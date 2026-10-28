'use strict';

/**
 * 给一个 resident agent 生成**框架持有**的权限配置，启动时用 `--settings <file>` 注入。
 *
 * ── 为什么不是 cwd 里那份 `.claude/settings.json` ───────────────────────────
 *   那份文件有三个洞：
 *   ① **agent 自己能改它** —— `hooks/check_security.js` 头注释写着「这个 hook
 *      保护不了它自己」。
 *   ② **provision 的 keepEdited 会保留旧版本** —— 一份带着没填的 `{{ENGLOOP}}` 的旧文件
 *      会让安全 hook 指向一个不存在的路径。
 *   ③ **worktree 的根上躺着的是编排者那份**（git checkout 带出来的）。
 *   ⇒ 这里的文件写在 `temp/agent-settings/`：在 agent 的 sandbox 写集之外，
 *     又被一条 Edit deny 盖住 ⇒ agent 的 Bash 和 Write 都碰不到它。
 *   ⇒ CLI `--settings` 在优先级上压过项目级和用户级（只低于 managed），
 *     而 deny 在任何一层都生效 ⇒ cwd 那份即使被改，也加不回被拒的东西。
 *   ⚠️ 而 **allow 是跨层合并的** —— 模板那份 `.claude/settings.json` 写着不带路径的
 *     `Bash, Edit, Write`，合并进来就又能 Write 别人的 outbox。
 *     ⇒ agent-start 同时传 `--setting-sources user`：项目级和 local 那两份**根本不加载**。
 *     模板里唯一还有用的那段（PreToolUse hook）由这里用绝对路径重新给。
 *
 * ── 为什么是 `dontAsk`，不是 `acceptEdits` ─────────────────────────────────
 *   `acceptEdits` 遇到没放行的东西会**弹确认框** ⇒ 一个没人看的 tmux 会话就停在那里，
 *   而 watchdog 只会把它判成 deaf。`dontAsk` 把「会弹框」变成「直接拒绝」⇒
 *   agent 看得到拒绝原因、能报出来，**会话永远不会卡在对话框上**。
 *
 * ── 这份配置的效果（`claude -p --permission-mode dontAsk --settings` 下）──────
 *   验证夹具必须在 `/private/tmp` **之外**：sandbox 本来就放行用户临时目录，
 *   夹具放在那里时「写别人的 poll 文件」这一格**不可能变红**。
 *   能过的：Redis · 写自己 outbox（Write）· 写自己 poll 文件（Bash）· busy 标记 ·
 *          tmux list · worktree 里 git commit
 *   被拦的：Write 别人的 outbox · Write 本目录 · Bash 写别人的 poll 文件 ·
 *          改 `.claude/settings.json`（Write 和 Bash 都拦）· 读 `.env` ·
 *          `git push --force` · 不在 allowedDomains 里的外网
 *   去掉 `allowLocalBinding` ⇒ Redis EPERM；去掉 `allowUnixSockets` ⇒ tmux EPERM
 *   ⇒ 两个开关都是**必需**的，而不是「本来就放行」。
 *
 * ⚠️ `allowLocalBinding` 放行的是**整个 localhost**，不只 6379 ——
 *   包括 bus 的 :9969。按端口放行没有文档化的开关 ⇒ bus 侧自己鉴权：
 *   所有 `/api/*` 和 `/ws` 要凭据，生命周期端点另要
 *   `can_manage_workers`；凭据文件（admin token、用户表）在下面 deny 掉 —— **agent 拿不到钥匙**。
 *   🔴 而 Redis（6379）仍然整个放行：agent 能直接 XADD 一条自称 `sender_type human` 的消息
 *     （`lib/stamp.js` 头注）。章防得住 HTTP 入口，防不住直连 Redis —— 那一格要 Redis ACL。
 */

const fs = require('node:fs');
const path = require('node:path');
const capabilities = require('./agent-capabilities');
const { shellJoin } = require('./agent-launch');

const ROOT = path.join(__dirname, '..');

/**
 * Bash 的外网白名单：**空**，对所有类型。
 * WebFetch/WebSearch 是工具、不走 sandbox，它们由 permissions.allow ＋ hook 的 url_policy 管。
 * 而 url_policy 禁了代码仓库和包 registry（供应链），「新依赖」是要人批的事
 * ⇒ `npm install` / `git fetch` 在 agent 里会被**拒绝**（不是弹框），由它报上来、人来决定。
 */
const BASH_DOMAINS = [];

