'use strict';

/**
 * watchdog 拿 StopFailure 信号当第二个证据。
 *
 *   假 tmuxApi ＋ 临时信号目录 ＋ Redis 测试库。「信号 × pane × 队列读数」的每种组合一个用例，再加：
 *   锚点取 signal.at · 线索从 message_tail 来 · 「at 之后读过队列 ⇒ 无效、文件被删」·
 *   ★「刚撞墙、花名册还是 ok ⇒ 文件**不能**被删」。
 *
 * ⚠️ 测不到的一格（写明，不假装）：**deaf 而且有消费者**。deaf 要求 idle ≥ WARN_MS（15 分钟），而 idle 是
 *   Redis 服务端计时，测试造不出（`levelFor` 头注同一个理由）。⇒ 表里的 deaf 行都用「组里没有消费者」
 *   （idle = null）或 XINFO 失败（probe_error）；`idle >= now - at` 那条比较由【1】的纯函数用例和
 *   【6】的在册 / heartbeat_lost 用例守。
 *
 * ⚠️ 施工纪律（X1/X2，同 watchdog-rate-limit-*）：本文件不出现能命中入口判据的字面文本；
 *   有限额文案的 pane 一律从 test/fixtures/rate-limit-panes/ 读。文件末尾自查。
 *
 * 变异：test/stopfailure-mutation.test.js 用 `node -r test/fixtures/e15-mutant-preload.js` 跑本文件。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ★ 信号目录：参数和环境变量**都**指到临时目录 —— 变异 2（清理挂到 act() 里，走默认目录）要删得到这里，
//   才杀得死；而生产的 temp/signals/ 一个字都不碰。【7】另外验「参数优先于环境变量」。
const SIGNALS = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-e15-signals-'));
process.env.ENGLOOP_SIGNALS_DIR = SIGNALS;
const OUTBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-e15-outbox-'));
const OTHER = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-e15-other-'));
process.on('exit', () => {
  for (const d of [SIGNALS, OUTBOX, OTHER]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清不掉就算了 */ } }
});

const q = require('../lib/queue');
const roster = require('../lib/roster');
const watchdog = require('../lib/watchdog');
const rlSignal = require('../lib/rate-limit-signal');

