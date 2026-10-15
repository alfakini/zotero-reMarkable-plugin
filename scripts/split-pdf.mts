import { readFileSync, writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
const [src, ...idx] = process.argv.slice(2);
const doc = await PDFDocument.load(readFileSync(src));
for (const i of idx.map(Number)) {
  const d = await PDFDocument.create();
  const [p] = await d.copyPages(doc, [i]);
  d.addPage(p);
  writeFileSync(`${src}.p${i}.pdf`, await d.save());
}
