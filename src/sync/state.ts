/**
 * Per-attachment sync state, persisted as JSON in the Zotero data directory
 * (`<dataDir>/remarkable-sync/state.json`). It records which reMarkable
 * document belongs to which attachment and which Zotero annotations were
 * created from which reMarkable scene items, so syncing is idempotent and
 * never touches annotations the user made in Zotero.
 */

import type { PageBox } from "./types";

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
  /**
   * Key of the embedded-image attachment the plugin created for the drawing.
   * Only this attachment is replaced or erased; user images are left alone.
   */
  drawingKey?: string;
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
  /** Title last pushed to the tablet; a change renames the document. */
  pushedTitle?: string;
  originalPageCount: number;
  appendedPageCount: number;
  /** Original PDF page boxes (CropBox) used for coordinate mapping. */
  pageBoxes: PageBox[];
  /** Notebook page id -> paired "reMarkable Note" child note. */
  notePages?: Record<string, NotePageRecord>;
  /** Fingerprint of synced notes at the last note sync. */
  notesFingerprint?: string;
  /** reMarkable item id (page:item) -> imported Zotero object. */
  imported: Record<string, ImportedRecord>;
  /**
   * Zotero keys imported from an earlier tablet document that was replaced
   * (the PDF's page count changed). They are not erased, since their
   * reMarkable keys are gone, but they stay out of the uploaded PDF.
   */
  detachedImported?: string[];
  lastSync?: string;
  /** Message and stack of the last failed sync, for troubleshooting. */
  lastError?: string;
}

interface StateFile {
  version: 1;
  docs: Record<string, DocState>;
  /** Tablet folder id by folder name; optional, absent in older files. */
  folders?: Record<string, string>;
  /**
   * Zotero keys of imported objects whose DocState was forgotten (document
   * deleted on the tablet, removed from sync, replaced), by
   * `libraryID/attachmentKey`. Optional, absent in older files. It outlives
   * the DocState so these objects are never mistaken for the user's own and
   * burned into a re-uploaded PDF.
   */
  detached?: Record<string, string[]>;
}

function stateKey(libraryID: number, attachmentKey: string) {
  return `${libraryID}/${attachmentKey}`;
}

/**
 * Zotero keys that are not the user's own: imported from `doc`, detached
 * from an earlier tablet document that was replaced, plus `registry` (the
 * persistent registry of forgotten documents, which is how a forgotten
 * pending upload hands its keys to the re-upload). They are never burned
 * into the uploaded PDF, and they are what "remove imported" erases.
 */
export function buildDetachedList(
  doc: Pick<DocState, "imported" | "detachedImported"> | undefined,
  registry: Iterable<string> = [],
): string[] {
  const keys = new Set<string>([...(doc?.detachedImported ?? []), ...registry]);
  for (const rec of Object.values(doc?.imported ?? {})) keys.add(rec.zoteroKey);
  return [...keys];
}

