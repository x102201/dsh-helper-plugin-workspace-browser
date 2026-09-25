/**
 * Windows 前台唤起：非 Windows 直接放行；无 PID 时失败。
 *
 * 跑法：`node test/win-focus.test.mjs`
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bringProcessWindowsToFront, restoreChromeWindowViaCdp } from '../lib/win-focus.js';

test('非 Windows 或空 PID：bringProcessWindowsToFront 行为稳定', async () => {
  const empty = await bringProcessWindowsToFront([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'no-pids');

  if (process.platform !== 'win32') {
    const skipped = await bringProcessWindowsToFront([process.pid]);
    assert.equal(skipped.ok, true);
    assert.equal(skipped.reason, 'not-windows');
  }
});

test('restoreChromeWindowViaCdp：空客户端不抛', async () => {
  await restoreChromeWindowViaCdp(null, 'TAB-1');
  await restoreChromeWindowViaCdp({}, '');
  await restoreChromeWindowViaCdp(
    {
      isConnected: () => false,
      connect: async () => {},
    },
    'TAB-1',
  );
});

test('restoreChromeWindowViaCdp：会调 getWindowForTarget / setWindowBounds / bringToFront', async () => {
  const calls = [];
  const client = {
    isConnected: () => true,
    connect: async () => {},
    commandBrowser: async (method, params) => {
      calls.push({ method, params });
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      return {};
    },
    command: async (targetId, method) => {
      calls.push({ targetId, method });
      return {};
    },
  };
  await restoreChromeWindowViaCdp(client, 'TAB-9');
  assert.ok(calls.some((entry) => entry.method === 'Browser.getWindowForTarget'));
  assert.ok(
    calls.some(
      (entry) =>
        entry.method === 'Browser.setWindowBounds'
        && entry.params?.windowId === 7
        && entry.params?.bounds?.windowState === 'normal',
    ),
  );
  assert.ok(calls.some((entry) => entry.method === 'Page.bringToFront' && entry.targetId === 'TAB-9'));
});
