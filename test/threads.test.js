'use strict';

/**
 * 房间消息的 thread 分组（`web/threads.js`）。
 *
 * ── 这个文件守的是什么 ──────────────────────────────────────────
 * 分组这段代码的危险**不在功能那一侧，在畸形输入那一侧**：
 *
 *   · 父消息不在这批里（history 只拉 200 条，父被截断了）
 *   · 父子互指成环 / 一条回复自己（`post()` 明确写着 reply_to **只存不验**）
 *   · 回复比父先到（乱序）
 *
 * **这三种的失败方式都是「消息静默消失」或「浏览器卡死渲染不出来」**，
 * 而后者在界面上跟「这个房间是空的」一模一样。
 *
 * ⚠️ 而这正是它不能留在 `web/app.js` 里的原因：`test/` 对 app.js 只做
 *   **源码断言**（读文件 + 正则）—— 那验得了「函数存在」，
 *   **验不了它拿到孤儿回复会不会把它吃掉**。所以抽成 UMD 模块，这里真的执行它。
 * ────────────────────────────────────────────────────────────────
 */

const T = require('../web/threads.js');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

// 造一条消息。`r` = reply_to（不传就是顶层，等同于改动之前的老消息）
const m = (id, r) => (r ? { id, from: 'x', text: 't' + id, reply_to: r }
  : { id, from: 'x', text: 't' + id });

const rootIds = (g) => g.map((t) => t.root.id);
const replyIds = (g, i) => g[i].replies.map((e) => e.id);

