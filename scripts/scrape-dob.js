#!/usr/bin/env node
/**
 * Scrape DOBs from iSoftPull for carriers missing DOB.
 *
 * Usage:  node scripts/scrape-dob.js [--limit 100] [--force]
 *
 * Reads & writes data/isoftpull-candidates.json  (adds dob field in-place)
 * Resumes automatically — skips candidates that already have a dob value.
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "../src/config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES_PATH = path.resolve(__dirname, "../data/isoftpull-candidates.json");
const BASE_URL = "https://app.isoftpull.com";

// US state abbreviation → full name
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function norm(s) {
    return (s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

function normalizeZip(zip) {
    const digits = String(zip || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length === 4) return digits.padStart(5, "0");
    return digits.slice(0, 5);
}

function normalizeAddressBase(address) {
    const raw = String(address || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

    const canonical = raw
        .replace(/\bapt\b|\bapartment\b|\bunit\b|\bsuite\b|\bste\b|\bfl\b|\bfloor\b/g, " ")
        .replace(/\bdr\b/g, " drive ")
        .replace(/\brd\b/g, " road ")
        .replace(/\bst\b/g, " street ")
        .replace(/\bave\b/g, " avenue ")
        .replace(/\bblvd\b/g, " boulevard ")
        .replace(/\bln\b/g, " lane ")
        .replace(/\bct\b/g, " court ")
        .replace(/\bpkwy\b/g, " parkway ")
        .replace(/\bhwy\b/g, " highway ");

    const base = canonical.split(/\b(?:apt|apartment|unit|suite|ste|#)\b/)[0];
    return norm(base);
}

function isFullNameMatch(firstName, lastName, candidateName) {
    return norm(`${firstName} ${lastName}`) === norm(candidateName);
}

function isPotentialNameMatch(firstName, lastName, candidateName) {
    if (isFullNameMatch(firstName, lastName, candidateName)) return true;

    const candidate = norm(candidateName);
    const firstTokens = String(firstName || "").split(/\s+/).map(norm).filter(Boolean);
    const lastTokens = String(lastName || "").split(/\s+/).map(norm).filter(Boolean);

    const hasAllFirstTokens = firstTokens.every((token) => candidate.includes(token));
    const hasAnyLastToken = lastTokens.some((token) => candidate.includes(token));

    return hasAllFirstTokens && hasAnyLastToken;
}

function normState(s) {
    const upper = (s || "").trim().toUpperCase();
    if (STATE_MAP[upper]) return STATE_MAP[upper];
    return (s || "").toLowerCase().trim();
}

function isAddressMatch(ours, theirs) {
    const ourAddress = normalizeAddressBase(ours.address);
    const theirAddress = normalizeAddressBase(theirs.address);
    const addressMatch =
        !ourAddress ||
        !theirAddress ||
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

function humanDelay(min = 400, max = 900) {
    const ms = min + Math.floor(Math.random() * (max - min));
    return new Promise((r) => setTimeout(r, ms));
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

function loadCandidates() {
    return JSON.parse(fs.readFileSync(CANDIDATES_PATH, "utf-8"));
}

function saveCandidates(candidates) {
    fs.writeFileSync(CANDIDATES_PATH, JSON.stringify(candidates, null, 2));
}

// ── Browser ─────────────────────────────────────────────────────────────────

async function login(page) {
    console.log("[scrape] Logging in...");
    await page.goto(`${BASE_URL}/users/sign_in`, { waitUntil: "domcontentloaded" });

    // Check for geo-block
    const content = await page.textContent("body");
    if (content.includes("Foreign Access Forbidden")) {
        throw new Error("403 Foreign Access Forbidden — enable US VPN and retry");
    }

    await page.fill("#exampleInputEmail1", env.ISOFTPULL_EMAIL);
    await page.fill("#exampleInputPassword", env.ISOFTPULL_PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL((url) => !url.toString().includes("/sign_in"), { timeout: 20000 });
    console.log("[scrape] Login successful.");
}

async function navigateAuth(page, context, url) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (page.url().includes("/sign_in")) {
        await login(page);
        await page.goto(url, { waitUntil: "domcontentloaded" });
    }
}

async function extractDetails(page) {
    const val = (placeholder) =>
        page.inputValue(`input[placeholder="${placeholder}"]`).catch(() => "");
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

        const noMoreResults = await page.textContent("body")
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

async function searchAndExtract(page, context, candidate) {
    const { firstName, lastName, address, city, state, zip } = candidate;
    const plans = buildSearchPlans(firstName, lastName);
    const seenRows = new Map();
    let matchedRows = [];

    for (const { query, archive } of plans) {
        const searchUrl = `${BASE_URL}/client/applicants?query=${encodeURIComponent(query)}&query_archive[]=${encodeURIComponent(archive)}`;

        await navigateAuth(page, context, searchUrl);
        await humanDelay(300, 700);

        const rows = await collectApplicantRows(page);
        rows.forEach((row) => {
            const existing = seenRows.get(row.href);
            if (!existing || (!existing.name && row.name)) {
                seenRows.set(row.href, row);
            }
        });

        const tableMatches = rows.filter((row) => isPotentialNameMatch(firstName, lastName, row.name));
        console.log(`    search "${query}" [${archive}] returned ${rows.length} applicant rows (${tableMatches.length} potential name matches)`);
    }

    matchedRows = [...seenRows.values()].filter((row) => isPotentialNameMatch(firstName, lastName, row.name));

    if (!matchedRows.length) {
        return { dob: null, reason: seenRows.size ? "no_name_match" : "no_search_results", checked: 0 };
    }

    for (let i = 0; i < matchedRows.length; i++) {
        const href = matchedRows[i].href;
        const applicantId = href.split("/").pop();
        await humanDelay(400, 900);
        await page.goto(`${BASE_URL}${href}`, { waitUntil: "domcontentloaded" });

        const details = await extractDetails(page);

        if (!isDetailAddressMatch({ address, city, state, zip }, details)) {
            console.log(`    [${applicantId}] address mismatch (${details.city}, ${details.state} ${details.zip})`);
            continue;
        }

        if (details.dob) {
            return { dob: details.dob, applicantId, checked: i + 1, details };
        }

        console.log(`    [${applicantId}] address OK but no DOB`);
    }

    return { dob: null, reason: "no_dob_on_matched_records", checked: matchedRows.length };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    if (!env.ISOFTPULL_EMAIL || !env.ISOFTPULL_PASSWORD) {
        throw new Error("ISOFTPULL_EMAIL and ISOFTPULL_PASSWORD are required");
    }

    const args = process.argv.slice(2);
    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 100;
    const force = args.includes("--force");

    const candidates = loadCandidates();

    // Build indices of candidates that still need DOB
    const toProcessIndices = [];
    for (let i = 0; i < candidates.length; i++) {
        if (force || !candidates[i].dob) {
            toProcessIndices.push(i);
        }
        if (toProcessIndices.length >= limit) break;
    }

    console.log(`[scrape] ${candidates.length} total candidates, ${toProcessIndices.length} to process (limit=${limit})`);

    if (!toProcessIndices.length) {
        console.log("[scrape] Nothing to process. Use --force to re-check all.");
        return;
    }

    const browser = await chromium.launch({
        headless: true,
        args: ["--disable-gpu", "--no-sandbox", "--disable-setuid-sandbox"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    let fetched = 0;
    let notFound = 0;
    let errors = 0;

    try {
        for (let j = 0; j < toProcessIndices.length; j++) {
            const idx = toProcessIndices[j];
            const c = candidates[idx];
            const progress = `[${j + 1}/${toProcessIndices.length}]`;

            try {
                const result = await searchAndExtract(page, context, c);

                if (result.dob) {
                    candidates[idx].dob = result.dob;
                    candidates[idx].applicantId = result.applicantId || null;
                    fetched++;
                    console.log(`${progress} ✓ ${c.firstName} ${c.lastName} → ${result.dob}`);
                } else {
                    candidates[idx].dob = null;
                    candidates[idx].reason = result.reason;
                    candidates[idx].checked = result.checked;
                    notFound++;
                    console.log(`${progress} ✗ ${c.firstName} ${c.lastName} → ${result.reason} (checked ${result.checked})`);
                }
            } catch (err) {
                errors++;
                candidates[idx].dob = null;
                candidates[idx].reason = "error";
                candidates[idx].error = err.message;
                console.error(`${progress} ! ${c.firstName} ${c.lastName} → ${err.message}`);
            }

            // Save after every company (resume-safe)
            saveCandidates(candidates);

            // Human delay between companies
            if (j < toProcessIndices.length - 1) {
                await humanDelay(3000, 6000);
            }
        }
    } finally {
        await browser.close();
    }

    console.log(`\n[scrape] Done! fetched=${fetched} notFound=${notFound} errors=${errors}`);
    console.log(`[scrape] Results saved to ${CANDIDATES_PATH}`);
}

main().catch((err) => {
    console.error("[scrape] Fatal:", err.message);
    process.exit(1);
});
