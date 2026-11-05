// Check the Google Drive connection for manuscripts:
//   node scripts/check-manuscripts.mjs ["post title"]
// Lists the newest Google Docs the service account can see and, given a title,
// shows how that manuscript is read (versions, subheadings, captions, bio).
import { driveEnabled, listDocs, exportHtml, folderName, serviceAccountEmail } from "./lib/gdrive.mjs";
import { googleDocHtmlToManuscript, parseManuscript, titleScore, looksLikeName } from "./lib/manuscript.mjs";

if (!driveEnabled()) {
  console.error("GOOGLE_SERVICE_ACCOUNT_JSON is not set. Add the service account's key file as that repository secret.");
  process.exit(1);
}
console.log(`Robot account: ${serviceAccountEmail()}`);
const docs = await listDocs();
console.log(`It can see ${docs.length} Google Doc(s).`);
if (!docs.length) {
  console.error("::error::No documents visible. Share the manuscripts folder (e.g. 2026) with the robot account's email as Commenter.");
  process.exit(1);
}
console.log("\nNewest:");
for (const d of docs.slice(0, 12)) console.log(`  ${d.modifiedTime.slice(0, 10)}  ${await folderName(d.parents?.[0])} / ${d.name}`);

const title = process.argv.slice(2).join(" ").trim();
if (title) {
  const doc = docs.map((d) => ({ d, s: titleScore(d.name, [title]) })).sort((a, b) => b.s - a.s)[0];
  if (!doc || doc.s < 0.85) { console.error(`\n::error::No document titled like "${title}".`); process.exit(1); }
  const html = await exportHtml(doc.d.id);
  const { text, comments } = googleDocHtmlToManuscript(html);
  const m = parseManuscript(text, comments);
  const folder = await folderName(doc.d.parents?.[0]);
  console.log(`\n"${doc.d.name}" (author folder: ${looksLikeName(folder) ? folder : "—"})`);
  console.log(`  HTML ${html.length} chars, ${comments.length} comment(s)`);
  console.log(`  title: ${m.title || "(none)"}`);
  for (const v of m.versions) {
    console.log(`  version "${v.name || "-"}": ${v.blocks.filter((b) => b.type === "p").length} paragraphs, subheadings: ${v.blocks.filter((b) => b.type === "heading").map((b) => b.text).join(" | ") || "none"}`);
    console.log(`    starts: ${v.blocks[0]?.text.slice(0, 60)}`);
  }
  console.log(`  images: ${m.images.length}, with captions: ${m.images.filter((i) => i.caption).length}`);
  m.images.forEach((im, i) => console.log(`    ${i + 1}. ${im.caption.replace(/\n/g, " ").slice(0, 70) || "(no caption)"}`));
  console.log(`  bio: ${m.bio.slice(0, 80) || "(none)"}`);
}
