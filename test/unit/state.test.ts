import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DocState,
  type StateFileIO,
  SyncStateStore,
} from "../../src/sync/state";

const PATH = "/data/remarkable-sync/state.json";

function memoryIO(files: Map<string, string> = new Map()) {
  const io: StateFileIO & { files: Map<string, string>; errors: unknown[] } = {
    files,
    errors: [],
    exists: async (p) => files.has(p),
    readText: async (p) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`ENOENT ${p}`);
      return t;
    },
    writeText: async (p, t) => {
      files.set(p, t);
    },
    copy: async (from, to) => {
      const t = files.get(from);
      if (t === undefined) throw new Error(`ENOENT ${from}`);
      files.set(to, t);
    },
    makeDirectory: async () => {},
    parentDir: (p) => p.slice(0, p.lastIndexOf("/")),
    logError: (e) => {
      io.errors.push(e);
    },
  };
  return io;
}

function doc(key: string): DocState {
  return {
    attachmentKey: key,
    libraryID: 1,
    rmDocId: `rm-${key}`,
    originalPageCount: 1,
    appendedPageCount: 0,
    pageBoxes: [],
    imported: {},
  };
}

test("state roundtrips through save and load", async () => {
  const io = memoryIO();
  const a = new SyncStateStore(PATH, io);
  await a.load();
  assert.deepEqual(a.all(), []);
  a.set(doc("AAAA"));
  await a.save();
  const b = new SyncStateStore(PATH, io);
  await b.load();
  assert.equal(b.get(1, "AAAA")?.rmDocId, "rm-AAAA");
});

test("save keeps the previous file as a backup", async () => {
  const io = memoryIO();
  const s = new SyncStateStore(PATH, io);
  await s.load();
  s.set(doc("AAAA"));
  await s.save();
  s.set(doc("BBBB"));
  await s.save();
  const bak = JSON.parse(io.files.get(`${PATH}.bak`)!);
  assert.deepEqual(Object.keys(bak.docs), ["1/AAAA"]);
});

test("a corrupt state file falls back to the backup and is restored", async () => {
  const io = memoryIO();
  const s = new SyncStateStore(PATH, io);
  await s.load();
  s.set(doc("AAAA"));
  await s.save();
  s.set(doc("BBBB"));
  await s.save();
  io.files.set(PATH, "{ not json");
  const r = new SyncStateStore(PATH, io);
  await r.load();
  assert.ok(r.get(1, "AAAA"));
  assert.equal(io.files.get(`${PATH}.corrupt`), "{ not json");
  // The next save must not replace the good backup with the bad file.
  await r.save();
  const bak = JSON.parse(io.files.get(`${PATH}.bak`)!);
  assert.deepEqual(Object.keys(bak.docs), ["1/AAAA"]);
});

async function corruptMainWithBackup(io: ReturnType<typeof memoryIO>) {
  const s = new SyncStateStore(PATH, io);
  await s.load();
  s.set(doc("AAAA"));
  await s.save();
  s.set(doc("BBBB"));
  await s.save();
  io.files.set(PATH, "{ not json");
}

test("a failed .corrupt copy does not stop the restore from the backup", async () => {
  const io = memoryIO();
  await corruptMainWithBackup(io);
  const copy = io.copy;
  io.copy = async (from, to) => {
    if (to === `${PATH}.corrupt`) throw new Error("EACCES corrupt");
    return copy(from, to);
  };
  const r = new SyncStateStore(PATH, io);
  await r.load();
  assert.ok(r.get(1, "AAAA"));
  assert.ok(io.errors.some((e) => /EACCES corrupt/.test(String(e))));
  // The main file was restored from the backup.
  assert.deepEqual(Object.keys(JSON.parse(io.files.get(PATH)!).docs), [
    "1/AAAA",
  ]);
  assert.equal(io.files.has(`${PATH}.corrupt`), false);
});

test("a failed restore keeps the good backup even if the next save fails", async () => {
  const io = memoryIO();
  await corruptMainWithBackup(io);
  const goodBackup = io.files.get(`${PATH}.bak`)!;
  const copy = io.copy;
  io.copy = async (from, to) => {
    if (to === PATH) throw new Error("EIO restore");
    return copy(from, to);
  };
  const r = new SyncStateStore(PATH, io);
  await r.load();
  assert.ok(r.get(1, "AAAA"));
  // The restore failure is surfaced, not swallowed.
  assert.ok(io.errors.some((e) => /EIO restore/.test(String(e))));
  assert.equal(io.files.get(PATH), "{ not json");
  // save() must not copy the bad main file over the good backup, even when
  // writing the main file then fails (a crash leaves the backup usable).
  const writeText = io.writeText;
  io.writeText = async () => {
    throw new Error("ENOSPC");
  };
  await assert.rejects(() => r.save(), /ENOSPC/);
  assert.equal(io.files.get(`${PATH}.bak`), goodBackup);
  // A later successful save replaces the main file and leaves the backup.
  io.writeText = writeText;
  await r.save();
  assert.equal(io.files.get(`${PATH}.bak`), goodBackup);
  assert.deepEqual(Object.keys(JSON.parse(io.files.get(PATH)!).docs), [
    "1/AAAA",
  ]);
});

