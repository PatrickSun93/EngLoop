'use strict';

/**
 * StopFailure 信号变异的注入器 —— 用 `node -r <本文件>` 预加载，**在内存里**把被测模块换成变异版，磁盘上一个字不动。
 *
 *   E15_MUTANT=<id>  选一条变异（表在下面 MUTANTS，test/stopfailure-mutation.test.js 用 `--list` 问它要，不抄）
 *   没设            什么都不做（正控）
 *
 * 做法：读源码 → 字符串替换 → 挂在 `Module._extensions['.js']` 上，谁第一次 `require` 那个文件，
 * 拿到的都是变异版（hook 子进程也一样：hook 测试把自己的 `process.execArgv` 透传给子进程）。
 * ⚠️ 锚点找不到 ⇒ **exit 3**，而不是安静地不变异 —— 不然「变异没杀死」和「变异根本没注入」长得一样。
 *   锚点失效时去改锚点，**不要直接删掉这条变异**：它守的判据还在。
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const LIB = path.join(__dirname, '..', '..', 'lib');

const MUTANTS = {
  // 1. 判定表第三行（pane 读得到、没有限额文案、信号有效）改回判 deaf
  'row3-deaf': {
    file: 'watchdog.js',
    from: 'if (paneRateLimited || signal.valid) {',
    to: 'if (paneRateLimited || (signal.valid && paneError)) {',
    expectFail: '表第三行',
  },
  // 2. 清理挂到 act() 的「level !== 'rate_limited' 就清 rl_since」上
  'cleanup-on-level': {
    file: 'watchdog.js',
    from: 'await redis.del(RL_SINCE_KEY(f.name), RL_WAKES_KEY(f.name)).catch(() => {});',
    to: 'await redis.del(RL_SINCE_KEY(f.name), RL_WAKES_KEY(f.name)).catch(() => {});'
      + ' try { fs.unlinkSync(rlSignal.fileFor(f.name)); } catch (_) { /* mutant */ }',
    expectFail: '刚撞墙',
  },
  // 3. hook 每次都覆盖 at
  'hook-overwrites-at': {
    file: 'rate-limit-signal.js',
    from: "const at = prev.state === 'ok' ? prev.sig.at : now;",
    to: 'const at = now;',
    expectFail: '保留 at',
  },
  // 4. 锚点用 now
  'anchor-now': {
    file: 'watchdog.js',
    from: 'const anchor = Number.isFinite(f.rate_limit_signal_at) ? Math.min(f.rate_limit_signal_at, now) : now;',
    to: 'const anchor = now;',
    expectFail: '锚点取 signal.at',
  },
  // 5. finding 里带上 message_tail
  'finding-has-tail': {
    file: 'watchdog.js',
    from: 'rate_limit_signal_at: signalAt,',
    to: 'rate_limit_signal_at: signalAt, rate_limit_message_tail: signal.valid ? signal.sig.message_tail : undefined,',
    expectFail: 'finding 不带 message_tail',
  },
  // 6. idle 读不到时按「无效」处理
  'null-idle-invalid': {
    file: 'watchdog.js',
    from: 'if (idleMs !== null && idleMs !== undefined && !(idleMs >= now - sig.at)) {',
    to: 'if (idleMs === null || idleMs === undefined || !(idleMs >= now - sig.at)) {',
    expectFail: 'idle 读不到',
  },
};

if (process.argv.includes('--list') && require.main === module) {
  process.stdout.write(JSON.stringify(MUTANTS));
  process.exit(0);
}

const id = process.env.E15_MUTANT;
if (id) {
  const m = MUTANTS[id];
  if (!m) { process.stderr.write(`e15-mutant-preload: 没有这条变异 ${id}\n`); process.exit(3); }
  const file = path.join(LIB, m.file);
  const src = fs.readFileSync(file, 'utf8');
  if (src.split(m.from).length !== 2) {
    process.stderr.write(`e15-mutant-preload: 变异锚点找不到（或不唯一）：${id} @ ${m.file}\n`
      + '  ⇒ 去改锚点，**不要直接删掉这条变异** —— 它守的判据还在。\n');
    process.exit(3);
  }
  // ⚠️ **不能在这里就编译**：preload 跑在主模块之前，那时 `require.main` 还是 undefined ——
  //   被测模块 require 进来的 lib/queue.js 会把它记住，然后 createClient() 判不出这是测试进程、拒绝连库
  //   （那样会红在「异常」上而不是在目标断言上）。
  //   ⇒ 挂在 `.js` 的加载器上，等测试**自己** require 到那个文件时再换源码。
  const mutated = src.replace(m.from, m.to);
  const orig = Module._extensions['.js'];
  Module._extensions['.js'] = function (module, filename) {
    if (filename === file) return module._compile(mutated, filename);
    return orig(module, filename);
  };
}

module.exports = { MUTANTS };
