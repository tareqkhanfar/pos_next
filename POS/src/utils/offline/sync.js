import { call } from "@/utils/apiWrapper"
import { db, getSetting, setSetting } from "./db"
import { offlineState } from "./offlineState"

// Mutex to prevent concurrent sync operations
let syncInProgress = false

// ============================================================================
// UUID-BASED OFFLINE ID GENERATION (Brainwise Approach)
// ============================================================================
// Generates a unique offline identifier for each invoice
// Format: pos_offline_<uuid>
// This ensures 100% uniqueness and allows server-side tracking
// ============================================================================

/**
 * Generate a UUID v4
 * @returns {string} UUID string
 */
const generateUUID = () => {
	// Use crypto.randomUUID if available (modern browsers)
	if (typeof crypto !== 'undefined' && crypto.randomUUID) {
		return crypto.randomUUID()
	}

	// Fallback to manual UUID v4 generation
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0
		const v = c === 'x' ? r : (r & 0x3) | 0x8
		return v.toString(16)
	})
}

/**
 * Generate offline ID for invoice
 * @returns {string} Unique offline identifier
 */
export const generateOfflineId = () => {
	return `pos_offline_${generateUUID()}`
}

// Ping server to check connectivity
export const pingServer = async () => {
	if (typeof window === "undefined") return true

	try {
		// Quick ping to check if server is reachable
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), 3000) // 3 second timeout

		const response = await fetch("/api/method/pos_next.api.ping", {
			method: "GET",
			signal: controller.signal,
		})

		clearTimeout(timeoutId)
		const isOnline = response.ok
		// Update centralized state (handles window sync automatically)
		offlineState.setServerOnline(isOnline)
		return isOnline
	} catch (error) {
		// Server unreachable
		offlineState.setServerOnline(false)
		return false
	}
}

// Check if offline - uses centralized state manager
export const isOffline = () => {
	if (typeof window === "undefined") return false
	return offlineState.isOffline
}

// NOTE: Periodic server ping is now handled by the offline worker
// This prevents duplicate pings and centralizes the logic

// Save invoice to offline queue
export const saveOfflineInvoice = async (invoiceData) => {
	try {
		// Validate invoice has items
		if (!invoiceData.items || invoiceData.items.length === 0) {
			throw new Error("Cannot save empty invoice")
		}

		// Clean data (remove reactive properties)
		const cleanData = JSON.parse(JSON.stringify(invoiceData))

		// ============================================================================
		// GENERATE UNIQUE OFFLINE ID (UUID-based approach)
		// ============================================================================
		// Generate a unique offline_id for this invoice if not already present
		// This ID will be sent to the server for idempotency checking
		// ============================================================================
		if (!cleanData.offline_id) {
			cleanData.offline_id = generateOfflineId()
		}

		// Add to queue with offline_id
		const invoiceId = await db.invoice_queue.add({
			data: cleanData,
			timestamp: Date.now(),
			synced: false,
			retry_count: 0,
			offline_id: cleanData.offline_id  // Store offline_id for tracking
		})

		// Update local stock
		await updateLocalStock(cleanData.items)

		console.log(`Invoice saved to offline queue with offline_id: ${cleanData.offline_id}`)
		return true
	} catch (error) {
		console.error("Error saving offline invoice:", error)
		throw error
	}
}

// Get pending offline invoices
export const getOfflineInvoices = async () => {
	try {
		// Use filter instead of where/equals for boolean values
		const invoices = await db.invoice_queue
			.filter((invoice) => invoice.synced === false)
			.toArray()
		return invoices
	} catch (error) {
		console.error("Error getting offline invoices:", error)
		return []
	}
}

// Get offline invoice count
export const getOfflineInvoiceCount = async () => {
	try {
		// Use filter instead of where/equals for boolean values
		const count = await db.invoice_queue
			.filter((invoice) => invoice.synced === false)
			.count()
		return count
	} catch (error) {
		console.error("Error getting offline invoice count:", error)
		return 0
	}
}

