/**
 * Inspect Array_Reports records that the Deluge function created.
 * Prints summary stats + a few sample records so we can verify validity.
 *
 * Usage (from collections/ project root):
 *   node scripts/inspect-array-reports.mjs                    # current month
 *   node scripts/inspect-array-reports.mjs --period="May 2026"
 *   node scripts/inspect-array-reports.mjs --delete-all        # DANGER: deletes all records for the period
 *
 * No credentials are printed.
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.resolve(projectRoot, ".env") });

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    })
);

// Default period = current month in "MMM YYYY" format (matching Deluge today.toString("MMM yyyy"))
function currentPeriod() {
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const d = new Date();
    return `${months[d.getMonth()]} ${d.getFullYear()}`;
}
const PERIOD = args.period || currentPeriod();
const DO_DELETE = !!args["delete-all"];

const ZOHO_BASE_URL = process.env.ZOHO_BASE_URL || "https://www.zohoapis.com";
const ZOHO_ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com";
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || "";
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || "";
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || "";

if (!ZOHO_CLIENT_ID || !ZOHO_REFRESH_TOKEN) {
    console.error("[inspect] Missing Zoho credentials in collections/.env");
    process.exit(1);
}

async function getAccessToken() {
    const params = new URLSearchParams({
        refresh_token: ZOHO_REFRESH_TOKEN,
        client_id: ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        grant_type: "refresh_token",
    });
    const r = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token?${params}`, { method: "POST" });
    const d = await r.json();
    if (!d.access_token) throw new Error("Token refresh failed: " + JSON.stringify(d));
    return d.access_token;
}

async function api(token, endpoint, options = {}) {
    const r = await fetch(`${ZOHO_BASE_URL}${endpoint}`, {
        ...options,
        headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            ...(options.headers || {}),
        },
    });
    return await r.json();
}

const token = await getAccessToken();

// Identify which Zoho org/environment we're hitting (best-effort, may fail on scope)
console.log(`[inspect] ZOHO_BASE_URL = ${ZOHO_BASE_URL}`);
console.log(`[inspect] ZOHO_ACCOUNTS_URL = ${ZOHO_ACCOUNTS_URL}`);
try {
    const orgInfo = await api(token, `/crm/v2/org`);
    const org = (orgInfo.org || [])[0];
    if (org) {
        console.log(`[inspect] Org: ${org.company_name || "?"} (id=${org.id || "?"}, domain=${org.domain_name || "?"})`);
    } else if (orgInfo.code === "OAUTH_SCOPE_MISMATCH") {
        console.log(`[inspect] Org info skipped — token lacks ZohoCRM.org.READ scope (continuing anyway)`);
    } else {
        console.log(`[inspect] Could not fetch org info: ${JSON.stringify(orgInfo).slice(0, 200)}`);
    }
} catch (e) {
    console.log(`[inspect] Org check threw: ${e.message}`);
}
console.log();

// First: diagnostic — try TWO ways to fetch records:
// (a) direct module endpoint /crm/v2/Array_Reports (needs ZohoCRM.modules.Array_Reports.READ)
// (b) COQL fallback (needs ZohoCRM.coql.READ + module read scope)
async function fetchAllDirectModule() {
    const all = [];
    for (let page = 1; page <= 25; page++) {
        const r = await api(token, `/crm/v2/Array_Reports?page=${page}&per_page=200&fields=id,Carrier_ID,Carrier_Type,Report_Period,Account_Status,Excluded_Reason,Payment_History_Profile,Date_Open,Date_of_Birth,Credit_Limit,Highest_Credit,Current_Balance,First_Name,Last_Name,City,State,Validation_Errors`);
        if (r.data) {
            all.push(...r.data);
            if (r.info && r.info.more_records === false) break;
            if (r.data.length < 200) break;
        } else {
            console.log(`[inspect] /crm/v2/Array_Reports page ${page} returned: ${JSON.stringify(r).slice(0, 250)}`);
            break;
        }
    }
    return all;
}

async function fetchAllNoFilter() {
    const direct = await fetchAllDirectModule();
    if (direct.length > 0) {
        console.log(`[inspect] Direct module endpoint returned ${direct.length} records.`);
        return direct;
    }
    console.log(`[inspect] Direct module endpoint returned 0 records — falling back to COQL.`);
    const all = [];
    for (let off = 0; off < 5000; off += 200) {
        const q = {
            select_query: `SELECT id, Carrier_ID, Carrier_Type, Report_Period FROM Array_Reports LIMIT 200 OFFSET ${off}`,
        };
        const r = await api(token, `/crm/v2/coql`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(q),
        });
        const page = r.data || [];
        if (!page.length) {
            if (off === 0 && r.message) {
                console.log(`[inspect] COQL response: ${JSON.stringify(r).slice(0, 250)}`);
            }
            break;
        }
        all.push(...page);
        if (page.length < 200) break;
    }
    return all;
}

console.log(`\n=== DIAGNOSTIC: all Array_Reports records (any period) ===\n`);
const allRecs = await fetchAllNoFilter();
console.log(`Total records in module: ${allRecs.length}`);
if (allRecs.length === 0) {
    console.log(`\nThe module is empty. Either:`);
    console.log(`  • The records were already deleted`);
    console.log(`  • The Deluge wrote to a different module/sandbox`);
    console.log(`  • The Deluge function silently failed all creates`);
    console.log(`\nCheck Zoho CRM → Array_Reports → All Records list view directly.`);
    process.exit(0);
}
const periodCounts = {};
const typeCounts = {};
for (const r of allRecs) {
    const p = r.Report_Period === null || r.Report_Period === undefined ? "(null)" : `"${r.Report_Period}"`;
    periodCounts[p] = (periodCounts[p] || 0) + 1;
    const t = r.Carrier_Type === null || r.Carrier_Type === undefined ? "(null)" : r.Carrier_Type;
    typeCounts[t] = (typeCounts[t] || 0) + 1;
}
console.log(`\nReport_Period values found:`);
for (const [p, c] of Object.entries(periodCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(30)} ${c}`);
}
console.log(`\nCarrier_Type distribution (across all records):`);
for (const [t, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(15)} ${c}`);
}

// COQL fetch all records for the period
async function fetchAll() {
    const all = [];
    for (let off = 0; off < 5000; off += 200) {
        const q = {
            select_query: `SELECT id, Carrier_ID, Company_Name, Carrier_Type, Excluded_Reason, Account_Status, Payment_Rating, Date_Open, Date_of_Birth, First_Name, Last_Name, City, State, Credit_Limit, Highest_Credit, Current_Balance, Payment_History_Profile, Validation_Errors, Report_Period FROM Array_Reports WHERE Report_Period = '${PERIOD}' LIMIT 200 OFFSET ${off}`,
        };
        const r = await api(token, `/crm/v2/coql`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(q),
        });
        const page = r.data || [];
        if (!page.length) break;
        all.push(...page);
        if (page.length < 200) break;
    }
    return all;
}

console.log(`\n=== Inspecting Array_Reports for Report_Period = "${PERIOD}" ===\n`);
const records = await fetchAll();
console.log(`Total records: ${records.length}\n`);

if (!records.length) {
    console.log("No records found for that exact Report_Period value.");
    console.log("If allRecs above showed records, re-run with --period=\"<exact value>\" matching the actual stored value.");
    process.exit(0);
}

// Stats by Carrier_Type
const byType = {};
for (const r of records) {
    const t = r.Carrier_Type || "(blank)";
    byType[t] = (byType[t] || 0) + 1;
}
console.log("By Carrier_Type:");
for (const [t, c] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(15)} ${c}`);
}

// Stats by Account_Status
const byStatus = {};
for (const r of records) {
    const t = r.Account_Status || "(blank)";
    byStatus[t] = (byStatus[t] || 0) + 1;
}
console.log("\nBy Account_Status:");
for (const [t, c] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(15)} ${c}`);
}

// Excluded reasons
const reasons = {};
for (const r of records) {
    if (r.Carrier_Type === "Excluded") {
        const x = r.Excluded_Reason || "(no reason)";
        reasons[x] = (reasons[x] || 0) + 1;
    }
}
if (Object.keys(reasons).length) {
    console.log("\nExcluded_Reason breakdown:");
    for (const [t, c] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${t.padEnd(40)} ${c}`);
    }
}

// Validation errors
const valErrs = {};
for (const r of records) {
    if (r.Validation_Errors) {
        const x = r.Validation_Errors;
        valErrs[x] = (valErrs[x] || 0) + 1;
    }
}
if (Object.keys(valErrs).length) {
    console.log("\nValidation_Errors breakdown (records with non-empty errors):");
    for (const [t, c] of Object.entries(valErrs).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        console.log(`  ${t.padEnd(60)} ${c}`);
    }
}

// Show 3 sample records of each type (with PII redacted)
function redact(rec) {
    const SENSITIVE = ["First_Name", "Last_Name", "Date_of_Birth", "City", "State", "Company_Name"];
    const out = {};
    for (const [k, v] of Object.entries(rec)) {
        if (v === null || v === "" || v === undefined) continue;
        if (SENSITIVE.includes(k) && typeof v === "string") {
            out[k] = `<${typeof v} len=${v.length}>`;
        } else {
            out[k] = v;
        }
    }
    return out;
}
console.log("\n=== Sample records (PII redacted) ===");
const seen = new Set();
let sampled = 0;
for (const r of records) {
    const key = `${r.Carrier_Type || ""}|${r.Account_Status || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`\n--- ${r.Carrier_Type || "?"} / status=${r.Account_Status || "?"} ---`);
    console.log(JSON.stringify(redact(r), null, 2));
    sampled++;
    if (sampled >= 6) break;
}

// PHP sanity check
console.log("\n=== Payment_History_Profile sanity check ===");
const phpLengths = {};
const phpSamples = [];
for (const r of records) {
    const php = r.Payment_History_Profile || "";
    phpLengths[php.length] = (phpLengths[php.length] || 0) + 1;
    if (phpSamples.length < 8 && php) {
        phpSamples.push(`${(r.Carrier_Type || "?").padEnd(10)} ${php}`);
    }
}
console.log("PHP length distribution:");
for (const [len, c] of Object.entries(phpLengths)) {
    console.log(`  length=${len}: ${c} records`);
}
console.log("\nSample PHP strings:");
for (const s of phpSamples) console.log(`  ${s}`);

// Optional: delete all records for the period
if (DO_DELETE) {
    console.log(`\n=== DELETE MODE: removing ${records.length} records ===`);
    const ids = records.map((r) => r.id);
    const chunkSize = 100;
    let deleted = 0;
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const r = await api(token, `/crm/v2/Array_Reports?ids=${chunk.join(",")}`, { method: "DELETE" });
        const okCount = (r.data || []).filter((x) => x.code === "SUCCESS").length;
        deleted += okCount;
        console.log(`  Batch ${Math.floor(i / chunkSize) + 1}: deleted ${okCount}/${chunk.length}`);
    }
    console.log(`\nTotal deleted: ${deleted}/${records.length}`);
}
