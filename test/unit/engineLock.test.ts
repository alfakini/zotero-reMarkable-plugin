import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemarkableCloud } from "../../src/remarkable/cloud";
import { SyncEngine } from "../../src/sync/engine";
import { Mutex } from "../../src/sync/mutex";
import type { SyncStateStore } from "../../src/sync/state";
import {
  FakeTablet,
  fakeAttachment,
  installGlobals,
  makeEngine,
  makeState,
  memoryIO,
} from "./engineHarness";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeEngine(
  lock: Mutex | undefined,
  log: string[],
  name: string,
  gate?: Promise<void>,
) {
  const state = {
    load: async () => {
      log.push(`${name} start`);
      await gate;
      log.push(`${name} end`);
    },
  } as unknown as SyncStateStore;
  const cloud = { clearPageCache() {} } as unknown as RemarkableCloud;
  return new SyncEngine(
    cloud,
    state,
    () => ({ folder: "", appendNotesPages: false, importHandwriting: false }),
    "author",
    lock,
  );
}

test("engines sharing a lock never run syncs concurrently", async () => {
  const lock = new Mutex();
  const log: string[] = [];
  const gate = deferred();
  const a = fakeEngine(lock, log, "a", gate.promise);
  const b = fakeEngine(lock, log, "b");
  const pa = a.sync([]);
  const pb = b.sync([]);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(log, ["a start"]);
  assert.equal(b.busy, true);
  gate.resolve();
  await Promise.all([pa, pb]);
  assert.deepEqual(log, ["a start", "a end", "b start", "b end"]);
  assert.equal(a.busy, false);
  assert.equal(b.busy, false);
});

test("engines without a shared lock keep independent locks", async () => {
  const log: string[] = [];
  const gate = deferred();
  const a = fakeEngine(undefined, log, "a", gate.promise);
  const b = fakeEngine(undefined, log, "b");
  const pa = a.sync([]);
  const pb = b.sync([]);
  await pb;
  assert.equal(b.busy, false);
  assert.equal(a.busy, true);
  gate.resolve();
  await pa;
});

/**
 * Two engines over the same state, cloud and Mutex, with one tracked
 * document. The first state.load() (the running sync's) waits on `gate`;
 * `log` records every load and every cloud trash call.
 */
async function lockedPair() {
  const z = installGlobals();
  z.addItem(1, "IMPORTED");
  const io = memoryIO();
  const seed = makeState(io);
  await seed.load();
  seed.set({
    attachmentKey: "ATTKEY01",
    libraryID: 1,
    rmDocId: "rm-doc",
    originalPageCount: 1,
    appendedPageCount: 0,
    pageBoxes: [],
    imported: {
      "p1:a": { zoteroKey: "IMPORTED", hash: "h", kind: "annotation" },
    },
  });
  await seed.save();

  const state = makeState(io);
  const log: string[] = [];
  const gate = deferred();
  const realLoad = state.load.bind(state);
  let loads = 0;
  state.load = async () => {
    const n = ++loads;
    log.push(`load ${n}`);
    if (n === 1) await gate.promise;
    return realLoad();
  };
  const tablet = new FakeTablet();
  tablet.docs.set("rm-doc", {
    hash: "h",
    name: "Paper",
    pdf: new Uint8Array(),
    pageCount: 1,
  });
  const cloud = tablet.cloud();
  const realTrash = cloud.trashDocument.bind(cloud);
  cloud.trashDocument = async (id: string) => {
    log.push(`trash ${id}`);
    return realTrash(id);
  };
  const lock = new Mutex();
  const a = makeEngine({ cloud, state, lock });
  const b = makeEngine({ cloud, state, lock });
  const att = fakeAttachment({
    key: "ATTKEY01",
    path: "/x.pdf",
    title: { value: "t" },
  });
  return { z, log, gate, a, b, att, state };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test("remove waits for a running sync, on the same engine and on one sharing the lock", async () => {
  for (const sameEngine of [true, false]) {
    const { log, gate, a, b, att } = await lockedPair();
    const running = a.sync([]);
    await settle();
    assert.deepEqual(log, ["load 1"]);
    assert.equal(a.busy, true);
    assert.equal(b.busy, true);

    const removing = (sameEngine ? a : b).remove(att);
    await settle();
    // Not started: no state load of its own, nothing sent to the tablet.
    assert.deepEqual(log, ["load 1"], `sameEngine=${sameEngine}`);
    assert.equal(a.busy, true);

    gate.resolve();
    await running;
    assert.equal(await removing, true);
    assert.deepEqual(log, ["load 1", "load 2", "trash rm-doc"]);
    assert.equal(a.busy, false);
    assert.equal(b.busy, false);
  }
});

test("removeImported waits for a running sync, on the same engine and on one sharing the lock", async () => {
  for (const sameEngine of [true, false]) {
    const { z, log, gate, a, b, att, state } = await lockedPair();
    const running = a.sync([]);
    await settle();

    const cleaning = (sameEngine ? a : b).removeImported([att], true);
    await settle();
    assert.deepEqual(log, ["load 1"], `sameEngine=${sameEngine}`);
    assert.deepEqual(z.erased, [], "nothing erased while the sync runs");
    assert.equal(b.busy, true);

    gate.resolve();
    await running;
    assert.equal(await cleaning, 1);
    assert.deepEqual(z.erased, ["IMPORTED"]);
    assert.deepEqual(state.get(1, "ATTKEY01")?.imported, {});
    assert.equal(a.busy, false);
    assert.equal(b.busy, false);
  }
});

test("queued operations run one at a time in call order and busy stays true until the last", async () => {
  const { log, gate, a, b, att } = await lockedPair();
  const running = a.sync([]);
  const removing = b.remove(att);
  const cleaning = a.removeImported([att]);
  await settle();
  gate.resolve();
  await running;
  await removing;
  // The cleanup is still queued behind the removal.
  assert.equal(a.busy, true);
  await cleaning;
  assert.deepEqual(log, ["load 1", "load 2", "trash rm-doc", "load 3"]);
  assert.equal(a.busy, false);
});
