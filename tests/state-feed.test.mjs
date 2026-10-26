import test from "node:test";
import assert from "node:assert/strict";
import { StateFeed, HISTORY_BYTES } from "../src/state-feed.mjs";

const build = (revision, items) => () => ({ revision, name: "test", items, workflows: [], jobs: [] });
const item = (id, text = "x".repeat(2048)) => ({ id, text, kind: "text", source: "mac", createdAt: "test" });

test("delta cache isolates roles and rotated credentials, and falls back after eviction", () => {
  const feed = new StateFeed(2);
  const items = [item("one"), item("two")];
  feed.snapshot("mac", "admin", "boot.1", build("boot.1", items));
  let update = JSON.parse(feed.update("phone", "token-a", "boot.2", build("boot.2", items), "boot.1", true));
  assert.ok(update.state, "a Mac revision cannot serve as a phone baseline");
  update = JSON.parse(feed.update("phone", "token-b", "boot.3", build("boot.3", items), "boot.2", true));
  assert.ok(update.state, "rotating a same-device token invalidates previous baselines");
  feed.snapshot("phone", "token-b", "boot.4", build("boot.4", items));
  update = JSON.parse(feed.update("phone", "token-b", "boot.5", build("boot.5", items), "boot.3", true));
  assert.ok(update.state, "evicted revisions must obtain a full snapshot");
  update = JSON.parse(feed.update("phone", "token-b", "boot.6", build("boot.6", items), "boot.5", true));
  assert.equal(update.delta.state.items.length, 0);
  assert.equal(update.delta.order, undefined);
  assert.equal(feed.scopes.get("phone").baselines.size, 2);
});

test("delta baseline is immutable when a stored receipt is later mutated", () => {
  const feed = new StateFeed();
  const original = item("one");
  const before = feed.snapshot("phone", "token", "boot.1", build("boot.1", [original, item("two")]));
  original.receivedAt = "later";
  assert.equal(before.items[0].receivedAt, undefined);
  const update = JSON.parse(feed.update("phone", "token", "boot.2", build("boot.2", [original, item("two")]), "boot.1", true));
  assert.equal(update.delta.state.items.length, 1);
  assert.equal(update.delta.state.items[0].receivedAt, "later");
});

test("escaped text cannot exceed the native response budget; smaller snapshots bypass deltas", () => {
  const feed = new StateFeed();
  const items = Array.from({ length: 200 }, (_, index) => item(String(index), "\u0001".repeat(64 * 1024)));
  const update = feed.update("phone", "token", "boot.1", build("boot.1", items), "unknown", true);
  assert.ok(Buffer.byteLength(update) < HISTORY_BYTES + 4096);
  const initial = JSON.parse(update).state;
  assert.ok(initial.items.length > 1 && initial.items.length < 200);
  assert.equal(initial.items[0].text.length, 64 * 1024, "individual text must never be truncated");
  const small = JSON.parse(feed.update("phone", "token", "boot.2", build("boot.2", []), "boot.1", true));
  assert.ok(small.state, "a large removal list should use a smaller full snapshot");
});
