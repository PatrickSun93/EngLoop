'use strict';
/**
 * 发送前的 thread 归属提醒 —— 单独成文件，为了让它可测。
 *
 * ── 为什么它存在 ────────────────────────────────────────────────
 *
 *   `_thread_alert` 是事后告警：写了一条正文、发出去，下一轮 poller 才说
 *   「网页上它标着红色『未归属』」。告警里明写着修法（「主动通知标 `kind:"notice"`」），
 *   而靠发的人记住它不可靠 —— **纪律对这个形状无效。**
 *   ⇒ 检查要放在一个会自己发生的位置：发消息**必然**经过这里。
 *
 * ── 它检两件，而第二件比第一件值钱 ──────────────────────────────
 *
 *   ① 有收件人 ＋ 有正文 ＋ **既没 `reply_to` 也没 `kind`** ⇒ 提醒
 *      ⇒ 后果可见：下一轮 `_thread_alert` 会说这件事（只是晚一轮）
 *
 *   🔴 ② **`kind` 写了，而不在 `KINDS` 里**（拼错）⇒ 提醒
 *      ⇒ `lib/relay.js:718` 是 `KINDS.includes(entry.kind) ? entry.kind : undefined`
 *        —— **拼错的 kind 被静默丢掉**，流里没有它。
 *      ⇒ ⇒ 于是 `_thread_alert` 下一轮确实会响，**而它会说「补 `reply_to`」**——
 *        指向一个错误的修法：你补了 reply_to，那个拼错的 kind 还在，下次照样丢。
 *      ★ 一条告警在**该响的时候响了，而它说的原因是错的** —— 告警的第三种失效方式
 *        （前两种：该响时不响 · 恒响）。
 *
 * ── 边界（写下来，别当它验过了）────────────────────────────────
 *
 *   ⚠️ 它**不判断**「这条到底该不该是回复」—— 那是判断型的，这里不做。
 *     一条真正的主动通知标了 `kind` 就不响，而标什么由发的人决定。
 *   ⚠️ 它**不阻止**发送。fail-open 是有意的：这个检查自己坏了不该让人发不出话
 *     （跟 `bin/next.js` 里那几个 alert 同一条）。
 */

// ★ `KINDS` 的唯一出处是 `web/threads.js`（UMD、零依赖，Node 引它成不了环 ——
//   `lib/relay.js:22` 已经这么引了）。**不要在这里抄一份值域**：
//   抄一份就是第二份实现，而它分叉时两边各自都「正常工作」。
const { KINDS } = require('../web/threads.js');

/**
 * @param {object} entry 草稿 JSON（原样）
 * @returns {string|null} 提醒文本；没问题时 `null`（**绝不返回空串那种「没有内容的告警」**）
 */
function threadHint(entry = {}) {
  const hasText = String(entry.text ?? '').trim().length > 0;
  const hasTarget = !!(entry.room_hash || entry.username);
  // 纯 ack、以及任何没有正文/没有收件人的东西，都不在射程内
  if (!hasText || !hasTarget) return null;

  const kind = entry.kind;
  if (kind !== undefined && kind !== null && String(kind) !== '') {
    if (!KINDS.includes(kind)) {
      return `⚠️ \`kind: ${JSON.stringify(kind)}\` 不在合法值域里 —— relay 会**静默丢掉**它`
        + `（\`lib/relay.js:718\`），网页上这条会渲染成「未归属」。`
        + `合法值：${KINDS.map((k) => `"${k}"`).join(' / ')}`;
    }
    return null;
  }

  if (entry.reply_to) return null;

  return '⚠️ 这条有正文、有收件人，而**既没有 `reply_to` 也没有 `kind`** —— '
    + '网页上它会标红「未归属」。回复某条 ⇒ 原样回填对方的 `room_msg_id` / `dm_msg_id`；'
    + `主动通知 ⇒ 标 \`kind\`（${KINDS.map((k) => `"${k}"`).join(' / ')}）`;
}

module.exports = { threadHint };
