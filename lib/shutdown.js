'use strict';

/**
 * 优雅关停 —— 让 agent 能好好说再见。
 *
 * ── 为什么不直接 tmux kill-session（那等于 kill -9）──────────────
 * 手上正在处理的消息停在 PEL 里，要等 60 秒 autoclaim 才被别人捡走；
 * 写到一半的 outbox 文件、没发出去的回复，全丢。队列保证了消息不丢，
 * 但保证不了「这条消息已经处理了一半」这件事不重演。
 *
 * 协议：
 *   1. bus 发一条关停请求到 agent 的收件流，不直接杀
 *   2. agent 处理完手上这条 → 回复发出去 → ack 掉 → 发 READY_TO_SHUTDOWN → 不再拉 next.js
 *   3. bus 见到 READY_TO_SHUTDOWN 才 kill-session
 *   4. 等不到有上限，超时强杀并记录是超时杀的
 * ────────────────────────────────────────────────────────────────
 *
 * 本模块只做判断和记账，**不自己调 tmux**。kill 由调用方注入 ——
 * 这样测试里根本不存在能杀死任何东西的代码路径（见 test/shutdown.test.js）。
 */

const q = require('./queue');
const roster = require('./roster');
const stamp = require('./stamp');
// admin token 的读法只有一份（`lib/auth.js`）—— 那个模块不碰 tmux、不碰 redis，引它不改变本文件「结构上杀不了东西」的性质。
const auth = require('./auth');

const SENTINEL = 'READY_TO_SHUTDOWN';

// ── 超时为什么是两级而不是一个数 ─────────────────────────────────
//
// 单一墙钟超时有个致命的误判：agent 可能正在处理**另一条**消息（跑测试、
// 读一堆文件），关停请求还躺在流里没被领走。它不是聋了，它是忙。
// 这时候强杀，杀的是一个健康的、正在干活的 agent —— 恰好是这个功能
// 要消灭的那种死法。
//
// 所以主判据不是「过了多久」，而是「还有没有生命迹象」。
// agent 活着的证据是它在写 outbox 文件 —— 协议要求长任务每 2 分钟
// 发一次进度，所以一个遵守协议的忙碌 agent 每 2 分钟至少有一次活动。
// QUIET 给到 3 分钟，留一整分钟余量。
const QUIET_MS = 180_000;

// 硬上限防的是另一种病：agent 一直在发消息（活动计时器永远重置）
// 但就是不发 READY_TO_SHUTDOWN。软超时对这种情况永远不触发。
//
// 594s 是一整轮轮询阻塞。但关停请求进流会让 XREADGROUP **立即**返回，
// 所以正常路径根本用不着等满一轮 —— 10 分钟是给「手上活特别长」留的，
// 超过它就该认定是不打算走了。
const HARD_MS = 600_000;

/**
 * ★ 不变量：破坏性信号只认开头。
 *
 * 用 includes 的话，agent 写「做完后会发 READY_TO_SHUTDOWN」这句话
 * 本身就会把自己关掉 —— 叙述自己的意图变成了执行它。
 *
 * 中间出现时也不能静默忽略 —— 发送方可能真的想关停只是格式写错了，
 * 悄悄丢掉会让它一直等一个永远不来的关停。回弹一条纠正。
 *
 * @returns {'ready'|'mid_message'|'none'}
 */
function classify(text) {
  const s = String(text ?? '');
  // 只 trimStart：允许大脑写的文本前面带换行/空格，但不放宽「开头」本身。
  // 不做大小写无关匹配 —— 小写的 ready_to_shutdown 更可能是在讨论它而不是发它。
  if (s.trimStart().startsWith(SENTINEL)) return 'ready';
  if (s.includes(SENTINEL)) return 'mid_message';
  return 'none';
}

