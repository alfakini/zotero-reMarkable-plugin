import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type IndexEntry,
  pairDevice,
  parseIndex,
  isTabletChangedError,
  RemarkableCloud,
  META_CACHE_MAX,
  RemarkableError,
  serializeIndex,
} from "../../src/remarkable/cloud";
import { sha256Hex } from "../../src/remarkable/hash";
import { resolveFolderId } from "../../src/sync/folderCache";
import { titleToPush } from "../../src/sync/titlePush";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

// JWT-shaped token that never expires, so no auth refresh is attempted.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64({ alg: "none" })}.${b64({ exp: 4102444800 })}.sig`;

/** In-memory fake of the sync v3/v4 endpoints used by RemarkableCloud. */
class FakeCloud {
  blobs = new Map<string, Uint8Array>();
  rootHash = "";
  generation = 0;
  puts: { filename: string; hash: string }[] = [];
  rootPuts = 0;
  /** Runs before each root PUT is evaluated; simulates other clients. */
  beforeRootPut?: (n: number) => Promise<void> | void;
  /** Applies each root PUT, then fails the request as if the response was lost. */
  loseRootResponse = false;

  async store(data: string | Uint8Array) {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    const hash = await sha256Hex(bytes);
    this.blobs.set(hash, bytes);
    return hash;
  }

  text(hash: string) {
    return dec.decode(this.blobs.get(hash));
  }

  rootEntries(): IndexEntry[] {
    return this.rootHash ? parseIndex(this.text(this.rootHash)).entries : [];
  }

  docEntries(id: string): IndexEntry[] {
    const e = this.rootEntries().find((x) => x.id === id);
    assert.ok(e, `doc ${id} in root`);
    return parseIndex(this.text(e.hash)).entries;
  }

  fileText(id: string, name: string) {
    const f = this.docEntries(id).find((e) => e.id === name);
    assert.ok(f, `file ${name}`);
    return this.text(f.hash);
  }

  /** Another client writes a document with the given files and commits. */
  async clientCommit(id: string, files: Record<string, string>) {
    const existing = this.rootEntries().find((e) => e.id === id);
    const entries = new Map<string, IndexEntry>();
    if (existing) {
      for (const e of parseIndex(this.text(existing.hash)).entries) {
        entries.set(e.id, e);
      }
    }
    for (const [name, data] of Object.entries(files)) {
      entries.set(name, {
        hash: await this.store(data),
        type: "0",
        id: name,
        subfiles: 0,
        size: enc.encode(data).length,
      });
    }
    const list = [...entries.values()];
    const docHash = await this.store(serializeIndex(id, list));
    const docEntry: IndexEntry = {
      hash: docHash,
      type: "0",
      id,
      subfiles: list.length,
      size: list.reduce((s, e) => s + e.size, 0),
    };
    const root = [...this.rootEntries().filter((e) => e.id !== id), docEntry];
    this.rootHash = await this.store(serializeIndex(".", root));
    this.generation++;
  }

  /** Pathnames of every request, in order. */
  requests: string[] = [];
  /** Number of GETs of blobs whose rm-filename ends in .rm. */
  rmGets = 0;

  fetch = async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    this.requests.push(url.pathname);
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    const json = (o: unknown, status = 200) =>
      new Response(JSON.stringify(o), { status });
    if (url.pathname === "/sync/v4/root") {
      if (!this.rootHash) return new Response("", { status: 404 });
      return json({
        hash: this.rootHash,
        generation: this.generation,
        schemaVersion: 4,
      });
    }
    if (url.pathname === "/sync/v3/root" && method === "PUT") {
      this.rootPuts++;
      await this.beforeRootPut?.(this.rootPuts);
      const body = JSON.parse(String(init.body));
      if (body.generation !== this.generation) {
        return new Response("precondition failed", { status: 412 });
      }
      assert.ok(this.blobs.has(body.hash), "root blob uploaded first");
      this.rootHash = body.hash;
      this.generation++;
      if (this.loseRootResponse) throw new TypeError("network error");
      return json({ hash: this.rootHash, generation: this.generation });
    }
    const m = url.pathname.match(/^\/sync\/v3\/files\/([0-9a-f]+)$/);
    if (m) {
      if (method === "PUT") {
        const bytes = init.body as Uint8Array;
        assert.equal(await sha256Hex(bytes), m[1]);
        this.blobs.set(m[1], bytes);
        this.puts.push({ filename: headers["rm-filename"], hash: m[1] });
        return new Response("", { status: 200 });
      }
      if (headers["rm-filename"]?.endsWith(".rm")) this.rmGets++;
      const blob = this.blobs.get(m[1]);
      return blob
        ? new Response(blob as BodyInit, { status: 200 })
        : new Response("not found", { status: 404 });
    }
    return new Response(`unexpected ${url.pathname}`, { status: 500 });
  };

  cloud(extra: Partial<ConstructorParameters<typeof RemarkableCloud>[0]> = {}) {
    return new RemarkableCloud({
      ...extra,
      fetch: this.fetch as unknown as typeof fetch,
      deviceToken: "unused",
      userToken: TOKEN,
      clientId: "33333333-3333-4333-8333-333333333333",
    });
  }
}

const metadata = (name: string) =>
  JSON.stringify({
    visibleName: name,
    type: "DocumentType",
    parent: "",
    lastModified: "1",
  });

