'use strict';

/**
 * 给 `rate_limited` 一个出口。
 *
 * ── 这一档的硬要求（`lib/watchdog.js` 那段注释原话）────────────────────
 *   **「这一档的验证必须能造出来 —— 不要等下一次真撞限额才知道它对不对。」**
 *   真限额一年撞不了几次，而**一个没被执行过的分支和一个不存在的分支等价**。
 *   ⇒ 下面每一条都喂假 pane 文本，样本一律来自 `test/fixtures/rate-limit-panes/`。
 *
 * ── ⚠️ 施工纪律（本文件自身遵守，见 X1/X2）────────────────────────
 *   **本文件里不出现任何能命中 `RATE_LIMIT_RE` 的字面文本。**
 *   真实文案只从 fixture 读；构造样本用不命中入口判据的最小串
 *   （出口判据 `RESET_TIME_RE` 和入口判据是两套，构造串只需要命中前者）。
 *   ⇒ 文件末尾有一条**自查**：把本文件源码喂进 `looksRateLimited` 必须是 false。
 */

const fs = require('node:fs');
const path = require('node:path');
const watchdog = require('../lib/watchdog');

let pass = 0; let fail = 0;
const ok = (c, l, d = '') => (c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`)));

const FIX = path.join(__dirname, 'fixtures', 'synthetic', 'rate-limit-panes');
// ⚠️ 这一份是 **pane 里的一行**，不是一份 pane。
//   它验的是「能不能从一行里读出时区」—— **不能替代 40 行整段样本**。
//   bug（E2）只存在于另外那 39 行里。见同目录 README.md。
const REAL = path.join(FIX, 'line-only.txt');
const PANE_ORCH = path.join(FIX, '40lines-orch.txt');
const PANE_SENIOR = path.join(FIX, '40lines-agent.txt');

// 锚点：撞墙那一刻。**固定值，不用 Date.now()** —— 一个随时间变的测试
// 会在某个时区/某个时刻莫名其妙地红，而那时没人知道它验的是什么。
const ANCHOR = Date.parse('2026-08-20T18:24:00Z');
const H = 3600 * 1000;

// ── 构造样本：只命中出口判据，不命中入口判据 ─────────────────────────
//   ★ 这一点本身就是一条信息：**两套正则是独立的**，
//     出口能解析的文本，入口不一定判成限额（反之亦然）。
const S_TZ = 'resets 2:10pm America/Los_Angeles';
const S_NO_TZ = 'resets 2:10pm';
const S_BAD_TZ = 'resets 2:10pm Foo/Barbaz';
const S_NO_TIME = 'nothing useful here';

// ═══ ⓪ 正控：先证明这些检查器**表达得出**两种结果 ═══════════════════
//
//   结果为空/零/全绿时先跑正控。而这里更前一步 ——
//   **先证明被测对象存在、fixture 读得到、判据两个方向都返回得了。**
function positiveControls() {
  console.log('━━ ⓪ 正控 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ok(typeof watchdog.parseResetTime === 'function', 'parseResetTime 导出了');
  ok(fs.existsSync(REAL), `fixture 存在：${path.relative(process.cwd(), REAL)}`);

  const real = fs.readFileSync(REAL, 'utf8');
  ok(real.length > 0 && /^[\x20-\x7E\n]+$/.test(real),
    `fixture 是非空纯 ASCII（${real.length} 字符）—— 它是 pane 文本，不是带标注的分析表`,
    JSON.stringify(real.slice(0, 20)));

  // 🔴 这一条是整个文件的地基：fixture 必须是**入口判据会命中**的那种文本。
  //   否则下面所有「出口」判据验的是一份根本不会进入 rate_limited 的样本。
  ok(watchdog.looksRateLimited(real) === true,
    '🔴 fixture 会被入口判据命中 —— 它确实是「会走到出口」的那种 pane');

  // 阴性对照：这个检查器表达得出 false 吗？
  ok(watchdog.looksRateLimited(S_NO_TIME) === false,
    '阴性对照：入口判据对一段无关文本返回 false ⇒ 它不是恒真的');

  // ★ 构造样本**不**命中入口判据 —— 记录这个事实，它是下面 C 组的前提
  ok(watchdog.looksRateLimited(S_TZ) === false,
    '★ 构造样本不命中入口判据 ⇒ 出口判据与入口判据是两套独立的东西');
}

// ═══ E 组 · 出口本身 ═══════════════════════════════════════════════
function groupE() {
  console.log('\n━━ E 组 · 出口本身 ━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const real = fs.readFileSync(REAL, 'utf8');

  // E1：真实文案能解析出时刻
  const r = watchdog.parseResetTime(real, ANCHOR);
  ok(r.ok === true, 'E1 真实 fixture 解析成功', JSON.stringify(r));
  ok(r.mode === 'tz', 'E1 走的是「文案自带时区名」这条路（不是最坏上界）', String(r.mode));
  ok(r.tz === 'America/Los_Angeles', 'E1 时区名抓对了', String(r.tz));

  // 🔴 手算对账：2:10pm PDT = UTC−7 ⇒ 21:10Z。
  //   **不写「等于函数自己算出来的值」** —— 那是一条恒真断言。
  ok(r.at === Date.parse('2026-08-20T21:10:00Z'),
    '🔴 E1 解出的 UTC 时刻 = 2026-08-20T21:10:00Z（14:10 PDT，UTC−7，手算对账）',
    r.ok ? new Date(r.at).toISOString() : String(r.reason));

  ok(r.at > ANCHOR, 'E1 解出的时刻在锚点之后 —— 重置必然晚于撞墙那一刻');

  // E1b：锚点变了，解出的「最近的那个 T」跟着变（证明它真用了锚点，不是写死的）
  const later = watchdog.parseResetTime(real, Date.parse('2026-08-20T22:00:00Z'));
  ok(later.ok && later.at === Date.parse('2026-08-21T21:10:00Z'),
    '🔴 E1b 锚点推到 22:00Z（已过当天 21:10）⇒ 取**第二天**的 21:10Z'
    + ' —— 证明它真按锚点算，不是常量',
    later.ok ? new Date(later.at).toISOString() : String(later.reason));
}

// ═══ C 组 · 正控与 fail-closed ═════════════════════════════════════
function groupC() {
  console.log('\n━━ C 组 · fail-closed 三档 + 上界 ━━━━━━━━━━━━━━');

  // C1：解析不出时刻
  const c1 = watchdog.parseResetTime(S_NO_TIME, ANCHOR);
  ok(c1.ok === false && c1.reason === 'no_time',
    '🔴 C1 解析不出时刻 → fail-closed，reason = no_time', JSON.stringify(c1));

  // C2：时区名 Intl 不认识
  const c2 = watchdog.parseResetTime(S_BAD_TZ, ANCHOR);
  ok(c2.ok === false && c2.reason === 'bad_tz',
    '🔴 C2 名字像时区但 Intl 不认识 → fail-closed，reason = bad_tz', JSON.stringify(c2));
  // ★ 为什么 bad_tz 不退回最坏上界：**「写了个读不懂的时区」和「压根没写」
  //   不是一回事** —— 前者说明解析有缺口，把它并进后者会把缺口盖住。
  ok(c2.reason !== 'no_tz' && c2.mode !== 'worst_case',
    '★ C2 没有被降级成「无时区名」那一档 —— 两者含义不同，不许并档');

  // C3：detected_at 缺失，**且不许拿「现在」顶替**
  // ⚠️ 标签用 String() 不用 JSON.stringify —— 后者把 NaN / Infinity 都印成
  //   `null`，于是五条断言里有三条**标签一模一样**，谁红了看不出是哪条。
  //   （一个把不同输入印成同一个字符串的显示器，等于把三条测试合并成一条。）
  for (const bad of [undefined, null, NaN, 'now', Infinity]) {
    const c3 = watchdog.parseResetTime(S_TZ, bad);
    ok(c3.ok === false && c3.reason === 'no_detected_at',
      `🔴 C3 detected_at = ${String(bad)} → fail-closed，不拿「现在」顶替`,
      JSON.stringify(c3));
  }

  // C2b：无时区名 → 可推导的上界（锚点 + 24h）
  const b = watchdog.parseResetTime(S_NO_TZ, ANCHOR);
  ok(b.ok === true && b.mode === 'worst_case', 'C2b 无时区名 → worst_case 档，不是 fail-closed',
    JSON.stringify(b));
  ok(b.tz === null, 'C2b 没有猜任何时区名', String(b.tz));
  ok(b.at === ANCHOR + 24 * H,
    '🔴 C2b 上界 = 锚点 + 24h —— 值只来自「一个本地时刻的周期」，不是拍的余量',
    b.ok ? String((b.at - ANCHOR) / H) + 'h' : String(b.reason));

  // 🔴 C2b 的后半句：**光断言「等于 anchor+24h」不够**。
  //   没有下面两条，「它真的用了上界」和「它偷偷用了某个时区、而那个时区
  //   恰好算出同一个值」分不开 —— 而后者是不允许的（无时区名时不许猜时区）。
  {
    const asUtc = (() => {                       // 把 2:10pm 当 UTC 解，取锚点之后最近的
      for (let add = -1; add <= 2; add += 1) {
        const t = Date.UTC(2026, 7, 20 + add, 14, 10);
        if (t > ANCHOR) return t;
      }
      return null;
    })();
    const asLocal = (() => {                     // 当**机器本地时区**解，取锚点之后最近的
      for (let add = -1; add <= 2; add += 1) {
        const t = new Date(2026, 7, 20 + add, 14, 10, 0, 0).getTime();
        if (t > ANCHOR) return t;
      }
      return null;
    })();
    ok(b.at !== asUtc,
      `🔴 C2b 解出的值 ≠ 把时刻当 UTC 解（${new Date(asUtc).toISOString()}）`);
    ok(b.at !== asLocal,
      `🔴 C2b 解出的值 ≠ 按**机器本地时区**解（${new Date(asLocal).toISOString()}，`
      + `本机偏移 ${-new Date().getTimezoneOffset() / 60}h）—— 决定 1③ 明写绝不用机器时区`);
    // ⚠️ 而这两条断言本身依赖「本机不是 UTC」这个偶然事实。写清楚，别装作它不存在。
    ok(new Date().getTimezoneOffset() !== 0,
      '⚠️ C2b 附：本机时区非 UTC ⇒ 上面那条「≠ 本地解」区分得开'
      + '（若在 UTC 机器上跑，它与「≠ UTC 解」退化成同一条，这时这一格会红并提醒你）');
  }

  // 🔴 C2c：**上界的紧性** —— 遍历全部真实时区偏移，证明没有候选越过它，
  //   而且它紧到 15 分钟粒度内可达。**这一条替代了「相信 24 是对的」。**
  {
    let latest = -Infinity; let latestOff = null;
    for (let off = -12 * 60; off <= 14 * 60; off += 15) {
      for (let add = -2; add <= 2; add += 1) {
        const t = Date.UTC(2026, 7, 20 + add, 14, 10) - off * 60000;
        if (t > ANCHOR) { if (t > latest) { latest = t; latestOff = off; } break; }
      }
    }
    ok(latest <= ANCHOR + 24 * H,
      `🔴 C2c 遍历 −12:00…+14:00 全部偏移：最晚候选 (+${((latest - ANCHOR) / H).toFixed(2)}h)`
      + ' 不越过上界 ⇒ 上界成立');
    ok(ANCHOR + 24 * H - latest <= 15 * 60000,
      `🔴 C2c 上界**紧**：最晚候选距上界仅 ${((ANCHOR + 24 * H - latest) / 60000).toFixed(0)} 分钟`
      + '（= 遍历粒度）⇒ 不可再收');
    // ⚠️ 「按 UTC−12 解」给出的不是最晚候选 —— 这条断言挡的就是那种写法。
    const utc12 = (() => {
      for (let add = -2; add <= 2; add += 1) {
        const t = Date.UTC(2026, 7, 20 + add, 14, 10) + 12 * H;
        if (t > ANCHOR) return t;
      }
      return null;
    })();
    ok(utc12 !== null && utc12 < latest,
      `★ C2c 附：UTC−12 解 (+${((utc12 - ANCHOR) / H).toFixed(2)}h) **比最晚候选早**`
      + ` ${((latest - utc12) / H).toFixed(1)} 小时（最晚由偏移 ${latestOff / 60}h 给出）`
      + ' —— 「最晚的偏移」≠「最晚的候选」，跳日效应把它抵消了');
  }
}

// ═══ B 组 · 缺口 B 那条正则 ════════════════════════════════════════
function groupB() {
  console.log('\n━━ B 组 · 缺口 B 那条正则 ━━━━━━━━━━━━━━━━━━━━');
  const res = watchdog.RESET_TIME_RE;
  ok(Array.isArray(res) && res.length >= 2,
    `B2 出口正则是数组且不止一条（${res && res.length} 条）`);

  // B2：原有那条（要求介词的）**没被删**
  const hasPrep = res.some((re) => /at\|in\|on/.test(re.source));
  ok(hasPrep, '🔴 B2 原有那条（带介词分支的）仍在数组里 —— 判据明写不许删');

  // B1：新增那条能覆盖真实文案
  const real = fs.readFileSync(REAL, 'utf8');
  const hitBy = res.map((re) => re.test(real));
  ok(hitBy.some(Boolean), 'B1 至少有一条命中真实 fixture');

  // ★ 而**哪一条命中**才是缺口 B 的实质：带介词那条在真实文案上是死的
  const idxPrep = res.findIndex((re) => /at\|in\|on/.test(re.source));
  ok(idxPrep >= 0 && hitBy[idxPrep] === false,
    '🔴 B1b **带介词那条对真实 fixture 不命中** —— 这就是缺口 B 本身'
    + '（它一直没命中，而没人发现，因为入口判据的第一条在替它工作）',
    JSON.stringify(hitBy));
  const idxNew = res.findIndex((re, i) => i !== idxPrep && hitBy[i]);
  ok(idxNew >= 0, '🔴 B1c 补的那条（不要求介词的）**命中了** ⇒ 缺口补上了');
}

// ═══ 变异 · C5 / C6 / B3 ═══════════════════════════════════════════
//
//   ── 为什么用「源码文本 + new Function」而不是改文件 ──────────────────
//     改文件跑完再恢复，会让 `run-all.js` 的工作区快照翻成
//     `worktree_changed_during_run: true`。
//     ⇒ **变异必须发生在内存里，磁盘一个字节都不动。**
function buildMutant(fnName, replace) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'watchdog.js'), 'utf8');
  const start = src.indexOf(`function ${fnName}`);
  if (start < 0) return null;
  // 括号配对找函数体结束
  let depth = 0; let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  let body = src.slice(start, end);
  const before = body;
  body = replace(body);
  if (body === before) return { unchanged: true };
  // 依赖项当参数注入 —— 它们都是纯的
  // ⚠️ 漏了 `IANA_TZ_RE_G` 的话变异体在**运行时**炸
  //   `ReferenceError`，而那看起来像「变异测试坏了」，不像「helpers 少列了一个」。
  const helpers = ['RESET_TIME_RE', 'IANA_TZ_RE', 'IANA_TZ_RE_G', 'tzOffsetAt', 'zonedToUtc', 'WORST_CASE_WINDOW_MS', 'extractResetHint'];
  const pick = (name) => {
    const s = src.indexOf(`const ${name} =`);
    if (s >= 0) {
      // ⚠️ 不能截到行末就算完 —— `RESET_TIME_RE` 是个**多行数组**，
      //   截第一行会得到 `const X = [` 这种语法错的碎片。
      //   ⇒ 扫到括号深度归零之后的那个分号。
      //   （截错时报 `SyntaxError: Unexpected token 'const'` —— 变异器自己坏了，
      //     而**如果它坏得更安静一点，变异就会「通过」**。）
      let d = 0;
      for (let i = s; i < src.length; i += 1) {
        const ch = src[i];
        if (ch === '[' || ch === '{' || ch === '(') d += 1;
        else if (ch === ']' || ch === '}' || ch === ')') d -= 1;
        else if (ch === ';' && d === 0) return src.slice(s, i + 1);
      }
      return src.slice(s, src.indexOf('\n', s));
    }
    const f = src.indexOf(`function ${name}`);
    if (f < 0) return '';
    let d = 0; let x = -1;
    for (let i = src.indexOf('{', f); i < src.length; i += 1) {
      if (src[i] === '{') d += 1;
      else if (src[i] === '}') { d -= 1; if (d === 0) { x = i + 1; break; } }
    }
    return src.slice(f, x);
  };
  const prelude = helpers.map(pick).join('\n');
  // eslint-disable-next-line no-new-func
  return { fn: new Function(`${prelude}\n${body}\nreturn ${fnName};`)() };
}

function groupMutation() {
  console.log('\n━━ 变异 · C5 / C6 / B3 ━━━━━━━━━━━━━━━━━━━━━━━');
  const real = fs.readFileSync(REAL, 'utf8');

  // ── 变异器自身的正控：不做任何替换时，它必须复现原行为 ──────────────
  const clean = buildMutant('resolveResetAt', (b) => b.replace('__nothing__', '__x__'));
  ok(clean && clean.unchanged, '⓪ 变异器正控：没有可替换处时如实报告 unchanged（不静默产出原件）');
  const identity = buildMutant('resolveResetAt', (b) => `${b}\n/* touched */`);
  const viaHint = (m, pane, det) => m(watchdog.extractResetHint(pane), det);
  ok(identity && typeof identity.fn === 'function'
    && viaHint(identity.fn, real, ANCHOR).at === Date.parse('2026-08-20T21:10:00Z'),
    '⓪ 变异器正控：只加一行注释时，重建出的函数与原件行为一致'
    + ' ⇒ 下面变异变红是**因为变异**，不是因为重建过程本身坏了');

  // ── C6（做过头方向）：把 fail-closed 改成「解析不出就当已过期」──────
  //
  //   ★ 这是这一组的**主判据**。C1/C2/C3 是**阴性**判据 ——
  //     「去掉功能」那类变异对它们一点鉴别力都没有（功能没了，它们当然全绿）。
  //     能验它们的只有**做过头**方向：让实现在缺证据时**放行**。
  //   ⚠️ 第一条替换不能少：`no_time` / `bad_tz` 由
  //   `extractResetHint` 判出来，`resolveResetAt` 开头那句 `if (hint.reason)` 才是
  //   它们的 fail-closed 出口。不变异它的话，C6 只覆盖得到 C3 一条 ——
  //   ★ **只红一条、另外两条绿 ⇒ 变异漏了一层，看起来像判据通过。**
  const over = buildMutant('resolveResetAt', (b) => b
    .replace(/if \(!hint \|\| hint\.reason\) return \{ ok: false, reason: \(hint && hint\.reason\) \|\| 'no_time' \};/,
      "if (false) return { ok: false, reason: 'no_time' };")
    .replace(/return \{ ok: false, reason: 'no_time' \};/g,
      "return { ok: true, at: 0, tz: null, mode: 'mutant', raw: null };")
    .replace(/return \{ ok: false, reason: 'no_detected_at' \};/g,
      "return { ok: true, at: 0, tz: null, mode: 'mutant', raw: null };")
    .replace(/return \{ ok: false, reason: 'bad_tz' \};/g,
      "return { ok: true, at: 0, tz: null, mode: 'mutant', raw: null };"));
  ok(over && typeof over.fn === 'function', 'C6 做过头变异体构造成功');
  if (over && over.fn) {
    const m1 = viaHint(over.fn, S_NO_TIME, ANCHOR);
    const m2 = viaHint(over.fn, S_TZ, undefined);
    const m3 = viaHint(over.fn, S_BAD_TZ, ANCHOR);
    ok(m1.ok === true, '🔴 C6 变异后 C1 的断言会红（解析不出却返回 ok）', JSON.stringify(m1));
    ok(m2.ok === true, '🔴 C6 变异后 C3 的断言会红（无锚点却返回 ok）', JSON.stringify(m2));
    ok(m3.ok === true, '🔴 C6 变异后 C2 的断言会红（坏时区却返回 ok）', JSON.stringify(m3));
    ok(viaHint(over.fn, real, ANCHOR).at === Date.parse('2026-08-20T21:10:00Z'),
      '★ C6 而变异体在**正常输入**上行为不变 ⇒ 只有阴性判据抓得住它，'
      + '阳性判据（E1）对它是瞎的 —— 这正是它必须存在的理由');
  }

  // ── C5（去掉功能方向）：把解析改坏 → E1 必须红 ────────────────────
  // ⚠️ 这里的 `.*` 不能写成 `[^)]*` —— 被替换的那行里**本身含右括号**
  //   （正则字面量里的分组），`[^)]*` 会在第一个 `)` 处停下，匹配不上。
  //   ★ 而它没有静默失败：`buildMutant` 在替换无效时返回 `{unchanged:true}`，
  //     于是断言红了。**一个「什么都没做」和「做了」返回同一个东西的变异器，
  //     会让每一次变异测试都假绿。**
  const broken = buildMutant('resolveResetAt', (b) => b.replace(
    /const hm = String\(hint\.raw\)\.match\(.*\);/,
    'const hm = null;'));
  ok(broken && typeof broken.fn === 'function', 'C5 去功能变异体构造成功');
  if (broken && broken.fn) {
    const m = viaHint(broken.fn, real, ANCHOR);
    ok(m.ok === false, '🔴 C5 变异后 E1 的断言会红（真实 fixture 解析不出来了）',
      JSON.stringify(m));
  }

  // ── B3：把补的那条正则拿掉 → B1c 必须红 ──────────────────────────
  {
    const res = watchdog.RESET_TIME_RE;
    const idxPrep = res.findIndex((re) => /at\|in\|on/.test(re.source));
    const onlyPrep = res.filter((_, i) => i === idxPrep);
    const real2 = fs.readFileSync(REAL, 'utf8');
    ok(onlyPrep.length === 1 && onlyPrep.some((re) => re.test(real2)) === false,
      '🔴 B3 只留带介词那条 ⇒ 真实 fixture 一条都不命中 ⇒ B1 会红'
      + ' —— 证明 B1 的绿是新增那条挣来的，不是恒真');
  }
}

// ═══ X 组 · 施工纪律自查 ═══════════════════════════════════════════
function groupX() {
  console.log('\n━━ X 组 · 施工纪律自查 ━━━━━━━━━━━━━━━━━━━━━━');
  const self = fs.readFileSync(__filename, 'utf8');
  ok(watchdog.looksRateLimited(self) === false,
    '🔴 X1 **本文件源码**喂进入口判据 = false ⇒ 读它、cat 它不会污染任何 pane');

  // ★ 阴性对照：没有这一条的话，上面那个 false 可能只是「检查器什么都不认」
  ok(watchdog.looksRateLimited(fs.readFileSync(REAL, 'utf8')) === true,
    '★ X1 阴性对照：同一个检查器对 fixture 返回 true ⇒ 它不是恒假的');

  // X2：真实文案只存在于 fixtures 里 —— 本文件没有内联它
  const real = fs.readFileSync(REAL, 'utf8').trim();
  ok(self.includes(real) === false,
    '🔴 X2 本文件没有内联 fixture 内容（只从文件读）');
}

// ═══ E2 组 · 时区锚定 ═══════════════════════════════════════════════
//
//   ── 这一组存在的理由，比它验的东西重要 ────────────────────────────
//     其余判据全绿，并不说明出口生效：
//     若 `extractResetHint` 在**整段 40 行**上找 IANA 形状、取第一个，
//     而 pane 里全是文件路径（`temp/outbox`、`bin/next`）⇒ 每次都 `bad_tz`。
//
//     🔴 **单行样本抓不到它**：样本是 **1 行**，而生产喂 **40 行**。
//        bug 只存在于另外那 39 行里。
//        ⇒ 样本切片和生产切片不一致，判据在测试里恒真。
//
//   ⇒ 所以这一组的每一条都喂**完整 40 行真实 pane**。
function groupE2() {
  console.log('\n━━ E2 组 · 时区锚定（勘误）━━━━━━━━━━━━━━━━━');
  const orch = fs.readFileSync(PANE_ORCH, 'utf8');
  const senior = fs.readFileSync(PANE_SENIOR, 'utf8');

  // ── ⓪ 正控：先证明这两份样本**确实是 40 行、确实会命中入口判据** ──────
  //   没有这一条，下面所有断言可能跑在一份被截短的、根本不含 bug 的样本上。
  for (const [name, t] of [['orch', orch], ['senior', senior]]) {
    const lines = t.split('\n').length;
    ok(lines >= 40, `⓪ ${name} 样本是 **${lines} 行**（≥ RATE_LIMIT_PEEK_LINES=40）`
      + ' —— 切片跟生产一致，这是这一组成立的前提');
    ok(watchdog.looksRateLimited(t) === true,
      `⓪ ${name} 样本会被入口判据命中 ⇒ 它确实是「会走到出口」的那种 pane`);
  }

  // ── E2-2：两份真实样本解析出真时区名 ─────────────────────────────
  for (const [name, t] of [['orch', orch], ['senior', senior]]) {
    const h = watchdog.extractResetHint(t);
    ok(h.tz === 'America/Los_Angeles',
      `🔴 E2-2 ${name}：40 行真实 pane → tz = **America/Los_Angeles**`,
      JSON.stringify(h));
    ok(h.raw === '7:10pm',
      `E2-2 ${name}：抓到的时刻是 **7:10pm**（= 终端上写的 19:10）`, JSON.stringify(h));
  }

  // ── 🔴 E2-2b：**错误实现会怎样** —— 把这个事实钉进测试 ──────────
  //   整段找、取第一个 ⇒ 第一个匹配是文件路径。
  //   ★ 这条断言的是「**污染源确实在样本里**」—— 否则 E2-2 的绿可能只是
  //     「这两份样本恰好没有污染行」。
  const IANA = /\b[A-Za-z]{2,}(?:_[A-Za-z]+)*\/[A-Za-z]{2,}(?:_[A-Za-z]+)*\b/;
  for (const [name, t, expect] of [['orch', orch, 'temp/outbox'], ['senior', senior, 'bin/next']]) {
    const first = (t.match(IANA) || [])[0];
    ok(first === expect,
      `🔴 E2-2b ${name}：整段的**第一个** IANA 形状仍然是 \`${expect}\`（实际 \`${first}\`）`
      + ' —— 污染源还在样本里，所以 E2-2 的绿是锚定挣来的，不是「样本很干净」');
    let known = false;
    try { watchdog.tzOffsetAt(Date.now(), first); known = true; } catch (_) { known = false; }
    ok(known === false, `E2-2b ${name}：而那个第一匹配 Intl **不认识** ⇒ 旧实现在这里返回 bad_tz`);
  }

  // ── E2-3 正控：删掉污染行之后**仍然**通过 ────────────────────────
  //   ⇒ 证明修法不是「恰好躲开 temp/outbox 和 bin/next 这两个字符串」。
  for (const [name, t, bad] of [['orch', orch, 'temp/outbox'], ['senior', senior, 'bin/next']]) {
    const cleaned = t.split('\n').filter((l) => !l.includes(bad)).join('\n');
    ok(cleaned !== t, `E2-3 ${name}：确实删掉了含 \`${bad}\` 的行（样本变短了）`);
    const h = watchdog.extractResetHint(cleaned);
    ok(h.tz === 'America/Los_Angeles',
      `🔴 E2-3 ${name}：删掉污染行后**仍然**解析出 America/Los_Angeles`,
      JSON.stringify(h));
  }

  // ── 🔴 E2-4：三条诱饵 ────────────────────────────────────────────
  //   每一条排除**一种**错误实现，而任何一条单独都排除不了另外两种。
  // ⚠️ 用**不带介词**的形式（`resets 2:10pm`）。
  //   ★ 注释里也不要举「带介词」那种形式的例子 —— 举了，这行注释本身就会
  //     命中入口判据：**一条正则唯一一次命中，往往是在有人解释它为什么不命中的时候。**
  //     ⇒ 只描述，不举例。
  //   带介词的会命中入口判据 `RATE_LIMIT_RE[3]`（`/\\bresets?\\s+(at|in|on)\\b/i`），
  //   于是**这个测试文件自己**变成一份会污染 pane 的文本（X1 会抓住它）。
  //   ★ 而真实文案本来就是不带介词的 —— 用带介词的构造样本，等于用了一个
  //     **真实输入里不存在的形式**，那是「构造 vs 真实」在又一个维度上分叉。
  const RESET_LINE = 'Your limit resets 2:10pm (America/Los_Angeles).';
  {
    // ① 诱饵在 resets 行**之前** ⇒ 排除「整段取第一个」
    const before = `cd Europe/London && ls\nsome noise\n${RESET_LINE}`;
    ok(watchdog.extractResetHint(before).tz === 'America/Los_Angeles',
      '🔴 E2-4① 诱饵（Europe/London）在 resets 行**之前** ⇒ 仍取到真时区名'
      + ' —— 排除「整段 match 取第一个」', JSON.stringify(watchdog.extractResetHint(before)));

    // ② 诱饵在 resets 行**之后** ⇒ 排除「整段取最后一个」
    //   ★ 只验①的话，一个把 match 换成「取最后一个」的实现会通过。
    const after = `${RESET_LINE}\nsee Europe/Paris for details`;
    ok(watchdog.extractResetHint(after).tz === 'America/Los_Angeles',
      '🔴 E2-4② 诱饵（Europe/Paris）在 resets 行**之后** ⇒ 仍取到真时区名'
      + ' —— 排除「整段取最后一个」', JSON.stringify(watchdog.extractResetHint(after)));

    // ③ 🔴 诱饵在**同一行更远处** ⇒ 排除「行锚定了，但行内仍然乱找」
    //   ★ 真实样本里时区名离时刻只有 **8 个字符**，
    //     所以任何「行内取第一个/最后一个」的实现在真实样本上**照样会通过**。
    const inline = `${RESET_LINE} see Europe/Berlin later`;
    const hi = watchdog.extractResetHint(inline);
    ok(hi.tz === null,
      '🔴 E2-4③ 诱饵（Europe/Berlin）在**同一行更远处** ⇒ **两个合法候选 ⇒ tz: null（走上界）**'
      + ' —— 不猜哪个对', JSON.stringify(hi));
    ok(hi.reason === undefined && hi.raw === '2:10pm',
      '🔴 E2-4③ 而它**不是 bad_tz** —— 我们读得懂那两个名字，只是不知道用哪个',
      JSON.stringify(hi));
  }

  // ── E2-4b：两个合法候选时**走上界**这个裁定的方向性 ────────────────
  //   ★ 为什么不「取最近」：取错的方向**不对称**。
  //     取最近而取错 ⇒ 可能算出**更早**的时刻 ⇒ 提前唤醒 ⇒ 再撞一次墙
  //                    （提前唤醒 ⇒ 再撞墙 ⇒ 再唤醒，是个永动循环的入口）
  //     走上界       ⇒ **只会晚，不会早** ⇒ 最坏多等 24 小时，而现状是「永远」
  {
    const ANCHOR2 = Date.parse('2026-08-20T18:24:00Z');
    const two = `Your limit resets 2:10pm (Asia/Tokyo) (America/Los_Angeles).`;
    const r = watchdog.parseResetTime(two, ANCHOR2);
    ok(r.ok === true && r.mode === 'worst_case',
      '🔴 E2-4b 两个合法候选 ⇒ 整条链走到 **worst_case 上界**（不是 fail-closed）',
      JSON.stringify(r));
    ok(r.at === ANCHOR2 + 24 * H,
      'E2-4b 而那个上界就是 anchor + 24h —— **只会晚，不会早**');
  }

  // ── E2-6：括号形式（真实文案就是带括号的）───────────────────────
  ok(watchdog.extractResetHint('resets 2:10pm (America/Los_Angeles).').tz === 'America/Los_Angeles',
    '🔴 E2-6 括号形式 `(America/Los_Angeles)` 解析得了 —— 真实文案就是这样写的');
  ok(watchdog.extractResetHint('resets 2:10pm America/Los_Angeles').tz === 'America/Los_Angeles',
    'E2-6 无括号形式**也**解析得了（老样本那种）⇒ 两种都覆盖');

  // ── E2-7：三个单行样本保留且仍然通过，但不再是唯一样本 ──────────────
  const lineOnly = fs.readFileSync(REAL, 'utf8');
  ok(lineOnly.split('\n').filter(Boolean).length === 1,
    `E2-7 \`line-only-\` 那份确实只有 **1 行** —— 它是 pane 里的一行，不是一份 pane`);
  ok(watchdog.extractResetHint(lineOnly).tz === 'America/Los_Angeles',
    'E2-7 单行样本**仍然**通过（老判据没被破坏）');

  // ── 🔴 E2-5 变异：把锚定改回「整段 match 取第一个」⇒ E2-2 必须红 ────
  const mut = buildMutant('extractResetHint', (b) => b
    .replace('const cands = [...line.matchAll(IANA_TZ_RE_G)].map((m) => m[0]);',
      'const cands = [...paneText.matchAll(IANA_TZ_RE_G)].map((m) => m[0]).slice(0, 1);'));
  ok(mut && typeof mut.fn === 'function', 'E2-5 锚定变异体构造成功');
  if (mut && mut.fn) {
    const m1 = mut.fn(orch);
    const m2 = mut.fn(senior);
    ok(m1.reason === 'bad_tz',
      '🔴 E2-5 变异后（整段取第一个）orch → **bad_tz** ⇒ E2-2 那条会红'
      + ' —— 这正是要防的那种失效', JSON.stringify(m1));
    ok(m2.reason === 'bad_tz',
      '🔴 E2-5 变异后 senior → **bad_tz** ⇒ E2-2 那条会红', JSON.stringify(m2));
    // ★ 而变异体在**单行样本**上行为不变 —— 这就是老测试抓不到它的原因
    ok(mut.fn(lineOnly).tz === 'America/Los_Angeles',
      '🔴 E2-5 ★ 而变异体在**单行样本**上行为**完全不变** ⇒ '
      + '**旧测试对这个变异是瞎的** —— 一条测试覆盖了什么，写在它的构造方式里',
      JSON.stringify(mut.fn(lineOnly)));
  }
}

function main() {
  console.log('\n══ watchdog rate_limited 出口（任务 E）══════════════\n');
  positiveControls();
  groupE();
  groupC();
  groupB();
  groupMutation();
  groupE2();
  groupX();
  console.log(`\n${'─'.repeat(50)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
