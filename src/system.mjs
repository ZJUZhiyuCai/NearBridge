import { spawn } from "node:child_process";

function run(file, args = [], input, { timeout = 8000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
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
