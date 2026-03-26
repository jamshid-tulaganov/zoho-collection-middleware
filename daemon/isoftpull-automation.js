/**
 * isoftpull-automation.js — iSoftPull browser automation for the local daemon.
 *
 * Receives an already-open Playwright browser context and performs
 * name-based search + address validation to find DOBs.
 * Mirrors the logic from src/services/isoftpull.js but works with
 * an externally managed context (no singleton browser).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, "../data/isoftpull-session.json");
const BASE_URL = "https://app.isoftpull.com";

const STATE_MAP = {
    AL:"alabama",AK:"alaska",AZ:"arizona",AR:"arkansas",CA:"california",
    CO:"colorado",CT:"connecticut",DE:"delaware",FL:"florida",GA:"georgia",
    HI:"hawaii",ID:"idaho",IL:"illinois",IN:"indiana",IA:"iowa",KS:"kansas",
    KY:"kentucky",LA:"louisiana",ME:"maine",MD:"maryland",MA:"massachusetts",
    MI:"michigan",MN:"minnesota",MS:"mississippi",MO:"missouri",MT:"montana",
    NE:"nebraska",NV:"nevada",NH:"new hampshire",NJ:"new jersey",NM:"new mexico",
    NY:"new york",NC:"north carolina",ND:"north dakota",OH:"ohio",OK:"oklahoma",
    OR:"oregon",PA:"pennsylvania",RI:"rhode island",SC:"south carolina",
    SD:"south dakota",TN:"tennessee",TX:"texas",UT:"utah",VT:"vermont",
    VA:"virginia",WA:"washington",WV:"west virginia",WI:"wisconsin",WY:"wyoming",
    DC:"district of columbia",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function norm(s) {
    return (s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

function collapseWhitespace(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeName(value) {
    return norm(collapseWhitespace(value));
}

function mergeAddressLines(...lines) {
    return collapseWhitespace(lines.filter(Boolean).join(" "));
}

function normalizeZip(zip) {
    const digits = String(zip || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length === 4) return digits.padStart(5, "0");
    return digits.slice(0, 5);
}

function normalizeAddressValue(address) {
    const raw = String(address || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

    return collapseWhitespace(
        raw
            .replace(/#/g, " unit ")
            .replace(/\bapt\b|\bapartment\b|\bunit\b|\bsuite\b|\bste\b|\brm\b|\broom\b/g, " unit ")
            .replace(/\bfl\b|\bfloor\b/g, " floor ")
            .replace(/\bdr\b/g, " drive ")
            .replace(/\brd\b/g, " road ")
            .replace(/\bst\b/g, " street ")
            .replace(/\bave\b/g, " avenue ")
            .replace(/\bblvd\b/g, " boulevard ")
            .replace(/\bln\b/g, " lane ")
            .replace(/\bct\b/g, " court ")
            .replace(/\bpkwy\b/g, " parkway ")
            .replace(/\bhwy\b/g, " highway ")
            .replace(/\btrl\b/g, " trail ")
            .replace(/\bter\b/g, " terrace ")
            .replace(/\bcir\b/g, " circle ")
            .replace(/[.,/-]/g, " ")
    );
}

function normalizeAddressBase(address) {
    return norm(normalizeAddressValue(address).split(/\b(?:unit|floor)\b/)[0]);
}

function normState(s) {
    const upper = (s || "").trim().toUpperCase();
    return STATE_MAP[upper] || (s || "").toLowerCase().trim();
}

function isFullNameMatch(firstName, lastName, candidateName) {
    return normalizeName(`${firstName}${lastName}`) === normalizeName(candidateName);
}

function isAddressMatch(ours, theirs) {
    const ourAddr = normalizeAddressBase(mergeAddressLines(ours.address));
    const theirAddr = normalizeAddressBase(mergeAddressLines(theirs.address, theirs.addressLine2));
    const ourAddrFull = normalizeAddressValue(mergeAddressLines(ours.address));
    const theirAddrFull = normalizeAddressValue(mergeAddressLines(theirs.address, theirs.addressLine2));

    const addrMatch = !ourAddrFull || !theirAddrFull
        || ourAddrFull.includes(theirAddrFull) || theirAddrFull.includes(ourAddrFull)
        || ourAddr.includes(theirAddr) || theirAddr.includes(ourAddr);

    const zipMatch = !normalizeZip(ours.zip) || !normalizeZip(theirs.zip)
        || normalizeZip(ours.zip) === normalizeZip(theirs.zip);

    const cityMatch = !ours.city || !theirs.city || norm(ours.city) === norm(theirs.city);
    const stateMatch = !ours.state || !theirs.state || normState(ours.state) === normState(theirs.state);

    return addrMatch && zipMatch && cityMatch && stateMatch;
}

function humanDelay() {
    return new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 500)));
}

// ── Navigation helpers ────────────────────────────────────────────────────────

async function getBodyText(page) {
    return page.textContent("body").catch(() => "");
}

async function assertNoGeoBlock(page) {
    const content = await getBodyText(page);
    if (content.includes("Foreign Access Forbidden")) {
        throw new Error("403 Foreign Access Forbidden — enable US VPN");
    }
}

async function doLogin(page, context) {
    const email = process.env.ISOFTPULL_EMAIL;
    const password = process.env.ISOFTPULL_PASSWORD;
    if (!email || !password) throw new Error("[isoftpull] ISOFTPULL_EMAIL and ISOFTPULL_PASSWORD required");

    console.log("[isoftpull] Logging in...");
    await page.goto(`${BASE_URL}/users/sign_in`, { waitUntil: "domcontentloaded" });
    await assertNoGeoBlock(page);
    await page.fill("#exampleInputEmail1", email);
    await page.fill("#exampleInputPassword", password);
    await page.click("button[type=submit].btnDarkBlue");
    await page.waitForURL((url) => !url.toString().includes("/sign_in"), { timeout: 20000 });

    // Save session
    try {
        const dir = path.dirname(SESSION_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        await context.storageState({ path: SESSION_PATH });
    } catch {}

    console.log("[isoftpull] Login successful.");
}

async function navigateAuth(page, context, url) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await assertNoGeoBlock(page);
    if (page.url().includes("/sign_in")) {
        await doLogin(page, context);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await assertNoGeoBlock(page);
    }
}

async function waitForSearchPage(page) {
    await page.locator("#tsearch").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(
        () => {
            const bodyText = document.body?.innerText || "";
            if (bodyText.includes("Foreign Access Forbidden")) return true;
            const hasResults = Array.from(document.querySelectorAll('a[href*="/client/applicants/"]'))
                .some((link) => /\/client\/applicants\/\d+$/.test(link.getAttribute("href") || ""));
            const searchReady = !!document.querySelector('#tsearch, input[name="query"]');
            const emptyStateReady = bodyText.includes("Archived:") || bodyText.includes("ADD APPLICANT");
            return searchReady && (hasResults || emptyStateReady);
        },
        { timeout: 10000 }
    ).catch(() => {});

    await page.waitForTimeout(500);
    await assertNoGeoBlock(page);
}

async function waitForDetailPage(page) {
    await page.locator('input[placeholder="Date of Birth"], input[placeholder="First Name"]')
        .first()
        .waitFor({ state: "attached", timeout: 10000 })
        .catch(() => {});
    await assertNoGeoBlock(page);
}

async function collectApplicantRows(page) {
    const applicants = new Map();
    let stableRounds = 0;
    let bottomRounds = 0;

    for (let round = 0; round < 60; round++) {
        const batch = await page.evaluate(() =>
            Array.from(document.querySelectorAll("a"))
                .map((link) => {
                    const href = link.getAttribute("href") || "";
                    if (!/\/client\/applicants\/\d+$/.test(href)) return null;
                    const text = (link.textContent || "").trim();
                    const name = text && !/view applicant/i.test(text)
                        ? text
                        : (link.closest(".popover-head")?.querySelector("h2")?.textContent || "");
                    return { href, name: (name || "").trim() };
                })
                .filter(Boolean)
        );

        const sizeBefore = applicants.size;
        for (const item of batch) {
            const existing = applicants.get(item.href);
            if (!existing || (!existing.name && item.name)) applicants.set(item.href, item);
        }

        const noMoreResults = await getBodyText(page)
            .then((t) => t.includes("No more Applicants to load"))
            .catch(() => false);

        const scrollState = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll("*"));
            const scrollables = elements.filter((el) => {
                const style = window.getComputedStyle(el);
                return el instanceof HTMLElement
                    && el.scrollHeight > el.clientHeight + 40
                    && /(auto|scroll)/.test(style.overflowY || "");
            });
            const target = scrollables.sort(
                (a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
            )[0] || document.scrollingElement || document.documentElement;

            const beforeTop = target.scrollTop;
            const maxTop = Math.max(0, target.scrollHeight - target.clientHeight);
            const step = Math.max(Math.floor(target.clientHeight * 0.9), 1200);
            target.scrollTo({ top: Math.min(maxTop, beforeTop + step), behavior: "instant" });
            window.scrollTo({ top: Math.min(document.documentElement.scrollHeight, window.scrollY + 1800), behavior: "instant" });
            return { beforeTop, afterTop: target.scrollTop, maxTop };
        }).catch(() => ({ beforeTop: 0, afterTop: 0, maxTop: 0 }));

        if (applicants.size === sizeBefore) stableRounds++;
        else stableRounds = 0;

        if (scrollState.maxTop > 0 && scrollState.afterTop >= scrollState.maxTop - 5) bottomRounds++;
        else bottomRounds = 0;

        if (noMoreResults || (stableRounds >= 5 && bottomRounds >= 3)) break;

        await page.mouse.wheel(0, 2400);
        await page.waitForTimeout(500);
    }

    return [...applicants.values()];
}

async function extractDetails(page) {
    const val = (placeholder) => page.inputValue(`input[placeholder="${placeholder}"]`).catch(() => "");
    const address = await val("Address");
    const addressLine2 = await val("Address Line 2");
    return {
        dob: await val("Date of Birth"),
        address,
        addressLine2,
        mergedAddress: mergeAddressLines(address, addressLine2),
        city: await val("City"),
        state: await val("State"),
        zip: await val("Zip Code"),
        firstName: await val("First Name"),
        lastName: await val("Last Name"),
    };
}

// ── Main lookup functions ─────────────────────────────────────────────────────

/**
 * Search iSoftPull by name, validate by address, return DOB.
 * @param {object} context — Playwright browser context
 * @param {string} firstName
 * @param {string} lastName
 * @param {{ address?, city?, state?, zip? }} addressMatch
 */
