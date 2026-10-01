/**
 * 画面 WebSocket 路由测试（DESIGN §7「画面 WebSocket」）。
 *
 * 跑法：`node test/stream.test.mjs`（**逐个文件直接跑**；`node --test <目录>` 会
 * spawn 子进程并用管道抓输出，受限沙箱里会 EPERM）。
 *
 * 两件事要在这里证明：
 *
 * 1. **服务端帧的编解码确实复用了 `lib/cdp.js`**：`encodeFrame(payload, { mask: false })`
 *    就是服务端帧，`FrameDecoder` 解客户端带掩码的帧一样正确（掩码位是读出来的，
 *    不是假设的）。所以 `lib/stream.js` 里一行帧字节都没重写。
 * 2. **端到端连得上**：真 `node:http` 服务器的 upgrade 交给路由 handler，再用
 *    `lib/cdp.js` 里的 **客户端**（`WebSocketClient`）连上去 —— 也就是说，服务端
 *    那一半与"客户端视角"的那一半能对上话（真握手、真掩码、真分片）。
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { test } from 'node:test';

import { createCdpClient, encodeFrame, FrameDecoder, OPCODES, parseFrame, WebSocketClient } from '../lib/cdp.js';
import { createScreencastHub } from '../lib/screencast.js';
import { computeAccept, createStreamRoute, isLoopbackAddress, parseUpstreamMessage, STREAM_PATH } from '../lib/stream.js';
import { ROUTE_PREFIX } from '../lib/routes.js';
import { startFakeChrome } from './helpers/fake-chrome.mjs';

/** 睡眠。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 造一张页面 target。 */
function page(targetId, index = 1) {
  return { targetId, type: 'page', url: `https://e${index}.example/`, title: `标签 ${index}` };
}

/** 一帧的假数据。 */
function frameParams(screencastSessionId = 7, text = 'fake-jpeg') {
  return {
    data: Buffer.from(text, 'utf8').toString('base64'),
    metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1 },
    sessionId: screencastSessionId,
  };
}

