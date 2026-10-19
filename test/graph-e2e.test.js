'use strict';

/**
 * 任务图端到端 —— **真 bus、真 worker 池、假 claude、agent 替身**。
 *
 *   PLAN.json ─CLI/HTTP─▶ bus（graph-runner：校验 · 冻结 · 人工闸）
 *        tick ─▶ kind:work ─XADD─▶ work:eval ─▶ 池 ─▶ 假 claude ─▶ 结果 ─▶ agent:GRAPH:in ─▶ 写 produces ─▶ stageGate
 *        tick ─▶ kind:crew  ─XADD─▶ agent:gcrew:in（system 章）─▶ 替身写文件 / 写 outbox「SUBPLAN gm c」─relay─▶ agent:GRAPH:in
 *
 * ── 主图 gm（5 个节点，D 是 C 往下拆出来的）────────────────────────────────
 *     a(work) ─┐
 *              ├─▶ c(agent: gcrew) ──▶ e(work, 带 verify)
 *     b(work) ─┘      └─ d(work，SUBPLAN 挂上的子节点)
 *
 * ── 旁边几张小图（同一个 bus 上并行跑）──────────────────────────────────
 *   gt  x(lib/) · y(lib/x.js)       无依赖、touches 重叠    ⇒ **不许**同时 dispatched
 *   gc  x(lib/a.js) · y(lib/ab.js)  无依赖、touches 不重叠  ⇒ **会**同时 dispatched（阴性对照：证明这个测量能看见重叠）
 *   gd  x(agent)，max_depth=1          申请子图 ⇒ 深度越界被拒（子图越界的第二种）
 *   gr  r(work) 输出不合格            ⇒ 打回、重派、再打回 ⇒ blocked ＋ 上报
 *   gv  v(work) verify 退 3           ⇒ 同上，走 verify 那条路
 *   gx  x(work) 跑起来之后 PLAN.json 被改 ⇒ verify 命令不可信 ⇒ blocked（文件头 🔴 那段的正控）
 *
 * ── 隔离 ──────────────────────────────────────────────────────────────────
 *   `bin/serve.js` 头注那张表 ①–⑨ 全设 ＋ ENGLOOP_ISOLATED=1 ＋ 自己的用户表 ＋ `q.allocTestDb()` 的测试库。
 *   ⚠️ worker 池每跑一次会 provision `workers/eval/`（写进 worktree 路径）—— 已知副作用，提交前还原。
 *
 * 变异（不落盘）：`scripts/mutate-graph.js`。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const q = require('../lib/queue');
const auth = require('../lib/auth');
const roster = require('../lib/roster');
const stamp = require('../lib/stamp');
const G = require('../lib/graph');

const PORT = 19983;                    // 生产 9969 · e2e 19969 · bus-auth 19977
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const TICK_MS = 600;
const CREW = 'gcrew';
const OTHER = 'gother';
const SINK = roster.inboxFor(G.SCHEDULER_NAME, G.SCHEDULER_TYPE);

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
  return { status: r.status, json, text };
}

const fieldsOf = ([id, f]) => { const o = { id }; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1]; return o; };

async function main() {
  console.log('\n任务图端到端（隔离 bus ＋ 假 claude ＋ agent 替身）\n');

  // ── 0. 隔离环境 ─────────────────────────────────────────────────────────
  const testDb = q.allocTestDb();
  if (testDb === null) { console.log('  ✗ 拿不到测试库 —— 中止'); process.exit(1); }
  const testUrl = q.withDb(q.DEFAULTS.url, testDb);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-graph-'));
  const dirs = {};
  for (const d of ['outbox', 'state', 'tmux', 'graphs', 'history', 'outputs', 'bin']) {
    dirs[d] = path.join(tmp, d);
    fs.mkdirSync(dirs[d], { recursive: true });
  }
  const usersFile = path.join(tmp, 'users.json');
  const tokenFile = path.join(tmp, 'bus-admin.token');
  const KEY_P = auth.newKey();
  const KEY_V = auth.newKey();
  fs.writeFileSync(usersFile, JSON.stringify([
    { username: 'Patrick', key_sha256: auth.sha256(KEY_P), can_manage_workers: true },
    { username: 'Viewer', key_sha256: auth.sha256(KEY_V), can_manage_workers: false },
  ]));

  // 假 claude：`-p <text>`。FAKE_BAD ⇒ 输出没有标题；FAKE_SLOW ⇒ 多睡一会儿（让 a、b 的 dispatched 区间看得见重叠）
  const fake = path.join(dirs.bin, 'fake-claude.js');
  fs.writeFileSync(fake, '#!/usr/bin/env node\n'
    + "const a = process.argv; const t = a[a.indexOf('-p') + 1] || '';\n"
    + 'const ms = /FAKE_SLOW/.test(t) ? 2500 : 900;\n'
    + 'setTimeout(() => {\n'
    + "  if (/FAKE_BAD/.test(t)) process.stdout.write('没有任何标题的输出\\n');\n"
    + "  else process.stdout.write('## 结论\\n假 worker 做完了：' + t.split('\\n')[0].slice(0, 60) + '\\n');\n"
    + '}, ms);\n');
  fs.chmodSync(fake, 0o755);

  const childEnv = { ...process.env };
  delete childEnv.TMUX; delete childEnv.TMUX_PANE;
  Object.assign(childEnv, {
    ENGLOOP_REDIS_URL: testUrl,                                   // ①
    ENGLOOP_PORT: String(PORT),                                    // ②
    ENGLOOP_OUTBOX_ROOT: dirs.outbox,                              // ③
    ENGLOOP_ISOLATED: '1',                                         // ④ tmux no-op
    ENGLOOP_HISTORY_ROOT: dirs.history,                            // ⑤
    ENGLOOP_OUTPUTS_ROOT: dirs.outputs,                            // ⑥
    ENGLOOP_THREAD_ALERT_DIR: path.join(dirs.state, 'thread-alert'), // ⑦
    ENGLOOP_ADMIN_TOKEN_FILE: tokenFile,                           // ⑧
    ENGLOOP_GRAPHS_ROOT: dirs.graphs,                              // ⑨
    ENGLOOP_USERS_FILE: usersFile,
    TMUX_TMPDIR: dirs.tmux,
    ENGLOOP_WAITING_STATE: path.join(dirs.state, 'waiting.json'),
    ENGLOOP_BUSY_ROOT: path.join(dirs.state, 'busy'),
    ENGLOOP_DEADLETTER_ROOT: path.join(dirs.state, 'deadletter'),
    ENGLOOP_WORKER_TYPES: 'eval',
    ENGLOOP_WORKER_CONCURRENCY: '4',
    ENGLOOP_CLAUDE_BIN: fake,
    ENGLOOP_GRAPH_TICK_MS: String(TICK_MS),
  });
  delete childEnv.ENGLOOP_TEST_DB; delete childEnv.ENGLOOP_TEST_DB_JOIN;

  const redis = q.createClient(testUrl);
  await redis.flushdb();
  // 替身们**在 bus 起来之前**登记（relay 在启动时第一次 syncRelays 就挂上）；
  // 不带 tmux_session ⇒ 隔离 bus 的 no-op watchdog 不会把它们判成 stale 摘掉
  await roster.register(redis, 'JARVIS', { type: 'orchestrator', tmux_session: '' });
  await roster.register(redis, CREW, { type: 'dev', tmux_session: '' });
  await roster.register(redis, OTHER, { type: 'dev', tmux_session: '' });

  let bus = null;
  const busLog = [];
  const startBus = () => {
    bus = spawn('node', [path.join(ROOT, 'bin', 'serve.js')], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    bus.stdout.on('data', (d) => busLog.push(String(d)));
    bus.stderr.on('data', (d) => busLog.push(String(d)));
  };
  const stopBus = () => new Promise((resolve) => {
    if (!bus || bus.exitCode !== null) return resolve();
    bus.once('exit', () => resolve());
    bus.kill('SIGTERM');
  });
  const healthy = async () => {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch (_) { /* 还没起来 */ }
      await wait(200);
    }
    return false;
  };
  process.on('exit', () => {
    try { if (bus && bus.exitCode === null) bus.kill('SIGKILL'); } catch (_) { /* 已经没了 */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  startBus();
  ok(await healthy(), `⓪ 隔离 bus 起来了（:${PORT}，db ${testDb}）`, busLog.join('').slice(-400));
  const login = async (username, key) => {
    const r = await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, key }),
    });
    return (r.headers.get('set-cookie') || '').split(';')[0];
  };
  let P = await login('Patrick', KEY_P);
  const V = await login('Viewer', KEY_V);
  ok(/^engloop_session=/.test(P), 'Patrick 登录拿到 session');

  // ── 工具 ────────────────────────────────────────────────────────────────
  const until = async (fn, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await wait(150);
    }
  };
  const view = async (gid) => (await http('GET', `/api/graphs/${gid}`, { cookie: P })).json;
  const nodeOf = async (gid, nid) => { const v = await view(gid); return v && v.nodes.find((n) => n.id === nid); };
  const stateIs = (gid, nid, st) => until(async () => { const n = await nodeOf(gid, nid); return n && n.state === st ? n : null; });
  const fullLog = async (gid) => (await redis.lrange(`graph:${gid}:log`, 0, -1)).map((x) => JSON.parse(x));
  /** log 里第一次「nid → to」的位置；找不到 ⇒ null（**不是 -1**：-1 会恒小于任何位置）。 */
  const posOf = (log, nid, to) => { const i = log.findIndex((e) => e.node === nid && e.to === to); return i >= 0 ? i : null; };
  const atOf = (log, nid, to) => { const e = log.find((x) => x.node === nid && x.to === to); return e ? Date.parse(e.at) : null; };
  const inbox = async (stream) => (await redis.xrange(stream, '-', '+')).map(fieldsOf);
  /** 图的投影：节点集合 ＋ 每个节点的状态 / 第几次 / 父节点 ＋ 图状态 ＋ redis 里冻结的定义原文。 */
  const snap = async (gid) => {
    const v = await view(gid);
    const defs = await redis.hgetall(`graph:${gid}:nodes`);
    return JSON.stringify([v.meta.status, v.nodes.map((n) => [n.id, n.state, n.attempt, n.parent, n.rejects]),
      Object.keys(defs).sort().map((k) => [k, defs[k]])]);
  };
  /** agent 替身往自己的 outbox 写一条（relay 盖 agent 章、from = 目录名）。 */
  const crewSay = (who, obj) => fs.writeFileSync(path.join(dirs.outbox, who, `${Date.now()}${Math.floor(Math.random() * 1000)}.json`), JSON.stringify(obj));
  const replyTo = (who, re, after = 0) => until(async () => (await inbox(roster.inboxFor(who, 'dev')))
    .slice(after).find((m) => m.from === G.SCHEDULER_NAME && re.test(m.text)));
  const writePlan = (id, plan) => {
    const d = path.join(dirs.graphs, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'PLAN.json'), JSON.stringify({ id, ...plan }, null, 2));
    return d;
  };
  const work = (id, over = {}) => ({
    id, title: `work ${id}`, kind: 'work', assignee: 'eval', depends_on: [], brief: `做 ${id}`,
    produces: `${id}/OUT.md`, requires: ['## 结论'], touches: [], timeout_min: 5, ...over,
  });
  const LIM = (o = {}) => ({ max_parallel: 2, max_depth: 2, max_nodes: 6, ...o });

  // ── 1. 鉴权：读要登录，起图要 can_manage_workers ────────────────────────
  console.log('\n【1】/api/graphs 在鉴权闸门后面');
  {
    ok((await http('GET', '/api/graphs')).status === 401, 'GET /api/graphs 无凭据 ⇒ 401');
    const gdir = writePlan('gz', { goal: 'x', limits: LIM(), nodes: [work('z')] });
    const vr = await http('POST', '/api/graphs', { cookie: V, body: { dir: gdir } });
    ok(vr.status === 403, 'Viewer（没有 can_manage_workers）起图 ⇒ 403', `${vr.status} ${vr.text.slice(0, 120)}`);
    const out = writePlan('../escape', { goal: 'x', limits: LIM(), nodes: [work('z')] });
    const er = await http('POST', '/api/graphs', { cookie: P, body: { dir: out } });
    ok(er.status === 400 && er.json.error === 'DIR_OUT_OF_ROOT', '图目录在 ENGLOOP_GRAPHS_ROOT 之外 ⇒ 400 DIR_OUT_OF_ROOT', er.text.slice(0, 160));
    const bad = writePlan('gbad', { goal: 'x', limits: LIM(), nodes: [work('p', { depends_on: ['q'] }), work('q', { depends_on: ['p'] })] });
    const br = await http('POST', '/api/graphs', { cookie: P, body: { dir: bad } });
    ok(br.status === 400 && /有环/.test(br.json.message), '有环的 PLAN ⇒ 400，消息里指到环', br.text.slice(0, 200));
  }

  // ── 2. 旁边几张小图先起（work-only、≤5 个节点 ⇒ 自动开跑）──────────────
  console.log('\n【2】work-only 的小图自动开跑；touches 冲突 / 阴性对照 / 打回 / verify / PLAN 被改');
  const small = {
    gt: { goal: 'touches 重叠', limits: LIM(), nodes: [work('x', { touches: ['lib/'] }), work('y', { touches: ['lib/x.js'] })] },
    gc: { goal: '阴性对照', limits: LIM(), nodes: [work('x', { touches: ['lib/a.js'] }), work('y', { touches: ['lib/ab.js'] })] },
    gr: { goal: '输出不合格', limits: LIM(), nodes: [work('r', { brief: 'FAKE_BAD 输出不带标题' })] },
    gv: { goal: 'verify 不过', limits: LIM(), nodes: [work('v', { verify: 'echo verify-says-no; exit 3' })] },
    gx: { goal: 'PLAN 被改', limits: LIM(), nodes: [work('x', { brief: 'FAKE_SLOW 慢一点', verify: 'true' })] },
  };
  for (const [id, p] of Object.entries(small)) {
    const r = await http('POST', '/api/graphs', { cookie: P, body: { dir: writePlan(id, p) } });
    ok(r.status === 201 && r.json.status === 'running', `${id}：起图 ⇒ 201 running（${r.json && r.json.why}）`, r.text.slice(0, 200));
  }
  // gx 一跑起来就改 PLAN.json（verify 命令从磁盘读、md5 要对得上 ⇒ 这次对不上）
  await stateIs('gx', 'x', 'dispatched');
  fs.appendFileSync(path.join(dirs.graphs, 'gx', 'PLAN.json'), '\n');

  // ── 3. 主图：CLI 起 ⇒ 人工闸 ────────────────────────────────────────────
  console.log('\n【3】主图 gm：带 kind:crew ⇒ 停在 awaiting_approval');
  const gm = writePlan('gm', {
    goal: '5 节点：a、b 并行 → c 汇合（agent）→ c 拆出 d → e',
    limits: { max_parallel: 2, max_depth: 2, max_nodes: 5 },
    nodes: [
      work('a', { brief: 'FAKE_SLOW a', touches: ['src/a/'] }),
      work('b', { brief: 'FAKE_SLOW b', touches: ['src/b/'] }),
      { id: 'c', title: '汇合', kind: 'crew', assignee: CREW, depends_on: ['a', 'b'], brief: '把 a、b 的结论合起来',
        produces: 'c/REPORT.md', requires: ['## 改了什么', '## 验收'], touches: ['src/c/'], timeout_min: 30 },
      work('e', { depends_on: ['c'], verify: 'node -e "process.exit(0)"' }),
    ],
  });
  {
    const cli = spawnSync('node', [path.join(ROOT, 'bin', 'graph.js'), 'start', gm], { cwd: ROOT, env: childEnv, encoding: 'utf8' });
    ok(cli.status === 0 && /awaiting_approval/.test(cli.stdout), '`node bin/graph.js start` ⇒ 退 0，说 awaiting_approval', `${cli.status} ${cli.stdout}${cli.stderr}`);
    await wait(TICK_MS * 4);
    const v = await view('gm');
    ok(v && v.meta.status === 'awaiting_approval' && v.nodes.every((n) => n.state === 'pending'),
      '★ 等了 4 个 tick：图仍是 awaiting_approval，4 个节点全 pending', v && JSON.stringify(v.nodes.map((n) => n.state)));
    const leaked = (await inbox('work:eval')).filter((m) => /^graph:gm:/.test(m.job_id || ''));
    ok(leaked.length === 0, '★ 等批期间 work:eval 里没有 gm 的活', String(leaked.length));
    const va = await http('POST', '/api/graphs/gm/approve', { cookie: V });
    ok(va.status === 403, 'Viewer 批 ⇒ 403', String(va.status));
    const pa = await http('POST', '/api/graphs/gm/approve', { cookie: P });
    ok(pa.status === 200 && pa.json.status === 'running', 'Patrick 批 ⇒ running', pa.text);
    const v2 = await view('gm');
    ok(v2.meta.approved_by === 'Patrick' && v2.meta.approved_via === 'session', '谁批的、经什么批的，记在 meta 上', JSON.stringify([v2.meta.approved_by, v2.meta.approved_via]));
  }

  // ── 4. a、b 并行 → c ───────────────────────────────────────────────────
  console.log('\n【4】a、b 同时 dispatched；c 在 a、b 都 verified 之前从没被派');
  await stateIs('gm', 'c', 'dispatched');
  {
    const log = await fullLog('gm');
    const [aS, aE, bS, bE] = [atOf(log, 'a', 'dispatched'), atOf(log, 'a', 'verified'), atOf(log, 'b', 'dispatched'), atOf(log, 'b', 'verified')];
    ok([aS, aE, bS, bE].every((x) => x !== null) && aS < bE && bS < aE,
      '★ a、b 的 dispatched→verified 区间重叠（同时在跑）', JSON.stringify({ aS, aE, bS, bE }));
    const pc = posOf(log, 'c', 'dispatched');
    const pa = posOf(log, 'a', 'verified');
    const pb = posOf(log, 'b', 'verified');
    ok(pc !== null && pa !== null && pb !== null && pc > pa && pc > pb,
      '★ c → dispatched 在 a、b → verified 之后（三个位置都找到了才比）', JSON.stringify({ pa, pb, pc }));
    ok(log.filter((e) => e.node === 'c' && e.to === 'dispatched').length === 1, 'c 只被派了一次');
    // ⚠️ 读不到不抛 —— 一个抛出的 ENOENT 会让后面那几段（【5】）根本不跑，变异 E13 会因此「活下来」
    let out = '';
    try { out = fs.readFileSync(path.join(gm, 'a', 'OUT.md'), 'utf8'); } catch (e) { out = `（读不到：${e.code}）`; }
    ok(/^## 结论\n假 worker 做完了/.test(out), 'kind:work 的输出被调度器原样写成 a/OUT.md（worker 没有写盘能力）', out.slice(0, 80));
  }

  console.log('\n【5】worker 结果进了 GRAPH 的收件流，没进发给人 / 编排者的流');
  {
    const sink = await inbox(SINK);
    const res = sink.filter((m) => /^graph:gm:[ab]:/.test(m.job_id || '') && m.from === 'worker:eval');
    ok(res.length === 2 && res.every((m) => m.result_ok === '1' && m.sender_type === 'agent'),
      `★ a、b 的两条结果都在 ${SINK}（result_ok=1，agent 章）`, JSON.stringify(res.map((m) => [m.job_id, m.result_ok])));
    const human = [...await inbox('orch:out'), ...await inbox('orch:in:agent'), ...await inbox('orch:in:human')]
      .filter((m) => /^graph:/.test(m.job_id || '') && String(m.from).startsWith('worker:'));
    ok(human.length === 0, '★ orch:out / orch:in:agent / orch:in:human 里一条 worker 结果都没有', JSON.stringify(human.map((m) => m.job_id)));
    const reg = await roster.lookup(redis, G.SCHEDULER_NAME);
    ok(reg && reg.type === G.SCHEDULER_TYPE && reg.stream === SINK, `调度器在册：${G.SCHEDULER_NAME} / ${G.SCHEDULER_TYPE} / ${SINK}`, JSON.stringify(reg));
  }

  console.log('\n【6】c 的派活：点名进 gcrew 的收件流，system 章，正文自足');
  let cMsg;
  {
    cMsg = (await inbox(roster.inboxFor(CREW, 'dev'))).find((m) => m.job_id === 'graph:gm:c:1');
    const t = cMsg ? cMsg.text : '';
    ok(Boolean(cMsg), '★ gcrew 的收件流里有 job graph:gm:c:1');
    ok(cMsg && stamp.readStamp(cMsg).trust === 'system', '★ 盖的是 system 章（bus 自己按图派的，不是 data）', cMsg && cMsg.sender_type);
    ok(t.includes(path.join(gm, 'c', 'REPORT.md')) && t.includes('## 改了什么') && t.includes(`SUBPLAN gm c`),
      '正文带：produces 的绝对路径、requires、往下拆的申请格式', t.slice(0, 300));
    ok(/不用回消息/.test(t), '正文说了「做完写文件，不用回消息」');
  }

  // ── 7. 重启 bus：从 redis 接着跑，不重派 ───────────────────────────────
  console.log('\n【7】杀掉 bus 再起 ⇒ 接着跑，不重派已 dispatched 的 c');
  {
    const before = {
      log: (await fullLog('gm')).length,
      crew: (await inbox(roster.inboxFor(CREW, 'dev'))).filter((m) => /^graph:gm:c:/.test(m.job_id || '')).length,
      work: (await inbox('work:eval')).length,
    };
    await stopBus();
    ok(bus.exitCode !== null, 'bus 停了');
    startBus();
    ok(await healthy(), 'bus 重新起来了');
    P = await login('Patrick', KEY_P);
    await wait(TICK_MS * 5);
    const c = await nodeOf('gm', 'c');
    ok(c && c.state === 'dispatched' && c.attempt === 1, '★ c 仍是 dispatched、仍是第 1 次', c && JSON.stringify([c.state, c.attempt]));
    const crewNow = (await inbox(roster.inboxFor(CREW, 'dev'))).filter((m) => /^graph:gm:c:/.test(m.job_id || '')).length;
    ok(crewNow === before.crew, `★ 重启后 gcrew 没有再收到 c 的派活（${before.crew} → ${crewNow}）`);
    const logNow = await fullLog('gm');
    ok(logNow.slice(before.log).every((e) => e.to !== 'dispatched'), '★ 重启后 log 里没有任何新的 → dispatched', JSON.stringify(logNow.slice(before.log)));
    const workNow = (await inbox('work:eval')).filter((m) => /^graph:gm:/.test(m.job_id || '')).length;
    const workBefore = before.work;
    ok(workNow <= workBefore, '★ work:eval 里没有新的 gm 的活（a、b 没被重派）', `${workBefore} → ${workNow}`);
  }

  // ── 8. 子图越界：三种都被拒，图状态不变 ─────────────────────────────────
  console.log('\n【8】子图申请越界 ⇒ 拒，图状态不变');
  const cDir = path.join(gm, 'c');
  fs.mkdirSync(cDir, { recursive: true });
  const D = { id: 'd', title: '子节点 d', kind: 'work', assignee: 'eval', depends_on: [], brief: 'FAKE_SLOW 子节点 d',
    produces: 'd/OUT.md', requires: ['## 结论'], touches: ['src/c/d.js'], timeout_min: 5 };
  const orchBefore = (await inbox('orch:in:agent')).length;
  {
    // ① 子节点 kind:"crew"
    let s0 = await snap('gm');
    fs.writeFileSync(path.join(cDir, 'SUBPLAN.json'), JSON.stringify({ nodes: [{ ...D, kind: 'crew', assignee: OTHER }] }));
    let n0 = (await inbox(roster.inboxFor(CREW, 'dev'))).length;
    crewSay(CREW, { username: G.SCHEDULER_NAME, text: 'SUBPLAN gm c', ack: cMsg ? [`${roster.inboxFor(CREW, 'dev')}:::${cMsg.id}`] : [] });
    const r1 = await replyTo(CREW, /SUBPLAN 被拒/, n0);
    ok(r1 && /kind:"work"/.test(r1.text), '★ ① 子节点 kind:"crew" ⇒ 拒，回给 gcrew 说清「只能是 kind:"work"」', r1 && r1.text.slice(0, 200));
    await wait(TICK_MS * 2);
    ok((await snap('gm')) === s0, '★ ① 之后图状态不变（节点集合、各节点状态、冻结的定义）');

    // ① 补：子节点数超 max_nodes（4 + 2 > 5）
    s0 = await snap('gm');
    fs.writeFileSync(path.join(cDir, 'SUBPLAN.json'), JSON.stringify({ nodes: [D, { ...D, id: 'd2', produces: 'd2/OUT.md' }] }));
    n0 = (await inbox(roster.inboxFor(CREW, 'dev'))).length;
    crewSay(CREW, { username: G.SCHEDULER_NAME, text: 'SUBPLAN gm c' });
    const r1b = await replyTo(CREW, /SUBPLAN 被拒/, n0);
    ok(r1b && /max_nodes=5/.test(r1b.text), '子图让全图超 max_nodes ⇒ 拒', r1b && r1b.text.slice(0, 200));
    await wait(TICK_MS * 2);
    ok((await snap('gm')) === s0, '超 max_nodes 被拒之后图状态不变（没有部分挂上 d）');

    // ③ 发件人不是 assignee（gother 申请挂 c 的子图 —— 内容本身合法）
    fs.writeFileSync(path.join(cDir, 'SUBPLAN.json'), JSON.stringify({ nodes: [D] }));
    s0 = await snap('gm');
    n0 = (await inbox(roster.inboxFor(OTHER, 'dev'))).length;
    crewSay(OTHER, { username: G.SCHEDULER_NAME, text: 'SUBPLAN gm c' });
    const r3 = await replyTo(OTHER, /SUBPLAN 被拒/, n0);
    ok(r3 && /gother/.test(r3.text) && /assignee/.test(r3.text), '★ ③ 发件人 gother 不是 c 的 assignee ⇒ 拒', r3 && r3.text.slice(0, 200));
    await wait(TICK_MS * 2);
    ok((await snap('gm')) === s0, '★ ③ 之后图状态不变');

    // ③ 补：名字写成 gcrew、但没有章（直接 XADD，绕过 relay）
    s0 = await snap('gm');
    await redis.xadd(SINK, '*', 'from', CREW, 'to', G.SCHEDULER_NAME, 'text', 'SUBPLAN gm c', 'job_id', `forged-${Date.now()}`);
    await until(async () => busLog.join('').includes('SUBPLAN gm/c 被拒（gcrew · data）'), 8000);
    ok(busLog.join('').includes('SUBPLAN gm/c 被拒（gcrew · data）'), '★ 自称 gcrew、没有 agent 章（trust:data）⇒ 拒（章说了算，名字不算）');
    await wait(TICK_MS * 2);
    ok((await snap('gm')) === s0, '伪造的申请之后图状态不变');
  }

  // ② 深度越界：另一张图 gd（max_depth=1）
  {
    const gd = writePlan('gd', {
      goal: '深度越界', limits: { max_parallel: 1, max_depth: 1, max_nodes: 4 },
      nodes: [{ id: 'x', title: 'x', kind: 'crew', assignee: CREW, depends_on: [], brief: '随便',
        produces: 'x/R.md', requires: ['## 结论'], touches: ['src/x/'], timeout_min: 30 }],
    });
    const r = await http('POST', '/api/graphs', { cookie: P, body: { dir: gd } });
    ok(r.status === 201 && r.json.status === 'awaiting_approval', 'gd 起图 ⇒ awaiting_approval（有 kind:crew）', r.text.slice(0, 160));
    await http('POST', '/api/graphs/gd/approve', { cookie: P });
    await stateIs('gd', 'x', 'dispatched');
    fs.mkdirSync(path.join(gd, 'x'), { recursive: true });
    fs.writeFileSync(path.join(gd, 'x', 'SUBPLAN.json'), JSON.stringify({ nodes: [{ ...D, touches: ['src/x/k.js'] }] }));
    const s0 = await snap('gd');
    const n0 = (await inbox(roster.inboxFor(CREW, 'dev'))).length;
    crewSay(CREW, { username: G.SCHEDULER_NAME, text: 'SUBPLAN gd x' });
    const r2 = await replyTo(CREW, /SUBPLAN 被拒（图 gd/, n0);
    ok(r2 && /max_depth=1/.test(r2.text), '★ ② 深度 2 > max_depth=1 ⇒ 拒', r2 && r2.text.slice(0, 200));
    await wait(TICK_MS * 2);
    ok((await snap('gd')) === s0, '★ ② 之后图状态不变');
    const cancel = await http('POST', '/api/graphs/gd/cancel', { cookie: P });
    ok(cancel.status === 200 && cancel.json.status === 'cancelled', 'gd 放弃 ⇒ cancelled', cancel.text);
  }
  {
    const fwd = (await inbox('orch:in:agent')).slice(orchBefore).filter((m) => m.from === G.SCHEDULER_NAME && /子图申请越界/.test(m.text));
    ok(fwd.length >= 4 && fwd.every((m) => /graph_id=g[md] node=[cx]/.test(m.text) && /下一步可选/.test(m.text)),
      `越界的申请都转给了编排者（${fwd.length} 条），每条带 graph_id ＋ node ＋ 下一步可选动作`, fwd.map((m) => m.text.split('\n')[0]).join(' | '));
  }

  // ── 9. 合法申请：D 挂上 ⇒ D verified 之前 c 不算 verified ───────────────
  console.log('\n【9】c 的 stageGate 过了，但 d 没挂上 / 没 verified ⇒ c 不算 verified');
  {
    // c 先把产出写好（stageGate 会过），而 SUBPLAN.json 还没申请
    fs.writeFileSync(path.join(cDir, 'REPORT.md'), '## 改了什么\n合了 a 和 b\n\n## 验收\n看 d 的结论\n');
    await wait(TICK_MS * 4);
    let c = await nodeOf('gm', 'c');
    ok(c.state === 'dispatched' && /SUBPLAN\.json/.test(c.hold || ''),
      '★ d 挂上之前：c 的 stageGate 过了也仍是 dispatched，hold 说「有没挂上的 SUBPLAN.json」', JSON.stringify([c.state, c.hold]));

    const n0 = (await inbox(roster.inboxFor(CREW, 'dev'))).length;
    crewSay(CREW, { username: G.SCHEDULER_NAME, text: 'SUBPLAN gm c' });
    const ack = await replyTo(CREW, /子图挂上了/, n0);
    ok(Boolean(ack), 'gcrew 收到「子图挂上了」');
    const d = await stateIs('gm', 'd', 'dispatched');
    ok(d && d.parent === 'c' && d.depth === 2, 'd 挂在 c 下面（深度 2）并且派出去了', d && JSON.stringify([d.parent, d.depth]));
    c = await nodeOf('gm', 'c');
    ok(c.state === 'dispatched' && /子节点/.test(c.hold || ''), '★ d 在跑：c 的 stageGate 过了，仍在等子节点', JSON.stringify([c.state, c.hold]));
    await stateIs('gm', 'e', 'verified');
    const log = await fullLog('gm');
    const pdv = posOf(log, 'd', 'verified');
    const pcv = posOf(log, 'c', 'verified');
    ok(pdv !== null && pcv !== null && pcv > pdv, '★ c → verified 在 d → verified 之后', JSON.stringify({ pdv, pcv }));
    const v = await view('gm');
    ok(v.meta.status === 'verified' && v.nodes.length === 5 && v.nodes.every((n) => n.state === 'verified'),
      '★ 整张图 verified：5 个节点（d 是挂上来的）全部 verified', JSON.stringify(v.nodes.map((n) => [n.id, n.state])));
    const e = v.nodes.find((n) => n.id === 'e');
    ok(e && /verify 过了（exit 0）/.test(e.why), 'e 走了 verify（从磁盘上的 PLAN.json 读的命令，exit 0）', e && e.why);
    // ★ 没写 verify 的主图节点走 bus 接上的 defaultVerify（bin/verify-complete.js --graph-node）；
    //   挂上来的子节点（d）不走（定义不在 PLAN.json 里，只看 stageGate）
    const na = v.nodes.find((n) => n.id === 'a');
    const nd = v.nodes.find((n) => n.id === 'd');
    ok(na && /verify 过了（exit 0）：.*verify-complete\.js' --graph-node /.test(na.why) && nd && !/verify-complete/.test(nd.why),
      '★ a（没写 verify）走了 defaultVerify = verify-complete --graph-node；子节点 d 没走', `${na && na.why} || ${nd && nd.why}`);
    const done = (await inbox('orch:in:agent')).filter((m) => m.from === G.SCHEDULER_NAME && /【图 gm】整张图 verified/.test(m.text));
    ok(done.length === 1 && /graph_id=gm/.test(done[0].text), '编排者只收到**一条**「整张图 verified」', String(done.length));
  }

  console.log('\n【10】每一次状态转移都有广播（房间里 expects_reply:false、system 章）');
  {
    for (const gid of ['gm', 'gt', 'gc']) {
      const v = await view(gid);
      const log = await fullLog(gid);
      const roomMsgs = (await redis.xrange(`room:${v.meta.room_hash}`, '-', '+')).map(fieldsOf);
      const missing = log.filter((e) => !roomMsgs.some((m) => m.text.includes(e.node ? `${e.node}: ${e.from || '∅'} → ${e.to}` : `图状态：${e.from} → ${e.to}`)));
      ok(log.length > 0 && missing.length === 0, `★ ${gid}：log 里 ${log.length} 次转移，每一次在房间里都有一条广播`, JSON.stringify(missing.slice(0, 3)));
      ok(roomMsgs.every((m) => m.expects_reply === undefined && m.sender_type === 'system'),
        `${gid}：房间里的广播全是 expects_reply:false（不写字段）、system 章`);
    }
  }

  console.log('\n【11】touches 冲突的两个节点从不同时 dispatched；不冲突的对照组会');
  {
    await stateIs('gt', 'y', 'verified');
    await stateIs('gc', 'y', 'verified');
    const span = (log, n) => [atOf(log, n, 'dispatched'), atOf(log, n, 'verified')];
    const overlap = (p, r) => p.every((x) => x !== null) && r.every((x) => x !== null) && p[0] < r[1] && r[0] < p[1];
    const lt = await fullLog('gt');
    const lc = await fullLog('gc');
    const t = [span(lt, 'x'), span(lt, 'y')];
    const c = [span(lc, 'x'), span(lc, 'y')];
    ok(t.flat().every((x) => x !== null) && !overlap(t[0], t[1]), '★ gt：x(lib/) 和 y(lib/x.js) 的 dispatched→verified 区间不重叠', JSON.stringify(t));
    ok(overlap(c[0], c[1]), '阴性对照 gc：x(lib/a.js) 和 y(lib/ab.js) 区间**重叠** —— 这个测量看得见并行', JSON.stringify(c));
    const yv = (await view('gt')).nodes.find((n) => n.id === 'y');
    ok(yv && yv.state === 'verified', 'gt 的 y 最终也跑完了（等，不是丢）');
  }

  console.log('\n【12】打回两次 ⇒ blocked ＋ 上报；PLAN.json 被改 ⇒ verify 不跑');
  {
    const r = await stateIs('gr', 'r', 'blocked');
    ok(r && r.rejects === 2 && r.attempt === 2, 'gr：输出没过 stageGate ⇒ 打回、重派、再打回 ⇒ blocked（rejects 2、派了 2 次）', r && JSON.stringify([r.rejects, r.attempt]));
    const v = await stateIs('gv', 'v', 'blocked');
    ok(v && v.rejects === 2, 'gv：verify 退 3 ⇒ 同样两次后 blocked', v && JSON.stringify([v.rejects, v.why]));
    const vlog = await fullLog('gv');
    ok(vlog.some((e) => e.to === 'rejected' && /verify-says-no/.test(e.why)), 'gv：打回原因里带着 verify 的输出原文');
    const x = await stateIs('gx', 'x', 'blocked');
    ok(x && /在执行中被改了/.test(x.why), '★ gx：PLAN.json 跑到一半被改 ⇒ verify 命令不可信，不跑，blocked', x && x.why);
    const msgs = (await inbox('orch:in:agent')).filter((m) => m.from === G.SCHEDULER_NAME && /blocked/.test(m.text.split('\n')[0]));
    const gids = ['gr', 'gv', 'gx'].filter((g) => msgs.some((m) => m.text.includes(`graph_id=${g} `)));
    ok(gids.length === 3, 'gr / gv / gx 的 blocked 都上报了编排者（带 graph_id ＋ node）', gids.join(','));
    const rt = await http('POST', '/api/graphs/gr/retry/r', { cookie: P });
    ok(rt.status === 200 && rt.json.state === 'pending', 'retry 把 blocked 的节点放回 pending', rt.text);
  }

  console.log('\n【13】CLI status');
  {
    const s = spawnSync('node', [path.join(ROOT, 'bin', 'graph.js'), 'status', 'gm'], { cwd: ROOT, env: childEnv, encoding: 'utf8' });
    ok(s.status === 0 && /└ d/.test(s.stdout) && /verified/.test(s.stdout), '`node bin/graph.js status gm` ⇒ 表里有挂在 c 下的 d', s.stdout.slice(0, 400) + s.stderr);
  }

  await stopBus();
  await redis.flushdb();
  await redis.quit();
  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log(`\n  通过 ${pass} · 失败 ${fail + 1}`); process.exit(1); });
