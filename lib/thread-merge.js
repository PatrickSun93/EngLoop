'use strict';

/**
 * 跨 thread 合并 —— **旁路映射**「根A 并入 根B」。
 *
 * ── 为什么只能是旁路，不能改历史 ────────────────────────────────
 * 房间流是 Redis stream，**append-only**。`lib/rooms.js` 的 `post()` 明写着
 * `reply_to` **只存不验、不回写** —— 已经写进流里的那个值，改不了。
 *
 *   > 所以「把这几条消息并到那个话题里」不可能靠修改消息实现。
 *   > 只能在旁边放一张表：**上溯找根的时候先查它。**
 *
 * ★★ 这带来一个白拿的好处，而且它是这个设计最该守住的性质：
 *   **历史一个字没动 ⇒ 合并随时可撤销。** 删掉一行映射，一切回到原样。
 *   任何「顺手把 reply_to 也改了」的优化都会把这个性质弄丢，别做。
 *
 * ── 环保护为什么是**两层**，别合并成一层 ──────────────────────────
 * ```
 * 这里（写入时）  拒绝会成环的合并  → 人当场看到「这样会成环」，能改
 * rootIdOf（读取时）遇到环也不卡死  → 数据已经坏了的时候还能把房间画出来
 * ```
 * 只做写入检查是不够的：这张表可能被手工改、被旧版本写过、被别的路径写入。
 * 只做读取保护也不够：那样人做了一次非法合并却**没有任何反馈**，
 * 而症状要等到打开房间才出现。
 *
 * ⚠️ 读取那一层的失败方式极其难认：`rootIdOf` 卡在 while 里 ⇒
 *   **「点开房间一片空白」，跟「这个房间是空的」长得一模一样**（那段注释里写着）。
 *
 * ⚠️ 自动识别同话题**不做**，合并由人手动做。
 *   判错就是把两个话题搅在一起，而**搅在一起比分开更难看出错**。
 */

const KEY = (hash) => `engloop:room:${hash}:threadmerge`;

/**
 * 加一条映射会不会成环。
 *
 * ★ 这**不是**「第二个上溯函数」。`rootIdOf` 上溯的是**消息树**
 *   （reply_to 链 + 映射两种跳转）；这里只在**映射表内部**走一遍。
 *   两者输入不同、用途不同，合并它们会让 rootIdOf 需要 Redis 才能跑 ——
 *   而它是浏览器端的函数。
 *
 * ⚠️ `from === to`（自己并入自己）也算环：它会让上溯原地打转，
 *   而且它表达的意图本身就是空的。
 */
function wouldCycle(mapObj, from, to) {
  if (!from || !to) return false;
  if (from === to) return true;
  const seen = new Set([String(from)]);
  let cur = String(to);
  while (cur != null && cur !== '') {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = (mapObj && mapObj[cur]) || null;
  }
  return false;
}

/** 读整张表：`{ 根A: 根B }`。读不到就是空表 —— 没合并过是常态，不是故障。 */
async function map(redis, hash) {
  try {
    const m = await redis.hgetall(KEY(hash));
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

/**
 * 把 `from` 并入 `to`。
 *
 * @returns `{ ok:true }` 或 `{ ok:false, error, note }` —— **失败必须有话说**：
 *   一次静默失败会让人以为合并了，然后对着没变的界面反复点。
 */
async function merge(redis, hash, from, to) {
  const a = String(from || '').trim();
  const b = String(to || '').trim();
  if (!a || !b) {
    return { ok: false, error: 'missing_root', note: '要合并哪两个话题：from / to 都得给。' };
  }
  if (a === b) {
    return { ok: false, error: 'self_merge', note: '不能把一个话题并进它自己。' };
  }

  const cur = await map(redis, hash);
  if (cur[a] === b) return { ok: true, already: true };

  // ★★ 环检查用的是**加这条之前**的表 + 这一条候选，不是加完再查 ——
  //   加完再查就得回滚，而回滚失败的话表里会留下一个成环的映射，
  //   那正好是读取端最难认的那种坏（房间一片空白 ≈ 房间是空的）。
  if (wouldCycle(cur, a, b)) {
    return {
      ok: false,
      error: 'cycle',
      note: `这样会成环：${b} 那条链最后又回到 ${a}。`
          + '先撤销中间那条合并，或者换个方向并。',
    };
  }

  await redis.hset(KEY(hash), a, b);
  return { ok: true };
}

/**
 * 撤销一条合并。
 *
 * ★ **撤销是这个设计的核心能力，不是补充功能** —— 历史没动过，所以撤销
 *   一定回得到原样。合并做错了的代价因此只是「再点一下」。
 */
async function unmerge(redis, hash, from) {
  const a = String(from || '').trim();
  if (!a) return { ok: false, error: 'missing_root', note: '要撤销哪一条：给 from。' };
  const n = await redis.hdel(KEY(hash), a);
  // n === 0 = 本来就没有这条。**不当失败**：撤销一个不存在的合并，
  // 结果和调用者想要的状态一致（它没被合并）。但要把 removed 报出去，
  // 免得界面显示「已撤销」而其实什么都没发生过。
  return { ok: true, removed: n > 0 };
}

/** 这个房间有没有合并过 —— 给界面用（没有就不必画那块 UI）。 */
async function count(redis, hash) {
  try {
    return Number(await redis.hlen(KEY(hash))) || 0;
  } catch {
    return 0;
  }
}

// ── HTTP 层 ────────────────────────────────────────────────────────
//
// ★ handler 写在这里、`bin/serve.js` 只留挂载行 —— 跟 `lib/rooms.js` 和
//   `lib/reactions.js` 同一条：**`bin/` 下的代码测不到**，而这两个端点的
//   价值恰恰全在状态码上（成环→409、缺参数→400），
//   而状态码只有真走一遍才验得到。

/** 错误码 → HTTP 状态。**`cycle` 是 409 不是 400**：请求本身没写错，是当前状态不允许。 */
const STATUS = { missing_root: 400, self_merge: 400, cycle: 409 };

function mergeHandler(redis) {
  return async (req, res) => {
    try {
      const { from, to } = req.body || {};
      const r = await merge(redis, req.params.hash, from, to);
      if (r.ok) return res.json(r);
      // ★ 每种错误都带 `next`（该做什么），不只是 `error`（是什么）。
      //   `note` 里已经写了该怎么改 —— 这里把它放到 `next` 上，跟别处对齐。
      return res.status(STATUS[r.error] || 400).json({ error: r.error, next: r.note });
    } catch (err) {
      return res.status(503).json({
        error: String((err && err.message) || err),
        next: 'Redis 可能连不上。合并表存在 Redis 里，它不可用时**宁可报错也不假装成功** —— '
            + '静默失败会让人以为合并了，然后对着没变的界面反复点。',
      });
    }
  };
}

function unmergeHandler(redis) {
  return async (req, res) => {
    try {
      const from = req.params.from || (req.body && req.body.from);
      const r = await unmerge(redis, req.params.hash, from);
      if (r.ok) return res.json(r);
      return res.status(STATUS[r.error] || 400).json({ error: r.error, next: r.note });
    } catch (err) {
      return res.status(503).json({ error: String((err && err.message) || err),
        next: 'Redis 连不上。撤销没生效 —— 界面别显示「已撤销」。' });
    }
  };
}

module.exports = {
  map, merge, unmerge, count, wouldCycle, KEY,
  mergeHandler, unmergeHandler, STATUS,
};
