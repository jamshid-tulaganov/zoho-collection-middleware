import mongoose from "mongoose";

/**
 * Carriers — master record per carrier (1 doc = 1 company).
 * Merges data from:
 *   - debtor-master-db.json (spreadsheet import)
 *   - SMP /companies API (live CMP data)
 *   - Zoho Deals (Card Swiped stage)
 */
const carrierSchema = new mongoose.Schema(
    {
        carrierId: { type: String, required: true, unique: true, index: true },
        company: String,

        // ── From SMP /companies API ──
        contractId: String,
        balance: { type: Number, default: 0 },
        debtAmount: { type: Number, default: 0 },
        creditLimit: { type: Number, default: 0 },
        creditScore: { type: Number, default: 0 },
        billingCycle: String, // SMP: WEEKLY_MON_SUN, WEEKLY_THU_WED, SEMI_WEEKLY
        feesType: String, // CHARGED | NOT_CHARGED
        contactEmail: String,
        contactPhone: String,
        mcDotNumber: String,
        agent: String,
        smpCreateDate: String, // ISO timestamp

        // SMP address
        addressLine1: String,
        addressLine2: String,
        city: String,
        state: String,
        postalCode: String,

        // SMP owners
        ownerFirstName: String,
        ownerLastName: String,

        // SMP tags (tag id=1 = debtor flag for fuel card stopping)
        smpTagIds: [Number],

        // ── From Zoho Deals (Card Swiped) ──
        dealFirstName: String,
        dealLastName: String,
        dealAddress: String,
        dealCity: String,
        dealState: String,
        dealZipCode: String,
        dealBirthOfDate: String, // yyyy-MM-dd
        dealCreditScore: String,
        dealApplicationDate: String, // yyyy-MM-dd

        // ── From debtor-master-db.json (spreadsheet import) ──
        spreadsheetBillingCycle: String, // "1_billing" | "2_billing"
        debtorSources: [String], // ["soft","hard","ggr"]
        isDebtor: { type: Boolean, default: false },
        earliestDelinquencyPeriodEnd: String, // yyyy-MM-dd
        totalDebt: { type: Number, default: 0 },
        totalCollected: { type: Number, default: 0 },

        // ── Source tracking ──
        lastSmpSync: Date,
        lastDealSync: Date,
        lastImport: Date,
    },
    { timestamps: true }
);

export default mongoose.model("Carrier", carrierSchema);
