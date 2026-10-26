#!/usr/bin/env node
/**
 * One-time migration: copies every article from your Shopify blogs into
 * src/posts/<journal>/<handle>.md and downloads the images into src/media/.
 *
 * Two ways to read Shopify (it picks automatically):
 *   1. Admin API (best: includes drafts, tags, full-size cover images)
 *        SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
 *        SHOPIFY_ADMIN_TOKEN=shpat_...     (custom app with read_content scope)
 *   2. Public Atom feeds (no setup; published articles only)
 *        https://www.ca-va.life/blogs/<blog>.atom?page=N
 *
 * Usage:
 *   npm run import                      # import both blogs
 *   npm run import -- --blog cavajournal
 *   npm run import -- --limit 5         # try a few first
 *   npm run import -- --force           # overwrite posts that already exist
 *   npm run import -- --keep-remote-images   # don't download images
 *   npm run import -- --dry-run
 */
import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import {
  ROOT, MEDIA_DIR, POSTS_DIR, loadConfig, writePost, listPosts, saveImage, toSiteUrl, excerpt,
} from "./lib/util.mjs";

const cfg = loadConfig();
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const DRY = flag("dry-run");
const FORCE = flag("force");
const KEEP_REMOTE = flag("keep-remote-images");
const LIMIT = Number(opt("limit") || Infinity);
const BLOGS = opt("blog") ? [opt("blog")] : cfg.shopify.blogs;
const STORE = cfg.shopify.storeUrl.replace(/\/$/, "");
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, tries = 3) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers: { "user-agent": "cava-site-migrator/1.0", accept: "*/*" } });
    if (res.ok) return res.text();
    if (res.status === 404) return null;
    if (i >= tries) throw new Error(`HTTP ${res.status} for ${url}`);
    await sleep(1500 * i); // Shopify rate limits (429) — back off
  }
}

/* ------------------------------------------------------------------ */
/* Source 1: Admin GraphQL API                                         */
/* ------------------------------------------------------------------ */
async function fromAdminApi() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  const endpoint = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;
  const query = `query($cursor: String) {
    articles(first: 50, after: $cursor, sortKey: PUBLISHED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle title body summary publishedAt isPublished tags
        author { name }
        image { url altText }
        blog { handle }
      }
    }
  }`;
  const out = [];
  let cursor = null;
  do {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": token },
      body: JSON.stringify({ query, variables: { cursor } }),
    });
    const json = await res.json();
    if (json.errors) throw new Error("Shopify Admin API: " + JSON.stringify(json.errors));
    const page = json.data.articles;
    for (const a of page.nodes) {
      if (!BLOGS.includes(a.blog.handle)) continue;
      out.push({
        journal: a.blog.handle,
        handle: a.handle,
        title: a.title,
        date: a.publishedAt,
        html: a.body || "",
        summary: a.summary || "",
        cover: a.image?.url || null,
        tags: a.tags || [],
        draft: !a.isPublished,
      });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

/* ------------------------------------------------------------------ */
/* Source 2: public Atom feeds (+ article page for the cover image)    */
/* ------------------------------------------------------------------ */
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text" });
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v) => (typeof v === "object" && v !== null ? v["#text"] ?? "" : v ?? "");

export function parseAtom(feedXml, journal) {
  const doc = xml.parse(feedXml);
  return arr(doc.feed?.entry).map((e) => {
    const link = arr(e.link).find((l) => !l["@rel"] || l["@rel"] === "alternate")?.["@href"] || "";
    const handle = decodeURIComponent(link.split("?")[0].replace(/\/$/, "").split("/").pop() || "");
    const thumb = e["media:thumbnail"]?.["@url"] || null;
    return {
      journal,
      handle,
      link,
      title: String(txt(e.title)).trim(),
      date: txt(e.published) || txt(e.updated),
      html: String(txt(e.content) || ""),
      summary: String(txt(e.summary) || ""),
      cover: thumb,
      tags: arr(e.category).map((c) => c["@term"]).filter(Boolean),
      draft: false,
    };
  });
}

