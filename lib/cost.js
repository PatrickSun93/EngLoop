'use strict';

/**
 * 成本记账 —— 「谁花的」这一层，只到这一层。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么有这个文件：
 *
 *   多个 CLI 进程失控空转（比如房间广播自激）时，需要能回答「**谁**花的」，
 *   而不是只能 ps 看 CPU 分钟数去猜。
 *
 * ── 边界：只做「谁花的」，不做「哪件事花的」──────────────────────
 *
 * 一个 agent 的一轮里混着多件事，没有可靠归属。
 * **不许为了报表好看去编那一层** —— 编出来的归属比没有归属更坏，
 * 因为人会照着它做决定。
 *
 * ── 不出美元（这不是没做完，是决定）──────────────────────────────
 *
 * jsonl 里根本没有 cost 字段，只有 token。而订阅制下真实约束是
 * session limit（配额和重置时间），不是账单：
 *
 *   > 订阅制下不存在「这些 token 值多少钱」这个量。按单价表算出来的
 *   > 美元既是编造的，又是**无关的**。
 *
 * 所以美元换算不该加。
 *
 * ── 四个 token 字段都要出，不许合成一个数 ────────────────────────
 *
 * cache_read 和 output 可以差三个数量级。
 * **只按 output 排名会得出完全不同的「谁在烧」。**
 * 「简化报表」时不要把它们合成一个数。
 * ══════════════════════════════════════════════════════════════════
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const ENGLOOP_ROOT = path.resolve(__dirname, '..');

// ───────────────────────── 纯函数层 ─────────────────────────

/**
 * 一行 jsonl → 一条计量记录，认不出的返回 null。
 *
 * ★ 只读 `usage` 顶层，**不读 `usage.iterations`**。
 *   iterations 恒为长度 1 且逐字段等于顶层 ——
 *   它是顶层的展开，不是补充。两个都读就是双倍计数。
 *   （将来若真出现 iterations > 1，顶层仍是汇总，这里依然对。）
 */
function parseUsageLine(obj) {
  if (!obj || obj.type !== 'assistant') return null;
  const msg = obj.message;
  const u = msg && msg.usage;
  if (!u) return null;

  // ★ `<synthetic>` 是 Claude Code 自己合成的消息，**根本没发给 API**。
  //   它带一个全零的 usage，于是长得和真实调用一模一样 ——
  //   混进来会让「调用次数」这一列虚高，而那一列正是
  //   用来看「谁在频繁触发」的。token 是 0 不代表可以留着不管：
  //   **错的是计数，不是求和。**
  //
  //   注意跟另一种全零区分开：真实 model 的全零记录，是一次
  //   响应拆多行时某些行没写全 usage，它们跟真实那条共享 requestId，
  //   由 dedupe 的「取最大」兜住 —— 那些是真调用，不能丢。
  if (msg.model === '<synthetic>') return null;

  // requestId 是一次计费 API 调用的身份。缺了退回 message.id ——
  // 同一次响应的多行共享同一个 message.id，去重效果等价。
  const key = obj.requestId || (msg && msg.id);
  if (!key) return null;

  return {
    key,
    sessionId: obj.sessionId || null,
    cwd: obj.cwd || null,
    model: (msg && msg.model) || null,
    ts: obj.timestamp || null,
    isSidechain: !!obj.isSidechain,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0,
  };
}

const totalOf = (e) => e.input + e.output + e.cacheRead + e.cacheCreate;

