/**
 * dobOrchestrator.js — Master DOB sync orchestrator.
 *
 * Coordinates DOB lookup across all available sources in priority order:
 *   1. Existing cached DOB (skip if already set, unless force=true)
 *   2. WEX portal (via daemon) — PRIMARY lookup
 *   3. iSoftPull (via daemon) — FALLBACK
 *
 * Upstream sources (Zoho, master-db) are handled by syncCarrierDb.js
 * before this orchestrator runs.
 *
 * Features:
 *   - Checkpoint-based recovery (resumes interrupted sync from last position)
 *   - Per-source rate limiting (WEX: 2s, iSoftPull: 1.5s)
 *   - Daemon availability check (skips browser-based sources if daemon unreachable)
 *   - Debtors-first ordering (highest priority carriers processed first)
 *   - Auto-save every 10 found DOBs
 *
 * Usage:
 *   GET /dob-sync/start    — start background batch sync
 *   GET /dob-sync/progress — poll live progress
 *   GET /dob-sync/stats    — summary stats
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "../config/env.js";
import { lookupWexDob } from "./wex.js";
import { getDobByName } from "./isoftpull.js";
import { getDaemonHealth } from "../clients/daemonClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOB_PATH = path.resolve(__dirname, "../../data/dob.json");
const CHECKPOINT_PATH = path.resolve(__dirname, "../../data/dob-sync-checkpoint.json");

// ── Progress state ────────────────────────────────────────────────────────────

let syncProgress = null;

// ── File helpers ──────────────────────────────────────────────────────────────

function loadCarrierDb() {
    try { return JSON.parse(fs.readFileSync(env.CARRIER_DB_PATH, "utf-8")); } catch { return {}; }
}

function saveCarrierDb(db) {
    fs.writeFileSync(env.CARRIER_DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function loadDobMap() {
    if (!fs.existsSync(DOB_PATH)) return {};
    try { return JSON.parse(fs.readFileSync(DOB_PATH, "utf-8")); } catch { return {}; }
}

function saveDobMap(dobMap) {
    const dir = path.dirname(DOB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DOB_PATH, JSON.stringify(dobMap, null, 2), "utf-8");
}

function loadCheckpoint() {
    if (!fs.existsSync(CHECKPOINT_PATH)) return null;
    try { return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf-8")); } catch { return null; }
}

function saveCheckpoint(data) {
    const dir = path.dirname(CHECKPOINT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function clearCheckpoint() {
    if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
}

// ── DOB normalization ─────────────────────────────────────────────────────────

/**
 * Convert any DOB format to 8-digit MMDDYYYY string.
 */
function normalizeDobTo8(dob) {
    if (!dob) return "";
    const s = String(dob).trim().replace(/\//g, "");
    // MMDDYYYY — already 8 digits, no dashes
    if (/^\d{8}$/.test(s)) return s;
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
        return dob.slice(5, 7) + dob.slice(8, 10) + dob.slice(0, 4);
    }
    return "";
}

// ── Candidate building ────────────────────────────────────────────────────────

/**
 * Build list of carriers that need DOB lookup.
 * Debtors processed first, then alphabetical by company name.
 */
function buildCandidates(db, dobMap, { force = false, resumeAfterCid = null } = {}) {
    const candidates = [];
    let resuming = Boolean(resumeAfterCid);

    for (const [cid, entry] of Object.entries(db)) {
        // Resume support: skip until we pass the last processed CID
        if (resuming) {
            if (cid === resumeAfterCid) resuming = false;
            continue;
        }

        if (!force) {
            // Skip if already has DOB from any source
            if (entry.derived?.dob) continue;
            if (dobMap[cid]) continue;
            // Also skip if WEX block already has owner DOBs
            if (entry.wex?.owners?.some((o) => o.dob)) continue;
        }

        const companyName = (
            entry.company
            || entry.smp?.company
            || entry.zoho?.legal_name
            || entry.accounting?.company
            || ""
        ).trim();

        if (!companyName) continue;

        const firstName = (entry.derived?.first_name || entry.zoho?.first_name || "").trim();
        const lastName = (entry.derived?.last_name || entry.zoho?.last_name || "").trim();
        const address = (entry.derived?.address || entry.smp?.address?.addressLine1 || "").trim();
        const city = (entry.derived?.city || entry.smp?.address?.city || "").trim();
        const state = (entry.derived?.state || entry.smp?.address?.state || "").trim();
        const zip = (entry.derived?.zip || entry.smp?.address?.postalCode || "").trim();

        candidates.push({
            carrierId: cid,
            companyName,
            firstName,
            lastName,
            address,
            city,
            state,
            zip,
            isDebtor: Boolean(entry.derived?.is_debtor),
        });
    }

    // Debtors first, then alphabetical
    candidates.sort((a, b) => {
        if (a.isDebtor !== b.isDebtor) return a.isDebtor ? -1 : 1;
        return a.companyName.localeCompare(b.companyName);
    });

    return candidates;
}

