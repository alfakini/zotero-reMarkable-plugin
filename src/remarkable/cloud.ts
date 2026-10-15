/**
 * Minimal client for the reMarkable cloud "sync v3/v4" protocol.
 *
 * Model: every file is a content-addressed blob (sha256). A document is an
 * index blob (`<id>.docSchema`) listing its files; the root index lists every
 * document index. Changing anything means uploading new blobs, a new document
 * index, a new root index, and finally compare-and-swapping the root pointer.
 */
import { buildPdfContent, pageRefs, reconcileContent } from "./content";
import { crc32cHeader, sha256Hex, uuid4 } from "./hash";

export const AUTH_HOST = "https://webapp-prod.cloud.remarkable.engineering";
export const SYNC_HOST = "https://internal.cloud.remarkable.com";
export const CONNECT_URL = "https://my.remarkable.com/device/browser/connect";

export type FetchFn = typeof fetch;

export interface IndexEntry {
  hash: string;
  type: string;
  id: string;
  subfiles: number;
  size: number;
}

export interface RootInfo {
  hash: string;
  generation: number;
  schemaVersion: number;
}

export interface RmMetadata {
  visibleName: string;
  type: "DocumentType" | "CollectionType";
  parent: string;
  lastModified: string;
  deleted?: boolean;
  [key: string]: unknown;
}

export interface RmItem {
  id: string;
  hash: string;
  metadata: RmMetadata;
}

export class RemarkableError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

class ConflictError extends RemarkableError {}

/** A file to write into a document: its name in the index and its content. */
type FileUpdate = { name: string; data: Uint8Array | string };

/** Result of a committed change to one document. */
export interface ChangedDocument {
  /** Hash of the document index after the change. */
  hash: string;
  /** Hash of the document entry the change was merged onto. */
  baseHash: string;
}

type DocumentContext = {
  files: IndexEntry[];
  readText: (entry: IndexEntry) => Promise<string>;
};

/** Computes the files to change from a document's current file entries. */
type DocumentBuilder = (
  ctx: DocumentContext,
) => Promise<FileUpdate[] | undefined> | FileUpdate[] | undefined;

/**
 * Rewrites a document's `.metadata` from the entries in `cur`. `mutate` edits
 * the parsed metadata in place and returns false for "no change"; otherwise
 * `lastModified` is bumped. Undefined when there is no metadata entry or
 * nothing changed.
 */
async function patchMetadata(
  id: string,
  cur: DocumentContext,
  mutate: (metadata: RmMetadata) => boolean,
): Promise<FileUpdate | undefined> {
  const entry = cur.files.find((f) => f.id === `${id}.metadata`);
  if (!entry) return undefined;
  const metadata = JSON.parse(await cur.readText(entry)) as RmMetadata;
  if (mutate(metadata) === false) return undefined;
  metadata.lastModified = String(Date.now());
  return { name: `${id}.metadata`, data: JSON.stringify(metadata) };
}

/** A library entry whose metadata cannot be used; listItems skips it. */
class UnreadableEntry extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function byId(a: { id: string }, b: { id: string }) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function parseIndex(text: string): {
  schema: number;
  entries: IndexEntry[];
} {
  const lines = text.split("\n").filter((l) => l.length);
  const schema = parseInt(lines.shift() ?? "3", 10);
  if (schema === 4 && lines.length && lines[0].startsWith("0:")) lines.shift();
  const entries = lines.map((line) => {
    const [hash, type, id, subfiles, size] = line.split(":");
    return { hash, type, id, subfiles: Number(subfiles), size: Number(size) };
  });
  return { schema, entries };
}

/** Serialize an index in schema 4. `id` is "." for the root index. */
export function serializeIndex(id: string, entries: IndexEntry[]): string {
  const sorted = [...entries].sort(byId);
  const total = sorted.reduce((s, e) => s + e.size, 0);
  const lines = [
    "4",
    `0:${id}:${sorted.length}:${total}`,
    ...sorted.map((e) => `${e.hash}:0:${e.id}:${e.subfiles}:${e.size}`),
  ];
  return `${lines.join("\n")}\n`;
}

export interface CloudOptions {
  fetch: FetchFn;
  deviceToken: string;
  userToken?: string;
  onUserToken?: (token: string) => void;
  syncHost?: string;
  /** Stable client uuid, recorded as CRDT author in .content files. */
  clientId?: string;
  /** Diagnostics sink (Zotero.debug in the plugin); keeps this module Zotero-free. */
  log?: (message: string) => void;
}

