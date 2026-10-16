/** Zotero-side helpers: read Zotero data, write imported annotations and notes. */
import type { RmParagraph } from "../remarkable/rmscene";
import type { AnnotationCandidate, NoteCandidate } from "./convert";
import { fitInkPosition } from "./inkFit";
import {
  decodeEntities,
  drawingImg,
  escapeHtml,
  isSyncedNoteTitle,
  legacyDrawingKey,
  type NoteDrawing,
  paragraphsToHtml,
  patchDrawing,
  staleDrawingKeys,
  wrapNoteHtml,
} from "./notes";
import { buildDetachedList, type DocState } from "./state";
import type { ZAnnotation, ZNote, ZPosition } from "./types";

/** Tag on imported annotations and notes. Must differ from the default `syncTag` pref, which users apply to mark items for sync. */
export const IMPORT_TAG = "reMarkable import";
const AUTHOR = "reMarkable";

/** The item with this key, if it exists (Zotero returns `false` otherwise). */
function itemByKey(libraryID: number, key: string): Zotero.Item | undefined {
  return (
    (Zotero.Items.getByLibraryAndKey(libraryID, key) as Zotero.Item | false) ||
    undefined
  );
}

/** PDF attachments for a mix of regular items and attachments. */
export function pdfAttachments(items: Zotero.Item[]): Zotero.Item[] {
  const out = new Map<number, Zotero.Item>();
  for (const item of items) {
    if (item.isPDFAttachment()) out.set(item.id, item);
    else if (item.isRegularItem()) {
      for (const att of Zotero.Items.get(item.getAttachments())) {
        if (att.isPDFAttachment()) out.set(att.id, att);
      }
    }
  }
  return [...out.values()];
}

/** Title shown on the tablet, e.g. "Liang et al. 2023 - Code as policies". */
export function remarkableTitle(attachment: Zotero.Item): string {
  const parent = attachment.parentItem;
  if (!parent) return attachment.getDisplayTitle().replace(/\.pdf$/i, "");
  const creator = parent.getField("firstCreator") as string;
  const year = (parent.getField("date", true, true) as string).slice(0, 4);
  const title =
    (parent.getField("shortTitle") as string) ||
    (parent.getField("title") as string);
  const head = [creator, year && year !== "0000" ? year : ""]
    .filter(Boolean)
    .join(" ");
  const name = head ? `${head} - ${title}` : title;
  return name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
}

/** Zotero-made annotations (excludes those imported from the tablet). */
export function zoteroAnnotations(
  attachment: Zotero.Item,
  doc?: DocState,
  /** Keys detached from forgotten documents (SyncStateStore.getDetached). */
  detached: Iterable<string> = [],
): ZAnnotation[] {
  const skip = new Set(buildDetachedList(doc, detached));
  return attachment
    .getAnnotations()
    .filter((a) => !skip.has(a.key))
    .map((a) => {
      let position: ZAnnotation["position"];
      try {
        position = JSON.parse(a.annotationPosition);
      } catch {
        return undefined;
      }
      return {
        key: a.key,
        type: a.annotationType as ZAnnotation["type"],
        text: a.annotationText ?? "",
        comment: a.annotationComment ?? "",
        color: a.annotationColor || "#ffd400",
        pageLabel: a.annotationPageLabel,
        sortIndex: a.annotationSortIndex,
        position,
        tags: a.getTags().map((t) => t.tag),
      } as ZAnnotation;
    })
    .filter(
      (a): a is ZAnnotation => !!a && typeof a.position?.pageIndex === "number",
    );
}

