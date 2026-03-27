#!/usr/bin/env node
/**
 * build-cmp-clients.js — Build data/cmpClients.json
 *
 * Fetches all CMP (SMP tagIds=2) companies, matches them with Zoho Card Swiped
 * deals by carrierId, and writes a flat JSON array with contact + address + DOB
 * for every matched client.
 *
 * The file is the input for DOB scraping:
 *   - Records where dob === "" can be fed straight into scrape-dob.js
 *
 * Usage:
 *   node scripts/build-cmp-clients.js
 *   node scripts/build-cmp-clients.js --only-missing-dob   # print count only
 *
 * Output: data/cmpClients.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchCompanies } from "../src/services/smp.js";
import { fetchDeals, ensureZohoToken } from "../src/services/zoho.js";
import { loadMergedMasterDb } from "../src/services/dob.js";
import { env } from "../src/config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH  = path.resolve(__dirname, "../data/cmpClients.json");
const CARRIER_DB_PATH = env.CARRIER_DB_PATH;

// ── Helpers ───────────────────────────────────────────────────────────────────

function normCid(raw) {
    const s = String(raw || "").trim();
    return s && !["0", "null", "None"].includes(s) ? s : null;
}

/** YYYY-MM-DD → MMddYYYY  or  passthrough if already 8-digit */
function normalizeDobToMmddYyyy(raw) {
    const s = String(raw || "").trim();
    if (!s || ["null", "None"].includes(s)) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        return s.slice(5, 7) + s.slice(8, 10) + s.slice(0, 4);
    }
    return s; // already MMddYYYY or unknown format — pass through
}

/** Load carrier-db.json if it exists (for cached DOB). */
function loadCarrierDb() {
    try {
        if (CARRIER_DB_PATH && fs.existsSync(CARRIER_DB_PATH)) {
            return JSON.parse(fs.readFileSync(CARRIER_DB_PATH, "utf-8"));
        }
    } catch {
        console.warn("[build-cmp-clients] Could not read carrier-db — DOB fallback from carrier-db skipped.");
    }
    return {};
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);

    console.log("[build-cmp-clients] Starting...");

    // ── 1. Load cached carrier-db + master DB for DOB fallbacks ──────────────
    console.log("[build-cmp-clients] Loading carrier-db and master-db for DOB fallbacks...");
    const carrierDb = loadCarrierDb();
    const masterDb  = loadMergedMasterDb(env.MASTER_DB_PATH, { logPrefix: "[build-cmp-clients]" });

    // ── 2. Fetch all CMP (LOC) companies from SMP ────────────────────────────
    console.log("[build-cmp-clients] Fetching SMP LOC companies (tagIds=2)...");
    const locMap = await fetchCompanies(2);
    console.log(`[build-cmp-clients]   LOC companies: ${locMap.size}`);

    // ── 3. Fetch all Zoho Card Swiped deals ──────────────────────────────────
    console.log("[build-cmp-clients] Fetching Zoho Card Swiped deals...");
    await ensureZohoToken();
    const deals = await fetchDeals();
    const dealByCid = new Map();
    for (const deal of deals) {
        const cid = normCid(deal.Carrier_ID);
        if (cid) dealByCid.set(cid, deal);
    }
    console.log(`[build-cmp-clients]   Deals: ${deals.length} (${dealByCid.size} with valid carrierId)`);

    // ── 4. Match & build output ───────────────────────────────────────────────
    const clients = [];

    // Union of all carrier IDs across both sources so nothing is missed
    const allCids = new Set([...locMap.keys(), ...dealByCid.keys()]);

    for (const cid of [...allCids].sort()) {
        const comp = locMap.get(cid) || null;
        const deal = dealByCid.get(cid) || null;

        // Only include carriers that exist in at least SMP (CMP) or have a
        // Card Swiped deal — skip orphan deal records with no SMP company.
        if (!comp && !deal) continue;

        // ── Address: SMP primary, Zoho fallback ──────────────────────────────
        const smpAddr = comp?.address || {};
        const address  = (smpAddr.addressLine1 || deal?.Address || "").trim();
        const address2 = (smpAddr.addressLine2 || "").trim();
        const city     = (smpAddr.city     || deal?.City     || "").trim();
        const state    = (smpAddr.state    || deal?.State    || "").trim();
        const zip      = (
            smpAddr.postalCode || deal?.Zip_Code || ""
        ).replace(/[^0-9]/g, "").slice(0, 5);

        // ── Name: SMP owners primary, Zoho fallback ──────────────────────────
        const owners    = comp?.owners || [];
        const firstName = (owners[0]?.firstName || deal?.First_name || "").trim();
        const lastName  = (owners[0]?.lastName  || deal?.Last_Name  || "").trim();

        // ── DOB priority chain ────────────────────────────────────────────────
        //   1. carrier-db.json derived.dob  (already fully resolved + normalized)
        //   2. Zoho deal Birth_Of_Date       (normalised MMddYYYY)
        //   3. master-db dob
        //   4. "" — will be scraped by scrape-dob.js
        const cachedDob  = carrierDb[cid]?.derived?.dob || "";
        const zohoDob    = normalizeDobToMmddYyyy(deal?.Birth_Of_Date);
        const masterDob  = normalizeDobToMmddYyyy(masterDb[cid]?.dob || "");
        const dob        = cachedDob || zohoDob || masterDob || "";

        clients.push({
            carrierId:   cid,
            companyName: (comp?.name || "").trim(),
            firstName,
            lastName,
            address,
            address2,
            city,
            state,
            zip,
            dob,
            // Convenience flags for the scraping step
            hasSmpRecord:  Boolean(comp),
            hasZohoDeal:   Boolean(deal),
            creditScore:   String(deal?.Credit_Score || comp?.creditScore || "").trim(),
        });
    }

    // ── 5. Write output ───────────────────────────────────────────────────────
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(clients, null, 2), "utf-8");

    const missingDob = clients.filter((c) => !c.dob);
    const hasDob     = clients.filter((c) =>  c.dob);

    console.log(`\n[build-cmp-clients] Done!`);
    console.log(`  Total clients : ${clients.length}`);
    console.log(`  With DOB      : ${hasDob.length}`);
    console.log(`  Missing DOB   : ${missingDob.length}  ← ready for Playwright scraping`);
    console.log(`  Output        : ${OUTPUT_PATH}`);

    if (args.includes("--only-missing-dob")) {
        console.log("\n[build-cmp-clients] Missing DOB carriers:");
        for (const c of missingDob) {
            console.log(`  ${c.carrierId.padEnd(12)} ${c.firstName} ${c.lastName}  (${c.city}, ${c.state})`);
        }
    }
}

main().catch((err) => {
    console.error("[build-cmp-clients] Fatal:", err.message);
    process.exit(1);
});
