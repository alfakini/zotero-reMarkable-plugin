/**
 * Converts parsed reMarkable pages into Zotero annotation JSON.
 *
 * Mapping decisions:
 *  - Text highlights (GlyphRange)          -> Zotero `highlight` with the text.
 *  - Freehand highlighter / shader strokes -> Zotero `highlight` covering the
 *                                             stroke (no text).
 *  - Pen strokes on a PDF page             -> Zotero `ink`, strokes grouped into
 *                                             spatial clusters (one per word /
 *                                             drawing) so they can be deleted
 *                                             or recoloured individually.
 *  - Typed text on a PDF page              -> Zotero `note` annotation.
 *  - Anything on inserted notebook pages,
 *    on the appended "Zotero notes" pages,
 *    or written outside the PDF page        -> child note with an SVG drawing
 *                                             of the handwriting (+ typed text).
 */
import type { RmPageRef } from "../remarkable/content";
import {
  isEraser,
  isHighlighter,
  isShader,
  type RmGlyph,
  type RmLine,
  type RmPage,
  type Rgba,
} from "../remarkable/rmscene";
import type { PageBox, ZPosition } from "./types";

/**
 * Bump when the conversion output changes, so already-synced documents are
 * re-imported (imported objects are updated in place, keyed by rmKey).
 */
export const CONVERTER_VERSION = 3;

/** reMarkable units per PDF point (rM2 / Paper Pro render PDFs at 226 dpi). */
export const RM_DPI = 226;
const S = 72 / RM_DPI;
/** Per-point pen width -> PDF points (calibrated against device exports). */
const WIDTH_FACTOR = 0.0945;

export const ZOTERO_COLORS = {
  yellow: "#ffd400",
  red: "#ff6666",
  green: "#5fb236",
  blue: "#2ea8e5",
  purple: "#a28ae5",
  magenta: "#e56eee",
  orange: "#f19837",
  gray: "#aaaaaa",
} as const;

const RM_PALETTE: Record<number, [number, number, number]> = {
  0: [0, 0, 0],
  1: [144, 144, 144],
  2: [255, 255, 255],
  3: [251, 247, 25],
  4: [0, 200, 0],
  5: [255, 105, 180],
  6: [78, 105, 201],
  7: [179, 62, 57],
  8: [125, 125, 125],
  9: [255, 237, 117],
  10: [161, 216, 125],
  11: [139, 208, 229],
  12: [183, 130, 205],
  13: [247, 232, 81],
};

export interface AnnotationCandidate {
  kind: "annotation";
  /** Stable id of the reMarkable source item(s). */
  rmKey: string;
  hash: string;
  json: {
    type: "highlight" | "ink" | "note";
    text?: string;
    comment?: string;
    color: string;
    pageLabel: string;
    sortIndex: string;
    position: ZPosition;
  };
}

export interface NoteCandidate {
  kind: "note";
  rmKey: string;
  hash: string;
  /** Human-readable location, e.g. "inserted page after p. 3". */
  title: string;
  /** Typed text on the page, if any. */
  text?: string;
  /** SVG drawing of the handwriting, if any. */
  svg?: { markup: string; width: number; height: number };
}

export type Candidate = AnnotationCandidate | NoteCandidate;

export interface ConvertInput {
  pages: { ref: RmPageRef; page: RmPage }[];
  originalPageCount: number;
  pageBoxes: PageBox[];
  pageLabels?: string[];
  /** Leave notebook pages without a PDF page to the two-way note sync. */
  skipInsertedPages?: boolean;
}

// ---------------------------------------------------------------- colours --

function rgbOf(color: number, rgba?: Rgba): [number, number, number] {
  if (rgba && (rgba.r || rgba.g || rgba.b)) return [rgba.r, rgba.g, rgba.b];
  return RM_PALETTE[color] ?? [0, 0, 0];
}

