'use strict';
/**
 * `lib/ack-alert.js` —— `_unacked` 的判定（从 `bin/next.js` 提出来）。
 *
 * ── 它防的那个 bug ────────────────────────────────────────────────
 *   错误写法是 `stale -= messages.length`，
 *   而 `messages = [...orphans, ...fresh]`，其中 **`orphans` 是 autoclaim 从 PEL 捞回来的**
 *   —— 也就是「上一轮领了没 ack 的那些」。
 *   ⇒ ⇒ 把它们减掉 ⇒ `2 - 2 = 0` ⇒ **这条告警在它唯一有用的那一轮恰好静音。**
 *
 *   ★ 减掉的理由（「本轮刚领的还没轮到大脑处理，算进去等于每轮都喊」）
 *     对 `fresh` 成立，对 `orphans` **不成立** —— 而两者混在一个数组里，
 *     一个 `.length` 把它们一起减掉了。
 *
 * ── 而这条告警为什么要紧 ──────────────────────────────────────────
 *   漏 ack 的典型形状是：**那一轮的主要动作是干活，回消息只是收尾**。
 *   ⇒ **纪律对这个形状无效** —— 只能靠这条告警在下一轮响。
 */
const path = require('node:path');
const { staleAlert } = require(path.join(__dirname, '..', 'lib', 'ack-alert.js'));

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); } else {
    fail += 1;
    console.log(`  ✗ ${msg}${detail !== undefined ? `  → ${detail}` : ''}`);
  }
}

const A = { stream: 'agent:dev:in', id: '1-0' };
const B = { stream: 'agent:dev:in', id: '2-0' };

function main() {
  console.log('\n══ lib/ack-alert.js · `_unacked` 在漏 ack 之后必须响 ══\n');

  console.log('【1】🔴 ★ 漏 ack 场景：上一轮漏了 ack，这一轮被 autoclaim 捞回来');
  const orphaned = staleAlert({ pendingTotal: 2, orphans: [A, B], fresh: [] });
  ok(orphaned !== null && /还有 2 条/.test(orphaned),
    '🔴 ★ `orphans=2 · fresh=0 · pending=2` ⇒ **报「2 条」** —— 这一条就是那个 bug 本身',
    JSON.stringify(orphaned));
  ok(orphaned !== null && /autoclaim 捞回来的/.test(orphaned),
    '而它说得出**这些是捞回来的** —— 读的人立刻知道「不是新消息，是我上一轮漏的」',
    JSON.stringify(orphaned));

  console.log('\n【2】✅ 而正常轮必须**仍然安静**（否则修法就变成「每轮都喊」）');
  ok(staleAlert({ pendingTotal: 2, orphans: [], fresh: [A, B] }) === null,
    '★ `orphans=0 · fresh=2 · pending=2` ⇒ **不报** —— '
    + '原注释那条理由对 `fresh` 成立：它们刚到，还没轮到大脑处理',
    JSON.stringify(staleAlert({ pendingTotal: 2, orphans: [], fresh: [A, B] })));

  console.log('\n【3】🔴 等价性：**旧公式在场景【1】下是静音的** —— 这一条钉住「修好了什么」');
  // ⚠️ 下面这个表达式是**旧 bug 的复现**，不是被测代码的副本 ——
  //   它存在的唯一理由是让「新旧行为不同」成为一条可以红的判据。
  //   （把 `fresh` 变异回 `messages` ⇒ 【1】那两条必须红。）
  const oldFormula = (pendingTotal, orphans, fresh) => {
    const stale = pendingTotal - (orphans.length + fresh.length);   // ← 旧的 messages.length
    return stale > 0 ? `⚠️ 还有 ${stale} 条` : null;
  };
  ok(oldFormula(2, [A, B], []) === null,
    '🔴 ★ 旧公式在同一个输入上返回 **null** —— '
    + '也就是说：**漏 ack 之后那一轮，它什么都不说**',
    JSON.stringify(oldFormula(2, [A, B], [])));
  ok(oldFormula(2, [], [A, B]) === null && staleAlert({ pendingTotal: 2, orphans: [], fresh: [A, B] }) === null,
    '而两者在**正常轮**上一致（都不报）—— '
    + '⇒ 差别**只在漏 ack 的场景**，没有扩大告警面',
    'oldFormula 与 staleAlert 在 fresh 场景应当都是 null');

  console.log('\n【4】不返回空告警（「0 条」那种）');
  for (const [label, args] of [
    ['pending=0', { pendingTotal: 0, orphans: [], fresh: [] }],
    ['pending 恰好等于 fresh', { pendingTotal: 2, orphans: [], fresh: [A, B] }],
    ['pending 小于 fresh（不该发生，但不能报负数）', { pendingTotal: 1, orphans: [], fresh: [A, B] }],
    ['什么都不传', undefined],
  ]) {
    ok(staleAlert(args) === null, `${label} ⇒ **null**，不是一句「还有 0 条」`,
      JSON.stringify(staleAlert(args)));
  }

  console.log('\n【5】混合：别的流还有积压时，orphans 之外的欠账也要算进去');
  const mixed = staleAlert({ pendingTotal: 5, orphans: [A], fresh: [] });
  ok(mixed !== null && /还有 5 条/.test(mixed),
    'pending=5 · orphans=1 · fresh=0 ⇒ 报 **5** 条（PEL 里的全部欠账，不只是捞回来那一条）',
    JSON.stringify(mixed));
  const mixed2 = staleAlert({ pendingTotal: 5, orphans: [], fresh: [A, B] });
  ok(mixed2 !== null && /还有 3 条/.test(mixed2),
    'pending=5 · fresh=2 ⇒ 报 **3** 条 —— 只把真正新领的那两条排除掉',
    JSON.stringify(mixed2));

  console.log(`\n${'─'.repeat(50)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
