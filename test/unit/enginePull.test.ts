import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONVERTER_VERSION } from "../../src/sync/convert";
import { keysToErase, needsPull, nextRmDocHash } from "../../src/sync/engine";
import {
  FakeTablet,
  fakeAttachment,
  installGlobals,
  makeEngine,
  makePdf,
  makeState,
  memoryIO,
} from "./engineHarness";

const imported = {
  "p1/g/a": { kind: "annotation" as const },
  "p1/i/b": { kind: "annotation" as const },
  "p1/margin": { kind: "note" as const },
  "p2/g/c": { kind: "annotation" as const },
  "p2/t": { kind: "annotation" as const },
  "p3/page": { kind: "note" as const },
};
const none = new Set<string>();

test("erases imported records that are no longer present", () => {
  const seen = new Set(["p1/g/a"]);
  assert.deepEqual(keysToErase(imported, seen, none, true).sort(), [
    "p1/i/b",
    "p1/margin",
    "p2/g/c",
    "p2/t",
    "p3/page",
  ]);
});

test("keeps records of unreadable pages", () => {
  const out = keysToErase(imported, none, new Set(["p2", "p3"]), true);
  assert.deepEqual(out.sort(), ["p1/g/a", "p1/i/b", "p1/margin"]);
});

test("keeps ink and notes when handwriting import is off", () => {
  const out = keysToErase(imported, none, none, false);
  assert.deepEqual(out.sort(), ["p1/g/a", "p2/g/c", "p2/t"]);
});

test("still erases gone highlights when handwriting import is off", () => {
  const seen = new Set(["p1/g/a", "p2/t"]);
  assert.deepEqual(keysToErase(imported, seen, none, false), ["p2/g/c"]);
});

test("does not match page ids that merely share a prefix", () => {
  const out = keysToErase(
    { "p10/g/x": { kind: "annotation" } },
    none,
    new Set(["p1"]),
    true,
  );
  assert.deepEqual(out, ["p10/g/x"]);
});

test("pull is needed when the previous pull was incomplete", () => {
  const doc = { rmDocHash: "h", converterVersion: 3 };
  assert.equal(needsPull(doc, "h", 3), false);
  assert.equal(needsPull(doc, "other", 3), true);
  assert.equal(needsPull(doc, "h", 4), true);
  assert.equal(needsPull({ ...doc, pullIncomplete: true }, "h", 3), true);
});

test("documents imported by converter version 3 are refreshed", () => {
  const doc = { rmDocHash: "h", converterVersion: 3 };
  assert.ok(CONVERTER_VERSION >= 4);
  assert.equal(needsPull(doc, "h", CONVERTER_VERSION), true);
});

test("nextRmDocHash records the new hash only when the tablet did not change", () => {
  // Merged onto exactly what we last pulled: safe to advance.
  assert.equal(nextRmDocHash("h1", { baseHash: "h1", hash: "h2" }), "h2");
  // The tablet committed after the pull: the next sync must pull first.
  assert.equal(nextRmDocHash("h1", { baseHash: "h9", hash: "h2" }), undefined);
  // Nothing recorded (never pulled, or reset): never claim to be up to date.
  assert.equal(
    nextRmDocHash(undefined, { baseHash: "h1", hash: "h2" }),
    undefined,
  );
  // A change that did nothing keeps the recorded hash.
  assert.equal(nextRmDocHash("h1", { baseHash: "h1", hash: "h1" }), "h1");
});

test("records of an unreadable page are kept, those of an empty page erased", () => {
  const out = keysToErase(
    {
      "p2/g/x": { kind: "annotation" },
      "p3/g/y": { kind: "annotation" },
    },
    new Set(),
    new Set(["p3"]),
    true,
  );
  assert.deepEqual(out, ["p2/g/x"]);
});

// pull() driven end to end against a fake tablet and Zotero.

const LIB = 1;
const ATT = "ATTKEY01";
const PATH = "/library/paper.pdf";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
/** Two highlights per page. */
const HIGHLIGHTS = fixture("Wikipedia_highlighted_p1.rm");
const STROKES = fixture("Normal_A_stroke_2_layers.rm");

