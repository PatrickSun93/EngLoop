'use strict';

/**
 * 依赖链探针 —— 回答「跑这个测试的时候，**到底加载了**哪些 lib 模块」。
 *
 * ★★ 它存在的理由是取证：一个测试红了，而改过的文件按 grep 看**不在**
 *   它的依赖链里。「grep 不到」是间接证据（漏一个动态 require 就塌了）；
 *   **require.cache 是直接证据** —— 那个模块的代码到底有没有进过这个进程。
 *
 * ⚠️ 只看得见**主进程**。测试 spawn 出去的子进程各有自己的 cache，
 *   要看那些得在子进程里再挂一个。**这个限制必须说出来**，
 *   否则「探针说没加载」会被当成比它实际更强的证据。
 *
 * 放在 `test/fixtures/` 下：queue.js 的测试库判定是「入口在 test/ 下含子目录」，
 * 所以被探的测试照常连测试库（见 queue.js 里那条判定的注释）。
 *
 * 用法：`node test/fixtures/require-probe.js mutual-isolation.test.js lib/rooms.js`
 *       第二个参数可省，省了就列出所有加载过的 lib/ 模块。
 */

const path = require('node:path');

const target = path.resolve(__dirname, '..', process.argv[2] || '');
const want = process.argv[3] || null;
const ROOT = path.resolve(__dirname, '..', '..');

process.on('exit', () => {
  const libs = Object.keys(require.cache)
    .filter((k) => k.startsWith(path.join(ROOT, 'lib') + path.sep))
    .map((k) => path.relative(ROOT, k))
    .sort();
  // 走 stderr：被探的测试 process.exit 之后 stdout 可能已经被它自己的收尾刷过了，
  // 而且这样探针的话跟测试的输出不会混在一起被 grep 误捡。
  console.error(`\n[探针] ${path.basename(target)} 主进程加载过的 lib 模块：`);
  console.error(`  ${libs.join('\n  ') || '(一个都没有)'}`);
  if (want) {
    const hit = libs.includes(want);
    console.error(`[探针] ${want} 被加载了吗：${hit ? '是' : '否'}`);
  }
  console.error('[探针] ⚠️ 只覆盖主进程 —— 测试 spawn 的子进程有自己的 cache。');
});

require(target);
