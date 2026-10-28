'use strict';

/**
 * 失聪看门狗。
 *
 * ── 为什么放在服务端 ───────────────────────────────────────────
 * 靠 agent 自己去排程的兜底（比如定时 cron 自检）**依赖 agent 本身**。
 * agent 一旦失聪，那层也跟着失聪 —— 靠一个可能已经不工作的东西来检测
 * 它自己不工作。
 *
 * 队列让这件事变成**服务端事实**：Redis 知道每个消费者多久没发过
 * XREADGROUP 了（XINFO CONSUMERS 的 idle 字段）。这不是猜测，
 * 不依赖 agent 配合，agent 死透了也照样测得出来。
 * ──────────────────────────────────────────────────────────────
 *
 * 但它治不了根：「大脑就是不再调用 poll」属于提示词遵从
 * 问题，不是传输问题，**没有任何队列能修好它**。所以这里只做检测 + 推一把。
 */

const fs = require('node:fs');
const path = require('node:path');
const q = require('./queue');
const roster = require('./roster');
const tmux = require('./tmux');
// ★ 只为拿 QUIET_MS —— **不另写一个 180_000**。同一个「多久算静默」的事实
//   在两处各写一遍，迟早会分叉。
//   （不构成循环依赖：shutdown 只 require queue + roster。）
const shutdown = require('./shutdown');
// ★ 长任务申报。**它治的是 outbox 判据无解的那一类** ——
//   跑单次长 Bash 调用的 agent 在调用期间没有执行权，写不了 outbox。
//   （不构成循环依赖：busy 只在 whoami() 里**惰性** require watchdog。）
const busy = require('./busy');
// ★ 撞限额信号文件（StopFailure hook 写、这里读）。路径 / 名字判据 / 形状只在那一份。
const rlSignal = require('./rate-limit-signal');

// ⚠️ **必须走 `ENGLOOP_OUTBOX_ROOT`**，不能硬编码。
//
//   ── 而这里的危害跟 `lib/probe.js` 那处**方向相反**，别照抄它的理由 ──────
//     probe 往 outbox **写** ⇒ 不覆盖的后果是「测试写的假回复被真 relay 发出去」。
//     🔴 而 watchdog 只**读**（`outboxIdleMs` = `now - statSync(...).mtimeMs`）
//        ⇒ 不覆盖的后果是**判据的输入来自生产目录**：
//        没传 `outboxRoot` 的 `check(redis, {…})` 测试，读的全是真实 `temp/outbox/`。
//
//   ── 这类测试能绿，靠的是**碰巧**，而不是有东西兜着 ──
//     测试用的名字在 `temp/outbox/` 下要么没有目录（`outboxIdleMs` 返回 `Infinity`），
//     要么目录很久没动过（远超 WARN/NUDGE/ALERT 阈值，行为等同 `Infinity`）
//     ⇒ ⇒ **绿的原因是「没有一个测试名字是活着的 agent」** —— 而那不是任何人保证的。
//     🔴 失效条件：**某个测试用了活 agent 的名字**（`dev`/`senior`/`JARVIS`），
//       **或者有人往那个测试名字的 outbox 目录里写一次**。
//       那时判据的取值会取决于**隔壁 agent 刚才有没有说话** ⇒ 假绿 / 间歇红。
const OUTBOX_ROOT = process.env.ENGLOOP_OUTBOX_ROOT
  || path.join(__dirname, '..', 'temp', 'outbox');

/**
 * ★ agent 最后一次有 outbox 活动距今多久 —— **唯一独立于 poller 的活性信号**。
 *
 * ── 为什么必须是它，不能是心跳或 idle ────────────────────────────
 * **心跳年龄 ≡ 队列 idle** —— 因为两者都由 `bin/next.js` 的同一轮
 * 驱动（poller 跑一轮 = 刷心跳 + 发 XREADGROUP）。
 * **它们不是互相印证，是同一个数看两遍**，所以拿心跳去补 idle 是死路。
 *
 * 而 outbox 是 agent 自己写的：一个正在干长活的 agent，队列 idle 可以很大，
 * outbox 却刚写过 —— **不是聋了，是忙**。这两个信号是真的互相独立。
 *
 * ── 判据的出处 ──
 * `lib/shutdown.js` 已经用它解决过一模一样的问题（「它不是聋了，它是忙」）。
 * **这里是把那个判据接过来，不是新设计。**
 *
 * ⚠️⚠️ **局限：用的是目录 mtime，而 relay 捡走文件时也会更新它。**
 *   所以它精确的语义是「**最后一次有文件进出**」，不是「最后一次 agent 写入」。
 *   对活性判断够用（relay 的删除总是紧跟在写入之后，差几十毫秒），
 *   **但它不是一个干净的信号源 —— 这是权宜，不是设计。**
 *
 *   **干净的做法**：bus 在 relay 的 `onEvent` 里记 `Map<name, ts>`
 *   （`relayed` / `ack_only` 事件都带 `from`），watchdog 读那个 Map。
 *   那要动 `bin/serve.js`。换过去时**判据形状不用变，只换 outboxIdle 的来源**。
 *
 * ⚠️ **目录不存在返回 Infinity，不是 null** —— 「没有活动证据」和「很久没活动」
 *   在这里是同一件事：一个不写 outbox 的 agent，要么没在干活，要么干活不报进度
 *   （违反协议第 1 条）。**两种都该被推一把。** 返回 null 会逼调用方再判一次
 *   「不确定怎么办」，而那个分支没有正确答案。
 */
function outboxIdleMs(name, { root = OUTBOX_ROOT, now = Date.now() } = {}) {
  try {
    return now - fs.statSync(path.join(root, name)).mtimeMs;
  } catch (_) {
    return Infinity;
  }
}

// 阈值必须大于一整个轮询周期。阻塞 594s 期间 idle 本来就会持续增长，
// 那是正常的 —— 阻塞返回后 agent 立刻再次 XREADGROUP，idle 归零。
// 卡住的特征是「超过阻塞时长之后 idle 仍在涨」。
const WARN_MS = 900_000;   // 15 分钟：记一笔
const NUDGE_MS = 1_200_000; // 20 分钟：send-keys 推一把
const ALERT_MS = 1_800_000; // 30 分钟：告诉人

/** 取某个消费者组里各消费者的空闲时长 */
async function consumerIdle(redis, stream, group) {
  try {
    const rows = await redis.xinfo('CONSUMERS', stream, group);
    return rows.map((r) => {
      const o = {};
      for (let i = 0; i < r.length; i += 2) o[r[i]] = r[i + 1];
      return { name: o.name, pending: Number(o.pending), idleMs: Number(o.idle) };
    });
  } catch (err) {
    // 这两种都不算异常，是「还没开始」的正常状态：
    //   NOGROUP     组还没建（没人读过）
    //   no such key 流本身还不存在（一条消息都没发过）
    const m = String(err.message);
    if (m.includes('NOGROUP') || m.includes('no such key')) return [];
    throw err;
  }
}

// agent 的会话名规则：resident agent 是 `agent_<name>`，编排者是 `orch`。
// 别的 tmux 会话（人自己开的）不归 watchdog 管 —— 把它们当成失聪的 agent
// 会制造噪音，而噪音多了人就不看告警了。
//
// ★ 这里是**逆向**：会话名 → agent 名。`roster.sessionFor()` 是正向。
//   两个方向没法合并成一个函数，所以这里不改成调用它 —— **但它们必须互逆**，
//   一方改了另一方没跟上，watchdog 就会把活着的 agent 认成陌生会话（判 deaf）
//   或者反过来把它漏掉。守法是 test/watchdog-liveness 里的**往返断言**
//   `sessionToName(roster.sessionFor(n, t)) === n`，不是靠人记得同步改两处。
const ORCH_NAME = 'JARVIS';
const ORCH_SESSION = roster.sessionFor(ORCH_NAME, 'orchestrator');

function isAgentSession(session) {
  return session === ORCH_SESSION || session.startsWith('agent_');
}

/** 从会话名反推 agent 名。掉册时这是**唯一**知道的身份信息。 */
function sessionToName(session) {
  return session === ORCH_SESSION ? ORCH_NAME : session.slice('agent_'.length);
}

/**
 * 检查活性。返回判定，不直接执行动作 —— 动作交给 act()，便于测试。
 *
 * ── ★ 枚举源是 **tmux 会话列表**，不是花名册 ──────────────────────
 * 从 `roster.list()` 起头的话：
 *
 *   **它盯着一份「还在报到的人」的名单，去找「不再报到的人」。**
 *
 * 而**掉册和失聪是同一个原因**（poller 停了）—— agent 不轮询就不刷心跳，
 * 900 秒后掉出花名册。所以**最该救的那类恰好不在它的枚举源里**：
 * 不是判断错了，是根本没看见。
 *
 * 会话列表是「**应该在的**」，花名册是「**还在报到的**」，两者做差：
 *
 *   会话在 + 册在  → 正常，查 idle
 *   会话在 + 册无  → **失聪**（掉了册的 agent）
 *   会话无 + 册在  → 脏记录，清掉
 *
 * ⚠️ **不要"顺手"把枚举源改成 roster.list()。** 改过去之后后两格
 *    会永远是空的 —— 而空的判定集合看起来跟「一切正常」一模一样，
 *    **没有任何测试会因此变红，除了 test/watchdog-liveness.test.js【1】**。
 */
/**
 * 把「会话列表」和「花名册」比对成三格。**纯函数，不碰 redis 也不碰 tmux。**
 *
 * ★ 抽出来是因为**不止 watchdog 要用它**：bus 页面的在线列表也要回答
 *   「谁在会话里但不在花名册」这个问题。两处各算一遍的话迟早不一致，
 *   **而不一致的时候没有人会发现** —— 两边各自都「正常工作」，只是说法不同。
 *   一个数据源，两个消费者。
 *
 * @returns {{ deaf: object[], stale: object[], live: object[] }}
 *   deaf  会话在、花名册无 —— 轮询停了（不轮询就不刷心跳，900 秒后掉册）
 *   stale 花名册有、会话无 —— 脏记录
 *   live  两侧都在，或**在册但没登记会话名**（那种无从比对，但不能因此不看它）
 */
function classifySessions(agents, allSessions) {
  const bySession = new Map(agents.filter((a) => a.tmux_session).map((a) => [a.tmux_session, a]));
  // 见下方 check() 里的说明：两个集合用途不同，合并就会误判
  const liveNames = new Set(allSessions.map((s) => s.name));
  const agentSessions = allSessions.filter((s) => isAgentSession(s.name));

  return {
    deaf: agentSessions
      .filter((s) => !bySession.has(s.name))
      .map((s) => ({
        name: sessionToName(s.name),
        type: s.name === ORCH_SESSION ? 'orchestrator' : 'unknown',
        tmux_session: s.name,
      })),
    stale: agents.filter((a) => a.tmux_session && !liveNames.has(a.tmux_session)),
    live: agents.filter((a) => !a.tmux_session || liveNames.has(a.tmux_session)),
  };
}

/**
 * ★ watchdog 自己的活性证据：**本轮枚举到了几个会话**。
 *
 * ── 为什么 fail-closed 还不够 ────────────────────────────────────
 * `tmux.list()` 的 fail-closed 管的是「**它自己知道**它失败了」。
 * 这条管的是「**即使它不知道，结果的形状本身就不合理**」——
 * 两个前提不同，所以是真的两层（同前提的两条加起来还是一条）。
 *
 * **零会话在这个系统里从来不是正常状态：至少 orch 必须在。**
 * 所以 N=0 要明确报出来，不能安静通过 —— 安静通过时，
 * 「一个 agent 都没出问题」和「我一个 agent 都没看见」长得一模一样。
 *
 * ⚠️ 它同时是可查的历史：`GET /api/agents` 带上 `sessions_seen`，
 *   于是「watchdog 到底做出过几次判定」有答案，而不是靠翻日志猜。
 * ────────────────────────────────────────────────────────────────
 */
const ZERO_SESSIONS_TEXT = (n) =>
  `⚠ **watchdog 本轮一个 tmux 会话都没枚举到（sessions_seen=${n}）。**\n`
  + '零会话在这个系统里从来不是正常状态 —— **至少编排者的 orch 会话必须在**。\n'
  + '所以这更可能是「我看不见」，不是「真的没有」：'
  + 'tmux 查询看似成功但返回空，或者 bus 跑在一个看不到那些会话的环境里'
  + '（launchd/nohup 的 PATH 与 TMUX socket 跟你的 shell 不同）。\n'
  + '**这段时间 watchdog 没有在检测任何 agent 的失聪** —— 别把无告警当成一切正常。';

// ── ★★ 第四档：撞了上游限额 ──────────────────────────────────────────
//
// 两级超时设计考虑了两种状态：**聋**（没读到请求）和**忙**（在干长活）。
// **这是第三种：上游不可用**（API `ECONNRESET`、rate limit 都是这一类）。
// 撞了 rate limit 时，**nudge 会直接加速消耗**：
//
//   agent 撞限额 → 无法轮询 → 掉册 → watchdog 判「失聪」→ send-keys 推一把
//   → 被唤醒 → 立刻再撞墙 → 再掉册 → 再 nudge   ……**永动机**
//
// ★ 处置跟 `heartbeat_lost` 同侧：**不 nudge，报给人。**
//   `deaf` 是唯一该 nudge 的那一档，而它的前提是「推一把就能好」——
//   撞限额的会话推一把只会更快地撞下一次。
//
// ⚠️⚠️ **已知假阳性：agent 正在讨论/编写关于限额的东西时，pane 上就有这些字。**
//   （比如正在改这段代码的 agent，pane 里会满屏 `rate limit`。）
//   **不装作没有这个问题，而是选一个代价方向：**
//
//     判错成 rate_limited（真失聪）→ 不 nudge，但**照样告警给人** ⇒ 慢一步，人看得见
//     判错成 deaf（真撞限额）      → nudge ⇒ **烧光订阅额度，而且没人看得见**
//
//   ⇒ 两个方向的代价差着数量级，所以宁可假阳性。**这是取舍，不是精度。**
//
// 降低假阳性的那一手：**只看 pane 末尾几十行**（限额提示是最后发生的事，
// 而讨论会被后续输出顶上去）。不是消除，是压低。
const RATE_LIMIT_PEEK_LINES = 40;

const RATE_LIMIT_RE = [
  /\b(session|usage|rate)\s+limit\b/i,
  /\blimit\s+reached\b/i,
  // 限额提示几乎总跟着一个「什么时候恢复」——它比 limit 这个词更少出现在别处
  /\bresets?\s+(at|in|on)\b/i,
];

/**
 * pane 内容里有没有上游限额的迹象。**纯函数，抽出来就是为了能喂假输入。**
 *
 * ★ **这一档的验证必须能造出来 —— 不能等下一次真撞限额才知道它对不对。**
 *   真限额很少撞到，而**一个没被执行过的分支和一个不存在的分支等价**。
 *
 * ⚠️ 输入不是字符串（peek 失败、会话没了）一律返回 false ——
 *   **但调用方不许把这个 false 当成「确认没有限额」**：那两件事的区别
 *   由 `pane_error` 承担，不由这个返回值承担。见 check() 里那段。
 */
function looksRateLimited(paneText) {
  if (typeof paneText !== 'string' || !paneText) return false;
  return RATE_LIMIT_RE.some((re) => re.test(paneText));
}

// ══ 出口：从「pane 上那行字还在不在」→「它说的时间过了没有」══════════════
//
//   ★ **入口判据不归这一段管**。这一段只回答一个问题：
//     既然已经判成 `rate_limited`，**什么时候可以再试一次**。
//
//   ⚠️ 它服务的是**真的停住**的那些。还能输出的 agent 自己就会脱离 ——
//     因为那行字被后续输出顶出 `RATE_LIMIT_PEEK_LINES` 窗口。两条路不冲突。
//     （「agent 不动 ⇒ pane 不变」不是因果，只是一个恰好可用的等价物。）

/**
 * 从 pane 文本里抓「什么时候恢复」。
 *
 * ── 两条，而**上面那条在真实文案上不命中** ────────────────────────────
 *   第一条要求 `at/in/on`，真实文案不一定带；它不命中也不会有人发现，
 *   因为 `RATE_LIMIT_RE` 的第一条一直在替它判「是不是限额」—— 两个防御依赖
 *   同一个前提，就不是两层。
 *   ⇒ 这里**保留**它（不许删），在它下面补一条不带那个前提的。
 *   ⚠️ 顺序有意义：带更多上下文的先试，抓到的更可能是真的那个时刻。
 */
const RESET_TIME_RE = [
  /\bresets?\s+(?:at|in|on)\s+([0-9]{1,2}:[0-9]{2}\s*[ap]\.?m\.?)/i,
  /\bresets?\s+([0-9]{1,2}:[0-9]{2}\s*[ap]\.?m\.?)/i,
];

