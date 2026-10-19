'use strict';

/**
 * 花名册 —— 谁活着、消息该往哪送。
 *
 * ── 存活 = key 未过期 ──────────────────────────────────────────────
 * 不扫目录拼 roster JSON、不用 process.kill(pid,0) 探活、
 * 不维护 instances 表和关停队列。
 *
 * 注册时写一个带 TTL 的 key，agent 定期续期。
 * 进程没了就不再续期，key 自然过期，存活判定即 key 是否存在。
 * 没有 PID 表、没有僵尸清理、没有关停队列。
 * ────────────────────────────────────────────────────────────────
 */

const KEY = (name) => `engloop:roster:${name}`;

/**
 * agent 名 → tmux 会话名。**约定的唯一出处。**
 *
 * `agent-start`、`orch-start`、`watchdog` 都调用这里，不各写一份。
 * `watchdog.sessionToName` 是**逆函数**，方向相反，
 * 合并不了 —— 它靠 test/watchdog-liveness【3c-7】的往返断言跟这里钉在一起。
 *
 * 集中到这里是因为
 * **自愈重建时必须填对 `tmux_session`** —— 填错或缺失的话，watchdog 会把
 * 这个 agent 的会话判成 deaf（「会话在、册里没有对应条目」），
 * **等于自愈完成的瞬间制造一个误报**。
 */
function sessionFor(name, type) {
  return type === 'orchestrator' ? 'orch' : `agent_${name}`;
}

/**
 * agent 名 → **别人写给它时该投的流**。同样是约定的唯一出处。
 *
 * ⚠️ 编排者的收件流是 `orch:in:agent`，**不是** `agent:JARVIS:in`。
 *   `register()` 的默认值要是无条件用后者 —— 对 agent 恰好是对的，对编排者
 *   是个**没有任何消费者的黑洞流**：relay 照常投递、XADD 照常成功、
 *   谁也不报错，消息就没了。显式传 stream 的调用方看不出这个问题；
 *   自愈重建**不传** stream，就会踩到。
 *
 * 注意编排者有两个收件流（`orch:in:human` 优先于 `orch:in:agent`），
 * 这里返回的是**花名册路由用的那个**：人类那条由 web relay 直接喂，
 * 不经花名册。**「它消费哪些流」和「别人该往哪写」是两个问题。**
 */
function inboxFor(name, type) {
  return type === 'orchestrator' ? 'orch:in:agent' : `agent:${name}:in`;
}

/**
 * agent → **它读消息用的消费者组名**。第三条约定，同样只此一处。
 *
 * ⚠️ 这一条的分叉后果比另外两条都狠：
 *   如果某处无条件用 `'agent:'+name`，编排者会被算成 `agent:JARVIS` 组 ——
 *   于是 JARVIS 拿 `agent:JARVIS` 组去 XACK `orch`
 *   组的 PEL。**XACK 跨组不报错，返回 0**，每条消息 60 秒后无限重投。
 *
 *   另一处是 `watchdog` 查 XINFO CONSUMERS 判 idle。它用错组的话查不到消费者
 *   → idle 判定失效 → **一个用来发现失聪的机制，以失聪的方式坏掉**。
 *
 * 注意组名跟收件流名**不是一回事**（`agent:dev` vs `agent:dev:in`），编排者更是
 * 两边都特殊（组 `orch`、流 `orch:in:agent`）。所以不能拿 inboxFor 削一截凑。
 */
function groupFor(name, type) {
  return type === 'orchestrator' ? 'orch' : `agent:${name}`;
}
// TTL 必须大于**一整个轮询周期**：阻塞 594s + 处理时间 + 余量。
//
// 设成 90s 这类短值是错的 —— next.js 只在启动时心跳一次然后阻塞 9.9 分钟，
// agent 明明活着却会在阻塞中途掉出花名册，导致别人发给它的消息
// 被当成「发给人」路由错地方。这个 bug 只在阻塞超过 TTL 时才现形。
//
// 失聪检测不该靠这个 TTL —— 「外部 watchdog 观察消费者组
// 多久没发过 XREADGROUP」才是正确手段，它是服务端事实而非猜测。
// 花名册的职责只是**路由**：谁在、消息往哪送。
const TTL_SEC = 900; // 15 分钟 = 594s 阻塞 + 充足余量

