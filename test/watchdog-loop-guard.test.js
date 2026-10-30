'use strict';

/**
 * watchdog × loop_guard（S1B R2 / R3）：`.stopped` 快速兜底 ＋ 暂停标记。
 *
 * 判定表（只有「该推」那一格推）：
 *   `.stopped` 原因 limit / unexpected × 满 60 秒 × 标记后没读过队列 × 没暂停 × 不在关停 × 没有撞限额证据 ⇒ submit 一条恢复指令
 *   原因 paused / shutdown / bus_down ⇒ 不推          不到 60 秒 ⇒ 不推          暂停了 ⇒ 不推、不告警
 *   在关停 ⇒ 不推          撞限额（StopFailure 信号 / pane 文案）或 pane 读不到 ⇒ **不推、报给人**
 *
 * 真 redis（测试库）＋ 假 tmux（只列本测试的会话、记下 submit / nudge）。标记目录、信号目录、outbox 全在临时目录。
 * 「标记之后没读过队列」用「组建好了、一个消费者都没有」造（idle = null）—— 真 idle 由 redis 服务端计时，造不出 61 秒；
 * 「读过队列」那一格用一个刚 XREADGROUP 过的消费者造（idle ≈ 0）。idle 的各种取值另由 test/loop-guard.test.js【7】的纯函数表覆盖。
 *
 * ⚠️ 施工纪律（同 watchdog-stopfailure）：本文件不出现能命中 RATE_LIMIT_RE 的字面文本 —— 限额 pane 从 fixture 读。文件末尾自查。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-wdlg-'));
const GUARD = path.join(TMP, 'guard');
const SIGNALS = path.join(TMP, 'signals');
const OUTBOX = path.join(TMP, 'outbox');
for (const d of [GUARD, SIGNALS, OUTBOX]) fs.mkdirSync(d, { recursive: true });
process.env.ENGLOOP_LOOP_GUARD_DIR = GUARD;
process.env.ENGLOOP_SIGNALS_DIR = SIGNALS;
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 清不掉就算了 */ } });

const q = require('../lib/queue');
const roster = require('../lib/roster');
const watchdog = require('../lib/watchdog');
const lg = require('../lib/loop-guard');

