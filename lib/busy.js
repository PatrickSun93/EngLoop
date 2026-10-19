'use strict';

/**
 * 「我正在跑一个长任务」的申报 —— 让 watchdog 知道别推。
 *
 * ── 它治的是什么 ────────────────────────────────────────────────
 * watchdog 的 outbox 判据（「还在写 outbox 就是忙，不是聋」）**对一整类情况无解**：
 * **跑单次长 Bash 调用的 agent 在调用期间没有执行权，写不了任何东西。**
 * `lib/watchdog.js` 里那段长注释写明了这是「无解，不是覆盖不全」。
 *
 * 全量测试（`node test/run-all.js`）要跑几分钟，
 * 和 `NUDGE_MS(1200s)` 是同一个量级，而且测试规模还在涨。
 *
 * ── 解法：不是让 agent 报进度（做不到），是让**那个任务自己**报 ──────
 * agent 在长调用期间没有执行权，**但它启动的那个子进程有** ——
 * 而 `test/run-all.js` 是这个仓库自己的代码，可以在里面申报。
 *
 * ★★ **判据是 `process.kill(pid, 0)`，不是时间戳。**
 *   这是这个模块的全部价值：
 *   · 标记残留（进程崩了没删）→ pid 不存在 → **否决自动失效，不用清理**
 *   · **不用猜「长任务要跑多久」** —— 猜出来的 TTL 短了误伤、长了留后门
 *   跟 outbox 判据是同一个思路（找一个独立信号源），
 *   **只是这次那个源在下面一层**。
 *
 * ── ⚠️ 三条边界，一条都不含糊 ───────────────────────────────────
 *
 * **① 覆盖不全，而且是结构性的。** 只有**写了申报的脚本**受保护。
 *    agent 跑一个第三方长命令（`npm install`）照样会被误判。
 *    **这不是「以后补上」，是这个方案的形状** —— 它保护「合作的长任务」，
 *    不保护「任意长任务」。
 *
 * **② 它没有修好那个代理。** watchdog 用「没在读队列」代理「失聪」，
 *    而长任务期间那两者天然一致。
 *    **这个模块不是修好了代理，是给它开了一个显式的例外出口。**
 *    别读成「那个代理现在没问题了」。
 *
 * **③ 可以被伪造。** agent 能写任意文件，所以能写一个指向长命进程的假标记
 *    来永久静默 watchdog。**这个系统里 agent 是受信的，不是敌人**，
 *    所以这里不做防伪。`MAX_AGE_MS` 是那个风险的上限 ——
 *    **它是一条信任假设下的兜底，不是安全边界。**
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ⚠️ 可被 \`ENGLOOP_BUSY_ROOT\` 覆盖 —— 而它不是新惯例：仓库里已经有
//   \`ENGLOOP_OUTBOX_ROOT\` / \`ENGLOOP_HISTORY_ROOT\` / \`ENGLOOP_OUTPUTS_ROOT\` /
//   \`ENGLOOP_THREAD_ALERT_DIR\` 四个同名形状。
//
//   🔴 为什么需要它：\`check(name,{root})\` / \`anyBusy({root})\` 都接受 root，
//   **而唯一的生产调用点**（\`bin/next.js\` 的 \`_busy\` 字段）无参调用它
//   ⇒ ⇒ 于是测试跑 next.js 时读的是**真实的** \`temp/busy/\` ——
//   夹具会污染另外两个 agent，而另外两个 agent 的 declare 会让判据随机红。
//   ★ **「这个模块可测」和「这条路径可测」是两回事** —— 前者会让人以为答完了后者。
const BUSY_ROOT = process.env.ENGLOOP_BUSY_ROOT
  || path.join(__dirname, '..', 'temp', 'busy');

/**
 * 兜底上限。**它不是判据** —— 判据是 pid 存活（见文件头）。
 *
 * 它挡两件事：pid 复用（进程死了、pid 被别的进程占了），
 * 以及一个写坏了/被伪造的标记永久生效。
 */