/** Exchange a one-time code (from CONNECT_URL) for a long-lived device token. */
export async function registerDevice(
  fetchFn: FetchFn,
  code: string,
  deviceID: string = uuid4(),
): Promise<string> {
  const res = await fetchFn(`${AUTH_HOST}/token/json/2/device/new`, {
    method: "POST",
    headers: { Authorization: "Bearer", "Content-Type": "application/json" },
    body: JSON.stringify({
      code: code.trim(),
      deviceDesc: "browser-chrome",
      deviceID,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new RemarkableError(
      `Pairing failed (${res.status}): ${text}`,
      res.status,
    );
  }
  return text.trim();
}

/**
 * Pair and only keep the device token once it has been validated, so a token
 * that does not work is never stored (and the UI never shows as connected).
 */
export async function pairDevice(steps: {
  register: () => Promise<string>;
  validate: (token: string) => Promise<unknown>;
  store: (token: string) => void;
}): Promise<void> {
  const token = await steps.register();
  await steps.validate(token);
  steps.store(token);
}

export class RemarkableCloud {
  private fetch: FetchFn;
  private userToken?: string;
  private host: string;
  /** docSchema hash -> parsed metadata, so unchanged docs aren't refetched. */
  private metaCache = new Map<string, RmItem>();

  constructor(private opts: CloudOptions) {
    this.fetch = opts.fetch;
    this.userToken = opts.userToken;
    this.host = opts.syncHost ?? SYNC_HOST;
  }

  async refreshUserToken() {
    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.fetch(`${AUTH_HOST}/token/json/2/user/new`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.opts.deviceToken}` },
        });
        if (res.status < 500 && res.status !== 429) break;
      } catch (e) {
        if (attempt >= 3) throw e;
      }
      if (attempt >= 3) break;
      await sleep(backoff(attempt) + 500);
    }
    const text = await res!.text();
    if (!res!.ok) {
      throw new RemarkableError(
        `Could not authenticate with reMarkable (${res!.status}): ${text}`,
        res!.status,
      );
    }
    this.userToken = text.trim();
    this.opts.onUserToken?.(this.userToken);
    return this.userToken;
  }

  private tokenExpired() {
    if (!this.userToken) return true;
    try {
      const payload = JSON.parse(
        atob(
          this.userToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"),
        ),
      );
      return (
        typeof payload.exp === "number" &&
        payload.exp * 1000 < Date.now() + 60_000
      );
    } catch {
      return false;
    }
  }

  /** Authenticated request with token refresh and backoff on 429/5xx. */
  private async request(
    path: string,
    init: RequestInit & { headers?: Record<string, string> } = {},
    retryNetwork = true,
  ): Promise<Response> {
    if (this.tokenExpired()) await this.refreshUserToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(`${this.host}${path}`, {
          ...init,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${this.userToken}`,
          },
        });
      } catch (e) {
        if (!retryNetwork || attempt >= 4) throw e;
        await sleep(backoff(attempt));
        continue;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.refreshUserToken();
        continue;
      }
      if (
        (res.status === 429 || res.status >= 500) &&
        attempt < 5 &&
        retryNetwork
      ) {
        await sleep(backoff(attempt));
        continue;
      }
      return res;
    }
  }

  async getRoot(): Promise<RootInfo> {
    const res = await this.request("/sync/v4/root");
    if (res.status === 404)
      return { hash: "", generation: 0, schemaVersion: 4 };
    if (!res.ok)
      throw new RemarkableError(`GET root: ${res.status}`, res.status);
    return (await res.json()) as unknown as RootInfo;
  }

  async getBlob(hash: string, filename: string): Promise<Uint8Array> {
    const res = await this.request(`/sync/v3/files/${hash}`, {
      headers: { "rm-filename": filename },
    });
    if (!res.ok) {
      throw new RemarkableError(
        `GET ${filename}: ${res.status} ${await res.text()}`,
        res.status,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async getText(hash: string, filename: string) {
    return dec.decode(await this.getBlob(hash, filename));
  }

  /** Upload a blob and return its hash. */
  async putBlob(filename: string, data: Uint8Array | string): Promise<string> {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    return this.putHashed(filename, bytes, await sha256Hex(bytes));
  }

  private async putHashed(
    filename: string,
    bytes: Uint8Array,
    hash: string,
  ): Promise<string> {
    const res = await this.request(`/sync/v3/files/${hash}`, {
      method: "PUT",
      headers: {
        "rm-filename": filename,
        "x-goog-hash": crc32cHeader(bytes),
        "content-type": filename.endsWith(".docSchema")
          ? "text/plain; charset=UTF-8"
          : "application/octet-stream",
      },
      body: bytes as BodyInit,
    });
    if (!res.ok) {
      throw new RemarkableError(
        `PUT ${filename}: ${res.status} ${await res.text()}`,
        res.status,
      );
    }
    return hash;
  }

  async getRootEntries(root: RootInfo): Promise<IndexEntry[]> {
    if (!root.hash) return [];
    return parseIndex(await this.getText(root.hash, "root.docSchema")).entries;
  }

  async getDocEntries(entry: {
    id: string;
    hash: string;
  }): Promise<IndexEntry[]> {
    return parseIndex(await this.getText(entry.hash, `${entry.id}.docSchema`))
      .entries;
  }

  /**
   * Apply a change to the root index with compare-and-swap semantics. The
   * mutator receives the current root entries and returns the new list; it is
   * re-run on generation conflicts.
   */
  async updateRoot(
    mutate: (entries: IndexEntry[]) => Promise<IndexEntry[]> | IndexEntry[],
  ) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const root = await this.getRoot();
      const entries = await mutate(await this.getRootEntries(root));
      const text = serializeIndex(".", entries);
      const hash = await this.putBlob("root.docSchema", text);
      try {
        await this.putRoot(hash, root.generation);
        return;
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }
    throw new RemarkableError(
      "reMarkable cloud kept changing; try again later",
    );
  }

  private async putRoot(hash: string, generation: number) {
    // Never retry on network errors: this is a compare-and-swap.
    const res = await this.request(
      "/sync/v3/root",
      {
        method: "PUT",
        headers: {
          "rm-filename": "roothash",
          "content-type": "application/json",
        },
        body: JSON.stringify({ hash, generation, broadcast: true }),
      },
      false,
    );
    if (res.ok) return;
    const text = await res.text();
    if (res.status === 412 || /precondition/i.test(text)) {
      throw new ConflictError("generation conflict", res.status);
    }
    throw new RemarkableError(`PUT root: ${res.status} ${text}`, res.status);
  }

  /**
   * Upload file blobs and return their index entries (content-addressed). A
   * blob already uploaded under the same name and hash according to `done` is
   * not sent again.
   */
  private async uploadFiles(
    files: FileUpdate[],
    done?: Map<string, IndexEntry>,
  ): Promise<IndexEntry[]> {
    const out: IndexEntry[] = [];
    for (const f of files) {
      const bytes = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const hash = await sha256Hex(bytes);
      const key = `${f.name}\0${hash}`;
      let entry = done?.get(key);
      if (!entry) {
        await this.putHashed(f.name, bytes, hash);
        entry = {
          hash,
          type: "0",
          id: f.name,
          subfiles: 0,
          size: bytes.length,
        };
        done?.set(key, entry);
      }
      out.push(entry);
    }
    return out;
  }

  /** Upload a document index built from `entries` and return its root entry. */
  private async putDocIndex(
    id: string,
    entries: IndexEntry[],
  ): Promise<IndexEntry> {
    const hash = await this.putBlob(
      `${id}.docSchema`,
      serializeIndex(id, entries),
    );
    return {
      hash,
      type: "0",
      id,
      subfiles: entries.length,
      size: entries.reduce((s, e) => s + e.size, 0),
    };
  }

  /** Upload files for a brand-new document and return its root-index entry. */
  private async putDocument(
    id: string,
    files: FileUpdate[],
  ): Promise<IndexEntry> {
    return this.putDocIndex(id, await this.uploadFiles(files));
  }

  /** Commit a brand-new document (fresh id, nothing to merge with). */
  private async commitDocument(docEntry: IndexEntry) {
    await this.updateRoot((entries) => [
      ...entries.filter((e) => e.id !== docEntry.id),
      docEntry,
    ]);
  }

  /**
   * Change some files of an existing document. `build` computes the changed
   * files from the document's file entries (and a way to read their blobs);
   * it first runs on `baseFiles`, what the caller read. If the root has moved
   * on and the document is no longer `base`, then by default `build` runs again
   * on the document's CURRENT entries (so derived files such as .content and
   * .metadata are computed from the tablet's latest versions) and only those
   * files are replaced by name. With `onChanged: "throw"` a changed document
   * instead aborts the call with a RemarkableError, for callers whose files
   * were derived from data that cannot be re-derived here. `build` may return
   * undefined for "nothing to change". Uploaded blobs are content-addressed and
   * are not sent twice within one call. Returns the hash of the committed
   * document index (`hash`) and the hash of the document entry the change was
   * merged onto (`baseHash`: the entry `build` last ran on, which is newer than
   * `base` when the tablet committed in between).
   */
  private async changeDocument(
    id: string,
    base: IndexEntry,
    baseFiles: IndexEntry[],
    build: DocumentBuilder,
    opts: {
      ifMissing?: "throw" | "skip";
      onChanged?: "rebuild" | "throw";
    } = {},
  ): Promise<ChangedDocument> {
    const ifMissing = opts.ifMissing ?? "throw";
    const uploaded = new Map<string, IndexEntry>();
    const derive = async (
      files: IndexEntry[],
    ): Promise<IndexEntry | undefined> => {
      const updates = await build({
        files,
        readText: (e) => this.getText(e.hash, e.id),
      });
      if (!updates) return undefined;
      const changed = await this.uploadFiles(updates, uploaded);
      const names = new Set(changed.map((e) => e.id));
      return this.putDocIndex(id, [
        ...files.filter((e) => !names.has(e.id)),
        ...changed,
      ]);
    };
    // Built from what the caller read; reused while the document is unchanged.
    const prepared = await derive(baseFiles);
    if (!prepared) return { hash: base.hash, baseHash: base.hash };
    let committed = prepared.hash;
    let mergedOn = base.hash;
    await this.updateRoot(async (entries) => {
      const current = entries.find((e) => e.id === id);
      if (!current) {
        if (ifMissing === "skip") return entries;
        throw new RemarkableError(`Document ${id} not found`, 404);
      }
      let entry: IndexEntry | undefined = prepared;
      mergedOn = current.hash;
      if (current.hash !== base.hash) {
        if (opts.onChanged === "throw") {
          throw new RemarkableError(TABLET_CHANGED);
        }
        entry = await derive(await this.getDocEntries(current));
        if (!entry) {
          committed = current.hash;
          return entries;
        }
      }
      committed = entry.hash;
      return [...entries.filter((e) => e.id !== id), entry];
    });
    return { hash: committed, baseHash: mergedOn };
  }

  /**
   * List all documents and folders (excluding deleted ones). An entry whose
   * metadata is missing, unreadable or invalid is skipped (and logged)
   * instead of failing the whole listing. Auth,
   * rate-limit, server and network errors still propagate: they say nothing
   * about one entry, and skipping would make it look absent. With `strict`,
   * an unreadable entry throws instead, for callers that must not act on an
   * incomplete listing (folder discovery would otherwise create a duplicate).
   */
  async listItems({
    concurrency = 3,
    strict = false,
  }: {
    concurrency?: number;
    strict?: boolean;
  } = {}): Promise<RmItem[]> {
    const root = await this.getRoot();
    const entries = await this.getRootEntries(root);
    const out: RmItem[] = [];
    await pool(entries, concurrency, async (entry) => {
      let item = this.metaCache.get(entry.hash);
      if (!item) {
        try {
          const files = await this.getDocEntries(entry);
          const meta = files.find((f) => f.id === `${entry.id}.metadata`);
          if (!meta) throw new UnreadableEntry("no metadata file");
          const metadata = JSON.parse(
            await this.getText(meta.hash, meta.id),
          ) as RmMetadata;
          if (!metadata || typeof metadata !== "object") {
            throw new UnreadableEntry("metadata is not an object");
          }
          item = { id: entry.id, hash: entry.hash, metadata };
          this.metaCache.set(entry.hash, item);
        } catch (e) {
          if (
            !(e instanceof UnreadableEntry) &&
            !(e instanceof SyntaxError) &&
            !(e instanceof RemarkableError && e.status === 404)
          ) {
            throw e;
          }
          const reason = e instanceof Error ? e.message : String(e);
          if (strict) {
            throw new Error(`unreadable library entry ${entry.id}: ${reason}`);
          }
          this.opts.log?.(`skipping unreadable entry ${entry.id}: ${reason}`);
          return;
        }
      }
      if (!item.metadata.deleted) out.push(item);
    });
    return out;
  }

  /**
   * Find (or create) a top-level folder with the given name. The listing is
   * strict: an unreadable entry could be the existing folder, so it throws
   * rather than creating a duplicate. A caller-supplied `items` must come
   * from a strict listing for the same reason.
   */
  async ensureFolder(name: string, items?: RmItem[]): Promise<string> {
    items ??= await this.listItems({ strict: true });
    const found = items.find(
      (i) =>
        i.metadata.type === "CollectionType" &&
        i.metadata.visibleName === name &&
        i.metadata.parent === "",
    );
    if (found) return found.id;
    const id = uuid4();
    const now = String(Date.now());
    const entry = await this.putDocument(id, [
      {
        name: `${id}.metadata`,
        data: JSON.stringify({
          visibleName: name,
          type: "CollectionType",
          parent: "",
          lastModified: now,
          createdTime: now,
          pinned: false,
        }),
      },
      { name: `${id}.content`, data: JSON.stringify({ tags: [] }) },
    ]);
    await this.commitDocument(entry);
    return id;
  }

  /**
   * Upload a new PDF document and return its id and the hash of the
   * committed document entry. A caller that must record
   * the id before the commit (the root PUT is never retried, so a lost
   * response would otherwise orphan the upload) passes a pre-generated `id`.
   */
  async uploadPdf(
    name: string,
    pdf: Uint8Array,
    pageCount: number,
    parent = "",
    id: string = uuid4(),
  ): Promise<{ id: string; hash: string }> {
    const now = String(Date.now());
    const metadata = {
      visibleName: name,
      type: "DocumentType",
      parent,
      lastModified: now,
      createdTime: now,
      lastOpened: "0",
      lastOpenedPage: 0,
      pinned: false,
    };
    const content = buildPdfContent({
      pageCount,
      sizeInBytes: pdf.length,
      newId: uuid4,
      authorId: this.opts.clientId ?? uuid4(),
    });
    const entry = await this.putDocument(id, [
      { name: `${id}.pdf`, data: pdf },
      { name: `${id}.metadata`, data: JSON.stringify(metadata) },
      { name: `${id}.content`, data: JSON.stringify(content) },
      { name: `${id}.pagedata`, data: "\n" },
    ]);
    await this.commitDocument(entry);
    return { id, hash: entry.hash };
  }

  /** Find a document's root entry, or undefined if it no longer exists. */
  async findDocument(id: string): Promise<IndexEntry | undefined> {
    const root = await this.getRoot();
    return (await this.getRootEntries(root)).find((e) => e.id === id);
  }

  /** A document's root entry and file entries, or undefined if it is gone. */
  private async openDocument(id: string) {
    const entry = await this.findDocument(id);
    if (!entry) return undefined;
    return { entry, files: await this.getDocEntries(entry) };
  }

  /**
   * Replace the PDF of an existing document, keeping its .rm annotation files
   * and page mapping. The new PDF must keep the original page order. When
   * `name` is given and differs from the current one, the document is renamed.
   * Returns the new document hash and the hash of the entry it was merged onto.
   */
  async replacePdf(
    id: string,
    pdf: Uint8Array,
    pageCount: number,
    name?: string,
  ): Promise<ChangedDocument> {
    const doc = await this.openDocument(id);
    if (!doc) throw new RemarkableError(`Document ${id} not found`, 404);
    return this.changeDocument(id, doc.entry, doc.files, async (cur) => {
      // Derived from the entries the build is given, so after a conflict the
      // pages and metadata the tablet changed meanwhile are kept.
      const updates: FileUpdate[] = [{ name: `${id}.pdf`, data: pdf }];
      const meta = await patchMetadata(id, cur, (metadata) => {
        if (name !== undefined) metadata.visibleName = name;
        return true;
      });
      if (meta) updates.push(meta);
      const contentEntry = cur.files.find((f) => f.id === `${id}.content`);
      const oldContent = contentEntry
        ? JSON.parse(await cur.readText(contentEntry))
        : undefined;
      const content = reconcileContent(
        oldContent,
        pageCount,
        pdf.length,
        uuid4,
        this.opts.clientId ?? uuid4(),
      );
      updates.push({ name: `${id}.content`, data: JSON.stringify(content) });
      return updates;
    });
  }

  /**
   * Rename a document without touching anything else. Does nothing when the
   * name is already `name` or the document has no readable metadata.
   * `baseHash` is the hash of the entry the rename was merged onto, `hash` the
   * document hash afterwards (equal to `baseHash` when nothing changed).
   */
  async renameDocument(id: string, name: string): Promise<ChangedDocument> {
    const doc = await this.openDocument(id);
    if (!doc) throw new RemarkableError(`Document ${id} not found`, 404);
    return this.changeDocument(id, doc.entry, doc.files, async (cur) => {
      const update = await patchMetadata(id, cur, (metadata) => {
        if (metadata.visibleName === name) return false;
        metadata.visibleName = name;
        return true;
      });
      return update && [update];
    });
  }

  /**
   * Write page files and/or a new `.content` for a document in one commit.
   * `pages` maps page id -> `.rm` bytes. The caller derived both from the
   * document it read and they cannot be re-derived here, so when the tablet
   * changed the document meanwhile this throws instead of overwriting it.
   * `expectedHash` is the hash of the document the caller derived its writes
   * from (the `hash` of `getDocumentFiles`): the call throws, before writing
   * anything, if the document is not at that hash any more. Resolves to the
   * new document hash and the hash it was merged onto (both the current hash
   * when `changes` is empty).
   */
  async updateDocument(
    id: string,
    changes: { pages?: Map<string, Uint8Array>; content?: unknown },
    opts: { expectedHash?: string } = {},
  ): Promise<ChangedDocument> {
    const docEntry = await this.findDocument(id);
    if (!docEntry) throw new RemarkableError(`Document ${id} not found`, 404);
    if (
      opts.expectedHash !== undefined &&
      docEntry.hash !== opts.expectedHash
    ) {
      throw new RemarkableError(TABLET_CHANGED);
    }
    const files = await this.getDocEntries(docEntry);
    const updates: FileUpdate[] = [];
    for (const [pageId, data] of changes.pages ?? []) {
      updates.push({ name: `${id}/${pageId}.rm`, data });
    }
    if (changes.content !== undefined) {
      updates.push({
        name: `${id}.content`,
        data: JSON.stringify(changes.content),
      });
    }
    if (!updates.length) {
      return { hash: docEntry.hash, baseHash: docEntry.hash };
    }
    return this.changeDocument(id, docEntry, files, () => updates, {
      onChanged: "throw",
    });
  }

  /** Move a document to the trash (the tablet then deletes it). */
  async trashDocument(id: string) {
    const doc = await this.openDocument(id);
    if (!doc) return;
    await this.changeDocument(
      id,
      doc.entry,
      doc.files,
      async (cur) => {
        const update = await patchMetadata(id, cur, (metadata) => {
          metadata.parent = "trash";
          return true;
        });
        return update && [update];
      },
      { ifMissing: "skip" },
    );
  }

  /**
   * The page ids in a document's live `.content` (one root read, the index and
   * the .content blob; no pages), or undefined if the document is gone. Used to
   * find out whether a write whose response was lost reached the server.
   */
  async getPageIds(id: string): Promise<Set<string> | undefined> {
    const doc = await this.openDocument(id);
    if (!doc) return undefined;
    const entry = doc.files.find((f) => f.id === `${id}.content`);
    const content = entry
      ? JSON.parse(await this.getText(entry.hash, entry.id))
      : {};
    return new Set(pageRefs(content).map((r) => r.id));
  }

  /** Download the .content and every .rm page file of a document. */
  async getDocumentFiles(id: string, entry?: IndexEntry) {
    entry ??= await this.findDocument(id);
    if (!entry) return undefined;
    const files = await this.getDocEntries(entry);
    const contentEntry = files.find((f) => f.id === `${id}.content`);
    const content = contentEntry
      ? JSON.parse(await this.getText(contentEntry.hash, contentEntry.id))
      : {};
    const rm = new Map<string, Uint8Array>();
    const rmEntries = files.filter((f) => /\/[^/]+\.rm$/.test(f.id));
    await pool(rmEntries, 3, async (f) => {
      const pageId = f.id.slice(f.id.lastIndexOf("/") + 1, -3);
      rm.set(pageId, await this.getBlob(f.hash, f.id));
    });
    return { hash: entry.hash, content, rm, files };
  }
}

const TABLET_CHANGED =
  "The tablet changed this document while syncing; nothing was written, the next sync retries";

/** True for the error that says a write was refused and nothing was written. */
export function isTabletChangedError(e: unknown) {
  return e instanceof RemarkableError && e.message === TABLET_CHANGED;
}

function backoff(attempt: number) {
  return Math.min(30_000, 200 * 2 ** attempt) * (0.5 + Math.random() / 2);
}

function sleep(ms: number) {
  // Plugin sandboxes may lack timers; fall back to Zotero's.
  const g = globalThis as any;
  if (typeof g.setTimeout === "function") {
    return new Promise((r) => g.setTimeout(r, ms));
  }
  return g.Zotero.Promise.delay(ms);
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}
