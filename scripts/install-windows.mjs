import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('请在 Windows 上安装。');
const source = fileURLToPath(new URL('../dist/windows/', import.meta.url));
if (!fs.existsSync(path.join(source, 'NearBridge.exe'))) throw new Error('请先运行 npm run build:windows');
const running = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq NearBridge.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
if (running.includes('"NearBridge.exe"')) throw new Error('请先从 NearBridge 托盘菜单退出，再安装。');
const parent = path.resolve(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Programs');
const target = path.join(parent, 'NearBridge');
const stage = path.join(parent, `NearBridge.new-${Date.now()}`);
const backup = path.join(parent, `NearBridge.backup-${Date.now()}`);
// All renames remain inside the explicitly named per-user Programs directory.
for (const candidate of [target, stage, backup])
  if (path.dirname(path.resolve(candidate)) !== parent) throw new Error('安装路径无效');
fs.mkdirSync(parent, { recursive: true });
fs.cpSync(source, stage, { recursive: true, errorOnExist: true, force: false });
const existed = fs.existsSync(target);
if (existed) fs.renameSync(target, backup);
try { fs.renameSync(stage, target); }
catch (error) { if (existed) fs.renameSync(backup, target); throw error; }

// Fixed script + JSON stdin; no execution-policy change or shell interpolation.
const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $request=[Console]::In.ReadToEnd() | ConvertFrom-Json; $shell=New-Object -ComObject WScript.Shell; foreach($folder in @('Programs','SendTo')) { $location=Join-Path ([Environment]::GetFolderPath($folder)) 'NearBridge.lnk'; $link=$shell.CreateShortcut($location); $link.TargetPath=$request.exe; $link.WorkingDirectory=$request.directory; $link.Save() }`;
execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { input: JSON.stringify({ exe: path.join(target, 'NearBridge.exe'), directory: target }), windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
console.log(`已安装：${path.join(target, 'NearBridge.exe')}；开始菜单与“发送到”入口已创建。`);
if (existed) console.log(`上一个版本保留在：${backup}`);
