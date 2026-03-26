/**
 * wex.js — WEX (Salesforce Experience Cloud) integration service.
 *
 * Provides a persistent browser session for looking up carrier data from the
 * WEX Community portal.  Uses Playwright to authenticate and then calls the
 * Salesforce Aura REST API to:
 *
 *   1. Search OnlineApplication records by company name
 *   2. Get application details (Carrier ID, Beneficial Owner Entity ID)
 *   3. Get Beneficial Owner Prong DOBs
 *
 * Designed to mirror the iSoftPull service pattern:
 *   - Singleton browser + context (reused across requests)
 *   - Serialised request queue to avoid navigation conflicts
 *   - Auto-login with session persistence
 *
 * Primary DOB source — checked before iSoftPull in the carrier-db sync.
 */

import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, "../../data/wex-session.json");

// ── Constants ────────────────────────────────────────────────────────────────

const WEX_URL = "https://wexinc.my.site.com/communities/s";

// Aura framework values (stable across sessions)
const AURA_FWUID = "VEhtaDlVRkdCeTJiZFhuOTVYYjRJQTJEa1N5enhOU3R5QWl2VzNveFZTbGcxMy4tMjE0NzQ4MzY0OC4xMzEwNzIwMA";
const AURA_APP = "siteforce:communityApp";
const AURA_LOADED = { "APPLICATION@markup://siteforce:communityApp": "1533_ez-GoXD6UAAJ6rtTbHErdw" };

// ── Singleton state ──────────────────────────────────────────────────────────

let browser = null;
let browserContext = null;
let auraToken = null;
let reqNum = 1;

// Serialise all WEX operations to avoid concurrent navigation conflicts
let queue = Promise.resolve();

function enqueue(fn) {
    const next = queue.then(fn);
    queue = next.catch(() => {}); // keep queue alive even if fn throws
    return next;
}

const LAUNCH_OPTS = {
    headless: env.WEX_HEADLESS,
    args: ["--disable-gpu", "--no-sandbox", "--disable-setuid-sandbox"],
};

// ── Browser lifecycle ────────────────────────────────────────────────────────

async function ensureBrowser() {
    if (browser?.isConnected()) return;

    try {
        browser = await chromium.launch(LAUNCH_OPTS);
    } catch (err) {
        if (err.message.includes("Executable doesn't exist")) {
            console.log("[wex] Chromium not found — installing now...");
            execSync("npx playwright install chromium chromium-headless-shell", { stdio: "inherit" });
            browser = await chromium.launch(LAUNCH_OPTS);
            console.log("[wex] Chromium installed and launched.");
        } else {
            throw err;
        }
    }
    browserContext = null;
    auraToken = null;
}

async function ensureContext() {
    await ensureBrowser();
    if (!browserContext) {
        const storageState = fs.existsSync(SESSION_PATH) ? SESSION_PATH : undefined;
        browserContext = await browser.newContext({ storageState });
    }
    return browserContext;
}

async function ensureAuraToken(page) {
    if (auraToken) return auraToken;

    // Navigate to the WEX portal and extract the Aura CSRF token
    await page.goto(
        `${WEX_URL}/onlineapplication/OnlineApplication__c/Default`,
        { waitUntil: "networkidle", timeout: 30000 }
    );

    auraToken = await extractAuraToken(page);

    if (!auraToken) {
        // May need to log in
        const url = page.url();
        if (url.includes("login") || url.includes("?ec=")) {
            await doLogin(page);
            auraToken = await extractAuraToken(page);
        }
    }

    if (!auraToken) {
        throw new Error("[wex] Failed to obtain Aura token — check WEX credentials");
    }

    console.log("[wex] Aura token obtained.");
    return auraToken;
}

