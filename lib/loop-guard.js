'use strict';

/**
 * loop_guard（S1B）—— 「常驻 agent 回合结束 = 失聪」从靠自觉改成靠代码。三方共用的判据和文件都在这一份里：
 *   写的一侧   `hooks/loop_guard.js`（Stop hook：拦回 poller / 放行并写 `.stopped`）
 *              `bin/agent-pause.js`（人放 / 撤暂停标记）
 *   读的一侧   `lib/watchdog.js`（看 `.stopped` 快速兜底；看暂停标记不 nudge）
 * 各写一份的话，写的人改了文件名或字段，读的人照样「读到空」、零报错（同 lib/tool-journal.js 头注）。
 *
 * ── 文件（都在 guardDir() 下，默认 `temp/loop-guard/`）────────────────────
 *   `<name>.paused`   暂停标记（人放的）。在 crew sandbox 的写白名单之外 ⇒ agent 不能自己给自己放暂停逃出循环。
 *                     ⚠️ 编排者**没有 sandbox**（lib/agent-settings.js「编排者没有 sandbox」那段）⇒ 它的 Bash 写得到这里。
 *                       防不住被注入的编排者 —— 那是已接受的风险，跟它能改任何文件同一档。
 *   `<name>.stopped`  loop_guard 放行时写（时间戳 ＋ 原因）。watchdog 读；loop_guard 下次**拦**的时候删掉。
 *                     「agent 回到 poller 之后它就不算数」由 watchdog 按「标记时刻晚于最近一次 XREADGROUP」判，
 *                     不靠 next.js 删它 —— next.js 跑在 crew 的 sandbox 里，写不到这里（而且不该给它这个写权限）。
 *   `<name>.state.json`  loop_guard 自己的计数：连续拦了几次、最后一次拦在什么时刻。
 *   `<name>.stopcheck.json`  **stop_check** 的状态（上次测的改动指纹、红绿、同一指纹连拦几次）—— 它不再看 stop_hook_active，
 *                     见 hooks/stop_check.js 头注 ①。放在这里只是借同一个「crew 写不到」的目录，判据在 stop_check 自己那里。
 *
 * ── 「回到了 poller」用什么判：**工具调用日志**（`temp/journal/<name>.jsonl`，DUR1）──────────
 *   上一次拦之后，日志里有没有一次 **Bash 调用、命令里有 `bin/next.js`、而且真的在 poller 上待过**
 *   （outcome ok，或者失败但跑了 ≥ POLL_MIN_MS —— 被 Bash 超时掐掉的长阻塞也算）。
 *   为什么选它：
 *     · 零新写权限：日志由框架的 hook 在 sandbox 外写，crew 和编排者都挂了（恰好就是挂 loop_guard 的那两种）；
 *       换成「next.js 每次 touch 一个文件」就得给 crew 的 sandbox 多开一个写口子，还要动 next.js（model-facing contract）。
 *     · 零网络：不用在 hook 里连 Redis 读心跳 / 消费者组 idle（hook 每个回合都跑，越便宜越好）。
 *     · **能分出「poller 自己坏了」**：next.js 一起来就崩（exit 1，几十毫秒）⇒ outcome 不 ok、也没待够 ⇒ 不算回到 poller
 *       ⇒ 计数照涨 ⇒ N 次后放行。只认「有过这条命令」的话，一个启动即崩的 poller 会让计数每轮清零 ⇒ 死循环烧额度。
 *   代价 / 失效方向：
 *     · 日志缺行（journal hook 是 fail-open 的）、或者刚好轮转（只读当前那份的尾巴）⇒ 看不到那次 poll ⇒ 计数照涨
 *       ⇒ 提前放行 ⇒ watchdog 60 秒后推一把。**错的方向是「多放一次」，不是「多拦」**。
 *     · agent 能伪造（跑一句 `echo bin/next.js`）—— 伪造的效果是计数清零 ⇒ **被拦得更多**，不是逃出去。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** 名字判据（防路径穿越 —— 名字是文件名的一部分）。跟 lib/tool-journal.js / lib/rate-limit-signal.js 同一条。 */
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const validName = (n) => typeof n === 'string' && NAME_RE.test(n);

