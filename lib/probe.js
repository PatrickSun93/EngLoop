'use strict';

/**
 * 自环存活探针 —— 让「agent 聋了」这件事变成可观测的。
 *
 * ── 它治的是什么 ────────────────────────────────────────────────
 * poller 返回 `{"timeout":true}` 有两种截然不同的原因：
 *   ① 真的没人说话
 *   ② relay 挂了 / 流名改了 / consumer group 坏了 / 花名册掉了
 * **两者长得一模一样**，而 `protocols/identity.md` 第一段就写着
 * 「停止轮询 = 失聪，你不会收到任何提示说你聋了，人也不会」。
 *
 * 探针：agent 给**自己**写一条 outbox，走完整条真链路
 * （outbox → relay → 自己的收件流 → poller）再回来。收得到 = 链路活着。
 *
 * ── ★ 为什么发送和销账都必须在 poller 里，而不是 agent 手里 ──────
 * 让 agent 自己手工发探针，链路能跑通，但没用：
 *
 *   探针没回来的表现 = 一直 timeout
 *   而 agent 在 timeout 轮的动作是协议写死的最高优先级：「立刻回去跑 poller」
 *   ⇒ **agent 越守纪律，越发现不了自己聋了。**
 *
 * 穷举过挂载点：timeout 轮 agent 唯一会执行的动作就是跑 poller。
 * **所以这不是「挂在 poller 上比较方便」，是只能挂在这里。**
 *
 * ── ⚠️ 三条硬约束 ────────────────────────────────────────────────
 * **① 告警长度不能随故障严重程度增长。**
 *    多条探针同时超时也只报最老的一条 + 计数，恒定一行。
 *    越严重越长的告警，会在最该被看见的时候把自己挤出 2048 字节的
 *    工具 preview —— 那就成了「为了不聋，改成瞎」。
 *
 * **② 检测器缺席时必须出声。**
 *    状态文件不存在 = 从没发过探针 = 这个检测器根本没在保护你，
 *    而它的表现（沉默）跟「一切正常」完全一样。所以缺席也报。
 *
 * **③ 探针机制自身出错，绝不能影响轮询。**
 *    poller 是所有 agent 的生命线。这里每个入口都吞异常并降级成
 *    「没有告警」—— 唯一的例外是上面那条②，它靠状态文件缺失来表达。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** 超过这么久没回来 = 判定异常。**用绝对时间不用「轮数」** ——
 *  一轮在 timeout 时是 9.9 分钟、在忙轮可能是 12 秒，同一个「两轮」差两个数量级。 */
const OVERDUE_MS = 20 * 60 * 1000;

/** 距上次发送超过这么久就自动补发一条。 */
const RESEND_AFTER_MS = 60 * 60 * 1000;

/** 探针文本前缀。relay 不认识「这条是探针」，识别只能靠它。 */
const PREFIX = 'PROBE-';

