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
    await page.fill("#exampleInputEmail1", env.ISOFTPULL_EMAIL);
    await page.fill("#exampleInputPassword", env.ISOFTPULL_PASSWORD);
    await page.click("button[type=submit].btnDarkBlue");
    await page.waitForURL((url) => !url.toString().includes("/sign_in"), { timeout: 20000 });
    await browserContext.storageState({ path: SESSION_PATH });
    console.log("[isoftpull] Login successful, session saved.");
}

async function navigateAuth(page, url) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (page.url().includes("/sign_in")) {
        await doLogin(page);
        await page.goto(url, { waitUntil: "domcontentloaded" });
    }
}

/** Extract all detail fields from an applicant detail page. */
async function extractDetailsFromPage(page) {
    const val = (placeholder) => page.inputValue(`input[placeholder="${placeholder}"]`).catch(() => "");
    return {
        dob: await val("Date of Birth"),
        address: await val("Address"),
        city: await val("City"),
        state: await val("State"),
        zip: await val("Zip Code"),
        firstName: await val("First Name"),
        lastName: await val("Last Name"),
    };
}

/** Normalize a string for fuzzy comparison. */
function norm(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Normalize state — accept "OH", "Ohio", "ohio" and compare as "ohio". */
function normState(s) {
    const upper = (s || "").trim().toUpperCase();
    if (STATE_MAP[upper]) return STATE_MAP[upper];
    return (s || "").toLowerCase().trim();
}

/** Check if an applicant on the detail page matches our carrier data. */
function isAddressMatch(ours, theirs) {
    // Zip match (first 5 digits)
    const ourZip = (ours.zip || "").slice(0, 5);
    const theirZip = (theirs.zip || "").slice(0, 5);
    if (ourZip && theirZip && ourZip === theirZip) return true;

    // City + State match
    const cityMatch = norm(ours.city) === norm(theirs.city);
    const stateMatch = normState(ours.state) === normState(theirs.state);
    if (cityMatch && stateMatch) return true;

    // Address contains the same street number
    const ourNum = (ours.address || "").match(/\d+/);
    const theirNum = (theirs.address || "").match(/\d+/);
    if (ourNum && theirNum && ourNum[0] === theirNum[0] && stateMatch) return true;

    return false;
}

/** Human-like delay between actions (2–4 seconds, randomized). */
function humanDelay() {
    const ms = 2000 + Math.floor(Math.random() * 2000);
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
            const query = `${firstName} ${lastName}`.trim();
            const searchUrl = `${BASE_URL}/client/applicants?query=${encodeURIComponent(query)}&query_archive[]=unarchived`;

            await navigateAuth(page, searchUrl);

            // Collect ALL applicant links matching /client/applicants/<numeric-id>
            const hrefs = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/client/applicants/"]'));
                return links
                    .map((l) => l.getAttribute("href"))
                    .filter((h) => /\/client\/applicants\/\d+$/.test(h));
            });

            if (!hrefs.length) {
                const pageUrl = page.url();
                console.log(`[isoftpull] No results for "${query}" (url: ${pageUrl})`);
                return { dob: null, applicantId: null, checked: 0, reason: "no_search_results" };
            }

            const uniqueHrefs = [...new Set(hrefs)];
            const hasMatchData = match.city || match.state || match.zip || match.address;

            for (let i = 0; i < uniqueHrefs.length; i++) {
                const href = uniqueHrefs[i];
                const applicantId = href.split("/").pop();
                await humanDelay();
                await page.goto(`${BASE_URL}${href}`, { waitUntil: "domcontentloaded" });

                const details = await extractDetailsFromPage(page);

                // If we have address data, validate before accepting
                if (hasMatchData && !isAddressMatch(match, details)) {
                    console.log(`[isoftpull] Applicant ${applicantId} — address mismatch (${details.city}, ${details.state} ${details.zip} vs ${match.city}, ${match.state} ${match.zip})`);
                    continue;
                }

                if (details.dob) {
                    console.log(`[isoftpull] ✓ Found DOB on applicant ${applicantId} (checked ${i + 1}/${uniqueHrefs.length}, ${details.city} ${details.state})`);
                    return { dob: details.dob, applicantId, checked: i + 1 };
                }

                // Address matched but no DOB on this record
                console.log(`[isoftpull] Applicant ${applicantId} — address match but no DOB`);
            }

            console.log(`[isoftpull] Checked ${uniqueHrefs.length} applicants for "${query}" — no valid match with DOB`);
            return { dob: null, applicantId: null, checked: uniqueHrefs.length, reason: "no_dob_on_matched_records" };
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