async function register(redis, name, info = {}, ttl = TTL_SEC) {
  const rec = {
    name,
    type: info.type || 'unknown',
    cwd: info.cwd || '',
    tmux_session: info.tmux_session || '',
    // 收件流。一 agent 一个流，消费者组同名。编排者是例外，见 inboxFor()。
    stream: info.stream || inboxFor(name, info.type),
    registered_at: new Date().toISOString(),
    // ★ 最后一次心跳的**毫秒时间戳**。见 heartbeat() 的说明。
    last_heartbeat: Date.now(),
  };
  await redis.set(KEY(name), JSON.stringify(rec), 'EX', ttl);
  return rec;
}

/**
 * 续期。agent 每轮循环调一次即可。
 *
 * ── 为什么存 `last_heartbeat`，而不是让人从 TTL 反推 ────────────────
 * 「最后心跳是什么时候」本可以用「注册时的 TTL − 剩余 TTL」算出来。
 * **别这么做**：那是间接量，依赖「注册时的 TTL 是多少」这个**会变的前提**。
 *
 * 例：`orch-start.js` 给编排者传 86400，而 `next.js` 每轮 heartbeat
 * 用默认参数 900 —— **第一次轮询就把它踩回去了**。所以 TTL **恰好**是 900，
 * 反推**恰好**算得对。**它对得纯属巧合** —— 这两处一改，反推就开始撒谎，
 * **而且不会有任何东西变红**。
 *
 * 判据：**「不显示」和「显示一个可能是错的数」不对称 ——
 * 前者会让人去查，后者会让人相信。** 所以存事实，不存推论。
 *
 * ── 为什么读-改-写在这里是安全的 ────────────────────────────────────
 * 把原子的 `EXPIRE` 换成 GET→改→SET 通常要担心丢更新。**这里的写入者：**
 *   · `heartbeat(name)` **只有那个 agent 自己在调**，而它的循环是串行的
 *   · 唯一可能撞上的是它自己的 `register`（有些 agent 每轮会调）
 *   · 撞了的后果是 `last_heartbeat` **差几秒**，不是数据损坏
 * **「非原子写有风险」和「这里有几个写入者」是两个问题。**
 *
 * ⚠️ 顺带的好处：`last_heartbeat` 和剩余 TTL 一起看，**「86400 被 900
 *    踩回」就变成可观测的了**（心跳 30 秒前、TTL 却只剩 870 而不是
 *    86370）。**这里只让它可见，不修它。**
 *
 * ── 返回值：字符串，不是布尔 ──────────────────────────────────────
 *   `'renewed'`   在册，续期成功 —— 正常
 *   `'rebuilt'`   **不在册，刚重建** —— 这是「刚刚掉过册」的证据，调用方
 *                 应该大声说出来；它意味着这期间发过来的消息全路由错了
 *   `'need_info'` 不在册，但调用方没给 type，**没重建**
 *   `'corrupt'`   条目是坏 JSON，且没素材重建
 *
 * 不返回布尔，是因为布尔表达不了「刚把你救回来」—— 而那恰恰是
 * 唯一需要被人看见的状态。`.catch(()=>{})` 丢弃返回值的调用方
 * 不会因此报错，只是看不到这个信号。
 */
async function heartbeat(redis, name, info = {}, ttl = TTL_SEC) {
  // 重建：素材来自调用方，**约定由这里补全**。
  //
  // ⚠️ 只补 `tmux_session`，**不补 `stream`** —— 后者 register() 的默认值
  //   （inboxFor）已经算过了，在这里再写一遍就是第二份实现。
  //
  // 这个不对称是有理由的，不是漏写：
  //   · `stream` 空值**没有合法含义** —— 每个 agent 都必须有收件流，
  //     所以推导值可以放进 register() 的默认，对所有调用方都兜底。
  //   · `tmux_session` 空值**有合法含义** = 「我不跑在 tmux 里」。
  //     放进 register() 默认会消灭这个状态，让非 tmux 的注册者被 watchdog
  //     判成 stale 然后 unregister 掉 —— 拿一个新故障换一个旧故障。
  //     所以只在**确知对方是 tmux agent**的重建路径上补。
  const rebuild = async () => {
    await register(redis, name, {
      ...info,
      tmux_session: info.tmux_session || sessionFor(name, info.type),
    }, ttl);
    // ★★ 留痕。**自愈成功恰恰是最容易被彻底遗忘的那种故障。**
    //
    //   掉册被救回时，`bin/next.js` 会打一条 stderr 警告 ——
    //   **而那条警告只有 agent 自己的终端看得见。**不留痕的话，
    //   **这次掉册不会在任何地方留下一个字。**
    //
    //   ⇒ 「救回来了」和「什么都没发生」在系统外部长得一模一样。
    //     所以自愈必须留痕 —— 这不是日志洁癖，是这个功能的另一半。
    await noteDropout(redis, name, info.type);
    return 'rebuilt';
  };

  const raw = await redis.get(KEY(name));

  // ── 不在册 → 自愈重建 ──
  //
  // ★ 这一支是整个功能的要点。没有它，掉册是**不可逆**的：纯 EXPIRE
  //   对一个不存在的 key 返回 0，跑一万次也救不回来，只能人手动救。
  //
  // ⚠️ **自愈逻辑只在这里，不许复制到调用方。** 让每个调用方自己写
  //   「heartbeat 返回失败就调 register」，就是第二份实现 ——
  //   而两份实现分叉时不会有任何测试变红。
  //   调用方只负责**提供重建素材**（info），那是它才有的信息，不是逻辑。
  if (!raw) {
    if (!info || !info.type) {
      // 数据不够就**不猜**。type 错了会让 watchdog 查错消费者组
      // （orchestrator 走 'orch' 组，别的走 'agent:<name>'），
      // idle 判定跟着失效 —— 那比不重建更难查。
      return 'need_info';
    }
    return rebuild();
  }

  // ── 在册 → 续期 + 更新心跳时间 ──
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch (_) {
    // 条目坏了：续期它反而会让一份坏数据活得更久。当作不在册处理，
    // 有素材就重建一份干净的。
    if (info && info.type) return rebuild();
    return 'corrupt';
  }
  rec.last_heartbeat = Date.now();
  await redis.set(KEY(name), JSON.stringify(rec), 'EX', ttl);
  return 'renewed';
}

