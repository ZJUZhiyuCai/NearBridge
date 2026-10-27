import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { VERSION } from '../src/version.mjs';
import { opensslExecutable } from '../src/platform.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'win32') throw new Error('请在 Windows 上构建桌面客户端。');
const localSDK = path.join(root, '.runtime/dotnet/dotnet.exe');
const dotnet = process.env.NEARBRIDGE_DOTNET || (fs.existsSync(localSDK) ? localSDK : 'dotnet');
const output = path.join(root, 'dist/windows');
opensslExecutable(); // Fail with an actionable message before a long publish.
const result = spawnSync(dotnet, ['publish', path.join(root, 'windows/NearBridge.csproj'),
  '-c', 'Release', '-r', process.arch === 'arm64' ? 'win-arm64' : 'win-x64', '--self-contained', 'true',
  '-o', output, `-p:Version=${VERSION}`], { cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
if (result.error) throw new Error('请安装 .NET 10 SDK，或设置 NEARBRIDGE_DOTNET。', { cause: result.error });
if (result.status !== 0) process.exit(result.status ?? 1);
for (const entry of ['src', 'public', 'node_modules', 'package.json', 'LICENSE'])
  fs.cpSync(path.join(root, entry), path.join(output, 'bridge', entry), { recursive: true });
fs.copyFileSync(process.execPath, path.join(output, 'node.exe'));
// Node's license includes its bundled third-party notices.
const license = path.join(path.dirname(process.execPath), 'LICENSE');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(output, 'NODE-LICENSE.txt'));
console.log(`Windows 客户端：${path.join(output, 'NearBridge.exe')}`);
