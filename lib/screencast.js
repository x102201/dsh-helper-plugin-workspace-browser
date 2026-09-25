/**
 * 画面采集与分发（DESIGN.zh.md §5「帧」）。
 *
 * 这一层只做四件事，**不认识 WebSocket、不认识设置文件**：
 *
 * 1. **每个 target 只开一路 `Page.startScreencast`**，再把同一张画面分给各个订阅者。
 *    一个 target 被三个会话看，Chrome 上也只开一路采集 —— 否则带宽和 CPU 都白烧。
 * 2. **收到 `Page.screencastFrame` 立刻回 `Page.screencastFrameAck`**。这是给 Chrome
 *    的确认（不 ack，Chrome 就不再推下一帧），和浏览器页面回不回 ack 无关；页面侧
 *    的 ack 只决定某一条 WebSocket 要不要丢旧帧。
 * 3. **只保留最新一帧**。每个 target 一个"最新帧"槽位，新帧直接覆盖旧帧；订阅者
 *    的 socket 堵了（`bufferedBytes()` 过高）或者积压了太多没 ack 的帧就跳过这一次
 *    投递 —— 丢的永远是旧帧，画面不会越积越迟。
 * 4. **谁在看决定推不推**：任何一个**可见**订阅者存在就继续推，全部不可见才
 *    `Page.stopScreencast`。会话 B 关掉画面不能把会话 A 的帧停掉。
 *
 * ## 帧率是"上限"，不是"定时器"
 *
 * `Page.startScreencast` 没有帧率参数：Chrome 在页面有视觉变化时推帧，能调的只有
 * `everyNthFrame` 和图片尺寸/质量。所以帧率限流是**服务端自己算的**：每条
 * （连接 × target）记一个 `lastSentAt`，距上次投递不足 `1000/fps` 毫秒就跳过这一帧。
 * 页面不动时 Chrome 本来就不推帧 —— 画面停住是正常现象，不是卡死。
 *
 * ## 缩略图上限 12 张
 *
 * 只有"最近活跃的 12 张"开采集，其余只出标题不出画面（§5「张数」）。焦点目标
 * 不受这个额度限制（同时看 12 张缩略图 + 1 张焦点，这是 §5 的默认形态）。
 *
 * ## 设置从 options 注入
 *
 * 角色参数（fps / maxWidth / quality）由**调用方**通过 `roles` / `getRoles()`
 * 注入；这一层不读设置文件、也不认识 `streamFocusFps` 这类键名。映射关系留在
 * 宿主半边的接线上。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/screencast
 */

import { createCdpClient } from './cdp.js';
import { filmstripTargets, orderPagesByIds } from './instance.js';

/** 帧的 MIME 类型；`Page.startScreencast` 只支持 jpeg / png，这里固定 jpeg。 */
export const FRAME_MIME = 'image/jpeg';

/** 缩略图最多给几张开采集（§5「张数」）。 */
export const MAX_THUMB_TARGETS = 12;

/** 角色名。 */
export const ROLES = Object.freeze(['focus', 'thumb']);

/**
 * 角色默认参数（§5 的表格；与 lib/settings.js 的 `FIELD_DEFAULTS` 一致）。
 *
 * 调用方通常会注入别的值；这里的默认值只是"没接线时也不至于崩"的兜底。
 */
export const DEFAULT_ROLES = Object.freeze({
  focus: Object.freeze({ fps: 2, maxWidth: 960, quality: 70 }),
  thumb: Object.freeze({ fps: 0.25, maxWidth: 160, quality: 50 }),
});

/** 心跳/重试节拍：顺带负责"浏览器后来才起来"的重连与最顶层标签的探测。 */
const DEFAULT_TICK_MS = 1000;

/** 单条 WebSocket 的发送缓冲上限；超过就丢这一帧（§5「bufferedAmount 过高时丢旧帧」）。 */
const DEFAULT_HIGH_WATER_BYTES = 512 * 1024;

/** 允许积压多少条没被页面 ack 的帧。 */
const DEFAULT_MAX_UNACKED = 6;

/** 采集启动失败后的重试间隔，避免每一拍都去撞一次。 */
const RETRY_AFTER_FAILURE_MS = 2000;

/** `Runtime.evaluate` 问 `document.visibilityState` 时的超时。 */
const EVALUATE_TIMEOUT_MS = 800;

/** 帧率上限，挡住坏请求。 */
const MAX_FPS = 30;

/** 采集宽度上限，挡住坏请求。 */
const MAX_WIDTH = 4096;

/**
 * 把输入收敛成一个有限的数字。
 *
 * @param {unknown} value - 输入。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @param {number} fallback - 不是数字时的缺省值。
 * @returns {number} 收敛后的数字。
 */
function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * 把输入收敛成一个整数。
 *
 * @param {unknown} value - 输入。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @param {number} fallback - 不是数字时的缺省值。
 * @returns {number} 收敛后的整数。
 */
function clampInteger(value, min, max, fallback) {
  return Math.trunc(clampNumber(value, min, max, fallback));
}

/**
 * 一帧要隔多久才能再投递（毫秒）；`fps <= 0` 表示这一路不要画面。
 *
 * @param {number} fps - 帧率。
 * @returns {number | null} 间隔毫秒；不要画面时为 null。
 */
export function frameIntervalMs(fps) {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return Math.round(1000 / Math.min(MAX_FPS, fps));
}

/**
 * 归一化一个角色参数（§5：质量是 **0–100 的整数**）。
 *
 * @param {'focus' | 'thumb' | string} role - 角色名。
 * @param {object} [input] - 注入的参数。
 * @returns {{ fps: number, maxWidth: number, quality: number }} 归一化结果。
 */
export function normalizeRole(role, input = {}) {
  const fallback = DEFAULT_ROLES[role === 'focus' ? 'focus' : 'thumb'];
  const source = input !== null && typeof input === 'object' ? input : {};
  return {
    // 缩略图允许 0（= 不要缩略图）；焦点最低 0.5 fps，再低就没有"实时"的意义了。
    fps: clampNumber(source.fps, role === 'focus' ? 0.5 : 0, MAX_FPS, fallback.fps),
    maxWidth: clampInteger(source.maxWidth, 16, MAX_WIDTH, fallback.maxWidth),
    quality: clampInteger(source.quality, 0, 100, fallback.quality),
  };
}

/**
 * 归一化整张角色表。
 *
 * @param {object} [input] - `{ focus?: {...}, thumb?: {...} }`。
 * @returns {{ focus: object, thumb: object }} 归一化后的角色表。
 */
