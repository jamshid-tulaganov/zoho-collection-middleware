import mongoose from "mongoose";

/**
 * MasterCarrier — basic carrier identity from debtor-master-db.json (common-carriers-db.json).
 * Central reference for carrier identity, DOB, and collection placement dates.
 */
const masterCarrierSchema = new mongoose.Schema(
    {
        carrier_id: { type: String, required: true, unique: true, index: true },
        company: String,
        first_name: String,
        last_name: String,
        full_name: String,
        email: String,
        phone_number: String,
        cs: String,
        open_date: String,
        address: String,
        city: String,
        state: String,
        zip_code: String,
        collection_placement_dates: { type: [String], default: [] },
        dob: String,
    },
    { timestamps: true, strict: false }
);

export default mongoose.model("MasterCarrier", masterCarrierSchema);
