import { validateEnvironment } from "../src/config/env.js";
import { runCarrierDbSync } from "../src/services/syncCarrierDb.js";

async function main() {
    validateEnvironment();

    const result = await runCarrierDbSync();
    if (!result || result.success === false) {
        console.error("[sync-carrier-db] Sync failed:", result?.error || "Unknown error");
        process.exit(1);
    }

    console.log("[sync-carrier-db] Sync complete:", JSON.stringify(result));
}

main().catch((err) => {
    console.error("[sync-carrier-db] Fatal error:", err.message);
    process.exit(1);
});
