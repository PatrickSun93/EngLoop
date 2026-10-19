'use strict';

/**
 * emoji 反应：语义判定 + 存储 + 待确认动作。
 *
 * ── 为什么全是行为测试，没有源码断言 ──────────────────────────────────
 * `web/threads.js:9-13` 解释过这件事：
 *
 *   > 源码断言验得了「这个函数存在」，**验不了它拿到畸形输入会不会把它吃掉**。
 *
 * 这份文件里每一条都真写 redis、真读回来。唯一的例外是最后那段路由挂载检查
 * （`bin/serve.js` 测试 require 不了 —— 一 require 就起服务占端口），
 * 而那一段自己带了一条「不存在的路由确实查不到」的自检，证明它不是恒真。
 *
 * ⚠️ 跑在测试库里：`require.main` 在 `test/` 下 ⇒ `q.createClient()` 自动换 db
 *    （`lib/queue.js:247-270`）。
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const q = require('../lib/queue');
const R = require('../lib/reactions');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const A = 'REACTTEST-anchor-1';
const A2 = 'REACTTEST-anchor-2';
/** ★ 房间和私聊**故意用同一个 anchor 字面值** —— 这就是碰撞测试的全部意义。 */
const SAME = 'REACTTEST-collide';

async function wipe(redis) {
  const keys = await redis.keys('engloop:react:*');
  if (keys.length) await redis.del(...keys);
  await redis.del(R.PENDING_INDEX);
}

