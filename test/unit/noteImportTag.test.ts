import assert from "node:assert/strict";
import { test } from "node:test";
import { ParagraphStyle as S } from "../../src/remarkable/rmscene";
import { IMPORT_TAG, saveNote, writeSyncedNote } from "../../src/sync/zotero";

class FakeNote {
  static all = new Map<string, FakeNote>();
  static count = 0;
  id = ++FakeNote.count;
  key = `N${this.id}`;
  libraryID = 1;
  parentID?: number;
  html = "";
  tags: string[] = [];
  getNote() {
    return this.html;
  }
  setNote(html: string) {
    this.html = html;
  }
  addTag(tag: string) {
    if (!this.tags.includes(tag)) this.tags.push(tag);
  }
  getAttachments() {
    return [];
  }
  async saveTx() {
    FakeNote.all.set(this.key, this);
  }
  async eraseTx() {
    FakeNote.all.delete(this.key);
  }
}

function setup() {
  FakeNote.all.clear();
  (globalThis as Record<string, unknown>).Zotero = {
    Item: FakeNote,
    Items: {
      getByLibraryAndKey: (_lib: number, key: string) =>
        FakeNote.all.get(key) ?? false,
      get: (ids: unknown[]) => ids,
    },
    logError() {},
  };
  return { parentID: 7, libraryID: 1 } as unknown as Zotero.Item;
}

const body = [{ style: S.PLAIN, text: "text" }];
const opts = { rewriteBody: true };

test("a synced note is tagged when created and not when updated", async () => {
  const att = setup();
  const created = await writeSyncedNote(
    att,
    undefined,
    "T",
    body,
    undefined,
    opts,
  );
  const note = FakeNote.all.get(created.key);
  assert.ok(note);
  assert.deepEqual(note.tags, [IMPORT_TAG]);

  // The user removes the tag; a later update must not bring it back.
  note.tags = [];
  await writeSyncedNote(att, created.key, "T2", body, undefined, opts);
  assert.deepEqual(note.tags, []);
});

test("updating a user's own paired note leaves its tags alone", async () => {
  const att = setup();
  const own = new FakeNote();
  own.parentID = 7;
  own.html = "<h1>reMarkable Note 7</h1><p>mine</p>";
  await own.saveTx();
  await writeSyncedNote(
    att,
    own.key,
    "reMarkable Note 7",
    body,
    undefined,
    opts,
  );
  assert.deepEqual(own.tags, []);
});

test("an imported note is tagged on create and on every update", async () => {
  const att = setup();
  const cand = { title: "Page", text: "hi" } as Parameters<typeof saveNote>[1];
  const key = await saveNote(att, cand);
  const note = FakeNote.all.get(key);
  assert.ok(note);
  assert.deepEqual(note.tags, [IMPORT_TAG]);
  note.tags = [];
  await saveNote(att, cand, key);
  assert.deepEqual(note.tags, [IMPORT_TAG]);
});
