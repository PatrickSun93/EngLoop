'use strict';

/**
 * 启动卫生 —— 三条启动路径走同一个配置生成器、
 * 模型从能力表取、剥掉 Claude Code 的会话态环境变量、agent 自动 worktree ＋ 本地合并闸。
 *
 * ── 断言**命令行和进程环境**，不断言源码里的串 ────────────────────────────
 *   每条启动路径都真的跑一次，`claude` 换成一个假的：它把**自己收到的 argv 和环境**写成 JSON。
 *   ⇒ 「--model 来自能力表」「没有 bypass」「CLAUDECODE 被剥掉」都是从**那个进程**里读出来的。
 *   · print worker：`ENGLOOP_CLAUDE_BIN` 指向假 claude
 *   · tmux worker / agent-start / orch-start：私有 tmux server（`TMUX_TMPDIR`），它的 PATH 里假 claude 排第一；
 *     **这个 server 起的时候环境里带着 `CLAUDECODE=1` 等会话态变量** —— 正是要防的那个现场
 *     （谁先起 tmux server，它的环境就被之后所有会话继承）。
 *
 * ── 隔离 ─────────────────────────────────────────────────────────────────
 *   Redis 测试库（allocTestDb）· 私有 tmux（TMUX_TMPDIR ＋ 删 TMUX）· 配置文件进临时目录
 *   （`ENGLOOP_AGENT_SETTINGS_DIR` —— 编排者那份叫 JARVIS.json，不能覆盖生产那份）·
 *   HOME 换成临时目录（trust 预检读 `~/.claude.json`；不碰真的那份）·
 *   worktree 和 wt-merge 在临时 git 仓库里（不碰本仓库的 main）。
 *
 * 变异（不落盘）：`scripts/mutate-launch.js`。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const q = require('../lib/queue');
const roster = require('../lib/roster');

const ROOT = path.join(__dirname, '..');
// ★ realpath：macOS 的 os.tmpdir() 在 /var/…，它是 /private/var/… 的软链，
//   而 `git rev-parse --path-format=absolute` 给的是解析过的路径 ⇒ 不取 realpath 的话【9b】在 Mac 上红一条、
//   「packed-refs 本体不 deny」那条恒真（路径永远对不上，!includes 永远成立）。
//   Linux 上同理：TMPDIR 指向一个软链目录时同一条会红。
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-launch-')));
const SETTINGS_DIR = path.join(TMP, 'agent-settings');
// ★ 在 require 生成器之前设：settingsDir() 每次调用都读它，但这样写清楚「这个进程里一律不写生产目录」
process.env.ENGLOOP_AGENT_SETTINGS_DIR = SETTINGS_DIR;

const AS = require('../lib/agent-settings');
const caps = require('../lib/agent-capabilities');
const launch = require('../lib/agent-launch');
const PW = require('../lib/agent-worktree');
const V = require('../lib/verify-complete');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? `  → ${String(d).slice(0, 400)}` : ''}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 假 claude ─────────────────────────────────────────────────────────────
const FAKE_DIR = path.join(TMP, 'fakebin');
const FAKE_OUT = path.join(TMP, 'fakeout');
fs.mkdirSync(FAKE_DIR, { recursive: true });
fs.mkdirSync(FAKE_OUT, { recursive: true });
const FAKE = path.join(FAKE_DIR, 'claude');
// 记下的环境只挑相关的几项（整份 env 里可能有凭据，不往磁盘上写）。
// ⚠️ **写死，不从 launch.SESSION_ENV 派生**：那是被测的清单 —— 从它派生的话，清单里漏一项，
//   假 claude 就跟着不记那一项，「没看到」被读成「剥掉了」（变异 L11 会因此活下来）。
const WATCH_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE', 'ENGLOOP_AGENT_TYPE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'LAUNCH_TEST_MARK'];
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require('fs');
const env = {};
for (const k of ${JSON.stringify(WATCH_ENV)}) if (k in process.env) env[k] = process.env[k];
const rec = { argv: process.argv.slice(2), env, cwd: process.cwd(), pid: process.pid };
fs.writeFileSync(${JSON.stringify(FAKE_OUT)} + '/' + Date.now() + '-' + process.pid + '.json', JSON.stringify(rec));
if (rec.argv.includes('-p')) { process.stdout.write('FAKE_OK'); process.exit(0); }
// 交互式：一次性 worker 类型跑完就退（runTmux 等会话消失）；常驻的画一个就绪光标、等着被 kill
if (['review', 'test', 'eval', 'solve', 'write'].includes(process.env.ENGLOOP_AGENT_TYPE)) process.exit(0);
process.stdout.write('\\n❯ fake ready (shift+tab)\\n');
setTimeout(() => {}, 120000);
`);
fs.chmodSync(FAKE, 0o755);

/** 拿「这个动作之后」新出现的那份记录 */
function recordsSince(t0) {
  return fs.readdirSync(FAKE_OUT).filter((f) => Number(f.split('-')[0]) >= t0)
    .sort().map((f) => JSON.parse(fs.readFileSync(path.join(FAKE_OUT, f), 'utf8')));
}
async function waitRecord(t0, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = recordsSince(t0);
    if (r.length) return r[r.length - 1];
    await wait(200);
  }
  return null;
}
const argAfter = (argv, flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };

