// Isolated application-level latency probe. No personal data or radio is used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createBridge } from "../src/server.mjs";
import { ensureCertificate } from "../src/certificate.mjs";

const reliable = process.argv.includes("--reliable");
const mode = process.argv.includes("--poll") ? "poll" : "changes";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nearbridge-bench-"));
const tls = ensureCertificate(path.join(directory, "certificates"), ["127.0.0.1"]);
const bridge = createBridge({ dataDir: path.join(directory, "data"), inbox: path.join(directory, "inbox"),
  tls, addresses: [{ ip: "127.0.0.1" }], system: {
    readClipboard: async () => "", writeClipboard: async () => {}, openInbox: async () => {},
    openURL: async () => {}, listShortcuts: async () => [], runShortcut: async () => {},
  } });
const agents = { mac: new http.Agent({ keepAlive: true }), phone: new https.Agent({ keepAlive: true, ca: tls.cert }) };
const bytes = { mac: 0, phone: 0 };
let urls, cookie;
function request(role, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = (role === "mac" ? http : https).request(new URL(route, urls[role]), {
      agent: agents[role], method: data ? "POST" : "GET",
      headers: { "X-NearBridge": "1", ...(cookie && role === "phone" ? { Cookie: cookie } : {}),
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const parts = [];
      res.on("data", (part) => { parts.push(part); bytes[role] += part.length; });
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(parts)}`));
        resolve({ data: JSON.parse(Buffer.concat(parts)), headers: res.headers });
      });
    });
    req.on("error", reject); req.end(data);
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.map(v => Number(v.toFixed(2))), p50: Number(sorted[Math.ceil(sorted.length * .5) - 1].toFixed(2)),
    p95: Number(sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2)) };
};
try {
  const info = await bridge.start({ port: 0, phonePort: 0 });
  urls = { mac: info.localURL, phone: `https://127.0.0.1:${info.phonePort}` };
  const qr = (await request("mac", "/api/pairing")).data;
  const token = new URL(qr.url).hash.split("=")[1];
  const claim = (await request("phone", "/api/pair", { token })).data;
  await request("mac", "/api/pair/approve", { id: claim.id });
  const approved = await request("phone", `/api/pair/status?id=${claim.id}`, undefined, { "X-Pair-Claim": claim.claim });
  cookie = approved.headers["set-cookie"][0].split(";")[0];
  // A representative synthetic history makes repeated snapshot overhead visible.
  for (let i = 0; i < 50; i++) bridge.store.addText(`fixture ${i}: ${"x".repeat(1024)}`, "mac", bridge.store.data.device.id);
  const intervals = { mac: 2000, phone: 3000 };
  const result = { mode, reliableActions: reliable, node: process.version, platform: `${process.platform}/${process.arch}`,
    transport: "loopback HTTP (Mac), verified HTTPS (phone); no BLE radio", observedAt: new Date().toISOString(), latencyMs: {}, acknowledgementMs: {} };
  for (const role of ["mac", "phone"]) {
    const latencies = [], acknowledgements = [];
    for (const phase of [.1, .5, .9, .1, .5, .9]) {
      const state = (await request(role, "/api/state")).data;
      if (mode === "changes" && !state.revision) throw new Error("Server does not support changes; use --poll for the baseline");
      let observed;
      const tickStart = performance.now();
      const observation = mode === "poll"
        ? sleep(intervals[role]).then(() => request(role, "/api/state")).then(reply => { observed = performance.now(); return reply.data; })
        : request(role, `/api/changes?since=${encodeURIComponent(state.revision)}`).then(reply => { observed = performance.now(); return reply.data.state; });
      await sleep(mode === "poll" ? intervals[role] * phase : 20);
      const sent = performance.now();
      const body = { text: `probe-${role}-${tickStart}`, ...(reliable ? { requestId: randomUUID(), requestedAt: Date.now(), peerId: bridge.store.data.device.id } : {}) };
      const item = (await request("mac", reliable ? "/api/actions/text" : "/api/items", body)).data.item;
      acknowledgements.push(performance.now() - sent);
      const snapshot = await observation;
      if (!snapshot?.items.some(value => value.id === item.id)) throw new Error("Observation missed the committed item");
      latencies.push(observed - sent);
    }
    result.latencyMs[role] = stats(latencies);
    result.acknowledgementMs[role] = stats(acknowledgements);
  }
  const state = (await request("phone", "/api/state")).data;
  const snapshotBytes = Buffer.byteLength(JSON.stringify(state));
  result.idleBodyBytesPerMinute = mode === "poll" ? snapshotBytes * 20 : null;
  if (mode === "changes") {
    const before = bytes.phone;
    await request("phone", `/api/changes?since=${encodeURIComponent(state.revision)}&wait=50`);
    result.idleBodyBytesPerMinute = (bytes.phone - before) * 60000 / 25000;
  }
  result.idleNote = "Body-only extrapolation from a fixed synthetic history; excludes HTTP/TLS/BLE framing. Poll phases: 10%, 50%, 90%, repeated twice.";
  console.log(JSON.stringify(result, null, 2));
} finally {
  Object.values(agents).forEach(agent => agent.destroy());
  await bridge.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
