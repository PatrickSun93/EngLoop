'use strict';

/**
 * `bin/bus-restart.js` 的两处修复。
 *
 * ── 这个文件为什么存在 ──────────────────────────────────────────
 * 这个脚本的整个价值是「每一步都不轻信」，所以它的第一步也不能信一个错的
 * 来源：**发信号的对象和验证的对象必须是同一批 PID**。否则输出会是
 *
 *     发 SIGTERM 给 2572
 *     ✗ 等了 8000ms，进程 35270 仍在。
 *
 * 而 2572 不存在。
 *
 * ★ 这里所有关于「进程在不在」的断言都**真起一个进程、真杀掉它**，
 *   所有关于「端口能不能用」的断言都**真去绑一次**。
 *   不断言「函数被调用了」—— 那种测试会骗人。
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const br = require('../bin/bus-restart');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

// 跑到终点了吗 —— 静默退出不许被算成通过（见 test/run-all.js 里的说明）
let reachedEnd = false;
process.on('exit', (code) => {
  if (!reachedEnd && code === 0) {
    console.error('\n✗ 测试没跑到终点就退出了（exit 0）。**这不是「通过」。**');
    process.exitCode = 1;
  }
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ───────────────────────────────────────────────────────────────
  console.log('\n【1】require 这个文件不能有副作用');
  // ★ 没有 require.main 守卫的话，上面那行 require 就已经把 bus 停了。
  //   这条断言看起来平淡，但它守的是「测试本身不会拆掉生产环境」。
  ok(typeof br.parsePsOutput === 'function', 'parsePsOutput 导出了（能拿构造输入测它）');
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'bus-restart.js'), 'utf8');
  ok(/if \(require\.main === module\)/.test(src),
    'main() 被 require.main 守着 —— require 它不会真的去停 bus');

  // ───────────────────────────────────────────────────────────────
  console.log('\n【2】ps 解析：只认「是 serve.js」，不认「提到 serve.js」');

  const real = '  PID COMMAND\n'
    + '59343 /home/u/.nvm/versions/node/v22.15.1/bin/node bin/serve.js\n';
  ok(JSON.stringify(br.parsePsOutput(real)) === '[59343]',
    '真实格式的一行能挑出来', JSON.stringify(br.parsePsOutput(real)));

  // ★ 一个进程的命令行里可以含换行 —— ps 原样打，一条记录被拆成几行。
  //   续行不是记录，它只是碰巧以数字开头的文本。
  const withNewlineArgv = '  PID COMMAND\n'
    + '  501 /path/node /path/claude --prompt 去看一下 bin/serve.js 里怎么写的\n'
    + '2572 然后把 bin/serve.js 的端口改掉\n'
    + '35270 /home/u/.nvm/versions/node/v22.15.1/bin/node bin/serve.js\n';
  const got = br.parsePsOutput(withNewlineArgv);
  ok(!got.includes(2572), '命令行续行里的数字不会被当成 PID', JSON.stringify(got));
  ok(!got.includes(501), '「参数里提到 bin/serve.js」的进程不算 bus', JSON.stringify(got));
  ok(JSON.stringify(got) === '[35270]', '只挑出真正的那一个', JSON.stringify(got));

  ok(br.parsePsOutput('  PID COMMAND\n 1234 /bin/bash bin/serve.sh\n').length === 0,
    'serve.sh（起 bus 的壳）不是 bus 本身');
  ok(br.parsePsOutput('  PID COMMAND\n 1234 /path/node bin/bus-restart.js\n').length === 0,
    '这个脚本自己不算');
  ok(br.parsePsOutput('  PID COMMAND\n 1234 /path/node bin/serve.js.bak\n').length === 0,
    'bin/serve.js.bak 不算（要求它是完整的一个参数）');
  ok(br.parsePsOutput('').length === 0, '空输入 → 空结果（不炸）');

  // ───────────────────────────────────────────────────────────────
  console.log('\n【3】pidAlive：直接试，不查 ps');

  // 真起一个进程
  const child = spawn('node', ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  await wait(300);
  ok(br.pidAlive(child.pid) === true, `真进程 ${child.pid} → 在`);

  child.kill('SIGKILL');
  // 等它真的没了 —— 不是等固定时间，是等到事实变了
  for (let i = 0; i < 40 && br.pidAlive(child.pid); i++) await wait(50);
  ok(br.pidAlive(child.pid) === false, '杀掉之后 → 不在（判据跟着现实走）');

  // ★ 几乎不可能存在的 PID。用 kill(pid,0) 直接问，不猜。
  const ghost = 2572;
  const ghostAlive = br.pidAlive(ghost);
  console.log(`  ⓘ 现场那个 2572 现在的状态: ${ghostAlive ? '存在' : '不存在'}`);
  ok(typeof ghostAlive === 'boolean', 'pidAlive 对任意 PID 都给确定答案，不抛');

  // ───────────────────────────────────────────────────────────────
  console.log('\n【4】★ 发信号的对象 = 验证的对象');
  // stop() 发信号和验证必须用同一份快照。验证时要是**重新问**
  // 一次「现在有哪些 bus」—— 两次独立快照之间进程集合会变，于是报出
  // 「发信号给 2572 / 进程 35270 仍在」这种读不懂的东西。

  // 用 `stop(` 而不是 `stop()` —— 签名带可选入参，写死括号会让整节
  // 静默失配（切片变成空串，5 条断言一起红，而原因跟它们守的东西无关）。
  const stopStart = src.indexOf('async function stop(');
  const stopSrc = src.slice(stopStart, src.indexOf('async function start(', stopStart));
  ok(stopStart > -1 && stopSrc.length > 200,
    '（前置）切到了 stop() 的函数体 —— 否则下面几条测的是空字符串',
    `起点 ${stopStart} 长度 ${stopSrc.length}`);

  ok(/pids\.some\(pidAlive\)|pids\.filter\(pidAlive\)/.test(stopSrc),
    'stop() 的等待与判定针对**发过信号的那批 pids**');
  // 变异守卫：改回 findBusPids() 重新取快照就红
  const waitBlock = stopSrc.slice(stopSrc.indexOf('const deadline'), stopSrc.indexOf('const left'));
  ok(!/findBusPids\(\)/.test(waitBlock),
    '等待循环里不再重新调 findBusPids() —— 那问的是另一个问题',
    waitBlock.trim().slice(0, 120));
  ok(/发过 SIGTERM 的进程/.test(stopSrc),
    '报告措辞说明白了「仍在」的是我发过信号的那些');
  ok(/other_bus_running/.test(stopSrc),
    '「又冒出一个别的 bus」单独是一个 reason，不混进「没停干净」');

  // ⚠️ 这个脚本唯一做对的地方：等不到就停下来报，不升级 SIGKILL。别改掉。
  ok(/没有升级到 SIGKILL/.test(stopSrc),
    '「不自动升级 SIGKILL」保留 —— 强杀是个决策，不该由脚本替人做');
  ok(/ok: false, reason: 'still_running'/.test(stopSrc),
    '停不掉时返回失败而不是硬着头皮往下起');

  // ───────────────────────────────────────────────────────────────
  console.log('\n【5】★ portBusy 换判据：能不能 bind，不是应不应答 HTTP');

  // 只看 portBusy 的函数体 —— `fetchAgents()` 用 http.get 是对的，
  // 它问的就是「bus 这个端点回什么」。被换掉的只有端口占用判定。
  const pbStart = src.indexOf('async function portBusy()');
  const portBusySrc = src.slice(pbStart, src.indexOf('\n}\n', pbStart) + 3);
  ok(!/http\.get/.test(portBusySrc), 'portBusy 不再用 HTTP 探测端口占用',
    portBusySrc.trim().slice(0, 120));
  ok(/portRegistry\.probe/.test(portBusySrc), '改成注册表的真实 bind 试探');
  ok(/http\.get/.test(src.slice(src.indexOf('function fetchAgents'))),
    '而 fetchAgents 照旧用 HTTP —— 它问的就是 HTTP 端点，那不是代理指标');

  // 端到端：真占住一个端口，看 portBusy 怎么说
  const P = await new Promise((resolve) => {
    const s = net.createServer((sock) => sock.destroy());
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });

  const busyBefore = await withEnvPort(P, () => freshBusRestart().portBusy());
  ok(busyBefore === false, `空闲端口 ${P} → portBusy false`, `实际 ${busyBefore}`);

  // ★ 关键场景：占用者**不说 HTTP**。用 HTTP 探端口的实现在这里会说「没人应答」= 端口空着，
  //   然后去起 bus → EADDRINUSE。
  const silentHolder = net.createServer((sock) => sock.destroy());
  await new Promise((r) => silentHolder.listen(P, '127.0.0.1', r));

  const busyAfter = await withEnvPort(P, () => freshBusRestart().portBusy());
  ok(busyAfter === true,
    '被一个**不说 HTTP** 的进程占着 → portBusy true（旧实现在这里会说「空着」）',
    `实际 ${busyAfter}`);

  await new Promise((r) => silentHolder.close(r));
  const busyReleased = await withEnvPort(P, () => freshBusRestart().portBusy());
  ok(busyReleased === false, '放开之后 → false');

  // ───────────────────────────────────────────────────────────────
  console.log('\n【6】--status 不动任何东西（真跑一次子进程）');
  // 判据④：真调用，不是断言 argv 里有那个 flag。

  const before = countBusProcs();
  const r = spawnSync('node', [path.join(ROOT, 'bin', 'bus-restart.js'), '--status'],
    { encoding: 'utf8', cwd: ROOT, timeout: 40000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const after = countBusProcs();

  ok(after === before, `--status 跑完 bus 进程数没变（${before} → ${after}）`);
  ok(/端口 \d+: (被占用（绑不上）|空闲（能绑上）)/.test(out),
    '端口那行的措辞跟着新判据走（不再说「有人应答」）', out.slice(0, 300));
  ok(!/有人应答|没人应答/.test(out), '旧措辞已经不出现了', out.slice(0, 300));

  // ★ 第二个环境变体：端口上**没有** bus。
  //
  //   走的是 `fetchAgents()` 的连不上分支 —— **那正是 `http is not defined`
  //   会炸的另一处**。上面那次（bus 真在跑）走的是 200 分支，两条不同的路。
  //
  //   这个 bug 逃过了 `node --check`（只查语法不查标识符解析）和
  //   `test/load-all.js`（bin/ 下的入口不可 require）。**只有真跑能看见。**
  const emptyPort = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const r2 = spawnSync('node', [path.join(ROOT, 'bin', 'bus-restart.js'), '--status'],
    { encoding: 'utf8', cwd: ROOT, timeout: 40000,
      env: { ...process.env, ENGLOOP_PORT: String(emptyPort) } });
  const out2 = (r2.stdout || '') + (r2.stderr || '');

  ok(!/is not defined|ReferenceError/.test(out2),
    '★ 端口上没有 bus 时 --status 不崩（fetchAgents 的连不上分支真被走过）',
    out2.slice(0, 300));
  ok(/空闲（能绑上）/.test(out2), '并且如实报告端口空闲', out2.slice(0, 300));
  ok(/连不上|超过 \d+ms 没应答/.test(out2),
    '并且说清 /api/agents 连不上 —— 而不是假装拿到了数据', out2.slice(0, 300));
  ok(countBusProcs() === before, '这一次也没动任何进程');

  // ───────────────────────────────────────────────────────────────
  console.log('\n【6b】stop() 的「没有在跑的 bus」分支 —— 用测试缝真跑一次');

  // ★ 先钉住默认行为：`psOutput` 是为了可测才加的入参，
  //   **不传时必须仍然真去查 ps**。否则这条缝会变成一条静默旁路 ——
  //   一个「为了可测」的参数把生产路径改成了别的东西，那比没测更坏。
  const realPids = br.findBusPids();
  ok(Array.isArray(realPids) && realPids.length >= 1,
    '★ 不传 psOutput 时仍然真去查 ps（此刻真 bus 在跑，找得到）',
    JSON.stringify(realPids));
  ok(realPids.every(br.pidAlive), '并且找出来的 PID 都真的存在');

  // 缝本身：喂空输入 → 走「没有在跑的 bus」那条分支
  ok(br.findBusPids({ psOutput: '' }).length === 0, '喂空 ps 输出 → 找不到 bus');

  // (a) 端口空闲 → 该干净地返回成功
  const freePort = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const stopA = await withEnvPort(freePort, () =>
    freshBusRestart().stop({ psOutput: '' }));
  ok(stopA.ok === true, '没有 bus + 端口空闲 → ok（这条路径真被执行了）',
    JSON.stringify(stopA));
  ok(Array.isArray(stopA.killed) && stopA.killed.length === 0, '并且没杀任何东西');

  // (b) 端口被别的东西占着 → **不能报「已经停好了」**
  const squatter = net.createServer((sock) => sock.destroy());
  await new Promise((r) => squatter.listen(freePort, '127.0.0.1', r));
  const stopB = await withEnvPort(freePort, () =>
    freshBusRestart().stop({ psOutput: '' }));
  ok(stopB.ok === false && stopB.reason === 'port_held_by_other',
    '★ 没有 bus 进程但端口被占 → port_held_by_other，不是「已经停好了」',
    JSON.stringify(stopB));
  await new Promise((r) => squatter.close(r));

  ok(countBusProcs() === before, '【6b】全程没动任何进程');

  // ⚠️ **仍然未覆盖，照实标**（判据⑤）：上面覆盖的是「没有 bus 可停」那条分支。
  //    **「真的杀掉一个 bus」那条路径在生产环境下依然验不了** —— findBusPids
  //    按 `node */bin/serve.js` 匹配，真 bus 就长这个形状，任何真触发 SIGTERM
  //    的测试都会连它一起杀。多覆盖了一半，不等于覆盖了。
  console.log('  ⓘ **仍未覆盖**：`stop()` 里「真发 SIGTERM 并回查」那一段，');
  console.log('    以及 `start()` / 默认重启。生产环境下跑它们会动真 bus。');

  // ───────────────────────────────────────────────────────────────
  console.log('\n【8】★★ launchd 托管：「停掉再起」这个模型在这里是错的');
  // ── launchd 托管 ─────────────────────────────────────────────────
  // bus 由 launchd 托管时（`KeepAlive=true` + `ThrottleInterval=10`）：
  // SIGTERM 之后 launchd 在 10 秒内自己拉起一个新的 → `stop()` 报成功 →
  // `start()` 再起一个 → **EADDRINUSE**。
  //
  // ★ 这时脚本要判对：它查到一个自己没杀过的 bus，报
  //   「这不是没停干净，是**又有一个**」然后拒绝继续 ——
  //   不把陌生进程当成自己的失败。
  {
    // ★ `run` 注入点：三条分支都能真跑到，**而且没有任何副作用**。
    const fakeLc = (spec) => (args) => {
      const key = args.join(' ');
      if (spec[key] === undefined) throw new Error(`fake launchctl: 没配 ${key}`);
      if (spec[key] instanceof Error) throw spec[key];
      return spec[key];
    };

    const managed = br.launchdStatus({
      run: fakeLc({ [`print ${br.LAUNCHD_TARGET()}`]: 'state = running\n' }),
    });
    ok(managed.managed === true, '★ launchctl print 成功 → 判为托管中');

    // 「没这个服务」→ 确实不是托管的（launchctl 本身是好的）
    const notFound = new Error('Could not find service "com.x" in domain');
    const unmanaged = br.launchdStatus({
      run: fakeLc({ [`print ${br.LAUNCHD_TARGET()}`]: notFound }),
    });
    ok(unmanaged.managed === false && !unmanaged.error,
      '★ launchctl 说「没这个服务」→ 判为未托管（那是个确定的答案）',
      JSON.stringify(unmanaged));

    // ★★ launchctl 本身跑不了 → **不知道**，不是「未托管」
    const noBinary = new Error('spawnSync launchctl ENOENT');
    const unknown = br.launchdStatus({
      run: fakeLc({ [`print ${br.LAUNCHD_TARGET()}`]: noBinary }),
    });
    ok(unknown.error === 'launchctl_unavailable',
      '★★ launchctl 跑不了 → error，**不是 managed:false**',
      JSON.stringify(unknown));
    ok(unknown.managed === undefined,
      '★★ 而且**没有** managed 字段 —— 一个 false 会被下游读成「确定不是托管的」，'
      + '然后走 stop+start 撞端口。**「查不了 ≠ 没有」，这个文件里第四处。**',
      JSON.stringify(unknown));

    // ★ 真环境的答案（这台机器上 bus 确实是 launchd 起的）——
    //   阳性对照：假 launchctl 全绿而真环境判错的话，上面几条毫无意义。
    const real = br.launchdStatus();
    ok(real.error === undefined,
      '★ 真 launchctl 跑得起来（否则下面那条无从判断）', JSON.stringify(real));
  }

  console.log('\n【8b】★★ launchd 下 `--stop` 必须拒绝执行');
  // ── ⚠️ 为什么这里是**静态断言**，而不是真跑 `--stop` ─────────────────
  //
  //   真跑的话，一旦实现有 bug（没拒绝），测试**会杀掉真的 bus** ——
  //   而 bus 一停，所有 agent 的 relay 就停了。
  //   **用「被测行为正确」来保证测试安全，是循环论证。**
  //
  //   在别的机器上更糟：那里 launchd 可能没这个服务 → `managed:false` →
  //   **真的走 stop()**。一条在本机安全、在 CI 上杀生产的测试，比没有更坏。
  //
  //   所以这里守的是**顺序**：`lc.managed` 的检查必须在 `await stop()` 之前。
  {
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const mainBody = code.slice(code.indexOf('async function main()'));
    ok(mainBody.length > 200, '（前置）切到了 main() 的函数体');

    const iStopFlag = mainBody.indexOf("flag === '--stop'");
    const iManaged = mainBody.indexOf('lc.managed', iStopFlag);
    const iStopCall = mainBody.indexOf('await stop()', iStopFlag);
    ok(iStopFlag > 0 && iManaged > 0 && iStopCall > 0,
      '（前置）三个位置都找到了', `flag=${iStopFlag} managed=${iManaged} stop=${iStopCall}`);
    ok(iManaged < iStopCall,
      '★★ `--stop` 分支里，托管判断在 `await stop()` **之前** —— '
      + '反过来的话 SIGTERM 先发出去了，而 KeepAlive 10 秒后把它拉回来，'
      + '**人会以为停掉了而它还在**',
      `managed=${iManaged} stop=${iStopCall}`);

    ok(/bootout/.test(mainBody),
      '★★ 拒绝时给出真出口（`launchctl bootout`）—— 说清「停不了」还要说「那怎么停」');
    ok(/bootstrap/.test(mainBody),
      '★★ 并说清怎么起回来 —— bootout 会**一直停着**，只说前半句会把人卡在停止状态');

    // ★★ 默认重启路径：托管时走 kickstart，**而且不能先 stop()**
    const iDefaultManaged = mainBody.lastIndexOf('lc.managed');
    const iKick = mainBody.indexOf('kickstart(');
    ok(iKick > 0 && iDefaultManaged < iKick,
      '★★ 默认路径也先判托管再 kickstart', `managed=${iDefaultManaged} kick=${iKick}`);
    ok(mainBody.indexOf('await stop()', iKick) === -1
       || mainBody.indexOf('return', iKick) < mainBody.indexOf('await stop()', iKick),
      '★★ kickstart 那条路**不经过 stop()** —— 先 stop 正是撞端口的那条路');

    // ★ 就绪判据只有一份：两条起法都走 waitReady()
    ok(/return waitReady\(\)/.test(code) && (code.match(/waitReady\(\)/g) || []).length >= 3,
      '★★ `start()` 和 `kickstart()` 共用 `waitReady()` —— '
      + '两份平行的就绪判定此刻行为一致，分叉那天也不会有任何东西变红',
      (code.match(/.*waitReady.*/g) || []).join(' | '));
  }

  console.log('\n【8c】★ --status 报出托管方式（它决定了重启该怎么做）');
  {
    // `--status` 是只读的，可以真跑。
    // ── 🔴 下面那条「没动任何进程」必须是**前后对照**，不是一元判断 ─────────
    //   断言「进程数 **>= 0**」的话 —— 进程数永远 >= 0 ⇒ **整条恒真**，
    //   它一个进程都没验，而它顶着「没动任何进程」这句话。
    //   ★ 而那正是最坏的一种：**它占住了那个位置**，于是没人会再来加一条真的。
    //   🔴 根子在措辞上：**「没动」是一个前后对照的说法**，
    //     恒真的写法**连一个「前」都没取** —— 它把一个二元关系写成了一元判断。
    //   📌 扫 `test/` 下的 `ok(` 调用点找这类恒真时，必须先剥注释，
    //     否则数的是「在谈论它」的。
    const nBefore = countBusProcs();
    const r = spawnSync('node', [path.join(ROOT, 'bin', 'bus-restart.js'), '--status'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    const out = (r.stdout || '') + (r.stderr || '');
    ok(/launchd:/.test(out), '★ 输出里有 launchd 那一行', out.slice(0, 300));
    ok(/托管中|未托管|查不了/.test(out),
      '★★ 三种状态都说得出来 —— 尤其「查不了」，它跟另外两个不是一回事',
      out.slice(0, 300));
    const nAfter = countBusProcs();
    ok(nAfter === nBefore,
      `★ --status 没动任何进程：前 ${nBefore} → 后 ${nAfter}`
      + ' —— 而这是**前后对照**，不是「>= 0」那种恒真的写法',
      `${nBefore} → ${nAfter}`);
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【7】9969 收敛到注册表');
  const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok(!/9969/.test(stripJs(src)), 'bin/bus-restart.js 的代码里没有硬编码的 9969',
    (stripJs(src).match(/.*9969.*/) || [''])[0].trim());

  reachedEnd = true;
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

/** 数一下现在有几个 bus 进程 —— 用被测模块自己的 findBusPids。 */
function countBusProcs() {
  try { return br.findBusPids().length; }
  catch (e) { return -1; }
}

/** 换 ENGLOOP_PORT 跑一段，跑完还原。 */
async function withEnvPort(port, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'ENGLOOP_PORT');
  const old = process.env.ENGLOOP_PORT;
  process.env.ENGLOOP_PORT = String(port);
  try { return await fn(); }
  finally {
    if (had) process.env.ENGLOOP_PORT = old;
    else delete process.env.ENGLOOP_PORT;
  }
}

/**
 * 重新加载 bus-restart，让它按当前的 ENGLOOP_PORT 解析端口。
 * （模块顶层的 `resolve('bus')` 只在加载时跑一次。）
 */
function freshBusRestart() {
  delete require.cache[require.resolve('../bin/bus-restart')];
  delete require.cache[require.resolve('../bin/port-registry')];
  return require('../bin/bus-restart');
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
