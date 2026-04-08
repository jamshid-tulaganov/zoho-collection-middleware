/**
 * syncWexDob.js — Batch DOB sync from WEX for carriers missing DOB.
 *
 * WEX is the sole DOB source for the carrier-db sync.
 *
 * Flow:
 *   1. Load carrier-db.json + dob.json
 *   2. Identify carriers missing DOB
 *   3. For each, call lookupWexDob() with company name + owner name
 *   4. Write found DOBs back into carrier-db.json + dob.json
 *
 * Usage:
 *   GET /wex/sync-dob            — start batch sync (background)
 *   GET /wex/sync-progress       — poll live progress
 *   GET /wex/dob-stats           — summary stats
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "../config/env.js";
import { lookupWexDob, hasWexConfig } from "./wex.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOB_PATH = path.resolve(__dirname, "../../data/dob.json");

// ── Progress tracking ────────────────────────────────────────────────────────

let syncProgress = null;

/**
 * Normalize WEX DOB "MM/DD/YYYY" → "MMDDYYYY" (carrier-db / Metro 2 format).
 */
function normalizeDob(dob) {
    if (!dob) return null;
    return dob.replace(/\//g, "");
}

function loadDobMap() {
    if (!fs.existsSync(DOB_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(DOB_PATH, "utf-8"));
    } catch {
        return {};
    }
}

function saveDobMap(dobMap) {
    const dir = path.dirname(DOB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DOB_PATH, JSON.stringify(dobMap, null, 2));
}

function loadCarrierDb() {
    try {
        return JSON.parse(fs.readFileSync(env.CARRIER_DB_PATH, "utf-8"));
    } catch {
        return {};
    }
}

function saveCarrierDb(db) {
    fs.writeFileSync(env.CARRIER_DB_PATH, JSON.stringify(db, null, 2));
}

/** Small pacing delay between lookups to be gentle on WEX. */
function delay() {
    const ms = 800 + Math.floor(Math.random() * 700);
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build list of carriers that need DOB lookup from WEX.
 * Prioritises debtors (is_debtor=true) first, then non-debtors.
 */
function buildCandidates(db, dobMap, { force = false } = {}) {
    const candidates = [];

    for (const [cid, entry] of Object.entries(db)) {
        // Skip if already has DOB (unless force)
        if (!force) {
            if (entry.derived?.dob) continue;
            if (dobMap[cid]) continue;
        }

        // Need a company name to search WEX
        const companyName = entry.company
            || entry.smp?.company
            || entry.zoho?.legal_name
            || entry.accounting?.company
            || "";
        if (!companyName.trim()) continue;

        const firstName = entry.derived?.first_name || entry.zoho?.first_name || "";
        const lastName = entry.derived?.last_name || entry.zoho?.last_name || "";

        candidates.push({
            carrierId: cid,
            companyName: companyName.trim(),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            isDebtor: Boolean(entry.derived?.is_debtor),
        });
    }

    // Debtors first, then sort alphabetically
    candidates.sort((a, b) => {
        if (a.isDebtor !== b.isDebtor) return a.isDebtor ? -1 : 1;
        return a.companyName.localeCompare(b.companyName);
    });

    return candidates;
}

/**
 * Run batch WEX DOB sync.
 *
 * @param {{ force?: boolean, limit?: number }} options
 *   force — re-check carriers that already have a DOB
 *   limit — max carriers to process (0 = all)
 * @returns {Promise<object>} stats
 */
export async function syncWexDobs({ force = false, limit = 0 } = {}) {
    if (!hasWexConfig()) {
        throw new Error("WEX credentials not configured (WEX_EMAIL / WEX_PASSWORD)");
    }

    const db = loadCarrierDb();
    const dobMap = loadDobMap();
    let candidates = buildCandidates(db, dobMap, { force });

    if (limit > 0) candidates = candidates.slice(0, limit);

    syncProgress = {
        total: Object.keys(db).length,
        toProcess: candidates.length,
        fetched: 0,
        notFound: 0,
        noMatch: 0,
        noBOE: 0,
        noDOB: 0,
        errors: 0,
        processed: 0,
        running: true,
        startedAt: new Date().toISOString(),
        details: [],
    };

    console.log(`[wex-dob] Starting sync: ${candidates.length} candidates (force=${force})`);

    for (const candidate of candidates) {
        const { carrierId, companyName, firstName, lastName } = candidate;
        syncProgress.current = { carrierId, companyName, firstName, lastName };

        try {
            const result = await lookupWexDob({ carrierId, companyName, firstName, lastName });

            if (result.status === "found" && result.dob) {
                // Write DOB into carrier-db
                if (!db[carrierId]) db[carrierId] = { carrier_id: carrierId, derived: {} };
                if (!db[carrierId].derived) db[carrierId].derived = {};

                const dob8 = normalizeDob(result.dob);
                db[carrierId].derived.dob = dob8;
                db[carrierId].derived.dob_source = "wex";
                db[carrierId].derived.dob_wex_carrier_id = result.matchedCarrierId || null;

                // Store WEX application data on the carrier entry
                if (result.application) {
                    db[carrierId].wex = {
                        app_id: result.application.appId || "",
                        legal_name: result.application.legalName || "",
                        dba_name: result.application.dbaName || "",
                        address: result.application.address || "",
                        city: result.application.city || "",
                        state: result.application.state || "",
                        zip: result.application.zip || "",
                        phone: result.application.phone || "",
                        email: result.application.email || "",
                        ein: result.application.ein || "",
                        status: result.application.status || "",
                        created_date: result.application.createdDate || "",
                        owners: (result.owners || []).map((o) => ({
                            first_name: o.firstName || "",
                            last_name: o.lastName || "",
                            dob: o.dob || "",
                            ownership_percent: o.ownershipPercent || "",
                            address: o.address || "",
                            city: o.city || "",
                            state: o.state || "",
                            zip: o.zip || "",
                        })),
                        last_synced: new Date().toISOString(),
                    };
                }

                dobMap[carrierId] = result.dob;
                syncProgress.fetched++;
                syncProgress.details.push({ carrierId, companyName, firstName, lastName, dob: dob8, status: "fetched" });
                console.log(`[wex-dob] ✓ [${carrierId}] ${companyName} → ${dob8}`);

                // Auto-save every 10 found DOBs
                if (syncProgress.fetched % 10 === 0) {
                    saveCarrierDb(db);
                    saveDobMap(dobMap);
                    console.log(`[wex-dob] Auto-saved at ${syncProgress.fetched} DOBs`);
                }
            } else {
                // Track specific failure reason
                const reason = result.status;
                if (reason === "noMatch") syncProgress.noMatch++;
                else if (reason === "noBOE") syncProgress.noBOE++;
                else if (reason === "noDOB") syncProgress.noDOB++;
                else syncProgress.notFound++;

                syncProgress.details.push({
                    carrierId, companyName, firstName, lastName,
                    dob: null, status: reason, error: result.error || null,
                });
                console.log(`[wex-dob] ✗ [${carrierId}] ${companyName} → ${reason}`);
            }
        } catch (err) {
            syncProgress.errors++;
            syncProgress.details.push({
                carrierId, companyName, firstName, lastName,
                dob: null, status: "error", error: err.message,
            });
            console.error(`[wex-dob] ! [${carrierId}] ${companyName} → ${err.message}`);
        }

        syncProgress.processed++;

        // Pacing delay
        if (syncProgress.processed < candidates.length) await delay();
    }

    // Final save
    if (syncProgress.fetched > 0) {
        saveCarrierDb(db);
        saveDobMap(dobMap);
        console.log(`[wex-dob] Final save: ${syncProgress.fetched} DOBs written`);
    }

    syncProgress.running = false;
    syncProgress.finishedAt = new Date().toISOString();

    console.log(`[wex-dob] Sync complete — fetched=${syncProgress.fetched} notFound=${syncProgress.notFound} noMatch=${syncProgress.noMatch} noBOE=${syncProgress.noBOE} noDOB=${syncProgress.noDOB} errors=${syncProgress.errors}`);
    return { ...syncProgress };
}

/**
 * Return the current live sync progress (or null if no sync has run).
 */
export function getWexSyncProgress() {
    return syncProgress;
}

/**
 * Return summary stats: how many DOBs in carrier-db came from WEX.
 */
export function getWexDobStats() {
    const db = loadCarrierDb();
    const entries = Object.values(db);
    const dobMap = loadDobMap();

    const withDob = entries.filter((e) => e.derived?.dob);
    const fromWex = entries.filter((e) => e.derived?.dob_source === "wex");
    const withWexData = entries.filter((e) => e.wex);
    const missingDob = entries.filter((e) => !e.derived?.dob);

    return {
        carrierDb: {
            total: entries.length,
            withDob: withDob.length,
            missingDob: missingDob.length,
            fromWex: fromWex.length,
            withWexApplicationData: withWexData.length,
        },
        dobJson: {
            total: Object.keys(dobMap).length,
        },
        syncProgress: syncProgress
            ? {
                  running: syncProgress.running,
                  processed: syncProgress.processed,
                  toProcess: syncProgress.toProcess,
                  fetched: syncProgress.fetched,
                  notFound: syncProgress.notFound,
                  noMatch: syncProgress.noMatch,
                  noBOE: syncProgress.noBOE,
                  noDOB: syncProgress.noDOB,
                  errors: syncProgress.errors,
              }
            : null,
    };
}
