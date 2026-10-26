import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  ensureCertificate,
  ensureNativeCertificate,
  localAddresses,
} from "./certificate.mjs";
import { createBridge } from "./server.mjs";

const dataDir =
  process.env.NEARBRIDGE_DATA_DIR ||
  path.join(os.homedir(), "Library/Application Support/NearBridge");
const inbox =
  process.env.NEARBRIDGE_INBOX ||
  path.join(os.homedir(), "Downloads/NearBridge");
const addresses = localAddresses();
const tls = ensureCertificate(path.join(dataDir, "certificates"), addresses);
const nativeDirectory = path.join(dataDir, "native-certificates");
const nativeTls = ensureNativeCertificate(nativeDirectory, addresses);
const bridge = createBridge({
  dataDir,
  inbox,
  tls,
  nativeTls,
  addresses,
  name: os.hostname().replace(/\.local$/, ""),
});
try {
  const info = await bridge.start({
    port: Number(process.env.NEARBRIDGE_PORT || 53318),
    phonePort: Number(process.env.NEARBRIDGE_PHONE_PORT || 53319),
    nativePhonePort: Number(process.env.NEARBRIDGE_NATIVE_PORT || 53320),
  });
  fs.writeFileSync(
    path.join(dataDir, "running.json"),
    JSON.stringify({ ...info, pid: process.pid }),
    { mode: 0o600 },
  );
  console.log(
    `NearBridge 已启动\nMac 控制台：${info.localURL}\n手机接收端：本地 HTTPS，端口 ${info.phonePort}\n收件目录：${inbox}`,
  );
  if (!addresses.length) console.log("未发现局域网地址，请连接 Wi-Fi 后重启。");
} catch (error) {
  console.error(
    error.code === "EADDRINUSE"
      ? "NearBridge 端口已占用。请先打开 http://127.0.0.1:53318 检查现有实例。"
      : error.message,
  );
  process.exitCode = 1;
}
let stopping = false;
const networkRefresh = setInterval(() => {
  if (stopping) return;
  const next = localAddresses();
  if (JSON.stringify(next) === JSON.stringify(addresses)) return;
  try {
    const renewed = ensureNativeCertificate(nativeDirectory, next);
    bridge.updateNativeTLS(renewed);
    addresses.splice(0, addresses.length, ...next);
  } catch (error) {
    console.error("更新本地网络连接失败：", error.message);
  }
}, 8000);
networkRefresh.unref();
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(networkRefresh);
  await bridge.close();
  const running = path.join(dataDir, "running.json");
  try {
    if (JSON.parse(fs.readFileSync(running, "utf8")).pid === process.pid)
      fs.rmSync(running);
  } catch {}
}
process.on("SIGINT", () => stop().then(() => process.exit()));
process.on("SIGTERM", () => stop().then(() => process.exit()));