// Sync offline invoices to server
export const syncOfflineInvoices = async () => {
	// Mutex to prevent concurrent sync operations
	if (syncInProgress) {
		console.log("Sync already in progress, skipping duplicate sync request")
		return { success: 0, failed: 0, skipped: true }
	}

	if (isOffline()) {
		console.log("Cannot sync while offline")
		return { success: 0, failed: 0 }
	}

	// Set mutex
	syncInProgress = true

	try {
		const pendingInvoices = await getOfflineInvoices()
		if (pendingInvoices.length === 0) {
			return { success: 0, failed: 0 }
		}

		let successCount = 0
		let failedCount = 0
		let duplicateCount = 0
		const errors = []

		for (const invoice of pendingInvoices) {
			// Defensive type check
			if (!invoice || typeof invoice !== 'object' || !invoice.data) {
				console.error(`Invalid invoice object at id ${invoice?.id}`)
				failedCount++
				continue
			}

			try {
				// ============================================================================
				// CLIENT-SIDE PRE-CHECK: Verify if invoice was already synced
				// ============================================================================
				// Before attempting to submit, check if this offline_id was already synced
				// This reduces unnecessary server calls and network traffic
				// ============================================================================
				const offlineId = invoice.offline_id || invoice.data?.offline_id

				if (offlineId) {
					try {
						// Check server if this offline_id was already synced
						const syncCheck = await call("pos_next.pos_next.doctype.offline_invoice_sync.offline_invoice_sync.check_offline_invoice_synced", {
							offline_id: offlineId
						})

						if (syncCheck && syncCheck.synced) {
							console.log(`Invoice already synced: ${offlineId} -> ${syncCheck.sales_invoice}`)

							// Mark as synced locally
							await db.invoice_queue.update(invoice.id, {
								synced: true,
								duplicate: true,
								synced_invoice_name: syncCheck.sales_invoice
							})

							duplicateCount++
							continue
						}
					} catch (checkError) {
						// If pre-check fails, continue with submission
						// The server-side idempotency check will catch duplicates
						console.warn(`Pre-check failed for ${offlineId}, continuing with submission:`, checkError)
					}
				}
				// ============================================================================

				// Transform items: map 'quantity' to 'qty' for ERPNext compatibility
				// Offline storage uses 'quantity' (cart format) but server expects 'qty'
				const invoiceData = { ...invoice.data }

				// Ensure offline_id is present in invoice data
				if (offlineId && !invoiceData.offline_id) {
					invoiceData.offline_id = offlineId
				}

				// Defensive type check for items array
				if (invoiceData.items && Array.isArray(invoiceData.items)) {
					invoiceData.items = invoiceData.items.map((item) => {
						// Defensive checks for item object
						if (!item || typeof item !== 'object') {
							return item
						}
						return {
							...item,
							qty: item.quantity || item.qty || 1,
						}
					})
				} else {
					console.error(`Invoice ${invoice.id} has invalid items array`)
					throw new Error('Invalid items array')
				}

				// ============================================================================
				// SUBMIT INVOICE TO SERVER (with server-side idempotency protection)
				// ============================================================================
				const response = await call("pos_next.api.invoices.submit_invoice", {
					data: JSON.stringify({
						invoice: invoiceData,
						data: {},
					}),
				})

				if (response.message || response.name) {
					// Check if this was detected as a duplicate by the server
					const isDuplicate = response.is_duplicate === true

					if (isDuplicate) {
						console.log(`Server detected duplicate: ${offlineId} -> ${response.name}`)
						duplicateCount++
					} else {
						successCount++
					}

					// Mark as synced
					await db.invoice_queue.update(invoice.id, {
						synced: true,
						synced_invoice_name: response.name || response.message,
						duplicate: isDuplicate
					})

					console.log(
						`Invoice ${invoice.id} ${isDuplicate ? 'was duplicate of' : 'synced successfully as'} ${response.name || response.message}`,
					)
				}
			} catch (error) {
				console.error(`Error syncing invoice ${invoice.id}:`, error)

				// Store error details
				errors.push({
					invoiceId: invoice.id,
					customer: invoice.data?.customer || "Walk-in Customer",
					error: error,
				})

				// Increment retry count with defensive check
				const currentRetryCount = typeof invoice.retry_count === 'number'
					? invoice.retry_count
					: 0

				await db.invoice_queue.update(invoice.id, {
					retry_count: currentRetryCount + 1,
				})

				failedCount++

				// If retry count exceeds threshold, mark as failed
				if (currentRetryCount >= 3) {
					await db.invoice_queue.update(invoice.id, {
						sync_failed: true,
						error: error.message || String(error),
					})
				}
			}
		}

		// Clean up synced invoices older than 7 days
		const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
		await db.invoice_queue
			.filter((item) => item.synced === true && item.timestamp < weekAgo)
			.delete()

		return {
			success: successCount,
			failed: failedCount,
			duplicates: duplicateCount,
			errors
		}
	} finally {
		// Always release mutex
		syncInProgress = false
	}
}

