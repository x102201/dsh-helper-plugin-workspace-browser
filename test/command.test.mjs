/**
 * `/browser` 命令的解析与分支测试。
 *
 * 这一层不碰真 Chrome、不碰模型：`ensure` / `listTabs` / `openTab` / `focusPanel`
 * / `submit` 全是注入的假实现，所以每个分支都能单独验。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composeAssignTabPrompt, composePrompt, composeSkillPrompt, createBrowserCommand, findUrl, normalizeUrl, parseSkillRequest, stripNewFlag } from '../lib/command.js';

/** 造一套记录调用痕迹的假依赖。 */
function harness(overrides = {}) {
  const calls = { ensure: 0, openTab: [], submit: [], focusPanel: 0, listTabs: 0 };
  const tabs = overrides.tabs ?? [];
  const deps = {
    instance: {
      ensure: async () => {
        calls.ensure += 1;
        return overrides.snapshot ?? { state: 'running', port: 1234, lastError: null };
      },
      status: () => overrides.snapshot ?? { state: 'running' },
    },
    listTabs: async () => {
      calls.listTabs += 1;
      return tabs;
    },
    openTab: async (url, options) => {
      calls.openTab.push({ url, options });
      return { targetId: 'T1', url };
    },
    focusPanel: () => {
      calls.focusPanel += 1;
    },
    submit: (agent, text) => {
      calls.submit.push({ agent, text });
    },
    listSkillNames: () => overrides.skillNames ?? [],
    warn: () => {},
  };
  return { command: createBrowserCommand(deps), calls };
}

test('拆 --new：只认开头的独立词', () => {
  assert.deepEqual(stripNewFlag('--new https://a.com'), { forceNew: true, rest: 'https://a.com' });
  assert.deepEqual(stripNewFlag('--new'), { forceNew: true, rest: '' });
  assert.deepEqual(stripNewFlag('https://a.com --new'), { forceNew: false, rest: 'https://a.com --new' });
  // `--newer` 不是 `--new`
  assert.deepEqual(stripNewFlag('--newer https://a.com'), { forceNew: false, rest: '--newer https://a.com' });
});

test('只认显式带 scheme 的网址', () => {
  assert.equal(findUrl('看看 https://example.com/a?b=1#c 这个').href, 'https://example.com/a?b=1#c');
  assert.equal(findUrl('http://127.0.0.1:8080/x').raw, 'http://127.0.0.1:8080/x');
  assert.equal(findUrl('example.com 上没有 scheme'), null, '裸域名不当网址，交给模型自己判断');
  assert.equal(findUrl('查一下天气'), null);
});

test('网址比较：去掉 # 与尾斜杠', () => {
  assert.equal(normalizeUrl('https://Example.com/a/#frag'), normalizeUrl('https://example.com/a'));
  assert.equal(normalizeUrl('https://example.com/a#x'), normalizeUrl('https://example.com/a#y'));
  assert.notEqual(normalizeUrl('https://example.com/a'), normalizeUrl('https://example.com/b'));
});

test('/browser 什么都不带：只启动 + 打开画面，不提交任何消息', async () => {
  const { command, calls } = harness();
  const result = await command.handler({ rawInput: '' });
  assert.equal(result.kind, 'success');
  assert.equal(calls.ensure, 1);
  assert.equal(calls.focusPanel, 1);
  assert.equal(calls.openTab.length, 0, '不该开标签');
  assert.equal(calls.submit.length, 0, '不该产生模型消息');
});

test('/browser <url>：开标签并把网址与 targetId 交给模型', async () => {
  const { command, calls } = harness();
  const result = await command.handler({ rawInput: ' https://example.com/login' });
  assert.equal(result.kind, 'success');
  assert.equal(calls.openTab.length, 1);
  assert.equal(calls.openTab[0].url, 'https://example.com/login');
  assert.equal(calls.submit.length, 1);
  const text = calls.submit[0].text;
  assert.ok(text.includes('https://example.com/login'), '要带网址');
  assert.ok(text.includes('T1'), '要带 targetId');
  assert.ok(text.includes('workspace_browser_'), '要点明工具前缀');
});

test('/browser <url> <指令>：把指令一起交给模型', async () => {
  const { command, calls } = harness();
  await command.handler({ rawInput: 'https://example.com 打开登录页并填上用户名' });
  assert.equal(calls.submit.length, 1);
  assert.ok(calls.submit[0].text.includes('打开登录页并填上用户名'));
});

test('已在跑的实例：去 # 后同网址复用，不再新开', async () => {
  const { command, calls } = harness({ tabs: [{ id: 'T9', url: 'https://example.com/a', title: 'A' }] });
  await command.handler({ rawInput: 'https://example.com/a#section-2' });
  assert.equal(calls.listTabs, 1);
  assert.equal(calls.openTab.length, 0, '应复用已有标签');
  assert.ok(calls.submit[0].text.includes('T9'), '应把复用到的 targetId 交给模型');
});

test('--new：即使已有相同网址也新开', async () => {
  const { command, calls } = harness({ tabs: [{ id: 'T9', url: 'https://example.com/a' }] });
  await command.handler({ rawInput: '--new https://example.com/a' });
  assert.equal(calls.listTabs, 0, '强制新开就不必再列标签');
  assert.equal(calls.openTab.length, 1);
  assert.equal(calls.openTab[0].options.forceNew, true);
});

