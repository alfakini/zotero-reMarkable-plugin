/**
 * Minimal client for the reMarkable cloud "sync v3/v4" protocol.
 *
 * Model: every file is a content-addressed blob (sha256). A document is an
 * index blob (`<id>.docSchema`) listing its files; the root index lists every
 * document index. Changing anything means uploading new blobs, a new document
 * index, a new root index, and finally compare-and-swapping the root pointer.
 */
import { buildPdfContent, reconcileContent } from "./content";
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
  return lines.join("\n") + "\n";
}

export interface CloudOptions {
  fetch: FetchFn;
  deviceToken: string;
  userToken?: string;
  onUserToken?: (token: string) => void;
  syncHost?: string;
  /** Stable client uuid, recorded as CRDT author in .content files. */
  clientId?: string;
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
    const hash = await sha256Hex(bytes);
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

  /** Upload files for a document and return its root-index entry. */
  private async putDocument(
    id: string,
    files: { name: string; data: Uint8Array | string }[],
    keep: IndexEntry[] = [],
  ): Promise<IndexEntry> {
    const names = new Set(files.map((f) => f.name));
    const entries = keep.filter((e) => !names.has(e.id));
    for (const f of files) {
      const bytes = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const hash = await this.putBlob(f.name, bytes);
      entries.push({
        hash,
        type: "0",
        id: f.name,
        subfiles: 0,
        size: bytes.length,
      });
    }
    const index = serializeIndex(id, entries);
    const hash = await this.putBlob(`${id}.docSchema`, index);
    return {
      hash,
      type: "0",
      id,
      subfiles: entries.length,
      size: entries.reduce((s, e) => s + e.size, 0),
    };
  }

  private async commitDocument(docEntry: IndexEntry) {
    await this.updateRoot((entries) => [
      ...entries.filter((e) => e.id !== docEntry.id),
      docEntry,
    ]);
  }

  /** List all documents and folders (excluding deleted ones). */
  async listItems(concurrency = 3): Promise<RmItem[]> {
    const root = await this.getRoot();
    const entries = await this.getRootEntries(root);
    const out: RmItem[] = [];
    await pool(entries, concurrency, async (entry) => {
      let item = this.metaCache.get(entry.hash);
      if (!item) {
        const files = await this.getDocEntries(entry);
        const meta = files.find((f) => f.id === `${entry.id}.metadata`);
        if (!meta) return;
        const metadata = JSON.parse(
          await this.getText(meta.hash, meta.id),
        ) as RmMetadata;
        item = { id: entry.id, hash: entry.hash, metadata };
        this.metaCache.set(entry.hash, item);
      }
      if (!item.metadata.deleted) out.push(item);
    });
    return out;
  }

  /** Find (or create) a top-level folder with the given name. */
  async ensureFolder(name: string, items?: RmItem[]): Promise<string> {
    items ??= await this.listItems();
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

  /** Upload a new PDF document and return its id. */
  async uploadPdf(
    name: string,
    pdf: Uint8Array,
    pageCount: number,
    parent = "",
  ): Promise<string> {
    const id = uuid4();
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
    return id;
  }

  /** Find a document's root entry, or undefined if it no longer exists. */
  async findDocument(id: string): Promise<IndexEntry | undefined> {
    const root = await this.getRoot();
    return (await this.getRootEntries(root)).find((e) => e.id === id);
  }

  /**
   * Replace the PDF of an existing document, keeping its .rm annotation files
   * and page mapping. The new PDF must keep the original page order.
   */
  async replacePdf(id: string, pdf: Uint8Array, pageCount: number) {
    const docEntry = await this.findDocument(id);
    if (!docEntry) throw new RemarkableError(`Document ${id} not found`, 404);
    const files = await this.getDocEntries(docEntry);
    const metaEntry = files.find((f) => f.id === `${id}.metadata`);
    const metadata = metaEntry
      ? (JSON.parse(
          await this.getText(metaEntry.hash, metaEntry.id),
        ) as RmMetadata)
      : undefined;
    const updates: { name: string; data: Uint8Array | string }[] = [
      { name: `${id}.pdf`, data: pdf },
    ];
    if (metadata) {
      metadata.lastModified = String(Date.now());
      updates.push({ name: `${id}.metadata`, data: JSON.stringify(metadata) });
    }
    const contentEntry = files.find((f) => f.id === `${id}.content`);
    const oldContent = contentEntry
      ? JSON.parse(await this.getText(contentEntry.hash, contentEntry.id))
      : undefined;
    const content = reconcileContent(
      oldContent,
      pageCount,
      pdf.length,
      uuid4,
      this.opts.clientId ?? uuid4(),
    );
    updates.push({ name: `${id}.content`, data: JSON.stringify(content) });
    const entry = await this.putDocument(id, updates, files);
    await this.commitDocument(entry);
  }

  /**
   * Write page files and/or a new `.content` for a document in one commit.
   * `pages` maps page id -> `.rm` bytes.
   */
  async updateDocument(
    id: string,
    changes: { pages?: Map<string, Uint8Array>; content?: unknown },
  ) {
    const docEntry = await this.findDocument(id);
    if (!docEntry) throw new RemarkableError(`Document ${id} not found`, 404);
    const files = await this.getDocEntries(docEntry);
    const updates: { name: string; data: Uint8Array | string }[] = [];
    for (const [pageId, data] of changes.pages ?? []) {
      updates.push({ name: `${id}/${pageId}.rm`, data });
    }
    if (changes.content !== undefined) {
      updates.push({
        name: `${id}.content`,
        data: JSON.stringify(changes.content),
      });
    }
    if (!updates.length) return docEntry.hash;
    const entry = await this.putDocument(id, updates, files);
    await this.commitDocument(entry);
    return entry.hash;
  }

  /** Move a document to the trash (the tablet then deletes it). */
  async trashDocument(id: string) {
    const docEntry = await this.findDocument(id);
    if (!docEntry) return;
    const files = await this.getDocEntries(docEntry);
    const metaEntry = files.find((f) => f.id === `${id}.metadata`);
    if (!metaEntry) return;
    const metadata = JSON.parse(
      await this.getText(metaEntry.hash, metaEntry.id),
    );
    metadata.parent = "trash";
    metadata.lastModified = String(Date.now());
    const entry = await this.putDocument(
      id,
      [{ name: `${id}.metadata`, data: JSON.stringify(metadata) }],
      files,
    );
    await this.commitDocument(entry);
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
