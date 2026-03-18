import mongoose from "mongoose";

/**
 * Invoices — one doc per invoice.
 * Sources:
 *   - Payment Verifications.xlsx (via import-master-db, source="full_verification")
 *   - SMP /invoices API (via sync, source="smp")
 */
const invoiceSchema = new mongoose.Schema(
    {
        carrierId: { type: String, required: true, index: true },
        source: { type: String, default: "full_verification" }, // "full_verification" | "phdb" | "smp"

        // ── From spreadsheet import (Payment Verifications) ──
        invoiceDate: String, // yyyy-MM-dd
        invoiceNumber: String,
        invoiceAmount: { type: Number, default: 0 },
        openingBalance: { type: Number, default: 0 },
        paymentDate: String, // yyyy-MM-dd (null if unpaid)
        paymentAmount: { type: Number, default: 0 },
        endingBalance: { type: Number, default: 0 },

        // ── From SMP /invoices API ──
        smpInvoiceId: String, // SMP invoice id
        status: String, // PENDING | PARTIALLY_PAID | PAID
        totalAmount: { type: Number, default: 0 },
        totalPaid: { type: Number, default: 0 },
        dateFrom: String, // yyyy-MM-dd (invoice period start)
        dateTo: String, // yyyy-MM-dd (invoice period end)
        dueDate: String, // yyyy-MM-dd
        createDate: String, // ISO timestamp from SMP
    },
    { timestamps: true }
);

invoiceSchema.index({ carrierId: 1, invoiceDate: -1 });
invoiceSchema.index({ carrierId: 1, source: 1 });

export default mongoose.model("Invoice", invoiceSchema);