/** 一个假套接字（只记写了什么）。 */
function fakeSocket() {
  const written = [];
  return {
    written,
    destroyed: false,
    write(chunk) {
      written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

// ── 1. 帧编解码：证明服务端能复用 lib/cdp.js ─────────────────────────────────

test('服务端帧不带掩码，客户端帧带掩码 —— 同一套编解码两头都对', () => {
  const serverFrame = encodeFrame('{"t":"targets"}', { mask: false });
  assert.equal(serverFrame[0], 0x81, 'FIN + 文本帧');
  assert.equal(serverFrame[1] & 0x80, 0, '服务端帧**不能**带掩码（RFC6455 §5.1）');
  const parsedServer = parseFrame(serverFrame);
  assert.equal(parsedServer.masked, false);
  assert.equal(parsedServer.payload.toString('utf8'), '{"t":"targets"}');

  const clientFrame = encodeFrame('{"t":"subscribe"}', { maskKey: Buffer.from([1, 2, 3, 4]) });
  assert.equal(clientFrame[1] & 0x80, 0x80, '客户端帧必须带掩码');
  const parsedClient = parseFrame(clientFrame);
  assert.equal(parsedClient.masked, true);
  assert.equal(parsedClient.payload.toString('utf8'), '{"t":"subscribe"}');
});

test('16 位与 64 位长度：服务端帧编码后能原样解回来', () => {
  const medium = Buffer.alloc(300, 0x41);
  const mediumFrame = encodeFrame(medium, { opcode: OPCODES.binary, mask: false });
  assert.equal(mediumFrame[1] & 0x7f, 126, '300 字节走 16 位长度');
  assert.equal(mediumFrame.readUInt16BE(2), 300);
  assert.ok(parseFrame(mediumFrame).payload.equals(medium));

  const large = Buffer.alloc(70000, 0x42);
  const largeFrame = encodeFrame(large, { opcode: OPCODES.binary, mask: false });
  assert.equal(largeFrame[1] & 0x7f, 127, '70000 字节走 64 位长度');
  assert.equal(Number(largeFrame.readBigUInt64BE(2)), 70000);
  assert.equal(parseFrame(largeFrame).payload.length, 70000);
});

test('分片拼接：客户端把一条消息拆成三片，服务端解码器拼回一条', () => {
  const messages = [];
  const decoder = new FrameDecoder({ onText: (text) => messages.push(text) });
  // 客户端分片也要带掩码，这里固定掩码键好断言。
  const key = Buffer.from([9, 8, 7, 6]);
  decoder.push(encodeFrame('{"t":"sub', { opcode: OPCODES.text, fin: false, maskKey: key }));
  decoder.push(encodeFrame('scribe","targe', { opcode: OPCODES.continuation, fin: false, maskKey: key }));
  decoder.push(encodeFrame('tIds":["A"]}', { opcode: OPCODES.continuation, fin: true, maskKey: key }));
  assert.deepEqual(messages, ['{"t":"subscribe","targetIds":["A"]}']);
});

test('控制帧插在分片中间：ping 先回、分片照样拼好', () => {
  const messages = [];
  const pings = [];
  const decoder = new FrameDecoder({ onText: (text) => messages.push(text), onPing: (payload) => pings.push(payload.toString('utf8')) });
  decoder.push(encodeFrame('前半', { opcode: OPCODES.text, fin: false, mask: false }));
  decoder.push(encodeFrame('ping!', { opcode: OPCODES.ping, mask: false }));
  decoder.push(encodeFrame('后半', { opcode: OPCODES.continuation, fin: true, mask: false }));
  assert.deepEqual(pings, ['ping!'], '控制帧不进分片缓冲');
  assert.deepEqual(messages, ['前半后半']);
});

test('握手应答：Sec-WebSocket-Accept 按 RFC6455 算', () => {
  // RFC6455 §1.3 的官方样例。
  assert.equal(computeAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

// ── 2. 上行消息解析 ──────────────────────────────────────────────────────────

test('上行消息：subscribe / unsubscribe / ack 各一条，非法消息不崩', () => {
  const subscribe = parseUpstreamMessage('{"t":"subscribe","targetIds":["A"],"role":"focus","fps":2,"maxWidth":960,"quality":70}');
  assert.equal(subscribe.t, 'subscribe');
  assert.deepEqual(subscribe.targetIds, ['A']);

  const unsubscribe = parseUpstreamMessage('{"t":"unsubscribe","targetIds":["A"]}');
  assert.equal(unsubscribe.t, 'unsubscribe');

  const ack = parseUpstreamMessage('{"t":"ack","targetId":"A","seq":3}');
  assert.equal(ack.t, 'ack');
  assert.equal(ack.seq, 3);

  // 非法消息一律返回 null（调用方直接忽略，不断连接）。
  assert.equal(parseUpstreamMessage('这不是 JSON'), null);
  assert.equal(parseUpstreamMessage('[1,2,3]'), null, '数组不算消息');
  assert.equal(parseUpstreamMessage('null'), null);
  assert.equal(parseUpstreamMessage('"字符串"'), null);
  assert.equal(parseUpstreamMessage('{}'), null, '没有 t');
  assert.equal(parseUpstreamMessage('{"t":123}'), null, 't 必须是字符串');
  assert.equal(parseUpstreamMessage('{"t":"unknown"}'), null, '不认识的 t 直接忽略');
  assert.equal(parseUpstreamMessage(''), null);
  assert.equal(parseUpstreamMessage(undefined), null);
});

test('路径与前缀：画面流挂在 DSH 的插件前缀下', () => {
  assert.equal(STREAM_PATH, `${ROUTE_PREFIX}/stream`);
});

// ── 3. 回环校验 ──────────────────────────────────────────────────────────────

test('回环判定：127/8、::1、IPv4-mapped 都算，其余不算', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.9.9.9'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('10.0.0.5'), false);
  assert.equal(isLoopbackAddress('192.168.1.20'), false);
  assert.equal(isLoopbackAddress('::ffff:10.0.0.5'), false);
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('非回环对端：直接断开，不做握手', () => {
  const route = createStreamRoute({ hub: { targetsSnapshot: () => [], captureState: () => null }, warn: () => {} });
  const socket = fakeSocket();
  route.handler(
    { headers: { upgrade: 'websocket', 'sec-websocket-key': 'abc' }, socket: { remoteAddress: '10.0.0.5' } },
    socket,
    Buffer.alloc(0),
  );
  assert.equal(socket.written.length, 1);
  assert.ok(socket.written[0].startsWith('HTTP/1.1 403 Forbidden'), `应是 403，实际：${socket.written[0]}`);
  assert.equal(socket.destroyed, true, '拒了就把套接字收掉');
  route.dispose();
});

test('回环但没有 WebSocket 升级头：400 并断开', () => {
  const route = createStreamRoute({ hub: { targetsSnapshot: () => [], captureState: () => null }, warn: () => {} });
  const socket = fakeSocket();
  route.handler({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, socket, Buffer.alloc(0));
  assert.ok(socket.written[0].startsWith('HTTP/1.1 400 Bad Request'));
  assert.equal(socket.destroyed, true);
  route.dispose();
});

// ── 4. 端到端：假 Chrome → 中枢 → 路由 → 真 WebSocket 客户端 ─────────────────

/**
 * 用裸套接字做一次握手（**不用** `WebSocketClient.connect`）。
 *
 * 为什么要多这一层：`WebSocketClient.connect()` 在 resolve 之前就会把升级响应后面
 * 跟着的字节（`head`）喂进解码器，那时调用方还没来得及注册监听 —— 浏览器里的
 * `new WebSocket()` 没有这个问题（`onmessage` 先注册再连），但测试里会漏掉
 * "连上就先发的第一帧"。裸套接字还能顺手断言**服务端第一帧没有掩码位**。
 *
 * @param {number} port - 端口。
 * @param {string} path - 路径。
 * @returns {Promise<{ socket: object, messages: string[], body: Buffer, headers: string }>} 连接与收到的消息。
 */
async function rawUpgrade(port, path) {
  const socket = netConnect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const key = randomBytes(16).toString('base64');
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );

  const messages = [];
  const bodyParts = [];
  const decoder = new FrameDecoder({
    onText: (text) => messages.push(text),
    onPing: (payload) => socket.write(encodeFrame(payload, { opcode: OPCODES.pong, mask: true })),
  });

  let buffer = Buffer.alloc(0);
  let header = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('裸握手超时')), 2000);
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      if (header !== '') {
        bodyParts.push(chunk);
        decoder.push(chunk);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const at = buffer.indexOf('\r\n\r\n');
      if (at === -1) return;
      clearTimeout(timer);
      header = buffer.subarray(0, at + 4).toString('latin1');
      const rest = buffer.subarray(at + 4);
      buffer = Buffer.alloc(0);
      resolve();
      if (rest.length > 0) {
        bodyParts.push(rest);
        decoder.push(rest);
      }
    });
  });

  return { socket, messages, body: Buffer.concat(bodyParts), headers: header };
}

test('端到端（裸套接字）：101 握手正确、第一条就是 targets、服务端帧不带掩码', async (t) => {
  const fake = await startFakeChrome({ targets: [page('TAB-1'), page('TAB-2')] });
  const cdp = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  await cdp.connect();
  const hub = createScreencastHub({ getClient: () => cdp, tickMs: 60000, warn: () => {}, info: () => {} });
  const route = createStreamRoute({ hub, warn: () => {}, info: () => {} });
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => route.handler(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const raw = await rawUpgrade(server.address().port, STREAM_PATH);
  t.after(async () => {
    raw.socket.destroy();
    route.dispose();
    await hub.dispose();
    cdp.close('test-over');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    await fake.close();
  });

  assert.ok(raw.headers.startsWith('HTTP/1.1 101 Switching Protocols'), `握手应成功：${raw.headers.split('\r\n')[0]}`);
  assert.ok(/sec-websocket-accept: /iu.test(raw.headers), '必须带 Sec-WebSocket-Accept');

  await sleep(50);
  assert.ok(raw.body.length >= 2, '连上就该收到一条快照');
  assert.equal(raw.body[0], 0x81, '第一条是 FIN + 文本帧');
  assert.equal(raw.body[1] & 0x80, 0, '服务端帧**不能**带掩码位');

  const snapshot = JSON.parse(raw.messages[0]);
  assert.equal(snapshot.t, 'targets');
  assert.deepEqual(
    snapshot.targets.map((target) => target.targetId),
    ['TAB-1', 'TAB-2'],
  );
  assert.ok('capture' in snapshot, '快照里带采集总状态');
  assert.equal(route.connections(), 1);
});

test('端到端：客户端 subscribe 之后能收到 state / frame，ack 与垃圾消息都不断连接', async (t) => {
  const fake = await startFakeChrome({ targets: [page('TAB-1'), page('TAB-2')] });
  const cdp = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  await cdp.connect();
  const hub = createScreencastHub({ getClient: () => cdp, tickMs: 60000, warn: () => {}, info: () => {} });
  const route = createStreamRoute({ hub, warn: () => {}, info: () => {} });

  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => route.handler(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const client = await WebSocketClient.connect(`ws://127.0.0.1:${server.address().port}${STREAM_PATH}`, { timeoutMs: 2000 });

  t.after(async () => {
    client.close('test-over');
    route.dispose();
    await hub.dispose();
    cdp.close('test-over');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    await fake.close();
  });

  // 收到的消息全进收件箱，避免"注册监听太晚"的竞态。
  const inbox = [];
  client.on('message', (data) => {
    try {
      inbox.push(JSON.parse(String(data)));
    } catch {
      /* 服务端只会发 JSON */
    }
  });
  const waitFor = async (predicate, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = inbox.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(`等消息超时；已收到：${JSON.stringify(inbox.map((message) => message.t))}`);
      }
      await sleep(10);
    }
  };

  // 订阅焦点那一张（订阅这一条消息本身会回一份 targets 快照）。
  client.send(
    JSON.stringify({ t: 'subscribe', targetIds: ['TAB-1'], role: 'focus', fps: 30, maxWidth: 320, quality: 50, visible: true }),
  );
  const snapshot = await waitFor((message) => message.t === 'targets');
  assert.deepEqual(
    snapshot.targets.map((target) => target.targetId),
    ['TAB-1', 'TAB-2'],
    '快照里是真正的标签页',
  );
  assert.equal(snapshot.targets[0].attached, false, '还没接管过就是灰点');

  const capturing = await waitFor((message) => message.t === 'state' && message.targetId === 'TAB-1' && message.capturing === true);
  assert.equal(capturing.capturing, true);
  assert.ok(
    fake.state.commands.some((entry) => entry.method === 'Page.startScreencast'),
    '宿主侧应该真的开了一路采集',
  );

  // 假 Chrome 推一帧 → 中枢 → WebSocket → 客户端（服务端帧不带掩码，客户端解得开）。
  // 截图兜底可能先到一帧；这里等过帧率间隔再认 screencast 那一帧。
  await sleep(50);
  const expectedJpeg = Buffer.from('jpeg-bytes', 'utf8').toString('base64');
  fake.emitEvent('Page.screencastFrame', frameParams(7, 'jpeg-bytes'), 'S-TAB-1');
  const frame = await waitFor((message) => message.t === 'frame' && message.dataB64 === expectedJpeg);
  assert.equal(frame.targetId, 'TAB-1');
  assert.equal(frame.mime, 'image/jpeg');
  assert.equal(frame.w, 800);
  assert.equal(frame.h, 600);
  assert.ok(frame.seq >= 1);
  assert.equal(typeof frame.ts, 'number');

  // 页面侧 ack + 垃圾消息 + 未知类型：都不该把连接弄断。
  client.send(JSON.stringify({ t: 'ack', targetId: 'TAB-1', seq: frame.seq }));
  client.send('这不是 JSON');
  client.send(JSON.stringify({ t: '不认识的类型' }));
  client.send(JSON.stringify({ t: 'subscribe' }));
  client.send(JSON.stringify({ t: 'visibility' }));
  await sleep(30);

  // 之后再推一帧，仍然收得到 → 连接还活着。
  // （等过一个帧率间隔：30 fps 也要 33ms，否则这一帧会被限流丢掉。）
  await sleep(150);
  inbox.length = 0;
  fake.emitEvent('Page.screencastFrame', frameParams(8, 'jpeg-2'), 'S-TAB-1');
  const second = await waitFor((message) => message.t === 'frame');
  assert.equal(second.dataB64, Buffer.from('jpeg-2', 'utf8').toString('base64'));

  // 每一帧都要真的回一条 screencastFrameAck 给 Chrome（不等页面的 ack）。
  assert.ok(
    fake.state.commands.filter((entry) => entry.method === 'Page.screencastFrameAck').length >= 2,
    '每一帧都要回 screencastFrameAck',
  );

  // 这条连接说"我不可见了"：都不可见 → 停采集。
  client.send(JSON.stringify({ t: 'visibility', visible: false }));
  await waitFor(() => fake.state.commands.some((entry) => entry.method === 'Page.stopScreencast'));

  // 退订 + 断开：路由上的连接数归零。
  client.send(JSON.stringify({ t: 'unsubscribe', targetIds: ['TAB-1'] }));
  await sleep(30);
  assert.equal(route.connections(), 1);
  client.close('bye');
  await sleep(50);
  assert.equal(route.connections(), 0, '断开后路由不再持有连接');
});

test('订阅里带 visible:false：连得上但不当观众，不开采集', async (t) => {
  const fake = await startFakeChrome({ targets: [page('TAB-1')] });
  const cdp = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  await cdp.connect();
  const hub = createScreencastHub({ getClient: () => cdp, tickMs: 60000, warn: () => {}, info: () => {} });
  const route = createStreamRoute({ hub, warn: () => {}, info: () => {} });
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => route.handler(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = await WebSocketClient.connect(`ws://127.0.0.1:${server.address().port}${STREAM_PATH}`, { timeoutMs: 2000 });

  t.after(async () => {
    client.close('test-over');
    route.dispose();
    await hub.dispose();
    cdp.close('test-over');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    await fake.close();
  });

  client.send(JSON.stringify({ t: 'subscribe', targetIds: ['TAB-1'], role: 'focus', fps: 2, visible: false }));
  await sleep(80);
  assert.equal(hub.captureState().viewers, 0, '不可见的订阅不计入观众');
  assert.equal(fake.state.commands.filter((entry) => entry.method === 'Page.startScreencast').length, 0, '没人看就不开采集');

  client.send(JSON.stringify({ t: 'visibility', visible: true }));
  await sleep(80);
  assert.equal(hub.captureState().viewers, 1);
  assert.equal(fake.state.commands.filter((entry) => entry.method === 'Page.startScreencast').length, 1, '变可见才开采集');
});

// ── 5. 客户端半边：画面中枢（同一个协议的"对端"） ────────────────────────────

/**
 * 起一个假的 WebSocket 类，把建出来的实例记下来。
 *
 * @returns {object} `{ instances, ctor }`。
 */
function fakeWebSocket() {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      instances.push(this);
    }

    send(text) {
      this.sent.push(JSON.parse(text));
    }

    close() {
      this.readyState = 3;
      if (typeof this.onclose === 'function') this.onclose();
    }

    /** 模拟握手成功。 */
    open() {
      this.readyState = 1;
      if (typeof this.onopen === 'function') this.onopen();
    }

    /** 模拟服务端下发。 */
    deliver(message) {
      if (typeof this.onmessage === 'function') this.onmessage({ data: JSON.stringify(message) });
    }
  }
  return { instances, ctor: FakeWebSocket };
}

/** 造一个只够画面中枢用的状态仓库。 */
function fakeStatusStore(settings = {}) {
  return {
    get: () => ({ value: { state: 'running', port: 1234, settings } }),
    subscribe: () => () => {},
    refresh: () => {},
  };
}

/** 极简 React：只够把组件树跑一遍看它抛不抛错（函数组件直接展开，跟 React 一样）。 */
function reactStub() {
  return {
    createElement: (type, ownProps, ...children) => {
      const props = { ...(ownProps ?? {}), children: children.length <= 1 ? children[0] : children };
      if (typeof type === 'function') return type(props);
      return { type, props };
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial ?? null }),
    useEffect: () => {},
  };
}

