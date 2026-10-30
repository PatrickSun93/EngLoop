#!/usr/bin/env node
'use strict';

/**
 * Stop hook —— 常驻 agent 的回合要结束时，**默认拦回 poller**（S1B）。
 *
 * 由 `lib/agent-settings.js` 挂给**所有 crew**（不管有没有写能力）和**编排者**；worker 不挂（一次性的）。
 * 命令里写死 `--name <agent 名> --kind <crew|orchestrator>`（生成配置时写进去；agent 改不了自己的配置，冒不了别人的名）。
 *
 * ── 为什么要它 ─────────────────────────────────────────────────────────
 *   常驻 agent 的循环是「前台跑 next.js ⇒ 处理 ⇒ 再跑」—— poller 是**回合内**的一次 Bash 调用。
 *   ⇒ **回合结束 = 不在 poller 上 = 失聪**，而在这之前没有任何代码管这件事：
 *   兜底只有 watchdog 的 15/20/30 分钟（`temp/bus.log` 里「失聪 —— 已发送恢复指令」44 次，JARVIS 18 次）。
 *
 * ── 逻辑（顺序就是优先级）────────────────────────────────────────────────
 *   ① 暂停标记在（`bin/agent-pause.js`）       ⇒ 放行（paused）
 *   ② bus 的 /health 1 秒内不通、或 ok 不是 true ⇒ 放行（bus_down）—— poller 跑不起来，拦回去只是空转
 *      只问 127.0.0.1 的 /health，**不看端口有没有监听**（9969 上有个 tailnet 转发进程）。
 *      端口走 `bin/port-registry.js`（`ENGLOOP_PORT`）—— 跟 serve.js、stopViaBus 同一个出处 ⇒ 隔离 bus 换了端口这里跟着换。
 *   ③ bus 侧它在关停（`GET /api/agents/<name>/shutdown` 的 pending）⇒ 放行（shutdown）
 *      为什么用 bus 侧的 pending、不用「它发没发过 READY_TO_SHUTDOWN」：pending 从**请求那一刻**一直到会话被收掉都成立，
 *      覆盖「已经发了 READY、正等 bus 收」和「还没发」两段；而 READY 那条 outbox 文件 relay 读完就删了，hook 看不到。
 *      查不了（没有 admin token / 401 / 超时）⇒ 当意外放行（unexpected）—— **绝不能因为查不了就把关停流程卡住**。
 *      已知代价：关停请求还躺在收件流里没被读到时它就结束回合 ⇒ 放行 ⇒ 等 shutdown 的 3 分钟静默强杀 —— 跟没有这个 hook 时一样。
 *   ④ 上次拦之后它回到过 poller ⇒ 计数清零；连续拦了 BLOCK_LIMIT 次还没回去 ⇒ 放行（limit）
 *      「回到 poller」的判据和理由在 `lib/loop-guard.js` 头注（工具调用日志里有一次真的跑过的 next.js）。
 *   ⑤ 否则 ⇒ **exit 2 拦回去**，stderr 是给模型的一句指令（带它该跑的 poller 命令）。
 *   任何放行都写 `temp/loop-guard/<name>.stopped`（时刻 ＋ 原因）—— watchdog 看它决定要不要 60 秒后推一把。
 *
 * ── 为什么**不**看 `stop_hook_active` ────────────────────────────────────
 *   `stop_check.js` 见它就放行。这里不能：实测（2.1.314）被拦过一次之后，同一串续写里它**一直是 true**，
 *   中间跑了多少工具调用都一样 —— 照抄的话，第二次回合结束就失聪了。防死循环用 ④ 的 N 次上限，
 *   而 Claude Code 自己那个上限只数「中间没有工具调用的连续拦截」（第 9 次强行结束），兜不住「跑了别的工具就是不跑 poller」。
 *
 * 退出码：0 放行 · 2 拦。**任何意外都放行**（hook 自己坏了不能把 agent 卡死）—— 跟 stop_check 同一原则。
 */

const fs = require('node:fs');
const lg = require('../lib/loop-guard');

const HTTP_TIMEOUT_MS = 1000;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (_) {
    return {};   // 输入坏了不影响判断：这个 hook 不用 stdin 里的任何字段做决定（名字在命令行上）
  }
}

function busBase() {
  // resolve() 对不合法的 ENGLOOP_PORT 会抛（不回落到默认值）⇒ 走意外放行
  const { port } = require('../bin/port-registry').resolve('bus');
  return `http://127.0.0.1:${port}`;
}

