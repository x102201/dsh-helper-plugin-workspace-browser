/**
 * `/browser` 命令的实现（DESIGN.zh.md §6「`/browser`」）。
 *
 * ## 为什么单独一个模块
 *
 * 命令的**解析与决策**是纯逻辑，而"开标签""把话交给模型"必须落到宿主能力上。
 * 这里全部通过注入进来（`listTabs` / `openTab` / `focusPanel` / `submit`），于是：
 *
 * - 解析与分支可以单测，不需要真 Chrome、不需要模型；
 * - 宿主侧换实现（HTTP 端点还是 CDP）不影响这一层。
 *
 * ## 解析规则（照文档）
 *
 * | 输入 | 行为 |
 * |---|---|
 * | `/browser` | 只启动窗口 + 打开画面，**不提交任何消息** |
 * | `/browser https://…` | 启动；已在跑则"去掉 `#` 后同网址"复用那张标签，否则后台新开 |
 * | `/browser https://… 后面的话` | 同上，再把这段话交给模型 |
 * | `/browser 一段没有网址的话` | 启动 + 打开画面，不开标签，整段话交给模型 |
 * | `/browser --new https://…` | 即使已有相同网址也新开 |
 * | `/browser --new`（没有网址） | 返回错误文字：不启动、不发给模型 |
 *
 * ⚠️ `rawInput` 是命令名之后的**整行原文**（含前导空白），DSH 不做 argv 解析。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/command
 */

/** 命令名（也是 DESIGN 附录里的「命令」一项）。 */
export const COMMAND_NAME = 'browser';

/** 交给模型的话里必须点明工具前缀，否则模型会去用 DSH 自带的抓取。 */
export const TOOL_PREFIX_HINT = 'workspace_browser_';

/**
 * 拆掉开头的 `--new`。
 *
 * @param {string} raw - `trim()` 之后的原文。
 * @returns {{ forceNew: boolean, rest: string }} 结果。
 */
export function stripNewFlag(raw) {
  const match = /^--new(?=$|\s)/u.exec(raw);
  if (!match) return { forceNew: false, rest: raw };
  return { forceNew: true, rest: raw.slice(match[0].length).trim() };
}

/**
 * 在文字里找第一个 http(s) 网址。
 *
 * 只认显式带 scheme 的，避免把 `example.com` 这种普通词当成网址误开标签 ——
 * 文档里"一段没有网址的话"要能原样交给模型。
 *
 * @param {string} text - 已 trim 的文本。
 * @returns {{ raw: string, href: string } | null} 命中结果。
 */
export function findUrl(text) {
  for (const token of text.split(/\s+/u)) {
    if (!/^https?:\/\//iu.test(token)) continue;
    try {
      const parsed = new URL(token);
      return { raw: token, href: parsed.toString() };
    } catch {
      // 不是合法 URL，继续看下一个词。
    }
  }
  return null;
}

/**
 * 网址比较用的归一形式：**去掉 `#`**，统一大小写，去掉尾部斜杠。
 *
 * 文档明确说"去掉 `#` 后若已有相同 URL 就用那张标签"—— 页内锚点不该另开一张。
 *
 * @param {string} url - 网址。
 * @returns {string} 归一后的字符串；无法解析时返回原串的小写形式。
 */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(String(url));
    parsed.hash = '';
    const text = parsed.toString();
    return (text.endsWith('/') ? text.slice(0, -1) : text).toLowerCase();
  } catch {
    return String(url ?? '').toLowerCase();
  }
}

/**
 * 拼给模型的那段话。
 *
 * @param {object} parts - 参数。
 * @param {string} [parts.url] - 网址。
 * @param {string} [parts.targetId] - 标签的 targetId。
 * @param {string} [parts.title] - 页面标题。
 * @param {string} [parts.instruction] - 用户后面跟的话。
 * @returns {string} 提示词。
 */
export function composePrompt({ url = '', targetId = '', title = '', instruction = '' } = {}) {
  const lines = ['【外部浏览器】这些操作要用本工作区的那个 Chrome 完成。'];
  if (title !== '') lines.push(`标题：${title}`);
  if (url !== '') lines.push(`目标网址：${url}`);
  if (targetId !== '') lines.push(`targetId：${targetId}`);
  if (instruction !== '') lines.push(`用户要求：${instruction}`);
  lines.push(`必须使用 ${TOOL_PREFIX_HINT}* 工具（不要用 DSH 内置的抓取能力）。`);
  return lines.join('\n');
}

/**
 * 胶片条芯片的 mention。气泡芯片显示最后一段标题；悬浮提示和模型看到整段，
 * 里面是可读的网址和 targetId。
 *
 * @param {object} tab - 标签信息。
 * @param {string} [tab.targetId] - targetId。
 * @param {string} [tab.url] - 网址。
 * @param {string} [tab.title] - 标题。
 * @returns {string} 带引号的 `@` mention。
 */