/** Child notes of the parent item (excluding notes this plugin created). */
export function zoteroNotes(
  attachment: Zotero.Item,
  doc?: DocState,
  /** Keys detached from forgotten documents (SyncStateStore.getDetached). */
  detached: Iterable<string> = [],
): ZNote[] {
  const parent = attachment.parentItem;
  if (!parent) return [];
  const skip = new Set(buildDetachedList(doc, detached));
  for (const rec of Object.values(doc?.notePages ?? {})) skip.add(rec.noteKey);
  return (
    Zotero.Items.get(parent.getNotes())
      // Notes with their own page on the tablet are not repeated in the PDF.
      .filter((n) => !skip.has(n.key) && !isSyncedNoteTitle(n.getNoteTitle()))
      .map((n) => ({
        key: n.key,
        title: n.getNoteTitle(),
        text: htmlToText(n.getNote()),
      }))
      .filter((n) => n.text.trim())
  );
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Page labels already known from existing annotations (pageIndex -> label). */
export function knownPageLabels(attachment: Zotero.Item): string[] {
  const labels: string[] = [];
  for (const a of attachment.getAnnotations()) {
    try {
      const idx = JSON.parse(a.annotationPosition).pageIndex;
      if (a.annotationPageLabel && labels[idx] === undefined)
        labels[idx] = a.annotationPageLabel;
    } catch {
      // ignore
    }
  }
  return labels;
}

/**
 * Fields of a re-imported annotation. The tablet owns geometry, text, colour,
 * sort index and page label; the comment and tags are the user's to edit in
 * Zotero, so an update keeps them. The exception is a note annotation: its
 * comment is the text typed on the tablet, so the tablet wins there.
 */
export function mergeAnnotationFields(
  candidate: { type: "highlight" | "ink" | "note"; comment?: string },
  importTag: string,
  existing?: { comment: string; tags: { tag: string; type?: number }[] },
): { comment: string; tags: { name: string; type?: number }[] } {
  const tags: { name: string; type?: number }[] = [];
  const seen = new Set<string>();
  for (const t of existing?.tags ?? []) {
    if (seen.has(t.tag)) continue;
    seen.add(t.tag);
    tags.push(t.type ? { name: t.tag, type: t.type } : { name: t.tag });
  }
  if (!seen.has(importTag)) tags.push({ name: importTag });
  const comment =
    !existing || candidate.type === "note"
      ? (candidate.comment ?? "")
      : existing.comment;
  return { comment, tags };
}

export async function saveAnnotation(
  attachment: Zotero.Item,
  c: AnnotationCandidate,
  key?: string,
): Promise<string> {
  let position: ZPosition = c.json.position;
  if (c.json.type === "ink" && position.paths) {
    const fitted = fitInkPosition({ ...position, paths: position.paths });
    position = fitted.position;
    if (fitted.droppedPaths)
      Zotero.debug(
        `[reMarkable] ink ${c.rmKey} too large: dropped ${fitted.droppedPaths} stroke(s)`,
      );
  }
  const found = key ? itemByKey(attachment.libraryID, key) : undefined;
  const existing = found?.isAnnotation()
    ? {
        comment: found.annotationComment ?? "",
        tags: found.getTags() as { tag: string; type?: number }[],
      }
    : undefined;
  const merged = mergeAnnotationFields(c.json, IMPORT_TAG, existing);
  const json: any = {
    key: key ?? (Zotero as any).DataObjectUtilities.generateKey(),
    type: c.json.type,
    color: c.json.color,
    pageLabel: c.json.pageLabel,
    sortIndex: c.json.sortIndex,
    position,
    comment: merged.comment,
    authorName: AUTHOR,
    tags: merged.tags,
  };
  if (c.json.type === "highlight") json.text = c.json.text ?? "";
  const item = await Zotero.Annotations.saveFromJSON(attachment, json);
  return item.key;
}

export async function eraseByKey(libraryID: number, key: string) {
  await itemByKey(libraryID, key)?.eraseTx();
}

export function existsByKey(libraryID: number, key: string) {
  const item = itemByKey(libraryID, key);
  return !!item && !item.deleted;
}

/** Whether an item with this key still exists in the library (any parent). */
export function existsInLibrary(libraryID: number, key: string): boolean {
  return !!itemByKey(libraryID, key);
}

/** Move an item to Zotero's trash (recoverable). */
export async function trashByKey(libraryID: number, key: string) {
  const item = itemByKey(libraryID, key);
  if (item && !item.deleted) {
    item.deleted = true;
    await item.saveTx();
  }
}

/** Child notes of the attachment's parent item, including trashed ones. */
export function childNotesWithTrashed(attachment: Zotero.Item): Zotero.Item[] {
  const parent = attachment.parentItem;
  if (!parent) return [];
  return Zotero.Items.get(parent.getNotes(true));
}

/** Embedded SVG attachments of a note (the plugin only ever makes SVGs). */
function svgAttachments(note: Zotero.Item): Zotero.Item[] {
  return (Zotero.Items.get(note.getAttachments()) as Zotero.Item[]).filter(
    (a) => a.attachmentContentType === "image/svg+xml",
  );
}

/** Best-effort erase during error cleanup: logged, never thrown, so the original error is the one reported. */
async function eraseQuietly(item: Zotero.Item | undefined) {
  try {
    await item?.eraseTx();
  } catch (e) {
    Zotero.logError(e as Error);
  }
}

/**
 * Create or update a child note of the attachment's parent, with an optional
 * SVG drawing embedded as an image attachment. `html` renders the new body
 * from the imported drawing (if any), the current body (undefined for a new
 * note) and the keys of the note's SVG attachments; `stale` names, from the
 * same inputs, the plugin's old drawings to erase once the new body is saved.
 * The destructive steps come last: when the save fails, the new image and a
 * note created by this call are erased again (the note is not in the state
 * yet, so the next sync would otherwise duplicate it) and the error rethrown.
 * The import tag goes on every note this call creates; `tagExisting` also adds
 * it when an existing note is updated. A paired note may be one the user wrote,
 * so only notes the plugin imported (saveNote) may be tagged on update.
 */
async function writeNote(
  attachment: Zotero.Item,
  key: string | undefined,
  drawing: { markup: string; width: number; height: number } | undefined,
  html: (
    img: NoteDrawing | undefined,
    current: string | undefined,
    svgKeys: string[],
  ) => string,
  stale: (current: string, svgKeys: string[], img?: NoteDrawing) => string[],
  tagExisting: boolean,
): Promise<{ key: string; drawingKey?: string }> {
  const parentID = attachment.parentID;
  if (!parentID) throw new Error("Notes need a parent item");
  let note = key ? itemByKey(attachment.libraryID, key) : undefined;
  let current: string | undefined;
  let svgKeys: string[] = [];
  if (note) {
    current = note.getNote();
    svgKeys = svgAttachments(note).map((a) => a.key);
  } else {
    // Saved before the drawing is imported: the image needs a parent item.
    note = new Zotero.Item("note");
    note.libraryID = attachment.libraryID;
    note.parentID = parentID;
    note.setNote(html(undefined, undefined, []));
    await note.saveTx();
  }
  let image: Zotero.Item | undefined;
  let img: NoteDrawing | undefined;
  try {
    if (drawing) {
      image = await Zotero.Attachments.importEmbeddedImage({
        blob: new Blob([drawing.markup], { type: "image/svg+xml" }),
        parentItemID: note.id,
      });
      img = { key: image.key, width: drawing.width, height: drawing.height };
    }
    note.setNote(html(img, current, svgKeys));
    if (current === undefined || tagExisting) note.addTag(IMPORT_TAG);
    await note.saveTx();
  } catch (e) {
    await eraseQuietly(image);
    if (current === undefined) await eraseQuietly(note);
    throw e;
  }
  if (current !== undefined) {
    const svgs = svgAttachments(note);
    for (const k of stale(current, svgKeys, img)) {
      await svgs.find((a) => a.key === k)?.eraseTx();
    }
  }
  return { key: note.key, drawingKey: img?.key };
}

/** Create or update a child note holding handwriting (SVG) and typed text imported from a tablet page. */
export async function saveNote(
  attachment: Zotero.Item,
  c: NoteCandidate,
  existingKey?: string,
): Promise<string> {
  const written = await writeNote(
    attachment,
    existingKey,
    c.svg,
    (img) => {
      let body = `<h1>${escapeHtml(c.title)}</h1>`;
      if (img) body += `<p>${drawingImg(img)}</p>`;
      if (c.text) {
        body += c.text
          .split(/\n{2,}/)
          .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
          .join("");
      }
      return wrapNoteHtml(body);
    },
    // Drawings the previous version of this note embedded (SVGs only; images
    // of any other kind are left alone).
    (current, svgKeys) => staleDrawingKeys(current, svgKeys),
    true,
  );
  return written.key;
}

export interface SyncedNoteOptions {
  /**
   * Regenerate the whole body from `body`. Only for text that really has to
   * change; otherwise just the drawing is swapped and the rest is kept.
   */
  rewriteBody: boolean;
  /** Attachment key of the drawing the plugin created last time. */
  drawingKey?: string;
  /**
   * Records from before `drawingKey` existed: replace the img of the note's
   * single embedded SVG attachment with the new drawing. That attachment is
   * left in place (it may be user content); only `drawingKey` is erased.
   */
  adoptLegacyDrawing?: boolean;
}

/**
 * Create or rewrite a note paired with a tablet page: title, body, and the
 * page's handwriting as an embedded SVG drawing. Only the plugin's own drawing
 * attachment is erased, and the body is regenerated only when asked to.
 */
export function writeSyncedNote(
  attachment: Zotero.Item,
  key: string | undefined,
  title: string,
  body: RmParagraph[],
  drawing: { markup: string; width: number; height: number } | undefined,
  opts: SyncedNoteOptions,
): Promise<{ key: string; drawingKey?: string }> {
  return writeNote(
    attachment,
    key,
    drawing,
    (img, current, svgKeys) => {
      if (current === undefined || opts.rewriteBody) {
        return paragraphsToHtml(title, body, img);
      }
      // Only a key the plugin recorded may be erased. A legacy record only
      // tells us which img to replace; its attachment stays where it is.
      const patchKey =
        opts.drawingKey ??
        (opts.adoptLegacyDrawing
          ? legacyDrawingKey(current, svgKeys)
          : undefined);
      return patchDrawing(current, patchKey, img);
    },
    // The previous drawing is unreferenced now; erase just that attachment.
    (_current, svgKeys, img) =>
      opts.drawingKey &&
      opts.drawingKey !== img?.key &&
      svgKeys.includes(opts.drawingKey)
        ? [opts.drawingKey]
        : [],
    // The paired note may be the user's own: tag it only when created here.
    false,
  );
}
