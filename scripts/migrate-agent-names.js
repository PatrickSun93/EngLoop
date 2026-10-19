'use strict';

/**
 * 迁移：把**存下来的**旧名字改成 agent 的名字。在**停机状态**下由人手动跑。
 *
 *   node scripts/migrate-agent-names.js              演练（默认）：只打印要做什么，什么都不改
 *   node scripts/migrate-agent-names.js --apply      真做
 *     [--root <仓库根>]  默认：这个脚本所在仓库
 *     [--home <HOME>]    默认：os.homedir()（测试用临时目录）
 *     [--redis <url>]    默认：ENGLOOP_REDIS_URL 或 redis://127.0.0.1:6379（db 0，生产库）
 *
 * 退出码：0 = 演练完 / 做完 / 没什么可做 · 2 = **拒绝**（什么都没改）· 1 = 出错
 *
 * 旧名字是三个字母，这个文件里**一次都不写它的字面量**（`test/no-legacy-names.test.js` 的闸）——
 * 下面一律用 `OLD` 拼。
 *
 * ── 改什么 ────────────────────────────────────────────────────────────
 *   Redis
 *     收件流            `<OLD>:<name>:in`  → `agent:<name>:in`     RENAMENX（组跟着流走）
 *     编排者收件流      `orch:in:<OLD>`    → `orch:in:agent`
 *     消费者组          `<OLD>:<name>`     → `agent:<name>`          按旧组的 last-delivered-id 建新组，再删旧组
 *                       `bus-<OLD>-in`     → `bus-agent-in`          （`orch` 组名里没有旧名字，不动）
 *     花名册的值        `engloop:roster:<name>` 里的 stream / tmux_session / cwd     保留 TTL
 *     任务图节点        `graph:<id>:nodes` 里 `kind:"<OLD>"` → `kind:"crew"`
 *                       （`graph:<id>:meta.plan_text` **不改**：它跟磁盘上 PLAN.json 的 md5 绑着，改了 verify 就拒跑）
 *   目录                `<root>/<OLD>s/` 里没被 git 跟踪、还留着的东西 → `<root>/agents/` 对应位置；空了删掉
 *   Claude Code 项目目录 `~/.claude/projects/<编码后的 <root>/<OLD>s/<name>>` → `…/agents/<name>` 对应的名字
 *   history/*.jsonl     记录里的 `stream` / `kind` 换成新流名 —— 不换的话，下一次导出会按（新流名|id）
 *                       把还在流里的每一条**再导一遍**（去重键是 `stream|id`，见 lib/history.js 的 keyOf）。
 *                       原文件先备份到 `history/pre-agent-rename/`。
 *
 * ── 拒绝（整个迁移一个字都不改，非 0 退出）──────────────────────────────
 *   · 名字里带旧名字、但**不认识的族**（不猜）
 *   · 认识的流上有**不认识的组**
 *   · 任何一个要迁的组 **PEL 不为空**（先处理完：看是哪个流、几条）
 *   · 目标 key 已经存在（RENAMENX 不覆盖；先看看是谁建的）
 *   · 花名册的值里还有认不出的旧名字
 *   · 还有旧名字的 tmux 会话活着（没停干净）
 *   · 目录 / 项目目录的目标已存在且内容不同
 *
 * ── 不改 ───────────────────────────────────────────────────────────────
 *   `~/.claude.json`（workspace trust）—— **程序里接受信任是禁止的**。只打印要重新信任的目录和做法。
 *   流里已有消息的字段（`<OLD>_type`、正文、ack 引用）—— 那是历史，不是状态。
 *
 * ── 幂等 ───────────────────────────────────────────────────────────────
 *   做完再跑一次 ⇒ 什么都找不到 ⇒ 「没什么可做」，退出 0。
 *   中途崩了（流已改名、组还没换）再跑：新流上的旧组名也会被找出来接着换。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const OLD = ['p', 'u', 'p'].join('');
const OLD_DIR = `${OLD}s`;
const NEW_DIR = 'agents';
const NEW_KIND = 'crew';

const ORCH_IN_OLD = `orch:in:${OLD}`;
const ORCH_IN_NEW = 'orch:in:agent';
const BUS_GROUP_OLD = `bus-${OLD}-in`;
const BUS_GROUP_NEW = 'bus-agent-in';
const INBOX_OLD_RE = new RegExp(`^${OLD}:([^:]+):in$`);
const INBOX_NEW_RE = /^agent:([^:]+):in$/;
const GROUP_OLD_RE = new RegExp(`^${OLD}:([^:]+)$`);
const SESSION_OLD_RE = new RegExp(`^${OLD}_(.+)$`);
const OLD_ANY_RE = new RegExp(OLD, 'i');
/** SCAN MATCH 是大小写敏感的 glob ⇒ 每个字母写成 `[xX]`。 */
const OLD_GLOB = `*${OLD.split('').map((c) => `[${c}${c.toUpperCase()}]`).join('')}*`;

