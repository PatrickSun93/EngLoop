'use strict';

/**
 * 把 lib/ 下每个模块真的 require 一遍。手动工具，不是测试（文件名不带
 * .test.js，run-all 不跑它）。
 *
 *   node test/load-all.js
 *
 * ── 为什么需要它：`node --check` 的实际含义比它的名字窄 ──────────
 * `node --check x.js` 检查的是**这一个文件本身能不能被解析**。
 * 它**不碰 x.js require 的任何东西**。
 *
 * 例：一个 lib 模块的块注释里写了一个含 `*​/` 的路径，
 * 提前结束了注释、整个文件语法坏掉。而
 *   `node --check test/eval-template.test.js`  → 通过
 * 因为那个测试文件自己没毛病，坏的是它 require 的模块。直到真的加载才炸。
 *
 * 「工具做了它承诺的事，而以为它承诺的更多」—— 同一个形状还有
 * `redis-cli keys | wc -l` 把空结果的那个换行数成 1。
 *
 * ⚠️ 只 require `lib/`，**不碰 `bin/`** —— bin 下的脚本被 require 时会
 *    执行 main()，可能读 argv、起 tmux 会话。测试不该有那种副作用。
 *    （`bin/agent-start.js` 加了 require.main 守卫，是例外，但这里不特殊照顾它，
 *      免得下一个没加守卫的 bin 脚本被顺手加进来。）
 */

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).sort();

let ok = 0;
const broken = [];

for (const f of files) {
  const full = path.join(LIB, f);
  try {
    require(full);
    ok++;
    console.log(`  ✓ ${f}`);
  } catch (err) {
    broken.push({ f, err });
    console.log(`  ✗ ${f}  → ${err.message.split('\n')[0]}`);
  }
}

console.log(`\n${'─'.repeat(46)}\n  能加载 ${ok} / ${files.length}`);
if (broken.length) {
  console.log('\n坏掉的模块的完整报错：');
  for (const b of broken) console.log(`\n── ${b.f} ──\n${b.err.stack}`);
}
process.exit(broken.length === 0 ? 0 : 1);
