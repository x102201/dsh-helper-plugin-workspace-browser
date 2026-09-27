/**
 * 页面读写：连到已经打开的 Chrome，用无障碍树编号操作，用可见正文供总结。
 *
 * 不启动浏览器，不改视口，不把窗口带到前台。截图不参与认元素。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/page-driver
 */

import { PLAYWRIGHT_MISSING } from './playwright-runtime.js';

/** 无障碍树里会编号的角色。正文节点不编号。 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'option',
  'slider',
  'spinbutton',
]);

/** 这些工具走页面驱动；开标签、关标签、截图仍走 CDP。 */
export const PAGE_DRIVER_TOOLS = new Set([
  'click',
  'type',
  'press',
  'scroll',
  'navigate',
  'back',
  'forward',
  'reload',
  'wait',
  'evaluate',
]);

/**
 * 把 aria 快照文本编成可操作编号。
 *
 * @param {string} aria - `locator.ariaSnapshot()` 的文本。
 * @returns {Array<{ ref: string, role: string, name: string, nth: number }>} 编号表。
 */
export function parseAriaRefs(aria) {
  const counts = new Map();
  const refs = [];
  const lines = String(aria ?? '').split(/\r?\n/u);
  for (const line of lines) {
    const match = /^\s*-\s+([a-zA-Z]+)(?:\s+"([^"]*)")?/u.exec(line);
    if (!match) continue;
    const role = match[1].toLowerCase();
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const name = match[2] ?? '';
    const key = `${role}\n${name}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    refs.push({ ref: `e${refs.length + 1}`, role, name, nth });
  }
  return refs;
}

/**
 * 把模型给的编号收成 `eN`。
 *
 * @param {unknown} raw - ref 或 index。
 * @returns {string} 编号；认不出为空串。
 */
export function normalizeRef(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return `e${raw}`;
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (/^e\d+$/iu.test(text)) return `e${text.slice(1)}`;
  if (/^\d+$/u.test(text)) return `e${text}`;
  return '';
}

/**
 * 正文和控件都空、或是读不了的地址时，说明原因。有正文或有控件则返回空串。
 *
 * @param {object} input - 页面情况。
 * @param {string} [input.url] - 网址。
 * @param {string} [input.text] - 可见正文。
 * @param {number} [input.refCount] - 可操作编号数量。
 * @returns {string} 原因；可以阅读时为空串。
 */
export function emptyReason({ url = '', text = '', refCount = 0 } = {}) {
  const href = String(url);
  if (/^(chrome|edge|devtools|chrome-extension):/iu.test(href)) {
    return '这是浏览器内部页，没有可阅读的正文。';
  }
  if (/\.pdf($|\?)/iu.test(href)) {
    return '这是 PDF，快照读不到正文。请改用 screenshot。';
  }
  if (String(text).trim() === '' && refCount === 0) {
    return '没有读到正文，也没有可操作控件。页面可能还在渲染，或内容在 canvas 里。可先 wait，仍为空再 screenshot。';
  }
  return '';
}

/**
 * 两份快照是否一样（正文 + 编号角色和名字）。
 *
 * @param {object | null} previous - 上一份。
 * @param {object} next - 这一份。
 * @returns {boolean} 一样为 true。
 */
export function snapshotUnchanged(previous, next) {
  if (!previous) return false;
  const sig = (snap) => {
    const refs = Array.isArray(snap?.refs) ? snap.refs : [];
    return `${snap?.text ?? ''}\n${refs.map((item) => `${item.role}:${item.name}`).join('|')}`;
  };
  return sig(previous) === sig(next);
}

/**
 * 造出页面驱动。
 *
 * @param {object} options - 参数。
 * @param {() => { port?: number }} options.getEndpoint - 当前调试端口。
 * @param {(options?: object) => Promise<object | null>} [options.loadPlaywright] - 加载 playwright-core。
 * @param {(targetId: string) => Promise<object | null>} [options.pageFor] - 测试注入的页面。
 * @param {(message: string) => void} [options.info] - 日志。
 * @param {(message: string, error?: unknown) => void} [options.warn] - 日志。
 * @returns {object} 驱动。
 */
export function createPageDriver(options = {}) {
  const loadPlaywright = options.loadPlaywright;
  const info = options.info ?? (() => {});
  const warn = options.warn ?? (() => {});
  /** @type {Map<string, Array<object>>} */
  const refsByTarget = new Map();
  /** @type {Map<string, object>} */
  const lastByTarget = new Map();
  /** @type {object | null} */
  let browser = null;
  let connectedPort = 0;

  function missing() {
    return {
      error: {
        code: PLAYWRIGHT_MISSING,
        message: '页面读写需要 playwright-core，但还没有装上。浏览器和画面仍可使用。',
      },
    };
  }

  async function disconnect() {
    const current = browser;
    browser = null;
    connectedPort = 0;
    if (!current || typeof current.close !== 'function') return;
    try {
      await current.close();
    } catch (error) {
      warn('断开页面驱动失败', error);
    }
  }

  async function connect() {
    const port = options.getEndpoint?.()?.port;
    if (!port) {
      return { error: { code: 'browser-not-running', message: '这个工作区的浏览器还没启动。' } };
    }
    if (browser && connectedPort === port) return { browser };
    await disconnect();
    if (typeof options.pageFor === 'function') {
      connectedPort = port;
      browser = { contexts: () => [{ pages: () => [] }] };
      return { browser };
    }
    if (typeof loadPlaywright !== 'function') return missing();
    let playwright;
    try {
      playwright = await loadPlaywright();
    } catch (error) {
      warn('加载 playwright-core 失败', error);
      return missing();
    }
    if (!playwright?.chromium?.connectOverCDP) return missing();
    try {
      browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      connectedPort = port;
      info(`页面驱动已连上端口 ${port}`);
      return { browser };
    } catch (error) {
      warn('connectOverCDP 失败', error);
      return { error: { code: 'cdp-failed', message: error instanceof Error ? error.message : String(error) } };
    }
  }

  async function pageOf(targetId) {
    const connected = await connect();
    if (connected.error) return connected;
    if (typeof options.pageFor === 'function') {
      const page = await options.pageFor(targetId);
      if (!page) return { error: { code: 'target-not-found', message: '没有找到要操作的标签。' } };
      return { page };
    }
    const context = connected.browser.contexts?.()?.[0];
    const pages = context?.pages?.() ?? [];
    if (pages.length === 0) return { error: { code: 'no-target', message: '浏览器里还没有页面。' } };
    if (!targetId) return { page: pages[0] };
    for (const page of pages) {
      try {
        const session = await context.newCDPSession(page);
        const infoResult = await session.send('Target.getTargetInfo');
        const id = infoResult?.targetInfo?.targetId ?? '';
        if (typeof session.detach === 'function') await session.detach();
        if (id === targetId) return { page };
      } catch {
        // 对不上就看下一张。
      }
    }
    return { error: { code: 'target-not-found', message: `没有 targetId 为 ${targetId} 的页面。` } };
  }

  async function readText(page) {
    const main = page.locator('main, article');
    const count = typeof main.count === 'function' ? await main.count() : 0;
    if (count > 0) {
      const text = await main.first().innerText();
      if (typeof text === 'string' && text.trim() !== '') return text;
    }
    const body = await page.locator('body').innerText();
    return typeof body === 'string' ? body : '';
  }

  async function takeSnapshot(page, targetId, limits = {}) {
    const url = typeof page.url === 'function' ? page.url() : '';
    const title = typeof page.title === 'function' ? await page.title() : '';
    let aria = '';
    try {
      aria = await page.locator('body').ariaSnapshot();
    } catch (error) {
      warn('读取无障碍树失败', error);
    }
    const refs = parseAriaRefs(typeof aria === 'string' ? aria : '');
    const fullText = await readText(page);
    const maxChars = limits.maxChars ?? 12000;
    const maxElements = limits.maxElements ?? 200;
    const reason = emptyReason({ url, text: fullText, refCount: refs.length });
    if (reason !== '') {
      return { error: { code: 'page-empty', message: reason } };
    }
    const text = fullText.length > maxChars ? fullText.slice(0, maxChars) : fullText;
    const listed = refs.slice(0, maxElements);
    const snap = {
      targetId,
      url,
      title: typeof title === 'string' ? title : '',
      text,
      textTruncated: fullText.length > maxChars,
      elementsTruncated: refs.length > listed.length,
      refs: listed,
      aria: typeof aria === 'string' ? aria : '',
    };
    refsByTarget.set(targetId, listed);
    return { snap };
  }

  function renderRefs(refs) {
    return refs
      .map((item) => `[${item.ref}] ${item.role}${item.name === '' ? '' : ` "${item.name}"`}`)
      .join('\n');
  }

  function pack(targetId, snap, extra = {}) {
    const previous = lastByTarget.get(targetId) ?? null;
    const unchanged = snapshotUnchanged(previous, snap);
    lastByTarget.set(targetId, snap);
    const body = unchanged ? '（相对上一份快照无变化）' : snap.text;
    const list = renderRefs(snap.refs);
    return {
      ok: true,
      targetId,
      url: snap.url,
      title: snap.title,
      text: body,
      textTruncated: snap.textTruncated,
      elementsTruncated: snap.elementsTruncated,
      clickables: snap.refs.map((item) => ({
        index: Number(item.ref.slice(1)),
        kind: 'clickable',
        tag: item.role,
        text: item.name,
        href: '',
        selector: '',
        disabled: false,
        via: 'aria',
      })),
      fields: [],
      unchanged,
      detail: [extra.detail, list === '' ? '' : list, unchanged ? '相对上一份快照无变化。' : ''].filter(Boolean).join('\n'),
      ...extra.fields,
    };
  }

  function locatorFor(page, item) {
    const located = page.getByRole(item.role, item.name === '' ? {} : { name: item.name });
    return typeof located.nth === 'function' ? located.nth(item.nth) : located;
  }

  async function withPage(targetId, run) {
    const found = await pageOf(targetId);
    if (found.error) return found;
    try {
      return await run(found.page);
    } catch (error) {
      return { error: { code: 'cdp-failed', message: error instanceof Error ? error.message : String(error) } };
    }
  }

  return {
    disconnect,
    async snapshot({ targetId = '', maxChars = 12000, maxElements = 200 } = {}) {
      return withPage(targetId, async (page) => {
        const taken = await takeSnapshot(page, targetId, { maxChars, maxElements });
        if (taken.error) return taken;
        return pack(targetId, taken.snap);
      });
    },
    async getText({ targetId = '', maxChars = 12000, selector = '' } = {}) {
      return withPage(targetId, async (page) => {
        let full = '';
        if (selector !== '') {
          const node = page.locator(selector);
          const count = typeof node.count === 'function' ? await node.count() : 0;
          if (count === 0) {
            return { error: { code: 'selector-not-found', message: `没有匹配 ${selector} 的区域。` } };
          }
          full = await node.first().innerText();
        } else {
          full = await readText(page);
        }
        const url = typeof page.url === 'function' ? page.url() : '';
        const title = typeof page.title === 'function' ? await page.title() : '';
        const reason = emptyReason({ url, text: full, refCount: selector === '' ? 0 : 1 });
        if (selector === '' && reason !== '') return { error: { code: 'page-empty', message: reason } };
        const text = String(full ?? '');
        return {
          ok: true,
          targetId,
          selector,
          url,
          title: typeof title === 'string' ? title : '',
          text: text.length > maxChars ? text.slice(0, maxChars) : text,
          textTruncated: text.length > maxChars,
        };
      });
    },
    async act(name, { args = {}, targetId = '' } = {}) {
      const ref = normalizeRef(args.ref ?? args.index);
      return withPage(targetId, async (page) => {
        if (name === 'click' || name === 'type') {
          const table = refsByTarget.get(targetId) ?? [];
          const item = table.find((entry) => entry.ref === ref);
          if (!item) {
            const taken = await takeSnapshot(page, targetId, {});
            const hint = taken.snap ? `\n${renderRefs(taken.snap.refs)}` : '';
            return { error: { code: 'ref-stale', message: `编号 ${ref || '（空）'} 不在当前快照里。请用新快照里的编号。${hint}` } };
          }
          const locator = locatorFor(page, item);
          if (typeof locator.scrollIntoViewIfNeeded === 'function') await locator.scrollIntoViewIfNeeded();
          if (name === 'click') {
            await locator.click();
          } else {
            if (args.clear === true && typeof locator.fill === 'function') await locator.fill('');
            if (typeof args.text === 'string' && args.text !== '') await locator.fill(args.text);
            if (args.submit === true) await page.keyboard.press('Enter');
          }
        } else if (name === 'press') {
          const key = typeof args.key === 'string' ? args.key : '';
          if (key === '') return { error: { code: 'invalid-argument', message: '必须给出 key。' } };
          const repeat = Number.isInteger(args.repeat) ? args.repeat : 1;
          for (let index = 0; index < repeat; index += 1) await page.keyboard.press(key);
        } else if (name === 'scroll') {
          const direction = args.direction;
          const amount = Number.isInteger(args.amount) ? args.amount : 400;
          const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
          const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
          await page.mouse.wheel(deltaX, deltaY);
        } else if (name === 'navigate') {
          await page.goto(String(args.url ?? ''), { waitUntil: 'domcontentloaded' });
        } else if (name === 'back') {
          await page.goBack();
        } else if (name === 'forward') {
          await page.goForward();
        } else if (name === 'reload') {
          await page.reload();
        } else if (name === 'wait') {
          const timeoutMs = Number.isInteger(args.timeoutMs) ? args.timeoutMs : 5000;
          const started = Date.now();
          let settled = false;
          let previous = null;
          while (Date.now() - started < timeoutMs) {
            const taken = await takeSnapshot(page, targetId, {});
            if (taken.error && taken.error.code === 'page-empty') {
              await new Promise((resolve) => { setTimeout(resolve, 200); });
              continue;
            }
            if (taken.snap && previous && snapshotUnchanged(previous, taken.snap)) {
              settled = true;
              break;
            }
            previous = taken.snap ?? previous;
            await new Promise((resolve) => { setTimeout(resolve, 200); });
          }
          const taken = await takeSnapshot(page, targetId, {});
          if (taken.error) return { ...taken, settled, waitedMs: Date.now() - started };
          return pack(targetId, taken.snap, { fields: { settled, waitedMs: Date.now() - started, readyState: settled ? 'stable' : 'timeout' } });
        } else if (name === 'evaluate') {
          const value = await page.evaluate(String(args.expression ?? ''));
          return { ok: true, targetId, value };
        } else {
          return { error: { code: 'invalid-argument', message: `页面驱动不处理 ${name}。` } };
        }
        const taken = await takeSnapshot(page, targetId, {});
        if (taken.error) return taken;
        return pack(targetId, taken.snap, { detail: `${name} 完成。`, fields: name === 'type' ? { typedChars: String(args.text ?? '').length } : {} });
      });
    },
  };
}
