'use strict';

/**
 * 对话历史导出 —— Redis Stream → `history/<date>.jsonl`
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这个：
 *
 *   队列和历史是同一个流（`orch:out` 既是投递通道又是「JARVIS 说过
 *   什么」的唯一记录）。**流里的历史全在，只是因为还没人裁，不是设计保证了它。**
 *   哪天有人为了防内存涨加个 MAXLEN，历史无声消失，不报错。
 *
 * 这是「一个字段承担两个语义」的完整形态，
 * 而且更险：**「碰巧还成立」的性质被当成了「保证」。**
 *
 * ── 三条硬要求（各防一件事）────────────────────────────────────────
 *
 *   1. **导出是单向的**，Redis → 文件。文件不参与投递。
 *      → 防的是「两套状态源」。一旦文件也能喂投递，
 *        「这条发过没有」就有两个答案，而崩溃恢复时它们会分叉。
 *
 *   2. **`id` 必须留**（Redis Stream ID）。
 *      → 那是去重和续传的唯一依据。消息里的 `job_id` 不行 ——
 *        同一条消息扇出到多个流时 `job_id` 相同，**Stream ID 不同**。
 *
 *   3. **顺序不能反：先有导出，再谈给流加 MAXLEN。**
 *      → 反了就是拿历史换内存。
 *
 * ★ 第 3 条还要补半句：**「先导出」不够，要「先导出**并且验证
 *   它真的写出了内容**」**。
 *
 *   一个跑起来了但写了空文件的导出器，跟没有导出器
 *   **在加 MAXLEN 那一刻长得一模一样** —— 而那一刻之后没有第二次机会。
 *
 *   所以 `exportAll` 返回**写了多少条**，调用方要把它打出来；
 *   测试里则是导出后**从文件读回来跟原流比对**，不是只看文件存在。
 * ══════════════════════════════════════════════════════════════════
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.join(__dirname, '..', 'history');

/**
 * 哪些流算「对话」。
 *
 * ⚠️ **这是个判断，不是规格** —— 行格式和三条硬要求里
 *   没列要导哪些流。这里的取舍写出来，方便推翻：
 *
 *   导     orch:*（编排者收发）· agent:*:in（派给 agent 的）· room:*（房间）
 *          deadletter（**没送到的那部分也是对话**，而且它最该留）
 *          work:*（任务队列 —— 内容是真活儿，不是心跳）
 *   不导   isolation:canary:*（测试产物，见 lib/queue.js 的隔离机制）
 *
 * > **多导一条的代价是文件大一点；少导一条的代价是它永久消失。**
 * > 所以默认宽，排除窄。
 */
const EXCLUDE = [/^isolation:canary:/];

function isConversation(stream) {
  return !EXCLUDE.some((re) => re.test(stream));
}

/**
 * 流名 → `kind`。给以后按维度查用。
 *
 * ⚠️ 顺序敏感：`orch:in:human` 必须在 `orch:in:` 之前判，
 *   否则两种入向消息会被归成同一类 —— 而**「人说的」和「agent 说的」
 *   正是最需要分开的那一对**。
 */
function kindOf(stream) {
  if (stream === 'orch:out') return 'orch:out';
  if (stream === 'orch:in:human') return 'in:human';
  if (stream === 'orch:in:agent') return 'in:agent';
  if (stream === 'deadletter') return 'deadletter';
  if (/^agent:[^:]+:in$/.test(stream)) return 'agent:in';
  if (/^room:/.test(stream)) return 'room';
  if (/^work:/.test(stream)) return 'work';
  return 'other';
}

/**
 * Stream ID → 毫秒时间戳。
 *
 * ★ 用 **Stream ID 的时间**，不是消息里的 `timestamp` 字段。
 *   前者是 redis 写入那一刻的事实，后者是发送方自己写的**声明** ——
 *   而声明会跟事实分叉（发送方时钟不准、或者干脆没填）。
 *
 *   两个都留在记录里（`ts` 来自 ID，`timestamp` 在 payload 里原样带着），
 *   **正常路径上它们一致，只在出问题时分叉 —— 而那正是要查的时候。**
 */
function tsOf(id) {
  const ms = Number(String(id).split('-')[0]);
  return Number.isFinite(ms) ? ms : null;
}

/** 毫秒 → `YYYY-MM-DD`（UTC）。用 UTC 是为了跨时区跑出来的文件名一致。 */
function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** redis 的扁平字段数组 → 对象 */
function unflatten(fields) {
  const o = {};
  for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
  return o;
}

/**
 * 一条流记录 → 一行 JSONL 的对象。
 *
 * 固定字段：`{ts, stream, id, from, to, text, room_hash, kind}`
 * 外加 `payload`：**其余字段原样带着**。
 *
 * ⚠️ 为什么要 `payload` 而不是只留那八个：
 *   `lib/queue.js` 的 `send` **故意不做白名单**（白名单会把 `room_hash`
 *   这类新字段吃掉，下游只能从 text 前缀里猜房间名）。
 *   导出这边再做一次白名单，等于把那个 bug 换个地方重犯 ——
 *   **只是这次丢的东西永远找不回来了。**
 */
