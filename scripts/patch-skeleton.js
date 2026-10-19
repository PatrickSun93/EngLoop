'use strict';

/**
 * 补丁脚本骨架（node 版）—— **可执行的实现**，而不是 `CLAUDE.md` 里那段文本。
 *
 * ── 为什么它必须是一个模块，而不是一段抄在文档里的代码 ──────────────
 *   **文本测不了** ⇒ self-test 只能**复刻**那几道逻辑
 *   ⇒ 而复刻件会跟真的分叉，**而分叉时两边各自都「正常工作」**
 *     （`lib/busy.js` 里同一个理由）
 *   ⇒ 所以「骨架要不要是一个可执行的对象」**不是偏好，是 self-test 能不能不复刻的前提**。
 *
 * ── ⚠️ 剩下的那个洞（判断型，换不掉）────────────────────────────────
 *   这些函数只有在**调用方真的 require 它们**时才起作用；凭记忆重写一遍就又成了复刻件。
 *   **一个「可执行的实现」，只有在它真的被执行时才不是复刻。**
 *   拦住这一格的只有 `agents/dev/CLAUDE.md` 里那一行「抄它，别现想」——**判断型**。
 *
 * ── 🔴 怎么 require 它 ────────────────────────────────────────────────
 *   `require` 的相对路径是相对于**调用它的那个脚本文件**，不是 cwd。
 *   ⇒ 补丁脚本通常写在 `temp/` 下 ⇒ `require('./scripts/patch-skeleton')` 会去找
 *     `temp/scripts/…` ⇒ **`MODULE_NOT_FOUND`**（fail-closed，文件一个字节没动）。
 *   ✅ **推荐写法（不依赖 cwd）**：补丁脚本写在 `temp/` 下 ⇒
 *     const S = require('../scripts/patch-skeleton');
 *     ⇒ 从任意 cwd 跑都拿得到（test/patch-skeleton.test.js【5】）
 *   ⚠️ 它的前提（唯一一个）：**这个脚本文件放在仓库的 `temp/` 下**（`..` 才是仓库根）
 *
 *   🟡 **另一个写法（依赖 cwd）**：
 *     const S = require(path.join(process.cwd(), 'scripts', 'patch-skeleton'));
 *   🔴 它有一个**前提**：**只有当 cwd 是仓库根**，这个写法才成立
 *     （test/patch-skeleton.test.js【5】：cwd 换成一个临时目录 ⇒ **MODULE_NOT_FOUND**）。
 *   ★ 别把这个前提写成一句事实（「补丁脚本总是从仓库根跑」）——
 *     **一句被写成事实的前提，不会被当成需要检查的东西。**
 *   ★ self-test 抓不到这一格：它测的是这些函数的**逻辑**，
 *     而「怎么 require 它们」发生在 self-test 之外。
 * * ── 每道检查有**名字**，引用时用名字不用编号 ──────────────────────
 *   不同文件给同一步的编号可能不同 ⇒ 说「第 ⑤ 步」会指向两件不同的事。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 【busy】动仓库文件之前**现查**。放脚本里，不单独跑 —— 单独跑 = 一张有时效的通行证。 */
function guardBusy(anyBusy) {
  // 🔴 **查不了 ⇒ 当成「有人在跑」**（fail-closed）。
  //   不包 try 的话 `anyBusy()` 抛错会直接往上冒 ⇒ 那是 fail-loud，不是 fail-closed。
  let b;
  try { b = anyBusy(); } catch (e) {
    return { ok: false, msg: `🔴 查不了 busy（${e && e.message}）⇒ 当成有人在跑（fail-closed）` };
  }
  // 【表达式】结论行是表达式的值 ＋ 【两个数】输入印在同一行
  const msg = b && b.busy
    ? `🔴 有人在跑 ${JSON.stringify(b.who)}（reason=${b.reason}）`
    : `✅ 没人在跑（reason=${b && b.reason}）`;
  return { ok: !(b && b.busy), msg };
}

/**
 * 【正控】先证明这个检查器**表达得出「没找到」**。
 *
 * 🔴 bogus 串**当场生成**，不用固定默认值：
 *   固定串写在这个文件里 ⇒ **拿骨架去改骨架自己时，那个串就存在了** ⇒ 正控报红
 *   ⇒ 而那个红是**自指**造成的，不是检查器坏了 —— 而它跟真的红长得一模一样。
 * ⇒ 当场生成的串**永远不在任何文件里** ⇒ 自指消失。
 */
function positiveControl(text, bogus) {
  const b = bogus || `__正控-不存在的锚点-${Date.now()}-${Math.random().toString(36).slice(2)}__`;
  return text.indexOf(b) === -1;
}

