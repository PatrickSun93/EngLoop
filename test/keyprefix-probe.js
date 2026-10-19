'use strict';

/**
 * 探测：ioredis 的 keyPrefix 对 Redis Stream 命令到底生不生效。
 *
 * ── 这个脚本为什么留下来 ──────────────────────────────────────────
 * 【T】要在「测试 vs 测试」之间加一层隔离，候选之一是给每个测试进程一个
 * keyPrefix，测试文件零改动。但 keyPrefix 是 ioredis 按**命令的 key 位置
 * 定义**施加的，而流命令的 key 位置很特殊：XREADGROUP 的 key 在 STREAMS
 * 之后、还跟着同样数量的 ID；XAUTOCLAIM / XINFO 各有各的形状。
 *
 * 只要有一个命令不生效，方案就必须放弃 —— **半生效比完全不生效危险得多**：
 * 写进前缀空间、读的时候没前缀，症状是「命令全都不报错，数据就是对不上」。
 *
 * 结论会过期（升级 ioredis 就可能变），所以留下的是能重跑的探测，不是结论。
 * 文件名不带 .test.js —— run-all 不会跑它，它是手动工具。
 *   node test/keyprefix-probe.js
 * ────────────────────────────────────────────────────────────────
 *
 * ★ 方法上最要紧的一条：**用一个不带前缀的裸 client 去查真实 key 名。**
 *   「keyPrefix 没生效」的表现恰恰是命令一切正常 —— 只是读写都打在了没有
 *   前缀的那个 key 上，从带前缀的 client 视角完全看不出来。用出问题的那个
 *   视角去验证它自己，什么也验不出来。
 */

const Redis = require('ioredis');

// 用 db 14：避开生产（0）和测试库（15），跑这个脚本不会碰任何人的数据
const URL = process.env.ENGLOOP_PROBE_URL || 'redis://127.0.0.1:6379/14';
const PREFIX = `probe${process.pid}:`;
const S = 'probestream';        // 逻辑流名（带前缀的 client 眼里的名字）
const REAL = PREFIX + S;        // 真实 key 名（裸 client 眼里的名字）
const G = 'probegroup';

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

