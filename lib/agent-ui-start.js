'use strict';

/**
 * 从界面开启一个 agent —— `POST /api/agents/:name/start` 背后的那一半。
 *
 * ── ⚠️ 这个动作花钱 ─────────────────────────────────────────────
 * 点一下 = 开一个 claude 会话 = 消耗用户的额度。所以：
 *   · **没有任何自动触发路径** —— 不重试、不「检测到离线就起」。
 *     调用它的只有一条路：人点了那个按钮。
 *   · 已经在册的直接拒绝，不「顺便重启一下」。
 * 开不开由人决定：按钮在人手上。
 *
 * ── ★ 这个模块存在的真正理由：让失败说得出话 ──────────────────
 * 起一个 agent 要等 tmux TUI 就绪，最长约 90 秒 —— HTTP 请求不能挂在
 * 那儿等。于是它必须异步，而异步的代价是：
 *
 *   **「正在起」和「起失败了」在界面上会长成同一个样子**
 *   （都是「它还没出现在花名册里」）
 *
 * 人会盯着一个永远不动的界面。所以这里存一份进行中状态，把三种情况分开：
 * ```
 * starting      spawn 出去了，还没结果          → 界面「正在起…」
 * spawn_failed  进程非零退出                     → 界面报错误码 + stderr
 * not_in_roster ★ 进程成功退出，花名册里却没有   → 最隐蔽的一种
 * ```
 * ★★ 第三种是关键：**`agent-start` 退出码为 0 不等于 agent 在册。**
 *   以花名册为准，不以退出码为准 —— 退出码说的是「命令跑完了」，不是「它活着」。
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/** 起一个 agent 最多等多久（agent-start 自己等 TUI 就绪最长 90 秒）。 */
const LAUNCH_TIMEOUT_MS = 180000;

/** 进行中 / 刚失败的记录保留多久 —— 失败信息要活得够久，人才看得到。 */
const KEEP_MS = 10 * 60 * 1000;

/**
 * ⚠️ 进程内内存。bus 重启就没了 —— **这是对的**：重启之后花名册才是真相，
 *   一份活过重启的「正在起」记录只会撒谎。
 */
const inflight = new Map();

function snapshot(now = Date.now()) {
  const out = {};
  for (const [name, rec] of inflight) {
    if (now - rec.at > KEEP_MS) { inflight.delete(name); continue; }
    out[name] = { ...rec };
  }
  return out;
}

function clear() { inflight.clear(); }

/**
 * 起一个 agent。**校验全部在这里做**，不指望调用方 —— 这是唯一入口。
 *
 * @param {object} deps  { candidates, registry, spawnFn }  注入是为了可测
 * @returns {{ok:boolean, code?:string, message?:string, name?:string, type?:string}}
 */
function start(name, { candidates, registry, spawnFn = spawn, now = Date.now() } = {}) {
  // ① 名字必须来自候选清单本身。**不做字符校验就放行** ——
  //    白名单比黑名单可靠：名字最终会进 tmux 会话名和 shell 命令行。
  const cand = (candidates || []).find((c) => c.name === name);
  if (!cand) {
    return { ok: false, code: 'UNKNOWN_CREW',
      message: `agents/ 目录里没有可起的「${name}」——`
        + ' 候选来自扫描 agents/*/CLAUDE.md，没有模板的目录不算。' };
  }

  // ② 已在册的拒绝。**不「顺便重启一下」** —— 那会悄悄花掉一次额度。
  if ((registry || []).some((r) => r && r.name === name)) {
    return { ok: false, code: 'ALREADY_ONLINE',
      message: `${name} 已经在花名册里。要重起先停它（这个按钮不做重启，`
        + '因为「重启」和「开启」花的额度一样，但只有一个是你点它时想要的）。' };
  }

  // ③ type 推不出来就拒绝，**不默认 'dev'**。
  //    起一个类型错的 agent，hook 会 fail-closed 拒掉它每一次工具调用，
  //    而那个现场跟「hook 正常工作」长得一模一样（全是 REJECT）。
  if (!cand.type) {
    return { ok: false, code: 'TYPE_UNKNOWN',
      message: `推不出 ${name} 的类型（CLAUDE.md 首行不是「# <名字> — <类型> agent」）。`
        + ' 不默认成 dev：类型错了之后的故障现场跟一切正常长得一样。' };
  }

  if (inflight.has(name) && inflight.get(name).status === 'starting') {
    return { ok: false, code: 'ALREADY_STARTING',
      message: `${name} 正在起，等它。` };
  }

  inflight.set(name, { status: 'starting', at: now, type: cand.type });

  const child = spawnFn(process.execPath,
    [path.join(ROOT, 'bin', 'agent-start.js'), '--name', name, '--type', cand.type],
    { cwd: ROOT, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  if (child.stderr) child.stderr.on('data', (d) => { stderr += String(d); });
  if (child.stdout) child.stdout.on('data', () => {});

  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
    inflight.set(name, {
      status: 'spawn_failed', at: Date.now(), type: cand.type,
      error: `超过 ${Math.round(LAUNCH_TIMEOUT_MS / 1000)} 秒还没起来，已放弃。`,
    });
  }, LAUNCH_TIMEOUT_MS);
  if (timer.unref) timer.unref();

  child.on('error', (err) => {
    clearTimeout(timer);
    inflight.set(name, { status: 'spawn_failed', at: Date.now(), type: cand.type,
      error: String(err.message || err) });
  });

  child.on('exit', (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      inflight.set(name, { status: 'spawn_failed', at: Date.now(), type: cand.type,
        error: `agent-start 退出码 ${code}${stderr ? `：${stderr.trim().slice(0, 400)}` : ''}` });
      return;
    }
    // ★★ 退出码 0 **不等于**它在册了。这里只标「跑完了」，
    //    真相由 /api/agents 下一次拿花名册去比对（见 settleAgainstRoster）。
    inflight.set(name, { status: 'spawned', at: Date.now(), type: cand.type });
  });

  return { ok: true, name, type: cand.type };
}

/**
 * ★★ 拿花名册给 inflight 记录结账 —— 每次 `/api/agents` 调一次。
 *
 * 这是「退出码 0 ≠ 它活着」那条的落地：进程说跑完了，**花名册说了才算**。
 * 在册 → 记录删掉（它上线了，界面自然会显示它）。
 * 不在册 → 标成 `not_in_roster`，**界面必须把这个说出来** ——
 * 否则它跟「正在起」一样是「界面上没有它」，人会一直等下去。
 */
function settleAgainstRoster(registry, now = Date.now()) {
  const online = new Set((registry || []).map((r) => r && r.name).filter(Boolean));
  for (const [name, rec] of inflight) {
    if (online.has(name)) { inflight.delete(name); continue; }
    if (rec.status === 'spawned') {
      inflight.set(name, {
        status: 'not_in_roster', at: now, type: rec.type,
        error: 'agent-start 正常退出，但它没出现在花名册里 —— '
          + '会话可能起来了却没心跳，用 `tmux attach -t agent_' + name + '` 看一眼。',
      });
    }
  }
  return snapshot(now);
}

module.exports = {
  LAUNCH_TIMEOUT_MS, KEEP_MS,
  start, snapshot, clear, settleAgainstRoster,
};
