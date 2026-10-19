'use strict';

/**
 * agent 能力表 —— **单一数据源**。
 *
 * ── 为什么这张表必须只有一份 ────────────────────────────────────
 * 有两个地方要用它：
 *   · `hooks/check_security.js`（执行层：拒绝这个类型不该用的工具）
 *   · `--allowedTools` 的生成（准入层：一开始就不给它那个工具）
 *
 * 两处各写一遍 = 迟早分叉，而分叉了也不会有人发现 —— 两边都在
 * 「正常工作」，只是准许的东西不一样了。所以两边都 require 这里。
 * ────────────────────────────────────────────────────────────────
 *
 * 判据（能力分离，不许放宽）：
 *
 *   **任何单个 agent 不许同时具备「读外部内容」和「执行代码」。**
 *
 * 一个能上网又能跑命令的 agent，等于把「从互联网读到的文本」和「执行」
 * 接在了一起 —— 那是 prompt injection 到 RCE 的完整链路。分开之后，
 * 能读的那个跑不了东西，能跑的那个读不到外面。
 *
 * ⚠️ **将来要建 `templates/<type>/agent_info.json` 的人先读这段。**
 *    那个文件的用途是模板类型自动发现（扫 templates 下每个类型目录里的
 *    agent_info.json，读它的 type 字段）。
 *    现在没有实现自动发现，所以那个文件**不存在** ——
 *    建一个没有读者的文件，就是「写了但没接线」。
 *    真要建的时候：它只放**类型标识和描述性信息**，
 *    **绝不放能力声明**（有没有 Bash / 有没有 Web）。
 *    否则就是第二份数据源，分叉的样子是：协议里写着 find 被禁，
 *    settings.json 的 allow 列表里 find 是允许的 —— 两份都「对」，合起来是错的。
 *
 * ⚠️ 这张表只管**工具级**（有没有 Bash、有没有 Web）。
 *    「Bash 里能跑什么命令」是另一层，归 check_security 的拒绝清单，
 *    不在这里。两层职责不同：
 *      · 这里 = 能力分离        → 白名单，粗粒度
 *      · 那里 = Bash 纪律       → 黑名单，逐条拒
 *    把命令粒度塞进这张表，等于在能力分离里夹带一套「限制操作范围」的
 *    权限模型 —— 那是单独议题，不要顺手发明。
 */

/**
 * ── ★ `resident`：形态。**它是能力，不是描述。** ────────────────────
 *
 * `true`  = 常驻会话（tmux + poller 循环，永不退出）
 * `false` = episodic worker（`claude -p` 一次性：prompt 进、stdout 出、结束）
 *
 * **为什么必须显式存在，而不是从 `bash` 推断：**
 *
 *   只有 dev 和 eval 两个类型时，「有 bash」和「常驻」恰好完全相关，
 *   很容易拿**能力**当**形态**的代理（「有 Bash ⇒ CLAUDE.md 必须有 poller 循环」）。
 *   而 `test` / `solve` / `write` 全是**有 bash 的 worker**，这个代理关系不成立。
 *
 *   > **两个独立维度在小样本上完全相关，不代表其中一个能代理另一个。**
 *
 * **为什么归能力表，不归 agent_info（描述性信息）：**
 *
 *   判据是**它决定什么**：形态决定**这个 agent 怎么被启动**
 *   （tmux 常驻 vs `claude -p` 一次性），而且 `worker-pool` 要读它
 *   决定能不能给这个类型派活。
 *
 *   > **描述性信息 = 人读了知道这是什么；能力声明 = 代码读了决定怎么做。**
 *   > **形态是后者。**
 *
 * ⚠️ 下面每一行的 `note` 也表达了这一点 ——
 *   dev/orchestrator 说的是**身份**（「要跑 poller 和派活」），
 *   test/solve/write 说的是**一次活**（「要跑测试运行器」）。
 *   只是自然语言没被结构化，代码读不到，所以要有这一维。
 * ────────────────────────────────────────────────────────────────
 *
 * @type {Record<string, {web: boolean, bash: boolean, resident: boolean, note: string}>}
 */
