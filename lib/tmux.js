'use strict';

/**
 * tmux 控制层：起会话、看会话、往会话里发键、收会话。
 *
 * 用 tmux 而不是 detached spawn ＋ 刮终端日志：真回滚缓冲（不是刮来的日志）、
 * 人能坐进去、会话在终端关闭和 SSH 断开后继续活、以及 send-keys 这条真实的
 * 救援路径（ESC 能在 1 秒内打断阻塞中的工具调用）。
 *
 * ⚠️ 命名空间义务：会话名是全局命名空间。撞名 = 静默把新任务
 * 接到一个活着的会话上。所有创建路径都必须先 has-session 校验。
 */

const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * tmux 可执行文件的路径。**唯一出处**，别在别处写裸的 `'tmux'`。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────
 * launchd / nohup **不加载 shell profile**，PATH 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin` —— 而 homebrew 的 tmux 在
 * `/opt/homebrew/bin`。于是 bus 里每一次 tmux 调用都是 ENOENT ——
 * `GET /api/agents` 全空、watchdog 枚举源全空，**失聪检测本身瞎了而没人发现**。
 *
 * `bin/serve.sh` 已经为 **node** 解决过同一个问题（自己解析 nvm 路径，
 * 因为 launchd 不认 profile）—— tmux 是同一个病。
 *
 * ⚠️ 修在这里而不是 `serve.sh`：**bus 不一定经过 serve.sh** ——
 *   `node bin/serve.js` 直接 nohup 起就绕过了它。
 *   **修在启动脚本里，只对「经过那个脚本」的启动方式生效。**
 *
 * ⚠️ 找不到时**返回 `'tmux'` 而不是抛错** —— 让后续调用去抛
 *   `TMUX_UNAVAILABLE`（见 `list()`）。在这里抛的话，
 *   **只是 require 这个模块就会炸**，而那时还没人有机会说明白发生了什么。
 * ────────────────────────────────────────────────────────────────
 */
const TMUX_FALLBACKS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
let _tmuxBin = null;

function tmuxBin() {
  if (_tmuxBin) return _tmuxBin;
  // 显式指定优先 —— 装在非常规位置的人不该被这份候选列表挡住
  if (process.env.ENGLOOP_TMUX_BIN) return (_tmuxBin = process.env.ENGLOOP_TMUX_BIN);
  // PATH 里有就用 PATH 的：正常 shell 环境下最准，也尊重用户自己装的版本
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return (_tmuxBin = 'tmux');
  } catch (_) { /* PATH 里没有，往下找 */ }
  for (const p of TMUX_FALLBACKS) {
    try {
      execFileSync(p, ['-V'], { stdio: 'ignore' });
      return (_tmuxBin = p);
    } catch (_) { /* 试下一个 */ }
  }
  return (_tmuxBin = 'tmux');   // 真找不到 —— 交给 list() 抛可区分的错
}

/** 会话命名约定：orch / agent_<type> / job_<type>_<shortid> */
function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && NAME_RE.test(name);
}

// 「这个会话真的不存在」的那几种 tmux 说法。跟 NO_SESSIONS_RE 一样是白名单。
const NO_SUCH_SESSION_RE = /can't find session|no server running|no sessions|error connecting to/i;

/**
 * 会话在不在。
 *
 * ── ★ 跟 list() 同一个判据，而且后果更重 ────────────────────────
 * `catch { return false }` 的写法在 **tmux 命令不存在时也返回 false**，
 * 而 false 的含义是「会话不存在」。**「查不了」被说成了「它没了」。**
 *
 * 最坏的下游是 `lib/shutdown.js`：kill 之后**回查**会话是否还在，
 * 用来判断强杀有没有真的生效。tmux 不可用时 `exists()` 说 false →
 * **报告一次没有发生的成功**。而那条回查存在的全部理由就是「不拿命令返回值
 * 当结果，要回查事实」—— **回查本身撒谎的话，那层防护是空的。**
 *
 * @throws {Error} `err.code === 'TMUX_UNAVAILABLE'` —— 查不了，不是不存在
 */
async function exists(session) {
  try {
    await run(tmuxBin(), ['has-session', '-t', session]);
    return true;
  } catch (err) {
    const msg = String(err.stderr || err.message || '');
    if (NO_SUCH_SESSION_RE.test(msg)) return false;   // 真的没有这个会话
    const e = new Error(
      `tmux 查询失败（不是「会话不存在」，是查不了）：${msg.trim() || err.code || '未知'}`);
    e.code = 'TMUX_UNAVAILABLE';
    e.cause = err;
    throw e;
  }
}

// 「真的没有会话」的那几种 tmux 说法。**白名单，不是黑名单** ——
// 认不出来的一律当「查不了」，见 list() 的说明。
const NO_SESSIONS_RE = /no server running|no sessions|error connecting to/i;

/**
 * `tmux ls -F` 的格式串。
 *
 * ⚠️ 分隔符用 `|` 不用 `\t`：会话名的字符集受 `validName` 约束
 * （`[A-Za-z0-9_-]`），数字字段也不含 `|` —— **所以 `|` 绝不可能出现在
 * 任何一个字段里面**。制表符在传递链上有可能被吃掉或转义，`|` 没有这个问题。
 */
const LIST_FORMAT = '#{session_name}|#{session_created}|#{session_attached}';

/**
 * 解析 `tmux ls -F` 的输出。**纯函数，抽出来是为了能喂假输入。**
 *
 * ── ★ 解析器必须验证自己解析出来的东西 ──────────────────────────
 * 分隔符没切开时，`list()` 会返回形如 `agent_dev_1785970068_0` 的名字 ——
 * **三个字段粘在一起，整行成了 `name`**。后果：
 *   · `sessionToName()` 反查必然失败 → 正常 agent 被判成陌生会话 / deaf
 *   · `exists()` / `kill()` 用真名，`list()` 给假名 → 两边对不上
 *   · **watchdog 的 stale 分支据此 `unregister`** → 活着的 agent 被删出花名册
 *
 * ★ 这类错误很难被发现：
 *
 *   **返回值的结构是完整的**（是数组、有 name 字段、长度也对），**只是内容错了。**
 *   **任何断言「返回了 N 个会话」的测试都会通过。**
 *
 * 变异测试、阴性对照、断言语义自检、源码断言都防不住它 ——
 * **它们要么问「行为对不对」，要么问「代码长什么样」。
 * 而这个 bug 行为正常、代码不重复：错的是数据内容，
 * 而测试只检查了数据的形状。**
 *
 * 所以这里的判据是：**解析出来的 `name` 必须是一个合法会话名**
 * （`validName` 判得过）。判不过 → **不是「解析出了一个奇怪的名字」，
 * 是「这一行没解析对」** → 抛 `TMUX_UNAVAILABLE`，
 * **绝不把脏数据交给上层当事实**。
 *
 * ⚠️ 这一条比「换个分隔符」重要得多：换分隔符只是让它更难出错，
 *   这一条让它**出错时说得出来**。**一个只在别的环境里发生、
 *   开发机上复现不出来的解析错误，只有解析器自己能发现。**
 * ────────────────────────────────────────────────────────────────
 */
function parseList(stdout) {
  const lines = String(stdout).trim().split('\n').filter(Boolean);
  return lines.map((l) => {
    const parts = l.split('|');
    const [name, created, attached] = parts;
    // ★ 自证：切出来的第一段必须像个会话名。不像 = 这一行没解析对。
    if (parts.length < 3 || !validName(name)) {
      const e = new Error(
        `tmux ls 的输出解析不了（格式对不上，不是「没有会话」）：${JSON.stringify(l.slice(0, 80))}`);
      e.code = 'TMUX_UNAVAILABLE';
      throw e;
    }
    return { name, created: Number(created), attached: attached === '1' };
  });
}

/**
 * 列会话。
 *
 * ── ★ 「没有会话」和「查不了」必须分开 ────────────────────────────
 * 「没有任何会话时 tmux ls 返回非 0，不是错误」—— 这句是对的，
 * 但 `catch { return [] }` 会把两种非 0 混成一种：
 *
 *   · `no server running`  → 真的没有会话 → `[]` **正确**
 *   · `ENOENT`（找不到 tmux 命令）→ **查不了** → `[]` **是谎话**
 *
 * 比如 bus 用 nohup 起，PATH 只有 `/usr/bin:/bin:...`，
 * 而 tmux 在 `/opt/homebrew/bin`。于是 `list()` 一直返回 `[]`，
 * watchdog 的枚举源全空、`GET /api/agents` 全空 ——
 * **页面显示「没有异常」，跟「真的没有异常」长得一模一样。**
 *
 * 而 `/api/agents` 存在的全部目的就是让人一眼看出失聪。
 * **它坏了，而且坏得没有症状。**
 *
 * ⚠️ 用**白名单**判「真的没有」：只有 tmux 明说了那几句才返回 `[]`，
 *   **认不出来的一律抛错**。反过来（黑名单认 ENOENT）的话，
 *   下一种没想到的失败又会变成「没有会话」—— fail-open 的默认永远是错的。
 * ────────────────────────────────────────────────────────────────
 *
 * @throws {Error} `err.code === 'TMUX_UNAVAILABLE'` —— 查不了，不是没有
 */
async function list() {
  try {
    const { stdout } = await run(tmuxBin(), ['ls', '-F', LIST_FORMAT]);
    return parseList(stdout);
  } catch (err) {
    // ★ parseList 抛的已经是 TMUX_UNAVAILABLE，**原样放行** ——
    //   否则会被下面重新包装，而「哪一行解析不了」那条信息正是诊断的全部。
    if (err.code === 'TMUX_UNAVAILABLE') throw err;
    const msg = String(err.stderr || err.message || '');
    if (NO_SESSIONS_RE.test(msg)) return [];   // 真的没有会话
    const e = new Error(
      `tmux 查询失败（不是「没有会话」，是查不了）：${msg.trim() || err.code || '未知'}`);
    e.code = 'TMUX_UNAVAILABLE';
    e.cause = err;
    throw e;
  }
}

/**
 * 起一个会话。命名冲突时**抛错而不是复用** —— 静默接管一个活会话
 * 正是命名空间义务要防的危险（见文件头）。
 */
/**
 * @param {object} opts
 * @param {Record<string,string>} [opts.env] 注进会话环境的变量（tmux -e）。
 *
 * ★ 为什么用 `tmux -e` 而不是把 `VAR=val` 拼进 command：
 *   变量要传到的不是那条命令，是**它后代进程里的 hook** ——
 *   tmux 会话 → shell → claude → PreToolUse hook。`-e` 设的是**会话环境**，
 *   整条链都继承得到；拼进命令行只对那一条命令生效，而且要靠 shell 解析。
 *   （需要 tmux 3.0+。）
 */
async function spawn(session, { cwd, command, env, width = 200, height = 50 }) {
  if (!validName(session)) throw new Error(`非法会话名: ${session}`);
  if (await exists(session)) {
    throw new Error(`会话已存在: ${session}（拒绝复用：会话名是 agent 的命名空间，复用会接管别人的会话）`);
  }
  const args = [
    'new-session', '-d', '-s', session, '-c', cwd,
    '-x', String(width), '-y', String(height),
  ];
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || v === null) continue;
    args.push('-e', `${k}=${v}`);
  }
  args.push(command);   // command 必须在最后
  await run(tmuxBin(), args);
  return { session, cwd };
}

/** 看会话里在干什么。真回滚缓冲，不是刮日志。 */
async function peek(session, lines = 60) {
  const { stdout } = await run(tmuxBin(), ['capture-pane', '-p', '-t', session, '-S', `-${lines}`]);
  return stdout;
}

/**
 * 推一把卡住的 agent。ESC 能在 1 秒内打断一个还剩好几分钟的
 * 阻塞工具调用，且会话立即恢复可用。
 */
async function nudge(session, keys) {
  await run(tmuxBin(), ['send-keys', '-t', session, keys]);
}

/** 发文本并回车。TUI 里必须分两次发，中间留间隔 —— 一次发 Enter 不生效。 */
async function submit(session, text, gapMs = 1500) {
  await run(tmuxBin(), ['send-keys', '-t', session, '-l', text]);
  await new Promise((r) => setTimeout(r, gapMs));
  await run(tmuxBin(), ['send-keys', '-t', session, 'Enter']);
}

async function kill(session) {
  try {
    await run(tmuxBin(), ['kill-session', '-t', session]);
    return true;
  } catch (_) {
    return false;
  }
}

/** 等界面出现某个模式。TUI 自动化必须等状态，不能用固定 sleep。 */
async function waitFor(session, regex, timeoutMs = 60000, intervalMs = 1000) {
  const re = regex instanceof RegExp ? regex : new RegExp(regex, 'i');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await exists(session))) return { ok: false, reason: 'session_gone' };
    const pane = await peek(session, 60);
    if (re.test(pane)) return { ok: true, pane };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, reason: 'timeout' };
}

function available() {
  try {
    // ★ 走 tmuxBin() —— 它是唯一出处。这里留裸的 'tmux' 的话，
    //   在 launchd/nohup 环境下 available() 会说「没装」，而 list() 明明能跑。
    //   **两个都在回答「tmux 能不能用」，却用不同的方式去找它。**
    execFileSync(tmuxBin(), ['-V'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  validName, exists, list, spawn, peek, nudge, submit, kill, waitFor, available,
  // 导出给测试用：守「所有调用点都走它」需要能直接问它解析到了什么
  tmuxBin,
  // ★ parseList 单独导出，因为**唯一能守住「结构对、内容错」那类 bug 的办法
  //   是喂它一个假输出**。那类错误在开发机上可能复现不出来 ——
  //   只有把解析器单独拎出来喂脏数据，才验得到它会不会把脏数据当事实。
  parseList, LIST_FORMAT,
};
