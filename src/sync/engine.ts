/**
 * Sync orchestration. A sync of one attachment is:
 *   1. pull: if the tablet copy changed, turn its annotations into Zotero
 *      annotations / notes (only objects this plugin created are ever
 *      updated or deleted);
 *   2. push: if the Zotero annotations or notes changed since the last
 *      upload, rebuild the PDF and replace it on the tablet, keeping the
 *      tablet's own annotations in place;
 *   3. notes: two-way sync of "reMarkable Note …" notes with their pages.
 */
import {
  type ChangedDocument,
  type IndexEntry,
  isTopLevelFolder,
  type RemarkableCloud,
  RemarkableError,
} from "../remarkable/cloud";
import { pageRefs, type RmPageRef } from "../remarkable/content";
import { uuid4 } from "../remarkable/hash";
import { parseRm, type RmPage } from "../remarkable/rmscene";
import {
  type AnnotationCandidate,
  buildPageIndex,
  type Candidate,
  CONVERTER_VERSION,
  convertPages,
  fingerprint,
  type PageIndex,
  respaceWith,
  splitPageTexts,
} from "./convert";
import { Mutex } from "./mutex";
import {
  migrateImportedPageNotes,
  notesFingerprint,
  syncNotes,
} from "./noteSync";
import { buildRemarkablePdf } from "./pdfExport";
import {
  buildDetachedList,
  type DocState,
  type ImportedRecord,
  type SyncStateStore,
} from "./state";
import {
  eraseByKey,
  existsByKey,
  knownPageLabels,
  remarkableTitle,
  saveAnnotation,
  saveNote,
  zoteroAnnotations,
  zoteroNotes,
} from "./zotero";

export interface SyncSettings {
  folder: string;
  appendNotesPages: boolean;
  importHandwriting: boolean;
}

export interface SyncReport {
  uploaded: number;
  updated: number;
  imported: number;
  removed: number;
  /** Notes pushed to / pulled from / created as tablet note pages. */
  notes: number;
  errors: string[];
}

export type Progress = (text: string, fraction?: number) => void;

/**
 * pdf-lib parses and re-serialises the whole file synchronously on Zotero's
 * main thread, so rebuilding a PDF at least this big may briefly freeze the
 * UI. This only warns; it never changes which PDFs are synced.
 */
const LARGE_PDF_BYTES = 50 * 1024 * 1024;

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

export class SyncEngine {
  constructor(
    private cloud: RemarkableCloud,
    private state: SyncStateStore,
    private settings: () => SyncSettings,
    /** Stable uuid of this installation (CRDT author on the tablet). */
    private authorId: string,
    /**
     * Serialises sync, remove and removeImported (one at a time). Share one
     * instance between engines that use the same state store, so replacing
     * the engine (connect/disconnect) cannot overlap a running operation.
     */
    private lock: Mutex = new Mutex(),
  ) {}

  get busy() {
    return this.lock.locked;
  }

  /** Runs one sync at a time; overlapping calls wait for the current one. */
  sync(
    attachments: Zotero.Item[],
    progress: Progress = () => {},
  ): Promise<SyncReport> {
    return this.lock.run(async () => {
      try {
        return await this.doSync(attachments, progress);
      } finally {
        // Page blobs only help within one sync; don't keep them resident.
        this.cloud.clearPageCache();
      }
    });
  }

  /** Attachments that are tracked in the sync state. */
  async trackedAttachments(): Promise<Zotero.Item[]> {
    await this.state.load();
    const out: Zotero.Item[] = [];
    for (const doc of this.state.all()) {
      const item = Zotero.Items.getByLibraryAndKey(
        doc.libraryID,
        doc.attachmentKey,
      );
      if (item && !item.deleted) out.push(item as Zotero.Item);
    }
    return out;
  }

