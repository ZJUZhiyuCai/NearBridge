import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { createBridge } from "../src/server.mjs";
import {
  ensureCertificate,
  ensureNativeCertificate,
} from "../src/certificate.mjs";
import { parseShortcuts } from "../src/system.mjs";
import { safeFilename } from "../src/store.mjs";

let root, tls;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nearbridge-tests-"));
  tls = ensureCertificate(path.join(root, "certificates"), ["127.0.0.1"]);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  const clipboard = {
    value: "测试 Mac 剪贴板",
    writes: [],
    opened: [],
    shortcuts: [],
  };
  const system = {
    readClipboard: async () => clipboard.value,
    writeClipboard: async (text) => {
      clipboard.writes.push(text);
    },
    openInbox: async (value) => {
      clipboard.opened.push(value);
    },
    openURL: async (value) => {
      clipboard.opened.push(value);
    },
    listShortcuts: async () => [
      { id: "00112233-4455-6677-8899-aabbccddeeff", name: "测试工作流" },
    ],
    runShortcut: async (id) => {
      clipboard.shortcuts.push(id);
    },
  };
  const config = {
    dataDir: path.join(directory, "data"),
    inbox: path.join(directory, "inbox"),
    tls,
    addresses: [{ ip: "127.0.0.1", name: "test" }],
    system,
    ...extra,
  };
  const bridge = createBridge(config);
  const info = await bridge.start({
    port: 0,
    phonePort: 0,
    nativePhonePort: 0,
  });
  t.after(() => bridge.close());
  const urls = {
    mac: info.localURL,
    phone: `https://127.0.0.1:${info.phonePort}`,
  };
  async function request(
    role,
    route,
    { method = "GET", body, raw, headers = {}, cookie } = {},
  ) {
    const target = new URL(route, urls[role]);
    const data =
      raw ??
      (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
    return new Promise((resolve, reject) => {
      const transport = role === "phone" ? https : http;
      const req = transport.request(
        target,
        {
          method,
          ca: tls.cert,
          headers: {
            "X-NearBridge": "1",
            Origin: urls[role],
            ...(body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
            ...(data ? { "Content-Length": data.length } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (value) => chunks.push(value));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            let json;
            try {
              json = JSON.parse(buffer.toString());
            } catch {}
            resolve({
              status: res.statusCode,
              headers: res.headers,
              buffer,
              json,
            });
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  }
  async function pair() {
    const qr = await request("mac", "/api/pairing");
    const secret = new URLSearchParams(new URL(qr.json.url).hash.slice(1)).get(
      "pair",
    );
    const pending = await request("phone", "/api/pair", {
      method: "POST",
      body: { token: secret, name: "Mate 70 Pro+" },
    });
    assert.equal(pending.status, 202);
    const claim = pending.json;
    const approval = await request("mac", "/api/pair/approve", {
      method: "POST",
      body: { id: claim.id },
    });
    assert.equal(approval.status, 200);
    const result = await request("phone", `/api/pair/status?id=${claim.id}`, {
      headers: { "X-Pair-Claim": claim.claim },
    });
    assert.equal(result.json.status, "approved");
    assert.match(
      result.headers["set-cookie"][0],
      /HttpOnly; Secure; SameSite=Strict/,
    );
    return result.headers["set-cookie"][0].split(";")[0];
  }
  return { bridge, config, request, pair, clipboard, urls, info };
}

test("adversarial: Unicode filenames fit filesystem byte limits and preserve extensions", async (t) => {
  const { request } = await fixture(t);
  const name = "中文📷".repeat(40) + ".jpg";
  assert.ok(Buffer.byteLength(safeFilename(name)) <= 240);
  assert.ok(safeFilename(name).endsWith(".jpg"));
  const results = [];
  for (let i = 0; i < 2; i++) {
    const result = await request("mac", "/api/files", { method: "POST", raw: Buffer.from("test"),
      headers: { "X-File-Name": encodeURIComponent(name), "X-File-Size": "4" } });
    assert.equal(result.status, 201);
    assert.ok(Buffer.byteLength(result.json.item.name) <= 255);
    results.push(result.json.item.name);
  }
  assert.notEqual(results[0], results[1]);
});

test("changes: notifications wake immediately, idle replies omit history, stale revisions cannot miss changes", async (t) => {
  const { request, pair } = await fixture(t);
  const cookie = await pair();
  const initial = (await request("phone", "/api/state", { cookie })).json;
  assert.equal(typeof initial.revision, "string");
  const waiting = request("phone", `/api/changes?since=${initial.revision}&wait=1000`, { cookie });
  const item = (await request("mac", "/api/items", { method: "POST", body: { text: "wake up" } })).json.item;
  const changed = await waiting;
  assert.equal(changed.status, 200);
  assert.equal(changed.json.state.items[0].id, item.id);
  assert.notEqual(changed.json.revision, initial.revision);
  const idle = await request("phone", `/api/changes?since=${changed.json.revision}&wait=10`, { cookie });
  assert.equal(idle.status, 200);
  assert.equal(idle.json.state, undefined);
  assert.ok(idle.buffer.length < 128);
  assert.equal((await request("phone", `/api/changes?since=${initial.revision}`, { cookie })).json.state.items[0].id, item.id);
  assert.equal((await request("phone", "/api/changes?wait=999999", { cookie })).status, 400);
  assert.equal((await request("phone", "/api/changes?wait=NaN", { cookie })).status, 400);
  assert.equal((await request("phone", "/api/changes")).status, 401);
});

function mergeUpdate(previous, update) {
  if (update.state) return update.state;
  const { delta } = update;
  assert.equal(delta.baseRevision, previous.revision);
  const items = new Map(previous.items.map(item => [item.id, item]));
  delta.removed.forEach(id => items.delete(id));
  delta.state.items.forEach(item => items.set(item.id, item));
  const order = delta.order || previous.items.map(item => item.id);
  assert.equal(order.length, items.size);
  return { ...delta.state, items: order.map(id => { assert.ok(items.has(id)); return items.get(id); }) };
}

test("delta: missed updates, receipts, deletion and the 200-item window reconstruct the exact authorized snapshot", async (t) => {
  const { bridge, request, pair } = await fixture(t);
  const cookie = await pair();
  for (let i = 0; i < 202; i++) bridge.store.addText(`history-${i}-${"x".repeat(1024)}`, "mac", bridge.store.data.device.id);
  let previous = (await request("phone", "/api/state", { cookie })).json;
  const oldest = previous.items.at(-1).id;
  const first = (await request("mac", "/api/items", { method: "POST", body: { text: "first new item" } })).json.item;
  await request("mac", "/api/items", { method: "POST", body: { text: "second new item" } });
  let reply = await request("phone", `/api/changes?mode=delta-v1&since=${previous.revision}`, { cookie });
  assert.ok(reply.json.delta, "large unchanged histories must not be retransmitted");
  assert.equal(reply.json.delta.state.items.length, 2);
  assert.ok(reply.json.delta.removed.includes(oldest));
  assert.ok(reply.buffer.length < 15000);
  previous = mergeUpdate(previous, reply.json);
  assert.deepEqual(previous, (await request("phone", "/api/state", { cookie })).json);
  await request("phone", `/api/items/${first.id}/received`, { cookie, method: "POST", body: {} });
  reply = await request("phone", `/api/changes?mode=delta-v1&since=${previous.revision}`, { cookie });
  assert.equal(reply.json.delta.order, undefined, "unchanged order should cost no repeated ID list");
  assert.equal(reply.json.delta.state.items.length, 1);
  previous = mergeUpdate(previous, reply.json);
  await request("mac", `/api/items/${first.id}`, { method: "DELETE" });
  reply = await request("phone", `/api/changes?mode=delta-v1&since=${previous.revision}`, { cookie });
  previous = mergeUpdate(previous, reply.json);
  assert.deepEqual(previous, (await request("phone", "/api/state", { cookie })).json);
  assert.equal(previous.items.length, 200);
  assert.ok(!previous.items.some(item => item.id === first.id));
  assert.equal((await request("phone", "/api/changes?mode=delta-v1&since=unknown.1", { cookie })).json.delta, undefined);
  assert.ok((await request("phone", "/api/changes?since=unknown.1", { cookie })).json.state, "old clients retain the snapshot contract");
});

test("adversarial: repeated valid receipts do not write or wake state observers again", async (t) => {
  const { request, pair } = await fixture(t);
  const cookie = await pair();
  const item = (await request("mac", "/api/items", { method: "POST", body: { text: "once" } })).json.item;
  const receipt = () => request("phone", `/api/items/${item.id}/received`, { cookie, method: "POST", body: {} });
  await receipt();
  const before = (await request("phone", "/api/state", { cookie })).json;
  await receipt();
  const after = (await request("phone", "/api/state", { cookie })).json;
  assert.equal(after.revision, before.revision);
  assert.equal(after.items[0].receivedAt, before.items[0].receivedAt);
});

test("adversarial: a failed receipt commit is rolled back and a retry persists it", async t => {
  const { request, pair, bridge } = await fixture(t);
  const cookie = await pair();
  const item = (await request("mac", "/api/items", { method: "POST", body: { text: "commit the receipt" } })).json.item;
  const save = bridge.store.save.bind(bridge.store);
  bridge.store.save = () => { throw Object.assign(new Error("disk full"), { status: 507 }); };
  const receipt = () => request("phone", `/api/items/${item.id}/received`, { cookie, method: "POST", body: {} });
  assert.equal((await receipt()).status, 507);
  assert.equal(bridge.store.data.items[0].receivedAt, undefined, "a failed save must not create a false idempotency marker");
  bridge.store.save = save;
  assert.equal((await receipt()).status, 200);
  assert.ok(JSON.parse(fs.readFileSync(bridge.store.indexPath)).items[0].receivedAt);
});

test("adversarial: an offline pairing expiry invalidates the cached Mac snapshot", async t => {
  const { request, pair, bridge } = await fixture(t);
  await pair(); // No authenticated phone traffic: the paired device stays offline.
  const before = (await request("mac", "/api/state")).json;
  assert.equal(before.paired, true);
  assert.equal(before.device.connected, false);
  bridge.store.data.device.expiresAt = Date.now() + 20;
  const update = (await request("mac", `/api/changes?since=${before.revision}&wait=1500`)).json;
  assert.equal(update.state?.paired, false);
  assert.equal((await request("mac", "/api/state")).json.paired, false);
});

test("adversarial: revoking a device terminates an already streaming download", async (t) => {
  const { request, pair, bridge, urls } = await fixture(t);
  const cookie = await pair();
  const bytes = Buffer.alloc(16 * 1024 * 1024, 123);
  const temp = path.join(bridge.store.staging, `${randomUUID()}.part`);
  fs.writeFileSync(temp, bytes);
  const item = bridge.store.addFile(temp, { name: "slow-reader.bin", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), source: "mac", peerId: bridge.store.data.device.id });
  let response, received = 0, stopped = false;
  let firstChunk;
  const started = new Promise(resolve => { firstChunk = resolve; });
  const complete = new Promise((resolve, reject) => {
    const req = https.get(new URL(`/api/files/${item.id}`, urls.phone), { ca: tls.cert, headers: { Cookie: cookie } }, res => {
      response = res;
      res.on("data", chunk => { received += chunk.length; if (!stopped) { stopped = true; res.pause(); firstChunk(); } });
      res.on("error", () => resolve());
      res.on("end", resolve);
    });
    req.on("error", reject); t.after(() => req.destroy());
  });
  await started;
  await request("mac", "/api/device/revoke", { method: "POST", body: {} });
  response.resume();
  await complete;
  assert.ok(response.aborted, "an old authorized response must not remain readable after revocation");
  assert.ok(received < bytes.length);
});

test("adversarial: session rotation closes old SSE streams even when the device ID is retained", async (t) => {
  const { request, pair, urls, bridge } = await fixture(t);
  const cookie = await pair();
  const id = bridge.store.data.device.id;
  let stream;
  const opened = new Promise((resolve, reject) => {
    stream = https.get(new URL("/api/events", urls.phone), { ca: tls.cert, headers: { Cookie: cookie } }, res => {
      res.resume();
      const closed = new Promise(done => res.once("end", done));
      resolve(closed);
    });
    stream.on("error", reject);
  });
  // Do not assimilate the stream lifetime into the response-header promise.
  let ended = false;
  opened.then(() => { ended = true; });
  t.after(() => stream.destroy());
  await new Promise(resolve => setTimeout(resolve, 20));
  await request("mac", "/api/pairing/native", { method: "POST", body: {} });
  const token = new URL((await request("mac", "/api/pairing")).json.url).hash.split("=")[1];
  const claim = (await request("phone", "/api/pair", { method: "POST", body: { token, client: "harmony-native" } })).json;
  await request("mac", "/api/pair/approve", { method: "POST", body: { id: claim.id } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(bridge.store.data.device.id, id);
  assert.equal(ended, true, "rotated credentials must not retain an event subscription");
});

test("adversarial: observer connections are bounded and released on disconnect", async (t) => {
  const { urls } = await fixture(t);
  const streams = [];
  t.after(() => streams.forEach(req => req.destroy()));
  const open = () => new Promise((resolve, reject) => {
    const req = http.get(new URL("/api/events", urls.mac), res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); streams.push(req);
  });
  for (let i = 0; i < 8; i++) assert.equal(await open(), 200);
  assert.equal(await open(), 429);
  streams[0].destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await open(), 200);
});

test("adversarial: an expired QR cannot be claimed by slowly completing a request body", async (t) => {
  const { urls, request } = await fixture(t);
  const qr = (await request("mac", "/api/pairing")).json;
  const token = new URL(qr.url).hash.split("=")[1];
  const body = JSON.stringify({ token });
  let req;
  const response = new Promise((resolve, reject) => {
    req = https.request(new URL("/api/pair", urls.phone), {
      ca: tls.cert, method: "POST", headers: { "X-NearBridge": "1", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.write(body.slice(0, -1));
  });
  t.after(() => req.destroy());
  // A separate completed request acts as an event-loop barrier after the slow body.
  await request("phone", "/api/bootstrap");
  const clock = t.mock.method(Date, "now", () => qr.expiresAt + 1);
  try { req.end(body.slice(-1)); assert.equal(await response, 401); }
  finally { clock.mock.restore(); }
});

test("adversarial: waiting snapshots reauthorize on expiry and revocation", async (t) => {
  const { bridge, request, pair } = await fixture(t);
  const cookie = await pair();
  const state = (await request("phone", "/api/state", { cookie })).json;
  const waiting = request("phone", `/api/changes?since=${state.revision}&wait=1000`, { cookie });
  await request("mac", "/api/device/revoke", { method: "POST", body: {} });
  const revoked = await waiting;
  assert.equal(revoked.status, 401);
  assert.equal(revoked.json.state, undefined);
  const next = await pair();
  const nextState = (await request("phone", "/api/state", { cookie: next })).json;
  bridge.store.data.device.expiresAt = Date.now() + 20;
  const expired = await request("phone", `/api/changes?since=${nextState.revision}&wait=50`, { cookie: next });
  assert.equal(expired.status, 401);
  assert.equal(expired.json.state, undefined);
});

test("adversarial: clipboard latency cannot hide a committed text or bypass capacity", async (t) => {
  let releaseCopy;
  const copying = new Promise(resolve => { releaseCopy = resolve; });
  let startedCopy;
  const copyStarted = new Promise(resolve => { startedCopy = resolve; });
  const { request, pair, bridge } = await fixture(t, { system: {
    writeClipboard: async () => { startedCopy(); await copying; },
    readClipboard: async () => { bridge.store.data.items = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), kind: "text" })); return "clipboard"; },
  } });
  const cookie = await pair();
  await request("mac", "/api/settings", { method: "POST", body: { copyIncomingText: true } });
  await request("phone", "/api/state", { cookie });
  const state = (await request("mac", "/api/state")).json;
  const observation = request("mac", `/api/changes?since=${state.revision}&wait=1000`);
  const posted = request("phone", "/api/items", { cookie, method: "POST", body: { text: "visible before pbcopy completes" } });
  try {
    await copyStarted;
    const update = await observation;
    assert.equal(update.json.state?.items[0].text, "visible before pbcopy completes");
  } finally { releaseCopy(); await posted; }
  assert.equal((await request("mac", "/api/mac/clipboard/send", { method: "POST", body: {} })).status, 507);
  assert.equal(bridge.store.data.items.length, 1000);
});

test("unpaired phones cannot read data, upload files, or run Mac actions", async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request("phone", "/api/state")).status, 401);
  assert.equal(
    (
      await request("phone", "/api/items", {
        method: "POST",
        body: { text: "secret" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("phone", "/api/mac/clipboard/send", {
        method: "POST",
        body: {},
      })
    ).status,
    401,
  );
  assert.equal(
    (await request("phone", "/api/bootstrap")).json.authenticated,
    false,
  );
});

test("pairing requires Mac approval; refreshed and used QR tokens stop working", async (t) => {
  const { request } = await fixture(t);
  const original = (await request("mac", "/api/pairing")).json;
  const secret = new URL(original.url).hash.split("=")[1];
  await request("mac", "/api/pairing/refresh", { method: "POST", body: {} });
  assert.equal(
    (
      await request("phone", "/api/pair", {
        method: "POST",
        body: { token: secret },
      })
    ).status,
    401,
  );
  const fresh = (await request("mac", "/api/pairing")).json;
  const freshSecret = new URL(fresh.url).hash.split("=")[1];
  const claim = (
    await request("phone", "/api/pair", {
      method: "POST",
      body: { token: freshSecret, name: "测试手机" },
    })
  ).json;
  assert.equal((await request("phone", "/api/state")).status, 401);
  assert.equal(
    (
      await request("phone", `/api/pair/status?id=${claim.id}`, {
        headers: { "X-Pair-Claim": "wrong" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("phone", "/api/pair", {
        method: "POST",
        body: { token: freshSecret },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("phone", `/api/pair/status?id=${claim.id}`, {
        headers: { "X-Pair-Claim": claim.claim },
      })
    ).json.status,
    "pending",
  );
  await request("mac", "/api/pair/reject", {
    method: "POST",
    body: { id: claim.id },
  });
  assert.equal(
    (
      await request("phone", `/api/pair/status?id=${claim.id}`, {
        headers: { "X-Pair-Claim": claim.claim },
      })
    ).json.status,
    "rejected",
  );
});

test("text transfers both directions; clipboard is explicit and optional", async (t) => {
  const { request, pair, clipboard } = await fixture(t);
  await request("mac", "/api/items", {
    method: "POST",
    body: { text: "先存，之后配对" },
  });
  const cookie = await pair();
  let state = (await request("phone", "/api/state", { cookie })).json;
  assert.equal(state.items[0].text, "先存，之后配对");
  const payload =
    "中文、emoji 🐳\n<script>alert(1)</script>\n$(touch /tmp/not-a-command)";
  const phoneText = await request("phone", "/api/items", {
    cookie,
    method: "POST",
    body: { text: payload },
  });
  assert.equal(phoneText.status, 201);
  assert.deepEqual(clipboard.writes, []);
  assert.equal(
    (await request("mac", "/api/state")).json.items[0].text,
    payload,
  );
  await request("mac", "/api/mac/clipboard/copy", {
    method: "POST",
    body: { id: phoneText.json.item.id },
  });
  assert.deepEqual(clipboard.writes, [payload]);
  await request("mac", "/api/settings", {
    method: "POST",
    body: { copyIncomingText: true },
  });
  assert.equal(
    (
      await request("phone", "/api/items", {
        cookie,
        method: "POST",
        body: { text: "开启后复制" },
      })
    ).json.clipboardCopied,
    true,
  );
  assert.equal(clipboard.writes.at(-1), "开启后复制");
  await request("mac", "/api/mac/clipboard/send", { method: "POST", body: {} });
  state = (await request("phone", "/api/state", { cookie })).json;
  assert.equal(state.items[0].text, clipboard.value);
  assert.equal(state.settings, undefined);
  assert.equal(state.device.tokenHash, undefined);
  assert.equal(
    (
      await request("phone", "/api/mac/clipboard/send", {
        cookie,
        method: "POST",
        body: {},
      })
    ).status,
    403,
  );
});

test("binary files, Chinese names, empty files, and collision handling survive round trips", async (t) => {
  const { request, pair, bridge } = await fixture(t);
  const cookie = await pair();
  const data = Buffer.from(
    Array.from({ length: 100003 }, (_, index) => index % 256),
  );
  async function upload(role, name, content) {
    return request(role, "/api/files", {
      method: "POST",
      cookie,
      raw: content,
      headers: {
        "X-File-Name": encodeURIComponent(name),
        "X-File-Size": String(content.length),
      },
    });
  }
  const received = await upload("phone", "../../照片.jpg", data);
  assert.equal(received.status, 201);
  assert.equal(
    received.json.item.sha256,
    createHash("sha256").update(data).digest("hex"),
  );
  assert.equal(
    path.dirname(bridge.store.filePath(received.json.item)),
    bridge.store.inbox,
  );
  const download = await request("mac", `/api/files/${received.json.item.id}`);
  assert.deepEqual(download.buffer, data);
  assert.match(download.headers["content-disposition"], /attachment/);
  const second = await upload("phone", "../../照片.jpg", data);
  assert.notEqual(second.json.item.name, received.json.item.name);
  const outbound = await upload("mac", "中文文档.pdf", data);
  assert.equal(outbound.status, 201);
  assert.deepEqual(
    (await request("phone", `/api/files/${outbound.json.item.id}`, { cookie }))
      .buffer,
    data,
  );
  const empty = await upload("phone", "empty.txt", Buffer.alloc(0));
  assert.equal(empty.status, 201);
  assert.equal(empty.json.item.size, 0);
  assert.equal(fs.readdirSync(bridge.store.staging).length, 0);
});

test("upload limits and incomplete transfers never become completed files", async (t) => {
  const { request, pair, bridge } = await fixture(t, {
    maxFileSize: 8,
    maxStorage: 10,
  });
  const cookie = await pair();
  const send = (raw, size) =>
    request("phone", "/api/files", {
      cookie,
      method: "POST",
      raw: Buffer.from(raw),
      headers: { "X-File-Name": "test.bin", "X-File-Size": String(size) },
    });
  assert.equal((await send("123456789", 9)).status, 413);
  assert.equal((await send("123", 5)).status, 400);
  assert.equal(bridge.store.data.items.length, 0);
  assert.equal(fs.readdirSync(bridge.store.staging).length, 0);
  assert.equal((await send("123456", 6)).status, 201);
  assert.equal((await send("12345", 5)).status, 507);
  assert.equal(bridge.store.data.items.length, 1);
});

test("cross-site requests, hostile Host headers and non-http link commands are rejected", async (t) => {
  const { request, clipboard } = await fixture(t);
  assert.equal(
    (
      await request("mac", "/api/state", {
        headers: { Host: "evil.example:80" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("mac", "/api/items", {
        method: "POST",
        body: { text: "x" },
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("mac", "/api/state", { headers: { "X-NearBridge": "" } }))
      .status,
    403,
  );
  assert.equal(
    (await request("mac", "/api/items", { method: "POST", body: null })).status,
    400,
  );
  for (const text of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "shortcuts://run-shortcut?name=bad",
  ]) {
    const item = (
      await request("mac", "/api/items", { method: "POST", body: { text } })
    ).json.item;
    assert.equal(
      (
        await request("mac", "/api/mac/open-link", {
          method: "POST",
          body: { id: item.id },
        })
      ).status,
      400,
    );
  }
  assert.deepEqual(clipboard.opened, []);
  const item = (
    await request("mac", "/api/items", {
      method: "POST",
      body: { text: "https://example.com/path?q=中文" },
    })
  ).json.item;
  assert.equal(
    (
      await request("mac", "/api/mac/open-link", {
        method: "POST",
        body: { id: item.id },
      })
    ).status,
    200,
  );
  assert.equal(clipboard.opened.length, 1);
});

test("revoking a device immediately removes access; new phones cannot read its history", async (t) => {
  const { request, pair } = await fixture(t);
  const cookie = await pair();
  await request("phone", "/api/items", {
    cookie,
    method: "POST",
    body: { text: "旧手机内容" },
  });
  await request("mac", "/api/items", {
    method: "POST",
    body: { text: "仅给旧手机" },
  });
  await request("mac", "/api/device/revoke", { method: "POST", body: {} });
  assert.equal((await request("phone", "/api/state", { cookie })).status, 401);
  assert.equal(
    (
      await request("phone", "/api/items", {
        cookie,
        method: "POST",
        body: { text: "不能再写" },
      })
    ).status,
    401,
  );
  const newCookie = await pair();
  assert.equal(
    (await request("phone", "/api/state", { cookie: newCookie })).json.items
      .length,
    0,
  );
  assert.equal((await request("mac", "/api/state")).json.items.length, 2);
});

test("local history and paired sessions persist across a service restart", async (t) => {
  const { request, pair, bridge, config } = await fixture(t);
  const cookie = await pair();
  await request("phone", "/api/items", {
    cookie,
    method: "POST",
    body: { text: "重启后仍在" },
  });
  await bridge.close();
  const resumed = createBridge(config);
  const info = await resumed.start({ port: 0, phonePort: 0 });
  t.after(() => resumed.close());
  const data = await new Promise((resolve, reject) => {
    https
      .get(
        `https://127.0.0.1:${info.phonePort}/api/state`,
        { ca: tls.cert, headers: { "X-NearBridge": "1", Cookie: cookie } },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve(JSON.parse(body)));
        },
      )
      .on("error", reject);
  });
  assert.equal(data.items[0].text, "重启后仍在");
  const disk = fs.readFileSync(path.join(config.dataDir, "index.json"), "utf8");
  assert.ok(!disk.includes(cookie.split("=")[1]));
});

test("a duplicate launch cannot delete the running service upload staging", async (t) => {
  const { bridge, config, urls } = await fixture(t);
  const inFlight = path.join(bridge.store.staging, "1234-abcd.part");
  fs.writeFileSync(inFlight, "still uploading");
  const duplicate = createBridge(config);
  assert.ok(fs.existsSync(inFlight));
  await assert.rejects(
    duplicate.start({ port: Number(new URL(urls.mac).port), phonePort: 0 }),
    { code: "EADDRINUSE" },
  );
  assert.equal(fs.readFileSync(inFlight, "utf8"), "still uploading");
});

test("paired phone can trigger allowlisted workflows and a duplicate request executes only once", async (t) => {
  const { request, pair, clipboard } = await fixture(t);
  assert.equal(
    (
      await request("phone", "/api/workflows/open-inbox/run", {
        method: "POST",
        body: { requestId: "request-before-pairing" },
      })
    ).status,
    401,
  );
  const cookie = await pair();
  const run = () =>
    request("phone", "/api/workflows/open-inbox/run", {
      cookie,
      method: "POST",
      body: { requestId: "repeatable-request-001" },
    });
  const first = await run();
  assert.equal(first.status, 202);
  const again = await run();
  assert.equal(first.json.job.id, again.json.job.id);
  assert.equal(clipboard.opened.length, 1);
  const state = (await request("phone", "/api/state", { cookie })).json;
  assert.equal(state.jobs[0].status, "succeeded");
  assert.equal(
    (
      await request("phone", "/api/workflows/arbitrary-shell/run", {
        cookie,
        method: "POST",
        body: {
          requestId: "request-unknown-0001",
          command: "touch /tmp/never",
        },
      })
    ).status,
    403,
  );
});

test("save-note creates a real Markdown file from this phone text and reports missing input honestly", async (t) => {
  const { request, pair, bridge } = await fixture(t);
  const cookie = await pair();
  await request("phone", "/api/workflows/save-note/run", {
    cookie,
    method: "POST",
    body: { requestId: "missing-input-request" },
  });
  assert.equal(
    (await request("phone", "/api/state", { cookie })).json.jobs[0].status,
    "failed",
  );
  const text =
    "研究想法：让手机成为 Mac 工作流遥控器。\n- 拍照\n- 整理\n- 写入笔记";
  await request("phone", "/api/items", {
    cookie,
    method: "POST",
    body: { text },
  });
  await request("phone", "/api/workflows/save-note/run", {
    cookie,
    method: "POST",
    body: { requestId: "valid-note-request-01" },
  });
  const state = (await request("phone", "/api/state", { cookie })).json;
  assert.equal(state.jobs[0].status, "succeeded");
  const note = state.items.find((item) => item.kind === "file");
  assert.match(note.name, /^便签-.+\.md$/);
  assert.equal(
    fs.readFileSync(bridge.store.filePath(note), "utf8"),
    `${text}\n`,
  );
});

test("only Mac can register existing shortcuts; disabled workflows cannot be run", async (t) => {
  const { request, pair, clipboard } = await fixture(t);
  const cookie = await pair();
  const id = "00112233-4455-6677-8899-aabbccddeeff";
  assert.equal(
    (
      await request("phone", "/api/mac/workflows/shortcut", {
        cookie,
        method: "POST",
        body: { id },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("phone", "/api/mac/shortcuts", { cookie })).status,
    403,
  );
  assert.equal(
    (
      await request("mac", "/api/mac/workflows/shortcut", {
        method: "POST",
        body: { id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request("mac", "/api/mac/workflows/shortcut", {
        method: "POST",
        body: { id },
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await request("phone", `/api/workflows/shortcut-${id}/run`, {
        cookie,
        method: "POST",
        body: { requestId: "shortcut-run-request01" },
      })
    ).status,
    202,
  );
  assert.deepEqual(clipboard.shortcuts, [id]);
  const phoneState = (await request("phone", "/api/state", { cookie })).json;
  assert.equal(
    phoneState.workflows.find((item) => item.type === "shortcut").shortcutId,
    undefined,
  );
  await request("mac", "/api/mac/workflows/enable", {
    method: "POST",
    body: { id: `shortcut-${id}`, enabled: false },
  });
  assert.equal(
    (
      await request("phone", `/api/workflows/shortcut-${id}/run`, {
        cookie,
        method: "POST",
        body: { requestId: "shortcut-run-request02" },
      })
    ).status,
    403,
  );
  assert.equal(clipboard.shortcuts.length, 1);
});

test("workflow execution is serialized while idempotent retries still return the same job", async (t) => {
  let finish;
  let calls = 0;
  const hold = new Promise((resolve) => {
    finish = resolve;
  });
  const { request, pair } = await fixture(t, {
    system: {
      openInbox: async () => {
        calls++;
        await hold;
      },
    },
  });
  const cookie = await pair();
  const body = { requestId: "long-running-request01" };
  const first = await request("phone", "/api/workflows/open-inbox/run", {
    cookie,
    method: "POST",
    body,
  });
  const duplicate = await request("phone", "/api/workflows/open-inbox/run", {
    cookie,
    method: "POST",
    body,
  });
  assert.equal(first.json.job.id, duplicate.json.job.id);
  assert.equal(first.json.job.status, "running");
  assert.equal(calls, 1);
  assert.equal(
    (
      await request("phone", "/api/workflows/open-inbox/run", {
        cookie,
        method: "POST",
        body: { requestId: "second-running-request" },
      })
    ).status,
    409,
  );
  finish();
  assert.equal(
    (await request("phone", "/api/state", { cookie })).json.jobs[0].status,
    "succeeded",
  );
});

test("shortcut discovery parses identifiers without turning names into executable arguments", () => {
  assert.deepEqual(
    parseShortcuts(
      "研究工作台 (00112233-4455-6677-8899-AABBCCDDEEFF)\n$(touch never) (00112233-4455-6677-8899-aabbccddee00)\nnot a shortcut",
    ),
    [
      { name: "研究工作台", id: "00112233-4455-6677-8899-aabbccddeeff" },
      { name: "$(touch never)", id: "00112233-4455-6677-8899-aabbccddee00" },
    ],
  );
});

test("chunked transfers resume after restart, verify bytes, and complete exactly once", async (t) => {
  const f = await fixture(t);
  const cookie = await f.pair();
  const id = randomUUID();
  const input = Buffer.alloc(4 * 1024 * 1024 + 19);
  for (let i = 0; i < input.length; i++) input[i] = i % 251;
  const body = { id, name: "断点续传.bin", size: input.length };
  assert.equal(
    (
      await f.request("phone", "/api/transfers", {
        cookie,
        method: "POST",
        body,
      })
    ).json.offset,
    0,
  );
  const put = (offset, raw) =>
    f.request("phone", `/api/transfers/${id}?offset=${offset}`, {
      cookie,
      method: "PUT",
      raw,
    });
  assert.equal(
    (await put(0, input.subarray(0, 4 * 1024 * 1024))).json.offset,
    4 * 1024 * 1024,
  );
  assert.equal((await put(0, Buffer.from("duplicate"))).status, 409);
  assert.equal(
    (
      await f.request("phone", `/api/transfers/${id}/complete`, {
        cookie,
        method: "POST",
        body: {},
      })
    ).status,
    409,
  );
  await f.bridge.close();
  // Simulate an interrupted disk write after the last durable offset.
  fs.appendFileSync(
    path.join(f.config.dataDir, "transfers", `${id}.part`),
    "uncommitted",
  );
  const next = createBridge(f.config);
  const info = await next.start({ port: 0, phonePort: 0 });
  t.after(() => next.close());
  f.urls.mac = info.localURL;
  f.urls.phone = `https://127.0.0.1:${info.phonePort}`;
  const resumed = await f.request("phone", "/api/transfers", {
    cookie,
    method: "POST",
    body,
  });
  assert.equal(resumed.json.offset, 4 * 1024 * 1024);
  assert.equal(
    (await put(resumed.json.offset, input.subarray(resumed.json.offset)))
      .status,
    200,
  );
  const completed = await f.request("phone", `/api/transfers/${id}/complete`, {
    cookie,
    method: "POST",
    body: {},
  });
  assert.equal(completed.status, 200);
  assert.equal(
    completed.json.item.sha256,
    createHash("sha256").update(input).digest("hex"),
  );
  assert.deepEqual(
    fs.readFileSync(next.store.filePath(completed.json.item)),
    input,
  );
  const retried = await f.request("phone", "/api/transfers", {
    cookie,
    method: "POST",
    body,
  });
  assert.equal(retried.json.item.id, completed.json.item.id);
  assert.equal(
    (
      await f.request("phone", `/api/transfers/${id}/complete`, {
        cookie,
        method: "POST",
        body: {},
      })
    ).json.item.id,
    completed.json.item.id,
  );
  assert.equal(
    next.store.data.items.filter((item) => item.transferId === id).length,
    1,
  );
  assert.equal(
    (
      await f.request("phone", "/api/transfers", {
        cookie,
        method: "POST",
        body: { ...body, name: "不同文件.bin" },
      })
    ).status,
    409,
  );
});

test("resumable reservations enforce storage limits and cancellations release space", async (t) => {
  const { request, pair } = await fixture(t, {
    maxFileSize: 10,
    maxStorage: 10,
  });
  const cookie = await pair();
  const id = randomUUID();
  assert.equal(
    (
      await request("mac", "/api/transfers", {
        method: "POST",
        body: { id, name: "one", size: 8 },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("phone", "/api/transfers", {
        cookie,
        method: "POST",
        body: { id: randomUUID(), name: "two", size: 3 },
      })
    ).status,
    507,
  );
  assert.equal(
    (await request("phone", `/api/transfers/${id}`, { cookie })).status,
    404,
  );
  assert.equal(
    (
      await request("mac", `/api/transfers/${id}?offset=-1`, {
        method: "PUT",
        raw: Buffer.from("a"),
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("mac", `/api/transfers/${id}`, { method: "DELETE" })).status,
    200,
  );
  assert.equal(
    (
      await request("mac", "/api/transfers", {
        method: "POST",
        body: { id: randomUUID(), name: "max", size: 10 },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("mac", "/api/transfers", {
        method: "POST",
        body: { id: "../../escape", name: "bad", size: 0 },
      })
    ).status,
    400,
  );
});

test("revoking a phone releases its resumable uploads without exposing them to the next phone", async (t) => {
  const { request, pair } = await fixture(t, { maxFileSize: 10, maxStorage: 10 });
  const cookie = await pair();
  const id = randomUUID();
  assert.equal((await request("phone", "/api/transfers", { cookie, method: "POST", body: { id, name: "private", size: 10 } })).status, 200);
  assert.equal((await request("phone", `/api/transfers/${id}?offset=0`, { cookie, method: "PUT", raw: Buffer.from("123") })).status, 200);
  await request("mac", "/api/device/revoke", { method: "POST", body: {} });
  const next = await pair();
  assert.equal((await request("phone", `/api/transfers/${id}`, { cookie: next })).status, 404);
  assert.equal((await request("phone", `/api/transfers/${id}/complete`, { cookie, method: "POST", body: {} })).status, 401);
  assert.equal((await request("phone", "/api/transfers", { cookie: next, method: "POST", body: { id: randomUUID(), name: "new", size: 10 } })).status, 200);
});

test("native pairing migrates the same device only after approval and supports bearer auth", async (t) => {
  const { request, pair, bridge } = await fixture(t);
  const oldCookie = await pair();
  const oldID = bridge.store.data.device.id;
  await request("phone", "/api/items", {
    cookie: oldCookie,
    method: "POST",
    body: { text: "保留的收件记录" },
  });
  assert.equal(
    (
      await request("phone", "/api/pairing/native", {
        cookie: oldCookie,
        method: "POST",
        body: {},
      })
    ).status,
    403,
  );
  const qr = await request("mac", "/api/pairing/native", {
    method: "POST",
    body: {},
  });
  assert.equal(qr.status, 200);
  assert.match(qr.json.qr, /^data:image\/png;base64,/);
  const secret = new URL(
    (await request("mac", "/api/pairing")).json.url,
  ).hash.split("=")[1];
  const claim = (
    await request("phone", "/api/pair", {
      method: "POST",
      body: { token: secret, client: "harmony-native", name: "Mate 70 Pro+" },
    })
  ).json;
  const headers = { "X-Pair-Claim": claim.claim };
  assert.equal(
    (await request("phone", `/api/pair/status?id=${claim.id}`, { headers }))
      .json.session,
    undefined,
  );
  assert.equal(
    (await request("phone", "/api/state", { cookie: oldCookie })).status,
    200,
  );
  await request("mac", "/api/pair/approve", {
    method: "POST",
    body: { id: claim.id },
  });
  const result = await request("phone", `/api/pair/status?id=${claim.id}`, {
    headers,
  });
  const bearer = { Authorization: `Bearer ${result.json.session}` };
  assert.equal(bridge.store.data.device.id, oldID);
  assert.equal(
    (await request("phone", "/api/state", { cookie: oldCookie })).status,
    401,
  );
  const native = await request("phone", "/api/state", { headers: bearer });
  assert.equal(native.status, 200);
  assert.equal(native.json.items[0].text, "保留的收件记录");
  assert.equal(
    (
      await request("phone", "/api/mac/clipboard/send", {
        method: "POST",
        body: {},
        headers: bearer,
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("mac", "/api/state")).json.device.connected,
    true,
  );
  assert.equal(
    JSON.stringify(bridge.store.data).includes(result.json.session),
    false,
  );
});

test("download ranges and receipt checks distinguish staging from phone delivery", async (t) => {
  const { request, pair } = await fixture(t);
  const cookie = await pair();
  const input = Buffer.from("0123456789中文");
  const item = (
    await request("mac", "/api/files", {
      method: "POST",
      raw: input,
      headers: { "X-File-Name": "range.bin", "X-File-Size": input.length },
    })
  ).json.item;
  assert.equal(item.receivedAt, undefined);
  assert.equal(
    (
      await request("phone", `/api/items/${item.id}/received`, {
        cookie,
        method: "POST",
        body: { sha256: "wrong" },
      })
    ).status,
    409,
  );
  const response = await request("phone", `/api/files/${item.id}`, {
    cookie,
    headers: { Range: "bytes=3-8" },
  });
  assert.equal(response.status, 206);
  assert.deepEqual(response.buffer, input.subarray(3, 9));
  assert.equal(response.headers["content-range"], `bytes 3-8/${input.length}`);
  assert.equal(
    (
      await request("phone", `/api/files/${item.id}`, {
        cookie,
        headers: { Range: "bytes=3-" },
      })
    ).buffer.toString(),
    input.subarray(3).toString(),
  );
  assert.equal(
    (
      await request("phone", `/api/files/${item.id}`, {
        cookie,
        headers: { Range: "bytes=99-100" },
      })
    ).status,
    416,
  );
  assert.equal(
    (
      await request("phone", `/api/items/${item.id}/received`, {
        cookie,
        method: "POST",
        body: { sha256: item.sha256 },
      })
    ).status,
    200,
  );
  const first = (await request("mac", "/api/state")).json.items[0];
  assert.ok(first.receivedAt);
  assert.ok(first.localPath);
  assert.equal(
    (await request("phone", "/api/state", { cookie })).json.items[0].localPath,
    undefined,
  );
  await request("phone", `/api/items/${item.id}/received`, {
    cookie,
    method: "POST",
    body: { sha256: item.sha256 },
  });
  assert.equal(
    (await request("mac", "/api/state")).json.items[0].receivedAt,
    first.receivedAt,
  );
});

test("native TLS renews IP coverage while retaining the CA and pinned public key", async (t) => {
  const directory = fs.mkdtempSync(path.join(root, "native-cert-"));
  const first = ensureNativeCertificate(directory, ["127.0.0.1"]);
  const renewed = ensureNativeCertificate(directory, [
    "127.0.0.1",
    "192.168.88.2",
  ]);
  assert.deepEqual(first.ca, renewed.ca);
  assert.deepEqual(first.key, renewed.key);
  const leaf = new X509Certificate(renewed.cert);
  assert.ok(leaf.checkIP("192.168.88.2"));
  assert.ok(leaf.verify(new X509Certificate(renewed.ca).publicKey));
  const f = await fixture(t, { nativeTls: renewed });
  // Native and browser listeners coexist without replacing the browser cert.
  assert.equal((await f.request("phone", "/health")).status, 200);
  const health = (ca) =>
    new Promise((resolve, reject) => {
      https
        .get(`https://127.0.0.1:${f.info.nativePort}/health`, { ca }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve(JSON.parse(Buffer.concat(chunks).toString())),
          );
        })
        .on("error", reject);
    });
  assert.equal((await health(renewed.ca)).app, "NearBridge");
  await assert.rejects(health(tls.cert));
  f.bridge.updateNativeTLS(
    ensureNativeCertificate(directory, ["127.0.0.1", "192.168.99.2"]),
  );
  assert.equal((await health(first.ca)).app, "NearBridge");
});

test("Bluetooth-style byte relay retains TLS identity and never grants loopback admin access", async (t) => {
  const nativeTls = ensureNativeCertificate(path.join(root, "relay-certificate"), ["127.0.0.1"]);
  const f = await fixture(t, { nativeTls });
  const peers = new Set();
  const relay = net.createServer((client) => {
    const upstream = net.connect(f.info.nativePort, "127.0.0.1");
    for (const socket of [client, upstream]) {
      peers.add(socket);
      socket.on("close", () => peers.delete(socket));
      socket.on("error", () => { client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of peers) socket.destroy();
    await new Promise((resolve) => relay.close(resolve));
  });
  const request = (route, { session = "", method = "GET", ca = nativeTls.ca } = {}) => new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "127.0.0.1", port: relay.address().port, path: route, method, ca, agent: false,
      headers: { Host: `127.0.0.1:${f.info.nativePort}`, "X-NearBridge": "1", ...(session ? { Authorization: `Bearer ${session}` } : {}) },
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end();
  });
  assert.equal(await request("/health"), 200);
  await assert.rejects(request("/health", { ca: tls.cert }));
  assert.equal(await request("/api/state"), 401);
  const session = (await f.pair()).slice("nearbridge=".length);
  assert.equal(await request("/api/state", { session }), 200);
  assert.equal(await request("/api/mac/clipboard/send", { session, method: "POST" }), 403);
  assert.equal(f.clipboard.writes.length, 0);
});

test("reliable text endpoints deduplicate lost replies, deleted items and clipboard side effects", async t => {
  const { request, pair, clipboard } = await fixture(t);
  const cookie = await pair();
  await request("mac", "/api/settings", { method: "POST", body: { copyIncomingText: true } });
  const body = { requestId: randomUUID(), requestedAt: Date.now(), text: "可靠发送" };
  const first = await request("phone", "/api/actions/text", { method: "POST", body, cookie });
  assert.equal(first.status, 201);
  const duplicate = await request("phone", "/api/actions/text", { method: "POST", body, cookie });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.item.id, first.json.item.id);
  assert.deepEqual(clipboard.writes, ["可靠发送"]);
  await request("mac", `/api/items/${first.json.item.id}`, { method: "DELETE" });
  const deleted = await request("phone", "/api/actions/text", { method: "POST", body, cookie });
  assert.equal(deleted.json.accepted, true);
  assert.equal(deleted.json.item, null, "retry must not recreate a deliberately deleted item");
  assert.equal((await request("phone", "/api/state", { cookie })).json.items.length, 0);
  assert.equal((await request("phone", "/api/actions/text", { method: "POST", cookie, body: { ...body, text: "different" } })).status, 409);
  assert.equal((await request("phone", "/api/actions/text", { method: "POST", cookie, body: { text: "missing identity" } })).status, 400);
});

test("reliable workflows return the same accepted job and enforce target binding on Mac retries", async t => {
  const { request, pair, clipboard, bridge } = await fixture(t);
  const cookie = await pair();
  const body = { requestId: randomUUID(), requestedAt: Date.now() };
  const path = "/api/actions/workflows/open-inbox/run";
  const first = await request("phone", path, { method: "POST", body, cookie });
  const second = await request("phone", path, { method: "POST", body, cookie });
  assert.equal(first.status, 202);
  assert.equal(second.json.job.id, first.json.job.id);
  assert.equal(clipboard.opened.length, 1);
  assert.equal((await request("phone", path, { method: "POST", cookie, body: { requestId: randomUUID() } })).status, 400);
  const mac = { requestId: randomUUID(), requestedAt: Date.now(), text: "old target", peerId: bridge.store.data.device.id };
  assert.equal((await request("mac", "/api/actions/text", { method: "POST", body: mac })).status, 201);
  await request("mac", "/api/device/revoke", { method: "POST" });
  // An already accepted request is still acknowledged, but an unaccepted old
  // request must never be delivered to a newly selected phone.
  assert.equal((await request("mac", "/api/actions/text", { method: "POST", body: mac })).status, 200);
  assert.equal((await request("mac", "/api/actions/text", { method: "POST", body: { ...mac, requestId: randomUUID() } })).status, 409);
  assert.equal((await request("mac", path, { method: "POST", body: { ...mac, requestId: randomUUID() } })).status, 409);
  const state = (await request("mac", "/api/state")).json;
  assert.equal(state.capabilities.reliableActions, 1);
  assert.equal(state.actionReceipts, undefined, "receipt ledger is not part of the public history feed");
});

test("desktop file reveal resolves stored IDs and never accepts a phone-supplied path", async t => {
  const { request, pair, clipboard, config } = await fixture(t);
  const cookie = await pair();
  const upload = await request("phone", "/api/files", { cookie, method: "POST", raw: Buffer.from("safe"),
    headers: { "X-File-Name": encodeURIComponent("手机文件.txt"), "X-File-Size": "4" } });
  assert.equal(upload.status, 201);
  const body = { id: upload.json.item.id };
  assert.equal((await request("phone", "/api/mac/reveal-file", { cookie, method: "POST", body })).status, 403);
  assert.equal((await request("mac", "/api/mac/reveal-file", { method: "POST", body: { id: "../arbitrary" } })).status, 404);
  assert.deepEqual(clipboard.opened, []);
  assert.equal((await request("mac", "/api/mac/reveal-file", { method: "POST", body })).status, 200);
  assert.deepEqual(clipboard.opened, [config.inbox]);
});

test("native desktop pairing can select a reachable address on a multihomed Windows host", async t => {
  const addresses = [{ name: "virtual", ip: "192.168.50.1" }, { name: "Wi-Fi", ip: "192.168.20.5" }];
  const { request, pair, info } = await fixture(t, { addresses });
  const cookie = await pair();
  const native = await request("mac", "/api/pairing/native?ip=192.168.20.5", { method: "POST", body: {} });
  assert.equal(native.status, 200);
  assert.equal(native.json.url, `https://192.168.20.5:${info.nativePort || info.phonePort}`);
  assert.match(native.json.qr, /^data:image\/png;base64,/);
  assert.equal((await request("phone", "/api/pairing/native", { cookie, method: "POST", body: {} })).status, 403);
});
