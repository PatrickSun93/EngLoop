'use strict';

/**
 * 端口注册表。
 *
 * ── 两件事，别混起来 ─────────────────────────────────────────────
 *   1. **端口该归谁** —— 一张表，唯一出处。
 *   2. **端口现在能不能用** —— 真去绑一次。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 两个服务各自写死一个「默认端口」，谁都没错，撞了才知道。
 *
 * 同一个默认端口在多个文件里各写一份（比如 `bin/serve.js` · `bin/bus-restart.js` ·
 * `bin/placeholder-server.js` · `bin/preflight.sh` 各写 `ENGLOOP_PORT || 9969`）时，
 * **几份分叉时不会有任何东西变红。**
 *
 * ── ★ 最要紧的一条判据 ──────────────────────────────────────────
 *
 *   **判据必须是「新进程能不能 listen 成功」，不是「lsof 说没人占」。**
 *
 * `lsof` 报的 PID 可能已经死了、`kill` 说 no such process，
 * **而端口仍然绑不上**。`lsof` 会给出过期信息。
 *
 * 推论：**能直接试的事，别去问一个可能过期的目录。**
 * 所以 `probe()` 真的去 `listen()` 一次。`identify()` 那套查「是谁占着」
 * 的东西只用来给人看，**在判定里没有投票权** —— 它返回的是线索，不是事实。
 *
 * ── ⚠️ probe() 有一个消不掉的窗口，别把它当成保证 ────────────────
 * 试探成功 → 关掉 → 真正启动，这中间端口可能被别人抢走（TOCTOU）。
 * 任何「先查再用」的检查都有这个窗口，绕不过去。
 *
 * 所以这里的分工是：
 *   `probe()`      = **诊断**。启动前给人一句能读懂的话，附带修复命令。
 *   listen 的 error handler = **判据**。绑不上时进程必须响亮地死，
 *                              而不是抛一个没人看的堆栈。
 *
 * **两个都要。** 只留 probe 会在那个窗口里静默失败；只留 handler 则
 * 每次冲突都要等到进程起来又死掉才知道，而人看不到那个 stderr。
 */

const net = require('node:net');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

/**
 * ── 注册表 ──────────────────────────────────────────────────────
 *
 * 端口的**唯一出处**。要加服务就往这里加，不要在别处再写一个默认值。
 *
 * `host` 不是装饰 —— 它必须跟服务真正 `listen()` 时用的地址**一模一样**。
 * 绑 `127.0.0.1` 的服务拿 `0.0.0.0` 去试探，是在试一件不同的事：
 * 两者的冲突规则不同，试探会给出一个跟真实启动不一致的答案。
 * **换个地方骗人，比不检查更糟。**
 */
const REGISTRY = Object.freeze({
  bus: Object.freeze({
    port: 9969,
    host: '127.0.0.1',
    env: 'ENGLOOP_PORT',
    desc: 'EngLoop bus（HTTP + WebSocket）',
    // 起它的命令 —— 冲突诊断里要把这句原样给人，省得再去翻文档
    start: 'node bin/bus-restart.js',
  }),
});

/** 已登记的服务名。 */
function names() {
  return Object.keys(REGISTRY);
}

/**
 * 查一个服务该用的端口。
 *
 * env 覆盖仍然支持（现有部署靠它），但**默认值只有这一份**。
 *
 * ★ 非法的 env 值**报错，不静默回落到默认**（fail-closed）。
 *   `ENGLOOP_PORT=abc` 回落成 9969 的话，人以为自己换了端口、
 *   实际没换，而这跟「换成功了」长得一模一样。
 */
function resolve(name) {
  const entry = REGISTRY[name];
  if (!entry) {
    throw Object.assign(
      new Error(`端口注册表里没有服务 '${name}'。已登记: ${names().join(', ') || '（空）'}`),
      { code: 'UNKNOWN_SERVICE' });
  }

  let port = entry.port;
  let source = 'registry';
  const raw = entry.env ? process.env[entry.env] : undefined;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw Object.assign(
        new Error(`${entry.env}='${raw}' 不是合法端口（要 1–65535 的整数）。`
          + `**没有回落到默认值 ${entry.port}** —— 静默回落会让你以为端口换了，而它没换。`),
        { code: 'BAD_PORT_ENV' });
    }
    port = n;
    source = entry.env;
  }

  return {
    name, port, host: entry.host, source,
    desc: entry.desc, start: entry.start, env: entry.env,
  };
}

