/**
 * 画面采集中枢测试（P3 的验收项）。
 *
 * 跑法：`node test/screencast.test.mjs`（**逐个文件直接跑**；`node --test <目录>`
 * 会 spawn 子进程并用管道抓输出，受限沙箱里会 EPERM）。
 *
 * 这里用的是**真 CDP 客户端 + 假 Chrome**（`test/helpers/fake-chrome.mjs`），不是
 * 桩件替身：`Page.startScreencast` / `Page.screencastFrameAck` 都是真命令，帧事件
 * 也走真实的 WebSocket 链路。真实 Chrome 跑不起来（也不该由单元测试去起浏览器）。
 *
 * 覆盖 DESIGN §9 P3 的判据：
 *
 * 1. 帧率限流：给定 fps，单位时间内的帧数不超过预期
 * 2. 可见性计数：A 可见 B 不可见 → 继续推；都不可见 → 停
 * 3. 缩略图上限 12：第 13 张不开采集
 * 4. CDP 立刻 ack（帧到就回，不等页面的 ack）
 * 5. 背压：只留最新一帧，缓冲过高/积压未 ack 时丢帧
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCdpClient } from '../lib/cdp.js';
import { createScreencastHub, DEFAULT_ROLES, frameIntervalMs, MAX_THUMB_TARGETS, normalizeRole } from '../lib/screencast.js';
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
    metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 },
    sessionId: screencastSessionId,
  };
}

/**
 * 造一个投递口（记录收到的消息）。
 *
 * @param {string} id - 连接 id。
 * @param {object} [options] - `{ buffered }` 缓冲字节数。
 * @returns {object} `{ id, messages, sink }`。
 */
function makeSink(id, options = {}) {
  const messages = [];
  const sink = {
    id,
    messages,
    send(message) {
      messages.push(message);
    },
    bufferedBytes: () => options.buffered ?? 0,
  };
  return { id, messages, sink };
}

/**
 * 造一套「假 Chrome + 真 CDP 客户端 + 采集中枢」。
 *
 * @param {object} [options] - `{ targets, now, roles, maxThumbTargets }`。
 * @returns {Promise<object>} `{ fake, client, hub, close }`。
 */
async function makeHub(options = {}) {
  const fake = await startFakeChrome({
    targets: options.targets ?? [page('TAB-1'), page('TAB-2')],
    ...(typeof options.onCommand === 'function' ? { onCommand: options.onCommand } : {}),
    ...(options.screenshotBase64 === undefined ? {} : { screenshotBase64: options.screenshotBase64 }),
  });
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  await client.connect();
  const hub = createScreencastHub({
    getClient: () => client,
    ...(options.roles === undefined ? {} : { roles: options.roles }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxThumbTargets === undefined ? {} : { maxThumbTargets: options.maxThumbTargets }),
    // 节拍拉长：测试里不要它自己跑，需要时手动 emit。
    tickMs: 60000,
    warn: () => {},
    info: () => {},
  });
  return {
    fake,
    client,
    hub,
    async close() {
      await hub.dispose();
      client.close('test-over');
      await fake.close();
    },
  };
}

/** 记录下来的 startScreencast 命令。 */
function starts(fake) {
  return fake.state.commands.filter((entry) => entry.method === 'Page.startScreencast');
}

/** 记录下来的 stopScreencast 命令。 */
function stops(fake) {
  return fake.state.commands.filter((entry) => entry.method === 'Page.stopScreencast');
}

