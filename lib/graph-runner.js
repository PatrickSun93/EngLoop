'use strict';

/**
 * 任务图调度器 —— **有副作用的那一半**。
 * 判断全在 `lib/graph.js`（纯函数），这里只做：读状态 → 问判据 → 落状态 → 发消息。
 *
 * ── 挂在 bus 里，不挂在 JARVIS 脑子里 ────────────────────────────────────
 *   `rooms.advance` 唯一的调用方是 `POST /api/rooms/:hash/advance` ——
 *   靠 JARVIS 记得去调 ⇒ 上下文压缩之后流程**安静地停住**。
 *   这里是 `bin/serve.js` 里的一个 interval（跟 watchdog 同一种挂法），每 tick 推一格。
 *   **「现在轮到谁」只从 redis 读**，JARVIS 和 agent 都不在脑子里记。
 *
 * ── 状态在 redis，定义在文件 ────────────────────────────────────────────
 *   graph:index              SET    所有图的 id
 *   graph:<id>:meta          STRING JSON：目录、PLAN.json 的 md5 ＋ 原文快照、limits、status、房间
 *   graph:<id>:nodes         HASH   节点 id → 冻结的定义（brief_file 已读进来；子节点带 parent / depth）
 *   graph:<id>:state         HASH   节点 id → { state, at, why, hold, attempt, job_id, dispatched_at, rejects, … }
 *   graph:<id>:log           LIST   每一次状态转移 { node, from, to, at, why }（审计；每次转移都有一条广播与它对应）
 *
 * ── 顺序：**先落状态，再发消息** ─────────────────────────────────────────
 *   反过来的话：消息发出去了、状态没写，bus 重启之后会再派一次 ⇒ assignee 收到两条一样的活。
 *   先落状态的代价：状态写了、消息没发出去（bus 恰好死在两步之间）⇒ 节点停在 dispatched，
 *   超时后先给 agent 发**带原文的提醒**（等于补发），再超一半判 failed 上报 —— 慢，但看得见。
 *
 * ── 调度器**不做判断题** ─────────────────────────────────────────────────
 *   被打回怎么改、失败了换谁、要不要加节点 —— 一律上报 JARVIS，消息里带 graph_id ＋ 节点 ＋ 可选动作。
 *
 * ── 🔴 安全：verify 命令只从**磁盘上的 PLAN.json** 读，并且要求 md5 跟启动时冻结的一致 ─────
 *   verify 是在 **bus 进程里、仓库根上**跑的 shell 命令（sandbox 之外）。而 redis 对每个 agent
 *   都可写（「直连 Redis 能伪造章」是已知并接受的风险）——
 *   从 redis 里的快照取命令 ⇒ 「能写 redis」就升级成「能让 bus 执行任意命令」，那比伪造章重一档。
 *   ⇒ 命令只认文件；文件变了（md5 对不上）⇒ 不跑、节点 blocked、上报（这也正是「执行中被改了要看得见」）。
 *   子节点（agent 写的 SUBPLAN）不许带 verify（`lib/graph.js` 的 validateSubplan）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const q = require('./queue');
const roster = require('./roster');
const rooms = require('./rooms');
const relay = require('./relay');
const stamp = require('./stamp');
const watchdog = require('./watchdog');
const G = require('./graph');

const { S, GRAPH_STATUS: GS } = G;

const KEY = Object.freeze({
  INDEX: 'graph:index',
  meta: (id) => `graph:${id}:meta`,
  nodes: (id) => `graph:${id}:nodes`,
  state: (id) => `graph:${id}:state`,
  log: (id) => `graph:${id}:log`,
});

const PLAN_FILE = 'PLAN.json';
const SUBPLAN_FILE = 'SUBPLAN.json';
/** verify 命令的硬超时。跟 worker 的上限同一个数（10 分钟）：更久的验收该拆成一个 kind:work 节点。 */
const VERIFY_TIMEOUT_MS = 600_000;
/** 消息里引用产出 / 输出的截断长度 —— 消息不是存档，文件才是。 */
const TAIL = 1500;

/** job_id 带上图和节点和第几次 —— worker 的去重键是 `dedupe:worker:<type>:<job_id>`，重派必须换号。 */
const jobIdFor = (gid, nid, attempt) => `graph:${gid}:${nid}:${attempt}`;
function parseJobId(j) {
  const m = /^graph:([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*):(\d+)$/.exec(String(j || ''));
  return m ? { gid: m[1], nid: m[2], attempt: Number(m[3]) } : null;
}

function coded(code, status, message, next) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  if (next) e.next = next;
  return e;
}

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

/**
 * @param {object} o
 * @param {object} o.redis       bus 的**主连接**（只跑非阻塞命令；收件流用不带 BLOCK 的 XREADGROUP 读）
 * @param {string} o.orchName    编排者名 —— **必传**（不在这里再埋一处 'JARVIS'）
 * @param {string} o.graphsRoot  图目录只许在它下面（生产 = serve.js 配置的图目录根；隔离 bus = 临时目录，见 serve.js 的隔离表）
 * @param {string} o.repoRoot    verify 命令的工作目录
 * @param {null|function} o.defaultVerify  **必须显式传**（null 也要写出来）。节点没写 verify 时用的验收：
 *        `(node, { graphId, dir }) => 命令字符串 | null`。`verify_complete` 从这里接上
 *        （这里只留接口）。bus 传 null ⇒ 只看 stageGate。
 */
