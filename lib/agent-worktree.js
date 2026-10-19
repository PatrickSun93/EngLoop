'use strict';

/**
 * agent 的 git worktree：自动建（`bin/agent-start.js --worktree`）＋ 本地合并（`bin/wt-merge.js`）。
 *
 * ── 为什么要自动建 ──────────────────────────────────────────────────────
 *   手建的 worktree 会停在旧 commit、越落越远；起 agent 前要人记得去建、去更新。
 *   所以由 agent-start 负责建。
 *
 * ── 为什么合并走本地，不走 PR ───────────────────────────────────────────
 *   agent worktree 的合并**以 verify-complete 的结论为闸、离线进行**：闸是 verify-complete
 *   那个独立进程核出来的 `pass`，按 sha 落在 agent 写不到的地方（`temp/verify-cache/verdicts/`）。
 *   这里**不推送、不开 PR**。
 *
 * ── 已存在的 worktree 一律不动 ──────────────────────────────────────────
 *   不 reset、不 rebase、不 pull：里面可能有没合的活。落后 main 只打一行提示，怎么处理由人 / 编排者定。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { worktreesDir } = require('./agent-settings');
const sandbox = require('./sandbox-profile');

/** 分支名约定：`wt/<name>`。名字的合法性由调用方（agent-start 的 tmux.validName）先查过。 */
const branchFor = (name) => `wt/${name}`;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * 框架的 git 调用。带 GIT_HARDEN（`-c core.fsmonitor=false -c core.hooksPath=/dev/null …`）——
 * worktree 里的东西是 agent 写的，框架跑 git 时不执行任何 repo 里配置出来的程序。
 */
function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...sandbox.GIT_HARDEN, ...args],
    { encoding: 'utf8', env: { ...process.env, ...sandbox.GIT_HARDEN_ENV } });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

function checkName(name) {
  if (!NAME_RE.test(String(name || ''))) throw new Error(`worktree 名字不合法：${JSON.stringify(name)}（字母数字开头，只含字母数字 _ -）`);
}

/**
 * 确保 `<worktreesDir>/<name>` 存在。
 * @returns {{ path, branch, created: boolean, behind: number|null, note?: string }}
 *   behind = 这棵树的 HEAD 落后 mainRef 多少个 commit（算不出 ⇒ null，不当成 0）
 */
function ensureWorktree({ root, name, mainRef = 'main', dir = null }) {
  checkName(name);
  const wtPath = path.resolve(dir || path.join(worktreesDir(root), name));
  const branch = branchFor(name);
  if (fs.existsSync(wtPath)) {
    // 在，但不是 git 工作树 ⇒ 不碰它（可能是别人的目录），报错让人看
    const top = git(wtPath, ['rev-parse', '--show-toplevel']);
    if (!top.ok || path.resolve(top.out) !== fs.realpathSync(wtPath)) {
      throw new Error(`${wtPath} 已存在，但不是一棵 git worktree 的根 —— 不动它。挪走它，或用 --cwd 指定别的目录`);
    }
    const behind = git(wtPath, ['rev-list', '--count', `HEAD..${mainRef}`]);
    return { path: wtPath, branch: git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']).out, created: false,
      behind: behind.ok ? Number(behind.out) : null };
  }
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  // 分支已经在（worktree 目录被删过、分支留着）⇒ 检出那条分支，**不新建、不重置** —— 上面可能有没合的提交
  const hasBranch = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  const r = hasBranch
    ? git(root, ['worktree', 'add', wtPath, branch])
    : git(root, ['worktree', 'add', '-b', branch, wtPath, mainRef]);
  if (!r.ok) throw new Error(`git worktree add 失败：${r.err || r.out}`);
  const behind = git(wtPath, ['rev-list', '--count', `HEAD..${mainRef}`]);
  return { path: wtPath, branch, created: true, behind: behind.ok ? Number(behind.out) : null,
    note: hasBranch ? `分支 ${branch} 原来就在，检出了它（没有从 ${mainRef} 重建）` : undefined };
}

/**
 * 合并 `wt/<name>` 进主仓库当前检出的 mainRef。三道闸，按顺序：
 *   ① 调用者是编排者（`ENGLOOP_AGENT_TYPE` 不是别的类型）—— **友好的第一道**，环境变量是可以伪造的；
 *     真正的墙是 agent 的 sandbox 写不到主仓库的 `.git`。
 *   ② `wt/<name>` 的 HEAD 有一条 verify-complete 的 **pass** 记录（按 sha），而且那次跑的是**全量**
 *     （tests 是 agent 自己选的，`--only` 的 pass 不算；`allowPartial` 明说才放行，message 里写明）
 *   ③ 主仓库工作树里没有跟这次要合的文件**有交集**的未提交改动（另一个会话可能正在改）
 * 然后 `git merge --no-ff`，commit message 带 verify 记录的摘要。冲突 ⇒ `merge --abort`、报出冲突文件。
 *
 * @returns {{ ok: boolean, code: string, message: string, merged?: string }}
 *   code: merged | not_orchestrator | no_branch | no_verify | verify_not_pass | verify_partial | not_on_main | overlap | conflict | merge_failed | git_error
 */
