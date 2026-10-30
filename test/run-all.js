'use strict';

/**
 * 跑全部测试。
 *
 * 没有它的话，`npm test` 只跑一个文件，其余文件靠人记得
 * 手写 for 循环去跑。于是「加一条自动检查」这件事有个隐含的漏洞：
 * 检查加了，但没人跑它，等于没加。isolation.test.js 尤其如此，
 * 它守的是「测试不许碰生产数据」，而它自己不被默认跑到的话就是摆设。
 *
 * 每个测试跑在**独立子进程**里：它们各自 process.exit，共享进程会互相打断；
 * 而且 lib/queue.js 的测试库判定看的是 require.main，子进程才判得准。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const status = require('../lib/status');

const DIR = __dirname;
const ALL_FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.test.js')).sort();

// ── 机器可读结果 ＋ 只跑一部分 ──────────────────────────────────────────
//
//   `bin/verify-complete.js` 要拿**逐条失败**（文件 ＋ 用例标题）去跟基线比 ——
//   「数目相等而换了一条」也要判 fail，只比合计数做不到。
//   ⇒ 它**不去 grep 这个文件的人类输出**（人类输出的格式会被下一次美化改掉，而那不会报错），
//     而是读这里写的 JSON。路径两种给法，同一件事：
//       `--json <文件>`                 人手工跑
//       `ENGLOOP_TEST_RESULTS=<文件>`   verify-complete 用 —— 它拿到的 tests 是一条**不透明**的命令，
//                                        不该去改写它的参数
//   `--only a.test.js,b.test.js`：只跑这几个（agent 报 evidence 时可以给一个范围更小的命令）。
//   ⚠️ 名字对不上**直接退出**，不是「什么都没跑、合计 0 · 0」—— 那正是下面「没跑的被算成跑过」那一类。
// ★ 被 require（而不是被 `node` 直接跑）时：只交出判据函数、不开跑整套测试。
//   `failureTitles` 是 verify-complete 判「失败集合」的地基，它要测得到；而这个文件一被 require
//   就开跑全量 ⇒ 写在里面的函数原本测不到（`lib/tree-fingerprint.js` 头注同一个理由）。
//   ⚠️ 不搬进 lib/：verify-complete 的基线在老 commit 上跑时会**借这个文件的新版本**去量老代码，
//     新版本要是 require 了一个老 commit 里没有的 lib 文件，就借不成了 —— 所以它必须自给自足。
//   （函数声明会提升，所以这里拿得到下面才定义的 failureTitles。CommonJS 允许顶层 return。）
if (require.main !== module) {
  module.exports = { failureTitles };
  return;
}

const ARGV = process.argv.slice(2);
function argValue(flag) {
  const i = ARGV.indexOf(flag);
  if (i === -1) return null;
  const v = ARGV[i + 1];
  if (!v || v.startsWith('--')) {
    console.error(`run-all: ${flag} 后面要跟一个值`);
    process.exit(2);
  }
  return v;
}
const JSON_OUT = argValue('--json') || process.env.ENGLOOP_TEST_RESULTS || null;
const ONLY = argValue('--only');
let files = ALL_FILES;
if (ONLY) {
  const want = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = want.filter((f) => !ALL_FILES.includes(f));
  if (!want.length || unknown.length) {
    console.error(`run-all: --only 里有不存在的测试文件：${unknown.join(', ') || '(空)'}`
      + ' —— 写 test/ 下的文件名（如 graph.test.js），逗号分隔');
    process.exit(2);
  }
  files = ALL_FILES.filter((f) => want.includes(f));
}

// ── `--skip a.test.js,b.test.js`：这几个不跑（CI 用：依赖本机 tmux 会话 / 真 bus / sandbox-exec 的那些）──
//
//   跟 `--only` 对称：名字对不上**直接退出** —— 一个拼错的名字会让那个文件照跑、照红，
//   而更坏的方向是文件改了名、跳过表还写着旧名：旧名对不上 ⇒ 它在这里炸，而不是悄悄失效。
//   ★ 被跳过的**照样进结果**（`skipped: true`、`skip_reason: 'cli'`），汇总里跟 ⏭ 那些一起列出来 ——
//     不跑而不列，合计数看起来就覆盖了它们（下面「⚠ N 个文件跳过」那段同一个理由）。
//   ⚠️ 为什么不在测试文件里各自判「我在 CI 里吗」然后 ⏭：那是改测试逻辑；而「在哪儿不跑」是跑法，
//     该集中写在跑的人那里（`.github/workflows/ci.yml` → `scripts/ci-test.sh`，每个文件一行原因）。
const SKIP = argValue('--skip');
let skipList = [];
if (SKIP) {
  skipList = SKIP.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = skipList.filter((f) => !ALL_FILES.includes(f));
  if (!skipList.length || unknown.length) {
    console.error(`run-all: --skip 里有不存在的测试文件：${unknown.join(', ') || '(空)'}`
      + ' —— 写 test/ 下的文件名（如 graph.test.js），逗号分隔');
    process.exit(2);
  }
}
const cliSkipped = files.filter((f) => skipList.includes(f));
files = files.filter((f) => !skipList.includes(f));

// ── 申报「我在跑一个长任务」，免得 watchdog 把跑测试的 agent 判成失聪 ──
//
// ★ watchdog 看 outbox 的判据**对这一类无解**：agent 在这次 Bash 调用期间
//   **没有执行权，写不了任何东西**。而这个进程有 —— 所以由它来报。
//
// ★ 不在 agent 的 tmux 会话里跑时**什么都不写**（人在自己终端跑、CI 跑）——
//   那时候本来就不该有谁免疫 watchdog。`declare()` 会打一行说明。
const busy = require('../lib/busy');
const claim = busy.declare(`test/run-all.js（${files.length} 个文件）`,
  { onLog: (m) => console.log(m) });

// ── ★★ 工作区快照：**这次运行期间，被测的代码变过吗** ────────────────
//
//   多 agent 并行时，全量跑到一半有别人在改文件 ⇒ 拿到「失败 2」，一分钟后重跑「0 失败」，
//   而那 2 条是什么再也查不出来。
//
//   「跑测试前先等工作区稳定」这条规矩写在文档里是不够的 —— 它要有触发点，
//   所以放在这里。
//
//   > **一条写下来但没有触发点的规矩，跟没写是一样的。**
//
// ★ 这里做的是**事后比对**，不是事前等待，两个理由：
//   ① 事前等待挡不住「跑到一半才开始改」——而多 agent 并行时那才是常态
//   ② **「这次跑期间变过」是一个可以事后判定的事实**，比「跑之前看起来稳」强：
//      后者只能预测，前者能解释你手上这份结果为什么不可复现
//
// ⛔ **只警告，不拒绝执行。** 拒绝会让人在真正需要跑的时候被挡住，
//   然后学会绕过它 —— 一个被绕过的守卫比没有守卫更坏（它还占着「有保护」的名分）。
// 🔴 指纹的实现在 `lib/tree-fingerprint.js` —— 而放在那里的理由**不是整洁**：
//   它在这里**不可测**（这个文件一 `require` 就开跑整套测试，而它也没导出）
//   ⇒ ⇒ 判据只能**复刻**它，而复刻的判据验的是复刻件。
//   ★ 它不能只哈希 `git status --porcelain`：那一行里**没有内容字段**
//     ⇒ 一个已经是 `M` 的文件再改一次，它看不见。
//   判据在 `test/worktree-hash.test.js`；它**仍然**看不见的那一格写在 `lib/tree-fingerprint.js` 头上。
// ★ 它的旧名字是 `lib/worktree.js`（改名是因为它是指纹，不管 worktree）。
//   而这个文件会被 verify-complete **借去老 commit 的临时树里跑**（见文件头「被 require 时」那段）——
//   老树里只有旧名字 ⇒ 只认新名字的话，借尺子那一步直接 MODULE_NOT_FOUND。⇒ 新名字找不到才退回旧名字。
//   ⚠️ 只退这一档：两个都没有 ⇒ 让它照常抛，不吞。
let fingerprintLib;
try { fingerprintLib = require('../lib/tree-fingerprint'); }
catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes('tree-fingerprint')) throw e;
  fingerprintLib = require('../lib/worktree');
}
const { worktreeHash: hashRepo } = fingerprintLib;
const worktreeHash = () => hashRepo(path.join(DIR, '..'));
const wtBefore = worktreeHash();

// ── ★★★ 生产 temp/ 里的 agent 状态文件，跑测试期间新增了吗 ──────────
//
//   例：`lib/thread-alert.js` 的状态文件默认落在
//   `temp/thread-alert-<name>.json`，而写它的是 relay（中心进程）。
//   测试要是往**编排者的生产状态文件**里追假记录，编排者下一轮就会真收到
//   一堆假告警 —— 而那个告警的全部资产是可信。
//   **几轮下来它就把自己教成了噪音。**
//
// ★ 硬守卫在 `test/isolation.test.js`【6】（默认值自己认出测试进程，
//   带生产入口的阴性对照）。这里这层是**事后事实判定**，跟下面的工作区
//   快照同一个形状：验的不是「应该不会污染」，是「这一次到底污染没有」。
//
// ⛔ **只警告，不计失败。** 真 agent 此刻也在跑，它真漏填时也会写出同名文件 ——
//   那是这个机制正常工作，不是污染。把它判成红的话，第一次误报就会有人
//   来放宽它，而**一个被放宽的守卫比没有守卫更坏**（它还占着「有保护」的名分）。
//   ⇒ 说出事实 + 说清两种可能，判断留给读的人。
const TEMP_DIR = path.join(DIR, '..', 'temp');
function agentStateSnapshot() {
  try {
    return new Set(fs.readdirSync(TEMP_DIR).filter((f) => /^thread-alert-.*\.json$/.test(f)));
  } catch {
    return null;   // 查不了 ≠ 没有。同工作区快照那条，不许降级成「干净」。
  }
}
const stBefore = agentStateSnapshot();

// ── ★★★ 生产探针状态：这次跑之后，**多出假 pending 了吗** ──────────────────
//
//   测试 spawn `bin/next.js` 时要是没传全隔离变量 ⇒ 子进程的探针写进
//   **生产** `temp/probe-state-*.json`。而那些 pending **永远不会销账**（没有 agent
//   叫那个名字去 poll 它）⇒ 它们能挂上很多天而没人看见 ——
//   只有落在**真 agent 名下**的那一份会响。
//
//   ⚠️ 而它跟上面那个 `agentStateSnapshot` 是**两个不同的口径**，别合并：
//     那个记的是**文件名的集合**（「多出来一个文件了吗」）——
//     而这种污染写进的是**已经存在**的文件（`probe-state-JARVIS.json` 从 0 变 1）
//     ⇒ ⇒ **文件集合一个字没变** ⇒ 那个口径看不见它。
//     ★ 而这跟 `worktreeHash` 早先那个盲区逐字同构：**只比状态，不比内容**。
//
//   ⛔ 只警告，不计失败 —— 理由同上面两处：一个被放宽的守卫比没有守卫更坏。
const PROBE_STATE_RE = /^probe-state-(.+)\.json$/;
function probeStateSnapshot() {
  try {
    const out = {};
    for (const f of fs.readdirSync(TEMP_DIR)) {
      const m = PROBE_STATE_RE.exec(f);
      if (!m) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(TEMP_DIR, f), 'utf8'));
        out[m[1]] = { pending: Array.isArray(j.pending) ? j.pending : [] };
      } catch {
        out[m[1]] = { pending: [], unreadable: true };   // 读坏了 ≠ 空，标出来
      }
    }
    return out;
  } catch {
    return null;   // 查不了 ≠ 干净。同上面两处。
  }
}
/** 谁在跑 —— **取法别自己写**：照 `lib/busy.js` 里那两步，顺序不能反。 */
function liveAgentNames() {
  try {
    const { sessionToName, isAgentSession } = require('../lib/watchdog');
    const r = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'],
      { encoding: 'utf8', timeout: 10_000 });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      .filter((s) => isAgentSession(s))     // ★ 先判，再转 —— 反了会得到垃圾串
      .map((s) => sessionToName(s));
  } catch {
    return null;
  }
}
const pbBefore = probeStateSnapshot();