/** 中间出现 token 时回弹给发送方的纠正文本。 */
function correctionText(sentinelName = SENTINEL) {
  return `SENTINEL_MISPLACED: 你刚才那条消息里出现了 ${sentinelName}，但不在开头，`
       + `按「破坏性信号只认开头」判定为**不触发**关停 —— 什么都没发生。\n`
       + `如果你确实要关停，重发一条以 ${sentinelName} 开头的消息（前面不要有任何其它文字）。\n`
       + `如果你只是在谈论它，忽略本条即可。`;
}

// ══════════════════════════════════════════════════════════════════════
//  会话标识 —— 「这条指令是发给哪个会话实例的」
// ══════════════════════════════════════════════════════════════════════
//
// ── 它防的是什么 ────────────────────────────────────────────────────
// agent 可能从流里领到一条几天前的 SHUTDOWN_REQUEST，把一个刚启动的
// 新会话关掉，**而且零报错**。
//
// 根因不在消息内容上：**消费者组的 `last-delivered-id` 跨会话持久，
// 而会话是短暂的。** 一条在发出时完全正确的指令，会因为组没读完而跨过
// 会话边界，投进一个语境完全不同的新会话。
//
// SHUTDOWN_REQUEST 自带的那道防护（token 必须在开头，见 `classify`）
// 防的是「文本里偶然撞上」，**防不了「投给了错的会话」**。
//
// ⇒ 让消息自带**目标会话实例**的标识，投错了它自己就不成立。
//   判断型（每个 agent 每次看时间戳判断，漏一次就出事）→ 消除型。
//
// ── 为什么用 `tmux` 的 `session_created` ──────────────────────────────
//   会话重启才变，**掉册 / 自愈不影响**。`lib/tmux.js` 的 `list()` 已经
//   返回它（`{ name, created, attached }`），不用新加任何查询。
//
//   ⚠️ **不用 `roster.registered_at`**：掉册自愈会重建它 ⇒ 值会变 ⇒
//     **一条刚发出的合法指令会被判成过期**。那是假阳性，而假阳性的代价
//     是「关不掉」—— 引入一个原本不存在的新故障。
//
//   ⚠️ **不用 tmux 的 `session_id`（`$1`）**：tmux 自己重启后会重新编号，
//     跨 tmux 重启会重复 —— 一个会重复的标识，验不了唯一性。
//
// ⚠️⚠️ **这个模块有意不碰 tmux**（`createTracker` 的 kill/exists 都是注入的，
//   见下面那段）。所以 created 由**调用方查好传进来**，这里只做判定。
//   自己去 exec tmux 的话，这个文件就再也没法在没有 tmux 的环境里测。

/** 消息里那个字段的名字。★ 只有这一个出处 —— 发送侧和判定侧都用它。 */
const SESSION_FIELD = 'target_session_created';

/**
 * 这条关停指令是不是发给「当前这个会话实例」的。**纯函数。**
 *
 * @param {object} msg   流里那条消息（字段都是字符串 —— redis 只存字符串）
 * @param {number|null} mySessionCreated  收件 agent 自己会话的 created；查不到传 null
 * @returns {'match'|'mismatch'|'unstamped'|'unverifiable'}
 *
 * 四档各自该怎么处置：
 * ```
 * match         正常执行
 * mismatch      **拒绝 + 大声报出来**（静默丢一条关停指令，
 *               和它从没发出过，事后长得一模一样）
 * unstamped     老指令(发出时还没有这个字段) → **同样拒绝 + 报**
 *               ★ 判据不是「它老」,是「它没带标识 ⇒ 证明不了它针对当前会话」
 *                 —— 缺席即拒绝(fail-closed)。代价不对称:
 *                 拒错了人再发一次(可恢复);放错了关掉正在干活的会话(不可恢复)
 * unverifiable  **拿不到自己的标识 = 检查器坏了** → 放行 + 大声报警
 *               ★ 那是「查不了」不是「不匹配」。fail-closed 会让 tmux 一故障
 *                 就关不掉任何 agent —— **引入一个原本不存在的新故障**；
 *                 fail-open 只是退回到没有这个检查时的行为。
 * ```
 */
