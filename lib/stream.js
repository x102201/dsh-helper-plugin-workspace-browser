/**
 * 画面 WebSocket 路由（DESIGN.zh.md §7「画面 WebSocket」）。
 *
 * ```
 * ws://127.0.0.1:<dsh 端口>/dsh-helper-plugin-workspace-browser/stream
 * ```
 *
 * ## 为什么复用 lib/cdp.js 的帧编解码
 *
 * `lib/cdp.js` 是从**客户端**视角写的（`WebSocketClient.connect()` 发握手、`send()`
 * 默认加掩码），但里头两个函数是**方向无关**的：
 *
 * - `encodeFrame(payload, { mask: false })` —— 这正是服务端帧的形状（RFC6455 §5.1：
 *   服务端**必须不**加掩码）。默认值 `mask: true` 是给客户端用的，显式传 false 就对了。
 * - `parseFrame` / `FrameDecoder` —— 解析时掩码位是**读出来的**，不是假设的，所以
 *   解客户端帧一样正确，而且分片拼接、控制帧插队、ping→pong 都已经写好了。
 *
 * 所以这一层只自己写**握手的方向**（服务端算 `Sec-WebSocket-Accept`，而不是校验它）
 * 与生命周期管理，帧的字节层面一行都不重写。`test/stream.test.mjs` 里有测试证明：
 * 服务端帧不带掩码位、客户端掩码帧能解出来、16/64 位长度与分片都对。
 *
 * ## 回环校验
 *
 * 升级时对端不是回环地址就直接断开（§7）。这**不是登录校验**，是为了不让画面流跟着
 * DSH 的监听地址（可能配成 `0.0.0.0`）走出去。
 *
 * ## 消息
 *
 * 上行（客户端 → 服务端）：
 *
 * ```json
 * { "t": "subscribe", "targetIds": ["…"], "role": "focus", "fps": 2, "maxWidth": 960, "quality": 70 }
 * { "t": "unsubscribe", "targetIds": ["…"] }
 * { "t": "ack", "targetId": "…", "seq": 1 }
 * ```
 *
 * 另外支持一条 DESIGN §7 没写、但 §5「谁在看」需要的消息：
 *
 * ```json
 * { "t": "visibility", "visible": false }
 * ```
 *
 * 右侧栏收起时，客户端**会**主动断开或退订；这条消息是给"连接还在、面板不可见"
 * 这种情况用的（例如浮出面板收起）。`subscribe` 上也可以直接带 `visible`。
 *
 * 下行：`frame` / `state` / `targets`。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/stream
 */

import { createHash } from 'node:crypto';

import { encodeFrame, FrameDecoder, OPCODES } from './cdp.js';
import { ROUTE_PREFIX } from './routes.js';

/** 画面流的路径（§7）。 */
export const STREAM_PATH = `${ROUTE_PREFIX}/stream`;

/** RFC6455 握手魔术串（与 lib/cdp.js 一致）。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 上行消息里认识的类型；别的一律忽略（不出错、不断连接）。 */
export const UPSTREAM_TYPES = Object.freeze(['subscribe', 'unsubscribe', 'ack', 'visibility']);

/**
 * 对端地址是不是回环。
 *
 * `remoteAddress` 是 TCP 层的地址，只会是 IP 字面量；IPv4 映射成 IPv6 时形如
 * `::ffff:127.0.0.1`，两种都要认。
 *
 * @param {unknown} address - `socket.remoteAddress`。
 * @returns {boolean} 是回环为 true。
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const value = address.trim().toLowerCase();
  if (value === '') return false;
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    return mapped === '127.0.0.1' || mapped.startsWith('127.');
  }
  // 127.0.0.0/8 整段都算回环。
  return value.split('.')[0] === '127';
}

/**
 * 算握手应答头。
 *
 * @param {string} key - 请求里的 `Sec-WebSocket-Key`。
 * @returns {string} `Sec-WebSocket-Accept` 的值。
 */