export function composeAssignTabPrompt(tab = {}) {
  const targetId = typeof tab.targetId === 'string' ? tab.targetId.trim() : '';
  const url = typeof tab.url === 'string' ? tab.url.trim() : '';
  const title = typeof tab.title === 'string' ? tab.title : '';
  const label = mentionLabel(title) || mentionLabel(hostOf(url)) || mentionLabel(targetId) || '标签';
  const bits = ['外部浏览器'];
  const safeUrl = url.replace(/["\r\n]/g, '');
  const safeId = targetId.replace(/["\r\n]/g, '');
  if (safeUrl !== '') bits.push(`网址 ${safeUrl}`);
  if (safeId !== '') bits.push(`targetId ${safeId}`);
  return `@"${bits.join('｜')}/${label}"`;
}

/**
 * 没有标题时，芯片上显示主机名。
 *
 * @param {string} url - 网址。
 * @returns {string} host，解析不了时给原串。
 */
function hostOf(url) {
  if (url === '') return '';
  try {
    const parsed = new URL(url);
    return parsed.host === '' ? url : parsed.host;
  } catch {
    return url;
  }
}

/**
 * 芯片上显示的那一段：去掉会截断 `@"…"` 的引号和换行，斜杠改成全角以免被当成路径再切一刀。
 *
 * @param {string} value - 原始标题或退路文本。
 * @returns {string} 单段标签。
 */
function mentionLabel(value) {
  return value.replace(/[\r\n"]/g, ' ').replace(/[\\/]/g, '／').trim();
}

/**
 * 造出 `/browser` 的命令定义。
 *
 * @param {object} deps - 依赖。
 * @param {object} deps.instance - 实例管理器（`ensure()` / `status()`）。
 * @param {() => Promise<Array<{id: string, url: string, title?: string}>>} deps.listTabs - 列出标签。
 * @param {(url: string, options: { forceNew: boolean }) => Promise<{ targetId?: string, url?: string } | null>} deps.openTab - 后台开标签。
 * @param {(sessionId: string | null) => void} deps.focusPanel - 请求展开画面。
 * @param {(agent: object, text: string) => void} deps.submit - 把一段话交给模型。
 * @param {(message: string, error?: unknown) => void} [deps.warn] - 降级日志。
 * @returns {object} 命令定义。
 */
export function createBrowserCommand(deps) {
  const { instance, listTabs, openTab, focusPanel, submit } = deps;
  const warn = deps.warn ?? (() => {});

  /**
   * 命令处理器。
   *
   * @param {object} invocation - `{ agent, rawInput }`。
   * @returns {Promise<{ kind: 'success'|'error', text: string }>} 命令结果。
   */
  async function handler(invocation) {
    const agent = invocation?.agent;
    const raw = String(invocation?.rawInput ?? '').trim();
    const { forceNew, rest } = stripNewFlag(raw);
    const found = findUrl(rest);
    const instruction = found === null ? rest : rest.replace(found.raw, '').trim();

    if (forceNew && found === null) {
      // 文档：`--new` 后面没有网址 → 返回错误文字，不启动、不给模型发消息。
      return { kind: 'error', text: `--new 后面要跟一个网址，例如 /${COMMAND_NAME} --new https://example.com` };
    }

    // `/browser` 与带网址两种都要先确保窗口在跑；已经在跑时 ensure() 直接复用。
    let snapshot;
    try {
      snapshot = await instance.ensure({ reason: 'command' });
    } catch (error) {
      warn('命令启动实例失败', error);
      snapshot = instance.status();
    }
    if (snapshot.state !== 'running') {
      return { kind: 'error', text: `没能启动工作区浏览器：${snapshot.lastError ?? '未知原因'}` };
    }
    focusPanel(null);

    // 没有网址：`/browser` 什么都不带只开窗口；带一段话则整段交给模型。
    if (found === null) {
      if (rest === '') return { kind: 'success', text: '工作区浏览器已就绪。' };
      submit(agent, composePrompt({ instruction: rest }));
      return { kind: 'success', text: '已打开工作区浏览器，并把这句话交给模型。' };
    }

    // 有网址：不强制新开时，先看有没有"去掉 # 后相同"的标签。
    let tab = null;
    if (!forceNew) {
      try {
        const tabs = await listTabs();
        const wanted = normalizeUrl(found.href);
        const existing = (tabs ?? []).find((entry) => normalizeUrl(entry?.url) === wanted);
        if (existing) tab = { targetId: existing.id, url: existing.url };
      } catch (error) {
        warn('列标签失败，改为直接新开', error);
      }
    }
    if (tab === null) {
      try {
        tab = await openTab(found.href, { forceNew });
      } catch (error) {
        warn('开标签失败', error);
        tab = null;
      }
    }

    submit(agent, composePrompt({ url: found.href, targetId: tab?.targetId ?? '', instruction }));
    return {
      kind: 'success',
      text: tab === null
        ? `已把 ${found.href} 交给模型，但没能确认标签是否打开。`
        : `已在工作区浏览器里打开 ${found.href}，并交给模型。`,
    };
  }

  return {
    name: COMMAND_NAME,
    description: '用工作区里那个真 Chrome 干活（外部浏览器）',
    input: { hint: '[--new] [url] [指令]' },
    handler,
  };
}
