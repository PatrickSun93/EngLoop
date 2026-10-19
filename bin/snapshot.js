#!/usr/bin/env node
'use strict';

/**
 * 跑全量测试前后各拍一次快照，证明**跑的时候底下没人动**。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 *   **读取结果只在被读对象静止时才有意义。**
 *
 * 多个 agent 同时在写这个仓库，一次全量要跑几分钟。期间任何一个文件被改，
 * 那个「基线」就是**拿两个版本的代码拼出来的** —— 而它打印出来的样子，
 * 跟一个干净基线一模一样。
 *
 * 「跑的时候没人动」这个假设，在这个项目里**不成立**，只是不去证伪就看不出来：
 * 几分钟里另一个 agent 改了几个 `lib/` 文件、或正在落地一批新模板，都很平常。
 *
 * ── 它不是测试，别放进 test/ ────────────────────────────────────
 * 它是**给人用的工具**，跟 `preflight.sh` `bus-restart.js` 一类。
 * 放进 `test/` 会被 `run-all.js` 当成测试文件捡走。
 *
 * 用法:
 *   node bin/snapshot.js before   拍快照
 *   node test/run-all.js          跑全量
 *   node bin/snapshot.js after    对比；无变动 exit 0，有变动 exit 2
 *
 * 退出码分三种，**不要合并**：
 *   0  没变动 —— 这次的结果是静止状态下测出来的
 *   1  没有 before 快照 —— **「无法判断」，不是「没变动」**
 *   2  有变动 —— 结果是拼出来的，别当基线用
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 观察范围：所有会影响测试结果的源码和模板。`node_modules` 不看（它不该变），
// `temp/` 不看（它本来就一直在变，包括这个快照文件自己）。
const DIRS = ['lib', 'bin', 'test', 'templates', 'hooks', 'config', 'protocols'];
const SNAP = path.join(ROOT, 'temp', 'snap-before.json');

function walk(dir, out = {}) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return out; }   // 目录不存在就是没有文件，不是错误
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); continue; }
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }  // 刚被删掉，下一轮 diff 会看到
    // mtime + size 两个一起看：有些编辑器会保住 mtime，但内容改了 size 多半会变。
    out[path.relative(ROOT, p)] = `${st.mtimeMs}:${st.size}`;
  }
  return out;
}

function take() {
  const out = {};
  for (const d of DIRS) walk(path.join(ROOT, d), out);
  return out;
}

const mode = process.argv[2];

if (mode === 'before') {
  const snap = take();
  fs.mkdirSync(path.dirname(SNAP), { recursive: true });
  fs.writeFileSync(SNAP, JSON.stringify(snap));
  console.log(`快照已记录：${Object.keys(snap).length} 个文件`);
  process.exit(0);
}

if (mode === 'after') {
  if (!fs.existsSync(SNAP)) {
    // ★ fail-closed：**一个检查工具自己缺证据时，绝不能给出「没问题」这个结论。**
    //   报「无法判断」而不是「没变动」—— 后者是一个关于世界的断言，
    //   而缺证据时没资格做那个断言。
    console.error(`✗ 找不到 before 快照（${path.relative(ROOT, SNAP)}）`);
    console.error('  **这是「无法判断」，不是「没变动」。** 先跑 `node bin/snapshot.js before`。');
    process.exit(1);
  }

  const before = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  const after = take();
  const changed = [], added = [], removed = [];
  for (const [f, v] of Object.entries(after)) {
    if (!(f in before)) added.push(f);
    else if (before[f] !== v) changed.push(f);
  }
  for (const f of Object.keys(before)) if (!(f in after)) removed.push(f);

  if (!changed.length && !added.length && !removed.length) {
    console.log(`✓ 期间 ${Object.keys(after).length} 个文件一个都没动`);
    console.log('  —— 这次的结果是**静止状态下**测出来的，可以当基线。');
    process.exit(0);
  }

  console.log('⚠ **期间有文件变动 —— 这次的结果是拿两个版本拼出来的：**');
  for (const f of changed.sort()) console.log(`   改动  ${f}`);
  for (const f of added.sort()) console.log(`   新增  ${f}`);
  for (const f of removed.sort()) console.log(`   删除  ${f}`);
  console.log('  **别把它当基线。** 等写的人落地之后重跑。');
  process.exit(2);
}

console.error('用法: node bin/snapshot.js before|after');
console.error('  before  跑全量之前拍一次');
console.error('  after   跑完对比；无变动 exit 0 · 无 before 快照 exit 1 · 有变动 exit 2');
process.exit(1);
