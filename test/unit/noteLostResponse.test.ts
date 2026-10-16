/**
 * syncNotes never retries the tablet write, because the server may have
 * applied it with only the response lost. After a failure it asks which of the
 * added pages exist and records the pairings for them, so the next sync does
 * not import those pages again as new notes.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  type RemarkableCloud,
  RemarkableError,
} from "../../src/remarkable/cloud";
import { syncNotes } from "../../src/sync/noteSync";
import type { DocState } from "../../src/sync/state";

const TABLET_CHANGED =
  "The tablet changed this document while syncing; nothing was written, the next sync retries";

function makeDoc(): DocState {
  return {
    attachmentKey: "ATT",
    libraryID: 1,
    rmDocId: "doc1",
    originalPageCount: 1,
    appendedPageCount: 0,
    pageBoxes: [],
    imported: {},
  };
}

/** A "reMarkable Note" made in Zotero that has no page on the tablet yet. */
const note = {
  key: "NOTE1",
  deleted: false,
  getNoteTitle: () => "reMarkable Note 1",
  getNote: () => "<h1>reMarkable Note 1</h1><p>hello</p>",
};
const att = {
  libraryID: 1,
  parentItem: { getNotes: () => [1] },
} as unknown as Zotero.Item;

beforeEach(() => {
  (globalThis as Record<string, unknown>).Zotero = {
    Items: { get: () => [note] },
    debug() {},
  };
});

interface Options {
  update: () => Error | undefined;
  /** Reports the added page as landed; undefined makes getPageIds fail. */
  landed: boolean | undefined;
}

function run({ update, landed }: Options) {
  const doc = makeDoc();
  const calls = { update: 0, getPageIds: 0 };
  let added: string[] = [];
  const cloud = {
    getDocumentFiles: async () => ({
      hash: "h1",
      content: { cPages: { pages: [] } },
      rm: new Map<string, Uint8Array>(),
      files: [],
    }),
    updateDocument: async (
      _id: string,
      changes: { pages?: Map<string, unknown> },
    ) => {
      calls.update++;
      added = [...(changes.pages?.keys() ?? [])];
      const err = update();
      if (err) throw err;
      return { hash: "h2", baseHash: "h1" };
    },
    getPageIds: async () => {
      calls.getPageIds++;
      if (landed === undefined) throw new Error("offline");
      return new Set(landed ? added : []);
    },
  } as unknown as RemarkableCloud;
  const result = syncNotes(
    cloud,
    att,
    doc,
    "11111111-1111-4111-8111-111111111111",
  );
  return { doc, calls, result, added: () => added };
}

test("a successful write pairs the new page with its note", async () => {
  const { doc, result, added } = run({
    update: () => undefined,
    landed: false,
  });
  assert.equal((await result).created, 1);
  assert.deepEqual(Object.keys(doc.notePages ?? {}), added());
  assert.equal(Object.values(doc.notePages ?? {})[0].noteKey, "NOTE1");
});

test("a lost response whose pages landed still records the pairing, and the write is not retried", async () => {
  const { doc, calls, result, added } = run({
    update: () => new Error("response lost"),
    landed: true,
  });
  await assert.rejects(result, /response lost/);
  assert.equal(calls.update, 1);
  assert.equal(calls.getPageIds, 1);
  assert.equal(added().length, 1);
  assert.equal(doc.notePages?.[added()[0]]?.noteKey, "NOTE1");
});

test("a failed write whose pages did not land records no pairing", async () => {
  const { doc, result } = run({
    update: () => new Error("connection reset"),
    landed: false,
  });
  await assert.rejects(result, /connection reset/);
  assert.deepEqual(doc.notePages ?? {}, {});
});

test("a write refused because the tablet changed records no pairing and does not look for pages", async () => {
  const { doc, calls, result } = run({
    update: () => new RemarkableError(TABLET_CHANGED),
    landed: true,
  });
  await assert.rejects(result, /tablet changed/);
  assert.equal(calls.getPageIds, 0);
  assert.deepEqual(doc.notePages ?? {}, {});
});

test("when the pages cannot be looked up the original error is thrown and nothing is recorded", async () => {
  const { doc, result } = run({
    update: () => new Error("response lost"),
    landed: undefined,
  });
  await assert.rejects(result, /response lost/);
  assert.deepEqual(doc.notePages ?? {}, {});
});
