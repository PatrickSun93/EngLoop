'use strict';

/**
 * 端口注册表。
 *
 * ── 这个文件专门守什么 ──────────────────────────────────────────
 *
 * ★ **判据是「新进程能不能 listen 成功」，不是「lsof 说没人占」。**
 *
 * 已知现象：`lsof` 报的 PID 已经死了、`kill` 说 no such process，
 * **而端口仍然绑不上**。所以本文件里所有关于「端口能不能用」的断言，
 * **一律靠真的去绑一次**，没有一条是查表或查工具输出得来的。
 *
 * 同理，【7】不断言「handler 被注册了」，而是**真起一个子进程去绑一个
 * 被占的端口，读它的退出码**。断言 argv 里有某个 flag 那种测试会骗人：
 * flag 传了，可能完全不生效（`--allowedTools` 就是这样）。
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const reg = require('../bin/port-registry');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'port-listen-probe.js');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

// ★ 「跑到终点了吗」守卫。
//
// 测试可能在中途**静默退出，退出码 0**，
// 后面的用例一条都没跑。而 `test/run-all.js` 靠正则找
// `通过 N · 失败 M`，找不到就记 pass=0/fail=0，再看 exit code 是 0 ——
// 于是在全量报告里打出一个 **绿勾**。
//
// **没跑的断言被算成跑过了**，比一条恒绿的断言更能骗人。
// 所以在这里钉一颗钉子：没走到 main() 末尾就退出的，一律非零。
let reachedEnd = false;
process.on('exit', (code) => {
  if (!reachedEnd && code === 0) {
    console.error('\n✗ 测试没跑到终点就退出了（exit 0）——'
      + ' 多半是某个 Promise 永远不 resolve，event loop 空了。');
    console.error('  **这不是「通过」。** 上面打出来的用例只是它死之前跑到的那些。');
    process.exitCode = 1;
  }
});

/**
 * 真起一个 server 占住某端口。返回 { port, close() }。
 *
 * ★ `(sock) => sock.destroy()` 不是装饰。
 *   Node 的 socket 不 resume 就不读数据，于是**看不到对端的 FIN**，
 *   连接一直挂着 → `server.close()` 的回调永远不来 → 测试静默死掉。
 *   【4】【6】里的 identify() 会去连这个端口，所以这里必须 destroy。
 */
function occupy(port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const s = net.createServer((sock) => sock.destroy());
    s.once('error', reject);
    s.listen(port, host, () => {
      resolve({
        port: s.address().port,
        close: () => new Promise((r) => s.close(r)),
      });
    });
  });
}

/** 借一个当下空闲的端口号：占一下、记下号、立刻放开。 */
async function borrowFreePort() {
  const held = await occupy(0);
  const p = held.port;
  await held.close();
  return p;
}

/** 在临时改过的 env 下跑一段，跑完还原。 */
function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); }
  finally {
    if (had) process.env[key] = old;
    else delete process.env[key];
  }
}

