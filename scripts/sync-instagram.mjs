#!/usr/bin/env node
/**
 * Turns new Instagram posts into journal articles.
 *
 *   INSTAGRAM_ACCESS_TOKEN=IGAA... npm run sync:instagram
 *
 * For each post on the account that isn't already on the site:
 *   - first line of the caption  → article title
 *   - rest of the caption        → article body (paragraphs, @mentions and #tags linked)
 *   - photos / carousel / video  → downloaded into src/media/<journal>/<handle>/
 *   - hashtags in the caption    → choose the journal (site.config.json → instagram.routeByHashtag)
 *
 * Posts older than instagram.importAfter are ignored, so the existing feed is
 * not duplicated on top of the articles migrated from Shopify.
 *
 * Flags: --dry-run   show what would be created
 *        --all       ignore importAfter (backfill)
 *        --mock FILE read a saved API response instead of calling Instagram (testing)
 * Exit code 0 always on "nothing new"; writes `changed=true|false` to $GITHUB_OUTPUT.
 */
import fs from "node:fs";
import path from "node:path";
import {
  MEDIA_DIR, loadConfig, writePost, listPosts, uniqueHandle, handleize, escapeHtml,
  saveImage, download, toSiteUrl, excerpt,
} from "./lib/util.mjs";

const cfg = loadConfig();
const ig = cfg.instagram;
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ALL = args.includes("--all");
const mockIdx = args.indexOf("--mock");
const MOCK = mockIdx >= 0 ? args[mockIdx + 1] : null;
const TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const API = `https://graph.instagram.com/${ig.apiVersion || "v26.0"}`;

const FIELDS = [
  "id", "caption", "media_type", "media_product_type", "media_url", "thumbnail_url",
  "permalink", "timestamp", "username",
  "children{id,media_type,media_url,thumbnail_url}",
].join(",");

