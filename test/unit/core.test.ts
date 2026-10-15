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

test("respace stays aligned when the page text has ligatures", async () => {
  const { respace } = await import("../../src/sync/convert");
  // "\uFB01" (fi) and "\uFB03" (ffi) expand under NFKC.
  const page = "The \uFB01rst o\uFB03ce was \uFB01ne and quiet today";
  assert.equal(respace("Thefirst office", page), "The \uFB01rst o\uFB03ce");
  // Match ending on a ligature: previously the end index ran off the table.
  assert.equal(respace("wasfine", page), "was \uFB01ne");
  assert.equal(respace("was\uFB01", page), "was \uFB01");
  // Ligature only in the tablet text.
  assert.equal(respace("\uFB01nequiet", "so fine quiet now"), "fine quiet");
});

test("respace handles ligatures with hyphenation and no match", async () => {
  const { respace } = await import("../../src/sync/convert");
  const page = "an e\uFB03-\ncient and o\uFB03cial pro-\ncess here";
  assert.equal(
    respace("efficientandofficialprocess", page),
    "e\uFB03cient and o\uFB03cial process",
  );
  assert.equal(respace("o\uFB03cial", page), "o\uFB03cial");
  assert.equal(respace("missing \uFB01 text", page), "missing \uFB01 text");
  assert.equal(respace("anything", ""), "anything");
  assert.equal(respace("anything", undefined), "anything");
});

test("respace keeps astral characters whole and measures in code units", async () => {
  const { respace } = await import("../../src/sync/convert");
  // U+20BB7 is outside the BMP (a surrogate pair in UTF-16).
  const ideo = "\u{20BB7}";
  // Previously the end index fell one unit short and dropped the "x".
  assert.equal(respace(`${ideo}x`, `see ${ideo}x here`), `${ideo}x`);
  assert.equal(respace(`a${ideo}b`, `so a ${ideo} b ok`), `a ${ideo} b`);
  assert.equal(
    respace(`${ideo}${ideo}z`, `${ideo}${ideo} z end`),
    `${ideo}${ideo} z`,
  );
  // Emoji, followed by more text and mixed with ligatures.
  const smile = "\u{1F600}";
  assert.equal(
    respace(`hi${smile}there`, `say hi ${smile} there now`),
    `hi ${smile} there`,
  );
  assert.equal(
    respace(`${smile}\uFB01nal`, `ok ${smile} \uFB01nal word`),
    `${smile} \uFB01nal`,
  );
  // Text before the match contains astral characters: offsets must not drift.
  assert.equal(respace("wordnext", `${smile}${ideo} word next`), "word next");
  // No match still falls back to the input.
  assert.equal(respace(`${ideo}q`, `see ${ideo}x here`), `${ideo}q`);
});

