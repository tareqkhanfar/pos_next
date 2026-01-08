import { call } from "@/utils/apiWrapper"
import { db, getSetting, setSetting } from "./db"
import { offlineState } from "./offlineState"

// Mutex to prevent concurrent sync operations
let syncInProgress = false

// Generate hash for invoice deduplication
const generateInvoiceHash = (invoiceData) => {
	if (!invoiceData || typeof invoiceData !== 'object') {
		return null
	}

	try {
		// Create a deterministic string from key invoice properties
		const hashString = JSON.stringify({
			customer: invoiceData.customer || '',
			posting_date: invoiceData.posting_date || '',
			posting_time: invoiceData.posting_time || '',
			grand_total: invoiceData.grand_total || 0,
			items_count: Array.isArray(invoiceData.items) ? invoiceData.items.length : 0,
			// Include first item details for better uniqueness
			first_item: Array.isArray(invoiceData.items) && invoiceData.items.length > 0
				? {
					item_code: invoiceData.items[0].item_code,
					qty: invoiceData.items[0].quantity || invoiceData.items[0].qty
				}
				: null
		})

		// Simple hash function (FNV-1a)
		let hash = 2166136261
		for (let i = 0; i < hashString.length; i++) {
			hash ^= hashString.charCodeAt(i)
			hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
		}
		return (hash >>> 0).toString(36)
	} catch (error) {
		console.error('Error generating invoice hash:', error)
		return null
	}
}

// Check if invoice hash already exists in persistent storage
const isInvoiceHashExists = async (hash) => {
	try {
		const existingHash = await db.invoice_hashes.get(hash)
		return !!existingHash
	} catch (error) {
		console.error('Error checking invoice hash:', error)
		return false
	}
}

// Store invoice hash permanently in IndexedDB
const storeInvoiceHash = async (hash, invoiceId) => {
	try {
		await db.invoice_hashes.put({
			hash: hash,
			timestamp: Date.now(),
			invoice_id: invoiceId
		})
		return true
	} catch (error) {
		console.error('Error storing invoice hash:', error)
		return false
	}
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

		// Generate hash for deduplication
		const invoiceHash = generateInvoiceHash(cleanData)

		// Check if this exact invoice was already saved offline
		if (invoiceHash && await isInvoiceHashExists(invoiceHash)) {
			console.warn(`Duplicate invoice detected while saving offline (hash: ${invoiceHash})`)
			throw new Error("This invoice was already saved offline. Please check your pending invoices.")
		}

		// Add to queue with hash
		const invoiceId = await db.invoice_queue.add({
			data: cleanData,
			timestamp: Date.now(),
			synced: false,
			retry_count: 0,
			invoice_hash: invoiceHash
		})

		// Store hash permanently to prevent future duplicates
		if (invoiceHash) {
			await storeInvoiceHash(invoiceHash, invoiceId)
		}

		// Update local stock
		await updateLocalStock(cleanData.items)

		console.log(`Invoice saved to offline queue with hash: ${invoiceHash}`)
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
				// Generate hash for deduplication (or use stored hash)
				const invoiceHash = invoice.invoice_hash || generateInvoiceHash(invoice.data)

				// Check if this invoice was already synced (persistent check in IndexedDB)
				if (invoiceHash && await isInvoiceHashExists(invoiceHash)) {
					// Check if this hash belongs to a different invoice ID (already synced)
					const existingHashRecord = await db.invoice_hashes.get(invoiceHash)

					if (existingHashRecord && existingHashRecord.invoice_id !== invoice.id) {
						console.log(`Duplicate invoice detected (hash: ${invoiceHash}, original ID: ${existingHashRecord.invoice_id}), skipping...`)
						// Mark as synced to prevent future attempts
						await db.invoice_queue.update(invoice.id, {
							synced: true,
							duplicate: true
						})
						duplicateCount++
						continue
					}
				}

				// Transform items: map 'quantity' to 'qty' for ERPNext compatibility
				// Offline storage uses 'quantity' (cart format) but server expects 'qty'
				const invoiceData = { ...invoice.data }

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

				// Submit invoice to server
				// The API expects 'data' parameter with nested 'invoice' and 'data' keys
				const response = await call("pos_next.api.invoices.submit_invoice", {
					data: JSON.stringify({
						invoice: invoiceData,
						data: {},
					}),
				})

				if (response.message || response.name) {
					// Store hash permanently to prevent future duplicates
					if (invoiceHash) {
						await storeInvoiceHash(invoiceHash, invoice.id)
					}

					// Mark as synced
					await db.invoice_queue.update(invoice.id, {
						synced: true,
						synced_invoice_name: response.name || response.message
					})
					successCount++
					console.log(
						`Invoice ${invoice.id} synced successfully as ${response.name || response.message}`,
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

		// Clean up invoice hashes older than 30 days (keep longer for better protection)
		const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
		await db.invoice_hashes
			.filter((item) => item.timestamp < monthAgo)
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
