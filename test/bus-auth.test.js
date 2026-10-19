'use strict';

/**
 * bus 的鉴权与盖章：人、agent、CLI 三条入口各自盖的章，以及关停流程的后端那半。
 *
 *   人 ──HTTP──▶ bus（鉴权 · 盖章）──XADD──▶ 流 ──▶ poller（读章 → trust）
 *   agent ─outbox─▶ relay（盖 agent 章）──▶ 流 ──▶ poller
 *   CLI（agent-start --stop）──admin token──▶ bus ──SHUTDOWN_REQUEST（system 章）──▶ agent ──READY──▶ 收会话
 *
 * ── 为什么要起一个真 bus ────────────────────────────────────────────────
 *   这一步的全部价值在**路由顺序和状态码**上（闸门挂在哪一行之前、401 还是 403、
 *   upgrade 被拒还是连上再踢），而 `bin/serve.js` 是入口脚本、require 不了。
 *   ⇒ 跟 `test/e2e.test.js` 一样起一个**隔离 bus**（ENGLOOP_ISOLATED=1 ＋ 测试库 ＋ 临时端口）。
 *
 * ── tmux：私有 socket ───────────────────────────────────────────────────
 *   `agent-start --stop` 端到端要一个真的 tmux 会话（bus 用它的 `created` 给关停指令盖会话章、
 *   最后 kill 它）。⇒ 子进程一律 `TMUX_TMPDIR=<临时目录>` ＋ **删掉 `TMUX`**
 *   （在 agent 的 tmux 里跑时 `TMUX` 会把命令指回生产 tmux server）。
 *   会话里跑的是 `sleep`，不是 claude —— 「临时 agent」只需要一个能被 kill 的会话和一个花名册条目。
 *
 * ⚠️ 隔离 bus 的 watchdog 用 no-op tmux ⇒ 它**一启动就把所有带 tmux_session 的在册条目判成 stale 并摘牌**。
 *   所以临时 agent 在 bus 起来**之后**才登记，并且后面那几段要在下一次 tick（60 秒）之前做完。
 *   ⇒ 这是一个时序约束：慢机器上它会红在「不在花名册」上，而不是假绿。
 *
 * 变异（不落盘）：`scripts/mutate-bus-auth.js` 拿 `scripts/_srcmut-hook.js` 把关键的几行在内存里删掉，
 * 要求**指定的那条**判据变红。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const q = require('../lib/queue');
const auth = require('../lib/auth');
const roster = require('../lib/roster');

const PORT = 19977;                   // 生产 9969、e2e 19969 —— 隔开
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const PROD_TOKEN = path.join(ROOT, 'temp', 'bus-admin.token');
const CREW = 'authcrew';
const CREW_SESSION = roster.sessionFor(CREW, 'dev');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, p, { cookie, bearer, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

/** WS 握手：连上 ⇒ {opened:true, ws}；被拒 ⇒ {opened:false, status}。 */
function wsTry(headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers });
    const received = [];
    ws.on('message', (d) => { try { received.push(JSON.parse(String(d))); } catch (_) { /* 忽略 */ } });
    ws.on('open', () => resolve({ opened: true, ws, received }));
    ws.on('unexpected-response', (_req, res) => { resolve({ opened: false, status: res.statusCode }); ws.terminate(); });
    ws.on('error', (e) => resolve({ opened: false, error: e.message }));
    setTimeout(() => resolve({ opened: false, error: 'timeout' }), 5000);
  });
}

