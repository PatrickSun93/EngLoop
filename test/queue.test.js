'use strict';

/**
 * 队列模块验收 —— 重点是那个「v1 会永久丢消息、v2 捞得回来」的差异。
 *
 * 跑：node test/queue.test.js
 */

const q = require('../lib/queue');

const S = 'engloop:test:orch:in:human';
const S2 = 'engloop:test:orch:in:agent';
const G = 'test-orch';

let pass = 0;
let fail = 0;

function ok(cond, label, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  → ' + detail : ''}`); }
}

async function main() {
  const r = q.createClient();
  await r.del(S, S2);

  console.log('\n【1】投递与领取');
  const sent = await q.send(r, S, { from: 'Patrick', text: 'hello', agent_type: 'orchestrator' });
  ok(!!sent.job_id, 'send 自动生成 job_id（幂等键 + 用量归因 join key）');

  const got = await q.claimNext(r, { streams: S, group: G, consumer: 'c1', blockMs: 1000 });
  ok(got.length === 1, '领到 1 条');
  ok(got[0].text === 'hello', '内容完整');
  ok(got[0].job_id === sent.job_id, 'job_id 贯通');

  console.log('\n【1b】额外字段必须透传（不是白名单）');
  // 用独立流 —— 上一版在这里 del(S) 清了主流，导致【2】的阻塞测试
  // 拿到了残留消息、0ms 就返回。测试之间不能共享可变状态。
  const SX = S + ':extra';
  await r.del(SX);
  await q.send(r, SX, { from: 'bus', text: '房间消息', room_hash: 'abc123', custom: 'x' });
  const extra = await q.claimNext(r, { streams: SX, group: 'gx', consumer: 'c', blockMs: 500 });
  ok(extra[0]?.room_hash === 'abc123', 'room_hash 透传到消费端');
  ok(extra[0]?.custom === 'x', '其它自定义字段也不丢');

  console.log('\n【2】阻塞超时返回空（对应 next.js 输出 {timeout:true}）');
  const t0 = Date.now();
  const none = await q.claimNext(r, { streams: S, group: G, consumer: 'c1', blockMs: 800 });
  const waited = Date.now() - t0;
  ok(none.length === 0, '没消息时返回空数组');
  ok(waited >= 700, `确实阻塞了（${waited}ms）`);

  console.log('\n【3】★ 消费者崩溃后消息不丢（v1 在这里永久丢失）');
  await q.send(r, S, { from: 'Patrick', text: 'deploy this', agent_type: 'orchestrator' });
  const claimed = await q.claimNext(r, { streams: S, group: G, consumer: 'crashy', blockMs: 500 });
  ok(claimed.length === 1, '消费者 crashy 领走');
  // 不 ack，模拟处理到一半进程被 kill -9
  const pend = await q.pending(r, S, G);
  ok(pend.count >= 1, `滞留在 PEL：${pend.count} 条`);

  await new Promise((res) => setTimeout(res, 1200));
  const rescued = await q.autoclaim(r, {
    stream: S, group: G, consumer: 'rescuer', minIdleMs: 1000,
  });
  const found = rescued.find((m) => m.text === 'deploy this');
  ok(!!found, '另一个消费者把它捞回来了');
  ok(found?.redelivered === true, '标记为 redelivered（幂等 handler 据此去重）');

  console.log('\n【4】ack 之后 PEL 清空');
  for (const m of rescued) await q.ack(r, S, G, m.id);
  await q.ack(r, S, G, claimed.map((m) => m.id));
  const after = await q.pending(r, S, G);
  ok(after.count === 0, `PEL 归零（剩 ${after.count}）`);

  console.log('\n【5】优先级 = 流顺序，不是进程内排序');
  await q.send(r, S2, { from: 'Flowie', text: 'crew chatter', agent_type: 'dev' });
  await q.send(r, S, { from: 'Patrick', text: 'human first', agent_type: 'orchestrator' });
  const ordered = await q.claimNext(r, {
    streams: [S, S2], group: G, consumer: 'c2', blockMs: 500,
  });
  ok(ordered[0]?.text === 'human first', '人类流排在 agent 流之前');
  ok(ordered.length === 2, `一次 drain 拿到两条（COUNT 批量，替代 v1 的 200ms 突发窗口）`);

  await r.del(S, S2, S + ':extra');
  await r.quit();

  console.log(`\n${'─'.repeat(46)}`);
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n✗ 测试异常:', e.message);
  process.exit(1);
});
