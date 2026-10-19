'use strict';

/**
 * 任务图的纯函数判据（校验、冲突判定、阈值）
 * ＋ worker 结果的路由（单元那一半）。
 *
 * 端到端（真 bus、假 claude、agent 替身）在 `test/graph-e2e.test.js`。
 *
 * ⚠️ 两种常见的假绿，这里都避开了：
 *   · 断言不查源码字符串（不会命中注释里的同一个串）
 *   · 不用 `indexOf(...) < indexOf(...)` 比先后（-1 恒小于任何位置）
 */

const q = require('../lib/queue');
const roster = require('../lib/roster');
const G = require('../lib/graph');
const { startPool } = require('../lib/worker-pool');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RES = ['JARVIS', G.SCHEDULER_NAME];

/** 一个合法节点，按需覆盖字段。 */
function node(id, over = {}) {
  return {
    id, title: `节点 ${id}`, kind: 'work', assignee: 'eval', depends_on: [],
    brief: `做 ${id}`, produces: `${id}/OUT.md`, requires: ['## 结论'], touches: [], timeout_min: 5,
    ...over,
  };
}
function plan(nodes, over = {}) {
  return { id: 'g1', goal: '测试', limits: { max_parallel: 2, max_depth: 2, max_nodes: 12 }, nodes, ...over };
}
const errsOf = (r) => r.errors.map((e) => `${e.node}/${e.field}: ${e.message}`).join(' | ');
const has = (r, field, re) => r.errors.some((e) => e.field === field && re.test(e.message));

