'use strict';

/**
 * 端到端：
 * 「人从浏览器发消息，编排者 ~2 秒内 ACK 并给出真实答复」
 *
 * 这里用脚本代替浏览器和大脑，验证的是**管道**本身：
 *
 *   WS 客户端 ──POST──▶ bus ──XADD──▶ orch:in:human
 *                                          │
 *                                    next.js 领取
 *                                          │
 *                              (模拟大脑) 写 outbox/*.json
 *                                          │
 *                                   relay ──XADD──▶ orch:out
 *                                          │
 *   WS 客户端 ◀──推送── bus ◀──XREADGROUP──┘
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件不能写成「orch 会话在跑 → 跳过」：
 *
 * **编排者是常驻进程** —— 那样的话最外层这一圈，在系统正常运行的状态下
 * **永远不会跑**。单元层再多断言全绿，唯一测「所有零件接起来能不能用」的是它。
 *
 * > **「跳过」和「通过」在汇总里都是非红 —— 那是「没跑的被当成跑过了」
 * >   换了个词。**（`run-all.js` 自己的注释）
 *
 * 现在它起**自己的一整套环境**，跟生产完全不碰：
 *
 *   redis db     测试库（q.allocTestDb()，跟本进程的 client 同一个）
 *   端口         19969
 *   outbox 根    临时目录       ★ 少了这条,测试写的假回复会被真 relay
 *                                 捡走并发给人 —— 有外部副作用,不只是测试脏
 *   tmux         no-op         ★★ 少了这条,这个 bus 的 watchdog 会枚举到
 *                                 真会话、判编排者失聪、**往它会话里打字**
 *   worker       关掉           不然一个测试 bus 会真的去跑 claude,烧额度
 *
 * ★ 只换 redis 和端口是不够的 ——
 *   **「隔离」这个词会让人以为它是一件事，实际上它是「所有出口都要堵」。**
 * ══════════════════════════════════════════════════════════════════
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const q = require('../lib/queue');
const auth = require('../lib/auth');

const PORT = 19969;                       // 生产是 9969，隔开
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const PROD_OUTBOX = path.join(ROOT, 'temp', 'outbox', 'JARVIS');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(deadlineMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch (_) { /* 还没起来 */ }
    await wait(200);
  }
  return false;
}

