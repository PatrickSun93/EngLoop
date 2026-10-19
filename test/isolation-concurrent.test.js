'use strict';

/**
 * `test/isolation.test.js` **同时跑两个，不许互撞**。
 *
 * ── 🔴 它守的是什么 ────────────────────────────
 *   写死测试库号（比如 `ENGLOOP_TEST_DB: '13'`、`const D = 1`）的话，
 *   两个实例同时跑 ⇒ 同一个号、同一把锁，而【5e–5h】还会 `rmSync` 那把锁
 *   ⇒ ⇒ **必然互相破坏**。而它跟机器负载**毫无关系**：空闲机器上并发跑两遍照样挂。
 *
 *   它只在有人**同时**跑全量时触发 ——
 *   ★ **「大家排队跑全量」这个习惯，正好挡住了它唯一的触发条件。**
 *
 *   而它在全量里的样子：`execFileSync` 抛 ⇒ 未捕获 ⇒ **整个文件死**
 *   ⇒ `broken 1 · silent [...]` ⇒ 全量少一整个文件的条数，而**总数看起来仍像个正常的数**。
 *
 * ── ⚠️ 射程：这条只验到并发 **2** ─────────────────────────────────
 *   真实上界是 **2 ＋ 其他并发全量的遍数**。
 *   而预约池是 15 个号 ⇒ 够用。**这里不验到 5，是因为代价换不来信息**。
 *
 * ── ⚠️ 变异为什么**安全** ────────────────────────────────────────
 *   变异只删掉「预约」那一步（`tryClaimLock`），**保留生产锁检查** ——
 *   ⇒ 于是两个变异体会撞在一起，而它们**不会去抢别人正在用的号**。
 *   变异体写在 `test/.isolation-mutant-<pid>.js`（**不以 `.test.js` 结尾**
 *   ⇒ `run-all` 发现不到它），跑完删掉。
 *
 * 单跑：`node test/isolation-concurrent.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SUBJECT = path.join(__dirname, 'isolation.test.js');
const MUTANT = path.join(__dirname, `.isolation-mutant-${process.pid}.js`);

// 变异锚点：**预约**那一步。删掉它 = 回到写死库号的行为。
const CLAIM_LINE = '    if (!q.tryClaimLock(claimPathFor(n))) { byOthers += 1; continue; }\n';

let pass = 0;
let fail = 0;
const ok = (c, l, d = '') => (c
  ? (pass += 1, console.log(`  ✓ ${l}`))
  : (fail += 1, console.log(`  ✗ ${l}${d ? `  → ${d}` : ''}`)));

/** 起一个子进程，记下它**自己**的起止时刻（重叠这件事要靠测量，不能靠「我同时起的」）。 */
function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const ch = spawn(process.execPath, [file], { cwd: ROOT, encoding: 'utf8' });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    ch.on('close', (code) => {
      const m = out.match(/通过 (\d+) · 失败 (\d+)/);
      resolve({
        code,
        started,
        ended: Date.now(),
        passed: m ? Number(m[1]) : null,
        failed: m ? Number(m[2]) : null,
        tail: out.slice(-260),
      });
    });
  });
}

const bothAt = (file) => Promise.all([runOne(file), runOne(file)]);
const overlaps = (a, b) => a.started < b.ended && b.started < a.ended;
const claimLeftovers = () => fs.readdirSync(os.tmpdir())
  .filter((f) => f.startsWith('engloop-isolation-claim-'));

