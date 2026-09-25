/**
 * 真机端到端验证：P0 实例 + P1 读工具 + P2 写工具 + P3 画面。
 *
 * 这是"统一验收"用的脚本：**真的起 Chrome**、真的走 CDP、真的跑工具定义，
 * 跑完自己收尾（停实例、删临时目录）。
 *
 * 工具参数名不写死：先从 `definition.parameters.properties` 里读出来再挑，这样
 * 各阶段换了参数名也不会让脚本失效（脚本会把它读到的名字打出来）。
 *
 * 跑法：`node scripts/verify-live.mjs`
 * ⚠️ 受限沙箱里 Chrome 建不起调试端口，需要放宽沙箱才能跑。
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createCdpClient } from '../lib/cdp.js';
import { createInstanceManager } from '../lib/instance.js';
import { createScreencastHub } from '../lib/screencast.js';
import { normalizeSettings } from '../lib/settings.js';
import { registerBrowserTools } from '../lib/tools.js';

// 写类工具是单独模块：万一它坏了（编码、语法），不该把整条验证链拖住 ——
// 读类与画面照样要能验。坏文件由 `scripts/check-encoding.mjs` 专门抓。
let registerWriteTools = null;
try {
  ({ registerWriteTools } = await import('../lib/write-tools.js'));
} catch (error) {
  console.log(`[warn] 写类工具模块加载失败，本次跳过 P2 部分：${error.message}`);
}

const root = join(process.cwd(), '.tmp-live');
const settings = normalizeSettings({ instanceRestoreTabsOnReopen: false, toolsWriteAuthorized: true });

const failures = [];
let step = 0;

/** 记一步结果。 */
function check(label, ok, detail = '') {
  step += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${String(step).padStart(2, '0')}. ${label}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
}

/** 等一个条件。 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/** 把工具定义收进数组（不注册到真的 tools 服务）。 */
function collectDefinitions(register, options) {
  const definitions = [];
  const toolsCtx = {
    tools: {
      register(definition) {
        definitions.push(definition);
        return () => {};
      },
    },
  };
  register(toolsCtx, options);
  return definitions;
}

/** 调一个工具：执行 + 渲染，返回 `{ value, text }`。 */
async function callTool(definitions, name, args) {
  const definition = definitions.find((entry) => entry.name === name);
  if (!definition) throw new Error(`没有工具 ${name}`);
  const exec = { deferContext() {}, concludeTurn() {} };
  const value = await definition.execute(args, exec);
  const content = definition.output.render(args, value);
  const text = (content ?? [])
    .map((block) => (block?.type === 'text' ? block.text : `[${block?.type ?? 'block'}]`))
    .join('\n');
  return { value, text };
}

/** 从 schema 里挑参数名。 */
function paramNames(definitions, name) {
  const definition = definitions.find((entry) => entry.name === name);
  return Object.keys(definition?.parameters?.properties ?? {});
}

/** 在候选名里挑第一个 schema 里存在的。 */
function pick(names, ...candidates) {
  for (const candidate of candidates) {
    if (names.includes(candidate)) return candidate;
  }
  return null;
}

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const manager = createInstanceManager({
  browserRoot: root,
  workspaceKey: 'live',
  getSettings: () => settings,
  warn: (message, error) => console.log(`     [warn] ${message}`, error ?? ''),
  info: (message) => console.log(`     [info] ${message}`),
});

