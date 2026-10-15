/**
 * Writes typed text into reMarkable v6 `.rm` pages.
 *
 * Edits are expressed the way the tablet itself records them in the text
 * CRDT: existing text runs are marked deleted and the new text is inserted
 * after them by our own author id, with counters above anything in the file.
 * All other blocks (strokes, highlights, layers, scene info) are copied
 * byte-for-byte, so handwriting on the page is untouched.
 * Format reference: ricklupton/rmscene (scene_stream.py, tagged_block_writer.py).
 */
import {
  HEADER,
  ParagraphStyle,
  parseRm,
  type CrdtId,
  type RmParagraph,
} from "./rmscene";

enum Tag {
  ID = 0xf,
  Length4 = 0xc,
  Byte8 = 0x8,
  Byte4 = 0x4,
  Byte1 = 0x1,
}

class Writer {
  private chunks: number[] = [];

  get length() {
    return this.chunks.length;
  }

  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.chunks.push(b[i]);
  }
  u8(v: number) {
    this.chunks.push(v & 255);
  }
  u16(v: number) {
    this.u8(v);
    this.u8(v >>> 8);
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.bytes(b);
  }
  f32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.bytes(b);
  }
  f64(v: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.bytes(b);
  }
  varuint(v: number) {
    do {
      let b = v % 128;
      v = Math.floor(v / 128);
      if (v > 0) b |= 0x80;
      this.u8(b);
    } while (v > 0);
  }
  crdtId(id: CrdtId) {
    this.u8(id.part1);
    this.varuint(id.part2);
  }
  tag(index: number, type: Tag) {
    this.varuint(index * 16 + type);
  }
  id(index: number, id: CrdtId) {
    this.tag(index, Tag.ID);
    this.crdtId(id);
  }
  bool(index: number, v: boolean) {
    this.tag(index, Tag.Byte1);
    this.u8(v ? 1 : 0);
  }
  int(index: number, v: number) {
    this.tag(index, Tag.Byte4);
    this.u32(v);
  }
  float(index: number, v: number) {
    this.tag(index, Tag.Byte4);
    this.f32(v);
  }
  subblock(index: number, fn: (w: Writer) => void) {
    const inner = new Writer();
    fn(inner);
    this.tag(index, Tag.Length4);
    this.u32(inner.length);
    this.bytes(inner.chunks);
  }
  string(index: number, s: string) {
    this.subblock(index, (w) => {
      const b = new TextEncoder().encode(s);
      w.varuint(b.length);
      w.u8(1); // is_ascii flag, always 1 in device files
      w.bytes(b);
    });
  }
  lwwString(index: number, ts: CrdtId, s: string) {
    this.subblock(index, (w) => {
      w.id(1, ts);
      w.string(2, s);
    });
  }
  lwwBool(index: number, ts: CrdtId, v: boolean) {
    this.subblock(index, (w) => {
      w.id(1, ts);
      w.bool(2, v);
    });
  }
  toBytes() {
    return Uint8Array.from(this.chunks);
  }
}

interface RawBlock {
  type: number;
  minVersion: number;
  version: number;
  body: Uint8Array;
}

function splitBlocks(data: Uint8Array): RawBlock[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: RawBlock[] = [];
  let pos = HEADER.length + 10; // header is padded to 43 bytes
  while (pos + 8 <= data.length) {
    const len = view.getUint32(pos, true);
    const minVersion = data[pos + 5];
    const version = data[pos + 6];
    const type = data[pos + 7];
    if (pos + 8 + len > data.length) break;
    out.push({
      type,
      minVersion,
      version,
      body: data.subarray(pos + 8, pos + 8 + len),
    });
    pos += 8 + len;
  }
  return out;
}

function joinBlocks(blocks: RawBlock[]): Uint8Array {
  const w = new Writer();
  w.bytes(new TextEncoder().encode(HEADER.padEnd(43, " ")));
  for (const b of blocks) {
    w.u32(b.body.length);
    w.u8(0);
    w.u8(b.minVersion);
    w.u8(b.version);
    w.u8(b.type);
    w.bytes(b.body);
  }
  return w.toBytes();
}

const block = (
  type: number,
  minVersion: number,
  version: number,
  fn: (w: Writer) => void,
): RawBlock => {
  const w = new Writer();
  fn(w);
  return { type, minVersion, version, body: w.toBytes() };
};

const ZERO: CrdtId = { part1: 0, part2: 0 };

