#!/usr/bin/env node
'use strict';

/**
 * 起一个**隔离 bus**，对它跑一个 Playwright 浏览器测试，跑完收干净。
 *
 *   node scripts/run-e2e-notify.js                                  ← 默认跑 test/e2e-notify.playwright.js
 *   node scripts/run-e2e-notify.js test/bus-login.playwright.js     ← 同一个入口跑 bus-login
 *
 * ── 隔离（照 test/e2e.test.js 那套，一件不少）────────────────────────────
 *   ENGLOOP_ISOLATED=1            serve.js 里那张隔离表的兜底分支全部生效（tmux no-op、admin token 进 tmpdir …）
 *   ENGLOOP_PORT                  测试端口（默认 19981；ENGLOOP_E2E_PORT 可换）—— 9969 拒绝
 *   ENGLOOP_REDIS_URL             测试库（默认 db 12；ENGLOOP_E2E_DB 可换）—— 走 lib/queue 的测试库锁
 *                                 （ENGLOOP_TEST_DB ⇒ 抢锁、清库；抢不到就抛，不静默共用）；db 0 拒绝
 *   ENGLOOP_OUTBOX_ROOT           临时目录
 *   ENGLOOP_USERS_FILE            临时用户表（一个测试用户，key 现生成、只经环境变量交给测试，不打印）
 *   ENGLOOP_WORKER_TYPES=''       不起 worker 池（不烧 claude 额度）
 *   TMUX_TMPDIR                   临时目录（再加删掉 TMUX / TMUX_PANE）
 *   ⚠️ 故意**不设** ENGLOOP_ADMIN_TOKEN_FILE：隔离 bus 的 token 落到 tmpdir 靠 serve.js 的兜底分支
 *     （`engloop-isolated-admin-<pid>.token`），理由同 test/e2e.test.js。跑完删掉它。
 *
 * ── 给测试的环境变量（跟 test/bus-login.playwright.js 同一套名字）─────────
 *   ENGLOOP_PW_BASE / _USER / _KEY / _REDIS / _OUTBOX
 *   ENGLOOP_PW_CHANNEL 原样透传（浏览器 channel，见各测试文件头）。
 *
 * ── 变异（内存里，磁盘一个字节不动）─────────────────────────────────────
 *   NODE_OPTIONS=--require=<仓库>/scripts/_srcmut-hook.js ENGLOOP_SRCMUT='{"file":…,"from":…,"to":…}'
 *   两个变量都会被子进程（bus、测试）继承 ⇒ 对 bin/serve.js 的变异进 bus，对测试文件的变异进测试。
 *
 * 退出码 = 测试的退出码；bus 没起来 / 前置不满足 ⇒ 2。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.ENGLOOP_E2E_PORT || 19981);
const DB = Number(process.env.ENGLOOP_E2E_DB || 12);
const TEST = path.resolve(ROOT, process.argv[2] || 'test/e2e-notify.playwright.js');
const USER = 'e2e-human';

function die(msg) { console.error(`✗ ${msg}`); process.exit(2); }

if (!Number.isInteger(PORT) || PORT <= 0 || PORT === 9969) die(`端口 ${PORT} 不行（9969 是生产）`);
if (!Number.isInteger(DB) || DB < 1 || DB > 15) die(`测试库 ${DB} 不行（1–15；db 0 是生产库）`);
if (!fs.existsSync(TEST)) die(`找不到测试文件：${TEST}`);

// 测试库：走 lib/queue 的锁（ENGLOOP_TEST_DB ⇒ 抢锁、清库）。必须在 require 之前设。
process.env.ENGLOOP_TEST_DB = String(DB);
const q = require('../lib/queue');
const auth = require('../lib/auth');

/** 127.0.0.1:PORT 现在有没有人在听（连一下，不发任何东西）。 */
function portTaken(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (await portTaken(PORT)) die(`127.0.0.1:${PORT} 已经有人在听 —— 换一个：ENGLOOP_E2E_PORT=<端口>`);

  let redis;
  try { redis = q.createClient(); } catch (e) { die(`测试库 db ${DB} 拿不到：${e.message}`); }
  const redisUrl = q.withDb(q.DEFAULTS.url, DB);
  if (!/\/(\d+)$/.test(redisUrl) || /\/0$/.test(redisUrl)) die(`redis url 不对：${redisUrl}`);
  await redis.ping();

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-e2e-notify-'));
  const outboxRoot = path.join(TMP, 'outbox');
  const tmuxDir = path.join(TMP, 'tmux');
  const usersFile = path.join(TMP, 'users.json');
  fs.mkdirSync(outboxRoot, { recursive: true });
  fs.mkdirSync(tmuxDir, { recursive: true });
  const KEY = auth.newKey();
  fs.writeFileSync(usersFile, JSON.stringify([
    { username: USER, key_sha256: auth.sha256(KEY), can_manage_workers: true },
  ]), { mode: 0o600 });

  const busEnv = {
    ...process.env,
    ENGLOOP_ISOLATED: '1',
    ENGLOOP_PORT: String(PORT),
    ENGLOOP_REDIS_URL: redisUrl,
    ENGLOOP_OUTBOX_ROOT: outboxRoot,
    ENGLOOP_USERS_FILE: usersFile,
    ENGLOOP_WORKER_TYPES: '',
    TMUX_TMPDIR: tmuxDir,
  };
  // 子进程不许再去抢同一把测试库锁（锁在本进程手里）；token 走兜底路径；不连调用方的 tmux。
  for (const k of ['ENGLOOP_TEST_DB', 'ENGLOOP_TEST_DB_JOIN', 'ENGLOOP_ADMIN_TOKEN_FILE', 'TMUX', 'TMUX_PANE']) delete busEnv[k];

  console.log(`隔离 bus：127.0.0.1:${PORT} · redis db ${DB} · 临时目录 ${TMP}`);
  const busLog = [];
  const bus = spawn(process.execPath, [path.join(ROOT, 'bin', 'serve.js')], {
    cwd: ROOT, env: busEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  bus.stdout.on('data', (d) => busLog.push(String(d)));
  bus.stderr.on('data', (d) => busLog.push(String(d)));
  const tokenFile = path.join(os.tmpdir(), `engloop-isolated-admin-${bus.pid}.token`);
  const verifyDir = path.join(os.tmpdir(), `engloop-isolated-verify-${bus.pid}`);

  let cleaned = false;
  const cleanupSync = () => {
    if (cleaned) return;
    cleaned = true;
    try { if (alive(bus.pid)) bus.kill('SIGKILL'); } catch (_) { /* 已经没了 */ }
    for (const p of [TMP, tokenFile, verifyDir]) fs.rmSync(p, { recursive: true, force: true });
  };
  process.on('exit', cleanupSync);   // Ctrl-C / 异常 也收（lib/queue 的 SIGINT 处理会走到 exit）

  // 等 /health 自报 engloop-bus
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    if (bus.exitCode !== null) break;
    up = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())
      .then((j) => j && j.service === 'engloop-bus').catch(() => false);
    if (!up) await wait(250);
  }
  if (!up) {
    console.error(`✗ 隔离 bus 没起来（exit=${bus.exitCode}）。日志最后几行：\n${busLog.join('').slice(-1200)}`);
    process.exitCode = 2;
  }

  let code = 2;
  if (up) {
    const testEnv = {
      ...process.env,
      ENGLOOP_PW_BASE: `http://127.0.0.1:${PORT}/`,
      ENGLOOP_PW_USER: USER,
      ENGLOOP_PW_KEY: KEY,
      ENGLOOP_PW_REDIS: redisUrl,
      ENGLOOP_PW_OUTBOX: outboxRoot,
    };
    for (const k of ['ENGLOOP_TEST_DB', 'ENGLOOP_TEST_DB_JOIN']) delete testEnv[k];
    const r = spawnSync(process.execPath, [TEST], { cwd: ROOT, env: testEnv, stdio: 'inherit' });
    code = r.status === null ? 1 : r.status;
    if (code !== 0) console.error(`\n（隔离 bus 日志最后几行，排查用）\n${busLog.join('').slice(-1500)}`);
  }

  // ── 收：bus（SIGTERM → 等 → SIGKILL）、核对它真的退了、删临时文件和 token ──
  bus.kill('SIGTERM');
  for (let i = 0; i < 40 && alive(bus.pid) && bus.exitCode === null; i++) await wait(250);
  if (bus.exitCode === null && alive(bus.pid)) { bus.kill('SIGKILL'); await wait(500); }
  const gone = bus.exitCode !== null || bus.signalCode !== null || !alive(bus.pid);
  try { await redis.flushdb(); } catch (_) { /* 尽力 */ }
  redis.disconnect();
  cleanupSync();
  const left = [TMP, tokenFile, verifyDir].filter((p) => fs.existsSync(p));
  console.log(`\n收尾：隔离 bus pid ${bus.pid} ${gone ? '已退出' : '✗ 还在！'} · 临时文件 ${left.length ? `✗ 还剩 ${left.join(' ')}` : '已删'}`
    + ` · admin token ${fs.existsSync(tokenFile) ? '✗ 还在' : '已删'}`);
  process.exit(gone && !left.length ? code : (code || 1));
}

main().catch((e) => { console.error('✗ 异常:', e && e.stack ? e.stack : e); process.exit(2); });