export function normalizeRoles(input = {}) {
  const source = input !== null && typeof input === 'object' ? input : {};
  return {
    focus: normalizeRole('focus', source.focus),
    thumb: normalizeRole('thumb', source.thumb),
  };
}

/**
 * 把两个订阅者对一个 target 的要求合成一份采集参数（取较大者）。
 *
 * 同一张画面只能有一路采集，所以宽度、质量取订阅者里最高的那个；焦点优先于缩略图
 * （焦点是"用户正在看"的那张）。
 *
 * @param {object | undefined} previous - 已有要求。
 * @param {object} next - 新要求。
 * @returns {object} 合成结果。
 */
function mergeDemand(previous, next) {
  if (previous === undefined) return { ...next };
  return {
    role: previous.role === 'focus' || next.role === 'focus' ? 'focus' : 'thumb',
    fps: Math.max(previous.fps, next.fps),
    maxWidth: Math.max(previous.maxWidth, next.maxWidth),
    quality: Math.max(previous.quality, next.quality),
  };
}

/**
 * 采集参数指纹。只有它变了才值得重启采集（帧率不是 CDP 参数，不进指纹）。
 *
 * @param {object} demand - 采集要求。
 * @returns {string} 指纹。
 */
function captureKey(demand) {
  return `${demand.maxWidth}x${demand.quality}`;
}

/**
 * 画面采集与分发中枢。
 *
 * 一个插件实例一个（一个工作区一个 Chrome）。上层是 {@link createStreamRoute}。
 */
export class ScreencastHub {
  /** @type {object} */
  #options;
  /** @type {object | null} CDP 客户端。 */
  #client = null;
  /** 客户端是不是这一层自己造的（自己造的才由自己关掉）。 */
  #ownsClient = false;
  /** @type {Map<string, object>} targetId → 采集通道。 */
  #channels = new Map();
  /** @type {Map<string, object>} connectionId → 订阅者。 */
  #viewers = new Map();
  /** @type {Map<string, Set<Function>>} 事件订阅。 */
  #listeners = new Map();
  /** @type {Map<string, string>} 扁平会话 id → targetId。 */
  #sessionToTarget = new Map();
  /** @type {Set<string>} 已经接管（attach 过）的 targetId —— 画面上的绿点。 */
  #attached = new Set();
  /** @type {Map<string, boolean>} targetId → 是否最顶层。 */
  #frontmost = new Map();
  /** 全部 hidden 时置真：画面沿用上一次结果，tooltip 要写明是推断（§10）。 */
  #frontmostInferred = false;
  /** @type {Array<object>} 最近一次看到的页面列表。 */
  #pages = [];
  /**
   * Chrome `/json/list` 给出的页面 id 顺序（对齐标签栏）；空数组表示还没有探到。
   * @type {string[]}
   */
  #pageOrderIds = [];
  /**
   * `/json/list` 最近一次成功拿到的页面（含 url/title），CDP 表空时给胶片条当 stubs。
   * @type {Array<object>}
   */
  #httpPages = [];
  /** CDP 表空、HTTP 有页时最多主动重连一次，避免每拍都 reconnect。 */
  #emptyTableReconnectAt = 0;
  /** 活跃序号：最近活跃的排在前面，缩略图额度按它排。 */
  #activityClock = 0;
  /** @type {Map<string, number>} targetId → 活跃序号。 */
  #activity = new Map();
  /** @type {NodeJS.Timeout | null} */
  #tick = null;
  /** 采集参数代际：断开/重连/重启采集时自增，让在途的启动作废。 */
  #generation = 0;
  /** 串行化 reconcile，避免并发开两路采集。 */
  #queue = Promise.resolve();
  /** 这一拍还在跑（最顶层标签要逐个问页面，慢了就跳过下一拍）。 */
  #ticking = false;
  /** @type {boolean} */
  #disposed = false;
  /** @type {Function[]} 对 CDP 客户端的退订函数。 */
  #clientOff = [];

  /**
   * @param {object} [options] - 参数。
   * @param {() => (object | null)} [options.getClient] - 取 CDP 客户端（测试/共享连接用）。
   * @param {() => object} [options.createClient] - 自己造客户端时用的工厂。
   * @param {object} [options.instance] - `createInstanceManager()` 的结果；没有 `getClient`/`createClient` 时用它造客户端。
   * @param {object} [options.roles] - 角色参数（§5 的表格）。
   * @param {() => object} [options.getRoles] - 每次现读角色参数（设置改了立刻生效）。
   * @param {() => Promise<string[] | Array<object>>} [options.listPageOrder] - 取 `/json/list` 顺序（id 数组或带 id 的页面）。
   * @param {number} [options.maxThumbTargets] - 缩略图额度，默认 12。
   * @param {number} [options.tickMs] - 节拍，默认 1000。
   * @param {number} [options.highWaterBytes] - 发送缓冲上限。
   * @param {number} [options.maxUnacked] - 允许积压的未 ack 帧数。
   * @param {() => number} [options.now] - 取当前时间（测试注入）。
   * @param {(message: string) => void} [options.info] - 普通日志。
   * @param {(message: string, error?: unknown) => void} [options.warn] - 异常日志。
   */
  constructor(options = {}) {
    this.#options = options;
  }

  // ── 对外：订阅 ────────────────────────────────────────────────────────────

  /**
   * 一条连接订阅若干 target。
   *
   * @param {string} connectionId - 连接标识（WebSocket 条数）。
   * @param {object} [sink] - 投递口：`{ send(message), bufferedBytes?() }`。
   * @param {object} [request] - 订阅请求。
   * @param {string[]} [request.targetIds] - 要看的 target。
   * @param {'focus' | 'thumb'} [request.role] - 角色。
   * @param {number} [request.fps] - 帧率上限。
   * @param {number} [request.maxWidth] - 采集宽度。
   * @param {number} [request.quality] - 采集质量（0–100）。
   * @param {boolean} [request.visible] - 这条连接现在看不看得见。
   * @returns {string[]} 实际记下的 target 列表。
   */
  subscribe(connectionId, sink, request = {}) {
    const viewer = this.#viewer(connectionId, sink);
    if (typeof request.visible === 'boolean') viewer.visible = request.visible;

    const role = request.role === 'focus' ? 'focus' : 'thumb';
    const roleDefaults = this.#roles()[role];
    const targetIds = Array.isArray(request.targetIds) ? request.targetIds : [];
    const accepted = [];

    for (const raw of targetIds) {
      const targetId = typeof raw === 'string' ? raw.trim() : '';
      if (targetId === '') continue;
      viewer.targets.set(targetId, {
        role,
        // 请求里给了就用请求的，没给就用角色默认值（§7 的上行消息带着这三个数）。
        fps: clampNumber(request.fps, role === 'focus' ? 0.5 : 0, MAX_FPS, roleDefaults.fps),
        maxWidth: clampInteger(request.maxWidth, 16, MAX_WIDTH, roleDefaults.maxWidth),
        quality: clampInteger(request.quality, 0, 100, roleDefaults.quality),
        lastSentAt: Number.NEGATIVE_INFINITY,
        lastSeq: 0,
        unacked: 0,
        sent: 0,
        dropped: 0,
      });
      this.#touch(targetId);
      accepted.push(targetId);
    }

    this.#ensureTick();
    void this.#reconcile();
    // 刚订上就**补一帧**：缓存里已经有这一路的最新帧时立刻投给这位观众。
    //
    // 不补的话会出现"这张标签还没有画面"**一直不消失**：Chrome 只在页面视觉变化时
    // 推 `Page.screencastFrame`，而这一路采集可能早就开着（别的观众订过、或刚从焦点
    // 切走又切回来），不会再发一帧初始画面 —— 于是静态页面的焦点区永远等不到第一帧。
    if (viewer.visible === true) {
      for (const targetId of accepted) {
        this.#deliver(targetId, { onlyViewer: viewer, force: true });
      }
    }
    return accepted;
  }

