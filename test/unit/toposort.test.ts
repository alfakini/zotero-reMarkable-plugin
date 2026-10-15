import assert from "node:assert/strict";
import { test } from "node:test";
import { toposort } from "../../src/remarkable/rmscene";

type Item = { id: string; left: string; right: string };

const END_MARKER = "0:0";

/** The previous quadratic implementation, kept as the behavioural reference. */
function referenceToposort<T extends Item>(items: T[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const side = (id: string, s: "left" | "right") =>
    id === END_MARKER ? (s === "left" ? "__start" : "__end") : id;
  const deps = new Map<string, Set<string>>();
  const dep = (k: string) => {
    let d = deps.get(k);
    if (!d) {
      d = new Set();
      deps.set(k, d);
    }
    return d;
  };
  for (const item of items) {
    dep(item.id).add(side(item.left, "left"));
    dep(side(item.right, "right")).add(item.id);
  }
  for (const d of [...deps.values()]) for (const k of d) dep(k);
  const out: T[] = [];
  const cmp = (a: string, b: string) => {
    const [a1, a2] = a.split(":").map(Number);
    const [b1, b2] = b.split(":").map(Number);
    return a1 - b1 || a2 - b2;
  };
  while (deps.size) {
    const ready = [...deps.entries()]
      .filter(([, d]) => d.size === 0)
      .map(([k]) => k);
    if (!ready.length) break;
    if (ready.length === 1 && ready[0] === "__end") break;
    for (const k of ready.filter((k) => byId.has(k)).sort(cmp))
      out.push(byId.get(k)!);
    for (const k of ready) if (k !== "__end") deps.delete(k);
    for (const d of deps.values()) for (const k of ready) d.delete(k);
    if (ready.every((k) => k === "__end")) break;
  }
  if (out.length < items.length) {
    const seen = new Set(out.map((i) => i.id));
    for (const i of items) if (!seen.has(i.id)) out.push(i);
  }
  return out;
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulates typing into a CRDT sequence: inserts between neighbours (and
 * concurrently at the same position), then deletes a few items so that some
 * links dangle. Items are shuffled so input order carries no information.
 */
function randomSequence(seed: number): Item[] {
  const rand = rng(seed);
  const pick = (n: number) => Math.floor(rand() * n);
  const seq: Item[] = [];
  const all: Item[] = [];
  const count = 1 + pick(60);
  for (let n = 0; n < count; n++) {
    const id = `${1 + pick(3)}:${10 + n}`;
    const at = pick(seq.length + 1);
    const left = at === 0 ? END_MARKER : seq[at - 1].id;
    const right = at === seq.length ? END_MARKER : seq[at].id;
    const item = { id, left, right };
    all.push(item);
    // Sometimes insert concurrently at the same position as the previous
    // insert (same left/right), leaving the sequence otherwise untouched.
    if (rand() < 0.25 && all.length > 1) {
      const other = all[pick(all.length - 1)];
      all.push({
        ...other,
        id: `${1 + pick(3)}:${1000 + n}`,
      });
    }
    seq.splice(at, 0, item);
  }
  let items = all.slice();
  for (const victim of seq.filter(() => rand() < 0.15))
    items = items.filter((i) => i !== victim);
  for (let i = items.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

test("toposort matches the reference on random CRDT sequences", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const items = randomSequence(seed);
    assert.deepEqual(
      toposort(items).map((i) => i.id),
      referenceToposort(items).map((i) => i.id),
      `seed ${seed}`,
    );
  }
});

test("toposort matches the reference with a cycle and malformed links", () => {
  const cases: Item[][] = [
    [
      { id: "1:10", left: "0:0", right: "1:11" },
      { id: "1:11", left: "1:10", right: "1:12" },
      { id: "1:12", left: "1:13", right: "1:13" },
      { id: "1:13", left: "1:12", right: "1:12" },
      { id: "1:14", left: "1:13", right: "0:0" },
    ],
    // self loop and a link to an unknown id
    [
      { id: "1:10", left: "1:10", right: "0:0" },
      { id: "1:11", left: "9:9", right: "0:0" },
    ],
    [],
  ];
  for (let seed = 1; seed <= 100; seed++) {
    const rand = rng(seed * 7919);
    const ids = Array.from({ length: 12 }, (_, n) => `1:${n + 1}`);
    const link = () =>
      rand() < 0.2 ? END_MARKER : ids[Math.floor(rand() * 12)];
    cases.push(ids.map((id) => ({ id, left: link(), right: link() })));
  }
  for (const [n, items] of cases.entries()) {
    assert.deepEqual(
      toposort(items).map((i) => i.id),
      referenceToposort(items).map((i) => i.id),
      `case ${n}`,
    );
  }
});

test("toposort handles 20000 chained items quickly", () => {
  const n = 20000;
  const items: Item[] = [];
  for (let i = 0; i < n; i++) {
    items.push({
      id: `1:${i + 10}`,
      left: i === 0 ? END_MARKER : `1:${i + 9}`,
      right: i === n - 1 ? END_MARKER : `1:${i + 11}`,
    });
  }
  items.reverse();
  const started = Date.now();
  const out = toposort(items);
  const elapsed = Date.now() - started;
  assert.equal(out.length, n);
  assert.equal(out[0].id, "1:10");
  assert.equal(out[n - 1].id, `1:${n + 9}`);
  assert.ok(elapsed < 1000, `took ${elapsed}ms`);
});