/** git 基线。**匹配的是命令文本**（`git -C . push -f` 就绕过去了）—— 减速带，不是墙。 */
const GIT_DENY = [
  'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push origin main:*)',
  'Bash(git reset --hard:*)', 'Bash(git clean:*)', 'Bash(git branch -D:*)',
];

/** tmux 的 socket。sandbox 要的是真实路径（macOS 上 /tmp → /private/tmp）。 */
function tmuxSocket() {
  let base = process.env.TMUX_TMPDIR || '/tmp';
  try { base = fs.realpathSync(base); } catch (_) { /* 不在就按原样 —— tmux 自己也会失败 */ }
  return path.join(base, `tmux-${process.getuid()}`, 'default');
}

/** 权限规则里的绝对路径要写成 `//abs`（单斜杠是「相对 settings 来源」）。 */
const abs = (p) => `/${path.resolve(p)}`;

/**
 * agent 的配置 —— 保留这个名字（测试和 Stop hook 的文档都按这个名字引用）。
 * 现在只是 `buildAgentSettings({ kind: 'crew', … })` 的别名。
 *
 * @param {object} o
 * @param {string} o.name  agent 名
 * @param {string} o.type  能力表里的类型
 * @param {string} o.cwd   agent 的工作目录（绝对路径）
 * @param {string} [o.root] EngLoop 根（测试用）
 */
function buildCrewSettings(o) {
  return buildAgentSettings({ ...o, kind: 'crew' });
}

/** 三种启动路径。**只有这三种** —— 拼错一个字母不能退回成「随便哪种」。 */
const KINDS = ['crew', 'orchestrator', 'worker'];

/**
 * ── 所有 agent 的启动配置，**一个函数** ──────────────────────────────────
 *
 *   三条启动路径（agent / 编排者 / worker）各写一份的话，验证过的那些规则
 *   只在一条路径上成立 —— 而另外两条「看起来」一样。⇒ 一个函数，按 `kind` 参数化，
 *   **差别只写在下面这几处 `if (kind === …)` 里**，一眼能数完：
 *
 *     差别              agent                 orchestrator              worker
 *     sandbox           有                   **没有**（见下）            有
 *     Bash              sandbox 里自动放行     **显式 allow**             sandbox 里自动放行（有 bash 的类型）
 *     写集（Edit）      自己的 cwd ＋ outbox  仓库根 ＋ worktrees 目录 ＋ 自己的 memory 目录   能写的类型：自己的 cwd
 *     钥匙（token/用户表） 拒读                **能读**（它是编排者）       拒读
 *     QA 产物           拒写                 不拒（verify-complete 由它手动跑时要写缓存）  拒写
 *     hooks            check_security ＋ Stop **StopFailure ＋ journal**   check_security ＋ StopFailure
 *                      ＋ StopFailure        （见下；没有 check_security）
 *                      ＋ journal ＋ SessionStart
 *     temp/ 按人分的文件  自己那几个           自己那几个 ＋ outbox/JARVIS  无（结果走 stdout）
 *
 *   （journal = `hooks/tool_journal.js` 挂在 PreToolUse / PostToolUse / PostToolUseFailure 上；
 *     SessionStart 也是它，只写 `<name>.session` 给 agent-start 判断接不接回会话。）
 *
 *   ★ StopFailure **三种都挂，编排者也挂** ——
 *     这是「编排者没有 hook」那条规则的**第一个例外**：JARVIS 撞墙时没有别人在看着，最需要这个信号。
 *     它只在 API 错误结束回合时触发、只写一个信号文件、退出码被忽略 ⇒ 不改编排者的任何行为纪律。
 *     名字在这里写死进命令行（跟 Stop hook 传 `--settings` 同一个做法）⇒ agent 改不了自己的配置，冒不了别人的名。
 *     ⚠️ 生成的配置要等 agent **重启**才生效。
 *   ★ 工具调用日志（journal）**crew 和编排者挂，worker 不挂** —— 这是**第二个例外**，理由同类：
 *     只记录、不改行为（退出码永远 0、stdout 永远空 ⇒ 不是任何权限决定；实测跟 check_security 并行、互不影响）。
 *     编排者也会收到 `redelivered: true` 的消息，重投时它跟 agent 一样需要「上一次做到哪了」的材料。
 *     worker 是一次性的：被重投时起的是一个全新的 worker，没有「接着上一次」这回事。
 *     根 `.claude/settings.json` **不动**（444，事故止血）—— 编排者的这两个例外都在这里生成的那份里。
 *   ⚠️ 编排者**不挂** check_security（它的 PreToolUse 上只有 journal）：根 `.claude/settings.json` 只有 SessionStart，
 *     而那个 hook 拒 `&&`、拒管道 —— 挂上去等于改变编排者的 Bash 纪律。
 *     编排者的 Bash 防护 = dontAsk ＋ GIT_DENY（下面）—— **只是防手滑**，见下一段。
 *   ⚠️ 编排者**仍然加载**根 `.claude/settings.json`（压缩补回 hook 在那里）⇒ 启动时**不**带
 *     `--setting-sources user`。那份文件的 allow 会合并进来；按 Claude Code 文档 deny 在任何一层都生效
 *     （这一条未经验证，依据只有文档）。
 *
 * ── 编排者**没有 sandbox** ──────────────────────────────────────────────────
 *   · 在 sandbox 里跑全量测试会多出一批失败：私有 tmux socket 连不上、`ps` 是 setuid（被拒）、
 *     隔离 bus 起不来 ⇒「提交前自己跑全量」这条纪律在 sandbox 里不成立。
 *   · `lib/sandbox-profile.js` 的 available() 在它的 sandbox 里是 false（sandbox 套 sandbox 起不来）
 *     ⇒ 它手动跑 verify-complete 只会得到 unverifiable ⇒ 照 wt-merge 的提示去核，永远拿不到 pass。
 *   ⇒ sandbox.enabled:false；dontAsk 下没有 sandbox 就没有「sandbox 里的 Bash 自动放行」⇒ allow 里显式加 `Bash`。
 *   🔴 **剩下的 deny 只是防手滑，不是防注入**：
 *     · `Edit(...)` deny 只拦 Write / Edit 工具，**拦不住 Bash**（`echo > .claude/…` 能写）；
 *     · `Bash(git push --force:*)` 是命令文本的前缀匹配，换个写法（`git push origin +main`、`git -C . push -f`）就绕过；
 *     · 被注入的编排者能用 Bash 写任何地方、连外网、读钥匙 —— 这是已接受的风险。
 *   没采用的选项：保留 sandbox、给全量 / verify-complete / bus-restart 开 `excludedCommands` ——
 *   编排者能改仓库里的测试和框架代码，被排除的命令执行的正是它改过的代码 ⇒ 开口子挡不住被注入的编排者，配置却复杂一截。
 *
 * @param {object} o
 * @param {'crew'|'orchestrator'|'worker'} o.kind
 * @param {string} o.name   agent 名 / 'JARVIS' / worker 的文件名标签
 * @param {string} o.type   能力表里的类型
 * @param {string} o.cwd    工作目录（绝对路径）
 * @param {string} [o.root] EngLoop 根（测试用）
 */
