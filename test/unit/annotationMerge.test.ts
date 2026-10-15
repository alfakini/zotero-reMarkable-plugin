import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeAnnotationFields } from "../../src/sync/annotationMerge";

const TAG = "reMarkable";

test("a new annotation gets the tablet comment and the import tag", () => {
  const m = mergeAnnotationFields({ type: "note", comment: "typed" }, TAG);
  assert.equal(m.comment, "typed");
  assert.deepEqual(m.tags, [{ name: TAG }]);
  const h = mergeAnnotationFields({ type: "highlight" }, TAG);
  assert.equal(h.comment, "");
});

test("an update keeps the user's comment on highlights and ink", () => {
  for (const type of ["highlight", "ink"] as const) {
    const m = mergeAnnotationFields({ type, comment: "" }, TAG, {
      comment: "my thoughts",
      tags: [{ tag: TAG }],
    });
    assert.equal(m.comment, "my thoughts");
  }
});

test("a note annotation takes its comment from the tablet", () => {
  const m = mergeAnnotationFields({ type: "note", comment: "new text" }, TAG, {
    comment: "old text",
    tags: [],
  });
  assert.equal(m.comment, "new text");
});

test("an update merges the user's tags with the import tag", () => {
  const m = mergeAnnotationFields({ type: "highlight" }, TAG, {
    comment: "",
    tags: [{ tag: "todo" }, { tag: "auto", type: 1 }, { tag: "todo" }],
  });
  assert.deepEqual(m.tags, [
    { name: "todo" },
    { name: "auto", type: 1 },
    { name: TAG },
  ]);
});

test("the import tag is not duplicated when already present", () => {
  const m = mergeAnnotationFields({ type: "ink" }, TAG, {
    comment: "",
    tags: [{ tag: TAG }, { tag: "x" }],
  });
  assert.deepEqual(m.tags, [{ name: TAG }, { name: "x" }]);
});