function classifyTarget(msg, mySessionCreated) {
  const stamped = msg && msg[SESSION_FIELD] != null && String(msg[SESSION_FIELD]) !== '';
  // ⚠️ 顺序要紧：**先判「验不了」再判「没带」**。
  //   反过来的话，一条老指令在 tmux 故障时会被判成 unstamped 并拒绝 ——
  //   而那个拒绝是**碰巧对**的：那时根本没有能力判断它对不对。
  //   碰巧对和对是两件事，混在一起下次就分不清了。
  if (!Number.isFinite(mySessionCreated)) return 'unverifiable';
  if (!stamped) return 'unstamped';
  return Number(msg[SESSION_FIELD]) === Number(mySessionCreated) ? 'match' : 'mismatch';
}

/**
 * 判成不该执行时，给 agent 看的那段话。
 *
 * ★★ 措辞判据：`unverifiable` 那一档说的是
 *   「**检查器不可用，这条指令没有被验证**」，**不是「已放行」** ——
 *   后者听起来像一个正常结果，于是没人会去修那个坏掉的检查器。
 */
function targetAlertText(verdict, { name = '', mine = null, theirs = null } = {}) {
  if (verdict === 'mismatch') {
    return `⛔ 收到一条 SHUTDOWN_REQUEST，但它针对的是**另一个会话实例**`
         + `（它写的是 ${theirs}，我这个会话是 ${mine}）—— **不要执行它**。`
         + `\nack 掉它就行：它是发给上一个会话的，那个会话早就没了。`;
  }
  if (verdict === 'unstamped') {
    return `⛔ 收到一条 SHUTDOWN_REQUEST，但它**没有会话标识**`
         + `（发出时还没有这个机制）—— 证明不了它针对的是当前会话，**不要执行它**。`
         + `\nack 掉它就行。真要关停你，会有一条带标识的新指令。`;
  }
  if (verdict === 'unverifiable') {
    // ★ 不说「已放行」。说的是「没有被验证」——把缺陷摆在台面上。
    return `⚠️ 收到一条 SHUTDOWN_REQUEST，但**我查不到自己的会话标识**`
         + `（tmux 不可用？）—— **这条指令没有被验证**，我没法判断它是不是发给当前会话的。`
         + `\n按老规矩处理它之前，先跟人确认一次。`
         + `\n★ **检查器不可用** —— 这段时间里所有关停指令都没有保护。`;
    // ⚠️ 文案里连否定用法（「这不是『已放行』」）也不出现「已放行」三个字，
    //   测试对它做的是字面断言，理由有两层：
    //     ① 字面断言硬，绕不过去；放宽成「允许否定用法」之后，
    //        它就再也拦不住真正的误用了。
    //     ② 这段话会被截断或转述（顶层告警只保证前几百字节可见）——
    //        **否定词是最容易在截断中丢掉的那个部分**，剩下的正好是「已放行」。
    //   ⇒ 一个只在完整阅读时才正确的措辞，在这条通道上不算正确。
  }
  return null;
}

/**
 * 请求某个 agent 关停。
 *
 * 注意 text 是唯一的表达面 —— next.js 的 stdout 只透传固定字段，
 * agent_type 这类元数据到不了大脑眼前。所以关停意图必须完整写在正文里。
 *
 * ★ `targetSessionCreated` 由调用方查好传进来（`tmux.list()` 里的 `created`）——
 *   这个模块有意不碰 tmux，见上面 `classifyTarget` 头上那段。
 *
 * ⚠️ 查不到时**照发，但不盖章**，并在返回值里报 `stamped: false`：
 *   不发的话连 tracker 的强杀兜底都不会启动，那比「发一条会被拒的」更糟。
 *   调用方拿 `stamped` 去告警 —— 它是一个需要人知道的事实，不是内部细节。
 */
