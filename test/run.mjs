// Offline tests: caption parsing, handles, Atom parsing, and a full Instagram
// sync against a mock API response (images served from a local server),
// run inside a throwaway copy of the project.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import sharp from "sharp";
import { handleize, ROOT } from "../scripts/lib/util.mjs";
import { parseCaption } from "../scripts/sync-instagram.mjs";
import { parseAtom, parseListing, parseArticlePage } from "../scripts/import-shopify.mjs";
import { slidesToBlocks, normalise, parseJsonReply, endsMidSentence } from "../scripts/lib/vision.mjs";

let passed = 0;
const t = (name, fn) => Promise.resolve(fn()).then(() => { passed++; console.log("  ✓", name); });

await t("handleize keeps Korean, matches Shopify style", () => {
  assert.equal(handleize("홍길동 — 어느 오후의 산책: 메모 몇 장"), "홍길동-어느-오후의-산책-메모-몇-장");
  assert.equal(handleize("  Hello, World!  "), "hello-world");
});

await t("caption: first line is title, hashtags collected", () => {
  const c = parseCaption("홍길동 — 어느 오후의 산책\n\n첫 단락입니다.\n둘째 줄.\n\n#nowjournal #산책");
  assert.equal(c.title, "홍길동 — 어느 오후의 산책");
  assert.equal(c.body, "첫 단락입니다.\n둘째 줄.");
  assert.deepEqual(c.hashtags, ["#nowjournal", "#산책"]);
});

await t("caption: long single paragraph is split at first sentence", () => {
  const c = parseCaption("이것은 제목 역할을 하는 첫 문장입니다. 그리고 나머지는 본문으로 들어가야 하는 꽤 긴 설명이 이어지는데, 이 문장은 아흔 자를 넘기도록 일부러 길게 썼습니다.");
  assert.equal(c.title, "이것은 제목 역할을 하는 첫 문장입니다");
  assert.ok(c.body.startsWith("그리고"));
});

await t("Atom feed parsing", () => {
  const feed = fs.readFileSync(path.join(ROOT, "test/fixtures/sample.atom"), "utf8");
  const entries = parseAtom(feed, "cavajournal");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].handle, "테스트-작가-첫-번째-테스트-글");
  assert.equal(entries[0].title, "테스트 작가 — 첫 번째 테스트 글");
  assert.ok(entries[0].html.includes("<p>"));
  assert.deepEqual(entries[1].tags, ["essay"]);
});

await t("listing pages: every article link with its date", () => {
  const items = parseListing(fs.readFileSync(path.join(ROOT, "test/fixtures/listing.html"), "utf8"), "cavajournal");
  assert.deepEqual(items.map((i) => i.handle), ["테스트-첫-글", "second-post"]);
  assert.equal(items[0].date, "2026-07-08T01:00:00Z");
  assert.equal(items[1].date, "2021-03-03T12:00:00+09:00");
});

await t("article page: title, cover and full body", () => {
  const a = parseArticlePage(fs.readFileSync(path.join(ROOT, "test/fixtures/article.html"), "utf8"));
  assert.equal(a.title, "테스트 — 첫 글");
  assert.equal(a.cover, "https://example-store.test/cdn/shop/articles/cover.jpg?v=1");
  assert.match(a.html, /^<p>첫 단락.<\/p><div><p>안쪽 div.<\/p><\/div><h6>/);
  assert.doesNotMatch(a.html, /share/);
});

await t("vision: reply parsing and normalising", () => {
  const r = normalise(parseJsonReply('Here: {"kind":"text","paragraphs":["  한 줄\n 두 줄 ",""],"note":"출처: 테스트","issue":"183"}'));
  assert.equal(r.kind, "text");
  assert.deepEqual(r.paragraphs, ["한 줄 두 줄"]);
  assert.equal(r.issue, 183);
  assert.equal(normalise({ kind: "text", paragraphs: [] }).kind, "image", "empty text slide kept as image");
  assert.equal(normalise({ kind: "weird" }).kind, "image");
});

