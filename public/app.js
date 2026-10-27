import { mergeState } from './state-update.js';
const nativeWindows = Boolean(window.nearBridgeWindows && window.chrome?.webview);
const nativePost = message => window.chrome.webview.postMessage(message);
const $ = (id) => document.getElementById(id);
const all = (selector) => [...document.querySelectorAll(selector)];
const SVG_NS = "http://www.w3.org/2000/svg";
// role 是协议角色（"mac" = 电脑端，"phone" = 手机浏览器），不代表电脑平台。
let role = "mac";
let snapshot;
let currentView = "transfer";
let filter = "all";
let events;
let pairInfo;
let pairLoading = false;
let pairingTimer;
let toastTimer;
let uploading = false;
let stateSequence = 0;
let pairToken = new URLSearchParams(location.hash.slice(1)).get("pair");
history.replaceState(null, "", location.pathname);
// Windows 宿主状态：仅在原生窗口中由 WebView2 消息更新。
let hostActions = new Set();
let hostQueue = { pending: false, count: 0 };
let hostBluetooth = null;
let nativeSendTimer;
let bluetoothTimer;
let dragDepth = 0;
document.body.classList.toggle("native", nativeWindows);

// 平台只来自 snapshot.platform；旧服务缺失时统一称“电脑”。
const PLATFORM_NAMES = new Map([["windows", "Windows"], ["macos", "Mac"]]);
const FOLDER_ACTIONS = new Map([["windows", "在资源管理器中打开"], ["macos", "在访达中打开"]]);
const platformName = (data) => PLATFORM_NAMES.get(data?.platform) || "";

// 与 Theme.ets / BridgeDesign.swift 相同的色调与哈希，同一快捷指令三端同色。
const TONES = [
  ["#4DA3FF", "#0A6CFF"], ["#7D7AFF", "#4C3FE0"], ["#C77DFF", "#8A3FD9"], ["#FF7EB3", "#F0407A"],
  ["#FF8A70", "#EC4A3B"], ["#FFB35C", "#FF7A00"], ["#6CCBFF", "#1C8FE8"], ["#A3A9B5", "#5F6673"],
];
const GLYPH_RULES = [
  ["camera", ["截图", "截屏", "拍", "相机", "照片"]],
  ["music", ["音乐", "播放", "歌", "音量", "静音", "声音"]],
  ["moon", ["睡眠", "休眠", "勿扰", "专注", "晚安", "夜"]],
  ["lock", ["锁", "离开"]],
  ["doc", ["文档", "笔记", "备忘", "记录", "写"]],
  ["open", ["打开", "网页", "浏览", "链接", "启动"]],
  ["clipboard", ["剪贴板", "复制", "粘贴"]],
  ["download", ["下载", "保存", "备份"]],
  ["sun", ["亮度", "灯", "屏幕", "显示器"]],
];
function stableHash(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 1000003;
  return hash;
}
function glyphFor(name) {
  for (const [key, words] of GLYPH_RULES)
    if (words.some((word) => name.includes(word))) return key;
  return "bolt";
}
const IMAGE_EXT = ["jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "bmp"];
const isImageName = (name) => IMAGE_EXT.includes(String(name || "").split(".").pop().toLowerCase());

function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  toastTimer = setTimeout(
    () => {
      $("toast").hidden = true;
    },
    error ? 6500 : 3800,
  );
}

