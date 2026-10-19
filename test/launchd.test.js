'use strict';

/**
 * bus 的两种起法（nohup / launchd）—— `bin/launchd.js` ＋ `start.sh` / `stop.sh` 的模式分支。
 * `bin/serve.sh` 在 launchd 那种环境下能不能用，见
 * `test/serve-sh-env.test.js`（那个要起一个隔离 bus，分开放）。
 *
 * ── ⛔ 这个文件**绝不**碰真 launchd ──────────────────────────────────────
 *   · `install` / `uninstall` / `start` 只在本进程里调，`run` 一律注入（假 launchctl，只记账）。
 *   · HOME 一律是临时目录 ⇒ 不写真 `~/Library/LaunchAgents`。
 *   · 子进程里只跑只读的子命令（print / label / mode）。
 *   · stop.sh 在一个**只有桩**的 PATH 里跑：launchctl / pgrep / pkill / tmux / lsof / curl 全是桩，
 *     真的那几个**在那个 PATH 里根本找不到**（跑之前先验这一点，验不过就不跑）。
 *     ⇒ 它杀不到真 bus、真会话，也 bootout 不了真服务。
 *   · start.sh 在一份**假 checkout** 里跑：它调的 bin/launchd.js、bin/serve.sh、bin/orch-start.js 全是桩；
 *     它自己会 prepend /opt/homebrew/bin，所以 tmux 是真的 ⇒ 私有 socket（TMUX_TMPDIR ＋ 删 TMUX）。
 *     端口是测试端口，不碰 9969。
 *
 * 变异：`node scripts/mutate-launchd.js`。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LAUNCHD = path.join(ROOT, 'bin', 'launchd.js');
const lj = require('../bin/launchd');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-e16-'));
const cleanups = [];
process.on('exit', () => {
  for (const f of cleanups.reverse()) { try { f(); } catch (_) { /* 尽力 */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
});
let homeSeq = 0;
const newHome = () => {
  const h = path.join(TMP, `home${++homeSeq}`);
  fs.mkdirSync(h, { recursive: true });
  return h;
};

// ── 一个只认 bin/launchd.js 生成的那种 plist 的小解析器（dict / array / key / string / integer / true / false）──
//   严格：遇到不认识的东西就抛。Linux 上没有 plutil 时，结构校验靠它。
function parsePlist(xml) {
  const body = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const toks = body.match(/<[^>]+>|[^<]+/g).filter((t) => t.trim() !== '');
  let i = 0;
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const expect = (t) => { if (toks[i] !== t) throw new Error(`期望 ${t}，实际 ${toks[i]}（第 ${i} 个）`); i++; };
  const textUntil = (close) => {
    let s = '';
    if (toks[i] !== close) { if (toks[i].startsWith('<')) throw new Error(`期望文本，实际 ${toks[i]}`); s = toks[i++]; }
    expect(close);
    return unesc(s);
  };
  function value() {
    const t = toks[i++];
    if (t === '<true/>') return true;
    if (t === '<false/>') return false;
    if (t === '<string>') return textUntil('</string>');
    if (t === '<integer>') { const v = textUntil('</integer>'); if (!/^-?\d+$/.test(v)) throw new Error(`integer 不是整数：${v}`); return Number(v); }
    if (t === '<array>') { const a = []; while (toks[i] !== '</array>') a.push(value()); i++; return a; }
    if (t === '<dict>') {
      const o = {};
      while (toks[i] !== '</dict>') {
        expect('<key>');
        const k = textUntil('</key>');
        if (Object.prototype.hasOwnProperty.call(o, k)) throw new Error(`重复的 key：${k}`);
        o[k] = value();
      }
      i++;
      return o;
    }
    throw new Error(`不认识的 token：${t}`);
  }
  expect('<plist version="1.0">');
  const v = value();
  expect('</plist>');
  if (i !== toks.length) throw new Error(`</plist> 后面还有东西：${toks.slice(i).join('')}`);
  return v;
}

/** 假 launchctl：按「哪些 label 在册」回答 print，记下每一次调用。 */
function fakeLaunchctl({ loadedLabels = [], pid = 4242, fail: failOn = {}, unavailable = false } = {}) {
  const calls = [];
  const loadedSet = new Set(loadedLabels);
  const run = (args) => {
    calls.push(args.slice());
    if (unavailable) throw Object.assign(new Error('spawnSync launchctl ENOENT'), { code: 'ENOENT' });
    if (failOn[args[0]]) throw Object.assign(new Error(`fake ${args[0]} failed`), { stderr: `Bootstrap failed: 5: Input/output error` });
    if (args[0] === 'print') {
      const label = args[1].split('/').pop();
      if (loadedSet.has(label)) return `${args[1]} = {\n\tstate = running\n\tpid = ${pid}\n}\n`;
      throw Object.assign(new Error('Command failed'), { stderr: `Could not find service "${label}" in domain for user gui: 501` });
    }
    if (args[0] === 'bootstrap') { loadedSet.add(path.basename(args[2], '.plist')); return ''; }
    if (args[0] === 'bootout') { loadedSet.delete(args[1].split('/').pop()); return ''; }
    if (args[0] === 'kickstart') return '';
    throw new Error(`fake launchctl: 没配 ${args.join(' ')}`);
  };
  return { run, calls };
}
const verbs = (calls) => calls.map((c) => c[0]);