  /**
   * 退订。不给 `targetIds` 就退掉这条连接的全部订阅。
   *
   * @param {string} connectionId - 连接标识。
   * @param {string[]} [targetIds] - 要退的 target。
   * @returns {number} 退掉的条数。
   */
  unsubscribe(connectionId, targetIds) {
    const viewer = this.#viewers.get(String(connectionId ?? ''));
    if (viewer === undefined) return 0;
    let removed = 0;
    const list = Array.isArray(targetIds) ? targetIds : [...viewer.targets.keys()];
    for (const raw of list) {
      if (viewer.targets.delete(String(raw))) removed += 1;
    }
    this.#syncTick();
    void this.#reconcile();
    return removed;
  }

  /**
   * 改这条连接的可见性。
   *
   * 「任何一个可见订阅者就继续推，全部不可见才停」（§5）：这个方法就是那个开关。
   * 会话 B 关掉画面只影响 B 自己那一票。
   *
   * @param {string} connectionId - 连接标识。
   * @param {boolean} visible - 是否可见（含浮出的面板）。
   * @returns {boolean} 是否已知这条连接。
   */
  setVisible(connectionId, visible) {
    const viewer = this.#viewers.get(String(connectionId ?? ''));
    if (viewer === undefined) return false;
    const wasVisible = viewer.visible === true;
    viewer.visible = visible !== false;
    // 从"看不见"变回"看得见"时要**补一帧**：缓存里那一帧是好的，但 Chrome 不会因为
    // 你切回来就再推一次（它只在页面视觉变化时推帧）。不补的话，切走再切回来会一直
    // 停在最后一帧、甚至停在"还没有画面"。
    if (viewer.visible && !wasVisible) {
      for (const targetId of viewer.targets.keys()) {
        this.#deliver(targetId, { onlyViewer: viewer, force: true });
      }
    }
    this.#syncTick();
    void this.#reconcile();
    return true;
  }

