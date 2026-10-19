'use strict';

/**
 * 变异测试 —— 守着「`worker.test.js`【★停止语义】那几条真的有分辨力」。
 *
 * ★★ 它回答的不是「代码对不对」，而是**「那几条断言有没有用」**。
 *
 * 例：这个竞态的断言要是用 `await pool.stop()`，
 * 而 await 会等 loop 完全退出 —— 「领到了但不处理」那一层根本执行不到。
 * **撤掉修复之后，那条断言仍然全绿。**
 * > ★ 一个修复有两层，测试只走了其中一层，**而那一层恰好是不需要修的那层**。
 * 光靠「全绿」发现不了它。只有把被测的东西弄坏、看它必须红。
 *
 * ★ 为什么它自己是 `.test.js`（会被 run-all 跑到）：一次性跑给人看的验证，
 *   第二天就没人记得跑了。而**分辨力会腐化** —— 有人把 `pool.stop()` 改回
 *   `await pool.stop()`，全绿依旧。**不被跑的检查是摆设。**
 *
 * ⚠️ 磁盘上的 `lib/worker-pool.js` 全程一个字不动（见 runner 头部）。
 *
 * 单跑：`node test/worker-stop-mutation.test.js`
 * 看某条变异跑起来什么样：`node test/fixtures/worker-stop-mutant-runner.js no-stop-break`
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const RUNNER = path.join(__dirname, 'fixtures', 'worker-stop-mutant-runner.js');

// ⚠️ 跟 runner **共用同一张表**（问它要，不在这里抄）——
//   抄的那天两边会分叉，症状是「变异测试绿着，但测的是旧判据」。
const MUTANTS = (() => {
  const r = spawnSync(process.execPath, [RUNNER, '--list'], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return {}; }
})();

const run = (id) => {
  const r = spawnSync(process.execPath, [RUNNER, id], { encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

console.log('\n【0】变异表读得到');
const ids = Object.keys(MUTANTS);
ok(ids.length >= 2, `读到 ${ids.length} 条`, ids.join(','));
ok(ids.some((id) => MUTANTS[id].expectFail === null), '★ 有正控（否则红只能证明注入机制坏了）');

console.log('\n【1】★ 正控：不变异必须**绿**');
{
  const r = run('none');
  ok(r.status === 0, '正控 none 全绿（exit 0）', `exit=${r.status}\n${r.out}`);
  ok(/阳性对照：池活着时 runner 被调用/.test(r.out) && /✓ 阳性对照/.test(r.out),
    '★ 而且它的阳性对照本身是绿的 —— 注入机制没把别的弄坏');
}

console.log('\n【2】★★★ 撤掉 `if (stopped) break` 必须**红，且红在对应那一条**');
{
  const id = 'no-stop-break';
  const r = run(id);
  ok(r.status === 1, `${id} 红了（exit 1）`, `exit=${r.status}\n${r.out}`);
  // ★ 只看退出码不够 —— 一个拼写错误也能让它红，那种红什么都没证明。
  const expect = MUTANTS[id].expectFail;
  const failedLines = (r.out.match(/^\s*✗.*$/gm) || []).join(' | ');
  ok(failedLines.includes(expect),
    `★★ 红在「${expect}」这一条上，不是别处`, failedLines || '(没有 ✗ 行)');
  // ★★ 阳性对照在变异下**仍然绿** —— 证明变异只弄坏了目标那一处，
  //   而不是把整个池搞瘫（那样的红什么都不证明）。
  ok(/✓ 阳性对照/.test(r.out),
    '★★ 变异之下阳性对照仍然绿 —— 弄坏的只是目标判据，不是整个池');
}

console.log('\n【3】★ 锚点失效要能被发现（exit 3），不能悄悄变成 no-op');
{
  // 一个必然找不到的锚点：直接问 runner 要一个不存在的变异名 → exit 2；
  // 锚点那条走的是 exit 3，靠 runner 里的 `src.includes` 守着。
  // 这里守的是**那段代码存在**，因为它没法在不改 lib 的前提下触发。
  const fs = require('node:fs');
  const src = fs.readFileSync(RUNNER, 'utf8');
  ok(/process\.exit\(3\)/.test(src) && /变异锚点找不到/.test(src),
    '★ runner 里有锚点检查（锚点没了 → exit 3，而不是安静地不变异）');
  ok(/不要\*\*直接删掉/.test(src) || /不要.*删掉/.test(src),
    '★ 而且提示写着「别删掉这条变异，它守的判据还在」');
}

console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
