/**
 * 读类工具测试：页面抽取、敏感值掩码、工具形状、严格 ctx、错误契约，以及对着
 * 假 Chrome 的端到端跑通。
 *
 * 跑法：`node test/tools.test.mjs`（**逐个直接跑**；`node --test <目录>` 会 spawn
 * 子进程并用管道抓输出，受限沙箱里会 EPERM）。
 *
 * 三块替身，各自负责一件事：
 *
 * - **极简 DOM**：让 `collectPageSnapshot` 真的在一段固定 HTML 上跑一遍（不需要 jsdom）。
 * - **node:vm**：让 `Runtime.evaluate` 真的执行宿主发过去的表达式 —— 于是「页面侧函数
 *   必须自包含」这条约束也在测试里成立。
 * - **假 Chrome**（test/helpers/fake-chrome.mjs）：真实的 WebSocket 与 CDP 线路。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  buildSnapshotValue,
  collectPageSnapshot,
  collectPageText,
  DEFAULT_TEXT_LIMIT,
  MASK_TEXT,
  renderSnapshotText,
} from '../lib/snapshot.js';
import {
  createBrowserTools,
  ERROR_CODES,
  pngSize,
  registerBrowserTools,
  TOOL_NAMES,
  TOOL_PREFIX,
  toPageExpression,
  UNTRUSTED_OPEN,
  wrapUntrusted,
} from '../lib/tools.js';
import { startFakeChrome, TINY_PNG_BASE64 } from './helpers/fake-chrome.mjs';

/** 固定 HTML：一个登录页，覆盖链接、按钮、onclick、role、各种字段、隐藏元素。 */
const FIXED_HTML = `<!doctype html>
<html>
<head><title>登录 - Example</title></head>
<body>
  <h1>请登录</h1>
  <a id="help-link" href="https://example.com/help">帮助</a>
  <form id="login-form" action="/login">
    <label for="user">用户名</label>
    <input id="user" name="username" type="text" value="alice" placeholder="用户名">
    <label for="pwd">密码</label>
    <input id="pwd" name="password" type="password" value="hunter2">
    <input id="csrf" name="csrf_token" type="hidden" value="tok_1234567890">
    <input id="sid" name="session_id" type="text" value="sess_abcdef">
    <input id="remember" name="remember" type="checkbox" checked>
    <textarea id="note" name="note">备注文字</textarea>
    <select id="lang" name="lang"><option value="zh">中文</option><option value="en">English</option></select>
    <button id="submit-btn" type="submit" name="go">登录</button>
  </form>
  <div id="custom" onclick="doThing()">点我</div>
  <span id="close-x" role="button" aria-label="关闭">×</span>
  <div id="invisible" hidden><input id="ghost" name="q" type="text" value="不该出现"></div>
  <script>console.log('忽略我')</script>
</body>
</html>`;

/** 页面地址（页面侧抽取出 `url`）。 */
const FIXED_URL = 'https://example.com/login';

// ── 极简 DOM：只实现页面侧抽取用到的那几个 API ─────────────────────────────

/** HTML 里没有结束标签的元素。 */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * 解析一行属性。
 *
 * @param {string} text - 标签里属性那一段。
 * @returns {Record<string, string>} 属性表（无值属性记为 `''`）。
 */
function parseAttributes(text) {
  const attrs = {};
  const pattern = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gu;
  let match = pattern.exec(text);
  while (match !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
    match = pattern.exec(text);
  }
  return attrs;
}

/**
 * 造一个极简 DOM。
 *
 * 只支持 `getAttribute` / `hasAttribute` / `children` / `parentElement` /
 * `textContent` / `innerText` / `getBoundingClientRect` / 布尔属性 / `value` / `id`，
 * 以及 `querySelectorAll('*')` 与 `#id` / `.class` / `tag` 三种 `querySelector`。
 * 够 `collectPageSnapshot` 与 `collectPageText` 用，不是通用实现。
 *
 * @param {string} html - HTML 源码。
 * @returns {{ document: object, location: { href: string } }} 假 DOM。
 */
