'use strict';

/**
 * `--require` 钩子：把某个模块的某个导出函数换成一个**常量函数**。
 *
 *   `ENGLOOP_MUT_FILE`  目标模块的绝对路径
 *   `ENGLOOP_MUT_FN`    要换掉的导出名
 *   `ENGLOOP_MUT_VALUE` `'true'` / `'false'` / `'null'`
 *
 * ⚠️ **它在内存里换，一个字节都不落盘** —— 变异测试如果落盘，
 *   它会跟「工作区必须静止」直接打架，而那一条是这个仓库的地基。
 *
 * 🔴 而它换在 `Module._load` 之后：模块**照常执行**（副作用照旧），
 *   只是那个导出被替换。⇒ 于是变异的语义是「**这个探测器永远回同一个值**」，
 *   而不是「这个模块坏了」—— 后者会把三档里的「崩了」那一档撑爆。
 */

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

/**
 * 路径比对**必须走 realpath**。
 *
 * 🔴 macOS 的 `os.tmpdir()` 回 `/var/folders/…`，而它是 `/private/var/folders/…` 的**符号链接**；
 *   而 `Module._resolveFilename` 回的是 **realpath** ⇒ 两边字符串不等 ⇒ **变异静默失效**。
 * ★ 它在扫 `lib/` 时**不会露** —— 仓库路径没有符号链接。
 *   ⇒ **这个缺陷只在「调用方用了另一种路径形式」时出现**，比如
 *     `test/mutate-detectors.test.js` 里的临时目录。
 */
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

const FILE = process.env.ENGLOOP_MUT_FILE;
const FN = process.env.ENGLOOP_MUT_FN;
const RAW = process.env.ENGLOOP_MUT_VALUE;

if (FILE && FN) {
  const target = real(path.resolve(FILE));
  const value = RAW === 'true' ? true : RAW === 'null' ? null : false;
  const orig = Module._load;
  Module._load = function mutLoad(request, parent, isMain) {
    const m = orig.apply(this, arguments);
    try {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent, isMain); } catch { /* 内建模块 */ }
      if (resolved && real(resolved) === target && m && typeof m[FN] === 'function') {
        // ★ 只换一次的语义：每次 require 都换，因为 require 缓存会把同一个对象发回来
        m[FN] = () => value;
      }
    } catch { /* 换不上就当没变异 —— 而那会表现成「活下来」，是**安全**的方向 */ }
    return m;
  };
}