// Delete offline invoice
export const deleteOfflineInvoice = async (id) => {
	try {
		await db.invoice_queue.delete(id)
		return true
	} catch (error) {
		console.error("Error deleting offline invoice:", error)
		return false
	}
}

// Update local stock after invoice
export const updateLocalStock = async (items) => {
	try {
		for (const item of items) {
			const currentStock = await db.stock.get({
				item_code: item.item_code,
				warehouse: item.warehouse,
			})

			const qty = item.quantity || item.qty || 0
			const newQty = (currentStock?.qty || 0) - qty

			await db.stock.put({
				item_code: item.item_code,
				warehouse: item.warehouse,
				qty: newQty,
				updated_at: Date.now(),
			})
		}
	} catch (error) {
		console.error("Error updating local stock:", error)
	}
}

// Get local stock
export const getLocalStock = async (itemCode, warehouse) => {
	try {
		const stock = await db.stock.get({
			item_code: itemCode,
			warehouse: warehouse,
		})
		return stock?.qty || 0
	} catch (error) {
		console.error("Error getting local stock:", error)
		return 0
	}
}

// Save offline payment
export const saveOfflinePayment = async (paymentData) => {
	try {
		const cleanData = JSON.parse(JSON.stringify(paymentData))

		await db.payment_queue.add({
			data: cleanData,
			timestamp: Date.now(),
			synced: false,
			retry_count: 0,
		})

		console.log("Payment saved to offline queue")
		return true
	} catch (error) {
		console.error("Error saving offline payment:", error)
		throw error
	}
}

// Auto-sync when coming back online
if (typeof window !== "undefined") {
	// Listen to centralized offline state changes for auto-sync
	offlineState.subscribe(async (state) => {
		// Only sync when transitioning from offline to online
		if (!state.isOffline && state.source !== 'manual') {
			console.log("Back online, syncing pending invoices...")
			const result = await syncOfflineInvoices()

			// Dispatch event to notify components to update their pending count
			window.dispatchEvent(
				new CustomEvent("offlineInvoicesSynced", {
					detail: result,
				}),
			)

			if (result.success > 0 || result.duplicates > 0) {
				const messages = []
				if (result.success > 0) {
					messages.push(`${result.success} invoice${result.success > 1 ? 's' : ''} synced`)
				}
				if (result.duplicates > 0) {
					messages.push(`${result.duplicates} duplicate${result.duplicates > 1 ? 's' : ''} skipped`)
				}

				console.log(`Sync complete: ${messages.join(', ')}`)

				if (window.frappe?.msgprint) {
					window.frappe.msgprint({
						title: __("Sync Complete"),
						message: messages.join(', '),
						indicator: "green",
					})
				}
			}

			if (result.failed > 0) {
				console.error(`Failed to sync ${result.failed} invoices`)
				if (window.frappe?.msgprint) {
					window.frappe.msgprint({
						title: __("Sync Warning"),
						message: `${result.failed} invoice${result.failed > 1 ? 's' : ''} failed to sync. Will retry later.`,
						indicator: "orange",
					})
				}
			}
		}
	})
}
