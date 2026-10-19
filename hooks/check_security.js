#!/usr/bin/env node
'use strict';

/**
 * PreToolUse hook —— Bash 纪律和工具级能力分离的**执行层**。
 *
 * 协议里的 Bash 纪律靠 agent 自觉；这个脚本拒的正好是同一批东西，
 * **不自觉也拒**。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★ 这一层的天花板 —— 读别的注释之前先读这段 ★★
 *
 * **这个 hook 保护不了它自己。**
 *
 * agent 有 Write 工具，settings.json 里没有任何东西挡着它写
 * `.claude/settings.json`。所以它可以直接把 `hooks` 段和整个 `deny`
 * 列表删掉 —— 不需要提权、不需要绕过下面任何一条检查，**直接移除
 * 检查者本身**。改动在会话重启后生效，而 agent 是会被重启的
 * （DISMISS、崩溃恢复、watchdog nudge）。
 *
 * 所以这一层的定位是：
 *
 *   **防的是「不自觉」（忘了 Bash 纪律、顺手写错一条命令），
 *     不是「对抗」（主动想绕过）。**
 *
 * **防的是意外，不是敌意。** 把它当对抗性防线用，是这一层最容易被
 * 误解的地方，而误解的代价是「以为有防护」。
 *
 * （怎么让它保护自己是个单独的设计题 —— deny 写路径？hook 配置放 agent
 *   改不到的地方？—— 不在这个文件里解决。）
 * ══════════════════════════════════════════════════════════════════
 *
 * ── 输入格式：**实测的，不是文档抄的** ────────────────────────────
 *
 * 格式来自一次真实探测：临时目录里挂一个只记录不拒绝的 hook，
 * 用 `claude -p` 各触发一次 Bash 和 WebFetch，抓下 Claude Code 实际喂进来
 * 的 JSON。「文档说的格式」和「实际喂的格式」可能不一致 ——
 * 而单元测试喂的都是自己想象的输入，它们证明不了这一点。
 *
 * 实际收到的（PreToolUse，Bash）：
 *   {
 *     "session_id": "...", "transcript_path": "...", "cwd": "...",
 *     "prompt_id": "...", "permission_mode": "bypassPermissions",
 *     "effort": { "level": "xhigh" },
 *     "hook_event_name": "PreToolUse",
 *     "tool_name": "Bash",
 *     "tool_input": { "command": "echo hello", "description": "..." },
 *     "tool_use_id": "toolu_..."
 *   }
 * WebFetch 时 `tool_input` 是 `{ "url": "https://…", "prompt": "…" }`。
 *
 * **本脚本依赖的三个字段**：`tool_name` · `tool_input.command`
 * · `tool_input.url`。
 *
 * ⚠️ 为什么核对必须逐字段做，而不是「JSON.parse 没抛就行」：
 *    字段名要是错了，解析**照样成功**，然后读到 `undefined` ——
 *    URL 那条会走进 `if (!url) allow(...)`，**放行所有 WebFetch，
 *    一次策略都不查**。fail-closed 只挡「解析不了」，挡不住「读的是空气」。
 *
 * ⚠️ 输入里有 `hook_event_name`，可以用来确认这确实是 PreToolUse。
 *    **故意不检查它**：它不是判断安全性所必需的，而依赖一个未文档化的字段
 *    意味着哪天它改名/消失就会 fail-closed 拒掉一切。
 *    误挂到别的事件的后果轻（判断时机不对，但不会放行不该放行的东西），
 *    依赖它的后果重。**取那个后果轻的。**
 *
 * ── 贯穿全文件的原则 ──────────────────────────────────────────────
 *
 *   **安全代码里，「不知道」不能表达「允许」。**
 *
 * 三处容易写成 fail-open（出错就放行）的地方，全部 fail-closed：
 *   A. stdin JSON 解析失败 → 拒绝（而不是 exit(0) 放行**全部检查**）
 *   B. 类型检测失败       → 拒绝（而不是回落成某个默认类型）
 *   C. policy 文件缺失     → 拒绝（而不是跳过整段 URL 检查）
 *
 * A 最致命：一个畸形输入让整个 hook 变成空操作，而 `exit(0)` 从调用方
 * 看跟「检查通过」一模一样。
 *
 * B 的默认值没有安全方向：在能力分离下，**dev 是有 Bash 的那个**，
 * 检测失败时回落成 dev，eval 就会以 dev 身份拿到 Bash —— 而 eval 恰恰是
 * 唯一能上网、因此绝不能有 Bash 的那个。**同一行默认值，权限模型一换
 * 就从保护变成后门。**
 *
 * ── 类型从哪来：环境变量。两条绑定都要知道 ────────────────────────
 *
 * 用 `process.cwd()` 反查类型的话，**cwd 就是安全边界**，settings.json
 * 里就必须有 `Bash(cd:*)` 禁令 —— 能 cd 就能改变自己的身份判定
 * （cd 到别的项目 → 被认成别的类型；cd 到认不出的地方 → 落进默认类型）。
 * **一条藏在权限列表里的规则，在保护另一个文件里的一个函数。**
 *
 * 这里读 `ENGLOOP_AGENT_TYPE`。这**不是没有绑定，是换了一条**：
 *
 *   · 查 cwd 的绑定：**cwd 不可被 agent 改变**（靠 `Bash(cd:*)` 禁令维持）
 *   · 读环境变量的绑定：**hook 的环境不可被 agent 改变**（靠「hook 由 claude 进程
 *     spawn、继承的是启动时环境」维持；agent 在 Bash 里 export 只影响
 *     那个 shell 子进程）
 *
 * ⚠️ **谁改动类型的来源，谁就要重新回答「现在什么东西是不可篡改的」。**
 *    改回查 cwd → `Bash(cd:*)` 必须同时变成禁令。改成读文件 → 那个文件
 *    必须是 agent 写不到的。只写「旧防线拆了」而不写「新防线在哪」，
 *    后人只会知道少了一道。
 *
 * ── 方法上限 ───────────────────────────────────────────────────────
 *
 * 命令检查是前缀匹配，**正则/前缀解析不了 shell 语法**（前面带变量赋值、
 * `env`、嵌套引号都能绕过）。这是尽力而为，不是完备解析；真修需要一个
 * shell parser。写在这里是为了防止后人以为它密不透风、然后在它上面叠更多假设。
 */

