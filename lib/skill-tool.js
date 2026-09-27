/**
 * 模型在用户确认之后，把浏览器技能写入工作区名单。
 *
 * 这不是宿主 `.dsh/skills` 的 skill 工具。没确认就不落盘。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/skill-tool
 */

import { saveSkill } from './skills.js';

/** 工具名。 */
export const SAVE_SKILL_TOOL = 'workspace_browser_save_skill';

/**
 * 造保存技能工具。
 *
 * @param {{ browserRoot: string }} options - 数据根。
 * @returns {object} 工具定义。
 */
export function createSaveSkillTool(options) {
  const browserRoot = options.browserRoot;
  return {
    name: SAVE_SKILL_TOOL,
    description:
      '用户用 /browser 新增技能、新增skill、保存skill 或 修改skill 之后，先在对话里确认意图和内容。' +
      '用户明确同意后，才把工作区浏览器技能写入胶片条下面的名单。修改用同一个名字覆盖。' +
      '这不是宿主 .dsh/skills。没确认不要调用。步骤用自然语言，不要写编号、CSS 或页面脚本。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '技能名字，40 字以内，不能含路径符号。' },
        description: { type: 'string', description: '一句话说明这个技能做什么。' },
        steps: { type: 'string', description: '自然语言步骤。控件用名字描述，例如「搜索框」「评论框」。' },
        confirmBefore: { type: 'string', description: '哪一步必须先问用户。默认是「发送」。' },
        confirm: { type: 'boolean', description: '只有用户已经确认意图和内容时才传 true。' },
      },
      required: ['name', 'steps', 'confirm'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: value?.message || (value?.ok ? '已保存' : '没保存') }],
    },
    /**
     * @param {object} args - 参数。
     * @returns {object} 结果。
     */
    execute(args) {
      const result = saveSkill(browserRoot, {
        name: args?.name,
        description: args?.description,
        steps: args?.steps,
        confirmBefore: args?.confirmBefore,
        confirm: args?.confirm === true,
      });
      if (result.ok !== true) {
        return { ok: false, message: result.error || '没保存' };
      }
      return { ok: true, name: result.skill?.name ?? args.name, message: `已保存浏览器技能「${result.skill?.name ?? args.name}」。它会出现在胶片条下面。` };
    },
  };
}

/**
 * 注册保存技能工具。
 *
 * @param {object} toolsCtx - tools 上下文。
 * @param {{ browserRoot: string }} options - 数据根。
 * @returns {{ registered: number }} 注册数量。
 */
export function registerSaveSkillTool(toolsCtx, options) {
  const tools = typeof toolsCtx?.get === 'function' ? toolsCtx.get('tools') : toolsCtx?.tools;
  if (!tools || typeof tools.register !== 'function') return { registered: 0 };
  const definition = createSaveSkillTool(options);
  const dispose = tools.register(definition);
  if (typeof toolsCtx.effect === 'function') {
    toolsCtx.effect(() => () => {
      try {
        dispose();
      } catch {
        // 注销失败只能忽略。
      }
    }, SAVE_SKILL_TOOL);
  }
  return { registered: 1 };
}