/** ModuleLoader 定义只拿一次：`import('../client.js')` 会走模块缓存，第二次不会重跑模块体。 */
let cachedClientDefinition = null;

/**
 * 载入 `client.js` 的 ModuleLoader 定义。
 *
 * @returns {Promise<object>} `{ id, factory }`。
 */
async function clientDefinition() {
  if (cachedClientDefinition !== null) return cachedClientDefinition;
  const previous = globalThis.window;
  globalThis.window = {
    ...previous,
    __ModuleLoader__: {
      load(def) {
        cachedClientDefinition = def;
      },
    },
  };
  await import('../client.js');
  return cachedClientDefinition;
}

/**
 * 载入 `client.js` 并取出模块与 `__internals`。
 *
 * @returns {Promise<{ clientModule: object, internals: object }>} 模块与 `__internals`。
 */
async function loadClientModule() {
  const definition = await clientDefinition();
  const require = (name) => {
    if (name === 'react') return reactStub();
    throw new Error(`unexpected require: ${name}`);
  };
  const clientModule = definition.factory(require);
  return { clientModule, internals: clientModule.__internals };
}

/**
 * 造一个行为跟 Cordis 一致的严格上下文，专供客户端半边挂载。
 *
 * @param {Array<object>} seats - 收集 `slots.inject` 出来的座位。
 * @returns {{ ctx: object, dispose: () => void }} 上下文与卸载。
 */
