'use strict';

/**
 * 「这次运行期间，工作区变过吗？」的那个指纹。
 *
 * ── 为什么单独成模块 ──────────────────────────────────────────────
 *   `test/run-all.js` 一 `require` 就开跑整套测试 ⇒ 函数放在那里没法导出、没法测，
 *   判据只能**复刻**它 —— 而复刻件验的是复刻件。
 *
 * ── 🔴 只哈希 porcelain 的盲区 ─────────────────────────────────────
 *   只用 `md5(git status --porcelain)` 的话，porcelain 的一行逐字是：
 *
 *       ` M test/poll-parse.test.js`
 *
 *   **里面没有任何内容字段。** ⇒ ⇒ 一个**本来就是 `M`** 的文件再改一次，
 *   porcelain 输出逐字节相同 ⇒ md5 相同 ⇒ **`during_run` 报 `false`**，
 *   而那一遍测的其实是那个文件的**旧版**。
 *   ★ 另一个「干净」的确认要是跟它共享同一个盲区，两者会互相印证，而两个都错。
 *
 * ── ✅ 修法：把**内容**也放进指纹 ───────────────────────────────────
 *       md5( `git status --porcelain`  ＋  `git diff HEAD` )
 *   · porcelain       覆盖**未跟踪**文件的出现/消失（`git diff HEAD` 看不见它们）
 *   · `git diff HEAD` 覆盖**已跟踪文件的内容**（含已暂存的）⇒ 正是漏掉的那一格
 *
 * ── 🔴 它**仍然**看不见的那一格 ─────────────────────────────────────────
 *   **未跟踪文件的「内容」变了，这个指纹抓不到。**
 *   porcelain 对它只打 `?? path`（不含内容），而 `git diff HEAD` 根本不看未跟踪文件。
 *   ⇒ 补它要去哈希未跟踪文件的内容，而那个数量不可控（`temp/`、构建产物…）
 *   ⇒ ⇒ 所以这是一条**知情的取舍**，不是遗漏。
 *
 *   ⚠️ 另一格：**一个 commit 都没有的仓库**里 `git diff HEAD` 会失败 ⇒ 返回 `null`
 *     ⇒ 而 `null` 的含义是「**查不了**」，调用方**不许**把它降级成「没变」。
 *     （只哈希 porcelain 的话那种仓库出得了数 —— 这里是**有意的**不同。）
 */

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// ★ 默认 1 MB 会让**大改动**直接超缓冲 —— 而那正是这个函数最该说话的时候。
//   超了会走 `r.error` ⇒ 返回 null（「查不了」），而不是一个**截断过的**指纹。
const MAX_BUFFER = 64 * 1024 * 1024;

function runGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  // ★ 三个条件都要：`error`（ENOBUFS / git 不在）· 非 0 退出 · stdout 不是字符串。
  //   少任何一个，一次失败都会变成空字符串 —— 而空字符串是一个**合法的「干净」指纹**。
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout;
}

/**
 * @param {string} cwd 仓库里的任意目录
 * @returns {string|null} 指纹；**查不了返回 `null`** —— 调用方不许当成「没变」
 */
function worktreeHash(cwd = process.cwd()) {
  const status = runGit(['status', '--porcelain'], cwd);
  if (status === null) return null;
  const diff = runGit(['diff', 'HEAD'], cwd);
  if (diff === null) return null;
  // ★ 中间那个 NUL 是分隔符：没有它，`status` 的结尾和 `diff` 的开头可以互相「借」
  //   字符 —— 两组不同的 (status, diff) 拼出同一个串，于是指纹相同。
  return crypto.createHash('md5').update(status + '\u0000' + diff).digest('hex');
}

module.exports = { worktreeHash, MAX_BUFFER };
