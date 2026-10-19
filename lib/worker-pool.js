'use strict';

/**
 * worker 池 —— 队列投资回报最高的地方。
 *
 * worker tier「几乎不用建」——
 *   XREADGROUP work:<type> → 干活 → XACK → 退出
 * 没有花名册条目、没有 PID 跟踪、没有关停队列、没有 READY_TO_SHUTDOWN 哨兵。
 * 并发度 = 消费者数量。
 *
 * ── 谁来 ack ────────────────────────────────────────────────────
 * 池来 ack，不是 worker。这样 worker 完全不需要知道队列存在 ——
 * 任务从 prompt 进，结果从 stdout 出，退出码就是成败。
 *
 * 失败**不 ack** → 消息留在 PEL → 被别的消费者或下一轮重投。
 * 这是 at-least-once 的用法：宁可重跑，不可丢活。
 * ──────────────────────────────────────────────────────────────
 *
 * ── 幂等去重 ─────────────────────────────────────────────────
 * at-least-once 的代价是幂等义务，而这里的副作用最重：跑一次 claude -p
 * 要烧订阅配额、可能写文件、结果还不可复现。消费者崩掉后消息**会被重投**。
 *
 * 去重必须在这里由代码执行，不能靠调用方（编排者）每次手工记得 ——
 * 依赖 LLM 记性的防线不是防线。
 *
 * ★ 缓存的是**结果**，不是「见过」。命中时走「用缓存结果照常回报 + ack」，
 *   不是「什么都不做直接 ack」—— **调用方在等一个回复，它不知道这是
 *   第二次**。返回一个空成功比重做一次更糟：后者至少还是个正确结果，
 *   前者是编造的。
 *
 * ⚠️ 已知的残留窗口：两个消费者**同时**在跑同一个 job
 *    （autoclaim 把消息交给了新消费者，而原消费者还没跑完）时，两边都
 *    查不到记录，都会跑。堵它需要一个「运行中」占位，而占位一旦在跑到
 *    一半崩掉时残留，就变成「消息被当成已完成跳过」—— 那是丢活，比重跑
 *    严重。同一个取舍，同一个方向。
 * ──────────────────────────────────────────────────────────────
 */

const fs = require('node:fs');
const path = require('node:path');
const q = require('./queue');
// 章：episodic worker 的回报是 agent 说的话。
const stamp = require('./stamp');
const { makeRunner } = require('./worker-runner');
const agyBackend = require('./agy-backend');
// 能力的**唯一数据源** —— 准入层和执行层（hooks/check_security.js）
// 都从这里读，两处各写一遍迟早分叉，而分叉不会有任何症状。
const capabilities = require('./agent-capabilities');
// 模板下发。**每次 worker 运行前跑一次**，见下面那段的理由。
const { provision } = require('./provision');
// 「可选类型」那行的唯一出处。**不用 Object.keys(CAPABILITIES)** ——
// 那份清单里有四个类型缺模板、根本起不来（见下面调用处）。
const discovery = require('./template-discovery');
// 任务图：结果要不要投回调度器，按花名册判（见 `replyStreamFor`）。
const roster = require('./roster');
const graph = require('./graph'); const { QA_REQUESTER, qaReplyStream } = require('./verify-complete'); // QA 回流（同一行 = 不挪下面的行号）

/** 极简信号量：限制同时在跑的 worker 数（默认 2） */
function semaphore(max) {
  let active = 0;
  const waiting = [];
  return {
    get active() { return active; },
    async acquire() {
      if (active < max) { active++; return; }
      await new Promise((res) => waiting.push(res));
      active++;
    },
    release() {
      active--;
      const next = waiting.shift();
      if (next) next();
    },
  };
}

/**
 * @param {object} redis
 * @param {object} opts
 * @param {string} opts.type          eval | solve | write
 * @param {number} [opts.concurrency] 同时几个 worker（默认 2）
 * @param {string} [opts.mode]        print | tmux（可切换）
 * @param {string} [opts.cwd]         **模板下发的目的地**，同时是执行目录的回落值。
 *        ⚠️ 它**不是「worker 的工作目录」那一个东西** ——
 *        job 消息可以带 `cwd` 单独指定执行目录。理由见 `handle()` 里 `runCwd` 那段。
 * @param {function} [opts.runner]    执行器，可注入。
 *        默认按 mode 选 print/tmux。测试注入假实现以免真调 LLM ——
 *        必须走这个参数：测试里替换模块导出无效（makeRunner 捕获的是
 *        局部引用），测试会静默调真 claude。
 */