/**
 * 掉册留痕。**跟花名册本身分开存** —— 它的用途是复盘，不是路由。
 *
 * ⚠️⚠️ 前缀**故意不是** `engloop:roster:` —— 写成
 *   `engloop:roster:dropouts` 的话，`list()` 的 `SCAN MATCH engloop:roster:*`
 *   会把它一起扫出来，然后对一个 list 执行 `GET` → `WRONGTYPE`，
 *   **整个花名册查询崩掉**（花名册崩 = 所有消息路由失效）。
 *
 *   ⇒ 一条通用的：**共享前缀 + SCAN MATCH 通配，等于声明「这个前缀下
 *     所有 key 都是同一种类型」**。
 */
const DROPOUT_KEY = 'engloop:dropouts';
const DROPOUT_KEEP = 50;

/**
 * 记一次「掉册后被自愈救回」。
 *
 * ⚠️ **只记「发现时刻」，不记区间** —— heartbeat 知道的是「这一刻我不在册」，
 *   它**不知道从什么时候开始不在的**（TTL 过期是静默的，没有事件）。
 *   编一个开始时间会让复盘的人算出一段假的失聪时长，
 *   而那比没有记录更坏。响应里那句 `unknown_since` 就是在说这件事。
 *
 * ⚠️ 写失败**不抛** —— 留痕失败不该让心跳跟着失败。
 *   救回来比记下来重要，但两件都要试。
 */
async function noteDropout(redis, name, type = null, at = Date.now()) {
  try {
    await redis.lpush(DROPOUT_KEY, JSON.stringify({
      name, type: type || null, detected_at: at,
      // ★ 这一行是给读的人的，不是给机器的：别把 detected_at 当成掉册开始时刻。
      unknown_since: true,
    }));
    await redis.ltrim(DROPOUT_KEY, 0, DROPOUT_KEEP - 1);
    return true;
  } catch {
    return false;
  }
}

/** 最近的掉册记录，新的在前。 */
async function dropouts(redis, limit = 10) {
  try {
    const raw = await redis.lrange(DROPOUT_KEY, 0, Math.max(0, limit - 1));
    return raw.map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function lookup(redis, name) {
  const raw = await redis.get(KEY(name));
  return raw ? JSON.parse(raw) : null;
}

async function list(redis) {
  const out = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', KEY('*'), 'COUNT', 100);
    cursor = next;
    for (const k of keys) {
      const raw = await redis.get(k);
      if (raw) {
        const rec = JSON.parse(raw);
        rec.ttl_s = await redis.ttl(k);
        out.push(rec);
      }
    }
  } while (cursor !== '0');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 主动摘牌（优雅关停用）。不调也行 —— TTL 到了自己会掉。 */
async function unregister(redis, name) {
  return redis.del(KEY(name));
}

module.exports = {
  register, heartbeat, lookup, list, unregister,
  sessionFor, inboxFor, groupFor, TTL_SEC, KEY,
  noteDropout, dropouts, DROPOUT_KEY, DROPOUT_KEEP,
};