/** IANA 时区名的**形状**。⚠️ 形状不等于身份 —— 身份由 `Intl` 判（见 tzOffsetAt）。 */
const IANA_TZ_RE = /\b([A-Za-z]{2,}(?:_[A-Za-z]+)*\/[A-Za-z]{2,}(?:_[A-Za-z]+)*(?:\/[A-Za-z]{2,}(?:_[A-Za-z]+)*)?)\b/;
// ★ 带 `g` 的同一条 —— `matchAll` 要求它。**两条必须同源**：
//   分开写两份的话，改一处不报错，而另一处静静地跟它分叉。
const IANA_TZ_RE_G = new RegExp(IANA_TZ_RE.source, 'g');


// ── 最坏情况：**一个本地时刻的周期** = 24 小时 ─────────────────────────
//
//   文案给的是**某个未知时区的本地时刻** T，而要的是
//   「`detected_at` 之后最近的那个 T」。
//
//   ★ 无论 T 属于哪个时区，那个「最近的」都**必然落在 (anchor, anchor+24h]**
//     —— 同一本地时刻每 24 小时重复一次，而「最近的那个」按定义不超过一个周期。
//   ★ 这个上界**紧**：时区偏移范围 −12:00 … +14:00 = **26 小时 > 24 小时**
//     ⇒ 相位全覆盖 ⇒ 区间里几乎每个点都有某个偏移能取到，不可再收。
//     （遍历 15 分钟粒度的全部偏移，最晚候选距上界只差 14 分钟。）
//
//   🔴 **它不是「解出来再加一个常数」那种拍出来的余量。**
//     值只来自「一天 24 小时」；IANA 的 26 小时范围只用来证明「紧」，不参与算值
//     ⇒ IANA 改了，值不变，只是上界不那么紧了。
//
//   ⚠️ 不能写成「按 UTC−12 解」（那是「同一日期下最晚的偏移」）——
//     **它会错 16 小时**：取「锚点之后最近的那个」这条规则会跳日，
//     而 UTC−12 把本地 T 推得足够晚，**当天那个候选就已在锚点之后 ⇒ 它不跳日**，
//     反倒是别的偏移被迫跳到第二天。
//     ⇒ **「最晚的偏移」和「最晚的候选」不是同一个东西。**
//     两条各自正确的规则叠起来，合成的结果不是任何一条单独预测的那个。
const WORST_CASE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 某个 UTC 时刻，在指定 IANA 时区里的偏移（分钟，东为正）。
 *
 * ⚠️ 时区名不认识时**抛异常**，不返回 0 —— 「查不了」不许降级成一个具体答案。
 *   （跟 `check()` 里 `paneError` 那段同一个惯例。）
 */
/**
 * 把一个绝对时刻同时渲染成 **UTC ＋ 那个时区的当地时间**。
 *
 * ── 为什么两个都给，而不是只给当地 ─────────────────────────────────────
 *
 *   只写 UTC（形如 `…T19:10:00.000Z`）的话，人读到「19:10」，
 *   直觉是**当地的晚上 7 点** —— 而在 PDT（UTC−7）它其实是当地的**中午 12:10**。
 *   ⇒ 于是一条算得完全正确的告警，被读成了一个差 7 小时的时刻。
 *
 *   ⚠️ 而**不能只给当地**：日志、redis、`results/*.json` 里存的都是 UTC，
 *     只给当地会让人跟那些对不上账。**两个都给，而不是换一个。**
 *
 *   ★ 而当地时区取的是**那行字自己说的那个**（`resolved.tz`），不是这台机器的 ——
 *     问的是「**那个 agent** 什么时候恢复」，而不是「我这儿几点」。
 *     `tz` 为 null（worst_case 那一支）时退回机器本地，并且**照样标出时区名**。
 */
function atBoth(ms, tz) {
  const iso = new Date(ms).toISOString();
  try {
    const local = new Date(ms).toLocaleString('sv-SE', {
      timeZone: tz || undefined,
      timeZoneName: 'short',
    });
    return `${iso}（＝当地 ${local}）`;
  } catch (e) {
    // ⚠️ Intl 不认识那个 tz 名时**不要静默吞掉** —— 退回纯 UTC，而把原因带出去，
    //   否则「当地时间没出现」看起来像这个功能没做。
    return `${iso}（当地时间渲染失败：${tz} —— ${e.message}）`;
  }
}


function tzOffsetAt(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  const asIfUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second),
  );
  return (asIfUtc - ms) / 60000;
}

/** 把「某时区的本地年月日时分」换算成 UTC 毫秒。 */
function zonedToUtc(y, mo, d, hh, mm, tz, fixedOffsetMin) {
  const naive = Date.UTC(y, mo, d, hh, mm, 0, 0);
  if (typeof fixedOffsetMin === 'number') return naive - fixedOffsetMin * 60000;
  // ⚠️ 一次迭代：先用 naive 时刻问偏移，再回代。
  //   DST 切换那一小时会有 ±1 小时的残差 —— **已知限制，写在这里而不是假装没有**。
  //   对本档的用途（等一个重置时刻）晚一小时无害，早一小时才有害，
  //   而回代的方向使残差偏晚。⇒ 方向是安全的那一侧。
  const off1 = tzOffsetAt(naive, tz);
  return naive - off1 * 60000;
}


/**
 * 从 pane 文本里**只提取线索**：时刻的原始串 + 时区名。不算时刻。
 *
 * ── 🔴 时区**锚定到时刻所在的那一行** ──────────────────────────────────
 *
 *   不能 `paneText.match(IANA_TZ_RE)` —— **在整段 40 行上找，取第一个**。
 *   pane 里全是文件路径，`temp/outbox`、`bin/next` 的形状跟 IANA 名**一模一样**，
 *   第一个匹配多半是路径 → Intl 不认识 → **bad_tz**；
 *   而真时区名（如 `America/Los_Angeles`）就在时刻那一行，离时刻只有几个字符。
 *
 *   ⇒ 那样出口永远不生效：每次都 bad_tz、永远不唤醒。
 *     而告警说的是「它写的时区名我不认识」—— **把人指向「补时区表」，**
 *     **而真正要修的是「别在文件路径上找时区」。**
 *     ★ 一条正确的 fail-closed 策略，喂了一个错误的观测。
 *
 *   ── 为什么不用「遍历所有候选、取第一个 Intl 认得的」──────────────────
 *     那个方案很诱人，而且在常见样本上**会通过** —— 但它有害：
 *     pane 里若恰好出现一个**真实存在**的 IANA 名（路径里有 `Europe/London`、
 *     或者 agent 正在讨论时区），它会被**静默误用**，
 *     而方向是坏的那一侧：算出的时刻可能**更早** ⇒ 提前唤醒 ⇒ 再撞一次墙。
 *
 *   ⇒ 所以是**行锚定**：只在时刻那一行里找。别的行**结构上取不到**，
 *     不是「优先级低」，是「看不见」。
 *     同一行里有多个候选时，取**距时刻最近**的那个。
 *
 * @returns {{raw:string, tz:string|null}|{reason:'no_time'|'bad_tz'}}
 */
function extractResetHint(paneText) {
  if (typeof paneText !== 'string' || !paneText) return { reason: 'no_time' };

  // ── ① 时刻：拿**位置**，不只拿值 ────────────────────────────────
  //   ⚠️ 要 `index` —— 位置正是锚定的依据（下面切那一行要用）。
  //   而 `matchAll` 的每个 match 同样带 `index`，且它不污染 `lastIndex`。
  let raw = null;
  let at = -1;
  // ★ 带 `g` 的版本**在这里从源数组派生**，不放模块级常量 ——
  //   理由不是风格：`test/watchdog-rate-limit-act.test.js` 的判据把这个函数的
  //   **源码 eval 出来**单独跑，而模块级常量在那个作用域里不存在。
  //   ⇒ 而从源数组派生**顺带更强**：它不可能跟 `RESET_TIME_RE` 分叉。
  for (const re of RESET_TIME_RE.map((r) => new RegExp(r.source, r.flags + 'g'))) {
    const all = [...paneText.matchAll(re)];
    if (!all.length) continue;
    // 🔴 **取最后一个，不是第一个**
    //
    //   pane 里可能有好几行 `resets`：上面的是**更早那次的残留**，下面的才是这次的。
    //   取第一个匹配 ⇒ 按一个早就过去的时刻算恢复 ⇒ **叫不醒它**。
    //
    //   ★ 而「最后一个 = 最新的」这个前提写在这里：
    //     pane 是**终端输出，新的在下面**，而 peek 取的是**最后 40 行**
    //     ⇒ ⇒ 它在「pane 被清屏 / 环形缓冲区回绕」时不成立 —— 那一档没有判据守着。
    //
    //   ⚠️ 而 `matchAll` 不会污染 `lastIndex`（它内部克隆正则）。
    const m = all[all.length - 1];
    raw = m[1]; at = m.index; break;
  }
  if (!raw) return { reason: 'no_time' };

  // ── ② 切出时刻所在的那一行 ──────────────────────────────────────
  const lineStart = paneText.lastIndexOf('\n', at) + 1;
  const nl = paneText.indexOf('\n', at);
  const lineEnd = nl < 0 ? paneText.length : nl;
  const line = paneText.slice(lineStart, lineEnd);
  const tmInLine = at - lineStart;

  // ── ③ 只在这一行里找，而**候选不止一个时不猜** ────────────────────
  //
  //   🔴 **不按「距时刻最近」挑。** 那条规则的前提是「真时区名离时刻最近」——
  //     而那只是样本里观察到的规律，不是文案格式保证的。
  //     构造得出反例：`reset at 2:10pm (Asia/Tokyo) (America/Los_Angeles)` ⇒ 取到诱饵。
  //
  //   ★ 而否掉它的理由不是「可能取错」，是**取错的方向不对称**：
  //       取最近而取错 ⇒ 可能算出**更早**的时刻 ⇒ **提前唤醒 ⇒ 再撞一次墙**
  //                     —— 那正是上面「永动机」的入口，而这一整格建在「别再打开它」上
  //       拿不准就走上界 ⇒ **只会晚，不会早** ⇒ 最坏多等 24 小时，而现状是「永远」
  //   ⇒ 所以：**恰好一个**认得的候选才用它；两个或更多 ⇒ 不猜。
  const cands = [...line.matchAll(IANA_TZ_RE_G)].map((m) => m[0]);
  const known = cands.filter((v) => {
    try { tzOffsetAt(Date.now(), v); return true; } catch (_) { return false; }
  });

  if (known.length === 1) return { raw, tz: known[0] };

  // 🔴 同一行里两个或更多合法时区名 ⇒ **走上界**，不是 bad_tz。
  //   （bad_tz 的含义是「写了个读不懂的」，而这里**读得懂，只是不知道用哪个**。）
  if (known.length > 1) return { raw, tz: null };

  // 有形似候选但一个都不被 Intl 认识 ⇒ **这时** bad_tz 才是真话：
  //   「它写了个读不懂的时区」—— 行锚定保证了这句话不会指向文件路径。
  if (cands.length) return { reason: 'bad_tz' };

  // 这一行**没有**时区名 ⇒ tz: null ⇒ 上层走可推导的最坏上界。
  // ★ 这跟 bad_tz 是两件事，不许并档：bad_tz 说明对文案的理解有缺口，这里只是文案没写。
  return { raw, tz: null };
}

/**
 * 由线索 + 锚点算出重置时刻。
 *
 * @returns {{ok:true, at:number, tz:string|null, mode:'tz'|'worst_case', raw:string}}
 *        | {{ok:false, reason:'no_time'|'no_detected_at'|'bad_tz'}}
 */
function resolveResetAt(hint, detectedAtMs) {
  if (!hint || hint.reason) return { ok: false, reason: (hint && hint.reason) || 'no_time' };

  // ── 锚点：**detected_at，不是「现在」** ──────────────────────────────
  //   🔴 缺失时**不许拿 Date.now() 顶替**。那会让一个刚重启的 watchdog
  //     把所有重置时刻都算成「未来」⇒ **永远不 nudge，而它看起来在正常工作**。
  if (typeof detectedAtMs !== 'number' || !Number.isFinite(detectedAtMs)) {
    return { ok: false, reason: 'no_detected_at' };
  }

  const hm = String(hint.raw).match(/([0-9]{1,2}):([0-9]{2})\s*([ap])/i);
  if (!hm) return { ok: false, reason: 'no_time' };
  let hh = Number(hm[1]) % 12;
  if (hm[3].toLowerCase() === 'p') hh += 12;
  const mm = Number(hm[2]);
  if (!(hh >= 0 && hh < 24 && mm >= 0 && mm < 60)) return { ok: false, reason: 'no_time' };

  if (!hint.tz) {
    // 🔴 无时区名 ⇒ **证据不完整，不是没有证据**：已知重置在某个本地 T，
    //   只是不知道是哪个时区的 T ⇒ 取那个可推导的上界（见常量定义处）。
    //   它只会醒得**晚**，不会**早** nudge —— 而早 nudge 才是有害的那侧。
    //
    //   ⚠️ 这一档**没有真实样本**，是防御性的，判据只能用构造样本验。
    return {
      ok: true, at: detectedAtMs + WORST_CASE_WINDOW_MS, tz: null, mode: 'worst_case', raw: hint.raw,
    };
  }

  // ── 「今天还是明天」：**detected_at 之后最近的那个 T** ──────────────────
  //   理由不需要猜：限额提示是在**撞墙那一刻**打印的，
  //   而重置时刻**必然在打印时刻之后**。这是唯一自洽的解释。
  const anchor = new Date(detectedAtMs);
  const y = anchor.getUTCFullYear();
  const mo = anchor.getUTCMonth();
  const d = anchor.getUTCDate();
  for (let add = -1; add <= 2; add += 1) {
    const at = zonedToUtc(y, mo, d + add, hh, mm, hint.tz);
    if (at > detectedAtMs) return { ok: true, at, tz: hint.tz, mode: 'tz', raw: hint.raw };
  }
  // 走到这里说明四个候选日全在锚点之前 —— 理论上不可能，但**不猜**。
  return { ok: false, reason: 'no_time' };
}

/**
 * 解析「什么时候恢复」，**返回一个判得出档次的结构，不返回裸值**。
 *
 * ── 为什么不用 `null` 表示失败 ────────────────────────────────────────
 *   `null` 会让「没有限额提示」和「有提示但读不出时刻」共用一个字面值，
 *   而**其中一个是正常，另一个是故障**。调用方分不开 ⇒ 只能猜。
 *   ⇒ 一律返回对象，失败带 `reason`。
 *
 * ⚠️ 这是 `extractResetHint` + `resolveResetAt` 的组合，**给一次拿得到 pane
 *   又拿得到锚点的调用方用**（测试就是）。生产路径分两步走，见两个函数各自的注释。
 */
function parseResetTime(paneText, detectedAtMs) {
  return resolveResetAt(extractResetHint(paneText), detectedAtMs);
}


/**
 * ── StopFailure 信号**有没有效** ──────────────────────────────────────────
 *
 *   同时满足三条才算有效：
 *     ① 文件在、读得出来、`name` 跟文件名一致（`rlSignal.read()` 判）；
 *     ② `at` 在 `RL_STATE_TTL_SEC` 以内；
 *     ③ **agent 在 `at` 之后没有读过自己的队列**：`idleMs >= now - at`。
 *
 *   ③ 读不到 idle（`idleMs === null`）⇒ **按有效处理**，偏向不 nudge。两种来源都是这样：
 *     · `probe_error`（XINFO 失败）：「查不了」不许降级成「它读过了」—— 跟 `pane_error` 同一个惯例；
 *     · 组里一个消费者都没有：它**从来没读过**队列，当然也没在 `at` 之后读过。
 *
 *   ⚠️ ③ 不成立（`consumed`）是**唯一**删文件的理由（再加超 TTL）。**不许**挂在 act() 里
 *     「`level !== 'rate_limited'` 就清 `rl_since`」那句上：撞墙后的头几分钟花名册还没过期，
 *     那时它的级别是 `ok` —— 挂在那里的话，信号会在它最有用之前就被删掉。
 *
 * @returns {{valid:boolean, state:'absent'|'bad'|'expired'|'consumed'|'valid', at?:number, sig?:object}}
 */
function signalValidity(read, { now, idleMs, ttlMs = RL_STATE_TTL_SEC * 1000 }) {
  if (!read || read.state !== 'ok') return { valid: false, state: read && read.state === 'bad' ? 'bad' : 'absent' };
  const { sig } = read;
  if (now - sig.at > ttlMs) return { valid: false, state: 'expired', at: sig.at };
  if (idleMs !== null && idleMs !== undefined && !(idleMs >= now - sig.at)) {
    return { valid: false, state: 'consumed', at: sig.at };
  }
  return { valid: true, state: 'valid', at: sig.at, sig };
}

/**
 * 从三个观测量算出级别。**纯函数，抽出来是为了它能被测。**
 *
 * ── 为什么必须抽 ────────────────────────────────────────────────
 * 真实的 `idle` 由 redis 服务端计时，**测试造不出一个「20 分钟没读队列」的
 * 消费者** —— 要么等 20 分钟，要么让 check() 收一个假的 idle 源（那是为测试
 * 改生产代码的形状）。判定逻辑留在 check() 里 = **它没有防线**。
 *
 * 跟 `classifySessions` 抽出来是同一类理由：判定只放一处，而且要测得到。
 *
 * @param {number|null} minIdle      多久没发 XREADGROUP（null = 查不到消费者）
 * @param {number} outboxIdle        多久没有 outbox 活动（Infinity = 从来没有）
 * @param {string|null} probeError   查询本身失败了
 */
