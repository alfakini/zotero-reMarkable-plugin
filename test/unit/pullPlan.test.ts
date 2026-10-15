import assert from "node:assert/strict";
import { test } from "node:test";
import { keysToErase, readPages } from "../../src/sync/pullPlan";

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

test("a page without an .rm blob is empty, not unreadable", () => {
  const refs = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
  const rm = new Map([
    ["p1", new Uint8Array([1])],
    ["p3", new Uint8Array([0])],
  ]);
  const errors: string[] = [];
  const { pages, unreadable } = readPages(
    refs,
    rm,
    (d) => {
      if (d[0] === 0) throw new Error("bad header");
      return "parsed";
    },
    (ref) => errors.push(ref.id),
  );
  assert.deepEqual(
    pages.map((p) => p.ref.id),
    ["p1"],
  );
  // p2 has no blob (empty page); only p3, whose blob fails to parse, is kept.
  assert.deepEqual([...unreadable], ["p3"]);
  assert.deepEqual(errors, ["p3"]);
  // Its imported records are erased; those of the unreadable page are kept.
  const out = keysToErase(
    {
      "p2/g/x": { kind: "annotation" },
      "p3/g/y": { kind: "annotation" },
    },
    new Set(),
    unreadable,
    true,
  );
  assert.deepEqual(out, ["p2/g/x"]);
});
