'use strict';

const q = require('../lib/queue');
const rooms = require('../lib/rooms');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

async function main() {
  const redis = q.createClient();
  // 清掉可能的残留
  for (const h of await redis.smembers(rooms.INDEX)) {
    const m = await rooms.get(redis, h);
    if (m && /^TEST-/.test(m.name)) {
      await redis.del(rooms.META(h), rooms.stream(h));
      await redis.srem(rooms.INDEX, h);
    }
  }

  console.log('\n【1】建房间');
  const room = await rooms.create(redis, 'TEST-房间A');
  ok(!!room.hash && room.hash.length === 12, `hash 生成（${room.hash}）`);
  ok(room.members.length === 0, '初始无成员');
  const listed = await rooms.list(redis);
  ok(listed.some((r) => r.hash === room.hash), 'list 能查到');

  console.log('\n【2】加入 / 退出');
  await rooms.join(redis, room.hash, 'JARVIS');
  await rooms.join(redis, room.hash, 'dev');
  await rooms.join(redis, room.hash, 'dev');  // 重复加入
  let m = await rooms.get(redis, room.hash);
  ok(m.members.length === 2, '重复 join 不产生重复成员');
  ok(m.members.includes('JARVIS') && m.members.includes('dev'), '两人都在');

  await rooms.leave(redis, room.hash, 'dev');
  m = await rooms.get(redis, room.hash);
  ok(m.members.length === 1 && !m.members.includes('dev'), 'leave 生效');
  await rooms.join(redis, room.hash, 'dev');

  console.log('\n【3】发言进流 + 可回溯（替代 v1 的 chatlog.jsonl）');
  await rooms.post(redis, room.hash, { from: 'Patrick', text: '第一句' });
  await rooms.post(redis, room.hash, { from: 'JARVIS', text: '第二句' });
  await rooms.post(redis, room.hash, { from: 'dev', text: '第三句' });

  const hist = await rooms.history(redis, room.hash, 10);
  ok(hist.length === 3, '历史三条');
  ok(hist[0].text === '第一句' && hist[2].text === '第三句', '顺序正确（append-only）');
  ok(hist[1].from === 'JARVIS', '发言人记录正确');
  ok(hist[0].room_hash === room.hash && !!hist[0].room_name, '每条带房间标识');

  console.log('\n【4】房间不存在时的行为');
  let threw = false;
  try { await rooms.post(redis, 'deadbeefcafe', { from: 'x', text: 'y' }); }
  catch (e) { threw = /不存在/.test(e.message); }
  ok(threw, '往不存在的房间发言会报错，不静默丢');
  ok((await rooms.get(redis, 'deadbeefcafe')) === null, '查不存在的房间返回 null');

  console.log('\n【5】消费者组维护水位（不用自己记 line_count）');
  const st = rooms.stream(room.hash);
  await q.ensureGroup(redis, st, 'reader1');
  const batch1 = await q.claimNext(redis, { streams: st, group: 'reader1', consumer: 'c', blockMs: 300 });
  ok(batch1.length === 3, '首次读到全部 3 条');
  const batch2 = await q.claimNext(redis, { streams: st, group: 'reader1', consumer: 'c', blockMs: 300 });
  ok(batch2.length === 0, '再读为空 —— 组自己记住了位置');

  await rooms.post(redis, room.hash, { from: 'Patrick', text: '第四句' });
  const batch3 = await q.claimNext(redis, { streams: st, group: 'reader1', consumer: 'c', blockMs: 300 });
  ok(batch3.length === 1 && batch3[0].text === '第四句', '只拿到新增的那条');

  console.log('\n【6】不同读者互不影响（每人一组）');
  await q.ensureGroup(redis, st, 'reader2');
  const other = await q.claimNext(redis, { streams: st, group: 'reader2', consumer: 'c', blockMs: 300 });
  ok(other.length === 4, 'reader2 从头读到 4 条，不受 reader1 影响');

  console.log('\n【7】★ historyPayload：房间不存在 → 抛，绝不返回空 messages');
  // ── 为什么这一条是这一节的核心 ──────────────────────────────────
  // 「这个房间没人说话」和「没有这个房间」在界面上长得**一模一样**：
  // 都是一片空白。而后者意味着请求方拿着一个错的 hash —— 静默返回 `[]`
  // 等于对他说「一切正常，只是还没人说话」。
  // `/api/agents` 头上那段注释骂的是同一件事，只是换了个端点。
  {
    let threw = null;
    try { await rooms.historyPayload(redis, 'deadbeefcafe'); }
    catch (e) { threw = e; }
    ok(threw !== null, '★ 不存在的房间**抛错**，不是返回 {messages:[]}');
    ok(threw?.code === rooms.ROOM_NOT_FOUND,
      '★ 带机器可判的 code —— 靠 message 里有没有「不存在」三个字来判 404 会被改文案打断',
      `实际 code=${threw?.code}`);

    const p = await rooms.historyPayload(redis, room.hash, 10);
    ok(p.messages.length === 4, '存在的房间照常返回历史（4 条）', `实际 ${p.messages.length}`);
    ok(p.name === 'TEST-房间A' && Array.isArray(p.members),
      '★ 带上 name / members —— 否则界面画顶栏还得再打一次 /api/rooms');
    ok(p.hash === room.hash, '带上 hash');

    // ★ 阴性对照：一个**存在但空**的房间必须是 200 + 空数组，不是 404。
    //   没有这条的话，「不存在就抛」可以被写成「没消息就抛」，同样绿。
    const empty = await rooms.create(redis, 'TEST-空房间');
    const ep = await rooms.historyPayload(redis, empty.hash);
    ok(Array.isArray(ep.messages) && ep.messages.length === 0,
      '★ （阴性对照）存在但没消息的房间 → 空数组，不抛 —— 两种「空」必须分得开');
    await redis.del(rooms.META(empty.hash), rooms.stream(empty.hash));
    await redis.srem(rooms.INDEX, empty.hash);
  }

  console.log('\n【8】★ httpError：404 / 503 的判定看 code，不看文案');
  {
    const nf = rooms.httpError(Object.assign(new Error('房间不存在: abc'), {
      code: rooms.ROOM_NOT_FOUND,
    }));
    ok(nf.status === 404, '房间不存在 → 404');
    ok(/不存在/.test(nf.body.error), '404 的 body 说得出是哪种错');

    const down = rooms.httpError(new Error('Connection is closed.'));
    ok(down.status === 503, 'Redis 挂了 → 503');
    ok(down.body.error === 'QUEUE_UNAVAILABLE',
      '★ 503 用 QUEUE_UNAVAILABLE —— 跟 /api/message、/api/rooms 同一个错误码');
    ok(/Connection/.test(down.body.message), '★ 原始原因没被吞掉');

    // ★ 这一条守的是「判据是 code 不是文案」。没有它，实现可以退回
    //   `message.includes('不存在')`，上面几条照样全绿。
    const trap = rooms.httpError(new Error('redis: key 不存在'));
    ok(trap.status === 503,
      '★★ 一个碰巧含「不存在」三个字的 Redis 错误 → 仍是 503，不会被误判成 404',
      `实际 ${trap.status}`);

    // ── ★★ 说清「是什么」之后还要说「该做什么」──────────────────────
    // > 诚实但无用的错误消息，人还是会去猜 —— 而且比假装没事更难发现，
    // > 因为**写的人看那句话时，脑子里已经有了它省略掉的那部分上下文**。
    //
    // ⚠️ 这里逐条断**具体出口**，不写一条「每个错误都要有 next 字段」的通用断言
    //   —— 那种只能查「有没有某个键」，而一个填了空字符串的实现照样全绿。
    ok(/\/api\/rooms/.test(nf.body.next || ''),
      '★★ 404 给出真出口：去房间列表核 hash（光说「不存在」，人不知道下一步去哪）',
      JSON.stringify(nf.body.next));
    ok(/删/.test(nf.body.next || ''),
      '★ 而且点出第二种可能（房间被删了）—— 两种情况这个端点都答不出来',
      JSON.stringify(nf.body.next));

    ok(/不是「房间没有消息」/.test(down.body.next || ''),
      '★★ 503 的出口先定性：**「读不到」不是「没有」** —— 别据此得出「这房间是空的」',
      JSON.stringify(down.body.next));
    ok(/health/.test(down.body.next || ''),
      '★ 并给出可直接查的东西（/health 看 redis 死活）', JSON.stringify(down.body.next));
  }

  console.log('\n【9】★ parseCount：非法值不报 400，但上限必须有');
  {
    ok(rooms.parseCount(undefined) === rooms.COUNT_DEFAULT, '没传 → 默认 50');
    ok(rooms.parseCount('20') === 20, '正常值透传');
    ok(rooms.parseCount('abc') === rooms.COUNT_DEFAULT,
      '★ 打错的 count 回落到默认 —— 不该让整个房间显示不出来');
    ok(rooms.parseCount('0') === rooms.COUNT_DEFAULT, '0 → 默认');
    ok(rooms.parseCount('-5') === rooms.COUNT_DEFAULT, '负数 → 默认');
    ok(rooms.parseCount('12.9') === 12, '小数取整（XREVRANGE 的 COUNT 只吃整数）');
    ok(rooms.parseCount('99999999') === rooms.COUNT_MAX,
      '★★ 超大值被夹到上限 —— 没有它，一个 URL 就能让 bus 把整条流拉进内存，'
      + '而 bus 卡住 = 所有 agent 的 relay 一起停',
      `实际 ${rooms.parseCount('99999999')}`);
  }

  console.log('\n【10】★★ fanOutPlan：广播不跳发言者，扇出跳');
  // ── 这个纯函数存在的唯一理由就是这一节 ──────────────────────────
  // 两个成员表不一样。写在同一个循环里的话，谁都会顺手让它们共用
  // 那个 `continue` —— 而后果是**自己说的话在自己屏幕上不出现**，
  // 看起来像消息发丢了，实际上是发出去了。**而且不会有任何报错。**
  {
    const meta = { hash: 'h1', name: '故障复盘', members: ['Patrick', 'JARVIS', 'dev'] };
    const msg = { id: '1786074073209-0', from: 'Patrick',
                  text: '这条房间消息你们收到的 room_hash 是什么？',
                  timestamp: '2026-08-07T03:00:00.000Z', job_id: 'j1' };
    const plan = rooms.fanOutPlan(meta, msg);

    ok(plan.deliveries.length === 2, '扇出给两个人（3 个成员减掉发言者）');
    ok(!plan.deliveries.some((d) => d.member === 'Patrick'),
      '★ 扇出**跳过**发言者 —— agent 收到自己刚说的话可能会再回一遍');
    ok(plan.deliveries.every((d) => d.text.startsWith('[房间 故障复盘] ')),
      '★ 扇出的文本带房间前缀 —— agent 只有一个收件流，得知道这条来自哪');

    ok(plan.broadcast.from === 'Patrick' && plan.broadcast.type === 'room_message',
      '★★ 广播里**有**发言者自己那条 —— 人要看到房间里的全部发言，包括自己刚发的');
    ok(plan.broadcast.text === msg.text,
      '★ 广播的 text 是原文，不带 [房间 X] 前缀（浏览器已经拿到 room_hash + room_name）');
    ok(plan.broadcast.room_hash === 'h1' && plan.broadcast.room_name === '故障复盘',
      '★ 广播带 room_hash 和 room_name');
    ok(plan.broadcast.at === msg.timestamp,
      '★ 广播带时间戳 —— watchdog 事件要跟发言按时间交织，那是判断因果的唯一线索');

    // ★★ 前端拿 id 跟 /api/rooms/:hash/history 拉来的那批去重。
    //   两边必须是**同一个 id 空间**（都是房间流的 stream id），
    //   否则刷新页面时每条消息显示两遍 —— 而且没有任何报错。
    ok(plan.broadcast.id === msg.id,
      '★★ 广播带房间流的 stream id —— 前端靠它跟 history 去重',
      JSON.stringify(plan.broadcast.id));

    // ★ 边界：发言者不在成员表里（agent 被移出房间后那条还在流里没扇完）。
    //   广播照发 —— 那句话确实在房间里说过，界面不该把它藏起来。
    const outsider = rooms.fanOutPlan(meta, { from: '路人', text: 'hi' });
    ok(outsider.deliveries.length === 3, '发言者不在成员表 → 三个人都收得到');
    ok(outsider.broadcast.from === '路人', '★ 而且照样广播 —— 那句话确实在房间里说过');
  }

  console.log('\n【10c】★★ 没有收件流的成员不扇出 —— 否则人会看到同一句话两遍');
  {
    // ── 这个重复是「加了一条正确的新路径，旧路径没人告诉它已经有人管了」──
    // 成员表里有 Patrick（人，不在花名册）→ `roster.lookup` 查不到 →
    // 回落 `orch:out` → **bus 的 deliverLoop 消费它又 broadcast 一次**。
    // 那条回落本来就在，**是广播让它显形的**。
    //
    // ⚠️ 判据是「有没有自己的收件流」，**不是「是不是人」** ——
    //   这个系统有一条明确的性质：不区分收件人是人还是 agent。
    //   掉册的 agent 同样适用：它读不到 `orch:out`，那条回落对它本来就没用。
    const meta = { hash: 'h2', name: '复盘', members: ['Patrick', 'JARVIS', 'dev'] };
    const msg = { id: '1-0', from: 'dev', text: 'agent 发言', timestamp: 'x' };
    const routable = new Set(['JARVIS', 'dev']);          // Patrick 不在花名册

    const plan = rooms.fanOutPlan(meta, msg, routable);
    ok(plan.deliveries.length === 1 && plan.deliveries[0].member === 'JARVIS',
      '★★ 只扇给有收件流的（JARVIS）—— Patrick 靠广播，再扇一份就是第二遍',
      JSON.stringify(plan.deliveries.map((d) => d.member)));
    ok(plan.broadcast.from === 'dev',
      '★★ 但广播照发 —— 那才是 Patrick 看到这句话的正路');
    ok(plan.skipped_no_inbox.includes('Patrick'),
      '★★ 被跳过的**说出来** —— 只存在于代码里的话，'
      + '下次查「为什么他没收到」时无从下手',
      JSON.stringify(plan.skipped_no_inbox));

    // ★ 阴性对照：不传 routable → 不过滤（旧行为）。
    //   缺了它，一个「永远只扇给第一个」的实现也能过上面那条。
    const noFilter = rooms.fanOutPlan(meta, msg);
    ok(noFilter.deliveries.length === 2,
      '★ 不传 routable → 不过滤，两个都扇（旧行为保留）',
      JSON.stringify(noFilter.deliveries.map((d) => d.member)));
    ok(noFilter.skipped_no_inbox.length === 0,
      '★ 不过滤时 skipped 是空的，不是「全部」');

    // ★★ 掉册的 agent 走同一条判据 —— 这条证明判据不是「是不是人」。
    const deafRoutable = new Set(['JARVIS']);              // dev2 掉册了
    const p2 = rooms.fanOutPlan(
      { hash: 'h3', name: 'r', members: ['JARVIS', 'dev2'] },
      { id: '1-0', from: 'JARVIS', text: 'x' }, deafRoutable);
    ok(p2.deliveries.length === 0 && p2.skipped_no_inbox.includes('dev2'),
      '★★ 掉册的 agent 也被跳过 —— 判据是「有没有收件流」，不是「是不是人」',
      JSON.stringify(p2));
  }

  console.log('\n【10b】★★ 广播的 id 跟 history 的 id 是同一个空间');
  {
    // ── 这条不能只靠上面那句「原样透传」──────────────────────────────
    // 透传是对的，但**透传的源头对不对**是另一回事：`fanOutPlan` 收到的 msg
    // 来自 `q.claimNext()`，而 history 的 id 来自 `XREVRANGE`。
    // 两者都叫 `id`，**但那是巧合还是保证，只有真跑一遍才知道** ——
    // 对不上的话前端去重永远匹配不到，症状是「刷新后每条显示两遍」。
    const st = rooms.stream(room.hash);
    const posted = await rooms.post(redis, room.hash, { from: 'Patrick', text: '去重验证' });
    const hist = await rooms.history(redis, room.hash, 1);
    ok(hist[0]?.id === posted.id,
      '（前置）history 的 id 就是 post 返回的那个 stream id',
      `history=${hist[0]?.id} posted=${posted.id}`);

    // 真走一遍 bus 的那条路：消费者组领出来 → fanOutPlan
    await q.ensureGroup(redis, st, 'dedup-probe');
    const got = await q.claimNext(redis, {
      streams: st, group: 'dedup-probe', consumer: 'p1', blockMs: 300, count: 50,
    });
    const mine = got.find((m) => m.text === '去重验证');
    ok(mine !== undefined, '（前置）从消费者组里领到了那条');
    const plan2 = rooms.fanOutPlan({ hash: room.hash, name: 'x', members: [] }, mine);
    ok(plan2.broadcast.id === posted.id,
      '★★ 走 claimNext 领出来再进 fanOutPlan，广播的 id 仍然等于 history 的 id',
      `broadcast=${plan2.broadcast.id} history=${posted.id}`);
  }

  console.log('\n【★t】thread：reply_to 端到端');
  {
    // ★ 父用 post 的返回 id —— **thread 的全部前提是 reply_to 和 history/broadcast
    //   的 id 在同一个空间**。上面那节刚验过 id 空间一致，这里接着用它。
    const parent = await rooms.post(redis, room.hash, { from: 'Patrick', text: 'thread 父' });
    const child = await rooms.post(redis, room.hash,
      { from: 'dev', text: 'thread 子', reply_to: parent.id });
    ok(child.reply_to === parent.id, 'post 返回值里带上了 reply_to');

    const h = await rooms.history(redis, room.hash, 5);
    const hChild = h.find((x) => x.text === 'thread 子');
    const hParent = h.find((x) => x.text === 'thread 父');
    ok(hChild && hChild.reply_to === parent.id,
      '★ history 读回来的 reply_to == 父的 stream id', JSON.stringify(hChild));

    // ★★★ 迁移安全那一条。**不传 reply_to 的消息，字段必须根本不存在** ——
    //   如果写成了字符串 "null"，前端 `if (m.reply_to)` 会当真，
    //   于是**每条顶层发言都变成一条挂在不存在父消息上的回复**。
    //   那是升级 bus 之后整个房间当场变形，而且没有任何报错。
    ok(hParent && !('reply_to' in hParent),
      '★★★ 顶层发言**没有** reply_to 这个字段（不是 "null" 字符串）',
      JSON.stringify(hParent));

    // 阴性对照：确认这个断言不是平凡成立的 —— 同一个检查在子消息上必须为真
    ok('reply_to' in hChild,
      '★★ 阴性对照：同一个 `in` 检查在子消息上是 true —— 上一条不是「永远没有这个字段」');

    // broadcast 那一侧（漏了的话：实时推送当顶层，刷新后又摞回去）
    const planC = rooms.fanOutPlan({ hash: room.hash, name: 'x', members: [] }, hChild);
    ok(planC.broadcast.reply_to === parent.id,
      '★ fanOutPlan 的 broadcast 带上了 reply_to', String(planC.broadcast.reply_to));
    const planP = rooms.fanOutPlan({ hash: room.hash, name: 'x', members: [] }, hParent);
    ok(planP.broadcast.reply_to === null,
      '★ 顶层发言的 broadcast.reply_to 是 null（前端据此当根）',
      String(planP.broadcast.reply_to));
  }

  console.log('\n【13】★★★ expects_reply：房间广播默认不要求回复（否则会引发广播风暴）');
  {
    // ── 守的是什么 ────────────────────────────────────────────────
    // 会烧光订阅额度的自激：收到房间消息 → 协议说必须回
    // → 回复又是房间消息 → 扇给其余 4 人 → 1→4→16→64。
    // 掐断它的是这一个字段。**这一组断言红了，就是那个自激回来了。**

    // ① 判据函数本身。**`'false'` 那条是这一组的核心** ——
    //    坑就是「字符串 'false' 是 truthy」，不钉它等于没测。
    const T = ['true', true, 1, '1'];
    const F = ['false', 'FALSE', '0', '', 0, null, undefined, 'no', {}, []];
    for (const v of T) {
      ok(rooms.expectsReply({ expects_reply: v }) === true,
        `★ expectsReply(${JSON.stringify(v)}) === true`);
    }
    for (const v of F) {
      ok(rooms.expectsReply({ expects_reply: v }) === false,
        `★ expectsReply(${JSON.stringify(v)}) === false`);
    }
    ok(rooms.expectsReply({}) === false, '★ 字段整个缺席 → false（默认不要求回复）');
    ok(rooms.expectsReply(null) === false, '★ 连消息都没有 → false，不抛异常');

    // ② fanOutPlan：默认不要求，**broadcast 和每一条 delivery 都要带**
    const meta13 = { hash: room.hash, name: 'TEST-房间A', members: ['dev', 'JARVIS', '路人'] };
    const plainMsg = { id: '1-0', from: '路人', text: '我把日志清了' };
    const p13 = rooms.fanOutPlan(meta13, plainMsg);
    ok(p13.broadcast.expects_reply === false,
      '★★ broadcast.expects_reply === false（严格布尔，不是 undefined）',
      JSON.stringify(p13.broadcast.expects_reply));
    ok(p13.deliveries.length === 2, '（前置）扇给两个人', String(p13.deliveries.length));
    ok(p13.deliveries.every((d) => d.expects_reply === false),
      '★★★ **每一条**投递都带 expects_reply:false —— 漏一条那条就是新的火种',
      JSON.stringify(p13.deliveries));

    // ③ 显式要求回复那一半必须真的能打开 —— 否则 relay 的透传就是死代码
    const askMsg = { id: '2-0', from: 'JARVIS', text: 'dev 你回我一下', expects_reply: 'true' };
    const p13b = rooms.fanOutPlan(meta13, askMsg);
    ok(p13b.broadcast.expects_reply === true
       && p13b.deliveries.every((d) => d.expects_reply === true),
      '★★ 源头显式声明（这里是 redis 读回来的字符串 "true"）→ 两侧都是 true',
      JSON.stringify(p13b.deliveries));

    // ④ ★★★ 真过一遍 redis —— **这一条才是正控**。
    //
    //   上面全是内存里传布尔，而 bug 的成因在 `lib/queue.js` 的
    //   `flat.push(k, String(v))`：**布尔进了 redis 就变字符串**。
    //   不真走一遍的话，②③ 全绿而线上照样爆炸。
    const st13 = rooms.stream(room.hash);
    await q.send(redis, st13, {
      from: 'JARVIS', to: room.hash, text: '知会一下', agent_type: 'room',
      expects_reply: false,
    });
    const back = (await rooms.history(redis, room.hash, 1))[0];
    ok(back && back.expects_reply === 'false',
      '★★★ 正控：false 进 redis 读回来**确实是字符串 "false"** —— 坑是真的',
      JSON.stringify(back && back.expects_reply));
    // 阴性对照：朴素写法**真的会踩**。这一条让上面那组不是平凡成立的 ——
    // 它红了说明 queue 不再 String() 化，那时上面那些断言的意义也变了。
    ok(back && !!back.expects_reply === true,
      '★★ 阴性对照：`if (msg.expects_reply)` 对这条**判为真** —— 朴素写法确实中招',
      JSON.stringify(back && back.expects_reply));
    ok(rooms.expectsReply(back) === false,
      '★★★ 而 expectsReply() 对同一条判 false —— 修法在**真实数据**上成立',
      JSON.stringify(back && back.expects_reply));
    // ⑤ 从 redis 读回来的这条再走一次扇出，端到端闭合
    const p13c = rooms.fanOutPlan(meta13, back);
    ok(p13c.deliveries.every((d) => d.expects_reply === false),
      '★★★ redis 读回来的消息扇出后仍然是 false —— 端到端闭合，不是只在内存里对',
      JSON.stringify(p13c.deliveries));
  }

  // ── 【15】broadcast 补齐 done / verify / sender_type ────────────────────
  //
  //   三个字段要是只有 history 带、实时推送没带 ⇒ 刷新前后不一致：
  //   房间完成报告的桌面通知实时不弹；核验跟帖（system）实时认不出、单独成一行。
  //   ★ 核心是 `done: 'false'` 那条 —— 原样透传的话前端拿到的是 truthy 的字符串。
  console.log('\n【15】★★ broadcast 带 done / verify / sender_type（刷新前后一致）');
  {
    const stampLib = require('../lib/stamp');
    const SF = stampLib.SENDER_FIELD;
    const meta15 = { hash: 'h15', name: 'n15', members: ['a', 'b'] };
    const base = { id: '1-0', from: 'dev', text: 'x', timestamp: 't' };
    const bc = (extra) => rooms.fanOutPlan(meta15, { ...base, ...extra }).broadcast;

    ok(bc({ done: 'true' }).done === true,
      "★ done: 'true' ⇒ broadcast.done === true（布尔）", JSON.stringify(bc({ done: 'true' }).done));
    ok(bc({ done: 'false' }).done === false,
      "★★★ done: 'false' ⇒ broadcast.done === false（**不是**字符串 'false'，那是 truthy）",
      JSON.stringify(bc({ done: 'false' }).done));
    ok(bc({}).done === false,
      '★ 没有 done ⇒ broadcast.done === false（严格布尔，不是 undefined）', JSON.stringify(bc({}).done));

    ok(bc({ verify: 'pass' }).verify === 'pass', "verify: 'pass' ⇒ 原样", JSON.stringify(bc({ verify: 'pass' }).verify));
    ok(bc({}).verify === null, '没有 verify ⇒ null', JSON.stringify(bc({}).verify));

    ok(bc({ [SF]: 'system' })[SF] === 'system',
      "★ sender_type: 'system' ⇒ 原样（前端靠它认核验跟帖）", JSON.stringify(bc({ [SF]: 'system' })[SF]));
    ok(bc({})[SF] === null,
      '没有章 ⇒ null（原样，**不**改写成 readStamp 的 unknown）', JSON.stringify(bc({})[SF]));
    ok(SF === 'sender_type', '（前置）stamp 的字段名就是前端读的 sender_type', SF);

    // ★ 只加字段：deliveries 的形状不变（只改给浏览器的 broadcast）
    const plan15 = rooms.fanOutPlan(meta15, { ...base, done: 'true', verify: 'pass', [SF]: 'agent' });
    ok(plan15.deliveries.every((d) => Object.keys(d).sort().join() === 'expects_reply,member,text'),
      '★ deliveries 没被顺手加字段（只改 broadcast）', JSON.stringify(plan15.deliveries));

    // ★★ 真过一遍 redis：relay 写进流的 done 是 String() 过的；章用 stamp 的产物写
    const st15 = rooms.stream(room.hash);
    await q.send(redis, st15, {
      from: 'dev', to: room.hash, text: '【15】完成报告', agent_type: 'room',
      done: true, verify: 'pending', ...stampLib.AGENT,
    });
    await q.send(redis, st15, {
      from: 'bus', to: room.hash, text: '【15】核验跟帖', agent_type: 'room',
      done: false, verify: 'pass', ...stampLib.SYSTEM,
    });
    const h15 = await rooms.history(redis, room.hash, 5);
    const rep = h15.find((x) => x.text === '【15】完成报告');
    const fol = h15.find((x) => x.text === '【15】核验跟帖');
    ok(fol && fol.done === 'false',
      "（正控）false 进 redis 读回来确实是字符串 'false'", JSON.stringify(fol && fol.done));
    const bRep = rooms.fanOutPlan(meta15, rep).broadcast;
    const bFol = rooms.fanOutPlan(meta15, fol).broadcast;
    ok(bRep.done === true && bRep.verify === 'pending' && bRep[SF] === 'agent',
      '★★ redis 读回来的完成报告：done=true · verify 原样 · sender_type=agent',
      JSON.stringify({ done: bRep.done, verify: bRep.verify, st: bRep[SF] }));
    ok(bFol.done === false && bFol.verify === 'pass' && bFol[SF] === 'system',
      "★★★ redis 读回来的跟帖：done=false（不是 'false'）· verify=pass · sender_type=system",
      JSON.stringify({ done: bFol.done, verify: bFol.verify, st: bFol[SF] }));
  }

  // ── 【14】同名房间连着建两次：两个都要活下来 ────────────────────────
  //
  //   `makeHash` 要是 `sha1(名字:Date.now())` ⇒ 连着两次落在同一毫秒 ⇒ **同一个 hash**
  //   ⇒ 而 `create()` 的两步都是静默的：`set(META)` 直接覆盖 · `sadd(INDEX)` 去重
  //   ⇒ ⇒ **先建的那个房间消失，而没有任何一处报错。**
  //
  //   ★ 这里**不构造「同一毫秒」** —— 连着两次函数调用本来就在同一毫秒里，
  //     那是这条路径的常态。**不造场景，直接跑那条本来就会跑的路径。**
  //
  //   🔴 走 `create()` 的那条**不是**必然红的：变异掉随机之后它**照样可能绿**
  //     （两次 redis await 就够跨过一毫秒）。
  //     ⇒ ⇒ 所以判别力那条必须**直接调 makeHash**（下面 50 次那条）。
  //     ★ **「必然」这个词要有一个数在后面，否则它只是预期。**
  console.log('\n【14】同名房间连建两次 —— 两个都要活下来');
  {
    const NAME = 'TEST-同名连建';
    // ★★ 判别力最强的那条：**直接连着调 makeHash 50 次，全都不同**
    //   （按毫秒取 hash 的实现几乎做不到：set 大小只有 1–2；加了随机的实现每轮都做得到）
    //   ⇒ 走 create() 的话中间隔着两次 redis await ⇒ **那就够跨过一毫秒** ⇒ 只剩间歇红
    const many = new Set();
    for (let i = 0; i < 50; i += 1) many.add(rooms.makeHash(NAME));
    ok(many.size === 50,
      `★★ 连着调 50 次 makeHash，50 个全不同（实际 ${many.size}）`,
      String(many.size));

    const r1 = await rooms.create(redis, NAME);
    const r2 = await rooms.create(redis, NAME);
    // ⚠️ 而下面这条**不是**判别力那条：走 create() 时按毫秒取 hash 的实现只是**间歇**红 ——
    //   它留着是因为它验的是**生产路径**，而上面那条验的是那个函数。
    ok(r1.hash !== r2.hash,
      `两次同名 create 的 hash 不同（${r1.hash} vs ${r2.hash}）—— 走的是生产路径`,
      `${r1.hash} vs ${r2.hash}`);
    // ★ 而 hash 不同只是**手段**；真正要守的是下面两条：先建的那个还在不在。
    const got1 = await rooms.get(redis, r1.hash);
    const got2 = await rooms.get(redis, r2.hash);
    ok(!!got1 && !!got2,
      '★★★ 两个 meta 都读得回来 —— 后建的不覆盖先建的（set 直接覆盖会静默丢掉一个）',
      JSON.stringify({ got1: !!got1, got2: !!got2 }));
    const idx = await redis.smembers(rooms.INDEX);
    ok(idx.includes(r1.hash) && idx.includes(r2.hash),
      '★★★ 两个 hash 都在索引里 —— sadd 是集合，同 hash 会被去重掉一个',
      JSON.stringify({ has1: idx.includes(r1.hash), has2: idx.includes(r2.hash) }));
    for (const h of [r1.hash, r2.hash]) {
      await redis.del(rooms.META(h), rooms.stream(h));
      await redis.srem(rooms.INDEX, h);
    }
  }

  await redis.del(rooms.META(room.hash), st);
  await redis.srem(rooms.INDEX, room.hash);
  await redis.quit();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.message); process.exit(1); });
