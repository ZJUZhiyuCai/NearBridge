import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, harmonyRoot, harmonyToolchain, prepareHarmonyProject } from './harmony-toolchain.mjs';

const cli = resolve(root, '.runtime/deveco-cli/node_modules/@deveco/deveco-cli/dist/cli.js');
if (!existsSync(cli)) {
  throw new Error('请先安装官方工具：npm install --prefix .runtime/deveco-cli --ignore-scripts --no-audit --no-fund --save-exact @deveco/deveco-cli@1.3.0-stable');
}
prepareHarmonyProject();
const toolchain = harmonyToolchain();
const result = spawnSync(toolchain.node, [cli, ...process.argv.slice(2)], {
  cwd: harmonyRoot, stdio: 'inherit', env: toolchain.env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
