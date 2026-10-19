'use strict';

/**
 * 成本记账纯函数（lib/cost.js）
 *
 * ★ 这个文件守的核心不是「能算出数」，是那三个**算出来看着完全合理、
 *   但是错的**的数：
 *
 *   1. 不按 requestId 去重 → 成倍虚高（一次响应拆成多行落盘，
 *      每行带同一份完整 usage）
 *   2. 去重时保留第一条 → 全零记录会把真实用量整个抹掉
 *   3. 不按 cwd 过滤 → 把同一台机器上别的项目也算进来
 *
 *   三个都不会报错，都不会让测试变红，**都看起来像个正常的数字**。
 *
 * 真实数据的对账在 test/cost-groundtruth.js（花额度，手动跑）——
 * 那个证明「落盘的数没骗人」，这个证明「读它没读错」。两件事。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cost = require('../lib/cost');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const ROOT = '/repo';
const line = (o) => ({
  type: 'assistant', requestId: 'req_1', sessionId: 's1',
  cwd: ROOT, timestamp: '2026-08-10T00:00:00.000Z',
  message: { id: 'msg_1', model: 'claude-opus-5', usage: {} },
  ...o,
});
const usage = (input, output, cacheRead, cacheCreate) => ({
  input_tokens: input, output_tokens: output,
  cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate,
});
const entry = (o) => ({
  key: 'k', sessionId: 's1', cwd: ROOT, model: 'm', ts: '2026-08-10T00:00:00.000Z',
  isSidechain: false, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, ...o,
});

console.log('\n【1】parseUsageLine');
{
  const e = cost.parseUsageLine(line({ message: { id: 'msg_1', model: 'claude-opus-5', usage: usage(2, 269, 22258, 16120) } }));
  ok(e && e.output === 269 && e.input === 2, 'input/output 读出来');
  ok(e.cacheRead === 22258 && e.cacheCreate === 16120, 'cache 两个字段读出来');
  ok(e.model === 'claude-opus-5', 'model 带出来');

  ok(cost.parseUsageLine({ type: 'user', message: {} }) === null, '非 assistant → null');
  ok(cost.parseUsageLine(line({ message: { id: 'm', model: 'x' } })) === null, '没有 usage → null');
  ok(cost.parseUsageLine(null) === null, 'null 输入不炸');

  // requestId 缺失时退到 message.id —— 同一次响应的多行共享同一个 id，
  // 去重效果等价。
  const noReq = cost.parseUsageLine(line({ requestId: undefined, message: { id: 'msg_9', usage: usage(1, 1, 0, 0) } }));
  ok(noReq && noReq.key === 'msg_9', 'requestId 缺失时用 message.id 当 key');

  // ★ 只读 usage 顶层，不读 iterations —— 两个都读就是双倍计数。
  const withIter = cost.parseUsageLine(line({
    message: { id: 'm', usage: { ...usage(2, 100, 0, 0), iterations: [{ input_tokens: 2, output_tokens: 100 }] } },
  }));
  ok(withIter.output === 100, '★ 有 iterations 时仍只算顶层一次（不是 200）');

  // ★ <synthetic> 没发给 API，全机 193 条。token 是 0，但**调用次数会虚高** ——
  //   而那一列正是用来看「谁在频繁触发」的。
  ok(cost.parseUsageLine(line({ message: { id: 'm', model: '<synthetic>', usage: usage(0, 0, 0, 0) } })) === null,
    '★★ <synthetic> 不算一次 API 调用');
  // 而真实 model 的全零要留着 —— 它跟真实那条共享 requestId，由 dedupe 兜住
  const realZero = cost.parseUsageLine(line({ message: { id: 'm', model: 'claude-opus-5', usage: usage(0, 0, 0, 0) } }));
  ok(realZero !== null, '★ 真实 model 的全零记录保留（那是拆行，不是假调用）');
}

console.log('\n【2】dedupe —— 虚高 111.6% 的那一刀');
{
  // 一次响应拆成两行落盘（thinking 一行、tool_use 一行），usage 完全相同
  const rows = [
    entry({ key: 'req_A', output: 269, cacheRead: 22258 }),
    entry({ key: 'req_A', output: 269, cacheRead: 22258 }),
    entry({ key: 'req_B', output: 100, cacheRead: 300 }),
  ];
  const r = cost.dedupe(rows);
  ok(r.entries.length === 2, '同 requestId 的多行压成一条');
  ok(r.duplicateRows === 1, '报出压掉了几行');
  ok(r.entries.reduce((a, e) => a + e.output, 0) === 369,
    '★ 求和是 369 不是 638 —— 天真求和会翻倍', String(r.entries.reduce((a, e) => a + e.output, 0)));
  ok(r.conflicts.length === 0, 'usage 一致时不报冲突');
}

console.log('\n【3】dedupe 的全零陷阱 —— 正控抓出来的那个 bug');
{
  // 全机 20,036 个 key 里有 202 条全零记录（中断/失败的调用），
  // 它们跟真实记录**共享同一个 requestId**。
  const real = entry({ key: 'req_A', output: 4340, cacheRead: 990449, input: 2, cacheCreate: 235 });
  const zero = entry({ key: 'req_A' }); // 全零

  const a = cost.dedupe([zero, real]);
  ok(a.entries[0].output === 4340,
    '★★ 全零排在前面时，真实用量不能被抹掉', String(a.entries[0].output));

  const b = cost.dedupe([real, zero]);
  ok(b.entries[0].output === 4340, '★ 全零排在后面时同样保住');

  ok(a.conflicts.length === 0 && b.conflicts.length === 0,
    '全零不算冲突 —— 它是已知的、有解释的例外');

  // 而两条都非零且不同，那是真冲突：说明「同 key 则 usage 相同」这个
  // 前提破了，去重就在丢数据，必须报出来。
  const c = cost.dedupe([
    entry({ key: 'req_A', output: 100 }),
    entry({ key: 'req_A', output: 200 }),
  ]);
  ok(c.conflicts.length === 1, '★ 两条非零且不同 → 报冲突，不许静默');
  ok(c.entries[0].output === 200, '冲突时取大的，不丢数据');
}

console.log('\n【4】agentOf —— 虚高 213% 的那一刀');
{
  ok(cost.agentOf('/repo', ROOT) === 'JARVIS', '根目录 → JARVIS');
  ok(cost.agentOf('/repo/agents/dev2', ROOT) === 'dev2', 'agents/dev2 → dev2');
  ok(cost.agentOf('/repo/agents/dev3', ROOT) === 'dev3', 'agents/dev3 → dev3');
  ok(cost.agentOf('/repo/workers/eval', ROOT) === 'worker:eval', 'workers/eval → worker:eval');
  ok(cost.agentOf('/repo/experiments/07', ROOT) === 'path:experiments/07', '其它子目录 → path:<相对路径>');

  // ★ 这几条是「谁花的」这个问题的正确性所在
  ok(cost.agentOf('/other/project', ROOT) === null,
    '★★ 别的项目 → null（混进来是 213% 的虚高，而那个数看着完全合理）');
  ok(cost.agentOf('/repo-sibling/x', ROOT) === null,
    '★ 前缀相同但不是子目录 → null（字符串前缀匹配会在这里出错）');
  ok(cost.agentOf(null, ROOT) === null, 'cwd 缺失 → null');
  ok(cost.agentOf('/repo/crews', ROOT) === 'path:crews', 'crews 本身不是 agent');
}

console.log('\n【5】aggregate —— 四个字段分开，不许合成一个数');
{
  const rows = [
    entry({ key: 'a', cwd: '/repo', output: 100, cacheRead: 50000, input: 1, cacheCreate: 10 }),
    entry({ key: 'b', cwd: '/repo', output: 200, cacheRead: 60000, input: 2, cacheCreate: 20 }),
    entry({ key: 'c', cwd: '/repo/agents/dev2', output: 500, cacheRead: 10, input: 3, cacheCreate: 30 }),
  ];
  const byAgent = cost.aggregate(rows, { by: 'agent', root: ROOT });
  ok(byAgent.length === 2, '按 agent 分成两组');
  const jarvis = byAgent.find((r) => r.key === 'JARVIS');
  ok(jarvis.output === 300 && jarvis.calls === 2, 'JARVIS 累加正确');
  ok(jarvis.cacheRead === 110000 && jarvis.cacheCreate === 30, 'cache 两列独立累加');

  // ★ 这条守的是「只按 output 排名会误判谁在烧」：dev2 的 output 更大，
  //   但 JARVIS 的 cacheRead 大三个数量级。两列必须都在。
  const dev2 = byAgent.find((r) => r.key === 'dev2');
  ok(dev2.output > jarvis.output && dev2.cacheRead < jarvis.cacheRead,
    '★ output 排名和 cacheRead 排名可以相反 —— 所以四列都要出');

  ok(cost.aggregate(rows, { by: 'day' })[0].key === '2026-08-10', '按 day 分组用 ISO 前缀');
  ok(cost.aggregate(rows, { by: 'model' })[0].key === 'm', '按 model 分组');
  ok(cost.aggregate(rows, { by: 'session' })[0].key === 's1', '按 session 分组');

  let threw = false;
  try { cost.aggregate(rows, { by: '不存在' }); } catch (_) { threw = true; }
  ok(threw, '未知维度报错，不是静默返回空');

  // 外部项目在 agent 维度下归到一个显式的桶，不是被悄悄算进某个 agent
  const withOutside = cost.aggregate(
    [...rows, entry({ key: 'd', cwd: '/elsewhere', output: 999 })],
    { by: 'agent', root: ROOT });
  ok(withOutside.some((r) => r.key === '(外部项目)'), '★ 外部项目单独成桶，不混入任何 agent');
}

console.log('\n【6】checkContextConservation');
{
  const chain = (list) => list.map((c, i) => entry({
    key: `k${i}`, ts: `2026-08-10T00:0${i}:00.000Z`,
    input: c[0], output: c[1], cacheRead: c[2], cacheCreate: c[3],
  }));

  // 真实观察到的形状：next.cacheRead == prev.(cacheRead + cacheCreate)
  const good = cost.checkContextConservation(chain([
    [2, 164, 0, 40439], [2, 169, 40439, 238], [2, 228, 40677, 1484],
  ]));
  ok(good.checked === 2 && good.violations.length === 0, '连续命中缓存 → 无违例');

  // 上一轮的 output 进了下一轮的缓存 —— 小幅超出，正常，不判失败
  const minor = cost.checkContextConservation(chain([
    [2, 939, 448900, 1694], [2, 1075, 451603, 0],
  ]));
  ok(minor.violations.length === 0 && minor.minorExcess === 1,
    '★ 小幅超出记为 minorExcess，不是违例', JSON.stringify(minor));
  ok(minor.maxMinor === 68, '报出最大超出量', String(minor.maxMinor));

  // 成倍的超出 = 数量级异常
  const bigger = cost.checkContextConservation(chain([
    [2, 100, 100000, 1000], [2, 100, 300000, 0],
  ]));
  ok(bigger.violations.length === 1, '★ 超出 1.5 倍 → 违例（重复计数至少翻倍）');

  // ★ 全零记录不代表任何上下文状态，不能进守恒链 ——
  //   拿它推上限会得到「上限 0」，把之后每一条都误报成违例。
  const withZero = cost.checkContextConservation(chain([
    [2, 164, 989217, 1522], [0, 0, 0, 0], [2, 249, 25415, 39636],
  ]));
  ok(withZero.checked === 1, '★ 全零记录被跳过（否则会误报成违例）', String(withZero.checked));
  ok(withZero.violations.length === 0, '跳过后压缩导致的下降不误报');

  ok(cost.checkContextConservation([entry({ ts: null })]).checked === 0, '没有时间戳的不参与');
}

console.log('\n【7】liveSessions —— pid ↔ session ↔ cwd ↔ pane ↔ 名字');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-cost-sess-'));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({
    pid: process.pid, sessionId: 'sess-a', cwd: '/repo/agents/dev2',
    tmux: 'agent_dev2:@2.%2', name: 'dev2-98', kind: 'interactive', status: 'busy',
  }));
  // 一个几乎不可能存在的 pid → alive:false
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({
    pid: 999999, sessionId: 'sess-b', cwd: '/elsewhere', name: 'other-1',
  }));
  fs.writeFileSync(path.join(dir, '3.json'), '{半个 JSON');

  const rows = cost.liveSessions({ dir, root: ROOT });
  ok(rows.length === 2, '半写入的文件被跳过，不炸也不算数', String(rows.length));

  const me = rows.find((r) => r.sessionId === 'sess-a');
  ok(me.agent === 'dev2', 'cwd 映射成 agent 名');
  ok(me.tmux === 'agent_dev2:@2.%2', '★ tmux pane 带出来 —— watchdog 靠它把进程和名字硬接起来');
  ok(me.name === 'dev2-98', 'Claude Code 自己起的名也带出来');
  ok(me.alive === true, '活着的进程标 alive');

  const dead = rows.find((r) => r.sessionId === 'sess-b');
  ok(dead.alive === false, '★ 死进程如实报 alive:false，不是被过滤掉');
  ok(dead.agent === null, '不在 root 下的 → agent 为 null');

  ok(cost.liveSessions({ dir: '/不存在的目录' }).length === 0, '目录不存在时返回空数组，不抛');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n【8】readSessionFile / collect');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-cost-proj-'));
  const pd = path.join(dir, 'p1');
  fs.mkdirSync(pd);
  fs.writeFileSync(path.join(pd, 's1.jsonl'), [
    JSON.stringify(line({ requestId: 'r1', message: { id: 'm1', usage: usage(2, 100, 0, 500) } })),
    // 同一次响应的第二行 —— 同一份 usage
    JSON.stringify(line({ requestId: 'r1', message: { id: 'm1', usage: usage(2, 100, 0, 500) } })),
    JSON.stringify(line({ requestId: 'r2', cwd: '/repo/agents/dev2', message: { id: 'm2', usage: usage(1, 50, 500, 10) } })),
    JSON.stringify({ type: 'user', message: { role: 'user' } }),
    '{ 半行 JSON',                                    // 尾部半行是常态，不是损坏
    JSON.stringify(line({ requestId: 'r3', cwd: '/外部项目', message: { id: 'm3', usage: usage(9, 9999, 0, 0) } })),
  ].join('\n'));

  ok(cost.readSessionFile(path.join(pd, 's1.jsonl')).length === 4,
    '半行被跳过，不让整份统计崩掉');
  ok(cost.readSessionFile('/不存在的文件').length === 0, '文件不存在返回空，不抛');

  const r = cost.collect({ dir, root: ROOT });
  ok(r.entries.length === 2, '★ 去重 + 排除外部项目后剩 2 次调用', String(r.entries.length));
  ok(r.entries.reduce((a, e) => a + e.output, 0) === 150,
    '★★ 150 —— 不是 250（重复行）也不是 10149（外部项目）',
    String(r.entries.reduce((a, e) => a + e.output, 0)));

  const withAll = cost.collect({ dir, root: ROOT, all: true });
  ok(withAll.entries.length === 3, '--all 时外部项目才算进来');

  const since = cost.collect({ dir, root: ROOT, since: '2026-08-11' });
  ok(since.entries.length === 0, '--since 过滤按 ISO 前缀比较');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
