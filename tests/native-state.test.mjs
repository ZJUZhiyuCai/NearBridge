import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
test("Mac native state merge rejects incomplete deltas and preserves unchanged history", { skip: process.platform !== "darwin" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "nearbridge-state-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "state-tests");
  await run("/usr/bin/swiftc", ["-swift-version", "5",
    fileURLToPath(new URL("../macos/Models.swift", import.meta.url)),
    fileURLToPath(new URL("./StateUpdateTests.swift", import.meta.url)), "-o", binary]);
  await run(binary);
});
