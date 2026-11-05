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
const FURNITURE_RE = /(CAVA\s*journal|^\s*\d{1,4}\s*$|^\s*\d{8}\s*$|^\s*\d{1,3}\s*\/\s*\d{1,3}\s*$)/i;

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

/** Share of pixels close to the slide's most common colour. */
export async function backgroundShare(file) {
  const { data, info } = await sharp(file).resize(60, 75, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const counts = new Map();
  const px = info.width * info.height;
  for (let i = 0; i < px; i++) {
    const key = ((data[i * 3] >> 4) << 8) | ((data[i * 3 + 1] >> 4) << 4) | (data[i * 3 + 2] >> 4);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [r, g, b] = [(top[0] >> 8) << 4, ((top[0] >> 4) & 15) << 4, (top[0] & 15) << 4];
  let near = 0;
  for (let i = 0; i < px; i++) {
    const d = Math.abs(data[i * 3] - r - 8) + Math.abs(data[i * 3 + 1] - g - 8) + Math.abs(data[i * 3 + 2] - b - 8);
    if (d < 48) near++;
  }
  return near / px;
}

/**
 * Tesseract TSV → lines in reading order, each with its text, position and confidence.
 */
export function tsvToLines(tsv) {
  const rows = tsv.trim().split("\n").slice(1).map((l) => l.split("\t"));
  const lines = new Map();
  for (const c of rows) {
    if (c.length < 12 || c[0] !== "5") continue; // level 5 = word
    const text = c.slice(11).join("\t").trim();
    if (!text) continue;
    const key = `${c[2]}-${c[3]}-${c[4]}`; // block-paragraph-line
    const top = Number(c[7]), height = Number(c[9]), conf = Number(c[10]);
    const l = lines.get(key) || { words: [], top, bottom: top + height, confs: [] };
    l.words.push(text);
    l.top = Math.min(l.top, top);
    l.bottom = Math.max(l.bottom, top + height);
    l.confs.push(conf);
    lines.set(key, l);
  }
  return [...lines.values()]
    .map((l) => ({ text: l.words.join(" "), top: l.top, bottom: l.bottom, conf: l.confs.reduce((a, b) => a + b, 0) / l.confs.length }))
    .sort((a, b) => a.top - b.top);
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
      prev.conf = Math.min(prev.conf, l.conf);
    } else {
      rows.push({ ...l });
    }
  }
  return rows;
}

// Signs of a misread: low confidence, stray single consonants/vowels, Latin
// fragments wedged between Korean words.
const SHAKY_RE = /[ㄱ-ㆎ]{2,}|[가-힣]\s+[A-Za-z]{1,3}[,.]?\s+[가-힣A-Za-z]/;

export function linesToParagraphs(rawLines) {
  const lines = mergeRows(rawLines);
  const body = [];
  const notes = [];
  let issue = null;
  for (const l of lines) {
    const m = l.text.match(/(\d{1,4})\s*CAVA\s*journal/i);
    if (m) issue = Number(m[1]);
    if (l.conf < RULES.dropLineBelow) continue;
    if (FURNITURE_RE.test(l.text)) continue;
    if (NOTE_RE.test(l.text)) { notes.push(l.text.replace(/^\s*[<«‹]\s*/, "← ")); continue; }
    body.push(l);
  }
  // Spacing is measured between line bottoms: steadier than tops when a line has tall syllables.
  const steps = body.slice(1).map((l, i) => l.bottom - body[i].bottom).filter((g) => g > 0).sort((a, b) => a - b);
  // Typical line spacing: lower quartile of the gaps (paragraph breaks are the large outliers).
  const usual = steps.length ? steps[Math.floor((steps.length - 1) / 4)] : 0;
  const paragraphs = [];
  body.forEach((l, i) => {
    const gap = i ? l.bottom - body[i - 1].bottom : 0;
    if (!i || (usual && gap > usual * 1.5)) paragraphs.push(l.text);
    else paragraphs[paragraphs.length - 1] += " " + l.text;
  });
  const chars = (paragraphs.join("").match(/[\p{L}\p{N}]/gu) || []).length;
  const conf = body.length ? body.reduce((a, l) => a + l.conf, 0) / body.length : 0;
  const shaky = body.some((l) => l.conf < 75 || SHAKY_RE.test(l.text));
  return { paragraphs: paragraphs.map((p) => p.replace(/\s+/g, " ").trim()), notes, issue, chars, conf, shaky };
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

/** Read one slide image. */
export async function analyzeSlideOcr(file) {
  const bg = await backgroundShare(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-"));
  const base = path.join(dir, "out");
  try {
    await run("tesseract", [file, base, "-l", "kor+eng", "--psm", "4", "-c", "tessedit_create_tsv=1", "-c", "tessedit_create_txt=1"],
      { maxBuffer: 20 * 1024 * 1024 });
    const tsv = fs.readFileSync(`${base}.tsv`, "utf8");
    const txt = fs.existsSync(`${base}.txt`) ? fs.readFileSync(`${base}.txt`, "utf8") : "";
    const r = linesToParagraphs(mergeText(tsvToLines(tsv), txt));
    const isText = bg >= RULES.minBackground && r.chars >= RULES.minChars && r.conf >= RULES.minConfidence;
    return {
      kind: isText ? "text" : "image",
      paragraphs: isText ? r.paragraphs : [],
      note: isText ? r.notes.join(" / ") : "",
      title: "",
      author: "",
      issue: r.issue,
      uncertain: isText && r.shaky,
      _debug: { background: Number(bg.toFixed(2)), chars: r.chars, confidence: Math.round(r.conf) },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