/**
 * 按 requestId 去重 —— **这个项目里最容易算错一倍的地方**。
 *
 * 一次 API 响应会被拆成多行落盘（thinking 一行、tool_use 一行），
 * **每行都带同一份完整的 usage**。天真求和的结果看起来完全合理，
 * 没有任何东西会提示你它翻倍了（不去重，output 求和会虚高一倍以上）。
 *
 * ★ 保留的是**四项之和最大**的那条，不是第一条。
 *
 *   同一 key 的各行 usage **几乎**总是相同 —— 例外是
 *   全零记录（中断/失败的调用），它跟真实记录共享
 *   同一个 requestId。**全零排在前面时，「保留第一条」会把那次调用
 *   的 output token 整个抹掉。**
 *
 *   取最大值同时满足两件事：全零永远盖不掉真实值；而在 usage 相同的
 *   情况下结果与取任意一条一致，**仍然是确定性的**。
 *
 * @returns {{entries: Array, duplicateRows: number, conflicts: Array}}
 *   conflicts = 同一 key 的多行**非全零** usage 不一致的情况。
 *   这本该是空的 —— 不空说明上面那条前提破了，去重就在丢数据。
 */
function dedupe(entries) {
  const best = new Map();
  const conflicts = [];
  let duplicateRows = 0;

  for (const e of entries) {
    const prev = best.get(e.key);
    if (!prev) { best.set(e.key, e); continue; }
    duplicateRows++;
    const a = totalOf(prev), b = totalOf(e);
    // 全零那条不算冲突 —— 它是已知的、有解释的例外。
    if (a !== b && a !== 0 && b !== 0) {
      conflicts.push({ key: e.key, sessionId: e.sessionId, a: prev, b: e });
    }
    if (b > a) best.set(e.key, e);
  }
  return { entries: [...best.values()], duplicateRows, conflicts };
}

/**
 * cwd → agent 名。这是「谁花的」的归属依据。
 *
 * 能这么切是因为**每个 agent 的工作目录本来就不同** ——
 * 不是额外埋的标记，是既有事实。埋标记会漏，事实不会。
 *
 *   <root>                → JARVIS      （编排者）
 *   <root>/agents/dev2      → dev2        （常驻 agent）
 *   <root>/workers/eval   → worker:eval （claude -p 起的一次性 worker）
 *   <root>/其它子目录      → path:<相对路径>
 *   root 之外              → null        ← 别的项目，**不是 EngLoop 的开销**
 *
 * ★ 返回 null 而不是「未知」：调用方据此把它排除掉。
 *   同一台机器上别的项目可能花得比 EngLoop 还多，
 *   **混进来会成倍虚高，而那个数看着完全合理。**
 */
function agentOf(cwd, root = ENGLOOP_ROOT) {
  if (!cwd) return null;
  const rel = path.relative(root, cwd);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel === '') return 'JARVIS';

  const parts = rel.split(path.sep);
  if (parts[0] === 'agents' && parts[1]) return parts[1];
  if (parts[0] === 'workers' && parts[1]) return `worker:${parts[1]}`;
  return `path:${rel}`;
}

const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0 });

function addInto(acc, e) {
  acc.input += e.input;
  acc.output += e.output;
  acc.cacheRead += e.cacheRead;
  acc.cacheCreate += e.cacheCreate;
  acc.calls += 1;
  return acc;
}

/**
 * 按维度聚合。`by` 取 agent | session | day | model。
 *
 * 四个 token 字段分开累加，**不合成总量**。见文件头那条：
 * 合成一个数就丢掉了「谁在烧」的答案。
 */
function aggregate(entries, { by = 'agent', root = ENGLOOP_ROOT } = {}) {
  const keyOf = {
    agent: (e) => agentOf(e.cwd, root) || '(外部项目)',
    session: (e) => e.sessionId || '(无 session)',
    day: (e) => (e.ts ? String(e.ts).slice(0, 10) : '(无时间)'),
    model: (e) => e.model || '(无 model)',
  }[by];
  if (!keyOf) throw new Error(`未知聚合维度: ${by}`);

  const acc = new Map();
  for (const e of entries) {
    const k = keyOf(e);
    if (!acc.has(k)) acc.set(k, ZERO());
    addInto(acc.get(k), e);
  }
  return [...acc.entries()]
    .map(([k, v]) => ({ key: k, ...v }))
    .sort((a, b) => b.output - a.output);
}

