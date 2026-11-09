import fs from "node:fs";
import { EleventyHtmlBasePlugin } from "@11ty/eleventy";
import { stripHtml, excerpt } from "./scripts/lib/util.mjs";

const config = JSON.parse(fs.readFileSync("./site.config.json", "utf8"));

// When the site is served from a sub-folder (e.g. user.github.io/repo/ before the
// custom domain is set), the deploy workflow passes SITE_URL and PATH_PREFIX.
if (process.env.SITE_URL) config.url = process.env.SITE_URL.replace(/\/$/, "");
const pathPrefix = "/" + (process.env.PATH_PREFIX || "").replace(/^\/+|\/+$/g, "");
const basePath = pathPrefix === "/" ? "" : pathPrefix;
const origin = new URL(config.url).origin;

/** Width and height of a local JPEG/PNG under src/ (read from its header), or null. */
const sizeCache = new Map();
function imageSize(url) {
  if (!url || /^https?:/.test(url)) return null;
  if (sizeCache.has(url)) return sizeCache.get(url);
  let out = null;
  try {
    const b = fs.readFileSync("./src" + decodeURI(url));
    if (b[0] === 0x89 && b[1] === 0x50) out = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    else if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1], len = b.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { out = { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }; break; }
        i += 2 + len;
      }
    }
  } catch {}
  sizeCache.set(url, out);
  return out;
}

export default function (eleventyConfig) {
  // Rewrites every root-relative href/src in the HTML output with the prefix.
  eleventyConfig.addPlugin(EleventyHtmlBasePlugin);
  eleventyConfig.addGlobalData("basePath", basePath);
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });
  eleventyConfig.addPassthroughCopy({ "src/media": "media" });
  eleventyConfig.addPassthroughCopy({ "src/static": "/" });

  eleventyConfig.addGlobalData("site", config);

  // Posts marked draft: true are built locally (npm start) but never published.
  const isProd = process.env.ELEVENTY_RUN_MODE === "build";
  const visible = (p) => !(isProd && p.data.draft);
  const byDateDesc = (a, b) => b.date - a.date;

  for (const j of config.journals) {
    eleventyConfig.addCollection(j.key, (api) =>
      api.getFilteredByGlob(`src/posts/${j.key}/*.md`).filter(visible).sort(byDateDesc)
    );
  }
  eleventyConfig.addCollection("allPosts", (api) =>
    api.getFilteredByGlob("src/posts/*/*.md").filter(visible).sort(byDateDesc)
  );

  const fmt = (opts) => (d) =>
    new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, ...opts }).format(new Date(d));
  eleventyConfig.addFilter("displayDate", fmt({ year: "numeric", month: "long", day: "2-digit" }));
  eleventyConfig.addFilter("isoDate", (d) => new Date(d).toISOString());
  eleventyConfig.addFilter("stripHtml", stripHtml);
  eleventyConfig.addFilter("excerpt", (html, len) => excerpt(html, len));
  eleventyConfig.addFilter("absUrl", (p) => (/^https?:/.test(p) ? p : origin + basePath + p));
  eleventyConfig.addFilter("withBase", (p) => (String(p).startsWith("/") ? basePath + p : p));
  eleventyConfig.addFilter("journalTitle", (key) => config.journals.find((j) => j.key === key)?.title || key);
  eleventyConfig.addFilter("json", (v) => JSON.stringify(v));
  eleventyConfig.addFilter("imageSize", (url) => imageSize(url) || { w: 4, h: 5 });
  eleventyConfig.addFilter("take", (arr, n) => (arr || []).slice(0, n));
  eleventyConfig.addFilter("prevNext", (list, url) => {
    const i = list.findIndex((p) => p.url === url);
    return { newer: i > 0 ? list[i - 1] : null, older: i >= 0 && i < list.length - 1 ? list[i + 1] : null };
  });

  return {
    pathPrefix,
    dir: { input: "src", includes: "_includes", data: "_data", output: "_site" },
    markdownTemplateEngine: false,
    htmlTemplateEngine: "njk",
    templateFormats: ["md", "njk", "html"],
  };
}
