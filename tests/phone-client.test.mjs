import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as module from "node:module";
import vm from "node:vm";

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
  const fileIO = {
    OpenMode: { CREATE: 1, READ_WRITE: 2, TRUNC: 4, READ_ONLY: 8 },
    accessSync: (path) => path === root || files.has(path),
    mkdirSync() {},
    readTextSync(path) { if (!files.has(path)) throw new Error("missing"); return files.get(path); },
    openSync: (path) => ({ fd: path }),
    statSync: () => ({ size: fileSize, mtime: 123 }),
    readSync: (_fd, buffer) => buffer.byteLength,
    writeSync(fd, value) { files.set(fd, value); return value.length; },
    fsyncSync() {}, closeSync() {},
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
  const context = vm.createContext({
    AppStorage: { setOrCreate: (key, value) => storage.set(key, value), get: (key) => storage.get(key) },
    fs: fileIO,
    http: {
      RequestMethod: { GET: "GET", POST: "POST", PUT: "PUT" }, HttpDataType: { ARRAY_BUFFER: 1 },
      createHttp: () => ({
        async request(url, options) {
          requests.push({ url, options });
          const body = await respond(url, options);
          return { responseCode: 200, result: new TextEncoder().encode(JSON.stringify(body)).buffer };
        }, destroy() {},
      }),
    },
    util: { TextDecoder: class { decodeToString(bytes) { return new TextDecoder().decode(bytes); } }, generateRandomUUID: () => "00000000-0000-4000-8000-000000000001" },
    BluetoothTunnel: {
      shared: { async ensure() { bluetoothConnections++; }, stop() {}, retry() {} },
      trace() {}, lastError: "",
    },
    BLUETOOTH_URL: "https://127.0.0.1:53320",
    window: { getLastWindow: async () => ({ setWindowKeepScreenOn: async () => {} }) },
    mdns: { createDiscoveryService: () => ({ on() {}, startSearchingMDNS() {}, stopSearchingMDNS() {} }) },
    setInterval: () => 1, clearInterval() {}, setTimeout, Uint8Array, ArrayBuffer,
  });
  const source = fs.readFileSync(new URL("../harmony/entry/src/main/ets/core/BridgeClient.ets", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export class BridgeClient", "class BridgeClient");
  const Client = new vm.Script(module.stripTypeScriptTypes(source) + "\nBridgeClient;").runInContext(context);
  const client = new Client();
  client.init({ filesDir: "/sandbox" });
  return { client, storage, files, requests, get bluetoothConnections() { return bluetoothConnections; } };
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
  let rejectRefresh;
  f.client.refresh = () => new Promise((_, reject) => { rejectRefresh = reject; });
  f.client.start();
  f.client.useLocalNetwork();
  const current = f.storage.get("status");
  rejectRefresh(new Error("old Bluetooth connection closed"));
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
