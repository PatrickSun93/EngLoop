'use strict';

/**
 * worker 执行器 —— 两种实现，一个开关。
 *
 * ── 为什么默认 `claude -p` ────────────────────────────────────────
 * 让 worker 走 interactive tmux 会话的唯一理由是**计费**
 * （如果 `claude -p` 移出订阅池）。目前不是这样，
 * 所以按技术优劣选：
 *
 *            claude -p          interactive tmux that exits
 *   并发      一进程一任务，天然  要 semaphore + 会话管理
 *   上下文    每次全新、无状态    会话累积，得处理
 *   延迟      无冷启动            有会话启动开销
 *   复杂度    低                  高（命名空间、退出检测、僵尸回收）
 *   可观测    无 scrollback       tmux attach ✓
 *
 * worker 是 episodic / 无状态 / 跑完即退 —— 除可观测性外每项都是 `-p` 更优。
 *
 * 计费方案将来可能变，所以**不锁死**：两个实现，
 * 一个配置开关。真变了时改配置，不改架构。
 * ──────────────────────────────────────────────────────────────
 */

const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmux = require('./tmux');
const launch = require('./agent-launch');
const agentSettings = require('./agent-settings');

/**
 * worker 的权限配置 ＋ 模型。两条路径（runPrint / runTmux）**共用这一个函数** ——
 * 各自拼参数的话，很容易「只改了一条路径」，另一条漏掉
 * `--disallowedTools` 或 `--append-system-prompt-file`。
 *
 * 类型取 `agentType`，没给就取 `task.type`（池永远会给 agentType；task.type 是测试和手工调用的退路）。
 * 两个都不是能力表里的类型 ⇒ **不起**：没有类型就算不出写集和 deny，不带配置起 = 不带 sandbox。
 * @returns {{ args: string[] } | { error: string }}
 */
function workerLaunchArgs(task, { cwd, agentType }) {
  const type = agentType || (task && task.type);
  try {
    const settingsFile = agentSettings.writeAgentSettings({ kind: 'worker', name: `worker-${type}`, type, cwd: path.resolve(cwd) });
    return { args: [...launch.permissionArgs({ kind: 'worker', settingsFile }), ...launch.modelArgs(type)] };
  } catch (e) {
    return { error: `worker 的启动配置生成失败（类型 "${type}"）：${e.message}` };
  }
}

/**
 * 解析 claude 可执行文件的绝对路径。
 *
 * ⚠️ launchd 启动的进程**不加载 shell profile**，PATH 里没有
 * ~/.local/bin。直接 spawn('claude') 会 ENOENT —— 而且这个错误
 * 只在 launchd 环境下出现，手工跑一切正常，很容易漏。
 * （serve.sh 为 node 解决的是同一个问题。）
 */
let _claudeBin = null;
function claudeBin() {
  if (_claudeBin) return _claudeBin;
  const candidates = [
    process.env.ENGLOOP_CLAUDE_BIN,
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) { _claudeBin = c; return c; }
  }
  try {
    _claudeBin = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
    if (_claudeBin) return _claudeBin;
  } catch (_) { /* 落到下面报错 */ }
  throw new Error('找不到 claude 可执行文件，请设置 ENGLOOP_CLAUDE_BIN');
}

/**
 * 失败是暂时的还是永久的？
 *
 * 这个区分很重要：失败不 ack 会让消息被重投，而**永久失败重投一万次
 * 也不会成功** —— 只会无限循环烧资源。比如 claude 二进制找不到时，
 * 任务会在 PEL 和 worker 之间反复弹跳。
 */
function isPermanent(err) {
  const m = String(err && (err.code || err.message) || '');
  return /ENOENT|EACCES|EPERM|not found/i.test(m);
}

/**
 * print 模式：一次性子进程，结果从 stdout 拿。
 * worker 完全不知道队列存在 —— 任务从 prompt 进，结果从 stdout 出。
 */
