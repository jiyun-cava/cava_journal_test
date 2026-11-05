import fs from "node:fs";
import path from "node:path";

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
  const bioG = grams(manuscript.bio || "");

  const out = [];
  let cursor = -1; // last manuscript block placed
  const emitUpTo = (idx) => {
    for (let k = cursor + 1; k <= idx; k++) {
      const b = version.blocks[k];
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
  emitUpTo(version.blocks.length - 1);

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

  if (manuscript.bio) out.push({ type: "bio", name: author, text: manuscript.bio });
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
    if (!/\.(md|txt)$/i.test(f) || /^readme/i.test(f)) continue;
    const base = path.join(dir, f.replace(/\.(md|txt)$/i, ""));
    const comments = fs.existsSync(`${base}.comments.json`) ? JSON.parse(fs.readFileSync(`${base}.comments.json`, "utf8")) : [];
    try {
      const m = parseManuscript(fs.readFileSync(path.join(dir, f), "utf8"), comments);
      out.push({ ...m, file: path.relative(process.cwd(), path.join(dir, f)) });
    } catch (e) {
      console.warn(`  ! manuscript ${f} couldn't be read: ${e.message}`);
    }
  }
  return out;
}

/** The manuscript whose title is the post's title (or appears in its caption). */
export function findManuscript(manuscripts, texts) {
  let best = null, bestS = 0;
  for (const m of manuscripts) {
    const tg = grams(m.title || "");
    if (tg.size < 3) continue;
    for (const t of texts) {
      const s = contained(tg, grams(t || ""));
      if (s > bestS) { best = m; bestS = s; }
    }
  }
  return bestS >= 0.85 ? best : null;
}