let pass = 0; let fail = 0;
const ok = (c, l, d = '') => (c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`)));

const OUT_T = 'engloop:wde15:out';
const FIX = path.join(__dirname, 'fixtures', 'synthetic', 'rate-limit-panes', 'line-only.txt');
const PANE_RL = fs.readFileSync(FIX, 'utf8');                                        // 有限额文案，线索 2:10pm LA
const PANE_RL_NO_TIME = PANE_RL.replace(/[0-9]{1,2}:[0-9]{2}\s*[ap]m/ig, '');        // 有文案、没有时刻
const TAIL_HINT = "You've hit your limit · resets 3:00pm (America/Los_Angeles)";    // 不命中入口判据（X1）
const SENTINEL = 'E15-SENTINEL-7f3a';
const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 tmux：pane 按会话给；值是 Error ⇒ peek 抛（= 读不到 pane）。 */
function fakeTmux(panes) {
  const calls = [];
  const sessions = Object.keys(panes);
  return {
    calls,
    list: async () => sessions.map((name) => ({ name, created: 0, attached: false })),
    exists: async (s) => sessions.includes(s),
    peek: async (s) => {
      calls.push({ fn: 'peek', s });
      const p = panes[s];
      if (p instanceof Error) throw p;
      return p;
    },
    nudge: async (s, k) => { calls.push({ fn: 'nudge', s, k }); },
    submit: async (s, t) => { calls.push({ fn: 'submit', s, t }); },
  };
}

/** 直接落一份信号（不走 hook —— hook 的「保留 at」是变异 3 的靶子，这里不让它掺进来）。 */
function putSignal(name, { at, tail = TAIL_HINT, fileName = name, dir = SIGNALS } = {}) {
  const sig = { v: 1, name, at, last_at: at, error: 'rate_limit', session_id: 's', message_tail: tail };
  fs.writeFileSync(path.join(dir, `rate_limit-${fileName}.json`), JSON.stringify(sig));
}
const sigFile = (name, dir = SIGNALS) => path.join(dir, `rate_limit-${name}.json`);

const wdCheck = (redis, tmuxApi, opts = {}) => watchdog.check(redis, {
  tmuxApi, outboxRoot: OUTBOX, signalsDir: SIGNALS, ...opts,
});
const findingOf = (r, name) => r.findings.find((f) => f.name === name);

/** start() 的 tick 做的那三步（start() 本身的接线由【6e】单独验）。 */
async function tickOnce(redis, tmuxApi, now = Date.now()) {
  const r = await wdCheck(redis, tmuxApi, { now });
  await watchdog.act(redis, r.findings, { tmuxApi, now, outStream: OUT_T });
  const removed = watchdog.sweepSignals(r.signalSweep, { now });
  return { ...r, removed };
}

async function resetAgent(redis, name) {
  await redis.del(watchdog.RL_SINCE_KEY(name), watchdog.RL_WAKES_KEY(name),
    roster.inboxFor(name, 'unknown'), roster.inboxFor(name, 'dev'));
  for (const k of ['rate_limited', 'rate_limit_wake', 'rate_limit_blind', 'rate_limit_giveup', 'deaf', 'deaf_pane_blind', 'heartbeat_lost']) {
    await redis.del(watchdog.COOLDOWN_KEY(k, name));
  }
  await roster.unregister(redis, name);
  try { fs.rmSync(sigFile(name), { force: true }); } catch (_) { /* 没有就算了 */ }
}

/** 一个在册 agent，组里有一个**刚读过**队列的消费者。 */
async function liveAgentJustRead(redis, name) {
  const stream = roster.inboxFor(name, 'dev');
  const group = roster.groupFor(name, 'dev');
  await roster.register(redis, name, { type: 'dev', stream, tmux_session: `agent_${name}` }, 300);
  await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  await redis.xreadgroup('GROUP', group, 'c1', 'COUNT', 1, 'STREAMS', stream, '>');
}

async function outTexts(redis) {
  const rows = await redis.xrange(OUT_T, '-', '+');
  return rows.map(([, f]) => { const o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1]; return o.text || ''; });
}

async function main() {
  console.log('\n══ E15 · watchdog 拿 StopFailure 信号当第二个证据 ══════════\n');
  const redis = q.createClient();
  if (!q.isTestProcess() || redis.options.db === 0) {
    console.error('🔴 拒绝运行：这个测试会写 redis，只能在测试库上跑。');
    process.exit(1);
  }
  await redis.del(OUT_T);

  console.log('━━ ⓪ 正控 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ok(redis.options.db !== 0, `连的是测试库（db ${redis.options.db}）`);
  ok(watchdog.looksRateLimited(PANE_RL) === true && watchdog.looksRateLimited('') === false,
    'fixture 命中入口判据，空 pane 不命中（下面「pane 读得到但没有文案」用空串）');
  ok(watchdog.looksRateLimited(PANE_RL_NO_TIME) === true && watchdog.extractResetHint(PANE_RL_NO_TIME).reason === 'no_time',
    '去掉时刻的 fixture：仍命中入口判据，但抓不出线索');
  ok(watchdog.looksRateLimited(TAIL_HINT) === false && watchdog.extractResetHint(TAIL_HINT).tz === 'America/Los_Angeles',
    'message_tail 那句：不命中入口判据（所以「读得到 pane 但没有文案」这一格造得出来），但抓得出线索');
  ok(rlSignal.signalsDir() === SIGNALS, 'ENGLOOP_SIGNALS_DIR 生效（变异 2 走默认目录也落在这里）');

  console.log('\n━━ 【1】有效性判据（纯函数）━━━━━━━━━━━━━━━━━━━━━━━');
  {
    const now = 1_000_000_000_000;
    const okRead = (at) => ({ state: 'ok', sig: { name: 'x', at } });
    const V = (r, idleMs) => watchdog.signalValidity(r, { now, idleMs });
    ok(V(okRead(now - 5 * MIN), 6 * MIN).valid, 'idle ≥ now−at（最后一次读队列在 at 之前）⇒ 有效');
    ok(V(okRead(now - 5 * MIN), 5 * MIN).valid, '边界：idle = now−at ⇒ 有效（>=）');
    const c = V(okRead(now - 5 * MIN), 4 * MIN);
    ok(!c.valid && c.state === 'consumed', 'idle < now−at（at 之后读过队列）⇒ 无效（consumed）', JSON.stringify(c));
    ok(V(okRead(now - 5 * MIN), null).valid, '★ idle 读不到（null）⇒ 按有效处理（偏向不 nudge）');
    const ttl = watchdog.RL_STATE_TTL_SEC * 1000;
    ok(V(okRead(now - ttl), null).valid && V(okRead(now - ttl - 1), null).state === 'expired',
      `at 超过 RL_STATE_TTL_SEC（${watchdog.RL_STATE_TTL_SEC}s）⇒ 无效（expired）；刚好 = TTL 仍有效`);
    ok(V({ state: 'bad' }, null).state === 'bad' && V({ state: 'absent' }, null).state === 'absent'
      && !V({ state: 'bad' }, null).valid, '读不出来 / 没有 ⇒ 无效');
    // name 跟文件名不一致：rlSignal.read 判
    putSignal('e15mm', { at: Date.now(), fileName: 'e15mm2' });
    const r = rlSignal.read('e15mm2', { dir: SIGNALS });
    ok(r.state === 'bad' && r.reason === 'name_mismatch', '文件里的 name 跟文件名不一致 ⇒ bad', JSON.stringify(r));
    fs.rmSync(sigFile('e15mm2'), { force: true });
  }

  console.log('\n━━ 【2】判定表，逐行（deaf 候选：会话在、不在册、组里没有消费者）━━');
  const rowCase = async (name, pane, signal) => {
    await resetAgent(redis, name);
    if (signal) putSignal(name, signal);
    return findingOf(await wdCheck(redis, fakeTmux({ [`agent_${name}`]: pane })), name);
  };
  const now0 = Date.now();
  {
    const f = await rowCase('e15r1a', PANE_RL, null);
    ok(f && f.level === 'rate_limited' && f.rate_limit_source === 'pane',
      '表第一行：pane 有文案、没有信号 ⇒ rate_limited，来源 pane（同现在）', JSON.stringify(f));
    ok(f && f.rate_limit_signal_at === undefined, '没有信号 ⇒ 不带 rate_limit_signal_at');
  }
  {
    const f = await rowCase('e15r1b', PANE_RL, { at: now0 - 3 * MIN });
    ok(f && f.level === 'rate_limited' && f.rate_limit_source === 'both',
      '表第一行：pane 有文案、信号有效 ⇒ rate_limited，来源 both', JSON.stringify(f));
  }
  {
    const f = await rowCase('e15r2', new Error('capture-pane failed'), { at: now0 - 3 * MIN });
    ok(f && f.level === 'rate_limited' && f.rate_limit_source === 'hook',
      '表第二行：pane 读不到、信号有效 ⇒ rate_limited，来源 hook', JSON.stringify(f));
    ok(f && f.pane_error === 'capture-pane failed', '「读不到 pane」这个事实照样带出去（pane_error）');
  }
  {
    const f = await rowCase('e15r3', '', { at: now0 - 3 * MIN });
    ok(f && f.level === 'rate_limited' && f.rate_limit_source === 'hook',
      '🔴 表第三行：pane 读得到、没有限额文案、信号有效 ⇒ rate_limited（不是 deaf ⇒ 不会被 nudge）', JSON.stringify(f));
  }
  {
    const f = await rowCase('e15r4a', '', null);
    ok(f && f.level === 'deaf' && f.rate_limit_source === undefined, '表第四行：没有信号、pane 没文案 ⇒ deaf（同现在）', JSON.stringify(f));
    const g = await rowCase('e15r4b', new Error('gone'), null);
    ok(g && g.level === 'deaf' && g.pane_error === 'gone', '表第四行：没有信号、pane 读不到 ⇒ deaf ＋ pane_error（同现在，act 不 nudge）', JSON.stringify(g));
    const h = await rowCase('e15r4c', '', { at: now0 - watchdog.RL_STATE_TTL_SEC * 1000 - MIN });
    ok(h && h.level === 'deaf', '表第四行：信号超过 TTL ⇒ 无效 ⇒ deaf', JSON.stringify(h));
    await resetAgent(redis, 'e15r4d');
    fs.writeFileSync(sigFile('e15r4d'), '{ 坏的');
    const i = findingOf(await wdCheck(redis, fakeTmux({ agent_e15r4d: '' })), 'e15r4d');
    ok(i && i.level === 'deaf', '表第四行：信号文件读不出来 ⇒ 无效 ⇒ deaf', JSON.stringify(i));
    fs.rmSync(sigFile('e15r4d'), { force: true });
  }
  {
    // XINFO 失败 ⇒ probe_error ⇒ idle 读不到 ⇒ 信号按有效处理
    await resetAgent(redis, 'e15probe');
    await redis.set(roster.inboxFor('e15probe', 'unknown'), 'not a stream');
    putSignal('e15probe', { at: now0 - 3 * MIN });
    const f = findingOf(await wdCheck(redis, fakeTmux({ agent_e15probe: '' })), 'e15probe');
    ok(f && f.probe_error && f.idleMs === null, '（前提）XINFO 失败 ⇒ probe_error、idle = null', JSON.stringify(f));
    ok(f && f.level === 'rate_limited' && f.rate_limit_source === 'hook',
      '🔴 idle 读不到（probe_error）⇒ 信号按有效处理 ⇒ rate_limited（偏向不 nudge）', JSON.stringify(f));
    await redis.del(roster.inboxFor('e15probe', 'unknown'));
  }

  console.log('\n━━ 【3】锚点：第一次写 rl_since 时取 min(signal.at, now) ━━━━━━━━');
  {
    const name = 'e15anc';
    await resetAgent(redis, name);
    const now = Date.now();
    const at = now - 30 * MIN;
    putSignal(name, { at, tail: 'no time here' });
    const t = fakeTmux({ [`agent_${name}`]: '' });
    const r = await wdCheck(redis, t, { now });
    await watchdog.act(redis, r.findings.filter((f) => f.name === name), { tmuxApi: t, now, outStream: OUT_T });
    const since = Number(await redis.get(watchdog.RL_SINCE_KEY(name)));
    ok(since === at, '🔴 锚点取 signal.at（它停下的时刻），不是 now（发现的时刻）',
      JSON.stringify({ since, at, now, diff_min: (since - at) / MIN }));
    ok(!t.calls.some((c) => c.fn === 'submit' || c.fn === 'nudge'), '这一轮没有 submit / nudge（看到信号不唤醒）', JSON.stringify(t.calls));

    // 已经存在的 rl_since 不改
    const t2 = fakeTmux({ [`agent_${name}`]: '' });
    putSignal(name, { at: now - 5 * MIN });
    const r2 = await wdCheck(redis, t2, { now: now + MIN });
    await watchdog.act(redis, r2.findings.filter((f) => f.name === name), { tmuxApi: t2, now: now + MIN, outStream: OUT_T });
    ok(Number(await redis.get(watchdog.RL_SINCE_KEY(name))) === at, '已经存在的 rl_since 不改（仍是 NX）');

    // 信号的 at 在未来 ⇒ 锚点 = now
    await resetAgent(redis, name);
    putSignal(name, { at: now + 60 * MIN });
    const t3 = fakeTmux({ [`agent_${name}`]: '' });
    const r3 = await wdCheck(redis, t3, { now });
    await watchdog.act(redis, r3.findings.filter((f) => f.name === name), { tmuxApi: t3, now, outStream: OUT_T });
    ok(Number(await redis.get(watchdog.RL_SINCE_KEY(name))) === now, '信号的 at 在未来（时钟不对）⇒ 锚点 = now（min）');

    // 没有信号（只凭 pane）⇒ 锚点 = now（同现在）
    await resetAgent(redis, name);
    const t4 = fakeTmux({ [`agent_${name}`]: PANE_RL });
    const r4 = await wdCheck(redis, t4, { now });
    await watchdog.act(redis, r4.findings.filter((f) => f.name === name), { tmuxApi: t4, now, outStream: OUT_T });
    ok(Number(await redis.get(watchdog.RL_SINCE_KEY(name))) === now, '没有信号 ⇒ 锚点 = now（同现在）');
    await resetAgent(redis, name);
  }

  console.log('\n━━ 【4】恢复时刻的线索：pane 优先，pane 没有 / 读不到 ⇒ message_tail ━━');
  {
    const f = await rowCase('e15h1', '', { at: now0 - 3 * MIN, tail: `noise\n${TAIL_HINT}` });
    ok(f && f.rate_limit_hint && f.rate_limit_hint.raw === '3:00pm' && f.rate_limit_hint.tz === 'America/Los_Angeles',
      '🔴 线索从 message_tail 来（pane 读得到但没有文案）', JSON.stringify(f && f.rate_limit_hint));
    const g = await rowCase('e15h2', new Error('x'), { at: now0 - 3 * MIN });
    ok(g && g.rate_limit_hint && g.rate_limit_hint.raw === '3:00pm', '线索从 message_tail 来（pane 读不到）', JSON.stringify(g && g.rate_limit_hint));
    const h = await rowCase('e15h3', PANE_RL, { at: now0 - 3 * MIN });
    ok(h && h.rate_limit_hint && h.rate_limit_hint.raw === '2:10pm', 'pane 有线索 ⇒ 用 pane 的（同现在），不被信号盖掉', JSON.stringify(h && h.rate_limit_hint));
    const i = await rowCase('e15h4', PANE_RL_NO_TIME, { at: now0 - 3 * MIN });
    ok(i && i.rate_limit_hint && i.rate_limit_hint.raw === '3:00pm' && i.rate_limit_source === 'both',
      'pane 有文案但没有时刻 ⇒ 用 message_tail 的', JSON.stringify(i && i.rate_limit_hint));
    const j = await rowCase('e15h5', PANE_RL_NO_TIME, { at: now0 - 3 * MIN, tail: 'nothing useful' });
    ok(j && j.rate_limit_hint && j.rate_limit_hint.reason === 'no_time', '两个都没有 ⇒ 留着失败理由（act 走 C7）', JSON.stringify(j && j.rate_limit_hint));

    // 两个都拿不到 ⇒ C7 fail-closed：不唤醒，告诉人，而且说清「只凭 hook」的那个代价
    const name = 'e15c7';
    await resetAgent(redis, name);
    await redis.del(OUT_T);
    const now = Date.now();
    putSignal(name, { at: now - 20 * MIN, tail: 'nothing useful' });
    await redis.set(watchdog.RL_SINCE_KEY(name), String(now - 20 * MIN));   // 不是第一轮
    const t = fakeTmux({ [`agent_${name}`]: '' });
    const r = await wdCheck(redis, t, { now });
    await watchdog.act(redis, r.findings.filter((x) => x.name === name), { tmuxApi: t, now, outStream: OUT_T });
    const texts = await outTexts(redis);
    ok(!t.calls.some((c) => c.fn === 'submit' || c.fn === 'nudge'), '只凭 hook、算不出恢复时刻 ⇒ 不 submit、不 nudge', JSON.stringify(t.calls));
    ok(texts.length === 1 && /算不出/.test(texts[0]) && /短时 429/.test(texts[0]) && /StopFailure/.test(texts[0]),
      '告诉人：算不出恢复时刻 ＋「只有 StopFailure 信号、可能只是短时 429」', texts.join(' | ').slice(0, 300));
    await resetAgent(redis, name);
  }

  console.log('\n━━ 【5】finding 不带 message_tail（它会推到浏览器）━━━━━━━━━━━━━━');
  {
    const f = await rowCase('e15tail', '', { at: now0 - 3 * MIN, tail: `${SENTINEL} ${TAIL_HINT}` });
    ok(f && f.level === 'rate_limited', '（前提）这一格判成了 rate_limited，信号确实被用了');
    ok(f && !JSON.stringify(f).includes(SENTINEL), '🔴 finding 不带 message_tail（只带 {raw, tz} 两个短串）',
      JSON.stringify(Object.keys(f || {})));
    const payload = watchdog.buildAgentsPayload([f], [], Date.now(), 1);
    ok(!JSON.stringify(payload).includes(SENTINEL), '/api/agents 的 payload 里也没有');
    ok(Number.isFinite(f.rate_limit_signal_at), '带的是 rate_limit_signal_at（一个数）');
  }

  console.log('\n━━ 【6】清理：只在「agent 在 at 之后读过队列」时删 ━━━━━━━━━━━━━━');
  {
    // a) ★ 刚撞墙、花名册还是 ok ⇒ 文件不能被删
    const name = 'e15fresh';
    await resetAgent(redis, name);
    await liveAgentJustRead(redis, name);
    await sleep(80);
    putSignal(name, { at: Date.now() });      // 读完队列之后才撞墙
    const t = fakeTmux({ [`agent_${name}`]: '' });
    const r = await tickOnce(redis, t);
    const f = findingOf(r, name);
    ok(f && f.level === 'ok', '（前提）刚撞墙的头几分钟：它还在册，级别是 ok', JSON.stringify(f));
    ok(fs.existsSync(sigFile(name)), '🔴 刚撞墙、花名册还是 ok ⇒ 信号文件**不能**被删（它最有用的时候还没到）',
      `removed=${JSON.stringify(r.removed)}`);
    ok(!r.signalSweep.consumed.some((c) => c.name === name), '也不在「该删」名单里');
    await resetAgent(redis, name);
  }
  {
    // b) at 之后读过队列 ⇒ 无效，文件被删
    const name = 'e15read';
    await resetAgent(redis, name);
    putSignal(name, { at: Date.now() - 10 * MIN });   // 十分钟前撞的
    await liveAgentJustRead(redis, name);            // 刚刚读过队列 ⇒ 那次事故过去了
    const t = fakeTmux({ [`agent_${name}`]: '' });
    const r = await tickOnce(redis, t);
    ok(r.signalSweep.consumed.some((c) => c.name === name), 'agent 在 at 之后读过队列 ⇒ 信号无效（consumed）', JSON.stringify(r.signalSweep.consumed));
    ok(!fs.existsSync(sigFile(name)) && r.removed.includes(`rate_limit-${name}.json`), '🔴 ⇒ 文件被删', JSON.stringify(r.removed));
    await resetAgent(redis, name);
  }
  {
    // b′) 不在册、但仍在读队列（heartbeat_lost）⇒ 同样算「读过了」
    const name = 'e15hb';
    await resetAgent(redis, name);
    putSignal(name, { at: Date.now() - 10 * MIN });
    const stream = roster.inboxFor(name, 'unknown');
    const group = roster.groupFor(name, 'unknown');
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
    await redis.xreadgroup('GROUP', group, 'c1', 'COUNT', 1, 'STREAMS', stream, '>');
    const r = await tickOnce(redis, fakeTmux({ [`agent_${name}`]: '' }));
    const f = findingOf(r, name);
    ok(f && f.level === 'heartbeat_lost' && f.rate_limit_source === undefined, 'heartbeat_lost 不因信号改判', JSON.stringify(f));
    ok(!fs.existsSync(sigFile(name)), 'heartbeat_lost 且在 at 之后读过队列 ⇒ 文件被删');
    await resetAgent(redis, name);
  }
  {
    // c) 比对 at 再删：check() 之后文件换成了另一次事故 ⇒ 不删
    const name = 'e15swap';
    putSignal(name, { at: 2000 });
    const removed = watchdog.sweepSignals({ consumed: [{ name, at: 1000 }], dir: SIGNALS }, { now: 3000 });
    ok(removed.length === 0 && fs.existsSync(sigFile(name)), '「该删」的是 at=1000，文件已换成 at=2000 ⇒ 不删');
    fs.rmSync(sigFile(name), { force: true });
  }
  {
    // d) 超过 TTL 的顺手删；临时文件残留按 mtime
    const now = Date.now();
    const ttl = watchdog.RL_STATE_TTL_SEC * 1000;
    putSignal('e15old', { at: now - ttl - MIN });
    putSignal('e15young', { at: now - MIN });
    const tmpOld = path.join(SIGNALS, 'rate_limit-e15x.json.tmp-1-1');
    const tmpNew = path.join(SIGNALS, 'rate_limit-e15y.json.tmp-1-2');
    fs.writeFileSync(tmpOld, '{'); fs.writeFileSync(tmpNew, '{');
    const old = (now - ttl - MIN) / 1000;
    fs.utimesSync(tmpOld, old, old);
    fs.writeFileSync(path.join(SIGNALS, 'unrelated.txt'), 'x');
    const removed = watchdog.sweepSignals({ consumed: [], dir: SIGNALS }, { now });
    ok(removed.includes('rate_limit-e15old.json') && !fs.existsSync(sigFile('e15old')), '超过 TTL 的信号顺手删掉', JSON.stringify(removed));
    ok(fs.existsSync(sigFile('e15young')), 'TTL 以内的留着（没有「读过队列」的证据就不删）');
    ok(!fs.existsSync(tmpOld) && fs.existsSync(tmpNew), '临时文件残留：旧的删、新的留（可能正在写）');
    ok(fs.existsSync(path.join(SIGNALS, 'unrelated.txt')), '不是信号文件的不碰');
    for (const f of [sigFile('e15young'), tmpNew, path.join(SIGNALS, 'unrelated.txt')]) fs.rmSync(f, { force: true });
  }
  {
    // e) start() 的 tick 真的接上了清理（上面 tickOnce 是照着它写的；这里验它本身）
    const name = 'e15start';
    await resetAgent(redis, name);
    putSignal(name, { at: Date.now() - 10 * MIN });
    await liveAgentJustRead(redis, name);
    const h = watchdog.start(redis, {
      tmuxApi: fakeTmux({ [`agent_${name}`]: '' }), signalsDir: SIGNALS, outStream: OUT_T, intervalMs: 3_600_000,
    });
    h.stop();
    let gone = false;
    for (let i = 0; i < 60 && !gone; i++) { await sleep(50); gone = !fs.existsSync(sigFile(name)); }
    ok(gone, 'start() 的 tick：act() 之后 sweepSignals() ⇒ 读过队列的那份被删');
    await sleep(100);
    await resetAgent(redis, name);
  }

  console.log('\n━━ 【7】check() 的 signalsDir 参数优先于环境变量 ━━━━━━━━━━━━━━━━');
  {
    const name = 'e15dir';
    await resetAgent(redis, name);
    putSignal(name, { at: Date.now() - 3 * MIN, dir: OTHER });
    const f = findingOf(await wdCheck(redis, fakeTmux({ [`agent_${name}`]: '' }), { signalsDir: OTHER }), name);
    ok(f && f.level === 'rate_limited' && f.rate_limit_source === 'hook', '信号只在参数给的目录里 ⇒ 照样读到', JSON.stringify(f));
    const g = findingOf(await wdCheck(redis, fakeTmux({ [`agent_${name}`]: '' })), name);
    ok(g && g.level === 'deaf', '阴性对照：换回默认目录（里面没有）⇒ deaf', JSON.stringify(g));
  }

  console.log('\n━━ 【X】施工纪律自查 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  {
    const me = fs.readFileSync(__filename, 'utf8');
    ok(watchdog.looksRateLimited(me) === false, '🔴 X1 本文件源码喂进入口判据 = false');
    ok(watchdog.looksRateLimited(PANE_RL) === true, '★ X1 阴性对照：同一个检查器对 fixture 返回 true');
  }

  await redis.del(OUT_T);
  await redis.quit();
  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
