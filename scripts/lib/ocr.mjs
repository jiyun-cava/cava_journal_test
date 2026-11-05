// Free slide reader: Tesseract OCR (Korean + English), no API key or payment.
//
// Same output shape as vision.mjs:
//   { kind: "text" | "image", paragraphs: [string], note, title: "", author: "", issue }
//
// A slide counts as a TEXT slide when most of it is plain background AND it
// carries a real amount of readable text. Photos, artwork, posters (even with an
// overlaid headline), the title/signature slide and "zoom out" portraits on white
// all stay images.
//
// Needs the `tesseract` command with the `kor` language data (TESSDATA_PREFIX).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);

const RULES = {
  minBackground: 0.55, // share of the slide that is one flat colour
  minChars: 40,        // letters needed to call it a text slide
  minConfidence: 60,   // average OCR confidence (0–100)
  dropLineBelow: 35,   // lines read with less confidence than this are treated as noise
};

const NOTE_RE = /^\s*(←|<|«|‹|출처|사진|자료|Photo|Image|Source|Courtesy)/i;
const FURNITURE_RE = /(CAVA\s*journal|^\s*\d{1,4}\s*$|^\s*\d{8}\s*$)/i;

let available;
/** True when tesseract and the Korean model are installed. */
export function ocrAvailable() {
  if (available !== undefined) return available;
  try {
    const langs = execFileSync("tesseract", ["--list-langs"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    available = /\bkor\b/.test(langs);
  } catch {
    available = false;
  }
  return available;
}

/** The slide's most common colour and the share of pixels close to it. */
export async function backgroundInfo(file) {
  const { data, info } = await sharp(file).resize(60, 75, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const counts = new Map();
  const px = info.width * info.height;
  for (let i = 0; i < px; i++) {
    const key = ((data[i * 3] >> 4) << 8) | ((data[i * 3 + 1] >> 4) << 4) | (data[i * 3 + 2] >> 4);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  // Exact colour: average of the pixels in the most common bucket.
  const sum = [0, 0, 0];
  for (let i = 0; i < px; i++) {
    const key = ((data[i * 3] >> 4) << 8) | ((data[i * 3 + 1] >> 4) << 4) | (data[i * 3 + 2] >> 4);
    if (key === top[0]) for (let c = 0; c < 3; c++) sum[c] += data[i * 3 + c];
  }
  const color = sum.map((v) => Math.round(v / top[1]));
  let near = 0;
  for (let i = 0; i < px; i++) {
    const d = Math.abs(data[i * 3] - color[0]) + Math.abs(data[i * 3 + 1] - color[1]) + Math.abs(data[i * 3 + 2] - color[2]);
    if (d < 48) near++;
  }
  return { share: near / px, color };
}

/** Share of pixels close to the slide's most common colour. */
export async function backgroundShare(file) {
  return (await backgroundInfo(file)).share;
}

const HANGUL = /[가-힣]/;
const LATIN2 = /[A-Za-z].*[A-Za-z]/;

/** Tesseract TSV → words with their boxes. */
export function tsvWords(tsv) {
  return tsv.trim().split("\n").slice(1).map((l) => l.split("\t"))
    .filter((c) => c.length >= 12 && c[0] === "5" && c.slice(11).join("\t").trim())
    .map((c) => ({
      key: `${c[2]}-${c[3]}-${c[4]}`, // block-paragraph-line
      left: Number(c[6]), top: Number(c[7]), width: Number(c[8]), height: Number(c[9]),
      conf: Number(c[10]), text: c.slice(11).join("\t").trim(),
    }));
}

const overlap = (a, b) => {
  const x = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const y = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return x > 0 && y > 0 ? (x * y) / Math.min(a.width * a.height, b.width * b.height) : 0;
};

/**
 * The Korean model reads Korean best but turns English into digits and symbols;
 * the Korean+English model reads English but swaps some Korean words for Latin
 * letters. Keep the Korean reading, and only where it found no Korean at all
 * take the English the other reading found in the same spot.
 */
export function fixEnglish(korWords, mixWords) {
  const used = new Set();
  for (const w of korWords) {
    if (HANGUL.test(w.text)) continue;
    const hits = mixWords.filter((m) => !HANGUL.test(m.text) && overlap(w, m) > 0.5);
    if (!hits.some((m) => LATIN2.test(m.text))) continue;
    const fresh = hits.filter((m) => !used.has(m));
    fresh.forEach((m) => used.add(m));
    w.english = fresh.map((m) => m.text).join(" ");
    w.englishConf = fresh.length ? Math.max(...fresh.map((m) => m.conf)) : 100;
  }
  return korWords;
}

/**
 * Tesseract TSV → lines in reading order, each with its text, position and confidence.
 */
export function tsvToLines(tsv) {
  return wordsToLines(tsvWords(tsv));
}

/** Average confidence, weighted by the length of each word. */
const weighted = (pairs) => {
  const n = pairs.reduce((a, [, k]) => a + k, 0);
  return n ? pairs.reduce((a, [c, k]) => a + c * k, 0) / n : 0;
};

export function wordsToLines(words) {
  const lines = new Map();
  for (const w of words) {
    const l = lines.get(w.key) || { words: [], top: w.top, bottom: w.top + w.height, left: w.left, right: w.left + w.width, confs: [] };
    l.words.push(w);
    l.top = Math.min(l.top, w.top);
    l.bottom = Math.max(l.bottom, w.top + w.height);
    l.left = Math.min(l.left, w.left);
    l.right = Math.max(l.right, w.left + w.width);
    if (w.text) l.confs.push([w.conf, w.text.length]);
    lines.set(w.key, l);
  }
  return [...lines.values()]
    .map((l) => ({
      text: l.words.map((w) => w.text).filter(Boolean).join(" "), top: l.top, bottom: l.bottom, left: l.left, right: l.right,
      conf: weighted(l.confs), n: l.confs.reduce((a, [, n]) => a + n, 0), words: l.words,
    }))
    .filter((l) => l.text)
    .sort((a, b) => a.top - b.top);
}

/**
 * Picture areas on a slide: everything that differs from the background and
 * isn't confidently-read text, grouped into blocks big enough to be a photo,
 * book cover or screenshot. Returned in the slide's own pixels.
 */
export async function findPictures(file, words, bg) {
  const meta = await sharp(file).metadata();
  const W = meta.width, H = meta.height;
  const S = 4; // work at 1/4 size
  const w = Math.max(1, Math.round(W / S)), h = Math.max(1, Math.round(H / S));
  // Ink = clearly different from the background, measured at full size so thin
  // edges (a white book cover's outline) count; a 4×4 block is ink if any pixel is.
  const { data } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    if (d > 18) ink[Math.min(h - 1, Math.floor(y / S)) * w + Math.min(w - 1, Math.floor(x / S))] = 1;
  }
  // Where text was read confidently (to tell a paragraph from a picture).
  const text = new Uint8Array(w * h);
  for (const t of words) {
    if (t.conf < 60 || t.height > H * 0.08 || !/[\p{L}\p{N}]/u.test(t.text)) continue;
    const x0 = Math.max(0, Math.floor(t.left / S)), x1 = Math.min(w - 1, Math.ceil((t.left + t.width) / S));
    const y0 = Math.max(0, Math.floor(t.top / S)), y1 = Math.min(h - 1, Math.ceil((t.top + t.height) / S));
    for (let y = y0; y <= y1; y++) text.fill(1, y * w + x0, y * w + x1 + 1);
  }
  // Join nearby ink (2px here = 8px on the slide), then find connected blocks.
  const R = 2;
  const grown = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!ink[y * w + x]) continue;
    for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) grown.fill(1, yy * w + Math.max(0, x - R), yy * w + Math.min(w - 1, x + R) + 1);
  }
  const seen = new Uint8Array(w * h);
  let boxes = [];
  for (let i = 0; i < w * h; i++) {
    if (!grown[i] || seen[i]) continue;
    let x0 = w, x1 = 0, y0 = h, y1 = 0, n = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      const x = j % w, y = (j - x) / w;
      if (ink[j]) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= w * h || seen[k] || !grown[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === w - 1)) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    if (!n) continue;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    let covered = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) covered += text[y * w + x];
    const isText = covered > 0.3 * bw * bh; // a block of readable lines, not a picture
    if (!isText && bw >= w * 0.12 && bh >= h * 0.06 && bw * bh >= w * h * 0.015) {
      const b = { left: x0, top: y0, right: x1 + 1, bottom: y1 + 1 };
      boxes.push({ ...b, pieces: [b] });
    }
  }
  // Pictures side by side (or overlapping) become one picture.
  boxes.sort((a, b) => a.top - b.top);
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const A = boxes[a], B = boxes[b];
      const v = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
      if (v > 0.3 * Math.min(A.bottom - A.top, B.bottom - B.top)) {
        boxes[a] = { left: Math.min(A.left, B.left), top: Math.min(A.top, B.top), right: Math.max(A.right, B.right), bottom: Math.max(A.bottom, B.bottom), pieces: [...A.pieces, ...B.pieces] };
        boxes.splice(b, 1);
        merged = true;
        break outer;
      }
    }
  }
  const px = (b) => {
    const left = Math.max(0, b.left * S - 2), top = Math.max(0, b.top * S - 2);
    return { left, top, width: Math.min(W, b.right * S + 2) - left, height: Math.min(H, b.bottom * S + 2) - top };
  };
  return boxes.map((b) => ({ ...px(b), pieces: b.pieces.map(px) }));
}