/**
 * 上下文守恒 —— 探测**重复计数**，不是一个精确不变量。
 *
 * 同一会话内按时间排序，下一轮能读到的缓存至多是上一轮的全部上下文：
 *
 *     next.cacheRead ≲ prev.(cacheRead + cacheCreate + input + output)
 *
 * ── 为什么是 ≲ 而不是 ≤（别改回等号）────────────────────────────
 *
 * 等号形式 `next.cacheRead ≤ prev.cacheRead + prev.cacheCreate` 在大多数
 * 相邻轮上精确成立，而例外有三类：
 *
 *   · 前一条是**全零记录**（中断的调用）→ 它根本不代表上下文状态，
 *     拿它推上限本身就是错的。已在下面跳过。
 *   · 上界要包含 `prev.input + prev.output` —— 上一轮的输出会进入下一轮
 *     的上下文，也可能已被缓存。
 *   · 剩下的小幅超出（相对上下文是千分之几）：那是**本轮的新输入在
 *     发请求时就被写进了缓存、下一轮读回来**。
 *     无法从 usage 推出它的上界，所以这里**没有严格不变量可用**。
 *
 * ★ 于是判据用倍数而不是绝对量：重复计数的失真**至少是 2 倍**，
 *   而正常超出是千分之几。1.5 是这两者之间的分界，不是从数据拟合出来的
 *   容差 —— 它是从「重复计数长什么样」推出来的。
 *
 * 小幅超出如实报告（`minorExcess`），但不判为失败。
 *
 * ── 已知误报：同一 session 里交错着两条上下文链 ──────────────────
 *
 * 形状如下：
 *
 *     t1  cacheRead 616,287        ← 主链
 *     t2  cacheRead  23,679 / create 308,732   ← 另一条独立的链
 *     t3  cacheRead 618,856        ← 回到主链，接的是 t1
 *
 * 一个 sessionId 里可以有多条上下文链，而 `isSidechain` 恒为 false，
 * 分不开它们。要分开得沿 uuid/parentUuid 建树 —— 那要把 user 行也读进来，
 * **为一个自检把读取层翻一倍不值**。
 *
 * 所以这一条**只作参考输出，不决定退出码**。真正把关的是
 * `dedupe` 的 conflicts（去重会不会丢数据）和 test/cost-groundtruth
 * 的双通道对账（落盘的数是不是真的）。
 */
const CONSERVATION_FACTOR = 1.5;

function checkContextConservation(entries) {
  const bySession = new Map();
  for (const e of entries) {
    // 全零 = 中断/失败的调用，不代表任何上下文状态，不能进守恒链。
    if (!e.sessionId || !e.ts || totalOf(e) === 0) continue;
    if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
    bySession.get(e.sessionId).push(e);
  }

  const violations = [];
  let checked = 0, minorExcess = 0, maxMinor = 0;
  for (const [sessionId, list] of bySession) {
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    for (let i = 0; i + 1 < list.length; i++) {
      const prev = list[i], next = list[i + 1];
      const ceiling = prev.cacheRead + prev.cacheCreate + prev.input + prev.output;
      checked++;
      if (next.cacheRead <= ceiling) continue;
      const excess = next.cacheRead - ceiling;
      if (next.cacheRead > ceiling * CONSERVATION_FACTOR) {
        violations.push({ sessionId, at: next.ts, ceiling, actual: next.cacheRead, excess });
      } else {
        minorExcess++;
        maxMinor = Math.max(maxMinor, excess);
      }
    }
  }
  return { checked, violations, minorExcess, maxMinor };
}

// ───────────────────────── 读取层 ─────────────────────────

/**
 * pid ↔ sessionId ↔ cwd ↔ tmux pane ↔ agent 名 的映射。
 *
 * ★ 这个函数导出来不只为记账。watchdog 现在只能靠 tmux **会话名**猜
 *   agent 是谁 —— 这是第一条把**进程**和**名字**硬接起来的路：
 *   `~/.claude/sessions/<pid>.json` 是 Claude Code 自己写的，
 *   不是推断出来的。
 *
 * ⚠️ 两个限制，用之前必须知道：
 *   1. **只覆盖当前进程**。进程死了这里就没有它 ——
 *      历史归属只能靠 jsonl 里的 cwd 字段，不能靠这个。
 *   2. 文件可能是**陈旧**的（进程没了文件还在）。所以带一个 `alive`
 *      字段如实报告，但**不替调用方过滤** —— 「文件在而进程没了」
 *      本身就是 watchdog 想知道的信号。
 */
