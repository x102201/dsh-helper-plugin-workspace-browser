/**
 * 页面驱动：正文、编号、空页面、编号失效。不启动 Chrome。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPageDriver, emptyReason, normalizeRef, parseAriaRefs, snapshotUnchanged } from '../lib/page-driver.js';
import { PLAYWRIGHT_MISSING } from '../lib/playwright-runtime.js';

test('无障碍树只给可操作节点编号', () => {
  const refs = parseAriaRefs('- heading "标题"\n- button "登录"\n- textbox "邮箱"\n- button "登录"');
  assert.deepEqual(refs.map((item) => item.ref), ['e1', 'e2', 'e3']);
  assert.equal(refs[0].name, '登录');
  assert.equal(refs[2].nth, 1);
  assert.equal(normalizeRef('2'), 'e2');
  assert.equal(normalizeRef('e2'), 'e2');
});

test('空正文给出原因，内部页和 PDF 也给出原因', () => {
  assert.match(emptyReason({ url: 'https://example.com', text: '', refCount: 0 }), /canvas/);
  assert.equal(emptyReason({ url: 'https://example.com', text: '有字', refCount: 0 }), '');
  assert.match(emptyReason({ url: 'chrome://settings', text: '', refCount: 0 }), /内部页/);
  assert.match(emptyReason({ url: 'https://example.com/a.pdf', text: '', refCount: 3 }), /PDF/);
});

test('快照没变时认得出', () => {
  const snap = { text: '正文', refs: [{ role: 'button', name: '登录' }] };
  assert.equal(snapshotUnchanged(snap, snap), true);
  assert.equal(snapshotUnchanged(snap, { text: '另一篇', refs: snap.refs }), false);
});

function fakePage(overrides = {}) {
  const log = [];
  const page = {
    url: () => overrides.url ?? 'https://example.com/post',
    title: async () => overrides.title ?? '文章',
    locator() {
      const node = {
        async count() {
          return overrides.empty === true ? 0 : 1;
        },
        first() {
          return node;
        },
        async innerText() {
          return overrides.text ?? '这是正文';
        },
        async ariaSnapshot() {
          return overrides.aria ?? '- button "登录"\n- textbox "邮箱"';
        },
      };
      return node;
    },
    getByRole() {
      const locator = {
        nth() {
          return locator;
        },
        async scrollIntoViewIfNeeded() {},
        async click() {
          log.push('click');
        },
        async fill(text) {
          log.push(`fill:${text}`);
        },
      };
      return locator;
    },
    keyboard: { async press(key) { log.push(`key:${key}`); } },
    mouse: { async wheel() { log.push('wheel'); } },
    async goto() { log.push('goto'); },
    async goBack() {},
    async goForward() {},
    async reload() {},
    async evaluate(expression) { return expression; },
  };
  return { page, log };
}

test('快照先有正文，点击只认当前编号', async () => {
  const { page, log } = fakePage();
  const driver = createPageDriver({
    getEndpoint: () => ({ port: 9 }),
    pageFor: async () => page,
  });
  const shot = await driver.snapshot({ targetId: 't1' });
  assert.equal(shot.ok, true);
  assert.match(shot.text, /这是正文/);
  assert.equal(shot.clickables[0].index, 1);
  const clicked = await driver.act('click', { targetId: 't1', args: { ref: 'e1' } });
  assert.equal(clicked.ok, true);
  assert.deepEqual(log, ['click']);
  const stale = await driver.act('click', { targetId: 't1', args: { ref: 'e99' } });
  assert.equal(stale.error.code, 'ref-stale');
});

test('evaluate 返回 schema 需要的字符串结果', async () => {
  const { page } = fakePage();
  const driver = createPageDriver({
    getEndpoint: () => ({ port: 9 }),
    pageFor: async () => page,
  });
  const result = await driver.act('evaluate', { targetId: 't1', args: { expression: 'document.title' } });
  assert.equal(result.ok, true);
  assert.equal(result.value, 'document.title');
  assert.equal(result.valueType, 'string');
  assert.equal(result.truncated, false);
  assert.equal(result.url, 'https://example.com/post');
  assert.equal(result.title, '文章');
});

test('空页面不报成功', async () => {
  const { page } = fakePage({ empty: true, text: '', aria: '', url: 'https://example.com' });
  const driver = createPageDriver({
    getEndpoint: () => ({ port: 9 }),
    pageFor: async () => page,
  });
  const shot = await driver.snapshot({ targetId: 't1' });
  assert.equal(shot.ok, undefined);
  assert.equal(shot.error.code, 'page-empty');
});

test('没有 playwright-core 时返回 playwright-missing，且不要求浏览器已启动之外的安装', async () => {
  const driver = createPageDriver({
    getEndpoint: () => ({ port: 9 }),
    loadPlaywright: async () => null,
  });
  const shot = await driver.snapshot({ targetId: 't1' });
  assert.equal(shot.error.code, PLAYWRIGHT_MISSING);
});