function makeClientCtx(seats) {
  const disposers = [];
  /** 注册进来的文案表：`bind()` 要能翻出真中文，否则断言只能看到键名。 */
  const locales = new Map();
  const services = {
    slots: {
      inject(name, factory) {
        // 框架会消费 `function*` 形式（设置卡片就是这么注册的），这里照做。
        const produced = factory();
        const entry = produced && typeof produced.next === 'function' ? produced.next().value : produced;
        seats.push({ name, entry });
        return () => {};
      },
      register(options, component) {
        return { options, component };
      },
    },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab: () => {} },
    locale: {
      register: (namespace, copy) => {
        locales.set(namespace, copy);
      },
      bind: (namespace) => (key) => locales.get(namespace)?.zh?.[key] ?? key,
    },
    configForms: {
      get: () => ({
        getSnapshot: () => ({ status: 'ready', value: {}, writable: true, revision: 1, mode: 'host' }),
        subscribe: () => () => {},
        set: async () => {},
        mutate: async () => {},
      }),
      whileServed: (_namespaces, register) => register(new Set(['workspace-browser'])),
    },
  };
  const methods = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const produced = fn();
      const wrapped = typeof produced === 'function' ? produced : () => {};
      disposers.push(wrapped);
      return wrapped;
    },
    inject(_deps, callback) {
      callback(ctx);
      return () => {};
    },
    get: (name) => services[name],
    provide() {},
    set() {},
    on() {
      return () => {};
    },
  };
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        const key = String(prop);
        if (key in services) return services[key];
        if (key in methods) return methods[key];
        throw new Error(`cannot get property "${key}" without inject`);
      },
    },
  );
  return {
    ctx,
    dispose() {
      for (const disposer of disposers.splice(0)) {
        try {
          disposer();
        } catch {
          /* 卸载失败不影响断言 */
        }
      }
    },
  };
}

