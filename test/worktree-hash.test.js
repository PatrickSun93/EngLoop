'use strict';

/**
 * `lib/tree-fingerprint.js` —— 「这次运行期间，工作区变过吗？」的那个指纹。
 *
 * ── 🔴 为什么不能只哈希 porcelain ────────────────────────────
 *   `md5(git status --porcelain)` 不够：porcelain 的一行逐字是
 *   ` M test/poll-parse.test.js` —— **里面没有内容字段**。
 *   ⇒ ⇒ 一个**本来就是 `M`** 的文件再改一次，输出逐字节相同 ⇒ 指纹相同
 *   ⇒ ⇒ ⇒ `worktree_changed_during_run` 报 `false`，而工作区确实变过。
 *
 *   比如全量起跑十几秒后有人改了一个已经是 `M` 的文件：那一遍报 `false`，
 *   而总数**也**可能跟预测一致 ——
 *   ★ 两个确认都说「干净」，而它们**不是两个证据**：它们共享同一个盲区。
 *
 * ── 🔴 这一组为什么必须**成对** ─────────────────────────────────────
 *   只验「内容变了 ⇒ 指纹变」的话，一个**每次都返回随机值**的实现照样全绿 ——
 *   而它在生产里的后果是 `during_run` **每一遍都报 true** ⇒ 等于把这个检查关掉。
 *   ⇒ 所以【2】（什么都不改 ⇒ **不变**）跟【3】是一对，缺哪半哪半恒真。
 *
 *   而【4】是另一种成对：**把旧实现放回同一个夹具**，它必须**看不见** ——
 *   否则【3】证明不了「现在的实现补上了什么」，只证明「现在的实现能过现在的判据」。
 *
 * ── ⚠️ 【4】里那份「旧实现」是**复刻**的（三行），而这里可以复刻 ────────
 *   复刻件平时不能当判据（它验的是复刻件）。而这一格例外，**理由是方向**：
 *
 *   ★ **它 fail 的方向是安全的。**
 *     复刻件跟真旧版分叉了 ⇒ 它**更可能看得见**那个改动 ⇒ 【4】**会红**，
 *     而不会假绿。⇒ ⇒ 所以「复刻件能不能代表真旧版」这个问题，
 *     在**这个方向上**不需要答案。
 *
 *   🔴 而它自带一个失效条件，写出来免得下一个人越过它：
 *     **这条理由只对「断言旧实现**看不见** X」成立。**
 *     哪天有人拿这份复刻的旧实现去断言「它**能**看见 Y」——
 *     理由当场失效，而**那一行代码一个字都不用变** ⇒ 没有任何提示。
 *
 *   （不说「它是被推翻的对象，不是被验的对象」——
 *     那句听起来像**一个关于对象的性质**，于是它没有失效条件；
 *     而「方向」这个说法自带一个。）
 *
 * 单跑：`node test/worktree-hash.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { worktreeHash } = require('../lib/tree-fingerprint');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const ok = (c, l, d = '') => (c
  ? (pass += 1, console.log(`  ✓ ${l}`))
  : (fail += 1, console.log(`  ✗ ${l}${d ? `  → ${d}` : ''}`)));

/** 🔴 被推翻的那个实现，逐字复刻 —— 见文件头「这里可以复刻」那一节。 */
function oldHash(cwd) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return crypto.createHash('md5').update(r.stdout || '').digest('hex');
}

/** 那两个版本 —— 优先拿**真实的仓库对象**；拿不到就退成构造的，**并且说出口**。 */
function incidentBlobs() {
  const show = (rev) => {
    const r = spawnSync('git', ['show', `${rev}:test/poll-parse.test.js`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return (r.status === 0 && typeof r.stdout === 'string' && r.stdout.length > 100)
      ? r.stdout : null;
  };
  const before = show('96f7392');   // 基线 commit（24 条那版）
  const after = show('6f3a6cc');    // 改动后的 commit（36 条那版）
  if (before && after && before !== after) return { before, after, real: true };
  return {
    before: '// 构造的基线\nmodule.exports = 1;\n',
    after: '// 构造的改动\nmodule.exports = 2;\n',
    real: false,
  };
}

const tmpRepos = [];
function makeRepo(seedText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-wthash-'));
  tmpRepos.push(dir);
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@engloop.local');
  git('config', 'user.name', 'engloop-test');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'subject.js'), seedText);
  git('add', '-A');
  const c = git('commit', '-qm', 'base');
  return { dir, git, committed: c.status === 0 };
}

