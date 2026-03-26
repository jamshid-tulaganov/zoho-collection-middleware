/**
 * daemonClient.js — HTTP client for the local Playwright daemon.
 *
 * The daemon runs on a local/team machine (see daemon/index.js).
 * This client is used by the Render production server to offload
 * Playwright operations (WEX and iSoftPull) that can't run on Render.
 *
 * Features:
 *   - Circuit breaker: stops hitting daemon if repeatedly unreachable
 *   - Timeout: 35s (5s buffer over daemon 30s page limit)
 *   - Retry: 1 automatic retry on network errors
 *   - Fallback: returns { status: "daemon_unavailable" } instead of crash
 */

import { env } from "../config/env.js";

// ── Config ────────────────────────────────────────────────────────────────────

const DAEMON_URL = (env.DAEMON_URL || "http://localhost:9002").replace(/\/$/, "");
const AUTH_TOKEN = env.DAEMON_AUTH_TOKEN || "";
const REQUEST_TIMEOUT_MS = Number(env.DAEMON_REQUEST_TIMEOUT_MS || 35000);
const DAEMON_ENABLED = env.DAEMON_ENABLED !== false && env.DAEMON_ENABLED !== "false";

// ── Circuit breaker ───────────────────────────────────────────────────────────

const circuit = {
    failures: 0,
    lastFailureAt: 0,
    openUntil: 0,
    FAILURE_THRESHOLD: 3,       // open after 3 consecutive failures
    RESET_TIMEOUT_MS: 60_000,   // try again after 1 minute
};

function isCircuitOpen() {
    if (circuit.openUntil && Date.now() < circuit.openUntil) return true;
    if (circuit.openUntil && Date.now() >= circuit.openUntil) {
        // Half-open: reset and allow one probe
        circuit.failures = 0;
        circuit.openUntil = 0;
    }
    return false;
}

function recordSuccess() {
    circuit.failures = 0;
    circuit.openUntil = 0;
}

function recordFailure() {
    circuit.failures++;
    circuit.lastFailureAt = Date.now();
    if (circuit.failures >= circuit.FAILURE_THRESHOLD) {
        circuit.openUntil = Date.now() + circuit.RESET_TIMEOUT_MS;
        console.warn(`[daemon-client] Circuit opened — daemon unreachable, pausing for ${circuit.RESET_TIMEOUT_MS / 1000}s`);
    }
}

// ── Fetch with timeout + retry ────────────────────────────────────────────────

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timerId);
    }
}

async function daemonPost(endpoint, body, retries = 1) {
    if (!DAEMON_ENABLED) {
        return { _daemonUnavailable: true, reason: "daemon_disabled" };
    }

    if (isCircuitOpen()) {
        return { _daemonUnavailable: true, reason: "circuit_open", openUntil: new Date(circuit.openUntil).toISOString() };
    }

    const url = `${DAEMON_URL}${endpoint}`;
    const headers = {
        "Content-Type": "application/json",
        ...(AUTH_TOKEN ? { "x-daemon-token": AUTH_TOKEN } : {}),
    };

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetchWithTimeout(
                url,
                { method: "POST", headers, body: JSON.stringify(body) },
                REQUEST_TIMEOUT_MS
            );

            if (res.status === 401) {
                throw new Error("daemon auth failed — check DAEMON_AUTH_TOKEN");
            }
            if (res.status === 503) {
                // Daemon overloaded — back off briefly
                if (attempt < retries) {
                    await new Promise((r) => setTimeout(r, 2000));
                    continue;
                }
                throw new Error("daemon 503 — overloaded");
            }

            const data = await res.json();
            recordSuccess();
            return data;
        } catch (err) {
            const isNetworkError = err.name === "AbortError"
                || err.code === "ECONNREFUSED"
                || err.code === "ECONNRESET"
                || err.code === "ETIMEDOUT"
                || err.message.includes("fetch failed");

            if (isNetworkError) {
                if (attempt < retries) {
                    console.warn(`[daemon-client] Network error on ${endpoint} (attempt ${attempt + 1}) — retrying...`);
                    await new Promise((r) => setTimeout(r, 1000));
                    continue;
                }
                recordFailure();
                console.error(`[daemon-client] Daemon unreachable at ${DAEMON_URL}: ${err.message}`);
                return { _daemonUnavailable: true, reason: "network_error", error: err.message };
            }

            // Non-network error — don't retry
            throw err;
        }
    }

    return { _daemonUnavailable: true, reason: "max_retries" };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up carrier data (DOB + application) from WEX portal.
 *
 * @param {{ carrierId, companyName, firstName?, lastName? }} candidate
 * @returns {Promise<object>}
 *   status = 'found' | 'notFound' | 'noMatch' | 'noBOE' | 'noBOP' | 'noDOB' | 'error' | 'daemon_unavailable'
 */
export async function lookupWexDob(candidate) {
    const result = await daemonPost("/api/wex/lookup", candidate);

    if (result._daemonUnavailable) {
        return {
            status: "daemon_unavailable",
            carrierId: candidate.carrierId,
            companyName: candidate.companyName,
            error: `daemon unavailable (${result.reason})`,
        };
    }

    return result;
}

/**
 * Search iSoftPull for a DOB by name + address.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {{ address?, city?, state?, zip? }} addressMatch
 * @returns {Promise<{ dob: string|null, applicantId: string|null, checked: number, reason?: string }>}
 */
export async function searchIsoftpull(firstName, lastName, addressMatch = {}) {
    const result = await daemonPost("/api/isoftpull/search", {
        firstName,
        lastName,
        ...addressMatch,
    });

    if (result._daemonUnavailable) {
        return {
            dob: null,
            applicantId: null,
            checked: 0,
            reason: `daemon_unavailable (${result.reason})`,
        };
    }

    return result;
}

/**
 * Fetch iSoftPull DOB directly by applicant ID.
 *
 * @param {string} applicantId
 * @returns {Promise<{ dob: string|null }>}
 */
export async function getIsoftpullDobById(applicantId) {
    const result = await daemonPost("/api/isoftpull/by-id", { applicantId });

    if (result._daemonUnavailable) {
        return { dob: null, reason: `daemon_unavailable (${result.reason})` };
    }

    return result;
}

/**
 * Check if the daemon is reachable and responsive.
 * @returns {Promise<{ connected: boolean, health?: object }>}
 */
export async function getDaemonHealth() {
    if (!DAEMON_ENABLED) return { connected: false, reason: "daemon_disabled" };

    try {
        const controller = new AbortController();
        const timerId = setTimeout(() => controller.abort(), 5000);
        let res;
        try {
            res = await fetch(`${DAEMON_URL}/health`, { signal: controller.signal });
        } finally {
            clearTimeout(timerId);
        }
        const health = await res.json();
        return { connected: true, health };
    } catch {
        return { connected: false };
    }
}

/**
 * Reset daemon browser context (for recovery after auth failures).
 * @param {'wex'|'isoftpull'|undefined} service
 */
export async function resetDaemonContext(service) {
    return daemonPost("/api/reset", { service });
}

export { DAEMON_ENABLED, DAEMON_URL };