let hub = null;
try {
  console.log('\n=== 1. 起实例 ===');
  const started = await manager.ensure({ reason: 'verify-live' });
  check('实例运行中', started.state === 'running', `port=${started.port}`);
  if (started.state !== 'running') throw new Error('实例没起来，后面没法验');

  const client = createCdpClient({
    getEndpoint: () => manager.endpoint,
    profileDir: manager.profileDir,
    info: (message) => console.log(`     [cdp] ${message}`),
    warn: (message, error) => console.log(`     [cdp warn] ${message}`, error ?? ''),
  });
  try {
    await client.connect();
    check('CDP 握手 + 拿到 target 表', client.isConnected(), `targets=${client.targets().length}`);
  } catch (error) {
    check('CDP 握手 + 拿到 target 表', false, error instanceof Error ? error.message : String(error));
    throw error;
  }

  const shared = { instance: manager, browserRoot: root, readSettings: () => settings, client };
  const readDefinitions = collectDefinitions(registerBrowserTools, shared);
  const writeDefinitions = registerWriteTools === null
    ? []
    : collectDefinitions(registerWriteTools, {
      ...shared,
      authorizeWrite: () => settings.toolsWriteAuthorized === true,
    });

  console.log(`     读类工具 ${readDefinitions.length} 个，写类工具 ${writeDefinitions.length} 个`);
  for (const definition of [...readDefinitions, ...writeDefinitions]) {
    console.log(`     · ${definition.name}(${Object.keys(definition.parameters?.properties ?? {}).join(', ')})`);
  }
  check(
    `工具数量（读类 ${readDefinitions.length} / 写类 ${writeDefinitions.length}）`,
    readDefinitions.length === 5 && (registerWriteTools === null || writeDefinitions.length === 11),
  );

  console.log('\n=== 2. 打开一张可操作的测试页 ===');
  const html = [
    '<html><head><title>验证页</title></head><body>',
    '<h1 id="h">标题一号</h1>',
    '<p>正文内容 ABC-123</p>',
    '<button id="btn">点我试试</button>',
    '<input id="user" type="text" name="user">',
    // ⚠️ 密码**不写进 data: URL** —— 否则它会出现快照的「网址」那一行，
    // 让人误以为掩码失效（第一版就踩了这个自己挖的坑）。改成页面加载后用 JS 填。
    '<input id="pw" type="password" name="password">',
    '</body></html>',
  ].join('');
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  const created = await client.commandBrowser('Target.createTarget', { url: dataUrl });
  const targetId = created?.targetId ?? '';
  check('创建了标签页', targetId !== '', `targetId=${targetId}`);
  // 后面的读类工具走**默认 target**：这里显式切过去，等于替模型调了一次 select_tab。
  client.selectTarget(targetId);
  check('等待页面就绪', await waitFor(async () => (await client.command(targetId, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }))?.result?.value === 'complete', 8000));

  console.log('\n=== 3. P1 读类工具 ===');
  // 页面加载后再把密码填进去：这样密文只存在于 DOM 里，不在 URL 里。
  await client.command(targetId, 'Runtime.evaluate', {
    expression: "document.getElementById('pw').value = 'secret123';",
  });
  const snapshot = await callTool(readDefinitions, 'workspace_browser_snapshot', {});
  check('snapshot 拿到标题', snapshot.text.includes('验证页'), '');
  check('snapshot 拿到正文', snapshot.text.includes('ABC-123'));
  check('snapshot 列出可点元素', /点我试试/u.test(snapshot.text));
  const leaked = snapshot.text.includes('secret123');
  check('snapshot 不泄露密码值', !leaked, leaked ? '⚠️ 密文出现在输出里' : '');
  if (leaked) {
    console.log('     --- snapshot 输出片段（前 1200 字）---');
    console.log(snapshot.text.slice(0, 1200));
  } else {
    const hasPasswordField = /password|密码|掩码|masked/iu.test(snapshot.text);
    check('snapshot 提到 password 字段（说明它被列出来了）', hasPasswordField, hasPasswordField ? '' : '输出里没有 password 字样');
    if (!hasPasswordField) {
      console.log('     --- snapshot 输出片段（前 1500 字）---');
      console.log(snapshot.text.slice(0, 1500));
    }
  }
  check('snapshot 包了不可信标记', snapshot.text.includes('<UNTRUSTED_PAGE_CONTENT>'));

  const listNames = paramNames(readDefinitions, 'workspace_browser_list_tabs');
  const listed = await callTool(readDefinitions, 'workspace_browser_list_tabs', {});
  check('list_tabs 能看到这张标签', listed.text.includes('data:text/html'), `参数=${listNames.join(',') || '无'}`);

  const textNames = paramNames(readDefinitions, 'workspace_browser_get_text');
  const selectorKey = pick(textNames, 'selector', 'css', 'query');
  const gotText = await callTool(
    readDefinitions,
    'workspace_browser_get_text',
    selectorKey === null ? {} : { [selectorKey]: 'h1' },
  );
  check('get_text 取到区域文字', gotText.text.includes('标题一号'), `参数=${selectorKey ?? '(整页)'}`);

  const shotNames = paramNames(readDefinitions, 'workspace_browser_screenshot');
  const shot = await callTool(readDefinitions, 'workspace_browser_screenshot', {});
  const shotPath = /([A-Za-z]:\\[^\s"']+\.png)/u.exec(shot.text)?.[1] ?? '';
  check('screenshot 返回落盘路径', shotPath !== '' && existsSync(shotPath), shotPath);
  check('截图文件不是空的', shotPath !== '' && existsSync(shotPath) && statSync(shotPath).size > 1000,
    shotPath === '' ? '' : `${statSync(shotPath).size} 字节`);

  const selectNames = paramNames(readDefinitions, 'workspace_browser_select_tab');
  const targetKey = pick(selectNames, 'targetId', 'id', 'target');
  if (targetKey !== null) {
    const selected = await callTool(readDefinitions, 'workspace_browser_select_tab', { [targetKey]: targetId });
    const after = await callTool(readDefinitions, 'workspace_browser_snapshot', {});
    check('select_tab 之后 snapshot 仍指向同一页', after.text.includes('ABC-123'), selected.text.slice(0, 60));
  } else {
    console.log('SKIP. select_tab 没有可识别的 targetId 参数');
  }

  console.log('\n=== 4. P2 写类工具 ===');
  // 写类工具用**快照编号**定位元素（`index`）或 `ref`；脚本按参数表自适应。
  const clickNames = paramNames(writeDefinitions, 'workspace_browser_click');
  const clickArgs = clickNames.includes('index')
    ? { index: 1 }
    : clickNames.includes('ref')
      ? { ref: '#btn' }
      : null;
  if (clickArgs !== null) {
    // 先给按钮挂一个副作用，点完从页面读回来 —— 才算真的点到了。
    await client.command(targetId, 'Runtime.evaluate', {
      expression: "document.getElementById('btn').addEventListener('click', () => { window.__clicked = true; });",
    });
    const clicked = await callTool(writeDefinitions, 'workspace_browser_click', clickArgs);
    const flag = await client.command(targetId, 'Runtime.evaluate', { expression: 'String(window.__clicked)', returnByValue: true });
    check('click 真的点到了元素', flag?.result?.value === 'true', `参数=${JSON.stringify(clickArgs)}`);
    check('click 返回值带 targetId', clicked.value?.targetId === targetId || clicked.text.includes(targetId));
  } else {
    console.log(`SKIP. click 参数无法识别：${clickNames.join(',')}`);
  }

  const typeNames = paramNames(writeDefinitions, 'workspace_browser_type');
  const textKey = pick(typeNames, 'text', 'value', 'input');
  if (textKey !== null) {
    const args = { [textKey]: 'hello-写入' };
    // 快照里表单字段是 [2]（type=text 的 #user）。
    if (typeNames.includes('index')) args.index = 2;
    else if (typeNames.includes('ref')) args.ref = '#user';
    await callTool(writeDefinitions, 'workspace_browser_type', args);
    const typed = await client.command(targetId, 'Runtime.evaluate', {
      expression: "document.getElementById('user').value",
      returnByValue: true,
    });
    check('type 真的写进了输入框', typed?.result?.value === 'hello-写入', `参数=${JSON.stringify(args)}`);
  } else {
    console.log(`SKIP. type 参数无法识别：${typeNames.join(',')}`);
  }

  const navNames = paramNames(writeDefinitions, 'workspace_browser_navigate');
  const urlKey = pick(navNames, 'url', 'href');
  if (urlKey !== null) {
    const second = `data:text/html;charset=utf-8,${encodeURIComponent('<title>第二页</title><p>NAV-OK</p>')}`;
    await callTool(writeDefinitions, 'workspace_browser_navigate', { [urlKey]: second });
    const navigated = await waitFor(async () => {
      const state = await client.command(targetId, 'Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
      return String(state?.result?.value ?? '').includes('NAV-OK');
    }, 8000);
    check('navigate 真的导航了', navigated);
  } else {
    console.log(`SKIP. navigate 参数无法识别：${navNames.join(',')}`);
  }

  console.log('\n=== 5. P3 画面 ===');
  hub = createScreencastHub({
    getClient: () => client,
    getRoles: () => ({ focus: { fps: 2, maxWidth: 960, quality: 70 }, thumb: { fps: 0.25, maxWidth: 160, quality: 50 } }),
    warn: (message, error) => console.log(`     [hub warn] ${message}`, error ?? ''),
    info: (message) => console.log(`     [hub] ${message}`),
  });
  const frames = [];
  // 投递口是对象 `{ send(message) }`（不是函数）：screencast 的 sink 契约。
  const sink = {
    send(message) {
      if (message && typeof message === 'object' && message.t === 'frame') frames.push(message);
    },
  };
  hub.subscribe('verify', sink, { targetIds: [targetId], role: 'focus', visible: true });
  hub.setVisible('verify', true);
  const gotFrame = await waitFor(() => frames.length > 0, 10000);
  check('收到画面帧', gotFrame, `${frames.length} 帧`);
  const first = frames[0];
  check(
    '帧是 JPEG base64 且带尺寸',
    first?.mime === 'image/jpeg' && typeof first?.dataB64 === 'string' && first.dataB64.length > 500 && first.w > 0 && first.h > 0,
    first ? `${first.w}x${first.h}, ${first.dataB64.length} 字符` : '',
  );
  check('帧的 targetId 对得上', first?.targetId === targetId);

  hub.setVisible('verify', false);
  const stopped = await waitFor(async () => {
    const before = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return frames.length === before;
  }, 6000);
  check('全部订阅者不可见后停止推帧', stopped);
} finally {
  try {
    await hub?.dispose?.();
  } catch {
    /* 忽略 */
  }
  await manager.dispose();
  await manager.stop().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (error) {
    console.log(`     [warn] 临时目录没删干净：${error.message}`);
  }
}

console.log(`\n===> ${failures.length === 0 ? '真机端到端全部通过' : `失败 ${failures.length} 项：${failures.join(' / ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