async function main() {
  console.log('\n鉴权 · 盖章 · trust（隔离 bus）\n');

  // ── 0. 隔离环境 ─────────────────────────────────────────────────────────
  const testDb = q.allocTestDb();
  if (testDb === null) { console.log('  ✗ 拿不到测试库 —— 中止'); process.exit(1); }
  const testUrl = q.withDb(q.DEFAULTS.url, testDb);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-busauth-'));
  const outboxRoot = path.join(tmp, 'outbox');
  const stateDir = path.join(tmp, 'state');
  const tmuxDir = path.join(tmp, 'tmux');
  for (const d of [outboxRoot, stateDir, tmuxDir]) fs.mkdirSync(d, { recursive: true });
  const usersFile = path.join(tmp, 'users.json');
  const tokenFile = path.join(tmp, 'bus-admin.token');
  const KEY_P = auth.newKey();
  const KEY_V = auth.newKey();
  fs.writeFileSync(usersFile, JSON.stringify([
    { username: 'Patrick', key_sha256: auth.sha256(KEY_P), can_manage_workers: true },
    { username: 'Viewer', key_sha256: auth.sha256(KEY_V), can_manage_workers: false },
  ]));

  // 子进程的环境：测试库 ＋ 私有 tmux ＋ 所有状态文件进临时目录
  const childEnv = { ...process.env };
  delete childEnv.TMUX; delete childEnv.TMUX_PANE;
  Object.assign(childEnv, {
    ENGLOOP_REDIS_URL: testUrl,
    TMUX_TMPDIR: tmuxDir,
    ENGLOOP_OUTBOX_ROOT: outboxRoot,
    ENGLOOP_ADMIN_TOKEN_FILE: tokenFile,
    ENGLOOP_USERS_FILE: usersFile,
    ENGLOOP_PORT: String(PORT),
    ENGLOOP_WAITING_STATE: path.join(stateDir, 'waiting.json'),
    ENGLOOP_THREAD_ALERT_DIR: path.join(stateDir, 'thread-alert'),
    ENGLOOP_BUSY_ROOT: path.join(stateDir, 'busy'),
    ENGLOOP_DEADLETTER_ROOT: path.join(stateDir, 'deadletter'),
  });
  delete childEnv.ENGLOOP_TEST_DB; delete childEnv.ENGLOOP_TEST_DB_JOIN;

  const prodTokenBefore = (() => { try { return fs.statSync(PROD_TOKEN).mtimeMs; } catch { return null; } })();

  const redis = q.createClient(testUrl);
  await redis.del('orch:in:human', 'orch:in:agent', 'orch:out', `agent:${CREW}:in`, roster.KEY(CREW), roster.KEY('JARVIS'));
  // JARVIS 在册（agent → JARVIS 才走 orch:in:agent）。**不带 tmux_session** ⇒ no-op watchdog 不会判它 stale。
  await roster.register(redis, 'JARVIS', { type: 'orchestrator', tmux_session: '' });

  // ── 0b. 用户表缺失 / 为空 ⇒ 拒绝启动（没有静默默认值）──────────────────
  console.log('【0】用户表不合法 ⇒ bus 拒绝启动，并说出要跑的命令');
  for (const [label, file, content] of [
    ['缺失', path.join(tmp, 'nope.json'), null],
    ['空数组', path.join(tmp, 'empty.json'), '[]'],
    ['明文 key', path.join(tmp, 'plain.json'), JSON.stringify([{ username: 'Patrick', key: 'x', can_manage_workers: true }])],
  ]) {
    if (content !== null) fs.writeFileSync(file, content);
    const r = spawnSync('node', [path.join(ROOT, 'bin', 'serve.js')], {
      env: { ...childEnv, ENGLOOP_ISOLATED: '1', ENGLOOP_WORKER_TYPES: '', ENGLOOP_USERS_FILE: file, ENGLOOP_PORT: String(PORT + 1) },
      encoding: 'utf8', timeout: 15000,
    });
    ok(r.status === 78 && /bus-user\.js add/.test(r.stderr),
      `用户表${label} ⇒ exit 78，错误信息里有 \`node bin/bus-user.js add\``,
      `status=${r.status} stderr=${String(r.stderr).slice(0, 200)}`);
  }

  // ── 1. 起隔离 bus ───────────────────────────────────────────────────────
  const busLog = [];
  const bus = spawn('node', [path.join(ROOT, 'bin', 'serve.js')], {
    cwd: ROOT,
    env: { ...childEnv, ENGLOOP_ISOLATED: '1', ENGLOOP_WORKER_TYPES: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bus.stdout.on('data', (d) => busLog.push(String(d)));
  bus.stderr.on('data', (d) => busLog.push(String(d)));
  const cleanup = () => {
    try { bus.kill('SIGTERM'); } catch (_) { /* 已经没了 */ }
    try { execFileSync('tmux', ['kill-server'], { env: childEnv, stdio: 'ignore' }); } catch (_) { /* 本来就没有 */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  process.on('exit', cleanup);

  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    try { healthy = (await fetch(`${BASE}/health`)).ok; } catch (_) { /* 还没起来 */ }
    if (!healthy) await wait(200);
  }
  ok(healthy, `⓪ 隔离 bus 起来了（:${PORT}，db ${testDb}）—— /health 不要凭据`, busLog.join('').slice(-400));
  if (!healthy) { await redis.quit(); process.exit(1); }

  // ── 1. 不带凭据 ⇒ 401；WS upgrade 被拒 ──────────────────────────────────
  console.log('\n【1】不带凭据');
  {
    const r = await http('POST', '/api/message', { body: { text: 'hi' } });
    ok(r.status === 401 && r.json && r.json.error === 'UNAUTHENTICATED',
      'POST /api/message 无凭据 ⇒ 401 UNAUTHENTICATED', `${r.status} ${r.text.slice(0, 120)}`);
    ok(r.json && /bus-user\.js add/.test(r.json.next || ''), '401 的 next 里说了怎么拿凭据');
    for (const p of ['/api/messages?to=JARVIS', '/api/agents', '/api/rooms', '/api/whoami']) {
      const g = await http('GET', p);
      ok(g.status === 401, `GET ${p} 无凭据 ⇒ 401（读接口也要：它们能读到所有人的对话）`, String(g.status));
    }
    const w = await wsTry();
    ok(!w.opened && w.status === 401, '/ws 无凭据 ⇒ upgrade 被拒（401），不是连上再踢',
      JSON.stringify({ opened: w.opened, status: w.status, error: w.error }));
    if (w.ws) w.ws.close();
    const bad = await http('POST', '/api/login', { body: { username: 'Patrick', key: 'wrong' } });
    ok(bad.status === 401 && bad.json.error === 'BAD_CREDENTIALS', '错的 key ⇒ 401 BAD_CREDENTIALS', String(bad.status));
    const wrongBearer = await http('GET', '/api/agents', { bearer: 'f'.repeat(64) });
    ok(wrongBearer.status === 401, '错的 admin token ⇒ 401', String(wrongBearer.status));
  }

  // ── 2. 登录 ＋ 盖章：body 里的 from 不算数 ─────────────────────────────
  console.log('\n【2】登录、发言盖章');
  const login = async (username, key) => {
    const r = await http('POST', '/api/login', { body: { username, key } });
    const sc = r.headers.get('set-cookie') || '';
    return { r, sc, cookie: sc.split(';')[0] };
  };
  const P = await login('Patrick', KEY_P);
  const V = await login('Viewer', KEY_V);
  ok(P.r.status === 200 && /^engloop_session=/.test(P.cookie), 'Patrick 登录 ⇒ 200 ＋ session cookie', P.sc);
  ok(/HttpOnly/i.test(P.sc) && /SameSite=Strict/i.test(P.sc), 'cookie 是 HttpOnly; SameSite=Strict', P.sc);
  const who = await http('GET', '/api/whoami', { cookie: P.cookie });
  ok(who.status === 200 && who.json.username === 'Patrick' && who.json.can_manage_workers === true,
    '/api/whoami 带 cookie ⇒ Patrick / can_manage_workers:true', who.text);

  const MARK = `AUTH-${Date.now()}`;
  const mp = await http('POST', '/api/message', { cookie: P.cookie, body: { from: 'Mallory', text: `P ${MARK}` } });
  const mv = await http('POST', '/api/message', { cookie: V.cookie, body: { from: 'Patrick', text: `V ${MARK}` } });
  ok(mp.status === 202 && mv.status === 202, '两个 session 都能发言（202）', `${mp.status} ${mv.status}`);
  const entries = await redis.xrange('orch:in:human', '-', '+');
  const asObj = (fields) => { const o = {}; for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1]; return o; };
  const ep = entries.map(([, f]) => asObj(f)).find((o) => o.job_id === mp.json.job_id);
  const ev = entries.map(([, f]) => asObj(f)).find((o) => o.job_id === mv.json.job_id);
  ok(ep && ep.from === 'Patrick', '★ body 写 from:"Mallory" ⇒ 流条目的 from 是 session 的 username（Patrick）',
    JSON.stringify(ep));
  ok(ep && !JSON.stringify(ep).includes('Mallory'), '★ 「Mallory」在流条目里哪儿都没有');
  ok(ep && ep.sender_type === 'human' && ep.can_manage_workers === '1',
    '★ 盖章：sender_type=human · can_manage_workers="1"', JSON.stringify(ep));
  ok(ev && ev.from === 'Viewer' && ev.can_manage_workers === '0',
    '★ Viewer 冒充 from:"Patrick" ⇒ 流里还是 Viewer，can_manage_workers="0"', JSON.stringify(ev));

  // ── 2b. 人的两个发言入口都会把 thread 的 agent 来回计数清零 ─────────────
  //   ★ 放在临时 agent 登记**之前**：不占下面那段「60 秒内做完」的预算。
  console.log('\n【2b】人的私聊 / 房间发言 ⇒ 这个 thread 的来回计数清零');
  {
    const tc = require('../lib/thread-count');
    /** 两个 agent 在 (scope) 里来回 6 条（各 3）⇒ 已告警。返回最后一条的 id。 */
    const seed = async (scope, prefix) => {
      let prev = null;
      for (let i = 1; i <= 6; i++) {
        const id = `${prefix}${i}`;
        await tc.record(redis, { scope, id, reply_to: prev, from: i % 2 ? 'agA' : 'agB', sender_type: 'agent' });
        prev = id;
      }
      return prev;
    };
    // 私聊
    const dmLast = await seed('dm', `E18D-${MARK}-`);
    const dmBefore = await tc.stateOf(redis, 'dm', dmLast);
    ok(dmBefore.alerted && dmBefore.counts.agA === 3, '（前置）私聊 thread 已告警（agA 3 · agB 3）', JSON.stringify(dmBefore));
    const hm = await http('POST', '/api/message', { cookie: P.cookie, body: { text: `E18 ${MARK}`, reply_to: dmLast } });
    ok(hm.status === 202, '人回在这个私聊 thread 里（202）', hm.text.slice(0, 100));
    const dmAfter = await tc.stateOf(redis, 'dm', dmLast);
    ok(!dmAfter.alerted && JSON.stringify(dmAfter.counts) === '{}', '★★ /api/message ⇒ 计数和「已告警」清零', JSON.stringify(dmAfter));
    ok((await tc.stateOf(redis, 'dm', hm.json.job_id)).root === `E18D-${MARK}-1`, '人那条也记进了同一个根（agent 回它时还在这个 thread）');
    // 房间
    const r2b = await http('POST', '/api/rooms', { cookie: P.cookie, body: { name: `e18-${MARK}`, members: [] } });
    ok(r2b.status === 201, '（前置）建房间', r2b.text.slice(0, 100));
    const scope = tc.roomScope(r2b.json.hash);
    const roomLast = await seed(scope, 'E18R-');
    ok((await tc.stateOf(redis, scope, roomLast)).alerted, '（前置）房间 thread 已告警');
    const other = await seed('dm', 'E18R-');   // 同名 id 在**私聊**里也有一个已告警的 thread
    const hp = await http('POST', `/api/rooms/${r2b.json.hash}/post`, { cookie: P.cookie, body: { text: `E18R ${MARK}`, reply_to: roomLast } });
    ok(hp.status === 202, '人回在这个房间 thread 里（202）', hp.text.slice(0, 100));
    const roomAfter = await tc.stateOf(redis, scope, roomLast);
    ok(!roomAfter.alerted && JSON.stringify(roomAfter.counts) === '{}', '★★ /api/rooms/:hash/post ⇒ 计数和「已告警」清零', JSON.stringify(roomAfter));
    // 阴性对照：房间那条人话不许连带清掉同名 id 的私聊 thread（scope 不同）
    ok((await tc.stateOf(redis, 'dm', other)).alerted, '★ 阴性对照：同名 id 的私聊 thread 不受房间那条影响');

    // ── 按**网页的方式**回复告警 ⇒ 那个 thread 清零 ───────────────────────────
    //   网页私聊：历史走 `GET /api/messages?to=JARVIS`，每行的锚点 = job_id（`web/app.js` anchorOf(m,'dm')），
    //   点「回复」时 reply_to = `Threads.replyTargetIdOf(行, 同频道 byId, 合并表)`（`setReplyTarget`），
    //   实时推送归到 `'dm:' + m.from` 频道（WS case 'message'）。下面三步照抄这三处。
    const Threads = require('../web/threads.js');
    const wsA = await wsTry({ cookie: P.cookie });
    const crewLast = await (async () => {               // 一个 JARVIS ↔ agent 私聊 thread（人在网页上碰不到它）
      let prev = null;
      for (let i = 1; i <= 5; i++) {
        const id = `E18W-${MARK}-${i}`;
        await tc.record(redis, { scope: 'dm', id, reply_to: prev, from: i % 2 ? 'JARVIS' : 'agP', sender_type: 'agent' });
        prev = id;
      }
      return prev;
    })();
    const evW = [];
    await tc.recordAndAlert(redis, { scope: 'dm', id: `E18W-${MARK}-6`, reply_to: crewLast, from: 'agP', sender_type: 'agent' },
      { onEvent: (e) => evW.push(e), text: `W ${MARK}` });
    const alertId = (evW.find((e) => e.type === 'thread_over_limit') || {}).alert_job_id;
    ok(Boolean(alertId) && (await tc.stateOf(redis, 'dm', crewLast)).alerted, '（前置）JARVIS ↔ agent 那个私聊 thread 告警了', JSON.stringify(evW));
    // ① 实时推送：告警归到 JARVIS 的私聊频道（不是一个叫 system、输入框禁用的频道）
    let pushedAlert = null;
    for (let i = 0; i < 40 && !pushedAlert; i++) {
      pushedAlert = (wsA.received || []).find((m) => m.type === 'message' && m.job_id === alertId);
      if (!pushedAlert) await wait(150);
    }
    ok(pushedAlert && `dm:${pushedAlert.from}` === 'dm:JARVIS', '★ WS 推来的告警 from=JARVIS ⇒ 网页把它放进 dm:JARVIS（能回复的那个频道）',
      JSON.stringify(pushedAlert));
    if (wsA.ws) wsA.ws.close();
    // ② 刷新：按网页的方式取历史，找到告警那一行，算出网页会发的 reply_to
    const hist = await http('GET', '/api/messages?to=JARVIS&count=200', { cookie: P.cookie });
    const rowsW = ((hist.json && (hist.json.messages || hist.json.history)) || [])
      .map((m) => ({ id: m.job_id || null, from: m.from, text: m.text, reply_to: m.reply_to, kind: m.kind, sender_type: m.sender_type }));
    const alertRow = rowsW.find((e) => String(e.text).includes(`W ${MARK}`) && e.sender_type === 'system');
    ok(Boolean(alertRow), '★ 告警出现在 GET /api/messages?to=JARVIS 里（刷新后还在 JARVIS 的对话里）', `${hist.status} ${rowsW.length} 行`);
    const byIdW = new Map(rowsW.filter((x) => x.id != null).map((x) => [x.id, x]));
    const webReplyTo = alertRow ? Threads.replyTargetIdOf(alertRow, byIdW, undefined) : null;
    ok(webReplyTo === alertId, '★★ 网页回复告警时发出的 reply_to === 告警的 job_id（alertref 的 key）',
      JSON.stringify({ webReplyTo, alertId }));
    // ③ 用它 POST ⇒ 那个 agent 私聊 thread 清零
    const hr = await http('POST', '/api/message', { cookie: P.cookie, body: { text: `回告警 ${MARK}`, reply_to: webReplyTo } });
    ok(hr.status === 202, '人回复告警（202）', hr.text.slice(0, 100));
    const cleared = await tc.stateOf(redis, 'dm', crewLast);
    ok(!cleared.alerted && JSON.stringify(cleared.counts) === '{}', '★★ 回复告警 ⇒ 那个 JARVIS ↔ agent thread 清零', JSON.stringify(cleared));
  }

  // ── 3. 生命周期端点：401 / 403 / admin 通过 ──────────────────────────────
  console.log('\n【3】生命周期端点');
  const adminToken = (() => { try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return ''; } })();
  ok(/^[0-9a-f]{64}$/.test(adminToken), 'admin token 文件写出来了（64 hex）');
  {
    const mode = fs.statSync(tokenFile).mode & 0o777;
    ok(mode === 0o600, `admin token 文件权限 0600（实际 0${mode.toString(8)}）`);
  }
  const lifecycle = [
    ['POST', '/api/agents/__nobody__/shutdown', { reason: 't' }, 404],
    ['POST', '/api/agents/__nobody__/start', {}, 400],
    ['POST', '/api/queue/cancel', {}, 400],
  ];
  for (const [m, p, body, passStatus] of lifecycle) {
    const none = await http(m, p, { body });
    ok(none.status === 401, `${p} 无凭据 ⇒ 401`, String(none.status));
    const view = await http(m, p, { cookie: V.cookie, body });
    ok(view.status === 403 && view.json && view.json.error === 'FORBIDDEN',
      `${p} can_manage_workers:false 的 session ⇒ 403（不是 401）`, `${view.status} ${view.text.slice(0, 100)}`);
    const adm = await http(m, p, { bearer: adminToken, body });
    ok(adm.status === passStatus,
      `${p} admin token ⇒ 过了鉴权，拿到业务层的 ${passStatus}（目标不存在 / 参数不对）`, `${adm.status} ${adm.text.slice(0, 100)}`);
    const pat = await http(m, p, { cookie: P.cookie, body });
    ok(pat.status === passStatus, `${p} Patrick（manage）的 session ⇒ 同样过了鉴权`, String(pat.status));
  }
  {
    const wc = await wsTry({ cookie: P.cookie });
    ok(wc.opened, '/ws 带 session cookie ⇒ 连上', JSON.stringify({ status: wc.status, error: wc.error }));
    if (wc.ws) wc.ws.close();
    const wb = await wsTry({ authorization: `Bearer ${adminToken}` });
    ok(wb.opened, '/ws 带 admin token ⇒ 连上');
    if (wb.ws) wb.ws.close();
  }

  // ── 临时 agent：bus 起来**之后**才登记（见文件头：no-op watchdog 启动那一下会摘牌）
  execFileSync('tmux', ['new-session', '-d', '-s', CREW_SESSION, 'sleep', '600'], { env: childEnv });
  {
    const ls = execFileSync('tmux', ['ls', '-F', '#{session_name}'], { env: childEnv, encoding: 'utf8' }).trim().split('\n');
    ok(ls.length === 1 && ls[0] === CREW_SESSION,
      `⓪ 私有 tmux server 上只有临时会话 ${CREW_SESSION} —— 没连到生产 tmux`, JSON.stringify(ls));
  }
  await roster.register(redis, CREW, { type: 'dev', tmux_session: CREW_SESSION });
  const tReg = Date.now();
  let relayUp = false;
  for (let i = 0; i < 100 && !relayUp; i++) {
    relayUp = busLog.join('').includes(`挂上 relay: ${CREW}`);
    if (!relayUp) await wait(250);
  }
  ok(relayUp, `临时 agent 的 relay 挂上了（${Math.round((Date.now() - tReg) / 1000)}s）`);

  const wsP = await wsTry({ cookie: P.cookie });

  // ── 4. 房间：章跟着扇出走 ───────────────────────────────────────────────
  console.log('\n【4】房间发言：盖章 ＋ 扇出带章');
  const room = await http('POST', '/api/rooms', { cookie: P.cookie, body: { name: `auth-${MARK}`, members: [CREW] } });
  ok(room.status === 201, '建房间（201）', room.text.slice(0, 100));
  const rp = await http('POST', `/api/rooms/${room.json.hash}/post`,
    { cookie: P.cookie, body: { from: 'Mallory', text: `R ${MARK}` } });
  ok(rp.status === 202 && rp.json.from === 'Patrick', '房间发言 body 写 from:"Mallory" ⇒ 返回的 from 是 Patrick', rp.text.slice(0, 120));
  {
    const rs = (await redis.xrange(`room:${room.json.hash}`, '-', '+')).map(([, f]) => asObj(f));
    const e = rs.find((o) => String(o.text).includes(`R ${MARK}`));
    ok(e && e.from === 'Patrick' && e.sender_type === 'human' && e.can_manage_workers === '1',
      '★ 房间流条目：from=Patrick · sender_type=human · can_manage_workers="1"', JSON.stringify(e));
  }
  let fan = null;
  for (let i = 0; i < 40 && !fan; i++) {
    const rows = (await redis.xrange(`agent:${CREW}:in`, '-', '+')).map(([, f]) => asObj(f));
    fan = rows.find((o) => String(o.text).includes(`R ${MARK}`));
    if (!fan) await wait(250);
  }
  ok(fan && fan.sender_type === 'human' && fan.can_manage_workers === '1',
    '★★ 扇出到 agent 收件流的那份**还带着章**（扇出是手工拼的 payload）', JSON.stringify(fan));

  // ── 5. agent 经 relay 发给 JARVIS ⇒ 盖 agent 章；WS 推送到浏览器 ──────────────
  console.log('\n【5】agent → relay → 编排者：agent 章 ＋ WS 推送');
  fs.mkdirSync(path.join(outboxRoot, CREW), { recursive: true });
  fs.writeFileSync(path.join(outboxRoot, CREW, `${Date.now()}.json`),
    JSON.stringify({ username: 'JARVIS', text: `A ${MARK}` }));
  let pe = null;
  for (let i = 0; i < 40 && !pe; i++) {
    pe = (await redis.xrange('orch:in:agent', '-', '+')).map(([, f]) => asObj(f))
      .find((o) => String(o.text).includes(`A ${MARK}`));
    if (!pe) await wait(250);
  }
  ok(pe && pe.from === CREW && pe.sender_type === 'agent', '★ relay 投进 orch:in:agent 的那条：from=authcrew · sender_type=agent',
    JSON.stringify(pe));
  let pushed = null;
  for (let i = 0; i < 40 && !pushed && wsP.opened; i++) {
    pushed = wsP.received.find((m) => m.type === 'message' && String(m.text).includes(`A ${MARK}`));
    if (!pushed) await wait(250);
  }
  ok(!!pushed, '登录过的 WS 收到了这条推送（agent → 编排者那条也推浏览器）',
    JSON.stringify((wsP.received || []).map((m) => m.type)));
  if (wsP.ws) wsP.ws.close();

  // ── 6. 不带章的消息（直接 XADD）＋ 伪造的管理权 ───────────────────────────
  await redis.xadd('orch:in:human', '*', 'from', 'Patrick', 'text', `U ${MARK}`, 'job_id', `u-${MARK}`);
  await redis.xadd('orch:in:agent', '*', 'from', 'dev', 'text', `F ${MARK}`, 'job_id', `f-${MARK}`,
    'sender_type', 'agent', 'can_manage_workers', '1');

  // ── 7. poller 输出：sender_type / can_manage_workers / trust ──────────────
  console.log('\n【7】poller（bin/next.js）输出的三个字段');
  const poll = (args, name) => {
    const out = execFileSync('node', [path.join(ROOT, 'bin', 'next.js'), ...args, '--block', '1500'], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...childEnv, ENGLOOP_PROBE_STATE: path.join(stateDir, `probe-${name}.json`),
        ...(name === CREW ? { ENGLOOP_AGENT_TYPE: 'dev' } : {}) },
    });
    return JSON.parse(out);
  };
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const o = poll([], 'JARVIS');
    seen.push(...(o.messages || []));
    if (['P ', 'V ', 'A ', 'U ', 'F '].every((p) => seen.some((m) => String(m.text).startsWith(p) && String(m.text).includes(MARK)))) break;
  }
  const find = (p) => seen.find((m) => String(m.text) === `${p} ${MARK}`);
  const fields = (m) => m && JSON.stringify({ from: m.from, sender_type: m.sender_type, can_manage_workers: m.can_manage_workers, trust: m.trust });
  const mP = find('P'); const mV = find('V'); const mA = find('A'); const mU = find('U'); const mF = find('F');
  ok(mP && mP.trust === 'principal' && mP.can_manage_workers === true && mP.sender_type === 'human',
    '★ 人类（Patrick）消息 ⇒ trust:"principal" · can_manage_workers:true', fields(mP));
  ok(mV && mV.trust === 'principal' && mV.can_manage_workers === false,
    '★ 人类（Viewer）消息 ⇒ trust:"principal" · can_manage_workers:false', fields(mV));
  ok(mA && mA.trust === 'agent' && mA.sender_type === 'agent' && mA.can_manage_workers === false,
    '★ agent 消息 ⇒ trust:"agent"', fields(mA));
  ok(mU && mU.trust === 'data' && mU.sender_type === 'unknown' && mU.can_manage_workers === false,
    '★★ 手工 XADD、不带章（from 写着 Patrick）⇒ trust:"data" · sender_type:"unknown"', fields(mU));
  ok(mF && mF.trust === 'agent' && mF.can_manage_workers === false,
    '★ agent 章上写着 can_manage_workers="1" ⇒ 仍是 false（只有 human 的章能带管理权）', fields(mF));
  ok(seen.every((m) => ['principal', 'agent', 'system', 'data'].includes(m.trust)),
    '每条消息都**有** trust 字段（没有章也说出来，不是缺席）', JSON.stringify(seen.map((m) => m.trust)));

  // agent 那一侧：房间里 Patrick 的话照样是 principal（信任按作者定，不按通道定）
  const crewSeen = [];
  for (let i = 0; i < 3 && !crewSeen.some((m) => String(m.text).includes(`R ${MARK}`)); i++) {
    crewSeen.push(...(poll(['--group', `agent:${CREW}`, '--streams', `agent:${CREW}:in`, '--name', CREW], CREW).messages || []));
  }
  const mR = crewSeen.find((m) => String(m.text).includes(`R ${MARK}`));
  ok(mR && mR.trust === 'principal' && mR.can_manage_workers === true && mR.room_hash === room.json.hash,
    '★★ agent 收到的 Patrick **房间**发言 ⇒ trust:"principal"（不因为是房间就降成 data）', fields(mR));
  // ack 掉 agent 这一轮，免得关停那一轮它们被 autoclaim 回来
  for (const m of crewSeen) {
    const [s, id] = m.stream_id.split(':::');
    await redis.xack(s, `agent:${CREW}`, id).catch(() => {});
  }

  // ── 8. agent-start --stop 端到端（admin token；SHUTDOWN_REQUEST 盖 system 章）──
  console.log('\n【8】node bin/agent-start.js --stop 端到端（临时 agent）');
  const stopOut = [];
  const stop = spawn('node', [path.join(ROOT, 'bin', 'agent-start.js'), '--stop', CREW], { cwd: ROOT, env: childEnv });
  stop.stdout.on('data', (d) => stopOut.push(String(d)));
  stop.stderr.on('data', (d) => stopOut.push(String(d)));
  const stopDone = new Promise((r) => stop.on('exit', (code) => r(code)));

  let req = null;
  for (let i = 0; i < 6 && !req; i++) {
    const msgs = poll(['--group', `agent:${CREW}`, '--streams', `agent:${CREW}:in`, '--name', CREW], CREW).messages || [];
    req = msgs.find((m) => String(m.text).startsWith('SHUTDOWN_REQUEST'));
  }
  ok(req && req.sender_type === 'system' && req.trust === 'system' && req.can_manage_workers === false,
    '★ agent 收到的 SHUTDOWN_REQUEST ⇒ trust:"system"（bus 自己写的；盖成 data 会让新协议拒掉握手）', fields(req));
  if (req) {
    // 模拟 agent 照关停协议收尾：ack ＋ 以 READY_TO_SHUTDOWN 开头的消息
    fs.writeFileSync(path.join(outboxRoot, CREW, `${Date.now()}.json`),
      JSON.stringify({ ack: [req.stream_id], username: 'JARVIS', text: 'READY_TO_SHUTDOWN 收尾完毕' }));
  }
  const code = await Promise.race([stopDone, wait(45000).then(() => 'timeout')]);
  const out = stopOut.join('');
  ok(code === 0 && out.includes(`✓ ${CREW} 已优雅关停（graceful）`),
    `★★ agent-start --stop ${CREW} ⇒ exit 0「已优雅关停（graceful）」`, `code=${code} out=${out.slice(-300)}`);
  let sessionGone = false;
  try { execFileSync('tmux', ['has-session', '-t', CREW_SESSION], { env: childEnv, stdio: 'ignore' }); } catch { sessionGone = true; }
  ok(sessionGone, `临时会话 ${CREW_SESSION} 被 bus 收掉了`);
  ok(!(await roster.lookup(redis, CREW)), '临时 agent 已摘牌');
  ok(Date.now() - tReg < 60000, `临时 agent 那几段在 no-op watchdog 的下一次 tick 之前做完（${Math.round((Date.now() - tReg) / 1000)}s < 60s）`);

  // 没有 token ⇒ CLI 明说，不降级成不带凭据
  {
    const r = spawnSync('node', [path.join(ROOT, 'bin', 'agent-start.js'), '--stop', CREW], {
      cwd: ROOT, encoding: 'utf8', env: { ...childEnv, ENGLOOP_ADMIN_TOKEN_FILE: path.join(tmp, 'no-such.token') },
    });
    ok(r.status === 1 && /admin token/.test(r.stderr), 'token 文件读不到 ⇒ agent-start 报「读不到 admin token」退 1',
      `${r.status} ${String(r.stderr).slice(0, 160)}`);
  }

  // ── 9. 生产 token 文件没被这个测试 bus 碰过 ─────────────────────────────
  const prodTokenAfter = (() => { try { return fs.statSync(PROD_TOKEN).mtimeMs; } catch { return null; } })();
  ok(prodTokenAfter === prodTokenBefore, '★ 生产 temp/bus-admin.token 没被测试 bus 改写（隔离表第 ⑧ 条）',
    `${prodTokenBefore} → ${prodTokenAfter}`);

  await redis.del('orch:in:human', 'orch:in:agent', 'orch:out', `agent:${CREW}:in`, `room:${room.json && room.json.hash}`,
    roster.KEY(CREW), roster.KEY('JARVIS'));
  await redis.quit();
  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log(`\n  通过 ${pass} · 失败 ${fail + 1}`); process.exit(1); });
