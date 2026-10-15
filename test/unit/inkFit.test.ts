import assert from "node:assert/strict";
import { test } from "node:test";
import { fitInkPosition, POSITION_MAX } from "../../src/sync/inkFit";

/** A stroke of `n` points with realistic coordinate widths. */
function stroke(n: number, seed = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++)
    out.push(
      Math.round((100 + i * 0.37 + seed) * 1000) / 1000,
      Math.round((200 + Math.sin(i) * 50 + seed) * 1000) / 1000,
    );
  return out;
}
const len = (v: unknown) => JSON.stringify(v).length;

test("leaves a position that already fits untouched", () => {
  const pos = { pageIndex: 0, width: 2, paths: [stroke(10)] };
  const r = fitInkPosition(pos);
  assert.equal(r.position, pos);
  assert.equal(r.droppedPaths, 0);
});

test("thins strokes when that is enough", () => {
  const pos = { pageIndex: 0, width: 2, paths: [stroke(6000)] };
  assert.ok(len(pos) > POSITION_MAX);
  const r = fitInkPosition(pos);
  assert.ok(len(r.position) <= POSITION_MAX);
  assert.equal(r.droppedPaths, 0);
  assert.equal(r.position.paths.length, 1);
  assert.equal(r.position.pageIndex, 0);
});

test("never returns an oversized position, dropping strokes if needed", () => {
  // Thousands of strokes: even thinned to 64 they exceed the limit.
  const paths = Array.from({ length: 4000 }, (_, i) => stroke(30, i));
  const pos = { pageIndex: 3, width: 2, paths };
  const r = fitInkPosition(pos);
  assert.ok(len(r.position) <= POSITION_MAX);
  assert.ok(r.position.paths.length > 0);
  assert.ok(r.droppedPaths > 0);
  assert.equal(r.droppedPaths, paths.length - r.position.paths.length);
  assert.equal(r.position.pageIndex, 3);
});

test("keeps later small strokes when a big one does not fit", () => {
  const huge = stroke(50000);
  const small = stroke(5, 7);
  const r = fitInkPosition({ pageIndex: 0, paths: [huge, small] }, 2000);
  assert.ok(len(r.position) <= 2000);
  assert.ok(
    r.position.paths.some((p) => p[0] === small[0] && p[1] === small[1]),
  );
});

test("reduces a single enormous stroke to fit", () => {
  const r = fitInkPosition({ pageIndex: 0, paths: [stroke(500000)] }, 3000);
  assert.ok(len(r.position) <= 3000);
  assert.equal(r.position.paths.length, 1);
  assert.ok(r.position.paths[0].length >= 4);
});

test("keeps the thinned path of a long stroke instead of a straight line", () => {
  const long = stroke(20000); // about 40000 numbers
  assert.equal(long.length, 40000);
  const r = fitInkPosition({ pageIndex: 0, paths: [long] }, 2000);
  assert.ok(len(r.position) <= 2000);
  assert.equal(r.droppedPaths, 0);
  assert.equal(r.position.paths.length, 1);
  const p = r.position.paths[0];
  // Not collapsed to its two end points.
  assert.ok(p.length > 4, `expected a thinned path, got ${p.length} numbers`);
  // A subset of the original points, in order, ending at the last point.
  assert.deepEqual(p.slice(0, 2), long.slice(0, 2));
  assert.deepEqual(p.slice(-2), long.slice(-2));
});
