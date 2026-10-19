'use strict';

/**
 * 完成核验的**源码级内存变异**：把关键判据的一行在内存里改掉，要求**指定的那条**判据变红。
 * 一个字节都不落盘（`scripts/_srcmut-hook.js`，NODE_OPTIONS 带进 bus 和核验子进程）。
 *
 * 判档跟 `scripts/mutate-graph.js` 一样：
 *   ✅ killed     指定的那条（label 子串）出现在 `✗` 行里，且跑到了总结行
 *   ⚠️ crashed    没有总结行（进程崩了 / 超时）—— **不算 killed**
 *   🔴 survived   跑完了，而指定的那条仍是 `✓`
 *
 * 用法：node scripts/mutate-verify.js          全部（~6 分钟；跑 graph-e2e 的那个 ~45 秒）
 *       node scripts/mutate-verify.js V1 V13   只跑这几个
 * ⚠️ verify-qa / graph-e2e 会 provision `workers/{test,eval}/`（已知副作用），跑完 `git checkout -- workers/`。不进 run-all。
 *
 * ⚠️ 避开两种已知的假绿：
 *   · 「断言命中注释里的同一个串」—— 这里的判据都看**行为**（核验结论、流条目、反应、退出码），不看源码文本
 *   · 「测试中途抛异常、总结行由 catch 补出来」—— 每个测试文件的 catch 都 `fail++`，而且这里要求的是**指定那条** ✗，
 *     不是「有红就行」：一个崩在前面的测试会报 crashed / survived，不会报 killed
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(__dirname, '_srcmut-hook.js');
const F = (p) => path.join(ROOT, p);
const VC = 'lib/verify-complete.js';
const DV = 'lib/done-verify.js';
const UNIT = 'test/verify-complete.test.js';
const QA = 'test/verify-qa.test.js';
const E2E = 'test/done-verify-e2e.test.js';
const STOP = 'test/stop-check.test.js';
const SET = 'test/agent-settings.test.js';
const SB = 'test/sandbox-profile.test.js';
const E2E2 = 'test/done-verify-e2e.test.js';
const SBP = 'lib/sandbox-profile.js';
const STOPJS = 'hooks/stop_check.js';

const MUTANTS = [
  // ── sandbox ──
  { id: 'B1', what: 'verify-complete：测试不套 sandbox（直接跑 agent 的测试代码）',
    file: VC, from: 'const wrapped = sandboxProfileFile ? sandbox.wrap(sandboxProfileFile, full) : full;', to: 'const wrapped = full;',
    test: SB, expect: 'token 内容没出现在任何输出里' },
  { id: 'B2', what: 'Stop hook：没拿到配置也照跑（退回成不带 sandbox）',
    file: STOPJS, from: 'const argv = sandbox.wrap(profileFile, [process.execPath, path.join(root, t)]);', to: 'const argv = [process.execPath, path.join(root, t)];',
    test: SB, expect: 'cwd 里没有偷来的 token' },
  { id: 'B3', what: 'profile：写白名单形同虚设（不 deny file-write*）',
    file: SBP, from: "'(deny file-write*)',", to: "'; (deny file-write*)',",
    test: SB, expect: '往工作树外（HOME 下）写 ⇒ EPERM' },
  { id: 'B4', what: 'profile：reDenyWrite 不生效（提权路径又能写）',
    file: SBP, from: '...reDeny.map((d) => `(deny file-write* (subpath ${sb(d)}))`),', to: '',
    test: SB, expect: 'reDenyWrite：写自己的 agent-settings / hooks ⇒ EPERM' },
  { id: 'B5', what: 'profile：网络全放（公网也能连）',
    file: SBP, from: '\'(deny network-outbound (remote ip "*:*"))\',', to: "'; no net deny',",
    test: SB, expect: '连公网 1.1.1.1:443 ⇒ 被拒' },
  { id: 'B6', what: 'profile：拒读不生效（钥匙能读）',
    file: SBP, from: '...reads.map((r) => `(deny file-read* (literal ${sb(r)}))`),', to: '',
    test: SB, expect: '读假 token ⇒ EPERM' },
  { id: 'B9', what: 'available() 退回「文件在就算能用」（套不上第二层时 exit 71 被读成测试红了）',
    file: SBP, from: 'usableCache = r.status === 0;', to: 'usableCache = true;',
    test: SB, expect: 'Stop hook 在 sandbox 里 ⇒ 认出套不上第二层' },
  // ── .git 收口 ──
  { id: 'G1', what: 'GIT_HARDEN 空（框架 git 不关 fsmonitor/hooks）',
    file: SBP, from: "const GIT_HARDEN = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat'];", to: 'const GIT_HARDEN = [];',
    test: 'test/sandbox-git.test.js', expect: '第二层：config 已设 fsmonitor' },
  { id: 'G2', what: 'gitExecConfigRegex 什么都不匹配（worktrees 元数据 config/hooks 不抠）',
    file: SBP, from: 'return `^${esc}(/worktrees/[^/]+)?/(config[.]worktree|config|hooks(/.*)?)$`;', to: 'return `^$a-impossible`;',
    test: 'test/sandbox-git.test.js', expect: 'worktrees/<name>/config 被正则抠' },
  { id: 'G3', what: 'profile 不抠 reDeny（.git 整个可写）',
    file: SBP, from: '...reDeny.map((d) => `(deny file-write* (subpath ${sb(d)}))`),', to: '',
    test: 'test/sandbox-git.test.js', expect: '.git/config、.git/hooks 被抠' },
  { id: 'B7', what: '去数字配对作用在整条 key 上（文件名里的数字被抹平）',
    file: VC, from: '  return k.slice(0, i + 4) + k.slice(i + 4).replace(/\\d+/g, \'#\');', to: '  return k.replace(/\\d+/g, \'#\');',
    test: UNIT, expect: 'v2.test.js 和 v3.test.js 标题相同也算两条' },
  { id: 'B8', what: '核验范围不是全量时跟帖不写范围',
    file: DV, from: "? `\\n范围：agent 自选的 \\`${ev.tests}\\`，不是全量。` : '';", to: "? '' : '';",
    test: E2E2, expect: '核验范围不是全量时' },


  // ── verify-complete 的判据 ──
  { id: 'V1', what: '失败集合按**数目**比（不按文件 ＋ 标题）',
    file: VC,
    spec: [
      { from: 'for (const [k, n] of h) for (let i = (b.get(k) || 0); i < n; i++) extra.push(k);',
        to: '{ const nb = [...b.values()].reduce((x, y) => x + y, 0); let nh = 0; for (const [k, n] of h) for (let i = 0; i < n; i++) { nh++; if (nh > nb) extra.push(k); } }' },
      { from: 'for (const [k, n] of b) for (let i = (h.get(k) || 0); i < n; i++) missing.push(k);', to: '' },
    ],
    test: UNIT, expect: '⑥ 数目相等但换了一条失败 ⇒ fail' },
  { id: 'V8', what: '不做去数字的第二轮配对（标题里带随机端口的老失败被当成新增）',
    file: VC, from: 'if (cands && cands.length) fuzzy.push([cands.shift(), k]);', to: 'if (false) fuzzy.push([cands.shift(), k]);',
    test: UNIT, expect: '标题只差数字（每次随机的端口）' },
  { id: 'V9', what: '去数字配对不消耗（一条老失败能配掉任意多条新的）',
    file: VC, from: 'fuzzy.push([cands.shift(), k]);', to: 'fuzzy.push([cands[0], k]);',
    test: UNIT, expect: '去数字配对也按多重集' },
  { id: 'V2', what: '不查 commit 是不是 HEAD',
    file: VC, from: 'const isHead = head.ok && head.out === sha;', to: 'const isHead = head.ok;',
    test: UNIT, expect: '④ claimed commit ≠ HEAD ⇒ fail' },
  { id: 'V3', what: '不查工作树干不干净',
    file: VC, from: 'const clean = st.ok && dirty.length === 0;', to: 'const clean = st.ok;',
    test: UNIT, expect: '③ 工作树有未提交改动 ⇒ fail' },
  { id: 'V4', what: '跟「全绿」比，不跟基线比',
    file: VC, from: 'compareFailures(base.results, headRun.results)', to: 'compareFailures({ files: [] }, headRun.results)',
    test: UNIT, expect: '⑤ 基线就有的失败（add）不算新增 ⇒ pass' },
  { id: 'V5', what: '临时树不清理',
    file: VC, from: 'const rm = removeScratch(repo, scratch.dir);', to: 'const rm = { ok: true };',
    test: UNIT, expect: '临时树都清掉了' },
  { id: 'V6', what: 'run-all 的失败标题不去掉「  → 细节」（细节里有时间戳）',
    file: 'test/run-all.js', from: "const t = m[1].split('  → ')[0].trim();", to: 'const t = m[1].trim();',
    test: UNIT, expect: 'run-all 标题：只认行首 ✗、去掉' },
  { id: 'V7', what: 'defaultVerify 不转义图目录（来自 redis）',
    file: VC, from: "String(s).replace(/'/g, `'\\\\''`)", to: 'String(s)',
    test: UNIT, expect: 'defaultVerify：图目录（来自 redis）被单引号转义' },
  // ── QA ──
  { id: 'Q1', what: 'QA：PASS 没证据也算过',
    file: VC, from: "else if (s.verdict === 'PASS' && !s.evidence)", to: 'else if (false)',
    test: UNIT, expect: 'QA 解析：PASS 有证据算过' },
  { id: 'Q2', what: 'QA：FAIL 的项不算没过',
    file: VC, from: "it.verdict === 'PASS', why,", to: 'true, why,',
    test: QA, expect: '第 2 项 FAIL ⇒ fail' },
  { id: 'Q3', what: 'QA：test worker 不回（超时）不算没过',
    file: VC, from: "rep.add('QA（work:test 独立核）', false, qa.error);", to: "rep.add('QA（work:test 独立核）', true, qa.error);",
    test: QA, expect: 'test worker 不回 ⇒ fail' },
  { id: 'Q4', what: 'worker 池不把 VERIFY 的结果改道（进 orch:in:agent）',
    file: 'lib/worker-pool.js', from: 'if (msg.from === QA_REQUESTER && msg.job_id) return qaReplyStream(msg.job_id); ', to: '',
    test: QA, expect: '两项都 PASS ⇒ pass' },
  // ── done 流程接线 ──
  { id: 'D1', what: 'relay：带 evidence 的 done 照旧直接打 🏁（不核）',
    file: 'lib/relay.js', from: 'if (done && verifyMode === doneVerify.VERIFY.PENDING) {', to: 'if (false) {',
    test: E2E, expect: '先打 ⏳，**没有**打 🏁' },
  { id: 'D2', what: 'bus 不给 relay 接核验',
    file: 'bin/serve.js', from: '    doneVerifier,\n', to: '',
    test: E2E, expect: '流里那条 done 带 verify:"pending"' },
  { id: 'D3', what: '核验阻塞 relay（等子进程跑完才处理下一条）',
    file: DV, from: 'child.unref();', to: "child.unref(); await new Promise((r) => child.on('exit', r));",
    test: E2E, expect: '★ 核验还在跑（⏳ 还在）时，relay 照样投了下一条' },
  { id: 'D4', what: '打回不设上限（第 3 次还打回给 agent）',
    file: DV, from: 'if (n <= maxBounces && crew && crew.stream) {', to: 'if (crew && crew.stream) {',
    test: E2E, expect: '第 3 次：vcrew **不再**收到打回' },
  { id: 'D5', what: '打回消息不盖 system 章',
    file: DV, from: "      ...stamp.SYSTEM,\n      to: job.from,", to: '      to: job.from,',
    test: E2E, expect: '第 1 次：vcrew 收到一条 trust:"system" 的打回' },
  { id: 'D6', what: '通知：没带 evidence 不写「没带 evidence」',
    file: 'web/threads.js', from: "missing: '（未验证（没带 evidence））',", to: "missing: '',",
    test: E2E, expect: '流里 verify:"missing"，通知标题带「未验证（没带 evidence）」' },
  { id: 'D7', what: '通知：核验在跑（pending）也弹',
    file: 'web/threads.js', from: "if (v === 'pending' || v === 'fail') return", to: "if (v === 'fail') return",
    test: E2E, expect: '通知：pending 那条不弹' },
  { id: 'D8', what: 'poller 不带 verify 字段',
    file: 'bin/next.js', from: 'verify: m.verify || undefined,', to: '',
    test: E2E, expect: 'poller：带 evidence 的那条 ⇒ verify:"pending"' },
  { id: 'D9', what: 'bus 不给任务图接 defaultVerify（退回 null）',
    file: 'bin/serve.js', from: 'defaultVerify: verifyLib.graphDefaultVerify({ root: ROOT, graphsRoot: GRAPHS_ROOT }),', to: 'defaultVerify: null,',
    test: 'test/graph-e2e.test.js', expect: '★ a（没写 verify）走了 defaultVerify' },
  // ── Stop hook ──
  { id: 'S1', what: 'Stop hook 不看 stop_hook_active（死循环）',
    file: 'hooks/stop_check.js', from: 'if (input.stop_hook_active === true) return 0;', to: '',
    test: STOP, expect: 'stop_hook_active:true ⇒ 放行' },
  { id: 'S2', what: 'Stop hook 映射不到 lib → test',
    file: 'hooks/stop_check.js', from: 'if (exists(t)) want.add(t);', to: 'if (false) want.add(t);',
    test: STOP, expect: '改坏 lib/math.js ⇒ exit 2' },
  { id: 'S3', what: 'Stop hook 挂给所有类型（不看写能力）',
    file: 'lib/agent-settings.js', from: "if (kind === 'crew' && cap.write) {", to: "if (kind === 'crew') {",
    test: STOP, expect: 'eval（不能写）不挂 Stop hook' },
  // ── QA 独立（配置形状）──
  { id: 'A1', what: 'QA 产物路径不 deny Edit',
    file: 'lib/agent-settings.js', from: 'deny.push(...qa.map((p) => `Edit(${abs(p)})`));', to: '',
    test: SET, expect: 'dev：Edit deny 和 sandbox denyWrite 都盖住' },
  { id: 'A2', what: 'QA 产物路径不进 sandbox denyWrite',
    file: 'lib/agent-settings.js', from: 'const denyWrite = [...qa, ...mainRefGuard(cwd)];', to: 'const denyWrite = [...mainRefGuard(cwd)];',
    test: SET, expect: 'eval：Edit deny 和 sandbox denyWrite 都盖住' },
];

function runOne(m) {
  const specs = (m.spec || [{ from: m.from, to: m.to }]).map((s) => ({ file: F(m.file), from: s.from, to: s.to }));
  const env = { ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${HOOK}`.trim(),
    ENGLOOP_SRCMUT: JSON.stringify(specs) };
  const r = spawnSync('node', [F(m.test)], { cwd: ROOT, env, encoding: 'utf8', timeout: 900_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const summary = /通过 \d+ · 失败 \d+/.exec(out);
  const red = out.split('\n').filter((l) => /^\s*✗/.test(l));
  const hit = red.some((l) => l.includes(m.expect));
  const verdict = !summary ? 'crashed' : hit ? 'killed' : 'survived';
  return { verdict, summary: summary ? summary[0] : `（无总结行，exit ${r.status}）`, red: red.length,
    first: (red.find((l) => l.includes(m.expect)) || red[0] || '').trim().slice(0, 140),
    tail: summary ? '' : out.slice(-400) };
}

const pick = process.argv.slice(2);
const list = pick.length ? MUTANTS.filter((m) => pick.includes(m.id)) : MUTANTS;
let killed = 0;
for (const m of list) {
  const r = runOne(m);
  if (r.verdict === 'killed') killed += 1;
  const icon = { killed: '✅', crashed: '⚠️', survived: '🔴' }[r.verdict];
  console.log(`${icon} ${m.id} ${r.verdict.padEnd(8)} ${m.what}`);
  console.log(`     ${path.basename(m.test)}：${r.summary} · 红 ${r.red} 条 · 指定那条：${r.first || '（没红）'}`);
  if (r.tail) console.log(`     ${r.tail.replace(/\n/g, '\n     ')}`);
}
console.log(`\n变异 ${list.length} 个 · 被指定判据杀掉 ${killed} 个`);
process.exit(killed === list.length ? 0 : 1);
