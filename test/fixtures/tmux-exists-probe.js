'use strict';

/**
 * 探针：在**找不到 tmux** 的环境里调 `exists()`，结果打成一行 JSON。
 *
 * 跟 `tmux-list-probe.js` 同一个理由 —— 唯一真实的复现条件是「换个环境」，
 * 而那要一个独立进程。
 *
 * ★ 这一处的下游比 list() 更重：`lib/shutdown.js` 用 `exists()`
 *   **回查 kill 有没有真的生效**。它撒谎 = 报告一次没发生的成功。
 */

const tmux = require('../../lib/tmux');

tmux.exists(process.argv[2] || 'nonexistent_session')
  .then((r) => process.stdout.write(JSON.stringify({ ok: true, exists: r }) + '\n'))
  .catch((e) => process.stdout.write(JSON.stringify({
    ok: false, code: e.code, message: String(e.message || ''),
  }) + '\n'));
