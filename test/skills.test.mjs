/**
 * 技能：未确认不落盘，确认后能列出、展开给模型、删除。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { presentSkillFile } from '../lib/skill-file.js';
import { createSaveSkillTool } from '../lib/skill-tool.js';
import { composeSkillMention, deleteSkill, listSkills, readSkill, saveSkill, SKILL_USAGE } from '../lib/skills.js';

test('技能要确认才保存，芯片展开才包含步骤', () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-skills-'));
  try {
    const draft = saveSkill(root, { name: '小红书评论', steps: '在搜索框填入 {{关键词}}', confirm: false });
    assert.equal(draft.ok, false);
    assert.deepEqual(listSkills(root), []);

    const saved = saveSkill(root, {
      name: '小红书评论',
      description: '搜索后评论',
      steps: '在搜索框填入 {{关键词}}',
      confirm: true,
    });
    assert.equal(saved.ok, true);
    assert.equal(listSkills(root)[0].name, '小红书评论');

    const skill = readSkill(root, '小红书评论');
    assert.match(skill.mention, /小红书评论"$/);
    assert.match(skill.mention, /搜索框/);
    assert.match(skill.mention, /workspace_browser_/);
    assert.equal(composeSkillMention(skill).endsWith('/小红书评论"'), true);
    assert.match(SKILL_USAGE, /\/browser 新增技能/);
    assert.match(SKILL_USAGE, /\/browser 保存技能/);
    assert.match(SKILL_USAGE, /\/browser 保存skill/);
    assert.match(SKILL_USAGE, /\/browser 修改技能/);
    assert.match(SKILL_USAGE, /\/browser 修改skill/);

    assert.equal(deleteSkill(root, '小红书评论').ok, true);
    assert.equal(readSkill(root, '小红书评论'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('保存技能工具：没确认不落盘，确认后写入名单', () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-skill-tool-'));
  try {
    const tool = createSaveSkillTool({ browserRoot: root });
    const blocked = tool.execute({ name: '汇率对比', steps: '打开搜索框', confirm: false });
    assert.equal(blocked.ok, false);
    assert.deepEqual(listSkills(root), []);
    const saved = tool.execute({ name: '汇率对比', steps: '打开搜索框并读出结果', confirm: true });
    assert.equal(saved.ok, true);
    assert.equal(listSkills(root)[0].name, '汇率对比');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('取路径不启动程序；系统打开和资源管理器选中仍然分开', () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-skill-file-'));
  try {
    assert.equal(saveSkill(root, { name: '汇率对比', steps: '打开搜索框', confirm: true }).ok, true);
    const calls = [];
    const spawn = (command, args) => {
      calls.push({ command, args });
      return { unref() {} };
    };
    const located = presentSkillFile(root, '汇率对比', 'path', { spawn });
    assert.equal(located.ok, true);
    assert.match(located.file, /汇率对比\.md$/);
    assert.equal(calls.length, 0, '只取路径时不能启动系统程序');
    const opened = presentSkillFile(root, '汇率对比', 'open', { spawn });
    assert.equal(opened.ok, true);
    assert.match(opened.file, /汇率对比\.md$/);
    const revealed = presentSkillFile(root, '汇率对比', 'reveal', { spawn });
    assert.equal(revealed.ok, true);
    assert.equal(calls.length, 2);
    if (process.platform === 'win32') {
      assert.equal(calls[0].command, 'cmd.exe');
      assert.deepEqual(calls[0].args.slice(0, 4), ['/d', '/c', 'start', '']);
      assert.match(calls[0].args[4], /汇率对比\.md$/);
      assert.equal(calls[1].command, 'explorer.exe');
      assert.match(calls[1].args[0], /^\/select,"/);
      assert.match(calls[1].args[0], /汇率对比\.md"$/);
    }
    assert.equal(presentSkillFile(root, '../outside', 'open', { spawn }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
