'use strict';

/**
 * 破坏性删除探针 —— 给 isolation.test.js 用的替身。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 直接 fork relay.test.js 和 worker.test.js 来证明「它们的 del 打在 db15」，
 * 会有一个后果：这两个文件在一次 npm test 里各跑**两遍**
 * （isolation 内一遍、run-all 自己一遍），两遍共享 db15 状态，
 * 于是结果依赖残留 —— 同样的代码连跑几轮，红的文件每轮都可能不一样。
 * 测试之间有了顺序依赖，谁都不可信。
 *
 * 要证明的其实很窄：**一个测试进程 del 生产流名时，删掉的是 db15 的同名流，
 * 不是 db0 的真流**。这不需要跑任何真实测试，一个探针就够，而且更精确 ——
 * 它直接针对「del 生产流名」这个动作本身，不掺杂别的测试逻辑。
 * ────────────────────────────────────────────────────────────────
 *
 * 文件名不以 .test.js 结尾，所以 run-all 不会把它当测试跑；
 * 但它躺在 test/ 目录里，所以 lib/queue.js 判它是测试进程 → 连 db15。
 * 这两件事都是故意的。
 */

const q = require('./../lib/queue');

const PROD_STREAMS = ['orch:in:human', 'orch:in:agent', 'orch:out', 'deadletter'];

async function main() {
  const redis = q.createClient();

  // 先确认自己确实连在测试库上 —— 探针要是连错了库，它就从「证明工具」
  // 变成了「破坏工具」，会真的删掉生产流。宁可什么都不做也不能删错。
  //
  // ⚠️ 这里原本判的是 `!== q.TEST_DB`（固定 15）。测试库改成按进程抢占
  // 1–15 之后，那个判据**反过来会误伤**：探针作为子进程抢到 db14，
  // 完全合法，却被自己拒绝执行。
  //
  // 意图没变（不许连着非测试库去删生产流名），变的是「测试库是哪个」
  // 从常量变成了范围。判据跟着意图走，不跟着旧实现走。
  const db = redis.options.db;
  if (!(Number.isInteger(db) && db >= q.TEST_DB_MIN && db <= q.TEST_DB_MAX)) {
    process.stdout.write(JSON.stringify({
      ok: false,
      reason: `探针连在 db ${db}，不在测试库范围 ${q.TEST_DB_MIN}–${q.TEST_DB_MAX} —— 拒绝执行删除`,
    }));
    await redis.quit();
    process.exit(2);
  }

  // 写进去再删掉，才能证明删除动作真的落到了实处
  const wrote = [];
  for (const s of PROD_STREAMS) {
    await redis.xadd(s, '*', 'probe', '1');
    wrote.push(s);
  }
  const existedBefore = [];
  for (const s of PROD_STREAMS) {
    if (await redis.exists(s) === 1) existedBefore.push(s);
  }

  await redis.del(...PROD_STREAMS);

  const stillThere = [];
  for (const s of PROD_STREAMS) {
    if (await redis.exists(s) === 1) stillThere.push(s);
  }

  await redis.quit();
  process.stdout.write(JSON.stringify({
    ok: stillThere.length === 0 && existedBefore.length === PROD_STREAMS.length,
    // ★ 报**实际连的库**，不是那个常量。
    //   报 q.TEST_DB 的话，两者恒等时看不出区别，一旦不等，
    //   报告字段就跟真实状态脱钩了：探针连在 db14 却报「在 15」，
    //   而从报告的视角完全看不出来。
    db,
    wrote,
    existedBefore,
    stillThere,
  }));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, reason: String(e.message || e) }));
  process.exit(1);
});
