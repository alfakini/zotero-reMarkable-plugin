import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  addInsertedPage,
  buildPdfContent,
  deletePage,
  pageRefs,
} from "../../src/remarkable/content";
import { parseRm, ParagraphStyle as S } from "../../src/remarkable/rmscene";
import { writePageText } from "../../src/remarkable/rmwrite";
import {
  decide,
  mergeConflict,
  pairState,
  withTabletStyles,
} from "../../src/sync/noteSync";
import {
  embeddedImageKeys,
  htmlToParagraphs,
  isSyncedNoteTitle,
  legacyDrawingKey,
  nextNoteTitle,
  paragraphsToHtml,
  patchDrawing,
  plainText,
  staleDrawingKeys,
} from "../../src/sync/notes";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const AUTHOR = "504d3023-c5f1-418f-ab41-76a1a9ee2a79";

test("parses a Zotero note into title and body", () => {
  const html =
    '<div class="zotero-note znv1"><div data-schema-version="9"><h1>reMarkable notebook page 2</h1>' +
    "<p>this is a note page</p><p>Test test. Sync from Zotero to reMarkable.</p>" +
    "<ul><li><p>first &amp; <strong>bold</strong></p></li><li><p>second</p></li></ul>" +
    '<p><img data-attachment-key="ABCD1234" width="10" height="10"/></p><p></p></div></div>';
  const note = htmlToParagraphs(html);
  assert.equal(note.title, "reMarkable notebook page 2");
  assert.deepEqual(note.body, [
    { style: S.PLAIN, text: "this is a note page" },
    { style: S.PLAIN, text: "Test test. Sync from Zotero to reMarkable." },
    { style: S.BULLET, text: "first & bold" },
    { style: S.BULLET, text: "second" },
  ]);
  // Note HTML we write parses back to the same body.
  const again = htmlToParagraphs(paragraphsToHtml(note.title, note.body));
  assert.deepEqual(again, note);
});

test("note title convention", () => {
  assert.ok(isSyncedNoteTitle("reMarkable Note 3 – Methods"));
  assert.ok(isSyncedNoteTitle("remarkable note"));
  assert.ok(!isSyncedNoteTitle("Reading notes"));
  assert.ok(!isSyncedNoteTitle("reMarkable notebook page 2"));
  assert.ok(isSyncedNoteTitle("reMarkable Note"));
  assert.ok(isSyncedNoteTitle("reMarkable Note: summary"));
  assert.equal(
    nextNoteTitle(["reMarkable Note 1", "reMarkable Note 3 – x", "Other"]),
    "reMarkable Note 2",
  );
});

test("three-way decisions", () => {
  assert.equal(decide("a", "a", "a"), "none");
  assert.equal(decide("a", "b", "a"), "toTablet");
  assert.equal(decide("a", "a", "b"), "toZotero");
  assert.equal(decide("a", "b", "c"), "conflict");
  assert.equal(decide("a", "b", "b"), "none");
  const merged = mergeConflict(
    [{ style: S.PLAIN, text: "zotero" }],
    [{ style: S.PLAIN, text: "tablet" }],
  );
  assert.match(plainText(merged), /^zotero\n.+\ntablet$/);
});

test("plain Zotero paragraphs keep the tablet's styles", () => {
  const out = withTabletStyles(
    [
      { style: S.PLAIN, text: "this is a note page" },
      { style: S.PLAIN, text: "new line" },
    ],
    [{ style: S.HEADING, text: "this is a note page" }],
  );
  assert.deepEqual(
    out.map((p) => p.style),
    [S.HEADING, S.PLAIN],
  );
});

test("note pages are appended and removed in the page map", () => {
  let n = 0;
  const c = buildPdfContent({
    pageCount: 3,
    sizeInBytes: 1,
    newId: () => `p${n++}`,
    authorId: "me",
  });
  const added = addInsertedPage(c, "note-1", AUTHOR);
  const refs = pageRefs(added);
  assert.equal(refs.at(-1)!.id, "note-1");
  assert.equal(refs.at(-1)!.pdfIndex, undefined);
  assert.equal(added.pageCount, 4);
  const removed = deletePage(added, "note-1", AUTHOR);
  assert.equal(pageRefs(removed).length, 3);
  assert.equal(removed.pageCount, 3);
});

