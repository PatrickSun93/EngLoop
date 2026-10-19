'use strict';

/**
 * `bin/serve.sh` 在 launchd 那种环境下能不能用。
 *
 *   env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin ENGLOOP_PORT=<测试端口> …隔离变量… bash bin/serve.sh
 *
 * launchd 给 LaunchAgent 的 PATH 就是 `/usr/bin:/bin:/usr/sbin:/sbin`，不加载 shell profile。
 * 所以这里把环境整个清掉，只留 HOME、那条最小 PATH 和隔离 bus 要的变量（照 `test/graph-e2e.test.js` 那张表）。
 *
 * 断言三件事：
 *   ① bus 起来了（/health）
 *   ② watchdog 看得见 tmux：私有 socket 里起一个会话，`/api/agents` 的 `sessions_seen` 从 0 变成 ≥ 1
 *      （先断言是 0：证明它看的是私有那个 server，不是本机真的那个）
 *   ③ bus 的子进程找得到 `claude`、`tmux`、`node`、`git`：
 *      用 `NODE_OPTIONS=--require=<探针>` 把一小段代码放进 **bus 进程本身**，它 spawn `/bin/sh -c 'command -v …'`
 *      —— 那就是一个继承了 bus 环境的子进程。不起 claude。
 *      （macOS 上 `ps eww` 读不到别的进程的环境，所以探针得在进程里面。）
 *
 * ⛔ 隔离：测试端口 · Redis 测试库（allocTestDb）· 私有 tmux（TMUX_TMPDIR，env -i 本来就没有 TMUX）·
 *   所有状态文件 / 日志进临时目录 · worker 池关掉（ENGLOOP_WORKER_TYPES=','：serve.sh 用 `:-`，空串会被当成没设、
 *   换回默认四个池；',' 不空，而 serve.js 拆完 filter(Boolean) 是 [] ⇒ 一个池都不起）。测完 SIGTERM、kill-server。
 *
 * 变异：`ENGLOOP_SHMUT={file:'bin/serve.sh',from,to}` ⇒ 跑一份改过的副本（放在临时目录，bin/serve.js 软链回仓库）。
 *   不设时跑的就是仓库里那份 bin/serve.sh。驱动：`node scripts/mutate-launchd.js`。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const q = require('../lib/queue');
const auth = require('../lib/auth');

const PORT = 19991;   // 生产 9969 · e2e 19969 · bus-auth 19977 · graph-e2e 19983 · 19987 · launchd.test 19993
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const MIN_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';   // launchd 给 LaunchAgent 的 PATH

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本测试进程（人的 shell 环境）里 `command -v X` 的答案：参照物。 */
function whereInMyShell(bin) {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function main() {
  console.log('\nbin/serve.sh 在 launchd 那种最小环境下（env -i）\n');

  const busy = spawnSync('lsof', ['-ti', `:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim();
  if (busy) { ok(false, `测试端口 ${PORT} 被占着（pid ${busy}）—— 不跑`); finish(); }

  const testDb = q.allocTestDb();
  if (testDb === null) { ok(false, '拿不到测试库 —— 中止'); finish(); }
  const testUrl = q.withDb(q.DEFAULTS.url, testDb);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-e16env-'));
  const dirs = {};
  for (const d of ['outbox', 'state', 'tmux', 'graphs', 'history', 'outputs', 'verify', 'root']) {
    dirs[d] = path.join(tmp, d);
    fs.mkdirSync(dirs[d], { recursive: true });
  }
  const usersFile = path.join(tmp, 'users.json');
  const tokenFile = path.join(tmp, 'bus-admin.token');
  const busLog = path.join(tmp, 'bus.log');
  const probeOut = path.join(tmp, 'probe.json');
  const probeJs = path.join(tmp, 'probe.js');
  fs.writeFileSync(usersFile, JSON.stringify([
    { username: 'Patrick', key_sha256: auth.sha256(auth.newKey()), can_manage_workers: true },
  ]));
  // 探针：只在 bus 进程里动作（argv[1] 是 bin/serve.js），spawn 一个继承 bus 环境的 /bin/sh
  fs.writeFileSync(probeJs, `
const out = process.env.ENGLOOP_E16_PROBE_OUT;
if (out && /bin[\\\\/]serve\\.js$/.test(process.argv[1] || '')) {
  const { spawnSync } = require('child_process');
  const r = { pid: process.pid, PATH: process.env.PATH || null, execPath: process.execPath, found: {} };
  for (const b of ['claude', 'tmux', 'node', 'git', 'env', 'ps', 'which', 'agy', 'launchctl', 'sandbox-exec', 'lsof', 'python3', 'redis-cli']) {
    const x = spawnSync('/bin/sh', ['-c', 'command -v ' + b], { encoding: 'utf8' });
    r.found[b] = x.status === 0 ? x.stdout.trim() : null;
  }
  require('fs').writeFileSync(out, JSON.stringify(r));
}
`);

  // 要跑的 serve.sh：默认就是仓库里那份；变异时是临时目录里改过的副本（bin/serve.js 软链回来）
  let serveSh = path.join(ROOT, 'bin', 'serve.sh');
  const mut = process.env.ENGLOOP_SHMUT ? [].concat(JSON.parse(process.env.ENGLOOP_SHMUT)).filter((m) => m.file === 'bin/serve.sh') : [];
  if (mut.length) {
    let text = fs.readFileSync(serveSh, 'utf8');
    for (const m of mut) {
      if (!text.includes(m.from)) throw new Error(`[shmut] bin/serve.sh 里找不到要变异的原文：${JSON.stringify(m.from).slice(0, 120)}`);
      text = text.split(m.from).join(m.to);
    }
    fs.mkdirSync(path.join(dirs.root, 'bin'), { recursive: true });
    serveSh = path.join(dirs.root, 'bin', 'serve.sh');
    fs.writeFileSync(serveSh, text, { mode: 0o755 });
    fs.symlinkSync(path.join(ROOT, 'bin', 'serve.js'), path.join(dirs.root, 'bin', 'serve.js'));
    console.log(`  （变异：跑的是 ${serveSh}）`);
  }

  const busEnv = {
    HOME: os.homedir(),
    PATH: MIN_PATH,
    ENGLOOP_ISOLATED: '1',
    ENGLOOP_PORT: String(PORT),
    ENGLOOP_REDIS_URL: testUrl,
    ENGLOOP_OUTBOX_ROOT: dirs.outbox,
    ENGLOOP_HISTORY_ROOT: dirs.history,
    ENGLOOP_OUTPUTS_ROOT: dirs.outputs,
    ENGLOOP_THREAD_ALERT_DIR: path.join(dirs.state, 'thread-alert'),
    ENGLOOP_ADMIN_TOKEN_FILE: tokenFile,
    ENGLOOP_GRAPHS_ROOT: dirs.graphs,
    ENGLOOP_VERIFY_CACHE: dirs.verify,
    ENGLOOP_USERS_FILE: usersFile,
    ENGLOOP_WAITING_STATE: path.join(dirs.state, 'waiting.json'),
    ENGLOOP_BUSY_ROOT: path.join(dirs.state, 'busy'),
    ENGLOOP_DEADLETTER_ROOT: path.join(dirs.state, 'deadletter'),
    ENGLOOP_WORKER_TYPES: ',',
    ENGLOOP_BUS_LOG: busLog,
    TMUX_TMPDIR: dirs.tmux,
    NODE_OPTIONS: `--require=${probeJs}`,
    ENGLOOP_E16_PROBE_OUT: probeOut,
  };
  // 本进程用私有 tmux 时的环境（起 / 杀那个探针会话）
  const tmuxEnv = { ...process.env, TMUX_TMPDIR: dirs.tmux };
  delete tmuxEnv.TMUX; delete tmuxEnv.TMUX_PANE;
  const tmux = (args) => spawnSync('tmux', args, { env: tmuxEnv, encoding: 'utf8' });

  const argv = ['-i', ...Object.entries(busEnv).map(([k, v]) => `${k}=${v}`), '/bin/bash', serveSh];
  // env 和 bash 都 exec ⇒ 这个 pid 最后就是 node bus 本身
  const bus = spawn('/usr/bin/env', argv, { cwd: tmp, stdio: 'ignore' });
  let exited = null;
  bus.on('exit', (code, sig) => { exited = { code, sig }; });
  const cleanup = () => {
    try { if (exited === null) bus.kill('SIGKILL'); } catch (_) { /* 已经没了 */ }
    tmux(['kill-server']);
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  process.on('exit', cleanup);

  let healthy = false;
  for (let i = 0; i < 100 && !healthy && exited === null; i++) {
    try { healthy = (await fetch(`${BASE}/health`)).ok; } catch (_) { /* 还没起来 */ }
    if (!healthy) await wait(200);
  }
  const logText = () => { try { return fs.readFileSync(busLog, 'utf8'); } catch { return '（没有日志）'; } };
  ok(healthy, `① env -i 下 serve.sh 把 bus 起来了（:${PORT}，db ${testDb}）`, `exited=${JSON.stringify(exited)}\n${logText().slice(-600)}`);
  if (!healthy) finish();

  ok(/═══ bus 启动 .* pid \d+ ═══/.test(logText()) && /\[engloop\] node: \//.test(logText()),
    'bus 日志里有 serve.sh 的启动横幅和它解析出的 node（走的是 serve.sh，日志进了 ENGLOOP_BUS_LOG）', logText().slice(0, 300));

  // ── ② watchdog 看得见 tmux ─────────────────────────────────────────────
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const agents = async () => {
    const r = await fetch(`${BASE}/api/agents`, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const a0 = await agents();
  ok(a0.status === 200 && a0.json && a0.json.sessions_seen === 0,
    '（对照）私有 tmux 里还没有会话 ⇒ sessions_seen = 0 —— 它看的是私有 server，不是本机真的那个',
    JSON.stringify(a0).slice(0, 200));
  const t = tmux(['new-session', '-d', '-s', 'e16probe', 'sleep 600']);
  ok(t.status === 0, '（前置）私有 tmux 里起了一个会话', t.stderr);
  const a1 = await agents();
  ok(a1.status === 200 && a1.json && a1.json.sessions_seen >= 1,
    '② 私有 socket 里起一个会话 ⇒ /api/agents 的 sessions_seen ≥ 1（watchdog 看得见 tmux）',
    JSON.stringify(a1).slice(0, 300));

  // ── ③ bus 的子进程找得到什么 ─────────────────────────────────────────
  let probe = null;
  for (let i = 0; i < 25 && !probe; i++) {
    try { probe = JSON.parse(fs.readFileSync(probeOut, 'utf8')); } catch (_) { await wait(200); }
  }
  ok(probe !== null, '（前置）探针在 bus 进程里跑了', logText().slice(-300));
  if (probe) {
    console.log(`    bus 进程的 PATH = ${probe.PATH}`);
    for (const [b, p] of Object.entries(probe.found)) console.log(`    ${b.padEnd(7)} → ${p || '（找不到）'}`);
    const mine = whereInMyShell('claude');
    if (mine) {
      ok(!!probe.found.claude, `③ bus 的子进程 command -v claude 找得到（人的 shell 里是 ${mine}）`, JSON.stringify(probe.found));
    } else {
      console.log('  — 这台机器的 shell 里也找不到 claude：③ 的 claude 那条没法判（不算过也不算挂）');
    }
    ok(!!probe.found.tmux, '③ bus 的子进程 command -v tmux 找得到', JSON.stringify(probe.found));
    ok(!!probe.found.git, '③ bus 的子进程 command -v git 找得到', JSON.stringify(probe.found));
    ok(probe.found.node && fs.realpathSync(probe.found.node) === fs.realpathSync(probe.execPath),
      '③ bus 的子进程 command -v node = bus 自己那个 node（agent 跑 `node bin/next.js`、hook 跑 `node hooks/…` 用的就是它）',
      `${probe.found.node} vs ${probe.execPath}`);
    ok(probe.PATH !== MIN_PATH, 'bus 的 PATH 不是 launchd 给的那条最小 PATH（serve.sh 设过）', probe.PATH);
  }

  // ── 停 ────────────────────────────────────────────────────────────────
  bus.kill('SIGTERM');
  for (let i = 0; i < 50 && exited === null; i++) await wait(100);
  ok(exited !== null, '测完 SIGTERM，bus 退出了', JSON.stringify(exited));
  finish();
}

function finish() {
  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
