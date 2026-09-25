/**
 * 把一段话交给模型（DESIGN.zh.md §6「`/browser`」的最后一步）。
 *
 * ## 为什么不是自己拼消息对象
 *
 * `agent.followup(message)` 要一个宿主的 `UserMessage`。自己写 `{ role: 'user',
 * content: [...] }` 等于复制宿主的内部结构，字段一变就静默失效。所以这里从
 * profile 里**动态解析宿主自己的 `@deepseek-ai/dsh-llm`**，用它导出的
 * `createUserMessage`（`link:` 安装下不能静态导入，见 lib/dsh-modules.js）。
 *
 * 解析不到时不抛错、也不发消息：命令会退回"只打开窗口"，并在返回值里说明 ——
 * 静默失败比少一个功能更糟。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/model
 */

import { resolveDshModule } from './dsh-modules.js';

/**
 * 造一个「把文本提交给模型」的函数。
 *
 * @param {object} [options] - 参数。
 * @param {(message: string, error?: unknown) => void} [options.warn] - 降级日志。
 * @returns {{ submit: (agent: object, text: string) => boolean, available: () => boolean, reason: () => string }}
 *   `submit` 返回是否真的提交成功。
 */
export function createModelSubmitter(options = {}) {
  const warn = options.warn ?? (() => {});
  let createUserMessage;
  let reason = '';

  const llm = resolveDshModule('@deepseek-ai/dsh-llm');
  if (!llm) {
    reason = '解析不到 @deepseek-ai/dsh-llm（link 安装下需要从 profile 的 node_modules 里取）';
  } else if (typeof llm.createUserMessage !== 'function') {
    reason = '@deepseek-ai/dsh-llm 没有导出 createUserMessage';
  } else {
    createUserMessage = llm.createUserMessage;
  }
  if (reason !== '') warn(`命令无法把内容交给模型：${reason}`);

  return {
    available: () => typeof createUserMessage === 'function',
    reason: () => reason,
    /**
     * 提交一段纯文本给模型。
     *
     * @param {object} agent - 命令收到的 agent。
     * @param {string} text - 文本。
     * @returns {boolean} 是否提交成功。
     */
    submit(agent, text) {
      if (typeof createUserMessage !== 'function') return false;
      if (!agent || typeof agent.followup !== 'function') {
        warn('命令拿不到 agent.followup，无法把内容交给模型');
        return false;
      }
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }));
        return true;
      } catch (error) {
        warn('提交给模型失败', error);
        return false;
      }
    },
  };
}