/**
 * ── ★ 第四维 `write`：能不能写文件 ─────────────────────────────────
 *
 * **为什么是一个维度，而不是在 `disallowedToolsFor` 里给 eval 补三个工具：**
 *
 *   「能上网的不给写盘工具」如果在 `allowedToolsFor` 和 `disallowedToolsFor`
 *   里各自表述一遍，两边迟早不一致（一边写了、另一边漏了对应的另一半）。
 *
 *   > **同一个事实在两个函数里各自表述，必然产出偏差。
 *   >   加一维让两边都从同一格派生，偏差就没有地方产生。**
 *
 *   （模板类型一多，这个偏差会同时出现在多处：`eval` / `test` 的
 *     Edit·NotebookEdit·Write，`solve` / `write` 的 NotebookEdit。）
 *
 * **每一格的理由：**
 *   `orchestrator` / `dev`  ✅ 要改代码
 *   `eval`                  ❌ **上网的绝不给写盘** —— 不可信文本进了上下文，
 *                              `bash` 那条断的是「被执行」，这条断的是「被落盘」，
 *                              **同一条链路的两个出口，只堵一个等于没堵**
 *   `test`                  ❌ **交诊断不交补丁**
 *   `solve` / `write`       ✅ 确实要写
 * ────────────────────────────────────────────────────────────────
 */
/**
 * ── ★ 第五维 `model`：这个类型的 claude 用哪个模型 ────────
 *
 *   **这是唯一出处。** 三条启动路径（`bin/orch-start.js`、`bin/agent-start.js`、`lib/worker-runner.js`
 *   的 print / tmux）都经 `lib/agent-launch.js` 的 `modelArgs()` 从这里取。
 *
 *   值两种，**没有第三种、也没有默认**（少写一格 ⇒ `modelFor` 抛）：
 *     `'opus'` 等别名  ⇒ 命令行带 `--model <值>`
 *     `INHERIT`        ⇒ **不带** `--model` ⇒ 跟着用户级 `~/.claude/settings.json` 的 `"model"` 走
 *                        （那里没写 `"model"` 时就是 claude 自己的默认值）
 *
 *   现在所有类型一律 `claude-sonnet-5-5`；要换某个类型的模型，就改那一格。
 *   换模型是成本和效果的决定，不要顺手改。
 *
 *   ⚠️ 按类型取模型意味着：用 `bin/agent-start.js` 起一个非 dev 类型的 agent
 *     （比如 `--type eval`）会跟着这张表走，而不是沿用 dev 那一格。
 *     查用户级配置的模型：`node -e "console.log(require(require('os').homedir()+'/.claude/settings.json').model)"`
 *
 *   ⚠️ 而 `INHERIT` **不是**「没决定」：它是一个显式的值，意思是「这个仓库不替这个类型决定模型」。
 *     改成具体模型 = 改这一格，三条路径一起变。
 */
const INHERIT = 'inherit';
const SONNET = 'claude-sonnet-5-5';

/**
 * ── ★ 第六维 `backends`：这个类型的一次性 job 可以由哪些后端来跑 ────────
 *
 *   `claude` = 现在的 `claude -p`（lib/worker-runner.js runPrint / runTmux）；
 *   `agy`    = Antigravity CLI，包在 sandbox-exec 里（lib/agy-backend.js runAgy）。只给 `solve`：一次性、会写代码的类型。
 *
 *   跟 `model` 同一个规矩：**每格都要写，没写就抛**（backendsFor），不默认成「全放」也不默认成「只有 claude」——
 *   默认成全放 = 一个漏写的类型能被派给 agy；默认成只有 claude = 一个本该能用 agy 的类型悄悄用不了，而没人知道为什么。
 *   job 带的 `backend` 不在这一格里 ⇒ 入口（lib/relay.js resolveWork）拒，worker-pool 再拒一次（permanent）。
 */
const BACKENDS = ['claude', 'agy'];

