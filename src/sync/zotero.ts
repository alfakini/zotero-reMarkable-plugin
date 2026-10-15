/** Zotero-side helpers: read Zotero data and write imported annotations. */
import { mergeAnnotationFields } from "./annotationMerge";
import type { AnnotationCandidate, NoteCandidate } from "./convert";
import { fitInkPosition } from "./inkFit";
import {
  drawingImg,
  eraseIfCreatedOnError,
  importSaveThenErase,
  isSyncedNoteTitle,
  legacyDrawingKey,
  type NoteDrawing,
  paragraphsToHtml,
  patchDrawing,
  staleDrawingKeys,
  wrapNoteHtml,
} from "./notes";
import type { RmParagraph } from "../remarkable/rmscene";
import { skipKeys } from "./detached";
import type { DocState } from "./state";
import type { ZAnnotation, ZNote } from "./types";

export const IMPORT_TAG = "reMarkable";
const AUTHOR = "reMarkable";

/** PDF attachments for a mix of regular items and attachments. */
export async function pdfAttachments(
  items: Zotero.Item[],
): Promise<Zotero.Item[]> {
  const out = new Map<number, Zotero.Item>();
  for (const item of items) {
    if (item.isPDFAttachment?.()) out.set(item.id, item);
    else if (item.isRegularItem()) {
      for (const id of item.getAttachments()) {
        const att = (Zotero.Items.get(id) as Zotero.Item | false) || undefined;
        if (att?.isPDFAttachment()) out.set(att.id, att);
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
  const skip = skipKeys(doc, detached);
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
  const skip = skipKeys(doc, detached);
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

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
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

export async function saveAnnotation(
  attachment: Zotero.Item,
  c: AnnotationCandidate,
  key?: string,
): Promise<string> {
  let position = c.json.position;
  if (c.json.type === "ink") {
    const fitted = fitInkPosition(c.json.position as any);
    position = fitted.position as any;
    if (fitted.droppedPaths)
      Zotero.debug(
        `[reMarkable] ink ${c.rmKey} too large: dropped ${fitted.droppedPaths} stroke(s)`,
      );
  }
  // An update keeps what the user edited in Zotero (comment, tags).
  const found = key
    ? (Zotero.Items.getByLibraryAndKey(attachment.libraryID, key) as
        | Zotero.Item
        | false)
    : false;
  const existing =
    found !== false && found.isAnnotation()
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

/**
 * A failed cleanup can leave an orphan note or image that later passes act on,
 * so surface it in the Zotero error log instead of swallowing it.
 */
function logCleanupError(err: unknown) {
  Zotero.logError(err as Error);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Create or update a child note holding handwriting (SVG) and typed text. */
export async function saveNote(
  attachment: Zotero.Item,
  c: NoteCandidate,
  existingKey?: string,
): Promise<string> {
  // A note cannot be a child of an attachment; callers skip these candidates.
  const parentID = attachment.parentID;
  if (!parentID)
    throw new Error("cannot create a note under a standalone attachment");
  let note = existingKey
    ? (Zotero.Items.getByLibraryAndKey(attachment.libraryID, existingKey) as
        | Zotero.Item
        | false)
    : false;
  let created = false;
  if (!note) {
    note = new Zotero.Item("note");
    note.libraryID = attachment.libraryID;
    note.parentID = parentID;
    note.setNote(wrapNoteHtml(`<h1>${escapeHtml(c.title)}</h1>`));
    await note.saveTx();
    created = true;
  }
  const saved = note;
  // A half-built note we just created is not recorded in the state, so remove
  // it; otherwise the retry on the next sync would duplicate it.
  await eraseIfCreatedOnError(
    created,
    () => saved.eraseTx(),
    async () => {
      // Drawings the plugin put in the previous version of this note (SVGs the
      // note embeds; images of any other kind are left alone). They are erased
      // only after the new version is saved.
      const svgs = svgAttachments(saved);
      const stale = staleDrawingKeys(
        saved.getNote(),
        svgs.map((a) => a.key),
      );
      await importSaveThenErase<Zotero.Item>({
        importImage: async () =>
          c.svg ? await importSvg(saved, c.svg.markup) : undefined,
        save: async (img) => {
          let body = `<h1>${escapeHtml(c.title)}</h1>`;
          if (c.svg && img) {
            body += `<p>${drawingImg({ key: img.key, width: c.svg.width, height: c.svg.height })}</p>`;
          }
          if (c.text) {
            body += c.text
              .split(/\n{2,}/)
              .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
              .join("");
          }
          saved.setNote(wrapNoteHtml(body));
          saved.addTag(IMPORT_TAG);
          await saved.saveTx();
        },
        eraseImage: (img) => img.eraseTx(),
        eraseOld: async () => {
          for (const img of svgs) {
            if (stale.includes(img.key)) await img.eraseTx();
          }
        },
        onCleanupError: logCleanupError,
      });
    },
    logCleanupError,
  );
  return saved.key;
}

export async function eraseByKey(libraryID: number, key: string) {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, key) as
    | Zotero.Item
    | false;
  if (item) await item.eraseTx();
}

export function existsByKey(libraryID: number, key: string) {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, key) as
    | Zotero.Item
    | false;
  return !!item && !item.deleted;
}

/** Child notes of the attachment's parent item, including trashed ones. */
export function childNotesWithTrashed(attachment: Zotero.Item): Zotero.Item[] {
  const parent = attachment.parentItem;
  if (!parent) return [];
  return Zotero.Items.get(parent.getNotes(true));
}

/** Whether an item with this key still exists in the library (any parent). */
export function existsInLibrary(libraryID: number, key: string): boolean {
  return !!Zotero.Items.getByLibraryAndKey(libraryID, key);
}

/** Move an item to Zotero's trash (recoverable). */
export async function trashByKey(libraryID: number, key: string) {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, key) as
    | Zotero.Item
    | false;
  if (item && !item.deleted) {
    item.deleted = true;
    await item.saveTx();
  }
}

/** Store SVG markup as an embedded image attachment of the note. */
function importSvg(note: Zotero.Item, markup: string) {
  return Zotero.Attachments.importEmbeddedImage({
    blob: new Blob([markup], { type: "image/svg+xml" }),
    parentItemID: note.id,
  });
}

/** Embedded SVG attachments of a note (the plugin only ever makes SVGs). */
function svgAttachments(note: Zotero.Item): Zotero.Item[] {
  return (Zotero.Items.get(note.getAttachments()) as Zotero.Item[]).filter(
    (a) => a.attachmentContentType === "image/svg+xml",
  );
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
export async function writeSyncedNote(
  attachment: Zotero.Item,
  key: string | undefined,
  title: string,
  body: RmParagraph[],
  drawing: { markup: string; width: number; height: number } | undefined,
  opts: SyncedNoteOptions,
): Promise<{ key: string; drawingKey?: string }> {
  const parentID = attachment.parentID;
  if (!parentID) throw new Error("Notes need a parent item");
  let note = key
    ? (Zotero.Items.getByLibraryAndKey(attachment.libraryID, key) as
        | Zotero.Item
        | false)
    : false;
  let rewriteBody = opts.rewriteBody;
  let created = false;
  if (!note) {
    note = new Zotero.Item("note");
    note.libraryID = attachment.libraryID;
    note.parentID = parentID;
    note.setNote(paragraphsToHtml(title, body));
    note.addTag(IMPORT_TAG);
    await note.saveTx();
    created = true;
    rewriteBody = true;
  }
  const saved = note;
  // A note created here is not in the state yet, so any failure below would
  // leave an orphan that the next sync duplicates (and pushes as a blank page).
  return eraseIfCreatedOnError(
    created,
    () => saved.eraseTx(),
    async () => {
      // Only a key the plugin recorded may be erased. A legacy record only
      // tells us which img to replace; its attachment stays where it is.
      const oldKey = opts.drawingKey;
      const patchKey =
        oldKey ??
        (opts.adoptLegacyDrawing
          ? legacyDrawingKey(
              saved.getNote(),
              svgAttachments(saved).map((a) => a.key),
            )
          : undefined);
      let image: NoteDrawing | undefined;
      await importSaveThenErase<Zotero.Item>({
        importImage: async () =>
          drawing ? await importSvg(saved, drawing.markup) : undefined,
        save: async (img) => {
          image =
            drawing && img
              ? { key: img.key, width: drawing.width, height: drawing.height }
              : undefined;
          saved.setNote(
            rewriteBody
              ? paragraphsToHtml(title, body, image)
              : patchDrawing(saved.getNote(), patchKey, image),
          );
          await saved.saveTx();
        },
        // The new image is not referenced by anything yet.
        eraseImage: (img) => img.eraseTx(),
        // The previous drawing is unreferenced now; erase just that attachment.
        eraseOld: async () => {
          if (oldKey && oldKey !== image?.key) {
            const old = svgAttachments(saved).find((a) => a.key === oldKey);
            if (old) await old.eraseTx();
          }
        },
        onCleanupError: logCleanupError,
      });
      return { key: saved.key, drawingKey: image?.key };
    },
    logCleanupError,
  );
}
