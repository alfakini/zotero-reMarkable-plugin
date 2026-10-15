import assert from "node:assert/strict";
import { test } from "node:test";
import { LARGE_PDF_BYTES, largePdfWarning } from "../../src/sync/largePdf";

test("the large-PDF threshold is 50 MB", () => {
  assert.equal(LARGE_PDF_BYTES, 50 * 1024 * 1024);
});

test("largePdfWarning names the item and the size", () => {
  const text = largePdfWarning("Thesis", 120 * 1024 * 1024);
  assert.match(text, /Thesis/);
  assert.match(text, /120 MB/);
  assert.match(text, /freeze/);
});