test("respaceWith over a shared page index matches respace", async () => {
  const { respace, respaceWith, buildPageIndex } = await import(
    "../../src/sync/convert"
  );
  // The pre-index algorithm, kept verbatim as the reference.
  const reference = (text: string, pageText: string | undefined) => {
    if (!pageText || !text) return text;
    const expand = (c: string) =>
      c.normalize("NFKC").toLowerCase().replace(/[\s-]/g, "");
    const start: number[] = [];
    const end: number[] = [];
    let compact = "";
    let i = 0;
    for (const ch of pageText) {
      const x = expand(ch);
      for (let k = 0; k < x.length; k++) {
        start.push(i);
        end.push(i + ch.length);
      }
      compact += x;
      i += ch.length;
    }
    let needle = "";
    for (const ch of text) needle += expand(ch);
    if (!needle) return text;
    const at = compact.indexOf(needle);
    if (at < 0) return text;
    const first = start[at];
    const last = end[at + needle.length - 1];
    if (first === undefined || last === undefined) return text;
    return pageText
      .slice(first, last)
      .replace(/-\s*\n\s*/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };
  const ideo = "\u{20BB7}";
  const smile = "\u{1F600}";
  const cases: Array<[string, string | undefined]> = [
    [
      "Whenprovided as input several example language commands (formattedas comments)",
      "parameterize control APIs. When provided as input several example\nlanguage commands (formatted as com-\nments) followed by",
    ],
    ["not on page", "parameterize control APIs. When provided"],
    ["Thefirst office", "The \uFB01rst o\uFB03ce was \uFB01ne and quiet today"],
    ["wasfine", "The \uFB01rst o\uFB03ce was \uFB01ne and quiet today"],
    ["was\uFB01", "The \uFB01rst o\uFB03ce was \uFB01ne and quiet today"],
    ["\uFB01nequiet", "so fine quiet now"],
    [
      "efficientandofficialprocess",
      "an e\uFB03-\ncient and o\uFB03cial pro-\ncess here",
    ],
    [
      "missing \uFB01 text",
      "an e\uFB03-\ncient and o\uFB03cial pro-\ncess here",
    ],
    ["anything", ""],
    ["anything", undefined],
    ["", "page"],
    [" - ", "page - text"],
    [`${ideo}x`, `see ${ideo}x here`],
    [`a${ideo}b`, `so a ${ideo} b ok`],
    [`hi${smile}there`, `say hi ${smile} there now`],
    [`${smile}\uFB01nal`, `ok ${smile} \uFB01nal word`],
    ["wordnext", `${smile}${ideo} word next`],
    [`${ideo}q`, `see ${ideo}x here`],
  ];
  for (const [text, page] of cases) {
    const expected = reference(text, page);
    assert.equal(respace(text, page), expected);
    const index = page ? buildPageIndex(page) : undefined;
    assert.equal(respaceWith(text, page, index), expected);
  }
  // Randomised: ASCII-only and mixed pages, queried many times per index.
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed % n;
  };
  const ascii = ["a", "B", "c", "d", "e", " ", " ", "-", "\n", "\t", ".", "1"];
  const wide = [...ascii, "\uFB01", "\uFB03", ideo, smile, "\u00e9", "\u00a0"];
  const gen = (alphabet: string[], len: number) =>
    Array.from({ length: len }, () => alphabet[rnd(alphabet.length)]).join("");
  for (let n = 0; n < 200; n++) {
    const alphabet = n % 2 ? wide : ascii;
    const page = gen(alphabet, 5 + rnd(60));
    const index = buildPageIndex(page);
    for (let q = 0; q < 8; q++) {
      // Half the queries are slices of the page with spacing stripped.
      const a = rnd(page.length);
      const sliced = page.slice(a, a + 1 + rnd(20)).replace(/[\s-]/g, "");
      const text = q % 2 ? sliced : gen(alphabet, 1 + rnd(6));
      assert.equal(
        respaceWith(text, page, index),
        reference(text, page),
        JSON.stringify({ text, page }),
      );
    }
  }
});

test("splitPageTexts never spreads one page of text over other pages", async () => {
  const { splitPageTexts } = await import("../../src/sync/convert");
  assert.deepEqual(splitPageTexts("a\fb\fc", 3), ["a", "b", "c"]);
  assert.deepEqual(splitPageTexts("only", 1), ["only"]);
  assert.deepEqual(splitPageTexts("all pages in one blob", 5), []);
  assert.deepEqual(splitPageTexts("unknown count"), []);
  assert.deepEqual(splitPageTexts(undefined, 2), []);
  assert.deepEqual(splitPageTexts("", 2), []);
});

test("handwriting written together becomes one ink annotation", async () => {
  const { clusterLines } = await import("../../src/sync/convert");
  // "Test Handwrite" written on one line on a Paper Pro.
  const page = parseRm(fixture("code_as_policies_p1_handwriting.rm"));
  assert.equal(page.lines.length, 23);
  assert.equal(clusterLines(page.lines).length, 1);

  const stroke = (id: string, x: number, y: number, w = 40, h = 40) => ({
    id,
    parent: "0:11",
    tool: 17,
    color: 0,
    thicknessScale: 2,
    points: [
      { x, y, speed: 0, direction: 0, width: 19, pressure: 100 },
      { x: x + w, y: y + h, speed: 0, direction: 0, width: 19, pressure: 100 },
    ],
  });
  // Two lines of a margin note, stacked closely -> one group.
  const stacked = [stroke("1:1", 0, 0, 200), stroke("1:2", 10, 60, 180)];
  assert.equal(clusterLines(stacked).length, 1);
  // Notes in different places on the page stay separate.
  const apart = [stroke("1:1", 0, 0), stroke("1:2", 600, 900)];
  assert.equal(clusterLines(apart).length, 2);
  // Same line but far apart (opposite margins) stay separate.
  const farOnLine = [stroke("1:1", -700, 100), stroke("1:2", 600, 100)];
  assert.equal(clusterLines(farOnLine).length, 2);
});