const results = [];
for (const f of files) {
  const r = spawnSync('node', [path.join(DIR, f)], {
    cwd: path.join(DIR, '..'), encoding: 'utf8',
  });
  const out = (r.stdout || '') + (r.stderr || '');
  // ── ★★★ 取**最后一个**匹配，不是第一个 ─────────────────────────────
  //
  //   取第一个匹配（`out.match(/…/)`）是错的：**测试的输出里天生就会
  //   包含测试数据**：watchdog-liveness 有一条用例拿「`  ✓ 通过 130 · 失败 0`」
  //   当「普通输出不该被误判成限额提示」的样本，那一行被打印出来，
  //   于是整个文件的成绩会被报成「130 · 0」，真实总结在末尾、永远轮不到。
  //
  //   🔴 少算几条只是它温和的那一面。**最坏的方向是：真有断言失败时，
  //   同一个机制会把「失败 0」也一起伪造出来** —— 一个假的绿色总结，
  //   而这个数字正是用来下判断的东西。
  //
  //   ⚠️ 为什么是 `pop()` 而不是看着更直观的第一个匹配：
  //   **每个测试文件的真实总结永远打印在最后一行**（那是它退出前做的事），
  //   而任何出现在它之前的同形字符串都是**内容**，不是结论。
  //   ⇒ 「最后一个」是这个协议里唯一稳定的位置。
  //
  //   ⚠️ 这不修根因 —— 根因是「拿输出里的一个形状当协议」，而测试输出
  //   本来就可能包含任何形状。真正的修法是让子进程用退出码或专用通道
  //   报数。`pop()` 只是把劫持窗口从「任何位置」缩小到「最后一行」。
  const hits = [...out.matchAll(/通过 (\d+) · 失败 (\d+)/g)];
  const m = hits.length ? hits[hits.length - 1] : null;
  const skipped = /⏭/.test(out);
  results.push({
    file: f,
    pass: m ? Number(m[1]) : 0,
    fail: m ? Number(m[2]) : 0,
    // ★ 「有没有报出总数」跟「总数是几」是两件事，必须分开记 —— 见下。
    reported: m !== null,
    skipped,
    code: r.status,
    out,
  });
}
// `--skip` 的那些也进结果（见上面 `--skip` 那段）：按文件名插回原位，汇总里读起来跟没跳过时同一个顺序
for (const f of cliSkipped) {
  results.push({ file: f, pass: 0, fail: 0, reported: false, skipped: true, skipReason: 'cli', code: null, out: '' });
}
results.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

