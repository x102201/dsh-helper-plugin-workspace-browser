/**
 * 写类工具（P2）测试：`lib/write-tools.js`。
 *
 * 跑法：`node test/write-tools.test.mjs`（**逐个直接跑**；`node --test <目录>` 会
 * spawn 子进程并用管道抓输出，受限沙箱里会 EPERM —— 与 `test/cdp.test.mjs` 同理）。
 *
 * ## 为什么用真 CDP 客户端 + 假 Chrome
 *
 * CDP 那一半不打断言：这里让写类工具走**真的** `lib/cdp.js` 客户端，另一头是
 * `test/helpers/fake-chrome.mjs`。这样「未授权时一条 CDP 命令都不发」这句话是对
 * **真实命令通道**（含握手里的 `Target.getTargets`）断言的，而不是对替身断言。
 *
 * ## 页面侧返回值怎么造
 *
 * `click` / `type` 会注入 `Runtime.evaluate` 去页面里量元素矩形，`wait` 会问
 * `document.readyState`。假 Chrome 的 `evaluateResult` 正好能统一替换
 * `Runtime.evaluate` 的返回值，所以：
 *
 * - 需要「元素找得到」的用例给一份带矩形/标签的 JSON；
 * - `wait` 的用例给 `'complete'`。
 *
 * 这说明白了一件事：这些用例覆盖的是**宿主侧的命令编排与授权**，页面侧的
 * `pageWriteAction`（真实 DOM 行为）没有在真浏览器里验证过。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCdpClient } from '../lib/cdp.js';
import { FIELD_DEFAULTS } from '../lib/settings.js';
import { ERROR_CODES, TOOL_PREFIX, toPageExpression } from '../lib/tools.js';
import { createWriteTools, pageWriteActionForTest, registerWriteTools, WRITE_ERROR_CODES, WRITE_TOOL_NAMES } from '../lib/write-tools.js';
import { startFakeChrome } from './helpers/fake-chrome.mjs';

/** 允许写、但还没点「允许模型操作」的设置。 */
const SETTINGS_LOCKED = Object.freeze({
  toolsWriteRequireApproval: true,
  toolsWriteAuthorized: false,
  toolsExposeEvaluate: false,
});

/** 已经点过「允许模型操作」的设置。 */
const SETTINGS_AUTHORIZED = Object.freeze({
  toolsWriteRequireApproval: true,
  toolsWriteAuthorized: true,
  toolsExposeEvaluate: true,
});

/** `pageWriteAction` 的 resolve / focus 分支会读的那份 JSON。 */
const ELEMENT_JSON = JSON.stringify({
  title: '登录 - Example',
  url: 'https://example.com/login',
  viewport: { width: 1280, height: 800 },
  found: true,
  invalidSelector: false,
  message: '',
  tag: 'input',
  text: '用户名',
  disabled: false,
  rect: { x: 100, y: 200, width: 200, height: 40 },
  scrolledIntoView: true,
  cleared: false,
});

/**
 * 造「实例在跑」的替身。`getEndpoint` 指的是假 Chrome 的端口与 wsPath。
 *
 * @param {object} fake - 假 Chrome。
 * @returns {object} 实例替身。
 */
function runningInstance(fake) {
  return {
    endpoint: { port: fake.port, wsPath: fake.wsPath },
    profileDir: '',
    status: () => ({ state: 'running', port: fake.port, diagnostic: '' }),
  };
}

/**
 * 造一份完整的环境：假 Chrome + 真 CDP 客户端 + 写类工具。
 *
 * @param {object} [options] - 参数。
 * @param {object} [options.settings] - 设置对象。
 * @param {object} [options.fake] - 复用已有的假 Chrome。
 * @param {boolean} [options.connect] - 是否先连上（默认连）。
 * @param {string} [options.evaluateResult] - `Runtime.evaluate` 的返回字符串。
 * @param {(message: object, ctx: object) => any} [options.onCommand] - 假 Chrome 的命令钩子。
 * @param {number} [options.commandTimeoutMs] - 命令超时。
 * @returns {Promise<object>} `{ fake, client, tools, byName, call, commands, of, close }`。
 */
async function setup(options = {}) {
  const fake =
    options.fake ??
    (await startFakeChrome({ evaluateResult: options.evaluateResult ?? ELEMENT_JSON, onCommand: options.onCommand }));
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: options.commandTimeoutMs ?? 4000,
  });
  if (options.connect !== false) await client.connect();

  const settings = options.settings ?? SETTINGS_LOCKED;
  const tools = createWriteTools({
    instance: runningInstance(fake),
    client,
    readSettings: () => settings,
    commandTimeoutMs: options.commandTimeoutMs ?? 4000,
    // 生产默认是 1500ms。假 Chrome 不会自己派发 `Page.frameNavigated`，每跳都要等满，
    // 所以测试里压到 150ms —— 它只影响「标题/网址有多新」，不影响任何断言。
    navigationWaitMs: options.navigationWaitMs ?? 150,
  });
  const byName = new Map(tools.definitions.map((definition) => [definition.name, definition]));

  return {
    fake,
    client,
    tools,
    byName,
    /**
     * 调一个工具（按名字，找不到就直接失败）。
     *
     * @param {string} name - 工具名。
     * @param {object} [args] - 参数。
     * @returns {Promise<object>} 结果值。
     */
    async call(name, args = {}) {
      const definition = byName.get(name);
      assert.ok(definition, `应该有工具 ${name}`);
      return definition.execute(args, {});
    },
    /** 假 Chrome 收到的全部命令（含握手那两条）。 */
    commands: () => fake.state.commands,
    /**
     * 按方法名找收到的命令。
     *
     * @param {string} method - CDP 方法名。
     * @returns {Array<object>} 命令记录。
     */
    of(method) {
      return fake.state.commands.filter((entry) => entry.method === method);
    },
    /**
     * 关掉客户端与假 Chrome（测试收尾用）。
     *
     * @returns {Promise<void>} resolve。
     */
    async close() {
      client.close('test-over');
      await fake.close();
    },
  };
}

