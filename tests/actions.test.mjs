import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.mjs";
import { WorkflowManager } from "../src/workflows.mjs";
import { ACTION_LIMIT, ACTION_TTL } from "../src/actions.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nearbridge-actions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reopen = () => new Store(path.join(root, "data"), path.join(root, "inbox"));
  return { store: reopen(), reopen };
}

test("text receipts survive deletion and process restart, and bind content, time and peer", t => {
  const f = fixture(t), id = randomUUID(), time = Date.now();
  const prepare = (store, value = "只发送一次", source = "phone", peer = "peer-a", at = time) =>
    store.actions.prepare(id, at, "text", value, source, peer);
  const action = prepare(f.store);
  const item = f.store.addText("只发送一次", "phone", "peer-a", action);
  f.store.remove(item.id);
  const restarted = f.reopen();
  assert.equal(prepare(restarted).existing.resultId, item.id);
  assert.equal(restarted.data.items.length, 0);
  assert.throws(() => prepare(restarted, "different"), { status: 409 });
  assert.throws(() => prepare(restarted, "只发送一次", "phone", "peer-a", time + 1), { status: 409 });
  assert.ok(prepare(restarted, "只发送一次", "phone", "peer-b").receipt);
  assert.ok(prepare(restarted, "只发送一次", "mac").receipt);
});

test("expired actions cannot execute after pruning; a full ledger preserves all live receipts", t => {
  const { store } = fixture(t), time = Date.now(), id = randomUUID();
  const action = store.actions.prepare(id, time, "text", "same", "mac", null);
  store.addText("same", "mac", null, action);
  const first = store.data.actionReceipts[0];
  store.data.actionReceipts = Array.from({ length: ACTION_LIMIT }, (_, index) => ({ ...first, requestId: index ? randomUUID() : id }));
  assert.equal(store.actions.prepare(id, time, "text", "same", "mac", "new-phone").existing.resultId, first.resultId);
  assert.throws(() => store.actions.prepare(randomUUID(), time, "text", "new", "mac", null), { status: 507 });
  assert.equal(store.data.actionReceipts.length, ACTION_LIMIT);
  store.data.actionReceipts = [];
  assert.throws(() => store.actions.prepare(id, time - ACTION_TTL, "text", "same", "mac", null), { status: 410 });
  for (const invalid of [undefined, "now", 1.5, Date.now() + 600000])
    assert.throws(() => store.actions.prepare(id, invalid, "text", "same", "mac", null), { status: 400 });
});

test("failed commits roll back both content and receipt, and never start a workflow", async t => {
  const { store, reopen } = fixture(t);
  let executions = 0;
  const workflows = new WorkflowManager(store, { openInbox: async () => { executions++; } }, () => {}, () => {});
  store.save();
  const save = store.save.bind(store), id = randomUUID(), time = Date.now();
  store.save = () => { throw new Error("disk full"); };
  const action = store.actions.prepare(id, time, "text", "hello", "phone", "peer");
  assert.throws(() => store.addText("hello", "phone", "peer", action), /disk full/);
  assert.throws(() => workflows.request("open-inbox", id, "peer", "phone", time), /disk full/);
  assert.equal(store.data.items.length, 0);
  assert.equal(store.data.jobs.length, 0);
  assert.equal(store.data.actionReceipts.length, 0);
  assert.equal(reopen().data.actionReceipts.length, 0);
  assert.equal(executions, 0);
  store.save = save;
  workflows.request("open-inbox", id, "peer", "phone", time);
  await workflows.close();
  assert.equal(executions, 1);
});

test("workflow receipts survive history trimming and restart without executing again", async t => {
  const { store, reopen } = fixture(t), id = randomUUID(), time = Date.now();
  let executions = 0;
  const system = { openInbox: async () => { executions++; } };
  const manager = new WorkflowManager(store, system, () => {}, () => {});
  const job = manager.request("open-inbox", id, "peer", "phone", time);
  await manager.close();
  store.data.jobs = []; store.save();
  const restarted = new WorkflowManager(reopen(), system, () => {}, () => {});
  const replay = restarted.request("open-inbox", id, "peer", "phone", time);
  assert.equal(replay.id, job.id);
  assert.equal(replay.status, "accepted");
  assert.equal(executions, 1);
  assert.throws(() => restarted.request("save-note", id, "peer", "phone", time), { status: 409 });
});

test("a restart after accepting a workflow reports interrupted instead of re-running it", async t => {
  const { store, reopen } = fixture(t), id = randomUUID(), time = Date.now();
  let finish, executions = 0;
  const manager = new WorkflowManager(store, { openInbox: () => { executions++; return new Promise(resolve => { finish = resolve; }); } }, () => {}, () => {});
  manager.request("open-inbox", id, "peer", "phone", time);
  const restarted = new WorkflowManager(reopen(), {}, () => {}, () => {});
  restarted.started();
  assert.equal(restarted.request("open-inbox", id, "peer", "phone", time).status, "interrupted");
  assert.equal(executions, 1);
  finish(); await manager.close();
});

test("confirming a retained legacy job upgrades its receipt before history is trimmed", async t => {
  const { store, reopen } = fixture(t), id = randomUUID(), time = Date.now();
  let executions = 0;
  const system = { openInbox: async () => { executions++; } };
  const manager = new WorkflowManager(store, system, () => {}, () => {});
  const original = manager.request("open-inbox", id, "peer", "phone");
  await manager.close();
  assert.equal(manager.request("open-inbox", id, "peer", "phone", time).id, original.id);
  store.data.jobs = []; store.save();
  const restarted = new WorkflowManager(reopen(), system, () => {}, () => {});
  assert.equal(restarted.request("open-inbox", id, "peer", "phone", time).id, original.id);
  assert.equal(executions, 1);
});
