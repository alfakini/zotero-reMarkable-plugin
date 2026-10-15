/**
 * Reader for reMarkable v6 `.rm` page files (firmware 3.x, incl. Paper Pro).
 *
 * The format is a sequence of length-prefixed blocks whose bodies are
 * "tagged" values (tag = varuint(index << 4 | type)). Every block and every
 * subblock is skipped to its declared end after parsing, so newer firmware
 * that appends fields keeps working. Reference: ricklupton/rmscene.
 */

export const HEADER = "reMarkable .lines file, version=6";

export interface CrdtId {
  part1: number;
  part2: number;
}

export interface RmPoint {
  x: number;
  y: number;
  /** Normalised to the v2 scale (v1 values are converted). */
  speed: number;
  direction: number;
  width: number;
  pressure: number;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface RmLine {
  id: string;
  parent: string;
  tool: number;
  color: number;
  rgba?: Rgba;
  thicknessScale: number;
  points: RmPoint[];
}

export interface RmRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RmGlyph {
  id: string;
  parent: string;
  color: number;
  rgba?: Rgba;
  text: string;
  rects: RmRect[];
}

export const ParagraphStyle = {
  BASIC: 0,
  PLAIN: 1,
  HEADING: 2,
  BOLD: 3,
  BULLET: 4,
  BULLET2: 5,
  CHECKBOX: 6,
  CHECKBOX_CHECKED: 7,
} as const;

export interface RmParagraph {
  style: number;
  text: string;
}

/** A run of text in the CRDT sequence, as stored in the file. */
export interface RmTextItem {
  id: CrdtId;
  left: CrdtId;
  right: CrdtId;
  /** Number of characters (live or deleted) covered by this run. */
  length: number;
  deleted: boolean;
}

export interface RmText {
  /** Plain text, paragraphs separated by "\n". */
  text: string;
  x: number;
  y: number;
  width: number;
  paragraphs: RmParagraph[];
  items: RmTextItem[];
  /** Id of the last character in document order (live or deleted). */
  lastCharId?: CrdtId;
}

export interface RmPage {
  lines: RmLine[];
  glyphs: RmGlyph[];
  text?: RmText;
  /** The root text block, even when it holds no visible text. */
  rootText?: RmText;
  /** Highest CRDT counter used anywhere in the file (for new ids). */
  maxCounter: number;
  /** Author id -> UUID bytes (little-endian), from the AuthorIds block. */
  authors: { id: number; uuid: Uint8Array }[];
}

export const Tool = {
  PAINTBRUSH: [0, 12],
  PENCIL: [1, 14],
  BALLPOINT: [2, 15],
  MARKER: [3, 16],
  FINELINER: [4, 17],
  HIGHLIGHTER: [5, 18],
  ERASER: [6],
  MECHANICAL_PENCIL: [7, 13],
  ERASER_AREA: [8],
  CALLIGRAPHY: [21],
  SHADER: [23],
} as const;

export const isHighlighter = (tool: number) =>
  (Tool.HIGHLIGHTER as readonly number[]).includes(tool);
export const isShader = (tool: number) =>
  (Tool.SHADER as readonly number[]).includes(tool);
export const isEraser = (tool: number) => tool === 6 || tool === 8;

enum TagType {
  ID = 0xf,
  Length4 = 0xc,
  Byte8 = 0x8,
  Byte4 = 0x4,
  Byte1 = 0x1,
}

export class RmParseError extends Error {}

export const idKey = (id: CrdtId) => `${id.part1}:${id.part2}`;
const END_MARKER = "0:0";

class Reader {
  private view: DataView;
  pos = 0;

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get length() {
    return this.buf.length;
  }

