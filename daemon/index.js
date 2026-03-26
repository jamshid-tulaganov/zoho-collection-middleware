/**
 * Collections Middleware — Local Playwright Daemon
 *
 * Runs Playwright locally (on a dev/team machine) so that the Render
 * production server can offload browser automation via HTTP calls.
 *
 * Render cannot run Chromium reliably (OOM / process limits). This
 * daemon solves that by keeping a single persistent Chromium instance
 * alive on the local machine.
 *
 * Endpoints:
 *   GET  /health               — health check + browser stats
 *   POST /api/wex/lookup       — look up carrier data from WEX portal
 *   POST /api/isoftpull/search — search iSoftPull by name + address
 *   POST /api/isoftpull/by-id  — fetch DOB by iSoftPull applicant ID
 *
 * Usage:
 *   cp .env.example .env        # fill in credentials
 *   npm install
 *   npm start
 */

import express from "express";
import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

import { lookupWex, ensureLoggedIn } from "./wex-automation.js";
import { getDobByName, getDobById } from "./isoftpull-automation.js";

// ── Config ────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

const PORT = Number(process.env.DAEMON_PORT || 9002);
const AUTH_TOKEN = process.env.DAEMON_AUTH_TOKEN || "";
const MAX_PAGES = Number(process.env.PLAYWRIGHT_MAX_PAGES || 5);
const PAGE_TIMEOUT = Number(process.env.PLAYWRIGHT_PAGE_TIMEOUT_MS || 30000);
const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== "false";

const WEX_SESSION = path.resolve(__dirname, "../data/wex-session.json");
const ISOFTPULL_SESSION = path.resolve(__dirname, "../data/isoftpull-session.json");

// ── Browser state ─────────────────────────────────────────────────────────────

let browser = null;
let wexContext = null;
let isoftpullContext = null;
let startedAt = new Date().toISOString();
let requestCount = 0;
let activePages = 0;

const LAUNCH_OPTS = {
    headless: HEADLESS,
    args: [
        "--disable-gpu",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run",
        "--safebrowsing-disable-auto-update",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--window-size=1280,900",
    ],
};

async function launchBrowser() {
    console.log("[daemon] Launching Chromium...");
    try {
        browser = await chromium.launch(LAUNCH_OPTS);
    } catch (err) {
        if (err.message.includes("Executable doesn't exist") || err.message.includes("not found")) {
            console.log("[daemon] Chromium not found — installing...");
            execSync("npx playwright install chromium", { stdio: "inherit" });
            browser = await chromium.launch(LAUNCH_OPTS);
        } else {
            throw err;
        }
    }

    browser.on("disconnected", () => {
        console.warn("[daemon] Browser disconnected — will relaunch on next request");
        browser = null;
        wexContext = null;
        isoftpullContext = null;
    });

    console.log(`[daemon] Chromium launched (headless=${HEADLESS})`);
}

async function ensureBrowser() {
    let alive = false;
    try { alive = browser?.isConnected(); } catch {}
    if (!alive) {
        if (browser) { try { await browser.close(); } catch {} }
        browser = null;
        wexContext = null;
        isoftpullContext = null;
        await launchBrowser();
    }
}

async function getWexContext() {
    await ensureBrowser();
    if (!wexContext) {
        const storageState = fs.existsSync(WEX_SESSION) ? WEX_SESSION : undefined;
        wexContext = await browser.newContext({
            storageState,
            viewport: { width: 1280, height: 900 },
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        });
    }
    return wexContext;
}

async function getIsoftpullContext() {
    await ensureBrowser();
    if (!isoftpullContext) {
        const storageState = fs.existsSync(ISOFTPULL_SESSION) ? ISOFTPULL_SESSION : undefined;
        isoftpullContext = await browser.newContext({
            storageState,
            viewport: { width: 1280, height: 900 },
        });
    }
    return isoftpullContext;
}

// ── Request queue ─────────────────────────────────────────────────────────────
// Serialize WEX and iSoftPull operations separately to avoid page conflicts.

let wexQueue = Promise.resolve();
let isoftpullQueue = Promise.resolve();

function enqueueWex(fn) {
    const next = wexQueue.then(fn);
    wexQueue = next.catch(() => {});
    return next;
}

function enqueueIsoftpull(fn) {
    const next = isoftpullQueue.then(fn);
    isoftpullQueue = next.catch(() => {});
    return next;
}

// ── Request helpers ───────────────────────────────────────────────────────────

function getMemoryMB() {
    const m = process.memoryUsage();
    return Math.round(m.heapUsed / 1024 / 1024);
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

// ── Auth middleware ───────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
    if (!AUTH_TOKEN) return next(); // No auth configured — allow all
    const provided = req.headers["x-daemon-token"] || req.query.token;
    if (provided !== AUTH_TOKEN) {
        return res.status(401).json({ error: "Unauthorized — invalid daemon token" });
    }
    next();
}

app.use("/api", authMiddleware);

// ── Health endpoint ───────────────────────────────────────────────────────────

app.get("/health", async (req, res) => {
    let browserConnected = false;
    try { browserConnected = browser?.isConnected() ?? false; } catch {}

    res.json({
        status: "ok",
        startedAt,
        uptime: Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
        browser: {
            connected: browserConnected,
            headless: HEADLESS,
        },
        memory: { heapMB: getMemoryMB() },
        requests: requestCount,
        activePages,
        config: {
            maxPages: MAX_PAGES,
            pageTimeout: PAGE_TIMEOUT,
            wexEmail: process.env.WEX_EMAIL ? `${process.env.WEX_EMAIL.slice(0, 4)}***` : "not set",
            isoftpullEmail: process.env.ISOFTPULL_EMAIL ? `${process.env.ISOFTPULL_EMAIL.slice(0, 4)}***` : "not set",
        },
    });
});

