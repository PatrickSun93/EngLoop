'use strict';

/**
 * **探测器常量化变异** —— 找「恒假类」判据的机械查法。
 *
 * ── 为什么是变异，而不是扫源码 ────────────────────────────────────────
 *   扫测试源码的做法（「一条断言『没有』的判据，有没有一条断言『有』的」）
 *   抓不到恒假类缺陷：比如一个探测器被改成恒 `false` 而**整个套件全绿**，
 *   那种形状不是「有一条断言没对照」，
 *   是**一整类输入从来没有被喂进去**（该有的那份夹具**从来没有被建出来**）。
 *   ⇒ 而一个**没被建出来的夹具，在源码里不留任何字符** ⇒ **没有东西可以扫**。
 *
 *   ★ 推论比这个工具适用面宽：**凡是「检查源码里有没有 X」的工具，
 *     都答不了「有没有一整类东西从来没被写下来」。**
 *   ⇒ 碰得到它的是变异：**不看写了什么，看改了之后有没有判据红。**
 *
 * ── 档位（区分它们是为了堵**假阴性**）──────────────────────────────────
 *   ✅ **被判据杀掉**：比基线多出至少一条 `✗` ⇒ 真的有判据分辨出返回值变了
 *   ⚠️ **崩了（不算）**：非零退出/抛异常，而**没有多出任何一条 `✗`**
 *      ⇒ 恒 `false` 让下游走进一个没准备的分支 ⇒ 红的是一次崩溃，不是一条判据
 *      🔴 只分「红/不红」两档的话，会把它划进「安全」 ⇒ **工具报安全，而实际不安全**
 *   🔴 **活下来**：跟基线**逐字相同** ⇒ 这个探测器**没有任何有分辨力的判据**
 *   ✂️ **分母缩了**：这一次执行到的判据比基线少 ⇒ 判档不可信
 *   ❓ **判不了**：其余 —— **说出口，别硬塞进前几档之一**
 *
 *   拿一个已知恒假的历史版本回放：基线和变异后的结果逐字相同 ⇒ 判档 `survived`，
 *   这正是恒假缺陷的定义。
 *
 * ── 射程边界，跟读数一起报 ────────────────────────────────────────────
 *   · 只跑**同名的**那个测试文件（`lib/foo.js` ⇒ `test/foo.test.js`）⇒ **快，但会误报**：
 *     判据写在别的文件里时，变异会「活下来」而其实有对照。
 *     ✅ 所以这一轮出的是**候选**；`--full` 只对候选跑全量（准，而成本被候选数除过一遍）。
 *   · 它只答「有没有判据红」。**一个探测器可能有判据、而那条判据验的是别的性质** —— 它答不了。
 *   · 判档按**失败判据的集合差**算，不按条数（条数相同而集合不同 ⇒ `unclear`，
 *     而进/出的 label 都会印出来）；并且**先看分母**（这一次执行到了多少条）——
 *     少跑了一批时，`✗` 怎么变都不可信。不这么做的话，
 *     **两个洞都朝假阴性**：它们会让工具**报安全**。
 *
 * 用法：
 *   node scripts/mutate-detectors.js                 # 全扫（同名测试文件）
 *   node scripts/mutate-detectors.js lib/provision.js  # 只扫一个模块
 *   node scripts/mutate-detectors.js --full          # 候选改跑全量复核
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'lib');
const HOOK = path.join(__dirname, '_mutate-hook.js');

/** 名字像探测器的（回布尔/可空的那一类） */
const NAME_RE = /^(is|has|can|should|claims|check|find|detect|match|looks|contains|any|was|are)[A-Z_]/;

/** 从一个模块的源码里挑出「探测器」—— 名字像 ＋ 源码里真的 `return true/false/null` */
function detectorsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  let mod;
  try { mod = require(file); } catch { return []; }
  const out = [];
  for (const [name, val] of Object.entries(mod || {})) {
    if (typeof val !== 'function') continue;
    const body = String(val);
    const boolish = /return\s+(true|false|null)\b/.test(body)
      || /return\s+!!/.test(body) || /return\s+[^;]*\s(===|!==|>=|<=)\s/.test(body);
    if (NAME_RE.test(name) || boolish) out.push(name);
  }
  return out.sort();
}

/**
 * 跑一次测试，回 { code, failSet, ran, out }。
 *
 * 🔴 **只看失败条数不够用** —— 有两个洞，而两个都朝**假阴性**：
 *   ① **集合**：一个变异完全做得到「杀掉一条 ✗ 的同时救活另一条」
 *      ⇒ **条数不动，集合全变** ⇒ 而按条数判会判成 `survived` ⇒ **报安全**
 *      ★「4 == 4」是一个数量，而「红的是同一 4 条」是一个集合。
 *   ② **分母**：变异让进程崩在第 3 条上，而崩之前恰好有 1 条 ✗
 *      ⇒ ✗ 变多 ⇒ 判 `killed` ⇒ **报「有对照」，而后面的判据根本没执行**
 *      ⇒ 所以要读「**这一次执行到了多少条**」（通过 ＋ 失败）——
 *        它不是「一共有多少条判据」，是这一次真的跑到的分母。
 */
