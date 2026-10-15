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

/**
 * Note candidates (margin notes, notebook pages) become child notes, which
 * Zotero only allows under a regular item. For a standalone PDF attachment
 * they are skipped.
 */
export function canSaveCandidate(
  kind: "annotation" | "note",
  attachmentHasParent: boolean,
): boolean {
  return kind === "annotation" || attachmentHasParent;
}

export interface CandidateFailure {
  rmKey: string;
  message: string;
}

/**
 * One readable report line for the candidates that could not be saved. Lists
 * at most `max` of them so a page full of failures does not flood the UI.
 */
export function formatCandidateFailures(
  failures: readonly CandidateFailure[],
  total: number,
  max = 3,
): string {
  const shown = failures
    .slice(0, max)
    .map((f) => `${f.rmKey}: ${f.message}`)
    .join("; ");
  const more =
    failures.length > max ? `; and ${failures.length - max} more` : "";
  return `could not import ${failures.length} of ${total} items (${shown}${more}); will retry on the next sync`;
}

/**
 * Whether the tablet copy must be pulled: it changed, the converter changed,
 * or the previous pull left candidates unsaved.
 */
export function needsPull(
  doc: {
    rmDocHash?: string;
    converterVersion?: number;
    pullIncomplete?: boolean;
  },
  entryHash: string,
  converterVersion: number,
): boolean {
  return (
    doc.rmDocHash !== entryHash ||
    doc.converterVersion !== converterVersion ||
    !!doc.pullIncomplete
  );
}
