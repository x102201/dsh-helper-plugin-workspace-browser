/**
 * 控制面 HTTP 路由（DESIGN.zh.md §7「HTTP」）。
 *
 * 前缀 `/dsh-helper-plugin-workspace-browser`，路径里**不带 workspaceKey** ——
 * 一个 DSH 宿主进程只服务一个工作区。
 *
 * 只注册**一条 prefix 路由**，在内部按方法 + 后缀分发：路由表短、注销简单
 * （一个 `ctx.effect` 就够），也不会和别的插件抢路径。
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET  | `/status`       | 状态。不启动进程，也不跑 `chrome --version` |
 * | POST | `/launch`       | `ensure()` |
 * | POST | `/stop`         | 停止 |
 * | POST | `/cross-origin` | 写入设置并重启 |
 * | POST | `/delete-data`  | 停止并删除这个工作区的 profile |
 * | GET  | `/targets`      | 标签列表 |
 * | POST | `/prefs`        | P3：画面自己那几个设置（分隔条位置、布局、焦点帧率） |
 * | POST | `/tab-action`   | P3：画面悬停菜单的动作（显示浏览器窗口 / 关标签 / 新标签打开） |
 *
 * 后两条是 P3 加的：画面的拖拽与悬停菜单需要落到宿主侧，而画面 WebSocket 的上行
 * 消息只有 subscribe / unsubscribe / ack（§7）—— 往那条协议里再塞动作会把"帧通道"
 * 变成"命令通道"，所以走 HTTP。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/routes
 */

import { request } from 'node:http';

import { probeChrome } from './chrome.js';
import { presentSkillFile } from './skill-file.js';
import { deleteSkill, listSkills, readSkill, saveSkill, SKILL_USAGE } from './skills.js';
import { filmstripTargets, findChromePidsByProfileDir, orderPagesByIds } from './instance.js';
import { bringProcessWindowsToFront, restoreChromeWindowViaCdp } from './win-focus.js';

/** 路由前缀（D8）。 */
export const ROUTE_PREFIX = '/dsh-helper-plugin-workspace-browser';

/** 请求体大小上限，防止一个坏请求把内存吃光。 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * `/prefs` 允许写的键（**白名单**）。
 *
 * 只放"画面自己会改"的那几个：分隔条位置、布局、焦点跟随、焦点帧率。其余设置
 * 只能在「设置 → 插件 → 插件配置」里改，免得画面变成第二个设置页。
 */
export const PREF_KEYS = Object.freeze(['panelTileSplit', 'panelSkillHeight', 'panelFollowFrontTab', 'streamFocusFps']);

/** `/tab-action` 允许的动作。 */
export const TAB_ACTIONS = Object.freeze(['bring-to-front', 'close', 'open', 'assign-to-model']);

/** 对 Chrome 调试端点发请求的超时。 */
const DEBUG_HTTP_TIMEOUT_MS = 2000;

/**
 * 校验并收敛一个 `/prefs` 的值。
 *
 * ⚠️ 必须**先校验再写**：设置文档最终会被 `normalizeSettings()` 读一遍，越界的值
 * 会让那次读取直接抛错，连带把 `/status` 打挂。所以这里宁可 400，也不写进去。
 *
 * @param {string} key - 设置键。
 * @param {unknown} value - 原始值。
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }} 结果。
 */
function validatePref(key, value) {
  if (key === 'panelTileSplit') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.15 || value > 0.85) {
      return { ok: false, error: 'panelTileSplit 必须是 0.15–0.85 之间的数字' };
    }
    return { ok: true, value };
  }
  if (key === 'panelSkillHeight') {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.trunc(value) !== value || value < 40 || value > 360) {
      return { ok: false, error: 'panelSkillHeight 必须是 40–360 之间的整数' };
    }
    return { ok: true, value };
  }
  if (key === 'streamFocusFps') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 10) {
      return { ok: false, error: 'streamFocusFps 必须是 0.5–10 之间的数字' };
    }
    return { ok: true, value };
  }
  if (key === 'panelFollowFrontTab') {
    if (typeof value !== 'boolean') return { ok: false, error: 'panelFollowFrontTab 必须是布尔值' };
    return { ok: true, value };
  }
  return { ok: false, error: `不允许通过 /prefs 改 ${key}` };
}