async function extractAuraToken(page) {
    return page.evaluate(() => {
        // Salesforce Aura stores the CSRF token in different places depending on version
        try {
            if (window.$A && window.$A.Hi && window.$A.Hi.client) return window.$A.Hi.client.Ac;
        } catch {}
        try {
            if (window.$A && window.$A.getToken) return window.$A.getToken();
        } catch {}
        return null;
    });
}

async function doLogin(page) {
    if (!env.WEX_EMAIL || !env.WEX_PASSWORD) {
        throw new Error("[wex] WEX_EMAIL and WEX_PASSWORD are required");
    }

    console.log("[wex] Logging in...");
    await page.fill('input[type="email"], input[name="username"]', env.WEX_EMAIL);
    await page.fill('input[type="password"], input[name="password"]', env.WEX_PASSWORD);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 });
    await browserContext.storageState({ path: SESSION_PATH });
    console.log("[wex] Login successful, session saved.");
}

// ── Aura API ─────────────────────────────────────────────────────────────────

async function auraPost(page, actionKey, descriptor, params) {
    const num = reqNum++;
    const message = JSON.stringify({
        actions: [{
            id: "1;a",
            descriptor,
            callingDescriptor: "UNKNOWN",
            params,
        }],
    });
    const context = JSON.stringify({
        mode: "PROD",
        fwuid: AURA_FWUID,
        app: AURA_APP,
        loaded: AURA_LOADED,
        dn: [],
        globals: {},
        uad: true,
    });

    const result = await page.evaluate(
        async ({ url, message, context, token }) => {
            const body = `message=${encodeURIComponent(message)}&aura.context=${encodeURIComponent(context)}&aura.pageURI=%2Fcommunities%2Fs%2Fonlineapplication%2FOnlineApplication__c%2FDefault&aura.token=${encodeURIComponent(token)}`;
            const r = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
                body,
            });
            return r.json();
        },
        {
            url: `/communities/s/sfsites/aura?r=${num}&${actionKey}=1`,
            message,
            context,
            token: auraToken,
        }
    );

    const action = result.actions?.[0];
    if (!action) throw new Error(`[wex] No action in Aura response for ${actionKey}`);
    if (action.state !== "SUCCESS") {
        // Token may have expired — clear it so next call re-acquires
        if (action.state === "ERROR") auraToken = null;
        throw new Error(`[wex] Aura ${actionKey} [${action.state}]: ${JSON.stringify(action.error || "").substring(0, 300)}`);
    }
    return action.returnValue;
}

// ── WEX data lookup steps ────────────────────────────────────────────────────

/**
 * Step 1: Search OnlineApplication records by company name (SOSL global search).
 * @returns {Array<{ id, legalName }>}
 */
async function searchApplications(page, companyName) {
    const rv = await auraPost(
        page,
        "SearchUiController.searchResultsKeyword",
        "aura://SearchUiController/ACTION$searchResultsKeyword",
        { q: companyName, objectApiName: "OnlineApplication__c", language: "en_US", options: {} }
    );
    const records = rv?.keywordSearchResult?.records || [];
    return records.map((r) => ({
        id: r.record.id,
        legalName: r.record.fields.Legal_Business_Name__c?.value || "",
    }));
}

/**
 * Step 2: Get application record fields (Carrier ID, BOE ID, and additional fields).
 * @returns {{ carrierId, boeId, ...extra fields }}
 */