  private async doSync(attachments: Zotero.Item[], progress: Progress) {
    await this.state.load();
    const report: SyncReport = {
      uploaded: 0,
      updated: 0,
      imported: 0,
      removed: 0,
      notes: 0,
      errors: [],
    };
    if (!attachments.length) return report;
    progress("Reading reMarkable library…", 0);
    const root = await this.cloud.getRoot();
    const rootEntries = new Map(
      (await this.cloud.getRootEntries(root)).map((e) => [e.id, e] as const),
    );
    let folderId: string | undefined;
    for (const [i, att] of attachments.entries()) {
      const label = remarkableTitle(att);
      progress(label, i / attachments.length);
      try {
        let doc = this.state.get(att.libraryID, att.key);
        const entry = doc ? rootEntries.get(doc.rmDocId) : undefined;
        if (doc && !entry) {
          // Deleted on the tablet, or an upload recorded in push() whose
          // commit never happened: forget it; it is re-uploaded below. The
          // imported objects stay in Zotero: forget() moves their keys into
          // the persistent registry right here, so they stay out of the
          // re-uploaded PDF even if push() fails before recording the new
          // document, and push() reads them back from the registry.
          this.state.forget(att.libraryID, att.key);
          doc = undefined;
        }
        // Must run before pull(), which would otherwise erase notes that
        // older versions imported one-way from notebook pages.
        if (doc && att.parentID) migrateImportedPageNotes(doc);
        const tabletChanged =
          !!doc && !!entry && needsPull(doc, entry.hash, CONVERTER_VERSION);
        if (doc && entry && tabletChanged) {
          await this.pull(att, doc, entry, report);
        }
        folderId ??= await resolveFolderId(
          this.cloud,
          this.state,
          this.settings().folder,
          rootEntries,
        );
        await this.push(
          att,
          doc,
          folderId,
          report,
          progress,
          i / attachments.length,
        );
        doc = this.state.get(att.libraryID, att.key);
        if (doc && att.parentID) {
          const notesPrint = notesFingerprint(att, doc);
          if (tabletChanged || notesPrint !== doc.notesFingerprint) {
            const r = await syncNotes(this.cloud, att, doc, this.authorId);
            report.notes += r.toTablet + r.toZotero + r.created + r.removed;
            if (r.changed) {
              doc.rmDocHash = nextRmDocHash(doc.rmDocHash, r.changed);
            }
            doc.notesFingerprint = notesFingerprint(att, doc);
            this.state.set(doc);
          }
        }
      } catch (e) {
        const err = e as Error;
        Zotero.logError(err);
        Zotero.debug(
          `[reMarkable] sync failed for ${label}: ${err}\n${err?.stack}`,
        );
        report.errors.push(`${label}: ${errorMessage(e)}`);
        const failed = this.state.get(att.libraryID, att.key);
        if (failed) {
          failed.lastError = `${new Date().toISOString()} ${errorMessage(e)}\n${err?.stack ?? ""}`;
          this.state.set(failed);
        }
        if (e instanceof RemarkableError && e.status === 401) break;
      } finally {
        await this.state.save();
        // Page blobs only help within one attachment; release them now.
        this.cloud.clearPageCache();
      }
    }
    progress("Done", 1);
    return report;
  }

