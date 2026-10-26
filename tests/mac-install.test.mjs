import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceMacApp } from "../scripts/replace-mac-app.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nearbridge-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.app"), target = path.join(root, "Applications", "NearBridge.app");
  for (const [app, version] of [[source, "new"], [target, "old"]]) {
    fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "version"), version);
  }
  return { source, target, read: app => fs.readFileSync(path.join(app, "Contents", "version"), "utf8") };
}

test("Mac replacement preserves the app directory identity and copies a recoverable backup", t => {
  const { source, target, read } = fixture(t), inode = fs.statSync(target).ino;
  const verified = [];
  const backup = replaceMacApp(source, target, app => verified.push(read(app)));
  assert.equal(fs.statSync(target).ino, inode);
  assert.equal(read(target), "new");
  assert.equal(read(backup), "old");
  assert.equal(backup.endsWith(".app"), false);
  assert.deepEqual(verified, ["new", "old", "new"]);
});

test("failed verification leaves or restores the previous Mac app without changing its identity", t => {
  for (const failAt of [1, 2, 3]) {
    const { source, target, read } = fixture(t), inode = fs.statSync(target).ino;
    let calls = 0;
    assert.throws(() => replaceMacApp(source, target, () => {
      if (++calls === failAt) throw new Error("signature rejected");
    }), /signature rejected/);
    assert.equal(fs.statSync(target).ino, inode);
    assert.equal(read(target), "old");
  }
});
