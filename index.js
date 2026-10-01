/**
 * dsh plugin: `dsh-helper-plugin-workspace-browser` 的宿主半边。
 *
 * 给当前工作区起一个带调试端口的真实 Chrome：胶囊管开关与状态，右侧栏管看
 * 画面，模型用 `workspace_browser_*` 工具操作页面。设计见 `DESIGN.zh.md`。
 *
 * ## 零运行时依赖（重要）
 *
 * 本包**不静态导入任何 `@deepseek-ai/...`**，只用 `node:` 内置模块和自己的
 * `lib/`。原因不是洁癖：`dsh plugin --profile web add link:<dir>` 把本目录
 * 符号链接进 profile，而 Node 会从包的**真实路径**解析裸导入 —— 那里的
 * `node_modules` 不存在。静态导入会让 `link:` 安装直接失败。所有宿主服务都
 * 通过 `ctx.inject([...])` 拿，浏览器半边是 ModuleLoader 工厂而不是 ESM 图。
 *
 * ## 已经做到哪一步
 *
 * - **P0**：`ensure()`、硬超时、按 user-data-dir 结束残留、Chrome 探测、胶囊与小面板、
 *   profile 目录、`endpoint.json`、控制面 HTTP 路由、设置命名空间。
 * - **P1**：CDP 客户端（lib/cdp.js）与五个读类工具（lib/tools.js）。
 *
 * 写类工具（P2）、画面（P3）、关窗恢复（P4）、`/browser` 与设置卡片（P5）随后。
 *
 * @module dsh-helper-plugin-workspace-browser
 */

import { createCdpClient } from './lib/cdp.js';
import { createPageDriver } from './lib/page-driver.js';
import { loadPlaywrightCore } from './lib/playwright-runtime.js';
import { createBrowserCommand } from './lib/command.js';
import { createInstanceManager } from './lib/instance.js';
import { createModelSubmitter } from './lib/model.js';
import {
  appendToWorkspaceGitignore,
  browserRootOf,
  hideDirOnWindows,
  migrateLegacyRoot,
  readWorkspacePathFromStorage,
  resolveDshHome,
  WORKSPACE_DATA_DIR,
  workspaceKeyOf,
  writeSelfIgnore,
} from './lib/paths.js';
import { createControlRoute, ROUTE_PREFIX } from './lib/routes.js';
import { createScreencastHub } from './lib/screencast.js';
import { createSettingsSchema, normalizeSettings, SETTINGS_NAMESPACE } from './lib/settings.js';
import { createStreamRoute, STREAM_PATH } from './lib/stream.js';
import { registerBrowserTools, TOOL_PREFIX } from './lib/tools.js';
import { registerWriteTools } from './lib/write-tools.js';
import { registerSaveSkillTool } from './lib/skill-tool.js';
import { listSkills } from './lib/skills.js';

/** 稳定插件名；也是 `cordis.patch.yml` 里的 row id。 */
export const name = 'workspace-browser';

/**
 * 顶层 inject 留空：所有服务都用嵌套 `ctx.inject([...])` 惰性拿。
 *
 * 这样在只有宿主的 profile 里也能挂上（没有 `webServer` 就只是没有路由，
 * 不会让整个插件加载失败）。
 */
export const inject = [];

/**
 * 本行的 Config schema。
 *
 * 0.2 的 settings 服务不再由插件“登记”namespace：它遍历 Loader 条目，从
 * `entry.fiber.runtime.Config` 拿 schema，并把 `entry.options.id`（也就是
 * `cordis.patch.yml` 里的 row id）当作 namespace。所以要让配置界面认识这个插件，
 * 唯一要做的就是**导出这份 schema**（字段都标了 `.volatile()`，见 lib/settings.js）。
 *
 * 同时它还是本行 `config` 的校验器：profile 里写错的键会在加载时直接报错。
 */
export const Config = createSettingsSchema();

