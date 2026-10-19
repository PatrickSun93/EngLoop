#!/usr/bin/env node
'use strict';

/**
 * 安全地重启 bus。
 *
 * ── 为什么需要一个脚本，而不是「kill 一下再起一下」──────────────────
 * 手工重启 bus 有三种静默失败：
 *   · 用 nohup 直接起 → PATH 里没有 tmux → `tmux.list()` 静默返回空 →
 *     watchdog 全空，**而「没有异常」和「看不见异常」长得一模一样**
 *   · 重启失败（EADDRINUSE），**而 `/api/health` 照常响应**（旧进程还在答）——
 *     **一个崩溃的 bus 和一个健康的 bus，从外面看一模一样**
 *   · 旧进程没收干净，新进程起不来，人以为起来了
 *
 * 所以这个脚本的价值不在「少敲几个字」，在于**每一步都不轻信**：
 *   停了 → **回查进程和端口**，不信 kill 的返回值（kill 的返回值有二义）
 *   起了 → **主动查一个数字**（`sessions_seen`），不看「有没有报错」
 *
 * ⚠️ 起 bus 走 `bin/serve.sh`，**不在这里自己找 node** ——
 *   那个脚本已经解决过「launchd 不加载 profile → nvm 的 node 找不到」，
 *   再写一份就是第二份实现，而两份分叉了也不会有任何东西变红。
 *
 * ⚠️ **停不掉就停下来报，不升级到 SIGKILL。**
 *   「等不下去了就强杀」是个决策，不该由脚本替人做 ——
 *   `lib/shutdown.js` 那整套「回查 + 区分 graceful/timeout」存在的理由，
 *   就是这两件事必须分开记。
 *
 * ⚠️ **bus 由 launchd 托管时，「停掉再起」这个模型本身是错的**
 *   （`KeepAlive=true`，SIGTERM 后 10 秒它自己回来）。
 *   那时走 `launchctl kickstart -k`，见下面 launchd 那一节。
 *
 * 用法:
 *   node bin/bus-restart.js            重启（自动选 kickstart 还是停+起）
 *   node bin/bus-restart.js --status   只查现状，不动任何东西
 *   node bin/bus-restart.js --stop     只停，不起（launchd 托管时会拒绝，见下）
 */

const path = require('node:path');
// `fetchAgents()` 仍然要说 HTTP —— 它问的就是「bus 的这个端点回什么」，
// 那是它该问的问题。**被换掉的是 `portBusy()`**：判断端口占用不能用
// HTTP 应答当代理指标（见下面 portBusy 的说明）。
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const portRegistry = require('./port-registry');
// `/api/agents` 要凭据 —— 用 bus 每次启动写出的 admin token。
const auth = require('../lib/auth');

const ROOT = path.join(__dirname, '..');
const SERVE_SH = path.join(ROOT, 'bin', 'serve.sh');

// 端口来自注册表，不在这里再写一份 `ENGLOOP_PORT || 9969`。
const BUS = portRegistry.resolve('bus');
const PORT = BUS.port;

// 停之后等它退出的上限。bus 自己的 SIGTERM 处理里有 3 秒兜底 exit，
// 留一倍余量 —— 超过这个还没退，说明它卡在了别的地方，那是要报给人的事实。
const STOP_WAIT_MS = 8000;
// 起之后等它就绪的上限。要等 express listen + redis 连上 + relay 挂上。
const START_WAIT_MS = 20000;
const POLL_MS = 400;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 一个 PID 还在吗。**信号 0 是直接试法** —— 不查 ps、不查 pid 文件。
 *
 * ★ `EPERM` 要当成「在」：那表示进程存在，只是没权限给它发信号。
 *   把它读成「不在」会让停止流程以为已经停好了，然后去起新的。
 *   **不确定的时候，往「它还在」那边错。**
 */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; }
}

