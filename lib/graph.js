'use strict';

/**
 * 任务图 —— **纯函数那一半**。
 *
 * ── 为什么有它 ──────────────────────────────────────────────────────────
 *   房间流程（`protocols/flows/*.json` ＋ `lib/rooms.js`）是**一条写死的直线**：
 *   下一阶段 = `idx + 1` 或 `on_reject`。没有依赖图、没有并行分支、没有汇合 ——
 *   而「批内串行」的约束（两个任务没有语义依赖、却改同一个文件，就不能同时跑）
 *   如果不写成数据，**就只活在编排者脑子里，不在任何字段里**。
 *   ⇒ 这里把「一张临场画的图」变成数据：`depends_on` 管先后，`touches` 管「能不能同时」。
 *
 * ── 这个文件只做判断，不碰 redis / 文件系统 / 时钟 ─────────────────────
 *   校验、环、`touches` 重叠、ready 集合、这一 tick 派谁、子图能不能挂 —— 全是
 *   「给数据、回答案」。理由跟 `rooms.stageGate` 是纯函数同一条：
 *   **判据错了的症状是「图停在原地」，派活错了的症状是「有人收到了不该收的活」**，
 *   两者混在一个带 redis 的函数里，出问题时分不清是哪一半。
 *   有副作用的那一半在 `lib/graph-runner.js`。
 *
 * ── 没有静默默认值 ─────────────────────────────────────────────────────
 *   `limits` 三个字段、`timeout_min`、`touches`、`requires` 全部**必填**：
 *   一个没写 `touches` 的节点，默认成 `[]`（只读）会让它跟谁都能并行 ——
 *   那正是这张图要消灭的「约束只在脑子里」；默认成「整个仓库」又会让图悄悄串行。
 *   两个方向都不报错，所以不给默认，让写 PLAN 的人说出来。
 */

const path = require('node:path');
const rooms = require('./rooms');
const capabilities = require('./agent-capabilities');

/** 调度器在花名册里的名字和类型。**结果要投回这里**，所以它必须在册。 */
const SCHEDULER_NAME = 'GRAPH';
const SCHEDULER_TYPE = 'graph';

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const CREW_NAME_RE = /^[A-Za-z0-9_-]+$/;
// 跟 `lib/relay.js` 的 resolveWork 同一个形状 —— 这里先挡，入队时 relay 那条再挡一次。
const WORK_TYPE_RE = /^[a-z][a-z0-9_-]*$/;

const KINDS = Object.freeze(['crew', 'work']);

const S = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  DISPATCHED: 'dispatched',
  PRODUCED: 'produced',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  FAILED: 'failed',
  BLOCKED: 'blocked',
});

/**
 * 「占着位子」的状态：算进 `max_parallel`，也参与 `touches` 冲突判定。
 * ★ `produced` 也算 —— 它在等验收，验收不过会**回到 dispatched**；
 *   不算它的话，验收期间另一个改同一批文件的节点会被派出去，
 *   打回之后两个人同时在改同一个文件。
 */
const OCCUPYING = Object.freeze([S.DISPATCHED, S.PRODUCED, S.REJECTED]);

const GRAPH_STATUS = Object.freeze({
  AWAITING_APPROVAL: 'awaiting_approval',
  RUNNING: 'running',
  PAUSED: 'paused',
  VERIFIED: 'verified',
  CANCELLED: 'cancelled',
});

/**
 * 默认的人工闸（已定的策略，不在这里改）：
 * 有 `kind:"crew"` 节点，或节点数 > 5 ⇒ `awaiting_approval`。
 */
const APPROVAL_MAX_AUTO_NODES = 5;

/** 同一节点被打回几次 ⇒ blocked。 */
const MAX_REJECTS = 2;

/** `dispatched` 超过 timeout_min ⇒ 提醒；再超一半（×1.5）⇒ failed。 */
const TIMEOUT_FAIL_FACTOR = 1.5;

/** kind:work 的 timeout_min 上限 —— 跟 relay 的 WORK_TIMEOUT_MAX_MS（10 分钟）同一个数，理由在那边。 */
const WORK_TIMEOUT_MAX_MIN = 10;

