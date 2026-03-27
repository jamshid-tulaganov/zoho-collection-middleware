import { chromium } from "playwright";
import { execSync } from "child_process";
import { env } from "../config/env.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, "../../data/isoftpull-session.json");
const BASE_URL = "https://app.isoftpull.com";

// US state abbreviation → full name map for matching
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

let browser = null;
let browserContext = null;

// Request queue — serializes all scraping to avoid concurrent navigation conflicts
let queue = Promise.resolve();

function enqueue(fn) {
    const next = queue.then(fn);
    queue = next.catch(() => {}); // keep queue alive even if fn throws
    return next;
}

const LAUNCH_OPTS = {
    headless: true,
    args: ["--disable-gpu", "--no-sandbox", "--disable-setuid-sandbox"],
};

async function getBodyText(page) {
    return page.textContent("body").catch(() => "");
}

async function assertNoGeoBlock(page) {
    const content = await getBodyText(page);
    if (content.includes("Foreign Access Forbidden")) {
        throw new Error("403 Foreign Access Forbidden — enable US VPN and retry");
    }
}

async function waitForApplicantSearchPage(page) {
    await page.locator("#tsearch").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page
        .waitForFunction(() => {
            const bodyText = document.body?.innerText || "";
            if (bodyText.includes("Foreign Access Forbidden")) return true;

            const hasResults = Array.from(document.querySelectorAll('a[href*="/client/applicants/"]'))
                .some((link) => /\/client\/applicants\/\d+$/.test(link.getAttribute("href") || ""));

            const searchReady = !!document.querySelector('#tsearch, input[name="query"]');
            const emptyStateReady = bodyText.includes("Archived:") || bodyText.includes("ADD APPLICANT");

            return searchReady && (hasResults || emptyStateReady);
        }, { timeout: 10000 })
        .catch(() => {});

    await page.waitForTimeout(500);
    await assertNoGeoBlock(page);
}

function buildSearchQueries(firstName, lastName) {
    const queries = [firstName, lastName]
        .map((value) => (value || "").trim())
        .filter(Boolean);

    return [...new Set(queries)];
}

function buildSearchPlans(firstName, lastName) {
    return buildSearchQueries(firstName, lastName).map((query) => ({ query, archive: "unarchived" }));
}

async function collectApplicantRows(page) {
    const applicants = new Map();
    let stableRounds = 0;
    let bottomRounds = 0;

    for (let round = 0; round < 60; round++) {
        const batch = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("a"))
                .map((link) => {
                    const href = link.getAttribute("href") || "";
                    if (!/\/client\/applicants\/\d+$/.test(href)) return null;

                    const text = (link.textContent || "").trim();
                    const name =
                        text && !/view applicant/i.test(text)
                            ? text
                            : (link.closest(".popover-head")?.querySelector("h2")?.textContent || "");

                    return {
                        href,
                        name: (name || "").trim(),
                    };
                })
                .filter(Boolean);
        });

        const sizeBefore = applicants.size;
        for (const item of batch) {
            const existing = applicants.get(item.href);
            if (!existing || (!existing.name && item.name)) {
                applicants.set(item.href, item);
            }
        }

        const noMoreResults = await getBodyText(page)
            .then((text) => text.includes("No more Applicants to load"))
            .catch(() => false);

        const scrollState = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll("*"));
            const scrollables = elements.filter((el) => {
                const style = window.getComputedStyle(el);
                return (
                    el instanceof HTMLElement &&
                    el.scrollHeight > el.clientHeight + 40 &&
                    /(auto|scroll)/.test(style.overflowY || "")
                );
            });

            const target =
                scrollables.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] ||
                document.scrollingElement ||
                document.documentElement;

            const beforeTop = target.scrollTop;
            const maxTop = Math.max(0, target.scrollHeight - target.clientHeight);
            const step = Math.max(Math.floor(target.clientHeight * 0.9), 1200);
            const nextTop = Math.min(maxTop, beforeTop + step);

            target.scrollTo({ top: nextTop, behavior: "instant" });
            window.scrollTo({ top: Math.min(document.documentElement.scrollHeight, window.scrollY + 1800), behavior: "instant" });

            return {
                beforeTop,
                afterTop: target.scrollTop,
                maxTop,
            };
        }).catch(() => ({ beforeTop: 0, afterTop: 0, maxTop: 0 }));

        if (applicants.size === sizeBefore) {
            stableRounds++;
        } else {
            stableRounds = 0;
        }

        if (scrollState.maxTop > 0 && scrollState.afterTop >= scrollState.maxTop - 5) {
            bottomRounds++;
        } else {
            bottomRounds = 0;
        }

        if (noMoreResults || (stableRounds >= 5 && bottomRounds >= 3)) break;

        await page.mouse.wheel(0, 2400);
        await page.waitForTimeout(500);
    }

    return [...applicants.values()];
}

