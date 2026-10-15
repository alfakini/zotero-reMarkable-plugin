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