await t("vision: slides become blocks; split sentences are joined", () => {
  assert.ok(endsMidSentence("다음 장으로 이어"));
  assert.ok(!endsMidSentence("끝난 문장입니다."));
  const img = (n) => ({ type: "image", src: `/m/${n}.jpg` });
  const blocks = slidesToBlocks([
    { media: img(1), analysis: normalise({ kind: "image" }) },
    { media: img(2), analysis: normalise({ kind: "title", title: "T", author: "A" }) },
    { media: img(3), analysis: normalise({ kind: "text", paragraphs: ["첫 단락입니다.", "둘째 단락은 다음 장으로 이어"] }) },
    { media: img(4), analysis: normalise({ kind: "text", paragraphs: ["집니다.", "셋째 단락."], note: "출처: 테스트" }) },
    { media: img(5), analysis: normalise({ kind: "image" }) },
  ]);
  assert.deepEqual(blocks.map((b) => b.type), ["media", "media", "text", "media"]);
  assert.deepEqual(blocks[2].paragraphs, ["첫 단락입니다.", "둘째 단락은 다음 장으로 이어 집니다.", "셋째 단락."]);
  assert.deepEqual(blocks[2].notes, ["출처: 테스트"]);
});

/* ---- full sync in a temp copy ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cava-test-"));
for (const p of ["site.config.json", "package.json", "eleventy.config.js", "scripts", "src"]) {
  fs.cpSync(path.join(ROOT, p), path.join(tmp, p), { recursive: true });
}
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tmp, "node_modules"));

const img = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#b9a58c" } }).jpeg().toBuffer();
const server = http.createServer((req, res) => {
  if (req.url.endsWith(".mp4")) { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(Buffer.alloc(2048)); }
  res.writeHead(200, { "content-type": "image/jpeg" }); res.end(img);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const mock = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/instagram-media.json"), "utf8").replaceAll("{{BASE}}", base));
const mockFile = path.join(tmp, "mock.json");
fs.writeFileSync(mockFile, JSON.stringify(mock));

// async: the mock image server lives in this process, so it must not be blocked
// a migrated Shopify article whose title matches an Instagram post
fs.writeFileSync(path.join(tmp, "src/posts/cavajournal/이미-있는-글.md"), '---\ntitle: "이미 있는 글"\ndate: "2026-10-01T00:00:00+09:00"\nsource: "shopify"\n---\n<div class="rte"><p>x</p></div>\n');

const run = async (...a) =>
  (await execFileAsync("node", ["scripts/sync-instagram.mjs", "--mock", mockFile, ...a], { cwd: tmp, encoding: "utf8" })).stdout;

await t("sync creates articles, routes by hashtag, skips old & #notjournal", async () => {
  const out = await run();
  console.log(out.trim().split("\n").map((l) => "      " + l).join("\n"));
  const more = fs.readdirSync(path.join(tmp, "src/posts/cavajournal"));
  const now = fs.readdirSync(path.join(tmp, "src/posts/nowjournal"));
  assert.ok(more.includes("홍길동-어느-오후의-산책.md"), "carousel post in MORE");
  assert.ok(now.includes("이번-주-작업실-풍경.md"), "#nowjournal post routed to NOW");
  assert.ok(!more.concat(now).some((f) => f.includes("비공개")), "#notjournal skipped");
  assert.ok(!more.concat(now).some((f) => f.includes("오래된")), "post before importAfter skipped");
  assert.ok(!more.includes("이미-있는-글-2.md"), "post already migrated from Shopify skipped");
  assert.match(out, /already on the site/);
  const md = fs.readFileSync(path.join(tmp, "src/posts/cavajournal/홍길동-어느-오후의-산책.md"), "utf8");
  assert.match(md, /instagram_id: "1800000000000001"/);
  assert.match(md, /class="mention" href="https:\/\/www.instagram.com\/someone\/"/);
  // No ANTHROPIC_API_KEY → fallback: first image + "text needed" for an editor
  assert.equal((md.match(/<figure>/g) || []).length, 1, "only the first image");
  assert.match(md, /needs_text: true/);
  assert.match(md, /본문 준비 중/);
  assert.ok(fs.existsSync(path.join(tmp, "src/media/cavajournal/홍길동-어느-오후의-산책/01.jpg")));
  assert.ok(!fs.existsSync(path.join(tmp, "src/media/cavajournal/홍길동-어느-오후의-산책/02.jpg")), "unused slides not kept");
  assert.ok(!fs.readdirSync(path.join(tmp, "src/media/cavajournal")).some((d) => d.startsWith("_incoming")), "temp folders cleaned");
  const state = JSON.parse(fs.readFileSync(path.join(tmp, "instagram-state.json"), "utf8"));
  assert.ok(state.seen.includes("1800000000000001"));
  const vid = fs.readFileSync(path.join(tmp, "src/posts/nowjournal/이번-주-작업실-풍경.md"), "utf8");
  assert.match(vid, /<video controls/);
  assert.doesNotMatch(vid, /#nowjournal/, "routing hashtag removed from body");
});

await t("second run is idempotent", async () => {
  assert.match(await run(), /No new Instagram posts/);
});

await t("vision: text slides become live text, title from the title slide", async () => {
  const vmock = path.join(tmp, "mock-vision-post.json");
  fs.writeFileSync(vmock, JSON.stringify({ data: [{
    id: "1800000000000007", caption: "캡션 첫 줄\n\n캡션 본문 #morejournal", media_type: "CAROUSEL_ALBUM",
    permalink: "https://www.instagram.com/p/TEST7/", timestamp: "2026-10-30T09:00:00+0000",
    children: { data: ["v1", "v2", "v3", "v4", "v5"].map((id) => ({ id, media_type: "IMAGE", media_url: `${base}/i/${id}.jpg` })) },
  }] }));
  const analyses = path.join(tmp, "mock-vision.json");
  fs.writeFileSync(analyses, JSON.stringify({
    v1: { kind: "image", issue: 183 },
    v2: { kind: "title", title: "서울의 습관", author: "김테스트" },
    v3: { kind: "text", paragraphs: ["첫 단락입니다.", "둘째 단락은 다음 장으로 이어"] },
    v4: { kind: "text", paragraphs: ["집니다."], note: "출처: 테스트 라이브러리" },
    v5: { kind: "image" },
  }));
  const report = path.join(tmp, "report.md");
  const out = (await execFileAsync("node", ["scripts/sync-instagram.mjs", "--mock", vmock, "--mock-vision", analyses],
    { cwd: tmp, encoding: "utf8", env: { ...process.env, SYNC_REPORT: report, REVIEW_RAW_BASE: "https://raw.example/b" } })).stdout;
  console.log(out.trim().split("\n").map((l) => "      " + l).join("\n"));
  const f = path.join(tmp, "src/posts/cavajournal/김테스트-서울의-습관.md");
  assert.ok(fs.existsSync(f), "handle from title slide");
  const md = fs.readFileSync(f, "utf8");
  assert.match(md, /title: "김테스트 — 서울의 습관"/);
  assert.match(md, /issue: 183/);
  assert.match(md, /<p>둘째 단락은 다음 장으로 이어 집니다.<\/p>/);
  assert.match(md, /slide-note">출처: 테스트 라이브러리/);
  assert.equal((md.match(/<figure>/g) || []).length, 3, "cover, title slide, last image");
  const dir = path.join(tmp, "src/media/cavajournal/김테스트-서울의-습관");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["01.jpg", "02.jpg", "05.jpg"], "text-slide images dropped");
  const bodyHtml = md.slice(md.indexOf("<div class=\"rte\">"));
  const order = ["01.jpg", "02.jpg", "첫 단락", "05.jpg"].map((s) => bodyHtml.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "carousel order kept");
  const rep = fs.readFileSync(report, "utf8");
  assert.match(rep, /### 김테스트 — 서울의 습관/);
  assert.match(rep, /https:\/\/raw.example\/b\/src\/media\/cavajournal\/김테스트-서울의-습관\/01.jpg/);
});

await t("site builds with synced posts", () => {
  execFileSync("npx", ["@11ty/eleventy", "--quiet"], { cwd: tmp, env: { ...process.env, ELEVENTY_RUN_MODE: "build" } });
  const page = fs.readFileSync(path.join(tmp, "_site/blogs/cavajournal/홍길동-어느-오후의-산책/index.html"), "utf8");
  assert.match(page, /Originally posted on <a href="https:\/\/www.instagram.com\/p\/TEST1\/"/);
  assert.ok(fs.existsSync(path.join(tmp, "_site/blogs/nowjournal/index.html")));
  const idx = JSON.parse(fs.readFileSync(path.join(tmp, "_site/search-index.json"), "utf8"));
  assert.ok(idx.some((p) => p.t.includes("홍길동")));
  const v = fs.readFileSync(path.join(tmp, "_site/blogs/cavajournal/김테스트-서울의-습관/index.html"), "utf8");
  assert.match(v, /<div class="slide-text">/);
});

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
