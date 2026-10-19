'use strict';

/**
 * Stop hook（hooks/stop_check.js 的离线那一半）：
 *   没改东西 ⇒ 放行，且**快**（< 1 秒，写进标签）· stop_hook_active ⇒ 放行 · 改坏 lib ⇒ exit 2 点名那条 ·
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
  const again = hook({ cwd: fx.repo, stop_hook_active: true });
  ok(again.code === 0 && again.ms < 1000, 'stop_hook_active:true ⇒ 放行（防死循环），而且不跑测试', `${again.code} ${Math.round(again.ms)}ms`);

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
ok(!evalS.hooks.Stop, 'eval（不能写）不挂 Stop hook');

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