const MAX_AGE_MS = 30 * 60 * 1000;

const fileFor = (name, root = BUSY_ROOT) => path.join(root, `${name}.json`);

/**
 * 我是哪个 agent —— **从 tmux 会话名反推**。
 *
 * ★★ 为什么不是 `ENGLOOP_AGENT_TYPE`：
 *   · 那是**类型**不是**名字**（`dev2` / `dev3` 的类型都是 `dev`，
 *     标记文件会互相覆盖）
 *   · 而且它是启动时注入的，**dev 自己那条「必须带前缀」的绕过就建在它上面**
 *     —— 把这个模块架在一个已知的绕过之上，是把两个问题绑在一起
 *
 * ★ 会话名是**不可伪造的事实**：进程真的在那个会话里，不是谁告诉它的。
 *   而 `watchdog.sessionToName()` 是那个约定的逆向唯一出处，
 *   `test/watchdog-liveness` 里有**往返断言**守着它跟正向互逆。
 *
 * ★ 顺带：watchdog 判定用的正是会话名，**两边用同一个标识天然对得上** ——
 *   不会出现「标记写给 dev、watchdog 在找 dev2」。
 *
 * @returns {string|null} agent 名；**拿不到返回 null**（见 `declare()`）
 */
function whoami({ run = null, env = process.env } = {}) {
  // 不在 tmux 里就不用问了 —— 而那本身就是「这次不是 agent 在跑」的信号
  if (!env.TMUX && !env.TMUX_PANE) return null;
  try {
    const exec = run || ((args) => execFileSync('tmux', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    }));
    const session = String(exec(['display-message', '-p', '#S'])).trim();
    if (!session) return null;
    // ★ 反推走 watchdog 那份唯一实现，不在这里自己 `slice('agent_'.length)`
    //   —— 那就是第二份实现，而它分叉时两边各自都「正常工作」。
    const { sessionToName, isAgentSession } = require('./watchdog');
    if (!isAgentSession(session)) return null;   // 人自己开的会话，不是 agent
    return sessionToName(session);
  } catch (_) {
    return null;
  }
}

/**
 * 申报「我在跑一个长任务」。返回一个 `release()`。
 *
 * ★★ **拿不到 agent 名时不写标记，但出声。**
 *
 *   给的两个选项都不选：写一个通用名 = **给所有 agent 开后门**
 *   （一个 agent 写的标记会保护所有人）；静默不写 = 失去保护且无人知道。
 *
 *   第三个选项成立，因为**那两件事其实是同一件事**：
 *
 *   > **「拿不到 agent 名」和「这次不是某个 agent 在跑」是同一个情形。**
 *
 *   `run-all.js` 不在 tmux 里跑是完全正常的（人在自己终端跑、CI 跑），
 *   而那时候本来就**不该**有任何 agent 免疫 watchdog —— 没有 agent 在等它。
 *   **所以「拿不到 → 不写」不是退让，是语义正确。**
 */
