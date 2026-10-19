'use strict';

/**
 * 接线测试 —— 断言「这个调用真的发生了」，不是「这个函数返回值对不对」。
 *
 * ── 为什么需要一类新形状的测试 ──────────────────────────────────
 * 下面六种是同一个形状：**写了但没接线**：
 *   1. ack 有规则、没有入口
 *   2. heartbeat 写了函数、没人调用 → agent 活着却掉出花名册
 *   3. relay 只给成功路径记日志 → ack 静默失效时日志一片正常
 *   4. send 用白名单拼 payload → room_hash 被静默丢弃
 *   5. runPrint 收 allowedTools → 没有任何调用方传过它
 *   6. isolation 用 stdio:'ignore' → 子进程失败原因被原地丢掉
 *
 * 六种全部符合同一个特征：**单元测试能过，因为单测自己传了参数；
 * 没有任何东西断言真实调用方传了。** 单测对接线处天然是盲的。
 *
 * 所以这个文件里的每一条都必须满足：**如果那根线被悄悄摘掉，它会变红。**
 * 判据不是「函数行为对不对」，是「生产路径上它被走到了没有」。
 *
 * ⚠️ 这里跑的是真的 `bin/next.js` 子进程。它是 bin/ 下的入口，
 *    `isTestProcess()` 判它为**生产进程** —— 会连 db 0。所以必须用
 *    ENGLOOP_REDIS_URL 把它指到本进程分到的测试库，否则测试会去搅生产数据
 *    （而那正是 lib/queue.js 那套隔离要防的事）。
 * ────────────────────────────────────────────────────────────────
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const rooms = require('../lib/rooms');
const { startRelay } = require('../lib/relay');

const ROOT = path.join(__dirname, '..');
const NEXT_JS = path.join(ROOT, 'bin', 'next.js');
const AGENT = 'wiringtestcrew';
const STREAM = `agent:${AGENT}:in`;
const GROUP = `agent:${AGENT}`;

// ── 🔴 探针的两个出口也要隔离 ──────────────────────────
//
//   `runNext` spawn 的是**真的 `bin/next.js`** ⇒ 而它每轮会自动补发存活探针
//   （`lib/probe.js` 的 `maybeSend`，`RESEND_AFTER_MS = 60 分钟`）。
//   不隔离的话，那条探针走的是**生产 outbox ＋ 生产 state**：
//     `temp/probe-state-wiringtestcrew.json` 里会攒下永久 pending，
//     而**没有任何东西会报它**（没有 agent 叫 `wiringtestcrew`，那条 pending 谁也不看）。
//
//   ⚠️ **两个都要传**：`OUTBOX_ROOT` 决定探针写去哪，`PROBE_STATE` 决定账记在哪 ——
//     **缺一个就是半隔离**，而半隔离比不隔离更坏（探针发得出、回不来 ⇒ 永久 pending）。
//
//   ★ 跟下面 `runNext` 里 `extraEnv` 那段是同一条：
//     **「夹具必须活在生产状态之外 —— 跟『基线必须活在改动之外』是同一条。」**
const PROBE_ROOT = path.join(os.tmpdir(), `engloop-wiring-probe-${process.pid}`);
// 跑完删掉。用 `exit` 而不是 main 末尾：异常退出时也要清（否则 tmpdir 会攒）。
process.on('exit', () => { try { fs.rmSync(PROBE_ROOT, { recursive: true, force: true }); } catch { /* 尽力 */ } });

// Bash 工具的超时。594000 这个值存在的唯一理由就是要小于它。
const BASH_TOOL_TIMEOUT_MS = 600_000;

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把一个流整个读出来，每条摊平成对象。 */
async function readStream(redis, stream) {
  const rows = await redis.xrange(stream, '-', '+');
  return rows.map(([id, fields]) => {
    const o = { _id: id };
    for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
    return o;
  });
}

/** 起一个临时 outbox 目录 + relay，事件收进数组里。调用方负责 stop()。 */
function tempRelay(redis, { from = AGENT, ackGroup } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-wiring-'));
  // ★★ 死信也落到临时目录 —— **这个文件的用例大量走死信路径**（ack 全失败
  //   那三种 0），不重定向的话一次全量就会往**生产**的 `temp/deadletter/` 里
  //   写测试产物。
  //   **死信目录的价值全在「里面每一条都是真的」** —— 混进测试产物之后，
  //   人捞的时候会把真的那条也当成残留。
  const dlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-wiring-dl-'));
  const events = [];
  const relay = startRelay({
    outboxDir: dir, from, redis,
    ...(ackGroup ? { ackGroup } : {}),
    onEvent: (e) => events.push(e),
    deadletterRoot: dlRoot,
  });
  let n = 0;
  return {
    dir, events, relay,
    /** 写一个 outbox 文件并立刻 drain，返回 drain 完成的 promise。 */
    async write(obj) {
      fs.writeFileSync(path.join(dir, `${Date.now()}-${n++}.json`), JSON.stringify(obj));
      await relay.drain();
    },
    stop() {
      relay.stop();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dlRoot, { recursive: true, force: true });
    },
  };
}

/**
 * 跑一次真的 next.js，指到本进程的测试库。
 *
 * `agentType` 显式控制 ENGLOOP_AGENT_TYPE：**不能继承跑测试那个进程的**。
 * dev 自己的会话里就有这个变量（值是 dev），继承的话「没注入」这个分支
 * 在 dev 机器上永远走不到，在 CI 上却会走到 —— 测试结果取决于谁在跑它。
 */
function runNext(args, { timeoutMs = 30_000, agentType = null, extraEnv = null } = {}) {
  const db = q.allocTestDb();
  const env = { ...process.env, ENGLOOP_REDIS_URL: `redis://127.0.0.1:6379/${db}` };
  if (agentType) env.ENGLOOP_AGENT_TYPE = agentType;
  else delete env.ENGLOOP_AGENT_TYPE;
  // ★ `extraEnv`：给子进程再塞几个变量。加它是因为 `_busy` 那组判据要把
  //   `ENGLOOP_BUSY_ROOT` 指到一个临时目录 —— 否则它读的是**真实的** `temp/busy/`，
  //   而那意味着：别的 agent 一 declare，这组判据就随机红；
  //   反过来，这里造的夹具也会让别的 agent 的 `anyBusy()` 看到一个假的「有人在跑」。
  //   ⇒ **夹具必须活在生产状态之外** —— 跟「基线必须活在改动之外」是同一条。
  if (extraEnv) Object.assign(env, extraEnv);
  // ★ 探针的两个出口（见文件头 PROBE_ROOT 那段）。**放在 extraEnv 之后**：
  //   若哪条判据要显式覆盖它们，它说了算；而默认永远不落生产。
  if (!env.ENGLOOP_OUTBOX_ROOT) env.ENGLOOP_OUTBOX_ROOT = path.join(PROBE_ROOT, 'outbox');
  if (!env.ENGLOOP_PROBE_STATE) env.ENGLOOP_PROBE_STATE = path.join(PROBE_ROOT, 'probe-state.json');
  return spawnSync('node', [NEXT_JS, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env,
  });
}

