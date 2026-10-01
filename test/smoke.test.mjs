/**
 * P0 冒烟测试：纯逻辑部分（不启动 Chrome、不碰 DSH）。
 *
 * 跑法：`node --test`（`package.json` 的 `npm test`）。
 *
 * 覆盖的是「错了会静默毁掉状态」的那几处：工作区键的稳定性、`endpoint.json`
 * 往返、`DevToolsActivePort` 解析、设置默认值与校验、页面 target 过滤。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { compareVersions, MIN_CHROME_VERSION } from '../lib/chrome.js';
import { createSettingsSchema, derefVolatile, FIELD_DEFAULTS, normalizeSettings } from '../lib/settings.js';
import { pageTargets } from '../lib/instance.js';
import {
  appendToWorkspaceGitignore,
  browserRootOf,
  devToolsActivePortPathOf,
  endpointPathOf,
  migrateLegacyRoot,
  profileDirOf,
  readDevToolsActivePort,
  readEndpoint,
  readWorkspacePathFromStorage,
  UNGROUPED_KEY,
  workspaceKeyOf,
  writeEndpoint,
} from '../lib/paths.js';

test('工作区键：稳定、可读、同名不同路径不撞车', () => {
  const a1 = workspaceKeyOf('C:\\work\\alpha');
  const a2 = workspaceKeyOf('C:\\work\\alpha\\');
  assert.equal(a1, a2, '尾分隔符不该改变键');
  assert.ok(a1.startsWith('alpha-'), `键应以目录名开头：${a1}`);
  assert.notEqual(workspaceKeyOf('C:\\work\\alpha'), workspaceKeyOf('C:\\play\\alpha'), '同名不同路径必须分开');
});

test('未分组会话落到 _ungrouped', () => {
  assert.equal(workspaceKeyOf(null), UNGROUPED_KEY);
  assert.equal(workspaceKeyOf(''), UNGROUPED_KEY);
  const root = browserRootOf({ workspaceKey: workspaceKeyOf(null), dshHome: 'C:\\dsh' });
  assert.equal(root, join('C:\\dsh', 'workspace-browser', '_ungrouped'));
});

test('有工作区时数据目录落在工作区里的隐藏子目录', () => {
  const root = browserRootOf({ workspacePath: 'C:\\work\\alpha', workspaceKey: 'alpha-12345678', dshHome: 'C:\\dsh' });
  assert.equal(root, join('C:\\work\\alpha', '.workspace-browser'));
  // 未分组时仍退回 DSH_HOME（没有工作区可放）。
  assert.equal(
    browserRootOf({ workspacePath: '', workspaceKey: 'x-1', dshHome: 'C:\\dsh' }),
    join('C:\\dsh', 'workspace-browser', 'x-1'),
  );
});

test('工作区路径能从 storages/workspace.json 同步读到（绕开服务 init 时序）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-home-'));
  try {
    mkdirSync(join(home, 'storages'), { recursive: true });
    writeFileSync(
      join(home, 'storages', 'workspace.json'),
      JSON.stringify({
        global: { initialized: true, workspaceIds: ['w1'] },
        tables: { workspaces: { w1: { path: 'C:\\Users\\x\\Desktop\\Planner1', title: 'Planner1' } } },
      }),
    );
    assert.equal(readWorkspacePathFromStorage(home), 'C:\\Users\\x\\Desktop\\Planner1');
    // 没有这个文件时安静地返回 null。
    assert.equal(readWorkspacePathFromStorage(join(home, 'nope')), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('工作区已有 .gitignore 时追加一行，且幂等；没有就不替用户建', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-git-'));
  const ws2 = mkdtempSync(join(tmpdir(), 'wb-git2-'));
  try {
    writeFileSync(join(ws, '.gitignore'), 'node_modules/\n');
    assert.equal(appendToWorkspaceGitignore(ws), true, '应追加');
    assert.equal(readFileSync(join(ws, '.gitignore'), 'utf8'), 'node_modules/\n.workspace-browser/\n');
    assert.equal(appendToWorkspaceGitignore(ws), false, '已经有这一行，不该重复追加');

    // 末行没有换行时也要接得干净。
    writeFileSync(join(ws, '.gitignore'), 'dist/');
    assert.equal(appendToWorkspaceGitignore(ws), true);
    assert.equal(readFileSync(join(ws, '.gitignore'), 'utf8'), 'dist/\n.workspace-browser/\n');

    // 没有 .gitignore：不替用户创建（由数据目录里那份自忽略兜住）。
    assert.equal(appendToWorkspaceGitignore(ws2), false);
    assert.equal(existsSync(join(ws2, '.gitignore')), false);
    assert.equal(appendToWorkspaceGitignore(''), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
  }
});

test('老位置的数据会迁到新位置（登录态不丢）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-legacy-'));
  const workspace = mkdtempSync(join(tmpdir(), 'wb-ws-'));
  try {
    // 老布局：<DSH_HOME>/workspace-browser/_ungrouped/chrome-profile
    const legacy = join(home, 'workspace-browser', UNGROUPED_KEY);
    mkdirSync(join(legacy, 'chrome-profile'), { recursive: true });
    writeFileSync(join(legacy, 'chrome-profile', 'Local State'), '{}');
    writeFileSync(join(legacy, 'endpoint.json'), '{"schema":1}');

    const browserRoot = browserRootOf({ workspacePath: workspace, workspaceKey: 'ws-1', dshHome: home });
    const from = migrateLegacyRoot({ browserRoot, workspaceKey: 'ws-1', dshHome: home });
    assert.equal(from, legacy, '应报出迁移来源');
    assert.equal(existsSync(join(browserRoot, 'chrome-profile', 'Local State')), true, 'profile 内容要跟过来');

    // 再跑一次不该重复迁移（目标已存在）。
    assert.equal(migrateLegacyRoot({ browserRoot, workspaceKey: 'ws-1', dshHome: home }), '');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('目录布局：profile 与 endpoint.json 都在数据根下', () => {
  const root = browserRootOf({ workspaceKey: 'alpha-12345678', dshHome: 'C:\\dsh' });
  assert.equal(profileDirOf(root), join(root, 'chrome-profile'));
  assert.equal(endpointPathOf(root), join(root, 'endpoint.json'));
  assert.ok(profileDirOf(root).endsWith(join('workspace-browser', 'alpha-12345678', 'chrome-profile')));
});

test('endpoint.json 往返：损坏与版本不符都当作没有', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-test-'));
  try {
    const endpointPath = endpointPathOf(dir);
    assert.equal(readEndpoint(endpointPath), null, '文件不存在时返回 null');
    assert.equal(writeEndpoint(endpointPath, { port: 59807, wsPath: '/devtools/browser/x', pid: 1 }), true);
    const back = readEndpoint(endpointPath);
    assert.equal(back.schema, 1);
    assert.equal(back.port, 59807);

    writeFileSync(endpointPath, '{ not json');
    assert.equal(readEndpoint(endpointPath), null, '坏 JSON 返回 null');

    writeFileSync(endpointPath, JSON.stringify({ schema: 99, port: 1 }));
    assert.equal(readEndpoint(endpointPath), null, 'schema 不符返回 null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DevToolsActivePort：两行才有效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dap-'));
  try {
    const file = devToolsActivePortPathOf(dir);
    assert.equal(readDevToolsActivePort(dir), null, '文件不存在时返回 null');

    writeFileSync(file, '59807\n/devtools/browser/be4bc857-4807-4e20-9be7-3342a15575d8\n');
    assert.deepEqual(readDevToolsActivePort(dir), {
      port: 59807,
      wsPath: '/devtools/browser/be4bc857-4807-4e20-9be7-3342a15575d8',
    });

    writeFileSync(file, '59807\n');
    assert.equal(readDevToolsActivePort(dir), null, '缺 wsPath 不算有效');

    writeFileSync(file, 'not-a-port\n/path');
    assert.equal(readDevToolsActivePort(dir), null, '端口不是数字不算有效');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('设置：默认值齐备，非法值抛错，未知键被丢掉', () => {
  const defaults = normalizeSettings({});
  for (const key of Object.keys(FIELD_DEFAULTS)) {
    assert.deepEqual(defaults[key], FIELD_DEFAULTS[key], `${key} 的默认值应一致`);
  }
  assert.equal(defaults.userDataDir, '');
  assert.equal(defaults.debugPort, 0);
  assert.equal(defaults.streamFocusQuality, 70);

  assert.throws(() => normalizeSettings({ debugPort: 70000 }), /debugPort/u);
  assert.throws(() => normalizeSettings({ streamFocusQuality: 101 }), /streamFocusQuality/u);
  assert.throws(() => normalizeSettings({ panelTileSplit: 0 }), /panelTileSplit/u);
  assert.throws(() => normalizeSettings({ instanceOnDshExit: 'maybe' }), /instanceOnDshExit/u);

  const cleaned = normalizeSettings({ nope: 1, capsuleEnabled: false });
  assert.equal(cleaned.capsuleEnabled, false);
  assert.equal('nope' in cleaned, false);
});

test('设置 schema：可调用且补齐默认值（schemastery 不可用时也一样）', () => {
  const schema = createSettingsSchema();
  assert.equal(typeof schema, 'function');
  const value = schema({});
  // 字段都标了 `.volatile()`（0.2 的 settings 服务只投影 volatile 字段），
  // cordis 会把它们解析成响应式引用，所以按引用读值 —— 正是 derefVolatile 做的。
  assert.equal(derefVolatile(value.capsuleEnabled), FIELD_DEFAULTS.capsuleEnabled);
  assert.equal(derefVolatile(value.chromeCrossOrigin), FIELD_DEFAULTS.chromeCrossOrigin);
});

test('版本比较', () => {
  assert.equal(compareVersions('141.0.7390.55', '92'), 1);
  assert.equal(compareVersions('92', '92.0.0.0'), 0);
  assert.equal(compareVersions('91', MIN_CHROME_VERSION), -1);
});

test('Chrome 探测绝不执行 chrome.exe（真机事故的回归门禁）', () => {
  // 事故：在 Windows 上跑 `chrome.exe --version` 不会打印版本，而是把命令行交给
  // **用户默认 profile** 的 Chrome —— 用户的日常浏览器被拉到前台，实测直接弹出
  // 「谁在使用 Chrome?」选择器。用户点插件里的「启动」就会触发。
  //
  // 这条断言很笨但很管用：只要有人再把 `--version` 写回探测路径，它就红。
  const source = readFileSync(new URL('../lib/chrome.js', import.meta.url), 'utf8');
  assert.equal(source.includes("'--version'"), false, 'lib/chrome.js 里不该再出现 --version');
  assert.equal(source.includes('"--version"'), false, 'lib/chrome.js 里不该再出现 --version');
  assert.equal(/run\(\s*probe\.path/u.test(source), false, '不该把探测到的 chrome.exe 当命令跑');
});

test('页面过滤：排除 devtools、扩展页与浏览器内部 UI', () => {
  const targets = [
    { id: '1', type: 'page', url: 'https://example.com' },
    { id: '2', type: 'page', url: 'devtools://devtools/bundled/inspector.html' },
    { id: '3', type: 'page', url: 'chrome-extension://abc/panel.html' },
    { id: '4', type: 'background_page', url: 'https://example.com' },
    { id: '5', type: 'page', url: 'about:blank' },
    // 实测 Chrome 会把 Omnibox 下拉当成 page target，它不是标签页。
    { id: '6', type: 'page', url: 'chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html', title: 'Omnibox Popup' },
    { id: '7', type: 'page', url: 'chrome-untrusted://new-tab-page/one-google-bar' },
    // 用户自己打开的 chrome:// 设置页仍是真标签页，要留着。
    { id: '8', type: 'page', url: 'chrome://settings/' },
  ];
  const pages = pageTargets(targets);
  assert.deepEqual(
    pages.map((page) => page.id),
    ['1', '5', '8'],
    'about:blank 与用户打开的 chrome:// 算页面；devtools/扩展/omnibox/内部 UI 不算',
  );
});

test('胶片条过滤 about:blank，并按 /json/list 顺序重排', async () => {
  const { filmstripTargets, isAboutBlankUrl, orderPagesByIds, pageTargets } = await import('../lib/instance.js');
  assert.equal(isAboutBlankUrl('about:blank'), true);
  assert.equal(isAboutBlankUrl('about:blank#blocked'), true);
  assert.equal(isAboutBlankUrl('https://example.com'), false);

  const pages = pageTargets([
    { id: 'a', type: 'page', url: 'about:blank' },
    { id: 'b', type: 'page', url: 'https://www.douyin.com/' },
    { id: 'c', type: 'page', url: 'https://www.baidu.com/' },
    { id: 'd', type: 'page', url: 'about:blank?' },
  ]);
  assert.deepEqual(
    filmstripTargets(pages).map((page) => page.id),
    ['b', 'c'],
    '胶片条默认不展示 about:blank',
  );

  const shuffled = [
    { targetId: 'c', url: 'https://www.baidu.com/' },
    { targetId: 'b', url: 'https://www.douyin.com/' },
  ];
  assert.deepEqual(
    orderPagesByIds(shuffled, ['b', 'c']).map((page) => page.targetId),
    ['b', 'c'],
    '应按 /json/list（标签栏）顺序排',
  );
});

test('心跳：/json/list 失败不算关窗；端口文件还在时保持运行中', async () => {
  const { createServer } = await import('node:http');
  const { createInstanceManager } = await import('../lib/instance.js');
  const { profileDirOf, devToolsActivePortPathOf } = await import('../lib/paths.js');

  const browserRoot = mkdtempSync(join(tmpdir(), 'wb-beat-'));
  mkdirSync(profileDirOf(browserRoot), { recursive: true });

  /** @type {'ok' | 'list-fail' | 'empty'} */
  let mode = 'ok';
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x` }));
      return;
    }
    if (path === '/json/list') {
      if (mode === 'list-fail') {
        req.socket.destroy();
        return;
      }
      const pages =
        mode === 'empty'
          ? []
          : [{ id: 'TAB-1', type: 'page', url: 'https://example.com/', title: 'Example' }];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(pages));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  writeFileSync(devToolsActivePortPathOf(profileDirOf(browserRoot)), `${port}\n/devtools/browser/x\n`);

  const instance = createInstanceManager({
    browserRoot,
    workspaceKey: 'test-ws',
    getSettings: () => ({ chromePath: '', chromeCrossOrigin: false }),
    warn: () => {},
    info: () => {},
  });

  try {
    const attached = await instance.ensure({ reason: 'test' });
    assert.equal(attached.state, 'running', `应接管假端点：${JSON.stringify(attached)}`);

    mode = 'list-fail';
    for (let i = 0; i < 5; i += 1) {
      await instance.beat();
    }
    assert.equal(instance.status().state, 'running', '/json/list 连续失败时胶囊不得变未启动（端口文件还在）');

    const probe = await instance.probeEndpoint();
    assert.equal(probe.reachable, true, 'version 仍通时 reachable 应为 true');
    assert.equal(probe.listOk, false, 'list 失败时 listOk 应为 false');
    assert.equal(probe.fromCache, true, 'list 失败时应带回上次成功的标签缓存');
    assert.equal(probe.pages.length, 1, '缓存里应有刚才那张真实标签');
    assert.equal(probe.pages[0].url, 'https://example.com/');
  } finally {
    await instance.dispose();
    await new Promise((resolve) => server.close(() => resolve()));
    rmSync(browserRoot, { recursive: true, force: true });
  }
});
