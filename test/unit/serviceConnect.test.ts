/**
 * Connecting registers the device, validates the token against the cloud and
 * only then stores it, so a bad code or a rejected token never leaves the
 * plugin looking connected.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { RemarkableService } from "../../src/service";

let prefs: Map<string, unknown>;
let requests: string[];
let responses: Record<string, { status: number; body: string }>;
let setPrefCalls: string[];

beforeEach(() => {
  prefs = new Map();
  requests = [];
  setPrefCalls = [];
  responses = {
    "/token/json/2/device/new": { status: 200, body: "device-token\n" },
    "/token/json/2/user/new": { status: 200, body: "user-token" },
  };
  const g = globalThis as Record<string, unknown>;
  g.Zotero = {
    Prefs: {
      get: (k: string) => prefs.get(k),
      set: (k: string, v: unknown) => {
        setPrefCalls.push(k);
        prefs.set(k, v);
      },
    },
    DataDirectory: { dir: "/data" },
    debug() {},
  };
  g.PathUtils = { join: (...p: string[]) => p.join("/") };
  g.fetch = async (url: string) => {
    const path = new URL(url).pathname;
    requests.push(path);
    const r = responses[path];
    return new Response(r.body, { status: r.status });
  };
});

const tokenPref = "extensions.zotero.zoteroremarkable.deviceToken";

test("a valid code registers, validates, then stores the token", async () => {
  const service = new RemarkableService();
  await service.connect("abcdefgh");
  assert.deepEqual(requests, [
    "/token/json/2/device/new",
    "/token/json/2/user/new",
  ]);
  assert.equal(prefs.get(tokenPref), "device-token");
  assert.equal(service.connected, true);
  assert.ok(setPrefCalls.lastIndexOf(tokenPref) > -1);
});

test("a token the cloud rejects is never stored", async () => {
  responses["/token/json/2/user/new"] = { status: 401, body: "no" };
  const service = new RemarkableService();
  await assert.rejects(service.connect("abcdefgh"), /Could not authenticate/);
  assert.equal(prefs.get(tokenPref), undefined);
  assert.equal(service.connected, false);
  assert.ok(!setPrefCalls.includes(tokenPref));
});

test("a failed registration neither validates nor stores", async () => {
  responses["/token/json/2/device/new"] = { status: 400, body: "bad code" };
  const service = new RemarkableService();
  await assert.rejects(service.connect("abcdefgh"), /Pairing failed/);
  assert.deepEqual(requests, ["/token/json/2/device/new"]);
  assert.equal(service.connected, false);
});