let totalPass = 0, totalFail = 0, broken = 0;
for (const r of results) {
  totalPass += r.pass;
  totalFail += r.fail;

  // ★ 一个跑完的 .test.js **不可能一条断言都没有**。
  //
  //   没报出「通过 N · 失败 M」，说明它在打印总结之前就没了 ——
  //   静默退出、被信号杀掉、或者某个 Promise 永远不 resolve 导致
  //   event loop 空掉。**这三种都会 exit 0。**
  //
  //   只记 pass=0/fail=0、再看 code===0 的话，
  //   就会打印一个**绿勾** —— 一个一条断言都没执行的文件，
  //   在全量报告里跟一个真的全过的文件长得一模一样。
  //
  //   **没跑的断言被算成跑过了，比一条恒绿的断言更坏**：后者至少执行过。
  //   而「N 通过 0 失败」这个数字是用来下判断的东西。
  const silent = !r.skipped && !r.reported;

  if (r.skipped) {
    console.log(`  ⏭  ${r.file.padEnd(26)} 跳过${r.skipReason === 'cli' ? '（--skip，没跑）' : ''}`);
  } else if (silent) {
    broken++;
    console.log(`  ✗  ${r.file.padEnd(26)} **没报出总数**（exit ${r.code}）`
      + ' —— 它在打印总结前就退出了，上面的数字里不包含它');
  } else if (r.code !== 0 || r.fail > 0) {
    broken++;
    console.log(`  ✗  ${r.file.padEnd(26)} 通过 ${r.pass} · 失败 ${r.fail}${r.code !== 0 ? ` · exit ${r.code}` : ''}`);
  } else {
    console.log(`  ✓  ${r.file.padEnd(26)} 通过 ${r.pass}`);
  }
}