/**
 * ★ 真去绑一次。**这是唯一有投票权的判据。**
 *
 * 用 `net.createServer().listen()` —— 跟 `bin/serve.js` 起 HTTP server
 * 走的是同一套底层 bind，同样的 SO_REUSEADDR 默认（所以 TIME_WAIT 的
 * socket 在两边都不算冲突，行为一致）。**试探和真实启动必须可传递**，
 * 否则试探就是在回答另一个问题。
 *
 * 返回值里 `available` 只有两种来源：
 *   - 绑上了            → true
 *   - 绑不上（任何原因）→ false，并带上原始 errno
 *
 * ★ **没有第三条路。** 探测本身出意外（超时、抛异常）也算
 *   `available: false`，而不是「就当能用吧」。「查不了」和「它空着」
 *   是两个完全不同的事实，任何把前者读成后者的代码都是个洞
 *   （比如把「命令不存在」读成「没有会话」）。
 *   调用方要区分这两者，看 `code`：`EADDRINUSE` 是「有人占着」，
 *   `PROBE_FAILED` / `PROBE_TIMEOUT` 是「没查成」。
 */
function probe({ port, host }, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve_) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve_(v); } };

    let server;
    try {
      server = net.createServer();
    } catch (err) {
      // 连 server 都造不出来 —— 极不寻常，但绝不能因此说「端口可用」
      return done({ available: false, port, host, code: 'PROBE_FAILED', detail: err.message });
    }

    // 试探卡住也算失败。**卡住 ≠ 空闲。**
    const timer = setTimeout(() => {
      try { server.close(); } catch (_) { /* 已经在关了 */ }
      done({
        available: false, port, host, code: 'PROBE_TIMEOUT',
        detail: `${timeoutMs}ms 内既没绑上也没报错 —— 这不是「端口空着」，是「没查出结果」`,
      });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    server.once('error', (err) => {
      clearTimeout(timer);
      try { server.close(); } catch (_) { /* 没绑上，本来就没开 */ }
      done({
        available: false, port, host,
        code: err.code || 'PROBE_FAILED',
        detail: err.message,
      });
    });

    server.once('listening', () => {
      clearTimeout(timer);
      // 立刻放开 —— 只是问一个问题，不是要占住它
      server.close(() => done({ available: true, port, host, code: null }));
    });

    try {
      server.listen(port, host);
    } catch (err) {
      // listen() 同步抛（比如 host 非法）—— error 事件不会来，这里兜住
      clearTimeout(timer);
      done({ available: false, port, host, code: err.code || 'PROBE_FAILED', detail: err.message });
    }
  });
}

/**
 * 尽力查「是谁占着这个端口」。
 *
 * ⚠️ **这是线索，不是判据。** 判定端口能不能用只看 `probe()`。
 *
 * 这里给出的每一条都可能是错的或过期的：
 *   - HTTP 探测：占着端口的东西可能根本不说 HTTP
 *   - `ps` 匹配命令行：进程可能已经死了而端口还没放开，
 *     也可能有个同名进程压根没绑这个端口
 *
 * ★ 查不出来时返回 `{ known: false, reason }`，**不返回空对象**。
 *   「没查到占用者」和「没人占」必须能分开 —— 前者是诊断的无知，
 *   后者是关于世界的断言，而这里没资格做后一个断言。
 */
