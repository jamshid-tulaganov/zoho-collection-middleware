import { Router } from "express";
import { getDobByName, getDobById } from "../services/isoftpull.js";
import { syncIsoftpullDobs, getIsoftpullDobStats, getSyncProgress } from "../services/syncIsoftpullDob.js";

const router = Router();

/**
 * POST /isoftpull/dob
 * Body: { firstName, lastName, address?, city?, state?, zip? }
 * Response: { dob: "MM/DD/YYYY" | null, applicantId: string | null }
 */
router.post("/dob", async (req, res) => {
    const { firstName, lastName, address, city, state, zip } = req.body;
    if (!firstName || !lastName) {
        return res.status(400).json({ error: "firstName and lastName are required" });
    }
    try {
        const result = await getDobByName(firstName, lastName, { address, city, state, zip });
        res.json(result);
    } catch (err) {
        console.error("[isoftpull] Error:", err.message);
        res.status(502).json({ error: err.message });
    }
});

/**
 * GET /isoftpull/dob/:id
 * Direct lookup when the iSoftPull applicant ID is already known.
 */
router.get("/dob/:id", async (req, res) => {
    try {
        const result = await getDobById(req.params.id);
        res.json(result);
    } catch (err) {
        console.error("[isoftpull] Error:", err.message);
        res.status(502).json({ error: err.message });
    }
});

/**
 * GET /isoftpull/dob-stats
 * Summary: how many DOBs from iSoftPull, how many still missing in Excel report.
 */
router.get("/dob-stats", (req, res) => {
    try {
        res.json(getIsoftpullDobStats());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /isoftpull/sync-progress
 * Live progress of the running (or last completed) sync.
 */
router.get("/sync-progress", (req, res) => {
    const progress = getSyncProgress();
    if (!progress) return res.json({ message: "No sync has run yet" });
    res.json(progress);
});

/**
 * GET /isoftpull/sync-dob
 * Start fetching missing DOBs (1,435 companies from Array Credit Report) → carrier-db.json.
 * Runs in background. Poll /isoftpull/sync-progress to see every company as it's processed.
 * Query param: ?force=true — re-fetch even records that already have a DOB in carrier-db.
 */
router.get("/sync-dob", (req, res) => {
    const progress = getSyncProgress();
    if (progress?.running) {
        return res.status(409).json({
            message: "Sync already in progress",
            progress: {
                processed: progress.processed,
                total: progress.toProcess,
                fetched: progress.fetched,
                notFound: progress.notFound,
                errors: progress.errors,
                lastProcessed: progress.details.at(-1) || null,
            },
        });
    }

    const force = req.query.force === "true";
    const limit = parseInt(req.query.limit) || 0;
    res.json({ message: "DOB sync started", force, limit: limit || "all", pollAt: "/isoftpull/sync-progress" });

    syncIsoftpullDobs({ force, limit }).catch((err) =>
        console.error("[isoftpull] Sync error:", err.message)
    );
});

export default router;
