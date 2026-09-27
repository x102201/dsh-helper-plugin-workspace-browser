/**
 * 最小 CDP 客户端（DESIGN.zh.md §7「CDP」）。
 *
 * ## 为什么自己写 WebSocket
 *
 * 本插件**零运行时依赖**（见 index.js 顶部的说明），而 `ws` 是第三方包。CDP 需要
 * 的只是 RFC6455 里很小的一块：客户端握手、屏蔽（mask）文本帧、拼分片、回 ping。
 * 这点代码自己写比多一个依赖划算，也让「link: 安装」不受影响。
 *
 * ## 一条铁律：可用性判据必须端到端
 *
 * `endpoint.json` 在、`DevToolsActivePort` 在、端口有 HTTP 响应，都**不算**「运行中」。
 * 只有**握手成功 + `Target.setDiscoverTargets` + `Target.getTargets` 都成功**才算。
 * 所以 `connect()` 把这三步合在一起：任何一步失败都关掉连接并按「不可用」上报，
 * 让调用方（lib/tools.js）给出 `browser-not-running`，而不是拿着半死的连接去发命令。
 *
 * ## 并发模型
 *
 * - **同一 target 的命令排队**：页面级操作必须有序（点击→等待→读文字）。
 * - **不同 target 并行**：两条互不相干的标签谁也不等谁。
 *
 * 实现就是每个 target 一条 promise 链（见 `#enqueue`）。队列键是 `target:<targetId>`，
 * 所以 attach 与附着后的命令天然同队，不会出现「先命令后 attach」。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/cdp
 */

import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';

import { pageTargets } from './instance.js';
import { readDevToolsActivePort } from './paths.js';

/** RFC6455 握手魔术串。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 帧操作码。 */
export const OPCODES = Object.freeze({
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
});

/** 默认命令超时（DESIGN.zh.md §7）。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10000;

/** 默认握手超时。启动后的 attach 预算只有 3 秒，握手比这更短才对。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 3000;

/** 单帧上限。CDP 消息都很小，这个上限只为挡住坏掉的/恶意的对端把内存吃光。 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * 带机器可读 `code` 的错误。`code` 供上层映射成结构化错误（§6）。
 */
export class CdpError extends Error {
  /**
   * @param {string} code - 机器可读的错误码。
   * @param {string} message - 人话。
   */
  constructor(code, message) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

/**
 * 编码一个 WebSocket 帧。
 *
 * 客户端发出的帧**必须**带掩码（RFC6455 §5.3），服务端帧不带；两种情况都支持，
 * 因为测试里的假 Chrome 就是服务端（用 `mask: false`）。
 *
 * @param {Buffer | string} payload - 载荷。
 * @param {object} [options] - 参数。
 * @param {number} [options.opcode] - 操作码，默认文本帧。
 * @param {boolean} [options.fin] - 是否最后一帧，默认 true。
 * @param {boolean} [options.mask] - 是否加掩码，默认 true（客户端行为）。
 * @param {Buffer} [options.maskKey] - 固定掩码键，只给测试用。
 * @returns {Buffer} 帧字节。
 */
export function encodeFrame(payload, options = {}) {
  const opcode = options.opcode ?? OPCODES.text;
  const fin = options.fin !== false;
  const mask = options.mask !== false;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');

  const head = [((fin ? 0x80 : 0x00) | (opcode & 0x0f)) & 0xff];
  const maskBit = mask ? 0x80 : 0x00;
  if (body.length < 126) {
    head.push(maskBit | body.length);
  } else if (body.length < 65536) {
    // 16 位长度
    head.push(maskBit | 126, (body.length >>> 8) & 0xff, body.length & 0xff);
  } else {
    // 64 位长度：用 BigInt 写，避免 number 精度问题
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(BigInt(body.length));
    head.push(maskBit | 127);
    for (const byte of big) head.push(byte);
  }

  const header = Buffer.from(head);
  if (!mask) return Buffer.concat([header, body]);

  const key = options.maskKey ?? randomBytes(4);
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= key[index % 4];
  return Buffer.concat([header, key, masked]);
}

/**
 * 解析一个帧。数据不够一整帧时返回 `null`（调用方继续攒）。
 *
 * @param {Buffer} buffer - 已收到的字节。
 * @returns {{ fin: boolean, opcode: number, masked: boolean, payload: Buffer, rest: Buffer } | null} 解析结果。
 * @throws {CdpError} 帧头非法或长度超过上限时抛出。
 */
export function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    offset += 8;
    if (big > BigInt(MAX_FRAME_BYTES)) throw new CdpError('ws-frame-too-large', `WebSocket 帧过大：${big} 字节`);
    length = Number(big);
  }
  if (length > MAX_FRAME_BYTES) throw new CdpError('ws-frame-too-large', `WebSocket 帧过大：${length} 字节`);

  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey !== null) {
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index % 4];
  }
  return { fin, opcode, masked, payload, rest: Buffer.from(buffer.subarray(offset + length)) };
}

