'use strict';

/**
 * 孤儿 PEL：**已掉册、但收件流 PEL 里还有滞留消息**的流。
 *
 * ── 这个洞是什么 ──────────────────────────────────────────────────
 * 重投靠 `bin/next.js` 的 `q.autoclaim`，而它挂在「有人在跑 poller」上 ——
 * 掉册的那个恰恰不跑了。被领走、进 PEL、没 ack 的消息就停在那儿，
 * **没有出口，也没有声音** —— 可以一卡好几天，直到有人手动 `XPENDING` 才撞见。
 *
 * ── ★ 这个文件里**阴性组（B）比阳性组（A）重要** ────────────────────
 * 「PEL 非空」单独**不是**告警条件 —— 在册 agent 的 PEL 经常非空（那是它
 * **正在处理**的消息）。判据漏掉「不在册」这个否决，这个告警上线第一分钟
 * 就开始对健康系统刷屏，然后被人无视，**然后真的那条也一起被无视**。
 * 所以 B1（在册 + PEL 非空 → 不报）是这一档的**主判据**，不是补充。
 */

const q = require('../lib/queue');
const roster = require('../lib/roster');
const wd = require('../lib/watchdog');
const FS = require('node:fs');
const OS = require('node:os');
const PATH = require('node:path');
// ── ★ 测试**不许读生产 `temp/outbox/`** ────────────────────────────────
//
//   `watchdog.check()` 的 `outboxRoot` 默认是 `lib/watchdog.js` 的 `OUTBOX_ROOT`
//   ＝ 生产的 `temp/outbox/`。而 `outboxIdleMs` = `now - statSync(dir).mtimeMs`
//   ⇒ **判据的输入会变成「隔壁 agent 刚才有没有说话」**。
//
//   ⚠️ 不传 root 时测试也可能是绿的，但那是**碰巧**：测试名字在 `temp/outbox/` 下
//     没有目录（⇒ `Infinity`），或者目录很久没动过（idle 远超阈值 ⇒ 行为等同 `Infinity`）。
//     ⇒ ⇒ **失效条件是「某个测试用了活 agent 的名字」** —— 而那不是任何人保证的。
//
//   ★ 所以这不是「传一个参数」，是**把一条测试与生产的边界补上** ——
//     跟「测试进程连测试库」是同一条边界的两半。
const WD_OUTBOX = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'engloop-wdtest-outbox-'));
// ★ 信号目录同理 —— 默认是生产 `temp/signals/`。不隔离的话，判级会取决于生产里有没有一个同名的信号文件，
//   而 check() 收集的「该删」名单也指向生产文件。空的临时目录 = 「没有信号」，这个文件验的正是那种情形。
const WD_SIGNALS = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'engloop-wdtest-signals-'));
process.on('exit', () => { try { FS.rmSync(WD_SIGNALS, { recursive: true, force: true }); } catch (_) { /* 清不掉就算了 */ } });
process.on('exit', () => { try { FS.rmSync(WD_OUTBOX, { recursive: true, force: true }); } catch (_) { /* 清不掉就算了 */ } });
// ★ **唯一的入口**：所有检查都走这里。别在别处直接调那个模块的方法 ——
//   那就是第二份实现，而它会静静地读回生产目录。
const wdCheck = (redis, opts = {}) => wd.check(redis, { outboxRoot: WD_OUTBOX, signalsDir: WD_SIGNALS, ...opts });


// ══ 🔴🔴 硬保护：这个文件会 `del('orch:in:agent')`（B5 要造它）═══════════
//
//   `lib/queue.js` 的 `isTestProcess` 要是判错（比如 `test/fixtures/` 下的探针被判成
//   **生产进程**）⇒ 连 db 0 ⇒ `redis.del(..., 'orch:in:agent')` **删掉编排者收件流，
//   未读消息全丢**。那个判据现在按前缀判定，
//   **但一个会 del 生产流名的测试，不该只靠上游判据正确。**
//
//   ⇒ 在这里再拦一道：db 不是测试库就**拒绝跑**，而不是「跑了再说」。
//     ⚠️ 两个条件都查：`isTestProcess()` 是判据，`options.db` 是**结果** ——
//       判据对而结果错（比如有人显式传了 url）同样致命。
const redis = q.createClient();
if (!q.isTestProcess() || redis.options.db === 0) {
  console.error('🔴 拒绝运行：这个测试会 del orch:in:agent，只能在测试库上跑。'
    + ` isTestProcess=${q.isTestProcess()} db=${redis.options.db}`);
  process.exit(1);
}