export function computeAccept(key) {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

/**
 * 解析一条上行消息。**永不抛错** —— 坏消息返回 `null`，连接照旧。
 *
 * @param {string} text - 文本帧内容。
 * @returns {object | null} 解析结果；不是合法对象时为 null。
 */
export function parseUpstreamMessage(text) {
  if (typeof text !== 'string' || text === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const type = parsed.t;
  if (typeof type !== 'string' || !UPSTREAM_TYPES.includes(type)) return null;
  return parsed;
}

/**
 * 把 subscribe 里的 targetIds 收敛成字符串数组（去重、去空、非字符串丢掉）。
 *
 * @param {unknown} input - 原始值。
 * @returns {string[]} 干净的 target 列表。
 */
function readTargetIds(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value !== '' && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * 造出画面 WebSocket 路由。
 *
 * **只返回 `{ path, handler }`，不自己注册** —— 注册由宿主半边用
 * `ctx.webServer.registerUpgrade(route)` 完成（卸载时拿它返回的 disposer 撤下）。
 *
 * @param {object} options - 参数。
 * @param {object} options.hub - `createScreencastHub()` 的结果。
 * @param {() => boolean} [options.isLoopback] - 回环判定（测试注入；默认看 `remoteAddress`）。
 * @param {() => (object | null)} [options.getClient] - 取 CDP 客户端，用来补 `state` 里的信息（可选）。
 * @param {(message: string) => void} [options.info] - 普通日志。
 * @param {(message: string, error?: unknown) => void} [options.warn] - 异常日志。
 * @returns {{ path: string, handler: Function, dispose: Function, connections: () => number }} 升级路由。
 */
export function createStreamRoute(options) {
  const hub = options.hub;
  if (hub === null || typeof hub !== 'object') throw new Error('stream: 必须传入 hub');
  const info = options.info ?? (() => {});
  const warn = options.warn ?? (() => {});
  const customLoopback = options.isLoopback;

  /** @type {Set<object>} 活着的连接。 */
  const connections = new Set();
  let counter = 0;
  let disposed = false;

  /** 把当前的标签列表与会话状态推给一条连接。 */
  function sendSnapshot(connection) {
    const targets = typeof hub.targetsSnapshot === 'function' ? hub.targetsSnapshot() : [];
    const capture = typeof hub.captureState === 'function' ? hub.captureState() : null;
    connection.sink.send({ t: 'targets', targets, capture });
    return targets;
  }

  /** 把一组 target 的采集开关推给一条连接。 */
  function sendStates(connection, targetIds) {
    const targets = typeof hub.targetsSnapshot === 'function' ? hub.targetsSnapshot() : [];
    for (const targetId of targetIds) {
      const found = targets.find((target) => target.targetId === targetId);
      connection.sink.send({
        t: 'state',
        targetId,
        capturing: found?.capturing === true,
        attached: found?.attached === true,
        frontmost: found?.frontmost === true,
        frontmostInferred: found?.frontmostInferred === true,
        reason: found === undefined ? 'unknown-target' : '',
      });
    }
  }

  /** 广播：标签列表或采集总状态变了。 */
  function broadcastTargets() {
    if (disposed) return;
    const targets = typeof hub.targetsSnapshot === 'function' ? hub.targetsSnapshot() : [];
    const capture = typeof hub.captureState === 'function' ? hub.captureState() : null;
    for (const connection of connections) {
      connection.sink.send({ t: 'targets', targets, capture });
    }
  }

  /** 广播：某个 target 的采集开关变了。 */
  function broadcastState(payload) {
    if (disposed || payload === null || typeof payload !== 'object') return;
    for (const connection of connections) {
      connection.sink.send({ t: 'state', ...payload });
    }
  }

  const offUpdate = typeof hub.on === 'function' ? hub.on('update', broadcastTargets) : () => {};
  const offState = typeof hub.on === 'function' ? hub.on('state', broadcastState) : () => {};

  /**
   * 处理一条上行消息。
   *
   * @param {object} connection - 连接包装。
   * @param {string} text - 文本帧内容。
   * @returns {void}
   */
  function onMessage(connection, text) {
    const message = parseUpstreamMessage(text);
    if (message === null) return; // 非法消息：忽略，不崩、不断连接。
    switch (message.t) {
      case 'subscribe': {
        const targetIds = readTargetIds(message.targetIds);
        if (typeof message.visible === 'boolean') connection.visible = message.visible;
        hub.subscribe(connection.id, connection.sink, {
          targetIds,
          role: message.role === 'focus' ? 'focus' : 'thumb',
          fps: message.fps,
          maxWidth: message.maxWidth,
          quality: message.quality,
          visible: connection.visible,
        });
        sendSnapshot(connection);
        sendStates(connection, targetIds);
        return;
      }
      case 'unsubscribe': {
        const targetIds = readTargetIds(message.targetIds);
        hub.unsubscribe(connection.id, targetIds.length === 0 ? undefined : targetIds);
        sendSnapshot(connection);
        return;
      }
      case 'visibility': {
        if (typeof message.visible !== 'boolean') return;
        connection.visible = message.visible;
        hub.setVisible(connection.id, message.visible);
        sendSnapshot(connection);
        return;
      }
      case 'ack': {
        const targetId = typeof message.targetId === 'string' ? message.targetId : '';
        if (targetId === '') return;
        hub.ack(connection.id, targetId, message.seq);
        return;
      }
      default:
        // `parseUpstreamMessage` 已经过滤过类型，这里只是穷举兜底。
    }
  }

  /**
   * 造一条连接包装（含解码器与生命周期）。
   *
   * @param {import('node:net').Socket} socket - 已升级的套接字。
   * @param {Buffer} [head] - 升级响应后面已经跟着的字节。
   * @returns {object} 连接包装。
   */
  function createConnection(socket, head) {
    counter += 1;
    const connection = { id: `c${counter}`, socket, visible: true, closed: false, sink: null };

    const writeFrame = (frame) => {
      if (connection.closed || socket.destroyed) return;
      try {
        socket.write(frame);
      } catch (error) {
        warn('画面 WebSocket 写失败', error);
      }
    };

    connection.sink = {
      id: connection.id,
      send(message) {
        let payload;
        try {
          payload = JSON.stringify(message);
        } catch (error) {
          warn('画面下行消息无法序列化，已丢弃', error);
          return;
        }
        // 服务端帧**不加掩码**（RFC6455 §5.1）。
        writeFrame(encodeFrame(payload, { mask: false }));
      },
      bufferedBytes() {
        return typeof socket.writableLength === 'number' ? socket.writableLength : 0;
      },
    };

    const close = (reason) => {
      if (connection.closed) return;
      connection.closed = true;
      connections.delete(connection);
      hub.detach?.(connection.id);
      try {
        socket.destroy();
      } catch {
        // 已经销毁就无所谓。
      }
      info(`画面 WebSocket 断开（${connection.id}：${reason}）`);
    };

    const decoder = new FrameDecoder({
      onText: (text) => onMessage(connection, text),
      onBinary: () => {
        // 画面流只走文本帧；收到二进制帧当协议错误处理。
        close('binary-frame');
      },
      onPing: (payload) => writeFrame(encodeFrame(payload, { opcode: OPCODES.pong, mask: false })),
      onPong: () => {},
      onClose: () => {
        // 对端先关：回一个 close 帧再收摊（RFC6455 §5.5.1）。
        writeFrame(encodeFrame(Buffer.alloc(0), { opcode: OPCODES.close, mask: false }));
        close('peer-close');
      },
      onError: (error) => {
        warn('画面 WebSocket 协议错误', error);
        close('protocol-error');
      },
    });

    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('error', (error) => {
      warn('画面 WebSocket 套接字错误', error);
      close('socket-error');
    });
    socket.on('close', () => close('socket-closed'));
    socket.on('end', () => close('socket-end'));
    if (head !== undefined && head.length > 0) decoder.push(head);

    connections.add(connection);
    return connection;
  }

  /**
   * 升级处理器：**它自己负责协议协商与升级后的套接字**（§7）。
   *
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:stream').Duplex} socket - 原始套接字。
   * @param {Buffer} head - 升级后已经到达的字节。
   * @returns {void}
   */
  function handler(req, socket, head) {
    const remote = req?.socket?.remoteAddress ?? socket?.remoteAddress ?? '';
    const loopback = typeof customLoopback === 'function'
      ? customLoopback(req, socket) === true
      : isLoopbackAddress(remote);
    if (!loopback) {
      // 不是回环就走人：画面流不该跟着 DSH 的监听地址走出去（§7）。
      warn(`画面 WebSocket 拒绝非回环对端：${String(remote)}`);
      try {
        socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      } catch {
        // 写不进去就直接关。
      }
      socket.destroy();
      return;
    }

    const upgrade = String(req?.headers?.upgrade ?? '').toLowerCase();
    const key = req?.headers?.['sec-websocket-key'];
    if (upgrade !== 'websocket' || typeof key !== 'string' || key === '') {
      try {
        socket.write('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      } catch {
        // 同上。
      }
      socket.destroy();
      return;
    }

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${computeAccept(key)}`,
        '',
        '',
      ].join('\r\n'),
    );
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

    const connection = createConnection(socket, head);
    // 连上就先给一份快照：客户端不用等下一次变化才知道有哪些标签。
    sendSnapshot(connection);
    // ⚠️ 打破死锁：快照可能为空（CDP 还没连），客户端没标签就不会 subscribe，
    // reconcile 永远不跑。这里主动发现一次，发现后 hub 会 broadcast targets。
    if (typeof hub.ensureDiscovery === 'function') {
      void hub.ensureDiscovery().then(
        () => {},
        (error) => warn('画面通道：连上后发现标签失败', error),
      );
    }
  }

  return {
    path: STREAM_PATH,
    handler,
    /** 测试/卸载用：关掉所有连接并退掉 hub 订阅。 */
    dispose() {
      if (disposed) return;
      disposed = true;
      offUpdate();
      offState();
      for (const connection of [...connections]) {
        connection.sink.send({ t: 'state', reason: 'route-disposed' });
        connection.closed = true;
        connections.delete(connection);
        hub.detach?.(connection.id);
        try {
          connection.socket.destroy();
        } catch {
          // 忽略。
        }
      }
    },
    /** 当前活着的连接数（测试用）。 */
    connections() {
      return connections.size;
    },
  };
}