  private async push(
    att: Zotero.Item,
    doc: DocState | undefined,
    folderId: string,
    report: SyncReport,
    progress: Progress,
    fraction: number,
  ) {
    const path = await att.getFilePathAsync();
    if (!path) throw new Error("PDF file is missing");
    const detached = this.state.getDetached(att.libraryID, att.key);
    const annotations = zoteroAnnotations(att, doc, detached);
    const notes = this.settings().appendNotesPages
      ? zoteroNotes(att, doc, detached)
      : [];
    const stat = await IOUtils.stat(path);
    const print = fingerprint({
      annotations,
      notes,
      size: stat.size,
      mtime: stat.lastModified,
      appendNotesPages: this.settings().appendNotesPages,
    });
    const title = remarkableTitle(att);
    if (doc && doc.uploadedFingerprint === print) {
      // Nothing to rebuild, but a renamed item must still reach the tablet.
      // Without a recorded title (synced before it was tracked) only record
      // it; the tablet name is not overwritten.
      const rename = titleToPush(doc.pushedTitle, title);
      if (rename !== undefined) {
        const renamed = await this.cloud.renameDocument(doc.rmDocId, rename);
        doc.rmDocHash = nextRmDocHash(doc.rmDocHash, renamed);
      }
      if (doc.pushedTitle !== title) {
        doc.pushedTitle = title;
        this.state.set(doc);
      }
      return;
    }

    if (stat.size !== undefined && stat.size >= LARGE_PDF_BYTES) {
      const mb = Math.round(stat.size / (1024 * 1024));
      const warning = `${title}: rebuilding a large PDF (${mb} MB), Zotero may freeze briefly`;
      // Keep the caller's fraction so the progress bar does not reset.
      progress(warning, fraction);
      Zotero.debug(`[reMarkable] ${warning}`);
    }

    // Copy into this realm: typed arrays from privileged APIs fail
    // `instanceof Uint8Array` checks inside the plugin sandbox (pdf-lib).
    const pdf = new Uint8Array(await IOUtils.read(path));
    const built = await buildRemarkablePdf(pdf, annotations, notes, {
      appendNotesPages: this.settings().appendNotesPages,
      title,
    });
    const pageCount = built.originalPageCount + built.appendedPageCount;
    if (doc && doc.originalPageCount === built.originalPageCount) {
      const replaced = await this.cloud.replacePdf(
        doc.rmDocId,
        built.bytes,
        pageCount,
        titleToPush(doc.pushedTitle, title),
      );
      // Only advance the recorded hash when the tablet did not change the
      // document since we last pulled it; otherwise the next sync pulls first.
      doc.rmDocHash = nextRmDocHash(doc.rmDocHash, replaced);
      report.updated++;
    } else {
      // A different page count means a new tablet document. What was imported
      // from the old one stays in Zotero but is detached from tracking, so it
      // is neither erased by a pull nor burned into the new PDF.
      const detachedImported = buildDetachedList(doc, detached);
      if (doc) {
        await this.cloud.trashDocument(doc.rmDocId);
        Zotero.debug(
          `[reMarkable] PDF page count changed for ${att.key} ` +
            `(${doc.originalPageCount} -> ${built.originalPageCount}): ` +
            `uploading a new document, detaching ${detachedImported.length} imported object(s)`,
        );
      }
      // Record the id before the commit. The root PUT is never retried, so if
      // the server applies it but the response is lost, the next sync either
      // finds no entry (forgets it and uploads again) or adopts the entry; its
      // missing fingerprint then makes push replace the PDF.
      const rmDocId = uuid4();
      doc = {
        attachmentKey: att.key,
        libraryID: att.libraryID,
        rmDocId,
        originalPageCount: built.originalPageCount,
        appendedPageCount: built.appendedPageCount,
        pageBoxes: built.pageBoxes,
        detachedImported: detachedImported.length
          ? detachedImported
          : undefined,
        // Nothing is imported yet, so start at the current converter version;
        // otherwise the next sync would see a version mismatch (needsPull)
        // and download every page for nothing.
        converterVersion: CONVERTER_VERSION,
        imported: {},
      };
      this.state.set(doc);
      await this.state.save();
      const uploaded = await this.cloud.uploadPdf(
        title,
        built.bytes,
        pageCount,
        folderId,
        rmDocId,
      );
      report.uploaded++;
      doc.rmDocHash = uploaded.hash;
    }
    doc.appendedPageCount = built.appendedPageCount;
    doc.pageBoxes = built.pageBoxes;
    doc.uploadedFingerprint = print;
    doc.pushedTitle = title;
    doc.lastError = undefined;
    doc.lastSync = new Date().toISOString();
    this.state.set(doc);
  }