// 失败的把输出全打出来 —— 只报个数字的话，查起来还得再跑一遍
for (const r of results) {
  if (r.code !== 0 || r.fail > 0 || (!r.skipped && !r.reported)) {
    console.log(`\n${'═'.repeat(50)}\n${r.file}\n${'═'.repeat(50)}\n${r.out}`);
  }
}

const silentFiles = results.filter((r) => !r.skipped && !r.reported);
const skippedFiles = results.filter((r) => r.skipped);

console.log(`\n${'─'.repeat(50)}\n  合计 通过 ${totalPass} · 失败 ${totalFail}`
          + `${broken ? ` · ${broken} 个文件未通过` : ''}`);

// ★ 「这个合计覆盖不到什么」必须跟数字**印在一起**。
//   人是照着合计下判断的 —— 警告写在上面某一行等于没写。
if (silentFiles.length) {
  console.log(`  ⚠ 上面这个合计**不完整** —— ${silentFiles.length} 个文件`
    + `（${silentFiles.map((r) => r.file).join(', ')}）没报出总数，`);
  console.log('    它们贡献的断言数未知。**别拿这个数字当「全绿」用。**');
}
if (skippedFiles.length) {
  // ★ 「跳过」和「通过」在汇总里都是非红 —— 那是「没跑的被当成跑过了」
  //   换了个词。而 e2e 是唯一端到端的那个：**它跳过意味着最外层那圈
  //   从来没跑过**，而反复吃亏的正是「单元层全绿、接线层是空的」。
  //
  //   ⚠️ 目标是**让跳过可见**，不是消灭跳过。e2e 的跳过有真实理由
  //   （编排者在跑会抢消息），把它强行打开只会换来一个不稳定的红。
  console.log(`  ⚠ ${skippedFiles.length} 个文件跳过 —— **这个数字不覆盖它们**`
    + `（${skippedFiles.map((r) => r.file).join(', ')}）`);
}

