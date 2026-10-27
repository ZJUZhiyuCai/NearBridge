// Validate an entire delta before exposing it. A mismatched baseline requests a
// fresh snapshot; older replies must never roll the visible history backwards.
export function mergeState(previous, update) {
  if (!update || typeof update.revision !== 'string') throw new Error('状态版本无效');
  const older = (a, b) => {
    const left = /^(.*)\.(\d+)$/.exec(a || '');
    const right = /^(.*)\.(\d+)$/.exec(b || '');
    return left && right && left[1] === right[1] && Number(left[2]) < Number(right[2]);
  };
  if (older(update.revision, previous?.revision)) return previous;
  if (update.state) {
    if (update.state.revision !== update.revision || !Array.isArray(update.state.items)) throw new Error('状态快照无效');
    return update.state;
  }
  if (!update.delta) {
    if (update.revision !== previous?.revision) throw new Error('缺少状态内容');
    return previous;
  }
  const delta = update.delta;
  if (!previous || delta.baseRevision !== previous.revision || delta.state?.revision !== update.revision ||
      !Array.isArray(delta.state.items) || !Array.isArray(delta.removed)) throw new Error('增量基线不一致');
  const items = new Map(previous.items.map(item => [item.id, item]));
  for (const id of delta.removed) items.delete(id);
  const changed = new Set();
  for (const item of delta.state.items) {
    if (typeof item.id !== 'string' || changed.has(item.id)) throw new Error('增量条目无效');
    changed.add(item.id); items.set(item.id, item);
  }
  const order = delta.order ?? previous.items.map(item => item.id).filter(id => items.has(id));
  if (!Array.isArray(order) || new Set(order).size !== items.size || order.length !== items.size || order.some(id => !items.has(id)))
    throw new Error('增量顺序不完整');
  return { ...delta.state, items: order.map(id => items.get(id)) };
}
