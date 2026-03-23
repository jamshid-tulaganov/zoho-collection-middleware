import { chromium } from "playwright";
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

async function ensureContext() {
    if (!browser?.isConnected()) {
        browser = await chromium.launch({ headless: true });
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

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Search iSoftPull by name and return the DOB from the first matching applicant.
 * @returns {{ dob: string|null, applicantId: string|null }}
 */
export function getDobByName(firstName, lastName) {
    return enqueue(async () => {
        const ctx = await ensureContext();
        const page = await ctx.newPage();
        try {
            const query = `${firstName} ${lastName}`.trim();
            const searchUrl = `${BASE_URL}/client/applicants?query=${encodeURIComponent(query)}&query_archive[]=unarchived`;

            await navigateAuth(page, searchUrl);

            // Find first link matching /client/applicants/<numeric-id>
            const href = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/client/applicants/"]'));
                const found = links.find((l) => /\/client\/applicants\/\d+$/.test(l.getAttribute("href")));
                return found ? found.getAttribute("href") : null;
            });

            if (!href) return { dob: null, applicantId: null };

            const applicantId = href.split("/").pop();
            await page.goto(`${BASE_URL}${href}`, { waitUntil: "domcontentloaded" });

            const dob = await extractDobFromPage(page);
            return { dob: dob || null, applicantId };
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
