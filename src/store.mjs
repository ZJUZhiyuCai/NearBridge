import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ActionLedger } from "./actions.mjs";

export function safeFilename(value) {
  let name = String(value)
    .normalize("NFC")
    .replace(/[\\/\x00-\x1f\x7f:<>"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .replace(/[. ]+$/, "");
  if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  // Filesystems limit bytes, not JS characters. Leave room for collision suffixes.
  const truncate = (text, limit) => {
    let result = "", bytes = 0;
    for (const char of text) {
      bytes += Buffer.byteLength(char);
      if (bytes > limit) break;
      result += char;
    }
    return result;
  };
  const extension = path.extname(name);
  const suffix = truncate(extension, 32);
  return truncate(name.slice(0, name.length - extension.length), 240 - Buffer.byteLength(suffix)) + suffix || "未命名文件";
}

export class Store {
  constructor(directory, inbox) {
    this.directory = directory;
    this.inbox = inbox;
    this.outbox = path.join(directory, "outbox");
    this.staging = path.join(directory, "staging");
    for (const dir of [directory, inbox, this.outbox, this.staging])
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.indexPath = path.join(directory, "index.json");
    this.data = fs.existsSync(this.indexPath)
      ? JSON.parse(fs.readFileSync(this.indexPath, "utf8"))
      : {
          version: 1,
          device: null,
          items: [],
          settings: { copyIncomingText: false },
        };
    if (this.data.version !== 1 || !Array.isArray(this.data.items))
      throw new Error("不支持的收件箱索引，请保留数据并检查版本。");
    this.actions = new ActionLedger(this);
  }

  clearStaging() {
    // Only call after binding the service ports, so a duplicate launch cannot
    // remove another running instance's in-flight uploads.
    for (const file of fs.readdirSync(this.staging))
      if (/^[a-f0-9-]+\.part$/.test(file))
        fs.unlinkSync(path.join(this.staging, file));
  }

  save(durable = false) {
    const tmp = `${this.indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    if (durable) {
      const fd = fs.openSync(tmp, "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    fs.renameSync(tmp, this.indexPath);
  }

  get bytes() {
    return this.data.items.reduce((sum, item) => sum + (item.size || 0), 0);
  }

  addText(text, source, peerId = null, action = null) {
    const item = {
      id: randomUUID(),
      kind: "text",
      text,
      source,
      peerId,
      createdAt: new Date().toISOString(),
    };
    const before = this.data.items;
    this.data.items = [item, ...before];
    try { this.actions.commit(action, item.id); }
    catch (error) { this.data.items = before; throw error; }
    return item;
  }

  addFile(
    temp,
    { name, size, sha256, source, peerId = null, transferId, originalName },
  ) {
    const root = source === "phone" ? this.inbox : this.outbox;
    const clean = safeFilename(name);
    const ext = path.extname(clean);
    const stem = clean.slice(0, clean.length - ext.length);
    let filename = clean;
    for (let suffix = 1; ; suffix++) {
      try {
        const target = path.join(root, filename);
        try { fs.linkSync(temp, target); }
        catch (error) {
          // Redirected Windows Downloads folders can be on another volume.
          if (!["EXDEV", "ENOTSUP", "EPERM"].includes(error.code)) throw error;
          fs.copyFileSync(temp, target, fs.constants.COPYFILE_EXCL);
        }
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        filename = `${stem} (${suffix})${ext}`;
      }
    }
    fs.unlinkSync(temp);
    const item = {
      id: randomUUID(),
      kind: "file",
      name: filename,
      size,
      sha256,
      source,
      peerId,
      createdAt: new Date().toISOString(),
      ...(transferId ? { transferId, originalName } : {}),
    };
    this.data.items.unshift(item);
    this.save();
    return item;
  }

  filePath(item) {
    return path.join(
      item.source === "phone" ? this.inbox : this.outbox,
      item.name,
    );
  }

  remove(id) {
    const item = this.data.items.find((value) => value.id === id);
    if (!item) return false;
    if (item.kind === "file") fs.rmSync(this.filePath(item), { force: true });
    this.data.items = this.data.items.filter((value) => value.id !== id);
    this.save();
    return true;
  }
}