export function toHex([r, g, b]: [number, number, number]) {
  return (
    "#" +
    [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")
  );
}

function hsl([r, g, b]: [number, number, number]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h =
    max === r
      ? ((g - b) / d) % 6
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/** Nearest Zotero highlight colour by hue (pastel device colours included). */
export function nearestZoteroColor(rgb: [number, number, number]): string {
  const { h, s } = hsl(rgb);
  if (s < 0.15) return ZOTERO_COLORS.gray;
  const hues: [number, string][] = [
    [0, ZOTERO_COLORS.red],
    [30, ZOTERO_COLORS.orange],
    [50, ZOTERO_COLORS.yellow],
    [100, ZOTERO_COLORS.green],
    [198, ZOTERO_COLORS.blue],
    [255, ZOTERO_COLORS.purple],
    [298, ZOTERO_COLORS.magenta],
    [360, ZOTERO_COLORS.red],
  ];
  let best = hues[0];
  for (const c of hues) {
    if (Math.abs(c[0] - h) < Math.abs(best[0] - h)) best = c;
  }
  return best[1];
}

/** Ink keeps the pen colour; black stays black. */
function inkColor(line: RmLine) {
  return toHex(rgbOf(line.color, line.rgba));
}

function highlightColor(color: number, rgba?: Rgba) {
  return nearestZoteroColor(rgbOf(color, rgba));
}

// ------------------------------------------------------------- geometry ---

export function makeTransform(box: PageBox) {
  const cx = box.x + box.width / 2;
  const top = box.y + box.height;
  return {
    x: (x: number) => cx + x * S,
    y: (y: number) => top - y * S,
    /** True if a PDF point lies on the page (with a small tolerance). */
    inside: (px: number, py: number) =>
      px >= box.x - 2 &&
      px <= box.x + box.width + 2 &&
      py >= box.y - 2 &&
      py <= top + 2,
  };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function sortIndex(pageIndex: number, box: PageBox, maxY: number) {
  const top = Math.max(0, Math.floor(box.y + box.height - maxY));
  return `${String(pageIndex).padStart(5, "0")}|000000|${String(Math.min(top, 99999)).padStart(5, "0")}`;
}

/** Small, stable, non-cryptographic fingerprint. */
export function fingerprint(value: unknown): string {
  const s = JSON.stringify(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822507);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0")
  );
}

interface BBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function lineBBox(line: RmLine, pad = 0): BBox {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const p of line.points) {
    x1 = Math.min(x1, p.x);
    y1 = Math.min(y1, p.y);
    x2 = Math.max(x2, p.x);
    y2 = Math.max(y2, p.y);
  }
  return { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad };
}

const overlaps = (a: BBox, b: BBox) =>
  a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2;

function avgWidth(line: RmLine) {
  if (!line.points.length) return 0;
  return line.points.reduce((s, p) => s + p.width, 0) / line.points.length;
}

/**
 * Group pen strokes into what was written together: a word, a sentence on
 * one line, a few stacked lines of a margin note, or a drawing.
 *
 *  1. Strokes whose (padded) boxes touch form "words".
 *  2. Words on the same line merge when the horizontal gap is within about
 *     2.5 line heights (normal word spacing), and lines stacked closely on
 *     top of each other merge when the vertical gap is within ~1.2 line
 *     heights and they overlap horizontally.
 *
 * Only strokes of the same colour are grouped.
 */
export function clusterLines(lines: RmLine[], gap = 30): RmLine[][] {
  // Pass 1: touching strokes.
  const boxes = lines.map((l) => lineBBox(l, gap / 2));
  const words = unionFind(
    lines.length,
    (i, j) =>
      inkColor(lines[i]) === inkColor(lines[j]) && overlaps(boxes[i], boxes[j]),
  ).map((idx) => idx.map((i) => lines[i]));

  // Pass 2: words -> lines -> paragraphs.
  const wb = words.map((w) => groupBBox(w));
  const color = words.map((w) => inkColor(w[0]));
  const merged = unionFind(words.length, (i, j) => {
    if (color[i] !== color[j]) return false;
    const a = wb[i];
    const b = wb[j];
    const h = Math.max(40, Math.min(a.y2 - a.y1, b.y2 - b.y1));
    const dx = Math.max(0, Math.max(a.x1, b.x1) - Math.min(a.x2, b.x2));
    const dy = Math.max(0, Math.max(a.y1, b.y1) - Math.min(a.y2, b.y2));
    const vOverlap = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
    const sameLine =
      vOverlap >= 0.4 * Math.min(a.y2 - a.y1, b.y2 - b.y1, h) && dx <= 2.5 * h;
    const stacked = dx <= 0.5 * h && dy <= 1.2 * h;
    return sameLine || stacked;
  });
  return merged.map((idx) => idx.flatMap((i) => words[i]));
}

function groupBBox(lines: RmLine[]): BBox {
  return lines
    .map((l) => lineBBox(l))
    .reduce((a, c) => ({
      x1: Math.min(a.x1, c.x1),
      y1: Math.min(a.y1, c.y1),
      x2: Math.max(a.x2, c.x2),
      y2: Math.max(a.y2, c.y2),
    }));
}

/** Connected components of `n` nodes under the `linked` relation. */
function unionFind(
  n: number,
  linked: (i: number, j: number) => boolean,
): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    if (parent[i] !== i) parent[i] = find(parent[i]); // path compression
    return parent[i];
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) !== find(j) && linked(i, j)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  }
  return [...groups.values()];
}