/** UUID string -> 16 bytes in the little-endian GUID layout used by the file. */
export function uuidBytesLE(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const b = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  // bytes_le: first three fields are little-endian.
  return Uint8Array.from([
    b[3],
    b[2],
    b[1],
    b[0],
    b[5],
    b[4],
    b[7],
    b[6],
    ...b.slice(8),
  ]);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export interface WriteTextOptions {
  /** Our CRDT author UUID (stable per installation). */
  authorUuid: string;
  /** A device-written page to copy scene info / text geometry from. */
  template?: Uint8Array;
}

/**
 * Return `.rm` bytes for a page whose typed text is `paragraphs`.
 * `existing` is the page's current file (undefined for a new page).
 */
export function writePageText(
  existing: Uint8Array | undefined,
  paragraphs: RmParagraph[],
  opts: WriteTextOptions,
): Uint8Array {
  const page = existing ? parseRm(existing) : undefined;
  const tmpl = opts.template ? parseRm(opts.template) : undefined;
  const ourUuid = uuidBytesLE(opts.authorUuid);

  const authors = [...(page?.authors ?? [])];
  let author = authors.find((a) => sameBytes(a.uuid, ourUuid))?.id;
  if (!author) {
    author = Math.max(0, ...authors.map((a) => a.id)) + 1;
    authors.push({ id: author, uuid: ourUuid });
  }
  // Lamport-style: everything we write is newer than anything in the file.
  let counter = Math.max(page?.maxCounter ?? 0, 16) + 1;
  const ts: CrdtId = { part1: author, part2: counter++ };

  const old = page?.rootText;
  const geometry = old ?? tmpl?.rootText ?? { x: -468, y: 234, width: 936 };
  const text = paragraphs.map((p) => p.text.replace(/\n/g, " ")).join("\n");
  const chars = [...text];
  const runId: CrdtId = { part1: author, part2: counter };

  const rootText = block(0x07, 1, 1, (w) => {
    w.id(1, ZERO);
    w.subblock(2, (w2) => {
      w2.subblock(1, (w3) =>
        w3.subblock(1, (w4) => {
          const items = old?.items ?? [];
          const count = items.length + (chars.length ? 1 : 0);
          w4.varuint(count);
          // Existing runs, all marked deleted.
          for (const it of items) {
            w4.subblock(0, (w5) => {
              w5.id(2, it.id);
              w5.id(3, it.left);
              w5.id(4, it.right);
              w5.int(5, it.length);
            });
          }
          if (chars.length) {
            w4.subblock(0, (w5) => {
              w5.id(2, runId);
              w5.id(3, old?.lastCharId ?? ZERO);
              w5.id(4, ZERO);
              w5.int(5, 0);
              w5.string(6, text);
            });
          }
        }),
      );
      // Paragraph styles: first paragraph keyed (0,0), others by their "\n".
      const styles: [CrdtId, number][] = [
        [ZERO, paragraphs[0]?.style ?? ParagraphStyle.PLAIN],
      ];
      let offset = 0;
      for (let i = 0; i < paragraphs.length - 1; i++) {
        offset += [...paragraphs[i].text.replace(/\n/g, " ")].length;
        styles.push([
          { part1: author, part2: runId.part2 + offset },
          paragraphs[i + 1].style,
        ]);
        offset += 1; // the "\n"
      }
      w2.subblock(2, (w3) =>
        w3.subblock(1, (w4) => {
          w4.varuint(styles.length);
          for (const [charId, style] of styles) {
            w4.crdtId(charId);
            w4.id(1, ts);
            w4.subblock(2, (w5) => {
              w5.u8(17);
              w5.u8(style);
            });
          }
        }),
      );
    });
    w.subblock(3, (w2) => {
      w2.f64(geometry.x);
      w2.f64(geometry.y);
    });
    w.float(4, geometry.width);
  });

  const authorBlock = block(0x09, 1, 1, (w) => {
    w.varuint(authors.length);
    for (const a of authors) {
      w.subblock(0, (w2) => {
        w2.varuint(a.uuid.length);
        w2.bytes(a.uuid);
        w2.u16(a.id);
      });
    }
  });

  const pageInfo = block(0x0a, 0, 1, (w) => {
    w.int(1, 1);
    w.int(2, 0);
    w.int(3, chars.length + 1);
    w.int(4, paragraphs.length);
    w.int(5, 0);
  });

  if (existing) {
    const blocks = splitBlocks(existing);
    const out: RawBlock[] = [];
    let wroteText = false;
    let wroteAuthors = false;
    for (const b of blocks) {
      if (b.type === 0x09) {
        out.push(authorBlock);
        wroteAuthors = true;
      } else if (b.type === 0x07) {
        out.push(rootText);
        wroteText = true;
      } else if (b.type === 0x0a) {
        out.push(pageInfo);
      } else out.push(b);
    }
    if (!wroteAuthors) out.unshift(authorBlock);
    if (!wroteText) {
      // Text goes after the scene tree declarations, before tree nodes.
      let at = out.findIndex((b) => b.type === 0x02);
      if (at < 0) at = out.length;
      out.splice(at, 0, rootText);
    }
    return joinBlocks(out);
  }

  // A fresh page, laid out like the tablet writes them.
  const sceneInfo = opts.template
    ? splitBlocks(opts.template).find((b) => b.type === 0x0d)
    : undefined;
  const blocks: RawBlock[] = [
    authorBlock,
    block(0x00, 1, 1, (w) => {
      w.id(1, { part1: 1, part2: 1 });
      w.bool(2, true);
      w.bool(3, false);
    }),
    pageInfo,
    ...(sceneInfo ? [sceneInfo] : []),
    block(0x01, 1, 1, (w) => {
      w.id(1, { part1: 0, part2: 11 });
      w.id(2, ZERO);
      w.bool(3, true);
      w.subblock(4, (w2) => w2.id(1, { part1: 0, part2: 1 }));
    }),
    rootText,
    block(0x02, 1, 2, (w) => {
      w.id(1, { part1: 0, part2: 1 });
      w.lwwString(2, ZERO, "");
      w.lwwBool(3, ZERO, true);
    }),
    block(0x02, 1, 2, (w) => {
      w.id(1, { part1: 0, part2: 11 });
      w.lwwString(2, { part1: 0, part2: 12 }, "Layer 1");
      w.lwwBool(3, ZERO, true);
    }),
    block(0x04, 1, 1, (w) => {
      w.id(1, { part1: 0, part2: 1 });
      w.id(2, { part1: 0, part2: 13 });
      w.id(3, ZERO);
      w.id(4, ZERO);
      w.int(5, 0);
      w.subblock(6, (w2) => {
        w2.u8(2);
        w2.id(2, { part1: 0, part2: 11 });
      });
    }),
  ];
  return joinBlocks(blocks);
}