test("note text round-trips through .rm pages, keeping handwriting", () => {
  const device = fixture("device_note_page_paperpro.rm");
  assert.deepEqual(parseRm(device).rootText!.paragraphs, [
    { style: S.HEADING, text: "this is a note page" },
  ]);
  const body = [
    { style: S.HEADING, text: "this is a note page" },
    { style: S.PLAIN, text: "Test test. Sync from Zotero to reMarkable." },
    { style: S.BULLET, text: "ünïcode ✓" },
  ];
  const edited = writePageText(device, body, { authorUuid: AUTHOR });
  assert.deepEqual(parseRm(edited).rootText!.paragraphs, body);
  // Editing again (as after a tablet edit) still produces a valid sequence.
  const twice = writePageText(edited, [{ style: S.PLAIN, text: "again" }], {
    authorUuid: AUTHOR,
  });
  assert.equal(parseRm(twice).rootText!.text, "again");
  // New page modelled on the device page.
  const fresh = writePageText(undefined, body, {
    authorUuid: AUTHOR,
    template: device,
  });
  assert.deepEqual(parseRm(fresh).rootText!.paragraphs, body);
  // Text written onto a page with handwriting keeps every stroke.
  const hw = fixture("code_as_policies_p1_handwriting.rm");
  const withText = writePageText(hw, body, { authorUuid: AUTHOR });
  assert.equal(parseRm(withText).lines.length, parseRm(hw).lines.length);
});

const WRAPPED =
  '<div class="zotero-note znv1"><div data-schema-version="9"><h1>reMarkable Note 1</h1>' +
  '<p>see <a href="https://example.org">this</a> and <strong>that</strong></p>' +
  "<ul><li><p>one<ul><li><p>nested</p></li></ul></p></li></ul>" +
  '<p><img data-attachment-key="USER0001" width="5" height="5"/></p>' +
  '<p><img width="10" height="20" data-attachment-key="DRAW0001"/></p></div></div>';

test("patchDrawing swaps only the plugin image and keeps user content", () => {
  const out = patchDrawing(WRAPPED, "DRAW0001", {
    key: "DRAW0002",
    width: 30,
    height: 40,
  });
  assert.ok(out.includes('<a href="https://example.org">this</a>'));
  assert.ok(out.includes("<strong>that</strong>"));
  assert.ok(out.includes("<li><p>nested</p></li>"));
  assert.ok(out.includes('data-attachment-key="USER0001"'));
  assert.ok(!out.includes("DRAW0001"));
  assert.ok(
    out.includes(
      '<p><img data-attachment-key="DRAW0002" width="30" height="40"/></p></div></div>',
    ),
  );
  assert.deepEqual(embeddedImageKeys(out), ["USER0001", "DRAW0002"]);
});

test("patchDrawing removes the plugin image and its empty paragraph", () => {
  const out = patchDrawing(WRAPPED, "DRAW0001");
  assert.ok(!out.includes("DRAW0001"));
  assert.ok(out.endsWith("</p></div></div>"));
  assert.ok(!out.includes("<p></p>"));
  assert.ok(out.includes("USER0001"));
});

test("patchDrawing appends inside the wrapper when the image is missing", () => {
  const drawing = { key: "NEW00001", width: 1, height: 2 };
  const withoutImg = WRAPPED.replace(/<p><img[^>]*DRAW0001[^>]*><\/p>/, "");
  for (const old of ["DRAW0001", undefined]) {
    const out = patchDrawing(withoutImg, old, drawing);
    assert.ok(
      out.endsWith(
        '<p><img data-attachment-key="NEW00001" width="1" height="2"/></p></div></div>',
      ),
    );
    assert.ok(out.includes("USER0001"));
  }
  const bare = patchDrawing("<p>hi</p>", undefined, drawing);
  assert.equal(
    bare,
    '<p>hi</p><p><img data-attachment-key="NEW00001" width="1" height="2"/></p>',
  );
});

test("patchDrawing never touches an image it does not own", () => {
  assert.equal(patchDrawing(WRAPPED, "NOPE0000"), WRAPPED);
  assert.equal(patchDrawing(WRAPPED, undefined), WRAPPED);
});

