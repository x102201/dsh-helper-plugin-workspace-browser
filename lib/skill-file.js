/**
 * 把技能文件交给系统：打开，或在文件资源管理器里选中。
 *
 * 只接受已经落在技能目录里的文件，不跟用户给的路径走。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/skill-file
 */

import { spawn } from 'node:child_process';

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
  const run = options.spawn ?? spawn;
  if (action === 'open') {
    launch(run, openCommand(file));
    return { ok: true, file };
  }
  if (action === 'reveal') {
    launch(run, revealCommand(file));
    return { ok: true, file };
  }
  return { ok: false, error: '不认识这个动作' };
}

/**
 * 打开文件的命令。Windows 用 `start`，让系统用关联程序打开工作区里的这个文件。
 *
 * @param {string} file - 绝对路径。
 * @returns {{ command: string, args: string[] }} 命令。
 */
function openCommand(file) {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${file}"`] };
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
  if (process.platform === 'win32') return { command: 'explorer.exe', args: [`/select,${file}`] };
  if (process.platform === 'darwin') return { command: 'open', args: ['-R', file] };
  return { command: 'xdg-open', args: [file.slice(0, Math.max(0, file.lastIndexOf('/'))) || '.'] };
}

/**
 * 启动后马上脱钩，不等资源管理器退出。
 *
 * @param {typeof spawn} run - spawn。
 * @param {{ command: string, args: string[] }} spec - 命令。
 * @returns {void}
 */
function launch(run, spec) {
  let child;
  try {
    child = run(spec.command, spec.args, { detached: true, stdio: 'ignore', windowsHide: true });
  } catch {
    return;
  }
  if (child && typeof child.unref === 'function') child.unref();
}