async function main() {
  console.log('\n══ `isolation.test.js` 并发自检 ══\n');

  const src = fs.readFileSync(SUBJECT, 'utf8');

  console.log('【1】（前提）变异锚点唯一命中 —— 一个没改到的变异会让【4】恒绿');
  const hits = src.split(CLAIM_LINE).length - 1;
  ok(hits === 1, `变异锚点（预约那一行）命中 ${hits} 次，应当 1`, String(hits));
  if (hits !== 1) { console.log('  ⛔ 锚点没命中 ⇒ 后面的变异是假的，直接停'); process.exit(1); }

  const before = claimLeftovers().length;
  console.log(`  ▸ 起跑前 tmpdir 里的预约文件：${before} 个（跑完要回到这个数）`);

  // ── 🔴 基线**当场量**，不写死 ────────────────────────────────────
  //   把「通过 N」抄进断言的话，`isolation.test.js` 一加断言
  //   ⇒ ⇒ **判据就红，而被测的东西一点问题都没有**（一个正确的假红）。
  //   ★ 那是「一个值两个副本」：**别人文件里的断言数，在这里抄了一份**。
  //   ⇒ 所以这里先**串行跑一遍**拿基线，下面再要求并发的两个跟它一致 ——
  //     于是这条判据问的是「**并发有没有让它变少**」，而不是「它是不是 N」。
  console.log('\n【2】🔴 基线：先**单独**跑一遍（并发的两个要跟它一模一样）');
  const base = await runOne(SUBJECT);
  ok(base.code === 0 && base.passed > 0 && base.failed === 0,
    `（基线）单跑 ⇒ 通过 ${base.passed} · 失败 ${base.failed}`,
    `code=${base.code} · ${base.tail}`);

  // ── 🔴 而基线**只活在「并发」这个变量之外，不活在「代码」之外** ──────────
  //
  //   假设 `isolation.test.js` **自己**退化成只跑 40 条
  //   ⇒ 基线 = 40 · 并发两个 = 40 / 40 ⇒ **全部等于 base** ⇒ **绿**。
  //   ⇒ ⇒ 而那一遍里「并发有没有让它变少」的答案确实是「没有」——
  //     **判据答对了它被问的问题**，而被测对象整体缩水了它一点感觉都没有。
  //
  //   ✅ 所以补一条**下界**。而这个数**故意不精确** ——
  //     写精确的话它就变回 `a.passed === N` 那种写死基线的毛病：
  //     别人给 `isolation.test.js` 加一条判据，这里就红，而被测的东西没问题。
  //   ⇒ 它红的时候，信息是：**isolation 缩水了一半，先去看它，别看并发。**
  ok(base.passed > 50,
    `（前提）串行基线本身没退化：通过 ${base.passed} > 50 —— `
    + '这个数**故意不精确**：它挡的是「整体缩水」，不是「少了几条」',
    String(base.passed));

  console.log('\n【3】🔴 ★ 同时跑两个 —— 两个都要活着走完');
  const [a, b] = await bothAt(SUBJECT);
  ok(overlaps(a, b),
    '（前提）两个子进程的运行区间**真的重叠** —— 否则这条判据根本没测到并发',
    `A ${a.started}→${a.ended} · B ${b.started}→${b.ended}`);
  ok(a.code === 0 && b.code === 0,
    '🔴 ★ 两个都退 0（没有预约那一步时，几乎每轮至少一个挂）',
    `A=${a.code} B=${b.code} · ${a.code ? a.tail : b.tail}`);
  ok(a.passed === base.passed && a.failed === 0
     && b.passed === base.passed && b.failed === 0,
  `🔴 ★ 而且两个都跟基线一样报 **通过 ${base.passed} · 失败 0** —— `
    + '只验退出码的话，一个**半路 return 的空跑**也是 0；'
    + '而基线是**本轮现量的**，不是抄来的数',
  `基线=${base.passed} · A=${a.passed}/${a.failed} B=${b.passed}/${b.failed}`);

  console.log('\n【4】★★ 变异（负控）：删掉「预约」那一步 ⇒ 回到没有预约时的行为');
  fs.writeFileSync(MUTANT, src.replace(CLAIM_LINE,
    '    // ★★ 变异：预约那一步被删掉了\n'));
  let rounds = 0;
  let broke = false;
  let last = null;
  try {
    // ★ 重试上限 3：这个变异几乎每轮都会挂，而它毕竟是并发时序 ——
    //   **给它三次机会，比让一条判据偶发红好**；而用了几轮会打出来。
    while (rounds < 3 && !broke) {
      rounds += 1;
      const [m1, m2] = await bothAt(MUTANT);
      last = `A=${m1.code} B=${m2.code}`;
      broke = m1.code !== 0 || m2.code !== 0;
    }
  } finally {
    fs.rmSync(MUTANT, { force: true });
  }
  ok(broke,
    `★★ 变异版**至少一个挂**（用了 ${rounds} 轮，上限 3）⇒ `
    + '于是【2】不是恒真：它抓的正是「两份同时跑互相踩」',
    `最后一轮 ${last}`);

  console.log('\n【5】跑完不留垃圾');
  const after = claimLeftovers();
  ok(after.length === before,
    `预约文件回到起跑前的数（${before}）—— 留下来的话会**永久占掉一个号**`,
    JSON.stringify(after));
  ok(!fs.existsSync(MUTANT), '变异体文件已删');

  console.log(`\n${'─'.repeat(50)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  fs.rmSync(MUTANT, { force: true });
  console.error('✗ 异常:', e.stack || e.message);
  process.exit(1);
});