async function waitForApplicantDetailPage(page) {
    await page
        .locator('input[placeholder="Date of Birth"], input[placeholder="First Name"]')
        .first()
        .waitFor({ state: "attached", timeout: 10000 })
        .catch(() => {});
    await assertNoGeoBlock(page);
}

async function ensureContext() {
    if (!browser?.isConnected()) {
        try {
            browser = await chromium.launch(LAUNCH_OPTS);
        } catch (err) {
            if (err.message.includes("Executable doesn't exist")) {
                console.log("[isoftpull] Chromium not found — installing now...");
                execSync("npx playwright install chromium chromium-headless-shell", { stdio: "inherit" });
                browser = await chromium.launch(LAUNCH_OPTS);
                console.log("[isoftpull] Chromium installed and launched.");
            } else {
                throw err;
            }
        }
        browserContext = null;
    }
    if (!browserContext) {
        const storageState = fs.existsSync(SESSION_PATH) ? SESSION_PATH : undefined;
        browserContext = await browser.newContext({ storageState });
    }
    return browserContext;
}

async function doLogin(page) {
    console.log("[isoftpull] Logging in...");
    await page.goto(`${BASE_URL}/users/sign_in`, { waitUntil: "domcontentloaded" });
    await assertNoGeoBlock(page);
    await page.fill("#exampleInputEmail1", env.ISOFTPULL_EMAIL);
    await page.fill("#exampleInputPassword", env.ISOFTPULL_PASSWORD);
    await page.click("button[type=submit].btnDarkBlue");
    await page.waitForURL((url) => !url.toString().includes("/sign_in"), { timeout: 20000 });
    await browserContext.storageState({ path: SESSION_PATH });
    console.log("[isoftpull] Login successful, session saved.");
}

async function navigateAuth(page, url) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await assertNoGeoBlock(page);
    if (page.url().includes("/sign_in")) {
        await doLogin(page);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await assertNoGeoBlock(page);
    }
}

