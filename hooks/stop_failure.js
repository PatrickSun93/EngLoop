#!/usr/bin/env node
'use strict';

/**
 * StopFailure hook —— 撞限额那一刻，由 Claude Code 自己落一个信号文件。
 *
 * 由 `lib/agent-settings.js` 挂给**所有**三种 kind（编排者也挂 —— 「编排者没有 hook」那条规则唯一的例外），
 * matcher `rate_limit`，命令里写死 `--name <agent 名>`（生成配置时写进去；agent 改不了自己的配置，冒不了别人的名）。
 *
 * ── 为什么要它 ─────────────────────────────────────────────────────────
 *   没有它的话，判「撞了额度」只有一条路：agent 掉成 deaf 之后，watchdog 去读 pane 的最后 40 行找限额文案。
 *   pane 读不到、或者文案被后续输出顶出那 40 行 ⇒ 判成 deaf ⇒ 去 nudge 一个撞了墙的会话。
 *   ⇒ 这里给 watchdog 一个**第二个证据**：Claude Code 自己说「这一回合是因为 rate_limit 结束的」。
 *
 * ── 做什么 ─────────────────────────────────────────────────────────────
 *   stdin 读 JSON ⇒ `error !== 'rate_limit'` 直接退出 ⇒ 否则原子写 `temp/signals/rate_limit-<name>.json`
 *   （文件已在且读得出来 ⇒ 保留原来的 `at`，只更新 `last_at`）。逻辑在 `lib/rate-limit-signal.js` 的 `record()`。
 *
 * ── 不做什么 ───────────────────────────────────────────────────────────
 *   · **不连 Redis**：没必要；而且直连 Redis 的写入防不了伪造。文件放在 agent 的 sandbox 写不到的 temp/signals/。
 *   · **不上网、不弹桌面通知**：订阅额度是整个账号共用的，一撞所有会话同时撞 ⇒ 每个 hook 各弹一次就是 N 条一样的通知。
 *     告警由 watchdog 统一发（它本来就在发）。
 *   · **不解析** `last_assistant_message`：只截原文的尾巴。解析只在 watchdog 一处（`extractResetHint`），不写第二份。
 *
 * 退出码：**永远 0**。StopFailure 是 fire-and-forget，输出和退出码本来就被忽略；hook 坏了也不能拖住会话。
 */

const fs = require('node:fs');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

function main() {
  let input;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    input = raw.trim() ? JSON.parse(raw) : null;
  } catch (_) {
    return;   // 垃圾 stdin：什么都不写
  }
  if (!input || input.error !== 'rate_limit') return;
  const name = argValue('--name');
  // 名字判据在 lib 里（NAME_RE）—— record() 自己会拒，这里不再写一份。
  require('../lib/rate-limit-signal').record(input, { name });
}

if (require.main === module) {
  try { main(); } catch (e) {
    try { process.stderr.write(`[stop_failure] 没写成信号（忽略）：${e && e.message}\n`); } catch (_) { /* 连 stderr 都不行就算了 */ }
  }
  process.exit(0);
}
