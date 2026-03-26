/**
 * wex.js — WEX (Salesforce Experience Cloud) integration service.
 *
 * Thin proxy to the local Playwright daemon (daemon/index.js).
 * The daemon handles all browser automation since Render cannot run
 * Playwright (browser processes are killed by resource limits).
 *
 * If the daemon is unavailable, all lookups return { status: "daemon_unavailable" }
 * so the DOB pipeline can fall back to iSoftPull without crashing.
 *
 * ── Data flow ──
 *   Render server → daemonClient → daemon (local machine) → Playwright → WEX portal
 *
 * ── Data path in WEX ──
 *   Search by company name
 *   → OnlineApplication__c record (app ID, BOE ID, proprietor DOB)
 *   → Beneficial_Owner_Information__c (BOE)
 *   → Beneficial_Owner_Prong__c (BOP) → Date_Of_Birth__c
 */

import { lookupWexDob as daemonLookupWexDob, getDaemonHealth, DAEMON_ENABLED } from "../clients/daemonClient.js";
import { env } from "../config/env.js";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up a carrier's full WEX data (DOB + application details + beneficial owners).
 *
 * @param {{ carrierId: string, companyName: string, firstName?: string, lastName?: string }} candidate
 * @returns {Promise<object>} result with status + data
 *
 * status values:
 *   'found'              — DOB found (+ full application data)
 *   'notFound'           — no search results for company name
 *   'noMatch'            — search results found but no carrier match
 *   'noBOE'              — application found but no Beneficial Owner Entity
 *   'noBOP'              — BOE found but no Beneficial Owner Prong records
 *   'noDOB'              — owners found but none have a DOB
 *   'daemon_unavailable' — daemon unreachable (circuit open or disabled)
 *   'error'              — unexpected exception
 */
export function lookupWexDob(candidate) {
    return daemonLookupWexDob(candidate);
}

/**
 * Check if WEX is configured and the daemon is enabled.
 */
export function hasWexConfig() {
    return Boolean(DAEMON_ENABLED && (env.WEX_EMAIL || env.DAEMON_URL));
}

/**
 * Check daemon connectivity (useful for /wex/status route).
 */
export async function getWexStatus() {
    const health = await getDaemonHealth();
    return {
        daemonEnabled: DAEMON_ENABLED,
        daemonUrl: env.DAEMON_URL,
        ...health,
    };
}

/**
 * No-op: browser lifecycle is now managed by the daemon.
 * Kept for API compatibility with callers that call closeWexBrowser() on shutdown.
 */
export async function closeWexBrowser() {
    // Browser lifecycle managed by daemon/index.js
}
