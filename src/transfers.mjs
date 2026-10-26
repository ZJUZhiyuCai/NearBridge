import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const fail = (status, message) => Object.assign(new Error(message), { status });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const CHUNK_SIZE = 4 * 1024 * 1024;

// A committed offset is durable. Extra bytes from an interrupted write are
// truncated on restart, so retrying a chunk cannot silently duplicate bytes.
export class TransferManager {
  constructor(store, { maxFileSize, hasRoom, changed }) {
    this.store = store;
    this.maxFileSize = maxFileSize;
    this.hasRoom = hasRoom;
    this.changed = changed;
    this.directory = path.join(store.directory, "transfers");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.entries = new Map();
    this.busy = new Set();
    this.revokedPeers = new Set();
  }
  started() {
    for (const filename of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9-]+\.json$/i.test(filename)) continue;
      const entry = JSON.parse(
        fs.readFileSync(path.join(this.directory, filename), "utf8"),
      );
      if (!UUID.test(entry.id)) continue;
      this.entries.set(entry.id, entry);
      const done = this.store.data.items.some(
        (item) => item.transferId === entry.id,
      );
      const revoked =
        entry.source === "phone" &&
        (entry.peerId !== this.store.data.device?.id ||
          this.store.data.device?.expiresAt < Date.now());
      if (
        done ||
        revoked ||
        Date.now() - entry.updatedAt > 7 * 86400000 ||
        !fs.existsSync(this.file(entry.id))
      ) {
        this.remove(entry.id);
        continue;
      }
      const size = fs.statSync(this.file(entry.id)).size;
      if (size < entry.offset) entry.offset = 0;
      fs.truncateSync(this.file(entry.id), entry.offset);
      this.save(entry);
    }
  }
  get count() {
    return this.entries.size;
  }
  get bytes() {
    return [...this.entries.values()].reduce(
      (sum, entry) => sum + entry.size,
      0,
    );
  }
  file(id) {
    return path.join(this.directory, `${id}.part`);
  }
  save(entry) {
    const file = path.join(this.directory, `${entry.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  remove(id) {
    this.entries.delete(id);
    for (const suffix of ["part", "json", "json.tmp"])
      fs.rmSync(path.join(this.directory, `${id}.${suffix}`), { force: true });
  }
  lookup(id, role, peerId) {
    if (!UUID.test(id)) throw fail(400, "传输编号无效");
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.source !== role ||
      (role === "phone" && entry.peerId !== peerId)
    )
      throw fail(404, "传输不存在");
    return entry;
  }
  view(entry) {
    return {
      id: entry.id,
      name: entry.name,
      size: entry.size,
      offset: entry.offset,
      chunkSize: CHUNK_SIZE,
    };
  }
  prepare(body, role, peerId) {
    const { id, name, size } = body;
    if (typeof id !== "string" || !UUID.test(id))
      throw fail(400, "传输编号无效");
    if (
      typeof name !== "string" ||
      !name.trim() ||
      Buffer.byteLength(name) > 1024
    )
      throw fail(400, "文件名无效");
    if (!Number.isSafeInteger(size) || size < 0)
      throw fail(400, "文件大小无效");
    if (size > this.maxFileSize) throw fail(413, "文件超过本次传输上限");
    const item = this.store.data.items.find((item) => item.transferId === id);
    if (item) {
      if (item.source !== role || (role === "phone" && item.peerId !== peerId))
        throw fail(404, "传输不存在");
      if (item.originalName !== name || item.size !== size)
        throw fail(409, "传输编号已用于其他文件");
      return { id, offset: size, size, chunkSize: CHUNK_SIZE, item };
    }
    let entry = this.entries.get(id);
    if (entry) {
      this.lookup(id, role, peerId);
      if (entry.name !== name || entry.size !== size)
        throw fail(409, "文件已改变，请重新选择文件");
    } else {
      this.hasRoom(size);
      if (this.count >= 100)
        throw fail(429, "待传文件过多，请先完成或取消现有传输");
      entry = {
        id,
        name,
        size,
        offset: 0,
        source: role,
        peerId,
        updatedAt: Date.now(),
      };
      fs.writeFileSync(this.file(id), "", { mode: 0o600, flag: "wx" });
      this.entries.set(id, entry);
      this.save(entry);
    }
    return this.view(entry);
  }
  async append(id, offset, req, role, peerId, authorize) {
    const entry = this.lookup(id, role, peerId);
    if (this.busy.has(id)) throw fail(409, "这个文件正在传输");
    if (this.busy.size >= 3) throw fail(429, "正在处理其他文件，请稍后再试");
    if (!Number.isSafeInteger(offset) || offset !== entry.offset)
      throw fail(409, "传输位置已改变，请恢复连接后重试");
    const length = Number(req.headers["content-length"]);
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > CHUNK_SIZE ||
      offset + length > entry.size
    )
      throw fail(400, "分块大小无效");
    this.busy.add(id);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > length) throw fail(400, "分块超过声明大小");
        chunks.push(chunk);
      }
      if (size !== length) throw fail(400, "分块不完整，请重试");
      authorize();
      const fd = fs.openSync(this.file(id), "r+");
      try {
        const buffer = Buffer.concat(chunks);
        let written = 0;
        while (written < buffer.length)
          written += fs.writeSync(
            fd,
            buffer,
            written,
            buffer.length - written,
            offset + written,
          );
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      entry.offset += size;
      entry.updatedAt = Date.now();
      this.save(entry);
      return this.view(entry);
    } finally {
      this.busy.delete(id);
      if (role === "phone" && this.revokedPeers.has(peerId)) this.remove(id);
    }
  }
  async complete(id, role, peerId, authorize) {
    const done = this.store.data.items.find(
      (item) =>
        item.transferId === id &&
        item.source === role &&
        (role === "mac" || item.peerId === peerId),
    );
    if (done) return done;
    const entry = this.lookup(id, role, peerId);
    if (this.busy.has(id)) throw fail(409, "这个文件正在传输");
    if (this.busy.size >= 3) throw fail(429, "正在处理其他文件，请稍后再试");
    if (entry.offset !== entry.size) throw fail(409, "文件尚未传完");
    this.busy.add(id);
    try {
      const digest = createHash("sha256");
      for await (const chunk of fs.createReadStream(this.file(id)))
        digest.update(chunk);
      authorize();
      const item = this.store.addFile(this.file(id), {
        name: entry.name,
        size: entry.size,
        sha256: digest.digest("hex"),
        source: role,
        peerId: entry.peerId || this.store.data.device?.id || null,
        transferId: id,
        originalName: entry.name,
      });
      this.remove(id);
      this.changed();
      return item;
    } finally {
      this.busy.delete(id);
      if (role === "phone" && this.revokedPeers.has(peerId)) this.remove(id);
    }
  }
  cancel(id, role, peerId) {
    this.lookup(id, role, peerId);
    if (this.busy.has(id)) throw fail(409, "请等待当前分块结束后取消");
    this.remove(id);
  }
  revoke(peerId) {
    this.revokedPeers.add(peerId);
    for (const entry of this.entries.values())
      if (
        entry.source === "phone" &&
        entry.peerId === peerId &&
        !this.busy.has(entry.id)
      )
        this.remove(entry.id);
  }
}