function levelFor({ minIdle, outboxIdle = Infinity, probeError = null, declaredBusy = false }) {
  if (probeError) return 'probe_failed';
  if (minIdle === null) return 'unknown';        // 从没读过，可能刚起
  if (minIdle >= NUDGE_MS) {
    // ── ★★ 第二条否决：**长任务自己申报了**（`lib/busy.js`）─────────────
    //
    //   下面那条 outbox 否决**对一整类情况无解**（它自己的注释写着）：
    //   跑单次长 Bash 调用的 agent **在调用期间没有执行权，写不了任何东西**。
    //   全量测试（`node test/run-all.js`）要跑几分钟，
    //   跟 NUDGE_MS 是同一个量级，**而测试规模还在涨**。
    //
    //   这一条走的是另一个信号源：**那个长任务的子进程自己写了标记，
    //   而且那个进程现在还活着**（判据是 `process.kill(pid,0)`，不是时间戳）。
    //   agent 没有执行权，但**它启动的子进程有**。
    //
    //   ⚠️ **它没有修好那个代理，是给代理开了一个显式的例外出口。**
    //   「没在读队列」代理「失聪」这件事本身还是错的 —— 别读成已经没问题了。
    //
    //   ⚠️ 放在 outbox 否决**之前**，因为它是更强的证据：
    //   outbox 说「几秒前有文件进出」（目录 mtime，relay 捡走也会更新，
    //   是个权宜信号）；这条说「**那个正在跑的进程此刻还活着**」。
    if (declaredBusy) return 'busy';
    // ── ★ outbox 否决：`idle` 大 + outbox 仍在动 = 忙，不是聋 ─────────
    //
    //   `idle` 是「多久没发 XREADGROUP」，而**一个正在专心干活的 agent，
    //   跟一个死了的 agent，都没在发 XREADGROUP** —— 这两态在队列侧同形。
    //
    //   一个 agent 连续干活 20 分钟（写测试 + 跑变异 + 真调模型）
    //   **就撞上 NUDGE_MS(1200s)**。那不是极端情况，是干一件正经活的常规时长。
    //   **对它发 ESC = 打断一个正在正常工作的 agent。**
    //
    //   ⚠️ **否决必须同时盖住 alert**，不能只盖 nudge：alert 的文案写着
    //   「已推送 ESC…此后仍无队列读取活动」—— 没推却这么说，
    //   就是把一个从未成立的因果写成观察结果。
    //
    //   ⚠️ `QUIET_MS(180s)` 是**擦边**的，不是宽松的：正常跑一次全量的静默期
    //   就在 180 秒上下。**调它之前先知道这个量级。**
    //   偏紧的方向在这里是对的 —— **误判「忙」只是不动作，误判「聋」是打断。**
    //
    //   ⚠️ 那个常量被**两处共用，而两处要的方向相反**：
    //     · `lib/shutdown.js`：多久没动静就**杀** → 偏紧 = 更容易误杀
    //     · 这里：            多久内有动静就**别动** → 偏紧 = 更容易放过
    //   **改它的人会同时改变两处的行为。**
    //
    // ── ★★ 这条否决的真实边界，以及**不许怎么改** ──────────────────
    //
    //   它只保护**能**周期性写 outbox 的 agent。而有一类根本做不到：
    //   **跑单次长 Bash 调用的**（比如一次 `run-all.js`）——
    //   **调用期间 agent 没有执行权，写不了任何东西。**
    //
    //   > **那不是纪律问题，是机制问题。** 说成「它们不守协议第 1 条」会把人
    //   > 引向「提醒它们报进度」，而那是白费 —— **对这一类，outbox 判据无解，
    //   > 不是覆盖不全。**「无解」和「覆盖不全」在报告上差一个词，在待办上差一整件事。
    //
    //   ⚠️⚠️ **所以不要把这个否决「加强」成「静默就一定该 nudge」** ——
    //   那正好会把跑长调用的 agent 全部误伤，**而它们恰恰是最不该被打断的那批**
    //   （被打断的是一次没法断点续传的长任务）。
    //   **这里只做到「有活动证据就别动」，是有意停在这一步的，不是没写完。**
    if (outboxIdle < shutdown.QUIET_MS) return 'busy';
    return minIdle >= ALERT_MS ? 'alert' : 'nudge';
  }
  if (minIdle >= WARN_MS) return 'warn';
  return 'ok';
}

// ══ 孤儿 PEL 扫描：第四个枚举源 ═══════════════════════════════════
//
// ── 洞在哪 ────────────────────────────────────────────────────────
// 重投靠 `bin/next.js` 的 `q.autoclaim`，而它挂在「**有人在跑 poller**」上 ——
// 掉册的那个恰恰不跑了。于是被领走、进 PEL、没 ack 的消息停在那儿，
// **没有出口，也没有声音**：一条消息可以卡上好几天，
// 只有人手动 `XPENDING` 才撞得见，系统里没有任何东西会报它。
//
// ── ★ 为什么它必须是**第三个**枚举源，而不是往现有三格里补一个判据 ──
// `check()` 的另外两个枚举源是 `roster.list()` 和 `tmuxApi.list()`。
// 三格全部建立在这两个集合的交叉上：
//     deaf/rate_limited/heartbeat_lost  会话**在** + 不在册
//     stale                             在册 + 会话不在
//     live                              在册
// **一个掉册且会话也没了的 agent，在这两个集合里都不存在** ——
// 它已经不是一个「agent」了，只剩一条流。
// ⇒ 不是判据漏了它，是**它从来没进过视野**。所以枚举源必须是 redis 里的流本身。
//
// ── 🔴 一条走不通的路 ──────────────────────────────────────────────
// `engloop:dropouts`（`roster.js` 的 DROPOUT_KEY）看起来是现成的名字出处 —— **它不是。**
// `noteDropout` 生产上唯一的调用点在 `rebuild()` 里，也就是**自愈成功那一刻**。
//
// > **dropouts 记的是「掉册**又活过来**」，孤儿 PEL 的定义是「掉册**没活过来**」。**
// > **两个集合几乎不相交 —— 拿它当出处，会系统性地漏掉最该报的那一类。**
// （一个死掉的 agent 出现在 dropouts 里，只可能是它死前曾经掉册自愈过 —— 那是偶然。）
const ORPHAN_STREAM_MATCH = 'agent:*:in';

// ── 冷却期取 6 小时，比 COOLDOWN_SEC(594s) 长得多，理由 ──────────────
// 别的档冷却期短，是因为它们报的是**正在恶化**的状态（失聪、卡死），
// 早一轮报早一轮救。这一档相反：**消息已经卡了好几天，它不会自己好，也不会更坏。**
// ⇒ 及时性在这里没有价值，而刷屏有代价：594s 冷却 = 一天 145 条，
//   「一条卡住的消息每一轮都被扫到、每一轮都报」正是要防的。
// 6 小时 = 一天 4 条：一个工作日内一定看得见，又不会淹掉别的告警。
const ORPHAN_COOLDOWN_SEC = 6 * 3600;

/**
 * 流名 → agent 名。**必须与 `roster.inboxFor()` 互逆**，跟
 * `sessionToName` / `roster.sessionFor()` 那一对是同一种关系 ——
 * 守法同样是往返断言（见 test/watchdog-orphan-pel.test.js），不是靠人记得同步改。
 *
 * ⚠️ 只认 agent 的形状。编排者的收件流是 `orch:in:agent`，**扫不到也不该扫到**：
 *   它在册、PEL 经常非空（那是它正在处理的消息），按同一套判据过一遍
 *   会周期性地报一个正在干活的编排者。
 */
function streamToName(stream) {
  const m = /^agent:(.+):in$/.exec(stream);
  return m ? m[1] : null;
}

/** 游标循环到 `'0'` —— `SCAN` 只保证「一直存在的 key 一定被扫到」，一次拿不全。 */
async function scanAll(redis, match) {
  const out = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 100);
    cursor = next;
    out.push(...keys);
  } while (cursor !== '0');
  return out;
}

/**
 * 一个组的 PEL 概况 + **最老那一条**的两个时间量。
 *
 * ── ★ 为什么两个时间量都要，而不是选一个 ────────────────────────
 *     `age`   = now − (stream ID 前半段)  「这条消息**等了多久**」
 *     `idle`  = XPENDING 详细形式的 IDLE  「距**上次投递**多久」
 * 它们回答的不是同一个问题：人判断「这条还要不要」看 age，
 * 判断「autoclaim 动没动过它」看 idle。
 *
 * ⚠️ 只投递过一次的消息上**两个数恰好相等** ——
 *   正是这种「恰好相等」会让人把它们当成一个数，
 *   等到分叉那天才发现报的是另一个。算两个的成本接近零，就不做这个取舍。
 *
 * NOGROUP / no such key 当 0 处理 —— 照 `consumerIdle()` 的先例，
 * 那是「还没开始」的正常状态，不是故障。
 */
async function oldestPending(redis, stream, group, now) {
  let summary;
  try {
    summary = await redis.xpending(stream, group);
  } catch (err) {
    const m = String(err.message);
    if (m.includes('NOGROUP') || m.includes('no such key')) return { pending: 0 };
    throw err;
  }
  const pending = Number((summary && summary[0]) || 0);
  if (!pending) return { pending: 0 };

  // 详细形式取最老的一条：XPENDING 按 ID 升序返回，第一条就是最老的。
  const rows = await redis.xpending(stream, group, '-', '+', 1);
  const row = rows && rows[0];
  if (!row) return { pending };          // 概况说有、明细拿不到：报条数，时间量留空
  const [id, consumer, idle, delivered] = row;
  const bornMs = Number(String(id).split('-')[0]);
  return {
    pending,
    oldestId: String(id),
    oldestConsumer: consumer == null ? null : String(consumer),
    oldestIdleMs: Number(idle),
    oldestDelivered: Number(delivered),
    // ID 前半段是 XADD 时刻的毫秒数 —— 服务端事实，不是推算。
    oldestAgeMs: Number.isFinite(bornMs) ? now - bornMs : null,
  };
}

/**
 * 扫出「不在花名册、但收件流 PEL 非空」的流。
 *
 * ★ 三个否决，缺一条就是误报：
 *   ① **在册的跳过** —— 在册 agent 的 PEL 经常非空（那是它**正在处理**的消息）。
 *      「PEL 非空」单独**不是**告警条件，必须叠加「不在册」。
 *      健康系统里在册 agent 的 PEL 常有 1~2 条在波动，
 *      只看 PEL 的话这个告警上线第一分钟就开始对健康系统刷屏。
 *   ② **PEL 为 0 的跳过** —— 「不在册 + PEL 空」的流（agent 走了、消息都处理完了）
 *      是天然的阴性对照：误报的话它们先叫。
 *   ③ **会话还在的跳过** —— 那批已经被 deaf/heartbeat_lost/rate_limited 覆盖。
 *      **同一个 name 不许同时产出两条 finding**：两条告警说同一件事而处置相反
 *      （deaf 要去 nudge，这一档没有可 nudge 的对象），人会照后看到的那条动手。
 *      去重按 **name** 而不是按流名 —— 流名相同 name 一定相同，反之不然。
 *
 * ★ 「查不了」不许降级成「都正常」（跟 `probe_error` / `pane_error` 同一个惯例）：
 *   · `SCAN` 整个失败      → 一条 `orphan_probe_failed`，**不是**「没有孤儿」
 *   · 单个流 `XPENDING` 失败 → 那个流一条 `orphan_probe_failed`，**其余流照常判定**
 *   · `WRONGTYPE`          → 这是个**确定的答案**（这个 key 不是流），不是「查不了」，
 *     跳过并记进 `skipped`。⚠️ 但它必须**活下来**：`roster.js` 的 DROPOUT_KEY 注释
 *     写着一个 list 混进 `engloop:roster:*` 时，`GET` 撞 WRONGTYPE
 *     **会把整个花名册查询打崩**（花名册崩 = 所有消息路由失效）。`agent:*:in` 同形。
 *
 * ★ `skipped` 跟着返回值出去而不是丢掉：**「扫过了、判它不该报」和「压根没扫到它」
 *   在一个只报 findings 的接口里长得一模一样。**
 */
async function findOrphanPels(redis, { registeredNames, coveredNames, now }) {
  const skipped = [];
  let streams;
  try {
    streams = await scanAll(redis, ORPHAN_STREAM_MATCH);
  } catch (err) {
    return {
      found: [{
        name: 'watchdog', type: 'system', tmux_session: null,
        stream: null, group: null, idleMs: null, pending: 0,
        level: 'orphan_probe_failed',
        probe_error: `SCAN ${ORPHAN_STREAM_MATCH}: ${err.message}`,
      }],
      skipped,
    };
  }

  const found = [];
  for (const stream of streams.sort()) {
    const name = streamToName(stream);
    if (!name) { skipped.push({ stream, why: 'name_unparsable' }); continue; }
    if (registeredNames.has(name)) { skipped.push({ stream, name, why: 'in_roster' }); continue; }
    if (coveredNames.has(name)) { skipped.push({ stream, name, why: 'session_grid' }); continue; }

    // ── ★ 组从 `XINFO GROUPS` 拿，**不是**用 `roster.groupFor()` 推 ────────
    //
    // 用 `groupFor` 推，防得住「组名拼错 → 查一个没人读过的组 → PEL 永远是 0」，
    // **但防不住另一个成因**：
    //
    //     防得住     组名**拼错**            → 查了个不存在的组 → 漏报
    //     防不住     组名**对，但不止一个**  → 查了其中一个     → 漏掉另一个组的 PEL
    //
    // 两个成因，**同一个后果：静默漏报**。而「一流多组」不是假想 ——
    // `orch:in:agent` 上就挂着两个组（`bus-agent-in` 和 `orch`），各自 pending 独立。
    // agent 流现在恰好每条一个组，但这不是任何东西保证的。
    //
    // > **一个用来消灭静默失败的功能，自己内部不能留一处静默失败。**
    //
    // `XINFO GROUPS` 不比推贵，而且**不依赖反推的正确性**。
    // （反推仍然要用，但只用来判「在册」—— 那是 agent 维度的问题，不是流维度的。）
    let groups;
    try {
      groups = await redis.xinfo('GROUPS', stream);
    } catch (err) {
      const m = String(err.message);
      // WRONGTYPE = 这个 key 不是流。这是个**确定的答案**，不是「查不了」。
      if (m.includes('WRONGTYPE')) { skipped.push({ stream, name, why: 'not_a_stream' }); continue; }
      // 流在 SCAN 之后、这一句之前被删掉了 —— 同样是确定的答案。
      if (m.includes('no such key')) { skipped.push({ stream, name, why: 'stream_gone' }); continue; }
      found.push({
        name, type: 'unknown', tmux_session: null, stream, group: null,
        idleMs: null, pending: 0, level: 'orphan_probe_failed',
        probe_error: `XINFO GROUPS ${stream}: ${m}`,
      });
      continue;
    }
    // 没有任何组 = 从没人读过这条流。不报，也不抛。
    if (!groups || !groups.length) { skipped.push({ stream, name, why: 'no_group' }); continue; }

    const perGroup = [];
    let probeError = null;
    for (const g of groups) {
      const gi = {};
      for (let i = 0; i < g.length; i += 2) gi[g[i]] = g[i + 1];
      const gname = String(gi.name);
      // XINFO GROUPS 已经带了 pending，先用它挡掉空组，省一次 XPENDING。
      if (!Number(gi.pending || 0)) { skipped.push({ stream, name, group: gname, why: 'pel_empty' }); continue; }
      try {
        const info = await oldestPending(redis, stream, gname, now);
        if (!info.pending) { skipped.push({ stream, name, group: gname, why: 'pel_empty' }); continue; }
        perGroup.push({ group: gname, ...info });
      } catch (err) {
        // 单个组查不了不能拖垮这条流的其余组，更不能拖垮整轮。
        probeError = `XPENDING ${stream} ${gname}: ${err.message}`;
      }
    }

    // ★ 一条流**最多产出一条 finding**，即使多个组都卡着 ——
    //   「同一个 name 不同时产出两条」。两条告警说同一个 agent 的同一件事，
    //   人会照后看到的那条动手。⇒ 主报最老的那一条，其余组挂在 `groups[]` 里。
    if (!perGroup.length) {
      // 一条组都没查成，而且确实有查询失败 → 这时候才报「查不了」。
      // **「查不了」跟「查了没事」必须分得开**，但也不能盖过一个确定的滞留事实。
      if (probeError) {
        found.push({
          name, type: 'unknown', tmux_session: null, stream, group: null,
          idleMs: null, pending: 0, level: 'orphan_probe_failed', probe_error: probeError,
        });
      }
      continue;
    }

    // 最老的那条所在的组当主报 —— 「滞留多久」取**消息年龄**（`oldest_age_ms`）。
    perGroup.sort((a, b) => (b.oldestAgeMs ?? -1) - (a.oldestAgeMs ?? -1));
    const top = perGroup[0];
    found.push({
      name, type: 'unknown', tmux_session: null,
      stream,
      group: top.group,
      // `idleMs` 借用既有字段名，值是**最老那条的 idle** —— 让 emit() 的
      // `idle_ms` 和 /api/agents 的 `idle_ms` 不用为这一档开特例。
      // ⚠️ 它**不是**告警文本里那个「滞留多久」（那个是 oldest_age_ms）。
      idleMs: top.oldestIdleMs ?? null,
      // 各组之和 = 「这条流一共卡了几条」。单组时跟该组条数相同。
      pending: perGroup.reduce((s, g) => s + g.pending, 0),
      groups: perGroup.map((g) => ({
        group: g.group,
        pending: g.pending,
        oldest_id: g.oldestId || null,
        oldest_consumer: g.oldestConsumer || null,
        oldest_age_ms: g.oldestAgeMs ?? null,
        oldest_idle_ms: g.oldestIdleMs ?? null,
        oldest_delivered: g.oldestDelivered ?? null,
      })),
      oldest_id: top.oldestId || null,
      oldest_consumer: top.oldestConsumer || null,
      oldest_age_ms: top.oldestAgeMs ?? null,
      oldest_idle_ms: top.oldestIdleMs ?? null,
      oldest_delivered: top.oldestDelivered ?? null,
      // 有组查不了、但别的组查出了滞留：**两个事实一起带出去**，
      // 不让「查不了」被一个成立的告警盖掉。
      probe_error: probeError || undefined,
      level: 'orphan_pel',
    });
  }
  return { found, skipped };
}