test("a missing file starts empty", async () => {
  const s = new SyncStateStore(PATH, memoryIO());
  await s.load();
  assert.deepEqual(s.all(), []);
});

test("main file missing but backup readable uses the backup", async () => {
  const io = memoryIO(
    new Map([
      [
        `${PATH}.bak`,
        JSON.stringify({ version: 1, docs: { "1/AAAA": doc("AAAA") } }),
      ],
    ]),
  );
  const s = new SyncStateStore(PATH, io);
  await s.load();
  assert.ok(s.get(1, "AAAA"));
});

test("both files corrupt: load throws, nothing is overwritten, retry works", async () => {
  const io = memoryIO(
    new Map([
      [PATH, "garbage-main"],
      [`${PATH}.bak`, "garbage-bak"],
    ]),
  );
  const s = new SyncStateStore(PATH, io);
  await assert.rejects(() => s.load(), /unreadable/);
  assert.equal(io.files.get(PATH), "garbage-main");
  assert.equal(io.files.get(`${PATH}.bak`), "garbage-bak");
  assert.equal(io.files.get(`${PATH}.corrupt`), "garbage-main");
  // Still not loaded: saving is refused and the files stay untouched.
  await assert.rejects(() => s.save(), /not loaded/);
  assert.equal(io.files.get(PATH), "garbage-main");
  // The user fixes the file; the next load succeeds.
  io.files.set(PATH, JSON.stringify({ version: 1, docs: {} }));
  await s.load();
  assert.deepEqual(s.all(), []);
});

test("corrupt main with no backup throws instead of starting empty", async () => {
  const io = memoryIO(new Map([[PATH, "{"]]));
  const s = new SyncStateStore(PATH, io);
  await assert.rejects(() => s.load(), /no usable backup/);
  assert.equal(io.files.get(PATH), "{");
  assert.equal(io.files.get(`${PATH}.corrupt`), "{");
});

test("a state file with an unexpected layout counts as corrupt", async () => {
  const io = memoryIO(new Map([[PATH, "[1,2]"]]));
  await assert.rejects(() => new SyncStateStore(PATH, io).load(), /unreadable/);
});

function withImports(key: string, ...zoteroKeys: string[]): DocState {
  return {
    ...doc(key),
    imported: Object.fromEntries(
      zoteroKeys.map((k) => [
        `p1/${k}`,
        { zoteroKey: k, hash: "h", kind: "annotation" as const },
      ]),
    ),
  };
}

test("forgetting a document keeps its imported keys in the registry", () => {
  const store = new SyncStateStore(PATH, memoryIO());
  store.set({
    ...withImports("AAAA", "ANNOA", "ANNOB"),
    detachedImported: ["OLD1"],
  });
  store.forget(1, "AAAA");
  assert.equal(store.get(1, "AAAA"), undefined);
  assert.deepEqual(store.getDetached(1, "AAAA").sort(), [
    "ANNOA",
    "ANNOB",
    "OLD1",
  ]);
  assert.deepEqual(store.getDetached(1, "OTHER"), []);
  assert.deepEqual(store.getDetached(2, "AAAA"), []);
});

test("forget of an unknown document is a no-op", () => {
  const store = new SyncStateStore(PATH, memoryIO());
  store.forget(1, "NOPE");
  assert.deepEqual(store.getDetached(1, "NOPE"), []);
});

test("the registry survives save/load and repeated forgets accumulate", async () => {
  const io = memoryIO();
  const a = new SyncStateStore(PATH, io);
  await a.load();
  a.set(withImports("AAAA", "ANNOA"));
  a.forget(1, "AAAA");
  a.set(withImports("AAAA", "ANNOB"));
  a.forget(1, "AAAA");
  await a.save();
  const b = new SyncStateStore(PATH, io);
  await b.load();
  assert.deepEqual(b.getDetached(1, "AAAA").sort(), ["ANNOA", "ANNOB"]);
});

test("state files without a registry load, and tolerate a malformed one", async () => {
  const io = memoryIO(
    new Map([
      [
        PATH,
        JSON.stringify({ version: 1, docs: {}, detached: { "1/A": "bad" } }),
      ],
    ]),
  );
  const s = new SyncStateStore(PATH, io);
  await s.load();
  assert.deepEqual(s.getDetached(1, "A"), []);
  const old = new SyncStateStore(
    PATH,
    memoryIO(new Map([[PATH, JSON.stringify({ version: 1, docs: {} })]])),
  );
  await old.load();
  assert.deepEqual(old.getDetached(1, "A"), []);
});

