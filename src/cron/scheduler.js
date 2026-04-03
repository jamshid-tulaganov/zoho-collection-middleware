import cron from "node-cron";
import { runFullSync } from "../services/sync.js";
import { runCarrierDbSync } from "../services/syncCarrierDb.js";
import { runDobEnrichment } from "../services/dobEnrichment.js";

export function startScheduler() {
    // ── MongoDB sync — daily at midnight (server time) ──
    cron.schedule("0 0 * * *", async () => {
        console.log("[cron] Midnight full sync (MongoDB) triggered");
        try {
            const result = await runFullSync();
            console.log("[cron] MongoDB sync complete:", result);
        } catch (err) {
            console.error("[cron] MongoDB sync failed:", err.message);
        }
    });

    // ── Carrier DB JSON sync — daily at 7am ET (12:00 UTC) ──
    cron.schedule("0 12 * * *", async () => {
        console.log("[cron] 7am ET carrier-db.json sync triggered");
        try {
            const result = await runCarrierDbSync();
            console.log("[cron] carrier-db sync complete:", JSON.stringify(result));

            // DOB enrichment — look up new carriers after sync
            console.log("[cron] Running DOB enrichment for new carriers...");
            const dobResult = await runDobEnrichment();
            console.log("[cron] DOB enrichment:", JSON.stringify(dobResult));
        } catch (err) {
            console.error("[cron] carrier-db sync/DOB failed:", err.message);
        }
    });

    console.log("[cron] Scheduler started — MongoDB sync at midnight, carrier-db sync + DOB enrichment at 7am ET (12:00 UTC).");
}
