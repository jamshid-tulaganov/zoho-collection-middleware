/**
 * wex-automation.js — WEX Salesforce Experience Cloud browser automation.
 *
 * Uses Playwright URL navigation and intercepts Aura API responses from the
 * portal's OWN network requests — no need to guess hard-coded Aura descriptors.
 *
 * Data path: Search → OnlineApplication → BOE → BOP → Date_Of_Birth__c
 *
 * URL patterns:
 *   /communities/s/global-search/{query}
 *   /communities/s/detail/{recordId}
 *   /communities/s/relatedlist/{parentId}/{relationship}
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, "../data/wex-session.json");
const WEX_BASE = "https://wexinc.my.site.com/communities/s";

// ── Aura response capture ─────────────────────────────────────────────────────

/**
 * Navigate to a URL and capture all Aura API action responses from
 * the page's own network requests. Returns an array of successful actions.
 */
async function navigateWithAuraCapture(page, url, { extraWaitMs = 1500 } = {}) {
    const captured = [];

    const onResponse = async (response) => {
        if (!response.url().includes("/sfsites/aura")) return;
        try {
            const body = await response.json();
            for (const action of body.actions || []) {
                if (action.state === "SUCCESS" && action.returnValue != null) {
                    captured.push({ id: action.id, returnValue: action.returnValue });
                }
            }
        } catch {
            // non-JSON or empty response — skip
        }
    };

    page.on("response", onResponse);
    try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        if (extraWaitMs > 0) {
            await page.waitForTimeout(extraWaitMs);
        }
    } finally {
        page.off("response", onResponse);
    }

    return captured;
}

// ── Aura data extractors ──────────────────────────────────────────────────────

/**
 * Find record field data in captured Aura responses.
 * Salesforce stores records under returnValue.record.fields or returnValue.records[id].fields.
 */
function findRecordFields(captured, recordId) {
    for (const c of captured) {
        const rv = c.returnValue;
        if (!rv) continue;

        // RecordUi: { record: { id, fields } }
        if (rv.record?.id === recordId) return rv.record.fields || {};
        if (rv.record?.fields && !recordId) return rv.record.fields;

        // RecordGvp / getRecord: { id, fields }
        if (rv.id === recordId && rv.fields) return rv.fields;

        // Multiple records: { records: { [id]: { fields } } }
        if (rv.records) {
            const rec = rv.records[recordId];
            if (rec?.fields) return rec.fields;
        }

        // Layout / getRecordWithLayouts: look in nested structures
        if (rv.apiName && rv.fields && rv.id === recordId) return rv.fields;
    }
    return null;
}

/**
 * Find search results in captured Aura responses.
 */
function findSearchResults(captured) {
    for (const c of captured) {
        const rv = c.returnValue;
        if (!rv) continue;

        // Search results format
        if (rv.keywordSearchResult?.records) return rv.keywordSearchResult.records;
        if (rv.searchResults?.records) return rv.searchResults.records;
        if (rv.result?.records) return rv.result.records;
        if (Array.isArray(rv.records) && rv.records.length > 0) {
            // Make sure these look like search results (have id + fields)
            if (rv.records[0]?.record?.id || rv.records[0]?.id) return rv.records;
        }
    }
    return null;
}

/**
 * Find related list records in captured Aura responses.
 */
function findRelatedListRecords(captured) {
    for (const c of captured) {
        const rv = c.returnValue;
        if (!rv) continue;

        if (rv.body?.records) return rv.body.records;
        if (rv.count != null && Array.isArray(rv.records)) return rv.records;
        if (rv.listReference && Array.isArray(rv.records)) return rv.records;
    }
    return null;
}

// ── Field value helper ────────────────────────────────────────────────────────

function fieldVal(fields, key) {
    if (!fields) return "";
    const f = fields[key];
    if (!f) return "";
    const v = f.value ?? f.displayValue;
    if (v == null || v === "null" || v === "undefined") return "";
    return String(v).trim();
}

// ── Step 1: Search ────────────────────────────────────────────────────────────