async function seed(fake: FakeCloud) {
  await fake.clientCommit(ID, {
    [`${ID}.pdf`]: "old-pdf",
    [`${ID}.metadata`]: metadata("Paper"),
    [`${ID}.content`]: JSON.stringify({ pageCount: 1, pages: ["p1"] }),
    [`${ID}/p1.rm`]: "strokes-v1",
  });
  await fake.clientCommit(OTHER, {
    [`${OTHER}.metadata`]: metadata("Other"),
    [`${OTHER}.content`]: "{}",
  });
}

test("replacePdf without conflict replaces only the pdf, metadata and content", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  await fake.cloud().replacePdf(ID, enc.encode("new-pdf"), 1);
  assert.equal(fake.fileText(ID, `${ID}.pdf`), "new-pdf");
  assert.equal(fake.fileText(ID, `${ID}/p1.rm`), "strokes-v1");
  assert.equal(fake.rootPuts, 1);
  assert.ok(fake.rootEntries().some((e) => e.id === OTHER));
});

test("replacePdf renames the document only when a name is given", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  await fake.cloud().replacePdf(ID, enc.encode("new-pdf"), 1);
  assert.equal(
    JSON.parse(fake.fileText(ID, `${ID}.metadata`)).visibleName,
    "Paper",
  );
  await fake.cloud().replacePdf(ID, enc.encode("newer-pdf"), 1, "Renamed");
  const meta = JSON.parse(fake.fileText(ID, `${ID}.metadata`));
  assert.equal(meta.visibleName, "Renamed");
  assert.equal(meta.type, "DocumentType");
  assert.equal(fake.fileText(ID, `${ID}/p1.rm`), "strokes-v1");
});

test("renameDocument updates only the metadata, and only when the name differs", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const before = fake.rootEntries().find((e) => e.id === ID)?.hash;
  const noop = await fake.cloud().renameDocument(ID, "Paper");
  assert.equal(noop.baseHash, before);
  assert.equal(noop.hash, before);
  assert.equal(fake.rootPuts, 0);
  assert.equal(fake.rootEntries().find((e) => e.id === ID)?.hash, before);

  const pdfPuts = fake.puts.filter((p) => p.filename === `${ID}.pdf`).length;
  const renamed = await fake.cloud().renameDocument(ID, "New title");
  assert.equal(renamed.baseHash, before);
  assert.equal(renamed.hash, fake.rootEntries().find((e) => e.id === ID)?.hash);
  assert.notEqual(renamed.hash, before);
  assert.equal(fake.rootPuts, 1);
  assert.equal(
    JSON.parse(fake.fileText(ID, `${ID}.metadata`)).visibleName,
    "New title",
  );
  assert.equal(fake.fileText(ID, `${ID}.pdf`), "old-pdf");
  assert.equal(fake.fileText(ID, `${ID}/p1.rm`), "strokes-v1");
  assert.equal(
    fake.puts.filter((p) => p.filename === `${ID}.pdf`).length,
    pdfPuts,
  );
  assert.ok(fake.rootEntries().some((e) => e.id === OTHER));
});

test("renameDocument on a missing document throws 404", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  await assert.rejects(
    fake.cloud().renameDocument("33333333-3333-4333-8333-333333333333", "x"),
    (e: unknown) => e instanceof RemarkableError && e.status === 404,
  );
});

test("conflict: a change the tablet made to the same document survives", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  fake.beforeRootPut = async (n) => {
    if (n === 1) {
      await fake.clientCommit(ID, {
        [`${ID}/p1.rm`]: "strokes-v2",
        [`${ID}/p2.rm`]: "new-page",
      });
    }
  };
  await fake.cloud().replacePdf(ID, enc.encode("new-pdf"), 1);
  assert.equal(fake.rootPuts, 2);
  assert.equal(fake.fileText(ID, `${ID}.pdf`), "new-pdf");
  assert.equal(fake.fileText(ID, `${ID}/p1.rm`), "strokes-v2");
  assert.equal(fake.fileText(ID, `${ID}/p2.rm`), "new-page");
  // Blob uploads are content-addressed and are not repeated after a conflict.
  const pdfPuts = fake.puts.filter((p) => p.filename === `${ID}.pdf`);
  assert.equal(pdfPuts.length, 1);
});

test("updateDocument conflict throws and writes nothing", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  fake.beforeRootPut = async (n) => {
    if (n === 1) await fake.clientCommit(ID, { [`${ID}/p1.rm`]: "strokes-v2" });
  };
  const rootBefore = fake.rootHash;
  await assert.rejects(
    fake
      .cloud()
      .updateDocument(ID, { pages: new Map([["p3", enc.encode("imported")]]) }),
    (e) => e instanceof RemarkableError && /tablet changed/.test(e.message),
  );
  // Only the tablet's own commit reached the root; our page was not added.
  assert.equal(fake.rootPuts, 1);
  assert.notEqual(fake.rootHash, rootBefore);
  assert.ok(!fake.docEntries(ID).some((e) => e.id === `${ID}/p3.rm`));
  assert.equal(fake.fileText(ID, `${ID}/p1.rm`), "strokes-v2");
});