function declare(what, { root = BUSY_ROOT, name = undefined, onLog = () => {} } = {}) {
  const agent = name !== undefined ? name : whoami();
  if (!agent) {
    onLog('[busy] 没在 agent 的 tmux 会话里跑，未写 busy 标记'
        + ' —— 这次不是某个 agent 在跑，本来也不该有谁免疫 watchdog。');
    return { declared: false, release: () => {} };
  }

  const file = fileFor(agent, root);
  const record = {
    agent,
    pid: process.pid,
    what: String(what || 'unknown'),
    started_at: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  } catch (err) {
    // 写不了不该让任务跑不下去 —— 但**不许静默**：失去保护要说出来。
    onLog(`[busy] 写不了 busy 标记（${err.message}）—— 这次没有保护，可能被 watchdog 推。`);
    return { declared: false, release: () => {} };
  }

  // ── 🔴 写完之后**读一遍别人** ──────────────────────────────────────
  //
  //   只写不读的 `declare` 是一份**申报**，不是一把**锁**：
  //   它告诉 watchdog「别来推我」，却从不告诉调用者「已经有人在跑了」。
  //   两个 agent 各自 `declare` 之后可能**同时**跑全量，
  //   而有些测试的清理规则是跨实例生效的，两遍并发会互相踩掉对方的文件。
  //
  // ⚠️ **只报告，不阻止。** 「有人在跑」不一定意味着「我不能跑」——
  //   那是调用者的判断，而这一层不该替他做。
  //   （而它也不能阻止：等这里返回时，调用者已经决定要跑了。）
  try {
    const others = anyBusy({ root }).records.filter((r) => r && r.agent !== agent);
    if (others.length) {
      onLog(`[busy] ⚠️ 现在还有 ${others.length} 个人在跑：`
        + others.map((r) => `${r.agent}（${r.what}）`).join(' · ')
        + ' —— **这不阻止你**，但如果你要跑的是测量类任务，先想清楚要不要等。');
    }
  } catch (_) { /* 读不到别人不该影响自己的申报 */ }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { fs.unlinkSync(file); } catch (_) { /* 已经没了也算删掉了 */ }
  };
  // ★ 兜底：进程正常退出/被信号打断都删掉。
  //   **删不掉也没关系** —— pid 存活判据会让残留标记自动失效（文件头 ★★）。
  process.once('exit', release);
  onLog(`[busy] 已申报：${agent} pid=${record.pid} ${record.what}`);
  return { declared: true, file, record, release };
}

/**
 * 某个 agent 现在有没有在跑长任务。**给 watchdog 用。**
 *
 * @returns {{busy:boolean, reason:string, record?:object, age_ms?:number}}
 *   `reason` 说得出为什么 —— 「没有标记」「进程已退出」「太旧了」
 *   是三种不同的情况，而它们都会让结果是 `busy:false`。
 *   **压成一个布尔的话，「它没在跑」和「标记坏了」在日志里长得一样。**
 */
function check(name, { root = BUSY_ROOT, now = Date.now(), alive = null } = {}) {
  const isAlive = alive || ((pid) => {
    try { process.kill(pid, 0); return true; }
    // ★ EPERM = 进程存在但当前进程没权限给它发信号 → **当成「在」**。
    //   跟 `bin/bus-restart.js` 的 pidAlive 同一个判断，理由也一样：
    //   不确定的时候往「它还在」那边错。
    catch (err) { return err.code !== 'ESRCH'; }
  });

  // ── 🔴 无参 = 「**有没有任何人**在忙」，不是「叫 undefined 的那个人在不在忙」──
  //
  //   不拦的话：`check()` 不传名字 ⇒ `fileFor(undefined)` ⇒ 去读
  //   `temp/busy/**undefined.json**` ⇒ 一个**永远不存在**的文件 ⇒ 永远 `no_marker`。
  //   这个恒假值看起来就是「现在没人在跑」，会被当成可以动手的凭据。
  //
  //   ⚠️ 传了名字的调用（如 `check('dev2')`）是对的：它真的读了文件、真的判了 pid。
  //   所以只验那个形式，验不出无参形式恒假。
  //
  //   ★ 语义上这才是对的：「该不该写文件 / 该不该跑全量」问的是
  //   **「有没有任何人在跑」**，而不是「某个特定的人在不在跑」——
  //   后者要求提问的人**先知道该问谁**，而那恰恰是他不知道的东西。
  if (name === undefined || name === null || name === '') {
    throw new TypeError(
      'busy.check() 需要一个 agent 名。你要问的多半是 **anyBusy()**（有没有任何人在忙）。\n'
      + '  ⚠️ 这里要是不抛错：check() 会去读 temp/busy/undefined.json —— '
      + '一个永远不存在的文件 ⇒ **永远返回 {busy:false, reason:"no_marker"}**。\n'
      + '  调用方会拿它当「现在没人在跑」的凭据，于是两遍全量可能真的并发跑起来，'
      + '互相踩红测试。\n'
      + '  ⇒ 抛错不是防御性编程：它把一次**静默的恒假**，换成一次**响亮的失败**。');
  }

  let raw;
  try {
    raw = fs.readFileSync(fileFor(name, root), 'utf8');
  } catch (_) {
    return { busy: false, reason: 'no_marker' };
  }

  let rec;
  try { rec = JSON.parse(raw); } catch (err) {
    return { busy: false, reason: 'corrupt', detail: String(err.message) };
  }
  if (!rec || typeof rec.pid !== 'number') {
    return { busy: false, reason: 'corrupt', detail: '缺 pid' };
  }

  // ★★ 主判据：那个进程还活着吗。**不是「标记写了多久」。**
  if (!isAlive(rec.pid)) {
    return { busy: false, reason: 'pid_gone', record: rec };
  }

  // ★ 兜底（不是判据）：太旧的不信 —— 挡 pid 复用和写坏/伪造的标记。
  const age = now - Date.parse(rec.started_at || 0);
  if (!Number.isFinite(age) || age > MAX_AGE_MS) {
    return { busy: false, reason: 'too_old', record: rec, age_ms: Number.isFinite(age) ? age : null };
  }

  return { busy: true, reason: 'running', record: rec, age_ms: age };
}