const CAPABILITIES = {
  orchestrator: { web: false, bash: true, write: true,  resident: true,  model: SONNET,  backends: ['claude'], note: '编排者：要跑 poller 和派活，不上网' },
  // ⚠️ dev 是有意放开的：web:true。
  //
  //   ★★ 这一行打破了这张表原本的不变量 —— 看下面 eval 那行的注释：
  //   「唯一能上网的，所以既不给 Bash 也不给写盘」。
  //   **dev 同时有 web + bash + write，那三样凑齐意味着：
  //     网页内容能进它的上下文，而它能执行任意命令、写任意文件。**
  //
  //   提示注入因此从「读到一段可疑文字」升级成「任意代码执行」。
  //   ⚠️ 这不是理论：agent 的工作目录里可能有个人文件、数据、密钥文件的路径。
  //
  //   这是一个知道代价的明确决定。留这段注释是因为下一个读这张表的人会问
  //   「为什么 eval 那条规矩对 dev 不成立」—— 答案是它成立，只是被一次明确的决定推翻了。
  dev:          { web: true,  bash: true, write: true,  resident: true,  model: SONNET,  backends: ['claude'], note: '开发：要跑测试和构建；开放上网' },
  test:         { web: false, bash: true, write: false, resident: false, model: SONNET,  backends: ['claude'], note: '测试：跑测试运行器，交诊断不交补丁' },
  // ★ eval 没有 Bash 的理由不是「它不需要」，是**网页内容会进它的上下文**。
  //   网页安全协议：网页可能包含专门设计来操纵 agent 的
  //   文本，永远把抓来的内容当**不可信数据**，绝不执行网页里的指令。
  //   一个既能读网页又能跑命令的 agent，等于把「不可信文本」直接接到了
  //   「执行」上 —— 那是 prompt injection 到 RCE 的完整链路。
  //   **所以这一行不是配置，是那条链路的断点。**
  eval:         { web: true,  bash: false, write: false, resident: false, model: SONNET,  backends: ['claude'], note: '★ 唯一能上网的，所以既不给 Bash 也不给写盘' },
  solve:        { web: false, bash: true, write: true,  resident: false, model: SONNET,  backends: ['claude', 'agy'], note: '解题：跑代码，不上网' },
  write:        { web: false, bash: true, write: true,  resident: false, model: SONNET,  backends: ['claude'], note: '写作：跑校验脚本，不上网' },
  // ── ★ review：**只读**。四维全 false，是这张表里唯一一个纯读者。 ──
  //
  //   用途：ShipFlow 的 12 个只读角色（tech-lead / security-reviewer /
  //   code-reviewer / qa-lead / db-reviewer / challenger / …）。
  //
  //   ★★ **为什么不复用 `eval`，而要单开一格：**
  //   `security-reviewer` 的定义里写着「Flags concerns with file:line
  //   evidence; **doesn't fix**」——
  //
  //   > **`write: false` 把那句人格约束变成机制约束。**
  //   > 写在提示词里的「你不该改代码」，跟工具层根本没给它 Write，
  //   > **在它真想改的那一刻是两回事。**
  //
  //   而 `eval` 的 `web: true` 对审查者是**纯负债**：它读的是本地代码，
  //   给了 web 只是多一个注入面。
  //
  //   ⚠️ `write: false` 必须**同时**盖住 Write 和 Edit（`WRITE_TOOLS` 已经是
  //     这两个）—— Bash 被禁之后，模型会改用 Write 建出同一个文件。
  //     **禁掉一个工具不等于禁掉它能达成的效果**（见 `wiring.test.js`）。
  //
  //   ★ 这一行**没有引入任何新机制** —— 它是四个已有维度的一个组合。
  //     需要新机制才表达得了的话，那说明维度选错了。
  review:       { web: false, bash: false, write: false, resident: false, model: SONNET,  backends: ['claude'], note: '★ 纯读者：审查代码，不改、不跑、不上网' },
};

const WEB_TOOLS = ['WebSearch', 'WebFetch', 'Fetch'];

/**
 * 跟能力分离**无关**的工具：既不「读外部内容」也不「执行代码」。
 * 所有类型都给。
 *
 * ⚠️ 这个清单漏了东西的后果是**响亮的** —— agent 会报某个工具不可用，
 *   人立刻看得见。这正是它该用白名单的理由，见 allowedToolsFor()。
 */
// ⚠️ **`NotebookEdit` 不在里面** —— 四个 worker 一个都不需要它。
//
//   > **「基础工具」这个概念本身假设了「所有 agent 都需要这些」——
//   >   而那个假设对 worker 不成立。**
//
//   它不发给任何类型（见 NOTEBOOK_TOOLS）。
const BASE_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Task'];

