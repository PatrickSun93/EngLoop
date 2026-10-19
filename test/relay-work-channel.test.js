'use strict';

// ── 临时目录回收 —— 不回收的话，每跑一遍全量这两个文件一共漏 9 个 ──────────
//
//   九个前缀（`workbox/workdl/workbox2/workdl2/crewbox/crewbox2/dl/dl2/dl3`）
//   都在 `$TMPDIR` 下建 `engloop-*` 目录，跑一遍留一份。
//
//   🔴 **只在退出码 0 时删** —— 异常退出要**留现场**（去掉 `code === 0` 那个判断，
//     异常时现场也会被删掉）。
//   ⚠️ 而 `SIGKILL` 时这个回调根本不跑 ⇒ 目录留着 —— 那个方向是对的，不修。
//   ⚠️ 这个文件的 `fs` / `os` / `path` 是**在函数里** require 的（`buildMutant`、`authorNotified` 里）——
//     所以这里不能用模块级的那几个名字（`node --check` 会过，
//     而跑到用它的那行才 `ReferenceError: fs is not defined`）。⇒ helper 自己 require。
const TMPDIRS = [];
const mkTmp = (p) => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); TMPDIRS.push(d); return d;
};
process.on('exit', (code) => {
  if (code !== 0) return;
  const fs = require('node:fs');
  for (const d of TMPDIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清不掉就算了 */ } }
});


/**
 * worker 通路的**路由判定层**（`resolveWork` / `liveWorkConsumer`）。
 *
 * 端到端那半边（真的起 bus、真的投 job、真的看 worker 回话）**不在这里** ——
 * 那要一个活着的 bus 进程，只能手动跑。
 * 这里验的是**判定本身**：喂假 `XINFO` 输出，看它分不分得开。
 *
 * ── 为什么这一层值得单独测 ────────────────────────────────────────────
 *   `bin/serve.sh` 里记的那个坑：
 *   **「job 进 work:review 流没有任何消费者，不报错、不超时、什么都不回，
 *     从外面看跟『worker 正在思考』一模一样。」**
 *   ⇒ 这一层就是为了让那件事**说得出话**。而一个「说得出话」的判定，
 *     最容易的坏法是**永远说同一句话** —— 所以下面每一档都有阴性对照。
 */

const relay = require('../lib/relay');