// ── 写 results/last-run.json，供 GET /api/status 读 ─────────────────
//
// ★★ 记的是**跑这一刻**的 commit 和工作区状态，不是读的时候。
//   那两个字段的全部用途就是跟「现在」比对；记成读取时刻的话两者恒等，
//   **过期判定会永远返回「新鲜」** —— 一个恒绿的过期检查比没有更坏。
//
// ★ `skipped` / `silent` 也写进去：上面那两段警告说的「这个合计覆盖不到
//   什么」，顶栏同样需要 —— **警告跟数字分开印，等于没写。**
//
// ⚠️ 写失败不改变退出码：`process.exit` 的判据只看断言结果，
//   一个写不出文件的磁盘不该把一次全绿说成失败。
//   但**不许静默** —— 一个停止更新的 last-run.json 会让顶栏显示一个
//   越来越旧的绿数字，而没有任何东西提示它停在了哪一刻。
// ── ★★★ 工作区在这次运行期间变过吗 ──────────────────────────────
const wtAfter = worktreeHash();
// null = 查不了。**「查不了」不许降级成「没变」** —— 那正是这个仓库
// 反复守的那条规矩，而在这里降级的后果是：一份不可复现的结果被当成可信的。
const wtUnknown = wtBefore === null || wtAfter === null;
const wtChanged = !wtUnknown && wtBefore !== wtAfter;
if (wtChanged) {
  console.log('  🔴 **这次运行期间工作区发生过变化**（跑之前和跑之后的 git status 不同）');
  console.log('     ⇒ 上面的结果**可能不可复现**：某些文件是在跑到一半时被改的。');
  console.log('     ⇒ 有失败的话，先在稳定的工作区重跑一次再下结论。');
} else if (wtUnknown) {
  console.log('  ⚠ 查不出工作区在这次运行期间变没变过（git status 跑不了）——'
            + ' **这不等于「没变过」**');
}