/** Drop points closer than `minDist` PDF points to keep positions compact. */
function simplify(path: number[], minDist = 0.4): number[] {
  if (path.length <= 4) return path;
  const out = [path[0], path[1]];
  for (let i = 2; i < path.length - 2; i += 2) {
    const dx = path[i] - out[out.length - 2];
    const dy = path[i + 1] - out[out.length - 1];
    if (dx * dx + dy * dy >= minDist * minDist) out.push(path[i], path[i + 1]);
  }
  out.push(path[path.length - 2], path[path.length - 1]);
  return out;
}

// ----------------------------------------------------------- conversion ---

/** Merge glyph ranges that continue a highlight onto the next text line. */
export function mergeGlyphs(glyphs: RmGlyph[]): RmGlyph[][] {
  const out: RmGlyph[][] = [];
  for (const g of glyphs) {
    if (!g.rects.length) continue;
    const prev = out[out.length - 1];
    const last = prev?.[prev.length - 1];
    if (
      last &&
      last.color === g.color &&
      JSON.stringify(last.rgba) === JSON.stringify(g.rgba)
    ) {
      const a = last.rects[last.rects.length - 1];
      const b = g.rects[0];
      const lineH = Math.max(a.h, b.h);
      const nextLine = b.y > a.y && b.y - (a.y + a.h) < lineH * 0.9;
      if (nextLine) {
        prev.push(g);
        continue;
      }
    }
    out.push([g]);
  }
  return out;
}

