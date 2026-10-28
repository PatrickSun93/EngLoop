#!/usr/bin/env node
'use strict';

/**
 * 起一个 resident agent。
 *
 * 对应 v1 的启动脚本（存档在 vendor/）。这里短很多 ——
 * 没有 PID 注册表、没有关停队列、没有 git-bash 脚本生成。
 *
 * 不变量「最小启动任务」：启动指令只说「向编排者报到」，
 * 绝不夹带具体工作 —— 夹带会让 agent 抢跑在还没传达的计划前面。
 *
 * 用法:
 *   node bin/agent-start.js --name dev --cwd ../some-project
 *   node bin/agent-start.js --name probe1 --kick "你是 probe1。⛔ 不许跑任何 poller。只做一件事然后停。"
 *   node bin/agent-start.js --name dev --bypass-permissions   回滚：不带 sandbox 起（会警告）
 *   node bin/agent-start.js --name dev1 --worktree   在 ../EngLoop-worktrees/dev1 起（没有就 `git worktree add -b wt/dev1 … main`）
 *   node bin/agent-start.js --name dev --resume      接回重启前的会话（有记录且 cwd 相同才接；否则警告、起全新会话）
 *   node bin/agent-start.js --list
 *   node bin/agent-start.js --stop dev            优雅停（等它把手上的活收尾）
 *   node bin/agent-start.js --stop dev --force    强杀（等于 kill -9）
 *
 * --stop 需要 bus 在跑：READY_TO_SHUTDOWN 是 agent 写的 outbox 文件，
 * 只有 bus 进程里的 relay 看得见它（见 lib/shutdown.js）。
 */

const fs = require('node:fs');
const path = require('node:path');
const tmux = require('../lib/tmux');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const shutdown = require('../lib/shutdown');
const capabilities = require('../lib/agent-capabilities');
const { writeCrewSettings, isTrusted, TRUST_DIALOG } = require('../lib/agent-settings');
const launch = require('../lib/agent-launch');
// ★ 模板下发搬去了 lib —— **worker 也要用它，而 lib 不该依赖 bin**。
//   这里只保留「resident agent 的默认策略」（keepEdited），逻辑只有那一份。
const { provision, listTemplateFiles, fillPlaceholders, claimsIdentity, countClaims } = require('../lib/provision');
// 「可选类型」那行的唯一出处。**不用 Object.keys(CAPABILITIES)** ——
// 那份清单里有的类型缺模板、根本起不来（见下面调用处）。
const discovery = require('../lib/template-discovery');
// `--resume` 要的 session 记录（DUR1 S3）。路径和判据都在那边，这里不写第二份。
const toolJournal = require('../lib/tool-journal');

const ROOT = path.join(__dirname, '..');
const ORCH = 'JARVIS';

/**
 * 默认 kick。**不 resume 时这句一个字都不能变**（不传参时的默认值 = 行为，见 start() 里 `--kick` 那段）。
 *
 * ── resume 时为什么还要发一句 kick，而且换了内容 ────────────────────────
 *   `--resume` 只是把上下文接回来，**不会让会话自己接着跑** —— 没有一条新的用户消息，它就停在输入框上，
 *   而 watchdog 只会看到一个不轮询的 agent。⇒ 还是要一句话把它推回循环。
 *   照发原来那句的话，它读到的是「你是 X。进入你的循环：先报到」—— 跟上面那段上下文对不上
 *   （上下文里它正干到一半），而且没告诉它「你刚崩过、重投的消息带着 recovery」。
 *   ⇒ 换成「你刚被重启」那句。仍然是**最小启动任务**：只说报到、跑 poller、怎么读 recovery，不夹带具体工作。
 *   实测（2.1.312，`-p` 模式）：`claude -p --resume <id> "<prompt>"` 会把 prompt 当成接回之后的下一条用户消息处理。
 *   ⚠️ 交互模式下同一条命令的行为**没有实测**（在本机起交互式 claude 被权限分类器拒了）——
 *     PR 描述里列了人工验收步骤；如果交互模式不提交位置参数，这句只是不生效，不会造成错误的动作。
 */
