/** Page mapping from a reMarkable document's `.content` file. */

export interface RmPageRef {
  /** Page id; `<docId>/<id>.rm` holds its annotations. */
  id: string;
  /** 0-based index into the document's PDF, or undefined for inserted pages. */
  pdfIndex?: number;
  /** Position in the document as shown on the tablet (0-based). */
  order: number;
}

interface CPage {
  id: string;
  idx?: { value: string };
  redir?: { value: number };
  deleted?: { value: number };
}

export function pageRefs(content: any): RmPageRef[] {
  const cpages: CPage[] | undefined = content?.cPages?.pages;
  if (Array.isArray(cpages) && cpages.length) {
    return cpages
      .filter((p) => !p.deleted || p.deleted.value === 0)
      .sort((a, b) => {
        const x = a.idx?.value ?? "";
        const y = b.idx?.value ?? "";
        return x < y ? -1 : x > y ? 1 : 0;
      })
      .map((p, order) => ({
        id: p.id,
        pdfIndex:
          typeof p.redir?.value === "number" && p.redir.value >= 0
            ? p.redir.value
            : undefined,
        order,
      }));
  }
  const pages: string[] = Array.isArray(content?.pages) ? content.pages : [];
  const redirect: number[] | undefined = content?.redirectionPageMap;
  return pages.map((id, order) => {
    const r = redirect?.[order];
    const pdfIndex = redirect
      ? r !== undefined && r >= 0
        ? r
        : undefined
      : order;
    return { id, pdfIndex, order };
  });
}

/** Fixed-width lexicographic keys, matching the tablet's fractional `idx`. */
function idxKey(i: number, width: number) {
  let s = "";
  for (let k = 0; k < width; k++) {
    s = String.fromCharCode(98 + (i % 24)) + s; // 'b'..'y', leaves room around
    i = Math.floor(i / 24);
  }
  return s;
}

function idxWidth(n: number) {
  return Math.max(2, Math.ceil(Math.log(n + 1) / Math.log(24)));
}

interface ContentOptions {
  pageCount: number;
  sizeInBytes: number;
  newId: () => string;
  /** Client uuid recorded as the CRDT author. */
  authorId: string;
}

/** A formatVersion 2 `.content` like the tablet writes, one page per PDF page. */
export function buildPdfContent(o: ContentOptions) {
  const width = idxWidth(o.pageCount);
  const pages = Array.from({ length: o.pageCount }, (_, i) => ({
    id: o.newId(),
    idx: { timestamp: "1:2", value: idxKey(i + 1, width) },
    redir: { timestamp: "1:2", value: i },
  }));
  return {
    cPages: {
      lastOpened: { timestamp: "1:1", value: pages[0]?.id ?? "" },
      original: { timestamp: "1:1", value: o.pageCount },
      pages,
      uuids: [{ first: o.authorId, second: 1 }],
    },
    coverPageNumber: 0,
    documentMetadata: {},
    dummyDocument: false,
    extraMetadata: {},
    fileType: "pdf",
    fontName: "",
    formatVersion: 2,
    lineHeight: -1,
    margins: 125,
    orientation: "portrait",
    originalPageCount: o.pageCount,
    pageCount: o.pageCount,
    pageTags: [],
    sizeInBytes: String(o.sizeInBytes),
    tags: [],
    textAlignment: "justify",
    textScale: 1,
    zoomMode: "bestFit",
  };
}

/**
 * Adapt an existing `.content` to a replacement PDF with `pageCount` pages:
 * pages pointing past the end are marked deleted and new PDF pages are
 * appended. Existing page ids (and so their .rm annotations) are kept.
 */
export function reconcileContent(
  content: any,
  pageCount: number,
  sizeInBytes: number,
  newId: () => string,
  authorId: string,
) {
  if (!content?.cPages?.pages) {
    return buildPdfContent({ pageCount, sizeInBytes, newId, authorId });
  }
  const c = clone(content);
  const cp = c.cPages;
  const ts = contentAuthor(c, authorId);
  const seen = new Set<number>();
  for (const p of cp.pages) {
    const r = p.redir?.value;
    if (typeof r !== "number") continue;
    if (r >= pageCount && !(p.deleted?.value === 1))
      p.deleted = { timestamp: ts, value: 1 };
    else if (r < pageCount && p.deleted?.value !== 1) seen.add(r);
  }
  const missing = Array.from({ length: pageCount }, (_, i) => i).filter(
    (i) => !seen.has(i),
  );
  const width = idxWidth(missing.length);
  // Computed once: every new page shares this prefix and differs only in the
  // fixed-width suffix. Re-reading it per page would nest the idx values.
  const top = maxIdx(cp) || "b";
  missing.forEach((r, k) => {
    cp.pages.push({
      id: newId(),
      idx: { timestamp: ts, value: `${top}${idxKey(k + 1, width)}` },
      redir: { timestamp: ts, value: r },
    });
  });
  cp.original = { timestamp: ts, value: pageCount };
  c.originalPageCount = pageCount;
  c.pageCount = liveCount(cp);
  c.sizeInBytes = String(sizeInBytes);
  return c;
}

/** Deep copy; there is no structuredClone in plugin sandboxes. */
function clone(content: any) {
  return JSON.parse(JSON.stringify(content));
}

/** Pages not marked deleted. */
function liveCount(cPages: any): number {
  return cPages.pages.filter((p: any) => p.deleted?.value !== 1).length;
}

/** Highest fractional `idx` in use, so a new page can sort after it. */
function maxIdx(cPages: any): string {
  return cPages.pages.reduce(
    (m: string, p: any) => (p.idx?.value > m ? p.idx.value : m),
    "",
  );
}

/** Timestamp `<author>:<counter>` for a change by `authorId`, registering the author if needed. */
function contentAuthor(c: any, authorId: string) {
  const cp = c.cPages;
  cp.uuids ??= [];
  let author = cp.uuids.find((u: any) => u.first === authorId)?.second;
  if (!author) {
    author = Math.max(0, ...cp.uuids.map((u: any) => u.second ?? 0)) + 1;
    cp.uuids.push({ first: authorId, second: author });
  }
  return `${author}:${Date.now() % 1_000_000}`;
}

/**
 * Append a blank notebook page (no PDF page behind it) at the end of the
 * document. Returns the updated content; the page's file is `<docId>/<pageId>.rm`.
 */
export function addInsertedPage(
  content: any,
  pageId: string,
  authorId: string,
) {
  const c = clone(content);
  if (!c.cPages?.pages) throw new Error("document has no page map yet");
  c.cPages.pages.push({
    id: pageId,
    // Same shape as pages inserted on the tablet (no template => blank).
    idx: {
      timestamp: contentAuthor(c, authorId),
      value: `${maxIdx(c.cPages) || "b"}n`,
    },
  });
  c.pageCount = liveCount(c.cPages);
  return c;
}

/** Mark a page deleted (the tablet removes it on its next sync). */
export function deletePage(content: any, pageId: string, authorId: string) {
  const c = clone(content);
  const page = c.cPages?.pages?.find((p: any) => p.id === pageId);
  if (!page) return c;
  page.deleted = { timestamp: contentAuthor(c, authorId), value: 1 };
  c.pageCount = liveCount(c.cPages);
  return c;
}
