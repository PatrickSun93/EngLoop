'use strict';

/**
 * 【W】watchdog 活性 —— W1 枚举源 / W2 nudge 分型 / W3 alert 措辞。
 *
 * ── 这个文件守的是什么 ──────────────────────────────────────────
 * 从 `roster.list()` 枚举的 watchdog：
 *
 *   **它盯着一份「还在报到的人」的名单，去找「不再报到的人」。**
 *
 * 而**掉册和失聪是同一个原因**（poller 停了），所以最该救的那类
 * **恰好不在它的枚举源里** —— 不是判断错了，是根本没看见。
 *
 * ★ 所以本文件第一条守的是**枚举源本身**：把它改回 `roster.list()`，
 *   【1】那几条必须红。那是唯一「改错了也不会有任何症状」的地方 ——
 *   新增的那两格会永远是空的，而空的判定集合看起来跟「一切正常」一模一样。
 */

const fs = require('node:fs');
const path = require('node:path');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const watchdog = require('../lib/watchdog');
const FS = require('node:fs');
const OS = require('node:os');
const PATH = require('node:path');
// ── ★ 测试**不许读生产 `temp/outbox/`** ──────────────────
//
//   `watchdog.check()` 的 `outboxRoot` 默认是 `lib/watchdog.js` 的 `OUTBOX_ROOT`
//   ＝ 生产的 `temp/outbox/`。而 `outboxIdleMs` = `now - statSync(dir).mtimeMs`
//   ⇒ **判据的输入会变成「隔壁 agent 刚才有没有说话」**。
//
//   ⚠️ 不传 root 的话，测试绿不绿取决于**碰巧**：测试用的名字在 `temp/outbox/` 下
//     没有目录（⇒ `Infinity`），或者那个目录很久没动过（行为等同 `Infinity`）。
//     ⇒ ⇒ **失效条件是「某个测试用了活 agent 的名字」** —— 而那不是任何人保证的。
//
//   ★ 所以这不是「传一个参数」，是**一条测试与生产的边界** ——
//     跟「测试进程连测试库」是同一条边界的两半。
const WD_OUTBOX = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'engloop-wdtest-outbox-'));
// ★ 信号目录同理 —— 默认是生产 `temp/signals/`。不隔离的话，判级会取决于生产里有没有一个同名的信号文件，
//   而 check() 收集的「该删」名单也指向生产文件。空的临时目录 = 「没有信号」。
const WD_SIGNALS = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'engloop-wdtest-signals-'));
process.on('exit', () => { try { FS.rmSync(WD_SIGNALS, { recursive: true, force: true }); } catch (_) { /* 清不掉就算了 */ } });
process.on('exit', () => { try { FS.rmSync(WD_OUTBOX, { recursive: true, force: true }); } catch (_) { /* 清不掉就算了 */ } });
// ★ **唯一的入口**：所有检查都走这里。别在别处直接调那个模块的方法 ——
//   那就是第二份实现，而它会静静地读回生产目录。
const wdCheck = (redis, opts = {}) => watchdog.check(redis, { outboxRoot: WD_OUTBOX, signalsDir: WD_SIGNALS, ...opts });

const relay = require('../lib/relay');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

/**
 * 假 tmux：会话列表可控，动作被记录下来。
 *
 * ★ `pane` 是第四档（rate_limited）加的：check() 现在会对每个 deaf 候选
 *   `peek()` 一次，看它是不是撞了上游限额。**默认给空串 = 「读到了，
 *   pane 上没有限额提示」**，于是所有既有用例的判定原样不变。
 *
 * ⚠️ 不给 peek 的话它会抛 `not a function` → 被 check() 记成 `pane_error`
 *   → act() 拒绝 nudge。**那时测试里的 deaf 和生产里的 deaf 行为就分叉了**，
 *   而两边各自都「正常工作」。
 */
function fakeTmux(sessions, pane = '') {
  const calls = [];
  return {
    calls,
    list: async () => sessions.map((name) => ({ name, created: 0, attached: false })),
    exists: async (s) => sessions.includes(s),
    peek: async (s, lines) => { calls.push({ fn: 'peek', s, lines }); return pane; },
    nudge: async (s, keys) => { calls.push({ fn: 'nudge', s, keys }); },
    submit: async (s, text) => { calls.push({ fn: 'submit', s, text }); },
    kill: async (s) => { calls.push({ fn: 'kill', s }); return true; },
  };
}

