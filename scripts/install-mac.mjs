import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "dist/NearBridge.app");
const directory = path.join(os.homedir(), "Applications");
const target = path.join(directory, "NearBridge.app");
if (!fs.existsSync(source)) throw new Error("请先运行 npm run build:mac");
fs.mkdirSync(directory, { recursive: true });
if (fs.existsSync(target)) {
  const id = execFileSync(
    "/usr/libexec/PlistBuddy",
    [
      "-c",
      "Print :CFBundleIdentifier",
      path.join(target, "Contents/Info.plist"),
    ],
    { encoding: "utf8" },
  ).trim();
  if (id !== "local.nearbridge.mac")
    throw new Error("目标位置不是 NearBridge，已保留原应用。");
}
const staging = path.join(directory, `.NearBridge-${Date.now()}.app`);
fs.cpSync(source, staging, { recursive: true, dereference: true });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", staging]);
if (fs.existsSync(target))
  fs.renameSync(
    target,
    path.join(directory, `.NearBridge-backup-${Date.now()}.app`),
  );
fs.renameSync(staging, target);
execFileSync(
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
  ["-f", target],
);
console.log(`已安装：${target}`);
