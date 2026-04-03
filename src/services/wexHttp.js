/**
 * WEX DOB Lookup service — hybrid Browserless + HTTP approach.
 *
 * 1. Uses Browserless.io (remote Chrome) to login to WEX and get the Aura CSRF token
 * 2. Caches the token + session cookies
 * 3. All subsequent Aura API calls use plain fetch() with cached credentials
 * 4. Re-acquires token only when expired (~25 min)
 *
 * Locally: uses Playwright if available, falls back to Browserless
 * On Render: always uses Browserless (no local Chrome needed)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOB_PATH = path.resolve(__dirname, "../../data/dob.json");

const WEX_BASE     = "https://wexinc.my.site.com";
const WEX_URL      = `${WEX_BASE}/communities/s`;
const WEX_EMAIL    = env.WEX_EMAIL    || "";
const WEX_PASSWORD = env.WEX_PASSWORD || "";
const BROWSERLESS_TOKEN = env.BROWSERLESS_TOKEN || "";
const BROWSERLESS_URL   = `wss://production-sfo.browserless.io?token=${BROWSERLESS_TOKEN}`;

const SESSION_TTL_MS = 25 * 60 * 1000; // 25 min

// ── Cached session state ──────────────────────────────────────────────────────

let _token = null;
let _cookies = "";
let _fwuid = "";
let _loaded = {};
let _sessionExpiry = 0;
let _reqNum = 1;
let _initPromise = null;

function isReady() {
    return _token && _cookies && Date.now() < _sessionExpiry;
}

// ── Token acquisition via browser (Browserless or local Playwright) ───────────

async function acquireToken() {
    if (_initPromise) return _initPromise;
    _initPromise = _acquireTokenImpl();
    try { await _initPromise; } finally { _initPromise = null; }
}

async function _acquireTokenImpl() {
    if (!WEX_EMAIL || !WEX_PASSWORD) {
        throw new Error("WEX_EMAIL and WEX_PASSWORD must be set");
    }

    let browser;
    let usedBrowserless = false;

    try {
        // Try local Playwright first, fall back to Browserless
        let chromium;
        try {
            ({ chromium } = await import("playwright"));
            console.log("[wex] Using local Playwright...");
            browser = await chromium.launch({
                headless: env.WEX_HEADLESS !== "false",
                args: ["--disable-gpu", "--no-sandbox", "--disable-setuid-sandbox"],
            });
        } catch {
            if (!BROWSERLESS_TOKEN) {
                throw new Error("No local Playwright and BROWSERLESS_TOKEN not set");
            }
            console.log("[wex] Using Browserless.io...");
            ({ chromium } = await import("playwright-core"));
            browser = await chromium.connectOverCDP(BROWSERLESS_URL);
            usedBrowserless = true;
        }

        const context = await browser.newContext();
        const page = await context.newPage();

        // Navigate to WEX
        await page.goto(
            `${WEX_URL}/onlineapplication/OnlineApplication__c/Default`,
            { waitUntil: "domcontentloaded", timeout: 60000 },
        );

        // Login if needed
        let token = await page.evaluate(() => window.$A?.Hi?.client?.Ac || null);

        if (!token) {
            const url = page.url();
            if (url.includes("login") || url.includes("?ec=")) {
                console.log("[wex] Logging in...");
                await page.fill('input[type="email"], input[name="username"]', WEX_EMAIL);
                await page.fill('input[type="password"], input[name="password"]', WEX_PASSWORD);
                await page.click('button[type="submit"], input[type="submit"]');
                await page.waitForURL("**/communities/s/**", { timeout: 60000 });
                await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
                await page.waitForTimeout(3000);
                token = await page.evaluate(() => window.$A?.Hi?.client?.Ac || null);
            }
        }

        if (!token) throw new Error("Failed to obtain Aura token from WEX");

        // Extract cookies for plain HTTP calls
        const browserCookies = await context.cookies();
        _cookies = browserCookies.map(c => `${c.name}=${c.value}`).join("; ");

        // Extract fwuid and loaded from page
        const pageConfig = await page.evaluate(() => {
            const html = document.documentElement.outerHTML;
            const fwMatch = html.match(/auraFW\/javascript\/([A-Za-z0-9_+/=-]+)\/aura/);
            const loadedMatch = html.match(/"loaded"\s*:\s*(\{"[^}]+\})/);
            return {
                fwuid: fwMatch?.[1] || "",
                loaded: loadedMatch?.[1] || "{}",
            };
        });

        _token = token;
        _fwuid = pageConfig.fwuid || _fwuid;
        try { _loaded = JSON.parse(pageConfig.loaded); } catch {}
        _reqNum = 1;
        _sessionExpiry = Date.now() + SESSION_TTL_MS;

        console.log(`[wex] Token acquired via ${usedBrowserless ? "Browserless" : "local Playwright"} — valid for 25 min`);

        // Close browser immediately — we only needed the token + cookies
        await browser.close().catch(() => {});
    } catch (err) {
        if (browser) await browser.close().catch(() => {});
        throw err;
    }
}

async function ensureSession() {
    if (isReady()) return;
    await acquireToken();
}

// ── Aura API via plain HTTP ──────────────────────────────────────────────────

async function auraPost(actionKey, descriptor, params) {
    await ensureSession();

    const reqNum = _reqNum++;
    const message = JSON.stringify({
        actions: [{ id: "1;a", descriptor, callingDescriptor: "UNKNOWN", params }],
    });
    const context = JSON.stringify({
        mode: "PROD", fwuid: _fwuid, app: "siteforce:communityApp",
        loaded: _loaded, dn: [], globals: {}, uad: true,
    });

    const body = `message=${encodeURIComponent(message)}&aura.context=${encodeURIComponent(context)}&aura.pageURI=%2Fcommunities%2Fs%2Fonlineapplication%2FOnlineApplication__c%2FDefault&aura.token=${encodeURIComponent(_token)}`;

    const res = await fetch(
        `${WEX_BASE}/communities/s/sfsites/aura?r=${reqNum}&${actionKey}=1`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Cookie": _cookies,
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
            },
            body,
        },
    );

    const raw = await res.text();
    // Aura wraps responses in /* ... */ comments
    const clean = raw.replace(/^\/\*+\s*/, "").replace(/\s*\/\*ERROR\*\/\s*$/, "");
    let data;
    try { data = JSON.parse(clean); } catch { throw new Error(`Aura parse error: ${raw.slice(0, 150)}`); }

    // Session expired — re-acquire token and retry once
    if (data.event?.descriptor === "markup://aura:invalidSession") {
        console.log("[wex] Session expired — re-acquiring token...");
        _token = null;
        _sessionExpiry = 0;
        await acquireToken();
        return auraPost(actionKey, descriptor, params);
    }

    // Client out of sync — update fwuid and retry
    if (data.event?.descriptor === "markup://aura:clientOutOfSync") {
        console.log("[wex] Client out of sync — re-acquiring token...");
        _token = null;
        _sessionExpiry = 0;
        await acquireToken();
        return auraPost(actionKey, descriptor, params);
    }

    const action = data?.actions?.[0];
    if (!action) throw new Error(`No action in Aura response: ${raw.slice(0, 150)}`);
    if (action.state !== "SUCCESS") {
        throw new Error(`Aura ${actionKey} failed [${action.state}]: ${JSON.stringify(action.error || "").slice(0, 100)}`);
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
 * Close session (clear cached token).
 */
export async function closeWexSession() {
    _token = null;
    _cookies = "";
    _sessionExpiry = 0;
    console.log("[wex] Session cleared");
}
