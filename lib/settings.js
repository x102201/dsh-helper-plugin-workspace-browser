/**
 * 设置命名空间与 schema（DESIGN.zh.md §8「配置项」）。
 *
 * namespace 必须匹配 `/^[a-z][a-z0-9-]*$/`，落在 `<DSH_HOME>/settings.yaml`
 * 顶层；配置界面是 设置 → 插件 → 插件配置。
 *
 * 键一律**扁平 camelCase**（不用 `capsule.enabled` 这种点路径）：设置文档是
 * 一份普通映射，扁平键让它一眼可读，也避开嵌套路径在 UI 写入时的歧义。
 * 与文档的对应关系写在 README 的配置表里。
 *
 * schemastery 不能静态导入 —— `link:` 安装下 Node 从包的真实路径解析裸导入，
 * 拿不到 profile 的 `node_modules`。所以这里**动态解析**，解析不到就用等价的
 * 可调用 fallback（与 dsh-helper-plugin-agent-swarm 同一套做法，已验证可用）。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/settings
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** 设置命名空间（也是设置卡片的 key）。 */
export const SETTINGS_NAMESPACE = 'dsh-helper-plugin-workspace-browser';

/** 配置键（顺序即设置页里的展示顺序）。 */
export const SETTINGS_KEYS = Object.freeze([
  'capsuleEnabled',
  'capsuleShowPort',
  'panelAutoOpenOnLaunch',
  'panelTileSplit',
  'panelSkillHeight',
  'panelFollowFrontTab',
  'streamFocusFps',
  'streamFocusMaxWidth',
  'streamFocusQuality',
  'streamThumbFps',
  'streamThumbMaxWidth',
  'streamThumbQuality',
  'userDataDir',
  'debugPort',
  'chromeCrossOrigin',
  'instanceOnDshExit',
]);

/** 默认值（DESIGN.zh.md §8 配置项表）。 */
export const FIELD_DEFAULTS = Object.freeze({
  /** 显示输入框那一行的胶囊。 */
  capsuleEnabled: true,
  /** 胶囊文案里带端口号。 */
  capsuleShowPort: true,
  /** 冷启动成功后展开当前会话的画面。 */
  panelAutoOpenOnLaunch: true,
  /** 焦点区高度占比（分隔条拖拽后写入）。 */
  panelTileSplit: 0.55,
  /** 胶片条下面技能区的高度（像素，拖分隔条后写入）。 */
  panelSkillHeight: 72,
  /** 焦点是否跟随窗口里最顶层的标签。 */
  panelFollowFrontTab: false,
  /** 焦点流帧率。 */
  streamFocusFps: 2,
  /** 焦点流最大宽度。 */
  streamFocusMaxWidth: 960,
  /** 焦点流 JPEG 质量，**0–100 的整数**（对应 `Page.startScreencast` 的 quality）。 */
  streamFocusQuality: 70,
  /** 缩略图帧率；0 表示不要缩略图。 */
  streamThumbFps: 0.25,
  /** 缩略图最大宽度。 */
  streamThumbMaxWidth: 160,
  /** 缩略图质量，0–100。 */
  streamThumbQuality: 50,
  /**
   * 用户指定的 Chrome 用户数据目录。空表示用这个工作区自己的 profile。
   * 填了就用这份已经登录过的目录。
   */
  userDataDir: '',
  /**
   * 调试端口。0 表示启动时自动分配。填了就连接这个端口；
   * 端口上已经有窗口就直接用，不再另开。
   */
  debugPort: 0,
  /** `--disable-web-security` 等跨域参数（见 §4「跨域」）。 */
  chromeCrossOrigin: false,
  /** DSH 退出时浏览器去向：`keep` 或 `close`。 */
  instanceOnDshExit: 'keep',
});

/** DSH 退出时的行为取值。 */
export const ON_DSH_EXIT = Object.freeze(['keep', 'close']);

/**
 * 从若干候选根目录里找 schemastery。
 *
 * @returns {object | undefined} schemastery 的默认导出。
 */
