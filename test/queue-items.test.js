'use strict';

/**
 * 【Q】队列面板的条目分类 —— **能不能撤回，取决于状态判对没判对**。
 *
 * 这个文件守的是一条语义边界：
 *   未投递 → 删得掉,是真撤回
 *   已投递未 ack → **删了没用**,agent 手里已经有那条了
 * 判错方向的后果是**一个让人以为撤回了、而 agent 照样在干的按钮**。
 */

const q = require('../lib/queue');
const roster = require('../lib/roster');
const items = require('../lib/queue-items');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

async function main() {
  console.log('\n【1】★★★ cmpId：stream id 必须按**数值**比，不是字符串');
  {
    // 🔴 决定性的一条：字符串序下 '1786…' < '9999-0'（'1' < '9'），
    //   而实际前者晚了四十多年。
    const late = '1786390372860-0';
    const early = '9999-0';
    ok(late < early, '（前置）字符串比较认为 1786… 小于 9999-0 —— 这就是那个陷阱');
    ok(items.cmpId(late, early) > 0,
      '★★★ cmpId 判 1786… **晚于** 9999-0（数值序），跟字符串序**相反**',
      String(items.cmpId(late, early)));
    ok(items.cmpId('5-0', '5-1') < 0, '同毫秒看序号');
    ok(items.cmpId('5-2', '5-2') === 0, '相等');
    ok(items.cmpId('10-0', '9-0') > 0,
      '★★ 位数不同也对（字符串序会说 10-0 < 9-0）', String(items.cmpId('10-0', '9-0')));
    ok(items.cmpId('1-0', '0-0') > 0, '跟初始游标 0-0 比');
  }

  console.log('\n【2】★★★ classify 三态');
  {
    const rows = [
      { id: '1-0', text: '已 ack 的历史' },
      { id: '2-0', text: '已投递未 ack' },
      { id: '3-0', text: '还没投递' },
    ];
    const out = items.classify(rows, new Set(['2-0']), '2-0');
    const by = Object.fromEntries(out.map((r) => [r.id, r.state]));
    ok(by['1-0'] === 'done', '① 游标之前 + 不在 PEL → done（已 ack 的历史）', JSON.stringify(by));
    ok(by['2-0'] === 'in_flight', '② 在 PEL → in_flight（**删了没用**）', JSON.stringify(by));
    ok(by['3-0'] === 'queued', '③ 游标之后 → queued（**删得掉,真撤回**）', JSON.stringify(by));
  }

  console.log('\n【3】★★★ 顺序要紧：PEL 必须先于游标判');
  {
    // 一条已投递未 ack 的消息，它的 id **必然 <= last-delivered-id** ——
    // 先按游标判会把它错判成 done，于是界面上它消失，人以为处理完了。
    const rows = [{ id: '2-0', text: '已投递未 ack' }];
    const out = items.classify(rows, new Set(['2-0']), '5-0');   // 游标远在它之后
    ok(out[0].state === 'in_flight',
      '★★★ id 远在游标之前、但在 PEL 里 → 仍判 in_flight（不是 done）',
      out[0].state);
    // 阴性对照：同一条不在 PEL 时才是 done
    const out2 = items.classify(rows, new Set(), '5-0');
    ok(out2[0].state === 'done',
      '★★ 阴性对照：同一条不在 PEL 时判 done —— 上一条不是恒真');
  }

  console.log('\n【4】★ 边界：组从没读过（last-delivered 为 null / 0-0）');
  {
    ok(items.classify([{ id: '1-0' }], new Set(), null)[0].state === 'queued',
      'last-delivered 是 null → 全算 queued（组还没读过任何东西）');
    ok(items.classify([{ id: '1-0' }], new Set(), '0-0')[0].state === 'queued',
      '★ last-delivered 是初始值 0-0 → 也算 queued（字符串比会判错的正是这里）');
  }

  console.log('\n【5】★★★ 真跑 redis：造出三态，看它们真的分得开');
  {
    const redis = q.createClient();
    const S = 'agent:qitest:in';
    const G = 'agent:qitest';
    await redis.del(S);

    // ① 写三条
    await q.send(redis, S, { from: 'JARVIS', to: 'qitest', text: '第一条', agent_type: 'dev' });
    await q.send(redis, S, { from: 'JARVIS', to: 'qitest', text: '第二条', agent_type: 'dev' });
    await q.send(redis, S, { from: 'JARVIS', to: 'qitest', text: '第三条', agent_type: 'dev' });

    // ② 领走前两条（模拟 agent 读了但还没 ack）→ 它们进 PEL
    const got = await q.claimNext(redis, { streams: S, group: G, consumer: 'c1', blockMs: 50, count: 2 });
    ok(got.length === 2, '（前置）领走 2 条', String(got.length));

    // ③ ack 掉第一条 → 它变成 done
    await q.ack(redis, S, G, got[0].id);

    const r = await items.listStream(redis, S, G, { includeDone: true });
    const by = Object.fromEntries(r.items.map((x) => [x.text, x.state]));
    ok(by['第一条'] === 'done', '★★ 领走且 ack 了 → done', JSON.stringify(by));
    ok(by['第二条'] === 'in_flight', '★★★ 领走没 ack → in_flight（**删了没用**）', JSON.stringify(by));
    ok(by['第三条'] === 'queued', '★★★ 没被领走 → queued（**删得掉**）', JSON.stringify(by));

    // ④ 两个数分开，且**不提供合计**
    ok(r.queued === 1 && r.in_flight === 1,
      '★★ queued=1 · in_flight=1 —— 两个数分开算', JSON.stringify([r.queued, r.in_flight]));
    ok(!('total' in r),
      '★★★ **没有 total 字段** —— 合成一个数会把「能不能撤回」这个区别抹掉，'
      + '而那正是这个功能的全部意义');

    // ⑤ 默认不含 done —— 面板要的是「现在积压什么」，不是历史
    const r2 = await items.listStream(redis, S, G);
    ok(r2.items.length === 2 && !r2.items.some((x) => x.state === 'done'),
      '★ 默认滤掉 done（面板显示的是积压，不是历史）',
      JSON.stringify(r2.items.map((x) => x.state)));
    // ★ 正控：确认 done 那一态**真的存在过** —— 否则「滤掉 done」这行从没被执行
    ok(r.items.some((x) => x.state === 'done'),
      '★★ 正控：includeDone 时确实看得到 done —— 上一条不是「本来就没有 done」');

    // ⑥ XLEN 那个坑：流长度 ≠ 积压
    const xlen = await redis.xlen(S);
    ok(xlen === 3 && (r2.queued + r2.in_flight) === 2,
      `★★★ XLEN=${xlen} 而真实积压=2 —— **拿流长度当积压会把已处理的历史算进去**，`
      + '而那个数只涨不降、看起来完全合理');

    await redis.del(S);
    await roster.unregister(redis, 'qitest').catch(() => {});
    await redis.quit();
  }

  console.log('\n【6】★★★ cancelItem：只有未投递的撤得掉 —— **机制在服务端**');
  {
    const redis = q.createClient();
    const S = 'agent:qcancel:in';
    const G = 'agent:qcancel';
    await redis.del(S);
    await q.send(redis, S, { from: 'JARVIS', to: 'qcancel', text: '甲 会被领走', agent_type: 'dev' });
    await q.send(redis, S, { from: 'JARVIS', to: 'qcancel', text: '乙 还没领走', agent_type: 'dev' });
    const got = await q.claimNext(redis, { streams: S, group: G, consumer: 'c1', blockMs: 50, count: 1 });
    ok(got.length === 1, '（前置）领走 1 条，它进 PEL');

    const list = await items.listStream(redis, S, G);
    const inflight = list.items.find((x) => x.state === 'in_flight');
    const queued = list.items.find((x) => x.state === 'queued');
    ok(!!inflight && !!queued, '（前置）造出了一条 in_flight 和一条 queued');

    // ① 撤 in_flight → 拒绝，**而且那条必须还在流里**
    const r1 = await items.cancelItem(redis, S, inflight.id, G);
    ok(r1.ok === false && r1.state === 'in_flight',
      '★★★ 撤 in_flight → 拒绝', JSON.stringify(r1));
    ok((await redis.xrange(S, inflight.id, inflight.id)).length === 1,
      '★★★ **而且它还在流里** —— 拒绝了却把它删了，就是「以为撤回了」那个后果本身');
    ok(/直接跟它说|跟它说/.test(r1.reason || ''),
      '★★ 拒绝的理由里给出**出路**（去直接跟 agent 说），不只是说「不行」',
      r1.reason);

    // ② 撤 queued → 放行，且真的删掉
    const r2 = await items.cancelItem(redis, S, queued.id, G);
    ok(r2.ok === true, '★★★ 撤 queued → 放行', JSON.stringify(r2));
    ok((await redis.xrange(S, queued.id, queued.id)).length === 0,
      '★★★ 它真的从流里没了 —— 「报告成功」和「真的删了」是两件事');

    // ③ 再撤一次同一条 → 说得出它已经不在了，不能假装成功
    const r3 = await items.cancelItem(redis, S, queued.id, G);
    ok(r3.ok === false, '★★ 重复撤回 → 不假装成功', JSON.stringify(r3));
    ok(/不在队列里了|刷新/.test(r3.reason || ''), '★ 而且说得出下一步', r3.reason);

    // ④ 阴性对照：确认「拒绝」不是恒真 —— ② 已经证明了，这里再钉一次方向
    ok(r1.ok === false && r2.ok === true,
      '★★ 阴性对照：同一个函数对两种状态给出**相反**的结论 —— 不是「一律拒绝」');

    // ⑤ ★★★ **竞态**：判定说「是 queued」之后、XDEL 之前，它刚好被领走。
    //
    //   这条路径**只能靠注入造出来** —— 而它是这个函数最重要的一条：
    //   删完一律回「已撤回」的话，产出的就是**一个让人以为撤回了、
    //   而 agent 照样在干的按钮**，也就是这个功能本来要防的那件事本身。
    await q.send(redis, S, { from: 'JARVIS', to: 'qcancel', text: '丙 会被抢走', agent_type: 'dev' });
    const l2 = await items.listStream(redis, S, G);
    const victim = l2.items.find((x) => x.state === 'queued' && /丙/.test(x.text));
    ok(!!victim, '（前置）又造了一条 queued');

    const r4 = await items.cancelItem(redis, S, victim.id, G, {
      // 判定之后、删除之前 —— 让消费者把它领走
      onBeforeDelete: async () => {
        await q.claimNext(redis, { streams: S, group: G, consumer: 'c2', blockMs: 50, count: 10 });
      },
    });
    ok(r4.ok === false, '★★★ 竞态：判定后被领走 → **不报成功**', JSON.stringify(r4));
    ok(r4.raced === true && r4.state === 'in_flight',
      '★★★ 而且说得出是「晚了一步」，不是笼统的失败', JSON.stringify(r4));
    ok(/晚了一步/.test(r4.reason || '') && /手里有一份|照常干完/.test(r4.reason || ''),
      '★★★ 理由里说清**它手里有一份、会照常干完** —— 这正是人需要知道的那件事',
      r4.reason);
    ok(r4.deleted === true,
      '★★ 而且如实说「队列记录确实删掉了」—— 删了和撤回了是两件事，都要说');

    // ★ 阴性对照：不注入竞态时，同一段代码报成功 —— 证明上面不是恒假
    await q.send(redis, S, { from: 'JARVIS', to: 'qcancel', text: '丁 正常撤', agent_type: 'dev' });
    const l3 = await items.listStream(redis, S, G);
    const calm = l3.items.find((x) => x.state === 'queued' && /丁/.test(x.text));
    const r5 = await items.cancelItem(redis, S, calm.id, G);
    ok(r5.ok === true && !r5.raced,
      '★★ 阴性对照：没有竞态时正常报「已撤回」—— 上面那条不是「一律失败」',
      JSON.stringify(r5));

    await redis.del(S);
    await roster.unregister(redis, 'qcancel').catch(() => {});
    await redis.quit();
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【9】★ 每条消息上的撤回入口：前端接线（源码断言）');
  {
    // ⚠️ **弱证据**：验得了「这几行在文件里」，
    //   验不了「按钮真的只在 queued 上出现」。真验收要人在浏览器里点。
    //   放它的理由只有一个：**没有它，这条接线可以静默消失** ——
    //   `renderWithdraw` 写得再对，`renderMsg` 里不调用就等于不存在，
    //   而语法检查和 lib 层这 8 段全都照样绿。
    const fs = require('node:fs');
    const path = require('node:path');
    const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.css'), 'utf8');

    ok(/if \(e\.id\) \{\s*\n\s*const wb = renderWithdraw\(e\);/.test(app),
      '★★ renderMsg 里真的挂了撤回条 —— 少了这一行整个入口不存在');

    // ★★★ 三条硬判据，逐条守 ——
    ok(/current\.kind !== 'dm'/.test(app),
      "★★ 房间频道不画（`current.kind !== 'dm'` 直接 return）");
    ok(/e\.from !== 'Patrick'/.test(app),
      '★ 只对自己发的消息画');
    ok(/it\.state === 'queued'/.test(app),
      "★★★ **只认 state==='queued'** —— in_flight 删了没用，给按钮就是骗人");

    // ★★ 复用而不是重写：另写一份请求逻辑 = 第二处出处，
    //   而 cancelQueueItem 里那三条守卫（先确认 / 原样呈现 reason /
    //   网络失败时明说「还在队列里」）会在第二份里悄悄少掉一条。
    ok(/onclick = \(\) => cancelQueueItem\(hit\.it, hit\.recipient\)/.test(app),
      '★★ 撤回复用 cancelQueueItem，没有另写一份请求逻辑');
    ok(/onclick = \(\) => withdrawAndRewrite\(hit\.it, hit\.recipient\)/.test(app),
      '★ 「撤回改写」复用 withdrawAndRewrite（先填框再撤，撤不掉时字还在）');
    ok(!/fetch\('\/api\/queue\/cancel'[\s\S]{0,400}renderWithdraw/.test(app),
      '★ 自检：撤回条那段里没有第二个 /api/queue/cancel 调用');

    // ★ 那个假阴性必须写在**代码注释**里，不是只写在报告里
    //   （报告被读一次，注释会被下一个改这段的人读到）。
    ok(/假阴性/.test(app) && /100 条窗口之外|窗口之外/.test(app),
      '★★ 100 条窗口的假阴性如实写进了代码注释');

    // ★ 时机那条：数据刷新后只填壳，不重画消息流（renderFeed 会弹滚动）
    ok(/refreshWithdrawBars\(\)/.test(app) && /scrollTop/.test(app),
      '★★ 有 refreshWithdrawBars —— 不靠每 5 秒 renderFeed（那会把人弹回底部）');

    // ★ 布局那条：跟 .reactions / .body / .reply-btn 同理，必须跨满整行
    ok(/\.withdraw-bar\{[^}]*grid-column:1\/-1/.test(css),
      '★★ .withdraw-bar 跨满整行 —— 否则 .msg 的三列 grid 会错位');
    ok(/\.withdraw-bar:empty\{display:none\}/.test(css),
      '★ 空壳不占视觉空间（撤不掉时它是空的，但要留着等数据刷新）');

    ok(!/renderWithdrawThatDoesNotExist/.test(app),
      '★ 自检：不存在的串确实查不到 —— 上面几条不是恒真');
  }

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