/**
 * 两次 poll 之间最多连续拦几次（R1 第 4 条）。
 * ★ 跟 Claude Code 自己的上限是两回事（实测 2.1.314，`claude -p` haiku，见 hooks/stop_check.js 头注）：
 *   它数的是「**中间没有任何工具调用**的连续拦截」，到第 9 次拦截时强行结束回合（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 可调）；
 *   中间夹着工具调用的话**根本不触发**（实测 15 次照拦）。
 *   ⇒ 它兜不住「模型被拦后跑了别的工具、就是不跑 poller」这一种 —— 那种只有这里的 N 兜得住。
 *   ⇒ 而「被拦后什么工具都不调、只回一句话」那一种，这里第 4 次放行（3 < 9），先于它；
 *     先于它是要紧的：它强行结束时**不经过这个 hook 的放行分支** ⇒ 不写 `.stopped` ⇒ watchdog 的快速兜底看不见。
 */
const BLOCK_LIMIT = 3;

/** 「真的在 poller 上待过」：失败的 poll 跑了这么久也算（被 Bash 超时掐掉的长阻塞）。启动即崩的是几十毫秒。 */
const POLL_MIN_MS = 30_000;

/** 只读日志文件的尾巴（上一次拦之后的那一小段就够；文件最大 5 MB 才轮转）。 */
const JOURNAL_TAIL_BYTES = 512 * 1024;

/**
 * 放行的原因。前两个 watchdog 会快速兜底（`FAST_NUDGE_REASONS`），后三个不推：
 *   paused     人放了暂停标记 —— 停住是人要的
 *   shutdown   bus 侧正在关停它 —— 推它会跟关停握手打架
 *   bus_down   bus 的 /health 不通（或 Redis 不通）—— poller 跑不起来，推也没用；bus 回来后的 15/20/30 分钟那套照旧兜
 *   limit      连续拦了 BLOCK_LIMIT 次还是没回到 poller（poller 坏了 / 模型不听）
 *   unexpected hook 自己出错、查不了关停状态 …… —— 任何意外都放行（不能把 agent 卡死），交给 watchdog
 */
const REASONS = ['paused', 'shutdown', 'bus_down', 'limit', 'unexpected'];
const FAST_NUDGE_REASONS = new Set(['limit', 'unexpected']);

/** `.stopped` 写下多久之后 watchdog 才推（R2）。给 agent 自己回来留一点时间。 */
const STOPPED_FAST_MS = 60_000;

/**
 * 标记目录。默认 `<EngLoop 根>/temp/loop-guard/` —— 不在 crew sandbox 的写白名单里（白名单是 temp/ 下逐个文件 ＋ busy/ ＋ plugin-runs/）。
 * `ENGLOOP_LOOP_GUARD_DIR`：**测试隔离用**（跟 ENGLOOP_JOURNAL_DIR / ENGLOOP_SIGNALS_DIR 同一类）。每次调用现读。
 */
function guardDir() {
  return process.env.ENGLOOP_LOOP_GUARD_DIR
    ? path.resolve(process.env.ENGLOOP_LOOP_GUARD_DIR)
    : path.join(ROOT, 'temp', 'loop-guard');
}

const fileFor = (suffix) => (name, dir = guardDir()) => (validName(name) ? path.join(dir, `${name}${suffix}`) : null);
const pausedFile = fileFor('.paused');
const stoppedFile = fileFor('.stopped');
const stateFile = fileFor('.state.json');
const stopCheckFile = fileFor('.stopcheck.json');