test("updateDocument succeeds when a conflict left the document unchanged", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  fake.beforeRootPut = async (n) => {
    if (n === 1) {
      await fake.clientCommit(OTHER, { [`${OTHER}/p9.rm`]: "other-strokes" });
    }
  };
  const before = fake.rootEntries().find((e) => e.id === ID)?.hash;
  const changed = await fake
    .cloud()
    .updateDocument(ID, { pages: new Map([["p3", enc.encode("imported")]]) });
  assert.equal(fake.rootPuts, 2);
  assert.equal(fake.fileText(ID, `${ID}/p3.rm`), "imported");
  assert.equal(fake.fileText(ID, `${ID}/p1.rm`), "strokes-v1");
  assert.equal(fake.rootEntries().find((e) => e.id === ID)?.hash, changed.hash);
  assert.equal(changed.baseHash, before);
});

test("updateDocument with expectedHash throws before any write when the tablet committed after the read", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const cloud = fake.cloud();
  const files = await cloud.getDocumentFiles(ID);
  assert.ok(files);
  // The tablet commits between getDocumentFiles and updateDocument.
  await fake.clientCommit(ID, { [`${ID}/p1.rm`]: "strokes-v2" });
  const rootBefore = fake.rootHash;
  const putsBefore = fake.puts.length;
  await assert.rejects(
    cloud.updateDocument(
      ID,
      {
        pages: new Map([["p3", enc.encode("imported")]]),
        content: { pageCount: 1, pages: ["p1", "p3"] },
      },
      { expectedHash: files.hash },
    ),
    (e) => e instanceof RemarkableError && /tablet changed/.test(e.message),
  );
  assert.equal(fake.rootPuts, 0);
  assert.equal(fake.rootHash, rootBefore);
  assert.equal(fake.puts.length, putsBefore);
  assert.equal(fake.fileText(ID, `${ID}/p1.rm`), "strokes-v2");
  assert.ok(!fake.docEntries(ID).some((e) => e.id === `${ID}/p3.rm`));
});

test("updateDocument with a matching expectedHash writes and returns the new hash", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const cloud = fake.cloud();
  const files = await cloud.getDocumentFiles(ID);
  assert.ok(files);
  const changed = await cloud.updateDocument(
    ID,
    { pages: new Map([["p3", enc.encode("imported")]]) },
    { expectedHash: files.hash },
  );
  assert.equal(fake.rootPuts, 1);
  assert.equal(fake.fileText(ID, `${ID}/p3.rm`), "imported");
  assert.equal(fake.rootEntries().find((e) => e.id === ID)?.hash, changed.hash);
  assert.equal(changed.baseHash, files.hash);
});

test("updateDocument with nothing to write reports the current hash as both", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const before = fake.rootEntries().find((e) => e.id === ID)?.hash;
  const changed = await fake.cloud().updateDocument(ID, {});
  assert.equal(fake.rootPuts, 0);
  assert.deepEqual(changed, { hash: before, baseHash: before });
});

test("replacePdf reports the hash of the entry it was merged onto", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const before = fake.rootEntries().find((e) => e.id === ID)?.hash;
  const plain = await fake.cloud().replacePdf(ID, enc.encode("new-pdf"), 1);
  assert.equal(plain.baseHash, before);
  assert.equal(plain.hash, fake.rootEntries().find((e) => e.id === ID)?.hash);

  // The tablet commits during the root swap: the merge base is its entry.
  fake.beforeRootPut = async (n) => {
    if (n === 1) await fake.clientCommit(ID, { [`${ID}/p1.rm`]: "strokes-v2" });
  };
  fake.rootPuts = 0;
  const tabletHash = (): string | undefined => {
    return fake.rootEntries().find((e) => e.id === ID)?.hash;
  };
  const start = tabletHash();
  const merged = await fake.cloud().replacePdf(ID, enc.encode("newer"), 1);
  assert.notEqual(merged.baseHash, start);
  assert.equal(merged.hash, tabletHash());
  assert.equal(fake.fileText(ID, `${ID}/p1.rm`), "strokes-v2");
});

test("replacePdf re-derives .content and .metadata from the document after a conflict", async () => {
  const fake = new FakeCloud();
  const page = (id: string, idx: string, redir: number) => ({
    id,
    idx: { timestamp: "1:2", value: idx },
    redir: { timestamp: "1:2", value: redir },
  });
  const content = (pages: ReturnType<typeof page>[]) =>
    JSON.stringify({
      cPages: {
        original: { timestamp: "1:1", value: 1 },
        pages,
        uuids: [{ first: "33333333-3333-4333-8333-333333333333", second: 1 }],
      },
      fileType: "pdf",
      pageCount: 1,
    });
  await fake.clientCommit(ID, {
    [`${ID}.pdf`]: "old-pdf",
    [`${ID}.metadata`]: metadata("Paper"),
    [`${ID}.content`]: content([page("p1", "ba", 0)]),
    [`${ID}/p1.rm`]: "strokes-v1",
  });
  fake.beforeRootPut = async (n) => {
    if (n !== 1) return;
    // The tablet adds an inserted page p2 and renames the document.
    await fake.clientCommit(ID, {
      [`${ID}.metadata`]: JSON.stringify({
        visibleName: "Renamed on tablet",
        type: "DocumentType",
        parent: "folder",
        lastModified: "5",
      }),
      [`${ID}.content`]: content([
        page("p1", "ba", 0),
        { ...page("p2", "bb", 0), redir: undefined } as never,
      ]),
      [`${ID}/p2.rm`]: "new-page",
    });
  };
  await fake.cloud().replacePdf(ID, enc.encode("new-pdf"), 1);
  assert.equal(fake.rootPuts, 2);
  assert.equal(fake.fileText(ID, `${ID}.pdf`), "new-pdf");
  assert.equal(fake.fileText(ID, `${ID}/p2.rm`), "new-page");
  assert.equal(fake.fileText(ID, `${ID}/p1.rm`), "strokes-v1");
  const pages = JSON.parse(fake.fileText(ID, `${ID}.content`)).cPages.pages;
  assert.deepEqual(
    pages.map((p: { id: string }) => p.id),
    ["p1", "p2"],
  );
  // Metadata comes from the tablet's current version, with only lastModified
  // changed (and no rename, because none was requested).
  const meta = JSON.parse(fake.fileText(ID, `${ID}.metadata`));
  assert.equal(meta.visibleName, "Renamed on tablet");
  assert.equal(meta.parent, "folder");
  assert.notEqual(meta.lastModified, "5");
  // The PDF is content-addressed and uploaded once for both attempts.
  assert.equal(fake.puts.filter((p) => p.filename === `${ID}.pdf`).length, 1);
});