  /**
   * 连接断开：退掉它的全部订阅。**只影响这一条连接**。
   *
   * @param {string} connectionId - 连接标识。
   * @returns {void}
   */
  detach(connectionId) {
    const id = String(connectionId ?? '');
    if (!this.#viewers.delete(id)) return;
    this.#syncTick();
    void this.#reconcile();
  }

  /**
   * 页面侧 ack：这条 WebSocket 上的这一帧已经送达。
   *
   * 它**不**参与"要不要继续采集"的决定（那是可见性的事），只用来放松背压 ——
   * 积压太多没 ack 的帧时先丢旧帧（§5）。
   *
   * @param {string} connectionId - 连接标识。
   * @param {string} targetId - target。
   * @param {number} seq - 帧序号。
   * @returns {boolean} 是否是已知的订阅。
   */
  ack(connectionId, targetId, seq) {
    const viewer = this.#viewers.get(String(connectionId ?? ''));
    const entry = viewer?.targets.get(String(targetId ?? ''));
    if (entry === undefined) return false;
    if (Number.isSafeInteger(seq) && seq > entry.lastSeq) return false;
    entry.unacked = Math.max(0, entry.unacked - 1);
    return true;
  }

  // ── 对外：状态 ────────────────────────────────────────────────────────────

  /**
   * 标签列表（给客户端的 `targets` 下行消息）。
   *
   * `attached` 是"已接管"（画面上的绿点），`capturing` 是"正在开采集"，
   * `frontmost` 是"这个窗口里最顶层的标签"（下划线）。**没接管过的标签只会是灰点。**
   *
   * @returns {Array<object>} 标签列表。
   */
  targetsSnapshot() {
    // 连接着的时候以 CDP 的 target 表为准，顺手刷新缓存 —— 上层（WebSocket 路由）
    // 是**同步**要快照的：新连接一上来就要一份，不能等下一拍协调跑完，所以这里
    // 也顺手把客户端要过来（`#ensureClient()` 是幂等的）。
    const client = this.#ensureClient();
    if (client !== null && typeof client.isConnected === 'function' && client.isConnected() && typeof client.pages === 'function') {
      this.#pages = client.pages();
    }
    let ordered = orderPagesByIds(this.#pages, this.#pageOrderIds);
    let visible = filmstripTargets(ordered);
    // CDP 还没连上 / 表空 / 只有 about:blank 时，用最近一次 `/json/list` 顶上，
    // 否则客户端永远订不到标签 → reconcile 永远不跑 → 死锁。
    if (visible.length === 0 && this.#httpPages.length > 0) {
      ordered = orderPagesByIds(this.#httpPages, this.#pageOrderIds);
      visible = filmstripTargets(ordered);
    }
    return visible.map((page) => {
      const targetId = page.targetId ?? page.id ?? '';
      const channel = this.#channels.get(targetId);
      return {
        targetId,
        url: typeof page.url === 'string' ? page.url : '',
        title: typeof page.title === 'string' ? page.title : '',
        attached: this.#attached.has(targetId),
        capturing: channel?.capturing === true,
        frontmost: this.#frontmost.get(targetId) === true,
        frontmostInferred: this.#frontmostInferred,
      };
    });
  }

  /**
   * 主动发现标签：连 CDP、拉 `/json/list`、表空则重连，并广播一次。
   *
   * WebSocket 一连上就要调 —— 不能等客户端先 subscribe（没标签就订不了，会卡死）。
   *
   * @returns {Promise<void>} 结束时 resolve。
   */
  ensureDiscovery() {
    return this.#reconcile();
  }

  /**
   * 采集总状态（给客户端的 `targets` 下行消息里的 `capture` 段）。
   *
   * @returns {object} `{ state, reason, viewers, capturing, attached }`。
   */
  captureState() {
    const client = this.#client;
    const connected = client !== null && typeof client.isConnected === 'function' && client.isConnected();
    const viewers = this.#visibleViewers();
    let state = 'idle';
    let reason = 'no-viewers';
    if (this.#disposed) {
      state = 'closed';
      reason = 'disposed';
    } else if (viewers > 0 && !connected) {
      state = 'unavailable';
      reason = 'browser-not-running';
    } else if (viewers > 0) {
      state = 'running';
      reason = '';
    }
    return {
      state,
      reason,
      viewers,
      capturing: [...this.#channels.values()].filter((channel) => channel.capturing).length,
      attached: this.#attached.size,
      frontmostInferred: this.#frontmostInferred,
    };
  }

  /** 正在采集中（或已接管）的 target 数量，调试用。 */
  get channelCount() {
    return this.#channels.size;
  }

  /**
   * 等当前的采集协调跑完（测试与"订阅后立刻要状态"的场景用）。
   *
   * @returns {Promise<void>} 协调结束时 resolve。
   */
  whenIdle() {
    return this.#queue.then(
      () => {},
      () => {},
    );
  }

  /**
   * 订阅事件。
   *
   * - `update`：标签列表 / 采集总状态变了，上层该重发一次 `targets`。
   * - `state`：某个 target 的采集开关变了，上层该发一条 `state`。
   *
   * @param {'update' | 'state'} name - 事件名。
   * @param {Function} handler - 处理函数。
   * @returns {() => void} 取消订阅。
   */
  on(name, handler) {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(handler);
    this.#listeners.set(name, set);
    return () => set.delete(handler);
  }

  /**
   * 收尾：停采集、断客户端、停节拍。
   *
   * @returns {Promise<void>} 结束时 resolve。
   */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#stopTick();
    for (const off of this.#clientOff.splice(0)) {
      try {
        off();
      } catch {
        // 退订失败只能忽略。
      }
    }
    const client = this.#client;
    for (const targetId of [...this.#channels.keys()]) {
      if (client !== null && typeof client.isConnected === 'function' && client.isConnected()) {
        try {
          await client.command(targetId, 'Page.stopScreencast', {}, { timeoutMs: 1000 });
        } catch {
          // 收尾路径上的失败只能忽略。
        }
      }
    }
    this.#channels.clear();
    this.#viewers.clear();
    this.#attached.clear();
    this.#sessionToTarget.clear();
    this.#frontmost.clear();
    this.#pages = [];
    if (this.#ownsClient && client !== null) {
      try {
        client.close?.('screencast-dispose');
      } catch {
        // 同上。
      }
    }
    this.#client = null;
    this.#emit('update');
  }

  // ── 内部：订阅者管理 ──────────────────────────────────────────────────────

  /**
   * 取（或建）一条连接的订阅记录。
   *
   * @param {string} connectionId - 连接标识。
   * @param {object} [sink] - 投递口。
   * @returns {object} 订阅记录。
   */
  #viewer(connectionId, sink) {
    const id = String(connectionId ?? '');
    if (id === '') throw new Error('screencast: subscribe 需要 connectionId');
    let viewer = this.#viewers.get(id);
    if (viewer === undefined) {
      viewer = { id, sink: null, visible: true, targets: new Map() };
      this.#viewers.set(id, viewer);
    }
    if (sink !== null && sink !== undefined) viewer.sink = sink;
    return viewer;
  }

  /** 有几个"看得见且真的有订阅"的观众。 */
  #visibleViewers() {
    let count = 0;
    for (const viewer of this.#viewers.values()) {
      if (viewer.visible === true && viewer.targets.size > 0) count += 1;
    }
    return count;
  }

  /** 按需起停节拍：有可见观众才跑。 */
  #syncTick() {
    if (this.#visibleViewers() > 0) this.#ensureTick();
    else this.#stopTick();
  }

  /** 起节拍。 */
  #ensureTick() {
    if (this.#tick !== null || this.#disposed) return;
    const every = clampInteger(this.#options.tickMs, 100, 60000, DEFAULT_TICK_MS);
    this.#tick = setInterval(() => {
      void this.#onTick();
    }, every);
    this.#tick.unref?.();
  }

  /** 停节拍。 */
  #stopTick() {
    if (this.#tick === null) return;
    clearInterval(this.#tick);
    this.#tick = null;
  }

  /** 一拍：协调采集 + 刷新最顶层标签。**同一时间只跑一拍**（上一拍没完就跳过）。 */
  async #onTick() {
    if (this.#disposed || this.#ticking) return;
    if (this.#visibleViewers() === 0) {
      this.#stopTick();
      return;
    }
    this.#ticking = true;
    try {
      await this.#reconcile();
      await this.#refreshFrontmost();
    } finally {
      this.#ticking = false;
    }
  }

  /** 记一次活跃（缩略图额度按最近活跃排序）。 */
  #touch(targetId) {
    this.#activityClock += 1;
    this.#activity.set(targetId, this.#activityClock);
  }

  // ── 内部：采集协调 ────────────────────────────────────────────────────────

