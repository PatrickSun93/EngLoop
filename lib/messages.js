'use strict';

/**
 * 私聊历史 —— `GET /api/messages?to=<name>`。
 *
 * ── 它是用来做什么的 ────────────────────────────────────────────
 * 用途是复盘：**「某个 agent 掉册之后，停摆期间发给它的消息去哪了」**。
 *
 * 这个用途定死了两个设计：
 *
 * **① 必须真读流，不能用内存环形缓冲。**
 *   那种复盘往往发生在**重启之后**，而缓冲重启就没了。
 *   一个只在进程活着时有效的历史，恰好在最需要它的时刻是空的。
 *
 * **② 名字不在花名册**不能拒绝，也不能返回空。
 *   **掉册的那个恰恰是最该查的那个。** 「不在册 → 空列表」会让这个端点
 *   在它唯一的用途上失效，而且失效得像「查过了，没有消息」。
 *
 * ── 覆盖范围是不完整的，而这件事必须说出来 ──────────────────────
 * 「它发出的消息」只查得到**发给编排者的那部分**（`orch:in:agent`）。
 * 它发给**另一个 agent** 的消息由 relay 直接投进对方的收件流，不经过这里。
 *
 * 所以响应里带 `sources`：**实际查了哪些流、各查到几条**。
 * 不带的话，人会把「结果里没有」读成「它没发过」——
 * **而这个端点的读者正在复盘一次事故，那种误读的代价是查错方向。**
 */

const roster = require('./roster');

const COUNT_DEFAULT = 50;
const COUNT_MAX = 1000;

const ORCH_NAME = 'JARVIS';

/**
 * 一个名字对应哪些流。**不需要它在花名册里** —— 按 `lib/roster.js` 的
 * 约定推得出来（那三个函数是约定的唯一出处）。
 *
 * ⚠️ 编排者两边都特殊：收件是 `orch:in:human`（人发的）+ `orch:in:agent`
 *   （agent 发的），发出是 `orch:out`。**不能拿 agent 那套削一截凑。**
 *
 * @param {string} name
 * @param {string|null} type  花名册里的 type；查不到时按名字猜（见下）
 */
function sourcesFor(name, type = null) {
  // ★ 不在册时 type 未知。按名字判断是不是编排者 —— 这跟 watchdog 处理
  //   deaf 候选是同一个做法（那里 type 只有 'orchestrator'/'unknown' 两种）。
  //   猜错的后果是查错流，而那会**返回空**；所以下面 sources 里带上流名，
  //   人看得见查的是哪条，猜错时是可诊断的，不是静默的。
  const isOrch = type === 'orchestrator' || (type === null && name === ORCH_NAME);
  const kind = isOrch ? 'orchestrator' : 'crew';

  if (isOrch) {
    return [
      { stream: 'orch:in:human', direction: 'in', filter: null },
      { stream: 'orch:in:agent', direction: 'in', filter: null },
      { stream: 'orch:out', direction: 'out', filter: name },
    ];
  }
  const out = [
    // 别人写给它的。roster.inboxFor 是这个约定的唯一出处。
    { stream: roster.inboxFor(name, kind), direction: 'in', filter: null },
    // 它发给编排者的。**它发给别的 agent 的不在这里** —— 见文件头。
    { stream: roster.inboxFor(ORCH_NAME, 'orchestrator'), direction: 'out', filter: name },
  ];

  // ★★ 不在册的名字，**可能是掉册的 agent，也可能是人** —— 而这两者
  //   在花名册里长得一模一样（都查不到）。所以不猜，两套流都查。
  //
  // ── 为什么这不是「多查一点保险」───────────────────────────────────
  //   只按 agent 约定查的话，`GET /api/messages?to=Patrick` 会返回 **0 条**：
  //   Patrick 是人，按 agent 约定推出来的 `agent:Patrick:in` 根本不存在，
  //   而人的消息走的是 `orch:in:human`（他发的）和 `orch:out`（发给他的）。
  //   那就违反了文件头的「不在册不能返回空」—— 返回的空长得像「查过了，没有消息」。
  //
  //   ⇒ 代价是多读两条流（各 count 条）。收益是这个端点在它最该有用的
  //     两个场景（查掉册 agent、查人）里都不再静默返回空。
  //     覆盖范围由响应里的 `sources` 说清楚 —— 那正是它存在的理由。
  if (type === null) {
    // 他发给编排者的（人只走这条流）。
    out.push({ stream: 'orch:in:human', direction: 'out', filter: name });
    // 编排者发给他的。⚠️ 这里按 **to** 过滤，不是 from ——
    //   `orch:out` 里 from 永远是编排者，按 from 过滤会一条都不剩。
    out.push({ stream: 'orch:out', direction: 'in', filterTo: name });
  }
  return out;
}