test("trashDocument keeps tablet changes made during a conflict", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  fake.beforeRootPut = async (n) => {
    if (n === 1) await fake.clientCommit(ID, { [`${ID}/p1.rm`]: "strokes-v2" });
  };
  await fake.cloud().trashDocument(ID);
  assert.equal(JSON.parse(fake.fileText(ID, `${ID}.metadata`)).parent, "trash");
  assert.equal(fake.fileText(ID, `${ID}/p1.rm`), "strokes-v2");
});

test("conflict on a different document reuses the prepared index", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  fake.beforeRootPut = async (n) => {
    if (n === 1) {
      await fake.clientCommit(OTHER, { [`${OTHER}/p9.rm`]: "other-strokes" });
    }
  };
  await fake.cloud().replacePdf(ID, enc.encode("new-pdf"), 1);
  assert.equal(fake.rootPuts, 2);
  assert.equal(fake.fileText(ID, `${ID}.pdf`), "new-pdf");
  assert.equal(fake.fileText(OTHER, `${OTHER}/p9.rm`), "other-strokes");
  // The document index is unchanged between attempts, so uploaded only once.
  const idx = fake.puts.filter((p) => p.filename === `${ID}.docSchema`);
  assert.equal(idx.length, 1);
});

test("five consecutive conflicts end in an error", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  let n = 0;
  fake.beforeRootPut = async () => {
    await fake.clientCommit(ID, { [`${ID}/p1.rm`]: `strokes-${++n}` });
  };
  await assert.rejects(
    fake.cloud().replacePdf(ID, enc.encode("new-pdf"), 1),
    (e) => e instanceof RemarkableError && /kept changing/.test(e.message),
  );
  assert.equal(fake.rootPuts, 5);
  // Nothing of ours was committed; the tablet's latest strokes remain.
  assert.equal(fake.fileText(ID, `${ID}.pdf`), "old-pdf");
  assert.equal(fake.fileText(ID, `${ID}/p1.rm`), "strokes-5");
});

test("document removed during a conflict is not resurrected", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  fake.beforeRootPut = async (n) => {
    if (n !== 1) return;
    const root = fake.rootEntries().filter((e) => e.id !== ID);
    fake.rootHash = await fake.store(serializeIndex(".", root));
    fake.generation++;
  };
  await assert.rejects(
    fake.cloud().replacePdf(ID, enc.encode("new-pdf"), 1),
    (e) => e instanceof RemarkableError && e.status === 404,
  );
  assert.ok(!fake.rootEntries().some((e) => e.id === ID));
});

test("uploadPdf uses a pre-generated id for every file of the document", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const NEW = "44444444-4444-4444-8444-444444444444";
  const uploaded = await fake
    .cloud()
    .uploadPdf("Fresh", enc.encode("fresh-pdf"), 3, "", NEW);
  assert.equal(uploaded.id, NEW);
  assert.equal(
    uploaded.hash,
    fake.rootEntries().find((e) => e.id === NEW)?.hash,
    "hash is that of the committed root entry",
  );
  assert.equal(fake.fileText(NEW, `${NEW}.pdf`), "fresh-pdf");
  assert.equal(
    JSON.parse(fake.fileText(NEW, `${NEW}.metadata`)).visibleName,
    "Fresh",
  );
});

test("uploadPdf generates an id when none is given", async () => {
  const fake = new FakeCloud();
  const { id } = await fake.cloud().uploadPdf("Fresh", enc.encode("pdf"), 1);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(fake.fileText(id, `${id}.pdf`), "pdf");
});

test("lost root response: the upload is not retried and sits under the pre-generated id", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const NEW = "44444444-4444-4444-8444-444444444444";
  fake.loseRootResponse = true;
  await assert.rejects(
    fake.cloud().uploadPdf("Fresh", enc.encode("fresh-pdf"), 1, "", NEW),
    TypeError,
  );
  // The server applied the commit exactly once; the caller, which recorded
  // NEW before calling, can find the entry on its next sync and adopt it
  // instead of uploading a second copy.
  assert.equal(fake.rootPuts, 1);
  const copies = fake.rootEntries().filter((e) => {
    const files = parseIndex(fake.text(e.hash)).entries;
    return files.some((f) => f.id.endsWith(".pdf"));
  });
  assert.equal(copies.filter((e) => e.id === NEW).length, 1);
  assert.equal(copies.length, 2);
});

