/**
 * 目录与身份：工作区键、profile 目录、`endpoint.json` 的读写。
 *
 * 目录布局（DESIGN.zh.md §8「目录」）：
 *
 * ```
 * <DSH_HOME>/workspace-browser/<workspaceKey>/
 * ├── chrome-profile/     # Chrome 自己维护（--user-data-dir）
 * └── endpoint.json       # 本插件写，只是线索，不代表浏览器还活着
 * ```
 *
 * profile 放在 `DSH_HOME` 而不是工作区目录里，是为了不进工作区的 git、
 * 也不进 DSH 的文件索引 —— 它有数千个文件，还含 Cookie。
 *
 * 本模块只用 `node:` 内置模块。`link:` 安装下 Node 从真实路径解析裸导入，
 * 任何静态 `@deepseek-ai/...` 导入都会让 link 安装失败（见 index.js 顶部说明）。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/paths
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize, sep } from 'node:path';

/** 无工作区时使用的目录名（DESIGN.zh.md §2）。 */
export const UNGROUPED_KEY = '_ungrouped';

/** `endpoint.json` 的 schema 版本。 */
export const ENDPOINT_SCHEMA = 1;

/**
 * 解析 DSH_HOME。宿主进程里由 dsh 注入 `DSH_HOME`；没有时退回 `~/.dsh`。
 *
 * @returns {string} 绝对路径。
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return normalize(fromEnv.trim());
  return join(homedir(), '.dsh');
}

/**
 * 把工作区目录名压成文件名安全的一段。
 *
 * @param {string} name - 目录名。
 * @returns {string} 小写、只含 `[a-z0-9._-]` 的一段，空则 `workspace`。
 */
export function slugify(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40);
  return slug === '' ? 'workspace' : slug;
}

/**
 * 规范化工作区路径用于身份比较：统一分隔符、去尾分隔符、Windows 下折叠大小写。
 *
 * @param {string} path - 工作区路径。
 * @returns {string} 规范化后的路径。
 */
