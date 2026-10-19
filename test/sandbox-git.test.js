'use strict';

/**
 * sandbox 里的测试改不了 `.git`，框架在 sandbox 外跑 git 时也不执行它配的命令。
 *
 * 要防的形状：测试在 sandbox 里 `git config core.fsmonitor '<往白名单外写标记>'` ⇒ 下一回合 hook 的 `git status`
 * 在 sandbox 外执行 fsmonitor ⇒ 标记写出来。防线两层：profile 抠掉 `.git` 的 config/hooks；框架 git 调用一律 `-c core.fsmonitor=false -c core.hooksPath=/dev/null`。
 *
 * 【0】两层各自的单元断言（关键断言，变异要能红）。
 * 【1】绿在修之后（在当前代码上）：三个变体 —— .git/config 的 fsmonitor、.git/hooks/post-checkout、linked worktree 的 .git 指针改写 —— 标记都不出现。
 *     「红在修之前」= profile 没抠 .git、git 调用没带 -c 时这几条会红（不在 CI 里回放旧 commit）。
 *
 * 夹具在 os.tmpdir() 之下；标记目录在白名单外（放 $HOME 下一个名字，sandbox 没放 $HOME）。装置缺失 ⇒ 跳过（⏭）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SP = require('../lib/sandbox-profile');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

console.log('\nsandbox × .git\n');

if (!SP.available()) {
  console.log('  ⏭ 跳过整个文件：sandbox-exec 在这里套不上（多半是这个进程本身已经在 sandbox 里）');
  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  process.exit(0);
}

// ── 【0】单元 ────────────────────────────────────────────────────────────────
console.log('【0】两层的单元断言');
ok(SP.GIT_HARDEN.join(' ').includes('core.fsmonitor=false') && SP.GIT_HARDEN.join(' ').includes('core.hooksPath=/dev/null'),
  'GIT_HARDEN 关掉 fsmonitor 和 hooksPath', SP.GIT_HARDEN.join(' '));
{
  // profile：.git（subpath）被抠、config/hooks 正则被抠、index 仍可写
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbgit-u-')));
  fs.mkdirSync(path.join(base, '.git', 'hooks'), { recursive: true });
  for (const f of ['config', 'index']) fs.writeFileSync(path.join(base, '.git', f), 'x');
  fs.writeFileSync(path.join(base, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(base, 'normal.txt'), 'x');
  const prof = SP.buildProfile({ allowWrite: [base], denyRead: [], reDenyWrite: [path.join(base, '.git')], allowTmp: false });
  const pf = path.join(base, 'p.sb'); fs.writeFileSync(pf, prof);
  const probe = (rel) => {
    const argv = SP.wrap(pf, [process.execPath, '-e', `try{require('fs').appendFileSync(${JSON.stringify(path.join(base, rel))},'y');console.log('WROTE')}catch(e){console.log(e.code)}`]);
    return (spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' }).stdout || '').trim();
  };
  ok(probe('.git/config') === 'EPERM' && probe('.git/hooks/post-checkout') === 'EPERM', 'profile：.git/config、.git/hooks 被抠（EPERM）');
  ok(probe('normal.txt') === 'WROTE', 'profile：工作树里普通文件照常可写');
  fs.rmSync(base, { recursive: true, force: true });
}
{
  // reDenyWriteRegex：worktrees/<name>/config 被抠、index 不被抠（verify-complete 放 worktrees 元数据目录用的那条）
  const common = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbgit-rx-')));
  fs.mkdirSync(path.join(common, 'worktrees', 'w1'), { recursive: true });
  for (const f of ['config', 'index']) fs.writeFileSync(path.join(common, 'worktrees', 'w1', f), 'x');
  const prof = SP.buildProfile({ allowWrite: [path.join(common, 'worktrees')], denyRead: [], reDenyWriteRegex: [SP.gitExecConfigRegex(common)], allowTmp: false });
  const pf = path.join(common, 'p.sb'); fs.writeFileSync(pf, prof);
  const probe = (rel) => { const a = SP.wrap(pf, [process.execPath, '-e', `try{require('fs').appendFileSync(${JSON.stringify(path.join(common, rel))},'y');console.log('WROTE')}catch(e){console.log(e.code)}`]); return (spawnSync(a[0], a.slice(1), { encoding: 'utf8' }).stdout || '').trim(); };
  ok(probe('worktrees/w1/config') === 'EPERM' && probe('worktrees/w1/index') === 'WROTE',
    'profile：worktrees/<name>/config 被正则抠、index 不被抠（verify-complete 的元数据目录）');
  fs.rmSync(common, { recursive: true, force: true });
}

// 第二层独立验：config **不经过 sandbox**预先设好（模拟「配置来自别处」）⇒ 框架带 GIT_HARDEN 跑 git 时不执行它
{
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbgit-L2-')));
  spawnSync('git', ['-C', repo, 'init', '-q']); spawnSync('git', ['-C', repo, 'config', 'user.email', 'a@b.c']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'a']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x'); spawnSync('git', ['-C', repo, 'add', '-A']); spawnSync('git', ['-C', repo, 'commit', '-qm', 'b']);
  const mark = path.join(os.homedir(), `.engloop-sbgit-L2-${process.pid}`);
  try { fs.rmSync(mark, { force: true }); } catch (_) { /* */ }
  // 直接写进 .git/config（不经 sandbox）—— 模拟配置从别处来，第一层（抠 .git）此刻帮不上
  spawnSync('git', ['-C', repo, 'config', 'core.fsmonitor', `sh -c "echo ran > ${mark}"`]);
  spawnSync('git', ['-C', repo, ...SP.GIT_HARDEN, 'status', '--porcelain'], { env: { ...process.env, ...SP.GIT_HARDEN_ENV } });
  ok(!fs.existsSync(mark), '第二层：config 已设 fsmonitor，框架带 GIT_HARDEN 跑 git status ⇒ **不执行**它（标记不出现）', mark);
  // 阴性对照：不带 GIT_HARDEN ⇒ 标记会出现（证明这个夹具对第二层有分辨力）
  spawnSync('git', ['-C', repo, 'status', '--porcelain']);
  ok(fs.existsSync(mark), '阴性对照：不带 GIT_HARDEN 跑 git status ⇒ 标记出现（夹具对第二层有分辨力）');
  try { fs.rmSync(mark, { force: true }); } catch (_) { /* */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

// ── 夹具 ────────────────────────────────────────────────────────────────────
const MARK_DIR = os.homedir();   // 白名单外（sandbox 没放 $HOME）
function git(repo, args) { return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); }
function makeRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbgit-')));
  fs.writeFileSync(path.join(repo, 'lib.js'), 'exports.n=1;\n');
  git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 'a@b.c']); git(repo, ['config', 'user.name', 'a']);
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base']);
  return repo;
}
/** 在 repo 上套 sandbox 跑一段脚本（模拟「测试在 sandbox 里」），写集 = repo ＋ tmp，抠掉 .git ＋ config/hooks 正则。 */
function runInSandbox(repo, script) {
  const common = git(repo, ['rev-parse', '--git-common-dir']).stdout.trim();
  const gitCommon = path.resolve(repo, common);
  const prof = SP.buildProfile({
    allowWrite: [repo], denyRead: [],
    reDenyWrite: [path.join(repo, '.git')],
    reDenyWriteRegex: [SP.gitExecConfigRegex(gitCommon)],
    allowTmp: true,
  });
  const pf = path.join(repo, 'prof.sb'); fs.writeFileSync(pf, prof);
  const argv = SP.wrap(pf, [process.execPath, '-e', script]);
  return spawnSync(argv[0], argv.slice(1), { cwd: repo, encoding: 'utf8' });
}
/** 框架在 sandbox 外跑 git（带 GIT_HARDEN）。 */
function frameworkGit(repo, args) {
  return spawnSync('git', ['-C', repo, ...SP.GIT_HARDEN, ...args],
    { encoding: 'utf8', env: { ...process.env, ...SP.GIT_HARDEN_ENV } });
}