/**
 * 流式帧解码器：拼分片、回控制帧。
 *
 * 分片规则（RFC6455 §5.4）：首帧 opcode 是 text/binary 且 `fin === false`，后续帧
 * opcode 为 0（continuation），最后一帧 `fin === true`。控制帧（ping/pong/close）
 * 可以**插在分片中间**，所以它们单独处理，不进分片缓冲。
 */
export class FrameDecoder {
  /** @type {Buffer} */
  #buffer = Buffer.alloc(0);
  /** @type {Buffer[]} */
  #fragments = [];
  /** @type {number} */
  #fragmentOpcode = 0;
  /** @type {object} */
  #handlers;

  /**
   * @param {object} handlers - 回调。
   * @param {(text: string) => void} [handlers.onText] - 文本消息。
   * @param {(data: Buffer) => void} [handlers.onBinary] - 二进制消息。
   * @param {(payload: Buffer) => void} [handlers.onPing] - ping。
   * @param {(payload: Buffer) => void} [handlers.onPong] - pong。
   * @param {(code: number, reason: string) => void} [handlers.onClose] - 对端关闭。
   * @param {(error: Error) => void} [handlers.onError] - 协议错误。
   */
  constructor(handlers = {}) {
    this.#handlers = handlers;
  }

  /**
   * 喂入一段字节，触发尽可能多的回调。
   *
   * @param {Buffer | Uint8Array} chunk - 新收到的字节。
   * @returns {void}
   */
  push(chunk) {
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      let frame;
      try {
        frame = parseFrame(this.#buffer);
      } catch (error) {
        // 帧坏了就没法再对齐，只能丢掉缓冲区等上层断开。
        this.#buffer = Buffer.alloc(0);
        this.#handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (frame === null) return;
      this.#buffer = frame.rest;
      this.#handleFrame(frame);
    }
  }

  /**
   * 处理一个完整帧。
   *
   * @param {{ fin: boolean, opcode: number, payload: Buffer }} frame - 帧。
   * @returns {void}
   */
  #handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODES.continuation: {
        if (this.#fragmentOpcode === 0) {
          this.#handlers.onError?.(new CdpError('ws-protocol', '收到了没有起始帧的续帧'));
          return;
        }
        this.#fragments.push(frame.payload);
        if (!frame.fin) return;
        const joined = Buffer.concat(this.#fragments);
        const opcode = this.#fragmentOpcode;
        this.#fragments = [];
        this.#fragmentOpcode = 0;
        this.#emitMessage(opcode, joined);
        return;
      }
      case OPCODES.text:
      case OPCODES.binary: {
        if (!frame.fin) {
          this.#fragmentOpcode = frame.opcode;
          this.#fragments = [frame.payload];
          return;
        }
        this.#emitMessage(frame.opcode, frame.payload);
        return;
      }
      case OPCODES.ping:
        this.#handlers.onPing?.(frame.payload);
        return;
      case OPCODES.pong:
        this.#handlers.onPong?.(frame.payload);
        return;
      case OPCODES.close: {
        let code = 1005;
        let reason = '';
        if (frame.payload.length >= 2) {
          code = frame.payload.readUInt16BE(0);
          reason = frame.payload.subarray(2).toString('utf8');
        }
        this.#handlers.onClose?.(code, reason);
        return;
      }
      default:
        this.#handlers.onError?.(new CdpError('ws-protocol', `未知的 WebSocket 操作码：${frame.opcode}`));
    }
  }

  /**
   * 把拼好的消息派发出去。
   *
   * @param {number} opcode - 首个分片的操作码。
   * @param {Buffer} payload - 拼好的载荷。
   * @returns {void}
   */
  #emitMessage(opcode, payload) {
    if (opcode === OPCODES.text) this.#handlers.onText?.(payload.toString('utf8'));
    else this.#handlers.onBinary?.(payload);
  }
}

/**
 * 解析 `ws://host:port/path`。
 *
 * @param {string} url - 地址。
 * @returns {{ host: string, port: number, path: string } | null} 解析结果。
 */
function parseWsUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:') return null;
    const port = parsed.port === '' ? 80 : Number.parseInt(parsed.port, 10);
    if (!Number.isSafeInteger(port) || port <= 0) return null;
    return { host: parsed.hostname, port, path: `${parsed.pathname}${parsed.search}` || '/' };
  } catch {
    return null;
  }
}

/**
 * 一条已经建好的 WebSocket 连接。
 *
 * 只做「帧进、帧出、断开通知」，不含 CDP 语义。
 */
export class WebSocketClient {
  /** @type {import('node:net').Socket | null} */
  #socket = null;
  /** @type {FrameDecoder | null} */
  #decoder = null;
  /** @type {'open' | 'closed'} */
  #state = 'closed';
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();
  /** 关闭信息，保证 `close` 只报一次。 */
  #closeInfo = null;

