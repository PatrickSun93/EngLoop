'use strict';

/**
 * 在册但循环停了，watchdog 只会推 ESC。
 *
 * ── 病灶 ────────────────────────────────────────────────────────
 * `idle` 是「多久没发 XREADGROUP」，而**一个正在专心干活的 agent，跟一个
 * 死了的 agent，都没在发 XREADGROUP**。两态在队列侧同形。
 *
 * **心跳年龄 ≡ 队列 idle，一个不差** —— 两者都由 `bin/next.js` 的同一轮驱动，
 * **它们不是互相印证，是同一个数看两遍**。而一个心跳和 idle 都是几分钟前、
 * outbox 却是一分钟前写的 agent —— 它在跑长任务，**不是聋了，是忙**。
 *
 * 判据不是新发明的：`lib/shutdown.js:28-38` 用它解决过一模一样的问题
 * （「它不是聋了，它是忙」）。**这里是把已验证的判据接过来。**
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const watchdog = require('../lib/watchdog');
const shutdown = require('../lib/shutdown');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

/** 造一个 outbox 根目录，指定的 agent 目录 mtime 设成 ageMs 之前。 */
function fakeOutbox(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-w8-'));
  for (const [name, ageMs] of Object.entries(spec)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, t, t);
  }
  return root;
}

