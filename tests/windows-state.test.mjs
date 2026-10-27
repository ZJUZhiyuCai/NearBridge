import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeState } from '../public/state-update.js';
test('Windows state deltas preserve content and receipts; reject incomplete baselines atomically', () => {
  const state = { revision: 'boot.1', items: [{ id: 'a', text: 'original' }, { id: 'b', text: 'removed' }] };
  const delta = { revision: 'boot.2', delta: { baseRevision: 'boot.1', state: { revision: 'boot.2', items: [{ id: 'c', text: 'new' }] }, removed: ['b'], order: ['c', 'a'] } };
  const next = mergeState(state, delta);
  assert.deepEqual(next.items, [{ id: 'c', text: 'new' }, state.items[0]]);
  assert.equal(mergeState(next, { revision: 'boot.2' }), next);
  assert.equal(mergeState(next, { revision: 'boot.1', state }), next);
  assert.throws(() => mergeState(next, delta));
  assert.throws(() => mergeState(state, { ...delta, delta: { ...delta.delta, order: ['c'] } }));
  assert.equal(state.items.length, 2);
});