const fs = require('node:fs');
const path = require('node:path');
const { capabilitiesFor, isKnownType, isWebTool } = require('../lib/agent-capabilities');

const ROOT = path.join(__dirname, '..');
// 路径可覆盖，**只为让测试指向临时文件**。
// 不这么做的话测试只能把真文件挪走再挪回，而那有个很阴的失败模式：
// 测试崩在中间 → policy 留在缺失状态 → 按 fail-closed 所有 web 调用被拒 →
// **故障现场跟「hook 正常工作」一模一样，都是 REJECT**。
// 顺带好处：能测「policy 内容不同 → 行为不同」，挪文件只能测有/无两态。
const POLICY_PATH = process.env.ENGLOOP_URL_POLICY || path.join(ROOT, 'config', 'url_policy.json');
// 不写 `process.cwd()/logs/` —— 每个 agent 的 cwd 不同，日志会散落
// 一地，谁也不知道该去哪儿看。固定到仓库根下。
const LOG_DIR = path.join(ROOT, 'temp', 'hook-logs');

const hookStart = Date.now();

/**
 * 拒绝。**exit 2 是 Claude Code 约定的 blocking error** —— stderr 的内容
 * 会回给模型。搞成 exit 0 就是全放行，而且从外面看不出区别。
 *
 * 错误信息必须说清**为什么拒**：agent 看不到这个文件，只看到这句话。
 * 不说原因它会反复撞同一堵墙，不知道发生了什么。
 */
function reject(reason) {
  process.stderr.write(`REJECT: ${reason}\n`);
  log(`phase=reject reason=${reason.slice(0, 200)}`);
  process.exit(2);
}

function allow(tag) {
  log(`phase=allow ${tag} total=${Date.now() - hookStart}ms`);
  process.exit(0);
}

/**
 * 日志。不用 `catch {}` —— 写失败被完全吞掉的话，「日志里什么都没有」
 * 同时表示「一切正常」和「日志根本没写成」。
 * 这里写失败会喊一声到 stderr（exit 0 时 stderr 无害，不影响放行判定）。
 */