function runTest(testFile, env) {
  const r = spawnSync('node', [testFile], {
    cwd: ROOT, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, ...env },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const failSet = new Set();
  let ran = 0;
  for (const line of out.split('\n')) {
    const m = /^\s*([✓✗])\s?(.*)$/.exec(line);
    if (!m) continue;
    ran++;
    if (m[1] === '✗') failSet.add(m[2].trim().slice(0, 160));
  }
  return { code: r.status, failSet, ran, out };
}

const diff = (a, b) => [...a].filter((x) => !b.has(x));

/**
 * 判档 —— 而**一切都按「跟基线的差」算**，不按绝对值。
 *
 * 🔴 为什么不能写成 `if (mut.code !== 0) return 'crashed'`：
 *   基线本身可能就是红的（比如有几条判据已经在失败、退出码 1），
 *   变异后结果**逐字相同**、退出码也是 1 —— 真相是「活下来」，
 *   而按绝对值会判成「崩了（不算）」。
 *   ★ **一个绝对值判据，会把「继承自基线的红」读成「这次变异造成的红」。**
 *
 * ⇒ 判不了的时候**说出「这一轮判不了」**，不是硬塞进别的档：
 */
function classify(base, mut) {
  // 🔴 **分母先判** —— 少跑了一批的话，✗ 怎么变都不可信
  if (mut.ran < base.ran) return 'truncated';
  const gained = diff(mut.failSet, base.failSet);
  const lost = diff(base.failSet, mut.failSet);
  if (gained.length && !lost.length) return 'killed';        // 真多出来了具体哪几条
  if (!gained.length && !lost.length && mut.code === base.code) return 'survived';
  if (!gained.length && !lost.length && base.code === 0 && mut.code !== 0) return 'crashed';
  return 'unclear';   // 含「条数相同而集合不同」—— 那一档比 survived 有意思得多
}

function main() {
  const args = process.argv.slice(2);
  const only = args.find((a) => !a.startsWith('--'));
  const files = only ? [path.join(ROOT, only)]
    : fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).map((f) => path.join(LIB, f));

  const rows = [];
  let noTest = 0;
  for (const file of files) {
    const base = path.basename(file, '.js');
    const testFile = path.join(ROOT, 'test', `${base}.test.js`);
    const dets = detectorsOf(file);
    if (!dets.length) continue;
    if (!fs.existsSync(testFile)) { noTest += dets.length; continue; }

    const baseline = runTest(testFile, {});
    for (const fn of dets) {
      for (const value of ['false', 'true']) {
        const mut = runTest(testFile, {
          ENGLOOP_MUT_FILE: file, ENGLOOP_MUT_FN: fn, ENGLOOP_MUT_VALUE: value,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${HOOK}`.trim(),
        });
        rows.push({
          mod: `lib/${base}.js`, fn, value,
          verdict: classify(baseline, mut),
          baseRed: baseline.code !== 0 || baseline.failSet.size > 0,
          ran: `${mut.ran}/${baseline.ran}`,
          gained: diff(mut.failSet, baseline.failSet),
          lost: diff(baseline.failSet, mut.failSet),
        });
      }
    }
  }

  const by = (v) => rows.filter((r) => r.verdict === v);
  const baselineRed = rows.filter((r) => r.baseRed).length;
  console.log(`\n📊 变异 ${rows.length} 次 · ${new Set(rows.map((r) => r.mod + r.fn)).size} 个探测器`);
  console.log(`   ✅ 被判据杀掉  ${by('killed').length}`);
  console.log(`   ⚠️ 崩了（不算）${by('crashed').length}   ← 红的是崩溃，不是判据`);
  console.log(`   🔴 活下来      ${by('survived').length}   ← **候选**，不是结论`);
  console.log(`   ❓ 判不了（unclear） ${by('unclear').length}   ← 含「条数相同而**集合不同**」`);
  console.log(`   ✂️ 分母缩了（truncated）${by('truncated').length}   ← 少跑了一批，`
    + '✗ 怎么变都不可信');
  console.log(`   ⬜ 没有同名测试文件、这一轮压根没测的探测器：${noTest} 个`);
  if (baselineRed) {
    console.log(`   ⚠️ 而其中 ${baselineRed} 次的**基线本来就是红的** —— `
      + '那些行的判档只说明「跟基线比没变化」，不说明测试是好的');
  }
  console.log('');

  for (const v of ['survived', 'truncated', 'unclear', 'crashed']) {
    const list = by(v);
    if (!list.length) continue;
    console.log({ survived: '🔴 活下来的变异（候选）：', crashed: '⚠️ 崩了的（红的是崩溃，不是判据）：',
      unclear: '❓ 判不了的（进/出的判据都列在下面）：',
      truncated: '✂️ 分母缩了的（少跑了一批 ⇒ 这一次的判档不可信）：' }[v]);
    for (const r of list) {
      console.log(`  · ${r.mod}  ${r.fn}() ⇒ 恒 ${r.value}   执行到 ${r.ran} 条`);
      // ★ `unclear` 那一档必须把**进和出**都印出来，否则它跟 `survived` 在输出里没区别
      if (r.gained.length) console.log(`      ＋红：${r.gained.slice(0, 3).join(' / ')}`);
      if (r.lost.length) console.log(`      －红：${r.lost.slice(0, 3).join(' / ')}`);
    }
    console.log('');
  }
  return by('survived').length;
}

if (require.main === module) main();
module.exports = { detectorsOf, classify };