test("removeDetached drops erased keys and prunes empty entries", async () => {
  const io = memoryIO();
  const s = new SyncStateStore(PATH, io);
  await s.load();
  s.addDetached(1, "AAAA", ["K1", "K2"]);
  s.removeDetached(1, "AAAA", ["K1", "UNKNOWN"]);
  assert.deepEqual(s.getDetached(1, "AAAA"), ["K2"]);
  s.removeDetached(1, "AAAA", ["K2"]);
  assert.deepEqual(s.getDetached(1, "AAAA"), []);
  await s.save();
  assert.equal("detached" in JSON.parse(io.files.get(PATH)!), false);
});

test("concurrent loads share one read and do not clobber later changes", async () => {
  const io = memoryIO(
    new Map([[PATH, JSON.stringify({ version: 1, docs: {} })]]),
  );
  let reads = 0;
  const readText = io.readText;
  io.readText = async (p) => {
    reads++;
    await new Promise((r) => setTimeout(r, 5));
    return readText(p);
  };
  const s = new SyncStateStore(PATH, io);
  const first = s.load();
  const second = s.load();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  s.set(doc("AAAA"));
  await s.load();
  assert.ok(s.get(1, "AAAA"));
  assert.equal(reads, 1);
});

test("a failed load can be retried after the shared promise settles", async () => {
  const io = memoryIO(new Map([[PATH, "{"]]));
  const s = new SyncStateStore(PATH, io);
  await assert.rejects(() => Promise.all([s.load(), s.load()]), /unreadable/);
  io.files.set(PATH, JSON.stringify({ version: 1, docs: {} }));
  await s.load();
  assert.deepEqual(s.all(), []);
});

test("the backup is refreshed once per load and still recovers a corrupt main file", async () => {
  const io = memoryIO();
  const s = new SyncStateStore(PATH, io);
  await s.load();
  s.set(doc("AAAA"));
  await s.save();

  // A new session: the first save snapshots the loaded state, later ones do not.
  const t = new SyncStateStore(PATH, io);
  await t.load();
  let backups = 0;
  const copy = io.copy;
  io.copy = async (from, to) => {
    if (to === `${PATH}.bak`) backups++;
    return copy(from, to);
  };
  t.set(doc("BBBB"));
  await t.save();
  t.set(doc("CCCC"));
  await t.save();
  t.set(doc("DDDD"));
  await t.save();
  assert.equal(backups, 1);
  const bak = JSON.parse(io.files.get(`${PATH}.bak`)!);
  assert.deepEqual(Object.keys(bak.docs), ["1/AAAA"]);

  // Corrupt main: the backup restores the state the session started with.
  io.files.set(PATH, "{ not json");
  const r = new SyncStateStore(PATH, io);
  await r.load();
  assert.ok(r.get(1, "AAAA"));
  assert.equal(r.get(1, "DDDD"), undefined);
  await r.save();
  assert.equal(backups, 2);
  assert.deepEqual(Object.keys(JSON.parse(io.files.get(`${PATH}.bak`)!).docs), [
    "1/AAAA",
  ]);
});

test("an unchanged state is not rewritten, a changed one is", async () => {
  const io = memoryIO();
  let writes = 0;
  const write = io.writeText;
  io.writeText = async (p, t) => {
    writes++;
    await write(p, t);
  };
  const s = new SyncStateStore(PATH, io);
  await s.load();
  s.set(doc("AAAA"));
  await s.save();
  await s.save();
  assert.equal(writes, 1);
  // DocState objects are mutated in place; the change must still be seen.
  s.get(1, "AAAA")!.lastSync = "now";
  await s.save();
  assert.equal(writes, 2);
  assert.equal(JSON.parse(io.files.get(PATH)!).docs["1/AAAA"].lastSync, "now");
  await s.save();
  assert.equal(writes, 2);
});

test("the state directory is created once", async () => {
  const io = memoryIO();
  let made = 0;
  io.makeDirectory = async () => {
    made++;
  };
  const s = new SyncStateStore(PATH, io);
  await s.load();
  await s.save();
  s.set(doc("AAAA"));
  await s.save();
  s.set(doc("BBBB"));
  await s.save();
  assert.equal(made, 1);
});

test("a skipped save leaves the backup at the pre-session state", async () => {
  const before = JSON.stringify({ version: 1, docs: { "1/OLD": doc("OLD") } });
  const io = memoryIO(new Map([[PATH, before]]));
  const s = new SyncStateStore(PATH, io);
  await s.load();
  // Unchanged since load: the first save still writes, refreshing the backup.
  await s.save();
  assert.equal(io.files.get(`${PATH}.bak`), before);
  s.set(doc("NEW"));
  await s.save();
  await s.save();
  // The backup is refreshed once per load: it still holds the pre-session text.
  assert.equal(io.files.get(`${PATH}.bak`), before);
  assert.ok(JSON.parse(io.files.get(PATH)!).docs["1/NEW"]);
});