/**
 * 造 Cordis 风格的严格上下文：读一个没 inject 的属性就抛错（手法与
 * `test/host.test.mjs` 完全一致）。
 *
 * @param {object} services - 可用服务表。
 * @param {Set<string>} allowed - 已 inject 的服务名。
 * @param {object} records - 收集副作用。
 * @returns {object} 伪 ctx。
 */
function makeStrictCtx(services, allowed = new Set(), records = { effects: [] }) {
  const disposers = [];
  const methods = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect(fn) {
      const dispose = fn();
      const wrapped = typeof dispose === 'function' ? dispose : () => {};
      disposers.push(wrapped);
      records.effects.push(wrapped);
      return wrapped;
    },
    inject(deps, callback) {
      const child = makeStrictCtx(services, new Set([...allowed, ...deps]), records);
      callback(child);
      return () => {};
    },
    get(name) {
      return services[name];
    },
    provide() {},
    set() {},
    on() {
      return () => {};
    },
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const key = String(prop);
        if (prop === 'then') return undefined;
        if (allowed.has(key)) return services[key];
        if (key in methods) return methods[key];
        throw new Error(`cannot get property "${key}" without inject`);
      },
      has(_target, prop) {
        return allowed.has(String(prop)) || String(prop) in methods;
      },
    },
  );
}

// ── 1. 授权门：未授权时一个工具都不动，且一条 CDP 命令都不发 ──────────────────

test('未授权时：每个写类工具都返回 write-not-authorized，且一条 CDP 命令都没发', async (t) => {
  // 关键：这里**不**先 connect()。授权门要在「连」之前就挡住，
  // 所以断言成立的话，假 Chrome 连握手都不该收到。
  const env = await setup({ connect: false });
  t.after(() => env.close());

  const unauthorizedNames = Object.values(WRITE_TOOL_NAMES).filter((name) => name !== WRITE_TOOL_NAMES.evaluate);
  assert.equal(unauthorizedNames.length, 11, '十一个写类工具都要被这道门挡住');

  for (const name of unauthorizedNames) {
    const value = await env.call(name, { ref: '1', index: 1, key: 'Enter', direction: 'down', url: 'https://example.com/', expression: '1', text: 'x' });
    assert.equal(value.ok, false, `${name} 在未授权时必须失败`);
    assert.equal(value.error?.code, WRITE_ERROR_CODES.notAuthorized, `${name} 的错误码应是 write-not-authorized`);
    assert.ok(value.error?.message.includes('允许模型操作'), `${name} 的文案要引导用户点「允许模型操作」`);
  }

  // 一条 CDP 命令都没有 —— 包括握手里的 Target.setDiscoverTargets / Target.getTargets。
  assert.deepEqual(env.commands(), [], '未授权时不该向 CDP 发出任何命令（含握手）');
  assert.equal(env.client.isConnected(), false, '未授权时不该建立 CDP 连接');
});

test('授权门只看设置：requireApproval 关掉或读不到设置时放行', async (t) => {
  const fake = await startFakeChrome({ evaluateResult: ELEMENT_JSON });

  // ① 关掉「要授权」：不再拦截（不需要 writeAuthorized）。
  const open = createWriteTools({
    instance: runningInstance(fake),
    readSettings: () => ({ toolsWriteRequireApproval: false, toolsWriteAuthorized: false }),
  });
  assert.equal(open.authorize(), true, 'requireApproval=false 就该放行');

  // ② 没有任何设置来源：默认直接放行。
  const bare = createWriteTools({ instance: runningInstance(fake) });
  assert.equal(bare.authorize(), true, '读不到设置时按默认放行');

  // ③ 默认值本身：不再要求授权。
  assert.equal(FIELD_DEFAULTS.toolsWriteRequireApproval, false);
  assert.equal(FIELD_DEFAULTS.toolsWriteAuthorized, false);

  open.dispose();
  bare.dispose();
  await fake.close();
});

