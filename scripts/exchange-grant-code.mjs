/**
 * Exchange a Zoho authorization grant code for a long-lived refresh token,
 * then write all three credentials (client_id, client_secret, refresh_token)
 * into collections/.env without echoing them.
 *
 * Grant codes are SINGLE-USE and expire ~10 minutes after generation.
 * Run this within that window.
 *
 * Usage (local, NEVER paste output back to chat):
 *   node scripts/exchange-grant-code.mjs \
 *     --client-id=1000.XXXXXXXX \
 *     --client-secret=YYYYYYYY \
 *     --code=1000.aaaaa.bbbbb \
 *     [--accounts-url=https://accounts.zoho.com] \
 *     [--base-url=https://www.zohoapis.com]
 *
 * On success: prints "done" — the new credentials live in .env (a backup of
 * the old .env is saved as .env.backup-<timestamp>).
 *
 * No tokens are printed to stdout.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    })
);

const CLIENT_ID = args["client-id"];
const CLIENT_SECRET = args["client-secret"];
const CODE = args["code"];
const ACCOUNTS_URL = args["accounts-url"] || "https://accounts.zoho.com";
const BASE_URL = args["base-url"] || "https://www.zohoapis.com";
const REDIRECT_URI = args["redirect-uri"] || "http://localhost";

if (!CLIENT_ID || !CLIENT_SECRET || !CODE) {
    console.error("Usage: node scripts/exchange-grant-code.mjs --client-id=... --client-secret=... --code=...");
    process.exit(1);
}

const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code: CODE,
    redirect_uri: REDIRECT_URI,
});

const r = await fetch(`${ACCOUNTS_URL}/oauth/v2/token?${params}`, { method: "POST" });
const d = await r.json();

if (!d.refresh_token) {
    console.error("Exchange failed. Zoho responded with:");
    // Don't print full body in case it has tokens — show only the error code.
    console.error(`  status: ${r.status}`);
    console.error(`  error: ${d.error || "(unknown)"}`);
    if (d.error === "invalid_code") {
        console.error("\n  The grant code was rejected. Most likely:");
        console.error("    • The code has already been used (one-time only)");
        console.error("    • The code expired (>10 min since generated)");
        console.error("    • CLIENT_ID/CLIENT_SECRET don't match the OAuth app that minted the code");
    } else if (d.error === "invalid_client") {
        console.error("\n  CLIENT_ID or CLIENT_SECRET is wrong.");
    } else if (d.error === "invalid_redirect_uri") {
        console.error("\n  Redirect URI mismatch. Check what you set when creating the Self Client.");
    }
    process.exit(1);
}

// Got refresh token + access token. Write only client_id, client_secret, refresh_token to .env.
const envPath = path.resolve(projectRoot, ".env");
if (!fs.existsSync(envPath)) {
    console.error(`No .env file at ${envPath}`);
    process.exit(1);
}

const ts = Date.now();
fs.copyFileSync(envPath, path.resolve(projectRoot, `.env.backup-${ts}`));

let envText = fs.readFileSync(envPath, "utf-8");

function setLine(name, value) {
    const re = new RegExp(`^${name}=.*$`, "m");
    if (re.test(envText)) {
        envText = envText.replace(re, `${name}=${value}`);
    } else {
        envText = envText.trimEnd() + `\n${name}=${value}\n`;
    }
}

setLine("ZOHO_CLIENT_ID", CLIENT_ID);
setLine("ZOHO_CLIENT_SECRET", CLIENT_SECRET);
setLine("ZOHO_REFRESH_TOKEN", d.refresh_token);
setLine("ZOHO_ACCOUNTS_URL", ACCOUNTS_URL);
setLine("ZOHO_BASE_URL", BASE_URL);

fs.writeFileSync(envPath, envText);

console.log("done");
console.log(`  .env updated — backup saved as .env.backup-${ts}`);
console.log(`  expires_in: ${d.expires_in || "?"}s (access token only; refresh token is long-lived)`);
console.log(`  scope: ${d.scope || "?"}`);
console.log("\n  Next: node scripts/inspect-array-reports.mjs");
