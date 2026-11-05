// Reads one carousel slide with Claude (vision) and says what it is:
//   image  → a photo/illustration slide, kept as an image on the site
//   text   → a body-text slide, transcribed into live text
//   title  → the title/signature slide, kept as an image; title and author read off it
//
// Needs ANTHROPIC_API_KEY. Returns null when no key is set, so the caller can fall back.
import fs from "node:fs";
import sharp from "sharp";

const PROMPT = `This is one slide from an Instagram carousel published by a Korean culture journal (CAVA journal).
Classify the slide and, for text slides, transcribe it. Reply with JSON only, no prose, in this shape:
{"kind": "image" | "text" | "title", "paragraphs": [string], "note": string, "title": string, "author": string, "issue": number | null}

Rules:
- "text": the slide's main content is body text (paragraphs of prose) on a plain or flat background. Transcribe every word of the body exactly as written, in reading order. One array item per paragraph; join the lines inside a paragraph with a single space (do not keep line breaks caused by wrapping). Do not translate, summarise, correct or add anything.
- Put small credits or source lines (e.g. lines starting with "출처", "←", "사진", "Photo") in "note", not in "paragraphs".
- Ignore page furniture: slide numbers, dates, the "CAVA journal" wordmark, issue numbers.
- "title": a slide whose main content is the piece's title, usually with the writer's handwritten signature/name. Put the printed title in "title" and the writer's name (read the handwriting if needed) in "author". paragraphs = [].
- "image": anything else (photographs, artwork, illustrations, posters), even if a short headline is overlaid. paragraphs = [].
- "issue": if a number shown next to the "CAVA journal" wordmark is visible, that number; otherwise null.
- Use "" for fields that do not apply.`;

const MEDIA_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export function visionEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Pull the first {...} block out of a model reply and parse it. */
export function parseJsonReply(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in reply");
  const raw = text.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch {
    // Raw line breaks inside strings: as JSON whitespace they are safe to turn into spaces.
    return JSON.parse(raw.replace(/[\r\n\t]+/g, " "));
  }
}

export function normalise(r) {
  const kind = ["image", "text", "title"].includes(r?.kind) ? r.kind : "image";
  const paragraphs = Array.isArray(r?.paragraphs)
    ? r.paragraphs.map((p) => String(p).replace(/\s+/g, " ").trim()).filter(Boolean)
    : [];
  return {
    kind: kind === "text" && !paragraphs.length ? "image" : kind,
    paragraphs,
    note: String(r?.note || "").trim(),
    title: String(r?.title || "").trim(),
    author: String(r?.author || "").trim(),
    issue: Number.isFinite(Number(r?.issue)) && r?.issue !== null && r?.issue !== "" ? Number(r.issue) : null,
  };
}

/**
 * @param {string} file  absolute path of the saved slide image
 * @param {{model?: string}} opts
 */
export async function analyzeSlide(file, { model = "claude-sonnet-5-5" } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  // Send a downscaled copy: plenty for reading text, cheaper and faster.
  let buf = fs.readFileSync(file);
  let mediaType = MEDIA_TYPES[(file.split(".").pop() || "").toLowerCase()] || "image/jpeg";
  try {
    buf = await sharp(buf).resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    mediaType = "image/jpeg";
  } catch { /* send as is */ }

  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: buf.toString("base64") } },
            { type: "text", text: PROMPT },
          ],
        }],
      }),
    });
    if (res.ok) {
      const json = await res.json();
      const text = (json.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      return normalise(parseJsonReply(text));
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 4) {
      const body = await res.text().catch(() => "");
      throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

/** True when a paragraph clearly stops mid-sentence (so the next slide continues it). */
export function endsMidSentence(p) {
  return !/[.!?。…"”'’)\]」』〉》~]$/.test(p.trim());
}

/**
 * Turn analysed slides (in carousel order) into article blocks.
 * Consecutive text slides are joined; a paragraph cut off at the end of one
 * slide is merged with the first paragraph of the next.
 * @param {{media: {type, src, poster?}, analysis: ReturnType<typeof normalise> | null}[]} slides
 */
export function slidesToBlocks(slides) {
  const blocks = [];
  for (const s of slides) {
    const a = s.analysis;
    if (a && a.kind === "text") {
      const prev = blocks[blocks.length - 1];
      const paras = [...a.paragraphs];
      if (prev && prev.type === "text" && prev.paragraphs.length && paras.length && endsMidSentence(prev.paragraphs.at(-1))) {
        prev.paragraphs[prev.paragraphs.length - 1] += " " + paras.shift();
      }
      if (prev && prev.type === "text") {
        prev.paragraphs.push(...paras);
        if (a.note) prev.notes.push(a.note);
      } else {
        blocks.push({ type: "text", paragraphs: paras, notes: a.note ? [a.note] : [] });
      }
    } else {
      blocks.push({ type: "media", media: s.media, role: a?.kind === "title" ? "title" : "image" });
    }
  }
  return blocks;
}
