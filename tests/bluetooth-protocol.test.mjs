import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
test('Mac BLE protocol rejects malformed frames and preserves TLS bytes at each MTU', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nearbridge-ble-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'protocol-tests');
  await run('/usr/bin/swiftc', ['-swift-version', '5',
    fileURLToPath(new URL('../macos/BluetoothProtocol.swift', import.meta.url)),
    fileURLToPath(new URL('./BluetoothProtocolTests.swift', import.meta.url)), '-o', binary]);
  await run(binary);
});
