// Developer helper: download every slide of the given posts into debug/<shortcode>/NN.jpg
// (used to tune the slide reader on real posts). Usage: node scripts/debug-slides.mjs <link> [<link>…]
import fs from "node:fs";
import path from "node:path";
const TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const V = "v26.0";
const get = async (u) => { const r = await fetch(u); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j; };
const codes = process.argv.slice(2).map((l) => (l.match(/\/(?:p|reel)\/([^/?#]+)/) || [, l])[1]);
const FIELDS = "id,permalink,media_type,media_url,children{media_type,media_url}";
let url;
if (TOKEN.startsWith("EAA")) {
  const me = await get(`https://graph.facebook.com/${V}/me?fields=instagram_business_account&access_token=${TOKEN}`);
  url = `https://graph.facebook.com/${V}/${me.instagram_business_account.id}/media?fields=${encodeURIComponent(FIELDS)}&limit=50&access_token=${TOKEN}`;
} else url = `https://graph.instagram.com/${V}/me/media?fields=${encodeURIComponent(FIELDS)}&limit=50&access_token=${TOKEN}`;
const found = new Map();
for (let i = 0; url && i < 20 && found.size < codes.length; i++) {
  const j = await get(url);
  for (const m of j.data) for (const c of codes) if (m.permalink?.includes(`/${c}/`)) found.set(c, m);
  url = j.paging?.next;
}
for (const [c, m] of found) {
  const kids = m.children?.data || [m];
  fs.mkdirSync(path.join("debug", c), { recursive: true });
  for (const [i, k] of kids.entries()) {
    if (k.media_type === "VIDEO") continue;
    const buf = Buffer.from(await (await fetch(k.media_url)).arrayBuffer());
    fs.writeFileSync(path.join("debug", c, `${String(i + 1).padStart(2, "0")}.jpg`), buf);
  }
  console.log(c, kids.length);
}
