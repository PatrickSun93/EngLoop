'use strict';

/**
 * loop_guard（S1B）：`hooks/loop_guard.js`（Stop hook）＋ `lib/loop-guard.js` ＋ `bin/agent-pause.js` ＋ 挂载矩阵。
 *
 * hook 每一条都**真的起子进程**、从 stdin 喂 JSON（字段照实测 2.1.314 的 Stop 输入：session_id / transcript_path / cwd /
 * hook_event_name / stop_hook_active）。bus 是**测试里起的一个假 HTTP 服务**（只答 /health 和关停状态），端口走 ENGLOOP_PORT，
 * admin token 走 ENGLOOP_ADMIN_TOKEN_FILE —— 不碰 127.0.0.1:9969，不碰生产的 temp/loop-guard/、temp/journal/。
 *
 * 变异：test 末尾不做；变异表在 PR 里（每条判据在内存里改一处 ⇒ 这里哪一条红）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'loop_guard.js');
const PAUSE = path.join(ROOT, 'bin', 'agent-pause.js');
const lg = require('../lib/loop-guard');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => (c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`)));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-loopguard-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 清不掉就算了 */ } });
const GUARD = path.join(TMP, 'guard');
const JOURNAL = path.join(TMP, 'journal');
const TOKEN_FILE = path.join(TMP, 'admin.token');
const TOKEN = 'a'.repeat(64);
fs.writeFileSync(TOKEN_FILE, `${TOKEN}\n`);
fs.mkdirSync(JOURNAL, { recursive: true });

// ── 假 bus：/health 和 GET /api/agents/:name/shutdown（要 Bearer token）──────────
const bus = { health: { ok: true, redis: 'pong' }, healthStatus: 200, pending: new Set(), shutdownStatus: null, requests: [] };
const server = http.createServer((req, res) => {
  bus.requests.push(req.url);
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.url === '/health') return send(bus.healthStatus, bus.health);
  const m = /^\/api\/agents\/([^/]+)\/shutdown$/.exec(req.url);
  if (m && req.method === 'GET') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    if (bus.shutdownStatus) return send(bus.shutdownStatus, { error: 'x' });
    return send(200, { name: decodeURIComponent(m[1]), pending: bus.pending.has(decodeURIComponent(m[1])), still_registered: true });
  }
  return send(404, {});
});

/** 一个现在没人在听的端口（bind 0 再关掉）。 */
function deadPort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function stopInput(over = {}) {
  return { session_id: 'sess-s1b', transcript_path: '/tmp/none.jsonl', cwd: '/tmp', hook_event_name: 'Stop', stop_hook_active: false, ...over };
}