/** 原子写（先写临时文件再改名）：watchdog 和 hook 可能同时碰同一个文件，不能读到写了一半的 JSON。 */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj)}\n`);
  fs.renameSync(tmp, file);
}
function readJson(file) {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function rm(file) {
  if (!file) return false;
  try { fs.unlinkSync(file); return true; } catch (_) { return false; }
}

// ── 暂停 ─────────────────────────────────────────────────────────────

/** 有没有暂停标记。**只看文件在不在**（内容坏了也算暂停）—— 人放了标记，读不出内容不该让它失效。 */
function isPaused(name, { dir = guardDir() } = {}) {
  const f = pausedFile(name, dir);
  return !!f && fs.existsSync(f);
}
function setPaused(name, { dir = guardDir(), by = null, now = Date.now() } = {}) {
  const f = pausedFile(name, dir);
  if (!f) throw new Error(`loop-guard: 名字不合格 "${name}"（只许字母数字 _ -）`);
  writeJson(f, { at: new Date(now).toISOString(), by });
  return f;
}
function clearPaused(name, { dir = guardDir() } = {}) {
  return rm(pausedFile(name, dir));
}
function listPaused({ dir = guardDir() } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names.filter((f) => f.endsWith('.paused') && validName(f.slice(0, -'.paused'.length)))
    .map((f) => ({ name: f.slice(0, -'.paused'.length), ...(readJson(path.join(dir, f)) || {}) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── `.stopped` ───────────────────────────────────────────────────────

function writeStopped(name, reason, detail = '', { dir = guardDir(), now = Date.now() } = {}) {
  const f = stoppedFile(name, dir);
  if (!f) return null;
  writeJson(f, { at: now, at_iso: new Date(now).toISOString(), reason, detail: String(detail || '').slice(0, 500) });
  return f;
}
/** 读不出来 / 形状不对 ⇒ null（当没有标记 —— 错的方向是「少推一次」，原来的 15/20/30 分钟照兜）。 */
function readStopped(name, { dir = guardDir() } = {}) {
  const o = readJson(stoppedFile(name, dir));
  if (!o || !Number.isFinite(o.at) || !REASONS.includes(o.reason)) return null;
  return o;
}
function clearStopped(name, { dir = guardDir() } = {}) {
  return rm(stoppedFile(name, dir));
}

// ── 计数 ─────────────────────────────────────────────────────────────

function readState(name, { dir = guardDir() } = {}) {
  const o = readJson(stateFile(name, dir));
  return {
    blocks: o && Number.isInteger(o.blocks) && o.blocks >= 0 ? o.blocks : 0,
    last_block_at: o && Number.isFinite(o.last_block_at) ? o.last_block_at : null,
  };
}
function writeState(name, st, { dir = guardDir() } = {}) {
  const f = stateFile(name, dir);
  if (f) writeJson(f, st);
}

// ── 回到 poller 了没有 ───────────────────────────────────────────────

const POLL_CMD_RE = /(?:^|[\s"'/])bin\/next\.js\b/;

/**
 * `sinceMs` 之后，这个 agent 有没有真的在 poller 上待过（判据见文件头）。**纯读，不写。**
 * @returns {{polled:boolean, at?:string, reason?:string}}
 */
function polledSince(name, sinceMs, { journalDir } = {}) {
  const dir = journalDir || require('./tool-journal').journalDir();
  if (!validName(name)) return { polled: false, reason: 'bad_name' };
  const file = path.join(dir, `${name}.jsonl`);
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, JOURNAL_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) {
    return { polled: false, reason: 'no_journal' };
  }
  const intents = new Map();
  for (const line of text.split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }   // 尾巴切出来的第一行多半是半行
    if (!o || !o.tool_use_id) continue;
    if (o.phase === 'intent') {
      if (o.tool_name === 'Bash' && POLL_CMD_RE.test(String(o.input_summary || ''))) intents.set(o.tool_use_id, Date.parse(o.at));
      continue;
    }
    if (o.phase !== 'outcome' || !intents.has(o.tool_use_id)) continue;
    const end = Date.parse(o.at);
    const start = intents.get(o.tool_use_id);
    if (!Number.isFinite(end) || !(end > sinceMs)) continue;
    if (o.ok === true || (Number.isFinite(start) && end - start >= POLL_MIN_MS)) return { polled: true, at: o.at };
  }
  return { polled: false, reason: 'no_poll' };
}

// ── poller 命令 ──────────────────────────────────────────────────────

/**
 * 拦回去时告诉模型跑哪条命令。**照它们各自的引导文件写**（查过的实际跑法）：
 *   编排者：根 CLAUDE.md 写的是 `node bin/next.js`（不带参数 ⇒ 组 orch、流 orch:in:human,orch:in:agent）。
 *           类型靠环境变量：orch-start 用 `tmux -e ENGLOOP_AGENT_TYPE=orchestrator` 注入，一般继承得到；
 *           这里**显式带上前缀** —— 万一继承断了（被人从别的 shell 起的），next.js 的兜底是「group 不是 agent:* 就当编排者」，
 *           带前缀让它不靠那个兜底；而前缀对已经继承到的情况是无害的重复。
 *   crew：  templates/<type>/CLAUDE.md「你的循环」第 1 步：带 --group/--consumer/--streams/--name，输出重定向到 temp/poll-<name>.json
 *           （outbox-send 的自检读那个文件）。组和流走 roster 的唯一出处，不在这里拼。
 *           ⚠️ 不带 ENGLOOP_AGENT_TYPE 前缀：agent-start 注入了，模板也写着「不带前缀跑」。
 */
function pollerCommand({ kind, name, root = ROOT }) {
  const nextJs = path.join(root, 'bin', 'next.js');
  if (kind === 'orchestrator') return `ENGLOOP_AGENT_TYPE=orchestrator node ${nextJs}`;
  const roster = require('./roster');
  return `node ${nextJs} --group ${roster.groupFor(name, 'crew')} --consumer ${name}-1 --streams ${roster.inboxFor(name, 'crew')}`
    + ` --name ${name} > ${path.join(root, 'temp', `poll-${name}.json`)}`;
}

// ── watchdog 侧的判据 ────────────────────────────────────────────────

/**
 * 这个 `.stopped` 该不该让 watchdog **现在**推一把（R2）。**纯函数**，watchdog 和测试都用它。
 *
 * @param {object} o
 * @param {object|null} o.stopped     readStopped() 的结果
 * @param {number}      o.now
 * @param {number|null} o.minIdle     消费者组 idle（ms）；null = 从没读过
 * @param {number}      [o.outboxIdle] 多久没有 outbox 活动（Infinity = 从来没有）
 * @param {boolean}     [o.paused]
 * @param {boolean}     [o.shuttingDown]
 * @returns {{nudge:boolean, why:string}}
 */
function stoppedVerdict({ stopped, now, minIdle, outboxIdle = Infinity, paused = false, shuttingDown = false }) {
  if (!stopped) return { nudge: false, why: 'no_marker' };
  if (!FAST_NUDGE_REASONS.has(stopped.reason)) return { nudge: false, why: `reason_${stopped.reason}` };
  if (paused) return { nudge: false, why: 'paused' };
  if (shuttingDown) return { nudge: false, why: 'shutting_down' };
  if (now - stopped.at < STOPPED_FAST_MS) return { nudge: false, why: 'too_fresh' };
  // ★ 标记之后它读过队列 ⇒ 它已经回到 poller 了，标记作废。
  //   最近一次 XREADGROUP 的时刻 = now - idle（阻塞读开始时就会刷新 idle；阻塞中 idle 照涨，但那次读开始于标记之后）。
  const lastPoll = minIdle === null || minIdle === undefined ? -Infinity : now - minIdle;
  if (lastPoll >= stopped.at) return { nudge: false, why: 'polled_since' };
  // ★ 标记之后它还写过 outbox ⇒ 它在一个新回合里干活（人敲了一句 / 别的唤醒），不是停着。
  //   留 2 秒余量：回合最后一个动作常常就是写 outbox，relay 捡走文件（也会更新目录 mtime）可能落在标记之后几十毫秒。
  if (Number.isFinite(outboxIdle) && now - outboxIdle > stopped.at + 2000) return { nudge: false, why: 'active_since' };
  return { nudge: true, why: stopped.reason };
}

module.exports = {
  NAME_RE, BLOCK_LIMIT, POLL_MIN_MS, REASONS, FAST_NUDGE_REASONS, STOPPED_FAST_MS,
  guardDir, pausedFile, stoppedFile, stateFile, stopCheckFile,
  isPaused, setPaused, clearPaused, listPaused,
  writeStopped, readStopped, clearStopped,
  readState, writeState,
  polledSince, pollerCommand, stoppedVerdict,
};