async function searchApplications(page, companyName) {
    const url = `${WEX_BASE}/global-search/${encodeURIComponent(companyName)}`;
    console.log(`[wex] Search URL: ${url}`);

    const captured = await navigateWithAuraCapture(page, url, { extraWaitMs: 2000 });
    console.log(`[wex] Captured ${captured.length} Aura actions from search`);

    // Try Aura capture first
    const auraResults = findSearchResults(captured);
    if (auraResults && auraResults.length > 0) {
        const apps = auraResults
            .map((r) => {
                const rec = r.record || r;
                const f = rec.fields || {};
                const apiName = rec.apiName || r.apiName || "";
                // Only Online Application records
                if (apiName && apiName !== "OnlineApplication__c") return null;
                return {
                    id: rec.id || r.id,
                    legalName: fieldVal(f, "Legal_Business_Name__c") || fieldVal(f, "Name") || rec.id,
                    status: fieldVal(f, "Status__c") || fieldVal(f, "Application_Stage__c"),
                    offer: fieldVal(f, "Offer__c"),
                };
            })
            .filter(Boolean)
            .filter((r) => r.id);
        if (apps.length) {
            console.log(`[wex] Found ${apps.length} apps from Aura`);
            return apps;
        }
    }

    // Fallback: extract from DOM
    console.log("[wex] No Aura search results, trying DOM fallback...");
    return extractSearchDOM(page);
}

async function extractSearchDOM(page) {
    await page.waitForTimeout(2000);
    return page.evaluate(() => {
        const results = [];
        // Links matching OnlineApplication records
        document.querySelectorAll('a[href*="/onlineapplication/"], a[href*="/detail/"]').forEach((link) => {
            const href = link.getAttribute("href") || "";
            // Application records have IDs like a3P... (18-char Salesforce IDs start with specific prefixes)
            const match = href.match(/\/(?:onlineapplication|detail)\/([a-zA-Z0-9]{15,18})/);
            if (!match) return;
            const text = (link.textContent || "").trim();
            // Application records show as "Application-NNNNNN" or company names
            results.push({ id: match[1], legalName: text, status: "", offer: "" });
        });
        return results;
    });
}

// ── Step 2: Get Application Record ───────────────────────────────────────────

async function getApplicationRecord(page, appId) {
    const url = `${WEX_BASE}/detail/${appId}`;
    console.log(`[wex] App detail: ${url}`);

    const captured = await navigateWithAuraCapture(page, url, { extraWaitMs: 1500 });
    console.log(`[wex] Captured ${captured.length} Aura actions from app detail`);

    // Try all captured responses for record fields
    let fields = findRecordFields(captured, appId);

    // Widen search — try any captured response that has fields
    if (!fields) {
        for (const c of captured) {
            const rv = c.returnValue;
            if (rv?.record?.fields) { fields = rv.record.fields; break; }
            if (rv?.fields && rv.id) { fields = rv.fields; break; }
        }
    }

    if (fields) {
        const val = (k) => fieldVal(fields, k);
        return {
            appId,
            carrierId: val("Carrier_ID_Number__c"),
            boeId: val("Beneficial_Owner_Information__c"),
            legalName: val("Legal_Business_Name__c"),
            tradeName: val("Trade_Name__c") || val("DBA_Name__c"),
            streetAddress: val("Street_Address__c") || val("Physical_Address__c"),
            federalTaxId: val("Federal_Tax_ID__c") || val("EIN__c"),
            dotNumber: val("DOT_Number__c"),
            mcNumber: val("MC_Number__c"),
            offer: val("Offer__c"),
            program: val("Program__c"),
            applicationStage: val("Application_Stage__c") || val("Status__c"),
            creditDecision: val("Credit_Decision__c"),
            createdDate: val("CreatedDate"),
            // Proprietor (sole owner) DOB stored directly on application
            proprietorFirstName: val("First_Name__c"),
            proprietorLastName: val("Last_Name__c"),
            proprietorDob: val("Date_of_Birth__c") || val("Date_Of_Birth__c"),
        };
    }

    // DOM fallback
    console.log("[wex] Falling back to DOM extraction for app record...");
    return extractAppRecordDOM(page, appId);
}

