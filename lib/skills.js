/**
 * 工作区技能：保存「怎么做」的说明，不保存某一次的编号或脚本。
 *
 * 文件在 `<browserRoot>/skills/<名字>.md`。未确认的草稿不落盘。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/skills
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 发给模型的固定约束。技能芯片展开时带上。 */
export const SKILL_MODEL_RULE = '这是已保存的技能。只能使用 workspace_browser_*。必须当场 snapshot 拿新编号，不要使用技能正文里可能出现的旧编号。评论、发送、提交先停下来等用户确认，除非技能写明不用确认直接发送。';

/** 胶片条和名单之间的用法说明。有没有技能都显示这一段。 */
export const SKILL_USAGE = '在输入框里管理技能：/browser 新增技能 或 /browser 新增skill；/browser 保存技能 或 /browser 保存skill；/browser 修改技能 或 /browser 修改skill。模型会先确认你的意图，你同意之后才会写入下面的名单。点名字只查看。@ 或「加入对话」只放入技能名，发出去之后模型才看到全文。';

/**
 * 技能目录。
 *
 * @param {string} browserRoot - 工作区数据根。
 * @returns {string} 目录。
 */
export function skillsDirOf(browserRoot) {
  return join(browserRoot, 'skills');
}

/**
 * 名字能否当文件名。
 *
 * @param {unknown} name - 名字。
 * @returns {string} 整理后的名字；非法时为空串。
 */
export function normalizeSkillName(name) {
  if (typeof name !== 'string') return '';
  const text = name.trim();
  if (text === '' || text.length > 40) return '';
  if (/[\\/:*?"<>|\r\n]/u.test(text)) return '';
  if (text === '.' || text === '..') return '';
  return text;
}

/**
 * 把技能收成模型看到的全文。芯片脸上不显示这段。
 *
 * @param {object} skill - 技能。
 * @returns {string} `@"技能｜…/<名字>"`。
 */
export function composeSkillMention(skill) {
  const name = normalizeSkillName(skill?.name) || '技能';
  const description = String(skill?.description ?? '').replace(/["\r\n]/gu, ' ').trim();
  const steps = String(skill?.steps ?? '').replace(/"/gu, "'").trim();
  const confirm = String(skill?.confirmBefore ?? '发送').replace(/["\r\n]/gu, ' ').trim();
  const body = [SKILL_MODEL_RULE, description === '' ? '' : `说明 ${description}`, `发送前确认 ${confirm}`, steps].filter(Boolean).join(' ');
  return `@"技能｜${body}/${name}"`;
}

/**
 * 读一个技能文件。
 *
 * @param {string} file - 路径。
 * @returns {object | null} 技能。
 */
function parseSkillFile(file) {
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(raw);
  const meta = {};
  let steps = raw;
  if (match) {
    steps = match[2].trim();
    for (const line of match[1].split(/\r?\n/u)) {
      const pair = /^([A-Za-z]+):\s*(.*)$/u.exec(line);
      if (pair) meta[pair[1]] = pair[2].trim();
    }
  }
  const name = normalizeSkillName(meta.name);
  if (name === '') return null;
  return {
    name,
    description: meta.description ?? '',
    confirmBefore: meta.confirmBefore || '发送',
    steps,
  };
}

/**
 * 列出技能（名字和一句话）。
 *
 * @param {string} browserRoot - 数据根。
 * @returns {Array<{ name: string, description: string }>} 名单。
 */
export function listSkills(browserRoot) {
  const dir = skillsDirOf(browserRoot);
  if (!existsSync(dir)) return [];
  const skills = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const skill = parseSkillFile(join(dir, file));
    if (!skill) continue;
    skills.push({ name: skill.name, description: skill.description });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return skills;
}

/**
 * 技能文件的绝对路径。名字非法或文件不存在时为空串。
 *
 * @param {string} browserRoot - 数据根。
 * @param {string} name - 名字。
 * @returns {string} 路径。
 */
export function skillFileOf(browserRoot, name) {
  const safe = normalizeSkillName(name);
  if (safe === '') return '';
  const file = join(skillsDirOf(browserRoot), `${safe}.md`);
  if (!existsSync(file)) return '';
  return file;
}

/**
 * 读一个技能全文。
 *
 * @param {string} browserRoot - 数据根。
 * @param {string} name - 名字。
 * @returns {object | null} 技能，含 mention。
 */
export function readSkill(browserRoot, name) {
  const safe = normalizeSkillName(name);
  if (safe === '') return null;
  const file = join(skillsDirOf(browserRoot), `${safe}.md`);
  const skill = parseSkillFile(file);
  if (!skill) return null;
  return { ...skill, mention: composeSkillMention(skill) };
}

/**
 * 确认后写入技能。`confirm` 不是 true 时不落盘。
 *
 * @param {string} browserRoot - 数据根。
 * @param {object} input - 草稿。
 * @returns {{ ok: true, skill: object } | { ok: false, error: string }} 结果。
 */
export function saveSkill(browserRoot, input = {}) {
  if (input.confirm !== true) return { ok: false, error: '还没确认保存' };
  const name = normalizeSkillName(input.name);
  if (name === '') return { ok: false, error: '技能名字无效' };
  const steps = typeof input.steps === 'string' ? input.steps.trim() : '';
  if (steps === '') return { ok: false, error: '技能步骤是空的' };
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const confirmBefore = typeof input.confirmBefore === 'string' && input.confirmBefore.trim() !== ''
    ? input.confirmBefore.trim()
    : '发送';
  const dir = skillsDirOf(browserRoot);
  mkdirSync(dir, { recursive: true });
  const body = `---\nname: ${name}\ndescription: ${description}\nconfirmBefore: ${confirmBefore}\n---\n${steps}\n`;
  writeFileSync(join(dir, `${name}.md`), body, 'utf8');
  const skill = readSkill(browserRoot, name);
  return { ok: true, skill };
}

/**
 * 删除一个技能。
 *
 * @param {string} browserRoot - 数据根。
 * @param {string} name - 名字。
 * @returns {{ ok: boolean, error?: string }} 结果。
 */
export function deleteSkill(browserRoot, name) {
  const safe = normalizeSkillName(name);
  if (safe === '') return { ok: false, error: '技能名字无效' };
  const file = join(skillsDirOf(browserRoot), `${safe}.md`);
  if (!existsSync(file)) return { ok: false, error: '没有这个技能' };
  rmSync(file);
  return { ok: true };
}
