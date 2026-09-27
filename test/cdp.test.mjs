/**
 * CDP 客户端测试：帧编解码 + 对手写 WebSocket 的端到端验证。
 *
 * 跑法：`node test/cdp.test.mjs`（**逐个直接跑**；`node --test <目录>` 会 spawn
 * 子进程并用管道抓输出，受限沙箱里会 EPERM）。
 *
 * 真实 Chrome 在这里跑不起来（也不该由单元测试去起浏览器），所以「客户端 ↔ 服务端」
 * 的另一半由 `test/helpers/fake-chrome.mjs` 扮演。它用同一个编解码器反向实现服务端，
 * 因此这里验证的是真实握手、真实掩码、真实分片，而不是替身逻辑。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CdpError,
  createCdpClient,
  encodeFrame,
  FrameDecoder,
  OPCODES,
  parseFrame,
  WebSocketClient,
} from '../lib/cdp.js';
import { startFakeChrome } from './helpers/fake-chrome.mjs';

/** 睡眠。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ── 帧编解码（纯逻辑） ──────────────────────────────────────────────────────

test('帧编码：客户端帧带掩码，解回来载荷一致', () => {
  const key = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const frame = encodeFrame('你好, CDP', { maskKey: key });

  assert.equal(frame[0], 0x81, '第一字节应是 FIN + 文本帧');
  assert.equal(frame[1] & 0x80, 0x80, '客户端发出的帧必须带掩码位');
  assert.equal(frame[1] & 0x7f, Buffer.byteLength('你好, CDP', 'utf8'), '短载荷用 7 位长度');
  assert.deepEqual([...frame.subarray(2, 6)], [...key], '掩码键应紧跟帧头');

  const parsed = parseFrame(frame);
  assert.ok(parsed, '应能解析出整帧');
  assert.equal(parsed.fin, true);
  assert.equal(parsed.opcode, OPCODES.text);
  assert.equal(parsed.masked, true);
  assert.equal(parsed.payload.toString('utf8'), '你好, CDP');
  assert.equal(parsed.rest.length, 0);
});

test('帧编码：16 位与 64 位长度都能往返', () => {
  const medium = Buffer.alloc(200, 0x61);
  const mediumFrame = encodeFrame(medium, { opcode: OPCODES.binary, maskKey: Buffer.alloc(4, 7) });
  assert.equal(mediumFrame[1] & 0x7f, 126, '200 字节要走 16 位长度');
  assert.equal(mediumFrame.readUInt16BE(2), 200);
  const mediumParsed = parseFrame(mediumFrame);
  assert.equal(mediumParsed.payload.length, 200);
  assert.ok(mediumParsed.payload.equals(medium), '16 位长度的载荷要逐字节一致');

  const large = Buffer.alloc(70000, 0x62);
  const largeFrame = encodeFrame(large, { opcode: OPCODES.binary, maskKey: Buffer.alloc(4, 9) });
  assert.equal(largeFrame[1] & 0x7f, 127, '70000 字节要走 64 位长度');
  assert.equal(Number(largeFrame.readBigUInt64BE(2)), 70000);
  const largeParsed = parseFrame(largeFrame);
  assert.equal(largeParsed.payload.length, 70000);
  assert.equal(largeParsed.payload[0], 0x62);
  assert.equal(largeParsed.payload[69999], 0x62);
});

test('帧解析：服务端帧不带掩码；数据不足时返回 null', () => {
  const serverFrame = encodeFrame('{"id":1}', { mask: false });
  assert.equal(serverFrame[1] & 0x80, 0, '服务端帧不该带掩码');
  const parsed = parseFrame(serverFrame);
  assert.equal(parsed.masked, false);
  assert.equal(parsed.payload.toString('utf8'), '{"id":1}');

  assert.equal(parseFrame(Buffer.alloc(1)), null, '只有一个字节时数据不够');
  assert.equal(parseFrame(serverFrame.subarray(0, 5)), null, '载荷不全时数据不够');
  const full = parseFrame(serverFrame);
  assert.equal(full.rest.length, 0);
});

test('解码器：分片拼接，控制帧可以插在分片中间', () => {
  const messages = [];
  const pings = [];
  const pongs = [];
  let closed = null;
  const decoder = new FrameDecoder({
    onText: (text) => messages.push(text),
    onPing: (payload) => pings.push(payload.toString('utf8')),
    onPong: (payload) => pongs.push(payload.toString('utf8')),
    onClose: (code, reason) => {
      closed = { code, reason };
    },
  });

  decoder.push(encodeFrame('he', { opcode: OPCODES.text, fin: false, mask: false }));
  decoder.push(encodeFrame('ping!', { opcode: OPCODES.ping, mask: false }));
  decoder.push(encodeFrame('l', { opcode: OPCODES.continuation, fin: false, mask: false }));
  decoder.push(encodeFrame('lo', { opcode: OPCODES.continuation, fin: true, mask: false }));
  decoder.push(encodeFrame('pong!', { opcode: OPCODES.pong, mask: false }));

  assert.deepEqual(messages, ['hello'], '三个分片要拼成一条消息');
  assert.deepEqual(pings, ['ping!']);
  assert.deepEqual(pongs, ['pong!']);

  const closeBody = Buffer.alloc(2 + Buffer.byteLength('bye', 'utf8'));
  closeBody.writeUInt16BE(1000, 0);
  closeBody.write('bye', 2, 'utf8');
  decoder.push(encodeFrame(closeBody, { opcode: OPCODES.close, mask: false }));
  assert.deepEqual(closed, { code: 1000, reason: 'bye' });
});

test('解码器：一次喂半帧不会误报，拼齐后才回调', () => {
  const messages = [];
  const decoder = new FrameDecoder({ onText: (text) => messages.push(text) });
  const frame = encodeFrame('分两次到', { mask: false });
  decoder.push(frame.subarray(0, 4));
  assert.deepEqual(messages, [], '半个帧不该触发回调');
  decoder.push(frame.subarray(4));
  assert.deepEqual(messages, ['分两次到']);
});

// ── 客户端 ↔ 假 Chrome ──────────────────────────────────────────────────────

test('客户端：握手、发现 target、attach 拿 sessionId', async (t) => {
  const fake = await startFakeChrome();
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
  });

  await client.connect();
  assert.equal(client.isConnected(), true);
  assert.equal(client.port, fake.port, '端口应记下来');

  // devtools:// 那张不该出现在页面列表里（复用 pageTargets 的过滤）。
  assert.deepEqual(
    client.pages().map((page) => page.targetId),
    ['TAB-1', 'TAB-2'],
  );
  assert.equal(client.selectedTargetId, 'TAB-1', '没选过时用第一张页面');

  const target = await client.resolveTarget('TAB-2');
  assert.equal(target.sessionId, 'S-TAB-2', 'attach 的扁平会话 id 应该来自 Target.attachToTarget');
  await client.command('TAB-2', 'Runtime.evaluate', { expression: '1' });

  const evaluate = fake.state.commands.find((entry) => entry.method === 'Runtime.evaluate');
  assert.equal(evaluate.sessionId, 'S-TAB-2', '附着后的命令必须带 sessionId');
  assert.ok(
    fake.state.commands.some((entry) => entry.method === 'Page.enable'),
    'attach 之后要 Page.enable（Page.frameNavigated 需要它）',
  );
});

test('tabStripPageIds：按窗口里的 tabStripIndex 从左到右排', async (t) => {
  const fake = await startFakeChrome({
    onCommand(message, { emitEvent }) {
      if (message.method === 'Target.getTargets' && Array.isArray(message.params?.filter)) {
        return {
          result: {
            targetInfos: [
              { targetId: 'TAB-B', type: 'tab', embedderData: { tabStripIndex: 1 } },
              { targetId: 'TAB-A', type: 'tab', embedderData: { tabStripIndex: 0 } },
            ],
          },
        };
      }
      if (message.method === 'Target.autoAttachRelated') {
        const pageId = message.params.targetId === 'TAB-A' ? 'PAGE-A' : 'PAGE-B';
        emitEvent('Target.attachedToTarget', {
          sessionId: `S-${pageId}`,
          targetInfo: { targetId: pageId, type: 'page', url: 'https://example.com/', title: pageId },
          waitingForDebugger: false,
        });
        return { result: {} };
      }
      return undefined;
    },
  });
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
  });

  await client.connect();
  assert.deepEqual(await client.tabStripPageIds(), ['PAGE-A', 'PAGE-B']);
});

test('排队：同一 target 严格按到达顺序，不同 target 并行', async (t) => {
  const fake = await startFakeChrome();
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 5000,
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
  });
  await client.connect();

  // 同一个 target：后到的（1ms）必须等先到的（60ms）。
  const same = [];
  const first = client.command('TAB-1', 'Test.slow', { ms: 60 }, {}).then(() => same.push('first'));
  const second = client.command('TAB-1', 'Test.slow', { ms: 1 }, {}).then(() => same.push('second'));
  await Promise.all([first, second]);
  assert.deepEqual(same, ['first', 'second'], '同一 target 的命令必须有序');

  // 不同 target：慢的不会挡住快的。
  const cross = [];
  const slow = client.command('TAB-1', 'Test.slow', { ms: 120 }, {}).then(() => cross.push('slow'));
  const fast = client.command('TAB-2', 'Test.slow', { ms: 10 }, {}).then(() => cross.push('fast'));
  await Promise.all([slow, fast]);
  assert.deepEqual(cross, ['fast', 'slow'], '不同 target 的命令可以并行');
});

test('超时：reject 并带上命令名', async (t) => {
  const fake = await startFakeChrome();
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 80,
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
  });
  await client.connect();

  await assert.rejects(
    client.command('TAB-1', 'Test.never', {}, {}),
    (error) => error instanceof CdpError && error.code === 'cdp-timeout' && error.message.includes('Test.never'),
    '超时错误要带命令名',
  );

  // 超时之后这条 target 的队列还能继续用（超时不该把队列废掉）。
  const result = await client.command('TAB-1', 'Test.slow', { ms: 1 }, {});
  assert.deepEqual(result, { ok: true, method: 'Test.slow' });
});

test('CDP 错误：拒绝并带上方法名与对端消息', async (t) => {
  const fake = await startFakeChrome();
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
  });
  await client.connect();

  await assert.rejects(
    client.command('TAB-1', 'Test.fail', { message: '坏掉了' }, {}),
    (error) => error.code === 'cdp-error' && error.message.includes('Test.fail') && error.message.includes('坏掉了'),
  );
});

test('断线：reject 所有在途请求并触发 closed 回调', async (t) => {
  const fake = await startFakeChrome();
  const closed = [];
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 5000,
    onClosed: (info) => closed.push(info),
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
  });
  await client.connect();

  const pending = client.command('TAB-1', 'Test.never', {}, {});
  await sleep(50); // 等命令真的发出去
  fake.dropConnections();

  await assert.rejects(
    pending,
    (error) => error.code === 'cdp-closed' && error.message.includes('Test.never'),
    '在途请求必须被 reject（不能悬着）',
  );
  await sleep(30);
  assert.equal(closed.length, 1, 'closed 回调只该报一次');
  assert.equal(client.isConnected(), false);
  assert.equal(client.pages().length, 0, '断开后 target 表要清空');

  // 重连入口：再连一次还能用（P1 不做自动重连，但手动这条必须通）。
  await client.reconnect();
  assert.equal(client.isConnected(), true);
});

test('target 事件：创建 / 变更 / 销毁都维护 target 表，Page.frameNavigated 能订阅', async (t) => {
  const fake = await startFakeChrome();
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
  });
  await client.connect();

  const navigations = [];
  client.on('Page.frameNavigated', (params) => navigations.push(params));

  fake.emitEvent('Target.targetCreated', { targetInfo: { targetId: 'TAB-3', type: 'page', url: 'https://new.example', title: '新标签' } });
  await sleep(50);
  assert.ok(
    client.pages().some((page) => page.targetId === 'TAB-3'),
    'targetCreated 之后应能列出新标签',
  );

  fake.emitEvent('Target.targetInfoChanged', {
    targetInfo: { targetId: 'TAB-3', type: 'page', url: 'https://changed.example', title: '改了' },
  });
  await sleep(50);
  assert.equal(client.pages().find((page) => page.targetId === 'TAB-3').url, 'https://changed.example');

  fake.emitEvent('Page.frameNavigated', { frame: { url: 'https://changed.example' } }, 'S-TAB-3');
  await sleep(50);
  assert.equal(navigations.length, 1, 'Page.frameNavigated 应派发给订阅者');
  assert.equal(navigations[0].frame.url, 'https://changed.example');

  fake.emitEvent('Target.targetDestroyed', { targetId: 'TAB-3' });
  await sleep(50);
  assert.ok(
    !client.pages().some((page) => page.targetId === 'TAB-3'),
    'targetDestroyed 之后应从表里移除',
  );
});

test('端到端判据：握手成功但拿不到 target 表就不算连上', async (t) => {
  const fake = await startFakeChrome({
    onCommand: (message) => {
      if (message.method === 'Target.getTargets') return { error: { code: -32000, message: '拿不到标签' } };
      return undefined;
    },
  });
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
  });

  await assert.rejects(
    client.connect(),
    (error) => error.code === 'browser-not-running',
    '「运行中」的判据必须端到端：拿不到 target 表就当没运行',
  );
  assert.equal(client.isConnected(), false);
  assert.equal(client.hasEndpointHint(), true, '有端口线索，只是没连成');
});

test('端点线索：端口已知但 wsPath 缺失时用 /json/version 补上', async (t) => {
  const fake = await startFakeChrome();
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: '' }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
  });

  await client.connect();
  assert.equal(client.isConnected(), true, 'wsPath 缺失时应能从 /json/version 补出来');
  assert.deepEqual(
    client.pages().map((page) => page.targetId),
    ['TAB-1', 'TAB-2'],
  );
});

test('宿主记住的 wsPath 过期时，以 /json/version 的实时路径为准', async (t) => {
  // 真机：Chrome `--remote-debugging-port=0` 重启后 port 可能不变、UUID 路径必变。
  // 若死信宿主里的旧 wsPath，HTTP /json/list 仍有标题，CDP 永远连不上 → 灰点无画面。
  const fake = await startFakeChrome();
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: '/devtools/browser/STALE-UUID-FROM-LAST-BOOT' }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
  });

  await client.connect();
  assert.equal(client.isConnected(), true, '过期 wsPath 不能挡住连接');
  assert.deepEqual(
    client.pages().map((page) => page.targetId),
    ['TAB-1', 'TAB-2'],
  );
});

test('宿主端口优先于另一份目录里过期的 DevToolsActivePort', async (t) => {
  const fake = await startFakeChrome();
  const staleDir = mkdtempSync(join(tmpdir(), 'wb-stale-port-'));
  writeFileSync(join(staleDir, 'DevToolsActivePort'), '1\n/devtools/browser/stale\n');
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: '' }),
    profileDir: staleDir,
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
    rmSync(staleDir, { recursive: true, force: true });
  });

  await client.connect();
  assert.equal(client.isConnected(), true, '过期端口文件不能把连接从宿主正在用的调试口上带走');
  assert.equal(client.port, fake.port);
});

test('getProfileDir 指向的目录才用来读 DevToolsActivePort', async (t) => {
  const fake = await startFakeChrome();
  const wrongDir = mkdtempSync(join(tmpdir(), 'wb-wrong-profile-'));
  const rightDir = mkdtempSync(join(tmpdir(), 'wb-right-profile-'));
  mkdirSync(wrongDir, { recursive: true });
  writeFileSync(join(wrongDir, 'DevToolsActivePort'), '1\n/devtools/browser/stale\n');
  writeFileSync(join(rightDir, 'DevToolsActivePort'), `${fake.port}\n${fake.wsPath}\n`);
  const client = createCdpClient({
    getEndpoint: () => ({ port: 0, wsPath: '' }),
    profileDir: wrongDir,
    getProfileDir: () => rightDir,
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
    rmSync(wrongDir, { recursive: true, force: true });
    rmSync(rightDir, { recursive: true, force: true });
  });

  assert.equal(client.hasEndpointHint(), true);
  await client.connect();
  assert.equal(client.isConnected(), true);
  assert.equal(client.port, fake.port);
});

test('没有端点线索时不假装能连（hasEndpointHint 为 false）', async (t) => {
  const client = createCdpClient({ getEndpoint: () => ({ port: 0, wsPath: '' }), profileDir: '' });
  t.after(() => client.close('test-over'));
  assert.equal(client.hasEndpointHint(), false);
  await assert.rejects(
    client.connect(),
    (error) => error.code === 'browser-not-running',
    '没有线索时要直接报未启动',
  );
});

test('WebSocketClient：非 101 响应与握手超时都要 reject，不留半开连接', async () => {
  const { createServer } = await import('node:http');
  const { createServer: createTcpServer } = await import('node:net');

  // 纯 HTTP 端口冒充调试端口：握手会拿到 404。
  const plain = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));

  // 只接受 TCP 连接、什么都不回的端口：握手只能等到超时。
  const silentSockets = [];
  const silent = createTcpServer((socket) => {
    silentSockets.push(socket);
    socket.on('data', () => {});
    socket.on('error', () => {});
  });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));

  try {
    await assert.rejects(
      WebSocketClient.connect(`ws://127.0.0.1:${plain.address().port}/devtools/browser/x`, { timeoutMs: 1000 }),
      (error) => error.code === 'ws-handshake-failed',
    );
    await assert.rejects(
      WebSocketClient.connect(`ws://127.0.0.1:${silent.address().port}/devtools/browser/x`, { timeoutMs: 60 }),
      (error) => error.code === 'ws-handshake-timeout',
    );
  } finally {
    for (const socket of silentSockets) socket.destroy();
    await new Promise((resolve) => plain.close(() => resolve()));
    await new Promise((resolve) => silent.close(() => resolve()));
  }
});
