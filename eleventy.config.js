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
