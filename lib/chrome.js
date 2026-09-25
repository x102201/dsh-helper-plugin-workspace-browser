/**
 * Chrome 探测（DESIGN.zh.md §8「去哪找 chrome.exe」）。
 *
 * 两条路径分得很清：
 *
 * - `quickProbe()` —— 只看注册表和文件在不在，**不启动进程**。给 `GET /status`
 *   轮询用，毫秒级。
 * - `probeChrome()` —— 读 **PE 文件版本资源**确认版本（用 PowerShell 读文件元数据）。
 *
 * ⚠️ **本模块任何路径都不执行 `chrome.exe`**。原因见 `probeChrome()` 上方的事故记录：
 * 在 Windows 上跑 `chrome.exe --version` 会把命令行交给用户**默认 profile** 的
 * Chrome，把用户的日常浏览器拉到前台（实测变成 profile 选择器）。
 *
 * 版本以 `--version` 为准，注册表值只用于快速判断。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/chrome
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 最低版本水位。低于它拒绝启动，只提示安装或升级（P0 实测后可能调整）。 */
export const MIN_CHROME_VERSION = '92';

/** `--version` 的超时（毫秒）。 */
export const VERSION_TIMEOUT_MS = 3000;

/** 探测状态取值。 */
export const CHROME_STATES = Object.freeze(['ok', 'missing', 'too-old', 'ambiguous', 'probing']);

/**
 * 跑一个命令并收下 stdout，带超时。
 *
 * @param {string} file - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {number} timeout - 超时（毫秒）。
 * @returns {Promise<string>} stdout；失败时 reject。
 */
function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout, killSignal: 'SIGKILL', windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout ?? ''));
      },
    );
  });
}

/**
 * 解析 `reg query <key>` 的整键输出。
 *
 * 一次查询拿回该键下的所有值，比"一个值一次查询"少 5 次进程创建 —— `/status`
 * 两秒一轮，这个差别很实在。
 *
 * @param {string} out - 命令输出。
 * @returns {Record<string, string>} 值名 → 数据；`(Default)` 归一成 `(default)`。
 */