function runPrint(task, {
  cwd, timeoutMs = 600_000, allowedTools, disallowedTools, agentType, appendSystemPromptFile,
}) {
  return new Promise((resolve) => {
    const args = ['-p', task.text];
    // ★★ 人格。这个参数是必需品 ——
    //   worker 站在被审的项目里时，claude 自动读到的 CLAUDE.md 是**那个项目的**。
    //   审 EngLoop 自己时，那份 CLAUDE.md 是编排者引导，
    //   **一个 review worker 读到它会去当第二个 JARVIS，而且不会报错。**
    //
    // ⚠️ 这个参数**不在 `claude --help` 的选项表里**（只在 `--bare` 的说明里
    //   以 `--append-system-prompt[-file]` 出现过）。它确实存在：
    //     不存在的路径 → `Append system prompt file not found: …`
    //     不存在的参数 → `error: unknown option …`
    //   两句报错不一样。
    //
    // ★ 传路径不传内容：模板里有引号、反引号、中文，拼 argv 要转义；
    //   而且路径指的就是 provision 刚下发的那一份 —— **人格的出处只有一个**。
    //
    // ⚠️ `if (x) push` 跟 allowedTools 那里是同一个危险形状（不传 = 静默失效）。
    //   守在这里没用 —— **防线在 `worker-pool` 那边：文件不在就不让 worker 起。**
    if (appendSystemPromptFile) args.push('--append-system-prompt-file', appendSystemPromptFile);
    // ★ 两个都传，但**起作用的是 disallowedTools**。
    //   `--allowedTools` 是「额外允许」，**不禁止未列出的工具**
    //   （给了不含 Bash 的白名单，Bash 照样能跑）。
    //   `--allowedTools` 保留是因为它表达意图（能力表的正向声明），
    //   **但它不构成一层防护，别把它算进层数。**
    if (allowedTools) args.push('--allowedTools', allowedTools);
    if (disallowedTools) args.push('--disallowedTools', disallowedTools);
    // ★ `--settings <框架生成的配置>` ＋ `--setting-sources user` ＋ dontAsk ＋ `--model`。
    //   `--disallowedTools` 留着 —— 两道：一道是工具级（这个类型根本没有 Bash），
    //   一道是 sandbox / deny（有 Bash 的类型能碰到哪里）。
    const la = workerLaunchArgs(task, { cwd, agentType });
    if (la.error) { resolve({ ok: false, ms: 0, reason: 'permanent', permanent: true, error: la.error }); return; }
    args.push(...la.args);

    let bin;
    try {
      bin = claudeBin();
    } catch (e) {
      resolve({ ok: false, ms: 0, reason: 'permanent', permanent: true, error: e.message });
      return;
    }

    const started = Date.now();
    execFile(bin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      killSignal: 'SIGKILL',
      // hooks/check_security.js 靠这个变量知道对面是哪种 worker。
      // 不传的话它继承 bus 进程的环境 —— 而 bus 是 orchestrator 类型，
      // **于是一个 eval worker 会被当成 orchestrator，拿到它不该有的 Bash**。
      // 继承一个错的身份，比读不到身份更危险 —— 后者会 fail-closed，
      // 前者一路绿灯。
      // ★ 剥掉 Claude Code 的会话态变量（清单在 lib/agent-launch.js）——
      //   bus 若是从一个 Claude Code 会话里起的，它的 env 里就带着那个会话的身份。
      env: launch.stripSessionEnv(process.env, agentType ? { ENGLOOP_AGENT_TYPE: agentType } : {}),
    }, (err, stdout, stderr) => {
      const ms = Date.now() - started;
      if (err) {
        const permanent = isPermanent(err);
        resolve({
          ok: false,
          ms,
          permanent,
          // timeout 时 err.killed 为 true。三类要分开：
          //   timeout    任务太大，重试大概率还是超时
          //   permanent  环境问题（找不到二进制/无权限），重投无意义
          //   error      可能是暂时的，值得重投
          reason: err.killed ? 'timeout' : (permanent ? 'permanent' : 'error'),
          error: String(err.message || err).slice(0, 500),
          output: String(stdout || '').slice(0, 4000),
          stderr: String(stderr || '').slice(0, 1000),
        });
        return;
      }
      resolve({ ok: true, ms, output: String(stdout || '').trim() });
    });
  });
}

