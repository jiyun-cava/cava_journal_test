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
import os from "node:os";
import path from "node:path";
import {
  ROOT, MEDIA_DIR, loadConfig, writePost, listPosts, uniqueHandle, handleize, escapeHtml,
  saveImage, download, toSiteUrl, excerpt,
} from "./lib/util.mjs";
import { visionEnabled, analyzeSlide, normalise, slidesToBlocks } from "./lib/vision.mjs";
import { ocrAvailable, analyzeSlideOcr, slideLayout } from "./lib/ocr.mjs";
import { loadManuscripts, findManuscript, assemble, titleScore, looksLikeName, googleDocHtmlToManuscript, parseManuscript } from "./lib/manuscript.mjs";
import { driveEnabled, listDocs, exportHtml, folderName, serviceAccountEmail } from "./lib/gdrive.mjs";
import sharp from "sharp";

const cfg = loadConfig();
const ig = cfg.instagram;
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ALL = args.includes("--all");
// --only <link or id>: (re)import just this one post, even if it was handled before.
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx >= 0 ? String(args[onlyIdx + 1] || "").trim() : "";
// --fallback: skip slide reading (first image + "text needed"), e.g. to test the fallback.
const FORCE_FALLBACK = args.includes("--fallback");
// --manuscripts <dir>: where approved manuscripts are kept (default: manuscripts/).
const msIdx = args.indexOf("--manuscripts");
const MANUSCRIPT_DIR = msIdx >= 0 ? path.resolve(args[msIdx + 1]) : null;
/** Does this post match the --only value (an Instagram link, shortcode or media id)? */
const matchesOnly = (m) => {
  if (!ONLY) return true;
  if (String(m.id) === ONLY) return true;
  const code = (ONLY.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|tv)\/([^/?#]+)/) || [, ONLY])[1];
  return Boolean(m.permalink && code && m.permalink.includes(`/${code}`));
};
const mockIdx = args.indexOf("--mock");
const MOCK = mockIdx >= 0 ? args[mockIdx + 1] : null;
// Testing: a JSON map of carousel child id → slide analysis, used instead of calling Claude.
const mvIdx = args.indexOf("--mock-vision");
const MOCK_VISION = mvIdx >= 0 ? JSON.parse(fs.readFileSync(args[mvIdx + 1], "utf8")) : null;
// --mock-layout FILE: slide layouts by media id, instead of running the reader (tests).
const mlIdx = args.indexOf("--mock-layout");
const MOCK_LAYOUT = mlIdx >= 0 ? JSON.parse(fs.readFileSync(args[mlIdx + 1], "utf8")) : null;
const TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const API = `https://graph.instagram.com/${ig.apiVersion || "v26.0"}`;

const FIELDS = [
  "id", "caption", "media_type", "media_product_type", "media_url", "thumbnail_url",
  "permalink", "timestamp", "username",
  "children{id,media_type,media_url,thumbnail_url}",
].join(",");

function setOutput(changed, count, titles = [], published = []) {
  if (process.env.GITHUB_OUTPUT) {
    const t = titles.join(" / ").replace(/[\r\n]/g, " ").slice(0, 200);
    const pt = published.map((x) => x.title).join(" / ").replace(/[\r\n]/g, " ").slice(0, 200);
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `changed=${changed}\ncount=${count}\ntitles=${t}\npublished=${published.length}\npublished_titles=${pt}\n`);
  }
  // Files of articles to publish straight away (built from an approved manuscript).
  if (process.env.SYNC_PUBLISH_LIST) {
    fs.writeFileSync(process.env.SYNC_PUBLISH_LIST, published.flatMap((x) => x.paths).map((f) => path.relative(ROOT, f)).join("\n") + (published.length ? "\n" : ""));
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
  let url;
  if (TOKEN.startsWith("EAA")) {
    // Facebook-login token (a Facebook Page token): read the Page's linked Instagram account.
    const FB = `https://graph.facebook.com/${ig.apiVersion || "v26.0"}`;
    const me = await api(`${FB}/me?fields=instagram_business_account&access_token=${TOKEN}`);
    const igId = me.instagram_business_account?.id;
    if (!igId) throw new Error("This Facebook token isn't linked to an Instagram account. Reconnect with \"Connect Instagram (Facebook login)\".");
    url = `${FB}/${igId}/media?fields=${encodeURIComponent(FIELDS)}&limit=25&access_token=${TOKEN}`;
  } else {
    url = `${API}/me/media?fields=${encodeURIComponent(FIELDS)}&limit=25&access_token=${TOKEN}`;
  }
  for (let page = 0; url && page < 40; page++) {
    const json = await api(url);
    out.push(...(json.data || []));
    if (ONLY && out.some(matchesOnly)) break;
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

/* ---------------- slides → article body ---------------- */
const siteFile = (src) => path.join(ROOT, "src", src.replace(/^\//, ""));

/** Cut the pictures out of their slides for a manuscript-built article. */
async function cutPictures(blocks) {
  const letters = new Map();
  const out = [];
  for (const b of blocks) {
    if (b.type !== "media" || !b.crop) { out.push(b); continue; }
    const k = letters.get(b.media.src) || 0;
    letters.set(b.media.src, k + 1);
    const src = b.media.src.replace(/(\.\w+)$/, `-${String.fromCharCode(97 + k)}$1`);
    const file = siteFile(b.media.src);
    const { width, height } = await sharp(file).metadata();
    const box = { left: Math.max(0, Math.round(b.crop.left)), top: Math.max(0, Math.round(b.crop.top)) };
    box.width = Math.max(1, Math.min(width - box.left, Math.round(b.crop.width)));
    box.height = Math.max(1, Math.min(height - box.top, Math.round(b.crop.height)));
    await sharp(file).extract(box).jpeg({ quality: 88 }).toFile(siteFile(src));
    out.push({ ...b, media: { type: "image", src, scale: Math.min(1, Math.max(0.2, box.width / width)) } });
  }
  return out;
}

/**
 * A text slide that also carries pictures (a book cover, a photo, a screenshot)
 * is split in reading order: its text becomes live text and each picture is cut
 * out of the slide and kept as an image, with its caption.
 */
async function slideParts(media, analysis) {
  if (!analysis?.parts?.some((p) => p.kind === "image")) return [{ media, analysis: analysis && normalise(analysis) }];
  const out = [];
  let k = 0;
  let note = "";
  for (const p of analysis.parts) {
    if (p.kind === "text") {
      if (!p.paragraphs?.length) { note = [note, p.note].filter(Boolean).join(" / "); continue; }
      out.push({ media, analysis: normalise({ kind: "text", paragraphs: p.paragraphs, note: [p.note, note].filter(Boolean).join(" / ") }) });
      note = "";
    } else {
      const src = media.src.replace(/(\.\w+)$/, `-${String.fromCharCode(97 + k++)}$1`);
      const { width, height } = await sharp(siteFile(media.src)).metadata();
      const box = {
        left: Math.max(0, Math.round(p.box.left)), top: Math.max(0, Math.round(p.box.top)),
      };
      box.width = Math.max(1, Math.min(width - box.left, Math.round(p.box.width)));
      box.height = Math.max(1, Math.min(height - box.top, Math.round(p.box.height)));
      await sharp(siteFile(media.src)).extract(box).jpeg({ quality: 88 }).toFile(siteFile(src));
      // Shown at the size it had on the slide, not stretched to the full column.
      const scale = Math.min(1, Math.max(0.2, box.width / width));
      out.push({ media: { type: "image", src, scale }, caption: p.caption || "", analysis: normalise({ kind: "image" }) });
    }
  }
  if (note) {
    const lastText = [...out].reverse().find((x) => x.analysis.kind === "text");
    if (lastText) lastText.analysis.note = [lastText.analysis.note, note].filter(Boolean).join(" / ");
  }
  if (out.length) out[0].analysis.issue = normalise(analysis).issue;
  return out;
}

function mediaHtml(m, permalink) {
  return galleryHtml([m], permalink).replace(/^<div class="ig-gallery">\n|\n<\/div>$/g, "");
}

function blocksHtml(blocks, permalink) {
  return blocks.map((b) => {
    if (b.type === "heading") return `<h4>${escapeHtml(b.text)}</h4>`;
    if (b.type === "bio") return `${b.name ? `<h3>${escapeHtml(b.name)}</h3>\n` : ""}<p>${escapeHtml(b.text)}</p>`;
    if (b.type === "media") {
      let fig = mediaHtml(b.media, permalink);
      if (b.alt) fig = fig.replace(' alt=""', ` alt="${escapeHtml(b.alt)}"`);
      if (b.caption) fig = fig.replace(/<\/figure>$/, `<figcaption>${escapeHtml(b.caption)}</figcaption></figure>`);
      if (b.media.scale && b.media.scale < 0.95) {
        return `<div class="ig-gallery ig-cutout">${fig.replace(/^<figure>/, `<figure style="width:${Math.round(b.media.scale * 100)}%">`)}</div>`;
      }
      return `<div class="ig-gallery">${fig}</div>`;
    }
    if (b.type === "placeholder") return `<!-- EDITOR: 본문을 여기에 붙여 넣으세요. Paste the article text here. -->\n<p class="needs-text">본문 준비 중</p>`;
    const paras = b.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`);
    const notes = b.notes.map((n) => `<p class="slide-note">${escapeHtml(n)}</p>`);
    return `<div class="slide-text">\n${[...paras, ...notes].join("\n")}\n</div>`;
  }).join("\n");
}

/** Markdown preview of one new article, for the pull request an editor reviews. */
function reviewMarkdown({ title, journal, file, permalink, mode, blocks, rawBase, warnings }) {
  const img = (src) => `<img src="${rawBase ? rawBase + "/src" + src : src}" width="240">`;
  const lines = [
    `### ${title}`,
    `${journal} · [Instagram](${permalink}) · \`${path.relative(ROOT, file)}\``,
    "",
    mode === "manuscript"
      ? "Text comes from the approved manuscript. **Check that each picture is in the right place** and its caption is right, then merge."
      : mode === "vision"
      ? "Text slides were transcribed automatically. **Check every word against the post** before merging."
      : "**Text needed.** Only the first image was imported. Open the file, replace `본문 준비 중` with the article text, then merge.",
    ...warnings.map((w) => `> ⚠️ ${w}`),
    "",
  ];
  for (const b of blocks) {
    if (b.type === "media") lines.push(b.media.type === "image" ? img(b.media.src) : `▶ video${b.media.poster ? " " + img(b.media.poster) : ""}`, ...(b.caption ? [`<sub>${escapeHtml(b.caption)}</sub>`] : []), "");
    else if (b.type === "placeholder") lines.push("_(본문 준비 중)_", "");
    else if (b.type === "heading") lines.push(`**${b.text}**`, "");
    else if (b.type === "bio") lines.push(`**${b.name || "(name)"}**`, `> ${b.text}`, "");
    else lines.push(...b.paragraphs.map((p) => `> ${p}\n>`), ...b.notes.map((n) => `> _${n}_`), "");
  }
  return lines.join("\n");
}

/* ---------------- state: posts already handled ---------------- */
const STATE_FILE = path.join(ROOT, "instagram-state.json");
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { seen: [] }; }
}
function writeState(state) {
  state.seen = [...new Set(state.seen.map(String))].sort();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

/* ---------------- main ---------------- */
async function main() {
  const cutoff = ALL || !ig.importAfter ? null : new Date(ig.importAfter);
  const existing = listPosts();
  const state = readState();
  // Already on the site, or already sent for review (merged, pending or rejected).
  const known = new Set([...existing.map((p) => String(p.data.instagram_id || "")), ...state.seen.map(String)].filter(Boolean));
  // Articles already on the site from Shopify: an Instagram post with the same
  // title is the same article, so it isn't imported twice.
  const migrated = new Set(existing.filter((p) => p.data.source !== "instagram").map((p) => p.handle));
  const media = await fetchMedia(ONLY ? null : cutoff);
  const manuscripts = loadManuscripts(MANUSCRIPT_DIR || path.join(ROOT, "manuscripts"));
  if (manuscripts.length) console.log(`${manuscripts.length} manuscript(s) on file.`);
  // Manuscripts in Google Drive (when a service account is set up).
  let driveDocs = [];
  if (driveEnabled()) {
    try {
      const since = cutoff && !ONLY ? new Date(cutoff.getTime() - 365 * 86400000) : null;
      driveDocs = await listDocs({ modifiedAfter: since });
      console.log(`Google Drive: ${driveDocs.length} document(s) visible to ${serviceAccountEmail()}.`);
    } catch (e) {
      console.warn(`::warning::Google Drive manuscripts unavailable: ${e.message}`);
    }
  }
  /** The post's manuscript: in the manuscripts folder, or a Google Doc with the post's title. */
  const manuscriptFor = async (texts) => {
    const local = findManuscript(manuscripts, texts);
    if (local) return local;
    const doc = driveDocs.map((d) => ({ d, s: titleScore(d.name, texts) })).filter((x) => x.s >= 0.85).sort((a, b) => b.s - a.s)[0]?.d;
    if (!doc) return null;
    const { text, comments } = googleDocHtmlToManuscript(await exportHtml(doc.id));
    const ms = parseManuscript(text, comments);
    if (!ms.title) ms.title = doc.name;
    const folder = await folderName(doc.parents?.[0]);
    if (looksLikeName(folder)) ms.author = folder;
    ms.file = `Google Doc "${doc.name}"${folder ? ` in ${folder}` : ""} (${doc.webViewLink || doc.id})`;
    return ms;
  };

  // A post imported before its manuscript was in: rebuild it from the manuscript once.
  state.manuscript = state.manuscript || [];
  state.manuscriptTried = state.manuscriptTried || {};
  const builtFromManuscript = new Set(state.manuscript.map(String));
  const manuscriptName = (m) => {
    const texts = [parseCaption(m.caption || "").title, m.caption || ""];
    const local = findManuscript(manuscripts, texts);
    if (local) return local.file;
    const doc = driveDocs.find((d) => titleScore(d.name, texts) >= 0.85);
    return doc ? `drive:${doc.id}:${doc.modifiedTime}` : null;
  };
  const redo = new Set();
  for (const m of media) {
    const id = String(m.id);
    if (ONLY || !known.has(id) || builtFromManuscript.has(id)) continue;
    if (cutoff && new Date(m.timestamp) < cutoff) continue;
    const name = manuscriptName(m);
    if (name && state.manuscriptTried[id] !== name) redo.add(id);
  }
  if (redo.size) console.log(`${redo.size} imported post(s) now have a manuscript: rebuilding them.`);

  const fresh = media
    .filter((m) => ONLY ? matchesOnly(m) : !known.has(String(m.id)) || redo.has(String(m.id)))
    .filter((m) => ONLY || !cutoff || new Date(m.timestamp) >= cutoff)
    .filter((m) => m.media_product_type !== "STORY")
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); // oldest first → stable handles
  if (ONLY && !fresh.length) {
    throw new Error(`Couldn't find the post "${ONLY}" on the account. Paste the post's full Instagram link.`);
  }
  if (ONLY) console.log(`Importing one post only: ${fresh[0].permalink || fresh[0].id}${FORCE_FALLBACK ? " (fallback)" : ""}`);

  const skip = new Set((ig.skipHashtags || []).map((t) => t.toLowerCase()));
  const requiredTag = ig.requireHashtag ? ig.requireHashtag.toLowerCase() : null;
  const routing = new Set(Object.keys(ig.routeByHashtag || {}).map((t) => t.toLowerCase()));
  if (requiredTag) routing.add(requiredTag);
  const maxBytes = (ig.maxVideoMB || 60) * 1024 * 1024;

  // Slide reader: "tesseract" (free, default) or "claude" (paid, needs ANTHROPIC_API_KEY).
  const reader = MOCK_VISION ? "mock"
    : ig.splitSlides === false ? null
    : (ig.reader || "tesseract") === "claude" ? (visionEnabled() ? "claude" : null)
    : (ocrAvailable() ? "tesseract" : null);
  const useVision = Boolean(reader);
  const visionModel = ig.visionModel || "claude-sonnet-5-5";
  if (ig.splitSlides !== false && !reader) {
    console.warn(`  ! slide reader "${ig.reader || "tesseract"}" is not available; new posts arrive as drafts with the first image only.`);
  }
  const rawBase = process.env.REVIEW_RAW_BASE || "";
  const reports = [];
  const titles = [];
  const published = [];

  let created = 0;
  for (const m of fresh) {
    const parsed = parseCaption(m.caption || "");
    const { body, hashtags } = parsed;
    let title = parsed.title;
    if (hashtags.some((t) => skip.has(t))) { console.log(`  – skip ${m.id} (skip hashtag)`); state.seen.push(m.id); continue; }
    if (requiredTag && !hashtags.includes(requiredTag)) { console.log(`  – skip ${m.id} (missing ${ig.requireHashtag})`); continue; }

    if (migrated.has(handleize(title))) { console.log(`  – skip ${m.id} (already on the site: ${title})`); state.seen.push(m.id); continue; }

    const journal = pickJournal(hashtags);
    console.log(`  + [${journal}] ${title}  (${m.media_type}, ${m.timestamp})`);
    if (DRY) { created++; continue; }

    // Media is saved under a temporary folder first: the final handle may come from the title slide.
    const tmpHandle = `_incoming-${m.id}`;
    const items = m.media_type === "CAROUSEL_ALBUM" ? (m.children?.data || []) : [m];
    const saved = await saveMedia(items, path.join(MEDIA_DIR, journal, tmpHandle), maxBytes);
    const warnings = [];

    // 0) Approved manuscript available: its text, with the carousel's pictures in place.
    // 1) Otherwise read each image slide; 2) fall back to "first image + text needed".
    let mode = "manual";
    let blocks = [];
    let author, issue;
    let manuscript = null;
    if (!FORCE_FALLBACK && saved.length) {
      try { manuscript = await manuscriptFor([title, m.caption || ""]); } catch (e) {
        console.warn(`    ! manuscript lookup failed: ${e.message}`);
        warnings.push(`Couldn't read the manuscript from Google Drive (${e.message.slice(0, 120)}).`);
      }
    }
    if (manuscript && !ocrAvailable() && !MOCK_LAYOUT) warnings.push("A manuscript was found, but the slide reader isn't installed, so pictures couldn't be placed.");
    if (manuscript && (ocrAvailable() || MOCK_LAYOUT)) {
      try {
        console.log(`      manuscript: ${manuscript.file}`);
        const slides = [];
        for (const [i, s] of saved.entries()) {
          const layout = s.type !== "image" ? null
            : MOCK_LAYOUT ? MOCK_LAYOUT[items[i]?.id] || null
            : await slideLayout(siteFile(s.src));
          slides.push({ media: s, layout });
        }
        const r = assemble(manuscript, slides);
        blocks = await cutPictures(r.blocks);
        title = r.title;
        author = r.author || undefined;
        warnings.push(...r.warnings);
        mode = "manuscript";
      } catch (e) {
        console.warn(`    ! manuscript matching failed: ${e.message}`);
        warnings.push(`The manuscript "${manuscript.file}" was found but couldn't be matched to the slides (${e.message.slice(0, 120)}).`);
        blocks = [];
      }
    }
    if (mode !== "manuscript" && useVision && !FORCE_FALLBACK && saved.length) {
      try {
        const slides = [];
        for (const [i, s] of saved.entries()) {
          let analysis = null;
          if (s.type === "image") {
            const t0 = Date.now();
            try {
              analysis = reader === "mock" ? MOCK_VISION[items[i]?.id] || null
                : reader === "claude" ? await analyzeSlide(siteFile(s.src), { model: visionModel })
                : await analyzeSlideOcr(siteFile(s.src));
            } catch (e) {
              if (reader === "claude") throw e;
              // One unreadable slide: keep it as an image and say so.
              console.warn(`      slide ${i + 1}: could not be read (${e.message.slice(0, 80)})`);
              warnings.push(`Slide ${i + 1} could not be read and was kept as an image. If it has text, type it in.`);
              analysis = null;
            }
            if (Date.now() - t0 > 30000) console.log(`      slide ${i + 1}: slow (${Math.round((Date.now() - t0) / 1000)}s)`);
            console.log(`      slide ${i + 1}: ${analysis?.kind || "image"}${analysis?.kind === "text" ? ` (${analysis.paragraphs.length} paragraphs)` : ""}`);
          }
          if (analysis?.uncertain) warnings.push(`Slide ${i + 1}: some words may be misread. Check this slide's text closely.`);
          slides.push(...await slideParts(s, analysis));
        }
        const titleSlide = slides.find((s) => s.analysis?.kind === "title")?.analysis;
        if (titleSlide?.title) {
          author = titleSlide.author || undefined;
          title = author ? `${author} — ${titleSlide.title}` : titleSlide.title;
        }
        issue = slides.map((s) => s.analysis?.issue).find((n) => Number.isFinite(n)) ?? undefined;
        blocks = slidesToBlocks(slides);
        mode = "vision";
        if (!blocks.some((b) => b.type === "text")) warnings.push("No text slides were found. If this post has text slides, add the text by hand.");
      } catch (e) {
        console.warn(`    ! slide reading failed, falling back to a draft: ${e.message}`);
        warnings.push(`Automatic transcription failed (${e.message.slice(0, 120)}).`);
        blocks = [];
        mode = "manual";
      }
    }
    if (mode === "manual") {
      const first = saved.find((s) => s.type === "image") || saved[0];
      blocks = [...(first ? [{ type: "media", media: first }] : []), { type: "placeholder" }];
      if (FORCE_FALLBACK) warnings.push("Imported as a fallback draft on request (slide reading skipped).");
      else if (!useVision) warnings.push("Automatic transcription is off or unavailable, so only the first image was imported.");
    }

    if (redo.has(String(m.id)) && mode !== "manuscript") {
      // Rebuilding only makes sense from the manuscript; keep the earlier import.
      console.log(`  – ${m.id}: manuscript couldn't be matched to the slides; keeping the earlier import`);
      fs.rmSync(path.join(MEDIA_DIR, journal, tmpHandle), { recursive: true, force: true });
      state.manuscriptTried[String(m.id)] = manuscriptName(m);
      continue;
    }
    if (migrated.has(handleize(title))) {
      console.log(`  – skip ${m.id} (already on the site: ${title})`);
      fs.rmSync(path.join(MEDIA_DIR, journal, tmpHandle), { recursive: true, force: true });
      state.seen.push(m.id);
      continue;
    }

    // The earlier import of this post (without its manuscript) is replaced.
    const prior = existing.find((p) => String(p.data.instagram_id || "") === String(m.id));
    const replaced = [];
    if (prior) {
      fs.rmSync(prior.file, { force: true });
      fs.rmSync(path.join(MEDIA_DIR, prior.journal, prior.handle), { recursive: true, force: true });
      replaced.push(prior.file, path.join(MEDIA_DIR, prior.journal, prior.handle));
    }
    // Move media to its final folder and point every src at it.
    const handle = uniqueHandle(journal, handleize(title) || `instagram-${m.id}`);
    const from = path.join(MEDIA_DIR, journal, tmpHandle);
    const to = path.join(MEDIA_DIR, journal, handle);
    fs.rmSync(to, { recursive: true, force: true });
    if (fs.existsSync(from)) fs.renameSync(from, to);
    const fix = (src) => src && src.replace(`/${tmpHandle}/`, `/${handle}/`);
    for (const s of [...saved, ...blocks.filter((b) => b.type === "media").map((b) => b.media)]) { s.src = fix(s.src); s.poster = fix(s.poster); }
    // Drop the image files of text slides: on the site they are live text.
    const used = new Set(blocks.filter((b) => b.type === "media").flatMap((b) => [b.media.src, b.media.poster]).filter(Boolean));
    for (const s of saved) for (const src of [s.src, s.poster]) if (src && !used.has(src)) fs.rmSync(siteFile(src), { force: true });

    const removeTags = ig.removeRoutingHashtags ? routing : new Set();
    const captionText = ig.includeCaption === false ? "" : captionHtml(body, removeTags);
    const cover = blocks.find((b) => b.type === "media" && b.media.type === "image")?.media.src
      || blocks.find((b) => b.type === "media")?.media.poster;
    const firstText = blocks.find((b) => b.type === "text")?.paragraphs.join(" ");
    // The page already shows the cover above the title: don't repeat it as the first picture
    // (its caption, if any, stays as a small note).
    const bodyBlocks = [...blocks];
    if (bodyBlocks[0]?.type === "media" && bodyBlocks[0].media.src === cover && !bodyBlocks[0].media.scale) {
      const first = bodyBlocks.shift();
      if (first.caption) bodyBlocks.unshift({ type: "text", paragraphs: [], notes: [first.caption] });
    }

    const file = writePost({
      journal,
      handle,
      data: {
        title,
        date: m.timestamp,
        author,
        issue,
        cover,
        excerpt: excerpt(firstText || captionText || title, 140),
        tags: hashtags.filter((t) => !removeTags.has(t)).map((t) => t.slice(1)),
        source: "instagram",
        instagram_id: String(m.id),
        instagram_permalink: m.permalink,
        needs_text: mode === "manual" ? true : undefined,
      },
      html: `${blocksHtml(bodyBlocks, m.permalink)}${captionText ? `\n<div class="ig-caption">\n${captionText}\n</div>` : ""}`,
    });
    state.seen.push(m.id);
    created++;
    // Built from the approved manuscript: published as soon as the post is up (unless set to review).
    if (mode === "manuscript") state.manuscript.push(String(m.id));
    if (mode === "manuscript" && (ig.manuscriptReview || "publish") === "publish") {
      published.push({ title, paths: [file, path.join(MEDIA_DIR, journal, handle), ...replaced] });
      console.log(`      → publishes now (approved manuscript)${warnings.length ? `; notes: ${warnings.join(" | ")}` : ""}`);
      continue;
    }
    titles.push(title);
    reports.push(reviewMarkdown({ title, journal, file, permalink: m.permalink, mode, blocks, rawBase, warnings }));
  }

  if (!DRY) writeState(state);
  const reportFile = process.env.SYNC_REPORT || path.join(os.tmpdir(), "instagram-sync-report.md");
  if (reports.length) fs.writeFileSync(reportFile, reports.join("\n\n---\n\n"));
  console.log(created ? `${DRY ? "Would create" : "Created"} ${created} article(s).` : "No new Instagram posts.");
  setOutput(!DRY && titles.length > 0, titles.length, titles, DRY ? [] : published);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message || e); setOutput(false, 0); process.exit(1); });
}
