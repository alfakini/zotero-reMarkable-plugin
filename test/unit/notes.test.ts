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
  embeddedImageKeys,
  eraseIfCreatedOnError,
  htmlToParagraphs,
  isSyncedNoteTitle,
  landedPages,
  mergeConflict,
  nextNoteTitle,
  paragraphsToHtml,
  patchDrawing,
  legacyDrawingKey,
  staleDrawingKeys,
  importSaveThenErase,
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

test("erases a note created in this call when a later step throws, then rethrows", async () => {
  let erased = 0;
  await assert.rejects(
    eraseIfCreatedOnError(
      true,
      async () => {
        erased++;
      },
      async () => {
        throw new Error("importEmbeddedImage failed");
      },
    ),
    /importEmbeddedImage failed/,
  );
  assert.equal(erased, 1);
});

test("never erases a pre-existing note when a step throws", async () => {
  let erased = 0;
  await assert.rejects(
    eraseIfCreatedOnError(
      false,
      async () => {
        erased++;
      },
      async () => {
        throw new Error("boom");
      },
    ),
    /boom/,
  );
  assert.equal(erased, 0);
});

test("a failing cleanup does not mask the original error", async () => {
  await assert.rejects(
    eraseIfCreatedOnError(
      true,
      async () => {
        throw new Error("erase failed");
      },
      async () => {
        throw new Error("original");
      },
    ),
    /original/,
  );
});

test("a failing cleanup is reported to onCleanupError and the original error is thrown", async () => {
  const reported: unknown[] = [];
  const cleanupErr = new Error("erase failed");
  await assert.rejects(
    eraseIfCreatedOnError(
      true,
      async () => {
        throw cleanupErr;
      },
      async () => {
        throw new Error("original");
      },
      (e) => reported.push(e),
    ),
    /original/,
  );
  assert.deepEqual(reported, [cleanupErr]);
});

test("onCleanupError is not called when the cleanup succeeds or is not needed", async () => {
  const reported: unknown[] = [];
  await assert.rejects(
    eraseIfCreatedOnError(
      true,
      async () => {},
      async () => {
        throw new Error("boom");
      },
      (e) => reported.push(e),
    ),
    /boom/,
  );
  await assert.rejects(
    eraseIfCreatedOnError(
      false,
      async () => {
        throw new Error("never runs");
      },
      async () => {
        throw new Error("boom");
      },
      (e) => reported.push(e),
    ),
    /boom/,
  );
  assert.deepEqual(reported, []);
});

test("a throwing onCleanupError does not mask the original error", async () => {
  await assert.rejects(
    eraseIfCreatedOnError(
      true,
      async () => {
        throw new Error("erase failed");
      },
      async () => {
        throw new Error("original");
      },
      () => {
        throw new Error("logger broke");
      },
    ),
    /original/,
  );
});

test("keeps a created note and returns the result when every step succeeds", async () => {
  let erased = 0;
  const out = await eraseIfCreatedOnError(
    true,
    async () => {
      erased++;
    },
    async () => ({ key: "NOTE1" }),
  );
  assert.deepEqual(out, { key: "NOTE1" });
  assert.equal(erased, 0);
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

function swapWorld(failSave: boolean) {
  const log: string[] = [];
  return {
    log,
    run: () =>
      importSaveThenErase<string>({
        importImage: async () => {
          log.push("import");
          return "NEW";
        },
        save: async (img) => {
          log.push(`save:${img}`);
          if (failSave) throw new Error("save failed");
        },
        eraseImage: async (img) => {
          log.push(`eraseNew:${img}`);
        },
        eraseOld: async () => {
          log.push("eraseOld");
        },
      }),
  };
}

test("importSaveThenErase erases the old drawings only after the save", async () => {
  const w = swapWorld(false);
  assert.equal(await w.run(), "NEW");
  assert.deepEqual(w.log, ["import", "save:NEW", "eraseOld"]);
});

test("importSaveThenErase keeps the old drawings and drops the new image when the save fails", async () => {
  const w = swapWorld(true);
  await assert.rejects(w.run(), /save failed/);
  assert.deepEqual(w.log, ["import", "save:NEW", "eraseNew:NEW"]);
});

test("importSaveThenErase reports a failed image cleanup and still throws the save error", async () => {
  const reported: unknown[] = [];
  const cleanupErr = new Error("erase image failed");
  await assert.rejects(
    importSaveThenErase<string>({
      importImage: async () => "NEW",
      save: async () => {
        throw new Error("save failed");
      },
      eraseImage: async () => {
        throw cleanupErr;
      },
      eraseOld: async () => {},
      onCleanupError: (e) => reported.push(e),
    }),
    /save failed/,
  );
  assert.deepEqual(reported, [cleanupErr]);
});

test("importSaveThenErase throws the save error when the image cleanup fails and nothing listens", async () => {
  await assert.rejects(
    importSaveThenErase<string>({
      importImage: async () => "NEW",
      save: async () => {
        throw new Error("save failed");
      },
      eraseImage: async () => {
        throw new Error("erase image failed");
      },
      eraseOld: async () => {},
    }),
    /save failed/,
  );
});

test("importSaveThenErase saves a note without a drawing", async () => {
  const log: string[] = [];
  const img = await importSaveThenErase<string>({
    importImage: async () => undefined,
    save: async (i) => {
      log.push(`save:${i}`);
    },
    eraseImage: async () => {
      log.push("eraseNew");
    },
    eraseOld: async () => {
      log.push("eraseOld");
    },
  });
  assert.equal(img, undefined);
  assert.deepEqual(log, ["save:undefined", "eraseOld"]);
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
