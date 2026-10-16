/**
 * Shared fakes for engine-level tests: stubs for the Zotero and Gecko globals
 * the engine touches, an in-memory state file, and an in-memory tablet that
 * implements the RemarkableCloud methods the engine calls. Not a test file
 * itself (the unit glob only picks up *.test.ts).
 */
import { PDFDocument } from "pdf-lib";
import type {
  ChangedDocument,
  IndexEntry,
  RemarkableCloud,
  RootInfo,
} from "../../src/remarkable/cloud";
import { SyncEngine } from "../../src/sync/engine";
import type { Mutex } from "../../src/sync/mutex";
import type { StateFileIO } from "../../src/sync/state";
import { SyncStateStore } from "../../src/sync/state";

export const STATE_PATH = "/data/remarkable-sync/state.json";

/** In-memory StateFileIO; `files` is the "disk". */
export function memoryIO(files: Map<string, string> = new Map()) {
  const io: StateFileIO & { files: Map<string, string> } = {
    files,
    exists: async (p) => files.has(p),
    readText: async (p) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`ENOENT ${p}`);
      return t;
    },
    writeText: async (p, t) => {
      files.set(p, t);
    },
    copy: async (from, to) => {
      const t = files.get(from);
      if (t === undefined) throw new Error(`ENOENT ${from}`);
      files.set(to, t);
    },
    makeDirectory: async () => {},
    parentDir: (p) => p.slice(0, p.lastIndexOf("/")),
    logError: () => {},
  };
  return io;
}

/** The state file as persisted on the fake disk. */
export function diskState(io: { files: Map<string, string> }) {
  const text = io.files.get(STATE_PATH);
  if (text === undefined) throw new Error("state was never saved");
  return JSON.parse(text) as {
    docs: Record<string, Record<string, unknown>>;
    detached?: Record<string, string[]>;
  };
}

export interface FakeZoteroItem {
  key: string;
  deleted: boolean;
  eraseTx(): Promise<void>;
  isAnnotation(): boolean;
  annotationComment: string;
  getTags(): { tag: string }[];
}

/**
 * Installs stub `Zotero` and `IOUtils` globals. Items and files are reset on
 * every call. `erased` records the keys passed to eraseTx, in order.
 */
export function installGlobals() {
  const items = new Map<string, FakeZoteroItem>();
  const files = new Map<string, Uint8Array>();
  const erased: string[] = [];
  /** Annotations passed to Zotero.Annotations.saveFromJSON, in order. */
  const saved: { key?: string; [field: string]: unknown }[] = [];
  const behavior = { failSave: false };
  let nextKey = 0;
  const g = globalThis as Record<string, unknown>;
  const addItem = (libraryID: number, key: string) => {
    items.set(`${libraryID}/${key}`, {
      key,
      deleted: false,
      isAnnotation: () => true,
      annotationComment: "",
      getTags: () => [],
      eraseTx: async () => {
        erased.push(key);
        items.delete(`${libraryID}/${key}`);
      },
    });
  };
  g.Zotero = {
    Items: {
      getByLibraryAndKey: (lib: number, key: string) =>
        items.get(`${lib}/${key}`) ?? false,
    },
    DataObjectUtilities: { generateKey: () => `GEN${++nextKey}` },
    Annotations: {
      saveFromJSON: async (
        att: { libraryID: number },
        json: { key: string },
      ) => {
        if (behavior.failSave) throw new Error("save failed");
        saved.push(json);
        addItem(att.libraryID, json.key);
        return { key: json.key };
      },
    },
    PDFWorker: {
      // No text layer: highlights keep the text the tablet gave them.
      getFullText: async () => {
        throw new Error("no full text");
      },
      renderAttachmentAnnotations: async () => {},
    },
    logError() {},
    debug() {},
  };
  g.IOUtils = {
    stat: async (path: string) => {
      const f = files.get(path);
      if (!f) throw new Error(`ENOENT ${path}`);
      return { size: f.length, lastModified: 1 };
    },
    read: async (path: string) => {
      const f = files.get(path);
      if (!f) throw new Error(`ENOENT ${path}`);
      return f;
    },
  };
  return {
    erased,
    files,
    saved,
    /** Set `failSave` to make saving an imported annotation throw. */
    behavior,
    /** A Zotero object that exists in the library. */
    addItem,
    has: (libraryID: number, key: string) => items.has(`${libraryID}/${key}`),
    /** The user deleted the object by hand (not recorded in `erased`). */
    remove: (libraryID: number, key: string) =>
      items.delete(`${libraryID}/${key}`),
  };
}

/** A real, valid PDF with `pages` blank pages. */
export async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return doc.save();
}

