/**
 * 从宿主 profile 里解析 `@deepseek-ai/*` 模块。
 *
 * ## 为什么需要它
 *
 * 本插件用 `dsh plugin add link:<dir>` 安装：Node 会从包的**真实路径**解析裸导入，
 * 那里没有 `node_modules`，所以 `import '@deepseek-ai/dsh-llm'` 会直接失败。
 * 但有些能力**必须**用宿主自己的实现（例如 `createUserMessage` —— 自己拼一个
 * 消息对象等于复制宿主的内部结构，迟早对不上）。
 *
 * 办法：在**运行时**用 `createRequire` 从 profile / DSH_HOME 这些真实存在
 * `node_modules` 的地方去 require。这样 `link:`、`file:`、`github:` 三种安装方式
 * 都能拿到宿主正在用的那个实例。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/dsh-modules
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * 列出值得一试的解析根目录。
 *
 * 顺序即优先级：先看 DSH 自己的位置，再看进程的工作目录 —— 宿主进程的 cwd
 * 有时是环境根，有时是它自己的 checkout，两个都要覆盖。
 *
 * @returns {string[]} 目录列表（去重）。
 */
export function candidateRoots() {
  const roots = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim() !== '') roots.add(value.trim());
  };
  const dshHome = process.env.DSH_HOME;
  if (dshHome) {
    add(dshHome);
    add(join(dshHome, 'profiles', 'web'));
    add(join(dshHome, 'profiles'));
    // 环境目录布局：<env>/.dsh 与 <env>/dsh 并列
    add(join(dshHome, '..', 'dsh'));
  }
  const cwd = process.cwd();
  add(cwd);
  add(join(cwd, '..', 'dsh'));
  add(join(cwd, '.dsh', 'profiles', 'web'));
  let dir = cwd;
  for (let i = 0; i < 3 && dir; i += 1) {
    add(join(dir, 'node_modules'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...roots];
}

/**
 * 解析一个模块，失败返回 undefined（**不抛**：调用方总是要能降级）。
 *
 * @param {string} specifier - 模块名，例如 `@deepseek-ai/dsh-llm`。
 * @returns {object | undefined} 模块导出。
 */
export function resolveDshModule(specifier) {
  for (const root of candidateRoots()) {
    // 用「root/node_modules/<pkg>/package.json」当锚点：createRequire 需要的是一个
    // 存在的文件路径，而且从它出发解析才能命中那个 node_modules。
    const parts = specifier.split('/');
    const pkgPath = join(root, 'node_modules', ...parts, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      return createRequire(pkgPath)(specifier);
    } catch {
      // 换下一个根目录。
    }
  }
  return undefined;
}