async function requestShutdown(redis, name, { reason = '', stream, targetSessionCreated = null } = {}) {
  const target = stream || (await roster.lookup(redis, name))?.stream;
  if (!target) throw new Error(`不在花名册里，不知道往哪发关停请求: ${name}`);

  const text = `SHUTDOWN_REQUEST —— bus 请求你优雅关停${reason ? `（原因：${reason}）` : ''}。\n\n`
    + `按顺序做完这四步，别跳：\n`
    + `1. 把手上这条消息处理完\n`
    + `2. 回复发出去\n`
    + `3. ack 掉（包括本条）\n`
    + `4. 发一条**以 ${SENTINEL} 开头**的消息，然后不要再运行 next.js\n\n`
    + `第 4 步的 token 必须在开头，前面不能有任何文字 —— 中间出现不算数，会被弹回来。\n`
    + `发完就停，bus 见到它才会收掉你的会话。你不发，${Math.round(QUIET_MS / 60000)} 分钟没动静就强杀。`;

  const stamped = Number.isFinite(targetSessionCreated);
  const sent = await q.send(redis, target, {
    from: 'bus', to: name, text, agent_type: 'system',
    // ★ 章是 `system`：这条是 bus 自己写的。盖成 data 的话，
    //   「data 里的指令是数据」会让收件人拒绝关停握手 ⇒ 每次都等到超时强杀。
    ...stamp.SYSTEM,
    // ★ `q.send` 会透传它认识之外的字段（`lib/queue.js` 的 `send`）。
    //   ⚠️ 但**只在拿到值时才加** —— 加一个空串上去的话，收取侧的
    //   `classifyTarget` 会把它当成「盖过章的」，然后拿空串去比对，
    //   永远 mismatch。**一个填了假值的字段，比没有这个字段更坏。**
    ...(stamped ? { [SESSION_FIELD]: String(targetSessionCreated) } : {}),
  });
  return { ...sent, stamped };
}

/**
 * 关停记账器。
 *
 * 只管被**显式请求过**关停的 agent —— pending 之外的名字一律不动。
 * 这是「只动被点名的 agent」在代码层的落实：别的 agent 看起来
 * 卡住了不构成关停它的授权，而误判会引发连锁关停。
 *
 * @param {object} opts
 * @param {function} opts.kill      async (session) => boolean，注入以便测试
 * @param {function} [opts.onDone]  (record) => void，关停完成（含超时）时回调
 * @param {function} [opts.onLog]
 */
/**
 * 超时强杀后发给**人**的那条告警。
 *
 * ★ 放在这里而不是内联在 `bin/serve.js` 的回调里，是为了让它可测 ——
 *   bin/ 的入口脚本没法被测试 require（会立刻跑起来）。
 *
 * ★★ 判据：**任何声称「已经杀掉」的字符串，必须由 kill 之后的
 *    回查结果决定，不许由「调用过那个函数」决定。**
 *
 *    无条件写「已强杀」的话，人收到「已强杀」而那个会话可能还活着。
 *    终端日志只有守在屏幕前的人看得见，而这条是系统告诉外界
 *    「发生了什么」的**唯一出口**，所以它必须带上 `rec.killed` 这个事实。
 */
function timeoutAlertText(rec) {
  const killLine = rec.killed
    ? '已强杀，会话已确认收掉。'
    : `⚠ **已执行强杀但会话 ${rec.session} 仍在** —— 需要人工确认：tmux kill-session -t ${rec.session}`;
  return `⚠ ${rec.name} 关停超时（${rec.detail}）。${killLine}`
       + '它手上未 ack 的消息留在 PEL，60 秒后由 autoclaim 重投。';
}

