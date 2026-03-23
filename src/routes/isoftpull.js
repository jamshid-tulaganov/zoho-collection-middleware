import { Router } from "express";
import { getDobByName, getDobById } from "../services/isoftpull.js";
import { syncIsoftpullDobs, getIsoftpullDobStats, getSyncProgress } from "../services/syncIsoftpullDob.js";

const router = Router();

/**
 * POST /isoftpull/dob
 * Body: { firstName, lastName }
 * Response: { dob: "MM/DD/YYYY" | null, applicantId: string | null }
 */
router.post("/dob", async (req, res) => {
    const { firstName, lastName } = req.body;
    if (!firstName || !lastName) {
        return res.status(400).json({ error: "firstName and lastName are required" });
    }
    try {
        const result = await getDobByName(firstName, lastName);
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
router.get("/dob-stats", async (req, res) => {
    try {
        res.json(await getIsoftpullDobStats());
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
 * POST /isoftpull/sync-dob
 * Start fetching missing DOBs from the Array Credit Report Excel → iSoftPull → carrier-db.json.
 * Runs in background. Poll /isoftpull/sync-progress for live updates.
 * Query param: ?force=true — re-fetch even records that already have a DOB in carrier-db.
 */
router.post("/sync-dob", (req, res) => {
    const progress = getSyncProgress();
    if (progress?.running) {
        return res.status(409).json({
            message: "Sync already in progress",
            progress: {
                processed: progress.processed,
                total: progress.toProcess,
                fetched: progress.fetched,
            },
        });
    }

    const force = req.query.force === "true";
    res.json({ message: "DOB sync started", force, pollAt: "/isoftpull/sync-progress" });

    syncIsoftpullDobs({ force }).catch((err) =>
        console.error("[isoftpull] Sync error:", err.message)
    );
});

export default router;