/** 跟 rooms.parseCount 同一个规则。上限的理由也一样：一个 URL 不该能让 bus 卡住。 */
function parseCount(raw, { def = COUNT_DEFAULT, max = COUNT_MAX } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), max);
}

/**
 * 排序键。优先用消息体里的 `timestamp`（发送时刻的事实），
 * 回落到 stream id 的毫秒部分。
 *
 * ⚠️ **不要只用 stream id**：它是「写进这条流的时刻」，而两条流的写入时刻
 *   跟发送时刻可以差出一整段 relay 延迟。复盘看的是「谁先说的」，不是
 *   「谁先落盘的」。
 */
function sortKey(m) {
  const t = Date.parse(m.timestamp);
  if (!Number.isNaN(t)) return t;
  const ms = Number(String(m.id || '').split('-')[0]);
  return Number.isFinite(ms) ? ms : 0;
}

/** 把 XREVRANGE 的一行摊平成对象。 */
function flatten(id, fields) {
  const o = { id };
  for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
  return o;
}

/**
 * 读一条流的最近 count 条，按 filter 过滤。
 *
 * 返回 `{ ok, rows, error }` —— **失败不抛**，因为调用方要能说出
 * **是哪一条流查不了**。抛出去的话那个信息就只剩一句话了。
 */
async function readSource(redis, src, count) {
  try {
    const raw = await redis.xrevrange(src.stream, '+', '-', 'COUNT', count);
    const rows = raw
      .map(([id, fields]) => flatten(id, fields))
      // `filter` 按 from、`filterTo` 按 to。**两个都没有 = 整条流都要**
      // （收件流本来就只有它一个人的消息，不需要再过滤）。
      .filter((m) => (src.filter ? m.from === src.filter : true))
      .filter((m) => (src.filterTo ? m.to === src.filterTo : true))
      .map((m) => ({ ...m, stream: src.stream, direction: src.direction }));
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, rows: [], error: String(err.message || err) };
  }
}

const PARTIAL_UNAVAILABLE = 'PARTIAL_UNAVAILABLE';

/**
 * 私聊历史的响应体。
 *
 * ★★ **任何一个源查失败 → 抛，不返回一半。**
 *
 *   合并两条流天然有这个风险：`orch:in:agent` 挂了而收件流没挂时，
 *   返回的结果长成「它收到 12 条、一条都没发过」——
 *   **而那恰好是单向失聪的样子**（收得到、发出去没人捡）。
 *   一份缺了一半的复盘会把人引向一个错误的结论，
 *   **比没有结果更坏**。
 */