async function fromAtom() {
  const out = [];
  for (const blog of BLOGS) {
    const seen = new Set();
    for (let page = 1; page < 500; page++) {
      const feed = await getText(`${STORE}/blogs/${blog}.atom?page=${page}`);
      if (!feed) break;
      const entries = parseAtom(feed, blog).filter((e) => e.handle && !seen.has(e.handle));
      if (!entries.length) break;
      entries.forEach((e) => seen.add(e.handle));
      out.push(...entries);
      log(`  ${blog}: feed page ${page} → ${entries.length} articles`);
      if (out.length >= LIMIT) break;
    }
  }
  // Atom feeds don't carry the cover image; read it from each article page's og:image.
  for (const a of out.slice(0, LIMIT)) {
    if (a.cover) continue;
    const html = await getText(a.link || `${STORE}/blogs/${a.journal}/${encodeURIComponent(a.handle)}`);
    const m = html && html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i);
    if (m) a.cover = m[1].replace(/^http:/, "https:");
    await sleep(250);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */
function absolutize(src) {
  if (!src) return null;
  if (src.startsWith("//")) return "https:" + src;
  if (src.startsWith("/")) return STORE + src;
  return src;
}
/** Shopify CDN: drop the resize/version params so we get the original file. */
function originalUrl(src) {
  try {
    const u = new URL(absolutize(src));
    ["width", "height", "crop", "v"].forEach((k) => u.searchParams.delete(k));
    u.pathname = u.pathname.replace(/_(\d+x\d*|\d*x\d+|pico|icon|thumb|small|compact|medium|large|grande|original|master)(?=\.[a-z]+$)/i, "");
    return u.toString();
  } catch {
    return src;
  }
}
const isShopifyAsset = (src) => /(^\/\/|https?:\/\/)(cdn\.shopify\.com|[^/]*ca-va\.life\/cdn\/shop)|^\/cdn\/shop/i.test(src || "");

async function localizeImages(article) {
  const dir = path.join(MEDIA_DIR, article.journal, article.handle);
  let n = 0;
  const cache = new Map();
  const save = async (src) => {
    const url = originalUrl(src);
    if (cache.has(url)) return cache.get(url);
    const name = String(++n).padStart(2, "0");
    try {
      const { file } = await saveImage(url, path.join(dir, name));
      const local = toSiteUrl(file);
      cache.set(url, local);
      return local;
    } catch (e) {
      console.warn(`    ! image failed, keeping remote: ${url} (${e.message})`);
      cache.set(url, url);
      return url;
    }
  };

  if (article.cover) article.cover = await save(article.cover);

  const srcs = [...article.html.matchAll(/<img\b[^>]*?\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const src of new Set(srcs)) {
    if (!isShopifyAsset(src)) continue;
    const local = await save(src);
    article.html = article.html.split(src).join(local);
  }
}

function cleanHtml(html) {
  return html
    .replace(/\s(srcset|sizes|data-mce-[a-z-]+)=["'][^"']*["']/gi, "")
    .replace(/<img\b(?![^>]*\bloading=)/gi, '<img loading="lazy" decoding="async"')
    .replace(/<meta charset="utf-8">/gi, "")
    .replace(/<p>(\s|&nbsp;)*<\/p>/gi, "");
}

/* ------------------------------------------------------------------ */
async function main() {
  const useApi = process.env.SHOPIFY_ADMIN_TOKEN && process.env.SHOPIFY_STORE_DOMAIN;
  log(`Reading Shopify via ${useApi ? "Admin API" : "public Atom feeds"} — blogs: ${BLOGS.join(", ")}`);
  let articles = useApi ? await fromAdminApi() : await fromAtom();
  articles = articles.slice(0, LIMIT);
  log(`Found ${articles.length} articles.`);
  if (DRY) {
    articles.forEach((a) => log(`  [${a.journal}] ${a.date?.slice(0, 10)}  ${a.title}`));
    return;
  }

  // Brand logo for header/footer.
  if (cfg.shopify.logoUrl && !fs.existsSync(path.join(MEDIA_DIR, "brand/logo.png"))) {
    try {
      const { file } = await saveImage(cfg.shopify.logoUrl, path.join(MEDIA_DIR, "brand/logo"), { maxWidth: 600 });
      if (!file.endsWith("logo.png")) fs.renameSync(file, path.join(MEDIA_DIR, "brand/logo.png"));
      log("Saved logo → src/media/brand/logo.png");
    } catch (e) { console.warn("! logo download failed:", e.message); }
  }

  const existing = new Set(listPosts().map((p) => `${p.journal}/${p.handle}`));
  let written = 0, skipped = 0;
  for (const a of articles) {
    if (!FORCE && existing.has(`${a.journal}/${a.handle}`)) { skipped++; continue; }
    a.html = cleanHtml(a.html);
    if (!KEEP_REMOTE) await localizeImages(a);
    const author = a.title.includes(" — ") ? a.title.split(" — ")[0].trim() : undefined;
    writePost({
      journal: a.journal,
      handle: a.handle,
      data: {
        title: a.title,
        date: a.date,
        author,
        cover: a.cover ? (KEEP_REMOTE ? absolutize(a.cover) : a.cover) : undefined,
        excerpt: a.summary ? excerpt(a.summary, 140) : undefined,
        tags: a.tags?.length ? a.tags : undefined,
        draft: a.draft || undefined,
        source: "shopify",
      },
      html: a.html,
    });
    written++;
    log(`  ✓ [${a.journal}] ${a.title}`);
  }

  // Remove the placeholder posts once real content exists.
  if (written > 0) {
    for (const p of listPosts()) if (p.data.sample === true) fs.rmSync(p.file);
    fs.rmSync(path.join(MEDIA_DIR, "samples"), { recursive: true, force: true });
  }
  log(`\nDone: ${written} written, ${skipped} already existed${skipped ? " (use --force to overwrite)" : ""}.`);
  log(`Posts: ${path.relative(ROOT, POSTS_DIR)}/  Media: ${path.relative(ROOT, MEDIA_DIR)}/`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