/**
 * 从 `ps` 的输出里挑出 bus 进程。**抽成纯函数是为了能拿构造的输入测它。**
 *
 * ── 这里为什么要这么严 ──────────────────────────────────────────
 * 宽松的写法是「行里含 `bin/serve.js` 且行首是数字」。它有两个漏法：
 *
 *   ① **`ps` 的输出不是每行一条记录。** 一个进程的命令行里可以含换行符，
 *      `ps` 原样打出来，于是一条记录被拆成几行 —— 那些续行不是记录，
 *      **它们只是碰巧以数字开头的文本**。agent 进程的 argv 里常塞着
 *      长 prompt。
 *
 *   ② **「命令行里提到 `bin/serve.js`」不等于「它是 bin/serve.js」。**
 *      任何一个参数里带这个字符串的进程都会被认成 bus。
 *
 * 所以现在要求：行首解析出 PID + 命令的**第一个 token 是 node** +
 * `bin/serve.js` 作为**参数**出现 + **这个 PID 真的存在**。
 *
 * ⚠️ 「发信号给 A，验证时说 B 仍在」这类症状不靠这里消灭：
 *   以上两条漏法是**推断，不是已证实的根因**。消灭那个症状的是 `stop()`
 *   的写法：**验证的对象就是发过信号的那批 PID**，不再重新问一次
 *   「现在有哪些 bus」。那条不依赖这里的推断对不对。
 */
function parsePsOutput(text) {
  const pids = [];
  for (const line of String(text).split('\n')) {
    // ★ 记录行的形状：行首(可选空白) + PID + 空白 + 命令。
    //   续行不满足这个形状 —— 除非它自己也长得像一条记录，而那还要
    //   同时通过下面两道检查。
    const m = line.match(/^\s*(\d+)\s+(\S.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];

    const tokens = cmd.split(/\s+/);

    // 第一个 token 必须是 node 本身，不是「参数里提到 node」
    if (!/(^|\/)node$/.test(tokens[0])) continue;

    // ★ `bin/serve.js` 必须出现在**脚本位置**上，不是命令行里的某处。
    //
    //   「行里含 bin/serve.js」这个条件太松：`node .../claude --prompt
    //   去看一下 bin/serve.js 里怎么写的` 会被认成 bus —— 而 agent
    //   就是 argv 里塞着长 prompt 的 node 进程。**提到它 ≠ 是它。**
    //
    //   node 的调用形状是 `node [选项] 脚本 [参数]`，选项都以 `-` 开头，
    //   所以第一个不以 `-` 开头的 token 就是脚本路径。
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) i++;
    const script = tokens[i];
    if (!script) continue;
    if (!/(^|\/)bin\/serve\.js$/.test(script)) continue;
    if (/bus-restart/.test(script)) continue;

    pids.push(pid);
  }
  return pids;
}

/**
 * 找 bus 进程。**按命令行特征找，不用 pid 文件** —— pid 文件会过期、会撒谎。
 *
 * ── `psOutput` 这个入参是干什么的 ──────────────────────────────
 * 它是**测试缝**，只为了让 `stop()` 的「没有在跑的 bus」那条分支能被真跑到。
 *
 * 为什么需要缝：`--stop` 和默认重启这两条命令路径**在生产环境下没法端到端
 * 测** —— 这里按「node + bin/serve.js」匹配，而真 bus 就长这个形状，
 * 任何触发 `--stop` 的测试都会连真 bus 一起 SIGTERM。造个假靶子也没用，
 * 那只会**多**杀一个。而一条从没被跑过的分支，坏了也没人知道
 * （比如漏了一个 require，跑到才抛 `http is not defined`）。
 *
 * ⚠️ **只传空字符串。** 传一个含 PID 的假 ps 输出，`stop()` 会**真的给那些
 *   PID 发 SIGTERM** —— 这个缝不隔离副作用，它只是换掉了输入。
 *
 * ⚠️ 不传时就是真去查 ps。测试里有一条断言钉着这点：
 *   一个「为了可测」的入参，绝不能变成一条静默旁路。
 */