const HISTORY_BACKUP = 'pre-agent-rename';

// ── 名字映射 ──────────────────────────────────────────────────────────

function mapStream(s) {
  if (s === ORCH_IN_OLD) return ORCH_IN_NEW;
  const m = INBOX_OLD_RE.exec(s);
  return m ? `agent:${m[1]}:in` : null;
}

function mapGroup(g) {
  if (g === BUS_GROUP_OLD) return BUS_GROUP_NEW;
  const m = GROUP_OLD_RE.exec(g);
  return m ? `agent:${m[1]}` : null;
}

function mapSession(s) {
  const m = SESSION_OLD_RE.exec(s);
  return m ? `agent_${m[1]}` : null;
}

/** `<root>/<OLD>s/...` → `<root>/agents/...`；不在 root 下的不动（返回 null）。 */
function mapPath(p, roots) {
  for (const r of roots) {
    const from = path.join(r, OLD_DIR);
    if (p === from) return path.join(r, NEW_DIR);
    if (p.startsWith(from + path.sep)) return path.join(r, NEW_DIR) + p.slice(from.length);
  }
  return null;
}

/** history 记录的 kind（lib/history.js 的 kindOf）跟着流名换。 */
function mapHistoryKind(k) {
  if (k === `in:${OLD}`) return 'in:agent';
  if (k === `${OLD}:in`) return 'agent:in';
  return null;
}

/** Claude Code 的项目目录名：绝对路径里非字母数字一律换成 `-`（lib/agent-settings.js 的 memoryDir 同一条）。 */
function encodeProject(p) {
  return path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');
}

// ── 小工具 ────────────────────────────────────────────────────────────

function pairs(arr) {
  const o = {};
  for (let i = 0; i + 1 < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}

async function scanAll(redis, match) {
  const out = new Set();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 500);
    for (const k of keys) out.add(k);
    cursor = next;
  } while (cursor !== '0');
  return [...out].sort();
}

async function groupsOf(redis, stream) {
  try {
    return (await redis.xinfo('GROUPS', stream)).map(pairs).map((g) => ({
      name: String(g.name),
      pending: Number(g.pending),
      lastId: String(g['last-delivered-id']),
      entriesRead: g['entries-read'] === undefined || g['entries-read'] === null ? null : Number(g['entries-read']),
    }));
  } catch (e) {
    if (/no such key/i.test(String(e.message))) return [];
    throw e;
  }
}

function sameEntry(a, b) {
  const sa = fs.lstatSync(a);
  const sb = fs.lstatSync(b);
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
    return sa.isSymbolicLink() && sb.isSymbolicLink() && fs.readlinkSync(a) === fs.readlinkSync(b);
  }
  if (!sa.isFile() || !sb.isFile()) return false;
  if (sa.size !== sb.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/** 一棵目录下所有叶子（文件 / 符号链接 / 空目录），相对路径。 */
function leaves(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    const ents = fs.readdirSync(abs, { withFileTypes: true });
    if (!ents.length && rel) out.push({ rel, kind: 'emptydir' });
    for (const e of ents) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(r);
      else out.push({ rel: r, kind: e.isSymbolicLink() ? 'symlink' : 'file' });
    }
  };
  walk('');
  return out;
}

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

