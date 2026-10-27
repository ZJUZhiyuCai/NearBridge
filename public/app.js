import { mergeState } from './state-update.js';
const nativeWindows = Boolean(window.nearBridgeWindows && window.chrome?.webview);
const nativePost = message => window.chrome.webview.postMessage(message);
const $ = (id) => document.getElementById(id);
const all = (selector) => [...document.querySelectorAll(selector)];
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
function setConnection(text, connected = false) {
  $("connection").querySelector("span").textContent = text;
  $("connection").classList.toggle("connected", connected);
}

function changeView(view) {
  currentView = view;
  for (const name of ["transfer", "workflows", "pairing", "settings"])
    $(`${name}-view`).hidden = name !== view;
  all("[data-nav]").forEach((button) =>
    button.classList.toggle("active", button.dataset.nav === view),
  );
  $("page-label").textContent = {
    transfer: "收发",
    workflows: "工作流",
    pairing: "设备连接",
    settings: "偏好设置",
  }[view];
  $("pair-banner").hidden = !snapshot?.pending || view === "pairing";
  if (view === "pairing") loadPairing();
}
all("[data-nav]").forEach((button) =>
  button.addEventListener("click", () => changeView(button.dataset.nav)),
);
$("pair-details").addEventListener("click", () => changeView("pairing"));
$("banner-review").addEventListener("click", () => changeView("pairing"));
$("workflow-connect").addEventListener("click", () => changeView("pairing"));

function sendTab(kind) {
  for (const name of ["file", "text"]) {
    $(`${name}-tab`).classList.toggle("selected", name === kind);
    $(`${name}-tab`).setAttribute("aria-selected", String(name === kind));
    $(`${name}-panel`).hidden = name !== kind;
  }
}
for (const name of ["file", "text"])
  $(`${name}-tab`).addEventListener("click", () => sendTab(name));
all("[data-filter]").forEach((button) =>
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    all("[data-filter]").forEach((value) =>
      value.classList.toggle("selected", value === button),
    );
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

function renderHistory() {
  if (!snapshot) return;
  const items = snapshot.items.filter(
    (item) =>
      filter === "all" ||
      (filter === "sent" ? item.source === role : item.source !== role),
  );
  $("item-count").textContent = snapshot.items.length;
  const fragment = document.createDocumentFragment();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    const title = document.createElement("strong");
    title.textContent = "这里还没有收发记录";
    const subtitle = document.createElement("span");
    subtitle.textContent = "传一张照片，或给另一台设备留一段文字。";
    empty.append(title, subtitle);
    fragment.append(empty);
  }
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "history-row";
    const icon = document.createElement("div");
    icon.className = "item-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent =
      item.kind === "file" ? "↧" : linkFrom(item.text) ? "↗" : "T";
    const main = document.createElement("div");
    main.className = "item-main";
    const title = document.createElement("p");
    title.className = "item-title";
    title.textContent = item.kind === "file" ? item.name : item.text;
    const meta = document.createElement("div");
    meta.className = "item-meta";
    const direction = document.createElement("span");
    direction.textContent =
      item.source === role
        ? role === "mac"
          ? item.receivedAt
            ? "发出 · 手机已收取"
            : item.peerId
            ? "发出 · 手机可取用"
            : "暂存 · 待手机配对"
          : "发出 · 已保存到电脑"
        : `收到 · 来自${item.source === "mac" ? " 电脑" : "手机"}`;
    const date = document.createElement("span");
    date.textContent = timestamp(item.createdAt);
    meta.append(direction, date);
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
      if (item.text.length > 100 || item.text.split("\n").length > 3)
        actions.append(
          makeButton("展开", () => {
            title.classList.toggle("expanded");
          }),
        );
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
        "×",
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
      remove.setAttribute(
        "aria-label",
        `删除${item.kind === "file" ? item.name : "文字记录"}`,
      );
      actions.append(remove);
    }
    row.append(icon, main, actions);
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
  document.querySelector('.sidebar-bottom small').textContent = `本地运行 · v${data.version}`;
  const previous = snapshot;
  snapshot = data;
  $("recipient").textContent =
    role === "phone"
      ? data.name
      : data.paired
        ? data.device.name +
          (data.device.connected ? " · 已连接" : " · 离线时可先暂存")
        : "可以先放入文件，手机连接后取用";
  $("mac-name").textContent = data.name;
  $("phone-name").textContent = data.paired ? data.device.name : "等待华为手机";
  $("phone-state").textContent = data.paired
    ? data.device.connected
      ? "在线 · 可收发"
      : "已配对 · 等待手机打开页面"
    : "扫码完成首次连接";
  $("phone-dot").classList.toggle(
    "online",
    Boolean(data.paired && data.device.connected),
  );
  $("mini-pairing").hidden = Boolean(data.paired);
  $("paired-summary").hidden = !data.paired;
  $("paired-summary").textContent = data.paired
    ? `已配对：${data.device.name}。手机可以收藏连接页面；更换手机时请先在偏好设置中解除配对。`
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
  snapshot.workflows.forEach((workflow, index) => {
    const row = document.createElement("div");
    row.className = "workflow-row";
    row.classList.toggle("disabled", !workflow.enabled);
    const number = document.createElement("span");
    number.className = "workflow-number";
    number.textContent = String(index + 1).padStart(2, "0");
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
      label.append(input, document.createTextNode("手机可用"));
      actions.append(label);
    }
    const run = makeButton(
      role === "mac" ? "试运行 ▷" : "运行 ▷",
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
      "primary",
    );
    run.disabled = !workflow.enabled || busy;
    run.setAttribute(
      "aria-label",
      `${role === "mac" ? "试运行" : "运行"}：${workflow.name}`,
    );
    actions.append(run);
    row.append(number, text, actions);
    fragment.append(row);
  });
  if (!snapshot.workflows.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "电脑尚未启用工作流，请先在电脑面板选择。";
    fragment.append(empty);
  }
  $("workflow-list").replaceChildren(fragment);
  const jobs = document.createDocumentFragment();
  for (const job of snapshot.jobs) {
    const row = document.createElement("div");
    row.className = "job-row";
    const state = document.createElement("span");
    state.className = `job-status ${job.status}`;
    state.textContent = {
      running: "执行中",
      succeeded: "已完成",
      failed: "未完成",
      interrupted: "已中断",
    }[job.status];
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
  if (!snapshot.jobs.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "还没有执行记录。点一个按钮，电脑就会开始处理。";
    jobs.append(empty);
  }
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
      ? "加入后，已配对手机可以直接执行。指令自身的授权和确认仍由 Windows 处理。"
      : nativeWindows ? "从窗口顶部打开“快捷方式目录”，放入 .lnk 快捷方式后重新载入。" : "没有找到快捷指令，请先在电脑配置后重新载入。";
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
    toast("已加入手机工作流面板");
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
      ? "用手机扫描，连接这台电脑"
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

$("text-panel").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (nativeWindows) { nativePost({ type: "text", text: $("message").value }); return; }
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
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());

