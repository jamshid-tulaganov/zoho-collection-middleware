import { Router } from "express";
import { runCarrierDbSync } from "../services/syncCarrierDb.js";
import {
    buildArrayReportFilename,
    buildArrayReportWorkbook,
    buildReportRows,
    loadReportCarriers,
} from "../services/arrayReport.js";

const router = Router();

async function maybeSyncCarrierDb(query) {
    if (query.sync !== "true") return null;
    const result = await runCarrierDbSync();
    if (result && result.success === false) {
        throw new Error(result.error || "Carrier DB sync failed");
    }
    return result;
}

router.get("/generate", async (req, res) => {
    try {
        await maybeSyncCarrierDb(req.query);
        const carriers = loadReportCarriers(req.query);

        if (!carriers.length) {
            return res.status(404).json({ error: "No records found in carrier-db.json" });
        }

        const generatedAt = new Date();
        const filename = buildArrayReportFilename(generatedAt);
        const compactOptional = req.query.compact !== "false";

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

        const { workbook } = buildArrayReportWorkbook({
            carriers,
            generatedAt,
            compactOptional,
        });
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error("[report] Generation error:", err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to generate report" });
        }
    }
});

router.get("/json", async (req, res) => {
    try {
        const syncResult = await maybeSyncCarrierDb(req.query);
        const carriers = loadReportCarriers(req.query);
        const rows = buildReportRows(carriers);

        const data = {};
        for (let i = 0; i < carriers.length; i++) {
            data[carriers[i].carrier_id] = rows[i];
        }

        res.json({
            count: carriers.length,
            generatedAt: new Date().toISOString(),
            source: "carrier-db.json",
            sync: syncResult,
            data,
        });
    } catch (err) {
        console.error("[report] JSON error:", err.message);
        res.status(500).json({ error: "Failed to generate report" });
    }
});

export default router;
