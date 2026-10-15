/** Zotero-side helpers: read Zotero data and write imported annotations. */
import type { AnnotationCandidate, NoteCandidate } from "./convert";
import { isSyncedNoteTitle, paragraphsToHtml } from "./notes";
import type { RmParagraph } from "../remarkable/rmscene";
import type { DocState } from "./state";
import type { ZAnnotation, ZNote } from "./types";

export const IMPORT_TAG = "reMarkable";
const AUTHOR = "reMarkable";
const POSITION_MAX = 65000;

/** PDF attachments for a mix of regular items and attachments. */
export async function pdfAttachments(
  items: Zotero.Item[],
): Promise<Zotero.Item[]> {
  const out = new Map<number, Zotero.Item>();
  for (const item of items) {
    if (item.isPDFAttachment?.()) out.set(item.id, item);
    else if (item.isRegularItem()) {
      for (const id of item.getAttachments()) {
        const att = Zotero.Items.get(id) as Zotero.Item | false;
        if (att && att.isPDFAttachment()) out.set(att.id, att);
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

function importedKeys(doc?: DocState) {
  return new Set(Object.values(doc?.imported ?? {}).map((r) => r.zoteroKey));
}

/** Zotero-made annotations (excludes those imported from the tablet). */
export function zoteroAnnotations(
  attachment: Zotero.Item,
  doc?: DocState,
): ZAnnotation[] {
  const skip = importedKeys(doc);
  return attachment
    .getAnnotations()
    .filter((a) => !skip.has(a.key))
    .map((a) => {
      let position;
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
export function zoteroNotes(attachment: Zotero.Item, doc?: DocState): ZNote[] {
  const parent = attachment.parentItem;
  if (!parent) return [];
  const skip = importedKeys(doc);
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

/** Thin out ink paths until the position fits Zotero's size limit. */
function fitPosition(position: any) {
  let pos = position;
  let step = 2;
  while (JSON.stringify(pos).length > POSITION_MAX && step < 64) {
    pos = {
      ...pos,
      paths: (position.paths as number[][]).map((p) => {
        const out: number[] = [];
        for (let i = 0; i < p.length; i += 2 * step) out.push(p[i], p[i + 1]);
        out.push(p[p.length - 2], p[p.length - 1]);
        return out;
      }),
    };
    step *= 2;
  }
  return pos;
}

export async function saveAnnotation(
  attachment: Zotero.Item,
  c: AnnotationCandidate,
  key?: string,
): Promise<string> {
  const json: any = {
    key: key ?? (Zotero as any).DataObjectUtilities.generateKey(),
    type: c.json.type,
    color: c.json.color,
    pageLabel: c.json.pageLabel,
    sortIndex: c.json.sortIndex,
    position:
      c.json.type === "ink" ? fitPosition(c.json.position) : c.json.position,
    comment: c.json.comment ?? "",
    authorName: AUTHOR,
    tags: [{ name: IMPORT_TAG }],
  };
  if (c.json.type === "highlight") json.text = c.json.text ?? "";
  const item = await Zotero.Annotations.saveFromJSON(attachment, json);
  return item.key;
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
  const parentID = attachment.parentID ?? attachment.id;
  let note = existingKey
    ? (Zotero.Items.getByLibraryAndKey(attachment.libraryID, existingKey) as
        | Zotero.Item
        | false)
    : false;
  if (!note) {
    note = new Zotero.Item("note");
    note.libraryID = attachment.libraryID;
    note.parentID = parentID;
    note.setNote(
      `<div data-schema-version="9"><h1>${escapeHtml(c.title)}</h1></div>`,
    );
    await note.saveTx();
  } else {
    // Drop images from the previous version of this note.
    for (const id of note.getAttachments()) {
      const img = Zotero.Items.get(id) as Zotero.Item | false;
      if (img) await img.eraseTx();
    }
  }
  let body = `<h1>${escapeHtml(c.title)}</h1>`;
  if (c.svg) {
    const img = await Zotero.Attachments.importEmbeddedImage({
      blob: new Blob([c.svg.markup], { type: "image/svg+xml" }),
      parentItemID: note.id,
    });
    body += `<p><img data-attachment-key="${img.key}" width="${c.svg.width}" height="${c.svg.height}"/></p>`;
  }
  if (c.text) {
    body += c.text
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
      .join("");
  }
  note.setNote(`<div data-schema-version="9">${body}</div>`);
  note.addTag(IMPORT_TAG);
  await note.saveTx();
  return note.key;
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

/** Live (not trashed) child notes of the attachment's parent item. */
export function childNotes(attachment: Zotero.Item): Zotero.Item[] {
  const parent = attachment.parentItem;
  if (!parent) return [];
  return Zotero.Items.get(parent.getNotes()).filter((n) => !n.deleted);
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

/**
 * Create or rewrite a note paired with a tablet page: title, body, and the
 * page's handwriting as an embedded SVG drawing.
 */
export async function writeSyncedNote(
  attachment: Zotero.Item,
  key: string | undefined,
  title: string,
  body: RmParagraph[],
  drawing?: { markup: string; width: number; height: number },
): Promise<string> {
  const parentID = attachment.parentID;
  if (!parentID) throw new Error("Notes need a parent item");
  let note = key
    ? (Zotero.Items.getByLibraryAndKey(attachment.libraryID, key) as
        | Zotero.Item
        | false)
    : false;
  if (!note) {
    note = new Zotero.Item("note");
    note.libraryID = attachment.libraryID;
    note.parentID = parentID;
    note.setNote(paragraphsToHtml(title, body));
    note.addTag(IMPORT_TAG);
    await note.saveTx();
  }
  // Replace the previous drawing, if any.
  for (const id of note.getAttachments()) {
    const img = Zotero.Items.get(id) as Zotero.Item | false;
    if (img) await img.eraseTx();
  }
  let image: { key: string; width: number; height: number } | undefined;
  if (drawing) {
    const img = await Zotero.Attachments.importEmbeddedImage({
      blob: new Blob([drawing.markup], { type: "image/svg+xml" }),
      parentItemID: note.id,
    });
    image = { key: img.key, width: drawing.width, height: drawing.height };
  }
  note.setNote(paragraphsToHtml(title, body, image));
  await note.saveTx();
  return note.key;
}