async function check(redis, {
  now = Date.now(), tmuxApi = tmux, outboxRoot = OUTBOX_ROOT, busyRoot = busy.BUSY_ROOT,
  // ★ 撞限额信号目录。默认 `rlSignal.signalsDir()`（`ENGLOOP_SIGNALS_DIR` 或 temp/signals/）。测试传临时目录。
  signalsDir = rlSignal.signalsDir(),
} = {}) {
  const agents = await roster.list(redis);
  const allSessions = await tmuxApi.list();

  // ★ 三格判定**只有一份实现**，就是 classifySessions()（页面也用它）。
  //   check() 不许再跑一套平行逻辑：两份平行代码此刻行为一致，所以任何测试都不会红；
  //   它们分叉的那天也不会红，因为各自都「正常工作」。
  const { deaf, stale, live } = classifySessions(agents, allSessions);
  const out = [];
  // ★ 「agent 在 `at` 之后读过队列」的那些信号 —— **只收集，不在这里删**。
  //   check() 也被 `GET /api/agents` 调；一次 GET 不该有删文件的副作用。删在 `sweepSignals()`（start() 的 tick 里）。
  const consumedSignals = [];
  const signalFor = (name, idleMs) => {
    const v = signalValidity(rlSignal.read(name, { dir: signalsDir }), { now, idleMs });
    if (v.state === 'consumed') consumedSignals.push({ name, at: v.at });
    return v;
  };

  // ★ N=0 是 watchdog 对**自己**的判定 —— 放进 findings，act() 才会报它。
  //   （`sessionsSeen` 那个事实同时随返回值出去给 /api/agents 用。）
  if (allSessions.length === 0) {
    out.push({
      name: 'watchdog', type: 'system', tmux_session: null,
      idleMs: null, pending: 0, sessionsSeen: 0,
      level: 'zero_sessions',
    });
  }

  // ── ★ deaf 候选也要查 idle，**不能只用集合差** ──────────────────
  //
  // 不在册的 agent 也查得到流名：inboxFor/groupFor 收口在 roster 之后，
  // 从会话名反推 agent 名，再按约定推出流名和组名，完全推得出来。
  // （收口的理由是防静默分叉，**这个能力是顺带的**。）
  //
  // 为什么必须查：**「会话在 + 不在花名册」把「正在轮询但心跳丢了」也算进来了。**
  // 那种 agent 的 poller 返回的是正常的 `{"timeout":true}`（594s 阻塞走完），
  // **一直在轮询**，只是心跳因为异常被吞掉而没写进去 —— 判成 deaf 就是误判。
  //
  // ⚠️ 判据不是「idle 大 / 小」：
  //   **阻塞期间 idle 照常增长**，594s 走完时接近 594000。
  //   真正的区别是**周期性**：在轮询的 agent，idle 每轮重置；失聪的单调增长。
  //   所以阈值取 WARN_MS(900s) = 594s 阻塞 + 306s 余量。
  for (const d of deaf) {
    // 按约定推出它的流和组。type 只有 'orchestrator' / 'unknown' 两种，
    // 而 groupFor/inboxFor 对非 orchestrator 一律同样处理，所以推得准。
    const group = roster.groupFor(d.name, d.type);
    const stream = roster.inboxFor(d.name, d.type);

    let consumers = [];
    let probeError = null;
    try {
      consumers = await consumerIdle(redis, stream, group);
    } catch (err) {
      probeError = String(err.message);
    }
    const minIdle = consumers.length
      ? Math.min(...consumers.map((c) => c.idleMs))
      : null;

    // 查不到消费者 = 它连流都没在读 → 真失聪（这是最强的失聪证据）
    const stillPolling = minIdle !== null && minIdle < WARN_MS;

    // ★ 第二格不叫 deaf，因为**它不是失聪**。
    //   nudge 对它无害但无用，而**把它算成失聪会掩盖真正的问题**：
    //   心跳为什么没写进去。名字不同，act() 才可能对它做不同的事。
    let level = stillPolling ? 'heartbeat_lost' : 'deaf';

    // ── ★★ 第四档 `rate_limited` ──────────────────────────────────────
    //
    //   **只在原本要判 deaf 的那一格上查**，两个理由：
    //   ① 语义：撞限额的 agent 执行不了工具调用 ⇒ poller 起不来 ⇒ 消费者 idle
    //      单调增长 ⇒ 它必然落在「不在册 + 不在读队列」这一格，
    //      **而 `heartbeat_lost` 那格按定义还在读队列**，不可能是限额。
    //   ② 成本：deaf 是少数，不必给每个健康 agent 都跑一次 capture-pane。
    let paneError;
    let rateLimitHint;
    let rateLimitSource;
    let signalAt;
    // ★ 撞限额信号对**每个** deaf 候选都读（含 heartbeat_lost）—— 判级只用在 deaf 那一支，
    //   但「读过队列 ⇒ 这次撞墙过去了 ⇒ 删」对仍在读队列的 heartbeat_lost 同样成立。
    const signal = signalFor(d.name, minIdle);
    if (level === 'deaf') {
      let paneRateLimited = false;
      try {
        const pane = await tmuxApi.peek(d.tmux_session, RATE_LIMIT_PEEK_LINES);
        if (looksRateLimited(pane)) {
          paneRateLimited = true;
          level = 'rate_limited';
          // ★ 线索在**观测层**提取，因为只有这里手上有 pane；算时刻要 redis
          //   里的 detected_at，那在 act()。⇒ 观测层提线索，处置层算时刻。
          //
          // 🔴 **只带 { raw, tz } 两个短串，不带 pane 全文。**
          //   finding 会进 /api/agents 的 payload 再进浏览器 ——
          //   把整段 pane 塞进去 = 把限额文案发给每一个看页面的人，
          //   而那正是这一格自己在防的污染（同一个理由，换了个出口）。
          rateLimitHint = extractResetHint(pane);
        }
      } catch (err) {
        // 🔴🔴 **「读不到 pane」绝不等于「没有限额提示」。**
        //
        //   这是这一格里最容易被写反的一行：`catch` 里什么都不做的话，
        //   level 静静地留在 `deaf` 上，于是**一次 capture-pane 失败就把
        //   rate_limited 降级回 deaf，然后 act() 去 nudge** ——
        //   那正是 nudge 加速消耗限额的那条路，原封不动。
        //
        //   ⇒ 把失败**记成一个事实带出去**，由 act() 的 deaf 分支拦住 nudge。
        //   （和 `probe_error` 同一个惯例：**「查不了」不许降级成一个具体答案**
        //     —— 这句话 fanOutRoom 那边的 `routable === null` 也写着。）
        paneError = String(err.message);
      }

      // ── ★ StopFailure 信号 = 第二个证据 ─────────────────────────────────────────
      //   pane 读得到且有限额文案      ⇒ rate_limited（信号有效时来源记成 both）
      //   pane 读不到（pane_error）    ⇒ 信号有效 ⇒ rate_limited
      //   pane 读得到、但没有限额文案   ⇒ 信号有效 ⇒ rate_limited
      //   信号无效或没有               ⇒ 只看 pane
      //   🔴 第三行的代价：信号若来自一次**短时 429**，这个会话不会被 nudge，而是走
      //     「算不出恢复时刻」那条告警交给人 —— 有意的取舍，偏向不 nudge。
      //   ⚠️ 只加一个证据来源：`looksRateLimited` / `extractResetHint` / `resolveResetAt` 的判据一个字不动；
      //     也**没有**任何「看到信号就唤醒 / nudge」的路径 —— 唤醒仍只走 act() 里那一套。
      if (paneRateLimited || signal.valid) {
        level = 'rate_limited';
        rateLimitSource = paneRateLimited && signal.valid ? 'both' : (paneRateLimited ? 'pane' : 'hook');
        if (signal.valid) {
          signalAt = signal.at;
          // 恢复时刻的线索：pane 的优先；pane 没有线索或读不到 ⇒ 从信号的原文尾巴里抓。
          //   两个都拿不到 ⇒ 保留 pane 那份失败理由（有的话）⇒ act() 走 fail-closed 告警。
          if (!rateLimitHint || rateLimitHint.reason) {
            const fromSignal = extractResetHint(signal.sig.message_tail);
            if (!fromSignal.reason || !rateLimitHint) rateLimitHint = fromSignal;
          }
        }
      }
    }

    out.push({
      ...d,
      stream,
      group,
      idleMs: minIdle,
      pending: consumers.reduce((s, c) => s + c.pending, 0),
      probe_error: probeError || undefined,
      // ★ 进 findings 而不是只在 act() 里现查 —— 跟 outboxIdleMs / busy_reason
      //   同一个理由：**一个只在动手那一刻才算的值，人永远看不到它，
      //   也就没法判断动手对不对。**
      pane_error: paneError || undefined,
      // ★ 跟 pane_error 同一个惯例：**一个只在动手那一刻才算的值，人永远看不到它。**
      //   🔴 而这里**只带 { raw, tz } 两个短串，不带 pane 全文** ——
      //   finding 会进 /api/agents 的 payload 再进浏览器，
      //   把整段 pane 塞进去 = 把限额文案发给每一个看页面的人。
      rate_limit_hint: rateLimitHint || undefined,
      // ★ 凭什么判的 —— 'pane' | 'hook' | 'both'。只有 rate_limited 才有。
      rate_limit_source: rateLimitSource,
      // ★ 信号的 `at`（一个数）—— act() 第一次写 `rl_since` 时用 min(它, now) 当锚点。
      //   🔴 **不带 `message_tail`**：理由跟上面 rate_limit_hint 那段一样 —— finding 会推到浏览器。
      rate_limit_signal_at: signalAt,
      level,
    });
  }

  for (const a of stale) {
    out.push({
      name: a.name, type: a.type, stream: a.stream,
      tmux_session: a.tmux_session, idleMs: null, pending: 0,
      level: 'stale',
    });
  }

  for (const a of live) {
    // 组名走 roster.groupFor —— 唯一出处。这里自己拼的话，跟 serve.js 的
    // syncRelays 分叉时**不会有任何东西变红**：两边各自「正常工作」，
    // 而后果是 idle 查不到消费者 → 失聪检测自己失聪。
    const group = roster.groupFor(a.name, a.type);

    // 单个 agent 查询失败不能拖垮整轮检查 —— watchdog 是最后一道防线，
    // 它自己挂掉就没人看着了。比如某个流被删掉时，不接住的话整个 check 抛异常。
    let consumers = [];
    let probeError = null;
    try {
      consumers = await consumerIdle(redis, a.stream, group);
    } catch (err) {
      probeError = String(err.message);
    }

    // 取该组里最活跃的那个消费者 —— 只要有一个在动，这个 agent 就没聋
    const minIdle = consumers.length
      ? Math.min(...consumers.map((c) => c.idleMs))
      : null;

    // ★ 在册的 agent 不按信号判级（信号只作用在 deaf 那一支），只看「它在 `at` 之后读过队列没有」——
    //   🔴 「刚撞墙、花名册还没过期 ⇒ 级别 ok」那几分钟里，它**没**读过队列 ⇒ 信号留着。
    signalFor(a.name, minIdle);
    const outIdle = outboxIdleMs(a.name, { root: outboxRoot, now });
    // ★ 长任务申报（lib/busy.js）。查不了当成「没申报」—— 那只是失去一层
    //   保护，退回只看 outbox 的判定；当成「申报了」才危险（会让所有 agent 免疫）。
    const busyRec = busy.check(a.name, { root: busyRoot, now });
    const level = levelFor({
      minIdle, outboxIdle: outIdle, probeError, declaredBusy: busyRec.busy,
    });

    out.push({
      name: a.name,
      type: a.type,
      stream: a.stream,
      group,
      tmux_session: a.tmux_session,
      idleMs: minIdle,
      // ★ 进 findings 而不是在 nudge 分支现查 —— 它也要出现在 /api/agents 上。
      //   **一个只在动手那一刻才算的值，人永远看不到它，也就没法判断动手对不对。**
      outboxIdleMs: outIdle,
      // ★ 跟 outboxIdleMs 同一个理由：**一个只在动手那一刻才算的值，
      //   人永远看不到它，也就没法判断动手对不对。**
      //   `busy_reason` 尤其要带：`no_marker`（没申报）和 `pid_gone`
      //   （申报过但那个进程死了）是两种完全不同的情况，都会让结果是「不忙」。
      declaredBusy: busyRec.busy,
      busy_reason: busyRec.reason,
      busy_what: busyRec.record ? busyRec.record.what : undefined,
      pending: consumers.reduce((s, c) => s + c.pending, 0),
      level,
      probe_error: probeError || undefined,
    });
  }
  // ── 第四个枚举源：redis 里的流本身 ──────────────────────────────
  //
  // ★ 放在最后，因为它要拿前面三格的结果做去重（`coveredNames`）——
  //   顺序不是风格，是依赖。
  //
  // ⚠️ `coveredNames` 只取 `deaf`：另外两格（stale / live）按定义都**在册**，
  //   已经被 `registeredNames` 挡在前面了。多加它们不会更安全，只会让
  //   「为什么是这三个集合」这个问题变得没有答案。
  const registeredNames = new Set(agents.map((a) => a.name));
  const coveredNames = new Set(deaf.map((d) => d.name));
  const orphan = await findOrphanPels(redis, { registeredNames, coveredNames, now });
  out.push(...orphan.found);

  // ★ 返回值是 `{ findings, sessionsSeen, … }`，不是裸数组。
  //   裸数组装不下「本轮枚举到几个会话」这个事实，而那正是**判断 watchdog
  //   自己有没有在工作的唯一依据**。
  //   **一个装不下事实的返回类型，等于提前决定了那件事不会被说出来。**
  //
  // ★ `orphanSkipped` 是同一个理由：**「扫过了、判它不该报」和
  //   「压根没扫到它」在一个只报 findings 的接口里长得一模一样。**
  // ★ `signalSweep` 交给 `sweepSignals()`（start() 的 tick 在 act() 之后调）。
  return {
    findings: out, sessionsSeen: allSessions.length, orphanSkipped: orphan.skipped,
    signalSweep: { consumed: consumedSignals, dir: signalsDir },
  };
}

/**
 * ★ 删撞限额信号文件。**只有两种情况**：
 *   ① check() 判成 `consumed` 的（agent 在 `at` 之后读过队列）—— 删之前再比一次 `at`；
 *   ② 超过 `RL_STATE_TTL_SEC` 的，顺手删。
 *   🔴 **跟 level 无关**。不许改成「不是 rate_limited 就删」（见 signalValidity 头注）。
 */
function sweepSignals({ consumed = [], dir = rlSignal.signalsDir() } = {}, { now = Date.now() } = {}) {
  return rlSignal.sweep({ consumed, dir, now, ttlMs: RL_STATE_TTL_SEC * 1000 });
}

// 失聪时发给 agent 的话。**必须是可直接执行的一句**，不是「你好像卡住了」——
// 收到它的 agent 需要的是下一步动作，不是一个诊断。
const DEAF_NUDGE_TEXT = '你的轮询停了，花名册里已经没有你。立刻前台重新运行 poller（node bin/next.js …，Bash timeout 设 600000）恢复收发，然后报告你停摆期间有没有丢掉没发出去的东西。';