test('--new 后面没有网址：报错且完全不动作', async () => {
  const { command, calls } = harness();
  const result = await command.handler({ rawInput: '--new' });
  assert.equal(result.kind, 'error');
  assert.equal(calls.ensure, 0, '不该启动');
  assert.equal(calls.submit.length, 0, '不该发消息');
});

test('一段没有网址的话：启动 + 打开画面，整段交给模型', async () => {
  const { command, calls } = harness();
  const result = await command.handler({ rawInput: '帮我看下这个站点的价格' });
  assert.equal(result.kind, 'success');
  assert.equal(calls.openTab.length, 0, '插件自己不猜网址');
  assert.equal(calls.submit.length, 1);
  assert.ok(calls.submit[0].text.includes('帮我看下这个站点的价格'));
  assert.ok(calls.submit[0].text.includes('workspace_browser_'));
});

test('实例起不来：返回可读错误，不假装成功', async () => {
  const { command, calls } = harness({ snapshot: { state: 'failed', lastError: '未检测到 Chrome。' } });
  const result = await command.handler({ rawInput: 'https://example.com' });
  assert.equal(result.kind, 'error');
  assert.ok(result.text.includes('未检测到 Chrome'));
  assert.equal(calls.submit.length, 0);
});

test('composePrompt：气泡只露出要求，展开说明给模型和悬浮', () => {
  const text = composePrompt({ instruction: '人民币和美元的汇率' });
  assert.equal(
    text,
    '@"外部浏览器｜用本工作区的 Chrome 完成最后一个斜杠后面的要求。只能使用 workspace_browser_*：有 targetId 就先 select_tab，没有网址就自己 navigate 或 open_tab，然后 snapshot 再读或操作。不要用 DSH 自带的网页抓取、搜索，也不要调用 browser_*。/人民币和美元的汇率"',
  );
  assert.ok(!text.includes('\n'), 'mention 不能换行，否则气泡不会收成芯片');
  assert.equal(text.slice(2, -1).split('/').at(-1), '人民币和美元的汇率');
});

test('composePrompt：只有网址时芯片是主机名，空字段不写进展开说明', () => {
  const text = composePrompt({ url: 'https://a.com/x', title: '' });
  assert.equal(text.slice(2, -1).split('/').at(-1), 'a.com');
  assert.ok(text.includes('https://a.com/x'));
  assert.ok(text.includes('workspace_browser_'));
  assert.ok(!text.includes('｜targetId '), '没有 targetId 就不写这一段');
  assert.ok(!text.includes('｜标题 '), '没有标题就不写这一段');
  assert.ok(text.includes('处理给出的页面'));
});

test('composeAssignTabPrompt：用文件 mention 语法，标题在最后一段', () => {
  const text = composeAssignTabPrompt({
    targetId: 'TAB-9',
    url: 'https://example.com/x',
    title: '示例',
  });
  assert.equal(text, '@"外部浏览器｜网址 https://example.com/x｜targetId TAB-9/示例"');
  assert.ok(!text.includes('\n'));
  assert.equal(text.slice(2, -1).split('/').at(-1), '示例');
});

test('parseSkillRequest：新增、保存、修改都只是意图线索', () => {
  assert.deepEqual(parseSkillRequest('新增技能'), { mode: 'create', hint: '' });
  assert.deepEqual(parseSkillRequest('新增skill'), { mode: 'create', hint: '' });
  assert.deepEqual(parseSkillRequest('新增 skill 汇率对比'), { mode: 'create', hint: '汇率对比' });
  assert.deepEqual(parseSkillRequest('保存skill'), { mode: 'save', hint: '' });
  assert.deepEqual(parseSkillRequest('保存技能'), { mode: 'save', hint: '' });
  assert.deepEqual(parseSkillRequest('保存 skill 汇率对比'), { mode: 'save', hint: '汇率对比' });
  assert.deepEqual(parseSkillRequest('修改skill'), { mode: 'update', hint: '' });
  assert.deepEqual(parseSkillRequest('修改技能'), { mode: 'update', hint: '' });
  assert.deepEqual(parseSkillRequest('修改技能 汇率对比'), { mode: 'update', hint: '汇率对比' });
  assert.equal(parseSkillRequest('保存成汇率对比'), null);
  assert.equal(parseSkillRequest('看看 https://example.com'), null);
});

test('/browser 保存skill：先让模型确认意图，并带上已有名单', async () => {
  const { command, calls } = harness({ skillNames: ['汇率对比'] });
  const result = await command.handler({ rawInput: '保存skill' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /先确认/);
  assert.equal(calls.openTab.length, 0, '保存技能不该开标签');
  assert.equal(calls.submit.length, 1);
  const text = calls.submit[0].text;
  assert.ok(text.includes('先确认意图'));
  assert.ok(text.includes('workspace_browser_save_skill'));
  assert.ok(text.includes('已有技能：汇率对比'));
  assert.ok(text.includes('不是 .dsh/skills'));
  assert.equal(text.slice(2, -1).split('/').at(-1), '保存技能');
  assert.equal(composeSkillPrompt({ mode: 'update', hint: '' }, '修改skill').slice(2, -1).split('/').at(-1), '修改技能');
});
