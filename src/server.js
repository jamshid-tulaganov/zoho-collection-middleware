import { env, validateEnvironment } from "./config/env.js";
import { connectDB } from "./config/db.js";
import { createApp } from "./app.js";
import { startScheduler } from "./cron/scheduler.js";

async function bootstrap() {
    try {
        validateEnvironment();
        await connectDB();

        const app = createApp();
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
