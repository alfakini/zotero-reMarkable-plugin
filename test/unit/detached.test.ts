import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDetachedList,
  clearErased,
  skipKeys,
} from "../../src/sync/detached";

const imported = {
  "p1/g/a": { zoteroKey: "ANNOA" },
  "p1/margin": { zoteroKey: "NOTEB" },
  "p2/i/c": { zoteroKey: "ANNOC" },
};

test("detaches every imported Zotero key of the replaced document", () => {
  assert.deepEqual(buildDetachedList({ imported }).sort(), [
    "ANNOA",
    "ANNOC",
    "NOTEB",
  ]);
});

test("keeps keys detached by an earlier replacement, without duplicates", () => {
  const out = buildDetachedList({
    imported: { "p1/g/a": { zoteroKey: "ANNOA" } },
    detachedImported: ["OLD1", "ANNOA"],
  });
  assert.deepEqual(out.sort(), ["ANNOA", "OLD1"]);
});

test("nothing to detach without a previous document or imports", () => {
  assert.deepEqual(buildDetachedList(undefined), []);
  assert.deepEqual(buildDetachedList({ imported: {} }), []);
});

test("skip set covers imported and detached keys", () => {
  const skip = skipKeys({ imported, detachedImported: ["OLD1"] });
  assert.deepEqual([...skip].sort(), ["ANNOA", "ANNOC", "NOTEB", "OLD1"]);
  assert.equal(skip.has("USERKEY"), false);
});

test("skip set after a replacement keeps old imports out of the PDF", () => {
  // The new document starts with no imported records but the detached list.
  const next = {
    imported: {},
    detachedImported: buildDetachedList({ imported }),
  };
  const skip = skipKeys(next);
  for (const k of ["ANNOA", "NOTEB", "ANNOC"]) assert.ok(skip.has(k));
});

test("skip set of an untracked document is empty", () => {
  assert.equal(skipKeys(undefined).size, 0);
  assert.equal(skipKeys({ imported: {} }).size, 0);
});

test("skip set also covers the persistent registry of forgotten documents", () => {
  const skip = skipKeys({ imported: {}, detachedImported: ["OLD1"] }, [
    "REG1",
    "REG2",
  ]);
  assert.deepEqual([...skip].sort(), ["OLD1", "REG1", "REG2"]);
  assert.deepEqual([...skipKeys(undefined, ["REG1"])], ["REG1"]);
});

test("remove imported erases imported, detached and registry keys, nothing else", () => {
  const doc = { imported, detachedImported: ["OLD1", "ANNOA"] };
  const keys = buildDetachedList(doc, ["REG1", "OLD1"]).sort();
  assert.deepEqual(keys, ["ANNOA", "ANNOC", "NOTEB", "OLD1", "REG1"]);
  assert.equal(keys.includes("USERKEY"), false);
});

test("remove imported still erases the registry of a forgotten document", () => {
  assert.deepEqual(buildDetachedList(undefined, ["REG1"]), ["REG1"]);
});

test("clearing after erase drops detached keys and keeps imported without reimport", () => {
  const doc = { imported: { ...imported }, detachedImported: ["OLD1"] };
  clearErased(doc, false);
  assert.equal(doc.detachedImported, undefined);
  assert.equal(Object.keys(doc.imported).length, 3);
});

test("clearing after erase with reimport also empties imported", () => {
  const doc = { imported: { ...imported }, detachedImported: ["OLD1"] };
  clearErased(doc, true);
  assert.equal(doc.detachedImported, undefined);
  assert.deepEqual(doc.imported, {});
  assert.equal(skipKeys(doc).size, 0);
});