async function main() {
  const pre = new Redis(URL, { keyPrefix: PREFIX });
  const bare = new Redis(URL);
  await pre.ping();
  await bare.ping();
  await bare.del(REAL, S);

  console.log(`\n前缀 = ${PREFIX}   逻辑流名 = ${S}   期望真实 key = ${REAL}\n`);

  console.log('【1】XADD');
  const id1 = await pre.xadd(S, '*', 'n', '1');
  ok(await bare.exists(REAL) === 1, 'XADD 落在带前缀的 key 上');
  ok(await bare.exists(S) === 0, '★ 没有同时写出一个不带前缀的同名 key');

  console.log('\n【2】XGROUP CREATE');
  let groupOk = false;
  try {
    await pre.xgroup('CREATE', S, G, '0');
    const info = await bare.xinfo('GROUPS', REAL);
    groupOk = info.length === 1;
  } catch (e) {
    console.log(`    （异常：${e.message}）`);
  }
  ok(groupOk, 'XGROUP CREATE 把组建在带前缀的流上');

  console.log('\n【3】XREADGROUP —— key 在 STREAMS 之后，最可疑的一个');
  let read = null;
  try {
    read = await pre.xreadgroup('GROUP', G, 'c1', 'COUNT', 10, 'STREAMS', S, '>');
  } catch (e) {
    console.log(`    （异常：${e.message}）`);
  }
  ok(Array.isArray(read) && read.length === 1, 'XREADGROUP 读到了数据（说明 key 被加了前缀）');
  const gotEntries = read?.[0]?.[1] || [];
  ok(gotEntries.length === 1, `读到 ${gotEntries.length} 条，期望 1 条`);

  // ★ 这一条规格里没写，但它比前面几条更致命。
  //   ioredis 给请求加前缀，**不给响应剥前缀**。如果返回的流名带着前缀，
  //   而调用方（q.claimNext）把它当成流名存进 stream_id 再传回
  //   q.ack，ioredis 会**再加一次前缀** → probe:probe:stream → XACK 静默
  //   返回 0。那正是「半生效」最恶心的形态。
  const returnedName = read?.[0]?.[0];
  console.log(`    XREADGROUP 返回的流名 = ${JSON.stringify(returnedName)}`);
  const nameHasPrefix = returnedName === REAL;
  ok(returnedName === S,
    '★ 返回的流名不带前缀（否则回传给 XACK 会被二次加前缀）',
    nameHasPrefix ? `返回的是真实 key 名 ${REAL}，不是逻辑名 ${S}` : `返回了 ${returnedName}`);

  console.log('\n【4】XACK');
  const idRead = gotEntries[0]?.[0] || id1;
  const acked = await pre.xack(S, G, idRead);
  ok(acked === 1, 'XACK 生效（返回 1）');
  const pend = await bare.xpending(REAL, G, '-', '+', 10);
  ok(pend.length === 0, '带前缀的流上 PEL 真的清零了');

  console.log('\n【5】XAUTOCLAIM');
  await pre.xadd(S, '*', 'n', '2');
  await pre.xreadgroup('GROUP', G, 'c1', 'COUNT', 10, 'STREAMS', S, '>');
  let claimed = null;
  try {
    claimed = await pre.xautoclaim(S, G, 'c2', 0, '0');
  } catch (e) {
    console.log(`    （异常：${e.message}）`);
  }
  ok(Array.isArray(claimed) && (claimed[1] || []).length === 1, 'XAUTOCLAIM 捞到了带前缀流上的消息');

  console.log('\n【6】XINFO / XLEN / XRANGE');
  let infoOk = false;
  try {
    const st = await pre.xinfo('STREAM', S);
    infoOk = Array.isArray(st) && st.length > 0;
  } catch (e) {
    console.log(`    （异常：${e.message}）`);
  }
  ok(infoOk, 'XINFO STREAM 认得带前缀的流');
  ok(await pre.xlen(S) === 2, 'XLEN 数的是带前缀的流');
  ok((await pre.xrange(S, '-', '+')).length === 2, 'XRANGE 读的是带前缀的流');

  // ★ 后果演示。lib/queue.js 的 claimNext 第 153 行就是这么用的：
  //     for (const [stream, entries] of res)  →  messages.push({ stream, ... })
  //   那个 stream 会被 bin/next.js 拼成 stream_id 交给大脑，大脑原样回填，
  //   relay 拆出流名再调 q.ack —— 于是 ioredis 给一个**已经带前缀**的名字
  //   再加一次前缀。下面两条断言通过，意味着这条坏路径已被复现。
  console.log('\n【8】★ 把 XREADGROUP 返回的流名回传给 XACK（claimNext 的真实用法）');
  await pre.xadd(S, '*', 'n', '3');
  const r2 = await pre.xreadgroup('GROUP', G, 'c3', 'COUNT', 1, 'STREAMS', S, '>');
  const nameFromRead = r2[0][0];
  const id3 = r2[0][1][0][0];
  const ackedBack = await pre.xack(nameFromRead, G, id3);
  ok(ackedBack === 0, '坏行为已复现：回传返回的流名 → XACK 返回 0，不报错');
  const stillPending = await bare.xpending(REAL, G, '-', '+', 10);
  ok(stillPending.some((p) => p[0] === id3),
    '坏行为已复现：那条消息仍滞留 PEL —— 60 秒后无限重投，全程静默');

  console.log('\n【7】DEL —— 清理路径同样必须打在前缀空间里');
  await pre.del(S);
  ok(await bare.exists(REAL) === 0, 'DEL 删掉的是带前缀的 key');

  await bare.del(REAL, S);
  await pre.quit();
  await bare.quit();

  console.log(`\n${'─'.repeat(52)}\n  通过 ${pass} · 失败 ${fail}`);
  console.log(fail === 0
    ? '  → 请求方向全生效、响应方向也不带前缀：候选 A 可行\n'
    : `  → 候选 A 必须放弃。请求方向（XADD/XGROUP/XREADGROUP/XACK/XAUTOCLAIM/
    XINFO/XLEN/XRANGE/DEL）全都正确加了前缀，但**响应方向不剥前缀** ——
    XREADGROUP 返回的是真实 key 名。claimNext 把它当流名回传给 XACK，
    ioredis 会二次加前缀，XACK 静默返回 0，消息无限重投。
    这正是「半生效」最危险的形态：命令全不报错，数据就是对不上。\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e); process.exit(1); });