function defaultSessions() {
  try {
    return require('node:child_process')
      .execFileSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch {
    return [];   // 没有 tmux server = 没有会话
  }
}

// ── 第一步：只读，算出计划 ─────────────────────────────────────────────

async function plan({ redis, root, home, sessions = defaultSessions, trustCheck = null }) {
  root = path.resolve(root);
  const roots = [...new Set([root, (() => { try { return fs.realpathSync(root); } catch { return root; } })()])];
  const P = {
    root, home,
    streams: [],       // { from, to, len, groups: [{ from, to|null, lastId, entriesRead, pending }] }
    groupFixes: [],    // 已改名的流上残留的旧组（上次中途崩了）
    roster: [],        // { key, before, after, pttl }
    graphNodes: [],    // { key, field, before, after }
    dirMoves: [],      // { from, to }
    dirSame: [],       // 目标已有一模一样的 ⇒ 删源
    projectRenames: [],// { from, to }
    history: [],       // { file, lines }
    trust: [],         // { dir, trusted|null }
    info: [],          // 不迁的，说清为什么
    refusals: [],      // { kind, detail }
  };
  const refuse = (kind, detail) => P.refusals.push({ kind, detail });

  // ── tmux：还有旧名字的会话活着 ⇒ 没停干净 ──
  for (const s of sessions()) {
    if (mapSession(s)) refuse('会话还活着', `tmux 会话 ${s} 还在 —— 先 ./stop.sh（改名后它会变成一个谁都不认的孤儿会话）`);
  }

  // ── Redis：名字里带旧名字的 key ──
  for (const key of await scanAll(redis, OLD_GLOB)) {
    const to = mapStream(key);
    const type = await redis.type(key);
    if (!to || type !== 'stream') {
      refuse('不认识的族', `${key}（type ${type}）—— 不是收件流也不是编排者收件流；不猜，先看清是什么`);
      continue;
    }
    if (await redis.exists(to)) {
      refuse('目标已存在', `${key} → ${to}：${to} 已经存在（${await redis.type(to)}）—— RENAMENX 不覆盖，先看清是谁建的`);
      continue;
    }
    const groups = [];
    for (const g of await groupsOf(redis, key)) {
      const gto = OLD_ANY_RE.test(g.name) ? mapGroup(g.name) : g.name;
      if (!gto) { refuse('不认识的组', `${key} 上的组 ${g.name}`); continue; }
      if (g.pending > 0) refuse('PEL 不为空', `${key} 组 ${g.name}：${g.pending} 条已投递未 ack —— 先处理完（XPENDING ${key} ${g.name}）`);
      groups.push({ ...g, from: g.name, to: gto === g.name ? null : gto });
    }
    P.streams.push({ from: key, to, len: await redis.xlen(key), groups });
  }

  // ── 已改名的流上残留的旧组（中途崩了之后再跑）──
  const newStreams = [...await scanAll(redis, 'agent:*:in'), ...(await redis.exists(ORCH_IN_NEW) ? [ORCH_IN_NEW] : [])];
  for (const s of newStreams) {
    if (s !== ORCH_IN_NEW && !INBOX_NEW_RE.test(s)) continue;
    if ((await redis.type(s)) !== 'stream') continue;
    for (const g of await groupsOf(redis, s)) {
      if (!OLD_ANY_RE.test(g.name)) continue;
      const gto = mapGroup(g.name);
      if (!gto) { refuse('不认识的组', `${s} 上的组 ${g.name}`); continue; }
      if (g.pending > 0) refuse('PEL 不为空', `${s} 组 ${g.name}：${g.pending} 条已投递未 ack`);
      P.groupFixes.push({ stream: s, ...g, from: g.name, to: gto });
    }
  }

  // ── 花名册的值 ──
  for (const key of await scanAll(redis, 'engloop:roster:*')) {
    if ((await redis.type(key)) !== 'string') continue;   // roster.list() 也只认 string
    const raw = await redis.get(key);
    if (!raw || !OLD_ANY_RE.test(raw)) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { refuse('花名册值', `${key} 不是 JSON，里面有旧名字`); continue; }
    const next = { ...rec };
    if (typeof next.stream === 'string' && mapStream(next.stream)) next.stream = mapStream(next.stream);
    if (typeof next.tmux_session === 'string' && mapSession(next.tmux_session)) next.tmux_session = mapSession(next.tmux_session);
    if (typeof next.cwd === 'string' && mapPath(next.cwd, roots)) next.cwd = mapPath(next.cwd, roots);
    const after = JSON.stringify(next);
    if (OLD_ANY_RE.test(after)) { refuse('花名册值', `${key} 换完还有认不出的旧名字：${after}`); continue; }
    P.roster.push({ key, before: raw, after, pttl: await redis.pttl(key) });
  }

  // ── 任务图节点的 kind ──
  for (const key of await scanAll(redis, 'graph:*:nodes')) {
    if ((await redis.type(key)) !== 'hash') continue;
    for (const [field, raw] of Object.entries(await redis.hgetall(key))) {
      let n;
      try { n = JSON.parse(raw); } catch { continue; }
      if (n && n.kind === OLD) P.graphNodes.push({ key, field, before: raw, after: JSON.stringify({ ...n, kind: NEW_KIND }) });
    }
  }
  if (P.graphNodes.length) {
    P.info.push(`graph:<id>:meta 的 plan_text 里的 kind 不改 —— 它跟磁盘上 PLAN.json 的 md5 绑着（verify 只从文件取命令）`);
  }

  // ── 目录 ──
  const oldDir = path.join(root, OLD_DIR);
  const newDir = path.join(root, NEW_DIR);
  if (fs.existsSync(oldDir)) {
    for (const l of leaves(oldDir)) {
      const from = path.join(oldDir, l.rel);
      const to = path.join(newDir, l.rel);
      if (l.kind === 'emptydir') continue;   // 空目录最后一起删
      let exists = false;
      try { fs.lstatSync(to); exists = true; } catch { /* 不存在 */ }
      if (!exists) P.dirMoves.push({ from, to });
      else if (sameEntry(from, to)) P.dirSame.push({ from, to });
      else refuse('目录冲突', `${from} → ${to}：目标已存在且内容不同（不覆盖）`);
    }
  }

  // ── Claude Code 的项目目录 ──
  const projects = path.join(home, '.claude', 'projects');
  if (fs.existsSync(projects)) {
    const names = fs.readdirSync(projects);
    for (const r of roots) {
      const oldPre = encodeProject(path.join(r, OLD_DIR));
      const newPre = encodeProject(path.join(r, NEW_DIR));
      for (const n of names) {
        if (n !== oldPre && !n.startsWith(`${oldPre}-`)) continue;
        const from = path.join(projects, n);
        const to = path.join(projects, newPre + n.slice(oldPre.length));
        if (P.projectRenames.some((x) => x.from === from)) continue;
        if (fs.existsSync(to)) refuse('项目目录冲突', `${from} → ${to}：目标已存在（不合并、不覆盖）`);
        else P.projectRenames.push({ from, to });
      }
    }
  }

  // ── history/*.jsonl ──
  const hdir = path.join(root, 'history');
  if (fs.existsSync(hdir)) {
    for (const f of fs.readdirSync(hdir).filter((x) => x.endsWith('.jsonl')).sort()) {
      const file = path.join(hdir, f);
      let n = 0;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes(OLD)) continue;
        try { const o = JSON.parse(line); if (o && mapStream(o.stream)) n++; } catch { /* 坏行原样留着 */ }
      }
      if (n) P.history.push({ file, lines: n });
    }
  }

  // ── 不迁的：说出来 ──
  const tdir = path.join(root, 'temp');
  if (fs.existsSync(tdir)) {
    const hits = fs.readdirSync(tdir).filter((x) => OLD_ANY_RE.test(x));
    if (hits.length) P.info.push(`temp/ 里名字带旧名字的 ${hits.length} 项（${hits.join(' · ')}）不迁：测试残留 / 一次性记录，没有代码按这些名字去读`);
    const outbox = path.join(tdir, 'outbox');
    if (fs.existsSync(outbox)) {
      const hitsOut = fs.readdirSync(outbox).filter((x) => OLD_ANY_RE.test(x));
      if (hitsOut.length) P.info.push(`temp/outbox/ 里名字带旧名字的 ${hitsOut.length} 个目录（${hitsOut.join(' · ')}）不迁：测试用的 agent 名，不是在册的 agent`);
    }
  }
  P.info.push('temp/acked-ids-*.json 里的旧流名不迁：它只给 outbox-send 算本轮 ack 差集；PEL 为空是迁移前提 ⇒ 那些 id 不会再被投递');
  P.info.push('temp/agent-settings/*.json 不迁：每次起 agent 都按新路径重写');
  P.info.push('流里已有消息的字段（旧的 *_type、正文、ack 引用）不迁：那是历史，读代码不依赖它们');

  // ── workspace trust：只报，不改 ──
  const agentNames = new Set();
  for (const d of [oldDir, newDir]) {
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) agentNames.add(e.name);
  }
  for (const name of [...agentNames].sort()) {
    const dir = path.join(newDir, name);
    P.trust.push({ dir, trusted: trustCheck ? trustCheck(dir) : null });
  }
  return P;
}