export { ROUTE_PREFIX, SETTINGS_NAMESPACE };

/**
 * 解析这个宿主进程服务的工作区路径。
 *
 * 一个 DSH 宿主进程只服务一个工作区（DESIGN.zh.md §2）。注册表里多于一个
 * 工作区时优先取**已经挂过会话**的那个；都没有会话就是未分组。
 *
 * @param {object} ctx - 宿主上下文。
 * @returns {string | null} 工作区绝对路径，未分组时为 null。
 */
function resolveWorkspacePath(ctx) {
  try {
    // ⚠️ 必须走 `ctx.get`：Cordis 上下文是严格代理，直接读 `ctx.workspaceRegistry`
    // 会抛 `cannot get property "workspaceRegistry" without inject`。
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
    if (!registry || typeof registry.list !== 'function') return null;
    const list = registry.list();
    if (!Array.isArray(list) || list.length === 0) return null;
    const withSessions = list.filter((entry) => Array.isArray(entry?.sessionIds) && entry.sessionIds.length > 0);
    const pool = withSessions.length > 0 ? withSessions : list;
    const picked = pool[0];
    return typeof picked?.path === 'string' && picked.path !== '' ? picked.path : null;
  } catch {
    return null;
  }
}

/**
 * 插件主体。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} [config] - `cordis.patch.yml` 里这一行的 config（本插件不用）。
 * @returns {void}
 */
