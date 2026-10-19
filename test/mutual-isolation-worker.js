'use strict';

/**
 * mutual-isolation.test.js 的子进程。单独跑没有意义，由那个测试 spawn。
 *
 * 文件名不带 .test.js —— run-all 不会把它当测试跑。
 * 但它**必须放在 test/ 目录下**：isTestProcess() 只认这一层目录，放别处
 * 会被判成生产进程、连去 db 0。那是这整个模块要防的最严重的事。
 *
 *   node test/mutual-isolation-worker.js <tag> [显式url]
 *
 * 不给 url  → q.createClient() 自己抢一个测试库（被测行为）
 * 给了 url  → 完全听调用方的，不抢占也不清库（对照组靠这个口子共用一个库）
 */

const q = require('../lib/queue');

const TAG = process.argv[2];
const URL = process.argv[3] || undefined;
const STREAM = 'orch:in:agent';   // 故意用生产流名 —— 那正是两个测试进程会撞上的东西
const N = 20;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const redis = URL ? q.createClient(URL) : q.createClient();
  const db = redis.options.db;

  for (let i = 0; i < N; i++) {
    await q.send(redis, STREAM, { from: TAG, text: `${TAG}-${i}` });
  }

  // 给对方进程时间把它的数据也写进来。没有这段等待，测的就只是「写得快的
  // 那个先读完」，撞不上真正的并发窗口。
  await wait(800);

  // ★ 读之前再报一次 db —— 验「进程内部前后是不是同一个库」
  const dbAtRead = redis.options.db;
  const rows = await redis.xrange(STREAM, '-', '+');
  let mine = 0, foreign = 0;
  for (const [, fields] of rows) {
    const o = {};
    for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
    if (o.from === TAG) mine++; else foreign++;
  }

  process.stdout.write(JSON.stringify({ tag: TAG, db, dbAtRead, mine, foreign, total: rows.length }));
  await redis.quit();
  process.exit(0);
})().catch((e) => {
  process.stdout.write(JSON.stringify({ tag: TAG, error: String(e && e.message || e) }));
  process.exit(1);
});