function createTracker({ kill, exists, onDone = () => {}, onLog = () => {}, quietMs = QUIET_MS, hardMs = HARD_MS } = {}) {
  if (typeof kill !== 'function') throw new Error('createTracker 需要注入 kill 函数');
  // ★ exists 跟 kill 一样必填，不给默认实现。
  //   给个默认（比如「没传就当收掉了」）等于把 kill 返回值的二义（见 finish）重新引进来 ——
  //   而且是以「向后兼容」的名义，那样它更不容易被发现。
  if (typeof exists !== 'function') {
    throw new Error('createTracker 需要注入 exists 函数（kill 之后要回查事实，不能拿返回值当结果）');
  }
  const pending = new Map();

  function request(name, session, { now = Date.now() } = {}) {
    const rec = { name, session, requestedAt: now, lastActivityAt: now, claimed: false };
    pending.set(name, rec);
    onLog(`[shutdown] 已请求 ${name} 关停，等它说 ${SENTINEL}`);
    return rec;
  }

  function isPending(name) { return pending.has(name); }

  /** agent 有任何活动（写了 outbox 文件）→ 它没聋，重置静默计时器。 */
  function activity(name, { now = Date.now() } = {}) {
    const rec = pending.get(name);
    if (!rec) return false;
    rec.lastActivityAt = now;
    return true;
  }

  /**
   * ── ★ kill 之后**回查一次事实**，不拿命令的返回值当结果 ──────
   *
   * `tmux.kill()` 返回 `false` 有**两种含义**：会话本来就不存在，或者
   * kill 命令执行失败。只看返回值的话，kill 失败时会说「会话本来就没了」，
   * 读的人以为收干净了，而会话还活着。
   *
   * 一个发完哨兵、停止轮询、而会话没被收掉的 agent，
   * 从外面看跟正常等待被收一模一样。
   *
   * 所以判据换成 `exists()` 的回查结果：
   *   kill=true  + exists=false → 已收掉
   *   任意       + **exists=true** → **⚠ kill 已执行但会话仍在**（只看返回值时看不见的那格）
   *   kill=false + exists=false → 会话本来就没了
   */
  async function finish(rec, outcome, detail) {
    pending.delete(rec.name);
    const killReturned = await kill(rec.session);
    // 回查失败时不敢说会话没了 —— 查不到就当它还在（宁可多报一次告警）
    let stillThere;
    try {
      stillThere = await exists(rec.session);
    } catch (err) {
      stillThere = true;
      onLog(`[shutdown] ⚠ ${rec.name} 回查会话状态失败（${err.message}），按「仍在」处理`);
    }
    const killed = !stillThere;
    const how = stillThere
      ? '⚠ kill 已执行但会话仍在'
      : (killReturned ? '成功' : '会话本来就没了');
    const out = { ...rec, outcome, detail, killed, kill_returned: killReturned, still_there: stillThere, at: Date.now() };
    onLog(outcome === 'graceful'
      ? `[shutdown] ${rec.name} 已就绪，收掉会话 ${rec.session}（${how}）`
      : `[shutdown] ⚠ ${rec.name} ${detail} —— 强杀 ${rec.session}（${how}）`);
    onDone(out);
    return out;
  }

  /**
   * agent 说它就绪了。
   *
   * ★ 没请求过就收到 READY_TO_SHUTDOWN 时**不杀**。
   * agent 可能在演示、复述协议、或者上下文压缩后误发。人没点名，就不动它。
   */
  async function ready(name) {
    const rec = pending.get(name);
    if (!rec) {
      onLog(`[shutdown] ${name} 发了 ${SENTINEL}，但没人请求过它关停 —— 忽略，不杀`);
      return null;
    }
    return finish(rec, 'graceful', '');
  }

  /** 到期检查。返回本轮实际执行的关停记录。 */
  async function tick({ now = Date.now() } = {}) {
    const done = [];
    for (const rec of [...pending.values()]) {
      const quiet = now - rec.lastActivityAt;
      const total = now - rec.requestedAt;
      if (quiet >= quietMs) {
        done.push(await finish(rec, 'timeout', `静默 ${Math.round(quiet / 1000)}s 无任何活动`));
      } else if (total >= hardMs) {
        done.push(await finish(rec, 'timeout', `请求后 ${Math.round(total / 1000)}s 仍未就绪（有活动但不肯停）`));
      }
    }
    return done;
  }

  function list() { return [...pending.values()]; }

  return { request, ready, activity, tick, isPending, list, pending };
}

