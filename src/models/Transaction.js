import mongoose from "mongoose";

/**
 * Transactions — one doc per billing-history entry from SMP API.
 * From GET /billing-history?carrierId={id}
 */
const transactionSchema = new mongoose.Schema(
    {
        carrierId: { type: String, required: true, index: true },
        refNum: String, // reference number
        companyName: String,
        contractId: String,
        amount: { type: Number, default: 0 },
        balanceBefore: { type: Number, default: 0 },
        balanceAfter: { type: Number, default: 0 },
        createDate: String, // ISO timestamp from SMP
    },
    { timestamps: true }
);

transactionSchema.index({ carrierId: 1, createDate: -1 });

export default mongoose.model("Transaction", transactionSchema);
