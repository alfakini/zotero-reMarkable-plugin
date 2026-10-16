import assert from "node:assert/strict";
import { test } from "node:test";
import { CONVERTER_VERSION } from "../../src/sync/convert";
import { keysToErase, needsPull, nextRmDocHash } from "../../src/sync/engine";

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