function main() {
  console.log('\nbus 的 nohup / launchd 两种起法\n');
  const UID = process.getuid();

  // ──────────────────────────────────────────────────────────────────────
  console.log('【1】print：plist 由代码生成，路径 = 当前 checkout 根 ＋ HOME');
  {
    const home = newHome();
    const xml = lj.renderPlist({ home, root: ROOT });
    let p = null;
    try { p = parsePlist(xml); } catch (e) { ok(false, 'XML 解析得动', e.message); }
    ok(p !== null, '生成的 plist 过 XML 解析（严格子集解析器）');
    if (p) {
      ok(p.Label === lj.LABEL, `Label = 共用的那一处（${lj.LABEL}）`, p.Label);
      ok(JSON.stringify(p.ProgramArguments) === JSON.stringify(['/bin/bash', path.join(ROOT, 'bin', 'serve.sh')]),
        'ProgramArguments = /bin/bash <当前根>/bin/serve.sh —— 走 serve.sh，不直接调 node', JSON.stringify(p.ProgramArguments));
      ok(p.WorkingDirectory === ROOT, 'WorkingDirectory = 当前根', p.WorkingDirectory);
      ok(p.StandardOutPath === path.join(home, 'Library', 'Logs', 'engloop.out')
        && p.StandardErrorPath === path.join(home, 'Library', 'Logs', 'engloop.err'),
      '日志路径在（临时）HOME 下', `${p.StandardOutPath} ${p.StandardErrorPath}`);
      ok(p.KeepAlive === true && p.RunAtLoad === true && p.ThrottleInterval === 10,
        'KeepAlive / RunAtLoad / ThrottleInterval=10 跟原来那份手写的一样', JSON.stringify(p));
      ok(!('EnvironmentVariables' in p), '没有 EnvironmentVariables —— 环境只在 serve.sh 里写一份');
    }

    // 子进程跑 CLI：HOME 换成临时目录，输出里只该出现它和当前根
    const r = spawnSync(process.execPath, [LAUNCHD, 'print'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    ok(r.status === 0 && r.stdout === lj.renderPlist({ home, root: ROOT }),
      '`HOME=<临时> node bin/launchd.js print` = renderPlist({ home: 临时, root: 当前根 })', r.stderr);
    const realHome = os.userInfo().homedir;
    ok(!r.stdout.includes(realHome), `HOME 换了以后输出里没有真 HOME（${realHome}）—— 没写死`, '');

    // 路径里有 XML 特殊字符也不坏
    const weird = path.join(TMP, 'a&b <c> "d"');
    let pw = null;
    try { pw = parsePlist(lj.renderPlist({ home: weird, root: weird })); } catch (e) { ok(false, '特殊字符路径解析', e.message); }
    ok(pw && pw.WorkingDirectory === weird, '路径带 & < > " 时转义正确，解析回来一模一样', pw && pw.WorkingDirectory);

    // 源码里没有写死的路径
    const src = fs.readFileSync(LAUNCHD, 'utf8');
    ok(!/\/Users\/|\/Volumes\//.test(src), 'bin/launchd.js 源码里没有写死家目录（\\/Users\\/）或外置盘（\\/Volumes\\/）的绝对路径');

    // macOS 上再过一遍 plutil（只读：lint 一个临时文件）
    if (fs.existsSync('/usr/bin/plutil')) {
      const f = path.join(TMP, 'lint.plist');
      fs.writeFileSync(f, xml);
      const lint = spawnSync('/usr/bin/plutil', ['-lint', f], { encoding: 'utf8' });
      ok(lint.status === 0 && /OK/.test(lint.stdout), '`plutil -lint` 通过', `${lint.stdout}${lint.stderr}`);
      const conv = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', f], { encoding: 'utf8' });
      let pj = null;
      try { pj = JSON.parse(conv.stdout); } catch (_) { /* 下面判 */ }
      ok(pj && JSON.stringify(pj, Object.keys(pj).sort()) === JSON.stringify(p, Object.keys(p).sort()),
        'plutil 读出来的跟子集解析器读出来的一样（解析器本身的对照）', conv.stdout.slice(0, 200));
    } else {
      console.log('  — 没有 /usr/bin/plutil（不是 macOS）：plutil -lint 那条在 Mac 上验，见 PR「只能在 Mac 上验」');
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  console.log('\n【2】label 只有一处：bus-restart.js、stop.sh 都从 bin/launchd.js 取');
  {
    // ★ 不是比两个字符串相等 —— 把 launchd.js 导出的 LABEL 换掉，看 bus-restart.js 跟不跟着变。
    //   它自己写一份字面量的话，这里拿到的还是原来那个值。
    const SENT = `test.e16.sentinel.${process.pid}`;
    const r = spawnSync(process.execPath, ['-e', `
      const l = require(${JSON.stringify(LAUNCHD)});
      l.LABEL = ${JSON.stringify(SENT)};
      const br = require(${JSON.stringify(path.join(ROOT, 'bin', 'bus-restart.js'))});
      console.log(JSON.stringify({ label: br.LAUNCHD_LABEL, target: br.LAUNCHD_TARGET() }));
    `], { encoding: 'utf8', env: { ...process.env, ENGLOOP_LAUNCHD_LABEL: '' } });
    let j = null;
    try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_) { /* 下面判 */ }
    ok(j && j.label === SENT && j.target.endsWith(`/${SENT}`),
      '★ 换掉 launchd.js 的 LABEL ⇒ bus-restart.js 的 LAUNCHD_LABEL / LAUNCHD_TARGET 跟着变（引用同一处）',
      `${r.stdout}${r.stderr}`.slice(0, 300));

    // 字面量在**代码**里只出现一次（注释里提到的不算）
    const files = ['start.sh', 'stop.sh',
      ...fs.readdirSync(path.join(ROOT, 'bin')).filter((f) => /\.(js|sh)$/.test(f)).map((f) => `bin/${f}`),
      ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`)];
    const hits = [];
    for (const f of files) {
      const commentRe = f.endsWith('.sh') ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/;
      const t = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => !commentRe.test(l)).join('\n');
      const n = t.split('com.patrick.engloop').length - 1;
      if (n) hits.push(`${f}×${n}`);
    }
    ok(hits.length === 1 && hits[0] === 'bin/launchd.js×1',
      '`com.patrick.engloop` 在 bin/ lib/ start.sh stop.sh 的代码里只出现一次，在 bin/launchd.js（preflight.sh 也改成问它了）', hits.join(' '));

    const stopSrc = fs.readFileSync(path.join(ROOT, 'stop.sh'), 'utf8');
    ok(/LABEL=\$\(node bin\/launchd\.js label[^)]*\)/.test(stopSrc), 'stop.sh 用 `node bin/launchd.js label` 取 label');

    const lab = spawnSync(process.execPath, [LAUNCHD, 'label'], { encoding: 'utf8', env: { ...process.env, ENGLOOP_LAUNCHD_LABEL: '' } });
    ok(lab.status === 0 && lab.stdout.trim() === lj.LABEL, '`node bin/launchd.js label` 打印 LABEL', lab.stdout);
    const lab2 = spawnSync(process.execPath, [LAUNCHD, 'label'], { encoding: 'utf8', env: { ...process.env, ENGLOOP_LAUNCHD_LABEL: SENT } });
    ok(lab2.stdout.trim() === SENT, 'ENGLOOP_LAUNCHD_LABEL 覆盖照旧（原来 bus-restart.js 就有这个口子）', lab2.stdout);
  }

  // ──────────────────────────────────────────────────────────────────────
  console.log('\n【3】mode：plist 文件在 ⇒ launchd，跟在不在册无关');
  {
    const home = newHome();
    const L = lj.LABEL;
    const notLoaded = fakeLaunchctl({ loadedLabels: [] });
    ok(lj.mode({ home, run: notLoaded.run }) === 'nohup', '文件不在 ⇒ nohup');

    fs.mkdirSync(path.dirname(lj.plistPath({ home })), { recursive: true });
    fs.writeFileSync(lj.plistPath({ home }), lj.renderPlist({ home }));
    ok(lj.mode({ home, run: notLoaded.run }) === 'launchd',
      '★ 文件在、不在册（stop.sh bootout 之后的样子）⇒ launchd —— 下次 start.sh 要重新 bootstrap，不是退回 nohup');

    const home2 = newHome();
    const loadedLc = fakeLaunchctl({ loadedLabels: [L] });
    ok(lj.mode({ home: home2, run: loadedLc.run }) === 'nohup', '文件不在、在册 ⇒ 仍是 nohup（判据只有文件）');

    // CLI：HOME 换成临时目录。label 也换成一个不存在的 —— 万一实现（或变异 D1）去问在不在册，
    //   问到的也只是一个不存在的服务（print 是只读的，但连只读的也不去问真 label）。
    const SENT = `test.e16.mode.${process.pid}`;
    fs.writeFileSync(lj.plistPath({ home, label: SENT }), 'x');
    const cliEnv = (h) => ({ ...process.env, HOME: h, ENGLOOP_LAUNCHD_LABEL: SENT });
    const m1 = spawnSync(process.execPath, [LAUNCHD, 'mode'], { encoding: 'utf8', env: cliEnv(home) });
    const m2 = spawnSync(process.execPath, [LAUNCHD, 'mode'], { encoding: 'utf8', env: cliEnv(home2) });
    ok(m1.stdout.trim() === 'launchd' && m2.stdout.trim() === 'nohup',
      '`node bin/launchd.js mode` 按 $HOME 下的文件答', `${m1.stdout.trim()} / ${m2.stdout.trim()}`);
  }

  // ──────────────────────────────────────────────────────────────────────
  console.log('\n【4】install：写文件 ＋ bootstrap；bus 在跑就拒绝');
  {
    const L = lj.LABEL;
    // 正常装
    {
      const home = newHome();
      const lc = fakeLaunchctl();
      const r = lj.install({ home, root: ROOT, run: lc.run, uid: UID, findBusPids: () => [] });
      const file = path.join(home, 'Library', 'LaunchAgents', `${L}.plist`);
      ok(r.ok === true && r.plist === file, 'bus 没在跑 ⇒ install 成功，文件在 <HOME>/Library/LaunchAgents/<label>.plist', JSON.stringify(r));
      ok(fs.existsSync(file) && fs.readFileSync(file, 'utf8') === lj.renderPlist({ home, root: ROOT }),
        '写进去的就是 print 生成的那份');
      ok(JSON.stringify(lc.calls) === JSON.stringify([['print', `gui/${UID}/${L}`], ['bootstrap', `gui/${UID}`, file]]),
        'launchctl 调用 = print（查在不在册）→ bootstrap gui/<uid> <plist>', JSON.stringify(lc.calls));
    }
    // ★ bus 在跑 ⇒ 拒绝
    {
      const home = newHome();
      const lc = fakeLaunchctl();
      const r = lj.install({ home, root: ROOT, run: lc.run, uid: UID, findBusPids: () => [31337] });
      ok(r.ok === false && r.reason === 'bus_running' && /\.\/stop\.sh/.test(r.message),
        '★★ bus 在跑（不是 launchd 起的）⇒ install 拒绝，提示先 ./stop.sh', JSON.stringify(r));
      ok(!verbs(lc.calls).includes('bootstrap'), '★★ 拒绝时没有 bootstrap', JSON.stringify(lc.calls));
      ok(!fs.existsSync(lj.plistPath({ home })), '★★ 拒绝时没写 plist（否则 mode 会变成 launchd）');
    }
    // 默认的「找 bus」就是 bus-restart.js 那份按进程枚举的（不是看端口）
    {
      const home = newHome();
      const lc = fakeLaunchctl();
      const br = require('../bin/bus-restart');
      const orig = br.findBusPids;
      br.findBusPids = () => [27182];
      let r;
      try { r = lj.install({ home, root: ROOT, run: lc.run, uid: UID }); } finally { br.findBusPids = orig; }
      ok(r.ok === false && r.reason === 'bus_running' && /27182/.test(r.message),
        '不注入时用的是 bus-restart.js 的 findBusPids（按进程枚举，跟 stop.sh 同一个判据）', JSON.stringify(r));
    }
    // 查不到进程列表 ⇒ 拒绝（查不了 ≠ 没有）
    {
      const home = newHome();
      const lc = fakeLaunchctl();
      const r = lj.install({ home, root: ROOT, run: lc.run, uid: UID,
        findBusPids: () => { throw Object.assign(new Error('ps 挂了'), { code: 'PS_FAILED' }); } });
      ok(r.ok === false && r.reason === 'ps_failed' && !fs.existsSync(lj.plistPath({ home })),
        '查不到进程列表 ⇒ 拒绝、不写文件', JSON.stringify(r));
    }
    // 已在册 ⇒ 拒绝
    {
      const home = newHome();
      const lc = fakeLaunchctl({ loadedLabels: [L] });
      const r = lj.install({ home, root: ROOT, run: lc.run, uid: UID, findBusPids: () => [] });
      ok(r.ok === false && r.reason === 'already_loaded' && !verbs(lc.calls).includes('bootstrap'),
        '已在册 ⇒ 拒绝（不重复 bootstrap）', JSON.stringify(r));
    }
    // launchctl 跑不了 ⇒ 拒绝
    {
      const home = newHome();
      const lc = fakeLaunchctl({ unavailable: true });
      const r = lj.install({ home, root: ROOT, run: lc.run, uid: UID, findBusPids: () => [] });
      ok(r.ok === false && r.reason === 'launchctl_unavailable' && !fs.existsSync(lj.plistPath({ home })),
        'launchctl 跑不了 ⇒ 拒绝、不写文件（查不了 ≠ 不在册）', JSON.stringify(r));
    }
    // bootstrap 失败 ⇒ 状态还原
    {
      const home = newHome();
      const lc = fakeLaunchctl({ fail: { bootstrap: true } });
      const r = lj.install({ home, root: ROOT, run: lc.run, uid: UID, findBusPids: () => [] });
      ok(r.ok === false && r.reason === 'bootstrap_failed' && !fs.existsSync(lj.plistPath({ home })),
        'bootstrap 失败、原来没文件 ⇒ 文件删掉（mode 不会变成 launchd）', JSON.stringify(r));

      const home2 = newHome();
      const file2 = lj.plistPath({ home: home2 });
      fs.mkdirSync(path.dirname(file2), { recursive: true });
      fs.writeFileSync(file2, 'OLD');
      const lc2 = fakeLaunchctl({ fail: { bootstrap: true } });
      const r2 = lj.install({ home: home2, root: ROOT, run: lc2.run, uid: UID, findBusPids: () => [] });
      ok(r2.ok === false && fs.readFileSync(file2, 'utf8') === 'OLD',
        'bootstrap 失败、原来有文件 ⇒ 还原成原来那份', JSON.stringify(r2));
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  console.log('\n【5】uninstall / status / start');
  {
    const L = lj.LABEL;
    // 在册 ⇒ bootout ＋ 删文件
    {
      const home = newHome();
      const file = lj.plistPath({ home });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lj.renderPlist({ home }));
      const lc = fakeLaunchctl({ loadedLabels: [L] });
      const r = lj.uninstall({ home, run: lc.run, uid: UID });
      ok(r.ok && r.bootedOut && r.removed && !fs.existsSync(file), '在册 ⇒ bootout 后删文件', JSON.stringify(r));
      ok(JSON.stringify(lc.calls) === JSON.stringify([['print', `gui/${UID}/${L}`], ['bootout', `gui/${UID}/${L}`]]),
        'launchctl 调用 = print → bootout gui/<uid>/<label>', JSON.stringify(lc.calls));
    }
    // 不在册 ⇒ 只删文件
    {
      const home = newHome();
      const file = lj.plistPath({ home });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x');
      const lc = fakeLaunchctl();
      const r = lj.uninstall({ home, run: lc.run, uid: UID });
      ok(r.ok && !r.bootedOut && r.removed && !fs.existsSync(file) && !verbs(lc.calls).includes('bootout'),
        '不在册 ⇒ 不 bootout，只删文件', JSON.stringify(lc.calls));
    }
    // bootout 失败 ⇒ 文件留着
    {
      const home = newHome();
      const file = lj.plistPath({ home });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x');
      const lc = fakeLaunchctl({ loadedLabels: [L], fail: { bootout: true } });
      const r = lj.uninstall({ home, run: lc.run, uid: UID });
      ok(!r.ok && r.reason === 'bootout_failed' && fs.existsSync(file),
        'bootout 失败 ⇒ 不删文件（删了 mode 变 nohup，下次 start.sh 会再起一个）', JSON.stringify(r));
    }
    // status
    {
      const home = newHome();
      const lc0 = fakeLaunchctl();
      const s0 = lj.status({ home, run: lc0.run, uid: UID });
      ok(s0.installed === false && s0.mode === 'nohup' && s0.loaded === false && s0.label === L,
        'status：没装 ⇒ installed:false · mode:nohup · loaded:false', JSON.stringify(s0));
      const file = lj.plistPath({ home });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lj.renderPlist({ home }));
      const lc1 = fakeLaunchctl({ loadedLabels: [L], pid: 777 });
      const s1 = lj.status({ home, run: lc1.run, uid: UID });
      ok(s1.installed && s1.matches === true && s1.loaded === true && s1.pid === 777 && s1.mode === 'launchd',
        'status：装了、在册 ⇒ pid 从 launchctl print 里读出来', JSON.stringify(s1));
      fs.writeFileSync(file, lj.renderPlist({ home, root: '/somewhere/else' }));
      const s2 = lj.status({ home, run: fakeLaunchctl().run, uid: UID });
      ok(s2.matches === false && s2.loaded === false, 'status：文件跟现在生成的不一样 ⇒ matches:false', JSON.stringify(s2));
      const s3 = lj.status({ home, run: fakeLaunchctl({ unavailable: true }).run, uid: UID });
      ok(s3.error === 'launchctl_unavailable' && s3.loaded === undefined,
        'status：launchctl 跑不了 ⇒ error，**没有** loaded:false', JSON.stringify(s3));
    }
    // start
    {
      const home = newHome();
      const lc0 = fakeLaunchctl();
      const r0 = lj.start({ home, run: lc0.run, uid: UID });
      ok(!r0.ok && r0.reason === 'not_installed' && lc0.calls.length === 0, 'start：没装 ⇒ 拒绝，不调 launchctl', JSON.stringify(r0));
      const file = lj.plistPath({ home });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lj.renderPlist({ home }));
      const lc1 = fakeLaunchctl();
      const r1 = lj.start({ home, run: lc1.run, uid: UID });
      ok(r1.ok && r1.action === 'bootstrap'
        && JSON.stringify(lc1.calls[1]) === JSON.stringify(['bootstrap', `gui/${UID}`, file]),
      'start：装了、不在册（stop.sh 之后）⇒ bootstrap', JSON.stringify(lc1.calls));
      const lc2 = fakeLaunchctl({ loadedLabels: [L] });
      const r2 = lj.start({ home, run: lc2.run, uid: UID });
      ok(r2.ok && r2.action === 'kickstart' && JSON.stringify(lc2.calls[1]) === JSON.stringify(['kickstart', `gui/${UID}/${L}`]),
        'start：在册 ⇒ kickstart（不带 -k：在跑的不动）', JSON.stringify(lc2.calls));
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  console.log('\n【6】脚本：语法 ＋ 一个入口');
  {
    for (const f of ['start.sh', 'stop.sh', 'bin/serve.sh', 'bin/preflight.sh']) {
      const r = spawnSync('/bin/bash', ['-n', path.join(ROOT, f)], { encoding: 'utf8' });
      ok(r.status === 0, `bash -n ${f}`, r.stderr);
    }
    const start = fs.readFileSync(path.join(ROOT, 'start.sh'), 'utf8');
    const code = start.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    ok(!/node\s+bin\/serve\.js/.test(code), 'start.sh 不再直接 `node bin/serve.js`');
    ok(/nohup\s+bash\s+bin\/serve\.sh/.test(code), 'start.sh 的 nohup 分支走 `bash bin/serve.sh`');
    ok(!/ENGLOOP_WORKER_TYPES=/.test(code), 'start.sh 不再 export ENGLOOP_WORKER_TYPES（只在 serve.sh 里）');
    ok(!/launchctl\s+(bootstrap|bootout|kickstart|print|list|load|unload)/.test(code),'start.sh 不直接调 launchctl（走 bin/launchd.js，那里有注入点）');
    const serve = fs.readFileSync(path.join(ROOT, 'bin', 'serve.sh'), 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    ok(/^export PATH=/m.test(serve), 'serve.sh export PATH');
    ok(!fs.existsSync(path.join(ROOT, 'deploy', 'com.patrick.engloop.plist')), 'deploy/com.patrick.engloop.plist 删掉了');
  }

  stopShHarness();
  stopGracefulHarness();
  startShHarness();

  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

// ── 把一个脚本放进假 checkout。`ENGLOOP_SHMUT`（变异驱动用）在这里生效：{file, from, to} ──
function stageScript(rel, destRoot) {
  let text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const raw = process.env.ENGLOOP_SHMUT ? JSON.parse(process.env.ENGLOOP_SHMUT) : null;
  for (const m of (Array.isArray(raw) ? raw : (raw ? [raw] : []))) {
    if (m.file !== rel) continue;
    if (!text.includes(m.from)) throw new Error(`[shmut] ${rel} 里找不到要变异的原文：${JSON.stringify(m.from).slice(0, 120)}`);
    text = text.split(m.from).join(m.to);
  }
  const dest = path.join(destRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text, { mode: 0o755 });
  return dest;
}
const writeExe = (p, body) => { fs.writeFileSync(p, body, { mode: 0o755 }); return p; };

// ──────────────────────────────────────────────────────────────────────
// stop.sh：只有桩的 PATH
// ──────────────────────────────────────────────────────────────────────
function stopShHarness() {
  console.log('\n【7】stop.sh 的 launchd 那一段（只有桩的 PATH，碰不到真 launchctl / pgrep / tmux）');
  const R = path.join(TMP, 'stop-root');
  const S = path.join(TMP, 'stop-stubs');
  fs.mkdirSync(path.join(R, 'bin'), { recursive: true });
  fs.mkdirSync(S, { recursive: true });
  stageScript('stop.sh', R);
  fs.symlinkSync(LAUNCHD, path.join(R, 'bin', 'launchd.js'));   // 真的 launchd.js（只跑 label / mode）

  const LOG = path.join(TMP, 'stop-launchctl.log');
  const STATE = path.join(TMP, 'stop-booted');
  fs.symlinkSync(process.execPath, path.join(S, 'node'));
  for (const t of ['id', 'tr', 'wc', 'seq', 'grep', 'head', 'dirname', 'cat']) {
    const real = ['/usr/bin', '/bin'].map((d) => path.join(d, t)).find((p) => fs.existsSync(p));
    if (real) fs.symlinkSync(real, path.join(S, t));
  }
  writeExe(path.join(S, 'sleep'), '#!/bin/bash\nexit 0\n');
  // 假 launchctl：FAKE_LOADED_LABEL 在册（直到被 bootout）；每次调用记一行
  writeExe(path.join(S, 'launchctl'), `#!/bin/bash
echo "$*" >> "$STUB_LOG"
lab="\${2##*/}"
case "$1" in
  print)  if [ "$lab" = "$FAKE_LOADED_LABEL" ] && [ ! -e "$STUB_STATE" ]; then echo "pid = 4242"; exit 0; fi
          echo "Could not find service \\"$lab\\" in domain" >&2; exit 113 ;;
  list)   if [ ! -e "$STUB_STATE" ]; then echo "4242	0	$FAKE_LOADED_LABEL"; fi; exit 0 ;;
  bootout) if [ "$lab" = "$FAKE_LOADED_LABEL" ]; then : > "$STUB_STATE"; exit 0; fi
          echo "Boot-out failed: 3: No such process" >&2; exit 3 ;;
  *) exit 64 ;;
esac
`);
  // 假 pgrep：只认测试自己起的那个替身进程（FAKE_BUS_PID）—— 它还活着就报它，死了就报没有。
  //   stop.sh 里的 `kill` 是 bash 内建、桩不掉，所以替身必须是一个**测试自己起的、可以被杀的**进程。
  writeExe(path.join(S, 'pgrep'), `#!/bin/bash
echo "pgrep $*" >> "$STUB_LOG"
if [ -n "\${FAKE_BUS_PID:-}" ] && kill -0 "$FAKE_BUS_PID" 2>/dev/null; then echo "$FAKE_BUS_PID"; exit 0; fi
exit 1
`);
  writeExe(path.join(S, 'pkill'), '#!/bin/bash\necho "pkill $*" >> "$STUB_LOG"\nexit 1\n');
  for (const t of ['lsof', 'curl']) writeExe(path.join(S, t), '#!/bin/bash\nexit 1\n');
  writeExe(path.join(S, 'tmux'), '#!/bin/bash\nexit 1\n');

  // ⛔ 先证明危险的那几个在这个 PATH 里只能找到桩，证明不了就不跑
  const probe = spawnSync('/bin/bash', ['-c', 'for c in launchctl pgrep pkill tmux lsof curl; do command -v "$c"; done'],
    { encoding: 'utf8', env: { PATH: S } });
  const found = probe.stdout.trim().split('\n');
  const safe = found.length === 6 && found.every((p) => p.startsWith(`${S}/`));
  ok(safe, '（前置）这个 PATH 里 launchctl / pgrep / pkill / tmux / lsof / curl 都只解析到桩', probe.stdout);
  if (!safe) { console.log('  ⛔ 前置没过，stop.sh 不跑'); return; }

  const SENT = `test.e16.stop.${process.pid}`;
  const run = (home, loadedLabel, { root = R, fakeBusPid = '' } = {}) => {
    fs.rmSync(LOG, { force: true }); fs.rmSync(STATE, { force: true });
    fs.writeFileSync(LOG, '');
    const r = spawnSync('/bin/bash', [path.join(root, 'stop.sh'), '--now'], {
      encoding: 'utf8', timeout: 30000,
      env: { PATH: S, HOME: home, ENGLOOP_LAUNCHD_LABEL: SENT, FAKE_LOADED_LABEL: loadedLabel,
        STUB_LOG: LOG, STUB_STATE: STATE, ENGLOOP_PORT: '19993', FAKE_BUS_PID: String(fakeBusPid) },
    });
    return { ...r, calls: fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) };
  };

  const home = newHome();
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const plist = path.join(home, 'Library', 'LaunchAgents', `${SENT}.plist`);
  fs.writeFileSync(plist, '<plist/>');

  const a = run(home, SENT);
  const uid = process.getuid();
  ok(a.calls.includes(`bootout gui/${uid}/${SENT}`),
    '★ 在册 ⇒ stop.sh bootout 的是 `node bin/launchd.js label` 给的 label', `calls=${JSON.stringify(a.calls)}\n${a.stdout.slice(-600)}${a.stderr}`);
  ok(/下次 \.\/start\.sh 会重新 bootstrap/.test(a.stdout), '提示：launchd 模式，下次 ./start.sh 会重新 bootstrap', a.stdout.slice(-400));
  ok(fs.existsSync(plist), 'stop.sh 不删 plist（删了下次 start.sh 就退回 nohup）');
  ok(a.status === 0, 'stop.sh 退出 0', `${a.status} ${a.stderr}`);

  const b = run(home, 'something.else');
  ok(!b.calls.some((c) => c.startsWith('bootout')), '不在册 ⇒ 不 bootout', JSON.stringify(b.calls));

  // ── 取不到 label ⇒ 大声说、照样停 bus、退出码非 0 ─────────────
  //   另一份假 checkout：bin/launchd.js 是一个直接 exit 1 的桩（node 在、launchd.js 坏了）。
  //   替身 bus：一个**孤儿** sleep（经 sh 起、sh 立刻退出 ⇒ 不是本进程的子进程，死了会被 launchd 收走，
  //   不会以僵尸的样子让 kill -0 继续成功）。pgrep 桩只报它。
  console.log('\n【7b】stop.sh 取不到 label（launchd.js 坏了）⇒ 照样停 bus');
  const R2 = path.join(TMP, 'stop-root-badlabel');
  fs.mkdirSync(path.join(R2, 'bin'), { recursive: true });
  stageScript('stop.sh', R2);
  writeExe(path.join(R2, 'bin', 'launchd.js'), "process.stderr.write('launchd.js 坏了（桩）\\n'); process.exit(1);\n");
  const sp = spawnSync('/bin/sh', ['-c', '/bin/sleep 300 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
  const fakePid = Number(sp.stdout.trim());
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  cleanups.push(() => { try { process.kill(fakePid, 'SIGKILL'); } catch (_) { /* 已经没了 */ } });
  ok(fakePid > 0 && alive(fakePid), '（前置）替身 bus 进程起来了', sp.stdout + sp.stderr);

  const c = run(home, SENT, { root: R2, fakeBusPid: fakePid });
  for (let i = 0; i < 30 && alive(fakePid); i++) spawnSync('/bin/sleep', ['0.1']);
  ok(c.calls.some((x) => x.startsWith('pgrep')) && !alive(fakePid),
    '★ 取不到 label ⇒ bus 那一步照样执行了（pgrep 找到替身、kill 把它杀了）',
    `alive=${alive(fakePid)} calls=${JSON.stringify(c.calls)}\n${c.stdout.slice(-700)}${c.stderr}`);
  ok(/取不到 label/.test(c.stdout) && /KeepAlive 拉回来/.test(c.stdout)
    && new RegExp(`launchctl bootout gui/${uid}/<label>`).test(c.stdout) && /bin\/launchd\.js/.test(c.stdout),
  '输出里有提示：装了 launchd 会被 KeepAlive 拉回来，手动 launchctl bootout gui/<uid>/<label>，label 见 bin/launchd.js',
  c.stdout.slice(-700));
  ok(c.status !== 0 && c.status !== null, '退出码非 0（有一步没做成）', `status=${c.status}`);
  ok(!c.calls.some((x) => /^(print|bootout|list)/.test(x)), '取不到 label ⇒ 没有拿一个空 label 去问 / 去 bootout launchctl', JSON.stringify(c.calls));
}

// ── 起一个**孤儿**后台进程（经 sh 起、sh 立刻退出 ⇒ 不是本进程的子进程，spawnSync 期间也照常响应）──
//   返回它的 pid；cleanup 时 SIGKILL。用来当「假 bus」「别的地址上的监听者」。
function orphan(cmd) {
  const sp = spawnSync('/bin/sh', ['-c', `${cmd} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' });
  const pid = Number(sp.stdout.trim());
  if (pid > 0) cleanups.push(() => { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* 已经没了 */ } });
  return pid;
}
// 等某个地址上的端口开始监听（最多 5 秒）
function waitListen(host, port) {
  for (let i = 0; i < 50; i++) {
    const r = spawnSync('lsof', ['-nP', `-iTCP@${host}:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (r.stdout.trim()) return true;
    spawnSync('/bin/sleep', ['0.1']);
  }
  return false;
}
const portBusy = (port) => spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim();

// ──────────────────────────────────────────────────────────────────────
// stop.sh 默认（优雅）模式：关停请求带 admin token（OPS1）
//   · tmux 是桩（会话表是一个文件）；curl / lsof 是**包一层真家伙**的桩：先把 argv 记一笔，再 exec 真的
//     ⇒ 既能核对「token 不在 argv 里」，又是真 curl 真发了 HTTP（`-H @-` 真的被 curl 接受了）。
//   · 假 bus：独立的 node 进程，只在 127.0.0.1 的测试端口上听；它核对 Bearer，
//     接受 ⇒ 从会话表里删掉那个会话（= agent 自己收好尾走了）。
//   · 不碰 9969、不碰真 tmux / launchctl / pgrep（同【7】那条前置）。
// ──────────────────────────────────────────────────────────────────────
function stopGracefulHarness() {
  console.log('\n【7c】stop.sh 优雅关停：带 admin token · 没送到的不等');
  const PORT = 19995;   // 生产 9969 · launchd.test 的 start.sh 用 19993
  const PORT2 = 19996;  // 只在 ::1 上有人听的那个端口（判据只看 127.0.0.1）
  const R = path.join(TMP, 'stopg-root');
  const S = path.join(TMP, 'stopg-stubs');
  fs.mkdirSync(path.join(R, 'bin'), { recursive: true });
  fs.mkdirSync(S, { recursive: true });
  stageScript('stop.sh', R);
  fs.symlinkSync(LAUNCHD, path.join(R, 'bin', 'launchd.js'));

  const LOG = path.join(TMP, 'stopg-calls.log');
  const SESS = path.join(TMP, 'stopg-sessions');
  const BUSLOG = path.join(TMP, 'stopg-bus.log');
  const TOKEN = 'ab'.repeat(32);   // 测试 token（64 hex），不是任何 bus 的
  const TOKEN_FILE = path.join(TMP, 'stopg-admin.token');
  fs.writeFileSync(TOKEN_FILE, `${TOKEN}\n`, { mode: 0o600 });

  fs.symlinkSync(process.execPath, path.join(S, 'node'));
  for (const t of ['id', 'tr', 'wc', 'seq', 'grep', 'head', 'dirname', 'cat']) {
    const real = ['/usr/bin', '/bin'].map((d) => path.join(d, t)).find((p) => fs.existsSync(p));
    if (real) fs.symlinkSync(real, path.join(S, t));
  }
  writeExe(path.join(S, 'sleep'), '#!/bin/bash\necho "sleep $*" >> "$STUB_LOG"\nexit 0\n');
  writeExe(path.join(S, 'launchctl'), '#!/bin/bash\necho "launchctl $*" >> "$STUB_LOG"\nexit 113\n');
  writeExe(path.join(S, 'pgrep'), `#!/bin/bash
if [ -n "\${FAKE_BUS_PID:-}" ] && kill -0 "$FAKE_BUS_PID" 2>/dev/null; then echo "$FAKE_BUS_PID"; exit 0; fi
exit 1
`);
  writeExe(path.join(S, 'pkill'), '#!/bin/bash\nexit 1\n');
  writeExe(path.join(S, 'curl'), '#!/bin/bash\nprintf \'curl %s\\n\' "$*" >> "$STUB_LOG"\nexec /usr/bin/curl "$@"\n');
  writeExe(path.join(S, 'lsof'), '#!/bin/bash\nprintf \'lsof %s\\n\' "$*" >> "$STUB_LOG"\nexec /usr/sbin/lsof "$@"\n');
  // 假 tmux：会话表是 $STUB_SESS 里的一行一个名字
  writeExe(path.join(S, 'tmux'), `#!/bin/bash
echo "tmux $*" >> "$STUB_LOG"
case "$1" in
  ls) cat "$STUB_SESS" 2>/dev/null; exit 0 ;;
  has-session) grep -qxF "$3" "$STUB_SESS" ;;
  kill-session) rest=$(grep -vxF "$3" "$STUB_SESS"); printf '%s\\n' "$rest" | grep -v '^$' > "$STUB_SESS.tmp"; cat "$STUB_SESS.tmp" > "$STUB_SESS"; exit 0 ;;
  *) exit 1 ;;
esac
`);
  const probe = spawnSync('/bin/bash', ['-c', 'for c in launchctl pgrep pkill tmux lsof curl; do command -v "$c"; done'],
    { encoding: 'utf8', env: { PATH: S } });
  const found = probe.stdout.trim().split('\n');
  const safe = found.length === 6 && found.every((p) => p.startsWith(`${S}/`));
  ok(safe, '（前置）这个 PATH 里 launchctl / pgrep / pkill / tmux / lsof / curl 都只解析到桩', probe.stdout);
  if (!safe) { console.log('  ⛔ 前置没过，stop.sh 不跑'); return; }
  for (const p of [PORT, PORT2]) {
    const b = portBusy(p);
    ok(!b, `（前置）测试端口 ${p} 空着`, b);
    if (b) return;
  }

  // 假 bus：核对 Bearer；`REJECT` 里的名字回 404（bus 不认识它）；接受 ⇒ 从会话表删掉它
  const fakeBus = writeExe(path.join(TMP, 'stopg-fake-bus.js'), `
const fs = require('fs');
const TOKEN = ${JSON.stringify(TOKEN)}, SESS = ${JSON.stringify(SESS)}, LOG = ${JSON.stringify(BUSLOG)};
const REJECT = new Set(['beta']);
require('http').createServer((q, s) => {
  const m = /^\\/api\\/agents\\/([^/]+)\\/shutdown$/.exec(q.url);
  const authOk = q.headers.authorization === 'Bearer ' + TOKEN;
  fs.appendFileSync(LOG, JSON.stringify({ method: q.method, url: q.url, auth: q.headers.authorization ? (authOk ? 'ok' : 'wrong') : 'none' }) + '\\n');
  s.setHeader('content-type', 'application/json');
  if (!m || q.method !== 'POST') { s.statusCode = 404; return s.end('{"error":"nope"}'); }
  if (!authOk) { s.statusCode = 401; return s.end('{"error":"UNAUTHENTICATED","message":"没有凭据"}'); }
  const name = decodeURIComponent(m[1]);
  if (REJECT.has(name)) { s.statusCode = 404; return s.end('{"error":"不在花名册里"}'); }
  const sess = name === 'JARVIS' ? 'orch' : 'agent_' + name;
  const left = fs.readFileSync(SESS, 'utf8').split('\\n').filter((x) => x && x !== sess);
  fs.writeFileSync(SESS, left.map((x) => x + '\\n').join(''));
  s.end(JSON.stringify({ ok: true, name }));
}).listen(${PORT}, '127.0.0.1');
setTimeout(() => process.exit(0), 60000);
`);
  const busPid = orphan(`${JSON.stringify(process.execPath)} ${JSON.stringify(fakeBus)}`);
  ok(busPid > 0 && waitListen('127.0.0.1', PORT), `（前置）假 bus 在 127.0.0.1:${PORT} 上听`);

  const run = ({ tokenFile = TOKEN_FILE, port = PORT, sessions = ['orch', 'agent_alpha', 'agent_beta'], fakeBusPid = '' } = {}) => {
    fs.writeFileSync(LOG, ''); fs.writeFileSync(BUSLOG, '');
    fs.writeFileSync(SESS, sessions.map((x) => `${x}\n`).join(''));
    const r = spawnSync('/bin/bash', [path.join(R, 'stop.sh')], {
      encoding: 'utf8', timeout: 60000,
      env: { PATH: S, HOME: newHome(), ENGLOOP_LAUNCHD_LABEL: `test.ops1.stop.${process.pid}`,
        STUB_LOG: LOG, STUB_SESS: SESS, ENGLOOP_PORT: String(port), ENGLOOP_ADMIN_TOKEN_FILE: tokenFile,
        FAKE_BUS_PID: String(fakeBusPid) },
    });
    const calls = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
    const bus = fs.readFileSync(BUSLOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { ...r, calls, bus, left: fs.readFileSync(SESS, 'utf8').trim().split('\n').filter(Boolean) };
  };
  const killed = (r, s) => r.calls.includes(`tmux kill-session -t ${s}`);
  // 等待循环里那个 `sleep 6`（bus 那一节等 SIGTERM 生效用的是 `sleep 1`/`sleep 2`，不算）
  const sleeps = (r) => r.calls.filter((c) => c === 'sleep 6').length;

  // ── 有 token；JARVIS、alpha 被接受，beta 被 bus 拒（404）──
  const g1 = run();
  const posts = g1.bus.filter((x) => x.method === 'POST');
  ok(posts.length === 3 && posts.every((x) => x.auth === 'ok'),
    '★ 三个关停请求都带了正确的 Bearer admin token（假 bus 核对过）', JSON.stringify(g1.bus) + '\n' + g1.stdout.slice(-600));
  const curlCalls = g1.calls.filter((c) => c.startsWith('curl '));
  ok(curlCalls.length === 3 && curlCalls.every((c) => !c.includes(TOKEN) && /-H @-/.test(c)),
    '★ token 不在 curl 的 argv 里（`ps` 看不见）；header 从 stdin 进（-H @-）', JSON.stringify(curlCalls));
  ok(/beta\s+✗ 没送到（HTTP 404）/.test(g1.stdout) && /没送到，不等它们，直接兜底强杀: beta/.test(g1.stdout),
    '被拒的那个：说出名字和 HTTP 码', g1.stdout.slice(-900));
  ok(/等待收尾: orch agent_alpha（/.test(g1.stdout) && /被接受的都优雅退出了/.test(g1.stdout),
    '被接受的才等；它们自己走了 ⇒ 等待结束', g1.stdout.slice(-900));
  ok(!killed(g1, 'orch') && !killed(g1, 'agent_alpha') && killed(g1, 'agent_beta'),
    '★ 自己走的不强杀；没送到的那个进了兜底强杀', JSON.stringify(g1.calls.filter((c) => c.startsWith('tmux kill'))));
  ok(g1.left.length === 0 && g1.status === 0, '收干净了，退出 0', `left=${g1.left} status=${g1.status}`);

  // ── token 是错的 ⇒ 全部 401 ⇒ **一秒都不等**（否则会白等满整个超时）──
  const wrong = path.join(TMP, 'stopg-wrong.token');
  fs.writeFileSync(wrong, `${'cd'.repeat(32)}\n`, { mode: 0o600 });
  const g2 = run({ tokenFile: wrong });
  ok(g2.bus.filter((x) => x.method === 'POST').every((x) => x.auth === 'wrong') && /HTTP 401/.test(g2.stdout),
    '（前置）token 不对 ⇒ bus 回 401，输出里看得见 401', g2.stdout.slice(-700));
  ok(sleeps(g2) === 0 && !/等待收尾/.test(g2.stdout) && /没有一个关停请求被接受 ⇒ 不等/.test(g2.stdout),
    '★★ 没有一个被接受 ⇒ 不进等待循环（sleep 一次都没调）', `sleeps=${sleeps(g2)}\n${g2.stdout.slice(-700)}`);
  ok(['orch', 'agent_alpha', 'agent_beta'].every((s) => killed(g2, s)) && g2.left.length === 0,
    '全部进兜底强杀', JSON.stringify(g2.calls.filter((c) => c.startsWith('tmux'))));

  // ── token 文件不在 ⇒ 大声说一行、一个请求都不发、不等、兜底；
  //        顺带：bus 那一步的「端口已释放」只看 127.0.0.1 —— ::1 上有人听不算 ──
  const v6 = orphan(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    `require('net').createServer(() => {}).listen(${PORT2}, '::1'); setTimeout(() => process.exit(0), 60000);`)}`);
  const v6up = v6 > 0 && waitListen('[::1]', PORT2);
  ok(v6up, `（前置）::1:${PORT2} 上有一个监听者（不是 127.0.0.1）`);
  const stand = orphan('/bin/sleep 300');   // 替身 bus 进程（让 stop.sh 走进 bus 那一节的三个判据）
  const g3 = run({ tokenFile: path.join(TMP, 'no-such.token'), port: PORT2, fakeBusPid: stand });
  ok(/读不到 bus 的 admin token/.test(g3.stdout) && g3.bus.length === 0 && !g3.calls.some((c) => c.startsWith('curl ') && /shutdown/.test(c)),
    '★ 读不到 token ⇒ 说出来，一个关停请求都不发（不降级成不带凭据去请求）', g3.stdout.slice(-700));
  ok(sleeps(g3) === 0 && g3.left.length === 0, '不等，直接兜底强杀', `sleeps=${sleeps(g3)} left=${g3.left}`);
  ok(g3.calls.some((c) => c.startsWith('lsof ') && c.includes(`-iTCP@127.0.0.1:${PORT2}`)),
    'bus 那一节的端口判据问的是 127.0.0.1:<端口>', JSON.stringify(g3.calls.filter((c) => c.startsWith('lsof'))));
  ok(v6up && new RegExp(`✓ 127\\.0\\.0\\.1:${PORT2} 已释放`).test(g3.stdout),
    '★ ::1 上有监听也报「127.0.0.1 已释放」（别的地址上的转发进程不算占用）', g3.stdout.slice(-500));
}

