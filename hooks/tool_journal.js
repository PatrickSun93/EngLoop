#!/usr/bin/env node
'use strict';

/**
 * 工具调用日志 hook（DUR1 S1）—— 每次工具调用前后各记一行，给「消息被重投时，上一次做到哪了」留材料。
 *
 * 由 `lib/agent-settings.js` 挂给 **crew 和编排者**（worker 不挂：一次性，没有重投后接着干这回事）。
 * 命令里写死 `--event <intent|outcome|failure|session>` 和 `--name <agent 名>`（生成配置时写进去；
 * agent 改不了自己的配置，冒不了别人的名）：
 *   PreToolUse ⇒ intent · PostToolUse ⇒ outcome(ok:true) · PostToolUseFailure ⇒ outcome(ok:false)
 *   SessionStart（只给 crew，命令多带一个 `--type <类型>`）⇒ 覆盖写 `<name>.session`，给 agent-start 判断接不接回会话用
 * 格式、路径、轮转、截断都在 `lib/tool-journal.js` 的 `record()`；这里只读 stdin、调它、吞掉一切异常。
 *
 * ── 照 `hooks/stop_failure.js` 的做法 ──────────────────────────────────
 *   · **不连 Redis**：只写 `temp/journal/` 下的文件（crew agent 的 sandbox 写不到 ⇒ 伪造不了自己的日志）。
 *   · **退出码永远 0，stdout 什么都不印**：PreToolUse 的 stdout JSON 会被当成权限决定，
 *     退出码 2 会拦下这次调用 —— 这个 hook **只记录、永远不做决定**。
 *   · 写失败就吞掉（stderr 留一行，只在 verbose 模式里看得见）。⇒ 日志可能缺行，S2 的 recovery 会把这一点告诉模型。
 *
 * ⚠️ 这跟 durable-harness 是**有意的差别**：它的 hook 要等 intent 落进 log 才放行（屏障）。这里不做屏障 ——
 *   一个 fail-closed 的屏障在磁盘或文件出问题时会让**所有** agent 停下来。取舍写在 lib/tool-journal.js 头注。
 */

const fs = require('node:fs');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  const input = JSON.parse(raw);   // 垃圾 stdin ⇒ 抛 ⇒ 下面吞掉
  // `--type` 只有 SessionStart 那条命令带（DUR3，给 resumePlan 的「类型变了不接回」）；别的事件没有 ⇒ null，record 不用它。
  require('../lib/tool-journal').record(argValue('--event'), input, { name: argValue('--name'), type: argValue('--type') });
}

if (require.main === module) {
  try { main(); } catch (e) {
    try { process.stderr.write(`[tool_journal] 没记上（忽略）：${e && e.message}\n`); } catch (_) { /* 连 stderr 都不行就算了 */ }
  }
  process.exit(0);
}
