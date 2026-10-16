/**
 * The destructive steps of writing a note come last: import the new drawing,
 * save the note, and only then erase the old drawing. A failed save must keep
 * the old drawing and erase only what this call created.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ParagraphStyle as S } from "../../src/remarkable/rmscene";
import { saveNote, writeSyncedNote } from "../../src/sync/zotero";

let log: string[];
let items: Map<number, FakeItem>;
let notes: Map<string, FakeNote>;
let nextId: number;
const behavior = {
  /** The nth saveTx call on any note throws (1-based); 0 never. */
  failSaveAt: 0,
  saveCalls: 0,
  failImport: false,
  /** Keys whose eraseTx throws. */
  failErase: new Set<string>(),
};
let logged: unknown[];

class FakeItem {
  id = ++nextId;
  libraryID = 1;
  constructor(
    public key: string,
    public attachmentContentType = "image/svg+xml",
  ) {
    items.set(this.id, this);
  }
  async eraseTx() {
    if (behavior.failErase.has(this.key)) throw new Error(`erase ${this.key}`);
    log.push(`erase ${this.key}`);
  }
}

class FakeNote {
  id = ++nextId;
  key = `N${this.id}`;
  libraryID = 1;
  parentID?: number;
  html = "";
  tags: string[] = [];
  attachments: FakeItem[] = [];
  getNote() {
    return this.html;
  }
  setNote(html: string) {
    this.html = html;
  }
  addTag(tag: string) {
    this.tags.push(tag);
  }
  getAttachments() {
    return this.attachments.map((a) => a.id);
  }
  async saveTx() {
    if (++behavior.saveCalls === behavior.failSaveAt) {
      throw new Error("save failed");
    }
    log.push(`save ${this.key}`);
    notes.set(this.key, this);
  }
  async eraseTx() {
    if (behavior.failErase.has(this.key)) throw new Error(`erase ${this.key}`);
    log.push(`erase ${this.key}`);
    notes.delete(this.key);
  }
}

beforeEach(() => {
  log = [];
  logged = [];
  items = new Map();
  notes = new Map();
  nextId = 0;
  behavior.failSaveAt = 0;
  behavior.saveCalls = 0;
  behavior.failImport = false;
  behavior.failErase = new Set();
  (globalThis as Record<string, unknown>).Zotero = {
    Item: FakeNote,
    Items: {
      getByLibraryAndKey: (_lib: number, key: string) =>
        notes.get(key) ?? false,
      get: (ids: number[]) => ids.map((id) => items.get(id)),
    },
    Attachments: {
      importEmbeddedImage: async (args: { parentItemID: number }) => {
        if (behavior.failImport) throw new Error("import failed");
        const image = new FakeItem("NEWIMG");
        log.push(`import ${image.key}`);
        // Like Zotero, the image becomes an attachment of its parent note.
        for (const n of notes.values()) {
          if (n.id === args.parentItemID) n.attachments.push(image);
        }
        return image;
      },
    },
    logError: (e: unknown) => logged.push(e),
  };
});

const attachment = { parentID: 7, libraryID: 1 } as unknown as Zotero.Item;
const drawing = { markup: "<svg/>", width: 10, height: 20 };
const candidate = { title: "Page", text: "hi", svg: drawing } as Parameters<
  typeof saveNote
>[1];
const body = [{ style: S.PLAIN, text: "text" }];

/** A note that exists, embeds the drawing OLD, and has OLD as an attachment. */
function existingNote() {
  const note = new FakeNote();
  note.parentID = 7;
  note.html = '<p><img data-attachment-key="OLD" width="1" height="1"/></p>';
  note.attachments.push(new FakeItem("OLD"));
  notes.set(note.key, note);
  return note;
}

function update(note: FakeNote, kind: "synced" | "imported") {
  return kind === "synced"
    ? writeSyncedNote(attachment, note.key, "T", body, drawing, {
        rewriteBody: false,
        drawingKey: "OLD",
      })
    : saveNote(attachment, candidate, note.key);
}

