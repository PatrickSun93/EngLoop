'use strict';

/**
 * 登录三处修复（TASK_S1A）在**真 bus** 上的那一圈：
 *
 *   ① key 登录拿 cookie ⇒ ② 重启 bus ⇒ ③ 同一个 cookie 访问 /api/* 仍是 200
 *   阴性对照：删掉 session 文件再重启 ⇒ 同一个 cookie 401（证明 ③ 的 200 来自那个文件，不是别的）
 *   一次性链接：`bus-user login` ⇒ 换 cookie ⇒ 第二次用同一个 token 401；全程原 key 照样能登
 *   换 key（`bus-user add` 同名）⇒ 旧 cookie **不重启**就 401
 *
 * 单元层（判据本身、坏文件、写集）在 `test/auth-session.test.js`。
 *
 * ── 为什么要起真 bus ────────────────────────────────────────────────────
 *   「重启后还认得」这件事的价值全在 serve.js 的接线上：createAuth 有没有拿到 sessionsFile、
 *   /api/login-token 挂没挂在闸门之前、隔离模式下文件写到哪 —— 单元层一个都看不到。
 *   ⇒ 跟 `test/bus-auth.test.js` 一样起**隔离 bus**（ENGLOOP_ISOLATED=1 ＋ 测试库 ＋ 临时端口），
 *   用户表、session 文件、token 文件、admin token 全在临时目录。**不碰 9969、不碰 config/users.json。**
 *
 * ⚠️ session 文件路径**必须显式给**（ENGLOOP_WEB_SESSIONS_FILE）：隔离兜底路径带 pid，重启后是另一个文件。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const q = require('../lib/queue');
const auth = require('../lib/auth');

const PORT = 19961;                   // 生产 9969 · e2e 19969 · bus-auth 19977 —— 隔开
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const PROD_SESSIONS = path.join(ROOT, 'temp', 'web-sessions.json');
const PROD_TOKENS = path.join(ROOT, 'temp', 'login-tokens.json');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };

async function http(method, p, { cookie, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

async function main() {
  console.log('\n登录：session 落盘 · 一次性链接 · 不分大小写（隔离 bus）\n');

  const testDb = q.allocTestDb();
  if (testDb === null) { console.log('  ✗ 拿不到测试库 —— 中止'); process.exit(1); }
  const testUrl = q.withDb(q.DEFAULTS.url, testDb);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-bussession-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const usersFile = path.join(tmp, 'users.json');
  const sessionsFile = path.join(tmp, 'web-sessions.json');
  const tokensFile = path.join(tmp, 'login-tokens.json');
  const KEY_P = auth.newKey();
  fs.writeFileSync(usersFile, JSON.stringify([
    { username: 'Patrick', key_sha256: auth.sha256(KEY_P), can_manage_workers: true },
  ]));

  const env = { ...process.env };
  delete env.TMUX; delete env.TMUX_PANE; delete env.ENGLOOP_TEST_DB; delete env.ENGLOOP_TEST_DB_JOIN;
  Object.assign(env, {
    ENGLOOP_ISOLATED: '1',
    ENGLOOP_WORKER_TYPES: '',
    ENGLOOP_REDIS_URL: testUrl,
    ENGLOOP_PORT: String(PORT),
    TMUX_TMPDIR: path.join(tmp, 'tmux'),
    ENGLOOP_OUTBOX_ROOT: path.join(tmp, 'outbox'),
    ENGLOOP_ADMIN_TOKEN_FILE: path.join(tmp, 'bus-admin.token'),
    ENGLOOP_USERS_FILE: usersFile,
    ENGLOOP_WEB_SESSIONS_FILE: sessionsFile,
    ENGLOOP_LOGIN_TOKENS_FILE: tokensFile,
    ENGLOOP_HISTORY_ROOT: path.join(tmp, 'history'),
    ENGLOOP_OUTPUTS_ROOT: path.join(tmp, 'outputs'),
    ENGLOOP_GRAPHS_ROOT: path.join(tmp, 'graphs'),
    ENGLOOP_VERIFY_CACHE: path.join(tmp, 'verify'),
    ENGLOOP_WAITING_STATE: path.join(stateDir, 'waiting.json'),
    ENGLOOP_THREAD_ALERT_DIR: path.join(stateDir, 'thread-alert'),
    ENGLOOP_BUSY_ROOT: path.join(stateDir, 'busy'),
    ENGLOOP_DEADLETTER_ROOT: path.join(stateDir, 'deadletter'),
  });
  const prodBefore = [mtime(PROD_SESSIONS), mtime(PROD_TOKENS)];

  let bus = null;
  let log = [];
  async function start() {
    log = [];
    bus = spawn('node', [path.join(ROOT, 'bin', 'serve.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    bus.stdout.on('data', (d) => log.push(String(d)));
    bus.stderr.on('data', (d) => log.push(String(d)));
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch (_) { /* 还没起来 */ }
      await wait(150);
    }
    return false;
  }
  async function stop() {
    if (!bus || bus.exitCode !== null) return;
    const exited = new Promise((r) => bus.once('exit', r));
    bus.kill('SIGTERM');
    await Promise.race([exited, wait(6000)]);
    if (bus.exitCode === null) { bus.kill('SIGKILL'); await exited; }
  }
  process.on('exit', () => {
    try { if (bus && bus.exitCode === null) bus.kill('SIGKILL'); } catch (_) { /* 已经没了 */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const busUser = (...a) => spawnSync('node', [path.join(ROOT, 'bin', 'bus-user.js'), ...a], { env, encoding: 'utf8' });
  const login = async (username, key) => {
    const r = await http('POST', '/api/login', { body: { username, key } });
    return { r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };

  // ── 1. 登录 ⇒ 重启 ⇒ 同一个 cookie ──────────────────────────────────────
  console.log('【1】key 登录 ⇒ 重启 bus ⇒ 同一个 cookie 仍是 200');
  ok(await start(), `⓪ 隔离 bus 起来了（:${PORT}，db ${testDb}）`, log.join('').slice(-400));
  const L = await login('patrick', KEY_P);
  ok(L.r.status === 200 && L.r.json.username === 'Patrick' && /^engloop_session=/.test(L.cookie),
    '★ 用户名小写 patrick ＋ key ⇒ 200，回的是表里的原样写法 Patrick', L.r.text);
  const w0 = await http('GET', '/api/whoami', { cookie: L.cookie });
  ok(w0.status === 200 && w0.json.username === 'Patrick', '（前置）重启前 /api/whoami 200', w0.text);
  ok(fs.existsSync(sessionsFile) && (fs.statSync(sessionsFile).mode & 0o777) === 0o600, 'session 文件写出来了（0600）');
  await stop();
  ok(await start(), '重启隔离 bus', log.join('').slice(-400));
  ok(/\[auth\] session 文件 .*恢复 1 条/.test(log.join('')), 'bus 日志：恢复 1 条', (log.join('').match(/\[auth\].*/g) || []).join(' | '));
  const w1 = await http('GET', '/api/whoami', { cookie: L.cookie });
  ok(w1.status === 200 && w1.json.username === 'Patrick', '★ 重启后同一个 cookie：/api/whoami 200', `${w1.status} ${w1.text}`);
  const a1 = await http('GET', '/api/agents', { cookie: L.cookie });
  ok(a1.status === 200, '★ 重启后同一个 cookie：/api/agents 200', `${a1.status} ${a1.text.slice(0, 120)}`);

  // ── 2. 阴性对照：删掉文件再重启 ⇒ 401 ──────────────────────────────────
  console.log('\n【2】阴性对照：删掉 session 文件 ⇒ 重启 ⇒ 401');
  await stop();
  fs.rmSync(sessionsFile, { force: true });   // force：变异下它可能根本没写出来，那时要红在上面的判据上，不是崩在这里
  ok(await start(), '重启隔离 bus（session 文件已删）', log.join('').slice(-400));
  ok(/session 文件不存在/.test(log.join('')), 'bus 日志：文件不存在 ⇒ 当空表（bus 照起）');
  const w2 = await http('GET', '/api/whoami', { cookie: L.cookie });
  ok(w2.status === 401, '★ 同一个 cookie ⇒ 401（【1】的 200 来自那个文件）', `${w2.status} ${w2.text.slice(0, 120)}`);

  // ── 3. 坏文件不让 bus 起不来 ───────────────────────────────────────────
  console.log('\n【3】session 文件坏了 ⇒ bus 照起');
  await stop();
  fs.writeFileSync(sessionsFile, '{garbage');
  ok(await start(), '★ 坏 session 文件 ⇒ bus 照样起来', log.join('').slice(-400));
  ok(/不是合法的 JSON/.test(log.join('')), 'bus 日志里有一行警告');

  // ── 4. 一次性登录链接 ──────────────────────────────────────────────────
  console.log('\n【4】一次性登录链接');
  const g = busUser('login', 'PATRICK');
  const url = (g.stdout.match(/(http\S+#login-token=\S+)/) || [])[1] || '';
  const token = (url.match(/#login-token=([A-Za-z0-9_-]+)$/) || [])[1];
  ok(g.status === 0 && url.startsWith(`${BASE}/#login-token=`), `bus-user login PATRICK ⇒ 链接指向这个 bus（${BASE}）`, g.stdout + g.stderr);
  const page = await http('GET', '/');
  ok(page.status === 200 && /<script src="\/auth\.js">/.test(page.text), '链接打开的是首页（静态，不要凭据），首页加载 auth.js（它读 # 后面的 token）');
  const T1 = await http('POST', '/api/login-token', { body: { token } });
  const tCookie = (T1.headers.get('set-cookie') || '').split(';')[0];
  ok(T1.status === 200 && T1.json.username === 'Patrick' && /^engloop_session=/.test(tCookie)
    && /HttpOnly/i.test(T1.headers.get('set-cookie')) && /SameSite=Strict/i.test(T1.headers.get('set-cookie')),
  '★ token 换 cookie：200，cookie 跟 key 登录同一种（HttpOnly; SameSite=Strict）', `${T1.status} ${T1.text}`);
  const w3 = await http('GET', '/api/whoami', { cookie: tCookie });
  ok(w3.status === 200 && w3.json.username === 'Patrick' && w3.json.can_manage_workers === true, '拿到的 cookie 能用', w3.text);
  const T2 = await http('POST', '/api/login-token', { body: { token } });
  ok(T2.status === 401 && T2.json.error === 'BAD_LOGIN_TOKEN' && T2.json.reason === 'used' && /已经用过/.test(T2.json.message),
    '★ 第二次用同一个 token ⇒ 401，说「已经用过」', `${T2.status} ${T2.text}`);
  ok(/bus-user\.js login/.test(T2.json.next || ''), '401 的 next 里给了重新生成的命令');
  const T3 = await http('POST', '/api/login-token', { body: { token: 'x'.repeat(43) } });
  ok(T3.status === 401 && T3.json.reason === 'invalid', '不存在的 token ⇒ 401 invalid');
  const K = await login('Patrick', KEY_P);
  ok(K.r.status === 200, '★ 整个过程中原 key 照样能登录（login 没换 key）', K.r.text);

  // 重启之后 token 文件里也没有它了
  await stop();
  ok(await start(), '重启隔离 bus');
  const T4 = await http('POST', '/api/login-token', { body: { token } });
  ok(T4.status === 401, '重启后再用同一个 token ⇒ 仍是 401（文件里已经删了）', `${T4.status} ${T4.text}`);
  const w4 = await http('GET', '/api/whoami', { cookie: tCookie });
  ok(w4.status === 200, 'token 换来的 session 也落盘了：重启后还是 200', `${w4.status}`);

  // ── 5. 换 key ⇒ 旧 cookie 不重启就掉 ───────────────────────────────────
  console.log('\n【5】bus-user add 同名换 key ⇒ 旧 cookie 当场 401');
  const rk = busUser('add', 'Patrick', '--manage');
  ok(rk.status === 0 && /换了 key/.test(rk.stdout), '（前置）add Patrick 换 key', rk.stdout + rk.stderr);
  const w5 = await http('GET', '/api/whoami', { cookie: K.cookie });
  ok(w5.status === 401, '★ 不重启：旧 key 拿到的 cookie 下一个请求就 401', `${w5.status}`);
  const old = await login('Patrick', KEY_P);
  ok(old.r.status === 401, '旧 key 登录 ⇒ 401');
  const rc = busUser('add', 'patrick');
  ok(rc.status === 1 && /已经有「Patrick」/.test(rc.stderr), 'add patrick（只差大小写）⇒ 拒');

  await stop();
  const prodAfter = [mtime(PROD_SESSIONS), mtime(PROD_TOKENS)];
  ok(prodAfter[0] === prodBefore[0] && prodAfter[1] === prodBefore[1],
    '★ 生产 temp/web-sessions.json、temp/login-tokens.json 没被测试碰过（隔离表 ⑪ ⑫）', JSON.stringify({ prodBefore, prodAfter }));

  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
