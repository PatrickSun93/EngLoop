'use strict';

/**
 * 文件投递中继 —— agent 的发信通道。
 *
 * ── model-facing contract：文件投递必须保留 ──────────────────
 * v1 的规则「永远用 Write 工具，不要 shell 出去」是对的，必须活下来：
 * 把带引号的散文 JSON 塞进 argv 是引号地狱，而 bash 纪律又禁止那种
 * 复杂命令。所以大脑仍然写文件，只是文件之后发生的事变了 ——
 * 本模块 fs.watch 到文件，转成 XADD 进 Redis。
 * ───────────────────────────────────────────────────────────────
 *
 * 对应 v1 的 outbox-watcher.js（461 行）+ 常驻 agent 那一份 outbox watcher（164 行）。
 */

const fs = require('node:fs');
const path = require('node:path');
const q = require('./queue');
const roster = require('./roster');
const shutdown = require('./shutdown');
const threadAlert = require('./thread-alert'); const stamp = require('./stamp'); // 章：见主投递那处
// 只为 `KINDS`（kind 的合法值域，唯一出处）。UMD、零依赖，Node 引它成不了环。
const threads = require('../web/threads.js');
// 只为了 rooms.stream()（房间流名的唯一出处）。
// **循环依赖在 CommonJS 里不报错，只会让其中一方拿到半成品 exports，
// 某个函数悄悄变成 undefined。** 所以这里的依赖链每次改都要重查一遍：
//
//   当前链：`relay → rooms → roster → queue`（rooms 也 require roster，
//   为了查「谁有收件流」），而 roster/queue 都不引 relay，**没有环**。
//   ⚠️ 这里写的是链本身，不是「查过了」—— 改依赖时照着链重查，别信结论。
const rooms = require('./rooms');
// 只为 `add()`（打 🏁）。依赖链：
// `reactions.js` 顶上只有 `require('node:crypto')` 一行，引它不可能成环。
const reactions = require('./reactions'); const threadCount = require('./thread-count'); // 按 thread 数来回；依赖链 thread-count → queue / stamp / thread-alert / web/threads，都不引 relay

const DEBOUNCE_MS = 30;
const READ_RETRY = 5;
const RETRY_DELAY_MS = 100;

/**
 * 死信原文落盘。**通知里给路径，不是给截断的预览。**
 *
 * ── 为什么 ────────────────────────────────
 * 一条长回复 JSON 坏了 → 走下面 parse_error 那条路 →
 * 收件方如果**只收到前 200 字符**，后面的论点就丢了，
 * **而两边都不会知道错过了什么。**
 *
 * > **截断多少都可能正好切掉关键那句，而路径是定长的。**
 *
 * ⚠️ 落盘是**唯一**能保住内容的机会：上游 `readThenDelete()` 已经把原文件
 *   删掉了，`raw` 只活在内存里。这一步失败 = 那份内容彻底没了。
 *
 * ⚠️ 存 `.txt` 不存 `.json`：死信的内容**按定义是有问题的**（parse_error
 *   那种根本不是合法 JSON）。叫 `.json` 会让人拿 JSON 工具去开它、
 *   **然后失败第二次** —— 而第二次失败看起来像是「捞出来的东西也是坏的」。
 */
// ⚠️ **必须走 `ENGLOOP_DEADLETTER_ROOT`**，不能硬编码。
//   跟 `ENGLOOP_OUTBOX_ROOT` / `ENGLOOP_HISTORY_ROOT` / `ENGLOOP_OUTPUTS_ROOT` /
//   `ENGLOOP_THREAD_ALERT_DIR` 是同一条惯例。
//   ⇒ 没设就是默认路径 ⇒ **生产零影响**；而测试可以把死信落到自己的临时目录里，
//     不必往生产 `temp/deadletter/` 里扔真文件。
const DEADLETTER_ROOT = process.env.ENGLOOP_DEADLETTER_ROOT
  || path.join(__dirname, '..', 'temp', 'deadletter');

/** 文件名里的 agent 名。**它决定一个写盘路径，所以不信任它的形状。** */
function safeSeg(s) {
  return String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'unknown';
}

function saveDeadLetter(raw, { from, reason, root = DEADLETTER_ROOT, now = Date.now() } = {}) {
  try {
    const dir = path.join(root, safeSeg(from));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${now}-${safeSeg(reason)}.txt`);
    fs.writeFileSync(file, String(raw));
    return { ok: true, path: file };
  } catch (err) {
    // ★ 落盘失败**不能让死信处理本身炸掉** —— 那会连「有东西丢了」这件事
    //   一起丢掉。但也绝不静默：调用方负责把它说出去。
    return { ok: false, error: String(err.message) };
  }
}

/** 通知文本里那句「原文在哪」。落盘失败时说清**内容已经没了**。 */
function savedNote(saved) {
  return saved.ok
    ? `\n完整原文已存: ${saved.path}`
    : `\n⚠ 原文落盘失败（${saved.error}）—— **这份内容已经没有第二个副本了**，`
      + '上面的预览是仅存的部分。';
}

/**
 * v1 有 tryRepairOutboxText（~60 行）抢救大脑写坏的 JSON。
 * 保留这个能力，但只用在文件投递这条路上 —— MCP 那条走结构化参数，
 * 从源头没有这个问题。
 */
function tryRepair(text) {
  try {
    return JSON.parse(text);
  } catch (_) { /* 继续尝试修复 */ }

  // 最常见的坏法：text 值里有未转义的双引号
  const m = text.match(/^\s*\{([\s\S]*)\}\s*$/);
  if (!m) return null;
  const repaired = text.replace(
    /"text"\s*:\s*"([\s\S]*?)"\s*(\}|,\s*")/g,
    (_all, body, tail) => `"text":"${body.replace(/(?<!\\)"/g, '\\"')}"${tail}`,
  );
  try {
    return JSON.parse(repaired);
  } catch (_) {
    return null;
  }
}

async function readThenDelete(file) {
  for (let i = 0; i < READ_RETRY; i++) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      fs.unlinkSync(file);
      return raw;
    } catch (err) {
      if (err.code === 'ENOENT') return null; // 别人先捡走了
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return null;
}

// ══ worker 通路 ═══════════════════════════════════════════════
//
//   `resolveTarget` 认三种目标（房间 / 在册 agent / 人），这一支补上 `work:*` ——
//   编排者的唯一输出手段就是写 outbox，没有这一支它就没有路把活派给 worker。