function defaultKick(name, { resumed = false } = {}) {
  return resumed
    ? `你是 ${name}。你刚被重启，用 --resume 接回了重启前的会话（上面是之前的上下文，那时手上的活可能做到一半）。`
      + `先向编排者 ${ORCH} 报到（写一条 outbox 消息说你已重新上线），然后运行 poller 等待指令。`
      + '收到 redelivered:true 的消息时，先读它的 recovery 字段、去现场核对，再决定重做还是跳过。不要做别的。'
    : `你是 ${name}。进入你的循环：先向编排者 ${ORCH} 报到（写一条 outbox 消息说你已上线），然后运行 poller 等待指令。不要做别的。`;
}

/**
 * tmux 里跑的那一整条命令。不带 resumeId 时跟改动前那一行**逐字节相同**（test/agent-resume.test.js 守着）。
 * `--resume <id>` 放在 prompt 前面、其余参数原样：权限 / 模型 / `--append-system-prompt-file` 一个都不能少 ——
 * resume 接回的是对话，不是启动参数；少一个就是「接回来的会话换了权限 / 模型 / 身份」。
 * id 已经被 resumePlan 校验成 UUID，shellJoin 只是多一道保险。
 */
function claudeCommand({ permFlags, modelFlags, prompt, personaFile, resumeId = null }) {
  const resume = resumeId ? ` ${launch.shellJoin(['--resume', resumeId])}` : '';
  return `${launch.envUnsetPrefix()} claude ${permFlags}${modelFlags ? ` ${modelFlags}` : ''}${resume} ${JSON.stringify(prompt)}`
    + ` --append-system-prompt-file ${JSON.stringify(personaFile)}`;
}

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
}