/**
 * 状态文件路径。**按 agent 分开** —— next.js 是所有 agent 共用的，
 * 一份共享状态会让 dev 的探针销掉 JARVIS 的账。
 *
 * `ENGLOOP_PROBE_STATE` 覆盖是给测试用的：往生产状态文件里塞测试探针，
 * 会留下一条**永远不会销账的告警**，而那正是最坏的坏法（见文件头②的反面：
 * 一直报会让人对真告警脱敏，而这个检测器的全部价值就是它平时不说话）。
 *
 * ── 🔴 「半隔离」比「不隔离」更坏 ──────────────────────────────────
 *
 *   一个 spawn `bin/next.js` 的测试如果只隔离了一部分（比如只传了 redis 地址，
 *   没传 outbox 根和 state 路径），子进程就会：
 *     · 探针写**生产** outbox   ⇒ 真 relay 捡走
 *     · 状态写**生产** state    ⇒ 一条 pending 记在生产里
 *   而如果探针回不到这个 agent 的收件流（比如被测的 agent 恰好掉册 ⇒ relay
 *   查花名册不在 ⇒ **当成人** ⇒ 推 `orch:out` ⇒ 进了人的界面），
 *   ⇒ pending 永远挂着 ⇒ 告警永远响，报的是「**可能已失聪**」—— 而那个 agent 收发全通。
 *
 *   ★ 这个假告警**只在「被测者恰好掉册」时才产生**：
 *     在册 ⇒ 探针投进它自己的收件流 ⇒ 下一轮 harvest 销账 ⇒ 没人看得见
 *     掉册 ⇒ 推给人 ⇒ 永久 pending ⇒ 假告警
 *   ⇒ **触发条件正好是这个告警唯一有用的那一刻。**
 *
 *   三种做法对比：
 *     完全不隔离 ⇒ 探针真发真回 ⇒ pending 清空 ⇒ **没有假告警**（代价是污染消息流）
 *     完全隔离   ⇒ 生产一个字节不动
 *     只隔离一半 ⇒ **发得出、回不来** ⇒ 一条永不销账的 pending
 *   ⇒ **做了一半隔离的那个，比什么都没做更坏，而它看起来比什么都没做更负责。**
 *
 * ── ✅ 所以这里多一层兜底：**state 跟着 outbox 走** ─────────────────
 *
 *   `ENGLOOP_OUTBOX_ROOT` 设了而 `ENGLOOP_PROBE_STATE` 没设 ⇒ 状态落进那个 root。
 *   ⇒ **隔离了 outbox 就自动隔离了 state**，不需要任何人记得第二件。
 *
 *   ⚠️ 而它挡不住「两个都没传」—— 那一类只能在调用方修
 *     （比如 `test/e2e.test.js` spawn 子进程时的 env）。
 *     **两层挡的不是同一类，所以两层都要有。**
 *
 *   ★ 为什么不用 `isTestProcess()`：那是 `lib/queue.js` 判「连哪个库」的判据，
 *     而它认的是**跑测试的进程自己**。这里的子进程是 `bin/next.js` ——
 *     一个**生产入口**，`isTestProcess()` 对它返回 false（本来就该）。
 *     ⇒ 拿它当隔离判据，会把「谁 spawn 了这个进程」这个信息当成「这个进程是谁」。
 */
function statePath(name) {
  if (process.env.ENGLOOP_PROBE_STATE) return process.env.ENGLOOP_PROBE_STATE;
  const outboxRoot = process.env.ENGLOOP_OUTBOX_ROOT;
  if (outboxRoot) return path.join(outboxRoot, `probe-state-${name}.json`);
  return path.join(ROOT, 'temp', `probe-state-${name}.json`);
}

/**
 * 探针往哪个 outbox 写。
 *
 * ⚠️⚠️ **必须走 `ENGLOOP_OUTBOX_ROOT`**，不许硬编码。
 *
 *   `bin/serve.js` 有一张「隔离必须四件一起」的清单，其中一条是：
 *   > outbox 根 `ENGLOOP_OUTBOX_ROOT` ★ 少了这个，**测试写的假回复会被真 relay
 *   >   捡走并发给人**。
 *
 *   探针也是一个出口：隔离模式下 bus 换了 outbox 根，而 poller 里的探针
 *   要是照旧往生产 `temp/outbox/<name>/` 写，就会被真 relay 捡走、真的投出去。
 *
 *   > **「所有出口都要堵」这句话的麻烦在于：出口的数量会随功能增长。**
 *   > 每加一个往外写的东西，就要回来问一次「隔离模式下它写去哪」。
 *
 * ★ 顺带它也让「探针本身」可测：不注入的话，跑一次 `maybeSend` 就会往生产
 *   outbox 扔一个文件，然后真的发出去。
 */
function outboxDirFor(name) {
  const root = process.env.ENGLOOP_OUTBOX_ROOT || path.join(ROOT, 'temp', 'outbox');
  return path.join(root, name);
}

/** 读状态。**读不到和读坏了都返回 null** —— 都表示「检测器没在保护你」，
 *  由调用方统一报告，这里不区分（区分了也没有不同的修法）。 */
function load(name) {
  try {
    const raw = fs.readFileSync(statePath(name), 'utf8');
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return null;
    return {
      last_sent_ms: Number(s.last_sent_ms) || null,
      last_returned_ms: Number(s.last_returned_ms) || null,
      pending: Array.isArray(s.pending) ? s.pending : [],
    };
  } catch {
    return null;
  }
}