test("lost root response: replacePdf then updates the adopted document", async () => {
  const fake = new FakeCloud();
  const NEW = "44444444-4444-4444-8444-444444444444";
  fake.loseRootResponse = true;
  await assert.rejects(
    fake.cloud().uploadPdf("Fresh", enc.encode("first"), 1, "", NEW),
  );
  fake.loseRootResponse = false;
  const cloud = fake.cloud();
  assert.ok(await cloud.findDocument(NEW), "entry is present in the root");
  await cloud.replacePdf(NEW, enc.encode("second"), 1);
  assert.equal(fake.fileText(NEW, `${NEW}.pdf`), "second");
  assert.equal(fake.rootEntries().length, 1);
});

const THIRD = "44444444-4444-4444-8444-444444444444";

test("listItems skips entries with missing or invalid metadata", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  // No metadata file at all.
  await fake.clientCommit(THIRD, { [`${THIRD}.content`]: "{}" });
  // Metadata blob that is not JSON.
  const BAD = "55555555-5555-4555-8555-555555555555";
  await fake.clientCommit(BAD, { [`${BAD}.metadata`]: "not json{" });
  // Metadata listed in the index but its blob is gone.
  const GONE = "66666666-6666-4666-8666-666666666666";
  await fake.clientCommit(GONE, { [`${GONE}.metadata`]: metadata("Gone") });
  const goneMeta = fake
    .docEntries(GONE)
    .find((e) => e.id === `${GONE}.metadata`);
  assert.ok(goneMeta);
  fake.blobs.delete(goneMeta.hash);

  const logs: string[] = [];
  const cloud = new RemarkableCloud({
    fetch: fake.fetch as unknown as typeof fetch,
    deviceToken: "unused",
    userToken: TOKEN,
    log: (m) => logs.push(m),
  });
  const items = await cloud.listItems();
  assert.deepEqual(items.map((i) => i.id).sort(), [ID, OTHER].sort());
  for (const id of [THIRD, BAD, GONE]) {
    assert.equal(
      logs.filter((m) => m.includes(id)).length,
      1,
      `${id} is logged as skipped`,
    );
  }
  assert.equal(logs.length, 3);
});

test("ensureFolder throws on an unreadable entry instead of creating a duplicate folder", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const HIDDEN = "88888888-8888-4888-8888-888888888888";
  await fake.clientCommit(HIDDEN, {
    [`${HIDDEN}.metadata`]: folderMeta(),
    [`${HIDDEN}.content`]: "{}",
  });
  const hiddenMeta = fake
    .docEntries(HIDDEN)
    .find((e) => e.id === `${HIDDEN}.metadata`);
  assert.ok(hiddenMeta);
  fake.blobs.delete(hiddenMeta.hash);
  const cloud = fake.cloud();

  // Tolerant listing hides it; strict listing and ensureFolder refuse.
  assert.ok(!(await cloud.listItems()).some((i) => i.id === HIDDEN));
  await assert.rejects(() => cloud.listItems({ strict: true }), /88888888/);
  const before = fake.rootEntries().length;
  await assert.rejects(() => cloud.ensureFolder("Zotero"), /unreadable/);
  assert.equal(fake.rootEntries().length, before, "no folder was created");

  // Once the entry is readable again the existing folder is found.
  fake.blobs.set(hiddenMeta.hash, enc.encode(folderMeta()));
  assert.equal(await fake.cloud().ensureFolder("Zotero"), HIDDEN);
});

const FOLDER = "77777777-7777-4777-8777-777777777777";
const folderMeta = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    visibleName: "Zotero",
    type: "CollectionType",
    parent: "",
    lastModified: "1",
    ...over,
  });

/** Resolve "Zotero" through the real cloud client and a cache holding FOLDER. */
async function resolveCached(fake: FakeCloud, cached = FOLDER) {
  const folders: Record<string, string> = { Zotero: cached };
  const cache = {
    getFolderId: (n: string) => folders[n],
    setFolderId: (n: string, id: string) => {
      folders[n] = id;
    },
  };
  const cloud = fake.cloud();
  const entries = new Map(
    (await cloud.getRootEntries(await cloud.getRoot())).map(
      (e) => [e.id, e] as const,
    ),
  );
  const before = fake.requests.length;
  const id = await resolveFolderId(
    cache,
    "Zotero",
    entries,
    (n) => cloud.ensureFolder(n),
    (fid) => {
      const e = entries.get(fid);
      return e ? cloud.readMetadata(e) : Promise.resolve(undefined);
    },
  );
  return { id, folders, requests: fake.requests.length - before };
}

test("resolveFolderId: a valid cached folder costs one docSchema and one metadata fetch, no listing", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  await fake.clientCommit(FOLDER, {
    [`${FOLDER}.metadata`]: folderMeta(),
    [`${FOLDER}.content`]: "{}",
  });
  const { id, requests } = await resolveCached(fake);
  assert.equal(id, FOLDER);
  assert.equal(requests, 2);
  assert.equal(fake.rootPuts, 0);
});

