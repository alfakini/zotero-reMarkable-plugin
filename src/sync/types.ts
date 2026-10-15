/**
 * Plain-data shapes shared between the Zotero side and the reMarkable side.
 * Nothing here touches Zotero globals so the conversion code can be unit
 * tested in Node.
 */

/** Zotero annotation as exposed by `Zotero.Annotations.toJSON`-like data. */
export interface ZAnnotation {
  key: string;
  type: "highlight" | "underline" | "note" | "text" | "image" | "ink";
  text?: string;
  comment?: string;
  color: string;
  pageLabel?: string;
  sortIndex?: string;
  position: ZPosition;
  tags?: string[];
}

export interface ZPosition {
  pageIndex: number;
  /** [x1, y1, x2, y2] in PDF user space, origin bottom-left. */
  rects?: number[][];
  /** Ink paths: flat [x, y, x, y, ...] arrays in PDF user space. */
  paths?: number[][];
  width?: number;
  fontSize?: number;
  rotation?: number;
}

/** A standalone Zotero note rendered on the appended notes pages. */
export interface ZNote {
  key: string;
  title: string;
  text: string;
}

/** Size of one PDF page in points, plus its user-space origin. */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