/** @returns {Promise<{up:boolean, why?:string}>} */
async function busHealth(base) {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || body.ok !== true) return { up: false, why: `/health 返回 ${r.status}${body && body.redis ? `（redis ${body.redis}）` : ''}` };
    return { up: true };
  } catch (e) {
    return { up: false, why: `/health ${HTTP_TIMEOUT_MS} 毫秒内不通（${e.name === 'TimeoutError' ? '超时' : (e.cause && e.cause.code) || e.message}）` };
  }
}

/** @returns {Promise<{pending:boolean}|{error:string}>} */
async function shutdownState(base, name) {
  let token;
  try { token = require('../lib/auth').readAdminToken(); } catch (e) { return { error: `读不到 admin token（${e.code || e.message}）` }; }
  try {
    const r = await fetch(`${base}/api/agents/${encodeURIComponent(name)}/shutdown`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!r.ok) return { error: `关停状态查询返回 ${r.status}` };
    const body = await r.json();
    if (typeof body.pending !== 'boolean') return { error: '关停状态查询的响应里没有 pending' };
    return { pending: body.pending };
  } catch (e) {
    return { error: `关停状态查询失败（${e.name === 'TimeoutError' ? '超时' : e.message}）` };
  }
}

const SAY = {
  paused: '有暂停标记（人放的）—— 放行，停在这里',
  shutdown: 'bus 正在关停你 —— 放行（照关停指令做完就停，不要再跑 poller）',
  bus_down: 'bus 不在 —— poller 跑不起来，放行',
  limit: `连续拦了 ${lg.BLOCK_LIMIT} 次你都没回到 poller —— 放行，交给 watchdog（约 1–2 分钟后推你一把）`,
  unexpected: '出了意外 —— 放行，交给 watchdog',
};

function release(name, reason, detail = '') {
  try { lg.writeState(name, { blocks: 0, last_block_at: null }); } catch (_) { /* 计数写不了不影响放行 */ }
  try { lg.writeStopped(name, reason, detail); } catch (e) { detail += `；.stopped 没写成（${e.message}）`; }
  process.stderr.write(`[loop_guard] ${SAY[reason]}${detail ? `：${detail}` : ''}\n`);
  return 0;
}

async function main() {
  const name = argValue('--name');
  const kind = argValue('--kind') === 'orchestrator' ? 'orchestrator' : 'crew';
  readInput();
  if (!lg.NAME_RE.test(name || '')) {
    process.stderr.write(`[loop_guard] 命令行上的 --name 不合格（${JSON.stringify(name)}）—— 放行\n`);
    return 0;
  }
  if (lg.isPaused(name)) return release(name, 'paused');

  const base = busBase();
  const health = await busHealth(base);
  if (!health.up) return release(name, 'bus_down', health.why);
  const sd = await shutdownState(base, name);
  if (sd.error) return release(name, 'unexpected', `查不了你是不是在关停：${sd.error}`);
  if (sd.pending) return release(name, 'shutdown');

  const now = Date.now();
  const st = lg.readState(name);
  let blocks = st.blocks;
  if (blocks > 0 && st.last_block_at !== null && lg.polledSince(name, st.last_block_at).polled) blocks = 0;
  if (blocks >= lg.BLOCK_LIMIT) return release(name, 'limit', `上次回到 poller 之后连续拦了 ${blocks} 次`);

  lg.writeState(name, { blocks: blocks + 1, last_block_at: now });
  lg.clearStopped(name);   // 正在被拦回去 ⇒ 旧的 .stopped 不再说明任何事
  process.stderr.write(
    `[loop_guard] 你是常驻 agent，回合结束 = 不在 poller 上 = 失聪。现在前台跑 poller（Bash timeout 600000）：\n`
    + `  ${lg.pollerCommand({ kind, name })}\n`
    + (kind === 'crew' ? `然后读那个 poll 文件、照常处理。` : '然后照常处理。')
    + `（第 ${blocks + 1} 次拦；连续 ${lg.BLOCK_LIMIT} 次没回到 poller 就放行。人要你停，由人放暂停标记 —— 不是你自己决定。）\n`);
  return 2;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => {
    const name = argValue('--name');
    try { if (lg.NAME_RE.test(name || '')) lg.writeStopped(name, 'unexpected', `hook 自己出错：${e && e.message}`); } catch (_) { /* 写不了就算了 */ }
    try { process.stderr.write(`[loop_guard] hook 自己出错了，这次不拦：${e && e.message}\n`); } catch (_) { /* 连 stderr 都不行就算了 */ }
    process.exit(0);
  });
}
