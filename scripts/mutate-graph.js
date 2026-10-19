'use strict';

/**
 * 任务图的**源码级内存变异**：把判据 / 调度的关键一行在内存里删掉（或改掉），
 * 要求**指定的那条**判据变红。一个字节都不落盘（`scripts/_srcmut-hook.js`）。
 *
 * 判档跟 `scripts/mutate-bus-auth.js` 一样：
 *   ✅ killed     指定的那条（label 子串）出现在 `✗` 行里，且跑到了总结行
 *   ⚠️ crashed    没有总结行（进程崩了 / 超时）—— **不算 killed**
 *   🔴 survived   跑完了，而指定的那条仍是 `✓`
 *
 * 用法：node scripts/mutate-graph.js            全部
 *       node scripts/mutate-graph.js E1 U3      只跑这几个
 *
 * ⚠️ 端到端那份每跑一次 ~45 秒（有的变异会让后面的等待超时，更久），全部跑完约 15 分钟。不进 run-all。
 * ⚠️ 每跑一次端到端都会 provision `workers/eval/`（已知副作用），跑完 `git checkout -- workers/`。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(__dirname, '_srcmut-hook.js');
const F = (p) => path.join(ROOT, p);
const UNIT = 'test/graph.test.js';
const E2E = 'test/graph-e2e.test.js';
const RUNNER = 'test/graph-runner.test.js';
const GJ = 'lib/graph.js';
const GR = 'lib/graph-runner.js';

const MUTANTS = [
  // ── 纯函数（单元判据）──
  { id: 'U1', what: 'graph.js：pickDispatch 不查 touches 冲突',
    file: GJ, from: 'if (pair) { clash = { o, pair }; break; }', to: 'if (false) { clash = { o, pair }; break; }',
    test: UNIT, expect: '★ x(lib/) 和 y(lib/x.js)' },
  { id: 'U2', what: 'graph.js：touches 重叠按字符串前缀比（不按路径段）',
    file: GJ, from: 'return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);', to: 'return x === y || x.startsWith(y) || y.startsWith(x);',
    // ⚠️ 指定的是 `lib/a` vs `lib/ab` 那条，不是 `lib/a.js` vs `lib/ab.js` 那条 ——
    //   后者对这个变异没有分辨力（变异会活下来，见 test/graph.test.js【2】的注释）。
    test: UNIT, expect: '★ `lib/a` vs `lib/ab` ⇒ 不冲突' },
  { id: 'U3', what: 'graph.js：依赖 produced 就算满足（不等 verified）',
    file: GJ, from: '.every((d) => states[d] && states[d].state === S.VERIFIED);',
    to: '.every((d) => states[d] && [S.VERIFIED, S.PRODUCED].includes(states[d].state));',
    test: UNIT, expect: '★ b 只是 produced' },
  { id: 'U4', what: 'graph.js：不报环',
    file: GJ, from: "if (cycle) errors.push(err(cycle[0], 'depends_on', `有环：${cycle.join(' → ')}`));", to: '',
    test: UNIT, expect: '环 a→c→b→a' },
  { id: 'U5', what: 'graph.js：insideDir 不查 ..',
    file: GJ, from: "return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);", to: "return r !== '';",
    test: UNIT, expect: 'produces ../x.md 越出目录' },
  { id: 'U6', what: 'worker-pool.js：结果一律回 orch:in:agent（不投回调度器）',
    file: 'lib/worker-pool.js', from: "await q.send(redis, graphStream || 'orch:in:agent', {", to: "await q.send(redis, 'orch:in:agent', {",
    test: UNIT, expect: '★ 调度器在册 ⇒ 结果进' },
  // ── 调度器（不起 bus 的那份）──
  { id: 'R1', what: 'graph-runner.js：超时不判 failed',
    file: GR, from: 'if (elapsed >= limit * G.TIMEOUT_FAIL_FACTOR) {', to: 'if (false) {',
    test: RUNNER, expect: '★ 15 分钟' },
  { id: 'R2', what: 'graph-runner.js：账号撞墙不暂停',
    file: GR, from: 'if (g.meta.status === GS.RUNNING && acct) {', to: 'if (false) {',
    test: RUNNER, expect: '★ 编排者 rate_limited' },
  { id: 'R3', what: 'graph-runner.js：agent 撞额度照样派',
    file: GR, from: 'if (await rateLimited(n.assignee)) return', to: 'if (false) return',
    test: RUNNER, expect: '★ p1 被 watchdog 判 rate_limited' },
  { id: 'R4', what: 'graph-runner.js：不在册照样派',
    file: GR, from: 'if (!target || !target.agent) return { ok: false, why: `${n.assignee} 不在花名册', to: 'if (false) return { ok: false, why: `${n.assignee} 不在花名册',
    test: RUNNER, expect: '★ ghost 不在册' },
  { id: 'R5', what: 'graph-runner.js：没写 verify 时不问 defaultVerify（接口断了）',
    file: GR, from: 'const cmd = v.cmd || fallbackVerify(g, nid);', to: 'const cmd = v.cmd;',
    test: RUNNER, expect: '★ 节点没写 verify ⇒ 跑 defaultVerify' },
  // ── 端到端判据 ──
  { id: 'E1', what: 'graph.js：子节点 kind 不查',
    file: GJ, from: "if (n && n.kind !== 'work') {", to: 'if (false) {',
    test: E2E, expect: '★ ① 子节点 kind:"crew"' },
  { id: 'E2', what: 'graph.js：申请人不必是 assignee',
    file: GJ, from: '} else if (sender.from !== parent.assignee) {', to: '} else if (false) {',
    test: E2E, expect: '★ ③ 发件人 gother' },
  { id: 'E3', what: 'graph.js：深度不查',
    file: GJ, from: 'if (depth > limits.max_depth) {', to: 'if (false) {',
    test: E2E, expect: '★ ② 深度 2' },
  { id: 'E4', what: 'graph.js：不要求 agent 章（名字对就行）',
    file: GJ, from: "if (!sender || sender.sender_type !== 'agent') {", to: 'if (false) {',
    test: E2E, expect: '★ 自称 gcrew、没有 agent 章' },
  { id: 'E5', what: 'graph.js：人工闸不看 kind:crew',
    file: GJ, from: 'if (crews.length) return { needed: true', to: 'if (false) return { needed: true',
    test: E2E, expect: '★ 等了 4 个 tick' },
  { id: 'E6', what: 'graph.js：pickDispatch 不查 touches 冲突（端到端那条）',
    file: GJ, from: 'if (pair) { clash = { o, pair }; break; }', to: 'if (false) { clash = { o, pair }; break; }',
    test: E2E, expect: '★ gt：x(lib/) 和 y(lib/x.js)' },
  { id: 'E7', what: 'graph-runner.js：父节点不等子节点',
    file: GR, from: '    if (!kids.done) {\n', to: '    if (false) {\n',
    test: E2E, expect: '★ d 在跑' },
  { id: 'E8', what: 'graph-runner.js：没挂上的 SUBPLAN.json 不挡产出',
    file: GR, from: 'if (kids.total === 0 && fs.existsSync(path.join(g.meta.dir, nid, SUBPLAN_FILE))) {', to: 'if (false) {',
    test: E2E, expect: '★ d 挂上之前' },
  { id: 'E9', what: 'graph-runner.js：调度器把「派过谁」记在进程内存里（重启就忘）',
    file: GR,
    spec: [
      { from: '{ attempt, job_id, dispatched_at: iso(), reminded_at: null, result: null, result_note: null, redo_why: null });',
        to: '{ attempt, job_id, dispatched_at: iso(), reminded_at: null, result: null, result_note: null, redo_why: null });\n'
          + '    (globalThis.__graphMem = globalThis.__graphMem || new Set()).add(job_id);' },
      { from: 'for (const nid of g.order) if (g.states[nid].state === S.DISPATCHED) await checkDispatched(g, nid);',
        to: 'for (const nid of g.order) if (g.states[nid].state === S.DISPATCHED) {'
          + ' if (!(globalThis.__graphMem && globalThis.__graphMem.has(g.states[nid].job_id))) { await dispatch(g, nid); continue; }'
          + ' await checkDispatched(g, nid); }' },
    ],
    test: E2E, expect: '★ 重启后 gcrew 没有再收到 c 的派活' },
  { id: 'E10', what: 'graph-runner.js：状态转移不广播',
    file: GR, from: "await say(g, `${nid}: ${from || '∅'} → ${to} · ${why}`);", to: '',
    test: E2E, expect: '★ gm：log 里' },
  { id: 'E11', what: 'graph-runner.js：派给 agent 的活不盖 system 章',
    file: GR, from: "text: crewDispatchText(g, n, { attempt, redo: redoWhy }),\n          agent_type: 'graph', job_id, ...stamp.SYSTEM,",
    to: "text: crewDispatchText(g, n, { attempt, redo: redoWhy }),\n          agent_type: 'graph', job_id,",
    test: E2E, expect: '★ 盖的是 system 章' },
  { id: 'E12', what: 'graph-runner.js：PLAN.json 被改了照样跑 verify',
    file: GR, from: 'if (md5 !== g.meta.plan_md5) {', to: 'if (false) {',
    test: E2E, expect: '★ gx：PLAN.json 跑到一半被改' },
  { id: 'E13', what: 'worker-pool.js：结果一律回 orch:in:agent（端到端那条）',
    file: 'lib/worker-pool.js', from: "await q.send(redis, graphStream || 'orch:in:agent', {", to: "await q.send(redis, 'orch:in:agent', {",
    test: E2E, expect: '★ a、b 的两条结果都在' },
];

function runOne(m) {
  const specs = (m.spec || [{ from: m.from, to: m.to }]).map((s) => ({ file: F(m.file), from: s.from, to: s.to }));
  const env = { ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${HOOK}`.trim(),
    ENGLOOP_SRCMUT: JSON.stringify(specs) };
  const r = spawnSync('node', [F(m.test)], { cwd: ROOT, env, encoding: 'utf8', timeout: 900_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const summary = /通过 \d+ · 失败 \d+/.exec(out);
  const red = out.split('\n').filter((l) => /^\s*✗/.test(l));
  const hit = red.some((l) => l.includes(m.expect));
  const verdict = !summary ? 'crashed' : hit ? 'killed' : 'survived';
  return { verdict, summary: summary ? summary[0] : `（无总结行，exit ${r.status}）`, red: red.length,
    first: (red.find((l) => l.includes(m.expect)) || red[0] || '').trim().slice(0, 140),
    tail: summary ? '' : out.slice(-400) };
}

const pick = process.argv.slice(2);
const list = pick.length ? MUTANTS.filter((m) => pick.includes(m.id)) : MUTANTS;
let killed = 0;
for (const m of list) {
  const r = runOne(m);
  if (r.verdict === 'killed') killed += 1;
  const icon = { killed: '✅', crashed: '⚠️', survived: '🔴' }[r.verdict];
  console.log(`${icon} ${m.id} ${r.verdict.padEnd(8)} ${m.what}`);
  console.log(`     ${path.basename(m.test)}：${r.summary} · 红 ${r.red} 条 · 指定那条：${r.first || '（没红）'}`);
  if (r.tail) console.log(`     ${r.tail.replace(/\n/g, '\n     ')}`);
}
console.log(`\n变异 ${list.length} 个 · 被指定判据杀掉 ${killed} 个`);
process.exit(killed === list.length ? 0 : 1);
