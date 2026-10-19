'use strict';

/**
 * 模板类型自动发现 —— 回答「**现在真正能起哪些类型**」。
 *
 * ── 为什么需要它：别拿能力表冒充可用类型 ──────────────────────────
 *
 *   lib/worker-pool.js   ` 可选：${Object.keys(CAPABILITIES).join(' / ')}。`
 *   bin/agent-start.js   `  可选: ${Object.keys(CAPABILITIES).join(' / ')}`
 *
 * 那样写把两件不是一回事的东西混了：
 *   · `CAPABILITIES` 说的是**这个类型该有什么能力**（6 个）
 *   · `templates/` 下有没有目录决定**它起不起得来**（2 个）
 *
 * **于是用户会被告知可以起 `solve`，实际起会抛「没有模板目录」。**
 * 「可选」这个词说的是能力表，而能真正起来的是**两者的交集**。
 *
 * ⚠️ 这跟 `agent-capabilities.js` 是不是单一数据源无关 —— 它仍然是能力的
 *   唯一出处，这里**不重新声明任何能力**，只做交叉核对。**"有哪些类型"
 *   和"每个类型有什么能力"是两个问题，前者没有自己的出处，就会被后者顶替。**
 *
 * ── ★ fail-closed：这个模块最不能出的错 ──────────────────────────
 * 「一个模板都没有」是一个**完全合法的答案**。所以读不到目录时**绝不能
 * 返回空数组** —— 调用方分不清「真的没有」和「发现机制坏了」，
 * 而它会照着空列表告诉用户「可选：」后面什么都没有。
 *
 * 同一个坑的形状（`lib/tmux.js` 的 `list()` 也会这样让 watchdog 误判健康的 agent）：
 * **命令失败 → 返回空数组 → 上层理解成「没有会话」→ 一个合法的答案。**
 * 所以这里一律**抛**，跟 `provision()` 读不到模板目录时的姿态保持一致。
 * ────────────────────────────────────────────────────────────────
 */

const fs = require('node:fs');
const path = require('node:path');
const { CAPABILITIES } = require('./agent-capabilities');

const TPL_ROOT = path.join(__dirname, '..', 'templates');

/**
 * ── ★ 多根目录 ───────────────────────────────────────────────────
 *
 * 模板不只在本仓库：外部平台的角色定义在**它自己的仓库**里。
 * 不支持多根的话，那些目录得长在 EngLoop 仓库里，
 * **而且每接一个平台就长一批。**
 *
 * ★★ **为什么是多根目录，不是「一个根目录放软链」**（理由三条）：
 *   1. **软链会把 realpath 那个坑引到这条路上** —— macOS 上外置盘的挂载路径
 *      本身可能是符号链接（`lib/docs.js` 为此要对根目录做 realpath）
 *   2. **git 里看不出软链指向哪** —— 换台机器就断，而断的样子是
 *      「模板找不到」，跟「这个角色不存在」同形
 *   3. **多根是显式配置，可以被测试断言**；软链是文件系统层的隐式依赖
 *
 * 配置：`ENGLOOP_TEMPLATE_ROOTS`，用 `path.delimiter` 分隔（跟 PATH 一样）。
 * 没设 = 只有本仓库的 `templates/`（跟以前完全一样）。
 */
const ROOTS_ENV = 'ENGLOOP_TEMPLATE_ROOTS';

function defaultRoots(env = process.env) {
  const raw = env[ROOTS_ENV];
  if (!raw || !String(raw).trim()) return [TPL_ROOT];
  const list = String(raw).split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [TPL_ROOT];
}

/**
 * 把各种入参归一成一个根目录数组。
 *
 * `templatesDir`（单个）保留：它是老参数，一堆测试在用。
 * **不删它** —— 删掉等于让「为了可测」的入参变成一次破坏性变更。
 */
function resolveRoots({ templatesDir, roots, env } = {}) {
  if (roots !== undefined) return [].concat(roots);
  if (templatesDir !== undefined) return [templatesDir];
  return defaultRoots(env);
}

