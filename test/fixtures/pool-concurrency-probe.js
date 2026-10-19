'use strict';

/**
 * 探针：**worker 池的并发真的被 semaphore 限住了吗。**
 *
 * ── ★ 难点是「并发不超过 2」怎么证 ──────────────────────────────
 * **事后看日志证明不了** —— 日志只能告诉你「都跑完了」。
 * 就算打了「开始/完成」两行，也要靠时间戳去推重叠，
 * **而那是把「观察到什么」当「发生了什么」用**。
 *
 * 这里让 **runner 自己记进出**：进入时 `active++` 并更新峰值，退出时 `active--`。
 * **峰值是 runner 观测到的事实，不是从日志反推的。**
 *
 * ⚠️ 用假 runner，不跑真 claude：
 *   · 验的是 **semaphore 的编排**，那跟 runner 里跑什么无关
 *   · 真 claude 跑 5 次要几分钟且花钱，**而它验不到任何多出来的东西**
 *   **这一点在报告里要说清 —— 别让人以为「5 个真 worker 并发」验过了。**
 *
 * ── 阴性对照（必须有）────────────────────────────────────────────
 * 只验「峰值 ≤ 2」的话，**一个串行执行的实现（峰值恒为 1）也能过** ——
 * 而那不是「限流生效」，是「根本没并发」。
 * 所以同时要求 **峰值真的到达过 2**：limit 起作用 ≠ 一次只跑一个。
 *
 * argv: <并发上限> <job 数>
 * stdout: 一行 JSON
 */

const q = require('../../lib/queue');
const { startPool } = require('../../lib/worker-pool');

const TYPE = 'eval';
const STREAM = `work:${TYPE}`;
const GROUP = `work:${TYPE}`;
const REPLY = 'orch:in:agent';

const LIMIT = Number(process.argv[2] || 2);
const JOBS = Number(process.argv[3] || 5);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ★★ **显式连测试库，不依赖 `isTestProcess()` 的自动判定。**
  //
  //   这个文件在 `test/fixtures/`；若 `isTestProcess()` 的判据是
  //   `path.dirname(main) === TEST_DIR`，**`test/fixtures` 不等于 `test`**，
  //   它就会被判成**生产进程**，连 db 0。
  //   下面那行 `del(STREAM, REPLY)` 里的 REPLY 是 `orch:in:agent`
  //   —— **编排者的收件流。判错一次就删一次，未读消息全没。**
  //
  //   > **一个「在 test 目录下就算测试」的判据，对 `test/` 的子目录不成立。
  //   >   而它的失败方向恰好最坏：判成生产 → 连生产库 → 而且不报错。**
  //
  //   ⚠️ **别改成「让 isTestProcess 认子目录」就完事** —— 那治的是这一个判据。
  //     **显式声明才治所有情况**：一个会 `del` 流的脚本，
  //     **不该把「连的是哪个库」交给一个推断出来的答案。**
  const redis = q.createClient(q.withDb(process.env.ENGLOOP_REDIS_URL || 'redis://127.0.0.1:6379/0', q.allocTestDb()));
  if (redis.options.db === 0) {
    process.stdout.write(JSON.stringify({
      probe_error: '拒绝在 db 0 上运行 —— 这个探针会 del 流，绝不能碰生产库',
    }) + '\n');
    process.exit(1);
  }
  await redis.del(STREAM, REPLY);
  await q.ensureGroup(redis, STREAM, GROUP);

  let active = 0;
  let peak = 0;
  let started = 0;
  let finished = 0;
  const timeline = [];

  // ★ runner 自己观测并发。**它是唯一同时知道「我进来了」和「我还没走」的地方。**
  const spy = async (task) => {
    active += 1;
    started += 1;
    if (active > peak) peak = active;
    timeline.push({ at: started, active, job: String(task.job_id || '').slice(0, 8) });
    // 停留足够久，让后来的 job 有机会挤进来 —— 太快的话峰值永远是 1，
    // 那时「没超过 2」是因为根本没重叠，不是因为限流。
    await wait(400);
    active -= 1;
    finished += 1;
    return { ok: true, ms: 400, output: `done ${started}` };
  };

  const pool = startPool(redis, {
    type: TYPE, concurrency: LIMIT, runner: spy, onLog: () => {},
  });

  for (let i = 0; i < JOBS; i++) {
    // eslint-disable-next-line no-await-in-loop
    await q.send(redis, STREAM, { from: 'probe', text: `job ${i}`, agent_type: TYPE });
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && finished < JOBS) await wait(100);
  // ★ 分两次采 PEL：**stop 之后立刻一次，等一会儿再一次。**
  //   只采一次的话可能拿到 `pel_left: 1` —— 而 5 个 job 全部完成、5 条回报都在。
  //   **「全部完成却有 PEL 残留」是会导致重投的状态，必须查清是竞态还是真的。**
  //   两个数字并排，才分得清「ack 还在路上」和「这条 ack 根本没发」。
  pool.stop();
  await wait(300);
  const pendingRightAfterStop = await q.pending(redis, STREAM, GROUP);
  await wait(3000);

  const replies = await redis.xrange(REPLY, '-', '+');
  const pending = await q.pending(redis, STREAM, GROUP);

  await redis.del(STREAM, REPLY);
  await redis.quit();

  process.stdout.write(JSON.stringify({
    limit: LIMIT,
    jobs: JOBS,
    started,
    finished,
    peak_concurrency: peak,
    replies: replies.length,
    pel_right_after_stop: pendingRightAfterStop.count,
    pel_left_3s_later: pending.count,
    timeline: timeline.slice(0, 12),
  }, null, 2) + '\n');
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ probe_error: String(e && e.stack || e) }) + '\n');
});
