'use strict';

/**
 * `--require` 钩子：在**编译前**把某个文件源码里的一段字面量换掉 —— 源码级变异，一个字节都不落盘。
 *
 *   `ENGLOOP_SRCMUT` = JSON `{ "file": "<绝对路径>", "from": "<原文>", "to": "<替换成>" }`（或这样的数组）
 *
 * ── 跟 `_mutate-hook.js` 的区别 ──────────────────────────────────────────
 *   那个换的是**导出函数的返回值**（「探测器永远回同一个值」）；
 *   这个换的是**一行代码**（「这一行没写」）—— 用来验 bus 里的路由中间件、
 *   payload 里的一个展开这类**不是导出函数**的东西。
 *
 * ★ 走 `NODE_OPTIONS=--require=…` 传给子进程：bus、poller、agent-start 都是 spawn 出来的，
 *   变异必须跟着进它们，否则「测试进程里变了、bus 里没变」⇒ 判据恒绿。
 *
 * 🔴 `from` 在源码里找不到 ⇒ **抛**（进程起不来，判据会红在「起不来」上）——
 *   而不是静默不变异：那样会表现成「变异活下来了」，把一个写错的变异误读成一条没用的判据。
 *   ⇒ 驱动脚本（`scripts/mutate-bus-auth.js`）要求**红的是指定的那条**，不是随便红。
 */

const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// ★ 也收**数组**：有的变异要同时改两处才成立 ——
//   比如「调度器把派过的活记在进程内存里」= 派活时记一笔 ＋ 每 tick 查这条记录。
//   单个对象的写法照旧（`scripts/mutate-bus-auth.js` 用的就是它）。
const raw = process.env.ENGLOOP_SRCMUT ? JSON.parse(process.env.ENGLOOP_SRCMUT) : null;
const specs = (Array.isArray(raw) ? raw : (raw ? [raw] : [])).filter((s) => s && s.file);
if (specs.length) {
  const orig = Module.prototype._compile;
  Module.prototype._compile = function srcmutCompile(content, filename) {
    for (const spec of specs) {
      if (real(filename) !== real(path.resolve(spec.file))) continue;
      if (!content.includes(spec.from)) {
        throw new Error(`[srcmut] ${filename} 里找不到要变异的原文：${JSON.stringify(spec.from).slice(0, 120)}`);
      }
      content = content.split(spec.from).join(spec.to);
    }
    return orig.call(this, content, filename);
  };
}
