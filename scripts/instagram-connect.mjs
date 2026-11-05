#!/usr/bin/env node
/**
 * Turns the one-time code from Instagram's login page into a long-lived
 * (60-day) access token. Used when the App Dashboard's "Generate token"
 * button doesn't work.
 *
 *   INSTAGRAM_APP_ID=... INSTAGRAM_APP_SECRET=... \
 *   node scripts/instagram-connect.mjs <code> <redirect_uri>
 *
 * In GitHub Actions the token is handed to the next step (masked), which
 * saves it as the INSTAGRAM_ACCESS_TOKEN secret.
 */
import fs from "node:fs";

const [rawCode, redirectUri] = process.argv.slice(2);
const appId = process.env.INSTAGRAM_APP_ID;
const appSecret = process.env.INSTAGRAM_APP_SECRET;

function fail(msg) { console.error(msg); process.exit(1); }
if (!appId || !appSecret) fail("INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET secrets are required (see README › Connect Instagram).");
if (!rawCode) fail("Paste the code from the address bar.");
if (!redirectUri) fail("The redirect URI is required.");

// People often paste the whole address, or the code with Instagram's trailing "#_".
let code = rawCode.trim();
const m = code.match(/[?&]code=([^&#\s]+)/);
if (m) code = m[1];
code = decodeURIComponent(code).replace(/#_?$/, "");

// 1) code → short-lived token
const form = new URLSearchParams({
  client_id: appId,
  client_secret: appSecret,
  grant_type: "authorization_code",
  redirect_uri: redirectUri,
  code,
});
const r1 = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
const j1 = await r1.json().catch(() => ({}));
if (!r1.ok || !j1.access_token) {
  const msg = j1.error_message || j1.error?.message || JSON.stringify(j1);
  fail(`Instagram refused the code: ${msg}\n` +
    "Codes work once and expire after an hour. The redirect URI must match the one in the login link exactly, " +
    "including the trailing slash. Get a fresh code and try again.");
}

// 2) short-lived → long-lived (60 days)
const r2 = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(appSecret)}&access_token=${encodeURIComponent(j1.access_token)}`);
const j2 = await r2.json().catch(() => ({}));
if (!r2.ok || !j2.access_token) fail(`Could not exchange for a long-lived token: ${j2.error?.message || JSON.stringify(j2)}`);

// 3) check it works
const r3 = await fetch(`https://graph.instagram.com/me?fields=username&access_token=${encodeURIComponent(j2.access_token)}`);
const j3 = await r3.json().catch(() => ({}));
console.log(`Connected Instagram account: @${j3.username || "?"} — token valid for ~${Math.round((j2.expires_in || 0) / 86400)} days.`);

if (process.env.GITHUB_OUTPUT) {
  console.log(`::add-mask::${j2.access_token}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `token=${j2.access_token}\nusername=${j3.username || ""}\n`);
} else {
  console.log(j2.access_token);
}