/**
 * 【命中数】要的是 **恰好 1 次**，不是「找得到」。
 *
 * 🔴 它**只数子串，不管行边界** —— 坑：
 *   锚点是一行 8 空格缩进的代码，而新加的一行是 **12 空格**缩进的同一句
 *   ⇒ **更深的缩进逐字包含了那个锚点** ⇒ 命中从 1 变成 2 ⇒ 判据红
 *   ⇒ 修法在**调用方**：锚点带上前后换行。⇒ 所以这里提供 `countAnchorAsLine`。
 * ⚠️ `countAnchor` 的行为**故意不变** —— 改默认会让所有现有调用的语义变，
 *   而子串命中是一个**有人在依赖**的语义，不是一个凑合的默认值。
 */
function countAnchor(text, anchor) {
  const n = text.split(anchor).length - 1;
  // ⭐ 一个**判得准**的提示（成因见上面「12 空格 vs 8 空格」）：
  //   🔴 「锚点不从行首开始就警告」**判不准**（改路径名/变量名
  //      的锚点本来就在行中间，全合法）。
  //   ✅ 判据是：**不看锚点长什么样，看两个数打不打架**。
  //      子串数 ≥ 2 而**整行**数恰好 1 ⇒ 成因只有一个：有更深缩进的同一句逐字包含了锚点。
  //   ⇒ 提示里直接给出可执行的动作；这个输入在 test/patch-skeleton.test.js 的【1b】里。
  if (n >= 2 && anchor.indexOf('\n') === -1 && countAnchorAsLine(text, anchor) === 1) {
    console.log(`  ⚠️ 子串命中 ${n} 次，而**整行**只命中 1 次 ⇒ 有更深缩进的同一句 ⇒ 改用 countAnchorAsLine(text, line)`);
  }
  return n;
}

/**
 * 【命中数·整行】把锚点当成**一整行**来数（前后各要有换行）。
 *
 * ⇒ 用它的时机：**锚点是一行代码/一行文本**（补丁脚本的常态）。
 *   而用 `countAnchor` 的时机：锚点是**一段跨行的块**，或者故意要子串匹配。
 * 🔴 它挡的正是上面那个坑：`    n = x` 不会命中 `n = x` 这一整行。
 */
function countAnchorAsLine(text, line) {
  const padded = `\n${text}\n`;                 // 首行/末行也当成有边界
  return padded.split(`\n${line}\n`).length - 1;
}

/**
 * 【重新数】多处 replace 时，在**当前串**上重数下一个锚点。
 *
 * ⚠️ 它的**独立探测力有限**：
 *   `countAnchor` 本来就在当前串上数 ⇒ 走到第二处时它自己会看见「2 处」。
 *   ⇒ 所以这一步的价值是**诊断**（提前一步 ＋ 印出成因），**不是**多一道独立防线。
 */
function recountAfterReplace(currentText, nextAnchor) {
  return countAnchor(currentText, nextAnchor);
}

/** 【staged】写盘前核三件：旧内容还在 · 新内容进去了 · **打增量字节**（统计要带分母）。 */
function verifyStaged(orig, next, mustKeep, mustGet) {
  const keep = mustKeep || [], get = mustGet || [];
  // ⭐ **参数正控** —— mustKeep / mustGet 写错（比如写了一个不存在的签名）时，
  //   结果看起来像是替换出了问题。
  //   ★ 两个方向的代价**完全不对称**，这才是它必须挂在这里的理由：
  //     mustKeep 写错（orig 里没有）⇒ 恒红 ⇒ **fail-closed**：吵，但拦得住
  //     🔴 mustGet 写错（orig 里**本来就有**）⇒ **恒绿** ⇒ **fail-open**：它一个字都没验，而全是 ✅
  //   ⇒ 所以 badGet 必须把 ok 打成 false —— 不然它就是「被占住的空位」那一族。
  const badKeep = keep.filter((s) => !orig.includes(s));   // 验不了「保留」
  const badGet  = get.filter((s) => orig.includes(s));     // 验不了「新增」⇒ fail-open
  const kept = keep.every((s) => next.includes(s));
  const got  = get.every((s) => next.includes(s));
  const delta = Buffer.byteLength(next) - Buffer.byteLength(orig);
  const argsOk = badKeep.length === 0 && badGet.length === 0;
  const argMsg = argsOk ? '' :
    ` · 🔴 参数正控：${badKeep.length ? `mustKeep 有 ${badKeep.length} 条在 orig 里不存在（恒红）` : ''}` +
    `${badKeep.length && badGet.length ? '；' : ''}` +
    `${badGet.length ? `mustGet 有 ${badGet.length} 条在 orig 里已存在（**恒绿 = fail-open**）` : ''}`;
  return { ok: kept && got && argsOk, kept, got, delta, badKeep, badGet,
    msg: `${kept ? '✅' : '🔴'} 旧内容还在 · ${got ? '✅' : '🔴'} 新内容进去了 · 增 ${delta} 字节${argMsg}` };
}

module.exports = { guardBusy, positiveControl, countAnchor, countAnchorAsLine, recountAfterReplace, verifyStaged };
