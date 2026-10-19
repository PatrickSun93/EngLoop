'use strict';

/**
 * 队列**条目**（不是计数）—— 给控制台的队列面板用。
 *
 * ── 为什么它跟 `lib/status.js` 的 `queueStats()` 分开 ────────────────
 * `queueStats` 回答「积压多少」，这里回答「积压的是**哪几条**、
 * 每条**还能不能撤回**」。后者需要逐条的状态，而那是另一个问题。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★★ 这个模块存在的全部理由是**一条语义边界**：
 *
 *   ① 还没投给 agent    → 删得掉，**是真撤回**
 *   ② 已投给 agent 未 ack → **删了没用**。agent 手里已经有那条了，
 *                          它会照常干完。删除只是把队列记录抹掉，
 *                          **而人以为自己撤回了。**
 *
 * 只看一个总数的话，这两种**完全无法区分**，
 * 而它们能不能被撤回是**相反的**。
 *
 * ⇒ 所以 `state` 是这个模块的主产出，条目正文反而是次要的。
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️ 第三态也必须说出来：**已经 ack 掉的条目仍然留在流里**（stream 是
 *   append-only，ack 只动 PEL）。拿「流里有几条」当排队数，会把处理完的
 *   历史全算进去 —— 那个数字**一路涨、永不下降，而它看起来完全合理**。
 *   这正是 `queueStats` 头上那段警告的同一个坑（`XLEN` 当等待数，
 *   **队列刚起时它是对的，跑久了才错**）。
 */

/**
 * 比较两个 stream id 的先后。
 *
 * ⚠️★ **不能用字符串比较** —— stream id 形如 `<毫秒>-<序号>`，
 *   而 `'1786390372860-0' < '9999-0'` 在字符串序下是 **true**（'1' < '9'），
 *   实际前者晚了四十多年。
 *
 *   这个错的形状很坏：**流刚建立时两边位数相同，字符串序恰好等于数值序** ——
 *   于是它在新环境里全对，等 id 位数变化（或跟 `0-0` 这种初始值比）才错。
 *   跟上面那个 XLEN 坑是同一族：**测试时对，用久了错。**
 *
 * @returns {number} a > b 返回正数，a < b 返回负数，相等返回 0
 */
function cmpId(a, b) {
  const [am, as] = String(a).split('-').map(Number);
  const [bm, bs] = String(b).split('-').map(Number);
  if (am !== bm) return am - bm;
  return (as || 0) - (bs || 0);
}

/**
 * 把一条 XRANGE 的返回摊平成对象。
 * （跟 lib/messages.js 的 flatten 同形 —— 但那个是私有的，
 *   为一行代码去 require 一个不导出的东西不值得。）
 */
function flatten(id, fields) {
  const o = { id };
  for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
  return o;
}

/**
 * 分类：给定流里的条目、PEL 里的 id 集合、组的 last-delivered-id，
 * 算出每条的状态。**纯函数** —— 抽出来是为了它能被喂假数据测。
 *
 * ★ 为什么必须能测：三态的判据里有两个游标（PEL 和 last-delivered-id），
 *   而**造一个「已投递未 ack」的真实状态需要一个真的消费者去读一次**。
 *   判定逻辑留在 IO 函数里 = 它没有防线（一段测不到的判定）。
 *
 * @param {object[]} rows        流里的条目（flatten 过的，要有 id）
 * @param {Set<string>} pelIds   在 PEL 里的 id（已投递未 ack）
 * @param {string|null} lastDelivered  组的 last-delivered-id
 */
function classify(rows, pelIds, lastDelivered) {
  return rows.map((r) => {
    // ★ 顺序要紧：**先问 PEL**。
    //   一条已投递未 ack 的消息，它的 id 必然 <= last-delivered-id，
    //   所以先按游标判会把它错判成「已完成」。PEL 是更强的证据。
    if (pelIds.has(r.id)) return { ...r, state: 'in_flight' };
    // 游标之后 = 这个组还没读过它
    if (lastDelivered === null || cmpId(r.id, lastDelivered) > 0) {
      return { ...r, state: 'queued' };
    }
    // 读过、且不在 PEL ⇒ 已经 ack 掉了
    return { ...r, state: 'done' };
  });
}

