'use strict';

/**
 * `scripts/mutate-detectors.js` —— **探测器常量化变异**，找「恒假类」判据的机械查法。
 *
 * ── 为什么这个文件存在 ──────────────────────────────────────────────
 *   那个工具本身是一个**检查器**，而
 *   **一个从没响过的防护，没有证据说它会响。** ⇒ 所以它自己也要有判据。
 *   而这里验的是它的**判定逻辑**（`classify` / `detectorsOf` / 内存变异钩子），
 *   不是它扫全仓的那次运行 —— 那次要五分钟，不该进全量。
 *
 * ── 🔴 `classify` 为什么是四档，不是两档 ─────────────────────────────────
 *   ① 只有两档（killed / survived）的话有**假阴性**：
 *     恒 `false` 让下游崩在半路 ⇒ `✗` 变多 ⇒ 判「killed」⇒ **报安全，而后面的断言没跑**
 *   ② `crashed` 不能写成 `if (mut.code !== 0)`：
 *     测试文件的**基线本身就红**（退出码 1）时，变异后还是 1 ⇒ 判「崩了」
 *     ⇒ ⇒ 而真相是 **`survived`**（变异后跟基线逐字相同）。
 *     ★ **一个绝对值判据，会把「继承自基线的红」读成「这次变异造成的红」。**
 *   ③ 所以**按跟基线的差**算，并且**分母先判**（`ran < base.ran` ⇒ `truncated`）。
 *   ⇒ ⇒ 不分档的话，「分母缩了」的那些变异会被大量报成「杀掉」—— 那些「杀掉」是假的。
 *
 * 单跑：`node test/mutate-detectors.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { detectorsOf, classify } = require('../scripts/mutate-detectors');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-mutdet-'));

console.log('\n【1】`classify` 的四档 —— 而三档是被真实读数逼出来的');

const S = (...xs) => new Set(xs);

// ── 🔴 ①档：一次真实回放的读数（44 通过 / 4 失败 · 退出码 1，两边逐字相同）──
//   `if (mut.code !== 0) return 'crashed'` 的写法在这个输入上返回 `crashed` ——
//   ⇒ ⇒ 它会把一次真正的「恒假活下来」划进「判不了」那一堆。
const incidentBase = { ran: 48, failSet: S('a', 'b', 'c', 'd'), code: 1 };
const incidentMut = { ran: 48, failSet: S('a', 'b', 'c', 'd'), code: 1 };
ok(classify(incidentBase, incidentMut) === 'survived',
  '【1-1】🔴 ★★ **①档**：基线本身就红（44/4 · 退出码 1），变异后逐字相同 ⇒ **`survived`** —— '
  + '那正是「恒假活下来」的定义（`claimsIdentity` 恒 false ⇒ 一条都不红）',
  classify(incidentBase, incidentMut));

// ── 🔴 分母先判：真实读数 `lib/rooms.js post() ⇒ 执行到 8/92 条` ────────────
//   两档制会看到「✗ 变多了」⇒ 判 `killed` ⇒ **报安全**；而后面 84 条根本没跑。
ok(classify({ ran: 92, failSet: S(), code: 0 },
  { ran: 8, failSet: S('异常: Cannot read properties of undefined'), code: 1 }) === 'truncated',
  '【1-2】🔴 ★★ **分母先判**：`8/92` ＋ ✗ 变多 ⇒ **`truncated`**，不是 `killed` —— '
  + '两档制会把这一档全报成「杀掉」',
  classify({ ran: 92, failSet: S(), code: 0 },
    { ran: 8, failSet: S('x'), code: 1 }));

// ── 阴性对照：真的被杀掉的那种，必须判 `killed` ─────────────────────────
//   没有它，【1-2】的绿可能只是「`classify` 什么都判成 truncated」。
ok(classify({ ran: 30, failSet: S(), code: 0 },
  { ran: 30, failSet: S('★ 恒 false 时它应当报错'), code: 1 }) === 'killed',
  '【1-3】★（阴性对照）分母不变 ＋ 多出一条具体的 ✗ ⇒ **`killed`** —— '
  + '否则【1-2】的绿说明不了 `classify` 分得开这两种',
  classify({ ran: 30, failSet: S(), code: 0 }, { ran: 30, failSet: S('y'), code: 1 }));

// ── 🔴 集合 vs 条数：杀掉一条同时救活一条 ⇒ **条数不变而集合全变** ──────────
//   按条数判会得到 `survived`（报安全）—— 一个假阴性。
ok(classify({ ran: 20, failSet: S('甲'), code: 1 },
  { ran: 20, failSet: S('乙'), code: 1 }) === 'unclear',
  '【1-4】🔴 ★★ **集合不同而条数相同**（`{甲}` ⇒ `{乙}`）⇒ **`unclear`**，不是 `survived` —— '
  + '按条数判会报安全，而这里「变异改变了什么」是确定的，只是没被判据分辨清',
  classify({ ran: 20, failSet: S('甲'), code: 1 }, { ran: 20, failSet: S('乙'), code: 1 }));

console.log('\n【2】`detectorsOf` 与内存变异钩子');

// ── `detectorsOf`：名字像探测器 或 源码里真的 `return true/false/null` ────────
const modPath = path.join(TMP, 'fixture-mod.js');
fs.writeFileSync(modPath, [
  'function isThing() { return true; }',
  'function plainNumber() { return 42; }',
  'function looksBool(x) { return x === 1; }',
  'module.exports = { isThing, plainNumber, looksBool, NOT_A_FN: 7 };',
].join('\n'));
const dets = detectorsOf(modPath);
ok(dets.includes('isThing') && dets.includes('looksBool')
   && !dets.includes('NOT_A_FN') && !dets.includes('plainNumber'),
  '【2-1】★ `detectorsOf` 挑出 `isThing`（名字像）＋ `looksBool`（源码里有 `===`），'
  + '而**排除**了非函数导出和只回数字的那个',
  JSON.stringify(dets));

// ── 🔴 内存变异：钩子换掉导出，而**磁盘上那个文件一个字节都不能变** ──────────
//   落盘的话，它会跟「跑全量前工作区必须静止」直接打架 —— 而那是这个仓库的地基。
const before = fs.readFileSync(modPath, 'utf8');
const probe = path.join(TMP, 'probe.js');
fs.writeFileSync(probe,
  `const m = require(${JSON.stringify(modPath)});\n`
  + 'process.stdout.write(String(m.isThing()));\n');
const r = spawnSync('node', [probe], {
  encoding: 'utf8',
  timeout: 60_000,
  env: {
    ...process.env,
    ENGLOOP_MUT_FILE: modPath,
    ENGLOOP_MUT_FN: 'isThing',
    ENGLOOP_MUT_VALUE: 'false',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${path.join(ROOT, 'scripts', '_mutate-hook.js')}`.trim(),
  },
});
ok(r.stdout === 'false',
  '【2-2】🔴 ★★ 钩子把 `isThing()` 换成了恒 `false`（原本回 `true`）—— '
  + '而它换在 `Module._load` 之后：模块照常执行，只有那个导出被替换',
  JSON.stringify({ stdout: r.stdout, stderr: (r.stderr || '').slice(0, 120) }));

ok(fs.readFileSync(modPath, 'utf8') === before,
  '【2-3】🔴 ★ 变异**只在内存里** —— 磁盘上那个文件逐字未变。'
  + '落盘的话它会跟「跑全量前工作区必须静止」直接打架',
  `${before.length} 字符`);

// ── 阴性对照：不给环境变量 ⇒ 钩子什么都不做 ───────────────────────────
//   没有它，【2-2】的绿可能只是「那个模块本来就回 false」。
const r2 = spawnSync('node', [probe], { encoding: 'utf8', timeout: 60_000 });
ok(r2.stdout === 'true',
  '【2-4】★（阴性对照）不设 `ENGLOOP_MUT_*` ⇒ 原样回 `true` —— '
  + '否则【2-2】的 `false` 说明不了是钩子干的',
  JSON.stringify(r2.stdout));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n  通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