function findBusPids({ psOutput } = {}) {
  let out = '';
  if (psOutput !== undefined) {
    out = psOutput;
  } else {
    try {
      // maxBuffer 给足：ps 输出可以很大（agent 的 argv 很长），
      // 超了会抛 ENOBUFS —— 那会被下面读成「查不了」，而不是「没有进程」。
      out = execFileSync('ps', ['-eo', 'pid,command'], {
        encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      // ★ 查不了 ≠ 没有（跟 tmux.list() 同一个形状）。
      throw Object.assign(new Error(`查不到进程列表：${err.message}`), { code: 'PS_FAILED' });
    }
  }
  // ★ 再验一道：解析出来的 PID 必须真的存在。
  //   ps 的文本是一个**代理**，`kill(pid,0)` 是直接试法。
  return parsePsOutput(out).filter(pidAlive);
}

/**
 * 端口还占着吗。**跟进程检查是两个独立的事实** —— 进程没了但端口没放开是真实情况。
 *
 * ── ★ 判据是「新进程能不能 listen 成功」，不是「有没有人应答 HTTP」──
 *
 * 发一个 HTTP GET `/api/health`、能应答就算占着 —— 那问的是
 * **一个代理指标**，跟 `lsof` 同族，两个漏法都是真的：
 *
 *   ① 端口被**不说 HTTP** 的东西占着，或被一个 socket 还在 listen 但
 *      已经不应答的进程占着 → 判成没占 → `stop()` 打印
 *      「✓ 端口已放开」→ `start()` 起 serve.sh → **EADDRINUSE**。
 *   ② 端口上有**别的** HTTP 服务应答 → 误判成「bus 还活着」。
 *
 * 所以直接去 bind 一次（`bin/port-registry.js` 的 `probe()`），
 * 用的 host/port 跟 bus 真正启动时**完全相同**。
 *
 * ★ fail-closed：探测没查出结果（超时、异常）时**当作还占着**。
 *   报「已放开」然后去起新的，会 EADDRINUSE 并把现场搅浑；
 *   报「还占着」最多是多等一轮，而那是人能看懂的状态。
 */
async function portBusy() {
  const r = await portRegistry.probe(BUS);
  return !r.available;
}

/**
 * 拿 /api/agents 的响应体。**起没起来的判据在这里，不在「有没有报错」。**
 *
 * ⚠️ 超时给得宽（15s）：这个端点可能要好几秒 —— 它要 spawn tmux、扫花名册、
 *   逐个查 XINFO。超时太紧（比如 2s）会报「连不上」而 bus 明明活着 ——
 *   一个太紧的超时会把「慢」说成「死了」，那正是这个脚本要消灭的那类误报。
 *
 * 顺带把耗时带出来：**好几秒对一个「一眼看出失聪」的端点是不正常的**，
 * 而页面每 5 秒轮询一次 —— 响应比轮询间隔还长，会堆积。
 */
function fetchAgents(timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // ★ 每次现读 token：重启后新 bus 会换一个。读不到 ⇒ 不发请求、如实说「没钥匙」，
    //   不降级成不带凭据去问 —— 那样拿回的 401 会被读成「bus 不对」。
    //   （刚重启那一瞬间新 token 还没写出来 ⇒ 这一轮算「没就绪」，waitReady 会接着等。）
    let token;
    try { token = auth.readAdminToken(); } catch (e) {
      resolve({ status: 0, error: e.message.split('\n')[0], ms: 0 });
      return;
    }
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/agents', timeout: timeoutMs,
        headers: { authorization: `Bearer ${token}` } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          const ms = Date.now() - t0;
          try { resolve({ status: res.statusCode, json: JSON.parse(body), ms }); }
          catch (_) { resolve({ status: res.statusCode, json: null, ms, raw: body.slice(0, 200) }); }
        });
      });
    req.on('error', (e) => resolve({ status: 0, error: e.message, ms: Date.now() - t0 }));
    req.on('timeout', () => {
      req.destroy();
      // ★ 说「超时」而不是「连不上」—— 两者要区分：一个是慢，一个是没人在
      resolve({ status: 0, error: `超过 ${timeoutMs}ms 没应答`, ms: Date.now() - t0 });
    });
  });
}

