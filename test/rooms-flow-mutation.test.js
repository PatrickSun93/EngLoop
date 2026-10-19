'use strict';

/**
 * 变异测试 —— 守着「`rooms-flow.test.js` 的那 74 条断言真的有分辨力」。
 *
 * ★★ 它回答的问题不是「代码对不对」，而是**「测试有没有用」**。
 *   把 `lib/rooms.js` 的判据故意弄坏，rooms-flow 必须红；
 *   而且必须**红在对应的那一条**上 —— 只看退出码的话，一个拼写错误
 *   也能让它红，那种红什么都没证明。
 *
 * ★ 为什么它自己是 `.test.js`（会被 run-all 跑到）：
 *   一次性跑给人看的变异验证，第二天就没人记得跑了。而分辨力**会腐化** ——
 *   有人把断言改松、或者把两个 state 合并，全绿依旧。
 *   **不被跑的检查是摆设**，所以它进 run-all。
 *
 * 单跑：`node test/rooms-flow-mutation.test.js`
 * 单看某一条变异跑起来什么样：
 *   `node test/fixtures/rooms-flow-mutant-runner.js no-normalize`
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const RUNNER = path.join(__dirname, 'fixtures', 'rooms-flow-mutant-runner.js');

// ⚠️ 跟 runner 里的 MUTANTS 表**共用同一个数据源**（问它要，不在这里抄）——
//   抄的那天两边会分叉，而分叉的症状是「变异测试绿着，但测的是旧判据」。
//   runner 跑起来会 require 整份测试，所以不能直接 require 它，走 `--list`。
const MUTANTS = (() => {
  const r = spawnSync(process.execPath, [RUNNER, '--list'], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return {}; }
})();

function run(id) {
  const r = spawnSync(process.execPath, [RUNNER, id], { encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

console.log('\n【0】变异表读得到');
const ids = Object.keys(MUTANTS);
const controls = ids.filter((id) => MUTANTS[id].expectFail === null);
const mutants = ids.filter((id) => MUTANTS[id].expectFail !== null);
ok(ids.length >= 10, `读到 ${ids.length} 条（正控 ${controls.length} · 变异 ${mutants.length}）`, ids.join(','));
ok(controls.length >= 2,
  '★ 每份被折磨的测试都有自己的正控 —— 共用一个的话，另一份的红'
  + '只能证明「注入机制没坏」，证不了它自己的断言有分辨力',
  controls.join(','));

// ── 正控先跑：注入机制本身不会让测试红 ──────────────────────────────
console.log('\n【1】★★ 正控：不变异时必须**绿**');
for (const id of controls) {
  const { status, out } = run(id);
  ok(status === 0,
    `★★ ${id}（${MUTANTS[id].what}）：同一套注入机制、不改任何判据 → 全绿。`
    + '所以下面每一条红都是**变异造成的**，不是注入把它跑坏了',
    `exit=${status}  ${out.split('\n').filter((l) => l.includes('✗')).slice(0, 3).join(' | ')}`);
  ok(/通过 \d+ · 失败 0/.test(out), `${id}：输出里失败数是 0`);
}

// ── 每条变异：必须红，而且红在指定的那条断言上 ──────────────────────
console.log('\n【2】每条变异都必须被**对应的那条断言**接住');
for (const id of mutants) {
  const m = MUTANTS[id];
  const { status, out } = run(id);

  // 3 = 锚点失效。这跟「测试没红」是两回事，必须分开报：
  // 前者说明这条变异已经不再变异任何东西了（假绿），后者说明断言不够。
  if (status === 3) {
    ok(false, `★★ 变异 ${id} 的锚点失效了 —— lib/rooms.js 改过，这条已经不再变异任何东西`,
      out.trim().split('\n').slice(0, 3).join(' | '));
    continue;
  }

  ok(status !== 0, `变异 ${id}（${m.what}）→ rooms-${m.test || 'flow'} 红了`, `exit=${status}`);

  const failedLines = out.split('\n').filter((l) => l.includes('✗'));
  ok(failedLines.some((l) => l.includes(m.expectFail)),
    `★★ 而且红在对的地方：「${m.expectFail}」`,
    failedLines.slice(0, 4).map((l) => l.trim()).join(' | ') || '(一条 ✗ 都没有)');
}

console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
