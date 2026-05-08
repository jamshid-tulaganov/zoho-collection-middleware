/**
 * Fetch Zoho module metadata + an optional sample record.
 *
 * Usage (run from collections/ project root):
 *   node scripts/fetch-zoho-meta.mjs --module=Deals
 *   node scripts/fetch-zoho-meta.mjs --module=Deals --sample-stage="Card Swiped"
 *   node scripts/fetch-zoho-meta.mjs --module=Array_Reports --sample
 *
 * Outputs:
 *   zoho/<module>_fields.json   — full field metadata (overwritten each run)
 *   zoho/<module>_sample.json   — sample record(s) if --sample* given
 *
 * No credentials are printed. Only api_names, types, and field values from
 * the sampled record (which is your real production data — review before sharing).
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.resolve(projectRoot, ".env") });

// Parse simple CLI args: --key=value or --flag
const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    })
);

const MODULE = args.module || "Deals";
const SAMPLE_STAGE = args["sample-stage"]; // e.g. "Card Swiped"
const WANT_SAMPLE = !!args.sample || !!SAMPLE_STAGE;
const SAMPLE_LIMIT = Number(args.limit) || 1;

const ZOHO_BASE_URL = process.env.ZOHO_BASE_URL || "https://www.zohoapis.com";
const ZOHO_ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com";
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || "";
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || "";
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || "";

if (!ZOHO_CLIENT_ID || !ZOHO_REFRESH_TOKEN) {
    console.error("[fetch] Missing Zoho credentials in collections/.env");
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

// --- 1. Fetch field metadata ---
const f = await api(token, `/crm/v2/settings/fields?module=${MODULE}`);
const fields = f.fields || [];
if (!fields.length) {
    console.error(`[fetch] No fields returned for module="${MODULE}". Response:`, JSON.stringify(f, null, 2));
    process.exit(1);
}
console.log(`\n=== ${MODULE}: ${fields.length} fields ===`);
console.log(`${"api_name".padEnd(35)} ${"data_type".padEnd(22)} ${"custom".padEnd(6)} label`);
console.log("-".repeat(110));
for (const fl of fields) {
    const api = (fl.api_name || "").padEnd(35);
    const dt = (fl.data_type || "").padEnd(22);
    const custom = (fl.custom_field ? "Y" : "").padEnd(6);
    console.log(`${api} ${dt} ${custom} ${fl.field_label || ""}`);
}

// Picklist values (compact)
const picklists = fields.filter((fl) => (fl.data_type === "picklist" || fl.data_type === "multiselectpicklist") && (fl.pick_list_values || []).length);
if (picklists.length) {
    console.log("\n=== Picklist values ===");
    for (const fl of picklists) {
        const vals = (fl.pick_list_values || []).map((p) => p.actual_value);
        console.log(`${fl.api_name}: ${JSON.stringify(vals)}`);
    }
}

// Save full metadata
const metaPath = path.resolve(projectRoot, "zoho", `${MODULE.toLowerCase()}_fields.json`);
fs.writeFileSync(metaPath, JSON.stringify(f, null, 2));
console.log(`\n[saved] ${path.relative(projectRoot, metaPath)}`);

// --- 2. Fetch sample record(s) if requested ---
if (WANT_SAMPLE) {
    let endpoint;
    if (SAMPLE_STAGE && MODULE === "Deals") {
        // Search by stage
        const enc = encodeURIComponent(SAMPLE_STAGE);
        endpoint = `/crm/v2/${MODULE}/search?criteria=(Stage:equals:${enc})&page=1&per_page=${SAMPLE_LIMIT}`;
    } else {
        // Just first record
        endpoint = `/crm/v2/${MODULE}?page=1&per_page=${SAMPLE_LIMIT}`;
    }
    const s = await api(token, endpoint);
    const recs = s.data || [];
    console.log(`\n=== ${MODULE} sample (${recs.length} record${recs.length === 1 ? "" : "s"}) ===`);
    if (!recs.length) {
        console.log("(no records returned)");
        if (s.message) console.log("API message:", s.message);
    } else {
        // Show only non-null fields per record
        for (const rec of recs) {
            const filtered = Object.fromEntries(
                Object.entries(rec).filter(([_, v]) => v !== null && v !== "" && !(Array.isArray(v) && !v.length))
            );
            console.log(JSON.stringify(filtered, null, 2));
        }
        const samplePath = path.resolve(projectRoot, "zoho", `${MODULE.toLowerCase()}_sample.json`);
        fs.writeFileSync(samplePath, JSON.stringify(recs, null, 2));
        console.log(`[saved] ${path.relative(projectRoot, samplePath)}`);
    }
}
