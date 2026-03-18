import mongoose from "mongoose";
import { env } from "./env.js";

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;

export async function connectDB() {
    if (!env.MONGODB_URI) {
        console.log("[MongoDB] MONGODB_URI not set — persistence disabled.");
        return false;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            mongoose.set("strictQuery", true);
            await mongoose.connect(env.MONGODB_URI);
            console.log("[MongoDB] Connected.");
            return true;
        } catch (err) {
            console.error(`[MongoDB] Attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);
            if (attempt === MAX_RETRIES) {
                throw new Error("Could not connect to MongoDB after maximum retries");
            }
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
    }
}

export function isDatabaseReady() {
    return mongoose.connection.readyState === 1;
}
