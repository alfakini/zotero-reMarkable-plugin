/**
 * Two-way sync between Zotero child notes titled "reMarkable Note …" and
 * notebook pages appended to the document on the tablet (see notes.ts for the
 * HTML conventions). The pure pairing rules come first; `syncNotes` applies
 * them to one attachment.
 */
import {
  isTabletChangedError,
  type ChangedDocument,
  type RemarkableCloud,
} from "../remarkable/cloud";
import { addInsertedPage, deletePage, pageRefs } from "../remarkable/content";
import { uuid4 } from "../remarkable/hash";
import {
  ParagraphStyle,
  parseRm,
  type RmPage,
  type RmParagraph,
} from "../remarkable/rmscene";
import { writePageText } from "../remarkable/rmwrite";
import { drawableLines, fingerprint, renderSvg } from "./convert";
import {
  htmlToParagraphs,
  isSyncedNoteTitle,
  nextNoteTitle,
  plainText,
} from "./notes";
import type { DocState, NotePageRecord } from "./state";
import {
  childNotesWithTrashed,
  existsInLibrary,
  trashByKey,
  writeSyncedNote,
} from "./zotero";

// ------------------------------------------------------------ pairing rules --

export type PairState =
  /** The tablet page was deleted: drop the pair (and trash the note). */
  | "pageGone"
  /** The note is only in Zotero's trash: leave the pair and page untouched. */
  | "paused"
  /** The note no longer exists in the library: delete the tablet page. */
  | "noteGone"
  /** Both sides exist: sync as usual. */
  | "active";

/**
 * Decide what to do with a note/page pair. A trashed note is recoverable, so
 * it pauses the pair instead of deleting the page and its handwriting; so is
 * a note that moved to another parent item (`existsElsewhere`: it is still in
 * the library but no longer among the attachment parent's notes). Only a note
 * that is gone from the library takes its page with it.
 */
export function pairState(
  pageLive: boolean,
  noteTrashed: boolean | undefined,
  existsElsewhere = false,
): PairState {
  if (!pageLive) return "pageGone";
  if (noteTrashed === undefined) return existsElsewhere ? "paused" : "noteGone";
  return noteTrashed ? "paused" : "active";
}

export type NoteAction = "none" | "toTablet" | "toZotero" | "conflict";

/** Three-way decision against the text both sides had at the last sync. */
export function decide(
  base: string | undefined,
  zotero: string,
  tablet: string,
): NoteAction {
  if (zotero === tablet) return "none";
  if (base === undefined) return "conflict";
  if (tablet === base) return "toTablet";
  if (zotero === base) return "toZotero";
  return "conflict";
}

/**
 * Body to write to the tablet. Plain Zotero paragraphs keep the style they
 * already have on the tablet (e.g. a heading set there), matched by text.
 */
export function withTabletStyles(zotero: RmParagraph[], tablet: RmParagraph[]) {
  const styleOf = new Map(tablet.map((p) => [p.text.trim(), p.style]));
  return zotero.map((p) =>
    p.style === ParagraphStyle.PLAIN && styleOf.has(p.text.trim())
      ? { ...p, style: styleOf.get(p.text.trim())! }
      : p,
  );
}

/** Keep both versions when each side changed: Zotero's first, then the tablet's. */
export function mergeConflict(zotero: RmParagraph[], tablet: RmParagraph[]) {
  return [
    ...zotero,
    {
      style: ParagraphStyle.HEADING,
      text: "Edited on reMarkable at the same time:",
    },
    ...tablet,
  ];
}

/**
 * What to do with one existing note/page pair, and the three-way base to
 * record once each half has actually been written. A base is only true after
 * the write it describes, so it is assigned in two stages (see applyPairPlan).
 */
export interface PairPlan {
  action: NoteAction;
  /** Body to write into the Zotero note (toZotero, conflict). */
  zoteroBody?: RmParagraph[];
  /** Body to write to the tablet page (toTablet, conflict). */
  tabletBody?: RmParagraph[];
  /**
   * Base that is true once the Zotero half is done: the text the tablet still
   * holds (toZotero: it was copied over; conflict: Zotero now has the merged
   * text and the tablet is untouched, so the merged text is simply pushed on
   * retry instead of being merged again). Undefined keeps the current base.
   */
  baseAfterZotero?: string;
  /** Base that is true once the tablet half is written too. */
  baseAfterTablet: string;
}

export function planPair(
  base: string | undefined,
  zotero: RmParagraph[],
  tablet: RmParagraph[],
): PairPlan {
  const zPlain = plainText(zotero);
  const tPlain = plainText(tablet);
  const action = decide(base, zPlain, tPlain);
  switch (action) {
    case "toTablet":
      return {
        action,
        tabletBody: withTabletStyles(zotero, tablet),
        baseAfterTablet: zPlain,
      };
    case "toZotero":
      return {
        action,
        zoteroBody: tablet,
        baseAfterZotero: tPlain,
        baseAfterTablet: tPlain,
      };
    case "conflict": {
      const merged = mergeConflict(zotero, tablet);
      return {
        action,
        zoteroBody: merged,
        tabletBody: merged,
        baseAfterZotero: tPlain,
        baseAfterTablet: plainText(merged),
      };
    }
    case "none":
      return {
        action,
        baseAfterZotero: zPlain,
        baseAfterTablet: zPlain,
      };
  }
}