/**
 * 失聪时**发给人**的告警。按 type 分两套 —— **它们对人的含义完全不同。**
 *
 * ── ★★ 为什么编排者那一套必须单独写 ─────────────────────────────
 * **编排者失聪是这个系统里唯一一种「没有任何人能发现」的故障**，
 * 而原因是一条闭合的链：
 *
 * > **JARVIS 失聪 → 网页没有新消息 → 而「没有新消息」跟「大家都没事所以
 * > 没话说」长得一模一样。而唯一的发现者（人）恰好是通过它才能看到东西的。**
 *
 * 所以这条告警的**全部价值在于打破那个同形** ——
 * 它是「**有新东西出现**」，而失聪的表现是「没有东西出现」。
 * 一条主动推过来的消息本身就证明了「安静不等于没事」。
 *
 * ⚠️ 这条推得到人，**因为它不经过编排者**：`q.send(redis, 'orch:out', …)`
 *   由 bus 的 `deliverLoop` 消费并 broadcast 到 WS，而 bus 是独立进程。
 *   **这一点是整个方案成立的前提** —— 换一条要经过编排者的通路就白搭了。
 *
 * ── ⚠️ agent 那套的最后一句对编排者不成立 ─────────────────────────
 * agent 那套说「发给它的消息会被当成『发给人』投进 orch:out，
 * 可能出现在你这里」。**那对 agent 成立，对编排者是错的**：
 * 人发给编排者的消息进 `orch:in:human`，**没有人消费，不会出现在 orch:out**。
 * 照着那句话找，人会去一个不会有东西的地方等。
 *
 * ★ 两套都以「下一步做什么」收尾，不是以诊断收尾。
 */
function deafAlertText(f) {
  if (f.type === 'orchestrator') {
    return `⚠️ **编排者 ${f.name} 失聪了 —— 你现在看到的安静是假的。**\n`
         + `它的会话 ${f.tmux_session} 还在，但已不在花名册，而且确实不在读队列。\n`
         + '**这不是「大家都没事所以没话说」** —— 页面上没有新消息，'
         + '恰恰是因为那个负责说话的进程停了。'
         + '**这两种情况在网页上长得一模一样，而你是唯一能分辨它们的人**（这条消息就是分辨依据）。\n'
         + '**你发给它的消息没有丢** —— 它们堆在 orch:in:human 里等着，'
         + '但在它恢复之前没有人会读，所以也不会有任何回应。\n'
         + '已向它的会话发送恢复指令（消息，非 ESC）。\n'
         + '**下一步**：先确认会话还在（`tmux has-session -t orch`）；'
         + '一两分钟内仍无回音就重启它 ——\n'
         + '`node bin/orch-start.js --stop && node bin/orch-start.js`';
  }
  return `⚠ ${f.name} 的会话 ${f.tmux_session} 还在，但它已不在花名册 ——`
       + ' 说明它的轮询停了（不轮询就不刷心跳，900 秒后掉册）。'
       + ' 已向该会话发送恢复指令（消息，非 ESC）。'
       + ' 此期间发给它的消息会被当成「发给人」投进 orch:out，可能出现在你这里。'
       + ` **下一步**：等一轮（约 ${Math.round(COOLDOWN_SEC / 60)} 分钟）看它回不回来；`
       + ` 不回来就重启：\`node bin/agent-start.js --stop ${f.name}`
       + ` && node bin/agent-start.js --name ${f.name}\``
       // DUR1 S3：`--resume` 是 opt-in —— 文案只给出写法，不替人选（接不回时 agent-start 自己会警告、退回全新会话）。
       + `（想接回它重启前的上下文：第二条末尾加 \`--resume\`）`;
}

/** 人读的时长。**取到「天/小时」就停** —— 一条卡了几天的消息，秒数不改变任何决定。 */
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分钟`;
  return `${s} 秒`;
}

/**
 * 孤儿 PEL 告警。
 *
 * ★ **必须能直接定位：哪个流 · 几条 · 最老的一条滞留多久。**
 *   只说「有滞留」的话，人还得自己去敲 `XPENDING` —— 那这个告警只省了
 *   「发现」这一步，没省「定位」那一步 —— 而耗时间的往往正是定位。
 *
 * ★ 结尾给的是**只读**命令，而且明说「watchdog 只报不动」——
 *   照 `deafAlertText` 的规矩：以「下一步做什么」收尾，不以诊断收尾。
 *   ⚠️ 但**不给** `XACK` / `XCLAIM` 的命令：处置不唯一（有的该重做、有的早已过期该丢），
 *   而一条现成的命令会让「先看内容再决定」那一步被跳过 —— 那正是这个功能
 *   不做自动重投的同一个理由，写在文案里就不该自己拆掉。
 */
function orphanPelAlertText(f) {
  const age = fmtDur(f.oldest_age_ms);
  const idle = fmtDur(f.oldest_idle_ms);
  const groups = Array.isArray(f.groups) ? f.groups : [];

  // ★ 多组时**逐组列出**。合成一个总数就等于把「哪个组卡着」这个信息扔掉，
  //   而人拿着总数没法敲出那条 XPENDING —— 又回到「只省了发现，没省定位」。
  const groupLines = groups.length > 1
    ? `\n分组明细（这条流上有 ${groups.length} 个组卡着）：\n`
      + groups.map((g) => `  · 组 \`${g.group}\`：${g.pending} 条，`
        + `最老 \`${g.oldest_id}\` 滞留 ${fmtDur(g.oldest_age_ms)}`).join('\n') + '\n'
    : '';

  // 有组查不了时，把它跟成立的告警**一起**说出来 —— 否则人会以为报的就是全部。
  const partial = f.probe_error
    ? `\n⚠️ 注意：这条流上还有组**没查成**（${f.probe_error}）—— `
      + '上面的条数是**查得到的那部分**，不是全部。\n'
    : '';

  return `⚠️ **${f.stream} 里有 ${f.pending} 条消息卡着没人认领，而 ${f.name} 已经不在花名册里。**\n`
       + `卡在消费者组 \`${f.group}\`，最老的一条 \`${f.oldest_id}\` 已经滞留 **${age}**`
       + `（距上次投递 ${idle}，投递过 ${f.oldest_delivered} 次，领它的消费者是 ${f.oldest_consumer}）。\n`
       + groupLines
       + partial
       + '重投靠 autoclaim，而 autoclaim 挂在「有人在跑 poller」上 —— '
       + '掉册的那个恰恰不跑了。**这些消息不会自己出来，也不会有第二次提醒。**\n'
       + '**watchdog 只报不动**：没有 ack、没有重投、没有删除，内容原样还在流里。\n'
       + '先看是什么，再决定怎么办（下面两条都是只读的）：\n'
       + `\`XPENDING ${f.stream} ${f.group} - + 10\`\n`
       + `\`XRANGE ${f.stream} ${f.oldest_id} ${f.oldest_id}\`\n`
       + `处置由你定 —— 重做 / 丢弃 / 重启 ${f.name}。`
       + '**这类消息的正确处置不唯一，所以这里没有自动化。**';
}

/**
 * 按判定执行动作。
 *
 * ── ★ nudge 要分型 ──────────────────────────────────────────────
 *   **阻塞** → ESC。1 秒内可打断阻塞中的工具调用。
 *   **失聪** → `submit()` 发一句可执行的指令。
 *
 * 两种都发 ESC 是不行的：失聪的 agent **没在阻塞** —— 它的循环停了，
 * 人在 TUI 里空闲等输入。**ESC 打断一个不存在的阻塞，然后它继续空闲。**
 * 真正能让它恢复的是那句消息。
 *
 * ⚠️ 必须用 `lib/tmux.js` 的 `submit()`，别手搓按键序列 ——
 *    那个函数已经知道「TUI 里必须分两次发、中间留间隔，一次发 Enter 不生效」
 *    （否则文字进了输入框但没提交）。
 */
/**
 * ★ 同一 agent 的同一类干预要有冷却期。
 *
 * ── 冷却期为什么是「一个完整轮询周期」──────────────────────────────
 * watchdog 每 60 秒 tick 一次，而 agent 一轮阻塞 594 秒。**冷却期短于一轮，
 * 就等于对一个正在忙的 agent 反复发** —— 它这一轮结束时会一次性收到十条，
 * 全堆在 CLI 排队区里。
 * **那不是噪音，是会被依次执行的指令** —— 排队区里的东西不会因为过时消失。
 *
 * ── ★ 为什么状态存 redis 而不是进程内存 ────────────────────────────
 * 存闭包 Map 的话，**bus 一重启冷却就清零** —— 而 bus 重启恰恰是最容易连发的
 * 时刻：`start()` 立刻 tick 一次，所有 agent 的判定都是新算的。
 * **「重启后重新开始」对别的状态是合理默认，对节流器是最坏默认。**
 *
 * 用 `SET NX EX`：原子，天然过期不用清理，多个 watchdog 实例也不会同时发。
 */
const COOLDOWN_SEC = Math.ceil(q.DEFAULTS.blockMs / 1000); // 594s，跟阻塞时长同源
const COOLDOWN_KEY = (kind, name) => `engloop:watchdog:cooldown:${kind}:${name}`;

// ══ 出口的状态与节流 ══════════════════════════════════════════════════
//
//   三个 key 都带 TTL：一个 agent 彻底不再出现在 findings 里（会话关了、
//   改名了）之后，没有任何东西会来清它们。**TTL 是这里唯一的兜底。**
const RL_SINCE_KEY = (name) => `engloop:watchdog:rl_since:${name}`;
const RL_WAKES_KEY = (name) => `engloop:watchdog:rl_wakes:${name}`;
const RL_STATE_TTL_SEC = 72 * 3600;

// ── 唤醒冷却：**至少一小时** ────────────────────────────────────────
//
//   为什么不按「算到下一个重置时刻」：那要求**信任自己解析出的时间**，
//   而这个功能存在的前提正是「那个时间可能解析错」。
//   **一个固定的下限，在解析错的时候仍然拦得住。**
//
//   为什么是 3600 而不是默认的 594：默认那个跟一轮阻塞轮询同源，
//   它管的是「同一条告警别每分钟重复」。而这里管的是**动手**——
//   唤醒一个真的还在墙上的会话，代价是再撞一次。**两件事的代价差着数量级。**
const WAKE_COOLDOWN_SEC = 3600;

// ── 连续几次「唤醒了又撞回来」就停手 ────────────────────────────────
const MAX_WAKE_ATTEMPTS = 3;

// ── ★ 唤醒的安全边际 ────────────────────────────────────────────────
//
// 🔴 **它防的是一个构造出来的场景，没有真实样本验过。**
//
//   ⚠️ 它**不管** `staleHint` 那一支：`(resolved.at - since) > 12h` 判成「陈提示」
//     ⇒ 立刻 nudge，那条路径跟这个边际无关（边际加在 `now < resolved.at` 上）。
//     陈提示那条路上的「唤醒太早」，不能拿这个边际去解释或去修。
//
//   ✅ 它防什么（准确射程）：
//     **hint 解析对了、gap 也正常，而 `now` 恰好落在 `resolved.at` 前后几十秒。**
//     ⬜ 测试喂的是构造出来的时刻。
//
//   🔴 而代价是三层叠加，一层比一层贵：
//     ① 白撞一次
//     ② 烧掉 1/3 的唤醒配额 —— 而 `RL_WAKES_KEY` 数的是「**反复撞墙**」，
//        而一次「早了几秒」在那个计数器上**跟一次真的没恢复完全一样**
//     ③ **冷却 `WAKE_COOLDOWN_SEC` = 1 小时** ⇒ **重置时刻只晚了几秒，代价是一小时停摆**
//
//   ⇒ 而代价**不对称**，所以判据往便宜那一侧偏：
//     早 ⇒ 上面三层 · 晚 ⇒ 晚开工 90 秒
//
//   ★ 为什么是 90 秒而不是 10 秒：**watchdog 的 tick 粒度就是 60 秒**
//     ⇒ 边际 < 60 秒等于没加（下一个 tick 落在哪一秒控制不了）。
//     90 秒保证跨过一个完整 tick，还留一点。
//
//   ⚠️ 而它跟 `WAKE_COOLDOWN_SEC` **互补，不是替代**（见那个常量的注释）：
//     边际 防「解析对了，而早了几秒」· 冷却 防「解析错了」。
//
//   ⚠️ `mode === 'worst_case'` 那一支（`detected_at + 24h`）**不为它分支** ——
//     那 24 小时是自己填的上界，加 90 秒没有意义也没有害。
//     **这是有意不处理的情况，不是漏了。**
const WAKE_MARGIN_MS = 90_000;

// ── 陈提示：那行字自己声称的重置时刻，在**watchdog 看见它之前**就过去了 ──
//
//   ── 现象 ─────────────────────────────────────────────────────────
//   pane 上那行 `resets <T>` 可能是**几小时前**打印的，而掉册是后来才发现的。
//   `resolveResetAt` 锚在 `detected_at` 上、取「锚点之后最近的那个 T」
//   ⇒ 当天那次已经过去 ⇒ 它被迫跳到**第二天** ⇒ 算出二十多小时之后
//   ⇒ ⇒ 于是 `now < resolved.at` **永远为真**，下面 ⑤ 那段唤醒**永远走不到**。
//   （样本见 `test/fixtures/rate-limit-panes/`）
//
//   ── 为什么是 12 小时，而不是一个拍出来的数 ─────────────────────────
//   **一次限额的重置窗口不可能超过一个重置周期（24h）** ——
//   所以 `resolved.at` 落到 20+ 小时之后，只意味着一件事：**当天那次 T 已经过去了**。
//   仍在限额的样本落在几小时以内，已经恢复的落在 20+ 小时，
//   中间隔得很开，阈值放在 12 小时两边都有足够余量。
//
//   ⚠️ **而它成立的前提是「T 每 24 小时出现一次」** —— 如果将来出现别的重置周期
//     （比如 5 小时窗口），这个数要跟着**重算**，不是「优化」。
//     写下这个前提，是因为「有依据」这三个字会保护一个常数不被重算。
const STALE_HINT_GAP_MS = 12 * 60 * 60 * 1000;

// ── 三档 fail-closed 各有各的说法 ────────────────────────────────────
//
//   🔴 **不许合并成一句「解析失败」。** 这三种情况人要做的事不一样：
//     no_time        → 去看看 pane 上到底写了什么（可能是文案变了）
//     bad_tz         → 本地的时区表跟上游对不上（这是这边的缺口）
//     no_detected_at → watchdog 自己丢了状态（重启/redis 清过）
//   把它们印成同一句话，等于把三个不同的排查方向合并成一个死胡同。
const RL_FAIL_WHY = {
  no_time: '而我在它的 pane 上**读不出恢复时刻**（文案里没有我认得的时刻格式）。',
  bad_tz: '而它写的时区名**我不认识**（不是 Intl 认得的 IANA 名）—— 这是我们这边的缺口，不是它的错。',
  no_detected_at: '而我**丢了「第一次发现它撞墙」的时刻**（多半是我自己重启过）——'
    + ' 没有那个锚点，「恢复时刻」是今天还是明天我判不了。',
};

// ── 唤醒时发的那句话 ────────────────────────────────────────────────
//
//   ⚠️ **不复用 `DEAF_NUDGE_TEXT`。** 两种情况下 agent 需要知道的事不一样：
//     失聪 → 「你的循环停了，重新开始轮询」
//     这一档 → 「你之前撞了额度上限，**现在应该恢复了**」——
//              而后半句正是它自己判断「要不要立刻再试」的依据。
//   把两句话合并，等于让它分不清自己是「卡住了」还是「刚从墙上下来」。
const RATE_LIMIT_WAKE_TEXT = '[watchdog] 你之前撞了上游额度上限而停下了，'
  + '按你终端上写的恢复时刻，现在应该已经恢复。请立刻回到你的循环：跑一次 poller。'
  + '（这是自动唤醒，不是人在叫你；如果你发现自己其实还没恢复，直接停下等着就行。）';

async function claimCooldown(redis, kind, name, sec = COOLDOWN_SEC) {
  const r = await redis.set(COOLDOWN_KEY(kind, name), String(Date.now()), 'EX', sec, 'NX');
  return r === 'OK';   // 拿到 = 该发；null = 冷却中，跳过
}

/**
 * ★ 结构化事件出口 —— 在这之前 watchdog 说的话**只有 console 一个去处**，
 *   而 bus 是 detached spawn 起来的，那个 console 进了一个没人看的日志文件。
 *
 * ── 为什么必须是结构化的，不能直接把 onLog 的字符串推给浏览器 ──────────
 * 界面把 watchdog 的话和 agent 的发言**按时间交织在同一条流里**，
 * 因为「恢复指令紧接在某个 agent 停止发言之后」这个**时序关系是判断因果的
 * 唯一线索**。要交织就要排序，要排序就要**每条带自己的时间戳** ——
 * 一行 `[watchdog] xxx` 的日志文本里没有它。
 *
 * ── 为什么 `level` 必须原样带出去，不能压成「告警/正常」两档 ────────────
 * `deaf` 和 `heartbeat_lost` 的**处置完全相反**：前者要推恢复指令，
 * 后者**明确不能推**（它没停，推它只会掩盖「心跳为什么没写进去」那个真 bug）。
 * 界面把它们画成同一种红，人就会对着一个正在正常轮询的 agent 动手。
 *
 * ── `action` / `throttled`：说清「做了什么」，不只是「发现了什么」──────
 * 系统消息要带着处置结果（「未推送恢复指令」/「已发送恢复指令
 * （消息，非 ESC）」）。**判定和动作是两件事** —— 冷却期里判定照样成立，
 * 但什么都没做。把它压成一条「发现失聪」会让人以为已经推过了。
 *
 * ⚠️ 冷却中的事件**照发**，只是 `throttled: true`。
 *   不发的话，「这一轮判定它仍然失聪」和「这一轮没检查」在浏览器里长得
 *   一模一样 —— 跟 `sessions_seen` 那条是同一个道理。
 *   **要不要折叠重复项是界面的决定，不是这里替它做的减法。**
 */