function miniDom(html) {
  /** @type {Array<object>} */
  const elements = [];
  const document = {
    title: '',
    body: null,
    _roots: [],
    querySelectorAll(selector) {
      if (selector !== '*') throw new Error(`mini DOM 只支持 '*'，收到 ${selector}`);
      return elements;
    },
    querySelector(selector) {
      const trimmed = selector.trim();
      if (trimmed.startsWith('#')) return elements.find((element) => element.id === trimmed.slice(1)) ?? null;
      if (trimmed.startsWith('.')) {
        return (
          elements.find((element) => (element.getAttribute('class') ?? '').split(/\s+/u).includes(trimmed.slice(1))) ?? null
        );
      }
      const tag = trimmed.toUpperCase();
      return elements.find((element) => element.tagName === tag) ?? null;
    },
  };

  /**
   * 收集一个元素的全部文字（含子孙）。
   *
   * @param {object} element - 元素。
   * @returns {string} 文字。
   */
  function textOf(element) {
    let text = element._text;
    for (const child of element.children) text += textOf(child);
    return text;
  }

  /**
   * 造一个元素。
   *
   * @param {string} tag - 大写标签名。
   * @param {Record<string, string>} attrs - 属性。
   * @param {object | null} parent - 父元素。
   * @returns {object} 元素。
   */
  function makeElement(tag, attrs, parent) {
    const element = {
      nodeType: 1,
      tagName: tag,
      parentElement: parent,
      children: [],
      _attrs: attrs,
      _text: '',
      getAttribute(name) {
        return Object.hasOwn(attrs, name) ? attrs[name] : null;
      },
      hasAttribute(name) {
        return Object.hasOwn(attrs, name);
      },
      getBoundingClientRect() {
        // 可见性是**继承**的：祖先 `hidden` / `display:none` 会让子孙也没有面积，
        // 真实浏览器就是这样（`#invisible` 里的输入框因此不该出现在快照里）。
        let node = element;
        while (node !== null && node !== undefined) {
          const attrsOfNode = node._attrs ?? {};
          const style = attrsOfNode.style ?? '';
          if (Object.hasOwn(attrsOfNode, 'hidden') || style.includes('display:none') || style.includes('display: none')) {
            return { width: 0, height: 0 };
          }
          node = node.parentElement;
        }
        return { width: 120, height: 24 };
      },
    };
    Object.defineProperty(element, 'id', { get: () => attrs.id ?? '' });
    // textarea 的 `.value` 就是它的文字（没写 value 属性时），真实浏览器如此。
    Object.defineProperty(element, 'value', {
      get: () => (tag === 'TEXTAREA' && !Object.hasOwn(attrs, 'value') ? textOf(element) : attrs.value ?? ''),
    });
    Object.defineProperty(element, 'textContent', { get: () => textOf(element) });
    Object.defineProperty(element, 'innerText', { get: () => textOf(element) });
    // 布尔属性：HTML 里「有这个名字」就是真（`checked="false"` 也仍然是真，浏览器同样如此）。
    for (const name of ['checked', 'disabled', 'selected', 'multiple', 'readonly', 'required']) {
      Object.defineProperty(element, name, { get: () => Object.hasOwn(attrs, name) });
    }
    elements.push(element);
    return element;
  }

  let current = null;
  let titleElement = null;
  const tokens = html.split(/(<[^>]*>)/u);
  for (const token of tokens) {
    if (token === '' || token.startsWith('<!--')) continue;
    if (token.startsWith('</')) {
      current = current === null ? null : current.parentElement;
      continue;
    }
    if (token.startsWith('<')) {
      const match = /^<([a-zA-Z0-9-]+)([\s\S]*?)(\/?)>$/u.exec(token);
      if (match === null) continue;
      const tag = match[1].toUpperCase();
      const element = makeElement(tag, parseAttributes(match[2]), current);
      (current === null ? document._roots : current.children).push(element);
      if (tag === 'TITLE') titleElement = element;
      if (tag === 'BODY') document.body = element;
      if (!VOID_TAGS.has(match[1].toLowerCase()) && match[3] !== '/') current = element;
      continue;
    }
    if (current !== null) current._text += token;
  }
  document.title = titleElement === null ? '' : textOf(titleElement).replace(/\s+/gu, ' ').trim();

  return { document, location: { href: FIXED_URL } };
}

/** 跑一次页面侧快照抽取，返回原始 JSON 对象。 */
function collectRaw() {
  const dom = miniDom(FIXED_HTML);
  const text = runInNewContext(toPageExpression(collectPageSnapshot), { document: dom.document, location: dom.location });
  return JSON.parse(text);
}

// ── harness JSON Schema 子集的自检（不引入依赖，但保证手写 schema 合法） ──────

/** `assertSupportedJsonSchema` 允许的关键字。 */
const ALLOWED_SCHEMA_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);

/**
 * 校验 schema 是否在 harness 的子集内（等价于 `assertSupportedJsonSchema` 的要点）。
 *
 * 这条测试很值：手写 definition 最容易犯的错就是把 DSL 的 `required: true` 当成
 * JSON Schema 的 `required: [...]`，注册表会在加载时直接抛错。
 *
 * @param {object} schema - 待检查的 schema。
 * @returns {string[]} 违规列表。
 */
