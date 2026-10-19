'use strict';

/**
 * `lib/thread-count.js` —— 按 thread 数 agent 来回，超过就通知人。
 *
 * 这里是「thread-count」和「next.js」两组。
 * relay 那组在 `test/relay.test.js`【13】【14】，bus 两个人类入口在 `test/bus-auth.test.js`。
 *
 * ⚠️ 全部用 Redis **测试库**（`q.createClient()` 在 test/ 下自动抢一个）；
 *   【12】spawn 的是真的 `bin/next.js`，它拿 `ENGLOOP_TEST_DB_JOIN` 加入同一个库，
 *   探针 / 账本 / 漏填告警 / busy 五个出口全部指到临时目录。
 *
 * 变异：`scripts/mutate-thread-count.js`（不进 run-all）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const tc = require('../lib/thread-count');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));
const J = (x) => JSON.stringify(x);

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-threadcount-'));
process.on('exit', (code) => { if (code === 0) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 尽力 */ } } });

async function main() {
  const redis = q.createClient();
  const rec = (scope, id, reply_to, from, sender_type = 'agent', kind) =>
    tc.record(redis, { scope, id, reply_to, from, sender_type, kind });
  /** 两个 agent 轮流在同一条链上往下回 n 条（a 先），返回最后一条的 id 和每一条的结果。 */
  async function pingPong(scope, prefix, n, { parent = null, who = ['a', 'b'] } = {}) {
    const out = [];
    let prev = parent;
    for (let i = 0; i < n; i++) {
      const id = `${prefix}${i + 1}`;
      out.push(await rec(scope, id, prev, who[i % who.length]));
      prev = id;
    }
    return { last: prev, results: out };
  }

  console.log('\n【1】私聊链 J1→J2→J3→J4：根都是 J1（每一层都查父的根，不是直接拿 reply_to）');
  {
    const r1 = await rec('dm', 'J1', null, 'a');
    const r2 = await rec('dm', 'J2', 'J1', 'b');
    const r3 = await rec('dm', 'J3', 'J2', 'a');
    const r4 = await rec('dm', 'J4', 'J3', 'b');
    ok(r1.root === 'J1', '没有 reply_to 的那条，根就是自己', r1.root);
    ok([r2, r3, r4].every((r) => r.root === 'J1'), '★ J2 / J3 / J4 的根都是 J1', J([r2.root, r3.root, r4.root]));
    ok(J(r4.counts) === J({ a: 2, b: 2 }), '四条都数进了同一个 thread（a 2 · b 2）', J(r4.counts));
    ok((await tc.stateOf(redis, 'dm', 'J4')).root === 'J1', 'stateOf 从任意一层查回来也是 J1');
    const ttl = await redis.ttl(tc.rootKey('dm', 'J3'));
    ok(ttl > 7 * 24 * 3600 - 60 && ttl <= 7 * 24 * 3600, `根映射按条设了 TTL 7 天（实际 ${ttl}s）`);
    const sttl = await redis.ttl(tc.stateKey('dm', 'J1'));
    ok(sttl > 0 && sttl <= 7 * 24 * 3600, `计数也有 TTL（实际 ${sttl}s）—— 不会无限攒`);
  }

  console.log('\n【2】父过期（或上线之前发的）⇒ 根是 reply_to');
  {
    await rec('dm', 'P0', null, 'a');
    await rec('dm', 'P1', 'P0', 'b');
    await redis.del(tc.rootKey('dm', 'P1'));            // P1 的映射过期了
    const r = await rec('dm', 'P2', 'P1', 'a');
    ok(r.root === 'P1', '★ 查不到父的根 ⇒ 把 reply_to（P1）当根', r.root);
    const never = await rec('dm', 'Q2', 'Q-never-recorded', 'a');
    ok(never.root === 'Q-never-recorded', '从没记过的父 ⇒ 同样把 reply_to 当根', never.root);
  }

  console.log('\n【3】两方各 2 条不触发；第 3 轮（两方都到 3）才触发；之后不再触发');
  {
    const S = 'room:r3';
    const { results } = await pingPong(S, 'm', 4);
    ok(results.every((r) => !r.triggered), '★ a 2 · b 2 ⇒ 不触发（判据是 > 2，不是 ≥ 2）', J(results.map((r) => r.counts)));
    const a3 = await rec(S, 'm5', 'm4', 'a');
    ok(!a3.triggered, '★ a 3 · b 2 ⇒ 不触发（只有一方超过）', J(a3.counts));
    const b3 = await rec(S, 'm6', 'm5', 'b');
    ok(b3.triggered === true, '★★ a 3 · b 3 ⇒ 触发', J(b3));
    ok(b3.root === 'm1' && J(b3.counts) === J({ a: 3, b: 3 }), '触发时带着根和各方条数', J(b3));
    const a4 = await rec(S, 'm7', 'm6', 'a');
    const b4 = await rec(S, 'm8', 'm7', 'b');
    ok(!a4.triggered && !b4.triggered, '★★ 第 4 轮 ⇒ 不再触发（每个 thread 只告警一次）', J([a4.triggered, b4.triggered]));
    ok((await tc.stateOf(redis, S, 'm8')).alerted === true, 'stateOf：这个 thread 是「已告警」');
  }

  console.log('\n【4】一方 5 条、另一方 1 条 ⇒ 不触发（一个人自己连发不算来回）');
  {
    const S = 'room:r4';
    await rec(S, 'n1', null, 'b');
    let prev = 'n1';
    const rs = [];
    for (let i = 2; i <= 6; i++) { rs.push(await rec(S, `n${i}`, prev, 'a')); prev = `n${i}`; }
    ok(rs.every((r) => !r.triggered), '★ a 5 · b 1 ⇒ 一次都没触发', J(rs[rs.length - 1].counts));
    ok((await tc.stateOf(redis, S, prev)).alerted === false, '也没有被标成已告警');
  }

  console.log('\n【5】房间三方：只有一方超过不触发，两方超过才触发');
  {
    const S = 'room:r5';
    const { last, results } = await pingPong(S, 'k', 7, { who: ['a', 'b', 'c'] });   // a3 b2 c2
    ok(results.every((r) => !r.triggered), '★ a 3 · b 2 · c 2 ⇒ 不触发', J(results[results.length - 1].counts));
    const c3 = await rec(S, 'k8', last, 'c');
    ok(c3.triggered === true, '★ a 3 · b 2 · c 3 ⇒ 触发（两方超过）', J(c3.counts));
    const b3 = await rec(S, 'k9', 'k8', 'b');
    ok(!b3.triggered, '第三方也超过 ⇒ 不再触发（同一个 thread 只一次）', J(b3.counts));
  }

  console.log('\n【6】system 和 status 不计（无章的也不计）');
  {
    const S = 'room:r6';
    const { last } = await pingPong(S, 's', 5);            // a3 b2
    const sys = [];
    let prev = last;
    for (let i = 0; i < 3; i++) { const id = `sys${i}`; sys.push(await rec(S, id, prev, 'watchdog', 'system')); prev = id; }
    ok(sys.every((r) => !r.triggered), '★★ system 发 3 条 ⇒ 不触发（system 不是 agent）', J(sys[2].counts));
    ok(!('watchdog' in sys[2].counts), '计数里根本没有 system 的发送者', J(sys[2].counts));
    const st = [];
    for (let i = 0; i < 3; i++) { const id = `st${i}`; st.push(await rec(S, id, prev, 'b', 'agent', 'status')); prev = id; }
    ok(st.every((r) => !r.triggered) && st[2].counts.b === 2, '★ b 发 3 条 kind:status ⇒ 不计（b 仍是 2）', J(st[2].counts));
    const un = await rec(S, 'un1', prev, 'ghost', null);   // null：undefined 会落到 rec 的默认值 'agent'
    ok(!un.triggered && !('ghost' in un.counts), '没有章（unknown）⇒ 不计', J(un.counts));
    const b3 = await rec(S, 'sb3', 'un1', 'b');
    ok(b3.triggered === true, '★ 阴性对照：b 再发一条普通的 ⇒ 触发 —— 前面不触发不是因为 thread 断了', J(b3));
  }

  console.log('\n【7】人的消息清零；清零后能再触发一次');
  {
    const S = 'room:r3';                                   // 【3】那个已告警的 thread
    const h = await rec(S, 'h1', 'm8', 'Patrick', 'human');
    ok(h.root === 'm1', '人回在链的末端 ⇒ 根照样是 m1', h.root);
    const st = await tc.stateOf(redis, S, 'm8');
    ok(st.alerted === false && J(st.counts) === '{}', '★★ 计数和「已告警」全清了', J(st));
    const { results } = await pingPong(S, 'z', 6, { parent: 'h1' });
    const fired = results.filter((r) => r.triggered).length;
    ok(fired === 1 && results[5].triggered === true, '★★ 清零后再来回三轮 ⇒ 第 6 条再触发一次（只一次）',
      J(results.map((r) => r.triggered)));
    ok(J(results[5].counts) === J({ a: 3, b: 3 }), '重新从 0 数（不是接着清零前的数）', J(results[5].counts));
  }

  console.log('\n【8】并发两次 record ⇒ 只有一次 triggered');
  {
    const r2 = q.createClient();
    let bad = 0;
    for (let t = 0; t < 10; t++) {
      const S = `room:r8-${t}`;
      const { last } = await pingPong(S, 'c', 5);          // a3 b2
      const [x, y] = await Promise.all([
        tc.record(redis, { scope: S, id: 'cx', reply_to: last, from: 'b', sender_type: 'agent' }),
        tc.record(r2, { scope: S, id: 'cy', reply_to: last, from: 'b', sender_type: 'agent' }),
      ]);
      if ([x, y].filter((r) => r.triggered).length !== 1) bad++;
    }
    ok(bad === 0, `★★ 10 轮两条连接并发，每轮恰好一次 triggered（坏的 ${bad} 轮）`);
    await r2.quit();
  }

  console.log('\n【9】两个 scope 里同一个 id 互不影响');
  {
    await pingPong('dm', 'X', 6);                           // dm 里 X1..X6 ⇒ 已告警
    const roomR = await rec('room:r9', 'X2', 'X1', 'a');
    ok(roomR.root === 'X1' && J(roomR.counts) === J({ a: 1 }), '房间里的 X1 是另一个 thread（计数从 1 开始）', J(roomR));
    ok((await tc.stateOf(redis, 'dm', 'X6')).alerted === true, 'dm 那个已告警');
    ok((await tc.stateOf(redis, 'room:r9', 'X2')).alerted === false, '★ 同一个 id 的房间 thread 没被连带');
    await redis.del(tc.rootKey('room:r9', 'X2'));
    await rec('room:r9', 'Y1', null, 'a');
    await redis.set(tc.rootKey('room:other', 'Y2'), 'Z');   // 别的房间里同名 id 有映射
    const y2 = await rec('room:r9', 'Y2', 'Y1', 'b');
    ok(y2.root === 'Y1', '★ 两个房间之间也互不影响（room:<hash> 是各自的 scope）', y2.root);
    let threw = false;
    try { await rec('room', 'W1', null, 'a'); } catch (_) { threw = true; }
    ok(threw, '只写 `room` 不带 hash 的 scope ⇒ 抛（两个房间的 id 空间不能合并）');
  }

  console.log('\n【10】批量读：一次调用，跟输入一一对应；poller 用的锚点');
  {
    const rows = await tc.stateOfMany(redis, [{ scope: 'dm', id: 'X6' }, { scope: 'room:r9', id: 'X2' }, { scope: 'dm', id: 'nobody' }]);
    ok(rows.length === 3 && rows[0].alerted && !rows[1].alerted && rows[2].root === 'nobody' && !rows[2].alerted,
      '三条：已告警 / 没告警 / 从没记过（根是自己）', J(rows));
    ok(J(tc.overLimitField(rows[0])) === J({ limit: tc.LIMIT, counts: { a: 3, b: 3 } }), 'overLimitField ⇒ { limit, counts }', J(tc.overLimitField(rows[0])));
    ok(tc.overLimitField(rows[1]) === undefined, '没告警 ⇒ undefined（字段不出现）');
    ok(J(tc.anchorOfPolled({ room_hash: 'h', room_msg_id: '1-0', job_id: 'shared' })) === J({ scope: 'room:h', id: '1-0' }),
      '房间消息取 room_msg_id（不取扇出时共享的 job_id）');
    ok(J(tc.anchorOfPolled({ job_id: 'J9' })) === J({ scope: 'dm', id: 'J9' }), '私聊取 job_id');
    ok(tc.anchorOfPolled({ room_hash: 'h' }) === null, '房间消息没有 room_msg_id ⇒ null（不猜）');
    let calls = 0;
    const counting = { eval: (...a) => { calls++; return redis.eval(...a); } };
    await tc.stateOfMany(counting, [{ scope: 'dm', id: 'X1' }, { scope: 'dm', id: 'X2' }, { scope: 'room:r9', id: 'X2' }, { scope: 'dm', id: 'X3' }]);
    ok(calls === 1, `★ 四条消息只发了一个命令（一次往返；实际 ${calls}）`);
  }

  console.log('\n【11】告警：发进 orch:out，盖 system 章、kind:notice，正文有 agent 和条数、scope 和根、前 40 字、「照常投递」、怎么清零');
  {
    await redis.del('orch:out');
    const events = [];
    const S = 'room:r11';
    const { last } = await pingPong(S, 'w', 5);
    const longText = '我再补充一点：上一条里那个阈值其实应该是三，而不是二，理由如下……一二三四五六七八九十';
    const r = await tc.recordAndAlert(redis, { scope: S, id: 'w6', reply_to: last, from: 'b', sender_type: 'agent' },
      { onEvent: (e) => events.push(e), text: longText });
    ok(r && r.triggered, '（前置）这一条触发了');
    const rows = await redis.xrange('orch:out', '-', '+');
    const msgs = rows.map(([, f]) => { const o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1]; return o; });
    ok(msgs.length === 1, '★ orch:out 里恰好一条', String(msgs.length));
    const m = msgs[0] || {};
    ok(m.sender_type === 'system' && m.kind === 'notice' && m.to === 'Patrick', '★ system 章 · kind notice · 发给 Patrick', J(m));
    ok(m.from === 'JARVIS', '★ from 是编排者的名字（网页按 from 归频道 —— 写 system 就进了一个不能回复的频道）', m.from);
    ok(m.text.includes('你回复这条告警，那个 thread 的计数就清零（你的回复照常发给 JARVIS）；在那个 thread 里说话也行。'),
      '正文最后一句：回复告警即清零', m.text);
    const ref = await tc.alertRefOf(redis, m.job_id);
    ok(ref && ref.scope === S && ref.root === 'w1' && J(ref.counts) === J({ a: 3, b: 3 }) && ref.preview === `${longText.slice(0, 40)}…`,
      '★★ alertref：告警的 job_id → { scope, root, counts, preview }', J(ref));
    const rttl = await redis.ttl(tc.alertRefKey(m.job_id));
    ok(rttl > 7 * 24 * 3600 - 60 && rttl <= 7 * 24 * 3600, `alertref 的 TTL 也是 7 天（实际 ${rttl}s）`);
    ok(/a 3 条/.test(m.text) && /b 3 条/.test(m.text), '正文：哪几个 agent、各几条', m.text);
    ok(m.text.includes(`scope：${S}`) && m.text.includes('根：w1'), '正文：scope 和根的 id', m.text);
    ok(m.text.includes(`「${longText.slice(0, 40)}…」`), '正文：触发那条的前 40 个字，截断带省略号', m.text);
    ok(m.text.includes('它们没有被拦住，消息照常投递'), '正文：「它们没有被拦住，消息照常投递」');
    ok(!('reply_to' in m), '告警不挂 reply_to（orch:out 跟房间不是一个 id 空间）');
    ok(events.some((e) => e.type === 'thread_over_limit' && e.root === 'w1'), 'onEvent 报了 thread_over_limit', J(events));

    // 失败：根映射被写坏（类型不对）⇒ record 抛 ⇒ recordAndAlert 不抛、onEvent 说出来、返回 null
    await redis.hset(tc.rootKey(S, 'broken'), 'x', '1');
    const ev2 = [];
    let threw = false, ret;
    try { ret = await tc.recordAndAlert(redis, { scope: S, id: 'w7', reply_to: 'broken', from: 'a', sender_type: 'agent' }, { onEvent: (e) => ev2.push(e) }); }
    catch (_) { threw = true; }
    ok(!threw && ret === null, '★ record 抛错 ⇒ recordAndAlert 不往外抛，返回 null');
    ok(ev2.some((e) => e.type === 'thread_count_failed' && /WRONGTYPE/.test(e.error)), '★ 并且用 onEvent 说出来（thread_count_failed）', J(ev2));

    // 告警发不出去（orch:out 类型不对 ⇒ XADD 抛）⇒ 不抛、报 thread_alert_failed；「已告警」已经置上（只报一次的代价）
    await redis.del('orch:out');
    await redis.set('orch:out', 'not-a-stream');
    const S3 = 'room:r11-fail';
    const { last: l3 } = await pingPong(S3, 'f', 5);
    const ev3 = [];
    let threw3 = false;
    try { await tc.recordAndAlert(redis, { scope: S3, id: 'f6', reply_to: l3, from: 'b', sender_type: 'agent' }, { onEvent: (e) => ev3.push(e) }); }
    catch (_) { threw3 = true; }
    ok(!threw3 && ev3.some((e) => e.type === 'thread_alert_failed' && /WRONGTYPE/.test(e.error)),
      '告警发送失败 ⇒ 不抛，onEvent 报 thread_alert_failed', J(ev3));
    ok((await tc.stateOf(redis, S3, 'f6')).alerted === true, '（如实记下）这时「已告警」已经置上 —— 在人回复 / 说话之前不会再报');
    await redis.del('orch:out');
  }

  console.log('\n【11b】★★ 回复告警 ⇒ 告警记着的那个 thread 清零');
  {
    await redis.del('orch:out');
    const alertIdOf = (evs) => (evs.find((e) => e.type === 'thread_over_limit') || {}).alert_job_id;
    // 两个已告警的 thread：S（要被清的）和 S2（旁观的）
    const S = 'dm', S2 = 'room:r13';
    const { last: lA } = await pingPong(S, 'AR', 5);
    const evA = [];
    await tc.recordAndAlert(redis, { scope: S, id: 'AR6', reply_to: lA, from: 'b', sender_type: 'agent' }, { onEvent: (e) => evA.push(e), text: '第六条' });
    const alertA = alertIdOf(evA);
    const { last: lB } = await pingPong(S2, 'BR', 5);
    const evB = [];
    await tc.recordAndAlert(redis, { scope: S2, id: 'BR6', reply_to: lB, from: 'b', sender_type: 'agent' }, { onEvent: (e) => evB.push(e) });
    const alertB = alertIdOf(evB);
    ok(alertA && alertB && alertA !== alertB, '（前置）两个 thread 各告警了一次，各有一个告警 job_id', J([alertA, alertB]));

    // 回复一条普通消息（不是告警）⇒ 什么都不清
    const evN = [];
    const n1 = await tc.resetByAlertReply(redis, 'AR3', { onEvent: (e) => evN.push(e) });
    ok(n1 === null && (await tc.stateOf(redis, S, 'AR6')).alerted && (await tc.stateOf(redis, S2, 'BR6')).alerted,
      '★ 回复一条普通消息 ⇒ 不清任何 thread', J(evN));

    // alertref 不存在 / 已过期 ⇒ 什么都不做，也不报错
    const evX = [];
    let threwX = false, x;
    try { x = await tc.resetByAlertReply(redis, 'no-such-alert', { onEvent: (e) => evX.push(e) }); } catch (_) { threwX = true; }
    ok(!threwX && x === null && evX.length === 0, '★ alertref 不存在 ⇒ 返回 null，不抛、不报失败事件', J(evX));

    // 回复告警 A ⇒ 只清 A 记着的那个 thread
    const evR = [];
    const ref = await tc.resetByAlertReply(redis, alertA, { onEvent: (e) => evR.push(e) });
    ok(ref && ref.scope === S && ref.root === 'AR1', '回复告警 ⇒ 返回它记着的 thread', J(ref));
    const after = await tc.stateOf(redis, S, 'AR6');
    ok(!after.alerted && J(after.counts) === '{}', '★★ 告警记着的那个 thread：计数和「已告警」清零', J(after));
    ok((await tc.stateOf(redis, S2, 'BR6')).alerted === true, '★ 另一个 thread 不受影响');
    ok(evR.some((e) => e.type === 'thread_reset_by_alert_reply' && e.root === 'AR1'), 'onEvent 报了 thread_reset_by_alert_reply', J(evR));
    ok((await redis.get(tc.rootKey(S, 'AR6'))) === 'AR1', '清零没有改任何消息的根映射（AR6 的根仍是 AR1）');

    // 过期：删掉 B 的 alertref ⇒ 回复它不清（等价于 7 天后）
    await redis.del(tc.alertRefKey(alertB));
    await tc.resetByAlertReply(redis, alertB);
    ok((await tc.stateOf(redis, S2, 'BR6')).alerted === true, '★ alertref 过期 ⇒ 回复它什么都不做');

    // 清零后再来回 3 轮 ⇒ 再告警一次，生成一条新的 alertref
    const ev2 = [];
    let prev = 'AR6';
    for (let i = 7; i <= 12; i++) {
      const id = `AR${i}`;
      await tc.recordAndAlert(redis, { scope: S, id, reply_to: prev, from: i % 2 ? 'a' : 'b', sender_type: 'agent' }, { onEvent: (e) => ev2.push(e) });
      prev = id;
    }
    const again = ev2.filter((e) => e.type === 'thread_over_limit');
    ok(again.length === 1, '★★ 清零后再来回 3 轮 ⇒ 再告警一次（只一次）', J(again));
    const alertA2 = again[0] && again[0].alert_job_id;
    ok(alertA2 && alertA2 !== alertA && (await tc.alertRefOf(redis, alertA2)).root === 'AR1', '★ 新告警有一条新的 alertref（同一个根）', J([alertA, alertA2]));

    // 批量读：一次调用，一一对应；坏 key ⇒ 抛（给 next.js 降级用，不把「查坏了」读成「不是告警」）
    const rs = await tc.alertRefsMany(redis, [alertA2, 'AR3', 'nope']);
    ok(rs.length === 3 && rs[0] && rs[0].root === 'AR1' && rs[1] === null && rs[2] === null, 'alertRefsMany：一一对应', J(rs));
    await redis.hset(tc.alertRefKey('bad-ref'), 'x', '1');
    let threwM = false;
    try { await tc.alertRefsMany(redis, ['bad-ref']); } catch (_) { threwM = true; }
    ok(threwM, 'alertref key 类型不对 ⇒ alertRefsMany 抛（不静默当成「不是告警」）');
    await redis.del(tc.alertRefKey('bad-ref'), 'orch:out');
  }

  console.log('\n【12】真 poller（bin/next.js）：已告警 thread 里的消息带 thread_over_limit；查不了 ⇒ 没有这个字段，照常返回');
  {
    const NAME = '__tcprobe';
    const STREAM = `agent:${NAME}:in`;
    const DB = q.allocTestDb();
    const env = {
      ...process.env,
      ENGLOOP_TEST_DB_JOIN: String(DB),
      ENGLOOP_AGENT_TYPE: 'dev',
      ENGLOOP_OUTBOX_ROOT: path.join(TMP, 'outbox'),
      ENGLOOP_PROBE_STATE: path.join(TMP, 'probe-state.json'),
      ENGLOOP_WAITING_STATE: path.join(TMP, 'waiting.json'),
      ENGLOOP_THREAD_ALERT_DIR: path.join(TMP, 'thread-alert'),
      ENGLOOP_BUSY_ROOT: path.join(TMP, 'busy'),
    };
    delete env.ENGLOOP_TEST_DB;
    const poll = () => {
      let out = '', code = 0;
      try {
        out = execFileSync('node', [path.join(ROOT, 'bin/next.js'), '--group', `agent:${NAME}`, '--consumer', `${NAME}-1`,
          '--streams', STREAM, '--name', NAME, '--block', '500'], { cwd: ROOT, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
      } catch (e) { out = String(e.stdout || ''); code = e.status; }
      let json = null; try { json = JSON.parse(out); } catch (_) { /* 下面会红 */ }
      return { json, code, out };
    };
    await redis.del(STREAM);
    // 一个已告警的私聊 thread（T1..T6），再投两条进 agent 的收件流：一条在这个 thread 里，一条不在
    const { last } = await pingPong('dm', 'T', 6);
    await q.send(redis, STREAM, { job_id: 'T7', from: 'a', to: NAME, text: '接着来', reply_to: last, sender_type: 'agent' });
    await tc.record(redis, { scope: 'dm', id: 'T7', reply_to: last, from: 'a', sender_type: 'agent' });
    await q.send(redis, STREAM, { job_id: 'U1', from: 'a', to: NAME, text: '别的事', sender_type: 'agent' });
    await tc.record(redis, { scope: 'dm', id: 'U1', from: 'a', sender_type: 'agent', kind: 'notice' });
    const p1 = poll();
    const ms = (p1.json && p1.json.messages) || [];
    const t7 = ms.find((m) => m.job_id === 'T7');
    const u1 = ms.find((m) => m.job_id === 'U1');
    ok(p1.code === 0 && ms.length === 2, '（前置）poller 领到两条', p1.out.slice(0, 200));
    ok(t7 && J(t7.thread_over_limit) === J({ limit: 2, counts: { a: 4, b: 3 } }),
      '★★ 已告警 thread 里的那条带 thread_over_limit: { limit, counts }', J(t7 && t7.thread_over_limit));
    ok(u1 && !('thread_over_limit' in u1), '★ 别的 thread 里的那条没有这个字段', J(u1 && Object.keys(u1)));

    // 查询失败：这条消息的根映射被写坏 ⇒ 批量读的脚本报错 ⇒ 降级成没有这个字段
    await q.send(redis, STREAM, { job_id: 'T8', from: 'b', to: NAME, text: '再来', reply_to: 'T7', sender_type: 'agent' });
    await tc.record(redis, { scope: 'dm', id: 'T8', reply_to: 'T7', from: 'b', sender_type: 'agent' });
    await redis.del(tc.rootKey('dm', 'T8'));
    await redis.hset(tc.rootKey('dm', 'T8'), 'x', '1');
    let threwDirect = false;
    try { await tc.stateOfMany(redis, [{ scope: 'dm', id: 'T8' }]); } catch (_) { threwDirect = true; }
    ok(threwDirect, '（前置）同一个查询在这个进程里确实会抛 —— 下面那条不是「本来就查不到」');
    const p2 = poll();
    const t8 = ((p2.json && p2.json.messages) || []).find((m) => m.job_id === 'T8');
    ok(p2.code === 0 && p2.json && !p2.json.error, '★★ 查询失败 ⇒ 轮询照常返回（退出码 0，没有 error）', p2.out.slice(0, 200));
    ok(t8 && !('thread_over_limit' in t8), '★★ 这一轮的消息上没有 thread_over_limit', J(t8 && Object.keys(t8)));
    ok(t8 && t8.text === '再来', '消息本身照常给出来了');
    await redis.del(tc.rootKey('dm', 'T8'));

    // ── S1：同一轮里「没有锚点」「已告警」「没告警」三条，按这个顺序 ⇒ 只有第二条带字段
    //   （没锚点的那条不进批量查询 ⇒ states 比消息少一条；按消息下标取就会错位）
    await q.send(redis, STREAM, { job_id: 'shared-fanout', from: 'a', to: NAME, text: '没锚点', room_hash: 'r-noanchor', sender_type: 'agent' });
    await q.send(redis, STREAM, { job_id: 'T9', from: 'a', to: NAME, text: '已告警那条', reply_to: 'T7', sender_type: 'agent' });
    await tc.record(redis, { scope: 'dm', id: 'T9', reply_to: 'T7', from: 'a', sender_type: 'agent' });
    await q.send(redis, STREAM, { job_id: 'U2', from: 'a', to: NAME, text: '没告警那条', sender_type: 'agent' });
    await tc.record(redis, { scope: 'dm', id: 'U2', from: 'a', sender_type: 'agent', kind: 'notice' });
    const p3 = poll();
    const m3 = (p3.json && p3.json.messages) || [];
    ok(m3.length === 3 && m3[0].text === '没锚点' && m3[1].job_id === 'T9' && m3[2].job_id === 'U2', '（前置）三条按顺序领到', J(m3.map((m) => m.text)));
    ok(m3.length === 3 && !('thread_over_limit' in m3[0]) && m3[1].thread_over_limit && !('thread_over_limit' in m3[2]),
      '★★ S1：「没锚点 · 已告警 · 没告警」⇒ 只有第二条带 thread_over_limit', J(m3.map((m) => m.thread_over_limit || null)));

    // ── M1：Patrick 回复告警 ⇒ 那个 thread 清零、thread_over_limit 消失；他那条回复带 thread_alert_ref
    await redis.del('orch:out');
    const evT = [];
    await tc.recordAndAlert(redis, { scope: 'dm', id: 'V6', reply_to: (await pingPong('dm', 'V', 5)).last, from: 'b', sender_type: 'agent' },
      { onEvent: (e) => evT.push(e), text: 'V 的第六条' });
    const alertV = (evT.find((e) => e.type === 'thread_over_limit') || {}).alert_job_id;
    ok(Boolean(alertV), '（前置）V 那个 thread 告警了', J(evT));
    await q.send(redis, STREAM, { job_id: 'P1', from: 'Patrick', to: NAME, text: '继续吧', reply_to: alertV, sender_type: 'human' });
    await tc.record(redis, { scope: 'dm', id: 'P1', reply_to: alertV, from: 'Patrick', sender_type: 'human' });
    await tc.resetByAlertReply(redis, alertV);                       // = bin/serve.js /api/message 那一行
    await q.send(redis, STREAM, { job_id: 'P2', from: 'Patrick', to: NAME, text: '普通回复', reply_to: 'U2', sender_type: 'human' });
    await q.send(redis, STREAM, { job_id: 'V7', from: 'a', to: NAME, text: 'V 接着说', reply_to: 'V6', sender_type: 'agent' });
    await tc.record(redis, { scope: 'dm', id: 'V7', reply_to: 'V6', from: 'a', sender_type: 'agent' });
    const p4 = poll();
    const m4 = (p4.json && p4.json.messages) || [];
    const P1 = m4.find((m) => m.job_id === 'P1'), P2 = m4.find((m) => m.job_id === 'P2'), V7 = m4.find((m) => m.job_id === 'V7');
    ok(P1 && J(P1.thread_alert_ref) === J({ scope: 'dm', root: 'V1', counts: { a: 3, b: 3 }, preview: 'V 的第六条' }),
      '★★ 回复告警的那条带 thread_alert_ref: { scope, root, counts, preview }', J(P1 && P1.thread_alert_ref));
    ok(P2 && !('thread_alert_ref' in P2), '★ 回复普通消息的那条没有 thread_alert_ref', J(P2 && Object.keys(P2)));
    ok(V7 && !('thread_over_limit' in V7), '★★ 回复告警之后，那个 thread 里的新消息不再带 thread_over_limit', J(V7 && V7.thread_over_limit));

    // thread_alert_ref 查询失败 ⇒ 没有这个字段，轮询照常返回
    await q.send(redis, STREAM, { job_id: 'P3', from: 'Patrick', to: NAME, text: '再回一次', reply_to: 'bad-alert', sender_type: 'human' });
    await redis.hset(tc.alertRefKey('bad-alert'), 'x', '1');
    const p5 = poll();
    const P3 = ((p5.json && p5.json.messages) || []).find((m) => m.job_id === 'P3');
    ok(p5.code === 0 && p5.json && !p5.json.error && P3 && P3.text === '再回一次', '★ alertref 查询失败 ⇒ 轮询照常返回', p5.out.slice(0, 200));
    ok(P3 && !('thread_alert_ref' in P3), '★ 这一轮没有 thread_alert_ref', J(P3 && Object.keys(P3)));

    await redis.del(STREAM, tc.alertRefKey('bad-alert'), 'orch:out');
    await roster.unregister(redis, NAME).catch(() => {});
  }

  await redis.quit();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e); fail++; console.log(`\n  通过 ${pass} · 失败 ${fail}\n`); process.exit(1); });