  /**
   * @param {import('node:net').Socket} socket - 已完成握手的套接字。
   */
  constructor(socket) {
    this.#socket = socket;
    this.#state = 'open';
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    this.#decoder = new FrameDecoder({
      onText: (text) => this.#emit('message', text),
      onBinary: (data) => this.#emit('message', data),
      onPing: (payload) => {
        this.#emit('ping', payload);
        // 收到 ping 必须回 pong，否则 Chrome 会认为我们死了。
        this.#write(encodeFrame(payload, { opcode: OPCODES.pong }));
      },
      onPong: (payload) => this.#emit('pong', payload),
      onClose: (code, reason) => {
        // 对端先关：回一个 close 帧再把套接字收掉（RFC6455 §5.5.1）。
        this.#write(encodeFrame(Buffer.alloc(0), { opcode: OPCODES.close }));
        this.#finish(code, reason);
      },
      onError: (error) => this.#emit('error', error),
    });
    socket.on('data', (chunk) => this.#decoder?.push(chunk));
    socket.on('error', (error) => this.#finish(1006, `套接字错误：${error?.message ?? String(error)}`));
    socket.on('close', () => this.#finish(1006, '套接字已关闭'));
    socket.on('end', () => this.#finish(1006, '对端结束了连接'));
  }

  /**
   * 发起握手。连上之前就失败的话 reject，不留下半开的连接。
   *
   * @param {string} url - `ws://host:port/path`。
   * @param {object} [options] - 参数。
   * @param {number} [options.timeoutMs] - 握手超时。
   * @returns {Promise<WebSocketClient>} 已连接的客户端。
   */
  static connect(url, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const parsed = parseWsUrl(url);
    if (parsed === null) return Promise.reject(new CdpError('ws-bad-url', `不是有效的 ws:// 地址：${url}`));

    const key = randomBytes(16).toString('base64');
    const expected = createHash('sha1').update(key + WS_GUID).digest('base64');

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (code, message) => {
        if (settled) return;
        settled = true;
        try {
          req.destroy();
        } catch {
          // 已经销毁就无所谓。
        }
        reject(new CdpError(code, message));
      };

      const req = request({
        host: parsed.host,
        port: parsed.port,
        path: parsed.path,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
        timeout: timeoutMs,
      });

      req.on('upgrade', (res, socket, head) => {
        const accept = res.headers['sec-websocket-accept'];
        if (res.statusCode !== 101 || accept !== expected) {
          try {
            socket.destroy();
          } catch {
            // 忽略。
          }
          fail('ws-handshake-failed', `WebSocket 握手被拒绝（status=${res.statusCode ?? 0}）`);
          return;
        }
        if (settled) {
          try {
            socket.destroy();
          } catch {
            // 忽略。
          }
          return;
        }
        settled = true;
        const client = new WebSocketClient(socket);
        // 升级响应后面可能已经跟着帧字节了。
        if (head !== undefined && head.length > 0) client.#decoder?.push(head);
        resolve(client);
      });
      req.on('response', (res) => {
        fail('ws-handshake-failed', `调试端口返回 HTTP ${res.statusCode ?? 0}，不是 WebSocket 升级`);
        res.resume();
      });
      req.on('timeout', () => {
        fail('ws-handshake-timeout', `WebSocket 握手超时（${timeoutMs}ms）`);
      });
      req.on('error', (error) => {
        fail('ws-connect-failed', `连不上 ${parsed.host}:${parsed.port}（${error?.code ?? error?.message ?? String(error)}）`);
      });
      req.end();
    });
  }

  /** 连接是否可用。 */
  get isOpen() {
    return this.#state === 'open';
  }

  /**
   * 订阅事件。
   *
   * @param {'message' | 'ping' | 'pong' | 'close' | 'error'} event - 事件名。
   * @param {Function} handler - 处理函数。
   * @returns {() => void} 取消订阅。
   */
  on(event, handler) {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(handler);
    this.#listeners.set(event, set);
    return () => set.delete(handler);
  }

  /**
   * 发一条消息（字符串走文本帧，Buffer 走二进制帧）。
   *
   * @param {string | Buffer} data - 内容。
   * @returns {void}
   */
  send(data) {
    if (this.#state !== 'open') throw new CdpError('ws-closed', 'WebSocket 已经关闭');
    const opcode = typeof data === 'string' ? OPCODES.text : OPCODES.binary;
    this.#write(encodeFrame(data, { opcode }));
  }

  /**
   * 主动关闭。
   *
   * @param {number} [code] - 关闭码。
   * @param {string} [reason] - 原因。
   * @returns {void}
   */
  close(code = 1000, reason = '') {
    if (this.#state !== 'open') return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2, 'utf8');
    this.#write(encodeFrame(body, { opcode: OPCODES.close }));
    try {
      this.#socket?.end();
    } catch {
      // 忽略。
    }
    this.#finish(code, reason);
  }

  /**
   * 写一段字节（内部用，失败不抛给调用方）。
   *
   * @param {Buffer} frame - 帧字节。
   * @returns {void}
   */
  #write(frame) {
    const socket = this.#socket;
    if (socket === null || this.#state !== 'open') return;
    try {
      socket.write(frame);
    } catch (error) {
      this.#emit('error', error);
    }
  }

  /** 收尾：只报一次 `close`。 */
  #finish(code, reason) {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#closeInfo = { code, reason };
    try {
      this.#socket?.destroy();
    } catch {
      // 忽略。
    }
    this.#emit('close', this.#closeInfo);
    this.#listeners.clear();
  }

  /**
   * 派发事件。
   *
   * @param {string} event - 事件名。
   * @param {...unknown} args - 参数。
   * @returns {void}
   */
  #emit(event, ...args) {
    const set = this.#listeners.get(event);
    if (set === undefined) return;
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch {
        // 订阅者自己的错误不该影响连接。
      }
    }
  }
}

