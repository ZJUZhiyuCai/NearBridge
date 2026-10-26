import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { VERSION, BUILD_NUMBER } from "../src/version.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const app = path.join(root, "dist/NearBridge.app");
const contents = path.join(app, "Contents");
fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
const bundle = path.join(contents, "Resources/bridge");
fs.mkdirSync(bundle, { recursive: true });
for (const name of ["src", "public", "node_modules"]) {
  const target = path.join(bundle, name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(root, name), target, {
    recursive: true,
    dereference: true,
    // npm CLI shims are not used by the embedded service. Node 24 can preserve
    // these as absolute links despite dereference, which strict codesign rejects.
    filter: (source) => name !== "node_modules" || path.basename(source) !== ".bin",
  });
}
for (const entry of fs.readdirSync(bundle, { recursive: true })) {
  if (fs.lstatSync(path.join(bundle, entry)).isSymbolicLink())
    throw new Error(`应用运行时中出现符号链接，请先检查打包输入：${entry}`);
}
for (const name of ["package.json", "package-lock.json"])
  fs.copyFileSync(path.join(root, name), path.join(bundle, name));
fs.writeFileSync(
  path.join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>NearBridge</string>
<key>CFBundleDisplayName</key><string>NearBridge</string>
<key>CFBundleIdentifier</key><string>local.nearbridge.mac</string>
<key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
<key>CFBundleShortVersionString</key><string>${VERSION}</string>
<key>CFBundleExecutable</key><string>NearBridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSLocalNetworkUsageDescription</key><string>与局域网内已配对的华为手机互传文件和文字。</string>
<key>NSBluetoothAlwaysUsageDescription</key><string>与已配对的华为手机通过蓝牙互传文件、文字并触发已启用的工作流。</string>
<key>NSBluetoothPeripheralUsageDescription</key><string>与已配对的华为手机建立 NearBridge 蓝牙连接。</string>
<key>NSBonjourServices</key><array><string>_nearbridge._tcp.</string></array>
<key>NSServices</key><array><dict>
<key>NSMenuItem</key><dict><key>default</key><string>发送到 NearBridge</string></dict>
<key>NSMessage</key><string>sendToPhone</string>
<key>NSPortName</key><string>NearBridge</string>
<key>NSSendTypes</key><array><string>public.file-url</string><string>NSFilenamesPboardType</string><string>public.utf8-plain-text</string></array>
<key>NSRequiredContext</key><dict/>
</dict></array>
</dict></plist>`,
);
const executable = path.join(contents, "MacOS/NearBridge");
execFileSync(
  "/usr/bin/swiftc",
  [
    "-swift-version",
    "5",
    "-O",
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`,
    "-framework",
    "AppKit",
    "-framework",
    "SwiftUI",
    "-framework",
    "Carbon",
    "-framework",
    "Network",
    "-framework",
    "CoreBluetooth",
    ...fs
      .readdirSync(path.join(root, "macos"))
      .filter((name) => name.endsWith(".swift"))
      .map((name) => path.join(root, "macos", name)),
    "-o",
    `${executable}.next`,
  ],
  { stdio: "inherit" },
);
fs.renameSync(`${executable}.next`, executable);
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], {
  stdio: "inherit",
});
console.log(`已构建：${app}`);