const PLAN_KEYS = Object.freeze(['id', 'goal', 'room_hash', 'limits', 'nodes']);
const LIMIT_KEYS = Object.freeze(['max_parallel', 'max_depth', 'max_nodes']);
const NODE_KEYS = Object.freeze([
  'id', 'title', 'kind', 'assignee', 'depends_on', 'brief', 'brief_file',
  'produces', 'requires', 'touches', 'cwd', 'timeout_min', 'verify',
]);

// ── 小工具 ───────────────────────────────────────────────────────────────

function err(node, field, message, { bound = false } = {}) {
  return { node: node ?? null, field: field ?? null, message, bound };
}

/** 错误 → 人话。**指到哪个节点哪个字段**。 */
function formatErrors(errors) {
  return errors.map((e) => {
    const where = `${e.node != null ? `节点 ${e.node}` : '图'}${e.field ? ` 的 ${e.field}` : ''}`;
    return `· ${where}：${e.message}`;
  }).join('\n');
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;

/**
 * 一个相对路径落在不落在 `base` 里面（纯字符串判定，不碰文件系统）。
 * ★ 用 `path.relative` 判，不是「字符串里没有 `..`」—— `a/../../x` 不含 `../` 开头，
 *   而它照样出去了。跟 `lib/docs.js` 那套同一个理由。
 */
function insideDir(base, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return false;
  if (path.isAbsolute(rel)) return false;
  const full = path.resolve(base, rel);
  const r = path.relative(path.resolve(base), full);
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
}

/**
 * `touches` 的一项 → 规范形状：去掉开头的 `./`、末尾的 `/`；`.` 表示整个仓库 ⇒ `''`。
 * 返回 null = 不合法（绝对路径、带 `..`、空串）。
 */
function normTouch(p) {
  if (typeof p !== 'string') return null;
  const t = p.trim();
  if (!t || t.includes('\0') || path.isAbsolute(t)) return null;
  const n = path.posix.normalize(t.replace(/\\/g, '/'));
  if (n === '.' || n === './') return '';
  if (n.split('/').includes('..')) return null;
  return n.replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * 两个 `touches` 项是不是**前缀重叠**：
 *   `lib/` vs `lib/x.js` ⇒ 重叠（一个包含另一个）
 *   `lib/a.js` vs `lib/ab.js` ⇒ **不**重叠 —— 比的是**路径段**，不是字符串前缀
 *   `.`（整个仓库）跟任何东西都重叠
 */
function touchPairOverlaps(a, b) {
  const x = normTouch(a);
  const y = normTouch(b);
  if (x === null || y === null) return false;
  if (x === '' || y === '') return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** 两组 touches 第一对重叠的项，没有 ⇒ null。只读节点（`[]`）跟谁都不重叠。 */
function touchesOverlap(as, bs) {
  for (const a of as || []) {
    for (const b of bs || []) {
      if (touchPairOverlaps(a, b)) return [a, b];
    }
  }
  return null;
}

/** 子节点的一项 touches 是不是被父节点的某一项覆盖（相等或在它下面）。 */
function touchCoveredBy(child, parents) {
  const c = normTouch(child);
  if (c === null) return false;
  return (parents || []).some((p) => {
    const q = normTouch(p);
    if (q === null) return false;
    return q === '' || c === q || c.startsWith(`${q}/`);
  });
}

// ── 校验 ─────────────────────────────────────────────────────────────────

/**
 * 一个节点的字段校验（主图和子图共用）。
 * @param {object} n
 * @param {object} o
 * @param {string[]} o.reserved 不能当 assignee 的名字（编排者、调度器自己）
 */
function validateNode(n, idx, { reserved }) {
  const errors = [];
  const label = (n && typeof n.id === 'string' && n.id) ? n.id : `#${idx + 1}`;
  if (!isPlainObject(n)) return [err(label, null, '不是一个 JSON 对象。')];

  const unknown = Object.keys(n).filter((k) => !NODE_KEYS.includes(k));
  if (unknown.length) {
    errors.push(err(label, unknown.join(','), `不认识的字段（拼错了？）。认识的：${NODE_KEYS.join(' / ')}`));
  }
  if (typeof n.id !== 'string' || !ID_RE.test(n.id)) {
    errors.push(err(label, 'id', `要匹配 ${ID_RE}（小写字母、数字、连字符）—— 它也是节点目录名。`));
  }
  if (typeof n.title !== 'string' || !n.title.trim()) errors.push(err(label, 'title', '必填，一句话说这个节点干什么。'));

  if (!KINDS.includes(n.kind)) {
    errors.push(err(label, 'kind', `只能是 ${KINDS.join(' / ')}（crew = 派给在册的常驻 agent；work = 丢进 work:<type>）。`));
  } else if (n.kind === 'crew') {
    if (typeof n.assignee !== 'string' || !CREW_NAME_RE.test(n.assignee)) {
      errors.push(err(label, 'assignee', `kind=crew 时要填 agent 名（${CREW_NAME_RE}）。`));
    } else if (reserved.includes(n.assignee)) {
      errors.push(err(label, 'assignee', `"${n.assignee}" 是编排者 / 调度器自己，不能当节点的 assignee。`));
    }
  } else if (typeof n.assignee !== 'string' || !WORK_TYPE_RE.test(n.assignee) || !capabilities.isKnownType(n.assignee)) {
    errors.push(err(label, 'assignee', `kind=work 时要填一个已登记的 worker 类型（lib/agent-capabilities.js），`
      + `收到的是 ${JSON.stringify(n.assignee)}。`));
  }

  if (!Array.isArray(n.depends_on) || n.depends_on.some((d) => typeof d !== 'string')) {
    errors.push(err(label, 'depends_on', '必填，字符串数组（没有依赖写 []）。'));
  } else if (new Set(n.depends_on).size !== n.depends_on.length) {
    errors.push(err(label, 'depends_on', '有重复项。'));
  }

  const hasBrief = typeof n.brief === 'string' && n.brief.trim().length > 0;
  const hasFile = n.brief_file !== undefined;
  if (hasBrief === hasFile) {
    errors.push(err(label, 'brief', 'brief 和 brief_file **恰好给一个**（两个都给的话不知道听哪个）。'));
  }
  if (hasFile && !insideDir('/plan', n.brief_file)) {
    errors.push(err(label, 'brief_file', `要是本目录下的相对路径，不许越出（收到 ${JSON.stringify(n.brief_file)}）。`));
  }

  if (typeof n.produces !== 'string' || !insideDir('/plan', n.produces)) {
    errors.push(err(label, 'produces', `要是本目录下的相对路径，不许越出（收到 ${JSON.stringify(n.produces)}）。`));
  } else if (!rooms.safeProduces(path.basename(n.produces)) || /\/$/.test(n.produces)) {
    errors.push(err(label, 'produces', '文件名部分要是一个简单文件名（跟 protocols/flows 同一条：不许通配、不许以 / 结尾）。'));
  } else if (['PLAN.json', 'SUBPLAN.json'].includes(path.basename(n.produces))) {
    errors.push(err(label, 'produces', 'PLAN.json / SUBPLAN.json 是图自己的文件，不能当产出。'));
  }

  if (!Array.isArray(n.requires) || !n.requires.length
      || n.requires.some((r) => typeof r !== 'string' || !/^#{1,6}\s+\S/.test(r))) {
    errors.push(err(label, 'requires', '必填，非空的 markdown 标题数组（如 ["## 改了什么"]）。'
      + '★ 空的 requires 只能验到「文件非空」—— 3 个字节也算做完，那不是可检验的事实。'));
  }

  if (!Array.isArray(n.touches)) {
    errors.push(err(label, 'touches', '必填，预计改动的文件 / 目录前缀数组；只读节点写 []。'
      + '不确定时宁可写宽（写宽的代价是少并行，写窄的代价是两个人同时改一个文件）。'));
  } else {
    const bad = n.touches.filter((t) => normTouch(t) === null);
    if (bad.length) errors.push(err(label, 'touches', `这些项不合法（要相对仓库根、不许绝对路径、不许 ..）：${bad.join(' / ')}`));
  }

  if (n.cwd !== undefined && (typeof n.cwd !== 'string' || !path.isAbsolute(n.cwd))) {
    errors.push(err(label, 'cwd', '给了就要是绝对路径。'));
  }

  if (typeof n.timeout_min !== 'number' || !Number.isFinite(n.timeout_min) || n.timeout_min <= 0) {
    errors.push(err(label, 'timeout_min', '必填，正数（分钟）。超过它先提醒，再超一半判 failed。'));
  } else if (n.kind === 'work' && n.timeout_min > WORK_TIMEOUT_MAX_MIN) {
    errors.push(err(label, 'timeout_min', `kind=work 最多 ${WORK_TIMEOUT_MAX_MIN} 分钟 —— 超过池的超时，`
      + '重投窗口会先到，同一个 job 会并发跑两份（lib/relay.js 的 WORK_TIMEOUT_MAX_MS）。要更久就拆小。'));
  }

  if (n.verify !== undefined && (typeof n.verify !== 'string' || !n.verify.trim())) {
    errors.push(err(label, 'verify', '给了就要是一条非空命令（在仓库根跑，退出码 0 = 过）。'));
  }
  return errors;
}

/**
 * 找环。返回环上的节点序列（首尾相同），没有环 ⇒ null。
 * `deps(id)` 只返回**存在**的依赖 —— 悬空依赖由别处报，不在这里混成「有环」。
 */
function findCycle(ids, deps) {
  const color = new Map(ids.map((id) => [id, 0]));   // 0 白 · 1 灰（在栈上）· 2 黑
  const stack = [];
  function visit(id) {
    color.set(id, 1);
    stack.push(id);
    for (const d of deps(id)) {
      if (!color.has(d)) continue;
      if (color.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (color.get(d) === 0) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  }
  for (const id of ids) {
    if (color.get(id) === 0) {
      const c = visit(id);
      if (c) return c;
    }
  }
  return null;
}

/**
 * PLAN.json 校验。**全部过了才算过**，错误一次全报（不是报第一个就停：
 * 人改一个、跑一次、再看见下一个，那是在用他的时间换少写一个循环）。
 *
 * @param {object} plan
 * @param {object} o
 * @param {string[]} o.reserved   不能当 assignee 的名字（编排者名、调度器名）—— **必传**
 * @returns {{ok: boolean, errors: object[]}}
 */
function validatePlan(plan, { reserved } = {}) {
  if (!Array.isArray(reserved)) throw new Error('validatePlan 需要 reserved（编排者 / 调度器的名字），不给默认值');
  const errors = [];
  if (!isPlainObject(plan)) return { ok: false, errors: [err(null, null, 'PLAN.json 不是一个 JSON 对象。')] };

  const unknown = Object.keys(plan).filter((k) => !PLAN_KEYS.includes(k));
  if (unknown.length) errors.push(err(null, unknown.join(','), `不认识的顶层字段。认识的：${PLAN_KEYS.join(' / ')}`));
  if (typeof plan.id !== 'string' || !ID_RE.test(plan.id)) errors.push(err(null, 'id', `要匹配 ${ID_RE} —— 它也是目录名。`));
  if (typeof plan.goal !== 'string' || !plan.goal.trim()) errors.push(err(null, 'goal', '必填，一句话：这张图要交付什么。'));
  if (plan.room_hash !== undefined && (typeof plan.room_hash !== 'string' || !plan.room_hash)) {
    errors.push(err(null, 'room_hash', '给了就要是非空字符串；不给 = 新建一个房间。'));
  }
  if (!isPlainObject(plan.limits)) {
    errors.push(err(null, 'limits', `必填：{ ${LIMIT_KEYS.join(', ')} }，都是正整数。不给默认值 —— 限流写多少是你的判断。`));
  } else {
    for (const k of LIMIT_KEYS) {
      if (!isPosInt(plan.limits[k])) errors.push(err(null, `limits.${k}`, '必填，正整数。'));
    }
    const extra = Object.keys(plan.limits).filter((k) => !LIMIT_KEYS.includes(k));
    if (extra.length) errors.push(err(null, 'limits', `不认识的字段：${extra.join(' / ')}`));
  }
  if (!Array.isArray(plan.nodes) || !plan.nodes.length) {
    errors.push(err(null, 'nodes', '必填，非空数组。'));
    return { ok: false, errors };
  }

  plan.nodes.forEach((n, i) => errors.push(...validateNode(n, i, { reserved })));

  const ids = plan.nodes.map((n) => n && n.id).filter((x) => typeof x === 'string');
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) errors.push(err(id, 'id', '重复 —— 节点 id 在图内必须唯一。'));
    seen.add(id);
  }
  const prods = new Map();
  for (const n of plan.nodes) {
    if (!n || typeof n.produces !== 'string') continue;
    const k = path.posix.normalize(n.produces);
    if (prods.has(k)) errors.push(err(n.id, 'produces', `跟节点 ${prods.get(k)} 是同一个文件 —— 两个节点的产出必须分开，否则判据分不清是谁写的。`));
    else prods.set(k, n.id);
  }
  for (const n of plan.nodes) {
    if (!n || !Array.isArray(n.depends_on)) continue;
    for (const d of n.depends_on) {
      if (d === n.id) errors.push(err(n.id, 'depends_on', '依赖了自己。'));
      else if (!seen.has(d)) errors.push(err(n.id, 'depends_on', `依赖 "${d}" 不在图里（悬空依赖）。`));
    }
  }
  const byId = new Map(plan.nodes.filter((n) => n && typeof n.id === 'string').map((n) => [n.id, n]));
  const cycle = findCycle([...byId.keys()], (id) => (Array.isArray(byId.get(id).depends_on) ? byId.get(id).depends_on : []));
  if (cycle) errors.push(err(cycle[0], 'depends_on', `有环：${cycle.join(' → ')}`));

  if (isPlainObject(plan.limits) && isPosInt(plan.limits.max_nodes) && plan.nodes.length > plan.limits.max_nodes) {
    errors.push(err(null, 'nodes', `${plan.nodes.length} 个节点，超过 limits.max_nodes=${plan.limits.max_nodes}。`));
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 默认人工闸（已定）：有 `kind:"crew"` 或节点数 > 5 ⇒ 要 Patrick 批。
 * @returns {{needed: boolean, why: string}}
 */
function needsApproval(nodes) {
  const crews = nodes.filter((n) => n.kind === 'crew').map((n) => n.id);
  if (crews.length) return { needed: true, why: `有 kind:"crew" 节点（${crews.join(' / ')}）—— 占用常驻 agent 要 Patrick 批` };
  if (nodes.length > APPROVAL_MAX_AUTO_NODES) {
    return { needed: true, why: `${nodes.length} 个节点 > ${APPROVAL_MAX_AUTO_NODES} —— 规模大的图要 Patrick 批` };
  }
  return { needed: false, why: `只有 kind:"work"、${nodes.length} 个节点 ≤ ${APPROVAL_MAX_AUTO_NODES} —— 自动开跑` };
}

// ── 调度判定 ─────────────────────────────────────────────────────────────

/** a 是不是 b 的祖先（沿 parent 链）。 */
function isAncestor(nodes, a, b) {
  let cur = nodes[b] && nodes[b].parent;
  while (cur) {
    if (cur === a) return true;
    cur = nodes[cur] && nodes[cur].parent;
  }
  return false;
}

/** 一个节点的直接子节点 id。 */
function childrenOf(nodes, id) {
  return Object.keys(nodes).filter((k) => nodes[k].parent === id);
}

/**
 * 父节点的「子节点全 verified 了吗」。没有子节点 ⇒ true。
 * ★ **父节点要等全部子节点 verified 之后，自己的 stageGate 才算数**。
 */
function childrenDone(nodes, states, id) {
  const kids = childrenOf(nodes, id);
  const open = kids.filter((k) => !states[k] || states[k].state !== S.VERIFIED);
  return { done: open.length === 0, open, total: kids.length };
}

/**
 * 哪些 pending 节点的**依赖条件**满足了（不含「在不在册」—— 那是 runner 查的）。
 *   · 依赖全部 verified
 *   · 子节点还要求父节点在 dispatched（父节点都还没开始 / 已经结束，子节点没有意义）
 */
function depsSatisfied(nodes, states) {
  const out = [];
  for (const id of Object.keys(nodes)) {
    const st = states[id];
    if (!st || st.state !== S.PENDING) continue;
    const n = nodes[id];
    const depsOk = (n.depends_on || []).every((d) => states[d] && states[d].state === S.VERIFIED);
    if (!depsOk) continue;
    if (n.parent && !(states[n.parent] && states[n.parent].state === S.DISPATCHED)) continue;
    out.push(id);
  }
  return out;
}

/**
 * 这一 tick 派谁。**纯函数** —— touches 冲突和 max_parallel 都在这里判。
 *
 * @param {object} o
 * @param {object} o.nodes       id → 定义（含 parent）
 * @param {object} o.states      id → { state }
 * @param {number} o.maxParallel
 * @param {string[]} o.candidates  ready 且 assignee 现在可用的节点（按图里的顺序）
 * @returns {{dispatch: string[], held: Object<string,string>}}  held = 这一轮不派的原因（人话）
 */
function pickDispatch({ nodes, states, maxParallel, candidates }) {
  if (!isPosInt(maxParallel)) throw new Error('pickDispatch 需要正整数 maxParallel（不给默认值）');
  const occupied = Object.keys(states).filter((id) => OCCUPYING.includes(states[id].state));
  const dispatch = [];
  const held = {};
  for (const id of candidates) {
    if (occupied.length >= maxParallel) {
      held[id] = `max_parallel=${maxParallel} 已满（占着位子的：${occupied.join(' / ')}）`;
      continue;
    }
    let clash = null;
    for (const o of occupied) {
      // ★ 祖先 / 后代不算冲突：子节点的 touches 本来就是父节点的子集，
      //   父节点在等子节点 —— 把它们判成冲突的话，子节点永远派不出去。
      if (isAncestor(nodes, o, id) || isAncestor(nodes, id, o)) continue;
      const pair = touchesOverlap(nodes[id].touches, nodes[o].touches);
      if (pair) { clash = { o, pair }; break; }
    }
    if (clash) {
      held[id] = `touches 跟 ${clash.o}（${states[clash.o].state}）重叠：${clash.pair[0]} ↔ ${clash.pair[1]} —— 等它结束`;
      continue;
    }
    dispatch.push(id);
    occupied.push(id);
  }
  return { dispatch, held };
}

/** 整张图做完了吗：每个节点都 verified。 */
function allVerified(states) {
  const ids = Object.keys(states);
  return ids.length > 0 && ids.every((id) => states[id].state === S.VERIFIED);
}

// ── 子图 ──────────────────────────────────────────────────────────────────

/**
 * 子图申请的校验。**全部过了才挂**；任何一条不过 ⇒ 拒绝，不降级、不部分挂。
 *
 * `bound: true` 的错误 = **越界**（不是写错）：要转给编排者决定。
 *
 * @param {object} o
 * @param {object} o.sub        SUBPLAN.json 的内容（只有 nodes）
 * @param {string} o.parentId
 * @param {object} o.nodes      图里现有的节点（id → 定义，含 depth）
 * @param {object} o.states
 * @param {object} o.limits     { max_depth, max_nodes }
 * @param {object} o.sender     { from, sender_type } —— **只从 bus 的章取**
 * @param {string[]} o.reserved
 */
function validateSubplan({ sub, parentId, nodes, states, limits, sender, reserved }) {
  const errors = [];
  const parent = nodes[parentId];
  if (!parent) return { ok: false, errors: [err(parentId, null, '图里没有这个节点。')] };

  // ── 身份：章说了算，正文里写的名字不算 ──
  if (!sender || sender.sender_type !== 'agent') {
    errors.push(err(parentId, 'sender', `申请必须来自一个 agent（bus 盖的章 sender_type:"agent"），`
      + `收到的章是 ${JSON.stringify(sender && sender.sender_type)}。`, { bound: true }));
  } else if (sender.from !== parent.assignee) {
    errors.push(err(parentId, 'sender', `只有这个节点的 assignee（${parent.assignee}）能申请往下拆，`
      + `发件人是 ${JSON.stringify(sender.from)}。`, { bound: true }));
  }
  if (parent.kind !== 'crew') errors.push(err(parentId, 'kind', '只有 kind:"crew" 的节点能往下拆。', { bound: true }));
  const st = states[parentId] && states[parentId].state;
  if (st !== S.DISPATCHED) errors.push(err(parentId, 'state', `节点现在是 ${st}，只有 dispatched（正在干）的节点能挂子图。`));
  if (childrenOf(nodes, parentId).length) errors.push(err(parentId, null, '这个节点已经挂过子图了 —— 一个节点只挂一次；要改，找编排者改主图。'));

  if (!isPlainObject(sub)) return { ok: false, errors: [...errors, err(parentId, 'SUBPLAN.json', '不是一个 JSON 对象。')] };
  const extra = Object.keys(sub).filter((k) => k !== 'nodes');
  if (extra.length) errors.push(err(parentId, 'SUBPLAN.json', `只认 nodes，不认识：${extra.join(' / ')}（limits 只能由编排者在主图里定）。`));
  if (!Array.isArray(sub.nodes) || !sub.nodes.length) {
    errors.push(err(parentId, 'SUBPLAN.json', 'nodes 必须是非空数组。'));
    return { ok: false, errors };
  }

  sub.nodes.forEach((n, i) => {
    errors.push(...validateNode(n, i, { reserved }));
    const label = (n && n.id) || `#${i + 1}`;
    // ★ 越界：子节点只能是 worker —— agent 不能拉起或占用常驻 agent（起停常驻 agent 是编排者的权力）
    if (n && n.kind !== 'work') {
      errors.push(err(label, 'kind', `子节点只能是 kind:"work"（收到 ${JSON.stringify(n.kind)}）—— `
        + '占用常驻 agent 是编排者的权力。', { bound: true }));
    }
    // ★ 越界：verify 是在 **bus 进程里、仓库根上** 跑的一条 shell 命令 ——
    //   让 agent 写的文件决定它，等于给 agent 一个出 sandbox 的口子。
    if (n && n.verify !== undefined) {
      errors.push(err(label, 'verify', '子节点不许带 verify —— 它会在 bus 进程里执行（sandbox 之外）。'
        + '要验收命令，找编排者加到主图里。', { bound: true }));
    }
    if (n && Array.isArray(n.touches)) {
      const out = n.touches.filter((t) => !touchCoveredBy(t, parent.touches));
      if (out.length) {
        errors.push(err(label, 'touches', `${out.join(' / ')} 不在父节点的 touches（${(parent.touches || []).join(' / ') || '[]'}）里面 —— `
          + '子节点只能改父节点声明过的范围。', { bound: true }));
      }
    }
    if (n && typeof n.id === 'string' && nodes[n.id]) errors.push(err(label, 'id', '跟图里已有的节点重名。'));
  });

  const ids = sub.nodes.map((n) => n && n.id).filter((x) => typeof x === 'string');
  if (new Set(ids).size !== ids.length) errors.push(err(parentId, 'SUBPLAN.json', '子节点 id 有重复。'));
  for (const n of sub.nodes) {
    if (!n || !Array.isArray(n.depends_on)) continue;
    for (const d of n.depends_on) {
      if (!ids.includes(d) || d === n.id) {
        errors.push(err(n.id, 'depends_on', `"${d}" 不是同一份 SUBPLAN 里的另一个节点 —— 子节点只能依赖兄弟节点。`));
      }
    }
  }
  const byId = new Map(sub.nodes.filter((n) => n && typeof n.id === 'string').map((n) => [n.id, n]));
  const cycle = findCycle([...byId.keys()], (id) => (Array.isArray(byId.get(id).depends_on) ? byId.get(id).depends_on : []));
  if (cycle) errors.push(err(cycle[0], 'depends_on', `有环：${cycle.join(' → ')}`));

  // ── 越界：深度、全图节点数 ──
  const depth = (parent.depth || 1) + 1;
  if (!isPlainObject(limits) || !isPosInt(limits.max_depth) || !isPosInt(limits.max_nodes)) {
    errors.push(err(null, 'limits', '图的 limits 读不到 —— 判不了深度和节点数，不挂。', { bound: true }));
  } else {
    if (depth > limits.max_depth) {
      errors.push(err(parentId, 'depth', `挂上去之后深度是 ${depth}，超过 limits.max_depth=${limits.max_depth}。`, { bound: true }));
    }
    const total = Object.keys(nodes).length + sub.nodes.length;
    if (total > limits.max_nodes) {
      errors.push(err(parentId, 'nodes', `挂上去之后全图 ${total} 个节点，超过 limits.max_nodes=${limits.max_nodes}。`, { bound: true }));
    }
  }
  return { ok: errors.length === 0, errors, depth };
}

module.exports = {
  SCHEDULER_NAME, SCHEDULER_TYPE, KINDS, S, OCCUPYING, GRAPH_STATUS,
  APPROVAL_MAX_AUTO_NODES, MAX_REJECTS, TIMEOUT_FAIL_FACTOR, WORK_TIMEOUT_MAX_MIN,
  ID_RE, NODE_KEYS,
  insideDir, normTouch, touchPairOverlaps, touchesOverlap, touchCoveredBy,
  validateNode, validatePlan, findCycle, formatErrors, needsApproval,
  isAncestor, childrenOf, childrenDone, depsSatisfied, pickDispatch, allVerified,
  validateSubplan,
};
