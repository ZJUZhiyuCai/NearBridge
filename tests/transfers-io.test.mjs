import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Store } from "../src/store.mjs";
import { TransferManager } from "../src/transfers.mjs";

function fixture(t, wrap = handle => handle) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nearbridge-io-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root, path.join(root, "inbox"));
  const manager = new TransferManager(store, { maxFileSize: 1024, hasRoom() {}, changed() {},
    io: { open: async (...args) => wrap(await fs.promises.open(...args)) } });
  const id = randomUUID();
  manager.prepare({ id, name: "io.bin", size: 4 }, "mac", null);
  const append = (authorize = () => {}) => {
    const req = Readable.from([Buffer.from("test")]); req.headers = { "content-length": "4" };
    return manager.append(id, 0, req, "mac", null, authorize);
  };
  return { manager, id, append };
}

test("slow disk sync yields to other work and revocation prevents publishing the offset", async t => {
  let entered, release;
  const syncing = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, handle => ({ write: (...args) => handle.write(...args), close: () => handle.close(),
    async sync() { entered(); await gate; await handle.sync(); } }));
  let authorized = true;
  const append = f.append(() => { if (!authorized) throw new Error("revoked"); });
  await syncing;
  assert.equal(f.manager.lookup(f.id, "mac").offset, 0);
  let progressed = false;
  await new Promise(resolve => setImmediate(() => { progressed = true; resolve(); }));
  assert.ok(progressed, "pending fsync must not monopolize the event loop");
  authorized = false; release();
  await assert.rejects(append, /revoked/);
  assert.equal(f.manager.lookup(f.id, "mac").offset, 0);
  assert.equal(f.manager.busy.size, 0);
});

test("partial writes finish correctly, zero writes fail, and failed metadata commits remain resumable", async t => {
  let zero = true;
  const f = fixture(t, handle => ({
    write: (data, offset, length, position) => zero ? Promise.resolve({ bytesWritten: 0 }) : handle.write(data, offset, Math.min(2, length), position),
    sync: () => handle.sync(), close: () => handle.close(),
  }));
  await assert.rejects(f.append(), /磁盘写入中断/);
  assert.equal(f.manager.lookup(f.id, "mac").offset, 0);
  zero = false;
  const save = f.manager.save.bind(f.manager);
  f.manager.save = () => { throw new Error("metadata disk full"); };
  await assert.rejects(f.append(), /metadata disk full/);
  assert.equal(f.manager.lookup(f.id, "mac").offset, 0);
  f.manager.save = save;
  assert.equal((await f.append()).offset, 4);
  assert.equal(fs.readFileSync(f.manager.file(f.id), "utf8"), "test");
});