async function main() {
  // ───────────────────────────────────────────────────────────────
  console.log('\n【1】注册表 = 唯一出处');

  const bus = withEnv('ENGLOOP_PORT', undefined, () => reg.resolve('bus'));
  ok(bus.port === 9969, 'bus 默认端口 9969', `实际 ${bus.port}`);
  ok(bus.source === 'registry', '没设 env 时来源标为 registry', `实际 ${bus.source}`);

  // ★ host 不是装饰。试探必须用跟真实 listen **完全相同**的地址，
  //   否则试探回答的是另一个问题（0.0.0.0 和 127.0.0.1 的冲突规则不同）。
  //   守法：断言 serve.js 的 listen **引用注册表变量**，而不是自己写一个
  //   字面量 —— 字面量哪怕现在写对了，注册表改的那天也不会跟着变。
  const serveSrc = fs.readFileSync(path.join(ROOT, 'bin', 'serve.js'), 'utf8');
  const listenLine = (serveSrc.match(/server\.listen\([^)]*\)/) || [''])[0];
  ok(bus.host === '127.0.0.1', '注册表里 bus 的 host 是 127.0.0.1');
  ok(/BUS\.host/.test(listenLine),
    'serve.js 的 listen 地址取自注册表，不是另写一个字面量',
    listenLine || '没找到 server.listen(...)');
  ok(!/['"]127\.0\.0\.1['"]/.test(listenLine),
    '并且那一行里没有硬编码的 127.0.0.1', listenLine);

  let threw = null;
  try { reg.resolve('nope'); } catch (e) { threw = e; }
  ok(threw && threw.code === 'UNKNOWN_SERVICE', '未登记的服务名 → 抛 UNKNOWN_SERVICE',
    threw ? threw.code : '没抛');

  // ───────────────────────────────────────────────────────────────
  console.log('\n【2】env 覆盖 —— 但非法值 fail-closed，不静默回落');

  const over = withEnv('ENGLOOP_PORT', '12345', () => reg.resolve('bus'));
  ok(over.port === 12345, 'ENGLOOP_PORT 能覆盖端口', `实际 ${over.port}`);
  ok(over.source === 'ENGLOOP_PORT', '覆盖时来源标成 env 名', `实际 ${over.source}`);

  // ★ 判据①：`ENGLOOP_PORT=abc` 悄悄回落成 9969，跟「换端口成功了」
  //   长得一模一样 —— 人以为自己换了，实际没换。必须报错。
  for (const bad of ['abc', '0', '70000', '-1', '9969.5']) {
    let e = null;
    try { withEnv('ENGLOOP_PORT', bad, () => reg.resolve('bus')); } catch (err) { e = err; }
    ok(e && e.code === 'BAD_PORT_ENV', `ENGLOOP_PORT='${bad}' → 报错，不回落到 9969`,
      e ? e.code : '没抛 —— 它回落了');
  }

  const empty = withEnv('ENGLOOP_PORT', '', () => reg.resolve('bus'));
  ok(empty.port === 9969 && empty.source === 'registry',
    "ENGLOOP_PORT='' 当成没设（launchd 常留空变量）", `实际 ${empty.port}/${empty.source}`);

  // ───────────────────────────────────────────────────────────────
  console.log('\n【3】probe = 真去绑一次（不是查 lsof，不是问 HTTP）');

  const P = await borrowFreePort();

  let r = await reg.probe({ port: P, host: '127.0.0.1' });
  ok(r.available === true, `空闲端口 ${P} → available`, `实际 ${JSON.stringify(r)}`);

  // ★ probe 自己不能把端口留住 —— 它只是问个问题。
  //
  //   这条**必须紧跟第一次 probe**，而且必须自己接住异常。
  //   放在这组最后的话，变异验证下它不会红：
  //   摘掉 probe 里的 close() 之后，下面那个 `occupy(P)` 直接 reject，
  //   测试从 main().catch 掉出去 —— **这条断言根本没被执行到**。
  //   一条到不了的断言，跟一条恒绿的断言一样没有鉴别力。
  let held = null;
  try { held = await occupy(P); }
  catch (e) { /* 绑不上 = probe 绑完没放开，端口还在它手里 */ }
  ok(held !== null, 'probe 之后端口能被真正绑上 —— probe 没把它留在手里',
    'occupy 失败，说明 probe 自己还占着它');

  if (held) {
    r = await reg.probe({ port: P, host: '127.0.0.1' });
    ok(r.available === false, '端口真被占住时 → 不可用', `实际 ${JSON.stringify(r)}`);
    ok(r.code === 'EADDRINUSE', '并且给出 EADDRINUSE，能跟「查不了」区分开', `实际 ${r.code}`);

    await held.close();
    r = await reg.probe({ port: P, host: '127.0.0.1' });
    ok(r.available === true, '占用者退出后 → 又可用了（判据跟着现实走）',
      `实际 ${JSON.stringify(r)}`);
  } else {
    // 主动记成失败并说明范围 —— 「没测到」不许悄悄变成「测过了」
    ok(false, '（占不住端口，下面 3 条「被占/EADDRINUSE/放开后恢复」没测到）');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【4】fail-closed：探测出意外，绝不返回「可用」');

  // 非法 host —— 造一个「探测本身失败」的真实情况
  const bad = await reg.probe({ port: P, host: '300.300.300.300' });
  ok(bad.available === false, '探测失败时 available=false，不是「就当能用吧」',
    JSON.stringify(bad));
  ok(bad.code && bad.code !== 'EADDRINUSE',
    '并且 code 不冒充 EADDRINUSE —— 「我查不了」跟「有人占着」是两个事实',
    `实际 ${bad.code}`);

  // ★ 措辞也算防线：诊断文本必须说清「这不是确认被占」。
  //   否则人照着「端口被占」去 kill 一个根本不存在的进程。
  const t = reg.resolve('bus');
  const txtUnknown = reg.formatConflict(t,
    { available: false, code: 'PROBE_TIMEOUT', detail: 'x' }, { known: false, reason: 'r', clues: [] });
  ok(/不是「确认被占」|没查出结果/.test(txtUnknown),
    '探测超时的诊断里写明「不是确认被占」', txtUnknown.slice(0, 120));

  const txtBusy = reg.formatConflict(t,
    { available: false, code: 'EADDRINUSE', detail: 'x' }, { known: true, clues: ['某进程'] });
  ok(!/不是「确认被占」/.test(txtBusy) && /有人占着它/.test(txtBusy),
    '真被占时不说那句免责，直接说有人占着', txtBusy.slice(0, 120));

  // ───────────────────────────────────────────────────────────────
  console.log('\n【5】identify 只是线索，且「查不到」≠「没人占」');

  const freeP = await borrowFreePort();
  const who = await reg.identify(
    { port: freeP, host: '127.0.0.1' },
    { processPattern: /__绝不会匹配到任何东西__/ });
  ok(who.known === false, '什么线索都没有时 → known:false（不是返回空当「没人」）',
    JSON.stringify(who));
  ok(typeof who.reason === 'string' && who.reason.length > 0,
    '并且给出一句人能读的解释', JSON.stringify(who));

  // 有线索时要标明这线索本身不可靠 —— ps 匹配到进程 ≠ 它绑着这个端口
  const whoPs = await reg.identify(
    { port: freeP, host: '127.0.0.1' },
    { processPattern: /node/ });
  if (whoPs.known) {
    ok(whoPs.clues.some((c) => /没有验证/.test(c)),
      'ps 线索明确标注「没有验证它绑的就是这个端口」', JSON.stringify(whoPs.clues));
  } else {
    // 这台机器上 ps 里一个 node 都没有（几乎不可能，因为测试自己就是）
    ok(false, 'ps 线索应该匹配到本测试进程自己', JSON.stringify(whoPs));
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【5b】identify 不能在被诊断的服务上留下连接');
  // ★ 变异验证给过两组数：`agent: false` 在 → 剩 0；摘掉 → 剩 1。
  //   排查一次冲突要问好几轮，每轮漏一条。诊断工具不该改变被诊断的对象。

  const victim = require('node:http').createServer((rq, rs) => rs.end('{"pid":1}'));
  await new Promise((r) => victim.listen(0, '127.0.0.1', r));
  const vPort = victim.address().port;

  const vWho = await reg.identify({ port: vPort, host: '127.0.0.1' }, { processPattern: /__none__/ });
  ok(vWho.known === true && vWho.clues.some((c) => /应答 HTTP/.test(c)),
    '对方说 HTTP 时能问出来', JSON.stringify(vWho));

  await new Promise((r) => setTimeout(r, 300));   // 给 socket 走完关闭
  const leftOver = await new Promise((r) => victim.getConnections((e, n) => r(e ? -1 : n)));
  ok(leftOver === 0, 'identify 之后目标身上剩 0 条连接（摘掉 agent:false 这里会是 1）',
    `实际 ${leftOver}`);
  await new Promise((r) => victim.close(r));

  // ───────────────────────────────────────────────────────────────
  console.log('\n【6】assertAvailable：能用就放行，不能用就抛可操作的错');

  const P2 = await borrowFreePort();
  const okTarget = await withEnv('ENGLOOP_PORT', String(P2), () => reg.assertAvailable('bus'));
  ok(okTarget.port === P2, '端口空闲时 assertAvailable 正常返回 target', `实际 ${okTarget.port}`);

  const held2 = await occupy(P2);
  let ae = null;
  try { await withEnv('ENGLOOP_PORT', String(P2), () => reg.assertAvailable('bus')); }
  catch (e) { ae = e; }
  ok(ae && ae.code === 'PORT_UNAVAILABLE', '端口被占时抛 PORT_UNAVAILABLE',
    ae ? ae.code : '没抛');
  ok(ae && /bus-restart/.test(ae.message), '错误里带了「怎么办」的命令，不是只报个 errno');
  ok(ae && /ENGLOOP_PORT=/.test(ae.message), '错误里给了换端口的办法');
  await held2.close();

  // ───────────────────────────────────────────────────────────────
  console.log('\n【7】listen 的 error handler —— 真子进程，真退出码');
  // ★ 这里不断言「handler 被注册了」。handler 的全部价值在**它怎么结束进程**，
  //   而那只有真起一个进程才验得到。

  const P3 = await borrowFreePort();

  // (a) 端口空着 → 探针该正常绑上并 exit 0
  const free = spawnSync('node', [FIXTURE, String(P3)], { encoding: 'utf8', cwd: ROOT });
  ok(free.status === 0, '端口空闲时探针 exit 0', `实际 exit ${free.status}`);
  ok(/LISTENING/.test(free.stdout || ''), '并且确实绑上了（打了 LISTENING）',
    (free.stdout || '') + (free.stderr || ''));

  // (b) 端口被占 → 探针该带专用退出码死掉，并打出诊断
  const held3 = await occupy(P3);
  const busyRun = spawnSync('node', [FIXTURE, String(P3)], { encoding: 'utf8', cwd: ROOT });
  const errOut = (busyRun.stderr || '') + (busyRun.stdout || '');
  ok(busyRun.status === 78, '端口被占时探针 exit 78（专用码，跟别的崩法分得开）',
    `实际 exit ${busyRun.status}`);
  ok(busyRun.status !== 0, '总之不是 0 —— 起失败绝不能看起来像起成功了');
  ok(!/LISTENING/.test(busyRun.stdout || ''), '并且没有谎报 LISTENING');
  ok(/绑不上/.test(errOut), '诊断说清了发生什么', errOut.slice(0, 200));
  ok(/bus-restart/.test(errOut), '诊断给了可以直接跑的修复命令', errOut.slice(0, 200));
  ok(reg.EXIT_PORT_CONFLICT === 78, '退出码 78 是导出的常量，调用方不用去 grep 日志文本');
  await held3.close();

  // ───────────────────────────────────────────────────────────────
  console.log('\n【8】收敛：9969 这个数字不该在别处再有一份');
  // 唯一出处的真实守卫 —— 有人再写一个 `|| 9969` 就红。

  // 只看代码，不看注释 —— 注释里写「以前这里是 9969」是文档，不是第二份默认值。
  const stripJs = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const stripSh = (s) => s.replace(/(^|\s)#.*$/gm, '$1');

  const shouldBeClean = ['serve.js', 'placeholder-server.js', 'preflight.sh'];
  for (const f of shouldBeClean) {
    const raw = fs.readFileSync(path.join(ROOT, 'bin', f), 'utf8');
    const code = f.endsWith('.sh') ? stripSh(raw) : stripJs(raw);
    ok(!/9969/.test(code), `bin/${f} 的代码里没有硬编码的 9969`,
      (code.match(/.*9969.*/) || [''])[0].trim());
  }

  // 剥注释这件事本身要有鉴别力 —— 否则它可能把整份代码都剥没了，
  // 那样上面三条就成了恒绿。用注册表自己当阳性对照：
  // 它的代码里**必须**有 9969，剥完还能看见才说明剥法没剥过头。
  const regCode = stripJs(fs.readFileSync(path.join(ROOT, 'bin', 'port-registry.js'), 'utf8'));
  ok(/9969/.test(regCode),
    '阳性对照：注册表自己的代码里看得见 9969 —— 证明上面三条不是被剥空剥绿的');

  // ⚠️ **未纳入守卫，主动标出来**（别让一条恒绿的断言假装有覆盖）：
  //    `bin/bus-restart.js` 有自己的一份端口默认值和端口占用判断，
  //    这里不守它。
  const brCode = stripJs(fs.readFileSync(path.join(ROOT, 'bin', 'bus-restart.js'), 'utf8'));
  if (/9969/.test(brCode)) {
    console.log('  ⓘ bin/bus-restart.js 仍有独立的 9969 默认值 —— **已知未收敛**，');
    console.log('    等编排者授权后改。这条没算进通过数，它现在没有覆盖。');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【9】CLI 出口 —— bin/preflight.sh 完全靠它拿端口');
  // ★ 真跑子进程读 stdout/退出码，不是断言函数存在。
  //   shell 侧没法 require 这个模块，这条 CLI 就是它唯一的问路方式；
  //   它一旦骗人，preflight 会拿着一个错端口去自检，**报出来的
  //   「EngLoop 不可达」是假的** —— 而假的故障报告比没有报告更贵。

  const CLI = path.join(ROOT, 'bin', 'port-registry.js');
  const runCli = (args, env = {}) => spawnSync('node', [CLI, ...args],
    { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env }, timeout: 20000 });

  const cliPort = runCli(['--port', 'bus'], { ENGLOOP_PORT: '' });
  ok(cliPort.status === 0, '--port bus → exit 0', `实际 ${cliPort.status}`);
  ok(cliPort.stdout.trim() === '9969', '--port bus 只吐端口号，别的什么都不吐',
    JSON.stringify(cliPort.stdout));

  // ★ 出错时**绝不能往 stdout 吐一个数字** —— shell 那边只会看 stdout。
  const cliUnknown = runCli(['--port', 'nope']);
  ok(cliUnknown.status !== 0, '未知服务 → 非零退出', `实际 ${cliUnknown.status}`);
  ok(!/^\s*\d+\s*$/.test(cliUnknown.stdout),
    '并且 stdout 里没有数字 —— 否则 shell 会拿着垃圾当端口用',
    JSON.stringify(cliUnknown.stdout));

  const cliBadEnv = runCli(['--port', 'bus'], { ENGLOOP_PORT: 'abc' });
  ok(cliBadEnv.status !== 0, '非法 ENGLOOP_PORT → 非零退出', `实际 ${cliBadEnv.status}`);
  ok(!/9969/.test(cliBadEnv.stdout),
    '并且不吐默认值 9969 —— 那会让人以为端口没问题',
    JSON.stringify(cliBadEnv.stdout));

  // --check：空/占两种情况各一组数
  const P5 = await borrowFreePort();
  const chkFree = runCli(['--check', 'bus'], { ENGLOOP_PORT: String(P5) });
  ok(chkFree.status === 0, '--check 端口空闲 → exit 0', `实际 ${chkFree.status}`);

  const held5 = await occupy(P5);
  const chkBusy = runCli(['--check', 'bus'], { ENGLOOP_PORT: String(P5) });
  ok(chkBusy.status === 78, '--check 端口被占 → exit 78', `实际 ${chkBusy.status}`);
  ok(/绑不上/.test(chkBusy.stderr || ''), '并且诊断走 stderr（不污染 stdout）',
    JSON.stringify((chkBusy.stderr || '').slice(0, 120)));
  await held5.close();

  // preflight.sh 真的在用这条 CLI 吗 —— 别让守卫守一个没人走的路径
  const pf = fs.readFileSync(path.join(ROOT, 'bin', 'preflight.sh'), 'utf8');
  ok(/port-registry\.js --port bus/.test(pf),
    'preflight.sh 确实是从这条 CLI 拿端口的');
  ok(/exit 1/.test(pf.slice(pf.indexOf('port-registry.js --port bus'))),
    '并且问不到端口时它停下来，不拿一个猜的端口继续自检');

  reachedEnd = true;
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