async function getApplicationRecord(page, appId) {
    const rv = await auraPost(
        page,
        "RecordUiController.getRecordWithFields",
        "aura://RecordUiController/ACTION$getRecordWithFields",
        {
            recordId: appId,
            fields: [
                "OnlineApplication__c.Carrier_ID_Number__c",
                "OnlineApplication__c.Beneficial_Owner_Information__c",
                "OnlineApplication__c.Legal_Business_Name__c",
                "OnlineApplication__c.DBA_Name__c",
                "OnlineApplication__c.Physical_Address__c",
                "OnlineApplication__c.Physical_City__c",
                "OnlineApplication__c.Physical_State__c",
                "OnlineApplication__c.Physical_Zip__c",
                "OnlineApplication__c.Phone__c",
                "OnlineApplication__c.Email__c",
                "OnlineApplication__c.EIN__c",
                "OnlineApplication__c.Status__c",
                "OnlineApplication__c.CreatedDate",
            ],
        }
    );
    const f = rv.fields || {};
    const val = (key) => f[key]?.value ?? "";
    return {
        carrierId: val("Carrier_ID_Number__c"),
        boeId: val("Beneficial_Owner_Information__c"),
        legalName: val("Legal_Business_Name__c"),
        dbaName: val("DBA_Name__c"),
        address: val("Physical_Address__c"),
        city: val("Physical_City__c"),
        state: val("Physical_State__c"),
        zip: val("Physical_Zip__c"),
        phone: val("Phone__c"),
        email: val("Email__c"),
        ein: val("EIN__c"),
        status: val("Status__c"),
        createdDate: val("CreatedDate"),
    };
}

/**
 * Step 3: Get Beneficial Owner Prong records (DOB, name, ownership %).
 * @returns {Array<{ id, firstName, lastName, dob, ownershipPercent }>}
 */
async function getBeneficialOwnerDOBs(page, boeId) {
    const rv = await auraPost(
        page,
        "RelatedListUiController.getRelatedListRecords",
        "aura://RelatedListUiController/ACTION$getRelatedListRecords",
        {
            parentRecordId: boeId,
            relatedListId: "Beneficial_Owners__r",
            fields: [
                "Beneficial_Owner_Prong__c.Id",
                "Beneficial_Owner_Prong__c.First_Name__c",
                "Beneficial_Owner_Prong__c.Last_Name__c",
                "Beneficial_Owner_Prong__c.Date_Of_Birth__c",
                "Beneficial_Owner_Prong__c.Ownership_Percentage__c",
                "Beneficial_Owner_Prong__c.SSN__c",
                "Beneficial_Owner_Prong__c.Address__c",
                "Beneficial_Owner_Prong__c.City__c",
                "Beneficial_Owner_Prong__c.State__c",
                "Beneficial_Owner_Prong__c.Zip_Code__c",
            ],
        }
    );
    return (rv.records || []).map((r) => {
        const val = (key) => r.fields?.[key]?.value ?? "";
        return {
            id: r.id,
            firstName: val("First_Name__c"),
            lastName: val("Last_Name__c"),
            dob: val("Date_Of_Birth__c"),               // "YYYY-MM-DD"
            ownershipPercent: val("Ownership_Percentage__c"),
            ssn: val("SSN__c"),
            address: val("Address__c"),
            city: val("City__c"),
            state: val("State__c"),
            zip: val("Zip_Code__c"),
        };
    });
}

// ── DOB format helpers ───────────────────────────────────────────────────────

function formatDobMmddyyyy(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "";
    const [y, m, d] = iso.split("-");
    return `${m}/${d}/${y}`;
}

function formatDob8digit(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
    return iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(0, 4); // MMDDYYYY
}

// ── Name matching ────────────────────────────────────────────────────────────

