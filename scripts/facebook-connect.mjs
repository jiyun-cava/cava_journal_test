#!/usr/bin/env node
/**
 * Facebook-login route to the Instagram API.
 *
 * Takes the short-lived user token from Meta's Graph API Explorer and turns it
 * into a Facebook Page token for the Page linked to the Instagram account.
 * A Page token made from a long-lived user token does not expire, so no
 * refresh is needed afterwards.
 *
 *   FACEBOOK_APP_ID=... FACEBOOK_APP_SECRET=... \
 *   node scripts/facebook-connect.mjs <user_token> [instagram_username]
 */
import fs from "node:fs";

const [userToken, wantUsername = "cava.life"] = process.argv.slice(2).map((s) => (s || "").trim());
const appId = process.env.FACEBOOK_APP_ID;
const appSecret = process.env.FACEBOOK_APP_SECRET;
const G = "https://graph.facebook.com/v26.0";

function fail(msg) { console.error(msg); process.exit(1); }
if (!appId || !appSecret) fail("FACEBOOK_APP_ID and FACEBOOK_APP_SECRET secrets are required (Meta app → App settings → Basic).");
if (!userToken) fail("Paste the access token from the Graph API Explorer.");

async function get(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error?.message || res.statusText);
  return json;
}

// 1) short-lived user token → long-lived user token (~60 days)
let longUser;
try {
  const j = await get(`${G}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${encodeURIComponent(appSecret)}&fb_exchange_token=${encodeURIComponent(userToken)}`);
  longUser = j.access_token;
} catch (e) {
  fail(`Meta refused the token: ${e.message}\nExplorer tokens expire after about an hour. Generate a new one and run this again.`);
}

// 2) find the Page whose linked Instagram account is the one we want
let pages = [];
let url = `${G}/me/accounts?fields=name,access_token,instagram_business_account{id,username}&limit=100&access_token=${encodeURIComponent(longUser)}`;
while (url) {
  const j = await get(url).catch((e) => fail(`Could not list your Facebook Pages: ${e.message}`));
  pages.push(...(j.data || []));
  url = j.paging?.next || null;
}
const want = wantUsername.replace(/^@/, "").toLowerCase();
const page = pages.find((p) => p.instagram_business_account?.username?.toLowerCase() === want);
if (!page) {
  const seen = pages.map((p) => `${p.name}${p.instagram_business_account ? ` → @${p.instagram_business_account.username}` : " (no Instagram linked)"}`);
  fail(`No Facebook Page linked to @${want} was found for this login.\n` +
    (seen.length ? `Pages this login can manage:\n  ${seen.join("\n  ")}` : "This login can't manage any Facebook Pages.") +
    `\nIn the Graph API Explorer, make sure you ticked the CAVA LIFE Page and @${want} in Facebook's login window, ` +
    "and that the permissions include pages_show_list, pages_read_engagement, instagram_basic and business_management.");
}

// 3) check the Page token can read the Instagram account's posts
const igId = page.instagram_business_account.id;
const test = await get(`${G}/${igId}/media?fields=id&limit=1&access_token=${encodeURIComponent(page.access_token)}`)
  .catch((e) => fail(`Found the Page, but reading @${want}'s posts failed: ${e.message}`));
const dbg = await get(`${G}/debug_token?input_token=${encodeURIComponent(page.access_token)}&access_token=${appId}|${encodeURIComponent(appSecret)}`).catch(() => null);
const exp = dbg?.data?.expires_at;
console.log(`Connected: Facebook Page "${page.name}" → @${page.instagram_business_account.username} (${test.data?.length ? "posts readable" : "no posts yet"}).`);
console.log(exp === 0 || exp === undefined ? "Token does not expire." : `Token expires ${new Date(exp * 1000).toISOString().slice(0, 10)}.`);

if (process.env.GITHUB_OUTPUT) {
  console.log(`::add-mask::${page.access_token}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `token=${page.access_token}\nusername=${page.instagram_business_account.username}\n`);
} else {
  console.log(page.access_token);
}