function main() {
  console.log('\n══ `lib/tree-fingerprint.js` · 工作区指纹（内容，不只是状态）══\n');

  const blobs = incidentBlobs();

  console.log('【1】（前提）夹具本身立得住 —— 否则下面每一条都可能是恒真');
  const { dir, git, committed } = makeRepo(blobs.before);
  const subject = path.join(dir, 'test', 'subject.js');
  ok(committed, '临时仓库建起来了，而且有一个 commit');
  // ★ 出处**不是断言** —— 它没有「不成立」的那一侧，写成 ok() 就是一条恒真的绿。
  //   ⇒ 它是**来源标签**：读结果的人要知道这一遍验的是①档还是②档。
  console.log(blobs.real
    ? '  ▸ 夹具出处 **①档**：两个真实的仓库对象'
      + '（两个真实 commit 里的 `test/poll-parse.test.js`）'
    : '  ▸ 夹具出处 **②档**：那两个 commit 取不到，内容是**构造**的 —— '
      + '判据仍然成立，而它验的是「构造的人想到的那一种」');

  const h0 = worktreeHash(dir);
  const o0 = oldHash(dir);
  ok(typeof h0 === 'string' && h0.length === 32, '干净的仓库拿得到一个指纹', String(h0));

  console.log('\n【2】🔴 什么都不改 ⇒ 指纹**不变** —— 缺了它，一个每次随机的实现也能过');
  ok(worktreeHash(dir) === h0,
    '连查两次，指纹一致（否则 `during_run` 每一遍都报 true ⇒ 等于把这个检查关掉）');

  console.log('\n【3】clean → M ⇒ 变（这一格旧实现也抓得到，验的是没退化）');
  fs.writeFileSync(subject, blobs.after);
  const h1 = worktreeHash(dir);
  const o1 = oldHash(dir);
  const porcelain1 = git('status', '--porcelain').stdout;
  ok(h1 !== h0, '文件从 clean 变成 M ⇒ 指纹变了');
  ok(o1 !== o0, '（对照）旧实现在这一格**也**抓得到 —— 所以它不是「什么都抓不到」');

  console.log('\n【4】🔴🔴 ★ 关键那一格：**已经是 `M` 的文件，再改一次内容**');
  fs.writeFileSync(subject, `${blobs.after}\n// +1 行\n`);
  const h2 = worktreeHash(dir);
  const o2 = oldHash(dir);
  const porcelain2 = git('status', '--porcelain').stdout;
  // 🔴 这条前提**必须比两次的真实输出**，不能比一个自己拼出来的期望串 ——
  //   拼出来的那种，写错了也照样绿（而这一整格的意义就是「porcelain 没变」）。
  ok(porcelain1 === porcelain2 && porcelain1.trim().length > 0,
    '（前提）两次改动之间 porcelain **逐字节相同**，而且非空 —— '
    + '这一格的全部意义就在这里：**状态没变，只有内容变了**',
    `${JSON.stringify(porcelain1)} vs ${JSON.stringify(porcelain2)}`);
  ok(h2 !== h1,
    '🔴 ★ 内容变了 ⇒ **指纹变了** —— 而这正是只看状态的实现漏掉的那一格',
    `${String(h1).slice(0, 8)} vs ${String(h2).slice(0, 8)}`);
  ok(o2 === o1,
    '★★ 而**旧实现**在同一个夹具上 **看不见**（指纹相同）⇒ 上一条不是恒真，'
    + '它抓的正是旧实现漏掉的那一格',
    `${String(o1).slice(0, 8)} vs ${String(o2).slice(0, 8)}`);

  console.log('\n【5】新增未跟踪文件 ⇒ 变；而它**内容**再变 ⇒ 🔴 **看不见**（已知射程，不是 bug）');
  const stray = path.join(dir, 'stray.txt');
  fs.writeFileSync(stray, 'a');
  const h3 = worktreeHash(dir);
  ok(h3 !== h2, '多了一个未跟踪文件 ⇒ 指纹变了（porcelain 的 `??` 行）');
  fs.writeFileSync(stray, 'bbbbbbbbbbbb');
  ok(worktreeHash(dir) === h3,
    '🔴 ⚠️ **未跟踪文件的内容变了，指纹不变** —— 这是**明说的射程**：'
    + 'porcelain 只打 `?? path`，而 `git diff HEAD` 看不到未跟踪文件。'
    + '补它要哈希未跟踪文件内容，而那个数量不可控（见 `lib/tree-fingerprint.js` 头）');

  console.log('\n【6】🔴 「查不了」必须是 `null` —— 不许降级成「没变」');
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-notrepo-'));
  tmpRepos.push(notRepo);
  ok(worktreeHash(notRepo) === null,
    '不是 git 仓库 ⇒ **`null`**（一个字符串会被上层当成一个合法指纹，于是「查不了」变成「没变」）',
    String(worktreeHash(notRepo)));

  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-emptyrepo-'));
  tmpRepos.push(emptyRepo);
  spawnSync('git', ['init', '-q'], { cwd: emptyRepo, encoding: 'utf8' });
  ok(worktreeHash(emptyRepo) === null,
    '⚠️ 一个 commit 都没有的仓库 ⇒ 也是 `null`（`git diff HEAD` 无 HEAD 可比）—— '
    + '**这是有意的行为变化**：旧实现在这种仓库里出得了数',
    String(worktreeHash(emptyRepo)));

  console.log('\n【7】分隔符 —— 两段拼接之间要有一个不会出现在任一段里的字节');
  ok(/update\(status \+ '\\u0000' \+ diff\)/.test(
    fs.readFileSync(path.join(ROOT, 'lib', 'tree-fingerprint.js'), 'utf8')),
  '⚠️ **存在型**（读源码）：`status` 和 `diff` 之间用 NUL 隔开 —— '
    + '没有它，两组不同的 (status, diff) 能拼出同一个串。'
    + '效果型要造一对真的碰撞夹具，代价远大于收益，退档写在这里');

  for (const d of tmpRepos) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 已经没了 */ }
  }

  console.log(`\n${'─'.repeat(50)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