function startPool(redis, {
  type,
  concurrency = 2,
  mode = process.env.ENGLOOP_WORKER_MODE || 'print',
  // ⚠️ 默认值是 `workers/<type>/`，**不能是 `process.cwd()`**。
  //
  //   每次运行前都会 provision，而 provision 对 worker 是**无条件覆盖**；
  //   `process.cwd()` 在测试里就是项目根目录 ⇒ 它会去覆盖仓库根的 `CLAUDE.md`。
  //
  //   `workers/<type>/` 跟 `bin/serve.js` 传的是同一个值，
  //   **默认值和真实调用方一致，比「让调用方总是记得传」可靠。**
  //
  //   ★ 这个值**只管 provision 的目的地**（以及没传时的执行目录）。
  //     worker 真正跑在哪由 job 决定 —— 两个职责为什么必须拆开，见 `handle()`。
  cwd = path.join(__dirname, '..', 'workers', type),
  timeoutMs = 600_000,
  runner = null,
  onLog = () => {},
  // 去重窗口覆盖的不是 autoclaim 的 60 秒，而是**agent 停机到重启的真实
  // 间隔** ——「人睡一觉起来发现 bus 挂了」是真实场景。一条记录很小。
  // 太短的失败模式很隐蔽：去重静默失效，看起来一切正常，只是活做了两遍。
  dedupeTtlSec = 86_400,
} = {}) {
  // ★ 准入层：这个池的 worker 只准用哪些工具。**在这里算一次，启动时就定死。**
  //
  //   ⚠️ **未知类型必须在这里炸掉，不能往下走。**
  //   `worker-runner` 那边是 `if (allowedTools) args.push(...)` ——
  //   **不传等于完全不限制**。所以「查不到能力」顺流而下会变成
  //   「什么都能用」，那是这条链最不能出的事：一个 eval worker 拿到 Bash，
  //   而它是唯一能读网页的 —— prompt injection 到 RCE 的完整链路。
  //
  //   在启动时失败，错误信息能说清是哪个类型名不对；等到运行时才发现，
  //   现场只剩一个「看起来正常工作」的 worker。
  const allowedTools = capabilities.allowedToolsFor(type);
  // ★ **这个才是真正起作用的那层。** `--allowedTools`
  //   是「额外允许」，不禁止未列出的工具（给了不含 Bash 的白名单，
  //   Bash 照样能跑）。`allowedTools` 保留是因为它表达意图，
  //   **但它不构成一层防护，别把它算进层数。**
  const disallowedTools = capabilities.disallowedToolsFor(type);
  if (!allowedTools) {
    // ★ 用 `discovery.safeHint()`，**不用 `Object.keys(CAPABILITIES)`**。
    //
    //   能力表里有的类型**缺模板、根本起不来**。把它们当「可选项」列给一个刚打错名字的人，
    //   **他会从里面挑一个再撞一次墙** —— 而第二次撞的是完全不同的错误
    //   （「没有模板目录」），他会以为自己又做错了别的事。
    //
    // ⚠️ 必须是 `safeHint` 不是 `usableTypesHint`：**这里是错误处理路径**。
    //   提示行要是抛异常，会把上面那句「不认识的类型 xxx」整个盖掉。
    //   `safeHint` 的契约是永不抛，坏掉时说「列不出来」，
    //   **绝不退回 `Object.keys(CAPABILITIES)`** —— 退回去等于又说了一次假话。
    throw new Error(
      `worker 池启动失败：不认识的 agent 类型 "${type}"，算不出它的工具白名单。`
      + ` 可选：${discovery.safeHint()}。`
      + ' 类型要先登记进 lib/agent-capabilities.js（能力的唯一数据源）。');
  }

  const stream = `work:${type}`;
  const group = `work:${type}`;
  // ★ 按 job 的 backend 选执行器（opts.backend 只在非 claude 时出现）。注入的 runner（测试）一律用它 —— 它从 opts.backend 知道是哪个后端。
  //   调用处仍是 `await run(`（test/provision.test.js 按这个字面量查「provision 在 run 之前」）。
  const baseRun = runner || makeRunner(mode);
  const run = (task, opts) => (!runner && opts.backend === 'agy' ? agyBackend.runAgy : baseRun)(task, opts);
  const sem = semaphore(concurrency);
  let stopped = false;

  // 键用 job_id —— 每条消息都带（queue.js send 里没有就生成）。
  // 不新造键。
  const dedupeKey = (jobId) => `dedupe:worker:${type}:${jobId}`;

  /**
   * 回报文本。抽出来是为了**重投命中缓存时能一字不差地重放同一句话**。
   *
   * ── ★★ 文案不自己猜「会不会重投」 ─────────────────────────────
   *
   *   不能写成 `res.permanent ? 「已停止重投」: 「将被重投」`。
   *   **那是拿「失败的原因」去代理「这条消息 ack 没 ack」** —— 而两者不等价：
   *
   *       permanent ⇒ 已 ack     （成立）
   *       已 ack    ⇒ permanent  （**不成立**）
   *
   *   真实存在**第三类**：不永久（环境修好后新任务能成功），
   *   但也不重投（这个 job 已经被 ack 掉了）——
   *   `provision_failed` 和 `persona_missing` 就是。
   *
   *   按 permanent 选文案，这两条路径就会**ack 了，却对调用方说「未确认，将被重投」**。
   *   人会去等一个永远不会来的重投。而失效**没有任何症状** ——
   *   文案照常生成，只是内容反了。
   *
   *   所以**「说了什么」和「做了什么」由同一个函数决定** ——
   *   见下面 `replyAndAck` / `replyAndRetry`。`willRetry` 由调用它们的那个
   *   函数填死，**不是参数**，所以两者不可能分叉。
   * ────────────────────────────────────────────────────────────────
   */
  function replyText(res, short, willRetry) {
    if (res.ok) return `[${type} 完成 ${Math.round(res.ms / 1000)}s] ${res.output}`;
    // ★★ **先看 willRetry，再看 permanent** —— 这个顺序不能反。
    if (willRetry) {
      return `[${type} 失败 ${res.reason}] job ${short} 未确认，将被重投。${res.error || ''}`.slice(0, 800);
    }
    // ── 下面两条都是「不会再投」，差别只在**怎么描述原因** ──────────
    //   ★ `permanent` 只决定「措辞」（原因是不是永久性的），
    //     **不决定「会不会重投」（那是行为，由 willRetry 说了算）。**
    //
    //   ⚠️ 别让它兼这两件事：「permanent ⇒ 已 ack」成立、反向不成立，
    //     反向那一半会让文案说谎。
    if (res.permanent) {
      return `[${type} 永久失败] job ${short}: ${res.error}。已停止重投，需要人修环境。`;
    }
    // 第三类：不永久（修好环境后新任务能成功），但这一条**已经 ack 掉了**。
    // 说清楚「这一条不会再来」和「以后还能成功」是两件事，否则人会以为要重跑。
    return `[${type} 失败 ${res.reason}] job ${short}: ${res.error}`
      + '。已停止重投（这一条已 ack，不会再来；修好之后新任务不受影响）。';
  }

  /**
   * 结果投到哪条流。**默认 `orch:in:agent`（编排者的收件流）—— 一个字没改。**
   *
   * ★ 例外只有一个（任务图）：请求者（`msg.from`）在花名册里登记成**调度器**
   *   （type = `graph.SCHEDULER_TYPE`）⇒ 投回它自己的收件流，并带上结构化的三个字段。
   *   不这么做的后果：图里 kind:work 节点的结果全进 `orch:in:agent` ——
   *   **bus 的 crewInLoop 会把那条流的每一条推到 Patrick 的网页上**，调度器自己反而收不到。
   *
   * ⚠️ 名字只是筛子，**改道要花名册的类型对得上**：名字谁都能写进 job 的 `from`，
   *   花名册条目是调度器自己登记的（type `graph`）。
   *   查不了 / 不在册 ⇒ 退回老路（编排者至少看得见），**并且说出来** —— 那说明调度器没登记上。
   */
  async function replyStreamFor(msg) {
    // ★ 先按名字筛，**不是**调度器派的活一次 redis 都不多查 ——
    //   这条连接上池自己挂着 BLOCK 5000 的阻塞读，多一次往返 = 回报多等最多 5 秒
    //   （每条都查的话，test/worker.test.js 去重那几条的 4 秒窗口会超时）。
    //   名字只是筛子，下面还要花名册的类型对得上才改道。
    if (msg.from === QA_REQUESTER && msg.job_id) return qaReplyStream(msg.job_id); if (msg.from !== graph.SCHEDULER_NAME) return null; // QA 回流：理由见 lib/verify-complete.js 的 QA_REQUESTER
    let rec = null;
    try { rec = await roster.lookup(redis, graph.SCHEDULER_NAME); } catch (_) { rec = null; }
    if (rec && rec.type === graph.SCHEDULER_TYPE && rec.stream) return rec.stream;
    onLog(`[pool:${type}] ⚠ job ${String(msg.job_id || '').slice(0, 24)} 是 ${graph.SCHEDULER_NAME} 派的，`
      + '但它不在花名册里（或类型不对）—— 结果退回 orch:in:agent，调度器收不到');
    return null;
  }

  async function send(msg, res, short, willRetry) {
    const graphStream = await replyStreamFor(msg);
    await q.send(redis, graphStream || 'orch:in:agent', {
      from: `worker:${type}`,
      ...stamp.AGENT,
      to: msg.from || 'JARVIS',
      text: replyText(res, short, willRetry),
      agent_type: type,
      job_id: msg.job_id,
      // ★ 调度器（和 verify-complete 的 QA）要拿**原样**输出 —— 调度器把它写成节点的 produces 文件 —— 从 `text` 里剥 `[eval 完成 3s] ` 前缀
      //   等于让文案格式变成协议。只在投给调度器时带，老路的 payload 不变。
      ...(graphStream ? {
        result_ok: res.ok ? '1' : '0',
        will_retry: willRetry ? '1' : '0',
        result_output: res.ok ? String(res.output ?? '') : '',
      } : {}),
    });
  }

  // ── ★★ 回报和 ack 绑成一个动作，因为它们说的是同一件事 ────────────
  //
  //   拆开的时候，「这条到此为止」这个事实被写了两遍 —— 一遍在 ack 调用上，
  //   一遍在文案里 —— 而**两份拷贝会分叉，分叉没有任何症状**。
  //
  //   绑在一起之后，想让报告说谎得**同时改两个函数体**。
  //
  // ⚠️⚠️ **重投命中缓存时要一字不差地重放同一句话** —— 那个性质靠的是
  //   「**能被重放的路径全都在 `replyAndAck` 这一侧**」：
  //
  //     成功       → replyAndAck   ┐
  //     永久失败   → replyAndAck   ├─ 都写去重记录，都可能被重放
  //     去重命中   → replyAndAck   ┘  → 同一个函数 → 一字不差 ✓
  //     要重投的   → replyAndRetry    → **不写去重记录，永远不会被重放** ✓
  //
  //   ★ 这个性质是**结构性的**，而结构会被下一次重构改变。
  //     谁要是把某条 `replyAndAck` 的路径挪到 `replyAndRetry`（或者反过来），
  //     **重放就从「一字不差」变成「一字之差」，而测试里那条断言比的是
  //     两次回报是否相同 —— 它会红。** 别删那条断言。
  // ────────────────────────────────────────────────────────────────

  /**
   * 回报 + ack —— **这条活到此为止，不会再来**。文案随之说「已停止重投」。
   *
   * @param {function} [beforeAck] **必须在 ack 落地之前跑完**的副作用（写去重记录）。
   *   ⚠️ 不是「顺手加的钩子」，是一个顺序约束的载体：
   *     先写记录再跑 → 跑到一半崩了，重投被当成「已完成」跳过，**活丢了**
   *     跑完再写记录 → 写之前崩了，重投会重跑一次。**重跑好过丢活**
   *   把它做成参数（而不是让调用方自己在两句之间插一行），是因为
   *   **「ack 之前」这个约束，只有和 ack 写在同一个函数里才守得住**。
   */
  async function replyAndAck(msg, res, short, beforeAck) {
    await send(msg, res, short, false);
    if (beforeAck) await beforeAck();
    await q.ack(redis, stream, group, msg.id);
  }

  /** 只回报，**不 ack** —— 留在 PEL 等重投。文案随之说「将被重投」。 */
  async function replyAndRetry(msg, res, short) {
    await send(msg, res, short, true);
  }

  async function handle(msg) {
    const short = String(msg.job_id || '').slice(0, 8);

    // ── 去重：这个 job 上次跑完了吗 ─────────────────────────────
    // 没有 job_id 就没法去重（理论上不会发生，queue.js send 保证有）。这种情况照常
    // 跑 —— 宁可重跑不可丢活，跟这个模块其它地方的取舍一致。
    if (msg.job_id) {
      let cached = null;
      try {
        const raw = await redis.get(dedupeKey(msg.job_id));
        if (raw) cached = JSON.parse(raw);
      } catch (_) {
        // 记录读不出来或坏了 → 当没有，重跑一次。同一个方向的取舍。
        cached = null;
      }
      if (cached) {
        // ★ 照常回报 + ack，不是「什么都不做直接 ack」。
        //   调用方在等一个回复，它并不知道这是第二次投递。
        await replyAndAck(msg, cached, short);
        onLog(`[pool:${type}] ⟲ ${short} 重投命中去重，用上次的结果回报，没有重跑`);
        return;
      }
    }

    // ── ★★ 执行目录按 job 走，模板目的地**不跟着走** ────────────────
    //
    //   `security-reviewer` 这类 worker 要是跑在 `workers/review/` 里，
    //   **它看不到任何要审的代码** —— 而它照样会输出一份看起来很像回事的
    //   审查报告。**审代码的 agent 站在一个没有代码的目录里，不会有任何报错。**
    //
    // ⚠️⚠️ **不能直接把上面那个 `cwd` 换成 `msg.cwd`。**
    //   下面那行 provision 用的是同一个变量，而它是 `keepEdited: false`
    //   （无条件覆盖），`provision.js` 对这种写法有一道 fail-closed：
    //   **只准写进 `workers/` 之下**，否则抛。
    //
    //   所以直接替换的后果**不是崩**，是每一个带 cwd 的 job 都走进下面那个
    //   catch，礼貌地回报一句 `provision_failed` 然后被 ack 掉 ——
    //   **不红、不响，看起来像别的毛病。**
    //
    //   那道 fail-closed 防的是 provision 把模板写进仓库根、覆盖编排者的
    //   CLAUDE.md 和 `.claude/settings.json`（任意一件都能让编排者静默失能）。
    //   **不动它，也不绕过它** —— 办法是根本不把它指向仓库外。于是两个职责各归各：
    //
    //     provision → `cwd`      池默认，永远在 `workers/<type>/`，**job 改不动它**
    //     执行      → `runCwd`   传了用传的，没传照旧回落到 `cwd`
    //
    const runCwd = msg.cwd || cwd;

    // ── 后端 ─────────────────────────────────────────────────────────────
    //   不带 = claude，传给 runner 的参数里不多一个键。
    //   不在这个类型的 backends 里 ⇒ permanent（入口 relay.resolveWork 已经拒过一次，这里是第二道：消息也可能不经 relay 进流）。
    //   非 claude ⇒ cwd 必须是一棵 linked worktree 的根、在 wt/<名字> 分支上 —— 产出先落在分支上，进 main 只走 verify-complete ＋ wt-merge。
    const backend = msg.backend == null || msg.backend === '' ? 'claude' : String(msg.backend);
    let allowedBackends;
    try { allowedBackends = capabilities.backendsFor(type); } catch (e) { allowedBackends = []; }
    if (!allowedBackends.includes(backend)) {
      const detail = `${type} 类型不能用后端 ${JSON.stringify(backend)}（能用的：${allowedBackends.join(' / ') || '无'}，见 lib/agent-capabilities.js 的 backends）`;
      onLog(`[pool:${type}] ⛔ ${short} ${detail}`);
      await replyAndAck(msg, { ok: false, ms: 0, reason: 'bad_backend', permanent: true, error: detail }, short);
      return;
    }
    if (backend !== 'claude') {
      const wt = msg.cwd ? agyBackend.linkedWorktree(runCwd) : { ok: false, error: `后端 ${backend} 的 job 必须带 cwd（一棵 wt/<名字> 的 linked worktree）` };
      if (!wt.ok) {
        onLog(`[pool:${type}] ⛔ ${short} ${wt.error}`);
        await replyAndAck(msg, { ok: false, ms: 0, reason: 'not_linked_worktree', permanent: true, error: wt.error }, short);
        return;
      }
    }

    // ⚠️ cwd 不存在要**在这里说清楚**，不能留给 execFile。
    //   `worker-runner.isPermanent()` 认 ENOENT —— 而 **claude 二进制找不到
    //   也是 ENOENT**。两个完全不同的原因产生同一条「永久失败: spawn ENOENT」，
    //   人拿到它会先去查 claude 装没装，**而真正错的是 job 里的一个路径**。
    if (msg.cwd && !fs.existsSync(runCwd)) {
      const detail = `job 指定的 cwd 不存在：${runCwd}（不是 claude 二进制的问题）`;
      onLog(`[pool:${type}] ⛔ ${short} ${detail}`);
      // 跟 provision 失败同一个取舍：回报 + ack（不让它重投刷屏），
      // **但不写去重记录** —— 目录建好之后重投应该能成功。
      await replyAndAck(msg, { ok: false, ms: 0, reason: 'bad_cwd', permanent: true, error: detail }, short);
      return;
    }

    // ── ★ 每次运行前下发模板 ─────────────────────────────────────
    //
    //   **不是池启动时下发**，是每个 worker 跑之前。理由：
    //     · 每个 worker 拿到的**一定是当下的模板** ——
    //       **不存在「跑着旧配置的 worker」这种状态**
    //     · 不需要 bus 启动时写文件
    //     · **符合 episodic 的性质**：每次从零重建本来就是这一层的设计意图
    //
    //   **无条件覆盖**（`keepEdited: false`）：worker 没有记忆要保护。
    //   「>50 字符就保留」那条规则会让一份手工建的旧 `CLAUDE.md` 一直盖住模板。
    //
    // ⚠️ **失败让这个 worker 起不来，不是记一条日志继续跑。**
    //   缺了 `.claude/settings.json` 时 **hook 对 worker 根本没挂上，
    //   而它跑起来和挂上了看起来一模一样。**
    //
    //   跟 allowedTools 那里同源：「查不到 / 没配好」顺流而下会变成
    //   「什么都没限制」。
    try {
      // ★ 第二个参数是 `cwd` 不是 `runCwd` —— 整个拆分的要点就在这一个字上。
      const p = provision(type, cwd, type, { keepEdited: false });
      onLog(`[pool:${type}] ⟳ ${short} 模板已下发: ${p.written.join(', ')}`);
    } catch (err) {
      const detail = `provision 失败，${type} worker 拒绝启动：${err.message}`;
      onLog(`[pool:${type}] ✗ ${short} ${detail}`);
      // 照常回报 + ack（ack 掉这条就不会重投刷屏），
      // **但不写去重记录** —— provision 失败多半是环境问题（模板缺失/权限），
      // 修好之后新任务应该能成功。**记进去重的话，修好了重投还是返回
      // 那条缓存的失败** —— 一个已经修好的问题继续报错，比报错本身更难查。
      // ★ `replyAndAck` —— 这条**确实 ack 了**，所以文案说的也是「已停止重投」。
      await replyAndAck(msg, { ok: false, ms: 0, reason: 'provision_failed', error: detail }, short);
      return;
    }

    // ── ★★ 人格要**跟着 worker 走**，不能躺在它没站的那个目录里 ──────────
    //
    //   拆开 cwd 之后：worker 站在被审的项目里，
    //   claude 自动读到的 CLAUDE.md 就是**那个项目的**。
    //
    //   审 EngLoop 自己时，仓库根的 CLAUDE.md 是**编排者引导**，
    //   教读者进入循环、跑 `bin/next.js` 去领消息。
    //   **一个 review worker 读到它，会去当第二个 JARVIS**，不会报错。
    //
    //   所以这不是「人格不够纯」的品味问题，是**审查 worker 会去领队列里的活**。
    //
    // ★ 指的是 `cwd`（provision 的目的地）下那一份，**不是 runCwd 下的** ——
    //   runCwd 下那份正是要被压过去的东西。
    //
    // ⚠️ fail-closed：人格必须在场，它缺席的时候必须是**响亮的**。
    //   跟 provision 失败同一个方向 ——
    //   「查不到 / 没配好」顺流而下会变成「什么都没有」，而那一刻不会有人发现。
    // agy 不读 CLAUDE.md，人格拼进 prompt 开头 ⇒ 用它自己那份（templates/<type>/AGY.md，provision 跟 CLAUDE.md 一起下发）。
    const personaFile = path.join(cwd, backend === 'agy' ? 'AGY.md' : 'CLAUDE.md');
    if (!fs.existsSync(personaFile)) {
      const detail = `provision 之后 ${personaFile} 仍然不在，${type} worker 拒绝启动：`
        + '没有它，worker 会读被审项目的 CLAUDE.md 当成自己的身份。';
      onLog(`[pool:${type}] ✗ ${short} ${detail}`);
      // 同 provision 失败：回报 + ack，**不写去重记录**（模板补上之后新任务该能成）。
      await replyAndAck(msg, { ok: false, ms: 0, reason: 'persona_missing', error: detail }, short);
      return;
    }

    // ★ job 传了 cwd 就把它打出来 —— 「worker 站在哪」是这条链上最容易
    //   出错又最看不出来的一件事，日志里不说的话没有任何地方说得出。
    onLog(`[pool:${type}] ▶ ${short} 开始（并发 ${sem.active}/${concurrency}）`
      + (msg.cwd ? ` cwd=${runCwd}` : ''));

    // ★ job 可以把超时**调小**（见下面那段注释）。非法/越界一律退回池的默认值。
    const jobTimeoutMs = (() => {
      const t = Number(msg.timeout_ms);
      if (!Number.isFinite(t) || t <= 0) return timeoutMs;
      return Math.min(t, timeoutMs);
    })();

    const res = await run(
      { text: msg.text, type, job_id: msg.job_id },
      // agentType 就是这个池的 type（eval / solve / write）。
      // 不传的话 worker 会继承 bus 进程的环境，而 bus 是 orchestrator ——
      // 一个 eval worker 会被 hook 当成 orchestrator，拿到它不该有的 Bash。
      //
      // ★ allowedTools 是**准入层**（hook 是执行层）。
      //   `worker-runner` 收这个参数，但只有调用方真传了它才生效 ——
      //   漏传就是一个「以为有防护、实际没有」的死参数。
      // ★ 这里是 `runCwd` —— worker 真正站的地方。上面 provision 是 `cwd`。
      //   **两个名字长得像，含义相反：一个是「模板写去哪」，一个是「活在哪干」。**
      // ★ 两个目录在这一行同时出场，含义相反：
      //     `cwd: runCwd`            活在哪干（job 说了算）
      //     `appendSystemPromptFile` 人格从哪来（永远是 workers/<type>/）
      // ── ★ per-job 超时 ─────────────────────────────────────────────
      //
      //   relay 把 `timeout_ms` 写进消息，这里用它（`jobTimeoutMs`），
      //   不是池的 `timeoutMs` —— 只写不读的字段，跟只收不传的参数是同一个洞。
      //
      //   🔴 **只能调小，不能调大。** 上界是池的 `timeoutMs`，理由在 `loop()` 的 autoclaim：
      //       minIdleMs: timeoutMs + 60_000     ← **池级**的重投窗口
      //     job 设 30 分钟而池的窗口是 11 分钟的话，**第 11 分钟 autoclaim
      //     会重投它** ⇒ 第二个 worker 开始跑同一个 job，而去重键**在并发
      //     窗口内不拦** ⇒ **两份并排跑到底，
      //     烧两份额度、副作用做两遍，而日志上看起来只是「慢」。**
      //   ⇒ 越界的值在入口就该被拒（`lib/relay.js` 的 `resolveWork`），
      //     这里再夹一次是第二道：**夹到池的上界，而不是照单全收**。
      { cwd: runCwd, timeoutMs: jobTimeoutMs, agentType: type, allowedTools, disallowedTools,
        appendSystemPromptFile: personaFile, ...(backend === 'claude' ? {} : { backend }) },
    );

    // ★ 写去重记录的时机：**副作用完成之后、ack 之前**。顺序不能反。
    //     先写再跑 → 跑到一半崩了，重投被当成「已完成」跳过，**活丢了**
    //     跑完再写 → 写之前崩了，重投会重跑一次。**重跑一次好过丢一次活**
    //   （选 at-least-once 是同一个取舍。）
    //   只记「已经定局」的两种：成功、永久失败。要重投的那种不记 ——
    //   记了就等于宣布它做完了。
    async function remember() {
      if (!msg.job_id) return;
      try {
        await redis.set(
          dedupeKey(msg.job_id),
          JSON.stringify({
            ok: res.ok, output: res.output, ms: res.ms,
            permanent: res.permanent, reason: res.reason, error: res.error,
          }),
          'EX', dedupeTtlSec,
        );
      } catch (e) {
        // 记不上不是致命的（下次重投会重跑一次），但必须说出来 ——
        // 静默失效的去重跟没有去重一样，而且更难发现。
        onLog(`[pool:${type}] ⚠ ${short} 去重记录写失败，重投会重跑: ${e.message}`);
      }
    }

    if (res.ok) {
      // 结果回给请求者。to 字段是编排者写的收件人。
      await replyAndAck(msg, res, short, remember);
      onLog(`[pool:${type}] ✓ ${short} 完成 ${Math.round(res.ms / 1000)}s`);
    } else if (res.permanent) {
      // ★ 永久失败**要 ack** —— 环境问题（找不到二进制、没权限）重投
      // 一万次也不会成功，只会在 PEL 和 worker 之间无限弹跳烧资源。
      // 例如 claude 二进制不在 launchd 的 PATH 里。
      //
      // 也要写去重记录。★ 挡的**不是** autoclaim —— 这条路径已经 ack 了，
      // 它不在 PEL 里，autoclaim 捞不到它。挡的是「remember 成功但 ack 失败
      // 或 ack 之前崩掉」那个窗口：那时它确实还在 PEL、会被重投，而记录
      // 已经写好，所以重投命中缓存、不会再跑一次一定失败的活。
      await replyAndAck(msg, res, short, remember);
      onLog(`[pool:${type}] ⛔ ${short} 永久失败，已 ack 停止重投: ${res.error}`);
    } else {
      // ★ 不 ack，也**不写去重记录** —— 留在 PEL 等重投，而重投时必须
      //   真的重跑。写了记录就等于宣布这活干完了，那是丢活。
      //   ★ 用 `replyAndRetry`：**这是六条路径里唯一真的会被重投的一条**，
      //     也只有它该说「将被重投」。
      onLog(`[pool:${type}] ✗ ${short} ${res.reason}: ${(res.error || '').slice(0, 120)}`);
      await replyAndRetry(msg, res, short);
    }
  }

  async function loop() {
    const consumer = `${type}-pool-${process.pid}`;
    while (!stopped) {
      try {
        // 先捞孤儿：上一轮跑到一半被杀的任务
        const orphans = await q.autoclaim(redis, {
          stream, group, consumer, minIdleMs: timeoutMs + 60_000, count: concurrency,
        });
        const msgs = orphans.length
          ? orphans
          : await q.claimNext(redis, {
              streams: stream, group, consumer, blockMs: 5000, count: concurrency,
            });

        for (const m of msgs) {
          // ── 🔴🔴 `stop()` 之后领到的，**一条都不处理** ──────────────
          //
          //   `while (!stopped)` 的判断在 `claimNext` **之前**，而 claimNext
          //   会阻塞最多 5 秒。所以 `stop()` 返回之后，一个还卡在里面的 loop
          //   **仍然会醒来、领走消息、并把它跑完** —— 而调用方以为池已经停了。
          //
            //   ★ 复现要求 send 和池**不共用一个 redis 连接** —— 阻塞命令
            //     独占连接，共用时 send 被推迟到 loop 退出之后，看不到这个窗口。
          //
          //   ⚠️ 已经领走的那条**留在 PEL 里，不 ack** —— 它会被下一个消费者
          //   通过 `autoclaim` 捞回去重跑。**宁可重跑不可丢活**（跟
          //   「失败不 ack」同一个取舍）。
          if (stopped) break;
          await sem.acquire();
          handle(m)
            .catch((e) => onLog(`[pool:${type}] handle 异常: ${e.message}`))
            .finally(() => sem.release());
        }
      } catch (err) {
        onLog(`[pool:${type}] 队列错误: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  // ★ 留住这个 Promise —— `stop()` 要能把「loop 真的退出了」交给调用方。
  const loopDone = loop();
  onLog(`[pool:${type}] 已启动（mode=${mode} 并发=${concurrency}）`);
  return {
    // ★ 导出 `dedupeKey` —— 判据要能查「这条 job 的去重记录落地了没有」。
    //
    //   🔴 而它**必须**从这里拿，不能让判据自己拼：那个 key 是
    //   `dedupe:worker:${type}:${jobId}` —— 而 **type 拼错的失败模式，
    //   跟这个模块的一个真实 bug 症状一模一样**：key 查不到 ⇒ 轮询超时
    //   ⇒ 看起来像「记录一直没写」，会把人引向错误的结论。
    //   （跟 `COOLDOWN_KEY` / `sessionToName` / `streamToName` 同一个理由。）
    dedupeKey,
    /**
     * 停止这个池。
     *
     * ★★ **返回一个 Promise：await 它 = loop 真的退出了。**
     *   不 await 也是安全的（上面那个 `if (stopped) break` 保证它不会再处理
     *   任何东西）—— 但**要确定性就得 await**：不 await 的话，那个 loop 还会
     *   在 `claimNext` 里挂最多 5 秒，期间它**仍然占着一个消费者名额**。
     *
     * ⚠️ 为什么不在 stop() 里主动打断 claimNext：redis 客户端没有干净的
     *   「取消一个阻塞命令」的办法，能做的只有断连 —— 而这个连接是调用方
     *   给的，池没有权力关掉它。**所以代价是最多 5 秒的等待，写在这里。**
     *
     * ★ 向后兼容：老调用方写的是 `pool.stop();`（不接返回值），行为不变。
     */
    stop() { stopped = true; return loopDone; },
    get active() { return sem.active; },
  };
}

module.exports = { startPool, semaphore };
