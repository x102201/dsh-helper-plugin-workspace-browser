/**
 * 宿主半边 + 客户端半边的挂载测试，重点是**Cordis 严格代理**。
 *
 * 背景：Cordis 的 `ctx` 是严格代理 —— 读一个没在 `inject` 里声明、也不是内置方法的
 * 属性会**直接抛** `cannot get property "x" without inject`，整条 loader entry 加载失败。
 * 真实踩到过两次（`ctx.sessionId`、`ctx.workspaceRegistry`），所以这里用一个等价的
 * 严格代理把 `apply()` 跑一遍，把这类错误挡在提交前。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply as applyHost } from '../index.js';
import { ROUTE_PREFIX } from '../lib/routes.js';

/**
 * 造一个行为跟 Cordis 一致的严格上下文：未声明的属性读取即抛错。
 *
 * @param {object} services - 可用服务表。
 * @param {Set<string>} allowed - 当前作用域已 inject 的服务名。
 * @param {object} [records] - 收集副作用（路由、设置等）。
 * @returns {object} 伪 ctx。
 */
function makeStrictCtx(services, allowed = new Set(), records = { routes: [], effects: [] }) {
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
      const nextAllowed = new Set([...allowed, ...deps]);
      const child = makeStrictCtx(services, nextAllowed, records);
      callback(child);
      return () => {};
    },
    get(name) {
      return services[name];
    },
    // 真 ctx 上一定有的东西：`settings.configure(policy, ctx.fiber)` 就用到它。
    fiber: {},
    provide() {},
    set() {},
    on() {
      return () => {};
    },
  };

  const target = {};
  return new Proxy(target, {
    get(_t, prop) {
      const key = String(prop);
      if (prop === 'then') return undefined;
      if (allowed.has(key)) return services[key];
      if (key in methods) return methods[key];
      throw new Error(`cannot get property "${key}" without inject`);
    },
    has(_t, prop) {
      return allowed.has(String(prop)) || String(prop) in methods;
    },
  });
}

/** 假的 req/res，够跑通控制面。 */
function fakeExchange(method, url) {
  const state = { statusCode: 0, headers: {}, chunks: [] };
  const res = {
    writeHead(status, h) {
      state.statusCode = status;
      Object.assign(state.headers, h ?? {});
    },
    end(body) {
      state.chunks.push(typeof body === 'string' ? body : '');
    },
  };
  return {
    req: { method, url, on: () => {}, destroy: () => {} },
    res,
    get statusCode() {
      return state.statusCode;
    },
    headers: state.headers,
    body: () => state.chunks.join(''),
  };
}

/** 装一个宿主 ctx，返回记录。 */
function mountHost() {
  const records = { routes: [], effects: [], settingsInstalled: null, tools: [], toolDisposals: 0 };
  const services = {
    webServer: {
      register(route) {
        records.routes.push(route);
        return () => {};
      },
    },
    tools: {
      register(definition) {
        records.tools.push(definition);
        return () => {
          records.toolDisposals += 1;
        };
      },
    },
    workspaceRegistry: {
      list: () => [{ id: 'w1', path: 'C:\\work\\alpha', title: 'alpha', sessionIds: ['s1'] }],
    },
    settings: {
      // 0.2 契约：namespace 由行 id 决定，schema 由导出的 Config 决定；插件只声明
      // 「本行自带页面」（auto: false），读值走 describe()、写值走 update()。
      configure(policy, fiber) {
        records.settingsConfigured = { policy, fiber };
        return () => {};
      },
      describe: () => [{ ns: 'workspace-browser', value: {}, writable: true, revision: 1 }],
      update: async () => {},
    },
  };
  const ctx = makeStrictCtx(services, new Set(), records);
  /** 卸载：把 effect 的 disposer 都跑一遍（心跳就是在这一步停的）。 */
  const disposeAll = () => {
    for (const disposer of records.effects) {
      try {
        disposer();
      } catch {
        /* 卸载失败不影响断言 */
      }
    }
    records.effects.length = 0;
  };
  return { ctx, records, disposeAll };
}

test('宿主半边能在严格 ctx 上挂载（不读未 inject 的属性）', (t) => {
  const { ctx, records, disposeAll } = mountHost();
  t.after(disposeAll);
  assert.doesNotThrow(() => applyHost(ctx, {}), 'apply() 不该抛错');
  assert.equal(records.routes.length, 1, '应注册恰好一条路由');
  assert.equal(records.routes[0].path, ROUTE_PREFIX);
  assert.equal(records.routes[0].kind, 'prefix');
  assert.ok(records.settingsConfigured, '应声明本行自带配置页面');
  assert.equal(
    records.settingsConfigured.policy.auto,
    false,
    '自带页面的插件必须 auto: false，免得设置页再自动生成一份表单',
  );
});

