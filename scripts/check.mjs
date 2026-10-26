import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION, BUILD_NUMBER } from "../src/version.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const directory of ["src", "scripts", "tests", "public"]) {
  for (const entry of fs.readdirSync(path.join(root, directory), { recursive: true })) {
    if (/\.(mjs|js)$/.test(entry)) execFileSync(process.execPath, ["--check", path.join(root, directory, entry)], { stdio: "inherit" });
  }
}
const phone = fs.readFileSync(path.join(root, "harmony/AppScope/app.json5"), "utf8");
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
assert.match(VERSION, /^\d+\.\d+\.\d+$/);
assert.equal(phone.match(/"versionName"\s*:\s*"([^"]+)"/)[1], VERSION, "Phone version must match package.json");
assert.equal(Number(phone.match(/"versionCode"\s*:\s*(\d+)/)[1]), BUILD_NUMBER, "Phone build number must match version");
assert.equal(lock.version, VERSION);
assert.equal(lock.packages[""].version, VERSION);
execFileSync(process.execPath, [path.join(root, "scripts/check-repository.mjs")], { cwd: root, stdio: "inherit" });
console.log(`Syntax and version checks passed (${VERSION}, build ${BUILD_NUMBER}).`);