function liveSessions({ dir = SESSIONS_DIR, root = ENGLOOP_ROOT } = {}) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return [];
  }

  const out = [];
  for (const f of files) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (_) {
      continue; // 半写入的文件，跳过而不是崩 —— 这个目录是别人在写的
    }
    if (!d || !d.pid) continue;

    let alive = false;
    try {
      process.kill(d.pid, 0);
      alive = true;
    } catch (e) {
      alive = e.code === 'EPERM'; // 存在但无权发信号（别的用户的进程），也算活着
    }

    out.push({
      pid: d.pid,
      sessionId: d.sessionId || null,
      cwd: d.cwd || null,
      tmux: d.tmux || null,       // 形如 agent_dev3:@3.%3，可直接 send-keys
      name: d.name || null,       // Claude Code 自己起的名，如 dev2-98
      agent: agentOf(d.cwd, root), // EngLoop 内的归属，null = 不是 EngLoop 的
      kind: d.kind || null,
      status: d.status || null,
      startedAt: d.startedAt || null,
      alive,
    });
  }
  return out.sort((a, b) => (a.agent || '~').localeCompare(b.agent || '~'));
}

/**
 * 读一个 jsonl 会话文件 → 计量记录数组。
 *
 * 单行解析失败就跳过那一行：这些文件是 Claude Code **正在写**的，
 * 尾部半行是常态，不是损坏。为一行半截 JSON 让整份统计崩掉是错的。
 */
function readSessionFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const e = parseUsageLine(obj);
    if (e) out.push(e);
  }
  return out;
}

/**
 * 扫 ~/.claude/projects 收集全部计量记录。
 *
 * ★ 归属**只认每行里的 `cwd` 字段，不认目录名**。
 *   目录名是 cwd 的某种编码（`/` → `-`），而那个编码规则的全部转义情况
 *   没有验证过 —— 拿没验证过的规则反推路径，就是「从文本推断状态」。
 *   cwd 字段是数据里的事实，直接用。
 *
 * @param {object}  o
 * @param {boolean} o.all    true = 连别的项目一起统计（默认只统计 EngLoop）
 * @param {string}  o.since  ISO 前缀，如 'YYYY-MM-DD'，按 timestamp 过滤
 */
function collect({ dir = PROJECTS_DIR, root = ENGLOOP_ROOT, all = false, since = null } = {}) {
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch (_) {
    return { entries: [], scannedFiles: 0, rawRows: 0 };
  }

  let rawRows = 0, scannedFiles = 0;
  const all_entries = [];
  for (const pd of projectDirs) {
    let files;
    try {
      files = fs.readdirSync(pd).filter((f) => f.endsWith('.jsonl'));
    } catch (_) {
      continue;
    }
    for (const f of files) {
      scannedFiles++;
      for (const e of readSessionFile(path.join(pd, f))) {
        rawRows++;
        if (since && (!e.ts || String(e.ts) < since)) continue;
        if (!all && agentOf(e.cwd, root) === null) continue;
        all_entries.push(e);
      }
    }
  }

  // 去重放在过滤之后：过滤只看每条自己的字段，不受同伴影响，
  // 两个顺序结果一样，但这样去重的集合更小。
  const { entries, duplicateRows, conflicts } = dedupe(all_entries);
  return { entries, scannedFiles, rawRows, keptRows: all_entries.length, duplicateRows, conflicts };
}

module.exports = {
  parseUsageLine,
  dedupe,
  agentOf,
  aggregate,
  checkContextConservation,
  liveSessions,
  readSessionFile,
  collect,
  PROJECTS_DIR,
  SESSIONS_DIR,
  ENGLOOP_ROOT,
};
