'use strict';

/**
 * 工具调用日志（DUR1）—— 每个 agent 一份只追加的 `temp/journal/<name>.jsonl`，外加一份 `<name>.session`。
 *
 * 写的一侧是 `hooks/tool_journal.js`（由 `lib/agent-settings.js` 挂给 crew 和编排者）；
 * 读的一侧有两个：`bin/next.js` 交出重投消息时算 `recovery`（S2），`bin/agent-start.js --resume` 读 session（S3）。
 * 两侧的格式、路径、判据都在这一个文件里 —— 各写一份的话，写的人改了字段名，读的人照样「读到空」、零报错。
 *
 * ── 为什么要它 ─────────────────────────────────────────────────────────
 *   消息被 autoclaim 重投（`redelivered: true`）时，上一次处理到哪一步、副作用发生没有，
 *   原来**全靠模型自己去想** —— 而它手上一点材料都没有（崩溃前那段上下文跟着进程没了）。
 *   ⇒ 这里在每次工具调用前记一行 intent、调用后记一行 outcome，重投时按 `tool_use_id` 配对给它看。
 *
 * ── 跟 durable-harness 的**有意差别**：不做屏障 ───────────────────────────
 *   它的 hook 要等 intent 落进 log 才放行工具调用（fail-closed）。这里**不等、不拦、不做任何决定**：
 *   一个 fail-closed 的屏障，在磁盘满 / 目录权限坏 / 文件被锁的时候会让**所有** agent 同时停下来 ——
 *   为了一份「事后给模型参考」的日志，赔上整个系统的可用性，不值。
 *   ⇒ 代价：日志可能缺行。所以 `recovery` 里永远带着 NOTE 那句「这里没有 ≠ 没做过」。
 *
 * ── 实测（Claude Code 2.1.312，`claude -p --settings <临时配置>`，临时目录，不是在册 agent）──────
 *   · PreToolUse / PostToolUse / PostToolUseFailure 的 stdin **都有 `tool_use_id`**（形如 `toolu_…`），同一次调用三处一致。
 *   · 执行失败（Bash 非零退出、Read 文件不存在）**不走 PostToolUse，走 PostToolUseFailure**（带 `error`、`is_interrupt`）
 *     ⇒ outcome 两个事件都要挂，否则失败的调用看起来跟「执行中崩溃」一样。
 *   · 被 check_security 拒掉（exit 2）的调用：journal 的 PreToolUse **照样触发**；PostToolUse、PostToolUseFailure
 *     **都不触发**。被 dontAsk 权限拒掉的调用同样只有 PreToolUse（`PermissionDenied` hook 也没触发）。
 *     ⇒「只有 intent、没有 outcome」有两个成因 —— 执行中崩溃 / 根本没执行 —— **hook 层分不出来**，NOTE 里两种都说。
 *   · 两个 PreToolUse 条目（check_security ＋ tool_journal）**并行起跑**：起始时刻差 1–2 ms，各自忙等 400 ms 的区间完全重叠。
 *     ⇒ journal 看不到 check_security 的结论、也影响不了它（journal 退出码 0、stdout 空 ⇒ 不是任何决定）。
 */

const fs = require('node:fs');
const path = require('node:path');

/** `--name` 的判据：防路径穿越（`../x`），也是文件名的一部分。跟 `lib/rate-limit-signal.js` 同一条。 */
const NAME_RE = /^[A-Za-z0-9_-]+$/;
/** `input_summary` 的上限（字节，UTF-8）。 */
const INPUT_MAX = 1024;
/** tool_input 里 `command` 以外的每个字符串字段先各截到这么多字节（见 summarize）。 */
const FIELD_MAX = 256;
/**
 * 一行的上限（字节，含换行）。一次 `appendFileSync` = 一次 O_APPEND 的 write()：
 * 本地文件系统上，几 KB 以内的单次追加不会跟别的进程的追加交错（并行的工具调用会让几个 hook 进程同时写）。
 * 4 KB 是保守取值 —— 跟一页 / PIPE_BUF 同量级；POSIX 对普通文件没有给出字节数保证，这是工程上的取舍。
 */
