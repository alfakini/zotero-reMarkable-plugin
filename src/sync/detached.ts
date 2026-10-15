/**
 * Pure (Zotero-free) helpers for imported objects whose tablet document was
 * replaced, unit-testable in Node.
 *
 * When a PDF change forces a re-upload as a new tablet document, what was
 * imported from the old one stays in Zotero. Its rmKeys belong to the old
 * document, so it cannot stay in `imported` (the next pull would erase it as
 * "gone from the tablet"). Its Zotero keys are kept in `detachedImported`
 * instead, so it is neither erased nor mistaken for the user's own work and
 * burned into the uploaded PDF.
 */

export interface DetachSource {
  imported?: Record<string, { zoteroKey: string }>;
  detachedImported?: readonly string[];
}

/**
 * Zotero keys to detach when `prev` is replaced: already detached + imported,
 * plus the persistent registry of forgotten documents, which is how a
 * forgotten pending upload hands its keys to the re-upload.
 */
export function buildDetachedList(
  prev: DetachSource | undefined,
  registry: Iterable<string> = [],
): string[] {
  const keys = new Set<string>([
    ...(prev?.detachedImported ?? []),
    ...registry,
  ]);
  for (const rec of Object.values(prev?.imported ?? {}))
    keys.add(rec.zoteroKey);
  return [...keys];
}

/**
 * Zotero keys that are not the user's own: imported from the tablet or
 * detached from a replaced document. They are never burned into the PDF.
 */
export function skipKeys(
  doc: DetachSource | undefined,
  /** Keys from the persistent registry of forgotten documents. */
  registry: Iterable<string> = [],
): Set<string> {
  return new Set(buildDetachedList(doc, registry));
}

/**
 * Forget the detached keys of a document whose objects were just erased.
 * `imported` is cleared only with `reimport` (otherwise its records stay, so
 * the objects are not pulled again, like deleting them by hand).
 */
export function clearErased(
  doc: DetachSource & { imported: Record<string, { zoteroKey: string }> },
  reimport: boolean,
): void {
  doc.detachedImported = undefined;
  if (reimport) doc.imported = {};
}
