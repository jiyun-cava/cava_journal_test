#!/usr/bin/env node
/**
 * Instagram long-lived tokens expire after 60 days unless refreshed.
 * This exchanges the current token for a fresh 60-day one and prints it
 * (or, in GitHub Actions, hands it to the next step to save as a secret).
 *
 *   INSTAGRAM_ACCESS_TOKEN=IGAA... npm run refresh:token
 */
import fs from "node:fs";

const token = process.env.INSTAGRAM_ACCESS_TOKEN;
if (!token) { console.error("INSTAGRAM_ACCESS_TOKEN is not set."); process.exit(1); }

const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`);
const json = await res.json().catch(() => ({}));
if (!res.ok || !json.access_token) {
  console.error("Refresh failed:", json.error?.message || res.statusText);
  console.error("If the token already expired, create a new one in the Meta App Dashboard (README › Instagram).");
  process.exit(1);
}

const days = Math.round((json.expires_in || 0) / 86400);
console.log(`Token refreshed — valid for ~${days} days.`);
if (process.env.GITHUB_OUTPUT) {
  // Mask it in logs, pass it to the next step.
  console.log(`::add-mask::${json.access_token}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `token=${json.access_token}\n`);
} else {
  console.log(json.access_token);
}
