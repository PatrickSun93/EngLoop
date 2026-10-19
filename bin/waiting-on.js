'use strict';

/**
 * 「等某人回话」账本 —— **只在那个人开口的那一轮提醒**。
 *
 * ── 它填的是三档模型里的中间档 ────────────────────────────────────
 *
 *   工具能销账        → 每轮必读              （自环探针：id 回来了就销）
 * ★ 工具能识别**时机** → 那个人说话的那一轮才提  （**这个文件**）
 *   两个都没有        → 挂账，自己翻          （纯备忘）
 *
 *   中间档的关键：**销账信号不在工具手里**（收到 Patrick 一条消息 ≠ 他回答了那件事，
 *   那一步判断只有编排者做得了），**但触发时机在工具手里** —— 他说话了这件事，poller 看得见。
 *
 * ── 为什么必须是「他开口才提」，不是「每轮都提」──────────────────
 *
 *   每轮都提的条目，看久了就不再被看 —— 检测器最坏的坏法不是不报，是一直报；
 *   而它的形式往往不是「告警刷屏」，是**「不再翻那个文件」** —— 更安静，同样致命。
 *
 *   ⇒ 安静时零噪音（不脱敏），他一开口它就在 —— **而那正是该翻账本的时刻。**
 */

const fs = require('node:fs');
const path = require('node:path');

// state 路径可覆盖 —— 测试用例（比如 self-probe）写进生产 state 的假记录
// 永远不会销账 ⇒ 每轮假告警 ⇒ 对真告警脱敏。
const LEDGER = process.env.ENGLOOP_WAITING_STATE
  // 🔴 这是**账本数据**，放在 temp/ 下 ——
  //   直接用 `__dirname` 会让它写进 git 跟踪的 bin/ 目录。
  //   ⇒ 显式指回 temp/：数据不跟着代码走。
  || path.join(__dirname, '..', 'temp', 'waiting-on.json');

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function save(list) {
  fs.writeFileSync(LEDGER, JSON.stringify(list, null, 2) + '\n');
}

/**
 * ⓘ 这里**故意**在 msgs 为空时什么都不做 —— 而这跟 self-probe 那个早退陷阱不同，
 *   区别要写清楚，否则下一个人会以为这里也漏了一格：
 *
 *     self-probe   「一直没消息」**是**故障的样子    ⇒ 静默 = 漏报，必须在早退前检查
 *   ★ 这里         「那个人没说话」**是**预期状态    ⇒ 静默 = 正确行为，不是漏报
 *
 *   ⇒ 判据不是「有没有早退」，是**那条安静的路径上到底藏着故障还是常态**。
 */
function reconcile(msgs) {
  const ledger = load();
  if (!ledger.length || !msgs || !msgs.length) return { lines: [] };

  const speakers = new Set(msgs.map((m) => String(m.from || '')));
  const hits = ledger.filter((e) => speakers.has(e.who));
  if (!hits.length) return { lines: [] };

  const lines = [];
  const byWho = new Map();
  for (const h of hits) {
    if (!byWho.has(h.who)) byWho.set(h.who, []);
    byWho.get(h.who).push(h);
  }
  for (const [who, items] of byWho) {
    lines.push(`  📌 **${who} 这一轮说话了** —— 你有 ${items.length} 件事在等他：`);
    for (const it of items) {
      const days = Math.round((Date.now() - it.since_ms) / 3600000);
      lines.push(`     [${it.id}] ${it.what}（等了 ${days}h）`);
    }
    lines.push(`     ⇒ 他这轮回答了的，销掉：node bin/waiting-on.js --done <id>`);
    lines.push(`     ⛔ 没回答的**不要销** —— 「他说话了」不等于「他回答了这件事」。`);
  }
  return { lines };
}

module.exports = { reconcile, LEDGER };

// ── CLI ────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const ledger = load();

  if (argv[0] === '--done') {
    const id = argv[1];
    const next = ledger.filter((e) => String(e.id) !== String(id));
    if (next.length === ledger.length) {
      console.log(`🔴 没找到 id=${id}。现有：${ledger.map((e) => e.id).join(', ') || '(空)'}`);
      process.exit(1);
    }
    save(next);
    console.log(`✓ 销掉 ${id}，还剩 ${next.length} 条`);
    process.exit(0);
  }

  if (argv[0] === '--add') {
    const who = argv[1];
    const what = argv.slice(2).join(' ');
    if (!who || !what) {
      console.log('用法: node bin/waiting-on.js --add <谁> <等他回答什么>');
      process.exit(2);
    }
    const id = String(Date.now()).slice(-6);
    ledger.push({ id, who, what, since_ms: Date.now() });
    save(ledger);
    console.log(`✓ 记下 [${id}] 等 ${who}：${what}`);
    console.log(`  ⇒ 他下次开口时 poll-parse 会提醒（安静时不出声）`);
    process.exit(0);
  }

  console.log(`账本 ${LEDGER}`);
  if (!ledger.length) console.log('  (空)');
  for (const e of ledger) {
    console.log(`  [${e.id}] 等 ${e.who}：${e.what}（${Math.round((Date.now() - e.since_ms) / 3600000)}h）`);
  }
  console.log('\n用法: --add <谁> <什么>   |   --done <id>');
}