test('新观众订阅时补帧：静态页面不会一直停在「还没有画面」', async () => {
  // 真机症状：画面里有一张标签**永远**显示「这张标签还没有画面」。
  // 原因：Chrome 只在页面视觉变化时推 `Page.screencastFrame`。这一路采集可能早就开着
  // （别人订过、或焦点切走又切回来），不会再发一帧初始画面 —— 于是后订上的观众
  // 即使缓存里明明有帧，也永远等不到。所以订阅时要**立刻补一帧**。
  const { fake, hub, close } = await makeHub();
  try {
    const a = makeSink('cA');
    hub.subscribe('cA', a.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2, visible: true });
    await sleep(20);
    fake.emitEvent('Page.screencastFrame', frameParams(), 'S-TAB-1');
    await sleep(20);
    assert.ok(a.messages.filter((m) => m.t === 'frame').length >= 1, 'A 先拿到一帧，缓存里就有了');

    // B 现在才订上同一张：不该等下一次页面变化，应当立刻收到缓存里那一帧。
    const b = makeSink('cB');
    hub.subscribe('cB', b.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2, visible: true });
    await sleep(30);
    const framesB = b.messages.filter((m) => m.t === 'frame');
    assert.equal(framesB.length, 1, 'B 订上就该拿到缓存那一帧（没有新的 frame 事件也一样）');
    assert.equal(framesB[0].targetId, 'TAB-1');
    assert.ok(framesB[0].dataB64.length > 0);
  } finally {
    await close();
  }
});

test('面板重新可见时补帧：切走再切回来不会停在旧画面', async () => {
  const { fake, hub, close } = await makeHub();
  try {
    const a = makeSink('cA');
    hub.subscribe('cA', a.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2, visible: true });
    await sleep(20);
    fake.emitEvent('Page.screencastFrame', frameParams(), 'S-TAB-1');
    await sleep(20);
    const before = a.messages.filter((m) => m.t === 'frame').length;

    hub.setVisible('cA', false);
    hub.setVisible('cA', true);
    await sleep(30);
    const after = a.messages.filter((m) => m.t === 'frame').length;
    assert.equal(after, before + 1, '重新可见要立刻补一帧，而不是等页面下次变化');
  } finally {
    await close();
  }
});

/** 记录下来的 screencastFrameAck 命令。 */
function acks(fake) {
  return fake.state.commands.filter((entry) => entry.method === 'Page.screencastFrameAck');
}

/** 假 Chrome 里 flat sessionId 与 targetId 的对应（`S-<targetId>`）。 */
function targetOf(entry) {
  const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : '';
  return sessionId.startsWith('S-') ? sessionId.slice(2) : sessionId;
}

// ── 角色参数 ─────────────────────────────────────────────────────────────────

test('角色参数：默认值与 §5 的表格一致，质量被夹到 0–100 的整数', () => {
  assert.deepEqual(normalizeRole('focus', {}), { fps: DEFAULT_ROLES.focus.fps, maxWidth: 960, quality: 70 });
  assert.deepEqual(normalizeRole('thumb', {}), { fps: 0.25, maxWidth: 160, quality: 50 });

  assert.equal(normalizeRole('focus', { quality: 250 }).quality, 100, '质量上限是 100');
  assert.equal(normalizeRole('focus', { quality: -5 }).quality, 0, '质量下限是 0');
  assert.equal(normalizeRole('focus', { quality: 69.7 }).quality, 69, '质量必须是整数');
  assert.equal(normalizeRole('thumb', { fps: 0 }).fps, 0, '缩略图允许 0（= 不要缩略图）');
  assert.equal(normalizeRole('thumb', { fps: 999 }).fps, 30, '帧率上限 30');

  assert.equal(frameIntervalMs(2), 500);
  assert.equal(frameIntervalMs(0.25), 4000);
  assert.equal(frameIntervalMs(0), null, 'fps 0 表示这一路不要画面');
});

// ── 1. 帧率限流 ──────────────────────────────────────────────────────────────