function log(message) {
  const now = new Date();
  const line = `[${now.toISOString()}] hook=check_security ${message}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `hook_${now.toISOString().slice(0, 10)}.log`), line, 'utf8');
  } catch (err) {
    process.stderr.write(`[hook] 日志写入失败（不影响判定）: ${err.message}\n`);
  }
}

// ── 命令级拒绝清单（Bash 纪律的执行层）──────────────────────────
//
// ⚠️ 不禁止绝对路径：agent 跨项目工作，绝对路径是日常。禁了会拦下几乎
//    所有正常命令，而**一条会误伤正常工作的安全规则，结局是整个 hook
//    被关掉** —— 那比没有这条规则糟得多。「限制操作范围」是单独议题。
//
// ⚠️ 也不禁 python/pip、curl/wget（web 工具开了之后禁它已经没有意义）、
//    ssh/scp/sftp、cmd.exe/powershell/pwsh —— 命令级限制太多会挡住正常工作。
//
// ★ 只留下三条,而且它们防的**不是敌手,是一次手滑**:
//   一个 agent 拼路径时少了个变量,`rm -rf /$EMPTY` 就是 `rm -rf /`。
//   留着不影响任何正常工作。
//
// ⚠️ 要连这三条也去掉,把数组清空即可。但先想一遍:
//   **这三条唯一的作用是在一个已经出错的命令真正执行之前拦一下,
//     而那种命令不会先跟你打招呼。**
const BLOCKED_COMMANDS = [
  'rm -rf /', 'del /f', 'format',
];


function checkCommand(command) {
  const lower = command.toLowerCase().trim();

  for (const blocked of BLOCKED_COMMANDS) {
    if (lower === blocked || lower.startsWith(`${blocked} `) || lower.startsWith(`${blocked}\t`)) {
      reject(`命令 "${blocked}" 被安全策略禁止。`);
    }
  }

  // ⚠️ 故意不查**写法**:命令串联 && || ; · node -e/-p 内联 · 输出重定向 > >> ·
  //   管道 | · 命令替换 $() 反引号 · 连续引号。
  //
  // ★ 它们和上面那三条的性质完全不同 —— 那三条拦的是灾难,
  //   这些拦的是**写法**。它们不阻止任何一类危险操作,
  //   只是逼着 agent 把一行命令拆成三次工具调用,或者写一个临时脚本。
  //
  //   而代价是真实的:一个被限制得写不出正常命令的 agent,
  //   会把时间花在绕路上。
  //
  // ★★ 所以这个函数只做一件事:上面那三条灾难性误操作。
  //   **要往回加规则,先问一句「这条拦的是灾难还是写法」。**
}

// policy 的必填字段。**每一项都必须显式写出来，缺一个就拒绝。**
//
// ★ 不查的话这是第四处 fail-open：一个内容为 `{}` 的
//   **合法** JSON 会让整段 URL 检查静默失效 —— `http://1.2.3.4/x`
//   （既是 http 又是裸 IP）照样放行，因为每个开关都是 undefined，
//   而 `undefined` 在 if 里等于 false、`|| []` 又把列表变成空。
//
//   **`require_https: false` 是一个明确的决定，字段缺失是一个
//   未知 —— 两者不该有相同的效果。** 前者是人说了「不用查」，后者是没人
//   说过话。
const POLICY_REQUIRED = {
  require_https: 'boolean',
  block_raw_ip: 'boolean',
  blocked_domains: 'object',            // 数组
  blocked_domain_patterns: 'object',
};

function checkUrl(url) {
  // ── fail-closed C：policy 缺失 = 拒绝，不是跳过 ──
  // 写成 `if (policy)` 跳过的话，删掉一个文件就能让 URL 策略消失，
  // 而且没有任何提示。
  let policy = null;
  try {
    policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  } catch (err) {
    reject(`URL 策略文件读不出来（${POLICY_PATH}）：${err.message}。`
         + ' 没有策略就不能判断这个 URL 是否安全 —— 拒绝，不是跳过。');
  }

  for (const [field, type] of Object.entries(POLICY_REQUIRED)) {
    const val = policy[field];
    const isArrayField = type === 'object';
    if (val === undefined || (isArrayField ? !Array.isArray(val) : typeof val !== type)) {
      reject(`URL 策略缺字段或类型不对：${field}（期望 ${isArrayField ? '数组' : type}）。`
           + ' 一份不完整的策略会让检查静默失效 —— 每一项都要显式写出来，'
           + ' 不查也要写成 false / 空数组。');
    }
  }

  let parsed = null;
  try {
    parsed = new URL(url);
  } catch (_) {
    reject(`URL 格式不合法：${url}`);
  }

  if (policy.require_https && parsed.protocol !== 'https:') {
    reject(`只允许 HTTPS。收到的是：${parsed.protocol}`);
  }

  if (policy.block_raw_ip) {
    const host = parsed.hostname;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || /^\[.*\]$/.test(host)) {
      reject(`不允许直接用 IP 地址：${host}`);
    }
  }

  const hostname = parsed.hostname.toLowerCase();

  for (const domain of policy.blocked_domains || []) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      reject(`域名被 URL 策略阻止：${domain}`);
    }
  }

  for (const pattern of policy.blocked_domain_patterns || []) {
    if (pattern.startsWith('*.') && hostname.endsWith(pattern.substring(1))) {
      reject(`域名匹配阻止规则：${pattern}`);
    }
  }
}