// ──────────────────────────────────────────────────────────────────────
// start.sh：假 checkout（launchd.js / serve.sh / orch-start.js 都是桩）＋ 私有 tmux ＋ 测试端口
// ──────────────────────────────────────────────────────────────────────
function startShHarness() {
  console.log('\n【8】start.sh 的两个分支（假 checkout：bin/launchd.js、bin/serve.sh 是桩）');
  const PORT = 19993;   // 生产 9969 · e2e 19969 · bus-auth 19977 · graph-e2e 19983 · 19987
  const R = path.join(TMP, 'start-root');
  fs.mkdirSync(path.join(R, 'bin'), { recursive: true });
  stageScript('start.sh', R);
  const LOG = path.join(TMP, 'start-calls.log');
  const PIDS = path.join(TMP, 'start-fakebus.pids');
  const tmuxDir = path.join(TMP, 'tmux');
  fs.mkdirSync(tmuxDir, { recursive: true });

  // 假 bus：/health 和 /api/agents 都回 200；60 秒后自己退出（兜底，cleanup 也会杀）
  const fakeBus = writeExe(path.join(R, 'bin', 'fake-bus.js'), `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(PIDS)}, process.pid + '\\n');
// /health 跟真 bus 一样自报 service（start.sh 只认这个），别的路径回 /api/agents 的形状
require('http').createServer((q, s) => { s.setHeader('content-type', 'application/json');
  s.end(q.url === '/health' ? '{"ok":true,"service":"engloop-bus"}' : '{"sessions_seen":1,"live":[]}'); })
  .listen(${PORT}, '127.0.0.1');
setTimeout(() => process.exit(0), 60000);
`);
  writeExe(path.join(R, 'bin', 'launchd.js'), `
const fs = require('fs');
const cmd = process.argv[2];
fs.appendFileSync(${JSON.stringify(LOG)}, 'launchd.js ' + cmd + '\\n');
if (cmd === 'mode') { console.log(process.env.FAKE_MODE); process.exit(0); }
if (cmd === 'start') {
  require('child_process').spawn(process.execPath, [${JSON.stringify(fakeBus)}], { detached: true, stdio: 'ignore' }).unref();
  console.log('✓ launchctl bootstrap（桩）'); process.exit(0);
}
process.exit(0);
`);
  writeExe(path.join(R, 'bin', 'serve.sh'), `#!/bin/bash
echo "serve.sh" >> ${JSON.stringify(LOG)}
exec node ${JSON.stringify(fakeBus)}
`);
  writeExe(path.join(R, 'bin', 'orch-start.js'), `require('fs').appendFileSync(${JSON.stringify(LOG)}, 'orch-start.js\\n');`);

  const env = { ...process.env, ENGLOOP_PORT: String(PORT), TMUX_TMPDIR: tmuxDir };
  delete env.TMUX; delete env.TMUX_PANE;
  const tmux = (args) => spawnSync('tmux', args, { env, encoding: 'utf8' });
  cleanups.push(() => tmux(['kill-server']));
  cleanups.push(() => {
    if (!fs.existsSync(PIDS)) return;
    for (const p of fs.readFileSync(PIDS, 'utf8').split('\n').filter(Boolean)) { try { process.kill(Number(p), 'SIGTERM'); } catch (_) { /* 已退 */ } }
  });
  const killFakeBuses = () => {
    if (!fs.existsSync(PIDS)) return;
    for (const p of fs.readFileSync(PIDS, 'utf8').split('\n').filter(Boolean)) { try { process.kill(Number(p), 'SIGTERM'); } catch (_) { /* 已退 */ } }
    fs.rmSync(PIDS, { force: true });
    // 等端口放开
    for (let i = 0; i < 50; i++) {
      const l = spawnSync('lsof', ['-ti', `:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
      if (!l.stdout.trim()) break;
      spawnSync('/bin/sleep', ['0.1']);
    }
  };

  // 前置：端口空着、私有 tmux 里有一个 orch（让 start.sh 跳过起编排者那一步）
  const busy = spawnSync('lsof', ['-ti', `:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim();
  ok(!busy, `（前置）测试端口 ${PORT} 空着`, busy);
  if (busy) return;
  const t = tmux(['new-session', '-d', '-s', 'orch', 'sleep 600']);
  ok(t.status === 0, '（前置）私有 tmux 里起了一个 orch 会话（start.sh 就不会去起编排者）', t.stderr);
  const pong = spawnSync('redis-cli', ['ping'], { encoding: 'utf8', env: { ...env, PATH: `/opt/homebrew/bin:/usr/local/bin:${env.PATH}` } });
  if (!/PONG/.test(pong.stdout || '')) { ok(false, '（前置）redis-cli ping —— start.sh 第 0 步要它', pong.stderr || pong.error); return; }

  const runStart = (mode) => {
    fs.writeFileSync(LOG, '');
    const r = spawnSync('/bin/bash', [path.join(R, 'start.sh')], {
      encoding: 'utf8', timeout: 60000, env: { ...env, FAKE_MODE: mode }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ...r, calls: fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) };
  };

  const n = runStart('nohup');
  ok(n.calls.includes('launchd.js mode') && n.calls.includes('serve.sh') && !n.calls.includes('launchd.js start'),
    'mode=nohup ⇒ 走 bin/serve.sh，不调 launchd.js start', `${JSON.stringify(n.calls)}\n${n.stdout.slice(-500)}`);
  ok(n.status === 0 && /bus 起来了/.test(n.stdout), 'nohup 分支：等 /health 那段照常（bus 起来了）', `${n.status}\n${n.stdout.slice(-400)}${n.stderr}`);
  ok(!n.calls.includes('orch-start.js'), '（orch 已在 ⇒ 没起编排者）', JSON.stringify(n.calls));

  // bus 已在跑 ⇒ 两个都不调
  const already = runStart('launchd');
  ok(!already.calls.includes('launchd.js start') && !already.calls.includes('serve.sh') && /bus 已在跑/.test(already.stdout),
    'bus 已在跑 ⇒ 不 bootstrap 也不 nohup（同现在）', `${JSON.stringify(already.calls)}\n${already.stdout.slice(-300)}`);
  killFakeBuses();

  const l = runStart('launchd');
  ok(l.calls.includes('launchd.js start') && !l.calls.includes('serve.sh'),
    '★ mode=launchd ⇒ 调 launchd.js start（bootstrap），不走 nohup', `${JSON.stringify(l.calls)}\n${l.stdout.slice(-500)}`);
  ok(l.status === 0 && /bus 起来了/.test(l.stdout), 'launchd 分支：后面等 /health 那段两种模式共用', `${l.status}\n${l.stdout.slice(-400)}${l.stderr}`);
  killFakeBuses();

  // ── 【8b】OPS1：判「bus 在不在」只认 127.0.0.1:<端口>/health 自报 engloop-bus ─────────────
  console.log('\n【8b】start.sh 判 bus：只认 /health 自报 engloop-bus');
  const node = JSON.stringify(process.execPath);

  // ① 只在 ::1 上有人听（比如一个转发进程：不在 127.0.0.1）⇒ 判「bus 不在」，照常起 bus
  const v6 = orphan(`${node} -e ${JSON.stringify(
    `require('net').createServer(() => {}).listen(${PORT}, '::1'); setTimeout(() => process.exit(0), 60000);`)}`);
  const v6up = v6 > 0 && waitListen('[::1]', PORT);
  ok(v6up, `（前置）::1:${PORT} 上有一个不相干的监听者，127.0.0.1:${PORT} 空着`);
  if (v6up) {
    const a = runStart('nohup');
    ok(!/bus 已在跑/.test(a.stdout) && a.calls.includes('serve.sh') && /bus 起来了/.test(a.stdout),
      '★★ 别的地址上有监听 ⇒ 不算 bus 在跑，照常起 bus（只看 `lsof -ti :PORT` 的话会在这里说「bus 已在跑」）',
      `${JSON.stringify(a.calls)}\n${a.stdout.slice(-500)}`);
    ok(/提示：端口 \d+ 在别的地址上有监听/.test(a.stdout), '别的地址上的监听只打一行提示', a.stdout.slice(-500));
    try { process.kill(v6, 'SIGKILL'); } catch (_) { /* 已退 */ }
    killFakeBuses();
  }

  // ② 127.0.0.1:<端口> 上是一个**回 200、但不是 engloop-bus** 的服务 ⇒ 报错退出，打印 pid，不起第二个 bus
  const impostor = orphan(`${node} -e ${JSON.stringify(
    `require('http').createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end('{"ok":true,"service":"something-else"}'); })`
    + `.listen(${PORT}, '127.0.0.1'); setTimeout(() => process.exit(0), 60000);`)}`);
  const squatterUp = impostor > 0 && waitListen('127.0.0.1', PORT);
  ok(squatterUp, `（前置）127.0.0.1:${PORT} 上有一个回 200 的冒牌服务（service≠engloop-bus）`);
  if (squatterUp) {
    const b = runStart('nohup');
    ok(b.status === 1 && !b.calls.includes('serve.sh') && !b.calls.includes('launchd.js start') && !/bus 已在跑/.test(b.stdout),
      '★★ 127.0.0.1 上被别人占着 ⇒ 不当成 bus、也不去起第二个，非 0 退出', `${b.status} ${JSON.stringify(b.calls)}\n${b.stdout.slice(-500)}`);
    ok(new RegExp(`不是 engloop-bus 的进程占着`).test(b.stdout) && new RegExp(`\\b${impostor}\\b`).test(b.stdout) && /node/.test(b.stdout),
      '打印占着端口的那个进程（pid、命令）', b.stdout.slice(-500));
    try { process.kill(impostor, 'SIGKILL'); } catch (_) { /* 已退 */ }
  }
}

try { main(); } catch (e) { console.error('✗ 异常:', e.stack || e.message); process.exit(1); }