test("pairState keeps the page while the note is only in the trash", () => {
  assert.equal(pairState(true, true), "paused");
  assert.equal(pairState(true, false), "active");
});

test("pairState deletes the page only when the note is gone", () => {
  assert.equal(pairState(true, undefined), "noteGone");
});

test("pairState pauses a note that moved to another parent", () => {
  assert.equal(pairState(true, undefined, true), "paused");
  assert.equal(pairState(true, undefined, false), "noteGone");
});

test("pairState ignores the library lookup when the note is a child", () => {
  assert.equal(pairState(true, false, true), "active");
  assert.equal(pairState(true, true, true), "paused");
});

test("pairState reports a page deleted on the tablet first", () => {
  assert.equal(pairState(false, undefined), "pageGone");
  assert.equal(pairState(false, true), "pageGone");
  assert.equal(pairState(false, false), "pageGone");
  assert.equal(pairState(false, undefined, true), "pageGone");
});

test("parses nested unordered lists into BULLET and BULLET2", () => {
  const html =
    "<h1>T</h1><ul><li><p>one</p>" +
    "<ul><li><p>one.a</p></li><li><p>one.b</p></li></ul></li>" +
    "<li><p>two</p></li></ul><p>after</p>";
  assert.deepEqual(htmlToParagraphs(html).body, [
    { style: S.BULLET, text: "one" },
    { style: S.BULLET2, text: "one.a" },
    { style: S.BULLET2, text: "one.b" },
    { style: S.BULLET, text: "two" },
    { style: S.PLAIN, text: "after" },
  ]);
});

test("nested list without <p> wrappers keeps text around the sublist", () => {
  const html =
    "<h1>T</h1><ul><li>parent<ol><li>child 1</li><li>child 2</li></ol>tail</li></ul>";
  assert.deepEqual(htmlToParagraphs(html).body, [
    { style: S.BULLET, text: "parent" },
    { style: S.BULLET2, text: "child 1" },
    { style: S.BULLET2, text: "child 2" },
    { style: S.BULLET, text: "tail" },
  ]);
});

test("nested lists round-trip through paragraphsToHtml", () => {
  const body = [
    { style: S.BULLET, text: "one" },
    { style: S.BULLET2, text: "one.a" },
    { style: S.BULLET2, text: "one.b" },
    { style: S.BULLET, text: "two" },
    { style: S.PLAIN, text: "after" },
    { style: S.BULLET, text: "three" },
    { style: S.BULLET2, text: "three.a" },
  ];
  const html = paragraphsToHtml("T", body);
  assert.ok(
    html.includes(
      "<ul><li><p>one</p><ul><li><p>one.a</p></li><li><p>one.b</p></li></ul></li><li><p>two</p></li></ul><p>after</p>",
    ),
    html,
  );
  assert.deepEqual(htmlToParagraphs(html).body, body);
});

test("paragraphsToHtml opens a list for a BULLET2 without a parent", () => {
  const html = paragraphsToHtml("T", [
    { style: S.BULLET2, text: "orphan" },
    { style: S.BULLET2, text: "sibling" },
    { style: S.PLAIN, text: "end" },
  ]);
  assert.ok(
    html.includes(
      "<ul><li><p>orphan</p><ul><li><p>sibling</p></li></ul></li></ul><p>end</p>",
    ),
    html,
  );
  assert.deepEqual(
    htmlToParagraphs(html).body.map((p) => p.text),
    ["orphan", "sibling", "end"],
  );
});

test("script and style blocks are skipped, even after characters that change length when lowercased", () => {
  // U+0130 lowercases to two code units, shifting offsets into a lowercased copy.
  const wide = "\u0130".repeat(40);
  const html =
    `<h1>T</h1><p>${wide} text</p>` +
    "<SCRIPT>var a = '<p>x</p>';</SCRIPT><p>after script</p>" +
    "<style>p { color: red }</STYLE><p>after style</p>";
  assert.deepEqual(htmlToParagraphs(html).body, [
    { style: S.PLAIN, text: `${wide} text` },
    { style: S.PLAIN, text: "after script" },
    { style: S.PLAIN, text: "after style" },
  ]);
  // An unterminated script swallows the rest instead of throwing.
  assert.deepEqual(htmlToParagraphs("<h1>T</h1><script>never closed").body, []);
});

