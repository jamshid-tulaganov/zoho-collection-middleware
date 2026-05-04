/**
 * sync-array-report.js
 *
 * Reads carrier-db.json, filters LOC carriers (CMP tag 2 + Zoho Card Swiped + has DOB),
 * builds the Metro 2 report row for each, and upserts to the Zoho CRM Array_Report module.
 *
 * Usage:
 *   node scripts/sync-array-report.js           # dry-run (prints count + sample)
 *   node scripts/sync-array-report.js --apply   # upsert to Zoho
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Load env from parent telegram-bot if present
try {
    const telegramEnv = path.resolve(ROOT, "../telegram-bot/.env");
    if (fs.existsSync(telegramEnv)) {
        const raw = fs.readFileSync(telegramEnv, "utf-8");
        for (const line of raw.split("\n")) {
            const m = line.match(/^([^#=]+)=(.*)$/);
            if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
        }
    }
} catch {}

const { loadReportCarriers, carrierToRow } = await import(`${ROOT}/src/services/arrayReport.js`);
const { ensureZohoToken } = await import(`${ROOT}/src/services/zoho.js`);

const ZOHO_BASE_URL = process.env.ZOHO_BASE_URL || "https://www.zohoapis.com";
const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = 100;

// ── Zoho upsert helper ────────────────────────────────────────────────────────

let zohoToken = "";
let tokenTime = 0;

async function getToken() {
    if (zohoToken && Date.now() - tokenTime < 45 * 60 * 1000) return zohoToken;
    await ensureZohoToken();
    // ensureZohoToken updates the shared token; re-read via a test request isn't needed —
    // we rely on the zoho.js module's internal token. Instead, do a direct refresh here.
    const params = new URLSearchParams({
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: "refresh_token",
    });
    const res = await fetch(
        `${process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com"}/oauth/v2/token?${params}`,
        { method: "POST" }
    );
    const data = await res.json();
    if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
    zohoToken = data.access_token;
    tokenTime = Date.now();
    return zohoToken;
}

async function zohoUpsert(records) {
    const token = await getToken();
    const res = await fetch(`${ZOHO_BASE_URL}/crm/v2/Array_Reports/upsert`, {
        method: "POST",
        headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            data: records,
            duplicate_check_fields: ["Customer_Account_Number"],
        }),
    });
    if (res.status === 401) {
        tokenTime = 0; // force refresh on next call
        throw new Error("Zoho 401 — token expired mid-batch");
    }
    return res.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Metro 2 dates are MMDDYYYY — convert to YYYY-MM-DD for Zoho
function m2DateToIso(v) {
    const s = String(v || "").trim();
    if (s.length !== 8) return "";
    return `${s.slice(4)}-${s.slice(0, 2)}-${s.slice(2, 4)}`;
}

// ── Row → Zoho record ─────────────────────────────────────────────────────────

function rowToZohoRecord(row, carrier) {
    const firstName = row["First Name"] || "";
    const lastName  = row["Last Name"] || "";
    const carrierId = String(row["Customer Account Number"] || "");
    const name = [firstName, lastName].filter(Boolean).join(" ") || carrierId;

    const picklistOrNull = (v) => v || null;
    const dateOrNull     = (v) => m2DateToIso(v) || null;

    return {
        Name:                         name,
        First_Name:                   firstName || null,
        Middle_Name:                  row["Middle Name"] || null,
        Last_Name:                    lastName || null,
        Generation_Code:              picklistOrNull(row["Generation Code"]),
        First_Line_of_Address:        row["First Line of Address"] || null,
        Second_Line_of_Address:       row["Second Line of Address"] || null,
        City:                         row["City"] || null,
        State:                        row["State"] || null,
        Zip_Code:                     row["Zip Code"] || null,
        Telephone_Number:             row["Telephone Number"] || null,
        Date_of_Birth:                dateOrNull(row["Date of Birth"]),
        Customer_Account_Number:      carrierId,
        Carrier_ID:                   carrierId,
        Company_Name:                 carrier?.company || null,
        Portfolio_Type:               picklistOrNull(row["Portfolio Type"]),
        Account_Type:                 picklistOrNull(row["Account Type"]),
        Date_Open:                    dateOrNull(row["Date Open"]),
        Date_of_First_Delinquency:    dateOrNull(row["Date of First Delinquency"]),
        Date_of_Last_Payment:         dateOrNull(row["Date of Last Payment"]),
        Date_Closed:                  dateOrNull(row["Date Closed"]),
        Account_Status:               picklistOrNull(row["Account Status"]),
        Payment_Rating:               picklistOrNull(row["Payment Rating"]),
        Special_Comment_Code:         picklistOrNull(row["Special Comment Code"]),
        Compliance_Condition_Code:    picklistOrNull(row["Compliance Condition Code"]),
        Association_Code:             picklistOrNull(row["Association Code"]),
        Terms_Frequency:              picklistOrNull(row["Terms Frequency"]),
        Terms:                        row["Terms"] || null,
        Payment_History_Profile:      row["Payment History Profile"] || null,
    };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const carriers = loadReportCarriers({});
console.log(`[array-report] LOC carriers (tag 2 + Card Swiped + DOB): ${carriers.length}`);

const rows = carriers.map((c) => rowToZohoRecord(carrierToRow(c), c));

if (!APPLY) {
    console.log("[array-report] Dry-run — first 3 records:");
    console.log(JSON.stringify(rows.slice(0, 3), null, 2));
    console.log(`\nRun with --apply to upsert all ${rows.length} records to Zoho Array_Report module.`);
    process.exit(0);
}

// Batch upsert
let created = 0, updated = 0, errors = 0;
for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
        const result = await zohoUpsert(batch);
        for (const item of result.data || []) {
            if (item.status === "success") {
                if (item.action === "insert") created++;
                else updated++;
            } else {
                errors++;
                console.warn(`[array-report] Error on ${item.details?.api_name || "?"}: ${item.message}`);
            }
        }
        if (result.code && result.code !== 0) {
            console.error(`[array-report] Batch error: ${JSON.stringify(result)}`);
        }
        console.log(`[array-report] ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length} processed`);
    } catch (err) {
        console.error(`[array-report] Batch ${i}–${i + BATCH_SIZE} failed: ${err.message}`);
        errors += batch.length;
    }
}

console.log(`\n[array-report] Done — created: ${created}, updated: ${updated}, errors: ${errors}`);
