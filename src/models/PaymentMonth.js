import mongoose from "mongoose";

/**
 * PaymentMonths — one doc per carrier per month.
 * Aggregated monthly totals from Payment Verifications.
 */
const paymentMonthSchema = new mongoose.Schema(
    {
        carrierId: { type: String, required: true, index: true },
        yearMonth: { type: String, required: true }, // "2024-06"
        totalInvoiced: { type: Number, default: 0 },
        totalPaid: { type: Number, default: 0 },
        unpaidCount: { type: Number, default: 0 },
    },
    { timestamps: true }
);

// One record per carrier per month
paymentMonthSchema.index({ carrierId: 1, yearMonth: 1 }, { unique: true });

export default mongoose.model("PaymentMonth", paymentMonthSchema);
