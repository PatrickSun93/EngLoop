'use strict';

/**
 * 待回复账本 —— 「等某个人回话」这类事项的提醒。
 *
 * ── 它和探针是**位置相反**的两个检查器，别把它们改成一样 ────────
 * ```
 * 探针    「一直没消息」**是**故障的样子   ⇒ 沉默 = 漏报 ⇒ 必须在 timeout 轮也报
 * 这里    「那个人没说话」**是**预期状态   ⇒ 沉默 = 正确行为 ⇒ 只在他开口那轮报
 * ```
 * 判据不是「要不要早退」，是**那条安静的路径上藏着故障还是常态**。
 * 两个检查器挨在一起、行为相反，看起来像其中一个写错了 —— 没写错。
 *
 * ── 为什么不是「每轮必读」 ──────────────────────────────────────
 * 一份「每轮都要读」的备忘文件，读的人很快就会不再看它。
 *
 * 这是「一直报会脱敏」最安静的一种形式：
 * **文件还在、内容还对、人不再打开它 —— 从外面看跟一切正常完全一样。**
 *
 * ⇒ 分档判据（销账动作和触发时机分别在谁手里）：
 * ```
 * 工具能销账          → 每轮必读            （探针：id 回来了就是销账）
 * 工具认得出时机      → 那个人开口那轮才提  （本模块）
 * 两个都没有          → 挂账，人自己翻      （纯备忘，不该占用每轮的注意力）
 * ```
 *
 * ⚠️ **「他开口」≠「他回答了这件事」。** 那一步判断只有 agent 做得了，
 * 所以销账是手动的。提醒里必须钉着这句 —— 否则触发点会被读成「这件事完了」，
 * 等于把这一档偷偷降级成「工具能销账」那一档，而它不能。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function statePath(name) {
  return process.env.ENGLOOP_WAITING_STATE
    || path.join(ROOT, 'temp', `waiting-${name}.json`);
}

/** 读账本。**读不到就是空账本，不报错** —— 跟探针相反：
 *  这里「没有账本」是常态（多数时候确实不等任何人），不是故障。 */
function load(name) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(name), 'utf8'));
    const items = Array.isArray(s) ? s : (Array.isArray(s && s.items) ? s.items : []);
    return items.filter((it) => it && it.who && it.what);
  } catch {
    return [];
  }
}

/** 已销账的那些（保留区）。**销账不等于删除** —— 见 settledLine 的注释。 */
function loadSettled(name) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(name), 'utf8'));
    return Array.isArray(s && s.settled) ? s.settled : [];
  } catch {
    return [];
  }
}

/** 保留区留多少条。够翻回去找一次误销就行，不是归档。 */
const SETTLED_KEEP = 20;

/**
 * 写账本。
 *
 * ⚠️ **销掉的条目移进 `settled` 区，不删** —— 误销会发生（见 settledLine）：
 *   一个没答的问题被标成答过了，如果同时也从文件里消失，
 *   **就再也没有任何东西能证明它存在过**。留着才谈得上「恢复它」。
 */
