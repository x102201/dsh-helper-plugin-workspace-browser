/**
 * dsh-helper-plugin-workspace-browser 客户端半边（浏览器侧）。
 *
 * ## 为什么是 ModuleLoader 工厂而不是 ESM
 *
 * Web UI 以经典脚本的 ModuleLoader 工厂加载客户端插件：`factory(require)`
 * 只解析平台的种子词（`react`、`react/jsx-runtime`…），别的会抛错。所以这个
 * 文件用 `React.createElement` 而不用 JSX，也不 import 任何东西 —— 它由
 * `package.json` 的 `dsh.client` 声明加载。
 *
 * ## P0 提供的东西
 *
 * - **胶囊**（`conversation.input.right`）：点一下**只打开小面板**，不启动浏览器。
 * - **小面板**：启动 / 重试、停止（带确认）、复制端点、跨域开关、打开浏览器画面。
 * - **画面 tab 类型**：`openTab('workspace-browser-mirror')` 会展开右栏。
 *
 * ## P3 提供的东西：右侧栏的实时画面
 *
 * 正文按 DESIGN §5 做「焦点 + 胶片条」：
 *
 * - 上面一张焦点画面、下面一排缩略图，中间的分隔条可拖并写回 `panelTileSplit`。
 * - 所有画面按**原始视口比例**等比缩放（`object-fit: contain`），不拉伸、不裁剪；
 *   高度不够时左右留白用面板底色。
 * - 三种状态标记走**三个互不重叠的位置 + 颜色/形状双编码**：外框（焦点）、下划线
 *   （窗口里最顶层）、左上角圆点（CDP 已接管 / 未接管）。
 * - 只有这张卡片真的看得见（`useTabInfo().tab.visible`）才连画面 WebSocket；
 *   全都不看了就断开，绝不让后端空跑。
 *
 * 数据只有一个来源：同源的 `GET /dsh-helper-plugin-workspace-browser/status`
 * 加上画面通道 `…/stream`（P3）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-helper-plugin-workspace-browser',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    /**
     * React 由 ModuleLoader 的 `require('react')` 提供。声明在工厂作用域，
     * 由 `apply` 在挂载时赋值 —— 模块级的组件与工具函数都读这个变量。
     */
    let React;

    const PLUGIN_NAME = 'dsh-helper-plugin-workspace-browser';
    const ROUTE_PREFIX = '/dsh-helper-plugin-workspace-browser';
    const LOCALE_NS = 'workspace-browser';
    const CAPSULE_SLOT = 'conversation.input.right';
    const CAPSULE_ID = 'workspace-browser';
    // 会话头部那个图标按钮（`conversation.session.header.utilities`，曾经 order -9）
    // 已按用户要求**去掉**：打开画面从胶囊、或从右侧栏本身都能做，多一个入口只是噪声。
    const PANE_TAB_SLOT = 'sidebar.right.pane.tab';
    const TAB_ID = 'workspace-browser/mirror';
    const TAB_KIND = 'workspace-browser-mirror';
    const POLL_MS = 2000;
    /** 输入框引用芯片的 source 名（须与 inputTriggers 注册名一致，发送时靠它找 codec）。 */
    const TAB_REF_SOURCE = 'workspace-browser';
    const SKILL_REF_SOURCE = 'workspace-browser-skill';

    const COPY = {
      zh: {
        capsuleIdle: '工作区浏览器',
        capsuleLaunching: '工作区浏览器 · 启动中…',
        capsuleStopping: '工作区浏览器 · 停止中…',
        capsuleRunning: '工作区浏览器 · 运行中',
        capsuleFailed: '工作区浏览器 · 失败',
        capsuleNoChrome: '工作区浏览器 · 未检测到 Chrome',
        capsuleTooOld: '工作区浏览器 · Chrome 版本过低',
        capsuleAmbiguous: '工作区浏览器 · 检测到多个 Chrome',
        start: '启动',
        retry: '重试',
        stop: '停止',
        stopConfirm: '停止会关掉这个工作区的浏览器，所有会话都会失去它。确定停止？',
        stopYes: '确定停止',
        cancel: '取消',
        copyEndpoint: '复制端点',
        copied: '已复制',
        crossOrigin: '跨域开关',
        crossOriginNote: '要重启，已打开的标签会关掉',
        openPanel: '打开浏览器画面',
        allowWrite: '允许模型操作',
        allowed: '已允许',
        chromeMissingTitle: '未检测到 Chrome',
        chromeMissingBody: '请在本机安装 Chrome，或指定 chrome.exe 的路径。',
        chromeTooOld: (version, min) => `检测到 ${version}，最低需要 ${min}。请安装或升级 Chrome。`,
        chromeAmbiguous: (count) => `检测到 ${count} 个 Chrome，请在插件配置里选定一个。`,
        recheckHint: '在 设置 → 插件 → 插件配置 里指定路径后点「重新检测」。',
        panelTitle: '工作区浏览器',
        notRunning: '未启动',
        startFromPanel: '启动工作区浏览器',
        tabs: '标签',
        noTabs: '还没有标签页。',
        profile: '数据目录',
        port: '端口',
        pause: '暂停画面',
        // ── P3 画面 ────────────────────────────────────────────────────────
        mirrorTitle: '工作区浏览器',
        mirrorPause: '⏸ 暂停画面',
        mirrorResume: '▶ 继续画面',
        mirrorFps: '帧率',
        mirrorLegend: '图例',
        mirrorLegendTitle: '画面上的三个标记（颜色 + 形状双编码）',
        mirrorLegendFocus: '外框（四边）= 正在上面这张主画面里显示的标签',
        mirrorLegendFront: '下划线（底部短横）= 那个窗口里最顶层的标签',
        mirrorLegendAttached: '圆点（左上角）：绿 = CDP 已接管，灰 = 未接管（常见原因：调试通道没连上）',
        mirrorLegendNote: '窗口最小化导致全部标签都不可见时，下划线沿用最后一次结果并在悬停里标明「推断」。',
        mirrorInferred: '推断（窗口最小化时沿用最后一次结果）',
        mirrorLive: '画面进行中',
        mirrorConnecting: '连接中…',
        mirrorPaused: '画面已暂停',
        mirrorError: '画面连接出错',
        mirrorIdle: '未连接',
        mirrorCdpDown: '调试通道未连上（有标题无画面时通常是这个原因，请点「重新检测」或重启浏览器）',
        mirrorWaiting: '正在等第一帧…（空白页或静止页可能较慢）',
        mirrorNoFrame: '这张标签还没有画面',
        mirrorBringFront: '显示浏览器窗口',
        mirrorAssignToModel: '加入对话',
        mirrorAssignDone: '已加入对话',
        mirrorAssignNoInput: '当前会话没有输入框',
        atSectionTabs: '浏览器标签',
        atSectionSkills: '技能',
        skillUsage: '在输入框里管理技能：/browser 新增技能 或 /browser 新增skill；/browser 保存技能 或 /browser 保存skill；/browser 修改技能 或 /browser 修改skill。模型会先确认你的意图，你同意之后才会写入下面的名单。点名字只查看。@ 或「加入对话」只放入技能名，发出去之后模型才看到全文。',
        skillUsageLabel: 'Skill',
        skillMenuOpen: '查看',
        skillMenuReveal: '在文件资源管理器中显示',
        skillMenuDelete: '删除',
        skillEmpty: '还没有技能。',
        mirrorCloseTab: '关闭标签',
        mirrorCopyUrl: '复制 URL',
        mirrorOpenTab: '在新标签打开',
        mirrorNewTab: '新建标签页',
        mirrorNoTabsTitle: '已启动，但还没有可显示的标签',
        mirrorNoTabsHint: 'about:blank 空白页默认不出现在胶片条里。请在浏览器里打开网页，或点下面新建标签页。',
        mirrorRetry: '重新检测',
        mirrorDownload: '去下载 Chrome',
        mirrorSetPath: '指定 chrome.exe',
        mirrorTileFocus: '正在主画面里显示这张',
        mirrorTileFront: '这个窗口里最顶层的标签',
        mirrorTileAttached: 'CDP 已接管（工具或画面正在用它）',
        mirrorTileDetached: '未接管（调试通道未连上，或还没采到画面）',
        mirrorSplitHint: '拖动调整焦点区与胶片条的高度（会记住）',
        mirrorSkillSplitHint: '拖动调整胶片条与技能区的高度（会记住）',
        mirrorActionFailed: '操作失败',
      },
      en: {
        capsuleIdle: 'Workspace browser',
        capsuleLaunching: 'Workspace browser · starting…',
        capsuleStopping: 'Workspace browser · stopping…',
        capsuleRunning: 'Workspace browser · running',
        capsuleFailed: 'Workspace browser · failed',
        capsuleNoChrome: 'Workspace browser · Chrome not found',
        capsuleTooOld: 'Workspace browser · Chrome too old',
        capsuleAmbiguous: 'Workspace browser · multiple Chrome found',
        start: 'Start',
        retry: 'Retry',
        stop: 'Stop',
        stopConfirm: 'Stopping closes this workspace’s browser for every session. Stop it?',
        stopYes: 'Stop it',
        cancel: 'Cancel',
        copyEndpoint: 'Copy endpoint',
        copied: 'Copied',
        crossOrigin: 'Cross-origin',
        crossOriginNote: 'Restarts the instance and closes open tabs',
        openPanel: 'Open the browser view',
        allowWrite: 'Allow model actions',
        atSectionTabs: 'Browser tabs',
        atSectionSkills: 'Skills',
        skillUsage: 'Manage skills from the composer: /browser 新增技能 or 新增skill; /browser 保存技能 or 保存skill; /browser 修改技能 or 修改skill. The model confirms your intent first, and writes the list only after you agree. Click a name only to read it. @ or Add to chat inserts the name; the model sees the full steps after you send.',
        skillUsageLabel: 'Skill',
        skillMenuOpen: 'Open',
        skillMenuReveal: 'Show in File Explorer',
        skillMenuDelete: 'Delete',
        skillEmpty: 'No skills yet.',
        allowed: 'Allowed',
        chromeMissingTitle: 'Chrome not found',
        chromeMissingBody: 'Install Chrome on this machine, or point to chrome.exe.',
        chromeTooOld: (version, min) => `Found ${version}; at least ${min} is required. Please install or update Chrome.`,
        chromeAmbiguous: (count) => `Found ${count} Chrome installs; pick one in the plugin config.`,
        recheckHint: 'Set the path in Settings → Plugins → Plugin config, then recheck.',
        panelTitle: 'Workspace browser',
        notRunning: 'Not started',
        startFromPanel: 'Start the workspace browser',
        tabs: 'Tabs',
        noTabs: 'No tabs yet.',
        profile: 'Data directory',
        port: 'Port',
        pause: 'Pause',
        // ── P3 mirror ─────────────────────────────────────────────────────
        mirrorTitle: 'Workspace browser',
        mirrorPause: '⏸ Pause',
        mirrorResume: '▶ Resume',
        mirrorFps: 'Rate',
        mirrorLegend: 'Legend',
        mirrorLegendTitle: 'The three markers (colour + shape, colour-blind safe)',
        mirrorLegendFocus: 'Outer border (all four sides) = the tab shown in the hero',
        mirrorLegendFront: 'Underline (short bar below) = the frontmost tab of that window',
        mirrorLegendAttached: 'Dot (top-left): green = CDP attached, grey = not attached (often means the debug channel is down)',
        mirrorLegendNote: 'When the window is minimised and every tab is hidden, the underline reuses the last result and says “inferred” on hover.',
        mirrorInferred: 'inferred (last result reused while the window is minimised)',
        mirrorLive: 'Streaming',
        mirrorConnecting: 'Connecting…',
        mirrorPaused: 'Paused',
        mirrorError: 'Stream error',
        mirrorIdle: 'Not connected',
        mirrorCdpDown: 'Debug channel is down (titles without frames usually mean this — tap Recheck or restart the browser)',
        mirrorWaiting: 'Waiting for the first frame… (blank or static pages can be slow)',
        mirrorNoFrame: 'No frames for this tab yet',
        mirrorBringFront: 'Show browser window',
        mirrorAssignToModel: 'Add to chat',
        mirrorAssignDone: 'Added to chat',
        mirrorAssignNoInput: 'No composer for this session',
        mirrorCloseTab: 'Close tab',
        mirrorCopyUrl: 'Copy URL',
        mirrorOpenTab: 'Open in new tab',
        mirrorNewTab: 'New tab',
        mirrorNoTabsTitle: 'Running, but no displayable tabs',
        mirrorNoTabsHint: 'about:blank tabs are hidden from the filmstrip. Open a page in the browser, or create a new tab below.',
        mirrorRetry: 'Recheck',
        mirrorDownload: 'Download Chrome',
        mirrorSetPath: 'Pick chrome.exe',
        mirrorTileFocus: 'Shown in the hero',
        mirrorTileFront: 'Frontmost tab of this window',
        mirrorTileAttached: 'CDP attached (a tool or the mirror is using it)',
        mirrorTileDetached: 'Not attached (debug channel down, or no frame yet)',
        mirrorSplitHint: 'Drag to resize the hero and the filmstrip (remembered)',
        mirrorSkillSplitHint: 'Drag to resize the filmstrip and the skill area (remembered)',
        mirrorActionFailed: 'Action failed',
      },
    };

    /** 自绘的「浏览器窗口」简笔，不用 Google 官方 logo。 */
    function browserGlyph(color, size) {
      return React.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('rect', {
          x: 1.5,
          y: 2.5,
          width: 13,
          height: 11,
          rx: 1.5,
          fill: 'none',
          stroke: color,
          strokeWidth: 1.4,
        }),
        React.createElement('line', { x1: 1.5, y1: 5.5, x2: 14.5, y2: 5.5, stroke: color, strokeWidth: 1.4 }),
      );
    }

    /** 同源请求控制面。`signal` 用来取消已经过期的 `@` 补全请求。 */
    async function callControl(path, options = {}) {
      const response = await fetch(`${ROUTE_PREFIX}${path}`, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const detail =
          payload !== null && typeof payload === 'object' && typeof payload.error === 'string' && payload.error !== ''
            ? payload.error
            : `${response.status} ${response.statusText}`;
        throw new Error(detail);
      }
      return payload;
    }

    /**
     * 胶片条不展示的空标签（about:blank 及其带 hash/query 的变体）。
     *
     * @param {unknown} url - 网址。
     * @returns {boolean} 是否该过滤。
     */
    function isAboutBlankUrl(url) {
      if (typeof url !== 'string' || url === '') return false;
      return url === 'about:blank' || url.startsWith('about:blank#') || url.startsWith('about:blank?');
    }

    /**
     * 「加入对话」芯片发给模型和写进对话的 mention。
     *
     * 气泡把 `@"…"` 画成文件芯片，脸上是最后一段（页面标题），`title` 提示是整段原文。
     * 所以悬浮看到的就是这段：外部浏览器、网址、targetId，标题放在最后一个斜杠后面。
     *
     * @param {object} target - 胶片条标签或 ref 解码结果。
     * @returns {string} `@"外部浏览器｜网址 …｜targetId …/<标题>"`。
     */
    function composeTabDraftSnippet(target) {
      const targetId = typeof target?.targetId === 'string' ? target.targetId.trim() : '';
      const url = typeof target?.url === 'string' ? target.url.trim() : '';
      const title = typeof target?.title === 'string' ? target.title : '';
      const host = hostOf(url);
      const label = mentionLabel(title) || mentionLabel(host) || mentionLabel(targetId) || '标签';
      const bits = ['外部浏览器'];
      const safeUrl = url.replace(/["\r\n]/g, '');
      const safeId = targetId.replace(/["\r\n]/g, '');
      if (safeUrl !== '') bits.push(`网址 ${safeUrl}`);
      if (safeId !== '') bits.push(`targetId ${safeId}`);
      return `@"${bits.join('｜')}/${label}"`;
    }

    /**
     * 芯片上显示的那一段。引号和换行会截断 `@"…"`，斜杠会被气泡再切成路径。
     *
     * @param {string} value - 原始文本。
     * @returns {string} 单段标签。
     */
    function mentionLabel(value) {
      return value.replace(/[\r\n"]/g, ' ').replace(/[\\/]/g, '／').trim();
    }

    /**
     * 芯片 ref：JSON，发送时再展开；剪贴板用短令牌。
     *
     * @param {object} target - 胶片条标签。
     * @returns {{ ref: string, clipboardText: string, label: string }} 芯片字段。
     */
    function tabReferenceParts(target) {
      const targetId = typeof target?.targetId === 'string' ? target.targetId : '';
      const url = typeof target?.url === 'string' ? target.url : '';
      const title = typeof target?.title === 'string' ? target.title : '';
      const rawLabel = title.trim() !== '' ? title.trim() : hostOf(url) !== '' ? hostOf(url) : targetId !== '' ? targetId : 'tab';
      const label = rawLabel.length > 28 ? `${rawLabel.slice(0, 27)}…` : rawLabel;
      return {
        ref: JSON.stringify({ targetId, url, title }),
        clipboardText: composeTabDraftSnippet(target),
        label,
      };
    }

    /**
     * 把浏览器标签插成输入框里的引用芯片（类似文件 `@` pill），不发送。
     *
     * @param {object} ctx - 客户端根上下文。
     * @param {string} sessionId - 当前会话。
     * @param {object} target - 胶片条标签。
     * @returns {{ ok: boolean, error?: string }} 是否插入成功。
     */
    function insertTabReferenceChip(ctx, sessionId, target) {
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: 'no-session' };
      const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined;
      const input = conversation?.input;
      if (!input || typeof input.shell !== 'function') return { ok: false, error: 'no-input' };
      let shell;
      try {
        shell = input.shell(sessionId);
      } catch {
        return { ok: false, error: 'no-shell' };
      }
      if (!shell || typeof shell.insertReference !== 'function') return { ok: false, error: 'no-insert' };

      const parts = tabReferenceParts(target);
      const reference = {
        source: TAB_REF_SOURCE,
        ref: parts.ref,
        label: parts.label,
        appearance: 'file',
        clipboardText: parts.clipboardText,
      };

      const snap = shell.snapshot;
      const draftRev = typeof snap?.draftRev === 'number' ? snap.draftRev : 0;
      let start = 0;
      let end = 0;
      if (typeof shell.caretSpan === 'function') {
        const caret = shell.caretSpan();
        start = typeof caret?.start === 'number' ? caret.start : 0;
        end = typeof caret?.end === 'number' ? caret.end : start;
      } else if (typeof snap?.draft === 'string') {
        start = end = snap.draft.length;
      }

      try {
        const ok = shell.insertReference(reference, { start, end, draftRev });
        return ok ? { ok: true } : { ok: false, error: 'insert-rejected' };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    /**
     * 把技能插成输入框芯片。脸上只有名字，步骤在发送时由 codec 展开。
     *
     * @param {object} ctx - 客户端根上下文。
     * @param {string} sessionId - 当前会话。
     * @param {object} skill - `{ name }`。
     * @returns {{ ok: boolean, error?: string }} 是否插入成功。
     */
    function insertSkillReferenceChip(ctx, sessionId, skill) {
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: 'no-session' };
      const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
      if (name === '') return { ok: false, error: 'no-name' };
      const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined;
      const input = conversation?.input;
      if (!input || typeof input.shell !== 'function') return { ok: false, error: 'no-input' };
      let shell;
      try {
        shell = input.shell(sessionId);
      } catch {
        return { ok: false, error: 'no-shell' };
      }
      if (!shell || typeof shell.insertReference !== 'function') return { ok: false, error: 'no-insert' };
      const reference = {
        source: SKILL_REF_SOURCE,
        ref: JSON.stringify({ name }),
        label: name,
        appearance: 'file',
        clipboardText: name,
      };
      const snap = shell.snapshot;
      const draftRev = typeof snap?.draftRev === 'number' ? snap.draftRev : 0;
      let start = 0;
      let end = 0;
      if (typeof shell.caretSpan === 'function') {
        const caret = shell.caretSpan();
        start = typeof caret?.start === 'number' ? caret.start : 0;
        end = typeof caret?.end === 'number' ? caret.end : start;
      } else if (typeof snap?.draft === 'string') {
        start = end = snap.draft.length;
      }
      try {
        const ok = shell.insertReference(reference, { start, end, draftRev });
        return ok ? { ok: true } : { ok: false, error: 'insert-rejected' };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    /**
     * 注册「技能」引用源。选中后插入不展开的芯片，发送时再向 `/skills` 取全文。
     *
     * @param {object} ctx - 客户端上下文。
     * @returns {() => void} 注销。
     */
    function attachSkillReferenceSource(ctx) {
      const inputTriggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined;
      if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') return () => {};
      try {
        return inputTriggers.registerSource({
          trigger: '@',
          name: SKILL_REF_SOURCE,
          order: 46,
          showGroupTitle: false,
          candidates: async (_session, req) => {
            if (req?.signal?.aborted) return [];
            let payload;
            try {
              payload = await callControl('/skills', { signal: req?.signal });
            } catch {
              return [];
            }
            if (req?.signal?.aborted) return [];
            const needle = typeof req?.query === 'string' ? req.query.trim().toLocaleLowerCase() : '';
            const section = (() => {
              const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
              if (locale && typeof locale.bind === 'function') {
                try {
                  const label = locale.bind(LOCALE_NS)('atSectionSkills');
                  if (typeof label === 'string' && label !== '' && label !== 'atSectionSkills') return label;
                } catch {
                  /* 词典未注册 */
                }
              }
              return COPY.zh.atSectionSkills;
            })();
            const rows = [];
            for (const skill of Array.isArray(payload?.skills) ? payload.skills : []) {
              const name = typeof skill?.name === 'string' ? skill.name : '';
              if (name === '') continue;
              const description = typeof skill?.description === 'string' ? skill.description : '';
              if (needle !== '' && !`${name}\n${description}`.toLocaleLowerCase().includes(needle)) continue;
              rows.push({
                name,
                ...(description === '' ? {} : { description }),
                icon: 'file',
                section,
                value: JSON.stringify({ name }),
              });
            }
            return rows;
          },
          onPick: ({ candidate }) => {
            if (typeof candidate?.value !== 'string' || candidate.value === '') return undefined;
            let skill;
            try {
              skill = JSON.parse(candidate.value);
            } catch {
              return undefined;
            }
            const name = typeof skill?.name === 'string' ? skill.name : '';
            if (name === '') return undefined;
            return {
              insert: {
                source: SKILL_REF_SOURCE,
                ref: JSON.stringify({ name }),
                label: name,
                appearance: 'file',
                clipboardText: name,
              },
            };
          },
          codec: {
            clipboardText: (ref) => {
              try {
                return JSON.parse(ref).name ?? ref;
              } catch {
                return ref;
              }
            },
            serialize: async (ref) => {
              let name = '';
              try {
                name = JSON.parse(ref).name ?? '';
              } catch {
                return ref;
              }
              try {
                const payload = await callControl(`/skills?name=${encodeURIComponent(name)}`);
                if (typeof payload?.skill?.mention === 'string' && payload.skill.mention !== '') return payload.skill.mention;
              } catch {
                /* 展开失败时至少把名字交给模型 */
              }
              return `@"技能｜请先 workspace_browser_snapshot，再按名为「${name}」的技能操作/${name}"`;
            },
          },
        });
      } catch (error) {
        console.error('[workspace-browser] 技能引用源注册失败', error);
        return () => {};
      }
    }

    /** `@` 菜单里浏览器标签这一组最多列这么多，避免把文件和会话顶出视口。 */
    const TAB_MENTION_LIMIT = 30;

    /**
     * `@` 菜单「浏览器标签」分组名。词典还没挂上时用中文。
     *
     * @param {object} ctx - 客户端上下文。
     * @returns {string} 分组标题。
     */
    function mentionSectionLabel(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
      if (locale && typeof locale.bind === 'function') {
        try {
          const label = locale.bind(LOCALE_NS)('atSectionTabs');
          if (typeof label === 'string' && label !== '' && label !== 'atSectionTabs') return label;
        } catch {
          // 词典未注册时落到下面的中文。
        }
      }
      return COPY.zh.atSectionTabs;
    }

    /**
     * 把 `/targets` 收成 `@` 菜单行。`about:blank` 默认不出现；查询匹配标题、网址或主机。
     *
     * @param {Array<object>} targets - `/targets` 的 `targets`。
     * @param {string} query - `@` 后面已经输入的文字。
     * @param {string} section - 分组标题。
     * @returns {Array<object>} 菜单候选项。
     */
    function mentionTabCandidates(targets, query, section) {
      const needle = typeof query === 'string' ? query.trim().toLocaleLowerCase() : '';
      const rows = [];
      for (const item of Array.isArray(targets) ? targets : []) {
        if (item === null || typeof item !== 'object') continue;
        const targetId = typeof item.id === 'string' ? item.id : typeof item.targetId === 'string' ? item.targetId : '';
        if (targetId === '') continue;
        const url = typeof item.url === 'string' ? item.url : '';
        if (isAboutBlankUrl(url)) continue;
        const title = typeof item.title === 'string' ? item.title.trim() : '';
        const host = hostOf(url);
        if (needle !== '') {
          const haystack = `${title}\n${url}\n${host}`.toLocaleLowerCase();
          if (!haystack.includes(needle)) continue;
        }
        const name = title !== '' ? title : host !== '' ? host : targetId;
        const description = title !== '' && host !== '' ? host : undefined;
        rows.push({
          name,
          ...(description === undefined ? {} : { description }),
          icon: 'file',
          section,
          value: JSON.stringify({ targetId, url, title }),
        });
        if (rows.length >= TAB_MENTION_LIMIT) break;
      }
      return rows;
    }

    /**
     * 注册「浏览器标签」引用源：`@` 菜单列出当前标签，选中后插入芯片，不发送。
     *
     * @param {object} ctx - 客户端上下文。
     * @returns {() => void} 注销。
     */
    function attachTabReferenceSource(ctx) {
      // 调用方必须先 `inject(['inputTriggers'])`：插件主体的 effect 跑得太早时，
      // 这个服务还没激活，`get` 会拿到 undefined，codec 就永远没注册。
      const inputTriggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined;
      if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') return () => {};
      try {
        return inputTriggers.registerSource({
          trigger: '@',
          name: TAB_REF_SOURCE,
          order: 45,
          showGroupTitle: false,
          candidates: async (_session, req) => {
            if (req?.signal?.aborted) return [];
            let payload;
            try {
              payload = await callControl('/targets', { signal: req?.signal });
            } catch {
              return [];
            }
            if (req?.signal?.aborted) return [];
            return mentionTabCandidates(payload?.targets, req?.query ?? '', mentionSectionLabel(ctx));
          },
          onPick: ({ candidate }) => {
            if (typeof candidate?.value !== 'string' || candidate.value === '') return undefined;
            let target;
            try {
              target = JSON.parse(candidate.value);
            } catch {
              return undefined;
            }
            const parts = tabReferenceParts(target);
            return {
              insert: {
                source: TAB_REF_SOURCE,
                ref: parts.ref,
                label: parts.label,
                appearance: 'file',
                clipboardText: parts.clipboardText,
              },
            };
          },
          codec: {
            clipboardText: (ref) => {
              try {
                return composeTabDraftSnippet(JSON.parse(ref));
              } catch {
                return ref;
              }
            },
            serialize: async (ref) => {
              try {
                return composeTabDraftSnippet(JSON.parse(ref));
              } catch {
                return ref;
              }
            },
          },
        });
      } catch (error) {
        console.error('[workspace-browser] 浏览器标签引用源注册失败', error);
        return () => {};
      }
    }

    /**
     * 胶片条用的标签列表（去掉 about:blank）。
     *
     * @param {Array<object>} targets - 原始列表。
     * @returns {Array<object>} 过滤后的列表。
     */
    function filmstripTargets(targets) {
      if (!Array.isArray(targets)) return [];
      return targets.filter((target) => target !== null && typeof target === 'object' && !isAboutBlankUrl(target.url));
    }

    /**
     * 状态仓库：一个 2 秒轮询 + 手动刷新，所有座位共享。
     *
     * @returns {object} store。
     */
    function createStatusStore() {
      let snapshot = { status: 'loading', value: null, error: '' };
      const listeners = new Set();
      let timer = null;
      let inflight = false;

      const emit = () => {
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            /* 单个座位出错不影响别人 */
          }
        }
      };

      async function refresh() {
        if (inflight) return;
        inflight = true;
        try {
          const value = await callControl('/status');
          snapshot = { status: 'ready', value, error: '' };
        } catch (error) {
          snapshot = { status: 'error', value: snapshot.value, error: error instanceof Error ? error.message : String(error) };
        } finally {
          inflight = false;
          emit();
        }
      }

      return {
        get: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          if (timer === null) {
            void refresh();
            timer = setInterval(() => {
              void refresh();
            }, POLL_MS);
          }
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0 && timer !== null) {
              clearInterval(timer);
              timer = null;
            }
          };
        },
        refresh,
      };
    }

    /** 等待标签状态用的 hook。 */
    function useStatus(store) {
      const [snapshot, setSnapshot] = React.useState(store.get());
      React.useEffect(() => store.subscribe(() => setSnapshot(store.get())), [store]);
      return snapshot;
    }

    /**
     * 按 DESIGN.zh.md §3 的顺序挑文案：状态优先，其次 Chrome 环境问题。
     *
     * @param {object} value - `/status` 的返回。
     * @param {Function} t - 翻译。
     * @returns {{ text: string, tone: string, detail: string }} 胶囊文案。
     */
    function describeCapsule(value, t) {
      if (!value) return { text: t('capsuleIdle'), tone: 'idle', detail: '' };
      const state = value.state;
      if (state === 'launching') return { text: t('capsuleLaunching'), tone: 'busy', detail: '' };
      if (state === 'stopping') return { text: t('capsuleStopping'), tone: 'busy', detail: '' };
      if (state === 'failed') return { text: t('capsuleFailed'), tone: 'failed', detail: value.lastError ?? '' };
      const chrome = value.chrome ?? { state: 'missing' };
      if (state !== 'running') {
        if (chrome.state === 'missing') return { text: t('capsuleNoChrome'), tone: 'warn', detail: (chrome.searched ?? []).join('\n') };
        if (chrome.state === 'too-old') {
          return { text: t('capsuleTooOld'), tone: 'warn', detail: `${chrome.version} < ${chrome.minVersion}` };
        }
        if (chrome.state === 'ambiguous') {
          return { text: t('capsuleAmbiguous'), tone: 'warn', detail: (chrome.candidates ?? []).map((item) => item.path).join('\n') };
        }
        return { text: t('capsuleIdle'), tone: 'idle', detail: chrome.path ?? '' };
      }
      return {
        text: value.settings?.capsuleShowPort === false ? t('capsuleRunning') : `${t('capsuleRunning')} · ${value.port}`,
        tone: 'running',
        detail: `${chrome.path ?? ''} ${chrome.version ?? ''}`.trim(),
      };
    }

    /** tone → 颜色。 */
    const TONE_COLOR = {
      idle: 'currentColor',
      busy: '#a1660a',
      warn: '#a1660a',
      failed: '#c0392b',
      running: '#1a7f37',
    };

    /**
     * 胶囊：点一下**只打开小面板**，任何状态下都能点。
     *
     * @param {object} props - 座位属性。
     * @returns {object} React 元素。
     */
    function Capsule(props) {
      const { store, t, locale, sessionId, requestPanelOpen } = props;
      const snapshot = useStatus(store);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState('');
      const [note, setNote] = React.useState('');
      const [confirmStop, setConfirmStop] = React.useState(false);
      const value = snapshot.value;
      const capsule = describeCapsule(value, t);
      const color = TONE_COLOR[capsule.tone] ?? 'currentColor';

      const act = async (label, fn) => {
        setBusy(label);
        setNote('');
        try {
          await fn();
          await store.refresh();
        } catch (error) {
          setNote(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy('');
        }
      };

      const button = (label, onClick, extra = {}) =>
        React.createElement(
          'button',
          {
            type: 'button',
            onClick,
            disabled: busy !== '',
            style: {
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '8px 10px',
              border: 'none',
              borderRadius: 10,
              background: 'transparent',
              cursor: busy === '' ? 'pointer' : 'default',
              opacity: busy === '' ? 1 : 0.5,
              fontSize: 13,
              fontWeight: 500,
              lineHeight: '20px',
              color: 'var(--dsw-alias-label-secondary, inherit)',
              ...extra,
            },
            onMouseEnter: (event) => {
              if (busy !== '') return;
              event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,0.06))';
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.background = 'transparent';
            },
          },
          label,
        );

      const state = value?.state ?? 'idle';
      const chromeState = value?.chrome?.state ?? 'missing';

      const rows = [];
      // 启动成功就把小面板**收起来**（用户要求）：启动之后该看的是右侧栏画面，
      // 输入框那一行的面板不该继续占着。失败时保持展开，好让人看见原因。
      const startThenCollapse = (label, run) => {
        void act(label, run).then(() => {
          if (store.get().value?.state === 'running') setOpen(false);
        });
      };
      if (state === 'failed') {
        rows.push(button(`${busy === 'retry' ? '…' : t('retry')}`, () => startThenCollapse('retry', () => callControl('/launch', { method: 'POST', body: {} }))));
      } else if (state === 'idle') {
        rows.push(
          button(t('start'), () => {
            // `too-old` 挡下来并说明。`missing` 仍然放行：宿主启动前还会再探测一次。
            if (chromeState === 'too-old') {
              setNote(t('chromeTooOld')(value.chrome.version, value.chrome.minVersion));
              return;
            }
            startThenCollapse('start', async () => {
              await callControl('/launch', { method: 'POST', body: {} });
              requestPanelOpen();
            });
          }),
        );
      } else if (state === 'running') {
        rows.push(button(t('stop'), () => setConfirmStop(true)));
        rows.push(button(t('openPanel'), () => requestPanelOpen()));
        rows.push(
          button(t('copyEndpoint'), () => {
            const text = `http://127.0.0.1:${value.port}${value.wsPath}`;
            void (navigator.clipboard?.writeText(text) ?? Promise.resolve()).then(() => setNote(t('copied')));
          }),
        );
        const crossOn = value.crossOrigin === true;
        rows.push(
          React.createElement(
            'div',
            {
              key: 'cross-origin',
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: '6px 10px',
                fontSize: 12,
                opacity: busy === '' ? 1 : 0.5,
              },
            },
            React.createElement('span', { style: { minWidth: 0 } }, t('crossOrigin')),
            React.createElement(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': crossOn,
                title: t('crossOriginNote'),
                disabled: busy !== '',
                onClick: () => {
                  if (!window.confirm(`${t('crossOrigin')} — ${t('crossOriginNote')}`)) return;
                  void act('cross', () => callControl('/cross-origin', { method: 'POST', body: { enabled: !crossOn } }));
                },
                style: {
                  flex: '0 0 auto',
                  width: 36,
                  height: 20,
                  padding: 0,
                  border: 'none',
                  borderRadius: 10,
                  cursor: busy === '' ? 'pointer' : 'default',
                  background: crossOn ? '#1a7f37' : 'rgba(128,128,128,0.35)',
                  position: 'relative',
                  transition: 'background 120ms ease',
                },
              },
              React.createElement('span', {
                'aria-hidden': 'true',
                style: {
                  position: 'absolute',
                  top: 2,
                  left: crossOn ? 18 : 2,
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  background: '#fff',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.08)',
                  transition: 'left 120ms ease',
                },
              }),
            ),
          ),
        );
      } else {
        rows.push(React.createElement('div', { style: { padding: '6px 10px', fontSize: 12, opacity: 0.7 } }, `${capsule.text}…`));
      }

      const problem = state !== 'running' && value?.chrome && value.chrome.state !== 'ok'
        ? React.createElement(
          'div',
          { style: { padding: '8px 10px', borderTop: '1px solid rgba(128,128,128,0.25)', fontSize: 11, lineHeight: 1.5 } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 2 } }, value.chrome.state === 'too-old' ? t('chromeTooOld')(value.chrome.version, value.chrome.minVersion) : t('chromeMissingBody')),
          React.createElement('div', { style: { opacity: 0.75 } }, t('recheckHint')),
        )
        : null;

      const stopBlock = confirmStop
        ? React.createElement(
          'div',
          { style: { padding: '8px 10px', borderTop: '1px solid rgba(128,128,128,0.25)', fontSize: 11, lineHeight: 1.5 } },
          React.createElement('div', { style: { marginBottom: 6 } }, t('stopConfirm')),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 6 } },
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: () => {
                  setConfirmStop(false);
                  void act('stop', () => callControl('/stop', { method: 'POST' }));
                },
                style: { fontSize: 11, padding: '3px 8px', cursor: 'pointer' },
              },
              t('stopYes'),
            ),
            React.createElement(
              'button',
              { type: 'button', onClick: () => setConfirmStop(false), style: { fontSize: 11, padding: '3px 8px', cursor: 'pointer' } },
              t('cancel'),
            ),
          ),
        )
        : null;

      const panel = open
        ? React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              bottom: 'calc(100% + 8px)',
              right: 0,
              minWidth: 240,
              zIndex: 40,
              background: 'var(--dsw-specific-menu, var(--dsh-color-surface, #ffffff))',
              color: 'var(--dsw-alias-label-primary, var(--dsh-color-text, #1f2328))',
              border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08))',
              borderRadius: 12,
              boxShadow: 'var(--dsw-shadow-lv3, 0 8px 28px rgba(0,0,0,0.14))',
              overflow: 'hidden',
              padding: 4,
            },
          },
          React.createElement(
            'div',
            {
              style: {
                padding: '6px 10px 8px',
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--dsw-alias-label-caption, #8a8f98)',
              },
            },
            capsule.text,
          ),
          React.createElement('div', null, ...rows),
          problem,
          stopBlock,
          value?.lastError && state === 'failed'
            ? React.createElement('div', { style: { padding: '6px 10px', fontSize: 11, color: 'var(--dsw-alias-state-danger-primary, #c0392b)' } }, value.lastError)
            : null,
          note ? React.createElement('div', { style: { padding: '6px 10px', fontSize: 11, color: 'var(--dsw-alias-label-caption, #8a8f98)' } }, note) : null,
        )
        : null;

      return React.createElement(
        'div',
        { style: { position: 'relative', display: 'inline-flex' }, 'data-locale': locale },
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((previous) => !previous),
            title: capsule.detail === '' ? capsule.text : `${capsule.text}\n${capsule.detail}`,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: 28,
              maxWidth: 'min(360px, 45cqw)',
              padding: '0 4px 0 8px',
              borderRadius: 24,
              border: 'none',
              outline: 'none',
              background: open ? 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,0.06))' : 'transparent',
              color: 'var(--dsw-alias-label-secondary, inherit)',
              fontSize: 13,
              fontWeight: 500,
              lineHeight: '20px',
              cursor: 'pointer',
            },
            onMouseEnter: (event) => {
              event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,0.06))';
            },
            onMouseLeave: (event) => {
              if (!open) event.currentTarget.style.background = 'transparent';
            },
            onFocus: (event) => {
              event.currentTarget.style.boxShadow = '0 0 0 2px var(--dsw-alias-border-l3, rgba(0,0,0,0.12))';
            },
            onBlur: (event) => {
              event.currentTarget.style.boxShadow = 'none';
            },
          },
          browserGlyph(color, 14),
          React.createElement(
            'span',
            { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } },
            value?.settings?.capsuleShowPort === false ? capsule.text.replace(/ · \d+$/u, '') : capsule.text,
          ),
          capsule.tone === 'running'
            ? React.createElement('span', {
              style: {
                flex: '0 0 auto',
                width: 6,
                height: 6,
                borderRadius: 3,
                background: 'var(--dsw-alias-state-success-primary, #1a7f37)',
                marginRight: 4,
              },
            })
            : null,
        ),
        panel,
      );
    }

    // ── 画面（P3）：实时镜像 ──────────────────────────────────────────────────
    //
    // ## 一个页面上只有一份画面中枢
    //
    // DESIGN §7：右侧栏每个会话一张，画面内容用客户端上的单例，各会话订同一份。
    // 这里用 `mirrorHubFor(store)` 保证同一个 store（= 同一个插件实例）只造一个中枢：
    // 一个 WebSocket、一份帧缓存、一份标签列表，各会话读同一份。
    //
    // ## 可见性按"有几个会话正看着"计数
    //
    // §5：任何一个会话的 `tab.visible === true`（含浮出的面板）就继续推，全部不可见
    // 才停。每个正文实例进出时给中枢加减一个数，归零就把 WebSocket 关掉 —— 不能让
    // 后端对着没人看的画面空跑。
    //
    // ## 三种状态标记走三个不重叠的位置（色盲友好：颜色 + 形状双编码）
    //
    // | 标记 | 位置 | 形状 | 含义 |
    // |---|---|---|---|
    // | accent 外框 | 整张缩略图四边 | 闭合矩形 | 正在主画面里显示的那张 |
    // | accent 短横 | 图片下方独立一行 | 短横条 | 那个窗口里最顶层的标签 |
    // | 圆点 | 图片左上角 | 6px 圆 | 绿 = CDP 已接管 / 灰 = 未接管 |
    //
    // 三者位置互不重叠，任何一个单独看都能认出来；悬停 tooltip 与面板头的 `?`
    // 各自再解释一遍。

    /** 画面流的路径（与 lib/stream.js 的 `STREAM_PATH` 一致）。 */
    const STREAM_PATH = `${ROUTE_PREFIX}/stream`;

    /** 帧率下拉的取值（§5：焦点 0.5–10 fps）。 */
    const FPS_CHOICES = [0.5, 1, 2, 5, 10];

    /** 主题色。与宿主模型选择器同一套 alias，避免自造「老旧边框按钮」观感。 */
    const MIRROR_ACCENT = 'var(--dsw-alias-brand-primary, #2f6feb)';
    const MIRROR_GREEN = 'var(--dsw-alias-state-success-primary, #1a7f37)';
    const MIRROR_DIM = 'var(--dsw-alias-label-tertiary, #8a8f98)';
    const MIRROR_BORDER = 'var(--dsw-alias-border-l2, rgba(0,0,0,0.08))';
    const MIRROR_SURFACE = 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2, #ffffff))';
    const MIRROR_LABEL = 'var(--dsw-alias-label-secondary, inherit)';
    const MIRROR_HOVER = 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,0.06))';

    /** 小按钮：无描边、圆角、悬停底，贴近模型选择触发器。 */
    const MIRROR_BUTTON = {
      font: 'inherit',
      fontSize: 12,
      fontWeight: 500,
      lineHeight: '18px',
      padding: '4px 10px',
      borderRadius: 8,
      border: 'none',
      background: 'transparent',
      color: MIRROR_LABEL,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    };

    /** 主画面不用缩略图档（常见 maxWidth≈160），否则会先糊再清晰。 */
    function isHeroQualityFrame(frame, focusMaxWidth) {
      if (frame === null || frame === undefined) return false;
      const have = integerOr(frame.maxWidth, 0);
      const need = numberOr(focusMaxWidth, 960);
      if (have <= 0) return true; // 旧帧/截图未带 maxWidth：照常显示
      return have >= need * 0.85;
    }

    /**
     * 读一个数字设置，坏值退回缺省。
     *
     * @param {unknown} value - 原始值。
     * @param {number} fallback - 缺省值。
     * @returns {number} 数字。
     */
    function numberOr(value, fallback) {
      const number = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(number) ? number : fallback;
    }

    /**
     * 读一个整数设置，坏值退回缺省。
     *
     * @param {unknown} value - 原始值。
     * @param {number} fallback - 缺省值。
     * @returns {number} 整数。
     */
    function integerOr(value, fallback) {
      return Math.trunc(numberOr(value, fallback));
    }

    /**
     * 高 DPI 校正系数（§5「高 DPI 先按 devicePixelRatio 校正，仍然等比」）。
     *
     * 只用来把**请求的采集宽度**放大，不改宽高比：比例由 `object-fit: contain` 守住。
     *
     * @returns {number} 1–2 之间的系数。
     */
    function deviceScale() {
      const ratio = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
      return Math.min(2, Math.max(1, numberOr(ratio, 1)));
    }

    /**
     * 取 URL 的 host（画面上只显示这一小段）。
     *
     * @param {string} url - 网址。
     * @returns {string} host；解析不了时给原串。
     */
    function hostOf(url) {
      if (typeof url !== 'string' || url === '') return '';
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'about:') return url;
        return parsed.host === '' ? url : parsed.host;
      } catch {
        return url;
      }
    }

    /**
     * 取 URL 里那一段能认人的路径。
     *
     * @param {string} url - 网址。
     * @returns {string} 路径（最多 40 字）。
     */
    function pathOf(url) {
      if (typeof url !== 'string' || url === '') return '';
      try {
        const parsed = new URL(url);
        const text = `${parsed.pathname}${parsed.search}`.replace(/^\/+$/u, '');
        return text.length > 40 ? `${text.slice(0, 40)}…` : text;
      } catch {
        return '';
      }
    }

    /**
     * 把服务端的 `targets` 下行消息项收敛成客户端用的形状。
     *
     * @param {unknown} raw - 下行消息里的一个元素。
     * @returns {object | null} 收敛结果。
     */
    function normalizeStreamTarget(raw) {
      if (raw === null || typeof raw !== 'object') return null;
      const targetId = typeof raw.targetId === 'string' ? raw.targetId : '';
      if (targetId === '') return null;
      return {
        targetId,
        url: typeof raw.url === 'string' ? raw.url : '',
        title: typeof raw.title === 'string' ? raw.title : '',
        attached: raw.attached === true,
        capturing: raw.capturing === true,
        frontmost: raw.frontmost === true,
        frontmostInferred: raw.frontmostInferred === true,
      };
    }

    /**
     * 把 `GET /targets` 的结果收敛成同一个形状（WebSocket 没连上时的兜底）。
     *
     * @param {unknown} raw - `/targets` 里的一个元素。
     * @returns {object | null} 收敛结果。
     */
    function normalizeHttpTarget(raw) {
      if (raw === null || typeof raw !== 'object') return null;
      const targetId = typeof raw.id === 'string' ? raw.id : '';
      if (targetId === '') return null;
      return {
        targetId,
        url: typeof raw.url === 'string' ? raw.url : '',
        title: typeof raw.title === 'string' ? raw.title : '',
        // HTTP 兜底这条路拿不到接管状态，一律灰点、无下划线。
        attached: false,
        capturing: false,
        frontmost: false,
        frontmostInferred: false,
      };
    }

    /**
     * 标签列表指纹：变了就重新订阅（新标签得有缩略图）。
     *
     * @param {Array<object>} targets - 标签列表。
     * @returns {string} 指纹。
     */
    function targetSignature(targets) {
      return targets.map((target) => target.targetId).join('|');
    }

    /**
     * 造一个画面中枢（一个页面一份）。
     *
     * @param {object} options - 参数。
     * @param {object} options.store - 状态仓库（读 `settings` 与实例状态）。
     * @returns {object} 中枢。
     */
    function createMirrorHub(options) {
      const store = options.store;
      const listeners = new Set();
      /** @type {WebSocket | null} */
      let socket = null;
      let visibleCount = 0;
      let paused = false;
      let closed = false;
      let retryTimer = null;
      let pollTimer = null;
      let fallback = [];
      let fallbackSignature = '';
      let subscribedSignature = '';
      let focusTargetId = '';
      let state = {
        status: 'idle',
        targets: [],
        frames: {},
        capture: null,
        selectedTargetId: '',
        paused: false,
        error: '',
      };

      /** 当前设置（从 `/status` 来的那一份）。 */
      const settingsOf = () => store.get().value?.settings ?? {};

      /** 实例现在是不是运行中。 */
      const running = () => store.get().value?.state === 'running';

      /** 该不该连着画面流：有人看得见、没暂停、浏览器在跑。 */
      const shouldRun = () => visibleCount > 0 && paused !== true && running();

      /**
       * 换掉一份状态并通知订阅者。
       *
       * @param {object} [patch] - 要改的字段。
       * @returns {void}
       */
      function publish(patch) {
        state = { ...state, ...(patch ?? {}) };
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            /* 单个座位出错不影响别人 */
          }
        }
      }

      /**
       * 角色参数：设置 → 上行消息里那三个数（§7）。
       *
       * @param {'focus' | 'thumb'} role - 角色。
       * @returns {{ fps: number, maxWidth: number, quality: number }} 参数。
       */
      function roleParams(role) {
        const settings = settingsOf();
        const scale = deviceScale();
        if (role === 'focus') {
          return {
            fps: numberOr(settings.streamFocusFps, 2),
            maxWidth: Math.round(numberOr(settings.streamFocusMaxWidth, 960) * scale),
            quality: integerOr(settings.streamFocusQuality, 70),
          };
        }
        return {
          fps: numberOr(settings.streamThumbFps, 0.25),
          maxWidth: Math.round(numberOr(settings.streamThumbMaxWidth, 160) * scale),
          quality: integerOr(settings.streamThumbQuality, 50),
        };
      }

      /**
       * 发一条上行消息（连接没开就丢掉）。
       *
       * @param {object} message - 消息体。
       * @returns {void}
       */
      function send(message) {
        if (socket === null || socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify(message));
        } catch {
          /* 发不出去就等下一次订阅 */
        }
      }

      /** 当前该显示的标签列表：优先 WebSocket 里非 blank 的，否则用 HTTP 兜底。 */
      function effectiveTargets() {
        const streamVisible = filmstripTargets(state.targets);
        if (streamVisible.length > 0) return streamVisible;
        // CDP 表可能只有 about:blank 或暂时为空，而 `/json/list` 已有真实标签 ——
        // 真机「已启动但没有标签页」就出在这里：不能因为 WS 里有 blank 就丢掉 HTTP。
        return filmstripTargets(fallback);
      }

      /**
       * 重新订阅：焦点一张，其余全按缩略图。
       *
       * 先 `unsubscribe` 清空再重订，逻辑最简单；标签最多十来张，这点代价可以忽略。
       *
       * @returns {void}
       */
      function resubscribe() {
        if (socket === null || socket.readyState !== 1) return;
        const targets = effectiveTargets();
        if (targets.length === 0) return;
        const focusId = targets.some((target) => target.targetId === focusTargetId)
          ? focusTargetId
          : state.selectedTargetId !== '' && targets.some((target) => target.targetId === state.selectedTargetId)
            ? state.selectedTargetId
            : targets[0].targetId;
        send({ t: 'unsubscribe' });
        send({ t: 'subscribe', targetIds: [focusId], role: 'focus', ...roleParams('focus'), visible: true });
        const thumbs = targets.map((target) => target.targetId).filter((id) => id !== focusId);
        if (thumbs.length > 0) {
          send({ t: 'subscribe', targetIds: thumbs, role: 'thumb', ...roleParams('thumb'), visible: true });
        }
        subscribedSignature = targetSignature(targets);
      }

      /**
       * 处理一条下行消息。
       *
       * @param {unknown} data - `event.data`。
       * @returns {void}
       */
      function onMessage(data) {
        if (typeof data !== 'string') return;
        let message;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        if (message === null || typeof message !== 'object') return;

        if (message.t === 'frame') {
          const targetId = typeof message.targetId === 'string' ? message.targetId : '';
          const dataB64 = typeof message.dataB64 === 'string' ? message.dataB64 : '';
          if (targetId === '' || dataB64 === '') return;
          // 只留最新一帧：`frames` 整个换掉，React 才看得到变化。
          publish({
            frames: {
              ...state.frames,
              [targetId]: {
                dataB64,
                mime: typeof message.mime === 'string' ? message.mime : 'image/jpeg',
                w: integerOr(message.w, 0),
                h: integerOr(message.h, 0),
                seq: integerOr(message.seq, 0),
                maxWidth: integerOr(message.maxWidth, 0),
              },
            },
          });
          // 页面侧 ack：它只决定服务端那条 WebSocket 要不要丢旧帧（§5）。
          send({ t: 'ack', targetId, seq: message.seq });
          return;
        }

        if (message.t === 'targets') {
          const targets = Array.isArray(message.targets)
            ? message.targets.map(normalizeStreamTarget).filter((target) => target !== null)
            : [];
          const patch = {
            targets,
            capture: message.capture ?? null,
            selectedTargetId: typeof message.selectedTargetId === 'string' ? message.selectedTargetId : '',
            error: '',
          };
          if (state.status !== 'live') patch.status = 'live';
          publish(patch);
          if (targetSignature(targets) !== subscribedSignature) resubscribe();
          return;
        }

        if (message.t === 'state') {
          const targetId = typeof message.targetId === 'string' ? message.targetId : '';
          if (targetId === '') return;
          const index = state.targets.findIndex((target) => target.targetId === targetId);
          if (index === -1) return;
          const next = [...state.targets];
          next[index] = {
            ...next[index],
            capturing: message.capturing === true,
            attached: message.attached === true || next[index].attached,
            frontmost: message.frontmost === true,
            frontmostInferred: message.frontmostInferred === true,
          };
          publish({ targets: next });
        }
      }

      /** 清掉重连定时器。 */
      function clearRetry() {
        if (retryTimer !== null) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      }

      /**
       * 断了以后过一会儿再连（浏览器还在跑、还有人看着才排）。
       *
       * @returns {void}
       */
      function scheduleRetry() {
        if (retryTimer !== null || closed || !shouldRun()) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (!shouldRun()) return;
          open();
        }, 3000);
      }

      /** 起 HTTP 兜底轮询（WebSocket 没数据时至少还有标题）。 */
      function ensurePoll() {
        if (pollTimer !== null) return;
        pollTimer = setInterval(() => {
          void pullTargets();
        }, POLL_MS);
        void pullTargets();
      }

      /** 停 HTTP 兜底轮询。 */
      function clearPoll() {
        if (pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }

      /** 拉一次 `GET /targets`（WebSocket 没起来或还没数据时用）。 */
      async function pullTargets() {
        if (closed || !shouldRun()) return;
        try {
          const data = await callControl('/targets');
          const next = Array.isArray(data?.targets) ? data.targets.map(normalizeHttpTarget).filter((target) => target !== null) : [];
          // 瞬时空列表不要冲掉上一份好数据（list 超时常见）。
          if (next.length > 0 || fallback.length === 0) fallback = next;
        } catch {
          /* 保留上一份 fallback */
        }
        const signature = targetSignature(fallback);
        if (signature !== fallbackSignature) {
          fallbackSignature = signature;
          // WS 只有 blank / 空表时也要靠 HTTP 刷新画面。
          if (filmstripTargets(state.targets).length === 0) {
            publish({});
            if (targetSignature(effectiveTargets()) !== subscribedSignature) resubscribe();
          }
        } else if (filmstripTargets(state.targets).length === 0 && filmstripTargets(fallback).length > 0) {
          // 签名没变但也要确保空 WS 时用上 HTTP。
          publish({});
          if (targetSignature(effectiveTargets()) !== subscribedSignature) resubscribe();
        }
      }

      /** 开连接。 */
      function open() {
        if (closed || socket !== null || !shouldRun()) return;
        if (typeof WebSocket !== 'function') {
          publish({ status: 'error', error: 'no-websocket' });
          return;
        }
        let url;
        try {
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          url = `${protocol}//${window.location.host}${STREAM_PATH}`;
        } catch {
          return;
        }
        publish({ status: 'connecting', error: '' });
        let ws;
        try {
          ws = new WebSocket(url);
        } catch (error) {
          publish({ status: 'error', error: error instanceof Error ? error.message : String(error) });
          scheduleRetry();
          return;
        }
        socket = ws;
        subscribedSignature = '';
        ws.onopen = () => {
          if (socket !== ws) return;
          publish({ status: 'live', error: '' });
          resubscribe();
        };
        ws.onmessage = (event) => {
          if (socket === ws) onMessage(event?.data);
        };
        ws.onerror = () => {
          if (socket === ws) publish({ status: 'error', error: 'stream-error' });
        };
        ws.onclose = () => {
          if (socket !== ws) return;
          socket = null;
          subscribedSignature = '';
          publish({ status: shouldRun() ? 'idle' : 'paused' });
          scheduleRetry();
        };
      }

      /**
       * 收掉连接。
       *
       * @param {object} [opts] - 参数。
       * @param {boolean} [opts.keepFrames] - 是否留着最后一帧（暂停时留着，看起来才像"冻结"）。
       * @returns {void}
       */
      function teardown(opts) {
        clearRetry();
        clearPoll();
        if (socket !== null) {
          const ws = socket;
          socket = null;
          try {
            ws.close();
          } catch {
            /* 已经关了 */
          }
        }
        subscribedSignature = '';
        const patch = { status: paused ? 'paused' : 'idle' };
        if (opts?.keepFrames !== true) patch.frames = {};
        publish(patch);
      }

      /**
       * 重新判断"该连还是该断"。状态一变（启动/暂停/可见）就调它。
       *
       * @returns {void}
       */
      function sync() {
        if (closed) return;
        if (!shouldRun()) {
          if (socket !== null || pollTimer !== null) teardown({ keepFrames: paused });
          else if (paused && state.status !== 'paused') publish({ status: 'paused' });
          else if (!paused && visibleCount === 0 && state.status !== 'idle') publish({ status: 'idle' });
          return;
        }
        if (socket === null) open();
        ensurePoll();
      }

      return {
        /** 当前快照（引用在没变化时保持不变）。 */
        getSnapshot: () => ({ ...state, targets: effectiveTargets() }),
        /**
         * 订阅变化。
         *
         * @param {Function} listener - 回调。
         * @returns {() => void} 取消订阅。
         */
        subscribe(listener) {
          listeners.add(listener);
          if (listeners.size === 1) sync();
          return () => {
            listeners.delete(listener);
          };
        },
        /** 这张卡片变得可见。 */
        addVisible() {
          visibleCount += 1;
          sync();
        },
        /** 这张卡片不可见了。 */
        removeVisible() {
          visibleCount = Math.max(0, visibleCount - 1);
          sync();
        },
        /**
         * 暂停 / 继续画面。
         *
         * @param {boolean} next - 是否暂停。
         * @returns {void}
         */
        setPaused(next) {
          paused = next === true;
          if (paused) teardown({ keepFrames: true });
          else sync();
          publish({ paused });
        },
        /**
         * 换主画面显示哪一张（**不动真实前台**）。
         *
         * @param {string} targetId - target。
         * @returns {void}
         */
        setFocusTarget(targetId) {
          const next = typeof targetId === 'string' ? targetId : '';
          if (next === focusTargetId) return;
          focusTargetId = next;
          resubscribe();
        },
        /** 状态一变（启动/停止）重新判断连接。 */
        sync,
        /** 立刻重拉一次标签列表。 */
        refresh() {
          void pullTargets();
        },
        /** 卸载：关连接、停轮询。 */
        dispose() {
          closed = true;
          clearRetry();
          clearPoll();
          if (socket !== null) {
            try {
              socket.close();
            } catch {
              /* 忽略 */
            }
            socket = null;
          }
          listeners.clear();
        },
        /** 调试用：连接是不是开着。 */
        isConnected: () => socket !== null && socket.readyState === 1,
      };
    }

    /** store → 画面中枢（一个页面一份）。 */
    const mirrorHubByStore = new WeakMap();
    /** 造过的中枢，插件卸载时统一收掉。 */
    const liveMirrorHubs = new Set();

    /**
     * 拿这个 store 对应的画面中枢（没有就造）。
     *
     * @param {object} store - 状态仓库。
     * @returns {object} 中枢。
     */
    function mirrorHubFor(store) {
      let hub = mirrorHubByStore.get(store);
      if (hub === undefined) {
        hub = createMirrorHub({ store });
        mirrorHubByStore.set(store, hub);
        liveMirrorHubs.add(hub);
      }
      return hub;
    }

    /** 插件卸载：把所有画面中枢收掉（HMR 重挂时不会留下野连接）。 */
    function disposeMirrorHubs() {
      for (const hub of [...liveMirrorHubs]) {
        try {
          hub.dispose();
        } catch {
          /* 卸载路径上的失败只能忽略 */
        }
      }
      liveMirrorHubs.clear();
    }

    /**
     * 图例弹层：三种标记各画一遍（面板头的 `?`）。
     *
     * @param {object} props - `{ t }`。
     * @returns {object} React 元素。
     */
    function MirrorLegend(props) {
      const { t } = props;
      const row = (glyph, text) =>
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 4 } },
          React.createElement('span', { style: { flex: '0 0 auto', marginTop: 2 } }, glyph),
          React.createElement('span', { style: { flex: '1 1 auto', lineHeight: 1.5 } }, text),
        );
      const box = (style) => React.createElement('span', { style: { display: 'inline-block', width: 14, height: 10, ...style } });
      return React.createElement(
        'div',
        {
          style: {
            position: 'absolute',
            top: '100%',
            right: 4,
            zIndex: 50,
            width: 250,
            padding: '8px 10px',
            fontSize: 11,
            background: MIRROR_SURFACE,
            color: 'inherit',
            border: `1px solid ${MIRROR_BORDER}`,
            borderRadius: 8,
            boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
          },
        },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: 2 } }, t('mirrorLegendTitle')),
        row(box({ border: `2px solid ${MIRROR_ACCENT}`, borderRadius: 2 }), t('mirrorLegendFocus')),
        row(
          React.createElement(
            'span',
            { style: { display: 'inline-flex', flexDirection: 'column', width: 14, height: 10, justifyContent: 'flex-end' } },
            React.createElement('span', { style: { height: 2, background: MIRROR_ACCENT } }),
          ),
          t('mirrorLegendFront'),
        ),
        row(
          React.createElement(
            'span',
            { style: { display: 'inline-block', width: 14, height: 10, position: 'relative' } },
            React.createElement('span', {
              style: { position: 'absolute', left: 1, top: 1, width: 6, height: 6, borderRadius: 3, background: MIRROR_GREEN },
            }),
          ),
          t('mirrorLegendAttached'),
        ),
        React.createElement('div', { style: { marginTop: 6, opacity: 0.7, lineHeight: 1.5 } }, t('mirrorLegendNote')),
      );
    }

    /**
     * 胶片条缩略图：左键点选焦点，右键出菜单（加入对话 / 显示窗口 / 关闭）。
     *
     * 三个标记的落点：**外框**在四边、**下划线**在图片下方的独立一行、**圆点**在图片
     * 左上角 —— 互不重叠，颜色之外还有形状与位置可认。
     *
     * @param {object} props - `{ t, target, frame, isFocus, onPick, onAction }`。
     * @returns {object} React 元素。
     */
    function MirrorTile(props) {
      const { t, target, frame, isFocus, onPick, onAction } = props;
      const [menuPos, setMenuPos] = React.useState(null);
      const rootRef = React.useRef(null);
      const label = target.title !== '' ? target.title : hostOf(target.url) !== '' ? hostOf(target.url) : target.targetId;

      const tips = [
        target.targetId,
        label,
        target.url,
        target.attached ? t('mirrorTileAttached') : t('mirrorTileDetached'),
        isFocus ? t('mirrorTileFocus') : '',
        target.frontmost ? `${t('mirrorTileFront')}${target.frontmostInferred ? `（${t('mirrorInferred')}）` : ''}` : '',
      ].filter((line) => line !== '');

      React.useEffect(() => {
        if (menuPos === null) return undefined;
        const close = (event) => {
          if (event.type === 'keydown' && event.key !== 'Escape') return;
          const root = rootRef.current;
          if (event.type === 'pointerdown' && root && root.contains(event.target)) return;
          setMenuPos(null);
        };
        document.addEventListener('pointerdown', close, true);
        document.addEventListener('keydown', close, true);
        return () => {
          document.removeEventListener('pointerdown', close, true);
          document.removeEventListener('keydown', close, true);
        };
      }, [menuPos]);

      const menuItem = (key, text, danger = false) =>
        React.createElement(
          'button',
          {
            key,
            type: 'button',
            onClick: (event) => {
              event.stopPropagation();
              setMenuPos(null);
              onAction(key, target);
            },
            style: {
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 'none',
              borderRadius: 10,
              padding: '8px 10px',
              font: 'inherit',
              fontSize: 13,
              fontWeight: 500,
              lineHeight: '20px',
              background: 'transparent',
              color: danger
                ? 'var(--dsw-alias-state-danger-primary, #c0392b)'
                : 'var(--dsw-alias-label-secondary, inherit)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            },
            onMouseEnter: (event) => {
              event.currentTarget.style.background = MIRROR_HOVER;
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.background = 'transparent';
            },
          },
          text,
        );

      const menu = menuPos !== null
        ? React.createElement(
          'div',
          {
            role: 'menu',
            style: {
              position: 'fixed',
              top: menuPos.y,
              left: menuPos.x,
              zIndex: 80,
              minWidth: 156,
              padding: 4,
              background: 'var(--dsw-specific-menu, ' + MIRROR_SURFACE + ')',
              border: `1px solid ${MIRROR_BORDER}`,
              borderRadius: 12,
              boxShadow: 'var(--dsw-shadow-lv3, 0 8px 28px rgba(0,0,0,0.14))',
            },
            onPointerDown: (event) => event.stopPropagation(),
          },
          menuItem('assign-model', t('mirrorAssignToModel')),
          menuItem('bring-front', t('mirrorBringFront')),
          menuItem('close', t('mirrorCloseTab'), true),
        )
        : null;

      const image = frame !== undefined && frame !== null
        ? React.createElement('img', {
          src: `data:${frame.mime};base64,${frame.dataB64}`,
          alt: '',
          draggable: false,
          style: {
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
            background: 'transparent',
          },
        })
        : React.createElement(
          'div',
          { style: { fontSize: 9, opacity: 0.55, textAlign: 'center', padding: '14px 2px' } },
          t('mirrorNoFrame'),
        );

      return React.createElement(
        'div',
        {
          ref: rootRef,
          style: { position: 'relative', flex: '0 0 auto', width: 104 },
        },
        React.createElement(
          'button',
          {
            type: 'button',
            title: menuPos !== null ? undefined : tips.join('\n'),
            onClick: () => {
              setMenuPos(null);
              onPick(target.targetId);
            },
            onContextMenu: (event) => {
              event.preventDefault();
              event.stopPropagation();
              setMenuPos({ x: event.clientX, y: event.clientY });
            },
            style: {
              display: 'block',
              width: 104,
              height: 64,
              padding: 0,
              overflow: 'hidden',
              cursor: 'pointer',
              borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-1, transparent)',
              border: isFocus ? `2px solid ${MIRROR_ACCENT}` : `1px solid ${MIRROR_BORDER}`,
              boxSizing: 'border-box',
            },
          },
          React.createElement('div', { style: { position: 'relative', width: '100%', height: '100%' } }, image),
          React.createElement('span', {
            title: target.attached ? t('mirrorTileAttached') : t('mirrorTileDetached'),
            style: {
              position: 'absolute',
              left: 4,
              top: 4,
              width: 6,
              height: 6,
              borderRadius: 3,
              background: target.attached ? MIRROR_GREEN : MIRROR_DIM,
              boxShadow: '0 0 0 1px rgba(255,255,255,0.55)',
            },
          }),
        ),
        React.createElement(
          'div',
          {
            title: target.frontmost
              ? `${t('mirrorTileFront')}${target.frontmostInferred ? `（${t('mirrorInferred')}）` : ''}`
              : t('mirrorTileFront'),
            style: { height: 3, marginTop: 2, display: 'flex', justifyContent: 'center' },
          },
          target.frontmost ? React.createElement('span', { style: { width: '60%', height: 2, background: MIRROR_ACCENT } }) : null,
        ),
        React.createElement(
          'div',
          {
            style: {
              fontSize: 11,
              lineHeight: 1.35,
              marginTop: 4,
              color: isFocus ? 'var(--dsw-alias-label-primary, inherit)' : MIRROR_DIM,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          label,
        ),
        menu,
      );
    }

    /**
     * 画面正文（DESIGN §5）：上面一张焦点画面，下面一排缩略图。
     *
     * @param {object} props - 座位属性（含框架注入的 `useTabInfo`）。
     * @returns {object} React 元素。
     */
    function MirrorBody(props) {
      const { store, t, insertTabChip, insertSkillChip } = props;
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const snapshot = useStatus(store);
      const value = snapshot.value;
      const state = value?.state ?? 'idle';
      const running = state === 'running';

      const hub = mirrorHubFor(store);
      const [mirror, setMirror] = React.useState(hub.getSnapshot());
      React.useEffect(() => hub.subscribe(() => setMirror(hub.getSnapshot())), [hub]);
      const [skills, setSkills] = React.useState([]);
      const [skillUsage, setSkillUsage] = React.useState('');
      const [usageOpen, setUsageOpen] = React.useState(false);
      const [hoverSkill, setHoverSkill] = React.useState('');
      const [skillMenu, setSkillMenu] = React.useState(null);
      const skillsKeyRef = React.useRef('');
      function reloadSkills() {
        return callControl('/skills')
          .then((payload) => {
            const next = Array.isArray(payload?.skills) ? payload.skills : [];
            const key = next.map((skill) => `${skill?.name ?? ''}\t${skill?.description ?? ''}`).join('\n');
            if (key !== skillsKeyRef.current) {
              skillsKeyRef.current = key;
              setSkills(next);
            }
            if (typeof payload?.usage === 'string') setSkillUsage(payload.usage);
          })
          .catch(() => {});
      }
      function locateSkill(name, action) {
        setSkillMenu(null);
        void callControl('/skills/locate', { method: 'POST', body: { name, action } })
          .then((payload) => {
            if (payload?.ok !== true) setNote(payload?.error || t('mirrorActionFailed'));
          })
          .catch((error) => setNote(error instanceof Error ? error.message : String(error)));
      }
      function removeSkill(name) {
        setSkillMenu(null);
        void callControl('/skills', { method: 'DELETE', body: { name } })
          .then(() => {
            skillsKeyRef.current = '';
            return reloadSkills();
          })
          .catch((error) => setNote(error instanceof Error ? error.message : String(error)));
      }

      // 「只有可见时才连接」：`tab.visible` 由框架给，含浮出的面板（§5／§7）。
      // 拿不到 useTabInfo（老宿主、测试）时按可见处理 —— 功能不因此消失。
      const tabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null;
      const visible = tabInfo === null || tabInfo === undefined ? true : tabInfo?.tab?.visible !== false;

      React.useEffect(() => {
        if (!visible) return undefined;
        let stopped = false;
        const load = () => {
          if (!stopped) void reloadSkills();
        };
        load();
        const timer = setInterval(load, POLL_MS);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, [visible]);

      React.useEffect(() => {
        if (!visible) return undefined;
        hub.addVisible();
        return () => {
          hub.removeVisible();
        };
      }, [hub, visible]);

      React.useEffect(() => {
        hub.sync();
      }, [hub, running, visible, mirror.paused]);

      const [picked, setPicked] = React.useState('');
      const [legend, setLegend] = React.useState(false);
      const [note, setNote] = React.useState('');
      const [dragSplit, setDragSplit] = React.useState(null);
      const [dragSkillHeight, setDragSkillHeight] = React.useState(null);
      const bodyRef = React.useRef(null);
      // 切胶片条时：没有焦点档新帧前先留着上一张主画面，避免缩略图拉满先糊一下。
      const heroHoldRef = React.useRef(null);

      const targets = filmstripTargets(mirror.targets);
      const serverFocus = mirror.selectedTargetId;
      // 宿主换了默认标签（例如模型调 `workspace_browser_select_tab`）：画面焦点跟过去，
      // 覆盖掉本地点选 —— DESIGN §6 要求 select_tab「把画面焦点切过去」。
      React.useEffect(() => {
        setPicked('');
      }, [serverFocus]);

      const exists = (targetId) => targetId !== '' && targets.some((target) => target.targetId === targetId);
      const frontmostTarget = targets.find((target) => target.frontmost);
      const followFront = value?.settings?.panelFollowFrontTab === true;
      const focusTargetId = followFront && frontmostTarget !== undefined
        ? frontmostTarget.targetId
        : exists(picked)
          ? picked
          : exists(serverFocus)
            ? serverFocus
            : targets.length > 0
              ? targets[0].targetId
              : '';
      const focusTarget = targets.find((target) => target.targetId === focusTargetId) ?? null;

      React.useEffect(() => {
        hub.setFocusTarget(focusTargetId);
      }, [hub, focusTargetId]);

      const serverSplit = numberOr(value?.settings?.panelTileSplit, 0.55);
      const split = dragSplit === null ? Math.min(0.85, Math.max(0.15, serverSplit)) : dragSplit;
      const serverSkillHeight = integerOr(value?.settings?.panelSkillHeight, 72);
      const skillHeight = dragSkillHeight === null
        ? Math.min(360, Math.max(40, serverSkillHeight))
        : dragSkillHeight;

      React.useEffect(() => {
        // 设置已经写回来了（或者本来就是这个值）：交回给服务端那份。
        if (dragSplit !== null && Math.abs(serverSplit - dragSplit) < 0.001) setDragSplit(null);
      }, [serverSplit, dragSplit]);
      React.useEffect(() => {
        if (dragSkillHeight !== null && serverSkillHeight === dragSkillHeight) setDragSkillHeight(null);
      }, [serverSkillHeight, dragSkillHeight]);

      /**
       * 右键菜单 / 主画面按钮的动作。
       *
       * 「显示浏览器窗口」是**唯一会抢系统焦点的动作**，必须用户自己点（§5）。
       * 「加入对话」把该标签插成输入框引用芯片（不发送），用户可再改再发。
       *
       * @param {string} action - `assign-model` / `bring-front` / `close` / `open-new`。
       * @param {object} target - 目标标签。
       * @returns {void}
       */
      const act = (action, target) => {
        setNote('');
        if (action === 'copy') {
          const url = typeof target?.url === 'string' ? target.url : '';
          try {
            void Promise.resolve(navigator.clipboard?.writeText(url)).catch(() => {});
          } catch {
            /* 剪贴板不可用就算了 */
          }
          return;
        }
        if (action === 'assign-model') {
          const result = typeof insertTabChip === 'function'
            ? insertTabChip(sessionId, target)
            : { ok: false, error: 'no-input' };
          if (!result?.ok) {
            setNote(result?.error === 'no-session' || result?.error === 'no-input' || result?.error === 'no-shell'
              ? t('mirrorAssignNoInput')
              : `${t('mirrorActionFailed')}：${result?.error ?? 'unknown'}`);
            return;
          }
          setNote(t('mirrorAssignDone'));
          // 顺带切默认 target，方便用户发送后工具对准这一页（失败不挡芯片）。
          void callControl('/tab-action', {
            method: 'POST',
            body: { action: 'assign-to-model', targetId: target.targetId },
          }).then(() => {
            store.refresh();
            hub.refresh();
          }).catch(() => {});
          return;
        }
        const body =
          action === 'bring-front'
            ? { action: 'bring-to-front', targetId: target.targetId }
            : action === 'close'
              ? { action: 'close', targetId: target.targetId }
              : { action: 'open', url: typeof target?.url === 'string' && target.url !== '' ? target.url : 'about:blank' };
        void callControl('/tab-action', { method: 'POST', body })
          .then(() => {
            store.refresh();
            hub.refresh();
          })
          .catch((error) => setNote(`${t('mirrorActionFailed')}：${error instanceof Error ? error.message : String(error)}`));
      };

      /**
       * 拖分隔条：松手时写回 `panelTileSplit`（§5「布局与拖拽」）。
       *
       * @param {object} event - pointerdown 事件。
       * @returns {void}
       */
      const startDrag = (event) => {
        const element = bodyRef.current;
        if (element === null || element === undefined) return;
        event.preventDefault();
        const rect = element.getBoundingClientRect();
        const height = Math.max(1, rect.height);
        const ratioOf = (clientY) => Math.min(0.85, Math.max(0.15, (clientY - rect.top) / height));
        const move = (moveEvent) => setDragSplit(ratioOf(moveEvent.clientY));
        const up = (upEvent) => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          const ratio = ratioOf(upEvent.clientY);
          setDragSplit(ratio);
          void callControl('/prefs', { method: 'POST', body: { panelTileSplit: ratio } })
            .then(() => store.refresh())
            .catch(() => {});
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      };

      /**
       * 拖胶片条和技能区之间的分隔条。高度从画面底边量起，松手写入 `panelSkillHeight`。
       *
       * @param {object} event - pointerdown 事件。
       * @returns {void}
       */
      const startSkillDrag = (event) => {
        const element = bodyRef.current;
        if (element === null || element === undefined) return;
        event.preventDefault();
        const rect = element.getBoundingClientRect();
        const heightOf = (clientY) => Math.min(360, Math.max(40, Math.round(rect.bottom - clientY)));
        const move = (moveEvent) => setDragSkillHeight(heightOf(moveEvent.clientY));
        const up = (upEvent) => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          const height = heightOf(upEvent.clientY);
          setDragSkillHeight(height);
          void callControl('/prefs', { method: 'POST', body: { panelSkillHeight: height } })
            .then(() => store.refresh())
            .catch(() => {});
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      };

      const statusText =
        mirror.status === 'error' && mirror.error !== ''
          ? `${t('mirrorError')}：${mirror.error}`
          : mirror.paused
            ? t('mirrorPaused')
            : mirror.capture?.state === 'unavailable'
              ? t('mirrorCdpDown')
              : mirror.status === 'live'
                ? t('mirrorLive')
                : mirror.status === 'connecting'
                  ? t('mirrorConnecting')
                  : t('mirrorIdle');
      const statusColor =
        mirror.capture?.state === 'unavailable'
          ? '#c0392b'
          : mirror.status === 'live'
            ? MIRROR_GREEN
            : mirror.status === 'error'
              ? '#c0392b'
              : mirror.status === 'connecting'
                ? '#a1660a'
                : MIRROR_DIM;

      // ── 空态一：未启动 / 启动中 / 失败 / Chrome 有问题 ──────────────────────
      if (!running) {
        const chrome = value?.chrome ?? null;
        const problem = chrome !== null && chrome.state !== 'ok' && chrome.state !== 'probing' ? chrome : null;
        const problemText =
          problem === null
            ? ''
            : problem.state === 'too-old'
              ? t('chromeTooOld')(problem.version, problem.minVersion)
              : problem.state === 'ambiguous'
                ? t('chromeAmbiguous')((problem.candidates ?? []).length)
                : t('chromeMissingBody');
        return React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 16, fontSize: 13, lineHeight: 1.7 } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, t('notRunning')),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => {
                void callControl('/launch', { method: 'POST', body: {} })
                  .then(() => store.refresh())
                  .catch((error) => setNote(error instanceof Error ? error.message : String(error)));
              },
              style: { ...MIRROR_BUTTON, padding: '6px 14px', fontSize: 13, alignSelf: 'flex-start' },
            },
            t('startFromPanel'),
          ),
          state === 'failed' && value?.lastError
            ? React.createElement('div', { style: { marginTop: 8, fontSize: 11, color: '#c0392b' } }, value.lastError)
            : null,
          problem === null
            ? null
            : React.createElement(
              'div',
              { style: { marginTop: 12, fontSize: 11, lineHeight: 1.7 } },
              React.createElement('div', { style: { fontWeight: 600 } }, problemText),
              React.createElement(
                'div',
                { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
                React.createElement('button', { type: 'button', style: MIRROR_BUTTON, onClick: () => void store.refresh() }, t('mirrorRetry')),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    style: MIRROR_BUTTON,
                    onClick: () => {
                      try {
                        window.open('https://www.google.com/chrome/', '_blank', 'noopener');
                      } catch {
                        /* 弹窗被挡就算了 */
                      }
                    },
                  },
                  t('mirrorDownload'),
                ),
                React.createElement(
                  'button',
                  { type: 'button', style: MIRROR_BUTTON, onClick: () => setNote(t('recheckHint')) },
                  t('mirrorSetPath'),
                ),
              ),
            ),
          note !== '' ? React.createElement('div', { style: { marginTop: 8, fontSize: 11, opacity: 0.8 } }, note) : null,
        );
      }

      // ── 空态二：已启动但没有可显示的标签（about:blank 被胶片条过滤） ─────────
      if (targets.length === 0) {
        return React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 16, fontSize: 13, lineHeight: 1.7 } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, t('mirrorNoTabsTitle')),
          React.createElement('div', { style: { marginBottom: 10, fontSize: 12, opacity: 0.75 } }, t('mirrorNoTabsHint')),
          React.createElement(
            'button',
            {
              type: 'button',
              style: { ...MIRROR_BUTTON, padding: '6px 14px', fontSize: 13, alignSelf: 'flex-start' },
              // 开 NTP 而不是 about:blank：空白页会被胶片条过滤，点了还是空态。
              onClick: () => act('open-new', { targetId: '', url: 'chrome://new-tab-page/' }),
            },
            t('mirrorNewTab'),
          ),
          React.createElement('div', { style: { marginTop: 8, fontSize: 11, opacity: 0.7 } }, `${t('port')} ${value?.port ?? 0}`),
          note !== '' ? React.createElement('div', { style: { marginTop: 8, fontSize: 11, opacity: 0.8 } }, note) : null,
        );
      }

      // ── 正常：焦点 + 胶片条（§5 的默认布局） ────────────────────────────────
      const rawFocusFrame = focusTarget === null ? null : mirror.frames[focusTarget.targetId] ?? null;
      const focusMaxWidth = numberOr(value?.settings?.streamFocusMaxWidth, 960) * deviceScale();
      const focusFrameReady = isHeroQualityFrame(rawFocusFrame, focusMaxWidth);
      if (focusTarget !== null && focusFrameReady) {
        heroHoldRef.current = { targetId: focusTarget.targetId, frame: rawFocusFrame };
      }
      // 新标签还没焦点档时：不拿缩略图糊一整屏；同标签升级中可暂留上一张清晰帧。
      const focusFrame = focusFrameReady
        ? rawFocusFrame
        : focusTarget !== null && heroHoldRef.current?.targetId === focusTarget.targetId
          ? heroHoldRef.current.frame
          : null;
      const heroCaption = focusTarget === null
        ? ''
        : (typeof focusTarget.url === 'string' && focusTarget.url !== '' ? focusTarget.url : '');

      const header = React.createElement(
        'div',
        {
          style: {
            position: 'relative',
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '6px 10px',
            fontSize: 12,
            borderBottom: `1px solid ${MIRROR_BORDER}`,
            background: 'var(--dsw-alias-bg-layer-1, transparent)',
          },
        },
        React.createElement('span', {
          style: { fontWeight: 600, fontSize: 13, color: 'var(--dsw-alias-label-primary, inherit)', marginRight: 4 },
        }, t('mirrorTitle')),
        React.createElement(
          'button',
          {
            type: 'button',
            style: MIRROR_BUTTON,
            onClick: () => hub.setPaused(!mirror.paused),
            title: mirror.paused ? t('mirrorResume') : t('mirrorPause'),
            onMouseEnter: (event) => { event.currentTarget.style.background = MIRROR_HOVER; },
            onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent'; },
          },
          mirror.paused ? t('mirrorResume') : t('mirrorPause'),
        ),
        React.createElement(
          'select',
          {
            value: String(numberOr(value?.settings?.streamFocusFps, 2)),
            title: t('mirrorFps'),
            onChange: (event) => {
              const fps = numberOr(event.target.value, 2);
              void callControl('/prefs', { method: 'POST', body: { streamFocusFps: fps } })
                .then(() => {
                  store.refresh();
                  hub.setPaused(false);
                })
                .catch(() => {});
            },
            style: { ...MIRROR_BUTTON, padding: '4px 6px', background: MIRROR_HOVER },
          },
          ...FPS_CHOICES.map((fps) => React.createElement('option', { key: String(fps), value: String(fps) }, `${fps} 帧/秒`)),
        ),
        React.createElement('span', { style: { flex: '1 1 auto' } }),
        React.createElement('span', { title: statusText, style: { width: 7, height: 7, borderRadius: 4, background: statusColor } }),
        React.createElement(
          'button',
          {
            type: 'button',
            style: {
              ...MIRROR_BUTTON,
              width: 28,
              height: 28,
              padding: 0,
              borderRadius: 14,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            },
            title: t('mirrorLegend'),
            onClick: () => setLegend((previous) => !previous),
            onMouseEnter: (event) => { event.currentTarget.style.background = MIRROR_HOVER; },
            onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent'; },
          },
          '?',
        ),
        legend ? React.createElement(MirrorLegend, { t }) : null,
      );

      const hero = React.createElement(
        'div',
        {
          style: {
            flex: `${split} 1 0`,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-layer-0, transparent)',
          },
        },
        React.createElement(
          'div',
          {
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              padding: 4,
            },
          },
          focusFrame === null || focusFrame === undefined
            ? React.createElement(
              'div',
              { style: { fontSize: 12, color: MIRROR_DIM, padding: '0 16px', textAlign: 'center', lineHeight: 1.5 } },
              mirror.capture?.state === 'unavailable' ? t('mirrorCdpDown') : t('mirrorWaiting'),
            )
            : React.createElement('img', {
              src: `data:${focusFrame.mime};base64,${focusFrame.dataB64}`,
              alt: '',
              draggable: false,
              style: {
                width: '100%',
                maxWidth: '100%',
                height: 'auto',
                maxHeight: '100%',
                aspectRatio: focusFrame.w > 0 && focusFrame.h > 0 ? `${focusFrame.w} / ${focusFrame.h}` : undefined,
                objectFit: 'contain',
                display: 'block',
                background: 'transparent',
              },
            }),
        ),
        React.createElement(
          'div',
          {
            style: {
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px 8px',
              fontSize: 12,
              color: MIRROR_LABEL,
            },
          },
          React.createElement('span', {
            style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' },
          }, heroCaption),
          focusTarget
            ? React.createElement(
              'button',
              {
                type: 'button',
                style: { ...MIRROR_BUTTON, background: MIRROR_HOVER, borderRadius: 16, padding: '4px 12px' },
                onClick: () => act('bring-front', focusTarget),
              },
              t('mirrorBringFront'),
            )
            : null,
        ),
      );

      const splitter = React.createElement(
        'div',
        {
          role: 'separator',
          'aria-orientation': 'horizontal',
          title: t('mirrorSplitHint'),
          onPointerDown: startDrag,
          style: {
            flex: '0 0 8px',
            cursor: 'row-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderTop: `1px solid ${MIRROR_BORDER}`,
            background: 'transparent',
          },
        },
        React.createElement('span', { style: { width: 28, height: 2, borderRadius: 1, background: MIRROR_BORDER } }),
      );

      const filmstrip = React.createElement(
        'div',
        {
          style: {
            flex: `${1 - split} 1 0`,
            minHeight: 0,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '10px 10px 72px',
            overflowX: 'auto',
            overflowY: 'auto',
            background: 'var(--dsw-alias-bg-layer-1, transparent)',
            borderTop: `1px solid ${MIRROR_BORDER}`,
          },
        },
        ...targets.map((target) =>
          React.createElement(MirrorTile, {
            key: target.targetId,
            t,
            target,
            frame: mirror.frames[target.targetId] ?? null,
            isFocus: target.targetId === focusTargetId,
            onPick: (targetId) => setPicked(targetId),
            onAction: act,
          }),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            title: t('mirrorNewTab'),
            onClick: () => act('open-new', { targetId: '', url: 'chrome://new-tab-page/' }),
            style: {
              ...MIRROR_BUTTON,
              flex: '0 0 auto',
              width: 44,
              height: 64,
              borderRadius: 8,
              background: MIRROR_HOVER,
              fontSize: 18,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            },
          },
          '＋',
        ),
      );

      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            fontSize: 12,
            color: 'var(--dsw-alias-label-primary, inherit)',
            background: MIRROR_SURFACE,
          },
        },
        header,
        React.createElement(
          'div',
          { ref: bodyRef, style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
          hero,
          splitter,
          filmstrip,
          React.createElement(
            'div',
            {
              role: 'separator',
              'aria-orientation': 'horizontal',
              title: t('mirrorSkillSplitHint'),
              onPointerDown: startSkillDrag,
              style: {
                flex: '0 0 8px',
                cursor: 'row-resize',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderTop: `1px solid ${MIRROR_BORDER}`,
                background: 'transparent',
              },
            },
            React.createElement('span', { style: { width: 28, height: 2, borderRadius: 1, background: MIRROR_BORDER } }),
          ),
          React.createElement(
            'div',
            {
              style: {
                flex: `0 0 ${skillHeight}px`,
                height: skillHeight,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              },
            },
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px' } },
              React.createElement(
                'div',
                {
                  style: { position: 'relative', display: 'inline-flex' },
                  onMouseEnter: () => setUsageOpen(true),
                  onMouseLeave: () => setUsageOpen(false),
                },
                React.createElement(
                  'button',
                  { type: 'button', style: { ...MIRROR_BUTTON, color: MIRROR_DIM, padding: '2px 8px' } },
                  t('skillUsageLabel'),
                ),
                usageOpen
                  ? React.createElement(
                    'div',
                    {
                      style: {
                        position: 'absolute',
                        left: 0,
                        bottom: 'calc(100% + 6px)',
                        width: 280,
                        zIndex: 20,
                        padding: '8px 10px',
                        borderRadius: 8,
                        background: MIRROR_SURFACE,
                        border: `1px solid ${MIRROR_BORDER}`,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                        color: 'var(--dsw-alias-label-primary, inherit)',
                        fontSize: 11,
                        lineHeight: 1.45,
                        whiteSpace: 'normal',
                      },
                    },
                    skillUsage || t('skillUsage'),
                  )
                  : null,
              ),
              skills.length === 0
                ? React.createElement('span', { style: { fontSize: 12, color: MIRROR_DIM } }, t('skillEmpty'))
                : null,
            ),
            skills.length === 0
              ? null
              : React.createElement(
                'div',
                {
                  style: {
                    flex: '1 1 auto',
                    minHeight: 0,
                    overflow: 'auto',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignContent: 'flex-start',
                    gap: 4,
                    padding: '0 10px 8px',
                  },
                },
                skills.map((skill) => React.createElement(
                  'div',
                  {
                    key: skill.name,
                    onMouseEnter: () => setHoverSkill(skill.name),
                    onMouseLeave: () => setHoverSkill((current) => (current === skill.name ? '' : current)),
                    onContextMenu: (event) => {
                      event.preventDefault();
                      setSkillMenu({ name: skill.name, x: event.clientX, y: event.clientY });
                    },
                    style: {
                      padding: '2px 8px',
                      borderRadius: 6,
                      cursor: 'default',
                      lineHeight: '20px',
                      background: hoverSkill === skill.name || skillMenu?.name === skill.name ? MIRROR_HOVER : 'transparent',
                    },
                  },
                  skill.name,
                )),
              ),
            ),
          ),
          note !== ''
          ? React.createElement('div', {
            style: {
              flex: '0 0 auto',
              padding: '6px 10px',
              fontSize: 11,
              color: 'var(--dsw-alias-state-danger-primary, #c0392b)',
            },
          }, note)
          : null,
        skillMenu === null
          ? null
          : React.createElement(
            'div',
            {
              style: { position: 'fixed', inset: 0, zIndex: 40 },
              onMouseDown: () => setSkillMenu(null),
              onContextMenu: (event) => {
                event.preventDefault();
                setSkillMenu(null);
              },
            },
            React.createElement(
              'div',
              {
                style: {
                  position: 'fixed',
                  left: skillMenu.x,
                  top: skillMenu.y,
                  transform: 'translateY(calc(-100% - 4px))',
                  zIndex: 41,
                  minWidth: 220,
                  padding: 4,
                  borderRadius: 8,
                  background: MIRROR_SURFACE,
                  border: `1px solid ${MIRROR_BORDER}`,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                },
                onMouseDown: (event) => event.stopPropagation(),
              },
              [
                {
                  key: 'add',
                  label: t('mirrorAssignToModel'),
                  onClick: () => {
                    const name = skillMenu.name;
                    setSkillMenu(null);
                    const result = typeof insertSkillChip === 'function'
                      ? insertSkillChip(sessionId, { name })
                      : { ok: false, error: 'no-input' };
                    setNote(result?.ok ? t('mirrorAssignDone') : t('mirrorAssignNoInput'));
                  },
                },
                { key: 'open', label: t('skillMenuOpen'), title: '转到工作区文件夹并打开文件', onClick: () => locateSkill(skillMenu.name, 'open') },
                { key: 'reveal', label: t('skillMenuReveal'), onClick: () => locateSkill(skillMenu.name, 'reveal') },
                { key: 'delete', label: t('skillMenuDelete'), danger: true, onClick: () => removeSkill(skillMenu.name) },
              ].map((item) => React.createElement(
                'button',
                {
                  key: item.key,
                  type: 'button',
                  title: item.title,
                  style: {
                    ...MIRROR_BUTTON,
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    color: item.danger ? 'var(--dsw-alias-state-danger-primary, #c0392b)' : MIRROR_BUTTON.color,
                  },
                  onClick: item.onClick,
                },
                item.label,
              )),
            ),
          ),
      );
    }

    // ── 插件配置卡片 ──────────────────────────────────────────────────────────
    //
    // 「设置 → 插件 → 插件配置」里能不能看到本插件，取决于**两份账本的交集**：
    // 宿主注册了同名 settings namespace，**并且**浏览器半边在插槽
    // `settings.plugin.item` 注册了 key = namespace 的卡片。只有前者时那一栏是空的
    // —— 这正是本项目第一版的状态（宿主挂好了，卡片没写）。

    const SETTINGS_NS = 'dsh-helper-plugin-workspace-browser';
    const SETTINGS_LOCALE_NS = 'workspace-browser-settings';

    /** 与宿主 `lib/settings.js` 的默认值保持一致。 */
    const SETTINGS_DEFAULTS = {
      capsuleEnabled: true,
      capsuleShowPort: true,
      panelAutoOpenOnLaunch: true,
      panelTileSplit: 0.55,
      panelSkillHeight: 72,
      panelFollowFrontTab: false,
      streamFocusFps: 2,
      streamFocusMaxWidth: 960,
      streamFocusQuality: 70,
      streamThumbFps: 0.25,
      streamThumbMaxWidth: 160,
      streamThumbQuality: 50,
      userDataDir: '',
      debugPort: 0,
      chromeCrossOrigin: false,
      startupUrl: '',
      instanceRestoreTabsOnReopen: true,
      instanceOnDshExit: 'keep',
    };

    /** 字段表：顺序即展示顺序，`group` 决定分组标题。 */
    const SETTINGS_FIELDS = [
      { key: 'capsuleEnabled', kind: 'bool', group: 'capsule' },
      { key: 'capsuleShowPort', kind: 'bool', group: 'capsule' },
      { key: 'panelAutoOpenOnLaunch', kind: 'bool', group: 'panel' },
      { key: 'panelTileSplit', kind: 'number', min: 0.15, max: 0.85, group: 'panel' },
      { key: 'panelSkillHeight', kind: 'int', min: 40, max: 360, group: 'panel' },
      { key: 'panelFollowFrontTab', kind: 'bool', group: 'panel' },
      { key: 'streamFocusFps', kind: 'number', min: 0.5, max: 10, group: 'stream' },
      { key: 'streamFocusMaxWidth', kind: 'int', min: 160, max: 3840, group: 'stream' },
      { key: 'streamFocusQuality', kind: 'int', min: 1, max: 100, group: 'stream' },
      { key: 'streamThumbFps', kind: 'number', min: 0, max: 1, group: 'stream' },
      { key: 'streamThumbMaxWidth', kind: 'int', min: 64, max: 640, group: 'stream' },
      { key: 'streamThumbQuality', kind: 'int', min: 1, max: 100, group: 'stream' },
      { key: 'userDataDir', kind: 'string', group: 'browser' },
      { key: 'debugPort', kind: 'int', min: 0, max: 65535, group: 'browser' },
      { key: 'chromeCrossOrigin', kind: 'bool', group: 'browser' },
      { key: 'startupUrl', kind: 'string', group: 'instance' },
      { key: 'instanceRestoreTabsOnReopen', kind: 'bool', group: 'instance' },
      { key: 'instanceOnDshExit', kind: 'enum', options: ['keep', 'close'], group: 'instance' },
    ];

    /** 卡片自己的文案（与胶囊分开，避免键名打架）。 */
    const SETTINGS_COPY = {
      zh: {
        title: '工作区浏览器',
        subtitle: 'dsh-helper-plugin-workspace-browser',
        intro: '给当前工作区起一个带调试端口的真实 Chrome。改完要点保存；标了「需重启」的项在下次启动实例时生效。',
        groupCapsule: '胶囊',
        groupPanel: '画面',
        groupStream: '帧率与质量',
        groupBrowser: '浏览器',
        groupInstance: '实例',
        capsuleEnabled: '显示胶囊',
        capsuleEnabledHint: '输入框那一行的入口按钮；关掉后仍可用会话头部按钮与 /browser',
        capsuleShowPort: '胶囊显示端口',
        capsuleShowPortHint: '文案里带「· 端口号」',
        panelAutoOpenOnLaunch: '启动后自动展开画面',
        panelAutoOpenOnLaunchHint: '仅对触发启动的那个会话生效',
        panelTileSplit: '焦点区高度占比',
        panelTileSplitHint: '0.15–0.85，拖分隔条会写回这里',
        panelSkillHeight: '技能区高度',
        panelSkillHeightHint: '40–360 像素，拖胶片条和技能区之间的分隔条会写回这里',
        panelFollowFrontTab: '焦点跟随最顶层标签',
        panelFollowFrontTabHint: '关掉时焦点只由你在画面里点选决定',
        userDataDir: '用户数据目录',
        userDataDirHint: '留空用这个工作区自己的目录。填了就用这份已经登录过的目录',
        debugPort: '调试端口',
        debugPortHint: '0 表示自动分配。填了就连接这个端口；上面已经有窗口就直接用，不另开',
        streamFocusFps: '焦点帧率',
        streamFocusFpsHint: '0.5–10 fps',
        streamFocusMaxWidth: '焦点最大宽度',
        streamFocusMaxWidthHint: '像素；高度按原始视口比例',
        streamFocusQuality: '焦点质量',
        streamFocusQualityHint: '1–100 的整数，对应 CDP 的 quality',
        streamThumbFps: '缩略图帧率',
        streamThumbFpsHint: '0 表示不要缩略图',
        streamThumbMaxWidth: '缩略图最大宽度',
        streamThumbMaxWidthHint: '像素',
        streamThumbQuality: '缩略图质量',
        streamThumbQualityHint: '1–100',
        chromeCrossOrigin: '跨域',
        chromeCrossOriginHint: '加 --disable-web-security 等参数；切换会重启实例并关掉已打开标签',
        startupUrl: '默认起始页',
        startupUrlHint: '没有可恢复的标签、也没有下面这项时才用它；留空则开 about:blank',
        instanceRestoreTabsOnReopen: '再次启动时恢复标签',
        instanceRestoreTabsOnReopenHint: '有记住的标签就只打开那些，不再加空白页。一个都没有时才开 about:blank',
        instanceOnDshExit: 'DSH 退出时',
        instanceOnDshExitHint: 'keep = 本插件启动的浏览器继续活着；close = 退出 DSH 时关掉它。接到已有调试窗口时不会关',
        saving: '保存中…',
        failed: '保存失败',
        save: '保存',
        discard: '放弃修改',
        unsaved: '未保存',
        invalid: '有一项填得不对，改完才能保存。',
        ready: '已生效',
        unavailable: '设置服务不可用',
        readonly: '只读（页面非回环访问）',
        needsRestart: '需重启',
        collapse: '收起',
        expand: '展开',
      },
      en: {
        title: 'Workspace browser',
        subtitle: 'dsh-helper-plugin-workspace-browser',
        intro: 'A real Chrome with a debugging port for this workspace. Save to apply changes; items marked “restart” take effect the next time the instance starts.',
        groupCapsule: 'Capsule',
        groupPanel: 'View',
        groupStream: 'Framerate and quality',
        groupBrowser: 'Browser',
        groupInstance: 'Instance',
        capsuleEnabled: 'Show the capsule',
        capsuleEnabledHint: 'The entry button on the input row; the header button and /browser still work when off',
        capsuleShowPort: 'Show the port',
        capsuleShowPortHint: 'Appends “· port” to the label',
        panelAutoOpenOnLaunch: 'Open the view after launch',
        panelAutoOpenOnLaunchHint: 'Only the session that triggered the launch',
        panelTileSplit: 'Hero height ratio',
        panelTileSplitHint: '0.15–0.85; dragging the splitter writes back here',
        panelSkillHeight: 'Skill area height',
        panelSkillHeightHint: '40–360 px; dragging the splitter under the filmstrip writes back here',
        panelFollowFrontTab: 'Follow the frontmost tab',
        panelFollowFrontTabHint: 'When off, the hero follows only your clicks',
        userDataDir: 'User data directory',
        userDataDirHint: 'Empty uses this workspace’s own profile. Set it to a directory that is already signed in',
        debugPort: 'Debug port',
        debugPortHint: '0 assigns a port at launch. A number connects to that port and reuses a window already listening there',
        streamFocusFps: 'Hero framerate',
        streamFocusFpsHint: '0.5–10 fps',
        streamFocusMaxWidth: 'Hero max width',
        streamFocusMaxWidthHint: 'Pixels; height keeps the viewport ratio',
        streamFocusQuality: 'Hero quality',
        streamFocusQualityHint: 'Integer 1–100, CDP’s quality',
        streamThumbFps: 'Thumbnail framerate',
        streamThumbFpsHint: '0 disables thumbnails',
        streamThumbMaxWidth: 'Thumbnail max width',
        streamThumbMaxWidthHint: 'Pixels',
        streamThumbQuality: 'Thumbnail quality',
        streamThumbQualityHint: '1–100',
        chromeCrossOrigin: 'Cross-origin',
        chromeCrossOriginHint: 'Adds --disable-web-security; toggling restarts the instance and closes open tabs',
        startupUrl: 'Start page',
        startupUrlHint: 'Used only when there is nothing to restore; empty means about:blank',
        instanceRestoreTabsOnReopen: 'Restore tabs on next start',
        instanceRestoreTabsOnReopenHint: 'Remembered tabs open alone, with no extra blank page. about:blank is used only when there are none',
        instanceOnDshExit: 'When DSH exits',
        instanceOnDshExitHint: 'keep = leave the browser this plugin started; close = shut it down on exit. An already-open debug window is left alone',
        saving: 'Saving…',
        failed: 'Save failed',
        save: 'Save',
        discard: 'Discard',
        unsaved: 'Unsaved',
        invalid: 'Fix the invalid value before saving.',
        ready: 'Applied',
        unavailable: 'Settings service unavailable',
        readonly: 'Read-only (non-loopback page)',
        needsRestart: 'restart',
        collapse: 'Collapse',
        expand: 'Expand',
      },
    };

    /** 把输入控件的原始值收敛成设置文档要的类型。 */
    function coerceSetting(field, raw) {
      switch (field.kind) {
        case 'bool':
          return Boolean(raw);
        case 'int': {
          const value = Math.trunc(Number(raw));
          return Number.isFinite(value) ? value : SETTINGS_DEFAULTS[field.key];
        }
        case 'number': {
          const value = Number(raw);
          return Number.isFinite(value) ? value : SETTINGS_DEFAULTS[field.key];
        }
        default:
          return String(raw ?? '');
      }
    }

    /**
     * 设置卡片的仓库：包一层 `settingsScope`，给卡片一个稳定的快照。
     *
     * React 的 `useSyncExternalStore` 要求 `getSnapshot()` 在没变化时返回**同一个
     * 引用**，否则会无限重渲染 —— 所以这里按 status / revision / writable / 保存态
     * 做一个 key，key 不变就复用上一次的对象。
     *
     * @param {object} scope - `ctx.settingsScope.bind({ namespace })` 的结果。
     * @returns {object} 卡片用的仓库。
     */
    function createSettingsStore(scope) {
      const listeners = new Set();
      let cached = null;
      let cachedKey = '';
      let saving = false;
      let failed = false;

      const publish = () => {
        cachedKey = '';
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            /* 单个座位出错不影响别人 */
          }
        }
      };

      const project = (raw) => {
        const value = raw.status === 'ready' && raw.value && typeof raw.value === 'object'
          ? { ...SETTINGS_DEFAULTS, ...raw.value }
          : { ...SETTINGS_DEFAULTS };
        return {
          available: raw.status === 'ready',
          writable: raw.writable === true,
          mode: raw.mode ?? 'host',
          value,
          saving,
          failed,
        };
      };

      return {
        getSnapshot() {
          let raw;
          try {
            raw = scope.getSnapshot();
          } catch {
            raw = { status: 'unavailable' };
          }
          const key = `${raw.status}|${raw.revision ?? ''}|${raw.writable === true}|${saving}|${failed}`;
          if (cached !== null && key === cachedKey) return cached;
          cachedKey = key;
          cached = project(raw);
          return cached;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        /**
         * 一次写入多份已经校验过的值。失败时保留草稿，让用户改完再存。
         *
         * @param {Record<string, unknown>} patch - 要写入的键。
         * @returns {Promise<boolean>} 全部写入成功为 true。
         */
        async saveFields(patch) {
          const entries = Object.entries(patch);
          if (entries.length === 0 || saving) return false;
          saving = true;
          failed = false;
          publish();
          try {
            if (typeof scope.mutate === 'function') {
              await scope.mutate(entries.map(([key, item]) => ({ op: 'set', path: [key], value: item })));
            } else if (typeof scope.set === 'function') {
              for (const [key, item] of entries) await scope.set(key, item);
            } else {
              throw new Error('settings scope has no writer');
            }
            return true;
          } catch {
            failed = true;
            return false;
          } finally {
            saving = false;
            publish();
          }
        },
      };
    }

    /** 一张设置卡片。 */
    function SettingsCard(props) {
      const el = React.createElement;
      const t = props.t;
      const store = props.store;
      const useStore = props.useWorkspaceBrowserSettings;
      const [fallback, setFallback] = React.useState(store.getSnapshot());
      React.useEffect(() => store.subscribe(() => setFallback(store.getSnapshot())), [store]);
      const state = typeof useStore === 'function' ? useStore((snapshot) => snapshot) : fallback;
      const [open, setOpen] = React.useState(false);
      const [draft, setDraft] = React.useState({});
      const value = state.value;
      const disabled = !state.writable || state.saving;

      const blankNumber = (raw) => typeof raw === 'string' && raw.trim() === '';
      const sameSetting = (field, raw, saved) => {
        if (field.kind === 'bool') return Boolean(raw) === Boolean(saved);
        if (field.kind === 'int' || field.kind === 'number') {
          if (blankNumber(raw)) return false;
          const next = Number(raw);
          return Number.isFinite(next) && next === Number(saved);
        }
        return String(raw ?? '') === String(saved ?? '');
      };
      const validSetting = (field, raw) => {
        if (field.kind === 'bool') return true;
        if (field.kind === 'enum') return (field.options ?? []).includes(String(raw));
        if (field.kind === 'int' || field.kind === 'number') {
          if (blankNumber(raw)) return false;
          const next = Number(raw);
          if (!Number.isFinite(next)) return false;
          if (field.kind === 'int' && !Number.isInteger(next)) return false;
          if (field.min !== undefined && next < field.min) return false;
          if (field.max !== undefined && next > field.max) return false;
          return true;
        }
        return true;
      };
      const editField = (field, raw) => {
        setDraft((previous) => {
          const next = { ...previous };
          if (sameSetting(field, raw, value[field.key])) delete next[field.key];
          else next[field.key] = raw;
          return next;
        });
      };
      const shown = { ...value };
      const dirtyFields = [];
      for (const field of SETTINGS_FIELDS) {
        if (!Object.hasOwn(draft, field.key)) continue;
        shown[field.key] = draft[field.key];
        if (!sameSetting(field, draft[field.key], value[field.key])) dirtyFields.push(field);
      }
      const invalid = dirtyFields.some((field) => !validSetting(field, draft[field.key]));
      const dirty = dirtyFields.length > 0;

      const control = (field) => {
        const common = {
          disabled,
          style: {
            font: 'inherit',
            fontSize: 12,
            padding: '3px 6px',
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
            background: 'var(--dsw-alias-bg-layer-3, transparent)',
            color: 'inherit',
            boxSizing: 'border-box',
            width: field.kind === 'string' ? 'min(100%, 280px)' : 140,
            maxWidth: '100%',
          },
        };
        if (field.kind === 'bool') {
          return el('input', {
            type: 'checkbox',
            checked: Boolean(shown[field.key]),
            disabled,
            onChange: (event) => editField(field, event.target.checked),
          });
        }
        if (field.kind === 'enum') {
          return el(
            'select',
            { ...common, value: String(shown[field.key] ?? ''), onChange: (event) => editField(field, event.target.value) },
            ...(field.options ?? []).map((option) => el('option', { key: option, value: option }, option)),
          );
        }
        return el('input', {
          ...common,
          type: field.kind === 'string' ? 'text' : 'number',
          step: field.kind === 'int' ? 1 : 'any',
          min: field.min,
          max: field.max,
          value: String(shown[field.key] ?? ''),
          onChange: (event) => editField(field, event.target.value),
        });
      };

      const groups = [];
      for (const field of SETTINGS_FIELDS) {
        const last = groups[groups.length - 1];
        if (!last || last.name !== field.group) groups.push({ name: field.group, fields: [field] });
        else last.fields.push(field);
      }

      const body = groups.map((group) =>
        el(
          'div',
          { key: group.name, style: { marginTop: 12 } },
          el('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, t(`group${group.name[0].toUpperCase()}${group.name.slice(1)}`)),
          ...group.fields.map((field) =>
            el(
              'div',
              {
                key: field.key,
                style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0' },
              },
              el(
                'label',
                { style: { flex: '1 1 12em', minWidth: 0, fontSize: 12, lineHeight: 1.5 } },
                t(field.key),
                el('span', { style: { display: 'block', opacity: 0.65 } }, t(`${field.key}Hint`)),
              ),
              el('span', { style: { flex: '0 0 auto', maxWidth: '100%' } }, control(field)),
            ),
          ),
        ),
      );

      const buttonStyle = (primary, blocked) => ({
        font: 'inherit',
        cursor: blocked ? 'default' : 'pointer',
        opacity: blocked ? 0.4 : 1,
        border: primary ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        borderRadius: 8,
        padding: '5px 14px',
        fontSize: 13,
        lineHeight: 1.5,
        background: primary ? 'var(--dsw-alias-label-primary, #1f2328)' : 'transparent',
        color: primary ? 'var(--dsw-alias-bg-layer-3, #fff)' : 'var(--dsw-alias-label-secondary, inherit)',
      });
      const save = () => {
        if (!dirty || invalid || state.saving || !state.writable) return;
        const patch = {};
        for (const field of dirtyFields) patch[field.key] = coerceSetting(field, draft[field.key]);
        void store.saveFields(patch).then((ok) => {
          if (ok) setDraft({});
        });
      };
      const discard = () => {
        if (state.saving) return;
        setDraft({});
      };

      return el(
        'li',
        {
          style: {
            listStyle: 'none',
            margin: '0 0 8px',
            border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
            borderRadius: 12,
            background: 'var(--dsw-alias-bg-layer-3, transparent)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: open ? 'min(72vh, 720px)' : undefined,
          },
        },
        el(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((previous) => !previous),
            style: {
              width: '100%',
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '14px 16px',
              border: 0,
              background: 'transparent',
              color: 'inherit',
              textAlign: 'left',
              font: 'inherit',
              cursor: 'pointer',
            },
          },
          el(
            'span',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
            el('span', { style: { fontSize: 14, fontWeight: 600 } }, t('title')),
            el('span', { style: { fontSize: 12, opacity: 0.65 } }, t('subtitle')),
            el('span', { style: { fontSize: 12, lineHeight: 1.5, opacity: 0.8 } }, t('intro')),
          ),
          dirty
            ? el(
              'span',
              {
                style: {
                  flex: '0 0 auto',
                  fontSize: 11,
                  lineHeight: 1.4,
                  padding: '1px 6px',
                  borderRadius: 999,
                  background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.16))',
                  whiteSpace: 'nowrap',
                },
              },
              t('unsaved'),
            )
            : null,
          el('span', { style: { flex: '0 0 auto', fontSize: 11, opacity: 0.65, whiteSpace: 'nowrap' } }, open ? t('collapse') : t('expand')),
        ),
        open
          ? el(
            'div',
            { style: { padding: '0 16px 16px', overflowY: 'auto', overflowX: 'hidden', minHeight: 0, flex: '1 1 auto' } },
            ...body,
            !state.available || !state.writable
              ? el('div', { style: { marginTop: 12, fontSize: 12, opacity: 0.7 } }, state.available ? t('readonly') : t('unavailable'))
              : null,
            el(
              'div',
              {
                style: {
                  display: 'flex',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
                },
              },
              state.failed
                ? el('span', { style: { flex: 1, minWidth: 0, fontSize: 12, color: 'var(--dsw-alias-label-error, #c0392b)' } }, t('failed'))
                : invalid
                  ? el('span', { style: { flex: 1, minWidth: 0, fontSize: 12, opacity: 0.7 } }, t('invalid'))
                  : el('span', { style: { flex: 1 } }),
              el(
                'button',
                { type: 'button', disabled: !dirty || state.saving, onClick: discard, style: buttonStyle(false, !dirty || state.saving) },
                t('discard'),
              ),
              el(
                'button',
                { type: 'button', disabled: !dirty || invalid || state.saving || !state.writable, onClick: save, style: buttonStyle(true, !dirty || invalid || state.saving || !state.writable) },
                t(state.saving ? 'saving' : 'save'),
              ),
            ),
          )
          : null,
      );
    }

    /**
     * 注册「设置 → 插件 → 插件配置」里的卡片。
     *
     * 走嵌套 `inject(['slots','settingsScope'])`：没有设置服务的 profile 里，
     * 胶囊与画面照常工作，只是没有这张卡片。
     *
     * @param {object} owner - 注入后的上下文。
     * @returns {void}
     */
    function attachSettings(owner) {
      owner.effect(() => {
        if (!owner.settingsScope || typeof owner.settingsScope.bind !== 'function') return () => {};
        if (!owner.slots || typeof owner.slots.inject !== 'function') return () => {};
        if (!React || typeof React.createElement !== 'function') return () => {};

        let scope;
        try {
          scope = owner.settingsScope.bind({ namespace: SETTINGS_NS });
        } catch {
          return () => {};
        }
        const store = createSettingsStore(scope);

        const locale = typeof owner.get === 'function' ? owner.get('locale') : undefined;
        if (locale && typeof locale.register === 'function') locale.register(SETTINGS_LOCALE_NS, SETTINGS_COPY);
        const t = locale && typeof locale.bind === 'function'
          ? locale.bind(SETTINGS_LOCALE_NS)
          : (key) => SETTINGS_COPY.zh[key] ?? SETTINGS_COPY.en[key] ?? key;

        try {
          console.info(`[${PLUGIN_NAME}] 注册插件配置卡片：${SETTINGS_NS}`);
        } catch {
          /* 忽略 */
        }

        const stopSlot = owner.slots.inject('settings.plugin.item', function* register() {
          yield owner.slots.register(
            {
              name: 'settings.plugin.item',
              key: SETTINGS_NS,
              ...(locale === undefined ? {} : { locale: SETTINGS_LOCALE_NS }),
              inject: () => ({
                hooks: { workspaceBrowserSettings: store },
                React,
                t,
                store,
              }),
            },
            SettingsCard,
          );
        });
        return () => {
          if (typeof stopSlot === 'function') stopSlot();
        };
      }, `${PLUGIN_NAME}: settings card`);
    }

    /** 注册胶囊与头部按钮。 */
    function attachSeats(ctx, store, t, locale, sessionId) {
      const openPanel = () => {
        const sidebarRight = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined;
        if (sidebarRight && typeof sidebarRight.openTab === 'function') {
          try {
            sidebarRight.openTab(TAB_KIND);
            return;
          } catch {
            // 没有挂载的会话面时会抛错：接住，只留文字提示。
          }
        }
      };

      const stops = [];
      stops.push(
        ctx.slots.inject(CAPSULE_SLOT, () =>
          ctx.slots.register(
            {
              name: CAPSULE_SLOT,
              id: CAPSULE_ID,
              order: 10,
              ...(locale === undefined ? {} : { locale: LOCALE_NS }),
              inject: () => ({ store, t, locale: LOCALE_NS, sessionId, requestPanelOpen: openPanel }),
            },
            Capsule,
          ),
        ),
      );
      // 会话头部那个图标按钮（「在本地打开」旁边）**已按用户要求去掉**：打开画面在
      // 胶囊里和右侧栏本身都能做，多一个入口只是噪声。
      return () => {
        for (const stop of stops) {
          if (typeof stop === 'function') stop();
        }
      };
    }

    /** 注册右侧栏 tab 类型与正文。 */
    function attachPane(ctx, store, t, locale, insertTabChip, insertSkillChip) {
      const tabs = typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : undefined;
      if (!tabs || typeof tabs.register !== 'function') return () => {};
      const stops = [];
      try {
        stops.push(
          tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => t('panelTitle'),
            guide: [{ order: 20, title: () => t('panelTitle') }],
          }),
        );
      } catch {
        // 重复注册（例如 HMR 重挂）不该让整块失败。
      }
      stops.push(
        ctx.slots.inject(PANE_TAB_SLOT, () =>
          ctx.slots.register(
            {
              name: PANE_TAB_SLOT,
              key: TAB_ID,
              ...(locale === undefined ? {} : { locale: LOCALE_NS }),
              inject: () => ({ store, t, insertTabChip, insertSkillChip }),
            },
            MirrorBody,
          ),
        ),
      );
      return () => {
        for (const stop of stops) {
          if (typeof stop === 'function') stop();
        }
      };
    }

    /**
     * 跟随宿主的展开请求：`/status` 里的 `panelOpen.epoch` 一变就 `openTab`。
     *
     * 画面还没打开时不存在 WebSocket，所以这条信号只能走 `/status` 轮询。
     *
     * @param {object} store - 状态仓库。
     * @param {string} sessionId - 当前会话 id。
     * @param {() => void} openPanel - 展开动作。
     * @returns {() => void} 取消订阅。
     */
    function followPanelRequests(store, sessionId, openPanel) {
      let seen = -1;
      return store.subscribe(() => {
        const value = store.get().value;
        const request = value?.panelOpen;
        if (!request || typeof request.epoch !== 'number') return;
        if (seen === -1) {
          seen = request.epoch;
          return;
        }
        if (request.epoch === seen) return;
        seen = request.epoch;
        // 宿主要求的会话 id 为空时表示「谁看到谁开」；非空且对不上才跳过。
        if (request.sessionId !== null && request.sessionId !== '' && sessionId !== '' && request.sessionId !== sessionId) return;
        openPanel();
      });
    }

    /**
     * 胶囊 + 会话头部按钮 + 画面 tab + 展开请求轮询。
     *
     * @param {object} ctx - 客户端上下文。
     * @returns {void}
     */
    function attachCapsuleAndView(ctx) {
      ctx.effect(() => {
        try {
          React = require('react');
        } catch {
          React = typeof globalThis !== 'undefined' ? globalThis.React : undefined;
        }
        if (!React || typeof React.createElement !== 'function') return () => {};

        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (locale && typeof locale.register === 'function') locale.register(LOCALE_NS, COPY);
        const t = locale && typeof locale.bind === 'function'
          ? locale.bind(LOCALE_NS)
          : (key) => (COPY.zh[key] !== undefined ? COPY.zh[key] : key);

        const store = createStatusStore();
        // ⚠️ 不要读 `ctx.session` / `ctx.sessionId`：Cordis 的上下文是严格代理，
        // 未声明 inject 的属性一读就抛 `cannot get property "sessionId" without inject`，
        // 整个插件都会加载失败。会话 id 只在「谁看到谁开」的语义里用到，用空串
        // 表示不限会话即可。
        const sessionId = '';

        const sidebarRight = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined;
        const openPanel = () => {
          if (sidebarRight && typeof sidebarRight.openTab === 'function') {
            try {
              sidebarRight.openTab(TAB_KIND);
            } catch {
              // 没有挂载的会话面时抛错：只留文字提示。
            }
          }
        };

        const stopCapsule = attachSeats(ctx, store, t, locale, sessionId);
        const insertTabChip = (sid, target) => insertTabReferenceChip(ctx, sid, target);
        const insertSkillChip = (sid, skill) => insertSkillReferenceChip(ctx, sid, skill);
        const stopPane = attachPane(ctx, store, t, locale, insertTabChip, insertSkillChip);
        const stopFollow = followPanelRequests(store, sessionId, openPanel);

        return () => {
          // 顺序：先停画面（它会退订并关掉 WebSocket），再撤座位。
          disposeMirrorHubs();
          stopFollow();
          stopPane();
          stopCapsule();
        };
      }, `${PLUGIN_NAME}: capsule and view`);
    }

    exports.name = PLUGIN_NAME;
    // `slots` 是硬依赖；`locale` / `sidebarRight` / `sidebarRightTabs` 是可选
    // 的周边能力，用非严格的 `ctx.get` 读，缺了也能降级。`settingsScope` 走嵌套
    // inject —— 没有设置服务的 profile 里，胶囊与画面照常工作，只是没有配置卡片。
    exports.inject = ['slots'];

    exports.apply = (ctx, rawConfig) => {
      void rawConfig;
      attachCapsuleAndView(ctx);
      if (typeof ctx.inject === 'function') {
        ctx.inject(['slots', 'settingsScope'], attachSettings);
        // 等 inputTriggers 激活后再注册 codec，发送时才能展开芯片。
        ctx.inject(['inputTriggers'], (trigCtx) => {
          trigCtx.effect(() => attachTabReferenceSource(trigCtx), `${PLUGIN_NAME}: tab reference`);
          trigCtx.effect(() => attachSkillReferenceSource(trigCtx), `${PLUGIN_NAME}: skill reference`);
        });
      } else {
        attachSettings(ctx);
        attachTabReferenceSource(ctx);
        attachSkillReferenceSource(ctx);
      }
    };

    exports.__internals = {
      describeCapsule,
      createStatusStore,
      createSettingsStore,
      SettingsCard,
      SETTINGS_FIELDS,
      SETTINGS_NS,
      COPY,
      SETTINGS_COPY,
      // P3：画面（给测试与排障用；正文本身仍只走插槽注册）。
      STREAM_PATH,
      FPS_CHOICES,
      createMirrorHub,
      mirrorHubFor,
      disposeMirrorHubs,
      normalizeStreamTarget,
      normalizeHttpTarget,
      hostOf,
      pathOf,
      numberOr,
      integerOr,
      MirrorBody,
      MirrorTile,
      MirrorLegend,
      insertTabReferenceChip,
      tabReferenceParts,
      composeTabDraftSnippet,
      mentionTabCandidates,
      TAB_REF_SOURCE,
    };

    return module.exports;
  },
});