function setOutput(changed, count) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\ncount=${count}\n`);
  }
}

async function api(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    const hint = e.code === 190
      ? "\n→ The access token is invalid or expired. Generate a new one (see README › Instagram) and update the INSTAGRAM_ACCESS_TOKEN secret."
      : "";
    throw new Error(`Instagram API error ${res.status}: ${e.message || res.statusText}${hint}`);
  }
  return json;
}

/** Newest posts first; stops paging once posts are older than the cutoff. */
async function fetchMedia(cutoff) {
  if (MOCK) return JSON.parse(fs.readFileSync(MOCK, "utf8")).data;
  if (!TOKEN) throw new Error("INSTAGRAM_ACCESS_TOKEN is not set.");
  const out = [];
  let url = `${API}/me/media?fields=${encodeURIComponent(FIELDS)}&limit=25&access_token=${TOKEN}`;
  for (let page = 0; url && page < 40; page++) {
    const json = await api(url);
    out.push(...(json.data || []));
    const oldest = json.data?.[json.data.length - 1];
    if (!oldest || (cutoff && new Date(oldest.timestamp) < cutoff)) break;
    url = json.paging?.next || null;
  }
  return out;
}

/* ---------------- caption → article ---------------- */
const TAG_RE = /#[\p{L}\p{N}_]+/gu;

export function parseCaption(caption = "") {
  const text = caption.replace(/\r\n?/g, "\n").trim();
  const hashtags = (text.match(TAG_RE) || []).map((t) => t.toLowerCase());
  const lines = text.split("\n");
  const firstIdx = lines.findIndex((l) => l.replace(TAG_RE, "").trim());
  let title = firstIdx >= 0 ? lines[firstIdx].replace(TAG_RE, "").trim() : "";
  let bodyLines = firstIdx >= 0 ? lines.slice(firstIdx + 1) : [];
  // A one-paragraph caption with no line break: use the first sentence as title.
  if (title.length > 70) {
    const m = title.match(/^(.{10,80}?[.!?。…])\s/);
    if (m) { bodyLines = [title.slice(m[1].length).trim(), ...bodyLines]; title = m[1]; }
    else { bodyLines = [title, ...bodyLines]; title = title.slice(0, 60).trimEnd() + "…"; }
  }
  // Drop trailing lines that are only hashtags / dots (Instagram spacing tricks).
  while (bodyLines.length && /^[\s.·•\-_]*$|^(\s*#[\p{L}\p{N}_]+\s*)+$/u.test(bodyLines[bodyLines.length - 1])) bodyLines.pop();
  return { title: title.replace(/^[\s.·•\-_]+|[\s.·•\-_]+$/g, "") || "Untitled", body: bodyLines.join("\n").trim(), hashtags };
}

function captionHtml(body, removeTags) {
  if (!body) return "";
  const linkify = (line) => {
    let s = escapeHtml(line);
    s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="noopener">$1</a>');
    s = s.replace(/(^|[^\w.])@([A-Za-z0-9._]{1,30})(?![A-Za-z0-9_])/g, (m, pre, u) =>
      `${pre}<a class="mention" href="https://www.instagram.com/${u.replace(/\.$/, "")}/" rel="noopener">@${u}</a>`);
    s = s.replace(/(^|\s)(#[\p{L}\p{N}_]+)/gu, (m, pre, t) =>
      removeTags.has(t.toLowerCase()) ? pre : `${pre}<span class="tag">${t}</span>`);
    return s.trimEnd();
  };
  return body
    .split(/\n\s*\n/)
    .map((para) => para.split("\n").map(linkify).filter((l) => l.trim()).join("<br>"))
    .filter(Boolean)
    .map((p) => `<p>${p}</p>`)
    .join("\n");
}

function pickJournal(hashtags) {
  for (const [tag, journal] of Object.entries(ig.routeByHashtag || {})) {
    if (hashtags.includes(tag.toLowerCase())) return journal;
  }
  return ig.defaultJournal;
}

/* ---------------- media ---------------- */
async function saveMedia(items, dir, maxBytes) {
  const out = [];
  let n = 0;
  for (const it of items) {
    const name = String(++n).padStart(2, "0");
    try {
      if (it.media_type === "VIDEO") {
        let poster;
        if (it.thumbnail_url) poster = toSiteUrl((await saveImage(it.thumbnail_url, path.join(dir, `${name}-poster`), { maxWidth: 1440 })).file);
        let src;
        if (it.media_url) {
          const dest = path.join(dir, `${name}.mp4`);
          if (await download(it.media_url, dest, { maxBytes })) src = toSiteUrl(dest);
        }
        out.push({ type: "video", src, poster });
      } else if (it.media_url) {
        const { file } = await saveImage(it.media_url, path.join(dir, name), { maxWidth: 1440, quality: 85 });
        out.push({ type: "image", src: toSiteUrl(file) });
      }
    } catch (e) {
      console.warn(`    ! media ${it.id || name} failed: ${e.message}`);
    }
  }
  return out;
}

function galleryHtml(media, permalink) {
  if (!media.length) return "";
  const figs = media.map((m) => {
    if (m.type === "video" && m.src) {
      return `<figure><video controls playsinline preload="metadata"${m.poster ? ` poster="${m.poster}"` : ""} src="${m.src}"></video></figure>`;
    }
    if (m.type === "video") {
      // Too large to store or not downloadable: show the poster linking to Instagram.
      return m.poster ? `<figure><a href="${permalink}" rel="noopener"><img src="${m.poster}" alt="" loading="lazy"></a><figcaption>▶ Watch on Instagram</figcaption></figure>` : "";
    }
    return `<figure><img src="${m.src}" alt="" loading="lazy" decoding="async"></figure>`;
  });
  return `<div class="ig-gallery">\n${figs.join("\n")}\n</div>`;
}

/* ---------------- main ---------------- */
async function main() {
  const cutoff = ALL || !ig.importAfter ? null : new Date(ig.importAfter);
  const known = new Set(listPosts().map((p) => String(p.data.instagram_id || "")).filter(Boolean));
  const media = await fetchMedia(cutoff);

  const fresh = media
    .filter((m) => !known.has(String(m.id)))
    .filter((m) => !cutoff || new Date(m.timestamp) >= cutoff)
    .filter((m) => m.media_product_type !== "STORY")
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); // oldest first → stable handles

  const skip = new Set((ig.skipHashtags || []).map((t) => t.toLowerCase()));
  const requiredTag = ig.requireHashtag ? ig.requireHashtag.toLowerCase() : null;
  const routing = new Set(Object.keys(ig.routeByHashtag || {}).map((t) => t.toLowerCase()));
  if (requiredTag) routing.add(requiredTag);
  const maxBytes = (ig.maxVideoMB || 60) * 1024 * 1024;

  let created = 0;
  for (const m of fresh) {
    const { title, body, hashtags } = parseCaption(m.caption || "");
    if (hashtags.some((t) => skip.has(t))) { console.log(`  – skip ${m.id} (skip hashtag)`); continue; }
    if (requiredTag && !hashtags.includes(requiredTag)) { console.log(`  – skip ${m.id} (missing ${ig.requireHashtag})`); continue; }

    const journal = pickJournal(hashtags);
    const handle = uniqueHandle(journal, handleize(title) || `instagram-${m.id}`);
    console.log(`  + [${journal}] ${title}  (${m.media_type}, ${m.timestamp})`);
    if (DRY) { created++; continue; }

    const items = m.media_type === "CAROUSEL_ALBUM" ? (m.children?.data || []) : [m];
    const saved = await saveMedia(items, path.join(MEDIA_DIR, journal, handle), maxBytes);
    const cover = saved.find((s) => s.type === "image")?.src || saved.find((s) => s.poster)?.poster;
    const removeTags = ig.removeRoutingHashtags ? routing : new Set();
    const text = captionHtml(body, removeTags);

    writePost({
      journal,
      handle,
      data: {
        title,
        date: m.timestamp,
        cover,
        excerpt: excerpt(text || title, 140),
        tags: hashtags.filter((t) => !removeTags.has(t)).map((t) => t.slice(1)),
        source: "instagram",
        instagram_id: String(m.id),
        instagram_permalink: m.permalink,
      },
      html: `${galleryHtml(saved, m.permalink)}\n<div class="ig-caption">\n${text}\n</div>`,
    });
    created++;
  }

  console.log(created ? `${DRY ? "Would create" : "Created"} ${created} article(s).` : "No new Instagram posts.");
  setOutput(!DRY && created > 0, created);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message || e); setOutput(false, 0); process.exit(1); });
}