  /**
   * 把"谁想看什么"翻译成"Chrome 上开哪几路采集"。
   *
   * 串行执行：并发订阅不会开出两路采集。
   *
   * @returns {Promise<void>} 结束时 resolve。
   */
  #reconcile() {
    if (this.#disposed) return Promise.resolve();
    const run = this.#queue.then(
      () => this.#doReconcile(),
      () => this.#doReconcile(),
    );
    this.#queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** reconcile 的本体。 */
  async #doReconcile() {
    if (this.#disposed) return;
    const client = this.#ensureClient();

    // 先确认连接与页面列表，再决定采不采 —— 否则会给已经不存在的标签开采集。
    let connected = false;
    if (client !== null) {
      if (typeof client.isConnected !== 'function' || !client.isConnected()) {
        // 还没连上：试着连一次。`connect()` 是幂等的，浏览器没起来时它自己会拒绝，
        // 由下一拍再试（节拍只在有可见观众时跑）。
        if (typeof client.connect === 'function') {
          try {
            await client.connect();
          } catch (error) {
            this.#options.info?.(`画面采集：暂时连不上调试端口（${error instanceof Error ? error.message : String(error)}）`);
          }
        }
      }
      connected = typeof client.isConnected === 'function' && client.isConnected();
    }

    // 胶片条跟窗口标签栏从左到右对齐。有 tabStripIndex 用它，否则退回 /json/list 反序。
    await this.#refreshPageOrder();

    // 真机症状：实例已 running、HTTP 能列出标签，但 CDP 根本连不上（过期 wsPath）
    // 或 CDP 表空/只有 about:blank → 面板有标题、永远灰点、永远无画面。
    // 以前只在「已连接但表空」时重连；连不上时永远不会进那个分支。
    const cdpFilmstripEmpty =
      connected
      && client !== null
      && typeof client.pages === 'function'
      && filmstripTargets(client.pages()).length === 0;
    const needForceReconnect =
      client !== null
      && this.#httpPages.length > 0
      && (!connected || cdpFilmstripEmpty)
      && typeof client.reconnect === 'function';
    if (needForceReconnect) {
      const now = this.#now();
      if (now - this.#emptyTableReconnectAt > 5000) {
        this.#emptyTableReconnectAt = now;
        this.#options.info?.(
          connected
            ? '画面采集：CDP 无可显示标签但 /json/list 有页，重建连接'
            : '画面采集：HTTP 有标签但 CDP 未连上，强制重连',
        );
        try {
          await client.reconnect();
          connected = typeof client.isConnected === 'function' && client.isConnected();
        } catch (error) {
          this.#options.warn?.('画面采集：强制重连失败', error);
          connected = false;
        }
      }
    }

    this.#pages = connected && typeof client?.pages === 'function' ? client.pages() : [];

    const wanted = connected ? this.#wantedTargets() : new Map();
    if (connected && this.#pages.length > 0) {
      // CDP 表 + HTTP stubs 都算已知：胶片条可能先用 /json/list 的 id 订阅，
      // 若只认 CDP 会把订阅掐掉，永远开不了采集。
      const known = new Set(this.#pages.map((page) => page.targetId));
      for (const page of this.#httpPages) {
        const id = page.targetId ?? page.id;
        if (typeof id === 'string' && id !== '') known.add(id);
      }
      for (const targetId of [...wanted.keys()]) {
        if (!known.has(targetId)) wanted.delete(targetId);
      }
    }

    // 不再需要看的：停掉。
    for (const [targetId, channel] of [...this.#channels]) {
      if (!wanted.has(targetId)) {
        await this.#stopCapture(targetId, 'no-viewers');
        continue;
      }
      // 参数变了（有人要求更宽/更清晰）：重启这一路。
      const demand = wanted.get(targetId);
      if (channel.capturing && channel.paramsKey !== captureKey(demand)) {
        await this.#stopCapture(targetId, 'params-changed');
      }
    }

    if (!connected) {
      this.#emit('update');
      return;
    }

    const now = this.#now();
    for (const [targetId, demand] of wanted) {
      const channel = this.#channel(targetId);
      if (channel.capturing || channel.starting) continue;
      if (channel.failedAt !== 0 && now - channel.failedAt < RETRY_AFTER_FAILURE_MS) continue;
      await this.#startCapture(targetId, demand);
    }
    this.#emit('update');
  }

  /**
   * 刷新标签顺序与 HTTP 页面缓存。
   *
   * 优先用 CDP 的 `tabStripIndex`（窗口里从左到右）。没有这项时，
   * `/json/list` 往往和标签栏相反，仍反转一次作兜底。
   *
   * @returns {Promise<void>} 结束时 resolve。
   */
  async #refreshPageOrder() {
    const listed = await this.#listedPages();
    const stripIds = await this.#tabStripIds();
    if (stripIds.length > 0) {
      this.#pageOrderIds = stripIds;
      if (listed.pages.length > 0) this.#httpPages = listed.pages;
      return;
    }
    this.#pageOrderIds = listed.ids.slice().reverse();
    if (listed.pages.length > 0) this.#httpPages = listed.pages.slice().reverse();
  }