  private async pull(
    att: Zotero.Item,
    doc: DocState,
    entry: IndexEntry,
    report: SyncReport,
  ) {
    const files = await this.cloud.getDocumentFiles(doc.rmDocId, entry);
    if (!files) return;
    // The page list comes from the document index: a page without an .rm
    // blob is empty, so its imported objects are erased below. A blob that
    // exists but fails to parse is unreadable and keeps them.
    const pages: { ref: RmPageRef; page: RmPage }[] = [];
    const unreadable = new Set<string>();
    for (const ref of pageRefs(files.content)) {
      const data = files.rm.get(ref.id);
      if (!data) continue;
      try {
        pages.push({ ref, page: parseRm(data) });
      } catch (e) {
        unreadable.add(ref.id);
        Zotero.debug(
          `[reMarkable] skipping page ${ref.id}: ${errorMessage(e)}`,
        );
      }
    }
    let candidates = convertPages({
      pages,
      originalPageCount: doc.originalPageCount,
      pageBoxes: doc.pageBoxes,
      pageLabels: knownPageLabels(att),
      // Notebook pages pair with notes (noteSync) when the item can hold notes.
      skipInsertedPages: !!att.parentID,
    });
    await respaceHighlights(att, candidates);
    const importHandwriting = this.settings().importHandwriting;
    if (!importHandwriting) {
      candidates = candidates.filter(
        (c) => c.kind === "annotation" && c.json.type !== "ink",
      );
    }

    const seen = new Set<string>();
    let savedImages = false;
    // Each candidate is saved in isolation: one that cannot be saved is
    // recorded and retried on the next sync without blocking the others.
    const failures: string[] = [];
    for (const c of candidates) {
      // Always "seen", so a skipped or failed one never erases an old import.
      seen.add(c.rmKey);
      if (c.kind === "note" && !att.parentID) {
        // Child notes need a regular parent item.
        Zotero.debug(
          `[reMarkable] skipping note ${c.rmKey}: standalone attachment has no parent item`,
        );
        continue;
      }
      const rec = doc.imported[c.rmKey];
      // Leave it alone when unchanged since the current converter imported it
      // (the candidate hash covers only the raw conversion, so a record from
      // an older converter is re-imported once), or when the user deleted it.
      if (
        rec &&
        ((rec.hash === c.hash && doc.converterVersion === CONVERTER_VERSION) ||
          !existsByKey(att.libraryID, rec.zoteroKey))
      )
        continue;
      try {
        const key =
          c.kind === "annotation"
            ? await saveAnnotation(att, c, rec?.zoteroKey)
            : await saveNote(att, c, rec?.zoteroKey);
        doc.imported[c.rmKey] = { zoteroKey: key, hash: c.hash, kind: c.kind };
        if (c.kind === "annotation" && c.json.type === "ink")
          savedImages = true;
        report.imported++;
      } catch (e) {
        Zotero.debug(
          `[reMarkable] could not import ${c.rmKey}: ${e}\n${(e as Error)?.stack}`,
        );
        failures.push(`${c.rmKey}: ${errorMessage(e)}`);
        // The document moves to the current converter version below. An
        // empty hash matches no candidate, so the failed re-import is retried
        // instead of looking current again.
        if (rec) doc.imported[c.rmKey] = { ...rec, hash: "" };
      }
    }
    if (failures.length) {
      report.errors.push(
        `${remarkableTitle(att)}: ${formatFailures(failures, candidates.length)}`,
      );
    }
    // Erased on the tablet -> remove what we imported from it.
    for (const rmKey of keysToErase(
      doc.imported,
      seen,
      unreadable,
      importHandwriting,
    )) {
      const rec = doc.imported[rmKey];
      await eraseByKey(att.libraryID, rec.zoteroKey);
      delete doc.imported[rmKey];
      report.removed++;
    }
    // Render preview images for new/changed ink now. Zotero's annotation list
    // renders missing previews itself, and the "modified" notification that
    // fires mid-render makes it show the annotation twice.
    if (savedImages) {
      try {
        await Zotero.PDFWorker.renderAttachmentAnnotations(att.id);
      } catch (e) {
        Zotero.debug(`[reMarkable] preview render failed: ${e}`);
      }
    }
    // Unsaved candidates are retried on the next sync (see needsPull); the
    // saved ones are skipped by hash, so only the failed ones are redone.
    doc.pullIncomplete = failures.length > 0 || undefined;
    doc.rmDocHash = entry.hash;
    doc.converterVersion = CONVERTER_VERSION;
    doc.lastSync = new Date().toISOString();
    this.state.set(doc);
  }

