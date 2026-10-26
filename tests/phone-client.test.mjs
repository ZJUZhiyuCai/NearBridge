import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as module from "node:module";
import vm from "node:vm";
import { createHash } from "node:crypto";

// Exercise the actual non-UI ArkTS client with in-memory platform adapters.
// No phone, real filesystem, Bluetooth radio or network is used.
function fixture(respond, bluetooth = false, fileSize = 0) {
  const root = "/sandbox/nearbridge";
  const pair = { name: "Test Mac", url: "https://192.168.1.2:53320", session: "test-session", certificate: "test", publicKeyHash: "test-pin" };
  const files = new Map([
    [`${root}/paired.json`, JSON.stringify(pair)],
    [`${root}/root.pem`, "old-root"],
    [`${root}/bluetooth.json`, JSON.stringify({ enabled: bluetooth, id: "11:22:33:44:55:66", name: "Test Mac", transport: "ble-v1" })],
  ]);
  const storage = new Map();
  const requests = [];
  let bluetoothConnections = 0;
  let destroyedRequests = 0;
  const fileIO = {
    OpenMode: { CREATE: 1, READ_WRITE: 2, TRUNC: 4, READ_ONLY: 8 },
    accessSync: (path) => path === root || files.has(path),
    mkdirSync(path) { files.set(path, ""); },
    readTextSync(path) { if (!files.has(path)) throw new Error("missing"); return files.get(path); },
    openSync(path, mode) { if (mode & 1 && !files.has(path)) files.set(path, Buffer.alloc(0)); return { fd: path }; },
    statSync: (path) => ({ size: files.has(path) ? Buffer.byteLength(files.get(path)) : fileSize, mtime: 123 }),
    readSync: (_fd, buffer) => buffer.byteLength,
    writeSync(fd, value, options) {
      if (typeof value === "string") { files.set(fd, value); return value.length; }
      const data = Buffer.from(value), offset = options?.offset || 0;
      const old = Buffer.from(files.get(fd) || []), next = Buffer.alloc(Math.max(old.length, offset + data.length));
      old.copy(next); data.copy(next, offset); files.set(fd, next); return data.length;
    },
    unlinkSync(path) { files.delete(path); },
    truncateSync(path, length) { files.set(path, Buffer.from(files.get(path)).subarray(0, length)); },
    fsyncSync() {}, closeSync() {},
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
  const context = vm.createContext({
    AppStorage: { setOrCreate: (key, value) => storage.set(key, value), get: (key) => storage.get(key) },
    fs: fileIO,
    http: {
      RequestMethod: { GET: "GET", POST: "POST", PUT: "PUT" }, HttpDataType: { ARRAY_BUFFER: 1 },
      createHttp: () => {
        let cancel;
        const aborted = new Promise((_, reject) => { cancel = reject; });
        return { async request(url, options) {
          requests.push({ url, options });
          const body = await Promise.race([respond(url, options), aborted]);
          if (body && typeof body.responseCode === "number") return body;
          return { responseCode: 200, result: new TextEncoder().encode(JSON.stringify(body)).buffer };
        }, destroy() { destroyedRequests++; cancel(new Error("HTTP task destroyed")); } };
      },
    },
    util: { TextDecoder: class { decodeToString(bytes) { return new TextDecoder().decode(bytes); } }, generateRandomUUID: () => "00000000-0000-4000-8000-000000000001" },
    BluetoothTunnel: {
      shared: { async ensure() { bluetoothConnections++; }, stop() {}, retry() {} },
      trace() {}, lastError: "",
    },
    BLUETOOTH_URL: "https://127.0.0.1:53320",
    window: { getLastWindow: async () => ({ setWindowKeepScreenOn: async () => {} }) },
    hash: { hash: async (path) => createHash("sha256").update(Buffer.from(files.get(path) || [])).digest("hex").toUpperCase() },
    mdns: { createDiscoveryService: () => ({ on() {}, startSearchingMDNS() {}, stopSearchingMDNS() {} }) },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, Uint8Array, ArrayBuffer,
  });
  const source = fs.readFileSync(new URL("../harmony/entry/src/main/ets/core/BridgeClient.ets", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export class BridgeClient", "class BridgeClient");
  const Client = new vm.Script(module.stripTypeScriptTypes(source) + "\nBridgeClient;").runInContext(context);
  const client = new Client();
  client.init({ filesDir: "/sandbox" });
  return { client, storage, files, requests, fileIO, get bluetoothConnections() { return bluetoothConnections; }, get destroyedRequests() { return destroyedRequests; } };
}

const qr = JSON.stringify({ protocol: "nearbridge", version: 2, name: "New Mac", url: "https://192.168.1.3:53320", token: "a".repeat(43), certificate: "A".repeat(400), publicKeyHash: "A".repeat(43) + "=" });
const skip = typeof module.stripTypeScriptTypes !== "function" ? "Requires Node 22.13+ for native TypeScript stripping" : false;

test("pairing a new Mac while BLE is selected uses the QR address, then LAN", { skip }, async () => {
  const f = fixture(async (url) => url.includes("/status?") ? { status: "approved", session: "new-session" } : { id: "pair-id", claim: "claim" }, true);
  f.client.refresh = async () => {};
  await f.client.pair(qr);
  assert.equal(f.bluetoothConnections, 0);
  assert.ok(f.requests.every((request) => request.url.startsWith("https://192.168.1.3:53320/")));
  assert.equal(f.storage.get("useBluetooth"), false);
  assert.equal(f.storage.get("macName"), "New Mac");
  f.client.stop();
});

test("failed re-pairing restores the previous Mac and Bluetooth choice", { skip }, async () => {
  const f = fixture(async () => { throw new Error("New Mac unreachable"); }, true);
  f.client.refresh = async () => {};
  await assert.rejects(() => f.client.pair(qr));
  assert.equal(f.storage.get("useBluetooth"), true);
  assert.equal(f.storage.get("macName"), "Test Mac");
  assert.equal(f.files.get("/sandbox/nearbridge/root.pem"), "old-root");
  assert.equal(JSON.parse(f.files.get("/sandbox/nearbridge/paired.json")).session, "test-session");
  f.client.stop();
});

test("a failed old refresh cannot overwrite the status after switching transports", { skip }, async () => {
  const f = fixture(async () => ({}), true);
  const rejects = [];
  f.client.refresh = () => new Promise((_, reject) => { rejects.push(reject); });
  f.client.start();
  f.client.useLocalNetwork();
  const current = f.storage.get("status");
  rejects[0](new Error("old Bluetooth connection closed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.storage.get("status"), current);
  assert.equal(f.storage.get("linkPhase"), "connecting");
  f.client.stop();
});

for (const action of ["sendText", "runWorkflow"]) {
  test(`${action}: a committed action remains successful when the following refresh fails`, { skip }, async () => {
    const f = fixture(async (_url, options) => {
      if (options.method === "GET") throw new Error("connection lost after success");
      return { ok: true };
    });
    await assert.doesNotReject(() => f.client[action]("test"));
    assert.equal(f.requests.filter((request) => request.options.method === "POST").length, 1);
    assert.equal(f.storage.get("linkPhase"), "offline");
  });
}

test("a committed file leaves the outgoing queue even if the receipt refresh is offline", { skip }, async () => {
  const f = fixture(async (url, options) => {
    if (options.method === "GET") throw new Error("offline after file commit");
    if (url.endsWith("/api/transfers")) return { id: "transfer", offset: 0, size: 0, chunkSize: 65536 };
    return { ok: true };
  });
  await assert.doesNotReject(() => f.client.sendFile("file://test-empty", "test-empty.bin"));
  assert.equal(f.storage.get("outgoingCount"), 0);
  assert.equal(f.storage.get("progress"), "test-empty.bin 已存入 Mac");
  assert.equal(f.storage.get("progressFraction"), -1);
  assert.equal(f.storage.get("transferPhase"), "completed");
  assert.equal(f.requests.filter((request) => request.url.endsWith("/complete")).length, 1);
});

test("pausing an upload keeps it queued and ends the progress indicator without committing", { skip }, async () => {
  let enteredChunk;
  const inChunk = new Promise((resolve) => { enteredChunk = resolve; });
  let finishChunk;
  const chunkResult = new Promise((resolve) => { finishChunk = resolve; });
  const f = fixture(async (_url, options) => {
    if (options.method === "PUT") { enteredChunk(); return chunkResult; }
    return { id: "transfer", offset: 0, size: 8, chunkSize: 8 };
  }, false, 8);
  const upload = f.client.sendFile("file://test-pause", "test-pause.bin");
  await inChunk;
  assert.equal(f.storage.get("transferPhase"), "sending");
  f.client.pauseSending();
  finishChunk({ offset: 8 });
  await assert.rejects(upload, /发送已暂停/);
  assert.equal(f.storage.get("outgoingCount"), 1);
  assert.equal(f.storage.get("transferPhase"), "paused");
  assert.equal(f.storage.get("progressFraction"), -1);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/complete")).length, 0);
});

test("stopping the phone cancels pending HTTP immediately and a new foreground sync is not blocked", { skip }, async () => {
  const f = fixture(async () => new Promise(() => {}));
  f.client.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1);
  f.client.stop();
  f.client.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.destroyedRequests, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.storage.get("linkPhase"), "connecting");
  f.client.stop();
});

test("out-of-order state snapshots cannot roll back an already observed revision", { skip }, async () => {
  const resolvers = [];
  const f = fixture(async () => new Promise(resolve => resolvers.push(resolve)));
  const first = f.client.refresh(), second = f.client.refresh();
  const state = { name: "Mac", items: [], workflows: [], jobs: [] };
  resolvers[1]({ ...state, revision: "boot.12", name: "new" }); await second;
  resolvers[0]({ ...state, revision: "boot.11", name: "old" }); await first;
  assert.equal(JSON.parse(f.storage.get("stateJSON")).name, "new");
});

test("a foreground action with an active revision does not wait for a redundant full snapshot", { skip }, async () => {
  const f = fixture(async (url) => url.endsWith("/api/state") ? { revision: "boot.1", items: [], workflows: [], jobs: [] } : {});
  await f.client.refresh();
  f.client.active = true;
  await f.client.sendText("fast");
  assert.deepEqual(f.requests.map(request => new URL(request.url).pathname), ["/api/state", "/api/items"]);
  f.client.stop();
});

test("changes polling sends a revision and keeps history when the heartbeat has no snapshot", { skip }, async () => {
  let finish;
  const f = fixture(async url => url.includes("/api/changes") ? new Promise(resolve => { finish = resolve; }) :
    { revision: "boot.7", name: "Mac", items: [], workflows: [], jobs: [] });
  await f.client.refresh();
  f.client.start();
  assert.match(f.requests[1].url, /\/api\/changes\?since=boot.7&mode=delta-v1$/);
  const previous = f.storage.get("stateJSON");
  finish({ revision: "boot.7" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.storage.get("stateJSON"), previous);
  assert.equal(f.storage.get("linkPhase"), "online");
  f.client.stop();
});

test("phone delta application preserves unchanged text, applies receipts, removes records and restores order", { skip }, async () => {
  const original = { revision: "boot.1", name: "Mac", items: [
    { id: "a", kind: "text", source: "mac", text: "preserve me", createdAt: "test" },
    { id: "b", kind: "text", source: "mac", text: "delete me", createdAt: "test" }
  ], workflows: [], jobs: [] };
  const f = fixture(async () => original);
  await f.client.refresh();
  f.client.applyUpdate({ revision: "boot.3", delta: { baseRevision: "boot.1", removed: ["b"], order: ["c", "a"],
    state: { ...original, revision: "boot.3", items: [{ id: "c", kind: "text", source: "mac", text: "new", createdAt: "test" }], jobs: [{ id: "job", status: "succeeded" }] } } });
  let state = JSON.parse(f.storage.get("stateJSON"));
  assert.deepEqual(state.items.map(item => item.id), ["c", "a"]);
  assert.equal(state.items[1].text, "preserve me");
  assert.equal(state.jobs[0].status, "succeeded");
  const prior = f.storage.get("stateJSON");
  f.client.applyUpdate({ revision: "boot.2", delta: { baseRevision: "boot.1" } });
  assert.equal(f.storage.get("stateJSON"), prior, "a late older delta must not overwrite a newer snapshot");
  f.client.applyUpdate({ revision: "boot.4", delta: { baseRevision: "boot.3", removed: [],
    state: { ...state, revision: "boot.4", items: [{ ...state.items[1], receivedAt: "now" }] } } });
  state = JSON.parse(f.storage.get("stateJSON"));
  assert.deepEqual(state.items.map(item => item.id), ["c", "a"]);
  assert.equal(state.items[1].receivedAt, "now");
});

test("phone rejects incomplete or stale-base deltas atomically and can bootstrap after a failed sync", { skip }, async () => {
  const original = { revision: "boot.1", name: "Mac", items: [{ id: "a", text: "keep" }], workflows: [], jobs: [] };
  const f = fixture(async () => original);
  await f.client.refresh();
  const before = f.storage.get("stateJSON");
  const next = { ...original, revision: "boot.2", items: [] };
  for (const delta of [
    { baseRevision: "wrong", state: next, removed: [] },
    { baseRevision: "boot.1", state: next, removed: [], order: ["missing"] },
    { baseRevision: "boot.1", state: next, removed: [], order: ["a", "a"] },
    { baseRevision: "boot.1", state: next, removed: ["missing"] },
  ]) {
    assert.throws(() => f.client.applyUpdate({ revision: "boot.2", delta }));
    assert.equal(f.storage.get("stateJSON"), before);
    assert.equal(f.client.revision, "boot.1");
  }
  f.client.json = async () => ({ revision: "boot.2", delta: { baseRevision: "lost", state: next, removed: [] } });
  f.client.discover = () => {}; // This test targets merge recovery, not mDNS timers.
  f.client.active = true;
  await f.client.tick();
  assert.equal(f.client.revision, "", "a failed merge must trigger a full bootstrap on retry");
  f.client.stop();
});

const payload = Buffer.from("verified phone file");
const receivedItem = { id: "11111111-2222-4333-8444-555555555555", kind: "file", source: "mac", name: "sample.bin",
  size: payload.length, sha256: createHash("sha256").update(payload).digest("hex"), createdAt: "test" };
const fileResponse = () => ({ responseCode: 206, result: Uint8Array.from(payload).buffer });

test("simultaneous manual and automatic receives share one download and one receipt", { skip }, async () => {
  let finish;
  const f = fixture(async url => url.includes("/api/files/") ? new Promise(resolve => { finish = resolve; }) : {});
  f.client.active = true;
  const first = f.client.receive(receivedItem), second = f.client.receive(receivedItem);
  finish(fileResponse());
  await Promise.all([first, second]);
  assert.equal(f.requests.filter(request => request.url.includes("/api/files/")).length, 1);
  assert.equal(f.requests.filter(request => request.url.endsWith("/received")).length, 1);
  assert.equal(f.storage.get("transferPhase"), "completed");
  assert.deepEqual(f.files.get(f.client.savedPath(receivedItem.id)), payload);
  f.client.stop();
});

test("a lost receipt leaves the verified file intact and retry does not download it again", { skip }, async () => {
  let failReceipt = true;
  const f = fixture(async url => {
    if (url.includes("/api/files/")) return fileResponse();
    if (failReceipt) throw new Error("receipt connection lost");
    return {};
  });
  f.client.active = true;
  await assert.rejects(f.client.receive(receivedItem), /receipt connection lost/);
  assert.equal(f.storage.get("transferPhase"), "paused");
  assert.deepEqual(f.files.get(f.client.savedPath(receivedItem.id)), payload);
  failReceipt = false;
  await f.client.receive(receivedItem);
  assert.equal(f.storage.get("transferPhase"), "completed");
  assert.equal(f.requests.filter(request => request.url.includes("/api/files/")).length, 1);
  f.client.stop();
});

test("zero-byte filesystem writes fail instead of spinning forever or issuing a false receipt", { skip }, async () => {
  const f = fixture(async () => fileResponse());
  f.fileIO.writeSync = () => 0;
  f.client.active = true;
  await assert.rejects(f.client.receive(receivedItem), /存储写入中断/);
  assert.equal(f.requests.filter(request => request.url.endsWith("/received")).length, 0);
  assert.equal(f.storage.get("transferPhase"), "failed");
  f.client.stop();
});

test("a blocked file download cannot block a workflow state notification", { skip }, async () => {
  let notification;
  const initial = { revision: "boot.1", name: "Mac", items: [receivedItem], workflows: [], jobs: [] };
  const f = fixture(async url => {
    if (url.includes("/api/changes")) return new Promise(resolve => { notification = resolve; });
    if (url.includes("/api/files/")) return new Promise(() => {});
    return initial;
  });
  try {
    f.client.start();
    for (let i = 0; !notification && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(notification, "notification request must start while the file is blocked");
    assert.equal(f.requests.filter(request => request.url.includes("/api/files/")).length, 1);
    notification({ revision: "boot.2", state: { ...initial, revision: "boot.2", jobs: [{ id: "job", status: "succeeded" }] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(f.storage.get("stateJSON")).jobs[0].status, "succeeded");
  } finally { f.client.stop(); }
});