/** A .content listing these pages in order; `redir` is the PDF page index. */
const content = (...pages: { id: string; redir: number }[]) => ({
  cPages: {
    pages: pages.map((p, i) => ({
      id: p.id,
      idx: { value: `b${String.fromCharCode(97 + i)}` },
      redir: { value: p.redir },
    })),
  },
});
const p1 = { id: "p1", redir: 0 };
const p2 = { id: "p2", redir: 1 };

async function setup(importHandwriting = false) {
  const z = installGlobals();
  z.files.set(PATH, await makePdf(2));
  const io = memoryIO();
  const tablet = new FakeTablet();
  const att = fakeAttachment({
    key: ATT,
    path: PATH,
    title: { value: "Paper" },
  });
  const boot = async () => {
    const state = makeState(io);
    await state.load();
    return {
      state,
      engine: makeEngine({ cloud: tablet.cloud(), state, importHandwriting }),
    };
  };
  await (await boot()).engine.sync([att]);
  const [rmDocId] = [...tablet.docs.keys()];
  const imported = async () => {
    const { state } = await boot();
    return state.get(LIB, ATT)!;
  };
  return { z, io, tablet, att, boot, rmDocId, imported };
}

test("pull imports highlights from every page", async () => {
  const { z, tablet, att, boot, rmDocId, imported } = await setup();
  tablet.setFiles(
    rmDocId,
    content(p1, p2),
    new Map([
      ["p1", HIGHLIGHTS],
      ["p2", HIGHLIGHTS],
    ]),
  );
  const report = await (await boot()).engine.sync([att]);
  assert.deepEqual(report.errors, []);
  assert.equal(report.imported, 4);
  assert.equal(z.saved.length, 4);
  const doc = await imported();
  assert.equal(Object.keys(doc.imported).length, 4);
  assert.equal(doc.converterVersion, CONVERTER_VERSION);
  assert.equal(doc.rmDocHash, tablet.docs.get(rmDocId)?.hash);
  assert.equal(doc.pullIncomplete, undefined);
});

test("a page without an .rm blob is empty and its imports are erased; a blob that fails to parse is unreadable and keeps them", async () => {
  const { z, tablet, att, boot, rmDocId, imported } = await setup();
  tablet.setFiles(
    rmDocId,
    content(p1, p2),
    new Map([
      ["p1", HIGHLIGHTS],
      ["p2", HIGHLIGHTS],
    ]),
  );
  await (await boot()).engine.sync([att]);
  const before = await imported();
  const p1Keys = Object.keys(before.imported).filter((k) =>
    k.startsWith("p1/"),
  );
  const p2Keys = Object.keys(before.imported).filter((k) =>
    k.startsWith("p2/"),
  );
  assert.equal(p1Keys.length, 2);
  assert.equal(p2Keys.length, 2);
  const p1Zotero = p1Keys.map((k) => before.imported[k].zoteroKey);
  const p2Zotero = p2Keys.map((k) => before.imported[k].zoteroKey);

  tablet.setFiles(
    rmDocId,
    content(p1, p2),
    new Map([["p2", new Uint8Array([1, 2, 3])]]),
  );
  const report = await (await boot()).engine.sync([att]);
  assert.deepEqual(report.errors, []);
  assert.equal(report.removed, 2);
  assert.deepEqual([...z.erased].sort(), [...p1Zotero].sort());
  for (const key of p2Zotero) assert.ok(z.has(LIB, key), "kept");
  const after = await imported();
  assert.deepEqual(Object.keys(after.imported).sort(), p2Keys.sort());
  // An unreadable page is not an incomplete pull: nothing is retried for it.
  assert.equal(after.pullIncomplete, undefined);
});

test("records that are current are not imported again", async () => {
  const { z, tablet, att, boot, rmDocId, imported } = await setup();
  const rm = new Map([["p1", HIGHLIGHTS]]);
  tablet.setFiles(rmDocId, content(p1), rm);
  await (await boot()).engine.sync([att]);
  assert.equal(z.saved.length, 2);

  // The tablet changed (new hash) but the highlights did not.
  tablet.setFiles(rmDocId, content(p1), rm);
  const report = await (await boot()).engine.sync([att]);
  assert.deepEqual(report.errors, []);
  assert.equal(tablet.pulls.length, 2, "the second change was pulled");
  assert.equal(report.imported, 0);
  assert.equal(z.saved.length, 2);
  assert.equal(Object.keys((await imported()).imported).length, 2);
});