/**
 * 读一条流的队列条目。
 *
 * ⚠️ `count` 限制的是**从流尾往回取多少条**，不是「返回多少条」——
 *   `done` 的那些会被滤掉，所以返回数通常小于 count。
 *   （不在这里做分页：面板要的是「现在积压了什么」，而积压按定义不会很长；
 *     真的很长时那本身就是要报告的事，不是要翻页的事。）
 *
 * @returns {{stream, group, items, queued, in_flight, error}}
 *   查不了时 `error` 有值而 `items` 是空数组 —— **「查不到」和「没有」
 *   绝不能长成一样**（lib/status.js 那段的同一条规矩）。
 */
async function listStream(redis, stream, group = null, { count = 100, includeDone = false } = {}) {
  const out = { stream, group, items: [], queued: 0, in_flight: 0, error: null };

  let lastDelivered = null;
  try {
    const raw = await redis.xinfo('GROUPS', stream);
    const groups = raw.map((g) => {
      const o = {};
      for (let i = 0; i < g.length; i += 2) o[g[i]] = g[i + 1];
      return o;
    });
    // ── ★★ 组名**从流上读**，不由调用方拼 ────────────────────────────
    //   `group` 传了就用传的；没传就用流上实际存在的那个。
    //
    //   为什么倾向后者：**流上有哪些组是事实，不是约定。**
    //   自己按 `agent:<name>:in → agent:<name>` 拼的话，跟 serve.js 的
    //   `syncRelays` 分叉的那天**不会有任何东西变红** —— 两边各自「正常工作」，
    //   而后果是这个面板永远显示 0 条（查了一个不存在的组）。
    //   组名分叉在 ack 那边的后果更重：XACK 跨组返回 0、消息无限重投。
    //
    // ⚠️ 一个流上有多个组是**异常，但不是错误** —— 说出来，不猜。
    //   猜一个的话，面板显示的是「其中某个组的积压」，而人以为是全部。
    if (!group) {
      if (groups.length === 1) out.group = group = groups[0].name;
      else if (groups.length > 1) {
        out.error = `这条流上有 ${groups.length} 个消费者组（${groups.map((g) => g.name).join(', ')}）`
                  + ' —— 没有唯一答案，不猜';
        return out;
      }
    }
    for (const o of groups) {
      if (o.name === group) lastDelivered = o['last-delivered-id'] ?? null;
    }
  } catch (err) {
    // 流不存在 / 没有组 —— 不是错误，就是「还没有队列」
    return out;
  }
  // 组名最终还是空 = 这条流上一个消费者组都没有 ⇒ 没人在读它，没有队列可言
  if (!group) return out;

  const pelIds = new Set();
  try {
    // XPENDING <key> <group> - + <count> —— 拿到已投递未 ack 的那批
    const pend = await redis.xpending(stream, group, '-', '+', String(count));
    for (const row of pend || []) pelIds.add(row[0]);
  } catch (err) {
    out.error = `XPENDING 失败：${err.message}`;
    return out;
  }

  let rows = [];
  try {
    const raw = await redis.xrevrange(stream, '+', '-', 'COUNT', String(count));
    rows = raw.map(([id, f]) => flatten(id, f)).reverse();
  } catch (err) {
    out.error = `XRANGE 失败：${err.message}`;
    return out;
  }

  const all = classify(rows, pelIds, lastDelivered);
  out.items = includeDone ? all : all.filter((x) => x.state !== 'done');
  out.queued = all.filter((x) => x.state === 'queued').length;
  out.in_flight = all.filter((x) => x.state === 'in_flight').length;
  return out;
}

/**
 * 面板的完整数据：**按收件人分组**。
 *
 * ★ 一个流 = 一个收件人（`agent:<name>:in` / `orch:in:*`），
 *   所以「按收件人分组」在这里就是「按流分组」，不需要再解析正文里的 `to`。
 *
 * ⚠️ `queued` 和 `in_flight` **分开返回，不提供合计**。
 *   合成一个「待处理 N+M」会把这个功能的**全部意义**抹掉：
 *   那两个数**能不能被撤回是相反的**。
 *   （所以这里连一个 `total` 字段都不给 —— 给了就一定有人显示它。）
 */