/** Extract all detail fields from an applicant detail page. */
async function extractDetailsFromPage(page) {
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

/** Normalize a string for fuzzy comparison. */
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

function normalizeAddressText(address) {
    return String(address || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

function normalizeAddressValue(address) {
    const raw = normalizeAddressText(address);

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
    const base = normalizeAddressValue(address).split(/\b(?:unit|floor)\b/)[0];
    return norm(base);
}

function isFullNameMatch(firstName, lastName, candidateName) {
    return normalizeName(`${firstName}${lastName}`) === normalizeName(candidateName);
}

/** Normalize state — accept "OH", "Ohio", "ohio" and compare as "ohio". */
function normState(s) {
    const upper = (s || "").trim().toUpperCase();
    if (STATE_MAP[upper]) return STATE_MAP[upper];
    return (s || "").toLowerCase().trim();
}

/** Check if an applicant on the detail page matches our carrier data. */
function isAddressMatch(ours, theirs) {
    const ourMergedAddress = mergeAddressLines(ours.address);
    const theirMergedAddress = mergeAddressLines(theirs.address, theirs.addressLine2);
    const ourAddress = normalizeAddressBase(ourMergedAddress);
    const theirAddress = normalizeAddressBase(theirMergedAddress);
    const ourAddressFull = normalizeAddressValue(ourMergedAddress);
    const theirAddressFull = normalizeAddressValue(theirMergedAddress);
    const addressMatch =
        !ourAddressFull ||
        !theirAddressFull ||
        ourAddressFull.includes(theirAddressFull) ||
        theirAddressFull.includes(ourAddressFull) ||
        ourAddress.includes(theirAddress) ||
        theirAddress.includes(ourAddress);

    const ourZip = normalizeZip(ours.zip);
    const theirZip = normalizeZip(theirs.zip);
    const zipMatch = !ourZip || !theirZip || ourZip === theirZip;

    const cityMatch = !ours.city || !theirs.city || norm(ours.city) === norm(theirs.city);
    const stateMatch = !ours.state || !theirs.state || normState(ours.state) === normState(theirs.state);

    return addressMatch && zipMatch && cityMatch && stateMatch;
}

function isDetailAddressMatch(ours, theirs) {
    return isAddressMatch(ours, theirs);
}

function isDetailNameMatch(firstName, lastName, details) {
    return isFullNameMatch(firstName, lastName, `${details.firstName} ${details.lastName}`);
}

/** Small pacing delay between applicant detail pages. */
function humanDelay() {
    const ms = 400 + Math.floor(Math.random() * 500);
    return new Promise((r) => setTimeout(r, ms));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Search iSoftPull by name, check each matching applicant, validate by address,
 * and return the DOB from the first match.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {{ address?, city?, state?, zip? }} match — our carrier data for validation
 * @returns {{ dob, applicantId, checked, reason? }}
 */
export function getDobByName(firstName, lastName, match = {}) {
    return enqueue(async () => {
        const ctx = await ensureContext();
        const page = await ctx.newPage();
        try {
            const searchPlans = buildSearchPlans(firstName, lastName);
            const seenRows = new Map();
            let matchedRows = [];
            let addressMatchedCount = 0;

            for (const { query, archive } of searchPlans) {
                const searchUrl = `${BASE_URL}/client/applicants?query=${encodeURIComponent(query)}&query_archive[]=${encodeURIComponent(archive)}`;

                await navigateAuth(page, searchUrl);
                await waitForApplicantSearchPage(page);

                const rows = await collectApplicantRows(page);
                rows.forEach((row) => {
                    const existing = seenRows.get(row.href);
                    if (!existing || (!existing.name && row.name)) {
                        seenRows.set(row.href, row);
                    }
                });

                const tableMatches = rows.filter((row) => isFullNameMatch(firstName, lastName, row.name));
                console.log(`[isoftpull] Search "${query}" [${archive}] returned ${rows.length} applicant rows (${tableMatches.length} exact full-name matches)`);

                const pageUrl = page.url();
                const pageTitle = await page.title().catch(() => "");
                const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || "").catch(() => "");
                if (!tableMatches.length) {
                    console.log(`[isoftpull] No results for "${query}" [${archive}] (url: ${pageUrl}, title: ${pageTitle})`);
                    console.log(`[isoftpull] Page content: ${bodyText}`);
                }
            }

            matchedRows = [...seenRows.values()].filter((row) => isFullNameMatch(firstName, lastName, row.name));

            if (!matchedRows.length) {
                const screenshotPath = path.resolve(__dirname, "../../data/isoftpull-debug.png");
                await page.screenshot({ path: screenshotPath }).catch(() => {});
                return { dob: null, applicantId: null, checked: 0, reason: seenRows.size ? "no_name_match" : "no_search_results" };
            }

            for (let i = 0; i < matchedRows.length; i++) {
                const href = matchedRows[i].href;
                const applicantId = href.split("/").pop();
                await humanDelay();
                await page.goto(`${BASE_URL}${href}`, { waitUntil: "domcontentloaded" });
                await waitForApplicantDetailPage(page);

                const details = await extractDetailsFromPage(page);

                if (!isDetailNameMatch(firstName, lastName, details)) {
                    console.log(`[isoftpull] Applicant ${applicantId} — detail name mismatch (${details.firstName} ${details.lastName})`);
                    continue;
                }

                if (!isDetailAddressMatch(match, details)) {
                    console.log(`[isoftpull] Applicant ${applicantId} — address mismatch (${details.city}, ${details.state} ${details.zip} vs ${match.city}, ${match.state} ${match.zip})`);
                    continue;
                }

                addressMatchedCount++;

                if (details.dob) {
                    console.log(`[isoftpull] ✓ Found DOB on applicant ${applicantId} (checked ${i + 1}/${matchedRows.length}, ${details.city} ${details.state})`);
                    return { dob: details.dob, applicantId, checked: i + 1 };
                }

                // Address matched but no DOB on this record
                console.log(`[isoftpull] Applicant ${applicantId} — address match but no DOB`);
            }

            console.log(`[isoftpull] Checked ${matchedRows.length} applicants for "${firstName} ${lastName}" — no valid match with DOB`);
            return {
                dob: null,
                applicantId: null,
                checked: matchedRows.length,
                reason: addressMatchedCount ? "no_dob_on_matched_records" : "no_address_match",
            };
        } finally {
            await page.close();
        }
    });
}

/**
 * Fetch DOB directly by iSoftPull applicant ID.
 * @returns {{ dob: string|null }}
 */
export function getDobById(applicantId) {
    return enqueue(async () => {
        const ctx = await ensureContext();
        const page = await ctx.newPage();
        try {
            await navigateAuth(page, `${BASE_URL}/client/applicants/${applicantId}`);
            await waitForApplicantDetailPage(page);
            const details = await extractDetailsFromPage(page);
            return { dob: details.dob || null };
        } finally {
            await page.close();
        }
    });
}

/** Call on server shutdown to cleanly close the browser. */
export async function closeBrowser() {
    if (browser) {
        await browser.close();
        browser = null;
        browserContext = null;
    }
}