// ── Pacing delays ─────────────────────────────────────────────────────────────

function wexDelay() {
    const ms = 1800 + Math.floor(Math.random() * 600);
    return new Promise((r) => setTimeout(r, ms));
}

function isoftpullDelay() {
    const ms = 1300 + Math.floor(Math.random() * 500);
    return new Promise((r) => setTimeout(r, ms));
}

// ── Single carrier DOB lookup ─────────────────────────────────────────────────

/**
 * Try all sources in order and return first found DOB.
 * @returns {{ dob8: string, dobDisplay: string, source: string }|null}
 */
async function lookupDobForCarrier(candidate, daemonAvailable, sources) {
    const { carrierId, companyName, firstName, lastName, address, city, state, zip } = candidate;

    // ── Source: WEX ──
    if (daemonAvailable && sources.includes("wex")) {
        try {
            const result = await lookupWexDob({ carrierId, companyName, firstName, lastName });
            if (result.status === "found" && result.dob8) {
                return {
                    dob8: result.dob8,
                    dobDisplay: result.dob,
                    source: "wex",
                    wexApplication: result.application,
                    wexOwners: result.owners,
                    matchedCarrierId: result.matchedCarrierId,
                };
            }
            await wexDelay();
        } catch (err) {
            console.warn(`[dob-orchestrator] WEX error for ${carrierId}: ${err.message}`);
        }
    }

    // ── Source: iSoftPull ──
    if (daemonAvailable && sources.includes("isoftpull") && (firstName || lastName)) {
        try {
            const result = await getDobByName(firstName, lastName, { address, city, state, zip });
            if (result.dob) {
                const dob8 = normalizeDobTo8(result.dob);
                if (dob8) {
                    return {
                        dob8,
                        dobDisplay: result.dob,
                        source: "isoftpull",
                        applicantId: result.applicantId,
                    };
                }
            }
            await isoftpullDelay();
        } catch (err) {
            console.warn(`[dob-orchestrator] iSoftPull error for ${carrierId}: ${err.message}`);
        }
    }

    return null;
}

// ── Main batch sync ───────────────────────────────────────────────────────────

/**
 * Run batch DOB sync for all carriers missing a DOB.
 *
 * @param {object} options
 * @param {boolean} options.force       — re-check even if DOB already set
 * @param {number}  options.limit       — max carriers to process (0 = all)
 * @param {string[]} options.sources    — which sources to use ['wex', 'isoftpull']
 * @param {boolean} options.resume      — resume from checkpoint if available
 * @returns {Promise<object>} final stats
 */