for (const [label, over] of [
  ["trashed", { parent: "trash" }],
  ["moved into another folder", { parent: OTHER }],
  ["renamed", { visibleName: "Renamed" }],
  ["marked deleted", { deleted: true }],
] as const) {
  test(`resolveFolderId: a cached folder that was ${label} on the tablet is not reused`, async () => {
    const fake = new FakeCloud();
    await seed(fake);
    await fake.clientCommit(FOLDER, {
      [`${FOLDER}.metadata`]: folderMeta(over),
      [`${FOLDER}.content`]: "{}",
    });
    const { id, folders } = await resolveCached(fake);
    assert.notEqual(id, FOLDER);
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(folders.Zotero, id);
    const meta = JSON.parse(fake.fileText(id, `${id}.metadata`));
    assert.equal(meta.visibleName, "Zotero");
    assert.equal(meta.type, "CollectionType");
    assert.equal(meta.parent, "");
  });
}

test("resolveFolderId: a trashed cached folder falls back to an existing live folder of that name", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const LIVE = "99999999-9999-4999-8999-999999999999";
  await fake.clientCommit(FOLDER, {
    [`${FOLDER}.metadata`]: folderMeta({ parent: "trash" }),
    [`${FOLDER}.content`]: "{}",
  });
  await fake.clientCommit(LIVE, {
    [`${LIVE}.metadata`]: folderMeta(),
    [`${LIVE}.content`]: "{}",
  });
  const { id, folders } = await resolveCached(fake);
  assert.equal(id, LIVE);
  assert.equal(folders.Zotero, LIVE);
});

test("resolveFolderId: a cached folder without readable metadata fails instead of creating a duplicate", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  await fake.clientCommit(FOLDER, { [`${FOLDER}.content`]: "{}" });
  const before = fake.rootEntries().length;
  await assert.rejects(() => resolveCached(fake), /unreadable library entry/);
  assert.equal(fake.rootEntries().length, before, "no folder was created");
});

test("resolveFolderId: a cached id missing from the root falls back to ensureFolder", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  await fake.clientCommit(FOLDER, {
    [`${FOLDER}.metadata`]: folderMeta(),
    [`${FOLDER}.content`]: "{}",
  });
  const { id, folders } = await resolveCached(
    fake,
    "88888888-8888-4888-8888-888888888888",
  );
  assert.equal(id, FOLDER);
  assert.equal(folders.Zotero, FOLDER);
});

test("resolveFolderId: no such folder at all creates and caches a new one", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const { id, folders } = await resolveCached(fake, "none");
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(folders.Zotero, id);
  assert.equal(
    JSON.parse(fake.fileText(id, `${id}.metadata`)).visibleName,
    "Zotero",
  );
});

test("listItems still propagates auth errors", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const real = fake.fetch;
  const cloud = new RemarkableCloud({
    fetch: (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      // The root index is readable; every document blob is refused.
      const blob = url.pathname.match(/^\/sync\/v3\/files\/(.+)$/)?.[1];
      if (
        url.pathname.startsWith("/token/") ||
        (blob && blob !== fake.rootHash)
      ) {
        return new Response("unauthorized", { status: 401 });
      }
      return real(input, init);
    }) as unknown as typeof fetch,
    deviceToken: "unused",
    userToken: TOKEN,
  });
  // The 401 triggers a token refresh, which also answers 401 here.
  await assert.rejects(
    () => cloud.listItems(),
    (e: unknown) => e instanceof RemarkableError && e.status === 401,
  );
});

test("pairDevice stores the token only after validation succeeds", async () => {
  const calls: string[] = [];
  await pairDevice({
    register: async () => "tok",
    validate: async (t) => {
      calls.push(`validate:${t}`);
    },
    store: (t) => calls.push(`store:${t}`),
  });
  assert.deepEqual(calls, ["validate:tok", "store:tok"]);
});

test("pairDevice does not store a token that fails validation", async () => {
  let stored = false;
  await assert.rejects(
    pairDevice({
      register: async () => "bad",
      validate: async () => {
        throw new RemarkableError("nope", 401);
      },
      store: () => {
        stored = true;
      },
    }),
    /nope/,
  );
  assert.equal(stored, false);
});

test("pairDevice does not validate or store when registration fails", async () => {
  let touched = false;
  await assert.rejects(
    pairDevice({
      register: async () => {
        throw new Error("bad code");
      },
      validate: async () => {
        touched = true;
      },
      store: () => {
        touched = true;
      },
    }),
    /bad code/,
  );
  assert.equal(touched, false);
});

test("index blobs are cached by hash; the root pointer is not", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const cloud = fake.cloud();
  const fileGets = () =>
    fake.requests.filter((r) => r.startsWith("/sync/v3/files/")).length;
  const rootGets = () =>
    fake.requests.filter((r) => r === "/sync/v4/root").length;

  const entry = await cloud.findDocument(ID);
  assert.ok(entry);
  assert.equal(fileGets(), 1);
  await cloud.findDocument(ID);
  await cloud.findDocument(OTHER);
  assert.equal(fileGets(), 1, "root index downloaded once");
  assert.equal(rootGets(), 3, "root pointer fetched every time");

  await cloud.getDocEntries(entry);
  await cloud.getDocEntries(entry);
  assert.equal(fileGets(), 2, "document index downloaded once");

  // A new root hash is a cache miss, so other clients' changes are seen.
  await fake.clientCommit(ID, { [`${ID}.metadata`]: metadata("Renamed") });
  const changed = await cloud.findDocument(ID);
  assert.ok(changed && changed.hash !== entry.hash);
  assert.equal(fileGets(), 3);
  assert.equal(
    (await cloud.getDocEntries(changed)).length,
    fake.docEntries(ID).length,
  );
});

