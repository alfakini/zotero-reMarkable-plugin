import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { IMPORT_TAG } from "../../src/sync/zotero";

test("import tag differs from the default sync tag", () => {
  const prefs = readFileSync("addon/prefs.js", "utf8");
  const m = prefs.match(/pref\("syncTag",\s*"([^"]*)"\)/);
  assert.ok(m, "syncTag default not found in addon/prefs.js");
  assert.notEqual(IMPORT_TAG, m[1]);
});