function schemaViolations(schema) {
  const violations = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') {
      violations.push(`${path}: 应该是 schema 对象`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!ALLOWED_SCHEMA_KEYWORDS.has(key)) violations.push(`${path}.${key}: 不支持的 schema 关键字`);
    }
    const hasType = Object.hasOwn(node, 'type');
    const hasOneOf = Object.hasOwn(node, 'oneOf');
    if (hasType && hasOneOf) violations.push(`${path}: type 与 oneOf 不能同时出现`);
    if (!hasType && !hasOneOf) violations.push(`${path}: 必须有 type 或 oneOf`);
    if (hasOneOf) {
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${path}.oneOf: 至少两个分支`);
      else node.oneOf.forEach((branch, index) => walk(branch, `${path}.oneOf[${index}]`));
    }
    if (hasType) {
      if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(node.type)) {
        violations.push(`${path}.type: 不是受支持的类型`);
      }
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some((name) => typeof name !== 'string')) {
        violations.push(`${path}.required: 必须是字符串数组（DSL 才写 required: true）`);
      } else if (node.properties !== undefined) {
        for (const name of node.required) {
          if (!Object.hasOwn(node.properties, name)) violations.push(`${path}.required: ${name} 不在 properties 里`);
        }
      }
    }
    if (node.properties !== undefined) {
      if (node.type !== 'object') violations.push(`${path}.properties: 只有 object 能带 properties`);
      for (const [name, child] of Object.entries(node.properties)) walk(child, `${path}.properties.${name}`);
    }
    if (node.items !== undefined) {
      if (node.type !== 'array') violations.push(`${path}.items: 只有 array 能带 items`);
      walk(node.items, `${path}.items`);
    }
  };
  walk(schema, 'schema');
  return violations;
}

/**
 * 校验一个值是否符合 schema 子集（等价于 `validateJsonSchemaValue` 的要点）。
 *
 * @param {object} schema - schema。
 * @param {unknown} value - 值。
 * @param {string} [path] - 路径（报错用）。
 * @returns {string[]} 违规列表。
 */
function valueViolations(schema, value, path = 'value') {
  const violations = [];
  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.filter((branch) => valueViolations(branch, value, path).length === 0).length;
    if (matched !== 1) violations.push(`${path}: oneOf 命中 ${matched} 个分支（应为 1）`);
    return violations;
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${path}: 应该是对象`];
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) violations.push(`${path}.${name}: 缺少必需属性`);
    }
    const properties = schema.properties ?? {};
    for (const [name, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) violations.push(...valueViolations(properties[name], child, `${path}.${name}`));
      else if (schema.additionalProperties === false) violations.push(`${path}.${name}: 不允许的额外属性`);
    }
    return violations;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path}: 应该是数组`];
    if (schema.items !== undefined) {
      value.forEach((item, index) => violations.push(...valueViolations(schema.items, item, `${path}[${index}]`)));
    }
    return violations;
  }
  if (schema.type === 'string' && typeof value !== 'string') violations.push(`${path}: 应该是字符串`);
  if (schema.type === 'integer' && !(typeof value === 'number' && Number.isInteger(value))) violations.push(`${path}: 应该是整数`);
  if (schema.type === 'number' && typeof value !== 'number') violations.push(`${path}: 应该是数字`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') violations.push(`${path}: 应该是布尔值`);
  if (schema.type === 'null' && value !== null) violations.push(`${path}: 应该是 null`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) violations.push(`${path}: 不在 enum 里`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) violations.push(`${path}: 不等于 const`);
  return violations;
}

// ── 测试用的替身 ────────────────────────────────────────────────────────────

/**
 * 造一个假的实例管理器。
 *
 * @param {object} [options] - 参数。
 * @param {number} [options.port] - `endpoint.port`。
 * @param {string} [options.wsPath] - `endpoint.wsPath`。
 * @param {string} [options.state] - 状态。
 * @param {string | null} [options.diagnostic] - 诊断。
 * @param {string | null} [options.lastError] - 错误文案。
 * @returns {object} 假实例。
 */
function fakeInstance(options = {}) {
  const state = options.state ?? 'idle';
  return {
    state,
    status: () => ({
      state,
      port: options.port ?? 0,
      wsPath: options.wsPath ?? '',
      pid: 1234,
      crossOrigin: false,
      chromePath: '',
      chromeVersion: '',
      startedAt: null,
      lastError: options.lastError ?? null,
      diagnostic: options.diagnostic ?? null,
      profileDir: '',
    }),
    endpoint: { port: options.port ?? 0, wsPath: options.wsPath ?? '' },
    profileDir: '',
  };
}

/**
 * 行为跟 Cordis 一致的严格上下文：读未 inject 的属性直接抛错。
 *
 * @param {object} services - 可用服务。
 * @param {Set<string>} [allowed] - 已 inject 的服务名。
 * @param {object} [records] - 副作用收集。
 * @returns {object} 伪 ctx。
 */
function makeStrictCtx(services, allowed = new Set(), records = { effects: [] }) {
  const methods = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect(fn) {
      const dispose = fn();
      const wrapped = typeof dispose === 'function' ? dispose : () => {};
      records.effects.push(wrapped);
      return wrapped;
    },
    inject(deps, callback) {
      callback(makeStrictCtx(services, new Set([...allowed, ...deps]), records));
      return () => {};
    },
    get: (name) => services[name],
    provide() {},
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

/** 跑一次工具：返回 `{ value, content }`。 */
async function runTool(definition, args) {
  const value = await definition.execute(args ?? {}, { signal: new AbortController().signal, arguments: args ?? {} });
  return { value, content: definition.output.render(args ?? {}, value) };
}

// ── 页面抽取（固定 HTML） ───────────────────────────────────────────────────

test('snapshot 抽取：编号、可点元素、表单字段、隐藏元素过滤', () => {
  const raw = collectRaw();
  assert.equal(raw.title, '登录 - Example');
  assert.equal(raw.url, FIXED_URL);
  assert.ok(raw.text.includes('请登录'), '正文里应有可见文字');

  const value = buildSnapshotValue(raw);

  // 文档顺序里，第一个可点元素是帮助链接。
  assert.equal(value.clickables[0].index, 1);
  assert.equal(value.clickables[0].selector, '#help-link');
  assert.equal(value.clickables[0].href, 'https://example.com/help');
  assert.equal(value.clickables[0].text, '帮助');

  const submit = value.clickables.find((item) => item.selector === '#submit-btn');
  assert.ok(submit, '按钮要在可点清单里');
  assert.equal(submit.text, '登录');

  const custom = value.clickables.find((item) => item.selector === '#custom');
  assert.equal(custom.via, 'onclick', 'onclick 的元素也算可点');

  const closeX = value.clickables.find((item) => item.selector === '#close-x');
  assert.equal(closeX.via, 'role=button', 'role=button 的元素也算可点');
  assert.equal(closeX.text, '关闭', '没有文字时用 aria-label 兜底');

  // 编号在两类元素之间共享，且严格递增、不重复。
  const indices = [...value.clickables, ...value.fields].map((item) => item.index).sort((a, b) => a - b);
  assert.deepEqual(
    indices,
    indices.map((_value, position) => position + 1),
    '编号必须是 1..N 且不重复',
  );

  const bySelector = new Map(value.fields.map((field) => [field.selector, field]));
  assert.equal(bySelector.get('#user').label, '用户名', 'label[for] 要变成字段名');
  assert.equal(bySelector.get('#user').value, 'alice', '普通文本域不该被掩码');
  assert.equal(bySelector.get('#user').masked, false);
  assert.equal(bySelector.get('#remember').fieldType, 'checkbox');
  assert.equal(bySelector.get('#remember').checked, true);
  assert.equal(bySelector.get('#note').fieldType, 'textarea');
  assert.equal(bySelector.get('#note').value, '备注文字');
  assert.equal(bySelector.get('#lang').fieldType, 'select');
  assert.equal(bySelector.get('#ghost'), undefined, '不可见区域里的输入框不该出现');
});

test('snapshot 掩码：密码、隐藏字段、名字敏感的字段只给占位符', () => {
  const value = buildSnapshotValue(collectRaw());
  const bySelector = new Map(value.fields.map((field) => [field.selector, field]));

  const password = bySelector.get('#pwd');
  assert.equal(password.masked, true, 'password 必须掩码');
  assert.equal(password.value, MASK_TEXT);

  const hidden = bySelector.get('#csrf');
  assert.equal(hidden.fieldType, 'hidden');
  assert.equal(hidden.masked, true, 'type=hidden 必须掩码');
  assert.equal(hidden.value, MASK_TEXT);

  const session = bySelector.get('#sid');
  assert.equal(session.masked, true, '名字里带 session_id 的也要掩码');
  assert.equal(session.value, MASK_TEXT);

  // 关键断言：敏感值不能出现在给模型的任何一处输出里。
  const payload = JSON.stringify(value);
  const rendered = renderSnapshotText(value);
  for (const secret of ['hunter2', 'tok_1234567890', 'sess_abcdef', '不该出现']) {
    assert.ok(!payload.includes(secret), `结构化值里不该有 ${secret}`);
    assert.ok(!rendered.includes(secret), `渲染文本里不该有 ${secret}`);
  }
  assert.ok(rendered.includes(MASK_TEXT), '渲染文本要显示掩码占位符');
});

test('snapshot 截断：正文与元素清单都有上限', () => {
  const raw = collectRaw();
  raw.text = 'x'.repeat(DEFAULT_TEXT_LIMIT + 50);
  const value = buildSnapshotValue(raw, { textLimit: 100, elementLimit: 2 });
  assert.equal(value.text.length, 100);
  assert.equal(value.textTruncated, true);
  assert.equal(value.clickables.length + value.fields.length, 2);
  assert.equal(value.elementsTruncated, true);
});

test('页面侧函数必须自包含（toString 之后能独立执行）', () => {
  // 注入方式是 `(${fn.toString()})()`，所以函数体内不能引用模块作用域的任何东西。
  for (const fn of [collectPageSnapshot, collectPageText]) {
    const rebuilt = runInNewContext(`(${fn.toString()})`, {});
    assert.equal(typeof rebuilt, 'function');
  }
  const dom = miniDom(FIXED_HTML);
  const text = JSON.parse(
    runInNewContext(toPageExpression(collectPageText, ['#login-form']), { document: dom.document, location: dom.location }),
  );
  assert.equal(text.found, true);
  assert.ok(text.text.includes('用户名'), '选择器命中的区域应该取到文字');

  const missing = JSON.parse(
    runInNewContext(toPageExpression(collectPageText, ['#nope']), { document: dom.document, location: dom.location }),
  );
  assert.equal(missing.found, false);
  assert.equal(missing.invalidSelector, false);
});

// ── 工具形状与注册 ──────────────────────────────────────────────────────────

test('工具形状：名字前缀、schema 合法、execute / render 都是函数', () => {
  const tools = createBrowserTools({
    instance: fakeInstance(),
    browserRoot: 'C:\\tmp\\wb-shape',
    readSettings: () => ({}),
    probeChrome: async () => ({ state: 'ok' }),
  });
  const names = tools.definitions.map((definition) => definition.name);
  assert.deepEqual(names, [TOOL_NAMES.snapshot, TOOL_NAMES.getText, TOOL_NAMES.listTabs, TOOL_NAMES.selectTab, TOOL_NAMES.screenshot]);
  for (const definition of tools.definitions) {
    assert.ok(definition.name.startsWith(TOOL_PREFIX), `${definition.name} 应用 ${TOOL_PREFIX} 前缀`);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 10, '描述要够模型判断');
    assert.equal(typeof definition.parameters, 'object');
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.output, 'object');
    assert.equal(typeof definition.output.schema, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
    assert.deepEqual(schemaViolations(definition.parameters), [], `${definition.name} 的 parameters 不合法`);
    assert.deepEqual(schemaViolations(definition.output.schema), [], `${definition.name} 的 output.schema 不合法`);
    assert.equal(definition.output.schema.oneOf.length, 2, '输出要么是成功值要么是结构化错误');
  }
  assert.deepEqual(
    tools.definitions.find((definition) => definition.name === TOOL_NAMES.selectTab).parameters.required,
    ['targetId'],
  );
  assert.equal(tools.definitions.find((definition) => definition.name === TOOL_NAMES.listTabs).parameters.properties !== undefined, true);
  tools.dispose();
});

test('注册：严格 ctx 上不读未 inject 的属性，卸载时全部注销', () => {
  const registered = [];
  const records = { effects: [] };
  const services = {
    tools: {
      register(definition) {
        registered.push(definition);
        let alive = true;
        return () => {
          if (!alive) throw new Error('注销被调了两次');
          alive = false;
          definition.__disposed = true;
        };
      },
    },
    // 故意不提供 attachments：附件服务是可选的。
  };
  const ctx = makeStrictCtx(services, new Set(['tools']), records);
  assert.doesNotThrow(() =>
    registerBrowserTools(ctx, {
      instance: fakeInstance(),
      browserRoot: 'C:\\tmp\\wb-register',
      readSettings: () => ({}),
      probeChrome: async () => ({ state: 'ok' }),
    }),
  );

  assert.equal(registered.length, 5, '五个读类工具都要注册');
  assert.equal(records.effects.length, 1, '要用一个 effect 兜住注销');
  records.effects[0]();
  assert.ok(registered.every((definition) => definition.__disposed === true), '卸载后五个都要注销');
});

test('注册：tools 服务缺失时不抛错（宿主可以只有一半能力）', () => {
  // `tools` 在 inject 里声明过、但服务没挂上：这是真实会遇到的组合。
  const ctx = makeStrictCtx({}, new Set(['tools']));
  let result;
  assert.doesNotThrow(() => {
    result = registerBrowserTools(ctx, {
      instance: fakeInstance(),
      browserRoot: 'C:\\tmp\\wb-no-tools',
      readSettings: () => ({}),
      probeChrome: async () => ({ state: 'ok' }),
    });
  });
  assert.equal(result.registered, 0);
  result.browserTools.dispose();
});

// ── 错误契约：实例没起来时不抛异常 ──────────────────────────────────────────

test('实例未运行且连不上时：五个工具都返回 browser-not-running，而不是抛异常', async () => {
  const tools = createBrowserTools({
    instance: fakeInstance(),
    browserRoot: 'C:\\tmp\\wb-idle',
    readSettings: () => ({}),
    // 探测说 Chrome 装好了，所以结论应该是「没启动」，不是「没装」。
    probeChrome: async () => ({ state: 'ok', version: '153.0.8010.53' }),
  });

  const cases = [
    [TOOL_NAMES.snapshot, {}],
    [TOOL_NAMES.getText, {}],
    [TOOL_NAMES.listTabs, {}],
    [TOOL_NAMES.selectTab, { targetId: 'TAB-1' }],
    [TOOL_NAMES.screenshot, {}],
  ];
  for (const [name, args] of cases) {
    const definition = tools.definitions.find((candidate) => candidate.name === name);
    const { value, content } = await runTool(definition, args);
    assert.equal(value.ok, false, `${name} 应返回结构化错误`);
    assert.equal(value.error.code, ERROR_CODES.notRunning, `${name} 的错误码`);
    assert.equal(typeof value.error.message, 'string');
    assert.ok(value.error.hint.actions.includes('recheck'), `${name} 要带 hint.actions`);
    assert.deepEqual(valueViolations(definition.output.schema, value), [], `${name} 的错误值要符合自己的 schema`);
    assert.equal(content[0].type, 'text');
    assert.ok(content[0].text.includes(ERROR_CODES.notRunning), `${name} 渲染里要有错误码`);
  }
  tools.dispose();
});

test('环境类错误：没装 Chrome / 版本过低 / 启动失败各有各的码', async () => {
  const cases = [
    [
      { state: 'idle' },
      { state: 'missing', version: '', minVersion: '92' },
      ERROR_CODES.chromeNotInstalled,
    ],
    [
      { state: 'idle' },
      { state: 'too-old', version: '80.0.1', minVersion: '92' },
      ERROR_CODES.chromeVersionUnsupported,
    ],
    [
      { state: 'failed', diagnostic: 'chrome-missing', lastError: '未检测到 Chrome。' },
      { state: 'ok' },
      ERROR_CODES.chromeNotInstalled,
    ],
    [
      { state: 'failed', diagnostic: 'chrome-too-old', lastError: '版本过低。' },
      { state: 'ok' },
      ERROR_CODES.chromeVersionUnsupported,
    ],
    [
      { state: 'failed', diagnostic: 'attach-timeout', lastError: '启动失败：连不上 CDP。' },
      { state: 'ok' },
      ERROR_CODES.chromeLaunchFailed,
    ],
  ];

  for (const [instanceOptions, chrome, expected] of cases) {
    const tools = createBrowserTools({
      instance: fakeInstance(instanceOptions),
      browserRoot: 'C:\\tmp\\wb-chrome',
      readSettings: () => ({}),
      probeChrome: async () => chrome,
    });
    const definition = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.listTabs);
    const { value } = await runTool(definition, {});
    assert.equal(value.error.code, expected, `${JSON.stringify(instanceOptions)} / ${chrome.state}`);
    tools.dispose();
  }
});

test('参数校验：手写 definition 没有注册表兜底，坏参数要变成 invalid-argument', async () => {
  const tools = createBrowserTools({
    instance: fakeInstance(),
    browserRoot: 'C:\\tmp\\wb-args',
    readSettings: () => ({}),
    probeChrome: async () => ({ state: 'ok' }),
  });
  const getText = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.getText);
  const selectTab = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.selectTab);
  const screenshot = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.screenshot);

  assert.equal((await runTool(getText, { selector: 42 })).value.error.code, ERROR_CODES.invalidArgument);
  assert.equal((await runTool(getText, { maxChars: 1.5 })).value.error.code, ERROR_CODES.invalidArgument);
  assert.equal((await runTool(getText, { maxChars: 999999 })).value.error.code, ERROR_CODES.invalidArgument);
  assert.equal((await runTool(selectTab, {})).value.error.code, ERROR_CODES.invalidArgument);
  assert.equal((await runTool(selectTab, { targetId: 7 })).value.error.code, ERROR_CODES.invalidArgument);
  assert.equal((await runTool(screenshot, { fullPage: 'yes' })).value.error.code, ERROR_CODES.invalidArgument);
  tools.dispose();
});

// ── 端到端：对着假 Chrome 跑 ────────────────────────────────────────────────

/**
 * 起一个「会执行页面脚本」的假 Chrome：`Runtime.evaluate` 用 node:vm 跑宿主的表达式，
 * 沙箱里放的是 `miniDom(FIXED_HTML)`。
 *
 * @param {object} [options] - 参数。
 * @returns {Promise<{ fake: object, browserRoot: string, cleanup: () => void }>} 句柄。
 */
async function startToolHarness(options = {}) {
  const dom = miniDom(FIXED_HTML);
  const fake = await startFakeChrome({
    ...options,
    onCommand: (message, ctx) => {
      // 先给用例自己的钩子机会（例如「故意不回」），它不管才走默认的页面求值。
      if (typeof options.onCommand === 'function') {
        const custom = options.onCommand(message, ctx);
        if (custom !== undefined) return custom;
      }
      if (message.method === 'Runtime.evaluate') {
        const evaluated = runInNewContext(message.params.expression, { document: dom.document, location: dom.location });
        return { result: { result: { type: 'string', value: evaluated } } };
      }
      return undefined;
    },
  });
  const browserRoot = mkdtempSync(join(tmpdir(), 'wb-tools-'));
  return {
    fake,
    browserRoot,
    cleanup: async () => {
      await fake.close();
      rmSync(browserRoot, { recursive: true, force: true });
    },
  };
}

/**
 * 造一套连着假 Chrome 的工具。
 *
 * @param {object} harness - `startToolHarness()` 的结果。
 * @param {object} [options] - 参数。
 * @returns {object} `createBrowserTools()` 的结果。
 */
function toolsForHarness(harness, options = {}) {
  return createBrowserTools({
    instance: fakeInstance({ port: harness.fake.port, wsPath: harness.fake.wsPath, state: 'running' }),
    browserRoot: harness.browserRoot,
    readSettings: () => ({}),
    probeChrome: async () => ({ state: 'ok' }),
    pageDriver: options.pageDriver,
    commandTimeoutMs: options.commandTimeoutMs ?? 3000,
    warn: () => {},
    info: () => {},
  });
}

test('端到端：snapshot 拿到标题、正文、编号元素与掩码字段', async (t) => {
  const harness = await startToolHarness();
  const tools = toolsForHarness(harness);
  t.after(async () => {
    tools.dispose();
    await harness.cleanup();
  });

  const definition = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.snapshot);
  const { value, content } = await runTool(definition, {});

  assert.deepEqual(valueViolations(definition.output.schema, value), []);
  assert.equal(value.ok, true);
  assert.equal(value.targetId, 'TAB-1');
  assert.equal(value.url, FIXED_URL);
  assert.equal(value.title, '登录 - Example');
  assert.ok(value.text.includes('请登录'));
  assert.equal(value.clickables[0].index, 1);
  assert.ok(value.fields.some((field) => field.masked === true && field.value === MASK_TEXT));

  const rendered = content[0].text;
  assert.ok(rendered.includes(UNTRUSTED_OPEN) && rendered.includes('</UNTRUSTED_PAGE_CONTENT>'), '页面内容必须包起来');
  assert.ok(!rendered.includes('hunter2'), '渲染文本里不能出现密码');
  assert.ok(rendered.includes('可点元素'), '渲染里要有清单');
});

test('页面驱动的 snapshot 会丢掉 schema 没声明的字段', async (t) => {
  const harness = await startToolHarness();
  const tools = toolsForHarness(harness, {
    pageDriver: {
      async snapshot() {
        return {
          ok: true,
          targetId: 'TAB-1',
          url: 'https://example.com',
          title: '例',
          text: '正文',
          textTruncated: false,
          elementsTruncated: false,
          clickables: [],
          fields: [],
          unchanged: false,
          detail: '不该出现',
        };
      },
    },
  });
  t.after(async () => {
    tools.dispose();
    await harness.cleanup();
  });

  const definition = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.snapshot);
  const { value } = await runTool(definition, {});
  assert.deepEqual(valueViolations(definition.output.schema, value), []);
  assert.equal(value.text, '正文');
  assert.equal(Object.hasOwn(value, 'unchanged'), false);
  assert.equal(Object.hasOwn(value, 'detail'), false);
});

test('端到端：get_text 取区域文字，选择器不命中给结构化错误', async (t) => {
  const harness = await startToolHarness();
  const tools = toolsForHarness(harness);
  t.after(async () => {
    tools.dispose();
    await harness.cleanup();
  });

  const definition = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.getText);
  const hit = await runTool(definition, { selector: '#login-form' });
  assert.deepEqual(valueViolations(definition.output.schema, hit.value), []);
  assert.equal(hit.value.ok, true);
  assert.equal(hit.value.selector, '#login-form');
  assert.ok(hit.value.text.includes('用户名'));
  assert.ok(hit.content[0].text.includes(UNTRUSTED_OPEN));

  const miss = await runTool(definition, { selector: '#nope' });
  assert.equal(miss.value.ok, false);
  assert.equal(miss.value.error.code, ERROR_CODES.selectorNotFound);
  assert.deepEqual(valueViolations(definition.output.schema, miss.value), []);
});

test('端到端：list_tabs 过滤内部 target，select_tab 改默认标签且不抢焦点', async (t) => {
  const harness = await startToolHarness();
  const tools = toolsForHarness(harness);
  t.after(async () => {
    tools.dispose();
    await harness.cleanup();
  });

  const listTabs = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.listTabs);
  const selectTab = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.selectTab);

  const before = await runTool(listTabs, {});
  assert.deepEqual(valueViolations(listTabs.output.schema, before.value), []);
  assert.equal(before.value.count, 2, 'devtools:// 那张不算标签页');
  assert.deepEqual(before.value.tabs.map((tab) => tab.targetId), ['TAB-1', 'TAB-2']);
  assert.equal(before.value.selectedTargetId, 'TAB-1');
  assert.ok(before.content[0].text.includes(UNTRUSTED_OPEN), '标题与网址要包起来');

  const selected = await runTool(selectTab, { targetId: 'TAB-2' });
  assert.deepEqual(valueViolations(selectTab.output.schema, selected.value), []);
  assert.equal(selected.value.ok, true);
  assert.equal(selected.value.targetId, 'TAB-2');
  assert.equal(selected.value.title, '文档');
  assert.ok(selected.content[0].text.includes('没有抢窗口焦点'), '文案要写明不抢焦点');

  const after = await runTool(listTabs, {});
  assert.equal(after.value.selectedTargetId, 'TAB-2', '默认标签应该换了');
  assert.equal(after.value.tabs.find((tab) => tab.targetId === 'TAB-2').selected, true);

  const missing = await runTool(selectTab, { targetId: 'TAB-404' });
  assert.equal(missing.value.error.code, ERROR_CODES.targetNotFound);
});

test('端到端：screenshot 落到 <browserRoot>/shots 并返回路径与尺寸', async (t) => {
  const harness = await startToolHarness();
  const tools = toolsForHarness(harness);
  t.after(async () => {
    tools.dispose();
    await harness.cleanup();
  });

  const definition = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.screenshot);
  const { value, content } = await runTool(definition, { fullPage: true });

  assert.deepEqual(valueViolations(definition.output.schema, value), []);
  assert.equal(value.ok, true);
  assert.ok(value.path.startsWith(join(harness.browserRoot, 'shots')), `截图应落在 shots 下：${value.path}`);
  assert.equal(value.width, 1);
  assert.equal(value.height, 1);
  assert.equal(value.bytes, Buffer.from(TINY_PNG_BASE64, 'base64').length);
  assert.equal(value.fullPage, true);
  assert.equal('attachment' in value, false, '没有附件服务时不该有图片块');
  assert.equal(content.length, 1);
  assert.ok(content[0].text.includes(value.path));
  assert.ok(content[0].text.includes(UNTRUSTED_OPEN));

  const capture = harness.fake.state.commands.find((entry) => entry.method === 'Page.captureScreenshot');
  assert.equal(capture.params.captureBeyondViewport, true, 'fullPage 应映射到 captureBeyondViewport');
  assert.equal(capture.sessionId, 'S-TAB-1', '截图要发在默认标签的会话里');
});

test('端到端：有附件服务时截图额外给一个图片块', async (t) => {
  const harness = await startToolHarness();
  const tools = toolsForHarness(harness);
  const saved = [];
  tools.setAttachments({
    async saveImage(input) {
      saved.push(input);
      return { attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, name: input.name };
    },
  });
  t.after(async () => {
    tools.dispose();
    await harness.cleanup();
  });

  const definition = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.screenshot);
  const { value, content } = await runTool(definition, {});

  assert.deepEqual(valueViolations(definition.output.schema, value), []);
  assert.equal(saved.length, 1);
  assert.equal(value.attachment.attachmentId, 'att-1');
  assert.equal(content.length, 2);
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].attachment.attachmentId, 'att-1');
});

test('端到端：附件入库失败不影响落盘结果', async (t) => {
  const harness = await startToolHarness();
  const tools = toolsForHarness(harness);
  tools.setAttachments({
    async saveImage() {
      throw new Error('图片太大');
    },
  });
  t.after(async () => {
    tools.dispose();
    await harness.cleanup();
  });

  const definition = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.screenshot);
  const { value, content } = await runTool(definition, {});
  assert.equal(value.ok, true);
  assert.equal('attachment' in value, false);
  assert.equal(content.length, 1);
});

test('端到端：截图命令失败 → screenshot-failed；命令超时 → cdp-failed', async (t) => {
  const failing = await startToolHarness({
    onCommand: (message) => {
      if (message.method === 'Page.captureScreenshot') return { error: { code: -32000, message: '页面正在加载' } };
      return undefined;
    },
  });
  const failingTools = toolsForHarness(failing);
  t.after(async () => {
    failingTools.dispose();
    await failing.cleanup();
  });
  const definition = failingTools.definitions.find((candidate) => candidate.name === TOOL_NAMES.screenshot);
  const failed = await runTool(definition, {});
  assert.equal(failed.value.error.code, ERROR_CODES.screenshotFailed);
  assert.ok(failed.value.error.message.includes('页面正在加载'));
  assert.deepEqual(valueViolations(definition.output.schema, failed.value), []);

  const silent = await startToolHarness({
    onCommand: (message) => (message.method === 'Runtime.evaluate' ? { silent: true } : undefined),
  });
  const silentTools = toolsForHarness(silent, { commandTimeoutMs: 80 });
  t.after(async () => {
    silentTools.dispose();
    await silent.cleanup();
  });
  const snapshot = silentTools.definitions.find((candidate) => candidate.name === TOOL_NAMES.snapshot);
  const timedOut = await runTool(snapshot, {});
  assert.equal(timedOut.value.error.code, ERROR_CODES.cdpFailed);
  assert.ok(timedOut.value.error.message.includes('Runtime.evaluate'), '超时消息要带命令名');
});

test('端到端：浏览器中途被杀 → 在途命令报 browser-not-running', async (t) => {
  const harness = await startToolHarness({
    onCommand: (message) => (message.method === 'Runtime.evaluate' ? { silent: true } : undefined),
  });
  const tools = toolsForHarness(harness, { commandTimeoutMs: 3000 });
  t.after(async () => {
    tools.dispose();
    await harness.cleanup();
  });

  const definition = tools.definitions.find((candidate) => candidate.name === TOOL_NAMES.snapshot);
  const pending = runTool(definition, {});
  setTimeout(() => harness.fake.dropConnections(), 60);
  const { value } = await pending;
  assert.equal(value.ok, false);
  assert.equal(value.error.code, ERROR_CODES.notRunning, '断线要归到「浏览器没在跑」');
  assert.deepEqual(valueViolations(definition.output.schema, value), []);
});

// ── 零碎 ────────────────────────────────────────────────────────────────────

test('pngSize：从 PNG 头读出宽高，非 PNG 给 0', () => {
  const png = Buffer.from(TINY_PNG_BASE64, 'base64');
  assert.deepEqual(pngSize(png), { width: 1, height: 1 });
  assert.deepEqual(pngSize(Buffer.from('not a png at all')), { width: 0, height: 0 });
});

test('wrapUntrusted：页面内容一律带上不可信标记', () => {
  const wrapped = wrapUntrusted('标题：x');
  assert.ok(wrapped.startsWith(UNTRUSTED_OPEN));
  assert.ok(wrapped.endsWith('</UNTRUSTED_PAGE_CONTENT>'));
});