// ── WEX lookup ────────────────────────────────────────────────────────────────

app.post("/api/wex/lookup", async (req, res) => {
    const { carrierId, companyName, firstName, lastName } = req.body || {};

    if (!companyName?.trim()) {
        return res.status(400).json({ error: "companyName is required" });
    }

    requestCount++;
    const reqId = `wex-${requestCount}`;
    console.log(`[daemon] ${reqId}: WEX lookup "${companyName}" (carrierId=${carrierId})`);
    const t0 = Date.now();

    try {
        const result = await enqueueWex(async () => {
            activePages++;
            try {
                const ctx = await getWexContext();
                return await lookupWex(ctx, { carrierId, companyName, firstName, lastName });
            } finally {
                activePages--;
            }
        });

        const ms = Date.now() - t0;
        console.log(`[daemon] ${reqId}: ${result.status} (${ms}ms)`);
        res.json({ ...result, _reqId: reqId, _ms: ms });
    } catch (err) {
        console.error(`[daemon] ${reqId}: error — ${err.message}`);
        // Reset WEX context on error (session may be stale)
        if (wexContext) {
            try { await wexContext.close(); } catch {}
            wexContext = null;
        }
        res.status(500).json({ status: "error", error: err.message, _reqId: reqId });
    }
});

// ── iSoftPull search ──────────────────────────────────────────────────────────

app.post("/api/isoftpull/search", async (req, res) => {
    const { firstName, lastName, address, city, state, zip } = req.body || {};

    if (!firstName?.trim() && !lastName?.trim()) {
        return res.status(400).json({ error: "firstName or lastName required" });
    }

    requestCount++;
    const reqId = `isp-${requestCount}`;
    console.log(`[daemon] ${reqId}: iSoftPull search "${firstName} ${lastName}"`);
    const t0 = Date.now();

    try {
        const result = await enqueueIsoftpull(async () => {
            activePages++;
            try {
                const ctx = await getIsoftpullContext();
                return await getDobByName(ctx, firstName, lastName, { address, city, state, zip });
            } finally {
                activePages--;
            }
        });

        const ms = Date.now() - t0;
        const found = Boolean(result.dob);
        console.log(`[daemon] ${reqId}: ${found ? `DOB found (${ms}ms)` : `not found — ${result.reason} (${ms}ms)`}`);
        res.json({ ...result, _reqId: reqId, _ms: ms });
    } catch (err) {
        console.error(`[daemon] ${reqId}: error — ${err.message}`);
        // Reset context on geo-block or fatal errors
        if (err.message.includes("Foreign Access") || err.message.includes("context")) {
            if (isoftpullContext) {
                try { await isoftpullContext.close(); } catch {}
                isoftpullContext = null;
            }
        }
        res.status(500).json({ dob: null, error: err.message, _reqId: reqId });
    }
});

// ── iSoftPull by ID ───────────────────────────────────────────────────────────

app.post("/api/isoftpull/by-id", async (req, res) => {
    const { applicantId } = req.body || {};
    if (!applicantId) return res.status(400).json({ error: "applicantId required" });

    requestCount++;
    const reqId = `isp-id-${requestCount}`;
    console.log(`[daemon] ${reqId}: iSoftPull by ID ${applicantId}`);

    try {
        const result = await enqueueIsoftpull(async () => {
            activePages++;
            try {
                const ctx = await getIsoftpullContext();
                return await getDobById(ctx, applicantId);
            } finally {
                activePages--;
            }
        });

        res.json({ ...result, _reqId: reqId });
    } catch (err) {
        console.error(`[daemon] ${reqId}: error — ${err.message}`);
        res.status(500).json({ dob: null, error: err.message, _reqId: reqId });
    }
});

// ── Reset contexts (for manual recovery) ─────────────────────────────────────

app.post("/api/reset", authMiddleware, async (req, res) => {
    const { service } = req.body || {};
    if (!service || service === "wex") {
        if (wexContext) { try { await wexContext.close(); } catch {} wexContext = null; }
    }
    if (!service || service === "isoftpull") {
        if (isoftpullContext) { try { await isoftpullContext.close(); } catch {} isoftpullContext = null; }
    }
    res.json({ status: "ok", reset: service || "all" });
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
    // Ensure data directory exists
    const dataDir = path.resolve(__dirname, "../data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // Pre-launch browser
    try {
        await launchBrowser();
    } catch (err) {
        console.error("[daemon] Failed to launch browser on startup:", err.message);
        console.log("[daemon] Will retry on first request...");
    }

    app.listen(PORT, () => {
        console.log(`\n[daemon] ✓ Collections Playwright Daemon running on port ${PORT}`);
        console.log(`[daemon]   Health: http://localhost:${PORT}/health`);
        console.log(`[daemon]   WEX: POST http://localhost:${PORT}/api/wex/lookup`);
        console.log(`[daemon]   iSoftPull: POST http://localhost:${PORT}/api/isoftpull/search`);
        console.log(`[daemon]   Auth: ${AUTH_TOKEN ? "enabled" : "disabled (set DAEMON_AUTH_TOKEN)"}`);
        console.log(`[daemon]   Headless: ${HEADLESS}\n`);
    });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal) {
    console.log(`\n[daemon] ${signal} received — shutting down...`);
    if (wexContext) { try { await wexContext.close(); } catch {} }
    if (isoftpullContext) { try { await isoftpullContext.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
    console.log("[daemon] Shutdown complete.");
    process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((err) => {
    console.error("[daemon] Fatal startup error:", err);
    process.exit(1);
});
