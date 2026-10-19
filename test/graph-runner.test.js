'use strict';

/**
 * 调度器（`lib/graph-runner.js`）里端到端那份**不方便造**的几条路：
 *   · 超时：先提醒（带原文）、只提醒一次，再超一半 ⇒ failed ＋ 上报编排者
 *   · 限流：某个 agent 撞额度 ⇒ 不给它派；编排者撞额度（= 账号撞墙）⇒ 整张图暂停，恢复后接着跑
 *   · assignee 不在册 ⇒ 不派，而且**不当成人投给网页**
 *   · 起图的几种拒绝（重复 id、id ≠ 目录名、目录不在根下）
 *
 * 不起 bus：直接拿测试库造一个 runner，时钟注入（超时那几条不用真等 15 分钟）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const watchdog = require('../lib/watchdog');
const { createRunner } = require('../lib/graph-runner');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const ROOT = path.join(__dirname, '..');
const fieldsOf = ([id, f]) => { const o = { id }; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1]; return o; };

async function main() {
  const redis = q.createClient();
  await redis.flushdb();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-graph-runner-'));
  const root = path.join(tmp, 'graphs');
  fs.mkdirSync(root);
  process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

  await roster.register(redis, 'JARVIS', { type: 'orchestrator', tmux_session: '' });
  await roster.register(redis, 'p1', { type: 'dev', tmux_session: '' });

  let T = Date.parse('2026-10-09T10:00:00Z');
  const logs = [];
  const runner = createRunner({ redis, orchName: 'JARVIS', graphsRoot: root, repoRoot: ROOT, defaultVerify: null, now: () => T, onLog: (m) => logs.push(m) });
  const P = { username: 'Patrick', via: 'session', can_manage_workers: true };

  const crewNode = (id, assignee, over = {}) => ({
    id, title: id, kind: 'crew', assignee, depends_on: [], brief: `做 ${id}`,
    produces: `${id}/R.md`, requires: ['## 结论'], touches: [], timeout_min: 10, ...over,
  });
  const plan = (id, nodes) => {
    const d = path.join(root, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'PLAN.json'), JSON.stringify({ id, goal: id, limits: { max_parallel: 2, max_depth: 2, max_nodes: 6 }, nodes }));
    return d;
  };
  const state = async (gid, nid) => JSON.parse(await redis.hget(`graph:${gid}:state`, nid));
  const inbox = async (s) => (await redis.xrange(s, '-', '+')).map(fieldsOf);

  console.log('\n【1】起图的拒绝');
  {
    const d = plan('ga', [crewNode('n', 'p1')]);
    const r = await runner.start(d, P);
    ok(r.status === 'awaiting_approval', '有 kind:crew ⇒ awaiting_approval', JSON.stringify(r));
    const again = await runner.start(d, P).catch((e) => e);
    ok(again.code === 'GRAPH_EXISTS' && again.status === 409, '同一个 id 再起 ⇒ 409 GRAPH_EXISTS', again.message);
    const mis = path.join(root, 'gb');
    fs.mkdirSync(mis);
    fs.writeFileSync(path.join(mis, 'PLAN.json'), JSON.stringify({ id: 'not-gb', goal: 'x', limits: { max_parallel: 1, max_depth: 1, max_nodes: 1 }, nodes: [crewNode('n', 'p1')] }));
    const e2 = await runner.start(mis, P).catch((e) => e);
    ok(e2.code === 'PLAN_INVALID' && /目录名/.test(e2.message), 'PLAN 的 id ≠ 目录名 ⇒ PLAN_INVALID', e2.message);
    const out = fs.mkdtempSync(path.join(tmp, 'outside-'));
    fs.writeFileSync(path.join(out, 'PLAN.json'), '{}');
    const e3 = await runner.start(out, P).catch((e) => e);
    ok(e3.code === 'DIR_OUT_OF_ROOT', '目录不在 graphsRoot 下 ⇒ DIR_OUT_OF_ROOT', e3.message);
  }

  console.log('\n【2】超时：提醒一次（带原文）⇒ 再超一半 ⇒ failed ＋ 上报');
  {
    await runner.approve('ga', P);
    await runner.tick();
    let s = await state('ga', 'n');
    ok(s.state === 'dispatched' && s.attempt === 1, 'n 派出去了', JSON.stringify([s.state, s.attempt]));
    const before = (await inbox('agent:p1:in')).length;
    T += 9 * 60_000;
    await runner.tick();
    ok((await inbox('agent:p1:in')).length === before, '9 分钟（< timeout_min 10）⇒ 不提醒');
    T += 1 * 60_000;
    await runner.tick();
    let msgs = await inbox('agent:p1:in');
    const rem = msgs.slice(before);
    ok(rem.length === 1 && /⏰ 提醒/.test(rem[0].text) && /做 n/.test(rem[0].text) && rem[0].sender_type === 'system',
      '★ 10 分钟 ⇒ 提醒一条，带原文（派活万一没发出去，这条就是补发），system 章', JSON.stringify(rem.map((m) => m.text.slice(0, 40))));
    await runner.tick();
    msgs = await inbox('agent:p1:in');
    ok(msgs.length === before + 1, '再一 tick ⇒ 不重复提醒');
    s = await state('ga', 'n');
    ok(s.state === 'dispatched', '提醒之后仍是 dispatched');
    T += 5 * 60_000;
    await runner.tick();
    s = await state('ga', 'n');
    ok(s.state === 'failed' && /超时/.test(s.why), '★ 15 分钟（= 10 × 1.5）⇒ failed', JSON.stringify([s.state, s.why]));
    const orch = (await inbox('orch:in:agent')).filter((m) => m.from === 'GRAPH');
    const f = orch.find((m) => /node=n/.test(m.text) && /failed/.test(m.text));
    ok(f && /graph_id=ga node=n/.test(f.text) && /bin\/graph\.js retry ga n/.test(f.text) && f.sender_type === 'system',
      '★ 上报编排者：带 graph_id ＋ node ＋ 可选动作（retry 的完整命令）', f && f.text.slice(0, 200));
    const r = await runner.retry('ga', 'n', P);
    ok(r.state === 'pending', 'retry ⇒ pending');
    await runner.tick();
    s = await state('ga', 'n');
    ok(s.state === 'dispatched' && s.attempt === 2 && s.job_id === 'graph:ga:n:2', '重派是第 2 次、换了 job_id', JSON.stringify([s.state, s.attempt, s.job_id]));
    const notRetry = await runner.retry('ga', 'n', P).catch((e) => e);
    ok(notRetry.code === 'NOT_RETRYABLE', 'dispatched 的节点不能 retry', notRetry.message);
  }

  console.log('\n【3】限流：agent 撞额度 ⇒ 不给它派；编排者撞额度 ⇒ 整张图暂停');
  {
    await runner.start(plan('gc', [crewNode('m', 'p1')]), P);
    await runner.approve('gc', P);
    await redis.set(watchdog.RL_SINCE_KEY('p1'), String(T));
    await runner.tick();
    let s = await state('gc', 'm');
    ok(s.state === 'pending' && /rate_limited/.test(s.hold || ''), '★ p1 被 watchdog 判 rate_limited ⇒ m 不派，hold 说清原因', JSON.stringify([s.state, s.hold]));
    await redis.del(watchdog.RL_SINCE_KEY('p1'));
    await runner.tick();
    s = await state('gc', 'm');
    ok(s.state === 'dispatched', 'p1 脱离 ⇒ m 派出', s.state);

    await runner.start(plan('gd', [crewNode('k', 'p1'), crewNode('k2', 'p1', { depends_on: ['k'] })]), P);
    await runner.approve('gd', P);
    await redis.set(watchdog.RL_SINCE_KEY('JARVIS'), String(T));
    await runner.tick();
    let meta = JSON.parse(await redis.get('graph:gd:meta'));
    s = await state('gd', 'k');
    ok(meta.status === 'paused' && s.state === 'pending', '★ 编排者 rate_limited（= 账号撞墙）⇒ 图 paused，节点不派', JSON.stringify([meta.status, s.state]));
    await redis.del(watchdog.RL_SINCE_KEY('JARVIS'));
    await runner.tick();
    meta = JSON.parse(await redis.get('graph:gd:meta'));
    s = await state('gd', 'k');
    ok(meta.status === 'running' && s.state === 'dispatched', '恢复 ⇒ running，接着派', JSON.stringify([meta.status, s.state]));
  }

  console.log('\n【4】assignee 不在册 ⇒ 不派，也不当成人投给网页');
  {
    const r = await runner.start(plan('ge', [crewNode('g', 'ghost')]), P);
    ok(r.not_in_roster_now.join(',') === 'ghost', 'start 的返回里说出现在不在册的 agent', JSON.stringify(r.not_in_roster_now));
    await runner.approve('ge', P);
    const outBefore = (await inbox('orch:out')).length;
    await runner.tick();
    const s = await state('ge', 'g');
    ok(s.state === 'pending' && /不在花名册/.test(s.hold || ''), '★ ghost 不在册 ⇒ g 停在 pending，hold 说清', JSON.stringify([s.state, s.hold]));
    ok((await inbox('orch:out')).length === outBefore, '★ orch:out（发给人的流）里没有多出任何东西');
  }

  console.log('\n【5】调度器自己在册');
  {
    const rec = await roster.lookup(redis, 'GRAPH');
    ok(rec && rec.type === 'graph' && rec.stream === 'agent:GRAPH:in' && rec.tmux_session === '',
      'tick 之后 GRAPH 在花名册里（type graph、没有 tmux 会话 ⇒ watchdog 不会去 tmux 里打字）', JSON.stringify(rec));
  }

  console.log('\n【6】verify 的接口（verify_complete 从 defaultVerify 接上）');
  {
    const thrown = (() => { try { createRunner({ redis, orchName: 'JARVIS', graphsRoot: root, repoRoot: ROOT }); return null; } catch (e) { return e; } })();
    ok(thrown && /defaultVerify/.test(thrown.message), '不传 defaultVerify ⇒ 抛（「忘了接」和「决定不接(null)」要分得开）', thrown && thrown.message);
    const r2 = createRunner({
      redis, orchName: 'JARVIS', graphsRoot: root, repoRoot: ROOT, now: () => T, onLog: (m) => logs.push(m),
      defaultVerify: (n) => (n.id === 'q' ? 'echo default-verify-ran; exit 4' : null),
    });
    const d = plan('gf', [crewNode('q', 'p1')]);
    await r2.start(d, P);
    await r2.approve('gf', P);
    await r2.tick();
    fs.mkdirSync(path.join(d, 'q'), { recursive: true });
    fs.writeFileSync(path.join(d, 'q', 'R.md'), '## 结论\n做完了\n');
    await r2.tick();                       // dispatched → produced，并启动默认 verify
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 100));
      await r2.tick();
      if ((await state('gf', 'q')).attempt === 2) break;
    }
    const s = await state('gf', 'q');
    const log = (await redis.lrange('graph:gf:log', 0, -1)).map((x) => JSON.parse(x));
    ok(log.some((e) => e.to === 'rejected' && /default-verify-ran/.test(e.why)) && s.state === 'dispatched' && s.attempt === 2,
      '★ 节点没写 verify ⇒ 跑 defaultVerify 给的命令；退 4 ⇒ 打回、重派第 2 次', JSON.stringify([s.state, s.attempt]));
  }

  await redis.flushdb();
  await redis.quit();
  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log(`\n  通过 ${pass} · 失败 ${fail + 1}`); process.exit(1); });