const LINE_MAX = 4096;
/** 超过这么大就轮转成 `.1`（只留一份）。 */
const ROTATE_BYTES = 5 * 1024 * 1024;
/** 只读工具。**其余一律算「可能已生效」** —— Bash 不解析命令内容（解析器会漏，而漏的方向是「把写当成读」）。 */
const READONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);

/** hook 命令行上的 `--event` 取值 ⇒ 写哪种行。生成配置时写死（见 lib/agent-settings.js）。 */
const EVENTS = ['intent', 'outcome', 'failure', 'session'];

/**
 * 日志目录。默认 `<EngLoop 根>/temp/journal/` —— 在 crew agent 的 sandbox 写集之外（agent 伪造不了自己的日志）。
 * `ENGLOOP_JOURNAL_DIR`：**只给测试隔离用**（跟 `ENGLOOP_SIGNALS_DIR` 同一类）。每次调用现读。
 */
function journalDir() {
  return process.env.ENGLOOP_JOURNAL_DIR
    ? path.resolve(process.env.ENGLOOP_JOURNAL_DIR)
    : path.join(__dirname, '..', 'temp', 'journal');
}

const validName = (name) => typeof name === 'string' && NAME_RE.test(name);
function journalFile(name, dir = journalDir()) {
  return validName(name) ? path.join(dir, `${name}.jsonl`) : null;
}
function sessionFile(name, dir = journalDir()) {
  return validName(name) ? path.join(dir, `${name}.session`) : null;
}

/** 按 UTF-8 字节截断，不切出半个字。返回 { text, cut }。 */
function capBytes(s, max) {
  const str = String(s);
  if (Buffer.byteLength(str) <= max) return { text: str, cut: false };
  const room = Math.max(0, max - 3);   // 留给「…」（3 字节）
  let t = Buffer.from(str).subarray(0, room).toString('utf8');
  // subarray 可能把最后一个多字节字切成半个 ⇒ toString 出一个 U+FFFD，去掉它
  t = t.replace(/\uFFFD+$/, '');
  return { text: `${t}…`, cut: true };
}

/**
 * tool_input ⇒ 一行字符串（≤ INPUT_MAX 字节）。
 * ★ 先把每个字符串字段各截到 FIELD_MAX，再整体截：Write 的 `content`、Edit 的 `old_string` 动辄几十 KB，
 *   直接整体截 1 KB 的话，排在它后面的字段全被挤掉。`command` 例外（Bash 的副作用全在它里面），只受整体上限。
 */
function summarize(toolInput) {
  if (toolInput === undefined || toolInput === null) return { text: '', cut: false };
  if (typeof toolInput !== 'object') return capBytes(String(toolInput), INPUT_MAX);
  let cut = false;
  const o = {};
  for (const [k, v] of Object.entries(toolInput)) {
    if (typeof v === 'string') {
      const c = capBytes(v, k === 'command' ? INPUT_MAX : FIELD_MAX);
      cut = cut || c.cut;
      o[k] = c.text;
    } else o[k] = v;
  }
  let json;
  try { json = JSON.stringify(o); } catch (_) { json = String(toolInput); }
  const c = capBytes(json, INPUT_MAX);
  return { text: c.text, cut: cut || c.cut };
}

const str = (v, max = 200) => (typeof v === 'string' ? capBytes(v, max).text : null);

/**
 * 把一行压到 LINE_MAX 以内。input_summary 截到 1 KB 之后，JSON 转义还可能把它放大（控制字符 \u0001 一个变六个）
 * ⇒ 最后再量一次，超了就把 input_summary 对半砍，直到放得下。
 */
function fitLine(obj) {
  let line = `${JSON.stringify(obj)}\n`;
  let o = obj;
  while (Buffer.byteLength(line) > LINE_MAX && o.input_summary) {
    const half = Math.floor(Buffer.byteLength(o.input_summary) / 2);
    o = { ...o, input_summary: half > 3 ? capBytes(o.input_summary, half).text : '', truncated: true };
    line = `${JSON.stringify(o)}\n`;
  }
  return line;
}