/** job 的默认硬超时（跟 `worker-pool.js:108` 同源）与上限。 */
const WORK_TIMEOUT_DEFAULT_MS = 600_000;
// ── 上限等于池的默认超时，而**不调全局 `timeoutMs`** ──────────────────────────
//   `worker-pool.js` 的 `timeoutMs` 同时决定 `minIdleMs`（autoclaim 重投窗口，
//   = timeoutMs + 60_000）—— **改一个动两个**。per-job 覆盖只影响这一个 job 的
//   硬超时，重投窗口继续用池的全局默认。**这是选 per-job 而不是调全局的主要理由。**
// 🔴 上限不能高于池的窗口（比如 30 分钟就是个陷阱）：
//
//   `worker-pool.js`   minIdleMs: timeoutMs + 60_000   ← **池级**重投窗口
//   job 设 30 分钟、池的窗口 11 分钟 ⇒ **第 11 分钟 autoclaim 会重投它**
//   ⇒ 第二个 worker 开始跑**同一个 job**，而去重键**在并发窗口内不拦**
//     （同 job_id 并发投两次 ⇒ 真的跑两次）
//   ⇒ **两份并排跑到底：烧两份额度、副作用做两遍，而日志上只是「慢」。**
//
// ★ 所以「per-job 覆盖不影响 minIdleMs」是对的 —— 而它**恰恰是问题所在**：
//   不影响，就意味着**跑过头的那部分不受保护**。
// ⇒ 需要跑更久的 job：**拆小**。真要整体调大，那是改池的 `timeoutMs`
//   （**同时**动重投窗口），是另一件事。
const WORK_TIMEOUT_MAX_MS = 600_000;

// ── 「活 consumer」的判据 ────────────────────────────────────────────
//   🔴 **不许只看 consumers 数量。** 死掉的 consumer 不会自动从 XINFO 里消失：
//   一个挂掉的 `review-pool-<pid>` 可以在列表里留好几天。
//   ⇒ 判据是「**名字里带当前 bus 进程的 pid**，且 idle 小」。
//   ★ 而 relay 就跑在 bus 进程内 ⇒ `process.pid` 就是它自己的，零新机制。
const WORK_CONSUMER_MAX_IDLE_MS = 60_000;

/**
 * 这个 worker 池现在有活消费者吗？
 *
 * @returns {{live:true, consumer:string, idle:number}
 *         | {live:false, reason:string, detail:string}}
 *
 * ⚠️ 查不了（XINFO 抛异常、组不存在）**一律算「没活的」** ——
 *   跟 `check()` 里 `paneError` 那段同一个惯例：**「查不了」不许降级成
 *   一个具体答案**，而在这一档，安全的那一侧是「不入队」。
 *   （反过来把 job 投进一个没人读的流，症状是**什么都不发生** ——
 *     不报错、不超时、什么都不回，从外面看跟「worker 正在思考」一模一样。
 *     `bin/serve.sh` 里有同一段说明。）
 */
async function liveWorkConsumer(redis, type, { pid = process.pid, now = Date.now() } = {}) {
  const stream = `work:${type}`;
  const want = `${type}-pool-${pid}`;
  let rows;
  try {
    rows = await redis.xinfo('CONSUMERS', stream, stream);
  } catch (err) {
    // 组不存在 / 流不存在 / redis 出错 —— 三种都归「没活的」，但 detail 分得开。
    return { live: false, reason: 'no_group', detail: `XINFO CONSUMERS ${stream}: ${err.message}` };
  }
  const seen = [];
  for (const row of rows || []) {
    const o = {};
    for (let i = 0; i < row.length; i += 2) o[row[i]] = row[i + 1];
    const idle = Number(o.idle);
    seen.push(`${o.name}(idle=${Number.isFinite(idle) ? idle : '?'})`);
    if (o.name === want && Number.isFinite(idle) && idle < WORK_CONSUMER_MAX_IDLE_MS) {
      return { live: true, consumer: o.name, idle };
    }
  }
  return {
    live: false,
    reason: 'no_live_consumer',
    // ★ detail 里列出**看到了什么** —— 「一个都没有」和「有三个但全是死的」
    //   要人做的事完全不同，而只报「没有活的」把两者印成同一句话。
    detail: seen.length
      ? `池 ${stream} 里有 ${seen.length} 个 consumer，但没有 ${want}（或它 idle ≥ ${WORK_CONSUMER_MAX_IDLE_MS}ms）：${seen.join(' · ')}`
      : `池 ${stream} 一个 consumer 都没有 —— 这个池没开`,
  };
}

/**
 * 一条 outbox 是给 worker 的吗？给的话，目标合法吗？
 *
 * @returns {null} 不是给 worker 的（调用方继续走 resolveTarget 的三支）
 *        | {{stream, to, work, timeoutMs}} 可以入队
 *        | {{error, work, detail}} **不能入队，而且原因说得出来**
 *
 * 🔴 **失败不返回 `null`。** `null` 在 `resolveTarget` 里已经有含义了
 *   （「未知目标」→ 死信文案是「未知目标」）。两种失败共用一个字面值的话，
 *   人看到「未知目标」会去查「是不是写错名字了」，**而真相是「池没开」**。
 *   同一族的还有 `roster.lookup` → null、`stageDrift` → null、`ls temp/busy` 非空。
 */
