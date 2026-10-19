'use strict';

/**
 * 变异测试 —— 守着「`threads.test.js` 那些断言真的有分辨力」。
 *
 * ★ 它回答的不是「代码对不对」，是**「测试有没有用」**。
 *
 * ⚠️ 这一族里最贵的是 `reply-target-self`（回复目标退回被点的那条）：
 *   **两层变三层的症状要好几轮对话才看得见**，而那时人只会觉得
 *   「界面有点乱」，不会想到是一个函数的返回值错了。
 *   **一个要好几轮才显形的 bug，必须由一条立刻会红的断言守着。**
 *
 * ★ 为什么它自己是 `.test.js`（进 run-all）：一次性跑给人看的变异验证，
 *   第二天就没人记得跑了。而分辨力**会腐化** —— 有人把断言改松、
 *   或者把 `kindOf` 的四档合并成三档，全绿依旧。**不被跑的检查是摆设。**
 *
 * ⚠️ 磁盘上的 `web/threads.js` 全程一个字不动（见 runner 头部）。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const RUNNER = path.join(__dirname, 'fixtures', 'thread-kind-mutant-runner.js');

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
ok(ids.length >= 4, `读到 ${ids.length} 条`, ids.join(','));
ok(ids.some((id) => MUTANTS[id].expectFail === null), '★ 有正控（否则红只能证明注入机制坏了）');

console.log('\n【1】★ 正控：不变异必须**绿**');
{
  const r = run('none');
  ok(r.status === 0, '正控 none 全绿（exit 0）', `exit=${r.status}\n${r.out.slice(-400)}`);
}

console.log('\n【2】★★★ 每条变异都必须红，**而且红在它自己那一条上**');
for (const id of ids.filter((x) => MUTANTS[x].expectFail !== null)) {
  const r = run(id);
  ok(r.status !== 0, `${id} 红了`, `exit=${r.status}`);
  // ★ 只看退出码不够 —— 一个拼写错误也能让它红，那种红什么都没证明。
  const expect = MUTANTS[id].expectFail;
  const failed = (r.out.match(/^\s*✗.*$/gm) || []).join(' | ');
  ok(failed.includes(expect),
    `★★ ${id} 红在「${expect}」上，不是别处`, failed.slice(0, 200) || '(没有 ✗ 行)');
  // ★★ 变异之下**其余断言仍然大部分绿** —— 证明弄坏的是目标判据，
  //   而不是把整个模块搞瘫（那样的红什么都不证明）。
  const m = /通过 (\d+) · 失败 (\d+)/.exec(r.out);
  ok(m && Number(m[1]) > Number(m[2]) * 5,
    `★★ ${id} 只弄坏了目标那几条（通过 ${m && m[1]} · 失败 ${m && m[2]}）`,
    m ? m[0] : '(没读到总数)');
}

console.log('\n【3】★ 锚点失效要能被发现（exit 3），不能悄悄变成 no-op');
{
  const fs = require('node:fs');
  const src = fs.readFileSync(RUNNER, 'utf8');
  ok(/process\.exit\(3\)/.test(src) && /变异锚点找不到/.test(src),
    '★ runner 里有锚点检查（锚点没了 → exit 3，而不是安静地不变异）');
  ok(/不要\*\*直接删掉/.test(src), '★ 而且提示写着「别删掉这条变异，它守的判据还在」');
}

console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