test('帧率限流：2 fps 时两秒内只投出 4 帧（喂 20 帧也一样）', async (t) => {
  let clock = 0;
  const { fake, hub, close } = await makeHub({ targets: [page('TAB-1')], now: () => clock });
  t.after(close);

  const viewer = makeSink('c1');
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2, maxWidth: 320, quality: 50 });
  await hub.whenIdle();
  assert.equal(starts(fake).length, 1, '订阅之后应开一路采集');
  // 截图兜底可能先投一帧；限流测的是之后的 screencast 帧。
  viewer.messages.length = 0;

  // 20 帧、每帧间隔 100ms（共 2 秒）= 页面在狂推帧。
  for (let index = 0; index < 20; index += 1) {
    clock += 100;
    fake.emitEvent('Page.screencastFrame', frameParams(), 'S-TAB-1');
    await sleep(5);
  }

  const frames = viewer.messages.filter((message) => message.t === 'frame');
  assert.equal(frames.length, 4, `2 fps × 2 秒最多 4 帧，实际 ${frames.length}`);
  for (let index = 1; index < frames.length; index += 1) {
    assert.ok(frames[index].ts - frames[index - 1].ts >= 500, '相邻两帧的间隔不得小于 1000/fps');
  }
  assert.equal(frames[0].mime, 'image/jpeg');
  assert.equal(frames[0].w, 800, '宽高来自 metadata 的原始视口');
  assert.equal(frames[0].h, 600);
  assert.equal(typeof frames[0].seq, 'number');
});

test('启动瞬间的首帧不能丢（静态页只推一帧）', async (t) => {
  // 真机：百度等已加载页在 Page.startScreencast 的 await 还没回来时就推来唯一一帧；
  // 若那时还要求 capturing===true，帧被 ack 掉却丢掉 → 永远「正在等第一帧…」。
  const { fake, hub, close } = await makeHub({
    targets: [page('TAB-1')],
    onCommand: async (message, ctx) => {
      if (message.method !== 'Page.startScreencast') return undefined;
      ctx.emitEvent('Page.screencastFrame', frameParams(9, 'first-static'), 'S-TAB-1');
      await ctx.sleep(20);
      return { result: {} };
    },
  });
  t.after(close);

  const viewer = makeSink('c1');
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2 });
  await hub.whenIdle();
  await sleep(40);

  const frames = viewer.messages.filter((message) => message.t === 'frame');
  assert.ok(frames.length >= 1, `启动瞬间那一帧必须投到观众，实际 ${frames.length}`);
  assert.ok(frames[0].dataB64.length > 0);
  assert.ok(acks(fake).length >= 1, '仍要立刻 ack，免得 Chrome 停推');
});

test('收到帧立刻回 Page.screencastFrameAck（用采集会话 id，不等页面的 ack）', async (t) => {
  const { fake, hub, close } = await makeHub({ targets: [page('TAB-1')] });
  t.after(close);

  const viewer = makeSink('c1');
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 10 });
  await hub.whenIdle();

  fake.emitEvent('Page.screencastFrame', frameParams(42), 'S-TAB-1');
  await sleep(30);

  const list = acks(fake);
  assert.equal(list.length, 1, '一帧对应一条 ack');
  assert.equal(list[0].params.sessionId, 42, 'ack 里带的必须是 params.sessionId（采集会话），不是扁平会话');
  assert.equal(list[0].sessionId, 'S-TAB-1', '命令本身打在 target 的扁平会话上');
});

// ── 2. 可见性计数 ────────────────────────────────────────────────────────────