  /**
   * 窗口标签栏从左到右的页面 id。连不上或 Chrome 太旧时返回空数组。
   *
   * @returns {Promise<string[]>} 页面 targetId。
   */
  async #tabStripIds() {
    const client = this.#ensureClient();
    if (client === null || typeof client.tabStripPageIds !== 'function') return [];
    if (typeof client.isConnected === 'function' && !client.isConnected()) return [];
    try {
      const ids = await client.tabStripPageIds();
      if (!Array.isArray(ids)) return [];
      return ids.filter((id) => typeof id === 'string' && id !== '');
    } catch (error) {
      this.#options.warn?.('读取标签栏顺序失败', error);
      return [];
    }
  }

  /**
   * 读一次 `/json/list`（或宿主给的等价列表），不改顺序。
   *
   * @returns {Promise<{ ids: string[], pages: Array<object> }>} 原始顺序。
   */
  async #listedPages() {
    const listPageOrder = this.#options.listPageOrder;
    if (typeof listPageOrder !== 'function') return { ids: [], pages: [] };
    try {
      const raw = await listPageOrder();
      if (!Array.isArray(raw)) return { ids: [], pages: [] };
      const pages = [];
      const ids = [];
      for (const entry of raw) {
        if (typeof entry === 'string' && entry !== '') {
          ids.push(entry);
          continue;
        }
        if (entry === null || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' && entry.id !== ''
          ? entry.id
          : typeof entry.targetId === 'string'
            ? entry.targetId
            : '';
        if (id === '') continue;
        ids.push(id);
        pages.push({
          targetId: id,
          id,
          type: entry.type ?? 'page',
          url: typeof entry.url === 'string' ? entry.url : '',
          title: typeof entry.title === 'string' ? entry.title : '',
        });
      }
      return { ids, pages };
    } catch (error) {
      this.#options.warn?.('刷新标签顺序失败', error);
      return { ids: [], pages: [] };
    }
  }

  /**
   * 算出**这一拍需要采集哪些 target**，以及每一路的参数。
   *
   * - 焦点目标无条件采集（它就是要看的那张）。
   * - 缩略图目标按"最近活跃"排序，只取前 12 张。
   * - 同一 target 被多路订阅时取要求最高的那份参数。
   *
   * @returns {Map<string, object>} targetId → 采集要求。
   */
  #wantedTargets() {
    const focus = new Map();
    const thumb = new Map();
    for (const viewer of this.#viewers.values()) {
      if (viewer.visible !== true) continue;
      for (const [targetId, entry] of viewer.targets) {
        const bucket = entry.role === 'focus' ? focus : thumb;
        bucket.set(targetId, mergeDemand(bucket.get(targetId), entry));
      }
    }

    const wanted = new Map(focus);
    const budget = clampInteger(this.#options.maxThumbTargets, 1, 64, MAX_THUMB_TARGETS);
    const ranked = [...thumb.entries()]
      .sort((a, b) => (this.#activity.get(b[0]) ?? 0) - (this.#activity.get(a[0]) ?? 0))
      .slice(0, budget);
    for (const [targetId, demand] of ranked) {
      wanted.set(targetId, mergeDemand(wanted.get(targetId), demand));
    }
    return wanted;
  }

  /**
   * 取（或建）一个 target 的采集通道。
   *
   * @param {string} targetId - target。
   * @returns {object} 通道。
   */
  #channel(targetId) {
    let channel = this.#channels.get(targetId);
    if (channel === undefined) {
      channel = {
        targetId,
        capturing: false,
        starting: false,
        paramsKey: '',
        captureMaxWidth: 0,
        seq: 0,
        latest: null,
        failedAt: 0,
        lastError: '',
      };
      this.#channels.set(targetId, channel);
    }
    return channel;
  }

  /**
   * 开一路采集。
   *
   * @param {string} targetId - target。
   * @param {object} demand - 采集要求。
   * @returns {Promise<void>} 结束时 resolve。
   */
  async #startCapture(targetId, demand) {
    let client = this.#client;
    if (client === null || typeof client.isConnected !== 'function' || !client.isConnected()) {
      // 胶片条可能先靠 /json/list 顶上标题；这里必须把 CDP 拉起来才能出画面。
      client = this.#ensureClient();
      if (client !== null && typeof client.connect === 'function') {
        try {
          await client.connect();
        } catch (error) {
          this.#options.warn?.(`画面采集：连不上调试端口，无法采集 ${targetId}`, error);
          return;
        }
      }
    }
    if (client === null || typeof client.isConnected !== 'function' || !client.isConnected()) {
      this.#options.warn?.(`画面采集：CDP 未连接，跳过 ${targetId}`);
      return;
    }
    this.#client = client;
    const channel = this.#channel(targetId);
    if (channel.starting) return;
    channel.starting = true;
    const generation = this.#generation;
    const nextMaxWidth = clampInteger(demand.maxWidth, 16, MAX_WIDTH, 160);
    // 从缩略图档升到焦点档时清掉低清缓存，免得订阅瞬间把糊图塞进主画面。
    if (channel.captureMaxWidth > 0 && nextMaxWidth > channel.captureMaxWidth) {
      channel.latest = null;
    }
    channel.captureMaxWidth = nextMaxWidth;
    try {
      // attach 之后才能对页面发命令；顺带记住扁平会话，方便把事件认回 target。
      if (typeof client.attach === 'function') {
        const sessionId = await client.attach(targetId);
        if (typeof sessionId === 'string' && sessionId !== '') {
          this.#sessionToTarget.set(sessionId, targetId);
          this.#attached.add(targetId);
          this.#emit('state', { targetId, attached: true, capturing: false, reason: '' });
        }
      }
      // 显式等 Page.enable：attach 里是 fire-and-forget，和 startScreencast 抢队时偶发无帧。
      try {
        await client.command(targetId, 'Page.enable', {}, { timeoutMs: 3000 });
      } catch {
        /* enable 失败不挡采集；下面截图兜底还可能成功 */
      }
      await client.command(targetId, 'Page.startScreencast', {
        format: 'jpeg',
        quality: demand.quality,
        maxWidth: demand.maxWidth,
        // 每帧都推；真正的帧率上限由服务端这一层把关（CDP 没有 fps 参数）。
        everyNthFrame: 1,
      });
      if (generation !== this.#generation) return;
      channel.capturing = true;
      channel.paramsKey = captureKey(demand);
      channel.failedAt = 0;
      channel.lastError = '';
      this.#emit('state', {
        targetId,
        capturing: true,
        attached: this.#attached.has(targetId),
        reason: '',
      });
      // start 返回前可能已收到并缓存了首帧（见 #onFrame 的 starting 分支）：立刻补投。
      if (channel.latest !== null) {
        this.#deliver(targetId, { force: true });
      } else {
        // 静态页有时连首帧都不推：用截图顶一张，避免永远「正在等第一帧…」。
        await this.#bootstrapStillFrame(targetId, demand);
      }
    } catch (error) {
      channel.capturing = false;
      channel.failedAt = this.#now();
      channel.lastError = error instanceof Error ? error.message : String(error);
      this.#options.warn?.(`开启画面采集失败（${targetId}）`, error);
      this.#emit('state', {
        targetId,
        capturing: false,
        attached: this.#attached.has(targetId),
        reason: 'capture-failed',
      });
      // 采集命令失败时仍试一张截图，总比空白好。
      try {
        await this.#bootstrapStillFrame(targetId, demand);
      } catch {
        /* 截图也失败就认了 */
      }
    } finally {
      channel.starting = false;
      this.#emit('update');
    }
  }

  /**
   * 用 `Page.captureScreenshot` 顶一张静帧（静态页 / 首帧丢失时的兜底）。
   *
   * @param {string} targetId - target。
   * @param {object} demand - 采集要求（取 quality）。
   * @returns {Promise<void>} 结束时 resolve。
   */
  async #bootstrapStillFrame(targetId, demand) {
    const client = this.#client;
    const channel = this.#channels.get(targetId);
    if (client === null || channel === undefined || channel.latest !== null) return;
    if (typeof client.isConnected !== 'function' || !client.isConnected()) return;
    const quality = clampInteger(demand?.quality, 0, 100, 60);
    // fromSurface 在部分标签（最小化、跨域保护、硬件加速异常）会空数据；再退回默认截图。
    const attempts = [
      { format: 'jpeg', quality, fromSurface: true },
      { format: 'jpeg', quality },
      { format: 'png' },
    ];
    for (const params of attempts) {
      try {
        const result = await client.command(targetId, 'Page.captureScreenshot', params, { timeoutMs: 4000 });
        const data = typeof result?.data === 'string' ? result.data : '';
        if (data === '') continue;
        channel.seq += 1;
        channel.latest = {
          targetId,
          seq: channel.seq,
          ts: this.#now(),
          dataB64: data,
          mime: params.format === 'png' ? 'image/png' : FRAME_MIME,
          maxWidth: channel.captureMaxWidth || clampInteger(demand?.maxWidth, 16, MAX_WIDTH, 960),
          w: 0,
          h: 0,
        };
        this.#attached.add(targetId);
        this.#deliver(targetId, { force: true });
        this.#emit('state', {
          targetId,
          attached: true,
          capturing: channel.capturing === true,
          reason: '',
        });
        this.#emit('update');
        return;
      } catch (error) {
        this.#options.warn?.(`静帧截图失败（${targetId}，${JSON.stringify(params)}）`, error);
      }
    }
  }

  /**
   * 停一路采集。
   *
   * @param {string} targetId - target。
   * @param {string} reason - 原因（只进日志与状态消息）。
   * @returns {Promise<void>} 结束时 resolve。
   */
  async #stopCapture(targetId, reason) {
    const channel = this.#channels.get(targetId);
    if (channel === undefined) return;
    this.#channels.delete(targetId);
    const client = this.#client;
    if (channel.capturing && client !== null && typeof client.isConnected === 'function' && client.isConnected()) {
      try {
        await client.command(targetId, 'Page.stopScreencast', {}, { timeoutMs: 2000 });
      } catch (error) {
        this.#options.warn?.(`停止画面采集失败（${targetId}）`, error);
      }
    }
    this.#emit('state', { targetId, capturing: false, reason });
    this.#emit('update');
  }

  // ── 内部：CDP 客户端 ──────────────────────────────────────────────────────

  /**
   * 拿到 CDP 客户端并挂上事件订阅。
   *
   * 三种来源，优先级从高到低：显式注入的 `getClient()`、`createClient()` 工厂、
   * 用 `instance` 自己造一个（插件只注入 `instance` 时也能工作）。
   *
   * @returns {object | null} 客户端。
   */
  #ensureClient() {
    // 每次都问 getClient()：实例换端口时宿主会换新客户端，若一直缓存旧实例，
    // 会出现「/json/list 有标签、画面永远等第一帧」（连着已 close 的旧 CDP）。
    let client = null;
    try {
      client = this.#options.getClient?.() ?? null;
    } catch (error) {
      this.#options.warn?.('取 CDP 客户端失败', error);
    }
    if (client === null && typeof this.#options.createClient === 'function') {
      try {
        client = this.#options.createClient();
      } catch (error) {
        this.#options.warn?.('创建 CDP 客户端失败', error);
      }
    }
    if (client === null && this.#options.instance) {
      if (this.#client !== null && this.#ownsClient) return this.#client;
      const instance = this.#options.instance;
      client = createCdpClient({
        getEndpoint: () => instance.endpoint,
        profileDir: instance.profileDir,
        info: this.#options.info,
        warn: this.#options.warn,
        onClosed: () => this.#onClientClosed(),
      });
      this.#ownsClient = true;
    }
    if (client === null) return this.#client;
    if (client !== this.#client) {
      for (const off of this.#clientOff.splice(0)) {
        try {
          off();
        } catch {
          /* 卸旧订阅失败无所谓 */
        }
      }
      this.#client = client;
      this.#watchClient(client);
    }
    return this.#client;
  }

  /**
   * 挂上 CDP 事件。
   *
   * ⚠️ `Page.screencastFrame` 的第二个参数是**扁平会话 id**（用来认 target），
   * 而 `params.sessionId` 是**采集会话 id**（用来 ack）—— 两者不是一个东西，
   * 混淆会让 ack 打到空气里。
   *
   * @param {object} client - 客户端。
   * @returns {void}
   */
  #watchClient(client) {
    if (typeof client.on !== 'function') return;
    this.#clientOff.push(
      client.on('Page.screencastFrame', (params, sessionId) => {
        this.#onFrame(params, sessionId);
      }),
    );
    this.#clientOff.push(
      client.on('targets', (pages) => {
        this.#pages = Array.isArray(pages) ? [...pages] : [];
        this.#emit('update');
      }),
    );
    this.#clientOff.push(
      client.on('closed', () => {
        this.#onClientClosed();
      }),
    );
  }

  /** CDP 断开：在途的东西全废掉，等下一拍重连。 */
  #onClientClosed() {
    this.#generation += 1;
    this.#attached.clear();
    this.#sessionToTarget.clear();
    this.#frontmost.clear();
    this.#pages = [];
    for (const channel of this.#channels.values()) {
      channel.capturing = false;
      channel.starting = false;
      channel.paramsKey = '';
      channel.latest = null;
    }
    this.#channels.clear();
    this.#emit('update');
  }

  // ── 内部：帧 ──────────────────────────────────────────────────────────────

  /**
   * 收到一帧。
   *
   * 顺序很重要：**先回 ack（不 await）**，再更新"最新帧"，最后投递。
   *
   * @param {object} params - `Page.screencastFrame` 的参数。
   * @param {string} [flatSessionId] - 扁平会话 id。
   * @returns {void}
   */
  #onFrame(params, flatSessionId) {
    const targetId = this.#sessionToTarget.get(String(flatSessionId ?? '')) ?? '';
    if (targetId === '') return;
    const channel = this.#channels.get(targetId);
    if (channel === undefined) return;

    // 1) 立刻确认。这是给 Chrome 的，不是给浏览器页面的（§5「帧」）。
    void this.#ackToChrome(targetId, params?.sessionId);

    const data = typeof params?.data === 'string' ? params.data : '';
    // ⚠️ 启动瞬间也要收帧：Chrome 常在 `Page.startScreencast` 的 await 还没回来时
    // 就推来**唯一的一帧**（已加载的百度等静态页不会再画）。以前只认 capturing，
    // 那一帧被 ack 掉却丢掉 → 永远「正在等第一帧…」。
    if (data === '' || (!channel.capturing && !channel.starting)) return;

    const metadata = params?.metadata !== null && typeof params?.metadata === 'object' ? params.metadata : {};
    const width = clampInteger(metadata.deviceWidth, 0, 100000, 0);
    const height = clampInteger(metadata.deviceHeight, 0, 100000, 0);

    // 2) 只保留最新一帧：直接覆盖，旧帧没有任何人还拿着。
    channel.seq += 1;
    channel.latest = {
      targetId,
      seq: channel.seq,
      ts: this.#now(),
      dataB64: data,
      mime: FRAME_MIME,
      maxWidth: channel.captureMaxWidth || 0,
      w: width,
      h: height,
    };
    this.#touch(targetId);

    // 3) 分发给此刻还看得见的订阅者。
    this.#deliver(targetId);
  }

  /**
   * 回 `Page.screencastFrameAck`。
   *
   * @param {string} targetId - target。
   * @param {unknown} screencastSessionId - 采集会话 id（`params.sessionId`）。
   * @returns {Promise<void>} 结束时 resolve。
   */
  async #ackToChrome(targetId, screencastSessionId) {
    const client = this.#client;
    if (client === null || typeof client.isConnected !== 'function' || !client.isConnected()) return;
    const numeric = Number(screencastSessionId);
    try {
      await client.command(
        targetId,
        'Page.screencastFrameAck',
        { sessionId: Number.isFinite(numeric) ? Math.trunc(numeric) : 0 },
        { timeoutMs: 2000 },
      );
    } catch (error) {
      // 漏一条 ack 只会让 Chrome 少推一帧，不值得打扰调用方。
      this.#options.warn?.('回 screencastFrameAck 失败', error);
    }
  }

  /**
   * 把最新一帧投给订阅者。
   *
   * 三道闸门（§5）：帧率间隔、发送缓冲、未 ack 积压。任何一道不过就**丢这一帧**，
   * 不做排队 —— 画面迟到比丢帧更糟。
   *
   * @param {string} targetId - target。
   * @param {object} [options] - 参数。
   * @param {object} [options.onlyViewer] - 只投给这一位观众（订阅/复可见时补帧用）。
   * @param {boolean} [options.force] - 跳过帧率间隔这一次（补帧必须是即时的）。
   * @returns {number} 这一轮投出去几份。
   */
  #deliver(targetId, options = {}) {
    const channel = this.#channels.get(targetId);
    const frame = channel?.latest;
    if (frame === undefined || frame === null) return 0;
    const now = this.#now();
    const highWater = clampInteger(this.#options.highWaterBytes, 1024, 64 * 1024 * 1024, DEFAULT_HIGH_WATER_BYTES);
    const maxUnacked = clampInteger(this.#options.maxUnacked, 1, 64, DEFAULT_MAX_UNACKED);
    const onlyViewer = options.onlyViewer ?? null;
    const force = options.force === true;
    let sent = 0;

    for (const viewer of this.#viewers.values()) {
      if (onlyViewer !== null && viewer !== onlyViewer) continue;
      if (viewer.visible !== true) continue;
      const entry = viewer.targets.get(targetId);
      if (entry === undefined) continue;
      // 主画面要焦点档清晰度：缩略图缓存（maxWidth 常只有 160）拉满会先糊一下再变清晰。
      if (entry.role === 'focus') {
        const need = entry.maxWidth;
        const have = Number(frame.maxWidth) || 0;
        if (need > 0 && have > 0 && have < need * 0.85) continue;
      }
      const interval = frameIntervalMs(entry.fps);
      // fps=0 表示平时不推缩略图；补帧（force）仍要送出，否则永远「没有画面」。
      if (interval === null && !force) continue;
      if (!force && interval !== null && now - entry.lastSentAt < interval) continue;

      const sink = viewer.sink;
      if (sink === null || sink === undefined || typeof sink.send !== 'function') continue;
      const buffered = typeof sink.bufferedBytes === 'function' ? Number(sink.bufferedBytes()) : 0;
      if (Number.isFinite(buffered) && buffered > highWater) {
        entry.dropped += 1;
        continue;
      }
      if (entry.unacked >= maxUnacked) {
        entry.dropped += 1;
        continue;
      }

      entry.lastSentAt = now;
      entry.lastSeq = frame.seq;
      entry.unacked += 1;
      entry.sent += 1;
      sent += 1;
      try {
        sink.send({
          t: 'frame',
          targetId,
          seq: frame.seq,
          ts: frame.ts,
          mime: typeof frame.mime === 'string' && frame.mime !== '' ? frame.mime : FRAME_MIME,
          dataB64: frame.dataB64,
          maxWidth: Number(frame.maxWidth) || 0,
          w: frame.w,
          h: frame.h,
        });
      } catch (error) {
        entry.unacked = Math.max(0, entry.unacked - 1);
        this.#options.warn?.(`投递画面帧失败（${targetId}）`, error);
      }
    }
    return sent;
  }

  // ── 内部：最顶层标签 ──────────────────────────────────────────────────────

  /**
   * 问一遍已接管页面的 `document.visibilityState`（§5「下划线」）。
   *
   * 全部 hidden（窗口被最小化/挡住）时**沿用最后一次结果**，并置 `frontmostInferred`，
   * 让 tooltip 能写明"这是推断"（§10 的待实测项）。
   *
   * @returns {Promise<void>} 结束时 resolve。
   */
  async #refreshFrontmost() {
    const client = this.#client;
    if (client === null || typeof client.isConnected !== 'function' || !client.isConnected()) return;
    const targets = [...this.#attached];
    if (targets.length === 0) return;
    const next = new Map();
    // 并发问：CDP 客户端同一 target 内部排队、不同 target 并行，所以 12 张也不会串成 12 份超时。
    const answers = await Promise.all(
      targets.map(async (targetId) => {
        try {
          const result = await client.command(
            targetId,
            'Runtime.evaluate',
            { expression: 'document.visibilityState', returnByValue: true },
            { timeoutMs: EVALUATE_TIMEOUT_MS },
          );
          const value = result?.result?.value;
          return typeof value === 'string' ? [targetId, value === 'visible'] : null;
        } catch {
          // 问不到就当作"不知道"，不覆盖上一次结果。
          return null;
        }
      }),
    );
    for (const answer of answers) {
      if (answer !== null) next.set(answer[0], answer[1]);
    }
    if (next.size === 0) return;
    const anyVisible = [...next.values()].some((visible) => visible === true);
    if (anyVisible) {
      this.#frontmost = next;
      this.#frontmostInferred = false;
    } else {
      // 全部 hidden：可能是窗口最小化。保留上一次结果，只标记为推断。
      this.#frontmostInferred = true;
    }
    this.#emit('update');
  }

  // ── 内部：杂项 ────────────────────────────────────────────────────────────

  /** 当前角色表（`getRoles()` 优先，其次构造时的 `roles`，最后是默认值）。 */
  #roles() {
    let injected = null;
    try {
      injected = this.#options.getRoles?.() ?? this.#options.roles ?? null;
    } catch (error) {
      this.#options.warn?.('读角色参数失败，改用默认值', error);
    }
    return normalizeRoles(injected ?? {});
  }

  /** 当前时间（测试可注入）。 */
  #now() {
    const now = typeof this.#options.now === 'function' ? Number(this.#options.now()) : Date.now();
    return Number.isFinite(now) ? now : Date.now();
  }

  /**
   * 派发事件。
   *
   * @param {'update' | 'state'} name - 事件名。
   * @param {object} [payload] - 载荷。
   * @returns {void}
   */
  #emit(name, payload) {
    const set = this.#listeners.get(name);
    if (set === undefined) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (error) {
        this.#options.warn?.(`画面事件的订阅者抛错（${name}）`, error);
      }
    }
  }
}

/**
 * 造一个画面采集与分发中枢。
 *
 * @param {object} [options] - 见 {@link ScreencastHub}。
 * @returns {ScreencastHub} 中枢。
 */
export function createScreencastHub(options = {}) {
  return new ScreencastHub(options);
}
