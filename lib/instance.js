/**
 * 实例管理：`ensure()`、`stop()`、心跳、硬超时（DESIGN.zh.md §4）。
 *
 * ## 一条铁律
 *
 * **「运行中」的判据必须端到端**：能连上 CDP 并且拿到标签列表。`endpoint.json`
 * 存在、或端口有 HTTP 响应，都**不算**。这条是「胶囊永远点得动」的基础 ——
 * 宁可把半死的实例判成未启动（然后重启），也不要看着像在运行却打不开。
 *
 * ## 状态
 *
 * 用户只看到五个：`idle` / `launching` / `running` / `stopping` / `failed`。
 * 更细的原因（`endpoint-stale`、`lock-held`、`latched`、`no-pages`）走
 * `diagnostic` 字段，**不进胶囊文案**。
 *
 * ## 为什么 P0 不需要 WebSocket
 *
 * 建立标签、列出标签、关掉标签都能用 Chrome 的 HTTP 调试端点
 * （`/json/version`、`/json/list`、`/json/new`、`/json/close/<id>`）完成。
 * 所以 P0 的「停止」是**优雅的**：先逐个关标签（关掉最后一个窗口 Chrome 自己
 * 退出），超时再按 `--user-data-dir` 结束进程。CDP 的 WebSocket 客户端
 * （`Browser.close`、`Page.*`、screencast）属于 P1/P3。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/instance
 */

import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { rmSync } from 'node:fs';

import { probeChrome } from './chrome.js';
import {
  ensureDir,
  endpointPathOf,
  profileDirOf,
  readDevToolsActivePort,
  readEndpoint,
  writeEndpoint,
} from './paths.js';

/** 用户可见的五种状态。 */
export const STATES = Object.freeze(['idle', 'launching', 'running', 'stopping', 'failed']);

/** 时间预算（DESIGN.zh.md §4「到点必须落地」）。 */
export const BUDGETS = Object.freeze({
  /** 冷启动总预算。 */
  launchMs: 15000,
  /** 等 `DevToolsActivePort` 出现。 */
  portFileMs: 10000,
  /** 端口文件出现后，再等 CDP 端到端可用。 */
  attachMs: 3000,
  /** 停止总预算。 */
  stopMs: 8000,
  /** 停止里等优雅退出的时间。 */
  gracefulMs: 3000,
  /** 强制结束后再等的时间。 */
  afterKillMs: 3000,
  /** 心跳间隔。 */
  heartbeatMs: 3000,
  /** 「页面没了」的防抖，避开「关掉最后一个标签，Chrome 马上又开一个」。 */
  pageGoneDebounceMs: 1500,
  /** 连续探测失败几次才判端点失效（screencast 满负荷时单次 HTTP 容易抖）。 */
  probeFailureLimit: 3,
  /** 单个 HTTP 探测请求的超时（version 等轻量接口）。 */
  httpTimeoutMs: 2000,
  /** `/json/list` 单独放宽：多标签 + 画面采集时 1.5s 经常超时，预览会整页空白。 */
  listTimeoutMs: 5000,
});

/** 睡眠。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 对 Chrome 调试端点发一个 HTTP 请求。
 *
 * @param {number} port - 调试端口。
 * @param {string} path - 路径，例如 `/json/version`。
 * @param {object} [options] - 参数。
 * @param {string} [options.method] - HTTP 方法，默认 `GET`。
 * @param {number} [options.timeoutMs] - 超时。
 * @returns {Promise<{ ok: boolean, status: number, body: string }>} 结果；连接失败时 `ok: false`。
 */