test('可见性计数：A 可见 B 不可见 → 继续推；都不可见 → 停采集', async (t) => {
  const { fake, hub, close } = await makeHub({ targets: [page('TAB-1')] });
  t.after(close);

  const a = makeSink('cA');
  const b = makeSink('cB');
  hub.subscribe('cA', a.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 30 });
  hub.subscribe('cB', b.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 30 });
  await hub.whenIdle();
  assert.equal(starts(fake).length, 1, '两个会话看同一张：Chrome 上只开一路采集');

  // B 的右侧栏收起了。
  hub.setVisible('cB', false);
  await hub.whenIdle();
  assert.equal(stops(fake).length, 0, 'A 还看得见，采集不能停');

  // 等过帧率间隔（截图兜底刚投过一帧），再喂 screencast。
  await sleep(50);

  const framesOf = (sink) => sink.messages.filter((message) => message.t === 'frame').length;
  const aBefore = framesOf(a);
  const bBefore = framesOf(b);

  fake.emitEvent('Page.screencastFrame', frameParams(), 'S-TAB-1');
  await sleep(30);
  assert.equal(framesOf(a), aBefore + 1, '可见的 A 应该收到帧');
  assert.equal(framesOf(b), bBefore, '不可见的 B 不该收到帧');

  // A 也收起了：全部不可见 → 停。
  hub.setVisible('cA', false);
  await hub.whenIdle();
  assert.equal(stops(fake).length, 1, '都不可见才停采集');
  assert.equal(hub.captureState().state, 'idle');
  assert.equal(hub.captureState().reason, 'no-viewers');

  // 再打开 A：重新开采集。
  hub.setVisible('cA', true);
  await hub.whenIdle();
  assert.equal(starts(fake).length, 2, '重新可见要重新开采集');
});

test('连接断开只影响它自己：detach 之后别人照收', async (t) => {
  const { fake, hub, close } = await makeHub({ targets: [page('TAB-1')] });
  t.after(close);

  const a = makeSink('cA');
  const b = makeSink('cB');
  hub.subscribe('cA', a.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 10 });
  hub.subscribe('cB', b.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 10 });
  await hub.whenIdle();
  hub.detach('cB');
  await hub.whenIdle();

  fake.emitEvent('Page.screencastFrame', frameParams(), 'S-TAB-1');
  await sleep(30);
  assert.equal(a.messages.filter((message) => message.t === 'frame').length, 1);
  assert.equal(stops(fake).length, 0, '还有一个人在看的');
});

// ── 3. 缩略图上限 12 ─────────────────────────────────────────────────────────

test(`缩略图上限 ${MAX_THUMB_TARGETS}：第 ${MAX_THUMB_TARGETS + 1} 张不开采集`, async (t) => {
  const targets = Array.from({ length: MAX_THUMB_TARGETS + 1 }, (_unused, index) => page(`TAB-${index + 1}`, index + 1));
  const { fake, hub, close } = await makeHub({ targets });
  t.after(close);

  const viewer = makeSink('c1');
  hub.subscribe('c1', viewer.sink, {
    targetIds: targets.map((target) => target.targetId),
    role: 'thumb',
    fps: 0.25,
    maxWidth: 160,
    quality: 50,
  });
  await hub.whenIdle();

  const started = starts(fake);
  assert.equal(started.length, MAX_THUMB_TARGETS, `只给 ${MAX_THUMB_TARGETS} 张开采集`);
  const startedIds = started.map(targetOf);
  assert.ok(!startedIds.includes('TAB-1'), '最不活跃的那张（TAB-1）不开采集');
  assert.ok(startedIds.includes('TAB-13'), '最近活跃的那张开采集');

  // 第 13 张变成"最近活跃"：它开采集，最不活跃的那张让位。
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-1'], role: 'thumb', fps: 0.25, maxWidth: 160, quality: 50 });
  await hub.whenIdle();

  const nowStarted = starts(fake).map(targetOf);
  assert.ok(nowStarted.includes('TAB-1'), '刚刚活跃过的 TAB-1 应该拿到画面');
  const stopped = stops(fake).map(targetOf);
  assert.ok(stopped.includes('TAB-2'), '被挤出前 12 的 TAB-2 应该停掉采集');
  assert.equal(starts(fake).length, MAX_THUMB_TARGETS + 1, '总共只多开了这一路');
});