// ── launchd 托管 ─────────────────────────────────────────────────
//
// bus 由 launchd 托管：`KeepAlive=true` + `ThrottleInterval=10`。
// **SIGTERM 之后 launchd 会在 10 秒内自己拉起一个新的。**
//
// 于是「停掉再起」这个模型在这里是**错的**：`stop()` 报成功，
// 10 秒后 launchd 起了一个，`start()` 再起一个 → EADDRINUSE。
//
// ★ 即使不认识 launchd，`stop()` 也会兜住这种情况：它在停完之后
//   查到一个自己没杀过的 bus 进程，报「这不是没停干净，是**又有一个**」
//   然后拒绝继续 —— 不把一个陌生的进程当成自己的失败。
//
// 正确动作是 `launchctl kickstart -k`：原子地停+起，launchd 自己管顺序。
//
// ★ label 的唯一出处是 bin/launchd.js（`ENGLOOP_LAUNCHD_LABEL` 覆盖也在那里），
//   不在这里或 stop.sh 里再写一份。
const launchd = require('./launchd');
const LAUNCHD_LABEL = launchd.LABEL;
const LAUNCHD_TARGET = () => `gui/${process.getuid()}/${LAUNCHD_LABEL}`;

/**
 * bus 是不是 launchd 托管的。
 *
 * @returns {{managed:boolean}|{error:string, detail:string}}
 *
 * ★★ **查不了要返回 error，不许猜「不是」。**
 *   猜「不是」会走 stop+start 那条路 —— 而如果它**其实是**托管的，
 *   SIGTERM 之后 launchd 会拉起一个，脚本再起一个，撞端口。
 *   **这个脚本的整个精神就是「查不了 ≠ 没有」，这里不能破例。**
 */
function launchdStatus({ run = null } = {}) {
  const exec = run || ((args) => execFileSync('launchctl', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  }));
  try {
    exec(['print', LAUNCHD_TARGET()]);
    return { managed: true, label: LAUNCHD_LABEL, target: LAUNCHD_TARGET() };
  } catch (err) {
    // ★ 区分两种失败，**它们的含义完全相反**：
    //   · launchctl 跑得起来但说「没这个服务」→ 确实不是托管的（正常路径）
    //   · launchctl 本身跑不了（没装/不在 PATH/超时）→ **不知道**
    const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    if (/Could not find service|No such process|not find/i.test(out)) {
      return { managed: false, label: LAUNCHD_LABEL };
    }
    return {
      error: 'launchctl_unavailable',
      detail: String(err.message || err).slice(0, 200),
      label: LAUNCHD_LABEL,
    };
  }
}

/**
 * launchd 下的重启。**不停不起，让 launchd 原子地做。**
 *
 * ⚠️ 不要在这之前先 `stop()` —— 那正是撞端口的那条路。
 */
async function kickstart({ run = null } = {}) {
  const target = LAUNCHD_TARGET();
  console.log(`launchd 托管，用 kickstart 重启: ${target}`);
  try {
    const exec = run || ((args) => execFileSync('launchctl', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
    }));
    exec(['kickstart', '-k', target]);
  } catch (err) {
    console.error(`✗ kickstart 失败: ${err.message}`);
    console.error(`  手动试一次看它说什么: launchctl kickstart -k ${target}`);
    return { ok: false, reason: 'kickstart_failed' };
  }
  // ★ 就绪判据跟自己 spawn 那条路**完全相同** —— 同一个 waitReady()。
  //   「launchctl 没报错」不等于「bus 起来了」，跟「spawn 没报错」一样不算数。
  return waitReady();
}

