#!/usr/bin/env node
'use strict';

/**
 * 给一个**已经在册**的 agent 刷一次心跳。**只做这一件事。**
 *
 * ── 为什么它存在 ────────────────────────────────────────────────
 *   花名册 TTL 是 900 秒，而心跳只由 `bin/next.js` 在轮询的开头和结尾刷。
 *   ⇒ 一个 agent 只要有一段动作超过 15 分钟不回到 poller，就会掉册；
 *     而掉册期间**别人发给它的消息会被当成「发给人」推去网页**。
 *   典型的静默是「跑一遍全量」——**一个动作，几分钟**，中间没有任何位置可以插 poller。
 *
 *   ⇒ 所以 `test/run-all.js` 跑完之后调它一次。
 *
 * ── 🔴 射程：它覆盖什么、不覆盖什么（别把它读成「掉册修好了」）──────
 *   ✅ 覆盖：「**跑一遍长命令**就掉册」这一类 —— 一个动作，前后各有一次心跳。
 *   🔴 **不覆盖**：「一连串动作」，比如「写测试 ＋ 跑两遍全量 ＋ 写 commit body」——
 *      加一次心跳救不了它，因为**每一段本身都可能超过 900 秒**。
 *   ⇒ 它把一段静默砍成两段，而不是消灭静默。
 *
 * ── 🔴 为什么它在 `bin/` 下（这一点是设计，不是巧合）──────────────
 *   花名册在**生产库 db 0**。而 `lib/queue.js` 的四格判定里，
 *   `bin/` 下的入口 ⇒ `isProductionEntry()` 命中 ⇒ db 0 **是它应得的**。
 *   ⇒ 而 `test/run-all.js` 自己去连的话会命中 `isTestProcess()` ⇒ 分配一个
 *     测试库 ⇒ **心跳写进测试库 = 白写**（而它不会报错）。
 *   ⇒ 所以这个文件的**位置本身**就是它连生产库的授权 ——
 *     「测试进程不连生产库」这条禁令只留了这一扇门。
 *
 *   🔴 **而位置给的权限跟功能无关** ⇒ 在这里加任何一个「顺手查一下」的功能，
 *     都是在一个**已经拿到生产库连接**的进程里加的。
 *     ⇒ 所以它**只做一件事**：刷心跳。不打印花名册、不查别的、不写别的。
 *
 * ── 🔴 它**创造不出**任何花名册记录 ─────────────────────────────
 *   调 `roster.heartbeat(redis, name)` 时**不传 info**。
 *   `lib/roster.js` 那一支：`if (!info || !info.type) return 'need_info'`
 *   ⇒ **不在册就什么都不写** —— 它连「自愈重建」那条路都走不到。
 *   ⇒ 两个后果，都是想要的：
 *       ① 测试可以拿一个**不存在的名字**去跑它，而生产库一个字节都不多；
 *       ② 已经掉册的 agent 它**救不回来** —— 重建需要 `type`，
 *          而 `run-all.js` 不该去猜那个。重建仍然由 poller 负责。
 *
 * 用法：
 *   node bin/heartbeat.js [name]
 *   · 不给 name ⇒ 用 `whoami()`（从 tmux 会话名推）
 *   · 推不出来（人在自己终端里跑）⇒ **什么都不做，而且说出口**
 *     —— 「什么都没做」和「坏了」的退出码都是 0，所以那句话是唯一的区别。
 */

const q = require('../lib/queue');
const roster = require('../lib/roster');
const { whoami } = require('../lib/busy');

async function main() {
  const name = process.argv[2] || whoami();
  if (!name) {
    // ★ 措辞照 `lib/busy.js` 的 `declare()` —— 同一种情况，同一句话。
    console.log('[heartbeat] 不在 agent 的 tmux 会话里，未刷心跳'
      + ' —— 这次不是某个 agent 在跑，本来也不该有谁免疫 watchdog。');
    return;
  }

  const redis = q.createClient();
  try {
    // 🔴 不传 info ⇒ 见文件头：它只能给**已经在册**的续期。
    const res = await roster.heartbeat(redis, name);
    // ★ 写完自己回查一次 —— 「调了 heartbeat」和「TTL 真的回到 900」是两件事，
    //   而测试读的是**这一行的 stdout**，于是 `test/` 下没有任何代码需要连生产库。
    const ttl = await redis.ttl(roster.KEY(name)).catch(() => -2);
    console.log(`[heartbeat] ${name} → ${res} · ttl=${ttl}s`);
  } finally {
    await redis.quit().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[heartbeat] 失败：${err.message}`);
  process.exit(1);
});