async function act(redis, findings, {
  onLog = () => {}, onEvent = () => {}, outStream = 'orch:out', tmuxApi = tmux,
  now = Date.now(),
} = {}) {
  const at = new Date(now).toISOString();
  const emit = (f, text, action, throttled = false) => {
    // watchdog 自己挂掉是最坏的结果（它是最后一道防线），所以事件回调
    // 抛异常不能把这一轮判定带走 —— 它只是个输出口。
    try {
      onEvent({
        // ★★ `type` 是**浏览器的路由键**（前端 `route()` 里一个 switch），
        //   `'watchdog'` 是跟前端钉死的字面值 —— 改一个字，所有 watchdog 事件
        //   都会落到 default 分支「未识别的事件」，**而后端这边毫无察觉**
        //   （`onEvent:(e)=>broadcast(e)` 原样透传，不报错、不掉数据、只是没人认）。
        //
        //   **「哪一种判定」放 `level`，不许放 `type`。**
        //   把分支名（'deaf_detected' 之类）写进 type 是同一个错的另一种走法。
        //
        // ⚠️ 前后端两边各自改这个值，很容易互相追着改、永远对不上。
        //   **它由后端的断言焊死**（test/watchdog-events.test.js 逐档验每个分支），
        //   前端只是一个 case 标签。**要改它，先改那条断言，再改两边。**
        type: 'watchdog',
        at,
        level: f.level,
        name: f.name,
        tmux_session: f.tmux_session || null,
        text,
        action,          // 'submit' | 'esc' | 'report' | 'unregister' | 'none'
        throttled,       // true = 判定成立但因冷却没动手
        idle_ms: f.idleMs ?? null,
        // Infinity 不是合法 JSON —— 跟 buildAgentsPayload 同一个处理
        outbox_idle_ms: Number.isFinite(f.outboxIdleMs) ? f.outboxIdleMs : null,
        pending: f.pending ?? 0,
      });
    } catch (err) {
      onLog(`[watchdog] onEvent 回调抛异常（已忽略）: ${err.message}`);
    }
  };

  for (const f of findings) {
    // ── **只要这一轮它不是 rate_limited，就把出口状态清掉** ──────────────
    //
    //   🔴 放在 `ok`/`unknown` 的 continue **之前** —— 而「它恢复了」
    //     最常见的表现恰恰就是 `ok`。放在后面的话，
    //     **一个真的醒过来的 agent 永远不会被清零**，
    //     于是它下次再撞墙时，唤醒次数是从上一次的余额接着数的
    //     ⇒ 三次用完之后会对一个刚撞第一次的 agent 直接停手。
    //
    //   ⚠️ 完全不出现在 findings 里的 agent 清不到 —— 那一档靠 TTL 兜底。
    if (f.level !== 'rate_limited' && f.name) {
      await redis.del(RL_SINCE_KEY(f.name), RL_WAKES_KEY(f.name)).catch(() => {});
    }

    // ★ `ok` / `unknown` 不发事件 —— 这是**唯一**一处替界面做的减法，写明理由：
    //   watchdog 每 60 秒跑一轮，而正常状态下每个 agent 每轮都是 ok。
    //   把它们也推进对话流，等于每分钟往里灌 N 条「一切正常」，
    //   **系统消息和发言交织出因果的那个效果，会被这些噪音冲掉。**
    //   「谁现在是 ok」有专门的答案：`GET /api/agents`，那是状态查询，不是事件。
    if (f.level === 'ok' || f.level === 'unknown') continue;

    // 花名册有、会话没有 —— 人已经不在了，清掉记录。
    // 留着的话 resolveTarget 会把消息投给一个不存在的 agent。
    // ★ watchdog 对自己的判定：本轮一个会话都没枚举到。
    //   **零会话在这个系统里从来不是正常状态 —— 至少 orch 必须在。**
    //   走冷却，否则 60 秒一条；而这类故障恰恰会持续很久。
    if (f.level === 'zero_sessions') {
      const zeroText = `watchdog 本轮一个 tmux 会话都没枚举到（sessions_seen=${f.sessionsSeen}）`
                     + ' —— 至少 orch 该在，所以多半是「我看不见」而不是「真的没有」。'
                     + '这段时间它没有在检测任何 agent 的失聪。';
      onLog(`[watchdog] ⚠ 本轮枚举到 0 个 tmux 会话 —— 至少 orch 该在，多半是我看不见`);
      if (!(await claimCooldown(redis, 'zero_sessions', 'watchdog'))) {
        emit(f, zeroText, 'none', true);
        continue;
      }
      emit(f, zeroText, 'report');
      await q.send(redis, outStream, {
        from: 'watchdog', to: 'Patrick',
        text: ZERO_SESSIONS_TEXT(f.sessionsSeen), agent_type: 'system',
      }).catch(() => {});
      continue;
    }

    if (f.level === 'stale') {
      await roster.unregister(redis, f.name);
      onLog(`[watchdog] ${f.name} 会话 ${f.tmux_session} 已不在，清掉花名册记录`);
      emit(f, `${f.name} 的会话 ${f.tmux_session} 已不在，花名册里的残留记录已清掉`,
        'unregister');
      continue;
    }

    // ★ heartbeat_lost：会话在 + 不在册 + **仍在读队列** = 它没聋，是心跳丢了。
    //
    //   **不 nudge。** nudge 对它无害但无用（它根本没停），
    //   而**把它算成失聪会掩盖真正的问题：心跳为什么没写进去。**
    //   当成失聪处理的话，一个正常阻塞轮询中的 agent 会被连发恢复指令。
    //
    //   报给人，因为这是**另一个 bug 的症状**，需要有人去查，不是推一把能好的。
    if (f.level === 'heartbeat_lost') {
      const secs = Math.round(f.idleMs / 1000);
      // ★ 这句话里「未推送恢复指令」不是补充说明，是**处置本身** ——
      //   人看到「不在花名册」会想去救它，而救它正是错的。
      //
      // ★★ **「watchdog 没救它」不等于告诉人「你也不该救」。**
      //   前一句是诚实地陈述 watchdog 做了什么，而读的人下一步要做的判断是
      //   「那我要不要动手」—— 那个问题这句话答不了，**于是他会自己填一个**，
      //   而他填的默认答案（去救它）正好是错的。
      //   所以后半句必须点名说「别去救」，并给出真正该查的东西。
      const hbText = `${f.name} 不在花名册，但仍在读队列（idle ${secs}s）`
                   + ' —— 不是失聪，是心跳丢了。未推送恢复指令（推它没用，只会掩盖真因）。'
                   + ' **你也不用去救它**：它下一轮轮询会自愈重建花名册条目。'
                   + ' 该查的是「心跳为什么没写进去」，那是另一个 bug。';
      onLog(`[watchdog] ⚠ ${f.name} 不在花名册，但仍在读队列（idle ${secs}s）—— 不是失聪，是心跳丢了`);
      if (!(await claimCooldown(redis, 'heartbeat_lost', f.name))) {
        onLog(`[watchdog] ${f.name} 冷却中，这一轮不重复报`);
        emit(f, hbText, 'none', true);
        continue;
      }
      emit(f, hbText, 'report');
      await q.send(redis, outStream, {
        from: 'watchdog',
        to: 'Patrick',
        text: `⚠ ${f.name} 掉出了花名册，但它**没有失聪** ——`
            + ` 它的消费者 ${secs} 秒前还在读队列（正常轮询周期 594 秒）。`
            + ' 所以问题不是「轮询停了」，是**心跳没写进去**，那是另一个 bug。'
            + ' 没有向它发恢复指令（它没停，推它没用，只会掩盖真因）。'
            + ' 它下一轮轮询会自愈重建花名册条目；'
            + ' 但在那之前，发给它的消息会被当成「发给人」投进 orch:out，可能出现在你这里。',
        agent_type: 'system',
      });
      continue;
    }

    // ── ★★ 第四档：撞了上游限额 —— **不 nudge，报给人** ────────────────
    //
    //   处置跟 `heartbeat_lost` 同侧，而理由不同：
    //     heartbeat_lost  推它**没用**（它没停）
    //     rate_limited    推它**有害**（它一被唤醒就再撞一次墙，加速消耗）
    //
    //   ★ 所以文案里「未推送恢复指令」同样是**处置本身**，不是补充说明。
    //     而且必须照 heartbeat_lost 那条把「你也不该去救」说出口：人看到「掉册了」
    //     会想去推一把，**而在这一档，人手动推和 watchdog 自动推一样坏**。
    if (f.level === 'rate_limited') {
      // ── ① 锚点：**第一次判成这一档的时刻**，写一次就不再动 ──────────────
      //   SET NX ⇒ 后面每一轮都拿到同一个值。
      //   🔴 拿不到（redis 出问题）时**不许用 now 顶替** —— 同 `resolveResetAt` 的锚点那条：
      //     一个刚重启的 watchdog 会把所有重置时刻都算成「未来」，
      //     于是永远不唤醒，**而它看起来在正常工作**。
      let since = null;
      // ★ `firstSeen` = **这一轮才第一次判成这一档**。
      //   它是免费的：`SET NX` 成功返回 `'OK'`、key 已存在返回 `null` ——
      //   **不加 key、不加一次往返**。（而 `redis` 出问题时它保持 false ⇒
      //   不会因为读不到状态就多跳过一轮。）
      let firstSeen = false;
      // ★ 撞限额信号有效时，锚点是**它停下的时刻** `min(signal.at, now)`，不是「发现的时刻」now ——
      //   发现要等它先掉成 deaf（花名册 TTL 900 秒 ＋ 一个 tick），比真正停下晚最多约 16 分钟。
      //   已经存在的 `rl_since` 不改（仍是 NX）。`min` 防一个时钟跑到未来的信号把锚点推进未来。
      const anchor = Number.isFinite(f.rate_limit_signal_at) ? Math.min(f.rate_limit_signal_at, now) : now;
      try {
        const setRes = await redis.set(RL_SINCE_KEY(f.name), String(anchor), 'EX', RL_STATE_TTL_SEC, 'NX');
        firstSeen = setRes === 'OK';
        const got = await redis.get(RL_SINCE_KEY(f.name));
        since = got == null ? null : Number(got);
        if (!Number.isFinite(since)) since = null;
      } catch (err) {
        onLog(`[watchdog] ${f.name} 读不到 rate_limited 起始时刻（${err.message}）—— 按缺失处理`);
        since = null;
      }

      const wakes = Number(await redis.get(RL_WAKES_KEY(f.name)).catch(() => 0)) || 0;
      const resolved = resolveResetAt(f.rate_limit_hint, since);
      // ★ 说话那一层跟着证据来源改 —— 只有 hook 信号时，「pane 上有限额提示」是一句不成立的话。
      const src = f.rate_limit_source || 'pane';
      const evidence = src === 'hook'
        ? '但 Claude Code 在它停下时报了一次撞限额（StopFailure 信号；pane 上没看到限额文案）'
        : src === 'both'
          ? '而它的 tmux pane 上有上游限额提示，Claude Code 停下时也报了撞限额（StopFailure 信号）'
          : '但它的 tmux pane 上有上游限额提示';
      const baseText = `${f.name} 掉册且不在读队列，${evidence}`
                     + ' —— 判定为撞了额度上限，不是失聪。';
      // 只凭 hook 判的那一格（pane 读得到、但没有限额文案）的已知代价：一次短时 429 也会走到这里。
      const hookOnlyNote = src === 'hook'
        ? `\n⚠️ 这次**只有** StopFailure 信号（pane 上没看到限额文案）：如果那只是一次**短时 429**`
          + '（不是额度用完），它其实可能已经能干活了 —— 我仍然没推它（有意偏向不推），请你看一眼它的 pane。'
        : '';

      // ── ② 连续 N 次「唤醒了又撞回来」⇒ **停手，而且说出口** ──────────────
      //   理由：**「一直在自动恢复」和「恢复不了但没人知道」
      //   在日志上长得一样**。⇒ 停手本身必须是一个可见事件。
      if (wakes >= MAX_WAKE_ATTEMPTS) {
        const stopText = `${baseText}我已经**停止自动唤醒它了** ——`
                       + ` 连续 ${wakes} 次唤醒之后它仍然落在这一档。`;
        onLog(`[watchdog] ⛔ ${f.name} 已唤醒 ${wakes} 次仍未脱离 —— 停止自动唤醒`);
        if (!(await claimCooldown(redis, 'rate_limit_giveup', f.name, WAKE_COOLDOWN_SEC))) {
          emit(f, stopText, 'none', true);
          continue;
        }
        emit(f, stopText, 'report');
        await q.send(redis, outStream, {
          from: 'watchdog',
          to: 'Patrick',
          text: `⛔ **${f.name}：我已经停止自动唤醒它了。**\n`
              + `我按它 pane 上写的恢复时刻唤醒过它 **${wakes} 次**，每一次它都又回到了这一档。`
              + '\n**继续自动唤醒只会重复消耗额度**，所以我停手了 —— '
              + '这条消息不是「它又出问题了」，是「**我不再管它了，该你了**」。\n'
              + '建议：换一个账号/模型再起它，或者等一个完整的重置周期之后手动起。',
          agent_type: 'system',
        });
        continue;
      }

      // ── ③ 算不出重置时刻 ⇒ fail-closed，**而且告警必须跟普通那条分得开** ──
      //   慢可以，但不许**静默地**慢：三档失败原因各有各的文案（`RL_FAIL_WHY`），
      //   人一眼看得出「watchdog 为什么没救它」。
      if (!resolved.ok) {
        const why = RL_FAIL_WHY[resolved.reason] || RL_FAIL_WHY.no_time;
        const fcText = `${baseText}${why} **我没有唤醒它。**`;
        onLog(`[watchdog] ⚠ ${f.name} 算不出恢复时刻（${resolved.reason}）—— 未唤醒`);
        if (!(await claimCooldown(redis, 'rate_limit_blind', f.name))) {
          emit(f, fcText, 'none', true);
          continue;
        }
        emit(f, fcText, 'report');
        await q.send(redis, outStream, {
          from: 'watchdog',
          to: 'Patrick',
          text: `⚠️ **${f.name} 撞了额度上限，而我算不出它什么时候能恢复。**\n${why}\n`
              + '**我没有唤醒它** —— 一个检查工具自己缺证据的时候，'
              + '不该给出「没问题」这个结论。\n'
              + '**你也不要手动推** —— 手动推和自动推一样坏，'
              + '而这一档连「什么时候安全」都不知道。\n'
              + '⇒ 该做的是看一眼它的 pane 上写的恢复时刻，或者等一个完整周期之后再起它。'
              + `${hookOnlyNote}\n`
              + `⚠️ 顺带一个已知的误判方向：如果 ${f.name} 只是**正好在处理跟额度`
              + '有关的文字**，pane 上也会有这些字 —— 那它其实是真失聪，'
              + '而我这一轮不会去救它。**这个方向是有意选的**：'
              + '救晚一步你看得见，而唤醒一个撞墙的会话没人看得见。',
          agent_type: 'system',
        });
        continue;
      }

      const atIso = atBoth(resolved.at, resolved.tz);
      // ⚠️ 估算档要**明说自己是估的**，而且说清最坏偏差 —— 跟 fail-closed 告警同一个要求。
      const estNote = resolved.mode === 'worst_case'
        ? `（⚠️ 文案里**没有时区名**，我按最坏情况估的：${atBoth(since, null)}`
          + ' 之后 24 小时。真正的恢复时刻只会比它早，不会比它晚。）'
        : `（按文案里的时区 ${resolved.tz} 解出来的）`;

      // ── ④′ 陈提示：那行字声称的时刻，在 watchdog 看见它之前就过去了 ──────
      //
      //   🔴 **必须带 `mode === 'tz'` 这个守卫。**
      //     `worst_case` 那一支的 `at` 是 `detected_at + 24h` —— 那 24 小时是
      //     **自己填的上界**，不是那行字说的。它的 gap 恒为 24h，
      //     不加守卫的话这里会把它全部判成陈提示 ⇒ 立刻 nudge，
      //     而那一支的注释写着「只会醒得晚，不会早 nudge」。
      //   ★ 一般形式：一个判据作用在「解析结果」上时，要先分清哪些字段来自**输入**、
      //     哪些是**自己补的默认值** —— 而它们在同一个对象里长得一样。
      const staleHint = resolved.mode === 'tz'
        && (resolved.at - since) > STALE_HINT_GAP_MS;

      // ── ④″ **第一次**判成这一档的那一轮：只告警，不唤醒 ──────────────────
      //
      //   不这样的话：**发现撞墙和唤醒可能发生在同一次 tick** ⇒ 而那一刻 pane 上最后一条
      //   `resets` 可能还是**上一次撞墙留下的旧行** ⇒ 它的 gap > 12 小时 ⇒ `staleHint` 判成
      //   「陈提示」⇒ 立刻唤醒 ⇒ **早于真实重置时刻**。
      //   代价三层：白撞一次 · 烧掉 1/3 配额 · 再冷却一小时。
      //
      //   ⇒ 处置：**头一轮不唤醒**，等下一次 tick（60 秒后）再判 —— 那时新行已经打印。
      //
      //   ⚠️ 两个洞：
      //     ① **「60 秒够 pane 打出新行」这个数没有量过**，是推的。
      //        （而它的方向是安全的：量小了只是多等一轮，不会早唤醒。）
      //     ② 它**没有换掉那个代理** —— `staleHint` 仍然拿「gap 大」当「hint 旧」，
      //        这里只是给它加了一个「不是刚发现的」这个额外条件。
      //        真正的修法要知道**那行字是什么时候出现在 pane 上的**，而现在拿不到。
      if (firstSeen) {
        const firstText = `${baseText}这是**第一次**判成这一档 —— 本轮**只报告、不唤醒**：`
                        + '刚撞墙的头几秒，pane 上最后一条限额提示可能还是上一次的，'
                        + '照它算出来的时刻会让唤醒早得离谱（可能早 10 分钟以上）。'
                        + '下一轮（约 60 秒后）再判。';
        onLog(`[watchdog] ⏸ ${f.name} 首次判 rate_limited —— 本轮不唤醒（等 pane 上的提示稳定）`);
        // 🔴 **不 `claimCooldown('rate_limited')`，也不推给人。**
        //   那个冷却是「告警节流」用的 —— 这一轮如果占了它，
        //   **下一轮那条真正有信息的告警（带恢复时刻、带「别手动推」）会被静默跳过**。
        //   ⇒ 而这一轮本来就没有新信息给人：它说的只是「我还在等 pane 稳定」。
        //   ★ 这跟下面 ⑤ 用独立的 `rate_limit_wake` 同一个理由：**两件事共用一个冷却 key 会互相吃掉。**
        emit(f, firstText, 'none', true);
        continue;
      }

      // ── ④ 还没到点 ⇒ 不唤醒，但**照常告警** ──────────────────────────────
      // 🔴 `+ WAKE_MARGIN_MS`：见上面那段。**只加在这个比较上** ——
      //   `staleHint` 那一支（陈提示 ⇒ 立刻 nudge）跟边际无关，一个字不动。
      if (now < resolved.at + WAKE_MARGIN_MS && !staleHint) {
        // 🔴 文案必须跟着行为改：加了边际之后，**实际唤醒不早于 `atIso + 90 秒`** ——
        //   而只说 `atIso` 的话，人会在那一刻去看、发现它没醒，然后以为坏了。
        //   ★ **改了行为，说话那一层就要跟着改。**
        const wakeIso = new Date(resolved.at + WAKE_MARGIN_MS).toISOString();
        const waitText = `${baseText}预计 ${atIso} 恢复${estNote}，未到时刻，未唤醒`
                       + `（实际唤醒不早于 ${wakeIso} —— 留了 ${WAKE_MARGIN_MS / 1000} 秒边际，`
                       + '因为早几秒唤醒会白撞一次、烧掉 1/3 配额，还要再冷却一小时）。';
        onLog(`[watchdog] ⚠ ${f.name} 判 rate_limited —— 预计 ${atIso} 恢复，未到点`);
        if (!(await claimCooldown(redis, 'rate_limited', f.name))) {
          emit(f, waitText, 'none', true);
          continue;
        }
        emit(f, waitText, 'report');
        await q.send(redis, outStream, {
          from: 'watchdog',
          to: 'Patrick',
          text: `⚠️ **${f.name} 撞了额度上限。**\n它掉出了花名册，也确实不在读队列 ——`
              + ' 但这**不是失聪**，**推它只会更快地撞下一次**。\n'
              + `📅 我读到的恢复时刻是 **${atIso}**${estNote}\n`
              + `**${wakeIso} 之后我会自动唤醒它一次**（比上面那个时刻晚 `
              + `${WAKE_MARGIN_MS / 1000} 秒 —— 早几秒唤醒会让它白撞一次），`
              + '在那之前**你也不要手动推**'
              + ' —— 手动推和自动推一样坏。\n'
              + `⚠️ 顺带一个已知的误判方向：如果 ${f.name} 只是**正好在处理跟额度`
              + '有关的文字**，pane 上也会有这些字 —— 那它其实是真失聪，'
              + ' 而我这一轮不会去救它。**这个方向是有意选的**：'
              + '救晚一步你看得见，而唤醒一个撞墙的会话没人看得见。',
          agent_type: 'system',
        });
        continue;
      }

      // ── ⑤ 到点了 ⇒ **唤醒一次**，走独立冷却 ────────────────────────────
      //   🔴 用**新的 kind** `rate_limit_wake`，不复用 `rate_limited` 那个 ——
      //     后者管的是「告警节流」，两件事共用一个 key 会互相吃掉：
      //     一条告警发过了，唤醒就被静默跳过（反之亦然）。
      const alive = await tmuxApi.exists(f.tmux_session);
      if (!alive) {
        onLog(`[watchdog] ${f.name} 到点了但 tmux 会话已不在 —— 唤不动，需要重启`);
        emit(f, `${baseText}恢复时刻 ${atIso} 已过，但 tmux 会话已不在，唤不动 —— 需要重启。`, 'none');
        continue;
      }
      if (!(await claimCooldown(redis, 'rate_limit_wake', f.name, WAKE_COOLDOWN_SEC))) {
        onLog(`[watchdog] ${f.name} 唤醒冷却中（${WAKE_COOLDOWN_SEC}s），这一轮不重发`);
        emit(f, `${baseText}恢复时刻 ${atIso} 已过，但唤醒冷却中`
              + `（${WAKE_COOLDOWN_SEC}s），本轮未重发。`, 'none', true);
        continue;
      }

      await tmuxApi.submit(f.tmux_session, RATE_LIMIT_WAKE_TEXT);
      const n = await redis.incr(RL_WAKES_KEY(f.name)).catch(() => wakes + 1);
      await redis.expire(RL_WAKES_KEY(f.name), RL_STATE_TTL_SEC).catch(() => {});
      // ⚠️ 两条路走到同一个 submit，而**告警文案必须分得开** ——
      //   「到点了」和「那行字是陈的」是两个不同的事实，而人只读文案。
      const whyWoke = staleHint
        ? `它 pane 上那行字声称的重置时刻，在我们发现它**之前**就过去了`
          + `（解出来是 ${atIso}，比发现时刻晚了 `
          + `${Math.round((resolved.at - since) / 3600000)} 小时 ⇒ 那行字是**旧的**）`
        : `恢复时刻 ${atIso} 已过${estNote}`;
      const wokeText = `${baseText}${whyWoke}`
                     + `，已向它发送恢复指令（第 ${n} 次，上限 ${MAX_WAKE_ATTEMPTS} 次）。`;
      onLog(`[watchdog] ▶ ${f.name} ${staleHint ? '限额提示是陈的' : '恢复时刻已过'}，已唤醒（第 ${n} 次）`);
      emit(f, wokeText, 'submit');
      await q.send(redis, outStream, {
        from: 'watchdog',
        to: 'Patrick',
        text: `▶️ **${f.name} 的恢复时刻到了，我唤醒了它一次。**\n`
            + `读到的恢复时刻：**${atIso}**${estNote}\n`
            + `这是第 **${n}** 次唤醒（上限 ${MAX_WAKE_ATTEMPTS} 次）。`
            + `连续 ${MAX_WAKE_ATTEMPTS} 次之后它仍在这一档的话，`
            + '**我会停手并明说**，不会一直悄悄重试。',
        agent_type: 'system',
      });
      continue;
    }

    // ★ 失聪：会话还在、花名册没有它、**而且确实不在读队列**
    if (f.level === 'deaf') {
      // 🔴🔴 **没读到 pane ⇒ 不 nudge。**
      //
      //   `check()` 那边读 pane 失败时把 level 留在 `deaf` 上（它没有别的
      //   诚实选择：**它并不知道那是不是限额**）。于是拦截必须发生在这里 ——
      //   否则「一次 capture-pane 失败」和「确认了不是限额」走同一条路，
      //   而那条路的尽头是 send-keys。
      //
      //   ⚠️ 这会让 tmux 半死时 deaf 一个都救不了。**这是对的**：
      //   连 capture-pane 都失败的 tmux，`submit()` 同样发不出去 ——
      //   区别只在于拦住了才有人被告知，不拦就是静默地什么也没发生。
      if (f.pane_error) {
        const peText = `${f.name} 判定为失聪，但**读不到它的 pane**（${f.pane_error}）`
                     + ' —— 无法排除「撞了上游限额」，未推送恢复指令。';
        onLog(`[watchdog] ⚠ ${f.name} 失聪但 pane 读不到（${f.pane_error}）—— 未推送恢复指令`);
        if (!(await claimCooldown(redis, 'deaf_pane_blind', f.name))) {
          emit(f, peText, 'none', true);
          continue;
        }
        emit(f, peText, 'report');
        await q.send(redis, outStream, {
          from: 'watchdog',
          to: 'Patrick',
          text: `⚠ ${f.name} 看起来失聪（掉册且不在读队列），`
              + `但我**读不到它的 tmux pane**（${f.pane_error}），`
              + '所以排除不掉「它撞了上游限额」这一种 —— 而那一种推一把是有害的。'
              + ' **没有推送恢复指令。**\n'
              + '要么你去看一眼那个会话（`tmux attach -t '
              + `${f.tmux_session}`
              + '`），要么先确认 tmux 本身是好的：'
              + '连 capture-pane 都失败的话，恢复指令本来也发不出去。',
          agent_type: 'system',
        });
        continue;
      }
      const alive = await tmuxApi.exists(f.tmux_session);
      if (!alive) {
        onLog(`[watchdog] ${f.name} 会话在列表里但已消失，跳过`);
        emit(f, `${f.name} 的会话 ${f.tmux_session} 在枚举时还在、现在已消失，未动作`, 'none');
        continue;
      }
      // ★ 冷却检查放在 exists() 之后、submit() 之前。
      //   放前面的话，一个已经消失的会话也会白占一个冷却位。
      if (!(await claimCooldown(redis, 'deaf', f.name))) {
        onLog(`[watchdog] ${f.name} 恢复指令冷却中（${COOLDOWN_SEC}s），这一轮不重发`);
        emit(f, `${f.name} 会话在但不在花名册（失聪）—— 恢复指令冷却中（${COOLDOWN_SEC}s），本轮未重发`,
          'none', true);
        continue;
      }
      await tmuxApi.submit(f.tmux_session, DEAF_NUDGE_TEXT);
      onLog(`[watchdog] ⚠ ${f.name} 会话在但不在花名册（失聪）——已向 ${f.tmux_session} 发送恢复指令`);
      // ★ 「（消息，非 ESC）」要说出来：对失聪发 ESC 是错的（见 act() 头上「nudge 要分型」），
      //   而人只看「推了一把」分不出这次推的是哪一种。
      emit(f, `${f.name} 会话在但不在花名册（失聪）—— 已向 ${f.tmux_session} 发送恢复指令（消息，非 ESC）`,
        'submit');
      // ★ 文案由 `deafAlertText()` 按 type 生成 —— 编排者失聪和 agent 失聪
      //   **对人的含义完全不同**，通用文案对编排者会说一件不成立的事
      //   （见那个函数头部）。放 lib 里是为了它能被测（bin/ 的回调测不到）。
      await q.send(redis, outStream, {
        from: 'watchdog',
        to: 'Patrick',
        text: deafAlertText(f),
        agent_type: 'system',
      });
      continue;
    }
    // ── 孤儿 PEL：不在册、会话也没了，但收件流里还有没人认领的消息 ──────
    //
    // ⚠️ **两个分支都必须排在下面那句 `const mins = Math.round(f.idleMs / 60000)`
    //   之前** —— 这两档的 `idleMs` 可能是 null（查不了 / 明细拿不到），
    //   `Math.round(null / 60000)` 是 0，不抛异常，**于是它会安静地报出
    //   「已 0 分钟没读队列」这种假事实**。顺序在这里是判据的一部分。
    if (f.level === 'orphan_probe_failed') {
      const what = f.stream ? f.stream : `孤儿流扫描（SCAN ${ORPHAN_STREAM_MATCH}）`;
      onLog(`[watchdog] ${what} 查不了（不是「没有滞留」）: ${f.probe_error}`);
      // ★ 跟既有 `probe_failed` 逐字同一个理由：**「查不了」跟「查了没事」必须分得开。**
      //   这一档尤其 —— 它报的东西本来就少见，一次静默失败在日志上
      //   跟「今天没有孤儿流」完全一样。
      emit(f, `${what} 查不了（不是「没有滞留」，是「查不了」）: ${f.probe_error}`, 'none');
      continue;
    }

    if (f.level === 'orphan_pel') {
      const orphanText = orphanPelAlertText(f);
      onLog(`[watchdog] ⚠ ${f.stream} 有 ${f.pending} 条滞留，${f.name} 不在册`
          + `（最老一条 ${fmtDur(f.oldest_age_ms)}）`);
      // ★ 冷却期用 ORPHAN_COOLDOWN_SEC（6 小时）而不是默认的 594s，理由见常量定义处。
      //   走的是**既有** claimCooldown / COOLDOWN_KEY，没有第二套节流器。
      if (!(await claimCooldown(redis, 'orphan_pel', f.name, ORPHAN_COOLDOWN_SEC))) {
        // ⚠️ 冷却中事件照发，只是 throttled —— 不发的话，「这轮判定它仍然滞留」
        //   和「这轮没扫」在浏览器里长得一模一样。
        emit(f, orphanText, 'none', true);
        continue;
      }
      emit(f, orphanText, 'report');
      await q.send(redis, outStream, {
        from: 'watchdog', to: 'Patrick', text: orphanText, agent_type: 'system',
      });
      continue;
    }

    if (f.level === 'probe_failed') {
      onLog(`[watchdog] ${f.name} 探测失败（不是失聪）: ${f.probe_error}`);
      // ★ 「查不了」跟「查了没事」必须分得开 —— 这是 /api/agents 那段注释
      //   讲的同一件事，只是换了个出口。
      emit(f, `${f.name} 探测失败（不是失聪，是查不了）: ${f.probe_error}`, 'none');
      continue;
    }

    const mins = Math.round(f.idleMs / 60000);

    if (f.level === 'warn') {
      onLog(`[watchdog] ${f.name} 已 ${mins} 分钟没读取队列`);
      emit(f, `${f.name} 已 ${mins} 分钟没读取队列（还没到动手档位，先记一笔）`, 'none');
      continue;
    }

    // ★ 够到动手档位了，但它还在写 outbox（或申报了长任务）—— **不动它，记一笔。**
    //
    //   记而不动，是因为这两件事都要成立：
    //     · **不打断它** —— 它在正常工作，ESC 会中断它当前的工具调用
    //     · **但要说出来** —— 一个 20 分钟不读队列的 agent 值得被看见，
    //       哪怕它在忙。**沉默地放过跟从没检查过，在日志上长得一模一样。**
    if (f.level === 'busy') {
      // ★ **两条否决的证据不一样，必须说清是哪一条** ——
      //   「它申报了一个还活着的长任务」比「outbox 目录几秒前动过」强得多，
      //   而人要判断「这次放过它对不对」时，看的正是这个区别。
      const why = f.declaredBusy
        ? `它申报了一个正在跑的长任务（${f.busy_what || '未说明'}），而那个进程此刻还活着`
        : `${Math.round(f.outboxIdleMs / 1000)}s 前还在写 outbox`;
      onLog(`[watchdog] ${f.name} 已 ${mins} 分钟没读队列，但${why}`
          + ' —— 判为**忙**，不推 ESC（推它等于打断一个正在干活的 agent）');
      emit(f, `${f.name} 已 ${mins} 分钟没读队列，但${why}`
             + ' —— 判为忙，未推 ESC（推它等于打断一个正在干活的 agent）', 'none');
      continue;
    }

    if (f.level === 'nudge') {
      const alive = await tmuxApi.exists(f.tmux_session);
      if (!alive) {
        onLog(`[watchdog] ${f.name} tmux 会话不在了，推不动 —— 需要重启`);
        emit(f, `${f.name} 空闲 ${mins} 分钟，但 tmux 会话已不在，推不动 —— 需要重启`, 'none');
        continue;
      }
      // ★ ESC 同样要冷却。它比 submit 温和（不进排队区），但 60 秒一次
      //   打断一个正在跑长工具调用的 agent，会让它永远做不完那件事。
      if (!(await claimCooldown(redis, 'nudge', f.name))) {
        onLog(`[watchdog] ${f.name} ESC 冷却中，这一轮不重发`);
        emit(f, `${f.name} 空闲 ${mins} 分钟，ESC 冷却中，本轮未重发`, 'none', true);
        continue;
      }
      // 这一路是**阻塞**：它在册、在读队列，只是卡在一次工具调用里
      await tmuxApi.nudge(f.tmux_session, 'Escape');
      onLog(`[watchdog] ${f.name} 空闲 ${mins} 分钟，已发 ESC 推一把`);
      emit(f, `${f.name} 空闲 ${mins} 分钟，已发 ESC 推一把（阻塞类故障，非失聪）`, 'esc');
      continue;
    }

    if (f.level === 'alert') {
      // ── ★ 陈述做过什么 + 随后观察到什么，**因果留给读的人** ──────────
      // 不写「ESC 推送无效」—— 那把一个从未成立的因果写成了观察结果。
      // 人读到「推过仍无反应」会判断 agent 病重该重启，而真实情况可能只是
      // **推错了东西**（对失聪发 ESC，打断了一个不存在的阻塞）。
      onLog(`[watchdog] ${f.name} 空闲 ${mins} 分钟，已上报`);
      emit(f, `${f.name}：已推送 ESC（适用于阻塞类故障）；此后仍无队列读取活动，`
             + `累计空闲 ${mins} 分钟，待确认消息 ${f.pending} 条。已上报，可能需要重启。`,
        'report');
      await q.send(redis, outStream, {
        from: 'watchdog',
        to: 'Patrick',
        text: `⚠ ${f.name}：已推送 ESC（适用于阻塞类故障）；此后仍无队列读取活动，`
            + `累计空闲 ${mins} 分钟。`
            + `待确认消息 ${f.pending} 条。可能需要重启：`
            + (f.type === 'orchestrator'
                ? 'node bin/orch-start.js --stop && node bin/orch-start.js'
                : `node bin/agent-start.js --stop ${f.name} && node bin/agent-start.js --name ${f.name}`
                  + '（想接回它重启前的上下文：第二条末尾加 --resume）'),
        agent_type: 'system',
      });
    }
  }
}