async function status() {
  const pids = findBusPids();
  const busy = await portBusy();
  const agents = await fetchAgents();
  console.log(`进程: ${pids.length ? pids.join(', ') : '（没有）'}`);
  // 措辞跟着判据走：现在问的是「绑不绑得上」，不是「应不应答」
  console.log(`端口 ${PORT}: ${busy ? '被占用（绑不上）' : '空闲（能绑上）'}`);

  // ★ 托管方式决定了**重启该怎么做**，所以它属于「现状」的一部分。
  const lc = launchdStatus();
  if (lc.error) {
    console.log(`launchd: 查不了（${lc.detail}）—— **这不是「不是托管的」**，`
      + '是不知道。重启前先弄清楚，否则可能撞端口。');
  } else if (lc.managed) {
    console.log(`launchd: 托管中（${lc.label}）—— 重启走 kickstart，`
      + '**别手动 kill**（KeepAlive 会跟你抢）');
  } else {
    console.log(`launchd: 未托管 —— 重启走「停掉再起」`);
  }
  if (agents.status === 200 && agents.json) {
    const n = agents.json.sessions_seen;
    console.log(`/api/agents: 200 · ${agents.ms}ms · sessions_seen=${n}`
      + (n === 0 ? '  ⚠ 零会话 —— 至少 orch 该在，多半是 bus 看不见 tmux' : ''));
    // 页面每 5 秒轮询一次这个端点。响应比轮询间隔还长 = 请求会堆积。
    if (agents.ms > 5000) {
      console.log(`  ⚠ ${agents.ms}ms 比页面的 5 秒轮询间隔还长 —— 请求会堆积`);
    }
  } else if (agents.status === 503) {
    console.log(`/api/agents: 503 ${agents.json && agents.json.error} —— bus 活着但查不了 tmux`);
  } else if (agents.status === 401) {
    console.log('/api/agents: 401 —— bus 活着，但不认 temp/bus-admin.token 里的 token：'
      + '跑着的 bus 不是写这个文件的那个（别处起的 / 隔离测试 bus 写错了路径）');
  } else if (agents.status === 404) {
    console.log('/api/agents: 404 —— 这个路由在跑着的进程里不存在，**它是旧代码**');
  } else {
    console.log(`/api/agents: ${agents.status || '连不上'} ${agents.error || ''}`);
  }
  return { pids, busy, agents };
}

async function stop(opts = {}) {
  const pids = findBusPids(opts);
  if (pids.length === 0) {
    console.log('没有在跑的 bus');
    // 端口仍要查 —— 进程没了但端口占着是真实情况，而且它会让下一步起不来
    if (await portBusy()) {
      console.error(`✗ 没找到 bus 进程，但端口 ${PORT} 仍绑不上 —— 别的东西占着它。`);
      console.error('  这不是「已经停好了」。查清楚是谁再继续。');
      return { ok: false, reason: 'port_held_by_other' };
    }
    return { ok: true, killed: [] };
  }

  console.log(`发 SIGTERM 给 ${pids.join(', ')}`);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); }
    catch (err) { console.error(`  发信号给 ${pid} 失败: ${err.message}`); }
  }

  // ★ 回查事实，**不信信号发出去了就等于停了**（kill 的返回值有二义）
  //
  // ★★ 但要回查**同一批 PID**。
  //
  //   在这里重新调 `findBusPids()`，问的是「现在还有没有 bus 进程」——
  //   那是**另一个问题**。会出现这种输出：
  //
  //       发 SIGTERM 给 A
  //       ✗ 等了 8000ms，进程 B 仍在。
  //
  //   发信号的对象和验证的对象是两个不同的 PID，而报告读起来像
  //   「杀的那个没死」。**两次独立快照之间，进程集合本来就会变。**
  //
  //   所以：记住发过信号的那批，只问「**这批**还在不在」，用 `kill(pid,0)`
  //   直接试。「有没有新的 bus 冒出来」是另一个事实，下面单独查、单独报。
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    await wait(POLL_MS);
    if (!pids.some(pidAlive)) break;
  }

  const left = pids.filter(pidAlive);
  if (left.length > 0) {
    console.error(`✗ 等了 ${STOP_WAIT_MS}ms，发过 SIGTERM 的进程 ${left.join(', ')} 仍在。`);
    console.error('  **没有升级到 SIGKILL** —— 强杀是个决策，不该由脚本替你做。');
    console.error(`  要强杀自己来: kill -9 ${left.join(' ')}`);
    return { ok: false, reason: 'still_running', pids: left };
  }

  // ★ 单独查：杀完之后，有没有**别的** bus 进程在（新起的，或者头一次
  //   快照时还没出现的）。这跟「杀的那些死了没」是两个事实，分开报，
  //   否则就会出现「发信号给 A、报告说 B 仍在」那种读不懂的输出。
  let others = [];
  try { others = findBusPids(opts); }
  catch (err) {
    console.error(`✗ 停完之后查不了进程列表：${err.message}`);
    console.error('  **查不了 ≠ 没有。** 不往下起新的。');
    return { ok: false, reason: 'ps_failed_after_stop' };
  }
  if (others.length > 0) {
    console.error(`✗ 我发信号的那批（${pids.join(', ')}）都停了，`
      + `但另有 bus 进程在: ${others.join(', ')}`);
    console.error('  这不是「没停干净」，是**又有一个**。查清楚它从哪来再继续。');
    return { ok: false, reason: 'other_bus_running', pids: others };
  }

  // 进程没了 ≠ 端口放开了。两个独立事实，分开查。
  if (await portBusy()) {
    console.error(`✗ 进程已退出，但端口 ${PORT} 仍绑不上。新的起不来（EADDRINUSE）。`);
    return { ok: false, reason: 'port_still_busy' };
  }

  console.log(`✓ 已停（${pids.join(', ')}），端口已放开`);
  return { ok: true, killed: pids };
}

