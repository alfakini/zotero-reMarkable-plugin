/**
 * Pairs Zotero child notes titled "reMarkable Note …" with notebook pages
 * appended to the document on the tablet, and keeps their text in sync
 * both ways (see notes.ts for the conventions).
 */
import { addInsertedPage, deletePage, pageRefs } from "../remarkable/content";
import {
  isTabletChangedError,
  type ChangedDocument,
  type RemarkableCloud,
} from "../remarkable/cloud";
import { uuid4 } from "../remarkable/hash";
import {
  isEraser,
  parseRm,
  type RmPage,
  type RmParagraph,
} from "../remarkable/rmscene";
import { writePageText } from "../remarkable/rmwrite";
import { fingerprint, renderSvg } from "./convert";
import {
  htmlToParagraphs,
  isSyncedNoteTitle,
  applyPairPlan,
  landedPages,
  nextNoteTitle,
  plainText,
  planPair,
  TabletCommits,
} from "./notes";
import type { DocState } from "./state";
import { childNotes, trashByKey, writeSyncedNote } from "./zotero";

export interface NoteSyncResult {
  toTablet: number;
  toZotero: number;
  created: number;
  removed: number;
  /** Set if the tablet copy was changed. */
  changed?: ChangedDocument;
}

/** Bump to make every paired note re-sync once (e.g. after a rules fix). */
const NOTE_SYNC_VERSION = 2;

/** Cheap check for Zotero-side changes to notes that take part in sync. */
export function notesFingerprint(att: Zotero.Item, doc: DocState) {
  const mapped = new Set(
    Object.values(doc.notePages ?? {}).map((p) => p.noteKey),
  );
  return fingerprint([
    NOTE_SYNC_VERSION,
    ...childNotes(att)
      .filter((n) => mapped.has(n.key) || isSyncedNoteTitle(n.getNoteTitle()))
      .map((n) => [n.key, n.getNote()]),
  ]);
}

