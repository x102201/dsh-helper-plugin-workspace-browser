/**
 * 把工作区 Chrome 的真实窗口唤到操作系统前台（Windows）。
 *
 * CDP `/json/activate` / `Page.bringToFront` 往往只在浏览器**内部**切标签，
 * 窗口仍在后面时 Windows 只会闪任务栏。用户点「显示浏览器窗口」时需要 Win32。
 *
 * 非 Windows：直接 no-op（成功），由调用方继续走 CDP 恢复。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/win-focus
 */

import { spawn } from 'node:child_process';

/** 唤起窗口的超时。 */
const FOCUS_TIMEOUT_MS = 4000;

/**
 * 用 Win32 把给定 PID 列表里带主窗口的进程提到前台。
 *
 * @param {number[]} pids - Chrome 相关 PID（浏览器进程 + 子进程均可）。
 * @returns {Promise<{ ok: boolean, reason: string }>} 结果；非 Windows 为 `{ ok: true, reason: 'not-windows' }`。
 */
export function bringProcessWindowsToFront(pids) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: true, reason: 'not-windows' });
  }
  const list = [...new Set((Array.isArray(pids) ? pids : [])
    .map((value) => Number(value))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (list.length === 0) {
    return Promise.resolve({ ok: false, reason: 'no-pids' });
  }

  // 用户刚点了按钮：用 AttachThreadInput 绕过「前台锁」，避免只闪任务栏。
  const pidLiteral = list.join(',');
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class DshFg {',
    '  public const int SW_RESTORE = 9;',
    '  public const int SW_SHOW = 5;',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
    '  public const byte VK_MENU = 0x12;',
    '  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;',
    '  public const uint KEYEVENTF_KEYUP = 0x0002;',
    '}',
    "'@",
    `\$pids = @(${pidLiteral})`,
    '$ok = $false',
    'foreach ($procId in $pids) {',
    '  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue',
    '  if ($null -eq $proc) { continue }',
    '  if ($proc.MainWindowHandle -eq 0) { continue }',
    '  $hwnd = [IntPtr]$proc.MainWindowHandle',
    '  if ([DshFg]::IsIconic($hwnd)) { [void][DshFg]::ShowWindow($hwnd, [DshFg]::SW_RESTORE) }',
    '  else { [void][DshFg]::ShowWindow($hwnd, [DshFg]::SW_SHOW) }',
    '  $fg = [DshFg]::GetForegroundWindow()',
    '  $dummy = 0',
    '  $tForeground = [DshFg]::GetWindowThreadProcessId($fg, [ref]$dummy)',
    '  $tTarget = [DshFg]::GetWindowThreadProcessId($hwnd, [ref]$dummy)',
    '  $tCurrent = [DshFg]::GetCurrentThreadId()',
    '  if ($tForeground -ne $tTarget) {',
    '    [void][DshFg]::AttachThreadInput($tCurrent, $tForeground, $true)',
    '    [void][DshFg]::AttachThreadInput($tCurrent, $tTarget, $true)',
    '  }',
    '  [DshFg]::keybd_event([DshFg]::VK_MENU, 0, [DshFg]::KEYEVENTF_EXTENDEDKEY, [UIntPtr]::Zero)',
    '  [DshFg]::keybd_event([DshFg]::VK_MENU, 0, [DshFg]::KEYEVENTF_EXTENDEDKEY -bor [DshFg]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)',
    '  [void][DshFg]::BringWindowToTop($hwnd)',
    '  $ok = [DshFg]::SetForegroundWindow($hwnd)',
    '  if ($tForeground -ne $tTarget) {',
    '    [void][DshFg]::AttachThreadInput($tCurrent, $tForeground, $false)',
    '    [void][DshFg]::AttachThreadInput($tCurrent, $tTarget, $false)',
    '  }',
    '  if ($ok) { break }',
    '}',
    'if ($ok) { "ok" } else { "fail" }',
  ].join('\n');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, reason: 'timeout' });
    }, FOCUS_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const text = out.trim().toLowerCase();
      if (text.includes('ok')) resolve({ ok: true, reason: 'focused' });
      else resolve({ ok: false, reason: text || 'fail' });
    });
  });
}

/**
 * 用 CDP 把目标所在窗口从最小化恢复，并在浏览器内切到该标签。
 *
 * @param {object | null} client - CDP 客户端。
 * @param {string} targetId - 标签 id。
 * @returns {Promise<void>} 结束时 resolve（失败不抛，由调用方记日志）。
 */
export async function restoreChromeWindowViaCdp(client, targetId) {
  if (client === null || typeof client !== 'object' || typeof targetId !== 'string' || targetId === '') return;
  if (typeof client.connect === 'function') {
    try {
      await client.connect();
    } catch {
      return;
    }
  }
  if (typeof client.isConnected === 'function' && !client.isConnected()) return;

  if (typeof client.commandBrowser === 'function') {
    try {
      const win = await client.commandBrowser('Browser.getWindowForTarget', { targetId }, { timeoutMs: 3000 });
      const windowId = win?.windowId;
      if (typeof windowId === 'number') {
        // normal：从 minimized / maximized 拉回可交互；不改位置尺寸。
        await client.commandBrowser(
          'Browser.setWindowBounds',
          { windowId, bounds: { windowState: 'normal' } },
          { timeoutMs: 3000 },
        );
      }
    } catch {
      /* 旧 Chrome 或无窗口映射时忽略 */
    }
  }

  if (typeof client.command === 'function') {
    try {
      await client.command(targetId, 'Page.bringToFront', {}, { timeoutMs: 3000 });
    } catch {
      /* activate 已做过；这里是双保险 */
    }
  }
}