test('客户端中枢：可见才连接、按角色分两路订阅、收帧回 ack、不可见就断开', async (t) => {
  const { internals } = await loadClientModule();
  const sockets = fakeWebSocket();
  const previousWindow = globalThis.window;
  const previousWebSocket = globalThis.WebSocket;
  const previousFetch = globalThis.fetch;
  globalThis.window = { ...previousWindow, location: { protocol: 'http:', host: '127.0.0.1:56615' } };
  globalThis.WebSocket = sockets.ctor;
  // 兜底轮询会去拉 /targets：给它一个空列表，别真的发请求。
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ state: 'running', targets: [] }) });

  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.WebSocket = previousWebSocket;
    globalThis.fetch = previousFetch;
  });

  const store = fakeStatusStore({ streamFocusFps: 2, streamFocusMaxWidth: 960, streamFocusQuality: 70, streamThumbFps: 0.25, streamThumbMaxWidth: 160, streamThumbQuality: 50 });
  const hub = internals.createMirrorHub({ store });
  t.after(() => hub.dispose());

  const snapshots = [];
  hub.subscribe(() => snapshots.push(hub.getSnapshot()));

  // 没人看着：不连接。
  assert.equal(sockets.instances.length, 0, '不可见时不该连接');

  hub.addVisible();
  assert.equal(sockets.instances.length, 1, '可见了才连');
  const socket = sockets.instances[0];
  assert.equal(socket.url, `ws://127.0.0.1:56615${internals.STREAM_PATH}`);

  socket.open();
  socket.deliver({
    t: 'targets',
    selectedTargetId: '',
    capture: { state: 'running', reason: '', viewers: 1 },
    targets: [
      { targetId: 'TAB-1', url: 'https://example.com/login', title: '登录', attached: true, capturing: true, frontmost: true, frontmostInferred: false },
      { targetId: 'TAB-2', url: 'https://example.com/docs', title: '文档', attached: false, capturing: false, frontmost: false, frontmostInferred: false },
    ],
  });

  const subscribes = socket.sent.filter((message) => message.t === 'subscribe');
  assert.equal(subscribes.length, 2, '焦点一路、缩略图一路');
  const focus = subscribes.find((message) => message.role === 'focus');
  const thumb = subscribes.find((message) => message.role === 'thumb');
  assert.deepEqual(focus.targetIds, ['TAB-1']);
  assert.deepEqual(thumb.targetIds, ['TAB-2']);
  assert.equal(focus.fps, 2);
  assert.equal(focus.maxWidth >= 960, true, '高 DPI 只会把宽度放大，不会缩小');
  assert.equal(focus.quality, 70);
  assert.equal(thumb.fps, 0.25);
  assert.equal(socket.sent.some((message) => message.t === 'unsubscribe'), true, '重订前先清空');
  assert.deepEqual(
    hub.getSnapshot().targets.map((target) => target.targetId),
    ['TAB-1', 'TAB-2'],
  );

  // 收帧：只留最新一帧，并且立刻回页面侧 ack。
  socket.deliver({ t: 'frame', targetId: 'TAB-1', seq: 1, ts: 1, mime: 'image/jpeg', dataB64: 'AAA', w: 800, h: 600 });
  socket.deliver({ t: 'frame', targetId: 'TAB-1', seq: 2, ts: 2, mime: 'image/jpeg', dataB64: 'BBB', w: 800, h: 600 });
  assert.equal(hub.getSnapshot().frames['TAB-1'].dataB64, 'BBB', '只保留最新一帧');
  const acks = socket.sent.filter((message) => message.t === 'ack');
  assert.deepEqual(acks.map((message) => message.seq), [1, 2], '每一帧都要 ack');

  // 焦点切换：只改"我在看哪张"，重新订阅一次。
  socket.sent.length = 0;
  hub.setFocusTarget('TAB-2');
  const afterSwitch = socket.sent.filter((message) => message.t === 'subscribe');
  assert.deepEqual(afterSwitch.find((message) => message.role === 'focus').targetIds, ['TAB-2']);

  // 暂停：断开并把最后一帧留着（看起来像"冻结"）。
  hub.setPaused(true);
  assert.equal(hub.getSnapshot().paused, true);
  assert.equal(hub.getSnapshot().frames['TAB-1'].dataB64, 'BBB', '暂停不清画面');
  assert.equal(hub.isConnected(), false, '暂停就不再连着');

  hub.setPaused(false);
  assert.equal(sockets.instances.length, 2, '继续时重开一条连接');

  // 不可见：断开、清画面。
  hub.removeVisible();
  assert.equal(hub.isConnected(), false, '没人看了就断开');
  assert.deepEqual(hub.getSnapshot().frames, {}, '断开时清掉帧缓存');
});