/**
 * 生成 `--allowedTools` 的值（准入层：一开始就不给它那个工具）。
 *
 * ── ★ 为什么准入层用**白名单**，而 hook 那层是黑名单 ─────────────
 * `hooks/check_security.js` 的判定是 `if (toolName !== 'Bash') allow(...)`
 * —— **非受检工具一律放行**，也就是黑名单：它的前提是
 * **「危险工具集合枚举完整」**，漏一个就**静默放行**。
 *
 * 如果准入层也用黑名单（`--disallowedTools`），两层的前提是同一个 ——
 * **按「同前提的两条加起来还是一条」，那不是两层防护，是一层。**
 *
 * 白名单的前提相反：**「安全工具集合枚举完整」**，漏一个 → agent 报
 * 工具不可用 → **响亮**。
 *
 *   准入层（白名单）：漏项 = 干不了活，立刻被发现
 *   执行层（黑名单）：漏项 = 放行，没人发现
 *
 * **一个漏项响亮、一个漏项静默，方向相反 —— 这才是真的互补。**
 * ────────────────────────────────────────────────────────────────
 *
 * ⚠️ **未知类型返回 `null`**，跟 `capabilitiesFor` 一致。调用方必须自己
 *   fail-closed —— **绝不能把 null 顺着传下去**：`worker-runner` 那边是
 *   `if (allowedTools) args.push(...)`，**不传等于完全不限制**。
 *   「查不到能力」变成「什么都能用」，是这个文件最不能出的事。
 *
 * @returns {string|null} 逗号分隔的工具名；未知类型 → null
 */
function allowedToolsFor(type) {
  const caps = capabilitiesFor(type);
  if (!caps) return null;
  // ★ 三个维度**各自独立**地决定一组工具，两个函数从同一格派生，
  //   不在两个函数里各自表述同一个事实。
  const tools = [...BASE_TOOLS];
  if (caps.bash) tools.push('Bash');
  if (caps.web) tools.push(...WEB_TOOLS);
  if (caps.write) tools.push(...WRITE_TOOLS);
  return tools.join(',');
}

/**
 * 生成 `--disallowedTools` 的值 —— **这才是真正起作用的那一层。**
 *
 * ── ★ 为什么不能只用 `--allowedTools` ────────────────────────────
 *
 *     claude -p --allowedTools "Read,Write,..."   （不含 Bash）
 *       → Bash 仍然可用                            ← **没拦住**
 *     claude -p --disallowedTools "Bash"
 *       → 工具被拒 ✓
 *
 * **`--allowedTools` 是「额外允许」，不禁止未列出的工具。**
 *
 * ⚠️ 白名单的论证本身是对的（hook 那层是黑名单，两层前提要相反才算
 *   真的两层），但 `claude --help` 里的「list of tool names to allow」
 *   读起来像白名单，实际行为是「额外 allow」—— 只有真调用一次才看得出来。
 *
 * **一个前提更好但不生效的防护，防护数是 0，不是 1。**
 *
 * ── 现在的真实层数 ──────────────────────────────────────────────
 * **只有一层，而且是黑名单**：这里 + `hooks/check_security.js`，
 * 两者前提相同（「危险工具集合枚举完整」）。
 * **要变成真的两层，得把 hook 从黑名单改成白名单**（TODO）。
 * **在那之前，别把它报成两层。**
 *
 * `allowedToolsFor` 保留：它是能力表的正向声明、表达意图，
 * **但不能当防护层数。**
 */
/**
 * 能上网的 agent 一并禁掉的**写盘工具**。
 *
 * ── 为什么 Bash 之外还要禁写盘工具 ──────────────────────────────
 *   只禁 Bash 时，模型拿不到 Bash，会改用 `Write` 建出同一个文件。
 *
 *   而且 worker 走 `-p` 模式，**`settings.json` 根本不参与** —— 起作用的
 *   只有命令行 flag。`templates/eval/.claude/settings.json` 里的
 *   `deny: [Bash, Write, Edit, NotebookEdit]` 对 worker 不生效，
 *   真正的禁止必须出现在 `disallowedToolsFor` 生成的 flag 里。
 *
 * ★ 那份 settings.json 里的论证是对的（worker 的任务从 prompt 来、结果走
 *   stdout，本来就不需要碰文件系统），只是写在不参与运行的地方：
 *
 *   > **一个正确的决定 + 正确的理由 + 写在不参与运行的地方 = 零。
 *   >   而它看起来完全像是做过了。**
 *
 * ⚠️ 判据是**不对称**：将来真需要，加回来是容易且可见的；
 *   **多给的权限不容易被发现** —— 直到有人真的让 eval 去越界才现形。
 * ────────────────────────────────────────────────────────────────
 */
