'use strict';

/**
 * 按 thread 数 agent 之间的来回 —— 超过上限就通知人。
 *
 * ── 为什么要服务端数 ────────────────────────────────────────────────
 *   编排者协议的规矩是「一个 thread 里双方各超过 2 条，就停下来问人」，
 *   而**这个数要服务端来数**：只写成一句协议，会被忘掉 ——
 *   两个 agent 正在来回的时候，恰好是谁都不会停下来数自己说了几句的时候。
 *
 * ── 判据 ──────────────────────────────────────────────────────────────
 *   thread   = (scope, 根)。scope 是 `dm` 或 `room:<hash>` —— 两个 id 空间各自独立
 *              （私聊锚点是 job_id，房间锚点是房间流 stream id；同 `lib/reactions.js` 的 scope）
 *   找根     = 每条消息发出时记下 `根(scope, 自己) = 根(scope, reply_to) ?? reply_to`；
 *              没有 reply_to 的，根就是自己。按条存、按条 TTL 7 天。
 *              查不到父（太老、过期了、上线之前发的）⇒ 把 reply_to 当根。
 *   计数     = 只数 `sender_type === 'agent'` 且 `kind !== 'status'` 的
 *   清零     = thread 里出现一条 `sender_type === 'human'` 的 ⇒ 计数和「已告警」全清
 *   触发     = **至少 MIN_AGENTS（2）个不同的 agent，各自 > LIMIT（2）条**
 *              「至少两个」只为抓**来回**：一个 agent 自己连发进度不算
 *   只告警一次 = 直到被人的消息清零。判定和置位在同一个 Lua 脚本里 ⇒ 两个 relay tick 并发也只有一次
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 **只告警，不拦。** 这个模块不碰投递：不延迟、不丢、不改内容，
 *   也**不改任何消息的 `reply_to`、不补 `reply_to`**。
 *   ⇒ 漏填 reply_to 的那条自己就是根，计数自然分开 —— 那是对的：
 *     替它补一个「最近的那条」正是 `lib/thread-alert.js` 头注释点名反对的「聪明默认值」，
 *     补上之后挂错的那些从此谁也看不见。
 *   ⇒ 根的映射是**旁路表**，跟 `lib/thread-merge.js` 同一条理由：历史不动，才能撤销 / 重算。
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️ 已知不管的（写在这里，别让下一个人以为管了）：
 *   · 房间的「合并 thread」旁路表（`lib/thread-merge.js`）**不参与计数** —— 并过去的两个话题仍按各自的根数。
 *   · 根映射只在**经过 `record()` 的入口**上建：relay（agent 发的）和 bus 的两个人类发言入口。
 *     系统自己写的跟帖（done-verify、流程点名）不经过这里 ⇒ agent 回它们时，那条的根查不到，
 *     按「查不到父 ⇒ reply_to 当根」处理 —— 计数会从那条起另开一个 thread，**只会少报，不会多报**。
 *   · relay 是在**投递之后**才记的 ⇒ 对方 poller 可能比 `record()` 先读到触发的那一条，
 *     那一条上就还没有 `thread_over_limit`；它回的下一条一定有（这一侧早就记完了）。
 */

const q = require('./queue');
const stamp = require('./stamp');
// 只为 `previewOf`：截断带省略号的那一份，预览规则只有一处。
const threadAlert = require('./thread-alert');
// 只为 `HUMAN`（谁是人 —— 告警发给谁），唯一出处。UMD、零依赖，引它成不了环。
const threads = require('../web/threads.js');
// 只为 `ORCH_NAME`：告警的 `from`（见 `alert()`）。它就是 `lib/messages.js` 读私聊历史时按 from 过滤的那个名字 ——
// 同一个值必须来自同一处，否则告警刷新后从 JARVIS 的对话里消失。依赖链 messages → roster → queue，不引本模块。
const { ORCH_NAME: ALERT_FROM } = require('./messages');

/** 每个 agent 在一个 thread 里最多几条，超过就算「来回太多」。**只在这里定义。** */
const LIMIT = 2;
/** 至少几个 agent 各自超过 LIMIT 才触发。2 = 只抓来回，不抓一个人自己连发。 */
const MIN_AGENTS = 2;
/** 根映射和计数的 TTL：7 天。 */
const TTL_SEC = 7 * 24 * 3600;

