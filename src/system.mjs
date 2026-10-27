import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { defaultDataDirectory } from "./platform.mjs";

function run(file, args = [], input, { timeout = 8000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let errorText = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("系统操作超时"));
    }, timeout);
    const cancel = () => {
      child.kill();
      reject(new Error("操作已中止"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on("data", (data) => {
      output += data;
      if (Buffer.byteLength(output) > 256 * 1024) {
        child.kill();
        reject(new Error("剪贴板文字过长"));
      }
    });
    child.stderr.on("data", (data) => {
      errorText += data;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (code === 0) resolve(output);
      else reject(new Error(errorText.trim() || "系统操作失败"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function parseShortcuts(output) {
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^(.*?)\s+\(([A-Fa-f0-9-]{36})\)\s*$/);
    return match ? [{ name: match[1], id: match[2].toLowerCase() }] : [];
  });
}

export const macSystem = {
  readClipboard: () => run("/usr/bin/pbpaste"),
  writeClipboard: (text) => run("/usr/bin/pbcopy", [], text),
  openInbox: (inbox) => run("/usr/bin/open", [inbox]),
  openURL: (url) => run("/usr/bin/open", [url]),
  listShortcuts: async () =>
    parseShortcuts(
      await run("/usr/bin/shortcuts", ["list", "--show-identifiers"]),
    ),
  runShortcut: (id, signal) =>
    run("/usr/bin/shortcuts", ["run", id], undefined, {
      timeout: 90000,
      signal,
    }),
};

export function shortcutIdentifier(filename) {
  const hash = createHash("sha256").update(filename.toLowerCase()).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

export function windowsShortcuts(directory = path.join(defaultDataDirectory(), "Workflows")) {
  fs.mkdirSync(directory, { recursive: true });
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(file => file.isFile() && /\.lnk$/i.test(file.name))
    .map(file => ({ id: shortcutIdentifier(file.name), name: path.basename(file.name, path.extname(file.name)), file: path.join(directory, file.name) }));
}

export function powershellOperation(operation, input, options, runner = run) {
  // Only fixed source is encoded. Clipboard text, paths and URLs travel as JSON
  // on stdin, so quotes, newlines and PowerShell syntax remain literal data.
  const operations = {
    read: "[Console]::Write([Windows.Forms.Clipboard]::GetText())",
    write: "if ($request.text.Length -eq 0) { [Windows.Forms.Clipboard]::Clear() } else { [Windows.Forms.Clipboard]::SetText([string]$request.text) }",
    open: "Start-Process -FilePath ([string]$request.path) | Out-Null",
    shortcut: "Start-Process -FilePath ([string]$request.path) | Out-Null",
  };
  if (!Object.hasOwn(operations, operation)) throw new Error("不支持的系统操作");
  const script = `$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $request = [Console]::In.ReadToEnd() | ConvertFrom-Json; ${operations[operation]}`;
  return runner(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    JSON.stringify(input || {}), options);
}

export function createWindowsSystem(directory = path.join(defaultDataDirectory(), "Workflows"), invoke = powershellOperation) {
  return {
  readClipboard: () => invoke("read"),
  writeClipboard: text => invoke("write", { text }),
  openInbox: inbox => invoke("open", { path: inbox }),
  openURL: url => {
    if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("只允许打开网页链接");
    return invoke("open", { path: url });
  },
  listShortcuts: async () => windowsShortcuts(directory).map(({ file, ...entry }) => entry),
  runShortcut: (id, signal) => {
    const shortcut = windowsShortcuts(directory).find(entry => entry.id === id.toLowerCase());
    if (!shortcut) throw new Error("本机快捷方式已移除，请重新载入列表");
    return invoke("shortcut", { path: shortcut.file }, { signal });
  },
  };
}

export const windowsSystem = createWindowsSystem();

export const desktopSystem = process.platform === "win32" ? windowsSystem : macSystem;
