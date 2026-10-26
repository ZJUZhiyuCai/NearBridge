import { constants, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const harmonyRoot = resolve(root, 'harmony');

export function prepareHarmonyProject() {
  // DevEco writes machine-specific signing material and encrypted passwords here.
  const profile = resolve(harmonyRoot, 'build-profile.json5');
  if (!existsSync(profile)) {
    copyFileSync(resolve(harmonyRoot, 'build-profile.template.json5'), profile, constants.COPYFILE_EXCL);
  }
}

export function harmonyToolchain() {
  const app = [process.env.NEARBRIDGE_DEVECO_APP, '/Applications/DevEco-Studio.app',
    resolve(homedir(), 'Applications/DevEco-Studio.app')]
    .filter(Boolean).find(path => existsSync(resolve(path, 'Contents/tools/hvigor/bin/hvigorw.js')));
  if (!app) throw new Error('请先安装华为官方 DevEco Studio，或设置 NEARBRIDGE_DEVECO_APP 为应用路径。');
  const contents = resolve(app, 'Contents');
  const nodeHome = resolve(contents, 'tools/node');
  return {
    contents,
    node: resolve(nodeHome, 'bin/node'),
    env: { ...process.env, NODE_HOME: nodeHome,
      DEVECO_CLI_STUDIO_PATH: app, DEVECO_CLI_DISABLE_TELEMETRY: '1',
      DEVECO_SDK_HOME: resolve(contents, 'sdk'),
      JAVA_HOME: resolve(contents, 'jbr/Contents/Home'),
      PATH: [resolve(nodeHome, 'bin'), resolve(contents, 'tools/ohpm/bin'), process.env.PATH || ''].join(delimiter) },
  };
}
