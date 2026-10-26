import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Keep the installed .app directory's identity. Moving that directory to an
// .app backup caused macOS's Bluetooth permission entry to follow the backup.
export function replaceMacApp(source, target, verify) {
  const directory = path.dirname(target), suffix = randomUUID();
  const staging = path.join(directory, `.NearBridge-staging-${suffix}`);
  const previous = path.join(directory, `.NearBridge-previous-contents-${suffix}`);
  const backup = path.join(directory, `.NearBridge-backup-${suffix}`);
  const contents = path.join(target, "Contents");
  if (fs.readdirSync(source).some(name => name !== "Contents"))
    throw new Error("应用包顶层包含未知文件，已停止替换");
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.cpSync(source, staging, { recursive: true, dereference: true });
    verify(staging);
    if (!fs.existsSync(target)) {
      fs.renameSync(staging, target);
      return null;
    }
    // Copy first; do not rename the app whose OS permission record is in use.
    fs.cpSync(target, backup, { recursive: true, dereference: true });
    verify(backup);
    fs.renameSync(contents, previous);
    try {
      fs.renameSync(path.join(staging, "Contents"), contents);
      verify(target);
    } catch (error) {
      fs.rmSync(contents, { recursive: true, force: true });
      fs.renameSync(previous, contents);
      throw error;
    }
    fs.rmSync(previous, { recursive: true });
    return backup;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