const PREFIX = 'engloop:thread:';
const rootKey = (scope, id) => `${PREFIX}root:${scope}:${id}`;
const stateKey = (scope, root) => `${PREFIX}state:${scope}:${root}`;
/** 计数字段的前缀 —— 跟 `alerted` 字段同住一个 hash，清零就是一次 DEL。 */
const AGENT_FIELD = 'a:';
const ALERTED_FIELD = 'alerted';

/** 房间的 scope。私聊就是字面量 `'dm'`。 */
const roomScope = (hash) => `room:${hash}`;

function assertScope(scope) {
  if (scope === 'dm') return;
  if (typeof scope === 'string' && /^room:.+/.test(scope)) return;
  throw new Error(`thread-count: scope 必须是 'dm' 或 'room:<hash>'，收到 ${JSON.stringify(scope)}`);
}

/**
 * 这条消息算不算进来回。
 * ⚠️ 判的是**写进流里的**值（relay 规范化过的 kind、bus 盖的章），不是 outbox 原文 ——
 *   同 `lib/relay.js` 里 `replyTo` / `kind` 那两个局部变量的理由。
 */
function countable({ sender_type, kind }) {
  return sender_type === 'agent' && kind !== 'status';
}

// ── record 的原子部分 ──────────────────────────────────────────────────
//   KEYS[1] 这条消息自己的根映射   KEYS[2] 根的计数 hash
//   ARGV    root · ttl · mode(count|reset|none) · from · limit · minAgents · now
//           root 为空串 ⇒ 不写根映射（`resetThread` 用：只清零，不替任何消息记根）
//   返回    { triggered, alerted, field1, value1, … }
//
// ★ 「判定 + 置已告警」必须同一个原子步：拆成「HINCRBY → 回 JS 判 → HSETNX」的话，
//   人的消息恰好落在中间时，HSETNX 会在一个刚被清空的 key 上建出一个只有 alerted 的 hash
//   ⇒ 这个 thread 从此静音，直到人再说一句。Lua 里没有这个缝。
const RECORD_LUA = `
if ARGV[1] ~= '' then redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2])) end
local mode = ARGV[3]
if mode == 'reset' then
  redis.call('DEL', KEYS[2])
  return {0, 0}
end
if mode == 'count' then
  redis.call('HINCRBY', KEYS[2], '${AGENT_FIELD}' .. ARGV[4], 1)
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
end
local h = redis.call('HGETALL', KEYS[2])
local limit = tonumber(ARGV[5])
local over = 0
local alerted = 0
for i = 1, #h, 2 do
  if h[i] == '${ALERTED_FIELD}' then
    alerted = 1
  elseif string.sub(h[i], 1, ${AGENT_FIELD.length}) == '${AGENT_FIELD}' and tonumber(h[i + 1]) > limit then
    over = over + 1
  end
end
local triggered = 0
if mode == 'count' and over >= tonumber(ARGV[6]) then
  if redis.call('HSETNX', KEYS[2], '${ALERTED_FIELD}', ARGV[7]) == 1 then
    triggered = 1
    alerted = 1
  end
end
local out = {triggered, alerted}
for i = 1, #h do out[#out + 1] = h[i] end
return out
`;

/** 把 HGETALL 的扁平数组拆成 `{ counts, alerted }`。 */
function parseState(flat) {
  const counts = {};
  let alerted = false;
  for (let i = 0; i + 1 < (flat || []).length; i += 2) {
    const k = String(flat[i]);
    if (k === ALERTED_FIELD) alerted = true;
    else if (k.startsWith(AGENT_FIELD)) counts[k.slice(AGENT_FIELD.length)] = Number(flat[i + 1]);
  }
  return { counts, alerted };
}

/**
 * 这条消息的 thread 根。
 * ★ **必须查父的根** —— agent 的 `reply_to` 填的是它收到的那条（`bin/next.js` 的
 *   `room_msg_id` / `dm_msg_id`），**不一定是根**。直接拿 reply_to 当根的话，
 *   J1 → J2 → J3 这条链会被数成「J1 一组、J2 一组」，来回永远数不满。
 */
async function rootOf(redis, scope, id, replyTo) {
  if (!replyTo) return String(id);
  const parentRoot = await redis.get(rootKey(scope, replyTo));
  return parentRoot || String(replyTo);
}

