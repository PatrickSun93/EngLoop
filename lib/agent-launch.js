'use strict';

/**
 * 三条启动路径（编排者 / agent / worker 的 print 与 tmux）共用的命令行片段。
 *
 * 这里只放「拼什么」：权限参数、`--model`、要剥掉的环境变量。**配置内容**在 `lib/agent-settings.js`，
 * **模型选什么**在 `lib/agent-capabilities.js` 的 `model` 那一格。三个地方各一份、各管一件事 ——
 * 启动脚本里不出现任何 `--model xxx`、`--dangerously-skip-permissions` 的字面量（回滚开关除外）。
 */

const capabilities = require('./agent-capabilities');

/**
 * ── 要剥掉的 Claude Code **会话态**环境变量 ────────────────────────────────
 *
 *   为什么要剥：`lib/tmux.js` 的 `new-session` 继承的是 **tmux server** 的环境 —— 谁先起的
 *   tmux server，它的环境就被之后所有会话继承。从一个 Claude Code 会话里起的 tmux server
 *   带着那个会话的身份变量 ⇒ 之后起的每个 agent 都以为自己「在另一个 Claude Code 里面」、
 *   拿着别人的会话号。print 模式 worker 直接透传 bus 的 `process.env` 的话，同一个问题。
 *
 *   ★ **只剥会话态，不按前缀剥。** `CLAUDE_CODE_*` 里一大半是**用户配置**：
 *     `CLAUDE_CODE_USE_BEDROCK` / `_USE_VERTEX`（走哪个 provider）、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、
 *     `CLAUDE_CODE_OAUTH_TOKEN`（凭据）…… 按前缀剥 = 子进程换了 provider 或丢了凭据，**而且报错不会说是这里**。
 *     （云端环境更明显：那里的鉴权就挂在一串 `CLAUDE_CODE_*` / `ANTHROPIC_BASE_URL` 上。）
 *   ⇒ 清单显式列出，每一项一个理由；**新出现的会话态变量要加进来** —— 漏一项的代价是那一项继续泄漏，
 *     而多剥一项用户配置的代价是 agent 起不来或换了账号（更难查）。两害取前者。
 *
 *   `ANTHROPIC_*`：**一个都不剥。** `ANTHROPIC_API_KEY` / `_AUTH_TOKEN` / `_BASE_URL` / `_MODEL` /
 *   `_DEFAULT_*_MODEL` / `_SMALL_FAST_MODEL` / `_CUSTOM_HEADERS` 全是用户（或宿主）给的配置，
 *   没有一个是 Claude Code 运行时替子进程设的。`--model` 命令行参数优先于 `ANTHROPIC_MODEL`，
 *   所以能力表里写了具体模型的类型不受它影响；写 INHERIT 的类型本来就该跟着它走。
 *
 *   实测（Linux，Claude Code 2.1.x）：让 `claude -p` 的 Bash 跑 `env`，
 *   跟父进程环境逐项比 ⇒ `CLAUDECODE=1`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_SESSION_ID`
 *   原样出现在子会话里（**会话号是父会话的**，子 claude 没有重设它）；`CLAUDE_PID` 被子进程改写成自己的。
 */
const SESSION_ENV = [
  // 「我在 Claude Code 里面」的标记。带着它起 claude ＝ 被当成嵌套会话。实测：子会话里 =1 原样可见。
  'CLAUDECODE',
  // 入口标签（cli / sdk-ts / remote_mobile …）。实测：子 claude 原样继承父会话的值，不自己设。
  'CLAUDE_CODE_ENTRYPOINT',
  // 父会话的会话号。实测：子 claude 的 Bash 里看到的是**父会话**的号 ⇒ 遥测、日志对不上人。
  'CLAUDE_CODE_SESSION_ID',
  // 父会话的 pid。实测子进程会改写它；剥掉是为了 tmux server 环境里不留一个指向死进程的值。
  'CLAUDE_PID',
  // IDE 集成（VS Code / JetBrains）那条连接的端口 —— 是父会话跟它的 IDE 之间的。
  // 带过去 ⇒ agent 去连别人的 IDE。没实测，按文档列入。
  'CLAUDE_CODE_SSE_PORT',
  // hook 运行时由 Claude Code 设：指向**触发 hook 的那个会话**的项目目录 / 环境文件。
  // agent-start 若是从某个 hook 里被调起，它们会指着那个会话。没实测，按文档列入。
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_ENV_FILE',
];

/** print 路径：给子进程的 env 删掉会话态（`extra` 后加，所以能设回需要的值）。 */
function stripSessionEnv(env, extra = {}) {
  const out = { ...env };
  for (const k of SESSION_ENV) delete out[k];
  return { ...out, ...extra };
}

/**
 * tmux 路径：`tmux -e` 只能设、不能删 ⇒ 用 `env -u A -u B … claude …` 作命令前缀。
 * 变量名是上面的常量（只有大写字母和下划线），拼进 shell 串不需要转义。
 */
function envUnsetPrefix() {
  return `env ${SESSION_ENV.map((k) => `-u ${k}`).join(' ')}`;
}

/**
 * 权限参数（argv 数组；tmux 路径自己用 shellJoin 拼）。
 *   agent / worker：`--setting-sources user` —— cwd 那份 `.claude/settings.json` 的 allow 会跨层合并进来
 *                 （理由见 lib/agent-settings.js 头注）。
 *   orchestrator：**不带** —— 根 `.claude/settings.json` 的压缩补回 hook 要加载。
 */
function permissionArgs({ kind, settingsFile }) {
  if (!settingsFile) throw new Error('agent-launch: 没有 settingsFile —— 不带配置起 claude 就是不带 sandbox');
  const a = ['--permission-mode', 'dontAsk'];
  if (kind !== 'orchestrator') a.push('--setting-sources', 'user');
  a.push('--settings', settingsFile);
  return a;
}

/** `--model` 参数：能力表那一格是 INHERIT ⇒ 空数组（不传，跟用户级配置走）。 */
function modelArgs(type) {
  const m = capabilities.modelFor(type);
  return m ? ['--model', m] : [];
}

/**
 * 把 argv 拼成给 tmux / shell 的一条命令串（带空格的路径必须是一个 argv）。
 * ★ 用**单引号**，不用 JSON.stringify 的双引号：双引号里 `$x` 和反引号仍会被 shell 替换，
 *   而且替换失败不报错（fail-open）；单引号里一切都是字面，只有单引号本身要 `'\''`。
 */
function shellJoin(argv) {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`)).join(' ');
}

module.exports = { SESSION_ENV, stripSessionEnv, envUnsetPrefix, permissionArgs, modelArgs, shellJoin };