test("a converter bump imports the records again, except objects the user deleted", async () => {
  const { z, att, boot, tablet, rmDocId, imported } = await setup();
  tablet.setFiles(rmDocId, content(p1), new Map([["p1", HIGHLIGHTS]]));
  await (await boot()).engine.sync([att]);
  assert.equal(z.saved.length, 2);
  const [deletedKey] = Object.values((await imported()).imported).map(
    (r) => r.zoteroKey,
  );
  z.remove(LIB, deletedKey);

  const { state, engine } = await boot();
  const doc = state.get(LIB, ATT)!;
  doc.converterVersion = CONVERTER_VERSION - 1;
  state.set(doc);
  await state.save();
  const report = await engine.sync([att]);
  assert.deepEqual(report.errors, []);
  assert.equal(report.imported, 1);
  assert.equal(z.saved.length, 3);
  assert.equal(z.has(LIB, deletedKey), false, "not recreated");
  assert.equal((await imported()).converterVersion, CONVERTER_VERSION);
});

test("a failed re-import stays stale and is retried after the converter version advanced", async () => {
  const { z, att, boot, tablet, rmDocId, imported } = await setup();
  tablet.setFiles(rmDocId, content(p1), new Map([["p1", HIGHLIGHTS]]));
  await (await boot()).engine.sync([att]);
  const first = await imported();
  const keys = Object.keys(first.imported);
  assert.equal(keys.length, 2);

  // Imported by an older converter, and now saving fails.
  const { state, engine } = await boot();
  const old = state.get(LIB, ATT)!;
  old.converterVersion = CONVERTER_VERSION - 1;
  state.set(old);
  await state.save();
  z.behavior.failSave = true;
  const failed = await engine.sync([att]);
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0], /could not import 2 of 2 items/);
  const stale = await imported();
  assert.equal(stale.pullIncomplete, true);
  assert.equal(stale.converterVersion, CONVERTER_VERSION);
  for (const key of keys) {
    assert.equal(stale.imported[key].hash, "", "invalidated");
    // The Zotero object it points at is still tracked, so it is updated.
    assert.equal(stale.imported[key].zoteroKey, first.imported[key].zoteroKey);
  }

  // The tablet did not change and the version is current: only the
  // incomplete pull and the empty hashes bring the records back.
  z.behavior.failSave = false;
  const savedBefore = z.saved.length;
  const retried = await (await boot()).engine.sync([att]);
  assert.deepEqual(retried.errors, []);
  assert.equal(retried.imported, 2);
  assert.equal(z.saved.length, savedBefore + 2);
  const healed = await imported();
  assert.equal(healed.pullIncomplete, undefined);
  for (const key of keys) {
    assert.equal(healed.imported[key].hash, first.imported[key].hash);
    assert.equal(healed.imported[key].zoteroKey, first.imported[key].zoteroKey);
  }
});

test("notes on a standalone attachment are skipped without an error and never erased", async () => {
  const { z, att, boot, tablet, rmDocId, imported } = await setup(true);
  // A notebook page (no PDF page behind it) holding strokes: a note candidate,
  // but a standalone attachment has no parent item to hold child notes.
  tablet.setFiles(
    rmDocId,
    content(p1, { id: "nb", redir: -1 }),
    new Map([
      ["p1", HIGHLIGHTS],
      ["nb", STROKES],
    ]),
  );
  const report = await (await boot()).engine.sync([att]);
  assert.deepEqual(report.errors, []);
  const doc = await imported();
  assert.ok(Object.keys(doc.imported).length >= 2, "highlights imported");
  assert.ok(!("nb/page" in doc.imported));
  assert.equal(doc.pullIncomplete, undefined);
  assert.equal(z.erased.length, 0);
});