test('宿主半边在严格 ctx 上注册全部 workspace_browser_* 工具，卸载时全部注销', (t) => {
  const { ctx, records, disposeAll } = mountHost();
  assert.doesNotThrow(() => applyHost(ctx, {}), 'apply() 不该抛错');

  const names = records.tools.map((definition) => definition.name);
  // 读类（P1）+ 写类（P2）都要在。断言"恰好这些"而不是"至少这些"：多出或漏掉
  // 一个都该让人停下来看一眼 —— 工具名进了提示词，不能悄悄变。
  const readTools = [
    'workspace_browser_snapshot',
    'workspace_browser_get_text',
    'workspace_browser_list_tabs',
    'workspace_browser_select_tab',
    'workspace_browser_screenshot',
  ];
  const writeTools = [
    'workspace_browser_click',
    'workspace_browser_type',
    'workspace_browser_press',
    'workspace_browser_scroll',
    'workspace_browser_navigate',
    'workspace_browser_open_tab',
    'workspace_browser_close_tab',
    'workspace_browser_back',
    'workspace_browser_forward',
    'workspace_browser_reload',
    'workspace_browser_wait',
    'workspace_browser_save_skill',
  ];
  assert.deepEqual([...names].sort(), [...readTools, ...writeTools].sort());
  assert.ok(
    !names.includes('workspace_browser_evaluate'),
    'evaluate 由 toolsExposeEvaluate 控制，默认不该注册',
  );

  for (const definition of records.tools) {
    assert.equal(typeof definition.execute, 'function', `${definition.name} 要有 execute`);
    assert.equal(typeof definition.output?.render, 'function', `${definition.name} 要有 output.render`);
    assert.equal(typeof definition.output?.schema, 'object', `${definition.name} 要有 output.schema`);
  }

  // 卸载：工具的注销必须挂在 effect 上（否则 HMR / 卸载会留下重名工具）。
  const expected = readTools.length + writeTools.length;
  disposeAll();
  assert.equal(records.toolDisposals, expected, `卸载后 ${expected} 个工具都要注销`);
  assert.equal(records.effects.length, 0);
});

test('控制面：/status 报未启动，未知路径 404，/cross-origin 校验入参', async (t) => {
  const { ctx, records, disposeAll } = mountHost();
  t.after(disposeAll);
  applyHost(ctx, {});
  const route = records.routes[0];

  const status = fakeExchange('GET', `${ROUTE_PREFIX}/status`);
  await route.handler(status.req, status.res);
  assert.equal(status.statusCode, 200);
  const payload = JSON.parse(status.body());
  assert.equal(payload.state, 'idle', '没启动时应报未启动');
  assert.equal(payload.port, 0);
  assert.ok(payload.chrome, '应带 chrome 段');
  assert.ok('panelOpen' in payload, '应带 panelOpen 段');
  assert.ok(payload.profileDir.includes('workspace-browser'), 'profile 应落在 DSH_HOME 下的 workspace-browser');

  const missing = fakeExchange('GET', `${ROUTE_PREFIX}/nope`);
  await route.handler(missing.req, missing.res);
  assert.equal(missing.statusCode, 404);

  const badBody = fakeExchange('POST', `${ROUTE_PREFIX}/cross-origin`);
  badBody.req.on = (event, handler) => {
    if (event === 'end') handler();
    return badBody.req;
  };
  await route.handler(badBody.req, badBody.res);
  assert.equal(badBody.statusCode, 400, 'enabled 不是布尔值时应报 400');
});

test('客户端半边能在严格 ctx 上挂载（曾经的 sessionId 崩溃点）', async (t) => {
  let definition = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(def) {
        definition = def;
      },
    },
  };
  await import('../client.js');
  assert.ok(definition, 'client.js 应通过 __ModuleLoader__.load 注册自己');
  assert.equal(definition.id, 'dsh-helper-plugin-workspace-browser');

  const ReactStub = {
    createElement: (...args) => ({ args }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  };
  const require = (name) => {
    if (name === 'react') return ReactStub;
    throw new Error(`unexpected require: ${name}`);
  };
  const clientModule = definition.factory(require);

  const seats = [];
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
    locale: { register: () => {}, bind: () => (key) => key },
    configForms: {
      // 0.2：每个 namespace（= 行 id）一张共享表单。
      get: () => ({
        getSnapshot: () => ({ status: 'ready', value: {}, writable: true, revision: 1, mode: 'host' }),
        subscribe: () => () => {},
        set: async () => {},
        mutate: async () => {},
      }),
      whileServed: (_namespaces, register) => register(new Set(['workspace-browser'])),
    },
  };
  // 客户端会订阅状态仓库（2 秒轮询），所以必须留下 records 并在测试结束卸载 ——
  // 否则那个定时器会一直吊着测试进程（浏览器里由页面卸载带走，测试里得自己做）。
  const records = { routes: [], effects: [] };
  const ctx = makeStrictCtx(services, new Set(['slots']), records);
  t.after(() => {
    for (const disposer of records.effects) {
      try {
        disposer();
      } catch {
        /* 忽略 */
      }
    }
  });

  assert.doesNotThrow(() => clientModule.apply(ctx, {}), '客户端 apply() 不该抛错');
  const names = seats.map((seat) => seat.name);
  assert.ok(names.includes('conversation.input.right'), '要有胶囊');
  assert.ok(names.includes('sidebar.right.pane.tab'), '要有画面正文');
  assert.ok(
    !names.includes('conversation.session.header.utilities'),
    '会话头部按钮已按用户要求去掉，不该再注册',
  );

  // 配置页：没有这张，插件面板里本插件的包页面就是空的。
  const settingsSeat = seats.find((seat) => seat.name === 'plugins.bundle.config');
  assert.ok(settingsSeat, '要有插件配置页');
  assert.equal(
    settingsSeat.entry.options.key,
    'dsh-helper-plugin-workspace-browser',
    '页面按包名派发到本插件自己的包卡片上',
  );
});
