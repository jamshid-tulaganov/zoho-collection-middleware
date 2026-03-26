/**
 * dobSync.js — REST routes for the master DOB sync orchestrator.
 *
 * Endpoints:
 *   GET  /dob-sync/stats     — DOB coverage stats + checkpoint info
 *   GET  /dob-sync/progress  — live progress of running sync
 *   GET  /dob-sync/start     — start background batch sync
 */

import { Router } from "express";
import { syncDobs, getSyncProgress, getDobStats } from "../services/dobOrchestrator.js";

const router = Router();

/**
 * GET /dob-sync/stats
 * Summary: DOB coverage across carrier-db, breakdown by source.
 */
router.get("/stats", (_req, res) => {
    try {
        res.json(getDobStats());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /dob-sync/progress
 * Live progress of the running (or most recent) sync.
 */
router.get("/progress", (_req, res) => {
    const progress = getSyncProgress();
    if (!progress) return res.json({ message: "No sync has run yet in this session" });
    res.json(progress);
});

/**
 * GET /dob-sync/start
 * Start batch DOB sync (background). Poll /dob-sync/progress to monitor.
 *
 * Query params:
 *   ?force=true        — re-lookup even carriers that already have a DOB
 *   ?limit=50          — max carriers to process (0 = all)
 *   ?sources=wex       — comma-separated sources to use (wex, isoftpull)
 *   ?resume=true       — resume from last checkpoint if available
 */
router.get("/start", (req, res) => {
    const progress = getSyncProgress();
    if (progress?.running) {
        return res.status(409).json({
            message: "Sync already in progress",
            progress: {
                processed: progress.processed,
                toProcess: progress.toProcess,
                found: progress.found,
                errors: progress.errors,
                current: progress.current,
            },
        });
    }

    const force = req.query.force === "true";
    const limit = parseInt(req.query.limit) || 0;
    const sources = req.query.sources
        ? req.query.sources.split(",").map((s) => s.trim()).filter(Boolean)
        : ["wex", "isoftpull"];
    const resume = req.query.resume === "true";

    res.json({
        message: "DOB sync started",
        force,
        limit: limit || "all",
        sources,
        resume,
        pollAt: "/dob-sync/progress",
    });

    syncDobs({ force, limit, sources, resume }).catch((err) =>
        console.error("[dob-sync] Sync error:", err.message)
    );
});

export default router;