/**
 * 等它就绪，并判断「起来了」到底算不算数。
 *
 * ★ 抽出来是因为**有两条起法**（自己 spawn / launchctl kickstart），
 *   而**就绪判据必须只有一份** —— 两份平行的判定此刻行为一致，
 *   分叉了也不会有任何东西变红，因为它们各自都「正常工作」。
 *   （这个仓库里 `classifySessions` 那段注释讲的是同一件事。）
 *
 * ★ 判据是 **`/api/agents` 返回 200 且能读到 sessions_seen**。
 *   不是「进程起来了」，也不是「没看到报错」——
 *   **一个崩溃的 bus 和一个健康的 bus，从外面看一模一样。**
 */
async function waitReady() {
  const deadline = Date.now() + START_WAIT_MS;
  let last = null;
  while (Date.now() < deadline) {
    await wait(POLL_MS);
    last = await fetchAgents();
    if (last.status === 200 && last.json) break;
    if (last.status === 503) break;   // 活着但查不了 tmux —— 也是个确定的答案
  }

  if (!last || (last.status !== 200 && last.status !== 503)) {
    console.error(`✗ ${START_WAIT_MS}ms 内没等到 /api/agents 应答（最后: `
      + `${last ? last.status || last.error : '无'}）`);
    console.error('  bus 可能没起来，也可能起来了但路由不存在（旧代码）。查日志。');
    return { ok: false };
  }

  if (last.status === 503) {
    console.error('⚠ bus 起来了，但它查不了 tmux（503 tmux_unavailable）。');
    console.error(`  ${last.json && last.json.hint || ''}`);
    console.error('  **这不是「没有 agent」，是「查不了」** —— watchdog 现在是瞎的。');
    return { ok: false, reason: 'tmux_unavailable' };
  }

  const n = last.json.sessions_seen;
  console.log(`✓ bus 已就绪 · sessions_seen=${n}`);
  if (n === 0) {
    // ★ 起来了但看不见任何会话 —— **零会话从来不是正常状态，至少 orch 该在。**
    console.error('⚠ 但它一个 tmux 会话都没枚举到。零会话在这个系统里不是正常状态');
    console.error('  （至少编排者的 orch 会话该在）。多半是 bus 看不见那些会话，');
    console.error('  **别把它读成「一切正常」** —— watchdog 这时不在检测任何 agent。');
    return { ok: false, reason: 'zero_sessions' };
  }
  const deaf = (last.json.deaf || []).length;
  const stale = (last.json.stale || []).length;
  const live = (last.json.live || []).length;
  console.log(`  live=${live} deaf=${deaf} stale=${stale}`);
  return { ok: true };
}