function main() {
  console.log('\n【1】outboxIdleMs：真目录、真 mtime，不是 mock');
  {
    const root = fakeOutbox({ busy: 5_000, quiet: 600_000 });
    const now = Date.now();

    const busyAge = watchdog.outboxIdleMs('busy', { root, now });
    ok(busyAge >= 4_000 && busyAge <= 8_000,
      `★ 5 秒前动过的目录 → 约 5 秒（实际 ${Math.round(busyAge / 1000)}s）`);

    const quietAge = watchdog.outboxIdleMs('quiet', { root, now });
    ok(quietAge >= 595_000 && quietAge <= 605_000,
      `★ 10 分钟前动过的 → 约 600 秒（实际 ${Math.round(quietAge / 1000)}s）`);

    // ★ 目录不存在返回 Infinity 而不是 null。
    //   「没有活动证据」和「很久没活动」在这里是同一件事 —— 一个不写 outbox 的
    //   agent，要么没在干活，要么干活不报进度（违反协议第 1 条），两种都该被推。
    //   返回 null 会逼调用方再判一次「不确定怎么办」，而那个分支没有正确答案。
    ok(watchdog.outboxIdleMs('nosuchagent', { root, now }) === Infinity,
      '★★ 目录不存在 → Infinity（不是 null —— 「没有证据」不该变成一个要额外处理的第三态）');

    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('\n【2】★★ levelFor：忙不该被推，聋必须被推');
  {
    const BUSY = shutdown.QUIET_MS - 1_000;      // 还在写 outbox
    const QUIET = shutdown.QUIET_MS + 1_000;     // 静默够久了

    // ── ★ 这一对是这个功能的全部 ──────────────────────────────────
    ok(watchdog.levelFor({ minIdle: watchdog.NUDGE_MS, outboxIdle: BUSY }) === 'busy',
      '★★ idle 到 nudge 档 + outbox 仍在动 → busy（**不推 ESC**）');

    // ★★ 阳性对照，缺了它一个「永不 nudge」的实现也能全绿 ——
    //    没有阳性对照时，「没跑起来」和「拦住了」同形。
    ok(watchdog.levelFor({ minIdle: watchdog.NUDGE_MS, outboxIdle: QUIET }) === 'nudge',
      '★★ 阳性对照：idle 到 nudge 档 + outbox 也静默 → **照样 nudge**');

    // ── 否决必须盖住 alert，否则 alert 会陈述一件没发生的事 ──
    //   alert 文案写着「已推送 ESC…此后仍无队列读取活动」。没推却这么说，
    //   就是把一个从未成立的因果写成观察结果。
    ok(watchdog.levelFor({ minIdle: watchdog.ALERT_MS, outboxIdle: BUSY }) === 'busy',
      '★★ alert 档也被否决 —— 否则会报「已推送 ESC」，而根本没推');
    ok(watchdog.levelFor({ minIdle: watchdog.ALERT_MS, outboxIdle: QUIET }) === 'alert',
      '★ 阳性对照：alert 档 + 静默 → 照样 alert');

    // ── 否决**不该**下探到 warn：warn 只记一笔，不动手，没有误伤 ──
    //   （而且盖住它会让「忙了 15 分钟」这件事彻底不可见。）
    ok(watchdog.levelFor({ minIdle: watchdog.WARN_MS, outboxIdle: BUSY }) === 'warn',
      '★ warn 档不受影响 —— 它不动手，没有要防的伤害，盖住它只会丢信息');

    // ── 边界：正好等于 QUIET_MS 算「静默」，不算「忙」 ──
    //   偏紧的方向在这里是对的：**误判「忙」只是不动作，误判「聋」是打断。**
    ok(watchdog.levelFor({ minIdle: watchdog.NUDGE_MS, outboxIdle: shutdown.QUIET_MS }) === 'nudge',
      '★ 边界：outboxIdle 正好 == QUIET_MS 算静默（判据偏紧，宁可不救也不误打）');

    // ── 没到 nudge 档的，outbox 说什么都不影响 ──
    ok(watchdog.levelFor({ minIdle: 0, outboxIdle: QUIET }) === 'ok',
      '阴性对照：idle 很小 → ok，跟 outbox 无关');
    ok(watchdog.levelFor({ minIdle: null, outboxIdle: BUSY }) === 'unknown',
      '阴性对照：查不到消费者 → unknown，不被 outbox 改写');
    ok(watchdog.levelFor({ minIdle: 999, probeError: 'boom' }) === 'probe_failed',
      '阴性对照：探测失败优先 —— 查询本身坏了的时候，别拿坏数据做判断');
  }

  console.log('\n【3】★ 常量取自 shutdown.js，没有第二个 180000');
  {
    // 同一个「多久算静默」的事实在两处各写一遍，两处迟早会分叉。
    ok(shutdown.QUIET_MS === 180_000,
      `（前置）shutdown.QUIET_MS = ${shutdown.QUIET_MS}`);
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'watchdog.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(/shutdown\.QUIET_MS/.test(src),
      '★ watchdog 读的是 shutdown.QUIET_MS');
    ok(!/\b180_?000\b/.test(src),
      '★★ watchdog 里没有另写一个 180000 —— 两处各写一遍，分叉那天两边都「正常工作」',
      '源码里出现了字面量 180000');
  }

  console.log('\n【4】★ 这个信号要能被人看见，不只在动手那一刻算一次');
  {
    // 一个只在 nudge 分支现查的值，人永远看不到它，
    // 也就没法判断「watchdog 这次动手对不对」。
    const payload = watchdog.buildAgentsPayload(
      [{ name: 'x', type: 'dev', tmux_session: 'agent_x', level: 'busy',
         idleMs: 1_300_000, outboxIdleMs: 42_000, pending: 0 }],
      [{ name: 'x', ttl_s: 800, last_heartbeat: Date.now() - 1_300_000 }],
    );
    const row = [...(payload.live || []), ...(payload.deaf || []), ...(payload.stale || [])]
      .find((r) => r.name === 'x');
    ok(row?.outbox_idle_ms === 42_000,
      '★ /api/agents 带上了 outbox_idle_ms —— 人能自己判断「idle 大」是聋还是忙',
      JSON.stringify(row));

    // Infinity 不是合法 JSON（JSON.stringify 会变成 null，但那是隐式的）——
    // 显式转 null，别让一个「看起来像数字」的字段偶尔变成 null。
    const p2 = watchdog.buildAgentsPayload(
      [{ name: 'y', type: 'dev', tmux_session: 'agent_y', level: 'nudge',
         idleMs: 1_300_000, outboxIdleMs: Infinity, pending: 0 }],
      [{ name: 'y', ttl_s: 800, last_heartbeat: Date.now() }],
    );
    const row2 = [...(p2.live || []), ...(p2.deaf || []), ...(p2.stale || [])]
      .find((r) => r.name === 'y');
    ok(row2 && row2.outbox_idle_ms === null,
      '★ 从没有过 outbox 活动 → 字段是 null，不是 Infinity（后者不是合法 JSON）',
      JSON.stringify(row2));
  }

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
