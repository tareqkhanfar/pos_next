# Copyright (c) 2025, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime


class OfflineInvoiceSync(Document):
	"""Track offline invoices that have been synced to prevent duplicates"""

	@staticmethod
	def is_synced(offline_id):
		"""
		Check if an offline invoice has already been synced

		Args:
			offline_id: The unique offline identifier (UUID)

		Returns:
			dict with 'synced' boolean and 'sales_invoice' if exists
		"""
		if not offline_id:
			return {"synced": False}

		existing = frappe.db.get_value(
			"Offline Invoice Sync",
			{"offline_id": offline_id},
			["name", "sales_invoice"],
			as_dict=True
		)

		if existing:
			return {
				"synced": True,
				"sales_invoice": existing.sales_invoice,
				"offline_id": existing.name
			}

		return {"synced": False}

	@staticmethod
	def create_sync_record(offline_id, sales_invoice, invoice_data=None):
		"""
		Create a sync record for an offline invoice

		Args:
			offline_id: The unique offline identifier
			sales_invoice: The Sales Invoice document name
			invoice_data: Optional invoice data for metadata

		Returns:
			OfflineInvoiceSync document
		"""
		if not offline_id or not sales_invoice:
			frappe.throw("offline_id and sales_invoice are required")

		# Check if already exists
		existing = frappe.db.exists("Offline Invoice Sync", offline_id)
		if existing:
			return frappe.get_doc("Offline Invoice Sync", existing)

		# Create new sync record
		doc = frappe.get_doc({
			"doctype": "Offline Invoice Sync",
			"offline_id": offline_id,
			"sales_invoice": sales_invoice,
			"synced_at": now_datetime(),
			"customer": invoice_data.get("customer") if invoice_data else None,
			"grand_total": invoice_data.get("grand_total") if invoice_data else None,
			"posting_date": invoice_data.get("posting_date") if invoice_data else None,
			"posting_time": invoice_data.get("posting_time") if invoice_data else None
		})
		doc.insert(ignore_permissions=True)
		frappe.db.commit()

		return doc


@frappe.whitelist()
def check_offline_invoice_synced(offline_id):
	"""
	API endpoint to check if an offline invoice has been synced
	Called from client before attempting sync

	Args:
		offline_id: The unique offline identifier

	Returns:
		dict with sync status
	"""
	return OfflineInvoiceSync.is_synced(offline_id)
