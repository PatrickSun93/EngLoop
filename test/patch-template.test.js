'use strict';

/**
 * `scripts/patch_template.py` —— 改仓库文件的补丁脚本骨架（python 版）。
 *
 * 它自带 `--self-test`：十道检查，每道喂一个「它应该抓住」的输入。
 * 而这个文件做的事只有一件：**让那个 self-test 真的被跑到**。
 *
 * ⚠️ **射程边界，先说清楚，否则这个文件会被读成一句假话：**
 *   它验的是**那段 `apply()` 的逻辑会不会响** —— 而**不是**「写补丁的人真的会去用它」。
 *   连接这两件事的只有「**真的去 import 它**」这个动作 —— 而那是**判断型**的，换不掉。
 *   （三层：名字 ⇒ `CLAUDE.md` · 实现 ⇒ `scripts/`（被 import）
 *     · self-test ⇒ `test/`。「被 import」是**唯一一种不复刻的连接**；
 *     而 `cp` 是复刻的一种，只是它复刻得比记忆准 —— 副本跟源头之间没有连接。
 *     凭记忆现写的补丁，正是会漏掉 `【mine】` 那一道的那种。）
 *   ⇒ 所以这个文件保证的是：**那段代码是好的**。它保证不了**有人会用它**。
 *
 * 单跑：`node test/patch-template.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const TPL = path.join(__dirname, '..', 'scripts', 'patch_template.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-patchtpl-'));

/** 跑一份（可能被变异过的）模板的 `--self-test`，回 { code, out } */
const runSelfTest = (file) => {
  const r = spawnSync('python3', [file, '--self-test'],
    { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

/** 把模板复制一份、做若干处替换、落到临时目录 —— **不碰真文件** */
const mutate = (name, subs) => {
  let s = SRC;
  for (const [old, neu] of subs) {
    // ★ 变异本身也要断言命中数：一个**没改动任何东西**的变异，跑出来是全绿的，
    //   而它跟「这段代码是必要的」长得一模一样。
    if (s.split(old).length - 1 !== 1) return null;
    s = s.replace(old, neu);
  }
  const p = path.join(TMP, name);
  fs.writeFileSync(p, s);
  return p;
};

console.log('\n【1】`scripts/patch_template.py` —— 它自己的十道检查会不会响');

ok(fs.existsSync(TPL),
  '【1-1】模板在 git 里（`scripts/patch_template.py`）—— '
  + '放在 scratchpad 的话活不过一个会话',
  TPL);

const SRC = fs.existsSync(TPL) ? fs.readFileSync(TPL, 'utf8') : '';

// ── 那三行 guard 是这个文件的全部价值所在 ──────────────────────────────
//   单独查过一次 `anyBusy()` = false，到按下执行时别人可能已经起跑 ——
//   放在脚本里的 `【busy】` 会在那一刻退 3 ⇒ **一个字节没写**。
//   ⇒ 它挡的那格有名字：**「凭据活得比它的条件久」** ——
//     单独跑一次 = 一张有时效的通行证；放进脚本 = 它跟着每一次写盘发生。
ok(/def guard_busy/.test(SRC) && /anyBusy/.test(SRC) && /sys\.exit\(3\)/.test(SRC),
  '【1-2】`【busy】` 那道还在（`guard_busy` ＋ `anyBusy` ＋ `exit(3)`）—— '
  + '它是这个模板存在的**唯一理由**',
  `guard_busy=${/def guard_busy/.test(SRC)} anyBusy=${/anyBusy/.test(SRC)}`);

const base = runSelfTest(TPL);
ok(base.code === 0 && /通过 15 · 失败 0/.test(base.out),
  '【1-3】★ `--self-test` ⇒ 退 0 且 **15 / 0** —— 每道检查都对着一个正控响过',
  `code=${base.code} · ${(base.out.match(/通过 \d+ · 失败 \d+/) || ['(没有那一行)'])[0]}`);

// ── 🔴 而 self-test 的 `case()` **只看退出码** ⇒ 那句诊断消失了它也不会红 ────
//   而那句诊断正是这一格的全部价值：只报「命中 2 次」会把人推向**加长锚点**，
//   而不是看见成因（有一句缩进更深的同一行逐字包含了它）。
//   ⇒ 所以这一条在**输出文本**上钉一次 —— 判据的层次跟 `case()` 不同，不是重复。
ok(/整行」只命中 1 次/.test(base.out) && /缩进更深/.test(base.out),
  '【1-4a】★ 子串数与整行数打架时，**那句成因**要真的印出来 —— '
  + '`case()` 只看退出码，诊断没了它不会红',
  base.out.split('\n').filter((l) => /整行|缩进/.test(l)).join(' / ') || '(一行都没有)');

// ── 裸跑必须**什么都不做** ────────────────────────────────────────────
//   `SUBS` 是空的时候它退 2 并打印用法。而这一条防的是一个很具体的坏法：
//   模板里 `F` 指着一个占位文件名，**如果它默认就往下走**，
//   一次手滑的 `python3 scripts/patch_template.py` 会去动一个不存在的路径。
const bare = spawnSync('python3', [TPL], { encoding: 'utf8', timeout: 60_000 });
ok(bare.status === 2 && /SUBS/.test(bare.stdout || ''),
  '【1-4】裸跑（`SUBS` 空）⇒ 退 **2** ＋ 打印用法，**不往下走**',
  `code=${bare.status}`);

// ══════════════════════════════════════════════════════════════════════
//  🔴【1-5】负控 —— 而它必须是**双变异**
// ══════════════════════════════════════════════════════════════════════
//
//   看起来该写的负控是：「把 `【重新数】` 那圈前瞻关掉 ⇒ ①档那道必须变红」。
//   🔬 而它是绿的：
//     单独关掉 `【重新数】`         ⇒ self-test 仍然 **9 / 0**
//     单独把计数改回**原始串**       ⇒ self-test 仍然 **9 / 0**
//     ⇒ ⇒ 两个一起关掉             ⇒ ①档那道**才**变红（退 0，应当 1）
//
//   ★ 成因：这两道在**互相顶着**。
//     `【命中数】`  每一步都在**当前串**上数 ⇒ 走到第二处时它自己就会看见「2 处」
//     `【重新数】`  只是**提前一步**看见同一件事，并且**说出成因**
//     ⇒ ⇒ 所以 `【重新数】` 的价值是**诊断**（它印「多半是新内容里逐字包含了它」），
//       **不是独立的探测力**。
//
//   🔴 而这正是「**被占住的空位看不见**」那一格：
//     单变异的负控是**恒真**的 —— 它会一直绿，而它的绿被读成「那段代码是必要的」。
//   🔴 变异锚点要**带上前后的换行**（`\n` ＋ 缩进 ＋ `\n`）：模板 `'all'` 模式那段里有一行
//     `            n = src.count(old)`（12 空格），它**逐字包含** 8 空格的那一行 ——
//     不带换行的话锚点会从 1 处变成 2 处 ⇒ 【1-5】【1-6】双双红，
//     而失效的方式正是 `【重新数】` 在讲的那个。
//     ★ 而这一格值钱的地方是：**判据红了，而红的原因是判据自己的锚点，不是被测对象** ——
//       而两者在输出里长得一模一样（都是一个 ✗）。所以 `mutate()` 返回 `null` 时，
//       失败信息里写的是「变异锚点没唯一命中」，而不是「防护没了」。
const mutCount = ['\n        n = src.count(old)\n', '\n        n = orig.count(old)\n'];
const mutAhead = ['\n            if m != 1:\n', '\n            if False:\n'];
const mutBoth = mutate('mut_both.py', [mutCount, mutAhead]);
const both = mutBoth ? runSelfTest(mutBoth) : null;
ok(both !== null && both.code === 1 && /✗ 【重新数】/.test(both.out),
  '【1-5】🔴 ★★ **双变异**（计数落回原始串 ＋ 关掉前瞻）⇒ ①档那道**必须变红** —— '
  + '证明那两道合起来真的挡得住，而不是写着好看',
  both === null ? '变异锚点没唯一命中 —— 那两行改过了，先去看它们'
    : `code=${both.code} · 有 ✗【重新数】=${/✗ 【重新数】/.test(both.out)}`);

// ── 🔴 而这一条**故意断言那个冗余还在** ──────────────────────────────
//   它红的时候有两种可能，而**动作相反** —— 所以失败信息里把两个退出码都印出来：
//     · 某一道变成**单独**就能挡 ⇒ **防护变强了** ⇒ 来把这条对照删掉，并把【1-5】降成单变异
//     · 两道**都**挡不住了       ⇒ 🔴 **保护没了** ⇒ 而【1-5】那条会同时红，去看它
//   （跟 `test/probe.test.js`【14-3】同一个形状：一条「断言缺陷/现状还在」的判据，
//     必须让人分得出这两种，否则它红的那天没人知道该往哪边走。）
const mutA = mutate('mut_a.py', [mutCount]);
const mutB = mutate('mut_b.py', [mutAhead]);
const a = mutA ? runSelfTest(mutA) : null;
const b = mutB ? runSelfTest(mutB) : null;
ok(a && b && a.code === 0 && b.code === 0,
  '【1-6】🔴 ★ 而**单独**变异任何一道，self-test 仍然全绿 —— '
  + '这两道在互相顶着（`【重新数】` 是诊断层，不是独立探测力），这条如实钉住这个现状',
  `单独变异计数 ⇒ code=${a && a.code} · 单独关前瞻 ⇒ code=${b && b.code}（两个都应当 0）`);

// ══════════════════════════════════════════════════════════════════════
//  【1-9..1-11】🔴 **从别的 cwd 用它** —— self-test 结构上测不到的那一格
// ══════════════════════════════════════════════════════════════════════
//
//   要防的形状：补丁脚本在 `temp/`，
//   而 `require('./scripts/…')` 去找了 `temp/scripts/…` ⇒ `MODULE_NOT_FOUND`。
//   🔴 `_resolve` 那条判据**补不了这一格**：
//     `_resolve` 测的是**目标文件路径**怎么解析，**不是「从别的 cwd import 这个模块」**。
//     ⇒ ⇒ 两件事共用了「cwd」这个词 ——
//       一读到「cwd 那一格」，眼睛就落到那条判据上，然后判定「有了」。
//     ★ 一个名字指两样东西时，按名字做的检查会返回一个**自信的错答案**。
//
//   ⇒ 而 self-test **结构上**测不到它：它总是从仓库根跑，「别的 cwd」在它的世界里不存在。
//     ⇒ ⇒ 所以这一格只能在这里（判据层）补，而补法是**照文件头里逐字写的那三行跑一次**。
//   ★ 于是它同时是一条**文档判据**：`scripts/patch_template.py` 头部那三行是给人复制的，
//     ⇒ ⇒ 「文档对不对」和「工具对不对」在这里**是同一条判据**。
{
  const ELSEWHERE = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-cwd-'));
  const target = path.join(ELSEWHERE, 'x.js');
  const SCRIPTS = path.join(__dirname, '..', 'scripts');

  ok(/sys\.path\.insert\(0, '<ROOT>\/scripts'\)/.test(SRC)
     && /from patch_template import apply/.test(SRC),
    '【1-9】★ 文件头里那三行**还是那三行** —— 下面两条跑的就是它，'
    + '文档一改这条先红（而那时下面两条测的就不是文档里的写法了）',
    JSON.stringify((SRC.match(/sys\.path\.insert[^\n]*/) || ['(没有)'])[0]));

  const runFrom = (setup) => {
    fs.writeFileSync(target, 'const a = 1;\n');
    const script = path.join(ELSEWHERE, 'p.py');
    fs.writeFileSync(script, [
      setup,
      'from patch_template import apply',
      `apply(${JSON.stringify(target)}, [('const a = 1;', 'const a = 2;', 'x')],`
        + ' check_busy=False, check_mine=False)',
    ].join('\n'));
    const r = spawnSync('python3', [script], { cwd: ELSEWHERE, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, body: fs.readFileSync(target, 'utf8'), err: (r.stderr || '').slice(0, 200) };
  };

  const good = runFrom(`import sys; sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`);
  ok(good.code === 0 && good.body === 'const a = 2;\n',
    '【1-10】🔴 ★★ 从**另一个 cwd**照文档那三行 import 并跑 `apply` ⇒ 退 0 且文件真的改了',
    `code=${good.code} · 内容=${JSON.stringify(good.body)} · ${good.err}`);

  // ── 阴性对照：把那一行写成**相对**路径（最自然的写错法）⇒ 从别的 cwd 必须失败 ──
  //   没有它，【1-10】可能只是因为 python 恰好从别处找到了那个模块而绿。
  const bad = runFrom("import sys; sys.path.insert(0, 'scripts')");
  ok(bad.code !== 0 && /ModuleNotFoundError|No module named/.test(bad.err),
    '【1-11】★（阴性对照）把那一行写成**相对** `scripts` ⇒ 从别的 cwd **必须失败** —— '
    + '否则【1-10】的绿说明不了「文档里那条绝对路径是必要的」',
    `code=${bad.code} · ${bad.err}`);

  fs.rmSync(ELSEWHERE, { recursive: true, force: true });
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n  通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