test('同一张同时被焦点与缩略图订阅：只开一路，参数取较高者', async (t) => {
  const { fake, hub, close } = await makeHub({ targets: [page('TAB-1')] });
  t.after(close);

  const focus = makeSink('cFocus');
  const thumb = makeSink('cThumb');
  hub.subscribe('cFocus', focus.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2, maxWidth: 960, quality: 70 });
  hub.subscribe('cThumb', thumb.sink, { targetIds: ['TAB-1'], role: 'thumb', fps: 0.25, maxWidth: 160, quality: 50 });
  await hub.whenIdle();

  const list = starts(fake);
  assert.equal(list.length, 1, '一个 target 只能有一路采集');
  assert.equal(list[0].params.maxWidth, 960, '参数取订阅者里最高的那份');
  assert.equal(list[0].params.quality, 70);
  assert.equal(list[0].params.format, 'jpeg');

  // 焦点会话换到更宽的要求 → 重启采集。
  hub.subscribe('cFocus', focus.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2, maxWidth: 1280, quality: 80 });
  await hub.whenIdle();
  assert.equal(stops(fake).length, 1, '参数变了要重启这一路');
  assert.equal(starts(fake).length, 2);
  assert.equal(starts(fake)[1].params.maxWidth, 1280);
});

// ── 4. 背压与"只保留最新一帧" ────────────────────────────────────────────────

test('背压：socket 缓冲过高时丢帧，缓冲恢复后继续', async (t) => {
  let clock = 0;
  const { fake, hub, close } = await makeHub({ targets: [page('TAB-1')], now: () => clock, roles: { focus: { fps: 10 } } });
  t.after(close);

  const viewer = makeSink('c1', { buffered: 4 * 1024 * 1024 });
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 10 });
  await hub.whenIdle();

  for (let index = 0; index < 5; index += 1) {
    clock += 200;
    fake.emitEvent('Page.screencastFrame', frameParams(), 'S-TAB-1');
    await sleep(5);
  }
  assert.equal(viewer.messages.filter((message) => message.t === 'frame').length, 0, '缓冲堵了就不投帧');

  viewer.sink.bufferedBytes = () => 0;
  clock += 200;
  fake.emitEvent('Page.screencastFrame', frameParams(), 'S-TAB-1');
  await sleep(30);
  assert.equal(viewer.messages.filter((message) => message.t === 'frame').length, 1, '缓冲恢复后投的是最新那一帧');
});

test('背压：页面不 ack 就积压丢帧，ack 之后恢复（丢的永远是旧帧）', async (t) => {
  let clock = 0;
  const { fake, hub, close } = await makeHub({ targets: [page('TAB-1')], now: () => clock });
  t.after(close);

  const viewer = makeSink('c1');
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 10 });
  await hub.whenIdle();

  for (let index = 0; index < 10; index += 1) {
    clock += 200;
    fake.emitEvent('Page.screencastFrame', frameParams(), 'S-TAB-1');
    await sleep(5);
  }
  const frames = viewer.messages.filter((message) => message.t === 'frame');
  assert.equal(frames.length, 6, `允许积压 6 条未 ack 的帧，多的丢掉（实际 ${frames.length}）`);

  // 页面 ack 掉最后一帧 → 又能收一帧。
  hub.ack('c1', 'TAB-1', frames[frames.length - 1].seq);
  clock += 200;
  fake.emitEvent('Page.screencastFrame', frameParams(), 'S-TAB-1');
  await sleep(30);
  const after = viewer.messages.filter((message) => message.t === 'frame');
  assert.equal(after.length, 7, 'ack 之后恢复投递');
  assert.ok(after[after.length - 1].seq > frames[frames.length - 1].seq, '投的必须是更新的那一帧');
});

// ── 5. 杂项 ──────────────────────────────────────────────────────────────────