async function identify({ port, host }, { processPattern = /bin\/serve\.js(\s|$)/ } = {}) {
  const clues = [];

  // 线索 1：它说 HTTP 吗？说的话是不是 EngLoop 的 bus？
  const hint = await httpHint({ port, host });
  if (hint) clues.push(hint);

  // 线索 2：ps 里有没有长得像的进程
  try {
    const out = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8' });
    const pids = [];
    for (const line of out.split('\n')) {
      if (!processPattern.test(line)) continue;
      const m = line.trim().match(/^(\d+)\s/);
      if (m) pids.push(Number(m[1]));
    }
    if (pids.length) {
      clues.push(`ps 里有匹配的进程: ${pids.join(', ')}（**没有验证它们绑的就是这个端口**）`);
    }
  } catch (err) {
    // ★ 查不了 ≠ 没有。说出来，不要当成「ps 显示没有进程」。
    clues.push(`ps 查不了（${err.message}）—— 这不是「没有进程」`);
  }

  if (clues.length === 0) {
    return {
      known: false,
      reason: '端口绑不上，但既不应答 HTTP，ps 里也没有认识的进程 —— '
        + '占用者是别的东西，或者是个已退出但 socket 未释放的进程',
      clues: [],
    };
  }
  return { known: true, clues };
}

/**
 * HTTP 线索。返回 null 表示「没问出东西」，不表示「没人在」。
 *
 * ★ `agent: false` 不是可选的 —— **一个诊断工具不该改变它正在诊断的东西。**
 *
 *   Node 19 起 globalAgent 默认 `keepAlive: true`：请求结束后 socket 被放回
 *   空闲池，**不关**。于是每问一次，就在被诊断的服务上留下一条活着的连接。
 *
 *   占用者是个真 HTTP server 时：
 *     带 `agent: false`  → identify 之后目标剩余连接数 **0**
 *     摘掉它            → identify 之后目标剩余连接数 **1**
 *
 *   排查一次端口冲突要问好几轮，那就是好几条。
 *
 * ⚠️ 别把这条读成「它能防住连接挂死」—— **不能**。占用者如果是个不读
 *   socket 的裸 server（没 resume 就看不到 FIN），连接照样挂在那儿，
 *   跟 agent 设成什么无关。那是对方的行为，不是这里能修的。
 */
function httpHint({ port, host }, timeoutMs = 1000) {
  return new Promise((resolve_) => {
    const req = http.get({ host, port, path: '/api/health', timeout: timeoutMs, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let pid = null;
        try { pid = JSON.parse(body).pid; } catch (_) { /* 不是 bus 的格式 */ }
        resolve_(`有东西在这个端口上应答 HTTP /api/health（${res.statusCode}`
          + `${pid ? `, pid=${pid}` : ''}）—— 多半是**已经在跑的 bus**`);
      });
    });
    req.on('error', () => resolve_(null));
    req.on('timeout', () => { req.destroy(); resolve_(null); });
  });
}

/**
 * 启动前检查：端口能用就返回，不能用就抛一个**人能照着做**的错。
 *
 * 服务在 `listen()` 之前调这个。它**不能替代** listen 的 error handler
 * （见文件头的 TOCTOU 说明）—— 它只是把「大多数情况下的冲突」提前到
 * 一个有上下文、有修复命令的位置说出来。
 */
async function assertAvailable(name, opts = {}) {
  const target = resolve(name);
  const r = await probe(target, opts);
  if (r.available) return target;

  const who = await identify(target);
  throw Object.assign(new Error(formatConflict(target, r, who)), {
    code: 'PORT_UNAVAILABLE',
    probe: r,
    target,
  });
}

/** 把冲突写成人能直接照着做的几行。 */
function formatConflict(target, probeResult, who) {
  const lines = [];
  lines.push(`端口 ${target.host}:${target.port} 绑不上（${probeResult.code}）—— `
    + `${target.desc} 起不来。`);
  lines.push(`  端口来源: ${target.source === 'registry'
    ? 'bin/port-registry.js 的注册表'
    : `环境变量 ${target.source}`}`);

  if (probeResult.code === 'EADDRINUSE') {
    lines.push('  有人占着它。线索：');
  } else if (probeResult.code === 'EACCES') {
    lines.push('  没权限绑这个端口（1024 以下要 root）。线索：');
  } else {
    // ★ 探测自己失败了。**别把这说成「端口被占」** —— 并不知道。
    lines.push(`  **注意：这不是「确认被占」，是「没查出结果」**（${probeResult.detail || ''}）。线索：`);
  }

  if (who.known) {
    for (const c of who.clues) lines.push(`    · ${c}`);
  } else {
    lines.push(`    · ${who.reason}`);
  }

  lines.push('  怎么办：');
  lines.push(`    · 看现状      node bin/bus-restart.js --status`);
  lines.push(`    · 停掉旧的再起 ${target.start}`);
  if (target.env) {
    lines.push(`    · 换个端口    ${target.env}=<其他端口> ${target.start}`);
  }
  return lines.join('\n');
}

