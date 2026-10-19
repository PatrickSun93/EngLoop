'use strict';

/**
 * `scripts/patch-skeleton.js` 的 self-test —— 每道检查**喂一个「它应该抓住」的输入**。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────
 *   骨架里那几道检查，在日常使用中真的会响的只有**正控**那一道。
 *   `【命中数】` 只要补丁的锚点**都恰好命中 1 次**就永远不会红。
 *   ⇒ ⇒ **「一个从没响过的防护，没有证据说它会响。」**
 *
 * ── 🔴 它**不**守什么（不写这一格，它会被读成「骨架被判据守着」）──────
 *   它守的是 `scripts/patch-skeleton.js` 里那些函数的**逻辑**。
 *   它**不**守「下次写补丁时真的 require 了它们」—— 那一格是**判断型**的，
 *   而拦住它的只有 agent 引导文件里那一行「抄它，别现想」。
 *   ⇒ ⇒ 这个洞的另一面：模板是可 `cp` 的文件，也可能**一次都没被 cp 过**（全是凭记忆重写）。
 *
 * 单跑：`node test/patch-skeleton.test.js`
 */

const S = require('../scripts/patch-skeleton');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

function main() {
  console.log('\n【1】🔴 【命中数】—— 锚点必须恰好命中 1 处，0 处和多处都要红');
  {
    const t = 'aaa BBB aaa BBB aaa';
    // ★ 三个方向都要，因为「恰好 1 次」的**两侧**都是错的，而只验一侧会漏一半
    ok(S.countAnchor(t, '找不到的锚点') === 0, '★ 0 处 ⇒ 返回 0（而调用方要求 === 1 ⇒ 红）');
    ok(S.countAnchor(t, 'BBB') === 2, '★★ **2 处** ⇒ 返回 2 —— 这一侧最容易被漏掉');
    ok(S.countAnchor(t, ' BBB aaa BBB') === 1, '★ 恰好 1 处 ⇒ 返回 1（阴性对照：它不是恒非 1）');
  }

  console.log('\n【1b】🔴 【命中数·整行】—— 更深缩进的同一句会被子串计数多数一次');
  {
    // 形状：判据锚点是一行 **8 空格**缩进的代码，而新加的一行是 **12 空格**缩进的同一句
    // ⇒ ⇒ 更深的缩进**逐字包含**那个锚点 ⇒ 命中从 1 变成 2 ⇒ 判据双双红
    const src = 'head\n        n = src.count(old)\n            n = src.count(old)\ntail';
    const line = '        n = src.count(old)';
    // 🔴 对照（这一条**故意断言旧行为**）：`countAnchor`（子串）在同一输入上命中 **2** 次
    ok(S.countAnchor(src, line) === 2,
      '★★ 对照：`countAnchor`（子串）命中 **2** 次 —— 子串计数的判据在这里会红',
      String(S.countAnchor(src, line)));
    ok(S.countAnchorAsLine(src, line) === 1,
      '★★ 而 `countAnchorAsLine`（整行）命中 **1** 次 ⇒ 更深的缩进不再命中');
    ok(S.countAnchorAsLine(src, '不存在的一行') === 0, '★ 阴性对照：不存在的行 ⇒ 0（它不是恒 1）');
    ok(S.countAnchorAsLine('只有一行', '只有一行') === 1, '★ 首行/末行也算有边界 ⇒ 1');
  }

  console.log('\n【2】【正控】它必须表达得出「没找到」');
  {
    ok(S.positiveControl('随便什么内容') === true, '★ 不含那个 bogus 串 ⇒ true');
    // 🔴 阴性对照：**把 bogus 串真的放进去** ⇒ 必须 false
    //   缺了这条，`positiveControl` 写成 `return true` 也全绿。
    // 🔴 bogus 串**显式传**（骨架里那个默认值已经改成当场生成 —— 见 `positiveControl` 的注释）
    ok(S.positiveControl('前面 XYZ-BOGUS 后面', 'XYZ-BOGUS') === false,
      '★★ 阴性对照：内容里真有那个串 ⇒ **false**（否则它可以恒真）');
    // 🔴 而**当场生成**那一支也要验：不传 bogus ⇒ 任何内容都该 true（串永远不在文件里）
    ok(S.positiveControl('随便什么内容，甚至含旧的默认串：这一行在文件里不存在-正控') === true,
      '★★ 不传 bogus ⇒ **每次现生成** ⇒ 连旧默认串在内容里也不影响（自指消失）');
  }

  console.log('\n【3】【staged】三件都要，而**缺哪一件哪一件恒真**');
  {
    const orig = 'keep1 keep2 old';          // 15 字节
    const next = 'keep1 keep2 NEWNEW';       // 18 字节 ⇒ 期望 delta = **3**（手写，不重算）
    const r = S.verifyStaged(orig, next, ['keep1', 'keep2'], ['NEW']);
    // 🔴 不能写成 `r.delta === Buffer.byteLength(next) - Buffer.byteLength(orig)`
    //   ⇒ ⇒ 那是**用被测对象的算法重算一遍期望值** ⇒ **恒真**（两串等长时 delta 还恰好是 0）
    //   ★ 期望值必须来自被测对象**之外** —— 这里是手写的 3。
    ok(r.ok === true && r.delta === 3,
      `★ 正常：旧的在、新的进去了、增量 = 3 字节（**手写的期望值**）`, JSON.stringify(r));
    // 🔴 旧内容丢了 ⇒ 必须 false（这一格正是「部分写入」和「整段被覆盖」的形状）
    ok(S.verifyStaged(orig, 'NEW only', ['keep1', 'keep2'], ['NEW']).ok === false,
      '★★ 旧内容丢了 ⇒ **false**（整段被覆盖 / 部分写入的形状）');
    // 🔴 新内容没进去 ⇒ 必须 false（锚点没命中而 replace 静默无操作，就是这个样子）
    ok(S.verifyStaged(orig, orig, ['keep1'], ['NEW']).ok === false,
      '★★ 新内容没进去 ⇒ **false**（replace 静默没换，长这样）');
  }

  console.log('\n【3b】🔴 【staged·参数正控】—— 两个方向代价不对称');
  {
    const o = 'AAA 保留 BBB', n = 'AAA 保留 BBB 新增 CCC';
    // ① 正常参数：不误报（阴性对照 —— 没有它，argsOk 可以恒 false 而判据全绿）
    const good = S.verifyStaged(o, n, ['保留'], ['新增']);
    ok(good.ok === true && good.badKeep.length === 0 && good.badGet.length === 0,
      '★ 阴性对照：参数正常 ⇒ 不报参数问题', JSON.stringify({ k: good.badKeep, g: good.badGet }));
    // ② mustKeep 指向 orig 里不存在的串 ⇒ 它验不了任何东西（恒红，fail-closed）
    const bk = S.verifyStaged(o, n, ['orig里没有这个串'], ['新增']);
    ok(bk.ok === false && bk.badKeep.length === 1,
      '★★ mustKeep 在 orig 里不存在 ⇒ 报出来（否则只会看到「旧内容没了」，去修一个没坏的东西）');
    // 🔴 ③ mustGet 指向 orig 里**已有**的串 ⇒ got 恒真 ⇒ **fail-open 那一半**，必须打成 false
    const bg = S.verifyStaged(o, n, ['保留'], ['保留']);
    ok(bg.got === true && bg.ok === false && bg.badGet.length === 1,
      '★★★ mustGet 在 orig 里已存在 ⇒ got **恒真**而 ok 必须 false',
      JSON.stringify({ got: bg.got, ok: bg.ok }));
  }

  console.log('\n【5】🔴 【cwd】—— 文件头那个 require 写法，有一个【前提】而不是一句事实');
  {
    const os = require('os'), cp = require('child_process');
    const fs = require('fs'), path = require('path');   // 🔴 顶层没有它们 —— `node --check` 检不出这个
    const R = process.cwd();
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skel-cwd-'));
    const run2 = (file) => {
      try { return cp.execFileSync(process.execPath, [file], { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { return String(e.stderr || e.message); }
    };
    const run = (code) => {
      try { return { out: cp.execFileSync(process.execPath, ['-e', code], { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: null }; }
      catch (e) { return { out: '', err: String(e.stderr || e.message) }; }
    };
    // ✅ 绝对路径：从任何 cwd 都拿得到
    const a = run(`const S=require(${JSON.stringify(path.join(R, 'scripts', 'patch-skeleton'))});process.stdout.write(typeof S.countAnchor)`);
    ok(a.out === 'function', '★★ 绝对路径写法从**别的 cwd** require ⇒ 拿得到 countAnchor', a.out || a.err);
    // 🔴 阴性对照①：`process.cwd()` 写法在**非仓库根**必须失败 —— 这条证明那个前提是真的
    const b = run("const p=require('path');require(p.join(process.cwd(),'scripts','patch-skeleton'))");
    ok(/MODULE_NOT_FOUND/.test(b.err || ''), '★★★ `process.cwd()` 写法在非仓库根 ⇒ **必须 MODULE_NOT_FOUND**（前提为真的证据）');
    // 🔴 阴性对照②：相对写法 —— 最容易栽的那个
    const c = run("require('./scripts/patch-skeleton')");
    ok(/MODULE_NOT_FOUND/.test(c.err || ''), '★ 阴性对照：`./scripts/…` 相对写法必须失败（相对的是 cwd，不是文件）');
    // 🔴 而文档本身也要被钉住：那个前提必须**写成条件**，不能写成事实
    const hdr = fs.readFileSync(path.join(R, 'scripts', 'patch-skeleton.js'), 'utf8').slice(0, 4000);
    ok(hdr.includes('只有当 cwd 是仓库根'),
      '★★ 文件头把它写成【前提】而不是事实（否则读的人不会去检查它）');
    // ⭐ **存在一个不依赖 cwd 的写法**：
    //   `require('./scripts/…')` 从 `temp/` 跑 ⇒ 找 `temp/scripts/` ⇒ 404
    //   🔴 而把它换成 `process.cwd()` 写法，只是换成了一个带隐含前提的解
    //   ⇒ ⇒ 这个测试文件自己用的 `require('../scripts/patch-skeleton')` 才是不依赖 cwd 的那个
    //   ★ **别用一个更复杂、带前提的解，去绕过一个一个字符的错误。**
    {
      const probe = path.join(R, 'temp', `__cwd-probe-${process.pid}.js`);
      fs.writeFileSync(probe, "const S=require('../scripts/patch-skeleton');process.stdout.write(typeof S.countAnchor)");
      const d = run2(probe);
      ok(d === 'function',
        '★★★ `require(\'../scripts/…\')` 从 `temp/` 出发 ⇒ **从别的 cwd 也成立**（相对的是【文件】不是 cwd）', d);
      fs.rmSync(probe, { force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n【4】【busy】fail-closed —— 而「查不了」必须当成「有人在跑」');
  {
    ok(S.guardBusy(() => ({ busy: false, reason: 'all_stale' })).ok === true, '★ 没人在跑 ⇒ 放行');
    const r = S.guardBusy(() => ({ busy: true, reason: 'running', who: ['JARVIS'] }));
    ok(r.ok === false, '★★ 有人在跑 ⇒ **拦住**');
    // ★ 结论行里必须带**输入**（reason），否则一个恒真的结论没有东西戳穿它
    ok(/reason=running/.test(r.msg) && /JARVIS/.test(r.msg),
      '★★ 而结论里印着**输入**（reason ＋ who）—— 假绿要靠它才看得出来',
      r.msg);
    // 🔴 **查不了 ⇒ 必须当成「有人在跑」** —— fail-closed 不能只写在标题里，
    //   实现和判据里都要有它。（标题 / 实现 / 判据三处都要说那件事。）
    const rt = S.guardBusy(() => { throw new Error('redis 连不上'); });
    ok(rt.ok === false && /fail-closed/.test(rt.msg),
      '★★ `anyBusy()` 抛错 ⇒ **拦住**（fail-closed），而不是往上冒', rt.msg);
  }

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