test("ordered lists become bullets", () => {
  const html = "<h1>T</h1><ol><li><p>first</p></li><li><p>second</p></li></ol>";
  assert.deepEqual(htmlToParagraphs(html).body, [
    { style: S.BULLET, text: "first" },
    { style: S.BULLET, text: "second" },
  ]);
});

test("blockquote paragraphs stay separate paragraphs", () => {
  const html =
    "<h1>T</h1><blockquote><p>quoted one</p><p>quoted <em>two</em></p></blockquote><p>plain</p>";
  assert.deepEqual(htmlToParagraphs(html).body, [
    { style: S.PLAIN, text: "quoted one" },
    { style: S.PLAIN, text: "quoted two" },
    { style: S.PLAIN, text: "plain" },
  ]);
  assert.deepEqual(
    htmlToParagraphs("<h1>T</h1><blockquote>bare quote</blockquote>").body,
    [{ style: S.PLAIN, text: "bare quote" }],
  );
});

test("pre blocks and images", () => {
  const html =
    '<h1>T</h1><pre><code>let a = 1;\n  let b = &lt;2&gt;;</code></pre><p><img src="x.png"/></p><p>end</p>';
  assert.deepEqual(htmlToParagraphs(html).body, [
    { style: S.PLAIN, text: "let a = 1; let b = <2>;" },
    { style: S.PLAIN, text: "end" },
  ]);
});

test("tolerates malformed note HTML", () => {
  // Unclosed list items and paragraphs, stray closing tags, bare "<".
  const html =
    "</ul></li><h1>Title<ul><li>a<li>b</ul></blockquote><p>x < y<p>z</div>";
  const note = htmlToParagraphs(html);
  assert.equal(note.title, "Title");
  assert.deepEqual(note.body, [
    { style: S.BULLET, text: "a" },
    { style: S.BULLET, text: "b" },
    { style: S.PLAIN, text: "x < y" },
    { style: S.PLAIN, text: "z" },
  ]);
  assert.deepEqual(htmlToParagraphs("just text &amp; more"), {
    title: "just text & more",
    body: [],
  });
  assert.equal(htmlToParagraphs("<p>a<!-- <p>hidden</p> -->b</p>").title, "ab");
  assert.deepEqual(htmlToParagraphs(""), { title: "", body: [] });
});

test("legacyDrawingKey picks the one embedded SVG, never an ambiguous one", () => {
  // WRAPPED embeds USER0001 and DRAW0001.
  assert.equal(legacyDrawingKey(WRAPPED, ["DRAW0001"]), "DRAW0001");
  // An SVG attachment the body does not embed is not a candidate.
  assert.equal(legacyDrawingKey(WRAPPED, ["DRAW0001", "LOOSE000"]), "DRAW0001");
  // Two embedded SVGs: cannot tell which one is the plugin's.
  assert.equal(legacyDrawingKey(WRAPPED, ["DRAW0001", "USER0001"]), undefined);
  assert.equal(legacyDrawingKey(WRAPPED, []), undefined);
});

test("legacy adoption can replace the img of a lone embedded SVG", () => {
  const key = legacyDrawingKey(WRAPPED, ["USER0001"]);
  assert.equal(key, "USER0001");
  const out = patchDrawing(WRAPPED, key, {
    key: "NEW00001",
    width: 1,
    height: 2,
  });
  assert.ok(!out.includes("USER0001"));
  assert.ok(out.includes("NEW00001"));
});

test("staleDrawingKeys lists only embedded SVGs other than the kept one", () => {
  assert.deepEqual(staleDrawingKeys(WRAPPED, ["DRAW0001", "LOOSE000"]), [
    "DRAW0001",
  ]);
  assert.deepEqual(staleDrawingKeys(WRAPPED, ["DRAW0001"], "DRAW0001"), []);
  // PNG/JPEG attachments (not in svgKeys) are never listed.
  assert.deepEqual(staleDrawingKeys(WRAPPED, []), []);
});
