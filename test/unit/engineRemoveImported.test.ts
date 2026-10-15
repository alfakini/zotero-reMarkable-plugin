import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocState } from "../../src/sync/state";
import {
  FakeTablet,
  diskState,
  fakeAttachment,
  installGlobals,
  makeEngine,
  makeState,
  memoryIO,
} from "./engineHarness";

const LIB = 1;
const ATT = "ATTKEY01";

function trackedDoc(): DocState {
  return {
    attachmentKey: ATT,
    libraryID: LIB,
    rmDocId: "rm-doc",
    originalPageCount: 1,
    appendedPageCount: 0,
    pageBoxes: [],
    rmDocHash: "hash-1",
    imported: {
      "p1:a": { zoteroKey: "IMPORTED", hash: "h1", kind: "annotation" },
    },
    detachedImported: ["DETACHED"],
  };
}

/** Engine over a saved state with imported, detached and registry keys. */
async function setup() {
  const z = installGlobals();
  // The user's own objects must never be touched.
  for (const key of ["IMPORTED", "DETACHED", "REGISTRY", "USER_ANNOT"])
    z.addItem(LIB, key);
  const io = memoryIO();
  const seed = makeState(io);
  await seed.load();
  seed.set(trackedDoc());
  seed.addDetached(LIB, ATT, ["REGISTRY"]);
  // A second attachment with its own registry key that must stay.
  seed.addDetached(LIB, "OTHERATT", ["OTHER_REGISTRY"]);
  z.addItem(LIB, "OTHER_REGISTRY");
  await seed.save();
  const state = makeState(io);
  const engine = makeEngine({ cloud: new FakeTablet().cloud(), state });
  const att = fakeAttachment({
    key: ATT,
    path: "/x.pdf",
    title: { value: "t" },
  });
  return { z, io, state, engine, att };
}

test("removeImported erases imported, detached and registry keys and nothing else", async () => {
  const { z, io, state, engine, att } = await setup();
  const n = await engine.removeImported([att]);
  assert.equal(n, 3);
  assert.deepEqual([...z.erased].sort(), ["DETACHED", "IMPORTED", "REGISTRY"]);
  assert.ok(z.has(LIB, "USER_ANNOT"), "user object kept");
  assert.ok(z.has(LIB, "OTHER_REGISTRY"), "other attachment's key kept");

  const doc = state.get(LIB, ATT);
  assert.ok(doc);
  assert.equal(doc.detachedImported, undefined);
  assert.deepEqual(state.getDetached(LIB, ATT), []);
  assert.deepEqual(state.getDetached(LIB, "OTHERATT"), ["OTHER_REGISTRY"]);
  // Without reimport the records stay, so nothing is pulled back.
  assert.deepEqual(Object.keys(doc.imported), ["p1:a"]);
  assert.equal(doc.rmDocHash, "hash-1");

  // The cleanup is persisted, not only held in memory.
  const disk = diskState(io);
  assert.equal(disk.docs[`${LIB}/${ATT}`].detachedImported, undefined);
  assert.deepEqual(disk.detached, { [`${LIB}/OTHERATT`]: ["OTHER_REGISTRY"] });
});

test("removeImported with reimport also clears the imported records and the hash", async () => {
  const { z, io, state, engine, att } = await setup();
  await engine.removeImported([att], true);
  assert.deepEqual([...z.erased].sort(), ["DETACHED", "IMPORTED", "REGISTRY"]);
  const doc = state.get(LIB, ATT);
  assert.ok(doc);
  assert.deepEqual(doc.imported, {});
  assert.equal(doc.detachedImported, undefined);
  assert.equal(doc.rmDocHash, undefined);
  const disk = diskState(io);
  assert.deepEqual(disk.docs[`${LIB}/${ATT}`].imported, {});
});

test("removeImported counts only objects that still exist and handles a forgotten document", async () => {
  const { z, state, engine, att } = await setup();
  // The document was forgotten (its keys live in the registry only) and the
  // user already deleted one imported object by hand.
  await state.load();
  state.forget(LIB, ATT);
  assert.deepEqual(state.getDetached(LIB, ATT).sort(), [
    "DETACHED",
    "IMPORTED",
    "REGISTRY",
  ]);
  z.remove(LIB, "IMPORTED");
  const n = await engine.removeImported([att]);
  assert.equal(n, 2);
  assert.deepEqual([...z.erased].sort(), ["DETACHED", "REGISTRY"]);
  assert.ok(z.has(LIB, "USER_ANNOT"));
  assert.deepEqual(state.getDetached(LIB, ATT), []);
});
