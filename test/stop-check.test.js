'use strict';

/**
 * Stop hook（hooks/stop_check.js 的离线那一半）：
 *   没改东西 ⇒ 放行，且**快**（< 1 秒，写进标签）· 改坏 lib ⇒ exit 2 点名那条 ·
 *   【2b】自己的状态代替 stop_hook_active（S1B）：stop_hook_active=true 照样测 · 同指纹绿过不重跑 · 同指纹连红 K 次放行 · 指纹变了重跑 · 状态坏了当没有 ·
 *   改动映射不到测试 ⇒ 放行（不跑全量）· 改的是测试文件 ⇒ 跑它本身 · 不在 git 里 ⇒ 放行 · 超预算 ⇒ 放行并说明
 * 真 claude 那一半（被拦回去继续修）不在这里测，要手工验。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const H = require('../hooks/stop_check');
const { makeFixture } = require('./verify-fixture');

const HOOK = path.join(__dirname, '..', 'hooks', 'stop_check.js');
let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

function runHook(input, env = {}, extraArgv = []) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [HOOK, ...extraArgv], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, err: r.stderr || '', ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

console.log('\nStop hook（范围内快测）\n');

console.log('【1】映射（纯函数）');
const ex = (set) => (p) => set.includes(p);
ok(H.testsFor(['lib/math.js'], ex(['test/math.test.js'])).join() === 'test/math.test.js', 'lib/x.js ⇒ test/x.test.js');
ok(H.testsFor(['bin/next.js'], ex(['test/next.test.js'])).join() === 'test/next.test.js', 'bin/x.js ⇒ test/x.test.js');
ok(H.testsFor(['lib/nomap.js', 'README.md', 'lib/sub/deep.js'], ex([])).length === 0, '映射不到（没有对应测试 / 不是 lib|bin 顶层）⇒ 一个都不跑');
ok(H.testsFor(['test/graph.test.js', 'lib/graph.js'], ex(['test/graph.test.js'])).join() === 'test/graph.test.js', '改的是测试文件 ⇒ 跑它本身（去重）');
ok(H.testsFor(['test/verify-fixture.js'], ex([])).length === 0, 'test/ 下不是 .test.js 的辅助文件 ⇒ 不跑');

console.log('\n【2】夹具仓库上实跑（带 --settings，测试在 sandbox 里跑）');
const Sx = require('../lib/agent-settings');
const SPx = require('../lib/sandbox-profile');
const fx = makeFixture();
// 一份真的框架配置（type dev，cwd = 夹具仓库），Stop hook 据它建 sandbox
const settings = Sx.writeCrewSettings({ name: 'stopfix', type: 'dev', cwd: fx.repo, root: fx.repo });
const hook = (input, env = {}) => runHook({ ...input }, env, ['--settings', settings]);
try {
  const clean = [hook({ cwd: fx.repo, stop_hook_active: false }), hook({ cwd: fx.repo, stop_hook_active: false }), hook({ cwd: fx.repo, stop_hook_active: false })];
  const worst = Math.max(...clean.map((r) => r.ms));
  ok(clean.every((r) => r.code === 0), '没改任何东西 ⇒ 放行（exit 0）');
  ok(worst < 1000, `没改任何东西 ⇒ 快：跑三次 ${clean.map((r) => `${Math.round(r.ms)}ms`).join(' / ')}（含 node 启动），都 < 1 秒`, String(worst));

  if (SPx.available()) {
    fx.setBroken({ mul: true });       // 没提交 ⇒ git status 里有 lib/math.js
    const b = hook({ cwd: fx.repo, stop_hook_active: false });
    ok(b.code === 2, '改坏 lib/math.js ⇒ exit 2（拦，测试在 sandbox 里跑）', `${b.code} ${b.err}`);
    ok(/test\/math\.test\.js/.test(b.err) && /mul 2\*3=6/.test(b.err) && !/add 2\+3=5/.test(b.err), 'stderr 写了哪个文件、哪一条（只有 mul 那条）', b.err.slice(0, 400));
    ok(/不是全量/.test(b.err) && /sandbox/.test(b.err), 'stderr 说明跑的只是范围内的测试、且在 sandbox 里');
  } else {
    console.log('  ⚠ 跳过「改坏 ⇒ exit 2」：没有 sandbox-exec');
  }
  // ── 【2b】自己的状态代替 stop_hook_active（S1B）：状态目录走 ENGLOOP_LOOP_GUARD_DIR 指到临时目录 ──
  if (SPx.available()) {
    const GUARD = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-stopstate-'));
    const genv = { ENGLOOP_LOOP_GUARD_DIR: GUARD };
    const named = (name, input = {}) => runHook({ cwd: fx.repo, stop_hook_active: false, ...input }, genv, ['--settings', settings, '--name', name]);
    const stFile = (name) => path.join(GUARD, `${name}.stopcheck.json`);
    const st = (name) => { try { return JSON.parse(fs.readFileSync(stFile(name), 'utf8')); } catch (_) { return null; } };
    const top = spawnSync('git', ['-C', fx.repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
    const fpNow = () => { const ch = H.changedPaths(top); return H.fingerprint(top, ch, H.testsFor(ch, (rel) => fs.existsSync(path.join(top, rel)))); };

    // ★ 原缺口的复现：stop_hook_active=true（被 loop_guard 拦过之后一直是它）＋ 一份新改动 ⇒ **照样跑、红就拦**
    fx.setBroken({ mul: true });
    const gap = named('sa', { stop_hook_active: true });
    ok(gap.code === 2 && /mul 2\*3=6/.test(gap.err), '★ stop_hook_active=true 且有新改动 ⇒ 仍然跑测试、红就拦（原来这里直接放行 —— loop_guard 拦回之后整个会话都不再测）', `${gap.code} ${gap.err.slice(0, 200)}`);
    ok(st('sa') && st('sa').result === 'fail' && st('sa').blocks === 1, '状态记下：这个指纹红、连拦 1 次', JSON.stringify(st('sa')));

    // 同一指纹、上次红、还没到 K ⇒ 照常跑；到 K ⇒ 放行并说明
    const r2 = named('sa', { stop_hook_active: true });
    ok(r2.code === 2 && st('sa').blocks === 2, `同一份改动、上次红、连拦 1 次 < K=${H.SAME_FAIL_LIMIT} ⇒ 照常跑、照样拦（blocks=2）`, `${r2.code} ${JSON.stringify(st('sa'))}`);
    const r3 = named('sa', { stop_hook_active: true });
    ok(r3.code === 0 && /连红 2 次，不再拦/.test(r3.err), `★ 同一份改动连红 K=${H.SAME_FAIL_LIMIT} 次 ⇒ 放行，stderr 说明（防「改不好又结束」的来回 —— Claude Code 的上限兜不住中间有工具调用的拦截）`, `${r3.code} ${r3.err}`);

    // 指纹变了 ⇒ 照常跑（换一处坏法）
    fx.setBroken({ add: true });
    const r4 = named('sa');
    ok(r4.code === 2 && /add 2\+3=5/.test(r4.err) && st('sa').blocks === 1, '★ 指纹变了（换了一份改动）⇒ 照常跑、红就拦，计数从 1 重数', `${r4.code} ${JSON.stringify(st('sa'))}`);

    // 改对了（跟提交的不一样、但测试绿）⇒ 跑、绿 ⇒ 记 pass
    fx.setBroken({});
    fx.write('lib/math.js', `${fs.readFileSync(path.join(fx.repo, 'lib/math.js'), 'utf8')}// tweak\n`);
    const r5 = named('sa');
    ok(r5.code === 0 && st('sa') && st('sa').result === 'pass', '改动绿 ⇒ 放行，状态记 pass', `${r5.code} ${JSON.stringify(st('sa'))}`);

    // ★ 指纹同上次、上次绿 ⇒ 不重跑：把「绿」的状态写给一份**坏的**改动，hook 若重跑就会拦 —— 放行 = 没跑
    fx.setBroken({ mul: true });
    fs.writeFileSync(stFile('sb'), JSON.stringify({ fingerprint: fpNow(), result: 'pass', blocks: 0 }));
    const r6 = named('sb');
    ok(r6.code === 0 && r6.err === '', '★ 指纹同上次且上次绿 ⇒ 直接放行、不重跑（这份改动其实是坏的 —— 跑了就会拦）', `${r6.code} ${r6.err.slice(0, 160)}`);
    // 阳性对照：同一份坏改动、状态是别的指纹 ⇒ 跑、拦
    fs.writeFileSync(stFile('sb'), JSON.stringify({ fingerprint: 'deadbeef', result: 'pass', blocks: 0 }));
    ok(named('sb').code === 2, '阳性对照：指纹对不上 ⇒ 照常跑、拦');

    // 状态文件坏了 / 读不了 ⇒ 当没有、照常跑
    fs.writeFileSync(stFile('sc'), '{坏的');
    const r7 = named('sc');
    ok(r7.code === 2, '状态文件坏了 ⇒ 当没有、照常跑（错的方向是多跑一次）', `${r7.code}`);
    // 形状不对：指纹对得上、写着 pass —— 但 blocks 不是整数 ⇒ 整份不认（认了就会「绿过、不重跑」放走这份坏改动）
    fs.writeFileSync(stFile('sd'), JSON.stringify({ fingerprint: fpNow(), result: 'pass', blocks: 'x' }));
    ok(named('sd').code === 2, '状态形状不对（blocks 不是整数，哪怕写着 pass、指纹也对）⇒ 当没有、照常跑');

    // 没有 --name ⇒ 不记状态，每次都跑（连红多少次都拦 —— 生产配置都带 --name）
    const noName = [0, 1, 2].map(() => runHook({ cwd: fx.repo, stop_hook_active: true }, genv, ['--settings', settings]).code);
    ok(noName.join(',') === '2,2,2' && !fs.readdirSync(GUARD).some((f) => f.startsWith('undefined')), '没有 --name ⇒ 不记状态、每次都跑（2,2,2）', noName.join(','));

    // 挂载：生产配置的 stop_check 命令带 --name <自己的名字>
    const devS = Sx.buildCrewSettings({ name: 'dev', type: 'dev', cwd: '/tmp/x' });
    ok(/stop_check\.js" --settings "[^"]+" --name dev$/.test(devS.hooks.Stop[0].hooks[0].command), '框架配置里 stop_check 带 --name <自己的名字>', devS.hooks.Stop[0].hooks[0].command);
    fs.rmSync(GUARD, { recursive: true, force: true });
    fx.setBroken({});
  } else {
    console.log('  ⚠ 跳过【2b】（状态 × 测试真跑）：没有 sandbox-exec');
  }

  fx.setBroken({});
  fx.write('lib/extra.js', 'exports.x = 1;\n');      // 映射不到测试
  const n = hook({ cwd: fx.repo, stop_hook_active: false });
  ok(n.code === 0, '改动映射不到测试 ⇒ 放行（宁可不拦，不跑全量）', n.err);

  // 没有 --settings / 没有 sandbox-exec ⇒ 放行、不在 sandbox 外跑
  fx.setBroken({ mul: true });
  const noSettings = runHook({ cwd: fx.repo, stop_hook_active: false }, {}, []);
  ok(noSettings.code === 0 && /没拿到 --settings/.test(noSettings.err), '没有 --settings ⇒ 放行、说明（不退回成不带 sandbox 跑）', noSettings.err.slice(0, 120));
  fx.setBroken({});
} finally {
  fx.cleanup();
}
const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-nogit-'));
const ng = runHook({ cwd: notGit, stop_hook_active: false });
ok(ng.code === 0, '不在 git 里 ⇒ 放行');
fs.rmSync(notGit, { recursive: true, force: true });
const junk = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', cwd: os.tmpdir() });
ok(junk.status === 0, '输入不是 JSON ⇒ 放行（hook 自己出问题不能把 agent 卡死）');

console.log('\n【3】接线：框架配置里挂上了');
const S = require('../lib/agent-settings');
const dev = S.buildCrewSettings({ name: 'x', type: 'dev', cwd: '/tmp/x' });
const evalS = S.buildCrewSettings({ name: 'y', type: 'eval', cwd: '/tmp/y' });
const stop = dev.hooks.Stop && dev.hooks.Stop[0].hooks[0];
ok(stop && stop.command.includes('hooks/stop_check.js') && stop.timeout > H.BUDGET_MS / 1000, 'dev（能写）挂了 Stop hook，timeout 比 hook 自己的预算大', JSON.stringify(stop));
// 只断言「没有 stop_check」：Stop 上挂不挂 loop_guard（S1B）由 test/loop-guard.test.js【9】的挂载矩阵管。
ok(!JSON.stringify(evalS.hooks.Stop || []).includes('stop_check'), 'eval（不能写）不挂 stop_check');

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