test('客户端正文：三条渲染路径（未启动 / 无标签 / 焦点+胶片条）都不抛错', async (t) => {
  const sockets = fakeWebSocket();
  const { clientModule, internals } = await loadClientModule();
  // `window` 上要同时有 ModuleLoader（模块已加载完）与 location（中枢拼 ws URL 用）。
  const previousWindow = globalThis.window;
  const previousWebSocket = globalThis.WebSocket;
  const previousFetch = globalThis.fetch;
  let statusValue = { state: 'idle', chrome: { state: 'ok' }, settings: {} };
  globalThis.window = { ...previousWindow, location: { protocol: 'http:', host: '127.0.0.1:56615' } };
  globalThis.WebSocket = sockets.ctor;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/status') ? statusValue : { state: statusValue.state, targets: [] }),
  });

  const seats = [];
  const { ctx, dispose } = makeClientCtx(seats);
  t.after(() => {
    dispose();
    globalThis.window = previousWindow;
    globalThis.WebSocket = previousWebSocket;
    globalThis.fetch = previousFetch;
  });

  assert.doesNotThrow(() => clientModule.apply(ctx, {}), '客户端 apply() 不该抛错');
  const pane = seats.find((seat) => seat.name === 'sidebar.right.pane.tab');
  assert.ok(pane, '画面正文要注册在 sidebar.right.pane.tab');
  const injected = pane.entry.options.inject();
  const Body = pane.entry.component;
  const props = { ...injected, useTabInfo: () => ({ sidebar: {}, panel: { id: 'p' }, tab: { visible: true } }) };

  /**
   * 换一份 `/status` 的返回并等它真的进到仓库里。
   *
   * 不能只 `await store.refresh()`：`createStatusStore()` 里有个 `inflight` 闸门，
   * 挂载时的第一次轮询还在飞的话这一次会被直接跳过。
   *
   * @param {object} value - 新的状态。
   * @returns {Promise<void>} 生效时 resolve。
   */
  const applyStatus = async (value) => {
    statusValue = value;
    for (let index = 0; index < 200; index += 1) {
      await injected.store.refresh();
      if (injected.store.get().value?.state === value.state) return;
      await sleep(5);
    }
    throw new Error(`/status 的新状态没生效：${value.state}`);
  };

  // 路径一：未启动 → 一个大按钮。
  await applyStatus({ state: 'idle', chrome: { state: 'ok' }, settings: {} });
  const idleTree = Body(props);
  assert.equal(typeof idleTree, 'object');
  assert.ok(JSON.stringify(idleTree).includes('启动工作区浏览器'), '空态要有启动按钮');

  // 路径二：已启动但没有标签。
  await applyStatus({ state: 'running', port: 1234, chrome: { state: 'ok' }, settings: { panelTileSplit: 0.55, streamFocusFps: 2 } });
  assert.ok(JSON.stringify(Body(props)).includes('还没有可显示的标签'), '无标签时给空态说明');
  assert.ok(JSON.stringify(Body(props)).includes('新建标签页'), '无标签时给「新建标签页」');

  // 路径三：有标签 + 有帧 → 焦点画面 + 胶片条 + 三种标记。
  const hub = internals.mirrorHubFor(injected.store);
  t.after(() => hub.dispose());
  hub.addVisible();
  const socket = sockets.instances[sockets.instances.length - 1];
  socket.open();
  socket.deliver({
    t: 'targets',
    selectedTargetId: 'TAB-1',
    capture: { state: 'running', reason: '', viewers: 1 },
    targets: [
      { targetId: 'TAB-1', url: 'https://github.com/example/repo', title: '登录', attached: true, capturing: true, frontmost: true, frontmostInferred: true },
      { targetId: 'TAB-2', url: 'https://example.com/docs', title: '文档', attached: false, capturing: false, frontmost: false, frontmostInferred: false },
    ],
  });
  socket.deliver({ t: 'frame', targetId: 'TAB-1', seq: 1, ts: 1, mime: 'image/jpeg', dataB64: 'AAA', w: 800, h: 600 });

  const tree = Body(props);
  const flat = JSON.stringify(tree);
  assert.ok(flat.includes('data:image/jpeg;base64,AAA'), '焦点区应该显示主画面那一帧');
  assert.ok(flat.includes('登录') && flat.includes('文档'), '胶片条要有每一张标签');
  assert.ok(flat.includes('显示浏览器窗口'), '焦点区要有「显示浏览器窗口」');
  assert.ok(flat.includes('github.com'), '焦点区标题取 host');
  assert.ok(flat.includes('推断'), '最顶层是推断时 tooltip 要写明「推断」');
  assert.ok(flat.includes('object-fit') === false && flat.includes('contain'), '等比缩放走 objectFit: contain');
  assert.ok(flat.includes('row-resize'), '焦点区与胶片条之间有可拖的分隔条');
  hub.removeVisible();
});