function tryLoadSchemastery() {
  const roots = new Set();
  const push = (start) => {
    let dir = start;
    for (let i = 0; i < 10 && dir; i += 1) {
      roots.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  };
  push(process.cwd());
  if (process.env.DSH_HOME) {
    push(process.env.DSH_HOME);
    roots.add(join(process.env.DSH_HOME, 'profiles'));
    roots.add(join(process.env.DSH_HOME, 'profiles', 'web'));
    roots.add(join(process.env.DSH_HOME, '..', 'dsh'));
  }
  roots.add(join(process.cwd(), '.dsh', 'profiles', 'web'));

  for (const root of roots) {
    const pkg = join(root, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json');
    if (!existsSync(pkg)) continue;
    try {
      const loaded = createRequire(pkg)('@deepseek-ai/schemastery');
      return loaded?.default ?? loaded;
    } catch {
      // 换下一个根目录。
    }
  }
  return undefined;
}

/** 抛出一个带键名的设置错误。 */
function fail(key, expectation) {
  throw new Error(`${SETTINGS_NAMESPACE}: ${key} ${expectation}`);
}

/** 校验并补齐布尔键。 */
function readBoolean(input, key, out) {
  const value = input[key] === undefined ? FIELD_DEFAULTS[key] : input[key];
  if (typeof value !== 'boolean') fail(key, '必须是布尔值');
  out[key] = value;
}

/** 校验并补齐整数键（含上下限）。 */
function readInteger(input, key, out, min, max) {
  const value = input[key] === undefined ? FIELD_DEFAULTS[key] : input[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.trunc(value) !== value) {
    fail(key, '必须是整数');
  }
  if (value < min || value > max) fail(key, `必须在 ${min}–${max} 之间`);
  out[key] = value;
}

/** 校验并补齐浮点键（含上下限）。 */
function readNumber(input, key, out, min, max) {
  const value = input[key] === undefined ? FIELD_DEFAULTS[key] : input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(key, '必须是数字');
  if (value < min || value > max) fail(key, `必须在 ${min}–${max} 之间`);
  out[key] = value;
}

/** 校验并补齐枚举键。 */
function readEnum(input, key, out, allowed) {
  const value = input[key] === undefined ? FIELD_DEFAULTS[key] : input[key];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(key, `必须是 ${allowed.join(' / ')} 之一`);
  }
  out[key] = value;
}

/**
 * 校验并补齐一份设置文档。未知键原样丢弃 —— 设置文档由 UI 写入，不该带噪声。
 *
 * @param {unknown} data - 原始设置映射。
 * @returns {object} 完整的设置对象。
 */
export function normalizeSettings(data) {
  const input = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const out = {};

  readBoolean(input, 'capsuleEnabled', out);
  readBoolean(input, 'capsuleShowPort', out);
  readBoolean(input, 'panelAutoOpenOnLaunch', out);
  readNumber(input, 'panelTileSplit', out, 0.15, 0.85);
  readInteger(input, 'panelSkillHeight', out, 40, 360);
  readBoolean(input, 'panelFollowFrontTab', out);

  readNumber(input, 'streamFocusFps', out, 0.5, 10);
  readInteger(input, 'streamFocusMaxWidth', out, 160, 3840);
  readInteger(input, 'streamFocusQuality', out, 1, 100);
  readNumber(input, 'streamThumbFps', out, 0, 1);
  readInteger(input, 'streamThumbMaxWidth', out, 64, 640);
  readInteger(input, 'streamThumbQuality', out, 1, 100);

  const userDataDir = input.userDataDir === undefined ? FIELD_DEFAULTS.userDataDir : input.userDataDir;
  if (typeof userDataDir !== 'string') fail('userDataDir', '必须是字符串');
  out.userDataDir = userDataDir.trim();
  readInteger(input, 'debugPort', out, 0, 65535);
  readBoolean(input, 'chromeCrossOrigin', out);
  readEnum(input, 'instanceOnDshExit', out, ON_DSH_EXIT);

  return out;
}

/** schemastery 不可用时的等价可调用 schema。 */
function createFallbackSchema() {
  const dict = {};
  const refs = {};
  const meta = {
    capsuleEnabled: { type: 'boolean' },
    capsuleShowPort: { type: 'boolean' },
    panelAutoOpenOnLaunch: { type: 'boolean' },
    panelTileSplit: { type: 'number' },
    panelSkillHeight: { type: 'number' },
    panelFollowFrontTab: { type: 'boolean' },
    streamFocusFps: { type: 'number' },
    streamFocusMaxWidth: { type: 'number' },
    streamFocusQuality: { type: 'number' },
    streamThumbFps: { type: 'number' },
    streamThumbMaxWidth: { type: 'number' },
    streamThumbQuality: { type: 'number' },
    userDataDir: { type: 'string' },
    debugPort: { type: 'number' },
    chromeCrossOrigin: { type: 'boolean' },
    instanceOnDshExit: { type: 'string' },
  };
  let uid = 1;
  for (const key of SETTINGS_KEYS) {
    refs[String(uid)] = { ...meta[key], meta: { default: FIELD_DEFAULTS[key] } };
    dict[key] = uid;
    uid += 1;
  }
  const objectUid = uid;
  refs[String(objectUid)] = { type: 'object', meta: { default: {} }, dict };

  function schema(data) {
    return normalizeSettings(data);
  }
  schema.type = 'object';
  schema.meta = { default: {} };
  schema.dict = Object.fromEntries(SETTINGS_KEYS.map((key) => [key, { ...meta[key], meta: { default: FIELD_DEFAULTS[key] } }]));
  schema.toJSON = () => ({ uid: objectUid, refs });
  return schema;
}

/**
 * 设置页要展示的 schema：能拿到 schemastery 就用它，否则用等价的 fallback。
 *
 * @returns {Function} 可调用 schema。
 */
export function createSettingsSchema() {
  const z = tryLoadSchemastery();
  if (z && typeof z.object === 'function') {
    try {
      return z.object({
        capsuleEnabled: z.boolean().default(FIELD_DEFAULTS.capsuleEnabled),
        capsuleShowPort: z.boolean().default(FIELD_DEFAULTS.capsuleShowPort),
        panelAutoOpenOnLaunch: z.boolean().default(FIELD_DEFAULTS.panelAutoOpenOnLaunch),
        panelTileSplit: z.number().min(0.15).max(0.85).default(FIELD_DEFAULTS.panelTileSplit),
        panelSkillHeight: z.number().step(1).min(40).max(360).default(FIELD_DEFAULTS.panelSkillHeight),
        panelFollowFrontTab: z.boolean().default(FIELD_DEFAULTS.panelFollowFrontTab),
        streamFocusFps: z.number().min(0.5).max(10).default(FIELD_DEFAULTS.streamFocusFps),
        streamFocusMaxWidth: z.number().step(1).min(160).max(3840).default(FIELD_DEFAULTS.streamFocusMaxWidth),
        streamFocusQuality: z.number().step(1).min(1).max(100).default(FIELD_DEFAULTS.streamFocusQuality),
        streamThumbFps: z.number().min(0).max(1).default(FIELD_DEFAULTS.streamThumbFps),
        streamThumbMaxWidth: z.number().step(1).min(64).max(640).default(FIELD_DEFAULTS.streamThumbMaxWidth),
        streamThumbQuality: z.number().step(1).min(1).max(100).default(FIELD_DEFAULTS.streamThumbQuality),
        userDataDir: z.string().default(FIELD_DEFAULTS.userDataDir),
        debugPort: z.number().step(1).min(0).max(65535).default(FIELD_DEFAULTS.debugPort),
        chromeCrossOrigin: z.boolean().default(FIELD_DEFAULTS.chromeCrossOrigin),
        instanceOnDshExit: z.union(ON_DSH_EXIT.map((value) => z.const(value))).default(FIELD_DEFAULTS.instanceOnDshExit),
      });
    } catch {
      // 任何构造失败都退回 fallback：没有 schema 就没有设置卡片。
    }
  }
  return createFallbackSchema();
}
