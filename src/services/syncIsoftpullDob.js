import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "../config/env.js";
import { getDobByName } from "./isoftpull.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES_PATH = path.resolve(__dirname, "../../data/isoftpull-candidates.json");

// Tracks in-progress sync so we can report live stats
let syncProgress = null;

/**
 * Normalize iSoftPull DOB "MM/DD/YYYY" → "MMDDYYYY" (carrier-db / Metro 2 format).
 */
function normalizeDob(dob) {
    if (!dob) return null;
    return dob.replace(/\//g, ""); // "08/18/1987" → "08181987"
}

/**
 * Load missing-DOB candidates from the pre-extracted JSON file.
 * Returns: Array of { carrierId, firstName, lastName }
 */
function loadCandidates() {
    return JSON.parse(fs.readFileSync(CANDIDATES_PATH, "utf-8"));
}

/**
 * Sync DOBs from iSoftPull for all carriers missing DOB in the Array Credit Report Excel.
 * Writes found DOBs back into carrier-db.json.
 *
 * @param {{ excelPath?: string, force?: boolean }} options
 * @returns {Promise<object>} stats
 */
export async function syncIsoftpullDobs({ force = false } = {}) {
    const db = JSON.parse(fs.readFileSync(env.CARRIER_DB_PATH, "utf-8"));
    const candidates = loadCandidates();

    // If force=false, also skip carriers that already have DOB in carrier-db
    const toProcess = force
        ? candidates
        : candidates.filter((c) => !db[c.carrierId]?.derived?.dob);

    syncProgress = {
        total: candidates.length,
        toProcess: toProcess.length,
        fetched: 0,
        notFound: 0,
        errors: 0,
        processed: 0,
        running: true,
        startedAt: new Date().toISOString(),
        details: [],
    };

    console.log(`[isoftpull-dob] Starting sync: ${toProcess.length} candidates (${candidates.length} missing in Excel, force=${force})`);

    for (const { carrierId, firstName, lastName } of toProcess) {
        syncProgress.current = { carrierId, firstName, lastName };

        try {
            const { dob, applicantId } = await getDobByName(firstName, lastName);

            if (dob) {
                // Ensure carrier entry exists in db
                if (!db[carrierId]) db[carrierId] = { carrier_id: carrierId, derived: {} };
                if (!db[carrierId].derived) db[carrierId].derived = {};

                db[carrierId].derived.dob = normalizeDob(dob);
                db[carrierId].derived.dob_source = "isoftpull";
                db[carrierId].derived.dob_isoftpull_id = applicantId || null;

                syncProgress.fetched++;
                syncProgress.details.push({ carrierId, firstName, lastName, dob: db[carrierId].derived.dob, status: "fetched" });
                console.log(`[isoftpull-dob] ✓ [${carrierId}] ${firstName} ${lastName} → ${db[carrierId].derived.dob}`);

                // Save after every 10 fetched DOBs so progress is never lost
                if (syncProgress.fetched % 10 === 0) {
                    fs.writeFileSync(env.CARRIER_DB_PATH, JSON.stringify(db, null, 2));
                    console.log(`[isoftpull-dob] Auto-saved at ${syncProgress.fetched} DOBs fetched`);
                }
            } else {
                syncProgress.notFound++;
                syncProgress.details.push({ carrierId, firstName, lastName, dob: null, status: "not_found" });
                console.log(`[isoftpull-dob] ✗ [${carrierId}] ${firstName} ${lastName} → not found in iSoftPull`);
            }
        } catch (err) {
            syncProgress.errors++;
            syncProgress.details.push({ carrierId, firstName, lastName, dob: null, status: "error", error: err.message });
            console.error(`[isoftpull-dob] ! [${carrierId}] ${firstName} ${lastName} → ${err.message}`);
        }

        syncProgress.processed++;
    }

    // Final save
    if (syncProgress.fetched > 0) {
        fs.writeFileSync(env.CARRIER_DB_PATH, JSON.stringify(db, null, 2));
        console.log(`[isoftpull-dob] Final save: ${syncProgress.fetched} DOBs written to carrier-db.json`);
    }

    syncProgress.running = false;
    syncProgress.finishedAt = new Date().toISOString();

    return { ...syncProgress };
}

/**
 * Return the current live sync progress (or null if no sync has run).
 */
export function getSyncProgress() {
    return syncProgress;
}

/**
 * Return summary stats: how many DOBs in carrier-db came from iSoftPull vs total missing in Excel.
 */
export function getIsoftpullDobStats() {
    const db = JSON.parse(fs.readFileSync(env.CARRIER_DB_PATH, "utf-8"));
    const entries = Object.values(db);
    const candidates = loadCandidates();
    const stillMissing = candidates.filter((c) => !db[c.carrierId]?.derived?.dob);

    return {
        carrierDb: {
            total: entries.length,
            withDob: entries.filter((e) => e.derived?.dob).length,
            fromIsoftpull: entries.filter((e) => e.derived?.dob_source === "isoftpull").length,
        },
        excel: {
            totalMissingInExcel: candidates.length,
            stillMissingInCarrierDb: stillMissing.length,
            filledSoFar: candidates.length - stillMissing.length,
        },
        syncProgress: syncProgress
            ? {
                  running: syncProgress.running,
                  processed: syncProgress.processed,
                  total: syncProgress.toProcess,
                  fetched: syncProgress.fetched,
                  notFound: syncProgress.notFound,
                  errors: syncProgress.errors,
              }
            : null,
    };
}
