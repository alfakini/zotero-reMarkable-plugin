/**
 * Pure (Zotero-free) merge of an imported annotation's tablet data with what
 * the user may have changed on it in Zotero, unit-testable in Node.
 *
 * When a tablet annotation is re-imported (its geometry or the converter
 * changed), the tablet still owns geometry, text, color, sort index and page
 * label. The comment and tags are the user's to edit in Zotero, so an update
 * keeps them. The exception is a note annotation: its comment is the text
 * typed on the tablet, so the tablet wins there.
 */

export interface ExistingAnnotation {
  comment: string;
  tags: { tag: string; type?: number }[];
}

export interface MergedAnnotationFields {
  comment: string;
  tags: { name: string; type?: number }[];
}

export function mergeAnnotationFields(
  candidate: { type: "highlight" | "ink" | "note"; comment?: string },
  importTag: string,
  existing?: ExistingAnnotation,
): MergedAnnotationFields {
  const fromTablet = candidate.comment ?? "";
  const tags: { name: string; type?: number }[] = [];
  const seen = new Set<string>();
  for (const t of existing?.tags ?? []) {
    if (seen.has(t.tag)) continue;
    seen.add(t.tag);
    tags.push(t.type ? { name: t.tag, type: t.type } : { name: t.tag });
  }
  if (!seen.has(importTag)) tags.push({ name: importTag });
  const comment =
    !existing || candidate.type === "note" ? fromTablet : existing.comment;
  return { comment, tags };
}
