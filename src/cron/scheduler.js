import cron from "node-cron";
import { runCarrierDbSync } from "../services/syncCarrierDb.js";

export function startScheduler() {
    // ── Carrier DB JSON sync — daily at 7am ET (12:00 UTC) ──
    // Runs after Zoho/SMP data has settled overnight
    cron.schedule("0 12 * * *", async () => {
        console.log("[cron] 7am ET carrier-db.json sync triggered");
        try {
            const result = await runCarrierDbSync();
            console.log("[cron] carrier-db sync complete:", JSON.stringify(result));
        } catch (err) {
            console.error("[cron] carrier-db sync failed:", err.message);
        }
    });

    console.log("[cron] Scheduler started — carrier-db sync at 7am ET (12:00 UTC).");
}
