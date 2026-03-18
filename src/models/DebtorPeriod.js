import mongoose from "mongoose";

/**
 * DebtorPeriods — one doc per debtor period entry from TSS Debtor List.
 * Tracks when a carrier appeared as a debtor (soft, hard, or GGR).
 */
const debtorPeriodSchema = new mongoose.Schema(
    {
        carrierId: { type: String, required: true, index: true },
        source: String, // "soft" | "hard" | "ggr" | "phdb"
        period: String, // raw period text "05.06 - 05.12.2024"
        periodStart: String, // yyyy-MM-dd
        periodEnd: String, // yyyy-MM-dd
        amount: { type: Number, default: 0 },
        amountCollected: { type: Number, default: 0 },
    },
    { timestamps: true }
);

debtorPeriodSchema.index({ carrierId: 1, periodEnd: 1 });

export default mongoose.model("DebtorPeriod", debtorPeriodSchema);