test('像 index.js 那样接线：共用客户端 + authorizeWrite 时，授权以它为准且不另建连接', async (t) => {
  const fake = await startFakeChrome({ evaluateResult: ELEMENT_JSON });
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  await client.connect();
  t.after(async () => {
    client.close('test-over');
    await fake.close();
  });

  const settings = { toolsWriteRequireApproval: true, toolsWriteAuthorized: false };
  /** 宿主给 `authorizeWrite` 的口径：真源 + 失败关闭。 */
  let reads = 0;
  const tools = createWriteTools({
    instance: runningInstance(fake),
    client,
    readSettings: () => settings,
    authorizeWrite: () => {
      reads += 1;
      const current = settings ?? {};
      if (current.toolsWriteRequireApproval !== true) return true;
      return current.toolsWriteAuthorized === true;
    },
    commandTimeoutMs: 2000,
  });
  t.after(() => tools.dispose());

  // ① 用户还没点「允许模型操作」：挡住，并且**一次 CDP 命令都不发**。
  const before = fake.state.commands.length;
  const denied = await tools.definitions
    .find((definition) => definition.name === WRITE_TOOL_NAMES.click)
    .execute({ ref: '1' }, {});
  assert.equal(denied.error.code, WRITE_ERROR_CODES.notAuthorized);
  assert.ok(reads > 0, 'authorizeWrite 要真的被调用（它就是宿主接设置的桥）');
  assert.equal(fake.state.commands.length, before, '未授权时命令表不该变化');

  // ② 用户点了按钮：同一次会话里立刻放行，不需要重建工具。
  settings.toolsWriteAuthorized = true;
  const allowed = await tools.definitions
    .find((definition) => definition.name === WRITE_TOOL_NAMES.click)
    .execute({ ref: '1' }, {});
  assert.equal(allowed.ok, true, '授权后应立刻能点');

  // ③ 注入的客户端归调用方所有：dispose 不该把它关掉。
  tools.dispose();
  assert.equal(client.isConnected(), true, '共享客户端不能被写类工具的 dispose 关掉');
});

test('静默规则（D10）：所有写类工具都不发 bringToFront，也不注入 window.focus', async (t) => {
  const env = await setup({
    settings: SETTINGS_AUTHORIZED,
    onCommand: (message) => {
      if (message.method === 'Target.createTarget') return { result: { targetId: 'NEW-TARGET-1' } };
      if (message.method === 'Page.getNavigationHistory') {
        return { result: { currentIndex: 1, entries: [{ id: 11 }, { id: 22 }, { id: 33 }] } };
      }
      return undefined;
    },
  });
  t.after(() => env.close());

  // 把每个写类工具都跑一遍（授权状态）。
  const runs = [
    [WRITE_TOOL_NAMES.click, { ref: '1' }],
    [WRITE_TOOL_NAMES.type, { ref: '1', text: 'x' }],
    [WRITE_TOOL_NAMES.press, { key: 'Tab' }],
    [WRITE_TOOL_NAMES.scroll, { direction: 'down' }],
    [WRITE_TOOL_NAMES.navigate, { url: 'https://example.com/x' }],
    [WRITE_TOOL_NAMES.openTab, { url: 'https://example.com/new' }],
    [WRITE_TOOL_NAMES.closeTab, { targetId: 'TAB-2' }],
    [WRITE_TOOL_NAMES.back, {}],
    [WRITE_TOOL_NAMES.forward, {}],
    [WRITE_TOOL_NAMES.reload, {}],
    [WRITE_TOOL_NAMES.wait, { timeoutMs: 150 }],
    [WRITE_TOOL_NAMES.evaluate, { expression: 'document.title' }],
  ];
  for (const [name, args] of runs) await env.call(name, args);

  const commands = env.commands();
  assert.ok(
    !commands.some((entry) => entry.method === 'Page.bringToFront'),
    '绝不允许 Page.bringToFront',
  );
  // `window.focus()` 只可能藏在注入的页面脚本里（没有对应的 CDP 方法）。
  const scripts = commands
    .filter((entry) => entry.method === 'Runtime.evaluate')
    .map((entry) => String(entry.params?.expression ?? ''));
  assert.ok(
    !scripts.some((script) => /window\s*\.\s*focus|\.focus\(\s*\)/u.test(script)),
    '注入的脚本里不许出现 window.focus()（页面内 element.focus({preventScroll:true}) 是允许的）',
  );
  // 浏览器级开标签命令必须显式声明「后台」意图。
  const created = env.of('Target.createTarget');
  assert.equal(created.length, 1);
  assert.equal(created[0].params.background, true);
  assert.ok(!('newWindow' in created[0].params));
});

test('实例没起来时：授权之后仍返回结构化 browser-not-running，不抛异常', async (t) => {
  // 没有任何端点线索：requireConnection 直接给结论，不去等一次必然失败的手势。
  const idleInstance = { endpoint: { port: 0, wsPath: '' }, profileDir: '', status: () => ({ state: 'idle' }) };
  const tools = createWriteTools({
    instance: idleInstance,
    readSettings: () => SETTINGS_AUTHORIZED,
    commandTimeoutMs: 500,
  });
  t.after(() => tools.dispose());

  const click = tools.definitions.find((definition) => definition.name === WRITE_TOOL_NAMES.click);
  const value = await click.execute({ ref: '1' }, {});
  assert.equal(value.ok, false);
  assert.equal(value.error.code, ERROR_CODES.notRunning, '未启动要给 browser-not-running');
  assert.ok(Array.isArray(value.error.hint.actions) && value.error.hint.actions.length > 0, '要带 hint.actions');

  // Chrome 缺失时换成环境类错误码（实例自己记的 failed 最具体）。
  const failedTools = createWriteTools({
    instance: {
      endpoint: { port: 0, wsPath: '' },
      profileDir: '',
      status: () => ({ state: 'failed', diagnostic: 'chrome-missing', lastError: '未检测到 Chrome。' }),
    },
    readSettings: () => SETTINGS_AUTHORIZED,
    commandTimeoutMs: 500,
  });
  t.after(() => failedTools.dispose());
  const failed = await failedTools.definitions
    .find((definition) => definition.name === WRITE_TOOL_NAMES.navigate)
    .execute({ url: 'https://example.com/' }, {});
  assert.equal(failed.error.code, ERROR_CODES.chromeNotInstalled);
});

