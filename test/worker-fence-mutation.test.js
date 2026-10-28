'use strict';

/**
 * 变异测试 —— 守着「`worker-fence.test.js` 那些断言真的有分辨力」。
 *
 * 每条变异把 `lib/worker-pool.js` 的 fence 弄坏一处（只在子进程的内存里，见那个文件头），
 * 断言：① 子进程红（exit 1）② **红在变异表写的那几条上** ③ 前提断言仍然绿 ——
 *   否则红可能只是「池整个瘫了」，什么都不证明。
 * 正控 `none` 必须全绿。
 *
 * ★ 为什么它自己是 `.test.js`：分辨力会腐化 —— 有人把 fence 挪到 send 后面，
 *   `worker-fence.test.js` 也许照样绿；只有这里会说「那条变异没被接住」。
 *
 * ⚠️ 子进程**并发跑，上限 4**：每个子进程约 1 分钟（池的 BLOCK 5000 让每次写入最多排 5 秒），
 *   串行 8 条要 8 分钟。每个子进程各抢一个测试库（1–15），4 个留足余量给同时在跑的别的测试。
 */

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const TEST = path.join(__dirname, 'worker-fence.test.js');
const PARALLEL = 4;

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

// 跟被测文件共用同一张表（问它要，不在这里抄）—— 抄的那天两边会分叉。
const MUTANTS = (() => {
  const r = spawnSync(process.execPath, [TEST, '--list'], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return {}; }
})();

function run(id) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [TEST, '--mutant', id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 240_000);
    c.on('close', (status) => { clearTimeout(t); resolve({ id, status, out }); });
  });
}

async function main() {
  console.log('\n【0】变异表读得到');
  const ids = Object.keys(MUTANTS);
  ok(ids.length >= 5, `读到 ${ids.length} 条`, ids.join(','));
  ok(ids.some((id) => MUTANTS[id].expectFail === null), '★ 有正控（否则红只能证明注入机制坏了）');

  const results = {};
  const queue = [...ids];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (queue.length) { const id = queue.shift(); results[id] = await run(id); }
  }));

  for (const id of ids) {
    const m = MUTANTS[id];
    const r = results[id];
    const failed = (r.out.match(/^\s*✗.*$/gm) || []);
    console.log(`\n【${id}】${m.what}`);
    // 全部红行照打 —— 变异表只写了「至少这几条」，实际红了哪些要看得见。
    for (const l of failed) console.log(`      红: ${l.trim().replace(/^✗\s*/, '').split('  → ')[0]}`);
    if (m.expectFail === null) {
      ok(r.status === 0, `正控 ${id} 全绿（exit 0）`, `exit=${r.status}\n${r.out.slice(-1500)}`);
      continue;
    }
    ok(r.status === 1, `${id} 红了（exit 1）`, `exit=${r.status}\n${r.out.slice(-1500)}`);
    for (const want of m.expectFail) {
      ok(failed.some((l) => l.includes(want)), `★★ 红在「${want}」上`, failed.join(' | ') || '(没有 ✗ 行)');
    }
    // ★ 前提断言（「（前提）…」）在变异下仍然绿 —— 变异只弄坏了目标判据，不是把场景搭不起来。
    ok(!failed.some((l) => l.includes('（前提）')), '★ 前提断言仍然绿（场景搭起来了，红的是判据）',
      failed.filter((l) => l.includes('（前提）')).join(' | '));
  }

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
