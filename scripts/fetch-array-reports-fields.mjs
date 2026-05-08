// One-off: fetch Array_Reports module fields from Zoho. No credentials are printed.
//
// Usage (from collections/ project root):
//   node scripts/fetch-array-reports-fields.mjs
//
// Looks up any custom module whose name contains "array", prints field summary,
// and saves full metadata to zoho/<api_name>_fields.json
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.resolve(projectRoot, ".env") });

const ZOHO_BASE_URL = process.env.ZOHO_BASE_URL || "https://www.zohoapis.com";
const ZOHO_ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com";
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || "";
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || "";
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || "";

if (!ZOHO_CLIENT_ID || !ZOHO_REFRESH_TOKEN) {
    console.error("[fetch] Missing Zoho credentials in .env");
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

async function api(token, endpoint) {
    const r = await fetch(`${ZOHO_BASE_URL}${endpoint}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    return await r.json();
}

const token = await getAccessToken();

// 1. List all modules to find "Array_Reports" (or whatever the api_name is)
const mods = await api(token, "/crm/v2/settings/modules");
const modules = (mods.modules || []).filter(m => /array/i.test(m.api_name || "") || /array/i.test(m.module_name || "") || /array/i.test(m.singular_label || "") || /array/i.test(m.plural_label || ""));
console.log("=== Matching modules (anything 'array') ===");
console.log(JSON.stringify(modules.map(m => ({ api_name: m.api_name, plural_label: m.plural_label, singular_label: m.singular_label, generated_type: m.generated_type })), null, 2));

if (modules.length === 0) {
    console.log("No matching module. Listing all custom modules...");
    const customs = (mods.modules || []).filter(m => m.generated_type === "custom" || (m.api_name || "").startsWith("CustomModule"));
    console.log(JSON.stringify(customs.map(m => ({ api_name: m.api_name, plural_label: m.plural_label })), null, 2));
}

// 2. For each matching module, fetch fields
for (const m of modules) {
    console.log(`\n=== Fields for module: ${m.api_name} (${m.plural_label}) ===`);
    const f = await api(token, `/crm/v2/settings/fields?module=${m.api_name}`);
    const fields = (f.fields || []).map(fl => ({
        api_name: fl.api_name,
        field_label: fl.field_label,
        data_type: fl.data_type,
        custom: fl.custom_field,
        mandatory: fl.system_mandatory || (fl.unique && fl.unique.case_sensitive),
        picklist: (fl.pick_list_values || []).map(p => p.actual_value).slice(0, 10),
    }));
    console.log(JSON.stringify(fields, null, 2));

    // Save full JSON to zoho/ directory
    const fs = await import("fs");
    const outPath = path.resolve(projectRoot, "zoho", `${m.api_name.toLowerCase()}_fields.json`);
    fs.writeFileSync(outPath, JSON.stringify(f, null, 2));
    console.log(`[saved] ${path.relative(projectRoot, outPath)}`);
}