export function apply(ctx, config) {
  const pluginConfig = config !== null && typeof config === 'object' ? config : {};

  /** 统一日志：宿主一定有 logger，但降级路径不假设。 */
  const info = (message) => {
    try {
      ctx.logger?.info?.(`${name}: ${message}`);
    } catch {
      // 日志失败不该影响功能。
    }
  };
  const warn = (message, error) => {
    try {
      if (error === undefined) ctx.logger?.warn?.(`${name}: ${message}`);
      else ctx.logger?.warn?.(`${name}: ${message} %o`, error);
    } catch {
      // 同上。
    }
  };

  const dshHome = resolveDshHome();
  // 工作区解析：**服务优先，其次直接读存储文件**。服务的 init 是异步的，而插件在加载
  // 这一刻就要算出数据目录 —— 实测因此掉进过 `_ungrouped`（注册表明明有 Planner1）。
  const workspacePath = resolveWorkspacePath(ctx) ?? readWorkspacePathFromStorage(dshHome);
  const workspaceKey = workspaceKeyOf(workspacePath);
  // 数据目录默认在**工作区里的隐藏子目录** `<workspace>/.workspace-browser/`；
  // 未分组时才退回 DSH_HOME。
  const browserRoot = browserRootOf({ workspacePath, workspaceKey, dshHome });
  const migratedFrom = migrateLegacyRoot({ browserRoot, workspaceKey, dshHome });
  if (migratedFrom !== '') info(`浏览器数据已从 ${migratedFrom} 迁到 ${browserRoot}（登录态保留）`);
  writeSelfIgnore(browserRoot);
  hideDirOnWindows(browserRoot);
  // 工作区里已经有 `.gitignore` 就顺手把数据目录加进去（没有就不替他建文件）。
  if (appendToWorkspaceGitignore(workspacePath)) {
    info(`已把 ${WORKSPACE_DATA_DIR}/ 追加到工作区的 .gitignore`);
  }

  const instance = createInstanceManager({
    browserRoot,
    workspaceKey,
    getSettings: () => readSettings(),
    warn,
    info,
  });

  /** 设置层：`settings` 服务可用时由它解析，否则用默认值 + 进程内覆盖。 */
  let settingsSource = () => ({});
  /**
   * 注入拿到的 settings 服务。**不能**在外层直接用 `ctx.settings`：那是严格代理上的
   * 未声明属性，读了就抛错（写设置、装命名空间都只能走这个引用）。
   */
  let settingsService = null;
  /** 写不进 settings 文档时的进程内覆盖（重启即失效）。 */
  let overlay = {};

  /**
   * 读当前设置。每次都读「最新值」——`settings` 的变更会经 `setSource` 更新
   * `settingsSource`，所以这里不需要缓存失效逻辑。
   *
   * @returns {object} 完整的设置对象。
   */
  function readSettings() {
    let base = pluginConfig;
    try {
      const resolved = settingsSource();
      if (resolved !== null && typeof resolved === 'object') base = resolved;
    } catch {
      // 用 config 兜底。
    }
    return normalizeSettings({ ...base, ...overlay });
  }

  /**
   * 写一个设置键。优先写进 settings 文档（真源），失败则退回进程内覆盖。
   *
   * @param {string} key - 配置键。
   * @param {unknown} value - 值。
   * @returns {Promise<boolean>} 是否写进了 settings 文档。
   */
  async function writeSetting(key, value) {
    const settings = settingsService;
    if (settings && typeof settings.update === 'function') {
      try {
        await settings.update(SETTINGS_NAMESPACE, { [key]: value });
        overlay = { ...overlay, [key]: value };
        return true;
      } catch (error) {
        warn(`写设置 ${key} 失败，改为进程内覆盖`, error);
      }
    }
    overlay = { ...overlay, [key]: value };
    return false;
  }

  /** 画面的展开请求：客户端轮询 `/status` 时看到 epoch 变化就去 `openTab`。 */
  const panelOpen = { sessionId: null, epoch: 0, reason: '' };

  /**
   * 请求客户端展开画面。
   *
   * `reason === 'launch'` 是**冷启动后的自动展开**，受 `panelAutoOpenOnLaunch`
   * 控制；其它来源（`/browser`）不受它限制。
   *
   * @param {string} reason - 来源。
   * @param {string | null} [sessionId] - 目标会话；null 表示「谁看到谁开」。
   * @returns {void}
   */
  function requestPanelOpen(reason, sessionId = null) {
    if (reason === 'launch' && !readSettings().panelAutoOpenOnLaunch) return;
    panelOpen.epoch += 1;
    panelOpen.sessionId = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
    panelOpen.reason = reason;
    info(`请求展开画面（${reason}，epoch=${panelOpen.epoch}）`);
  }

  // ── 设置命名空间 ──────────────────────────────────────────────────────────
  // 0.2：行不再“登记”namespace —— settings 服务按行 id 描述条目，schema 来自上面
  // 导出的 `Config`，namespace 就等于 `cordis.patch.yml` 的 row id
  // （`SETTINGS_NAMESPACE`）。这里只做两件事：把服务引用留给读写用，并声明
  // 「本行自带页面」（`auto: false`），免得设置页再自动生成一份表单。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.effect(() => {
        const settings = settingsCtx.settings;
        settingsService = settings && typeof settings.describe === 'function' ? settings : null;
        if (settingsService === null) {
          warn('settings 服务不可用；配置界面不会显示本插件（其余功能照常）');
          return () => {};
        }
        // 活读：每次读设置都问一遍 describe()，用户层改动立刻生效。
        settingsSource = () => {
          try {
            const forms = settingsService.describe();
            const mine = Array.isArray(forms)
              ? forms.find((form) => form !== null && typeof form === 'object' && form.ns === SETTINGS_NAMESPACE)
              : undefined;
            const value = mine && mine.value;
            return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
          } catch (error) {
            warn('读取设置失败；本次用行配置兜底', error);
            return null;
          }
        };
        try {
          const dispose = typeof settings.configure === 'function'
            ? settings.configure({ auto: false }, ctx.fiber)
            : undefined;
          info(`设置命名空间 "${SETTINGS_NAMESPACE}" 已挂载（自带页面）`);
          return typeof dispose === 'function' ? dispose : () => {};
        } catch (error) {
          warn('settings.configure 失败；插件面板不会出现本插件的配置页', error);
          return () => {};
        }
      });
    });
  }

  // ── 控制面 HTTP ───────────────────────────────────────────────────────────
  const model = createModelSubmitter({ warn });

  ctx.inject(['webServer'], (webCtx) => {
    try {
      const route = createControlRoute({
        instance,
        readSettings,
        writeSetting,
        requestPanelOpen,
        panelOpen: () => ({ ...panelOpen }),
        getCdpPages: () => {
          try {
            const client = sharedCdpClient;
            if (client === null || typeof client.pages !== 'function') return [];
            if (typeof client.isConnected === 'function' && !client.isConnected()) return [];
            return client.pages();
          } catch {
            return [];
          }
        },
        getCdpClient: getSharedClient,
        browserRoot,
        warn,
      });
      webCtx.effect(() => webCtx.webServer.register(route), `${name}: control plane`);
      info(`控制面已挂载：${ROUTE_PREFIX}`);
    } catch (error) {
      warn('控制面路由注册失败；胶囊会一直显示未启动', error);
    }
  });

  const pageDriver = createPageDriver({
    getEndpoint: () => instance.endpoint,
    loadPlaywright: () => loadPlaywrightCore({ dshHome: resolveDshHome() }),
    info,
    warn,
  });

  // ── 读类工具（P1） ────────────────────────────────────────────────────────
  // 工具在**插件加载时**注册，不随实例启停增减（DESIGN.zh.md §6）：提示词里始终
  // 看得到它们，实例没起来时返回结构化错误（`browser-not-running` 等）。
  // 注销走 `ctx.effect`：插件卸载时把五个定义一起撤掉。
  ctx.inject(['tools'], (toolsCtx) => {
    try {
      const { registered } = registerBrowserTools(toolsCtx, {
        instance,
        browserRoot,
        readSettings,
        pageDriver,
        warn,
        info,
      });
      if (registered > 0) info(`已注册 ${registered} 个 ${TOOL_PREFIX}* 工具`);
    } catch (error) {
      // 重名（同一个插件装两次）会让 dsh-tools 直接抛错；这里抓住它，让插件的其余
      // 部分（胶囊、控制面）照常工作。
      warn(`${TOOL_PREFIX}* 工具注册失败；模型侧不会看到它们`, error);
    }
  });

  // ── 共享一条 CDP 连接 ─────────────────────────────────────────────────────
  // 一个工作区只有一个浏览器：读工具、写工具、画面都走同一条连接。各建各的会出现
  // 两份 target 表、两套 attach 状态，事件还会各收一半（P1 的实现约定）。
  let sharedCdpClient = null;
  /** 上一次给客户端用的端口：用来发现"实例换端口了"。 */
  let sharedClientPort = 0;
  /** 上一次的 wsPath：Chrome 重启后 UUID 路径会变，只看端口不够。 */
  let sharedClientWsPath = '';

  function getSharedClient() {
    // ⚠️ **实例重启会换端口**（随机端口是设计如此），而 CDP 客户端一旦连上就不会自己
    // 发现端点变了 —— `connect()` 还是幂等的（已连接直接返回）。真机症状：面板与画面
    // 一直连着**上一个已经死掉的实例**，于是"已启动但永远没有标签页、永远等第一帧"，
    // 而且面板显示的端口和胶囊（走 `/status`）显示的端口**不是同一个**。
    // 写工具注册时可能 port=0，不能把 sharedClientPort 冻死在 0 上。
    const wantPort = instance.endpoint.port;
    const wantWsPath = typeof instance.endpoint.wsPath === 'string' ? instance.endpoint.wsPath : '';
    const endpointDrifted =
      sharedCdpClient !== null
      && wantPort !== 0
      && (
        sharedClientPort === 0
        || sharedClientPort !== wantPort
        || (wantWsPath !== '' && sharedClientWsPath !== '' && sharedClientWsPath !== wantWsPath)
      );
    if (endpointDrifted) {
      info(`实例端点 ${sharedClientPort || '未定'}${sharedClientWsPath ? sharedClientWsPath : ''} → ${wantPort}${wantWsPath}，重建 CDP 连接`);
      try {
        sharedCdpClient.close('endpoint-changed');
      } catch {
        /* 关不掉也无所谓，下面直接换新实例 */
      }
      sharedCdpClient = null;
      void pageDriver.disconnect();
    }
    if (sharedCdpClient === null) {
      sharedClientPort = wantPort;
      sharedClientWsPath = wantWsPath;
      const created = createCdpClient({
        getEndpoint: () => instance.endpoint,
        getProfileDir: () => instance.dataDir,
        info,
        warn,
        onClosed: (payload) => {
          info(`CDP 连接已断开（code=${payload.code}，${payload.reason}）；下次调用会重连。`);
          // 清掉引用，避免一直握着已 close 的实例（尤其是握手失败后）。
          if (sharedCdpClient === created) {
            sharedCdpClient = null;
            sharedClientPort = 0;
            sharedClientWsPath = '';
          }
        },
      });
      sharedCdpClient = created;
    }
    return sharedCdpClient;
  }

  // ── 写类工具（P2） ────────────────────────────────────────────────────────
  ctx.inject(['tools'], (toolsCtx) => {
    try {
      const { registered } = registerWriteTools(toolsCtx, {
        instance,
        readSettings,
        pageDriver,
        client: getSharedClient(),
        // 写操作默认全部放行，不再询问。
        authorizeWrite: () => true,
        warn,
        info,
      });
      if (registered > 0) info(`已注册 ${registered} 个写类工具`);
    } catch (error) {
      // 重名同样会让 dsh-tools 抛错；抓住它，胶囊与控制面照常工作。
      warn('写类工具注册失败；模型侧不会看到它们', error);
    }
  });

  ctx.inject(['tools'], (toolsCtx) => {
    try {
      const { registered } = registerSaveSkillTool(toolsCtx, { browserRoot });
      if (registered > 0) info('已注册保存浏览器技能的工具');
    } catch (error) {
      warn('保存技能工具注册失败', error);
    }
  });

  // ── 画面通道（P3） ────────────────────────────────────────────────────────
  let screencastHub = null;
  ctx.inject(['webServer'], (streamCtx) => {
    try {
      screencastHub = createScreencastHub({
        getClient: getSharedClient,
        // 每次现读设置：改帧率/质量立刻生效，不用重启实例。
        getRoles: () => {
          const settingsNow = readSettings();
          return {
            focus: {
              fps: settingsNow.streamFocusFps,
              maxWidth: settingsNow.streamFocusMaxWidth,
              quality: settingsNow.streamFocusQuality,
            },
            thumb: {
              fps: settingsNow.streamThumbFps,
              maxWidth: settingsNow.streamThumbMaxWidth,
              quality: settingsNow.streamThumbQuality,
            },
          };
        },
        // Chrome `/json/list`：顺序 + 完整页面（CDP 未就绪时给胶片条 stubs）。
        listPageOrder: async () => {
          try {
            const probe = await instance.probeEndpoint();
            // list 超时也会带回 lastGoodPages；空数组才表示真没有。
            return (probe.pages ?? [])
              .filter((page) => typeof page?.id === 'string' && page.id !== '')
              .map((page) => ({
                id: page.id,
                targetId: page.id,
                type: page.type ?? 'page',
                url: typeof page.url === 'string' ? page.url : '',
                title: typeof page.title === 'string' ? page.title : '',
              }));
          } catch {
            return [];
          }
        },
        warn,
        info,
      });
      const route = createStreamRoute({ hub: screencastHub, getClient: getSharedClient, warn, info });
      streamCtx.effect(() => streamCtx.webServer.registerUpgrade(route), `${name}: stream`);
      info(`画面通道已挂载：${STREAM_PATH}`);
    } catch (error) {
      warn('画面通道注册失败；右侧栏不会有实时画面', error);
    }
  });

  // ── `/browser` 命令（P5） ─────────────────────────────────────────────────
  ctx.inject(['commands'], (commandCtx) => {
    try {
      const command = createBrowserCommand({
        instance,
        listSkillNames: () => listSkills(browserRoot).map((skill) => skill.name),
        listTabs: async () => {
          const client = getSharedClient();
          await client.connect();
          return client.pages().map((page) => ({
            id: page.targetId ?? page.id,
            url: page.url ?? '',
            title: page.title ?? '',
          }));
        },
        openTab: async (url) => {
          const client = getSharedClient();
          await client.connect();
          // `Target.createTarget` 是浏览器级命令，必须走 commandBrowser（不带 sessionId）。
          // 一个工作区只有一个窗口，所以**不传 `newWindow`**。
          let created;
          try {
            // `background` 的参数名还没实测（DESIGN §10 V6）：先按它传，被拒就退回不带。
            created = await client.commandBrowser('Target.createTarget', { url, background: true });
          } catch (error) {
            warn('Target.createTarget 不接受 background 参数，改为不带它重试', error);
            created = await client.commandBrowser('Target.createTarget', { url });
          }
          const targetId = created?.targetId ?? '';
          // 新开的标签要成为**默认 target**：否则随后的 snapshot/click 还在操作旧标签，
          // 而命令已经把 targetId 告诉模型了 —— 两边会各说各话（真机验证时踩到过）。
          if (targetId !== '' && typeof client.selectTarget === 'function') {
            try {
              client.selectTarget(targetId);
            } catch (error) {
              warn('切默认 target 失败；请让模型用 workspace_browser_select_tab', error);
            }
          }
          return { targetId, url };
        },
        focusPanel: (sessionId) => requestPanelOpen('command', sessionId),
        submit: (agent, text) => {
          if (!model.submit(agent, text)) {
            warn(`命令没能把内容交给模型（${model.reason() || '未知原因'}）`);
          }
        },
        warn,
      });
      commandCtx.effect(() => commandCtx.commands.register(command), `${name}: /${command.name}`);
      info(`命令 /${command.name} 已注册`);
    } catch (error) {
      warn('命令注册失败；/browser 会用不了', error);
    }
  });

  // ── 生命周期 ──────────────────────────────────────────────────────────────
  instance.startHeartbeat();
  // 退出策略写在设置里。只靠 effect 的话，宿主进程退出时往往等不到异步的 stop。
  const shutdownBrowser = () => instance.dispose();
  process.once('SIGINT', () => { void shutdownBrowser(); });
  process.once('SIGTERM', () => { void shutdownBrowser(); });
  process.once('beforeExit', () => { void shutdownBrowser(); });
  process.on('exit', () => {
    try {
      instance.killOnExitSync();
    } catch {
      // 退出阶段不能再抛。
    }
  });
  ctx.effect(() => () => {
    // 卸载时把共享连接和画面采集一起收掉，别留着幽灵 WebSocket。
    try {
      screencastHub?.dispose?.();
    } catch {
      /* 卸载失败不影响进程退出 */
    }
    try {
      sharedCdpClient?.close('plugin-unload');
    } catch {
      /* 同上 */
    }
    void pageDriver.disconnect();
    void instance.dispose();
  }, `${name}: instance`);

  info(`工作区 ${workspacePath ?? '(未分组)'} → ${workspaceKey}；数据目录 ${browserRoot}`);

  // 供 `--patch` 覆盖或调试时读取（不进模型）。
  try {
    ctx.provide('workspaceBrowser', {
      get workspaceKey() {
        return workspaceKey;
      },
      get browserRoot() {
        return browserRoot;
      },
      status: () => instance.status(),
      readSettings,
      panelOpen: () => ({ ...panelOpen }),
    });
  } catch {
    // provide 冲突不影响功能。
  }
}