async function main() {
  console.log('\n【1】PLAN.json 校验：环、悬空依赖、越目录、重复 id');
  {
    const good = G.validatePlan(plan([node('a'), node('b', { depends_on: ['a'] })]), { reserved: RES });
    ok(good.ok, '正控：两个节点、一条依赖 ⇒ 过', errsOf(good));

    const cyc = G.validatePlan(plan([node('a', { depends_on: ['c'] }), node('b', { depends_on: ['a'] }), node('c', { depends_on: ['b'] })]), { reserved: RES });
    ok(!cyc.ok && has(cyc, 'depends_on', /有环：/), '环 a→c→b→a ⇒ 拒，错误里说「有环」', errsOf(cyc));
    const cycMsg = (cyc.errors.find((e) => /有环/.test(e.message)) || {}).message || '';
    ok(['a', 'b', 'c'].every((x) => cycMsg.includes(x)), '环的路径里三个节点都在', cycMsg);
    const self = G.validatePlan(plan([node('a', { depends_on: ['a'] })]), { reserved: RES });
    ok(!self.ok && has(self, 'depends_on', /自己/), '自依赖 ⇒ 拒', errsOf(self));

    const dang = G.validatePlan(plan([node('a', { depends_on: ['ghost'] })]), { reserved: RES });
    ok(!dang.ok && dang.errors.some((e) => e.node === 'a' && e.field === 'depends_on' && /ghost/.test(e.message)),
      '悬空依赖 ⇒ 拒，指到节点 a 的 depends_on、说出 ghost', errsOf(dang));

    for (const bad of ['../x.md', '/etc/passwd', 'a/../../x.md']) {
      const r = G.validatePlan(plan([node('a', { produces: bad })]), { reserved: RES });
      ok(!r.ok && r.errors.some((e) => e.node === 'a' && e.field === 'produces'), `produces ${bad} 越出目录 ⇒ 拒`, errsOf(r));
    }
    const bf = G.validatePlan(plan([node('a', { brief: undefined, brief_file: '../../secret.md' })]), { reserved: RES });
    ok(!bf.ok && bf.errors.some((e) => e.field === 'brief_file'), 'brief_file 越出目录 ⇒ 拒', errsOf(bf));

    const dup = G.validatePlan(plan([node('a'), node('a', { produces: 'x/Y.md' })]), { reserved: RES });
    ok(!dup.ok && has(dup, 'id', /重复/), '重复 id ⇒ 拒', errsOf(dup));
    const dupP = G.validatePlan(plan([node('a', { produces: 'same/OUT.md' }), node('b', { produces: 'same/OUT.md' })]), { reserved: RES });
    ok(!dupP.ok && has(dupP, 'produces', /同一个文件/), '两个节点同一个产出文件 ⇒ 拒', errsOf(dupP));

    const many = G.validatePlan(plan([node('a'), node('b'), node('c')], { limits: { max_parallel: 1, max_depth: 1, max_nodes: 2 } }), { reserved: RES });
    ok(!many.ok && has(many, 'nodes', /max_nodes=2/), '节点数 > max_nodes ⇒ 拒', errsOf(many));

    const noLimits = G.validatePlan(plan([node('a')], { limits: undefined }), { reserved: RES });
    ok(!noLimits.ok && noLimits.errors.some((e) => e.field === 'limits'), '没有 limits ⇒ 拒（不给默认值）', errsOf(noLimits));
    const noTouch = G.validatePlan(plan([node('a', { touches: undefined })]), { reserved: RES });
    ok(!noTouch.ok && noTouch.errors.some((e) => e.field === 'touches'), '没写 touches ⇒ 拒（不默认成 []，那会让它跟谁都能并行）', errsOf(noTouch));
    const typo = G.validatePlan(plan([node('a', { depend_on: ['x'] })]), { reserved: RES });
    ok(!typo.ok && typo.errors.some((e) => e.field === 'depend_on'), '拼错的字段（depend_on）⇒ 拒，不静默忽略', errsOf(typo));
    const orch = G.validatePlan(plan([node('a', { kind: 'crew', assignee: 'JARVIS' })]), { reserved: RES });
    ok(!orch.ok && orch.errors.some((e) => e.field === 'assignee'), 'kind:crew 的 assignee 是编排者 ⇒ 拒', errsOf(orch));
    const wt = G.validatePlan(plan([node('a', { assignee: 'nosuchtype' })]), { reserved: RES });
    ok(!wt.ok && wt.errors.some((e) => e.field === 'assignee'), 'kind:work 的类型没登记 ⇒ 拒', errsOf(wt));
    const longWork = G.validatePlan(plan([node('a', { timeout_min: 30 })]), { reserved: RES });
    ok(!longWork.ok && longWork.errors.some((e) => e.field === 'timeout_min'), 'kind:work 的 timeout_min > 10 ⇒ 拒（会撞 worker 的重投窗口）', errsOf(longWork));
    ok(/节点 a 的 depends_on/.test(G.formatErrors(dang.errors)), 'formatErrors 指到「节点 a 的 depends_on」', G.formatErrors(dang.errors));
  }

  console.log('\n【2】touches 前缀重叠');
  {
    ok(G.touchPairOverlaps('lib/', 'lib/x.js') === true, '`lib/` vs `lib/x.js` ⇒ 冲突');
    ok(G.touchPairOverlaps('lib/x.js', 'lib') === true, '`lib/x.js` vs `lib` ⇒ 冲突（方向无关、末尾斜杠无关）');
    ok(G.touchPairOverlaps('lib/a.js', 'lib/ab.js') === false, '`lib/a.js` vs `lib/ab.js` ⇒ **不**冲突（比路径段，不比字符串前缀）');
    // ⚠️ 上面那条例子**对「按字符串前缀比」的实现没有分辨力**：
    //   'lib/ab.js'.startsWith('lib/a.js') 本来就是 false（第 6 个字符 b ≠ .）——
    //   `scripts/mutate-graph.js` 的变异 U2 换成字符串前缀，那条照样绿。真正能把两种实现分开的是下面这两条。
    ok(G.touchPairOverlaps('lib/a', 'lib/ab') === false, '★ `lib/a` vs `lib/ab` ⇒ 不冲突（这条才分得开「路径段」和「字符串前缀」）');
    ok(G.touchPairOverlaps('lib/a', 'lib/ab/c.js') === false, '`lib/a` vs `lib/ab/c.js` ⇒ 不冲突');
    ok(G.touchPairOverlaps('./bin/serve.js', 'bin/serve.js') === true, '`./bin/serve.js` vs `bin/serve.js` ⇒ 冲突（同一个文件）');
    ok(G.touchPairOverlaps('.', 'web/app.js') === true, '`.`（整个仓库）跟任何东西冲突');
    ok(G.touchesOverlap([], ['lib/']) === null, '只读节点（[]）跟谁都不冲突');
    const pair = G.touchesOverlap(['docs/a.md', 'lib/relay.js'], ['bin/', 'lib/']);
    ok(Array.isArray(pair) && pair[0] === 'lib/relay.js' && pair[1] === 'lib/', '报出是哪一对重叠', JSON.stringify(pair));
    ok(G.normTouch('../x') === null && G.normTouch('/abs') === null, '`..` / 绝对路径 ⇒ 不合法');
  }

  console.log('\n【3】ready 集合 ＋ 这一 tick 派谁');
  {
    const nodes = {
      a: { ...node('a'), touches: ['lib/a.js'] },
      b: { ...node('b'), touches: ['lib/ab.js'] },
      c: { ...node('c', { kind: 'crew', assignee: 'dev', depends_on: ['a', 'b'] }), touches: ['lib/'] },
    };
    const st = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { state: v }]));
    let ready = G.depsSatisfied(nodes, st({ a: 'pending', b: 'pending', c: 'pending' }));
    ok(ready.join(',') === 'a,b', '开局：a、b 没依赖 ⇒ ready 候选；c 不在', ready.join(','));
    ready = G.depsSatisfied(nodes, st({ a: 'verified', b: 'produced', c: 'pending' }));
    ok(!ready.includes('c'), '★ b 只是 produced（没 verified）⇒ c 仍不在 ready', ready.join(','));
    ready = G.depsSatisfied(nodes, st({ a: 'verified', b: 'verified', c: 'pending' }));
    ok(ready.join(',') === 'c', 'a、b 都 verified ⇒ c 进 ready', ready.join(','));

    const p1 = G.pickDispatch({ nodes, states: st({ a: 'ready', b: 'ready', c: 'pending' }), maxParallel: 2, candidates: ['a', 'b'] });
    ok(p1.dispatch.join(',') === 'a,b', '★ a、b touches 不重叠（lib/a.js vs lib/ab.js）⇒ 同一 tick 一起派', JSON.stringify(p1));

    const clash = {
      x: { ...node('x'), touches: ['lib/'] },
      y: { ...node('y'), touches: ['lib/x.js'] },
    };
    const p2 = G.pickDispatch({ nodes: clash, states: st({ x: 'ready', y: 'ready' }), maxParallel: 2, candidates: ['x', 'y'] });
    ok(p2.dispatch.join(',') === 'x' && /touches 跟 x/.test(p2.held.y || ''), '★ x(lib/) 和 y(lib/x.js) 无依赖但重叠 ⇒ 只派 x，y 说清在等 x', JSON.stringify(p2));
    const p3 = G.pickDispatch({ nodes: clash, states: st({ x: 'dispatched', y: 'ready' }), maxParallel: 2, candidates: ['y'] });
    ok(p3.dispatch.length === 0, 'x 已经 dispatched ⇒ y 这一轮仍不派', JSON.stringify(p3));
    const p3b = G.pickDispatch({ nodes: clash, states: st({ x: 'produced', y: 'ready' }), maxParallel: 2, candidates: ['y'] });
    ok(p3b.dispatch.length === 0, 'x produced（等验收、可能被打回）⇒ y 仍不派', JSON.stringify(p3b));
    const p4 = G.pickDispatch({ nodes: clash, states: st({ x: 'verified', y: 'ready' }), maxParallel: 2, candidates: ['y'] });
    ok(p4.dispatch.join(',') === 'y', 'x verified ⇒ y 派出', JSON.stringify(p4));

    const three = { a: node('a'), b: node('b'), c: node('c') };
    const p5 = G.pickDispatch({ nodes: three, states: st({ a: 'dispatched', b: 'ready', c: 'ready' }), maxParallel: 2, candidates: ['b', 'c'] });
    ok(p5.dispatch.join(',') === 'b' && /max_parallel=2/.test(p5.held.c || ''), 'max_parallel=2：已有 1 个在跑 ⇒ 只再派 1 个', JSON.stringify(p5));

    // 子节点：touches 是父节点的子集，但跟父节点**不算冲突**（父节点在等它）
    const fam = { c: { ...node('c', { kind: 'crew', assignee: 'dev' }), touches: ['src/c/'] }, d: { ...node('d'), touches: ['src/c/d.js'], parent: 'c' } };
    const p6 = G.pickDispatch({ nodes: fam, states: st({ c: 'dispatched', d: 'ready' }), maxParallel: 2, candidates: ['d'] });
    ok(p6.dispatch.join(',') === 'd', '子节点 d 跟父节点 c 的 touches 重叠，但父子不算冲突 ⇒ d 派出', JSON.stringify(p6));
    const r6 = G.depsSatisfied(fam, st({ c: 'pending', d: 'pending' }));
    ok(!r6.includes('d'), '父节点还没 dispatched ⇒ 子节点不进 ready', r6.join(','));
    ok(G.childrenDone(fam, st({ c: 'dispatched', d: 'dispatched' }), 'c').done === false
      && G.childrenDone(fam, st({ c: 'dispatched', d: 'verified' }), 'c').done === true, 'childrenDone：子节点 verified 前 false、之后 true');
  }

  console.log('\n【4】子图申请：越界一律拒');
  {
    const nodes = {
      c: { ...node('c', { kind: 'crew', assignee: 'gcrew' }), touches: ['src/c/'], parent: null, depth: 1 },
    };
    const states = { c: { state: 'dispatched' } };
    const limits = { max_parallel: 2, max_depth: 2, max_nodes: 6 };
    const sender = { from: 'gcrew', sender_type: 'agent' };
    const child = (over = {}) => ({ ...node('d', { produces: 'd/OUT.md', touches: ['src/c/d.js'] }), ...over });
    const run = (sub, o = {}) => G.validateSubplan({ sub, parentId: 'c', nodes, states, limits, sender, reserved: RES, ...o });

    const good = run({ nodes: [child()] });
    ok(good.ok && good.depth === 2, '正控：一个 work 子节点、touches 是子集 ⇒ 过（深度 2）', errsOf(good));
    const crewKid = run({ nodes: [child({ kind: 'crew', assignee: 'dev' })] });
    ok(!crewKid.ok && crewKid.errors.some((e) => e.field === 'kind' && e.bound), '★ 子节点 kind:"crew" ⇒ 拒，标为越界', errsOf(crewKid));
    const deep = run({ nodes: [child()] }, { limits: { ...limits, max_depth: 1 } });
    ok(!deep.ok && deep.errors.some((e) => e.field === 'depth' && e.bound), '★ 深度超 max_depth ⇒ 拒，标为越界', errsOf(deep));
    const other = run({ nodes: [child()] }, { sender: { from: 'gother', sender_type: 'agent' } });
    ok(!other.ok && other.errors.some((e) => e.field === 'sender' && e.bound && /gother/.test(e.message)), '★ 发件人不是 assignee ⇒ 拒', errsOf(other));
    const human = run({ nodes: [child()] }, { sender: { from: 'gcrew', sender_type: 'unknown' } });
    ok(!human.ok && human.errors.some((e) => e.field === 'sender'), '★ 名字对、但没有 agent 章（直接 XADD 的）⇒ 拒', errsOf(human));
    const wide = run({ nodes: [child({ touches: ['lib/'] })] });
    ok(!wide.ok && wide.errors.some((e) => e.field === 'touches' && e.bound), 'touches 不是父节点的子集 ⇒ 拒', errsOf(wide));
    const prefixTrap = run({ nodes: [child({ touches: ['src/cc/x.js'] })] });
    ok(!prefixTrap.ok, '`src/cc/x.js` 不在 `src/c/` 里（路径段，不是字符串前缀）⇒ 拒', errsOf(prefixTrap));
    const verify = run({ nodes: [child({ verify: 'rm -rf /' })] });
    ok(!verify.ok && verify.errors.some((e) => e.field === 'verify' && e.bound), '子节点带 verify（会在 bus 里执行）⇒ 拒', errsOf(verify));
    const tooMany = run({ nodes: [child(), child({ id: 'e', produces: 'e/O.md' })] }, { limits: { ...limits, max_nodes: 2 } });
    ok(!tooMany.ok && tooMany.errors.some((e) => e.field === 'nodes' && e.bound), '全图节点数超 max_nodes ⇒ 拒', errsOf(tooMany));
    const notRunning = run({ nodes: [child()] }, { states: { c: { state: 'verified' } } });
    ok(!notRunning.ok && notRunning.errors.some((e) => e.field === 'state'), '父节点不在 dispatched ⇒ 拒', errsOf(notRunning));
    const extraKey = run({ nodes: [child()], limits: { max_depth: 9 } });
    ok(!extraKey.ok, 'SUBPLAN 里自带 limits ⇒ 拒（limits 只能编排者定）', errsOf(extraKey));
  }

  console.log('\n【5】人工闸阈值');
  {
    ok(G.needsApproval([node('a', { kind: 'crew', assignee: 'dev' })]).needed === true, '有 kind:crew ⇒ 要批');
    const five = ['a', 'b', 'c', 'd', 'e'].map((x) => node(x));
    ok(G.needsApproval(five).needed === false, '5 个 work ⇒ 自动开跑');
    ok(G.needsApproval([...five, node('f')]).needed === true, '6 个 work ⇒ 要批');
  }

  console.log('\n【6】worker 结果的路由：调度器在册 ⇒ 回它的收件流，不进 orch:in:agent');
  {
    const redis = q.createClient();
    const STREAM = 'work:eval';
    const SINK = roster.inboxFor(G.SCHEDULER_NAME, G.SCHEDULER_TYPE);
    await redis.del(STREAM, 'orch:in:agent', SINK, roster.KEY(G.SCHEDULER_NAME));
    await q.ensureGroup(redis, STREAM, STREAM);
    const fake = async (t) => ({ ok: true, ms: 5, output: `## 结论\n输出 ${t.text}` });
    // ★ 池用**自己的连接**：它在里面跑 BLOCK 5000 的阻塞读，跟测试共用一条的话，
    //   测试的每次 XADD / XRANGE 都排在它后面等 5 秒（bus 主连接那条注释讲的同一件事）
    const poolRedis = q.createClient();
    const pool = startPool(poolRedis, { type: 'eval', concurrency: 1, runner: fake, onLog: () => {} });
    const fieldsOf = (row) => { const o = {}; for (let i = 0; i < row[1].length; i += 2) o[row[1][i]] = row[1][i + 1]; return o; };
    const waitFor = async (stream, jobId) => {
      for (let i = 0; i < 80; i++) {
        const rows = (await redis.xrange(stream, '-', '+')).map(fieldsOf);
        const hit = rows.find((r) => r.job_id === jobId);
        if (hit) return hit;
        await wait(50);
      }
      return null;
    };

    // ① 调度器**不在**册 ⇒ 退回老路（编排者看得见）—— 这是「必须登记」那条的反面
    const j0 = `graph:t:a:${Date.now()}`;
    await q.send(redis, STREAM, { from: G.SCHEDULER_NAME, text: 'x0', job_id: j0 });
    const r0 = await waitFor('orch:in:agent', j0);
    ok(r0 && !r0.result_output, '调度器不在册 ⇒ 结果退回 orch:in:agent（老路，而那条流会被 bus 推到网页）', JSON.stringify(r0));

    // ② 在册 ⇒ 回调度器自己的收件流
    await roster.register(redis, G.SCHEDULER_NAME, { type: G.SCHEDULER_TYPE, tmux_session: '' });
    const j1 = `graph:t:b:${Date.now()}`;
    await q.send(redis, STREAM, { from: G.SCHEDULER_NAME, text: 'x1', job_id: j1 });
    const r1 = await waitFor(SINK, j1);
    ok(r1 && r1.result_ok === '1' && r1.result_output === '## 结论\n输出 x1', `★ 调度器在册 ⇒ 结果进 ${SINK}，带原样输出`, JSON.stringify(r1));
    ok(r1 && r1.sender_type === 'agent', '结果带 agent 章（worker 的回报）');
    await wait(200);
    const leaked = (await redis.xrange('orch:in:agent', '-', '+')).map(fieldsOf).find((r) => r.job_id === j1);
    ok(!leaked, '★ 同一条结果**没有**出现在 orch:in:agent', JSON.stringify(leaked));

    // ③ 阴性对照：别人（JARVIS）派的活照旧回 orch:in:agent —— 证明上面那条不是「全部都改道了」
    const j2 = `plain-${Date.now()}`;
    await q.send(redis, STREAM, { from: 'JARVIS', text: 'x2', job_id: j2 });
    const r2 = await waitFor('orch:in:agent', j2);
    ok(r2 && r2.result_output === undefined, '阴性对照：JARVIS 派的活 ⇒ 仍回 orch:in:agent，payload 不多字段', JSON.stringify(r2));

    // ④ 冒名：一个 type 不是 graph 的条目叫 GRAPH ⇒ 不改道（按花名册的类型判，不按名字）
    await roster.register(redis, G.SCHEDULER_NAME, { type: 'dev', tmux_session: '' });
    const j3 = `graph:t:c:${Date.now()}`;
    await q.send(redis, STREAM, { from: G.SCHEDULER_NAME, text: 'x3', job_id: j3 });
    const r3 = await waitFor('orch:in:agent', j3);
    ok(Boolean(r3), '花名册里叫 GRAPH 但类型不是 graph ⇒ 不改道', JSON.stringify(r3));

    await pool.stop();
    await redis.del(STREAM, 'orch:in:agent', SINK, roster.KEY(G.SCHEDULER_NAME));
    await poolRedis.quit();
    await redis.quit();
  }

  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log(`\n  通过 ${pass} · 失败 ${fail + 1}`); process.exit(1); });