function main() {
  console.log('\n【1】★★ 老消息那一侧：没有 reply_to 的一律顶层，顺序不变');
  // ⚠️ 这是**迁移安全**那一条：改动之前写进流的消息全都没有 reply_to。
  //   它们必须表现得跟改动之前**一模一样**，否则升级 bus 会让所有历史房间变形。
  {
    const g = T.group([m('1'), m('2'), m('3')]);
    ok(g.length === 3, '三条老消息 = 三个根（实际 ' + g.length + '）');
    ok(JSON.stringify(rootIds(g)) === '["1","2","3"]', '★ 顺序原样保留', rootIds(g).join(','));
    ok(g.every((t) => t.replies.length === 0), '没有任何一条被当成回复');
  }

  console.log('\n【2】一层：回复挂到根下面，不再出现在顶层');
  {
    const g = T.group([m('1'), m('2', '1'), m('3')]);
    ok(JSON.stringify(rootIds(g)) === '["1","3"]', '顶层只剩 1 和 3', rootIds(g).join(','));
    ok(JSON.stringify(replyIds(g, 0)) === '["2"]', '2 挂在 1 底下');
  }

  console.log('\n【3】★★★ 孤儿回复：父不在这批里 → **当根显示，绝不吞掉**');
  // 这是最贵的一条。history?count=200 会把更早的父截断，
  // 而「回复还在、父不在」是**必然会发生**的常态，不是边缘情况。
  {
    const g = T.group([m('9', 'not-in-this-batch'), m('10')]);
    ok(g.length === 2, '两条都在，一条都没丢（实际 ' + g.length + '）');
    ok(rootIds(g).includes('9'), '★ 孤儿回复自己当了根');
    const all = JSON.stringify(g);
    ok(all.includes('"9"'), '★★ 阴性对照：它真的出现在输出里，不是「长度对但内容没了」');
  }

  console.log('\n【4】两层塌成一层（一层嵌套是定死的范围）');
  {
    const g = T.group([m('1'), m('2', '1'), m('3', '2')]);
    ok(rootIds(g).length === 1 && rootIds(g)[0] === '1', '只有一个根');
    ok(JSON.stringify(replyIds(g, 0)) === '["2","3"]',
      '★ 3 回的是 2，但它挂到根 1 上 —— 不开第二层', replyIds(g, 0).join(','));
  }

  console.log('\n【5】★★ 环 / 自指：不能卡死，也不能丢');
  // `post()` 只存不验 → 流里可以合法地出现这些。没有环保护的话
  // 浏览器会卡在 while 里，**症状是「点开房间一片空白」= 跟「房间是空的」同形**。
  {
    // ⚠️ 这条的失败方式**不是红，是挂住** —— 真死循环的话进程停在这里，
    //   `node test/threads.test.js` 永远不返回。所以「能打印出下面这行」
    //   本身就是断言内容，不需要额外的计时装置。
    const g = T.group([m('a', 'b'), m('b', 'a')]);
    ok(true, '★★ 互相指的两条没有把它卡死（能走到这一行就是通过）');
    const flat = JSON.stringify(g);
    ok(flat.includes('"a"') && flat.includes('"b"'), '★ 两条都还在输出里，没被吃掉');

    const g2 = T.group([m('s', 's')]);
    ok(JSON.stringify(g2).includes('"s"'), '★ 自己回复自己也不丢');
  }

  console.log('\n【6】乱序到达：回复排在父前面照样摞对');
  {
    const g = T.group([m('2', '1'), m('1')]);
    ok(rootIds(g).length === 1 && rootIds(g)[0] === '1',
      '★ 根是 1（不是先出现的 2）', rootIds(g).join(','));
    ok(JSON.stringify(replyIds(g, 0)) === '["2"]', '2 在它底下');
    ok(g[0].root.text === 't1', '★★ 根是**真的那条 1**，不是占位用的 2', g[0].root.text);
  }

  console.log('\n【7】★ 系统事件（没有 id）留在原来的时间位置');
  // renderFeed 头上：「watchdog / 系统事件**混在时间流里**，不另开面板 ——
  // 它跟它旁边那条发言是同一件事的两面，拆开就看不出因果了」。
  // thread 化不许把那个性质弄丢。
  {
    const sys = { sys: true, tag: 'watchdog', text: 'dev 掉册' };
    const g = T.group([m('1'), sys, m('2')]);
    ok(g.length === 3, '三项都在');
    ok(g[1].root === sys, '★ 系统事件仍然夹在 1 和 2 中间，没被推到末尾');
  }

  console.log('\n【8】★★ 正控：确认它真的在分组，不是「一律当根」');
  // 【1】那条（老消息全是根）单独看是「平凡成立」的 —— 一个什么都不做、
  // 直接把每条都当根返回的实现**也能让它绿**。所以必须有这一条来钉死：
  // **分组行为真的发生了。**
  {
    const g = T.group([m('1'), m('2', '1')]);
    ok(g.length === 1,
      '★★ 两条进去只出来一个顶层 —— 「一律当根」的实现在这里必红', String(g.length));
  }

  console.log('\n【9】空输入 / 非数组：不抛');
  {
    ok(Array.isArray(T.group([])) && T.group([]).length === 0, '空数组 → 空数组');
    ok(Array.isArray(T.group(null)), '★ null 不抛（前端 feed 可能还没初始化）');
    ok(Array.isArray(T.group(undefined)), 'undefined 不抛');
  }

  console.log('\n【10】★★★ kindOf：只有人能开话题，而 agent 没标的**不许消失**');
  {
    const K = (e) => T.kindOf(e);
    ok(K({ from: 'Patrick' }) === 'topic', '人发的、没 reply_to → topic（开话题）');
    ok(K({ from: 'Patrick', reply_to: '1-0' }) === 'reply', '人发的、有 reply_to → reply');
    ok(K({ from: 'dev', reply_to: '1-0' }) === 'reply', 'agent 回复 → reply');
    ok(K({ from: 'dev', kind: 'notice' }) === 'notice', '★ agent 标了 notice → notice');
    // ★★★ 这一条是 orphan 存在的全部理由
    ok(K({ from: 'dev' }) === 'orphan',
      '★★★ agent 发的、既没 reply_to 也没标 notice → **orphan**（协议违规，'
      + '但它必须有一个分类 —— 没有的话渲染规则会把它吃掉）');
    // 显式 kind 压过推断
    ok(K({ from: 'dev', kind: 'topic' }) === 'topic', '显式 kind 优先于「谁发的」');
    ok(K({ from: 'dev', kind: 'notice', reply_to: '1-0' }) === 'notice',
      '★ notice 压过 reply_to —— 一条通知即使挂在某处，它仍然是通知');
    // 老消息：既没 kind 也没 reply_to
    ok(K({ from: 'Patrick' }) === 'topic' && K({ from: 'dev' }) === 'orphan',
      '★ 老消息（无 kind 无 reply_to）：人的当 topic、agent 的当 orphan —— 不追溯');
    ok(K(null) === 'topic' && K(undefined) === 'topic', '空输入不抛，回落到 topic');
    // ★ 阴性对照：确认它不是「一律返回同一个值」
    const kinds = new Set([K({ from: 'Patrick' }), K({ from: 'dev' }),
      K({ from: 'dev', kind: 'notice' }), K({ from: 'dev', reply_to: '1-0' })]);
    ok(kinds.size === 4, '★★ 阴性对照：四种输入给出四个不同的分类 —— 不是恒定值',
      JSON.stringify([...kinds]));
  }

  console.log('\n【11】★★★ replyTargetIdOf：回复目标归一到**根**，永远两层');
  {
    const rows = [
      { id: 'A', from: 'Patrick', text: '话题' },
      { id: 'B', from: 'dev', text: '回复1', reply_to: 'A' },
      { id: 'C', from: 'dev', text: '回复2', reply_to: 'A' },
    ];
    const byId = new Map(rows.map((r) => [r.id, r]));
    ok(T.replyTargetIdOf(rows[0], byId) === 'A', '点话题本身 → 还是它自己');
    // ★★★ 这一条就是「两层变三层」那个 bug 本身
    ok(T.replyTargetIdOf(rows[1], byId) === 'A',
      '★★★ 点 thread 里的一条**回复** → 回复目标是**话题 A**，不是那条回复',
      T.replyTargetIdOf(rows[1], byId));
    ok(T.replyTargetIdOf(rows[2], byId) === 'A', '点另一条回复 → 同样归到 A');
    // ★ 阴性对照：如果它返回的是被点的那条，上面第二条会是 'B'
    ok(T.replyTargetIdOf(rows[1], byId) !== 'B',
      '★★ 阴性对照：**不是**返回被点的那条（返回 B 就是两层变三层）');
    // 父不在这批里 → 当根（不能吞掉）
    ok(T.replyTargetIdOf({ id: 'X', reply_to: '不存在' }, byId) === 'X',
      '★ 父不在这批里（history 截断）→ 它自己当根，**绝不丢掉**');
    // 环：A→B→A，不能卡死
    const cyc = new Map([['P', { id: 'P', reply_to: 'Q' }], ['Q', { id: 'Q', reply_to: 'P' }]]);
    const r = T.replyTargetIdOf(cyc.get('P'), cyc);
    ok(r === 'P' || r === 'Q', '★★ 环不卡死（post 明确 reply_to 只存不验，流里能有 A→B→A）', r);
    ok(T.replyTargetIdOf(null, byId) === null, '空输入返回 null，不抛');
  }

  console.log('\n【12】★★ kindOf：`status` 那一档（①.5）—— 上线报到不是违规');
  // 上线报到这类消息没有真正的信息，可以转换成一个小小的 notification。
  // ⚠️ 它必须是**单独一档**而不是 orphan：上线报到本来就不该有 reply_to，
  //   它不在回复任何人。判成违规是**判据错，不是行为错**，
  //   而一个持续误报的判据会诱使人放宽它，最后连真 orphan 也不报了。
  {
    ok(T.kindOf({ from: 'dev2', kind: 'status', text: 'dev2 已上线' }) === 'status',
      'agent 标了 status ⇒ status');
    ok(T.kindOf({ from: 'dev2', text: 'dev2 已上线' }) === 'orphan',
      '★ 阴性对照：**没标**的同一条还是 orphan —— 这一档只认显式标注');
    // ★★ 显式标注优先于结构推断：标了 status 又碰巧带 reply_to 时，
    //   作者的意思是「这是状态」。判据顺序在 kindOf 里是写死的。
    ok(T.kindOf({ from: 'dev2', kind: 'status', reply_to: 'X' }) === 'status',
      '★★ status 排在 reply_to 判定之前（不会被 reply 抢走）');
    ok(T.kindOf({ from: T.HUMAN, kind: 'status' }) === 'status',
      '人也能标 status（判据看字段，不看谁发的）');
  }

  console.log('\n【13】★★★ segments：相邻的 status 合成一段，**边界不许粘连**');
  // 这一节守的是合并显示的分段算法。它错的方式全在边界上，而每一种都不报错：
  // 粘连 → 合并行只显示最后一条的时间，于是那行谎报了它覆盖的范围；
  // 少收 → 版面没省下来；多收 → 把有对话的消息折没了。
  const st = (id, from) => ({ id, from, kind: 'status', text: from + ' 已上线' });
  const seg = (list) => T.segments(T.group(list));
  {
    // ① 相邻的合成一段
    const s = seg([st('1', 'dev'), st('2', 'dev2')]);
    ok(s.length === 1 && s[0].kind === 'status', '两条相邻 status ⇒ 一段', JSON.stringify(s.map((x) => x.kind)));
    ok(s[0].items.length === 2, '★ 两条都在里面，一条没丢');
    ok(s[0].items.map((e) => e.from).join('、') === 'dev、dev2',
      '★ 顺序按发生顺序（合并行要照它显示「dev、dev2」）');

    // ② 中间夹一条普通消息 ⇒ **断成两段**
    const s2 = seg([st('1', 'dev'), m('2'), st('3', 'dev2')]);
    ok(s2.length === 3, '★★★ 夹了普通消息 ⇒ 断开，不是粘成一段', JSON.stringify(s2.map((x) => x.kind)));
    ok(s2[0].kind === 'status' && s2[1].kind === 'thread' && s2[2].kind === 'status',
      '★★ 段的类型和顺序都对');
    ok(s2[0].items.length === 1 && s2[2].items.length === 1,
      '★ 两段各自只有一条 —— 没有跨过中间那条把它们收到一起');

    // ③ ★★ 有回复的 status **不收** —— 它已经长出对话了
    const s3 = seg([st('1', 'dev'), { id: '2', from: 'x', text: '追问', reply_to: '1' }]);
    ok(s3.length === 1 && s3[0].kind === 'thread',
      '★★★ 被回复过的 status 走普通 thread，不被折成一行', JSON.stringify(s3.map((x) => x.kind)));
    ok(s3[0].thread.replies.length === 1, '★ 那条回复还在（折掉它就是折掉一段对话）');

    // ④ 全是普通消息 ⇒ 一条一段，不许冒出 status 段
    const s4 = seg([m('1'), m('2')]);
    ok(s4.length === 2 && s4.every((x) => x.kind === 'thread'),
      '★ 阴性对照：没有 status 时不会凭空产生 status 段');

    // ⑤ 边界输入不抛
    ok(T.segments([]).length === 0, '空数组 ⇒ 空');
    ok(T.segments(null).length === 0, 'null ⇒ 空，不抛');
    ok(T.segments([null, undefined]).length === 0, '成员是空的也不抛');
  }

  console.log('\n【13.5】★★★ KINDS 是唯一出处，而这条断言随它自动扩展');
  // ══════════════════════════════════════════════════════════════
  //   提取 `KINDS` 常量**本身不够**：它保证写入侧（relay / serve）透传同一批值，
  //   **保证不了 `kindOf` 认识数组里的每个值**。少了下面这条，
  //   往 KINDS 里加一档而忘了让 kindOf 认，症状还是老样子 ——
  //   字段进了流、前端不认、落进 orphan 挂红标签，零报错。
  //
  //   ★★ 这条断言的价值在于**它自己会覆盖新值**：加一档到 KINDS，
  //   这里当场就多测一个，不需要谁记得回来补测试。
  //   > 提取常量只是把「三处」变成「两处」；**加上这条才把「记得」这个动作删掉。**
  // ══════════════════════════════════════════════════════════════
  {
    ok(Array.isArray(T.KINDS) && T.KINDS.length >= 4, 'KINDS 导出了', JSON.stringify(T.KINDS));
    for (const k of T.KINDS) {
      ok(T.kindOf({ from: 'someagent', kind: k }) === k,
        `★★ kindOf 认识 KINDS 里的 "${k}" 并原样返回`, T.kindOf({ from: 'someagent', kind: k }));
    }

    // ⚠️ `orphan` **不在** KINDS 里，这是故意的 —— 它是输出不是输入。
    //   进了数组的话 agent 就能自己标 `kind:"orphan"`，
    //   而那一档的全部意义是「没有人标它」。
    ok(!T.KINDS.includes('orphan'),
      '★★★ orphan 不在值域里 —— 它是 kindOf 的输出，不是发送者能标的输入');
    ok(T.kindOf({ from: 'someagent', kind: 'orphan' }) === 'orphan',
      '★ 就算有人硬标 orphan，也只是掉进「没标」那条路（结果一样，但不是被承认的档）');

    // ★ 阴性对照：不在值域里的值**不会**被原样返回 —— 否则上面那个 for 恒真。
    ok(T.kindOf({ from: 'someagent', kind: 'notic' }) === 'orphan',
      '★★ 拼错的 "notic" 退化成 orphan，走可见那条路');
    ok(T.kindOf({ from: 'someagent', kind: 'digest' }) === 'orphan',
      '★★ 对照：一个还没进值域的新词同样退化 —— 所以上面那个循环不是恒真');
  }

  console.log('\n【14】★★★ splitByAge：判据是**话题里最新一条**的时间，不是根的');
  // ── 这一节守的是最贵的那条判据：话题按最后活动时间折叠 ────────────────────────────
  //   一个三天前开的话题、昨天还在回 —— **它是活的**。按根的时间算会
  //   **恰好把最活跃的老话题藏起来**，而那是最不该藏的一类。
  //   症状是「我明明还在聊的那个话题不见了」，零报错。
  const HOUR = 3600e3;
  const NOW = 1786700000000;   // 固定时刻 —— 用 Date.now() 的话这几条会随时间飘
  const ma = (id, hoursAgo, r) => Object.assign(
    { id, from: 'x', text: 't' + id, at: NOW - hoursAgo * HOUR },
    r ? { reply_to: r } : {},
  );
  const split = (list) => T.splitByAge(T.segments(T.group(list)), NOW);
  {
    // ★★★ 三天前开的根 + 5 小时前的回复 ⇒ **活的，不许折**
    const s = split([ma('old', 72), ma('r', 5, 'old')]);
    ok(s.fresh.length === 1 && s.older.length === 0,
      '★★★ 老根 + 新回复 ⇒ 留在上面（按最新一条判，不是按根）',
      `fresh=${s.fresh.length} older=${s.older.length}`);
    ok(T.lastActivityOf(s.fresh[0]) === NOW - 5 * HOUR,
      '★★ 它的活动时间取的是那条回复，不是根', String(T.lastActivityOf(s.fresh[0])));

    // ★ 阴性对照：同一个根**没有**新回复时，它确实会被折走。
    //   没有这一条，上面那条可能只是「什么都不折」。
    const s2 = split([ma('old2', 72)]);
    ok(s2.older.length === 1 && s2.fresh.length === 0,
      '★★ 对照：老根**没有**新回复 ⇒ 折走 —— 所以上面那条不是「一律不折」');
  }

  console.log('\n【15】★★ 滚动 48 小时，不是自然日（午夜不许跳变）');
  {
    // 自然日的话「今天+昨天」会在午夜一到突然少掉一半。
    const s = split([ma('a', 47), ma('b', 49)]);
    ok(s.fresh.length === 1 && s.older.length === 1, '47 小时前留下、49 小时前折走',
      `fresh=${s.fresh.length} older=${s.older.length}`);
    ok(s.fresh[0].thread.root.id === 'a', '★ 留下的是 47 小时那条');
    ok(s.older[0].thread.root.id === 'b', '★ 折走的是 49 小时那条');
    // 边界：正好 48 小时算「在窗口内」（<=，不是 <）—— 边界归属要定死，
    // 否则同一条消息在两次渲染之间会左右横跳。
    ok(split([ma('c', 48)]).fresh.length === 1, '正好 48 小时 ⇒ 还在窗口内');
  }

  console.log('\n【16】★★★ 判不出时间的**一律不藏** —— 宁可碍眼，不可消失');
  {
    // m() 造的消息没有 at。判不出 ⇒ 不知道它多旧 ⇒ **绝不能降级成「很旧，藏起来」**。
    const s = T.splitByAge(T.segments(T.group([m('1'), m('2')])), NOW);
    ok(s.fresh.length === 2 && s.older.length === 0,
      '★★★ 没有 at 的消息全部留下，一条都不折', `older=${s.older.length}`);

    const s2 = T.splitByAge(T.segments(T.group([ma('x', 999)])), NaN);
    ok(s2.older.length === 0, '★★ 连「现在几点」都不知道时，同样一条都不折');

    ok(T.splitByAge(null, NOW).fresh.length === 0, 'null ⇒ 空，不抛');
    ok(T.splitByAge([], NOW).olderCount === 0, '空输入 olderCount 是 0');
  }

  console.log('\n【16b】★★★ `at` 是 ISO 字符串也认 —— 房间历史进 feed 时就是这种');
  {
    // 房间历史的 `at` 来自流里的 `timestamp`（ISO 字符串）。`lastActivityOf` 只认数字的话 ⇒
    // 房间话题一律「判不出时间」⇒ 4 天前的话题永远赖在最近区。
    const iso = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
    const mi = (id, hoursAgo, r) => Object.assign({ id, from: 'x', text: 't' + id, at: iso(hoursAgo) },
      r ? { reply_to: r } : {});
    const s49 = split([mi('r49', 80), mi('a49', 49, 'r49')]);
    ok(s49.older.length === 1 && s49.fresh.length === 0,
      '★★★ ISO 的 at：话题最新一条在 49 小时前 ⇒ 折进 older',
      `fresh=${s49.fresh.length} older=${s49.older.length}`);
    const s47 = split([mi('r47', 80), mi('a47', 47, 'r47')]);
    ok(s47.fresh.length === 1 && s47.older.length === 0,
      '★★ ISO 的 at：最新一条在 47 小时前 ⇒ 留在 fresh（对照：不是「ISO 一律折」）',
      `fresh=${s47.fresh.length} older=${s47.older.length}`);

    // 一段里数字和 ISO 混着 ⇒ 取最新的那个，不管哪种写法
    const mixA = split([ma('mx', 80), mi('mx1', 47, 'mx')]);          // 根是数字（80h），回复是 ISO（47h）
    ok(mixA.fresh.length === 1 && T.lastActivityOf(mixA.fresh[0]) === NOW - 47 * HOUR,
      '★★ 数字 + ISO 混着：最新的是 ISO 那条 ⇒ 按它算（47h，留下）',
      String(mixA.fresh[0] && T.lastActivityOf(mixA.fresh[0])));
    const mixB = split([mi('my', 80), ma('my1', 47, 'my')]);          // 反过来：根 ISO，回复数字
    ok(mixB.fresh.length === 1 && T.lastActivityOf(mixB.fresh[0]) === NOW - 47 * HOUR,
      '★★ ISO + 数字混着：最新的是数字那条 ⇒ 按它算（47h，留下）');

    // 判不出 ⇒ 仍然算新（规则不变）
    const sg = split([{ id: 'g', from: 'x', text: 'g', at: 'garbage' }]);
    ok(sg.fresh.length === 1 && sg.older.length === 0,
      "★★★ at 是 'garbage' ⇒ 仍然算新（判不出 ⇒ 不藏）");

    // 解析只有一份：derive.js 的 atMs 就是这个函数
    ok(require('../web/derive.js').atMs === T.atMs, '★ Derive.atMs === Threads.atMs（时间解析只有一份）');
  }

  console.log('\n【17】★★ olderCount 是**真数目** —— 只藏不说等于静默丢消息');
  {
    // 一段 status 折走时算它里面的条数，不是算「一段」——
    // 那一行是人判断「我错过了多少」的唯一依据。
    const oldStatus = [
      Object.assign(st('s1', 'dev'), { at: NOW - 80 * HOUR }),
      Object.assign(st('s2', 'dev2'), { at: NOW - 80 * HOUR }),
    ];
    const s = T.splitByAge(T.segments(T.group([...oldStatus, ma('new', 1)])), NOW);
    ok(s.older.length === 1 && s.older[0].kind === 'status',
      '（前置）两条老 status 合成一段被折走');
    ok(s.olderCount === 2,
      '★★★ 数的是 2 条状态，不是 1 段 —— 报「1 个话题」会瞒掉一条', String(s.olderCount));

    const s2 = T.splitByAge(T.segments(T.group([ma('o1', 80), ma('o2', 80), ma('n', 1)])), NOW);
    ok(s2.olderCount === 2, '两个老话题 ⇒ 2', String(s2.olderCount));
    ok(s2.fresh.length === 1, '新的那个没被算进去（对照）');
  }

  console.log('\n【18】★★★ 合并映射：rootIdOf 的第二种前进方式');
  // ② 手动合并。历史 append-only 改不了，所以合并走旁路映射，
  // 上溯时先查这张表。
  {
    const g = (list, merges) => T.group(list, merges);
    const rootIds = (x) => x.map((t) => t.root.id);

    // ① 基本：A 并入 B ⇒ A 那一支挂到 B 底下
    {
      const x = g([m('B'), m('A'), m('a2', 'A')], { A: 'B' });
      ok(x.length === 1 && x[0].root.id === 'B', '★★ 两个话题合成一个，根是 B',
        JSON.stringify(rootIds(x)));
      ok(x[0].replies.length === 2, '★ A 和它的回复都挂过来了，一条没丢',
        String(x[0].replies.length));
    }

    // ② 不传 merges ⇒ **老行为一字不差**（迁移安全）
    {
      const x = g([m('B'), m('A'), m('a2', 'A')]);
      ok(JSON.stringify(rootIds(x)) === '["B","A"]',
        '★★ 不传映射时还是两个话题 —— 老行为没被改动', JSON.stringify(rootIds(x)));
    }

    // ③ ★★★ 环：A 并入 B、B 又并入 A —— **必须终止，而且一条都不能丢**
    //    这条是整节最贵的：漏了就是浏览器卡死在循环里，
    //    而症状是「点开房间一片空白」，跟「这个房间是空的」一模一样。
    {
      const x = g([m('A'), m('B')], { A: 'B', B: 'A' });
      ok(x.length >= 1, '★★★ 成环不卡死（跑到这里就说明没死循环）');
      const all = JSON.stringify(x);
      ok(all.includes('"A"') && all.includes('"B"'),
        '★★★ 两条消息都还在 —— 不卡死之外，也不许丢', all.slice(0, 80));
    }

    // ④ ★★ 环 + reply_to 混合：两种跳转必须共用同一个 seen
    //    A→B 是映射，B 底下有回复 b2，而 B 又并回 A。
    //    只挡住其中一种跳转的实现会在这里转不出来。
    {
      const x = g([m('A'), m('B'), m('b2', 'B')], { A: 'B', B: 'A' });
      ok(x.length >= 1, '★★★ 混合环也不卡死');
      ok(JSON.stringify(x).includes('"b2"'), '★★ 那条回复没丢');
    }

    // ⑤ 链式：A→B→C
    {
      const x = g([m('C'), m('B'), m('A')], { A: 'B', B: 'C' });
      ok(x.length === 1 && x[0].root.id === 'C', '★★ 链式合并跟到最后那个根',
        JSON.stringify(rootIds(x)));
    }

    // ⑥ ★★ 合并目标**不在这批里**（被条数截断）—— 不许把消息弄丢或显示两遍
    {
      const x = g([m('A'), m('a2', 'A')], { A: 'gone' });
      const all = JSON.stringify(x);
      ok(all.includes('"A"') && all.includes('"a2"'), '★★★ 两条都还在', all.slice(0, 90));
      // 展示根是组里第一条；它**不能**同时又出现在 replies 里
      const dup = x[0].replies.filter((r) => r.id === x[0].root.id).length;
      ok(dup === 0, '★★★ 展示根没有在 replies 里重复出现（界面上会是同一条显示两遍）',
        `重复 ${dup} 次`);
    }

    // ⑦ 自己并入自己：不动，也不卡
    {
      const x = g([m('A')], { A: 'A' });
      ok(x.length === 1 && x[0].root.id === 'A', '★ A→A 原地不动，不死循环');
    }

    // ⑧ replyTargetIdOf 也要认映射 —— 否则新回复挂回旧根
    {
      const byId = new Map([['A', m('A')], ['B', m('B')]]);
      ok(T.replyTargetIdOf(byId.get('A'), byId, { A: 'B' }) === 'B',
        '★★ 回复一个被并走的话题，目标是合并后的根');
      ok(T.replyTargetIdOf(byId.get('A'), byId) === 'A',
        '★ 不传映射时还是它自己（对照）');
    }
  }

  console.log('\n【9】★★ isDone —— 「任务完成」判据');
  {
    // ── ① 规范化：Redis 流把所有字段过 String()，写进去的 true 读出来是 'true'
    //   ⚠️ 这一组不是「多写几个值凑数」。少认一种写法的表现是
    //   **通知不弹、🏁 不打，零报错** —— 而漏掉的那种恰好是从流里读回来的
    //   那一种（字符串），也就是**刷新页面之后走的那条路径**。
    for (const v of [true, 'true', '1', 1]) {
      ok(T.isDone({ done: v }) === true, `真值 ${JSON.stringify(v)} ⇒ done`);
    }
    for (const v of [false, 'false', 0, '0', '', null, undefined, 'yes', 'DONE']) {
      ok(T.isDone({ done: v }) === false, `假值 ${JSON.stringify(v)} ⇒ 不是 done`);
    }
    ok(T.isDone({}) === false, '没有这个字段 ⇒ 不是 done（老消息那一侧）');
    ok(T.isDone(null) === false, 'null 不炸');
    ok(T.isDone(undefined) === false, 'undefined 不炸');

    // ── ② ★★★ 正交性 —— **这一条是这个设计存在的全部理由**
    //
    //   为什么用独立字段而不用 `kind:"done"`：
    //   `kindOf` 第一行「显式标注优先于结构推断」会让一条 kind:'done'
    //   的消息**不再返回 'reply'** ⇒ 它从自己的 thread 里掉出来渲染成顶层，
    //   而另一半需求恰恰要那条 thread 的根。
    //
    //   ⚠️ 下面两条断言是给**未来那个想把 done 并回 kind 的人**准备的：
    //   他一改，这两条立刻红。没有它们的话，那个改动会静静通过全量，
    //   症状要等到某条完成报告在界面上跳到顶层才被发现。
    {
      const done = { id: 'X', from: 'dev2', text: 't', reply_to: 'ROOT', done: true };
      ok(T.kindOf(done) === 'reply',
        '★★★ done + reply_to ⇒ 仍然是 reply（done 不抢 kind 的位子）');
      ok(T.isDone(done) === true, '★★★ 同一条消息同时是 done —— 两个维度并存');
    }
    ok(!T.KINDS.includes('done'),
      "★★★ 'done' 不在 KINDS 里 —— 它是正交维度，不是第五档 kind");

    // ── ③ kind 的四档都不该被 isDone 误判成完成
    for (const k of T.KINDS) {
      ok(T.isDone({ kind: k }) === false, `kind:'${k}' 本身不构成 done`);
    }
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  if (fail) process.exit(1);
}

main();
