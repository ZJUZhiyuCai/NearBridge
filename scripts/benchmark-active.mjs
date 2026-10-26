// Reproducible active-sync payload comparison on an isolated local TLS service.
// Uses synthetic history and inert OS adapters; never touches the personal app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createBridge } from "../src/server.mjs";
import { ensureCertificate } from "../src/certificate.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nearbridge-active-bench-"));
const tls = ensureCertificate(path.join(directory, "certificates"), ["127.0.0.1"]);
const bridge = createBridge({ dataDir: path.join(directory, "data"), inbox: path.join(directory, "inbox"),
  tls, addresses: [{ ip: "127.0.0.1" }], system: {
    readClipboard: async () => "", writeClipboard: async () => {}, openInbox: async () => {},
    openURL: async () => {}, listShortcuts: async () => [], runShortcut: async () => {},
  } });
const agents = { mac: new http.Agent({ keepAlive: true }), phone: new https.Agent({ keepAlive: true, ca: tls.cert }) };
let urls, cookie;
function request(role, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const start = performance.now();
    const req = (role === "mac" ? http : https).request(new URL(route, urls[role]), {
      agent: agents[role], method: data ? "POST" : "GET",
      headers: { "X-NearBridge": "1", ...(cookie && role === "phone" ? { Cookie: cookie } : {}),
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers },
    }, res => {
      const parts = [];
      res.on("data", part => parts.push(part)); res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(parts)}`));
        const buffer = Buffer.concat(parts);
        resolve({ data: JSON.parse(buffer), headers: res.headers, bytes: buffer.length, ms: performance.now() - start });
      });
    });
    req.on("error", reject); req.end(data);
  });
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.map(v => Number(v.toFixed(2))), p50: Number(sorted[Math.ceil(sorted.length * .5) - 1].toFixed(2)),
    p95: Number(sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2)) };
}
try {
  const info = await bridge.start({ port: 0, phonePort: 0 });
  urls = { mac: info.localURL, phone: `https://127.0.0.1:${info.phonePort}` };
  const qr = (await request("mac", "/api/pairing")).data;
  const token = new URL(qr.url).hash.split("=")[1];
  const claim = (await request("phone", "/api/pair", { token })).data;
  await request("mac", "/api/pair/approve", { id: claim.id });
  cookie = (await request("phone", `/api/pair/status?id=${claim.id}`, undefined, { "X-Pair-Claim": claim.claim })).headers["set-cookie"][0].split(";")[0];
  bridge.store.data.items = Array.from({ length: 200 }, (_, i) => ({ id: randomUUID(), kind: "text", source: "mac",
    peerId: bridge.store.data.device.id, createdAt: new Date(i * 1000).toISOString(), text: "x".repeat(8192) }));
  bridge.store.save();
  const result = { node: process.version, platform: `${process.platform}/${process.arch}`, observedAt: new Date().toISOString(),
    history: "200 synthetic text items, each 8 KiB; bounded window rolls as new items arrive",
    transport: "verified HTTPS on loopback; no phone, BLE radio or UI rendering", scenarios: {} };
  for (const scenario of ["workflow", "receipt", "newText"]) {
    const samples = { full: [], delta: [] };
    for (let index = 0; index < 6; index++) {
      const previous = (await request("phone", "/api/state")).data;
      if (scenario === "workflow") await request("phone", "/api/workflows/open-inbox/run", { requestId: randomUUID() });
      if (scenario === "receipt") await request("phone", `/api/items/${previous.items[index].id}/received`, {});
      if (scenario === "newText") await request("mac", "/api/items", { text: `small new text ${index}` });
      // Alternate request order so the snapshot-cache cost is not assigned to
      // the same mode on every sample. Both requests observe the same mutation.
      for (const mode of index % 2 ? ["delta", "full"] : ["full", "delta"]) {
        const reply = await request("phone", `/api/changes?since=${previous.revision}${mode === "delta" ? "&mode=delta-v1" : ""}`);
        if (mode === "delta" && !reply.data.delta) throw new Error("Expected a delta for the large unchanged history");
        samples[mode].push(reply);
      }
    }
    const fullBytes = stats(samples.full.map(reply => reply.bytes)), deltaBytes = stats(samples.delta.map(reply => reply.bytes));
    result.scenarios[scenario] = { fullBytes, deltaBytes,
      reductionPercent: Number((100 * (1 - deltaBytes.p50 / fullBytes.p50)).toFixed(2)),
      requestMs: { full: stats(samples.full.map(reply => reply.ms)), delta: stats(samples.delta.map(reply => reply.ms)) } };
  }
  result.note = "Response-body bytes only. Request timing includes server serialization and response parsing but excludes mutation, rendering, radio and TLS setup. Six samples per case; not a hardware latency/throughput claim.";
  console.log(JSON.stringify(result, null, 2));
} finally {
  Object.values(agents).forEach(agent => agent.destroy());
  await bridge.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