export function convertPages(input: ConvertInput): Candidate[] {
  const out: Candidate[] = [];
  for (const { ref, page } of input.pages) {
    const onPdfPage =
      ref.pdfIndex !== undefined &&
      ref.pdfIndex < input.originalPageCount &&
      !!input.pageBoxes[ref.pdfIndex];
    if (!onPdfPage) {
      if (input.skipInsertedPages && ref.pdfIndex === undefined) continue;
      const note = pageToNote(ref, page, input);
      if (note) out.push(note);
      continue;
    }
    const pageIndex = ref.pdfIndex!;
    const box = input.pageBoxes[pageIndex];
    const tf = makeTransform(box);
    const pageLabel = input.pageLabels?.[pageIndex] ?? String(pageIndex + 1);

    // Text highlights.
    for (const group of mergeGlyphs(page.glyphs)) {
      const rects = group
        .flatMap((g) => g.rects)
        .map((r) => {
          const xs = [tf.x(r.x), tf.x(r.x + r.w)];
          const ys = [tf.y(r.y), tf.y(r.y + r.h)];
          return [
            Math.min(...xs),
            Math.min(...ys),
            Math.max(...xs),
            Math.max(...ys),
          ].map(r3);
        });
      const text = group
        .map((g) => g.text.trim())
        .filter(Boolean)
        .join(" ");
      const maxY = Math.max(...rects.map((r) => r[3]));
      const json = {
        type: "highlight" as const,
        text,
        color: highlightColor(group[0].color, group[0].rgba),
        pageLabel,
        sortIndex: sortIndex(pageIndex, box, maxY),
        position: { pageIndex, rects },
      };
      out.push({
        kind: "annotation",
        rmKey: `${ref.id}/g/${group[0].id}`,
        hash: fingerprint(json),
        json,
      });
    }

    const drawable = page.lines.filter(
      (l) => !isEraser(l.tool) && l.points.length,
    );
    const marker = drawable.filter(
      (l) => isHighlighter(l.tool) || isShader(l.tool),
    );
    const pens = drawable.filter(
      (l) => !isHighlighter(l.tool) && !isShader(l.tool),
    );

    // Freehand highlighter strokes.
    for (const line of marker) {
      const half = (Math.max(avgWidth(line), 40) * WIDTH_FACTOR) / 2 / S;
      const b = lineBBox(line, half);
      const rect = [tf.x(b.x1), tf.y(b.y2), tf.x(b.x2), tf.y(b.y1)].map(r3);
      const json = {
        type: "highlight" as const,
        text: "",
        color: highlightColor(line.color, line.rgba),
        pageLabel,
        sortIndex: sortIndex(pageIndex, box, rect[3]),
        position: { pageIndex, rects: [rect] },
      };
      out.push({
        kind: "annotation",
        rmKey: `${ref.id}/h/${line.id}`,
        hash: fingerprint(json),
        json,
      });
    }

    // Pen strokes -> ink clusters; clusters off the page become a note.
    const offPage: RmLine[] = [];
    for (const cluster of clusterLines(pens)) {
      const b = groupBBox(cluster);
      if (!tf.inside(tf.x((b.x1 + b.x2) / 2), tf.y((b.y1 + b.y2) / 2))) {
        offPage.push(...cluster);
        continue;
      }
      const paths = cluster.map((l) =>
        simplify(l.points.flatMap((p) => [r3(tf.x(p.x)), r3(tf.y(p.y))])),
      );
      const widths = cluster.map(avgWidth).sort((a, c) => a - c);
      const width = Math.max(
        0.5,
        r3(widths[Math.floor(widths.length / 2)] * WIDTH_FACTOR),
      );
      const maxY = tf.y(b.y1);
      const json = {
        type: "ink" as const,
        color: inkColor(cluster[0]),
        pageLabel,
        sortIndex: sortIndex(pageIndex, box, maxY),
        position: { pageIndex, width, paths },
      };
      const firstId = cluster.map((l) => l.id).sort()[0];
      out.push({
        kind: "annotation",
        rmKey: `${ref.id}/i/${firstId}`,
        hash: fingerprint(json),
        json,
      });
    }

    // Typed text on a PDF page -> sticky note at the text box position.
    if (page.text) {
      const px = Math.min(
        Math.max(tf.x(page.text.x), box.x + 11),
        box.x + box.width - 11,
      );
      const py = Math.min(
        Math.max(tf.y(page.text.y), box.y + 11),
        box.y + box.height - 11,
      );
      const json = {
        type: "note" as const,
        comment: page.text.text.trim(),
        color: ZOTERO_COLORS.yellow,
        pageLabel,
        sortIndex: sortIndex(pageIndex, box, py + 11),
        position: {
          pageIndex,
          rects: [[px - 11, py - 11, px + 11, py + 11].map(r3)],
        },
      };
      out.push({
        kind: "annotation",
        rmKey: `${ref.id}/t`,
        hash: fingerprint(json),
        json,
      });
    }

    if (offPage.length) {
      const svg = renderSvg(offPage);
      out.push({
        kind: "note",
        rmKey: `${ref.id}/margin`,
        hash: fingerprint(svg),
        title: `reMarkable margin notes — p. ${pageLabel}`,
        svg,
      });
    }
  }
  return out;
}

function pageToNote(
  ref: RmPageRef,
  page: RmPage,
  input: ConvertInput,
): NoteCandidate | undefined {
  const lines = page.lines.filter((l) => !isEraser(l.tool) && l.points.length);
  const text = page.text?.text.trim();
  if (!lines.length && !text && !page.glyphs.length) return undefined;
  let title: string;
  if (ref.pdfIndex !== undefined && ref.pdfIndex >= input.originalPageCount) {
    title = `reMarkable notes — Zotero notes page ${ref.pdfIndex - input.originalPageCount + 1}`;
  } else {
    title = `reMarkable notebook page ${ref.order + 1}`;
  }
  const glyphText = page.glyphs.map((g) => g.text.trim()).filter(Boolean);
  const fullText = [text, ...glyphText.map((t) => `“${t}”`)]
    .filter(Boolean)
    .join("\n\n");
  const svg = lines.length ? renderSvg(lines) : undefined;
  return {
    kind: "note",
    rmKey: `${ref.id}/page`,
    hash: fingerprint({ fullText, svg }),
    title,
    text: fullText || undefined,
    svg,
  };
}