function buildAgentSettings({ kind, name, type, cwd, root = ROOT }) {
  if (!KINDS.includes(kind)) throw new Error(`agent-settings: 不认识的启动路径 "${kind}"（可选 ${KINDS.join(' / ')}）`);
  const cap = capabilities.capabilitiesFor(type);
  if (!cap) throw new Error(`agent-settings: 能力表里没有类型 "${type}"`);
  if (kind === 'orchestrator' && type !== 'orchestrator') throw new Error(`agent-settings: 编排者的类型只能是 orchestrator（给的是 "${type}"）`);
  if (kind !== 'orchestrator' && type === 'orchestrator') throw new Error('agent-settings: orchestrator 类型只给编排者');
  const temp = path.join(root, 'temp');
  const outbox = path.join(temp, 'outbox', name);
  const hasOutbox = kind !== 'worker';

  const allow = ['Read', 'Glob', 'Grep'];
  if (hasOutbox) allow.push(`Edit(${abs(outbox)}/**)`);
  if (kind === 'orchestrator') {
    // 编排者要提交代码 ⇒ 整个仓库根 ＋ 它建的 worktree 目录（`agent-start --worktree` 往那里 `git worktree add`）。
    // `Bash`：没有 sandbox ⇒ 没有「sandbox 里自动放行」，dontAsk 下不显式 allow 就什么命令都跑不了。
    allow.push('Bash', `Edit(${abs(root)}/**)`, `Edit(${abs(worktreesDir(root))}/**)`);
    // 自己的 memory 目录：Claude Code 按项目路径存在 ~/.claude/projects/<编码后的路径>/memory/。
    //   编码 = 路径里每个非字母数字字符换成 `-`（例：/home/user/EngLoop ⇒ -home-user-EngLoop）。
    //   Claude Code 自己写 memory 时会不会走权限检查 —— 没查到权威说法 ⇒ 显式 allow 一条（只放 memory 子目录，
    //   不放 ~/.claude 别处）。路径编码规则是推断的，未经验证。
    allow.push(`Edit(${abs(memoryDir(root))}/**)`);
  } else if (cap.write) {
    allow.push(`Edit(${abs(cwd)}/**)`);
  }
  if (cap.web) allow.push('WebSearch', 'WebFetch');

  // ★ bus 的钥匙：admin token 是 `local-admin`（能起停 agent）的凭据，
  //   用户表里是登录用的 key 摘要。agent 读得到其中任何一个，bus 的鉴权就只剩形式。
  //   两层：`Read(//…)` 拦 Read 工具，`sandbox.filesystem.denyRead` 拦 Bash（`cat`）。
  //   ⚠️ 用户表存的是 sha256，读到也登录不了 —— 这里仍然拦，因为摘要能用来离线核对猜测，
  //     而「谁有账号、谁能管 worker」本身也不该是 agent 的输入。
  //   ★ 编排者例外：`bin/agent-start.js --stop` / `bin/graph.js` 走 admin token —— 那是它的活。
  //   ★ agy 后端的专用 HOME（里面是 agy 的 Google 登录）也是钥匙 —— 它是**目录**，单列在 secretDirs()：
  //     Read 规则要写成 `Read(//dir/**)`，sandbox denyRead 直接给目录。
  const secretFiles = kind === 'orchestrator' ? [] : secretPaths(root);
  const secretTrees = kind === 'orchestrator' ? [] : secretDirs();
  const secrets = [...secretFiles, ...secretTrees];
  const sDir = settingsDir(root);
  const writeRoot = kind === 'orchestrator' ? root : cwd;

  const deny = [
    `Read(${abs(writeRoot)}/.env)`, `Read(${abs(writeRoot)}/.env.*)`,
    ...secretFiles.map((f) => `Read(${abs(f)})`),
    ...secretTrees.map((d) => `Read(${abs(d)}/**)`),
    // Edit 规则同时管 Write（Write(...) 规则会被接受但从不被查）。
    `Edit(${abs(writeRoot)}/.claude/**)`,
    `Edit(${abs(sDir)}/**)`,
    ...GIT_DENY,
  ];
  if (!cap.bash) deny.push('Bash');
  if (!cap.write) deny.push(`Edit(${abs(cwd)}/**)`);
  // ★ QA 产物：**所有** agent 类型都写不了。QA 结论只有两个来源 ——
  //   `work:test` 的 job 结果（test worker 没有写能力，结果走消息）和 verify-complete 自己写的缓存。
  //   agent 能写到的地方一旦出现 QA 结论，「独立」就只剩名字：干活的人能替验收的人签字。
  //   两层：Edit deny 拦 Write / Edit 工具；下面 sandbox 的 denyWrite 拦 Bash。
  //   worker 同理（solve / write 有写能力）。编排者不拦：它手动跑 verify-complete 时要写缓存。
  const qa = kind === 'orchestrator' ? [] : qaGuarded({ cwd, root });
  deny.push(...qa.map((p) => `Edit(${abs(p)})`));

  // poller / outbox-send / heartbeat 往 temp/ 里写的**按人分的**文件 ——
  // 按文件放行，不按目录：放行 temp/ 整个目录 = 能写别人的 poll 文件和别人的 outbox。
  const allowWrite = hasOutbox ? [
    outbox,
    path.join(temp, `poll-${name}.json`),
    path.join(temp, `probe-state-${name}.json`),
    path.join(temp, `waiting-${name}.json`),
    path.join(temp, `acked-ids-${name}.json`),
    path.join(temp, 'sent-jobs.json'),
    path.join(temp, 'busy'),
    // `node bin/plugin.js` 的运行目录（config/suitehost/host.yaml 的 `data:`）。
    // 不放的话 `plugin.js list` 直接 EPERM。共享目录 —— 插件本来就是给所有 agent 调的。
    path.join(temp, 'plugin-runs'),
  ] : [];
  // worker：能写的类型写自己的 cwd（sandbox 默认也放 cwd，这里显式写出来，不靠默认）。
  // （编排者没有 sandbox，这一段对它不生效 —— 它在下面 return 之前就返回了。）
  if (kind === 'worker' && cap.write) allowWrite.push(cwd);
  const denyWrite = [...qa, ...mainRefGuard(cwd)];

  const hooks = {};
  if (kind !== 'orchestrator') {
    hooks.PreToolUse = [{
      matcher: 'Bash|WebSearch|WebFetch|Fetch',
      hooks: [{ type: 'command', command: `node ${JSON.stringify(path.join(root, 'hooks', 'check_security.js'))}` }],
    }];
  }
  // ★ Stop：回合结束跑改动范围内的快测 —— 只给**有写能力的 agent**：
  //   不能写的改不了代码，跑它只是每个回合白付一次 git status；worker 是一次性的，结果由派活的人核。
  //   timeout 150 秒 > hook 自己的 120 秒预算：让 hook 自己说「超时、这次不拦」，而不是被 Claude Code 掐掉。
  //   ★ 把**这份配置文件的路径**作为参数传给 hook：hook 据它读 sandbox.filesystem 的
  //     allowWrite / denyRead，用 sandbox-exec 把测试套进跟这个 agent **同一个**写集和拒读集里跑。
  //     配置在 temp/agent-settings/（agent 的 Edit deny 盖住了）⇒ hook 读的不是 agent 写得到的地方。
  if (kind === 'crew' && cap.write) {
    hooks.Stop = [{ hooks: [{ type: 'command', timeout: 150,
      command: `node ${JSON.stringify(path.join(root, 'hooks', 'stop_check.js'))} --settings ${JSON.stringify(path.join(sDir, `${name}.json`))}` }] }];
  }

  // ★ 工具调用日志（DUR1 S1，`hooks/tool_journal.js`）：**crew 和编排者挂，worker 不挂**（见函数头那张表）。
  //   PreToolUse ⇒ intent · PostToolUse ⇒ outcome(ok) · PostToolUseFailure ⇒ outcome(!ok)。
  //   ⚠️ PostToolUseFailure 不能省：实测执行失败（Bash 非零退出、Read 不存在）**不走** PostToolUse ——
  //     只挂 PostToolUse 的话，每个失败的调用在日志里都是「只有 intent」，跟执行中崩溃长得一样。
  //   matcher `*`：所有工具都记（分类在读的一侧做，见 lib/tool-journal.js 的 READONLY_TOOLS）。
  //   排在 check_security **后面**只是为了让 `PreToolUse[0]` 仍是 check_security（别处按下标引用它）——
  //   实测两个 PreToolUse 条目是**并行**跑的，顺序不影响谁先执行，journal 也影响不了 check_security 的结论。
  //   timeout 5 秒：它只追加一行；每次工具调用都要等它（跟 check_security 并行，等的是两者中慢的那个）。
  //   `--name` 走 shellJoin，同 StopFailure 那段。
  // ★ SessionStart（**只给 crew**）：覆盖写 `temp/journal/<name>.session`，给 agent-start 判断接不接回（DUR3 起默认接回）。
  //   为什么不从 jsonl 最后一行拿 session_id：① `/clear` 会换一个新 id，SessionStart(source=clear) 当场记下，
  //   而 jsonl 要等下一次工具调用才看得到；② 起来之后还没调用过工具的会话，jsonl 里根本没有它；
  //   ③ jsonl 会轮转，最后一行可能在 `.1` 里。代价：多挂一个 hook。
  //   编排者不挂：`--resume` 只做在 agent-start 上（orch-start 没有）。
  //   ★ 只有 session 那条多带 `--type <类型>`（DUR3 R3）：记录里有了类型，同名换类型重启时 resumePlan 才拦得住。
  //     type 从这里传而不是从 stdin 读：Claude Code 不知道 EngLoop 的类型；而写在配置里 ⇒ agent 改不了（配置在它的 Edit deny 里）。
  //     另外三个事件不带：jsonl 不需要它，多一个参数只是让每次工具调用的命令行变长。
  const journalCmd = (event) => `node ${JSON.stringify(path.join(root, 'hooks', 'tool_journal.js'))} --event ${event} --name ${shellJoin([name])}`
    + (event === 'session' ? ` --type ${shellJoin([type])}` : '');
  const journalEntry = (event) => ({ matcher: '*', hooks: [{ type: 'command', timeout: 5, command: journalCmd(event) }] });
  if (kind !== 'worker') {
    hooks.PreToolUse = [...(hooks.PreToolUse || []), journalEntry('intent')];
    hooks.PostToolUse = [journalEntry('outcome')];
    hooks.PostToolUseFailure = [journalEntry('failure')];
  }
  if (kind === 'crew') {
    hooks.SessionStart = [{ hooks: [{ type: 'command', timeout: 5, command: journalCmd('session') }] }];
  }

  // ★ StopFailure：**三种 kind 都挂，编排者也挂**（见函数头那张表）。只认 `rate_limit` ——
  //   别的 API 错误（overloaded / auth / …）不是「额度用完」，不该让 watchdog 改判。
  //   timeout 10 秒：hook 只写一个小文件；而它是 fire-and-forget，超时也不拖住会话。
  //   `--name` 走 shellJoin（单引号）：合格的名字（NAME_RE）原样输出；不合格的被安全地引起来，由 hook 自己拒。
  hooks.StopFailure = [{ matcher: 'rate_limit', hooks: [{ type: 'command', timeout: 10,
    command: `node ${JSON.stringify(path.join(root, 'hooks', 'stop_failure.js'))} --name ${shellJoin([name])}` }] }];

  const permissions = {
    defaultMode: 'dontAsk',
    disableBypassPermissionsMode: 'disable',
    allow,
    deny,
    additionalDirectories: hasOutbox ? [outbox] : [],
  };
  // 编排者：没有 sandbox（见函数头「编排者没有 sandbox」那段）。**不写** failIfUnavailable 之类 —— 只有这一项。
  if (kind === 'orchestrator') return { permissions, sandbox: { enabled: false }, hooks };

  return {
    permissions,
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      // 不许「sandbox 拦了就换不带 sandbox 的重试」—— 那条逃生口在 dontAsk 下也会被拒，
      // 这里再关一道，让它连试都不试。
      allowUnsandboxedCommands: false,
      // sandbox 起不来时**拒绝启动**，而不是退回成没有 sandbox 的会话。
      failIfUnavailable: true,
      filesystem: { allowWrite, denyRead: secrets, denyWrite },
      network: {
        allowLocalBinding: true,
        allowUnixSockets: [tmuxSocket()],
        allowedDomains: BASH_DOMAINS,
      },
    },
    hooks,
  };
}