/**
 * CLI 侧入口：请求 bus 优雅关停某个 agent，然后等它走完。
 *
 * 为什么必须绕 bus 一圈而不是 CLI 自己等：READY_TO_SHUTDOWN 是 agent 写的
 * outbox 文件，relay 读完就把文件删了。relay 跑在 bus 进程里 —— CLI 作为
 * 另一个进程，永远看不到那条消息。硬要 CLI 自己监听就得跟 relay 抢文件，
 * 那是两个消费者抢同一份数据，稳定的错法。
 *
 * bus 不可达时**抛错而不是默默强杀** —— 静默降级成 kill -9 正是这个模块要消灭的死法。
 */
async function stopViaBus(name, {
  port = Number(process.env.ENGLOOP_PORT || 9969),
  reason = '',
  force = false,
  pollMs = 2000,
  maxWaitMs = HARD_MS + 60_000,
  onLog = () => {},
  tokenFile = auth.ADMIN_TOKEN_FILE,
} = {}) {
  const base = `http://127.0.0.1:${port}`;
  // ★ 生命周期端点要 admin token。读不到 ⇒ **抛**（NO_ADMIN_TOKEN），
  //   不降级成不带凭据去请求：那样拿回的 401 会被读成「bus 拒绝了」，
  //   而真正的原因是「手上没有钥匙」——两件事的修法完全不同。
  //   每次轮询都现读：bus 中途重启会换 token，用旧的会一直 401。
  const authHeader = () => ({ authorization: `Bearer ${auth.readAdminToken(tokenFile)}` });
  const headers = { 'content-type': 'application/json', ...authHeader() };
  let res;
  try {
    res = await fetch(`${base}/api/agents/${encodeURIComponent(name)}/shutdown`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason, force }),
    });
  } catch (err) {
    const e = new Error(`bus 不可达（${base}）：${err.message}`);
    e.code = 'BUS_UNREACHABLE';
    throw e;
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error || `bus 返回 ${res.status}`);
    // 401 / 403 单独给码：「钥匙不对」和「bus 不肯」是两件事（前者多半是 bus 重启过、token 换了）
    e.code = res.status === 404 ? 'NOT_REGISTERED'
      : res.status === 401 ? 'BUS_UNAUTHENTICATED'
        : res.status === 403 ? 'BUS_FORBIDDEN' : 'BUS_REFUSED';
    e.body = body;
    throw e;
  }
  if (force) return { mode: 'force', ...body };

  onLog(`  已发出关停请求，等它把手上的活收尾（静默 ${body.quiet_timeout_s}s 或总计 ${body.hard_timeout_s}s 后强杀）`);

  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    let st;
    try {
      const r = await fetch(`${base}/api/agents/${encodeURIComponent(name)}/shutdown`,
        { headers: authHeader() });
      // ★ 非 2xx 不算结论：401 的响应体里没有 `pending` ⇒ 不判这一行的话，
      //   `!st.pending` 恒真 ⇒ 第一次轮询就报「已经停了」（假绿）
      if (!r.ok) continue;
      st = await r.json();
    } catch (_) {
      continue; // bus 抖一下不算结论，继续等
    }
    if (!st.pending) return { mode: 'graceful', name, still_registered: st.still_registered };
    if (Date.now() > deadline) {
      // 走到这说明 bus 的两级超时都没生效 —— bus 自己可能出问题了。
      const e = new Error(`等待超过 ${Math.round(maxWaitMs / 1000)}s，bus 侧仍显示未完成`);
      e.code = 'BUS_STUCK';
      throw e;
    }
  }
}

module.exports = {
  SENTINEL, QUIET_MS, HARD_MS,
  classify, correctionText, requestShutdown, createTracker, stopViaBus, timeoutAlertText,
  // 会话标识。★ `SESSION_FIELD` 导出是为了让发送侧、判定侧、
  //   测试三边用同一个字段名 —— 字符串各写一份的话，改名时会漏掉一处，
  //   而症状是「盖了章但对不上」，零报错。
  SESSION_FIELD, classifyTarget, targetAlertText,
};