/** Render strokes as a standalone SVG, cropped to the strokes' bounds. */
export function renderSvg(lines: RmLine[]) {
  const boxes = lines.map((l) => lineBBox(l, Math.max(avgWidth(l), 8)));
  const x1 = Math.min(...boxes.map((b) => b.x1));
  const y1 = Math.min(...boxes.map((b) => b.y1));
  const x2 = Math.max(...boxes.map((b) => b.x2));
  const y2 = Math.max(...boxes.map((b) => b.y2));
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);
  const paths = lines.map((l) => {
    const marker = isHighlighter(l.tool) || isShader(l.tool);
    const d = l.points
      .map(
        (p, i) =>
          `${i ? "L" : "M"}${(p.x - x1).toFixed(1)} ${(p.y - y1).toFixed(1)}`,
      )
      .join("");
    const width = Math.max(1.5, (avgWidth(l) / 4) * (marker ? 1 : 1.2));
    const color = marker ? toHex(rgbOf(l.color, l.rgba)) : inkColor(l);
    const opacity = marker ? ` stroke-opacity="0.45"` : "";
    return `<path d="${d}" stroke="${color}" stroke-width="${width.toFixed(1)}"${opacity}/>`;
  });
  // Display width ~ the tablet's physical size at 96 css px/in.
  const displayW = Math.round((w / RM_DPI) * 96);
  const displayH = Math.round((h / RM_DPI) * 96);
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" ` +
    `width="${displayW}" height="${displayH}"><rect width="100%" height="100%" fill="#fff"/>` +
    `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${paths.join("")}</g></svg>`;
  return { markup, width: displayW, height: displayH };
}

/** Normalised form of one page's text, built once and reused per highlight. */
export interface PageIndex {
  /** Lower-cased NFKC text without whitespace and hyphens. */
  compact: string;
  /** Per `compact` UTF-16 unit, its source span in the page: [start, end, ...]. */
  pos: number[];
}

const ASCII_ONLY = /^[^\u0080-\uffff]*$/;
const SKIPPED = /[\s-]/;

// NFKC can expand one source character into several ("\uFB01" -> "fi"), so
// callers give every expanded UTF-16 unit its own entry that maps back to the
// source character's span; otherwise needle offsets drift away from the span.
const expand = (c: string) =>
  c.normalize("NFKC").toLowerCase().replace(/[\s-]/g, "");

/**
 * Build the normalised index of a page for {@link respaceWith}. Iterates by
 * code point so astral characters (surrogate pairs) stay whole, and measures
 * everything in UTF-16 units to match indexOf and slice.
 */
export function buildPageIndex(pageText: string): PageIndex {
  const pos: number[] = [];
  let compact = "";
  if (ASCII_ONLY.test(pageText)) {
    // ASCII is stable under NFKC and lower-casing is one-to-one, so skip normalize.
    for (let i = 0; i < pageText.length; i++) {
      const ch = pageText[i];
      if (SKIPPED.test(ch)) continue;
      compact += ch.toLowerCase();
      pos.push(i, i + 1);
    }
    return { compact, pos };
  }
  let i = 0;
  for (const ch of pageText) {
    const x = expand(ch);
    for (let k = 0; k < x.length; k++) pos.push(i, i + ch.length);
    compact += x;
    i += ch.length;
  }
  return { compact, pos };
}

/** {@link respace} against a prebuilt {@link PageIndex} of `pageText`. */
export function respaceWith(
  text: string,
  pageText: string | undefined,
  index: PageIndex | undefined,
): string {
  if (!pageText || !index || !text) return text;
  let needle = "";
  for (const ch of text) needle += expand(ch);
  if (!needle) return text;
  const at = index.compact.indexOf(needle);
  if (at < 0) return text;
  const first = index.pos[2 * at];
  const last = index.pos[2 * (at + needle.length - 1) + 1];
  if (first === undefined || last === undefined) return text;
  return pageText
    .slice(first, last)
    .replace(/-\s*\n\s*/g, "") // re-join hyphenated line breaks
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The tablet copies highlighted text straight from the PDF text layer, which
 * often lacks spaces ("Whenprovided"). Find the same characters in a properly
 * spaced extraction of the page and return that span instead.
 */
export function respace(text: string, pageText: string | undefined): string {
  if (!pageText || !text) return text;
  return respaceWith(text, pageText, buildPageIndex(pageText));
}

/**
 * Split Zotero's full-text extraction into per-page strings. Pages are
 * expected to be separated by a form feed. If no separator is present but the
 * document has more than one page, the text cannot be attributed to a page, so
 * return nothing rather than apply it to the wrong pages.
 */
export function splitPageTexts(
  text: string | undefined,
  totalPages?: number,
): string[] {
  if (!text) return [];
  const pages = text.split("\f");
  if (pages.length === 1 && totalPages !== 1) return [];
  return pages;
}
