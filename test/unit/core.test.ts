import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { parseIndex, serializeIndex } from "../../src/remarkable/cloud";
import {
  buildPdfContent,
  pageRefs,
  reconcileContent,
} from "../../src/remarkable/content";
import { crc32c, crc32cHeader, sha256Hex } from "../../src/remarkable/hash";
import { parseRm, toposort } from "../../src/remarkable/rmscene";
import {
  convertPages,
  makeTransform,
  mergeGlyphs,
  nearestZoteroColor,
  ZOTERO_COLORS,
} from "../../src/sync/convert";
import { buildRemarkablePdf } from "../../src/sync/pdfExport";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

test("crc32c matches the Castagnoli check value", () => {
  assert.equal(crc32c(new TextEncoder().encode("123456789")), 0xe3069283);
  assert.equal(
    crc32cHeader(new TextEncoder().encode("123456789")),
    "crc32c=4waSgw==",
  );
});

test("sha256 hex", async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("schema 4 index round-trips and is sorted by id", () => {
  const entries = [
    { hash: "b".repeat(64), type: "0", id: "zz", subfiles: 0, size: 5 },
    { hash: "a".repeat(64), type: "0", id: "aa", subfiles: 2, size: 7 },
  ];
  const text = serializeIndex(".", entries);
  assert.equal(
    text,
    `4\n0:.:2:12\n${"a".repeat(64)}:0:aa:2:7\n${"b".repeat(64)}:0:zz:0:5\n`,
  );
  assert.deepEqual(
    parseIndex(text).entries.map((e) => e.id),
    ["aa", "zz"],
  );
  const v3 = parseIndex(`3\n${"c".repeat(64)}:80000000:doc:4:100\n`);
  assert.equal(v3.schema, 3);
  assert.equal(v3.entries[0].subfiles, 4);
});

test("content page mapping handles inserted and deleted pages", () => {
  const content = {
    cPages: {
      pages: [
        { id: "p2", idx: { value: "bc" }, redir: { value: 1 } },
        { id: "p1", idx: { value: "bb" }, redir: { value: 0 } },
        { id: "ins", idx: { value: "bbn" } },
        {
          id: "gone",
          idx: { value: "bd" },
          redir: { value: 2 },
          deleted: { value: 1 },
        },
      ],
    },
  };
  assert.deepEqual(pageRefs(content), [
    { id: "p1", pdfIndex: 0, order: 0 },
    { id: "ins", pdfIndex: undefined, order: 1 },
    { id: "p2", pdfIndex: 1, order: 2 },
  ]);
  assert.deepEqual(
    pageRefs({ pages: ["a", "b"], redirectionPageMap: [0, -1] }).map(
      (p) => p.pdfIndex,
    ),
    [0, undefined],
  );
});

test("built content maps every PDF page in order; reconcile keeps ids", () => {
  let n = 0;
  const newId = () => `id${n++}`;
  const c = buildPdfContent({
    pageCount: 30,
    sizeInBytes: 1,
    newId,
    authorId: "me",
  });
  const refs = pageRefs(c);
  assert.deepEqual(
    refs.map((r) => r.pdfIndex),
    [...Array(30).keys()],
  );
  const shrunk = reconcileContent(c, 28, 2, newId, "me");
  assert.equal(shrunk.pageCount, 28);
  assert.deepEqual(
    pageRefs(shrunk).map((r) => r.id),
    refs.slice(0, 28).map((r) => r.id),
  );
  const grown = reconcileContent(c, 32, 2, newId, "me");
  assert.deepEqual(
    pageRefs(grown).map((r) => r.pdfIndex),
    [...Array(32).keys()],
  );
});

test("toposort orders a CRDT chain", () => {
  const items = [
    { id: "1:12", left: "1:11", right: "0:0" },
    { id: "1:10", left: "0:0", right: "1:11" },
    { id: "1:11", left: "1:10", right: "1:12" },
  ];
  assert.deepEqual(
    toposort(items).map((i) => i.id),
    ["1:10", "1:11", "1:12"],
  );
});

test("parses strokes, layers and typed text", () => {
  const page = parseRm(fixture("Normal_A_stroke_2_layers.rm"));
  assert.equal(page.lines.length, 2);
  assert.equal(page.lines[0].tool, 17);
  assert.equal(page.text?.text, "A");
});

test("parses text highlights and Paper Pro ARGB colours", () => {
  const wiki = parseRm(fixture("Wikipedia_highlighted_p1.rm"));
  assert.equal(wiki.glyphs.length, 4);
  assert.equal(wiki.glyphs[0].text, "The reMarkable uses electronic paper");
  // Three consecutive lines form one highlight.
  assert.deepEqual(
    mergeGlyphs(wiki.glyphs).map((g) => g.length),
    [1, 3],
  );

  const colors = parseRm(fixture("More_color_highlight_shader_v3.15.4.2.rm"));
  const first = colors.lines[0];
  assert.deepEqual(first.rgba, { r: 255, g: 237, b: 117, a: 255 });
  assert.equal(nearestZoteroColor([255, 237, 117]), ZOTERO_COLORS.yellow);
  assert.equal(nearestZoteroColor([190, 234, 254]), ZOTERO_COLORS.blue);
  assert.equal(nearestZoteroColor([242, 158, 255]), ZOTERO_COLORS.magenta);
  assert.equal(nearestZoteroColor([255, 195, 140]), ZOTERO_COLORS.orange);
  assert.equal(nearestZoteroColor([172, 255, 133]), ZOTERO_COLORS.green);
  assert.equal(nearestZoteroColor([199, 199, 198]), ZOTERO_COLORS.gray);
});

test("reMarkable coordinates map onto PDF points", () => {
  const tf = makeTransform({ x: 0, y: 0, width: 612, height: 792 });
  assert.equal(tf.x(0), 306); // x is centred
  assert.equal(tf.y(0), 792); // y grows down from the top
  assert.ok(Math.abs(tf.x(226) - (306 + 72)) < 1e-9); // 226 units = 1 inch
  assert.ok(Math.abs(tf.y(226) - (792 - 72)) < 1e-9);
});

test("converts a page into highlights, ink and notes", () => {
  const box = { x: 0, y: 0, width: 612, height: 792 };
  const wiki = parseRm(fixture("Wikipedia_highlighted_p1.rm"));
  const strokes = parseRm(fixture("Normal_A_stroke_2_layers.rm"));
  const out = convertPages({
    pages: [
      { ref: { id: "p0", pdfIndex: 0, order: 0 }, page: wiki },
      { ref: { id: "p1", pdfIndex: 1, order: 1 }, page: strokes },
      { ref: { id: "nb", pdfIndex: undefined, order: 2 }, page: strokes },
    ],
    originalPageCount: 2,
    pageBoxes: [box, box],
  });
  const kinds = out.map((c) =>
    c.kind === "annotation" ? c.json.type : c.rmKey,
  );
  // The fixture has one stroke above the page top: it becomes a margin drawing.
  assert.deepEqual(kinds, [
    "highlight",
    "highlight",
    "ink",
    "note",
    "p1/margin",
    "nb/page",
  ]);
  const hl = out[1];
  assert.ok(hl.kind === "annotation");
  assert.ok(hl.json.position.rects!.length >= 3); // one+ rect per line
  assert.match(hl.json.sortIndex, /^00000\|000000\|\d{5}$/);
  const ink = out[2];
  assert.ok(ink.kind === "annotation" && ink.json.position.paths!.length >= 1);
  const typed = out[3];
  assert.ok(typed.kind === "annotation" && typed.json.comment === "A");
  const nb = out[5];
  assert.ok(nb.kind === "note" && nb.svg && nb.text === "A");
  // Same input -> same keys and hashes (idempotent sync).
  const again = convertPages({
    pages: [{ ref: { id: "p0", pdfIndex: 0, order: 0 }, page: wiki }],
    originalPageCount: 2,
    pageBoxes: [box, box],
  });
  assert.equal(again[0].rmKey, out[0].rmKey);
  assert.equal(again[0].hash, out[0].hash);
});

test("burns annotations into the PDF and appends a notes page", async () => {
  const src = await PDFDocument.create();
  src.addPage([612, 792]);
  src.addPage([612, 792]);
  const res = await buildRemarkablePdf(
    await src.save(),
    [
      {
        key: "AAAAAAAA",
        type: "highlight",
        text: "Ünïcödé “quote” → arrow",
        comment: "A comment with ✓ symbols",
        color: "#ffd400",
        sortIndex: "00000|000000|00010",
        position: { pageIndex: 0, rects: [[50, 700, 200, 712]] },
      },
      {
        key: "BBBBBBBB",
        type: "ink",
        color: "#000000",
        position: { pageIndex: 1, width: 2, paths: [[10, 10, 20, 20, 30, 10]] },
      },
    ],
    [{ key: "N", title: "My note", text: "Body of the note" }],
    { appendNotesPages: true, title: "Test" },
  );
  assert.equal(res.originalPageCount, 2);
  assert.equal(res.appendedPageCount, 1);
  const out = await PDFDocument.load(res.bytes);
  assert.equal(out.getPageCount(), 3);
});

test("respace restores spacing and hyphenation from page text", async () => {
  const { respace } = await import("../../src/sync/convert");
  const page =
    "parameterize control APIs. When provided as input several example\nlanguage commands (formatted as com-\nments) followed by";
  assert.equal(
    respace(
      "Whenprovided as input several example language commands (formattedas comments)",
      page,
    ),
    "When provided as input several example language commands (formatted as comments)",
  );
  assert.equal(respace("not on page", page), "not on page");
});
