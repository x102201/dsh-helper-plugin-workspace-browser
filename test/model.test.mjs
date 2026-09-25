/**
 * `lib/dsh-modules.js` 与 `lib/model.js` 的测试。
 *
 * 关键是**不依赖本机路径**：造一个临时的假 `@deepseek-ai/dsh-llm` 包，把
 * `DSH_HOME` 指过去，验证"解析得到 → 提交成功"和"解析不到 → 明确降级"两条路。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { candidateRoots, resolveDshModule } from '../lib/dsh-modules.js';
import { createModelSubmitter } from '../lib/model.js';

/** 造一个假的 DSH 目录树，含一个假的 dsh-llm。 */
function makeFakeHome({ withLlm }) {
  const home = mkdtempSync(join(tmpdir(), 'wb-home-'));
  if (withLlm) {
    const pkgDir = join(home, 'node_modules', '@deepseek-ai', 'dsh-llm');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', main: 'index.js' }));
    writeFileSync(
      join(pkgDir, 'index.js'),
      'module.exports = { createUserMessage: (input) => ({ ...input, __fake: true }) };\n',
    );
  }
  return home;
}

/** 在指定的 DSH_HOME 下跑一段逻辑，跑完恢复环境变量。 */
function withDshHome(home, fn) {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

test('候选根目录：含 DSH_HOME 相关位置', () => {
  const home = makeFakeHome({ withLlm: false });
  try {
    const roots = withDshHome(home, () => candidateRoots());
    assert.ok(roots.includes(home), 'DSH_HOME 本身');
    assert.ok(roots.includes(join(home, 'profiles', 'web')), 'profile 目录');
    assert.ok(roots.includes(join(home, '..', 'dsh')), '环境目录里并列的 dsh checkout');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('解析不到模块时返回 undefined，不抛错', () => {
  const home = makeFakeHome({ withLlm: false });
  try {
    const missing = withDshHome(home, () => resolveDshModule('@deepseek-ai/dsh-llm'));
    assert.equal(missing, undefined);
    assert.equal(resolveDshModule('@deepseek-ai/definitely-not-a-real-package'), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('解析得到时：submit 用宿主的 createUserMessage 提交一次', () => {
  const home = makeFakeHome({ withLlm: true });
  try {
    const submitter = withDshHome(home, () => createModelSubmitter({ warn: () => {} }));
    assert.equal(submitter.available(), true, '应能拿到 createUserMessage');

    const seen = [];
    const ok = submitter.submit({ followup: (message) => seen.push(message) }, '你好');
    assert.equal(ok, true);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].content, [{ type: 'text', text: '你好' }]);
    assert.deepEqual(seen[0].source, { kind: 'user' });
    assert.equal(seen[0].__fake, true, '必须用宿主导出的函数造消息，而不是自己拼');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('解析不到时：submit 返回 false 并给出原因（不静默失败）', () => {
  const home = makeFakeHome({ withLlm: false });
  try {
    const warnings = [];
    const submitter = withDshHome(home, () => createModelSubmitter({ warn: (message) => warnings.push(message) }));
    assert.equal(submitter.available(), false);
    assert.ok(submitter.reason().includes('dsh-llm'), '原因里要说明解析不到哪个包');
    assert.equal(submitter.submit({ followup: () => {} }, '你好'), false);
    assert.ok(warnings.length >= 1, '要留下一条 warn');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('拿不到 agent.followup 时不抛错，返回 false', () => {
  const home = makeFakeHome({ withLlm: true });
  try {
    const warnings = [];
    const submitter = withDshHome(home, () => createModelSubmitter({ warn: (message) => warnings.push(message) }));
    assert.equal(submitter.submit({}, '你好'), false);
    assert.equal(submitter.submit(null, '你好'), false);
    assert.ok(warnings.some((message) => message.includes('followup')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