function listenEvents() {
  if (nativeWindows) { listenNative(); return; }
  events?.close();
  events = new EventSource("/api/events");
  events.addEventListener("change", () =>
    refreshState().catch((error) => {
      if (error.status === 401) showPhonePairing();
      else setConnection("连接已中断");
    }),
  );
  events.addEventListener("error", async () => {
    setConnection("正在重新连接");
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
      "在电脑的 NearBridge「设备连接」页刷新二维码，再用这台手机扫描。";
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
      setConnection("正在重新连接");
      await new Promise(resolve => setTimeout(resolve, Math.min(15000, 1000 * 2 ** Math.min(failures++, 4))));
      await refreshState().catch(() => {});
    }
  }
}

if (nativeWindows) {
  window.chrome.webview.addEventListener('message', event => {
    const data = event.data;
    if (data.type === 'error') toast(data.message, true);
    if (data.type === 'actionComplete') {
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
    if (data.type === 'queue' && data.pending) toast('有操作结果尚未确认，请点窗口顶部“重试确认”。', true);
  });
  document.querySelector('.pairing-guide ol').innerHTML = '<li><strong>打开手机 NearBridge，点“扫码连接”</strong><p>手机和 Windows 电脑连接同一个 Wi-Fi。</p></li><li><strong>扫描此原生配对码</strong><p>证书和公钥随配对绑定，无需关闭证书验证。</p></li><li><strong>在电脑点击“允许配对”</strong><p>只确认你手边的手机，之后即可双向收发。</p></li>';
  document.querySelector('.scope-note p').textContent = '鸿蒙端收发时请保持 NearBridge 前台运行。Windows 端关闭窗口后仍在托盘运行；电脑需保持唤醒。';
  document.querySelector('.shortcut-builder h2').textContent = '接入 Windows 快捷方式';
  document.querySelector('.builder-heading p').textContent = '从窗口顶部打开“快捷方式目录”，放入你选定的 .lnk，再载入并加入面板。手机只能触发已启用的 ID。';
}

async function initialize() {
  try {
    const info = await api("/api/bootstrap");
    role = info.role;
    document.body.classList.toggle("phone", role === "phone");
    $("loading").hidden = true;
    if (role === "phone") {
      $("send-title").textContent = "发送到电脑";
      $("recipient-kicker").textContent = "手机 → WINDOWS";
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
    setConnection("未连接");
  }
}
initialize();
