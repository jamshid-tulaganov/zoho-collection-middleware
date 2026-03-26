import { Router } from "express";
import { lookupWexDob, hasWexConfig, getWexStatus } from "../services/wex.js";
import { getDaemonHealth } from "../clients/daemonClient.js";

const router = Router();

/**
 * GET /wex/status
 * Check WEX + daemon connectivity.
 */
router.get("/status", async (_req, res) => {
    try {
        const status = await getWexStatus();
        res.json({
            configured: hasWexConfig(),
            ...status,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /wex/dob
 * Single DOB lookup from WEX by company name.
 *
 * Body: { carrierId, companyName, firstName?, lastName? }
 */
router.post("/dob", async (req, res) => {
    const { carrierId, companyName, firstName, lastName } = req.body;
    if (!companyName) {
        return res.status(400).json({ error: "companyName is required" });
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
 * GET /wex/daemon-health
 * Check local daemon connectivity + browser stats.
 */
router.get("/daemon-health", async (_req, res) => {
    try {
        const health = await getDaemonHealth();
        res.json(health);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