async function listAll(redis, { streams = null, count = 100, groupOf = null, orchName = 'JARVIS' } = {}) {
  let names = streams;
  if (!names) {
    names = [];
    for (const k of await redis.keys('*')) {
      if (!/^(orch:in:|agent:[^:]+:in$)/.test(k)) continue;
      if ((await redis.type(k)) === 'stream') names.push(k);
    }
  }
  names.sort();

  // ★★ 按**收件人**聚合，不是按流 —— 规格要的是「什么任务分给了谁」。
  //
  //   ⚠️ 编排者有**两条**收件流（`orch:in:human` 人发的 / `orch:in:agent`
  //   agent 发的）。不聚合的话它在面板上出现两行，而人会读成「有两个 JARVIS」
  //   或者只看见其中一行的数字就下判断。
  //   （lib/messages.js 头上那段写着同一件事：「编排者两边都特殊，
  //     不能拿 agent 那套削一截凑」。）
  const byRecipient = new Map();
  for (const s of names) {
    // 组名不传 —— 让 listStream 从流上读（见那里那段）。
    // `groupOf` 保留给调用方需要覆盖时用，正常路径不用它。
    const one = await listStream(redis, s, groupOf ? groupOf(s) : null, { count });
    // ★ 收件人从流名反推：`agent:<name>:in` → `<name>`；`orch:in:*` → 编排者。
    //   **这是展示用的标签，不参与任何路由判断** —— 推错了只是标签不好看，
    //   不会把消息投错地方。（真正的路由在 relay 那边，走花名册。）
    const m = /^agent:([^:]+):in$/.exec(s);
    const recipient = m ? m[1] : (s.startsWith('orch:in:') ? orchName : s);

    let cur = byRecipient.get(recipient);
    if (!cur) {
      cur = { recipient, queued: 0, in_flight: 0, items: [], streams: [], errors: [] };
      byRecipient.set(recipient, cur);
    }
    cur.queued += one.queued;
    cur.in_flight += one.in_flight;
    // 条目带上它来自哪条流 —— 编排者那两条流的条目混在一起时，
    // 「这条是人发的还是 agent 发的」是要看得出来的。
    for (const it of one.items) cur.items.push({ ...it, stream: one.stream, group: one.group });
    cur.streams.push(one.stream);
    if (one.error) cur.errors.push(`${one.stream}: ${one.error}`);
  }

  // 条目按时间排序（跨流合并之后顺序才有意义）
  for (const cur of byRecipient.values()) {
    cur.items.sort((a, b) => cmpId(a.id, b.id));
  }

  // ★ 排序：有积压的排前面，**其中「在手」优先于「排队」** ——
  //   「领了一堆没干完」比「还没投给它」更需要人看一眼。
  const groups = [...byRecipient.values()].sort((a, b) =>
    (b.in_flight - a.in_flight) || (b.queued - a.queued) || a.recipient.localeCompare(b.recipient));
  return { groups };
}

/**
 * 撤回一条队列条目。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★★ **判定和删除在同一个函数里，而且判定在前。**
 *
 * 不能做成「调用方先查状态、觉得可以再调删除」——那中间有个窗口：
 * agent 正好在这两步之间领走了它。于是**人看到的是「已撤回」，
 * 而 agent 手里有一份，照常干完。** 这正是这个功能要防的那个后果，
 * 而拆成两步会亲手把它造出来。
 *
 * ⚠️ 就算合成一步，redis 这边也不是原子的（XPENDING 查完到 XDEL 之间
 *   仍有微秒级窗口）。**这一点如实标着**：它把窗口从「人的反应时间」
 *   缩到「两个 redis 命令之间」，不是消除。真要消除得用 Lua 脚本，
 *   而那个复杂度对这个功能不划算 —— **但下一个人有权知道它还在。**
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️ 前端不渲染按钮**不是机制，是给人看的**。一次前端 bug、一条手写
 *   curl 都能绕过它。机制在这里。
 *
 * @returns {{ok, state, reason}} `ok:false` 时 `reason` 是给人看的话，
 *   **必须说清出路** —— 「不能删」而不说该怎么办，人就会去猜。
 */