/**
 * 一个模板目录要"数得上"，得真有东西可下发。
 *
 * 判据跟 `provision()` 对齐（它对空目录抛「模板目录是空的」）——
 * **发现说它可用、下发却抛异常，是最难查的一类不一致**：两边各自都"对"。
 */
function hasContent(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * 扫所有模板根目录，跟能力表交叉核对。
 *
 * @param {object} [opts]
 * @param {string}   [opts.templatesDir] 单个根目录（老参数，保留）
 * @param {string[]} [opts.roots]        多个根目录
 * @returns {{
 *   usable: string[],            两边都齐 —— **这才是"可选类型"**
 *   missingTemplate: string[],   能力表有、模板没有 → 起它会抛
 *   missingCapability: string[], 模板有、能力表没有 → 起它会被 isKnownType 拒
 *   empty: string[],             有目录但目录是空的 → provision 会抛
 *   roots: string[],             实际扫了哪些根
 *   dirOf: Record<string,string> 每个类型来自哪个根（provision 要用它）
 *   conflicts: Array<{name,chosen,shadowed}>  同名类型在多个根里都有
 *   unreadableRoots: Array<{root,error}>      读不到的根
 * }}
 * @throws **所有**根都读不到、或加起来一个子目录都没有。见文件头的 fail-closed。
 */
function discoverTypes(opts = {}) {
  const roots = resolveRoots(opts);
  const dirOf = {};          // 类型名 → 它来自哪个根（先声明的赢）
  const conflicts = [];
  const unreadableRoots = [];

  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      // ★ 单个根读不到**不致命**：多根的典型用法是「本仓库 + 一个外部平台仓库」，
      //   而那个外部仓库可能没克隆。但**绝不静默** —— 见下面 unreadableRoots。
      unreadableRoots.push({ root, error: String(err.message) });
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (dirOf[e.name] === undefined) { dirOf[e.name] = root; continue; }
      // ★★ 同名冲突：**先声明的赢**，但必须说出来。
      //   不报错的理由：一个无关的重名不该让整个模板发现挂掉。
      //   必须可见的理由：**选错的后果是一个 agent 用了别人的定义在跑，
      //   而它看起来完全正常。**
      //   进返回值而不是只打日志 —— bus 是 detached 起的，那个 console 没人看。
      conflicts.push({ name: e.name, chosen: dirOf[e.name], shadowed: root });
    }
  }

  // ★ 所有根都读不到 = 部署坏了。**一个都没读到时才抛** ——
  //   有一个读到了就还能给出一份（不完整但真实的）答案，而缺的那些在
  //   `unreadableRoots` 里说着。
  if (unreadableRoots.length === roots.length) {
    throw new Error(`模板根目录全都读不到：${
      unreadableRoots.map((u) => `${u.root}（${u.error}）`).join('；')}`);
  }

  const dirs = Object.keys(dirOf).sort();
  if (dirs.length === 0) {
    throw new Error(`模板根目录里一个类型目录都没有：${roots.join(path.delimiter)}`);
  }

  const known = Object.keys(CAPABILITIES);
  const empty = dirs.filter((t) => !hasContent(path.join(dirOf[t], t)));
  const nonEmpty = dirs.filter((t) => !empty.includes(t));

  return {
    usable: nonEmpty.filter((t) => known.includes(t)),
    missingTemplate: known.filter((t) => !dirs.includes(t)).sort(),
    missingCapability: dirs.filter((t) => !known.includes(t)),
    empty,
    roots,
    // ★ 每个类型来自哪个根 —— **provision 需要它**，否则它不知道去哪拷。
    dirOf,
    conflicts,
    unreadableRoots,
  };
}

/**
 * 一个类型的模板目录在哪。**多根之后 provision 不能再自己拼路径。**
 *
 * @returns {string|null} 绝对路径；没有这个类型 → null
 */