// ── 6. 画面用的两条 HTTP 支撑路由（分隔条持久化 / 悬停菜单的动作） ────────────

/**
 * 假的 req/res：够跑通 `createControlRoute` 的分发与 JSON 请求体解析。
 *
 * @param {string} method - HTTP 方法。
 * @param {string} url - 路径。
 * @param {string} [bodyText] - 请求体文本。
 * @returns {object} 交换对象。
 */
function fakeExchange(method, url, bodyText) {
  const state = { statusCode: 0, headers: {}, chunks: [] };
  const listeners = new Map();
  const on = (event, handler) => {
    const list = listeners.get(event) ?? [];
    list.push(handler);
    listeners.set(event, list);
    return req;
  };
  const req = { method, url, on, destroy() {} };
  const res = {
    writeHead(status, headers) {
      state.statusCode = status;
      Object.assign(state.headers, headers ?? {});
    },
    end(body) {
      state.chunks.push(typeof body === 'string' ? body : '');
    },
  };
  // `readJsonBody` 先挂监听再等数据，所以这里异步喂。
  setImmediate(() => {
    if (bodyText !== undefined) {
      for (const handler of listeners.get('data') ?? []) handler(Buffer.from(bodyText, 'utf8'));
    }
    for (const handler of listeners.get('end') ?? []) handler();
  });
  return {
    req,
    res,
    get statusCode() {
      return state.statusCode;
    },
    body: () => state.chunks.join(''),
  };
}

