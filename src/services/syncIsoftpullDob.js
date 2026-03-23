import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";
import { env } from "../config/env.js";
import { getDobByName } from "./isoftpull.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 * Read the Array Credit Report Excel and return carriers that are missing DOB.
 * Returns: Array of { carrierId, firstName, lastName }
 */
async function loadMissingDobsFromExcel(excelPath) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(excelPath);
    const sheet = wb.getWorksheet("Array Credit Report");

    const missing = [];
    sheet.eachRow((row, rowNum) => {
        if (rowNum < 5) return; // skip title + header + description + required rows
        const carrierId = String(row.getCell(11).value || "").trim();
        if (!carrierId) return;
        const dob = String(row.getCell(10).value || "").trim();
        if (dob) return; // already has DOB
        const firstName = String(row.getCell(2).value || "").trim();
        const lastName = String(row.getCell(3).value || "").trim();
        if (!firstName || !lastName) return;
        missing.push({ carrierId, firstName, lastName });
    });

    return missing;
}

/**
 * Sync DOBs from iSoftPull for all carriers missing DOB in the Array Credit Report Excel.
 * Writes found DOBs back into carrier-db.json.
 *
 * @param {{ excelPath?: string, force?: boolean }} options
 * @returns {Promise<object>} stats
 */
export async function syncIsoftpullDobs({ excelPath, force = false } = {}) {
    const reportPath = excelPath || path.resolve(__dirname, "../../data/Array_Credit_Report_2026-03-23.xlsx");

    const db = JSON.parse(fs.readFileSync(env.CARRIER_DB_PATH, "utf-8"));

    // Build candidate list from Excel (missing DOB rows)
    const candidates = await loadMissingDobsFromExcel(reportPath);

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
export async function getIsoftpullDobStats() {
    const db = JSON.parse(fs.readFileSync(env.CARRIER_DB_PATH, "utf-8"));
    const entries = Object.values(db);

    const reportPath = path.resolve(__dirname, "../../data/Array_Credit_Report_2026-03-23.xlsx");
    let excelMissing = null;
    if (fs.existsSync(reportPath)) {
        const missing = await loadMissingDobsFromExcel(reportPath);
        // How many of those missing are still missing in carrier-db
        const stillMissing = missing.filter((c) => !db[c.carrierId]?.derived?.dob);
        excelMissing = {
            totalMissingInExcel: missing.length,
            stillMissingInCarrierDb: stillMissing.length,
            filledSoFar: missing.length - stillMissing.length,
        };
    }

    return {
        carrierDb: {
            total: entries.length,
            withDob: entries.filter((e) => e.derived?.dob).length,
            fromIsoftpull: entries.filter((e) => e.derived?.dob_source === "isoftpull").length,
        },
        excel: excelMissing,
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
