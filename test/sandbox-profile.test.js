'use strict';

/**
 * sandbox-profile ＋「agent 写的测试在 sandbox 里跑」。
 *
 * 【0】生成器纯函数 ＋ 关键断言内存变异。
 * 【1】**红在修之前**：一个恶意测试夹具（读假 token 写到 cwd、往工作树外写、连公网）——
 *      不套 sandbox 直接跑 ⇒ 三件事都成（证明夹具能分辨）。假 token 放夹具自己的 temp/bus-admin.token。
 * 【2】**绿在修之后**：同一个夹具套上 sandbox profile ⇒ 三件事都 EPERM；正常的写（工作树内、tmp）照常成。
 * 【2b】接到 Stop hook / verify-complete 上实跑：Stop hook 拦住恶意测试（exit 2）、verify-complete 不把假 token 写出来。
 *
 * 夹具在 os.tmpdir() 下（不碰真 token）。装置：`/usr/bin/sandbox-exec`（没有就跳过 sandbox 那几条，说明）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SP = require('../lib/sandbox-profile');
const S = require('../lib/agent-settings');

let pass = 0, fail = 0, skip = 0;
const ok = (c, l, d = '') => c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));
const skipit = (l) => { skip++; console.log(`  ⚠ 跳过（没有 sandbox-exec）：${l}`); };

console.log('\nsandbox-profile ＋ sandbox 里跑测试\n');

// ── 【0】生成器 ─────────────────────────────────────────────────────────────
console.log('【0】profile 生成器');
{
  const prof = SP.buildProfile({ allowWrite: ['/w/a'], denyRead: ['/s/tok'], reDenyWrite: ['/w/a/hooks'], allowTmp: false });
  ok(/\(deny file-read\* \(literal "[^"]*\/s\/tok"\)\)/.test(prof), '拒读里有钥匙（literal）');
  ok(/\(deny network-outbound \(remote ip "\*:\*"\)\)/.test(prof) && /\(allow network-outbound \(remote ip "localhost:\*"\)\)/.test(prof), '网络：先全拒再放 localhost');
  ok(/\(deny file-write\*\)/.test(prof), '写：先全拒');
  const wi = prof.indexOf('(allow file-write* (subpath'); const di = prof.indexOf('(deny file-write* (subpath');
  ok(wi > 0 && di > wi, 'reDenyWrite 的 deny 排在 allow 之后（SBPL 后者覆盖前者）', `allow@${wi} deny@${di}`);
}

// ── 夹具 ────────────────────────────────────────────────────────────────────
function makeEvil(parent = os.tmpdir()) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'engloop-sbfix-')));
  const w = (rel, t) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), t); };
  w('temp/bus-admin.token', 'SECRET-TOKEN-XYZ\n');       // 假 token（夹具自己的）
  w('config/users.json', '[{"key_sha256":"deadbeef"}]');
  w('hooks/.keep', '');
  w('temp/agent-settings/.keep', '');
  // 恶意测试：读假 token 写到 cwd/stolen；往工作树外写；连公网。每件事的结果记进 report。
  // ★ 写「工作树外」挑一个既不在树里、也不在 tmp 里的路径 —— 父目录（parent 的上一级一般是 /）不可写，
  //   所以挑 HOME 下一个名字：sandbox 放 tmp，但不放 HOME，正好能分辨。
  const outside = path.join(os.homedir(), `.engloop-sbfix-pwned-${process.pid}`);
  w('evilpaths.json', JSON.stringify({ token: path.join(root, 'temp/bus-admin.token'), cwdSteal: path.join(root, 'stolen.txt'), outside }));
  w('test/evil.test.js', `'use strict';
const fs = require('fs'); const net = require('net');
const P = require(require('path').join(__dirname, '..', 'evilpaths.json'));
const r = {};
try { const t = fs.readFileSync(P.token, 'utf8'); fs.writeFileSync(P.cwdSteal, t); r.readToken = 'ok:' + t.trim(); } catch (e) { r.readToken = e.code || String(e.message); }
try { fs.writeFileSync(P.outside, 'x'); r.writeOutside = 'ok'; } catch (e) { r.writeOutside = e.code || String(e.message); }
const done = () => { console.log('EVIL ' + JSON.stringify(r)); console.log('通过 0 · 失败 1'); process.exit(1); };
const s = net.connect({ host: '1.1.1.1', port: 443 });
let fin = false; const end = (v) => { if (fin) return; fin = true; r.net = v; try { s.destroy(); } catch (_) {} done(); };
s.on('connect', () => end('ok')); s.on('error', (e) => end(e.code || 'err')); setTimeout(() => end('timeout'), 3000);
`);
  // 正常测试：写工作树内 scratch、写 tmp —— 都该成。
  w('test/good.test.js', `'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
let ok = true;
try { fs.writeFileSync(path.join(__dirname, '..', 'scratch.txt'), 'x'); } catch (_) { ok = false; }
try { fs.writeFileSync(path.join(os.tmpdir(), 'engloop-sbgood-' + process.pid), 'x'); } catch (_) { ok = false; }
console.log('通过 ' + (ok ? 1 : 0) + ' · 失败 ' + (ok ? 0 : 1)); process.exit(ok ? 0 : 1);
`);
  return {
    root, outside,
    settingsFile() {
      // 一份真的框架配置（type dev，cwd = root）—— Stop hook 要从它读 sandbox.filesystem
      const f = S.writeCrewSettings({ name: 'sbfix', type: 'dev', cwd: root, root });
      return f;
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); try { fs.rmSync(outside, { force: true }); } catch (_) {} },
  };
}

const parse = (out) => { const m = out.match(/EVIL (\{.*\})/); return m ? JSON.parse(m[1]) : null; };

// ── 【1】红在修之前：不套 sandbox 直接跑恶意测试 ──────────────────────────────
console.log('\n【1】夹具能分辨（不套 sandbox 直接跑恶意测试 ⇒ 三件坏事都成）');
// ★ 这个文件自己跑在限制性 sandbox 里时（核验 EngLoop 自己），「不套 sandbox」那个对照就不成立了 —— 跳过。
if (!SP.available()) { skipit('【1】（这个进程本身在 sandbox 里，没有「不套 sandbox」的对照）'); }
else {
  const fx = makeEvil();
  try {
    const r = spawnSync(process.execPath, [path.join(fx.root, 'test/evil.test.js')], { cwd: fx.root, encoding: 'utf8' });
    const got = parse(r.stdout + r.stderr);
    ok(got && got.readToken.startsWith('ok:SECRET'), '不套 sandbox：读到了假 token 并写进了 cwd', JSON.stringify(got));
    ok(got && got.writeOutside === 'ok', '不套 sandbox：往工作树外写成功', got && got.writeOutside);
    ok(fs.existsSync(path.join(fx.root, 'stolen.txt')), '不套 sandbox：cwd 里真出现了偷来的 token');
    // net 可能因离线而 err —— 不作为「夹具能分辨」的必要条件，只记录
    console.log(`     （联网那件事不套 sandbox 的结果：${got && got.net}）`);
  } finally { fx.cleanup(); }
}

// ── 【2】绿在修之后：套上 profile ⇒ 三件坏事 EPERM，正常写照常 ───────────────
console.log('\n【2】套上 sandbox profile ⇒ 坏事 EPERM、正常写照常');
if (!SP.available()) { skipit('【2】整段'); }
else {
  const fx = makeEvil();
  try {
    const root = fx.root;
    const prof = SP.buildProfile({
      allowWrite: [root], denyRead: S.secretPaths(root),
      reDenyWrite: [path.join(root, 'temp', 'agent-settings'), path.join(root, 'hooks'), path.join(root, '.claude')],
      allowTmp: true,
    });
    const pf = path.join(root, 'profile.sb'); fs.writeFileSync(pf, prof);
    const runSb = (testRel) => {
      const argv = SP.wrap(pf, [process.execPath, path.join(root, testRel)]);
      return spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8' });
    };
    const ev = runSb('test/evil.test.js');
    const got = parse(ev.stdout + ev.stderr);
    ok(got && got.readToken === 'EPERM', '读假 token ⇒ EPERM', JSON.stringify(got));
    ok(!fs.existsSync(path.join(root, 'stolen.txt')), 'cwd 里没有出现偷来的 token（读那一步就被拦了）');
    ok(got && got.writeOutside === 'EPERM', '往工作树外（HOME 下）写 ⇒ EPERM', got && got.writeOutside);
    ok(got && (got.net === 'EPERM' || got.net === 'ENETUNREACH' || got.net === 'ENETDOWN'), '连公网 1.1.1.1:443 ⇒ 被拒', got && got.net);
    ok(!fs.existsSync(fx.outside), '工作树外那个文件真的没被建出来');
    // reDenyWrite：写 temp/agent-settings、hooks ⇒ EPERM
    fs.writeFileSync(path.join(root, 'test/esc.test.js'), `const fs=require('fs');const p=require('path');const r={};
for(const[k,x]of Object.entries({settings:${JSON.stringify(path.join(root, 'temp/agent-settings/sbfix.json'))},hooks:${JSON.stringify(path.join(root, 'hooks/x.js'))},cwd:${JSON.stringify(path.join(root, 'ok.txt'))}})){try{fs.writeFileSync(x,'x');r[k]='ok'}catch(e){r[k]=e.code}}
console.log('EVIL '+JSON.stringify(r));console.log('通过 0 · 失败 1');process.exit(1);`);
    const esc = parse(runSb('test/esc.test.js').stdout + '');
    ok(esc && esc.settings === 'EPERM' && esc.hooks === 'EPERM', 'reDenyWrite：写自己的 agent-settings / hooks ⇒ EPERM', JSON.stringify(esc));
    ok(esc && esc.cwd === 'ok', '工作树里的普通位置照常能写（正常测试不会被误伤）', esc && esc.cwd);
    // 正常测试：全绿 + 真写到了 scratch
    const good = runSb('test/good.test.js');
    ok(/通过 1 · 失败 0/.test(good.stdout) && fs.existsSync(path.join(root, 'scratch.txt')), '正常测试在 sandbox 里照常通过、照常写到工作树内', good.stdout.trim());
  } finally { fx.cleanup(); }
}

// ── 【2b】接到 Stop hook 上 ──────────────────────────────────────────────────
console.log('\n【2b】Stop hook：恶意测试被拦（exit 2），没有 --settings / 没 sandbox ⇒ 放行');
if (!SP.available()) { skipit('【2b】整段'); }
else {
  const fx = makeEvil();
  try {
    const root = fx.root;
    const settings = fx.settingsFile();   // 写进 root/temp/agent-settings/sbfix.json
    // 需要让 git status 里有改动，且映射命中 evil.test.js —— 建个 git 仓库、动一下
    spawnSync('git', ['-C', root, 'init', '-q']); spawnSync('git', ['-C', root, 'config', 'user.email', 'a@b.c']);
    spawnSync('git', ['-C', root, 'config', 'user.name', 'a']); spawnSync('git', ['-C', root, 'add', '-A']);
    spawnSync('git', ['-C', root, 'commit', '-qm', 'x']);
    fs.appendFileSync(path.join(root, 'test/evil.test.js'), '\n// touch\n');   // 改测试文件 ⇒ 映射到它自己
    const HOOK = path.join(__dirname, '..', 'hooks', 'stop_check.js');
    const run = (args) => spawnSync(process.execPath, [HOOK, ...args], { input: JSON.stringify({ cwd: root, stop_hook_active: false }), encoding: 'utf8' });
    const r1 = run(['--settings', settings]);
    // ⚠️ 只看 exit 2 不够：sandbox 没套上（exit 71）也会让测试「失败」⇒ exit 2，那是假绿。
    //   ⇒ 要求 stderr 里是恶意测试**真跑了**、而读 token 那一步被拒的证据。
    ok(r1.status === 2 && /"readToken":"EPERM"/.test(r1.stderr), 'Stop hook：恶意测试真跑了、读 token 被拒（EPERM）⇒ exit 2', `${r1.status} ${r1.stderr.slice(0, 200)}`);
    ok(!fs.existsSync(path.join(root, 'stolen.txt')), 'Stop hook 跑完，cwd 里没有偷来的 token');
    const r2 = run([]);
    ok(r2.status === 0 && /没拿到 --settings/.test(r2.stderr), '没有 --settings ⇒ 放行、说明（不在 sandbox 外跑）', r2.stderr.slice(0, 120));
  } finally { fx.cleanup(); }
}

// ── 【2c】接到 verify-complete 上：恶意的被提交的测试在 sandbox 里跑 ──────────────
async function verifyCase() {
  console.log('\n【2c】verify-complete：被提交的恶意测试读假 token ⇒ sandbox 里 EPERM，token 不外泄');
  if (!SP.available()) { skipit('【2c】整段'); return; }
  const V = require('../lib/verify-complete');
  const parent = os.tmpdir();
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'engloop-vsb-')));
  const g = (a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  const w = (rel, t) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), t); };
  const token = path.join(repo, 'temp', 'bus-admin.token');
  w('temp/bus-admin.token', 'REAL-SECRET-abc\n');
  // 最小 runner（写机器可读结果）＋ 一个正常测试
  w('test/run.js', require('./verify-fixture').RUNNER);
  w('test/base.test.js', "console.log('  ✓ base'); console.log('通过 1 · 失败 0');\n");
  g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 'a@b.c']); g(['config', 'user.name', 'a']);
  g(['add', '-A']); g(['commit', '-qm', 'base']);
  // 分支上加一个**恶意**测试：读 token 写进 cwd
  g(['checkout', '-q', '-b', 'evil']);
  w('test/steal.test.js', `const fs=require('fs');const p=require('path');
let v;try{v=fs.readFileSync(${JSON.stringify(token)},'utf8');fs.writeFileSync(p.join(__dirname,'..','STOLEN.txt'),v);console.log('  ✗ stole '+v.trim());}catch(e){console.log('  ✗ read-token '+e.code);}
console.log('通过 0 · 失败 1');process.exit(1);`);
  g(['add', '-A']); g(['commit', '-qm', 'evil']);
  const sha = g(['rev-parse', 'HEAD']).stdout.trim();
  const cache = path.join(repo, '.cache');
  const r = await V.verify({ kind: 'code', repo, commit: sha, tests: 'node test/run.js' },
    { cacheRoot: cache, testsTimeoutMs: 60_000, denyRead: [token] });
  ok(r.verdict === 'fail', 'verdict = fail（恶意测试在 sandbox 里读 token 被拒 ⇒ 它那条红）', r.verdict);
  ok(r.missing.some((m) => /steal\.test\.js :: read-token EPERM/.test(m)) && !/REAL-SECRET/.test(JSON.stringify(r)),
    '新增的失败是 steal.test.js 的 read-token EPERM —— token 内容没出现在任何输出里', JSON.stringify(r.missing).slice(0, 300));
  ok(!fs.existsSync(path.join(repo, 'STOLEN.txt')), '工作树里没有 STOLEN.txt（偷不成；而且临时树是一次性的）');
  fs.rmSync(repo, { recursive: true, force: true });
}

// ── 【3】套不上第二层 sandbox 时：放行 / unverifiable，**不能**被读成「测试红了」──────────
//   要防的假绿：在限制性 sandbox 里再 sandbox-exec ⇒ exit 71（sandbox_apply EPERM）。
//   按「文件在不在」判的话，Stop hook 拿这个 exit 71 当测试失败 ⇒ exit 2；核验拿它当「没结果」⇒ fail ——
//   而测试一行都没跑。这里把 hook 和核验**放进**一个限制性 sandbox 里跑，要求它们认出「套不上」。
async function nestedCase() {
  console.log('\n【3】在 sandbox 里面再起 hook / 核验 ⇒ 认出「套不上」，放行 / unverifiable');
  if (!SP.available()) { skipit('【3】（这个进程本身就在 sandbox 里，造不出外层）'); return; }
  const fx = makeEvil();
  try {
    const root = fx.root;
    spawnSync('git', ['-C', root, 'init', '-q']); spawnSync('git', ['-C', root, 'config', 'user.email', 'a@b.c']);
    spawnSync('git', ['-C', root, 'config', 'user.name', 'a']); spawnSync('git', ['-C', root, 'add', '-A']);
    spawnSync('git', ['-C', root, 'commit', '-qm', 'x']);
    const settings = fx.settingsFile();
    fs.appendFileSync(path.join(root, 'test/good.test.js'), '\n// touch\n');   // 有改动 ⇒ 映射命中
    const outer = path.join(root, 'outer.sb');
    fs.writeFileSync(outer, SP.buildProfile({ allowWrite: [root], denyRead: [], allowTmp: true }));
    const HOOK = path.join(__dirname, '..', 'hooks', 'stop_check.js');
    const argv = SP.wrap(outer, [process.execPath, HOOK, '--settings', settings]);
    const r = spawnSync(argv[0], argv.slice(1), { input: JSON.stringify({ cwd: root, stop_hook_active: false }), encoding: 'utf8' });
    ok(r.status === 0 && /在这里套不上/.test(r.stderr),
      'Stop hook 在 sandbox 里 ⇒ 认出套不上第二层，放行（exit 0）并说明 —— 不是 exit 2', `${r.status} ${r.stderr.slice(0, 160)}`);
  } finally { fx.cleanup(); }
}

verifyCase().then(nestedCase).then(() => {
  console.log(`\n通过 ${pass} · 失败 ${fail}${skip ? ` · 跳过 ${skip}` : ''}`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.log(`  ✗ 【2c】崩了：${e.stack}`); console.log(`\n通过 ${pass} · 失败 ${fail + 1}`); process.exit(1); });
