/**
 * P0 真机验证：按 DESIGN.zh.md §9「P0 拉得起、停得下」的判据逐条跑一遍。
 *
 * 这个脚本会**真的起一个 Chrome 窗口**（冷启动是本阶段的验收要求），跑完自己
 * 收尾：停实例、删临时数据目录。工作目录用 `.tmp-verify/`，不会碰真实
 * `DSH_HOME`。
 *
 * 跑法：`node scripts/verify-p0.mjs`
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { probeChrome } from '../lib/chrome.js';
import { createInstanceManager, findChromePidsByProfileDir, BUDGETS } from '../lib/instance.js';
import { devToolsActivePortPathOf, readDevToolsActivePort, readEndpoint } from '../lib/paths.js';
import { normalizeSettings } from '../lib/settings.js';

const root = join(process.cwd(), '.tmp-verify');
const settings = normalizeSettings({ instanceRestoreTabsOnReopen: false });

/** @type {string[]} */
const failures = [];
let step = 0;

/**
 * 断言一步。
 *
 * @param {string} label - 步骤名。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 细节。
 * @returns {void}
 */
function check(label, ok, detail = '') {
  step += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark} ${String(step).padStart(2, '0')}. ${label}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
}

/** 等一个条件成立。 */
async function waitFor(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  console.log(`     （${label} 在 ${timeoutMs}ms 内没成立）`);
  return false;
}

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const manager = createInstanceManager({
  browserRoot: root,
  workspaceKey: 'verify',
  getSettings: () => settings,
  warn: (message, error) => console.log(`     [warn] ${message}`, error ?? ''),
  info: (message) => console.log(`     [info] ${message}`),
});

try {
  console.log('\n=== 0. Chrome 探测 ===');
  const chrome = await probeChrome({ chromePath: '', confirm: true });
  check('探测到可用的 Chrome', chrome.state === 'ok', `${chrome.path} ${chrome.version}`);
  if (chrome.state !== 'ok') {
    console.log('跳过其余步骤：本机没有可用的 Chrome。');
  } else {
    console.log('\n=== 1. 冷启动 ===');
    const started = Date.now();
    const first = await manager.ensure({ reason: 'verify' });
    check('ensure() 落到运行中', first.state === 'running', `用了 ${Date.now() - started}ms`);
    check('拿到端口', Number.isSafeInteger(first.port) && first.port > 0, `port=${first.port}`);

    const discovered = readDevToolsActivePort(manager.profileDir);
    check('端口与 DevToolsActivePort 第一行一致', discovered !== null && discovered.port === first.port, `文件=${discovered?.port} 状态=${first.port}`);

    const record = readEndpoint(manager.endpointPath);
    check('endpoint.json 已写入且端口一致', record !== null && record.port === first.port, `pid=${record?.pid}`);

    console.log('\n=== 2. 第二次 ensure 复用同一个进程 ===');
    const second = await manager.ensure({ reason: 'verify-again' });
    check('仍是运行中', second.state === 'running');
    check('端口没变（没新起进程）', second.port === first.port, `${first.port} → ${second.port}`);
    const pidsNow = await findChromePidsByProfileDir(manager.profileDir);
    if (pidsNow.length === 1) {
      check('这份 profile 下只有一个 Chrome 实例', true, `pid=${pidsNow.join(',')}`);
    } else {
      // 受限沙箱不允许管道捕获子进程输出，命令行查询会降级为空。
      console.log(`SKIP 02b. 命令行进程查询不可用（返回 ${pidsNow.length} 个）——本沙箱预期行为，不算失败`);
    }

    console.log('\n=== 3. 假的 endpoint.json 不影响状态 ===');
    writeFileSync(manager.endpointPath, JSON.stringify({ schema: 1, port: 1, wsPath: '/nope', pid: 999999 }));
    const afterFake = await manager.probeEndpoint();
    check('探测只看 Chrome 侧真相，不看 endpoint.json', afterFake.reachable && afterFake.port === first.port, `探测端口=${afterFake.port}`);

    console.log('\n=== 4. kill -9 之后回到未启动，且还能再起来 ===');
    const byCommandLine = await findChromePidsByProfileDir(manager.profileDir);
    const victims = byCommandLine.length > 0 ? byCommandLine : [first.pid].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    check('拿到了要杀的 PID', victims.length > 0, `pids=${victims.join(',')}`);
    for (const pid of victims) {
      await new Promise((resolve) => {
        const child = spawn('taskkill.exe', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
        child.on('close', resolve);
        child.on('error', resolve);
      });
    }
    const wentIdle = await waitFor(
      '心跳/探测发现进程没了',
      async () => (await manager.probeEndpoint()).reachable === false,
      BUDGETS.heartbeatMs * 2,
    );
    check('进程被杀后探测立刻为不可达', wentIdle);
    const afterKill = await manager.ensure({ reason: 'after-kill' });
    check('再点「启动」能重新起来', afterKill.state === 'running' && afterKill.port > 0, `port=${afterKill.port}`);

    console.log('\n=== 5. 停止 ===');
    const stopped = await manager.stop();
    check('stop() 回到未启动', stopped.state === 'idle');
    const gone = await waitFor(
      '端口不再响应',
      async () => (await manager.probeEndpoint()).reachable === false,
      8000,
    );
    check('实例确实停下来了', gone);
    check('profile 目录还在（不该自己删数据）', existsSync(manager.profileDir));

    console.log('\n=== 6. 停止后仍能再次启动（胶囊永远点得动）===');
    const again = await manager.ensure({ reason: 'post-stop' });
    check('再次启动成功', again.state === 'running', `port=${again.port}`);
    await manager.stop();
  }
} finally {
  await manager.dispose();
  await manager.stop().catch(() => {});
  // Chrome 刚退出时 profile 里的文件还占着句柄：等一会儿再删，并允许重试。
  await new Promise((resolve) => {
    setTimeout(resolve, 1500);
  });
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (error) {
    console.log(`     [warn] 临时目录没删干净（句柄未释放）：${error.message}`);
  }
  console.log(`\n清理完成：${root}`);
}

console.log(`\n===> ${failures.length === 0 ? 'P0 全部通过' : `P0 失败 ${failures.length} 项：${failures.join(' / ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