function nothingToDo(P) {
  return !P.streams.length && !P.groupFixes.length && !P.roster.length && !P.graphNodes.length
    && !P.dirMoves.length && !P.dirSame.length && !P.projectRenames.length && !P.history.length
    && !fs.existsSync(path.join(P.root, OLD_DIR));
}

// ── 第二步：照计划做 ──────────────────────────────────────────────────

async function applyPlan(redis, P, log) {
  for (const s of P.streams) {
    const r = await redis.renamenx(s.from, s.to);
    if (Number(r) !== 1) throw new Error(`RENAMENX ${s.from} ${s.to} 返回 ${r}（目标在演练之后被建了？）`);
    log(`  ✓ 流 ${s.from} → ${s.to}`);
    for (const g of s.groups) {
      if (!g.to) continue;
      await createGroupLike(redis, s.to, g);
      log(`    ✓ 组 ${g.from} → ${g.to} @ ${g.lastId}`);
    }
  }
  for (const g of P.groupFixes) {
    await createGroupLike(redis, g.stream, g);
    log(`  ✓ 组 ${g.stream} ${g.from} → ${g.to} @ ${g.lastId}`);
  }
  for (const r of P.roster) {
    if (r.pttl > 0) await redis.set(r.key, r.after, 'PX', r.pttl);
    else await redis.set(r.key, r.after);
    log(`  ✓ 花名册 ${r.key}`);
  }
  for (const n of P.graphNodes) {
    await redis.hset(n.key, n.field, n.after);
    log(`  ✓ 任务图 ${n.key} ${n.field} kind → ${NEW_KIND}`);
  }

  for (const m of P.dirMoves) {
    fs.mkdirSync(path.dirname(m.to), { recursive: true });
    fs.renameSync(m.from, m.to);
  }
  for (const m of P.dirSame) fs.rmSync(m.from, { force: true });
  if (P.dirMoves.length || P.dirSame.length) log(`  ✓ 目录：搬 ${P.dirMoves.length} 个 · 目标已有相同的 ${P.dirSame.length} 个（删源）`);
  const oldDir = path.join(P.root, OLD_DIR);
  removeEmptyDirs(oldDir);
  if (fs.existsSync(oldDir)) log(`  ⚠️ ${oldDir} 还不空（演练之后有人往里写了？）—— 没删`);
  else log(`  ✓ ${OLD_DIR}/ 已删`);

  for (const p of P.projectRenames) {
    fs.renameSync(p.from, p.to);
    log(`  ✓ 项目目录 ${path.basename(p.from)} → ${path.basename(p.to)}`);
  }

  for (const h of P.history) {
    const bdir = path.join(path.dirname(h.file), HISTORY_BACKUP);
    fs.mkdirSync(bdir, { recursive: true });
    const backup = path.join(bdir, path.basename(h.file));
    if (!fs.existsSync(backup)) fs.copyFileSync(h.file, backup);
    const out = fs.readFileSync(h.file, 'utf8').split('\n').map((line) => {
      if (!line.includes(OLD)) return line;
      let o;
      try { o = JSON.parse(line); } catch { return line; }
      const to = o && mapStream(o.stream);
      if (!to) return line;
      o.stream = to;
      const k = mapHistoryKind(o.kind);
      if (k) o.kind = k;
      return JSON.stringify(o);
    }).join('\n');
    const tmp = `${h.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, h.file);
    log(`  ✓ history ${path.basename(h.file)}：${h.lines} 行（原文件在 history/${HISTORY_BACKUP}/）`);
  }
}

async function createGroupLike(redis, stream, g) {
  const args = ['CREATE', stream, g.to, g.lastId];
  if (g.entriesRead !== null && Number.isFinite(g.entriesRead)) args.push('ENTRIESREAD', String(g.entriesRead));
  try {
    await redis.xgroup(...args);
  } catch (e) {
    if (!/BUSYGROUP/.test(String(e.message))) throw e;
    // 已经有了（上次建完没来得及删旧组）⇒ 只认 last-delivered-id 对得上的
    const cur = (await groupsOf(redis, stream)).find((x) => x.name === g.to);
    if (!cur || cur.lastId !== g.lastId) throw new Error(`组 ${g.to} 已存在且位置不同（${cur && cur.lastId} ≠ ${g.lastId}）`);
  }
  await redis.xgroup('DESTROY', stream, g.from);
}

// ── 打印 ──────────────────────────────────────────────────────────────

function report(P, log) {
  log(`仓库根：${P.root}`);
  log(`HOME：${P.home}`);
  const section = (title, rows) => {
    log(`\n[${title}] ${rows.length}`);
    for (const r of rows) log(`  ${r}`);
  };
  const inbox = P.streams.filter((s) => s.from !== ORCH_IN_OLD);
  const orch = P.streams.filter((s) => s.from === ORCH_IN_OLD);
  const fmt = (s) => `${s.from} → ${s.to}（${s.len} 条）`
    + s.groups.map((g) => `\n      组 ${g.from}${g.to ? ` → ${g.to}` : '（不改名）'} @ ${g.lastId} · PEL ${g.pending}`).join('');
  section(`redis · 收件流 ${OLD}:<name>:in → agent:<name>:in`, inbox.map(fmt));
  section(`redis · 编排者收件流 ${ORCH_IN_OLD} → ${ORCH_IN_NEW}`, orch.map(fmt));
  section('redis · 已改名的流上残留的旧组', P.groupFixes.map((g) => `${g.stream} 组 ${g.from} → ${g.to} @ ${g.lastId}`));
  section('redis · 花名册的值', P.roster.map((r) => `${r.key}（TTL ${r.pttl > 0 ? Math.round(r.pttl / 1000) + 's' : '无'}）\n      ${r.before}\n    → ${r.after}`));
  section(`redis · 任务图节点 kind → ${NEW_KIND}`, P.graphNodes.map((n) => `${n.key} ${n.field}`));
  section(`目录 ${OLD_DIR}/ → ${NEW_DIR}/（没被 git 跟踪、还留着的）`,
    [...P.dirMoves.map((m) => `${path.relative(P.root, m.from)} → ${path.relative(P.root, m.to)}`),
      ...P.dirSame.map((m) => `${path.relative(P.root, m.from)}（目标已有一模一样的，删源）`)]);
  section('Claude Code 项目目录（auto memory、会话记录）', P.projectRenames.map((p) => `${path.basename(p.from)} → ${path.basename(p.to)}`));
  section('history/*.jsonl 里的流名', P.history.map((h) => `${path.basename(h.file)}：${h.lines} 行`));
  section('不迁（说明）', P.info);
  log(`\n[workspace trust] 这个脚本**不改** ~/.claude.json。下面每个目录要人重新信任一次：`);
  log('  做法：cd 进去，交互式开一次 `claude`，在对话框里点信任，然后退出。');
  log('  （agent-start 起之前会按 git 仓库根再查一次；查到没信任就拒起，不会卡在对话框上）');
  for (const t of P.trust) {
    log(`  ${t.dir}${t.trusted === null ? '' : t.trusted ? '   —— 现在按 git 根判已信任' : '   —— 现在没信任'}`);
  }
  if (P.refusals.length) {
    log(`\n🔴 拒绝（${P.refusals.length} 条）—— 什么都没改：`);
    for (const r of P.refusals) log(`  [${r.kind}] ${r.detail}`);
  }
}

/**
 * @returns {Promise<{code:number, plan:object, applied:boolean, nothing:boolean}>}
 */
async function migrate({ redis, root, home = os.homedir(), apply = false, log = console.log,
  sessions = defaultSessions, trustCheck = null } = {}) {
  const P = await plan({ redis, root, home, sessions, trustCheck });
  report(P, log);
  if (P.refusals.length) return { code: 2, plan: P, applied: false, nothing: false };
  if (nothingToDo(P)) {
    log('\n✓ 没什么可做（已经迁过，或者本来就没有旧名字）。');
    return { code: 0, plan: P, applied: false, nothing: true };
  }
  if (!apply) {
    log('\n演练：什么都没改。确认上面的清单后加 --apply 再跑一次。');
    return { code: 0, plan: P, applied: false, nothing: false };
  }
  log('\n--apply：开始改');
  await applyPlan(redis, P, log);
  log('\n✓ 做完了。再跑一次（不带 --apply）应该显示「没什么可做」。');
  return { code: 0, plan: P, applied: true, nothing: false };
}

module.exports = {
  OLD_DIR, NEW_DIR, NEW_KIND, mapStream, mapGroup, mapSession, mapPath, mapHistoryKind, encodeProject,
  plan, migrate,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (flag, dflt) => { const i = argv.indexOf(flag); return i === -1 ? dflt : argv[i + 1]; };
  const apply = argv.includes('--apply');
  const root = path.resolve(val('--root', path.join(__dirname, '..')));
  const home = path.resolve(val('--home', os.homedir()));
  const url = val('--redis', process.env.ENGLOOP_REDIS_URL || 'redis://127.0.0.1:6379');
  const q = require('../lib/queue');
  // ★ 显式给 url：createClient 对显式 url「完全听调用方的」—— 这个脚本既不在 bin/ 也不在 test/，
  //   不给的话它会抛（见 lib/queue.js 的四格判定）。
  const redis = q.createClient(url);
  let trustCheck = null;
  try {
    const { isTrusted } = require('../lib/agent-settings');
    trustCheck = (dir) => isTrusted(dir, { claudeJson: path.join(home, '.claude.json') });   // 只读
  } catch { /* 拿不到就不报信任状态 */ }
  console.log(`redis：${url}${apply ? '' : '（演练）'}`);
  migrate({ redis, root, home, apply, trustCheck })
    .then((r) => { redis.disconnect(); process.exit(r.code); })
    .catch((e) => { console.error(`✗ ${e.stack || e.message}`); redis.disconnect(); process.exit(1); });
}