async function historyPayload(redis, name, count = COUNT_DEFAULT, { registry = null } = {}) {
  // 在册与否都要查 —— 但**要告诉人它在不在册**，那本身是复盘的线索。
  let rec = null;
  try {
    rec = registry !== null ? registry : await roster.lookup(redis, name);
  } catch (err) {
    // 花名册查不了不该让整个端点失效：流还是查得到的。
    // 但也不能装作「查过了，不在册」—— 那是两件事。
    rec = undefined;
  }

  const srcs = sourcesFor(name, rec ? rec.type : null);
  const results = await Promise.all(srcs.map((s) => readSource(redis, s, count)));

  const failed = results
    .map((r, i) => ({ ...r, stream: srcs[i].stream }))
    .filter((r) => !r.ok);
  if (failed.length) {
    const err = new Error(
      `查不了 ${failed.length}/${srcs.length} 条流：`
      + failed.map((f) => `${f.stream}(${f.error})`).join('，')
      + ' —— 不返回部分结果：缺一半的历史会长得像「它没发过消息」，'
      + '而那正好是单向失聪的样子。',
    );
    err.code = PARTIAL_UNAVAILABLE;
    throw err;
  }

  const messages = results
    .flatMap((r) => r.rows)
    .sort((a, b) => sortKey(a) - sortKey(b))
    .slice(-count);

  return {
    name,
    // ★ 在册与否是复盘线索，不是准入判据 —— 不在册照查（见文件头）。
    //   `undefined` 表示花名册本身没查成，跟 `false`（查了，不在）不是一回事。
    registered: rec === undefined ? null : Boolean(rec),
    type: rec ? rec.type : null,
    count,
    // ★★ 覆盖范围必须可见：这里查了哪些流、各查到几条。
    //   `out` 只覆盖「发给编排者的」—— 它发给别的 agent 的消息不在结果里，
    //   而人会把「结果里没有」读成「它没发过」。
    sources: srcs.map((s, i) => ({
      stream: s.stream,
      direction: s.direction,
      filtered_by_from: s.filter || null,
      // ★ 单列一个字段，不塞进 `filtered_by_from` —— 那个名字说的是
      //   「按谁发的过滤」，而 orch:out 是按「发给谁」过滤的。
      //   两件事共用一个名字，读的人会以为查的是他发出的消息。
      filtered_by_to: s.filterTo || null,
      matched: results[i].rows.length,
    })),
    coverage_note: '「发出」只覆盖发给编排者的那部分（orch:in:agent / orch:out）。'
                 + '它发给其它 agent 的消息由 relay 直接投进对方的收件流，不在这里。',
    // ★ 光说「不在这里」还不够 —— 人接着要问的是「那去哪查」，
    //   而这个缺口**有一个干净的出口**：那些消息在对方的收件流里，
    //   也就是用**对方的名字**再查一次这个端点。
    //   说清缺口而不给出口，人只会把「查不到」当成「没发生」。
    coverage_next: `想看它发给某个 agent 的消息，用**那个 agent 的名字**再查一次：`
                 + `/api/messages?to=<对方名字> —— 那些消息在对方的收件流里，`
                 + `会以 direction=in 出现。`,
    messages,
  };
}

/**
 * 翻译成 HTTP。判据是 `err.code`，不是文案（跟 rooms.httpError 同一个理由）。
 *
 * ★ 带 `next` —— 说清「是什么」之后还要说「该做什么」。
 *   这个端点的读者**正在复盘一次事故**，而复盘时最危险的动作是
 *   **拿着半份数据往下推**。所以 `next` 的第一句就是「别下结论」。
 */
function httpError(err) {
  if (err && err.code === PARTIAL_UNAVAILABLE) {
    return {
      status: 503,
      body: {
        error: PARTIAL_UNAVAILABLE,
        message: String(err.message),
        detail: '这不是「没有消息」，是「有一部分查不了」——'
              + '返回部分结果会让一次事故复盘得出相反的结论。',
        next: '**先别拿这次的结果下任何结论。** 上面点名的那条流恢复后重查一次；'
            + '现在就要看的话，GET /health 能看 redis 死活，'
            + '而 GET /api/agents 能看这个 agent 当前在不在线（那是另一个信号源）。',
      },
    };
  }
  return {
    status: 503,
    body: {
      error: 'QUEUE_UNAVAILABLE',
      message: String((err && err.message) || err),
      next: '这不是「它没有消息」，是「读不到」—— 别据此判断它有没有在收发。'
          + 'redis 恢复后重试；GET /health 能看它现在的死活。',
    },
  };
}

/**
 * `GET /api/messages?to=<name>` 的 handler。
 *
 * 整个放在 lib 里的理由跟 `rooms.historyHandler` 一样：**bin/ 的路由回调
 * 没法被测试 require，而这个端点的关键行为（不在册照查、部分失败不降级）
 * 只有真走一遍 HTTP 才验得到。**
 */
function handler(redis) {
  return async (req, res) => {
    const name = req.query.to;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: 'to required',
        message: '要查谁的私聊历史？例：/api/messages?to=dev',
      });
    }
    try {
      res.json(await historyPayload(redis, name, parseCount(req.query.count)));
    } catch (err) {
      const { status, body } = httpError(err);
      res.status(status).json(body);
    }
  };
}

module.exports = {
  historyPayload, handler, httpError, parseCount, sourcesFor, sortKey,
  PARTIAL_UNAVAILABLE, COUNT_DEFAULT, COUNT_MAX, ORCH_NAME,
};