function norm(s) {
    return (s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

function nameMatch(firstName, lastName, ownerFirstName, ownerLastName) {
    const target = norm(`${firstName}${lastName}`);
    const candidate = norm(`${ownerFirstName}${ownerLastName}`);
    if (target === candidate) return true;
    // Partial: both last names match and first token matches
    if (norm(lastName) && norm(ownerLastName) && norm(lastName) === norm(ownerLastName)) {
        const firstToken = norm(firstName).slice(0, 3);
        if (firstToken && norm(ownerFirstName).startsWith(firstToken)) return true;
    }
    return false;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up a carrier's full WEX data (DOB + application details + beneficial owners).
 *
 * @param {{ carrierId: string, companyName: string, firstName?: string, lastName?: string }} candidate
 * @returns {Promise<object>} result with status + data
 *
 * status values:
 *   'found'    — DOB found (+ full application data)
 *   'notFound' — no search results for company name
 *   'noMatch'  — search results found but no carrier ID match
 *   'noBOE'    — application found but no Beneficial Owner Entity
 *   'noBOP'    — BOE found but no Beneficial Owner Prong records
 *   'noDOB'    — owners found but none have a DOB
 *   'error'    — exception
 */
export function lookupWexDob(candidate) {
    return enqueue(async () => {
        const { carrierId, companyName, firstName = "", lastName = "" } = candidate;

        if (!companyName?.trim()) {
            return { status: "error", carrierId, companyName, error: "companyName is required for WEX search" };
        }

        const ctx = await ensureContext();
        const page = await ctx.newPage();

        try {
            await ensureAuraToken(page);

            // Step 1: Search
            const apps = await searchApplications(page, companyName);
            if (!apps.length) {
                return { status: "notFound", carrierId, companyName, searchResults: 0 };
            }

            // Step 2: Find matching application by carrier ID
            let matched = null;
            for (const app of apps.slice(0, 5)) {
                const rec = await getApplicationRecord(page, app.id).catch(() => null);
                if (!rec) continue;
                if (rec.carrierId === String(carrierId)) {
                    matched = { ...rec, appId: app.id };
                    break;
                }
                // If only 1 result, use it even if carrier ID differs
                if (!matched && apps.length === 1) {
                    matched = { ...rec, appId: app.id };
                }
            }

            if (!matched) {
                return { status: "noMatch", carrierId, companyName, searchResults: apps.length };
            }

            if (!matched.boeId) {
                return {
                    status: "noBOE",
                    carrierId,
                    companyName,
                    matchedCarrierId: matched.carrierId,
                    application: matched,
                };
            }

            // Step 3: Get beneficial owners
            const owners = await getBeneficialOwnerDOBs(page, matched.boeId);
            if (!owners.length) {
                return {
                    status: "noBOP",
                    carrierId,
                    companyName,
                    matchedCarrierId: matched.carrierId,
                    application: matched,
                };
            }

            const ownersWithDOB = owners.filter((o) => o.dob);
            if (!ownersWithDOB.length) {
                return {
                    status: "noDOB",
                    carrierId,
                    companyName,
                    matchedCarrierId: matched.carrierId,
                    application: matched,
                    owners,
                };
            }

            // Pick best DOB — prefer name match, else take first
            let best = ownersWithDOB[0];
            if (firstName || lastName) {
                for (const o of ownersWithDOB) {
                    if (nameMatch(firstName, lastName, o.firstName, o.lastName)) {
                        best = o;
                        break;
                    }
                }
            }

            return {
                status: "found",
                carrierId,
                companyName,
                dob: formatDobMmddyyyy(best.dob),     // "MM/DD/YYYY"
                dobISO: best.dob,                       // "YYYY-MM-DD"
                dob8: formatDob8digit(best.dob),        // "MMDDYYYY"
                firstName: best.firstName,
                lastName: best.lastName,
                matchedCarrierId: matched.carrierId,
                application: matched,
                owners,
                source: "wex",
            };
        } catch (err) {
            // If it's an auth error, clear the token so we re-login next time
            if (err.message.includes("token") || err.message.includes("401") || err.message.includes("login")) {
                auraToken = null;
            }
            return { status: "error", carrierId, companyName, error: err.message };
        } finally {
            await page.close();
        }
    });
}

/**
 * Check if WEX is configured (credentials present).
 */
export function hasWexConfig() {
    return Boolean(env.WEX_EMAIL && env.WEX_PASSWORD);
}

/**
 * Cleanly close the WEX browser on shutdown.
 */
export async function closeWexBrowser() {
    if (browser) {
        await browser.close();
        browser = null;
        browserContext = null;
        auraToken = null;
    }
}
