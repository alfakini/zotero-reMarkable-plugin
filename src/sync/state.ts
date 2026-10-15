/**
 * Per-attachment sync state, persisted as JSON in the Zotero data directory
 * (`<dataDir>/remarkable-sync/state.json`). It records which reMarkable
 * document belongs to which attachment and which Zotero annotations were
 * created from which reMarkable scene items, so syncing is idempotent and
 * never touches annotations the user made in Zotero.
 */

export interface ImportedRecord {
  /** Zotero annotation or note key. */
  zoteroKey: string;
  /** Fingerprint of the reMarkable source; changes when the item changes. */
  hash: string;
  kind: "annotation" | "note";
}

export interface NotePageRecord {
  /** Key of the paired Zotero child note. */
  noteKey: string;
  /** Body text both sides had after the last sync (three-way merge base). */
  base?: string;
  /** Fingerprint of the handwriting drawing last copied into the note. */
  drawingHash?: string;
  /** Adopted from the older one-way import; base is set on first sync. */
  migrated?: boolean;
}

export interface DocState {
  attachmentKey: string;
  libraryID: number;
  rmDocId: string;
  /** Version of the import conversion used for `imported`. */
  converterVersion?: number;
  /** Hash of the reMarkable document entry when we last synced. */
  rmDocHash?: string;
  /**
   * Set when the last pull could not save every candidate. The next sync
   * pulls again (saved ones are skipped by hash) even if the tablet copy is
   * unchanged, because push may advance `rmDocHash` in between.
   */
  pullIncomplete?: boolean;
  /** Fingerprint of the Zotero annotations burned into the uploaded PDF. */
  uploadedFingerprint?: string;
  originalPageCount: number;
  appendedPageCount: number;
  /** Original PDF page boxes (CropBox) used for coordinate mapping. */
  pageBoxes: { x: number; y: number; width: number; height: number }[];
  /** Notebook page id -> paired "reMarkable Note" child note. */
  notePages?: Record<string, NotePageRecord>;
  /** Fingerprint of synced notes at the last note sync. */
  notesFingerprint?: string;
  /** reMarkable item id (page:item) -> imported Zotero object. */
  imported: Record<string, ImportedRecord>;
  lastSync?: string;
  /** Message and stack of the last failed sync, for troubleshooting. */
  lastError?: string;
}

interface StateFile {
  version: 1;
  docs: Record<string, DocState>;
}

function stateKey(libraryID: number, attachmentKey: string) {
  return `${libraryID}/${attachmentKey}`;
}

export class SyncStateStore {
  private data: StateFile = { version: 1, docs: {} };
  private loaded = false;

  constructor(private readonly path: string) {}

  async load() {
    if (this.loaded) return;
    try {
      if (await IOUtils.exists(this.path)) {
        this.data = (await IOUtils.readJSON(this.path)) as StateFile;
      }
    } catch (e) {
      Zotero.logError(e as Error);
    }
    this.data.docs ??= {};
    this.loaded = true;
  }

  async save() {
    await IOUtils.makeDirectory(PathUtils.parent(this.path)!, {
      ignoreExisting: true,
    });
    await IOUtils.writeJSON(this.path, this.data, {
      tmpPath: `${this.path}.tmp`,
    });
  }

  get(libraryID: number, attachmentKey: string): DocState | undefined {
    return this.data.docs[stateKey(libraryID, attachmentKey)];
  }

  set(doc: DocState) {
    this.data.docs[stateKey(doc.libraryID, doc.attachmentKey)] = doc;
  }

  delete(libraryID: number, attachmentKey: string) {
    delete this.data.docs[stateKey(libraryID, attachmentKey)];
  }

  all(): DocState[] {
    return Object.values(this.data.docs);
  }

  /** True if the given Zotero key was created by this plugin. */
  isImported(doc: DocState | undefined, zoteroKey: string) {
    return (
      !!doc &&
      Object.values(doc.imported).some((r) => r.zoteroKey === zoteroKey)
    );
  }
}