test('浏览器没起来时不开采集、报 unavailable；起来后自己接上', async (t) => {
  const fake = await startFakeChrome({ targets: [page('TAB-1')] });
  // 先指向一个连不上的端点（模拟"浏览器还没启动"），再切成真的假 Chrome。
  let endpoint = { port: 1, wsPath: '/devtools/browser/nope' };
  const client = createCdpClient({
    getEndpoint: () => endpoint,
    connectTimeoutMs: 200,
    commandTimeoutMs: 2000,
  });
  const hub = createScreencastHub({ getClient: () => client, tickMs: 60000, warn: () => {}, info: () => {} });
  t.after(async () => {
    await hub.dispose();
    client.close('test-over');
    await fake.close();
  });

  const viewer = makeSink('c1');
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2 });
  await hub.whenIdle();
  assert.equal(starts(fake).length, 0, '连不上就不该开采集');
  assert.equal(hub.captureState().state, 'unavailable');
  assert.equal(hub.captureState().reason, 'browser-not-running');

  // 浏览器起来了：下一次协调（这里用再订阅一次触发）应该自己连上并开采集。
  endpoint = { port: fake.port, wsPath: fake.wsPath };
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2 });
  await hub.whenIdle();
  assert.equal(client.isConnected(), true, '中枢会自己连一次（connect 是幂等的）');
  assert.equal(starts(fake).length, 1);
  assert.equal(hub.captureState().state, 'running');
  assert.equal(hub.captureState().viewers, 1, '可见观众计数只算看得见的');
});

test('标签列表：接管过的绿点，采集中的标 capturing', async (t) => {
  const { fake, hub, close } = await makeHub({ targets: [page('TAB-1'), page('TAB-2')] });
  t.after(close);

  const viewer = makeSink('c1');
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2 });
  await hub.whenIdle();

  const snapshot = hub.targetsSnapshot();
  const first = snapshot.find((target) => target.targetId === 'TAB-1');
  const second = snapshot.find((target) => target.targetId === 'TAB-2');
  assert.equal(first.attached, true, '开过采集的就是"已接管"');
  assert.equal(first.capturing, true);
  assert.equal(second.attached, false, '没碰过的标签是灰点');
  assert.equal(second.capturing, false);
  assert.equal(second.frontmost, false);
  assert.equal(fake.state.commands.some((entry) => entry.method === 'Runtime.evaluate'), false, '没有节拍就不问最顶层');
});

test('最顶层标签：问 document.visibilityState；全 hidden 时沿用上一次并标「推断」', async (t) => {
  let visibility = 'visible';
  const fake = await startFakeChrome({
    targets: [page('TAB-1')],
    // 用命令钩子把页面侧的返回值握在测试手里。
    onCommand: (message) => {
      if (message.method === 'Runtime.evaluate') {
        return { result: { result: { type: 'string', value: visibility } } };
      }
      return undefined;
    },
  });
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  await client.connect();
  const hub = createScreencastHub({ getClient: () => client, tickMs: 100, warn: () => {}, info: () => {} });
  t.after(async () => {
    await hub.dispose();
    client.close('test-over');
    await fake.close();
  });

  const viewer = makeSink('c1');
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2 });
  await hub.whenIdle();
  await sleep(250);

  const visible = hub.targetsSnapshot().find((target) => target.targetId === 'TAB-1');
  assert.equal(visible.frontmost, true, 'visibilityState === visible 就是最顶层');
  assert.equal(visible.frontmostInferred, false, '这是实测结果，不是推断');

  // 窗口最小化：全部 hidden → 沿用最后一次结果，但标明是推断（DESIGN §10 的待实测项）。
  visibility = 'hidden';
  await sleep(250);
  const hidden = hub.targetsSnapshot().find((target) => target.targetId === 'TAB-1');
  assert.equal(hidden.frontmost, true, '全部 hidden 时沿用上一次结果');
  assert.equal(hidden.frontmostInferred, true, '要能告诉界面这是推断');

  // 又看得见了 → 回到实测结果。
  visibility = 'visible';
  await sleep(250);
  const again = hub.targetsSnapshot().find((target) => target.targetId === 'TAB-1');
  assert.equal(again.frontmostInferred, false);
});

