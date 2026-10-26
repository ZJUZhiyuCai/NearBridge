import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

const builtins = [
  {
    id: "open-inbox",
    name: "打开收件目录",
    description: "让 Mac 在访达中打开 NearBridge 收件目录。",
    type: "builtin",
    enabled: true,
    symbol: "↗",
  },
  {
    id: "save-note",
    name: "把刚发来的文字存成便签",
    description:
      "把这台手机最近发来的文字存为 Markdown 文件，放进 Mac 收件目录。",
    type: "builtin",
    enabled: true,
    symbol: "T",
  },
];
const fail = (status, message) => Object.assign(new Error(message), { status });

export class WorkflowManager {
  constructor(store, system, changed, checkRoom) {
    this.store = store;
    this.system = system;
    this.changed = changed;
    this.checkRoom = checkRoom;
    this.active = null;
    store.data.workflows ??= builtins.map((value) => ({ ...value }));
    store.data.jobs ??= [];
  }

  started() {
    let changed = false;
    for (const job of this.store.data.jobs)
      if (job.status === "running") {
        job.status = "interrupted";
        job.message = "服务已重启，请先检查 Mac 上的执行结果再决定是否重试。";
        changed = true;
      }
    if (changed) this.store.save();
  }

  list(role) {
    return this.store.data.workflows
      .filter((value) => role === "mac" || value.enabled)
      .map(({ shortcutId, ...value }) => value);
  }

  async registerShortcut(id) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
      throw fail(400, "请选择本机快捷指令");
    const available = await this.system.listShortcuts();
    const shortcut = available.find(
      (value) => value.id.toLowerCase() === id.toLowerCase(),
    );
    if (!shortcut) throw fail(404, "快捷指令不存在，请重新载入列表");
    const key = `shortcut-${shortcut.id}`;
    if (this.store.data.workflows.some((value) => value.id === key))
      throw fail(409, "这个快捷指令已经加入面板");
    if (this.store.data.workflows.length >= 32)
      throw fail(400, "面板最多支持 32 个工作流");
    this.store.data.workflows.push({
      id: key,
      shortcutId: shortcut.id,
      name: shortcut.name,
      description: "由 Mac 端选定的快捷指令。手机点按后直接在 Mac 执行。",
      type: "shortcut",
      enabled: true,
      symbol: "⌘",
    });
    this.store.save();
    this.changed();
  }

  setEnabled(id, enabled) {
    const workflow = this.store.data.workflows.find((value) => value.id === id);
    if (!workflow || typeof enabled !== "boolean")
      throw fail(400, "工作流设置无效");
    workflow.enabled = enabled;
    this.store.save();
    this.changed();
  }

  request(id, requestId, peerId, role, requestedAt, expectedPeer) {
    if (
      typeof requestId !== "string" ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)
    )
      throw fail(400, "缺少有效请求编号");
    const action = requestedAt === undefined ? null : this.store.actions.prepare(requestId, requestedAt, "workflow", id, role, peerId);
    if (action?.existing) {
      return this.store.data.jobs.find(job => job.id === action.existing.resultId) || {
        id: action.existing.resultId, workflowId: id, status: "accepted",
        message: "Mac 已接收这项操作，执行记录已移出历史；不会重复执行。",
      };
    }
    const existing = this.store.data.jobs.find(
      (job) =>
        job.requestId === requestId &&
        job.peerId === peerId &&
        job.source === role,
    );
    if (existing) {
      if (existing.workflowId !== id)
        throw fail(409, "请求编号已用于另一个工作流");
      // A client may confirm an older retained job through the new endpoint.
      // Preserve that receipt before acknowledging the reliable contract.
      if (action) this.store.actions.commit(action, existing.id);
      return existing;
    }
    if (expectedPeer !== undefined && expectedPeer !== peerId)
      throw fail(409, "配对的手机已改变，请先检查原操作的结果");
    const workflow = this.store.data.workflows.find(
      (value) => value.id === id && value.enabled,
    );
    if (!workflow) throw fail(403, "这个工作流未在 Mac 启用");
    if (this.active) throw fail(409, "Mac 正在执行另一个工作流，请完成后再试");
    const job = {
      id: randomUUID(),
      requestId,
      workflowId: id,
      name: workflow.name,
      peerId,
      source: role,
      status: "running",
      message: "正在 Mac 上执行…",
      createdAt: new Date().toISOString(),
    };
    const before = this.store.data.jobs;
    this.store.data.jobs = [job, ...before].slice(0, 100);
    try { this.store.actions.commit(action, job.id); }
    catch (error) { this.store.data.jobs = before; throw error; }
    const active = { controller: new AbortController(), peerId, promise: null };
    this.active = active;
    this.changed();
    active.promise = this.execute(workflow, job, active.controller.signal)
      .then((message) => {
        job.status = "succeeded";
        job.message = message;
      })
      .catch((error) => {
        job.status = "failed";
        job.message = error.status
          ? error.message
          : "执行未完成。请检查 Mac 的权限或确认窗口；重试前先确认是否已有部分结果。";
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        try { this.store.save(); }
        finally { this.active = null; this.changed(); }
      });
    // Keep an I/O error observable to close(), without an unhandled rejection
    // when no shutdown is currently awaiting this task.
    active.promise.catch(() => {});
    return job;
  }

  async execute(workflow, job, signal) {
    if (workflow.id === "open-inbox") {
      await this.system.openInbox(this.store.inbox);
      return "已请求 Mac 打开收件目录。";
    }
    if (workflow.id === "save-note") {
      const text = this.store.data.items.find(
        (item) =>
          item.kind === "text" &&
          item.source === "phone" &&
          item.peerId === job.peerId,
      );
      if (!text) throw fail(400, "先从手机发送一段文字，再运行这个工作流。");
      const content = Buffer.from(`${text.text}\n`, "utf8");
      this.checkRoom(content.length);
      const temp = path.join(this.store.staging, `${randomUUID()}.part`);
      fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
      const date = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        dateStyle: "short",
        timeStyle: "medium",
        hour12: false,
      })
        .format(new Date())
        .replace(/[: ]/g, "-");
      try {
        const item = this.store.addFile(temp, {
          name: `便签-${date}.md`,
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
          source: "phone",
          peerId: job.peerId,
        });
        return `已保存 ${item.name}`;
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
    if (
      workflow.type === "shortcut" &&
      /^[a-f0-9-]{36}$/i.test(workflow.shortcutId)
    ) {
      await this.system.runShortcut(workflow.shortcutId, signal);
      return "快捷指令已结束。具体结果以 Mac 上的快捷指令行为为准。";
    }
    throw fail(403, "这个工作流不受支持");
  }

  async close() {
    this.active?.controller.abort();
    await this.active?.promise;
  }
}