function createRunner({
  redis, orchName, graphsRoot, repoRoot, defaultVerify, onLog = () => {}, now = () => Date.now(), pid = process.pid,
} = {}) {
  if (!redis) throw new Error('graph-runner 需要 redis');
  if (!orchName) throw new Error('graph-runner 需要 orchName（不给默认值）');
  if (!graphsRoot) throw new Error('graph-runner 需要 graphsRoot（图目录的根；不给默认值）');
  if (!repoRoot) throw new Error('graph-runner 需要 repoRoot（verify 在哪跑；不给默认值）');
  if (defaultVerify !== null && typeof defaultVerify !== 'function') {
    throw new Error('graph-runner 需要 defaultVerify：一个函数，或者**显式的 null**（= 没写 verify 的节点只看 stageGate）。'
      + '不给默认值 —— 「忘了接 verify_complete」和「决定不接」要分得开。');
  }

  const reserved = [orchName, G.SCHEDULER_NAME];
  const INBOX = roster.inboxFor(G.SCHEDULER_NAME, G.SCHEDULER_TYPE);
  const GROUP = roster.groupFor(G.SCHEDULER_NAME, G.SCHEDULER_TYPE);
  const CONSUMER = `graph-${pid}`;
  const ORCH_INBOX = roster.inboxFor(orchName, 'orchestrator');
  /** 在跑的 verify：`gid/nid/attempt` → { done, ok, code, tail, cmd } */
  const verifying = new Map();

  // ── 串行化：tick、HTTP 的 start / approve / retry / cancel 都过这一道 ──
  //   全在一个 node 进程里，但每一步都有 await —— 不串行的话，approve 写的 running
  //   会被一个读了旧 meta 的 tick 写回 awaiting_approval，零报错。
  let chain = Promise.resolve();
  function serial(fn) {
    const p = chain.then(() => fn());
    chain = p.catch(() => {});
    return p;
  }

  const iso = () => new Date(now()).toISOString();

  // ── 读写 ───────────────────────────────────────────────────────────────
  async function load(id) {
    const raw = await redis.get(KEY.meta(id));
    if (!raw) return null;
    const meta = JSON.parse(raw);
    const nodes = {};
    for (const [k, v] of Object.entries(await redis.hgetall(KEY.nodes(id)))) nodes[k] = JSON.parse(v);
    const states = {};
    for (const [k, v] of Object.entries(await redis.hgetall(KEY.state(id)))) states[k] = JSON.parse(v);
    const order = Object.keys(nodes).sort((a, b) => nodes[a].order - nodes[b].order);
    return { id, meta, nodes, states, order };
  }

  async function saveMeta(g) { await redis.set(KEY.meta(g.id), JSON.stringify(g.meta)); }

  /** 房间广播：`expects_reply:false`、system 章（bus 自己写的）。失败不影响状态（状态已经先落了）。 */
  async function say(g, line) {
    try {
      await rooms.post(redis, g.meta.room_hash, {
        from: G.SCHEDULER_NAME, text: `【图 ${g.id}】${line}`, expects_reply: false, stampFields: stamp.SYSTEM,
      });
    } catch (e) {
      onLog(`[graph] ⚠ ${g.id} 广播失败（状态已落，只是房间里看不到这一条）：${e.message}`);
    }
  }

  /**
   * **唯一的状态转移入口**：先写状态 ＋ 审计日志，再广播。
   * `hold` 每次转移都清空 —— 它是「这一状态下为什么不动」，换了状态就不成立了。
   */
  async function transition(g, nid, to, why, patch = {}) {
    const prev = g.states[nid] || null;
    const from = prev ? prev.state : null;
    const at = iso();
    const next = { ...(prev || {}), ...patch, state: to, at, why, hold: null };
    g.states[nid] = next;
    await redis.hset(KEY.state(g.id), nid, JSON.stringify(next));
    await redis.rpush(KEY.log(g.id), JSON.stringify({ node: nid, from, to, at, why }));
    await say(g, `${nid}: ${from || '∅'} → ${to} · ${why}`);
  }

  /** 不是转移，只是「这一状态下为什么不动」—— 变了才写，不广播（否则每 tick 一条，房间就成了噪音）。 */
  async function hold(g, nid, why) {
    const st = g.states[nid];
    if (!st || st.hold === why) return;
    st.hold = why;
    await redis.hset(KEY.state(g.id), nid, JSON.stringify(st));
  }

  async function patchState(g, nid, patch) {
    Object.assign(g.states[nid], patch);
    await redis.hset(KEY.state(g.id), nid, JSON.stringify(g.states[nid]));
  }

  async function setStatus(g, to, why) {
    const from = g.meta.status;
    g.meta.status = to;
    g.meta.status_why = why;
    g.meta.status_at = iso();
    if (to === GS.VERIFIED || to === GS.CANCELLED) g.meta.finished_at = g.meta.status_at;
    await saveMeta(g);
    await redis.rpush(KEY.log(g.id), JSON.stringify({ node: null, from, to, at: g.meta.status_at, why }));
    await say(g, `图状态：${from} → ${to} · ${why}`);
  }

  // ── 对外说话 ───────────────────────────────────────────────────────────

  /**
   * 给编排者的消息。**每条都带 graph_id ＋ 节点 ＋ 下一步可选动作** ——
   * 收到它的可能是一个刚被压缩过的 JARVIS，它手上只有这一条。
   */
  async function notifyOrch(g, nid, headline, why) {
    const lines = [
      `【图 ${g.id}】${headline}`,
      `graph_id=${g.id}${nid ? ` node=${nid}` : ''}`,
      `原因：${String(why).slice(0, TAIL)}`,
      `目录：${g.meta.dir}`,
      '下一步可选：',
      `  ① 看全图：node bin/graph.js status ${g.id}`,
      ...(nid ? [`  ② 重派这个节点：node bin/graph.js retry ${g.id} ${nid}`] : []),
      `  ③ 放弃这张图：node bin/graph.js cancel ${g.id}（改 PLAN.json、换 id 重起）`,
      '  ④ 拿不准 ⇒ 转问 Patrick',
    ];
    try {
      await q.send(redis, ORCH_INBOX, {
        from: G.SCHEDULER_NAME, to: orchName, text: lines.join('\n'), agent_type: 'graph', ...stamp.SYSTEM,
      });
    } catch (e) {
      onLog(`[graph] ✗ 通知编排者失败（${g.id}${nid ? `/${nid}` : ''}：${headline}）：${e.message}`);
    }
  }

  /**
   * 回一个 agent（子图申请的结果）。**只投给在册的 agent** ——
   * `relay.resolveTarget` 对不在册的名字会给 `orch:out`（= 当成人），
   * 一条「你的 SUBPLAN 被拒」推到 Patrick 的网页上，那是投错人，不是通知。
   */
  async function replyAgent(name, text) {
    const target = await relay.resolveTarget(redis, { username: name }).catch(() => null);
    if (!target || !target.agent) {
      onLog(`[graph] ⚠ ${name} 不在册，回复没发（不当成人投给网页）：${text.slice(0, 120)}`);
      return false;
    }
    await q.send(redis, target.stream, {
      from: G.SCHEDULER_NAME, to: name, text, agent_type: 'graph', ...stamp.SYSTEM,
    });
    return true;
  }

  // ── 可用性 ─────────────────────────────────────────────────────────────

  /**
   * 撞了上游额度吗。读 watchdog 落的 `rl_since` 键（它判 rate_limited 时写、脱离时清）。
   * ⚠️ 查不了 ⇒ 当「撞了」：**「查不了」不许降级成一个具体答案**，而这一档安全的一侧是「不派」。
   */
  async function rateLimited(name) {
    try { return (await redis.exists(watchdog.RL_SINCE_KEY(name))) === 1; } catch { return true; }
  }

  /** assignee 现在能接活吗。返回 { ok, why, target }（target = agent 的投递目标 / work 的入队目标）。 */
  async function availability(n, jobId) {
    if (n.kind === 'crew') {
      // ★ 投递目标走 relay 的路由判定（唯一出处）；**只认在册的 agent**：
      //   不在册 ⇒ relay 会当成人投给网页 —— 这正是 rooms.js「花名册查不到就不推进」那条。
      let target;
      try { target = await relay.resolveTarget(redis, { username: n.assignee }); } catch (e) {
        return { ok: false, why: `花名册查不了（${e.message}）—— 这不是「不在」，是「查不出来」；不派` };
      }
      if (!target || !target.agent) return { ok: false, why: `${n.assignee} 不在花名册 —— 不派（硬派的话 relay 会把这条活投给人）` };
      const rec = await roster.lookup(redis, n.assignee).catch(() => null);
      if (rec && (rec.type === 'orchestrator' || rec.type === G.SCHEDULER_TYPE)) {
        return { ok: false, why: `${n.assignee} 是编排者 / 调度器，不能接图里的活` };
      }
      if (await rateLimited(n.assignee)) return { ok: false, why: `${n.assignee} 撞了额度（watchdog 判 rate_limited）—— 不给它派` };
      return { ok: true, target };
    }
    // kind:work —— 入队判定整个交给 relay.resolveWork（活 consumer、job_id、超时上限）：不另写一份
    const wt = await relay.resolveWork(redis, {
      work: n.assignee, job_id: jobId || 'probe', timeout_ms: Math.round(n.timeout_min * 60_000),
    }, { pid });
    if (!wt || wt.error) return { ok: false, why: `work:${n.assignee} 现在不能入队（${wt ? `${wt.error}：${wt.detail}` : '未知'}）` };
    return { ok: true, target: wt };
  }

  // ── 文本 ───────────────────────────────────────────────────────────────

  function absProduces(g, n) {
    if (!G.insideDir(g.meta.dir, n.produces)) return null;
    return path.resolve(g.meta.dir, n.produces);
  }

  function crewDispatchText(g, n, { attempt, redo }) {
    const nodeDir = path.join(g.meta.dir, n.id);
    return [
      `【图 ${g.id} · 节点 ${n.id}】${redo ? '**重做**' : '派活'}（第 ${attempt} 次）：${n.title}`,
      '',
      n.brief,
      '',
      ...(redo ? ['上一轮被打回，原因（原样）：', String(redo).slice(0, TAIL), '⚠️ 改在原文件上 —— 判据看的是它有没有在这次派活之后被写过。', ''] : []),
      `产出：${absProduces(g, n)}`,
      `必须含小节（每节下面要有正文）：${n.requires.join(' / ')}`,
      `预计改动范围（touches）：${n.touches.length ? n.touches.join(' / ') : '[]（只读）'}`,
      ...(n.cwd ? [`在哪干：${n.cwd}`] : []),
      `时限：${n.timeout_min} 分钟（超了先提醒，再超一半判 failed、上报编排者）`,
      '',
      '★ 做完**写文件**就行，不用回消息 —— 调度器每一 tick 自己查文件。这条消息照常 ack（纯 ack 文件即可）。',
      `★ 要往下拆：先写 ${path.join(nodeDir, SUBPLAN_FILE)}（跟 PLAN.json 同形状，只有 nodes，**只能是 kind:"work"**，`
        + 'touches 只能是上面那个范围的子集，不许带 verify），'
        + `再给 ${G.SCHEDULER_NAME} 发一条：SUBPLAN ${g.id} ${n.id}`,
      '  （先申请、再写产出：节点目录里有没挂上的 SUBPLAN.json 时，你的产出不算数。）',
      '★ 这条是 bus 的调度器按图派的（trust:"system"）——只叫你动你自己。',
    ].join('\n');
  }

  function workText(g, n, { redo }) {
    return [
      n.brief,
      '',
      ...(redo ? ['上一轮的输出被打回，原因（原样）：', String(redo).slice(0, TAIL), ''] : []),
      '输出要求：你的**全部输出**会被原样写成一个 markdown 文件，然后按小节检查。',
      `必须含这些标题（每节下面要有正文）：${n.requires.join(' / ')}`,
      '不要输出任何前言、不要把标题放进代码块。',
    ].join('\n');
  }

  // ── 派活 ───────────────────────────────────────────────────────────────

  /**
   * 派一个节点（第一次，或者打回后的重做）。**先落状态，再发消息。**
   * 可用性不过 ⇒ 不派；从 rejected 来的话退回 ready（带着打回原因，下次派的时候再说）。
   */
  async function dispatch(g, nid, { redo = null } = {}) {
    const n = g.nodes[nid];
    const st = g.states[nid];
    const attempt = (st.attempt || 0) + 1;
    const job_id = jobIdFor(g.id, nid, attempt);
    const redoWhy = redo || st.redo_why || null;
    const av = await availability(n, job_id);
    if (!av.ok) {
      if (st.state === S.REJECTED) {
        await transition(g, nid, S.READY, `打回后要重派，但现在派不了：${av.why}`, { redo_why: redoWhy });
      } else {
        await hold(g, nid, av.why);
      }
      return false;
    }
    await transition(g, nid, S.DISPATCHED,
      `${redoWhy ? '重派' : '派给'} ${n.kind === 'crew' ? n.assignee : `work:${n.assignee}`}（第 ${attempt} 次，job ${job_id}）`,
      { attempt, job_id, dispatched_at: iso(), reminded_at: null, result: null, result_note: null, redo_why: null });
    try {
      if (n.kind === 'crew') {
        await q.send(redis, av.target.stream, {
          from: G.SCHEDULER_NAME, to: n.assignee, text: crewDispatchText(g, n, { attempt, redo: redoWhy }),
          agent_type: 'graph', job_id, ...stamp.SYSTEM,
        });
      } else {
        await q.send(redis, av.target.stream, {
          from: G.SCHEDULER_NAME, to: av.target.to, text: workText(g, n, { redo: redoWhy }),
          agent_type: 'graph', job_id, ...stamp.SYSTEM,
          ...(n.cwd ? { cwd: n.cwd } : {}),
          ...(av.target.timeoutMs ? { timeout_ms: av.target.timeoutMs } : {}),
        });
      }
    } catch (e) {
      // 状态已经是 dispatched —— 不回滚（回滚又开一个「发出去了但状态说没发」的窗口）。超时会接住它。
      onLog(`[graph] ✗ ${g.id}/${nid} 状态已落 dispatched，消息没发出去：${e.message} —— 超时提醒会补发（crew）/ 超时判 failed（work）`);
      await hold(g, nid, `派活消息没发出去（${e.message}）—— 等超时提醒补发 / 判 failed`);
    }
    return true;
  }

  /** 打回：计数；满 MAX_REJECTS ⇒ blocked ＋ 上报；否则立刻重派（rejected → dispatched）。 */
  async function reject(g, nid, why) {
    const rejects = (g.states[nid].rejects || 0) + 1;
    await transition(g, nid, S.REJECTED, `被打回（第 ${rejects} 次）：${String(why).slice(0, TAIL)}`, { rejects });
    if (rejects >= G.MAX_REJECTS) {
      await transition(g, nid, S.BLOCKED, `同一节点被打回 ${rejects} 次 —— 等编排者决定`);
      await notifyOrch(g, nid, `节点 ${nid} blocked（被打回 ${rejects} 次）`, why);
      return;
    }
    await dispatch(g, nid, { redo: why });
  }

  // ── 判据 ───────────────────────────────────────────────────────────────

  /** stageGate（`lib/rooms.js`，复用，不重写）。since = 这一次派活的时刻 —— 上一轮的旧文件不算。 */
  function gate(g, n) {
    const full = absProduces(g, n);
    if (!full) return { ok: false, reasons: [`produces ${JSON.stringify(n.produces)} 越出图目录 —— 拒绝读`] };
    return rooms.stageGate(path.dirname(full), {
      name: n.id, role: n.assignee, produces: path.basename(full), requires: n.requires,
    }, { since: g.states[n.id].dispatched_at });
  }

  async function checkTimeout(g, nid) {
    const n = g.nodes[nid];
    const st = g.states[nid];
    const limit = n.timeout_min * 60_000;
    const elapsed = now() - Date.parse(st.dispatched_at);
    if (!Number.isFinite(elapsed)) return;
    if (elapsed >= limit * G.TIMEOUT_FAIL_FACTOR) {
      const why = `超时：已 dispatched ${Math.round(elapsed / 60_000)} 分钟 ≥ timeout_min×${G.TIMEOUT_FAIL_FACTOR}`
        + `（${n.timeout_min}×${G.TIMEOUT_FAIL_FACTOR}）`;
      await transition(g, nid, S.FAILED, why);
      await notifyOrch(g, nid, `节点 ${nid} failed（超时）`, why);
      return;
    }
    if (elapsed >= limit && !st.reminded_at && n.kind === 'crew') {
      // ★ 提醒**带原文**：如果当初那条派活恰好没发出去（先落状态的代价），这一条就是补发。
      await patchState(g, nid, { reminded_at: iso() });
      const target = await relay.resolveTarget(redis, { username: n.assignee }).catch(() => null);
      if (target && target.agent) {
        await q.send(redis, target.stream, {
          from: G.SCHEDULER_NAME, to: n.assignee, agent_type: 'graph', job_id: st.job_id, ...stamp.SYSTEM,
          text: `⏰ 提醒：节点 ${nid} 已超过 timeout_min（${n.timeout_min} 分钟）。再过一半时间没有合格产出就判 failed、上报编排者。\n\n`
            + crewDispatchText(g, n, { attempt: st.attempt, redo: null }),
        }).catch((e) => onLog(`[graph] ⚠ ${g.id}/${nid} 提醒没发出去：${e.message}`));
      }
    }
  }

  async function checkDispatched(g, nid) {
    const n = g.nodes[nid];
    const st = g.states[nid];
    if (n.kind === 'work') {
      if (!st.result) return checkTimeout(g, nid);
      if (st.result.ok === false) {
        await transition(g, nid, S.FAILED, `worker 失败且不会重投：${st.result.error}`);
        await notifyOrch(g, nid, `节点 ${nid} failed（worker 失败）`, st.result.error);
        return;
      }
      const r = gate(g, n);
      if (r.ok) return transition(g, nid, S.PRODUCED, r.reasons[r.reasons.length - 1]);
      return reject(g, nid, `worker 的输出没过 stageGate：${r.reasons.join('；')}`);
    }
    // kind:crew
    const r = gate(g, n);
    const kids = G.childrenDone(g.nodes, g.states, nid);
    if (!r.ok) {
      await hold(g, nid, `等产出：${r.reasons.join('；')}`);
      if (kids.done) await checkTimeout(g, nid);   // 有子节点在跑时不计时 —— 那时它在等子节点，不是卡住
      return;
    }
    // ★ 节点目录里有一份**没挂上**的 SUBPLAN.json ⇒ 它说过「我要往下拆」，产出不能先算数
    if (kids.total === 0 && fs.existsSync(path.join(g.meta.dir, nid, SUBPLAN_FILE))) {
      await hold(g, nid, `stageGate 过了，但节点目录里有一份还没挂上的 ${SUBPLAN_FILE} —— `
        + `给 ${G.SCHEDULER_NAME} 发「SUBPLAN ${g.id} ${nid}」申请；不拆了就删掉它`);
      return checkTimeout(g, nid);
    }
    if (!kids.done) {
      await hold(g, nid, `stageGate 过了，但子节点还没全部 verified（${kids.open.join(' / ')}）—— 父节点要等它们`);
      return;
    }
    return transition(g, nid, S.PRODUCED,
      `${r.reasons[r.reasons.length - 1]}${kids.total ? `；子节点 ${kids.total} 个全部 verified` : ''}`);
  }

  /**
   * verify 命令：**从磁盘上的 PLAN.json 读**，md5 要跟启动时冻结的一致（理由见文件头 🔴 那段）。
   * 子节点没有 verify（validateSubplan 拒了）⇒ 一定返回 { cmd: null }。
   */
  function verifyCommand(g, nid) {
    const n = g.nodes[nid];
    if (n.parent) return { cmd: null };
    let text;
    try { text = fs.readFileSync(path.join(g.meta.dir, PLAN_FILE), 'utf8'); } catch (e) {
      return { error: `读不到 ${PLAN_FILE}（${e.message}）—— verify 命令只从文件取，不从 redis 取` };
    }
    const md5 = rooms.md5Of(text);
    if (md5 !== g.meta.plan_md5) {
      return { error: `${PLAN_FILE} 在执行中被改了（启动时 md5 ${g.meta.plan_md5}，现在 ${md5}）—— verify 命令不可信，不跑` };
    }
    const def = (JSON.parse(text).nodes || []).find((x) => x && x.id === nid);
    return { cmd: def && typeof def.verify === 'string' ? def.verify : null };
  }

  /** 节点没写 verify ⇒ 问 defaultVerify。null ⇒ 没有默认验收。 */
  function fallbackVerify(g, nid) {
    if (!defaultVerify) return null;
    const cmd = defaultVerify(g.nodes[nid], { graphId: g.id, dir: g.meta.dir });
    return typeof cmd === 'string' && cmd.trim() ? cmd : null;
  }

  function runVerify(key, cmd) {
    const rec = { done: false, cmd };
    verifying.set(key, rec);
    execFile('/bin/sh', ['-c', cmd], { cwd: repoRoot, timeout: VERIFY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' },
      (e, stdout, stderr) => {
        rec.done = true;
        rec.ok = !e;
        rec.code = e ? (e.killed ? `超时（${VERIFY_TIMEOUT_MS / 1000}s）被杀` : (e.code ?? '?')) : 0;
        rec.tail = `${stdout || ''}${stderr || ''}`.slice(-TAIL);
      });
  }

  async function checkProduced(g, nid) {
    const st = g.states[nid];
    const v = verifyCommand(g, nid);
    if (v.error) {
      await transition(g, nid, S.BLOCKED, v.error);
      await notifyOrch(g, nid, `节点 ${nid} blocked（verify 跑不了）`, v.error);
      return;
    }
    const cmd = v.cmd || fallbackVerify(g, nid);
    if (!cmd) return transition(g, nid, S.VERIFIED, '没给 verify、也没有默认验收 —— 只看 stageGate（verify_complete 从 defaultVerify 接上）');
    const key = `${g.id}/${nid}/${st.attempt}`;
    const rec = verifying.get(key);
    if (!rec) {
      runVerify(key, cmd);
      await hold(g, nid, `verify 在跑：${cmd}`);
      return;
    }
    if (!rec.done) return;
    verifying.delete(key);
    if (rec.ok) return transition(g, nid, S.VERIFIED, `verify 过了（exit 0）：${rec.cmd}`);
    return reject(g, nid, `verify 没过（exit ${rec.code}）：${rec.cmd}\n${rec.tail}`);
  }

  // ── 一张图推一格 ───────────────────────────────────────────────────────
  async function advanceGraph(g) {
    // 全账号撞墙 ⇒ 整张图暂停。判据：**编排者**被 watchdog 判 rate_limited ——
    //   agent / worker / 编排者是同一个账号；编排者撞墙就是账号撞墙的最早信号，而它恢复时 watchdog 会清键。
    const acct = await rateLimited(orchName);
    if (g.meta.status === GS.RUNNING && acct) {
      await setStatus(g, GS.PAUSED, `编排者 ${orchName} 被 watchdog 判 rate_limited ⇒ 账号撞墙，整张图暂停（不派新活）`);
      return;
    }
    if (g.meta.status === GS.PAUSED && !acct) await setStatus(g, GS.RUNNING, `${orchName} 脱离 rate_limited ⇒ 恢复`);
    if (g.meta.status !== GS.RUNNING) return;

    for (const nid of g.order) if (g.states[nid].state === S.DISPATCHED) await checkDispatched(g, nid);
    for (const nid of g.order) if (g.states[nid].state === S.PRODUCED) await checkProduced(g, nid);

    for (const nid of G.depsSatisfied(g.nodes, g.states)) {
      const av = await availability(g.nodes[nid]);
      if (av.ok) await transition(g, nid, S.READY, '依赖全部 verified，assignee 可用');
      else await hold(g, nid, `依赖齐了，但 ${av.why}`);
    }

    const ready = g.order.filter((nid) => g.states[nid].state === S.READY);
    const candidates = [];
    for (const nid of ready) {
      const av = await availability(g.nodes[nid]);
      if (av.ok) candidates.push(nid); else await hold(g, nid, av.why);
    }
    const pick = G.pickDispatch({ nodes: g.nodes, states: g.states, maxParallel: g.meta.limits.max_parallel, candidates });
    for (const [nid, why] of Object.entries(pick.held)) await hold(g, nid, why);
    for (const nid of pick.dispatch) await dispatch(g, nid);

    if (G.allVerified(g.states)) {
      await setStatus(g, GS.VERIFIED, `全部 ${g.order.length} 个节点 verified`);
      await notifyOrch(g, null, `整张图 verified（${g.order.length} 个节点）`,
        `目标：${g.meta.goal}。下一步：汇总**一条**给 Patrick（不是每个节点一条），产出都在目录里。`);
    }
  }

  // ── 收件流：worker 结果、子图申请 ───────────────────────────────────────
  async function onWorkerResult(m, st, jid) {
    if (st.sender_type !== 'agent') return onLog(`[graph] ⚠ 一条自称 worker 结果的消息没有 agent 章（trust ${st.trust}），不认`);
    const g = await load(jid.gid);
    const n = g && g.nodes[jid.nid];
    const s = g && g.states[jid.nid];
    if (!n || !s || s.state !== S.DISPATCHED || s.job_id !== m.job_id) {
      return onLog(`[graph] ${m.job_id} 的结果到了，但节点现在不在等它（${s ? `${s.state} / job ${s.job_id}` : '没有这个节点'}）—— 旧结果，丢掉`);
    }
    if (m.from !== `worker:${n.assignee}`) return onLog(`[graph] ⚠ ${m.job_id} 的结果来自 ${m.from}，不是 worker:${n.assignee}，不认`);
    if (m.result_ok === '1') {
      if (m.result_output === undefined) {
        return patchState(g, jid.nid, { result: { ok: false, at: iso(), error: '结果里没有 result_output 字段（worker-pool 版本不对？）' } });
      }
      const full = absProduces(g, n);
      if (!full) return patchState(g, jid.nid, { result: { ok: false, at: iso(), error: 'produces 越出图目录，拒绝写' } });
      fs.mkdirSync(path.dirname(full), { recursive: true });
      // ★ worker 多数没有写盘能力 —— 调度器替它写成 produces，再走**同一个** stageGate
      fs.writeFileSync(full, String(m.result_output));
      return patchState(g, jid.nid, { result: { ok: true, at: iso() } });
    }
    if (m.will_retry === '1') return patchState(g, jid.nid, { result_note: String(m.text || '').slice(0, TAIL) });
    return patchState(g, jid.nid, { result: { ok: false, at: iso(), error: String(m.text || '').slice(0, TAIL) } });
  }

  async function onSubplan(m, st, gid, nid) {
    const sender = { from: String(m.from || ''), sender_type: st.sender_type };
    const g = await load(gid);
    const deny = async (errors) => {
      const text = `❌ SUBPLAN 被拒（图 ${gid} 节点 ${nid}），**什么都没挂**（不降级、不部分挂）：\n${G.formatErrors(errors)}`;
      // 只回带 agent 章的发件人：没章的那条可能是伪造的，回它等于替伪造者把消息投给它冒充的那个人
      if (st.sender_type === 'agent') await replyAgent(sender.from, text);
      if (g && errors.some((e) => e.bound)) {
        await notifyOrch(g, nid, `节点 ${nid} 的子图申请越界，被拒（发件人 ${sender.from || '?'} · trust ${st.trust}）`, G.formatErrors(errors));
      }
      onLog(`[graph] ✗ SUBPLAN ${gid}/${nid} 被拒（${sender.from} · ${st.trust}）：${errors.map((e) => e.message).join(' | ').slice(0, 300)}`);
    };
    if (!g) return deny([{ node: null, field: null, message: `图 ${gid} 不存在。`, bound: false }]);
    if (![GS.RUNNING, GS.PAUSED].includes(g.meta.status)) {
      return deny([{ node: null, field: 'status', message: `图现在是 ${g.meta.status}，不能挂子图。`, bound: false }]);
    }
    let sub;
    const file = path.join(g.meta.dir, nid, SUBPLAN_FILE);
    try { sub = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      return deny([{ node: nid, field: SUBPLAN_FILE, message: `读不了 / 不是 JSON：${file}（${e.message}）`, bound: false }]);
    }
    const v = G.validateSubplan({
      sub, parentId: nid, nodes: g.nodes, states: g.states, limits: g.meta.limits, sender, reserved,
    });
    const extra = [];
    if (v.ok) {
      // produces / brief_file 相对**节点目录**；冻结成相对图目录的路径，并且跟现有节点不撞
      const taken = new Set(Object.values(g.nodes).map((x) => path.posix.normalize(x.produces)));
      for (const c of sub.nodes) {
        const p = path.posix.normalize(path.posix.join(nid, c.produces));
        if (taken.has(p)) extra.push({ node: c.id, field: 'produces', message: `${p} 跟已有节点的产出是同一个文件。`, bound: false });
        taken.add(p);
        if (c.brief_file !== undefined) {
          try { c._brief = fs.readFileSync(path.join(g.meta.dir, nid, c.brief_file), 'utf8'); } catch (e) {
            extra.push({ node: c.id, field: 'brief_file', message: `读不到：${e.message}`, bound: false });
          }
        }
      }
    }
    if (!v.ok || extra.length) return deny([...v.errors, ...extra]);

    const base = Math.max(...Object.values(g.nodes).map((x) => x.order)) + 1;
    sub.nodes.forEach((c, i) => {
      const def = { ...c, brief: c._brief !== undefined ? c._brief : c.brief,
        produces: path.posix.join(nid, c.produces), parent: nid, depth: v.depth, order: base + i };
      delete def._brief;
      if (c.brief_file !== undefined) def.brief_file = path.posix.join(nid, c.brief_file);
      g.nodes[c.id] = def;
    });
    // 先落定义，再落状态（每个子节点 ∅ → pending 是一次转移，照样广播）
    await redis.hset(KEY.nodes(g.id), ...sub.nodes.flatMap((c) => [c.id, JSON.stringify(g.nodes[c.id])]));
    for (const c of sub.nodes) await transition(g, c.id, S.PENDING, `${nid} 的子图挂上了（深度 ${v.depth}）`);
    await replyAgent(sender.from, `✓ 子图挂上了（图 ${gid} 节点 ${nid}）：${sub.nodes.map((c) => c.id).join(' / ')}。`
      + `⚠️ ${nid} 要等它们全部 verified，你的产出才算数。`);
  }

  async function handleInbound(m) {
    const st = stamp.readStamp(m);
    const jid = parseJobId(m.job_id);
    if (String(m.from || '').startsWith('worker:') && jid) return onWorkerResult(m, st, jid);
    const first = String(m.text || '').trim().split('\n')[0];
    const sm = /^SUBPLAN\s+(\S+)\s+(\S+)\s*$/.exec(first);
    if (sm) return onSubplan(m, st, sm[1], sm[2]);
    // ★ 不认识的消息**不回** —— 回一句「格式不对」会让一个也爱回话的 agent 再回一句，
    //   两边互相触发（广播风暴的形状）。记日志，ack 掉。
    onLog(`[graph] 收件流里一条不认识的消息（from ${m.from} · trust ${st.trust}）：${String(m.text || '').slice(0, 120)}`);
  }

  async function drainInbox() {
    await q.ensureGroup(redis, INBOX, GROUP);
    // 上一个 bus 进程领了没 ack 的（崩在处理中途）⇒ 60 秒后捞回来
    const claimed = await q.autoclaim(redis, { stream: INBOX, group: GROUP, consumer: CONSUMER, minIdleMs: 60_000, count: 50 });
    // ★ 不带 BLOCK：主连接只许跑非阻塞命令（queue.nonBlockingOnly 守着）；调度器每 tick 读一次就够
    const res = await redis.xreadgroup('GROUP', GROUP, CONSUMER, 'COUNT', '100', 'STREAMS', INBOX, '>');
    const fresh = [];
    for (const [, entries] of res || []) {
      for (const [id, fields] of entries) {
        const o = { id };
        for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
        fresh.push(o);
      }
    }
    for (const m of [...claimed, ...fresh]) {
      try { await handleInbound(m); } catch (e) {
        onLog(`[graph] ✗ 处理收件流 ${m.id} 出错（照样 ack，不让它无限重投）：${e.message}`);
      }
      await q.ack(redis, INBOX, GROUP, m.id);
    }
  }

  /**
   * 登记 / 续命花名册。**调度器必须在册**：worker 的结果按花名册路由，
   * 不在册 ⇒ worker-pool 退回老路（`orch:in:agent`，bus 会把它推到网页）。
   * 没有 tmux 会话 ⇒ tmux_session 写空（watchdog 把它归「live」，按收件流的 idle 判，不会去 tmux 里打字）。
   */
  async function ensureRegistered() {
    const rec = await roster.lookup(redis, G.SCHEDULER_NAME);
    if (!rec || rec.type !== G.SCHEDULER_TYPE) {
      await roster.register(redis, G.SCHEDULER_NAME, { type: G.SCHEDULER_TYPE, tmux_session: '', cwd: repoRoot });
    } else {
      await roster.heartbeat(redis, G.SCHEDULER_NAME, { type: G.SCHEDULER_TYPE });
    }
  }

  async function doTick() {
    await ensureRegistered();
    await drainInbox();
    for (const id of await redis.smembers(KEY.INDEX)) {
      try {
        const g = await load(id);
        if (g) await advanceGraph(g);
      } catch (e) {
        onLog(`[graph] ✗ ${id} 这一 tick 出错：${e.stack || e.message}`);
      }
    }
  }

  let pendingTick = null;
  /** 一 tick。上一 tick 还没完就不叠一个新的（interval 比 tick 慢的时候不会越堆越多）。 */
  function tick() {
    if (pendingTick) return pendingTick;
    pendingTick = serial(doTick).finally(() => { pendingTick = null; });
    return pendingTick;
  }

  // ── 对外动作 ───────────────────────────────────────────────────────────

  /** 启动一张图：校验 → 冻结 → 落状态 → 人工闸。 */
  function start(dir, principal) {
    return serial(async () => {
      if (typeof dir !== 'string' || !dir) throw coded('BAD_DIR', 400, '要给图目录（含 PLAN.json）。');
      const rootReal = realOr(graphsRoot);
      const real = realOr(path.resolve(dir));
      if (!rootReal) throw coded('GRAPHS_ROOT_MISSING', 500, `图目录的根不存在：${graphsRoot}`, `mkdir -p ${graphsRoot}`);
      if (!real) throw coded('DIR_NOT_FOUND', 400, `目录不存在：${dir}`);
      const rel = path.relative(rootReal, real);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw coded('DIR_OUT_OF_ROOT', 400, `图目录必须在 ${graphsRoot} 下面（收到 ${real}）。`,
          '图的产出是要进 git 的文件；放到别处的话调度器也会拒绝写。');
      }
      let text;
      try { text = fs.readFileSync(path.join(real, PLAN_FILE), 'utf8'); } catch (e) {
        throw coded('PLAN_MISSING', 400, `读不到 ${path.join(real, PLAN_FILE)}：${e.message}`);
      }
      let plan;
      try { plan = JSON.parse(text); } catch (e) { throw coded('PLAN_INVALID', 400, `${PLAN_FILE} 不是 JSON：${e.message}`); }
      const v = G.validatePlan(plan, { reserved });
      if (!v.ok) throw coded('PLAN_INVALID', 400, `${PLAN_FILE} 没过校验：\n${G.formatErrors(v.errors)}`);
      if (path.basename(real) !== plan.id) {
        throw coded('PLAN_INVALID', 400, `PLAN.json 的 id（${plan.id}）要等于目录名（${path.basename(real)}）。`);
      }
      if (await redis.sismember(KEY.INDEX, plan.id)) {
        throw coded('GRAPH_EXISTS', 409, `图 ${plan.id} 已经启动过了。`, `看状态：node bin/graph.js status ${plan.id}；要重来就换个 id。`);
      }
      const nodes = {};
      for (const [i, n] of plan.nodes.entries()) {
        let brief = n.brief;
        if (n.brief_file !== undefined) {
          try { brief = fs.readFileSync(path.join(real, n.brief_file), 'utf8'); } catch (e) {
            throw coded('PLAN_INVALID', 400, `节点 ${n.id} 的 brief_file 读不到：${e.message}`);
          }
        }
        nodes[n.id] = { ...n, brief, parent: null, depth: 1, order: i };
      }
      let roomHash = plan.room_hash;
      if (roomHash) {
        if (!(await rooms.get(redis, roomHash))) throw coded('ROOM_NOT_FOUND', 400, `room_hash ${roomHash} 不存在。`, '去掉 room_hash 让调度器新建一个。');
      } else {
        roomHash = (await rooms.create(redis, `graph-${plan.id}`)).hash;
      }
      const approval = G.needsApproval(Object.values(nodes));
      const at = iso();
      const meta = {
        id: plan.id, goal: plan.goal, dir: real, plan_md5: rooms.md5Of(text), plan_text: text,
        limits: plan.limits, room_hash: roomHash, created_at: at,
        started_by: principal ? principal.username : null, started_via: principal ? principal.via : null,
        status: approval.needed ? GS.AWAITING_APPROVAL : GS.RUNNING, status_why: approval.why, status_at: at,
        approved_by: null, approved_via: null, approved_at: null, finished_at: null,
      };
      const g = { id: plan.id, meta, nodes, states: {}, order: plan.nodes.map((n) => n.id) };
      await redis.hset(KEY.nodes(g.id), ...Object.entries(nodes).flatMap(([k, n]) => [k, JSON.stringify(n)]));
      await saveMeta(g);
      await redis.sadd(KEY.INDEX, g.id);
      for (const nid of g.order) await transition(g, nid, S.PENDING, '图启动');
      await say(g, `已创建：${g.order.length} 个节点 · 状态 ${meta.status}（${meta.status_why}）· 目录 ${real}`);
      // 现在不在册的 agent：**不拒绝启动**（图可能跑几个小时，后面的 agent 可以晚点起），但说出来
      const missing = [];
      for (const n of Object.values(nodes)) {
        if (n.kind === 'crew' && !(await roster.lookup(redis, n.assignee).catch(() => null))) missing.push(n.assignee);
      }
      return {
        id: g.id, status: meta.status, why: meta.status_why, nodes: g.order.length, room_hash: roomHash, dir: real,
        not_in_roster_now: [...new Set(missing)],
      };
    });
  }

  function approve(id, principal) {
    return serial(async () => {
      const g = await load(id);
      if (!g) throw coded('GRAPH_NOT_FOUND', 404, `没有图 ${id}。`);
      if (g.meta.status !== GS.AWAITING_APPROVAL) throw coded('NOT_AWAITING', 409, `图 ${id} 现在是 ${g.meta.status}，不在等批。`);
      g.meta.approved_by = principal.username;
      g.meta.approved_via = principal.via;
      g.meta.approved_at = iso();
      await setStatus(g, GS.RUNNING, `${principal.username} 批了（via ${principal.via}）`);
      return { id, status: g.meta.status };
    });
  }

  function retry(id, nid, principal) {
    return serial(async () => {
      const g = await load(id);
      if (!g) throw coded('GRAPH_NOT_FOUND', 404, `没有图 ${id}。`);
      const st = g.states[nid];
      if (!st) throw coded('NODE_NOT_FOUND', 404, `图 ${id} 里没有节点 ${nid}。`);
      if (![S.FAILED, S.BLOCKED].includes(st.state)) throw coded('NOT_RETRYABLE', 409, `节点 ${nid} 现在是 ${st.state}，只有 failed / blocked 能重派。`);
      await transition(g, nid, S.PENDING, `${principal.username} 要求重来（via ${principal.via}）`, { rejects: 0, result: null });
      return { id, node: nid, state: S.PENDING };
    });
  }

  function cancel(id, principal) {
    return serial(async () => {
      const g = await load(id);
      if (!g) throw coded('GRAPH_NOT_FOUND', 404, `没有图 ${id}。`);
      if ([GS.VERIFIED, GS.CANCELLED].includes(g.meta.status)) throw coded('ALREADY_DONE', 409, `图 ${id} 已经是 ${g.meta.status}。`);
      await setStatus(g, GS.CANCELLED, `${principal.username} 放弃了这张图（via ${principal.via}）—— 已派出去的活不收回，结果到了也不再处理`);
      return { id, status: GS.CANCELLED };
    });
  }

  async function view(id) {
    const g = await load(id);
    if (!g) return null;
    const t = now();
    const { plan_text: _omit, ...meta } = g.meta;
    const rawLog = await redis.lrange(KEY.log(id), -200, -1);
    return {
      meta,
      nodes: g.order.map((nid) => {
        const n = g.nodes[nid];
        const s = g.states[nid] || {};
        return {
          id: nid, title: n.title, kind: n.kind, assignee: n.assignee, parent: n.parent, depth: n.depth,
          depends_on: n.depends_on, touches: n.touches, produces: n.produces,
          state: s.state, at: s.at, why: s.why, hold: s.hold || null, attempt: s.attempt || 0, rejects: s.rejects || 0,
          waited_s: s.at ? Math.round((t - Date.parse(s.at)) / 1000) : null,
        };
      }),
      log: rawLog.map((x) => JSON.parse(x)),
    };
  }

  async function list() {
    const out = [];
    for (const id of await redis.smembers(KEY.INDEX)) {
      const v = await view(id);
      if (!v) continue;
      const counts = {};
      for (const n of v.nodes) counts[n.state] = (counts[n.state] || 0) + 1;
      out.push({ id, goal: v.meta.goal, status: v.meta.status, status_why: v.meta.status_why,
        room_hash: v.meta.room_hash, dir: v.meta.dir, created_at: v.meta.created_at, counts, nodes: v.nodes.length });
    }
    return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  // ── HTTP（`bin/serve.js` 只挂载；理由跟 rooms 那几个 handler 一样：bin/ 测不到）──
  const fail = (res, e) => res.status(e.status || 503).json({ error: e.code || 'GRAPH_ERROR', message: e.message, next: e.next || null });
  return {
    tick, start, approve, retry, cancel, view, list, load,
    listHandler: () => async (_req, res) => { try { res.json({ graphs: await list() }); } catch (e) { fail(res, e); } },
    getHandler: () => async (req, res) => {
      try {
        const v = await view(req.params.id);
        if (!v) return res.status(404).json({ error: 'GRAPH_NOT_FOUND', message: `没有图 ${req.params.id}。` });
        res.json(v);
      } catch (e) { fail(res, e); }
    },
    startHandler: () => async (req, res) => {
      try { res.status(201).json(await start((req.body || {}).dir, req.principal)); } catch (e) { fail(res, e); }
    },
    approveHandler: () => async (req, res) => {
      try { res.json(await approve(req.params.id, req.principal)); } catch (e) { fail(res, e); }
    },
    retryHandler: () => async (req, res) => {
      try { res.json(await retry(req.params.id, req.params.node, req.principal)); } catch (e) { fail(res, e); }
    },
    cancelHandler: () => async (req, res) => {
      try { res.json(await cancel(req.params.id, req.principal)); } catch (e) { fail(res, e); }
    },
  };
}

module.exports = {
  createRunner, KEY, PLAN_FILE, SUBPLAN_FILE, VERIFY_TIMEOUT_MS, jobIdFor, parseJobId,
};