test('焦点订阅不接收缩略图档低清帧（避免主画面先糊一下）', async (t) => {
  const { fake, hub, close } = await makeHub({ targets: [page('TAB-1')] });
  t.after(close);

  // 先按缩略图开采集（maxWidth 160）。
  const thumb = makeSink('cThumb');
  hub.subscribe('cThumb', thumb.sink, { targetIds: ['TAB-1'], role: 'thumb', fps: 1, maxWidth: 160, quality: 50 });
  await hub.whenIdle();
  fake.emitEvent('Page.screencastFrame', frameParams(1, 'thumb-jpeg'), 'S-TAB-1');
  await sleep(30);
  assert.ok(thumb.messages.some((message) => message.t === 'frame'), '缩略图观众应收到低清帧');

  // 再订焦点：旧低清缓存不得塞进主画面。
  const focus = makeSink('cFocus');
  hub.subscribe('cFocus', focus.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 30, maxWidth: 960, quality: 70 });
  await hub.whenIdle();
  await sleep(40);
  const early = focus.messages.filter((message) => message.t === 'frame');
  assert.equal(
    early.filter((message) => message.dataB64 === Buffer.from('thumb-jpeg', 'utf8').toString('base64')).length,
    0,
    '焦点观众不应收到缩略图档那一帧',
  );

  // 焦点档重启后推来的帧可以收（等过帧率间隔）。
  await sleep(50);
  focus.messages.length = 0;
  fake.emitEvent('Page.screencastFrame', frameParams(2, 'focus-jpeg'), 'S-TAB-1');
  await sleep(40);
  const later = focus.messages.filter((message) => message.t === 'frame');
  assert.ok(
    later.some((message) => message.dataB64 === Buffer.from('focus-jpeg', 'utf8').toString('base64')),
    '焦点档新帧应投递',
  );
});

test('静态页无 screencast 帧时用 Page.captureScreenshot 顶首帧', async (t) => {
  const { fake, hub, close } = await makeHub({
    targets: [page('TAB-1')],
    screenshotBase64: 'iVBORw0KGgo=',
  });
  t.after(close);

  const viewer = makeSink('c1');
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2 });
  await hub.whenIdle();
  await sleep(40);

  const frames = viewer.messages.filter((message) => message.t === 'frame');
  assert.ok(frames.length >= 1, `截图兜底必须给出首帧，实际 ${frames.length}`);
  assert.equal(frames[0].dataB64, 'iVBORw0KGgo=');
  assert.ok(
    fake.state.commands.some((entry) => entry.method === 'Page.captureScreenshot'),
    '应调用 Page.captureScreenshot',
  );
  const snap = hub.targetsSnapshot().find((target) => target.targetId === 'TAB-1');
  assert.equal(snap?.attached, true, '截图成功后也应标已接管');
});

test('getClient 换实例后要跟新客户端，不能卡在已关闭的旧连接', async (t) => {
  const first = await startFakeChrome({ targets: [page('TAB-1', 1)] });
  const second = await startFakeChrome({ targets: [page('TAB-2', 2)] });
  let useSecond = false;
  const clientA = createCdpClient({
    getEndpoint: () => ({ port: first.port, wsPath: first.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  const clientB = createCdpClient({
    getEndpoint: () => ({ port: second.port, wsPath: second.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  const hub = createScreencastHub({
    getClient: () => (useSecond ? clientB : clientA),
    tickMs: 60000,
    warn: () => {},
    info: () => {},
  });
  t.after(async () => {
    await hub.dispose();
    clientA.close('test-over');
    clientB.close('test-over');
    await first.close();
    await second.close();
  });

  const viewer = makeSink('c1');
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-1'], role: 'focus', fps: 2 });
  await hub.whenIdle();
  assert.ok(
    first.state.commands.some((entry) => entry.method === 'Page.startScreencast'),
    '先对第一个客户端开采集',
  );

  useSecond = true;
  clientA.close('endpoint-changed');
  hub.subscribe('c1', viewer.sink, { targetIds: ['TAB-2'], role: 'focus', fps: 2 });
  await hub.whenIdle();
  assert.ok(
    second.state.commands.some(
      (entry) => entry.method === 'Page.startScreencast' || entry.method === 'Page.captureScreenshot',
    ),
    '换端口后应对新客户端开采集',
  );
});