/**
 * 给 `server.listen()` 挂的 error handler —— **最终判据在这里**。
 *
 * 不挂 handler 的话：EADDRINUSE 会抛未捕获异常，
 * 进程带着一段堆栈崩掉。而 bus 是 detached spawn 起来的，stderr 进了
 * 日志文件 —— **没人会去看**。于是「起失败了」和「起好了」
 * 在人这边长得一模一样。这就是「静默失败」的机制。
 *
 * 挂上之后：说清楚是什么、给出修复命令、用一个**能区分开的退出码**。
 */
function installListenErrorHandler(server, target, { onLog = console.error, exit = true } = {}) {
  server.on('error', async (err) => {
    if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
      onLog(`[bus] listen 失败: ${err.code || ''} ${err.message}`);
      if (exit) process.exit(75);   // 75 = EX_TEMPFAIL
      return;
    }
    const who = await identify(target).catch(() => ({ known: false, reason: '查占用者时也出错了', clues: [] }));
    onLog('');
    onLog(formatConflict(target, { available: false, code: err.code, detail: err.message }, who));
    onLog('');
    // ★ 专用退出码：让脚本能把「端口冲突」跟「别的崩法」分开处理。
    //   全都 exit(1) 的话，调用方只能去 grep 日志文本 —— 那会随文案漂移。
    if (exit) process.exit(78);     // 78 = EX_CONFIG
  });
}

module.exports = {
  REGISTRY,
  names,
  resolve,
  probe,
  identify,
  assertAvailable,
  formatConflict,
  installListenErrorHandler,
  EXIT_PORT_CONFLICT: 78,
};

// ── CLI ─────────────────────────────────────────────────────────
//
// shell 脚本没法 `require()` 这个模块，但**它们也不该各自再写一份默认端口**
// （比如 `${ENGLOOP_PORT:-9969}`）。给它们一个能问的地方：
//
//   node bin/port-registry.js --port bus     只打印端口号（给 shell 用）
//   node bin/port-registry.js --check bus    试探；能用 exit 0，不能用 exit 78
//   node bin/port-registry.js                列出全表 + 每个端口的真实现状
//
// ⚠️ `--port` 在 env 非法时**报错并 exit 78，不打印默认值** —— 打印默认值
//    会让 shell 侧拿到一个跟服务实际要用的端口不同的数字，而两边都不会报错。

async function cli(argv) {
  const [flag, name] = argv;

  if (flag === '--port') {
    const t = resolve(name || 'bus');
    process.stdout.write(`${t.port}\n`);
    return 0;
  }

  if (flag === '--check') {
    const t = resolve(name || 'bus');
    const r = await probe(t);
    if (r.available) {
      console.log(`✓ ${t.host}:${t.port} 可用（${t.desc}）`);
      return 0;
    }
    const who = await identify(t);
    console.error(formatConflict(t, r, who));
    return 78;
  }

  // 默认：列全表。**每一行的「现状」都是真绑一次问出来的**，不是查表。
  for (const n of names()) {
    const t = resolve(n);
    const r = await probe(t);
    const state = r.available
      ? '空闲'
      : (r.code === 'EADDRINUSE' ? '被占用' : `查不出（${r.code}）`);
    console.log(`${n.padEnd(10)} ${t.host}:${t.port}  [${state}]  ${t.desc}`);
    console.log(`${''.padEnd(10)} 来源: ${t.source === 'registry' ? '注册表' : `环境变量 ${t.source}`}`);
  }
  return 0;
}

if (require.main === module) {
  cli(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`✗ ${err.message}`);
      // 配置类错误（未知服务、非法 env）用 78，跟端口冲突同类：都是「配置不对」
      process.exitCode = err.code === 'UNKNOWN_SERVICE' || err.code === 'BAD_PORT_ENV' ? 78 : 1;
    });
}