export async function syncDobs({
    force = false,
    limit = 0,
    sources = ["wex", "isoftpull"],
    resume = false,
} = {}) {
    const db = loadCarrierDb();
    const dobMap = loadDobMap();

    // Resume from checkpoint if available
    let resumeAfterCid = null;
    if (resume) {
        const checkpoint = loadCheckpoint();
        if (checkpoint?.lastProcessedCid) {
            resumeAfterCid = checkpoint.lastProcessedCid;
            console.log(`[dob-orchestrator] Resuming from checkpoint (last: ${resumeAfterCid})`);
        }
    }

    let candidates = buildCandidates(db, dobMap, { force, resumeAfterCid });
    if (limit > 0) candidates = candidates.slice(0, limit);

    // Check daemon availability
    const health = await getDaemonHealth();
    const daemonAvailable = health.connected;
    if (!daemonAvailable) {
        console.warn("[dob-orchestrator] Daemon unavailable — browser-based lookups will be skipped");
    }

    syncProgress = {
        total: Object.keys(db).length,
        toProcess: candidates.length,
        processed: 0,
        found: { wex: 0, isoftpull: 0 },
        notFound: 0,
        errors: 0,
        running: true,
        daemonAvailable,
        sources,
        startedAt: new Date().toISOString(),
        current: null,
        details: [],
    };

    console.log(`[dob-orchestrator] Starting sync: ${candidates.length} candidates, daemon=${daemonAvailable}, sources=${sources.join(",")}`);

    let autoSaveTrigger = 0;

    for (const candidate of candidates) {
        const { carrierId, companyName } = candidate;
        syncProgress.current = { carrierId, companyName };

        let found = null;
        try {
            found = await lookupDobForCarrier(candidate, daemonAvailable, sources);
        } catch (err) {
            syncProgress.errors++;
            syncProgress.details.push({ carrierId, companyName, status: "error", error: err.message });
            console.error(`[dob-orchestrator] ! [${carrierId}] ${companyName} → error: ${err.message}`);
        }

        if (found) {
            // Write DOB back to carrier-db
            if (!db[carrierId]) db[carrierId] = { carrier_id: carrierId, derived: {} };
            if (!db[carrierId].derived) db[carrierId].derived = {};

            db[carrierId].derived.dob = found.dob8;
            db[carrierId].derived.dob_source = found.source;
            db[carrierId].derived.dob_updated_at = new Date().toISOString();

            // Store WEX application data if found via WEX
            if (found.source === "wex" && found.wexApplication) {
                db[carrierId].wex = {
                    app_id: found.wexApplication.appId || "",
                    legal_name: found.wexApplication.legalName || "",
                    trade_name: found.wexApplication.tradeName || "",
                    street_address: found.wexApplication.streetAddress || "",
                    federal_tax_id: found.wexApplication.federalTaxId || "",
                    dot_number: found.wexApplication.dotNumber || "",
                    mc_number: found.wexApplication.mcNumber || "",
                    offer: found.wexApplication.offer || "",
                    program: found.wexApplication.program || "",
                    application_stage: found.wexApplication.applicationStage || "",
                    credit_decision: found.wexApplication.creditDecision || "",
                    created_date: found.wexApplication.createdDate || "",
                    matched_carrier_id: found.matchedCarrierId || "",
                    owners: (found.wexOwners || []).map((o) => ({
                        first_name: o.firstName || "",
                        last_name: o.lastName || "",
                        title: o.title || "",
                        dob: o.dob || "",
                        ownership_percent: o.ownershipPercent || "",
                        address: o.address || "",
                        city: o.city || "",
                        state: o.state || "",
                        zip: o.zip || "",
                        verification_status: o.verificationStatus || "",
                    })),
                    last_synced: new Date().toISOString(),
                };
            }

            // Also store in iSoftPull block if found there
            if (found.source === "isoftpull" && found.applicantId) {
                if (!db[carrierId].isoftpull) db[carrierId].isoftpull = {};
                db[carrierId].isoftpull.applicant_id = found.applicantId;
                db[carrierId].isoftpull.dob_synced_at = new Date().toISOString();
            }

            dobMap[carrierId] = found.dobDisplay || found.dob8;
            syncProgress.found[found.source] = (syncProgress.found[found.source] || 0) + 1;
            autoSaveTrigger++;

            syncProgress.details.push({ carrierId, companyName, status: "found", dob: found.dob8, source: found.source });
            console.log(`[dob-orchestrator] ✓ [${carrierId}] ${companyName} → ${found.dob8} (${found.source})`);

            // Auto-save every 10 DOBs
            if (autoSaveTrigger % 10 === 0) {
                saveCarrierDb(db);
                saveDobMap(dobMap);
                saveCheckpoint({
                    startedAt: syncProgress.startedAt,
                    lastCheckpointAt: new Date().toISOString(),
                    lastProcessedCid: carrierId,
                    processed: syncProgress.processed + 1,
                    toProcess: syncProgress.toProcess,
                    found: { ...syncProgress.found },
                    errors: syncProgress.errors,
                });
                console.log(`[dob-orchestrator] Auto-saved at ${autoSaveTrigger} DOBs found`);
            }
        } else if (!syncProgress.details.find((d) => d.carrierId === carrierId && d.status === "error")) {
            syncProgress.notFound++;
            syncProgress.details.push({ carrierId, companyName, status: "not_found" });
        }

        syncProgress.processed++;
    }

    // Final save
    const totalFound = Object.values(syncProgress.found).reduce((s, v) => s + v, 0);
    if (totalFound > 0) {
        saveCarrierDb(db);
        saveDobMap(dobMap);
        console.log(`[dob-orchestrator] Final save: ${totalFound} DOBs written`);
    }

    syncProgress.running = false;
    syncProgress.finishedAt = new Date().toISOString();
    clearCheckpoint();

    console.log(
        `[dob-orchestrator] Sync complete — found=${totalFound} (wex=${syncProgress.found.wex || 0}, isoftpull=${syncProgress.found.isoftpull || 0}) notFound=${syncProgress.notFound} errors=${syncProgress.errors}`
    );

    return { ...syncProgress };
}

// ── Live stats ────────────────────────────────────────────────────────────────

/**
 * Return current live sync progress.
 */
export function getSyncProgress() {
    return syncProgress;
}

/**
 * Return summary stats: DOB coverage across carrier-db.
 */
export function getDobStats() {
    const db = loadCarrierDb();
    const entries = Object.values(db);
    const dobMap = loadDobMap();

    return {
        carrierDb: {
            total: entries.length,
            withDob: entries.filter((e) => e.derived?.dob).length,
            missingDob: entries.filter((e) => !e.derived?.dob).length,
            fromWex: entries.filter((e) => e.derived?.dob_source === "wex").length,
            fromIsoftpull: entries.filter((e) => e.derived?.dob_source === "isoftpull").length,
            withWexData: entries.filter((e) => e.wex).length,
        },
        dobJson: { total: Object.keys(dobMap).length },
        checkpoint: loadCheckpoint(),
        syncProgress: syncProgress
            ? {
                running: syncProgress.running,
                processed: syncProgress.processed,
                toProcess: syncProgress.toProcess,
                found: syncProgress.found,
                notFound: syncProgress.notFound,
                errors: syncProgress.errors,
                daemonAvailable: syncProgress.daemonAvailable,
            }
            : null,
    };
}