for (const kind of ["synced", "imported"] as const) {
  test(`${kind} note: the old drawing is erased only after the save`, async () => {
    const note = existingNote();
    await update(note, kind);
    assert.deepEqual(log, ["import NEWIMG", `save ${note.key}`, "erase OLD"]);
    assert.match(note.html, /data-attachment-key="NEWIMG"/);
    assert.doesNotMatch(note.html, /data-attachment-key="OLD"/);
  });

  test(`${kind} note: a failed save keeps the old drawing and the note`, async () => {
    const note = existingNote();
    behavior.failSaveAt = 1;
    await assert.rejects(update(note, kind), /^Error: save failed$/);
    // Only the image this call imported goes; never the old one or the note.
    assert.deepEqual(log, ["import NEWIMG", "erase NEWIMG"]);
    assert.ok(notes.has(note.key));
  });

  test(`${kind} note: a failed erase of the new image is logged, not thrown over the save error`, async () => {
    const note = existingNote();
    behavior.failSaveAt = 1;
    behavior.failErase.add("NEWIMG");
    await assert.rejects(update(note, kind), /^Error: save failed$/);
    assert.equal(logged.length, 1);
    assert.match(String(logged[0]), /erase NEWIMG/);
    assert.ok(!log.includes("erase OLD"));
    assert.ok(notes.has(note.key));
  });
}

test("a note created by this call is erased when the save fails", async () => {
  // The first save creates the note; the second one fills it and fails.
  behavior.failSaveAt = 2;
  await assert.rejects(
    writeSyncedNote(attachment, undefined, "T", body, drawing, {
      rewriteBody: true,
    }),
    /^Error: save failed$/,
  );
  assert.deepEqual(log.slice(1), ["import NEWIMG", "erase NEWIMG", "erase N1"]);
  assert.equal(notes.size, 0);
});

test("an imported note created by this call is erased when the import fails", async () => {
  behavior.failImport = true;
  await assert.rejects(
    saveNote(attachment, candidate),
    /^Error: import failed$/,
  );
  assert.equal(notes.size, 0);
  assert.ok(!log.includes("erase NEWIMG"));
});

test("a failed erase of the created note is logged, not thrown over the save error", async () => {
  behavior.failSaveAt = 2;
  behavior.failErase.add("N1");
  await assert.rejects(saveNote(attachment, candidate), /^Error: save failed$/);
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]), /erase N1/);
  // The new image is still cleaned up even though the note could not be.
  assert.ok(log.includes("erase NEWIMG"));
});

test("a successful create erases nothing", async () => {
  await saveNote(attachment, candidate);
  assert.ok(!log.some((l) => l.startsWith("erase")));
});

test("a legacy record without a drawingKey patches the img and erases nothing", async () => {
  const note = existingNote();
  await writeSyncedNote(attachment, note.key, "T", body, drawing, {
    rewriteBody: false,
    adoptLegacyDrawing: true,
  });
  assert.deepEqual(log, ["import NEWIMG", `save ${note.key}`]);
  assert.match(note.html, /data-attachment-key="NEWIMG"/);
  assert.doesNotMatch(note.html, /data-attachment-key="OLD"/);
});

test("only the recorded drawingKey is erased, never another attachment", async () => {
  const note = existingNote();
  note.attachments.push(new FakeItem("USER"));
  await update(note, "synced");
  assert.deepEqual(log, ["import NEWIMG", `save ${note.key}`, "erase OLD"]);
  assert.ok(!log.includes("erase USER"));
});

test("a recorded drawingKey that is no longer attached erases nothing", async () => {
  const note = existingNote();
  note.attachments = [];
  await update(note, "synced");
  assert.ok(!log.some((l) => l.startsWith("erase")));
});

test("a pre-existing note is never erased, even when the save fails", async () => {
  const note = existingNote();
  behavior.failSaveAt = 1;
  await assert.rejects(update(note, "synced"), /^Error: save failed$/);
  assert.ok(!log.includes(`erase ${note.key}`));
  assert.ok(notes.has(note.key));
});
