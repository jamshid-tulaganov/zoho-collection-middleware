// Force Playwright to find browsers in node_modules (Render deploy)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
}

/**
 * WEX DOB Lookup service with persistent session.
 *
 * Uses Playwright for Salesforce Aura token (required by SF Experience Cloud),
 * but keeps the browser session alive for multiple lookups.
 *
 * On Render: requires playwright + chromium buildpack.
 * Locally: works with playwright devDependency.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOB_PATH = path.resolve(__dirname, "../../data/dob.json");

const WEX_URL      = "https://wexinc.my.site.com/communities/s";
const WEX_EMAIL    = env.WEX_EMAIL    || "";
const WEX_PASSWORD = env.WEX_PASSWORD || "";

const AURA_FWUID  = "VEhtaDlVRkdCeTJiZFhuOTVYYjRJQTJEa1N5enhOU3R5QWl2VzNveFZTbGcxMy4tMjE0NzQ4MzY0OC4xMzEwNzIwMA";
const AURA_APP    = "siteforce:communityApp";
const AURA_LOADED = { "APPLICATION@markup://siteforce:communityApp": "1533_ez-GoXD6UAAJ6rtTbHErdw" };

// ── Persistent session ───────────────────────────────────────────────────────

let _browser = null;
let _page = null;
let _token = null;
let _reqNum = 1;
let _sessionExpiry = 0;
let _initPromise = null;
let _idleTimer = null;

const SESSION_TTL_MS = 25 * 60 * 1000; // 25 min
const IDLE_CLOSE_MS = 5 * 60 * 1000;   // auto-close browser after 5 min idle

function resetIdleTimer() {
    if (_idleTimer) clearTimeout(_idleTimer);
    _idleTimer = setTimeout(async () => {
        if (_browser) {
            console.log("[wex] Closing idle browser session");
            await closeWexSession();
        }
    }, IDLE_CLOSE_MS);
}

function isReady() {
    return _token && _page && Date.now() < _sessionExpiry;
}

async function ensureSession() {
    if (isReady()) return;
    // Prevent concurrent inits
    if (_initPromise) return _initPromise;
    _initPromise = _initSession();
    try { await _initPromise; } finally { _initPromise = null; }
}

async function _initSession() {
    // Close old session if exists
    if (_browser) {
        await _browser.close().catch(() => {});
        _browser = null;
        _page = null;
        _token = null;
    }

    if (!WEX_EMAIL || !WEX_PASSWORD) {
        throw new Error("WEX_EMAIL and WEX_PASSWORD must be set");
    }

    let chromium;
    try {
        ({ chromium } = await import("playwright"));
    } catch {
        throw new Error("Playwright not installed — run: npm install playwright");
    }

    console.log("[wex] Launching browser session...");
    _browser = await chromium.launch({
        headless: env.WEX_HEADLESS !== "false",
        args: ["--disable-gpu", "--no-sandbox", "--disable-setuid-sandbox"],
    });
    const context = await _browser.newContext();
    _page = await context.newPage();

    await _page.goto(
        `${WEX_URL}/onlineapplication/OnlineApplication__c/Default`,
        { waitUntil: "domcontentloaded", timeout: 60000 },
    );

    // Extract token or login first
    _token = await _page.evaluate(() =>
        window.$A?.Hi?.client?.Ac || null
    );

    if (!_token) {
        const url = _page.url();
        if (url.includes("login") || url.includes("?ec=")) {
            console.log("[wex] Logging in...");
            await _page.fill('input[type="email"], input[name="username"]', WEX_EMAIL);
            await _page.fill('input[type="password"], input[name="password"]', WEX_PASSWORD);
            await _page.click('button[type="submit"], input[type="submit"]');
            await _page.waitForURL("**/communities/s/**", { timeout: 60000 });
            await _page.waitForLoadState("domcontentloaded", { timeout: 30000 });
            await _page.waitForTimeout(3000);
            _token = await _page.evaluate(() =>
                window.$A?.Hi?.client?.Ac || null
            );
        }
    }

    if (!_token) {
        throw new Error("Failed to obtain Aura token from WEX");
    }

    _reqNum = 1;
    _sessionExpiry = Date.now() + SESSION_TTL_MS;
    resetIdleTimer();
    console.log("[wex] Session ready");
}

// ── Aura API ─────────────────────────────────────────────────────────────────

async function auraPost(actionKey, descriptor, params) {
    await ensureSession();
    resetIdleTimer();

    const reqNum = _reqNum++;
    const message = JSON.stringify({
        actions: [{ id: "1;a", descriptor, callingDescriptor: "UNKNOWN", params }],
    });
    const context = JSON.stringify({
        mode: "PROD", fwuid: AURA_FWUID, app: AURA_APP, loaded: AURA_LOADED,
        dn: [], globals: {}, uad: true,
    });

    const result = await _page.evaluate(
        async ({ url, message, context, token }) => {
            const body = `message=${encodeURIComponent(message)}&aura.context=${encodeURIComponent(context)}&aura.pageURI=%2Fcommunities%2Fs%2Fonlineapplication%2FOnlineApplication__c%2FDefault&aura.token=${encodeURIComponent(token)}`;
            const r = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
                body,
            });
            return r.json();
        },
        { url: `/communities/s/sfsites/aura?r=${reqNum}&${actionKey}=1`, message, context, token: _token },
    );

    const action = result?.actions?.[0];
    if (!action) throw new Error("No action in Aura response");
    if (action.state !== "SUCCESS") {
        // Session expired — re-init and retry once
        if (_reqNum > 2) {
            _token = null;
            await ensureSession();
            return auraPost(actionKey, descriptor, params);
        }
        throw new Error(`Aura ${actionKey} failed [${action.state}]`);
    }
    return action.returnValue;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up DOB for a carrier from WEX.
 */
