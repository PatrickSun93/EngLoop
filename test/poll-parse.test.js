'use strict';
/**
 * `bin/poll-parse.js` ＋ `bin/self-probe.js` ＋ `bin/waiting-on.js`
 * —— **三块一个东西**，一起住在 `bin/`（从 `temp/` 搬过来）。
 *
 * ── 为什么是三个，不是一个 ──────────────────────────────────────
 *   `poll-parse` 会 require `self-probe` 和 `waiting-on` ⇒ 三个必须一起搬。
 *   ⚠️ 判断「哪些文件还在用」不能看 `mtime`：
 *     **`mtime` 是「最后一次被**改**」，不是「最后一次被**跑**」** ——
 *     一个很久没改的文件可能**每一轮都在跑**。要看 require 图。
 *
 * ── 🔴 这一组判据防的是什么 ──────────────────────────────────────
 *   搬迁残留有**五个不同的维度**：
 *     ① `__dirname` ② 硬编码 `'dev'` ③ 旧路径字面 ④ `require('./兄弟')`
 *     ⑤ **`path.join(HERE, 'outbox-send.js')`** —— 在**另一个文件**里
 *   ⇒ ⇒ 靠「再扫一遍源码」很难把它们找全。
 *   ★ 所以这里的判据一律是**效果型**（真跑，看输出），不是 grep 源码 ——
 *     因为「想得到的维度」这个清单，恰恰漏掉想不到的那些。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'synthetic', 'poll-with-busy.json');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); } else {
    fail += 1;
    console.log(`  ✗ ${msg}${detail !== undefined ? `  → ${detail}` : ''}`);
  }
}

function run(args) {
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 30_000,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const MISSING = /Cannot find module '([^']+)'/g;

function main() {
  console.log('\n══ bin/{poll-parse,self-probe,waiting-on}.js · 三块一起搬 ══\n');

  console.log('【1】🔴 三个脚本真跑一次 ⇒ 输出里**不含** `Cannot find module`');
  // 🔴 守的是：`poll-parse.js` 搬进 bin/ 之后，
  //   `require('./self-probe.js')` / `require('./waiting-on.js')` 双双找不到。
  //   ⇒ 而它 **fail-soft**（脚本自己说「不影响下面的消息解析」）⇒ **消息照常解析**
  //   ⇒ ⇒ 所以它不会失败，它会**成功地少做两件事** —— 而判据必须看输出，不能看退出码。
  const cases = [
    ['poll-parse 跑真实夹具', ['bin/poll-parse.js', FIXTURE]],
    ['self-probe --status', ['bin/self-probe.js', '--status']],
    ['waiting-on', ['bin/waiting-on.js']],
  ];
  for (const [label, args] of cases) {
    const r = run(args);
    const missing = r.out.match(MISSING) || [];
    ok(missing.length === 0,
      `${label} —— 没有 \`Cannot find module\``,
      JSON.stringify(missing));
  }
  // 🔴 阴性对照：这个检查器**表达得出「有问题」**吗（否则上面三条可能恒真）
  ok(("x Cannot find module './nope.js' x".match(MISSING) || []).length === 1,
    '🔴 阴性对照：喂一段**明知含错**的文本 ⇒ 检查器认得出',
    'MISSING 正则失效则上面三条全是恒真');
  // ── 把 bin/ 下那两个文件移走 ⇒ 3 条红。而三条红的原因不一样：
  //   ✅ 第 1 条  `Cannot find module './self-probe.js'` / `'./waiting-on.js'`
  //              ⇒ **这就是要防的那个 bug**（相对 require 指向了别处）
  //   🔴 第 2、3 条 `Cannot find module '/…/bin/self-probe.js'`
  //              ⇒ 红的原因是**那个文件被移走了**，不是那个 bug
  //              ⇒ ⇒ 它们在这个变异下**必然**红，因为变异删掉的正是它们要跑的东西
  //   ★ 所以这一组里，真正守住那个 bug 的**只有第 1 条**。
  //     另外两条的射程是「那两个文件在 bin/ 且能跑」——**那是一件不同的事**，
  //     而它们在输出里长得跟第 1 条一模一样，都是一个 ✗。

  console.log('\n【2】🔴 运行时数据**不跟着代码搬** —— 它们不能落进 `bin/`');
  // 🔴 两处用 `__dirname` 定位运行时数据的地方：
  //   `waiting-on.js`   `__dirname` 是**账本**的位置
  //   `self-probe.js`   同族：pending 状态 ＋ draft
  //   ⇒ ⇒ 留着 `__dirname` 的话，它们会写进 `bin/` —— 而 `bin/` 是 **git 跟踪**的。
  // ★ 分界：**代码进仓库，数据留在 `temp/`**（temp/ 是 gitignored 的）。
  for (const f of ['waiting-on.json', 'probe-pending.json', 'draft-probe-auto.json']) {
    ok(!fs.existsSync(path.join(ROOT, 'bin', f)),
      `\`bin/${f}\` **不存在** —— 运行时数据留在 temp/`,
      '它出现在 bin/ 里 = 数据跟着代码搬了');
  }
  // ── ✅【2b】正向的那一半 ─────────────────────────────────────────────
  //
  //   🔴 上面那条只断言「`bin/` 下**没有**这些文件」——
  //     而「数据没跟着搬」和「**根本没有那些数据**」是**同一个绿**。
  //     而后者是可达的：那三个文件全是**运行时才产生**的 ⇒ 一个从不写盘的实现全绿。
  //
  //   ✅ 正向：跑一次 `--status`，看它**自己说**它读的是哪个文件。
  //   ⚠️ 而为什么不做「让它真写一次再看落在哪」这种效果型 ——
  //     那要往生产 `temp/probe-pending.json` 里放东西，
  //     而**【7-10】那条正控守的正是「那个文件一个字节没动」** ⇒ **两条判据要求相反的东西**。
  //     ⇒ 而两条都对：【7-10】守的是「读是有意的，写不行」，
  //       那正是这个文件**跑在真路径上**的代价。
  //
  //   🔴 而它剩下的那一格如实标着：判据读的是 **stdout 里那个字符串**，
  //     而「打出来的路径」和「它真的去读了那个文件」之间还差一步 ——
  //     补那一步又要碰生产文件 ⇒ 回到上面那个冲突 ⇒ **到此为止**。
  //   ⬜ ＋ `waiting-on.json` 那一格**仍然只有反向**（它属于 `bin/waiting-on.js`，这里不验）。
  {
    const stat = run(['bin/self-probe.js', '--status']);
    const line = (stat.out || '').split('\n').find((l) => l.startsWith('状态文件: ')) || '';
    const draft = (stat.out || '').split('\n').find((l) => l.startsWith('草稿文件: ')) || '';
    ok(line !== '' && draft !== '',
      '【2b】（前提）`--status` 打出了「状态文件 / 草稿文件」两行 —— 否则下面两条恒假',
      JSON.stringify((stat.out || '').slice(0, 120)));
    const inTemp = (l) => /[/\\]temp[/\\][^/\\]+\.json$/.test(l.split(': ')[1] || '');
    const inBin = (l) => /[/\\]bin[/\\]/.test(l.split(': ')[1] || '');
    ok(inTemp(line) && inTemp(draft),
      '【2c】★★ 它**自己说**那两份数据在 `temp/` 下 —— 这是【2】反向的正向配对',
      `${line} | ${draft}`);
    ok(!inBin(line) && !inBin(draft),
      '【2d】而它们**不在 `bin/` 下**（跟【2】同向，但问的是「它读哪」而不是「盘上有没有」）',
      `${line} | ${draft}`);
  }

  console.log('\n【3】它真的解析了那份夹具（不是崩在半路还退 0）');
  const pp = run(['bin/poll-parse.js', FIXTURE]);
  ok(/消息数 1\b/.test(pp.out),
    '★ 报出**消息数 1** —— 而夹具里确实是 1 条',
    JSON.stringify(pp.out.slice(0, 120)));
  ok(/agent:dev:in:::/.test(pp.out),
    '而它打印了 stream_id（协议字段原样打印，「看起来乱」是它该有的样子）',
    JSON.stringify((pp.out.match(/agent:\S+/) || [])[0]));

  console.log('\n【4】🔴 夹具本身必须带 `_busy` —— 否则后面所有关于它的判据都会退化成恒真');
  // 坑：`_busy` **只在有人 declare 时出现** ⇒ 随手捞一份 poll.json 大概率没有它
  //   ⇒ ⇒ 那条断言会变成「断言一个不存在的字段被正确地不存在」= 恒真，而且全绿。
  // ✅ 这份是 declare ＋ poll ＋ 退出**在同一个进程里**跑出来的真实返回，
  //   不是手工构造的 JSON。（而它之所以必须同进程，见 `lib/busy.js` 里那个 exit 钩子。）
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  ok('_busy' in fx && Array.isArray(fx._busy.who) && fx._busy.who.length > 0,
    '🔴 ★ 夹具里**有 `_busy`**，而且 `who` 非空',
    JSON.stringify(Object.keys(fx)));
  ok(typeof fx._busy.polled_at === 'string' && !('age' in fx._busy) && !('as_of_secs_ago' in fx._busy),
    '而它带 `polled_at`、**故意没有 `age`** —— '
    + '「你读到它」到「你动手」之间那段只有你算得出，字段替你算就是替你撒谎',
    JSON.stringify(fx._busy));

  console.log('\n【5】🔴 身份自检的绿灯条件 —— **成对**，而两份夹具只差身份段一处');
  // ── 守的是什么 ────────────────────────────────────────────────────
  //   条件 `injectedIsMe && !injectedIsOrchestrator` 里的 `injectedIsMe`
  //   **结构上不可能为真**：`bin/next.js` 的 `isOrch` 分支让
  //   非编排者一律读同一份通用 agent 身份，而那份**点不了名**。
  //   ⇒ ⇒ 绿灯条件恒假 ⇒ 每轮一个 ⛔ ⇒ 一条恒响、没有可执行动作、照做之后还会响的告警。
  //
  // ✅ 条件仍然是**白名单**：把「认名字」扩成「认角色」（「你是一个 **常驻 agent**」）。
  //   ⚠️ 而**没有**改成「不得声称是编排者」—— 那是黑名单，
  //     **「黑名单的失效方式是结构性的：列举永远差一个」**（`bin/poll-parse.js` 里有同样的说明）。
  //
  // 🔴 而这两条判据的价值全在**成对**：只验绿的那半，
  //   一个 `PASS = true` 的实现照样全绿。
  const real = run(['bin/poll-parse.js', FIXTURE]);
  const orch = run(['bin/poll-parse.js', path.join(__dirname, 'fixtures', 'synthetic', 'poll-as-orchestrator.json')]);
  ok(/角色一致/.test(real.out) && !/⛔ 结论/.test(real.out),
    '✅ 真实注入（「你是一个 **常驻 agent**」）⇒ **放行**，而且那行 ⛔ **消失了** —— '
    + '「照做之后它会安静」，③b 的第三条',
    JSON.stringify(real.out.slice(0, 200)));
  ok(/自称「你是 JARVIS」/.test(orch.out) && /⛔ 结论/.test(orch.out),
    '🔴 ★ 而编排者的注入 ⇒ **不放行**，并说得出为什么',
    JSON.stringify(orch.out.slice(0, 200)));
  // 🔴 而这一条钉住「红的原因是那件事」：两份夹具**除了身份段之外完全相同**
  //   ⇒ 上面那对红/绿的差别，只可能来自那一处。
  //   （正控夹具的身份段用的是**真的** `protocols/identity.md`，不是编出来的句子。）
  const fxA = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const fxB = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'synthetic', 'poll-as-orchestrator.json'), 'utf8'));
  const stripId = (o) => JSON.stringify({ ...o, _orchestrator_instructions: (o._orchestrator_instructions || []).slice(1) });
  ok(stripId(fxA) === stripId(fxB),
    '🔴 ★ 两份夹具**除身份段外逐字相同** ⇒ 上面那对红/绿只可能来自那一处',
    '若不同，则红的原因可能是别的差异 —— 而那正是「第二问」问的东西');
  ok(/你是 \*\*JARVIS\*\*/.test(String(fxB._orchestrator_instructions[0])),
    '而正控夹具的身份段是**真的** `protocols/identity.md`，不是测试编的句子',
    JSON.stringify(String(fxB._orchestrator_instructions[0]).slice(0, 60)));

  console.log('\n【6】🔴 poller 的告警字段 —— 在此之前这个文件**一个都不显示**');
  // ── 守的是什么 ────────────────────────────────────────────────────
  //   `bin/next.js` 的 alerts 字段（`_stale_command` / `_unacked` / `_busy`）
  //   必须在 `bin/poll-parse.js` 的输出里显示得出来。
  //   ⇒ ⇒ 否则**字段存在、正确，而按文档读消息的人看不见它们。**
  //
  // 📌 两份夹具**互补** —— 一次覆盖「存在」和「不存在」两侧：
  //     A `poll-with-busy.json`   有 `_busy`，**无** `_stale_command` / `_unacked`
  //     B `poll-with-alerts.json` 有那两个，**无** `_busy`
  //   ⇒ 每个字段都各有一份存在样本和一份不存在样本。
  //   ⚠️ 只做一份的话，「安静地不显示」这条对另外两个字段**恒真**。
  //
  // ★ 夹具 B 的两段文本不是编的：`_stale_command` 由 `shutdown.targetAlertText()`
  //   生成，`_unacked` 由 `lib/ack-alert.js` 的 `staleAlert()` 生成 —— 都是真函数。
  //
  // ⚠️ 而这两份（连同 `poll-as-orchestrator.json`）是**真实快照** ——
  //   它们里面还带着 `_output_truncated` 字段，而那个字段**已经删除**。
  //   ⇒ 它在这里是**历史**，不是当前 poller 会输出的东西。
  //   ★ 不去编辑它：一份被修干净的 fixture，是这个仓库里最难发现的那种假东西。
  const FX_A = FIXTURE;
  const FX_B = path.join(__dirname, 'fixtures', 'synthetic', 'poll-with-alerts.json');
  const outA = run(['bin/poll-parse.js', FX_A]).out;
  const outB = run(['bin/poll-parse.js', FX_B]).out;
  const fa = JSON.parse(fs.readFileSync(FX_A, 'utf8'));
  const fb = JSON.parse(fs.readFileSync(FX_B, 'utf8'));

  ok(!('_stale_command' in fa) && !('_unacked' in fa) && ('_busy' in fa)
    && ('_stale_command' in fb) && ('_unacked' in fb) && !('_busy' in fb),
    '（前提）两份夹具**互补** —— 否则下面每一条都可能是恒真',
    JSON.stringify({ A: Object.keys(fa), B: Object.keys(fb) }));

  // ① 存在 ⇒ 显示得出来（各一条）
  ok(outB.includes(String(fb._stale_command).split('\n')[0].slice(0, 30)),
    '🔴 ★ `_stale_command` **显示得出来** —— 它在 next.js 里排第一，'
    + '因为它拦的动作（关掉一个正在干活的会话）**不可恢复**',
    JSON.stringify(outB.slice(0, 150)));
  ok(/还有 2 条消息领了没 ack/.test(outB),
    '`_unacked` 显示得出来', JSON.stringify(outB.slice(0, 150)));
  ok(outA.includes(JSON.stringify(fa._busy.who)) && outA.includes(fa._busy.polled_at),
    '`_busy` 显示得出来（`who` ＋ `polled_at`）', JSON.stringify(outA.slice(0, 150)));

  // ② 不存在 ⇒ **安静地**不显示（各一条）—— 不是打印一行 undefined
  ok(!/_stale_command|关停指令告警/.test(outA) && !/漏 ack/.test(outA),
    '🔴 A 里没有那两个字段 ⇒ **安静地不显示** —— 不是一行 `undefined`',
    JSON.stringify(outA.slice(0, 150)));
  ok(!/_busy|有人在跑长任务/.test(outB),
    '🔴 B 里没有 `_busy` ⇒ **安静地不显示**', JSON.stringify(outB.slice(0, 150)));
  ok(!/undefined|\[object Object\]/.test(outA + outB),
    '★ 两份输出里都**没有** `undefined` / `[object Object]` —— '
    + '「一行 undefined」是「陈旧绿灯」在显示层的同一件事',
    JSON.stringify((`${outA}${outB}`).match(/undefined|\[object Object\]/g)));

  // ③ 🔴 polled_at 原样，绝不算 age
  ok(!/\d+\s*秒前|\d+\s*分钟前|ago/.test(outA),
    '🔴 ★ `_busy` 的显示里**没有任何形如「29 秒前」的东西** —— '
    + '那个减法的右操作数是「**你动手的时刻**」，而显示层不知道它',
    JSON.stringify((outA.match(/\d+\s*秒前|\d+\s*分钟前|ago/g) || [])));
  ok(outA.includes(fa._busy.polled_at),
    '而 `polled_at` 是**原样**打出来的（那个 ISO 串逐字出现在输出里）',
    JSON.stringify(fa._busy.polled_at));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n【7】🔴 `bin/self-probe.js` 的**主语**是「我」，不是写死的 `dev`');
  //
  // ── 守什么 ────────────────────────────────────────────────────────
  //   原先写死的字面量 `'dev'` 在那个文件里有**两侧**：
  //     ① `load('dev')`      「**检查谁的**探针状态」—— 错了是**漏报**
  //     ④ `username: 'dev'`  「探针**发给谁**」    —— 错了是**往别人那儿写东西**
  //   ⇒ 它们是一个量的两处（同一个 `whoami()`、同一个「拿不到名字怎么办」），
  //     所以一起验。
  //
  // ── 🔴 为什么必须**成对** ──────────────────────────────────────────
  //   只验「有名字 ⇒ 读自己的」的话，一个「**说完『我不知道我是谁』、照样按 'dev' 查**」
  //   的实现**照样能过** —— 因为那句话它也说了。
  //   ⇒ 所以「拿不到名字」那一档要验两件事：
  //       · 它**说出口**了吗？                              （正）
  //       · 🔴 它**闭嘴**了吗（那一轮没有给出任何探针结论）？（这条才抓得住上面那个冒牌货）
  //   ⇒ ⇒ 下面【7-3】【7-6】就是这一对，而【7-6】配了一个真的会骗过前半句的变异。
  //
  // ── ⚠️ 变异在**内存里**，磁盘上的 `bin/self-probe.js` 一个字不动 ──────────
  //   两份状态文件用 `probetest-*` 这种**没有任何 agent 叫的名字** ⇒
  //   生产的 `probe-state-dev.json` / `probe-state-senior.json` 碰都不碰。
  //   ⚠️ 而 `reconcile()` 会**读**生产的 `temp/probe-pending.json` —— 那是有意的
  //     （让它跑在真路径上）；`msgs=[]` ⇒ `changed` 恒 false ⇒ 不写。末尾有 mtime 正控。
  const MINE = 'probetest-mine';
  const OTHER = 'probetest-other';
  // ★ 这三个跟上面两个一样必须在 `try` **外面** —— `finally` 的清理要看得见它们。
  //   （写在 try 里的话，判据全绿、而 `finally` 抛 ReferenceError
  //     ⇒ 一串 ✓ 之后一个 broken —— 只看末尾几行的话，它看起来是成功的。）
  const ABSENT = 'probetest-absent';
  const CORRUPT = 'probetest-corrupt';
  const NOSENT = 'probetest-nosent';
  const SP_FILE = path.join(ROOT, 'bin', 'self-probe.js');
  const BUSY_FILE = require.resolve(path.join(ROOT, 'lib', 'busy.js'));
  const stateOf = (n) => path.join(ROOT, 'temp', `probe-state-${n}.json`);
  const PROD_PENDING = path.join(ROOT, 'temp', 'probe-pending.json');
  const mtime = () => { try { return fs.statSync(PROD_PENDING).mtimeMs; } catch { return null; } };
  const SRC = fs.readFileSync(SP_FILE, 'utf8');

  /** 把（可能变异过的）源码在内存里编译一份，`whoami()` 固定回 `who`。 */
  function loadSP(source, who) {
    const NodeModule = require('node:module');
    const realBusy = require(BUSY_FILE);
    require.cache[BUSY_FILE].exports = { ...realBusy, whoami: () => who };
    try {
      const m = new NodeModule(SP_FILE, null);
      m.filename = SP_FILE;                                   // ★ `__dirname` 必须是真的 bin/
      m.paths = NodeModule._nodeModulePaths(path.dirname(SP_FILE));
      m._compile(source, SP_FILE);
      return m.exports;
    } finally {
      require.cache[BUSY_FILE].exports = realBusy;            // ★ 立刻还回去
    }
  }
  /** `lib/probe.js` 的 `load()` **被喂了什么名字** —— 这一层不依赖任何文件内容。 */
  function namesFedTo(source, who) {
    const PROBE_FILE = require.resolve(path.join(ROOT, 'lib', 'probe.js'));
    const realProbe = require(PROBE_FILE);
    const seen = [];
    require.cache[PROBE_FILE].exports = { ...realProbe, load: (n) => { seen.push(n); return null; } };
    try { loadSP(source, who).reconcile([]); } finally {
      require.cache[PROBE_FILE].exports = realProbe;          // ★ 立刻还回去
    }
    return seen;
  }
  const say = (source, who) => loadSP(source, who).reconcile([]).lines.join('\n');
  /** 「探针结论」= 那三支里任何一支说了话。**闭嘴**的判据就是它一个都不匹配。 */
  //   ⚠️ 改这里的措辞时，同时看【8-8】—— 它是这条正则的**正控**：
  //     漏掉一支不会红，只会让下面「闭嘴」的判据静默变松。
  const CONCLUSION = /距上次发探针|读不到.{0,4}生产路径的落盘记录|没有「上次发出」时间/;

  const mtBefore = mtime();
  const NOW = Date.now();
  const OLD = NOW - 24 * 60 * 60 * 1000;        // 24 小时前 —— 远超任何阈值
  fs.mkdirSync(path.join(ROOT, 'temp'), { recursive: true });
  try {
    // ── 第一档：有名字 ⇒ 读的是**那个名字**的那份 ────────────────────
    //   自己那份「很久没发了」⇒ 现版必须报；别人那份「刚发过」⇒ 读错人就会安静。
    fs.writeFileSync(stateOf(MINE), JSON.stringify({ last_sent_ms: OLD, pending: [] }));
    fs.writeFileSync(stateOf(OTHER), JSON.stringify({ last_sent_ms: NOW, pending: [] }));

    const realOut = say(SRC, MINE);
    ok(/距上次发探针/.test(realOut),
      `【7-1】有名字 ⇒ 读的是**我（${MINE}）**那份（它很久没发 ⇒ 报了出来）`,
      JSON.stringify(realOut.slice(0, 160)));

    // ★★ 变异 A（负控）：`load(ME)` → 写死另一个人。**这就是要防的那个 bug 的形状。**
    const mutA = SRC.replace('.load(ME)', `.load('${OTHER}')`);
    ok(SRC.split('.load(ME)').length - 1 === 1 && mutA !== SRC,
      '【7-2】（变异 A 的锚点唯一命中 —— 一个没改到的变异会让下一条恒绿）');
    const mutAOut = say(mutA, MINE);
    ok(!/距上次发探针/.test(mutAOut),
      '【7-3】★★ 变异：读写死的那个人 ⇒ **安静** —— 于是【7-1】不是恒真',
      JSON.stringify(mutAOut.slice(0, 160)));

    // ── 🔴 而【7-3】那条变异用的名字是**构造**的 —— 这里补一条用**旧写法原文** ────
    //
    //   旧写法那一行逐字是 `.load('dev')`。而**不能**拿 `temp/probe-state-dev.json`
    //   的**内容**当夹具（那是生产文件，而且它的内容随探针每小时在变）
    //   ⇒ 所以这一档退到**参数层**：只看 `load()` **被喂了什么名字**。
    //   ⇒ ⇒ 参数层不依赖任何文件内容 ⇒ 它是确定的，
    //     而且喂进去的源码是**旧写法那一行的原文**，不是想象的一种形状。
    //   ★ 分工：【7-1/7-3】验**效果**（读到的内容不同），这两条验**主语**（喂进去的名字）。
    ok(JSON.stringify(namesFedTo(SRC, MINE)) === JSON.stringify([MINE]),
      `【7-3b】真版喂给 \`load()\` 的名字是 **${MINE}**`,
      JSON.stringify(namesFedTo(SRC, MINE)));
    const mutReal = SRC.replace('.load(ME)', ".load('dev')");
    ok(JSON.stringify(namesFedTo(mutReal, MINE)) === JSON.stringify(['dev']),
      "【7-3c】★★ 而**旧写法那一行的原文**（`.load('dev')`）喂的是 `dev` ⇒ "
      + '这一对不是构造出来的形状，是真的那一行',
      JSON.stringify(namesFedTo(mutReal, MINE)));

    // ── 第二档：拿不到名字 ⇒ 说出口 ＋ **闭嘴** ──────────────────────
    //   把「别人那份」也改成很久没发 ⇒ 「照样按别人查」的实现**会**报，
    //   而正确的实现必须一个结论都不给。
    fs.writeFileSync(stateOf(OTHER), JSON.stringify({ last_sent_ms: OLD, pending: [] }));
    const blindOut = say(SRC, null);
    ok(/推不出我是谁/.test(blindOut),
      '【7-4】拿不到名字 ⇒ **说出口**（「推不出我是谁」）',
      JSON.stringify(blindOut.slice(0, 140)));
    ok(!CONCLUSION.test(blindOut),
      '【7-5】🔴 ★ 而同一轮**没有给出任何探针结论** —— 「我不知道该查谁」≠「探针没问题」',
      JSON.stringify(blindOut.match(CONCLUSION) || []));
    // ── 🔴【7-5b】…【7-5e】：把「闭嘴」从**否定匹配**换成**逐字比** ──
    //
    //   【7-5】验的是「输出**不匹配** `CONCLUSION`」——
    //   而否定匹配对「**没想到的那一句**」天然瞎：在那一支里再 push 一句新的结论，
    //   `CONCLUSION` 不认识它 ⇒ 【7-5】照样绿。
    //
    //   ✅ 所以：把 pending 那一段切掉，对**剩下的整段**逐字比。
    //     于是「在那条路径上多 push 任何一句」都会红，跟它长什么样无关。
    //
    //   ⚠️ 代价：**有意改措辞的人会撞红** —— 而那正是要的（他得回来看一眼这一格）。
    //   🔴 而残余洞：**在 pending 段之后再 push 一句结论**
    //     ⇒ 它落在 `head` 外面 ⇒ 看不见。目前不存在那种写法 ——
    //     而「目前不存在」不等于「守住了」。
    const sayLines = (source, who) => loadSP(source, who).reconcile([]).lines;
    /** pending 那一段的**主行**（续行不必识别 —— 切点只需要第一行）。 */
    const PENDING_HEAD = /^\s+(✅|🔴🔴|⏳) 探针 /;
    const headOf = (lines) => {
      const cut = lines.findIndex((l) => PENDING_HEAD.test(l));
      return cut < 0 ? lines : lines.slice(0, cut);
    };
    // ★ 先验这个**切法本身**（它是下面两条的前提；切错了它们就恒真/恒假）。
    ok(headOf(['x', '  ✅ 探针 123 回来了 —— 端到端链路活着', 'y']).join('|') === 'x',
      '【7-5b】（前提）`headOf` 在 pending 主行处切断');
    ok(headOf(['x', 'y']).join('|') === 'x|y',
      '【7-5c】（前提·阴性对照）没有 pending 段时**一行都不切** —— 否则上一条恒真');

    // 手抄自 `bin/self-probe.js`（拿不到名字那一支）。**故意手抄**：从被测对象取期望值
    // 就成了「自己给自己发证」，那样改措辞时它永远不会红。
    const EXPECTED_BLIND = [
      '  ⚠️ **推不出我是谁**（不在 agent 的 tmux 会话里）⇒ 这一轮没有给出任何探针结论',
      '     ⛔ 这不是「探针没在发」，是「我不知道它在不在发」—— 别据此下结论。',
    ];
    const blindHead = headOf(sayLines(SRC, null));
    ok(blindHead.length === EXPECTED_BLIND.length
      && blindHead.every((l, i) => l === EXPECTED_BLIND[i]),
      '【7-5d】★★ 拿不到名字那一支的输出**逐字**只有那两行'
      + ' —— 多 push 任何一句都会红，跟它长什么样无关',
      JSON.stringify(blindHead));

    // 🔴【7-5e】（存在型）：**分支数没变**。
    //   上面那条守「话变了」，这条守「结构变了」—— 有人加第五支时立刻撞红，
    //   而红的信息可执行：去把它加进 `CONCLUSION`、加进【8-8】的三支正控。
    //   ⚠️ 存在型的理由写在这里：效果型答不了「有没有没想到的那一支」，
    //     要真答它得枚举所有可能的 `prodState`，而那是个开集。
    ok((SRC.match(/\} else if \(prodState/g) || []).length === 2
      && (SRC.match(/if \(prodState === undefined\) \{/g) || []).length === 1,
      '【7-5e】⚠️ **存在型**：`prodState` 的分支仍是 4 支（1 if ＋ 2 else if ＋ 1 else）',
      `else-if ${(SRC.match(/\} else if \(prodState/g) || []).length} 次`);
    // ── 🔴【7-5f/g/h】把「逐字比比否定匹配强在哪」写成判据 ────────
    //
    //   ★ 同一个变异（在那一支多 push 一句结论）：
    //       【7-5】（`CONCLUSION` 否定匹配）⇒ **仍然绿** —— 它认不出那句新结论
    //       【7-5d】（逐字比）              ⇒ **红**
    //     ⇒ ⇒ 于是「否定匹配瞎在哪里」是判据自己说的。
    //   （同 `worktree-hash.test.js`【4】的做法：把**旧实现**放进判据。）
    const MUT_EXTRA_ANCHOR =
      "    lines.push('     ⛔ 这不是「探针没在发」，是「我不知道它在不在发」—— 别据此下结论。');";
    const mutExtra = SRC.replace(MUT_EXTRA_ANCHOR,
      `${MUT_EXTRA_ANCHOR}\n    lines.push('  ⚠️ 顺带一提：探针那边大概没什么事');`);
    ok(SRC.split(MUT_EXTRA_ANCHOR).length - 1 === 1 && mutExtra !== SRC,
      '【7-5f】（变异锚点唯一命中 —— 没改到的话下面两条都恒绿）');
    const mutExtraLines = sayLines(mutExtra, null);
    ok(!CONCLUSION.test(mutExtraLines.join('\n')),
      '【7-5g】🔴 而**旧判据（`CONCLUSION` 否定匹配）在这个变异下仍然绿** —— 它认不出那句新结论'
      + '（⚠️ 这条是**故意断言一个弱点**：哪天 `CONCLUSION` 强到认得它，这条会红，'
      + '而那时的动作是「把这组对照删掉」）',
      JSON.stringify(mutExtraLines.slice(0, 3)));
    const mutExtraHead = headOf(mutExtraLines);
    ok(!(mutExtraHead.length === EXPECTED_BLIND.length
      && mutExtraHead.every((l, i) => l === EXPECTED_BLIND[i])),
      '【7-5h】★★ 而【7-5d】那条逐字比**红了**（head 3 行 ≠ 期望 2 行）'
      + ' ⇒ 逐字比抓得住的正是这一格',
      `head=${mutExtraHead.length} 行`);

    // ★★ 变异 B（负控）：**说完照样查** —— 那个能骗过【7-4】的实现，长这样。
    const MUT_B_ANCHOR = 'if (!ME) return undefined;';
    const mutB = SRC.replace(MUT_B_ANCHOR,
      "if (!ME) { lines.push('  ⚠️ **推不出我是谁**（不在 agent 的 tmux 会话里）'); "
      + `return require(path.join(HERE, '..', 'lib', 'probe.js')).load('${OTHER}'); }`);
    ok(SRC.split(MUT_B_ANCHOR).length - 1 === 1 && mutB !== SRC,
      '【7-6】（变异 B 的锚点唯一命中）');
    const mutBOut = say(mutB, null);
    ok(/推不出我是谁/.test(mutBOut) && CONCLUSION.test(mutBOut),
      '【7-7】★★ 变异「说完照样按写死的名字查」：它**过得了**【7-4】，'
      + '**过不了**【7-5】⇒ 成对的后半句是唯一抓得住它的地方',
      JSON.stringify(mutBOut.slice(0, 220)));

    // ── 第三档：④「发给谁」──────────────────────────────────────────
    //   ⚠️ 这两条是**存在型**的，而退档的理由写在断言里：
    //     效果型要真跑一次 `node bin/self-probe.js`，而那会**真的投一条消息进流** ——
    //     判据不该有那种副作用。（⇒ 它守不住「改了字面量但发送路径另有一份」那种。）
    ok(/username: ME,/.test(SRC) && !/username: 'dev'/.test(SRC),
      "【7-8】④ 收件人是 `ME` 不是写死的 `'dev'` —— ⚠️ **存在型**：效果型会真发一条消息",
      JSON.stringify(SRC.match(/username: [^,\n]+/g) || []));
    ok(/if \(!ME\) \{[\s\S]{0,600}?process\.exit\(2\)/.test(SRC),
      '【7-9】④ 而推不出名字时**一条都不发**（退出码 2）—— 不默认成任何人');

    // ── 第四档：③ **同一个 `null`，两种输入，一个结论** ────────
    //
    //   `lib/probe.js` 的 `load()` 对**两种**输入都返回 null：文件不存在 / 文件解不开。
    //   而它的注释写着「由调用方统一报告，这里不区分」——
    //   所以 `self-probe.js` 不许说过头：「从来没发过探针」对「文件坏了」是假的，
    //   而且方向反了。
    //
    //   ⚠️ 为什么不用 `ENGLOOP_PROBE_STATE` 来隔离：`lib/probe.js` 拿它当生产状态文件；
    //     设了它，这一段就不再跑在它要验的那条路径上。
    //     ⇒ 所以照【7-x】的做法：用**没有任何 agent 叫的名字**写到 `temp/`。
    // 【前提】两个输入**真的不同** —— 否则「两种输入同一句结论」恒真。
    try { fs.unlinkSync(stateOf(ABSENT)); } catch { /* 本来就没有 */ }
    fs.writeFileSync(stateOf(CORRUPT), '{ 这一份存在，但解不开');
    ok(!fs.existsSync(stateOf(ABSENT)) && fs.existsSync(stateOf(CORRUPT)),
      '【8-0】（前提）A 的文件**不存在** ＋ B 的文件**存在** —— 否则下面全恒真');
    let bParses = true;
    try { JSON.parse(fs.readFileSync(stateOf(CORRUPT), 'utf8')); } catch { bParses = false; }
    ok(!bParses, '【8-0b】（前提）而 B 的内容**真的解不开** —— 否则它会走到别的分支去');

    const outAbsent = say(SRC, ABSENT);
    const outCorrupt = say(SRC, CORRUPT);
    ok(/读不到.{0,4}生产路径的落盘记录/.test(outAbsent),
      '【8-1】文件不存在 ⇒ 「**读不到**生产路径的落盘记录」',
      JSON.stringify(outAbsent.slice(0, 120)));
    ok(/读不到.{0,4}生产路径的落盘记录/.test(outCorrupt),
      '【8-2】★★ 文件在但解不开 ⇒ **同一句** —— 一个 null，一个结论',
      JSON.stringify(outCorrupt.slice(0, 120)));
    ok(!/从来没发过探针/.test(outAbsent) && !/从来没发过探针/.test(outCorrupt),
      '【8-3】两种输入都**不再说**「从来没发过探针」'
      + '（⚠️ 这条单独恒真 —— 它只在跟 8-1/8-2 配着看时有意义）');

    // ★ 结论要一样，而**人得拿得到分辨它们的东西** ⇒ 差别只许出现在那一行路径上。
    const stripPath = (s) => s.split('\n').filter((l) => !l.includes('自己分辨：看')).join('\n');
    ok(stripPath(outAbsent) === stripPath(outCorrupt),
      '【8-4】★ 去掉路径那行之后，两种输入的输出**逐字相同**（而输入确实不同，见 8-0）');
    ok(outAbsent.includes(stateOf(ABSENT)) && outCorrupt.includes(stateOf(CORRUPT)),
      '【8-5】而两边各自打印了**自己那份**的路径 ⇒ 人能自己分辨是哪一种');

    // ★★ 变异 C（负控）：把措辞换回旧的。**这就是要防的那句话的形状。**
    const mutC = SRC.replace('**读不到**生产路径的落盘记录', '生产路径**从来没发过探针**');
    ok(SRC.split('**读不到**生产路径的落盘记录').length - 1 === 1 && mutC !== SRC,
      '【8-6】（变异 C 的锚点唯一命中 —— 没改到的话下一条恒绿）');
    ok(/从来没发过探针/.test(say(mutC, CORRUPT)),
      '【8-7】★★ 变异回旧措辞 ⇒ 在「文件坏了」上说「从来没发过」'
      + ' ⇒ 于是【8-2】不是恒真，它守的正是这句假话别回来');

    // ── 🔴【8-8】正控 `CONCLUSION` 自己 ──────────────────────────────────
    //   `bin/self-probe.js` 的措辞一改，`CONCLUSION` 里对应那一支
    //   就再也匹配不上任何东西 —— 而**测试照样全绿**，
    //   因为【7-5】断言的是「**没有**给出结论」⇒ 漏一支只会让它**变松**。
    //   ⇒ ⇒ 一个值两个副本：措辞在 `bin/`，正则在 `test/`，而分叉是静默的。
    fs.writeFileSync(stateOf(NOSENT), JSON.stringify({ pending: [] }));   // 无 last_sent_ms
    const threeBranches = [
      ['距上次发探针', say(SRC, MINE)],
      ['读不到落盘记录', outAbsent],
      ['没有「上次发出」时间', say(SRC, NOSENT)],
    ];
    const missed = threeBranches.filter(([, s]) => !CONCLUSION.test(s)).map(([n]) => n);
    ok(missed.length === 0,
      '【8-8】★★ 正控 `CONCLUSION` 自己：现版**每一支**结论它都匹配得上'
      + ' —— 漏一支，【7-5】就静默变松',
      `漏掉: ${missed.join(' / ') || '(无)'}`);
    // ── 第五档：② **不许一名两用**（self-probe 用 `ENGLOOP_PROBE_PENDING`）──────
    //
    //   旧写法：`lib/probe.js` 和 `bin/self-probe.js` 读**同一个** `ENGLOOP_PROBE_STATE`，
    //   一个当「生产的按名字分的状态文件」，一个当「self-probe 自己的在途清单」。
    //   ⇒ 设了它 ⇒ 两边指向同一个文件 ⇒ `reconcile()` 那段检查不再跟生产路径走。
    //
    //   ★ 判据是**效果型**的：把一条带 id 的 pending 塞进那个文件，看输出里有没有那个 id。
    //     （存在型只能验「源码里写的是哪个名字」—— 而那答不了「它实际读了谁」。）
    const SHARED = stateOf('probetest-shared');
    const MARK = 'ZZZ-two-names';
    fs.writeFileSync(SHARED, JSON.stringify({
      last_sent_ms: NOW, pending: [{ id: MARK, sent_ms: OLD, outbox_ms: OLD }],
    }));
    const envBefore = {
      s: process.env.ENGLOOP_PROBE_STATE, p: process.env.ENGLOOP_PROBE_PENDING,
    };
    try {
      // 【9-1】（前提）先证明这条路**真的通**：设**自己那个**变量 ⇒ 那条 pending 出现在输出里。
      //   ⚠️ 没有它，下面「不出现」可能只是「这个夹具压根没被读到」⇒ 恒真。
      delete process.env.ENGLOOP_PROBE_STATE;
      process.env.ENGLOOP_PROBE_PENDING = SHARED;
      ok(say(SRC, MINE).includes(MARK),
        '【9-1】（前提）设 `ENGLOOP_PROBE_PENDING` ⇒ 那条 pending **出现在输出里**'
        + ' —— 否则下面那条恒真');

      // 【9-2】★★ 核心：两个模块设**同一个**变量 ⇒ 拿到的路径**不同**。
      delete process.env.ENGLOOP_PROBE_PENDING;
      process.env.ENGLOOP_PROBE_STATE = SHARED;
      const sharedOut = say(SRC, MINE);
      ok(!sharedOut.includes(MARK),
        '【9-2】★★ 设 `ENGLOOP_PROBE_STATE` ⇒ self-probe 的 pending **不再跟着走**'
        + '（改名之前这里恒假）', JSON.stringify(sharedOut.slice(0, 140)));
      ok(require(path.join(ROOT, 'lib', 'probe.js')).statePath(MINE) === SHARED,
        '【9-3】（对照）而**同一时刻** `lib/probe.js` 那一侧确实拿到了它'
        + ' ⇒ 两个模块、同一个变量、**两条路径**');

      // 【9-4】★★ 变异（负控）：把 `PENDING` 改回读旧名 ⇒ 【9-2】必红。
      const MUT_NAME = 'process.env.ENGLOOP_PROBE_PENDING';
      const mutName = SRC.replace(MUT_NAME, 'process.env.ENGLOOP_PROBE_STATE');
      ok(SRC.split(MUT_NAME).length - 1 === 1 && mutName !== SRC,
        '【9-4】（变异锚点唯一命中）');
      ok(say(mutName, MINE).includes(MARK),
        '【9-5】★★ 变异回旧名 ⇒ 那条 pending **又跟着 `ENGLOOP_PROBE_STATE` 走了**'
        + ' ⇒ 于是【9-2】不是恒真');
    } finally {
      // ★ 环境变量**原样还回去**（`undefined` 要用 delete，不能赋 'undefined' 字符串）。
      if (envBefore.s === undefined) delete process.env.ENGLOOP_PROBE_STATE;
      else process.env.ENGLOOP_PROBE_STATE = envBefore.s;
      if (envBefore.p === undefined) delete process.env.ENGLOOP_PROBE_PENDING;
      else process.env.ENGLOOP_PROBE_PENDING = envBefore.p;
    }

    ok(mtime() === mtBefore,
      '【7-10】⚠️ 正控：生产 `temp/probe-pending.json` **一个字节没动**（读是有意的，写不行）',
      `${mtBefore} → ${mtime()}`);
  } finally {
    // ★ 两份夹具都在 `temp/`（gitignored），而**留下来会变成永不销账的状态**。
    for (const n of [MINE, OTHER, ABSENT, CORRUPT, NOSENT, 'probetest-shared']) {
      try { fs.unlinkSync(stateOf(n)); } catch { /* 本来就没有 */ }
    }
  }

  console.log(`\n${'─'.repeat(50)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