// ── ★★ 生产探针状态：这次跑之后多出假 pending 了吗 ────────────────────
const pbAfter = probeStateSnapshot();
const liveAgents = liveAgentNames();
let probeAdded = null;          // null = 查不了
let probeCheckNote = null;
if (pbBefore === null || pbAfter === null) {
  probeCheckNote = 'snapshot_failed';
  console.log('  ⚠ 查不出生产探针状态变没变 —— **这不等于「没污染」**');
} else if (liveAgents === null) {
  // 🔴 拿不到 agent 名 ⇒ 排除集合为空 ⇒ 每个真 agent 都会被判成污染
  //   ⇒ ⇒ 与其报一堆假红，不如**说出口并放弃这一轮的判定**。
  probeCheckNote = 'no_agent_names';
  console.log('  ⚠ 拿不到「谁在跑」（tmux 查不了）⇒ **这一轮不判探针污染** —— 不是「没污染」');
} else {
  // 只看**这一遍新长出来的** pending：存量不归这条管（存量要单独清）
  const grew = {};
  for (const [name, a] of Object.entries(pbAfter)) {
    const b = pbBefore[name] || { pending: [] };
    if (a.pending.length > b.pending.length) grew[name] = a;
  }
  probeAdded = require('../lib/probe').classifyPollution(grew, liveAgents);
  if (probeAdded.length) {
    console.log(`  🟠 这次跑**新造了假 pending**：${probeAdded.join(', ')}`);
    console.log('     ⇒ 成因多半是某个测试 spawn `bin/next.js` 时没传全隔离变量');
    console.log('       （`ENGLOOP_OUTBOX_ROOT` ＋ `ENGLOOP_PROBE_STATE` 两个都要，'
      + '缺一个就是半隔离 —— 而半隔离比不隔离更坏：探针发得出、回不来）');
    console.log('     ⚠️ 而它**看不见**「掉册但 tmux 还在的真 agent 被污染」那一类'
      + '（已知漏报，见 `lib/probe.js` 的 `classifyPollution`）');
  }
}

// ── ★★ 生产 temp/ 的 agent 状态文件：这次跑之后多出来了吗 ────────────
const stAfter = agentStateSnapshot();
if (stBefore === null || stAfter === null) {
  console.log('  ⚠ 查不出生产 temp/ 下的 agent 状态文件变没变 —— **这不等于「没污染」**');
} else {
  const added = [...stAfter].filter((f) => !stBefore.has(f));
  if (added.length) {
    console.log(`  🟠 生产 \`temp/\` 下新增了 ${added.length} 个 agent 状态文件：`
      + added.join(', '));
    console.log('     两种可能，**别默认是哪一种**：');
    console.log('     ① 真 agent 这段时间确实漏挂了 thread —— 那是机制在正常工作；');
    console.log('     ② 某个测试又在往生产目录写 —— 那是测试污染生产数据');
    console.log('        （硬守卫在 test/isolation.test.js【6】，先看它红没红）。');
    console.log('     分辨法：打开文件看 `to` 字段，测试用的是 *testcrew / er-test 这类假名。');
  }
}

