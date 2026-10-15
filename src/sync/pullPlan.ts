/** Pure (Zotero-free) decisions for the pull pass, unit-testable in Node. */

export interface ImportedLike {
  kind: "annotation" | "note";
}

/** True when the rmKey was produced for ink (pen stroke clusters). */
export function isInkKey(rmKey: string): boolean {
  return rmKey.split("/")[1] === "i";
}

/**
 * Parses the pages of a document. `rm` comes from the document index, so a
 * page without a blob has no drawing data: it is an empty page and yields no
 * entry (its imported records are then erased). Only a blob that exists but
 * fails to parse is unreadable, which keeps its imported records.
 */
export function readPages<R extends { id: string }, P>(
  refs: readonly R[],
  rm: ReadonlyMap<string, Uint8Array>,
  parse: (data: Uint8Array) => P,
  onError?: (ref: R, e: unknown) => void,
): { pages: { ref: R; page: P }[]; unreadable: Set<string> } {
  const pages: { ref: R; page: P }[] = [];
  const unreadable = new Set<string>();
  for (const ref of refs) {
    const data = rm.get(ref.id);
    if (!data) continue;
    try {
      pages.push({ ref, page: parse(data) });
    } catch (e) {
      unreadable.add(ref.id);
      onError?.(ref, e);
    }
  }
  return { pages, unreadable };
}

/**
 * Previously imported records that this pull must erase: only those whose
 * source is genuinely gone from the tablet. Records are kept when
 * - the candidate with that rmKey was seen in this pull,
 * - their page could not be read (its .rm exists but fails to parse), since
 *   the candidates missing from it say nothing about the content (a page
 *   with no .rm blob is an empty page and does not count as unreadable), or
 * - handwriting import is off, which filters ink and notes out of the
 *   candidates, so their absence is not an erase on the tablet.
 */
export function keysToErase(
  imported: Record<string, ImportedLike>,
  seen: ReadonlySet<string>,
  unreadablePageIds: ReadonlySet<string>,
  importHandwriting: boolean,
): string[] {
  const out: string[] = [];
  for (const [rmKey, rec] of Object.entries(imported)) {
    if (seen.has(rmKey)) continue;
    if (unreadablePageIds.has(rmKey.split("/")[0])) continue;
    if (!importHandwriting && (rec.kind === "note" || isInkKey(rmKey)))
      continue;
    out.push(rmKey);
  }
  return out;
}