function save(name, items, settled = null) {
  try {
    const p = statePath(name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const prev = settled === null ? loadSettled(name) : settled;
    fs.writeFileSync(p, JSON.stringify({
      items,
      settled: prev.slice(0, SETTLED_KEEP),
    }, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** 账本条目 id → 提问那条消息该用的 `job_id`。**这个前缀是全部机关所在。** */
const ASK_PREFIX = 'ask-';
function askJobId(entryId) { return `${ASK_PREFIX}${entryId}`; }

/**
 * ★★ 按 `reply_to` 自动销账 —— 把销账动作从人手里搬进工具手里。
 *
 * ── 它为什么成立（链路上每一环都已经在那儿了）──────────────────
 * ```
 * agent 写 outbox 时指定  job_id: "ask-<条目id>"
 *   lib/relay.js:426  job_id: entry.job_id      ← 透传，不是新生成
 *   lib/queue.js      job_id: msg.job_id || 随机 ← 给了就用给的
 *   bin/next.js       dm_msg_id = job_id         ← 界面拿它当可回复锚点
 * 他点「回复」→ 他那条消息的 reply_to === "ask-<条目id>"
 * ⇒ **「这句话回答的是哪一件」变成机器可读的，不再需要人判断。**
 * ```
 * ⇒ 于是这一档从「工具认得出时机、销账要人判断」升进「工具能销账」那一档。
 *
 * ⚠️ **能自动化的是销账，不是记账。** 提一个问题、把它记进账本，
 *   仍然是 agent 的动作 —— 这条边界修不掉，说清楚比假装它不存在好。
 *
 * ⚠️ 只认**精确匹配**的 reply_to。不做「他回了话大概就是回答了」那种推断 ——
 *   那正是本模块开头警告的降级：把「他说话」读成「这件事完了」。
 *
 * @returns {{remaining: any[], settled: any[]}}
 */
function autoSettle(items, messages, now = Date.now()) {
  // ★★ 记的是「哪条回复销了它」，不只是「被销了」—— 见 settledLine。
  const byAsk = new Map();
  for (const m of messages || []) {
    if (m && m.reply_to) byAsk.set(m.reply_to, m);
  }
  if (!byAsk.size) return { remaining: items || [], settled: [] };
  const settled = [];
  const remaining = [];
  for (const it of items || []) {
    const hit = it && it.id && byAsk.get(askJobId(it.id));
    if (hit) {
      settled.push({
        ...it,
        settled_at: now,
        // ★★★ **他当时说的那句话**。误销能被一眼看出来，全靠这一个字段。
        settled_by_text: String(hit.text || '').slice(0, 60),
      });
    } else remaining.push(it);
  }
  return { remaining, settled };
}

/**
 * 刚销掉的那些，报一行。
 *
 * ── 🔴 误销：为什么销账通知里要贴原话 ────────────────────────────
 * 一条提问消息（`job_id: ask-<条目id>`）**里面问了两件事**
 * （① bus 要不要重启 ② 有什么要开发的）。对方回复那条，正文「1 做」——
 * 他答的是 ②。而机制照 `reply_to` 精确匹配，把 ①「要不要重启 bus」
 * **销掉了**。那件事他一个字没说。
 *
 * > **漏销只是继续提醒；误销是一个没答的问题被标成答过了，
 * > 而且再也不会有人提起它。**
 *
 * ★ 根因不在代码：`reply_to` 能证明「他在回复这条消息」，
 *   **证明不了「他回答了这条消息里的哪个问题」**。
 *   一条提问消息只该问一件事 —— 那是纪律，而纪律会被违反。
 *
 * ⇒ 所以修法不是「消除误销」，是**让误销在发生的那一瞬间就能被看出来**：
 *   把**他当时说的那句话**贴在销账通知里。上面那个例子里有这行的话，
 *   `←他说的是「1 做」` 一眼就不对。
 */
function settledLine(settled) {
  if (!settled || !settled.length) return null;
  // 长度不随条数增长（跟探针同一条约束）：只展开最老的一条 + 计数。
  const first = settled[0];
  const more = settled.length > 1 ? ` 等 ${settled.length} 件` : '';
  const said = first.settled_by_text
    ? `←他说的是「${first.settled_by_text.replace(/\s+/g, ' ')}」` : '';
  return `✅ 已销账：「${first.what}」${more} ${said}`
    + ' ⚠️ 这句话没回答这件事的话，它是误销 —— 账本 settled 区里还留着，说一声能恢复';
}

/**
 * 算提醒。**只在账上那个人本轮开口时说话**，其余一律 null。
 *
 * @param {any[]} messages 本轮消息
 * @param {any[]} items    账本
 * @returns {string|null}  恒定一行
 */
function alertLine(messages, items, now) {
  if (!items || !items.length) return null;
  const speakers = new Set((messages || []).map((m) => m && m.from).filter(Boolean));
  const hit = items.filter((it) => speakers.has(it.who));
  if (!hit.length) return null;

  // ★ 长度不随条数增长（跟探针同一条约束）：只点名最老的一条 + 计数。
  const oldest = hit.slice().sort((a, b) => (a.since_ms || 0) - (b.since_ms || 0))[0];
  const days = oldest.since_ms ? Math.floor((now - oldest.since_ms) / 3600000) : null;
  const age = days === null ? '' : `，最久的等了 ${days} 小时`;
  const more = hit.length > 1 ? ` 等 ${hit.length} 件` : '';
  return `📌 ${oldest.who} 这一轮开口了 —— 账上有「${oldest.what}」${more}${age}`
    + '；⛔ 他说话不等于他回答了这件事，没回答的不要销账';
}

module.exports = {
  statePath, load, save, alertLine,
  loadSettled, SETTLED_KEEP,
  ASK_PREFIX, askJobId, autoSettle, settledLine,
};