// ── 2. 授权后：click / type / navigate 发出的方法与参数 ────────────────────────

test('授权后 click：Runtime.evaluate 量元素 → Input.dispatchMouseEvent 三连', async (t) => {
  const env = await setup({ settings: SETTINGS_AUTHORIZED });
  t.after(() => env.close());

  const value = await env.call(WRITE_TOOL_NAMES.click, { ref: '3' });
  assert.equal(value.ok, true, '授权后应点成功');
  assert.equal(value.targetId, 'TAB-1');
  assert.equal(value.url, 'https://example.com/login');
  assert.equal(value.title, '登录 - Example');
  assert.equal(typeof value.detail, 'string');

  const mouse = env.of('Input.dispatchMouseEvent');
  assert.deepEqual(
    mouse.map((entry) => entry.params.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased'],
    '要有移动 + 按下 + 抬起',
  );
  // 矩形 (100,200,200×40) 的中心。
  assert.equal(mouse[1].params.x, 200);
  assert.equal(mouse[1].params.y, 220);
  assert.equal(mouse[1].params.button, 'left');
  assert.equal(mouse[1].params.clickCount, 1);
  assert.equal(mouse[0].params.buttons, 0, '移动时不该带按住状态');
  assert.equal(mouse[1].sessionId, 'S-TAB-1', '页面级命令必须带扁平会话');
});

test('授权后 type：先 focus 再 Input.insertText；submit 追一次回车', async (t) => {
  const env = await setup({ settings: SETTINGS_AUTHORIZED });
  t.after(() => env.close());

  const value = await env.call(WRITE_TOOL_NAMES.type, { ref: '#user', text: '张三', clear: true, submit: true });
  assert.equal(value.ok, true, '授权后应填字成功');
  assert.equal(value.typedChars, 2);
  assert.equal(value.targetId, 'TAB-1');
  assert.equal(value.url, 'https://example.com/login');

  const inserted = env.of('Input.insertText');
  assert.equal(inserted.length, 1, '填字只该有一条 insertText');
  assert.equal(inserted[0].params.text, '张三');
  assert.equal(inserted[0].sessionId, 'S-TAB-1');

  const keys = env.of('Input.dispatchKeyEvent');
  assert.deepEqual(
    keys.map((entry) => entry.params.type),
    ['keyDown', 'keyUp'],
    'submit 要派发一次回车（按下 + 抬起）',
  );
  assert.equal(keys[0].params.key, 'Enter');
  assert.equal(keys[1].params.text, undefined, 'keyUp 不能带 text，否则会又输入一遍');

  // 清空是页面侧做的（focus 那一跳带的 clear:true），宿主侧不该为此多发命令。
  const evaluates = env.of('Runtime.evaluate');
  assert.equal(evaluates.length, 1, 'focus 只注入一次脚本');
  assert.ok(evaluates[0].params.expression.includes('"clear":true'), 'clear 要一路传到页面侧');
});

test('授权后 navigate：Page.navigate 带 URL，返回值反映导航后的 url/title', async (t) => {
  const env = await setup({
    settings: SETTINGS_AUTHORIZED,
    fake: await startFakeChrome({
      evaluateResult: ELEMENT_JSON,
      onCommand: (message, { emitEvent }) => {
        if (message.method !== 'Page.navigate') return undefined;
        // 真 Chrome 会先回响应、再派发 frameNavigated；这里照做，让 waitForNavigation 走事件那条路。
        setTimeout(() => {
          emitEvent('Page.frameNavigated', { frame: { url: message.params.url } }, `S-${message.sessionId ?? 'TAB-1'}`);
        }, 5);
        return { result: { frameId: 'FRAME-1' } };
      },
    }),
  });
  t.after(() => env.close());

  // 目标表的 url 也改成导航后的（模拟 Target.targetInfoChanged）。
  env.fake.emitEvent('Target.targetInfoChanged', {
    targetInfo: { targetId: 'TAB-1', type: 'page', url: 'https://example.com/after', title: '导航后' },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const value = await env.call(WRITE_TOOL_NAMES.navigate, { url: 'example.com/login' });
  assert.equal(value.ok, false, '不带协议要报参数错误');

  const bad = await env.call(WRITE_TOOL_NAMES.navigate, { url: 'javascript:alert(1)' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, WRITE_ERROR_CODES.navigationBlocked, 'javascript: 不该放过去');

  const ok = await env.call(WRITE_TOOL_NAMES.navigate, { url: 'https://example.com/after' });
  assert.equal(ok.ok, true);
  const navigations = env.of('Page.navigate');
  assert.equal(navigations.length, 1, '只有合法的那个真的发了 Page.navigate');
  assert.equal(navigations[0].params.url, 'https://example.com/after');
  assert.equal(ok.targetId, 'TAB-1');
  assert.equal(ok.url, 'https://example.com/after');
  assert.equal(ok.title, '导航后');
});

test('授权后 scroll / press：滚轮事件与按键事件的参数正确', async (t) => {
  const env = await setup({ settings: SETTINGS_AUTHORIZED });
  t.after(() => env.close());

  const scrolled = await env.call(WRITE_TOOL_NAMES.scroll, { direction: 'down', amount: 300 });
  assert.equal(scrolled.ok, true);
  const wheels = env.of('Input.dispatchMouseEvent').filter((entry) => entry.params.type === 'mouseWheel');
  assert.equal(wheels.length, 1);
  assert.equal(wheels[0].params.deltaY, 300, '向下滚是正 deltaY');
  assert.equal(wheels[0].params.deltaX, 0);
  assert.equal(wheels[0].params.x, 640, '默认在视口中心滚');
  assert.equal(wheels[0].params.y, 400);

  const pressed = await env.call(WRITE_TOOL_NAMES.press, { key: 'ArrowDown', repeat: 2 });
  assert.equal(pressed.ok, true);
  const keys = env.of('Input.dispatchKeyEvent');
  assert.equal(keys.length, 4, '按两次 = 两组 down/up');
  assert.equal(keys[0].params.key, 'ArrowDown');
  assert.equal(keys[0].params.windowsVirtualKeyCode, 40);
  assert.equal(keys[2].params.autoRepeat, true, '第二次要标 autoRepeat');

  const unknown = await env.call(WRITE_TOOL_NAMES.press, { key: 'NoSuchKey' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, ERROR_CODES.invalidArgument);
});

test('授权后 wait：readyState 变成 complete 才算稳定，超时不算失败', async (t) => {
  // 两种 `Runtime.evaluate` 要分开答：`document.readyState` 那一跳给 `complete`，
  // 取标题/视口的那一跳给页面 JSON。
  const fake = await startFakeChrome({
    onCommand: (message) => {
      if (message.method !== 'Runtime.evaluate') return undefined;
      const expression = String(message.params?.expression ?? '');
      if (expression === 'document.readyState') {
        return { result: { result: { type: 'string', value: 'complete' } } };
      }
      return { result: { result: { type: 'string', value: ELEMENT_JSON } } };
    },
  });
  const client = createCdpClient({
    getEndpoint: () => ({ port: fake.port, wsPath: fake.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  await client.connect();
  const tools = createWriteTools({
    instance: runningInstance(fake),
    client,
    readSettings: () => SETTINGS_AUTHORIZED,
    commandTimeoutMs: 2000,
  });
  t.after(async () => {
    client.close('test-over');
    await fake.close();
  });

  const settled = await tools.definitions
    .find((definition) => definition.name === WRITE_TOOL_NAMES.wait)
    .execute({ timeoutMs: 500 }, {});
  assert.equal(settled.ok, true);
  assert.equal(settled.settled, true);
  assert.equal(settled.readyState, 'complete');
  assert.ok(settled.waitedMs >= 0 && settled.waitedMs < 500, '稳定了就该立刻返回，不空等');
  assert.equal(settled.targetId, 'TAB-1');
  assert.equal(settled.url, 'https://example.com/login', 'url/title 取自页面那一跳');

  // 一直不是 complete：超时返回 settled:false，但**不是**错误。
  const neverDone = await startFakeChrome({
    onCommand: (message) => {
      if (message.method !== 'Runtime.evaluate') return undefined;
      const expression = String(message.params?.expression ?? '');
      if (expression === 'document.readyState') {
        return { result: { result: { type: 'string', value: 'loading' } } };
      }
      return { result: { result: { type: 'string', value: ELEMENT_JSON } } };
    },
  });
  const client2 = createCdpClient({
    getEndpoint: () => ({ port: neverDone.port, wsPath: neverDone.wsPath }),
    connectTimeoutMs: 2000,
    commandTimeoutMs: 2000,
  });
  await client2.connect();
  const tools2 = createWriteTools({
    instance: runningInstance(neverDone),
    client: client2,
    readSettings: () => SETTINGS_AUTHORIZED,
    commandTimeoutMs: 2000,
  });
  t.after(async () => {
    client2.close('test-over');
    tools2.dispose();
    await neverDone.close();
  });

  const timedOut = await tools2.definitions
    .find((definition) => definition.name === WRITE_TOOL_NAMES.wait)
    .execute({ timeoutMs: 250 }, {});
  assert.equal(timedOut.ok, true, '超时不该变成错误');
  assert.equal(timedOut.settled, false);
  assert.equal(timedOut.readyState, 'loading');
  assert.ok(timedOut.waitedMs >= 200, `要真的等过（实际 ${timedOut.waitedMs}ms）`);
});

// ── 3. open_tab / close_tab ──────────────────────────────────────────────────

test('open_tab 用 Target.createTarget 且不带 newWindow；close_tab 用 Target.closeTarget', async (t) => {
  const env = await setup({
    settings: SETTINGS_AUTHORIZED,
    onCommand: (message) => {
      if (message.method !== 'Target.createTarget') return undefined;
      return { result: { targetId: 'NEW-TARGET-1' } };
    },
  });
  t.after(() => env.close());

  const opened = await env.call(WRITE_TOOL_NAMES.openTab, { url: 'https://example.com/new' });
  assert.equal(opened.ok, true);
  assert.equal(opened.targetId, 'NEW-TARGET-1', '返回值要带新建的 targetId');
  assert.equal(opened.url, 'https://example.com/new', '假 Chrome 还没把 targetInfo 报回来时，至少要把请求的 url 带回来');
  assert.equal(opened.title, '', 'title 拿不到就是空串，不能编一个');

  const created = env.of('Target.createTarget');
  assert.equal(created.length, 1);
  assert.equal(created[0].params.url, 'https://example.com/new');
  assert.ok(!('newWindow' in created[0].params), '一个工作区只有 1 个窗口：绝不能带 newWindow');
  // ⚠️ 这个参数名还没实测（DESIGN §10），这里锁住「按设计传了什么」，不代表 Chrome 认它。
  assert.equal(created[0].params.background, true, '要按 background: true 传（待实测）');
  // 浏览器级命令**不带会话**：`lib/cdp.js` 的 `commandBrowser()` 就是为此存在的
  // （`command(null, …)` 会先 attach 一个默认标签，语义不对）。
  assert.equal(created[0].sessionId, undefined, 'Target.createTarget 走 commandBrowser，不带 sessionId');

  // 静默规则（D10）：全程不许出现抢前台的调用。
  const methods = env.commands().map((entry) => entry.method);
  assert.ok(!methods.includes('Page.bringToFront'), '写操作绝不能把窗口带到前台');

  const closed = await env.call(WRITE_TOOL_NAMES.closeTab, { targetId: 'TAB-2' });
  assert.equal(closed.ok, true);
  assert.equal(closed.targetId, 'TAB-2');
  assert.equal(closed.url, 'https://example.com/docs', '关之前要把 url/title 报出来');
  assert.equal(closed.title, '文档');

  const closeCalls = env.of('Target.closeTarget');
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].params.targetId, 'TAB-2');

  // 关一个不存在的标签：结构化错误，不是抛异常。
  const missing = await env.call(WRITE_TOOL_NAMES.closeTab, { targetId: 'NOPE' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, ERROR_CODES.targetNotFound);
});

test('授权后 back / forward / reload：命令与「没有上一页」的结构化错误', async (t) => {
  const env = await setup({
    settings: SETTINGS_AUTHORIZED,
    fake: await startFakeChrome({
      evaluateResult: ELEMENT_JSON,
      onCommand: (message) => {
        if (message.method !== 'Page.getNavigationHistory') return undefined;
        return {
          result: {
            currentIndex: 1,
            entries: [
              { id: 11, url: 'https://example.com/first' },
              { id: 22, url: 'https://example.com/second' },
            ],
          },
        };
      },
    }),
  });
  t.after(() => env.close());

  const back = await env.call(WRITE_TOOL_NAMES.back, {});
  assert.equal(back.ok, true);
  assert.equal(back.url, 'https://example.com/login', 'url 取自 target 表');
  assert.deepEqual(
    env.of('Page.navigateToHistoryEntry').map((entry) => entry.params.entryId),
    [11],
    '后退要拿 currentIndex-1 那一条的 entryId（Page.navigateToHistoryEntry 不接受空参数）',
  );

  // 前进：currentIndex=1 已经是最后一条，没有下一页。
  const forward = await env.call(WRITE_TOOL_NAMES.forward, {});
  assert.equal(forward.ok, false);
  assert.equal(forward.error.code, WRITE_ERROR_CODES.navigationBlocked);

  const reload = await env.call(WRITE_TOOL_NAMES.reload, {});
  assert.equal(reload.ok, true);
  assert.equal(env.of('Page.reload').length, 1);
});

// ── 4. evaluate 的注册开关 ───────────────────────────────────────────────────

test('evaluate：toolsExposeEvaluate 关时不出现，开时出现（且同样过授权门）', async (t) => {
  const env = await setup({ settings: SETTINGS_LOCKED });
  t.after(() => env.close());

  assert.equal(env.byName.has(WRITE_TOOL_NAMES.evaluate), false, '默认不注册 evaluate');
  assert.equal(env.tools.names.includes(WRITE_TOOL_NAMES.evaluate), false);
  assert.equal(env.tools.names.length, 11, '不开开关时是 11 个（click…wait）');

  const withEvaluate = await setup({ settings: SETTINGS_AUTHORIZED });
  t.after(() => withEvaluate.close());
  assert.equal(withEvaluate.byName.has(WRITE_TOOL_NAMES.evaluate), true, '开了就该出现');
  assert.equal(withEvaluate.tools.names.length, 12);

  const value = await withEvaluate.call(WRITE_TOOL_NAMES.evaluate, { expression: 'document.title' });
  assert.equal(value.ok, true);
  assert.equal(value.value, ELEMENT_JSON, 'evaluate 把页面返回的字符串原样带回来');
  assert.equal(value.valueType, 'string');
  assert.equal(value.truncated, false);
  assert.equal(value.targetId, 'TAB-1');
  const calls = withEvaluate.of('Runtime.evaluate');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.awaitPromise, true, 'evaluate 要 await 页面返回的 Promise');

  // 有 evaluate 但没授权：一样被挡住，且什么命令都不发。
  const lockedWithEvaluate = await setup({ settings: { toolsWriteRequireApproval: true, toolsWriteAuthorized: false, toolsExposeEvaluate: true }, connect: false });
  t.after(() => lockedWithEvaluate.close());
  const denied = await lockedWithEvaluate.call(WRITE_TOOL_NAMES.evaluate, { expression: '1' });
  assert.equal(denied.error.code, WRITE_ERROR_CODES.notAuthorized);
  assert.deepEqual(lockedWithEvaluate.commands(), []);
});

// ── 5. 每个写类工具的返回值都含 targetId / url / title ────────────────────────

test('所有写类工具的返回值都带 targetId / url / title', async (t) => {
  const env = await setup({
    settings: SETTINGS_AUTHORIZED,
    onCommand: (message) => {
      if (message.method === 'Target.createTarget') return { result: { targetId: 'NEW-TARGET-1' } };
      // back / forward 需要一条真实的历史：currentIndex 放中间，两边都走得到。
      if (message.method === 'Page.getNavigationHistory') {
        return {
          result: {
            currentIndex: 1,
            entries: [
              { id: 11, url: 'https://example.com/first' },
              { id: 22, url: 'https://example.com/second' },
              { id: 33, url: 'https://example.com/third' },
            ],
          },
        };
      }
      return undefined;
    },
  });
  t.after(() => env.close());

  const cases = [
    [WRITE_TOOL_NAMES.click, { ref: '1' }],
    [WRITE_TOOL_NAMES.type, { ref: '1', text: 'x' }],
    [WRITE_TOOL_NAMES.press, { key: 'Tab' }],
    [WRITE_TOOL_NAMES.scroll, { direction: 'down' }],
    [WRITE_TOOL_NAMES.navigate, { url: 'https://example.com/login' }],
    [WRITE_TOOL_NAMES.openTab, { url: 'https://example.com/new' }],
    [WRITE_TOOL_NAMES.closeTab, { targetId: 'TAB-2' }],
    [WRITE_TOOL_NAMES.back, {}],
    [WRITE_TOOL_NAMES.forward, {}],
    [WRITE_TOOL_NAMES.reload, {}],
    [WRITE_TOOL_NAMES.wait, { timeoutMs: 200 }],
    [WRITE_TOOL_NAMES.evaluate, { expression: '1' }],
  ];

  for (const [name, args] of cases) {
    const value = await env.call(name, args);
    assert.equal(value.ok, true, `${name} 应成功（实际 ${JSON.stringify(value)}）`);
    assert.equal(typeof value.targetId, 'string', `${name} 要有 targetId`);
    assert.notEqual(value.targetId, '', `${name} 的 targetId 不能是空串`);
    assert.equal(typeof value.url, 'string', `${name} 要有 url`);
    assert.equal(typeof value.title, 'string', `${name} 要有 title`);
  }

  // 静默规则：跑完这一整轮，一次都不许出现把窗口带到前台的调用。
  const methods = env.commands().map((entry) => entry.method);
  assert.ok(!methods.includes('Page.bringToFront'), '写操作全程都不能 Page.bringToFront');
});

// ── 7. 页面侧元素定位：编号与快照同构（用一个假 DOM 真跑一遍注入的脚本） ────────

/**
 * 造一个只够 `pageWriteAction` 用的假元素。
 *
 * @param {string} tag - 标签名。
 * @param {object} [options] - 参数。
 * @param {string} [options.id] - id。
 * @param {string} [options.type] - type 属性。
 * @param {object} [options.rect] - 矩形。
 * @param {object} [options.attrs] - 额外属性。
 * @returns {object} 假元素。
 */
function fakeElement(tag, options = {}) {
  const attrs = { ...(options.id === undefined ? {} : { id: options.id }), ...(options.type === undefined ? {} : { type: options.type }), ...(options.attrs ?? {}) };
  const rect = options.rect ?? { x: 0, y: 0, width: 10, height: 10 };
  return {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    disabled: false,
    isContentEditable: false,
    innerText: options.text ?? '',
    textContent: options.text ?? '',
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    getBoundingClientRect: () => rect,
    scrollIntoView: () => {},
    focus: () => {
      globalThis.__focused = true;
    },
    dispatchEvent: () => {},
  };
}

test('页面侧定位：假 DOM 上跑一遍注入的脚本，编号与选择器都能指对元素', async (t) => {
  // 这个用例不连 CDP：直接把注入用的那一段页面代码在假 DOM 上跑一遍。
  // 它验证的是「编号背后的判据」（可见性 + 可点/字段），也就是最容易和
  // lib/snapshot.js 漂开的那一半。
  const link = fakeElement('a', { id: 'link', text: '详情', rect: { x: 0, y: 0, width: 80, height: 20 } });
  const button = fakeElement('button', { id: 'go', text: '提交', rect: { x: 0, y: 30, width: 80, height: 20 } });
  const plainDiv = fakeElement('div', { attrs: { class: 'plain' } }); // 不可点：不该占编号
  const hiddenBox = fakeElement('button', { id: 'hidden', rect: { x: 0, y: 0, width: 0, height: 0 } }); // 没面积：跳过
  const hiddenInput = fakeElement('input', { id: 'csrf', type: 'hidden', rect: { x: 0, y: 0, width: 0, height: 0 } }); // 隐藏字段：算
  const nodes = [plainDiv, link, hiddenBox, button, hiddenInput];

  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  globalThis.__focused = false;
  globalThis.document = {
    title: '假页面',
    querySelectorAll: () => nodes,
    querySelector: (selector) => {
      // 真 `document.querySelector` 对语法错的选择器会抛 `SyntaxError`；
      // 「坏选择器只回报、不抛」这条路要能测到，假 DOM 就得照做。
      if (!/^[#.\w-]+$/u.test(selector)) {
        throw new SyntaxError(`'${selector}' is not a valid selector`);
      }
      return nodes.find((element) => (selector.startsWith('#') ? element.getAttribute('id') === selector.slice(1) : false)) ?? null;
    },
  };
  globalThis.window = { innerWidth: 1000, innerHeight: 600 };
  globalThis.location = { href: 'https://example.com/fake' };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  });

  // 注入用的表达式必须和实现同一条路径：`toPageExpression(pageWriteAction, [payload])`。
  const result = JSON.parse(eval(toPageExpression(pageWriteActionForTest, [{ mode: 'resolve', index: 1 }])));
  assert.equal(result.found, true);
  assert.equal(result.tag, 'a', '编号 1 = DOM 顺序里第一个「可见 + 可交互」的元素（div 不占编号）');
  assert.equal(result.text, '详情');

  const second = JSON.parse(eval(toPageExpression(pageWriteActionForTest, [{ mode: 'resolve', index: 2 }])));
  assert.equal(second.tag, 'button', '编号 2 = 按钮（零面积的第二个 button 被跳过）');
  assert.equal(second.disabled, false);

  const third = JSON.parse(eval(toPageExpression(pageWriteActionForTest, [{ mode: 'resolve', index: 3 }])));
  assert.equal(third.tag, 'input', '编号 3 = 隐藏的 csrf 字段（隐藏 input 算字段）');

  const missing = JSON.parse(eval(toPageExpression(pageWriteActionForTest, [{ mode: 'resolve', index: 9 }])));
  assert.equal(missing.found, false, '越界的编号要报「找不到」，不能点到别的元素上');

  const bySelector = JSON.parse(eval(toPageExpression(pageWriteActionForTest, [{ mode: 'resolve', selector: '#go' }])));
  assert.equal(bySelector.found, true);
  assert.equal(bySelector.tag, 'button');
  assert.equal(bySelector.rect.width, 80, 'resolve 必须把矩形带回来（click 靠它算坐标）');
  assert.equal(bySelector.rect.x, 0);

  const badSelector = JSON.parse(
    eval(toPageExpression(pageWriteActionForTest, [{ mode: 'resolve', selector: '>>>bad<<<' }])),
  );
  assert.equal(badSelector.found, false);
  assert.equal(badSelector.invalidSelector, true, '坏选择器只回报，不抛');

  const focused = JSON.parse(eval(toPageExpression(pageWriteActionForTest, [{ mode: 'focus', index: 2 }])));
  assert.equal(focused.found, true);
  assert.equal(globalThis.__focused, true, 'focus 分支要真的调 element.focus()');
  assert.equal(focused.rect.height, 20);

  const info = JSON.parse(eval(toPageExpression(pageWriteActionForTest, [{ mode: 'info' }])));
  assert.equal(info.title, '假页面');
  assert.equal(info.url, 'https://example.com/fake');
  assert.deepEqual(info.viewport, { width: 1000, height: 600 });
});

// ── 8. registerWriteTools：数量与 disposer ──────────────────────────────────

test('registerWriteTools 注册 11 个工具（开 evaluate 是 12），disposer 能把它们全注销', async (t) => {
  const fake = await startFakeChrome({ evaluateResult: ELEMENT_JSON });
  t.after(() => fake.close());

  const registered = [];
  const effects = [];
  const services = {
    tools: {
      register(definition) {
        registered.push(definition.name);
        return () => {
          const index = registered.indexOf(definition.name);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
  };
  const ctx = makeStrictCtx(services, new Set(['tools']), { effects });
  let writeTools = null;
  assert.doesNotThrow(() => {
    writeTools = registerWriteTools(ctx, {
      instance: runningInstance(fake),
      readSettings: () => SETTINGS_LOCKED,
    });
  }, 'registerWriteTools 不该抛错');

  assert.equal(writeTools.registered, 11, '不开 evaluate 时注册 11 个');
  assert.equal(registered.length, 11);
  assert.ok(registered.every((name) => name.startsWith(TOOL_PREFIX)), '名字都要带 workspace_browser_ 前缀');
  assert.ok(registered.includes(WRITE_TOOL_NAMES.click) && registered.includes(WRITE_TOOL_NAMES.openTab));
  assert.equal(effects.length, 1, '要用一个 effect 兜住注销');

  effects[0]();
  assert.deepEqual(registered, [], 'disposer 要把 11 个工具全部注销');

  // 开 evaluate 时是 12 个。
  const registered2 = [];
  const ctx2 = makeStrictCtx(
    {
      tools: {
        register(definition) {
          registered2.push(definition.name);
          return () => {};
        },
      },
    },
    new Set(['tools']),
    { effects: [] },
  );
  const withEvaluate = registerWriteTools(ctx2, {
    instance: runningInstance(fake),
    readSettings: () => ({ ...SETTINGS_LOCKED, toolsExposeEvaluate: true }),
  });
  assert.equal(withEvaluate.registered, 12);
  assert.ok(registered2.includes(WRITE_TOOL_NAMES.evaluate));
});

test('registerWriteTools 在严格 ctx 上不读未 inject 的属性', async (t) => {
  const fake = await startFakeChrome({ evaluateResult: ELEMENT_JSON });
  t.after(() => fake.close());

  const effects = [];
  const ctx = makeStrictCtx({ tools: { register: () => () => {} } }, new Set(['tools']), { effects });
  // 这个 ctx 上没有 settings / instance / webServer：碰一下就抛错。
  assert.doesNotThrow(() => {
    registerWriteTools(ctx, { instance: runningInstance(fake), readSettings: () => SETTINGS_AUTHORIZED });
  });
  assert.equal(effects.length, 1);

  // `tools` 服务不存在（宿主没提供）时返回 registered: 0，不抛错。
  const bare = makeStrictCtx({}, new Set(), { effects: [] });
  const result = registerWriteTools(bare, { instance: runningInstance(fake), readSettings: () => SETTINGS_LOCKED });
  assert.equal(result.registered, 0);
  assert.equal(result.writeTools.definitions.length, 11, '工具定义照样造出来（只是没注册）');
  result.writeTools.dispose();
});