export function normalizeWorkspacePath(path) {
  const abs = normalize(String(path ?? ''));
  const trimmed = abs.endsWith(sep) ? abs.slice(0, -sep.length) : abs;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * 算出一个工作区稳定的目录键：`<目录名>-<路径哈希前 8 位>`。
 *
 * 用哈希而不是纯目录名，是因为不同路径可能同名（`work/a` 与 `play/a`）；
 * 用目录名做前缀，是为了让人在 `DSH_HOME` 里一眼看出这目录是谁的。
 *
 * @param {string | null | undefined} workspacePath - 工作区绝对路径；空表示未分组。
 * @returns {string} 目录键。
 */
export function workspaceKeyOf(workspacePath) {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') return UNGROUPED_KEY;
  const normalized = normalizeWorkspacePath(workspacePath);
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return `${slugify(basename(normalized))}-${hash}`;
}

/** 工作区里的数据目录名。**点开头 + 设隐藏属性**，用户默认看不到。 */
export const WORKSPACE_DATA_DIR = '.workspace-browser';

/**
 * 一个工作区的插件数据根目录。
 *
 * **有工作区就放在工作区里**：`<workspace>/.workspace-browser/` —— 点开头、再加 Windows
 * 隐藏属性，用户看不见；删工作区就跟着清掉，心理模型最简单。
 * 只有**未分组**（没有工作区）时才退回 `<DSH_HOME>/workspace-browser/_ungrouped/`。
 *
 * @param {object} options - 参数。
 * @param {string} [options.workspacePath] - 工作区绝对路径。
 * @param {string} [options.workspaceKey] - `workspaceKeyOf()` 的结果（未分组回退用）。
 * @param {string} [options.dshHome] - 覆盖 `DSH_HOME`（测试用）。
 * @returns {string} 数据根目录。
 */
export function browserRootOf({ workspacePath, workspaceKey, dshHome }) {
  const home = typeof dshHome === 'string' && dshHome !== '' ? dshHome : resolveDshHome();
  if (typeof workspacePath === 'string' && workspacePath.trim() !== '') {
    return join(normalize(workspacePath.trim()), WORKSPACE_DATA_DIR);
  }
  const key = typeof workspaceKey === 'string' && workspaceKey !== '' ? workspaceKey : UNGROUPED_KEY;
  return join(home, 'workspace-browser', key);
}

/**
 * 从 `<DSH_HOME>/storages/workspace.json` **同步**读工作区路径。
 *
 * 为什么不只靠 `ctx.get('workspaceRegistry')`：那个服务的 init 是异步的，而插件在
 * **加载时**就要算出数据目录 —— 实测撞上过"注册表明明有 Planner1，插件却落到
 * `_ungrouped`"。存储文件是同一份真源，读它没有时序问题。
 *
 * @param {string} [dshHome] - 覆盖 `DSH_HOME`。
 * @returns {string | null} 工作区绝对路径；没有则 null。
 */
export function readWorkspacePathFromStorage(dshHome) {
  try {
    const home = typeof dshHome === 'string' && dshHome !== '' ? dshHome : resolveDshHome();
    const doc = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'));
    const ids = Array.isArray(doc?.global?.workspaceIds) ? doc.global.workspaceIds : [];
    const table = doc?.tables?.workspaces ?? {};
    for (const id of ids) {
      const path = table?.[id]?.path;
      if (typeof path === 'string' && path.trim() !== '') return path;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 让目录在 Windows 资源管理器里**默认隐藏**（`attrib +H`）。
 *
 * 点开头的名字在 Unix 下天然隐藏，Windows 不认，所以要显式设属性。失败只当没做。
 *
 * @param {string} dir - 目录。
 * @returns {void}
 */
export function hideDirOnWindows(dir) {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn('attrib.exe', ['+H', dir], { windowsHide: true, stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 隐藏失败不影响功能 */
  }
}

/**
 * 工作区里**已经有** `.gitignore` 时，把数据目录追加进去。
 *
 * 只在文件已存在时追加 —— 用户没建过 `.gitignore` 就别替他建，那是他自己的仓库配置
 * （这种情况由数据目录里那份自忽略的 `.gitignore` 兜住）。已经有等价写法就不动，保证幂等。
 *
 * @param {string} workspacePath - 工作区绝对路径。
 * @returns {boolean} 是否真的追加了。
 */
export function appendToWorkspaceGitignore(workspacePath) {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') return false;
  const file = join(normalize(workspacePath.trim()), '.gitignore');
  if (!existsSync(file)) return false;
  const entry = `${WORKSPACE_DATA_DIR}/`;
  try {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/u).map((line) => line.trim());
    if (lines.some((line) => line === entry || line === WORKSPACE_DATA_DIR)) return false;
    const prefix = text !== '' && !text.endsWith('\n') ? '\n' : '';
    appendFileSync(file, `${prefix}${entry}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 在数据根里放一个**自忽略**的 `.gitignore`（内容 `*`）。
 *
 * 数据目录现在在工作区里，用户很可能 `git add .` —— 这份文件让 git 自动忽略整个目录，
 * 不需要用户去改自己的 `.gitignore`。
 *
 * @param {string} root - 数据根目录。
 * @returns {void}
 */
export function writeSelfIgnore(root) {
  try {
    const file = join(root, '.gitignore');
    if (existsSync(file)) return;
    mkdirSync(root, { recursive: true });
    writeFileSync(file, '*\n', 'utf8');
  } catch {
    /* 写不了就算了 */
  }
}

/**
 * 把**老位置**（`<DSH_HOME>/workspace-browser/<键>/`）的数据搬到新位置。
 *
 * 只在目标还不存在时做一次 `rename`（同盘瞬时），把用户已经登录好的 profile 带过去 ——
 * 不然换目录就等于"所有站点重新登录一次"。
 *
 * @param {object} options - 参数。
 * @param {string} options.browserRoot - 新数据根目录。
 * @param {string} [options.workspaceKey] - 工作区键（老布局里的目录名）。
 * @param {string} [options.dshHome] - 覆盖 `DSH_HOME`。
 * @returns {string} 迁移来源目录；没迁移则为空串。
 */
export function migrateLegacyRoot({ browserRoot, workspaceKey, dshHome }) {
  if (existsSync(browserRoot)) return '';
  const home = typeof dshHome === 'string' && dshHome !== '' ? dshHome : resolveDshHome();
  const candidates = [
    join(home, 'workspace-browser', typeof workspaceKey === 'string' && workspaceKey !== '' ? workspaceKey : UNGROUPED_KEY),
    join(home, 'workspace-browser', UNGROUPED_KEY),
  ];
  for (const candidate of candidates) {
    if (candidate === browserRoot) continue;
    if (!existsSync(join(candidate, 'chrome-profile'))) continue;
    try {
      mkdirSync(dirname(browserRoot), { recursive: true });
      renameSync(candidate, browserRoot);
      return candidate;
    } catch {
      // 跨盘或被占用：换下一个候选（迁移失败不该挡住启动）。
    }
  }
  return '';
}

/**
 * `--user-data-dir` 指向的目录。**这是判定「是不是同一个实例」的身份**。
 *
 * @param {string} browserRoot - `browserRootOf()` 的结果。
 * @returns {string} profile 目录。
 */
export function profileDirOf(browserRoot) {
  return join(browserRoot, 'chrome-profile');
}

/**
 * `endpoint.json` 路径。
 *
 * @param {string} browserRoot - `browserRootOf()` 的结果。
 * @returns {string} 文件路径。
 */
export function endpointPathOf(browserRoot) {
  return join(browserRoot, 'endpoint.json');
}

/**
 * 截图落盘目录（P1 的 `workspace_browser_screenshot` 写这里）。
 *
 * 放在数据根下而不是工作区里：截图是运行产物，不该进工作区的 git 和文件索引，
 * 和 profile 同一个理由（DESIGN.zh.md §8「目录」）。
 *
 * @param {string} browserRoot - `browserRootOf()` 的结果。
 * @returns {string} 目录路径。
 */
export function shotsDirOf(browserRoot) {
  return join(browserRoot, 'shots');
}

/** `DevToolsActivePort` 相对 profile 目录的文件名（Chrome 自己写）。 */
export const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort';

/**
 * Chrome 写的端口发现文件。第一行端口，第二行浏览器级 WebSocket 路径。
 *
 * @param {string} profileDir - profile 目录。
 * @returns {string} 文件路径。
 */
export function devToolsActivePortPathOf(profileDir) {
  return join(profileDir, DEVTOOLS_ACTIVE_PORT_FILE);
}

/**
 * 读 `DevToolsActivePort`。文件不在、或内容不是「端口 + wsPath」两行时返回 null。
 *
 * 注意：**文件在只说明可以开始连**，不说明实例还活着 —— 判定「运行中」必须
 * 端到端探测（见 lib/instance.js）。
 *
 * @param {string} profileDir - profile 目录。
 * @returns {{ port: number, wsPath: string } | null} 解析结果。
 */
export function readDevToolsActivePort(profileDir) {
  try {
    const text = readFileSync(devToolsActivePortPathOf(profileDir), 'utf8');
    const lines = text.split(/\r?\n/u).map((line) => line.trim());
    const port = Number.parseInt(lines[0] ?? '', 10);
    const wsPath = lines[1] ?? '';
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return null;
    if (wsPath === '') return null;
    return { port, wsPath };
  } catch {
    return null;
  }
}

/**
 * 读 `endpoint.json`。任何损坏、缺失、schema 不符都返回 null —— 它只是线索。
 *
 * @param {string} endpointPath - 文件路径。
 * @returns {object | null} 端点记录。
 */
export function readEndpoint(endpointPath) {
  try {
    const parsed = JSON.parse(readFileSync(endpointPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    if (parsed.schema !== ENDPOINT_SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 原子写 `endpoint.json`（先写临时文件再改名）。
 *
 * @param {string} endpointPath - 文件路径。
 * @param {object} record - 要写入的记录（自动补 `schema`）。
 * @returns {boolean} 是否写成功。
 */
export function writeEndpoint(endpointPath, record) {
  const tmp = `${endpointPath}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(endpointPath), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ schema: ENDPOINT_SCHEMA, ...record }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmp, endpointPath);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 清理失败无所谓：下一次写入会覆盖同名临时文件。
    }
    return false;
  }
}

/**
 * 确保目录存在。
 *
 * @param {string} dir - 目录。
 * @returns {boolean} 是否可用。
 */
export function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 目录里是否已经有 Chrome 的 profile 痕迹（用来判断「是不是第一次启动」）。
 *
 * @param {string} profileDir - profile 目录。
 * @returns {boolean} 是否存在。
 */
export function profileExists(profileDir) {
  return existsSync(profileDir);
}
