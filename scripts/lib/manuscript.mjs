import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { parse as parseHtml } from "node-html-parser";
import { docxToManuscript } from "./docx.mjs";

// Build an article from the approved manuscript, using the Instagram carousel
// only for its pictures and their order.
//
// The manuscript gives the exact text (and, as comments on its images, the exact
// captions). Each slide is read only to find WHERE it sits in the manuscript, so
// misread words don't matter: a picture goes between the manuscript paragraphs
// that surround it on the carousel.

/* ---------------- manuscript text ---------------- */

const unescape = (s) => s.replace(/\\([!\[\]*_#().-])/g, "$1");

/**
 * Parse a manuscript exported as text/Markdown (Google Docs "read" output, .md or .txt).
 *   # 1안 / # 2안      → alternative versions (the one matching the post is used)
 *   # 필진 소개         → author bio
 *   **Title**          → title
 *   1.  Heading        → numbered subheading (all "1." in exports → renumbered)
 * Images carry their caption as a comment: <comment_start id=X>\[image\]<comment_end id=X>.
 *
 * @param {string} text
 * @param {{id: string, text: string}[]} comments
 */
export function parseManuscript(text, comments = []) {
  const byId = new Map(comments.map((c) => [c.id, c.text]));
  const sections = [];
  let bio = "";
  let current = null;
  const images = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    // Images and their captions (comments anchored on the image).
    const imgRe = /<comment_start id=([^>]+)>\\?\[image\\?\]<comment_end id=\1>/g;
    let m;
    while ((m = imgRe.exec(raw))) images.push({ caption: (byId.get(m[1]) || "").trim() });
    const line = unescape(raw.replace(imgRe, "").replace(/<comment_(start|end) id=[^>]+>/g, "").replace(/\[image\]/g, "")).trim();
    const head = line.match(/^#{1,3}\s+(.*)$/);
    if (head) {
      current = { name: head[1].trim(), title: "", blocks: [], bio: /필진|저자|author|bio|소개/i.test(head[1]) };
      sections.push(current);
      continue;
    }
    if (!line) continue;
    if (!current) { current = { name: "", title: "", blocks: [], bio: false }; sections.push(current); }
    if (current.bio) { bio = [bio, line].filter(Boolean).join(" "); continue; }
    const bold = line.match(/^\*\*(.+)\*\*$/);
    if (bold && !current.title && !current.blocks.length) { current.title = bold[1].trim(); continue; }
    if (bold) { current.blocks.push({ type: "p", text: bold[1].trim(), soft: false }); continue; }
    const num = line.match(/^(\d{1,2})[.)]\s+(.+)$/);
    if (num) { current.blocks.push({ type: "heading", n: Number(num[1]), text: num[2].trim() }); continue; }
    // A line ending in two spaces continues on the next line (soft line break).
    const prev = current.blocks[current.blocks.length - 1];
    if (prev && prev.type === "p" && prev.soft) { prev.text += " " + line; prev.soft = /\s{2,}$/.test(raw); continue; }
    current.blocks.push({ type: "p", text: line, soft: /\s{2,}$/.test(raw) });
  }
  const versions = sections.filter((s) => !s.bio && s.blocks.length);
  for (const v of versions) {
    // Docs exports number every list item "1."; number them in order.
    const heads = v.blocks.filter((b) => b.type === "heading");
    if (heads.length > 1 && heads.every((h) => h.n === heads[0].n)) heads.forEach((h, i) => { h.n = heads[0].n + i; });
    for (const b of v.blocks) { if (b.type === "heading") b.text = `${b.n}. ${b.text}`; delete b.n; delete b.soft; }
  }
  const title = versions.map((v) => v.title).find(Boolean) || "";
  return { title, versions, bio, images };
}

/* ---------------- fuzzy matching ---------------- */

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function grams(s) {
  const t = norm(s);
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  if (t.length === 1) g.add(t);
  return g;
}
/** Share of a's letter pairs that also occur in b (how much of an OCR line is in a paragraph). */
function contained(a, b) {
  if (!a.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / a.size;
}

const MATCH = 0.6;

/* ---------------- assembling ---------------- */

const inside = (l, b) => {
  const cy = (l.top + l.bottom) / 2, cx = (l.left + l.right) / 2;
  return cy >= b.top && cy <= b.top + b.height && cx >= b.left && cx <= b.left + b.width;
};

/**
 * @param {object} manuscript   result of parseManuscript
 * @param {{media: object, layout: object}[]} slides  carousel items in order;
 *        layout = slideLayout() result (null for videos)
 * @returns {{ title, author, blocks, warnings, cover }}
 *   blocks: {type:"heading", text} | {type:"text", paragraphs, notes:[]} |
 *           {type:"media", media, caption, alt, crop?} | {type:"bio", name, text}
 */
export function assemble(manuscript, slides) {
  const warnings = [];
  const knownAuthor = manuscript.author || "";
  const lineOk = (l) => l.conf >= 40 && norm(l.text).length >= 2;

  // 1) Which version of the manuscript is the post? The one most of the slide text is found in.
  const allLines = slides.flatMap((s) => (s.layout?.lines || []).filter(lineOk));
  const scored = manuscript.versions.map((v) => {
    const g = v.blocks.map((b) => grams(b.text));
    return { v, g, score: allLines.filter((l) => g.some((bg) => contained(grams(l.text), bg) >= MATCH)).length };
  }).sort((a, b) => b.score - a.score);
  if (!scored.length) throw new Error("The manuscript has no text.");
  const { v: version, g: blockGrams } = scored[0];
  if (manuscript.versions.length > 1) warnings.push(`The manuscript has ${manuscript.versions.length} versions; used "${version.name || "the first"}", which matches the slides.`);

  const captions = manuscript.images.map((im, i) => ({ i, text: im.caption, g: grams(im.caption), used: false })).filter((c) => c.text);
  const titleG = grams(manuscript.title || "");

  // 2) Which stretch of the manuscript the slides show. A Doc may also hold other
  //    versions, notes or the bio without headings: keep the run of paragraphs the
  //    slides follow in order, and take the bio from the author slide.
  const bestBlock = (l) => {
    const g = grams(l.text);
    let best = -1, bestS = 0;
    blockGrams.forEach((bg, k) => { const sc = contained(g, bg); if (sc > bestS) { best = k; bestS = sc; } });
    return bestS >= MATCH && norm(l.text).length >= 4 ? best : -1;
  };
  const seq = [];
  slides.forEach((s, si) => (s.layout?.lines || []).filter(lineOk).forEach((l) => {
    if (si === 0 && titleG.size && contained(grams(l.text), titleG) >= 0.7) return;
    const k = bestBlock(l);
    if (k >= 0) seq.push({ si, l, k });
  }));
  let bioText = manuscript.bio || "";
  let bioBlocks = new Set();
  if (!bioText && seq.length) {
    // The last slide with matched text, if it's a short "name + bio" slide after the article.
    const lastSi = seq[seq.length - 1].si;
    const here = seq.filter((x) => x.si === lastSi);
    const before = seq.filter((x) => x.si < lastSi).map((x) => x.k);
    const L = slides[lastSi].layout;
    const firstTop = Math.min(...here.map((x) => x.l.top));
    const nameAbove = L.lines.filter(lineOk).some((l) => l.top < firstTop && norm(l.text).length >= 2 && norm(l.text).length <= 12 && bestBlock(l) < 0);
    const ks = [...new Set(here.map((x) => x.k))];
    if (nameAbove && ks.length <= 2 && here.length <= 4 && !L.pictures.length && before.length && Math.min(...ks) > Math.max(...before)) {
      bioBlocks = new Set(ks);
      bioText = ks.sort((a, b) => a - b).map((k) => version.blocks[k].text).join(" ");
    }
  }
  // Longest run of matches in carousel order (outliers: lines also found in another version).
  const body = seq.filter((x) => !bioBlocks.has(x.k));
  const len = body.map(() => 1), prev = body.map(() => -1);
  for (let i = 0; i < body.length; i++) for (let j = 0; j < i; j++) {
    if (body[j].k <= body[i].k && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
  }
  let lo = 0, hi = version.blocks.length - 1;
  if (body.length) {
    let i = len.indexOf(Math.max(...len));
    const ks = [];
    for (; i >= 0; i = prev[i]) ks.push(body[i].k);
    lo = Math.min(...ks); hi = Math.max(...ks);
    if (lo <= 1) lo = 0; // the opening paragraphs are the article's even if a slide wasn't read
    const left = version.blocks.length - 1 - hi - [...bioBlocks].filter((k) => k > hi).length;
    if (left > 0) warnings.push(`${left} paragraph(s) at the end of the manuscript aren't on the slides and were left out (another version or notes?). Check the article ends where the post does.`);
    if (lo > 0) warnings.push(`${lo} paragraph(s) at the start of the manuscript aren't on the slides and were left out.`);
  }
  const bioG = grams(bioText);

  const out = [];
  let cursor = lo - 1; // last manuscript block placed
  const emitUpTo = (idx) => {
    for (let k = cursor + 1; k <= idx; k++) {
      const b = version.blocks[k];
      if (bioBlocks.has(k)) continue;
      if (b.type === "heading") out.push({ type: "heading", text: b.text });
      else {
        const prev = out[out.length - 1];
        if (prev && prev.type === "text") prev.paragraphs.push(b.text);
        else out.push({ type: "text", paragraphs: [b.text], notes: [] });
      }
    }
    cursor = Math.max(cursor, idx);
  };
  const bodyMatch = (l) => {
    const g = grams(l.text);
    let best = -1, bestS = 0;
    blockGrams.forEach((bg, k) => {
      if (k < lo || k > hi || bioBlocks.has(k)) return;
      const s = contained(g, bg) + (k > cursor ? 0.05 : 0); // prefer what comes next
      if (s > bestS) { best = k; bestS = s; }
    });
    return bestS >= MATCH ? best : -1;
  };
  const captionMatch = (text) => {
    const g = grams(text);
    let best = null, bestS = 0;
    for (const c of captions) { const s = contained(g, c.g); if (s > bestS) { best = c; bestS = s; } }
    return bestS >= MATCH ? best : null;
  };

  let author = "";
  let cover = null;
  const pictures = []; // media blocks in carousel order, for captions by order later
  let lastPicture = null;

  slides.forEach((slide, si) => {
    const L = slide.layout;
    if (!L) { // video
      const b = { type: "media", media: slide.media, caption: "", alt: "" };
      out.push(b); pictures.push(b); lastPicture = b;
      return;
    }
    const lines = L.lines.filter(lineOk);
    const isTitle = titleG.size && lines.some((l) => contained(grams(l.text), titleG) >= 0.7 && norm(l.text).length >= 3) && si === 0;
    const bodyLines = lines.map((l) => ({ l, k: bodyMatch(l) }));
    const hasBody = bodyLines.some((x) => x.k >= 0);
    const bioLine = bioG.size ? lines.findIndex((l) => contained(grams(l.text), bioG) >= MATCH && norm(l.text).length >= 6) : -1;

    if (bioLine >= 0 && !hasBody) {
      // Author slide: the short line above the bio is the name.
      const name = lines.slice(0, bioLine).reverse().find((l) => norm(l.text).length >= 2 && norm(l.text).length <= 12);
      if (name) author = name.text.trim();
      return;
    }
    if (isTitle) {
      // Title slide: kept whole as the cover; the name under the title is the author (until the bio slide says otherwise).
      const t = lines.findIndex((l) => contained(grams(l.text), titleG) >= 0.7);
      const name = lines.slice(t + 1).find((l) => contained(grams(l.text), titleG) < 0.5 && norm(l.text).length >= 2 && norm(l.text).length <= 12);
      if (name && !author) author = name.text.trim();
      const b = { type: "media", media: slide.media, caption: "", alt: manuscript.title, role: "title" };
      cover = b; out.push(b); pictures.push(b); lastPicture = b;
      return;
    }
    // Pictures on this slide: cut out of a text slide or a caption band; otherwise the whole slide.
    const pics = L.pictures.length && (hasBody || L.paper)
      ? L.pictures.map((p) => ({ box: { left: p.left, top: p.top, width: p.width, height: p.height }, pieces: p.pieces || [p] }))
      : [];
    const wholeSlide = !hasBody && !pics.length;
    const free = bodyLines.filter((x) => x.k < 0 && !pics.some((p) => p.pieces.some((b) => inside(x.l, b)))).map((x) => x.l);

    if (wholeSlide) {
      // A photo slide (any text on it is printed on the photo): its caption, if found, becomes the alt text.
      const c = captionMatch(lines.map((l) => l.text).join(" "));
      if (c) c.used = true;
      const b = { type: "media", media: slide.media, caption: "", alt: c ? c.text : "", baked: true };
      out.push(b); pictures.push(b); lastPicture = b;
      return;
    }

    // Walk the slide top to bottom.
    const items = [
      ...bodyLines.filter((x) => x.k >= 0).map((x) => ({ top: x.l.top, k: x.k })),
      ...pics.map((p) => ({ top: p.box.top, pic: p })),
    ].sort((a, b) => a.top - b.top);
    const blocksHere = [];
    for (const it of items) {
      if (it.pic) {
        const b = { type: "media", media: slide.media, crop: it.pic.box, caption: "", alt: "" };
        it.pic.block = b;
        out.push(b); pictures.push(b); blocksHere.push(b); lastPicture = b;
      } else if (it.k > cursor) emitUpTo(it.k);
    }
    // Lines not in the manuscript: captions of the pictures next to them, or a "←" note about the picture before.
    const groups = [];
    for (const l of free.sort((a, b) => a.top - b.top)) {
      const g = groups[groups.length - 1];
      if (g && l.top - g.bottom < (l.bottom - l.top) * 1.2) { g.lines.push(l); g.bottom = l.bottom; }
      else groups.push({ lines: [l], top: l.top, bottom: l.bottom });
    }
    for (const g of groups) {
      const text = g.lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
      if (norm(text).length < 4) continue;
      const c = captionMatch(text);
      const isNote = /^\s*(←|<|«|‹)/.test(text);
      let target = null;
      if (isNote) target = blocksHere.length && g.top > (blocksHere[0].crop?.top ?? 0) ? blocksHere[blocksHere.length - 1] : (pictures[pictures.length - blocksHere.length - 1] || null);
      else if (pics.length) {
        // nearest picture on this slide
        target = pics.map((p) => ({ p, d: Math.min(Math.abs(g.top - (p.box.top + p.box.height)), Math.abs(g.bottom - p.box.top), (g.top >= p.box.top && g.top <= p.box.top + p.box.height) ? 0 : Infinity) }))
          .sort((a, b) => a.d - b.d)[0].p.block;
      }
      if (target && !target.caption) {
        target.caption = c ? c.text : text.replace(/^\s*[←<«‹]\s*/, "");
        if (c) c.used = true;
        else target.captionFromSlide = true;
      } else if (!c && (text.match(/[가-힣A-Za-z]/g) || []).length >= 10 && !/[ㄱ-ㆎ]/.test(text)) {
        warnings.push(`Slide ${si + 1}: text not found in the manuscript was left out: "${text.slice(0, 80)}"`);
      }
    }
  });
  emitUpTo(hi);

  // Pictures whose caption couldn't be read: give them the manuscript's unused captions in order,
  // when the count between two placed captions matches.
  const placedIdx = (b) => captions.find((c) => c.used && c.text === (b.caption || b.alt))?.i;
  const runs = [];
  let run = [];
  let before = -1;
  for (const b of pictures) {
    const idx = placedIdx(b);
    if (idx !== undefined) { if (run.length) runs.push({ run, before, after: idx }); run = []; before = idx; }
    else if (b.role !== "title" && !b.caption && !b.alt) run.push(b);
  }
  if (run.length) runs.push({ run, before, after: Infinity });
  for (const { run, before, after } of runs) {
    const pool = captions.filter((c) => !c.used && c.i > before && c.i < after);
    if (!pool.length || pool.length < run.length) continue;
    run.forEach((b, j) => {
      const mine = j === run.length - 1 ? pool.slice(j) : [pool[j]];
      mine.forEach((c) => { c.used = true; });
      const text = mine.map((c) => c.text).join(" / ");
      if (b.baked) b.alt = text; else b.caption = text;
    });
    warnings.push(`Captions for ${run.length} picture(s) were placed by their order in the manuscript. Check they're on the right pictures.`);
  }
  for (const b of pictures) if (b.captionFromSlide) warnings.push(`A caption was read from the slide, not the manuscript ("${b.caption.slice(0, 50)}…"). Check its spelling.`);

  if (knownAuthor) author = knownAuthor; // the manuscript's folder name beats reading it off a slide
  if (bioText) out.push({ type: "bio", name: author, text: bioText });
  if (!author) warnings.push("The author's name wasn't found on the slides. Add it to the title and the bio.");
  const title = author ? `${author} — ${manuscript.title}` : manuscript.title;
  return { title, author, blocks: out, warnings, cover, version: version.name };
}

/* ---------------- manuscripts on file ---------------- */

/**
 * Manuscripts kept in a folder: <name>.md or <name>.txt, with the captions of
 * its images (comments) in <name>.comments.json when there are any.
 */
export function loadManuscripts(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!/\.(md|txt|html?|docx)$/i.test(f) || /^readme/i.test(f)) continue;
    const base = path.join(dir, f.replace(/\.(md|txt|html?|docx)$/i, ""));
    try {
      let text, comments;
      if (/\.docx$/i.test(f)) ({ text, comments } = docxToManuscript(fs.readFileSync(path.join(dir, f))));
      else {
        text = fs.readFileSync(path.join(dir, f), "utf8");
        comments = fs.existsSync(`${base}.comments.json`) ? JSON.parse(fs.readFileSync(`${base}.comments.json`, "utf8")) : [];
        if (/\.html?$/i.test(f)) ({ text, comments } = googleDocHtmlToManuscript(text));
      }
      const m = parseManuscript(text, comments);
      const meta = fs.existsSync(`${base}.json`) ? JSON.parse(fs.readFileSync(`${base}.json`, "utf8")) : {};
      if (meta.author) m.author = meta.author;
      if (meta.title && !m.title) m.title = meta.title;
      // "version": the Doc tab to use when the Doc holds several versions.
      if (meta.version) {
        const chosen = m.versions.filter((v) => v.name === meta.version);
        if (chosen.length) { m.versions = chosen; m.title = chosen[0].title || m.title; }
        else console.warn(`  ! manuscript ${f}: version "${meta.version}" not found; all versions kept`);
      }
      m.titles = [m.title, meta.title, meta.postTitle].filter(Boolean);
      // Changes when the manuscript (or its author/title) changes: the article is then rebuilt.
      m.hash = crypto.createHash("sha1").update(JSON.stringify([text, comments, meta.author || "", meta.postTitle || "", meta.version || ""])).digest("hex").slice(0, 12);
      out.push({ ...m, file: path.relative(process.cwd(), path.join(dir, f)) });
    } catch (e) {
      console.warn(`  ! manuscript ${f} couldn't be read: ${e.message}`);
    }
  }
  return out;
}

/** How well a manuscript title matches a post (0–1): the share of the title found in its title or caption. */
export function titleScore(title, texts) {
  const tg = grams(title || "");
  if (tg.size < 3) return 0;
  return Math.max(0, ...texts.map((t) => contained(tg, grams(t || ""))));
}

/** A folder name that is a person's name, not "10월", "2026" or "이미지". */
export function looksLikeName(s) {
  const t = (s || "").trim();
  return t.length >= 2 && t.length <= 15 && !/(\d+월|^\d{4}$|이미지|사진|원고|자료|manuscript|draft|images?|photos?)/i.test(t);
}

/** The manuscript whose title is the post's title (or appears in its caption). */
export function findManuscript(manuscripts, texts) {
  let best = null, bestS = 0;
  for (const m of manuscripts) {
    for (const title of m.titles || [m.title]) {
      const tg = grams(title || "");
      if (tg.size < 3) continue;
      for (const t of texts) {
        const s = contained(tg, grams(t || ""));
        if (s > bestS) { best = m; bestS = s; }
      }
    }
  }
  return bestS >= 0.85 ? best : null;
}

/* ---------------- Google Docs (HTML export) ---------------- */

const clean = (t) => t.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();

/**
 * A Google Doc exported as HTML → the text form parseManuscript reads, plus the
 * comments. Keeps headings, bold title lines, numbered lists, and which comment
 * is attached to which image (its caption).
 */
export function googleDocHtmlToManuscript(html) {
  const root = parseHtml(html, { comment: false });
  // Classes Google uses for bold text.
  const css = root.querySelectorAll("style").map((x) => x.text).join("\n");
  const bold = new Set();
  for (const m of css.matchAll(/\.([\w-]+)\{[^}]*font-weight:\s*(700|bold)[^}]*\}/g)) bold.add(m[1]);
  const isBold = (el) => (el.getAttribute?.("class") || "").split(/\s+/).some((c) => bold.has(c));

  // Comments: <a id="cmnt1">[a]</a> text… at the end of the document.
  const comments = [];
  for (const a of root.querySelectorAll('a[id^="cmnt"]')) {
    const id = a.getAttribute("id");
    if (!/^cmnt\d+$/.test(id)) continue;
    const box = a.closest("div") || a.parentNode;
    const paras = box.tagName?.toLowerCase() === "div" ? box.querySelectorAll("p") : [a.parentNode];
    const text = paras.map((p) => clean(p.text.replace(a.text, ""))).filter(Boolean).join("\n");
    comments.push({ id, text });
    box.remove();
  }

  const body = root.querySelector("body") || root;
  const lines = [];
  const walk = (el) => {
    for (const node of el.childNodes) {
      if (node.nodeType !== 1) continue;
      const tag = node.tagName?.toLowerCase();
      if (/^h[1-6]$/.test(tag)) { const t = clean(node.text.replace(/\[[a-z]{1,2}\]/g, "")); if (t) lines.push(`# ${t}`); continue; }
      if (tag === "ol" || tag === "ul") {
        const start = Number(node.getAttribute("start") || 1);
        node.querySelectorAll("li").forEach((li, i) => {
          const t = clean(li.text.replace(/\[[a-z]{1,2}\]/g, ""));
          if (t) lines.push(tag === "ol" ? `${start + i}.  ${t}` : t);
        });
        continue;
      }
      if (tag === "table") { node.querySelectorAll("p").forEach((p) => paragraph(p)); continue; }
      if (tag === "p") { paragraph(node); continue; }
      if (tag === "div") { walk(node); continue; }
    }
  };
  const paragraph = (p) => {
    // Images, each followed by the comment(s) attached to it.
    const imgs = p.querySelectorAll("img");
    const refs = p.querySelectorAll('a[id^="cmnt_ref"]').map((a) => a.getAttribute("href").replace("#", ""));
    if (imgs.length) {
      const text = clean(p.text.replace(/\[[a-z]{1,2}\]/g, ""));
      imgs.forEach((img, i) => {
        // Pair images and comments in order; extra images get none.
        const id = refs.length === imgs.length ? refs[i] : refs.length === 1 && i === imgs.length - 1 ? refs[0] : null;
        lines.push(id ? `<comment_start id=${id}>\\[image\\]<comment_end id=${id}>` : "\\[image\\]");
      });
      if (text) lines.push(text);
      return;
    }
    const spans = p.querySelectorAll("span").filter((sp) => clean(sp.text));
    const text = clean(p.text.replace(/\[[a-z]{1,2}\]/g, ""));
    if (!text) return;
    const allBold = spans.length && spans.every((sp) => isBold(sp));
    const isTitle = /\btitle\b/.test(p.getAttribute("class") || "");
    lines.push(allBold || isTitle ? `**${text}**` : text);
  };
  walk(body);
  return { text: lines.join("\n"), comments };
}