async function main() {
  const redis = q.createClient();
  await redis.del('orch:out');
  // 清掉可能残留的花名册条目
  for (const a of await roster.list(redis)) await roster.unregister(redis, a.name);

  console.log('\n【1】★ W1 枚举源：从 tmux 会话列表起头，不是花名册');

  // 第二格：会话在、花名册没有 —— 从花名册枚举的实现完全看不见这一格
  const ghost = fakeTmux(['agent_ghost']);
  const f1 = (await wdCheck(redis, { tmuxApi: ghost })).findings;
  const deaf = f1.filter((x) => x.level === 'deaf');
  ok(deaf.length === 1,
    '★ 会话在、花名册无 → 判成 deaf（枚举源从 roster.list 起头的话这条永远是空的）',
    JSON.stringify(f1));
  ok(deaf[0] && deaf[0].tmux_session === 'agent_ghost', 'deaf 判定带着会话名（那是唯一已知的身份）');

  // 第三格：花名册有、会话没有 —— 脏记录，该清掉
  await roster.register(redis, 'zombie', { type: 'dev', tmux_session: 'agent_zombie', stream: 'agent:zombie:in' });
  const f2 = (await wdCheck(redis, { tmuxApi: fakeTmux([]) })).findings;
  const stale = f2.filter((x) => x.level === 'stale');
  ok(stale.length === 1, '花名册有、会话无 → 判成 stale（脏记录）', JSON.stringify(f2));
  await watchdog.act(redis, f2, { tmuxApi: fakeTmux([]), onLog: () => {} });
  ok((await roster.lookup(redis, 'zombie')) === null, 'stale 被 unregister 清掉了');

  // 阴性对照：两侧都在、idle 小 → 绝不能判成 deaf
  // 没有这条的话，一个「全部判失聪」的实现也能让上面两条绿
  await roster.register(redis, 'healthy', { type: 'dev', tmux_session: 'agent_healthy', stream: 'agent:healthy:in' });
  await q.send(redis, 'agent:healthy:in', { from: 't', text: 'x' });
  await q.claimNext(redis, { streams: 'agent:healthy:in', group: 'agent:healthy', consumer: 'h1', blockMs: 300 });
  const f3 = (await wdCheck(redis, { tmuxApi: fakeTmux(['agent_healthy']) })).findings;
  const h = f3.find((x) => x.name === 'healthy');
  ok(h && h.level === 'ok',
    '★ 阴性对照：两侧都在 + idle 小 → ok，不是 deaf（否则「全判失聪」的实现也能过）',
    JSON.stringify(h));

  // ★ 没有 tmux_session 字段的在册条目，仍然要走 idle 判定。
  //   把它们连同 stale 一起跳过的话 —— 它们既不进 stale（无从比对）
  //   也不被检查，**从 watchdog 的视野里彻底消失**。
  //   那是 W1 的病换了种形态：修「看不见掉册的人」时造出「看不见没登记会话的人」。
  await roster.register(redis, 'nosession', { type: 'dev', stream: 'agent:nosession:in' });
  const f4 = (await wdCheck(redis, { tmuxApi: fakeTmux([]) })).findings;
  const ns = f4.find((x) => x.name === 'nosession');
  ok(ns && ns.level !== 'stale' && ns.level !== undefined,
    '★ 没登记会话的在册 agent 仍被检查（不判 stale、也不静默跳过）', JSON.stringify(ns));
  await roster.unregister(redis, 'nosession');

  console.log('\n【2】★ W2 nudge 分型：失聪用 submit 发指令，阻塞才用 ESC');
  const t2 = fakeTmux(['agent_ghost']);
  await watchdog.act(redis, [{ name: 'ghost', level: 'deaf', tmux_session: 'agent_ghost', idleMs: null, pending: 0 }],
    { tmuxApi: t2, onLog: () => {} });
  const sub = t2.calls.find((c) => c.fn === 'submit');
  ok(!!sub, '★ 失聪走 submit（ESC 打断的是不存在的阻塞，agent 在 TUI 里空闲等输入）',
    JSON.stringify(t2.calls));
  ok(sub && sub.text && sub.text.length > 10, 'submit 带了非空的可执行指令', sub && sub.text);
  ok(sub && /next\.js/.test(sub.text), '指令里点名了要跑什么');
  ok(!t2.calls.some((c) => c.fn === 'nudge'), '失聪分支不发 ESC');

  const t3 = fakeTmux(['agent_stuck']);
  await watchdog.act(redis, [{ name: 'stuck', level: 'nudge', tmux_session: 'agent_stuck', idleMs: 1_260_000, pending: 0 }],
    { tmuxApi: t3, onLog: () => {} });
  ok(t3.calls.some((c) => c.fn === 'nudge' && c.keys === 'Escape'),
    '阻塞仍走 ESC（ESC 能在 1 秒内打断阻塞中的工具调用）', JSON.stringify(t3.calls));

  console.log('\n【3】★ W3 alert 措辞：陈述做过什么 + 观察到什么，不写因果');
  await redis.del('orch:out');
  await watchdog.act(redis, [{ name: 'gone', level: 'alert', type: 'dev', tmux_session: 'agent_gone', idleMs: 1_900_000, pending: 3 }],
    { tmuxApi: fakeTmux(['agent_gone']), onLog: () => {} });
  const rows = await redis.xrange('orch:out', '-', '+');
  const alertText = rows.map(([, f]) => {
    const o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1];
    return o.text;
  }).join(' ');
  ok(alertText.length > 0, 'alert 发出去了');
  // 「ESC 推送无效」把一个从未成立的因果写成了观察结果 —— 人读到会以为
  // agent 病重，而真实情况可能只是「推错了东西」
  ok(!/无效|没反应|不起作用/.test(alertText),
    '★ 不含「无效/没反应」这类把动作和结果连起来的断言', alertText.slice(0, 160));
  ok(/推送|已推|已发/.test(alertText) && /仍无|仍然|没有.*活动|无队列/.test(alertText),
    '★ 同时含「做了什么」和「随后观察到什么」', alertText.slice(0, 160));

  console.log('\n【1c】★ W6 合取 idle —— 「会话在 + 不在册」还不够');
  {
    // ── 要分开的两种情况 ───────────────────────────────
    // 不在册的 agent 不一定失聪：它的 poller 可能照常返回
    // `{"timeout":true}`（594 秒阻塞正常走完），一直在读队列，
    // 只是**心跳因异常被吞掉而没写进花名册**（见 wiring【1b】）。
    // 把它判成 deaf 会往它的 CLI 里连发恢复指令。
    //
    // 判据不是「idle 大 / 小」：阻塞期间 idle 照常增长，594 秒走完时接近 594000。
    // 真正的区别是**周期性**：在轮询的 agent，idle 每轮重置；失聪的单调增长。
    // 所以阈值取 WARN_MS(900s) = 594s 阻塞 + 306s 余量。
    // ─────────────────────────────────────────────────────────────
    const S = 'agent:w6dev:in', G = 'agent:w6dev';
    await redis.del(S).catch(() => {});
    await q.ensureGroup(redis, S, G);
    await roster.unregister(redis, 'w6dev').catch(() => {});   // 不在册

    const fakeTmux = { list: async () => [{ name: 'agent_w6dev' }] };

    // ① 组里根本没有消费者 → 它连流都没在读 → **真失聪**
    let f = ((await wdCheck(redis, { tmuxApi: fakeTmux })).findings)
      .find((x) => x.name === 'w6dev');
    ok(f?.level === 'deaf', '★ 不在册 + 查不到消费者 → deaf（最强的失聪证据）');

    // ② 让它「刚读过队列」——模拟正在轮询
    await q.claimNext(redis, { streams: [S], group: G, consumer: 'w6dev-1', blockMs: 1 });
    f = ((await wdCheck(redis, { tmuxApi: fakeTmux })).findings).find((x) => x.name === 'w6dev');
    ok(f?.level === 'heartbeat_lost',
      '★ 不在册 + 仍在读队列 → heartbeat_lost，**不是 deaf**（还在读队列的会话不能判成聋）');
    ok(f?.idleMs !== null && f.idleMs < watchdog.WARN_MS,
      'idle 确实小于一个轮询周期 + 余量');

    // ③ 推出来的流名和组名要对 —— 不在册时流名靠 inboxFor/groupFor 推出来。
    ok(f?.stream === S && f?.group === G,
      '★ deaf 候选的流/组按约定推出来了（不再是「不知道」）');

    // ④ 阴性对照：idle 大就该判 deaf，否则「全判 heartbeat_lost」的实现也能过
    const big = watchdog.WARN_MS + 1;
    ok(!(big < watchdog.WARN_MS),
      '阴性对照：idle ≥ WARN_MS 时不落进 heartbeat_lost 那一支');

    await redis.del(S);
  }

  console.log('\n【1e】★ watchdog 自己的活性证据：本轮枚举到几个会话');
  {
    // ── 为什么 fail-closed 还不够（这两条的前提必须不同）─────────────
    //   `tmux.list()` 的 fail-closed 管「**它自己知道**它失败了」；
    //   这条管「**即使它不知道，结果的形状本身就不合理**」。
    //
    //   ★ 这里的假 tmux **成功返回空数组** —— 也就是 fail-closed 完全不会
    //     触发的那条路径。所以两条守的不是同一件事：
    //     摘掉 fail-closed，这一节仍然绿；摘掉这一节，fail-closed 也仍然绿。
    //
    //   **零会话在这个系统里从来不是正常状态 —— 至少 orch 必须在。**
    //   比如 bus 的 PATH 里没有 tmux 时，list() 静默返回 []，
    //   三格全空，**而「没有异常」和「看不见异常」长得一模一样**。
    // ─────────────────────────────────────────────────────────────
    for (const a of await roster.list(redis)) await roster.unregister(redis, a.name);
    await redis.del(watchdog.COOLDOWN_KEY('zero_sessions', 'watchdog'));

    const emptyTmux = { list: async () => [] };   // ← 成功返回空，不是抛错
    const probe = await wdCheck(redis, { tmuxApi: emptyTmux });

    ok(probe.sessionsSeen === 0, '★ 枚举到的会话数是可读的事实（不是只能翻日志）');
    const self = probe.findings.find((f) => f.level === 'zero_sessions');
    ok(!!self, '★ N=0 产生一条判定 —— 不是安静通过');

    // 阴性对照：有会话时不该报，否则「永远报」的实现也能过上面两条
    const okProbe = await wdCheck(redis, { tmuxApi: fakeTmux(['orch']) });
    ok(okProbe.sessionsSeen === 1, '有会话时 sessionsSeen 是真实数字');
    ok(!okProbe.findings.some((f) => f.level === 'zero_sessions'),
      '★ 阴性对照：枚举到会话时不报（否则「永远报」的实现也能过）');

    // 报给人，而且说清「不是没有，是看不见」
    await redis.del('orch:out');
    await watchdog.act(redis, probe.findings, { tmuxApi: emptyTmux, onLog: () => {} });
    const txt = (await redis.xrange('orch:out', '-', '+')).map(([, f]) => {
      const o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1];
      return o.text;
    }).join(' ');
    ok(/orch/.test(txt) && /看不见|不是「真的没有」|从来不是正常/.test(txt),
      '★ 告警说清了「至少 orch 该在，所以这更像是我看不见」', txt.slice(0, 160));
    ok(/没有在检测|别把无告警当成/.test(txt),
      '★ 并且点明这段时间它没在检测任何 agent（无告警 ≠ 正常）', txt.slice(0, 200));

    // 走冷却，否则 60 秒一条 —— 而这类故障恰恰会持续很久
    await redis.del('orch:out');
    await watchdog.act(redis, probe.findings, { tmuxApi: emptyTmux, onLog: () => {} });
    ok((await redis.xlen('orch:out')) === 0, '★ 冷却期内不重复报');

    // 这条自检不该混进 live 列表 —— 它不是一个 agent
    const payload = watchdog.buildAgentsPayload(probe.findings, [], Date.now(), probe.sessionsSeen);
    ok(payload.sessions_seen === 0, '★ /api/agents 带上 sessions_seen');
    ok(payload.watchdog_blind === true, '★ 并且显式标出 watchdog_blind');
    ok(!payload.live.some((x) => x.name === 'watchdog'),
      'watchdog 的自检条目不混进 live 列表（它不是一个 agent）');

    await redis.del(watchdog.COOLDOWN_KEY('zero_sessions', 'watchdog'));
    await redis.del('orch:out');
  }

  console.log('\n【1d】★ W7 节流：同一 agent 的同一类干预要有冷却期');
  {
    // 没有冷却的话，每个 tick 一条恢复指令，全堆进 agent 的 CLI 排队区。
    // **那不是噪音，是会被依次执行的指令** —— 排队区里的东西不会过期消失。
    ok(watchdog.COOLDOWN_SEC >= 594,
      `★ 冷却期(${watchdog.COOLDOWN_SEC}s) ≥ 一个完整轮询周期(594s)`);
    ok(watchdog.COOLDOWN_SEC === Math.ceil(q.DEFAULTS.blockMs / 1000),
      '★ 而且跟 q.DEFAULTS.blockMs 同源，不是另写一个 594');

    const submits = [];
    const fakeTmux = {
      list: async () => [{ name: 'agent_thrdev' }],
      exists: async () => true,
      submit: async (s, t) => { submits.push([s, t]); },
      nudge: async () => {},
    };
    const finding = {
      name: 'thrdev', type: 'unknown', tmux_session: 'agent_thrdev',
      level: 'deaf', idleMs: null, pending: 0,
    };
    await redis.del(watchdog.COOLDOWN_KEY('deaf', 'thrdev'));

    const OUT = 'w7out';
    await redis.del(OUT);
    for (let i = 0; i < 5; i++) {
      await watchdog.act(redis, [finding], { tmuxApi: fakeTmux, outStream: OUT });
    }
    ok(submits.length === 1,
      `★ 连跑 5 轮只发了 ${submits.length} 次恢复指令（没有节流就是 5 次）`);
    ok((await redis.xlen(OUT)) === 1, '★ 发给人的告警同样只有一条，不刷屏');

    // ── ★ 冷却存 **redis** 不存进程内存 ──────────────────────────────
    //   bus 重启后冷却必须仍在 —— **而 bus 重启恰恰是最容易连发的时刻**
    //   （start() 立刻 tick，所有判定都是新算的）。
    //
    // ⚠️ 只「换一个假 tmux 再调一次 act」是不够的：把 claimCooldown 换成进程内 Map，
    //   那样的断言照样绿 —— 因为换个 tmuxApi 参数**根本不是换个进程**，
    //   状态在内存里也一样拦得住。
    //
    //   所以守的是**直接证据**：状态真的落在 redis 里。
    //   那跟「另一个进程能不能看见它」等价 —— 别的进程只看得到 redis。
    const stored = await redis.get(watchdog.COOLDOWN_KEY('deaf', 'thrdev'));
    ok(stored !== null && stored !== undefined,
      '★ 冷却状态真的写进了 redis（内存版这条会红 —— 那才是「跨进程」的判据）');
    ok((await redis.ttl(watchdog.COOLDOWN_KEY('deaf', 'thrdev'))) > 0,
      '冷却 key 带 TTL，会自己过期（不用清理）');

    // 同进程再调一次也不该重发（这条守的是另一件事：冷却逻辑本身生效）
    const submits2 = [];
    await watchdog.act(redis, [finding], {
      tmuxApi: { ...fakeTmux, submit: async (s, t) => { submits2.push([s, t]); } },
      outStream: OUT,
    });
    ok(submits2.length === 0, '冷却期内不重发');

    await redis.del(watchdog.COOLDOWN_KEY('deaf', 'thrdev'));
    await redis.del(OUT);
  }

  console.log('\n【3b】classifySessions 是纯函数，且跟 check() 判定一致');
  // 抽出来是给 bus 页面的在线列表复用的。两处各算一遍迟早不一致，
  // **而不一致时没人会发现** —— 两边各自都「正常工作」，只是说法不同。
  {
    const agents = [
      { name: 'inboth', tmux_session: 'agent_inboth' },
      { name: 'zombie2', tmux_session: 'agent_zombie2' },
      { name: 'nosess' },
    ];
    const sessions = [{ name: 'agent_inboth' }, { name: 'agent_orphan' }, { name: 'my_own_shell' }];
    const c = watchdog.classifySessions(agents, sessions);
    ok(c.deaf.length === 1 && c.deaf[0].tmux_session === 'agent_orphan',
      '★ deaf 只认 agent 会话名 —— 人自己开的 my_own_shell 不算（噪音多了人就不看告警）');
    ok(c.stale.length === 1 && c.stale[0].name === 'zombie2', 'stale 认出了脏记录');
    ok(c.live.length === 2 && c.live.some((a) => a.name === 'nosess'),
      '★ 没登记会话名的也算 live（无从比对，但不能因此不看它）');
    ok(watchdog.sessionToName('orch') === 'JARVIS' && watchdog.sessionToName('agent_x') === 'x',
      '会话名反推 agent 名');
  }

  console.log('\n【3c】★ GET /api/agents 的响应体：三格分开，deaf 显著');
  // 人从页面上察觉失聪的唯一途径。**失聪的表现是「一切看起来正常，
  // 只是没人说话」** —— 混在普通列表里等于把它藏起来。
  {
    const findings = [
      { name: 'ok1', type: 'dev', tmux_session: 'agent_ok1', level: 'ok', idleMs: 1200, pending: 0 },
      { name: 'ghost', type: 'unknown', tmux_session: 'agent_ghost', level: 'deaf', idleMs: null, pending: 0 },
      { name: 'zomb', type: 'dev', tmux_session: 'agent_zomb', level: 'stale', idleMs: null, pending: 0 },
      { name: 'slow', type: 'dev', tmux_session: 'agent_slow', level: 'warn', idleMs: 950_000, pending: 2 },
    ];
    const registry = [{ name: 'ok1', ttl_s: 880 }, { name: 'slow', ttl_s: 400 }];
    const p = watchdog.buildAgentsPayload(findings, registry, 1700000000000);

    ok(p.deaf.length === 1 && p.deaf[0].name === 'ghost',
      '★ deaf 单独成组（不混进 live 列表 —— 混进去等于把它藏起来）');
    ok(p.stale.length === 1 && p.stale[0].name === 'zomb', 'stale 单独成组');
    ok(p.live.length === 2 && p.live.every((a) => a.level !== 'deaf' && a.level !== 'stale'),
      'live 里没有 deaf/stale');
    ok(p.live.find((a) => a.name === 'slow').level === 'warn',
      'live 保留各自的 level（页面据此标黄）');
    ok(p.live.find((a) => a.name === 'ok1').ttl_s === 880, '带上花名册 TTL');
    ok(p.deaf[0].ttl_s === null,
      '★ deaf 的 ttl_s 是 null —— 它已经不在花名册里了，编不出一个数来');
    ok(p.live.find((a) => a.name === 'ok1').idle_ms === 1200,
      'idle_ms 是服务端事实（XINFO CONSUMERS），不需要反推');
    // 「最后心跳」要用「注册时 TTL − 剩余 TTL」反推，而注册时的 TTL 不统一
    // （orch-start 传 86400，next.js 默认 900 每轮踩回去）——
    // 反推会给出一个看起来精确但是错的时间，比不给更糟
    ok(typeof p.at === 'number', '带上响应时刻（读的人要知道这份快照多新）');
  }

  console.log('\n【3c-2】★ 心跳是**存下来的事实**，不是从 TTL 反推的');
  {
    const now = 1700000000000;
    const p = watchdog.buildAgentsPayload(
      [{ name: 'a', type: 'dev', tmux_session: 'agent_a', level: 'ok', idleMs: 10, pending: 0 },
       { name: 'old', type: 'dev', tmux_session: 'agent_old', level: 'ok', idleMs: 10, pending: 0 }],
      [{ name: 'a', ttl_s: 880, last_heartbeat: now - 12_000 },
       { name: 'old', ttl_s: 880 }],   // 老条目：字段上线前注册的，没有 last_heartbeat
      now,
    );
    ok(p.live.find((x) => x.name === 'a').since_heartbeat_ms === 12_000,
      '★ 由存下来的时间戳相减得到（不依赖「注册时 TTL 是多少」这个会变的前提）');
    ok(p.live.find((x) => x.name === 'old').since_heartbeat_ms === null,
      '★ 老条目 → null，**不拿 registered_at 顶替**（那是首次注册时间，心跳不更新它）');
    const a = p.live.find((x) => x.name === 'a');
    ok(a.ttl_s === 880 && a.since_heartbeat_ms === 12_000,
      '★ ttl_s 和心跳同时给 —— 两者对不上就暴露了注册/续期用的 TTL 不一致');
  }

  console.log('\n【3c-3】roster 的读-改-写：更新心跳，且不破坏别的');
  {
    // ⚠️ heartbeat 用读-改-写是可以的 —— 数过写入者：heartbeat 只有
    //    agent 自己串行调用，唯一可能撞的是它自己的 register，后果是时间戳
    //    差几秒而不是数据损坏。
    //    这一节守的是读-改-写的真实风险：会不会冲掉别的字段。
    await roster.register(redis, 'hbtest', { type: 'dev', stream: 'agent:hbtest:in' });
    const before = (await roster.lookup(redis, 'hbtest')).last_heartbeat;
    ok(typeof before === 'number', 'register 就写了 last_heartbeat');
    await new Promise((r) => setTimeout(r, 15));
    ok((await roster.heartbeat(redis, 'hbtest')) === 'renewed', '在册时返回 renewed');
    const rec = await roster.lookup(redis, 'hbtest');
    ok(rec.last_heartbeat > before, '★ 心跳时间戳前进了（不只是续 TTL）');
    ok(rec.type === 'dev' && rec.stream === 'agent:hbtest:in',
      '★ 读-改-写没把其它字段冲掉（这是这个实现的真实风险所在）');

    // 续期**不能**顺手把记录换成按约定推导的那份 —— 那会把非标准
    // 配置（自定义 stream / session）在第一次心跳时静默改掉。
    await roster.register(redis, 'hbtest',
      { type: 'dev', stream: 'weird:stream', tmux_session: 'weird_sess' });
    await roster.heartbeat(redis, 'hbtest', { type: 'dev', cwd: '/x' });
    const kept = await roster.lookup(redis, 'hbtest');
    ok(kept.stream === 'weird:stream' && kept.tmux_session === 'weird_sess',
      '★ 在册时 info 只是**备料**，不覆盖已有记录');
    await roster.unregister(redis, 'hbtest');
  }

  console.log('\n【3c-4】★ 掉册自愈：不在册就重建（这是 heartbeat 存在的第二个理由）');
  {
    // ── 为什么要能自愈 ─────────────────────────────────────────────────
    // 掉册的 agent 每轮都在调 heartbeat，而纯 EXPIRE **调了也没用**：
    // 对一个不存在的 key 返回 0，跑一万次也救不回来。
    // 「命令成功执行、返回一个表示什么都没发生的值、没人看那个值」——
    // 跟 XACK 返回 0 是同一个失败形状。
    // ─────────────────────────────────────────────────────────────
    await roster.unregister(redis, 'reborn').catch(() => {});
    ok(await redis.exists(roster.KEY('reborn')) === 0, '（前置）条目不在册');

    const r = await roster.heartbeat(redis, 'reborn', { type: 'dev', cwd: '/tmp/x' });
    ok(r === 'rebuilt', '★ 不在册 + 有素材 → 重建，返回 rebuilt');
    const rec = await roster.lookup(redis, 'reborn');
    ok(rec !== null, '★ 条目真的回来了（不是只返回个字符串）');
    ok(rec.type === 'dev' && rec.cwd === '/tmp/x', '重建用了调用方给的素材');

    // ★ 这两条是「自愈的瞬间制造一个新故障」的守卫。
    ok(rec.tmux_session === 'agent_reborn',
      '★ tmux_session 按约定补齐 —— 留空的话 watchdog 会把它的会话判成 deaf');
    ok(rec.stream === 'agent:reborn:in', '★ 收件流按约定补齐');

    // 真的拿 watchdog 验一遍，而不是只信对它行为的记忆
    const cls = watchdog.classifySessions(
      [rec], [{ name: 'agent_reborn' }, { name: 'other' }]);
    ok(cls.deaf.length === 0 && cls.live.length === 1,
      '★ 重建后 watchdog 判它 live —— 自愈没有顺手造出一条误报');

    ok(typeof rec.last_heartbeat === 'number', '重建的条目也带心跳时间戳');
    ok(await redis.ttl(roster.KEY('reborn')) > 0, '重建的条目带 TTL，不是永久 key');
    await roster.unregister(redis, 'reborn');
  }

  console.log('\n【3c-5】★ 编排者的收件流是 orch:in:agent —— 重建时最容易填错的字段');
  {
    // register() 的默认值要是无条件 `agent:${name}:in`：对 agent 恰好对，
    // 对编排者是个**没有消费者的黑洞流**：XADD 成功、relay 不报错、消息没了。
    // 显式传了 stream 的调用方不会现形；自愈重建不传。
    await roster.unregister(redis, 'JARVISTEST').catch(() => {});
    await roster.heartbeat(redis, 'JARVISTEST', { type: 'orchestrator', cwd: '/r' });
    const rec = await roster.lookup(redis, 'JARVISTEST');
    ok(rec.stream === 'orch:in:agent',
      '★ orchestrator 重建 → orch:in:agent（不是 agent:JARVISTEST:in 那个黑洞）');
    ok(rec.tmux_session === 'orch', '★ orchestrator 的会话名是 orch，不是 agent_*');
    ok(roster.inboxFor('x', 'dev') === 'agent:x:in'
      && roster.sessionFor('x', 'dev') === 'agent_x',
      '约定对 agent 不变（这两个函数是约定的唯一出处）');
    await roster.unregister(redis, 'JARVISTEST');
  }

  console.log('\n【3c-7】★ 正向/逆向必须互逆 —— 会话名约定只有一份，方向有两个');
  {
    // roster.sessionFor 是 name+type → 会话名；watchdog.sessionToName 是反过来。
    // 两个方向没法合并成一个函数，所以只能靠往返断言把它们钉在一起。
    // 一方改了另一方没跟上的后果：watchdog 把活着的 agent 认成陌生会话（判 deaf
    // 然后去 nudge 它），或者反过来整个漏掉它 —— 两种都不会有别的测试变红。
    //
    // ⚠️ **「往返回到原名」这一条比它看起来弱，别只留它。**
    //   把 sessionFor 的前缀改成 `agent-`，往返那条**照样绿** ——
    //   `sessionToName` 用的是 `slice('agent_'.length)`，**按长度切，不看内容**，
    //   `'agent-dev'.slice(6)` 一样是 `'dev'`。真正抓住这个变异的是下面那条
    //   `isAgentSession`。两条都要在。
    for (const [n, t] of [['dev', 'dev'], ['eval', 'eval'], ['JARVIS', 'orchestrator']]) {
      const s = roster.sessionFor(n, t);
      ok(watchdog.isAgentSession(s), `★ ${n}(${t}) 的会话名 ${s} 被认成 agent 会话`);
      ok(watchdog.sessionToName(s) === n, `★ 往返回到原名：${s} → ${n}`);
    }
    // 阴性对照：人自己开的会话不能被认领（否则告警变噪音，噪音多了人就不看）
    ok(!watchdog.isAgentSession('my_own_shell'),
      '阴性对照：非约定会话名不算 agent（否则「全都算」的实现也能过往返）');
  }

  console.log('\n【3c-6】★ 素材不够就不重建 —— 建一条 type 错的比不建更难查');
  {
    await roster.unregister(redis, 'noinfo').catch(() => {});
    ok(await roster.heartbeat(redis, 'noinfo') === 'need_info',
      '★ 不在册 + 没给 type → need_info');
    ok(await redis.exists(roster.KEY('noinfo')) === 0,
      '★ 而且**没有**建出一条 type=unknown 的垃圾条目');
    // type 错的后果：watchdog 照 type 选消费者组（orchestrator 走 'orch'，
    // 其余走 'agent:<name>'），组名错 → idle 查不到 → 失聪判定跟着失效。

    // 坏 JSON：续期它只会让坏数据活得更久
    await redis.set(roster.KEY('brokenrec'), '{not json', 'EX', 60);
    ok(await roster.heartbeat(redis, 'brokenrec') === 'corrupt',
      '★ 坏条目 + 没素材 → corrupt（不装作续期成功）');
    ok(await roster.heartbeat(redis, 'brokenrec', { type: 'dev' }) === 'rebuilt',
      '★ 坏条目 + 有素材 → 重建成干净的一份');
    ok((await roster.lookup(redis, 'brokenrec')).type === 'dev', '重建后能正常解析');
    await roster.unregister(redis, 'brokenrec');
  }

  console.log('\n【3c-8】★ 消费者组名：serve 和 watchdog 必须用同一份（这处分叉过一次）');
  {
    ok(roster.groupFor('dev', 'dev') === 'agent:dev', 'agent 的组名是 agent:<name>');
    ok(roster.groupFor('JARVIS', 'orchestrator') === 'orch', '编排者的组名是 orch');
    // 组名 ≠ 收件流名。混用的话 XREADGROUP 会 NOGROUP，或者更糟 —— 建出一个
    // 名字看起来对、没人往里写的组。
    ok(roster.groupFor('dev', 'dev') !== roster.inboxFor('dev', 'dev'),
      '★ 组名和收件流名不是一回事（agent:dev vs agent:dev:in）');
    ok(roster.groupFor('JARVIS', 'orchestrator') !== roster.inboxFor('JARVIS', 'orchestrator'),
      '★ 编排者两边都特殊，不能拿 inboxFor 削一截凑出组名');

    // ── 这条约定**没有逆函数**，往返那招用不上，只能守「没人再自己拼」──
    // 分叉后果：watchdog 查错组 → XINFO 查不到消费者 → idle 判定失效。
    // 一个用来发现失聪的机制，以失聪的方式坏掉，而且不会有别的测试变红。
    // ⚠️ `bin/serve.js` 不在第一个名单里：它的判定在 `relay.planRelays()` 里，
    //   它自己不调 groupFor —— 组名仍然只有一份出处。
    //   下面 serve.js 单独守「它调的是那份唯一判定」。
    const srcOf = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))    // 注释里提到不算
      .join('\n');

    for (const f of ['lib/relay.js', 'lib/watchdog.js', 'bin/orch-start.js']) {
      ok(/roster\.groupFor\(/.test(srcOf(f)), `★ ${f} 调 roster.groupFor`);
    }
    for (const f of ['lib/relay.js', 'lib/watchdog.js', 'bin/orch-start.js', 'bin/serve.js']) {
      const code = srcOf(f);
      ok(!/`agent:\$\{[^}]*\}`(?!:in)/.test(code.replace(/`agent:\$\{[^}]*\}:in`/g, '')),
        `★ ${f} 没有自己拼组名的字面量`);
    }
  }

  console.log('\n【3c-9】★ planRelays：bus 里唯一一段「决定谁能说话」的逻辑');
  {
    // 它要是长在 bin/serve.js 里 —— 入口脚本 require 不了，**整个仓库里
    // 最关键的一段就是最测不到的一段**。放在 lib/relay.js 的全部理由就是这句。
    const AG = [{ name: 'dev', type: 'dev' }, { name: 'JARVIS', type: 'orchestrator' }];

    const p = relay.planRelays({ agents: AG, current: [], orchName: 'JARVIS' });
    ok(p.want.get('dev') === 'agent:dev' && p.want.get('JARVIS') === 'orch',
      '★ 组名走 roster.groupFor（编排者是 orch，不是 agent:JARVIS）');
    ok(p.add.length === 2 && p.remove.length === 0, '空手起步：两个都要挂，没有要摘的');

    // ★ 编排者常驻 —— 掉册也不摘。否则它连「掉册了」都发不出来。
    const gone = relay.planRelays({
      agents: [{ name: 'dev', type: 'dev' }],       // 花名册里没有 JARVIS 了
      current: ['dev', 'JARVIS'], orchName: 'JARVIS',
    });
    ok(!gone.remove.includes('JARVIS'),
      '★ 编排者掉出花名册也不摘它的 relay（失去发言能力的同一刻也失去报告能力）');
    ok(gone.want.get('JARVIS') === 'orch', '而且组名仍然对');

    // ★ agent 没有这个待遇：掉册就摘。这是 agent 那段 60 秒尾巴的来源，不是 bug。
    const crewGone = relay.planRelays({
      agents: [], current: ['dev', 'JARVIS'], orchName: 'JARVIS',
    });
    ok(crewGone.remove.length === 1 && crewGone.remove[0] === 'dev',
      '★ 阴性对照：agent 掉册就摘（否则「谁都不摘」的实现也能过上面那条）');

    // ★ 那个 continue 保护：编排者的记录 type 被写坏时，不能被覆盖成 agent:JARVIS
    //   —— 否则 JARVIS 会拿 agent:JARVIS 组去 XACK orch 组的 PEL，
    //   XACK 跨组返回 0 且不报错，每条消息 60 秒后无限重投。
    const corrupt = relay.planRelays({
      agents: [{ name: 'JARVIS', type: 'dev' }],   // type 坏了
      current: [], orchName: 'JARVIS',
    });
    ok(corrupt.want.get('JARVIS') === 'orch',
      '★ 编排者记录 type 写坏也不会被算成 agent:JARVIS');

    // 已经挂着的不重复挂
    const stable = relay.planRelays({ agents: AG, current: ['dev', 'JARVIS'], orchName: 'JARVIS' });
    ok(stable.add.length === 0 && stable.remove.length === 0, '稳态：不重复挂、不乱摘');

    // orchName 必传。不给「没传就当是 JARVIS」的默认 —— 那种默认在错的时候
    // 跟对的时候长得一模一样。
    let threw = false;
    try { relay.planRelays({ agents: [], current: [] }); } catch (_) { threw = true; }
    ok(threw, '★ 不传 orchName 直接抛（不给「没传就当…」的默认）');

    // 抽完要数一遍：serve.js 得**调**它，而不是自己再算一遍
    // （抽出来而原处没删的话，两份并存照样全绿）。
    const s = fs.readFileSync(path.join(ROOT, 'bin', 'serve.js'), 'utf8');
    ok(/planRelays\(/.test(s), '★ bin/serve.js 调 planRelays');
    ok(!/relays\.has\(/.test(s),
      '★ serve.js 里没有自己重算一遍「该挂哪些」的痕迹（原实现用 relays.has 判定）');
  }

  console.log('\n【3d】路由确实挂上了，而且调的是那份唯一实现');
  {
    // bin/ 的入口脚本没法被 require（会立刻跑起来），所以用源码断言守住
    // 「路由存在」和「它没有自己重算一遍判定」这两件事
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'serve.js'), 'utf8');
    ok(/app\.get\(['"]\/api\/agents['"]/.test(src), 'GET /api/agents 路由存在');
    ok(/watchdog\.buildAgentsPayload\(/.test(src),
      '★ 路由调 buildAgentsPayload，没有在回调里自己组装（两份实现迟早分叉）');
    ok(/watchdog\.check\(redis\)/.test(src),
      '★ 判定来自 watchdog.check —— 跟 watchdog 自己用的是同一份');
    ok(!/app\.(post|put|delete)\(['"]\/api\/agents['"]/.test(src),
      '★ 这个端点只读（「一眼看清状态」和「能动手」是两件事）');
    // 页面在 `web/` 下。下面这条守的是
    // **页面真的被服务出去了** —— 这件事可能单独失效：
    // 删掉这一行，页面 404，而所有别的断言照样全绿。
    ok(/express\.static\(WEB/.test(src), '★ bin/serve.js 把 web/ 托管出去了');
  }

  console.log('\n【3e】页面侧：失聪必须一眼可见，而且不能只靠颜色');
  {
    // ⚠️ 断一个色值（如 `background:#d03b3b`）是错的守卫：
    //    换配色它会假红，而**把 deaf 和 heartbeat_lost 画成同一种红它不会红**，
    //    可后者才是这条断言真正要防的事故。
    //
    //    所以断的是**意图**：三重编码（色条 / 形状字符 / 一句说明），
    //    以及那两态必须可区分。色值随便改，这几条不动。
    const css = fs.readFileSync(path.join(ROOT, 'web', 'app.css'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');

    ok(/\.ag\.deaf\{[^}]*background:/.test(css),
      'deaf 有独立底色，不是列表里一行普通文字');
    ok(/function ago\(/.test(js),
      '页面用相对时间（绝对时间要人心算才知道有没有问题）');

    // ★ 核心那条：`◐` 和 `▲` 的区别是真实的 —— 前者在轮询、只是心跳丢了，
    //   后者轮询已停。**处置完全相反**（查心跳 vs 推恢复指令），
    //   界面把它们画成同一种红，等于告诉人这两件事一样。
    const entry = (name) => {
      const m = new RegExp(`^\\s*${name}:\\s*\\{([^}]*)\\}`, 'm').exec(js);
      if (!m) return null;
      const g = /glyph:\s*'([^']+)'/.exec(m[1]);
      const c = /cls:\s*'([^']+)'/.exec(m[1]);
      // ★ note 可能是**多段 `+` 拼接**（长文案换行写）。
      //   只认单个引号串的话，它会悄悄只抓到第一段 ——
      //   而 `rate_limited` 那句关键的「也可能是误判」正好在第二段里，
      //   断言会假红。**一个只解析得了短 note 的守卫，会逼着以后所有
      //   note 都写成一行，而这一档的 note 本来就该长。**
      const n = /note:\s*(null|(?:'[^']*'(?:\s*\+\s*)?)+)/.exec(m[1]);
      const note = !n ? null
        : n[1] === 'null' ? 'null'
          // 把 `'a' + 'b'` 拼回 `ab`：先吃掉段间的 `' + '`，再去首尾引号
          : n[1].replace(/'\s*\+\s*'/g, '').replace(/^'/, '').replace(/'$/, '');
      return g && c && note !== null ? { glyph: g[1], cls: c[1], note } : null;
    };
    const dEntry = entry('deaf');
    const hEntry = entry('heartbeat_lost');
    ok(dEntry && hEntry, 'STATUS 表里 deaf 和 heartbeat_lost 都有映射');
    ok(dEntry && hEntry && dEntry.glyph !== hEntry.glyph,
      '★ deaf 和 heartbeat_lost 的形状字符不同（不能只靠颜色区分）');
    ok(dEntry && hEntry && dEntry.cls !== hEntry.cls,
      '★ deaf 和 heartbeat_lost 的色类不同（处置相反，不该画成同一种红）');
    ok(dEntry && dEntry.note !== 'null' && hEntry && hEntry.note !== 'null',
      '★ 两态各带一句说明 —— 三重编码的第三条通道');

    // watchdog 瞎了比任何单个 agent 失聪更危险：失聪至少有一行亮红，
    // watchdog 瞎了是整个左栏空白，而空白跟「一切正常」同形。
    ok(/watchdog_blind/.test(js) && /sessions_seen\s*===\s*0/.test(js),
      '★ 页面会把「watchdog 什么都没看见」单独报出来，不画成空列表');

    // ── 页面侧的三条 ──────────
    //
    // ⚠️★ 断言必须在**剥掉注释之后**的文本上跑。不剥的话会假红：
    //   · `!/失聪/` —— 会被「『失联』不是『失聪』…」这类注释触发
    //   · `!/@media (max-width/` —— 会被提到旧 @media 的注释触发
    //   **注释里提到了那个词，而注释恰恰是在解释为什么不要它。**
    //
    //   > **一个记录「删掉了 X」的注释，会让任何搜 X 的守卫假红。**
    //   > 而假红的代价不是烦 —— 是下一个人把守卫放宽，然后它再也抓不到真事故。
    const strip = {
      css: (s) => s.replace(/\/\*[\s\S]*?\*\//g, ''),
      html: (s) => s.replace(/<!--[\s\S]*?-->/g, ''),
    };
    const htmlRaw = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    const html = strip.html(htmlRaw);
    const cssNoComment = strip.css(css);

    // ★ 用词改了，但 level 值不许跟着改。
    //   「失聪 → 失联」是文案；`deaf` 是 watchdog 的 level 值。
    //   一起改的话前端就认不出后端推来的那个 level，**而它不会报错，
    //   只会安静地走 UNMAPPED 分支** —— 一个改文案改出来的失效判定。
    ok(/失联/.test(html) && !/失聪/.test(html),
      '★ 顶栏用词是「失联」');
    ok(/deaf:\s*\{/.test(js) && /id="s-deaf"/.test(html),
      '★★ 而 `deaf` 这个 level 值原样不动 —— 文案和协议值分开');

    // ★ 失败和过期是两种状态，能同时出现。
    //   旧写法是三元表达式，于是**既失败又过期的结果只显示红，
    //   丢掉了「它是旧的」** —— 而那条信息决定人下一步是「重跑」还是「去查」。
    ok(/\.stat\.bad\.stale-data\{/.test(cssNoComment),
      '★★ CSS 里有 .bad.stale-data 的组合规则（两个状态能同时显示）');
    ok(!/bad\s*\?\s*' bad'\s*:\s*d\.stale/.test(js),
      '★ JS 里不再用三元表达式把这两个状态做成互斥');

    // ★ 窄屏分支**不许退回整页滚动**。
    //   窄屏分支写了 `body{height:auto;overflow:auto}` 的话 →
    //   输入框会被长消息推出视口。
    //
    // ⚠️ 窄屏是要的（< 900px：舰队带横向滚、右栏收成按钮、不能整页横向滚），
    //   所以不断「有没有窄屏分支」，断**会咬人的那一处**：
    //     任何 max-width 分支里的 `body` 都不许改高度链（height:auto / overflow 放开）。
    //   要防的是「窄屏分支动了 body 的高度链」，不是「写窄屏」这件事。
    //   ⚠️ 只断 `@media` 不行 —— 深色主题那两条也是 @media。断 max-width。
    const narrowBlocks = (css) => {
      const out = [];
      const re = /@media\s*\(max-width[^{]*\{/g;
      let m;
      while ((m = re.exec(css))) {
        let depth = 1, i = re.lastIndex;
        for (; i < css.length && depth; i++) {
          if (css[i] === '{') depth++;
          else if (css[i] === '}') depth--;
        }
        out.push(css.slice(re.lastIndex, i - 1));
      }
      return out;
    };
    const bodyBreaksChain = (block) => [...block.matchAll(/(^|[},\s])body\s*\{([^}]*)\}/g)]
      .some((b) => /height\s*:\s*auto|overflow(-y)?\s*:\s*(auto|scroll|visible)/.test(b[2]));
    const blocks = narrowBlocks(cssNoComment);
    ok(blocks.length > 0 && !blocks.some(bodyBreaksChain),
      `★★ 窄屏分支（${blocks.length} 段 max-width）里没有动 body 的高度链（height:auto / overflow 放开）`);
    ok(/body\{[^}]*height:100dvh[^}]*overflow:hidden/.test(cssNoComment),
      '★★ 而 body 本身仍是 100dvh + overflow:hidden（输入框永远在视口里那条链）');
    ok(bodyBreaksChain(narrowBlocks('@media (max-width:760px){body{height:auto;overflow:auto}}')[0] || ''),
      '★ 阴性对照：当年那段 `body{height:auto;overflow:auto}` 被认得出来（上面那条不是恒真）');
    ok(/prefers-color-scheme/.test(cssNoComment),
      '★ 阴性对照：深色主题那两条 @media 还在（不是把媒体查询全删了）');

    // ── ★★★ 第四档 rate_limited 的页面侧 ─────────────────
    //
    //   **后端分了组、前端不认，那一组就等于不存在** —— 撞了限额的 agent
    //   会掉进 live 显示成绿的，人以为额度还够，接着派活接着撞。
    //   这一组守的就是那个「假绿」。
    //
    //   ⚠️ 全部跑在剥掉注释的文本上：上面那条（「一个记录『删掉了 X』
    //   的注释会让任何搜 X 的守卫假红」）在这里同样适用 —— 这一档的
    //   注释里满是 `deaf` 和「限额」。
    const jsNoComment = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const rEntry = entry('rate_limited');
    ok(!!rEntry, '★★ STATUS 表里有 rate_limited 的映射 —— 没有它会落到 UNMAPPED 显示成「未知状态」',
      JSON.stringify(rEntry));
    // ★★★ JARSIS 约束一：视觉不能跟 deaf 同色。
    //   deaf = 「去救它」，这一档 = 「别碰它，等额度回来」，**处置相反**。
    //   人看的是颜色不是字段名 —— 同色等于告诉他这两件事一样。
    ok(rEntry && dEntry && rEntry.cls !== dEntry.cls,
      '★★★ rate_limited 和 deaf 的色类不同 —— 处置相反的两档不许画成同一种红',
      JSON.stringify([rEntry && rEntry.cls, dEntry && dEntry.cls]));
    ok(rEntry && dEntry && rEntry.glyph !== dEntry.glyph,
      '★★ 形状字符也不同（不能只靠颜色区分）',
      JSON.stringify([rEntry && rEntry.glyph, dEntry && dEntry.glyph]));
    // ★★★ 约束二：note 必须带那句假阳性提示，不能只显示状态名。
    //   人看到「rate_limited」会当成事实；判据只是 pane 末尾几十行里的字样，
    //   而一个正在写限额相关代码的 agent pane 上也有这些字。
    ok(rEntry && /也可能/.test(rEntry.note),
      '★★★ note 里带着「也可能是它正好在读这类文字」—— 只显示状态名会被当成事实',
      rEntry && rEntry.note);
    ok(rEntry && /确认一眼|去确认/.test(rEntry.note),
      '★★ 而且给出下一步动作（去确认一眼），不是只丢一个免责声明',
      rEntry && rEntry.note);
    // 接线：渲染真的读了后端那一组
    ok(/d\.rate_limited/.test(jsNoComment),
      '★★★ renderAgents 真的读了 d.rate_limited —— 不读的话后端分组白分，'
      + '那些 agent 一个都不显示（比显示成绿的更坏：整行消失）',
      (jsNoComment.match(/.*rate_limited.*/g) || []).join(' | ').slice(0, 200));
    // CSS：独立底色 + 四个主题块都定义了变量
    ok(/\.ag\.limit\{[^}]*background:/.test(cssNoComment),
      '★★ .ag.limit 有独立底色，不是列表里一行普通文字');
    ok(!/\.ag\.limit\{[^}]*var\(--deaf/.test(cssNoComment),
      '★★ 而且它没有借用 --deaf 那个红（借了就等于在 CSS 上把两组合回去了）');
    // ★ 主题变量漏一处不会报错 —— 只会在那个主题下 var(--limit) 解析失败、
    //   颜色静默回落成继承值。**四个块：亮 / @media 深 / [data-theme=dark] / [light]。**
    const limitDefs = (cssNoComment.match(/--limit:/g) || []).length;
    ok(limitDefs === 4,
      `★★ --limit 在四个主题块里都定义了（实际 ${limitDefs} 处）——`
      + '漏一处只会在那个主题下静默回落，不报错',
      String(limitDefs));
    ok((cssNoComment.match(/--limit-bg:/g) || []).length === 4,
      '★★ --limit-bg 同样四处');
    // 状态栏那一格
    ok(/id="s-limit"/.test(html), '★ 状态栏有「限额」那一格');
    ok(/id="s-limit-wrap"[^>]*hidden/.test(html),
      '★ 默认 hidden —— 常驻一个 0 会把真正要紧的那格淹掉');
    ok(/\.stat\.limit\{/.test(cssNoComment),
      '★★ .stat.limit 有自己的规则，没复用 .bad（那是红的，含义相反）');
  }

  console.log('\n【4】★ W4 kill 之后回查事实 —— 不拿命令返回值当结果');
  // `tmux.kill()` 返回 false 有两种含义：会话本来就没了，或者 kill 失败。
  // 只写乐观那半（「会话本来就没了」）的话，读的人以为收干净了，而会话还活着 ——
  // 比如 agent 发完哨兵、停止轮询、会话没被收掉，就卡在这条路径上。
  const sd = require('../lib/shutdown');
  {
    const logs = [];
    // kill 报告成功，但回查说会话仍在 —— 现在完全看不见的那一格
    const t = sd.createTracker({
      kill: async () => true,
      exists: async () => true,
      onLog: (m) => logs.push(m),
    });
    t.request('ghostcrew', 'engloop_w4_fake', { now: 0 });
    const r = await t.ready('ghostcrew');
    ok(r.killed === false,
      '★ kill 说成功但会话仍在 → killed 记为 false（判据是回查的事实，不是命令返回值）',
      JSON.stringify(r));
    ok(r.still_there === true, '记录里留下了「会话仍在」这个事实');
    ok(logs.some((l) => /仍在/.test(l)),
      '★ 日志明确说「kill 已执行但会话仍在」，不是「会话本来就没了」', logs.join(' | '));
  }
  {
    // 正常路径：kill 成功、回查确认没了
    const t = sd.createTracker({ kill: async () => true, exists: async () => false, onLog: () => {} });
    t.request('okcrew', 'engloop_w4_ok', { now: 0 });
    const r = await t.ready('okcrew');
    ok(r.killed === true, '阴性对照：真收掉了 → killed 为 true（否则「全部报仍在」的实现也能过）');
  }
  {
    // 回查本身失败 → 不敢说会话没了，按「仍在」处理（宁可多报一次告警）
    const t = sd.createTracker({
      kill: async () => true,
      exists: async () => { throw new Error('tmux 挂了'); },
      onLog: () => {},
    });
    t.request('errcrew', 'engloop_w4_err', { now: 0 });
    const r = await t.ready('errcrew');
    ok(r.killed === false, '回查失败 → 保守地记为没收掉（查不到不等于没了）');
  }
  {
    // exists 必填 —— 给默认实现等于把二义以「向后兼容」的名义重新引进来
    let threw = false;
    try { sd.createTracker({ kill: async () => true }); } catch (_) { threw = true; }
    ok(threw, '★ 不注入 exists 直接抛错（不给「没传就当收掉了」的默认）');
  }

  console.log('\n【4b】★ W4 第二处：发给**人**的告警也必须由回查结果决定');
  // 这一处比终端日志更要紧：终端日志只有守在屏幕前的人看得见，
  // 而这条是系统告诉外界「发生了什么」的**唯一出口**。
  // 写错的后果：人收到「已强杀」，而那个会话还活着。
  {
    const notKilled = sd.timeoutAlertText({
      name: 'ghost', session: 'agent_ghost', detail: '静默 187s 无任何活动', killed: false,
    });
    const killed = sd.timeoutAlertText({
      name: 'gone', session: 'agent_gone', detail: '静默 187s 无任何活动', killed: true,
    });
    ok(/仍在/.test(notKilled),
      '★ 会话仍在时，人向告警明说「已执行强杀但会话仍在」', notKilled.slice(0, 120));
    ok(/tmux kill-session -t agent_ghost/.test(notKilled),
      '给出人能直接跑的补救命令（收到告警的人需要下一步动作，不是一个诊断）');
    ok(!/已强杀，会话已确认收掉/.test(notKilled),
      '★ 没有在会话还活着时说「已确认收掉」');
    ok(/已确认收掉/.test(killed), '阴性对照：真收掉了就正常说收掉了');
    ok(/PEL|重投/.test(notKilled) && /PEL|重投/.test(killed), '两种情况都保留了 PEL 重投的说明');
  }

  console.log('\n【W9】★★★ 第四档 rate_limited：撞了上游限额 —— 不 nudge，报给人');
  {
    // ── 守的是什么 ────────────────────────────────────────────────
    //   agent 撞限额 → 无法轮询 → 掉册 → watchdog 判「失聪」
    //   → send-keys 推一把 → 被唤醒 → 立刻再撞墙 → 再掉册 → 再 nudge。
    //   **watchdog 会把一次撞限额变成永动机**，烧光一整份订阅额度。
    //
    //   ★ 这一档的验证必须能造出来 —— 不能等下一次真撞限额才知道它对不对。
    //     真限额一年撞不了几次，**而一个从没被执行过的分支等于不存在**。

    // ① 判定器本身。喂假 pane 文本，这是整条修法唯一可造的入口。
    const HITS = [
      'Claude usage limit reached · resets at 3pm',
      '  ⎿  You have reached your session limit',
      'Error: rate limit exceeded, please try again',
      'limit reached — resets in 2 hours',
    ];
    for (const s of HITS) {
      ok(watchdog.looksRateLimited(s) === true, `★ 认得出限额提示: ${JSON.stringify(s.slice(0, 40))}`);
    }
    const MISS = [
      '$ node bin/next.js --block 3000',
      '{"timeout":true}',
      // ⚠️ 这个样本不能写成一行测试总结（形如「✓ 通过 N · 失败 0」）——
      //   **它会劫持 run-all 的统计**：run-all 用
      //   `out.match(/通过 (\d+) · 失败 (\d+)/)` 取**第一个**匹配，
      //   于是整个文件的成绩被报成这个字符串里的数，
      //   而真实总结在文件末尾、永远轮不到。
      //   🔴 更坏的方向：真有断言失败时，它同样会被这个假的「失败 0」盖住。
      '  ✓ 断言全部通过，没有失败项',
      '', null, undefined, 42,
    ];
    for (const s of MISS) {
      ok(watchdog.looksRateLimited(s) === false, `★ 普通输出不误判: ${JSON.stringify(s)}`);
    }

    // ② ★★★ check()：pane 上有限额提示 → **rate_limited，而不是 deaf**
    //    （喂假 pane 文本，断言返回 rate_limited）
    //    造 deaf 场景 = 会话在 + 不在花名册。'rl' 没注册过，所以它必落这格。
    const tRL = fakeTmux(['agent_rl'], 'Claude usage limit reached · resets at 3pm');
    const fRL = (await wdCheck(redis, { tmuxApi: tRL })).findings.find((x) => x.name === 'rl');
    ok(!!fRL, '（前置）造出了一个不在花名册的会话', JSON.stringify(fRL));
    ok(fRL && fRL.level === 'rate_limited',
      '★★★ pane 上有限额提示 → 判 rate_limited（**不是 deaf**）—— 这一条红了就是把撞额度误判成了聋',
      fRL && fRL.level);
    // ★ 守「只看末尾几十行」那条降假阳性的措施 —— 没人守的话它会悄悄变成全量
    const peeked = tRL.calls.find((c) => c.fn === 'peek');
    ok(peeked && peeked.lines === watchdog.RATE_LIMIT_PEEK_LINES,
      `★ peek 按 RATE_LIMIT_PEEK_LINES(${watchdog.RATE_LIMIT_PEEK_LINES}) 取末尾行，不是全量`,
      JSON.stringify(peeked));

    // ③ ★ 阴性对照：**同一个场景**，只把 pane 换成干净的 → 判回 deaf。
    //    没有这一条，一个「永远返回 rate_limited」的实现也能让 ② 全绿。
    const tOK = fakeTmux(['agent_rl'], '$ node bin/next.js\n{"timeout":true}');
    const fOK = (await wdCheck(redis, { tmuxApi: tOK })).findings.find((x) => x.name === 'rl');
    ok(fOK && fOK.level === 'deaf',
      '★★ 阴性对照：pane 干净 → 判回 deaf —— ② 不是恒真',
      fOK && fOK.level);

    // ④ ★★★ peek 抛错 → **不许悄悄降级**。level 留在 deaf，但带上 pane_error。
    const tErr = {
      ...fakeTmux(['agent_rl']),
      peek: async () => { throw new Error('no server running on /tmp/tmux-501/default'); },
    };
    const fErr = (await wdCheck(redis, { tmuxApi: tErr })).findings.find((x) => x.name === 'rl');
    ok(fErr && !!fErr.pane_error,
      '★★★ peek 失败 → pane_error 作为事实进 findings（「查不了」不许降级成一个具体答案）',
      JSON.stringify(fErr && fErr.pane_error));
    ok(fErr && /no server running/.test(fErr.pane_error || ''),
      '★ pane_error 带着原始错因，人看得出该去查什么', fErr && fErr.pane_error);

    // ⑤ ★★★ act()：rate_limited **绝不 nudge**，而且要告警给人
    await redis.del('orch:out');
    const aRL = fakeTmux(['agent_rl']);
    await watchdog.act(redis, [{
      name: 'rl9', level: 'rate_limited', tmux_session: 'agent_rl', idleMs: 999_999, pending: 0,
    }], { tmuxApi: aRL, onLog: () => {} });
    ok(!aRL.calls.some((c) => c.fn === 'submit' || c.fn === 'nudge'),
      '★★★ rate_limited 一次 submit / nudge 都没发 —— 推它只会更快撞下一次',
      JSON.stringify(aRL.calls));
    const rlOut = await redis.xrange('orch:out', '-', '+');
    ok(rlOut.length === 1, '★★ 但**报给人了** —— 不 nudge 不等于不吭声', String(rlOut.length));
    const rlText = rlOut.length ? Object.fromEntries(
      rlOut[0][1].reduce((a, v, i) => (i % 2 ? a[a.length - 1].push(v) : a.push([v]), a), [])
        .map(([k, v]) => [k, v]),
    ).text : '';
    ok(/不要手动推|不要手动|别手动/.test(rlText),
      '★★ 告警里明说「你也不要手动推」—— 「我没救它」不等于告诉他「他也不该救」',
      rlText.slice(0, 160));
    ok(/误判|假阳|正好在处理/.test(rlText),
      '★★ 告警里带上已知的误判方向 —— 人看到 rate_limited 会当成事实，'
      + '得让他知道该去确认一眼', rlText.slice(0, 240));

    // ⑥ ★★★ act()：deaf **但读不到 pane** → 同样不 nudge
    //    别让一次读取失败把 rate_limited 悄悄降级回 deaf 再去 nudge。
    await redis.del('orch:out');
    const aBlind = fakeTmux(['agent_rl']);
    await watchdog.act(redis, [{
      name: 'rl9b', level: 'deaf', tmux_session: 'agent_rl', idleMs: null, pending: 0,
      pane_error: 'capture-pane failed',
    }], { tmuxApi: aBlind, onLog: () => {} });
    ok(!aBlind.calls.some((c) => c.fn === 'submit'),
      '★★★ deaf + pane_error → 不发恢复指令（排除不掉「撞了限额」这一种）',
      JSON.stringify(aBlind.calls));
    ok((await redis.xrange('orch:out', '-', '+')).length === 1,
      '★★ 而且报给人了 —— 静默地不动作跟没检查一模一样');

    // ⑦ ★★ 阴性对照：deaf 且 pane 读得到（没有 pane_error）→ **照常 submit**。
    //    没有这一条，一个「deaf 分支整个坏掉」的实现也能让 ⑤⑥ 全绿。
    await redis.del('orch:out');
    const aDeaf = fakeTmux(['agent_rl']);
    await watchdog.act(redis, [{
      name: 'rl9c', level: 'deaf', tmux_session: 'agent_rl', idleMs: null, pending: 0,
    }], { tmuxApi: aDeaf, onLog: () => {} });
    ok(aDeaf.calls.some((c) => c.fn === 'submit'),
      '★★ 阴性对照：正常 deaf 仍然发恢复指令 —— ⑤⑥ 不是「deaf 分支坏了」',
      JSON.stringify(aDeaf.calls));

    // ⑧ ★★ buildAgentsPayload：rate_limited **不许掉进 live**（假绿）
    const payload = watchdog.buildAgentsPayload(
      [{ name: 'rl9', type: 'unknown', level: 'rate_limited', tmux_session: 'agent_rl', idleMs: 1, pending: 0 }],
      [], Date.now(), 1,
    );
    ok(Array.isArray(payload.rate_limited) && payload.rate_limited.length === 1,
      '★★ rate_limited 单独成组', JSON.stringify(payload.rate_limited));
    ok(!payload.live.some((x) => x.name === 'rl9'),
      '★★★ **不在 live 组里** —— 混进去等于界面显示成绿的，人以为额度还够，接着派活接着撞',
      JSON.stringify(payload.live));
    ok(!payload.deaf.some((x) => x.name === 'rl9'),
      '★★ 也不在 deaf 组 —— 那两档对人的指示相反（deaf 该救，这档不许碰）');

    await redis.del('orch:out', 'agent:rl:in');
  }

  for (const a of await roster.list(redis)) await roster.unregister(redis, a.name);
  await redis.del('orch:out', 'agent:healthy:in');
  await redis.quit();

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