async function start() {
  const name = arg('name');
  const type = arg('type', 'dev');
  if (!name) { console.error('✗ 需要 --name'); process.exit(1); }
  // ★ 在**注入点**校验类型，而不是等 hook 去拒。
  //
  //   注入一个能力表不认识的字符串，hook 会 fail-closed 拒掉这个 agent 的
  //   每一次工具调用 —— 而那时的故障现场跟「hook 正常工作」长得一模一样，
  //   全是 REJECT。agent 自己只会看到一连串拒绝，不知道是启动时打错了类型名。
  //
  //   在这里失败，错误信息能直接说清是哪个类型名不对、有哪些可选 ——
  //   **越早失败，现场信息越完整。**
  if (!capabilities.isKnownType(type)) {
    console.error(`✗ 不认识的 agent 类型 "${type}"`);
    // ★ 用 `safeHint()` 而不是 `usableTypesHint()`，**因为这里是错误处理路径**。
    //
    //   走到这一行时，用户已经打错了类型名。提示行要是抛异常，那条异常会把
    //   上面那句「✗ 不认识的 agent 类型 "xxx"」整个盖掉 —— 用户打错了一个
    //   类型名，却得到一条关于模板目录的 ENOENT，**他会去查模板目录，
    //   而问题在他的命令行里**。
    //
    //   `safeHint()` 的契约是**永不抛**，坏掉时说「列不出可用类型」而
    //   **绝不退回 `Object.keys(CAPABILITIES)`** —— 能力表里有的类型缺模板起不来，
    //   把它们当可选项列给一个刚打错名字的人，他会从里面挑一个再撞一次墙。
    console.error(`  可选: ${discovery.safeHint()}`);
    console.error('  类型要先登记进 lib/agent-capabilities.js —— 那是能力的唯一数据源。');
    process.exit(1);
  }

  // ★ agent 不能是 orchestrator 类型。
  //
  //   会话名走 roster.sessionFor()，而
  //   sessionFor(name,'orchestrator') 返回 `orch`，于是 `--type orchestrator`
  //   会让一个 agent 去占编排者的会话名。编排者在跑的话它会撞在「orch 已在运行」
  //   上（错误信息还很误导），**编排者没在跑的话就真占上了，orch-start 起不来。**
  //
  //   `orchestrator` 在能力表里是合法类型（hook 要认它），所以 isKnownType
  //   拦不住 —— **「是个合法类型」和「这个入口可以用这个类型」是两个问题。**
  if (type === 'orchestrator') {
    console.error('✗ --type orchestrator 不能用在 agent 上（那是编排者自己的类型）');
    console.error('  起编排者用: node bin/orch-start.js');
    process.exit(1);
  }

  // ── `--worktree` ────────────────────────────────────────────────────────
  //   cwd 不给时：`../EngLoop-worktrees/<name>`，不在就 `git worktree add -b wt/<name> <path> main`；
  //   在就**不动它**（不 reset —— 里面可能有没合的活），落后 main 打一行提示。
  //   合并走 `bin/wt-merge.js <name>`（以 verify-complete 的 pass 记录为闸，只给编排者用）。
  //   ⚠️ 新建出来的 worktree **不在信任列表里** ⇒ 下面的 trust 预检会拒（exit 5），并给出点 trust 的命令 ——
  //     linked worktree 的 trust 是跟着自己还是跟着主仓库，没有确认过，
  //     按「跟着自己」处理；**不由程序去改 ~/.claude.json 替人点**（trust 对话框是给人的闸）。
  const useWorktree = process.argv.includes('--worktree');
  if (useWorktree && arg('cwd')) {
    console.error('✗ --worktree 和 --cwd 只能给一个：--worktree 的目录是固定的 ../EngLoop-worktrees/<name>');
    process.exit(1);
  }
  let wtInfo = null;
  if (useWorktree) {
    if (!tmux.validName(name)) { console.error('✗ 名字含非法字符'); process.exit(1); }
    try {
      wtInfo = require('../lib/agent-worktree').ensureWorktree({ root: ROOT, name });
    } catch (e) {
      console.error(`✗ ${e.message}`);
      process.exit(7);
    }
    console.log(wtInfo.created
      ? `  ✓ 已建 worktree ${wtInfo.path}（分支 ${wtInfo.branch}）${wtInfo.note ? ` —— ${wtInfo.note}` : ''}`
      : `  · worktree ${wtInfo.path} 已存在（分支 ${wtInfo.branch}），不动它`);
    if (wtInfo.behind === null) console.warn('  ⚠️  算不出它落后 main 多少（git rev-list 失败）');
    else if (wtInfo.behind > 0) {
      console.warn(`  ⚠️  ${wtInfo.path} 落后 main ${wtInfo.behind} 个 commit —— 没有自动更新（里面可能有没合的活）。`);
      console.warn(`     要更新：在那棵树里 \`git merge main\`（agent 自己做，或编排者派活时说明）`);
    }
  }
  const cwd = path.resolve(wtInfo ? wtInfo.path : arg('cwd', path.join(ROOT, 'agents', name)));
  // 会话名一律走 roster.sessionFor —— **约定的唯一出处**。花名册自愈重建时
  // 要填出同一个名字，两处各写各的迟早分叉，而分叉不会让任何东西变红。
  const session = roster.sessionFor(name, type);

  if (!tmux.validName(session)) { console.error('✗ 名字含非法字符'); process.exit(1); }

  if (await tmux.exists(session)) {
    console.error(`✗ ${session} 已在运行`);
    process.exit(1);
  }

  // ★ 在 provision 和登记花名册**之前**：拒绝启动时不能留下一条在册、却永远不报到的记录。
  const bypass = process.argv.includes('--bypass-permissions');
  if (!bypass) {
    if (!isTrusted(cwd)) {
      console.error(`✗ ${cwd} 没有被 Claude Code 信任过 —— ${name} 拒绝启动。`);
      console.error('  不带 bypass 时会话会停在 trust 对话框上，永远不报到。');
      console.error(`  修法：cd ${JSON.stringify(cwd)} && claude   → 选「Yes, I trust this folder」→ 退出，再起一次。`);
      if (wtInfo) console.error('  （这是 --worktree 的目录：每棵新 worktree 要点一次，之后同名再起不用再点。）');
      console.error(`  或者明说回滚：加 --bypass-permissions`);
      process.exit(5);
    }
  }

  const p = provision(name, cwd, type);
  console.log(`  工作目录 ${cwd}`);
  // 逐个列出来。只说「已下发」的话，少下发了一个文件谁也看不出来 ——
  // 而少的那个可能正好是 .claude/settings.json（权限配置）。
  if (p.written.length) console.log(`  ✓ 已下发: ${p.written.join(', ')}`);
  if (p.kept.length) console.log(`  · 保留不覆盖: ${p.kept.join(', ')}`);
  // ★★ 「保留不覆盖」读起来是好消息（「我保护了你的文件」），而 CLAUDE.md 那一项
  //   实际说的是**这个 agent 拿不到模板里的身份注入** —— 它不知道自己是谁、
  //   循环怎么跑、outbox 怎么写，只能靠 kickstart 那一句话。
  //   一条如实报出、却长得像正常输出的信息，会一直没人看。
  //
  //   ⚠️ keepEdited 的行为是对的（`lib/provision.js`：
  //   agent 自己往 CLAUDE.md 里记的东西不能被下一次启动抹掉）。要管的是措辞。
  // ── `kept` 的含义 —— 这几个分支必须一起读 ──────────────────────────
  //
  //   只按长度判时，`kept:['CLAUDE.md']` = 「有个 >50 字符的文件挡着，模板没写进去」
  //           ⇒ 那**既可能是** agent 自己攒的笔记（好），**也可能是** git worktree
  //             带出来的编排者引导（灾难）—— 而这两者在这一行输出里长得一模一样。
  //
  //   所以 `lib/provision.js` 按白名单判：
  //     `kept`        = 那份文件**点名到了这个 agent** ⇒ **正常**，不该报警
  //     `overwritten` = 有内容、但**不点名** ⇒ 已被覆盖 ⇒ **必须说出来**
  //
  // ⚠️ 对 `kept` 报警的话，agent 每次正常重启都会打告警 ——
  //   而一个**每次都出现的告警**，等于没有告警。
  if (p.overwritten && p.overwritten.includes('CLAUDE.md')) {
    console.warn(`  ⚠️  ${cwd}/CLAUDE.md 原来有内容，但它没有点名 ${name} —— **已被模板覆盖**`);
    console.warn('     → 判据是「文件里有没有 `你是 **<name>**`」，不是长度（lib/provision.js claimsIdentity）');
    console.warn('     → 常见成因：cwd 是一棵 git worktree 的根，那里躺着仓库根的 CLAUDE.md');
  }

  // ── 人格文件拿不到 ⇒ **拒绝启动**，不是打两行日志继续跑 ──────────────
  //
  //   ★ 跟 worker 侧同一道门：`lib/worker-runner.js` 写着
  //       「`if (x) push` ⇒ 不传 = 静默失效；守在这里没用 ——
  //         **防线在 worker-pool：文件不在就不让 worker 起**」
  //     而 `lib/worker-pool.js` 的 `handle()` 里那道门的错误消息是
  //       「没有它，worker 会读**被审项目的 CLAUDE.md** 当成自己的身份。」
  //     agent 侧需要同样的门。
  //
  // ⚠️ **为什么用「非零退出 + stderr」而不是写 outbox**：
  //   这一刻 agent **还没注册**（`roster.register` 在下面几行），
  //   而 relay 只监听花名册里的名字（`bin/serve.js`，每 60s 重扫）
  //   ⇒ 此刻写 `temp/outbox/<name>/` 的文件**没有人会捡**。
  //   而 `lib/agent-ui-start.js` 在收 stderr，并且**只在非零退出时**
  //   把它放进 `launching.error` ⇒ 那个字段出现在 `/api/agents` 上，界面读得到。
  //   ⇒ 所以「有人会读的地方」在这条路径上是 **launching.error**，
  //     而通往它的唯一门票是**非零退出码**。零退出会让 stderr 被丢掉。
  const personaFile = path.join(cwd, 'CLAUDE.md');
  if (!fs.existsSync(personaFile)) {
    console.error(`✗ ${personaFile} 不在 —— ${name} 拒绝启动。`);
    console.error('  没有它，这个 agent 读到的最内层身份会是它 cwd 往上层叠到的那一份');
    console.error('  （在一棵 git worktree 的根上，那份写着「你是这个系统的编排者」）。');
    process.exit(2);
  }
  // ★ 第二道，跟第一道**不相交**：第一道问「文件在不在」，这道问「它说的是不是你」。
  //   而它调的是 provision 内部**同一个函数**（导出的 `claimsIdentity`），
  //   不是另写一个判据去猜那个格式 —— 复写一份逻辑去验它，验的是复写件。
  if (!claimsIdentity(fs.readFileSync(personaFile, 'utf8'), name)) {
    console.error(`✗ ${personaFile} 里没有「你是 **${name}**」—— ${name} 拒绝启动。`);
    console.error(`  provision 报的是 kept=${JSON.stringify(p.kept)} overwritten=${JSON.stringify(p.overwritten || [])}`);
    console.error('  这说明白名单判据和实际落盘不一致，属于 provision 那一侧的问题，不要绕过它。');
    process.exit(3);
  }

  // 先注册再启动 —— 否则 agent 报到时编排者回信会因为查不到花名册而误投
  const redis = q.createClient();
  // 不传 stream：register 的默认走 roster.inboxFor（唯一出处）。
  // 在这里再写一遍 `agent:${name}:in` 就是第二份实现 —— 下面用 rec.stream，
  // 拿到的是**实际写进花名册的那个值**，而不是假设它是什么。
  const rec = await roster.register(redis, name, {
    type, cwd, tmux_session: session,
  });
  await q.ensureGroup(redis, rec.stream, `agent:${name}`);
  await redis.quit();
  console.log(`  ✓ 已登记花名册（TTL ${roster.TTL_SEC}s，靠心跳续期）`);

  // 不变量：最小启动任务
  //
  // ── `--kick <text>` 覆盖 ─────────────────────────────────────────────
  //   **不传参时的默认值不能变**：
  //   一个为了做实验而加的参数，如果它改变了**不传参时**的行为，
  //   那它就不再是实验工具，而是一次行为变更。
  //
  //   为什么需要它：**没有它就起不了一个不进循环的探针。**
  //   默认这句的第二半是「然后运行 poller 等待指令」——
  //   而一个 cwd 在 worktree 根上的探针如果照做，它读到的最内层身份
  //   可能把它当成编排者 ⇒ 它会用编排者的 agent 类型跑 poller
  //   ⇒ **加入 `orch:in:*` 的消费者组，抢走投给编排者的消息**，
  //     而编排者会静默地聋一段（消息进了别人的 PEL，60 秒后才 autoclaim 回来）。
  //
  // ⚠️ 传进来的文本会进命令行 ⇒ 下面拼串时**必须** `JSON.stringify()`
  //   —— 跟默认那句走同一条路。
  // ── `countClaims !== 1` —— **不拒绝启动**，而是让读者去报 ──────────────
  //
  //   为什么**不**当门：
  //     `countClaims === 2` 最常见的成因是「有人在文件里**引用**了那个句式」——
  //     而那是一个**无害的写作行为**。
  //     ⇒ 用它拒绝启动 = 让一个无害行为**让一个常驻 agent 起不来**。
  //     ★ 一个检查该不该接进「拒绝启动」那道门，看它误报时的代价 ——
  //       worker 是一次性的（拒绝 = 重派一次）；**agent 是常驻的（拒绝 = 整个系统停摆）**。
  //
  //   为什么**也不**只当测试断言：
  //     `agents/<name>/CLAUDE.md` 是 **agent 自己随时往里写字**的地方 ——
  //     而 agent 不会跑全量。下一次全量可能是几天后。
  //
  //   ⇒ 折中：**照常启动 ＋ 把这件事追加进 kick**，让一个会说话的读者立刻报出去。
  //     （落点现成：这里本来就在给它写 kick。而 stderr 在退出码 0 时会被丢掉，
  //       所以 kick 是这条路径上唯一到得了「一个会读的人」的通道。）
  const claimCount = countClaims(fs.readFileSync(personaFile, 'utf8'), name);
  const claimWarn = claimCount === 1 ? '' : `\n\n🔴 **启动检查发现一件事，请你第一件事就把它写进 outbox 报给 ${ORCH}：**\n`
    + `你的身份文件 ${personaFile} 里，「你是 **${name}**」这个句式出现了 **${claimCount}** 次（应该是 1 次）。\n`
    + '这会让 lib/provision.js 的 claimsIdentity 判据失去分辨力 —— 它命中的可能是一处**引用**，\n'
    + '而不是真正那一行身份声明。⇒ 于是「你的身份声明被换掉了」这件事，判据再也看不见。';

  // ── `--resume`（opt-in，DUR1 S3）─────────────────────────────────────
  //   有记录的 session_id ⇒ `claude --resume <id>` 接回重启前的会话；权限 / 模型 / --append-system-prompt-file 一个不变。
  //   记录是 SessionStart hook 写的 `temp/journal/<name>.session`（为什么不从 jsonl 最后一行拿，见 lib/agent-settings.js）。
  //   接不回（没记录 / cwd 不同 / id 不像 UUID）⇒ **打警告、起全新会话** —— 不静默失败，也不拒绝启动：
  //   用户要的是「起一个 agent」，上下文接不回不该让它起不来。
  //   **默认不开**：开不开成默认，等人在真机上验收过再定（PR 描述里有人工步骤）。
  const wantResume = process.argv.includes('--resume');
  let resumeId = null;
  if (wantResume) {
    const plan = toolJournal.resumePlan({ ...toolJournal.readSession(name), cwd });
    if (plan.resume) {
      resumeId = plan.sessionId;
      console.log(`  ✓ --resume：接回会话 ${resumeId}（记录于 ${plan.record.at || '?'}，source=${plan.record.source || '?'}）`);
    }
    else console.warn(`  ⚠️  --resume 没接回：${plan.warn}`);
  }

  const kick = arg('kick', defaultKick(name, { resumed: !!resumeId }));

  let permFlags;
  if (bypass) {
    permFlags = '--dangerously-skip-permissions';
    console.warn('  ⚠️  --bypass-permissions：这个 agent 没有 sandbox、没有 deny，任何注入的指令都以完整权限执行');
  } else {
    const settingsFile = writeCrewSettings({ name, type, cwd });
    // `--setting-sources user`：cwd 的 .claude/settings.json 不加载 —— 它的 allow 会跨层合并进来
    // （模板里是不带路径的 Edit/Write）。理由见 lib/agent-settings.js 头注。参数本身在 lib/agent-launch.js。
    permFlags = launch.shellJoin(launch.permissionArgs({ kind: 'crew', settingsFile }));
    console.log(`  ✓ 权限: dontAsk + sandbox（${path.relative(ROOT, settingsFile)}）`);
  }
  // 模型从能力表取 —— 唯一出处是 lib/agent-capabilities.js 的 `model` 那一格。
  const modelFlags = launch.shellJoin(launch.modelArgs(type));
  await tmux.spawn(session, {
    cwd,
    // ── 把「人格从哪来」和「活在哪干」拆成两个变量 ──────────────────
    //
    //   跟 `lib/worker-pool.js` 的 `handle()` 一样：
    //     `cwd`                    活在哪干
    //     `appendSystemPromptFile` 人格从哪来
    //   ⇒ worktree 隔离要的就是把它们分开。
    //
    // ⚠️ `JSON.stringify` 不是风格 —— 这整条串会被 tmux 交给 shell 分词（`lib/tmux.js`
    //   把它作为**一个 command 字符串**传给 `new-session`）。
    //   一个带两个空格的路径，裸拼会被分成 6 个 argv，加引号是 4 个（正确）。
    // ── 模型 ─────────────────────────────────────────────────────────────
    //   不传 model 时 claude 会层叠到用户级 ~/.claude/settings.json 的 `"model"` 字段，
    //   那里可能是别的模型。所以显式传，值的出处是 lib/agent-capabilities.js。
    // ── 权限 ─────────────────────────────────────────────────────────────
    //   默认：`dontAsk` ＋ sandbox ＋ deny，不是 `--dangerously-skip-permissions`；
    //   配置由框架生成、放在 agent 写不到的地方（理由见 lib/agent-settings.js）。
    //   `--bypass-permissions` 是回滚开关 —— **必须明说**，而且会打一行警告。
    // ── `env -u …` 前缀 ──────────────────────────────────────────────────
    //   新会话继承的是 **tmux server** 的环境，而 `-e` 只能设不能删 ⇒ 在命令前面把
    //   Claude Code 的会话态变量剥掉（清单和理由在 lib/agent-launch.js 的 SESSION_ENV）。
    //   回滚开关也剥：那是权限的回滚，不是环境的。
    // 拼法在 claudeCommand()（抽出来是为了单测；resume 只多一个 `--resume <id>`）。
    command: claudeCommand({
      permFlags, modelFlags, prompt: kick + claimWarn,
      personaFile, resumeId,
    }),
    // hooks/check_security.js 靠这个变量知道对面是谁。**读不到就 fail-closed
    // 拒掉一切** —— 所以它必须在这里注入，而不是指望 agent 自己设
    // （agent 在 Bash 里 export 只影响那个 shell 子进程，hook 是 claude
    //   spawn 的、继承的是会话环境）。
    env: { ENGLOOP_AGENT_TYPE: type },
  });
  if (claimWarn) {
    console.warn(`  ⚠️  ${personaFile} 里「你是 **${name}**」出现了 ${claimCount} 次（应为 1）`);
    console.warn('     → 已把这件事追加进 kick，让它自己报给编排者（退出码 0 ⇒ 这两行 stderr 不会进 launching.error）');
  }
  console.log(`  ✓ 已起会话 ${session}`);

  const r = await tmux.waitFor(session, /shift\+tab|for shortcuts|esc to interrupt|❯/, 90000, 2000);
  // ★ `❯` 也是 trust 对话框的选择光标 ⇒ 单靠上面那条正则，停在对话框上也会报「就绪」。
  //   isTrusted 是推断出来的规则，所以这里再看一眼。
  //   **不杀会话**：人 attach 进去点一下「Yes」它就能接着跑；非零退出让 agent-ui-start 报出来。
  if (r.ok && TRUST_DIALOG.test(r.pane)) {
    console.error(`✗ ${session} 停在 workspace trust 对话框上 —— 它不会报到。`);
    console.error(`  修法：tmux attach -t ${session}，选「Yes, I trust this folder」。`);
    process.exit(6);
  }
  console.log(r.ok ? '  ✓ TUI 就绪' : `  ⚠ 未等到就绪（${r.reason}）`);
  console.log(`\n  看它干活: tmux attach -t ${session}`);
}