async function start() {
  console.log(`起 bus: ${SERVE_SH}`);
  // ★ 走 serve.sh —— node 路径的解析只有那一份实现。
  const child = spawn('/bin/bash', [SERVE_SH], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.unref();
  return waitReady();
}

async function main() {
  const flag = process.argv[2];

  if (flag === '--status') { await status(); return; }

  // ★ 托管方式先查 —— 它决定了下面每一条路该怎么走。
  const lc = launchdStatus();

  // ★★ 查不了就停下来，什么都不做。
  //   猜「不是托管的」会走 stop+start：SIGTERM 之后 launchd 拉起一个、
  //   脚本再起一个 → EADDRINUSE，而且现场被搅浑。
  //   **还是「查不了 ≠ 没有」。**
  if (lc.error) {
    console.error(`✗ 查不了 bus 是不是 launchd 托管的：${lc.detail}`);
    console.error('  **这不是「它不是托管的」，是「我不知道」** ——');
    console.error('  猜错的代价是撞端口：SIGTERM 之后 launchd 会自己拉起一个，');
    console.error('  我们再起一个就是 EADDRINUSE。什么都没做。');
    console.error(`  自己确认一下: launchctl print ${LAUNCHD_TARGET()}`);
    process.exitCode = 1;
    return;
  }

  if (flag === '--stop') {
    // ★★ launchd 下 `--stop` **做不到它承诺的事**，所以拒绝执行。
    //
    //   SIGTERM 之后 `KeepAlive=true` 会在 ThrottleInterval(10s) 内把它拉回来。
    //   真要停得用 `bootout`，**而那会一直停到有人 bootstrap 回来** ——
    //   那是个决策，不该由脚本替人做。
    //   **跟「不升级到 SIGKILL」是同一条规矩：能做和该做是两件事。**
    if (lc.managed) {
      console.error(`✗ bus 由 launchd 托管（${lc.label}），\`--stop\` 停不住它。`);
      console.error(`  SIGTERM 之后 KeepAlive 会在 10 秒内把它拉回来 ——`);
      console.error('  **你会以为停掉了，而它还在。**');
      console.error('  真要停下来（会一直停着，直到你手动起回来）:');
      console.error(`    launchctl bootout ${LAUNCHD_TARGET()}`);
      console.error('  起回来:');
      console.error(`    launchctl bootstrap gui/${process.getuid()} ${launchd.plistPath()}`);
      console.error('    （或者 ./start.sh —— plist 在就走 launchd）');
      console.error('  只是想重启的话，不带参数跑这个脚本就行。');
      process.exitCode = 1;
      return;
    }
    const r = await stop();
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  // ★★ launchd 下**不停不起**，让它原子地做。
  //   在这之前先 `stop()` 正是撞端口的那条路。
  if (lc.managed) {
    const r = await kickstart();
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  const s = await stop();
  if (!s.ok) {
    console.error('✗ 没停干净，不起新的 —— 起了也是 EADDRINUSE，而那会把现场搅浑。');
    process.exitCode = 1;
    return;
  }
  const r = await start();
  process.exitCode = r.ok ? 0 : 1;
}

// ⚠️ `require.main` 守卫不是样板 —— **没有它，任何 `require()` 这个文件的
//    动作都会真的去停 bus。** 测试要拿到 `parsePsOutput` 就必须 require 它。
if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    if (err.code === 'PS_FAILED') {
      console.error('  查不到进程列表 ≠ 没有 bus 在跑。什么都没做。');
    }
    process.exitCode = 1;
  });
}

module.exports = {
  parsePsOutput, pidAlive, findBusPids, portBusy, stop, start, status,
  // launchd 分支。`launchdStatus` 收 `run` 注入点，所以「查不了」那条
  // 分支能被真跑到 —— 它是三条里唯一一条**猜错会撞端口**的。
  launchdStatus, kickstart, waitReady, LAUNCHD_LABEL, LAUNCHD_TARGET,
};