/**
 * 记一条**已经发出去的**消息。
 *
 * @param {object} m
 * @param {string} m.scope        'dm' | 'room:<hash>'
 * @param {string} m.id           这条自己的锚点（私聊 job_id / 房间流 stream id）
 * @param {string} [m.reply_to]   写进流里的那个值
 * @param {string} m.from
 * @param {string} m.sender_type  bus 盖的章
 * @param {string} [m.kind]       规范化之后的 kind
 * @returns {Promise<{root:string, counts:object, alerted:boolean, triggered:boolean}>}
 */
async function record(redis, { scope, id, reply_to, from, sender_type, kind } = {}) {
  assertScope(scope);
  if (id == null || id === '') throw new Error('thread-count: 缺这条消息的锚点 id');
  const replyTo = reply_to ? String(reply_to) : null;
  const root = await rootOf(redis, scope, String(id), replyTo);
  const mode = sender_type === 'human' ? 'reset'
    : (countable({ sender_type, kind }) ? 'count' : 'none');
  const res = await redis.eval(RECORD_LUA, 2, rootKey(scope, String(id)), stateKey(scope, root),
    root, String(TTL_SEC), mode, String(from || 'unknown'), String(LIMIT), String(MIN_AGENTS),
    String(Date.now()));
  const { counts, alerted } = parseState((res || []).slice(2));
  return { root, counts, alerted: Number(res[1]) === 1, triggered: Number(res[0]) === 1 };
}

/**
 * 把一个 thread 清零（计数 ＋「已告警」）。**跟 `record` 里人的消息走的是同一支**（RECORD_LUA 的 reset），
 * 只是不替任何消息记根 —— 给「人回复了告警」用：那条回复在私聊里，而它要清的 thread 可能在房间里。
 */
async function resetThread(redis, scope, root) {
  assertScope(scope);
  if (root == null || root === '') throw new Error('thread-count: resetThread 缺根');
  await redis.eval(RECORD_LUA, 2, rootKey(scope, String(root)), stateKey(scope, String(root)),
    '', String(TTL_SEC), 'reset', 'unknown', String(LIMIT), String(MIN_AGENTS), String(Date.now()));
}

// ── 告警 → thread 的反查（回复告警即清零）──────────────────────────────────
//
// ★ 为什么要有它：JARVIS 派给 agent 的私聊 thread，根在 `agent:<name>:in` 里，**人在网页上碰不到** ——
//   网页的私聊只有他和 JARVIS 那两条流，agent 的输入框是禁用的（`web/app.js` renderBar）。
//   这种 thread 一告警，就只能等 7 天 TTL；而协议要求告警之后双方都别在这个 thread 里回。
//   ⇒ 人唯一一定碰得到的东西，是**告警本身**（它在他和 JARVIS 的私聊里）。回它，就清那个 thread。
const alertRefKey = (jobId) => `${PREFIX}alertref:${jobId}`;

/** 一条告警记着的是哪个 thread。没有（过期 / 不是告警）⇒ null。 */
async function alertRefOf(redis, jobId) {
  if (jobId == null || jobId === '') return null;
  const raw = await redis.get(alertRefKey(String(jobId)));
  if (!raw) return null;
  return JSON.parse(raw);
}

/**
 * 一批消息的 `reply_to` 各自是不是指向一条告警。**一次往返**（Lua 里逐个 GET ——
 * 不用 MGET：MGET 碰到类型不对的 key 返回 nil，会把「查坏了」读成「不是告警」）。
 * @returns {Promise<Array<object|null>>} 跟 jobIds 一一对应
 */
async function alertRefsMany(redis, jobIds) {
  const ids = (jobIds || []).map((x) => String(x));
  if (!ids.length) return [];
  const rows = await redis.eval(
    "local out = {} for i = 1, #KEYS do out[i] = redis.call('GET', KEYS[i]) or '' end return out",
    ids.length, ...ids.map(alertRefKey));
  return (rows || []).map((r) => (r ? JSON.parse(r) : null));
}

/**
 * 人的私聊消息：它的 `reply_to` 是一条告警 ⇒ 把告警记着的那个 thread 清零。**永远不抛。**
 * ★ 在 `bin/serve.js` 的 `/api/message` 里，记完人的这条**之后**调。
 * @returns {Promise<object|null>} 清了的那个 thread（`{scope, root, counts, preview}`）；没清 ⇒ null
 */
