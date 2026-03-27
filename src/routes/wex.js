import { Router } from "express";
import { lookupWexDob, hasWexConfig } from "../services/wex.js";
import { syncWexDobs, getWexSyncProgress, getWexDobStats } from "../services/syncWexDob.js";

const router = Router();

/**
 * GET /wex/status
 * Check if WEX is configured and ready.
 */
router.get("/status", (_req, res) => {
    res.json({
        configured: hasWexConfig(),
        message: hasWexConfig()
            ? "WEX credentials configured"
            : "WEX_EMAIL and WEX_PASSWORD are not set",
    });
});

/**
 * POST /wex/dob
 * Single DOB lookup from WEX by company name.
 *
 * Body: { carrierId, companyName, firstName?, lastName? }
 * Response: full WEX lookup result (status, dob, application data, owners)
 */
router.post("/dob", async (req, res) => {
    if (!hasWexConfig()) {
        return res.status(503).json({ error: "WEX credentials not configured" });
    }

    const { carrierId, companyName, firstName, lastName } = req.body;
    if (!carrierId || !companyName) {
        return res.status(400).json({ error: "carrierId and companyName are required" });
    }

    try {
        const result = await lookupWexDob({ carrierId, companyName, firstName, lastName });
        res.json(result);
    } catch (err) {
        console.error("[wex] DOB lookup error:", err.message);
        res.status(502).json({ error: err.message });
    }
});

/**
 * GET /wex/dob-stats
 * Summary: how many DOBs from WEX, how many still missing.
 */
router.get("/dob-stats", (_req, res) => {
    try {
        res.json(getWexDobStats());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /wex/sync-progress
 * Live progress of the running (or last completed) WEX DOB sync.
 */
router.get("/sync-progress", (_req, res) => {
    const progress = getWexSyncProgress();
    if (!progress) return res.json({ message: "No WEX sync has run yet" });
    res.json(progress);
});

/**
 * GET /wex/sync-dob
 * Start batch WEX DOB sync for carriers missing DOB.
 * Runs in background. Poll /wex/sync-progress to monitor.
 *
 * Query params:
 *   ?force=true  — re-lookup even carriers that already have a DOB
 *   ?limit=50    — max carriers to process (0 = all)
 */
router.get("/sync-dob", (req, res) => {
    if (!hasWexConfig()) {
        return res.status(503).json({ error: "WEX credentials not configured" });
    }

    const progress = getWexSyncProgress();
    if (progress?.running) {
        return res.status(409).json({
            message: "WEX sync already in progress",
            progress: {
                processed: progress.processed,
                toProcess: progress.toProcess,
                fetched: progress.fetched,
                notFound: progress.notFound,
                errors: progress.errors,
                current: progress.current || null,
            },
        });
    }

    const force = req.query.force === "true";
    const limit = parseInt(req.query.limit) || 0;

    res.json({
        message: "WEX DOB sync started",
        force,
        limit: limit || "all",
        pollAt: "/wex/sync-progress",
    });

    syncWexDobs({ force, limit }).catch((err) =>
        console.error("[wex] Sync error:", err.message)
    );
});

export default router;