function main(input) {
  // ── fail-closed A：stdin 解析失败 = 拒绝 ──
  // 这里要是 exit(0)，一个畸形输入就让整个 hook 变成空操作。
  // ⚠️ 空 stdin 也走这条（JSON.parse('') 抛错）。所以挂到 settings.json
  //    之前**必须先用真实的 hook 输入验证一次** —— 如果 Claude Code 的
  //    实际输入跟假设的不一样，这条会拒掉一切工具调用。
  let parsed = null;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    reject(`hook 收到了无法解析的输入（${err.message}）。`
         + ` 前 200 字符：${String(input).slice(0, 200)}。`
         + ' 无法判断这次调用是什么 —— 拒绝，不是放行。');
  }

  const toolName = parsed.tool_name || '';

  // ── fail-closed B：类型未知 = 拒绝 ──
  // 「没设」和「设了个不认识的值」分开报，因为修法完全不同：
  // 前者是启动脚本漏了注入，后者是拼错了或者加了新类型没登记。
  const agentType = process.env.ENGLOOP_AGENT_TYPE;
  if (!agentType) {
    reject('环境变量 ENGLOOP_AGENT_TYPE 没有设置，无法判断这个 agent 的能力。'
         + ' 它应该由 agent-start / orch-start / worker-pool 在启动时注入。'
         + ' 不知道你是谁就不能放行 —— 拒绝，不是猜一个默认值。');
  }
  if (!isKnownType(agentType)) {
    reject(`不认识的 agent 类型 "${agentType}"。`
         + ' 要么拼错了，要么新增了类型但没登记进 lib/agent-capabilities.js。');
  }

  const caps = capabilitiesFor(agentType);

  // ── 工具级：能力分离（粗粒度白名单）──
  // 「Bash 里能跑什么命令」不在这里判 —— 那是下面的拒绝清单。
  if (isWebTool(toolName)) {
    if (!caps.web) {
      reject(`${toolName} 对 ${agentType} 类型不开放。`
           + ` 只有能上网的类型可以用（${caps.note}）。`);
    }
    // WebSearch 没有 URL 可查，到这儿就放行
    const url = (parsed.tool_input || {}).url;
    if (!url) allow(`tool=${toolName} agent=${agentType}`);
    checkUrl(url);
    allow(`tool=${toolName} agent=${agentType}`);
  }

  if (toolName !== 'Bash') {
    allow(`tool=${toolName} agent=${agentType} （非受检工具）`);
  }

  if (!caps.bash) {
    reject(`Bash 对 ${agentType} 类型不开放（${caps.note}）。`
         + ' 能读外部内容的 agent 不许执行代码 —— 那是 prompt injection 到 RCE 的完整链路。');
  }

  const command = (parsed.tool_input || {}).command || '';
  if (!command) allow(`tool=Bash agent=${agentType} （空命令）`);

  checkCommand(command);
  allow(`tool=Bash agent=${agentType}`);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => main(input));