let pass = 0; let fail = 0;
const ok = (c, l, d = '') => (c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`)));

const OUT_T = 'engloop:wdlg:out';
const PANE_RL = fs.readFileSync(path.join(__dirname, 'fixtures', 'synthetic', 'rate-limit-panes', 'line-only.txt'), 'utf8');
const TAIL_HINT = "You've hit your limit · resets 3:00pm (America/Los_Angeles)";

function fakeTmux(panes) {
  const calls = [];
  const sessions = Object.keys(panes);
  return {
    calls,
    list: async () => sessions.map((name) => ({ name, created: 0, attached: false })),
    exists: async (s) => sessions.includes(s),
    peek: async (s) => { const p = panes[s]; if (p instanceof Error) throw p; return p; },
    nudge: async (s, k) => { calls.push({ fn: 'nudge', s, k }); },
    submit: async (s, t) => { calls.push({ fn: 'submit', s, t }); },
  };
}

const COOLDOWN_KINDS = ['stopped', 'stopped_hold', 'paused', 'deaf', 'deaf_pane_blind', 'rate_limited', 'nudge', 'heartbeat_lost'];
async function reset(redis, name) {
  for (const k of COOLDOWN_KINDS) await redis.del(watchdog.COOLDOWN_KEY(k, name));
  await redis.del(roster.inboxFor(name, 'dev'), watchdog.RL_SINCE_KEY(name), watchdog.RL_WAKES_KEY(name));
  await roster.unregister(redis, name).catch(() => {});
  for (const f of [lg.pausedFile(name, GUARD), lg.stoppedFile(name, GUARD), path.join(SIGNALS, `rate_limit-${name}.json`)]) fs.rmSync(f, { force: true });
}

/** 在册、组建好了、没有消费者（idle = null ⇒ 从没读过队列）。 */
async function liveNeverRead(redis, name) {
  const stream = roster.inboxFor(name, 'dev');
  await roster.register(redis, name, { type: 'dev', stream, tmux_session: `agent_${name}` }, 300);
  await redis.xgroup('CREATE', stream, roster.groupFor(name, 'dev'), '$', 'MKSTREAM');
}
/** 在册、刚读过队列（idle ≈ 0）。 */
async function liveJustRead(redis, name) {
  await liveNeverRead(redis, name);
  const stream = roster.inboxFor(name, 'dev');
  await redis.xreadgroup('GROUP', roster.groupFor(name, 'dev'), 'c1', 'COUNT', 1, 'STREAMS', stream, '>');
}

async function outTexts(redis) {
  const rows = await redis.xrange(OUT_T, '-', '+');
  return rows.map(([, f]) => { const o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1]; return o.text || ''; });
}

/** 一轮 check ＋ act。返回 { f（这个名字的 finding）, calls（submit/nudge）, out（这轮新推给人的消息）, events }。 */
async function tick(redis, name, { pane = '', isShuttingDown, now = Date.now() } = {}) {
  const tmuxApi = fakeTmux({ [`agent_${name}`]: pane });
  const before = (await outTexts(redis)).length;
  const r = await watchdog.check(redis, { tmuxApi, outboxRoot: OUTBOX, signalsDir: SIGNALS, loopGuardDir: GUARD, now, ...(isShuttingDown ? { isShuttingDown } : {}) });
  const events = [];
  await watchdog.act(redis, r.findings.filter((x) => x.name === name), { tmuxApi, now, outStream: OUT_T, onEvent: (e) => events.push(e) });
  const out = (await outTexts(redis)).slice(before);
  return { f: r.findings.find((x) => x.name === name), calls: tmuxApi.calls, out, events };
}

const stopAgo = (name, reason, ms) => lg.writeStopped(name, reason, 'test', { dir: GUARD, now: Date.now() - ms });
const submits = (t) => t.calls.filter((c) => c.fn === 'submit');

async function main() {
  console.log('\n══ watchdog × loop_guard（S1B）══\n');
  const redis = q.createClient();
  if (!q.isTestProcess() || redis.options.db === 0) {
    console.error('🔴 拒绝运行：这个测试会写 redis，只能在测试库上跑。');
    process.exit(1);
  }
  await redis.del(OUT_T);
  ok(watchdog.looksRateLimited(PANE_RL) === true, '正控：fixture 命中限额入口判据');

  console.log('\n【1】该推的那一格：limit / unexpected、满 60 秒、没读过队列、没暂停、不在关停、没有限额证据');
  for (const reason of ['limit', 'unexpected']) {
    const n = `wdlg1${reason.slice(0, 3)}`;
    await reset(redis, n);
    await liveNeverRead(redis, n);
    stopAgo(n, reason, 61_000);
    const t = await tick(redis, n);
    ok(t.f && t.f.level === 'stopped' && t.f.stopped && t.f.stopped.reason === reason && !t.f.stopped.hold,
      `${reason}：判成 stopped（没有 hold）`, JSON.stringify(t.f));
    ok(submits(t).length === 1 && submits(t)[0].s === `agent_${n}`, `${reason}：★ submit 了一条恢复指令（消息，不是 ESC）`, JSON.stringify(t.calls));
    ok(submits(t)[0] && submits(t)[0].t.includes(`--group agent:${n}`) && submits(t)[0].t.includes('bin/next.js'),
      `${reason}：指令里带它该跑的 poller 命令`, submits(t)[0] && submits(t)[0].t);
    ok(!t.calls.some((c) => c.fn === 'nudge'), `${reason}：没发 ESC`);
    ok(t.out.length === 0, `${reason}：没打扰人（例行自愈，事件流里看得见）`, JSON.stringify(t.out));
    ok(t.events.some((e) => e.level === 'stopped' && e.action === 'submit'), `${reason}：发了 level=stopped action=submit 的事件`);
    const t2 = await tick(redis, n);
    ok(submits(t2).length === 0 && t2.events.some((e) => e.throttled), `${reason}：冷却中第二轮不重推（事件照发，throttled）`);
  }

  console.log('\n【2】不推：原因不对 / 太新 / 读过队列');
  for (const reason of ['paused', 'shutdown', 'bus_down']) {
    const n = `wdlg2${reason.slice(0, 3)}`;
    await reset(redis, n);
    await liveNeverRead(redis, n);
    stopAgo(n, reason, 600_000);
    const t = await tick(redis, n);
    ok(t.f.level !== 'stopped' && submits(t).length === 0, `原因 ${reason} ⇒ 不推（level ${t.f.level}）`);
  }
  {
    const n = 'wdlg2new';
    await reset(redis, n);
    await liveNeverRead(redis, n);
    stopAgo(n, 'limit', 30_000);
    const t = await tick(redis, n);
    ok(t.f.level !== 'stopped' && submits(t).length === 0, '标记只有 30 秒 ⇒ 不推');
  }
  {
    const n = 'wdlg2rd';
    await reset(redis, n);
    stopAgo(n, 'limit', 61_000);
    await liveJustRead(redis, n);   // 标记之后读过队列
    const t = await tick(redis, n);
    ok(t.f.level === 'ok' && submits(t).length === 0, '★ 标记之后读过队列（已回到 poller）⇒ 不推', JSON.stringify(t.f));
  }

  console.log('\n【3】暂停 ⇒ 不推、不告警（降成一行日志）');
  {
    const n = 'wdlg3';
    await reset(redis, n);
    await liveNeverRead(redis, n);
    stopAgo(n, 'limit', 61_000);
    lg.setPaused(n, { dir: GUARD });
    const t = await tick(redis, n);
    ok(t.f.paused === true && t.f.level !== 'stopped', 'finding 带 paused，不判 stopped', JSON.stringify(t.f));
    ok(submits(t).length === 0 && t.out.length === 0, '★ 不推、不推给人');
    // 暂停 × deaf：会话在、不在册 —— 原本要 submit 并告诉人「失聪了」
    const d = 'wdlg3deaf';
    await reset(redis, d);
    const ctrl = await tick(redis, d);
    ok(ctrl.f.level === 'deaf' && submits(ctrl).length === 1 && ctrl.out.length === 1, '阳性对照：没暂停的 deaf ⇒ submit ＋ 告诉人');
    await reset(redis, d);
    lg.setPaused(d, { dir: GUARD });
    const pd = await tick(redis, d);
    ok(pd.f.level === 'deaf' && pd.f.paused === true && submits(pd).length === 0 && pd.out.length === 0,
      '★ 暂停了的 deaf ⇒ 判定照做（页面看得见），但不推、不告警', JSON.stringify({ calls: pd.calls, out: pd.out }));
    ok(pd.events.length <= 1 && pd.events.every((e) => e.action === 'none'), '最多一条 action=none 的事件（冷却里的那一行）');
  }

  console.log('\n【4】在关停 ⇒ 不推');
  {
    const n = 'wdlg4';
    await reset(redis, n);
    await liveNeverRead(redis, n);
    stopAgo(n, 'limit', 61_000);
    const t = await tick(redis, n, { isShuttingDown: (x) => x === n });
    ok(t.f.level !== 'stopped' && submits(t).length === 0, 'isShuttingDown(name) = true ⇒ 不推');
    const t2 = await tick(redis, n, { isShuttingDown: () => { throw new Error('boom'); } });
    ok(submits(t2).length === 0, 'isShuttingDown 自己抛 ⇒ 当在关停（不推）');
  }

  console.log('\n【5】🔴 撞限额照旧不推、报给人 —— 快速兜底不许绕过 rate_limited');
  {
    const n = 'wdlg5h';
    await reset(redis, n);
    await liveNeverRead(redis, n);
    stopAgo(n, 'limit', 61_000);
    fs.writeFileSync(path.join(SIGNALS, `rate_limit-${n}.json`), JSON.stringify({ v: 1, name: n, at: Date.now() - 50_000, last_at: Date.now() - 50_000, error: 'rate_limit', session_id: 's', message_tail: TAIL_HINT }));
    const t = await tick(redis, n);
    ok(t.f.level === 'stopped' && t.f.stopped.hold === 'rate_limit_hook', 'StopFailure 信号有效 ⇒ hold = rate_limit_hook', JSON.stringify(t.f));
    ok(submits(t).length === 0 && !t.calls.some((c) => c.fn === 'nudge'), '★ 不推（submit、ESC 都没有）');
    ok(t.out.length === 1 && /没有推它/.test(t.out[0]), '报给人一条（说清没推、为什么）', JSON.stringify(t.out));
  }
  {
    const n = 'wdlg5p';
    await reset(redis, n);
    await liveNeverRead(redis, n);
    stopAgo(n, 'unexpected', 61_000);
    const t = await tick(redis, n, { pane: PANE_RL });
    ok(t.f.stopped && t.f.stopped.hold === 'rate_limit_pane' && submits(t).length === 0 && t.out.length === 1,
      'pane 上有限额文案 ⇒ hold = rate_limit_pane，不推、报给人', JSON.stringify(t.f));
  }
  {
    const n = 'wdlg5b';
    await reset(redis, n);
    await liveNeverRead(redis, n);
    stopAgo(n, 'limit', 61_000);
    const t = await tick(redis, n, { pane: new Error('capture-pane failed') });
    ok(t.f.stopped && t.f.stopped.hold === 'pane_blind' && submits(t).length === 0 && t.out.length === 1,
      'pane 读不到 ⇒ 排除不了限额 ⇒ hold = pane_blind，不推、报给人', JSON.stringify(t.f));
  }

  console.log('\n【6】15/20/30 分钟那几档不被改写');
  {
    // 快速兜底只改 ok / warn / unknown。nudge / alert / busy 要 idle ≥ 20 分钟，真 redis 造不出来 ⇒
    // 用一个造得出来的「别的档」验同一条边界：probe_failed（收件流的 key 是个字符串 ⇒ XINFO 报 WRONGTYPE）。
    // 「只改那三档」写成了白名单 ⇒ 任何不在名单里的档都不该被改写；probe_failed 就是名单外的一个样本。
    const n = 'wdlg6pf';
    await reset(redis, n);
    await roster.register(redis, n, { type: 'dev', stream: roster.inboxFor(n, 'dev'), tmux_session: `agent_${n}` }, 300);
    await redis.set(roster.inboxFor(n, 'dev'), 'not-a-stream');
    stopAgo(n, 'limit', 61_000);
    const t = await tick(redis, n);
    ok(t.f.level === 'probe_failed' && submits(t).length === 0, '名单外的档（probe_failed）+ 该推的 .stopped ⇒ 级别不被改写、不推', JSON.stringify(t.f));
    ok(watchdog.WARN_MS === 900_000 && watchdog.NUDGE_MS === 1_200_000 && watchdog.ALERT_MS === 1_800_000, '15/20/30 分钟阈值没动');
    await redis.del(roster.inboxFor(n, 'dev'));
  }

  console.log('\n【X】施工纪律自查');
  {
    const me = fs.readFileSync(__filename, 'utf8');
    ok(watchdog.looksRateLimited(me) === false, '🔴 本文件源码喂进入口判据 = false');
  }

  for (const n of ['wdlg1lim', 'wdlg1une', 'wdlg2pau', 'wdlg2shu', 'wdlg2bus', 'wdlg2new', 'wdlg2rd', 'wdlg3', 'wdlg3deaf', 'wdlg4', 'wdlg5h', 'wdlg5p', 'wdlg5b', 'wdlg6pf']) await reset(redis, n);
  await redis.del(OUT_T);
  await redis.quit();
  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