async function api(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: {
      "X-NearBridge": "1",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "请求未完成");
    error.status = response.status;
    throw error;
  }
  return data;
}
const post = (route, body = {}) => api(route, { method: "POST", body });
const bytes = (value) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KB`
      : value < 1024 ** 3
        ? `${(value / 1024 ** 2).toFixed(1)} MB`
        : `${(value / 1024 ** 3).toFixed(2)} GB`;
function timestamp(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
function clock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
function dayLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", {
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    month: "long",
    day: "numeric",
  }).format(date);
}
function setConnection(text, connected = false, warn = false) {
  $("connection").querySelector("span").textContent = text;
  $("connection").classList.toggle("connected", connected);
  $("connection").classList.toggle("warn", warn && !connected);
}

const VIEW_LABELS = { transfer: "互传", workflows: "快捷指令", pairing: "手机连接", settings: "设置" };
function changeView(view) {
  const changed = currentView !== view;
  currentView = view;
  for (const name of ["transfer", "workflows", "pairing", "settings"])
    $(`${name}-view`).hidden = name !== view;
  all("[data-nav]").forEach((button) => {
    const active = button.dataset.nav === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("page-label").textContent = VIEW_LABELS[view];
  $("pair-banner").hidden = !snapshot?.pending || view === "pairing";
  if (changed) window.scrollTo(0, 0);
  if (view === "pairing") loadPairing();
}
all("[data-nav]").forEach((button) =>
  button.addEventListener("click", () => changeView(button.dataset.nav)),
);
$("nav-device").addEventListener("click", () => changeView("pairing"));
$("pair-details").addEventListener("click", () => changeView("pairing"));
$("banner-review").addEventListener("click", () => changeView("pairing"));
$("workflow-connect").addEventListener("click", () => changeView("pairing"));

function sendTab(kind) {
  for (const name of ["file", "text"]) {
    $(`${name}-tab`).classList.toggle("selected", name === kind);
    $(`${name}-tab`).setAttribute("aria-selected", String(name === kind));
    $(`${name}-tab`).tabIndex = name === kind ? 0 : -1;
    $(`${name}-panel`).hidden = name !== kind;
  }
}
for (const name of ["file", "text"])
  $(`${name}-tab`).addEventListener("click", () => sendTab(name));
// ARIA tabs：左右方向键、Home、End 在两个发送类型之间切换。
document.querySelector(".send-tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = $("file-tab").classList.contains("selected") ? "file" : "text";
  const target = event.key === "Home" ? "file" : event.key === "End" ? "text" : current === "file" ? "text" : "file";
  sendTab(target);
  $(`${target}-tab`).focus();
});
all("[data-filter]").forEach((button) =>
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    all("[data-filter]").forEach((value) => {
      value.classList.toggle("selected", value === button);
      value.setAttribute("aria-pressed", String(value === button));
    });
    renderHistory();
  }),
);

async function confirmAction(title, message, label) {
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm-ok").textContent = label;
  const dialog = $("confirm-dialog");
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "ok"),
      { once: true },
    );
  });
}
$("confirm-cancel").addEventListener("click", () =>
  $("confirm-dialog").close("cancel"),
);
$("confirm-ok").addEventListener("click", () =>
  $("confirm-dialog").close("ok"),
);
$("copy-close").addEventListener("click", () => $("copy-dialog").close());

function linkFrom(text) {
  try {
    const value = new URL(text.trim());
    return ["https:", "http:"].includes(value.protocol) ? value.href : null;
  } catch {
    return null;
  }
}
function makeButton(label, action, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = className;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}
async function copyItem(item) {
  if (role === "mac") {
    await post("/api/mac/clipboard/copy", { id: item.id });
    toast("已复制到电脑剪贴板");
    return;
  }
  try {
    await navigator.clipboard.writeText(item.text);
    toast("已复制，可以粘贴到其他应用");
  } catch {
    $("copy-fallback").value = item.text;
    $("copy-dialog").showModal();
    $("copy-fallback").focus();
    $("copy-fallback").select();
  }
}

function emptyState(iconName, heading, detail) {
  const empty = document.createElement("div");
  empty.className = "history-empty";
  const title = document.createElement("strong");
  title.textContent = heading;
  const subtitle = document.createElement("span");
  subtitle.textContent = detail;
  empty.append(icon(iconName), title, subtitle);
  return empty;
}

function renderHistory() {
  if (!snapshot) return;
  const items = snapshot.items.filter(
    (item) =>
      filter === "all" ||
      (filter === "sent" ? item.source === role : item.source !== role),
  );
  $("item-count").textContent = snapshot.items.length;
  const fragment = document.createDocumentFragment();
  if (!items.length)
    fragment.append(
      snapshot.items.length
        ? emptyState("text", "没有符合筛选的记录", "换一个筛选条件看看。")
        : emptyState(
            "transfer",
            "这里还没有收发记录",
            role === "mac" ? "把文件拖进窗口，或给手机留一段文字。" : "传一张照片，或给电脑留一段文字。",
          ),
    );
  let lastDay = "";
  for (const item of items) {
    const day = dayLabel(item.createdAt);
    if (day && day !== lastDay) {
      const header = document.createElement("div");
      header.className = "history-day";
      header.textContent = day;
      fragment.append(header);
      lastDay = day;
    }
    const outgoing = item.source === role;
    const row = document.createElement("article");
    row.className = "history-row";
    const badge = document.createElement("div");
    badge.className = outgoing ? "item-icon" : "item-icon incoming";
    badge.setAttribute("aria-hidden", "true");
    const direction = document.createElement("span");
    direction.className = "direction";
    direction.append(icon(outgoing ? "up" : "down"));
    badge.append(
      icon(item.kind === "file" ? (isImageName(item.name) ? "image" : "file") : linkFrom(item.text) ? "link" : "text"),
      direction,
    );
    const main = document.createElement("div");
    main.className = "item-main";
    const title = document.createElement("p");
    title.className = "item-title";
    title.textContent = item.kind === "file" ? item.name : item.text;
    const meta = document.createElement("div");
    meta.className = "item-meta";
    const state = document.createElement("span");
    state.textContent =
      outgoing
        ? role === "mac"
          ? item.receivedAt
            ? "发出 · 手机已收取"
            : item.peerId
            ? "发出 · 手机可取用"
            : "暂存 · 待手机配对"
          : "发出 · 已保存到电脑"
        : `收到 · 来自${item.source === "mac" ? "电脑" : snapshot.device?.name || "手机"}`;
    // 回执：手机确认收取后用蓝色勾标出。
    if (outgoing && role === "mac" && item.receivedAt) {
      state.className = "receipt";
      state.prepend(icon("check"));
    }
    const date = document.createElement("span");
    date.textContent = day ? clock(item.createdAt) : timestamp(item.createdAt);
    date.title = timestamp(item.createdAt);
    meta.append(state, date);
    if (item.kind === "file") {
      const size = document.createElement("span");
      size.textContent = bytes(item.size);
      meta.append(size);
    }
    main.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "item-actions";
    if (item.kind === "text") {
      actions.append(makeButton("复制", () => copyItem(item)));
      if (item.text.length > 100 || item.text.split("\n").length > 3) {
        const expand = makeButton("展开", () => {
          const expanded = title.classList.toggle("expanded");
          expand.textContent = expanded ? "收起" : "展开";
          expand.setAttribute("aria-expanded", String(expanded));
        });
        expand.setAttribute("aria-expanded", "false");
        actions.append(expand);
      }
      if (linkFrom(item.text)) {
        if (role === "mac")
          actions.append(
            makeButton("打开", () =>
              post("/api/mac/open-link", { id: item.id }),
            ),
          );
        else {
          const link = document.createElement("a");
          link.textContent = "打开";
          link.href = linkFrom(item.text);
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          actions.append(link);
        }
      }
    } else {
      if (nativeWindows) actions.append(makeButton("所在目录", () => post("/api/mac/reveal-file", { id: item.id })));
      else {
      const download = document.createElement("a");
      download.textContent = "下载";
      download.href = `/api/files/${item.id}`;
      download.download = item.name;
      actions.append(download);
      }
    }
    if (role === "mac") {
      const remove = makeButton(
        "",
        async () => {
          if (
            await confirmAction(
              "删除这条记录？",
              item.kind === "file"
                ? "这也会删除 NearBridge 保存的文件副本；原来用于发送的文件不会受影响。"
                : "这段文字会从两端的 NearBridge 记录中移除。",
              "删除",
            )
          ) {
            await api(`/api/items/${item.id}`, { method: "DELETE" });
            await refreshState();
          }
        },
        "remove",
      );
      remove.append(icon("close"));
      remove.title = "删除";
      remove.setAttribute(
        "aria-label",
        `删除${item.kind === "file" ? item.name : "文字记录"}`,
      );
      actions.append(remove);
    }
    row.append(badge, main, actions);
    fragment.append(row);
  }
  $("history").replaceChildren(fragment);
}

async function refreshState() {
  const sequence = ++stateSequence;
  const data = await api("/api/state");
  if (sequence !== stateSequence) return;
  renderState(mergeState(snapshot, { revision: data.revision, state: data }));
}
function renderState(data) {
  $("app-version").textContent = `本地运行 · v${data.version}`;
  const previous = snapshot;
  snapshot = data;
  const platform = platformName(data);
  const phoneOnline = Boolean(data.paired && data.device?.connected);
  $("recipient").textContent =
    role === "phone"
      ? data.name
      : data.paired
        ? data.device.name +
          (data.device.connected ? " · 已连接" : " · 离线时可先暂存")
        : "可以先放入文件，手机连接后取用";
  $("recipient-kicker").textContent = role === "phone" ? `手机 → ${platform || "电脑"}` : "这台电脑 → 手机";
  $("brand-platform").textContent = platform ? `${platform} 版` : "本地互联";
  $("computer-platform").textContent = platform || "电脑";
  $("crumb-root").textContent = data.name || "NearBridge";
  $("settings-inbox").textContent = FOLDER_ACTIONS.get(data.platform) || "打开收件目录";
  $("mac-name").textContent = data.name;
  $("phone-name").textContent = data.paired ? data.device.name : "等待手机";
  $("phone-state").textContent = data.paired
    ? data.device.connected
      ? "在线 · 可收发"
      : "已配对 · 等待手机打开 NearBridge"
    : "扫码完成首次连接";
  $("phone-dot").classList.toggle("online", phoneOnline);
  const deviceState = data.paired ? (phoneOnline ? "已连接" : "不在线") : data.pending ? "有配对请求" : "尚未配对";
  $("nav-device-name").textContent = data.paired ? data.device.name : "连接手机";
  $("nav-device-state").textContent = deviceState;
  $("nav-device-dot").className = `dot${phoneOnline ? " online" : data.pending ? " warn" : ""}`;
  $("nav-device").setAttribute("aria-label", `手机：${data.paired ? data.device.name : "未连接"}，${deviceState}。打开手机连接`);
  $("mini-pairing").hidden = Boolean(data.paired);
  $("paired-summary").hidden = !data.paired;
  $("paired-summary").textContent = data.paired
    ? `已配对：${data.device.name}。手机可以收藏连接页面；更换手机时请先在设置中解除配对。`
    : "";
  $("refresh-pairing").disabled = data.paired || (nativeWindows && Boolean(data.pending));
  if (nativeWindows) $("network-select").disabled = Boolean(data.pending);
  $("pending-pairing").hidden = !data.pending;
  $("pair-banner").hidden = !data.pending || currentView === "pairing";
  if (data.pending) {
    $("pending-name").textContent = `${data.pending.name} 想要连接`;
    $("banner-name").textContent = data.pending.name;
  }
  if (role === "mac") {
    $("auto-copy").checked = data.settings.copyIncomingText;
    $("inbox-path").textContent = data.inbox;
    $("storage-usage").textContent =
      `${bytes(data.limits.usedStorage)} / ${bytes(data.limits.maxStorage)}，包含收件与待手机取用的文件副本。`;
    $("revoke-description").textContent = data.paired
      ? `${data.device.name} 可以收发内容。解除后需要重新扫码。`
      : "尚未配对手机";
    $("revoke-device").disabled = !data.paired;
    if (
      !pairInfo ||
      previous?.paired !== data.paired ||
      previous?.pending?.id !== data.pending?.id
    )
      loadPairing();
  }
  $("file-limit").textContent =
    `单个文件最高 ${bytes(data.limits.maxFileSize)}`;
  setConnection(
    role === "phone"
      ? "已连接电脑"
      : data.device?.connected
        ? "手机已连接"
        : data.paired
          ? "等待手机上线"
          : "本机已就绪",
    role === "phone" || Boolean(data.device?.connected),
  );
  renderHistory();
  renderWorkflows();
}

function renderWorkflows() {
  const busy = snapshot.jobs.some((job) => job.status === "running");
  $("workflow-connection").textContent =
    role === "phone"
      ? `${snapshot.name} · 可执行`
      : snapshot.device?.connected
        ? `${snapshot.device.name} 已连接，可从手机触发`
        : "可以先在电脑试运行，再连接手机";
  $("workflow-dot").classList.toggle(
    "online",
    role === "phone" || Boolean(snapshot.device?.connected),
  );
  const fragment = document.createDocumentFragment();
  snapshot.workflows.forEach((workflow) => {
    const row = document.createElement("div");
    row.className = "workflow-row";
    row.classList.toggle("disabled", !workflow.enabled);
    const [top, bottom] = TONES[stableHash(String(workflow.id)) % TONES.length];
    const tile = document.createElement("span");
    tile.className = "tone-tile";
    tile.setAttribute("aria-hidden", "true");
    tile.style.setProperty("--tone-top", top);
    tile.style.setProperty("--tone-bottom", bottom);
    tile.append(icon(glyphFor(String(workflow.name))));
    const text = document.createElement("div");
    text.className = "workflow-description";
    const name = document.createElement("h2");
    name.textContent = workflow.name;
    const description = document.createElement("p");
    description.textContent = workflow.description;
    text.append(name, description);
    const actions = document.createElement("div");
    actions.className = "workflow-actions";
    if (role === "mac") {
      const label = document.createElement("label");
      label.className = "workflow-toggle";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "switch";
      input.setAttribute("role", "switch");
      input.checked = workflow.enabled;
      input.setAttribute("aria-label", `在手机启用${workflow.name}`);
      input.addEventListener("change", async () => {
        try {
          await post("/api/mac/workflows/enable", {
            id: workflow.id,
            enabled: input.checked,
          });
          await refreshState();
        } catch (error) {
          toast(error.message, true);
          input.checked = !input.checked;
        }
      });
      label.append(document.createTextNode("手机可用"), input);
      actions.append(label);
    }
    const run = makeButton(
      role === "mac" ? "试运行" : "运行",
      async () => {
        if (nativeWindows) { nativePost({ type: "workflow", id: workflow.id }); return; }
        const requestId = crypto.randomUUID
          ? crypto.randomUUID()
          : Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
              value.toString(16).padStart(2, "0"),
            ).join("");
        await post(`/api/workflows/${workflow.id}/run`, { requestId });
        await refreshState();
        toast("请求已交给电脑，执行结果会显示在下方");
      },
      role === "mac" ? "quiet" : "primary",
    );
    run.prepend(icon("play"));
    run.disabled = !workflow.enabled || busy;
    run.setAttribute(
      "aria-label",
      `${role === "mac" ? "试运行" : "运行"}：${workflow.name}`,
    );
    actions.append(run);
    row.append(tile, text, actions);
    fragment.append(row);
  });
  if (!snapshot.workflows.length)
    fragment.append(
      role === "mac"
        ? emptyState("bolt", "还没有快捷指令", "用下方的“载入”把电脑上的快捷指令加入手机面板。")
        : emptyState("bolt", "电脑还没有开放快捷指令", "请先在电脑的 NearBridge 中启用。"),
    );
  $("workflow-list").replaceChildren(fragment);
  const jobs = document.createDocumentFragment();
  for (const job of snapshot.jobs) {
    const row = document.createElement("div");
    row.className = "job-row";
    const state = document.createElement("span");
    state.className = `job-status ${job.status}`;
    state.textContent = {
      running: "执行中",
      queued: "等待中",
      pending: "等待中",
      succeeded: "已完成",
      failed: "未完成",
      interrupted: "已中断",
    }[job.status] || job.status;
    const main = document.createElement("div");
    main.className = "job-main";
    const name = document.createElement("strong");
    name.textContent = job.name;
    const detail = document.createElement("p");
    detail.textContent = job.message;
    main.append(name, detail);
    const time = document.createElement("small");
    time.textContent = timestamp(job.createdAt);
    row.append(state, main, time);
    jobs.append(row);
  }
  if (!snapshot.jobs.length)
    jobs.append(emptyState("check", "还没有执行记录", "点一个按钮，电脑就会开始处理。"));
  $("workflow-jobs").replaceChildren(jobs);
}

$("load-shortcuts").addEventListener("click", async () => {
  $("load-shortcuts").disabled = true;
  try {
    const result = await api("/api/mac/shortcuts");
    $("shortcut-picker").hidden = false;
    $("shortcut-select").replaceChildren(
      ...result.shortcuts.map((shortcut) => {
        const option = document.createElement("option");
        option.value = shortcut.id;
        option.textContent = shortcut.name;
        return option;
      }),
    );
    $("add-shortcut").disabled = !result.shortcuts.length;
    $("shortcut-hint").textContent = result.shortcuts.length
      ? `加入后，已配对手机可以直接执行。指令自身的授权和确认仍由${platformName(snapshot) || "电脑"}处理。`
      : nativeWindows ? "打开快捷方式目录，放入 .lnk 快捷方式后重新载入。" : "没有找到快捷指令，请先在电脑配置后重新载入。";
  } catch (error) {
    toast(error.message, true);
  } finally {
    $("load-shortcuts").disabled = false;
  }
});
$("add-shortcut").addEventListener("click", async () => {
  const name = $("shortcut-select").selectedOptions[0]?.textContent;
  if (
    !name ||
    !(await confirmAction(
      "把这个快捷指令交给手机触发？",
      `「${name}」加入后，配对手机点按就会在电脑执行。请先确认指令的具体作用，尤其是发送消息、删除文件或账户操作。`,
      "加入面板",
    ))
  )
    return;
  try {
    await post("/api/mac/workflows/shortcut", {
      id: $("shortcut-select").value,
    });
    await refreshState();
    toast("已加入手机快捷指令面板");
  } catch (error) {
    toast(error.message, true);
  }
});

async function loadPairing(force = false) {
  if (role !== "mac" || pairLoading) return;
  pairLoading = true;
  try {
    let data = await api(
      `/api/pairing?ip=${encodeURIComponent($("network-select").value)}`,
    );
    if (nativeWindows) {
      if ((!pairInfo || force === true) && !snapshot?.paired && !snapshot?.pending)
        data = { ...data, ...await post(`/api/pairing/native?ip=${encodeURIComponent($("network-select").value)}`) };
      else data = { ...data, ...pairInfo, links: data.links };
    }
    pairInfo = data;
    for (const id of ["mini-qr", "large-qr"]) {
      $(id).hidden = !data.qr || snapshot?.paired;
      if (data.qr) $(id).src = data.qr;
    }
    const selected = $("network-select").value;
    $("network-select").replaceChildren(
      ...data.links.map((value) => {
        const option = document.createElement("option");
        option.value = value.ip;
        option.textContent = `${value.ip} · ${value.name}`;
        return option;
      }),
    );
    if (data.links.some((value) => value.ip === selected))
      $("network-select").value = selected;
    $("pairing-address").textContent = data.url
      ? data.url.split("#")[0]
      : data.links.length
        ? "等待配对结果"
        : "未发现局域网地址，请连接 Wi-Fi 后重启 NearBridge。";
    $("fingerprint").textContent = data.fingerprint || "";
    $("mini-pair-caption").textContent = data.qr
      ? nativeWindows ? "在手机 NearBridge 点“添加电脑”，扫描此码" : "用手机扫描，连接这台电脑"
      : data.links.length
        ? "手机已请求连接，请在电脑确认"
        : "连接 Wi-Fi 后重启，以生成二维码";
    renderPairExpiry();
  } catch (error) {
    toast(error.message, true);
  } finally {
    pairLoading = false;
  }
}
function renderPairExpiry() {
  if (!pairInfo) return;
  const remaining = Math.max(
    0,
    Math.ceil((pairInfo.expiresAt - Date.now()) / 60000),
  );
  $("pairing-expiry").textContent = snapshot?.paired
    ? "已配对，无需重复扫码"
    : remaining
      ? `二维码 ${remaining} 分钟内有效`
      : "二维码已过期，请刷新";
  if (!remaining && !snapshot?.paired) {
    $("mini-qr").hidden = true;
    $("large-qr").hidden = true;
    $("mini-pair-caption").textContent = "二维码已过期，请刷新";
  }
}
setInterval(renderPairExpiry, 10000);
$("network-select").addEventListener("change", () => loadPairing(true));
$("refresh-pairing").addEventListener("click", async () => {
  try {
    if (!nativeWindows) await post("/api/pairing/refresh");
    await loadPairing(true);
    toast("二维码已刷新");
  } catch (error) {
    toast(error.message, true);
  }
});
for (const action of ["approve", "reject"])
  $(`${action}-pair`).addEventListener("click", async () => {
    try {
      await post(`/api/pair/${action}`, { id: snapshot.pending.id });
      await refreshState();
      toast(
        action === "approve" ? "已允许配对，等待手机完成连接" : "已拒绝配对",
      );
    } catch (error) {
      toast(error.message, true);
    }
  });
$("auto-copy").addEventListener("change", async () => {
  try {
    await post("/api/settings", { copyIncomingText: $("auto-copy").checked });
    await refreshState();
  } catch (error) {
    toast(error.message, true);
    await refreshState();
  }
});
for (const id of ["inbox-button", "settings-inbox"])
  $(id).addEventListener("click", async () => {
    try {
      await post("/api/mac/inbox");
    } catch (error) {
      toast(error.message, true);
    }
  });
$("revoke-device").addEventListener("click", async () => {
  if (
    !(await confirmAction(
      "解除手机配对？",
      "手机将立即失去收发权限。现有文件和文字保留在电脑；再次连接需要重新扫码。",
      "解除配对",
    ))
  )
    return;
  try {
    await post("/api/device/revoke");
    pairInfo = null;
    await refreshState();
    toast("已解除配对");
  } catch (error) {
    toast(error.message, true);
  }
});

// 原生窗口：文字交给宿主后等待回执；只改按钮状态，不改发送与重试逻辑。
function setNativeSending(sending) {
  clearTimeout(nativeSendTimer);
  const button = $("text-send");
  button.disabled = sending;
  button.classList.toggle("is-busy", sending);
  button.setAttribute("aria-busy", String(sending));
  if (sending) nativeSendTimer = setTimeout(() => setNativeSending(false), 20000);
}
$("text-panel").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (nativeWindows) {
    if (!$("message").value.trim()) { toast("先输入要发送的文字或链接", true); $("message").focus(); return; }
    setNativeSending(true);
    nativePost({ type: "text", text: $("message").value });
    return;
  }
  const button = $("text-send");
  button.disabled = true;
  try {
    const data = await post("/api/items", { text: $("message").value });
    $("message").value = "";
    toast(
      data.clipboardCopied
        ? "已送到电脑，并复制到剪贴板"
        : role === "mac"
          ? "已放入手机可取用的收件箱"
          : "文字已送到电脑",
    );
    await refreshState();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("message").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
  event.preventDefault();
  if (!$("text-send").disabled) $("text-panel").requestSubmit();
});
$("clipboard-send").addEventListener("click", async () => {
  if (nativeWindows) { nativePost({ type: "clipboard" }); return; }
  $("clipboard-send").disabled = true;
  try {
    await post("/api/mac/clipboard/send");
    await refreshState();
    toast("电脑剪贴板文字已发送");
  } catch (error) {
    toast(error.message, true);
  } finally {
    $("clipboard-send").disabled = false;
  }
});

function uploadFile(file, position, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.setRequestHeader("X-NearBridge", "1");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-File-Size", String(file.size));
    xhr.timeout = 10 * 60000;
    $("upload-name").textContent = file.name;
    $("upload-progress").value = 0;
    $("upload-percent").textContent = "0%";
    $("upload-detail").textContent =
      `第 ${position} / ${total} 个 · ${bytes(file.size)}`;
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const progress = Math.round((event.loaded / event.total) * 100);
      $("upload-progress").value = progress;
      $("upload-percent").textContent =
        progress === 100 ? "正在确认…" : `${progress}%`;
    });
    xhr.addEventListener("load", () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error("服务器响应无效，请重试"));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || "文件发送失败"));
    });
    xhr.addEventListener("error", () =>
      reject(new Error("连接中断，请重新选择文件发送")),
    );
    xhr.addEventListener("timeout", () =>
      reject(new Error("传输超时，请检查网络后重试")),
    );
    xhr.addEventListener("abort", () => reject(new Error("传输已取消")));
    xhr.send(file);
  });
}
async function sendFiles(files) {
  if (nativeWindows) {
    if (files.length) window.chrome.webview.postMessageWithAdditionalObjects({ type: "files" }, files);
    return;
  }
  if (uploading || !files.length) return;
  uploading = true;
  $("file-input").disabled = true;
  $("dropzone").setAttribute("aria-disabled", "true");
  $("upload-status").hidden = false;
  sendTab("file");
  let complete = 0;
  try {
    for (const file of files) {
      if (file.size > snapshot.limits.maxFileSize)
        throw new Error(
          `${file.name} 超过 ${bytes(snapshot.limits.maxFileSize)} 上限`,
        );
      await uploadFile(file, complete + 1, files.length);
      complete++;
    }
    $("upload-progress").value = 100;
    $("upload-percent").textContent = "已完成";
    $("upload-detail").textContent =
      role === "mac"
        ? `${complete} 个文件已暂存，手机可下载保存`
        : `${complete} 个文件已保存到电脑收件目录`;
    toast(role === "mac" ? "文件已准备好，手机可取用" : "文件已送到电脑");
  } catch (error) {
    $("upload-percent").textContent = "未全部完成";
    $("upload-detail").textContent =
      `已完成 ${complete} / ${files.length}。${error.message}`;
    toast(error.message, true);
  } finally {
    uploading = false;
    $("file-input").disabled = false;
    $("file-input").value = "";
    $("dropzone").setAttribute("aria-disabled", "false");
    await refreshState().catch(() => {});
  }
}
$("dropzone").addEventListener("click", () => {
  if (!uploading) $("file-input").click();
});
$("dropzone").addEventListener("keydown", (event) => {
  if (["Enter", " "].includes(event.key)) {
    event.preventDefault();
    if (!uploading) $("file-input").click();
  }
});
$("file-input").addEventListener("change", (event) =>
  sendFiles([...event.target.files]),
);
$("dropzone").addEventListener("dragover", (event) => {
  event.preventDefault();
  $("dropzone").classList.add("dragging");
});
$("dropzone").addEventListener("dragleave", () =>
  $("dropzone").classList.remove("dragging"),
);
$("dropzone").addEventListener("drop", (event) => {
  event.preventDefault();
  $("dropzone").classList.remove("dragging");
  sendFiles([...event.dataTransfer.files]);
});
$("choose-folder").addEventListener("click", () => {
  if (nativeWindows) nativePost({ type: "chooseFolder" });
});

// 整窗投放：文件拖到窗口任意位置即可发送。投放区自己的处理保持不变，这里跳过投放区内的放下事件。
const draggingFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
const canDropAnywhere = () => Boolean(snapshot) && !uploading && !document.querySelector("dialog[open]");
function showDropOverlay(show) {
  if (show) {
    $("drop-title").textContent =
      role === "mac"
        ? `松手，发到 ${snapshot?.paired ? snapshot.device.name : "手机"}`
        : `松手，发到 ${snapshot?.name || "电脑"}`;
    $("drop-detail").textContent =
      role === "mac" && snapshot?.paired && !snapshot.device?.connected
        ? "手机现在不在线，文件会先排队"
        : "支持一次放入多个文件";
  }
  $("drop-overlay").hidden = !show;
}
document.addEventListener("dragenter", (event) => {
  if (!draggingFiles(event) || !canDropAnywhere()) return;
  dragDepth++;
  showDropOverlay(true);
});
document.addEventListener("dragleave", (event) => {
  if (!draggingFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  const outside = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= innerWidth || event.clientY >= innerHeight;
  if (!dragDepth || outside) {
    dragDepth = 0;
    showDropOverlay(false);
  }
});
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  showDropOverlay(false);
  if (event.target instanceof Element && event.target.closest("#dropzone")) return;
  if (!canDropAnywhere() || !event.dataTransfer?.files.length) return;
  changeView("transfer");
  sendTab("file");
  sendFiles([...event.dataTransfer.files]);
});
// Ctrl+O：选择文件（电脑端）。
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "o") return;
  if (!snapshot || role !== "mac" || uploading || document.querySelector("dialog[open]")) return;
  event.preventDefault();
  changeView("transfer");
  sendTab("file");
  $("file-input").click();
});

function listenEvents() {
  if (nativeWindows) { listenNative(); return; }
  events?.close();
  events = new EventSource("/api/events");
  events.addEventListener("change", () =>
    refreshState().catch((error) => {
      if (error.status === 401) showPhonePairing();
      else setConnection("连接已中断", false, true);
    }),
  );
  events.addEventListener("error", async () => {
    setConnection("正在重新连接", false, true);
    try {
      const info = await api("/api/bootstrap");
      if (!info.authenticated) showPhonePairing();
    } catch {}
  });
}
function showPhonePairing() {
  events?.close();
  snapshot = null;
  $("mobile-workspace-nav").hidden = true;
  for (const view of ["transfer", "workflows", "pairing", "settings"])
    $(`${view}-view`).hidden = true;
  $("pair-phone").hidden = false;
  $("pair-submit").disabled = !pairToken;
  if (!pairToken) {
    $("pair-intro").textContent =
      "在电脑的 NearBridge「手机连接」页刷新二维码，再用这台手机扫描。";
    $("pair-form").hidden = true;
  }
  setConnection("尚未配对");
}
async function enterWorkspace() {
  $("pair-phone").hidden = true;
  $("mobile-workspace-nav").hidden = role !== "phone";
  $("loading").hidden = true;
  changeView(nativeWindows ? "transfer" : "workflows");
  await refreshState();
  listenEvents();
}
async function pollPair(claim) {
  try {
    const data = await api(
      `/api/pair/status?id=${encodeURIComponent(claim.id)}`,
      { headers: { "X-Pair-Claim": claim.claim } },
    );
    if (data.status === "approved") {
      sessionStorage.removeItem("nearbridge-pair");
      pairToken = null;
      await enterWorkspace();
      toast("配对成功，可以开始收发");
      return;
    }
    if (data.status === "rejected")
      throw new Error("电脑已拒绝请求，请刷新二维码后重试");
    pairingTimer = setTimeout(() => pollPair(claim), 1500);
  } catch (error) {
    sessionStorage.removeItem("nearbridge-pair");
    $("pair-status").textContent = error.message;
    $("pair-submit").disabled = false;
  }
}
$("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("pair-submit").disabled = true;
  try {
    const claim = await post("/api/pair", {
      token: pairToken,
      name: $("device-name").value,
    });
    pairToken = null;
    sessionStorage.setItem("nearbridge-pair", JSON.stringify(claim));
    $("pair-status").hidden = false;
    $("pair-status").textContent = "请求已发送，请在电脑点击「允许配对」。";
    clearTimeout(pairingTimer);
    pollPair(claim);
  } catch (error) {
    $("pair-submit").disabled = false;
    toast(error.message, true);
  }
});

let nativeListening = false;
async function listenNative() {
  if (nativeListening) return;
  nativeListening = true;
  let failures = 0;
  while (nativeListening) {
    try {
      if (!snapshot?.revision) await refreshState();
      const base = snapshot;
      const update = await api(`/api/changes?since=${encodeURIComponent(base.revision)}&mode=delta-v1`);
      // A manual refresh can supersede the baseline while the request waits.
      if (snapshot === base) renderState(mergeState(base, update));
      failures = 0;
    } catch {
      setConnection("正在重新连接", false, true);
      await new Promise(resolve => setTimeout(resolve, Math.min(15000, 1000 * 2 ** Math.min(failures++, 4))));
      await refreshState().catch(() => {});
    }
  }
}

// Windows 宿主：队列 / 回执条、蓝牙开关、能力声明。未声明的动作不显示入口，原生工具条继续提供。
function renderHost() {
  if (!nativeWindows) return;
  const { pending, count } = hostQueue;
  $("host-status").hidden = !pending && !(count > 0);
  $("host-status").classList.toggle("pending", pending);
  $("host-status-text").textContent = pending ? "有一项操作还在等待确认" : `${count} 个文件在待发队列`;
  $("host-status-detail").textContent = pending
    ? "重试会继续同一项操作，不会因回执丢失而重复发送或执行。"
    : "手机上线后会继续发送，也可以现在重试。";
  $("host-retry").textContent = pending ? "重试确认" : "重试发送";
  $("host-forget").hidden = !pending || !hostActions.has("forget");
  const canToggle = hostActions.has("bluetooth");
  $("bluetooth-row").hidden = !hostBluetooth && !canToggle;
  $("bluetooth-toggle").hidden = !canToggle;
  $("bluetooth-toggle").checked = Boolean(hostBluetooth?.enabled);
  $("bluetooth-state").textContent =
    hostBluetooth?.message || (hostBluetooth?.enabled ? "已开启，手机可在“连接方式”里选择这台电脑" : "未开启");
  $("link-route").textContent = hostBluetooth?.enabled ? "本地加密 · 局域网或蓝牙" : "本地加密传输";
  $("open-workflows").hidden = !hostActions.has("openWorkflows");
}
for (const id of ["host-retry", "settings-retry"])
  $(id).addEventListener("click", () => {
    if (!nativeWindows) return;
    nativePost({ type: "retry" });
    toast("已开始重试");
  });
$("host-forget").addEventListener("click", async () => {
  if (!hostActions.has("forget")) return;
  if (
    await confirmAction(
      "结束重试？",
      "这不会撤销电脑或手机上已经执行的操作。请先检查结果；结束后再次点按会发起一项新操作。",
      "已检查，结束重试",
    )
  )
    nativePost({ type: "forget" });
});
$("bluetooth-toggle").addEventListener("change", () => {
  const toggle = $("bluetooth-toggle");
  const wanted = toggle.checked;
  if (toggle.hidden || !hostActions.has("bluetooth")) { toggle.checked = !wanted; return; }
  toggle.disabled = true;
  $("bluetooth-state").textContent = wanted ? "正在开启…" : "正在关闭…";
  nativePost({ type: "bluetooth", enabled: wanted });
  clearTimeout(bluetoothTimer);
  bluetoothTimer = setTimeout(() => { toggle.disabled = false; renderHost(); }, 10000);
});
$("open-workflows").addEventListener("click", () => {
  if (hostActions.has("openWorkflows")) nativePost({ type: "openWorkflows" });
});

if (nativeWindows) {
  window.chrome.webview.addEventListener('message', event => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'error') {
      setNativeSending(false);
      clearTimeout(bluetoothTimer);
      $("bluetooth-toggle").disabled = false;
      renderHost();
      toast(data.message, true);
    }
    if (data.type === 'actionComplete') {
      setNativeSending(false);
      if (data.text === $("message").value) $("message").value = '';
      toast('电脑已确认接收，结果可在记录中查看');
      refreshState().catch(() => {});
    }
    if (data.type === 'upload') {
      $("upload-status").hidden = false; $("upload-name").textContent = data.name;
      $("upload-progress").value = data.progress; $("upload-percent").textContent = `${data.progress}%`;
      $("upload-detail").textContent = '正在存入待发队列，支持中断后重试';
    }
    if (data.type === 'queued') {
      $("upload-percent").textContent = '已加入待发队列';
      $("upload-detail").textContent = '等待手机保存并校验后，记录会显示“手机已收取”。';
      refreshState().catch(() => {});
    }
    if (data.type === 'queue') {
      const wasPending = hostQueue.pending;
      hostQueue = { pending: Boolean(data.pending), count: Number.isFinite(data.count) ? data.count : hostQueue.count };
      if (data.pending) setNativeSending(false);
      renderHost();
      if (data.pending && !wasPending) toast('有操作结果尚未确认，可以在页面上方点“重试确认”。', true);
    }
    if (data.type === 'bluetooth') {
      hostBluetooth = { message: String(data.message || ''), enabled: Boolean(data.enabled) };
      clearTimeout(bluetoothTimer);
      $("bluetooth-toggle").disabled = false;
      renderHost();
    }
    if (data.type === 'host') {
      hostActions = new Set(Array.isArray(data.actions) ? data.actions.filter(action => typeof action === 'string') : []);
      renderHost();
    }
  });
  document.querySelector('.pairing-guide ol').innerHTML = '<li><strong>打开手机 NearBridge，点“添加电脑”</strong><p>手机和这台电脑连接同一个 Wi‑Fi。手机里已添加的其他电脑会保留。</p></li><li><strong>扫描此原生配对码</strong><p>证书和公钥随配对绑定，无需关闭证书验证。</p></li><li><strong>在电脑点击“允许配对”</strong><p>只确认你手边的手机，之后即可双向收发。</p></li>';
  $("scope-text").textContent = '鸿蒙端收发时请保持 NearBridge 前台运行。关闭窗口后 NearBridge 仍在托盘运行；电脑需保持唤醒。';
  $("builder-title").textContent = '添加 Windows 快捷方式';
  $("builder-description").textContent = '把你选定的 .lnk 快捷方式放进快捷方式目录，再载入并加入手机面板。手机只能触发已启用的项目。';
  $("load-shortcuts").replaceChildren(icon("retry"), "载入快捷方式");
}

async function initialize() {
  try {
    const info = await api("/api/bootstrap");
    role = info.role;
    document.body.classList.toggle("phone", role === "phone");
    $("loading").hidden = true;
    if (role === "phone") {
      $("send-title").textContent = "发送到电脑";
      $("recipient-kicker").textContent = "手机 → 电脑";
      $("footer-detail").textContent = "收发时请保持页面打开。";
    }
    if (info.authenticated) await enterWorkspace();
    else {
      showPhonePairing();
      const saved = sessionStorage.getItem("nearbridge-pair");
      if (saved) {
        $("pair-status").hidden = false;
        $("pair-status").textContent = "正在恢复配对请求…";
        pollPair(JSON.parse(saved));
      }
    }
  } catch (error) {
    $("loading").hidden = false;
    $("loading").textContent =
      `连接没有完成：${error.message}。请确认电脑上的 NearBridge 正在运行，然后刷新。`;
    setConnection("未连接", false, true);
  }
}
initialize();
