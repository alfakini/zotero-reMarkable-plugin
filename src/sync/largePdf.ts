/**
 * Pure (Zotero-free) size check for PDFs that are rebuilt on Zotero's main
 * thread. pdf-lib parses and re-serialises the whole file synchronously, so a
 * large scan can freeze the UI for a while. This only warns; it never changes
 * which PDFs are synced.
 */

/** Rebuilding a PDF at least this big may briefly freeze Zotero. */
export const LARGE_PDF_BYTES = 50 * 1024 * 1024;

/** The warning shown (progress + debug log) before rebuilding a big PDF. */
export function largePdfWarning(label: string, sizeBytes: number): string {
  const mb = Math.round(sizeBytes / (1024 * 1024));
  return `${label}: rebuilding a large PDF (${mb} MB), Zotero may freeze briefly`;
}
