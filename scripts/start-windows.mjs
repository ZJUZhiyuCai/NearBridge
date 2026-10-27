import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const app = fileURLToPath(new URL('../dist/windows/NearBridge.exe', import.meta.url));
if (!existsSync(app)) throw new Error('请先运行 npm run build:windows');
const child = spawn(app, process.argv.slice(2), { detached: true, stdio: 'ignore', windowsHide: false });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.unref();