  /** Delete the document from the tablet (to trash) and forget it. */
  remove(att: Zotero.Item): Promise<boolean> {
    return this.lock.run(() => this.doRemove(att));
  }

  private async doRemove(att: Zotero.Item) {
    await this.state.load();
    const doc = this.state.get(att.libraryID, att.key);
    if (!doc) return false;
    await this.cloud.trashDocument(doc.rmDocId);
    // What was imported stays in Zotero and must not be taken for the user's
    // own work if the item is synced again.
    this.state.forget(att.libraryID, att.key);
    await this.state.save();
    return true;
  }

  /**
   * Delete every Zotero object imported from the tablet for these items.
   * With `reimport`, they are pulled again on the next sync; otherwise they
   * stay deleted (like deleting them by hand).
   */
  removeImported(atts: Zotero.Item[], reimport = false): Promise<number> {
    return this.lock.run(() => this.doRemoveImported(atts, reimport));
  }

  private async doRemoveImported(atts: Zotero.Item[], reimport: boolean) {
    await this.state.load();
    let n = 0;
    for (const att of atts) {
      const doc = this.state.get(att.libraryID, att.key);
      const registry = this.state.getDetached(att.libraryID, att.key);
      // Only what the plugin created: imported, detached from a replaced
      // document, or detached from a forgotten one.
      const keys = buildDetachedList(doc, registry);
      for (const key of keys) {
        if (existsByKey(att.libraryID, key)) n++;
        await eraseByKey(att.libraryID, key);
      }
      this.state.removeDetached(att.libraryID, att.key, keys);
      if (doc) {
        doc.detachedImported = undefined;
        // Without `reimport` the records stay, so the erased objects are not
        // pulled again (like deleting them by hand).
        if (reimport) {
          doc.imported = {};
          doc.rmDocHash = undefined;
        }
        this.state.set(doc);
      }
    }
    await this.state.save();
    return n;
  }
}

/**
 * Restore word spacing in highlighted text: the tablet copies it straight
 * from the PDF text layer, which often lacks spaces ("Whenprovided"), so the
 * same characters are looked up in Zotero's spaced extraction of the page.
 */
async function respaceHighlights(att: Zotero.Item, candidates: Candidate[]) {
  const highlights = candidates.filter(
    (c): c is AnnotationCandidate => c.kind === "annotation" && !!c.json.text,
  );
  if (!highlights.length) return;
  let pageTexts: string[];
  try {
    const res = await Zotero.PDFWorker.getFullText(att.id, null, true);
    pageTexts = splitPageTexts(res?.text, res?.totalPages);
  } catch (e) {
    Zotero.debug(`[reMarkable] full text unavailable: ${errorMessage(e)}`);
    return;
  }
  // Built lazily and shared by all highlights on the same page.
  const indexes = new Map<number, PageIndex>();
  for (const c of highlights) {
    const pageIndex = c.json.position.pageIndex;
    const pageText = pageTexts[pageIndex];
    let index = indexes.get(pageIndex);
    if (!index && pageText) {
      index = buildPageIndex(pageText);
      indexes.set(pageIndex, index);
    }
    c.json.text = respaceWith(c.json.text ?? "", pageText, index);
  }
}