export async function lookupWexDob({ carrierId, companyName, firstName = "", lastName = "" }) {
    if (!companyName?.trim()) {
        return { status: "error", carrierId, companyName, error: "companyName required" };
    }

    try {
        // Step 1: Search
        const rv = await auraPost(
            "SearchUiController.searchResultsKeyword",
            "aura://SearchUiController/ACTION$searchResultsKeyword",
            { q: companyName, objectApiName: "OnlineApplication__c", language: "en_US", options: {} },
        );
        const apps = (rv?.keywordSearchResult?.records || []).map(r => ({
            id: r.record.id,
            legalName: r.record.fields?.Legal_Business_Name__c?.value || "",
        }));
        if (!apps.length) return { status: "notFound", carrierId, companyName };

        // Step 2: Match by carrier ID
        let matched = null;
        for (const app of apps.slice(0, 5)) {
            const rec = await auraPost(
                "RecordUiController.getRecordWithFields",
                "aura://RecordUiController/ACTION$getRecordWithFields",
                { recordId: app.id, fields: ["OnlineApplication__c.Carrier_ID_Number__c", "OnlineApplication__c.Beneficial_Owner_Information__c"] },
            ).catch(() => null);
            if (!rec) continue;
            const f = rec.fields || {};
            const recCarrierId = f.Carrier_ID_Number__c?.value || "";
            const boeId = f.Beneficial_Owner_Information__c?.value || "";
            if (String(recCarrierId) === String(carrierId)) {
                matched = { carrierId: recCarrierId, boeId, legalName: app.legalName };
                break;
            }
            if (!matched && apps.length === 1) {
                matched = { carrierId: recCarrierId, boeId, legalName: app.legalName };
            }
        }
        if (!matched?.boeId) return { status: "noMatch", carrierId, companyName };

        // Step 3: Get DOBs
        const rv3 = await auraPost(
            "RelatedListUiController.getRelatedListRecords",
            "aura://RelatedListUiController/ACTION$getRelatedListRecords",
            { parentRecordId: matched.boeId, relatedListId: "Beneficial_Owners__r", fields: ["Beneficial_Owner_Prong__c.Id", "Beneficial_Owner_Prong__c.First_Name__c", "Beneficial_Owner_Prong__c.Last_Name__c", "Beneficial_Owner_Prong__c.Date_Of_Birth__c"] },
        );
        const withDob = (rv3?.records || [])
            .map(r => ({ firstName: r.fields?.First_Name__c?.value || "", lastName: r.fields?.Last_Name__c?.value || "", dob: r.fields?.Date_Of_Birth__c?.value || "" }))
            .filter(o => o.dob);
        if (!withDob.length) return { status: "noDOB", carrierId, companyName };

        // Pick best by name
        let best = withDob[0];
        if (firstName || lastName) {
            for (const o of withDob) {
                const name = `${o.firstName} ${o.lastName}`.toLowerCase();
                if (name.includes(firstName.toLowerCase()) || name.includes(lastName.toLowerCase())) { best = o; break; }
            }
        }

        const [y, m, d] = best.dob.split("-");
        return { status: "found", carrierId, companyName, dob: `${m}/${d}/${y}`, dobISO: best.dob, firstName: best.firstName, lastName: best.lastName, source: "wex" };
    } catch (err) {
        return { status: "error", carrierId, companyName, error: err.message };
    }
}

/**
 * Look up DOB and save to dob.json.
 */
export async function lookupAndSaveDob({ carrierId, companyName, firstName = "", lastName = "" }) {
    const result = await lookupWexDob({ carrierId, companyName, firstName, lastName });

    if (result.status === "found" && result.dobISO) {
        let dobMap = {};
        try { dobMap = JSON.parse(fs.readFileSync(DOB_PATH, "utf-8")); } catch {}
        dobMap[String(carrierId)] = result.dobISO;
        fs.writeFileSync(DOB_PATH, JSON.stringify(dobMap, null, 2), "utf-8");
    }

    return result;
}

/**
 * Close the browser session (call on server shutdown).
 */
export async function closeWexSession() {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    if (_browser) {
        await _browser.close().catch(() => {});
        _browser = null;
        _page = null;
        _token = null;
        console.log("[wex] Session closed");
    }
}
