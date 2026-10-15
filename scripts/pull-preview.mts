/**
 * Dev tool: download a reMarkable document, convert its annotations exactly
 * like the plugin does, and write
 *   <out>.json  the Zotero annotation candidates
 *   <out>.pdf   the document's PDF with those candidates drawn on top
 *
 * Usage:
 *   RM_DEVICE_TOKEN=... npx tsx scripts/pull-preview.mts <docId> <out> [originalPageCount]
 */
import { writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { RemarkableCloud } from "../src/remarkable/cloud";
import { pageRefs } from "../src/remarkable/content";
import { parseRm } from "../src/remarkable/rmscene";
import { convertPages } from "../src/sync/convert";
import { buildRemarkablePdf } from "../src/sync/pdfExport";
import type { ZAnnotation } from "../src/sync/types";

const [docId, out, originalArg] = process.argv.slice(2);
const cloud = new RemarkableCloud({
  fetch,
  deviceToken: process.env.RM_DEVICE_TOKEN!,
  userToken: process.env.RM_USER_TOKEN,
});
const files = await cloud.getDocumentFiles(docId);
if (!files) throw new Error("document not found");
const pdfEntry = files.files.find((f) => f.id === `${docId}.pdf`)!;
const pdf = await cloud.getBlob(pdfEntry.hash, pdfEntry.id);
const doc = await PDFDocument.load(pdf);
const pageBoxes = doc.getPages().map((p) => p.getCropBox());
const originalPageCount = Number(originalArg ?? pageBoxes.length);

const refs = pageRefs(files.content);
const pages = refs
  .filter((r) => files.rm.has(r.id))
  .map((ref) => ({ ref, page: parseRm(files.rm.get(ref.id)!) }));
for (const { ref, page } of pages) {
  console.log(
    `page ${ref.order} (pdf ${ref.pdfIndex ?? "inserted"}): ${page.lines.length} strokes, ` +
      `${page.glyphs.length} highlights${page.text ? ", typed text" : ""}`,
  );
}
const candidates = convertPages({ pages, originalPageCount, pageBoxes });
writeFileSync(`${out}.json`, JSON.stringify(candidates, null, 2));
for (const c of candidates) {
  if (c.kind === "annotation") {
    console.log(
      `  ${c.json.type} p.${c.json.pageLabel} ${c.json.color} ` +
        JSON.stringify(c.json.text ?? c.json.comment ?? "").slice(0, 70),
    );
  } else console.log(`  note "${c.title}"${c.svg ? " +drawing" : ""}`);
}
const anns: ZAnnotation[] = candidates
  .filter((c) => c.kind === "annotation")
  .map((c, i) => ({ key: `K${i}`, ...(c as any).json }));
const preview = await buildRemarkablePdf(pdf, anns, [], {
  appendNotesPages: false,
});
writeFileSync(`${out}.pdf`, preview.bytes);
for (const c of candidates) {
  if (c.kind === "note" && c.svg)
    writeFileSync(`${out}-${c.rmKey.replace(/\W/g, "_")}.svg`, c.svg.markup);
}