/**
 * 配置文件放哪。默认 `<root>/temp/agent-settings/`。
 * `ENGLOOP_AGENT_SETTINGS_DIR`：**测试隔离用**（跟 serve.js 隔离表里那些 ENGLOOP_* 同一类）——
 * 编排者的配置文件名固定是 `JARVIS.json`，测试起 orch-start 时不能覆盖生产那份
 * （那份里写着 tmux socket 的路径，测试的私有 socket 会把它改掉）。
 * deny 和 Stop hook 都从这里取，所以挪了位置的那份照样写不到、hook 照样找得到。
 */
function settingsDir(root = ROOT) {
  return process.env.ENGLOOP_AGENT_SETTINGS_DIR
    ? path.resolve(process.env.ENGLOOP_AGENT_SETTINGS_DIR)
    : path.join(root, 'temp', 'agent-settings');
}

/**
 * ── linked worktree 里的 agent 不许挪主仓库的 main ───────────────────────
 *
 *   cwd 是一棵 linked worktree 时，Claude Code 的 sandbox 会**自动**放行主仓库的 `.git`
 *   （worktree 的提交要写 `.git/objects`、`.git/worktrees/<name>/`、`.git/refs/heads/wt/<name>`）——
 *   `.git/config`、`.git/hooks` 它抠掉了（写被拒），**`refs/heads/main` 没有**：
 *   agent 跑 `git -C <主仓库> update-ref refs/heads/main <自己的 sha>` ⇒ 成功，main 指到了没核过的 commit，
 *   `bin/wt-merge.js` 的 verify 闸整个被绕开。
 *   ⇒ 把 main 的 ref（loose 或 packed，见函数里 ① ②）、主工作树的 `HEAD` 抠出写集。
 *
 *   ⚠️ 两条写法约束（Linux / bubblewrap）：
 *   ① **不存在的文件不能直接 deny**：bubblewrap 会在那里放一个占位，git 读 `packed-refs` 时
 *     `Permission denied` ⇒ 连 `git status` 都坏。⇒ 本体只 deny **启动时已存在的**；
 *   ② `.lock` 从来不会被读 ⇒ 占位不碍事；git 改 ref 都先建 `<文件>.lock`、再改名 ⇒ deny `.lock` 就堵住经 git 的写。
 *   效果：loose 形态下 `update-ref refs/heads/main` ⇒ `cannot lock ref`；agent 自己分支上 `git commit`、`git branch -d` 照常。
 *
 * @returns {string[]} 不是 linked worktree（或不在 git 里）⇒ 空数组
 */
