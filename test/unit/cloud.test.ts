import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type IndexEntry,
  parseIndex,
  isTabletChangedError,
  RemarkableCloud,
  RemarkableError,
  serializeIndex,
} from "../../src/remarkable/cloud";
import { sha256Hex } from "../../src/remarkable/hash";

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

  fetch = async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
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
      const blob = this.blobs.get(m[1]);
      return blob
        ? new Response(blob as BodyInit, { status: 200 })
        : new Response("not found", { status: 404 });
    }
    return new Response(`unexpected ${url.pathname}`, { status: 500 });
  };

  cloud() {
    return new RemarkableCloud({
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
