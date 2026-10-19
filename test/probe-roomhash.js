'use strict';

/**
 * 探针（不是测试）—— 求证一件事：
 *   agent 写一条带 room_hash 的 outbox，经过 relay 投进房间流之后，
 *   **room_hash 字段还在不在消息体里**。
 *
 * 起因：`lib/queue.js` 的 send 是「非必备字段原样透传」，
 * 但 `lib/relay.js:302` 那个调用方是**手工挑五个字段**拼 payload 的 ——
 * 也就是白名单又在调用侧长回来了一遍。
 *
 * 必须放在 test/ 目录：`lib/queue.js` 只认「入口脚本躺在本仓库 test/ 下」
 * 才判测试进程、才连测试库。放 agents/ 下跑会连 db 0，直接搅生产数据。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const q = require('../lib/queue');
const rooms = require('../lib/rooms');
const { startRelay } = require('../lib/relay');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const redis = q.createClient();
  console.log('连的库:', redis.options.db ?? '(url 里)');

  const meta = await rooms.create(redis, 'probe-room');
  const st = rooms.stream(meta.hash);
  await redis.del(st);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-probe-'));
  const relay = startRelay({
    outboxDir: dir,
    from: 'probecrew',
    redis,
    onEvent: (e) => console.log('  [event]', JSON.stringify(e)),
  });

  // ── 对照组：人从网页发言走的是 rooms.post ──
  await rooms.post(redis, meta.hash, { from: 'Patrick', text: '人说的话' });

  // ── 实验组：agent 写 outbox 回房间，走 relay ──
  fs.writeFileSync(
    path.join(dir, `${Date.now()}.json`),
    JSON.stringify({ room_hash: meta.hash, text: 'agent 说的话' }),
  );
  await wait(150);
  await relay.drain();
  await wait(100);

  const rows = await redis.xrange(st, '-', '+');
  console.log(`\n房间流 ${st} 里有 ${rows.length} 条：\n`);
  for (const [id, fields] of rows) {
    const o = {};
    for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
    console.log(`  ${id}`);
    console.log(`    from       = ${JSON.stringify(o.from)}`);
    console.log(`    text       = ${JSON.stringify(o.text)}`);
    console.log(`    room_hash  = ${JSON.stringify(o.room_hash)}   ${o.room_hash ? '' : '← 没了'}`);
    console.log(`    room_name  = ${JSON.stringify(o.room_name)}   ${o.room_name ? '' : '← 没了'}`);
    console.log(`    全部字段   = ${Object.keys(o).join(', ')}\n`);
  }

  relay.stop();
  await redis.del(st, rooms.META(meta.hash));
  await redis.srem(rooms.INDEX, meta.hash);
  await redis.quit();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => { console.error('探针异常:', e.stack || e.message); process.exit(1); });