async function extractAppRecordDOM(page, appId) {
    return page.evaluate((id) => {
        const result = { appId: id, carrierId: "", boeId: "", legalName: "" };

        // Find BOE link (e.g. "BOE-20250527-2141947")
        document.querySelectorAll('a[href*="/detail/"]').forEach((link) => {
            const text = (link.textContent || "").trim();
            if (text.startsWith("BOE-")) {
                const href = link.getAttribute("href") || "";
                const m = href.match(/\/detail\/([a-zA-Z0-9]{15,18})/);
                if (m) result.boeId = m[1];
            }
        });

        // Field labels
        document.querySelectorAll(".slds-form-element, [data-field-id]").forEach((el) => {
            const labelEl = el.querySelector("label, .slds-form-element__label");
            const valueEl = el.querySelector(
                "lightning-formatted-text, .slds-form-element__static, lightning-formatted-url a, a"
            );
            if (!labelEl || !valueEl) return;
            const label = (labelEl.textContent || "").trim().toLowerCase();
            const value = (valueEl.textContent || "").trim();
            if (label.includes("legal business name")) result.legalName = value;
            if (label.includes("federal tax") || label.includes("tax id")) result.federalTaxId = value;
            if (label.includes("dot number")) result.dotNumber = value;
            if (label.includes("carrier id")) result.carrierId = value;
        });

        return result;
    }, appId);
}

// ── Step 3: Get Beneficial Owners from BOE ───────────────────────────────────

async function getBeneficialOwners(page, boeId) {
    // Navigate to BOE detail page — page loads with related list data
    const boeUrl = `${WEX_BASE}/detail/${boeId}`;
    console.log(`[wex] BOE detail: ${boeUrl}`);

    let captured = await navigateWithAuraCapture(page, boeUrl, { extraWaitMs: 2000 });
    console.log(`[wex] Captured ${captured.length} Aura actions from BOE detail`);

    let records = findRelatedListRecords(captured);

    // If the related list wasn't included, explicitly navigate to it
    if (!records || records.length === 0) {
        const relUrl = `${WEX_BASE}/relatedlist/${boeId}/Beneficial_Owners__r`;
        console.log(`[wex] Related list: ${relUrl}`);
        captured = await navigateWithAuraCapture(page, relUrl, { extraWaitMs: 2000 });
        console.log(`[wex] Captured ${captured.length} Aura actions from related list`);
        records = findRelatedListRecords(captured);
    }

    if (records && records.length > 0) {
        return records.map((r) => {
            const f = r.fields || {};
            const val = (k) => fieldVal(f, k);
            return {
                id: r.id,
                firstName: val("First_Name__c"),
                lastName: val("Last_Name__c"),
                title: val("Title__c"),
                dob: val("Date_Of_Birth__c"),
                ssn: val("Social_Security_Number__c"),
                address: val("Address_Line_1__c") || val("Address__c"),
                city: val("City__c"),
                state: val("State__c"),
                zip: val("Postal_Code__c") || val("Zip_Code__c"),
                country: val("Country__c"),
                verificationStatus: val("Verification_Status__c"),
                ownershipPercent: val("Ownership_Percentage__c"),
            };
        });
    }

    // DOM fallback: find BOP links on the BOE page and navigate to each
    console.log("[wex] No related list data, trying BOP link extraction from DOM...");
    return extractBOPsFromDOM(page, boeId);
}

async function extractBOPsFromDOM(page, boeId) {
    // Navigate back to BOE page (might have navigated away to related list)
    const boeUrl = `${WEX_BASE}/detail/${boeId}`;
    if (!page.url().includes(boeId)) {
        await navigateWithAuraCapture(page, boeUrl);
    }

    const bopLinks = await page.evaluate(() => {
        const links = [];
        document.querySelectorAll('a[href*="/detail/"]').forEach((link) => {
            const text = (link.textContent || "").trim();
            if (text.startsWith("BOP-") || text.startsWith("Owner-")) {
                const href = link.getAttribute("href") || "";
                const m = href.match(/\/detail\/([a-zA-Z0-9]{15,18})/);
                if (m) links.push({ id: m[1], name: text });
            }
        });
        return links;
    });

    if (!bopLinks.length) return [];

    const owners = [];
    for (const bopLink of bopLinks) {
        const bopUrl = `${WEX_BASE}/detail/${bopLink.id}`;
        console.log(`[wex] BOP detail: ${bopUrl}`);
        const bopCaptured = await navigateWithAuraCapture(page, bopUrl);

        const f = findRecordFields(bopCaptured, bopLink.id)
            || (() => {
                for (const c of bopCaptured) {
                    if (c.returnValue?.record?.fields) return c.returnValue.record.fields;
                    if (c.returnValue?.fields && c.returnValue.id) return c.returnValue.fields;
                }
                return null;
            })();

        if (!f) continue;
        owners.push({
            id: bopLink.id,
            firstName: fieldVal(f, "First_Name__c"),
            lastName: fieldVal(f, "Last_Name__c"),
            title: fieldVal(f, "Title__c"),
            dob: fieldVal(f, "Date_Of_Birth__c"),
            ssn: fieldVal(f, "Social_Security_Number__c"),
            address: fieldVal(f, "Address_Line_1__c") || fieldVal(f, "Address__c"),
            city: fieldVal(f, "City__c"),
            state: fieldVal(f, "State__c"),
            zip: fieldVal(f, "Postal_Code__c") || fieldVal(f, "Zip_Code__c"),
            country: fieldVal(f, "Country__c"),
            verificationStatus: fieldVal(f, "Verification_Status__c"),
            ownershipPercent: fieldVal(f, "Ownership_Percentage__c"),
        });
    }
    return owners;
}

