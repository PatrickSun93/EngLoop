'use strict';

/**
 * 变异跑手 —— 把 `lib/worker-pool.js` 的停止判据故意弄坏，看守卫红不红。
 *
 * ★★ 为什么要有它 ──────────────────────────────────────────────────
 * 一条**用了 `await pool.stop()`** 的断言守不住这个竞态：
 * await 会等 loop 完全退出 —— 于是「领到了但不处理」那一层根本执行不到。
 * **撤掉修复之后，那样的断言仍然全绿。**
 *
 * > ★ 一个修复有两层，测试只走了其中一层，**而那一层恰好是不需要修的那层**。
 *
 * 光靠「113 条全绿」发现不了这件事。**只有把被测的东西弄坏、看它必须红。**
 *
 * ⚠️ **磁盘上的 `lib/worker-pool.js` 一个字都不动**（结构同
 *   `rooms-flow-mutant-runner.js`）：变异后的源码用
 *   `Module._compile` 塞进 require.cache，只活在这个子进程里。
 *   **直接改文件再改回来的话，中间那几秒别人跑全量会被误伤，而且这个进程
 *   崩在中途，坏代码就留在磁盘上了。**
 *   （`lib/worker-pool.js` 在 bus 的加载链上：坏状态留在盘上时重启 bus，bus 起不来。）
 *
 * ⚠️ 放 `test/fixtures/` 下是**故意的**：`lib/queue.js` 的测试库判定是
 *   「入口路径在 test/ 下（含子目录）」，所以子进程照样连测试库、不碰 db 0。
 *
 * ── ⚠️ 一处诚实标注 ────────────────────────────────────────────────
 * 这里**内联**跑最小停止语义验证，**没有** require `test/worker.test.js`——
 * 后者 113 条要跑好几分钟，而变异测试要跑它 N 次。
 * ⇒ 下面这段断言是 `worker.test.js`【★停止语义】那三条的**同构副本**，
 *   不是同一份代码。**两边改了要一起改**（那边的注释也指回这里）。
 *
 * 用法：`node test/fixtures/worker-stop-mutant-runner.js <变异名|--list>`
 */

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const POOL = path.resolve(__dirname, '..', '..', 'lib', 'worker-pool.js');

/**
 * 每条变异写清**弄坏了什么** + **期望哪条断言接住它**。
 * `expectFail: null` = 正控，期望绿。
 */
const MUTANTS = {
  none: {
    what: '不变异（正控）',
    from: "'use strict';",
    to: "'use strict';",
    expectFail: null,
  },

  // ★★ 这一条就是那个竞态本身。撤掉它 ⇒ stop() 之后领到的消息照样被处理。
  //    没有它的话，stop() 返回之后几毫秒 runner 仍会被调用。
  'no-stop-break': {
    what: '撤掉 `if (stopped) break` —— stop() 之后领到的照样处理',
    from: '          if (stopped) break;',
    to: '          // 变异：break 被撤掉',
    expectFail: 'stop() 之后没有再处理任何消息',
  },
};

const id = process.argv[2];

// ★ 父测试从这里拿同一张表，不自己抄期望值 —— 抄的那天两边会分叉，
//   而分叉的症状是「变异测试绿着，但测的是旧判据」。
if (id === '--list') { process.stdout.write(JSON.stringify(MUTANTS)); process.exit(0); }

const m = MUTANTS[id];
if (!m) {
  console.error(`未知变异 "${id}"。可选：${Object.keys(MUTANTS).join(' / ')}`);
  process.exit(2);
}

const src = fs.readFileSync(POOL, 'utf8');

// ★★ 锚点必须存在，否则**这条变异已经失效了**。
//   少了这一步，lib/worker-pool.js 一改，替换就变成 no-op —— 跑手报告
//   「没红」，人会去查断言，而真相是变异根本没发生。
//   **一个悄悄不再变异的变异测试，比没有更坏。**
if (!src.includes(m.from)) {
  console.error(`✗ 变异锚点找不到：${JSON.stringify(m.from)}`);
  console.error('  → lib/worker-pool.js 改过了，这条变异已经失效。'
    + '把锚点更到新代码上，**不要**直接删掉它 —— 它守的判据还在。');
  process.exit(3);
}

const mutated = src.split(m.from).join(m.to);
const mod = new Module(POOL, null);
mod.filename = POOL;
mod.paths = Module._nodeModulePaths(path.dirname(POOL));
require.cache[POOL] = mod;          // 先进 cache 再编译
mod._compile(mutated, POOL);
mod.loaded = true;                  // 不设它，Module._load 会当成未完成的循环依赖

// ── 内联的最小验证（worker.test.js【★停止语义】三条的同构副本）──────
const q = require(path.resolve(__dirname, '..', '..', 'lib', 'queue'));
const { startPool } = require(POOL);

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`【变异 ${id}】${m.what}`);

(async () => {
  const redis = q.createClient();
  // ⚠️ **第二个连接**：池阻塞在 claimNext 时独占连接，共用的话 q.send 会被
  //   推迟到 5 秒后才生效 —— 那时 loop 早退出了，**这条验证就永远绿**。
  //   （这正是同一个 bug 在全量里只是偶发的原因。）
  const sender = q.createClient();
  const S = 'work:eval';
  await redis.del(S, 'orch:in:agent');

  let calls = 0;
  const pool = startPool(redis, {
    type: 'eval', concurrency: 1, onLog: () => {},
    runner: async () => { calls++; await wait(30); return { ok: true, ms: 30, output: 'S' }; },
  });
  await wait(400);                          // 让它真的进入 claimNext 的阻塞

  // 阳性对照：池活着时必须领得到（否则下面那个 0 什么都不证明）
  await q.send(sender, S, { from: 'T', text: 'alive', agent_type: 'eval', job_id: 'alive-m' });
  for (let i = 0; i < 30 && calls === 0; i++) await wait(100);
  ok(calls === 1, '阳性对照：池活着时 runner 被调用', `calls=${calls}`);

  const before = calls;
  pool.stop();                              // ★ 故意不 await —— 见文件头
  await q.send(sender, S, { from: 'T', text: 'after', agent_type: 'eval', job_id: 'after-m' });
  await wait(2000);
  ok(calls === before, 'stop() 之后没有再处理任何消息', `${before} → ${calls}`);
  ok((await redis.xlen(S)) >= 1, '那条消息还在流里（停止不等于丢活）');

  await redis.del(S, 'orch:in:agent');
  await sender.quit();
  await redis.quit();
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
