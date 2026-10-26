import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { harmonyRoot, harmonyToolchain, prepareHarmonyProject } from './harmony-toolchain.mjs';

prepareHarmonyProject();
const toolchain = harmonyToolchain();
const result = spawnSync(toolchain.node, [
  resolve(toolchain.contents, 'tools/hvigor/bin/hvigorw.js'), '--mode', 'module',
  '-p', 'product=default', '-p', 'module=entry@default', '-p', 'buildMode=debug',
  'assembleHap', '--no-daemon', ...process.argv.slice(2),
], {
  cwd: harmonyRoot, stdio: 'inherit', env: toolchain.env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