let pass = 0; let fail = 0;
const ok = (c, l, d = '') => (c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`)));

const PID = 4242;
const TYPE = 'solve';
const LIVE = `${TYPE}-pool-${PID}`;

/** 造一份假的 XINFO CONSUMERS 输出（ioredis 的扁平数组形状）。 */
const consumerRow = (name, idle) => ['name', name, 'pending', '0', 'idle', String(idle)];

/** 假 redis：只实现这一层用得到的 `xinfo`。 */
function fakeRedis(rows) {
  return {
    xinfo: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  };
}

const job = (over = {}) => ({ work: TYPE, job_id: 'job-1', text: 'do it', ...over });

// ═══ ⓪ 正控 ═══════════════════════════════════════════════════════════
async function positiveControls() {
  console.log('━━ ⓪ 正控 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ok(typeof relay.resolveWork === 'function', 'resolveWork 导出了');
  ok(typeof relay.liveWorkConsumer === 'function', 'liveWorkConsumer 导出了');
  // 🔴 上限是 **池的 timeoutMs（600_000）**，不是更宽松的值（如 30 分钟）。
  //   理由是硬的：
  //   job 超时 > 池的 timeoutMs ⇒ 第 (timeoutMs+60s) 分钟 autoclaim 会重投它
  //   ⇒ 同一个 job 并发跑两份（去重键在并发窗口内不拦，见 worker.test.js 的 C10b）。
  //   ⇒ 所以这个数**必须**等于池的 timeoutMs，不能更大。
  ok(relay.WORK_TIMEOUT_MAX_MS === 600_000,
    `超时上限 = **池的 timeoutMs**（600_000，实际 ${relay.WORK_TIMEOUT_MAX_MS}）`
    + ' —— 不能更大：更大的话重投窗口会先到');
  ok(relay.WORK_CONSUMER_MAX_IDLE_MS === 60_000,
    `活 consumer 的 idle 阈值 = 60s（实际 ${relay.WORK_CONSUMER_MAX_IDLE_MS}）`);

  // 🔴 这一条是全文件的地基：**成功那一支真的走得通**。
  //   没有它，下面所有「失败」断言都可能是「这个函数永远失败」。
  const r = await relay.resolveWork(fakeRedis([consumerRow(LIVE, 12)]), job(), { pid: PID });
  ok(r && !r.error && r.stream === `work:${TYPE}`,
    '🔴 正控：池开着 + 消息合法 ⇒ **入队**', JSON.stringify(r));
  ok(r && r.to === `worker:${TYPE}` && r.consumer === LIVE,
    '正控：目标与 consumer 名字都带出来了（报告里要贴这两个数）', JSON.stringify(r));
}

// ═══ ① 不是 work 消息 ⇒ null（原来三支零影响）═══════════════════════
async function notWork() {
  console.log('\n━━ ① 不是 work 消息 ━━━━━━━━━━━━━━━━━━━━━━━━━');
  const red = fakeRedis([consumerRow(LIVE, 1)]);
  for (const [label, entry] of [
    ['私聊', { username: 'Patrick', text: 'hi' }],
    ['房间', { room_hash: 'abc123', text: 'hi' }],
    ['空 work', { work: '', job_id: 'j', text: 'hi' }],
    ['work 是 null', { work: null, job_id: 'j', text: 'hi' }],
    ['没有任何目标', { text: 'hi' }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await relay.resolveWork(red, entry, { pid: PID });
    ok(r === null, `① ${label} → **null** ⇒ 调用方继续走原来那三支`, JSON.stringify(r));
  }
}

// ═══ ② 三者互斥 ═══════════════════════════════════════════════════════
async function mutualExclusion() {
  console.log('\n━━ ② 三者互斥 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const red = fakeRedis([consumerRow(LIVE, 1)]);
  for (const [label, over] of [
    ['work + username', { username: 'Patrick' }],
    ['work + room_hash', { room_hash: 'abc123' }],
    ['三个一起', { username: 'Patrick', room_hash: 'abc123' }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await relay.resolveWork(red, job(over), { pid: PID });
    ok(r && r.error === 'ambiguous_target',
      `🔴 ② ${label} → **当场拒绝**（不猜哪个优先）`, JSON.stringify(r));
    ok(r && /username|room_hash/.test(r.detail || ''),
      `② ${label} 的 detail 说清了**是跟哪个撞的**`, r ? r.detail : '');
  }
}

// ═══ ③ job_id：缺了当场拒绝，**不自动生成** ═══════════════════════════
async function jobId() {
  console.log('\n━━ ③ job_id ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const red = fakeRedis([consumerRow(LIVE, 1)]);
  for (const bad of [undefined, null, '', 0]) {
    const e = job(); delete e.job_id;
    if (bad !== undefined) e.job_id = bad;
    // eslint-disable-next-line no-await-in-loop
    const r = await relay.resolveWork(red, e, { pid: PID });
    ok(r && r.error === 'missing_job_id',
      `🔴 ③ job_id = ${String(bad)} → 拒绝（**不替它生成一个**）`, JSON.stringify(r));
  }
  // ★ 为什么不生成：去重键是 dedupe:worker:<type>:<job_id>。
  //   生成一个新的 = 去重永远不生效，而表现是「跑了两遍，两遍都成功」。
  const good = await relay.resolveWork(red, job({ job_id: 'j-9' }), { pid: PID });
  ok(good && !good.error, '③ 阴性对照：带了 job_id 就过 ⇒ 上面四条不是恒假的');
}

// ═══ ④ 活 consumer 判据（C6 的核心）═══════════════════════════════════
async function liveness() {
  console.log('\n━━ ④ 活 consumer 判据 ━━━━━━━━━━━━━━━━━━━━━━');

  // 空池
  {
    const r = await relay.resolveWork(fakeRedis([]), job(), { pid: PID });
    ok(r && r.error === 'no_live_consumer', '🔴 ④ 一个 consumer 都没有 → no_live_consumer',
      JSON.stringify(r));
    ok(r && /一个 consumer 都没有|没开/.test(r.detail),
      '④ detail 说的是「这个池没开」', r ? r.detail : '');
  }

  // 🔴 死 consumer —— 这一条是判据 C6 的命门
  //   死掉的 consumer 会在 XINFO 列表里留很久（这里用 2.6 天）。
  {
    const rows = [consumerRow(`${TYPE}-pool-75766`, 2.6 * 24 * 3600 * 1000)];
    const r = await relay.resolveWork(fakeRedis(rows), job(), { pid: PID });
    ok(r && r.error === 'no_live_consumer',
      '🔴 ④ **有 consumer 但它是别的进程的（且 idle 2.6 天）→ 仍然拒绝**'
      + ' —— 死掉的 consumer 不会自动从 XINFO 里消失', JSON.stringify(r));
    ok(r && /75766/.test(r.detail),
      '🔴 ④ detail 里**列出了看到的是什么** —— 「一个都没有」和'
      + '「有三个但全是死的」要人做的事完全不同', r ? r.detail : '');
  }

  // 名字对但 idle 超阈值
  {
    const rows = [consumerRow(LIVE, relay.WORK_CONSUMER_MAX_IDLE_MS + 1)];
    const r = await relay.resolveWork(fakeRedis(rows), job(), { pid: PID });
    ok(r && r.error === 'no_live_consumer',
      `🔴 ④ 名字对但 idle = 阈值+1ms → 拒绝`, JSON.stringify(r));
  }
  // ★ 边界正控：阈值−1ms 必须**通过** —— 否则上面那条可能是「永远拒绝」
  {
    const rows = [consumerRow(LIVE, relay.WORK_CONSUMER_MAX_IDLE_MS - 1)];
    const r = await relay.resolveWork(fakeRedis(rows), job(), { pid: PID });
    ok(r && !r.error,
      '🔴 ④ **边界正控**：idle = 阈值−1ms → 通过 ⇒ 上面那条不是恒真的',
      JSON.stringify(r));
  }

  // 混在一起：两个死的 + 一个活的 ⇒ 通过
  {
    const rows = [consumerRow(`${TYPE}-pool-1`, 999_999),
      consumerRow(LIVE, 5),
      consumerRow(`${TYPE}-pool-2`, 888_888)];
    const r = await relay.resolveWork(fakeRedis(rows), job(), { pid: PID });
    ok(r && !r.error && r.consumer === LIVE,
      '④ 死的活的混在一起 ⇒ 挑出活的那个，通过', JSON.stringify(r));
  }

  // XINFO 抛异常 ⇒ 归「没活的」，但 reason 分得开
  {
    const r = await relay.resolveWork(fakeRedis(new Error('NOGROUP no such key')), job(), { pid: PID });
    ok(r && r.error === 'no_group',
      '🔴 ④ XINFO 抛异常 → **no_group**（跟 no_live_consumer 分开）'
      + ' —— 「查不了」不许降级成一个具体答案', JSON.stringify(r));
    ok(r && /NOGROUP/.test(r.detail), '④ detail 带上了 redis 的原话', r ? r.detail : '');
  }
}

// ═══ ⑤ per-job 超时 ═══════════════════════════════════════════════════
async function timeouts() {
  console.log('\n━━ ⑤ per-job 超时 ━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const red = fakeRedis([consumerRow(LIVE, 1)]);

  const none = await relay.resolveWork(red, job(), { pid: PID });
  ok(none && none.timeoutMs === undefined,
    '⑤ 不带 timeout_ms ⇒ 不写这个字段（池用自己的默认值）', JSON.stringify(none));

  // ⚠️ 用 300_000（5 分钟）：一个**合法的调小**，这才是这条判据要验的。
  //   900_000（15 分钟）在上限（600_000）下**该被拒**。
  const okT = await relay.resolveWork(red, job({ timeout_ms: 300_000 }), { pid: PID });
  ok(okT && okT.timeoutMs === 300_000, '⑤ 5 分钟（合法的调小）→ 通过', JSON.stringify(okT));
  // ★ 而 15 分钟**必须被拒** —— 一个比上限大的值留成一条断言
  const tooBig = await relay.resolveWork(red, job({ timeout_ms: 900_000 }), { pid: PID });
  ok(tooBig && tooBig.error === 'timeout_too_large',
    '🔴 ⑤ 15 分钟（> 池的 600s）→ **拒绝**',
    JSON.stringify(tooBig));
  ok(tooBig && /并发跑两份/.test(tooBig.detail || ''),
    '🔴 ⑤ 而拒绝的理由**说得出「为什么」** —— 不是「超了」，是「重投窗口会先到」',
    tooBig ? tooBig.detail : '');

  const max = await relay.resolveWork(red, job({ timeout_ms: relay.WORK_TIMEOUT_MAX_MS }), { pid: PID });
  ok(max && max.timeoutMs === relay.WORK_TIMEOUT_MAX_MS, '⑤ 正好等于上限 → 通过（边界含在内）');

  const over = await relay.resolveWork(red, job({ timeout_ms: relay.WORK_TIMEOUT_MAX_MS + 1 }), { pid: PID });
  ok(over && over.error === 'timeout_too_large',
    '🔴 ⑤ 超上限 1ms → **当场拒绝，不静默夹到上限**'
    + '（夹住的话发起方以为自己拿到了更长的时间）', JSON.stringify(over));

  for (const bad of [0, -1, 'ten', NaN, Infinity]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await relay.resolveWork(red, job({ timeout_ms: bad }), { pid: PID });
    ok(r && r.error === 'bad_timeout', `⑤ timeout_ms = ${String(bad)} → bad_timeout`,
      JSON.stringify(r));
  }
}

// ═══ ⑥ 变异 —— 成对：去功能 + **做过头** ═══════════════════════════════
//
//   ★ **阳性判据怕「功能没做」，阴性判据怕「做过头」，而「去掉功能」那类变异
//     对阴性判据一点鉴别力都没有。** 所以两个方向都要。
//   ⚠️ 变异在**内存里**做（读源码文本 + `new Function`），磁盘一个字节不动 ——
//     改文件跑完再恢复会让 `run-all.js` 的 `worktree_changed_during_run` 翻 true。
/**
 * 找到函数**体**那个左花括号的位置。
 *
 * 🔴 **不能直接 `indexOf('{', start)`** —— 这两个函数的参数里有解构：
 *   `liveWorkConsumer(redis, type, { pid = process.pid, now = Date.now() } = {})`
 *   于是配对会在**参数列表**就闭合，切出 84 字节的碎片，
 *   拼进 `new Function` 得到 `SyntaxError: Unexpected token 'async'`。
 *
 * ★ 而同一个变异器工具在 `watchdog.js` 上是好的 —— 那边的函数参数里没有 `{`。
 *   **一个工具在 A 上验过、搬到 B 上失效，而失效的原因在参数表里。**
 */
function bodyBrace(src, start) {
  let d = 0;
  for (let i = src.indexOf('(', start); i < src.length; i += 1) {
    if (src[i] === '(') d += 1;
    else if (src[i] === ')') { d -= 1; if (d === 0) return src.indexOf('{', i); }
  }
  return src.indexOf('{', start);
}

function buildMutant(fnName, replace) {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay.js'), 'utf8');
  const start = src.indexOf(`async function ${fnName}`);
  if (start < 0) return null;
  let depth = 0; let end = -1;
  for (let i = bodyBrace(src, start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  const body = src.slice(start, end);
  const mutated = replace(body);
  // ★ 「没替换成功」必须**说出来**，不能静默返回原件 ——
  //   否则一个失效的变异跟「判据本来就通过」长得一模一样。
  if (mutated === body) return { unchanged: true };
  const pick = (name) => {
    const s = src.indexOf(`const ${name} =`);
    if (s < 0) return '';
    let d = 0;
    for (let i = s; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '[' || ch === '{' || ch === '(') d += 1;
      else if (ch === ']' || ch === '}' || ch === ')') d -= 1;
      else if (ch === ';' && d === 0) return src.slice(s, i + 1);
    }
    return '';
  };
  const deps = ['WORK_TIMEOUT_DEFAULT_MS', 'WORK_TIMEOUT_MAX_MS', 'WORK_CONSUMER_MAX_IDLE_MS']
    .map(pick).join('\n');
  // ⚠️ helper 用**括号配对**切，不切到「下一个函数的名字」——
  //   `indexOf('async function resolveWork')` 会命中**注释里**提到的那个名字，
  //   于是切出来的片段在函数体中间断开 ⇒ `SyntaxError: Unexpected token 'return'`。
  //   ★ 而它响亮地炸了，所以不危险；危险的是**静默切错**那种。
  const sliceFn = (name) => {
    const a = src.indexOf(`async function ${name}`);
    if (a < 0) return '';
    let d = 0;
    for (let i = bodyBrace(src, a); i < src.length; i += 1) {
      if (src[i] === '{') d += 1;
      else if (src[i] === '}') { d -= 1; if (d === 0) return src.slice(a, i + 1); }
    }
    return '';
  };
  const helper = fnName === 'resolveWork' ? sliceFn('liveWorkConsumer') : '';
  // eslint-disable-next-line no-new-func
  return { fn: new Function(`${deps}\n${helper}\n${mutated}\nreturn ${fnName};`)() };
}

async function mutation() {
  console.log('\n━━ ⑥ 变异（成对）━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ⓪ 变异器自身的正控
  const nop = buildMutant('resolveWork', (b) => b.replace('__nothing_here__', 'x'));
  ok(nop && nop.unchanged,
    '⓪ 变异器正控：没有可替换处时**如实报 unchanged**（不静默产出原件）');
  const ident = buildMutant('resolveWork', (b) => `${b}\n/* touched */`);
  ok(ident && typeof ident.fn === 'function',
    '⓪ 变异器正控：只加一行注释时重建得出函数');
  if (ident && ident.fn) {
    const r = await ident.fn(fakeRedis([consumerRow(LIVE, 3)]), job(), { pid: PID });
    ok(r && !r.error && r.stream === `work:${TYPE}`,
      '⓪ 变异器正控：重建出的函数与原件**行为一致** ⇒ 下面变红是因为变异，'
      + '不是因为重建机制本身坏了', JSON.stringify(r));
  }

  // 🔴 做过头方向：「池没开也放行」
  const over = buildMutant('resolveWork', (b) => b.replace(
    'if (!live.live) return { error: live.reason, work, detail: live.detail };',
    '/* mutant: 池没开也放行 */',
  ));
  ok(over && typeof over.fn === 'function', '⑥ 做过头变异体构造成功');
  if (over && over.fn) {
    const empty = await over.fn(fakeRedis([]), job(), { pid: PID });
    const dead = await over.fn(fakeRedis([consumerRow(`${TYPE}-pool-75766`, 9e8)]), job(), { pid: PID });
    ok(empty && !empty.error,
      '🔴 ⑥ 变异后：空池也返回入队 ⇒ **④「空池拒绝」那条会红**', JSON.stringify(empty));
    ok(dead && !dead.error,
      '🔴 ⑥ 变异后：只有死 consumer 也返回入队 ⇒ **④「死 consumer 拒绝」那条会红**',
      JSON.stringify(dead));
    const live = await over.fn(fakeRedis([consumerRow(LIVE, 3)]), job(), { pid: PID });
    ok(live && !live.error,
      '★ ⑥ 而变异体在**池开着**时行为不变 ⇒ **正控（池开着 ⇒ 入队）对它是瞎的**'
      + ' —— 这正是那两条阴性判据必须存在的理由', JSON.stringify(live));
  }

  // 去功能方向：把「三者互斥」拿掉
  const gone = buildMutant('resolveWork', (b) => b.replace(
    /if \(also\.length\) \{[\s\S]*?\n  \}/,
    '/* mutant: 互斥检查没了 */',
  ));
  ok(gone && typeof gone.fn === 'function', '⑥ 去功能变异体构造成功');
  if (gone && gone.fn) {
    const r = await gone.fn(fakeRedis([consumerRow(LIVE, 3)]),
      job({ username: 'Patrick' }), { pid: PID });
    ok(r && !r.error,
      '🔴 ⑥ 变异后：work + username 同时出现也放行 ⇒ **②那三条会红**',
      JSON.stringify(r));
  }
}

// ═══ ⑦ C6b · 失败回报**投到发起方自己的收件流**（集成，连测试库）═══════
//
//   🔴 要防的漏：
//     C6 的判据是「必须收到明确失败回报」。回报发出去了、deadletter 写了、
//     编排者也看见了 —— **而发起方没收到**，因为它读的是 `agent:<name>:in`，
//     不是 `orch:in:agent`。`to: from` 只是消息体里的一个字段，**它不决定投进哪条流**。
//
//   ★ 同样的处理在 relay 里已经有一份（`parse_error` 的 `notifyAuthor`）——
//     复用那个形状时很容易漏掉它的补丁：
//     补丁长得像「额外的代码」，不像「形状的一部分」。
async function authorNotified() {
  console.log('\n━━ ⑦ C6b · 失败回报投给发起方 ━━━━━━━━━━━━━━━');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const q = require('../lib/queue');
  const roster = require('../lib/roster');

  const redis = q.createClient();
  // ⛔ 这一节会 del 流、写花名册。**只能在测试库上跑。**
  if (!q.isTestProcess() || redis.options.db === 0) {
    console.error('🔴 拒绝运行：这一节会写 redis，只能在测试库上跑。');
    process.exit(1);
  }

  const CREW = 'workprobe';
  const CREW_IN = `agent:${CREW}:in`;
  const ORCH_IN = 'orch:in:agent';
  const mkdir = mkTmp;   // ← 回收见文件头那段
  const wait = (ms) => new Promise((s) => { setTimeout(s, ms); });
  const drain = async (stream) => {
    const rows = await redis.xrange(stream, '-', '+');
    return rows.map(([, f]) => {
      const o = {};
      for (let i = 0; i < f.length; i += 1) o[f[i]] = f[i + 1];
      const oo = {};
      for (let i = 0; i < f.length; i += 2) oo[f[i]] = f[i + 1];
      return oo;
    });
  };

  await redis.del(CREW_IN, ORCH_IN);
  await roster.register(redis, CREW, { type: 'dev', stream: CREW_IN });

  // ★ 正控：先证明这个查询看得见 agent 流上的消息（否则下面「收到了」可能是假的）
  await q.send(redis, CREW_IN, { from: 'test', to: CREW, text: 'CONTROL-PROBE' });
  const probe = await drain(CREW_IN);
  ok(probe.some((m) => m.text === 'CONTROL-PROBE'),
    '⑦ 正控：这个查询确实看得见 agent:workprobe:in 上的消息');
  await redis.del(CREW_IN, ORCH_IN);

  const dir = mkdir('engloop-workbox-');
  const events = [];
  const rl = relay.startRelay({
    outboxDir: dir,
    from: CREW,
    redis,
    onEvent: (e) => events.push(e),
    deadletterRoot: mkdir('engloop-workdl-'),
  });
  // 投给一个**肯定没开**的池
  fs.writeFileSync(path.join(dir, `${Date.now()}.json`), JSON.stringify({
    work: 'nosuchpool', job_id: 'c6b-probe', text: '这条不该入队',
  }));
  await wait(600);

  const toCrew = await drain(CREW_IN);
  const toOrch = await drain(ORCH_IN);
  ok(toCrew.some((m) => /job 没有入队/.test(String(m.text))),
    '🔴 ⑦ **发起方自己的收件流收到了失败回报** —— 这就是补上的那个漏',
    JSON.stringify(toCrew.map((m) => String(m.text).slice(0, 30))));
  ok(toOrch.some((m) => /job 没有入队/.test(String(m.text))),
    '⑦ 编排者那条**照旧还在** —— 这是「多一个目标」，不是「改目标」');

  const ev = events.filter((e) => e.type === 'work_rejected').pop();
  ok(ev && Array.isArray(ev.delivered_to)
     && ev.delivered_to.includes(ORCH_IN) && ev.delivered_to.includes(CREW_IN),
  '🔴 ⑦ 事件里带了**投递目标，两个都在** —— 旧事件只有 file/saved，'
  + '而那两个字段投对投错完全一样', JSON.stringify(ev && ev.delivered_to));
  ok(ev && ev.author_notified === true, '⑦ author_notified 为真');
  rl.stop();

  // ★★ 阴性对照：**不在册**的发起方通知不到，而那必须说得出来。
  //   「没通知到」和「通知到了」不能长一样 —— 否则又是一次
  //   「查不了」被读成「没事」。
  await roster.unregister(redis, CREW);
  await redis.del(CREW_IN, ORCH_IN);
  const dir2 = mkdir('engloop-workbox2-');
  const ev2 = [];
  const rl2 = relay.startRelay({
    outboxDir: dir2, from: CREW, redis,
    onEvent: (e) => ev2.push(e),
    deadletterRoot: mkdir('engloop-workdl2-'),
  });
  fs.writeFileSync(path.join(dir2, `${Date.now()}.json`), JSON.stringify({
    work: 'nosuchpool', job_id: 'c6b-probe-2', text: '这条也不该入队',
  }));
  await wait(600);
  const off = ev2.filter((e) => e.type === 'work_rejected').pop();
  ok(off && off.author_notified === false,
    '🔴 ⑦ 阴性对照：发起方**不在册** ⇒ author_notified = **false**（说得出「没通知到」）',
    JSON.stringify(off && { d: off.delivered_to, a: off.author_notified }));
  ok(off && off.delivered_to.length === 1,
    '⑦ 阴性对照：只投了编排者那一条', JSON.stringify(off && off.delivered_to));
  rl2.stop();

  await redis.del(CREW_IN, ORCH_IN);
  await roster.unregister(redis, CREW).catch(() => {});
  await redis.quit();
}

async function main() {
  console.log('\n══ worker 通路 · 路由判定（任务 C）══════════════════\n');
  await positiveControls();
  await notWork();
  await mutualExclusion();
  await jobId();
  await liveness();
  await timeouts();
  await mutation();
  await authorNotified();
  console.log(`\n${'─'.repeat(50)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