function debugHttp(port, path, options = {}) {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? BUDGETS.httpTimeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = request(
      { host: '127.0.0.1', port, path, method, timeout: timeoutMs, headers: { Host: `127.0.0.1:${port}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => done({ ok: true, status: res.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, status: 0, body: '' });
    });
    req.on('error', () => done({ ok: false, status: 0, body: '' }));
    req.end();
  });
}

/**
 * 解析 `/json/list` 的正文。Chrome 在少数版本上会返回对象而非数组，这里都兜住。
 *
 * @param {string} body - 响应正文。
 * @returns {Array<object>} target 列表。
 */
function parseTargets(body) {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) return parsed;
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.targets)) return parsed.targets;
    return [];
  } catch {
    return [];
  }
}

/**
 * 从 `/json/version` 正文里取出当前的浏览器 WebSocket 路径。
 * Chrome 每次冷启动（`--remote-debugging-port=0`）都会换这个 UUID 路径。
 *
 * @param {string} body - 响应正文。
 * @returns {string} 例如 `/devtools/browser/…`；解析失败为空串。
 */
function wsPathFromVersionBody(body) {
  try {
    const parsed = JSON.parse(body);
    const url = typeof parsed?.webSocketDebuggerUrl === 'string' ? parsed.webSocketDebuggerUrl : '';
    if (url === '') return '';
    const parsedUrl = new URL(url);
    return `${parsedUrl.pathname}${parsedUrl.search}` || '/';
  } catch {
    return '';
  }
}

/**
 * 「窗口还开着吗」用的**宽松**过滤：只排除 devtools 与扩展页。
 *
 * 为什么不能直接用 `pageTargets()`（那个更严格，还排掉 `chrome-untrusted://`、
 * `chrome://omnibox*`）：**窗口里只剩新标签页或 omnibox 这类内部页时，严格过滤会算出
 * 0 个页面** —— 于是窗口明明开着，实例却被判成"没有页面"，500 毫秒后翻成「未启动」。
 * 真机上用户就是这么遇到的。
 *
 * @param {Array<object>} targets - `/json/list` 的结果。
 * @returns {Array<object>} 用于判活的 target。
 */
export function windowTargets(targets) {
  return targets.filter((target) => {
    if (target === null || typeof target !== 'object') return false;
    if (target.type !== 'page') return false;
    const url = typeof target.url === 'string' ? target.url : '';
    if (url.startsWith('devtools://')) return false;
    if (url.startsWith('chrome-extension://')) return false;
    return true;
  });
}

/**
 * 过滤出「真正的页面」。
 *
 * 排除三类**不是标签页**的 target：
 *
 * - `devtools://` —— 开发者工具自己的页面
 * - `chrome-extension://` —— 扩展页
 * - `chrome-untrusted://` 与 `chrome://omnibox-popup*` —— 浏览器内部 UI（Omnibox
 *   下拉就是这类，实测它也会以 `type: 'page'` 出现在 `/json/list` 里）
 *
 * 后一类必须排除：它们会污染标签列表，更要紧的是**会让"页面没了"的判断失效** ——
 * 用户把标签全关掉后，这些幽灵 target 还在，实例就迟迟回不到「未启动」（§4 关窗）。
 *
 * @param {Array<object>} targets - `/json/list` 的结果。
 * @returns {Array<object>} 页面 target。
 */
export function pageTargets(targets) {
  return targets.filter((target) => {
    if (target === null || typeof target !== 'object') return false;
    if (target.type !== 'page') return false;
    const url = typeof target.url === 'string' ? target.url : '';
    if (url.startsWith('devtools://')) return false;
    if (url.startsWith('chrome-extension://')) return false;
    if (url.startsWith('chrome-untrusted://')) return false;
    if (url.startsWith('chrome://omnibox')) return false;
    return true;
  });
}

/**
 * 是否是空标签页（`about:blank` 及其带 hash/query 的变体）。
 *
 * 胶片条默认不展示这类标签；判活与 `pageTargets()` 仍保留它们。
 *
 * @param {unknown} url - 网址。
 * @returns {boolean} 是否是 about:blank。
 */
export function isAboutBlankUrl(url) {
  if (typeof url !== 'string' || url === '') return false;
  return url === 'about:blank' || url.startsWith('about:blank#') || url.startsWith('about:blank?');
}

/**
 * 胶片条 / 面板用的页面列表：在 `pageTargets` 基础上再去掉 `about:blank`。
 *
 * @param {Array<object>} pages - 已经过 `pageTargets`（或等价过滤）的页面。
 * @returns {Array<object>} 适合展示的页面。
 */
export function filmstripTargets(pages) {
  if (!Array.isArray(pages)) return [];
  return pages.filter((page) => {
    if (page === null || typeof page !== 'object') return false;
    return !isAboutBlankUrl(typeof page.url === 'string' ? page.url : '');
  });
}

/**
 * 按给定 id 顺序重排页面（用于对齐 Chrome `/json/list` / 标签栏顺序）。
 *
 * 不在顺序列表里的页面追加在末尾，保持相对次序。
 *
 * @param {Array<object>} pages - 页面（CDP 用 `targetId`，HTTP 用 `id`）。
 * @param {Array<string>} orderedIds - 期望顺序的 target id。
 * @returns {Array<object>} 重排后的页面。
 */
export function orderPagesByIds(pages, orderedIds) {
  if (!Array.isArray(pages) || pages.length === 0) return Array.isArray(pages) ? [...pages] : [];
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return [...pages];
  const byId = new Map();
  for (const page of pages) {
    if (page === null || typeof page !== 'object') continue;
    const id = typeof page.targetId === 'string' && page.targetId !== ''
      ? page.targetId
      : typeof page.id === 'string'
        ? page.id
        : '';
    if (id === '' || byId.has(id)) continue;
    byId.set(id, page);
  }
  const ordered = [];
  for (const id of orderedIds) {
    if (typeof id !== 'string' || id === '') continue;
    const page = byId.get(id);
    if (page === undefined) continue;
    ordered.push(page);
    byId.delete(id);
  }
  for (const page of byId.values()) ordered.push(page);
  return ordered;
}

/**
 * 找出命令行里带这份 `--user-data-dir` 的 chrome.exe 进程。
 *
 * 用 PowerShell 的 CIM 查询而不是 `wmic`（后者在新 Windows 上已被移除）。
 * 只看命令行匹配 —— 「PID 只帮着找进程，不单独拿去 taskkill」。
 *
 * ⚠️ **受限环境降级**：某些沙箱（包括 DSH 自己的）不允许子进程用管道捕获 stdout，
 * `spawn` 会抛 `EPERM`。这里**抓住**它并返回空数组，同时置
 * `commandLineQueryAvailable = false`，让调用方走「按记录的 PID 结束」这条降级
 * 路径，而不是让整条 `ensure()` 挂掉。
 *
 * @param {string} profileDir - profile 目录。
 * @returns {Promise<number[]>} PID 列表；查询不可用或失败时为空数组。
 */
export async function findChromePidsByProfileDir(profileDir) {
  if (!commandLineQueryAvailable) return [];
  const needle = profileDir.toLowerCase().replace(/'/gu, "''");
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" |',
    `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${needle}') } |`,
    'ForEach-Object { $_.ProcessId }',
  ].join(' ');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      commandLineQueryAvailable = false;
      warnDegrade(`命令行查询不可用（${error instanceof Error ? error.message : String(error)}）`);
      resolve([]);
      return;
    }
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const pids = out
        .split(/\r?\n/u)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
      resolve([...new Set(pids)]);
    });
  });
}

