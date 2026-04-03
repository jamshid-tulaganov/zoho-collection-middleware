import mongoose from "mongoose";

/**
 * AccountingClient — onboarding/application data from accounting-client-db.json.
 * Provides date_filled (Date Open fallback), credit score, and contact info.
 */
const accountingClientSchema = new mongoose.Schema(
    {
        carrier_id: { type: String, required: true, unique: true, index: true },
        billing_cycle_group: String, // "1 Billing Cycle", "2 Billing Cycle", etc.
        company_name: String,
        application_id: String,
        first_name: String,
        last_name: String,
        mc_dot: String,
        cs: String,
        oldest_open_date: String,
        email: String,
        phone: String,
        address: String,
        city: String,
        st: String,
        zip: String,
        cards: String,
        date_filled: String,
        billing_form_y_n: String,
        agent: String,
        task: String,
        column_20: String,
        email_to_ta: String,
        ta_efs_added: String,
        cards_activated: String,
        limits_added: String,
        mobile_driver_app: String,
        chain_policy: String,
        tracking_numbers: String,
    },
    { timestamps: true, strict: false }
);

export default mongoose.model("AccountingClient", accountingClientSchema);
