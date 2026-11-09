// A manuscript saved as Word (.docx, e.g. Google Docs → Download → Word) →
// the text form parseManuscript reads, plus its comments and images.
//
// Kept: headings (# …), the title (bold or Title style → **…**), numbered list
// items (1. …), paragraphs, and which comment is attached to which image: a
// comment on an image is its caption.
import { unzipSync, strFromU8 } from "fflate";

const decode = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&");
const attr = (tag, name) => (tag.match(new RegExp(`${name}="([^"]*)"`)) || [])[1];

/** Plain text of a run of WordprocessingML (w:t, tabs, breaks). */
function runsText(xml) {
  let out = "";
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
    out += m[1] !== undefined ? decode(m[1]) : m[0] === "<w:tab/>" ? " " : "\n";
  }
  return out;
}

function readComments(files) {
  const xml = files["word/comments.xml"] ? strFromU8(files["word/comments.xml"]) : "";
  const ext = files["word/commentsExtended.xml"] ? strFromU8(files["word/commentsExtended.xml"]) : "";
  // Replies have a parent paragraph: they're conversation, not captions.
  const replies = new Set([...ext.matchAll(/<w15:commentEx\b[^>]*>/g)].map((m) => m[0])
    .filter((t) => attr(t, "w15:paraIdParent")).map((t) => attr(t, "w15:paraId")));
  const out = new Map();
  for (const m of xml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const id = attr(m[1], "w:id");
    const paras = [...m[2].matchAll(/<w:p\b([^>]*)>([\s\S]*?)<\/w:p>/g)];
    if (paras.some((p) => replies.has(attr(p[1], "w14:paraId")))) continue;
    out.set(id, paras.map((p) => runsText(p[2]).trim()).filter(Boolean).join("\n"));
  }
  return out;
}

function readNumbering(files) {
  const xml = files["word/numbering.xml"] ? strFromU8(files["word/numbering.xml"]) : "";
  const abs = new Map();
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const lvls = new Map();
    for (const l of m[2].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      lvls.set(l[1], { fmt: (l[2].match(/<w:numFmt w:val="([^"]+)"/) || [])[1] || "decimal", start: Number((l[2].match(/<w:start w:val="(\d+)"/) || [])[1] || 1) });
    }
    abs.set(m[1], lvls);
  }
  const nums = new Map();
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    nums.set(m[1], abs.get((m[2].match(/<w:abstractNumId w:val="(\d+)"/) || [])[1]) || new Map());
  }
  return nums;
}

/**
 * @param {Uint8Array|Buffer} buf  the .docx file
 * @returns {{ text: string, comments: {id,text}[], images: {id: string|null, file: string, data: Uint8Array}[] }}
 */
export function docxToManuscript(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const doc = strFromU8(files["word/document.xml"]);
  const rels = files["word/_rels/document.xml.rels"] ? strFromU8(files["word/_rels/document.xml.rels"]) : "";
  const relMap = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [attr(m[1], "Id"), attr(m[1], "Target")]));
  const comments = readComments(files);
  const numbering = readNumbering(files);
  const counters = new Map();

  const lines = [];
  const images = [];
  const open = []; // comment ranges currently open, in order
  const body = doc.slice(doc.indexOf("<w:body"));
  for (const pm of body.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const p = pm[1] || "";
    const style = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || "";
    const numId = (p.match(/<w:numPr>[\s\S]*?<w:numId w:val="(\d+)"/) || [])[1];
    const ilvl = (p.match(/<w:numPr>[\s\S]*?<w:ilvl w:val="(\d+)"/) || [])[1] || "0";
    let text = "";
    let runs = 0, boldRuns = 0;
    const marks = [];
    // Walk the paragraph in order: comment ranges, runs, drawings.
    for (const t of p.matchAll(/<w:commentRangeStart w:id="(\d+)"\/>|<w:commentRangeEnd w:id="(\d+)"\/>|<w:r\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:r>)/g)) {
      if (t[1] !== undefined) { open.push(t[1]); continue; }
      if (t[2] !== undefined) { const i = open.lastIndexOf(t[2]); if (i >= 0) open.splice(i, 1); continue; }
      const r = t[3] || "";
      for (const d of r.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)) {
        const rid = (d[0].match(/r:embed="([^"]+)"/) || [])[1];
        const target = relMap.get(rid);
        // The comment around the image (the innermost open one that is a caption).
        const id = [...open].reverse().find((c) => comments.has(c)) ?? null;
        if (target && files[`word/${target}`]) images.push({ id, file: target.split("/").pop(), data: files[`word/${target}`] });
        marks.push(id);
      }
      const s = runsText(r);
      if (s.trim()) {
        runs++;
        if (/<w:b\/>|<w:b w:val="(1|true|on)"\/>/.test(r)) boldRuns++;
      }
      text += s;
    }
    for (const id of marks) lines.push(id !== null ? `<comment_start id=c${id}>\\[image\\]<comment_end id=c${id}>` : "\\[image\\]");
    text = text.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").trim();
    if (!text) continue;
    const flat = text.replace(/\s*\n\s*/g, "  \n");
    if (/^(Heading|heading)\s?\d|^Title$/.test(style) && !/^Title$/.test(style)) { lines.push(`# ${text.replace(/\s+/g, " ")}`); continue; }
    if (/^Title$/i.test(style) || (runs && boldRuns === runs && !numId && lines.length < 6)) { lines.push(`**${text.replace(/\s+/g, " ")}**`); continue; }
    if (numId && numbering.get(numId)?.get(ilvl)?.fmt === "decimal") {
      const lvl = numbering.get(numId).get(ilvl);
      const key = `${numId}:${ilvl}`;
      const n = counters.has(key) ? counters.get(key) + 1 : lvl.start;
      counters.set(key, n);
      lines.push(`${n}.  ${text.replace(/\s+/g, " ")}`);
      continue;
    }
    lines.push(flat);
  }
  return {
    text: lines.join("\n"),
    comments: [...comments].map(([id, text]) => ({ id: `c${id}`, text })),
    images,
  };
}