/**
 * Carry out a plan for one pair. `writeZotero` (if any) rewrites the note
 * and records the drawing fields itself; the record is untouched while it
 * throws. The tablet half of the base only becomes true after the single
 * tablet write (updateDocument) succeeds, so it is pushed to `afterCommit`,
 * which syncNotes runs once that write is through.
 */
export async function applyPairPlan(
  rec: NotePageRecord,
  plan: PairPlan,
  writeZotero: (() => Promise<void>) | undefined,
  afterCommit: (() => void)[],
) {
  if (writeZotero) await writeZotero();
  if (plan.baseAfterZotero !== undefined) rec.base = plan.baseAfterZotero;
  if (plan.tabletBody) {
    afterCommit.push(() => {
      rec.base = plan.baseAfterTablet;
    });
  }
}

// ---------------------------------------------------------------- the pass --

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
    ...childNotesWithTrashed(att)
      // Trashed notes only matter while paired: trashing, restoring or
      // emptying the trash for them must trigger a sync.
      .filter((n) =>
        n.deleted
          ? mapped.has(n.key)
          : mapped.has(n.key) || isSyncedNoteTitle(n.getNoteTitle()),
      )
      .map((n) => [n.key, n.deleted ? "trashed" : n.getNote()]),
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
  const pageText = (existing: Uint8Array | undefined, body: RmParagraph[]) =>
    writePageText(existing, body, { authorUuid: authorId, template });

  const allNotes = childNotesWithTrashed(att);
  const notes = allNotes.filter((n) => !n.deleted);
  const noteByKey = new Map(allNotes.map((n) => [n.key, n]));
  // Titles of the live notes by key, kept current as notes are trashed,
  // retitled or created below.
  const titleByKey = new Map(notes.map((n) => [n.key, n.getNoteTitle()]));
  const titles = () => [...titleByKey.values()];

  const tabletBody = (page?: RmPage): RmParagraph[] =>
    (page?.rootText?.paragraphs ?? []).filter((p) => p.text.trim());
  const drawingOf = (page?: RmPage) => {
    const lines = page ? drawableLines(page) : [];
    return lines.length ? renderSvg(lines) : undefined;
  };

  // Records only change after the write that makes them true: the base of a
  // pair whose page is rewritten, new pairings for created pages and removed
  // pairings are applied once updateDocument succeeds, so a failure anywhere
  // leaves state matching what both sides really hold (see applyPairPlan).
  const afterCommit: (() => void)[] = [];
  const commit = () => {
    for (const effect of afterCommit.splice(0)) effect();
  };

  // 1. Existing pairs.
  for (const [pageId, rec] of Object.entries(notePages)) {
    const note = noteByKey.get(rec.noteKey);
    // A note dragged to another parent is no longer among this item's
    // notes but still exists: pause the pair rather than delete the page.
    const state = pairState(
      livePages.has(pageId),
      note ? !!note.deleted : undefined,
      !note && existsInLibrary(att.libraryID, rec.noteKey),
    );
    if (state === "pageGone") {
      // Page deleted on the tablet -> move the note to Zotero's trash.
      if (note && !note.deleted) {
        await trashByKey(att.libraryID, rec.noteKey);
        titleByKey.delete(rec.noteKey);
      }
      delete notePages[pageId];
      result.removed++;
      continue;
    }
    if (state === "noteGone") {
      // Note gone from the library -> delete the page on the tablet.
      content = deletePage(content, pageId, authorId);
      contentChanged = true;
      afterCommit.push(() => delete notePages[pageId]);
      result.removed++;
      continue;
    }
    // Trashed or reparented note: keep the pair and the page as they are until
    // the note is restored, moved back or erased.
    if (state === "paused" || !note) continue;
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
    // Regenerate the body only when its text must change (or the title was
    // fixed); a drawing-only change swaps just the plugin's image.
    const rewriteBody = !!plan.zoteroBody || title !== parsedNote.title;
    const needsWrite = rewriteBody || drawingHash !== rec.drawingHash;
    await applyPairPlan(
      rec,
      plan,
      needsWrite
        ? async () => {
            const written = await writeSyncedNote(
              att,
              rec.noteKey,
              title,
              plan.zoteroBody ?? zotero,
              drawing,
              {
                rewriteBody,
                drawingKey: rec.drawingKey,
                adoptLegacyDrawing: rec.drawingHash !== undefined,
              },
            );
            titleByKey.set(rec.noteKey, title);
            rec.drawingHash = drawingHash;
            rec.drawingKey = written.drawingKey;
          }
        : undefined,
      afterCommit,
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
    const title = nextNoteTitle(titles());
    const written = await writeSyncedNote(
      att,
      undefined,
      title,
      body,
      drawing,
      { rewriteBody: true },
    );
    notePages[ref.id] = {
      noteKey: written.key,
      base: plainText(body),
      drawingHash: drawing ? fingerprint(drawing.markup) : undefined,
      drawingKey: written.drawingKey,
    };
    pagedNotes.add(written.key);
    titleByKey.set(written.key, title);
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
    afterCommit.push(() => {
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
      // only the response lost. The write is a single root swap, so if any of
      // the added pages exists now, all of it landed and the pairings must be
      // recorded, or the next sync would import them again as new pages.
      if (addedPageIds.length && !isTabletChangedError(e)) {
        const live = await cloud.getPageIds(doc.rmDocId).catch(() => undefined);
        if (addedPageIds.some((id) => live?.has(id))) commit();
      }
      throw e;
    }
  }
  commit();
  return result;
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
