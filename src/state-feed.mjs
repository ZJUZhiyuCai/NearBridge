import { createHash } from "node:crypto";

// Keep only bounded ID/hash manifests for older revisions, never copies of old
// history text. Each authenticated scope owns its own baseline cache.
export const HISTORY_BYTES = 8 * 1024 * 1024;
export class StateFeed {
  constructor(limit = 32) {
    this.limit = limit;
    this.scopes = new Map();
  }

  capture(role, scope, revision, build) {
    let cache = this.scopes.get(role);
    if (!cache || cache.scope !== scope) {
      cache = { scope, baselines: new Map(), current: null };
      this.scopes.set(role, cache);
    }
    if (cache.current?.state.revision === revision) return cache;
    const state = build();
    const items = [], signatures = new Map();
    let bytes = 0;
    for (const item of state.items.slice(0, 200)) {
      const encoded = JSON.stringify(item);
      const size = Buffer.byteLength(encoded) + (items.length ? 1 : 0);
      // JSON escaping can expand a valid 64 KiB text sixfold. Bound the encoded
      // history so initial sync stays below the native HTTP response limit.
      if (bytes + size > HISTORY_BYTES) break;
      bytes += size;
      items.push({ ...item });
      signatures.set(item.id, createHash("sha256").update(encoded).digest("base64"));
    }
    const snapshot = { ...state, items };
    const manifest = { signatures, order: items.map(item => item.id) };
    cache.current = { state: snapshot, manifest,
      bytes: bytes + Buffer.byteLength(JSON.stringify({ ...snapshot, items: [] })) };
    cache.baselines.set(revision, manifest);
    while (cache.baselines.size > this.limit) cache.baselines.delete(cache.baselines.keys().next().value);
    return cache;
  }

  snapshot(...args) {
    return this.capture(...args).current.state;
  }

  update(role, scope, revision, build, since, delta) {
    const cache = this.capture(role, scope, revision, build);
    const { state, manifest, bytes } = cache.current;
    const full = () => JSON.stringify({ revision, state });
    const baseline = delta && cache.baselines.get(since);
    if (!baseline || since === revision) return full();
    const changed = state.items.filter(item => baseline.signatures.get(item.id) !== manifest.signatures.get(item.id));
    const removed = baseline.order.filter(id => !manifest.signatures.has(id));
    const reordered = baseline.order.length !== manifest.order.length || baseline.order.some((id, index) => id !== manifest.order[index]);
    const encoded = JSON.stringify({ revision, delta: { baseRevision: since,
      state: { ...state, items: changed }, removed, ...(reordered ? { order: manifest.order } : {}) } });
    const fullBytes = bytes + Buffer.byteLength(JSON.stringify({ revision, state: null })) - 4;
    return Buffer.byteLength(encoded) < fullBytes ? encoded : full();
  }
}
