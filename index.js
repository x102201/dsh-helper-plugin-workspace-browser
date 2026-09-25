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

/** 稳定插件名；也是 `cordis.patch.yml` 里的 row id。 */
export const name = 'workspace-browser';

/**
 * 顶层 inject 留空：所有服务都用嵌套 `ctx.inject([...])` 惰性拿。
 *
 * 这样在只有宿主的 profile 里也能挂上（没有 `webServer` 就只是没有路由，
 * 不会让整个插件加载失败）。
 */
export const inject = [];

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
  // 嵌套 inject：只有宿主没有 settings 提供方时，插件其余部分照常工作。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = settingsCtx.settings;
      if (!settings || typeof settings.installSection !== 'function') return;
      settingsService = settings;
      try {
        settings.installSection(settingsCtx, SETTINGS_NAMESPACE, createSettingsSchema(), pluginConfig, {
          setSource: (current) => {
            settingsSource = typeof current === 'function' ? current : () => pluginConfig;
          },
          onChange: () => {
            // 真源变了：`settingsSource` 已经是活的读取器，直接通知实例层重新读。
            info('设置已更新');
            const settingsNow = readSettings();
            if (instance.status().state === 'running') {
              // 跨域等需要重启的键自己会走 `/cross-origin`；这里只记录，不擅自重启。
              info(`当前跨域开关：${settingsNow.chromeCrossOrigin ? '开' : '关'}`);
            }
          },
        });
        info(`设置命名空间 "${SETTINGS_NAMESPACE}" 已挂载`);
      } catch (error) {
        warn('settings.installSection 失败；设置 → 插件配置 不会显示本插件', error);
      }
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
        warn,
      });
      webCtx.effect(() => webCtx.webServer.register(route), `${name}: control plane`);
      info(`控制面已挂载：${ROUTE_PREFIX}`);
    } catch (error) {
      warn('控制面路由注册失败；胶囊会一直显示未启动', error);
    }
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
    }
    if (sharedCdpClient === null) {
      sharedClientPort = wantPort;
      sharedClientWsPath = wantWsPath;
      const created = createCdpClient({
        getEndpoint: () => instance.endpoint,
        profileDir: instance.profileDir,
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
        client: getSharedClient(),
        // 授权的真源是设置：要授权且还没授权就拦住。小面板与画面头上的
        // 「允许模型操作」写的就是 `toolsWriteAuthorized`（DESIGN.zh.md §6）。
        authorizeWrite: () => {
          const settingsNow = readSettings();
          return settingsNow.toolsWriteRequireApproval !== true || settingsNow.toolsWriteAuthorized === true;
        },
        warn,
        info,
      });
      if (registered > 0) info(`已注册 ${registered} 个写类工具`);
    } catch (error) {
      // 重名同样会让 dsh-tools 抛错；抓住它，胶囊与控制面照常工作。
      warn('写类工具注册失败；模型侧不会看到它们', error);
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