test("a cached index is not mutated by callers", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const cloud = fake.cloud();
  const first = await cloud.getRootEntries(await cloud.getRoot());
  first.length = 0;
  const second = await cloud.getRootEntries(await cloud.getRoot());
  assert.equal(second.length, 2);
});

test("the index cache is bounded and evicts the least recently used", async () => {
  const fake = new FakeCloud();
  const cloud = fake.cloud();
  const fileGets = () =>
    fake.requests.filter((r) => r.startsWith("/sync/v3/files/")).length;
  const hashes: string[] = [];
  for (let i = 0; i < 300; i++) {
    hashes.push(await fake.store(serializeIndex(`doc${i}`, [])));
  }
  const get = (i: number) =>
    cloud.getDocEntries({ id: `doc${i}`, hash: hashes[i] });
  for (let i = 0; i < 300; i++) await get(i);
  assert.equal(fileGets(), 300);
  await get(299); // recent: cached
  assert.equal(fileGets(), 300);
  await get(0); // oldest: evicted
  assert.equal(fileGets(), 301);
});

test("getDocumentFiles refetches only pages whose blob changed", async () => {
  const fake = new FakeCloud();
  await clientCommitPages(fake, { p1: "strokes-1", p2: "strokes-2" });
  const cloud = fake.cloud();
  const rmGets = () => fake.rmGets;
  const first = await cloud.getDocumentFiles(ID);
  assert.ok(first);
  assert.equal(dec.decode(first.rm.get("p1")), "strokes-1");
  assert.equal(rmGets(), 2);

  await fake.clientCommit(ID, { [`${ID}/p2.rm`]: "strokes-2b" });
  const second = await cloud.getDocumentFiles(ID);
  assert.ok(second);
  assert.notEqual(second.hash, first.hash);
  assert.equal(dec.decode(second.rm.get("p1")), "strokes-1");
  assert.equal(dec.decode(second.rm.get("p2")), "strokes-2b");
  assert.equal(rmGets(), 3, "only the changed page was downloaded");
});

test("the page cache respects its byte cap and evicts least recently used", async () => {
  const fake = new FakeCloud();
  await clientCommitPages(fake, { a: "aaaa", b: "bbbb", c: "cccc" });
  const cloud = fake.cloud({ pageCacheBytes: 8 });
  await cloud.getDocumentFiles(ID); // 12 bytes through an 8-byte cache
  assert.equal(fake.rmGets, 3);
  await cloud.getDocumentFiles(ID);
  assert.equal(
    fake.rmGets - 3,
    1,
    "two pages fit in 8 bytes, one is refetched",
  );

  // A blob larger than the cap is never cached.
  const tiny = fake.cloud({ pageCacheBytes: 2 });
  const before = fake.rmGets;
  await tiny.getDocumentFiles(ID);
  await tiny.getDocumentFiles(ID);
  assert.equal(fake.rmGets - before, 6);
});

test("concurrent fetches of one page hash share a download and keep the cache size exact", async () => {
  const fake = new FakeCloud();
  // Two identical blank pages: one blob hash, two page ids.
  await clientCommitPages(fake, { a: "blank", b: "blank" });
  const cloud = fake.cloud({ pageCacheBytes: 20 });
  const size = () =>
    (cloud as unknown as { pageCache: { weight: number } }).pageCache.weight;
  const files = await cloud.getDocumentFiles(ID);
  assert.ok(files);
  assert.equal(fake.rmGets, 1, "one request for the shared blob");
  assert.equal(size(), 5);

  // Repeated syncs do not drift the counter or refetch.
  for (let i = 0; i < 5; i++) await cloud.getDocumentFiles(ID);
  assert.equal(fake.rmGets, 1);
  assert.equal(size(), 5);

  // Cold cache, concurrent callers of the same hash directly.
  const cold = fake.cloud({ pageCacheBytes: 20 });
  const [h] = fake.docEntries(ID).filter((e) => e.id.endsWith("a.rm"));
  const get = (
    cold as unknown as {
      getPageBlob(h: string, f: string): Promise<Uint8Array>;
    }
  ).getPageBlob.bind(cold);
  const before = fake.rmGets;
  await Promise.all([get(h.hash, h.id), get(h.hash, h.id), get(h.hash, h.id)]);
  assert.equal(fake.rmGets - before, 1);
  assert.equal(
    (cold as unknown as { pageCache: { weight: number } }).pageCache.weight,
    5,
  );
});