/**
 * tmux 模式：起一个 interactive 会话，跑完让它退出。
 * 保留这条路是为了计费方案变化时，以及需要 attach 观察时。
 */
async function runTmux(task, {
  cwd, timeoutMs = 600_000, session, agentType, allowedTools, disallowedTools,
  appendSystemPromptFile,
}) {
  const name = session || `job_${task.type}_${String(task.job_id).slice(0, 8)}`;
  if (await tmux.exists(name)) {
    return { ok: false, reason: 'session_exists', error: `会话 ${name} 已存在` };
  }

  const started = Date.now();
  // ★ 准入层同样要接上 —— 两条路径各自拼参数时，**只验一条不等于两条都验过。**
  //
  // ★ 不带 `--dangerously-skip-permissions`，用跟 runPrint **同一个** `workerLaunchArgs`
  //   （dontAsk ＋ `--setting-sources user` ＋ `--settings <框架配置>` ＋ `--model`）：
  //   deny 和 sandbox 在任何一层都生效。
  //
  // ⚠️ **端到端没验证**：这条路径**没有用真 claude 跑通过**（只用假 claude 断言了 argv 和环境）。
  //   而交互式 claude 答完一件活**不会自己退出** —— 下面的循环靠「会话消失」判结束 ⇒ 很可能一直等到 timeoutMs。
  //   ⇒ **在验证之前，生产不要用 `ENGLOOP_WORKER_MODE=tmux`**（默认 print）。
  const la = workerLaunchArgs(task, { cwd, agentType });
  if (la.error) return { ok: false, ms: 0, reason: 'permanent', permanent: true, error: la.error };
  const flags = [launch.shellJoin(la.args)];
  if (allowedTools) flags.push('--allowedTools', JSON.stringify(allowedTools));
  // 起作用的是这个 —— 理由见 runPrint 里那段。
  if (disallowedTools) flags.push('--disallowedTools', JSON.stringify(disallowedTools));
  // ★ 人格也要接上。**只改一条路径不算修完。**
  //   ★ 这里传的是**路径**，所以塞进 shell 命令字符串是安全的；
  //     换成传内容的话，模板里的引号和反引号会把这条命令拆散。
  if (appendSystemPromptFile) {
    flags.push('--append-system-prompt-file', JSON.stringify(appendSystemPromptFile));
  }

  // 跑完即退：claude 结束后 shell 也结束，会话自然消失
  await tmux.spawn(name, {
    cwd,
    // `env -u …`：tmux 会话继承的是 tmux server 的环境，`-e` 只能设不能删（清单见 lib/agent-launch.js）。
    // ⚠️ 提示词放在 `--` 之后：`--allowedTools` / `--disallowedTools` 是**可变参数**，
    //   不隔开的话提示词会被当成又一个工具名吞掉（claude 报「Input must be provided」）。
    command: `${launch.envUnsetPrefix()} claude ${flags.join(' ')} -- ${launch.shellJoin([task.text])}`,
    env: agentType ? { ENGLOOP_AGENT_TYPE: agentType } : undefined,   // 同 runPrint
  });

  const deadline = Date.now() + timeoutMs;
  let output = '';
  while (Date.now() < deadline) {
    if (!(await tmux.exists(name))) {
      return { ok: true, ms: Date.now() - started, output: output.trim(), via: 'tmux' };
    }
    output = await tmux.peek(name, 200).catch(() => output);
    await new Promise((r) => setTimeout(r, 2000));
  }

  await tmux.kill(name);
  return { ok: false, ms: Date.now() - started, reason: 'timeout', output: output.trim() };
}

function makeRunner(mode) {
  if (mode === 'tmux') return runTmux;
  if (mode === 'print') return runPrint;
  throw new Error(`未知 worker 模式: ${mode}（可选 print | tmux）`);
}

module.exports = { runPrint, runTmux, makeRunner, claudeBin, isPermanent, workerLaunchArgs };
