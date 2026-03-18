import mongoose from "mongoose";

/**
 * Clients (Metro2Records) — the computed Metro 2 output per carrier.
 * Built by the sync service from Carriers + Invoices + DebtorPeriods
 * + live SMP/Zoho data. This is what the Excel report reads from.
 */
const clientSchema = new mongoose.Schema(
    {
        clientId: { type: String, required: true, unique: true, index: true },
        companyName: String,

        // ── Section A: Primary Account Profile (Metro 2 fields 1-13) ──
        associationCode: { type: String, default: "1" },
        firstName: String,
        middleName: String,
        lastName: String,
        generationCode: String,
        address1: String,
        address2: String,
        city: String,
        state: String,
        zipCode: String,
        ssn: String,
        phone: String,
        dateOfBirth: String, // MMddyyyy
        consumerInfoIndicator: String,

        // ── Section C: Account & Financial (Metro 2 fields 26-46) ──
        portfolioType: { type: String, default: "C" },
        accountType: { type: String, default: "15" },
        dateOpen: String, // MMddyyyy
        dateFirstDelinquency: String, // MMddyyyy
        dateLastPayment: String, // MMddyyyy
        dateClosed: String, // MMddyyyy
        accountStatus: { type: String, default: "11" },
        paymentRating: String,
        specialCommentCode: String,
        complianceConditionCode: String,
        creditLimit: { type: Number, default: 0 },
        highestCredit: { type: Number, default: 0 },
        currentBalance: { type: Number, default: 0 },
        amountPastDue: { type: Number, default: 0 },
        monthlyPayment: { type: Number, default: 0 },
        actualPayment: { type: Number, default: 0 },
        termsFrequency: { type: String, default: "W" },
        terms: { type: String, default: "001" },
        originalChargeOffAmount: { type: Number, default: 0 },
        paymentHistoryProfile: String, // 24-char Metro 2 code

        // ── ISO date fields (for computation) ──
        dateOpenIso: String,
        dateFirstDelinquencyIso: String,
        dateLastPaymentIso: String,
        dateClosedIso: String,
        acctOpenDateIso: String,

        // ── Source flags ──
        isDebtor: { type: Boolean, default: false },
        isClosed: { type: Boolean, default: false },
        wasFormerDebtor: { type: Boolean, default: false },

        // ── Sync metadata ──
        lastSyncedAt: Date,
        syncSource: String,
    },
    { timestamps: true }
);

export default mongoose.model("Client", clientSchema);