  need(n: number) {
    if (this.pos + n > this.buf.length)
      throw new RmParseError("unexpected end of data");
  }
  u8() {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32() {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bytes(n: number) {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** LEB128; uses multiplication so values above 2^32 survive. */
  varuint() {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = this.u8();
      result += (b & 0x7f) * mul;
      if (!(b & 0x80)) return result;
      mul *= 128;
    }
  }
  /** Highest CRDT counter seen (sentinels near 2^64 are ignored). */
  maxCounter = 0;

  crdtId(): CrdtId {
    const id = { part1: this.u8(), part2: this.varuint() };
    if (id.part2 < 2 ** 40 && id.part2 > this.maxCounter) {
      this.maxCounter = id.part2;
    }
    return id;
  }
}

/** Tagged-value reader bounded to the current block / subblock. */
class TaggedReader {
  private ends: number[] = [];

  constructor(public r: Reader) {}

  get end() {
    return this.ends.length ? this.ends[this.ends.length - 1] : this.r.length;
  }

  remaining() {
    return this.end - this.r.pos;
  }

  private peekTag(): { index: number; type: number } | undefined {
    if (this.r.pos >= this.end) return undefined;
    const save = this.r.pos;
    try {
      const x = this.r.varuint();
      return { index: Math.floor(x / 16), type: x % 16 };
    } catch {
      return undefined;
    } finally {
      this.r.pos = save;
    }
  }

  has(index: number, type: TagType) {
    const t = this.peekTag();
    return !!t && t.index === index && t.type === type;
  }

  private tag(index: number, type: TagType) {
    const t = this.peekTag();
    if (!t || t.index !== index || t.type !== type) {
      throw new RmParseError(
        `expected tag ${index}/${type}, got ${t ? `${t.index}/${t.type}` : "end"} at ${this.r.pos}`,
      );
    }
    this.r.varuint();
  }

  id(index: number) {
    this.tag(index, TagType.ID);
    return this.r.crdtId();
  }
  bool(index: number) {
    this.tag(index, TagType.Byte1);
    return this.r.u8() !== 0;
  }
  byte(index: number) {
    this.tag(index, TagType.Byte1);
    return this.r.u8();
  }
  int(index: number) {
    this.tag(index, TagType.Byte4);
    return this.r.u32();
  }
  float(index: number) {
    this.tag(index, TagType.Byte4);
    return this.r.f32();
  }
  double(index: number) {
    this.tag(index, TagType.Byte8);
    return this.r.f64();
  }

  /** Run `fn` inside subblock `index`, then seek to the subblock's end. */
  subblock<T>(index: number, fn: (len: number) => T): T {
    this.tag(index, TagType.Length4);
    const len = this.r.u32();
    const end = this.r.pos + len;
    if (end > this.end) throw new RmParseError("subblock overruns parent");
    this.ends.push(end);
    try {
      return fn(len);
    } finally {
      this.ends.pop();
      this.r.pos = end;
    }
  }

  hasSubblock(index: number) {
    return this.has(index, TagType.Length4);
  }

  string(index: number): string {
    return this.subblock(index, () => {
      const len = this.r.varuint();
      this.r.u8(); // is_ascii flag
      return new TextDecoder("utf-8").decode(this.r.bytes(len));
    });
  }

  /** String that may instead carry an integer formatting code. */
  stringWithFormat(index: number): string | number {
    return this.subblock(index, () => {
      const len = this.r.varuint();
      this.r.u8();
      const s = new TextDecoder("utf-8").decode(this.r.bytes(len));
      if (this.has(2, TagType.Byte4)) return this.int(2);
      return s;
    });
  }

  /** Last-writer-wins register: subblock{ 1: timestamp id, 2: value }. */
  lww<T>(index: number, read: (t: TaggedReader) => T): T {
    return this.subblock(index, () => {
      this.id(1);
      return read(this);
    });
  }

  block<T>(len: number, fn: () => T): T {
    const end = this.r.pos + len;
    this.ends.push(Math.min(end, this.r.length));
    try {
      return fn();
    } finally {
      this.ends.pop();
      this.r.pos = end;
    }
  }
}

function readRgba(t: TaggedReader, index: number): Rgba | undefined {
  if (!t.has(index, TagType.Byte4)) return undefined;
  const v = t.int(index);
  return { r: (v >>> 16) & 255, g: (v >>> 8) & 255, b: v & 255, a: v >>> 24 };
}

interface ItemEnvelope {
  parent: string;
  id: string;
  left: string;
  right: string;
  deletedLength: number;
}

function readItemEnvelope(t: TaggedReader): ItemEnvelope {
  return {
    parent: idKey(t.id(1)),
    id: idKey(t.id(2)),
    left: idKey(t.id(3)),
    right: idKey(t.id(4)),
    deletedLength: t.int(5),
  };
}

function readPoints(t: TaggedReader, version: number): RmPoint[] {
  return t.subblock(5, (len) => {
    const size = version === 1 ? 24 : 14;
    if (len % size) throw new RmParseError(`bad point data length ${len}`);
    const r = t.r;
    const out: RmPoint[] = [];
    for (let i = 0; i < len / size; i++) {
      if (version === 1) {
        const x = r.f32();
        const y = r.f32();
        const speed = r.f32() * 4;
        const direction = (r.f32() * 255) / (2 * Math.PI);
        const width = Math.round(r.f32() * 4);
        const pressure = r.f32() * 255;
        out.push({ x, y, speed, direction, width, pressure });
      } else {
        const x = r.f32();
        const y = r.f32();
        const speed = r.u16();
        const width = r.u16();
        const direction = r.u8();
        const pressure = r.u8();
        out.push({ x, y, speed, direction, width, pressure });
      }
    }
    return out;
  });
}

function readLine(t: TaggedReader, env: ItemEnvelope, version: number): RmLine {
  const tool = t.int(1);
  const color = t.int(2);
  const thicknessScale = t.double(3);
  t.float(4); // starting_length
  const points = readPoints(t, version);
  if (t.has(6, TagType.ID)) t.id(6); // timestamp
  if (t.has(7, TagType.ID)) t.id(7); // move_id
  const rgba = readRgba(t, 8);
  return {
    id: env.id,
    parent: env.parent,
    tool,
    color,
    rgba,
    thicknessScale,
    points,
  };
}

function readGlyph(t: TaggedReader, env: ItemEnvelope): RmGlyph {
  if (t.has(2, TagType.Byte4)) t.int(2); // start (absent since 3.6)
  if (t.has(3, TagType.Byte4)) t.int(3); // length
  const color = t.int(4);
  const text = t.string(5);
  const rects = t.subblock(6, () => {
    const n = t.r.varuint();
    const out: RmRect[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ x: t.r.f64(), y: t.r.f64(), w: t.r.f64(), h: t.r.f64() });
    }
    return out;
  });
  const rgba = readRgba(t, 10);
  return { id: env.id, parent: env.parent, color, rgba, text, rects };
}

interface TextChar {
  id: string;
  left: string;
  right: string;
  value: string | number | null; // null = deleted
}

/** Full RootTextBlock parse, expanding text runs into per-character CRDT items. */
function readRootTextBlock(t: TaggedReader): RmText {
  t.id(1);
  const chars: TextChar[] = [];
  const items: RmTextItem[] = [];
  const styles = new Map<string, number>();
  t.subblock(2, () => {
    t.subblock(1, () =>
      t.subblock(1, () => {
        const n = t.r.varuint();
        for (let i = 0; i < n; i++) {
          t.subblock(0, () => {
            const id = t.id(2);
            const leftId = t.id(3);
            const rightId = t.id(4);
            const left = idKey(leftId);
            const right = idKey(rightId);
            const deleted = t.int(5);
            let value: string | number = "";
            if (t.hasSubblock(6)) value = t.stringWithFormat(6);
            const runLen =
              typeof value === "number" ? 1 : [...value].length || deleted;
            const glyphs = typeof value === "number" ? [value] : [...value];
            // Each character of a run consumes a counter value.
            const lastCounter = id.part2 + runLen - 1;
            if (lastCounter < 2 ** 40 && lastCounter > t.r.maxCounter) {
              t.r.maxCounter = lastCounter;
            }
            items.push({
              id,
              left: leftId,
              right: rightId,
              length: runLen,
              deleted: !!deleted && typeof value === "string" && !value,
            });
            for (let k = 0; k < runLen; k++) {
              chars.push({
                id: idKey({ part1: id.part1, part2: id.part2 + k }),
                left:
                  k === 0
                    ? left
                    : idKey({ part1: id.part1, part2: id.part2 + k - 1 }),
                right:
                  k === runLen - 1
                    ? right
                    : idKey({ part1: id.part1, part2: id.part2 + k + 1 }),
                value:
                  deleted && typeof value === "string" && !value
                    ? null
                    : (glyphs[k] ?? null),
              });
            }
          });
        }
      }),
    );
    // Paragraph styles, keyed by the id of the paragraph's leading "\n"
    // ((0,0) for the first paragraph).
    if (t.hasSubblock(2)) {
      t.subblock(2, () =>
        t.subblock(1, () => {
          const n = t.r.varuint();
          for (let i = 0; i < n; i++) {
            const charId = t.r.crdtId();
            t.id(1);
            const style = t.subblock(2, () => {
              t.r.u8(); // always 17
              return t.r.u8();
            });
            styles.set(idKey(charId), style);
          }
        }),
      );
    }
  });
  const pos = t.subblock(3, () => ({ x: t.r.f64(), y: t.r.f64() }));
  const width = t.float(4);
  const ordered = toposort(chars);
  const paragraphs: RmParagraph[] = [];
  let current: RmParagraph = {
    style: styles.get("0:0") ?? ParagraphStyle.PLAIN,
    text: "",
  };
  for (const c of ordered) {
    if (typeof c.value !== "string") continue;
    if (c.value === "\n") {
      paragraphs.push(current);
      current = { style: styles.get(c.id) ?? ParagraphStyle.PLAIN, text: "" };
    } else current.text += c.value;
  }
  paragraphs.push(current);
  const text = paragraphs.map((p) => p.text).join("\n");
  const last = ordered[ordered.length - 1];
  const lastCharId = last
    ? (() => {
        const [p1, p2] = last.id.split(":").map(Number);
        return { part1: p1, part2: p2 };
      })()
    : undefined;
  return { text, x: pos.x, y: pos.y, width, paragraphs, items, lastCharId };
}

/**
 * Order CRDT sequence items by their left/right links (rmscene algorithm).
 * Kahn's algorithm in waves: every wave is the set of nodes whose
 * prerequisites were all emitted by earlier waves, sorted by id. Runs in
 * O((n + e) + n log n) using indegree counts and dependents lists.
 */
export function toposort<T extends { id: string; left: string; right: string }>(
  items: T[],
): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const side = (id: string, s: "left" | "right") =>
    id === END_MARKER ? (s === "left" ? "__start" : "__end") : id;
  // Nodes get a stable index in first-seen order; prerequisites are sets so a
  // repeated link counts once.
  const index = new Map<string, number>();
  const names: string[] = [];
  const prereqs: Set<number>[] = [];
  const dependents: number[][] = [];
  const node = (k: string) => {
    let n = index.get(k);
    if (n === undefined) {
      n = names.length;
      index.set(k, n);
      names.push(k);
      prereqs.push(new Set());
      dependents.push([]);
    }
    return n;
  };
  const link = (from: string, to: string) => {
    // `to` depends on `from`.
    const f = node(from);
    const t = node(to);
    if (prereqs[t].has(f)) return;
    prereqs[t].add(f);
    dependents[f].push(t);
  };
  for (const item of items) {
    link(side(item.left, "left"), item.id);
    link(item.id, side(item.right, "right"));
  }
  const remaining = prereqs.map((p) => p.size);
  const end = index.get("__end");
  const out: T[] = [];
  const cmp = (a: string, b: string) => {
    const [a1, a2] = a.split(":").map(Number);
    const [b1, b2] = b.split(":").map(Number);
    return a1 - b1 || a2 - b2;
  };
  let wave: number[] = [];
  for (let n = 0; n < names.length; n++) if (remaining[n] === 0) wave.push(n);
  // Stop at a cycle (nothing ready) or when only the end sentinel is left.
  while (wave.length && !wave.every((n) => n === end)) {
    const next: number[] = [];
    for (const n of wave) {
      for (const d of dependents[n]) if (--remaining[d] === 0) next.push(d);
    }
    wave
      .map((n) => names[n])
      .filter((k) => byId.has(k))
      .sort(cmp)
      .forEach((k) => {
        out.push(byId.get(k)!);
      });
    // Keep first-seen order so ties sort exactly as a full rescan would.
    wave = next.sort((x, y) => x - y);
  }
  // Anything left (malformed links) is appended rather than dropped.
  if (out.length < items.length) {
    const seen = new Set(out.map((i) => i.id));
    for (const i of items) if (!seen.has(i.id)) out.push(i);
  }
  return out;
}

