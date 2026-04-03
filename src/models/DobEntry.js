import mongoose from "mongoose";

/**
 * DobEntry — DOB lookup cache from dob.json (WEX Salesforce lookups).
 * Maps carrier_id → date of birth.
 */
const dobEntrySchema = new mongoose.Schema(
    {
        carrier_id: { type: String, required: true, unique: true, index: true },
        dob: String, // YYYY-MM-DD or MM/DD/YYYY (as stored in dob.json)
    },
    { timestamps: true }
);

export default mongoose.model("DobEntry", dobEntrySchema);