/** stdin ⇒ 要追加的那一行对象。session 事件不在这里（它不进 jsonl）。 */
function lineFor(event, input, now = Date.now()) {
  const base = {
    tool_use_id: str(input.tool_use_id),     // 实测有；万一哪个版本没了 ⇒ null，读的一侧当「配不上对」，不编键
    tool_name: str(input.tool_name),
  };
  const at = new Date(now).toISOString();
  if (event === 'intent') {
    const s = summarize(input.tool_input);
    return { phase: 'intent', ...base, input_summary: s.text, ...(s.cut ? { truncated: true } : {}), session_id: str(input.session_id), at };
  }
  const ok = event === 'outcome';
  return { phase: 'outcome', ...base, ok, ...(!ok && input.is_interrupt === true ? { interrupted: true } : {}), session_id: str(input.session_id), at };
}

/** 超过 ROTATE_BYTES ⇒ 改名成 `.1`（覆盖旧的 `.1`）。两个 hook 同时撞上 ⇒ 后一个改名的可能丢掉一份 —— 日志本来就是 fail-open 的。 */
function rotateIfBig(file) {
  let size;
  try { size = fs.statSync(file).size; } catch (_) { return; }
  if (size > ROTATE_BYTES) {
    try { fs.renameSync(file, `${file}.1`); } catch (_) { /* 另一个 hook 刚改过名 */ }
  }
}

/**
 * hook 的全部逻辑。**会抛**（写失败、名字不合格）—— 吞掉是 hook 那一层的事（它要保证退出码 0、stdout 空）。
 * @param {'intent'|'outcome'|'failure'|'session'} event
 */
function record(event, input, { name, dir = journalDir(), now = Date.now() } = {}) {
  if (!EVENTS.includes(event)) throw new Error(`不认识的 --event ${JSON.stringify(event)}`);
  if (!validName(name)) throw new Error(`--name 不合格：${JSON.stringify(name)}`);
  if (!input || typeof input !== 'object') throw new Error('stdin 不是 JSON 对象');
  fs.mkdirSync(dir, { recursive: true });
  if (event === 'session') return writeSession(name, input, { dir, now });
  const file = journalFile(name, dir);
  rotateIfBig(file);
  fs.appendFileSync(file, fitLine(lineFor(event, input, now)));
  return file;
}

/** SessionStart ⇒ `<name>.session`（整份覆盖，先写临时文件再改名：`--resume` 读到的永远是一份完整的）。 */
function writeSession(name, input, { dir = journalDir(), now = Date.now() } = {}) {
  const file = sessionFile(name, dir);
  const rec = {
    session_id: str(input.session_id),
    cwd: str(input.cwd, 4096),
    source: str(input.source),
    at: new Date(now).toISOString(),
  };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

// ═══ S2：重投时的恢复提示 ═══════════════════════════════════════════════

/** 每个列表最多列几条。超出的只报数（`shown` / `total`），**不允许一个看起来像「一共就这些」的截断列表**。 */
const LIST_MAX = 10;
/** recovery 里每条的 input_summary 再截到这么多字节（日志里是 1 KB；这里是要进每个 agent 上下文的）。 */
const ITEM_SUMMARY_MAX = 200;
/** 一条消息的 recovery 序列化后的上限（字节）。超了就从最旧的条目开始丢（`shown` 跟着变小，`total` 不变）。 */
const RECOVERY_MAX_BYTES = 6144;

const ADVICE_MAYBE = '可能已生效，重复之前先检查';
const ADVICE_READONLY = '只读，可以重做';
/** 固定说明。**每一份 recovery 都带**（available:false 那份除外 —— 那份说的是「连日志都读不到」）。 */
const NOTE = '日志是 fail-open 的：hook 写失败会静默丢行 ⇒「这里没有」不等于「没做过」。'
  + '「没有 outcome」有两种成因，日志分不出来：执行到一半进程没了（副作用可能已经发生），'
  + '或者根本没执行（被 check_security / 权限拒掉的调用也只留下 intent）。'
  + '时间窗从这条消息第一次入流算起，窗里的调用不一定都属于这条消息。'
  + '重复任何有副作用的动作之前，先去现场核对。';

/** 流条目 id（`1735000000000-0`）⇒ 毫秒时间戳。它 ≤ 首次投递时刻 ⇒ 当时间窗的起点，只会多算、不会漏算。 */
function entryMs(entryId) {
  const m = /^(\d+)-\d+$/.exec(String(entryId || ''));
  return m ? Number(m[1]) : NaN;
}

const unavailable = (reason) => ({ available: false, reason });

/** 读 `.1`（轮转出去的那份）＋ 本体。坏行跳过、计数。文件都不在 ⇒ ok:false。 */
function readEntries(name, { dir = journalDir() } = {}) {
  const file = journalFile(name, dir);
  if (!file) return { ok: false, reason: `名字不合格：${JSON.stringify(name)}` };
  const entries = [];
  let unparsable = 0;
  let found = 0;
  for (const f of [`${file}.1`, file]) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); found += 1; } catch (e) {
      if (e.code === 'ENOENT') continue;
      return { ok: false, reason: `读 ${path.basename(f)} 失败：${e.code || e.message}` };
    }
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      try {
        const e = JSON.parse(l);
        if (e && typeof e === 'object' && (e.phase === 'intent' || e.phase === 'outcome')) entries.push(e);
        else unparsable += 1;
      } catch (_) { unparsable += 1; }
    }
  }
  if (!found) {
    return { ok: false, reason: `没有日志文件 ${path.basename(file)}（hook 可能还没生效：生成的配置要等 agent 重启；或者这个名字从没调用过工具）` };
  }
  return { ok: true, entries, unparsable };
}

