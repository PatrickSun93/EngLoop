'use strict';

/**
 * 控制台的纯逻辑：当前任务、需要你、心跳缓冲、队列两个数。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────
 * 跟 `web/threads.js` 同一个理由：`test/` 对 `web/app.js` 只能做源码断言，
 * 而这几条判据**错了不报错，只会画出一个看起来合理的界面**：
 *   · 「排队 0 · 在手 6」被合成「待处理 6」 —— 处置相反的两件事长成一样
 *   · 撞限额的 agent 进了「需要你」 —— 人被催着去碰一个不许碰的东西
 *   · 最后一条消息冒充「当前任务」 —— 一个编出来的事实
 * ⇒ UMD 双导出：浏览器 `<script>` 拿 `window.Derive`，`test/web-derive.test.js` 真的执行它。
 *
 * ⚠️ 加载顺序：浏览器里它要 `window.Threads`，所以 index.html 里排在 threads.js **之后**、
 *   app.js **之前**。Node 里自己 require threads.js。
 * ⚠️ 这里**不放** `STATUS` / `CRIT_LEVELS` —— 它们的唯一出处是 `web/app.js`
 *   （`test/watchdog-liveness.test.js` 从那个文件读它们）。需要时由调用方传进来。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./threads.js'));
  else root.Derive = factory(root.Threads);
}(typeof self !== 'undefined' ? self : this, function (Threads) {

  // ── 给人看的消息（A 组 ①②③）────────────────────────────────────────
  //
  // ══════════════════════════════════════════════════════════════════
  // ★ ①②③ 用**现成信号**；④ 是唯一加的字段 —— 加一个字段要改至少 7 处
  //   手工白名单（relay / rooms / serve×2 / next / app×4），漏掉一处（比如消费侧 `bin/next.js`），
  //   编排者就分不清「它没标」和「它标了我看不到」。test/needs-decision.test.js 逐处钉住。
  //
  //   ① 流程事件    `【流程】` 开头 **或** `Threads.expectsReply(m)`
  //   ② 完成报告    `Threads.isDone(m)`
  //   ③ 点名要他    文本里有 `@Patrick`
  //   ④ 要他拍板    `Threads.needsDecision(m)` —— **这一档是后加的字段**（`needs_decision`），
  //                 因为私聊里没有任何现成信号能表达「这条话在等你做决定」。仍然不按文本猜。
  //
  // ── 🔴 三条「不许这么写」 ──────────────────────────────────────────
  //   · **不许**用「@xxx 请开始」这类**文本形状**认流程事件：有假阳性 ——
  //     普通消息会因为**正文里引用了**那句话而被认成流程事件。
  //   · **不许**直接拿 `expects_reply` 字段做真值判断：`'false'` 是 truthy 字符串，
  //     真实消息里绝大多数是 `'false'` ⇒ 几乎全被判成流程事件。
  //   · **不许**拿 `expects_reply` / `done` / `needs_decision` 直接跟布尔真值比较：流里存的是**字符串**。
  //   · **不许**写 `if (m.needs_decision)`：同上，`'false'` 是 truthy。
  //   ⇒ 一律走 `Threads.*`，判据只有一处。
  //
  // ★ 放在这里而不在 `web/app.js`：「需要你」要用同一条判据，
  //   而 app.js 里的代码测不到。`app.js` 的 `isForHuman` 只是转调这里 ——
  //   **不是第二份实现**。
  // ⚠️ 也**不许**按文本再猜「这是个问题」：问号、「吗」之类一律不认。
  // ══════════════════════════════════════════════════════════════════
  function forHumanReasons(m) {
    const out = [];
    if (!m) return out;
    const text = String(m.text || '');
    if (/^\s*【流程】/.test(text)) out.push('flow');            // ①
    if (Threads.expectsReply(m)) out.push('expects_reply');      // ①
    if (Threads.isDone(m)) out.push('done');                     // ②
    if (/@Patrick\b/i.test(text)) out.push('mention');           // ③
    if (Threads.needsDecision(m)) out.push('decision');          // ④ 要他拍板
    return out;
  }
  function isForHuman(m) { return forHumanReasons(m).length > 0; }

  // ── 队列：两个数，**永远不合成一个总数** ──────────────────────────────
  //
  //   「排队 5 / 在手 1」和「排队 0 / 在手 6」总数都是 6，
  //   **但前者是它干得慢，后者是它领了一堆没干完 —— 人要做的处置完全相反。**
  //   ⇒ 两格都画，零也画（「排队 0 · 在手 6」里那个 0 是信息）。
  //   ⚠️ 「查不了」画成「队列 ?」，不画成「没有」—— 后者会让人停止追查。
  function queueChips(qi, queueError) {
    if (queueError) {
      return {
        unknown: true,
        chips: [{ cls: 'q-unknown', text: '队列 ?',
          title: '队列条目查不出来 —— **这不是「没有积压」**，是「我答不了这个问题」。\n' + queueError }],
      };
    }
    const queued = Number((qi && qi.queued) || 0);
    const inFlight = Number((qi && qi.in_flight) || 0);
    return {
      unknown: false,
      queued,
      in_flight: inFlight,
      chips: [
        { cls: 'q-queued' + (queued ? '' : ' zero'), text: `排队 ${queued}`,
          title: '还没投给它的条数 —— 这些删得掉，是真撤回' },
        { cls: 'q-inflight' + (inFlight ? '' : ' zero'), text: `在手 ${inFlight}`,
          title: '已经投给它、还没确认处理完的条数 —— 这些删了没用，它照常会干完' },
      ],
    };
  }

  /** stream id 比较（`1700000000000-3`）。跟 `lib/queue-items.js` 的 cmpId 同一个规则：先毫秒再序号。 */
  function cmpStreamId(a, b) {
    const [am, as] = String(a).split('-').map(Number);
    const [bm, bs] = String(b).split('-').map(Number);
    if (am !== bm) return (am || 0) - (bm || 0);
    return (as || 0) - (bs || 0);
  }

  const TASK_CHARS = 40;

  /**
   * 卡片上的「当前任务」。三档，按证据强弱：
   *   ① `declared_busy === true` ⇒ `busy_what`（进程申报的，那个进程此刻还活着）
   *   ② 否则 ⇒ 在手条目里**最早**一条的正文前 40 个字（已经投给它、还没 ack 的）
   *   ③ 都没有 ⇒ `—`
   *
   * 🔴 **不准**拿最后一条消息冒充当前任务：一个 agent 最后说的话
   *   可能是「好的」、可能是上一件事的收尾 —— 拿它当「在干什么」就是编一个事实。
   *   ⇒ 这个函数**不收**消息列表。`messages` 参数只为让测试能证明「给了也不用」。
   */
  function currentTask(agent, qi /* , messages —— 故意不用 */) {
    if (agent && agent.declared_busy === true) {
      return { text: agent.busy_what || '（申报了长任务，没写是什么）', source: 'declared' };
    }
    const inflight = ((qi && qi.items) || []).filter((it) => it && it.state === 'in_flight');
    if (inflight.length) {
      const first = inflight.slice().sort((a, b) => cmpStreamId(a.id, b.id))[0];
      const one = String(first.text || '').replace(/\s+/g, ' ').trim();
      const chars = Array.from(one);       // 按字符切，不按 UTF-16 单元 —— 中文和 emoji 不会切出半个
      const text = chars.length > TASK_CHARS ? chars.slice(0, TASK_CHARS).join('') + '…' : (one || '（空正文）');
      return { text, source: 'inflight', id: first.id };
    }
    return { text: '—', source: 'none' };
  }

  // ── 心跳曲线：前端自己存的环形缓冲 ────────────────────────────────────
  //
  // ★ 只放内存，刷新即空 —— 后端没有这个历史，存进 localStorage 的话，
  //   一张昨天的曲线会冒充成「最近 3 分钟」。
  // ★ 不到 3 个点不画线，写「采样中」—— 两个点连出来的线是一条斜线，
  //   而人会把斜线读成趋势。
  const HEARTBEAT_MAX = 36;      // pollAgents 5 秒一次 ⇒ 约 3 分钟
  const HEARTBEAT_MIN = 3;

  function createHeartbeat({ max = HEARTBEAT_MAX, min = HEARTBEAT_MIN } = {}) {
    const buf = new Map();     // name → [{ at, idle_ms }]
    return {
      push(name, idleMs, at = Date.now()) {
        if (!name) return;
        if (!buf.has(name)) buf.set(name, []);
        const arr = buf.get(name);
        arr.push({ at, idle_ms: Number.isFinite(idleMs) ? idleMs : null });
        while (arr.length > max) arr.shift();
      },
      points(name) { return (buf.get(name) || []).slice(); },
      state(name) {
        const pts = (buf.get(name) || []).filter((p) => p.idle_ms != null);
        if (pts.length < min) return { sampling: true, label: '采样中', n: pts.length, points: [] };
        return { sampling: false, label: null, n: pts.length, points: pts };
      },
      names() { return [...buf.keys()]; },
    };
  }

  /**
   * 心跳点 → SVG polyline 的 points。idle 越久线越低（对数刻度，30 分钟封顶 =
   * watchdog 的 alert 档）。返回 null 表示不画（点数不够）。
   */
  function sparkline(points, { w = 120, h = 16, min = HEARTBEAT_MIN } = {}) {
    const pts = (points || []).filter((p) => p && p.idle_ms != null);
    if (pts.length < min) return null;
    const cap = Math.log1p(30 * 60);
    const step = pts.length > 1 ? w / (pts.length - 1) : 0;
    return pts.map((p, i) => {
      const r = Math.min(1, Math.log1p(Math.max(0, p.idle_ms) / 1000) / cap);
      const y = 2 + (h - 4) * r;
      return `${Math.round(i * step * 10) / 10},${Math.round(y * 10) / 10}`;
    }).join(' ');
  }

  // ── 需要你 ───────────────────────────────────────────────────────────
  //
  //   ① agent 的 level 在 `CRIT_LEVELS` 里 —— **`rate_limited` 不算**：它的处置是「别碰」，
  //     放进「需要你」等于催人去碰（限额和失联长得一样时，人会对着限额的 agent 反复去推）。
  //     ① **不受时间窗限制** —— 失联多久都还是失联。
  //   ② `isForHuman(m)` 为真的消息，而且同时满足：
  //     · 在时间窗里（默认 24 小时，按 `at`；数字毫秒和 ISO 字符串都认）
  //     · 人类还没回过它（见 `answeredByHuman`）
  //     · 这个浏览器没点过「收起」（手动兜底）
  //   ①排在②前面。
  //
  // ★★ 为什么要时间窗和「已回过」：
  //   「所有已加载的消息里 isForHuman 为真的」全收的话，预载会拉好几个房间和私聊 ——
  //   **条目一多人就不看了，到那时失联卡也会跟着被忽略。**
  //   ⚠️ test/web-derive.test.js 的 R9：orch-out-48h.json 里 isForHuman 的条目
  //     全在最后 12 小时内，快照里**没有人类发言**（只有 orch:out）。
  //     ⇒ 时间窗和「已回过」在这份夹具上一条都滤不掉 —— 它们防的是更长的历史和活的私聊
  //       （真私聊会把 orch:in:human 合进同一个 feed），不是这份夹具演示得出来的东西。
  // ⚠️ 「人类」由调用方传 `isHuman(m)` 进来（`sender_type` 章 / whoami），这里**不写死名字**。
  //
  // ⚠️ 没有条目时**不等于没事**：两个端点各自查不查得到要一起给出去，
  //   调用方据此写「查不了」而不是「没有要你处理的事」。
  const NEED_WINDOW_MS = 24 * 60 * 60 * 1000;

  function dismissKey(chKey, m) {
    return `${chKey}|${m && m.id != null ? m.id : ''}`;
  }

  /**
   * `at` → 毫秒。**实现在 `web/threads.js`（`Threads.atMs`），这里只是同一个函数的别名。**
   * ★ 时间解析只留一份 —— 两份实现（比如一份「只认数字」的）会对同一条房间消息
   *   给出不同的答案。
   *   导出名 `atMs` 保留（`Derive.atMs === Threads.atMs`），现有调用点和测试不用改。
   */
  const atMs = Threads.atMs;

  /**
   * 人类在这条**之后**回过它没有。
   *   私聊：这个频道里，这条之后有人类发言 ⇒ 回过
   *   房间：人类在这条之后发了一条 `reply_to` 落在同一个线程里的消息
   *         （指向这条的锚点，或指向同一个线程根）⇒ 回过；回别的线程不算
   * 「之后」按列表里的位置算 —— feed 本来就按时间排，而 `at` 可能缺。
   */
  function answeredByHuman(list, idx, isRoom, isHuman, merges) {
    const m = list[idx];
    if (!isRoom) {
      for (let j = idx + 1; j < list.length; j++) {
        const h = list[j];
        if (h && !h.sys && isHuman(h)) return true;
      }
      return false;
    }
    const byId = new Map(list.filter((x) => x && x.id != null).map((x) => [x.id, x]));
    const root = Threads.rootIdOf(m, byId, merges);
    for (let j = idx + 1; j < list.length; j++) {
      const h = list[j];
      if (!h || h.sys || !isHuman(h) || !h.reply_to) continue;
      if (h.reply_to === m.id || Threads.rootIdOf(h, byId, merges) === root) return true;
    }
    return false;
  }

  function needYou({ agents = null, agentsError = null, statusState = 'unknown', feeds = [],
                     dismissed = new Set(), crit = new Set(),
                     now = Date.now(), windowMs = NEED_WINDOW_MS,
                     isHuman = () => false, mergesOf = () => null } = {}) {
    const items = [];
    if (agents && !agentsError) {
      const groups = [
        ...(agents.deaf || []), ...(agents.live || []), ...(agents.stale || []),
      ];
      const seen = new Set();
      for (const a of groups) {
        if (!a || seen.has(a.name)) continue;
        // 🔴 双保险：即使调用方传进来的 crit 里有 rate_limited，这里也不收。
        if (a.level === 'rate_limited') continue;
        if (!crit.has(a.level)) continue;
        seen.add(a.name);
        items.push({ type: 'agent', key: `agent|${a.name}`, agent: a, level: a.level });
      }
    }
    const msgs = [];
    let outOfWindow = 0, answered = 0, doneOnly = 0;
    for (const [chKey, list] of feeds) {
      const arr = list || [];
      const isRoom = String(chKey).startsWith('room:');
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        if (!m || m.sys) continue;
        if (isHuman(m)) continue;                 // 人自己说的话不是「要你处理」
        if (!isForHuman(m)) continue;
        // ★ **只因为 `done`** 才算给人看的 ⇒ 不进「需要你」——
        //   完成报告只出现在今天视图的「刚完成」。同时带 @Patrick / expects_reply / 【流程】的照收。
        // ⚠️ 只在这里滤，**不改 `isForHuman`**：它还负责把线程里的完成报告提到折叠条外面。
        const why = forHumanReasons(m);
        if (why.length === 1 && why[0] === 'done') { doneOnly++; continue; }
        // 时间窗：判不出时间的（at 缺/坏）**留着** —— 看不出新旧就不替人藏起来
        const t = atMs(m.at);
        if (t !== null && now - t > windowMs) { outOfWindow++; continue; }
        if (answeredByHuman(arr, i, isRoom, isHuman, isRoom ? mergesOf(chKey) : null)) { answered++; continue; }
        const key = dismissKey(chKey, m);
        if (dismissed.has(key)) continue;
        msgs.push({ type: 'message', key, chKey, msg: m, reasons: forHumanReasons(m) });
      }
    }
    // 新的在上 —— 「需要你」是待办，不是历史
    msgs.sort((a, b) => (atMs(b.msg.at) || 0) - (atMs(a.msg.at) || 0));
    return {
      items: items.concat(msgs),
      agentCount: items.length,
      // 被时间窗 / 「已回过」滤掉的条数 —— 给 title 用，**滤掉了要说出来**
      // `done`：只因为是完成报告而没收的条数。它们在「刚完成」里看得到，不是被藏起来了 ——
      //   所以「另有 N 条…」那行不写它，只放进 title。
      filtered: { outOfWindow, answered, done: doneOnly },
      health: {
        agents: agentsError ? 'error' : (agents ? 'ok' : 'unknown'),
        // 'ok' | '404' | 'error' | 'unknown' —— 由调用方照 pollStatus 的结果填
        status: statusState,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // ══ 「今天」视图 ════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════════
  //
  // ★ 跟上面同一个理由放这里：这些判据**错了不报错，只会画出一句看起来合理的话**——
  //   · 「自 14:02 以来」把**现在**的读数说成那段时间里发生的事
  //   · 核验跟帖算成第二条完成报告，或者 🏁 读成「通过」
  //   · 「派出 14 分钟」被写成「在手 14 分钟」（队列不给领取时间）
  // ⚠️ 全部**参数传进来、不读全局**：摘要句里每个数字都要能追到输入。

  const MIN_MS = 60 * 1000;
  const DAY_MS = 24 * 60 * MIN_MS;
  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

  /** 日期行：「10 月 14 日 · 周三 · 14:12」（本地时间）。 */
  function dateLine(d) {
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WEEKDAY[d.getDay()]} · ${hhmm(d)}`;
  }

  /**
   * 问候：5–11 上午好，11–13 中午好，13–18 下午好，其余晚上好（本地小时，左闭右开）。
   * ⚠️ 名字由调用方传（whoami 的用户名），**不写死**；拿不到就只写「下午好。」。
   */
  function greeting(d, name) {
    const h = d.getHours();
    const w = h >= 5 && h < 11 ? '上午好' : h >= 11 && h < 13 ? '中午好' : h >= 13 && h < 18 ? '下午好' : '晚上好';
    return name ? `${w}，${name}。` : `${w}。`;
  }

  /**
   * 问候下面那一句。输入是 `needYou()` 的条数和 `health`。
   *   有 N 条 ⇒「有 N 件事在等你。」（agents 不正常时 N 写成「N+?」，跟顶栏角标一样）
   *   0 条且两个端点都正常 ⇒「没有要你处理的事。」
   *   0 条但有端点不正常 ⇒ `kind: 'unknown'`，「查不了有没有事在等你」+ 是哪个端点。**不准写成「没有」。**
   */
  function helloLine({ count = 0, health = { agents: 'unknown', status: 'unknown' }, blind = false } = {}) {
    const bad = [];
    if (health.agents !== 'ok') {
      bad.push(blind ? '/api/agents 回了，但 watchdog 什么都没看见'
        : health.agents === 'unknown' ? '/api/agents 还没回来' : '/api/agents 报错');
    }
    if (health.status !== 'ok') {
      bad.push(health.status === '404' ? '/api/status 404'
        : health.status === 'unknown' ? '/api/status 还没回来' : '/api/status 报错');
    }
    if (count > 0) {
      return { kind: 'some', text: `有 ${count}${health.agents !== 'ok' ? '+?' : ''} 件事在等你。`, bad };
    }
    if (!bad.length) return { kind: 'none', text: '没有要你处理的事。', bad };
    return { kind: 'unknown', text: '查不了有没有事在等你', detail: bad.join(' · '), bad };
  }

  // ── 摘要句的起点 ───────────────────────────────────────────────────────
  const SINCE_MAX_MS = 7 * DAY_MS;
  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  /**
   * 「上次离开今天视图的时间」→ 起点。
   *   存的值读不到 / 坏的 / 在未来 / 超过 7 天 ⇒ 今天 00:00（`today: true`，句子写「今天：」）。
   *   7 天前的起点说明什么也说明不了。
   */
  function resolveSince(saved, now) {
    const t = saved == null ? null : atMs(typeof saved === 'number' ? saved : String(saved));
    if (t === null || t > now || now - t > SINCE_MAX_MS) return { ms: startOfDay(now), today: true };
    return { ms: t, today: false };
  }
  /** 起点写成人话：同一天「14:02」、前一天「昨天 22:10」、更早「10 月 9 日 08:00」。 */
  function sinceText(ms, now) {
    const d = new Date(ms);
    const day0 = startOfDay(now);
    if (ms >= day0) return hhmm(d);
    if (ms >= day0 - DAY_MS) return `昨天 ${hhmm(d)}`;
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hhmm(d)}`;
  }

  // ── 读数：跟顶栏同一套「查不了」写法 ────────────────────────────────────
  /**
   * `/api/status` 快照（app.js 的 `statusSnap`：`{kind:'ok',d} | {kind:'404'} | {kind:'error'} | {kind:'loading'}`）
   * → 全量那一格。文案跟顶栏 `pollStatusMeters` 一字不差：「端点 404」「查不了」「没跑过」「记录损坏」「过 · 红」。
   */
  function testsReading(status) {
    const k = status && status.kind;
    if (k === '404') return { state: '404', text: '端点 404' };
    if (k === 'error') return { state: 'error', text: '查不了' };
    if (k !== 'ok') return { state: 'loading', text: '—' };
    const d = status.d || {};
    const run = d.tests || null;
    if (run && run.error === 'corrupt') return { state: 'corrupt', text: '记录损坏' };
    if (!run || run.error === 'no_data' || run.passed == null) return { state: 'no_data', text: '没跑过' };
    const failed = run.failed == null ? null : run.failed;
    return { state: 'ok', passed: run.passed, failed, stale: d.stale === true,
             text: `${run.passed} · ${failed == null ? '?' : failed}` };
  }
  /** 今日 commit 那一格。`commits_today: null` ⇒「查不了」（照 app.js 顶栏那段：逐字段判 null）。 */
  function commitReading(status) {
    const k = status && status.kind;
    if (k === '404') return { state: '404', text: '端点 404' };
    if (k === 'error') return { state: 'error', text: '查不了' };
    if (k !== 'ok') return { state: 'loading', text: '—' };
    const git = (status.d && status.d.git) || {};
    if (git.available === false || git.head == null) return { state: 'error', text: '查不了' };
    if (git.commits_today == null) return { state: 'error', text: '查不了' };
    return { state: 'ok', n: git.commits_today, text: String(git.commits_today) };
  }
  /** 舰队：在线 = live 组，总数 = 失联 + 限额 + 在线 + 残留（跟顶栏 `renderAgentsTail` 同一个算法）。 */
  function fleetCounts(agents) {
    if (!agents) return null;
    const n = (k) => (agents[k] || []).length;
    return {
      online: n('live'),
      total: n('deaf') + n('rate_limited') + n('live') + n('stale'),
      blind: !!(agents.watchdog_blind || agents.sessions_seen === 0),
    };
  }

  /** 摘要句里 agent 计数的叫法。`ok` / `busy` 是正常，不计；没在表里的 level 叫「未知状态」。 */
  const LEVEL_SHORT = {
    deaf: '失联', alert: '推了没反应', probe_failed: '探测失败', zero_sessions: '零会话', blind: '看不见',
    rate_limited: '限额', nudge: '已推过一把', warn: '轮询慢', heartbeat_lost: '心跳丢了',
    unknown: '还没读过队列', stale: '会话已不在',
  };
  const NORMAL_LEVELS = new Set(['ok', 'busy']);
  function agentLevelCounts(agents) {
    const counts = new Map();
    const seen = new Set();
    const add = (a, fb) => {
      if (!a || seen.has(a.name)) return;
      seen.add(a.name);
      const lv = a.level || fb;
      if (NORMAL_LEVELS.has(lv)) return;
      counts.set(lv, (counts.get(lv) || 0) + 1);
    };
    for (const a of agents.deaf || []) add(a, 'deaf');
    for (const a of agents.rate_limited || []) add(a, 'rate_limited');
    for (const a of agents.live || []) add(a, 'ok');
    for (const a of agents.stale || []) add(a, 'stale');
    const order = Object.keys(LEVEL_SHORT);
    const known = order.filter((l) => counts.has(l)).map((l) => ({ level: l, n: counts.get(l), label: LEVEL_SHORT[l] }));
    const other = [...counts.keys()].filter((l) => !LEVEL_SHORT[l])
      .map((l) => ({ level: l, n: counts.get(l), label: '未知状态' }));
    return known.concat(other);
  }

  // ── 刚完成 ─────────────────────────────────────────────────────────────
  //
  // ★★ 一份完成报告在流里可能是**两条**消息（`lib/done-verify.js:178-192`）：
  //   报告本身（带 evidence 时 `verify: 'pending'`）＋ 核验结论跟帖：
  //     from 同原报告 · `sender_type: 'system'` · `done: 'true'` · `verify: 'pass' | 'unverifiable'` · `reply_to` 指向锚点
  //   ⇒ 跟帖**不单独成行**，它的 verify 记到原报告上；原报告没加载 ⇒ 跟帖自己成一行，**不准丢**。
  //   ⚠️ `sender_type` 不是 system 的同形消息**不合并**：那是 agent 自己又报了一次完成，不是核验结论。
  //
  // ★★ 核验没过的**流里没有任何跟帖**（`done-verify.js:196-`）：只把原报告上的反应换成 🔙，
  //   `verify` 永远停在 `pending`。所以 pending 的报告要看反应：
  //     🔙 ⇒ 打回（红）；🏁 且没有跟帖 ⇒ 「已结束 · 结论没加载到」（灰）—— **不是「通过」**：
  //     `done-verify.js:176` 在 pass 和 unverifiable 下都贴 🏁；都没有 ⇒ 核验中。
  //
  // ⚠️ 锚点：relay 的锚点是 `reply_to || 自己`（`lib/relay.js:881`）—— 报告本身是某个 thread 里的回复时，
  //   🏁 / 🔙 打在 **thread 根**上、跟帖的 `reply_to` 也指向 thread 根。所以：
  //   · 反应按 `报告.reply_to || 报告.id` 去取；
  //   · 跟帖先找 `id === reply_to` 的报告，找不到再找「同一个人、锚点等于 reply_to、在跟帖之前」的最新一份；
  //   · 同一个锚点上有更新的报告时，旧的那份 pending **不读反应**（反应已经是新那份的了）⇒「结论不确定」。
  const DONE_WINDOW_MS = 24 * 60 * MIN_MS;
  const DONE_MAX = 8;
  const DONE_TITLE_CHARS = 60;
  const VERIFY_EMOJI = { PENDING: '⏳', PASS: '🏁', BOUNCED: '🔙' };   // lib/done-verify.js:41 的 EMOJI

  /** 核验状态的文案：照 `Threads.VERIFY_SUFFIX`（通知标题用的同一份），去掉外层括号。认不出的值 ⇒「未验证」。 */
  function verifyLabel(v) {
    const s = Threads.VERIFY_SUFFIX[v] || Threads.VERIFY_SUFFIX.none;
    return s.slice(1, -1);
  }

  const DONE_STATES = {
    pass: { label: verifyLabel('pass'), cls: 'ok', title: '核验结论跟帖：verify = pass' },
    bounced: { label: '核验没过 · 已打回', cls: 'bad',
      title: '报告上有 🔙。核验失败时 lib/done-verify.js 只换反应、不发跟帖，所以 verify 字段停在 pending' },
    ended_unknown: { label: '核验已结束 · 结论没加载到', cls: 'muted',
      title: '报告上有 🏁、没加载到核验跟帖。pass 和 unverifiable 都会贴 🏁（lib/done-verify.js:176），单看反应分不出是哪一种 —— 不当成通过' },
    verifying: { label: '核验中', cls: '', title: 'verify = pending，反应里有 ⏳（核验在跑），或者 🔙 / 🏁 都没有' },
    superseded: { label: '核验结论不确定', cls: 'muted',
      title: '同一个 thread 里有更新的完成报告 —— 🏁 / 🔙 挂在 thread 根上，现在那上面的反应说的是更新的那份' },
    reactions_loading: { label: '核验状态读取中…', cls: 'muted', title: 'verify = pending，反应还没取回来' },
    reactions_error: { label: '核验状态查不了', cls: 'unknown',
      title: 'verify = pending，而反应读不到（/api/reactions/batch 报错）—— 这不是「核验中」' },
    // ★ 泳道视图：**只看 verify 字段、不取反应** ⇒ pending 只能说「交上去了」。
    //   不写「核验中」（不知道核验跑完没有）、更不写「通过」。结论在今天视图（那边取反应）。
    submitted: { label: '已提交核验', cls: '',
      title: '结论看「今天」视图 —— 泳道不取反应，不知道核验跑完没有（verify = pending）' },
  };
  function doneState(state) {
    if (DONE_STATES[state]) return Object.assign({ state }, DONE_STATES[state]);
    // none / missing / unverifiable / not_wired / 没有字段 / 认不出的值 —— 都是「未验证」一族。
    // ⚠️ 缺字段不能读成核过了（`Threads.doneNotice` 同一条）。
    return { state, label: verifyLabel(state === 'absent' ? 'none' : state), cls: '',
             title: state === 'absent' ? '这条完成报告上没有 verify 字段' : `verify = ${state}` };
  }

  function stripMd(s) {
    return String(s)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`+/g, '')
      .replace(/\*\*|__|~~/g, '')
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
      .trim();
  }
  /** 标题：正文第一个有内容的行，去掉 markdown 标记，最多 60 个字（按字符切）。 */
  function doneTitle(text) {
    let line = '';
    for (const l of String(text || '').split('\n')) {
      const t = l.trim();
      if (!t || /^(```|~~~)/.test(t)) continue;
      line = stripMd(t);
      if (line) break;
    }
    const ch = Array.from(line);
    return ch.length > DONE_TITLE_CHARS ? ch.slice(0, DONE_TITLE_CHARS).join('') + '…' : (line || '（空正文）');
  }

  /** 这条是不是核验结论跟帖（`lib/done-verify.js:178-192` 的形状）。 */
  function isVerdictFollowup(m) {
    return !!m && !m.sys && Threads.isDone(m) && m.sender_type === 'system'
      && (m.verify === 'pass' || m.verify === 'unverifiable')
      && m.reply_to != null && String(m.reply_to) !== '';
  }

  function reactionsGetter(reactions) {
    if (!reactions) return () => undefined;
    if (typeof reactions === 'function') return reactions;
    if (typeof reactions.get === 'function') return (k) => reactions.get(k);
    return (k) => reactions[k];
  }
  /** 反应里某个 emoji 的最新时间；没有这个 emoji ⇒ null；有但没时间 ⇒ -Infinity。 */
  function emojiAt(list, emoji) {
    if (!Array.isArray(list)) return null;
    let hit = null;
    for (const r of list) {
      if (!r || r.emoji !== emoji || r.count === 0) continue;
      if (hit === null) hit = -Infinity;
      for (const u of r.users || []) {
        const t = atMs(u && u.at);
        if (t !== null && t > hit) hit = t;
      }
    }
    return hit;
  }

  /**
   * 「刚完成」那一栏的行。
   * @param feeds  `[[chKey, 消息数组], …]`（Map 也行）。chKey 以 `room:` 开头的是房间，其余是私聊。
   * @param reactions  `${scope}:${锚点}` → 反应数组（`/api/reactions/batch` 的元素）。**取不到 = undefined**。
   * @param reactionsFailed  取过但报错的那些 key（Set）—— 写「查不了」，不写「核验中」。
   * @returns `{ rows, total, more, wanted }` —— `wanted` 是还要去取反应的 `{scope, anchor}`（调用方一次批量取）。
   */
  function recentDone({ feeds = [], reactions = null, reactionsFailed = null, now = Date.now(),
                        windowMs = DONE_WINDOW_MS, max = DONE_MAX, mergesOf = () => null } = {}) {
    const getR = reactionsGetter(reactions);
    const failedR = reactionsFailed || new Set();
    const rows = [];
    const seen = new Set();
    const wanted = new Map();
    let ord = 0;
    const inWindow = (t) => t === null || now - t <= windowMs;     // 判不出时间 ⇒ 不藏（跟 splitByAge 一样）
    const newer = (a, ai, b, bi) => {
      const ta = atMs(a.at), tb = atMs(b.at);
      if (ta !== null && tb !== null && ta !== tb) return ta > tb;
      return ai > bi;
    };

    for (const [chKey, list] of feeds) {
      const arr = (list || []).filter((m) => m && !m.sys);
      const scope = String(chKey).startsWith('room:') ? 'room' : 'dm';
      const anchorOf = (m) => String(m.reply_to || m.id);

      const reports = [];
      for (let i = 0; i < arr.length; i++) {
        if (Threads.isDone(arr[i]) && !isVerdictFollowup(arr[i])) reports.push(i);
      }
      // 跟帖 → 报告。`targetOf` 记每条跟帖落在哪份报告上（落不上 = 原报告没加载）
      const targetOf = new Map();        // 跟帖下标 → 报告下标
      const orphans = [];
      for (let i = 0; i < arr.length; i++) {
        const f = arr[i];
        if (!isVerdictFollowup(f)) continue;
        const to = String(f.reply_to);
        let target = reports.find((j) => arr[j].id != null && String(arr[j].id) === to && arr[j].from === f.from);
        if (target === undefined) {
          // relay 的锚点是 `reply_to || 自己` ⇒ 报告是 thread 里的回复时，跟帖指向 thread 根
          for (const j of reports) if (j < i && arr[j].from === f.from && anchorOf(arr[j]) === to) target = j;
        }
        if (target === undefined) orphans.push(i);
        else targetOf.set(i, target);
      }
      // 一份报告有好几条跟帖 ⇒ 用最新的那条；没被选中的旧跟帖也算合进去了（说的是同一份报告）
      const verdictOf = new Map();       // 报告下标 → { m, idx }
      const merged = new Set();          // 合进了某一行的跟帖（消息对象）
      for (const [i, j] of targetOf) {
        merged.add(arr[i]);
        const prev = verdictOf.get(j);
        if (!prev || newer(arr[i], i, prev.m, prev.idx)) verdictOf.set(j, { m: arr[i], idx: i });
      }

      let replyMap = null;
      const repliesOf = (m) => {
        if (!replyMap) {
          replyMap = new Map();
          for (const t of Threads.group(arr, mergesOf(chKey))) replyMap.set(String(t.root.id), t.replies || []);
        }
        return (replyMap.get(String(m.id)) || []).filter((r) => !merged.has(r)).length;
      };

      for (const j of reports) {
        const m = arr[j];
        const t = atMs(m.at);
        if (!inWindow(t)) continue;
        const key = `${scope}|${m.id}`;
        if (m.id != null) { if (seen.has(key)) continue; seen.add(key); }
        const verdict = verdictOf.get(j);
        let state;
        if (verdict) {
          state = verdict.m.verify;
        } else if (m.verify === 'pending') {
          const anchor = anchorOf(m);
          if (reports.some((k) => k > j && anchorOf(arr[k]) === anchor)) {
            state = 'superseded';
          } else {
            const rk = `${scope}:${anchor}`;
            const rs = getR(rk);
            if (rs == null) {
              if (failedR.has(rk)) state = 'reactions_error';
              else { state = 'reactions_loading'; wanted.set(rk, { scope, anchor }); }
            } else {
              // ★★ **先看 ⏳**。核验开始时贴 ⏳（done-verify.js:114），每次结束时 swap 一定先摘掉它
              //   （:156-160）⇒ ⏳ 在 = 有一次核验正在跑。而 🔙 只有 pass 才摘（:176）——
              //   被打回后重报、第二次核验还在跑时，锚点上挂着**旧的 🔙 和新的 ⏳**。不先看 ⏳ 的话，
              //   旧的 🔙 会记到新报告头上（「核验没过」，而它其实在核）。
              const running = emojiAt(rs, VERIFY_EMOJI.PENDING);
              const back = emojiAt(rs, VERIFY_EMOJI.BOUNCED);
              const flag = emojiAt(rs, VERIFY_EMOJI.PASS);
              // 两个都在时看谁更新（pass 会摘掉 🔙，unverifiable 不摘）；时间都不明 ⇒ 按打回算
              if (running !== null) state = 'verifying';
              else if (back !== null && (flag === null || !(flag > back))) state = 'bounced';
              else if (flag !== null) state = 'ended_unknown';
              else state = 'verifying';
            }
          }
        } else {
          state = m.verify == null || m.verify === '' ? 'absent' : String(m.verify);
        }
        rows.push({ key, chKey, scope, id: m.id, msg: m, from: m.from, at: t, title: doneTitle(m.text),
                    verify: doneState(state), replies: repliesOf(m), followup: verdict ? verdict.m : null,
                    orphanVerdict: false, decision: Threads.needsDecision(m), ord: ord++ });
      }
      for (const i of orphans) {
        const f = arr[i];
        const t = atMs(f.at);
        if (!inWindow(t)) continue;
        const key = `${scope}|${f.id}`;
        if (f.id != null) { if (seen.has(key)) continue; seen.add(key); }
        rows.push({ key, chKey, scope, id: f.id, msg: f, from: f.from, at: t, title: doneTitle(f.text),
                    verify: doneState(f.verify), replies: 0, followup: null, orphanVerdict: true, decision: false, ord: ord++ });
      }
    }
    // 新的在上；判不出时间的排最后（不藏）
    rows.sort((a, b) => {
      if (a.at !== b.at) {
        if (a.at === null) return 1;
        if (b.at === null) return -1;
        return b.at - a.at;
      }
      return b.ord - a.ord;
    });
    const total = rows.length;
    const cap = Number.isFinite(max) ? Math.max(0, max) : total;
    // ★ 带 `decision` 的行**不占**上限：它是最该看的那一类，被 8 条上限淹掉就是「决策点埋在完成报告里」
    //   那个根因的第三处。先全收，再对其余行切 `max`；`more` 只数被切掉的非 decision 行。
    let plain = 0;
    const kept = rows.filter((r) => r.decision || plain++ < cap);
    return { rows: kept, total, more: Math.max(0, plain - cap), wanted: [...wanted.values()] };
  }

  // ── 摘要句 ─────────────────────────────────────────────────────────────
  /**
   * 两句话：
   *   「自 14:02 以来：2 条完成报告（1 条已核验）。」—— **只说这段时间里发生的事**
   *   「现在：全量 3932 过 / 5 红 · 1 个失联 · 1 个限额。」—— 当前读数另起一句
   * ⚠️ 两种不能混成一句：全量结果和失联都是**现在**的读数，不知道是不是这段时间里发生的。
   * ⚠️ 全部输入从参数来，**不读全局** —— 测试用夹具对一遍每个数字的出处。
   *
   * @param savedSince  localStorage 里存的「上次离开今天视图」的时刻（原样，可能是 null / 坏的）
   * @param loaded      `{rooms, dms}`：已加载的频道数 —— 「只数已加载的频道」那个 ⓘ 要用真的数
   * @param status      app.js 的 `statusSnap`
   */
  function briefSummary({ now = Date.now(), savedSince = null, feeds = [], reactions = null, reactionsFailed = null,
                          mergesOf = () => null, loaded = { rooms: 0, dms: 0 },
                          status = { kind: 'loading' }, agents = null, agentsError = null } = {}) {
    const since = resolveSince(savedSince, now);
    // 合并跟帖、判核验状态跟「刚完成」那一栏**同一个函数**（不重写一份）；时间窗在下面那一行切
    const all = recentDone({ feeds, reactions, reactionsFailed, mergesOf, now, windowMs: Infinity, max: Infinity }).rows;
    // 「以来」只数起点**之后**的；判不出时间的不数（说不出它在不在这段时间里）
    const after = all.filter((r) => r.at !== null && r.at > since.ms);
    const reports = after.filter((r) => !r.orphanVerdict);
    const verified = reports.filter((r) => r.verify.state === 'pass').length;
    const orphanVerdicts = after.length - reports.length;
    const prefix = since.today ? '今天' : `自 ${sinceText(since.ms, now)} 以来`;
    let line1 = reports.length
      ? `${prefix}：${reports.length} 条完成报告（${verified} 条已核验）。`
      : `${prefix}没有新的完成报告。`;
    if (orphanVerdicts) line1 += `另有 ${orphanVerdicts} 条核验结论（原报告没加载）。`;
    const info = `只数已加载的频道（${loaded.rooms || 0} 个房间、${loaded.dms || 0} 个私聊）`;

    // 第二句：**现在**的读数，跟顶栏同一个来源、同一套「查不了」写法
    const parts = [];
    const tr = testsReading(status);
    if (tr.state === 'ok') {
      parts.push(`全量${tr.stale ? '（过时）' : ''} ${tr.passed} 过 / ${tr.failed == null ? '?' : tr.failed} 红`);
    } else if (tr.state === 'loading') {
      parts.push('全量：还没回来');
    } else {
      parts.push(`全量：${tr.text}`);
    }
    if (agentsError) {
      parts.push('agent 状态查不了');
    } else if (!agents) {
      parts.push('agent 状态还没回来');
    } else if (agents.watchdog_blind || agents.sessions_seen === 0) {
      parts.push('agent 状态查不了（watchdog 什么都没看见）');
    } else {
      const lv = agentLevelCounts(agents);
      if (lv.length) for (const x of lv) parts.push(`${x.n} 个${x.label}`);
      else parts.push('agent 都正常');
    }
    const line2 = `现在：${parts.join(' · ')}。`;
    return { line1, line2, info, since,
             counts: { reports: reports.length, verified, orphanVerdicts } };
  }

  // ── 进行中 ─────────────────────────────────────────────────────────────
  /** stream id（`1700000000000-3`）→ 距 now 多少毫秒。解析不出 ⇒ null。 */
  function dispatchedMs(id, now) {
    const ms = Number(String(id == null ? '' : id).split('-')[0]);
    return Number.isFinite(ms) && ms > 0 ? Math.max(0, now - ms) : null;
  }
  function fmtMinutes(ms) {
    const m = Math.floor(ms / MIN_MS);
    if (m < 60) return `${m} 分钟`;
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
  }
  /**
   * 「进行中」的行：`agents.live` 加 `rate_limited`，按名字排。
   * 失联的已经在「等你处理」里，`stale` 和未启动的不放。
   *   右边那格：inflight ⇒「派出 N 分钟」（按 stream id，**进队列的时间，不是被领走的时间**）·
   *            declared ⇒「申报中」（花名册没有申报开始时间）· none ⇒「空闲」。
   * ⚠️ 队列查不了时不写「空闲」—— 那是把「查不了」画成「没有」。
   */
  function inProgress({ agents = null, queueOf = () => null, queueError = null, now = Date.now(), statusTable = {} } = {}) {
    if (!agents) return null;
    const list = [];
    const seen = new Set();
    for (const [g, fb] of [['live', 'ok'], ['rate_limited', 'rate_limited']]) {
      for (const a of agents[g] || []) {
        if (!a || seen.has(a.name)) continue;
        seen.add(a.name);
        list.push([a, fb]);
      }
    }
    list.sort((x, y) => (x[0].name < y[0].name ? -1 : x[0].name > y[0].name ? 1 : 0));
    return list.map(([a, fb]) => wipRow({ agent: a, level: a.level || fb, qi: queueOf(a.name), queueError, now, statusTable }));
  }

  /**
   * 一个 agent 的「当前任务 + 右边那格」。
   * ★ 今天视图的「进行中」（`inProgress`）和泳道的列头**用的是这同一个函数** —— 不另写一份「派出 N 分钟」。
   */
  function wipRow({ agent: a, level, qi = null, queueError = null, now = Date.now(), statusTable = {} } = {}) {
    const RL = statusTable.rate_limited || {};
    const q = queueChips(qi, queueError);
    if (level === 'rate_limited') {
      return { name: a.name, level, agent: a, q,
               task: { text: RL.note || '撞了上游限额 —— 别推它', source: 'rate_limited' },
               right: { text: RL.label || '限额', title: '撞了上游限额：没有「什么时候恢复」的数据，这里不编一个' } };
    }
    const task = currentTask(a, queueError ? null : qi);
    let right;
    if (task.source === 'inflight') {
      const ms = dispatchedMs(task.id, now);
      right = ms === null
        ? { text: '派出时间不明', title: `stream id 解析不出时间：${task.id}` }
        : { text: `派出 ${fmtMinutes(ms)}`,
            title: '从派出算，不是从开始干算：按那条消息的 stream id 算，是进队列的时间。'
                 + '队列接口不给领取时间（lib/queue-items.js 只给 state），所以不写「在手 N 分钟」。' };
    } else if (task.source === 'declared') {
      right = { text: '申报中', title: '花名册里没有申报开始时间（只有 declared_busy / busy_what / busy_reason），所以不写时长' };
    } else if (task.source === 'none' && queueError) {
      right = { text: '队列查不了', title: `队列条目查不出来 —— 这不是「空闲」。\n${queueError}` };
    } else {
      right = { text: '空闲', title: '没申报长任务，手里也没有已投递未确认的条目' };
    }
    return { name: a.name, level, agent: a, q, task, right };
  }

  // ══════════════════════════════════════════════════════════════════════
  // ══ 「泳道」视图 ════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════════
  //
  // ★ 跟上面同一个理由放这里：这几条判据**错了不报错，只会画出一列看起来合理的东西**——
  //   · 撞限额的 agent 占一整列、跟在线的并排 —— 人会以为它能接活
  //   · 编排者那一列把**别人**发给 agent 的话画成「JARVIS 派的活」—— 一个编出来的指挥关系
  //   · 同一条从两处来（房间流 + 扇出进收件流的那份）画两遍
  //   · `verify: pending` 写成「核验中」或「通过」—— 泳道不取反应，它两个都不知道
  //   · 命令条的目标里混进 agent —— 后端没有「人直接发给 agent」的接口（`POST /api/message` 一律进 orch:in:human）

  /** 失联：列排在编排者后面，底部压救援面板。跟 STATUS 表里 `cls: 'deaf'` 的两档对齐。 */
  const LOST_LEVELS = ['deaf', 'alert'];
  /** 收进右侧窄栏（dock）的：撞限额的（**别碰**）和会话已不在的。 */
  const DOCK_LEVELS = ['rate_limited', 'stale'];

  /**
   * 哪些 agent 有列、什么顺序。
   *   列：`live` + `deaf`。编排者第一，然后失联的（救援面板要在视野里），其余按名字。
   *   窄栏：`rate_limited` + `stale`（按组认，**也按 level 认** —— live 组里带着 rate_limited 的照样进窄栏）。
   * ⚠️ `agents` 为 null（还没回来 / 报错）⇒ 返回 null，调用方画「查不了」，**不画空白**。
   */
  function laneLayout(agents, { orchName = 'JARVIS', lostLevels = LOST_LEVELS } = {}) {
    if (!agents) return null;
    const lost = new Set(lostLevels);
    const seen = new Set();
    const lanes = [], dock = [];
    const add = (a, fb) => {
      if (!a || !a.name || seen.has(a.name)) return;
      seen.add(a.name);
      const level = a.level || fb;
      const row = { name: a.name, agent: a, level,
                    orch: a.type === 'orchestrator' || a.name === orchName,
                    lost: fb === 'deaf' || lost.has(level) };
      if (fb === 'rate_limited' || fb === 'stale' || DOCK_LEVELS.includes(level)) dock.push(row);
      else lanes.push(row);
    };
    for (const [g, fb] of [['deaf', 'deaf'], ['live', 'ok'], ['rate_limited', 'rate_limited'], ['stale', 'stale']]) {
      for (const a of agents[g] || []) add(a, fb);
    }
    const byName = (x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
    const rank = (r) => (r.orch ? 0 : r.lost ? 1 : 2);
    lanes.sort((x, y) => rank(x) - rank(y) || byName(x, y));
    const drank = (r) => (r.level === 'rate_limited' ? 0 : 1);
    dock.sort((x, y) => drank(x) - drank(y) || byName(x, y));
    return { lanes, dock };
  }

  /** stream id 的毫秒部分（`1790000006000-0` ⇒ 1790000006000）。解析不出 ⇒ null。 */
  function streamIdMs(id) {
    const ms = Number(String(id == null ? '' : id).split('-')[0]);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }

  /** 泳道里的完成标记：**只看 verify 字段**。pending ⇒「已提交核验」；其余照 `doneState`（缺字段 ⇒ 未验证）。 */
  function laneDoneState(m) {
    const v = m && m.verify;
    if (v === 'pending') return doneState('submitted');
    return doneState(v == null || v === '' ? 'absent' : String(v));
  }

  /** 正文超过这么多行就折起来。 */
  const LANE_FOLD_LINES = 6;
  function laneFolds(text) {
    return String(text == null ? '' : text).split('\n').length > LANE_FOLD_LINES;
  }

  /**
   * 一列的内容：合并 + 去重 + 排序。纯函数。
   *
   * @param name      这一列是谁
   * @param dm        `GET /api/messages?to=<name>` 的 `messages`（原样：`id / stream / direction / from / to / timestamp / job_id …`）
   * @param roomFeeds `[[chKey, 条目数组], …]`（页面的 `feeds`）—— 只取 `room:` 频道里 `from === name` 的
   * @param orchExtra `[[agent 名字, 那个 agent 的 dm 行], …]` —— **只有编排者那一列用**：并进 `from === orchName` 的派活
   * @param local     页面 `feeds` 里 `dm:<name>` 下**没有 stream 字段**的那些（本地回显、WS 推来的）—— 按 job_id 跟 dm 去重
   *
   * 去重键（stream id 加流名）：
   *   房间发言          `room:<hash>|<房间流 id>`
   *   扇出进收件流的那份 `room:<room_hash>|<room_msg_id>` —— **跟上一条是同一个键**（同一条从两处来，只出一次）
   *   私聊行            `<stream>|<id>`，另记 `job:<job_id>`（本地回显只有 job_id）
   * ⚠️ 扇出的那份**不记 job_id**：房间消息的 job_id 是 N 个收件人共享的（`bin/next.js` 的 dm_msg_id 那段）。
   * ⚠️ 派活行**不收**带 `room_hash` 的：那是 JARVIS 在房间里说的话扇出进了 agent 收件流，不是派活。
   *
   * 排序：`Derive.atMs`（数字和 ISO 都认）；没有时间的用 stream id 的毫秒；都没有的排最后（不藏）。新的在下。
   */
  function laneEntries({ name, orchName = 'JARVIS', dm = [], roomFeeds = [], orchExtra = [], local = [] } = {}) {
    const out = [];
    const seen = new Set();
    let ord = 0;
    const timeOf = (m) => {
      const raw = m.timestamp != null && m.timestamp !== '' ? m.timestamp : m.at;
      const t = atMs(raw);
      return t !== null ? t : streamIdMs(m.id);
    };
    const take = (m, base, keys) => {
      if (keys.some((k) => seen.has(k))) return;
      for (const k of keys) seen.add(k);
      const e = Object.assign({ key: keys[0], t: timeOf(m), from: m.from || null,
        text: String(m.text == null ? '' : m.text), id: m.id != null ? m.id : null,
        to: null, roomHash: null, chKey: null, done: null, verdict: null, msg: m, ord: ord++ }, base);
      // 核验结论跟帖：画成一行系统行，**不当成这个 agent 自己说的话**
      if (isVerdictFollowup(m)) { e.kind = 'verdict'; e.verdict = doneState(String(m.verify)); }
      else if (Threads.isDone(m)) e.done = laneDoneState(m);
      out.push(e);
    };

    // ② 房间发言**先收**：同一条也扇出进了某个收件流时，以房间那份为准（能点过去）
    for (const [chKey, list] of roomFeeds || []) {
      if (!String(chKey).startsWith('room:')) continue;
      const hash = String(chKey).slice(5);
      for (const m of list || []) {
        if (!m || m.sys || m.from !== name) continue;
        const k = m.id != null ? `room:${hash}|${m.id}` : `c:${chKey}|${JSON.stringify([m.from, m.at, m.text])}`;
        take(m, { kind: 'room', src: 'room', roomHash: hash, chKey }, [k]);
      }
    }
    // ① 私聊历史
    for (const m of dm || []) {
      if (!m || m.sys) continue;
      const dir = m.direction === 'in' || m.direction === 'out' ? m.direction : (m.from === name ? 'out' : 'in');
      const keys = [];
      if (m.room_hash && m.room_msg_id != null) keys.push(`room:${m.room_hash}|${m.room_msg_id}`);
      keys.push(`${m.stream || 'dm'}|${m.id}`);
      if (m.job_id && !m.room_hash) keys.push(`job:${m.job_id}`);
      take(m, { kind: dir, src: 'dm', to: m.to || null, stream: m.stream || null,
                roomHash: m.room_hash || null, chKey: m.room_hash ? 'room:' + m.room_hash : null }, keys);
    }
    // ③ 编排者那一列：并进各 agent 收件流里它派的活
    const merged = [];
    if (name === orchName) {
      for (const [crew, rows] of orchExtra || []) {
        if (!crew || crew === name) continue;
        merged.push(crew);
        for (const m of rows || []) {
          if (!m || m.sys || m.room_hash) continue;
          if (m.from !== orchName) continue;      // ★★ 只并它自己派的 —— 别人发给 agent 的不是派活
          const keys = [`${m.stream || `agent:${crew}:in`}|${m.id}`];
          if (m.job_id) keys.push(`job:${m.job_id}`);
          take(m, { kind: 'disp', src: 'orch', to: m.to || crew, stream: m.stream || null }, keys);
        }
      }
    }
    // 本地回显 / WS 推来的（还没被重拉覆盖的那些）
    for (const m of local || []) {
      if (!m || m.sys) continue;
      const k = m.id != null ? `job:${m.id}` : `c:dm:${name}|${JSON.stringify([m.from, m.at, m.text])}`;
      take(m, { kind: m.from === name ? 'out' : 'in', src: 'local' }, [k]);
    }

    out.sort((a, b) => {
      if (a.t !== b.t) {
        if (a.t === null) return 1;
        if (b.t === null) return -1;
        return a.t - b.t;
      }
      return a.ord - b.ord;
    });
    return { entries: out, merged };
  }

  /**
   * 列头 ⓘ 的 title：**这一列的覆盖范围**。
   * ⚠️ 后端的 `coverage_note` / `coverage_next` **原样**放进来，不改写（改写就是第二份说法，覆盖范围变了只有一份会跟着改）。
   * ⚠️ 房间数写真实的（已加载的个数），派活行写清并了哪几个 agent。
   */
  function laneCoverage({ name, orchName = 'JARVIS', payload = null, error = null, rooms = 0, merged = null } = {}) {
    const lines = [`这一列是三处拼起来的（按时间排，同一条只出一次）：`];
    if (payload) {
      const src = (payload.sources || [])
        .map((s) => `${s.stream}（${s.direction}）${s.matched == null ? '?' : s.matched} 条`).join('、');
      lines.push(`① GET /api/messages?to=${name}：${src || '响应里没有 sources'}`);
      if (payload.coverage_note) lines.push(payload.coverage_note);
      if (payload.coverage_next) lines.push(payload.coverage_next);
    } else {
      lines.push(`① GET /api/messages?to=${name}：${error ? '查不了 —— ' + error : '还没取回来'}`);
    }
    lines.push(`② 已加载的 ${rooms} 个房间里 ${name} 的发言 —— 没加载过的房间里的发言不在这里`);
    if (name === orchName) {
      lines.push(merged && merged.length
        ? `③ 派活行（→ 收件人）：并进了 ${merged.join('、')} 的收件流里 from = ${orchName} 的条目 —— 只有已经取过的 agent。`
          + `/api/messages?to=${orchName} 本身不含派活（relay 直接投进 agent 的收件流）`
        : `③ 派活行：还没取到任何 agent 的收件流 —— /api/messages?to=${orchName} 本身不含派活`);
    }
    return lines.join('\n');
  }

  /**
   * 命令条能选的目标：**编排者，加上房间。没有 agent。**
   *   `POST /api/message` 一律投进 `orch:in:human`，后端没有「人直接发给 agent」的接口 ——
   *   目标里放一个 agent，人发出去的话会进编排者的收件流，而界面上写着「发给 dev」。
   * ⇒ 这个函数**故意不收** agent 列表（`agents` 参数只为让测试能证明「给了也不用」）。
   */
  function cmdTargets({ orchName = 'JARVIS', rooms = [] /* , agents —— 故意不用 */ } = {}) {
    const out = [{ kind: 'dm', id: orchName, name: orchName, members: [], label: `@${orchName}（私聊）` }];
    for (const r of rooms || []) {
      if (!r || !r.hash) continue;
      out.push({ kind: 'room', id: r.hash, name: r.name || r.hash, members: r.members || [], label: `#${r.name || r.hash}` });
    }
    return out;
  }

  /** 焦点在某个 agent 的列上时，命令条旁边那行灰字。目标**不跟着换**。焦点在编排者 / 没有焦点 ⇒ null。 */
  function cmdFocusHint({ focus = null, orchName = 'JARVIS' } = {}) {
    if (!focus || focus === orchName) return null;
    return `要给 ${focus} 派活，发给 ${orchName}`;
  }

  return {
    forHumanReasons, isForHuman,
    queueChips, cmpStreamId, currentTask, TASK_CHARS,
    createHeartbeat, sparkline, HEARTBEAT_MAX, HEARTBEAT_MIN,
    needYou, dismissKey, atMs, answeredByHuman, NEED_WINDOW_MS,
    // 「今天」视图
    dateLine, greeting, helloLine, resolveSince, sinceText, SINCE_MAX_MS,
    testsReading, commitReading, fleetCounts, agentLevelCounts,
    recentDone, isVerdictFollowup, doneTitle, verifyLabel, doneState, DONE_WINDOW_MS, DONE_MAX,
    briefSummary, inProgress, dispatchedMs, wipRow,
    // 「泳道」视图
    laneLayout, laneEntries, laneCoverage, laneDoneState, laneFolds, LANE_FOLD_LINES, streamIdMs,
    cmdTargets, cmdFocusHint, LOST_LEVELS, DOCK_LEVELS,
  };
}));
