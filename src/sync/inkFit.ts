/**
 * Fit an ink annotation position into Zotero's size limit. Pure (Zotero-free)
 * so it can be unit tested in Node.
 */

/** Zotero rejects annotation positions whose JSON is longer than this. */
export const POSITION_MAX = 65000;

export interface InkPosition {
  paths: number[][];
  [key: string]: unknown;
}

export interface FittedInk<P extends InkPosition> {
  position: P;
  /** Strokes that had to be dropped because they could not fit. */
  droppedPaths: number;
}

/** Keep every `step`-th point of a flat [x, y, x, y, ...] path plus its end. */
function thinPath(p: number[], step: number): number[] {
  if (p.length <= 4) return p;
  const out: number[] = [];
  for (let i = 0; i < p.length; i += 2 * step) out.push(p[i], p[i + 1]);
  out.push(p[p.length - 2], p[p.length - 1]);
  return out;
}

const size = (v: unknown) => JSON.stringify(v).length;

/**
 * Return a position whose serialized size never exceeds `max`.
 *
 * 1. Thin every stroke (every 2nd, 4th, ... 64th point) until it fits.
 * 2. If it still does not fit, keep the largest subset of the (64-thinned)
 *    strokes, in their original order: a stroke that would overflow is
 *    skipped and later, smaller ones are still tried.
 * 3. If not even one stroke fits, reduce the first stroke further, down to
 *    its end points.
 * Dropping strokes beats failing the whole import of the page.
 */
export function fitInkPosition<P extends InkPosition>(
  position: P,
  max = POSITION_MAX,
): FittedInk<P> {
  if (size(position) <= max) return { position, droppedPaths: 0 };
  let thinned = position.paths;
  for (let step = 2; step <= 64; step *= 2) {
    thinned = position.paths.map((p) => thinPath(p, step));
    const pos = { ...position, paths: thinned };
    if (size(pos) <= max) return { position: pos, droppedPaths: 0 };
  }

  // Each path costs its own JSON plus a separating comma.
  let budget = max - size({ ...position, paths: [] });
  const kept: number[][] = [];
  for (const p of thinned) {
    const cost = size(p) + 1;
    if (cost <= budget) {
      kept.push(p);
      budget -= cost;
    }
  }
  if (!kept.length && thinned.length) {
    let step = 128;
    let p = thinPath(thinned[0], step);
    while (p.length > 4 && size({ ...position, paths: [p] }) > max) {
      step *= 2;
      p = thinPath(thinned[0], step);
    }
    // Keep the thinned path whenever it fits; only fall back to the end
    // points when even the coarsest thinning does not.
    const fits = size({ ...position, paths: [p] }) <= max;
    kept.push(fits || p.length <= 4 ? p : p.slice(0, 2).concat(p.slice(-2)));
  }
  return {
    position: { ...position, paths: kept },
    droppedPaths: position.paths.length - kept.length,
  };
}
