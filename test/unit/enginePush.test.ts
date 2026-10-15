import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FakeTablet,
  STATE_PATH,
  diskState,
  fakeAttachment,
  installGlobals,
  makeEngine,
  makePdf,
  makeState,
  memoryIO,
} from "./engineHarness";

const LIB = 1;
const ATT = "ATTKEY01";
const KEY = `${LIB}/${ATT}`;
const PATH = "/library/paper.pdf";

async function setup(pages = 2) {
  const z = installGlobals();
  z.files.set(PATH, await makePdf(pages));
  const io = memoryIO();
  const tablet = new FakeTablet();
  const title = { value: "Paper" };
  const att = fakeAttachment({ key: ATT, path: PATH, title });
  /** A fresh engine over the same disk, like a restart of Zotero. */
  const boot = async () => {
    const state = makeState(io);
    await state.load();
    return { state, engine: makeEngine({ cloud: tablet.cloud(), state }) };
  };
  return { z, io, tablet, title, att, boot };
}

test("the new document id is on disk before the root commit, and the next sync adopts it", async () => {
  const { io, tablet, att, boot } = await setup();
  // The server applies the commit but the response is lost.
  let onDiskAtCommit: Record<string, unknown> | undefined;
  tablet.afterUploadCommit = (id) => {
    onDiskAtCommit = diskState(io).docs[KEY];
    assert.equal(onDiskAtCommit?.rmDocId, id);
    throw new Error("response lost");
  };
  const first = await boot();
  const report = await first.engine.sync([att]);
  assert.equal(report.uploaded, 0);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /response lost/);

  assert.deepEqual([...tablet.docs.keys()].length, 1);
  const [rmDocId] = [...tablet.docs.keys()];
  // Persisted by the time uploadPdf ran, without a fingerprint, so the
  // document cannot be mistaken for an up-to-date one.
  assert.ok(onDiskAtCommit, "state was saved before the commit");
  assert.equal(onDiskAtCommit.rmDocId, rmDocId);
  assert.equal(onDiskAtCommit.uploadedFingerprint, undefined);
  const afterFailure = diskState(io).docs[KEY];
  assert.equal(afterFailure.rmDocId, rmDocId);
  assert.equal(afterFailure.uploadedFingerprint, undefined);

  // Next sync (a new engine reading the state file): adopt, replace the PDF,
  // never upload a second copy.
  tablet.afterUploadCommit = undefined;
  const second = await boot();
  const report2 = await second.engine.sync([att]);
  assert.deepEqual(report2.errors, []);
  assert.equal(report2.uploaded, 0);
  assert.equal(report2.updated, 1);
  assert.equal(tablet.count("upload:"), 1);
  assert.equal(tablet.count(`replace:${rmDocId}`), 1);
  assert.deepEqual([...tablet.docs.keys()], [rmDocId]);
  const doc = diskState(io).docs[KEY];
  assert.equal(doc.rmDocId, rmDocId);
  assert.ok(doc.uploadedFingerprint, "fingerprint recorded once replaced");
  assert.equal(doc.pushedTitle, "Paper");
});

test("a successful upload records the id the tablet received", async () => {
  const { io, tablet, att, boot } = await setup();
  const { engine } = await boot();
  const report = await engine.sync([att]);
  assert.equal(report.uploaded, 1);
  const [rmDocId] = [...tablet.docs.keys()];
  const doc = diskState(io).docs[KEY];
  assert.equal(doc.rmDocId, rmDocId);
  assert.ok(doc.uploadedFingerprint);
  assert.ok(io.files.has(STATE_PATH));
  // Nothing changed: the next sync does nothing on the tablet.
  const again = await (await boot()).engine.sync([att]);
  assert.equal(again.uploaded + again.updated, 0);
  assert.equal(tablet.calls.length, 1);
});

test("a title change with an unchanged PDF only renames the tablet document", async () => {
  const { io, tablet, title, att, boot } = await setup();
  await (await boot()).engine.sync([att]);
  const [rmDocId] = [...tablet.docs.keys()];
  assert.equal(tablet.docs.get(rmDocId)?.name, "Paper");
  const pdfBefore = tablet.docs.get(rmDocId)?.pdf;

  title.value = "Paper (renamed)";
  const { state, engine } = await boot();
  const report = await engine.sync([att]);
  assert.deepEqual(report.errors, []);
  assert.equal(report.uploaded + report.updated, 0);
  assert.equal(tablet.count("upload:"), 1);
  assert.equal(tablet.count("replace:"), 0);
  assert.equal(tablet.count("rename:"), 1);
  assert.equal(tablet.docs.get(rmDocId)?.name, "Paper (renamed)");
  assert.equal(tablet.docs.get(rmDocId)?.pdf, pdfBefore, "PDF untouched");
  const doc = state.get(LIB, ATT);
  assert.equal(doc?.pushedTitle, "Paper (renamed)");
  // The hash advanced with the rename, so the next sync does not pull.
  assert.equal(doc?.rmDocHash, tablet.docs.get(rmDocId)?.hash);
  assert.equal(diskState(io).docs[KEY].pushedTitle, "Paper (renamed)");

  const again = await (await boot()).engine.sync([att]);
  assert.equal(again.uploaded + again.updated, 0);
  assert.equal(tablet.count("rename:"), 1, "renamed only once");
});

test("without a recorded title only the title is recorded; the tablet name is kept", async () => {
  const { io, tablet, title, att, boot } = await setup();
  await (await boot()).engine.sync([att]);
  const [rmDocId] = [...tablet.docs.keys()];
  // Synced before pushedTitle existed, then renamed on the tablet.
  const disk = diskState(io);
  delete disk.docs[KEY].pushedTitle;
  io.files.set(STATE_PATH, JSON.stringify(disk));
  tablet.docs.get(rmDocId)!.name = "Renamed on tablet";

  title.value = "Paper (new)";
  const { state, engine } = await boot();
  await engine.sync([att]);
  assert.equal(tablet.count("rename:"), 0);
  assert.equal(tablet.docs.get(rmDocId)?.name, "Renamed on tablet");
  assert.equal(state.get(LIB, ATT)?.pushedTitle, "Paper (new)");
});

test("a changed page count uploads a new document under a persisted id and trashes the old one", async () => {
  const { z, io, tablet, att, boot } = await setup(2);
  await (await boot()).engine.sync([att]);
  const [oldId] = [...tablet.docs.keys()];

  z.files.set(PATH, await makePdf(3));
  let persisted: Record<string, unknown> | undefined;
  tablet.afterUploadCommit = () => {
    persisted = diskState(io).docs[KEY];
  };
  const report = await (await boot()).engine.sync([att]);
  assert.equal(report.uploaded, 1);
  assert.deepEqual(report.errors, []);
  assert.equal(tablet.count(`trash:${oldId}`), 1);
  const [newId] = [...tablet.docs.keys()];
  assert.notEqual(newId, oldId);
  assert.equal(persisted?.rmDocId, newId);
  assert.equal(persisted?.uploadedFingerprint, undefined);
  assert.equal(diskState(io).docs[KEY].rmDocId, newId);
});
