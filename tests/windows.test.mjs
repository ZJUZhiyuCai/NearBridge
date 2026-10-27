import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultDataDirectory } from '../src/platform.mjs';
import { safeFilename } from '../src/store.mjs';
import { createWindowsSystem, powershellOperation } from '../src/system.mjs';
import { harmonyToolchain } from '../scripts/harmony-toolchain.mjs';

const run = promisify(execFile);
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearbridge-win-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('Windows data directory and filenames handle reserved names, punctuation and trailing dots', () => {
  assert.equal(defaultDataDirectory('win32', { LOCALAPPDATA: 'user-app-data' }, 'user'), path.join('user-app-data', 'NearBridge'));
  for (const name of ['CON', 'nul.txt', 'COM1.jpg', 'LPT¹.txt']) assert.ok(safeFilename(name).startsWith('_'));
  assert.equal(safeFilename('报告<>:"|?*.txt... '), '报告_______.txt');
  assert.equal(safeFilename('正常照片.jpg'), '正常照片.jpg');
});
test('Windows workflow IDs can only launch locally enumerated shortcuts; arguments remain data', async t => {
  const directory = temp(t), calls = [];
  const name = "测试 & $(calc) ' .lnk";
  fs.writeFileSync(path.join(directory, name), 'fixture');
  fs.writeFileSync(path.join(directory, 'not-allowed.ps1'), 'fixture');
  const system = createWindowsSystem(directory, async (...args) => { calls.push(args); });
  const shortcuts = await system.listShortcuts();
  assert.equal(shortcuts.length, 1);
  await system.runShortcut(shortcuts[0].id);
  assert.equal(calls[0][1].path, path.join(directory, name));
  assert.throws(() => system.runShortcut('../not-allowed.ps1'));
  fs.unlinkSync(path.join(directory, name));
  assert.throws(() => system.runShortcut(shortcuts[0].id));
  assert.throws(() => system.openURL('file:///C:/Windows/notepad.exe'));
  const text = "你好\n🌉 ' ` $([Environment]::Exit(1))";
  await powershellOperation('write', { text }, undefined, async (file, args, input) => {
    assert.equal(JSON.parse(input).text, text);
    const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.ok(!source.includes(text)); assert.ok(source.includes('ConvertFrom-Json'));
  });
});
test('Harmony toolchain locates Windows SDK paths with spaces without overwriting PATH or SDK overrides', t => {
  const directory = temp(t);
  for (const file of ['tools/hvigor/bin/hvigorw.js', 'tools/node/node.exe']) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.writeFileSync(path.join(directory, file), '');
  }
  const tc = harmonyToolchain({ platform: 'win32', env: { NEARBRIDGE_DEVECO_APP: directory, Path: 'original', DEVECO_SDK_HOME: 'custom-sdk' } });
  assert.equal(tc.node, path.join(directory, 'tools/node/node.exe'));
  assert.equal(tc.env.DEVECO_SDK_HOME, 'custom-sdk');
  assert.ok(tc.env.Path.endsWith(';original')); assert.equal(tc.env.PATH, undefined);
  assert.equal(tc.env.JAVA_HOME, path.join(directory, 'jbr'));
});
const app = fileURLToPath(new URL('../dist/windows/NearBridge.exe', import.meta.url));
const nativeSkip = process.platform !== 'win32' || !fs.existsSync(app);
test('Windows compiled BLE codec, ZIP packaging and journal corruption checks', { skip: nativeSkip }, async () => {
  await run(app, ['--self-test'], { windowsHide: true, timeout: 30000 });
});
test('Windows compiled client resumes actions and chunks after lost replies and restart', { skip: nativeSkip }, async t => {
  const directory = temp(t);
  const actions = [], prepares = [], chunks = [];
  let offset = 0, transfer, bytes = Buffer.alloc(0), dropped = false;
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    const raw = Buffer.concat(parts), data = raw.length && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : null;
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/api/state') return json({ device: { id: 'phone-1' }, capabilities: { reliableActions: 1 } });
    if (req.url === '/api/actions/text') {
      actions.push(data); if (actions.length === 1) { res.destroy(); return; } return json({ accepted: true });
    }
    if (req.url === '/api/transfers') { prepares.push(data); transfer = data; return json({ ...data, offset, chunkSize: 4096 }); }
    if (req.method === 'PUT') {
      const position = Number(new URL(req.url, 'http://localhost').searchParams.get('offset'));
      chunks.push(position);
      if (position !== offset) { res.statusCode = 409; return json({ error: 'wrong offset' }); }
      bytes = Buffer.concat([bytes, raw]); offset += raw.length;
      if (!dropped) { dropped = true; res.destroy(); return; }
      return json({ offset });
    }
    if (req.url === `/api/transfers/${transfer?.id}/complete`) return json({ item: { sha256: createHash('sha256').update(bytes).digest('hex') } });
    res.statusCode = 404; json({ error: 'unexpected request' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await run(app, ['--client-test', directory, `http://127.0.0.1:${server.address().port}/`], { windowsHide: true, timeout: 40000 });
  assert.equal(actions.length, 2); assert.deepEqual(actions[0], actions[1]);
  assert.equal(actions[0].peerId, 'phone-1');
  assert.equal(prepares[0].id, prepares[1].id); assert.deepEqual(chunks, [0, 4096, 8192]);
  assert.equal(bytes.length, 12000); assert.equal(fs.existsSync(path.join(directory, 'windows/pending-action.json')), false);
});
