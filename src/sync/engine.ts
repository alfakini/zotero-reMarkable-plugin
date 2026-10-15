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
  type RemarkableCloud,
  RemarkableError,
  type IndexEntry,
} from "../remarkable/cloud";
import { pageRefs } from "../remarkable/content";
import { parseRm } from "../remarkable/rmscene";
import {
  CONVERTER_VERSION,
  convertPages,
  fingerprint,
  respace,
} from "./convert";
import {
  migrateImportedPageNotes,
  notesFingerprint,
  syncNotes,
} from "./noteSync";
import { buildRemarkablePdf } from "./pdfExport";
import { keysToErase, readPages } from "./pullPlan";
import type { SyncStateStore, DocState } from "./state";
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

export class SyncEngine {
  private running?: Promise<SyncReport>;

  constructor(
    private cloud: RemarkableCloud,
    private state: SyncStateStore,
    private settings: () => SyncSettings,
    /** Stable uuid of this installation (CRDT author on the tablet). */
    private authorId: string,
  ) {}

  get busy() {
    return !!this.running;
  }

  /** Runs one sync at a time; overlapping calls wait for the current one. */
  async sync(
    attachments: Zotero.Item[],
    progress: Progress = () => {},
  ): Promise<SyncReport> {
    while (this.running) await this.running.catch(() => {});
    this.running = this.doSync(attachments, progress);
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
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
          // Deleted on the tablet: forget it; it is re-uploaded below.
          this.state.delete(att.libraryID, att.key);
          doc = undefined;
        }
        // Must run before pull(), which would otherwise erase notes that
        // older versions imported one-way from notebook pages.
        if (doc && att.parentID) migrateImportedPageNotes(doc);
        const tabletChanged =
          !!doc &&
          !!entry &&
          (doc.rmDocHash !== entry.hash ||
            doc.converterVersion !== CONVERTER_VERSION);
        if (doc && entry && tabletChanged) {
          await this.pull(att, doc, entry, report);
        }
        folderId ??= this.settings().folder
          ? await this.cloud.ensureFolder(this.settings().folder)
          : "";
        await this.push(att, doc, folderId, report);
        doc = this.state.get(att.libraryID, att.key);
        if (doc && att.parentID) {
          const notesPrint = notesFingerprint(att, doc);
          if (tabletChanged || notesPrint !== doc.notesFingerprint) {
            const r = await syncNotes(this.cloud, att, doc, this.authorId);
            report.notes += r.toTablet + r.toZotero + r.created + r.removed;
            if (r.newHash) doc.rmDocHash = r.newHash;
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
        report.errors.push(`${label}: ${err?.message ?? String(e)}`);
        const failed = this.state.get(att.libraryID, att.key);
        if (failed) {
          failed.lastError = `${new Date().toISOString()} ${err?.message ?? e}\n${err?.stack ?? ""}`;
          this.state.set(failed);
        }
        if (e instanceof RemarkableError && e.status === 401) break;
      } finally {
        await this.state.save();
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
  ) {
    const path = await att.getFilePathAsync();
    if (!path) throw new Error("PDF file is missing");
    const annotations = zoteroAnnotations(att, doc);
    const notes = this.settings().appendNotesPages ? zoteroNotes(att, doc) : [];
    const stat = await IOUtils.stat(path);
    const print = fingerprint({
      annotations,
      notes,
      size: stat.size,
      mtime: stat.lastModified,
      appendNotesPages: this.settings().appendNotesPages,
    });
    if (doc && doc.uploadedFingerprint === print) return;

    // Copy into this realm: typed arrays from privileged APIs fail
    // `instanceof Uint8Array` checks inside the plugin sandbox (pdf-lib).
    const pdf = new Uint8Array(await IOUtils.read(path));
    const built = await buildRemarkablePdf(pdf, annotations, notes, {
      appendNotesPages: this.settings().appendNotesPages,
      title: remarkableTitle(att),
    });
    const pageCount = built.originalPageCount + built.appendedPageCount;
    if (doc && doc.originalPageCount === built.originalPageCount) {
      await this.cloud.replacePdf(doc.rmDocId, built.bytes, pageCount);
      report.updated++;
    } else {
      if (doc) await this.cloud.trashDocument(doc.rmDocId);
      const rmDocId = await this.cloud.uploadPdf(
        remarkableTitle(att),
        built.bytes,
        pageCount,
        folderId,
      );
      doc = {
        attachmentKey: att.key,
        libraryID: att.libraryID,
        rmDocId,
        originalPageCount: built.originalPageCount,
        appendedPageCount: built.appendedPageCount,
        pageBoxes: built.pageBoxes,
        imported: {},
      };
      report.uploaded++;
    }
    doc.appendedPageCount = built.appendedPageCount;
    doc.pageBoxes = built.pageBoxes;
    doc.uploadedFingerprint = print;
    doc.lastError = undefined;
    doc.rmDocHash = (await this.cloud.findDocument(doc.rmDocId))?.hash;
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
    // Pages whose .rm exists but fails to parse: their imported objects must
    // not be erased. A page without an .rm blob is empty (the files come from
    // the document index), so its imported objects are erased.
    const { pages, unreadable } = readPages(
      pageRefs(files.content),
      files.rm,
      parseRm,
      (ref, e) =>
        Zotero.debug(
          `[reMarkable] skipping page ${ref.id}: ${(e as Error).message}`,
        ),
    );
    let candidates = convertPages({
      pages,
      originalPageCount: doc.originalPageCount,
      pageBoxes: doc.pageBoxes,
      pageLabels: knownPageLabels(att),
      // Notebook pages pair with notes (noteSync) when the item can hold notes.
      skipInsertedPages: !!att.parentID,
    });
    // Restore word spacing in highlighted text from Zotero's text extraction.
    if (candidates.some((c) => c.kind === "annotation" && c.json.text)) {
      const pageTexts = await pageTextsOf(att);
      for (const c of candidates) {
        if (c.kind === "annotation" && c.json.text) {
          c.json.text = respace(
            c.json.text,
            pageTexts[c.json.position.pageIndex],
          );
        }
      }
    }
    const importHandwriting = this.settings().importHandwriting;
    if (!importHandwriting) {
      candidates = candidates.filter(
        (c) => c.kind === "annotation" && c.json.type !== "ink",
      );
    }

    const seen = new Set<string>();
    let savedImages = false;
    for (const c of candidates) {
      seen.add(c.rmKey);
      const rec = doc.imported[c.rmKey];
      if (rec) {
        // Unchanged, or deleted by the user in Zotero: leave it alone.
        if (rec.hash === c.hash || !existsByKey(att.libraryID, rec.zoteroKey))
          continue;
      }
      const key =
        c.kind === "annotation"
          ? await saveAnnotation(att, c, rec?.zoteroKey)
          : await saveNote(att, c, rec?.zoteroKey);
      doc.imported[c.rmKey] = { zoteroKey: key, hash: c.hash, kind: c.kind };
      if (c.kind === "annotation" && c.json.type === "ink") savedImages = true;
      report.imported++;
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
    doc.rmDocHash = entry.hash;
    doc.converterVersion = CONVERTER_VERSION;
    doc.lastSync = new Date().toISOString();
    this.state.set(doc);
  }

  /** Delete the document from the tablet (to trash) and forget it. */
  async remove(att: Zotero.Item) {
    await this.state.load();
    const doc = this.state.get(att.libraryID, att.key);
    if (!doc) return false;
    await this.cloud.trashDocument(doc.rmDocId);
    this.state.delete(att.libraryID, att.key);
    await this.state.save();
    return true;
  }

  /**
   * Delete every Zotero object imported from the tablet for these items.
   * With `reimport`, they are pulled again on the next sync; otherwise they
   * stay deleted (like deleting them by hand).
   */
  async removeImported(atts: Zotero.Item[], reimport = false) {
    await this.state.load();
    let n = 0;
    for (const att of atts) {
      const doc = this.state.get(att.libraryID, att.key);
      if (!doc) continue;
      for (const rec of Object.values(doc.imported)) {
        if (existsByKey(att.libraryID, rec.zoteroKey)) n++;
        await eraseByKey(att.libraryID, rec.zoteroKey);
      }
      if (reimport) {
        doc.imported = {};
        doc.rmDocHash = undefined;
      }
      this.state.set(doc);
    }
    await this.state.save();
    return n;
  }
}

async function pageTextsOf(att: Zotero.Item): Promise<string[]> {
  try {
    const res = await Zotero.PDFWorker.getFullText(att.id, null, true);
    return (res?.text ?? "").split("\f");
  } catch (e) {
    Zotero.debug(`[reMarkable] full text unavailable: ${(e as Error).message}`);
    return [];
  }
}
