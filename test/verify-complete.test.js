'use strict';

/**
 * verify-complete —— 夹具仓库上实跑：
 *   pass 一例 · 新增一条失败 ⇒ fail · 工作树有未提交改动 ⇒ fail · claimed commit ≠ HEAD ⇒ fail ·
 *   基线就有的失败不算新增 ⇒ pass · **数目相等但换了一条失败** ⇒ fail
 * 外加：纯函数（evidence 校验、tests 命令白名单、多重集差、QA 解析）、doc / none、基线缓存、
 * 「基线的 runner 不写机器可读结果 ⇒ 借 commit 的 runner」、临时树清干净、图节点。
 *
 * 不起 bus、不连 redis（QA 在 test/verify-qa.test.js）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const V = require('../lib/verify-complete');
const { makeFixture } = require('./verify-fixture');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const brief = (r) => `${r.verdict} · missing=${JSON.stringify(r.missing).slice(0, 400)}`;
const check = (r, name) => r.checks.find((c) => c.name.startsWith(name));

async function main() {
  console.log('\nverify-complete（夹具仓库）\n');

  // ── 纯函数 ────────────────────────────────────────────────────────────────
  console.log('【0】纯函数');
  ok(V.parseTestsCommand('node test/run-all.js').argv.join(' ') === 'node test/run-all.js', 'tests: node test/run-all.js 合规');
  ok(V.parseTestsCommand('node test/run-all.js --only graph.test.js,md-paths.test.js').argv.length === 4, 'tests: 带 --only 的合规');
  for (const bad of ['npm test', 'node test/x.js; rm -rf ~', 'node ../x.js', 'node /etc/x.js', 'node test/x.js $(id)', 'node test/x.js "a b"', 'node', 'node test/x.sh']) {
    ok(Boolean(V.parseTestsCommand(bad).error), `tests 拒：${bad}`);
  }
  ok(V.validateEvidence({ kind: 'code', repo: '/x', commit: 'abc1234', tests: 'node t.js' }).ok === true, 'code evidence 齐全 ⇒ 过校验');
  ok(V.validateEvidence({ kind: 'code', repo: 'rel', commit: 'zz', tests: 'make' }).errors.length === 3, 'code evidence 三处不合规 ⇒ 三条错误');
  ok(!V.validateEvidence({ kind: 'doc', files: ['docs/x.md'] }).ok, 'doc 相对路径但没给 repo ⇒ 拒');
  ok(!V.validateEvidence({ kind: 'none' }).ok, 'none 没写 reason ⇒ 拒');
  ok(!V.validateEvidence({ kind: 'foo' }).ok && !V.validateEvidence(null).ok, '不认识的 kind / 非对象 ⇒ 拒');

  const R = (fails) => ({ schema: 'engloop-test-results/1', files: Object.entries(fails).map(([file, failures]) => ({ file, failures })) });
  const d1 = V.compareFailures(R({ 'a.test.js': ['x'] }), R({ 'a.test.js': ['y'] }));
  ok(d1.added.length === 1 && d1.added[0] === 'a.test.js :: y' && d1.removed[0] === 'a.test.js :: x', '多重集差：x→y ⇒ 新增 y、修好 x（数目相等也看得见）');
  const d2 = V.compareFailures(R({ 'a.test.js': ['x'] }), R({ 'a.test.js': ['x', 'x'] }));
  ok(d2.added.length === 1, '同一个标题基线红 1 次、这次红 2 次 ⇒ 多出来的那次算新增');
  const d3 = V.compareFailures(R({ 'a.test.js': ['x'] }), R({ 'b.test.js': ['x'] }));
  ok(d3.added.length === 1, '同标题换了文件 ⇒ 新增（按「文件 ＋ 标题」比）');
  // 要防的形状：bus-restart 那条把每次随机的端口写进了标题
  const d4 = V.compareFailures(R({ 'bus-restart.test.js': ['端口 54791 仍绑不上'] }), R({ 'bus-restart.test.js': ['端口 53526 仍绑不上'] }));
  ok(d4.added.length === 0 && d4.fuzzy.length === 1, '标题只差数字（每次随机的端口）⇒ 第二轮配上，不算新增，并且列在 fuzzy 里', JSON.stringify(d4));
  const d5 = V.compareFailures(R({ 'a.test.js': ['端口 1 仍绑不上'] }), R({ 'a.test.js': ['端口 2 仍绑不上', '端口 3 仍绑不上'] }));
  ok(d5.added.length === 1, '去数字配对也按多重集：基线 1 条、这次 2 条 ⇒ 多出来的那条照样算新增', JSON.stringify(d5));
  const d6 = V.compareFailures(R({ 'a.test.js': ['add 2+3=5'] }), R({ 'a.test.js': ['sub 5-3=2'] }));
  ok(d6.added.length === 1 && d6.fuzzy.length === 0, '去数字之后还不同的（add #+#=# vs sub #-#=#）⇒ 照样是新增');
  // 去数字只作用在**标题**上，文件名逐字比 —— 文件名里的数字不能被抹平
  const d7 = V.compareFailures(R({ 'v2.test.js': ['foo'] }), R({ 'v3.test.js': ['foo'] }));
  ok(d7.added.length === 1 && d7.added[0] === 'v3.test.js :: foo' && d7.fuzzy.length === 0,
    'v2.test.js 和 v3.test.js 标题相同也算两条（文件名逐字比，不被去数字抹平）', JSON.stringify(d7));

  // run-all 的机器可读结果：标题怎么抽（verify-complete 的「失败集合」整个建在它上面）
  const { failureTitles } = require('./run-all.js');
  const ft = failureTitles({ out: '  ✗ add 2+3=5  → got 6 at 1791\n  ✓ sub\n样本：这行里的 ✗ 不是结论\n✗ mul  → x\n', code: 1, fail: 2, reported: true, skipped: false });
  ok(ft.join('|') === 'add 2+3=5|mul', 'run-all 标题：只认行首 ✗、去掉「  → 细节」（细节里有时间戳，留着就每次都不一样）', JSON.stringify(ft));
  ok(failureTitles({ out: '  ✗ 样本\n通过 3 · 失败 0', code: 0, fail: 0, reported: true, skipped: false }).length === 0, 'run-all 标题：过了的文件不报失败（输出里的 ✗ 是内容）');
  ok(/没报出总数/.test(failureTitles({ out: 'boom', code: 1, fail: 0, reported: false, skipped: false })[0]), 'run-all 标题：没报出总数 ⇒ 一条合成标题（不是空数组 = 「没有失败」）');

  const qa = V.parseQaOutput('先说格式：QA 1: PASS — 示例\n…\nQA 1: FAIL — 实际 exit 1\nQA 2: PASS — 跑了 node t.js，输出 ok\n**QA 3**: PASS', 4);
  ok(qa.items[0].verdict === 'FAIL', 'QA 解析：同一编号取最后一次（开头复述的格式不算）');
  ok(qa.items[1].verdict === 'PASS' && qa.items[2].verdict === 'NO_EVIDENCE' && qa.items[3].verdict === 'MISSING' && !qa.ok,
    'QA 解析：PASS 有证据算过 · PASS 没证据不算 · 没回的编号 MISSING', JSON.stringify(qa.items));

  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-vcache-'));
  // ★ code 型核验要把测试关进 sandbox-exec（返工 1）。这个测试文件自己跑在一个限制性 sandbox 里时
  //   （「核验 EngLoop 自己」：它在核验的 sandbox 里），第二层套不上 ⇒ 核验如实报 unverifiable ——
  //   那不是被测代码的回退，是装置的限制。⇒ 这一段**跳过并说出来**，不让它红成一条假的「新增失败」。
  if (!require('../lib/sandbox-profile').available()) {
    console.log('\n  ⚠ 跳过【1】【2】（code 型核验）：sandbox-exec 在这里套不上（多半是这个进程本身已经在 sandbox 里）');
  } else {
  // ── 夹具：main 全绿 ──────────────────────────────────────────────────────
  const fx = makeFixture();
  const opts = { cacheRoot: cache, testsTimeoutMs: 60_000 };
  const ev = (commit) => ({ kind: 'code', repo: fx.repo, commit, tests: 'node test/run.js' });
  try {
    console.log('\n【1】六种情况');
    // ① pass
    fx.branch('ok');
    fx.write('lib/extra.js', 'exports.x = 1;\n');
    const c1 = fx.commit('无害改动');
    const r1 = await V.verify(ev(c1), opts);
    ok(r1.verdict === 'pass', '① 无害改动 ⇒ pass', brief(r1));
    ok(/基线自己的 runner|0 过|失败/.test(JSON.stringify(r1.checks)) && check(r1, '失败集合跟基线比不新增').ok, '① 失败集合检查项在、且是绿的');

    // ② 新增一条失败
    fx.branch('newfail');
    fx.setBroken({ mul: true });
    const c2 = fx.commit('弄坏 mul');
    const r2 = await V.verify(ev(c2), opts);
    ok(r2.verdict === 'fail', '② 新增一条失败 ⇒ fail', brief(r2));
    ok(r2.missing.some((m) => m.includes('math.test.js :: mul 2*3=6')), '② missing 里点名了那一条（文件 :: 标题）', JSON.stringify(r2.missing));
    ok(check(r2, '基线 ').detail.includes('缓存命中'), '② 基线走了缓存（①已经跑过 merge-base）', check(r2, '基线 ').detail);

    // ③ 工作树有未提交改动
    fx.branch('dirty');
    const c3 = fx.commit('空提交');
    fx.write('lib/math.js', `${fs.readFileSync(path.join(fx.repo, 'lib/math.js'), 'utf8')}// 没提交的一行\n`);
    const r3 = await V.verify(ev(c3), opts);
    ok(r3.verdict === 'fail' && check(r3, '工作树干净') && !check(r3, '工作树干净').ok, '③ 工作树有未提交改动 ⇒ fail（工作树干净 ✗）', brief(r3));
    ok(!check(r3, '在 '), '③ 脏树不往下跑测试（「你交的不是你测的」）');
    fx.git(['checkout', '--', '.']);

    // ④ claimed commit ≠ HEAD
    fx.branch('nothead');
    const c4a = fx.commit('第一笔');
    fx.commit('第二笔');
    const r4 = await V.verify(ev(c4a), opts);
    ok(r4.verdict === 'fail' && !check(r4, 'commit 是 repo 当前的 HEAD').ok, '④ claimed commit ≠ HEAD ⇒ fail', brief(r4));
    const r4b = await V.verify(ev('deadbeef'), opts);
    ok(r4b.verdict === 'fail' && !check(r4b, 'commit 存在').ok, '④′ commit 根本不存在 ⇒ fail');
  } finally {
    fx.cleanup();
  }

  // ── 夹具：main 上 add 就是红的 ────────────────────────────────────────────
  const fx2 = makeFixture(os.tmpdir(), { broken: { add: true } });
  const ev2 = (commit) => ({ kind: 'code', repo: fx2.repo, commit, tests: 'node test/run.js' });
  try {
    // ⑤ 基线就有的失败不算新增
    fx2.branch('keep');
    fx2.write('lib/extra.js', 'exports.x = 2;\n');
    fx2.setBroken({ add: true });
    const c5 = fx2.commit('add 照旧是红的');
    const r5 = await V.verify(ev2(c5), opts);
    ok(r5.verdict === 'pass', '⑤ 基线就有的失败（add）不算新增 ⇒ pass', brief(r5));
    ok(/基线 1 条失败、这次 1 条/.test(check(r5, '失败集合').detail), '⑤ 检查项写明两边各 1 条', check(r5, '失败集合').detail);

    // ⑥ 数目相等但换了一条失败
    fx2.branch('swap');
    fx2.setBroken({ sub: true });     // 修好 add、弄坏 sub ⇒ 失败数 1 → 1
    const c6 = fx2.commit('修好 add、弄坏 sub');
    const r6 = await V.verify(ev2(c6), opts);
    ok(r6.verdict === 'fail', '⑥ 数目相等但换了一条失败 ⇒ fail', brief(r6));
    ok(/基线 1 种 · 这次 1 种/.test(check(r6, '失败集合').detail) && /sub 5-3=2/.test(check(r6, '失败集合').detail),
      '⑥ 两边都是 1 条，新增的是 sub 那条', check(r6, '失败集合').detail);
    ok(fx2.worktrees() === 1, '临时树都清掉了（git worktree list 只剩主树）', String(fx2.worktrees()));
  } finally {
    fx2.cleanup();
  }

  // ── 基线的 runner 不写机器可读结果 ⇒ 借 commit 的 runner ─────────────────────
  console.log('\n【2】基线 runner 是老版本');
  const fx3 = makeFixture(os.tmpdir(), { oldRunner: true });
  try {
    fx3.branch('newrunner');
    fx3.useNewRunner();
    const c7 = fx3.commit('runner 学会写机器可读结果');
    const r7 = await V.verify({ kind: 'code', repo: fx3.repo, commit: c7, tests: 'node test/run.js' }, { ...opts, cacheRoot: path.join(cache, 'fresh') });   // 新的缓存根：基线必须真跑一遍（不能命中上面的缓存）
    ok(r7.verdict === 'pass' && /借 commit 的 runner/.test(JSON.stringify(r7.checks)), '基线的 runner 没写结果 ⇒ 借 commit 那一版重跑基线 ⇒ pass', brief(r7));
    // 阴性对照：commit 上的 runner 也不写 ⇒ fail（不是 pass）
    fx3.branch('stillold');
    fx3.write('lib/extra.js', 'exports.y = 1;\n');
    const c8 = fx3.commit('runner 还是老的');
    const r8 = await V.verify({ kind: 'code', repo: fx3.repo, commit: c8, tests: 'node test/run.js' }, opts);
    ok(r8.verdict === 'fail' && r8.missing.some((m) => m.includes('没有读到机器可读结果')), '阴性对照：commit 的 runner 也不写结果 ⇒ fail，不是「没读到失败 = 没有失败」', brief(r8));
  } finally {
    fx3.cleanup();
  }
  }   // ← sandbox 可用才跑的那一段

  // ── doc / none ────────────────────────────────────────────────────────────
  console.log('\n【3】doc / none');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-vdoc-'));
  fs.mkdirSync(path.join(dd, 'docs'));
  fs.writeFileSync(path.join(dd, 'docs', 'x.md'), '# x\n\n## 结论\n做完了。\n');
  fs.writeFileSync(path.join(dd, 'docs', 'empty.md'), '   \n');
  fs.writeFileSync(path.join(dd, 'docs', 'hollow.md'), '# y\n\n## 结论\n\n## 别的\n正文\n');
  const rd1 = await V.verify({ kind: 'doc', repo: dd, files: ['docs/x.md'], requires: ['## 结论'] });
  ok(rd1.verdict === 'pass', 'doc：文件在、小节在且有正文 ⇒ pass', brief(rd1));
  const rd2 = await V.verify({ kind: 'doc', repo: dd, files: ['docs/x.md', 'docs/missing.md'], requires: ['## 结论'] });
  ok(rd2.verdict === 'fail' && rd2.missing.some((m) => m.includes('missing.md')), 'doc：有一个文件不在 ⇒ fail', brief(rd2));
  const rd3 = await V.verify({ kind: 'doc', repo: dd, files: ['docs/empty.md'] });
  ok(rd3.verdict === 'fail', 'doc：文件只有空白 ⇒ fail', brief(rd3));
  const rd4 = await V.verify({ kind: 'doc', repo: dd, files: [path.join(dd, 'docs', 'hollow.md')], requires: ['## 结论'] });
  ok(rd4.verdict === 'fail' && /有标题、下面一行正文都没有/.test(rd4.missing.join()), 'doc：小节只有标题没有正文 ⇒ fail（stageGate 的判据）', brief(rd4));
  const rn = await V.verify({ kind: 'none', reason: '回答一个问题' });
  ok(rn.verdict === 'unverifiable' && rn.checks.some((c) => c.detail === '回答一个问题'), 'none ⇒ unverifiable，原样带 reason');
  const rbad = await V.verify({ kind: 'code', repo: dd, commit: 'abc1234', tests: 'bash -c x' });
  ok(rbad.verdict === 'fail' && /tests/.test(rbad.missing[0]), 'tests 不合规 ⇒ fail（不跑）');

  // ── 图节点 ────────────────────────────────────────────────────────────────
  console.log('\n【4】任务图节点（defaultVerify）');
  const gd = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-vgraph-'));
  fs.writeFileSync(path.join(gd, 'PLAN.json'), JSON.stringify({ nodes: [{ id: 'a', produces: 'a/OUT.md', requires: ['## 结论'] }] }));
  fs.mkdirSync(path.join(gd, 'a'));
  fs.writeFileSync(path.join(gd, 'a', 'OUT.md'), '## 结论\n好\n');
  const rg1 = await V.verifyGraphNode(gd, 'a', { graphsRoot: path.dirname(gd) });
  ok(rg1.verdict === 'pass', '节点产出齐、没有 EVIDENCE.json ⇒ pass（只核了产出）', brief(rg1));
  fs.writeFileSync(path.join(gd, 'a', 'EVIDENCE.json'), JSON.stringify({ kind: 'doc', files: [path.join(gd, 'nope.md')] }));
  const rg2 = await V.verifyGraphNode(gd, 'a', { graphsRoot: path.dirname(gd) });
  ok(rg2.verdict === 'fail' && rg2.missing.some((m) => m.startsWith('evidence ·')), '节点带的 EVIDENCE.json 没过 ⇒ fail', brief(rg2));
  const rg3 = await V.verifyGraphNode(gd, 'a', { graphsRoot: path.join(os.tmpdir(), 'somewhere-else') });
  ok(rg3.verdict === 'fail', '图目录不在 graphsRoot 下 ⇒ fail');
  const dv = V.graphDefaultVerify({ root: '/R' });
  const cmd = dv({ id: 'a' }, { dir: "/g/x'; touch /tmp/pwned; '" });
  ok(cmd.includes(`'/g/x'\\''; touch /tmp/pwned; '\\'''`) && cmd.includes("'--graph-node'") === false && cmd.includes('--graph-node'),
    'defaultVerify：图目录（来自 redis）被单引号转义，夹带的 shell 不会执行', cmd);
  ok(dv({ id: 'A;x' }, { dir: '/g' }) === null, 'defaultVerify：节点 id 不合规 ⇒ 不给命令');

  fs.rmSync(cache, { recursive: true, force: true });
  fs.rmSync(dd, { recursive: true, force: true });
  fs.rmSync(gd, { recursive: true, force: true });
}

main()
  .catch((e) => { fail++; console.log(`  ✗ 测试本身崩了：${e.stack}`); })
  .finally(() => {
    console.log(`\n通过 ${pass} · 失败 ${fail}`);
    process.exit(fail ? 1 : 0);
  });