async function main() {
  console.log('\n端到端：人 → bus → 队列 → agent → relay → bus → 人\n');

  // ── 0. 起一套隔离环境 ────────────────────────────────────────────
  const testDb = q.allocTestDb();
  if (testDb === null) {
    console.log('  ✗ 拿不到测试库编号 —— 这个测试必须在测试库里跑，中止。');
    process.exit(1);
  }
  const testUrl = q.withDb(q.DEFAULTS.url, testDb);
  const outboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-e2e-outbox-'));
  const OUTBOX = path.join(outboxRoot, 'JARVIS');

  // ── ★★★ 生产 `temp/` 的快照：这一轮结束时要证明没往里写东西 ──────
  //
  //   要防的形状：这个测试的**隔离 bus** 把漏挂告警写进
  //   **真 JARVIS 的**状态文件（`temp/thread-alert-JARVIS.json`），
  //   它下一轮就会真收到那条假告警。
  //
  //   ⚠️ 为什么两层现成的防护接不住：`lib/thread-alert.js` 有
  //   `threadAlertDir` 参数和 `isTestProcess()` 默认值 —— 但 e2e 不是
  //   「测试脚本自己 require 那个模块」，它 **spawn 了一个 bus 子进程**，
  //   那个进程的入口就是 `bin/serve.js`。
  //   > **进程级判据天然覆盖不了「同一程序的隔离实例」。**
  //   ⇒ 所以它在 `serve.js` 的隔离表里（`ENGLOOP_THREAD_ALERT_DIR`）。
  //
  //   ★ 这里守的不是那一个文件，是**「隔离表又漏了一项」这件事本身**：
  //   每加一个往外写的东西都要回来登记一次，而**没有人会记得回来**。
  //   这条断言不需要谁记得 —— 它每次 e2e 都跑。
  //
  // ══════════════════════════════════════════════════════════════
  // ⚠️ **别顺手让 cleanup 把 `$TMPDIR/engloop-isolated-thread-alert/` 也删了。**
  //
  //   看到 tmpdir 里留了个目录，下一个人的第一反应一定是「这里漏清了」，
  //   最省事的修法是让这个测试**显式传 `ENGLOOP_THREAD_ALERT_DIR`**
  //   指到自己那个 mkdtemp 目录，cleanup 一起删 —— 干净、对称、看起来更好。
  //
  //   **那样会把这条路径测没。** 隔离 bus 之所以写对地方，靠的是
  //   `bin/serve.js` 里 `ISOLATED ? tmpdir : undefined` 那个**兜底**；
  //   一旦这里显式设了 env，兜底分支再也不会被执行到 ——
  //
  //   > **一条没有人走的兜底路径，等于不存在的兜底。**
  //   > 而它的失效方式恰好是：下一个加出口的人也没设 env，
  //   > 于是掉进兜底，**而兜底早就坏了，没有任何测试会红。**
  //
  //   ⇒ 取舍是明说的：**测得到兜底 > 目录干净**。
  //   代价只是 tmpdir 里几百字节（系统会清），收益是那条路径每次 e2e 都真跑一遍。
  // ══════════════════════════════════════════════════════════════
  const prodTemp = path.join(ROOT, 'temp');
  const snapProdTemp = () => {
    try {
      return new Set(fs.readdirSync(prodTemp)
        .filter((f) => /^(thread-alert|probe-state|waiting)-.*\.json$/.test(f)));
    } catch { return null; }   // 查不了 ≠ 没有。不许降级成「干净」。
  };
  const prodBefore = snapProdTemp();

  // ★ 起 bus 之前先把测试库里这几条流清干净。
  //
  //   ⚠️ 这不是洁癖：上一轮跑如果中途失败（比如链路断了），
  //   POST 进来的那条消息**领了但没 ack，滞留在 PEL 里**。下一轮
  //   `next.js` 会先领到那条残留，于是 `job_id` 对不上 —— 而失败信息
  //   看起来像「job_id 没贯通」，**指向一个完全不存在的 bug**。
  //
  //   > **一个测试的产物变成了另一个测试的前提。**
  //   （跟死信目录污染、跟花名册残留是同一族。）
  //
  //   ⚠️ 清的是**测试库**（testUrl 显式传进去，createClient 传了 url
  //   就完全听调用方的）。手滑清成 db 0 会清掉编排者正在等的队列。
  {
    const t = q.createClient(testUrl);
    try {
      await t.del('orch:in:human', 'orch:out', 'orch:in:agent', 'engloop:roster:JARVIS');
    } finally { t.quit(); }
  }

  // ── 鉴权：bus 没有用户表就拒绝启动 ⇒ 给它一份临时的。
  //   ⚠️ **故意不设 `ENGLOOP_ADMIN_TOKEN_FILE`** —— 跟上面 THREAD_ALERT_DIR 同一个理由：
  //   隔离 bus 的 token 落到 tmpdir 靠的是 serve.js 里 `ISOLATED ? tmpdir : …` 那个兜底，
  //   设了 env 那条兜底就再也没人走。下面有一条正向断言证明它真的写进了 tmpdir。
  const E2E_KEY = auth.newKey();
  const usersFile = path.join(outboxRoot, '..', `${path.basename(outboxRoot)}-users.json`);
  fs.writeFileSync(usersFile, JSON.stringify([
    { username: 'Patrick', key_sha256: auth.sha256(E2E_KEY), can_manage_workers: true },
  ]));
  const prodTokenFile = path.join(ROOT, 'temp', 'bus-admin.token');
  const prodTokenBefore = (() => { try { return fs.statSync(prodTokenFile).mtimeMs; } catch { return null; } })();

  const busLog = [];
  const bus = spawn('node', [path.join(ROOT, 'bin', 'serve.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ENGLOOP_ISOLATED: '1',
      ENGLOOP_PORT: String(PORT),
      ENGLOOP_REDIS_URL: testUrl,
      ENGLOOP_OUTBOX_ROOT: outboxRoot,
      ENGLOOP_WORKER_TYPES: '',        // 一个测试 bus 不该去烧 claude 额度
      ENGLOOP_USERS_FILE: usersFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bus.stdout.on('data', (d) => busLog.push(String(d)));
  bus.stderr.on('data', (d) => busLog.push(String(d)));

  // 隔离 bus 的 admin token 兜底路径（serve.js：`engloop-isolated-admin-<pid>.token`）
  const isolatedToken = path.join(os.tmpdir(), `engloop-isolated-admin-${bus.pid}.token`);
  const cleanup = () => {
    try { bus.kill('SIGTERM'); } catch (_) { /* 已经没了 */ }
    fs.rmSync(outboxRoot, { recursive: true, force: true });
    fs.rmSync(usersFile, { force: true });
    // ★ token 文件要删：它是一把（测试 bus 的）钥匙，不该留在 tmpdir 里。
    //   删它不影响「兜底被走过」—— 那条断言在删之前就判过了。
    fs.rmSync(isolatedToken, { force: true });
  };
  process.on('exit', cleanup);

  const healthy = await waitHealthy();
  ok(healthy, `隔离 bus 起来了（:${PORT}，db ${testDb}）`,
    busLog.join('').slice(-400));
  if (!healthy) { cleanup(); process.exit(1); }

  // ★ 正控：证明打的是自己起的那个 bus，不是生产那个。
  //   缺了这一步，**下面每一条都可能是在生产环境里绿的** ——
  //   而那种绿比红更坏。
  {
    const prodAlive = await fetch('http://127.0.0.1:9969/health')
      .then((r) => r.ok).catch(() => false);
    ok(PORT !== 9969, '★ 端口跟生产不同');
    console.log(`     （生产 bus ${prodAlive ? '在跑' : '没在跑'} —— `
      + `${prodAlive ? '所以隔离必须真的成立' : '这次没有对照，下面的库断言仍然有效'}）`);
  }

  // ── 0c. 登录：拿 session cookie，下面的 WS 和 POST 都带它
  ok(fs.existsSync(isolatedToken),
    '★ 隔离 bus 的 admin token 写进了 tmpdir 兜底路径（没设 ENGLOOP_ADMIN_TOKEN_FILE，兜底被真走了一次）',
    isolatedToken);
  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Patrick', key: E2E_KEY }),
  });
  const cookie = String(loginRes.headers.get('set-cookie') || '').split(';')[0];
  ok(loginRes.status === 200 && cookie.startsWith('engloop_session='), '登录拿到 session cookie',
    `${loginRes.status}`);

  // ── 1. WS 连上，准备接收
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const received = [];
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    setTimeout(() => rej(new Error('WS 连接超时')), 5000);
  });
  ws.on('message', (d) => received.push(JSON.parse(d.toString())));
  ok(true, 'WebSocket 已连接');

  // ── 2. POST 消息，必须立即 202（不挂起等回复）
  const MARK = `E2E-${Date.now()}`;      // 唯一标记，用来在两个库里找它
  const t0 = Date.now();
  const resp = await fetch(`${BASE}/api/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ from: 'Patrick', text: `看一下 shipflow 的构建 ${MARK}` }),
  });
  const ackMs = Date.now() - t0;
  const body = await resp.json();

  ok(resp.status === 202, `POST 返回 202（${ackMs}ms）`, `实际 ${resp.status}`);
  ok(!!body.job_id, '返回了 job_id');
  ok(ackMs < 500, `立即返回，没有挂起等回复（${ackMs}ms < 500ms）`);

  // ── 3. agent 侧：next.js 领取
  //   ⚠️ 必须把测试库传给它 —— 不传的话它连生产库，领不到这条，
  //     而且会**真的把生产队列里的消息领走**（那是编排者在等的）。
  //
  //   ⚠️ 它会在 stderr 上打一句「花名册里刚才没有你（JARVIS），已自动重建」——
  //     **那是预期的，不是故障**：测试库的花名册本来就是空的。
  //     那句话是 next.js 的掉册自愈在正常工作，只是它对着一个空库说的。
  //     （留着不消音：**消掉它就等于把一个真掉册也一起消掉了**。）
  //   🔴 不能**只传 `ENGLOOP_REDIS_URL`** —— 起 bus 时传的是四件套。
  //     只传一个的话，这个子进程的**存活探针**走生产 outbox ＋ 生产 state：
  //     它发一条署名 JARVIS 的探针，要是那一刻 JARVIS 正好掉册
  //     ⇒ relay 当它是人 ⇒ 推 `orch:out` ⇒ **进了用户的界面**，
  //     而 pending 记在生产状态里、**永远销不掉** ⇒ 告警报「可能已失聪」。
  //     （「半隔离比不隔离更坏」写在 `lib/probe.js` 的 statePath 头上。）
  //   ⇒ 两个都传：**outbox 决定探针写去哪，state 决定账记在哪** —— 缺一个就半隔离。
  const probeStateInIsolation = path.join(outboxRoot, 'probe-state-e2e.json');
  const raw = execFileSync('node', [path.join(ROOT, 'bin', 'next.js'), '--block', '3000'],
    {
      encoding: 'utf8',
      cwd: ROOT,
      env: {
        ...process.env,
        ENGLOOP_REDIS_URL: testUrl,
        ENGLOOP_OUTBOX_ROOT: outboxRoot,
        ENGLOOP_PROBE_STATE: probeStateInIsolation,
      },
    });

  // ── ★ 正向：**证明那个子进程的探针写进了隔离路径**（不是「生产没变」）──────
  //
  //   🔴 只验「生产 temp/ 没新增」是不够的，它有两种成因：
  //     · 隔离生效了                 · 探针**根本没发**
  //   而这一条只有一种成因 ⇒ ⇒ 它同时证明「隔离生效」和「那条路径真的跑了」。
  //
  //   ★ 而它每次都真的在测，理由是一个性质：隔离路径下 state 文件是**新建的**
  //     ⇒ `load()` 返回 null ⇒ `maybeSend(name, null, now)` 里 `last` 为 null
  //     ⇒ **一定发**（`RESEND_AFTER_MS` 那个 60 分钟冷却在这里天然不成立）。
  //   ⇒ 也就是说：**这条判据不会因为「刚好在冷却里」而悄悄变成恒真**。
  //     （在冷却里的实验不可能红，而它会给出一个绿。）
  ok(fs.existsSync(probeStateInIsolation),
    '★★ 子进程的探针状态写进了**隔离路径** —— 而不是生产 temp/',
    probeStateInIsolation);
  const polled = JSON.parse(raw);
  ok(Array.isArray(polled.messages) && polled.messages.length >= 1, 'next.js 领到消息');
  const msg = polled.messages.find((m) => m.job_id === body.job_id);
  ok(!!msg, 'job_id 从 HTTP 一路贯通到 agent');
  ok(Array.isArray(polled._orchestrator_instructions) && polled._orchestrator_instructions.length > 0,
    '指令被重新注入（人格靠它跨压缩存活）');

  // ── 4. 模拟大脑：写 outbox 文件（outbox 契约）
  const REPLY = `收到，正在看构建日志。${MARK}`;
  fs.mkdirSync(OUTBOX, { recursive: true });
  fs.writeFileSync(
    path.join(OUTBOX, `${Date.now()}.json`),
    JSON.stringify({ username: 'Patrick', text: REPLY }),
  );

  // ── 5. relay → orch:out → bus → WS
  //   ⚠️ 按内容找，不是「第一条 type=message」——
  //     隔离之后这个流里理论上只有这一条，但按标记找是**免费的确定性**，
  //     而「第一条」在任何共享场景下都会拿错。
  for (let i = 0; i < 40 && !received.some((m) => m.type === 'message' && String(m.text).includes(MARK)); i++) {
    await wait(150);
  }
  const back = received.find((m) => m.type === 'message' && String(m.text).includes(MARK));
  ok(!!back, 'WS 收到回复',
    JSON.stringify(received.map((m) => m.type)));
  ok(back?.text === REPLY, '回复内容正确');
  ok(back?.from === 'JARVIS', 'from 是编排者');

  // ── 6. ★★ 隔离验证：生产那边一点都没被碰到 ──────────────────────
  //
  //   这一节才是「能在编排者活着的时候跑」的**代价核对**。
  //   上面全绿只说明管道通了，**不说明它没顺手往生产里写东西**。
  console.log('\n  ── 隔离核对（生产侧应当毫无痕迹）──');
  {
    // 显式连 db 0 —— createClient 传了 url 就完全听调用方的（不走测试库改写）
    const prod = q.createClient(q.withDb(q.DEFAULTS.url, 0));
    try {
      const scan = async (stream) => {
        const rows = await prod.xrange(stream, '-', '+').catch(() => []);
        return rows.filter(([, f]) => f.join(' ').includes(MARK)).length;
      };
      const inProd = await scan('orch:in:human');
      const outProd = await scan('orch:out');

      // ★ 正控：先证明这个查询**能**在流里找到东西 —— 否则「0 条」
      //   既可能是「没污染」也可能是「根本没查对地方」，而两者同形。
      const probeId = await prod.xadd('e2e:isolation:probe', '*', 'text', MARK);
      const probeRows = await prod.xrange('e2e:isolation:probe', '-', '+');
      ok(probeRows.some(([, f]) => f.join(' ').includes(MARK)),
        '★ 正控：这个查询确实能在生产库的流里找到带标记的消息');
      await prod.del('e2e:isolation:probe');
      void probeId;

      ok(inProd === 0, '★★ 生产 orch:in:human 里**没有**这次的消息', `找到 ${inProd} 条`);
      ok(outProd === 0, '★★ 生产 orch:out 里**没有**这次的回复', `找到 ${outProd} 条`);
    } finally {
      prod.quit();
    }

    // ★ 生产 outbox 目录。**这条防的是回归，不是当前实现**：
    //   现在测试写的是临时目录，所以它在当前代码下不可能红。
    //   它守的是「有人把写入路径改回 `temp/outbox/JARVIS/`」——
    //   那一改，假回复就会被**真 relay** 捡走并发给人。
    //
    //   ⚠️ 变异（拿掉 ENGLOOP_OUTBOX_ROOT）时**这条是绿的** ——
    //   红的是链路那三条（relay 去监听生产目录了，没人捡测试写的文件）。
    //   **所以真正守住 ENGLOOP_OUTBOX_ROOT 的是链路断言，不是这一条。**
    //   两条各守一半，别把它们当成互相印证。
    const leaked = fs.existsSync(PROD_OUTBOX)
      ? fs.readdirSync(PROD_OUTBOX).filter((f) => {
        try { return fs.readFileSync(path.join(PROD_OUTBOX, f), 'utf8').includes(MARK); }
        catch (_) { return false; }   // relay 抢先删掉了 —— 那不是本测试写的
      })
      : [];
    ok(leaked.length === 0,
      '★★ 生产 outbox 目录里**没有**这次写的文件（否则会真发给人）',
      JSON.stringify(leaked));

    // ★ tmux 出口：隔离 bus 的 watchdog 不许碰真会话。
    //   它的 list() 是 no-op → 枚举到 0 个 → 走 zero_sessions 那档报一条，
    //   **而那正是它该做的**（那个环境里确实没有会话）。
    //   这里断言的是**没有任何一条恢复指令被推出去**。
    const pushed = busLog.join('').match(/已向.*发送恢复指令/g) || [];
    ok(pushed.length === 0,
      '★★ 隔离 bus 的 watchdog **没有**向任何真会话推恢复指令',
      JSON.stringify(pushed));

    // ★★ 源码断言配一条 —— 因为**这一条的变异测试不能跑**。
    //
    //   要证明「no-op 是必需的」，就得拿掉它跑一次，
    //   **而那一次会往真编排者的会话里打字** —— 那是拿一次真事故换一个数据点。
    //   （有些假说的验证成本高于它能省下的东西，
    //     那时候正确的动作是换一种守卫，不是硬验。）
    //
    //   所以这里用另一种守卫：**源码断言**。它抓的是「有人把这段删了」，
    //   而上面那条行为断言抓的是「它这一轮没推」。
    //   **两条抓的不是同一件事** —— 行为断言在 watchdog 恰好没触发时也会绿。
    const serveSrc = fs.readFileSync(path.join(ROOT, 'bin', 'serve.js'), 'utf8');
    ok(/ISOLATED\s*\?\s*\{\s*tmuxApi:/.test(serveSrc),
      '★★ serve.js 在隔离模式下确实把 tmuxApi 换掉了（源码断言，因为变异测试不能跑）');
    ok(/submit:\s*\(\)\s*=>\s*\{\}/.test(serveSrc),
      '★ 而那个 no-op 的 submit 确实是空的（不是转发到真 tmux）');
  }

  ws.close();

  // ★ 清掉这一轮在测试库里造的花名册条目（next.js 的掉册自愈建的，TTL 900s）。
  //   不清的话下一个拿到同一个库编号的测试会看到一个「已经在册的 JARVIS」——
  //   **一个测试的产物变成了另一个测试的前提**（跟死信目录污染同一族，
  //   只是载体从文件系统换成了 redis）。
  {
    const t = q.createClient(testUrl);
    try { await t.del('engloop:roster:JARVIS'); } finally { t.quit(); }
  }

  // ── ★★★ 隔离验收：这一轮有没有往生产 `temp/` 里写东西 ────────────────
  //
  //   ⚠️ 这一条**不是**「再检查一遍 cleanup 干净不干净」。它守的是
  //   **隔离表有没有又漏一项** —— 而漏项的表现永远是「某个真 agent 收到
  //   一条它修不了、也对不上号的东西」，那时人查的是 agent，不是这个测试。
  //
  //   ★ 判据是**新增**（跑前跑后比对），不是「目录里有没有这些文件」：
  //   真 agent 此刻也在跑，它们自己的状态文件本来就该在那儿。
  //   判成「不许存在」的话第一次就误报，而误报会诱使人放宽它。
  console.log('\n【隔离验收】这一轮没往生产 temp/ 写东西');
  {
    // ★ admin token 这个出口：生产那份不许被隔离 bus 改写。
    //   ⚠️ 生产 bus 没在跑时这个文件可能根本不存在（before = after = null）⇒ 那时这条**没有分辨力**，
    //   真正守它的是上面那条正向断言（token 写进了 tmpdir）。两条各守一半。
    const prodTokenAfter = (() => { try { return fs.statSync(prodTokenFile).mtimeMs; } catch { return null; } })();
    ok(prodTokenAfter === prodTokenBefore, '★ 生产 temp/bus-admin.token 没被隔离 bus 改写',
      `${prodTokenBefore} → ${prodTokenAfter}`);

    const prodAfter = snapProdTemp();
    if (prodBefore === null || prodAfter === null) {
      ok(false, '★ 查不了生产 temp/ —— **这不等于「没污染」**，请手动核对');
    } else {
      const added = [...prodAfter].filter((f) => !prodBefore.has(f));
      ok(added.length === 0,
        '★★★ 生产 temp/ 下没有新增 agent 状态文件（隔离表没漏项）',
        added.length ? `新增了：${added.join(', ')} —— 隔离表少了一项，见 serve.js 头部那张表` : '');
    }
  }

  cleanup();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.message); process.exit(1); });