function parseRegQuery(out) {
  const values = {};
  for (const line of out.split(/\r?\n/u)) {
    const match = /^\s{4}(.+?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/u.exec(line);
    if (!match) continue;
    const name = match[1].trim() === '(Default)' ? '(default)' : match[1].trim();
    values[name] = match[3].trim().replace(/^"|"$/gu, '');
  }
  return values;
}

/**
 * 读一个注册表键下的全部值（单次进程）。
 *
 * @param {string} key - 注册表键。
 * @returns {Promise<Record<string, string>>} 值表；键不存在或查询不可用时为空对象。
 */
async function readRegistryValues(key) {
  try {
    return parseRegQuery(await run('reg.exe', ['query', key], VERSION_TIMEOUT_MS));
  } catch {
    return {};
  }
}

/** 缓存有效期：`/status` 两秒一轮，30 秒足够新鲜，又省掉重复的进程创建。 */
const PROBE_CACHE_MS = 30000;

/** @type {{ key: string, at: number, value: object } | null} */
let probeCache = null;

/** 清掉探测缓存（测试与「重新检测」用）。 */
export function clearProbeCache() {
  probeCache = null;
}

/**
 * 比较两个 Chrome 版本号（点分数字）。
 *
 * @param {string} a - 版本 A。
 * @param {string} b - 版本 B。
 * @returns {number} A>B 为 1，A<B 为 -1，相等为 0。
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  return 0;
}

/**
 * 收集候选安装。
 *
 * ⚠️ **默认不 spawn 任何进程**：`/status` 两秒一轮，每次轮询去开 `reg.exe` /
 * `where.exe` 既贵又会漏管道句柄（受限环境里 `execFile` 遇到 EPERM 时尤其明显）。
 * 只有 `withRegistry` 为真 —— 也就是用户点了「启动」或「重新检测」—— 才去查
 * 注册表和 PATH。这与设计里「轮询只看注册表和文件在不在」的分工一致。
 *
 * @param {string} configuredPath - 设置里的 `chromePath`。
 * @param {object} [options] - 参数。
 * @param {boolean} [options.withRegistry] - 是否查注册表与 PATH（会 spawn 进程）。
 * @returns {Promise<{ candidates: Array<{path: string, version: string, source: string}>, searched: string[] }>}
 */
async function collectCandidates(configuredPath, options = {}) {
  /** @type {Array<{path: string, version: string, source: string}>} */
  const candidates = [];
  /** @type {string[]} */
  const searched = [];
  const seen = new Set();

  const add = (path, version, source) => {
    if (typeof path !== 'string' || path.trim() === '') return;
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path, version: typeof version === 'string' ? version : '', source });
  };

  if (configuredPath !== '') {
    searched.push(configuredPath);
    add(configuredPath, '', 'setting');
  }

  const fileCandidates = [
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter((value) => value !== '');
  for (const file of fileCandidates) {
    searched.push(file);
    if (existsSync(file)) add(file, '', 'path');
  }

  if (options.withRegistry !== true) return { candidates, searched };

  const registryKeys = [
    ['HKLM\\SOFTWARE\\Google\\Chrome\\BLBeacon', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe', 'registry-hklm'],
    ['HKCU\\SOFTWARE\\Google\\Chrome\\BLBeacon', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe', 'registry-hkcu'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Google\\Chrome\\BLBeacon', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe', 'registry-wow64'],
  ];
  for (const [beaconKey, appPathKey, source] of registryKeys) {
    // 每边只查一次整键，而不是每个值一次。
    const [beacon, appPath] = await Promise.all([readRegistryValues(beaconKey), readRegistryValues(appPathKey)]);
    const version = beacon.version ?? '';
    const exe = appPath['(default)'] ?? '';
    searched.push(`${beaconKey} → version`, `${appPathKey} → (默认值)`);
    if (exe !== '') add(exe, version, source);
    else if (version !== '') add('', version, source);
  }

  // PATH 兜底：只有前面一个能用的路径都没有时才 spawn。
  if (candidates.every((entry) => entry.path === '')) {
    try {
      const where = await run('where.exe', ['chrome'], VERSION_TIMEOUT_MS);
      for (const line of where.split(/\r?\n/u)) {
        const candidate = line.trim();
        if (candidate === '') continue;
        searched.push(candidate);
        add(candidate, '', 'path-env');
      }
    } catch {
      searched.push('where.exe chrome');
    }
  }

  return { candidates, searched };
}

/**
 * 只看注册表和文件在不在，不启动进程。给 `/status` 轮询用。
 *
 * 注意：这一步**不**跑 `--version`，所以 `version` 可能来自注册表，也可能是空串。
 * 「版本是否达标」由 `probeChrome({confirm:true})` 之后的 `state` 决定。
 *
 * @param {object} [options] - 参数。
 * @param {string} [options.chromePath] - 设置里的 `chromePath`。
 * @param {boolean} [options.fresh] - 跳过缓存（「重新检测」与「启动」用）。
 * @returns {Promise<{state: string, path: string, version: string, minVersion: string, candidates: Array<object>, searched: string[]}>} 探测结果。
 */
export async function quickProbe(options = {}) {
  const configuredPath = typeof options.chromePath === 'string' ? options.chromePath.trim() : '';
  if (
    options.fresh !== true
    && probeCache !== null
    && probeCache.key === configuredPath
    && Date.now() - probeCache.at < PROBE_CACHE_MS
  ) {
    return probeCache.value;
  }
  const { candidates, searched } = await collectCandidates(configuredPath, { withRegistry: options.fresh === true });
  const usable = candidates.filter((entry) => entry.path !== '' && existsSync(entry.path));
  const withVersion = usable.length > 0 ? usable : candidates.filter((entry) => entry.version !== '');
  const chosen = configuredPath !== '' ? usable[0] ?? withVersion[0] : withVersion[0] ?? usable[0];

  if (!chosen) {
    const missing = {
      state: 'missing',
      path: '',
      version: '',
      minVersion: MIN_CHROME_VERSION,
      candidates: [],
      searched,
    };
    probeCache = { key: configuredPath, at: Date.now(), value: missing };
    return missing;
  }

  const distinctPaths = new Set(withVersion.map((entry) => entry.path.toLowerCase()).filter((value) => value !== ''));
  const state = configuredPath === '' && distinctPaths.size > 1 ? 'ambiguous' : 'ok';
  const result = {
    state: state === 'ok' && chosen.version !== '' && compareVersions(chosen.version, MIN_CHROME_VERSION) < 0 ? 'too-old' : state,
    path: chosen.path,
    version: chosen.version,
    minVersion: MIN_CHROME_VERSION,
    candidates: withVersion,
    searched,
  };
  probeCache = { key: configuredPath, at: Date.now(), value: result };
  return result;
}

/**
 * 读 PE 文件版本资源（`FileVersionInfo.ProductVersion`）。
 *
 * 这是版本探测的**首选也是唯一**的自动化来源：
 *
 * - 本机 `HKLM\SOFTWARE\Google\Chrome\BLBeacon` 根本不存在；
 * - `chrome.exe --version` **不能用**（见 `probeChrome()` 上方的事故记录）。
 *
 * 用 PowerShell 的 `Get-Item ... VersionInfo` 而不是解析 PE 资源节，省掉一个二进制
 * 解析器；它只读文件元数据，**不会启动 Chrome**。
 *
 * @param {string} exePath - chrome.exe 路径。
 * @returns {Promise<string>} 版本号；读不到时抛错。
 */
export async function readFileVersion(exePath) {
  const literal = exePath.replace(/'/gu, "''");
  const script = `$ErrorActionPreference='SilentlyContinue'; (Get-Item -LiteralPath '${literal}').VersionInfo.ProductVersion`;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], VERSION_TIMEOUT_MS);
  const match = /(\d+\.\d+\.\d+\.\d+)/u.exec(out) ?? /(\d+\.\d+\.\d+)/u.exec(out);
  if (!match) throw new Error(`无法读取文件版本：${exePath}`);
  return match[1];
}

/**
 * 把 `quickProbe` + 版本确认合成 `status.chrome`。
 *
 * ## ⚠️ 这里**绝不**执行 `chrome.exe`
 *
 * 曾经的第一版会跑 `chrome.exe --version`。真机排查证明那是个**有副作用的错误**：
 *
 * ```
 * 运行 chrome.exe --version 之前：  pid 24176 窗口标题 = "支付明细 · dsh-helper 管理 - Google Chrome"
 * 运行 chrome.exe --version 之后：  pid 24176 窗口标题 = "Google Chrome"      ← 变成 profile 选择器了
 * chrome --version 的 stdout = "在非交互式会话中打开。"（压根没输出版本号）
 * ```
 *
 * 原因：Windows 上 `chrome.exe` 是 GUI 程序，`--version` 在非交互式会话里不会被处理成
 * "打印版本并退出"，而是**把命令行交给已经在跑的那个默认 profile 的 Chrome**，于是
 * **用户日常浏览器**被拉起/切到 profile 选择器。我们调它的时候**没有带 `--user-data-dir`**
 * （那一步只是想读版本号），所以受害的是用户的浏览器 —— 这是绝对不能接受的行为，
 * 也违背 DESIGN 的静默原则（D10）。
 *
 * 所以版本链改成：**文件版本资源 → 注册表值 → 未知**。三者都拿不到时不阻塞启动，
 * 只带 `diagnostic: 'version-unconfirmed'` 与空版本 —— 把能正常跑的 Chrome 判成
 * 「不可用」比版本未知更糟。
 *
 * @param {object} options - 参数。
 * @param {string} [options.chromePath] - 设置里的 `chromePath`。
 * @param {boolean} [options.confirm] - 是否确认版本（只在「启动」或「重新检测」时为 true）。
 * @returns {Promise<object>} `status.chrome`。
 */
export async function probeChrome(options = {}) {
  const probe = await quickProbe({ chromePath: options.chromePath, fresh: options.confirm === true });
  if (options.confirm !== true || probe.path === '') return probe;

  let version = '';
  const notes = [];
  try {
    version = await readFileVersion(probe.path);
  } catch (error) {
    notes.push(`file: ${error instanceof Error ? error.message : String(error)}`);
  }
  // 退到注册表值（本机没有这个键，但别的机器可能有）。
  if (version === '' && probe.version !== '') version = probe.version;
  if (version === '' && typeof options.registryVersion === 'string') version = options.registryVersion;

  if (version === '') {
    return { ...probe, state: 'ok', diagnostic: 'version-unconfirmed' };
  }
  const tooOld = compareVersions(version, MIN_CHROME_VERSION) < 0;
  return {
    ...probe,
    version,
    state: tooOld ? 'too-old' : probe.state === 'ambiguous' ? 'ambiguous' : 'ok',
    ...(notes.length === 0 ? {} : { diagnostic: `version-fallback: ${notes.join('; ')}` }),
  };
}

/**
 * 版本是否达标。
 *
 * @param {object} chrome - `probeChrome()` 的结果。
 * @returns {boolean} 达标为 true。
 */
export function chromeUsable(chrome) {
  return chrome.state === 'ok';
}

/**
 * 把 Chrome 状态翻成给用户的一句话。
 *
 * @param {object} chrome - `probeChrome()` 的结果。
 * @returns {string} 人话。
 */
export function describeChrome(chrome) {
  switch (chrome.state) {
    case 'ok':
      return `Chrome ${chrome.version === '' ? '' : chrome.version}可用`.trim();
    case 'ambiguous':
      return `检测到 ${chrome.candidates.length} 个 Chrome，请选一个`;
    case 'too-old':
      return `Chrome 版本过低：检测到 ${chrome.version}，最低需要 ${chrome.minVersion}`;
    case 'probing':
      return '正在检测 Chrome…';
    default:
      return '未检测到 Chrome';
  }
}
