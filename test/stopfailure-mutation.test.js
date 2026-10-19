'use strict';

/**
 * StopFailure 信号的变异测试 —— 守着「stop-failure-hook / watchdog-stopfailure 那些断言真的有分辨力」
 * （变异表在 preload 里，见下）。
 *
 *   每条变异：`node -r test/fixtures/e15-mutant-preload.js <测试文件>`，环境变量 E15_MUTANT=<id>。
 *   变异**只在内存里**（preload 把变异版塞进 require.cache），磁盘上的 lib/ 一个字不动 ——
 *   所以它不需要工作区静止，也不会在被打断时留下一份坏代码。
 *
 * ★ 判据：① 正控（不变异、同样带 preload）两个文件都绿；② 每条变异至少一个文件红，
 *   **而且红在它自己那条断言上**（只看退出码的话，一个拼写错误也能让它红）。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => (c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`)));

const PRELOAD = path.join(__dirname, 'fixtures', 'e15-mutant-preload.js');
const FILES = ['stop-failure-hook.test.js', 'watchdog-stopfailure.test.js'];

// 跟 preload **共用同一张表**（问它要，不在这里抄）
const MUTANTS = (() => {
  const r = spawnSync(process.execPath, [PRELOAD, '--list'], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return {}; }
})();

function run(id) {
  const env = { ...process.env };
  delete env.E15_MUTANT;
  if (id) env.E15_MUTANT = id;
  return FILES.map((f) => {
    const r = spawnSync(process.execPath, ['-r', PRELOAD, path.join(__dirname, f)], { encoding: 'utf8', env, timeout: 120_000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    return { file: f, status: r.status, out, failed: (out.match(/^\s*✗.*$/gm) || []).map((l) => l.trim()) };
  });
}

console.log('\n【0】变异表读得到');
const ids = Object.keys(MUTANTS);
ok(ids.length === 6, `读到 ${ids.length} 条（变异表应有 6 条）`, ids.join(','));

console.log('\n【1】★ 正控：带 preload、不变异 ⇒ 两个文件都绿');
for (const r of run(null)) {
  ok(r.status === 0, `正控 ${r.file} exit 0`, `exit=${r.status}\n${r.out.slice(-400)}`);
}

console.log('\n【2】★★★ 每条变异都必须红，而且红在它自己那条上');
for (const id of ids) {
  const rs = run(id);
  const injected = rs.every((r) => r.status !== 3);
  ok(injected, `${id}：变异注入成功（锚点在）`, rs.map((r) => `${r.file}=${r.status}`).join(' '));
  const red = rs.filter((r) => r.status !== 0);
  ok(red.length > 0, `${id}：红了（${red.map((r) => r.file).join(', ') || '没有'}）`);
  const all = rs.flatMap((r) => r.failed);
  const expect = MUTANTS[id].expectFail;
  ok(all.some((l) => l.includes(expect)), `★★ ${id} 红在「${expect}」上`, all.join(' | ').slice(0, 300) || '(没有 ✗ 行)');
  console.log(`      （被杀死的断言：${all.length} 条 —— ${all.map((l) => l.replace(/^✗\s*/, '').slice(0, 40)).join(' / ').slice(0, 240)}）`);
}

console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