function mainRefGuard(cwd, mainRef = 'main') {
  const { spawnSync } = require('node:child_process');
  let d = path.resolve(cwd);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  const q = (arg) => {
    const r = spawnSync('git', ['-C', d, 'rev-parse', '--path-format=absolute', arg], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const gitDir = q('--git-dir');
  const common = q('--git-common-dir');
  if (!gitDir || !common || path.resolve(gitDir) === path.resolve(common)) return [];
  // ── 不能无条件 deny packed-refs.lock：
  //   git 的 files 后端**删任何 ref** 都要锁 packed-refs ⇒ agent 会删不了任何分支（`git branch -d x` exit 1、分支还在），
  //   macOS 上每次 commit 还多打一行 error。⇒ 按 main 存在的形态分两种：
  //
  //   ① main 是 **loose 文件**（refs/heads/main 在）：loose 优先于 packed-refs ⇒ packed-refs 里写什么都挪不动 main
  //     ⇒ 只 deny main 的 loose 文件 ＋ 它的 .lock ＋ 主 HEAD ＋ HEAD.lock，**不碰 packed-refs / packed-refs.lock**。
  //     「删掉 loose 的 main，让 packed 里那份（或空）生效」这条路：删这个文件 = 对这个路径的写 ⇒ 已被 deny
  //     （Linux 上 rm 被拒；bubblewrap 是把它只读挂载，unlink 一个挂载点会失败）。
  //     `git update-ref -d` / `git branch -D main` 也要先建 main.lock ⇒ 同样被拒。
  //   ② main **只在 packed-refs 里**（`git pack-refs --all` / gc 之后）：
  //     deny packed-refs（本体，存在）＋ packed-refs.lock ＋ refs/heads/main.lock（防止建一个 loose main 盖过 packed 那份）
  //     ＋ 主 HEAD ＋ HEAD.lock。**代价**：这种形态下 agent 删不了任何分支（删 ref 要锁 packed-refs）。
  //     ⚠️ refs/heads/main 本体这时不存在 ⇒ 不能 deny（Linux 上会留占位，git 读 main 时坏掉）⇒
  //     不经 git、直接 `echo <sha> > refs/heads/main` 建一个 loose main 这条路**没堵**。经 git 的路都要 main.lock，堵了。
  //   main 两处都没有（空仓库）⇒ 按 ① 的 lock 那几项给，不 deny 不存在的本体。
  const loose = path.join(common, 'refs', 'heads', mainRef);
  const packed = path.join(common, 'packed-refs');
  const head = path.join(common, 'HEAD');
  const exists = (f) => fs.existsSync(f);
  const inPacked = exists(packed)
    && fs.readFileSync(packed, 'utf8').split('\n').some((l) => l.endsWith(` refs/heads/${mainRef}`));
  const out = [];
  if (exists(loose)) out.push(loose);
  out.push(`${loose}.lock`);
  if (exists(head)) out.push(head);
  out.push(`${head}.lock`);
  if (!exists(loose) && inPacked) out.push(packed, `${packed}.lock`);
  return out;
}

/** 编排者的 Claude Code memory 目录（推断的编码规则，见 buildAgentSettings 里那段）。 */
function memoryDir(root = ROOT) {
  const enc = path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');
  return path.join(require('node:os').homedir(), '.claude', 'projects', enc, 'memory');
}

/** 编排者自动建 worktree 的地方：仓库根的兄弟目录（`../EngLoop-worktrees`）。 */
function worktreesDir(root = ROOT) {
  return path.join(path.dirname(path.resolve(root)), `${path.basename(path.resolve(root))}-worktrees`);
}

/**
 * QA 产物路径。cwd 下和 EngLoop 根下各一份 —— agent 的 cwd 可能是 `agents/<name>`（在根里面），
 * 也可能是一棵 EngLoop worktree（自己就有 `docs/flows/`、`temp/`）。
 * ⚠️ 规则里的通配是 `**` 跨目录、`*` 一段。
 */
/**
 * 钥匙清单 —— **唯一出处**。agent 会话的 sandbox（denyRead ＋ Read deny）和「替 agent 跑测试」那层
 * `sandbox-exec`（lib/sandbox-profile.js）都从这里取。各写一份早晚漂移：一边还拦着、一边放了，零报错。
 * admin token 是 `local-admin`（起停 agent）的凭据；users.json 是登录 key 的 sha256（读到能离线核对猜测）。
 */
function secretPaths(root = ROOT) {
  return [path.join(root, 'temp', 'bus-admin.token'), path.join(root, 'config', 'users.json')];
}

/**
 * 钥匙**目录**（整棵拒读）—— agy 后端的专用 HOME（`lib/agy-config.js`，里面是 agy 的 Google 登录凭据）。
 * 跟 secretPaths 同一个意思、分开列是因为写法不同：Read 规则 `Read(//dir/**)`、sandbox-exec 用 `subpath` 不用 `literal`。
 * 路径**不跟 root 走**：专用 HOME 只有一个（配置那一处），测试传的假 root 不改变它。
 */
function secretDirs() {
  return [require('./agy-config').AGY_CONFIG.home];
}

function qaGuarded({ cwd, root }) {
  const out = [];
  for (const base of [...new Set([path.resolve(cwd), path.resolve(root)])]) {
    out.push(path.join(base, '**', 'QA*.md'));
    out.push(path.join(base, 'docs', 'flows', '*', 'TEST_REPORT.md'));
    out.push(path.join(base, 'temp', 'verify-cache'));
    out.push(path.join(base, 'temp', 'verify-cache', '**'));
  }
  return out;
}

/**
 * 这个 cwd 会不会在启动时弹 workspace trust 对话框？
 *
 * ── 为什么要在启动**前**问 ─────────────────────────────────────────────
 *   带 `--dangerously-skip-permissions` 时 trust 对话框不出现。不带 bypass 时，
 *   在一个没被信任的目录里起 agent ⇒ 会话**停在 trust 对话框上**，
 *   而 agent-start 的就绪正则 `❯` 正好命中对话框的选择光标 ⇒ 报「✓ TUI 就绪」。
 *
 * ── 判据：**git 仓库根**，精确匹配，不看祖先 ───────────────────────────
 *   不能按「cwd 或任一祖先被信任」判：一个被信任的目录下面的一棵 worktree
 *   照样弹框（那棵 worktree 是它自己的 git 根）。
 *   ⇒ 按 `git rev-parse --show-toplevel` 取根、只认那一条；不在 git 里就认 cwd 本身。
 *   ⚠️ linked worktree 的信任看 worktree 自己还是主仓库，**没有确认过**。
 *     这里按 worktree 自己算 —— 错了的方向是「多拒一次」，有声、一行修法。
 *   ⇒ 这仍然是推断 ⇒ agent-start 起来之后还要看一眼 pane（第二道）。
 */
function trustRoot(cwd) {
  // cwd 可能还不存在（provision 才会建它）⇒ 拿最近一个存在的祖先去问 git。
  let d = path.resolve(cwd);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  const r = require('node:child_process').spawnSync('git', ['-C', d, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : path.resolve(cwd);
}

function isTrusted(cwd, { claudeJson = path.join(require('node:os').homedir(), '.claude.json'), root } = {}) {
  let projects;
  try { projects = JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects || {}; }
  catch (_) { return false; }   // 读不到 ⇒ 当没信任：误报的代价是一行修法，漏报的代价是一个卡死的 agent
  const key = root || trustRoot(cwd);
  return !!(projects[key] && projects[key].hasTrustDialogAccepted);
}

/** pane 上是不是那个 trust 对话框（启动后的第二道）。 */
const TRUST_DIALOG = /trust this folder|one you trust/i;

/**
 * 生成并落盘，返回文件路径。每次启动都重写 —— 这份文件只属于框架。
 * 文件名：agent / 编排者 = `<name>.json`（Stop hook 按这个名字找）；
 * worker = `worker-<type>-<cwd 摘要>.json` —— 同一类型的 worker 可能同时站在不同的项目里，
 * 写集跟着 cwd 走，共用一个文件会让后起的那个改掉先起的那个的写集。
 */
function writeAgentSettings(o) {
  const root = o.root || ROOT;
  const dir = settingsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const base = o.kind === 'worker'
    ? `worker-${o.type}-${require('node:crypto').createHash('sha1').update(path.resolve(o.cwd)).digest('hex').slice(0, 10)}`
    : o.name;
  const file = path.join(dir, `${base}.json`);
  // 先写临时文件再改名：并发起两个同类型 worker 时，另一个不会读到写了一半的 JSON。
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(buildAgentSettings(o), null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

function writeCrewSettings(o) {
  return writeAgentSettings({ ...o, kind: 'crew' });
}

module.exports = {
  qaGuarded, secretPaths, secretDirs,
  buildCrewSettings, writeCrewSettings, buildAgentSettings, writeAgentSettings, worktreesDir, settingsDir, mainRefGuard, memoryDir, KINDS,
  isTrusted, trustRoot, TRUST_DIALOG, tmuxSocket, BASH_DOMAINS, GIT_DENY,
};