/** A standalone PDF attachment (no parent item) backed by `path`. */
export function fakeAttachment(opts: {
  key: string;
  path: string;
  title: { value: string };
  libraryID?: number;
}) {
  return {
    id: 1,
    key: opts.key,
    libraryID: opts.libraryID ?? 1,
    parentID: undefined,
    parentItem: undefined,
    getFilePathAsync: async () => opts.path,
    getAnnotations: () => [],
    getDisplayTitle: () => opts.title.value,
  } as unknown as Zotero.Item;
}

interface TabletDoc {
  hash: string;
  name: string;
  pdf: Uint8Array;
  pageCount: number;
  /** What the tablet holds besides the PDF: the .content JSON and .rm blobs. */
  files?: { content: unknown; rm: Map<string, Uint8Array> };
}

/**
 * In-memory tablet implementing the cloud methods SyncEngine uses. Every
 * commit gives the document a new hash, like the real index.
 */
export class FakeTablet {
  docs = new Map<string, TabletDoc>();
  /** Calls in order, e.g. "upload:<id>", "replace:<id>", "rename:<id>". */
  calls: string[] = [];
  /** Ids of the documents whose files were downloaded (one per pull). */
  pulls: string[] = [];
  private n = 0;
  /** Runs after uploadPdf committed the document, before it returns. */
  afterUploadCommit?: (id: string) => void | Promise<void>;

  private nextHash() {
    return `hash-${++this.n}`;
  }

  /**
   * The tablet changes the document's pages (a new hash, as after the user
   * wrote on it). A page listed in `content` without an entry in `rm` has no
   * .rm blob.
   */
  setFiles(id: string, content: unknown, rm: Map<string, Uint8Array>) {
    const d = this.docs.get(id);
    if (!d) throw new Error(`Document ${id} not found`);
    d.files = { content, rm };
    d.hash = this.nextHash();
  }

  count(prefix: string) {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }

  cloud(): RemarkableCloud {
    const self = this;
    const cloud = {
      clearPageCache() {},
      async getRoot(): Promise<RootInfo> {
        return { hash: "root", generation: self.n, schemaVersion: 4 };
      },
      async getRootEntries(): Promise<IndexEntry[]> {
        return [...self.docs].map(([id, d]) => ({
          hash: d.hash,
          type: "0",
          id,
          subfiles: 1,
          size: d.pdf.length,
        }));
      },
      async ensureFolder(name: string) {
        throw new Error(`unexpected folder ${name}`);
      },
      async readMetadata() {
        return undefined;
      },
      async uploadPdf(
        name: string,
        pdf: Uint8Array,
        pageCount: number,
        _parent: string,
        id: string,
      ) {
        self.calls.push(`upload:${id}`);
        const hash = self.nextHash();
        self.docs.set(id, { hash, name, pdf, pageCount });
        await self.afterUploadCommit?.(id);
        return { id, hash };
      },
      async replacePdf(
        id: string,
        pdf: Uint8Array,
        pageCount: number,
        name?: string,
      ): Promise<ChangedDocument> {
        self.calls.push(`replace:${id}`);
        const d = self.docs.get(id);
        if (!d) throw new Error(`Document ${id} not found`);
        const baseHash = d.hash;
        Object.assign(d, { pdf, pageCount, hash: self.nextHash() });
        if (name !== undefined) d.name = name;
        return { hash: d.hash, baseHash };
      },
      async renameDocument(id: string, name: string): Promise<ChangedDocument> {
        self.calls.push(`rename:${id}`);
        const d = self.docs.get(id);
        if (!d) throw new Error(`Document ${id} not found`);
        const baseHash = d.hash;
        d.name = name;
        d.hash = self.nextHash();
        return { hash: d.hash, baseHash };
      },
      async trashDocument(id: string) {
        self.calls.push(`trash:${id}`);
        self.docs.delete(id);
      },
      async getDocumentFiles(id: string) {
        const d = self.docs.get(id);
        if (!d) return undefined;
        self.pulls.push(id);
        return (
          d.files ?? {
            content: { pageCount: d.pageCount, pages: [] },
            rm: new Map<string, Uint8Array>(),
          }
        );
      },
    };
    return cloud as unknown as RemarkableCloud;
  }
}

export function makeEngine(opts: {
  cloud: RemarkableCloud;
  state: SyncStateStore;
  lock?: Mutex;
  importHandwriting?: boolean;
}) {
  return new SyncEngine(
    opts.cloud,
    opts.state,
    () => ({
      folder: "",
      appendNotesPages: false,
      importHandwriting: opts.importHandwriting ?? false,
    }),
    "author",
    opts.lock,
  );
}

export function makeState(io: StateFileIO) {
  return new SyncStateStore(STATE_PATH, io);
}