/** 「本次 poll 自己」：intent 已落、outcome 要等这个进程退出才会有 ⇒ 不排除的话，每份 recovery 都会把它列成「可能已生效」。 */
const isPollerCall = (e) => e.tool_name === 'Bash' && typeof e.input_summary === 'string' && e.input_summary.includes('bin/next.js');

const item = (e, extra) => ({
  tool_name: e.tool_name,
  input_summary: capBytes(e.input_summary || '', ITEM_SUMMARY_MAX).text,
  at: e.at,
  ...extra,
});
const listOf = (arr, limit) => {
  const items = arr.slice(-limit);   // 最近的 limit 条（离崩溃最近的那几条最要紧），按时间先后
  return { shown: items.length, total: arr.length, items };
};

/**
 * 一条重投消息的 recovery。**永远返回一个对象**：读不到 ⇒ `{ available: false, reason }`，不省略 ——
 * 沉默的缺席会被读成「没事」。
 */
function buildRecovery({ name, entryId, now = Date.now(), dir = journalDir(), limit = LIST_MAX, maxBytes = RECOVERY_MAX_BYTES } = {}) {
  const from = entryMs(entryId);
  if (!Number.isFinite(from)) return unavailable(`流条目 id ${JSON.stringify(entryId)} 里读不出毫秒时间戳，定不了时间窗`);
  const read = readEntries(name, { dir });
  if (!read.ok) return unavailable(read.reason);

  const inWindow = read.entries
    .filter((e) => { const t = Date.parse(e.at); return Number.isFinite(t) && t >= from; })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const outcomes = new Map();
  for (const e of inWindow) if (e.phase === 'outcome' && e.tool_use_id) outcomes.set(e.tool_use_id, e);
  const intents = inWindow.filter((e) => e.phase === 'intent');

  // 没有 outcome 的（含 tool_use_id 缺失、配不上对的）
  let open = intents.filter((e) => !e.tool_use_id || !outcomes.has(e.tool_use_id));
  // 本次 poll 自己：**只排除最后一条**。更早的「没有 outcome 的 poller 调用」是真的观察（那次 poll 中途没了 —— 它可能已经领走了消息）。
  let selfPoll = 0;
  const last = open[open.length - 1];
  if (last && isPollerCall(last)) { open = open.slice(0, -1); selfPoll = 1; }
  const noOutcome = open.map((e) => item(e, { advice: READONLY_TOOLS.has(e.tool_name) ? ADVICE_READONLY : ADVICE_MAYBE }));

  const finished = intents.filter((e) => e.tool_use_id && outcomes.has(e.tool_use_id));
  const effectful = finished.filter((e) => !READONLY_TOOLS.has(e.tool_name));
  // ok:false 的也列：Bash 非零退出不等于什么都没改（脚本可能跑到一半）。
  const completed = effectful.map((e) => item(e, { ok: outcomes.get(e.tool_use_id).ok === true }));

  const rec = {
    available: true,
    note: NOTE,
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    no_outcome: listOf(noOutcome, limit),
    completed_with_side_effects: listOf(completed, limit),
    readonly_completed: finished.length - effectful.length,
    excluded_current_poll: selfPoll,
    unparsable_lines: read.unparsable,
  };
  // 字节上限：从条目多的那个列表里丢最旧的一条，直到放得下。`total` 不动 ⇒ 被丢掉的照样数得出来。
  while (Buffer.byteLength(JSON.stringify(rec)) > maxBytes) {
    const a = rec.no_outcome; const b = rec.completed_with_side_effects;
    const victim = a.items.length >= b.items.length ? a : b;
    if (!victim.items.length) break;
    victim.items.shift();
    victim.shown = victim.items.length;
  }
  return rec;
}

