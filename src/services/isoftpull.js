import { chromium } from "playwright";
import { execSync } from "child_process";
import { env } from "../config/env.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, "../../data/isoftpull-session.json");
const BASE_URL = "https://app.isoftpull.com";

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

async function extractDobFromPage(page) {
    return page.inputValue('input[placeholder="Date of Birth"]').catch(() => null);
}

/** Human-like delay between actions (2–4 seconds, randomized). */
function humanDelay() {
    const ms = 2000 + Math.floor(Math.random() * 2000);
    return new Promise((r) => setTimeout(r, ms));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Search iSoftPull by name, check every matching applicant one by one until a DOB is found.
 * A company may have multiple records — iterate all of them before giving up.
 * @returns {{ dob: string|null, applicantId: string|null, checked: number }}
 */
export function getDobByName(firstName, lastName) {
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
                // Log why — could be no results or login issue
                const pageTitle = await page.title().catch(() => "");
                const pageUrl = page.url();
                console.log(`[isoftpull] No results for "${query}" (url: ${pageUrl}, title: ${pageTitle})`);
                return { dob: null, applicantId: null, checked: 0, reason: "no_search_results", pageUrl };
            }

            // Deduplicate hrefs (search page may have duplicate links per applicant)
            const uniqueHrefs = [...new Set(hrefs)];

            // Go through each applicant until we find one with a DOB
            for (let i = 0; i < uniqueHrefs.length; i++) {
                const href = uniqueHrefs[i];
                const applicantId = href.split("/").pop();
                await humanDelay();
                await page.goto(`${BASE_URL}${href}`, { waitUntil: "domcontentloaded" });
                const dob = await extractDobFromPage(page);
                if (dob) {
                    console.log(`[isoftpull] Found DOB on applicant ${applicantId} (checked ${i + 1}/${uniqueHrefs.length})`);
                    return { dob, applicantId, checked: i + 1 };
                }
            }

            // All applicants checked, none had a DOB
            console.log(`[isoftpull] Checked ${uniqueHrefs.length} applicants for "${query}" — none had DOB`);
            return { dob: null, applicantId: null, checked: uniqueHrefs.length, reason: "no_dob_on_records" };
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
            const dob = await extractDobFromPage(page);
            return { dob: dob || null };
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
