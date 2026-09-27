/**
 * 把技能文件交给系统：打开，或在文件资源管理器里选中。
 *
 * 只接受已经落在技能目录里的文件，不跟用户给的路径走。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/skill-file
 */

import { spawn, spawnSync } from 'node:child_process';

import { skillFileOf } from './skills.js';

/**
 * 打开技能文件，或在资源管理器中显示它。
 *
 * @param {string} browserRoot - 数据根。
 * @param {string} name - 技能名。
 * @param {'open' | 'reveal'} action - `open` 打开文件，`reveal` 在资源管理器中选中。
 * @param {{ spawn?: typeof spawn }} [options] - 测试可替换 spawn。
 * @returns {{ ok: true, file: string } | { ok: false, error: string }} 结果。
 */
export function presentSkillFile(browserRoot, name, action, options = {}) {
  const file = skillFileOf(browserRoot, name);
  if (file === '') return { ok: false, error: '没有这个技能' };
  const spec = action === 'open' ? openCommand(file) : action === 'reveal' ? revealCommand(file) : null;
  if (spec === null) return { ok: false, error: '不认识这个动作' };
  const launched = launch(spec, options.spawn);
  return launched.ok ? { ok: true, file } : launched;
}

/**
 * 打开文件的命令。Windows 用 `start`，让系统用关联程序打开工作区里的这个文件。
 *
 * @param {string} file - 绝对路径。
 * @returns {{ command: string, args: string[] }} 命令。
 */
function openCommand(file) {
  if (process.platform === 'win32') {
    // 标题和路径必须分成独立参数。合成一句再交给 cmd 时，Node 会把引号转成
    // `\"`，cmd 不认这种转义，`start` 直接语法错误，窗口不会出现。
    return { command: 'cmd.exe', args: ['/d', '/c', 'start', '', file], wait: true };
  }
  if (process.platform === 'darwin') return { command: 'open', args: [file] };
  return { command: 'xdg-open', args: [file] };
}

/**
 * 在系统文件管理器里选中文件。
 *
 * @param {string} file - 绝对路径。
 * @returns {{ command: string, args: string[] }} 命令。
 */
function revealCommand(file) {
  if (process.platform === 'win32') {
    // `windowsHide` 会把资源管理器窗口一起藏掉，所以这里显式不要隐藏。
    return { command: 'explorer.exe', args: [`/select,"${file}"`], verbatim: true, hide: false };
  }
  if (process.platform === 'darwin') return { command: 'open', args: ['-R', file] };
  return { command: 'xdg-open', args: [file.slice(0, Math.max(0, file.lastIndexOf('/'))) || '.'] };
}

/**
 * 启动系统命令。
 *
 * 打开文件时等 `start` 返回：它马上结束，失败码才能变成「打不开」。
 * 资源管理器经常不退出，所以只脱钩，不等它。
 *
 * @param {{ command: string, args: string[], wait?: boolean, verbatim?: boolean }} spec - 命令。
 * @param {typeof spawn | undefined} run - 测试注入的 spawn。
 * @returns {{ ok: true } | { ok: false, error: string }} 是否启动成功。
 */
function launch(spec, run) {
  if (typeof run === 'function') {
    try {
      const child = run(spec.command, spec.args);
      if (child && typeof child.unref === 'function') child.unref();
      return { ok: true };
    } catch {
      return { ok: false, error: '打不开这个文件' };
    }
  }
  const stdio = 'ignore';
  if (spec.wait === true) {
    const result = spawnSync(spec.command, spec.args, {
      windowsHide: spec.hide !== false,
      stdio,
      windowsVerbatimArguments: spec.verbatim === true,
    });
    if (result.error || result.status) return { ok: false, error: '打不开这个文件' };
    return { ok: true };
  }
  try {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio,
      windowsHide: spec.hide !== false,
      windowsVerbatimArguments: spec.verbatim === true,
    });
    if (typeof child.unref === 'function') child.unref();
    return { ok: true };
  } catch {
    return { ok: false, error: '打不开这个文件' };
  }
}