async function resolveWork(redis, entry, opts = {}) {
  if (!entry || entry.work == null || entry.work === '') return null;
  const work = String(entry.work);

  // ── 三者互斥 ────────────────────────────────────────────────────
  //   `work` / `username` / `room_hash` 表达的是三个互不相容的意图。
  //   同时出现 ⇒ **直接拒绝**，不猜哪个优先 —— 猜错的表现是
  //   「消息静默去了别处」，而那正是这套协议里最难发现的一类错。
  const also = [];
  if (entry.username) also.push('username');
  if (entry.room_hash) also.push('room_hash');
  if (also.length) {
    return {
      error: 'ambiguous_target',
      work,
      detail: `同一条消息里同时出现了 work 和 ${also.join(' / ')} —— 这三者互斥，我不猜哪个优先`,
    };
  }

  if (!/^[a-z][a-z0-9_-]*$/.test(work)) {
    return { error: 'bad_work_type', work, detail: `work 类型名不合法：${JSON.stringify(work)}` };
  }

  // ── job_id 必须由发起方给 ──────────────────────────────────────
  //   🔴 **不自动生成。** 去重键是 `dedupe:worker:<type>:<job_id>`
  //   （`worker-pool.js`）—— 自动生成一个新的，等于**让去重永远不生效**，
  //   而它的表现是「同一个 job 跑了两遍，两遍都成功，没有任何报错」。
  //   ⇒ 一个静默失效的去重，比没有去重更坏。
  if (!entry.job_id) {
    return { error: 'missing_job_id', work, detail: 'work 消息必须带 job_id —— 它是去重键，我不替你生成一个' };
  }

  const live = await liveWorkConsumer(redis, work, opts);
  if (!live.live) return { error: live.reason, work, detail: live.detail };

  // ── per-job 超时 ───────────────────────────────────────────────
  let timeoutMs;
  if (entry.timeout_ms != null) {
    const t = Number(entry.timeout_ms);
    if (!Number.isFinite(t) || t <= 0) {
      return { error: 'bad_timeout', work, detail: `timeout_ms 不是正数：${JSON.stringify(entry.timeout_ms)}` };
    }
    // 超上限**直接拒绝**，不静默夹到上限 —— 夹住的话发起方以为自己拿到了要的时长。
    if (t > WORK_TIMEOUT_MAX_MS) {
      return {
        error: 'timeout_too_large',
        work,
        detail: `timeout_ms=${t} 超过上限 ${WORK_TIMEOUT_MAX_MS}`
          + '（= 池的 timeoutMs）—— **不能超过池的超时，否则重投窗口会先到 ⇒ 同一个 job 并发跑两份**。'
          + '我不替你夹到上限（夹住的话你以为自己拿到了更长的时间）；请拆小这个 job。',
      };
    }
    timeoutMs = t;
  }

  // ── job 指定的后端 —— 不在这个类型的 backends 里 ⇒ 入口拒（跟越界的 timeout_ms 同一种处理）。
  //   worker-pool 还会再拒一次（permanent）：消息也可能不经 relay 进流。不带 = claude（下面不往消息里写这个字段）。
  let backend;
  if (entry.backend != null && entry.backend !== '') {
    backend = String(entry.backend);
    let allowed = [];
    try { allowed = require('./agent-capabilities').backendsFor(work); } catch (e) {
      return { error: 'bad_backend', work, detail: `算不出 ${work} 能用哪些后端：${e.message}` };
    }
    if (!allowed.includes(backend)) {
      return { error: 'bad_backend', work, detail: `${work} 类型不能用后端 ${JSON.stringify(backend)}（能用的：${allowed.join(' / ')}）` };
    }
  }

  return {
    stream: `work:${work}`,
    to: `worker:${work}`,
    work,
    consumer: live.consumer,
    idle: live.idle,
    timeoutMs,
    backend,
  };
}

/**
 * 路由判定：
 *   有 room_hash          → 房间流
 *   username 在花名册里    → 那个 agent 的收件流
 *   username 是人          → orch:out（bus 推 WebSocket）
 *   都没有                → 死信
 *
 * v1 这里叫 deliverToUser：先查一次 v1 的项目归属表判断收件人是不是 agent，
 * 是就改投它的 inbox 文件，否则走 WebSocket。同一个逻辑，
 * 只是「是不是 agent」的判据从扫目录变成查花名册。
 */
async function resolveTarget(redis, entry) {
  if (entry.room_hash) {
    // ★ 房间流名走 `rooms.stream()` —— **约定的唯一出处**，别在这里自己拼。
    //
    //   在这里手拼 `` `room:${entry.room_hash}` `` 的话，一旦它跟 rooms.js 里的
    //   `stream()` 分叉，后果**正好是协议里用最重措辞警告的那个**：
    //   消息投进一个没人读的流，**房间里其他人永远看不到，而且没有任何报错**。
    //
    //   区别在于协议警告的是「人写错了 username」，而这里是**代码自己投错流**。
    //   **协议能拦住人，拦不住代码。**
    return { stream: rooms.stream(entry.room_hash), to: entry.room_hash };
  }
  if (entry.username) {
    const rec = await roster.lookup(redis, entry.username);
    // 在册 = 是个 agent，投它的收件流；不在册 = 是人，走出向流
    if (rec) return { stream: rec.stream, to: entry.username, agent: true };
    return { stream: 'orch:out', to: entry.username };
  }
  return null;
}

/**
 * 算 relay 计划 —— **谁该挂上、谁该摘掉**。纯函数，不碰 redis、不碰 relay 实例。
 *
 * ── 为什么它值得从 bin/serve.js 里抽出来 ──────────────────────────
 * 这是 bus 里**唯一一段「决定谁能说话」的逻辑** —— relay 没挂上的 agent，
 * 写进 outbox 的东西没人捡，而它自己完全不知道（poller 直连 redis，收消息
 * 一切正常）。**单向失聪，无报错。**
 *
 * 留在 `bin/serve.js` 里的话，**入口脚本 require 不了**（一 require 就
 * 把整个 bus 跑起来），于是整个仓库里**最关键的一段是最测不到的一段**。
 *
 * 测不到的代价有两种形态：组名分叉造成 XACK 跨组返回 0、消息无限重投；
 * 一个未定义标识符让 syncRelays 首次执行就抛异常
 * （外面有 try/catch，**「整个系统聋了」会被压缩成一行日志**）。
 *
 * ★ 抽的是**算计划**，不是**执行计划**。执行那半只是 Map 的增删，
 *   把它也抽进来就得把 relay 实例和 redis 连接拖进 lib，反而更难测。
 * ────────────────────────────────────────────────────────────────
 *
 * @param {object[]} opts.agents   花名册条目（要 name / type）
 * @param {Iterable<string>} opts.current  当前已挂着 relay 的名字
 * @param {string} opts.orchName   编排者的名字。**必传，不给默认** ——
 *   给默认等于在这里再埋一处 'JARVIS' 字面量，而且「没传就当是它」这种
 *   默认在错的时候看起来跟对的时候一模一样。
 * @returns {{want: Map<string,string>, add: [string,string][], remove: string[]}}
 */
