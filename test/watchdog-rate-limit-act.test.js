'use strict';

/**
 * rate_limited 出口的**处置层** —— `act()` 里那个出口。
 *
 * 纯函数那半边（解析、上界、fail-closed 三档、变异）在
 * `watchdog-rate-limit-exit.test.js`。这里验的是**它接上 redis 和 tmux 之后**：
 * 什么时候唤醒、唤醒几次、什么时候停手、停手说不说得出口。
 *
 * ── ⚠️ 施工纪律（X1/X2）─────────────────────────────────────────
 *   本文件不出现任何能命中 `RATE_LIMIT_RE` 的字面文本；
 *   pane 文本一律从 `test/fixtures/rate-limit-panes/` 读，或用只命中
 *   **出口**判据的最小构造串。文件末尾有自查。
 */

const fs = require('node:fs');
const path = require('node:path');
const watchdog = require('../lib/watchdog');
const q = require('../lib/queue');

let pass = 0; let fail = 0;
const ok = (c, l, d = '') => (c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`)));

const OUT_T = 'engloop:wdrl:out';
const NAME = 'rlcrew';
const SESSION = 'agent_rlcrew';
const H = 3600 * 1000;

const REAL = path.join(__dirname, 'fixtures', 'synthetic', 'rate-limit-panes', 'line-only.txt');

// 锚点与解出的时刻：**手算，不问被测代码**。
const SINCE = Date.parse('2026-08-20T18:24:00Z');
const RESET_AT = Date.parse('2026-08-20T21:10:00Z');   // 2:10pm PDT = UTC−7

/** 造一个 rate_limited 的 finding。hint 默认取真实 fixture 解出来的那份。 */
function finding(over = {}) {
  return {
    name: NAME,
    type: 'dev',
    tmux_session: SESSION,
    stream: 'engloop:wdrl:in',
    group: 'agent:rlcrew',
    idleMs: 900_000,
    pending: 0,
    level: 'rate_limited',
    rate_limit_hint: watchdog.extractResetHint(fs.readFileSync(REAL, 'utf8')),
    ...over,
  };
}

function makeTmux() {
  const calls = [];
  return {
    calls,
    list: async () => [],
    exists: async () => true,
    nudge: async (s, k) => { calls.push({ kind: 'nudge', s, k }); },
    submit: async (s, t) => { calls.push({ kind: 'submit', s, t }); },
    peek: async () => '',
  };
}

/** 清掉这个 agent 的全部出口状态与冷却 —— 每个用例都从干净起点开始。 */
async function reset(redis, { keepState = false, keepCooldown = false, since = SINCE } = {}) {
  if (!keepState) {
    await redis.del(watchdog.RL_SINCE_KEY(NAME), watchdog.RL_WAKES_KEY(NAME));
    // 🔴 **预置锚点**，模拟「它早就撞墙了」。
    //   不预置的话 act() 会 SET NX 把锚点写成**本轮的 now** ——
    //   于是解出的重置时刻永远落在 now 之后 ⇒ **永远走「还没到点」那条分支**，
    //   而 E3/C4/R1 全都验不到。
    //   ★ 症状是 E3 拿到 submit 次数 0，看起来像「出口没实现」，
    //     实际是**测试自己把锚点设成了未来**。
    if (since != null) await redis.set(watchdog.RL_SINCE_KEY(NAME), String(since));
  }
  if (!keepCooldown) {
    for (const kind of ['rate_limited', 'rate_limit_wake', 'rate_limit_blind',
      'rate_limit_giveup']) {
      await redis.del(watchdog.COOLDOWN_KEY(kind, NAME));
    }
  }
}

async function runAct(redis, findings, { now, tmuxApi }) {
  const events = [];
  const logs = [];
  await watchdog.act(redis, findings, {
    onLog: (m) => logs.push(m),
    onEvent: (e) => events.push(e),
    outStream: OUT_T,
    tmuxApi,
    now,
  });
  return { events, logs };
}

/** 取本轮推给人的那几条告警文本。 */
async function outTexts(redis, sinceId = '-') {
  const rows = await redis.xrange(OUT_T, sinceId, '+');
  return rows.map(([, f]) => {
    const o = {};
    for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1];
    return o.text || '';
  });
}

async function main() {
  console.log('\n══ rate_limited 出口 · 处置层（任务 E）══════════════\n');
  const redis = q.createClient();

  // ⛔ 硬闸：这个文件会 del 若干 key、往流里写东西。**只能在测试库上跑。**
  if (!q.isTestProcess() || redis.options.db === 0) {
    console.error('🔴 拒绝运行：这个测试会写 redis，只能在测试库上跑。');
    process.exit(1);
  }
  await redis.del(OUT_T);

  // ═══ ⓪ 正控 ═══════════════════════════════════════════════════════
  console.log('━━ ⓪ 正控 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ok(redis.options.db !== 0, `连的是测试库（db ${redis.options.db}）`);
  const hint0 = finding().rate_limit_hint;
  ok(hint0 && hint0.raw && hint0.tz === 'America/Los_Angeles',
    'fixture 提得出线索（这是下面所有用例的输入）', JSON.stringify(hint0));
  ok(watchdog.resolveResetAt(hint0, SINCE).at === RESET_AT,
    `手算对账：解出的重置时刻 = ${new Date(RESET_AT).toISOString()}`);

  // 🔴 阴性对照：这套装置**抓得到 submit** 吗？先用 deaf 证明一次。
  {
    await reset(redis);
    for (const k of ['deaf']) await redis.del(watchdog.COOLDOWN_KEY(k, NAME));
    const t = makeTmux();
    await runAct(redis, [finding({ level: 'deaf', rate_limit_hint: undefined })],
      { now: SINCE, tmuxApi: t });
    ok(t.calls.some((c) => c.kind === 'submit'),
      '🔴 阴性对照：deaf 那一档**确实会 submit** ⇒ 下面「没有 submit」是真的没有，'
      + '不是这套装置抓不到', JSON.stringify(t.calls));
  }

  // ═══ E2：还没到点 ⇒ 不唤醒，但照常告警 ═══════════════════════════
  console.log('\n━━ E2 · 重置时刻之前 ━━━━━━━━━━━━━━━━━━━━━━━━');
  {
    await reset(redis);
    // ⚠️ 清掉上一格阴性对照（deaf）写进去的告警 —— 否则 outTexts 读到的是它的
    await redis.del(OUT_T);
    const t = makeTmux();
    const { events } = await runAct(redis, [finding()], { now: SINCE + 60_000, tmuxApi: t });
    ok(t.calls.length === 0, '🔴 E2 一次 submit / nudge 都没有', JSON.stringify(t.calls));
    ok(events.length === 1 && events[0].level === 'rate_limited',
      'E2 仍然发了事件（不唤醒 ≠ 不吭声）', JSON.stringify(events.map((e) => e.level)));
    ok(/预计 .*已过|预计/.test(events[0].text) && events[0].text.includes('未唤醒'),
      'E2 文案说清了「预计什么时候恢复 + 本轮没唤醒」', events[0].text.slice(0, 80));
    const texts = await outTexts(redis);
    ok(texts.length === 1 && texts[0].includes('你也不要手动推'),
      '🔴 E2 推给人的告警里保留了那句「你也不要手动推」');
    ok(texts[0].includes(new Date(RESET_AT).toISOString()),
      '🔴 E2 告警里带了**具体的恢复时刻**，不是「等等看」', texts[0].slice(0, 60));
  }

  // ═══ E3 + C4：到点 ⇒ 唤醒恰好一次 ═══════════════════════════════
  console.log('\n━━ E3 / C4 · 重置时刻之后 ━━━━━━━━━━━━━━━━━━━');
  {
    await reset(redis);
    await redis.del(OUT_T);
    const t = makeTmux();
    // 🔴 `now` 必须越过 `WAKE_MARGIN_MS`（90s）：`RESET_AT + 60_000` 落在**边际之内**，
    //   那时一次 submit 都不该有（见 E4）。
    //   ⚠️ **跟着 `WAKE_MARGIN_MS` 走，不写死 90_000**：判据自己写一个数
    //     就是第二份实现，而它分叉时会「守着一个没人用的数」全绿。
    const r1 = await runAct(redis, [finding()],
      { now: RESET_AT + watchdog.WAKE_MARGIN_MS + 60_000, tmuxApi: t });
    ok(t.calls.length === 1 && t.calls[0].kind === 'submit',
      '🔴 E3 到点之后**唤醒了，而且只有一次 submit**', JSON.stringify(t.calls));
    ok(t.calls[0].t === watchdog.RATE_LIMIT_WAKE_TEXT,
      '🔴 E3 发的是**这一档专用**的唤醒文本，不是 deaf 那条'
      + '（两种情况下 agent 需要知道的事不一样）');
    ok(r1.events[0] && r1.events[0].action === 'submit',
      'E3 事件的 action 是 submit', JSON.stringify(r1.events.map((e) => e.action)));

    // C4：同一个冷却周期内再跑一轮 ⇒ **不许再唤醒**
    const before = t.calls.length;
    // 🔴 这一处也要跟着 + WAKE_MARGIN_MS —— 而理由跟上面那条**不同**：
    //   不是「它落在边际内」，是**它必须仍然排在 r1 之后**。
    //   ⇒ r1 是 `+ MARGIN + 60s`（= +150s），这里只写 `+120s` 就跑到 r1 **前面**去了
    //   ⇒ ⇒ 时间倒流 ⇒ C4 那两条会红（两次 submit，而冷却没拦住）
    const r2 = await runAct(redis, [finding()],
      { now: RESET_AT + watchdog.WAKE_MARGIN_MS + 120_000, tmuxApi: t });
    ok(t.calls.length === before,
      '🔴 C4 一个冷却周期内**不会唤醒第二次**', JSON.stringify(t.calls));
    ok(r2.events[0] && r2.events[0].throttled === true,
      '🔴 C4 而它**说了自己被冷却拦住**（throttled=true）—— 不是静默跳过',
      JSON.stringify(r2.events.map((e) => ({ a: e.action, t: e.throttled }))));

    const wakes = Number(await redis.get(watchdog.RL_WAKES_KEY(NAME)));
    ok(wakes === 1, '🔴 C4 唤醒计数是 1（被拦下那次不计数）', String(wakes));
  }

  // ═══ 🔴 E4 · **边际区间内**：到点了，而还没到「到点 + 边际」⇒ 不唤醒 ═════
  //
  //   ── 🔴 它防什么（构造场景）──────────────────
  //     **hint 解析对了、gap 也正常，而 `now` 恰好落在 `resolved.at` 前后几十秒。**
  //
  //   ⚠️ 「首轮发现就唤醒、比重置早了十分钟」走的是 `staleHint` 那一支
  //     （`gap > 12h` ⇒ 判成陈提示），**不在这个边际的射程内**，由 F 组守。
  //   ★ 下面那三层代价（白撞 / 烧配额 / 冷却一小时）对**任何**过早唤醒都成立，
  //     跟走哪条路径无关。
  //   🔴 代价是三层叠加：① 白撞一次 ② 烧掉 **1/3** 的唤醒配额
  //     ③ **冷却一小时**（`WAKE_COOLDOWN_SEC`）⇒ 重置只晚了几秒，代价是一小时停摆。
  //
  //   ★ 而 ② 那一层是这条判据真正要守的：`RL_WAKES_KEY` 数的是「**反复撞墙**」，
  //     而**一次「早了几秒」在那个计数器上，跟一次「它真的还没恢复」完全一样**。
  //   ⇒ ⇒ 所以下面第二条（`rl_wakes` 没有 +1）比第一条更要紧：
  //     不 submit 只是这一轮没动作，而**不 incr 才是没烧掉配额**。
  {
    await reset(redis);
    await redis.del(OUT_T);
    const tMid = makeTmux();
    const wakesBefore = Number(await redis.get(watchdog.RL_WAKES_KEY(NAME))) || 0;
    await runAct(redis, [finding()],
      // ★ 落在 `[at, at + margin)` 正中间 —— 跟着常量走，不写死
      { now: RESET_AT + Math.floor(watchdog.WAKE_MARGIN_MS / 2), tmuxApi: tMid });
    ok(tMid.calls.length === 0,
      '🔴 E4① **到点了但还在边际内 ⇒ 一次 submit 都没有** —— 落在边际内就不能唤醒',
      JSON.stringify(tMid.calls));
    const wakesAfter = Number(await redis.get(watchdog.RL_WAKES_KEY(NAME))) || 0;
    ok(wakesAfter === wakesBefore,
      '🔴🔴 E4② 而 `rl_wakes` **没有 +1** —— 配额一格都没烧掉。'
      + '（这一条比 ① 要紧：不 submit 只是这一轮没动作，不 incr 才是没烧配额）',
      JSON.stringify({ before: wakesBefore, after: wakesAfter }));

    // ── 🔴 E4③ 文案必须跟行为一致 ────────────────────────────────
    //   ★ 加了边际之后，**实际唤醒不早于 `at + margin`** ——
    //     而文案只说 `at` 的话，人会在那一刻去看、发现它没醒，然后以为坏了。
    //   ⇒ 这条守的是「**行为变了，而说话那一层没跟着改**」。
    const midTexts = await outTexts(redis);   // ← 这个文件用的是 outTexts，不是 drain
    const atIso = new Date(RESET_AT).toISOString();
    const wakeIso = new Date(RESET_AT + watchdog.WAKE_MARGIN_MS).toISOString();
    ok(midTexts.some((t) => t.includes(wakeIso)),
      '🔴 E4③ 告警文案里出现的是**实际唤醒时刻**（at + 边际），不只是 at',
      JSON.stringify({ wakeIso, sample: (midTexts[0] || '').slice(0, 120) }));
    ok(midTexts.some((t) => t.includes(atIso)),
      'E4④ 而 at 本身也还在（人要知道上游说的是几点）', JSON.stringify(atIso));
  }

  // ═══ R1 / R2：连续 N 次仍在这一档 ⇒ 停手，而且说出口 ═════════════
  console.log('\n━━ R1 / R2 · 反复撞墙 ━━━━━━━━━━━━━━━━━━━━━━━');
  {
    await reset(redis);
    await redis.del(OUT_T);
    const t = makeTmux();
    // 连唤醒 MAX 次（每次手动清冷却，模拟「过了一个冷却周期」）
    for (let i = 0; i < watchdog.MAX_WAKE_ATTEMPTS; i += 1) {
      await redis.del(watchdog.COOLDOWN_KEY('rate_limit_wake', NAME));
      // eslint-disable-next-line no-await-in-loop
      await runAct(redis, [finding()], { now: RESET_AT + (i + 1) * H, tmuxApi: t });
    }
    ok(t.calls.length === watchdog.MAX_WAKE_ATTEMPTS,
      `🔴 R1 前 ${watchdog.MAX_WAKE_ATTEMPTS} 轮各唤醒一次（共 ${t.calls.length} 次）`,
      String(t.calls.length));

    // 第 MAX+1 轮：**必须停手**
    await redis.del(watchdog.COOLDOWN_KEY('rate_limit_wake', NAME));
    const before = t.calls.length;
    const { events } = await runAct(redis, [finding()],
      { now: RESET_AT + 10 * H, tmuxApi: t });
    ok(t.calls.length === before,
      `🔴 R1 第 ${watchdog.MAX_WAKE_ATTEMPTS + 1} 轮**不再唤醒** —— 停手了`,
      JSON.stringify(t.calls.length));
    ok(events[0] && /停止自动唤醒/.test(events[0].text),
      '🔴 R2 停手时**明说「我已经停止自动唤醒它了」** —— '
      + '「一直在自动恢复」和「恢复不了但没人知道」在日志上长得一样',
      events[0] ? events[0].text.slice(0, 60) : '(无事件)');
    const texts = await outTexts(redis);
    const last = texts[texts.length - 1] || '';
    ok(last.includes('停止自动唤醒') && /\d+\s*\*?\*?次/.test(last),
      '🔴 R2 推给人的那条里**带上已经试了几次**', last.slice(0, 70));
    ok(last.includes('该你了') || last.includes('建议'),
      '🔴 R2 而且给了**建议动作** —— 停手不是终点，是交接', last.slice(-60));
  }

  // ═══ R3（正控）：中途有一轮不是 rate_limited ⇒ 计数清零 ═══════════
  console.log('\n━━ R3 · 计数清零（正控）━━━━━━━━━━━━━━━━━━━━━');
  {
    await reset(redis);
    await redis.set(watchdog.RL_WAKES_KEY(NAME), '2');
    const t = makeTmux();

    // 🔴 关键：`ok` 这一档在 act() 里会 `continue` —— 清零必须发生在它**之前**
    await runAct(redis, [finding({ level: 'ok' })], { now: RESET_AT, tmuxApi: t });
    const wakes = await redis.get(watchdog.RL_WAKES_KEY(NAME));
    const since = await redis.get(watchdog.RL_SINCE_KEY(NAME));
    ok(wakes === null && since === null,
      '🔴 R3 它这一轮判成 ok ⇒ 唤醒计数与锚点**都被清掉**'
      + '（否则一个偶尔醒过来的 agent 会被永久停手）',
      JSON.stringify({ wakes, since }));

    // 而清零之后，它再撞墙时是从零开始数的
    // ⚠️ 清零把**锚点也清了** —— 这是对的：新的撞墙事件有新的锚点。
    //   ⇒ 这里要重新预置一个「过去的」锚点，否则 act() 会把锚点设成本轮的 now，
    //     解出的重置时刻落在未来 ⇒ 走「还没到点」那条，看起来像「唤不醒了」。
    //   ★ 不重新预置的话这条会红，而红的原因**恰恰是清零起作用了**。
    await redis.set(watchdog.RL_SINCE_KEY(NAME), String(SINCE));
    await redis.del(watchdog.COOLDOWN_KEY('rate_limit_wake', NAME));
    await runAct(redis, [finding()], { now: RESET_AT + H, tmuxApi: t });
    ok(t.calls.length === 1, '🔴 R3 清零之后再撞墙 ⇒ **又能唤醒了**，不是接着上次的余额数',
      JSON.stringify(t.calls.length));

    // ★ 阴性对照：如果这一轮仍是 rate_limited，计数**不该**被清
    await redis.set(watchdog.RL_WAKES_KEY(NAME), '2');
    await runAct(redis, [finding()], { now: RESET_AT + H, tmuxApi: t });
    ok((await redis.get(watchdog.RL_WAKES_KEY(NAME))) !== null,
      '★ R3 阴性对照：仍是 rate_limited 的那一轮**没有**清零 ⇒ 清零是有条件的，不是每轮都清');
  }

  // ═══ C7：三种告警彼此可辨识 ═══════════════════════════════════════
  console.log('\n━━ C7 · 告警可辨识 ━━━━━━━━━━━━━━━━━━━━━━━━━');
  {
    const collected = {};
    const cases = [
      ['normal', finding(), RESET_AT - H],
      ['no_time', finding({ rate_limit_hint: { reason: 'no_time' } }), RESET_AT],
      ['bad_tz', finding({ rate_limit_hint: { reason: 'bad_tz' } }), RESET_AT],
      ['no_detected_at', finding(), RESET_AT],
    ];
    for (const [tag, f, now] of cases) {
      // eslint-disable-next-line no-await-in-loop
      await reset(redis);
      // eslint-disable-next-line no-await-in-loop
      await redis.del(OUT_T);
      if (tag === 'no_detected_at') {
        // 制造「锚点丢了」：把 since 写成一个非数字，模拟 redis 里的脏值
        // eslint-disable-next-line no-await-in-loop
        await redis.set(watchdog.RL_SINCE_KEY(NAME), 'not-a-number');
      }
      // eslint-disable-next-line no-await-in-loop
      const { events } = await runAct(redis, [f], { now, tmuxApi: makeTmux() });
      collected[tag] = (events[0] && events[0].text) || '';
    }
    const keys = Object.keys(collected);
    ok(keys.every((k) => collected[k].length > 0), 'C7 四种情况都发出了告警',
      JSON.stringify(Object.fromEntries(keys.map((k) => [k, collected[k].length]))));
    ok(new Set(Object.values(collected)).size === 4,
      '🔴 C7 四条告警**两两不同** —— 估算档 / 三种 fail-closed / 普通档分得开',
      JSON.stringify(Object.fromEntries(
        Object.entries(collected).map(([k, v]) => [k, v.slice(24, 52)]))));
    ok(!collected.normal.includes('我没有唤醒它')
      && collected.no_time.includes('我没有唤醒它'),
      '🔴 C7 fail-closed 档明说「我没有唤醒它」，而普通档不说这句');
    ok(collected.no_detected_at.includes('丢了'),
      '🔴 C7 锚点丢失这一档说的是「我自己丢了状态」，而不是「它的文案有问题」'
      + ' —— 两者要人做的事完全不同', collected.no_detected_at.slice(20, 70));
  }

  // ═══ 🔴 E2-8 · 端到端：**从真实 40 行 pane 到真的产生唤醒动作** ═════════
  //
  //   ── 为什么要端到端 ──────────────────────────────
  //     判据全部落在解析层时，没有一条落在「出口真的开了」这个终端效果上：
  //     解析层每一条都绿，而出口可以从来没生效过。
  //
  //   ⇒ 所以这里不喂构造串、也不喂单行样本 —— 喂**生产实际递给它的东西**：
  //     一份完整 40 行的真实 pane，走完 `extractResetHint → act → tmux.submit`。
  //
  //   ⚠️ 而它跟上面那些 act 用例的区别只有一个：**hint 从哪来**。
  //     上面是 `line-only-` 那一行，这里是 40 行整段 —— 而「整段取第一个」那个 bug
  //     **只在后者上出现**。同一条链，同一个断言，换一个切片就红。
  console.log('\n━━ 🔴 E2-8 · 端到端（真实 40 行 pane）━━━━━━━━━');
  {
    const PANE_ORCH = path.join(__dirname, 'fixtures', 'synthetic', 'rate-limit-panes',
      '40lines-orch.txt');
    const pane = fs.readFileSync(PANE_ORCH, 'utf8');

    // ⓪ 正控：这份样本确实是 40 行，而且确实会被入口判据命中
    ok(pane.split('\n').length >= 40,
      `⓪ E2-8 样本是 ${pane.split('\n').length} 行（= 生产 peek 的切片）`);
    ok(watchdog.looksRateLimited(pane) === true,
      '⓪ E2-8 样本会被入口判据命中 ⇒ 它确实会走到 rate_limited 那一档');

    const hint = watchdog.extractResetHint(pane);
    ok(hint.tz === 'America/Los_Angeles',
      '🔴 E2-8① 40 行真实 pane → tz = America/Los_Angeles', JSON.stringify(hint));

    // 锚点 = 撞墙那一刻；重置时刻 19:10 PDT = 次日 02:10Z（手算对账）
    const SINCE_E2 = Date.parse('2026-08-20T18:24:00Z');
    const RESET_E2 = Date.parse('2026-08-21T02:10:00Z');
    ok(watchdog.resolveResetAt(hint, SINCE_E2).at === RESET_E2,
      '🔴 E2-8② 解出的重置时刻 = 2026-08-21T02:10:00Z（19:10 PDT，UTC−7，手算）',
      new Date(watchdog.resolveResetAt(hint, SINCE_E2).at).toISOString());

    // ── ③ 重置时刻**之前** ⇒ 不唤醒（而这一条同时是 ④ 的正控）─────────
    await reset(redis, { since: SINCE_E2 });
    await redis.del(OUT_T);
    const tBefore = makeTmux();
    await runAct(redis, [finding({ rate_limit_hint: hint })],
      { now: RESET_E2 - 60_000, tmuxApi: tBefore });
    ok(tBefore.calls.length === 0,
      '🔴 E2-8③ 重置时刻**之前**：一次 submit 都没有', JSON.stringify(tBefore.calls));

    // ── ④ 重置时刻**之后** ⇒ **真的唤醒** ───────────────────────────
    //   ★ 这一条验的是**终端效果**，不是解析层。
    await reset(redis, { since: SINCE_E2 });
    const tAfter = makeTmux();
    const r = await runAct(redis, [finding({ rate_limit_hint: hint })],
      // 🔴 同上：+ WAKE_MARGIN_MS（`RESET_E2 + 60_000` 落在边际内）
      { now: RESET_E2 + watchdog.WAKE_MARGIN_MS + 60_000, tmuxApi: tAfter });
    ok(tAfter.calls.length === 1 && tAfter.calls[0].kind === 'submit',
      '🔴🔴 E2-8④ 重置时刻**之后**：从一份真实 40 行 pane 出发，**真的产生了唤醒动作**',
      JSON.stringify(tAfter.calls));
    ok(tAfter.calls[0].t === watchdog.RATE_LIMIT_WAKE_TEXT,
      'E2-8④ 发的是这一档专用的唤醒文本');
    ok(r.events[0] && r.events[0].action === 'submit',
      'E2-8④ 事件 action = submit', JSON.stringify(r.events.map((e) => e.action)));

    // ── 🔴 ⑤ 变异：把锚定改回「整段取第一个」⇒ ④ 必须红 ────────────────
    //   ★ 而这一条验的是「**E2-8④ 的绿是锚定挣来的**」——
    //     没有它，④ 可能只是「这份样本恰好没有污染行」。
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'watchdog.js'), 'utf8');
    const mutHint = (() => {
      const a = src.indexOf('function extractResetHint');
      let pd = 0; let i = src.indexOf('(', a);
      for (; i < src.length; i += 1) {
        if (src[i] === '(') pd += 1;
        else if (src[i] === ')') { pd -= 1; if (pd === 0) { i = src.indexOf('{', i); break; } }
      }
      let d = 0; let end = -1;
      for (; i < src.length; i += 1) {
        if (src[i] === '{') d += 1;
        else if (src[i] === '}') { d -= 1; if (d === 0) { end = i + 1; break; } }
      }
      const body = src.slice(a, end).replace(
        'const cands = [...line.matchAll(IANA_TZ_RE_G)].map((m) => m[0]);',
        'const cands = [...paneText.matchAll(IANA_TZ_RE_G)].map((m) => m[0]).slice(0, 1);',
      );
      const pick = (n) => {
        const s0 = src.indexOf(`const ${n} =`);
        if (s0 < 0) return '';
        let dd = 0;
        for (let k = s0; k < src.length; k += 1) {
          const c = src[k];
          if (c === '[' || c === '{' || c === '(') dd += 1;
          else if (c === ']' || c === '}' || c === ')') dd -= 1;
          else if (c === ';' && dd === 0) return src.slice(s0, k + 1);
        }
        return '';
      };
      const tzFn = (() => {
        const a2 = src.indexOf('function tzOffsetAt');
        let p2 = 0; let j = src.indexOf('(', a2);
        for (; j < src.length; j += 1) {
          if (src[j] === '(') p2 += 1;
          else if (src[j] === ')') { p2 -= 1; if (p2 === 0) { j = src.indexOf('{', j); break; } }
        }
        let d2 = 0;
        for (; j < src.length; j += 1) {
          if (src[j] === '{') d2 += 1;
          else if (src[j] === '}') { d2 -= 1; if (d2 === 0) return src.slice(a2, j + 1); }
        }
        return '';
      })();
      const deps = ['RESET_TIME_RE', 'IANA_TZ_RE', 'IANA_TZ_RE_G'].map(pick).join('\n');
      // eslint-disable-next-line no-new-func
      return new Function(`${deps}\n${tzFn}\n${body}\nreturn extractResetHint;`)();
    })();
    const badHint = mutHint(pane);
    ok(badHint.reason === 'bad_tz',
      '🔴 E2-8⑤ 变异（整段取第一个）⇒ hint 变成 **bad_tz**', JSON.stringify(badHint));

    await reset(redis, { since: SINCE_E2 });
    const tMut = makeTmux();
    await runAct(redis, [finding({ rate_limit_hint: badHint })],
      // 🔴 同上：+ WAKE_MARGIN_MS
      { now: RESET_E2 + watchdog.WAKE_MARGIN_MS + 60_000, tmuxApi: tMut });
    ok(tMut.calls.length === 0,
      '🔴🔴 E2-8⑤ ⇒ **一次唤醒都没有** —— 这就是要防的形状：'
      + '重置时刻两小时前就过了，而 agent 全卡着', JSON.stringify(tMut.calls));
  }

  // ═══ S 组 · 陈提示：那行字声称的时刻，在被发现之前就过去了 ═══
  //
  //   输入是一份真实 pane（「两位数小时」的样本，`12:10pm`）。
  //   没有陈提示这一支的话，`act()` 的 `if (now < resolved.at)` 对它**永远为真** ——
  //   于是 ⑤ 那段唤醒**永远走不到**，agent 一直卡着。
  console.log('\n━━ S 组 · 陈提示（reset 在被发现之前就过去了）━━━━');
  {
    const PANE_21 = path.join(__dirname, 'fixtures', 'synthetic', 'rate-limit-panes',
      '39lines-agent-two-digit-hour.txt');
    const HINT_21 = watchdog.extractResetHint(fs.readFileSync(PANE_21, 'utf8'));

    // 手算，不问被测代码：12:10pm PDT(UTC−7) = 19:10Z
    const SINCE_STALE = Date.parse('2026-08-21T20:58:00Z');   // 发现它的时刻（重置**之后**）
    const AT_STALE = Date.parse('2026-08-22T19:10:00Z');      // ⇒ 被迫跳到第二天
    const NOW_STALE = Date.parse('2026-08-21T21:10:00Z');     // now < at ⇒ 没有陈提示这一支就不会唤醒
    ok(AT_STALE - SINCE_STALE > watchdog.STALE_HINT_GAP_MS,
      `（前提）这一格的 gap = ${((AT_STALE - SINCE_STALE) / H).toFixed(2)}h > 阈值 `
      + `${watchdog.STALE_HINT_GAP_MS / H}h`);
    ok(NOW_STALE < AT_STALE,
      '🔴（前提）`now < resolved.at` ⇒ **不打这个补丁的话，这一格不会唤醒**');

    await reset(redis, { since: SINCE_STALE });
    const t = makeTmux();
    const r = await runAct(redis, [finding({ rate_limit_hint: HINT_21 })],
      { now: NOW_STALE, tmuxApi: t });

    ok(t.calls.length === 1 && t.calls[0].kind === 'submit',
      '🔴 S1 陈提示 ⇒ **唤醒了，而且只有一次 submit**', JSON.stringify(t.calls));
    ok(t.calls[0] && t.calls[0].t === watchdog.RATE_LIMIT_WAKE_TEXT,
      '★ S1b 发过去的是唤醒文案本身（触发之后**真的走到 submit**，不是只改了个分支）');
    ok(r.events[0] && r.events[0].action === 'submit',
      'S1c 事件 action = submit', JSON.stringify(r.events.map((e) => e.action)));
    ok(Number(await redis.get(watchdog.RL_WAKES_KEY(NAME))) === 1,
      '★ S1d 这一条路**照样记数** ⇒ 三次停手对它同样生效');

    // ★ 告警文案必须跟「到点了」分得开 —— 两条路走到同一个 submit，而人只读文案。
    const txt = (r.events[0] && r.events[0].text) || '';
    ok(txt.includes('之前') && txt.includes('旧的'),
      '🔴 S2 告警说得出**为什么**唤醒（「在我们发现它之前就过去了 / 那行字是旧的」）',
      txt.slice(0, 90));
    ok(!txt.includes('恢复时刻') || txt.includes('之前'),
      '★ S2b 没有把它说成「恢复时刻已过」—— 那是另一条路的说法');

    // ── 🔴 正控①：同一份 hint，把 gap 压到阈值以内 ⇒ **必须不唤醒** ──────────
    //   变量只有一个：**只改锚点**（发现时刻），hint 一个字节没动。
    const SINCE_FRESH = Date.parse('2026-08-21T10:00:00Z');
    const AT_FRESH = Date.parse('2026-08-21T19:10:00Z');       // 当天那次，没跳日
    ok(AT_FRESH - SINCE_FRESH <= watchdog.STALE_HINT_GAP_MS,
      `（前提）这一格 gap = ${((AT_FRESH - SINCE_FRESH) / H).toFixed(2)}h ≤ 阈值`);
    await reset(redis, { since: SINCE_FRESH });
    const t2 = makeTmux();
    await runAct(redis, [finding({ rate_limit_hint: HINT_21 })],
      { now: Date.parse('2026-08-21T11:00:00Z'), tmuxApi: t2 });
    ok(t2.calls.length === 0,
      '🔴 S3 **正控**：gap 在阈值以内（重置还在前面）⇒ **一次 submit 都没有**',
      JSON.stringify(t2.calls));

    // ── 🔴 正控②：`worst_case` 那一支**不许**被这条判据吃掉 ─────────────────
    //   它的 `at = since + 24h` 是 watchdog **自己填的上界**，不是那行字说的。
    //   gap 恒为 24h ⇒ 少了 `mode === 'tz'` 守卫的话，这里会立刻 nudge，
    //   而那一支的设计是「只会醒得晚，不会早 nudge」。
    await reset(redis, { since: SINCE_STALE });
    const t3 = makeTmux();
    await runAct(redis, [finding({ rate_limit_hint: { raw: HINT_21.raw, tz: null } })],
      { now: NOW_STALE, tmuxApi: t3 });
    ok(t3.calls.length === 0,
      '🔴 S4 **正控**：无时区名（`worst_case`，gap 恒 24h）⇒ **不唤醒** '
      + '—— 这条守着 `mode === \'tz\'` 那个守卫', JSON.stringify(t3.calls));
  }

  // ═══ X 组 · 自查 ═══════════════════════════════════════════════════
  console.log('\n━━ X 组 · 施工纪律自查 ━━━━━━━━━━━━━━━━━━━━━━');
  {
    const self = fs.readFileSync(__filename, 'utf8');
    ok(watchdog.looksRateLimited(self) === false,
      '🔴 X1 本文件源码喂进入口判据 = false');
    ok(watchdog.looksRateLimited(fs.readFileSync(REAL, 'utf8')) === true,
      '★ X1 阴性对照：同一个检查器对 fixture 返回 true ⇒ 它不是恒假的');
    ok(!self.includes(fs.readFileSync(REAL, 'utf8').trim()),
      '🔴 X2 本文件没有内联 fixture 内容');
    ok(watchdog.looksRateLimited(watchdog.RATE_LIMIT_WAKE_TEXT) === false,
      '🔴 X1b **唤醒时发给 agent 的那句话**本身不命中入口判据 —— '
      + '否则我们发过去的那一刻，就把它的 pane 变成了「看起来又撞墙了」');
  }

  // ── T 组：告警时刻同时给 UTC 和当地 ────────
  //
  //   只给 `…T19:10:00.000Z` 的话，人容易读成「当地晚上 7 点」，
  //   而它是当地的**中午 12:10**（PDT = UTC−7）——一条算得完全正确的告警，
  //   被读成了一个差 7 小时的时刻。
  //
  //   ⚠️ 这一组验的是**文案**，不是判定逻辑。而文案说错一句话的代价，
  //     是人去一个不会有东西的地方等 —— 跟 deafAlertText 那一组同理。
  {
    const T = Date.UTC(2026, 7, 22, 19, 10, 0);   // 2026-08-22T19:10Z
    const withTz = watchdog.atBoth(T, 'America/Los_Angeles');

    ok(withTz.startsWith('2026-08-22T19:10:00.000Z'),
      '🔴 T1 UTC 那半**仍然在最前面** —— 日志/redis 里存的是它，只给当地会对不上账');
    ok(withTz.includes('（＝当地 '),
      '🔴 T2 同时给出当地时间');
    ok(withTz.includes('2026-08-22 12:10'),
      '🔴 T3 当地时刻算对了：19:10Z − 7h = **12:10**（而不是 19:10）');
    ok(/GMT|PDT|PST|UTC/.test(withTz),
      '🔴 T4 当地那半带**时区标记** —— 否则「12:10」自己也说不清是哪儿的 12:10');

    // 🔴 正控：换回原来那种「只给 UTC」的写法 ⇒ T2/T3 必须红
    const isoOnly = new Date(T).toISOString();
    ok(!isoOnly.includes('（＝当地 ') && !isoOnly.includes('12:10'),
      '🔴 T5 **正控**：只给 UTC 的旧写法，既没有「当地」也不含 12:10 ⇒ 上面那三条确实在验新行为');

    // tz 为 null（worst_case 那一支）⇒ 退回机器本地，而**照样**给当地那半
    const noTz = watchdog.atBoth(T, null);
    ok(noTz.startsWith('2026-08-22T19:10:00.000Z') && noTz.includes('（＝当地 '),
      '🔴 T6 没有时区名时退回机器本地，而不是把当地那半整个吞掉');

    // 🔴 Intl 不认识那个名字时**不许静默** —— 否则「当地时间没出现」看起来像功能没做
    const badTz = watchdog.atBoth(T, 'Not/AZone');
    ok(badTz.startsWith('2026-08-22T19:10:00.000Z')
      && badTz.includes('渲染失败') && badTz.includes('Not/AZone'),
      '🔴 T7 时区名不合法 ⇒ UTC 照给，而**把原因带出来**（不静默吞掉）');
  }

  // ══ F 组 · 首次判成 rate_limited 的那一轮不唤醒 ══════════
  //
  //   要防的形状：发现和唤醒落在同一 tick
  //   ⇒ 而那一刻 pane 上最后一条 `resets` 还可能是旧的 ⇒ gap > 12h ⇒ `staleHint` ⇒ 立刻唤醒
  //   ⇒ ⇒ **比真实重置时刻早**。
  //
  //   ★ 判据**成对**，缺哪一半哪一半就恒真：
  //     F1/F2 首轮：**不 submit** ＋ **`rl_wakes` 不 +1**
  //     F3    首轮：**告警照发** —— 只验「不唤醒」的话，一个把整档静音的实现也能过
  //     F4    次轮：**照常唤醒** —— 只验首轮的话，一个「永远不唤醒」的实现全绿
  console.log('\n━━ F 组 · 首次那一轮只告警、不唤醒 ━━━━━━━━━━━━');
  {
    // 🔴 `since: null` ⇒ **不预置锚点** ⇒ act() 里那个 SET NX 会成功 ⇒ firstSeen = true
    //   （其余用例都预置锚点 ⇒ firstSeen = false ⇒ 它们的行为一个字不变）
    await reset(redis, { since: null });
    const t1 = makeTmux();
    // ★ 用**跟 E3 完全相同的输入**（真实夹具的 hint ＋ 已经到点的 now）——
    //   于是 F1/F2 和 E3 之间**只差一个变量**：锚点是不是这一轮才建的。
    //   （而 `since: null` ⇒ act() 里那个 SET NX 会成功 ⇒ 锚点 = 本轮 now
    //     ⇒ 解出的重置时刻落在明天 ⇒ gap ≈ 23h ⇒ `staleHint` 为真
    //     ⇒ ⇒ **没有首轮守卫的实现在这一轮必然唤醒** —— 那正是要防的形状。）
    const NOW_PAST = RESET_AT + watchdog.WAKE_MARGIN_MS + 60_000;
    const { events: ev1 } = await runAct(redis, [finding()], { now: NOW_PAST, tmuxApi: t1 });
    const submits1 = t1.calls.filter((c) => c.kind === 'submit').length;
    ok(submits1 === 0,
      '★★ F1 首次判这一档的那一轮 **一次 submit 都没有**（实际 ' + submits1 + '）',
      JSON.stringify(t1.calls.map((c) => c.kind)));
    const wakes1 = Number(await redis.get(watchdog.RL_WAKES_KEY(NAME)).catch(() => 0)) || 0;
    ok(wakes1 === 0,
      '★★ F2 而 `rl_wakes` **没有 +1**（实际 ' + wakes1 + '）—— 唤醒配额一次都没烧',
      String(wakes1));
    // ⚠️ 判别量是**事件**，不是 `OUT_T` 的长度 —— 这一轮**有意不推给人**
    //   （推了会占掉 `rate_limited` 那个冷却，把下一轮真正有信息的告警吃掉）。
    ok(ev1.some((e) => e.name === NAME),
      '★★★ F3 **而这一轮照样发了事件** —— 只验「不唤醒」的话，一个把整档静音的实现也能过',
      JSON.stringify(ev1.map((e) => e.name)));

    // ── F4：第二轮（锚点已经在了 ⇒ firstSeen = false）⇒ 照常唤醒 ──────────
    //   ⚠️ 只清冷却，**留状态** —— 那正是「同一次撞墙的第二次 tick」
    await reset(redis, { keepState: true, keepCooldown: false });
    const t2 = makeTmux();
    await runAct(redis, [finding()], { now: NOW_PAST, tmuxApi: t2 });
    const submits2 = t2.calls.filter((c) => c.kind === 'submit').length;
    ok(submits2 === 1,
      '★★★ F4 第二轮**照常唤醒**（submit ' + submits2 + ' 次）—— 这一条挡住「永远不唤醒」那个实现',
      JSON.stringify(t2.calls.map((c) => c.kind)));
    await reset(redis, { since: SINCE });
  }

  await redis.del(OUT_T);
  await reset(redis);
  await redis.quit();

  // ══════════════════════════════════════════════════════════════════════
  // 🔴 M · pane 里有**多行** `resets` 时，取**最新**那个
  //
  //   `multi-reset.txt` 这份 pane 里有三行 resets ——
  //     行 9 `resets 12:10pm`（**很久以前那次的残留**）· 行 25/32 `resets 6:50pm`（这次的）
  //   用 `re.exec(paneText)`（不带 `g`）会返回**第一个**匹配
  //   ⇒ ⇒ 按 12:10pm 算恢复时刻 ⇒ **watchdog 叫不醒它**。
  //
  //   ⚠️ **另外四份夹具每份只有一行 `resets`** ——
  //   只有一个匹配时，「第一个」和「最后一个」是同一个 ⇒ 只用它们的判据对这个 bug 全绿。
  //   ★ 那是「被占住的空位看不见」：那个位置上**有**夹具，
  //     而它们全是「pane 里只撞过一次限额」的样本。
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n━━ M · 多行 resets ━━━━━━━━━━━━━━━━━━━━━━━━━━');
  {
    const DIR = path.join(__dirname, 'fixtures', 'synthetic', 'rate-limit-panes');
    const MULTI = 'multi-reset.txt';
    const SINGLES = [
      'line-only.txt',
      '40lines-orch.txt',
      '40lines-agent.txt',
      '39lines-agent-two-digit-hour.txt',
    ];
    const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

    // 对照实现：**取第一个**（不带 `g` 的 exec 的行为）
    const takeFirst = (pane) => {
      for (const re of watchdog.RESET_TIME_RE.map((r) => new RegExp(r.source, r.flags + 'g'))) {
        const all = [...pane.matchAll(re)];
        if (all.length) return { raw: all[0][1], at: all[0].index };
      }
      return null;
    };

    const multi = read(MULTI);
    const h = watchdog.extractResetHint(multi);

    // ── M1 ① 多行 resets 的真实 pane：必须取到**最新**那个
    ok(h && h.raw === '6:50pm',
      '🔴 M1 真实 pane（三行 resets）⇒ 取到**最新**那个 6:50pm'
      + '（而不是 12:10pm —— 一个早就过去的时刻）', JSON.stringify(h && h.raw));

    // ── M2 ② 第二个口径：**取的是最后一个，不是"最后两个里的某一个"**
    //
    //   ⚠️ 真实夹具里最后两处的值**都是 6:50pm** ⇒ 值本身分不出「中间 vs 最后」，
    //   而 `extractResetHint` 只返回 `{raw, tz}`，没有位置字段。
    //   ⇒ ⇒ 所以这一格只能用**构造输入**，而它带着构造输入那个上限：
    //     **它证明的是「对想到的那一类有效」，不是「有效」。**
    const synth = ['x 1:00pm 之类的旧行', 'y 2:00pm', 'z 3:00pm'].join('\n')
      .replace(/(\d:\d\d[ap]m)/g, (t) => 'reset' + 's ' + t);
    const hs = watchdog.extractResetHint(synth);
    ok(hs && hs.raw === '3:00pm',
      '🔴 M2（**构造输入**）三个互不相同的时刻 ⇒ 取到**最后一个** —— '
      + '真实夹具最后两处同值，分不出「中间 vs 最后」，这一格只能构造',
      JSON.stringify(hs && hs.raw));

    // ── M3 🔴 这份夹具**有分辨力**：对照实现在它上面给出不同的答案
    const first = takeFirst(multi);
    ok(first && first.raw === '12:10pm' && first.raw !== h.raw,
      '🔴 M3 **对照**：取第一个的实现在这份夹具上给出 12:10pm ⇒ '
      + '⇒ 这份夹具区分得开两种实现（而另外四份区分不开 —— 见 M4）',
      JSON.stringify({ first: first && first.raw, now: h && h.raw }));

    // ── M4 🔴 而四份单匹配夹具上，两种实现**必须一致** ⇒ 取最后一个不改变单匹配时的结果
    for (const f of SINGLES) {
      const pane = read(f);
      const a = watchdog.extractResetHint(pane);
      const c = takeFirst(pane);
      ok((a && a.raw) === (c && c.raw),
        `M4 单匹配夹具 ${f}：两种实现取到同一个值 ⇒ 改动没碰旧行为`,
        JSON.stringify({ now: a && a.raw, first: c && c.raw }));
    }

    // ── M5 🔴 RE1 在**五份真实夹具**上一次都不命中
    //   「RE1 从没在真实文案上命中过」是一个**关于外部世界的断言** ——
    //   而外部会变，注释不会跟着变。
    //   ⇒ 上游哪天在那个词后面加上介词（RE1 要求的那个形状），这条就会红 ——
    //     而那正是「RE1 的顺序又开始起作用了」这件事需要有人看的时刻。
    //   ⚠️ 这里**故意不写出那个形状** —— 写出来就会命中 `RATE_LIMIT_RE`，
    //     而本文件的源码要能安全地喂进 `looksRateLimited`（X1 守着这一条）。
    const RE1 = watchdog.RESET_TIME_RE[0];
    // ⚠️ 命名注意：这里的 `RE1` 是 **`RESET_TIME_RE[0]`**（要求 at/in/on 的那条，排在前面）。
    //   而 `RE2` 是 `[1]`（不要介词的那条）—— **真正在生效的是它**。

    // ── 🔴 前提：这五份夹具**真的被读到了，而且里面真的有 resets 行** ──────────
    //
    //   下面那组断言全是「**不**命中」——而「不命中」和「`read(f)` 读到的是空 /
    //   文件没了」在结果上**是同一个绿**，而且五条会**一起**变绿
    //   ⇒ ⇒ 而一起变绿看起来比一条更可信。
    //
    //   ✅ 所以配一条正向，而选的是「**真正生效的那条 RE 在同一份夹具上命中**」——
    //     它一条盖三件：**夹具是真的** · **RE 家族在工作** · **而生效的不是 RE1**。
    //     （只断言「文件非空」的话，「读到了一份不相干的文件」它挡不住。）
    //   📌 RE1 在五份上命中 **0 / 0 / 0 / 0 / 0**；
    //     RE2 命中 **1 / 1 / 1 / 1 / 3**（多行那份三次）。
    //
    //   ⚠️ 而它红的时候，动作跟下面那组是同一个：**去看顺序是不是开始起作用了**。
    const RE2 = watchdog.RESET_TIME_RE[1];
    const noRe2 = [...SINGLES, MULTI].filter((f) => !RE2.test(read(f)));
    ok(noRe2.length === 0,
      '🔴 M5（前提）**真正生效的那条 RE（`RESET_TIME_RE[1]`）在五份夹具上全部命中** —— '
      + '否则下面那组「RE1 不命中」可能只是因为根本没读到内容',
      JSON.stringify(noRe2));

    for (const f of [...SINGLES, MULTI]) {
      ok(!RE1.test(read(f)),
        `🔴 M5 RE1（要求 at/in/on）在 ${f} 上**不命中** —— 它排在前面而从未生效；`
        + '这条红了说明上游文案变了，那时顺序开始起作用');
    }
  }

  console.log(`\n${'─'.repeat(50)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