/** 写状态。失败静默 —— 见文件头③。 */
function save(name, state) {
  try {
    const p = statePath(name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * 从本轮消息里摘出属于自己的探针。
 *
 * ⚠️ **判据是 `from === name` 且文本以 PROBE- 开头，两个都要。**
 * 只看前缀的话，任何人在正文里提到 `PROBE-xxx`（比如讨论探针本身）
 * 都会被误销账。
 *
 * @returns {{kept: any[], ids: string[], acks: any[]}}
 *   `kept` 交给大脑；`ids` 用来销账；
 *   `acks` 是被摘走的**原始消息**（带 stream/id）——
 *   ⚠️ **调用方必须 ack 它们**。摘出去却不 ack，60 秒后 PEL 重投，
 *   于是探针变成一条永远回来、永远被摘走、永远重投的消息：
 *   **一个本来用于发现故障的机制，自己成了那个故障。**
 */
function harvest(messages, name) {
  const kept = [];
  const ids = [];
  const acks = [];
  for (const m of messages || []) {
    const isProbe = m && m.from === name
      && typeof m.text === 'string' && m.text.startsWith(PREFIX);
    if (!isProbe) { kept.push(m); continue; }
    ids.push(m.text.slice(PREFIX.length).split(/\s/)[0]);
    acks.push(m);
  }
  return { kept, ids, acks };
}

/** 把回来的探针销账。**`last_sent_ms` 不清** —— 见 alertLine 里②的理由。 */
function settle(state, ids, now) {
  if (!state || !ids.length) return state;
  const done = new Set(ids);
  state.pending = (state.pending || []).filter((p) => !done.has(p.id));
  state.last_returned_ms = now;
  return state;
}

/**
 * 算告警。**恒定一行，或者 null。**
 *
 * 三种情况会说话，优先级从高到低：
 *   ① 有探针超时未回      → 可能聋了
 *   ② 状态文件不存在      → 这个检测器没在保护你
 *   ③ 太久没发过探针      → 在下一条探针回来之前，「没有告警」不等于链路健康
 */
function alertLine(state, now) {
  // ② 放在最前面判断，但它的**语义**是最弱的一条：不是「出事了」，
  //    是「你现在没有任何保护」。**沉默会被读成一切正常，所以它必须出声。**
  if (state === null) {
    return '⚠️ 存活探针未启用（状态文件读不到）—— 此刻的 timeout 无法区分'
      + '「真没人说话」和「你已经聋了」';
  }

  const pending = state.pending || [];
  const overdue = pending
    .filter((p) => now - (p.sent_ms || 0) > OVERDUE_MS)
    .sort((a, b) => (a.sent_ms || 0) - (b.sent_ms || 0));

  if (overdue.length) {
    const oldest = overdue[0];
    const mins = Math.floor((now - oldest.sent_ms) / 60000);
    // ★ 只报最老的一条 + 计数。**长度不随 overdue.length 增长** —— 文件头①。
    const more = pending.length > 1 ? `（另有 ${pending.length - 1} 条在途）` : '';
    return `🔴 探针 ${oldest.id} 发出 ${mins} 分钟未回${more}`
      + ' —— 可能已失聪：查 relay 进程 / 流名 / consumer group / 花名册';
  }

  // ③ `last_sent_ms` 在销账时**不清空**，就是为了让这一条判得出来。
  //    只存「在途的探针」的话，「从没发过」和「刚销完账」都是 pending 为空 ——
  //    于是「探针机制自己停了、根本没发」这种故障一点痕迹都不留。
  if (!state.last_sent_ms || now - state.last_sent_ms > RESEND_AFTER_MS) {
    return '⚠️ 存活探针已超过 60 分钟没发出 —— 在下一条回来之前，'
      + '「没有告警」不等于链路健康';
  }

  return null;
}

/**
 * 需要时补发一条探针（写 outbox，走完整链路）。
 *
 * ⚠️ **必须写 outbox 文件，不能直接 q.send 进收件流。**
 * 直接 send 会跳过 relay —— 而 relay 正是最可能坏、也最需要被验的那一段。
 * 一个抄近路的探针，验的是一条没人走的路。
 *
 * @returns {string|null} 发出的探针 id
 */
function maybeSend(name, state, now) {
  const last = state && state.last_sent_ms;
  if (last && now - last <= RESEND_AFTER_MS) return null;
  try {
    const id = String(now);
    const dir = outboxDirFor(name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${now}.json`),
      JSON.stringify({
        username: name,
        text: `${PREFIX}${id} 自环存活探针（poller 自动发出）。`
          + '收到即销账，无需回复。',
        // ★★★ `kind: "status"` —— **别删，它不是装饰**。
        //
        // ── 不标的后果 ────────────────────────────────────────────────
        //   探针是**写进 agent outbox 目录的普通文件**（见上面那段：必须走
        //   完整链路）。于是在 relay 眼里它和 agent 亲手写的一模一样：
        //   没有 `reply_to`、没有 `kind` ⇒ `web/threads.js` 的 kindOf 判成
        //   `orphan` ⇒ `_thread_alert` 报「你上一轮发的消息没挂 thread」。
        //
        //   **而收到告警的那个 agent 修不了它** —— 那条 outbox 不是它写的，
        //   它没有任何办法给探针加 reply_to。
        //
        //   ⚠️ 更糟的是探针**周期性重发**，所以这个误报会一直回来。
        //   **一个修不掉又反复出现的告警，是训练人忽略告警的最快方式** ——
        //   比一次性的假数据快得多。
        //
        // ★ 判据：
        //   > **只对「他做得了主的事」告警。做不了主的事报给他，
        //   >   只会训练他不看告警。**
        //
        // ★ 为什么是「标注」而不是「让检查器跳过探针」：
        //   这里的发送者是**系统**，而 thread 模型的判据本来就是
        //   「由发送者标注，不许靠内容猜」。
        //   让 relay 或 thread-alert 去认 `PROBE-` 前缀，就是让检查器猜 ——
        //   而且靠文本前缀识别很脆：改一个字，失效方式正是这个误报重新长出来。
        //
        // ★ 这一档语义上也完全对得上：`status` = 「在报自己的状态，
        //   而不是在说一件事」。探针自己那句话是「收到即销账，无需回复」。
        //   **它不是为了绕过告警才标的 —— 它本来就属于这一档。**
        kind: 'status',
      }) + '\n',
    );
    return id;
  } catch {
    // 见文件头③：发不出去不能让轮询挂掉。下一轮 alertLine 的③会喊。
    return null;
  }
}

/**
 * 从一批探针状态里分出「**测试污染**」的那些。
 *
 * ── 判据两半，缺一半就没用 ────────────────────────────────────────
 *   **名字不是活着的 agent** 且 **pending 非空**
 *   · 前半挡掉活着的 agent 正常的探针周期（每 60 分钟一发一回，pending 短暂非空）
 *   · 后半挡掉退役 agent 留下的**干净**文件（pending 为 0）
 *
 * ── 🔴 已知漏报：**掉册但 tmux 还在的真 agent 被污染时，它选不出来** ────
 *   比如一个测试 spawn 的 poller 往 `probe-state-JARVIS.json` 写了一条永不销账的 pending ——
 *   而 JARVIS **是** agent、tmux **也在** ⇒ 这个函数**不会**选中它。
 *   ⇒ 这被判为可接受，理由是**不对称**：
 *       误报 ⇒ 人会放宽判据；
 *       而漏报「掉册者」那一类 ⇒ **另有一条覆盖**：探针告警自己
 *       （那条 pending 真的没回来，告警会响）。
 *   📌 `test/probe.test.js`【14】里有一条**专门断言这个漏报还在**的判据：
 *     它变红说明洞的形状变了，而怎么读写在那条断言旁边。
 *
 * @param {Record<string, {pending?: unknown[]}>} states  { 名字: 状态 }
 * @param {Iterable<string>} liveAgents  活着的 agent 名
 *   ⚠️ 取法**别自己写** —— 照 `lib/busy.js` 里的写法：
 *     `if (!isAgentSession(s)) return null;` → `sessionToName(s)`，**顺序不能反**。
 *     （`sessionToName('random')` 会无条件 slice 出 `"om"` —— 而那个垃圾串
 *       不报错、不命中任何东西 ⇒ **静默地什么都不做**。）
 * @returns {string[]} 被判为污染的名字，已排序
 */
function classifyPollution(states, liveAgents) {
  const live = new Set(liveAgents || []);
  return Object.keys(states || {})
    .filter((n) => !live.has(n)
      && Array.isArray(states[n] && states[n].pending)
      && states[n].pending.length > 0)
    .sort();
}

module.exports = {
  classifyPollution,
  OVERDUE_MS, RESEND_AFTER_MS, PREFIX,
  statePath, load, save, harvest, settle, alertLine, maybeSend,
};
