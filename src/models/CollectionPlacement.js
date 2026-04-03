import mongoose from "mongoose";

/**
 * CollectionPlacement — debtor/collection agency records from collection-placement-db.json.
 * Keyed by normalized company name. Contains invoices with agency tracking and collection cases.
 */
const collectionPlacementSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, index: true }, // normalized company name
        company: String,
        debtor_type: String,
        date_of_delinquency: String,
        sent_to_collection_date: String,
        collection_source: String,
        invoices: { type: [mongoose.Schema.Types.Mixed], default: [] },
        collection_cases: { type: [mongoose.Schema.Types.Mixed], default: [] },
    },
    { timestamps: true, minimize: false }
);

export default mongoose.model("CollectionPlacement", collectionPlacementSchema);