function mergeWorktree({ root, name, mainRef = 'main', cacheRoot, readVerdict, isFullSuite, allowPartial = false, env = process.env }) {
  checkName(name);
  const branch = branchFor(name);
  const fail = (code, message) => ({ ok: false, code, message });

  // ① 调用者
  const who = env.ENGLOOP_AGENT_TYPE;
  if (who && who !== 'orchestrator') {
    return fail('not_orchestrator', `wt-merge 只给编排者用（当前 ENGLOOP_AGENT_TYPE=${who}）。`
      + ' 做完了就写 outbox 报给编排者、附 evidence —— 合并由它来跑。');
  }

  const sha = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (!sha.ok || !sha.out) return fail('no_branch', `主仓库里没有分支 ${branch}。worktree 是 \`node bin/agent-start.js --name ${name} --worktree\` 建的吗？`);

  // ② verify 记录
  const wtPath = path.join(worktreesDir(root), name);
  const verifyHint = `先核：写一份 evidence（{"kind":"code","repo":${JSON.stringify(wtPath)},"commit":"${sha.out}","tests":"node test/run-all.js"}）`
    + '，跑 `node bin/verify-complete.js --evidence <那个文件>`；pass 了再来合。';
  const v = readVerdict(cacheRoot, sha.out);
  if (!v) return fail('no_verify', `${branch} 的 HEAD ${sha.out.slice(0, 12)} 没有 verify-complete 的记录。${verifyHint}`);
  if (v.verdict !== 'pass') {
    return fail('verify_not_pass', `${branch} 的 HEAD ${sha.out.slice(0, 12)} 的核验结论是 ${v.verdict}（${v.at}），不是 pass：`
      + `${(v.missing || []).slice(0, 3).join('；') || '没写原因'}。修好、提交、再核。`);
  }
  // ★ isFullSuite 由调用方传进来（bin/wt-merge.js 传 verify-complete 的那一个）—— 不传就没法判，**拒**，不当成全量。
  const full = typeof isFullSuite === 'function' && isFullSuite(v.tests);
  if (!full && !allowPartial) {
    return fail('verify_partial', `${branch} 的 HEAD ${sha.out.slice(0, 12)} 的 pass 跑的是 ${JSON.stringify(v.tests || '(未记录)')}，不是全量 —— `
      + 'tests 是干活的人自己选的，范围小的 pass 不能当合并的闸。'
      + `用全量重核：evidence 的 tests 写 "node test/run-all.js"，跑 \`node bin/verify-complete.js --evidence <文件>\`。`
      + '确认只要这个范围：加 --allow-partial（会写进 commit message）。');
  }

  // ③ 主仓库：在 mainRef 上 ＋ 未提交改动跟这次的文件没有交集
  const cur = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!cur.ok || cur.out !== mainRef) {
    return fail('not_on_main', `主仓库当前检出的是 ${cur.out || '(detached)'}，不是 ${mainRef} —— wt-merge 只往 ${mainRef} 合。`);
  }
  const files = git(root, ['diff', '--name-only', `${mainRef}...${branch}`]);
  if (!files.ok) return fail('git_error', `算不出要合的文件：${files.err}`);
  const incoming = new Set(files.out ? files.out.split('\n') : []);
  // porcelain v1 -z：`XY path\0`，重命名多一段原路径。两边都算「在改」。
  const st = spawnSync('git', ['-C', root, ...sandbox.GIT_HARDEN, 'status', '--porcelain', '-z', '--untracked-files=all'],
    { encoding: 'utf8', env: { ...process.env, ...sandbox.GIT_HARDEN_ENV } });
  if (st.status !== 0) return fail('git_error', `git status 失败：${st.stderr}`);
  const dirty = [];
  const parts = String(st.stdout).split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2);
    dirty.push(parts[i].slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') dirty.push(parts[++i]);
  }
  const overlap = dirty.filter((f) => incoming.has(f));
  if (overlap.length) {
    return fail('overlap', `主仓库有未提交的改动碰到了这次要合的文件：${overlap.slice(0, 10).join('、')}${overlap.length > 10 ? ` …共 ${overlap.length} 个` : ''}`
      + ' —— 可能有别的会话正在改。等它提交，或者确认后自己处理掉，再合。');
  }

  // 合并
  const msg = [
    `wt-merge: ${branch} (${sha.out.slice(0, 12)})`,
    '',
    `verify-complete: ${v.verdict} · ${v.at}${v.ms ? ` · ${Math.round(v.ms / 1000)}s` : ''}`,
    `tests: ${v.tests || '(未记录)'}${full ? '' : '（不是全量，--allow-partial）'}`,
    ...(v.checks || []).slice(0, 12),
  ].join('\n');
  const m = git(root, ['merge', '--no-ff', '-m', msg, branch]);
  if (!m.ok) {
    const conflicts = git(root, ['diff', '--name-only', '--diff-filter=U']).out;
    git(root, ['merge', '--abort']);
    // 有冲突文件 ⇒ conflict；没有 ⇒ 合并本身失败（比如写不了工作树 —— agent 在 sandbox 里调它时就是这个）。
    //   两种的修法不一样，不能都叫「冲突」。
    if (!conflicts) return fail('merge_failed', `合并没成（已 merge --abort）：${(m.err || m.out).split('\n').slice(0, 3).join(' ')}`);
    return fail('conflict', `合并没成（已 merge --abort，主仓库回到合并前）：冲突文件 ${conflicts.split('\n').join('、')}`
      + `。在 worktree 里把 ${mainRef} 合进 ${branch}、解决冲突、重新核验，再来。`);
  }
  return { ok: true, code: 'merged', merged: git(root, ['rev-parse', 'HEAD']).out, message: `已合并 ${branch}（${sha.out.slice(0, 12)}）进 ${mainRef}` };
}

module.exports = { ensureWorktree, mergeWorktree, branchFor };
