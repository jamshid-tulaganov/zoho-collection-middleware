import { env, validateEnvironment } from "./config/env.js";
import { connectDB } from "./config/db.js";
import { createApp } from "./app.js";
import { startScheduler } from "./cron/scheduler.js";
import { bootTelegramBot } from "./routes/telegram.js";
let closeBrowser = async () => {};
let closeWex = async () => {};
try {
    closeBrowser = (await import("./services/isoftpull.js")).closeBrowser;
} catch (_) {}
try {
    closeWex = (await import("./services/wexHttp.js")).closeWexSession;
} catch (_) {}

async function bootstrap() {
    try {
        validateEnvironment();
        await connectDB();

        const app = createApp();
        await bootTelegramBot();
        startScheduler();

        app.listen(env.PORT, () => {
            console.log(`[server] Collection middleware running on port ${env.PORT}`);
        });
    } catch (err) {
        console.error("[FATAL]", err.message);
        process.exit(1);
    }
}

bootstrap();

async function shutdown() { await closeBrowser(); await closeWex(); process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