// ── fixture 命名 ────────────────────────────────────────────────────
const ORPHAN = 'wdorph1';        // 不在册 + PEL 非空  → 该报
const LIVE = 'wdorph2';          // 在册   + PEL 非空  → 不该报（B1，主判据）
const EMPTY = 'wdorph3';         // 不在册 + PEL 空    → 不该报（B2）
const NOGRP = 'wdorph4';         // 不在册 + 有流没组  → 不该报（B3）
const DEAF = 'wdorph5';          // 不在册 + PEL 非空 + **会话还在** → 归 deaf 档（B4）
const TWOGRP = 'wdorph6';        // 一条流两个组      → A6
const AGED = 'wdorph7';          // 投递过多次的老消息 → A5
const NOTSTREAM = 'wdorph8';     // 这个 key 不是流   → C3
const ALL = [ORPHAN, LIVE, EMPTY, NOGRP, DEAF, TWOGRP, AGED, NOTSTREAM];
const S = (n) => `agent:${n}:in`;
const G = (n) => `agent:${n}`;
const OUT_T = 'engloop:wdorph:out';
const ORCH_STREAM = 'orch:in:agent';
const ORCH_GROUP = 'orch';

// 会话列表可变：B4 要 DEAF 那个会话「在」，其余都不在。
let sessions = [{ name: `agent_${DEAF}`, created: 0, attached: false }];
const fakeTmux = {
  list: async () => sessions,
  exists: async (s) => sessions.some((x) => x.name === s),
  peek: async () => '',          // 空 pane ⇒ looksRateLimited=false，不会跑进 rate_limited
  nudge: async () => {},
  submit: async () => {},
};

