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
 * 有用户要求时，展开说明告诉模型：任务写在最后一个斜杠后面。
 * 气泡只画出那一段，悬停和模型看到的是这一整句。
 */
const TASK_RULE = `用本工作区的 Chrome 完成最后一个斜杠后面的要求。只能使用 ${TOOL_PREFIX_HINT}*：有 targetId 就先 select_tab，没有网址就自己 navigate 或 open_tab，然后 snapshot 再读或操作。不要用 DSH 自带的网页抓取、搜索，也不要调用 browser_*。`;

/**
 * 只给了网址、没有另写要求时的展开说明。
 */
const PAGE_RULE = `用本工作区的 Chrome 处理给出的页面，这不是文件路径。只能使用 ${TOOL_PREFIX_HINT}*：有 targetId 就先 select_tab，然后 snapshot。不要用 DSH 自带的网页抓取、搜索，也不要调用 browser_*。`;

/**
 * 拼给模型的 mention。
 *
 * 对话气泡把 `@"…"` 画成芯片，脸上只有最后一个斜杠后的标签，默认不把整段铺开。
 * 悬停时的 `title` 和模型收到的是同一段：操作说明、网址、targetId，标签在最后。
 *
 * @param {object} parts - 参数。
 * @param {string} [parts.url] - 网址。
 * @param {string} [parts.targetId] - 标签的 targetId。
 * @param {string} [parts.title] - 页面标题。
 * @param {string} [parts.instruction] - 用户后面跟的话。
 * @returns {string} `@"外部浏览器｜…/<标签>"`。
 */
export function composePrompt({ url = '', targetId = '', title = '', instruction = '' } = {}) {
  const safeUrl = mentionBody(url);
  const safeId = mentionBody(targetId);
  const safeTitle = mentionBody(title);
  const task = mentionLabel(instruction);
  const bits = ['外部浏览器', task !== '' ? TASK_RULE : PAGE_RULE];
  const label = task || mentionLabel(safeTitle) || mentionLabel(hostOf(safeUrl)) || '任务';
  if (safeTitle !== '' && safeTitle !== label) bits.push(`标题 ${safeTitle}`);
  if (safeUrl !== '') bits.push(`网址 ${safeUrl}`);
  if (safeId !== '') bits.push(`targetId ${safeId}`);
  return `@"${bits.join('｜')}/${label}"`;
}

/**
 * mention 正文里的一段：去掉会截断 `@"…"` 的引号和换行，压成一行。斜杠保留，
 * 因为标签只认最后一个斜杠。
 *
 * @param {string} value - 原始文本。
 * @returns {string} 单行。
 */