async function resetByAlertReply(redis, replyTo, { onEvent = () => {} } = {}) {
  try {
    const ref = await alertRefOf(redis, replyTo);
    if (!ref) return null;
    await resetThread(redis, ref.scope, ref.root);
    onEvent({ type: 'thread_reset_by_alert_reply', alert_job_id: String(replyTo), scope: ref.scope, root: ref.root });
    return ref;
  } catch (err) {
    onEvent({ type: 'thread_alert_reply_failed', alert_job_id: String(replyTo), error: String((err && err.message) || err) });
    return null;
  }
}

// ── 批量读（poller 用）：一轮一次往返 ────────────────────────────────────
//   KEYS    每条消息自己的根映射
//   ARGV    prefix · 然后每条一对 (scope, id)
//   返回    每条一项 { root, field1, value1, … }
//   ⚠️ 计数 hash 的 key 是在脚本里按查到的根拼的（没进 KEYS）—— 单机 Redis 允许，
//     cluster 不允许。EngLoop 只有单机这一种部署；换 cluster 时这里要改成两次往返。
const STATE_MANY_LUA = `
local out = {}
for i = 1, #KEYS do
  local scope = ARGV[2 * i]
  local id = ARGV[2 * i + 1]
  local root = redis.call('GET', KEYS[i])
  if not root then root = id end
  local row = {root}
  local h = redis.call('HGETALL', ARGV[1] .. 'state:' .. scope .. ':' .. root)
  for j = 1, #h do row[#row + 1] = h[j] end
  out[i] = row
end
return out
`;

/**
 * 一批消息各自所在 thread 的状态。**一次往返。**
 * @param {Array<{scope:string,id:string}>} items
 * @returns {Promise<Array<{root:string, counts:object, alerted:boolean}>>} 跟 items 一一对应
 */
async function stateOfMany(redis, items) {
  const list = (items || []).filter((it) => it && it.id != null && it.id !== '');
  if (!list.length) return [];
  for (const it of list) assertScope(it.scope);
  const keys = list.map((it) => rootKey(it.scope, String(it.id)));
  const argv = [PREFIX];
  for (const it of list) argv.push(it.scope, String(it.id));
  const rows = await redis.eval(STATE_MANY_LUA, keys.length, ...keys, ...argv);
  return (rows || []).map((row) => ({ root: String(row[0]), ...parseState(row.slice(1)) }));
}

/** 单条版 —— 给测试和人工排查。 */
async function stateOf(redis, scope, id) {
  const [s] = await stateOfMany(redis, [{ scope, id }]);
  return s;
}

/**
 * poller 领到的一条消息，在哪个 thread 空间、锚点是什么。
 * ★ 跟 `bin/next.js` 里 reactions 那段是同一条规则：房间取 `room_msg_id`，私聊取 `job_id`
 *   （两个字段互斥出现）。房间消息没有 `room_msg_id` ⇒ null（不猜）。
 */
function anchorOfPolled(m) {
  if (!m) return null;
  if (m.room_hash) return m.room_msg_id ? { scope: roomScope(m.room_hash), id: String(m.room_msg_id) } : null;
  return m.job_id ? { scope: 'dm', id: String(m.job_id) } : null;
}

/** poller 上那个字段的值。没告警 ⇒ `undefined`（字段不出现），不是 `null` / `{}`。 */
function overLimitField(state) {
  if (!state || !state.alerted) return undefined;
  return { limit: LIMIT, counts: state.counts };
}

/** 「dev 3 条 · senior 3 条」—— 多的排前面。 */
function countsLine(counts) {
  return Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([who, n]) => `${who} ${n} 条`)
    .join(' · ');
}

/** 告警正文：谁各几条、上限、scope 和根、触发的那条、怎么清零。 */
function alertText({ scope, root, counts, from, text }) {
  return `⚠️ **agent 在一个 thread 里来回超过上限了**：${countsLine(counts)}`
    + `（每方上限 ${LIMIT} 条，至少 ${MIN_AGENTS} 方超过就报）\n`
    + `scope：${scope} · 根：${root}\n`
    + `触发的那条（${from}）：「${threadAlert.previewOf(text)}」\n`
    + '它们没有被拦住，消息照常投递。参与的 agent 从下一轮起会在这个 thread 的消息上看到 '
    + '`thread_over_limit`，协议要它们停在这里等你。\n'
    + `你回复这条告警，那个 thread 的计数就清零（你的回复照常发给 ${ALERT_FROM}）；在那个 thread 里说话也行。`;
}

