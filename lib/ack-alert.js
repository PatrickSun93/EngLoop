'use strict';
/**
 * `_unacked` 告警的判定 —— 从 `bin/next.js` 提出来，为了让它可测。
 *
 * ── 要避开的写法 ──────────────────────────────────────────────────
 *
 *   ```js
 *   const orphans = await q.autoclaim(…, { minIdleMs: 60000 });  // ← PEL 里领了没 ack 的
 *   const fresh   = orphans.length > 0 ? [] : await q.claimNext(…);
 *   const messages = [...orphans, ...fresh];
 *   …
 *   stale -= messages.length;   // 注释：「本轮刚领的不算」
 *   ```
 *
 *   `messages` **包含 `orphans`**，而 `orphans` 正是「上一轮漏 ack 的那些」。
 *   ⇒ ⇒ 把它们减掉 ⇒ `stale = 2 - 2 = 0` ⇒ **不报**。
 *
 *   ★ 那样写的告警：**平时安静（对），而漏 ack 之后的那一轮 ——
 *     也就是它唯一有用的那一轮 —— 它还是安静。**
 *
 * ── 「本轮刚领的不算」只对一半 ────────────────────────────────────
 *
 *   > 「本轮刚领的那些还没轮到大脑处理，算进去等于每轮都喊。」
 *
 *   ✅ 对 `fresh` 成立 —— 它们确实刚到。
 *   🔴 对 `orphans` **不成立** —— 它们**上一轮就该被处理了**，而没有。
 *   ⇒ 而两者在 `messages` 里混成一个数组，一个 `.length` 把它们一起减掉。
 *
 * ── 🔴 所以这个函数**同时收两个数组，而只减一个** ────────────────
 *   签名故意不接受一个合并后的 `messages` —— 那正是 bug 的形状。
 *   **让「只减 fresh」在签名上就看得见**，而不是藏在一次 `.length` 里。
 *
 * ── 一条告警值得存在的三个条件，这条全部满足 ──────────────────────
 *   ① 判得准    平时 orphans 为空 ⇒ 不报；漏 ack 之后非空 ⇒ 报
 *   ② 有可执行动作  「去 ack 这几条」，而 id 就在手上
 *   🔴 ③ 照做之后会安静  ack 了 ⇒ 下一轮 autoclaim 捞不到 ⇒ orphans 空 ⇒ 安静
 *   ⇒ 对照 `_output_truncated`（恒真 · 没有可执行动作）：差别全在 ③。
 */

/**
 * @param {object} o
 * @param {number} o.pendingTotal  各流 PEL 里 pending 的总数（XPENDING 的 count 之和）
 * @param {Array}  o.orphans       本轮 autoclaim 捞回来的（= 上一轮领了没 ack 的）**不减**
 * @param {Array}  o.fresh         本轮真正新领的                                  **要减**
 * @returns {string|null} 告警文本；没有欠账时返回 `null`（**绝不返回「0 条」那种空告警**）
 */
function staleAlert({ pendingTotal, orphans = [], fresh = [] } = {}) {
  const pending = Number(pendingTotal) || 0;
  // 🔴 只减 `fresh`。`orphans` 是欠账本身，减掉它就是让告警在该响时静音。
  const stale = pending - (Array.isArray(fresh) ? fresh.length : 0);
  if (stale <= 0) return null;
  const via = (Array.isArray(orphans) ? orphans.length : 0) > 0
    ? '（其中有本轮刚被 autoclaim 捞回来的 —— 那些正是上一轮漏掉的）'
    : '';
  return `⚠️ 还有 ${stale} 条消息领了没 ack —— 60 秒后会重投给你，`
    + `副作用可能做两遍。回复时把它们的 stream_id 填进 ack${via}`;
}

module.exports = { staleAlert };
