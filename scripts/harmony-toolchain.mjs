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

export function harmonyToolchain({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const windows = platform === 'win32';
  const app = [env.NEARBRIDGE_DEVECO_APP,
    ...(windows ? [
      resolve(env.ProgramFiles || 'C:/Program Files', 'Huawei/DevEco Studio'),
      resolve(env.LOCALAPPDATA || resolve(home, 'AppData/Local'), 'Programs/Huawei/DevEco Studio'),
      'C:/Huawei/DevEco Studio', 'D:/Huawei/DevEco Studio',
    ] : ['/Applications/DevEco-Studio.app', resolve(home, 'Applications/DevEco-Studio.app')])]
    .filter(Boolean).find(path => existsSync(resolve(path, windows ? 'tools/hvigor/bin/hvigorw.js' : 'Contents/tools/hvigor/bin/hvigorw.js')));
  if (!app) throw new Error('请先安装华为官方 DevEco Studio，或设置 NEARBRIDGE_DEVECO_APP 为应用路径。');
  const contents = windows ? resolve(app) : resolve(app, 'Contents');
  const nodeHome = resolve(contents, 'tools/node');
  const javaHome = resolve(contents, windows ? 'jbr' : 'jbr/Contents/Home');
  const node = [resolve(nodeHome, windows ? 'node.exe' : 'bin/node'), resolve(nodeHome, 'bin/node.exe')].find(existsSync);
  if (!node) throw new Error('DevEco Studio 内置 Node.js 不存在，请检查 NEARBRIDGE_DEVECO_APP。');
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  return {
    contents,
    node,
    env: { ...env, NODE_HOME: nodeHome,
      DEVECO_CLI_STUDIO_PATH: app, DEVECO_CLI_DISABLE_TELEMETRY: '1',
      DEVECO_SDK_HOME: env.DEVECO_SDK_HOME || resolve(contents, 'sdk'),
      JAVA_HOME: javaHome,
      // PackageHap invokes java by name, even when JAVA_HOME is present.
      [pathKey]: [nodeHome, resolve(nodeHome, 'bin'), resolve(javaHome, 'bin'), resolve(contents, 'tools/ohpm/bin'), env[pathKey] || ''].join(windows ? ';' : delimiter) },
  };
}