function start(redis, {
  intervalMs = 60_000, onLog = () => {}, onEvent = () => {}, outStream = 'orch:out',
  // ★ 透传下去，不是新功能：`check()` 早就接这个参数了，只是 start() 一直
  //   没往下传 —— 于是「watchdog 自己瞎了会发生什么」这条路径**测不到**，
  //   而它恰恰是最该有守卫的那条（它自己瞎了的现场跟「一切正常」同形）。
  tmuxApi = tmux,
  // ★ 撞限额信号目录透传（测试隔离用；生产走默认）。
  signalsDir = rlSignal.signalsDir(),
} = {}) {
  const tick = async () => {
    try {
      const { findings, signalSweep } = await check(redis, { tmuxApi, signalsDir });
      await act(redis, findings, { onLog, onEvent, outStream, tmuxApi });
      // ★ act() **之后**删信号 —— 删的只是「已经过去的撞墙」和超 TTL 的，这一轮的判定已经用完它们了。
      //   删失败不许带走这一轮（watchdog 是最后一道防线）。
      try {
        const removed = sweepSignals(signalSweep);
        if (removed.length) onLog(`[watchdog] 清掉信号文件：${removed.join(', ')}`);
      } catch (e) { onLog(`[watchdog] 清信号文件失败（忽略）：${e.message}`); }
    } catch (err) {
      onLog(`[watchdog] 检查失败: ${err.message}`);

      // ★ 「查不了」必须报给人，不能只打在没人看的终端日志里。
      //
      //   watchdog 是**发现失聪的最后一道防线**。它自己瞎了的时候，
      //   现场跟「一切正常」完全一样 —— 没有告警、页面三格全空、
      //   **而「没有异常」和「我看不见异常」长得一模一样。**
      //
      //   典型场景：bus 用 nohup 起、PATH 里没有 tmux，
      //   watchdog 的枚举源静默返回空数组，可以很久都没人发现它瞎了。
      //
      //   ⚠️ 这条告警走冷却（用 'blind' 这个 kind），否则每 60 秒一条 ——
      //   而它恰恰是那种「会持续很久」的故障，不节流就是刷屏。
      //
      // ⚠️ 这个 await 包在 try 里：**冷却查询自己会失败**（它也走 redis）。
      //   不包的话，redis 和 tmux 一起挂的时候，这里会抛出第二个异常 ——
      //   而它抛在一个 catch 块里，没人接，**连下面那条「我瞎了」的事件都发不出去。**
      //   最该出声的时刻，出声的代码路径本身被同一场故障带走了。
      let canReport = false;
      try {
        canReport = err.code === 'TMUX_UNAVAILABLE'
          && await claimCooldown(redis, 'blind', 'watchdog');
      } catch (_) { /* redis 也挂了：报不了人，但下面的事件照发 */ }

      // ★ 结构化事件**每轮都发**，用 throttled 区分「这轮报了人」和「冷却中」——
      //   跟 act() 里其它分支同一个规则。
      //
      //   这条是所有事件里最该发的：**如果只有正常判定推得出事件、而「我瞎了」
      //   推不出，那界面上的安静就同时代表两件相反的事。**
      //   它不进 act()（那一轮压根没跑到 act），所以在这里单独发。
      try {
        onEvent({
          // 同上：路由键是 'watchdog'，「哪种判定」在 level 里
          type: 'watchdog',
          at: new Date().toISOString(),
          level: 'blind',
          name: 'watchdog',
          tmux_session: null,
          text: `watchdog 这一轮检查失败：${err.message}`
              + ' —— 这不是「没有 agent 出问题」，是「我看不见有没有 agent 出问题」。'
              + '这段时间它没有在检测任何 agent 的失聪。',
          action: canReport ? 'report' : 'none',
          throttled: !canReport,
          idle_ms: null,
          outbox_idle_ms: null,
          pending: 0,
        });
      } catch (e2) {
        onLog(`[watchdog] onEvent 回调抛异常（已忽略）: ${e2.message}`);
      }

      if (canReport) {
        await q.send(redis, outStream, {
          from: 'watchdog',
          to: 'Patrick',
          text: '⚠ **watchdog 瞎了** —— 它查不到 tmux 会话列表，'
              + `所以这段时间**它没有在检测任何 agent 的失聪**。\n${err.message}\n`
              + '注意：这不是「没有 agent 出问题」，是「我看不见有没有 agent 出问题」——'
              + ' 页面上的在线列表同样是空的，别把它当成一切正常。\n'
              + '常见原因：bus 用 nohup/launchd 起的，PATH 里没有 tmux 所在目录'
              + '（tmux 通常在 /opt/homebrew/bin）。',
          agent_type: 'system',
        }).catch(() => {});
      }
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer), tick };
}

