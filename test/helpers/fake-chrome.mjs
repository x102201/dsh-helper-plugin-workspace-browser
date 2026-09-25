/**
 * 假 Chrome：一个只认 CDP 的 WebSocket 服务端（**仅测试用**）。
 *
 * 为什么值得写：本插件的 WebSocket 是手写的，「客户端能跟一个真服务端对上话」这件事
 * 只能用另一头来验证。这里用同一个 `encodeFrame` / `FrameDecoder` 反向实现服务端
 * （服务端帧**不加掩码**），于是 `test/cdp.test.mjs` 能覆盖握手、掩码、分片、事件、
 * 排队、超时、断线这些真实路径，而不用起真的 Chrome。
 *
 * 它不是一个完整的 WS 实现：只做握手 + 文本帧 + 关闭，够 CDP 用。
 *
 * @module test/helpers/fake-chrome
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

import { encodeFrame, FrameDecoder, OPCODES } from '../../lib/cdp.js';

/** RFC6455 握手魔术串。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 1×1 的 PNG，用来当 `Page.captureScreenshot` 的应答。 */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC';

/** 睡眠。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 默认的 target 表：两张真标签 + 一张 devtools（后者会被 `pageTargets()` 排掉）。 */
function defaultTargets() {
  return [
    { targetId: 'TAB-1', type: 'page', url: 'https://example.com/login', title: '登录 - Example' },
    { targetId: 'TAB-2', type: 'page', url: 'https://example.com/docs', title: '文档' },
    { targetId: 'DEVTOOLS-1', type: 'page', url: 'devtools://devtools/bundled/inspector.html', title: 'DevTools' },
  ];
}

/**
 * 起一个假 Chrome。
 *
 * @param {object} [options] - 参数。
 * @param {(message: object, ctx: object) => (undefined | { result?: object, error?: object, silent?: boolean } | Promise<undefined | { result?: object, error?: object, silent?: boolean }>)} [options.onCommand] - 命令钩子；返回 `undefined` 用默认应答。
 * @param {Array<object>} [options.targets] - 初始 target 表。
 * @param {string|number} [options.evaluateResult] - `Runtime.evaluate` 的默认返回值（字符串）。
 * @param {(() => object) | object} [options.jsonVersion] - `/json/version` 的应答。
 * @returns {Promise<object>} 假 Chrome 句柄。
 */
export async function startFakeChrome(options = {}) {
  const state = {
    /** @type {Array<{ method: string, params: object, sessionId?: string }>} */
    commands: [],
    targets: options.targets === undefined ? defaultTargets() : [...options.targets],
    /** @type {Array<{ socket: import('node:net').Socket, send: (message: object) => void }>} */
    peers: [],
    /** 收到过多少个握手。 */
    handshakes: 0,
  };

  /**
   * 广播一个 CDP 事件。
   *
   * @param {string} method - 事件名。
   * @param {object} params - 参数。
   * @param {string} [sessionId] - 会话。
   * @returns {void}
   */
  function emitEvent(method, params, sessionId) {
    for (const peer of state.peers) {
      peer.send({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
    }
  }

  /** 默认应答。 */
  async function defaultReply(message) {
    const params = message.params ?? {};
    switch (message.method) {
      case 'Target.setDiscoverTargets':
        return { result: {} };
      case 'Target.getTargets':
        return { result: { targetInfos: state.targets } };
      case 'Target.attachToTarget':
        return { result: { sessionId: `S-${params.targetId}` } };
      case 'Page.enable':
        return { result: {} };
      case 'Runtime.evaluate':
        return { result: { result: { type: 'string', value: String(options.evaluateResult ?? '{}') } } };
      case 'Page.captureScreenshot':
        return { result: { data: options.screenshotBase64 ?? TINY_PNG_BASE64 } };
      case 'Test.slow':
        await sleep(Number.isSafeInteger(params.ms) ? params.ms : 100);
        return { result: { ok: true, method: message.method } };
      case 'Test.never':
        return { silent: true };
      case 'Test.fail':
        return { error: { code: -32000, message: typeof params.message === 'string' ? params.message : '故意失败' } };
      default:
        return { result: { ok: true } };
    }
  }

  /** 处理一条客户端命令。 */
  async function handleCommand(peer, message, sessionId) {
    state.commands.push({ method: message.method, params: message.params ?? {}, ...(sessionId === undefined ? {} : { sessionId }) });
    let reply;
    if (typeof options.onCommand === 'function') {
      reply = await options.onCommand({ ...message, sessionId }, { state, emitEvent, sleep });
    }
    if (reply === undefined) reply = await defaultReply(message);
    if (reply.silent === true) return;
    peer.send({
      id: message.id,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(reply.error === undefined ? { result: reply.result ?? {} } : { error: reply.error }),
    });
  }

  const server = createServer((req, res) => {
    const url = typeof req.url === 'string' ? req.url : '/';
    const path = url.split('?')[0];
    // `/json/version`：给「只有端口、没有 wsPath」的兜底路径用。
    if (path === '/json/version') {
      const payload =
        typeof options.jsonVersion === 'function'
          ? options.jsonVersion()
          : options.jsonVersion ?? { webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake` };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (path === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          state.targets.map((target) => ({
            id: target.targetId,
            type: target.type,
            url: target.url,
            title: target.title,
          })),
        ),
      );
      return;
    }
    if (path === '/json/new') {
      const created = {
        targetId: `TAB-NEW-${state.targets.length + 1}`,
        type: 'page',
        url: 'about:blank',
        title: '',
      };
      state.targets.push(created);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: created.targetId, type: created.type, url: created.url, title: created.title }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.on('upgrade', (req, socket) => {
    state.handshakes += 1;
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'),
    );
    socket.setNoDelay(true);

    const peer = {
      socket,
      send(message) {
        if (socket.destroyed) return;
        socket.write(encodeFrame(JSON.stringify(message), { mask: false }));
      },
    };
    state.peers.push(peer);

    const decoder = new FrameDecoder({
      onText: (text) => {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        if (message === null || typeof message !== 'object') return;
        if (typeof message.id !== 'number') return; // 事件不上行，测试里用不到
        void handleCommand(peer, message, message.sessionId);
      },
      onPing: (payload) => socket.write(encodeFrame(payload, { opcode: OPCODES.pong, mask: false })),
      onClose: () => socket.destroy(),
    });
    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    wsPath: '/devtools/browser/fake',
    state,
    emitEvent,
    /**
     * 粗暴断开所有连接（模拟 Chrome 被杀掉）。
     *
     * @returns {void}
     */
    dropConnections() {
      for (const peer of state.peers) peer.socket.destroy();
    },
    /**
     * 关掉假 Chrome。
     *
     * @returns {Promise<void>} 关完 resolve。
     */
    async close() {
      for (const peer of state.peers) peer.socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