// ── ★★★ 失败的**断言行**落盘，不只是数字 ────────────────────────
//
//   一次「失败 2」可能在一分钟后变成「0 失败」，而
//   `results/last-run.json` 要是**只记数字不记哪条红了** ——
//   那 2 条是什么，就**永远查不出来了**。
//
//   > **一个只记总数的测试记录，在失败不可复现时等于没记。**
//
//   失败输出一直有打到 stdout（上面那段），但 stdout 属于**跑它的那个人的
//   那一次终端**：他 `| tail` 了、或者上下文被压缩了，证据就没了。
//   **落盘的那份才是能被第二个人读到的。**
const failureDetail = results
  .filter((r) => r.code !== 0 || r.fail > 0 || (!r.skipped && !r.reported))
  .map((r) => {
    const lines = (r.out.match(/^.*✗.*$/gm) || [])
      // 第一行是 run-all 自己打的汇总行（`✗  xxx.test.js 通过 N · 失败 M`），
      // 不是断言 —— 滤掉它，留下真正红了的那几条
      .filter((l) => !l.includes('.test.js'))
      .map((l) => l.trim());
    const MAX = 25;
    return {
      file: r.file,
      pass: r.pass,
      fail: r.fail,
      exit: r.code,
      reported: r.reported,
      // ⚠️ 截断要**说出来**：一个安静截断的记录会让人以为「就这几条」
      lines: lines.slice(0, MAX),
      truncated: lines.length > MAX ? lines.length - MAX : 0,
    };
  });

// ── 机器可读结果（见文件头 `JSON_OUT` 那段）──────────────────────────────
//
// ★ 每个**没过**的文件给出逐条失败的**标题**：行首是 `✗` 的那一行，去掉 `  → 细节` 那半。
//   细节里常有耗时、实际值 —— 留着它的话，同一条失败两次跑出来是两个不同的串，
//   「跟基线比」会把一条老失败当成新的。
//   ⚠️ 只认**行首**的 ✗（上面 failureDetail 认的是行中任何位置，那是给人看的，宽一点无妨）：
//     测试会把样本数据打出来，行中间的 ✗ 是内容不是结论 —— 跟总结行取「最后一个匹配」同一个理由。
//   ⚠️ 没过却一条 ✗ 都没有（崩了、没报总数、exit≠0）⇒ 补一条**合成标题**，不能是空数组 ——
//     空数组在集合比较里等于「这个文件没有失败」。
// ★ 过了的文件 `failures` 恒为 []：它输出里的 ✗ 行是内容（比如「这行不该被当成失败」的样本）。
function failureTitles(r) {
  if (r.skipped) return [];
  const bad = r.code !== 0 || r.fail > 0 || !r.reported;
  if (!bad) return [];
  const titles = [];
  for (const m of r.out.matchAll(/^[ \t]*✗[ \t]*(.*)$/gm)) {
    const t = m[1].split('  → ')[0].trim();
    if (t) titles.push(t);
  }
  if (!titles.length) {
    titles.push(!r.reported
      ? `(没报出总数 · exit ${r.code})`
      : `(exit ${r.code} · 失败 ${r.fail}，输出里没有行首 ✗ 的断言行)`);
  }
  return titles;
}
if (JSON_OUT) {
  const doc = {
    schema: 'engloop-test-results/1',
    only: ONLY ? files : null,
    skip: SKIP ? cliSkipped : null,
    files: results.map((r) => ({
      file: r.file, pass: r.pass, fail: r.fail, exit: r.code,
      reported: r.reported, skipped: r.skipped, ...(r.skipReason ? { skip_reason: r.skipReason } : {}),
      failures: failureTitles(r),
    })),
    total: { pass: totalPass, fail: totalFail, broken },
    worktree_changed_during_run: (() => {
      const after = worktreeHash();
      return wtBefore === null || after === null ? null : wtBefore !== after;
    })(),
  };
  try {
    fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    const tmpOut = `${path.resolve(JSON_OUT)}.tmp-${process.pid}`;
    fs.writeFileSync(tmpOut, `${JSON.stringify(doc, null, 1)}\n`);
    fs.renameSync(tmpOut, path.resolve(JSON_OUT));     // 原子替换：读的人不会读到半个文件
    console.log(`  ↳ 机器可读结果已写：${path.resolve(JSON_OUT)}`);
  } catch (err) {
    // ⚠️ 写不出来**改变退出码**（跟下面 last-run.json 那段相反）：要这个文件的人（verify-complete）
    //   拿不到它就判不了 —— 一个「测试都过了、结果文件没写」的 exit 0 会被读成「过了」。
    console.log(`  ✗ 机器可读结果**没写成**：${err.message}`);
    broken++;
  }
}

