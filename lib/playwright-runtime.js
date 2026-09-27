/**
 * 加载 `playwright-core`（不下载浏览器）。
 *
 * 查找顺序：调用方指定的路径、插件旁的 `node_modules`、`<DSH_HOME>/workspace-browser/vendor/`。
 * 都没有且允许安装时，往 vendor 目录装钉死的版本。装不上就返回 null，调用方报
 * `playwright-missing`。Chrome 的启动不依赖这里。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/playwright-runtime
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDshHome } from './paths.js';

/** 钉死的 playwright-core 版本。只装这个包，不装会下载浏览器的 `playwright`。 */
export const PLAYWRIGHT_CORE_VERSION = '1.55.1';

/** 读写工具在库缺失时返回的错误码。 */
export const PLAYWRIGHT_MISSING = 'playwright-missing';

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * vendor 目录：`<DSH_HOME>/workspace-browser/vendor`。
 *
 * @param {string} [dshHome] - 覆盖 DSH_HOME。
 * @returns {string} 绝对路径。
 */
export function vendorDirOf(dshHome) {
  const home = typeof dshHome === 'string' && dshHome !== '' ? dshHome : resolveDshHome();
  return join(home, 'workspace-browser', 'vendor');
}

/**
 * 从一个目录加载 playwright-core。失败返回 null。
 *
 * @param {string} entry - 包根目录。
 * @returns {object | null} 模块。
 */
function requireFrom(entry) {
  const root = entry.endsWith('playwright-core') ? entry : join(entry, 'node_modules', 'playwright-core');
  if (!existsSync(join(root, 'package.json')) && !existsSync(join(root, 'index.js'))) return null;
  try {
    return createRequire(import.meta.url)(root);
  } catch {
    return null;
  }
}

/**
 * 在 vendor 目录安装钉死版本。
 *
 * @param {string} vendor - vendor 目录。
 * @param {object} [options] - 可替换 spawn，测试用。
 * @returns {Promise<boolean>} 是否装上。
 */
export function installPlaywrightCore(vendor, options = {}) {
  const run = options.spawn ?? spawn;
  mkdirSync(vendor, { recursive: true });
  const manifest = join(vendor, 'package.json');
  if (!existsSync(manifest)) {
    writeFileSync(manifest, `${JSON.stringify({ private: true, dependencies: {} }, null, 2)}\n`, 'utf8');
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = run(
        'npm',
        ['install', '--omit=dev', '--no-fund', '--no-audit', `playwright-core@${PLAYWRIGHT_CORE_VERSION}`],
        { cwd: vendor, shell: process.platform === 'win32', stdio: 'ignore' },
      );
    } catch {
      resolve(false);
      return;
    }
    if (!child || typeof child.on !== 'function') {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0 && requireFrom(vendor) !== null));
  });
}

/**
 * 加载 playwright-core。
 *
 * @param {object} [options] - 参数。
 * @param {string} [options.dshHome] - DSH_HOME。
 * @param {string} [options.modulePath] - 测试注入的包路径。
 * @param {boolean} [options.install] - 缺失时是否 npm install。默认 true。
 * @returns {Promise<object | null>} 模块；没有则为 null。
 */
export async function loadPlaywrightCore(options = {}) {
  const vendor = vendorDirOf(options.dshHome);
  const found =
    (typeof options.modulePath === 'string' ? requireFrom(options.modulePath) : null)
    ?? requireFrom(join(PLUGIN_DIR, 'node_modules', 'playwright-core'))
    ?? requireFrom(vendor);
  if (found) return found;
  if (options.install === false) return null;
  const ok = await installPlaywrightCore(vendor, options);
  return ok ? requireFrom(vendor) : null;
}