// ── Matching helpers ──────────────────────────────────────────────────────────

function norm(s) {
    return (s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

function companyScore(searchName, resultName) {
    if (!searchName || !resultName) return 0;
    const a = norm(searchName);
    const b = norm(resultName);
    if (!a || !b) return 0;
    if (a === b) return 1.0;
    if (a.includes(b) || b.includes(a)) return 0.9;

    // Word overlap score
    const stopWords = new Set(["llc", "inc", "corp", "ltd", "co", "the", "and", "of"]);
    const wordsA = searchName.toLowerCase().split(/[\s,\.]+/).filter((w) => w.length > 2 && !stopWords.has(w));
    const wordsB = resultName.toLowerCase().split(/[\s,\.]+/).filter((w) => w.length > 2 && !stopWords.has(w));
    if (!wordsA.length || !wordsB.length) return 0;

    const setA = new Set(wordsA.map((w) => norm(w)));
    const setB = new Set(wordsB.map((w) => norm(w)));
    const common = [...setA].filter((w) => setB.has(w)).length;
    const union = new Set([...setA, ...setB]).size;
    return common / union; // Jaccard similarity
}

function nameMatch(firstName, lastName, ownerFirst, ownerLast) {
    if (!firstName && !lastName) return true;
    const targetLn = norm(lastName);
    const targetFn = norm(firstName);
    const candLn = norm(ownerLast);
    const candFn = norm(ownerFirst);

    if (targetLn && candLn && targetLn !== candLn) return false;
    if (targetFn && candFn && !candFn.startsWith(targetFn.slice(0, 3))) return false;
    return true;
}

// ── DOB formatting ────────────────────────────────────────────────────────────

function formatDobDisplay(iso) {
    if (!iso) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(iso)) {
        const [y, m, d] = iso.slice(0, 10).split("-");
        return `${m}/${d}/${y}`;
    }
    return iso; // already formatted or unknown
}

function formatDob8(iso) {
    if (!iso) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(iso)) {
        return iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(0, 4);
    }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(iso)) return iso.replace(/\//g, "");
    return "";
}

// ── Authentication ────────────────────────────────────────────────────────────

export async function ensureLoggedIn(page) {
    const url = page.url();
    const needsLogin = url.includes("login") || url.includes("?ec=") || url.includes("/Login");
    if (!needsLogin) return;

    const email = process.env.WEX_EMAIL;
    const password = process.env.WEX_PASSWORD;
    if (!email || !password) throw new Error("[wex] WEX_EMAIL and WEX_PASSWORD required");

    console.log("[wex] Logging in...");
    try {
        await page.fill('input[type="email"], input[name="username"]', email, { timeout: 5000 });
        await page.fill('input[type="password"], input[name="password"]', password, { timeout: 5000 });
        await page.click('button[type="submit"], input[type="submit"]', { timeout: 5000 });
        await page.waitForURL((u) => !u.includes("login") && !u.includes("?ec="), { timeout: 20000 });
        console.log("[wex] Login successful.");
    } catch (err) {
        throw new Error(`[wex] Login failed: ${err.message}`);
    }
}