export async function getDobByName(context, firstName, lastName, addressMatch = {}) {
    const page = await context.newPage();
    try {
        const queries = [firstName, lastName]
            .map((v) => (v || "").trim())
            .filter(Boolean);
        const uniqueQueries = [...new Set(queries)];

        const seenRows = new Map();

        for (const query of uniqueQueries) {
            const url = `${BASE_URL}/client/applicants?query=${encodeURIComponent(query)}&query_archive[]=unarchived`;
            await navigateAuth(page, context, url);
            await waitForSearchPage(page);

            const rows = await collectApplicantRows(page);
            rows.forEach((row) => {
                const existing = seenRows.get(row.href);
                if (!existing || (!existing.name && row.name)) seenRows.set(row.href, row);
            });

            const nameMatches = rows.filter((r) => isFullNameMatch(firstName, lastName, r.name));
            console.log(`[isoftpull] "${query}" → ${rows.length} rows, ${nameMatches.length} name matches`);
        }

        const matchedRows = [...seenRows.values()].filter((r) => isFullNameMatch(firstName, lastName, r.name));

        if (!matchedRows.length) {
            return {
                dob: null,
                applicantId: null,
                checked: 0,
                reason: seenRows.size ? "no_name_match" : "no_search_results",
            };
        }

        let addressMatchedCount = 0;

        for (let i = 0; i < matchedRows.length; i++) {
            const href = matchedRows[i].href;
            const applicantId = href.split("/").pop();
            await humanDelay();
            await page.goto(`${BASE_URL}${href}`, { waitUntil: "domcontentloaded" });
            await waitForDetailPage(page);

            const details = await extractDetails(page);

            if (!isFullNameMatch(firstName, lastName, `${details.firstName} ${details.lastName}`)) {
                console.log(`[isoftpull] Applicant ${applicantId} — detail name mismatch`);
                continue;
            }

            if (!isAddressMatch(addressMatch, details)) {
                console.log(`[isoftpull] Applicant ${applicantId} — address mismatch`);
                continue;
            }

            addressMatchedCount++;

            if (details.dob) {
                console.log(`[isoftpull] ✓ DOB found on applicant ${applicantId}`);
                return { dob: details.dob, applicantId, checked: i + 1 };
            }

            console.log(`[isoftpull] Applicant ${applicantId} — address match but no DOB`);
        }

        return {
            dob: null,
            applicantId: null,
            checked: matchedRows.length,
            reason: addressMatchedCount ? "no_dob_on_matched_records" : "no_address_match",
        };
    } finally {
        await page.close().catch(() => {});
    }
}

/**
 * Fetch DOB directly by applicant ID.
 */
export async function getDobById(context, applicantId) {
    const page = await context.newPage();
    try {
        await navigateAuth(page, context, `${BASE_URL}/client/applicants/${applicantId}`);
        await waitForDetailPage(page);
        const details = await extractDetails(page);
        return { dob: details.dob || null };
    } finally {
        await page.close().catch(() => {});
    }
}