let PORT;
/** 起一次 hook（异步 —— 假 bus 跑在本进程里，spawnSync 会把它卡死）。 */
function runHook({ name = 'lgdev', kind = 'crew', input = stopInput(), port = PORT, env = {}, args } = {}) {
  return new Promise((resolve) => {
    const argv = [HOOK, ...(args || ['--name', name, '--kind', kind])];
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, ENGLOOP_LOOP_GUARD_DIR: GUARD, ENGLOOP_JOURNAL_DIR: JOURNAL, ENGLOOP_PORT: String(port), ENGLOOP_ADMIN_TOKEN_FILE: TOKEN_FILE, ...env },
    });
    let stderr = '', stdout = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => { stdout += d; });
    const t0 = Date.now();
    child.on('close', (status) => resolve({ status, stderr, stdout, ms: Date.now() - t0 }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

const reset = (name) => {
  for (const f of [lg.pausedFile(name, GUARD), lg.stoppedFile(name, GUARD), lg.stateFile(name, GUARD)]) fs.rmSync(f, { force: true });
  fs.rmSync(path.join(JOURNAL, `${name}.jsonl`), { force: true });
};
const stoppedOf = (name) => lg.readStopped(name, { dir: GUARD });

/** 往假日志里追加一次 Bash 调用（intent ＋ outcome），时刻可控。 */
let tid = 0;
function journalCall(name, { command, startMs, endMs, ok: good = true, tool = 'Bash' }) {
  const id = `toolu_s1b_${++tid}`;
  const intent = { phase: 'intent', tool_use_id: id, tool_name: tool, input_summary: JSON.stringify({ command, timeout: 600000 }), session_id: 's', at: new Date(startMs).toISOString() };
  const out = { phase: 'outcome', tool_use_id: id, tool_name: tool, ok: good, session_id: 's', at: new Date(endMs).toISOString() };
  fs.appendFileSync(path.join(JOURNAL, `${name}.jsonl`), `${JSON.stringify(intent)}\n${JSON.stringify(out)}\n`);
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  console.log(`\nloop_guard（假 bus 在 127.0.0.1:${PORT}）\n`);

  console.log('【1】默认拦：exit 2，stderr 里是**它该跑的那条** poller 命令');
  {
    reset('lgdev');
    const r = await runHook({ name: 'lgdev', kind: 'crew' });
    const want = `node ${path.join(ROOT, 'bin', 'next.js')} --group agent:lgdev --consumer lgdev-1 --streams agent:lgdev:in --name lgdev > ${path.join(ROOT, 'temp', 'poll-lgdev.json')}`;
    ok(r.status === 2, 'crew：exit 2（拦）', `status=${r.status} ${r.stderr}`);
    ok(r.stderr.includes(want), 'crew：stderr 带 templates/<type>/CLAUDE.md 第 1 步那条命令（组 / 流走 roster，重定向到 temp/poll-<name>.json）', r.stderr);
    ok(!/ENGLOOP_AGENT_TYPE=/.test(r.stderr), 'crew：**不带** ENGLOOP_AGENT_TYPE 前缀（agent-start 注入了；模板写着不带前缀跑）');
    ok(r.stdout === '', 'stdout 是空的（Stop hook 的 stdout JSON 会被当成决定）', r.stdout);
    ok(lg.readState('lgdev', { dir: GUARD }).blocks === 1, '计数 = 1');
    ok(stoppedOf('lgdev') === null, '拦的时候不写 .stopped');

    reset('JARVIS');
    const o = await runHook({ name: 'JARVIS', kind: 'orchestrator' });
    ok(o.status === 2 && o.stderr.includes(`ENGLOOP_AGENT_TYPE=orchestrator node ${path.join(ROOT, 'bin', 'next.js')}`),
      '编排者：exit 2，命令带 ENGLOOP_AGENT_TYPE=orchestrator 前缀、不带 --group（next.js 默认组就是 orch）', o.stderr);
    ok(!o.stderr.includes('--group'), '编排者：不带 crew 那套参数');

    reset('lgdev');
    const sha = await runHook({ name: 'lgdev', input: stopInput({ stop_hook_active: true }) });
    ok(sha.status === 2, '★ stop_hook_active=true **照样拦**（不像 stop_check 那样见它就放 —— 被拦过一次之后它一直是 true）', sha.stderr);
    reset('lgdev');
    const junk = await runHook({ name: 'lgdev', input: 'not json' });
    ok(junk.status === 2, 'stdin 不是 JSON 也照常判（名字在命令行上，不用 stdin 的字段做决定）');
    ok(r.ms < 5000, `一次判定 < 5 秒（实际 ${r.ms} ms；配置里 timeout 10 秒）`);
  }

  console.log('\n【2】放行 ①：暂停标记');
  {
    reset('lgdev');
    lg.setPaused('lgdev', { dir: GUARD, by: 'test' });
    const before = bus.requests.length;
    const r = await runHook({ name: 'lgdev' });
    ok(r.status === 0, '有暂停标记 ⇒ exit 0', r.stderr);
    ok((stoppedOf('lgdev') || {}).reason === 'paused', '.stopped 原因 = paused', JSON.stringify(stoppedOf('lgdev')));
    ok(bus.requests.length === before, '暂停时不去问 bus（不必要的网络）');
  }

  console.log('\n【3】放行 ②：bus 不在（/health 不通 / ok 不是 true）');
  {
    reset('lgdev');
    const p = await deadPort();
    const r = await runHook({ name: 'lgdev', port: p });
    ok(r.status === 0 && (stoppedOf('lgdev') || {}).reason === 'bus_down', '端口没人听 ⇒ exit 0，原因 bus_down', `${r.status} ${r.stderr}`);
    ok(r.ms < 4000, `bus 不在时也快（实际 ${r.ms} ms）`);
    reset('lgdev');
    bus.health = { ok: false, redis: 'down' };
    const r2 = await runHook({ name: 'lgdev' });
    bus.health = { ok: true, redis: 'pong' };
    ok(r2.status === 0 && (stoppedOf('lgdev') || {}).reason === 'bus_down', '/health 答了但 ok:false（Redis 不通）⇒ 也当 bus_down 放行（poller 跑不起来）', r2.stderr);
  }

  console.log('\n【4】放行 ③：bus 侧它在关停');
  {
    reset('lgdev');
    bus.pending.add('lgdev');
    const r = await runHook({ name: 'lgdev' });
    ok(r.status === 0 && (stoppedOf('lgdev') || {}).reason === 'shutdown', 'pending ⇒ exit 0，原因 shutdown', r.stderr);
    reset('lgdev');
    const r2 = await runHook({ name: 'lgdev', input: stopInput({ stop_hook_active: true }) });
    ok(r2.status === 0, '关停中、stop_hook_active=true 也放（关停流程不能被卡住）');
    bus.pending.delete('lgdev');
    reset('lgother');
    bus.pending.add('lgdev');
    const r3 = await runHook({ name: 'lgother' });
    bus.pending.delete('lgdev');
    ok(r3.status === 2, '关停的是别人 ⇒ 照样拦（按名字查，不是「有人在关停」就放）');
  }

  console.log('\n【5】放行 ④：连续拦到上限（BLOCK_LIMIT = 3）—— 回到 poller 才清零');
  {
    reset('lgdev');
    const codes = [];
    for (let i = 0; i < lg.BLOCK_LIMIT + 1; i++) codes.push((await runHook({ name: 'lgdev' })).status);
    ok(codes.join(',') === '2,2,2,0', `连拦 ${lg.BLOCK_LIMIT} 次、第 ${lg.BLOCK_LIMIT + 1} 次放行（实际 ${codes.join(',')}）`);
    ok((stoppedOf('lgdev') || {}).reason === 'limit', '.stopped 原因 = limit');
    const after = (await runHook({ name: 'lgdev' })).status;
    ok(after === 2 && stoppedOf('lgdev') === null, '放行后从零数（又拦，而且拦的时候清掉旧的 .stopped）');

    // 回到过 poller ⇒ 清零
    reset('lgdev');
    await runHook({ name: 'lgdev' });
    await runHook({ name: 'lgdev' });   // blocks = 2
    const t = Date.now();
    // 时刻：在上一次拦（< t）之后、下一次拦（> t）之前 —— 写成 t+50 的话会落在下一次拦**之后**，把那次也清零
    journalCall('lgdev', { command: `node ${ROOT}/bin/next.js --group agent:lgdev --consumer lgdev-1 > x`, startMs: t - 20, endMs: t });
    const codes2 = [];
    for (let i = 0; i < lg.BLOCK_LIMIT + 1; i++) codes2.push((await runHook({ name: 'lgdev' })).status);
    ok(codes2.join(',') === '2,2,2,0', `★ 中间真跑过一次 poller（ok）⇒ 计数清零，又能连拦 ${lg.BLOCK_LIMIT} 次（实际 ${codes2.join(',')}）`);

    // poller 启动即崩（不 ok、几十毫秒）⇒ 不算
    reset('lgdev');
    await runHook({ name: 'lgdev' });
    await runHook({ name: 'lgdev' });
    await runHook({ name: 'lgdev' });   // blocks = 3
    const t2 = Date.now();
    journalCall('lgdev', { command: `node ${ROOT}/bin/next.js`, startMs: t2 + 10, endMs: t2 + 60, ok: false });
    ok((await runHook({ name: 'lgdev' })).status === 0, '★ poller 启动即崩（outcome 不 ok、60 ms）⇒ **不算**回到 poller ⇒ 照样到上限放行（防 poller 坏了时的死循环）');

    // 被 Bash 超时掐掉的长阻塞（不 ok、但待了 ≥ 30 秒）⇒ 算
    reset('lgdev');
    for (let i = 0; i < 3; i++) await runHook({ name: 'lgdev' });
    const t3 = Date.now();
    journalCall('lgdev', { command: `ENGLOOP_AGENT_TYPE=orchestrator node bin/next.js`, startMs: t3 - 200_000, endMs: t3 + 20, ok: false });
    ok((await runHook({ name: 'lgdev' })).status === 2, '★ 失败但在 poller 上待了 ≥ 30 秒（被 Bash 超时掐掉）⇒ 算回到过 ⇒ 清零、接着拦');

    // 别的 Bash 不算；上次拦**之前**的 poll 不算
    reset('lgdev');
    const t4 = Date.now();
    journalCall('lgdev', { command: `node ${ROOT}/bin/next.js`, startMs: t4 - 100, endMs: t4 - 50 });
    for (let i = 0; i < 3; i++) await runHook({ name: 'lgdev' });
    journalCall('lgdev', { command: 'git status', startMs: Date.now() + 5, endMs: Date.now() + 10 });
    journalCall('lgdev', { command: `node ${ROOT}/bin/next.js`, startMs: Date.now() + 5, endMs: Date.now() + 10, tool: 'Read' });
    ok((await runHook({ name: 'lgdev' })).status === 0, '上次拦之前的 poll、别的 Bash 命令、非 Bash 工具里的同一串字 ⇒ 都不算');
  }

  console.log('\n【6】放行 ⑤：意外 ⇒ 放（hook 坏了不能把 agent 卡死）');
  {
    reset('lgdev');
    const r = await runHook({ name: 'lgdev', env: { ENGLOOP_PORT: 'not-a-port' } });
    ok(r.status === 0 && (stoppedOf('lgdev') || {}).reason === 'unexpected', 'ENGLOOP_PORT 不合法（port-registry 抛）⇒ exit 0，原因 unexpected', `${r.status} ${r.stderr}`);
    reset('lgdev');
    const r2 = await runHook({ name: 'lgdev', env: { ENGLOOP_ADMIN_TOKEN_FILE: path.join(TMP, 'nope.token') } });
    ok(r2.status === 0 && (stoppedOf('lgdev') || {}).reason === 'unexpected', '读不到 admin token ⇒ 查不了关停状态 ⇒ 放行（unexpected），不是拦', r2.stderr);
    reset('lgdev');
    bus.shutdownStatus = 500;
    const r3 = await runHook({ name: 'lgdev' });
    bus.shutdownStatus = null;
    ok(r3.status === 0 && (stoppedOf('lgdev') || {}).reason === 'unexpected', '关停状态查询返回 500 ⇒ 放行（unexpected）', r3.stderr);
    const r4 = await runHook({ args: ['--name', '../x', '--kind', 'crew'] });
    ok(r4.status === 0, '--name 不合格（路径穿越）⇒ 放行', r4.stderr);
    const r5 = await runHook({ args: [] });
    ok(r5.status === 0, '没有 --name ⇒ 放行');
    reset('lgdev');
    fs.mkdirSync(GUARD, { recursive: true });
    fs.writeFileSync(lg.stateFile('lgdev', GUARD), '{垃圾');
    ok((await runHook({ name: 'lgdev' })).status === 2, '计数文件坏了 ⇒ 当 0（照常拦，不崩）');
  }

  console.log('\n【7】lib：stoppedVerdict（watchdog 快速兜底的判据，纯函数）');
  {
    const now = 10_000_000;
    const S = (reason, ago) => ({ at: now - ago, reason });
    const V = (o) => lg.stoppedVerdict({ now, minIdle: 600_000, ...o });
    ok(V({ stopped: S('limit', 61_000) }).nudge === true, 'limit、61 秒、没再读队列 ⇒ 推');
    ok(V({ stopped: S('unexpected', 61_000) }).nudge === true, 'unexpected ⇒ 推');
    // ⚠️ 用跟上面推的那两格**同样**的 61 秒 / idle 600 秒 —— 只差原因这一个变量（换成 600 秒的标记会先撞上 polled_since，原因判据就测不到了）
    for (const r of ['paused', 'shutdown', 'bus_down']) ok(V({ stopped: S(r, 61_000) }).why === `reason_${r}`, `${r} ⇒ 不推（因为原因，不是别的）`);
    ok(V({ stopped: S('limit', 59_000) }).why === 'too_fresh', '不到 60 秒 ⇒ 不推（too_fresh）');
    ok(V({ stopped: S('limit', 61_000), paused: true }).why === 'paused', '暂停了 ⇒ 不推');
    ok(V({ stopped: S('limit', 61_000), shuttingDown: true }).why === 'shutting_down', '在关停 ⇒ 不推');
    ok(V({ stopped: S('limit', 61_000), minIdle: 30_000 }).why === 'polled_since', '标记之后读过队列（idle 30 秒 < 标记 61 秒）⇒ 不推');
    ok(V({ stopped: S('limit', 61_000), minIdle: null }).nudge === true, '从没读过队列（idle null）⇒ 推');
    ok(V({ stopped: S('limit', 61_000), outboxIdle: 10_000 }).why === 'active_since', '标记之后写过 outbox（新回合在干活）⇒ 不推');
    ok(V({ stopped: S('limit', 61_000), outboxIdle: 60_000 }).nudge === true, 'outbox 最后一次活动在标记前后 2 秒内（回合最后一个动作）⇒ 仍推');
    ok(V({ stopped: null }).nudge === false, '没有标记 ⇒ 不推');
  }

  console.log('\n【8】bin/agent-pause.js');
  {
    const env = { ...process.env, ENGLOOP_LOOP_GUARD_DIR: GUARD };
    const run = (...a) => spawnSync(process.execPath, [PAUSE, ...a], { env, encoding: 'utf8' });
    reset('lgp');
    const on = run('lgp');
    ok(on.status === 0 && lg.isPaused('lgp', { dir: GUARD }), '<name> ⇒ 放标记', on.stdout + on.stderr);
    const list = run('--list');
    ok(list.status === 0 && /lgp/.test(list.stdout), '--list 列出来', list.stdout);
    const none = run();
    ok(none.status === 0 && /lgp/.test(none.stdout), '不带参数 = --list');
    const off = run('lgp', '--off');
    ok(off.status === 0 && !lg.isPaused('lgp', { dir: GUARD }), '--off ⇒ 撤掉', off.stdout);
    ok(/没有 agent 在暂停/.test(run('--list').stdout), '撤完 --list 为空');
    ok(run('../x').status === 2 && run('a', 'b').status === 2 && run('a', '--bogus').status === 2, '不合格的名字 / 两个名字 / 不认识的参数 ⇒ exit 2');
  }

  console.log('\n【9】挂载矩阵（lib/agent-settings.js）');
  {
    const S = require('../lib/agent-settings');
    const R = '/fake/engloop';
    const stopCmds = (s) => (s.hooks.Stop || []).flatMap((e) => e.hooks.map((h) => ({ cmd: h.command, timeout: h.timeout })));
    const LG = /^node "\/fake\/engloop\/hooks\/loop_guard\.js" --name (\S+) --kind (crew|orchestrator)$/;
    const cases = [
      { kind: 'crew', name: 'dev', type: 'dev', cwd: '/w/dev', want: ['stop_check', 'loop_guard'], k: 'crew' },
      // 没有写能力、有 Bash 的 crew：挂（「不管有没有写能力」）
      { kind: 'crew', name: 'ts', type: 'test', cwd: '/w/ts', want: ['loop_guard'], k: 'crew' },
      // 没有 Bash 的 crew：不挂（跑不了 poller，拦回去只是空耗）
      { kind: 'crew', name: 'ev', type: 'eval', cwd: '/w/ev', want: [] },
      { kind: 'crew', name: 'rv', type: 'review', cwd: '/w/rv', want: [] },
      { kind: 'orchestrator', name: 'JARVIS', type: 'orchestrator', cwd: R, want: ['loop_guard'], k: 'orchestrator' },
      { kind: 'worker', name: 'worker-solve', type: 'solve', cwd: '/proj', want: [] },
      { kind: 'worker', name: 'worker-review', type: 'review', cwd: '/proj', want: [] },
    ];
    for (const c of cases) {
      const s = S.buildAgentSettings({ ...c, root: R });
      const cmds = stopCmds(s);
      const got = cmds.map((x) => (x.cmd.includes('stop_check.js') ? 'stop_check' : x.cmd.includes('loop_guard.js') ? 'loop_guard' : x.cmd));
      ok(got.join(',') === c.want.join(','), `${c.kind}/${c.type}：Stop = [${c.want.join(', ') || '无'}]`, got.join(','));
      const lgc = cmds.find((x) => x.cmd.includes('loop_guard.js'));
      if (c.want.includes('loop_guard')) {
        const m = LG.exec(lgc.cmd);
        ok(m && m[1] === c.name && m[2] === c.k && lgc.timeout === 10, `${c.kind}/${c.type}：命令 node <root>/hooks/loop_guard.js --name ${c.name} --kind ${c.k}，timeout 10`, lgc.cmd);
      }
    }
    const dev = S.buildAgentSettings({ kind: 'crew', name: 'dev', type: 'dev', cwd: '/w/dev', root: R });
    ok(dev.hooks.Stop[0].hooks[0].command.includes('stop_check.js'), 'stop_check 仍在 Stop[0]（别处按下标引用它）');
    // ★ 暂停标记放在 crew 写不到的地方（R3）：不在 sandbox allowWrite 的任何一项下面，也不在 Edit allow 下面
    const guard = path.join(R, 'temp', 'loop-guard');
    const under = (p, dir) => p === dir || p.startsWith(`${dir}/`);
    for (const type of ['dev', 'eval', 'test', 'solve', 'write', 'review']) {
      const s = S.buildAgentSettings({ kind: 'crew', name: 'q', type, cwd: '/w/q', root: R });
      const aw = s.sandbox.filesystem.allowWrite;
      const edits = s.permissions.allow.filter((a) => a.startsWith('Edit(')).map((a) => a.slice('Edit(/'.length, -1).replace(/\/\*\*$/, ''));
      ok(!aw.some((d) => under(guard, d) || under(d, guard)) && !edits.some((d) => under(guard, d)),
        `${type}：temp/loop-guard/ 不在 sandbox 写集、也不在 Edit allow 里（agent 不能自己给自己放暂停）`, JSON.stringify(aw));
    }
  }

  server.close();
  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