let pass = 0; let fail = 0;
const ok = (c, l, d = '') => (c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`)));

/** 造一条「被领走但没 ack」的消息，可指定它的出生时刻（用来把年龄和 idle 拉开）。 */
async function pendingMsg(stream, group, consumer, { bornMs = null, text = 'hi' } = {}) {
  await q.ensureGroup(redis, stream, group);
  const id = bornMs ? `${bornMs}-0` : '*';
  await redis.xadd(stream, id, 'from', 'tester', 'text', text);
  await q.claimNext(redis, { streams: stream, group, consumer, blockMs: 50 });
}

async function cleanup() {
  for (const n of ALL) await redis.del(S(n));
  await redis.del(S(TWOGRP), OUT_T, ORCH_STREAM);
  for (const n of ALL) await roster.unregister(redis, n);
  await roster.unregister(redis, 'JARVIS');
  for (const n of [...ALL, 'JARVIS']) {
    await redis.del(wd.COOLDOWN_KEY('orphan_pel', n));
    await redis.del(wd.COOLDOWN_KEY('deaf', n));
  }
}

async function main() {
  await cleanup();

  // ══ 往返断言：streamToName 必须与 roster.inboxFor 互逆 ══════════════
  //   跟 `sessionToName(roster.sessionFor(n,t)) === n` 逐字同一个理由：
  //   **一方改了另一方没跟上，扫描就会把活着的流认成别人的、或者整个漏掉，
  //   而两边各自都「正常工作」，没有任何东西会变红。**
  console.log('\n【0】streamToName ⇄ roster.inboxFor 往返');
  for (const n of ['dev', 'dev2', 'resume-helper', 'a-b-c']) {
    ok(wd.streamToName(roster.inboxFor(n, 'dev')) === n, `往返 ${n}`);
  }
  ok(wd.streamToName(roster.inboxFor('JARVIS', 'orchestrator')) === null,
    '编排者的收件流（orch:in:agent）反推不出 agent 名 —— 它本来就不该进这个扫描（决定 1）');
  ok(wd.streamToName('agent:x:in:extra') === null, '形状不对的流名不认');

  // ══ 造现场 ═════════════════════════════════════════════════════════
  const bornOrphan = Date.now() - 3_600_000;              // 1 小时前
  await pendingMsg(S(ORPHAN), G(ORPHAN), `${ORPHAN}-1`, { bornMs: bornOrphan });

  // 在册 + PEL 非空。**不给 tmux_session** —— 带了会被判 stale，
  // 而 B1 要验的是「在册且正常」这一格。
  await roster.register(redis, LIVE, { type: 'dev', stream: S(LIVE) }, 300);
  await pendingMsg(S(LIVE), G(LIVE), `${LIVE}-1`);

  // 不在册 + PEL 空：建组、发消息、**领了就 ack**（PEL 归零）
  await q.ensureGroup(redis, S(EMPTY), G(EMPTY));
  const em = await q.send(redis, S(EMPTY), { from: 'tester', text: 'x' });
  const got = await q.claimNext(redis, { streams: S(EMPTY), group: G(EMPTY), consumer: 'e-1', blockMs: 50 });
  for (const m of got) await redis.xack(S(EMPTY), G(EMPTY), m.id);
  ok(em.id && got.length === 1, '（前置）EMPTY 的消息发出并被 ack 掉了');

  // 有流、**没有任何组**（从没人读过）
  await redis.xadd(S(NOGRP), '*', 'from', 'tester', 'text', 'x');

  // 会话还在 + 不在册 + PEL 非空 → 该归 deaf 档，不该归孤儿档
  await pendingMsg(S(DEAF), G(DEAF), `${DEAF}-1`);

  // 一条流两个组，**只有 alt 组卡着**。
  // ★ 这一条正是「不能用 groupFor() 推组名」的直接证明：推出来的是 G(TWOGRP)，
  //   而它 pending=0 —— 按推的走，这条流会被判成「没有滞留」。
  await q.ensureGroup(redis, S(TWOGRP), G(TWOGRP));
  await q.ensureGroup(redis, S(TWOGRP), `${G(TWOGRP)}:alt`);
  await redis.xadd(S(TWOGRP), '*', 'from', 'tester', 'text', 'x');
  await q.claimNext(redis, { streams: S(TWOGRP), group: `${G(TWOGRP)}:alt`, consumer: 'alt-1', blockMs: 50 });

  // 投递过多次的老消息：年龄很大、idle 很小 —— 决定 2 要的分叉样本
  const bornAged = 1_700_000_000_000;                      // 2023-11 的一个固定时刻
  await pendingMsg(S(AGED), G(AGED), `${AGED}-1`, { bornMs: bornAged });
  await redis.xclaim(S(AGED), G(AGED), `${AGED}-2`, 0, `${bornAged}-0`);   // 第二次投递

  // 不是流的 key
  await redis.set(S(NOTSTREAM), 'i am a string, not a stream');

  // ══ 一次 check()，验大部分判据 ══════════════════════════════════════
  console.log('\n【1】A 组：报得出来');
  const now = Date.now();
  const res = await wdCheck(redis, { tmuxApi: fakeTmux, now });
  const fs = res.findings;
  const orphanOf = (n) => fs.find((f) => f.name === n && f.level === 'orphan_pel');

  const o = orphanOf(ORPHAN);
  ok(!!o, 'A1 不在册 + PEL 非空 → 产出 finding');
  ok(o && o.level === 'orphan_pel', 'A1 level 是新档名 orphan_pel（不是 deaf/stale/live 的复用）',
    o && o.level);
  ok(o && o.stream === S(ORPHAN), `A2 流名 = ${S(ORPHAN)}`, o && o.stream);
  ok(o && o.group === G(ORPHAN), `A2 组名 = ${G(ORPHAN)}`, o && o.group);
  ok(o && o.pending === 1, 'A2 PEL 条数 = 1', o && String(o.pending));
  ok(o && Math.abs(o.oldest_age_ms - (now - bornOrphan)) < 5000,
    `A2 最老一条的年龄 ≈ 1 小时（实际 ${o && wd.fmtDur(o.oldest_age_ms)}）`,
    o && String(o.oldest_age_ms));
  ok(o && Array.isArray(o.groups) && o.groups.length === 1,
    'A2 groups[] 单组时也存在（形状统一，少见的那一支才不会成为唯一没跑到的路径）');

  console.log('\n【2】A3/A4：act() 推给人的那条消息');
  await redis.del(OUT_T, wd.COOLDOWN_KEY('orphan_pel', ORPHAN));
  const events = [];
  await wd.act(redis, [o], {
    onLog: () => {}, onEvent: (e) => events.push(e), outStream: OUT_T, tmuxApi: fakeTmux,
  });
  ok(await redis.xlen(OUT_T) === 1, 'A3 outStream 收到恰好 1 条');
  const rows = await redis.xrange(OUT_T, '-', '+');
  const msg = {};
  for (let i = 0; i < rows[0][1].length; i += 2) msg[rows[0][1][i]] = rows[0][1][i + 1];
  ok(msg.to === 'Patrick', 'A3 收件人是 Patrick', msg.to);
  ok(/watchdog/.test(msg.from), 'A3 发信人是 watchdog', msg.from);
  ok(new RegExp(S(ORPHAN)).test(msg.text), 'A4 文本里有流名');
  ok(new RegExp(G(ORPHAN)).test(msg.text), 'A4 文本里有组名');
  ok(/1 条/.test(msg.text), 'A4 文本里有条数');
  ok(/滞留 \*\*1 小时/.test(msg.text), 'A4 文本里有滞留时长', msg.text.slice(0, 200));
  ok(events.length === 1 && events[0].level === 'orphan_pel' && events[0].action === 'report'
     && events[0].throttled === false, 'A3 事件：level=orphan_pel action=report throttled=false',
  JSON.stringify(events[0] && { l: events[0].level, a: events[0].action, t: events[0].throttled }));
  ok(events[0] && events[0].type === 'watchdog',
    'A3 事件的 type 仍是路由键 watchdog（「哪一种判定」在 level 里，不许放 type）');

  console.log('\n【3】A5：滞留时长是**消息年龄**，不是 idle（决定 2）');
  const a = orphanOf(AGED);
  ok(!!a, 'A5 老消息那条流被报出来');
  ok(a && a.oldest_delivered === 2, 'A5 样本确实投递过 2 次', a && String(a.oldest_delivered));
  ok(a && a.oldest_age_ms > 600 * 86400000,
    `A5 年龄很大（${a && wd.fmtDur(a.oldest_age_ms)}）`, a && String(a.oldest_age_ms));
  ok(a && a.oldest_idle_ms < 60000, 'A5 idle 很小（刚被 XCLAIM 重新投递过）', a && String(a.oldest_idle_ms));
  // ★ 这一条是决定 2 的**核心断言**：两个数分叉时，报文里取的是大的那个。
  //   用 idle 会系统性低估，而低估的方向是让人以为不严重。
  const agedText = wd.orphanPelAlertText(a);
  ok(agedText.includes(`滞留 **${wd.fmtDur(a.oldest_age_ms)}**`),
    'A5 报文里的「滞留」= 年龄');
  ok(!agedText.includes(`滞留 **${wd.fmtDur(a.oldest_idle_ms)}**`),
    'A5 报文里的「滞留」**不是** idle（两个数此刻确实不同）',
    `age=${wd.fmtDur(a.oldest_age_ms)} idle=${wd.fmtDur(a.oldest_idle_ms)}`);

  console.log('\n【4】A6：一条流多个组，报得出是哪个组卡着');
  const tg = orphanOf(TWOGRP);
  ok(!!tg, 'A6 两组流被报出来');
  ok(tg && tg.group === `${G(TWOGRP)}:alt`,
    `A6 报的是真正卡着的那个组（${G(TWOGRP)}:alt），不是 groupFor() 推出来的 ${G(TWOGRP)}`,
    tg && tg.group);
  ok(tg && tg.groups.length === 1 && tg.groups[0].group === `${G(TWOGRP)}:alt`,
    'A6 groups[] 里只列 PEL 非空的组（空组不占位）');

  console.log('\n【5】B 组：不该报的不报 —— 这一组是主判据');
  ok(!orphanOf(LIVE), 'B1 在册 + PEL 非空 → 不报（在册 agent 的 PEL 常年非空，这是常态不是异常）');
  ok(res.orphanSkipped.some((s) => s.stream === S(LIVE) && s.why === 'in_roster'),
    'B1 而且它是**被判定跳过**的，不是压根没扫到（两者在只报 findings 的接口里同形）');
  ok(!orphanOf(EMPTY), 'B2 不在册 + PEL 空 → 不报');
  ok(res.orphanSkipped.some((s) => s.stream === S(EMPTY) && s.why === 'pel_empty'), 'B2 记为 pel_empty');
  ok(!orphanOf(NOGRP), 'B3 有流但没有任何组 → 不报');
  ok(res.orphanSkipped.some((s) => s.stream === S(NOGRP) && s.why === 'no_group'), 'B3 记为 no_group');

  const deafFs = fs.filter((f) => f.name === DEAF);
  ok(deafFs.length === 1, `B4 同一个 name 只产出一条 finding（实际 ${deafFs.length} 条）`,
    JSON.stringify(deafFs.map((f) => f.level)));
  ok(deafFs[0] && ['deaf', 'heartbeat_lost', 'rate_limited'].includes(deafFs[0].level),
    'B4 会话还在的那批归会话三档，不归孤儿档（两档处置相反：deaf 要 nudge，孤儿档没有可 nudge 的对象）',
    deafFs[0] && deafFs[0].level);
  ok(res.orphanSkipped.some((s) => s.stream === S(DEAF) && s.why === 'session_grid'),
    'B4 孤儿扫描明确记下「这个交给会话三格了」');

  console.log('\n【6】B5：orch:in:* 不在扫描范围（决定 1，正面验不靠副作用）');
  await roster.unregister(redis, 'JARVIS');       // 花名册里**没有** JARVIS
  await q.ensureGroup(redis, ORCH_STREAM, ORCH_GROUP);
  await redis.xadd(ORCH_STREAM, '*', 'from', 'tester', 'text', 'x');
  await q.claimNext(redis, { streams: ORCH_STREAM, group: ORCH_GROUP, consumer: 'orch-1', blockMs: 50 });
  const orchPel = await redis.xpending(ORCH_STREAM, ORCH_GROUP);
  ok(Number(orchPel[0]) === 1, '（前置）orch:in:agent 确实有 1 条没 ack 的 —— 判据成立的前提');
  const res2 = await wdCheck(redis, { tmuxApi: fakeTmux });
  ok(!res2.findings.some((f) => f.level === 'orphan_pel' && f.stream === ORCH_STREAM),
    'B5 orch:in:agent 有滞留、JARVIS 不在册，仍然不报（这条边界是有意的，不是遗漏）');
  ok(!res2.orphanSkipped.some((s) => s.stream === ORCH_STREAM),
    'B5 它压根没进扫描（SCAN MATCH 就不匹配），所以连 skipped 里都没有');

  console.log('\n【7】C 组：「查不了」≠「都正常」');
  // 只让**某一条流**的 XPENDING 抛错，其余照常 —— 这样能同时验 C1 和 C2。
  const brokenRedis = new Proxy(redis, {
    get(t, p) {
      if (p === 'xpending') {
        return async (stream, ...rest) => {
          if (stream === S(ORPHAN)) throw new Error('boom-xpending-injected');
          return t.xpending(stream, ...rest);
        };
      }
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  let res3;
  let threw = null;
  try { res3 = await wdCheck(brokenRedis, { tmuxApi: fakeTmux }); } catch (e) { threw = e; }
  ok(!threw, 'C2 单个流查询失败，check() 不整轮抛', threw && threw.message);
  const pf = res3 && res3.findings.find((f) => f.level === 'orphan_probe_failed' && f.stream === S(ORPHAN));
  ok(!!pf, 'C1 查不了的那条流带 probe_error 出去，**不是**被静默跳过');
  ok(pf && /boom-xpending-injected/.test(pf.probe_error), 'C1 错误原文带出来了', pf && pf.probe_error);
  ok(res3 && !res3.findings.some((f) => f.level === 'orphan_pel' && f.stream === S(ORPHAN)),
    'C1 而且它**没有**同时被报成「有滞留」—— 查不了就是查不了');
  ok(res3 && res3.findings.some((f) => f.level === 'orphan_pel' && f.stream === S(AGED)),
    'C2 其余流的判定照常产出');

  ok(res.orphanSkipped.some((s) => s.stream === S(NOTSTREAM) && s.why === 'not_a_stream'),
    'C3 SCAN 扫到非 stream 类型的 key：认成「不是流」跳过，check() 不崩'
    + '（roster.js 的 DROPOUT_KEY 注释记着同形的 WRONGTYPE 打崩过整个花名册查询）');

  console.log('\n【8】D 组：不刷屏');
  await redis.del(OUT_T, wd.COOLDOWN_KEY('orphan_pel', ORPHAN));
  const ev1 = []; const ev2 = [];
  await wd.act(redis, [o], { onLog: () => {}, onEvent: (e) => ev1.push(e), outStream: OUT_T, tmuxApi: fakeTmux });
  await wd.act(redis, [o], { onLog: () => {}, onEvent: (e) => ev2.push(e), outStream: OUT_T, tmuxApi: fakeTmux });
  ok(await redis.xlen(OUT_T) === 1, 'D1 连续两轮，推给人的消息仍然只有 1 条');
  ok(ev2.length === 1 && ev2[0].throttled === true,
    'D2 但第二轮的事件照发、带 throttled:true（不发的话，「判定仍成立」和「这轮没扫」在界面上同形）',
    JSON.stringify(ev2[0] && { a: ev2[0].action, t: ev2[0].throttled }));
  ok(ev2[0] && ev2[0].action === 'none', 'D2 第二轮 action=none（判定成立但没动手）');
  ok(wd.ORPHAN_COOLDOWN_SEC >= wd.COOLDOWN_SEC,
    `D3 冷却期 ${wd.ORPHAN_COOLDOWN_SEC}s ≥ COOLDOWN_SEC ${wd.COOLDOWN_SEC}s`);
  const ttl = await redis.ttl(wd.COOLDOWN_KEY('orphan_pel', ORPHAN));
  ok(ttl > wd.ORPHAN_COOLDOWN_SEC - 60 && ttl <= wd.ORPHAN_COOLDOWN_SEC,
    `D3 走的是既有 claimCooldown / COOLDOWN_KEY（TTL=${ttl}s），没有第二套节流器`);

  console.log('\n【9】F 组：不在 /api/agents 上显示成绿的');
  const registry = await roster.list(redis);
  const payload = wd.buildAgentsPayload(fs, registry, Date.now(), res.sessionsSeen);
  ok(!payload.live.some((x) => x.name === ORPHAN),
    'F1 孤儿流不在 live 组里（掉进 live 就是把一个掉册的流显示成「在线」）',
    payload.live.map((x) => x.name).join(','));
  ok((payload.orphan_pel || []).some((x) => x.name === ORPHAN), 'F1 它在单独的 orphan_pel 组里');
  const row = (payload.orphan_pel || [])[0];
  ok(row && row.stream && row.group && row.oldest_id && row.oldest_age_ms != null,
    'F1 orphan_pel 行带得出 stream/group/oldest_id/oldest_age_ms（不带的话人还得再敲一次 XPENDING）',
    JSON.stringify(row));
  ok(!payload.live.some((x) => x.level === 'orphan_probe_failed'),
    'F1 orphan_probe_failed 也不许掉进 live —— 那是「查不了」，显示成在线更糟');
  ok(Array.isArray(payload.deaf) && Array.isArray(payload.stale)
     && Array.isArray(payload.rate_limited) && Array.isArray(payload.live),
  'F2 既有四组仍然存在');
  ok(payload.deaf.concat(payload.stale, payload.rate_limited).every((x) => x.name !== ORPHAN),
    'F2 孤儿也没有混进既有三组');

  console.log('\n【10】E 组：只报警，不动数据');
  //   ★ 这一条**不是**读源码 grep，而是验行为：跑完上面全部 act()/check() 之后，
  //     那条被报的消息**必须原样还在 PEL 里**。
  //     判据的价值在于：滞留消息的价值在它的内容，自动处置会让
  //     「人先看一眼再决定」这个判断没机会发生。
  const stillPending = await redis.xpending(S(ORPHAN), G(ORPHAN));
  ok(Number(stillPending[0]) === 1, 'E1 被报过之后，那条消息仍然在 PEL 里（没有 ack）',
    JSON.stringify(stillPending && stillPending[0]));
  const stillThere = await redis.xrange(S(ORPHAN), `${bornOrphan}-0`, `${bornOrphan}-0`);
  ok(stillThere.length === 1, 'E1 消息本体也还在流里（没有 XDEL / XTRIM）');

  await cleanup();
  await redis.quit();
  console.log(`\n${'─'.repeat(50)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('✗ 异常:', e.stack || e.message);
  try { await cleanup(); await redis.quit(); } catch (_) { /* ignore */ }
  process.exit(1);
});