function templateDirFor(type, opts = {}) {
  let d;
  try { d = discoverTypes(opts); } catch (_) { return null; }
  return d.dirOf[type] ? path.join(d.dirOf[type], type) : null;
}

/**
 * 给人看的那一行 —— **两处「可选：」提示都该用它**，而不是
 * `Object.keys(CAPABILITIES).join(' / ')`。
 *
 * ★ 不一致时**顺带说出来**：一个列在能力表里却起不来的类型，
 *   沉默地从提示里消失，比根本没提过更难查 —— 人会以为自己记错了类型名。
 */
function usableTypesHint(opts) {
  const d = discoverTypes(opts);
  const parts = [d.usable.join(' / ')];
  if (d.missingTemplate.length) {
    parts.push(`（能力表里有但缺模板、起不来：${d.missingTemplate.join(' / ')}）`);
  }
  if (d.missingCapability.length) {
    parts.push(`（有模板但能力表没登记、会被拒：${d.missingCapability.join(' / ')}）`);
  }
  // ★ 读不到的根要说出来：少了一个根，某些类型会**静默地不在列表里** ——
  //   而「这个类型不存在」和「放它的那个仓库没克隆」是两件事。
  if (d.unreadableRoots.length) {
    parts.push(`（⚠ ${d.unreadableRoots.length} 个模板根读不到：${
      d.unreadableRoots.map((u) => u.root).join(' / ')}，那里的类型这次都不在上面）`);
  }
  // ★ 冲突同样要说：同名类型来自哪个根，决定了那个 agent 拿到谁的定义。
  if (d.conflicts.length) {
    parts.push(`（⚠ 同名模板：${d.conflicts.map((c) => `${c.name} 用 ${c.chosen} 的，忽略了 ${c.shadowed}`).join('；')}）`);
  }
  return parts.join(' ');
}

/**
 * 给**错误处理路径**用的那一层：**永不抛。**
 *
 * ── 为什么必须有这个，而不是让调用方自己 try ─────────────────────
 * 两处调用点（`bin/agent-start.js` / `lib/worker-pool.js`）都在**报错分支里**
 * ——「用户已经打错类型名了」之后才执行到。这时候提示行要是抛异常：
 *
 *     ✗ 抛了: 模板根目录读不到（…）：ENOENT: no such file or directory …
 *
 * **这条异常会把原本那句「✗ 不认识的 agent 类型 "xxx"」整个盖掉。**
 * 用户打错了一个类型名，得到的却是一条关于模板目录的 ENOENT ——
 * **他会去查模板目录，而问题在他的命令行里。**
 *
 * > **一条「帮你把错误说清楚」的提示，失败时把错误本身弄没了。**
 *
 * 契约定死在这里而不是靠每个调用方记得 try：**靠记得的防线，
 * 在第三个调用方出现时就破了。**（`worker-pool` 那处就是同一个形状。）
 *
 * ── ★ 降级文案的红线 ─────────────────────────────────────────────
 * **绝不退回 `Object.keys(CAPABILITIES)`。** 那正是这个模块要替掉的东西：
 * 读不到 `templates/` 的时候退回去，用户会看到一份「6 个都能起」的清单，
 * **而那一刻一个都起不来 —— 比不提示还糟。**
 * **坏掉时说「说不出来」，不要说一个错的。**
 *
 * ⚠️ `usableTypesHint()` 保持 fail-closed（该抛就抛）—— 它是给**知道自己
 *   在干什么**的调用方用的。**两个函数、两种契约，别合并。**
 */
function safeHint(opts) {
  try {
    return usableTypesHint(opts);
  } catch (err) {
    // 连 String(err) 都可能抛（自定义 toString）。**永不抛**就是永不抛。
    let why;
    try { why = String(err && err.message ? err.message : err); } catch (_) { why = '未知错误'; }
    return `（列不出可用类型：${why}）`;
  }
}

module.exports = {
  discoverTypes, usableTypesHint, safeHint, templateDirFor,
  TPL_ROOT, ROOTS_ENV, defaultRoots, resolveRoots,
};