/**
 * 对 Chrome 的 HTTP 调试端点发一个请求（`/json/activate/<id>` 这类）。
 *
 * 不走 CDP WebSocket：这三条动作 Chrome 的 HTTP 调试端点都有等价入口，而 CDP
 * 连接属于工具层与画面层，控制面不该再拉一条。
 *
 * @param {number} port - 调试端口。
 * @param {string} path - 路径（已编码）。
 * @param {string} [method] - HTTP 方法。
 * @returns {Promise<{ ok: boolean, status: number, body: string }>} 结果；连不上时 `ok: false`。
 */
function debugRequest(port, path, method = 'GET') {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = request(
      { host: '127.0.0.1', port, path, method, timeout: DEBUG_HTTP_TIMEOUT_MS, headers: { Host: `127.0.0.1:${port}` } },
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
 * 收下并解析 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<object>} 解析后的对象；空体或非对象一律给 `{}`。
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve({});
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => resolve({}));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * 写一个 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态码。
 * @param {object} payload - 响应体。
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 造出控制面路由。
 *
 * @param {object} options - 参数。
 * @param {object} options.instance - `createInstanceManager()` 的结果。
 * @param {() => object} options.readSettings - 读当前设置。
 * @param {(key: string, value: unknown) => Promise<boolean>} options.writeSetting - 写一个设置键。
 * @param {(reason: string, sessionId?: string | null) => void} options.requestPanelOpen - 请求客户端展开画面。
 * @param {() => Array<object>} [options.getCdpPages] - CDP 侧页面列表（HTTP 探测空时的兜底）。
 * @param {() => (object | null)} [options.getCdpClient] - 共享 CDP 客户端（显示窗口时恢复最小化）。
 * @param {(message: string, error?: unknown) => void} [options.warn] - 降级路径日志。
 * @returns {{ kind: 'prefix', path: string, handler: (req: object, res: object) => Promise<void> }} 路由对象。
 */