if (ONLY || SKIP) {
  // ★ 只跑了一部分 ⇒ 不写 results/last-run.json：顶栏读它当「全量的最近一次」，
  //   一次 3 个文件的绿会把一次全量的红盖掉。`--skip` 同理：少跑的那几个正是本机才红的那几个。
  console.log(`  ↳ ${ONLY ? '--only' : '--skip'}（跑了 ${files.length} 个文件）⇒ 不更新 results/last-run.json（那份只记全量）`);
} else try {
  const rec = status.writeLastRun({
    passed: totalPass,
    failed: totalFail,
    files: results.length,
    broken,
    skipped: skippedFiles.map((r) => r.file),
    silent: silentFiles.map((r) => r.file),
    // ★ 哪几条红了 —— 这是这份记录从「一个数字」变成「一份证据」的地方
    failures: failureDetail,
    // ★ 而这两个字段决定了上面那些数字**值不值得信**
    worktree_changed_during_run: wtChanged,
    // ★ 这一遍**新造**的假 pending（空数组 = 没造；null/缺席 = 这一轮判不了）
    //   ⚠️ 它是**探测器，不是防护**：它说「这一遍写了」，挡不住写。
    probe_pollution_added: probeAdded || undefined,
    probe_pollution_check: probeCheckNote || undefined,
    worktree_check_failed: wtUnknown || undefined,
  });
  console.log(`  ↳ results/last-run.json 已写 · commit ${rec.commit || '(查不到)'}`
    + `${rec.dirty === null ? ' · 工作区状态未知' : rec.dirty ? ' · 工作区脏' : ' · 工作区干净'}`);
} catch (err) {
  console.log(`  ⚠ results/last-run.json **没写成**：${err.message}`);
  console.log('    顶栏会继续显示上一次的数字 —— 而那个数字从现在起是过期的。');
}

// 主动收掉标记。**删不掉也没关系** —— busy.check 的判据是 pid 存活，
// 残留标记会随这个进程退出而自动失效（`lib/busy.js` 文件头 ★★）。
claim.release();

// ── ★ 跑完刷一次心跳 ──────────────────────────────────────────────
//
//   花名册 TTL 900 秒，而心跳只由 `bin/next.js` 在轮询的开头和结尾刷 ——
//   ⇒ 「跑一遍全量」是**一个动作、约 5 分钟**，中间没有位置可以插 poller，
//   跑测试的 agent 会因此掉册。
//
//   🔴 **必须起子进程，不能在这里直接连 redis**：这个文件在 `test/` 下
//     ⇒ `isTestProcess()` 命中 ⇒ 分配一个**测试库** ⇒ 心跳写进测试库 = 白写，
//     而它不会报错。而 `bin/heartbeat.js` 在 `bin/` 下 ⇒ 拿到 db 0 是它应得的。
//   ⚠️ 而它**救不了「一连串动作」那一类**（见 `bin/heartbeat.js` 文件头的射程）。
//   ⚠️ 失败不改变退出码 —— 跟上面写 `last-run.json` 那段同一个理由：
//     `process.exit` 的判据只看断言结果。
try {
  // ★ 用 `DIR` 而不是 `ROOT` —— 这个文件里没有 ROOT（`DIR = __dirname` 指向 test/）。
  //   写成 `ROOT` 的话：`node --check` **过**，而它会在运行时 ReferenceError。
  const hb = spawnSync(process.execPath, [path.join(DIR, '..', 'bin', 'heartbeat.js')],
    { encoding: 'utf8', timeout: 15000 });
  const line = String(hb.stdout || hb.stderr || '').trim().split('\n').pop();
  if (line) console.log(`  ${line}`);
} catch (err) {
  console.log(`  ⚠ 心跳没刷成：${err.message}（不影响退出码）`);
}

console.log('');
process.exit(totalFail === 0 && broken === 0 ? 0 : 1);