/**
 * 把 check() 的判定 + 花名册 TTL 组装成 `GET /api/agents` 的响应体。
 *
 * ★ 放在 lib 里而不是 bin/serve.js 的路由回调里，理由跟 `timeoutAlertText()`
 *   一样：**bin/ 的入口脚本没法被测试 require（会立刻跑起来）。
 *   一段没法被测试看见的输出，就是一段没有守卫的断言。**
 *
 * ★ 三个字段**全是事实，没有一个是推论**：
 *     `idle_ms`            多久没读队列（XINFO CONSUMERS 的服务端事实）
 *     `ttl_s`              还有多久掉出花名册（redis TTL）
 *     `since_heartbeat_ms` 距上次心跳多久（roster 存的时间戳相减）
 *
 * ⚠️ **不要**把最后一条改成用「注册时的 TTL − 剩余 TTL」反推。那是间接量，
 *    依赖一个**会变的前提**：orch-start 传 86400，而 next.js 每轮 heartbeat
 *    用默认 900 把它踩回去 —— 所以现在**恰好**算得对，**而它对得纯属巧合**。
 *
 * ⚠️ 顺带：`ttl_s` 和 `since_heartbeat_ms` 一起看，上面那个 bug 就**可观测**了 ——
 *    比如 `ttl_s=870 · 心跳 30 秒前`，870+30=900，而 orch-start 传的是 86400。
 *    **这里只让它可见，不修它。**
 */
function buildAgentsPayload(findings, registry, now = Date.now(), sessionsSeen = null) {
  const byName = new Map(registry.map((a) => [a.name, a]));
  const shape = (f) => {
    const rec = byName.get(f.name);
    return {
      name: f.name,
      type: f.type,
      tmux_session: f.tmux_session || null,
      level: f.level,
      idle_ms: f.idleMs,
      // ★ 它是唯一独立于 poller 的活性信号 —— 人看这一行才能判断
      //   「idle 很大」到底是聋了还是在忙。**Infinity 不是合法 JSON，转 null。**
      outbox_idle_ms: Number.isFinite(f.outboxIdleMs) ? f.outboxIdleMs : null,
      // ★ 长任务申报。跟 `outbox_idle_ms` 同一个理由：**人得看得见
      //   「idle 很大」这次是被什么否决的**，否则判断不了放过它对不对。
      //   `busy_reason` 分得开「没申报」和「申报过但那进程死了」——
      //   两种都让结果是「不忙」，但后者说明有个任务异常退出了。
      declared_busy: f.declaredBusy === undefined ? null : f.declaredBusy,
      busy_reason: f.busy_reason || null,
      busy_what: f.busy_what || null,
      pending: f.pending,
      ttl_s: rec ? rec.ttl_s : null,
      // 老条目（这个字段上线前注册的）没有 last_heartbeat —— 给 null，
      // **不要拿 registered_at 顶替**：那是首次注册时间，heartbeat 不更新它，
      // 用它冒充心跳时间就是又一个「看起来精确但是错的」值。
      since_heartbeat_ms: rec && rec.last_heartbeat ? now - rec.last_heartbeat : null,
    };
  };
  // ★ 孤儿流单独一个 shape，**不是**给 shape() 加字段 ——
  //   给 shape() 加的话，既有四档每条都会多出几个恒为 null 的字段，
  //   而既有分组的结果形状不该因为新增一档而改变。
  //   这一档特有的三个值（哪条 · 等了多久 · 谁领走的）是人判断
  //   「这条还要不要」的全部依据，不带出去等于让人再去敲一次 XPENDING。
  const shapeOrphan = (f) => ({
    ...shape(f),
    stream: f.stream || null,
    group: f.group || null,
    oldest_id: f.oldest_id || null,
    oldest_consumer: f.oldest_consumer || null,
    oldest_age_ms: f.oldest_age_ms ?? null,
    oldest_idle_ms: f.oldest_idle_ms ?? null,
    oldest_delivered: f.oldest_delivered ?? null,
  });
  const isSelf = (f) => f.level === 'zero_sessions';
  return {
    at: now,
    // ★ watchdog 自己的活性证据。**没有它的话，「三格全空」和「一切正常」
    //   在这个响应里长得一模一样**。
    //   `sessions_seen === 0` 意味着「我什么都没看见」，不是「什么都没有」：
    //   **至少 orch 会话必须在。**
    sessions_seen: sessionsSeen,
    watchdog_blind: sessionsSeen === 0 || undefined,
    // deaf 单独成组，不混进 live 列表 —— 它是唯一一个「看起来正常但实际上
    // 聋了」的状态，混进去等于把它藏起来。
    deaf: findings.filter((f) => f.level === 'deaf').map(shape),
    stale: findings.filter((f) => f.level === 'stale').map(shape),
    // ★★ `rate_limited` 单独成组，理由跟 deaf 那条**逐字相同**：
    //   它也是一个「看起来正常但实际上停了」的状态，**混进 live 就是把它藏起来**
    //   —— 而这一档藏起来的后果比 deaf 更重：人在界面上看到它是 live，
    //   会以为额度还够，于是接着派活，接着撞。
    //
    //   ⚠️ 但**不能跟 deaf 合并成一组**：那两档对人的指示是相反的
    //   （deaf 该去救，这一档**不许去救**）。画成同一种红，人就会对着一个
    //   撞了限额的会话动手（同 act() 头上 `level` 那段的理由）。
    //
    //   ⚠️⚠️ **前端目前只认 deaf / stale / live 三组，还没认这一组** ——
    //   也就是说这一档在界面上**暂时什么都不显示**。这不是遗漏后的补救，
    //   是有意的取舍：告警的主通道是 `orch:out` 那条推给人的消息（已实现），
    //   而**「界面上不显示」好过「界面上显示成绿的」**。
    //   ⇒ 前端补这一组之前，别把界面当这一档的观测口。
    rate_limited: findings.filter((f) => f.level === 'rate_limited').map(shape),
    // ★★ `orphan_pel` 单独成组，理由跟 deaf / rate_limited 那两条**同族**：
    //   它也是一个「看起来什么都没有、实际上有东西卡着」的状态。
    //
    //   ⚠️ 但这一档更该单列，因为它连一个「agent」都不是 —— 那个名字在
    //   花名册里查不到，`shape()` 给它的 `ttl_s` / `since_heartbeat_ms` 全是 null。
    //   混进 live 的话，它会**显示成一个在线但所有指标为空的 agent**，
    //   而那正是 `rate_limited` 那段注释警告过的形状：
    //   **「界面上不显示」好过「界面上显示成绿的」。**
    //
    //   ⚠️⚠️ 跟 rate_limited 一样，**前端目前不认这一组** ⇒ 界面上暂时不显示。
    //   这一档告警的主通道是 `orch:out` 那条推给人的消息（已实现），
    //   **别把界面当这一档的观测口。**
    orphan_pel: findings.filter((f) => f.level === 'orphan_pel').map(shapeOrphan),
    live: findings
      .filter((f) => f.level !== 'deaf' && f.level !== 'stale'
                  && f.level !== 'rate_limited'
                  // ★ 这两档必须一起排掉。`orphan_probe_failed` 尤其容易漏 ——
                  //   它是「查不了」，掉进 live 就等于**把一次探测失败显示成在线**。
                  && f.level !== 'orphan_pel' && f.level !== 'orphan_probe_failed'
                  && !isSelf(f))
      .map(shape),
  };
}

module.exports = {
  check, act, start, consumerIdle, buildAgentsPayload,
  // 失聪告警文案。导出给测试 —— 编排者那一套是「唯一没有人能发现的故障」
  // 的唯一对外出口，它说错一句话的代价是人去一个不会有东西的地方等。
  deafAlertText, DEAF_NUDGE_TEXT,
  // 导出给测试 —— 也导出 OUTBOX_ROOT，否则测试只能自己拼一遍那个路径，
  // 那就是第二份实现（跟 COOLDOWN_KEY 同理，见下）。
  outboxIdleMs, OUTBOX_ROOT, levelFor,
  // ★★ 第四档的判定器。**导出不是可选的** —— 这一档必须能
  //   在不撞真限额的情况下验证，而唯一的办法就是把假 pane 文本喂给它。
  //   （`RATE_LIMIT_PEEK_LINES` 一并导出：测试要断言 check() 真的按这个行数
  //     去 peek，不然「只看末尾几十行」那条降假阳性的措施没人守。）
  looksRateLimited,
  // ── 出口相关（纯函数，抽出来就是为了能喂假输入）──
  // ★ `atBoth` 导出的理由跟上面那批一样：它是**告警文案的一部分**，
  //   而告警文案说错一句话（比如「只给 UTC」让人读错时区）的代价，
  //   是人在错的时刻去看。
  atBoth,
  parseResetTime,
  extractResetHint,
  resolveResetAt,
  // StopFailure 信号 —— 有效性判据 ＋ 清理（测试要直接喂）
  signalValidity,
  sweepSignals,
  WAKE_COOLDOWN_SEC,
  MAX_WAKE_ATTEMPTS,
  // ★ 导出理由跟 `COOLDOWN_KEY` / `sessionToName` / `streamToName` 逐字相同：
  //   判据拿不到它就只能自己写一个 90000 —— 那就是第二份实现，
  //   而它分叉时判据会「守着一个没人用的数」全绿。
  WAKE_MARGIN_MS,
  RATE_LIMIT_WAKE_TEXT,
  RL_FAIL_WHY,
  RL_SINCE_KEY,
  RL_WAKES_KEY,
  RL_STATE_TTL_SEC,
  tzOffsetAt,
  RESET_TIME_RE,
  WORST_CASE_WINDOW_MS, RATE_LIMIT_PEEK_LINES, STALE_HINT_GAP_MS,
  // 导出给 bus 页面的在线列表用 —— 「谁在会话但不在册」必须只有一个判定实现
  classifySessions, isAgentSession, sessionToName,
  WARN_MS, NUDGE_MS, ALERT_MS,
  // 节流：导出给测试用。COOLDOWN_KEY 也导出，否则测试只能自己拼一遍 key ——
  // 那就是第二份实现，而它分叉时测试会「守着一个没人用的 key」全绿。
  COOLDOWN_SEC, COOLDOWN_KEY,
  // ── 孤儿 PEL 扫描 ──────────────────────────────────────────────
  // `streamToName` 导出**不是可选的**：它必须与 `roster.inboxFor()` 互逆，
  // 而守法是往返断言 —— 断言拿不到函数就只能自己写一遍正则，那就是第二份实现。
  // （跟 `sessionToName` / `COOLDOWN_KEY` 逐字同一个理由。）
  streamToName, findOrphanPels, oldestPending, orphanPelAlertText, fmtDur,
  ORPHAN_STREAM_MATCH, ORPHAN_COOLDOWN_SEC,
};