export function createControlRoute(options) {
  const instance = options.instance;
  const readSettings = options.readSettings;
  const writeSetting = options.writeSetting;
  const requestPanelOpen = options.requestPanelOpen;
  const getCdpPages = typeof options.getCdpPages === 'function' ? options.getCdpPages : null;
  const getCdpClient = typeof options.getCdpClient === 'function' ? options.getCdpClient : null;
  const warn = options.warn ?? (() => {});
  const browserRoot = typeof options.browserRoot === 'string' ? options.browserRoot : '';

  /**
   * 面板用的标签列表：优先 `/json/list` 顺序，去掉 about:blank；CDP 仅作兜底。
   *
   * @param {object} probe - `probeEndpoint()` 的结果。
   * @returns {Array<object>} `{ id, type, url, title }`。
   */
  function listFilmstripPages(probe) {
    const fromProbe = Array.isArray(probe?.pages) ? probe.pages : [];
    let pages = fromProbe;
    // probe 只有 about:blank、或 list 失败时 pages=[]：都要再问 CDP。
    if (filmstripTargets(fromProbe).length === 0 && getCdpPages !== null) {
      try {
        const cdpPages = getCdpPages();
        if (Array.isArray(cdpPages) && cdpPages.length > 0) {
          const mapped = cdpPages.map((page) => ({
            id: page.targetId ?? page.id ?? '',
            type: page.type ?? 'page',
            url: typeof page.url === 'string' ? page.url : '',
            title: typeof page.title === 'string' ? page.title : '',
          }));
          // 合并：probe 里已有的 id 保留顺序，CDP 多出来的追加。
          const seen = new Set(fromProbe.map((page) => page.id));
          pages = [...fromProbe];
          for (const page of mapped) {
            if (page.id === '' || seen.has(page.id)) continue;
            seen.add(page.id);
            pages.push(page);
          }
          if (fromProbe.length === 0) pages = mapped;
        }
      } catch (error) {
        warn('读取 CDP 页面列表失败', error);
      }
    }
    const orderedIds = fromProbe.map((page) => page.id).filter((id) => typeof id === 'string' && id !== '');
    const ordered = orderPagesByIds(pages, orderedIds);
    return filmstripTargets(ordered).map((target) => ({
      id: target.id ?? target.targetId ?? '',
      type: target.type ?? 'page',
      url: typeof target.url === 'string' ? target.url : '',
      title: typeof target.title === 'string' ? target.title : '',
    })).reverse(); // 与标签栏左右顺序对齐（/json/list 常为反序）
  }

  /**
   * `GET /status`。
   *
   * `chrome` 段只做**只读探测**（注册表 + 文件），不启动进程、不跑 `--version`。
   *
   * @returns {Promise<object>} 状态。
   */
  async function statusPayload() {
    const settings = readSettings();
    const snapshot = instance.status();
    let chrome;
    try {
      chrome = await probeChrome({ confirm: false });
    } catch (error) {
      warn('Chrome 探测失败', error);
      chrome = {
        state: 'missing',
        path: '',
        version: '',
        minVersion: '',
        candidates: [],
        searched: [],
        diagnostic: 'probe-failed',
      };
    }
    return {
      ...snapshot,
      chrome,
      settings,
      panelOpen: options.panelOpen ? options.panelOpen() : { sessionId: null, epoch: 0 },
    };
  }

  /**
   * 请求体里的超时，统一夹到 1–60 秒。
   *
   * @param {object} body - 请求体。
   * @returns {number | null} 毫秒；未指定返回 null。
   */
  function readTimeoutMs(body) {
    const seconds = body?.timeoutSec;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
    return Math.min(60, Math.max(1, Math.trunc(seconds))) * 1000;
  }

  /** 主分发。 */
  async function handler(req, res) {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = typeof req.url === 'string' ? req.url : '/';
    const path = rawUrl.split('?')[0];
    const suffix = path.startsWith(ROUTE_PREFIX) ? path.slice(ROUTE_PREFIX.length) : path;

    try {
      if (method === 'GET' && (suffix === '/status' || suffix === '' || suffix === '/')) {
        sendJson(res, 200, await statusPayload());
        return;
      }
      if (method === 'GET' && suffix === '/targets') {
        const snapshot = instance.status();
        if (snapshot.state !== 'running') {
          sendJson(res, 200, { state: snapshot.state, targets: [] });
          return;
        }
        const probe = await instance.probeEndpoint();
        let targets = listFilmstripPages(probe);
        const client = getCdpClient !== null ? getCdpClient() : null;
        if (client !== null && typeof client.isConnected === 'function' && client.isConnected() && typeof client.tabStripPageIds === 'function') {
          try {
            const stripIds = await client.tabStripPageIds();
            if (Array.isArray(stripIds) && stripIds.length > 0) targets = orderPagesByIds(targets, stripIds);
          } catch (error) {
            warn('按标签栏排序失败', error);
          }
        }
        sendJson(res, 200, {
          state: snapshot.state,
          port: probe.port,
          // ⚠️ 用 `pages`，不是 `targets`：`targets` 含 Chrome 内部 UI
          // （实测 Omnibox 下拉以 `type: 'browser_ui'` 出现在 /json/list 里），
          // 面板只该显示真正的标签页；about:blank 也不进胶片条。
          // 连着 CDP 时再按窗口里的 tabStripIndex 排；否则 listFilmstripPages 的反序兜底。
          targets,
        });
        return;
      }
      if (method === 'GET' && suffix === '/skills') {
        const query = new URLSearchParams(rawUrl.split('?')[1] ?? '');
        const name = query.get('name') ?? '';
        if (name !== '') {
          const skill = readSkill(browserRoot, name);
          if (!skill) {
            sendJson(res, 404, { ok: false, error: '没有这个技能' });
            return;
          }
          sendJson(res, 200, { ok: true, skill, usage: SKILL_USAGE });
          return;
        }
        sendJson(res, 200, { ok: true, skills: listSkills(browserRoot), usage: SKILL_USAGE });
        return;
      }
      if (method === 'POST' && suffix === '/skills/locate') {
        const body = await readJsonBody(req);
        const action = body?.action === 'reveal' ? 'reveal' : body?.action === 'open' ? 'open' : '';
        const located = action === ''
          ? { ok: false, error: '不认识这个动作' }
          : presentSkillFile(browserRoot, body?.name, action);
        sendJson(res, located.ok ? 200 : 400, located);
        return;
      }
      if (method === 'POST' && suffix === '/skills') {
        const body = await readJsonBody(req);
        const saved = saveSkill(browserRoot, body);
        sendJson(res, saved.ok ? 200 : 400, saved);
        return;
      }
      if (method === 'DELETE' && suffix === '/skills') {
        const body = await readJsonBody(req);
        const removed = deleteSkill(browserRoot, body?.name);
        sendJson(res, removed.ok ? 200 : 400, removed);
        return;
      }
      if (method === 'POST' && suffix === '/launch') {
        const body = await readJsonBody(req);
        const timeoutMs = readTimeoutMs(body);
        const launched = timeoutMs === null
          ? await instance.ensure({ reason: body?.reason ?? 'http' })
          : await Promise.race([
            instance.ensure({ reason: body?.reason ?? 'http' }),
            new Promise((resolve) => {
              setTimeout(() => resolve(instance.status()), timeoutMs);
            }),
          ]);
        if (launched.state === 'running') requestPanelOpen('launch', body?.sessionId ?? null);
        sendJson(res, 200, launched);
        return;
      }
      if (method === 'POST' && suffix === '/stop') {
        sendJson(res, 200, await instance.stop());
        return;
      }
      if (method === 'POST' && suffix === '/cross-origin') {
        const body = await readJsonBody(req);
        if (typeof body?.enabled !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
          return;
        }
        const previous = readSettings().chromeCrossOrigin;
        await writeSetting('chromeCrossOrigin', body.enabled);
        let snapshot = instance.status();
        if (snapshot.state === 'running' && previous !== body.enabled) {
          await instance.stop();
          snapshot = await instance.ensure({ reason: 'cross-origin' });
        }
        sendJson(res, 200, { ok: true, crossOrigin: body.enabled, state: snapshot.state });
        return;
      }
      if (method === 'POST' && suffix === '/delete-data') {
        sendJson(res, 200, await instance.deleteData());
        return;
      }
      if (method === 'POST' && suffix === '/panel-open') {
        // 客户端主动请求展开画面（胶囊里的「打开浏览器画面」也能本地做，这条给需要跨会话的场景）。
        const body = await readJsonBody(req);
        requestPanelOpen('client', body?.sessionId ?? null);
        sendJson(res, 200, { ok: true, panelOpen: options.panelOpen ? options.panelOpen() : null });
        return;
      }
      if (method === 'POST' && suffix === '/prefs') {
        // 画面自己那几个设置：拖分隔条、改布局、改焦点帧率。白名单之外一律 400。
        const body = await readJsonBody(req);
        const prefs = {};
        for (const [key, raw] of Object.entries(body)) {
          if (!PREF_KEYS.includes(key)) {
            sendJson(res, 400, { ok: false, error: `不允许通过 /prefs 改 ${key}` });
            return;
          }
          const checked = validatePref(key, raw);
          if (checked.ok !== true) {
            sendJson(res, 400, { ok: false, error: checked.error });
            return;
          }
          prefs[key] = checked.value;
        }
        if (Object.keys(prefs).length === 0) {
          sendJson(res, 400, { ok: false, error: `至少要给一个键：${PREF_KEYS.join(' / ')}` });
          return;
        }
        for (const [key, value] of Object.entries(prefs)) {
          await writeSetting(key, value);
        }
        // 回一份最新设置，客户端不用再拉一次 /status。
        sendJson(res, 200, { ok: true, prefs, settings: readSettings() });
        return;
      }
      if (method === 'POST' && suffix === '/tab-action') {
        // 画面右键菜单的动作。**只有 bring-to-front 会抢系统焦点**，且必须用户自己点。
        const body = await readJsonBody(req);
        const action = typeof body?.action === 'string' ? body.action : '';
        if (!TAB_ACTIONS.includes(action)) {
          sendJson(res, 400, { ok: false, error: `action 必须是 ${TAB_ACTIONS.join(' / ')} 之一` });
          return;
        }
        const targetId = typeof body?.targetId === 'string' ? body.targetId.trim() : '';
        if (action !== 'open' && targetId === '') {
          sendJson(res, 400, { ok: false, error: `${action} 需要 targetId` });
          return;
        }

        // 「加入对话」配套：只切默认 target（芯片由客户端写入输入框，不自动发送）。
        if (action === 'assign-to-model') {
          const snapshot = instance.status();
          if (snapshot.state !== 'running') {
            sendJson(res, 409, { ok: false, error: 'browser-not-running', state: snapshot.state });
            return;
          }
          let client = null;
          try {
            client = getCdpClient?.() ?? null;
          } catch (error) {
            warn('tab-action assign 取 CDP 客户端失败', error);
          }
          if (client !== null) {
            try {
              if (typeof client.connect === 'function') await client.connect();
              if (typeof client.selectTarget === 'function') client.selectTarget(targetId);
            } catch (error) {
              warn('tab-action assign 切默认 target 失败', error);
            }
          }
          sendJson(res, 200, { ok: true, action, targetId });
          return;
        }

        // `open`：面板空态的「新建标签页」常在实例刚被心跳判 idle、或调试口抖一下时点到。
        // 这时直接 409 只会留下「操作失败：409 Conflict」；先 ensure 再开，和点「启动」同路。
        let snapshot = instance.status();
        if (action === 'open' && snapshot.state !== 'running' && typeof instance.ensure === 'function') {
          try {
            snapshot = await instance.ensure({ reason: 'tab-action-open' });
          } catch (error) {
            warn('tab-action open 触发 ensure 失败', error);
            snapshot = instance.status();
          }
        }
        if (snapshot.state !== 'running') {
          sendJson(res, 409, { ok: false, error: 'browser-not-running', state: snapshot.state });
          return;
        }
        let probe = await instance.probeEndpoint();
        if (!probe.reachable && action === 'open' && typeof instance.ensure === 'function') {
          try {
            snapshot = await instance.ensure({ reason: 'tab-action-open-unreachable' });
            probe = await instance.probeEndpoint();
          } catch (error) {
            warn('tab-action open 在端点不可达时 ensure 失败', error);
            probe = await instance.probeEndpoint();
          }
        }
        if (!probe.reachable) {
          sendJson(res, 409, { ok: false, error: 'endpoint-unreachable', state: snapshot.state });
          return;
        }
        const encoded = encodeURIComponent(targetId);
        if (action === 'bring-to-front') {
          // 1) 浏览器内切到该标签（HTTP activate ≈ Page.bringToFront）。
          const result = await debugRequest(probe.port, `/json/activate/${encoded}`);
          if (!result.ok || result.status >= 400) {
            sendJson(res, 502, { ok: false, error: 'activate-failed', status: result.status });
            return;
          }
          // 2) CDP：若窗口最小化，先恢复为 normal（只闪任务栏时常见）。
          let client = null;
          try {
            client = getCdpClient?.() ?? null;
          } catch (error) {
            warn('tab-action 取 CDP 客户端失败', error);
          }
          await restoreChromeWindowViaCdp(client, targetId);
          // 3) Win32：真正把操作系统窗口提到前台（用户点的，允许抢焦点）。
          const pids = [];
          if (Number.isSafeInteger(snapshot.pid) && snapshot.pid > 0) pids.push(snapshot.pid);
          try {
            const profileDir = typeof instance.dataDir === 'string' && instance.dataDir !== ''
              ? instance.dataDir
              : (typeof instance.profileDir === 'string' ? instance.profileDir : '');
            if (profileDir !== '') {
              const found = await findChromePidsByProfileDir(profileDir);
              for (const pid of found) pids.push(pid);
            }
          } catch (error) {
            warn('tab-action 查找 Chrome PID 失败', error);
          }
          const focused = await bringProcessWindowsToFront(pids);
          if (!focused.ok && focused.reason !== 'not-windows') {
            warn(`显示浏览器窗口：系统前台唤起未成功（${focused.reason}）`);
          }
          sendJson(res, 200, { ok: true, action, targetId, windowFocus: focused.reason });
          return;
        }
        if (action === 'close') {
          const result = await debugRequest(probe.port, `/json/close/${encoded}`);
          if (!result.ok || result.status >= 400) {
            sendJson(res, 502, { ok: false, error: 'close-failed', status: result.status });
            return;
          }
          sendJson(res, 200, { ok: true, action, targetId });
          return;
        }
        // `open`：新标签。新版 Chrome 只认 PUT，老版本接受 GET，两个都试。
        const url = typeof body?.url === 'string' && body.url.trim() !== '' ? body.url.trim() : 'about:blank';
        let created = await debugRequest(probe.port, `/json/new?${encodeURIComponent(url)}`, 'PUT');
        if (!created.ok || created.status >= 400) {
          created = await debugRequest(probe.port, `/json/new?${encodeURIComponent(url)}`, 'GET');
        }
        if (!created.ok || created.status >= 400) {
          sendJson(res, 502, { ok: false, error: 'open-failed', status: created.status });
          return;
        }
        let createdId = '';
        try {
          createdId = JSON.parse(created.body)?.id ?? '';
        } catch {
          createdId = '';
        }
        sendJson(res, 200, { ok: true, action, url, targetId: createdId });
        return;
      }
      sendJson(res, 404, { ok: false, error: `未知路径 ${method} ${path}` });
    } catch (error) {
      warn(`处理 ${method} ${path} 失败`, error);
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { kind: 'prefix', path: ROUTE_PREFIX, handler };
}
