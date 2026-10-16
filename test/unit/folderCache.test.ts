import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FolderMetadata,
  type IndexEntry,
  isTopLevelFolder,
} from "../../src/remarkable/cloud";
import { resolveFolderId } from "../../src/sync/engine";
import { SyncStateStore, type StateFileIO } from "../../src/sync/state";

const cacheOf = (folders: Record<string, string>) => ({
  getFolderId: (n: string) => folders[n],
  setFolderId: (n: string, id: string) => {
    folders[n] = id;
  },
});

/** Root index entries for these document ids. */
const rootOf = (...ids: string[]) =>
  new Map(
    ids.map(
      (id) =>
        [id, { id, hash: `h-${id}`, type: "0", subfiles: 0, size: 0 }] as const,
    ),
  );

/** A cloud whose ensureFolder / readMetadata are the given functions. */
const cloudOf = (
  ensureFolder: (name: string) => Promise<string>,
  readMetadata: (
    entry: IndexEntry,
  ) => Promise<FolderMetadata | undefined> = async () => undefined,
) => ({
  ensureFolder,
  readMetadata: readMetadata as (
    entry: IndexEntry,
  ) => Promise<Record<string, unknown> | undefined>,
});
const never = (what: string) => () => {
  throw new Error(what);
};

const folder = (over: Record<string, unknown> = {}) => ({
  type: "CollectionType",
  parent: "",
  visibleName: "Zotero",
  ...over,
});

test("isTopLevelFolder accepts only a live top-level folder with the configured name", () => {
  assert.equal(isTopLevelFolder(folder(), "Zotero"), true);
  assert.equal(isTopLevelFolder(folder({ deleted: false }), "Zotero"), true);
  assert.equal(isTopLevelFolder(undefined, "Zotero"), false);
  assert.equal(isTopLevelFolder(folder({ parent: "trash" }), "Zotero"), false);
  assert.equal(isTopLevelFolder(folder({ parent: "abc" }), "Zotero"), false);
  assert.equal(isTopLevelFolder(folder({ visibleName: "Z" }), "Zotero"), false);
  assert.equal(isTopLevelFolder(folder({ deleted: true }), "Zotero"), false);
  assert.equal(
    isTopLevelFolder(folder({ type: "DocumentType" }), "Zotero"),
    false,
  );
});

test("resolveFolderId uses a valid cached id without calling ensure", async () => {
  const cache = cacheOf({ Zotero: "f1" });
  const id = await resolveFolderId(
    cloudOf(never("ensure must not run"), async () => folder()),
    cache,
    "Zotero",
    rootOf("f1"),
  );
  assert.equal(id, "f1");
});

test("resolveFolderId does not read metadata when the id is not in the root", async () => {
  const id = await resolveFolderId(
    cloudOf(async () => "f2", never("must not read")),
    cacheOf({ Zotero: "gone" }),
    "Zotero",
    rootOf(),
  );
  assert.equal(id, "f2");
});

test("resolveFolderId falls back to ensure and updates the cache", async () => {
  const folders: Record<string, string> = { Zotero: "gone" };
  const calls: string[] = [];
  const ensure = async (n: string) => {
    calls.push(n);
    return "f2";
  };
  const cloud = cloudOf(ensure, async () => folder());
  const id = await resolveFolderId(
    cloud,
    cacheOf(folders),
    "Zotero",
    rootOf("f2"),
  );
  assert.equal(id, "f2");
  assert.deepEqual(calls, ["Zotero"]);
  assert.equal(folders.Zotero, "f2");
  // Second sync: the cache now hits.
  await resolveFolderId(cloud, cacheOf(folders), "Zotero", rootOf("f2"));
  assert.equal(calls.length, 1);
});

test("resolveFolderId replaces a cached folder whose metadata no longer matches", async () => {
  for (const meta of [
    undefined,
    folder({ parent: "trash" }),
    folder({ visibleName: "Renamed" }),
    folder({ deleted: true }),
  ]) {
    const folders: Record<string, string> = { Zotero: "old" };
    const id = await resolveFolderId(
      cloudOf(
        async () => "new",
        async () => meta,
      ),
      cacheOf(folders),
      "Zotero",
      rootOf("old"),
    );
    assert.equal(id, "new");
    assert.equal(folders.Zotero, "new");
  }
});

test("resolveFolderId needs no folder or cache for an empty name", async () => {
  const folders: Record<string, string> = {};
  const id = await resolveFolderId(
    cloudOf(never("ensure must not run"), never("must not read")),
    cacheOf(folders),
    "",
    rootOf(),
  );
  assert.equal(id, "");
  assert.deepEqual(folders, {});
});

test("the folder cache persists in the state file and old files still load", async () => {
  const files = new Map<string, string>();
  const io: StateFileIO = {
    exists: async (p) => files.has(p),
    readText: async (p) => files.get(p) ?? "",
    writeText: async (p, t) => void files.set(p, t),
    copy: async (a, b) => void files.set(b, files.get(a) ?? ""),
    makeDirectory: async () => {},
    parentDir: () => "/",
    logError: () => {},
  };
  files.set("/s.json", JSON.stringify({ version: 1, docs: {} }));
  const a = new SyncStateStore("/s.json", io);
  await a.load();
  assert.equal(a.getFolderId("Zotero"), undefined);
  a.setFolderId("Zotero", "f1");
  await a.save();
  const b = new SyncStateStore("/s.json", io);
  await b.load();
  assert.equal(b.getFolderId("Zotero"), "f1");
});
