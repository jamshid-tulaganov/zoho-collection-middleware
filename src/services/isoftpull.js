/**
 * isoftpull.js — iSoftPull integration service.
 *
 * Thin proxy to the local Playwright daemon (daemon/index.js).
 * All browser automation is in daemon/isoftpull-automation.js.
 *
 * Previously ran Playwright directly — this caused production crashes
 * on Render (browserType.launch: Target page, context or browser has been closed)
 * because Render kills background Chromium processes.
 *
 * If the daemon is unavailable, lookups return { dob: null, reason: "daemon_unavailable" }
 * so the DOB pipeline can degrade gracefully.
 */

import { searchIsoftpull, getIsoftpullDobById, DAEMON_ENABLED } from "../clients/daemonClient.js";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Search iSoftPull by name, validate by address, return the DOB.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {{ address?, city?, state?, zip? }} match — carrier address for validation
 * @returns {Promise<{ dob: string|null, applicantId: string|null, checked: number, reason?: string }>}
 */
export function getDobByName(firstName, lastName, match = {}) {
    return searchIsoftpull(firstName, lastName, match);
}

/**
 * Fetch DOB directly by iSoftPull applicant ID.
 * @returns {Promise<{ dob: string|null }>}
 */
export function getDobById(applicantId) {
    return getIsoftpullDobById(applicantId);
}

/**
 * Check if iSoftPull is reachable via the daemon.
 */
export function hasIsoftpullConfig() {
    return Boolean(DAEMON_ENABLED);
}

/**
 * No-op: browser lifecycle managed by daemon.
 * Kept for API compatibility.
 */
export async function closeBrowser() {
    // Browser lifecycle managed by daemon/index.js
}