test('POST /prefs：白名单 + 校验，不合法一律 400 且不写设置', async () => {
  const { createControlRoute } = await import('../lib/routes.js');
  const written = [];
  const route = createControlRoute({
    instance: { status: () => ({ state: 'idle' }), probeEndpoint: async () => ({ reachable: false, port: 0, pages: [] }) },
    readSettings: () => ({ panelTileSplit: 0.55 }),
    writeSetting: async (key, value) => {
      written.push([key, value]);
      return true;
    },
    requestPanelOpen: () => {},
    warn: () => {},
  });

  const ok = fakeExchange('POST', '/dsh-helper-plugin-workspace-browser/prefs', JSON.stringify({ panelTileSplit: 0.7 }));
  await route.handler(ok.req, ok.res);
  assert.equal(ok.statusCode, 200, ok.body());
  assert.deepEqual(written, [['panelTileSplit', 0.7]], '拖分隔条要真的写回设置');
  assert.equal(JSON.parse(ok.body()).settings.panelTileSplit, 0.55, '回一份最新设置');

  written.length = 0;
  const outOfRange = fakeExchange('POST', '/dsh-helper-plugin-workspace-browser/prefs', JSON.stringify({ panelTileSplit: 5 }));
  await route.handler(outOfRange.req, outOfRange.res);
  assert.equal(outOfRange.statusCode, 400, '越界的值必须在写之前挡住（否则 /status 会读设置时抛错）');
  assert.equal(written.length, 0);

  const denied = fakeExchange('POST', '/dsh-helper-plugin-workspace-browser/prefs', JSON.stringify({ chromePath: 'x' }));
  await route.handler(denied.req, denied.res);
  assert.equal(denied.statusCode, 400, '白名单之外不能改');

  const empty = fakeExchange('POST', '/dsh-helper-plugin-workspace-browser/prefs', '{}');
  await route.handler(empty.req, empty.res);
  assert.equal(empty.statusCode, 400, '一个键都不给也算坏请求');
});

test('POST /tab-action：动作与 targetId 都要校验，实例没起来给 409', async () => {
  const { createControlRoute } = await import('../lib/routes.js');
  const route = createControlRoute({
    instance: { status: () => ({ state: 'idle' }), probeEndpoint: async () => ({ reachable: false, port: 0, pages: [] }) },
    readSettings: () => ({}),
    writeSetting: async () => true,
    requestPanelOpen: () => {},
    warn: () => {},
  });
  const call = async (body) => {
    const exchange = fakeExchange('POST', '/dsh-helper-plugin-workspace-browser/tab-action', JSON.stringify(body));
    await route.handler(exchange.req, exchange.res);
    return exchange;
  };

  const badAction = await call({ action: 'nope' });
  assert.equal(badAction.statusCode, 400, '只认 bring-to-front / close / open / assign-to-model');
  const noTarget = await call({ action: 'close' });
  assert.equal(noTarget.statusCode, 400, 'close 必须给 targetId');
  const notRunning = await call({ action: 'bring-to-front', targetId: 'TAB-1' });
  assert.equal(notRunning.statusCode, 409, '实例没起来时不能假装成功');
  assert.equal(JSON.parse(notRunning.body()).error, 'browser-not-running');
  // `open` 不需要 targetId，但没有 ensure 时同样受"实例没起来"的限制。
  const openIdle = await call({ action: 'open', url: 'https://example.com' });
  assert.equal(openIdle.statusCode, 409);
});

test('POST /tab-action open：实例 idle 时先 ensure 再开，避免空态 409', async () => {
  const { createControlRoute } = await import('../lib/routes.js');
  const { startFakeChrome } = await import('./helpers/fake-chrome.mjs');
  const fake = await startFakeChrome();
  const ensured = [];
  try {
    const route = createControlRoute({
      instance: {
        status: () => ({ state: ensured.length > 0 ? 'running' : 'idle' }),
        ensure: async () => {
          ensured.push(true);
          return { state: 'running' };
        },
        probeEndpoint: async () => ({
          reachable: true,
          port: fake.port,
          pages: [{ id: 'TAB-1', type: 'page', url: 'https://example.com', title: 'Example' }],
        }),
      },
      readSettings: () => ({}),
      writeSetting: async () => true,
      requestPanelOpen: () => {},
      warn: () => {},
    });
    const exchange = fakeExchange(
      'POST',
      '/dsh-helper-plugin-workspace-browser/tab-action',
      JSON.stringify({ action: 'open', url: 'about:blank' }),
    );
    await route.handler(exchange.req, exchange.res);
    assert.equal(exchange.statusCode, 200, exchange.body());
    assert.equal(ensured.length, 1, 'idle 时 open 必须先 ensure');
    assert.equal(JSON.parse(exchange.body()).ok, true);
  } finally {
    await fake.close();
  }
});

test('POST /tab-action assign-to-model：只切默认 target，不提交对话', async () => {
  const { createControlRoute } = await import('../lib/routes.js');
  const selected = [];
  const route = createControlRoute({
    instance: {
      status: () => ({ state: 'running' }),
      probeEndpoint: async () => ({ reachable: true, port: 1, pages: [] }),
    },
    readSettings: () => ({}),
    writeSetting: async () => true,
    requestPanelOpen: () => {},
    getCdpClient: () => ({
      connect: async () => {},
      selectTarget: (id) => selected.push(id),
    }),
    warn: () => {},
  });
  const exchange = fakeExchange(
    'POST',
    '/dsh-helper-plugin-workspace-browser/tab-action',
    JSON.stringify({
      action: 'assign-to-model',
      targetId: 'TAB-7',
    }),
  );
  await route.handler(exchange.req, exchange.res);
  assert.equal(exchange.statusCode, 200, exchange.body());
  assert.deepEqual(selected, ['TAB-7']);
  assert.equal(JSON.parse(exchange.body()).ok, true);
});
