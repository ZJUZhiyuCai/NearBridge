import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

export function defaultDataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  if (env.NEARBRIDGE_DATA_DIR) return path.resolve(env.NEARBRIDGE_DATA_DIR);
  return platform === "win32"
    ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "NearBridge")
    : path.join(home, "Library", "Application Support", "NearBridge");
}

// Git for Windows includes OpenSSL. Resolve an executable, never a shell command.
export function opensslExecutable(platform = process.platform, env = process.env) {
  if (env.NEARBRIDGE_OPENSSL) {
    if (!fs.existsSync(env.NEARBRIDGE_OPENSSL)) throw new Error("NEARBRIDGE_OPENSSL 指向的程序不存在");
    return env.NEARBRIDGE_OPENSSL;
  }
  if (platform !== "win32") return "/usr/bin/openssl";
  const candidates = [
    ...String(env.PATH || env.Path || "").split(";").map(dir => path.join(dir, "openssl.exe")),
    ...[env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")]
      .filter(Boolean).map(dir => path.join(dir, "Git", "usr", "bin", "openssl.exe")),
  ];
  try {
    for (const git of execFileSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/))
      candidates.push(path.resolve(path.dirname(git), "../usr/bin/openssl.exe"));
  } catch {}
  const result = candidates.find(file => fs.existsSync(file));
  if (!result) throw new Error("没有找到 OpenSSL。请安装 Git for Windows，或设置 NEARBRIDGE_OPENSSL 为 openssl.exe 的完整路径。");
  return result;
}