/**
 * Lines → paragraphs. A gap clearly larger than the usual line spacing starts
 * a new paragraph; source lines become notes; page furniture is dropped.
 */
/** Join pieces Tesseract split off the same visual row (they overlap vertically). */
export function mergeRows(lines) {
  const rows = [];
  for (const l of [...lines].sort((a, b) => a.top - b.top)) {
    const prev = rows[rows.length - 1];
    const overlap = prev ? Math.min(prev.bottom, l.bottom) - Math.max(prev.top, l.top) : 0;
    if (prev && overlap > 0.5 * Math.min(prev.bottom - prev.top, l.bottom - l.top)) {
      prev.text += " " + l.text;
      prev.top = Math.min(prev.top, l.top);
      prev.bottom = Math.max(prev.bottom, l.bottom);
      prev.left = Math.min(prev.left ?? l.left, l.left);
      prev.right = Math.max(prev.right ?? l.right, l.right);
      prev.conf = weighted([[prev.conf, prev.n || prev.text.length], [l.conf, l.n || l.text.length]]);
      prev.n = (prev.n || prev.text.length) + (l.n || l.text.length);
    } else {
      rows.push({ ...l });
    }
  }
  return rows;
}

// Signs of a misread: low confidence, stray single consonants/vowels, Latin
// fragments wedged between Korean words.
const SHAKY_RE = /[ㄱ-ㆎ]{2,}|[가-힣]\s+[A-Za-z]{1,3}[,.]?\s+[가-힣A-Za-z]/;