/**
 * 发告警给人 —— 走 watchdog 那条路（`orch:out`，bus 的 deliverLoop 推到浏览器），盖 system 章。
 * ★ 不带 reply_to：私聊里人看到的是 `orch:out` 那条流，房间的锚点跟它不是一个 id 空间 ——
 *   挂上去只会挂在一条不存在的父上。标 `notice`，它本来就是一条主动通知。
 *
 * ★★ `from` 写编排者的名字（`ALERT_FROM`），**章是 system** —— 跟 `lib/done-verify.js` 核验跟帖同一个做法：
 *   网页**按 `from` 归频道**（WS：`'dm:' + m.from`；刷新：`lib/messages.js` 读 `orch:out` 时按 `from === 编排者` 过滤）。
 *   写 `from:'system'` 的话，告警落进一个叫 system 的频道 —— 那里输入框是禁用的（只能对编排者说话），
 *   **人回复不了它**，「回复告警即清零」在真界面上就不成立。
 *   章说真话（这条是框架写的），`from` 只决定它出现在哪个对话里。
 *
 * ★ 发出去之后记一条 alertref：`告警的 job_id → { scope, root, counts, preview }`，7 天。
 *   人回复告警时，网页发出来的 `reply_to` 就是这个 job_id（私聊锚点 = job_id，告警没有父 ⇒ 根就是它自己）。
 */
async function alert(redis, { scope, root, counts, from, text }) {
  const sent = await q.send(redis, 'orch:out', {
    from: ALERT_FROM,
    to: threads.HUMAN,
    text: alertText({ scope, root, counts, from, text }),
    agent_type: 'system',
    ...stamp.SYSTEM,
    kind: 'notice',
  });
  sent.alertref_error = null;
  try {
    await redis.set(alertRefKey(sent.job_id),
      JSON.stringify({ scope, root, counts, preview: threadAlert.previewOf(text) }), 'EX', TTL_SEC);
  } catch (err) {
    // 告警已经发出去了 —— 只是回复它清不了零。说出来（recordAndAlert 会把它放进事件）。
    sent.alertref_error = String((err && err.message) || err);
  }
  return sent;
}

/**
 * 调用方用的那一个：记一笔，触发了就告警。**永远不抛。**
 *
 * 🚫 调用它的时候消息**已经发出去了**（relay 已经 XADD、ack 过；bus 已经 XADD）。
 *   这里抛出去只会让 relay 的这一轮 drain 中断 —— 同一批里后面的文件不被处理 ——
 *   而代价仅仅是少数一次。所以 catch 掉，但**要说出来**（onEvent），
 *   否则「没数上」和「没超过」在外面看是同一个安静。（理由同 relay 打 🏁 那段。）
 *
 * @returns {Promise<object|null>} record 的结果；失败时 null
 */
async function recordAndAlert(redis, msg, { onEvent = () => {}, text = '' } = {}) {
  let r;
  try {
    r = await record(redis, msg);
  } catch (err) {
    onEvent({ type: 'thread_count_failed', scope: msg && msg.scope, id: msg && msg.id,
      error: String((err && err.message) || err) });
    return null;
  }
  if (r.triggered) {
    try {
      const sent = await alert(redis, { scope: msg.scope, root: r.root, counts: r.counts, from: msg.from, text });
      onEvent({ type: 'thread_over_limit', scope: msg.scope, root: r.root, counts: r.counts, alert_job_id: sent.job_id,
        ...(sent.alertref_error ? { alertref_error: sent.alertref_error } : {}) });
    } catch (err) {
      // ⚠️ 「已告警」已经置上了 ⇒ 这个 thread 在人说话之前不会再报。说出来，别让它安静地丢。
      onEvent({ type: 'thread_alert_failed', scope: msg.scope, root: r.root, counts: r.counts,
        error: String((err && err.message) || err) });
    }
  }
  return r;
}

module.exports = {
  LIMIT, MIN_AGENTS, TTL_SEC, PREFIX,
  record, recordAndAlert, stateOf, stateOfMany,
  resetThread, resetByAlertReply, alertRefOf, alertRefsMany, alertRefKey, ALERT_FROM,
  anchorOfPolled, overLimitField, roomScope, countable,
  // 导出给测试
  alert, alertText, rootKey, stateKey,
};