async function navigateAuthWithCapture(page, context, url) {
    const captured = await navigateWithAuraCapture(page, url);
    if (page.url().includes("login") || page.url().includes("?ec=")) {
        await ensureLoggedIn(page);
        // Save session state
        try {
            const dir = path.dirname(SESSION_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            await context.storageState({ path: SESSION_PATH });
        } catch {}
        // Re-navigate after login
        return navigateWithAuraCapture(page, url);
    }
    return captured;
}

// ── Main lookup function ──────────────────────────────────────────────────────

/**
 * Look up WEX carrier data by company name.
 * @param {object} context - Playwright browser context
 * @param {object} candidate - { carrierId, companyName, firstName?, lastName? }
 * @returns {Promise<object>} result with status + data
 */
export async function lookupWex(context, candidate) {
    const { carrierId, companyName, firstName = "", lastName = "" } = candidate;

    if (!companyName?.trim()) {
        return { status: "error", carrierId, companyName, error: "companyName required" };
    }

    const page = await context.newPage();
    try {
        // Step 1: Search
        console.log(`\n[wex] Looking up "${companyName}" (carrierId=${carrierId})...`);
        const apps = await searchApplications(page, companyName);

        if (!apps.length) {
            console.log(`[wex] No search results for "${companyName}"`);
            return { status: "notFound", carrierId, companyName, searchResults: 0 };
        }

        console.log(`[wex] ${apps.length} search results found`);

        // Step 2: Find matching application
        let matched = null;
        let bestScore = 0;

        for (const app of apps.slice(0, 6)) {
            if (!app.id) continue;

            const score = companyScore(companyName, app.legalName);
            if (score < 0.4 && apps.length > 1) {
                console.log(`[wex] Skipping ${app.id} (score=${score.toFixed(2)}, name="${app.legalName}")`);
                continue;
            }

            const rec = await getApplicationRecord(page, app.id).catch((err) => {
                console.warn(`[wex] Failed to fetch app ${app.id}: ${err.message}`);
                return null;
            });
            if (!rec) continue;

            // Exact carrier ID match wins immediately
            if (rec.carrierId && rec.carrierId === String(carrierId)) {
                matched = rec;
                console.log(`[wex] Exact carrierId match: ${app.id}`);
                break;
            }

            // Track highest company name match
            const recScore = companyScore(companyName, rec.legalName || app.legalName);
            if (recScore > bestScore) {
                bestScore = recScore;
                matched = rec;
            }
        }

        // Take any result when only 1 found
        if (!matched && apps.length === 1) {
            matched = await getApplicationRecord(page, apps[0].id).catch(() => null);
        }

        if (!matched) {
            return { status: "noMatch", carrierId, companyName, searchResults: apps.length };
        }

        console.log(`[wex] Matched app ${matched.appId} (score=${bestScore.toFixed(2)})`);

        // Check proprietor DOB (sole-owner applications store it directly)
        if (matched.proprietorDob) {
            console.log(`[wex] Proprietor DOB found: ${matched.proprietorDob}`);
            return {
                status: "found",
                carrierId,
                companyName,
                dob: formatDobDisplay(matched.proprietorDob),
                dobISO: matched.proprietorDob,
                dob8: formatDob8(matched.proprietorDob),
                firstName: matched.proprietorFirstName || firstName,
                lastName: matched.proprietorLastName || lastName,
                matchedCarrierId: matched.carrierId,
                application: matched,
                owners: [],
                source: "wex",
            };
        }

        // No BOE link
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
        const owners = await getBeneficialOwners(page, matched.boeId).catch((err) => {
            console.warn(`[wex] Failed to get BOE owners: ${err.message}`);
            return [];
        });

        if (!owners.length) {
            return {
                status: "noBOP",
                carrierId,
                companyName,
                matchedCarrierId: matched.carrierId,
                application: matched,
            };
        }

        const withDOB = owners.filter((o) => o.dob);
        if (!withDOB.length) {
            return {
                status: "noDOB",
                carrierId,
                companyName,
                matchedCarrierId: matched.carrierId,
                application: matched,
                owners,
            };
        }

        // Pick best owner — prefer name match, else first
        let best = withDOB[0];
        if (firstName || lastName) {
            for (const o of withDOB) {
                if (nameMatch(firstName, lastName, o.firstName, o.lastName)) {
                    best = o;
                    break;
                }
            }
        }

        console.log(`[wex] DOB found: ${best.dob} (${best.firstName} ${best.lastName})`);
        return {
            status: "found",
            carrierId,
            companyName,
            dob: formatDobDisplay(best.dob),
            dobISO: best.dob,
            dob8: formatDob8(best.dob),
            firstName: best.firstName,
            lastName: best.lastName,
            matchedCarrierId: matched.carrierId,
            application: matched,
            owners,
            source: "wex",
        };
    } catch (err) {
        console.error(`[wex] Error: ${err.message}`);
        return { status: "error", carrierId, companyName, error: err.message };
    } finally {
        await page.close().catch(() => {});
    }
}