function planRelays({ agents, current, orchName }) {
  if (!orchName) throw new Error('planRelays 需要 orchName（不给默认值，见注释）');

  // ★ 编排者常驻：**即使它掉出花名册，relay 也不摘。**
  //   否则它连「我掉册了」这句话都发不出来 —— 一个 agent 失去发言能力的
  //   同一时刻，也失去了报告这件事的能力。
  //   agent 没有这个待遇（掉册就摘），所以掉册的 agent 回册之后还要等下一轮
  //   syncRelays 才重新挂上，**最长 60 秒的尾巴，那期间写的东西照样没人捡**。
  const want = new Map([[orchName, roster.groupFor(orchName, 'orchestrator')]]);

  for (const a of agents) {
    // ★ 这个 continue 不是冗余，别删：编排者自己也在花名册里，而它的记录要是
    //   type 被写坏了，groupFor 会算出 `agent:JARVIS` 覆盖掉上面那行 —— 于是
    //   JARVIS 拿 `agent:JARVIS` 组去 XACK `orch` 组的 PEL。**XACK 跨组返回 0
    //   且不报错**，每条消息 60 秒后无限重投。
    if (want.has(a.name)) continue;
    want.set(a.name, roster.groupFor(a.name, a.type));
  }

  const cur = new Set(current);
  return {
    want,
    add: [...want].filter(([name]) => !cur.has(name)),
    remove: [...cur].filter((name) => !want.has(name)),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.outboxDir  监听目录
 * @param {string} opts.from       发送者名（写进消息的 from）
 * @param {object} opts.redis
 * @param {string} [opts.ackGroup]  ack 时用的消费者组，默认 orch
 * @param {function} [opts.onEvent] 观测回调
 */
/**
 * @param {string} [deadletterRoot] 死信落盘的根目录。
 *
 * ⚠️ **这个参数不是「为了可测」的装饰。** 没有它，跑一次全量测试就会往
 *   **生产**的 `temp/deadletter/<agent>/` 里写测试死信。
 *
 *   > **死信目录的全部用途是「这里面的每一条都是真的没人处理过」。**
 *   > 混进测试产物之后，人捞的时候分不出哪条是真的 ——
 *   > **而分不出的代价是他会把真的那条也当成测试残留。**
 *
 *   跟 `lib/queue.js` 那套「测试不许碰生产库」是同一条规矩，
 *   只是载体是文件系统。
 */
function startRelay({
  outboxDir, from, redis, ackGroup = 'orch', onEvent = () => {},
  deadletterRoot = DEADLETTER_ROOT,
  // ★ 同 `deadletterRoot`：可注入不是装饰。不给这个口子，跑一次全量就会让
  //   某个真 agent 下一轮收到几条凭空冒出来的漏填告警 ——
  //   而它指的那几条消息根本不存在，他会去翻自己的发件记录然后什么也找不到。
  threadAlertDir = undefined, doneVerifier = null, // ← 独立核验（`lib/done-verify.js` 的 createLauncher）。不传 ⇒ 带 evidence 的完成报告标 verify:not_wired，照旧打 🏁
}) {
  fs.mkdirSync(outboxDir, { recursive: true });

  let timer = null;
  let draining = false;

  /** ack 字段规范化成数组：没写 = 空数组，写了单个 = 单元素数组。 */
  function ackList(entry) {
    if (entry.ack === undefined || entry.ack === null) return [];
    return Array.isArray(entry.ack) ? entry.ack : [entry.ack];
  }

  /**
   * ★ 只认 "<stream>:::<id>" 复合格式。
   *
   * 不对裸 ID 默认回退到 orch:in:human —— agent 的消息来自
   * orch:in:agent，XACK 一个不存在的 ID **返回 0 且不报错**，
   * 于是静默失败，每条 agent 消息 60 秒后无限重投。
   * 猜错比报错危险得多，所以这里不猜。
   *
   * 返回 {total, ok}。ok 只数**真的生效了**的：XACK 返回 0（ack_noop）
   * 算失败，因为健康系统里它不该出现 —— 被重投的消息其 ack 一定还在
   * PEL 里（正因为没 ack 成才被重投），XACK 会返回 1；autoclaim 换了
   * 消费者也不影响，XACK 按组不按消费者。所以 noop 出现就意味着流名
   * 或组名写错了，那正是最该让人看到原文的情况。
   */
  async function runAcks(entry) {
    const acks = ackList(entry);
    let ok = 0;
    for (const a of acks) {
      const id0 = String(a);
      if (!id0.includes(':::')) {
        onEvent({ type: 'ack_failed', id: id0, error: '缺少流名，需要 "<stream>:::<id>" 格式' });
        continue;
      }
      const idx = id0.indexOf(':::');
      const s = id0.slice(0, idx);
      const id = id0.slice(idx + 3);
      try {
        const n = await q.ack(redis, s, ackGroup, id);
        // XACK 返回 0 = 那条消息不在这个组的 PEL 里（流名或组名不对）。
        // 不报错但也没生效，必须显式说出来。
        if (n === 0) {
          onEvent({ type: 'ack_noop', stream: s, id, group: ackGroup });
        } else {
          ok++;
          onEvent({ type: 'acked', stream: s, id });
        }
      } catch (e) {
        onEvent({ type: 'ack_failed', id: id0, error: e.message });
      }
    }
    return { total: acks.length, ok };
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      const files = fs.readdirSync(outboxDir).filter((f) => f.endsWith('.json')).sort();
      for (const f of files) {
        const full = path.join(outboxDir, f);
        const raw = await readThenDelete(full);
        if (raw === null) continue;

        const entry = tryRepair(raw);
        if (!entry) {
          // 绝不静默丢失：坏 JSON 回弹给发送者，让它有机会改正
          //
          // ★ 原文落盘 + 通知里给路径。**预览和路径两个都要**：
          //   预览让人一眼看出是哪一条，路径保证没被截断的那份还在
          //   （只给 200 字符的话，一整个论点可以全丢在截断之后）。
          const saved = saveDeadLetter(raw, { from, reason: 'parse_error', root: deadletterRoot });
          const parseErrText = `PARSE_ERROR: 你写的 ${f} 不是合法 JSON，已丢弃。原文前 200 字符：\n`
                             + `${raw.slice(0, 200)}${savedNote(saved)}`;
          const targets = ['orch:in:human'];
          await q.send(redis, 'orch:in:human', {
            from: 'system',
            to: from,
            text: parseErrText,
            agent_type: 'system', ...stamp.SYSTEM,
          });

          // ★ 也发给写坏它的那个 agent。
          //
          //   只发 orch:in:human 的话，那条消息 `to` 写着 agent 名，
          //   **却投进了编排者的流**。后果：**写坏 JSON 的 agent 永远不知道
          //   自己写坏了**，它以为消息发出去了（危险的不是
          //   发不出去，是以为发出去了），只能靠编排者转告。
          //
          //   ⚠️ 编排者不重复发：它的入站流是 orch:in:agent，但 orch:in:human
          //   **也是它读的** —— 上面那条它本来就收得到。再发一条会让它以为
          //   写坏了两个文件。**只有 agent 需要第二条，因为 agent 读不到 orch:in:human。**
          //
          //   编排者那条保留不动：**队伍里出了什么事它要知道**，而且
          //   现有断言都压在那条上。这是「多一个目标」，不是「改目标」。
          const author = await roster.lookup(redis, from);
          const notifyAuthor = Boolean(author) && author.type !== 'orchestrator';
          if (notifyAuthor) {
            await q.send(redis, author.stream, {
              from: 'system',
              to: from,
              text: parseErrText,
              agent_type: 'system', ...stamp.SYSTEM,
            });
            targets.push(author.stream);
          }

          // ★ 投递目标进事件。**事件里看不出投给了谁，投错就藏得住**
          //   —— 只有 file / saved 的话，那两个字段无论投对投错都长得一样。
          //   author_notified 单独给一位：**「不在册所以没通知到」和「通知到了」
          //   必须分得开**，否则又是一次「查不了」被读成「没事」。
          onEvent({ type: 'parse_error', file: f, saved: saved.ok ? saved.path : null,
                    save_error: saved.ok ? undefined : saved.error,
                    delivered_to: targets, author_notified: notifyAuthor });
          continue;
        }

        // ★ 纯 ack：没有收件人，也没有话要说，只是要 ack 掉一条无需回复的消息。
        //
        // 「发出去才 ack」（见下面绑在 q.send 之后的那段）防的是
        // 「有话要说、却没送出去就 ack 了」。它不该管「本来就没话说」
        // 这一半 —— 没有这个分支的话，无收件人的文件先被死信分支截住，
        // ack 那段代码根本执行不到。后果是每 ack 一条无需回复的消息，
        // 就得凭空造一条新消息发给别人，
        // 对方又得 ack 它，噪音自我繁殖。
        //
        // 口子开到最窄，四条同时满足才允许跳过投递：
        //   text 为空 + 无 username + 无 room_hash + 确实带了至少一个 ack
        // 放宽其中任何一条，前一半就重新暴露 —— 比如只判 text 为空
        // 而不管 username，一条写错收件人的空消息就会被静默 ack 掉，
        // 那才是真丢消息。没带 ack 的空文件什么都不表达，照旧走死信
        // （绝不静默丢失），这里加的是一个更窄的前置分支，
        // 不是放宽死信条件。
        //
        // ★ 第四条判的是**规范化后的长度**，不是 Boolean(entry.ack)。
        //   `{"text":"","ack":[]}` 里空数组是 truthy，会从 Boolean 底下
        //   钻过来，然后一条 ack 都不执行就把文件删了 —— 正是这一条要
        //   防的那件事，被一个 truthy 的空值绕过去。
        const acks = ackList(entry);
        const isAckOnly = String(entry.text ?? '') === ''
          && !entry.username
          && !entry.room_hash
          && acks.length > 0;
        if (isAckOnly) {
          const { ok } = await runAcks(entry);

          // ★ 一条都没 ack 成 = 这个文件的全部意图都没实现，原文必须留下。
          //
          // 跳过投递换来的是「没有收件人也能 ack」，不是「可以静默丢文件」。
          // 全失败时发送方以为自己 ack 掉了、实际一条没成，它不会知道 ——
          // 只有死信流能把原文交还给人。事件日志不够：日志能看，
          // 但捞不回来。
          if (ok === 0) {
            const saved = saveDeadLetter(raw, {
              from, reason: 'ack_only_all_failed', root: deadletterRoot,
            });
            await q.send(redis, 'deadletter', {
              from, text: `${raw.slice(0, 2000)}${savedNote(saved)}`, agent_type: 'system',
            });
            onEvent({ type: 'deadletter', file: f, reason: 'ack_only_all_failed',
                      saved: saved.ok ? saved.path : null,
                      save_error: saved.ok ? undefined : saved.error });
            continue;
          }

          // 部分成功不进死信：死信的语义是「这个文件完全没被处理」，
          // 混进「处理了一半」的，人捞出来重放时无法判断该不该重放，
          // 而死信的全部价值就是可安全恢复。没 ack 成的那几条会自然
          // 重投（60 秒后回来），系统自愈，不需要人介入。
          // ok < total 从事件里一眼可见，每条失败的 ID 另有
          // ack_failed / ack_noop 说明原因。
          onEvent({ type: 'ack_only', file: f, ok, total: acks.length });
          continue;
        }

        // ── worker 通路 —— **早返回，一个字节都不碰下面那个共享 payload** ──
        //
        //   下面那个 `q.send` 拼的是「给人 / 给 agent」的形状
        //   （from/to/text/agent_type/room_hash/reply_to/kind/expects_reply/done…），
        //   而 worker 池要的是 `{ text, job_id, cwd }`（见 `worker-pool.js`）。
        //
        //   ★ 走早返回、自己 send，于是「不要碰那几份 payload 白名单」
        //     **在结构上就做不到违反** —— 把一条纪律换成了一个做不到。
        //
        //   ⚠️ 而 `job_id` 必须原样带上：worker 的去重键是
        //     `dedupe:worker:<type>:<job_id>`。不带的话去重永远不生效，
        //     表现是**同一个 job 跑两遍、两遍都成功、没有任何报错**。
        //     （`resolveWork` 里已经拒绝了缺 job_id 的消息，这里是第二道。）
        const workTarget = await resolveWork(redis, entry);
        if (workTarget) {
          if (workTarget.error) {
            // 🔴 失败**不静默排队**（`bin/serve.sh` 记着同一个坑）：
            //   job 进了一个没有任何消费者的 work 流，**不报错、不超时、
            //     什么都不回**，从外面看跟「worker 正在思考」一模一样。
            //
            // ★ 两半都要：**回报**（告诉发起方，判断型）+ **deadletter**
            //   （原文还在，查证型）。只留前者的话，发起方漏读那条消息，
            //   这个 job 就彻底没了。
            const saved = saveDeadLetter(raw, {
              from, reason: `work_${workTarget.error}`, root: deadletterRoot,
            });
            const rejectText = `❌ **job 没有入队**（work:${workTarget.work}）\n`
                             + `原因：${workTarget.detail}\n`
                             + `job_id：${entry.job_id || '(缺失)'}\n`
                             + `${savedNote(saved)}`;
            const workTargets = ['orch:in:agent'];
            // ★ 编排者读 `orch:in:agent`：队伍里出了什么事它要知道。**这条保留。**
            await q.send(redis, 'orch:in:agent', {
              from: 'system',
              to: from,
              text: rejectText,
              agent_type: 'system',
              ...stamp.SYSTEM,
            });

            // ── 🔴 第二条：投给**发起方自己的收件流** ────────────────────
            //
            //   `to: from` 只是消息体里的一个字段 —— **它不决定投进哪条流**。
            //   一条 `to: 'dev'` 的消息躺在 `orch:in:agent` 里，dev 永远读不到：
            //   它读的是 `agent:dev:in`。
            //
            //   ⚠️ 上面 `parse_error` 路径的 `notifyAuthor` 那段是同一个洞的同一个修法：
            //     不补这一条，发起方会以为消息发出去了。
            //
            //   ★ 复用那段的**形状**（from:'system' + to:from + deadletter）时，
            //     必须连它的**补丁**一起复用。补丁长得像「额外的代码」，
            //     不像「形状的一部分」—— 而它恰恰是那个形状被修好的那一半。
            //     少了它：回报发出去了、deadletter 写了、编排者也看见了，
            //     **而发起方收不到**。
            //
            //   ⚠️ 编排者**不重复发**：它读 `orch:in:agent`，上面那条已经到了。
            const author = await roster.lookup(redis, from);
            const notifyAuthor = Boolean(author) && author.type !== 'orchestrator';
            if (notifyAuthor) {
              await q.send(redis, author.stream, {
                from: 'system',
                to: from,
                text: rejectText,
                agent_type: 'system',
                ...stamp.SYSTEM,
              });
              workTargets.push(author.stream);
            }
            onEvent({ type: 'work_rejected', file: f, work: workTarget.work,
                      reason: workTarget.error, detail: workTarget.detail,
                      saved: saved.ok ? saved.path : null,
                      save_error: saved.ok ? undefined : saved.error,
                      // ★ 投给了谁进事件 —— 理由同 parse_error 那段：
                      //   事件里看不出投给了谁，投错就藏得住。
                      //   `author_notified` 单独给一位：「不在册所以没通知到」
                      //   和「通知到了」必须分得开。
                      delivered_to: workTargets, author_notified: notifyAuthor });
            // ★ 拒绝也要 ack：这条 outbox **处理完了**（结论是「不投」）。
            //   不 ack 的话它 60 秒后重投，而重投的结果一模一样 —— 无限重试。
            await runAcks(entry);
            continue;
          }

          const sentWork = await q.send(redis, workTarget.stream, {
            from,
            ...stamp.AGENT,
            to: workTarget.to,
            text: String(entry.text ?? ''),
            job_id: entry.job_id,
            // ★ `cwd` 透传：worker 在哪棵树上干活由 job 说了算
            //   （`worker-pool.js` 的 `runCwd = msg.cwd || cwd`）。
            //   ⚠️ 不存在的路径 `worker-pool.js` 那一层会直接报错 —— 已有，
            //     这里**不重复校验**（第二份实现会跟它分叉）。
            ...(entry.cwd ? { cwd: String(entry.cwd) } : {}),
            // ★ per-job 超时。`resolveWork` 已经校验过范围。
            //   🔴 全局 `timeoutMs` 一个字不动 —— 它同时决定 `minIdleMs`（重投窗口）。
            ...(workTarget.timeoutMs ? { timeout_ms: workTarget.timeoutMs } : {}),
            // 后端透传（resolveWork 已按能力表校验过）；不带就不写这个字段。
            ...(workTarget.backend ? { backend: workTarget.backend } : {}),
          });
          await runAcks(entry);
          onEvent({ type: 'work_queued', file: f, stream: workTarget.stream,
                    work: workTarget.work, job_id: sentWork.job_id,
                    consumer: workTarget.consumer, idle: workTarget.idle });
          continue;
        }

        const target = await resolveTarget(redis, entry);
        if (!target) {
          // 死信：未知目标绝不静默丢失
          const saved = saveDeadLetter(raw, { from, reason: 'no_target', root: deadletterRoot });
          await q.send(redis, 'deadletter', {
            from, text: `${raw.slice(0, 2000)}${savedNote(saved)}`, agent_type: 'system',
          });
          onEvent({ type: 'deadletter', file: f, reason: 'no_target',
                    saved: saved.ok ? saved.path : null,
                    save_error: saved.ok ? undefined : saved.error });
          continue;
        }

        // ★★ `reply_to` / `kind` 先算成局部变量，再**同时**喂给下面的 payload
        //   和投递后那个漏填检查 —— 两处必须是同一个值，不能各算各的。
        //
        //   ⚠️ 检查那边要是照 `entry.kind` 原值判：一个拼错的 `"notic"`
        //   会被这里丢掉（流里没有 kind ⇒ 网页渲染成 orphan、打红标签），
        //   而检查那边认为「他标了 notice，不用提醒」——
        //   **网页红着，告警是绿的。** 两边不一致比没有告警更坏，
        //   因为看到的每一次「没问题」都在教人这个检查器可以信。
        //
        //   同一事实不在两处表述，代价只是两个变量。
        const replyTo = entry.reply_to ? String(entry.reply_to) : undefined;
        // ★★ `status` ——「纯状态、零信息量」那一档：
        //   上线报到、自检通过、心跳。这类消息没有真正的信息量，
        //   渲染成一个小小的 notification 就够了。
        //
        //   ⚠️ 值域**不在这里定义** —— 唯一出处是 `web/threads.js` 的 `KINDS`。
        //   在这里写第二份数组的话，加一个新值时很容易漏改某一处
        //   （比如 `bin/serve.js`），而少改任何一处都不报错。
        const kind = threads.KINDS.includes(entry.kind) ? entry.kind : undefined;
        // ★★ `done` ——「这条是任务完成报告」。
        //
        //   判据走 `threads.isDone()`（唯一出处，前后端共用）。**不在这里
        //   自己写 `entry.done === true`** —— agent 的 outbox 是 JSON，
        //   写 `"done": "true"` 和 `"done": true` 都很自然，而只认后者的话
        //   表现是**通知不弹、🏁 不打，零报错**。规范化只该发生一次。
        //
        //   ⚠️ 它跟 `kind` 是**正交**的两个维度，不是第五个 kind ——
        //   为什么，写在 `web/threads.js` 的 `isDone` 头上（简版：塞进 kind 会
        //   让完成报告从它自己的 thread 里掉出来，而 🏁 正需要那个 thread 的根）。
        const done = threads.isDone(entry);
        // ★★ `needs_decision` ——「这条话在等 Patrick 拍板」。判据走 `threads.needsDecision()`（唯一出处）。
        //   跟 `expects_reply` 的区别：**不看 room_hash**，房间、私聊、work 目标都透传 ——
        //   那正是私聊缺口的修法。只在真时写字段、值固定 `'true'`，绝不写 `'false'`（流里它是 truthy 字符串）。
        const needsDecision = threads.needsDecision(entry);
        // ★ 完成报告核不核 ——
        //   值写进流（`verify` 字段），前端据它决定通知弹不弹、写不写「未验证」，编排者据它决定转不转达。
        //   ⚠️ 没传 doneVerifier 的 relay（测试、老调用方）**不装成核过**：标 not_wired、照旧打 🏁。
        const doneVerify = require('./done-verify');
        const verifyMode = done ? doneVerify.modeOf(entry.evidence, { wired: Boolean(doneVerifier) }) : null;

        const sent = await q.send(redis, target.stream, {
          from,
          // ★ 章：`from` 是按 outbox 目录名定的（agent 改不了），
          //   `sender_type` 跟它说同一件事 ——「这是一个 agent 说的」。进了房间流也带着，扇出时原样转给每个收件人。
          //   relay 自己写的纠正 / 回弹盖 `system`。**只加字段，不改投递逻辑。**
          ...stamp.AGENT,
          to: target.to,
          text: String(entry.text ?? ''),
          agent_type: entry.agent_type || 'orchestrator',
          job_id: entry.job_id,
          // ★★ `room_hash` 必须跟着走。
          //
          //   这里是**手工拼 payload**，字段是白名单式的一个个列出来的 ——
          //   漏列 `room_hash` 的话，**agent 发的房间消息投进了
          //   正确的房间流，但消息体里没有 room_hash。**
          //
          //   后果正是协议里用最重措辞警告的那个：
          //   **房间里其他人看不到，而且没有任何报错。**
          //   区别只在于：协议警告的是「人写错了 username」，
          //   **这里是代码自己把字段丢了。协议能拦住人，拦不住代码。**
          //
          // ⚠️ **这个形状会再长回来。** `q.send` 支持透传不等于问题解决了 ——
          //   **下一个手工拼 payload 的调用方照样会丢字段**，而它同样不会报错。
          //   「函数支持透传」和「调用方真的传了」是两件事
          //   （`runPrint` 收 `allowedTools` 也可以收很久而**没有任何调用方传过它**）。
          //
          //   不做整体透传是有意的：那要先定义「哪些字段该透传」，
          //   **是决策不是 bug**。
          ...(entry.room_hash ? { room_hash: entry.room_hash } : {}),
          // ★★ `reply_to`（thread）—— 上面那段警告的同一个形状。
          //
          //   漏掉它的后果和 room_hash 同构：
          //   **回复投进了正确的房间流，消息体里却没有 reply_to
          //   → 前端把它当顶层显示，零报错。**
          //
          //   仍然不改成整体透传 —— 「哪些字段该透传」是决策不是 bug。
          //   所以这里继续一个个列。
          //   （值算在上面那个 `replyTo` 局部变量里 —— 投递后的漏填检查
          //     必须判**同一个值**，理由见那段。）
          ...(replyTo ? { reply_to: replyTo } : {}),
          // ★★ `kind`（thread 模型）—— 同一个形状。
          //
          //   值域：`topic` / `reply` / `notice`。**agent 唯一能标 notice 的地方就是这里** ——
          //   而通知**全是** agent 发的，所以漏掉这一行 = 通知分类只对人成立 = 等于没做。
          //
          // ⚠️ 只透传**认识的值**，不认识的一律丢掉（不是原样透传）：
          //   一个拼错的 `kind: "notic"` 原样传下去，前端会落到「未知分类」，
          //   而那跟「没标」在渲染上是两回事 —— **让它退化成「没标」，
          //   于是它走违规那条可见路径，人看得见自己拼错了。**
          //   （白名单在上面那个 `kind` 局部变量里过了一遍，这里只放结果。）
          ...(kind ? { kind } : {}),
          // ★★ `expects_reply`（防广播风暴）—— 同一个形状。
          //   漏掉它的后果不是显示错位，是**自激**：房间流里没有这个字段
          //   → 扇出时判不出「不要求回复」→ agent 互相回复的回声链长回来。
          //
          // ★★★ 只在**房间消息**上加，而且这个条件是语义性的、不是防御性的：
          //
          //     私聊  = 派活   → 默认**要**回（协议里「收到活要回」那条）
          //     房间  = 知会   → 默认**不**要回
          //
          //   给私聊也盖一个 `expects_reply: false` 会把「收到活要回」整个关掉 ——
          //   agent 从此收到活也不吭声，**而那是比广播风暴更安静的坏**。
          //   两种消息在这个字段上默认值相反，所以它只能挂在其中一边。
          //
          //   ⚠️ 值走 `rooms.expectsReply()` 规范化后再写进去，不是原样透传：
          //   agent 在 draft 里写的可能是字符串 `"true"`，也可能是布尔；
          //   而不规范化的话，房间流里就会同时存在 `'true'` / `'True'` / `true`
          //   三种写法，**下游每个读者都得各自猜一遍**。判据只有一处，
          //   规范化也就只该发生一次 —— 在写进流的那一刻。
          ...(entry.room_hash ? { expects_reply: rooms.expectsReply(entry) } : {}),
          // ★★ `done` —— 同一个「手工白名单会漏字段」的形状。
          //   漏掉它的后果：agent 报了完成，**通知不弹、🏁 不打，而且
          //   刷新页面之后也还是没有** —— 这一条连「刷新前后不一致」
          //   那点可见性都没有，是纯静默。
          ...(done ? { done: true } : {}),
          // ★★ `needs_decision` —— 同一个手工白名单；漏了零报错，界面上就是看不见（见上面局部变量）。
          ...(needsDecision ? { needs_decision: 'true' } : {}),
          // ★ `verify`（见上面 verifyMode 那段）。只挂在 done 上 —— 不是完成报告就没有「核没核」。
          ...(verifyMode ? { verify: verifyMode } : {}),
        });

        // ★ 发出回复 = 处理完成 → 顺带 ack 掉对应的入向消息。
        //
        // 为什么不做成一条独立的 ack 命令让大脑自己调：那是多一步，
        // 而大脑漏掉一步的概率不低（漏了的话每条消息
        // 60 秒后被重投、处理两遍）。绑在发送动作上语义也更准 ——
        // 崩溃时没发出回复，就不会 ack，消息自然会被重投。
        await runAcks(entry);

        onEvent({ type: 'relayed', file: f, stream: target.stream, job_id: sent.job_id });

        // ── 🏁 打在 thread 的根上 ──────
        //
        // ★★ **为什么在后端打，不在前端打。**
        //   需求是「完成的 thread 第一条上有个标记」。前端打的话，那个标记
        //   只在**当时开着页面的浏览器**里产生 —— 人睡觉时 agent 报的完成，
        //   第二天翻回去看是**没有标的**。而「翻回去看昨晚谁干完了」
        //   恰恰是这个标记最有用的时刻。
        //   ⇒ 标记是事实，事实在消息到达时就该落盘，不该取决于谁开着页面。
        //   （通知那一半只能在前端 —— 那是浏览器 API。两半分家是对的。）
        //
        // ★ anchor 取 `replyTo || 自己`。⚠️ 「`replyTo` 就是根」**只对网页发的回复成立**：
        //   网页回复时 `reply_to` 被归一到 thread 的根（`threads.replyTargetIdOf`）。
        //   **agent 填的 `reply_to` 是它收到的那条**（`bin/next.js` 的 room_msg_id / dm_msg_id），
        //   多层链里那是父、不是根 ⇒ 这时 🏁 打在父上。根的映射在 `lib/thread-count.js` 里有，这里有意没用（不改 🏁 的锚点）。
        //
        // ⚠️ 私聊的锚点是 job_id、房间的锚点是 stream id ——
        //   这个「哪一种锚点取哪个字段」的分叉，`lib/reactions.js` 的 KEY
        //   注释里写着：拿得到还不存进去，就是在赌两个 id 空间不会撞。
        //   所以 scope 跟着一起传，不是可选的。
        //
        // 🚫 打标失败**不能**让这条消息的投递失败 —— 消息已经送出去、已经
        //   ack 过了。这里抛出去只会让下一条消息也不被处理，而代价仅仅是
        //   少了一个装饰性标记。所以 catch 掉，但**要说出来**（onEvent），
        //   不然「没打上」和「没报完成」在界面上同形。
        if (done && verifyMode === doneVerify.VERIFY.PENDING) {
          // ── 带 evidence ⇒ **先不打 🏁**：打 ⏳、另起进程核（不阻塞 relay），核完由子进程换标记 ──
          //   anchor 的算法跟下面打 🏁 那支**同一个**（前端 onDoneMessage 也按它刷新反应条）。
          const isRoom = Boolean(entry.room_hash);
          const anchor = replyTo || (isRoom ? sent.id : sent.job_id);
          try {
            const r = await doneVerifier.begin({
              from, to: target.to, stream: target.stream, scope: isRoom ? 'room' : 'dm',
              anchor: String(anchor), reply_to: replyTo || null, room_hash: entry.room_hash || null,
              evidence: entry.evidence, job_id: sent.job_id,
            });
            onEvent({ type: 'done_verify_started', anchor: String(anchor), job_id: sent.job_id,
              started: r.started, pid: r.pid, log: r.logFile });
          } catch (err) {
            // 起核验失败**不能**让投递失败（消息已经送出、ack 过了）—— 但要说出来，⏳ 可能挂住了
            onEvent({ type: 'done_verify_failed', anchor: String(anchor), job_id: sent.job_id,
              error: String(err.message || err) });
          }
        } else if (done) {
          const isRoom = Boolean(entry.room_hash);
          const anchor = replyTo || (isRoom ? sent.id : sent.job_id);
          try {
            await reactions.add(redis, {
              scope: isRoom ? 'room' : 'dm',
              anchor: String(anchor),
              emoji: '🏁',
              // ★ `by` 写死 'system'：界面上「谁打的」这一栏要能把它跟
              //   Patrick 自己点的区分开。同一个 emoji 两个来源而分不清，
              //   就退回成了 ✅ 那个问题。
              by: 'system',
            });
            onEvent({ type: 'done_marked', anchor: String(anchor),
              scope: isRoom ? 'room' : 'dm', job_id: sent.job_id });
          } catch (err) {
            onEvent({ type: 'done_mark_failed', anchor: String(anchor),
              job_id: sent.job_id, error: String(err.message || err) });
          }
        }

        // ★★ 按 thread 数 agent 来回（`lib/thread-count.js`）—— 超过上限给人发一条 system 告警。
        //   **只告警，不拦**：消息上面已经发出去、ack 过了，这里不碰投递，也不碰 reply_to。
        //   `recordAndAlert` 永远不抛（失败走 onEvent `thread_count_failed`）—— 理由同上面打 🏁 那段：
        //   抛出去只会让这一轮 drain 里后面的文件不被处理，换来的仅仅是少数一次。
        //   判的是**写进流里的**那份（`replyTo` / `kind` 两个局部变量），同漏填检查那段的理由。
        await threadCount.recordAndAlert(redis, {
          scope: entry.room_hash ? threadCount.roomScope(entry.room_hash) : 'dm',
          id: entry.room_hash ? sent.id : sent.job_id,
          reply_to: replyTo, from, sender_type: stamp.AGENT[stamp.SENDER_FIELD], kind,
        }, { onEvent, text: String(entry.text ?? '') });

        // ★★ 漏填 thread 记一笔 ——
        //   **挂在这里的理由和下面那个关停哨兵是同一条**：relay 是 per-agent 的、
        //   `from` 由目录名推断伪造不了，而这是 agent 发出的每条消息的必经之路。
        //
        //   判的是刚**写进流里**的那份（`replyTo` / `kind` 两个局部变量），
        //   不是 outbox 原文 —— 否则网页红着、告警是绿的（见上面那段）。
        //
        // ⚠️ 记在投递 + ack **之后**：没送出去的那条不存在挂错 thread 的问题，
        //   先记后投会在投递失败时留下一条 agent 永远对不上号的告警。
        //
        // 🚫 这里只**记录**。绝不在这儿顺手把 `reply_to` 补上 ——
        //   那是明确不要的行为，而且它会让漏填从此不可见。
        if (threadAlert.isOrphan({ from, kind, reply_to: replyTo })) {
          threadAlert.record(from, {
            at: Date.now(),
            to: target.to,
            room: Boolean(entry.room_hash),
            // 存 200 字封顶：状态文件要有界。展示时还会再截一次并补省略号。
            preview: String(entry.text ?? '').slice(0, 200),
          }, threadAlertDir);
        }

        // ── 优雅关停哨兵（agent 自己声明可以关停，bus 才关它）─────────────────────────────
        //
        // 挂在这里而不是别处：relay 是 per-agent 的，`from` 由目录名推断，
        // agent 伪造不了别人的身份。而且这是 agent 发出的每条消息的必经之路，
        // 不会漏。
        //
        // 判定放在投递 + ack **之后**：agent 临终这条消息该送到还是要送到，
        // 先杀再投等于又制造一次「处理到一半」，那正是这个功能要消灭的东西。
        const verdict = shutdown.classify(entry.text);
        if (verdict === 'ready') {
          onEvent({ type: 'shutdown_ready', name: from, file: f });
        } else if (verdict === 'mid_message') {
          // ★ 不静默忽略。发送方可能真想关停，只是格式写错了 ——
          // 悄悄丢掉会让它一直等一个永远不来的关停。
          const self = await roster.lookup(redis, from);
          if (self) {
            await q.send(redis, self.stream, {
              from: 'bus', to: from, text: shutdown.correctionText(), agent_type: 'system',
              ...stamp.SYSTEM,
            });
          }
          onEvent({ type: 'sentinel_misplaced', name: from, file: f, bounced: Boolean(self) });
        }
      }
    } finally {
      draining = false;
    }
  }

  const watcher = fs.watch(outboxDir, () => {
    clearTimeout(timer);
    timer = setTimeout(() => { drain().catch((e) => onEvent({ type: 'error', error: e.message })); }, DEBOUNCE_MS);
  });

  // 启动先扫一遍 —— 进程不在的时候写进来的文件不能漏
  drain().catch((e) => onEvent({ type: 'error', error: e.message }));

  return {
    drain,
    stop() { clearTimeout(timer); watcher.close(); },
  };
}

module.exports = {
  startRelay, planRelays, tryRepair, resolveTarget,
  // ── worker 通路（纯函数 + 一个只读 redis 查询，都喂得进假输入）──
  resolveWork, liveWorkConsumer,
  WORK_TIMEOUT_DEFAULT_MS, WORK_TIMEOUT_MAX_MS, WORK_CONSUMER_MAX_IDLE_MS,
  // 死信落盘。导出给测试 —— **这是「丢东西」这条路上唯一保住内容的一步**，
  // 而它没有守卫的话，坏掉时的现场跟「本来就没内容」一模一样。
  saveDeadLetter, savedNote, DEADLETTER_ROOT,
};
