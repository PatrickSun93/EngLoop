'use strict';

/**
 * agy 后端。**不需要真 agy、也不需要真 sandbox-exec**：
 *
 *   · 假 `agy`：把收到的 argv / env / cwd 写成 JSON，按 prompt 里的暗号回四种输出（成功、超时、ERROR、空 response）。
 *   · 假 `sandbox-exec`：`-f <profile> cmd…` ⇒ 把 profile 拷一份出来，再 exec 后面的命令 ⇒ 测试读得到「agy 实际被包进了哪份 profile」。
 *     注入方式是 runAgy 的第三个参数（deps.sandbox）—— **不是环境变量**：生产代码里没有能换掉 sandbox-exec 的开关。
 *   · 夹具：临时 git 仓库 ＋ `lib/agent-worktree.ensureWorktree` 建的 `wt/<名字>`（跟生产同一个函数）。
 *
 * 真 agy ＋ 真 sandbox-exec 的验收要在 Mac 上另做（这里测不到）。
 * 变异（不落盘）：`scripts/mutate-agy.js`。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-agy-')));

const caps = require('../lib/agent-capabilities');
const AS = require('../lib/agent-settings');
const SP = require('../lib/sandbox-profile');
const PW = require('../lib/agent-worktree');
const AB = require('../lib/agy-backend');
const { AGY_CONFIG } = require('../lib/agy-config');
const relay = require('../lib/relay');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? `  → ${String(d).slice(0, 400)}` : ''}`));

// ── 假二进制 ───────────────────────────────────────────────────────────────
const BIN = path.join(TMP, 'bin');
const OUT = path.join(TMP, 'out');
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const FAKE_AGY = path.join(BIN, 'agy');
fs.writeFileSync(FAKE_AGY, `#!${process.execPath}
const fs = require('fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(OUT)} + '/agy-' + Date.now() + '-' + process.pid + '.json',
  JSON.stringify({ argv, env: process.env, cwd: process.cwd() }));
const p = argv[argv.indexOf('-p') + 1] || '';
const j = (o) => process.stdout.write(JSON.stringify(Object.assign({ conversation_id: 'c', duration_seconds: 1, num_turns: 1 }, o)) + '\\n');
if (p.includes('MODE:timeout')) { j({ status: 'SUCCESS', response: '' }); process.stderr.write('[agy] print timeout after 15s with turn in progress; returning partial output\\n'); process.exit(0); }
if (p.includes('MODE:error')) { j({ status: 'ERROR', response: '', error: 'Eligibility check failed' }); process.stderr.write('error: Eligibility check failed\\n'); process.exit(1); }
if (p.includes('MODE:bgkill')) { j({ status: 'SUCCESS', response: 'Running \`sleep 90\`. Waiting for it to finish...' }); process.stderr.write('root agent idle; waiting up to 20s for 1 background task(s)\\nterminating 1 background task(s) on exit\\n'); process.exit(0); }
if (p.includes('MODE:empty')) { j({ status: 'SUCCESS', response: '' }); process.exit(0); }
if (p.includes('MODE:notjson')) { process.stdout.write('hello\\n'); process.exit(0); }
j({ status: 'SUCCESS', response: 'DONE in ' + process.cwd() + '\\n' });
`);
fs.chmodSync(FAKE_AGY, 0o755);
const FAKE_SBX = path.join(BIN, 'sandbox-exec');
fs.writeFileSync(FAKE_SBX, `#!/bin/sh
# 假 sandbox-exec：-f <profile> cmd... ⇒ 拷 profile，exec cmd
[ "$1" = "-f" ] || { echo "fake sandbox-exec: want -f" >&2; exit 64; }
cp "$2" ${JSON.stringify(OUT)}/profile-$$.sb
shift 2
exec "$@"
`);
fs.chmodSync(FAKE_SBX, 0o755);
const fakeSandbox = (avail = true) => ({
  available: () => avail,
  wrap: (profileFile, argv) => [FAKE_SBX, '-f', profileFile, ...argv],
  SANDBOX_EXEC: FAKE_SBX,
});
// 「这一次调用有没有留下记录」按**文件集合的差**判，不按 mtime 时间窗（Mac 上上一个 case 的记录可能落在同一个 5ms 窗里 ⇒ 误报）
const snapshot = () => new Set(fs.readdirSync(OUT));
function newRecord(prefix, before) {
  const fresh = fs.readdirSync(OUT).filter((f) => f.startsWith(prefix) && !before.has(f));
  if (fresh.length > 1) throw new Error(`一次调用留下了 ${fresh.length} 份 ${prefix} 记录：${fresh.join(', ')}`);
  return fresh.length ? path.join(OUT, fresh[0]) : null;
}

// ── 夹具：主仓库 ＋ wt/agy1 ──────────────────────────────────────────────────
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const repo = path.join(TMP, 'repo');
fs.mkdirSync(repo);
g(repo, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'init');
const wt = PW.ensureWorktree({ root: repo, name: 'agy1' }).path;
const HOME_AGY = path.join(TMP, 'agy-home');
fs.mkdirSync(HOME_AGY);
const REAL_HOME = path.join(TMP, 'realhome');   // 假的「真实用户目录」—— 推送凭据位置按它算
// 诱饵：假真实用户目录下放一个 ~/.local/bin/agy（Mac 上真 agy 就在这个位置）——
// 「显式给的路径不在」时 runAgy 要报 agy_missing，**不能**往下找到它（往下找 = 测试在 Mac 上真去调 agy）。
const DECOY_AGY = path.join(REAL_HOME, '.local', 'bin', 'agy');
fs.mkdirSync(path.dirname(DECOY_AGY), { recursive: true });
fs.writeFileSync(DECOY_AGY, '#!/bin/sh\necho DECOY-AGY-RAN >&2\nexit 99\n');
fs.chmodSync(DECOY_AGY, 0o755);
const PERSONA = path.join(TMP, 'AGY.md');
fs.writeFileSync(PERSONA, '# PERSONA-MARK-7c1 你是 agy worker\n');
const AGY = { home: HOME_AGY, projectId: 'proj-test-1' };
const baseOpts = (o = {}) => ({ cwd: wt, timeoutMs: 15_000, appendSystemPromptFile: PERSONA, root: repo, agy: AGY, ...o });
const deps = (o = {}) => ({ sandbox: fakeSandbox(), agyBin: FAKE_AGY, realHome: REAL_HOME, ...o });

async function main() {
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n【1】能力表：backends 一维');
  {
    ok(JSON.stringify(caps.backendsFor('solve')) === '["claude","agy"]', 'solve 能用 claude ＋ agy');
    ok(['orchestrator', 'dev', 'test', 'eval', 'write', 'review'].every((t) => JSON.stringify(caps.backendsFor(t)) === '["claude"]'),
      '其余类型只有 claude');
    ok(!caps.BACKENDS.some((b) => /deepseek/.test(b)), 'DeepSeek 推迟没做 ⇒ 不在已知后端里');
    const saved = caps.CAPABILITIES.review.backends;
    delete caps.CAPABILITIES.review.backends;
    let threw = false;
    try { caps.backendsFor('review'); } catch (_) { threw = true; }
    caps.CAPABILITIES.review.backends = ['claude', 'nope'];
    let threw2 = false;
    try { caps.backendsFor('review'); } catch (_) { threw2 = true; }
    caps.CAPABILITIES.review.backends = saved;
    ok(threw, '★ 某一格没写 backends ⇒ 抛（不默认成全放）');
    ok(threw2, '写了不认识的后端 ⇒ 抛');
  }

  console.log('\n【2】入口：relay.resolveWork 按能力表拒 backend');
  {
    const PID = 4243;
    const red = { xinfo: async () => [['name', `solve-pool-${PID}`, 'pending', '0', 'idle', '12']] };
    const redW = { xinfo: async () => [['name', `write-pool-${PID}`, 'pending', '0', 'idle', '12']] };
    const r1 = await relay.resolveWork(red, { work: 'solve', job_id: 'j1', text: 'x', backend: 'agy' }, { pid: PID });
    ok(r1 && !r1.error && r1.backend === 'agy', 'solve ＋ agy ⇒ 放行，backend 带下去', JSON.stringify(r1));
    const r2 = await relay.resolveWork(redW, { work: 'write', job_id: 'j2', text: 'x', backend: 'agy' }, { pid: PID });
    ok(r2 && r2.error === 'bad_backend', '★ write ＋ agy ⇒ bad_backend（不在这个类型的 backends 里）', JSON.stringify(r2));
    const r3 = await relay.resolveWork(red, { work: 'solve', job_id: 'j3', text: 'x', backend: 'deepseek-pro' }, { pid: PID });
    ok(r3 && r3.error === 'bad_backend', 'deepseek-pro ⇒ bad_backend（推迟没做）', JSON.stringify(r3));
    const r4 = await relay.resolveWork(red, { work: 'solve', job_id: 'j4', text: 'x' }, { pid: PID });
    ok(r4 && !r4.error && r4.backend === undefined, '不带 backend ⇒ 不加这个字段（claude 路径跟以前一样）', JSON.stringify(r4));
  }

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n【3】linked worktree 闸');
  {
    const w = AB.linkedWorktree(wt);
    ok(w.ok && w.branch === 'wt/agy1' && w.name === 'agy1' && w.common === fs.realpathSync(path.join(repo, '.git')),
      'wt/agy1 是 linked worktree 的根 ⇒ 过', JSON.stringify(w));
    ok(!AB.linkedWorktree(repo).ok && /主工作树/.test(AB.linkedWorktree(repo).error), '★ 主工作树 ⇒ 拒');
    fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
    ok(!AB.linkedWorktree(path.join(wt, 'sub')).ok, 'worktree 的子目录 ⇒ 拒（写集按 cwd 算）');
    ok(!AB.linkedWorktree(path.join(TMP, 'nope')).ok && !AB.linkedWorktree(TMP).ok, '不存在 / 不在 git 里 ⇒ 拒');
    const other = path.join(TMP, 'repo-worktrees', 'odd');
    g(repo, 'worktree', 'add', '-q', '-b', 'feature/x', other, 'main');
    ok(!AB.linkedWorktree(other).ok && /wt\/<名字>/.test(AB.linkedWorktree(other).error), '分支不是 wt/<名字> ⇒ 拒');
  }

  console.log('\n【4】sandbox-exec profile');
  {
    const x = { allowWrite: ['/w'], denyRead: ['/s/t'], reDenyWrite: ['/w/h'], allowTmp: false };
    const def = SP.buildProfile(x);
    ok(def === SP.buildProfile({ ...x, network: 'localhost', denyReadTree: [] }), '不传新参数 ＝ 显式给默认值（逐字节）');
    ok(!def.includes('(allow network-outbound (remote ip "*:*"))') && !/subpath "\/s/.test(def),
      '★ 不传 network ⇒ 不放开出站、没有整棵拒读');
    const w = AB.linkedWorktree(wt);
    const prof = AB.buildAgyProfile({ cwd: wt, wt: w, home: HOME_AGY, tmpdir: path.join(TMP, 'jobtmp'), root: repo, realHome: REAL_HOME });
    const allowW = (p) => prof.includes(`(allow file-write* (subpath "${SP.realish(p)}"))`);
    const C = w.common;
    ok(allowW(wt) && allowW(HOME_AGY) && allowW(path.join(TMP, 'jobtmp')), '写集：cwd ＋ 专用 HOME ＋ 私有 TMPDIR');
    ok(['objects', 'worktrees/agy1', 'refs/heads/wt', 'logs/refs/heads/wt'].every((p) => allowW(path.join(C, p))),
      '★ 写集：这棵 worktree 的 git 元数据四项（少了 commit 不成，W1_PROBES b1-literal）');
    ok(prof.includes(`(deny file-write* (subpath "${path.join(C, 'refs', 'heads', 'main')}"))`)
      && prof.includes(`(deny file-write* (subpath "${path.join(wt, '.git')}"))`) && prof.includes('(deny file-write* (regex #'),
      '抠掉：mainRefGuard、worktree 的 .git 指针、git 的 config / hooks');
    ok(['Library/Keychains', '.ssh', '.config/gh', '.git-credentials', '.netrc', '.gemini'].every((p) => prof.includes(`(deny file-read* (subpath "${path.join(REAL_HOME, p)}"))`)),
      '★ 推送凭据整棵拒读（按真实用户目录，不按 HOME）—— 堵 push 绕过 wt-merge 的唯一一层');
    ok(AS.secretPaths(repo).every((f) => prof.includes(`(deny file-read* (literal "${f}"))`)), '钥匙拒读（secretPaths）');
    ok(prof.trimEnd().endsWith('(allow network-outbound (remote ip "*:*"))'), '网络全开（D2 / D2\'），而且是最后一条（盖过前面的 deny）');
    ok(prof.includes(`(deny file-read* (subpath "${path.join(REAL_HOME, '.gemini')}"))`)
      && !prof.includes(`(allow file-write* (subpath "${path.join(REAL_HOME, '.gemini')}"))`),
      '★ Patrick 自己的 ~/.gemini（真实用户目录下）整棵拒读、不在写集里 —— 它用的是专用 HOME 那份登录');
    ok(!prof.includes(`(deny file-read* (subpath "${HOME_AGY}"))`), '专用 HOME 对 agy 不拒读（它要读登录）');
    ok(JSON.stringify(AB.credentialTrees('/u')) === JSON.stringify(['/u/Library/Keychains', '/u/.ssh', '/u/.config/gh', '/u/.git-credentials', '/u/.netrc', '/u/.gemini']),
      'credentialTrees 的六项');
  }

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n【5】runAgy 真跑一次（假 sandbox-exec ＋ 假 agy）');
  {
    const saved = { ...process.env };
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-should-not-pass', CLAUDECODE: '1', ENGLOOP_ADMIN_TOKEN_FILE: '/x' });
    const t0 = snapshot();
    const r = await AB.runAgy({ text: 'write hello.txt' }, baseOpts(), deps());
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    const recF = newRecord('agy-', t0);
    const rec = recF && JSON.parse(fs.readFileSync(recF, 'utf8'));
    const profF = newRecord('profile-', t0);
    const prof = profF && fs.readFileSync(profF, 'utf8');
    ok(r.ok && r.via === 'agy' && r.output === `DONE in ${wt}`, '（前置）跑通，output = response', JSON.stringify(r));
    const a = rec ? rec.argv : [];
    const at = (f) => a[a.indexOf(f) + 1];
    ok(at('--project') === 'proj-test-1', '★ argv：--project <专用 project>（不带就落到默认 project 配的那个大目录）', JSON.stringify(a.filter((x) => x.startsWith('--'))));
    ok(at('--output-format') === 'json' && at('--print-timeout') === '15s' && a.includes('--dangerously-skip-permissions'),
      'argv：--output-format json · --print-timeout = job 超时 · 显式 --dangerously-skip-permissions');
    ok(at('-p').startsWith('# PERSONA-MARK-7c1') && at('-p').includes('write hello.txt'), '人格拼在 prompt 开头，任务在后面');
    ok(rec && rec.cwd === wt, 'agy 的 cwd = worktree');
    const env = rec ? rec.env : {};
    ok(env.HOME === HOME_AGY, '★ HOME = 专用 HOME（不是真 HOME）', env.HOME);
    ok(env.TMPDIR && env.TMPDIR.startsWith(fs.realpathSync(os.tmpdir())) && !env.TMPDIR.startsWith(wt) && !fs.existsSync(env.TMPDIR),
      '★ TMPDIR 是这个 job 私有的（不在 cwd 里），跑完删了', env.TMPDIR);
    // __CF_USER_TEXT_ENCODING：macOS 给每个进程加的（Mac 上会多出来的那一个）
    ok(Object.keys(env).every((k) => ['HOME', 'TMPDIR', 'PATH', '__CF_USER_TEXT_ENCODING'].includes(k) || /^(PWD|SHLVL|_|OLDPWD)$/.test(k)),
      '★ env 从零开始：只有 HOME / TMPDIR / PATH（没有 ANTHROPIC_*、CLAUDECODE、ENGLOOP_*）', JSON.stringify(Object.keys(env)));
    ok(prof && prof.includes(`(allow file-write* (subpath "${env.TMPDIR}"))`) && prof.includes('(subpath "' + path.join(fs.realpathSync(path.join(repo, '.git')), 'objects') + '")'),
      '★ agy 真被包进了那份 profile（TMPDIR 和 git 元数据都在里面）');
    ok(prof && prof.includes(`(deny file-read* (subpath "${path.join(REAL_HOME, 'Library/Keychains')}"))`), '那份 profile 拒读 Keychains');
  }

  console.log('\n【6】判失败：超时是 exit 0 ＋ SUCCESS ＋ 空 response');
  {
    const r1 = await AB.runAgy({ text: 'MODE:timeout' }, baseOpts(), deps());
    ok(!r1.ok && r1.reason === 'timeout' && !r1.permanent, '★ stderr 有 print timeout ⇒ 失败（reason timeout，可重投）', JSON.stringify(r1));
    const r2 = await AB.runAgy({ text: 'MODE:error' }, baseOpts(), deps());
    ok(!r2.ok && /exit 1/.test(r2.error) && /Eligibility/.test(r2.error), 'exit 1 ＋ status ERROR ⇒ 失败，带上 agy 的 error', JSON.stringify(r2));
    const r3 = await AB.runAgy({ text: 'MODE:empty' }, baseOpts(), deps());
    ok(!r3.ok && /空 response/.test(r3.error), '★ SUCCESS 但 response 空（没有 stderr）⇒ 失败', JSON.stringify(r3));
    const r5 = await AB.runAgy({ text: 'MODE:bgkill' }, baseOpts(), deps());
    ok(!r5.ok && r5.reason === 'timeout' && !r5.permanent && /terminating 1 background task/.test(r5.error) && /Waiting for it to finish/.test(r5.error),
      '★ 后台任务被杀（exit 0 ＋ SUCCESS ＋ response 非空 ＋ stderr「terminating N background task(s)」）⇒ 失败（reason timeout，可重投，error 带那一行和 response）', JSON.stringify(r5));
    const r4 = await AB.runAgy({ text: 'MODE:notjson' }, baseOpts(), deps());
    ok(!r4.ok && /不是 JSON/.test(r4.error), '输出不是 JSON ⇒ 失败');
    ok(AB.parseAgyResult({ code: 0, stdout: '{"status":"SUCCESS","response":"x"}', stderr: '' }).ok, 'parse：正常 ⇒ ok');
    ok(!AB.parseAgyResult({ code: 0, stdout: '{"status":"SUCCESS","response":"x"}', stderr: '[agy] print timeout after 1s' }).ok,
      'parse：response 非空但 stderr 有 print timeout ⇒ 仍判失败（partial output）');
    const long = 'w'.repeat(500);
    const p6 = AB.parseAgyResult({ code: 0, stdout: JSON.stringify({ status: 'SUCCESS', response: long }), stderr: 'terminating 3 background task(s) on exit\n' });
    ok(!p6.ok && p6.reason === 'timeout' && p6.error.includes('w'.repeat(200)) && !p6.error.includes('w'.repeat(201)), 'parse：后台任务被杀 ⇒ timeout，response 只带前 200 字', JSON.stringify(p6).slice(0, 200));
  }

  console.log('\n【7】不起 worker 的情况（都是 permanent，不退回成别的跑法）');
  {
    const cases = [
      ['sandbox 起不来', baseOpts(), deps({ sandbox: fakeSandbox(false) }), 'sandbox_unavailable'],
      ['project id 没配', baseOpts({ agy: { home: HOME_AGY, projectId: '' } }), deps(), 'agy_config'],
      ['专用 HOME 不在', baseOpts({ agy: { home: path.join(TMP, 'no-home'), projectId: 'p' } }), deps(), 'agy_config'],
      ['agy 二进制不在（显式给的路径不存在时不往下找）', baseOpts(), deps({ agyBin: path.join(TMP, 'no-agy') }), 'agy_missing'],
      ['cwd 是主工作树', baseOpts({ cwd: repo }), deps(), 'not_linked_worktree'],
      ['人格文件不在', baseOpts({ appendSystemPromptFile: path.join(TMP, 'no.md') }), deps(), 'persona_missing'],
    ];
    for (const [label, o, d, reason] of cases) {
      const t0 = snapshot();
      const r = await AB.runAgy({ text: 'x' }, o, d);
      ok(!r.ok && r.permanent && r.reason === reason && !newRecord('agy-', t0), `${label} ⇒ ${reason}，agy 没被调用`, JSON.stringify(r));
    }
    ok(AB.resolveAgyBin(path.join(TMP, 'no-agy'), REAL_HOME) === null && AB.resolveAgyBin(undefined, REAL_HOME) === DECOY_AGY,
      '★ 显式给的路径不在 ⇒ null（不往下找到 ~/.local/bin/agy）；不给 ⇒ 才按真实用户目录找');
    fs.writeFileSync(path.join(wt, 'AGENTS.md'), 'injected\n');
    const t0 = snapshot();
    const r = await AB.runAgy({ text: 'x' }, baseOpts(), deps());
    ok(!r.ok && r.permanent && r.reason === 'agy_context_file' && !newRecord('agy-', t0), '★ cwd 里有 AGENTS.md ⇒ 不起（agy 会把它读进系统上下文）', JSON.stringify(r));
    fs.rmSync(path.join(wt, 'AGENTS.md'));
  }

  console.log('\n【8】仓库里没有 agy 会读的上下文文件（每棵 worktree 都会检出它们）');
  {
    const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n');
    const hits = tracked.filter((f) => AB.CONTEXT_FILES.includes(path.basename(f)));
    ok(hits.length === 0, '★ EngLoop 里没有任何 AGENTS.md / GEMINI.md', JSON.stringify(hits));
  }

  console.log('\n【9】专用 HOME 是钥匙：claude agent 都拒读');
  {
    const home = AGY_CONFIG.home;
    // 期望值用 git 自己算（git-common-dir 的上级 = 主工作树）—— 这个测试从 linked worktree 里跑也对
    const common = execFileSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    const agyCfgFile = path.join(ROOT, 'config', 'agy-project.json');
    const idOk = fs.existsSync(agyCfgFile) ? /^[0-9a-f-]{36}$/.test(AGY_CONFIG.projectId) : AGY_CONFIG.projectId === '';
    ok(home === path.join(path.dirname(path.dirname(common)), 'EngLoop-agy-home') && idOk,
      '配置一处：专用 HOME = <EngLoop 主工作树的上级>/EngLoop-agy-home；project id：config/agy-project.json 在 ⇒ 是一个 uuid，不在 ⇒ 空串', home);
    const agyCfg = require('../lib/agy-config');
    const expect = path.join(path.dirname(repo), 'EngLoop-agy-home');
    ok(agyCfg.agyHomeFor(wt) === expect && agyCfg.agyHomeFor(repo) === expect && agyCfg.agyHomeFor(path.join(TMP, 'repo-worktrees', 'odd')) === expect,
      '★ 从 linked worktree 推出来的专用 HOME 跟主仓库推出来的一样（不按 dirname(ROOT)）', `${agyCfg.agyHomeFor(wt)} vs ${expect}`);
    // 原样：把 lib/agy-config.js 放进夹具仓库，从主工作树和 linked worktree 各 require 一次
    fs.mkdirSync(path.join(repo, 'lib'));
    fs.copyFileSync(path.join(ROOT, 'lib', 'agy-config.js'), path.join(repo, 'lib', 'agy-config.js'));
    g(repo, 'add', 'lib'); g(repo, 'commit', '-qm', 'cfg');
    const wt2 = PW.ensureWorktree({ root: repo, name: 'cfg1' }).path;
    const homeOf = (dir) => execFileSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(dir, 'lib', 'agy-config.js'))}).AGY_CONFIG.home)`], { encoding: 'utf8' });
    ok(path.dirname(wt2) !== path.dirname(repo) && homeOf(wt2) === homeOf(repo) && homeOf(repo) === expect,
      '在一棵 linked worktree 里 require 这个模块 ⇒ 专用 HOME 跟主仓库里的一样', `${homeOf(wt2)} vs ${homeOf(repo)}`);
    // project id 的出处：config/agy-project.json。文件不在 / 坏了 ⇒ ''（runAgy 照「project id 没配」拒）
    const idOf = (dir) => execFileSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(dir, 'lib', 'agy-config.js'))}).AGY_CONFIG.projectId))`], { encoding: 'utf8' });
    ok(idOf(repo) === '""', '★ 仓库里没有 config/agy-project.json（公开版的样子）⇒ projectId 是空串', idOf(repo));
    fs.mkdirSync(path.join(repo, 'config'));
    fs.writeFileSync(path.join(repo, 'config', 'agy-project.json'), JSON.stringify({ projectId: '00000000-0000-4000-8000-00000000a9e1' }));
    ok(idOf(repo) === '"00000000-0000-4000-8000-00000000a9e1"', '★ 有 config/agy-project.json ⇒ projectId 就是文件里那个', idOf(repo));
    const idFile = (name, content) => { const f = path.join(TMP, name); fs.writeFileSync(f, content); return agyCfg.projectIdFrom(f); };
    ok(agyCfg.projectIdFrom(path.join(TMP, 'no-such-agy-project.json')) === '' && idFile('agy-bad.json', '{not json') === ''
      && idFile('agy-num.json', '{"projectId": 42}') === '' && idFile('agy-none.json', '{}') === '',
      'projectIdFrom：文件不在 / 不是 JSON / 字段不是字符串 / 没有字段 ⇒ 都是空串（不抛）');
    {
      const r0 = await AB.runAgy({ text: 'x' }, baseOpts({ agy: { home: HOME_AGY, projectId: agyCfg.projectIdFrom(path.join(TMP, 'no-such-agy-project.json')) } }), deps());
      ok(!r0.ok && r0.permanent && r0.reason === 'agy_config', '★ 文件不在时读出来的空串交给 runAgy ⇒ agy_config（不落到默认 project）', JSON.stringify(r0));
    }
    const throwsFor = (name, dotGit) => {
      const d = path.join(TMP, name);
      fs.mkdirSync(d); fs.writeFileSync(path.join(d, '.git'), dotGit);
      try { agyCfg.agyHomeFor(d); return false; } catch (_) { return true; }
    };
    ok(throwsFor('brokengit1', 'gitdir: /nonexistent/wt/x\n') && throwsFor('brokengit2', 'not a gitfile\n'),
      '.git 是文件却推不出 common dir ⇒ 抛（不回退成 dirname(ROOT)）');
    const p = AS.buildCrewSettings({ name: 'd', type: 'dev', cwd: '/w', root: '/r' });
    ok(p.permissions.deny.includes(`Read(/${home}/**)`) && p.sandbox.filesystem.denyRead.includes(home), '★ agent：Read 规则 ＋ sandbox denyRead 都有专用 HOME');
    const w = AS.buildAgentSettings({ kind: 'worker', name: 'w', type: 'solve', cwd: '/w', root: '/r' });
    ok(w.permissions.deny.includes(`Read(/${home}/**)`) && w.sandbox.filesystem.denyRead.includes(home), 'worker：同上');
    const o = AS.buildAgentSettings({ kind: 'orchestrator', name: 'JARVIS', type: 'orchestrator', cwd: '/r', root: '/r' });
    ok(!o.permissions.deny.some((d) => d.includes(home)), '编排者不拒读（跟钥匙一样）');
    const sb = SP.buildProfile({ denyReadTree: AS.secretDirs() });
    ok(sb.includes(`(deny file-read* (subpath "${SP.realish(home)}"))`), 'sandbox-exec（verify-complete / Stop hook）用 subpath 整棵拒读');
  }

  console.log('\n【10】worker-pool：按 backend 派、闸在池里也有一道');
  {
    const q = require('../lib/queue');
    const { startPool } = require('../lib/worker-pool');
    const redis = q.createClient();
    const STREAM = 'work:solve';
    await redis.del(STREAM, 'orch:in:agent');
    await q.ensureGroup(redis, STREAM, STREAM);
    const seen = [];
    const runner = async (task, opts) => { seen.push({ task, opts }); return { ok: true, ms: 1, output: 'ok' }; };
    const pool = startPool(redis, { type: 'solve', concurrency: 1, runner, onLog: () => {} });
    const replies = async (n) => {
      for (let i = 0; i < 60 && (await redis.xlen('orch:in:agent')) < n; i++) await new Promise((r) => setTimeout(r, 100));
      return (await redis.xrange('orch:in:agent', '-', '+')).map(([, f]) => { const o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1]; return o; });
    };
    await q.send(redis, STREAM, { from: 'JARVIS', text: 'claude job', job_id: 'w1-claude-1' });
    await replies(1);
    const c = seen[0];
    ok(c && !('backend' in c.opts) && c.opts.appendSystemPromptFile.endsWith(`${path.sep}CLAUDE.md`),
      '★ 不带 backend ⇒ 传给 runner 的参数跟以前一样（没有 backend 键，人格是 CLAUDE.md）', JSON.stringify(c && Object.keys(c.opts)));
    await q.send(redis, STREAM, { from: 'JARVIS', text: 'agy job', job_id: 'w1-agy-1', backend: 'agy', cwd: wt });
    await replies(2);
    const ag = seen[1];
    ok(ag && ag.opts.backend === 'agy' && ag.opts.cwd === wt && ag.opts.appendSystemPromptFile.endsWith(`${path.sep}AGY.md`),
      '★ backend agy ＋ worktree cwd ⇒ runner 拿到 backend:agy、人格 AGY.md', JSON.stringify(ag && ag.opts));
    await q.send(redis, STREAM, { from: 'JARVIS', text: 'agy main', job_id: 'w1-agy-2', backend: 'agy', cwd: repo });
    const r3 = await replies(3);
    ok(seen.length === 2 && /linked worktree/.test(r3[2] && r3[2].text), '★ backend agy ＋ cwd 是主工作树 ⇒ 池拒（permanent），runner 没被调', r3[2] && r3[2].text);
    await q.send(redis, STREAM, { from: 'JARVIS', text: 'agy nocwd', job_id: 'w1-agy-3', backend: 'agy' });
    const r4 = await replies(4);
    ok(seen.length === 2 && /必须带 cwd/.test(r4[3] && r4[3].text), 'backend agy 不带 cwd ⇒ 拒', r4[3] && r4[3].text);
    await q.send(redis, STREAM, { from: 'JARVIS', text: 'ds', job_id: 'w1-ds-1', backend: 'deepseek-pro', cwd: wt });
    const r5 = await replies(5);
    ok(seen.length === 2 && /不能用后端/.test(r5[4] && r5[4].text), '★ 不在 backends 里的后端 ⇒ 池再拒一次（消息可能不经 relay）', r5[4] && r5[4].text);
    pool.stop();
    await redis.quit();
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log(`  ✗ 崩了：${e.stack}`); process.exit(1); });