// ── 【1】三个变体：修之后标记都不出现 ────────────────────────────────────────
console.log('\n【1】三个变体（修之后标记都不出现）');

// 变体 A：fsmonitor via .git/config ⇒ 框架的 git status
{
  const repo = makeRepo();
  const mark = path.join(MARK_DIR, `.engloop-sbgit-fsmonitor-${process.pid}`);
  try { fs.rmSync(mark, { force: true }); } catch (_) { /* */ }
  const r = runInSandbox(repo, `const {execFileSync}=require('child_process');
try{execFileSync('git',['config','core.fsmonitor','sh -c "echo ran > ${mark}"'],{cwd:${JSON.stringify(repo)}});console.log('CONFIGURED')}catch(e){console.log('config',e.status,String(e.stderr||e.message).slice(0,80))}`);
  ok(/EPERM|\boperation not permitted\b|fatal/.test((r.stdout || '') + (r.stderr || '')) || !/CONFIGURED/.test(r.stdout || ''),
    'A：测试在 sandbox 里写 .git/config 被拦', (r.stdout + r.stderr).trim().slice(0, 120));
  frameworkGit(repo, ['status', '--porcelain']);   // 框架在 sandbox 外跑 git status
  ok(!fs.existsSync(mark), 'A：框架 git status 之后，fsmonitor 的标记**没有**出现（写不进 config ＋ -c 关掉双保险）', mark);
  try { fs.rmSync(mark, { force: true }); } catch (_) { /* */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

// 变体 B：.git/hooks/post-checkout ⇒ 框架的 git worktree add 检出时跑钩子
{
  const repo = makeRepo();
  const mark = path.join(MARK_DIR, `.engloop-sbgit-posthook-${process.pid}`);
  try { fs.rmSync(mark, { force: true }); } catch (_) { /* */ }
  const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
  const r = runInSandbox(repo, `const fs=require('fs');
try{fs.writeFileSync(${JSON.stringify(hook)},'#!/bin/sh\\necho ran > ${mark}\\n');fs.chmodSync(${JSON.stringify(hook)},0o755);console.log('WROTE-HOOK')}catch(e){console.log(e.code)}`);
  ok(r.stdout.trim() === 'EPERM', 'B：测试在 sandbox 里写 .git/hooks/post-checkout 被拦（EPERM）', r.stdout.trim());
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sbgit-wt-'));
  fs.rmdirSync(scratch);
  frameworkGit(repo, ['worktree', 'add', '--detach', scratch, 'HEAD']);   // 检出时会跑 post-checkout（若存在且 hooksPath 没被关）
  ok(!fs.existsSync(mark), 'B：worktree add 检出之后，post-checkout 的标记**没有**出现（写不进 hooks ＋ hooksPath=/dev/null）', mark);
  frameworkGit(repo, ['worktree', 'remove', '--force', scratch]);
  try { fs.rmSync(mark, { force: true }); } catch (_) { /* */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

// 变体 C：linked worktree 的 .git **指针文件**改写 ⇒ 把 git 指到测试自己造的 gitdir（其 config 有 fsmonitor）
{
  const repo = makeRepo();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sbgit-lw-'));
  fs.rmdirSync(scratch);
  frameworkGit(repo, ['worktree', 'add', '--detach', scratch, 'HEAD']);   // scratch/.git 是指针文件
  const mark = path.join(MARK_DIR, `.engloop-sbgit-ptr-${process.pid}`);
  try { fs.rmSync(mark, { force: true }); } catch (_) { /* */ }
  // 在 scratch（临时树，白名单内）里跑：试图改写 scratch/.git 指针。scratch/.git 在白名单里（tmp）—— 但它是工作树的 .git，reDenyWrite 抠了
  const prof = SP.buildProfile({ allowWrite: [scratch], denyRead: [], reDenyWrite: [path.join(scratch, '.git')], allowTmp: true });
  const pf = path.join(scratch, 'prof.sb'); fs.writeFileSync(pf, prof);
  const evilGitdir = path.join(scratch, 'evilgit');
  const argv = SP.wrap(pf, [process.execPath, '-e', `const fs=require('fs');
try{fs.writeFileSync(${JSON.stringify(path.join(scratch, '.git'))},'gitdir: ${evilGitdir}\\n');console.log('REPOINTED')}catch(e){console.log(e.code)}`]);
  const r = spawnSync(argv[0], argv.slice(1), { cwd: scratch, encoding: 'utf8' });
  ok(r.stdout.trim() === 'EPERM', 'C：测试在 sandbox 里改写 linked worktree 的 .git 指针被拦（EPERM）', r.stdout.trim());
  frameworkGit(repo, ['worktree', 'remove', '--force', scratch]);
  try { fs.rmSync(mark, { force: true }); fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
