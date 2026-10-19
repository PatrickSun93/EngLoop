'use strict';

/**
 * 崩溃恢复演示 —— v1 与 v2 的核心差异，跑一遍就看明白。
 *
 * v1（文件总线）：delete 就是 claim。brain 在 unlink 之后、真正处理之前
 * 被 kill -9 → 那条消息**永久消失，且没有任何记录**。
 *
 * v2（Redis Streams）：领取和确认是两件事。没 ack 的消息滞留 PEL，
 * 超时后被 XAUTOCLAIM 重投，并带上 redelivered 标记。
 *
 * 跑：node test/crash-recovery-demo.js
 */

const q = require('../lib/queue');

const S = 'engloop:demo:orch:in:human';
const G = 'demo-orch';
const IDLE = 1500; // 演示用短超时；生产是 60s

const line = (c = '─') => console.log('  ' + c.repeat(56));

async function main() {
  const r = q.createClient();
  await r.del(S);

  console.log('\n场景：用户让 agent 部署，agent 领走消息后进程被 kill -9\n');
  line('═');

  // ── 用户发消息
  const sent = await q.send(r, S, {
    from: 'Patrick',
    text: '把 shipflow 部署到生产',
    agent_type: 'orchestrator',
  });
  console.log(`  ① 用户发出   job_id=${sent.job_id.slice(0, 8)}…`);

  // ── agent 领走
  const got = await q.claimNext(r, {
    streams: S, group: G, consumer: 'orch-1', blockMs: 500,
  });
  console.log(`  ② agent 领走 「${got[0].text}」`);

  // ── 崩溃：没有 ack
  console.log('  ③ 💥 kill -9 —— 消息已领走但【未确认】');
  const p = await q.pending(r, S, G);
  console.log(`     PEL 待确认: ${p.count} 条  ← v1 在这一刻消息已经没了`);

  line();
  console.log('  v1 的结局：文件已 unlink，消息永久消失，无任何记录');
  console.log('  v2 的结局：↓');
  line();

  // ── 新实例接手
  await new Promise((res) => setTimeout(res, IDLE + 200));
  const rescued = await q.autoclaim(r, {
    stream: S, group: G, consumer: 'orch-2', minIdleMs: IDLE,
  });

  if (rescued.length === 0) {
    console.log('  ✗ 没捞回来（不该发生）');
  } else {
    const m = rescued[0];
    console.log(`  ④ 新实例启动，自动捞回 ${rescued.length} 条`);
    console.log(`     「${m.text}」`);
    console.log(`     redelivered = ${m.redelivered}   job_id = ${m.job_id.slice(0, 8)}…`);
    line();
    console.log('  ⚠️  但这带来一个义务：');
    console.log('     「部署」被重投了 —— 如果第一次已经部署成功，');
    console.log('     现在会部署第二次。**重投一条部署比丢掉它更糟。**');
    console.log(`     所以有副作用的 handler 必须先用 job_id 查重。`);
    console.log('     （protocols/poll_rules.md 第 3、4 条就是写这个的）');
  }

  line('═');
  await q.ack(r, S, G, rescued.map((m) => m.id));
  await r.del(S);
  await r.quit();
  console.log();
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