// ── 私有 tmux server，环境里带着会话态变量（要防的现场）─────────────────────
const TMUX_DIR = path.join(TMP, 'tmux');
fs.mkdirSync(TMUX_DIR, { recursive: true });
const DIRTY = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '65000',
  // 用户配置 —— **不该**被剥掉（对照）
  ANTHROPIC_API_KEY: 'sk-launch-test-not-a-real-key', CLAUDE_CODE_USE_BEDROCK: '0', LAUNCH_TEST_MARK: 'kept' };
const baseEnv = { ...process.env };
delete baseEnv.TMUX; delete baseEnv.TMUX_PANE;
delete baseEnv.ENGLOOP_TEST_DB; delete baseEnv.ENGLOOP_TEST_DB_JOIN;
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const tmuxEnv = { ...baseEnv, ...DIRTY, TMUX_TMPDIR: TMUX_DIR, PATH: `${FAKE_DIR}:${baseEnv.PATH}`, HOME };
const tmuxRun = (args) => spawnSync('tmux', args, { env: tmuxEnv, encoding: 'utf8' });

async function main() {
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n【1】生成器：编排者');
  {
    const R = '/fake/engloop';
    const s = AS.buildAgentSettings({ kind: 'orchestrator', name: 'JARVIS', type: 'orchestrator', cwd: R, root: R });
    const p = s.permissions;
    ok(p.defaultMode === 'dontAsk' && p.disableBypassPermissionsMode === 'disable', 'dontAsk，bypass 被禁用');
    // ★ 编排者**没有 sandbox** —— 它的 sandbox 里全量跑不起来、verify-complete 只会 unverifiable。
    ok(s.sandbox && s.sandbox.enabled === false && Object.keys(s.sandbox).length === 1,
      '★ 编排者没有 sandbox：sandbox 段只有 enabled:false（不写 failIfUnavailable）', JSON.stringify(s.sandbox));
    ok(p.allow.includes('Bash'), '★ 没有 sandbox ⇒ 没有「sandbox 里自动放行」⇒ allow 显式有 Bash（不然 dontAsk 下什么命令都跑不了）');
    ok(p.allow.includes('Edit(//fake/engloop/**)') && p.allow.includes('Edit(//fake/engloop-worktrees/**)'),
      '能写整个仓库根 ＋ 兄弟目录 engloop-worktrees（worktree 建在那里）', JSON.stringify(p.allow));
    ok(p.allow.some((a) => /\/\.claude\/projects\/-fake-engloop\/memory\/\*\*\)$/.test(a)),
      '能写自己的 memory 目录（~/.claude/projects/<编码后的路径>/memory/，原来 bypass 下能写）', JSON.stringify(p.allow));
    ok(!p.deny.some((r) => /bus-admin\.token|users\.json/.test(r)),
      '★ 钥匙**不**拒读：编排者要用 admin token（agent-start --stop、graph.js）', JSON.stringify(p.deny));
    ok(p.deny.includes(`Edit(/${SETTINGS_DIR}/**)`) && p.deny.includes('Edit(//fake/engloop/.claude/**)'),
      '★ deny 还在：自己的启动配置、根 .claude/（只拦 Write / Edit 工具 —— 没有 sandbox，拦不住 Bash，防手滑）');
    ok(AS.GIT_DENY.every((r) => p.deny.includes(r)) && p.deny.includes('Read(//fake/engloop/.env)'),
      'git 基线和 .env 都在 deny 里');
    // 编排者**只**多挂一个 StopFailure —— 「编排者没有 hook」那条规则唯一的例外。
    //   要守的东西（不挂 check_security / Stop）照旧守住，只是把那唯一的例外写明。
    ok(Object.keys(s.hooks).join(',') === 'StopFailure' && !s.hooks.PreToolUse && !s.hooks.Stop,
      '不挂 check_security / Stop（挂上去会改它的 Bash 纪律）—— 只有 StopFailure', JSON.stringify(Object.keys(s.hooks)));
    ok(p.allow.includes('Edit(//fake/engloop/temp/outbox/JARVIS/**)'), '能写自己的 outbox');
    let threw = 0;
    for (const bad of [{ kind: 'orch' }, { kind: 'orchestrator', type: 'dev' }, { kind: 'crew', type: 'orchestrator' }]) {
      try { AS.buildAgentSettings({ name: 'x', type: 'orchestrator', cwd: R, root: R, ...bad }); } catch (_) { threw++; }
    }
    ok(threw === 3, '拼错的 kind、编排者配了别的类型、agent 配了 orchestrator 类型 ⇒ 都抛，不猜');
  }

  console.log('\n【2】生成器：worker');
  {
    const R = '/fake/engloop';
    const rv = AS.buildAgentSettings({ kind: 'worker', name: 'worker-review', type: 'review', cwd: '/proj', root: R });
    ok(rv.permissions.deny.includes('Bash') && rv.permissions.deny.includes('Edit(//proj/**)'), 'review：Bash 拒、写 cwd 拒');
    ok(rv.permissions.additionalDirectories.length === 0 && !rv.permissions.allow.some((a) => a.includes('outbox')),
      'worker 没有 outbox（结果走 stdout）');
    ok(rv.sandbox.filesystem.denyRead.includes('/fake/engloop/temp/bus-admin.token'), 'worker 拒读钥匙');
    ok(rv.hooks.PreToolUse && !rv.hooks.Stop, 'worker 挂 check_security，不挂 Stop（一次性，结果由派活的人核）');
    const sv = AS.buildAgentSettings({ kind: 'worker', name: 'worker-solve', type: 'solve', cwd: '/proj', root: R });
    ok(sv.permissions.allow.includes('Edit(//proj/**)') && sv.sandbox.filesystem.allowWrite.includes('/proj'),
      'solve（有写能力）：Edit 和 Bash 都能写 cwd');
    ok(sv.sandbox.filesystem.denyWrite.some((p) => p.endsWith('QA*.md')), 'solve 也写不了 QA 产物');
    const f1 = AS.writeAgentSettings({ kind: 'worker', name: 'w', type: 'solve', cwd: '/proj/a', root: R });
    const f2 = AS.writeAgentSettings({ kind: 'worker', name: 'w', type: 'solve', cwd: '/proj/b', root: R });
    ok(f1 !== f2 && path.dirname(f1) === SETTINGS_DIR, '同类型、不同 cwd ⇒ 不同的配置文件（写集跟 cwd 走）', `${f1} ${f2}`);
  }

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n【3】model：能力表是唯一出处');
  {
    // 所有类型一律 Sonnet 5.5，要 Opus 时点名
    ok(Object.keys(caps.CAPABILITIES).every((t) => caps.modelFor(t) === 'claude-sonnet-5-5'), '所有类型 = claude-sonnet-5-5');
    ok(JSON.stringify(launch.modelArgs('dev')) === '["--model","claude-sonnet-5-5"]', 'modelArgs：具体模型 ⇒ --model');
    const saved = caps.CAPABILITIES.review.model;
    caps.CAPABILITIES.review.model = caps.INHERIT;
    const inheritArgs = launch.modelArgs('review');
    caps.CAPABILITIES.review.model = saved;
    ok(inheritArgs.length === 0, 'modelArgs：继承 ⇒ 不传（现在没有类型用它，内存里改一格验）');
    delete caps.CAPABILITIES.review.model;
    let threw = false;
    try { caps.modelFor('review'); } catch (_) { threw = true; }
    caps.CAPABILITIES.review.model = saved;
    ok(threw, '★ 某一格没写 model ⇒ 抛（不静默退回「继承」）');
    let threw2 = false;
    try { caps.modelFor('nope'); } catch (_) { threw2 = true; }
    ok(threw2, '不认识的类型 ⇒ 抛');
  }

  console.log('\n【4】环境变量：只剥会话态');
  {
    const e = launch.stripSessionEnv({ ...DIRTY, PATH: '/x', CLAUDE_CODE_SESSION_ID: 's' }, { ENGLOOP_AGENT_TYPE: 'dev' });
    ok(!('CLAUDECODE' in e) && !('CLAUDE_CODE_ENTRYPOINT' in e) && !('CLAUDE_CODE_SESSION_ID' in e) && !('CLAUDE_CODE_SSE_PORT' in e),
      '会话态的都剥了', JSON.stringify(Object.keys(e)));
    ok(e.ANTHROPIC_API_KEY && e.CLAUDE_CODE_USE_BEDROCK === '0' && e.PATH === '/x' && e.ENGLOOP_AGENT_TYPE === 'dev',
      '★ 用户配置（ANTHROPIC_API_KEY、CLAUDE_CODE_USE_BEDROCK）留着 —— 不按前缀剥');
    // `env -u` 前缀：真让 shell 跑一次
    const out = spawnSync('sh', ['-c', `${launch.envUnsetPrefix()} env`], { env: { ...process.env, ...DIRTY }, encoding: 'utf8' }).stdout;
    ok(!/^CLAUDECODE=/m.test(out) && /^LAUNCH_TEST_MARK=kept$/m.test(out), '`env -u …` 前缀在真 shell 里剥掉 CLAUDECODE、留下别的');
  }

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n【5】print 模式 worker：真跑一次（假 claude）');
  {
    process.env.ENGLOOP_CLAUDE_BIN = FAKE;
    const { runPrint } = require('../lib/worker-runner');
    const saved = {};
    for (const [k, v] of Object.entries(DIRTY)) { saved[k] = process.env[k]; process.env[k] = v; }
    const t0 = Date.now();
    const r = await runPrint({ text: 'review this', type: 'review' }, {
      cwd: TMP, timeoutMs: 15000, agentType: 'review',
      allowedTools: caps.allowedToolsFor('review'), disallowedTools: caps.disallowedToolsFor('review'),
    });
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const rec = await waitRecord(t0);
    ok(r.ok && r.output === 'FAKE_OK' && rec, '（前置）假 claude 跑了、结果拿到了', JSON.stringify(r).slice(0, 200));
    const a = rec ? rec.argv : [];
    ok(!a.includes('--dangerously-skip-permissions') && argAfter(a, '--permission-mode') === 'dontAsk',
      '★ argv：dontAsk，没有 bypass', JSON.stringify(a));
    ok(argAfter(a, '--setting-sources') === 'user', '★ argv：--setting-sources user（cwd 的项目配置不加载）');
    const sf = argAfter(a, '--settings');
    const sj = sf && JSON.parse(fs.readFileSync(sf, 'utf8'));
    ok(sj && JSON.stringify(sj) === JSON.stringify(AS.buildAgentSettings({ kind: 'worker', name: 'worker-review', type: 'review', cwd: TMP })),
      '★ --settings 指向的文件 = 生成器给 review worker 的那份', sf);
    ok(/\bBash\b/.test(argAfter(a, '--disallowedTools') || ''), '--disallowedTools 留着（两道）');
    ok(argAfter(a, '--model') === caps.modelFor('review'), `★ argv：--model ${caps.modelFor('review')}（= 能力表 review 那一格）`, JSON.stringify(a));
    ok(rec && !('CLAUDECODE' in rec.env) && !('CLAUDE_CODE_ENTRYPOINT' in rec.env) && rec.env.ANTHROPIC_API_KEY,
      '★ 进程环境：CLAUDECODE / ENTRYPOINT 没了，ANTHROPIC_API_KEY 还在', JSON.stringify(rec && Object.keys(rec.env)));
    ok(rec && rec.env.ENGLOOP_AGENT_TYPE === 'review', '进程环境：ENGLOOP_AGENT_TYPE = review');
    const bad = await runPrint({ text: 'x', type: 'nope' }, { cwd: TMP, timeoutMs: 5000 });
    ok(bad.ok === false && bad.permanent && /启动配置/.test(bad.error), '类型算不出 ⇒ 不起（permanent），不带配置起 = 不带 sandbox', JSON.stringify(bad));
  }

  // ── 起私有 tmux server（带着 DIRTY 环境）──
  tmuxRun(['new-session', '-d', '-s', 'keeper', 'sleep 600']);
  const srvEnv = tmuxRun(['show-environment', '-g', 'CLAUDECODE']).stdout.trim();
  ok(srvEnv === 'CLAUDECODE=1', '（前置）私有 tmux server 的全局环境里有 CLAUDECODE=1 —— 不剥的话会话都会继承它', srvEnv);

  console.log('\n【6】tmux 模式 worker：真跑一次（私有 tmux ＋ 假 claude）');
  {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['-e', `
      const { runTmux } = require(${JSON.stringify(path.join(ROOT, 'lib', 'worker-runner.js'))});
      const caps = require(${JSON.stringify(path.join(ROOT, 'lib', 'agent-capabilities.js'))});
      runTmux({ text: "review it's \\$HOME", type: 'review', job_id: 'lh000001' }, { cwd: ${JSON.stringify(TMP)}, timeoutMs: 20000,
        agentType: 'review', allowedTools: caps.allowedToolsFor('review'), disallowedTools: caps.disallowedToolsFor('review') })
        .then((r) => { console.log(JSON.stringify(r)); process.exit(0); });
    `], { env: tmuxEnv, encoding: 'utf8', timeout: 40000 });
    let res = null;
    try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_) { /* 下面报 */ }
    const rec = await waitRecord(t0, 5000);
    ok(res && res.ok === true && res.via === 'tmux', '★ 会话跑完自己退了（runTmux 判 ok）', `${r.stdout} ${r.stderr}`);
    const a = rec ? rec.argv : [];
    ok(rec && !a.includes('--dangerously-skip-permissions') && argAfter(a, '--permission-mode') === 'dontAsk'
      && argAfter(a, '--setting-sources') === 'user' && /worker-review-/.test(argAfter(a, '--settings') || ''),
    '★ argv：没有 bypass；dontAsk ＋ --setting-sources user ＋ 生成的 worker 配置', JSON.stringify(a));
    ok(a[a.length - 1] === "review it's $HOME" && a[a.length - 2] === '--',
      '★ 提示词在 `--` 之后、原样到达（单引号、$ 没被 shell 吃掉；不被可变参数 --disallowedTools 吞掉）', JSON.stringify(a.slice(-3)));
    ok(argAfter(a, '--model') === caps.modelFor('review'), `argv：--model ${caps.modelFor('review')}（= 能力表 review 那一格）`);
    ok(rec && !('CLAUDECODE' in rec.env) && !('CLAUDE_CODE_SSE_PORT' in rec.env) && rec.env.LAUNCH_TEST_MARK === 'kept',
      '★ 进程环境：tmux server 里的 CLAUDECODE / SSE_PORT 没传进来，别的照传', JSON.stringify(rec && rec.env));
  }

  // ── Redis 测试库（agent-start / orch-start 要登记花名册）──
  const testDb = q.allocTestDb();
  if (testDb === null) { console.log('  ✗ 拿不到测试库 —— 中止'); process.exit(1); }
  const testUrl = q.withDb(q.DEFAULTS.url, testDb);
  const redis = q.createClient(testUrl);
  const childEnv = { ...tmuxEnv, ENGLOOP_REDIS_URL: testUrl, ENGLOOP_AGENT_SETTINGS_DIR: SETTINGS_DIR };

  console.log('\n【7】agent-start：真跑一次（私有 tmux ＋ 假 claude）');
  const CREW = `lh${process.pid % 100000}`;
  const crewCwd = path.join(TMP, 'crewcwd');
  {
    fs.mkdirSync(crewCwd, { recursive: true });
    // trust 预检读 $HOME/.claude.json —— HOME 是临时目录；cwd 不在 git 里 ⇒ trust 根就是 cwd 本身
    fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ projects: { [fs.realpathSync(crewCwd)]: { hasTrustDialogAccepted: true } } }));
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'agent-start.js'), '--name', CREW, '--type', 'dev', '--cwd', fs.realpathSync(crewCwd)],
      { env: childEnv, encoding: 'utf8', timeout: 60000 });
    const rec = await waitRecord(t0, 5000);
    ok(r.status === 0 && rec, '（前置）agent-start 退 0、假 claude 起来了', `status=${r.status} ${r.stdout.slice(-300)} ${r.stderr.slice(-300)}`);
    const a = rec ? rec.argv : [];
    ok(argAfter(a, '--model') === caps.modelFor('dev'), `★ argv：--model ${caps.modelFor('dev')}（= 能力表 dev 那一格）`, JSON.stringify(a));
    ok(!a.includes('--dangerously-skip-permissions') && argAfter(a, '--permission-mode') === 'dontAsk'
      && argAfter(a, '--setting-sources') === 'user' && argAfter(a, '--settings') === path.join(SETTINGS_DIR, `${CREW}.json`),
    'argv：dontAsk ＋ --setting-sources user ＋ 自己那份配置');
    ok(rec && !('CLAUDECODE' in rec.env) && !('CLAUDE_CODE_ENTRYPOINT' in rec.env) && rec.env.ENGLOOP_AGENT_TYPE === 'dev'
      && rec.env.ANTHROPIC_API_KEY, '★ 进程环境：CLAUDECODE 没了（tmux server 里有），ENGLOOP_AGENT_TYPE=dev，用户配置还在',
    JSON.stringify(rec && rec.env));
    tmuxRun(['kill-session', '-t', roster.sessionFor(CREW, 'dev')]);
    await roster.unregister(redis, CREW).catch(() => {});

    const r2 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'agent-start.js'), '--name', CREW, '--worktree', '--cwd', '/tmp'],
      { env: childEnv, encoding: 'utf8', timeout: 20000 });
    ok(r2.status === 1 && /--worktree 和 --cwd 只能给一个/.test(r2.stderr), '--worktree 和 --cwd 一起给 ⇒ 拒绝（说清为什么）', r2.stderr);
  }

  console.log('\n【8】orch-start：真跑一次（私有 tmux ＋ 假 claude ＋ 测试库）');
  {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'orch-start.js')], { env: childEnv, encoding: 'utf8', timeout: 120000 });
    const rec = await waitRecord(t0, 5000);
    ok(r.status === 0 && rec, '（前置）orch-start 退 0、假 claude 起来了', `status=${r.status} ${r.stdout.slice(-300)} ${r.stderr.slice(-300)}`);
    const a = rec ? rec.argv : [];
    ok(!a.includes('--dangerously-skip-permissions') && argAfter(a, '--permission-mode') === 'dontAsk',
      '★ argv：编排者不再 bypass，dontAsk', JSON.stringify(a));
    ok(argAfter(a, '--settings') === path.join(SETTINGS_DIR, 'JARVIS.json') && !a.includes('--setting-sources'),
      '★ argv：带生成的 JARVIS.json，**不**带 --setting-sources（根 .claude/settings.json 的压缩补回 hook 要加载）');
    const sj = JSON.parse(fs.readFileSync(path.join(SETTINGS_DIR, 'JARVIS.json'), 'utf8'));
    ok(sj.permissions.allow.includes(`Edit(/${path.resolve(ROOT)}/**)`), '那份配置就是编排者的（写集 = 仓库根）');
    ok((argAfter(a, '--model') || null) === caps.modelFor('orchestrator'), `★ argv：--model 跟能力表 orchestrator 那一格一致（${caps.modelFor('orchestrator')}）`, JSON.stringify(a));
    ok(rec && !('CLAUDECODE' in rec.env) && rec.env.ENGLOOP_AGENT_TYPE === 'orchestrator', '★ 进程环境：CLAUDECODE 没了，类型 orchestrator');
    tmuxRun(['kill-session', '-t', roster.sessionFor('JARVIS', 'orchestrator')]);

    const t1 = Date.now();
    const rb = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'orch-start.js'), '--bypass-permissions'], { env: childEnv, encoding: 'utf8', timeout: 120000 });
    const recb = await waitRecord(t1, 5000);
    ok(rb.status === 0 && recb && recb.argv.includes('--dangerously-skip-permissions') && /--bypass-permissions：编排者没有 sandbox/.test(rb.stderr),
      '回滚开关 --bypass-permissions ⇒ bypass ＋ 一行警告', `${rb.stderr.slice(-200)} ${JSON.stringify(recb && recb.argv)}`);
    tmuxRun(['kill-session', '-t', roster.sessionFor('JARVIS', 'orchestrator')]);
    await roster.unregister(redis, 'JARVIS').catch(() => {});
  }
  tmuxRun(['kill-server']);
  await redis.quit();

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n【9】自动 worktree（临时仓库）');
  const repo = path.join(TMP, 'repo');
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  fs.mkdirSync(repo, { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'init');
  {
    const w = PW.ensureWorktree({ root: repo, name: 'dev9' });
    ok(w.created && w.path === path.join(TMP, 'repo-worktrees', 'dev9') && w.branch === 'wt/dev9' && w.behind === 0,
      '不存在 ⇒ `git worktree add -b wt/dev9 ../repo-worktrees/dev9 main`', JSON.stringify(w));
    fs.writeFileSync(path.join(w.path, 'wip.txt'), 'uncommitted\n');
    g(w.path, 'commit', '--allow-empty', '-qm', 'wt work');
    const headBefore = g(w.path, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'main moved\n');
    g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'main moves');
    const w2 = PW.ensureWorktree({ root: repo, name: 'dev9' });
    ok(!w2.created && g(w.path, 'rev-parse', 'HEAD') === headBefore && fs.existsSync(path.join(w.path, 'wip.txt')),
      '★ 已存在 ⇒ 不动它（HEAD 不变、未提交文件还在）');
    ok(w2.behind === 1, '★ 落后 main ⇒ 报出落后几个 commit（agent-start 据此打提示）', JSON.stringify(w2));
    fs.mkdirSync(path.join(TMP, 'repo-worktrees', 'plain'), { recursive: true });
    let threw = null;
    try { PW.ensureWorktree({ root: repo, name: 'plain' }); } catch (e) { threw = e.message; }
    ok(threw && /不是一棵 git worktree 的根/.test(threw), '目录在、但不是 worktree ⇒ 不碰，报错', threw);
  }

  console.log('\n【9b】linked worktree 里的 agent 挪不了主仓库的 main（sandbox denyWrite）');
  {
    const wt = path.join(TMP, 'repo-worktrees', 'dev9');
    const common = path.join(repo, '.git');
    const loose = path.join(common, 'refs', 'heads', 'main');
    // ① main 是 loose 文件（新仓库的默认形态）
    ok(fs.existsSync(loose), '（前置）此刻 main 是 loose 文件');
    const guard = AS.mainRefGuard(wt);
    ok(guard.includes(loose) && guard.includes(`${loose}.lock`) && guard.includes(path.join(common, 'HEAD'))
      && guard.includes(path.join(common, 'HEAD.lock')),
    '★ loose：main 的 loose 文件、它的 .lock、主 HEAD、HEAD.lock 都在', JSON.stringify(guard));
    ok(!guard.some((g) => g.includes('packed-refs')),
      '★ loose：**不碰** packed-refs / packed-refs.lock（loose 优先；deny 它们 ⇒ agent 删不了任何分支）', JSON.stringify(guard));
    ok(!guard.some((g) => g.includes(path.join('refs', 'heads', 'wt'))) && !guard.some((g) => g.includes(path.join('worktrees', 'dev9'))),
      '自己的分支和自己的 worktree 元数据不在里面（agent 要在 wt/dev9 上提交）');
    const s = AS.buildAgentSettings({ kind: 'crew', name: 'dev9', type: 'dev', cwd: wt, root: '/fake/engloop' });
    ok(guard.every((g) => s.sandbox.filesystem.denyWrite.includes(g)), '★ agent 配置的 sandbox denyWrite 里带着它');
    ok(AS.mainRefGuard(repo).length === 0 && AS.mainRefGuard('/fake/not/git').length === 0,
      '主仓库本身、不在 git 里的目录 ⇒ 不加（agent 的配置跟以前一样）');
    // ② main 只在 packed-refs 里（pack-refs / gc 之后）
    g(repo, 'pack-refs', '--all');
    ok(!fs.existsSync(loose) && fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').includes(' refs/heads/main'),
      '（前置）pack-refs 之后 main 只在 packed-refs 里');
    const g2 = AS.mainRefGuard(wt);
    ok(g2.includes(path.join(common, 'packed-refs')) && g2.includes(path.join(common, 'packed-refs.lock'))
      && g2.includes(`${loose}.lock`),
    '★ packed：deny packed-refs 本体 ＋ .lock ＋ main.lock（防止建一个 loose main 盖过 packed 那份）', JSON.stringify(g2));
    ok(!g2.includes(loose), '★ packed：不存在的 loose 本体**不** deny（Linux 上占位会让 git 读 main 时坏掉）');
    // 还原成 loose，后面【10】要合并
    // （update-ref 写同一个值时 git 不落 loose 文件 ⇒ 直接写；loose 优先，packed 里那份留着无害）
    fs.writeFileSync(loose, `${g(repo, 'rev-parse', 'main')}\n`);
    ok(fs.existsSync(loose), '（还原）main 回到 loose');
  }

  console.log('\n【10】wt-merge 的闸（临时仓库）');
  {
    const cache = path.join(TMP, 'vcache');
    const wt = path.join(TMP, 'repo-worktrees', 'dev9');
    fs.rmSync(path.join(wt, 'wip.txt'));
    // 先把 main 合进来 ⇒ 下面那次合并**本来可以 fast-forward** —— 否则 --no-ff 那条判据分不出有没有 --no-ff
    // （否则变异 L16 会活下来：main 已经往前走了，git 怎样都得做一个合并 commit）。
    g(wt, 'merge', '-q', '--no-edit', 'main');
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'feature\n');
    fs.writeFileSync(path.join(wt, 'shared.txt'), 'changed by wt\n');
    g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'feature');
    const sha = g(wt, 'rev-parse', 'HEAD');
    const M = (env = {}, o = {}) => PW.mergeWorktree({ root: repo, name: 'dev9', cacheRoot: cache, readVerdict: V.readVerdict, isFullSuite: V.isFullSuite, env, ...o });
    const mainBefore = g(repo, 'rev-parse', 'main');

    let r = M({ ENGLOOP_AGENT_TYPE: 'dev' });
    ok(!r.ok && r.code === 'not_orchestrator', '★ agent（ENGLOOP_AGENT_TYPE=dev）调用 ⇒ 拒', r.message);
    r = M();
    ok(!r.ok && r.code === 'no_verify' && r.message.includes('verify-complete.js --evidence') && r.message.includes(sha),
      '★ 没有 verify 记录 ⇒ 拒，并给出跑 verify 的命令（带这个 sha）', r.message);
    V.writeVerdict(cache, sha, { verdict: 'fail', checks: [], missing: ['新增失败 x'], ms: 1 });
    r = M();
    ok(!r.ok && r.code === 'verify_not_pass' && /新增失败 x/.test(r.message), '★ 记录是 fail ⇒ 拒（说出原因）', r.message);
    V.writeVerdict(cache, sha, { verdict: 'unverifiable', checks: [], missing: [], ms: 1 });
    r = M();
    ok(!r.ok && r.code === 'verify_not_pass', 'unverifiable 也不算 pass');
    // ★ pass 但只跑了一个文件 ⇒ 不当成合并的闸
    V.writeVerdict(cache, sha, { verdict: 'pass', checks: [], missing: [], ms: 1, tests: 'node test/run-all.js --only graph.test.js' });
    r = M();
    ok(!r.ok && r.code === 'verify_partial' && r.message.includes('node test/run-all.js') && r.message.includes('--allow-partial'),
      '★ pass 但 tests 是 --only（agent 自己选的范围）⇒ 拒 verify_partial，提示用全量重核', r.message);
    r = M({}, { isFullSuite: undefined });
    ok(!r.ok && r.code === 'verify_partial', '调用方没传 isFullSuite ⇒ 拒（判不了不当成全量）');
    V.writeVerdict(cache, sha, { verdict: 'pass', checks: [{ ok: true, name: '失败集合', detail: '没有新增' }], missing: [], ms: 1234, tests: 'node test/run-all.js' });
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'someone else editing\n');
    r = M();
    ok(!r.ok && r.code === 'overlap' && r.message.includes('shared.txt'), '★ main 上有未提交改动、跟要合的文件有交集 ⇒ 拒', r.message);
    ok(g(repo, 'rev-parse', 'main') === mainBefore, '拒绝时 main 一个 commit 都没多');
    g(repo, 'checkout', '-q', '--', 'shared.txt');
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'dirty but unrelated\n');
    // CLI 走一次（退出码 ＋ 输出），用 ENGLOOP_VERIFY_CACHE 指向临时缓存
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'wt-merge.js'), 'dev9', '--repo', repo],
      { env: { ...baseEnv, ENGLOOP_VERIFY_CACHE: cache, ENGLOOP_AGENT_TYPE: 'orchestrator' }, encoding: 'utf8' });
    ok(cli.status === 0 && /已合并 wt\/dev9/.test(cli.stdout), '★ 有 pass 记录、无交集（无关的脏文件不挡）⇒ bin/wt-merge.js 合并成功', `${cli.stdout} ${cli.stderr}`);
    const parents = g(repo, 'rev-list', '--parents', '-n', '1', 'main').split(' ');
    const body = g(repo, 'log', '-1', '--format=%B', 'main');
    ok(g(repo, 'merge-base', '--is-ancestor', mainBefore, sha) === '' , '（前置）这次本来可以 fast-forward（main 是 wt/dev9 的祖先）');
    ok(parents.length === 3 && parents[1] === mainBefore && parents[2] === sha, '--no-ff：合并 commit 两个父，第二个是 wt/dev9 的 HEAD');
    ok(/verify-complete: pass/.test(body) && /tests: node test\/run-all\.js/.test(body) && /✓ 失败集合/.test(body),
      'commit message 带 verify 记录的摘要', body);
    ok(fs.existsSync(path.join(repo, 'unrelated.txt')), '无关的未提交文件原样留着');
    // CLI 的拒绝退出码
    const cli2 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'wt-merge.js'), 'dev9', '--repo', repo],
      { env: { ...baseEnv, ENGLOOP_VERIFY_CACHE: cache, ENGLOOP_AGENT_TYPE: 'dev' }, encoding: 'utf8' });
    ok(cli2.status === 4 && /not_orchestrator/.test(cli2.stderr), 'CLI：agent 调用 ⇒ exit 4');
    // ★ --only 的 pass ⇒ CLI exit 3；明说 --allow-partial ⇒ 合，message 带标记
    fs.writeFileSync(path.join(wt, 'more.txt'), 'more\n'); g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'more');
    const shaP = g(wt, 'rev-parse', 'HEAD');
    V.writeVerdict(cache, shaP, { verdict: 'pass', checks: [], missing: [], ms: 1, tests: 'node test/run-all.js --only graph.test.js' });
    const envO = { ...baseEnv, ENGLOOP_VERIFY_CACHE: cache, ENGLOOP_AGENT_TYPE: 'orchestrator' };
    const cli3 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'wt-merge.js'), 'dev9', '--repo', repo], { env: envO, encoding: 'utf8' });
    ok(cli3.status === 3 && /verify_partial/.test(cli3.stderr), 'CLI：--only 的 pass ⇒ exit 3 verify_partial', cli3.stderr);
    const cli4 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'wt-merge.js'), 'dev9', '--repo', repo, '--allow-partial'], { env: envO, encoding: 'utf8' });
    const body4 = g(repo, 'log', '-1', '--format=%B', 'main');
    ok(cli4.status === 0 && /--allow-partial/.test(cli4.stderr) && /tests: node test\/run-all\.js --only graph\.test\.js（不是全量，--allow-partial）/.test(body4),
      '★ --allow-partial ⇒ 合并、打警告、commit message 写明「不是全量」', `${cli4.stderr} ${body4}`);
    // 冲突 ⇒ abort，main 回原样
    fs.writeFileSync(path.join(wt, 'a.txt'), 'wt side\n'); g(wt, 'commit', '-qam', 'wt a');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'main side\n'); g(repo, 'commit', '-qam', 'main a');
    const sha2 = g(wt, 'rev-parse', 'HEAD');
    V.writeVerdict(cache, sha2, { verdict: 'pass', checks: [], missing: [], ms: 1, tests: 'node test/run-all.js' });
    const before2 = g(repo, 'rev-parse', 'main');
    r = M();
    ok(!r.ok && r.code === 'conflict' && r.message.includes('a.txt'), '冲突 ⇒ 拒，说出冲突文件', r.message);
    ok(!/merge_failed/.test(r.code), '有冲突文件时叫 conflict，不叫 merge_failed（两种修法不一样）');
    ok(g(repo, 'rev-parse', 'main') === before2 && !fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')),
      '冲突后 merge --abort：main 没动、没有半截合并');
  }

  console.log('\n【11】verify-complete 按 sha 落结论（wt-merge 读的就是它）');
  {
    const cache = path.join(TMP, 'vcache2');
    const head = g(repo, 'rev-parse', 'HEAD');
    const first = g(repo, 'rev-list', '--max-parents=0', 'HEAD');
    const rv = await V.verify({ kind: 'code', repo, commit: first, tests: 'node test/run-all.js' }, { cacheRoot: cache });
    const rec = V.readVerdict(cache, first);
    ok(rv.verdict === 'fail' && rec && rec.verdict === 'fail' && rec.sha === first,
      '核验一个不是 HEAD 的 commit ⇒ fail，结论按那个 sha 落盘', JSON.stringify(rec).slice(0, 300));
    ok(V.readVerdict(cache, head) === null, '没核过的 sha ⇒ 没有记录（不是 pass）');
    ok(V.verdictFile(cache, first).startsWith(path.join(cache, 'verdicts')), '落在 <cacheRoot>/verdicts/ 下（agent 的 QA deny 盖住 temp/verify-cache/**）');
    ok(AS.qaGuarded({ cwd: '/w', root: '/r' }).includes('/r/temp/verify-cache/**'), '（前置）temp/verify-cache/** 在所有 agent 的 QA deny 里');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log(`  ✗ 崩了：${e.stack}`);
  try { tmuxRun(['kill-server']); } catch (_) { /* 已经没了 */ }
  process.exit(1);
});
