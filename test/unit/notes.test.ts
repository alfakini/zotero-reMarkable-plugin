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
  htmlToParagraphs,
  isSyncedNoteTitle,
  landedPages,
  mergeConflict,
  nextNoteTitle,
  paragraphsToHtml,
  plainText,
  withTabletStyles,
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

test("landedPages reports the added pages that exist after a lost response", () => {
  assert.deepEqual(landedPages(["a", "b"], ["x", "a", "b"]), ["a", "b"]);
  // The write is one root swap: any added page present means it landed.
  assert.deepEqual(landedPages(["a", "b"], new Set(["b"])), ["b"]);
});

test("landedPages commits nothing when the pages are absent or unreadable", () => {
  assert.deepEqual(landedPages(["a"], ["x", "y"]), []);
  assert.deepEqual(landedPages(["a"], []), []);
  assert.deepEqual(landedPages(["a"], undefined), []);
  assert.deepEqual(landedPages([], ["a"]), []);
});