export function linesToParagraphs(rawLines, pictures = []) {
  const lines = mergeRows(rawLines);
  const inside = (l, b) => {
    const cy = (l.top + l.bottom) / 2, cx = l.left === undefined ? b.left + 1 : (l.left + l.right) / 2;
    return cy >= b.top && cy <= b.top + b.height && cx >= b.left && cx <= b.left + b.width;
  };
  const inPicture = (l) => pictures.some((p) => (p.pieces || [p]).some((b) => inside(l, b)));
  // A line level with a picture but not on it (beside it) is that picture's caption.
  const besidePicture = (l) => pictures.find((p) => {
    const cy = (l.top + l.bottom) / 2;
    return cy >= p.top && cy <= p.top + p.height;
  });
  const body = [];
  let issue = null;
  for (const l of lines) {
    const m = l.text.match(/(\d{1,4})\s*CAVA\s*journal/i);
    if (m) issue = Number(m[1]);
    if (l.conf < RULES.dropLineBelow) continue;
    if (FURNITURE_RE.test(l.text)) continue;
    if ((l.text.match(/[\p{L}\p{N}]/gu) || []).length < 2) continue; // stray marks
    if (inPicture(l)) continue; // text printed on a photo or book cover
    body.push(l);
  }
  const heights = body.map((l) => l.bottom - l.top).sort((a, b) => a - b);
  const lineH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;

  // Walk down the slide: text lines and pictures in reading order.
  const pics = pictures.map((p) => ({ kind: "image", box: { left: p.left, top: p.top, width: p.width, height: p.height }, caption: "", captionBottom: p.top + p.height, src: p }));
  const items = [
    ...body.map((l) => ({ line: l, top: l.top })),
    ...pics.map((p) => ({ picture: p, top: p.box.top })),
  ].sort((a, b) => a.top - b.top);
  const parts = [];
  let lastPic = null;   // picture whose caption may follow
  for (const it of items) {
    if (it.picture) {
      lastPic = it.picture;
      parts.push(lastPic);
      continue;
    }
    const l = it.line;
    const beside = besidePicture(l);
    if (beside && inside(l, beside)) continue; // already part of the cut-out
    if (beside) {
      const pic = pics.find((p) => p.src === beside);
      pic.caption = (pic.caption + " " + l.text).trim();
      continue;
    }
    // Smaller lines right under a picture are its caption.
    if (lastPic && l.top - lastPic.captionBottom < 2.5 * lineH && l.bottom - l.top < 0.85 * lineH) {
      lastPic.caption = (lastPic.caption + " " + l.text).trim();
      lastPic.captionBottom = l.bottom;
      continue;
    }
    lastPic = null;
    const prev = parts[parts.length - 1];
    if (prev && prev.kind === "text") prev.lines.push(l);
    else parts.push({ kind: "text", lines: [l] });
  }
  // Spacing is measured between line centres: steadier than tops or bottoms when a line has tall syllables.
  const mid = (l) => (l.top + l.bottom) / 2;
  const steps = parts.filter((p) => p.kind === "text")
    .flatMap((p) => p.lines.slice(1).map((l, i) => mid(l) - mid(p.lines[i])))
    .filter((g) => g > 0).sort((a, b) => a - b);
  // Typical line spacing: lower quartile of the gaps (paragraph breaks are the large outliers).
  const usual = steps.length ? steps[Math.floor((steps.length - 1) / 4)] : 0;
  const allNotes = [];
  for (const p of parts) {
    if (p.kind !== "text") { delete p.captionBottom; delete p.src; continue; }
    const paragraphs = [];
    const notes = [];
    let prevLine = null;
    // Paragraphs without a blank line between them: a sentence that ends well short of the right margin.
    const sized = p.lines.filter((l) => l.right !== undefined && l.text.length > 3);
    const maxRight = sized.length ? Math.max(...sized.map((l) => l.right)) : 0;
    const charW = sized.length ? sized.map((l) => (l.right - l.left) / l.text.replace(/\s/g, "").length).sort((a, b) => a - b)[Math.floor(sized.length / 2)] : 0;
    const endsShort = (l) => charW && l.right !== undefined && /[.?!。」』"”’)]\s*$/.test(l.text) && maxRight - l.right > 4 * charW;
    for (const l of p.lines) {
      if (NOTE_RE.test(l.text)) { notes.push(l.text.replace(/^\s*[<«‹]\s*/, "← ")); continue; }
      const gap = prevLine ? mid(l) - mid(prevLine) : 0;
      if (!prevLine || (usual && gap > usual * 1.5) || endsShort(prevLine)) paragraphs.push(l.text);
      else paragraphs[paragraphs.length - 1] += " " + l.text;
      prevLine = l;
    }
    p.paragraphs = paragraphs.map((x) => x.replace(/\s+/g, " ").trim());
    p.note = notes.join(" / ");
    allNotes.push(...notes);
    delete p.lines;
  }
  const paragraphs = parts.filter((p) => p.kind === "text").flatMap((p) => p.paragraphs);
  const chars = (paragraphs.join("").match(/[\p{L}\p{N}]/gu) || []).length;
  const conf = body.length ? body.reduce((a, l) => a + l.conf, 0) / body.length : 0;
  const shaky = body.some((l) => l.conf < 75 || SHAKY_RE.test(l.text));
  return { paragraphs, notes: allNotes, parts: parts.filter((p) => p.kind === "image" || p.paragraphs.length || p.note), issue, chars, conf, shaky };
}

/**
 * Tesseract's word boxes split Korean at odd places, but its plain-text output
 * keeps the real spacing. Take each line's text from the plain output and its
 * position/confidence from the TSV, matched in reading order.
 */
export function mergeText(lines, txt) {
  const textLines = txt.split("\n").map((l) => l.trim()).filter(Boolean);
  if (textLines.length !== lines.length) {
    // Couldn't match line for line: drop the spaces Tesseract put inside Korean words.
    return lines.map((l) => ({ ...l, text: l.text.replace(/(?<=[가-힣]) (?=[가-힣])/g, "") }));
  }
  return lines.map((l, i) => ({ ...l, text: textLines[i] }));
}

async function readSlide(file, lang, dir) {
  const base = path.join(dir, lang.replace("+", "_"));
  // One thread per reading: two readings run side by side, and Tesseract's own
  // threads fighting over the same cores slow it down many times over.
  await run("tesseract", [file, base, "-l", lang, "--psm", "4", "-c", "tessedit_create_tsv=1", "-c", "tessedit_create_txt=1"],
    { maxBuffer: 20 * 1024 * 1024, timeout: 120000, env: { ...process.env, OMP_THREAD_LIMIT: "1" } });
  return {
    tsv: fs.readFileSync(`${base}.tsv`, "utf8"),
    txt: fs.existsSync(`${base}.txt`) ? fs.readFileSync(`${base}.txt`, "utf8") : "",
  };
}

const share = (text, re) => {
  const letters = text.match(/\p{L}/gu) || [];
  return letters.length ? letters.filter((c) => re.test(c)).length / letters.length : 0;
};

/** A line the Korean model barely read but the bilingual model reads as English: take the English. */
export function englishLine(line, mixLines) {
  if (share(line.text, /[가-힣ㄱ-ㆎ]/) >= 0.5) return line;
  const same = mixLines.filter((m) => {
    const v = Math.min(m.bottom, line.bottom) - Math.max(m.top, line.top);
    const h = Math.min(m.right, line.right) - Math.max(m.left, line.left);
    return v > 0.5 * Math.min(m.bottom - m.top, line.bottom - line.top) && h > 0;
  }).sort((a, b) => a.left - b.left);
  const text = same.map((m) => m.text).join(" ");
  if (!same.length || share(text, /[A-Za-z]/) < 0.6) return line;
  return { ...line, text, conf: weighted(same.map((m) => [m.conf, m.text.length])) };
}

/**
 * The colour of the "paper" a photo slide is laid out on: a flat strip along the
 * bottom (or top) edge, as when a photo sits above a white caption band.
 */
export async function paperColor(file) {
  const { data, info } = await sharp(file).resize(120, 150, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  for (const rows of [[H - 6, H], [0, 6]]) {
    const px = [];
    for (let y = rows[0]; y < rows[1]; y++) for (let x = 0; x < W; x++) px.push([data[(y * W + x) * 3], data[(y * W + x) * 3 + 1], data[(y * W + x) * 3 + 2]]);
    const mean = [0, 1, 2].map((c) => px.reduce((a, p) => a + p[c], 0) / px.length);
    const flat = px.filter((p) => Math.abs(p[0] - mean[0]) + Math.abs(p[1] - mean[1]) + Math.abs(p[2] - mean[2]) < 30).length / px.length;
    if (flat > 0.95) return mean.map(Math.round);
  }
  return null;
}

/**
 * Everything read from one slide, with positions: its text lines and the
 * pictures on it. Used to place a manuscript's pictures and captions.
 */
export async function slideLayout(file) {
  const { width, height } = await sharp(file).metadata();
  const bg = await backgroundInfo(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-"));
  try {
    const [kor, mix] = await Promise.all([readSlide(file, "kor", dir), readSlide(file, "kor+eng", dir)]);
    const mixWords = tsvWords(mix.tsv);
    const mixLines = wordsToLines(mixWords);
    const words = fixEnglish(tsvWords(kor.tsv), mixWords);
    // Plain-text output keeps Korean spacing: use it, then put the English back in.
    const lines = mergeText(wordsToLines(words), kor.txt).map((l) => {
      const fixed = l.words.filter((w) => w.english !== undefined);
      if (!fixed.length) return l;
      let text = l.text;
      for (const w of fixed) text = text.replace(w.text, w.english);
      const confs = l.words.filter((w) => w.text).map((w) => (w.english !== undefined ? [w.englishConf, w.english.length || 1] : [w.conf, w.text.length]));
      return { ...l, text: text.replace(/\s+/g, " ").trim(), conf: weighted(confs) };
    }).filter((l) => l.text).map((l) => englishLine(l, mixLines));
    // Pictures: on the slide's background, or on the paper strip of a photo slide.
    const paper = bg.share >= RULES.minBackground ? bg.color : await paperColor(file);
    const pictures = paper ? await findPictures(file, [...words, ...mixWords], paper) : [];
    return { width, height, bg, paper, lines, pictures };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Read one slide image. */
export async function analyzeSlideOcr(file) {
  const layout = await slideLayout(file);
  const { bg, lines } = layout;
  const pictures = bg.share >= RULES.minBackground ? layout.pictures : [];
  const r = linesToParagraphs(lines, pictures);
  const isText = bg.share >= RULES.minBackground && r.chars >= RULES.minChars && r.conf >= RULES.minConfidence;
  const hasPictures = isText && r.parts.some((p) => p.kind === "image");
  return {
    kind: isText ? "text" : "image",
    paragraphs: isText ? r.paragraphs : [],
    note: isText ? r.notes.join(" / ") : "",
    parts: hasPictures ? r.parts : undefined,
    title: "",
    author: "",
    issue: r.issue,
    uncertain: isText && r.shaky,
    layout,
    _debug: { background: Number(bg.share.toFixed(2)), chars: r.chars, confidence: Math.round(r.conf), pictures: pictures.length },
  };
}