async function main() {
  const redis = q.createClient();
  await redis.del(STREAM);
  await roster.unregister(redis, AGENT).catch(() => {});

  console.log('\n【1】★ 心跳：next.js 真的调了 roster.heartbeat');
  // 这条守的是「heartbeat 函数写好了但没人调」：那样 agent
  // 注册 90 秒后就从花名册消失，编排者查不到它、消息路由错地方，
  // 而 agent 进程活得好好的。
  //
  // 测法：先用一个**短 TTL** 注册，跑一轮 next.js，再看 TTL 有没有被顶回长值。
  // 只有 heartbeat 被真的调用过，TTL 才会变。
  {
    await roster.register(redis, AGENT, { type: 'dev', stream: STREAM }, 60);
    const before = await redis.ttl(roster.KEY(AGENT));
    ok(before > 0 && before <= 60, `注册后 TTL=${before}s（短 TTL，等着被顶回去）`);

    const r = runNext(['--group', GROUP, '--consumer', `${AGENT}-1`,
                       '--streams', STREAM, '--block', '300']);
    ok(r.status === 0, 'next.js 正常退出', (r.stderr || '').slice(0, 200));

    const after = await redis.ttl(roster.KEY(AGENT));
    ok(after > 60,
      `★ TTL 被顶回 ${after}s —— 证明 heartbeat 在生产路径上被调用了`,
      `before=${before} after=${after}（没变就是那根线断了）`);
    ok(after > 800 && after <= roster.TTL_SEC,
      `★ 顶回的是 roster.TTL_SEC（${roster.TTL_SEC}s）而不是别的值`);
  }

  console.log('\n【1b】★ 掉册之后能自愈 —— 而且是**在生产路径上**自愈');
  // ── 这一节守的是「掉册之后条目能自己回来」 ──────────────
  //
  // 要防的失效：agent 单向失聪 —— 收得到消息，发出去的没人捡，而且
  // 它自己完全不知道。失效链：如果 next.js 只在 poller 启动那一刻打一次
  // heartbeat（TTL 900s = 594s 阻塞 + 306s 余量），那 306s 余量只够
  // 覆盖**阻塞**，不覆盖 agent 干活的时间。长任务超过余量 →
  // 掉出花名册 → bus 的 syncRelays 摘掉它的 relay → 它继续写 outbox，
  // 没人捡。poller 直连 redis 所以收消息一切正常。
  //
  // ★ 上面【1】那条测试**抓不到这种失效**：那时 heartbeat 每一轮都在
  //   被调用，变异测试照样会红。它只是**没有生效** —— EXPIRE 一个不存在的
  //   key 返回 0，而返回 0 不是异常，`.catch()` 根本进不去。
  //
  //   跟 XACK 返回 0 一模一样。这是这个系统里最危险的失败形状：
  //   **命令成功执行、返回一个表示「什么都没发生」的值、没有人看那个值。**
  //
  // ★ 单测（watchdog-liveness【3c-4】）已经验过 roster 会重建。这里守的是
  //   **另一件事**：真的跑一次 bin/next.js，条目会不会自己回来。
  //   自愈逻辑在 roster 里没用 —— 得有人给它素材（type/cwd）才走得到。
  //   把 next.js 那两行素材删掉，roster 单测照样全绿，只有这一节会红。
  {
    await roster.unregister(redis, AGENT);           // 模拟条目已过期
    ok(await redis.exists(roster.KEY(AGENT)) === 0, '（前置）条目已不在花名册');

    const r = runNext(['--group', GROUP, '--consumer', `${AGENT}-1`,
                       '--streams', STREAM, '--block', '300'], { agentType: 'dev' });
    ok(r.status === 0, 'next.js 正常退出', (r.stderr || '').slice(0, 300));

    const rec = await roster.lookup(redis, AGENT);
    ok(rec !== null, '★ 跑完一轮 poller，条目自己回来了 —— 生产路径上真的自愈了');
    ok(rec?.type === 'dev', '★ 重建用的是注入的 ENGLOOP_AGENT_TYPE，不是猜的');
    ok(rec?.tmux_session === 'agent_' + AGENT && rec?.stream === STREAM,
      '★ 会话名和收件流按约定补齐（留空会让 watchdog 误报 deaf / 消息进黑洞流）');

    // ── 「救回来了」还不够：人必须知道刚才掉过册 ──
    // 掉册期间发给它的消息被当成「发给人」推去了网页，写出去的 outbox 没人捡。
    // 悄悄补上条目 = 把掉册抹平，比不修更糟。
    // ⚠️ 不能只匹配 /掉过册|重建/ —— 太松：need_info 分支的文案是
    //    「无法**重建**」，一样能匹配。摘掉 next.js 的素材做变异时，那样写
    //    照样绿。**「关键词出现过」和「说的是这件事」是两回事。**
    ok(/已自动重建/.test(r.stderr || ''),
      '★ 自愈时大声说出来（走 stderr，大脑在 Bash 输出里看得见）',
      JSON.stringify((r.stderr || '').slice(0, 200)));
    ok(!/续期失败/.test(r.stderr || ''),
      '★ 阴性对照：成功重建时不会同时喊「续期失败」');
    ok(r.stdout.trim().split('\n').length === 1,
      '★ 但没有污染 stdout —— 那是协议通道，形状是禁区');

    // ── 素材不够时：不重建，但也不沉默 ──
    await roster.unregister(redis, AGENT);
    const r2 = runNext(['--group', GROUP, '--consumer', `${AGENT}-1`,
                        '--streams', STREAM, '--block', '300']);  // 不给 agentType
    ok(await redis.exists(roster.KEY(AGENT)) === 0,
      '★ 没有 ENGLOOP_AGENT_TYPE 就不重建 —— 建一条 type 错的比不建更难查');
    ok(/续期失败|need_info/.test(r2.stderr || ''),
      '★ 但会报出来（沉默 = 回到掉册不可见的老状态）',
      JSON.stringify((r2.stderr || '').slice(0, 200)));

    // 返回值必须被读。`.catch(()=>{})` 那种丢弃写法一旦回来，这条就红。
    const src = fs.readFileSync(NEXT_JS, 'utf8');
    ok(/roster\.heartbeat\(/.test(src) && /rebuilt/.test(src),
      '★ next.js 读了 heartbeat 的返回值（历史上它整个丢掉了）');

    // ── heartbeat 的**四种**失败都要出声，一种都不许静默 ──
    //
    // rebuilt / need_info / corrupt 之外，还有「heartbeat 抛异常」那一种 ——
    // 而它是最静默的：连返回值都没有。那几行 stderr 的全部目的就是
    // 「不让心跳失败静默」，漏了这一种，同一段代码里就留着一条静默路径，
    // **目的和缺陷相隔几行**。
    //
    // ⚠️ 而且不能写成 `.catch(() => 'error')` —— **那样连失败原因都丢了**，
    //   掉册就**无法确诊**（只能靠 TTL 时间线推算）。
    //   一个让自己无法被诊断的缺陷，比一个能被诊断的更该先修。
    const code = src.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    for (const kind of ['rebuilt', 'need_info', 'corrupt', 'error']) {
      ok(new RegExp(`'${kind}'`).test(code),
        `★ heartbeat 的 '${kind}' 分支被处理了（不是静默走过）`);
    }
    ok(!/heartbeat\([^)]*\)[\s\S]{0,80}?\.catch\(\s*\(\s*\)\s*=>/.test(code),
      '★ 没有用 `.catch(() => …)` 吞掉 heartbeat 的异常（那会丢掉失败原因）');
    // ⚠️ 只写 `/hbErr/.test(code)` **太弱**：加一个叫 `hbErrPlaceholder`
    //   的无关变量它就绿了。**光有那个名字出现过，
    //   不代表异常真的被接住并用上了。**（「关键词出现过」≠「说的是这件事」。）
    //   所以守两个**具体动作**：catch 里把 err 赋给它、输出时真的读了它。
    ok(/catch\s*\([^)]*\)\s*\{[\s\S]{0,120}?hbErr\s*=/.test(code),
      '★ catch 里把 Error 接住了（不是 `.catch(() => …)` 丢掉）');
    ok(/hbErr\s*&&\s*hbErr\.message|hbErr\.message/.test(code),
      '★ 而且报出来的时候真的读了它 —— 说得出「为什么失败」，不只是「失败了」');
  }

  console.log('\n【1c】★ 阻塞返回后要再刷一次心跳（心跳原来不覆盖「处理」）');
  {
    // ── 它治的是什么 ────────────────────────────────────────────────
    // TTL 900s = 594s 阻塞 + 306s 余量，而心跳如果**只在轮询开始时刷一次**，
    // 那 306 秒就是留给「处理」的全部预算。**干活越久越容易掉册，而干活久
    // 恰恰是正常工作的样子。** 一轮跑 20 分钟（改几个文件 + 两次全量测试）
    // 就足以掉册。
    //
    // ⚠️ 它治不了什么：余量 306 → 900 秒，**但心跳仍然不覆盖处理，
    //   而处理时间没有上限**。900 不是安全线，是下一条会被跨过去的线。
    // ────────────────────────────────────────────────────────────────
    await roster.register(redis, AGENT, { type: 'dev', stream: STREAM }, 60);

    // 先把 TTL 压到 60，跑一轮，然后看它有没有被顶回去**两次**。
    // ★ 光看「TTL 变大了」区分不出刷一次还是两次 —— 两次都会顶到 900。
    //   所以用 last_heartbeat：两次刷之间隔着一整个阻塞，时间戳必然前进。
    const before = (await roster.lookup(redis, AGENT)).last_heartbeat;
    await wait(30);

    const r = runNext(['--group', GROUP, '--consumer', `${AGENT}-1`,
                       '--streams', STREAM, '--block', '400'], { agentType: 'dev' });
    ok(r.status === 0, 'next.js 正常退出', (r.stderr || '').slice(0, 200));

    const after = (await roster.lookup(redis, AGENT)).last_heartbeat;
    ok(after > before, '心跳时间戳前进了');

    // ★ 真正的守卫：源码里 heartbeat 被调用**两次**，且第二次在 claimNext 之后。
    //   行为断言在这里做不到 —— 两次刷的最终 TTL 跟一次一样。
    const src = fs.readFileSync(NEXT_JS, 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const calls = src.match(/roster\.heartbeat\(/g) || [];
    ok(calls.length === 2,
      `★ heartbeat 被调用两次（实际 ${calls.length}）—— 一次在阻塞前，一次在阻塞后`);

    const idxClaim = src.indexOf('claimNext');
    const idxLast = src.lastIndexOf('roster.heartbeat(');
    ok(idxClaim > 0 && idxLast > idxClaim,
      '★ 第二次在 claimNext **之后** —— 那一刻它刚证明自己在轮询，信号是真的');

    // ★★ 切片前先证明切到了东西 —— 下面两处 `src.slice(idxLast, …)` 都吊在它上面。
    //
    //   `lastIndexOf` 找不到时返回 **-1**，而 `src.slice(-1)` **不报错**，
    //   它安静地返回最后一个字符。于是：
    //     · 肯定断言（`/x/.test(tail)`）会红 —— **但红的原因会被读成
    //       「那个分支没处理」，而真相是「切片压根没对上」。**
    //     · 否定断言（`!/x/.test(tail)`）会**永远绿** —— 空串不包含任何东西。
    //       **那种绿最像真绿。** 这一节现在没有否定断言，但下一个人加一条就中招。
    //
    //   ⚠️ 上面那条 `idxLast > idxClaim` **不能替代它**：断言红了测试不会停，
    //   后面的切片照样跑。**「前一条断言会红」和「后面的代码拿到了有效输入」
    //   是两回事** —— 这个文件里到处在讲同一件事，切片这里也不例外。
    ok(idxLast > 0 && src.length - idxLast > 100,
      '（前置）源码切片真的切到了东西 —— 切不到会静默退化，让后面每条断言的红都指错方向',
      `idxLast=${idxLast} 切片长度=${src.length - idxLast}`);

    // ⚠️ 第二次心跳也要传重建素材 —— 不能以「本轮开头刚报过，重复报是噪音」
    //   为由省掉：agent 会在**阻塞期间**被删出花名册（watchdog 拿解析错的会话名判
    //   stale → unregister）。那时轮次开头的心跳早跑完了，
    //   **这一次是唯一能发现它的时机。**
    //   期望始终是「掉册必须被发现且说出来」。
    const secondCall = src.slice(idxLast, idxLast + 200);
    ok(/type:|cwd:/.test(secondCall),
      '★ 第二次**要**传重建素材 —— 阻塞期间被删只有这一次查得到',
      secondCall.slice(0, 100));

    // ★★ 而且必须**读返回值**，不能只 catch 异常。
    //   `need_info` / `corrupt` **不是异常，是返回值** —— 只 catch 的话，
    //   「阻塞期间被删」会在这里静默走过。
    const tail = src.slice(idxLast);
    ok(/hb2\s*===\s*'rebuilt'/.test(tail),
      '★★ 第二次心跳的 rebuilt 分支被处理了（阻塞期间被删的唯一信号）');
    for (const kind of ['need_info', 'corrupt', 'error']) {
      ok(new RegExp(`'${kind}'`).test(tail),
        `★ 第二次心跳的 '${kind}' 也没被静默走过`);
    }

    await roster.unregister(redis, AGENT);
  }

  console.log('\n【2】★ 输出契约：stdout 的形状（禁区，改了大脑就聋）');
  // next.js 的 stdout 是编排者唯一的输入通道。这几条守的是形状本身。
  {
    const r = runNext(['--group', GROUP, '--consumer', `${AGENT}-1`,
                       '--streams', STREAM, '--block', '300']);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (_) { /* 下面断言会报 */ }

    ok(parsed !== null, '★ stdout 是合法 JSON（不是日志、不是错误栈）',
      (r.stdout || '').slice(0, 200));
    ok(parsed?.timeout === true, '★ 没消息时输出 {"timeout":true}');
    ok(r.stdout.trim().split('\n').length === 1,
      '★ 只有一行 —— 多一行调试输出就会污染协议通道');
  }
  {
    // 有消息时的形状。每个字段都是协议的一部分：
    // stream_id 缺了大脑没法 ack，_orchestrator_instructions 缺了人格不再注入
    await q.send(redis, STREAM, { from: 'Patrick', text: '接线测试', agent_type: 'test' });
    const r = runNext(['--group', GROUP, '--consumer', `${AGENT}-1`,
                       '--streams', STREAM, '--block', '300']);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (_) { /* 下面断言会报 */ }

    const m = parsed?.messages?.[0];
    ok(Array.isArray(parsed?.messages) && parsed.messages.length === 1, '领到一条消息');
    ok(typeof m?.stream_id === 'string' && m.stream_id.includes(':::'),
      '★ stream_id 是复合格式 —— 少了这个大脑 ack 不掉（裸 ID 会静默失败）');
    ok(m?.stream_id.startsWith(`${STREAM}:::`), '★ 复合 ID 的前半段是流名');
    ok(typeof m?.job_id === 'string' && m.job_id.length > 0,
      '★ job_id 透传（幂等键 + 用量归因）');
    ok(Array.isArray(parsed?._orchestrator_instructions)
       && parsed._orchestrator_instructions.length > 0,
      '★ 指令被重新注入 —— 人格靠它跨压缩存活');
    ok(parsed._orchestrator_instructions.join('').includes('READY_TO_SHUTDOWN'),
      '★ 注入的确实是 protocols/ 的内容，不是占位文本');
  }

  console.log('\n【3】★ BLOCK 594000：守的是约束，不是那个数字');
  // 文档说这个配对「是调好的，不要随意改」。但守住「等于 594000」是错的 ——
  // 那会把一次合理的调整也判成失败。真正不能破的是**它和 Bash 工具超时的关系**：
  // 阻塞必须先返回，工具才不会在拿到消息前把大脑打断。
  {
    ok(q.DEFAULTS.blockMs < BASH_TOOL_TIMEOUT_MS,
      `★ 阻塞时长(${q.DEFAULTS.blockMs}ms) < Bash 工具超时(${BASH_TOOL_TIMEOUT_MS}ms)`,
      '反过来的话：工具会在 poller 返回前打断它，大脑收不到消息也看不到 timeout');
    ok(BASH_TOOL_TIMEOUT_MS - q.DEFAULTS.blockMs >= 5000,
      `★ 余量 ${BASH_TOOL_TIMEOUT_MS - q.DEFAULTS.blockMs}ms ≥ 5000ms（够 redis 往返 + 进程退出）`);

    // 静态守卫：next.js 必须**用** DEFAULTS.blockMs，不能自己硬编码一个。
    // 上面两条断言的是常量本身；这条断言那个常量真的被生产入口读了 ——
    // 否则改了常量而 next.js 纹丝不动，两条绿着，线是断的。
    const src = fs.readFileSync(NEXT_JS, 'utf8');
    ok(/q\.DEFAULTS\.blockMs/.test(src),
      '★ next.js 的默认阻塞取自 q.DEFAULTS.blockMs，没有另写一个数');
  }

  console.log('\n【4】★ 手工白名单不许吃字段 —— 调用侧也一样，这一节守着它');
  // ── 这一节报告的是一个**当前存在的缺陷**，不是历史回归 ──────────────
  //
  // 要防的形状：「send 用白名单拼 payload → room_hash 被静默丢弃」。
  // 修复做在**被调方**：`lib/queue.js:412` 现在把非必备字段原样透传，
  // 而且 `REQUIRED_FIELDS` 上面那段注释专门解释了白名单的危害。
  //
  // ★ 但**调用方**没跟着改。`lib/relay.js:302` 是手工挑五个字段拼 payload：
  //
  //     await q.send(redis, target.stream, {
  //       from, to: target.to, text: ..., agent_type: ..., job_id: entry.job_id,
  //     });                                    // ← entry.room_hash 在这里被扔掉
  //
  //   **白名单没有消失，它从被调方搬到了调用方。**
  //   `queue.test.js` 验 send 会透传 —— 全绿；生产路径上根本没人给它 room_hash。
  //   **「函数支持透传」≠「调用方真的传了」**，这正是接线测试存在的理由。
  //
  // ── 为什么它是缺陷而不是「设计如此」 ──
  //   1. 同一个房间流里两种形状：人走 rooms.post 的带 room_hash，agent 走
  //      relay 的不带。任何读房间流的代码写 `m.room_hash` 都会拿到 undefined。
  //   2. `bin/serve.js:415` 的 fanOutRoom 现在**恰好**不受影响 —— 它用自己的
  //      参数 hash，不读 `m.room_hash`。**那是巧合不是保证**：哪天有人照
  //      `bin/next.js:244` 的写法从消息体读，agent 在房间里说的话就会静默
  //      变成非房间消息 —— 协议里用最重措辞警告的那件事，且没有任何报错。
  //   3. hash 其实还在，但在 `to` 字段里（resolveTarget 返回 to: room_hash）。
  //      **字段名不对等于没有** —— 没人会去 `to` 里找 hash。
  //   4. rooms.js 说房间流是「唯一的历史真相，可回溯、可重放」。
  //      agent 那条重放不出来：记录里没有它属于哪个房间。
  //
  // ⚠️ 修在 relay.js。这一节**会红，红的是缺陷不是测试**。
  //    修好之后它自己会变绿，不需要改这里。
  {
    const meta = await rooms.create(redis, 'wiring-room');
    const st = rooms.stream(meta.hash);
    await redis.del(st);
    const t = tempRelay(redis);

    // ★ 对照组不可省：它把「流不支持这个字段」和「relay 把它丢了」分开。
    //   没有它，下面那条红了也说不清是谁的问题。
    await rooms.post(redis, meta.hash, { from: 'Patrick', text: '人说的话' });
    await t.write({ room_hash: meta.hash, text: 'agent 说的话' });

    const rows = await readStream(redis, st);
    const human = rows.find((r) => r.from === 'Patrick');
    const agent = rows.find((r) => r.from === AGENT);

    ok(human?.room_hash === meta.hash,
      '（对照）人走 rooms.post 的那条带着 room_hash —— 流本身支持这个字段');
    ok(agent !== undefined,
      '（前置）agent 那条确实投进了房间流 —— 路由是对的，只是字段掉了');
    ok(agent?.room_hash === meta.hash,
      '★ agent 经 relay 发的那条也带着 room_hash',
      `实际 room_hash=${JSON.stringify(agent?.room_hash)}，字段表=[${Object.keys(agent || {}).join(', ')}]`);

    t.stop();
    await redis.del(st, rooms.META(meta.hash));
    await redis.srem(rooms.INDEX, meta.hash);
  }

  console.log('\n【5】★ XACK 的三种 0 都要说出来 —— 现有防线只挡住了没出过事的那一种');
  // ── 为什么这不是「已经有 ack_noop 断言了」的重复 ────────────────────
  //
  // XACK 返回 0 有三种成因，而它们**长得一模一样**：
  //   (a) 流根本不存在
  //   (b) 流和组都对，但这个 ID 已经不在 PEL 里（早就 ack 过了）
  //   (c) 流、ID、组**都存在**，但 ID 在**另一个组**的 PEL 里 ← 最难发现的那种
  //
  // (c) 见 `lib/relay.js:140` 那段注释：拿 `agent:JARVIS` 组去 XACK
  // `orch` 组的 PEL，**跨组返回 0 且不报错**，每条消息 60 秒无限重投。
  //
  // ★ `relay.test.js` 那条 ack_noop 断言造的是 (a)（`nosuch:stream:::1-0`）。
  //   只有它不够：把 noop 判定弱化成只认 (a) ——
  //   `if (n === 0 && await redis.exists(s) === 0)` —— relay.test.js 照样全绿。
  //   只验 (a) 的防线会漏掉 (c)，而且看起来是绿的。
  //
  // ★★ 每一种都**先证明「造出来的确实是这一种」**再断言。少了这一步，三次
  //    很可能造出的是同一种 0（最容易变成三次 (a)），测试照样全绿 ——
  //    那就是「以为验了 A、实际验的是 B」。
  // ────────────────────────────────────────────────────────────────
  {
    const noopOf = (evs) => evs.filter((e) => e.type === 'ack_noop');

    // ── (a) 流不存在 ──
    const ghost = `nosuch-${AGENT}-${Date.now()}`;
    ok(await redis.exists(ghost) === 0, '（造 a）确认这个流真的不存在');
    const ta = tempRelay(redis);
    await ta.write({ text: '', ack: `${ghost}:::1-0` });
    const na = noopOf(ta.events);
    ok(na.length === 1, '★ (a) 流不存在 → 报了 ack_noop', JSON.stringify(ta.events));
    ok(na[0]?.stream === ghost && na[0]?.id === '1-0',
      '★ (a) 事件里带着流名和 ID —— 说得出是哪一条，不只是「有条没成」');
    ta.stop();

    // ── (b) 流和组都对，但 ID 已经不在 PEL 里 ──
    const stB = `${STREAM}.noop-b`;
    const grpB = 'orch';                      // relay 默认就用 orch
    await redis.del(stB);
    await q.send(redis, stB, { from: 'x', text: 'b' });
    const mB = await q.claimNext(redis, { streams: stB, group: grpB, consumer: 'b1', blockMs: 200 });
    ok(mB.length === 1, '（造 b）领到消息');
    await q.ack(redis, stB, grpB, mB[0].id);  // 先正常 ack 掉
    ok(await redis.exists(stB) === 1, '（造 b）流确实存在 —— 不是 (a)');
    ok((await q.pending(redis, stB, grpB)).count === 0,
      '（造 b）确认 ID 已不在 PEL —— 这才是 (b) 而不是别的');
    const tb = tempRelay(redis);
    await tb.write({ text: '', ack: `${stB}:::${mB[0].id}` });
    const nb = noopOf(tb.events);
    ok(nb.length === 1, '★ (b) 重复 ack 一条已 ack 的 → 也报 ack_noop', JSON.stringify(tb.events));
    ok(nb[0]?.stream === stB && nb[0]?.id === mB[0].id, '★ (b) 事件指得出是哪一条');
    tb.stop();

    // ── (c) 流、ID、组都存在，但 ID 在另一个组的 PEL 里 ──
    const stC = `${STREAM}.noop-c`;
    await redis.del(stC);
    await q.send(redis, stC, { from: 'x', text: 'c' });
    const mC = await q.claimNext(redis, { streams: stC, group: 'realgroup', consumer: 'c1', blockMs: 200 });
    ok(mC.length === 1, '（造 c）领到消息');
    // pending() 内部会 ensureGroup —— 借它把「另一个组」真的建出来。
    // ★ 这一步不能省：组不存在的话 (c) 会退化成「组不存在」，那是另一种 0，
    //   而要验的场景里 orch 组是**存在**的，消息只是在别人的 PEL 里。
    const otherGroup = 'wrong-but-real-group';
    await q.pending(redis, stC, otherGroup);
    ok(await redis.exists(stC) === 1, '（造 c）流确实存在');
    ok((await q.pending(redis, stC, 'realgroup')).count === 1,
      '（造 c）ID 真的在 realgroup 的 PEL 里 —— 消息是「还没被确认」的状态');
    ok((await q.pending(redis, stC, otherGroup)).count === 0,
      '（造 c）而在另一个组的 PEL 里没有它 —— 这才是跨组那种 0');
    const tc = tempRelay(redis, { ackGroup: otherGroup });
    await tc.write({ text: '', ack: `${stC}:::${mC[0].id}` });
    const nc = noopOf(tc.events);
    ok(nc.length === 1,
      '★★ (c) 跨组 ack → 也报 ack_noop（这是唯一真出过事的那种）',
      JSON.stringify(tc.events));
    ok(nc[0]?.group === otherGroup,
      '★★ (c) 事件里带着**组名** —— 跨组的情况只有这个字段能认出来',
      JSON.stringify(nc[0]));
    // 消息还在原组的 PEL 里 —— 跨组 ack 什么都没做成，它会被重投。
    ok((await q.pending(redis, stC, 'realgroup')).count === 1,
      '★ (c) 原组的 PEL 纹丝不动 —— 证明这次 ack 真的一点用都没有');
    tc.stop();

    await redis.del(stB, stC);
  }

  console.log('\n【6】★ 子进程失败原因不许原地丢掉（stdio:\'ignore\' 会把它丢掉）');
  // ── 要防的形状：「用 stdio:'ignore' 起子进程 → 子进程失败原因被原地丢掉」──
  //
  // test/isolation.test.js 读 stdout/stderr 并打进失败详情；
  // 而**生产路径上的同一形状**要靠这一节守：
  // `lib/worker-runner.js` 的 runPrint 是真正 spawn 子进程的地方，而
  // `test/worker.test.js` 用的是**假 runner**（stub 直接返回 {ok:false,...}），
  // **真 runPrint 的错误路径从来没有被真的子进程验证过。**
  //
  // ★ 判据不是「失败了没有」—— 那是退出码就能告诉你的。
  //   判据是**「说不说得出为什么失败」**：stdio:'ignore' 之下，
  //   子进程往 stderr 喊的那一声会被原地丢掉，外面只剩一个数字。
  //
  // 做法：注入一个假 claude（往 stderr 喊一个 nonce 然后非零退出），
  // 断言**那个 nonce 出现在 runPrint 的返回值里**。nonce 是随机的，
  // 只有那个假二进制会产生它 —— 断言绿了就只可能是真读到了 stderr。
  {
    const nonce = `ENGLOOP_STDERR_NONCE_${process.pid}_${Date.now()}`;
    const outNonce = `ENGLOOP_STDOUT_NONCE_${process.pid}`;
    const fake = path.join(os.tmpdir(), `fake-claude-${process.pid}.sh`);
    fs.writeFileSync(fake, `#!/bin/sh\necho "${outNonce}"\necho "${nonce}" >&2\nexit 3\n`);
    fs.chmodSync(fake, 0o755);

    // ⚠️ 必须起子进程：worker-runner 用模块级变量缓存 claudeBin()，一个进程
    //   里只解析一次。【7】还要用**真**的 claude，两者不能共享这个缓存。
    const probe = spawnSync('node', [path.join(__dirname, 'fixtures', 'subprocess-failure-probe.js')], {
      cwd: ROOT, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ENGLOOP_CLAUDE_BIN: fake },
    });
    let r = null;
    try { r = JSON.parse(probe.stdout || '{}'); } catch (_) { /* 下面断言会报 */ }

    ok(r !== null && !r.probe_error, '（前置）探针跑起来了',
      `exit=${probe.status} out=${(probe.stdout || '').slice(0, 300)} err=${(probe.stderr || '').slice(0, 300)}`);
    ok(r?.ok === false, '（前置）假二进制非零退出，runPrint 判为失败');
    ok(r?.reason === 'error',
      `（前置）归类成可重试的 error 而不是 permanent（实际 ${r?.reason}）`);

    ok(String(r?.stderr || '').includes(nonce),
      '★★ stderr 的内容活着传了出来 —— 说得出「为什么失败」，不只是「失败了」',
      `实际 stderr=${JSON.stringify(String(r?.stderr || '').slice(0, 200))}`);
    ok(String(r?.output || '').includes(outNonce),
      '★ stdout 也没被丢掉 —— 失败时子进程说过的话两条通道都要留下',
      `实际 output=${JSON.stringify(String(r?.output || '').slice(0, 200))}`);
    ok(String(r?.error || '').includes('fake-claude'),
      '★ error 里说得出**是哪个二进制**失败的（换成通用文案「任务失败」这条就红）',
      `实际 error=${JSON.stringify(String(r?.error || '').slice(0, 200))}`);

    // ⚠️ 这里**验不了退出码**：
    //   像 `/3/.test(r.error)` 这样的断言匹配的是「字符串里有个字符 3」，
    //   跟退出码毫无关系 —— **临时文件名里的 pid 恰好含一个 3** 时它就绿，
    //   换台机器、换个 pid 就红。**一条靠巧合变绿的断言，
    //   比没有更坏。**（「关键词出现过」≠「说的是这件事」。）
    //
    // 真实情况：`runPrint` 只存了 `err.message`，而 Node 的 execFile 把
    // stderr 拼进 message、**不放退出码**（退出码在 `err.code` 上，被丢了）。
    // 所以「退出码保留了没有」这件事**这一节没有覆盖**。
    //
    // 没把它写成一条会红的断言，是因为 stderr + stdout 已经满足了这一节的
    // 判据（「说得出为什么失败」）；退出码是锦上添花，不提成硬要求。
    // 要不要保留退出码是 runner 的设计决定，这里只记现状。

    fs.rmSync(fake, { force: true });
  }

  console.log('\n【7】★ 准入层真的拦得住吗 —— 真启动、真越界、看文件系统');
  // ── 为什么「断言 argv 里有 --allowedTools」是无效测试 ────────────────
  //
  // 那个 flag 可能**传了，但完全不生效**。
  // `test/worker.test.js:185` 断言「池真的传了 allowedTools」—— 那条是对的，
  // **别删**：它守的是「参数有没有传」。**这一节守的是「传了有没有用」。**
  // 两条前提不同，是真的两层。
  //
  // ★ 这里不看 argv、不看模型说了什么，**只看文件系统**：让它用 Bash 建一个
  //   文件，然后去看那个文件在不在。**模型可以声称自己执行了，但它变不出
  //   一个文件来。** 这是这一节唯一不可伪造的证据。
  //
  // ── 受控实验：两组唯一的差别是工具集 ──
  //   A 组：工具集取自 dev（含 Bash）      → 文件**必须**出现
  //   B 组：工具集取自 eval（无 Bash）     → 文件**必须不**出现
  //   两组的 agentType **都固定传 'dev'**，所以 hook 在两组里身份一致、
  //   行为一致 —— **组间唯一变量就是准入层拿到的工具集**。
  //   （B 组「自称 dev 却只拿 eval 的工具集」在生产里不会发生，它是为了
  //     隔离变量而故意造的组合。）
  //
  // ── 执行层被物理排除，不是靠注释区分 ──
  //   cwd 是 tmpdir：项目级 `.claude/settings.json` 在那儿不生效，
  //   用户级 `~/.claude/settings.json` 查过**没挂 hook**。
  //   **那个目录里执行层根本不存在**，所以这一节测出来的只可能是准入层。
  //   （「workers/eval/ 没有 settings.json 导致 hook 没挂」是
  //     生产路径上的另一个问题，撞不到这里 —— 两个原因不会混在一起。）
  //
  // ── 只传 `--allowedTools` 拦不住，要配 `--disallowedTools` ──
  //   · 只传 `--allowedTools`：B 组工具集里**没有 Bash**，
  //     文件**照样被建出来**。`--allowedTools` 是「额外允许」，**不排他**。
  //   · 接上 `--disallowedTools`：B 组回答
  //     `UNAVAILABLE`，**符号链接没有出现**。准入层真的拦住了。
  //
  // ⚠️⚠️ **生产调用方改了，这一节不会「自己变绿」。** 探针里的参数是
  //   **从生产调用方复制的**，生产改了它不会跟着改：`worker-pool` 两个 flag
  //   都传、而探针只传 `allowedTools` 时，**它的红跟 disallowedTools 接没接上毫无关系。**
  //   > 「镜像真实调用方」是复制，而复制会过期。
  //   探针文件头记着要同步哪两处。
  //
  // ── ★ 为什么副作用是符号链接，而不是「文件存在」 ──
  //   让它 `touch` 一个文件、断言文件在不在，**会被绕过**：
  //   Bash 被禁时（模型会自陈「本次会话没有 Bash 工具可用」），
  //   **它会改用 Write 建出同一个文件**。
  //
  //   > **用「文件存在」代理「Bash 被执行了」，那个代理的假设是
  //   >   「只有 Bash 能建文件」—— 工具集里有 Write，假设不成立。**
  //
  //   所以换成 **Write 做不到** 的副作用：符号链接。模型绕道建个普通文件
  //   也没用 —— 断言查的是 `isSymbolicLink()`，不是「在不在」。
  //
  //   ★ 「模型会主动绕道」是真实行为，不是噪音：
  //     **禁掉一个工具，不等于禁掉它能达成的效果。**
  //
  // ⚠️ 代价说清楚：**这条对「用白名单还是黑名单」不敏感**，它只看结果。
  //   要守「准入层用的是白名单」（`agent-capabilities.js` 那个「漏项响亮 vs
  //   漏项静默」的理由），需要另一条断言，前提不同 —— 这里没有它。
  // ────────────────────────────────────────────────────────────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-breach-'));
    const PROBE = path.join(__dirname, 'fixtures', 'allowedtools-breach-probe.js');

    /** 符号链接判定。`existsSync` 对断链返回 false，所以走 lstat。 */
    const isSymlink = (p) => {
      try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; }
    };

    const run = (type, file) => {
      const target = path.join(dir, file);
      const p = spawnSync('node', [PROBE, type, target, dir], {
        cwd: ROOT, encoding: 'utf8', timeout: 240_000,
      });
      let out = null;
      try { out = JSON.parse(p.stdout || '{}'); } catch (_) { /* 下面断言会报 */ }
      return {
        out, status: p.status, stderr: p.stderr,
        link: isSymlink(target),
        // 建了个普通文件 = 绕道成功。它不算越界（Bash 没跑），但要看得见。
        detoured: !isSymlink(target) && fs.existsSync(target),
      };
    };

    const A = run('dev', 'A-link');
    const B = run('eval', 'B-link');

    ok(A.out?.hasBashInToolset === true,
      '（前置）dev 的工具集里有 Bash');
    ok(B.out?.hasBashInToolset === false,
      '（前置）eval 的工具集里没有 Bash —— 能力分离的源头是对的，问题不在这',
      `实际 ${B.out?.allowedTools}`);
    ok(B.out?.bashIsDisallowed === true,
      '★ （前置）eval 的 Bash 进了 disallowedTools —— 起作用的是这个，不是白名单',
      `实际 disallowedTools=${B.out?.disallowedTools}`);

    // ★ 阳性对照。**它不通过时，下面那条的「绿」没有任何意义** ——
    //   claude 没跑起来同样不会产生符号链接，那是 fail-open：
    //   「什么都没验到」会长得跟「准入层生效」一模一样。
    ok(A.link === true,
      '★ 阳性对照：给了 Bash 就真建出了符号链接 —— 证明 claude 真跑起来了、任务表述有效',
      `A 组没产生符号链接 ⇒ **本节全部结论作废**（不是「准入层生效」，是「什么都没验到」）。`
      + `out=${JSON.stringify(A.out)} exit=${A.status} err=${String(A.stderr || '').slice(0, 200)}`);

    ok(B.link === false,
      '★★ 不给 Bash 就建不出符号链接 —— 准入层真的拦得住（不是「参数传了」，是「拦住了」）',
      `B 组建出了符号链接 ⇒ **越界成功，准入层形同虚设**。`
      + `disallowedTools=${B.out?.disallowedTools}`);

    // ★ 绕道不算越界，但必须看得见：**禁掉一个工具不等于禁掉它能达成的效果。**
    //   Bash 被拦住后，模型会改用 Write 建出同一个文件。
    ok(B.detoured === false,
      '★ 而且没有用别的工具绕道达成同样效果（绕道不是越界，但它说明禁的是工具、不是效果）',
      `B 组用非 Bash 手段建出了目标文件。输出：${String(B.out?.output || '').slice(0, 300)}`);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【★thread】接线：reply_to 从 agent 一路走到浏览器');
  // ── 为什么这一节全是源码断言 ────────────────────────────────
  // 下面这些点**漏了都不报错**，而且症状全都不指向漏掉的那一行：
  //   · relay 白名单漏 reply_to → 回复进了正确的房间流，但当顶层显示
  //   · WS 分支漏 reply_to      → **刷新前后不一致**（实时当顶层，刷新后摞回去）
  //   · select() 不清 replyTarget → 换房间后那条挂到别房间不存在的父上
  //   · index.html 顺序反了      → ReferenceError 在渲染路径上 = **整页空白**
  // 行为测试覆盖不到它们（都在浏览器里），所以这里守「那行代码在不在」。
  // ⚠️ 源码断言的边界要记着：它验得了「写了」，验不了「写对了」。
  {
    const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
    const relaySrc = read('lib', 'relay.js');
    const serveSrc = read('bin', 'serve.js');
    const appSrc = read('web', 'app.js');
    const htmlSrc = read('web', 'index.html');

    ok(/entry\.reply_to\s*\?/.test(relaySrc),
      '★★ relay 的手工白名单里有 reply_to —— 漏了它，thread 在 relay 这一跳就断了（同 room_hash）');
    ok(/room_msg_id:\s*m\.id/.test(serveSrc),
      '★★ 扇出带 room_msg_id —— agent 没有它就填不出正确的 reply_to');
    ok(/reply_to\s*=\s*null\s*\}\s*=\s*req\.body/.test(serveSrc)
      || /reply_to\s*=\s*null/.test(serveSrc),
      '★ POST /api/rooms/:hash/post 收 reply_to');

    // 前端三处
    ok(/case 'room_message'[\s\S]{0,400}reply_to/.test(appSrc),
      '★★ WS 的 room_message 分支带 reply_to（漏了 = 刷新前后不一致）');
    // ⚠️ 锚点用**内容差异**，不用「离函数头 N 个字符」。
    //   写成 `loadRoomHistory[\s\S]{0,900}reply_to` 会假红（实际间隔超过 900）；
    //   而把跨度调大到 3000 会更糟：**匹配到 WS 分支那处的 reply_to**，
    //   于是 loadRoomHistory 真漏了也照样绿（假绿）。
    //   ★ 判据：history 那处用 `at: m.timestamp`，WS 那处用 `at: m.at` —— 两者天然可分。
    ok(/at:\s*m\.timestamp,\s*reply_to:\s*m\.reply_to/.test(appSrc),
      '★ 拉历史时带 reply_to（锚在 `at: m.timestamp` 上，跟 WS 那处区分开）');
    ok(/function select\([\s\S]{0,600}setReplyTarget\(null\)/.test(appSrc),
      '★★★ select() 换频道时清掉回复目标 —— **这功能里最危险的一行**');
    ok(/Threads\.group\(/.test(appSrc), '★ renderFeed 真的调了分组');

    // ── ★★ thread 模型（四条规则）────────────────
    //
    // ⚠️ **这几条是源码断言，不是行为验证** —— `renderMsg` 是 DOM 渲染，
    //   抽不进可 require 的模块。判据本身（`kindOf` / `replyTargetIdOf`）
    //   在 `web/threads.js` 里，由 `test/threads.test.js` 真测 +
    //   `test/thread-kind-mutation.test.js` 变异守着。
    //   **这里守的只是「渲染路径真的用了它们、而且没把 orphan 吃掉」。**
    ok(/Threads\.kindOf\(/.test(appSrc),
      '★★ 渲染路径调 Threads.kindOf —— 判据只有一处，不在 app.js 里放第二份');
    ok(!/^function kindOf\(/m.test(appSrc),
      '★★ app.js 里**没有**本地的 kindOf —— 有的话两份判据迟早分叉');
    ok(/Threads\.replyTargetIdOf\(/.test(appSrc),
      '★★★ setReplyTarget 用 replyTargetIdOf（归一到根）—— 直接用被点那条会两层变三层');
    // ★★★ 这一条守的是「违规消息不许消失」：
    //   「顶层只渲染人开的话题 + 通知」照字面做，会让一条 agent
    //   没标的消息**从界面上消失** —— 而消息静默不见是这个项目最反对的形状。
    ok(!/kind\s*===\s*'orphan'\s*\)\s*(return|continue)/.test(appSrc),
      "★★★ 没有「kind === 'orphan' 就跳过渲染」这种代码 —— "
      + '**违规消息照常显示 + 打标记，绝不吞掉**');
    ok(/orphan-tag/.test(appSrc) && /notice-tag/.test(appSrc),
      '★★ orphan 和 notice 各有自己的可见标记（不是只改颜色）');

    // ── ★★★ 私聊那一半 ——「人能用、agent 不能用」的另一侧 ──
    //
    //   只守网页侧的话，漏了 `bin/next.js` 也会验收全绿，
    //   而 **agent 结构上一个都用不了**。所以私聊这条把两侧一起守。
    const nextSrc = read('bin', 'next.js');

    ok(/reply_to\s*=\s*null\s*\}\s*=\s*req\.body/.test(serveSrc),
      '★★ POST /api/message 收 reply_to —— 私聊那条入口原来只解 {from, text}');
    // deliverLoop 的 broadcast。锚在 `type: 'message'` 上跟房间那处区分开。
    ok(/type:\s*'message'[\s\S]{0,300}reply_to/.test(serveSrc),
      '★★★ deliverLoop 的 broadcast 带 reply_to —— 漏了就是「实时当顶层、'
      + '刷新后摞回去」，两边各自都能用，最难查');
    // agent 那一侧
    ok(/dm_msg_id:/.test(nextSrc),
      '★★★ next.js 给 agent 带 dm_msg_id —— 没有它，私聊 thread 对所有 agent '
      + '**结构上不存在**（跟房间侧漏字段是同一个形状）');
    // ★★ 互斥：房间消息的 job_id 是扇出时 N 个收件人共享的同一个值，
    //   拿它当锚点会让一条发言的 N 份投递互相指认成同一条。
    ok(/dm_msg_id:\s*m\.room_hash\s*\?\s*undefined/.test(nextSrc),
      '★★★ 有 room_hash 时**不给** dm_msg_id —— 房间的 job_id 是扇出共享的，'
      + '当锚点会让 N 份投递互相指认',
      (nextSrc.match(/.*dm_msg_id.*/g) || []).join(' | '));

    // 前端：锚点归一函数
    ok(/function anchorOf\(/.test(appSrc),
      '★★ 前端有 anchorOf() —— 「哪种频道取哪个字段」只能有一处知道');
    // ★★★ 私聊那侧**不许回落到 m.id**：回落出一个锚点的话按钮是有了，
    //   而它生成的 reply_to 指向查不到的父 → 回复显示成顶层 → 跟没回复一样。
    ok(/function anchorOf\([\s\S]{0,300}:\s*\(m\.job_id \|\| null\)/.test(appSrc),
      '★★★ anchorOf 私聊侧是 `m.job_id || null` —— **没有锚点就返回 null，'
      + '绝不回落到 stream id**（两条流的 stream id 会撞）',
      (appSrc.match(/.*m\.job_id \|\| null.*/g) || []).join(' | '));
    // 回复按钮：判据从「哪种频道」改成「有没有锚点」
    ok(!/current\.kind === 'room' && e\.id/.test(appSrc),
      '★★ 回复按钮不再按频道种类判 —— 私聊也能回了');
    ok(/reply-btn/.test(appSrc) && /if \(e\.id\) \{/.test(appSrc),
      '★★★ 判据是「这条有没有锚点」——**没锚点不给按钮**，'
      + '而不是凑一个出来让按钮都在');
    // 私聊两个接收点都带 reply_to（跟房间那两条对称）
    ok(/case 'message'[\s\S]{0,400}reply_to/.test(appSrc),
      '★★ WS 的 message 分支带 reply_to');
    ok(/at:\s*m\.timestamp \|\| m\.at,\s*reply_to:\s*m\.reply_to/.test(appSrc),
      '★★ 私聊拉历史时带 reply_to（锚在 `at: m.timestamp || m.at` 上，'
      + '跟房间 history 的 `at: m.timestamp` 区分开）');

    // ★ 脚本顺序：threads.js 必须在 app.js 之前
    const iT = htmlSrc.indexOf('/threads.js');
    const iA = htmlSrc.indexOf('/app.js');
    ok(iT !== -1 && iA !== -1 && iT < iA,
      '★★ index.html 里 threads.js 在 app.js 之前（反了 = 整页空白）',
      `threads@${iT} app@${iA}`);

    // ★★ 阴性对照：确认上面那些正则**真的在验东西**，不是「怎么写都绿」。
    //   拿一段肯定不存在的字符串走同一套 test —— 它必须是 false。
    ok(/entry\.reply_to_THIS_MUST_NOT_EXIST/.test(relaySrc) === false,
      '★★ 阴性对照：不存在的模式返回 false —— 上面那些绿不是「正则永远匹配」');
  }

  console.log('\n【★存储层】存储层不许调 LLM —— **递归**查 require 图');
  {
    // ── 这条守的是「存储层不调 LLM」──
    //
    //   **存储层一旦开始用 LLM 加工它存的东西，「记录下来的」和「推断出来的」
    //   就再也分不开** —— 而且分不开是**永久的**：两者当初就是从同一个函数
    //   流出来的，数据里没留下任何痕迹，之后任何检查都救不回来。
    //
    // ★ 要紧的不是「别在存储层调 LLM」这个建议（谁都同意），
    //   是**「用 import 方向锁死」这个手法** —— 它把一条纪律变成一个静态事实。
    //   而这条断言就是那个锁：跑测试是必然动作，所以它不需要任何人记得。
    const STORAGE = ['queue', 'history', 'outputs', 'roster', 'rooms'];
    const stripc = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const libSrc = (n) => stripc(fs.readFileSync(path.join(ROOT, 'lib', `${n}.js`), 'utf8'));

    /** 递归收集一个 lib 模块的**全部**本地依赖（含它自己）。 */
    const closure = (name, seen = new Set()) => {
      if (seen.has(name)) return seen;
      seen.add(name);
      let src;
      try { src = libSrc(name); } catch (_) { return seen; }   // 不是 lib/ 里的，跳过
      for (const m of src.matchAll(/require\('\.\/([a-z0-9-]+)'\)/g)) closure(m[1], seen);
      return seen;
    };
    /** 这个模块自己**真的**去起模型了吗（剥注释之后看）。 */
    const invokesLLM = (n) => {
      let src;
      try { src = libSrc(n); } catch (_) { return false; }
      return /claudeBin\s*\(|runPrint\s*\(|(spawn|execFile)\s*\(\s*['"`]claude/.test(src);
    };

    for (const s of STORAGE) {
      const all = [...closure(s)];
      const bad = all.filter(invokesLLM);
      ok(bad.length === 0,
        `★★★ \`${s}\` 的依赖闭包（${all.length} 个模块）里没有任何 LLM 调用`,
        bad.length ? `🔴 命中: ${bad.join(', ')}` : '');
    }

    // ── ★★★ 两条对照，缺了它们上面那堆绿等于没测 ──────────────────
    //
    // ① 阳性：这个检测器**真的抓得到东西**。
    //    没有这一条的话，一个「永远返回 false 的 invokesLLM」也能让上面全绿。
    const wpAll = [...closure('worker-pool')];
    const wpBad = wpAll.filter(invokesLLM);
    ok(wpBad.length > 0,
      '★★★ 阳性对照：`worker-pool` 的闭包里**确实**检出了 LLM 调用 —— 检测器是活的',
      JSON.stringify(wpBad));

    // ② ★ 而且是**递归**才抓到的 —— `worker-pool` 自己不 spawn claude，
    //    是它依赖的 `worker-runner` 在起模型。
    //    **只查一层的实现会让这条漏掉，而那时上面那 5 条照样全绿。**
    ok(!invokesLLM('worker-pool') && wpBad.length > 0,
      '★★★ 而且 `worker-pool` **自己**不含 LLM 特征 —— 是**间接**依赖被抓到的，'
      + '这证明「递归」那一层有价值（只查一层会在最像成功的时候失去强度）',
      JSON.stringify({ self: invokesLLM('worker-pool'), viaClosure: wpBad }));
  }

  console.log('\n【接线】离线 agent 清单 + 开启按钮 —— handler 写得再对，没挂就是 404');
  {
    const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
    const serveSrc = read('bin', 'serve.js');
    const appSrc = read('web', 'app.js');
    const cssSrc = read('web', 'app.css');

    ok(/app\.post\(['"`]\/api\/agents\/:name\/start['"`]/.test(serveSrc),
      '★★ 开启路由挂上了（POST /api/agents/:name/start）');
    ok(/require\(['"`]\.\.\/lib\/agent-ui-start['"`]\)/.test(serveSrc)
      && /launch\.start\(/.test(serveSrc),
      '★★ 用的是 lib 里那个被测过的 start()，不是在回调里又实现一遍');
    ok(/offline_candidates/.test(serveSrc) && /catalog\.offline\(/.test(serveSrc),
      '★ /api/agents 真的把离线候选放进了响应');
    ok(/offline_source/.test(serveSrc),
      '★★ 来源标记跟着走 —— 要的是「A + 标注来源」，'
      + '**扫目录得来的名单不说明出处，就成了一份看起来像声明的推断**');
    ok(/launch\.settleAgainstRoster\(/.test(serveSrc),
      '★★★ 每次 /api/agents 都拿花名册结账 —— 不结的话，'
      + '「正在起」和「起完了却没上线」在界面上是同一个样子');

    ok(/offline_candidates/.test(appSrc) && /renderOffline/.test(appSrc),
      '★ 前端真的渲染了它 —— 后端给了字段、前端不认，那个字段等于不存在');
    ok(/\/start['"`]?[\s\S]{0,80}method:\s*['"`]POST['"`]/.test(appSrc)
      || /method:\s*['"`]POST['"`]/.test(appSrc),
      '★ 按钮真的发 POST');
    ok(/confirm\(/.test(appSrc) && /消耗额度/.test(appSrc),
      '★★ 点击要确认，**且确认框里写明代价** —— '
      + '「你确定吗」不告诉人代价是什么，等于没问');
    ok(/launching\[/.test(appSrc) && /正在起/.test(appSrc) && /起失败/.test(appSrc),
      '★★★ 界面把「正在起」和「起失败」分开显示 —— '
      + '两者在花名册里都是「它不在」，分不开的话人会一直等下去');
    ok(/\.launch-btn/.test(cssSrc) && /\.launch-err/.test(cssSrc),
      '★ 两种状态有各自的样式（分得开不能只靠文案）');

    // ── 掉册留痕：自愈的另一半 ────────────────────────────────────
    ok(/roster\.dropouts\(/.test(serveSrc) && /payload\.dropouts/.test(serveSrc),
      '★★ /api/agents 真的把掉册记录带出来了');
    ok(/renderDropouts/.test(appSrc) && /dropouts/.test(appSrc),
      '★★★ 前端真的渲染了它 —— **自愈成功是最容易被彻底遗忘的那种事**：'
      + '警告只打在 agent 自己的终端里的话，界面上一个字都没有');
    ok(/不是掉出去的时刻/.test(appSrc),
      '★★ 界面明说这是「发现时刻」不是「掉出去的时刻」—— '
      + 'TTL 过期是静默的，编一个开始时间会让人算出一段假的失聪时长');
    ok(/\.drop-row/.test(cssSrc), '★ 有自己的样式');
  }

  await roster.unregister(redis, AGENT);
  await redis.del(STREAM);
  await redis.quit();


  // ══════════════════════════════════════════════════════════════════════
  // 🔴 `_busy`：有人在跑长任务时，poller 返回里要看得见
  //
  //   场景：一个 agent 在另一个 agent 跑全量的窗口里改了文件，
  //   让那一遍的 `worktree_changed_during_run` 作废、只能重跑。
  //   而 `anyBusy()` 那时**答得出**（对方 declare 过）—— 只是没有人问它。
  //   ⇒ ⇒ **一个工具被修好，不会让人开始使用它。** 所以把它挂到每轮都会读的地方。
  //
  //   ⚠️ **这一组必须成对**：只验「有人在跑 ⇒ 出现」的话，一个**恒把字段塞进去**的
  //   实现也能全绿；而那正是这条改动最要防的东西 ——
  //   **一个恒在的 `busy:false` 是一盏可能陈旧的绿灯，而拿着它的人更不会去查。**
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n【_busy】poller 返回里的「有人在跑」');
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-busy-'));
    const runBusy = (extra) => {
      const r = runNext(['--group', GROUP, '--consumer', `${AGENT}-1`,
                         '--streams', STREAM, '--name', AGENT, '--block', '150'],
                        { agentType: 'dev', extraEnv: { ENGLOOP_BUSY_ROOT: T, ...extra } });
      try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); }
      catch (_) { return null; }
    };

    // 🔴 ③ 正控（先跑它）：目录是空的 ⇒ 没有人在跑 ⇒ **字段不该出现**
    const empty = runBusy();
    ok(empty !== null, '⓪ poller 输出解析得了（这一组判据的前提）');
    ok(empty && !('_busy' in empty),
      '🔴 ③ **正控**：没有任何标记 ⇒ `_busy` **不出现** —— 不出现 = 没有灯，'
      + '而不是「查过了，没人在跑」', JSON.stringify(Object.keys(empty || {})));

    // 🔴 ④ 只有**死** pid 的标记 ⇒ 仍然不出现（`all_stale` ≠ 有人在跑）
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
    fs.writeFileSync(path.join(T, 'ghost.json'), JSON.stringify({
      agent: 'ghost', pid: deadPid, what: '一个刚退出的子进程',
      started_at: new Date().toISOString(),
    }));
    const stale = runBusy();
    ok(stale && !('_busy' in stale),
      '🔴 ④ 只有 pid 已死的陈标记 ⇒ 仍然**不出现**（否则 `temp/busy/` 里留下的'
      + '陈记录会让它恒真 —— 而恒真和恒假一样不携带「现在」的信息）',
      JSON.stringify(stale && stale._busy));

    // ① 加一个**活着**的标记 ⇒ 必须出现
    fs.writeFileSync(path.join(T, 'someone.json'), JSON.stringify({
      agent: 'someone', pid: process.pid, what: 'test/run-all.js（夹具）',
      // ⚠️ 用**现在**：`MAX_AGE_MS` 是 30 分钟兜底，用一个固定的旧时刻会被判过期
      started_at: new Date().toISOString(),
    }));
    const live = runBusy();
    ok(live && live._busy && Array.isArray(live._busy.who),
      '🔴 ① 有一个活标记 ⇒ `_busy` 出现', JSON.stringify(live && live._busy));
    // ② 第二个口径：不只看「出现了」，看它说的**是不是那件事**
    ok(live && live._busy && live._busy.who.includes('someone'),
      '🔴 ② 而 `who` 里是**测试造的那个名字** —— 只看「字段在」的话，'
      + '一个恒塞空对象的实现也能过', JSON.stringify(live && live._busy && live._busy.who));
    ok(live && live._busy && /run-all/.test(String(live._busy.what || '')),
      '② 而 `what` 带着他在跑什么 —— 没有它，读的人得再问一次');
    ok(live && live._busy && typeof live._busy.polled_at === 'string'
      && !Number.isNaN(Date.parse(live._busy.polled_at)),
      '🔴 ② `polled_at` 是一个**可解析的时刻** —— 给原料不给结论：'
      + '「多旧」只有读的人算得出（age 在这里恒等于 0）',
      JSON.stringify(live && live._busy && live._busy.polled_at));
    ok(live && live._busy && !('as_of_secs_ago' in live._busy)
      && !('age' in live._busy),
      '🔴 ② 而**没有** `age` / `as_of_secs_ago` —— 它会诱导「够新就信」，'
      + '而这一版一个「够新」的档都不给');

    // ⑤ 而 **timeout 那条出口**也要带 —— 挂在 alerts 上就是为了这个
    ok(live && live.timeout === true,
      '⑤ 而上面这些全是在 **timeout 出口**上验的（没有消息那一轮）'
      + ' —— 两个出口都展开 alerts，这一条钉住其中一个', JSON.stringify(live && live.timeout));

    fs.rmSync(T, { recursive: true, force: true });
  }

  // ── ★ 正向：**证明那条探针写进了隔离路径** ─────────────
  //
  //   🔴 只验「生产 `temp/probe-state-wiringtestcrew.json` 没出现」是不够的，它有两种成因：
  //     · 隔离生效了            · **探针根本没发**（`RESEND_AFTER_MS = 60 分钟`的不应期）
  //   ⇒ 而这一条只有一种成因 ⇒ ⇒ 它同时证明「隔离生效」和「那条路径真的跑了」。
  //
  //   ⚠️ 而它必须在 `process.on('exit')` 的清理**之前**跑 —— 那之后 PROBE_ROOT 就没了。
  //   📌 做法同 `test/e2e.test.js`。
  ok(fs.existsSync(path.join(PROBE_ROOT, 'probe-state.json')),
    '★★ 存活探针写进了**隔离**路径（正向 —— 「生产没出现」有两种成因，这条只有一种）',
    `PROBE_ROOT=${PROBE_ROOT}`);

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
