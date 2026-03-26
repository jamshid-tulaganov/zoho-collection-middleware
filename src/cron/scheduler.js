import cron from "node-cron";
import { runFullSync } from "../services/sync.js";
import { runCarrierDbSync } from "../services/syncCarrierDb.js";
import { syncDobs } from "../services/dobOrchestrator.js";

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

    // ── DOB Sync (WEX + iSoftPull via daemon) — daily at 9am ET (14:00 UTC) ──
    // Runs 2 hours after carrier-db sync to let Zoho/SMP data settle.
    // Requires local Playwright daemon to be running on team machine.
    cron.schedule("0 14 * * *", async () => {
        console.log("[cron] 9am ET DOB sync (WEX + iSoftPull) triggered");
        try {
            const result = await syncDobs({
                force: false,
                limit: 200,                   // Process up to 200 missing DOBs per run
                sources: ["wex", "isoftpull"],
            });
            const totalFound = Object.values(result.found || {}).reduce((s, v) => s + v, 0);
            console.log(
                `[cron] DOB sync complete — found=${totalFound} (wex=${result.found?.wex || 0}, isoftpull=${result.found?.isoftpull || 0}) errors=${result.errors}`
            );
        } catch (err) {
            console.error("[cron] DOB sync failed:", err.message);
        }
    });

    console.log("[cron] Scheduler started — MongoDB sync at midnight, carrier-db sync at 7am ET, DOB sync at 9am ET.");
}
