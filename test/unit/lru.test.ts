import assert from "node:assert/strict";
import { test } from "node:test";
import { LruCache } from "../../src/remarkable/lru";

test("evicts the least recently used entry beyond the count cap", () => {
  const c = new LruCache<string, number>(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("b"), 2);
  assert.equal(c.get("c"), 3);
  assert.equal(c.size, 2);
});

test("get marks an entry as most recently used", () => {
  const c = new LruCache<string, number>(2);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1);
  c.set("c", 3);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
});

test("evicts by total weight and keeps the weight exact", () => {
  const c = new LruCache<string, string>(8, (v) => v.length);
  c.set("a", "aaaa");
  c.set("b", "bbbb");
  assert.equal(c.weight, 8);
  c.set("c", "cccc");
  assert.equal(c.get("a"), undefined);
  assert.equal(c.weight, 8);
  assert.equal(c.size, 2);
  // Replacing an entry does not double count it.
  c.set("c", "cc");
  assert.equal(c.weight, 6);
  c.delete("b");
  assert.equal(c.weight, 2);
  c.delete("missing");
  assert.equal(c.weight, 2);
});

test("a heavy entry evicts several light ones", () => {
  const c = new LruCache<string, string>(8, (v) => v.length);
  c.set("a", "aa");
  c.set("b", "bb");
  c.set("c", "cc");
  c.set("d", "dddddd");
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("c"), "cc");
  assert.equal(c.get("d"), "dddddd");
  assert.equal(c.weight, 8);
});

test("an entry heavier than the cap is not stored", () => {
  const c = new LruCache<string, string>(4, (v) => v.length);
  c.set("a", "aa");
  c.set("big", "bbbbb");
  assert.equal(c.get("big"), undefined);
  assert.equal(c.get("a"), "aa");
  assert.equal(c.weight, 2);
});

test("clear empties the cache and resets the weight", () => {
  const c = new LruCache<string, string>(8, (v) => v.length);
  c.set("a", "aaaa");
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.weight, 0);
  assert.equal(c.get("a"), undefined);
  c.set("b", "bbbb");
  assert.equal(c.weight, 4);
});