export async function syncNotes(
  cloud: RemarkableCloud,
  att: Zotero.Item,
  doc: DocState,
  authorId: string,
): Promise<NoteSyncResult> {
  const result: NoteSyncResult = {
    toTablet: 0,
    toZotero: 0,
    created: 0,
    removed: 0,
  };
  const files = await cloud.getDocumentFiles(doc.rmDocId);
  if (!files) return result;
  const notePages = migrateImportedPageNotes(doc);

  let content = files.content;
  let contentChanged = false;
  const writes = new Map<string, Uint8Array>();
  const refs = pageRefs(content);
  const livePages = new Set(refs.map((r) => r.id));
  const inserted = refs.filter((r) => r.pdfIndex === undefined);
  const parsed = new Map<string, RmPage>();
  const pageOf = (id: string) => {
    if (!parsed.has(id)) {
      const data = files.rm.get(id);
      try {
        if (data) parsed.set(id, parseRm(data));
      } catch (e) {
        Zotero.debug(`[reMarkable] note page ${id} unreadable: ${e}`);
      }
    }
    return parsed.get(id);
  };
  // A device-written page to model new pages on (scene info, text geometry).
  const template =
    inserted.map((r) => files.rm.get(r.id)).find(Boolean) ??
    [...files.rm.values()][0];

  const notes = childNotes(att);
  const noteByKey = new Map(notes.map((n) => [n.key, n]));
  const titles = () => childNotes(att).map((n) => n.getNoteTitle());

  const tabletBody = (page?: RmPage): RmParagraph[] =>
    (page?.rootText?.paragraphs ?? []).filter((p) => p.text.trim());
  const drawingOf = (page?: RmPage) => {
    const lines = (page?.lines ?? []).filter(
      (l) => !isEraser(l.tool) && l.points.length,
    );
    return lines.length ? renderSvg(lines) : undefined;
  };

  // Records only change after the write that makes them true: the base of a
  // pair whose page is rewritten, new pairings for created pages and removed
  // pairings are applied once updateDocument succeeds, so a failure anywhere
  // leaves state matching what both sides really hold (see applyPairPlan).
  const tabletCommits = new TabletCommits();

  // 1. Existing pairs.
  for (const [pageId, rec] of Object.entries(notePages)) {
    const note = noteByKey.get(rec.noteKey);
    if (!livePages.has(pageId)) {
      // Page deleted on the tablet -> move the note to Zotero's trash.
      if (note) await trashByKey(att.libraryID, rec.noteKey);
      delete notePages[pageId];
      result.removed++;
      continue;
    }
    if (!note) {
      // Note deleted in Zotero -> delete the page on the tablet.
      content = deletePage(content, pageId, authorId);
      contentChanged = true;
      tabletCommits.defer(() => delete notePages[pageId]);
      result.removed++;
      continue;
    }
    const page = pageOf(pageId);
    const tablet = tabletBody(page);
    const parsedNote = htmlToParagraphs(note.getNote());
    let title = parsedNote.title;
    if (!isSyncedNoteTitle(title)) title = nextNoteTitle(titles());
    const zotero = parsedNote.body;
    const tPlain = plainText(tablet);
    if (rec.base === undefined && rec.migrated) rec.base = tPlain;
    const drawing = drawingOf(page);
    const drawingHash = drawing ? fingerprint(drawing.markup) : undefined;

    const plan = planPair(rec.base, zotero, tablet);
    if (plan.tabletBody) {
      writes.set(pageId, pageText(files.rm.get(pageId), plan.tabletBody));
      result.toTablet++;
    }
    if (plan.zoteroBody) result.toZotero++;
    const needsWrite =
      !!plan.zoteroBody ||
      drawingHash !== rec.drawingHash ||
      title !== parsedNote.title;
    await applyPairPlan(
      rec,
      plan,
      needsWrite
        ? async () => {
            await writeSyncedNote(
              att,
              rec.noteKey,
              title,
              plan.zoteroBody ?? zotero,
              drawing,
            );
            rec.drawingHash = drawingHash;
          }
        : undefined,
      tabletCommits,
    );
  }

  // 2. Pages added on the tablet -> new notes.
  const pagedNotes = new Set(Object.values(notePages).map((r) => r.noteKey));
  for (const ref of inserted) {
    if (notePages[ref.id]) continue;
    const page = pageOf(ref.id);
    const body = tabletBody(page);
    const drawing = drawingOf(page);
    if (!body.length && !drawing) continue; // still blank
    const key = await writeSyncedNote(
      att,
      undefined,
      nextNoteTitle(titles()),
      body,
      drawing,
    );
    notePages[ref.id] = {
      noteKey: key,
      base: plainText(body),
      drawingHash: drawing ? fingerprint(drawing.markup) : undefined,
    };
    pagedNotes.add(key);
    result.created++;
  }

  // 3. "reMarkable Note …" notes made in Zotero -> new pages.
  const addedPageIds: string[] = [];
  for (const note of notes) {
    if (pagedNotes.has(note.key) || !isSyncedNoteTitle(note.getNoteTitle()))
      continue;
    const { body } = htmlToParagraphs(note.getNote());
    const pageId = uuid4();
    content = addInsertedPage(content, pageId, authorId);
    contentChanged = true;
    writes.set(pageId, pageText(undefined, body));
    addedPageIds.push(pageId);
    // Paired only once the page exists on the tablet.
    tabletCommits.defer(() => {
      notePages[pageId] = { noteKey: note.key, base: plainText(body) };
    });
    result.created++;
  }

  if (writes.size || contentChanged) {
    try {
      result.changed = await cloud.updateDocument(
        doc.rmDocId,
        {
          pages: writes,
          content: contentChanged ? content : undefined,
        },
        { expectedHash: files.hash },
      );
    } catch (e) {
      // The root PUT is never retried: the server may have applied it with
      // only the response lost. Record the pairings if the new pages exist,
      // or the next sync would import them again and create more pages.
      if (addedPageIds.length && !isTabletChangedError(e)) {
        const live = await cloud.getPageIds(doc.rmDocId).catch(() => undefined);
        if (landedPages(addedPageIds, live).length) tabletCommits.commit();
      }
      throw e;
    }
  }
  tabletCommits.commit();
  return result;

  function pageText(existing: Uint8Array | undefined, body: RmParagraph[]) {
    return writePageText(existing, body, { authorUuid: authorId, template });
  }
}

/**
 * Before two-way note sync, tablet notebook pages were imported one-way as
 * notes keyed `<pageId>/page`. Adopt those notes as synced pairs.
 */
export function migrateImportedPageNotes(doc: DocState) {
  doc.notePages ??= {};
  const notePages = doc.notePages;
  for (const [rmKey, rec] of Object.entries(doc.imported)) {
    const m = /^([^/]+)\/page$/.exec(rmKey);
    if (!m || rec.kind !== "note") continue;
    notePages[m[1]] ??= { noteKey: rec.zoteroKey, migrated: true };
    delete doc.imported[rmKey];
  }
  return notePages;
}