/** The few file operations the store needs; injectable for Node tests. */
export interface StateFileIO {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  /** Replace the file atomically (write to a temp file, then rename). */
  writeText(path: string, text: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;
  parentDir(path: string): string;
  logError(e: unknown): void;
}

/** Default IO backed by Gecko's IOUtils/PathUtils. */
function zoteroStateIO(): StateFileIO {
  return {
    exists: (path) => IOUtils.exists(path),
    readText: (path) => IOUtils.readUTF8(path),
    writeText: async (path, text) => {
      await IOUtils.writeUTF8(path, text, { tmpPath: `${path}.tmp` });
    },
    copy: (from, to) => IOUtils.copy(from, to),
    makeDirectory: (path) =>
      IOUtils.makeDirectory(path, { ignoreExisting: true }),
    parentDir: (path) => PathUtils.parent(path)!,
    logError: (e) => Zotero.logError(e as Error),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseState(text: string): StateFile {
  const data = JSON.parse(text) as StateFile;
  if (
    !isPlainObject(data) ||
    (data.docs !== undefined && !isPlainObject(data.docs))
  )
    throw new Error("unexpected state file layout");
  normaliseState(data);
  return data;
}

/**
 * `folders` and `detached` are optional extras. A malformed value (a string,
 * an array, entries of the wrong type) is dropped rather than treated as
 * corruption, so the rest of the state is kept and later writes cannot throw.
 */
function normaliseState(data: StateFile) {
  const folders: Record<string, string> = {};
  if (isPlainObject(data.folders))
    for (const [name, id] of Object.entries(data.folders))
      if (typeof id === "string") folders[name] = id;
  data.folders = folders;

  const detached: Record<string, string[]> = {};
  if (isPlainObject(data.detached))
    for (const [id, keys] of Object.entries(data.detached))
      if (Array.isArray(keys) && keys.every((k) => typeof k === "string"))
        detached[id] = keys;
  data.detached = detached;
}

export class SyncStateStore {
  private data: StateFile = { version: 1, docs: {} };
  private loaded = false;
  private loading: Promise<void> | undefined;
  /**
   * True once this load's backup refresh happened, or when the backup must
   * not be refreshed because the main file is known bad (reset by load).
   */
  private backedUp = false;
  /** Last JSON successfully written; an identical save is skipped. */
  private lastWritten: string | undefined;
  /** True once the state directory was created (or found existing). */
  private dirReady = false;
  private readonly io: StateFileIO;

  constructor(
    private readonly path: string,
    io?: StateFileIO,
  ) {
    this.io = io ?? zoteroStateIO();
  }

  private get backupPath() {
    return `${this.path}.bak`;
  }

  private get corruptPath() {
    return `${this.path}.corrupt`;
  }

  /**
   * Load the state. A missing file means a fresh start. If the file exists
   * but cannot be read, the backup is used. The backup is a copy of the state
   * as it was at the first save after the previous load, so restoring from it
   * can lose changes made since then. If that fails too, this throws and the store stays unloaded, so no sync
   * runs and the unreadable files are never overwritten. Each call retries.
   */
  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    // Concurrent callers share one load, so a second one cannot replace
    // `data` after a sync has started mutating it.
    this.loading ??= this.doLoad().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async doLoad() {
    let data: StateFile | undefined;
    let mainStillBad = false;
    const mainExists = await this.io.exists(this.path);
    if (mainExists) {
      try {
        data = parseState(await this.io.readText(this.path));
      } catch (e) {
        this.io.logError(e);
      }
    }
    if (!data && (await this.io.exists(this.backupPath))) {
      try {
        data = parseState(await this.io.readText(this.backupPath));
      } catch (e) {
        this.io.logError(e);
        if (!mainExists) {
          throw new Error(
            `The reMarkable sync state backup (${this.backupPath}) is unreadable. ` +
              "Sync is disabled so nothing is overwritten. Fix or remove the file, then retry.",
          );
        }
      }
      if (data && mainExists) {
        // The main file was unreadable: keep a copy for inspection and
        // restore it from the backup so the next save cannot clobber the
        // good backup with the bad file. The steps are independent: a failed
        // inspection copy must not stop the restore.
        try {
          await this.io.copy(this.path, this.corruptPath);
        } catch (e) {
          this.io.logError(e);
        }
        try {
          await this.io.copy(this.backupPath, this.path);
        } catch (e) {
          this.io.logError(e);
          // The main file is still the bad one. save() must not copy it over
          // the good backup; it only replaces the main file.
          mainStillBad = true;
        }
      }
    }
    if (!data && mainExists) {
      try {
        await this.io.copy(this.path, this.corruptPath);
      } catch (e) {
        this.io.logError(e);
      }
      throw new Error(
        `The reMarkable sync state file (${this.path}) is unreadable and no usable backup exists. ` +
          `Sync is disabled so nothing is overwritten; a copy was kept as ${this.corruptPath}. ` +
          "Fix or remove the file, then retry.",
      );
    }
    this.data = data ?? { version: 1, docs: {} };
    this.data.docs ??= {};
    this.backedUp = mainStillBad;
    this.lastWritten = undefined;
    this.loaded = true;
  }

  async save() {
    if (!this.loaded) throw new Error("Sync state was not loaded; not saving.");
    // DocState objects are mutated in place, so compare the serialised text.
    // The first save after a load always writes (and refreshes the backup).
    const text = JSON.stringify(this.data);
    if (text === this.lastWritten) return;
    if (!this.dirReady) {
      await this.io.makeDirectory(this.io.parentDir(this.path));
      this.dirReady = true;
    }
    // The main file is known good here (load restores it from the backup if
    // it was not), so it becomes the backup before being replaced. Once per
    // load is enough, and avoids copying the whole file on every save.
    if (!this.backedUp && (await this.io.exists(this.path))) {
      await this.io.copy(this.path, this.backupPath);
      this.backedUp = true;
    }
    await this.io.writeText(this.path, text);
    this.lastWritten = text;
  }

  get(libraryID: number, attachmentKey: string): DocState | undefined {
    return this.data.docs[stateKey(libraryID, attachmentKey)];
  }

  set(doc: DocState) {
    this.data.docs[stateKey(doc.libraryID, doc.attachmentKey)] = doc;
  }

  /**
   * Forget a document: its imported and already detached Zotero keys move to
   * the detached registry, then the DocState is deleted. Use this wherever a
   * tracked document is dropped.
   */
  forget(libraryID: number, attachmentKey: string) {
    const doc = this.get(libraryID, attachmentKey);
    if (doc) this.addDetached(libraryID, attachmentKey, buildDetachedList(doc));
    delete this.data.docs[stateKey(libraryID, attachmentKey)];
  }

  /** Zotero keys detached from this attachment's forgotten documents. */
  getDetached(libraryID: number, attachmentKey: string): string[] {
    return this.data.detached?.[stateKey(libraryID, attachmentKey)] ?? [];
  }

  addDetached(
    libraryID: number,
    attachmentKey: string,
    keys: Iterable<string>,
  ) {
    const all = new Set(this.getDetached(libraryID, attachmentKey));
    for (const k of keys) all.add(k);
    if (!all.size) return;
    this.data.detached ??= {};
    this.data.detached[stateKey(libraryID, attachmentKey)] = [...all];
  }

  /** Drop keys from the registry, e.g. because the objects were erased. */
  removeDetached(
    libraryID: number,
    attachmentKey: string,
    keys: Iterable<string>,
  ) {
    const id = stateKey(libraryID, attachmentKey);
    const drop = new Set(keys);
    const rest = this.getDetached(libraryID, attachmentKey).filter(
      (k) => !drop.has(k),
    );
    if (rest.length) {
      this.data.detached ??= {};
      this.data.detached[id] = rest;
    } else if (this.data.detached) {
      delete this.data.detached[id];
      if (!Object.keys(this.data.detached).length) delete this.data.detached;
    }
  }

  getFolderId(name: string): string | undefined {
    return this.data.folders?.[name] || undefined;
  }

  setFolderId(name: string, id: string) {
    this.data.folders ??= {};
    this.data.folders[name] = id;
  }

  all(): DocState[] {
    return Object.values(this.data.docs);
  }
}