// ═══ S3：`--resume` ═══════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<name>.session` ⇒ { record } 或 { record: null, reason }。 */
function readSession(name, { dir = journalDir() } = {}) {
  const file = sessionFile(name, dir);
  if (!file) return { record: null, reason: `名字不合格：${JSON.stringify(name)}` };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { record: null, reason: e.code === 'ENOENT' ? `没有 ${path.basename(file)}（这个 agent 还没在带 SessionStart hook 的配置下起过）` : `读 ${path.basename(file)} 失败：${e.code || e.message}` };
  }
  try { return { record: JSON.parse(text) }; } catch (_) { return { record: null, reason: `${path.basename(file)} 不是合法 JSON` }; }
}

const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };

/**
 * 能不能 `--resume`。不能 ⇒ `{ resume: false, warn }`，调用方**打警告、起全新会话**（不静默失败、也不拒绝启动）。
 *
 * ★ cwd 不同就不接回。实测（2.1.312，`-p`）：换一个 cwd 去 `--resume` 同一个 id，**照样接得回**
 *   （会话被续写进原 cwd 的 transcript）—— 所以这里拦的不是「会找不到」，而是「找到了也不该接」：
 *   那段上下文里的文件路径、git 状态、跑过的命令全属于另一棵树，接回来的 agent 会对着这棵树按那棵树的记忆干活。
 *   cwd 两边都按 realpath 比（hook 收到的 cwd 是解析过符号链接的，macOS 上 /tmp ⇒ /private/tmp）。
 */
function resumePlan({ record, reason, cwd }) {
  if (!record) return { resume: false, warn: `没有可接回的会话：${reason || '没有记录'} ⇒ 起全新会话` };
  if (typeof record.session_id !== 'string' || !UUID_RE.test(record.session_id)) {
    return { resume: false, warn: `记录里的 session_id ${JSON.stringify(record.session_id)} 不是 UUID ⇒ 起全新会话` };
  }
  if (typeof record.cwd !== 'string' || real(record.cwd) !== real(cwd)) {
    return { resume: false, warn: `记录的会话起在 ${JSON.stringify(record.cwd)}，这次 cwd 是 ${JSON.stringify(cwd)} ⇒ 不接回（那段上下文属于另一棵树），起全新会话` };
  }
  return { resume: true, sessionId: record.session_id, record };
}

module.exports = {
  NAME_RE, INPUT_MAX, FIELD_MAX, LINE_MAX, ROTATE_BYTES, READONLY_TOOLS, EVENTS,
  LIST_MAX, ITEM_SUMMARY_MAX, RECOVERY_MAX_BYTES, ADVICE_MAYBE, ADVICE_READONLY, NOTE,
  journalDir, journalFile, sessionFile, capBytes, summarize, fitLine, lineFor, record, writeSession,
  entryMs, readEntries, buildRecovery, readSession, resumePlan,
};