const BLOCK = {
  AuthorIds: 0x09,
  SceneTree: 0x01,
  TreeNode: 0x02,
  GlyphItem: 0x03,
  GroupItem: 0x04,
  LineItem: 0x05,
  RootText: 0x07,
} as const;

export function parseRm(data: Uint8Array): RmPage {
  const header = new TextDecoder("ascii").decode(
    data.subarray(0, HEADER.length),
  );
  if (header !== HEADER) {
    throw new RmParseError(`unsupported .rm file (header "${header.trim()}")`);
  }
  const r = new Reader(data);
  r.pos = 43;
  const t = new TaggedReader(r);
  const lines: RmLine[] = [];
  const glyphs: RmGlyph[] = [];
  let text: RmText | undefined;
  const authors: RmPage["authors"] = [];
  const hidden = new Set<string>();
  /** child group -> parent group */
  const groupParent = new Map<string, string>();

  while (r.pos + 8 <= r.length) {
    const len = r.u32();
    r.u8(); // unknown
    r.u8(); // min version
    const version = r.u8();
    const type = r.u8();
    if (r.pos + len > r.length) break;
    try {
      t.block(len, () => {
        switch (type) {
          case BLOCK.TreeNode: {
            const id = idKey(t.id(1));
            t.lww(2, (x) => x.string(2)); // label
            const visible = t.lww(3, (x) => x.bool(2));
            if (!visible) hidden.add(id);
            break;
          }
          case BLOCK.GroupItem: {
            const env = readItemEnvelope(t);
            if (!t.hasSubblock(6)) break;
            t.subblock(6, () => {
              t.r.u8(); // item type
              groupParent.set(idKey(t.id(2)), env.parent);
            });
            break;
          }
          case BLOCK.LineItem: {
            const env = readItemEnvelope(t);
            if (!t.hasSubblock(6)) break; // deleted
            t.subblock(6, () => {
              if (t.r.u8() !== 3) return;
              lines.push(readLine(t, env, version));
            });
            break;
          }
          case BLOCK.GlyphItem: {
            const env = readItemEnvelope(t);
            if (!t.hasSubblock(6)) break;
            t.subblock(6, () => {
              if (t.r.u8() !== 1) return;
              glyphs.push(readGlyph(t, env));
            });
            break;
          }
          case BLOCK.AuthorIds: {
            const n = t.r.varuint();
            for (let i = 0; i < n; i++) {
              t.subblock(0, () => {
                const len = t.r.varuint();
                const uuid = t.r.bytes(len).slice();
                authors.push({ id: t.r.u16(), uuid });
              });
            }
            break;
          }
          case BLOCK.RootText:
            text = readRootTextBlock(t);
            break;
          default:
            break; // skipped by t.block
        }
      });
    } catch (e) {
      if (!(e instanceof RmParseError)) throw e;
      // Corrupt or unknown variant: block end is known, so carry on.
    }
  }

  const isHidden = (group: string) => {
    for (
      let g: string | undefined = group, n = 0;
      g && n < 64;
      g = groupParent.get(g), n++
    ) {
      if (hidden.has(g)) return true;
    }
    return false;
  };
  return {
    lines: lines.filter((l) => !isHidden(l.parent)),
    glyphs: glyphs.filter((g) => !isHidden(g.parent)),
    text: text?.text.trim() ? text : undefined,
    rootText: text,
    maxCounter: r.maxCounter,
    authors,
  };
}