async function main() {
  if (process.argv.includes('--list')) {
    const redis = q.createClient();
    const all = await roster.list(redis);
    await redis.quit();
    if (all.length === 0) return console.log('花名册为空');
    console.log('花名册:');
    for (const r of all) {
      const alive = await tmux.exists(r.tmux_session);
      console.log(`  ${r.name.padEnd(10)} ${r.type.padEnd(6)} ttl=${String(r.ttl_s).padStart(3)}s  tmux=${alive ? '在' : '不在'}  ${r.cwd || '—（掉册后自愈重建的记录不带 cwd）'}`);
    }
    return;
  }

  const stopName = arg('stop');
  if (stopName) {
    // 默认优雅：让它把手上这条消息处理完、回复发出去、ack 掉再走。
    // --force 等于 kill -9 —— 保留，但必须是明说的选择。
    const force = process.argv.includes('--force');
    if (force) {
      const redis = q.createClient();
      await roster.unregister(redis, stopName);
      await redis.quit();
      // 同一个约定出处。这里没有 type（--stop 只给名字），传 undefined 即可 ——
      // sessionFor 只对 'orchestrator' 特判，其余一律 `agent_<name>`，
      // 而 --stop 本来就停不了编排者（那是 orch-start --stop 的事）。
      const stopSession = roster.sessionFor(stopName);
      const killed = await tmux.kill(stopSession);
      console.log(killed
        ? `✓ 已强杀 ${stopSession} 并摘牌（它手上未 ack 的消息 60 秒后由 autoclaim 重投）`
        : '会话本来就没跑（已摘牌）');
      return;
    }

    try {
      const r = await shutdown.stopViaBus(stopName, {
        reason: `agent-start.js --stop ${stopName}`,
        onLog: (m) => console.log(m),
      });
      console.log(`✓ ${stopName} 已优雅关停（${r.mode}）`);
    } catch (e) {
      // 不静默降级成强杀 —— 把选择权交回去。
      console.error(`✗ 优雅关停没走成：${e.message}`);
      if (e.code === 'BUS_UNREACHABLE') {
        console.error('  bus 没在跑，关停请求送不到。要么先起 bus（./bin/serve.sh），');
        console.error(`  要么明说强杀：node bin/agent-start.js --stop ${stopName} --force`);
      } else if (e.code === 'NOT_REGISTERED') {
        console.error(`  它不在花名册。会话可能还在，用 --force 收掉。`);
      } else if (e.code === 'NO_ADMIN_TOKEN' || e.code === 'BUS_UNAUTHENTICATED') {
        // 生命周期端点要 admin token。token 每次 bus 启动换新，
        // 401 多半是「跑着的 bus 不是写这个文件的那个」（旧代码 / 别处起的）。
        console.error('  关停端点要 bus 的 admin token（temp/bus-admin.token，bus 每次启动写一次）。');
        console.error('  确认跑着的 bus 是这份代码：node bin/bus-restart.js status');
      }
      process.exit(1);
    }
    return;
  }

  await start();
}

// ★ 只在被直接执行时跑。加这个守卫是为了让 provision() 能被测试 require ——
//   没有它的话，`require('bin/agent-start.js')` 会立刻读 argv、可能真的去起
//   tmux 会话。测试不该有那种副作用。
if (require.main === module) {
  main().catch((e) => { console.error('✗', e.message); process.exit(1); });
}

module.exports = { provision, listTemplateFiles, fillPlaceholders, claudeCommand, defaultKick };
