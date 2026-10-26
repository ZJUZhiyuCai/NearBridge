import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import QRCode from "qrcode";
import { Store } from "./store.mjs";
import { macSystem } from "./system.mjs";
import { WorkflowManager } from "./workflows.mjs";
import { TransferManager } from "./transfers.mjs";
import { VERSION } from "./version.mjs";
import { StateFeed } from "./state-feed.mjs";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const SESSION_MS = 30 * 86400000;
const PAIR_MS = 5 * 60000;
const TEXT_LIMIT = 64 * 1024;
const token = () => randomBytes(32).toString("base64url");
const hash = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
const equal = (a, b) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const fail = (status, message) => Object.assign(new Error(message), { status });

function json(res, status, data) {
  encodedJSON(res, status, JSON.stringify(data));
}

function encodedJSON(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readJSON(req) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json"))
    throw fail(415, "需要 JSON 请求");
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > TEXT_LIMIT + 2048) throw fail(413, "文字过长，请改为发送文件");
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("object required");
    return result;
  } catch {
    throw fail(400, "请求内容无效");
  }
}

export function createBridge(options) {
  const {
    dataDir,
    inbox,
    tls,
    addresses = [],
    name = "我的 Mac",
    maxFileSize = 512 * 1024 * 1024,
    maxStorage = 2 * 1024 * 1024 * 1024,
    system = macSystem,
  } = options;
  if (!tls?.key || !tls?.cert) throw new Error("手机连接必须使用 TLS");
  const store = new Store(dataDir, inbox);
  const clients = new Map();
  const waiters = new Map();
  const downloads = new Set();
  const feed = new StateFeed();
  const instance = randomUUID();
  let sequence = 0;
  const revision = () => `${instance}.${sequence}`;
  const attempts = new Map();
  const uploads = new Set();
  let reservedBytes = 0;
  let pairing = { token: token(), expiresAt: Date.now() + PAIR_MS };
  let pending = null;
  let localPort;
  let remotePort;
  let nativePort;
  let nativeTls = options.nativeTls;
  let closing = false;
  let phoneLastSeen = 0;
  let wasConnected = false;
  let wasPaired = Boolean(store.data.device && store.data.device.expiresAt > Date.now());
  let pendingVisible = false;
  const workflows = new WorkflowManager(store, system, broadcast, hasRoom);
  const transfers = new TransferManager(store, {
    maxFileSize,
    hasRoom,
    changed: broadcast,
  });

  function broadcast() {
    sequence++;
    wasPaired = Boolean(store.data.device && store.data.device.expiresAt > Date.now());
    for (const download of downloads) if (!download.valid()) download.abort.abort();
    for (const [res, client] of clients) {
      if (!client.valid()) { res.end(); continue; }
      // A stalled reader must not accumulate an unbounded notification queue.
      if (!res.writableEnded && !res.write(`event: change\ndata: {}\n\n`)) res.destroy();
    }
    for (const waiter of [...waiters.values()]) waiter.finish(true);
  }

  function observerRoom(role) {
    const count = [...clients.values(), ...waiters.values()].filter(client => client.role === role).length;
    if (count >= 8) throw fail(429, "连接过多，请关闭多余的 NearBridge 页面后重试");
  }
  function phoneConnected() {
    const device = store.data.device;
    return Boolean(device && device.expiresAt > Date.now() &&
      (Date.now() - phoneLastSeen < 12000 ||
        [...clients.values(), ...waiters.values()].some(client => client.role === "phone" && client.valid())));
  }

  function requireMac(role) {
    if (role !== "mac") throw fail(403, "只能在 Mac 上操作");
  }
  function deviceFor(req) {
    const cookie = String(req.headers.cookie || "")
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("nearbridge="));
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
      String(req.headers.authorization || ""),
    );
    const credential = bearer?.[1] || cookie?.slice("nearbridge=".length);
    const device = store.data.device;
    return credential &&
      device &&
      device.expiresAt > Date.now() &&
      equal(hash(credential), device.tokenHash)
      ? device
      : null;
  }
  function accessible(item, role, device) {
    return item && (role === "mac" || item.peerId === device?.id);
  }
  function hasRoom(size = 0) {
    if (store.data.items.length + uploads.size + transfers.count >= 1000)
      throw fail(507, "收件箱已满，请在 Mac 删除不需要的记录后重试");
    if (store.bytes + reservedBytes + transfers.bytes + size > maxStorage)
      throw fail(507, "暂存空间已满，请在 Mac 删除不需要的文件后重试");
  }
  function validatedText(value) {
    if (typeof value !== "string" || !value.trim())
      throw fail(400, "请先输入文字或链接");
    if (Buffer.byteLength(value, "utf8") > TEXT_LIMIT)
      throw fail(413, "文字最多 64 KB，请改为发送文件");
    return value;
  }
  function state(role, device) {
    const currentDevice = store.data.device;
    return {
      revision: revision(),
      role,
      name,
      version: VERSION,
      paired: Boolean(currentDevice && currentDevice.expiresAt > Date.now()),
      device: currentDevice
        ? { id: currentDevice.id, name: currentDevice.name, connected: phoneConnected() }
        : null,
      items: store.data.items
        .filter((item) => accessible(item, role, device))
        .slice(0, 200)
        .map((item) =>
          role === "mac" && item.kind === "file"
            ? { ...item, localPath: store.filePath(item) }
            : item,
        ),
      workflows: workflows.list(role),
      jobs: store.data.jobs
        .filter((job) => role === "mac" || job.peerId === device?.id)
        .slice(0, 20)
        .map(({ requestId, ...job }) => job),
      settings: role === "mac" ? { ...store.data.settings } : undefined,
      pending:
        role === "mac" &&
        pending?.status === "pending" &&
        pending.expiresAt > Date.now()
          ? { id: pending.id, name: pending.name, createdAt: pending.createdAt }
          : null,
      inbox: role === "mac" ? inbox : undefined,
      limits: {
        maxFileSize,
        maxStorage,
        usedStorage: role === "mac" ? store.bytes : undefined,
        textBytes: TEXT_LIMIT,
      },
    };
  }

  async function route(req, res, role) {
    const port = req.socket.localPort;
    const protocol = role === "mac" ? "http:" : "https:";
    const host = req.headers.host;
    const allowedHosts = [
      "127.0.0.1",
      "localhost",
      ...(role === "phone" ? addresses.map((value) => value.ip) : []),
    ].map((value) => `${value}:${port}`);
    if (!allowedHosts.includes(host)) throw fail(403, "请求地址不受信任");
    const origin = `${protocol}//${host}`;
    const url = new URL(req.url, origin);
    const { pathname } = url;
    const method = req.method;
    if (req.headers.origin && req.headers.origin !== origin)
      throw fail(403, "不接受跨站请求");
    if (req.headers["sec-fetch-site"] === "cross-site")
      throw fail(403, "不接受跨站请求");
    if (method === "OPTIONS") throw fail(403, "不接受跨站请求");
    const staticFiles = {
      "/": ["index.html", "text/html"],
      "/app.js": ["app.js", "text/javascript"],
      "/style.css": ["style.css", "text/css"],
      "/icon.svg": ["icon.svg", "image/svg+xml"],
    };
    if (method === "GET" && staticFiles[pathname]) {
      const [file, mime] = staticFiles[pathname];
      res.writeHead(200, { "Content-Type": `${mime}; charset=utf-8` });
      fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
      return;
    }
    if (method === "GET" && pathname === "/health") {
      json(res, 200, { ok: true, app: "NearBridge", version: VERSION });
      return;
    }
    if (!pathname.startsWith("/api/")) throw fail(404, "页面不存在");
    const isDownload =
      /^\/api\/files\/[a-f0-9-]+$/.test(pathname) && method === "GET";
    if (
      !isDownload &&
      pathname !== "/api/events" &&
      req.headers["x-nearbridge"] !== "1"
    )
      throw fail(403, "请求缺少客户端标识");
    const device = role === "phone" ? deviceFor(req) : null;
    if (device) {
      const connected = phoneConnected();
      phoneLastSeen = Date.now();
      if (!connected) { wasConnected = true; broadcast(); }
    }
    if (method === "GET" && pathname === "/api/bootstrap") {
      json(res, 200, {
        role,
        name,
        authenticated: role === "mac" || Boolean(device),
        fingerprint: tls.fingerprint,
      });
      return;
    }

    if (method === "POST" && pathname === "/api/pair" && role === "phone") {
      let now = Date.now();
      const ip = req.socket.remoteAddress;
      const attempt = attempts.get(ip) || { count: 0, resetAt: now + 60000 };
      if (attempt.resetAt < now) {
        attempt.count = 0;
        attempt.resetAt = now + 60000;
      }
      attempt.count++;
      if (!attempts.has(ip) && attempts.size >= 256) throw fail(429, "配对请求过多，请稍后重试");
      attempts.set(ip, attempt);
      if (attempt.count > 10) throw fail(429, "尝试过于频繁，请一分钟后重试");
      const body = await readJSON(req);
      now = Date.now(); // A slow body must not extend the QR token's lifetime.
      const native = body.client === "harmony-native";
      if (
        store.data.device &&
        store.data.device.expiresAt > now &&
        !(native && pairing.native)
      )
        throw fail(409, "这台 Mac 已有配对手机，请先在 Mac 解除配对");
      if (pairing.native && !native)
        throw fail(400, "请使用 NearBridge 原生客户端扫描此二维码");
      if (
        !pairing.token ||
        pairing.expiresAt < now ||
        typeof body.token !== "string" ||
        !equal(body.token, pairing.token)
      )
        throw fail(401, "二维码已过期，请在 Mac 刷新后重新扫码");
      const claim = token();
      pending = {
        id: randomUUID(),
        name: String(body.name || "我的华为手机")
          .replace(/[\x00-\x1f]/g, "")
          .slice(0, 60),
        claimHash: hash(claim),
        native,
        previousDeviceId:
          native && pairing.native ? store.data.device?.id : undefined,
        status: "pending",
        createdAt: new Date(now).toISOString(),
        expiresAt: now + PAIR_MS,
      };
      pairing.token = null;
      broadcast();
      json(res, 202, { id: pending.id, claim });
      return;
    }
    if (
      method === "GET" &&
      pathname === "/api/pair/status" &&
      role === "phone"
    ) {
      if (
        !pending ||
        pending.id !== url.searchParams.get("id") ||
        pending.expiresAt < Date.now() ||
        !equal(hash(req.headers["x-pair-claim"] || ""), pending.claimHash)
      )
        throw fail(401, "配对请求已失效，请重新扫码");
      if (pending.status === "approved")
        res.setHeader(
          "Set-Cookie",
          `nearbridge=${pending.session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`,
        );
      json(res, 200, {
        status: pending.status,
        ...(pending.status === "approved" && pending.native
          ? { session: pending.session }
          : {}),
      });
      return;
    }
    if (role === "phone" && !device)
      throw fail(401, "请先扫描 Mac 上的二维码配对");

    const authorize = () => {
      if (closing) throw fail(503, "服务正在重启，请稍后重试");
      if (role === "phone" && deviceFor(req)?.id !== device?.id)
        throw fail(401, "配对已解除");
    };
    if (method === "POST" && pathname === "/api/transfers") {
      const body = await readJSON(req);
      authorize();
      json(
        res,
        200,
        transfers.prepare(body, role, store.data.device?.id || null),
      );
      return;
    }
    const transferRoute = /^\/api\/transfers\/([a-f0-9-]+)(\/complete)?$/i.exec(
      pathname,
    );
    if (transferRoute) {
      const id = transferRoute[1];
      if (method === "POST" && transferRoute[2]) {
        json(res, 200, {
          item: await transfers.complete(id, role, device?.id, authorize),
        });
      } else if (method === "PUT" && !transferRoute[2]) {
        const rawOffset = url.searchParams.get("offset");
        if (!/^\d+$/.test(rawOffset || "")) throw fail(400, "缺少传输位置");
        json(
          res,
          200,
          await transfers.append(
            id,
            Number(rawOffset),
            req,
            role,
            device?.id,
            authorize,
          ),
        );
      } else if (method === "GET" && !transferRoute[2]) {
        json(res, 200, transfers.view(transfers.lookup(id, role, device?.id)));
      } else if (method === "DELETE" && !transferRoute[2]) {
        transfers.cancel(id, role, device?.id);
        json(res, 200, { ok: true });
      } else throw fail(405, "传输操作不支持");
      return;
    }
    const receiptRoute = /^\/api\/items\/([a-f0-9-]+)\/received$/.exec(
      pathname,
    );
    if (method === "POST" && receiptRoute) {
      if (role !== "phone") throw fail(403, "只有接收手机能确认收件");
      const body = await readJSON(req);
      authorize();
      const item = store.data.items.find((item) => item.id === receiptRoute[1]);
      if (!accessible(item, role, device) || item.source !== "mac")
        throw fail(404, "记录不存在");
      if (item.kind === "file" && body.sha256 !== item.sha256)
        throw fail(409, "文件校验失败，请重新接收");
      if (!item.receivedAt) {
        item.receivedAt = new Date().toISOString();
        try { store.save(); }
        catch (error) { delete item.receivedAt; throw error; }
        broadcast();
      }
      json(res, 200, { ok: true });
      return;
    }

    if (
      method === "POST" &&
      pathname.startsWith("/api/workflows/") &&
      pathname.endsWith("/run")
    ) {
      const body = await readJSON(req);
      if (role === "phone" && !deviceFor(req)) throw fail(401, "配对已解除");
      const id = pathname.split("/")[3];
      const job = workflows.request(
        id,
        body.requestId,
        store.data.device?.id || null,
        role,
      );
      json(res, 202, { job });
      return;
    }
    if (method === "GET" && pathname === "/api/mac/shortcuts") {
      requireMac(role);
      json(res, 200, { shortcuts: await system.listShortcuts() });
      return;
    }
    if (method === "POST" && pathname === "/api/mac/workflows/shortcut") {
      requireMac(role);
      const body = await readJSON(req);
      await workflows.registerShortcut(body.id);
      json(res, 201, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/mac/workflows/enable") {
      requireMac(role);
      const body = await readJSON(req);
      workflows.setEnabled(body.id, body.enabled);
      json(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname === "/api/state") {
      json(res, 200, feed.snapshot(role, device?.tokenHash || "mac", revision(), () => state(role, device)));
      return;
    }
    if (method === "GET" && pathname === "/api/changes") {
      const rawWait = url.searchParams.get("wait") || "25000";
      if (!/^\d+$/.test(rawWait) || Number(rawWait) < 1 || Number(rawWait) > 25000)
        throw fail(400, "等待时间无效");
      const since = url.searchParams.get("since");
      const update = () => feed.update(role, device?.tokenHash || "mac", revision(), () => state(role, device), since,
        url.searchParams.get("mode") === "delta-v1");
      if (since !== revision()) {
        encodedJSON(res, 200, update());
        return;
      }
      observerRoom(role);
      let timer;
      const cleanup = () => { clearTimeout(timer); waiters.delete(res); };
      const finish = (changed) => {
        cleanup();
        if (res.destroyed || res.writableEnded) return;
        try {
          authorize(); // Recheck the exact credential, including same-device rotation.
          if (role === "phone") phoneLastSeen = Date.now();
          if (changed) encodedJSON(res, 200, update());
          else json(res, 200, { revision: revision() });
        } catch (error) { json(res, error.status || 500, { error: error.message }); }
      };
      waiters.set(res, { role, valid: () => role === "mac" || Boolean(deviceFor(req)), finish });
      timer = setTimeout(() => finish(false), Number(rawWait));
      res.once("close", cleanup);
      return;
    }
    if (method === "GET" && pathname === "/api/events") {
      observerRoom(role);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      clients.set(res, { role, deviceId: device?.id, valid: () => role === "mac" || Boolean(deviceFor(req)) });
      res.write("event: change\ndata: {}\n\n");
      broadcast();
      const heartbeat = setInterval(() => {
        if (
          role === "phone" &&
          !deviceFor(req)
        ) {
          res.end();
          return;
        }
        if (!res.write(": heartbeat\n\n")) res.destroy();
      }, 15000);
      res.once("close", () => {
        clearInterval(heartbeat);
        clients.delete(res);
        if (!closing) broadcast();
      });
      return;
    }
    if (method === "GET" && pathname === "/api/pairing") {
      requireMac(role);
      const links = addresses.map((value) => ({
        ...value,
        url: pairing.token
          ? `https://${value.ip}:${remotePort}/#pair=${pairing.token}`
          : null,
      }));
      const selected =
        links.find((value) => value.ip === url.searchParams.get("ip")) ||
        links[0];
      json(res, 200, {
        links,
        url: selected?.url,
        expiresAt: pairing.expiresAt,
        qr: selected?.url
          ? await QRCode.toDataURL(selected.url, {
              width: 280,
              margin: 2,
              errorCorrectionLevel: "M",
              color: { dark: "#1d1d1f", light: "#ffffff" },
            })
          : null,
        fingerprint: tls.fingerprint,
      });
      return;
    }
    if (method === "POST" && pathname === "/api/pairing/native") {
      requireMac(role);
      if (!addresses.length) throw fail(409, "请先连接 Wi-Fi");
      pairing = {
        token: token(),
        expiresAt: Date.now() + PAIR_MS,
        native: true,
      };
      pending = null;
      const certificate = new X509Certificate(nativeTls?.cert || tls.cert);
      const ca = new X509Certificate(nativeTls?.ca || tls.cert);
      const pin = createHash("sha256")
        .update(certificate.publicKey.export({ type: "spki", format: "der" }))
        .digest("base64");
      const payload = JSON.stringify({
        protocol: "nearbridge",
        version: 2,
        name,
        url: `https://${addresses[0].ip}:${nativePort || remotePort}`,
        token: pairing.token,
        certificate: ca.raw.toString("base64"),
        publicKeyHash: pin,
      });
      json(res, 200, {
        expiresAt: pairing.expiresAt,
        fingerprint: certificate.fingerprint256,
        qr: await QRCode.toDataURL(payload, {
          width: 660,
          margin: 3,
          errorCorrectionLevel: "M",
        }),
      });
      broadcast();
      return;
    }
    if (method === "POST" && pathname === "/api/pairing/refresh") {
      requireMac(role);
      if (store.data.device && store.data.device.expiresAt > Date.now())
        throw fail(409, "请先解除当前手机配对");
      pairing = { token: token(), expiresAt: Date.now() + PAIR_MS };
      pending = null;
      broadcast();
      json(res, 200, { ok: true });
      return;
    }
    if (
      method === "POST" &&
      (pathname === "/api/pair/approve" || pathname === "/api/pair/reject")
    ) {
      requireMac(role);
      const body = await readJSON(req);
      if (
        !pending ||
        body.id !== pending.id ||
        pending.status !== "pending" ||
        pending.expiresAt < Date.now()
      )
        throw fail(409, "配对请求已失效");
      pending.status = pathname.endsWith("/approve") ? "approved" : "rejected";
      if (pending.status === "approved") {
        phoneLastSeen = 0;
        pending.session = token();
        store.data.device = {
          id: pending.previousDeviceId || randomUUID(),
          name: pending.name,
          tokenHash: hash(pending.session),
          expiresAt: Date.now() + SESSION_MS,
        };
        for (const item of store.data.items)
          if (item.source === "mac" && !item.peerId)
            item.peerId = store.data.device.id;
        store.save();
      }
      broadcast();
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/device/revoke") {
      requireMac(role);
      transfers.revoke(store.data.device?.id);
      store.data.device = null;
      phoneLastSeen = 0;
      store.save();
      pending = null;
      pairing = { token: token(), expiresAt: Date.now() + PAIR_MS };
      for (const [client, info] of clients)
        if (info.role === "phone") client.end();
      for (const upload of uploads)
        if (upload.role === "phone") upload.abort.abort();
      broadcast();
      await workflows.close();
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/settings") {
      requireMac(role);
      const body = await readJSON(req);
      if (typeof body.copyIncomingText !== "boolean")
        throw fail(400, "设置值无效");
      store.data.settings.copyIncomingText = body.copyIncomingText;
      store.save();
      broadcast();
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/items") {
      const body = await readJSON(req);
      if (role === "phone" && !deviceFor(req)) throw fail(401, "配对已解除");
      const text = validatedText(body.text);
      hasRoom();
      const item = store.addText(text, role, store.data.device?.id);
      broadcast(); // Persisted text is visible immediately, even if pbcopy is slow.
      let clipboardCopied = false;
      if (role === "phone" && store.data.settings.copyIncomingText) {
        try {
          await system.writeClipboard(text);
          clipboardCopied = true;
        } catch {
          /* Saved even if macOS rejects the clipboard operation. */
        }
      }
      json(res, 201, { item, clipboardCopied });
      return;
    }
    if (method === "POST" && pathname === "/api/files") {
      if (uploads.size >= 3) throw fail(429, "正在处理其他文件，请稍后再试");
      let filename;
      try {
        filename = decodeURIComponent(req.headers["x-file-name"] || "");
      } catch {
        throw fail(400, "文件名无效");
      }
      if (!filename) throw fail(400, "缺少文件名");
      const declared = Number(req.headers["x-file-size"]);
      if (!Number.isSafeInteger(declared) || declared < 0)
        throw fail(400, "缺少有效文件大小");
      if (declared > maxFileSize) throw fail(413, "文件超过本次传输上限");
      hasRoom(declared);
      reservedBytes += declared;
      const temp = path.join(store.staging, `${randomUUID()}.part`);
      const upload = { role, abort: new AbortController() };
      uploads.add(upload);
      let bytes = 0;
      const digest = createHash("sha256");
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          if (bytes > declared || bytes > maxFileSize) {
            callback(fail(413, "文件大小超出声明值"));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          req,
          meter,
          fs.createWriteStream(temp, { flags: "wx", mode: 0o600 }),
          { signal: upload.abort.signal },
        );
        if (bytes !== declared) throw fail(400, "文件传输不完整，请重新发送");
        if (role === "phone" && !deviceFor(req)) throw fail(401, "配对已解除");
        const item = store.addFile(temp, {
          name: filename,
          size: bytes,
          sha256: digest.digest("hex"),
          source: role,
          peerId: store.data.device?.id,
        });
        broadcast();
        json(res, 201, { item });
      } finally {
        reservedBytes -= declared;
        uploads.delete(upload);
        fs.rmSync(temp, { force: true });
      }
      return;
    }
    if (isDownload) {
      const item = store.data.items.find(
        (value) => value.id === pathname.split("/").at(-1),
      );
      if (!accessible(item, role, device) || item.kind !== "file")
        throw fail(404, "文件不存在");
      const file = store.filePath(item);
      if (!fs.existsSync(file)) throw fail(410, "文件已从 Mac 移动或删除");
      const size = fs.statSync(file).size;
      let start = 0,
        end = size - 1;
      if (req.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (
          !match ||
          !size ||
          Number(match[1]) >= size ||
          (match[2] &&
            (Number(match[2]) < Number(match[1]) || Number(match[2]) >= size))
        ) {
          res.setHeader("Content-Range", `bytes */${size}`);
          throw fail(416, "下载范围无效");
        }
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      }
      res.writeHead(req.headers.range ? 206 : 200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": size ? end - start + 1 : 0,
        "Accept-Ranges": "bytes",
        ETag: `"${item.sha256}"`,
        "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      });
      if (size) {
        const download = { valid: () => role === "mac" || Boolean(deviceFor(req)), abort: new AbortController() };
        downloads.add(download);
        try { await pipeline(fs.createReadStream(file, { start, end }), res, { signal: download.abort.signal }); }
        finally { downloads.delete(download); }
      } else res.end();
      return;
    }
    if (method === "DELETE" && pathname.startsWith("/api/items/")) {
      requireMac(role);
      if (!store.remove(pathname.split("/").at(-1)))
        throw fail(404, "记录不存在");
      broadcast();
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/mac/clipboard/send") {
      requireMac(role);
      const text = validatedText(await system.readClipboard());
      authorize();
      hasRoom(); // Capacity may have changed while awaiting the OS clipboard.
      const item = store.addText(text, "mac", store.data.device?.id);
      broadcast();
      json(res, 201, { item });
      return;
    }
    if (method === "POST" && pathname === "/api/mac/clipboard/copy") {
      requireMac(role);
      const body = await readJSON(req);
      const item = store.data.items.find(
        (value) => value.id === body.id && value.kind === "text",
      );
      if (!item) throw fail(404, "文字记录不存在");
      await system.writeClipboard(item.text);
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/mac/inbox") {
      requireMac(role);
      await system.openInbox(inbox);
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/mac/open-link") {
      requireMac(role);
      const body = await readJSON(req);
      const item = store.data.items.find(
        (value) => value.id === body.id && value.kind === "text",
      );
      let link;
      try {
        link = new URL(item?.text.trim());
      } catch {
        throw fail(400, "这条内容不是网址");
      }
      if (!["http:", "https:"].includes(link.protocol))
        throw fail(400, "只支持打开 http 或 https 网址");
      await system.openURL(link.href);
      json(res, 200, { ok: true });
      return;
    }
    throw fail(404, "操作不存在");
  }

  function handler(role) {
    return (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      Promise.resolve(route(req, res, role)).catch((error) => {
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) {
          res.end();
          return;
        }
        json(res, error.status || 500, {
          error: error.status
            ? error.message
            : "操作没有完成，请重试；原有记录已保留",
        });
        if (
          !error.status &&
          error.code !== "ECONNRESET" &&
          error.name !== "AbortError"
        )
          console.error("[NearBridge]", error.message);
      });
    };
  }

  const local = http.createServer(handler("mac"));
  const remote = https.createServer(
    { key: tls.key, cert: tls.cert, minVersion: "TLSv1.2" },
    handler("phone"),
  );
  const native = nativeTls
    ? https.createServer(
        { key: nativeTls.key, cert: nativeTls.cert, minVersion: "TLSv1.2" },
        handler("phone"),
      )
    : null;
  const servers = [local, remote, ...(native ? [native] : [])];
  for (const server of servers) {
    server.maxConnections = 64;
    server.keepAliveTimeout = 30000;
  }
  if (native) {
    native.requestTimeout = 10 * 60000;
    native.headersTimeout = 15000;
  }
  local.requestTimeout = remote.requestTimeout = 10 * 60000;
  local.headersTimeout = remote.headersTimeout = 15000;
  const cleanup = setInterval(() => {
    for (const [ip, attempt] of attempts)
      if (attempt.resetAt < Date.now()) attempts.delete(ip);
  }, 60000);
  cleanup.unref();
  const presence = setInterval(() => {
    const connected = phoneConnected();
    const paired = Boolean(store.data.device && store.data.device.expiresAt > Date.now());
    const visible = Boolean(pending?.status === "pending" && pending.expiresAt > Date.now());
    const expiredObserver = [...clients.values(), ...waiters.values()].some(client => !client.valid());
    const expiredDownload = [...downloads].some(download => !download.valid());
    if (paired !== wasPaired || connected !== wasConnected || visible !== pendingVisible || expiredObserver || expiredDownload) {
      wasConnected = connected; pendingVisible = visible; broadcast();
    }
  }, 1000);
  presence.unref();
  async function listen(server, port, host) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    return server.address().port;
  }
  return {
    store,
    updateNativeTLS(value) {
      nativeTls = value;
      native?.setSecureContext({ key: value.key, cert: value.cert });
    },
    async start({
      port = 53318,
      phonePort = 53319,
      nativePhonePort = 53320,
    } = {}) {
      try {
        localPort = await listen(local, port, "127.0.0.1");
        remotePort = await listen(remote, phonePort, "0.0.0.0");
        if (native)
          nativePort = await listen(native, nativePhonePort, "0.0.0.0");
        store.clearStaging();
        transfers.started();
        workflows.started();
        return {
          localURL: `http://127.0.0.1:${localPort}`,
          phonePort: remotePort,
          nativePort,
        };
      } catch (error) {
        local.close();
        remote.close();
        native?.close();
        clearInterval(cleanup);
        clearInterval(presence);
        throw error;
      }
    },
    async close() {
      closing = true;
      clearInterval(cleanup);
      clearInterval(presence);
      for (const waiter of [...waiters.values()]) waiter.finish(false);
      for (const [res] of clients) res.end();
      for (const upload of uploads) upload.abort.abort();
      for (const download of downloads) download.abort.abort();
      await workflows.close();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise((resolve) => {
              server.close(resolve);
              server.closeAllConnections();
            }),
        ),
      );
    },
  };
}
