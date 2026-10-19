'use strict';

const q = require('../lib/queue');
const roster = require('../lib/roster');
const wd = require('../lib/watchdog');
const FS = require('node:fs');
const OS = require('node:os');
const PATH = require('node:path');
// ── ★ 测试**不许读生产 `temp/outbox/`** ──────────────────────────────
//
//   `watchdog.check()` 的 `outboxRoot` 默认是 `lib/watchdog.js` 的 `OUTBOX_ROOT`
//   ＝ 生产的 `temp/outbox/`。而 `outboxIdleMs` = `now - statSync(dir).mtimeMs`
//   ⇒ **判据的输入会变成「隔壁 agent 刚才有没有说话」**。
//
//   ⚠️ 不传 root 的 `check()` 能绿只是**碰巧**：测试名字在 `temp/outbox/` 下
//     没有目录（⇒ `Infinity`），或者那个目录很久没动过（行为等同 `Infinity`）。
//     ⇒ ⇒ **失效条件是「某个测试用了活 agent 的名字」** —— 而那不是任何人保证的。
//
//   ★ 所以这里不是「传一个参数」，是**把一条测试与生产的边界补上** ——
//     而它跟 `q.createClient()` 那条（测试进程连测试库）是同一条边界的两半。
const WD_OUTBOX = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'engloop-wdtest-outbox-'));
// ★ 信号目录同理 —— 默认是生产 `temp/signals/`。不隔离的话，判级会取决于生产里有没有一个同名的信号文件，
//   而 check() 收集的「该删」名单也指向生产文件。空的临时目录 = 「没有信号」，即只凭 pane 判级。
const WD_SIGNALS = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'engloop-wdtest-signals-'));
process.on('exit', () => { try { FS.rmSync(WD_SIGNALS, { recursive: true, force: true }); } catch (_) { /* 清不掉就算了 */ } });
process.on('exit', () => { try { FS.rmSync(WD_OUTBOX, { recursive: true, force: true }); } catch (_) { /* 清不掉就算了 */ } });
// ★ **唯一的入口**：所有 `check()` 都走这里，别在别处直接调 `wd.check()` ——
//   那就是第二份实现，而它会静静地读回生产目录（`test/isolation.test.js` 有一条判据数这个）。
const wdCheck = (redis, opts = {}) => wd.check(redis, { outboxRoot: WD_OUTBOX, signalsDir: WD_SIGNALS, ...opts });


const S = 'engloop:wdtest:in';
const G = 'agent:wdtest';

// ★ watchdog 从 **tmux 会话列表**枚举，会话参与判定。
//
// 这个文件测的是 **idle 判定**，而随便填一个不存在的会话名
// （`tmux_session: 'nope'`）的话，「花名册有、会话无」会被判成 stale，
// 于是 idle 那几条测不到。
//
// 所以让测试自己造它需要的前提：注入一个
// 假 tmux，让 'nope' 这个会话「存在」。这样它继续专测 idle 判定，
// 而会话侧的三格分治由 test/watchdog-liveness.test.js 专门守。
const fakeTmux = {
  list: async () => [{ name: 'nope', created: 0, attached: false }],
  exists: async (s) => s === 'nope',
  nudge: async () => {},
  submit: async () => {},
};
let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

async function main() {
  const redis = q.createClient();
  await redis.del(S);
  await roster.unregister(redis, 'wdtest');

  console.log('\n【1】没读过的组 → unknown（不误报）');
  await roster.register(redis, 'wdtest', { type: 'dev', stream: S, tmux_session: 'nope' }, 300);
  await q.ensureGroup(redis, S, G);
  let f = (await wdCheck(redis, { tmuxApi: fakeTmux })).findings.find((x) => x.name === 'wdtest');
  ok(f?.level === 'unknown', '从没有消费者读过 → unknown', `实际 ${f?.level}`);

  console.log('\n【2】刚读过 → ok');
  await q.send(redis, S, { from: 'x', text: 'hi' });
  await q.claimNext(redis, { streams: S, group: G, consumer: 'wdtest-1', blockMs: 300 });
  f = (await wdCheck(redis, { tmuxApi: fakeTmux })).findings.find((x) => x.name === 'wdtest');
  ok(f?.level === 'ok', '刚交互过 → ok');
  ok(f.idleMs !== null && f.idleMs < 5000, `idle 很小（${f.idleMs}ms）`);
  ok(f.pending === 1, '统计到 1 条待确认');

  console.log('\n【3】分级判定（用阈值边界验证，不真等 15 分钟）');
  const mk = (idleMs) => {
    if (idleMs >= wd.ALERT_MS) return 'alert';
    if (idleMs >= wd.NUDGE_MS) return 'nudge';
    if (idleMs >= wd.WARN_MS) return 'warn';
    return 'ok';
  };
  ok(mk(60_000) === 'ok', '1 分钟 → ok');
  ok(mk(600_000) === 'ok', '10 分钟 → ok（阻塞期内，不误报）');
  ok(mk(wd.WARN_MS) === 'warn', '15 分钟 → warn');
  ok(mk(wd.NUDGE_MS) === 'nudge', '20 分钟 → nudge');
  ok(mk(wd.ALERT_MS) === 'alert', '30 分钟 → alert');
  ok(wd.WARN_MS > 594_000, 'warn 阈值大于一次完整阻塞（594s），否则会把正常阻塞误判成失聪');

  console.log('\n【4】alert 会把消息推给人');
  // 用独立流，别碰真实的 orch:out（bus 正在消费它）
  const OUT_T = 'engloop:wdtest:out';
  await redis.del(OUT_T);
  await wd.act(redis, [{
    name: 'wdtest', type: 'dev', tmux_session: 'nope',
    idleMs: wd.ALERT_MS + 1000, pending: 3, level: 'alert', stream: S, group: G,
  }], { onLog: () => {}, outStream: OUT_T });
  const outLen = await redis.xlen(OUT_T);
  ok(outLen === 1, 'orch:out 收到一条告警');
  const row = await redis.xrange(OUT_T, '-', '+');
  const obj = {}; const fields = row[0][1];
  for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
  ok(/watchdog/.test(obj.from), '发信人是 watchdog');
  ok(/重启/.test(obj.text), '告警里带了恢复命令');

  console.log('\n【5】tmux 会话不在时不硬推');
  let logged = '';
  await wd.act(redis, [{
    name: 'wdtest', type: 'dev', tmux_session: 'definitely_not_here',
    idleMs: wd.NUDGE_MS + 1, pending: 0, level: 'nudge', stream: S, group: G,
  }], { onLog: (m) => { logged += m; } });
  ok(/推不动|需要重启/.test(logged), '会话不存在时给出明确说明而非静默失败');

  await redis.del(S, OUT_T);
  await roster.unregister(redis, 'wdtest');
  await redis.quit();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.message); process.exit(1); });
