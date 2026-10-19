'use strict';

/**
 * 变异跑手 —— 把 `web/threads.js` 的判据故意弄坏，再跑 `test/threads.test.js`，
 * 看它红不红、以及**红在哪一条**。
 *
 * ★ 结构同 `rooms-flow-mutant-runner.js`。
 *   ⚠️ **磁盘上的 `web/threads.js` 一个字都不动** —— 变异后的源码用
 *   `Module._compile` 塞进 require.cache，只活在这个子进程里。
 *   （直接改文件再改回来的话，中间那几秒别人跑全量会被误伤；而且这个进程
 *     崩在中途（比如命令超时被移到后台），坏代码就留在盘上。）
 *
 * ★ 这个 runner 比 worker 那个干净一层：`threads.test.js` 是**纯函数测试、
 *   秒级跑完**，所以它 **直接 require 真测试**，不需要内联一份同构副本。
 *
 * 用法：`node test/fixtures/thread-kind-mutant-runner.js <变异名|--list>`
 */

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const THREADS = path.resolve(__dirname, '..', '..', 'web', 'threads.js');
const TARGET = path.resolve(__dirname, '..', 'threads.test.js');

/** 每条变异写清弄坏了什么 + 期望哪条断言接住它。`expectFail: null` = 正控。 */
const MUTANTS = {
  none: {
    what: '不变异（正控）',
    from: "'use strict';",
    to: "'use strict';",
    expectFail: null,
  },

  // ★★★ 两层变三层，而症状要好几轮对话才看得见
  'reply-target-self': {
    what: 'replyTargetIdOf 返回**被点的那条**而不是根 —— 两层会变三层',
    // ⚠️ 被测代码改写法时（比如 `replyTargetIdOf` 加参数），旧锚点会在源码里消失，
    //   exit(3) 会响 —— 那正好证明这个守卫没有退化成 no-op
    //   （一条悄悄不再变异的变异测试，会照样打绿勾）。
    //   改锚点时**别顺手把这条变异删掉**：它守的判据（归一到根，否则两层变三层）
    //   一个字都没变，变的只是那行代码长什么样。
    from: '    return rootIdOf(entry, byId, merges);',
    to: '    return entry.id;',
    expectFail: '回复目标是**话题 A**',
  },

  // ★★ 通知那一档没了 ⇒ agent 标的 notice 退化成普通消息
  //
  // ⚠️ 锚点选在 `KINDS` 值域上：`kindOf` 写成 `if (KINDS.includes(e.kind)) return e.kind;`，
  //   按分支选锚点（`if (e.kind === 'notice') …`）会在写法收敛时消失。
  //   锚点消失时 runner 报 `exit(3)`「变异锚点找不到」，
  //   而不是静默变成 no-op。**一条悄悄不再变异的变异测试比没有更坏** ——
  //   它照样打绿勾，而它守的那个判据早就没人守了。
  //
  // ★ 变**值域本身**，比变 kindOf 的分支更贴近真实失效模式：
  //   值域里少一个值 ⇒ 写入侧把字段丢掉 / 读取侧不认 ⇒ 那一档退化成 orphan。
  'no-notice': {
    what: 'KINDS 里去掉 notice ⇒ 标了 notice 的消息退化成 orphan',
    from: "  const KINDS = ['topic', 'reply', 'notice', 'status'];",
    to: "  const KINDS = ['topic', 'reply', 'status'];",
    expectFail: 'agent 标了 notice',
  },

  // ★★★ `lastActivityOf` 改回只认数字型 `at`
  //   ⇒ 房间历史（ISO 字符串）判不出时间 ⇒ 49 小时前的话题又赖在最近区。
  //   `threads.test.js`【16b】第一条必须红。
  'at-numeric-only': {
    what: 'lastActivityOf 的 take 改回只认数字 —— ISO 字符串的 at 判不出时间、永远不折',
    from: "      const t = e ? atMs(e.at) : null;\n      if (t !== null) times.push(t);",
    to: "      const t = e && e.at;\n      if (typeof t === 'number' && isFinite(t)) times.push(t);",
    expectFail: 'ISO 的 at：话题最新一条在 49 小时前',
  },

  // ★★★ orphan 那一档没了 ⇒ agent 没标的被当成人开的话题
  //   这一条守的是「违规必须有自己的分类」——**没有分类，渲染规则就会把它吃掉**
  'no-orphan': {
    what: "kindOf 把 orphan 也算成 topic —— 违规消息失去自己的分类",
    from: "    return e.from === HUMAN ? 'topic' : 'orphan';",
    to: "    return 'topic';",
    expectFail: 'orphan',
  },
};

const id = process.argv[2];

// ★ 父测试从这里拿同一张表，不自己抄期望值 —— 抄的那天两边会分叉。
if (id === '--list') { process.stdout.write(JSON.stringify(MUTANTS)); process.exit(0); }

const m = MUTANTS[id];
if (!m) {
  console.error(`未知变异 "${id}"。可选：${Object.keys(MUTANTS).join(' / ')}`);
  process.exit(2);
}

const src = fs.readFileSync(THREADS, 'utf8');

// ★★ 锚点必须存在，否则**这条变异已经失效了**。
//   少了这一步，web/threads.js 一改，替换就变成 no-op —— 跑手报告「没红」，
//   人会去查断言，而真相是变异根本没发生。
//   **一个悄悄不再变异的变异测试，比没有更坏。**
if (!src.includes(m.from)) {
  console.error(`✗ 变异锚点找不到：${JSON.stringify(m.from)}`);
  console.error('  → web/threads.js 改过了，这条变异已经失效。把锚点更到新代码上，'
    + '**不要**直接删掉它 —— 它守的判据还在。');
  process.exit(3);
}

const mutated = src.split(m.from).join(m.to);
const mod = new Module(THREADS, null);
mod.filename = THREADS;
mod.paths = Module._nodeModulePaths(path.dirname(THREADS));
require.cache[THREADS] = mod;          // 先进 cache 再编译
mod._compile(mutated, THREADS);
mod.loaded = true;                     // 不设它，Module._load 会当成未完成的循环依赖

console.log(`【变异 ${id}】${m.what}  → 跑 ${path.basename(TARGET)}`);
require(TARGET);