async function main() {
  const redis = q.createClient();

  // ───────────────────────────────────────────────────────────────
  console.log('\n【0】★★ 开场自检：这份测试真的跑在测试库上');
  {
    // ★★ 这一段挡的形状：`test/` 下的进程被判成生产进程、连了 db 0，
    //   然后 `del` 掉编排者的收件流，未读消息全丢（`lib/queue.js:255-267`）。
    //
    //   下面每一段都在 `del engloop:react:*`。**连错库的话，
    //   那几行会删生产数据，而测试照样全绿** —— 绿灯根本不区分它删的是哪个库。
    //
    // ⚠️ 所以自检必须在**任何写操作之前**跑，而且必须是这份文件的第一件事。
    //   放在收尾去查等于「在副作用发生之后才执行的检查」，那不是检查。
    const db = redis.options && redis.options.db;
    ok(typeof db === 'number' && db !== 0,
      '★★ 连的不是 db 0', `实际 db=${db}`);
    ok(db >= q.TEST_DB_MIN && db <= q.TEST_DB_MAX,
      `★ 而且落在测试库区间 [${q.TEST_DB_MIN}, ${q.TEST_DB_MAX}] 内`, `实际 db=${db}`);
    // ★ 正控：这个检查表达得出「不合格」吗？喂一个生产库编号给同一条判据。
    //   少了它，上面两条对一个恒真的实现（比如 db 读成 undefined 时短路）也会绿。
    const fakeProdDb = 0;
    ok(!(fakeProdDb >= q.TEST_DB_MIN && fakeProdDb <= q.TEST_DB_MAX),
      '★ 正控：同一条判据把 db 0 判为不合格 —— 它不是恒真');

    if (db === 0) {
      console.error('\n🔴 连到了生产库，**立刻停** —— 再跑下去下面的 del 会删生产数据。');
      process.exit(1);
    }
  }

  await wipe(redis);

  // ───────────────────────────────────────────────────────────────
  console.log('\n【1】语义表：四档分类');
  {
    ok(R.classify('👍').tier === 'A' && R.classify('👍').effect === 'none',
      'A 档 👍 → 不触发动作');
    ok(R.classify('✅').tier === 'B' && R.classify('✅').effect === 'immediate',
      'B 档 ✅ → 立即执行');
    ok(R.classify('🛑').tier === 'C' && R.classify('🛑').effect === 'confirm',
      'C 档 🛑 → 待确认');
    ok(R.classify('🦄').known === false, '未知 emoji → known=false');

    // ★ 正控：上面那条 `known===false` 必须认得出反面，否则它对任何输入都成立。
    ok(R.classify('👍').known === true,
      '★ 正控：已知 emoji 的 known 真的是 true —— 上一条不是恒真');
    // ★ 而且未知的那个**结构完整**，不是 null（调用方无从漏判）。
    ok(R.classify('🦄').effect === 'none' && typeof R.classify('🦄').label === 'string',
      '★ 未知 emoji 返回结构完整的对象，不是 null');
    ok(R.classify('🦄').notice && R.classify('🦄').notice.includes('没绑动作'),
      '★ 未知 emoji 自带「没绑动作」的可显示说明 —— 不静默吞掉');

    // ★★★ 🏁 —— **系统会自动打的唯一一个 emoji**，
    //   `lib/relay.js` 在 agent 报完成时替它打在 thread 根上。
    //
    //   ⚠️ 下面这条断言守的不是「表里有这一项」，是**它的档位**：
    //   一旦有人把 🏁 挪进 B 档（或者图省事直接改成让系统打 ✅），
    //   **系统就会替人执行一次动作** —— 每条完成报告都自动触发一次
    //   mark_verified 回执。而 A/B 两档的分界线就是「有没有动作」，
    //   系统替人越过那条线，这张表的分档就名存实亡了。
    //
    //   ⇒ 这是「改错了不报错」的典型：界面照常显示 🏁，回执悄悄多了一份。
    ok(R.classify('🏁').known === true, '🏁 在语义表里');
    ok(R.classify('🏁').tier === 'A' && R.classify('🏁').effect === 'none',
      '★★★ 🏁 必须是 A 档 —— 系统自动打的东西绝不能触发动作');
    ok(R.classify('🏁').action === null,
      '★★★ 🏁 不绑任何动作（挪进 B 档这条会红）');
    ok(R.classify('🏁').costs_quota === false, '🏁 不花额度');

    // ★★ 而 ✅ 必须**保持**是 B 档的人工验收 —— 两个符号的区别就是
    //   「它说完了」和「人认了」的区别，也就是待办和已办的区别。
    //   把 ✅ 降成 A 档来「统一」两者，同样会让这个功能失去意义。
    ok(R.classify('✅').tier === 'B' && R.classify('✅').action === 'mark_verified',
      '★★ 对照：✅ 仍是 B 档人工验收，没被 🏁 顶掉');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【2】❓ 花额度这件事是**数据**，不是注释');
  {
    ok(R.classify('❓').costs_quota === true,
      '❓ costs_quota=true —— 它要触发一次 agent 调用');
    ok(R.classify('❓').tier === 'B',
      '❓ 留在 B 档（Patrick 选的方案 1）');
    // ★ 阴性对照：这个字段区分得开，不是所有条目都 true。
    ok(R.classify('👍').costs_quota === false && R.classify('✅').costs_quota === false,
      '★ 阴性对照：不花钱的条目确实是 false —— 上一条不是恒真');
    ok(R.classify('🔁').costs_quota === true, '🔁 也标了花额度');

    // ★★ 「一路吐到界面上」这条要求：它必须出现在**对外 payload** 里。
    //   只在 classify 里有、payload 里漏掉的话，界面永远看不到它 ——
    //   而那正是这条要求想防的（写成注释 = 等于没做）。
    const p = R.semanticsPayload();
    const q_ = p.emojis.find((e) => e.emoji === '❓');
    ok(q_ && q_.costs_quota === true,
      '★ semanticsPayload 里 ❓ 的 costs_quota 真的吐出去了');
    ok(p.emojis.every((e) => typeof e.costs_quota === 'boolean'),
      '★ 表里每一条都带 costs_quota（没有漏字段的条目）');
    ok(p.tier_rules.length === 3 && p.tier_rules.some((r) => r.includes('额度')),
      '★ 分档判据（含「花额度」那一维）也跟着吐给界面');
    ok(p.confirm_ui === 'button',
      '★ 「确认用按钮不用 emoji」是对外声明的，不只是实现细节');
    ok(p.emojis.length === Object.keys(R.SEMANTICS).length,
      '★ payload 由 SEMANTICS 派生，条目数一致（唯一出处）');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【3】加 / 取消 / 读回来');
  {
    await R.add(redis, { scope: 'room', anchor: A, emoji: '👍', by: 'Patrick' });
    await R.add(redis, { scope: 'room', anchor: A, emoji: '👍', by: 'dev' });
    const r1 = await R.list(redis, 'room', A);
    const thumb = r1.reactions.find((x) => x.emoji === '👍');
    ok(thumb && thumb.count === 2, '两个人点同一个 emoji → count=2', JSON.stringify(r1));
    ok(thumb.users.map((u) => u.by).sort().join(',') === 'Patrick,dev',
      '两个人都在 users 里');

    // ★ 幂等：同一个人点两次还是 1。设计出来的，不是碰巧 ——
    //   重复点击 / 前端重试 / 重发请求三条路径都指望它。
    await R.add(redis, { scope: 'room', anchor: A, emoji: '👍', by: 'Patrick' });
    const r2 = await R.list(redis, 'room', A);
    ok(r2.reactions.find((x) => x.emoji === '👍').count === 2,
      '★ 同一个人重复点 → 仍然 count=2（幂等）');

    // ★★ 取消**只删自己那条**，不碰别人的。
    await R.remove(redis, { scope: 'room', anchor: A, emoji: '👍', by: 'Patrick' });
    const r3 = await R.list(redis, 'room', A);
    const t3 = r3.reactions.find((x) => x.emoji === '👍');
    ok(t3 && t3.count === 1 && t3.users[0].by === 'dev',
      '★★ 取消只删自己那条 —— 别人的还在', JSON.stringify(r3));

    const again = await R.remove(redis, { scope: 'room', anchor: A, emoji: '👍', by: 'Patrick' });
    ok(again.ok === true && again.removed === false,
      '★ 取消一个不存在的反应：不报错，但如实返回 removed=false');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【4】★★ 两个 id 空间不许互相看见（JARVIS 点名的那条）');
  {
    // 同一个 anchor 字面值，一个当房间锚点、一个当私聊锚点。
    await R.add(redis, { scope: 'room', anchor: SAME, emoji: '👍', by: 'Patrick' });
    await R.add(redis, { scope: 'dm', anchor: SAME, emoji: '🔥', by: 'dev' });

    const inRoom = await R.list(redis, 'room', SAME);
    const inDm = await R.list(redis, 'dm', SAME);
    ok(inRoom.reactions.length === 1 && inRoom.reactions[0].emoji === '👍',
      '房间那侧只看得到 👍', JSON.stringify(inRoom.reactions.map((x) => x.emoji)));
    ok(inDm.reactions.length === 1 && inDm.reactions[0].emoji === '🔥',
      '私聊那侧只看得到 🔥', JSON.stringify(inDm.reactions.map((x) => x.emoji)));
    ok(R.KEY('room', SAME) !== R.KEY('dm', SAME),
      '★ 两个 scope 的 key 真的不同', `${R.KEY('room', SAME)} vs ${R.KEY('dm', SAME)}`);

    // ★ 正控：这套断言认得出「两边确实会看见对方」的情形吗？
    //   同一个 scope 下加第二个 emoji —— 它**应该**被看见。看不见就说明
    //   上面那两条「只看得到一个」是因为读不出来，而不是因为隔离生效。
    await R.add(redis, { scope: 'room', anchor: SAME, emoji: '👀', by: 'dev2' });
    const inRoom2 = await R.list(redis, 'room', SAME);
    ok(inRoom2.reactions.length === 2,
      '★ 正控：同一 scope 下的第二个 emoji 读得到 —— 上面的隔离不是「什么都读不到」');

    const scopeErr = await R.add(redis, { scope: 'nope', anchor: SAME, emoji: '👍', by: 'x' })
      .then(() => null).catch((e) => e);
    ok(scopeErr && scopeErr.code === R.BAD_SCOPE,
      '★ 非法 scope 大声失败，不悄悄写进一个新命名空间');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【5】★★★ C 档不执行动作，只落一条待确认');
  {
    const res = await R.add(redis, { scope: 'dm', anchor: A2, emoji: '🛑', by: 'Patrick' });
    ok(res.semantic.effect === 'confirm', '🛑 判成 confirm');
    ok(res.pending && res.pending.status === R.PENDING_OPEN,
      '★★ 产生了一条待确认动作，状态是 pending', JSON.stringify(res.pending));
    ok(res.pending.action === 'stop_agent' && res.pending.by === 'Patrick',
      '待确认动作记着「谁点的、要做什么」');

    // ★★★ 阴性对照 —— 这是整份测试里最容易恒真的一条断言的守卫。
    //   「C 档没执行动作」怎么证明？靠对照 B 档：B 档**必须**没有 pending。
    //   两者读数不同 ⇒ `pending != null` 这个观测点区分得开两种情形，
    //   ⇒ 上面那条不是「无论如何都成立」。
    const b = await R.add(redis, { scope: 'dm', anchor: A2, emoji: '✅', by: 'Patrick' });
    ok(b.pending === null && b.semantic.effect === 'immediate',
      '★★★ 阴性对照：B 档 ✅ 不产生待确认 —— 上一条不是恒真');
    const a = await R.add(redis, { scope: 'dm', anchor: A2, emoji: '👍', by: 'Patrick' });
    ok(a.pending === null && a.semantic.effect === 'none',
      '★ A 档 👍 同样不产生待确认');

    const open = await R.listPending(redis);
    ok(open.length === 1 && open[0].emoji === '🛑',
      '待确认列表里只有那条 C 档的', JSON.stringify(open.map((x) => x.emoji)));
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【6】待确认动作的生命周期：可撤回、留痕、不许二次结账');
  {
    const [p] = await R.listPending(redis);
    const cancelled = await R.cancelPending(redis, p.id, 'Patrick');
    ok(cancelled.status === R.PENDING_CANCELLED && cancelled.resolved_by === 'Patrick',
      '撤回成功，记下了是谁撤的');

    const still = await R.getPending(redis, p.id);
    ok(still && still.status === R.PENDING_CANCELLED,
      '★ 撤回**不删记录** —— 「误销修法不是消除它，是让它当场可见」');

    const openNow = await R.listPending(redis);
    ok(openNow.length === 0, '默认列表里不再出现（它已经结账了）');
    const allNow = await R.listPending(redis, { all: true });
    ok(allNow.length === 1 && allNow[0].status === R.PENDING_CANCELLED,
      '★ all:true 仍然看得见它 —— 留痕');

    const twice = await R.confirmPending(redis, p.id, 'dev').then(() => null).catch((e) => e);
    ok(twice && twice.code === R.PENDING_SETTLED,
      '★★ 已结账的不许再结一次 —— 否则一条已撤销的动作会被第二次点击改成「已确认」并执行');

    const gone = await R.getPending(redis, 'REACTTEST-no-such-id').then(() => null).catch((e) => e);
    ok(gone && gone.code === R.PENDING_NOT_FOUND, '★ 正控：不存在的 id 真的报错（上面几条不是恒真）');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【7】★ 取消反应**不**连带撤销已生成的待确认动作');
  {
    const anchor = 'REACTTEST-detach';
    const res = await R.add(redis, { scope: 'room', anchor, emoji: '🔁', by: 'Patrick' });
    ok(res.pending.status === R.PENDING_OPEN, '先产生一条待确认');

    const rm = await R.remove(redis, { scope: 'room', anchor, emoji: '🔁', by: 'Patrick' });
    const after = await R.getPending(redis, res.pending.id);
    ok(after.status === R.PENDING_OPEN,
      '★ 取消 emoji 之后，那条待确认**还在**且仍然 open');
    // 为什么这是对的：人取消 emoji 会以为「那件事没发生过」，
    // 而它已经在待确认列表里躺着了。让它跟着消失，才是真正的静默。
    const list = await R.list(redis, 'room', anchor);
    ok(list.reactions.length === 0, '而反应本身确实取消掉了（两件事各自独立）');

    // ★★★ 判据对，但**光有判据会自己制造一次误操作** ——
    //   人的心智模型是「取消 = 没发生过」。所以真相必须当场说出来。
    ok(rm.pending_still_open.length === 1 && rm.pending_still_open[0].id === res.pending.id,
      '★★★ 取消的响应里带着「那条待确认还在」', JSON.stringify(rm.pending_still_open));
    ok(rm.notice && rm.notice.includes('待确认'),
      '★ 而且带一句人能直接读的话 —— 前端显示它就行', String(rm.notice));

    // ★ 阴性对照：取消一个**没**生成过 pending 的反应时，不许报这句话。
    //   否则这条提示对所有取消都出现，人两天后就不看它了 —— 那等于没有提示。
    const anchorA = 'REACTTEST-detach-plain';
    await R.add(redis, { scope: 'room', anchor: anchorA, emoji: '👍', by: 'Patrick' });
    const rmA = await R.remove(redis, { scope: 'room', anchor: anchorA, emoji: '👍', by: 'Patrick' });
    ok(rmA.pending_still_open.length === 0 && rmA.notice === null,
      '★ 阴性对照：A 档取消不报这句 —— 提示不是恒真，所以它不会变成噪音');

    await R.cancelPending(redis, res.pending.id, 'Patrick');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【8】未知 emoji：存下来、读得回、不触发');
  {
    const anchor = 'REACTTEST-unknown';
    const res = await R.add(redis, { scope: 'room', anchor, emoji: '🦄', by: 'Patrick' });
    ok(res.ok === true && res.pending === null, '加成功，且不产生任何动作');
    const l = await R.list(redis, 'room', anchor);
    const u = l.reactions[0];
    ok(u && u.emoji === '🦄' && u.count === 1, '★ 它真的被存下来了 —— 没有静默丢掉');
    ok(u.known === false && u.notice, '★ 读回来时带着「没绑动作」的说明，界面显示得出');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【9】批量读：只回有反应的那些');
  {
    const out = await R.listMany(redis, 'room', [A, 'REACTTEST-nothing-here']);
    ok(Object.prototype.hasOwnProperty.call(out, A), '有反应的那条在结果里');
    ok(!Object.prototype.hasOwnProperty.call(out, 'REACTTEST-nothing-here'),
      '★ 没反应的那条**不出现** —— 否则前端要给每条消息渲染一个空反应条');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【10】坏数据不吃掉，报成可见的 malformed');
  {
    const anchor = 'REACTTEST-malformed';
    // 直接写一个不是 JSON 的 field，模拟历史脏数据 / 别的写入方
    await redis.hset(R.KEY('room', anchor), 'not-json-at-all', String(Date.now()));
    await R.add(redis, { scope: 'room', anchor, emoji: '👍', by: 'Patrick' });
    const l = await R.list(redis, 'room', anchor);
    ok(l.reactions.length === 1, '好数据照常读出来');
    ok(l.malformed.length === 1 && l.malformed[0] === 'not-json-at-all',
      '★ 坏 field 报成 malformed，不是静默跳过 —— 少一个反应而没人知道才是最坏的');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【11】输入校验：空值大声失败');
  {
    const cases = [
      ['anchor 为空', { scope: 'room', anchor: '', emoji: '👍', by: 'p' }],
      ['emoji 为空', { scope: 'room', anchor: A, emoji: '', by: 'p' }],
      ['by 为空', { scope: 'room', anchor: A, emoji: '👍', by: '' }],
    ];
    for (const [label, args] of cases) {
      const e = await R.add(redis, args).then(() => null).catch((x) => x);
      ok(e && e.code === R.BAD_INPUT, `${label} → BAD_INPUT`);
    }
    // ★ 正控：合法输入不会被这几条拦下来。
    const good = await R.add(redis, { scope: 'room', anchor: A, emoji: '👍', by: 'p' })
      .then((r) => r).catch(() => null);
    ok(good && good.ok === true, '★ 正控：合法输入照常通过 —— 上面几条不是「什么都拒绝」');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【12】★★ unicode 规范化：带不带变体选择符必须是同一个 emoji');
  {
    // ★ 这里用**显式转义**写这一对，不贴字面字符 —— VS16 不可见，
    //   贴进源码之后这两个常量在编辑器里长得一模一样，
    //   而这条测试的全部意义就是「它们看起来一样但码点不同」。
    const PLAIN = '\u{1F44D}';            // 👍  裸码点
    const WITH_VS16 = '\u{1F44D}\uFE0F';  // 👍 + U+FE0F（变体选择符，不可见）
    ok([...PLAIN].length === 1 && [...WITH_VS16].length === 2,
      '前提：这两个字符串码点数确实不同（否则下面全是空测）');

    // ① 幂等：同一个人用两种写法各点一次 → 仍然只算一个
    const anchor = 'REACTTEST-vs16';
    await R.add(redis, { scope: 'room', anchor, emoji: PLAIN, by: 'Patrick' });
    await R.add(redis, { scope: 'room', anchor, emoji: WITH_VS16, by: 'Patrick' });
    const l = await R.list(redis, 'room', anchor);
    ok(l.reactions.length === 1 && l.reactions[0].count === 1,
      '★★ 两种写法落成同一个 field —— 幂等没被码点差异打破',
      JSON.stringify(l.reactions.map((x) => [x.emoji, x.count])));
    ok(R.fieldOf(PLAIN, 'Patrick') === R.fieldOf(WITH_VS16, 'Patrick'),
      '★ fieldOf 对两种写法给出同一个 field');

    // ② ★★ 更狠的那个：带 VS16 的**不许**被判成未知 emoji。
    //   判成未知的话，表里明明有的动作不触发，而界面上那个 emoji 照常显示。
    ok(R.classify(WITH_VS16).known === true && R.classify(WITH_VS16).tier === 'A',
      '★★ 带 VS16 的 👍️ 仍然查得中语义表（不是「未知」）',
      JSON.stringify(R.classify(WITH_VS16)));
    ok(R.classify(WITH_VS16).action === R.classify(PLAIN).action
      && R.classify(WITH_VS16).effect === R.classify(PLAIN).effect,
      '★ 两种写法判成同一个动作');
    ok([...R.classify(WITH_VS16).emoji].length === 1,
      '★ classify 返回的是**规范化之后**的形式 —— 跟存储里那个一致');

    // ③ C 档也要归一 —— 否则带 VS16 的 🛑 会绕过两段式（判成未知 = 不触发）
    const stopVs = '\u{1F6D1}\uFE0F';
    ok(R.classify(stopVs).effect === 'confirm',
      '★★★ 带 VS16 的 🛑 仍然走两段式 —— 破坏性动作不会因为一个隐形码点被绕过');

    // ★ 正控：规范化没有把**所有**东西都变成已知。
    //   少了这条，上面几条对「一个把任何输入都判成 👍 的实现」也会全绿。
    ok(R.classify('\u{1F984}\uFE0F').known === false,
      '★ 正控：带 VS16 的未知 emoji 仍然是未知 —— 规范化不是「什么都认」');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【13】★ 源码断言：路由真的挂在 bin/serve.js 上');
  {
    // handler 再对，没挂上去也是零 —— 而挂载写在 bin/ 里，测试 require 不了它。
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'serve.js'), 'utf8');
    const want = [
      ["app.get('/api/reactions/semantics', reactions.semanticsHandler())", 'GET semantics'],
      ["app.post('/api/reactions/batch', reactions.batchHandler(redis))", 'POST batch'],
      ["app.get('/api/reactions/:scope/:anchor', reactions.listHandler(redis))", 'GET 一条的反应'],
      ["app.post('/api/reactions/:scope/:anchor', reactions.addHandler(redis))", 'POST 加反应'],
      ["app.delete('/api/reactions/:scope/:anchor', reactions.removeHandler(redis))", 'DELETE 取消'],
      ["app.get('/api/reactions/pending', reactions.listPendingHandler(redis))", 'GET 待确认列表'],
      ["app.post('/api/reactions/pending/:id/confirm', reactions.confirmHandler(redis))", 'POST 确认'],
      ["app.post('/api/reactions/pending/:id/cancel', reactions.cancelHandler(redis))", 'POST 撤回'],
    ];
    for (const [line, label] of want) ok(src.includes(line), `${label} 挂了`, line);
    ok(!src.includes("app.get('/api/reactions/nope', reactions.nopeHandler(redis))"),
      '★ 自检：不存在的路由确实查不到 —— 上面几条不是恒真');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【14】★★ 真 HTTP：这几个端点的价值**全在状态码上**');
  {
    // ⚠️ 挂到测试自己的 express + 端口 0，**不起真 bus** ——
    //   bus 一起来 watchdog 就会枚举真 tmux 会话，而测试库花名册是空的，
    //   于是每个真 agent 都会被判失聪、被 submit 一条恢复指令。
    //   **测试会去打断正在干活的人。**（`lib/rooms.js:369-371` 同一条。）
    const app = express();
    app.use(express.json());
    app.get('/api/reactions/semantics', R.semanticsHandler());
    app.post('/api/reactions/batch', R.batchHandler(redis));
    app.get('/api/reactions/pending', R.listPendingHandler(redis));
    app.post('/api/reactions/pending/:id/confirm', R.confirmHandler(redis));
    app.post('/api/reactions/pending/:id/cancel', R.cancelHandler(redis));
    app.get('/api/reactions/:scope/:anchor', R.listHandler(redis));
    app.post('/api/reactions/:scope/:anchor', R.addHandler(redis));
    app.delete('/api/reactions/:scope/:anchor', R.removeHandler(redis));

    const srv = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve({
        base: `http://127.0.0.1:${s.address().port}`,
        close: () => new Promise((r) => s.close(r)),
      }));
    });
    const j = async (method, path, body) => {
      const r = await fetch(srv.base + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    const ANCHOR = 'REACTTEST-http-1';

    const sem = await j('GET', '/api/reactions/semantics');
    ok(sem.status === 200 && Array.isArray(sem.body.emojis), 'GET semantics → 200');
    ok(sem.body.emojis.some((e) => e.emoji === '❓' && e.costs_quota === true),
      '★ 走真 HTTP 也拿得到 costs_quota —— 「一路吐到界面上」是端到端成立的');

    const add1 = await j('POST', `/api/reactions/dm/${ANCHOR}`, { emoji: '👍', by: 'Patrick' });
    ok(add1.status === 200 && add1.body.ok === true, 'POST 加反应 → 200');

    // ★ 未知 emoji 走 **200**，不是 4xx —— 加反应这个动作本身成功了。
    //   4xx 会让界面当成「加失败了」而不显示它，于是人连「点过一个
    //   没绑动作的 emoji」都不知道。
    const addUnknown = await j('POST', `/api/reactions/dm/${ANCHOR}`, { emoji: '🦄', by: 'Patrick' });
    ok(addUnknown.status === 200 && addUnknown.body.semantic.known === false,
      '★★ 未知 emoji → 200 + known=false（不是 4xx，那是另一种静默）');

    const badScope = await j('POST', '/api/reactions/nope/x', { emoji: '👍', by: 'p' });
    ok(badScope.status === 400 && badScope.body.error === 'BAD_SCOPE',
      '★ 非法 scope → 400（不是 500）', JSON.stringify(badScope));
    ok(typeof badScope.body.next === 'string' && badScope.body.next.includes('room'),
      '★ 而且告诉人下一步该怎么写 —— 只说「失败了」会让人去猜');

    const badInput = await j('POST', `/api/reactions/dm/${ANCHOR}`, { emoji: '', by: 'p' });
    ok(badInput.status === 400 && badInput.body.error === 'BAD_INPUT', '空 emoji → 400');

    const batch = await j('POST', '/api/reactions/batch',
      { scope: 'dm', anchors: [ANCHOR, 'REACTTEST-http-empty'] });
    ok(batch.status === 200 && batch.body.reactions[ANCHOR],
      'POST batch → 200，有反应的那条在结果里');
    ok(!batch.body.reactions['REACTTEST-http-empty'],
      '★ 没反应的那条不出现（前端不用给它画空反应条）');
    ok(batch.body.truncated === null, '没超限时 truncated=null');

    const batchBad = await j('POST', '/api/reactions/batch', { scope: 'dm', anchors: 'not-an-array' });
    ok(batchBad.status === 400 && batchBad.body.error === 'BAD_INPUT',
      '★ anchors 不是数组 → 400');

    // ★★ 超限：截断 + **在响应里说清截了**。静默截断 = 界面上少几条反应而没人知道。
    const many = Array.from({ length: R.BATCH_MAX + 3 }, (_, i) => `REACTTEST-many-${i}`);
    const batchBig = await j('POST', '/api/reactions/batch', { scope: 'dm', anchors: many });
    ok(batchBig.status === 200 && batchBig.body.truncated
      && batchBig.body.truncated.asked === R.BATCH_MAX + 3
      && batchBig.body.truncated.used === R.BATCH_MAX,
      '★★ 超限截断，而且响应里说清了截掉多少', JSON.stringify(batchBig.body.truncated));

    // ★ C 档两段式走 HTTP：409 / 404 这两个码是这段的重点
    const addStop = await j('POST', `/api/reactions/dm/${ANCHOR}`, { emoji: '🛑', by: 'Patrick' });
    ok(addStop.status === 200 && addStop.body.pending, 'C 档 → 200 且带 pending');
    const pid = addStop.body.pending.id;

    const conf = await j('POST', `/api/reactions/pending/${pid}/confirm`, { by: 'Patrick' });
    ok(conf.status === 200 && conf.body.record.status === 'confirmed', '确认 → 200');

    const conf2 = await j('POST', `/api/reactions/pending/${pid}/confirm`, { by: 'dev' });
    ok(conf2.status === 409 && conf2.body.error === 'PENDING_SETTLED',
      '★★ 二次确认 → **409**（请求没毛病，是状态不允许 —— 不是 400）',
      JSON.stringify(conf2.status));
    ok(conf2.body.record && conf2.body.record.status === 'confirmed',
      '★ 而且把它**现在的状态**一起返回 —— 人要知道的是「它到底是什么」，不是「你失败了」');

    const noSuch = await j('POST', '/api/reactions/pending/REACTTEST-nope/cancel', { by: 'p' });
    ok(noSuch.status === 404 && noSuch.body.error === 'PENDING_NOT_FOUND',
      '不存在的 pending → 404');

    // ★★ `by` 必填 —— 缺席不是一个状态，是一条丢失的事实（一条没带 body 的撤回
    //   会存出 `resolved_by: null`，零报错）。
    const addStop2 = await j('POST', `/api/reactions/dm/${ANCHOR}`, { emoji: '❌', by: 'Patrick' });
    const pid2 = addStop2.body.pending.id;
    const noBy = await j('POST', `/api/reactions/pending/${pid2}/cancel`, {});
    ok(noBy.status === 400 && noBy.body.error === 'BAD_INPUT',
      '★★ 撤回不带 by → **400**（不是存一条没署名的记录）', JSON.stringify(noBy.status));
    // ★★ 而且**没有产生副作用**：那条 pending 必须还是 open。
    //   少了这一条，一个「先改状态再校验」的实现也会返回 400 —— 而它已经把
    //   记录改坏了。状态码对，事实错。
    const stillOpen = await j('GET', '/api/reactions/pending');
    ok((stillOpen.body.pending || []).some((p) => p.id === pid2),
      '★★★ 400 之后那条 pending **仍然是 open** —— 校验发生在写之前');
    // ★ 正控：带上 by 就能撤，而且署名真的存下来了。
    const withBy = await j('POST', `/api/reactions/pending/${pid2}/cancel`, { by: 'Patrick' });
    ok(withBy.status === 200 && withBy.body.record.resolved_by === 'Patrick',
      '★ 正控：带 by → 200 且署名存下来了（上面那条不是「什么都拒」）');

    // ★ 正控：这一整段的状态码断言区分得开吗？一条正常请求必须是 200。
    const okList = await j('GET', `/api/reactions/dm/${ANCHOR}`);
    ok(okList.status === 200, '★ 正控：正常请求确实是 200 —— 上面那些 4xx 不是「什么都报错」');

    await srv.close();
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【15】★ 前端接线（源码断言 —— 浏览器脚本 require 不了）');
  {
    // ⚠️ 这一段是**弱证据**：它验得了「这一行在文件里」，
    //   验不了「点下去真的发出了请求」。真验收要人在浏览器里点一次。
    //   放它在这里的理由只有一个：**没有它，前端整条接线可以静默消失**
    //   ——`renderReactions` 定义得再对，`renderMsg` 里不调用就等于不存在，
    //   而语法检查、后端测试、HTTP 测试**全都照样绿**。
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
    const appCss = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.css'), 'utf8');

    ok(appJs.includes('if (e.id) msg.appendChild(renderReactions(e));'),
      '★★ renderMsg 尾部真的挂了反应条 —— 少了这一行整个功能不存在');
    ok(appJs.includes("fetch('/api/reactions/batch'"),
      '★ 批量拉反应走 batch 端点（不是一屏 50 个请求）');
    ok(appJs.includes("fetch('/api/reactions/semantics')"),
      '★ 语义表从后端拿 —— 前端不留第二份');
    ok(!/const\s+(SEMANTICS|EMOJI_TABLE)\s*=/.test(appJs),
      '★★ 前端**没有**自己再写一份 emoji→动作表（两份表会各自漂移，零报错）');
    ok(appJs.includes("'/api/reactions/pending/'") || appJs.includes('/api/reactions/pending/'),
      '★ 确认/撤回接到了 pending 端点');

    // ★★ 这条守的是一个具体的、注释里写明过的坑（app.css:386-392）：
    //   `.msg` 是三列 grid，往它下面塞一个不跨列的元素会把整行错开，
    //   **而错位只在 agent 的消息上看得出来** —— 自己的消息刚好填满再换行。
    ok(/\.reactions\{[^}]*grid-column:1\/-1/.test(appCss),
      '★★ .reactions 跨满整行（grid-column:1/-1）—— 否则 .msg 的三列 grid 会错位');

    // ★★ 守一个具体的坑：`renderFeed` 是 `replaceChildren()` 整树重建，
    //   而轮询每几秒触发一次。异步回填如果落到发请求时保存的节点引用上，
    //   那些节点已经被丢弃 ⇒ **反应不显示、零报错、而且「有时显示有时不显示」**。
    ok(appJs.includes('const reactWanted = new Set()'),
      '★★ 待拉取的是**锚点 key**，不是 DOM 节点引用');
    ok(/function reactNodes\(scope, anchor\)/.test(appJs),
      '★★ 回填按锚点重查当前 DOM（别假设发请求时那棵树还在）');
    // ★ 这条守的是「改了一半」：旧写法留着没用，比没改更危险 ——
    //   下一个人会以为两条路都还在用，然后照着旧的那条改。
    ok(!/reactWaiting/.test(appJs),
      '★ 旧的节点引用写法**完全移除**了，不是留着不用');

    // ★ 自检：这几条断言认得出「不在」的情形吗？
    ok(!appJs.includes('renderReactionsThatDoNotExist('),
      '★ 自检：不存在的串确实查不到 —— 上面几条不是恒真');
  }

  await wipe(redis);
  await redis.quit();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('✗ 异常:', (e && e.stack) || e);
  process.exit(1);
});
