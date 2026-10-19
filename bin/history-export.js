#!/usr/bin/env node
'use strict';

/**
 * 手动跑一次对话历史导出。
 *
 * bus 会每 5 分钟自动导（`bin/serve.js`），这个 CLI 的用途是**手动确认**：
 *
 *   > 给流加 MAXLEN 之前要先导出，而且光导出不够，
 *   > 要**看见它写了多少条**——
 *   > 一个跑起来了但写 0 条的导出器，在加 MAXLEN 那一刻跟没有导出器一样。
 *
 * 用法：node bin/history-export.js [--root <dir>]
 */

const q = require('../lib/queue');
const history = require('../lib/history');

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf('--root');
const root = rootIdx >= 0 ? argv[rootIdx + 1] : undefined;

(async () => {
  const redis = q.createClient();
  try {
    const r = await history.exportAll(redis, root ? { root } : {});
    console.log(`写入 ${r.written} 条 · 跳过 ${r.skipped} 条 · ${r.streams} 个流`);
    for (const [s, n] of Object.entries(r.byStream).sort()) {
      console.log(`  ${String(n).padStart(5)}  ${s}`);
    }
    console.log(`文件：\n  ${r.files.join('\n  ')}`);
    if (r.badLines) console.log(`⚠ 历史文件里有 ${r.badLines} 行读不动 —— 那些 id 会被重复追加`);
    // ★ 「一个流都没枚举到」和「没有新消息」必须分得开。
    if (r.streams === 0) {
      console.log('⚠ **一个流都没枚举到** —— 这不是「没有历史」，是「我什么都没看到」。');
      process.exit(1);
    }
  } finally {
    await redis.quit();
  }
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
