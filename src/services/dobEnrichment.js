/**
 * DOB Enrichment — automatically looks up DOB for new Card Swiped carriers.
 * Runs after carrier-db sync. Only processes carriers not yet in dob.json.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readCarrierDb } from "./syncCarrierDb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOB_PATH = path.resolve(__dirname, "../../data/dob.json");

/**
 * Find Card Swiped carriers missing DOB.
 * Returns array of { carrierId, companyName, firstName, lastName }.
 */
export function findCarriersMissingDob() {
    const db = readCarrierDb();
    let dobMap = {};
    try { dobMap = JSON.parse(fs.readFileSync(DOB_PATH, "utf-8")); } catch {}

    const candidates = [];
    for (const c of Object.values(db)) {
        const cid = String(c.carrier_id);
        const stage = String(c.zoho?.stage || "").trim();
        if (stage !== "Card Swiped") continue;

        const d = c.derived || {};
        if (d.dob || dobMap[cid]) continue;

        const companyName = c.company
            || c.accounting?.company || c.zoho?.company
            || c.smp?.name || "";
        if (!companyName) continue;

        candidates.push({
            carrierId: cid,
            companyName,
            firstName: d.first_name || "",
            lastName: d.last_name || "",
        });
    }
    return candidates;
}

/**
 * Run DOB enrichment for carriers missing DOB.
 * Uses the persistent WEX session from wexHttp.js.
 * @param {object} options
 * @param {number} [options.limit=0] - Max carriers to process (0 = all)
 * @returns {{ found: number, notFound: number, errors: number, total: number }}
 */
export async function runDobEnrichment({ limit = 0 } = {}) {
    const candidates = findCarriersMissingDob();
    if (!candidates.length) {
        console.log("[dob-enrich] No carriers missing DOB.");
        return { found: 0, notFound: 0, errors: 0, total: 0 };
    }

    // Lazy import — Playwright may not be available on all environments
    let lookupAndSaveDob;
    try {
        const mod = await import("./wexHttp.js");
        lookupAndSaveDob = mod.lookupAndSaveDob;
    } catch (err) {
        console.warn("[dob-enrich] WEX module not available:", err.message);
        return { found: 0, notFound: 0, errors: 0, total: candidates.length, skipped: true };
    }

    const toProcess = limit > 0 ? candidates.slice(0, limit) : candidates;
    console.log(`[dob-enrich] Processing ${toProcess.length} carriers missing DOB...`);

    let found = 0, notFound = 0, errors = 0;

    for (let i = 0; i < toProcess.length; i++) {
        const { carrierId, companyName, firstName, lastName } = toProcess[i];
        try {
            const result = await lookupAndSaveDob({ carrierId, companyName, firstName, lastName });
            if (result.status === "found") {
                found++;
            } else if (result.status === "error") {
                errors++;
                console.warn(`[dob-enrich] Error for ${carrierId}: ${result.error}`);
            } else {
                notFound++;
            }
        } catch (err) {
            errors++;
            console.warn(`[dob-enrich] Failed ${carrierId}: ${err.message}`);
        }

        // Brief delay between lookups
        if (i < toProcess.length - 1) {
            await new Promise((r) => setTimeout(r, 800));
        }
    }

    console.log(`[dob-enrich] Done: ${found} found, ${notFound} not found, ${errors} errors (of ${toProcess.length})`);
    return { found, notFound, errors, total: toProcess.length };
}