test("clearPageCache drops cached pages and their weight", async () => {
  const fake = new FakeCloud();
  await clientCommitPages(fake, { a: "aaaa", b: "bbbb" });
  const cloud = fake.cloud();
  const internals = cloud as unknown as {
    pageCache: { size: number; weight: number };
  };
  await cloud.getDocumentFiles(ID);
  assert.equal(fake.rmGets, 2);
  assert.equal(internals.pageCache.size, 2);
  assert.equal(internals.pageCache.weight, 8);

  cloud.clearPageCache();
  assert.equal(internals.pageCache.size, 0);
  assert.equal(internals.pageCache.weight, 0);

  // Still works afterwards: pages are downloaded and cached again.
  const files = await cloud.getDocumentFiles(ID);
  assert.ok(files);
  assert.equal(dec.decode(files.rm.get("a")), "aaaa");
  assert.equal(fake.rmGets, 4);
  assert.equal(internals.pageCache.weight, 8);
});

test("the metadata cache is bounded and evicts the least recently used", async () => {
  const fake = new FakeCloud();
  const cloud = fake.cloud();
  const internals = cloud as unknown as {
    metaCache: Map<string, unknown>;
    loadItem(e: { id: string; hash: string }): Promise<unknown>;
  };
  const total = META_CACHE_MAX + 5;
  const entries: { id: string; hash: string }[] = [];
  for (let i = 0; i < total; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    await fake.clientCommit(id, { [`${id}.metadata`]: metadata(`Doc ${i}`) });
  }
  for (const e of fake.rootEntries()) entries.push(e);
  const fileGets = () =>
    fake.requests.filter((r) => r.startsWith("/sync/v3/files/")).length;
  for (const e of entries) await internals.loadItem(e);
  assert.equal(internals.metaCache.size, META_CACHE_MAX);

  const before = fileGets();
  await internals.loadItem(entries[total - 1]); // recent: cached
  assert.equal(fileGets(), before);
  await internals.loadItem(entries[0]); // oldest: evicted, refetched
  assert.ok(fileGets() > before);
  assert.equal(internals.metaCache.size, META_CACHE_MAX);
});

async function clientCommitPages(
  fake: FakeCloud,
  pages: Record<string, string>,
) {
  await fake.clientCommit(ID, {
    [`${ID}.metadata`]: metadata("Paper"),
    [`${ID}.content`]: JSON.stringify({ pages: Object.keys(pages) }),
    ...Object.fromEntries(
      Object.entries(pages).map(([id, data]) => [`${ID}/${id}.rm`, data]),
    ),
  });
}

// Mirrors SyncEngine.push: the title handed to replacePdf comes from
// titleToPush, so only a Zotero-side title change can rename the document.
async function rebuild(
  fake: FakeCloud,
  pushedTitle: string | undefined,
  title: string,
) {
  await fake
    .cloud()
    .replacePdf(ID, enc.encode("rebuilt"), 1, titleToPush(pushedTitle, title));
}
const tabletName = (fake: FakeCloud) =>
  JSON.parse(fake.fileText(ID, `${ID}.metadata`)).visibleName;

test("titleToPush only returns a title that changed since the last push", () => {
  assert.equal(titleToPush("A", "A"), undefined);
  assert.equal(titleToPush("A", "B"), "B");
  // Synced before pushedTitle existed: never rename.
  assert.equal(titleToPush(undefined, "B"), undefined);
});

test("a PDF rebuild keeps a tablet-side rename while the Zotero title is unchanged", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  await fake.cloud().renameDocument(ID, "Renamed on tablet");
  await rebuild(fake, "Paper", "Paper");
  assert.equal(tabletName(fake), "Renamed on tablet");
  assert.equal(fake.fileText(ID, `${ID}.pdf`), "rebuilt");
});

test("a PDF rebuild renames the document after the Zotero title changed", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  await fake.cloud().renameDocument(ID, "Renamed on tablet");
  await rebuild(fake, "Paper", "New Zotero title");
  assert.equal(tabletName(fake), "New Zotero title");
});

test("a PDF rebuild without a recorded title does not overwrite the tablet name", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  await fake.cloud().renameDocument(ID, "Renamed on tablet");
  await rebuild(fake, undefined, "Zotero title");
  assert.equal(tabletName(fake), "Renamed on tablet");
});

test("getPageIds shows whether an updateDocument whose response was lost landed", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  const cloud = fake.cloud();
  assert.deepEqual([...((await cloud.getPageIds(ID)) ?? [])], ["p1"]);
  const content = { pageCount: 2, pages: ["p1", "p2"] };
  fake.loseRootResponse = true;
  await assert.rejects(
    cloud.updateDocument(ID, {
      pages: new Map([["p2", enc.encode("new-page")]]),
      content,
    }),
    (e) => e instanceof TypeError && !isTabletChangedError(e),
  );
  fake.loseRootResponse = false;
  assert.deepEqual([...((await cloud.getPageIds(ID)) ?? [])], ["p1", "p2"]);
  assert.equal(await cloud.getPageIds("missing"), undefined);
});

test("getPageIds does not show pages of an updateDocument refused as changed", async () => {
  const fake = new FakeCloud();
  await seed(fake);
  fake.beforeRootPut = async (n) => {
    if (n === 1) await fake.clientCommit(ID, { [`${ID}/p1.rm`]: "strokes-v2" });
  };
  const cloud = fake.cloud();
  await assert.rejects(
    cloud.updateDocument(ID, {
      pages: new Map([["p2", enc.encode("new-page")]]),
      content: { pageCount: 2, pages: ["p1", "p2"] },
    }),
    (e) => isTabletChangedError(e),
  );
  assert.deepEqual([...((await cloud.getPageIds(ID)) ?? [])], ["p1"]);
});
