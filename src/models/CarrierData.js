import mongoose from "mongoose";

/**
 * CarrierData — full carrier record from carrier-db.json.
 * Merges SMP, Zoho, accounting, WEX, invoices, billing, collection, and derived Metro 2 fields.
 */
const carrierDataSchema = new mongoose.Schema(
    {
        carrier_id: { type: String, required: true, unique: true, index: true },
        company: String,

        // Nested source blocks (flexible — match JSON structure exactly)
        smp: { type: mongoose.Schema.Types.Mixed, default: null },
        zoho: { type: mongoose.Schema.Types.Mixed, default: null },
        accounting: { type: mongoose.Schema.Types.Mixed, default: null },
        wex: { type: mongoose.Schema.Types.Mixed, default: null },

        // CMP invoices and billing
        invoices: { type: [mongoose.Schema.Types.Mixed], default: [] },
        invoices_last_synced: String,
        billing_history: { type: [mongoose.Schema.Types.Mixed], default: [] },
        billing_last_synced: String,

        // Master DB fields
        billing_cycle: String,
        credit_score_tss: Number,
        debtor_sources: { type: [String], default: [] },
        debtor_periods: { type: [String], default: [] },

        // Collection placement
        ggr_data: { type: mongoose.Schema.Types.Mixed, default: null },
        ggr_submission_date: String,
        collection_placement_date: String,
        collection_placement_dates: { type: [String], default: [] },
        earliest_delinquency_period_end: String,

        // Computed Metro 2 fields
        derived: { type: mongoose.Schema.Types.Mixed, default: {} },

        // Sync metadata
        last_full_sync: String,
        seeded_at: String,
    },
    { timestamps: true, minimize: false }
);

export default mongoose.model("CarrierData", carrierDataSchema);
