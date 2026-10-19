'use strict';

/**
 * 探针：在**受限 PATH** 下调 `tmux.list()`，把结果以一行 JSON 打到 stdout。
 *
 * 存在的理由：`list()` 必须能区分「没有会话」和「查不了」，而**唯一真实的
 * 复现条件是「找不到 tmux 命令」** —— 那要一个 PATH 不同的进程才造得出来。
 * 在测试进程里 mock 掉 execFile 只能验到实现细节，验不到「换个环境它怎么表现」。
 *
 * 典型现场：bus 用 nohup 起，PATH 只有 /usr/bin:/bin:...，
 * 而 tmux 在 /opt/homebrew/bin。
 */

const tmux = require('../../lib/tmux');

tmux.list()
  .then((r) => process.stdout.write(JSON.stringify({ ok: true, sessions: r }) + '\n'))
  .catch((e) => process.stdout.write(JSON.stringify({
    ok: false, code: e.code, message: String(e.message || ''),
  }) + '\n'));
