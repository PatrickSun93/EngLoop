'use strict';

/**
 * 跨 thread 合并的旁路映射（`lib/thread-merge.js`）。
 *
 * ── 这个文件守的是什么 ──────────────────────────────────────────
 * 两件事，而且第二件比第一件贵得多：
 *
 *   ① 合并/撤销确实生效，而且**历史一个字没动**（撤销一定回得到原样）。
 *   ② **成环的合并进不去表。** 环的后果不在这一层 —— 它在读取端：
 *      `rootIdOf` 会卡在 while 里，而症状是**「点开房间一片空白」，
 *      跟「这个房间是空的」长得一模一样**。
 *
 * ⚠️ 所以下面的环用例不是防御性编程的洁癖，它们守的是一个
 *   **看起来完全正常的故障**。
 */

const express = require('express');
const q = require('../lib/queue');
const rooms = require('../lib/rooms');
const TM = require('../lib/thread-merge');

const jpost = async (url, body) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
};
const jget = async (url) => {
  const r = await fetch(url);
  return { status: r.status, body: await r.json() };
};

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const HASH = 'mergetestroom';

async function main() {
  const redis = q.createClient();
  await redis.del(TM.KEY(HASH));

  console.log('\n【1】纯函数 wouldCycle：判据本身');
  {
    ok(TM.wouldCycle({}, 'A', 'A') === true, '★ 自己并入自己算环（上溯会原地打转）');
    ok(TM.wouldCycle({}, 'A', 'B') === false, '空表里 A→B 不成环');
    ok(TM.wouldCycle({ A: 'B' }, 'B', 'A') === true,
      '★★★ 已有 A→B，再加 B→A ⇒ 成环');
    ok(TM.wouldCycle({ A: 'B', B: 'C' }, 'C', 'A') === true,
      '★★ 三段链首尾相接也算 —— 环不一定只有两个点');
    ok(TM.wouldCycle({ A: 'B' }, 'C', 'B') === false,
      '★ 阴性对照：两条都指向 B 不是环（合并本来就允许多对一）');
    ok(TM.wouldCycle({ A: 'B', B: 'C' }, 'X', 'A') === false,
      '★ 接在链尾上不成环 —— 判据不是「碰到已有的键就拒绝」');
  }

  console.log('\n【2】合并 → 读表 → 撤销');
  {
    const r = await TM.merge(redis, HASH, 'rootA', 'rootB');
    ok(r.ok === true, 'rootA 并入 rootB');
    const m = await TM.map(redis, HASH);
    ok(m.rootA === 'rootB', '★ 表里读得到这条', JSON.stringify(m));
    ok(await TM.count(redis, HASH) === 1, 'count 是 1');

    const again = await TM.merge(redis, HASH, 'rootA', 'rootB');
    ok(again.ok === true && again.already === true,
      '★ 重复合并同一对 ⇒ 成功且标 already（不报错，也不重复写）');

    const u = await TM.unmerge(redis, HASH, 'rootA');
    ok(u.ok === true && u.removed === true, '★★ 撤销成功');
    ok(Object.keys(await TM.map(redis, HASH)).length === 0,
      '★★★ 撤销之后表是空的 —— 历史没动过，所以一定回得到原样');

    const u2 = await TM.unmerge(redis, HASH, 'rootA');
    ok(u2.ok === true && u2.removed === false,
      '★ 撤销一个不存在的：不算失败，但 removed=false —— '
      + '否则界面会显示「已撤销」而其实什么都没发生');
  }

  console.log('\n【3】★★★ 成环的合并进不去表 —— 它的症状在读取端，长得像「房间是空的」');
  {
    await redis.del(TM.KEY(HASH));
    await TM.merge(redis, HASH, 'A', 'B');

    const bad = await TM.merge(redis, HASH, 'B', 'A');
    ok(bad.ok === false && bad.error === 'cycle', '★★★ B→A 被拒', JSON.stringify(bad));
    ok(typeof bad.note === 'string' && bad.note.length > 10,
      '★★ 拒绝时有话说 —— 静默失败会让人对着没变的界面反复点', bad.note);

    const m = await TM.map(redis, HASH);
    ok(m.B === undefined,
      '★★★ 表里**没有**留下那条 —— 检查发生在写入之前，不需要回滚');
    ok(m.A === 'B', '★ 原来那条还在（拒绝一条不该影响别的）');

    // 三段链
    await TM.merge(redis, HASH, 'B', 'C');
    const bad3 = await TM.merge(redis, HASH, 'C', 'A');
    ok(bad3.ok === false && bad3.error === 'cycle', '★★ A→B→C 之后 C→A 也被拒');

    // ★ 阴性对照：合法的链式合并**不许**被这条拦住。
    //   没有这一条，「拒绝一切」也能让上面几条全绿。
    const good = await TM.merge(redis, HASH, 'D', 'A');
    ok(good.ok === true, '★★★ 对照：D→A 是合法的（接在链尾），必须放行',
      JSON.stringify(good));
  }

  console.log('\n【4】参数校验：说清楚缺了什么');
  {
    const r1 = await TM.merge(redis, HASH, '', 'X');
    ok(r1.ok === false && r1.error === 'missing_root', '缺 from ⇒ missing_root');
    const r2 = await TM.merge(redis, HASH, 'X', 'X');
    ok(r2.ok === false && r2.error === 'self_merge',
      '★ 自己并入自己有**专门的**错误码 —— 跟成环分开报，因为人改法不同');
    const r3 = await TM.unmerge(redis, HASH, '');
    ok(r3.ok === false && r3.error === 'missing_root', '撤销也要给 from');
  }

  console.log('\n【5】房间之间不串');
  {
    await redis.del(TM.KEY(HASH), TM.KEY('otherroom'));
    await TM.merge(redis, HASH, 'A', 'B');
    const other = await TM.map(redis, 'otherroom');
    ok(Object.keys(other).length === 0,
      '★★ 另一个房间的表是空的 —— 合并是房间内的事', JSON.stringify(other));
    await redis.del(TM.KEY('otherroom'));
  }

  console.log('\n【6】★★★ HTTP 层：状态码 + 映射表真的到得了浏览器');
  // ⚠️ 这一节必须**真走一遍 HTTP**。`bin/` 下的代码测不到，而这两个端点的
  //   价值全在状态码上 —— 直接调函数验不了「成环回的是 409 还是 500」。
  //
  // ★★ 而最后那两条（history 里带 merges）守的是一个常见形状：
  //   服务端做好了、前端拿不到，于是**界面纹丝不动而且不报错**。
  //   （同一形状见 `bin/next.js` 里转发字段那段：字段已经在流里，只是没往外传，
  //   网页侧验收全绿，对 agent 却是空功能。）
  {
    await redis.del(TM.KEY(HASH));

    const app = express();
    app.use(express.json());
    app.post('/api/rooms/:hash/threads/merge', TM.mergeHandler(redis));
    app.delete('/api/rooms/:hash/threads/merge/:from', TM.unmergeHandler(redis));
    app.get('/api/rooms/:hash/history', rooms.historyHandler(redis));

    const srv = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve({
        base: `http://127.0.0.1:${s.address().port}`,
        close: () => new Promise((r) => s.close(r)),
      }));
    });

    const room = await rooms.create(redis, 'MERGEHTTP-' + Date.now());
    const U = `${srv.base}/api/rooms/${room.hash}/threads/merge`;

    const r1 = await jpost(U, { from: 'A', to: 'B' });
    ok(r1.status === 200 && r1.body.ok === true, '合并 ⇒ 200', JSON.stringify(r1));

    const r2 = await jpost(U, { from: 'B', to: 'A' });
    ok(r2.status === 409, '★★★ 成环 ⇒ **409 不是 400** —— 请求没写错，是当前状态不允许',
      String(r2.status));
    ok(r2.body.error === 'cycle' && typeof r2.body.next === 'string' && r2.body.next.length > 10,
      '★★ 带 next 说清该怎么改（错误要说「该做什么」，不只说「是什么」）',
      JSON.stringify(r2.body));

    const r3 = await jpost(U, { from: 'X' });
    ok(r3.status === 400 && r3.body.error === 'missing_root', '缺 to ⇒ 400');
    const r4 = await jpost(U, { from: 'X', to: 'X' });
    ok(r4.status === 400 && r4.body.error === 'self_merge', '自己并自己 ⇒ 400');

    // ★★★ 映射表跟着 history 一起回 —— 前端的上溯全靠它
    const h1 = await jget(`${srv.base}/api/rooms/${room.hash}/history`);
    ok(h1.status === 200, '（前置）history 200');
    ok(h1.body.merges && h1.body.merges.A === 'B',
      '★★★ history 的 payload 里带着合并表 —— 不带的话服务端合并了、界面纹丝不动',
      JSON.stringify(h1.body.merges));

    // 撤销之后表要跟着空 —— 「历史没动过所以回得去」这个性质要能从 API 看到
    const d1 = await fetch(`${U}/A`, { method: 'DELETE' });
    const d1b = await d1.json();
    ok(d1.status === 200 && d1b.removed === true, '★ DELETE 撤销 ⇒ 200 + removed:true');

    const h2 = await jget(`${srv.base}/api/rooms/${room.hash}/history`);
    ok(h2.body.merges && Object.keys(h2.body.merges).length === 0,
      '★★ 撤销后 payload 里的表是空的（对照：上面那条不是「恒有一张表」）',
      JSON.stringify(h2.body.merges));

    await redis.del(TM.KEY(room.hash), rooms.META(room.hash));
    await redis.srem(rooms.INDEX, room.hash).catch(() => {});
    await srv.close();
  }

  await redis.del(TM.KEY(HASH));
  await redis.quit();

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
