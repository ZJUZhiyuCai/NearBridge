import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const privatePath = /(^|\/)(?:\.runtime|node_modules|dist|\.idea|\.hvigor|oh_modules|screenshots|\.env(?:\..*)?)(\/|$)|\.(?:pem|key|p12|pfx|cer|p7b|jks|keystore|hap)$/;
const credential = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}/;
const errors = [];
for (const file of tracked) {
  if (privatePath.test(file) && !file.endsWith(".env.example") || ["harmony/build-profile.json5", "harmony/local.properties"].includes(file)) {
    errors.push(`${file}: private/generated path must not be tracked`);
    continue;
  }
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) { errors.push(`${file}: tracked file is missing`); continue; }
  if (fs.lstatSync(absolute).isSymbolicLink()) { errors.push(`${file}: review symlink before committing`); continue; }
  const bytes = fs.readFileSync(absolute);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  if (credential.test(text)) errors.push(`${file}: possible credential (value omitted)`);
  if (!file.endsWith(".md")) continue;
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, "").split("#")[0];
    if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(absolute), decodeURIComponent(target)))) errors.push(`${file}: missing local link ${target}`);
  }
}
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log(`Repository checks passed (${tracked.length} versioned/pending files).`);