async function cancelItem(redis, stream, id, group = null, { onBeforeDelete = null } = {}) {
  const one = await listStream(redis, stream, group, { count: 500, includeDone: true });
  if (one.error) return { ok: false, state: null, reason: one.error };
  // listStream 会把组名从流上读出来 —— 后面复查 PEL 要用同一个组，
  // 不能再拼一次（那就是第二处出处了）。
  group = group || one.group;

  const hit = one.items.find((x) => x.id === id);
  if (!hit) {
    return {
      ok: false, state: null,
      reason: '这条不在队列里了 —— 可能刚被领走并处理完，也可能 id 写错了。'
            + '刷新一下看它还在不在。',
    };
  }
  if (hit.state === 'in_flight') {
    return {
      ok: false, state: 'in_flight',
      // ★ 说清出路，不只是拒绝。
      reason: '它已经领走这条了 —— **删掉队列记录不会让它停下**，它会照常干完。'
            + '要撤只能直接跟它说一声。',
    };
  }
  if (hit.state === 'done') {
    return {
      ok: false, state: 'done',
      reason: '这条已经处理完了，删除没有意义（流是 append-only 的历史）。',
    };
  }
  // 到这里只剩 queued —— 还没投出去，删得掉，是真撤回
  // ★ 测试专用钩子：**这个竞态只能在「判定之后、XDEL 之前」注入才造得出来**，
  //   而它是这个函数最重要的一条路径。默认 null，生产路径上不存在。
  if (typeof onBeforeDelete === 'function') await onBeforeDelete();

  const n = await redis.xdel(stream, id);

  // ══════════════════════════════════════════════════════════════
  // ★★★ 删完**重新查一次** —— 判定和删除之间它可能刚好被投出去。
  //
  //   这个竞态**消不掉**（redis 没有原子的「检查并删除」），
  //   所以不假装消掉它 —— **如实报告发生了什么**：
  //
  //     删掉了、且确实没被投递  → 「已撤回」
  //     删的时候它已经进了 PEL  → **「晚了一步，它已经在它手里了」**
  //
  //   ⚠️ 最坏的写法是删完一律回「已撤回」。那就是这个功能本来要防的
  //   那个形状本身：**一个让人以为撤回了、而 agent 照样在干的按钮。**
  //
  //   ⚠️ 注意 XDEL **对已投递的条目同样返回 1**（它删的是流里的条目，
  //   而 PEL 记的是 id，两者是分开的）—— 所以**返回值分不出这两种情况**，
  //   必须去查 PEL。「命令成功了」和「事情如你所愿」是两件事。
  // ══════════════════════════════════════════════════════════════
  let racedIntoPel = false;
  try {
    const after = await redis.xpending(stream, group, '-', '+', '1000');
    racedIntoPel = (after || []).some((row) => row[0] === id);
  } catch (_) {
    // 复查本身失败 —— **不能因此报成功**。说清「删了，但确认不了」。
    return {
      ok: false, state: 'unknown', deleted: n > 0,
      reason: '已经从队列里删掉了，但**确认不了它有没有在删之前被领走** —— '
            + '复查 PEL 失败。保险起见直接跟它说一声。',
    };
  }

  if (racedIntoPel) {
    return {
      ok: false, state: 'in_flight', raced: true, deleted: n > 0,
      reason: '**晚了一步** —— 就在撤回的这一瞬间它已经把这条领走了。'
            + '队列记录删掉了，但**它手里有一份，会照常干完**。要撤只能直接跟它说。',
    };
  }
  return n > 0
    // ★ 带上原条目 —— 前端的「撤回改写」要拿它的正文预填输入框。
    ? { ok: true, state: 'queued', deleted: true, reason: null, item: hit }
    // ★ XDEL 返回 0 = 没删到。**不能报成功** —— 那正是「以为撤回了」的形状。
    : { ok: false, state: 'queued', deleted: false,
        reason: 'XDEL 返回 0，没有删到这条（可能刚被别人删了）。刷新一下看它还在不在。' };
}

module.exports = { listAll, listStream, classify, cmpId, flatten, cancelItem };
