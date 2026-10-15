/**
 * Builds the PDF that is sent to the reMarkable: the original Zotero file with
 * Zotero's annotations burned into the page content (so every reMarkable
 * firmware renders them identically) and, optionally, extra pages at the end
 * listing annotation comments and the item's notes.
 *
 * Flattening (instead of writing PDF annotation objects) is deliberate: the
 * reMarkable renderer ignores most annotation appearance streams, and burned-in
 * marks cannot be confused with marks made on the tablet when syncing back.
 */
import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  StandardFonts,
  rgb,
} from "pdf-lib";
import type { PageBox, ZAnnotation, ZNote } from "./types";

export interface ExportOptions {
  /** Append pages listing comments and notes. */
  appendNotesPages: boolean;
  /** Title printed on the first appended page. */
  title?: string;
}

export interface ExportResult {
  bytes: Uint8Array;
  /** Number of pages that came from the original PDF. */
  originalPageCount: number;
  /** Number of pages appended for comments / notes. */
  appendedPageCount: number;
  /** Page boxes of the original pages (used later to map coordinates back). */
  pageBoxes: PageBox[];
}

export function hexToRgb(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xffd400;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export async function buildRemarkablePdf(
  pdfBytes: Uint8Array,
  annotations: ZAnnotation[],
  notes: ZNote[],
  options: ExportOptions,
): Promise<ExportResult> {
  const doc = await PDFDocument.load(pdfBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const originalPageCount = pages.length;
  const pageBoxes = pages.map((p) => {
    const b = p.getCropBox();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });

  // Number comments so the appended list can refer to the marker on the page.
  const sorted = [...annotations].sort((a, b) =>
    (a.sortIndex ?? "").localeCompare(b.sortIndex ?? ""),
  );
  const numbered: { n: number; ann: ZAnnotation }[] = [];
  for (const ann of sorted) {
    const page = pages[ann.position.pageIndex];
    if (!page) continue;
    drawAnnotation(page, ann, font);
    if (ann.comment?.trim() || ann.type === "note") {
      const n = numbered.length + 1;
      numbered.push({ n, ann });
      drawMarker(page, ann, n, bold);
    }
  }

  let appendedPageCount = 0;
  if (options.appendNotesPages && (numbered.length || notes.length)) {
    const size = pages[0]?.getSize() ?? { width: 612, height: 792 };
    const writer = new PageWriter(doc, size.width, size.height, font, bold);
    writer.heading(
      options.title ? `Zotero notes — ${options.title}` : "Zotero notes",
    );
    if (numbered.length) {
      writer.subheading("Annotations");
      for (const { n, ann } of numbered) {
        const label = ann.pageLabel || String(ann.position.pageIndex + 1);
        writer.paragraph(`[${n}] p. ${label}`, bold);
        if (ann.text?.trim()) writer.paragraph(`“${ann.text.trim()}”`, font);
        if (ann.comment?.trim()) writer.paragraph(ann.comment.trim(), font);
        writer.gap();
      }
    }
    for (const note of notes) {
      writer.subheading(note.title || "Note");
      writer.paragraph(note.text, font);
      writer.gap();
    }
    appendedPageCount = writer.pageCount;
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, originalPageCount, appendedPageCount, pageBoxes };
}

function drawAnnotation(page: PDFPage, ann: ZAnnotation, font: PDFFont) {
  const color = hexToRgb(ann.color);
  const rects = ann.position.rects ?? [];
  switch (ann.type) {
    case "highlight":
      for (const [x1, y1, x2, y2] of rects) {
        page.drawRectangle({
          x: x1,
          y: y1,
          width: x2 - x1,
          height: y2 - y1,
          color,
          opacity: 0.4,
          blendMode: BlendMode.Multiply,
        });
      }
      break;
    case "underline":
      for (const [x1, y1, x2] of rects) {
        page.drawLine({
          start: { x: x1, y: y1 + 0.5 },
          end: { x: x2, y: y1 + 0.5 },
          thickness: 1.2,
          color,
        });
      }
      break;
    case "image":
      for (const [x1, y1, x2, y2] of rects) {
        page.drawRectangle({
          x: x1,
          y: y1,
          width: x2 - x1,
          height: y2 - y1,
          borderColor: color,
          borderWidth: 1.5,
        });
      }
      break;
    case "ink": {
      const width = ann.position.width ?? 2;
      for (const path of ann.position.paths ?? []) {
        for (let i = 2; i + 1 < path.length; i += 2) {
          page.drawLine({
            start: { x: path[i - 2], y: path[i - 1] },
            end: { x: path[i], y: path[i + 1] },
            thickness: width,
            color,
            lineCap: LineCapStyle.Round,
          });
        }
      }
      break;
    }
    case "text": {
      const [x1, y1, x2, y2] = rects[0] ?? [0, 0, 0, 0];
      const size = ann.position.fontSize ?? 12;
      const lines = wrap(
        sanitize(ann.comment ?? "", font),
        font,
        size,
        x2 - x1,
      );
      let y = y2 - size;
      for (const line of lines) {
        if (y < y1 - size) break;
        page.drawText(line, { x: x1, y, size, font, color });
        y -= size * 1.15;
      }
      break;
    }
    case "note":
      // Drawn as a numbered marker by drawMarker.
      break;
  }
}

/** Small numbered tag in the page margin next to a commented annotation. */
function drawMarker(page: PDFPage, ann: ZAnnotation, n: number, bold: PDFFont) {
  const rects = ann.position.rects ?? [];
  const paths = ann.position.paths ?? [];
  let x: number;
  let y: number;
  if (rects.length) {
    x = Math.max(...rects.map((r) => r[2]));
    y = Math.max(...rects.map((r) => r[3]));
  } else if (paths.length && paths[0].length >= 2) {
    x = paths[0][0];
    y = paths[0][1];
  } else return;
  const label = String(n);
  const size = 7;
  const w = bold.widthOfTextAtSize(label, size) + 4;
  const { width: pw } = page.getSize();
  const bx = Math.min(x + 1, page.getCropBox().x + pw - w - 1);
  const by = y - size - 1;
  page.drawRectangle({
    x: bx,
    y: by,
    width: w,
    height: size + 3,
    color: hexToRgb(ann.color),
  });
  page.drawText(label, {
    x: bx + 2,
    y: by + 2,
    size,
    font: bold,
    color: rgb(0, 0, 0),
  });
}

/** Standard 14 fonts only encode WinAnsi; replace anything else. */
export function sanitize(text: string, font: PDFFont): string {
  const supported = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\n" || supported.has(cp)) out += ch;
    else if (/\s/.test(ch)) out += " ";
    else {
      const plain = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      out += [...plain].every((c) => supported.has(c.codePointAt(0)!))
        ? plain
        : "?";
    }
  }
  return out;
}

export function wrap(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
) {
  const lines: string[] = [];
  for (const para of text.split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
      // Hard-break words that are wider than the column on their own.
      while (font.widthOfTextAtSize(line, size) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (
          cut > 1 &&
          font.widthOfTextAtSize(line.slice(0, cut), size) > maxWidth
        )
          cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Flows text onto as many new pages as needed. */
class PageWriter {
  private page!: PDFPage;
  private y = 0;
  pageCount = 0;
  private readonly margin: number;
  private readonly size = 11;

  constructor(
    private doc: PDFDocument,
    private width: number,
    private height: number,
    private font: PDFFont,
    private bold: PDFFont,
  ) {
    this.margin = Math.max(36, width * 0.08);
    this.newPage();
  }

  private newPage() {
    this.page = this.doc.addPage([this.width, this.height]);
    this.y = this.height - this.margin;
    this.pageCount++;
  }

  private line(
    text: string,
    font: PDFFont,
    size: number,
    color = rgb(0, 0, 0),
  ) {
    if (this.y - size < this.margin) this.newPage();
    this.y -= size * 1.3;
    this.page.drawText(text, { x: this.margin, y: this.y, size, font, color });
  }

  heading(text: string) {
    for (const l of wrap(
      sanitize(text, this.bold),
      this.bold,
      16,
      this.width - 2 * this.margin,
    ))
      this.line(l, this.bold, 16);
    this.gap();
  }

  subheading(text: string) {
    for (const l of wrap(
      sanitize(text, this.bold),
      this.bold,
      13,
      this.width - 2 * this.margin,
    ))
      this.line(l, this.bold, 13);
  }

  paragraph(text: string, font: PDFFont, color = rgb(0, 0, 0)) {
    for (const l of wrap(
      sanitize(text, font),
      font,
      this.size,
      this.width - 2 * this.margin,
    ))
      this.line(l, font, this.size, font === this.font ? rgb(0, 0, 0) : color);
  }

  gap() {
    this.y -= this.size * 0.8;
  }
}