/**
 * 命令行查询是否可用。受限沙箱里第一次就会置 false，避免每次重试都吃一次 EPERM。
 */
let commandLineQueryAvailable = true;

/** 降级路径的通知钩子（由 createInstanceManager 装上）。 */
let warnDegrade = () => {};

/**
 * 进程是否还活着（信号 0 只做存在性检查，不真的发信号）。
 *
 * @param {number} pid - 进程号。
 * @returns {boolean} 活着为 true。
 */
export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 强制结束若干进程。`stdio: 'ignore'` —— 不捕获输出，所以在受限沙箱里也能跑。
 *
 * @param {number[]} pids - PID 列表。
 * @returns {Promise<void>} 结束时 resolve。
 */
async function killPids(pids) {
  for (const pid of pids) {
    await new Promise((resolve) => {
      let child;
      try {
        child = spawn('taskkill.exe', ['/F', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        resolve();
        return;
      }
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });
  }
}

/**
 * 创建一个工作区的实例管理器。
 *
 * @param {object} options - 参数。
 * @param {string} options.browserRoot - 插件数据根目录。
 * @param {string} options.workspaceKey - 工作区键。
 * @param {() => object} options.getSettings - 读当前设置（每次读最新值）。
 * @param {(message: string, error?: unknown) => void} [options.warn] - 降级路径日志。
 * @param {(message: string) => void} [options.info] - 普通日志。
 * @returns {object} 实例管理器。
 */
export function createInstanceManager(options) {
  const browserRoot = options.browserRoot;
  const profileDir = profileDirOf(browserRoot);
  const endpointPath = endpointPathOf(browserRoot);
  const workspaceKey = options.workspaceKey;
  const getSettings = options.getSettings;
  const warn = options.warn ?? (() => {});
  const info = options.info ?? (() => {});
  // 命令行查询降级时，把原因上报给宿主的日志（只报一次由上游 flag 保证是「一次」）。
  warnDegrade = (message) => warn(message);

  /** 内部状态。 */
  const state = {
    /** @type {'idle'|'launching'|'running'|'stopping'|'failed'} */
    phase: 'idle',
    /** @type {string} */
    diagnostic: '',
    /** @type {string} */
    lastError: '',
    /** @type {number} */
    port: 0,
    /** @type {string} */
    wsPath: '',
    /** @type {number} */
    pid: 0,
    /** @type {string} */
    chromePath: '',
    /** @type {string} */
    chromeVersion: '',
    /** @type {boolean} */
    crossOrigin: false,
    /** @type {number} */
    startedAt: 0,
    /** 记住了上次确认过的端口：关窗但进程还在时，下次「启动」走「开窗口」而不是再 spawn。 */
    latchedPort: 0,
    /** @type {string[]} 上次见到的标签网址（上限 20）。 */
    lastKnownTabs: [],
    /** 正在进行的 ensure / stop，用来合并并发点击。 */
    inflight: null,
    /** @type {NodeJS.Timeout | null} */
    heartbeat: null,
    /** @type {NodeJS.Timeout | null} */
    pageGoneTimer: null,
    /** 是否正在探测，避免心跳重入。 */
    probing: false,
    /** 连续探测失败次数：**一次抖动不算死**（见 beat()）。 */
    probeFailures: 0,
    /**
     * 最近一次成功的 `/json/list` 页面表。
     * list 超时时空预览不能把真实标签「弄丢」——用这份顶上（胶囊仍显示运行中）。
     * @type {Array<object>}
     */
    lastGoodPages: [],
    /** @type {Array<object>} */
    lastGoodWindowPages: [],
  };

  /** 读一次发现的端口。 */
  function readPort() {
    const discovered = readDevToolsActivePort(profileDir);
    if (discovered) return discovered;
    return null;
  }

  /**
   * 端到端探测：端口文件 → `/json/version` → `/json/list`。
   *
   * - `reachable`：`/json/version` 成功（调试口还活着）
   * - `listOk`：`/json/list` 也成功
   *
   * 二者必须分开：list 超时/失败时若仍带 `windowPages=[]` 且当「窗口没了」，
   * 心跳会在防抖后把胶囊打成「未启动」，而窗口其实还开着（screencast 满负荷时
   * `/json/list` 比 `/json/version` 更容易抖）。
   *
   * @returns {Promise<{ reachable: boolean, listOk: boolean, port: number, wsPath: string, targets: Array<object>, pages: Array<object>, windowPages: Array<object> }>} 探测结果。
   */
  async function probeEndpoint() {
    const discovered = readPort();
    const port = discovered?.port ?? state.latchedPort ?? state.port;
    if (!Number.isSafeInteger(port) || port <= 0) {
      return { reachable: false, listOk: false, fromCache: false, port: 0, wsPath: '', targets: [], pages: [], windowPages: [] };
    }
    const version = await debugHttp(port, '/json/version');
    // 优先用 /json/version 的实时路径；文件里的可能是上一次启动留下的。
    const liveWsPath = version.ok ? wsPathFromVersionBody(version.body) : '';
    const wsPath = liveWsPath || discovered?.wsPath || '';
    if (!version.ok || version.status >= 400) {
      return { reachable: false, listOk: false, fromCache: false, port, wsPath, targets: [], pages: [], windowPages: [] };
    }
    const list = await debugHttp(port, '/json/list', { timeoutMs: BUDGETS.listTimeoutMs });
    if (!list.ok || list.status >= 400) {
      // list 抖了：把上次成功的标签顶上，预览不要突然变空。
      const cached = state.lastGoodPages.length > 0;
      return {
        reachable: true,
        listOk: false,
        fromCache: cached,
        port,
        wsPath,
        targets: [],
        pages: cached ? state.lastGoodPages.map((page) => ({ ...page })) : [],
        windowPages: cached ? state.lastGoodWindowPages.map((page) => ({ ...page })) : [],
      };
    }
    const targets = parseTargets(list.body);
    const pages = pageTargets(targets);
    const windowPages = windowTargets(targets);
    state.lastGoodPages = pages.map((page) => ({ ...page }));
    state.lastGoodWindowPages = windowPages.map((page) => ({ ...page }));
    return {
      reachable: true,
      listOk: true,
      fromCache: false,
      port,
      wsPath,
      targets,
      pages,
      windowPages,
    };
  }

  /**
   * 工作区 Chrome 是否还像活着（端口文件 / 命令行 profile / 记录的 PID）。
   * 探测 HTTP 抖的时候用它拦住「胶囊变未启动、窗口还在」。
   *
   * @returns {Promise<boolean>} 仍在为 true。
   */
  async function chromeStillPresent() {
    if (readDevToolsActivePort(profileDir) !== null) return true;
    if (state.pid > 0 && isProcessAlive(state.pid)) return true;
    try {
      const pids = await findChromePidsByProfileDir(profileDir);
      if (pids.length > 0) return true;
    } catch {
      /* 查询失败时不据此判死 */
    }
    return false;
  }

  /** 记住标签网址（上限 20，跳过不可恢复项）。 */
  function rememberTabs(pages) {
    const urls = pages
      .map((page) => (typeof page.url === 'string' ? page.url : ''))
      .filter((url) => url !== '' && url !== 'about:blank' && !url.startsWith('chrome://'))
      .slice(0, 20);
    if (urls.length > 0) state.lastKnownTabs = urls;
  }

  /** 写 `endpoint.json`。它只是线索，写失败不影响运行。 */
  function persistEndpoint() {
    writeEndpoint(endpointPath, {
      port: state.port,
      wsPath: state.wsPath,
      pid: state.pid,
      chromePath: state.chromePath,
      crossOrigin: state.crossOrigin,
      startedAt: state.startedAt === 0 ? new Date().toISOString() : new Date(state.startedAt).toISOString(),
      workspaceKey,
      profileDir,
      lastKnownTabs: state.lastKnownTabs,
    });
  }

  /**
   * 冷启动：结束残留 → 探测 Chrome → spawn → 等端口文件 → 端到端确认。
   *
   * @returns {Promise<object>} 状态快照。
   */
  async function coldStart() {
    const settings = getSettings();
    const chrome = await probeChrome({ chromePath: settings.chromePath, confirm: true });
    if (chrome.state !== 'ok') {
      state.phase = 'failed';
      state.lastError =
        chrome.state === 'too-old'
          ? `Chrome 版本过低：检测到 ${chrome.version}，最低需要 ${chrome.minVersion}。请在本机安装或升级 Chrome。`
          : chrome.state === 'ambiguous'
            ? `检测到 ${chrome.candidates.length} 个 Chrome，请先在插件配置里选定一个。`
            : '未检测到 Chrome。请在本机安装 Chrome，或在插件配置里指定 chrome.exe 路径。';
      state.diagnostic = `chrome-${chrome.state}`;
      return status();
    }

    if (!ensureDir(profileDir)) {
      state.phase = 'failed';
      state.lastError = `无法创建 profile 目录：${profileDir}`;
      return status();
    }

    // 残留进程会占着这份 profile 的单例锁，必须先清掉。
    await killResidual();

    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
    ];
    if (settings.chromeCrossOrigin) {
      args.push('--disable-web-security', '--disable-features=IsolateOrigins,site-per-process');
    }
    // 有记住的网址就交给 Chrome 当启动页（第一个在前台，其余由 Chrome 自己排）；
    // 没有才用**默认起始页**，再没有才 `about:blank`。**不加 `--restore-last-session`。**
    const restore = settings.instanceRestoreTabsOnReopen ? state.lastKnownTabs.slice(0, 20) : [];
    if (restore.length > 0) args.push(...restore);
    else args.push(typeof settings.startupUrl === 'string' && settings.startupUrl !== '' ? settings.startupUrl : 'about:blank');

    state.phase = 'launching';
    state.crossOrigin = settings.chromeCrossOrigin;
    state.chromePath = chrome.path;
    state.chromeVersion = chrome.version;
    state.lastError = '';
    state.diagnostic = '';

    let child;
    try {
      child = spawn(chrome.path, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
    } catch (error) {
      state.phase = 'failed';
      state.lastError = `无法启动 Chrome：${error instanceof Error ? error.message : String(error)}`;
      return status();
    }
    state.pid = child.pid ?? 0;
    info(`冷启动 Chrome pid=${state.pid} profile=${profileDir}`);

    const deadline = Date.now() + BUDGETS.portFileMs;
    let discovered = null;
    while (Date.now() < deadline) {
      discovered = readPort();
      if (discovered) break;
      await sleep(120);
    }
    if (!discovered) {
      state.phase = 'failed';
      state.lastError = '启动超时：10 秒内没有出现 DevToolsActivePort。若这份数据目录已被一个没开调试端口的 Chrome 占用，请先关闭它。';
      state.diagnostic = 'port-file-timeout';
      await killResidual();
      return status();
    }

    state.port = discovered.port;
    state.wsPath = discovered.wsPath;
    state.startedAt = Date.now();
    state.latchedPort = discovered.port;

    const attachDeadline = Date.now() + BUDGETS.attachMs;
    let probe = await probeEndpoint();
    while (!probe.reachable && Date.now() < attachDeadline) {
      await sleep(120);
      probe = await probeEndpoint();
    }
    if (!probe.reachable) {
      state.phase = 'failed';
      state.lastError = '启动失败：端口文件已出现，但 3 秒内连不上 CDP。';
      state.diagnostic = 'attach-timeout';
      return status();
    }

    rememberTabs(probe.pages);
    state.phase = 'running';
    persistEndpoint();
    return status();
  }

  /** 按 `--user-data-dir` 结束残留进程，并等锁释放。 */
  async function killResidual() {
    let targets = await findChromePidsByProfileDir(profileDir);
    if (targets.length === 0) {
      // 降级路径：命令行查询不可用（受限沙箱）时只能按记录的 PID 结束。
      // 两个条件一起用，尽量不误杀：进程得活着，而且 ensure() 走到这里说明
      // CDP 已经不响应了（响应的话第 3/4 步就把它接管了）。
      const record = readEndpoint(endpointPath);
      const candidate = state.pid > 0 ? state.pid : Number.isSafeInteger(record?.pid) ? record.pid : 0;
      if (candidate > 0 && isProcessAlive(candidate)) {
        warn(`命令行查询不可用，按 endpoint.json 记录的 PID ${candidate} 结束残留实例`);
        targets = [candidate];
      }
    }
    if (targets.length === 0) return;
    warn(`正在结束 ${targets.length} 个占用该 profile 的残留 Chrome：${targets.join(', ')}`);
    await killPids(targets);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const byCommandLine = await findChromePidsByProfileDir(profileDir);
      const stillAlive = targets.filter(isProcessAlive);
      if (byCommandLine.length === 0 && stillAlive.length === 0) return;
      await sleep(150);
    }
    state.diagnostic = 'lock-held';
  }

  /**
   * 在一个还活着的进程里把窗口开回来（`ensure()` 第 4 步）。
   *
   * @returns {Promise<boolean>} 是否成功开出页面。
   */
  async function openWindowInLiveProcess() {
    const port = state.latchedPort || state.port;
    if (!Number.isSafeInteger(port) || port <= 0) return false;
    // `/json/new` 在新版 Chrome 上要求 PUT；老版本接受 GET，两个都试。
    let created = await debugHttp(port, '/json/new?about:blank', { method: 'PUT' });
    if (!created.ok || created.status >= 400) {
      created = await debugHttp(port, '/json/new?about:blank', { method: 'GET' });
    }
    if (!created.ok || created.status >= 400) return false;
    const deadline = Date.now() + BUDGETS.attachMs;
    while (Date.now() < deadline) {
      const probe = await probeEndpoint();
      if (probe.listOk === true && probe.windowPages.length > 0) {
        rememberTabs(probe.pages);
        state.phase = 'running';
        state.port = probe.port;
        state.wsPath = probe.wsPath;
        state.startedAt = state.startedAt === 0 ? Date.now() : state.startedAt;
        persistEndpoint();
        return true;
      }
      await sleep(120);
    }
    return false;
  }

  /**
   * `ensure()`：用户点「启动」或「重试」时走的唯一一条路。
   *
   * 幂等、合并并发、永远有落地状态（DESIGN.zh.md §4）。
   *
   * @param {object} [options] - 参数。
   * @param {string} [options.reason] - 触发原因，只用于日志。
   * @returns {Promise<object>} 状态快照。
   */
  function ensure(options = {}) {
    if (state.inflight) return state.inflight;
    const run = (async () => {
      const reason = options.reason ?? 'manual';
      info(`ensure(${reason})：当前状态 ${state.phase}`);
      try {
        if (state.phase === 'stopping') {
          const deadline = Date.now() + BUDGETS.stopMs;
          while (state.phase === 'stopping' && Date.now() < deadline) await sleep(120);
        }

        let probe = await probeEndpoint();
        // list 偶发抖动时不要立刻冷启动（会杀残留），先短重试。
        if (probe.reachable && probe.listOk !== true) {
          const deadline = Date.now() + BUDGETS.attachMs;
          while (Date.now() < deadline && probe.reachable && probe.listOk !== true) {
            await sleep(200);
            probe = await probeEndpoint();
          }
        }
        if (probe.reachable && probe.listOk === true && probe.windowPages.length > 0) {
          // 第 3 步：直接用，不把窗口带到前台。
          state.phase = 'running';
          state.port = probe.port;
          state.wsPath = probe.wsPath;
          state.latchedPort = probe.port || state.latchedPort;
          state.lastError = '';
          // ⚠️ 心跳曾经把它判成 idle（`resetToIdle()` 会把 pid/startedAt 清零并留下
          // `endpoint-stale`）。这里重新接管时必须**把 pid / 启动时间从 endpoint.json
          // 补回来、并清掉那条诊断** —— 否则界面会一直停在"运行中但 pid=0、端点失效"
          // 这种自相矛盾的状态上（真机上就是这么被用户看见的）。
          const record = readEndpoint(endpointPath);
          if (record !== null && Number.isSafeInteger(record.port) && record.port === probe.port) {
            state.pid = Number.isSafeInteger(record.pid) ? record.pid : 0;
            const parsed = typeof record.startedAt === 'string' ? Date.parse(record.startedAt) : Number.NaN;
            state.startedAt = Number.isFinite(parsed) ? parsed : 0;
            if (typeof record.chromePath === 'string' && record.chromePath !== '') state.chromePath = record.chromePath;
          }
          state.diagnostic = '';
          rememberTabs(probe.pages);
          persistEndpoint();
          return status();
        }
        if (probe.reachable && probe.listOk === true && probe.windowPages.length === 0) {
          // 第 4 步：进程还活着但没有页面 —— 在这个进程里开窗口。
          state.port = probe.port;
          state.wsPath = probe.wsPath;
          state.latchedPort = probe.port;
          const opened = await openWindowInLiveProcess();
          if (opened) return status();
          warn('进程活着但开不出窗口，改为冷启动');
        }
        // 第 5 步：CDP 不通 —— 冷启动（先清残留）。
        return await coldStart();
      } catch (error) {
        state.phase = 'failed';
        state.lastError = error instanceof Error ? error.message : String(error);
        return status();
      }
    })();
    state.inflight = run;
    const clear = () => {
      state.inflight = null;
    };
    run.then(clear, clear);
    return run;
  }

  /**
   * `stop()`：先优雅（逐个关标签，Chrome 自己退出），超时再按 user-data-dir 强杀。
   *
   * @returns {Promise<object>} 状态快照。
   */
  function stop() {
    if (state.inflight) {
      // 正在启动时点停止：等这一轮落地再停。
      return state.inflight.then(() => stop());
    }
    const run = (async () => {
      if (state.phase === 'idle') return status();
      state.phase = 'stopping';
      try {
        const probe = await probeEndpoint();
        if (probe.reachable) {
          rememberTabs(probe.pages);
          for (const target of probe.targets) {
            if (typeof target.id !== 'string') continue;
            await debugHttp(probe.port, `/json/close/${target.id}`, { method: 'GET' });
          }
          const gracefulDeadline = Date.now() + BUDGETS.gracefulMs;
          while (Date.now() < gracefulDeadline) {
            const again = await probeEndpoint();
            if (!again.reachable) break;
            await sleep(150);
          }
        }
        let still = await probeEndpoint();
        if (still.reachable) {
          await killResidual();
          const killDeadline = Date.now() + BUDGETS.afterKillMs;
          while (Date.now() < killDeadline) {
            still = await probeEndpoint();
            if (!still.reachable) break;
            await sleep(150);
          }
        }
      } catch (error) {
        warn('停止过程中出错，仍然复位状态', error);
      }
      resetToIdle();
      return status();
    })();
    state.inflight = run;
    const clear = () => {
      state.inflight = null;
    };
    run.then(clear, clear);
    return run;
  }

  /** 回到未启动：清掉端口与 pid，但**留着** `latchedPort` 与 `lastKnownTabs`。 */
  function resetToIdle() {
    state.phase = 'idle';
    state.port = 0;
    state.wsPath = '';
    state.pid = 0;
    state.startedAt = 0;
    state.lastError = '';
    state.lastGoodPages = [];
    state.lastGoodWindowPages = [];
    if (state.pageGoneTimer) {
      clearTimeout(state.pageGoneTimer);
      state.pageGoneTimer = null;
    }
  }

  /**
   * 心跳：每 3 秒核对一次状态，防止事件漏掉。
   *
   * 只**报告**状态变化，**绝不**自动重开（DESIGN.zh.md §4「关窗」）。
   */
  async function beat() {
    if (state.probing) return;
    if (state.phase !== 'running' && state.phase !== 'idle') return;
    state.probing = true;
    try {
      const probe = await probeEndpoint();
      if (state.phase === 'running') {
        // version 失败，或 list 失败：都当探测抖动，绝不当「窗口没了」。
        if (!probe.reachable || probe.listOk !== true) {
          // list 超时但带了上次成功的标签：先把端口稳住，预览仍能显示。
          if (probe.reachable && probe.fromCache === true && probe.port) {
            state.port = probe.port || state.port;
            state.latchedPort = probe.port || state.latchedPort;
            if (typeof probe.wsPath === 'string' && probe.wsPath !== '') state.wsPath = probe.wsPath;
          }
          state.probeFailures += 1;
          if (state.probeFailures >= BUDGETS.probeFailureLimit) {
            if (await chromeStillPresent()) {
              state.probeFailures = 1;
              warn('心跳连续探测失败，但工作区 Chrome 仍在，保持「运行中」（避免胶囊误显示未启动）');
              return;
            }
            state.diagnostic = 'endpoint-stale';
            state.probeFailures = 0;
            resetToIdle();
          }
          return;
        }
        state.probeFailures = 0;
        const endpointChanged =
          (probe.port && probe.port !== state.port)
          || (typeof probe.wsPath === 'string' && probe.wsPath !== '' && probe.wsPath !== state.wsPath);
        state.port = probe.port || state.port;
        state.latchedPort = probe.port || state.latchedPort;
        // ⚠️ 以前只更新 port、不更新 wsPath：Chrome 重启后 HTTP 列表仍通，
        // CDP WebSocket 却连着旧的 /devtools/browser/<uuid> → 永远灰点、无画面。
        if (typeof probe.wsPath === 'string' && probe.wsPath !== '') state.wsPath = probe.wsPath;
        if (endpointChanged) persistEndpoint();
        rememberTabs(probe.pages);
        if (probe.windowPages.length === 0) {
          // 页面没了：防抖后再判，避开「关掉最后一个标签，Chrome 马上又开一个」。
          if (state.pageGoneTimer === null) {
            state.pageGoneTimer = setTimeout(() => {
              state.pageGoneTimer = null;
              void (async () => {
                const again = await probeEndpoint();
                if (
                  state.phase === 'running'
                  && again.reachable
                  && again.listOk === true
                  && again.windowPages.length === 0
                ) {
                  state.diagnostic = 'latched';
                  resetToIdle();
                }
              })();
            }, BUDGETS.pageGoneDebounceMs);
          }
        } else if (state.pageGoneTimer !== null) {
          clearTimeout(state.pageGoneTimer);
          state.pageGoneTimer = null;
        }
        return;
      }
      // 未启动时也顺带记一下端口，方便下次走「开窗口」这条路。
      if (probe.reachable) state.latchedPort = probe.port;
    } catch (error) {
      warn('心跳出错', error);
    } finally {
      state.probing = false;
    }
  }

  /**
   * 给界面/接口用的状态快照。**不启动进程，也不跑 `chrome --version`。**
   *
   * @returns {object} 状态。
   */
  function status() {
    return {
      state: state.phase,
      port: state.port,
      wsPath: state.wsPath,
      pid: state.pid,
      crossOrigin: state.crossOrigin,
      chromePath: state.chromePath,
      chromeVersion: state.chromeVersion,
      startedAt: state.startedAt === 0 ? null : new Date(state.startedAt).toISOString(),
      lastError: state.lastError === '' ? null : state.lastError,
      diagnostic: state.diagnostic === '' ? null : state.diagnostic,
      profileDir,
    };
  }

  /** 启动心跳。 */
  function startHeartbeat() {
    if (state.heartbeat !== null) return;
    state.heartbeat = setInterval(() => {
      void beat();
    }, BUDGETS.heartbeatMs);
    if (typeof state.heartbeat.unref === 'function') state.heartbeat.unref();
  }

  /**
   * 停心跳并（按设置）决定浏览器去向。
   *
   * @returns {Promise<void>} 结束时 resolve。
   */
  async function dispose() {
    if (state.heartbeat !== null) {
      clearInterval(state.heartbeat);
      state.heartbeat = null;
    }
    if (state.pageGoneTimer !== null) {
      clearTimeout(state.pageGoneTimer);
      state.pageGoneTimer = null;
    }
    const settings = getSettings();
    if (settings.instanceOnDshExit === 'close' && state.phase === 'running') {
      await stop();
    }
  }

  /**
   * 删除这个工作区的浏览器数据：先停，再删目录。
   *
   * @returns {Promise<object>} 状态快照。
   */
  async function deleteData() {
    await stop();
    try {
      rmSync(browserRoot, { recursive: true, force: true });
      state.lastKnownTabs = [];
      state.latchedPort = 0;
    } catch (error) {
      warn('删除浏览器数据失败', error);
    }
    return status();
  }

  /**
   * 读一次 `endpoint.json`（只是线索，不改变状态）。
   *
   * @returns {object | null} 端点记录。
   */
  function readEndpointRecord() {
    return readEndpoint(endpointPath);
  }

  return {
    status,
    ensure,
    stop,
    dispose,
    deleteData,
    probeEndpoint,
    beat,
    startHeartbeat,
    readEndpointRecord,
    profileDir,
    endpointPath,
    browserRoot,
    /** 供路由层读内部诊断（不对外展示）。 */
    get diagnostic() {
      return state.diagnostic;
    },
    /** 供 P1 起的 CDP 客户端复用：当前端口与 wsPath。 */
    get endpoint() {
      return { port: state.port || state.latchedPort, wsPath: state.wsPath };
    },
  };
}