function mentionBody(value) {
  return String(value ?? '').replace(/["\r\n]/gu, ' ').replace(/\s+/gu, ' ').trim();
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

/** 技能命令在芯片上的短标签，以及交给模型的意图猜测。 */
const SKILL_MODES = {
  create: {
    label: '新增技能',
    guess: '用户输入了新增技能或新增 skill，可能想新建一个浏览器技能。',
  },
  save: {
    label: '保存技能',
    guess: '用户输入了保存技能或保存 skill，可能想把刚才这次浏览器操作存成技能。',
  },
  update: {
    label: '修改技能',
    guess: '用户输入了修改技能或修改 skill，可能想改一个已经在胶片条下面的技能。',
  },
};

/**
 * 认出输入框里的技能命令。
 *
 * 认 `/browser` 后面的：`新增技能`、`新增 skill`、`保存技能`、`保存 skill`、`修改技能`、`修改 skill`。
 * 后面还可以带名字或补充。这些字只是意图线索，不是已经定下来的名字。
 * 不是这类句子时返回 null，交给原来的网址和指令逻辑。
 *
 * @param {string} rest - 去掉 `--new` 之后的原文。
 * @returns {{ mode: 'create' | 'save' | 'update', hint: string } | null} 技能请求。
 */
export function parseSkillRequest(rest) {
  const text = String(rest ?? '').trim();
  const matched = /^(新增|新建|添加|保存|修改)\s*(?:一个)?\s*(?:skill|技能)\s*(.*)$/iu.exec(text);
  if (!matched) return null;
  const verb = matched[1].toLowerCase();
  const mode = verb === '保存' ? 'save' : verb === '修改' ? 'update' : 'create';
  return { mode, hint: skillHintFrom(matched[2]) };
}

/**
 * 命令后面附带的字，留给模型当线索。
 *
 * @param {string} raw - 尾巴。
 * @returns {string} 线索；没有时为空串。
 */
function skillHintFrom(raw) {
  return String(raw ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * 交给模型的技能说明。先确认意图，同意之后才落盘。
 *
 * @param {{ mode: 'create' | 'save' | 'update', hint: string }} request - 解析结果。
 * @param {string} raw - 用户原话。
 * @param {string[]} [existingNames] - 已经有的技能名。
 * @returns {string} mention。
 */
export function composeSkillPrompt(request, raw, existingNames = []) {
  const mode = SKILL_MODES[request.mode] ?? SKILL_MODES.create;
  const names = existingNames.length > 0 ? existingNames.join('、') : '还没有';
  const hint = request.hint === '' ? '没有附带名字或补充' : `附带的字：${request.hint}`;
  const body = [
    '外部浏览器',
    `${mode.guess}这只是线索，先确认意图，不要立刻写入。`,
    '第一句用自己的话复述：你理解用户是要新增、把刚才的操作保存下来，还是修改已有技能。把准备采用的名字、一句话说明和步骤列出来，请用户确认或改正。',
    '用户明确同意之前，不要调用 workspace_browser_save_skill，也不要调用宿主的 skill 工具。这不是 .dsh/skills 里的 SKILL.md。',
    '用户同意之后才调用 workspace_browser_save_skill，confirm 必须是 true。修改用同一个名字覆盖。步骤只用自然语言，不要写编号、CSS 或页面脚本。',
    `已有技能：${names}`,
    hint,
    `用户原话：${String(raw ?? '').replace(/["\r\n]/gu, ' ')}`,
  ];
  return `@"${body.join('｜')}/${mode.label}"`;
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
 * @param {() => string[] | Promise<string[]>} [deps.listSkillNames] - 已有技能名，交给模型确认要改哪一个。
 * @param {(agent: object, text: string) => void} deps.submit - 把一段话交给模型。
 * @param {(message: string, error?: unknown) => void} [deps.warn] - 降级日志。
 * @returns {object} 命令定义。
 */
export function createBrowserCommand(deps) {
  const { instance, listTabs, openTab, focusPanel, submit } = deps;
  const listSkillNames = typeof deps.listSkillNames === 'function' ? deps.listSkillNames : () => [];
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
    const skillRequest = parseSkillRequest(rest);
    if (skillRequest) {
      let snapshot;
      try {
        snapshot = await instance.ensure({ reason: 'command' });
      } catch (error) {
        warn('命令启动实例失败', error);
        snapshot = instance.status();
      }
      focusPanel(null);
      let names = [];
      try {
        const listed = await listSkillNames();
        names = Array.isArray(listed) ? listed.filter((entry) => typeof entry === 'string' && entry !== '') : [];
      } catch (error) {
        warn('列已有技能失败', error);
      }
      submit(agent, composeSkillPrompt(skillRequest, rest, names));
      const ready = snapshot?.state === 'running';
      return {
        kind: 'success',
        text: ready
          ? '已交给模型。它会先确认你是要新增、保存还是修改，你同意之后才会写入胶片条下面。'
          : '已交给模型。它会先确认你的意图；浏览器没启动，你同意之后仍会写入胶片条下面的名单。',
      };
    }
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
        if (existing) tab = { targetId: existing.id, url: existing.url, title: existing.title ?? '' };
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

    submit(agent, composePrompt({
      url: found.href,
      targetId: tab?.targetId ?? '',
      title: tab?.title ?? '',
      instruction,
    }));
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
    input: { hint: '[--new] [url] [指令] | 新增技能 | 新增skill | 保存技能 | 保存skill | 修改技能 | 修改skill' },
    handler,
  };
}
