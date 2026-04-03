import mongoose from "mongoose";

/**
 * PaymentVerification — historical invoice/payment data from payment-verifications-db.json.
 * Used for closed carrier detection when no CMP data is available.
 */
const paymentVerificationSchema = new mongoose.Schema(
    {
        carrier_id: { type: String, required: true, unique: true, index: true },
        company: String,
        last_invoice_date: String,
        last_payment_date: String,
        total_invoiced: { type: Number, default: 0 },
        total_paid: { type: Number, default: 0 },
        invoice_count: { type: Number, default: 0 },
        ending_balance: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    { timestamps: true }
);

export default mongoose.model("PaymentVerification", paymentVerificationSchema);