/**
 * **有没有任何人**在跑长任务？—— 扫整个 `temp/busy/`，逐个走 `check(name)`。
 *
 * ── ★ 为什么是**新名字**，不是给 `check()` 加一个无参重载 ─────────────
 *   `lib/rooms.js` 的 `unfreeze` 注释里那句：**「两个问题两个答案。」**
 *   「**他**在不在忙」和「有没有**任何人**在忙」是两个问题 ——
 *   让它们共用一个函数名，就是让第二个问题**继续借第一个的可信度**：
 *   `check('dev2')` 有效，会让人以为无参的 `check()` 也有效。
 *
 * @returns {{busy:boolean, reason:string, who:string[], records:object[], skipped:object[]}}
 *   `busy` 仍然是布尔 ⇒ 既有的 `if (r.busy)` 调用方不用改。
 *   `who` 是**正在跑**的那些名字；`skipped` 是被跳过的（pid_gone / too_old / corrupt），
 *   **它必须被返回** —— 「没人在跑」和「有三个坏标记」是两种情况，
 *   而压成一个 `false` 之后它们在日志里长得一样。
 *
 * ⚠️ **跳过 `pid_gone`**：`temp/busy/` 里可能躺着进程早就没了的陈标记。
 *   不跳过的话这个函数会**恒真** —— 恒真和恒假一样不携带「现在」的信息。
 */
function anyBusy({ root = BUSY_ROOT, now = Date.now(), alive = null } = {}) {
  let files;
  try {
    files = fs.readdirSync(root).filter((f) => f.endsWith('.json'));
  } catch (_) {
    // ★ 目录不存在 = 从来没人 declare 过 ⇒ 那确实是「没人在忙」，不是「查不了」。
    return { busy: false, reason: 'no_marker', who: [], records: [], skipped: [] };
  }

  const running = [];
  const skipped = [];
  for (const f of files) {
    const agent = f.replace(/\.json$/, '');
    const r = check(agent, { root, now, alive });
    if (r.busy) running.push({ agent, ...r });
    else skipped.push({ agent, reason: r.reason, record: r.record });
  }

  return running.length
    ? {
      busy: true,
      reason: 'running',
      who: running.map((r) => r.agent),
      records: running.map((r) => r.record),
      skipped,
    }
    : { busy: false, reason: skipped.length ? 'all_stale' : 'no_marker', who: [], records: [], skipped };
}

module.exports = { declare, check, anyBusy, whoami, fileFor, BUSY_ROOT, MAX_AGE_MS };
