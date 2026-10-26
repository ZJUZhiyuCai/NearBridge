import { createHash } from "node:crypto";

export const ACTION_TTL = 7 * 24 * 60 * 60 * 1000;
export const ACTION_LIMIT = 4096;
const fail = (status, message) => Object.assign(new Error(message), { status });

// Receipts outlive visible history. Never evict a live receipt to make room:
// doing so would turn a retry into a second side effect.
export class ActionLedger {
  constructor(store) { this.store = store; store.data.actionReceipts ??= []; }

  prepare(requestId, requestedAt, kind, payload, source, peerId) {
    const now = Date.now();
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId) ||
        !Number.isSafeInteger(requestedAt) || requestedAt > now + 5 * 60000)
      throw fail(400, "操作编号或时间无效，请检查设备时间");
    if (requestedAt <= now - ACTION_TTL)
      throw fail(410, "这项操作已超过 7 天，请先检查执行结果；确认后再发起新操作");
    const fingerprint = createHash("sha256").update(JSON.stringify([kind, payload])).digest("hex");
    // Local Mac retries must stay bound to the original operation even if the
    // paired phone changed. Phone receipts are scoped to the authenticated peer.
    const scope = source === "phone" ? peerId : null;
    const existing = this.store.data.actionReceipts.find(receipt =>
      receipt.requestId === requestId && receipt.source === source && receipt.peerId === scope);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.requestedAt !== requestedAt)
        throw fail(409, "操作编号已用于另一项内容");
      return { existing };
    }
    if (this.store.data.actionReceipts.filter(value => value.requestedAt > now - ACTION_TTL).length >= ACTION_LIMIT)
      throw fail(507, "可靠操作记录已满，请稍后再试；已提交的操作仍可查询");
    return { receipt: { requestId, requestedAt, kind, fingerprint, source, peerId: scope } };
  }

  commit(action, resultId) {
    const before = this.store.data.actionReceipts;
    if (action) this.store.data.actionReceipts = [
      ...before.filter(value => value.requestedAt > Date.now() - ACTION_TTL),
      { ...action.receipt, resultId },
    ];
    try { this.store.save(Boolean(action)); }
    catch (error) { this.store.data.actionReceipts = before; throw error; }
  }
}
