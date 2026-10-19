#!/usr/bin/env node
'use strict';

/**
 * 把一棵 agent worktree（分支 `wt/<name>`）合进 main —— **本地、离线、以 verify 记录为闸**。
 * 判据在 `lib/agent-worktree.js` 的 mergeWorktree（bin/ 测不到）。
 *
 * 用法：
 *   node bin/wt-merge.js <name>                     合 wt/<name>
 *   node bin/wt-merge.js <name> --main <ref>        基线分支（默认 main）
 *   node bin/wt-merge.js <name> --repo <dir>        主仓库（默认这份 EngLoop；测试用）
 *   node bin/wt-merge.js <name> --allow-partial     verify 的 pass 不是全量也合（打警告，写进 commit message）
 *
 * 闸（任何一道不过 ⇒ 不合、非零退出、说清怎么办）：
 *   ① 调用者是编排者（ENGLOOP_AGENT_TYPE 不是别的类型）            exit 4
 *   ② wt/<name> 的 HEAD 有 verify-complete 的 pass 记录（按 sha），且跑的是全量    exit 3
 *   ③ 主仓库在 main 上、未提交改动跟要合的文件没有交集              exit 5
 *   合并冲突 / 合并本身失败 ⇒ merge --abort                          exit 6
 *
 * ⚠️ 不推送、不开 PR —— 那是另一件事。
 * 环境：ENGLOOP_VERIFY_CACHE（verify 记录的根，默认 temp/verify-cache —— 跟 verify-complete 同一个）。
 */

const path = require('node:path');
const { mergeWorktree } = require('../lib/agent-worktree');
const V = require('../lib/verify-complete');

const argv = process.argv.slice(2);
function opt(flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) { console.error(`wt-merge: ${flag} 后面要跟一个值`); process.exit(2); }
  return v;
}
const name = argv.find((a, i) => !a.startsWith('--') && !['--main', '--repo'].includes(argv[i - 1]));
if (!name) {
  console.error('用法：node bin/wt-merge.js <name> [--main <ref>] [--repo <dir>]');
  process.exit(2);
}

const EXIT = { merged: 0, no_verify: 3, verify_not_pass: 3, verify_partial: 3, not_orchestrator: 4, not_on_main: 5, overlap: 5, conflict: 6, merge_failed: 6 };
const allowPartial = argv.includes('--allow-partial');
if (allowPartial) console.warn('⚠️  --allow-partial：verify 的 pass 不是全量也合 —— 范围外的回退这次核验抓不到（会写进 commit message）');
let r;
try {
  r = mergeWorktree({
    root: path.resolve(opt('--repo') || path.join(__dirname, '..')),
    name,
    mainRef: opt('--main') || 'main',
    cacheRoot: V.cacheRootFrom(),
    readVerdict: V.readVerdict,
    isFullSuite: V.isFullSuite,
    allowPartial,
  });
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(2);
}
if (r.ok) console.log(`✓ ${r.message}（${r.merged.slice(0, 12)}）`);
else console.error(`✗ [${r.code}] ${r.message}`);
process.exit(EXIT[r.code] !== undefined ? EXIT[r.code] : 1);