function toRecord(stream, id, fields) {
  const msg = unflatten(fields);
  const known = ['from', 'to', 'text', 'room_hash'];
  const payload = {};
  for (const [k, v] of Object.entries(msg)) {
    if (!known.includes(k)) payload[k] = v;
  }
  return {
    ts: tsOf(id),
    stream,
    id,
    from: msg.from || '',
    to: msg.to || '',
    text: msg.text || '',
    room_hash: msg.room_hash || null,
    kind: kindOf(stream),
    payload,
  };
}

/**
 * 去重键：`<stream>|<id>`。
 *
 * ⚠️ 只此一处，而且**不用模板字符串里的裸分隔符** ——
 *   `` `${stream} ${id}` `` 里那个「空格」可能实际是不可见字符（比如
 *   **NUL 字节**，`'x\x001-0'`）。后果有两层：
 *     · 去重键跟测试里拼的不一样 → 幂等断言假红
 *     · **`grep "ids.add"` 返回空** —— 文件里有 NUL，grep 当它是二进制
 *   ★ 第二层更坏：**排查工具自己失效了**，而失效的样子是「没找到」，
 *     跟「那行代码不存在」完全同形。
 *
 *   **所以分隔符收进一个函数、写成可见字符。**
 */
function keyOf(stream, id) {
  return String(stream) + '|' + String(id);
}

/**
 * 读回一个已存在的 jsonl，收集里面的 `id`。
 *
 * ⚠️ 坏行不抛，**但要报出来**。一个读不动的历史文件如果静默跳过，
 *   那些 id 会被当成「没导出过」而重复追加 —— **文件越坏，重复越多。**
 */
function readExistingIds(file) {
  const ids = new Set();
  let bad = 0;
  if (!fs.existsSync(file)) return { ids, bad };
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.id) ids.add(keyOf(o.stream, o.id));
      else bad++;
    } catch (_) { bad++; }
  }
  return { ids, bad };
}

/**
 * 全量导出。
 *
 * 不做增量优化：每次全量导出、按 id 去重。数据量小，全量足够。
 *
 * @returns {{written:number, skipped:number, files:string[], byStream:object,
 *            badLines:number, streams:number}}
 *   ★ `written` 是这次**实际写进文件**的条数 —— 调用方必须把它打出来。
 *     一个「跑成功了但写了 0 条」的导出，跟没有导出器在加 MAXLEN 那一刻同形。
 */
async function exportAll(redis, { root = DEFAULT_ROOT, streams = null } = {}) {
  fs.mkdirSync(root, { recursive: true });

  let names = streams;
  if (!names) {
    names = [];
    const keys = await redis.keys('*');
    for (const k of keys) {
      if (!isConversation(k)) continue;
      if ((await redis.type(k)) === 'stream') names.push(k);
    }
  }
  names.sort();

  // 先把所有记录读出来按天分组 —— 去重要在**写之前**做，
  // 而去重依据是文件里已有的 id，所以每个目标文件只读一次。
  const byDay = new Map();
  const byStream = {};
  for (const s of names) {
    const rows = await redis.xrange(s, '-', '+');
    byStream[s] = rows.length;
    for (const [id, fields] of rows) {
      const rec = toRecord(s, id, fields);
      if (rec.ts === null) continue;          // ID 不含时间戳 —— 不该发生，但不猜
      const day = dayOf(rec.ts);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(rec);
    }
  }

  let written = 0, skipped = 0, badLines = 0;
  const files = [];
  for (const [day, recs] of [...byDay.entries()].sort()) {
    const file = path.join(root, `${day}.jsonl`);
    const { ids, bad } = readExistingIds(file);
    badLines += bad;

    // 同一天内按 (ts, id) 排序 —— 追加进来的顺序才是时间顺序。
    // ⚠️ 光按 ts 排不够：同一毫秒内多条时顺序不定，而 jsonl 是追加的，
    //   顺序一乱，下次读回来做 diff 会以为内容变了。
    recs.sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const lines = [];
    for (const r of recs) {
      const key = keyOf(r.stream, r.id);
      if (ids.has(key)) { skipped++; continue; }
      ids.add(key);                            // 同一轮内也去重
      lines.push(JSON.stringify(r));
    }
    if (lines.length) {
      fs.appendFileSync(file, lines.join('\n') + '\n');
      written += lines.length;
    }
    files.push(file);
  }

  return { written, skipped, files, byStream, badLines, streams: names.length };
}

module.exports = {
  DEFAULT_ROOT, EXCLUDE, keyOf,
  isConversation, kindOf, tsOf, dayOf, unflatten, toRecord, readExistingIds,
  exportAll,
};