/**
 * 端口已知、wsPath 未知时，用 HTTP 调试端点补上浏览器级 WebSocket 路径。
 *
 * 这不是多余的：宿主进程重启后 `instance.endpoint` 可能只剩记住的端口
 * （`latchedPort`），而 `DevToolsActivePort` 也可能已经被 Chrome 清掉。
 *
 * @param {number} port - 调试端口。
 * @param {number} [timeoutMs] - 超时。
 * @returns {Promise<string>} wsPath；拿不到时为空串。
 */
export function fetchBrowserWsPath(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = request({ host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const url = typeof parsed?.webSocketDebuggerUrl === 'string' ? parsed.webSocketDebuggerUrl : '';
          done(parseWsUrl(url)?.path ?? '');
        } catch {
          done('');
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      done('');
    });
    req.on('error', () => done(''));
    req.end();
  });
}

/**
 * CDP 客户端：浏览器级连接 + target 表 + 扁平会话 + 命令排队。
 */
export class CdpClient {
  /** @type {object} */
  #options;
  /** @type {WebSocketClient | null} */
  #ws = null;
  /** @type {'closed' | 'open'} */
  #state = 'closed';
  /** 是否已经拿到过 target 表（端到端判据的最后一步）。 */
  #ready = false;
  /** @type {Map<number, { method: string, settle: (error: Error | null, result?: object) => void }>} */
  #pending = new Map();
  /** @type {number} */
  #nextId = 0;
  /** @type {Map<string, object>} targetId → targetInfo。 */
  #targets = new Map();
  /** @type {Map<string, string>} targetId → sessionId。 */
  #sessions = new Map();
  /** @type {Map<string, string>} sessionId → targetId。 */
  #sessionToTarget = new Map();
  /** @type {Map<string, Promise<string>>} 正在进行的 attach。 */
  #attachInflight = new Map();
  /** @type {Map<string, Promise<void>>} 每个 target 一条命令队列。 */
  #queues = new Map();
  /** @type {Map<string, string>} 标签栏 targetId → 里面那张页面的 targetId。 */
  #tabToPage = new Map();
  /** @type {Map<string, Set<Function>>} 事件订阅。 */
  #listeners = new Map();
  /** 默认 target（`workspace_browser_select_tab` 改的就是它）。 */
  #selectedTargetId = null;
  /** @type {number} */
  #port = 0;
  /** @type {Promise<void> | null} */
  #connecting = null;

  /**
   * @param {object} [options] - 参数。
   * @param {() => ({ port: number, wsPath: string } | null | undefined)} [options.getEndpoint] - 宿主侧当前的端口与 wsPath。
   * @param {string} [options.profileDir] - profile 目录（读 `DevToolsActivePort` 兜底）。
   * @param {() => string} [options.getProfileDir] - 当前实际使用的用户数据目录，优先于 `profileDir`。
   * @param {number} [options.commandTimeoutMs] - 单条命令超时。
   * @param {number} [options.connectTimeoutMs] - 握手超时。
   * @param {(info: object) => void} [options.onClosed] - 连接断开回调（P1 不自动重连）。
   * @param {(message: string) => void} [options.info] - 普通日志。
   * @param {(message: string, error?: unknown) => void} [options.warn] - 异常日志。
   */
  constructor(options = {}) {
    this.#options = options;
  }

  /** 调试端口；没连上时为 0。 */
  get port() {
    return this.#port;
  }

  /** 连接是否可用（含「拿到过 target 表」这一步）。 */
  isConnected() {
    return this.#state === 'open' && this.#ready && this.#ws?.isOpen === true;
  }

  /** 当前的默认 target。 */
  get selectedTargetId() {
    return this.#defaultTargetId();
  }