const WRITE_TOOLS = ['Write', 'Edit'];

/**
 * `NotebookEdit`：**不给任何类型**。
 *
 * ── 为什么不给它加一个维度 ──────────────────────────────────────
 *   **没有一个类型需要它。** 为一个零使用者的工具加一维，
 *   是把「谁要谁显式要」实现成「谁都不要但仍然要写一格」。
 *   **要的时候再加那一维。**
 *
 * ⚠️ 也不并进 `WRITE_TOOLS` —— 那样 `solve`/`write`（`write: true`）
 *   会拿到它。把几样东西绑成一个常量、再按一个维度整包发，
 *   绑定就还在，只是粒度变了。
 *
 * ⚠️ **对 resident 无影响**：`disallowedToolsFor` 只被 `worker-runner` 用，
 *   而 dev/orchestrator 走 tmux + `settings.json`，**根本不经过那条路**。
 *   所以「谁都禁」对它们是一句没有消费者的声明
 *   （「只禁 worker」和「谁都禁」两种写法对真实行为的差别是零）。
 */
const NOTEBOOK_TOOLS = ['NotebookEdit'];

function disallowedToolsFor(type) {
  const caps = capabilitiesFor(type);
  if (!caps) return null;
  // ★ 跟 `allowedToolsFor` **严格互补**：同一个维度，一边给一边禁。
  //   两边都从 `caps` 的同一格派生，所以不可能说反话。
  const denied = [];
  if (!caps.bash) denied.push('Bash');
  if (!caps.web) denied.push(...WEB_TOOLS);
  if (!caps.write) denied.push(...WRITE_TOOLS);
  denied.push(...NOTEBOOK_TOOLS);
  return denied.join(',');   // 可能是空串：某个类型全都有（现在没有这种）
}

/** 已知类型？未知类型一律不给能力（调用方负责 fail-closed）。 */
function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, type);
}

/**
 * 查能力。**未知类型返回 null，不返回一个「什么都不给」的默认对象** ——
 * 后者会让调用方分不清「这个类型不许用」和「不认识这个类型」，而那两种
 * 情况该有不同的错误信息。「不知道」和「不允许」在安全代码里必须能区分，
 * 哪怕最终动作一样。
 */
function capabilitiesFor(type) {
  return isKnownType(type) ? CAPABILITIES[type] : null;
}

/**
 * 这个类型用哪个模型。返回模型名，或 `null` = 不传 `--model`（`INHERIT`）。
 * 未知类型、或那一格没写 `model` ⇒ **抛**：静默退回「继承」就是把「没人决定」伪装成「决定了继承」。
 */
/**
 * 这个类型能用哪些后端。未知类型、或那一格没写 / 写了不认识的后端 ⇒ **抛**。
 * @returns {string[]}
 */
function backendsFor(type) {
  const caps = capabilitiesFor(type);
  if (!caps) throw new Error(`agent-capabilities: 不认识的类型 "${type}"`);
  const b = caps.backends;
  if (!Array.isArray(b) || !b.length) {
    throw new Error(`agent-capabilities: 类型 "${type}" 没写 backends —— 在能力表里写一个数组（至少 ['claude']）`);
  }
  const bad = b.filter((x) => !BACKENDS.includes(x));
  if (bad.length) throw new Error(`agent-capabilities: 类型 "${type}" 的 backends 里有不认识的后端 ${JSON.stringify(bad)}（认识的：${BACKENDS.join(' / ')}）`);
  return b.slice();
}

function modelFor(type) {
  const caps = capabilitiesFor(type);
  if (!caps) throw new Error(`agent-capabilities: 不认识的类型 "${type}"`);
  if (typeof caps.model !== 'string' || !caps.model) {
    throw new Error(`agent-capabilities: 类型 "${type}" 没写 model —— 在能力表里写一个模型名或 INHERIT`);
  }
  return caps.model === INHERIT ? null : caps.model;
}

function isWebTool(toolName) {
  return WEB_TOOLS.indexOf(toolName) >= 0;
}

module.exports = {
  CAPABILITIES, WEB_TOOLS, BASE_TOOLS,
  capabilitiesFor, allowedToolsFor, disallowedToolsFor, isKnownType, isWebTool,
  modelFor, INHERIT, backendsFor, BACKENDS,
};
