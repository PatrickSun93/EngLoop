'use strict';

/**
 * 掉册留痕 —— 「它掉过册，被自愈救回来了」这件事必须在系统外部可见。
 *
 * ── 这个文件守的是什么 ──────────────────────────────────────────
 * agent 掉册时 `roster.heartbeat` 会自愈重建，`bin/next.js` 打一条警告 ——
 * **而那条警告只有 agent 自己的终端看得见**，人从外部看不出发生过什么。
 *
 * > **「救回来了」和「什么都没发生」在系统外部长得一模一样。**
 * > 而且自愈越可靠，这件事越隐蔽 —— 因为再也没有别的症状了。
 *
 * ★ 所以留痕不是日志洁癖，是自愈功能的**另一半**：
 *   一半把它救回来，另一半让人知道刚才需要救。
 *
 * 单跑：`node test/roster-dropout.test.js`
 */

const q = require('../lib/queue');
const roster = require('../lib/roster');

const AGENT = 'droptestcrew';

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

async function main() {
  const redis = q.createClient();
  await redis.del(roster.DROPOUT_KEY);
  await roster.unregister(redis, AGENT).catch(() => {});

  console.log('\n【1】★★ 自愈重建 → 必须留痕');
  {
    const before = await roster.dropouts(redis);
    ok(before.length === 0, '（前置）没有记录');

    const r = await roster.heartbeat(redis, AGENT, { type: 'dev', cwd: '/tmp' });
    ok(r === 'rebuilt', '不在册 + 有素材 → 自愈重建');

    const after = await roster.dropouts(redis);
    ok(after.length === 1, '★★ 留下了一条记录 —— 没有它，这次掉册在系统外部不存在');
    ok(after[0].name === AGENT && after[0].type === 'dev', '记了是谁、什么类型');
    ok(typeof after[0].detected_at === 'number', '记了发现时刻');
  }

  console.log('\n【2】★★ 只记「发现时刻」，且**明说**不知道掉了多久');
  {
    const [d] = await roster.dropouts(redis);
    ok(d.unknown_since === true,
      '★★ 带 unknown_since —— TTL 过期是静默的，系统**不知道**它从什么时候'
      + '开始不在册。编一个开始时间会让复盘的人算出一段假的失聪时长，'
      + '而那比没有记录更坏');
    ok(!('duration_ms' in d) && !('since' in d),
      '★ 而且真的没有任何字段假装知道时长', JSON.stringify(Object.keys(d)));
  }

  console.log('\n【3】阴性对照 —— 正常续期不留痕');
  {
    await redis.del(roster.DROPOUT_KEY);
    // 现在它在册了（上一段刚重建过），再心跳应该是 renewed。
    const r = await roster.heartbeat(redis, AGENT, { type: 'dev', cwd: '/tmp' });
    ok(r === 'renewed', '在册 → 续期');
    ok((await roster.dropouts(redis)).length === 0,
      '★★ 正常续期一条都不记 —— **一个每轮都记的检测器会让人对真记录脱敏**，'
      + '而这个记录的全部价值就在于它很少出现');
  }

  console.log('\n【4】★ need_info 那条路径不留痕 —— 它没救回来');
  {
    await redis.del(roster.DROPOUT_KEY);
    await roster.unregister(redis, AGENT);
    const r = await roster.heartbeat(redis, AGENT, { cwd: '/tmp' });   // 缺 type
    ok(r === 'need_info', '缺 type → need_info（不猜）');
    ok((await roster.dropouts(redis)).length === 0,
      '★ 没重建就不记「已自愈」—— 那一栏叫「掉册记录 · 已自愈」，'
      + '把没救回来的记进去等于撒谎');
  }

  console.log('\n【5】保留上限 —— 不会无限长');
  {
    await redis.del(roster.DROPOUT_KEY);
    for (let i = 0; i < roster.DROPOUT_KEEP + 5; i++) {
      await roster.noteDropout(redis, `bulk${i}`, 'dev', 1786400000000 + i);
    }
    const all = await roster.dropouts(redis, 999);
    ok(all.length === roster.DROPOUT_KEEP, `裁到 ${roster.DROPOUT_KEEP} 条`, `实际 ${all.length}`);
    ok(all[0].name === `bulk${roster.DROPOUT_KEEP + 4}`,
      '★ 新的在前 —— 复盘先找最近的', all[0].name);
  }

  console.log('\n【6】★★★ 留痕的 key 不能污染花名册查询');
  {
    // ── 为什么留痕 key 不能在花名册前缀下 ─────────────────────────
    //   key 要是写成 `engloop:roster:dropouts`，而 `list()` 用
    //   `SCAN MATCH engloop:roster:*` 扫花名册、对每个 key `GET` ——
    //   对一个 list 执行 GET 就是 `WRONGTYPE`，**整个花名册查询崩掉**。
    //   花名册崩 = 所有消息路由失效。
    //
    // ⇒ **共享前缀 + SCAN 通配，等于声明「这前缀下全是同一种类型」**，
    //   而那条约定没写在任何地方，放进第二种类型才会暴露。
    await roster.register(redis, AGENT, { type: 'dev' }, 60);
    await roster.noteDropout(redis, AGENT, 'dev');
    let listed = null; let threw = null;
    try { listed = await roster.list(redis); } catch (e) { threw = e; }
    ok(threw === null,
      '★★★ 有掉册记录时 list() 不炸（不撞 WRONGTYPE）',
      threw && threw.message);
    ok(listed && listed.some((a) => a.name === AGENT),
      '★ 而且照常查得到 agent', JSON.stringify((listed || []).map((a) => a.name)));
    ok(!roster.DROPOUT_KEY.startsWith('engloop:roster:'),
      '★ 留痕 key 不在花名册的前缀下', roster.DROPOUT_KEY);
    await roster.unregister(redis, AGENT);
    await redis.del(roster.DROPOUT_KEY);
  }

  console.log('\n【7】★ 留痕失败不能拖垮心跳');
  {
    // 救回来比记下来重要。写不进去时 noteDropout 返回 false，不抛。
    const broken = { lpush: async () => { throw new Error('redis 炸了'); } };
    const r = await roster.noteDropout(broken, 'x', 'dev');
    ok(r === false, '★★ 写失败返回 false 而不是抛 —— '
      + '留痕失败不该让一次成功的自愈变成一次失败的心跳');
  }

  await redis.del(roster.DROPOUT_KEY);
  await roster.unregister(redis, AGENT).catch(() => {});
  await redis.quit();
  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