  /**
   * 订阅事件或生命周期。
   *
   * @param {string} name - `Target.targetCreated` 这样的 CDP 事件名，或 `closed` / `selected`。
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
   * 建立连接：解析端点 → 握手 → 发现 target → 取一次 target 表。
   *
   * @returns {Promise<void>} 成功时 resolve。
   * @throws {CdpError} 任何一步失败都抛；失败时会关掉连接，不留半开状态。
   */
  connect() {
    if (this.isConnected()) return Promise.resolve();
    if (this.#connecting !== null) return this.#connecting;
    const run = this.#doConnect().finally(() => {
      this.#connecting = null;
    });
    this.#connecting = run;
    return run;
  }

  /** 断开并重连（P1 的手动重连入口；没有后台自动重连）。 */
  async reconnect() {
    this.close('reconnect');
    await this.connect();
  }

  /**
   * 主动断开。在途请求全部 reject。
   *
   * @param {string} [reason] - 原因，只进日志。
   * @returns {void}
   */
  close(reason = 'manual') {
    const ws = this.#ws;
    this.#ws = null;
    this.#state = 'closed';
    this.#ready = false;
    if (ws !== null) ws.close(1000, reason);
    this.#resetConnectionState();
  }

  /**
   * 有没有可尝试的端点线索（**不判断端到端可用性**）。
   *
   * 上层用它来决定「值不值得发起一次连接」：一点线索都没有时直接报
   * `browser-not-running`，不去等一次必然失败的握手。
   *
   * @returns {boolean} 有线索为 true。
   */
  hasEndpointHint() {
    try {
      const fromHost = this.#options.getEndpoint?.();
      if (fromHost !== null && fromHost !== undefined && Number.isSafeInteger(fromHost.port) && fromHost.port > 0) return true;
    } catch {
      // 读宿主状态失败不算线索。
    }
    const profileDir = this.#activeProfileDir();
    if (profileDir !== '') {
      if (readDevToolsActivePort(profileDir) !== null) return true;
    }
    return false;
  }

  /**
   * 实际要读 `DevToolsActivePort` 的目录。
   *
   * 用户指定了数据目录时，文件在那份目录里，不在工作区自己的 profile 里。
   *
   * @returns {string} 目录；没有时为空串。
   */
  #activeProfileDir() {
    try {
      if (typeof this.#options.getProfileDir === 'function') {
        const dir = this.#options.getProfileDir();
        if (typeof dir === 'string' && dir !== '') return dir;
      }
    } catch {
      // 读目录失败就退回构造时记下的那份。
    }
    return typeof this.#options.profileDir === 'string' ? this.#options.profileDir : '';
  }

  /**
   * 列出这个工作区的页面 target（复用 `pageTargets()` 的过滤规则）。
   *
   * @returns {Array<object>} 页面 target。
   */
  pages() {
    return pageTargets([...this.#targets.values()]);
  }

  /**
   * 全部 target（页面之外还有 iframe / worker / 浏览器内部 target）。
   *
   * @returns {Array<object>} target 列表。
   */
  targets() {
    return [...this.#targets.values()];
  }

  /**
   * 改默认 target。**不碰窗口焦点**（绝不把窗口带到前台）。
   *
   * @param {string} targetId - target id。
   * @returns {boolean} 是否是已知的页面 target。
   */
  selectTarget(targetId) {
    const isPage = this.pages().some((page) => page.targetId === targetId);
    if (!isPage) return false;
    this.#selectedTargetId = targetId;
    this.#emit('selected', targetId);
    return true;
  }

  /**
   * 找到默认 target 并保证它有扁平会话。
   *
   * @param {string | null} [targetId] - 指定 target；省略时用默认 target。
   * @returns {Promise<{ targetId: string, sessionId: string, info: object | null }>} 目标。
   * @throws {CdpError} 没有可用 target 或 attach 失败时抛。
   */
  async resolveTarget(targetId = null) {
    const id = targetId ?? this.#defaultTargetId();
    if (id === null) throw new CdpError('no-target', '这个工作区还没有可操作的标签页。');
    const info = this.#targets.get(id) ?? null;
    const sessionId = await this.attach(id);
    return { targetId: id, sessionId, info };
  }

  /**
   * 对某个 target 发一条命令（自动 attach、自动排队）。
   *
   * @param {string | null} targetId - target；省略时用默认 target。
   * @param {string} method - CDP 方法名。
   * @param {object} [params] - 参数。
   * @param {object} [options] - 参数。
   * @param {number} [options.timeoutMs] - 超时。
   * @param {AbortSignal} [options.signal] - 取消信号。
   * @returns {Promise<object>} CDP 结果。
   */
  async command(targetId, method, params, options = {}) {
    const id = targetId ?? this.#defaultTargetId();
    if (id === null) throw new CdpError('no-target', '这个工作区还没有可操作的标签页。');
    const sessionId = await this.attach(id);
    return this.#enqueue(`target:${id}`, () => this.#send(method, params, sessionId, options));
  }

  /**
   * 发一条**浏览器级**命令（不带 sessionId）。
   *
   * `Target.*` / `Browser.*` 属于浏览器会话：`Target.createTarget` 这类必须从这里
   * 发。走 {@link command} 的话会被 attach 到某个标签的会话上（那是我加这个方法的
   * 原因 —— 接线时实测 `command(null, 'Target.createTarget', …)` 语义不对）。
   *
   * @param {string} method - CDP 方法名。
   * @param {object} [params] - 参数。
   * @param {object} [options] - 参数。
   * @param {number} [options.timeoutMs] - 超时。
   * @param {AbortSignal} [options.signal] - 取消信号。
   * @returns {Promise<object>} CDP 结果。
   */
  async commandBrowser(method, params, options = {}) {
    return this.#enqueue('browser', () => this.#send(method, params, undefined, options));
  }

  /**
   * 浏览器窗口里从左到右的页面 targetId。
   *
   * `/json/list` 不是标签栏顺序。Chrome 150 起，`type: "tab"` 的
   * `embedderData.tabStripIndex` 才是窗口里的位置。标签 target 和页面 target
   * 不是同一个 id，用 `Target.autoAttachRelated` 对上一次并缓存。
   *
   * 老版本没有 tab target 时返回空数组，调用方继续用原来的兜底顺序。
   *
   * @returns {Promise<string[]>} 页面 targetId，左到右。
   */
  tabStripPageIds() {
    if (!this.isConnected()) return Promise.resolve([]);
    return this.#enqueue('browser', () => this.#tabStripPageIds());
  }

  /**
   * @returns {Promise<string[]>} 页面 targetId。
   */
  async #tabStripPageIds() {
    let listed;
    try {
      listed = await this.#send('Target.getTargets', {
        filter: [{ type: 'tab', exclude: false }, { exclude: true }],
      }, undefined, {});
    } catch {
      return [];
    }
    const tabs = (Array.isArray(listed?.targetInfos) ? listed.targetInfos : [])
      .filter((info) => info !== null && typeof info === 'object' && info.type === 'tab' && Number.isInteger(info.embedderData?.tabStripIndex))
      .sort((a, b) => a.embedderData.tabStripIndex - b.embedderData.tabStripIndex);
    if (tabs.length === 0) return [];

    const alive = new Set(tabs.map((tab) => tab.targetId));
    for (const tabId of [...this.#tabToPage.keys()]) {
      if (!alive.has(tabId)) this.#tabToPage.delete(tabId);
    }

    const pageIds = [];
    for (const tab of tabs) {
      const tabId = tab.targetId;
      if (typeof tabId !== 'string' || tabId === '') continue;
      let pageId = this.#tabToPage.get(tabId) ?? '';
      if (pageId === '' || !this.#targets.has(pageId)) {
        pageId = await this.#pageIdForTab(tabId);
        if (pageId !== '') this.#tabToPage.set(tabId, pageId);
      }
      if (pageId !== '') pageIds.push(pageId);
    }
    return pageIds;
  }

  /**
   * 一个标签栏 target 里面的页面 target。
   *
   * @param {string} tabTargetId - `type: "tab"` 的 targetId。
   * @returns {Promise<string>} 页面 targetId；对不上时返回空串。
   */
  async #pageIdForTab(tabTargetId) {
    /** @type {Array<{ targetId: string, sessionId?: string }>} */
    const found = [];
    const off = this.on('Target.attachedToTarget', (params) => {
      const info = params?.targetInfo;
      if (info?.type !== 'page' || typeof info.targetId !== 'string' || info.targetId === '') return;
      found.push({
        targetId: info.targetId,
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
      });
    });
    try {
      await this.#send('Target.autoAttachRelated', {
        targetId: tabTargetId,
        waitForDebuggerOnStart: false,
        filter: [{ type: 'page', exclude: false }, { exclude: true }],
      }, undefined, {});
    } catch {
      return '';
    } finally {
      off();
    }
    const hit = found[0];
    if (hit === undefined) return '';
    const kept = this.#sessions.get(hit.targetId);
    if (typeof hit.sessionId === 'string' && kept !== undefined && kept !== hit.sessionId) {
      await this.#send('Target.detachFromTarget', { sessionId: hit.sessionId }, undefined, {}).catch(() => {});
    }
    return hit.targetId;
  }

  /**
   * 拿到 target 的扁平会话（已有就复用）。
   *
   * @param {string} targetId - target id。
   * @returns {Promise<string>} sessionId。
   */
  attach(targetId) {
    const existing = this.#sessions.get(targetId);
    if (existing !== undefined) return Promise.resolve(existing);
    const inflight = this.#attachInflight.get(targetId);
    if (inflight !== undefined) return inflight;

    const run = this.#enqueue(`target:${targetId}`, async () => {
      const result = await this.#send('Target.attachToTarget', { targetId, flatten: true }, undefined, {});
      const sessionId = typeof result?.sessionId === 'string' ? result.sessionId : '';
      if (sessionId === '') throw new CdpError('cdp-attach-failed', `attach 到 ${targetId} 没有拿到 sessionId。`);
      this.#sessions.set(targetId, sessionId);
      this.#sessionToTarget.set(sessionId, targetId);
      // `Page.frameNavigated` 要先 `Page.enable`。不 await：它只是订阅，失败也不该挡住命令。
      void this.#enqueue(`target:${targetId}`, () => this.#send('Page.enable', {}, sessionId, {}).catch(() => {}));
      this.#emit('attached', { targetId, sessionId });
      return sessionId;
    }).finally(() => {
      this.#attachInflight.delete(targetId);
    });

    this.#attachInflight.set(targetId, run);
    return run;
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────────

  /**
   * 连接主流程。
   *
   * @returns {Promise<void>} 成功时 resolve。
   */
  async #doConnect() {
    const endpoint = await this.#resolveEndpoint();
    if (endpoint === null) {
      throw new CdpError('browser-not-running', '找不到可用的调试端点：这个工作区的浏览器还没启动。');
    }

    const ws = await WebSocketClient.connect(`ws://127.0.0.1:${endpoint.port}${endpoint.wsPath}`, {
      timeoutMs: this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    });

    this.#ws = ws;
    this.#state = 'open';
    this.#port = endpoint.port;
    ws.on('message', (data) => this.#onMessage(data));
    ws.on('close', (info) => this.#onSocketClose(info));

    try {
      // 端到端判据的后两步：订阅 + 真的拿到 target 表。
      await this.#send('Target.setDiscoverTargets', { discover: true }, undefined, {});
      const list = await this.#send('Target.getTargets', {}, undefined, {});
      this.#ready = true;
      this.#ingestTargets(Array.isArray(list?.targetInfos) ? list.targetInfos : []);
    } catch (error) {
      this.close('handshake-verify-failed');
      const detail = error instanceof Error ? error.message : String(error);
      throw new CdpError('browser-not-running', `连上了调试端口，但拿不到标签列表：${detail}`);
    }
  }

  /**
   * 解析调试端点：宿主记录 → `DevToolsActivePort` → `/json/version`。
   *
   * @returns {Promise<{ port: number, wsPath: string } | null>} 端点。
   */
  async #resolveEndpoint() {
    let hostPort = 0;
    let hostWsPath = '';

    try {
      const fromHost = this.#options.getEndpoint?.();
      if (fromHost !== null && fromHost !== undefined) {
        if (Number.isSafeInteger(fromHost.port) && fromHost.port > 0) hostPort = fromHost.port;
        if (typeof fromHost.wsPath === 'string') hostWsPath = fromHost.wsPath;
      }
    } catch {
      // 宿主读端点失败不是致命错误，继续走下一条线索。
    }

    // 宿主端口就是画面 `/json/list` 正在用的那个。用户改了数据目录或调试端口之后，
    // 工作区 profile 里可能还留着上一份 DevToolsActivePort；它不能把连接带到别的端口上。
    // 文件只在宿主还不知道端口时兜底，而且只补同一端口上的 wsPath。
    let port = hostPort;
    let wsPath = '';
    const profileDir = this.#activeProfileDir();
    if (profileDir !== '') {
      const discovered = readDevToolsActivePort(profileDir);
      if (discovered !== null) {
        if (port === 0) port = discovered.port;
        if (port === discovered.port) wsPath = discovered.wsPath;
      }
    }
    if (wsPath === '') wsPath = hostWsPath;

    if (port === 0) return null;
    // 每次连接都向活着的 Chrome 问一次当前路径，挡住「port 对了、UUID 路径过期」。
    const livePath = await fetchBrowserWsPath(port);
    if (livePath !== '') wsPath = livePath;
    if (wsPath === '') return null;
    return { port, wsPath };
  }

  /**
   * 处理一条 CDP 消息（响应或事件）。
   *
   * @param {string | Buffer} data - 原始文本。
   * @returns {void}
   */
  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      this.#options.warn?.('CDP 返回了无法解析的消息，已忽略');
      return;
    }
    if (message === null || typeof message !== 'object') return;

    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      if (message.error !== undefined && message.error !== null) {
        const text = typeof message.error?.message === 'string' ? message.error.message : JSON.stringify(message.error);
        pending.settle(new CdpError('cdp-error', `${pending.method} 失败：${text}`));
      } else {
        pending.settle(null, message.result ?? {});
      }
      return;
    }

    if (typeof message.method === 'string') {
      this.#onEvent(message.method, message.params ?? {}, message.sessionId);
    }
  }

  /**
   * 维护 target 表并派发事件。
   *
   * @param {string} method - 事件名。
   * @param {object} params - 事件参数。
   * @param {string} [sessionId] - 会话（扁平模式下事件也带）。
   * @returns {void}
   */
  #onEvent(method, params, sessionId) {
    switch (method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged':
        this.#ingestTargets([params.targetInfo]);
        break;
      case 'Target.targetDestroyed':
        this.#dropTarget(params.targetId);
        break;
      case 'Target.attachedToTarget': {
        // 我们没主动 attach 过（例如别的客户端接管）时也把会话记下来。
        const targetId = params.targetInfo?.targetId;
        const sid = params.sessionId;
        if (typeof targetId === 'string' && typeof sid === 'string' && !this.#sessions.has(targetId)) {
          this.#sessions.set(targetId, sid);
          this.#sessionToTarget.set(sid, targetId);
        }
        break;
      }
      case 'Target.detachedFromTarget':
        this.#dropSession(params.sessionId);
        break;
      default:
        break;
    }
    this.#emit(method, params, sessionId);
    this.#emit('event', method, params, sessionId);
  }

  /**
   * 把 targetInfo 并进 target 表。
   *
   * @param {Array<object>} infos - `Target.getTargets` 或事件里的 targetInfo。
   * @returns {void}
   */
  #ingestTargets(infos) {
    for (const info of infos) {
      if (info === null || typeof info !== 'object') continue;
      const targetId = info.targetId;
      if (typeof targetId !== 'string' || targetId === '') continue;
      this.#targets.set(targetId, info);
    }
    this.#emit('targets', this.pages());
  }

  /**
   * 移除一个 target 及其会话。
   *
   * @param {string} targetId - target id。
   * @returns {void}
   */
  #dropTarget(targetId) {
    if (typeof targetId !== 'string') return;
    this.#targets.delete(targetId);
    const sessionId = this.#sessions.get(targetId);
    if (sessionId !== undefined) this.#dropSession(sessionId);
    this.#emit('targets', this.pages());
  }

  /**
   * 移除一个会话。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {void}
   */
  #dropSession(sessionId) {
    if (typeof sessionId !== 'string') return;
    const targetId = this.#sessionToTarget.get(sessionId);
    this.#sessionToTarget.delete(sessionId);
    if (targetId !== undefined) this.#sessions.delete(targetId);
  }

  /** 默认 target：显式选过的那个优先，没了就退回第一张页面。 */
  #defaultTargetId() {
    const pages = this.pages();
    if (pages.length === 0) return null;
    if (this.#selectedTargetId !== null && pages.some((page) => page.targetId === this.#selectedTargetId)) {
      return this.#selectedTargetId;
    }
    return pages[0].targetId ?? null;
  }

  /**
   * 发一条 CDP 命令（不排队、不 attach，内部用）。
   *
   * @param {string} method - 方法名。
   * @param {object} [params] - 参数。
   * @param {string} [sessionId] - 会话。
   * @param {object} [options] - 参数。
   * @returns {Promise<object>} 结果。
   */
  #send(method, params, sessionId, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.#options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const ws = this.#ws;
    if (this.#state !== 'open' || ws === null || !ws.isOpen) {
      return Promise.reject(new CdpError('cdp-closed', `CDP 连接未建立，无法执行 ${method}。`));
    }

    this.#nextId += 1;
    const id = this.#nextId;
    const message = { id, method };
    if (params !== undefined && params !== null) message.params = params;
    if (typeof sessionId === 'string' && sessionId !== '') message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const signal = options.signal;
      let timer = null;
      let done = false;
      /** 只结算一次：先清账（待办表、定时器、取消订阅），再落地。 */
      const settle = (error, result) => {
        if (done) return;
        done = true;
        this.#pending.delete(id);
        if (timer !== null) clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        if (error !== null && error !== undefined) reject(error);
        else resolve(result ?? {});
      };
      const onAbort = () => {
        settle(new CdpError('cdp-aborted', `CDP 命令已取消：${method}。`));
      };

      // 超时必须带上命令名，否则从日志里看不出卡在哪一条。
      timer = setTimeout(() => {
        settle(new CdpError('cdp-timeout', `CDP 命令超时（${timeoutMs}ms）：${method}。`));
      }, timeoutMs);

      this.#pending.set(id, { method, settle });

      if (signal !== undefined) {
        if (signal.aborted) {
          settle(new CdpError('cdp-aborted', `CDP 命令已取消：${method}。`));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        settle(new CdpError('cdp-send-failed', `发送 ${method} 失败：${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  /**
   * 把一个任务挂到某条队列的尾巴上。
   *
   * 前一个任务失败**不**影响后面的（用 `then(task, task)`），否则一条超时命令会把
   * 这条 target 的后续命令全废掉。
   *
   * @param {string} key - 队列键。
   * @param {() => Promise<any>} task - 任务。
   * @returns {Promise<any>} 任务结果。
   */
  #enqueue(key, task) {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.#queues.set(key, tail);
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
    return run;
  }

  /**
   * 套接字断开：reject 所有在途请求，清掉 target 表，通知订阅者。
   *
   * @param {{ code: number, reason: string }} info - 关闭信息。
   * @returns {void}
   */
  #onSocketClose(info) {
    if (this.#state !== 'closed') this.#options.info?.(`CDP 连接断开（code=${info.code}）：${info.reason}`);
    this.#state = 'closed';
    this.#ready = false;
    this.#ws = null;
    this.#resetConnectionState();
    const payload = { code: info.code, reason: info.reason, intentional: info.code === 1000 };
    this.#emit('closed', payload);
    try {
      this.#options.onClosed?.(payload);
    } catch (error) {
      this.#options.warn?.('closed 回调抛错，已忽略', error);
    }
  }

  /**
   * 复位与连接绑定的状态，并 reject 在途请求。
   *
   * @returns {void}
   */
  #resetConnectionState() {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      entry.settle(new CdpError('cdp-closed', `CDP 连接已断开，命令未完成：${entry.method}。`));
    }
    this.#targets.clear();
    this.#sessions.clear();
    this.#sessionToTarget.clear();
    this.#tabToPage.clear();
    this.#port = 0;
  }

  /**
   * 派发本地事件。
   *
   * @param {string} name - 事件名。
   * @param {...unknown} args - 参数。
   * @returns {void}
   */
  #emit(name, ...args) {
    const set = this.#listeners.get(name);
    if (set === undefined) return;
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch (error) {
        this.#options.warn?.(`CDP 事件 ${name} 的订阅者抛错`, error);
      }
    }
  }
}

/**
 * 造一个 CDP 客户端。
 *
 * @param {object} [options] - 见 {@link CdpClient}。
 * @returns {CdpClient} 客户端。
 */
export function createCdpClient(options = {}) {
  return new CdpClient(options);
}
