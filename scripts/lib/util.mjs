// Shared helpers for the build and the import/sync scripts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const POSTS_DIR = path.join(ROOT, "src/posts");
export const MEDIA_DIR = path.join(ROOT, "src/media");

export function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "site.config.json"), "utf8"));
}

/**
 * Shopify-style handle: keeps Korean (and any other) letters and digits,
 * turns everything else into single hyphens.
 * "케이티 — 나는 바젤도 처음이고" -> "케이티-나는-바젤도-처음이고"
 */
export function handleize(str, maxLen = 120) {
  const h = String(str)
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (h.length <= maxLen) return h;
  return h.slice(0, maxLen).replace(/-[^-]*$/, "") || h.slice(0, maxLen);
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function stripHtml(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|figure|figcaption)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function excerpt(text, len = 140) {
  const t = stripHtml(text);
  return t.length > len ? t.slice(0, len).trimEnd() + "…" : t;
}

/** YAML-safe scalar (JSON strings are valid YAML). */
const y = (v) => JSON.stringify(v);

/**
 * Write a post as Markdown with front matter. The body is raw HTML kept as a
 * single HTML block (no blank lines), so Markdown never rewrites it.
 */
export function writePost({ journal, handle, data, html }) {
  const dir = path.join(POSTS_DIR, journal);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${handle}.md`);
  const fm = Object.entries({ handle, ...data })
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${Array.isArray(v) || typeof v === "object" ? JSON.stringify(v) : y(v)}`)
    .join("\n");
  const body = String(html || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimStart())
    .filter((l) => l.trim() !== "")
    .join("\n");
  fs.writeFileSync(file, `---\n${fm}\n---\n<div class="rte">\n${body}\n</div>\n`);
  return file;
}

/** Read every post's front matter (cheap parser: our files are written by writePost). */
export function listPosts() {
  const out = [];
  if (!fs.existsSync(POSTS_DIR)) return out;
  for (const journal of fs.readdirSync(POSTS_DIR)) {
    const dir = path.join(POSTS_DIR, journal);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      const m = text.match(/^---\n([\s\S]*?)\n---/);
      const data = {};
      if (m) {
        for (const line of m[1].split("\n")) {
          const i = line.indexOf(":");
          if (i < 0) continue;
          const k = line.slice(0, i).trim();
          const raw = line.slice(i + 1).trim();
          try { data[k] = JSON.parse(raw); } catch { data[k] = raw; }
        }
      }
      out.push({ journal, file: path.join(dir, f), handle: f.replace(/\.md$/, ""), data });
    }
  }
  return out;
}

/** Pick a handle that doesn't collide with an existing post in that journal. */
export function uniqueHandle(journal, base) {
  const taken = new Set(listPosts().filter((p) => p.journal === journal).map((p) => p.handle));
  let h = base || "post";
  let n = 2;
  while (taken.has(h)) h = `${base}-${n++}`;
  return h;
}

/** Download a URL to disk (skips if it already exists). Returns true on success. */
export async function download(url, dest, { maxBytes = Infinity } = {}) {
  if (fs.existsSync(dest)) return true;
  const res = await fetch(url, { headers: { "user-agent": "cava-site-migrator/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > maxBytes) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return true;
}

/**
 * Save an image, downscaled to maxWidth and re-encoded, to keep the repo small.
 * Falls back to the original bytes if sharp can't read it (e.g. GIF animations).
 */
export async function saveImage(url, destNoExt, { maxWidth = 2000, quality = 82 } = {}) {
  const res = await fetch(url, { headers: { "user-agent": "cava-site-migrator/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destNoExt), { recursive: true });
  const urlExt = (new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i) || [, "jpg"])[1].toLowerCase();
  try {
    const { default: sharp } = await import("sharp");
    const img = sharp(buf, { animated: urlExt === "gif" });
    const meta = await img.metadata();
    if (urlExt === "gif" && (meta.pages || 1) > 1) throw new Error("animated");
    const hasAlpha = meta.hasAlpha && urlExt === "png";
    const ext = hasAlpha ? "png" : "jpg";
    let pipeline = img.rotate();
    if ((meta.width || 0) > maxWidth) pipeline = pipeline.resize({ width: maxWidth });
    pipeline = hasAlpha ? pipeline.png({ compressionLevel: 9 }) : pipeline.jpeg({ quality, mozjpeg: true });
    const out = `${destNoExt}.${ext}`;
    await pipeline.toFile(out);
    return { file: out, width: Math.min(meta.width || 0, maxWidth) || undefined };
  } catch {
    const out = `${destNoExt}.${urlExt === "jpeg" ? "jpg" : urlExt}`;
    fs.writeFileSync(out, buf);
    return { file: out };
  }
}

/** Turn an absolute path inside src/ into a site URL. */
export function toSiteUrl(absPath) {
  return "/" + path.relative(path.join(ROOT, "src"), absPath).split(path.sep).join("/");
}
