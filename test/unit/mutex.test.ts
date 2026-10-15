import assert from "node:assert/strict";
import { test } from "node:test";
import { Mutex } from "../../src/sync/mutex";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("mutex runs callbacks one at a time in call order", async () => {
  const m = new Mutex();
  const log: string[] = [];
  const gate = deferred();
  const a = m.run(async () => {
    log.push("a start");
    await gate.promise;
    log.push("a end");
  });
  const b = m.run(async () => {
    log.push("b start");
    log.push("b end");
  });
  const c = m.run(async () => {
    log.push("c");
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log, ["a start"]);
  assert.equal(m.locked, true);
  gate.resolve();
  await Promise.all([a, b, c]);
  assert.deepEqual(log, ["a start", "a end", "b start", "b end", "c"]);
  assert.equal(m.locked, false);
});

test("mutex releases the lock when a callback throws", async () => {
  const m = new Mutex();
  const failing = m.run(async () => {
    throw new Error("boom");
  });
  const next = m.run(async () => "ok");
  await assert.rejects(failing, /boom/);
  assert.equal(await next, "ok");
  assert.equal(m.locked, false);
});

test("mutex returns the callback result", async () => {
  const m = new Mutex();
  assert.equal(await m.run(async () => 42), 42);
});
