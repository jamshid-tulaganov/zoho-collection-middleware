import express from "express";
import reportsRouter from "./routes/reports.js";
import carrierDbRouter from "./routes/carrierDb.js";
import {
    getCarrierDbSyncStatus,
    getCarrierDbStatusSnapshot,
    runCarrierDbSync,
} from "./services/syncCarrierDb.js";

export function createApp() {
    const app = express();

    app.use(express.json({ limit: "5mb" }));

    // ── Health check ──
    app.get("/", (req, res) => {
        res.json({
            status: "ok",
            service: "collection-middleware",
            carrierDbSync: getCarrierDbSyncStatus(),
        });
    });

    // ── Report routes ──
    app.use("/reports", reportsRouter);

    // ── Carrier DB (file-based cache) ──
    app.use("/carrier-db", carrierDbRouter);

    // Convenience aliases matching the carrier-db plan
    const triggerCarrierDbSync = async (req, res) => {
        const status = getCarrierDbSyncStatus();
        if (status.inProgress) {
            return res.status(409).json({ message: "Sync already in progress", status });
        }

        res.json({ message: "Carrier DB sync started", status: "running" });
        runCarrierDbSync().catch((err) =>
            console.error("[carrier-db] Background sync error:", err.message)
        );
    };

    app.get("/sync-carrier-db", triggerCarrierDbSync);
    app.post("/sync-carrier-db", triggerCarrierDbSync);

    app.get("/carrier-db-status", (req, res) => {
        res.json(getCarrierDbStatusSnapshot());
    });

    return app;
}