/** One report line for the candidates that could not be saved; lists at most three. */
export function formatFailures(failures: string[], total: number): string {
  const shown = failures.slice(0, 3).join("; ");
  const more = failures.length > 3 ? `; and ${failures.length - 3} more` : "";
  return `could not import ${failures.length} of ${total} items (${shown}${more}); will retry on the next sync`;
}

/**
 * Whether the tablet copy must be pulled: it changed, the converter changed,
 * or the previous pull left candidates unsaved.
 */
export function needsPull(
  doc: Pick<DocState, "rmDocHash" | "converterVersion" | "pullIncomplete">,
  entryHash: string,
  converterVersion: number,
): boolean {
  return (
    doc.rmDocHash !== entryHash ||
    doc.converterVersion !== converterVersion ||
    !!doc.pullIncomplete
  );
}

/**
 * Previously imported records that this pull must erase: only those whose
 * source is genuinely gone from the tablet. Records are kept when
 * - the candidate with that rmKey was seen in this pull,
 * - their page could not be read (its .rm exists but fails to parse), since
 *   the candidates missing from it say nothing about the content, or
 * - handwriting import is off, which filters ink (rmKey `<page>/i/…`) and
 *   notes out of the candidates, so their absence is not an erase.
 */
export function keysToErase(
  imported: Record<string, Pick<ImportedRecord, "kind">>,
  seen: ReadonlySet<string>,
  unreadablePageIds: ReadonlySet<string>,
  importHandwriting: boolean,
): string[] {
  const out: string[] = [];
  for (const [rmKey, rec] of Object.entries(imported)) {
    const [pageId, kind] = rmKey.split("/");
    if (seen.has(rmKey) || unreadablePageIds.has(pageId)) continue;
    if (!importHandwriting && (rec.kind === "note" || kind === "i")) continue;
    out.push(rmKey);
  }
  return out;
}

/**
 * The `rmDocHash` to record after we changed the tablet document. `known` is
 * the hash we last pulled or recorded; `changed.baseHash` is the document
 * entry our change was merged onto and `changed.hash` the result. Only when
 * the base is what we knew has the tablet not changed in between, so the new
 * hash is safe to record. Otherwise (or when nothing is known) undefined makes
 * the next sync pull first instead of skipping tablet changes that were never
 * imported.
 */
export function nextRmDocHash(
  known: string | undefined,
  changed: ChangedDocument,
): string | undefined {
  return known !== undefined && known === changed.baseHash
    ? changed.hash
    : undefined;
}

/**
 * The title to write to the tablet document, or undefined to leave its name
 * alone. A rename is only pushed when the Zotero title changed since the
 * last push, so a rename done on the tablet survives PDF rebuilds. Documents
 * synced before `pushedTitle` was recorded have none: the caller records the
 * current title without renaming.
 */
export function titleToPush(
  pushedTitle: string | undefined,
  title: string,
): string | undefined {
  return pushedTitle !== undefined && pushedTitle !== title ? title : undefined;
}

/**
 * The id of the top-level tablet folder `name` (empty name: the root, which
 * needs no folder). Finding a folder by name needs every document's metadata,
 * so the id found last time is cached in the sync state. The root index only
 * proves that the entry exists: a folder trashed, moved or renamed on the
 * tablet stays in it, so the cached folder's own metadata (one cheap read) is
 * checked too before falling back to `ensureFolder`.
 */
export async function resolveFolderId(
  cloud: Pick<RemarkableCloud, "ensureFolder" | "readMetadata">,
  state: Pick<SyncStateStore, "getFolderId" | "setFolderId">,
  name: string,
  rootEntries: ReadonlyMap<string, IndexEntry>,
): Promise<string> {
  if (!name) return "";
  const cached = state.getFolderId(name);
  const entry = cached === undefined ? undefined : rootEntries.get(cached);
  if (entry && isTopLevelFolder(await cloud.readMetadata(entry), name)) {
    return entry.id;
  }
  const id = await cloud.ensureFolder(name);
  state.setFolderId(name, id);
  return id;
}
