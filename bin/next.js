#!/usr/bin/env node
'use strict';

/**
 * Bash-blocking 适配器 —— agent 大脑的收件接口。
 *
 * 手写的队列语义全交给 Redis Streams，这里只做适配。
 *
 * ── model-facing contract：不要改这个接口 ─────────────────────
 * agent loop 活在 protocol markdown 里，不在代码里。协议写的是
 * 「处理完每条消息后，前台重新拉起 poller」。所以这里必须：
 *   · 前台阻塞（不能后台化 —— 后台化会把结果送进模型可能永远不读的
 *     任务输出文件，且上下文压缩后模型分不清真消息和安全检查）
 *   · 结果走 stdout 的 JSON
 *   · 没消息时输出 {"timeout": true}，让协议驱动它再来一轮
 * ──────────────────────────────────────────────────────────────
 *
 * 用法:
 *   node bin/next.js --group orch --consumer orch-1
 *   node bin/next.js --group agent:dev --consumer dev-1 --streams agent:dev:in
 */

const path = require('node:path');
const fs = require('node:fs');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const probe = require('../lib/probe');
const waiting = require('../lib/waiting');
const threadAlert = require('../lib/thread-alert');
const reactions = require('../lib/reactions'); const threadCount = require('../lib/thread-count');
const shutdown = require('../lib/shutdown');
// 章 → sender_type / can_manage_workers / trust。读法只有 `readStamp()` 一份。
const stamp = require('../lib/stamp');
// 只为 `isDone`（「这条是不是任务完成报告」的判据，唯一出处）。
// UMD、零依赖，Node 引它成不了环 —— 同 lib/relay.js 引它的理由。
const threads = require('../web/threads.js');
// ★ 只为查「本会话实例的 created」，而且**只在本轮真有关停指令时才调**。
const tmux = require('../lib/tmux');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

// 默认组 = 编排者的组。**这不是可有可无的默认值**：编排者的启动指令
// （orch-start 的 KICKSTART）写的就是不带 --group 的 `node bin/next.js`，
// 所以这个默认值就是它每一轮真正用的组名 —— 走 roster.groupFor 的唯一出处。
const GROUP = arg('group', roster.groupFor('JARVIS', 'orchestrator'));
const CONSUMER = arg('consumer', `${GROUP}-1`);
// 数组顺序 = 优先级。人类流永远排前面，不靠进程内排序 ——
// 后者会被一阵 agent 刷屏打垮。
const STREAMS = arg('streams', 'orch:in:human,orch:in:agent').split(',');
const BLOCK_MS = Number(arg('block', q.DEFAULTS.blockMs));
// agent 自己的名字。默认从 group 推断：agent:dev → dev，orch → JARVIS
const NAME = arg('name', GROUP.startsWith('agent:') ? GROUP.slice('agent:'.length) : 'JARVIS');

// agent 类型。花名册重建时要用它填 tmux_session / 收件流，填错比不填更难查。
//
// 正路是启动时注入的 ENGLOOP_AGENT_TYPE（agent-start / orch-start 都注）。
// 读不到时**只对编排者兜底**：上面那行 NAME 已经把「group 不是 agent:*」
// 当成编排者了，这里沿用同一条约定，不是新猜的。
// agent 的类型（dev/eval/…）推不出来 —— 那就交回 roster 返回 need_info，
// **宁可不重建，也不要建一条 type 错的**：watchdog 会照 type 选消费者组
// （orchestrator 走 'orch'，其余走 'agent:<name>'），type 错则 idle 判定跟着错。
const AGENT_TYPE = process.env.ENGLOOP_AGENT_TYPE
  || (GROUP.startsWith('agent:') ? undefined : 'orchestrator');

/**
 * 不变量：每次**有消息的**轮询都重新注入指令（空轮不注入 —— 这是有意的，不是笔误）。
 * 大脑可能在上一条消息之后压缩过上下文 —— 这是让人格能无限期存活的机制。
 *
 *   · 只在有消息时注入的数字与理由，见本文件 `_orchestrator_instructions: loadInstructions()` 那一行上面的注释
 *   · 「大脑可能已压缩上下文」这一格是这样兜的：
 *     身份那一半靠 `CLAUDE.md`（进程启动时进系统提示，**压缩不动系统提示**）。
 *     🔴 **而操作规则那一半（`poll_rules.md` 13 KB）目前是敞着的**：
 *     一个压缩之后连续遇到空轮的 agent 拿不到它。待修：压缩后第一次 poll 带上它。
 */
// ── `_busy`：有人在跑长任务时，让**每一个** agent 在下一轮就看得见
//
//   `anyBusy()` 答得出「现在有没有人在跑全量」，但没人会在动手前主动去问 ——
//   而在别人跑全量的窗口里改文件，会让那一遍 `worktree_changed_during_run` 作废、重跑。
//   所以把它挂到每轮都会读的地方。
const busyState = require('../lib/busy');
const { staleAlert } = require('../lib/ack-alert');
// ── `recovery`：重投消息附上「上一次做到哪了」（DUR1 S2）
//
//   日志源是**本消费者自己**的 `temp/journal/<NAME>.jsonl`（`hooks/tool_journal.js` 写，`--name` 跟这里的 NAME
//   是同一个名字：agent 是 `agent:<name>` 推出来的那个，编排者是 JARVIS —— 跟 lib/agent-settings.js 生成配置时一致）。
//   算法、上限、固定说明都在 lib/tool-journal.js 的 buildRecovery()。
const toolJournal = require('../lib/tool-journal');

/**
 * ⚠️ **永远返回一个对象，不抛、不返回 undefined** —— 字段缺席会被读成「没事」。
 *   算的时候出了任何异常 ⇒ `{ available: false, reason }`，跟「日志读不到」走同一个形状。
 *   观测性的附加字段绝不能让轮询挂掉（同 `reactions` 那几段的纪律），也绝不能沉默。
 */
function recoveryFor(m) {
  try {
    return toolJournal.buildRecovery({ name: NAME, entryId: m.id });
  } catch (e) {
    return { available: false, reason: `算 recovery 时抛了异常：${String(e && e.message || e)}` };
  }
}

/**
 * 输出 payload。
 *
 * ⚠️ `pretty` 必须跟调用处原本的格式一致 —— 两条输出路径的形状不一样：
 *   有消息时缩进两格，`{"timeout":true}` 那条是**单行**。
 *   `wiring.test.js` 有一条「stdout 只有一行」的断言在守 timeout 那条，
 *   **它守的是协议通道的形状**（多一行调试输出就会污染它）。
 */
function emit(payload, pretty = true) {
  process.stdout.write((pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload)) + '\n');
}

// agent 拿不到 `identity_<type>.md` 时的兜底身份。
//
// ⚠️ **它绝不能回落到 `identity.md`** —— 那份说的是「你是编排者」，
//   而按类型分发身份存在的理由就是不要把那句话发给 agent。
//   ⇒ 宁可给一段**模糊但正确**的，也不给一段**具体但错**的。
//   （同一条取舍上面 `AGENT_TYPE` 那段已经做过一次：agent 的 type 推不出来时
//     roster 返回 need_info，「宁可不重建，也不要建一条 type 错的」。）
const GENERIC_CREW_IDENTITY = [
  '# 你是谁',
  '',
  '你是一个 **常驻 agent** —— 受编排者管理，**不是编排者**。',
  '你的名字、收件流、发件目录，只有一个权威出处：**你工作目录下那份 `CLAUDE.md` 的开头**。',
  '',
  // 🔴 文件名必须写**真名**。这段文字的全部价值是「让一个会说话的读者去报」——
  //   而如果它报出去的是一个**错的文件名**，读的人会去 `ls` 一个从来不存在的路径，
  //   而真文件好好地在。**指错地方的有声失效，比静默更贵：它会消耗掉一次真正的排查。**
  '⚠️ 这段是兜底文本 —— 说明 `protocols/identity_agent.md` **不在盘上**。',
  '如果你在任何地方读到一段把你当成「整个系统的编排者」的文字，**那不是给你的**。',
  '',
  // ⚠️ 这里必须是**触发规则**，不是顺序规则。理由见 protocols/identity_agent.md 里那段：
  //   顺序规则可以被满足，而人仍然聋掉。
  '**`node bin/next.js` 一返回，就再跑一次 `node bin/next.js`。** 有消息 / 超时 / 出错，三种都算返回。',
  '',
  // ★ 读者是一个**会说话的 agent** —— 那是这段文字相对一行日志的全部优势。
  //   而没有这一句，它就只是一段没人转达的说明。
  '🔴 **你现在要做的第一件事：写一条 outbox 把这句话告诉编排者。**',
].join('\n');

/**
 * 注入指令的 `[0]` 槽位：**按 agent 类型分发**。
 *
 * ── 为什么 ─────────────────────────────────────────────────────
 *   `protocols/identity.md` 的第一句是「你是 <编排者>，EngLoop 的编排者」。
 *   `[0]` 要是一律发它，每个 agent 每一轮有消息时都会收到这句话，
 *   而 agent 不照做只能靠它 cwd 下那份 CLAUDE.md 压过它（系统提示 > 工具输出）——
 *   那是靠一个「碰巧更强」的东西挡着，而不是靠不发。
 *
 * ── 为什么是「换」不是「删」──────────────────────────────────────
 *   `bin/next.js` 的 **stdout 格式在禁改清单上**。而：
 *     换：`[0]` 还是一份 markdown 字符串，**数组长度仍然是 2**
 *         ⇒ 字段名不变、位置不变、类型不变 ⇒ 「长度=2」的断言照样绿
 *     删：长度从 2 变成 1 ⇒ 那算不算「改 stdout 格式」需要人判断
 *   ⇒ 「换」这个做法**根本不碰那条边界**，所以它不需要那个判断。
 *
 * ── 编排者路径 ─────────────────────────────────────────────────
 *   `agentType === 'orchestrator'` 时读 identity.md + poll_rules.md，
 *   文件不存在时跳过。
 *
 * @param {string|undefined} agentType 默认取模块级的 `AGENT_TYPE`
 *   ⚠️ agent 读不到 `ENGLOOP_AGENT_TYPE` 时它是 `undefined` ——（身份文件不按 type 取，所以它只影响这个判断）
 *   而那**仍然走 agent 分支**（判据是「是不是编排者」，不是「type 是什么」）。
 *   这一点是有意的：type 未知不该让人掉回编排者身份。
 */
function loadInstructions(agentType = AGENT_TYPE) {
  const out = [];
  const dir = path.join(__dirname, '..', 'protocols');
  const isOrch = agentType === 'orchestrator';

  // ── [0] 身份：编排者读 identity.md；其余**一律不读它** ──
  if (isOrch) {
    const p = path.join(dir, 'identity.md');
    if (fs.existsSync(p)) out.push(fs.readFileSync(p, 'utf8').trim());
  } else {
    // ★ **一份**，不按 type 建。
    //   按 <type> 建的话会有六份（dev/eval/review/solve/test/write）**逐字相同**的正文
    //   —— 因为注入按 type 走、**点不了名** ⇒ 内容里不能有任何 type 特有的东西。
    //   ⇒ 六份相同的文件 = 六个会各自漂移的地方。
    //   ⇒ 将来真出现 type 特有的内容时再分叉 —— 那时才有分叉的理由。
    const p = path.join(dir, 'identity_agent.md');
    if (fs.existsSync(p)) out.push(fs.readFileSync(p, 'utf8').trim());
    // ⚠️ **else 分支不许省。** `if (exists) push` 的失效是**静默**的：
    //   文件拼错/没建 ⇒ 数组长度变 1 ⇒ 那个 agent **一个身份声明都收不到**
    //   ⇒ 而它 cwd 层叠的最内层，在一棵 worktree 里就是编排者那份
    //   ⇒ **它又会读到「你是编排者」。**
    else out.push(GENERIC_CREW_IDENTITY);
  }

  // ── [1] 规则：所有人同一份 ──
  const rules = path.join(dir, 'poll_rules.md');
  if (fs.existsSync(rules)) out.push(fs.readFileSync(rules, 'utf8').trim());

  if (out.length === 0) {
    out.push('You are an EngLoop agent. Protocol files not yet provisioned.');
  }
  return out;
}

async function main() {
  // 记下最后一次连接错误，用于给出可读的失败原因
  let lastErr = null;
  const redis = q.createClient(undefined, {
    onStatus: (kind, err) => { if (kind === 'error') lastErr = err; },
  });

  try {
    // ★ 轮询即心跳。
    //
    // 花名册用 TTL 表示存活，但「续期」必须真的有人调用 —— 只有
    // heartbeat() 函数而不接线的话，agent 注册 90 秒后就从花名册消失，
    // 编排者查不到它、消息也路由不过去，而 agent 进程明明活得好好的。
    //
    // 挂在这里最合适：agent 活着的**证据**就是它在轮询。
    // 它不轮询了就是失聪了，那时确实该从花名册掉出去。
    //
    // ★ 传 info = 给 roster **重建素材**，不是在这里实现自愈。
    //   自愈逻辑只有 lib/roster.js 一份（见那边的说明）—— 让每个调用方
    //   自己写「失败了就 register」就是第二份实现，分叉时不会有东西变红。
    //   这里只提供它拿不到的信息：名字、类型（cwd 不传，见下）。
    //   tmux_session / stream 由 roster 按约定补，别在这里推导。
    //
    // ⚠️ **别退回 `.catch(() => 'error')`**：那样连失败原因都丢了 ——
    //   「heartbeat 抛异常被吞掉」那条路径不留任何痕迹，掉册了也**无法确诊**。
    //   一个让自己无法被诊断的缺陷，比一个能被诊断的更该先修。
    let hb, hbErr = null;
    try {
      // 🔴 **不传 cwd**。理由是 poller **不知道** agent 的家在哪：
      //   `process.cwd()` 是「跑这条 poller 命令的 shell 在哪」，而各个 agent 的
      //   跑法各不相同（有的先 `cd` 到仓库根、有的用绝对路径）。
      //   ⚠️ 而它只在 **rebuild 那一支**才写进花名册（`lib/roster.js` 在册路径
      //     只更新 `last_heartbeat`，不 merge info）—— 所以传了的症状是
      //     **「掉过册被自愈救回来的 agent，cwd 变成救它那一刻的 shell 路径」**，
      //     而不是「每轮都被覆盖」，很容易被误诊成身份污染。
      //   ⇒ 宁可**没有这个字段**，也不要一个看起来合理的错值 ——
      //     真值在注册时由 `bin/agent-start.js` 写入，没人有权覆盖它。
      hb = await roster.heartbeat(redis, NAME, {
        type: AGENT_TYPE,
      });
    } catch (err) {
      hb = 'error';
      hbErr = err;
    }

    // ★ 返回值必须被看见。`.catch(()=>{})` 会把它整个丢掉 ——
    //   而 EXPIRE 一个不存在的 key 返回 0、**返回 0 不是异常**，
    //   catch 根本进不去，掉册就这么静默过去。
    //
    // 走 stderr 不走 stdout：stdout 是协议通道，形状是禁区（model-facing
    // contract，必须恰好一行 JSON）。stderr 一样会出现在 Bash 工具的输出里，
    // 大脑照样看得见。
    if (hb === 'rebuilt') {
      process.stderr.write(
        `⚠️ 花名册里刚才没有你（${NAME}），已自动重建。\n`
        + `   这说明你掉过册 —— 掉册期间别人发给你的消息被当成「发给人」`
        + `推去网页了，而且你写出去的 outbox 没人捡。\n`
        + `   请向上报告这次掉册，并检查这段时间有没有丢东西。\n`);
    } else if (hb === 'need_info' || hb === 'corrupt') {
      // 这两种是**没救回来**。不能沉默 —— 沉默等于回到掉册不可见的老状态。
      process.stderr.write(
        `⚠️ 花名册续期失败（${hb}）：${NAME} 不在册且无法重建。\n`
        + `   need_info = 这个进程没拿到 ENGLOOP_AGENT_TYPE（启动时没注入）。\n`
        + `   你现在是「活着但不在册」——收得到消息，发出去的没人捡。请报告。\n`);
    } else if (hb === 'error') {
      // ★ 第四种失败：heartbeat **抛异常**。它恰恰是最静默的一种：
      //   连返回值都没有，只有一个被吞掉的 Error。
      //
      //   后果跟没心跳一样：TTL 到期 → 掉册 → 收得到消息、发出去没人捡，
      //   而且 watchdog 会把「正在轮询但心跳丢了」误判成失聪。
      process.stderr.write(
        `⚠️ 花名册心跳抛异常（${NAME}）：${String(hbErr && hbErr.message || hbErr)}\n`
        + `   这一轮**没有续期**。TTL 走完你就会掉册，而轮询看起来一切正常。\n`
        + `   常见原因：redis 连接刚建立还没就绪（心跳是连上后的第一个操作）。\n`
        + `   请报告，并留意下一轮是否打出「已自动重建」。\n`);
    }

    // 先捞 PEL 里的孤儿：上一轮崩溃前领走但没 ack 的，必须优先重投。
    //
    // ⚠️ 已知恢复延迟：autoclaim 只捞 idle > 60s 的条目（防止抢走别人
    // 正在处理的活消息）。如果 agent 重启时孤儿还不够"旧"，这一轮捞不到，
    // 接着进入 594s 阻塞 —— 那条消息要等下一轮才回来，最坏延迟约 10 分钟。
    // 要缩短的话，得让 bus 侧独立扫 PEL 并主动重投，
    // 而不是依赖 agent 自己下一轮来捞（尚未做）。
    const orphans = [];
    for (const s of STREAMS) {
      const rescued = await q.autoclaim(redis, {
        stream: s, group: GROUP, consumer: CONSUMER, minIdleMs: 60000,
      });
      orphans.push(...rescued);
    }

    const fresh = orphans.length > 0
      ? []
      : await q.claimNext(redis, {
          streams: STREAMS, group: GROUP, consumer: CONSUMER, blockMs: BLOCK_MS,
        });

    const messages = [...orphans, ...fresh];

    // ★ 阻塞返回之后**再刷一次心跳**，然后才把消息交给大脑。
    //
    // ── 它治的是什么 ──────────────────────────────────────────────
    //   TTL 900s = 594s 阻塞 + 306s 余量。心跳要是**只在轮询开始时刷一次**，
    //   那 306 秒就是留给「处理」的全部预算 —— 而处理就是 agent 在干活。
    //   **干活越久越容易掉册，而干活久恰恰是正常工作的样子**
    //   （改几个文件 + 两次全量测试，一轮就能跑 20 分钟）。
    //
    //   这一刻刷是对的：**agent 刚从 XREADGROUP 回来，「它在轮询」这个信号
    //   是真的**，没有被稀释成别的意思（对比：用「写了 outbox」当存活证据，
    //   那会把「卡在长任务里还在发进度」也算成在轮询）。
    //
    // ── ⚠️ 它治不了什么（别把「掉册次数下降」读成「解决了」）─────────
    //   余量从 306 秒变成 900 秒，**但心跳仍然只覆盖轮询、不覆盖处理，
    //   而处理时间没有上限。900 不是安全线，是下一条会被跨过去的线** ——
    //   一轮 20 分钟就跨过去了。
    //
    // ⚠️ **这里必须传 info、必须读返回值。**
    //
    //   「本轮开头刚报过掉册，这里重复报是噪音」这个理由不成立：agent 会在**阻塞期间**
    //   被删出花名册（比如 watchdog 拿解析错的会话名判 stale → unregister）。
    //   那时轮次开头的心跳早就跑完了，**这一次才是唯一能发现它的时机**。
    //
    // ⚠️ 只 catch 异常不够 —— `need_info` / `corrupt` **不是异常**，它们是返回值。
    //   丢弃返回值的话，「阻塞期间被删」这件事在这里静默走过。
    let hb2, hb2Err = null;
    try {
      hb2 = await roster.heartbeat(redis, NAME, { type: AGENT_TYPE });   // 不传 cwd，见上面那段
    } catch (err) {
      hb2 = 'error';
      hb2Err = err;
    }
    if (hb2 === 'rebuilt') {
      process.stderr.write(
        `⚠️ 你在**这一轮阻塞期间**掉出了花名册（${NAME}），已重建。\n`
        + `   轮次开头还在册、阻塞完就没了 —— 那不是「处理太久」，`
        + `是有东西在主动删你（watchdog 的 stale 分支会 unregister）。\n`
        + `   掉册期间发给你的消息被当成「发给人」推去网页了。请报告。\n`);
    } else if (hb2 === 'need_info' || hb2 === 'corrupt') {
      process.stderr.write(
        `⚠️ 阻塞返回后的心跳没能续上（${hb2}）：${NAME} 不在册且无法重建。\n`
        + `   need_info = 这个进程没拿到 ENGLOOP_AGENT_TYPE。\n`);
    } else if (hb2 === 'error') {
      process.stderr.write(
        `⚠️ 阻塞返回后的心跳抛异常（${NAME}）：${String(hb2Err && hb2Err.message || hb2Err)}\n`
        + `   本轮处理期间不再有续期保护，处理超过 ${roster.TTL_SEC} 秒会掉册。\n`);
    }

    // ★★ 存活探针 + 待回复账本。**必须在下面那个 return 之前。**
    //
    // ── 这个位置就是它全部的意义所在 ────────────────────────────────
    //   探针没回来的表现 = 一直 timeout = `messages.length === 0`
    //   ⇒ 放在那个 return **之后**的话，检查器恰好在它唯一该报警的场景里
    //     不执行。**故障把检测器一起带走了。**
    //
    // ⚠️ 整段用 try 包住并降级成「没有告警」—— **poller 是所有 agent 的
    //   生命线，探针机制自己出错绝不能让轮询挂掉。**
    let probeAlert = null;
    let waitingAlert = null;
    let brainMessages = messages;
    try {
      const now = Date.now();
      const state = probe.load(NAME) || { last_sent_ms: null, last_returned_ms: null, pending: [] };
      const missing = probe.load(NAME) === null;

      // ① 先摘走本轮回来的探针：它们不进大脑（对大脑透明），但必须 ack。
      const { kept, ids, acks } = probe.harvest(messages, NAME);
      brainMessages = kept;
      if (acks.length) {
        probe.settle(state, ids, now);
        for (const m of acks) {
          try { await q.ack(redis, m.stream, GROUP, [m.id]); } catch { /* 见上：不能影响轮询 */ }
        }
      }

      // ② 该补发就补发。**发送也在 poller 里**，不依赖 agent 记得发 ——
      //   agent 在 timeout 轮的动作是协议写死的「立刻回到第 1 步」。
      const sent = probe.maybeSend(NAME, missing ? null : state, now);
      if (sent) {
        state.pending = [...(state.pending || []), { id: sent, sent_ms: now }];
        state.last_sent_ms = now;
      }

      if (acks.length || sent) probe.save(NAME, state);

      // ③ 算告警。missing 时传 null，让 alertLine 报「检测器没在保护你」——
      //   **除非这一轮刚补发成功**，那样它已经在保护了，报出来是假警。
      probeAlert = probe.alertLine(missing && !sent ? null : state, now);

      // ★★ 待回复账本：**先按 reply_to 自动销账，再算提醒。**
      //   顺序不能反 —— 反了的话，他刚回答完的那件事还会被提醒一次，
      //   而「已经答过了还在催」正是让人开始忽略提醒的那种噪音。
      const { remaining, settled } = waiting.autoSettle(
        waiting.load(NAME), brainMessages, now,
      );
      // ⚠️ 销掉的移进 settled 保留区，**不删** —— 自动销账会误销：
      //   `reply_to` 证明得了「他在回复这条消息」，证明不了「他回答了
      //   这条消息里的哪个问题」。留着，误销才谈得上恢复。
      if (settled.length) {
        waiting.save(NAME, remaining, [...settled, ...waiting.loadSettled(NAME)]);
      }
      waitingAlert = waiting.settledLine(settled)
        || waiting.alertLine(brainMessages, remaining, now);
    } catch { /* 降级成没有告警 —— 见上 */ }

    // ★★★ 没 ack 的消息 —— 「我听见了，但没应答」。
    //
    // ── 为什么由 poller 来报 ─────────────────────────────────────
    //   漏 ack 的典型形状：**那一轮的主要动作是干活，回消息只是收尾** ——
    //   注意力全在工作上，而 ack 是工作之外的一个动作。
    //   ⇒ **纪律对这个形状无效**，只能由机制来提醒。
    //
    //   不提醒的话，要等 60 秒后 `redelivered: true` 回来才知道 ——
    //   **而那时消息已经被重投了一遍**（副作用可能已经做了两次）。
    //
    // ★ 跟探针的分工：探针答「我还听得见吗」，这条答「我听见了但没应答吗」。
    //   两个都挂在 poller 上，因为那是 agent 唯一必然执行的动作。
    //
    // ⚠️ 查的是**本轮领走之前**就积压在 PEL 里的量 —— 本轮刚领的那些
    //   还没轮到大脑处理，算进去等于每轮都喊。
    // 🔴 但只能减 `fresh`，不能减 **messages.length**：
    //   这个理由对 `fresh` 成立，对 `orphans` **不成立**（它们上一轮就该被处理了）。
    //   ⇒ 判定见 `lib/ack-alert.js`。
    let ackAlert = null;
    try {
      let stale = 0;
      for (const s of STREAMS) {
        const p = await q.pending(redis, s, GROUP);
        stale += (p.count || 0);
      }
      // 🔴 别写成 `stale -= messages.length`：
      //   `messages = [...orphans, ...fresh]` —— **`orphans` 正是 autoclaim 从 PEL
      //   捞回来的，也就是「上一轮领了没 ack 的那些」**。把它们减掉 ⇒ `2 - 2 = 0`
      //   ⇒ **这条告警在它唯一有用的那一轮恰好静音。**
      //   判定放在 `lib/ack-alert.js`（纯函数，可测、可变异回放）——
      //   它**同时收两个数组、只减一个**，好让「只减 fresh」在签名上看得见。
      ackAlert = staleAlert({ pendingTotal: stale, orphans, fresh });
    } catch { /* 跟探针同一条：这个检查自己坏了不能拖垮轮询 */ }

    // ★★ 上一轮发出去的消息里，有没有没挂 thread 的。
    //
    // ★ 为什么这个检查只能在**事后**、而且只能在 poller 里 ──────────
    //   拦不住：一条没挂 thread 的消息是**完全合法**的消息，relay 没有任何
    //   理由拒收它（拒收才是真丢消息）。它照常投递、照常渲染，只是显示成
    //   顶层发言 —— 零报错。判据在 `web/threads.js` 里叫 `orphan`，
    //   而那条判据配的标记**画在网页上，发消息的 agent 永远不看网页**。
    //   ⇒ 唯一的出路是事后送到他必然会读的地方，也就是这里。
    //
    // ★ 跟 `_unacked` 是同一档欠账，所以紧挨着排：
    //   那条是「听见了没应答」，这条是「说了话但没说清接的是哪一句」。
    //
    // ⚠️ 整段 try 包住降级成「没有告警」—— 同探针那条：
    //   观测机制自己出错，绝不能让轮询挂掉。
    let orphanAlert = null;
    try {
      orphanAlert = threadAlert.alertLine(threadAlert.take(NAME));
    } catch { /* 见上 */ }

    // ★★★ 本轮收到的关停指令，是不是发给**本会话实例**的
    //
    // ── 它防的是什么 ──────────────────────────────────────────────
    //   消费者组的 `last-delivered-id` 跨会话持久，而会话是短暂的 —— 一条在当时完全
    //   正确的指令，会跨过会话边界投进一个语境完全不同的新会话：
    //   一条几天前的 SHUTDOWN_REQUEST 能把刚启动的会话关掉，**零报错**。
    //   判定和四档处置在 `lib/shutdown.js` 的 `classifyTarget`（纯函数，有测试）。
    //
    // ★ **只在本轮真有关停指令时才查 tmux。** 绝大多数轮次一条都没有 ⇒
    //   零开销。把 tmux 查询放在轮询主路径上，等于给每一轮都加一次 exec，
    //   而它只在极少数轮次里有用。
    //
    // ⚠️ 查不到自己的会话标识时传 `null` → `classifyTarget` 判 `unverifiable`
    //   → **放行 + 大声报警**。理由：那是「查不了」不是
    //   「不匹配」；fail-closed 会让 tmux 一故障就关不掉任何 agent ——
    //   **引入一个没有这项检查时都不存在的新故障**，而 fail-open 只是退回不检查的状态。
    //
    // ⚠️⚠️ 整段 try 包住 —— 同上：观测机制自己坏了不能拖垮轮询。
    let staleCommandAlert = null;
    try {
      const cmds = brainMessages.filter(
        (m) => String(m.text ?? '').trimStart().startsWith('SHUTDOWN_REQUEST'));
      if (cmds.length) {
        let mine = null;
        try {
          // 会话名从花名册来，不硬编码 `agent_<name>` —— 那个拼法是
          // `agent-start.js` 的实现细节，硬编码在这里会在它改名时
          // 静默变成「查不到」⇒ 每条关停指令都变 unverifiable。
          const rec = await roster.lookup(redis, NAME);
          const s = rec && rec.tmux_session
            ? (await tmux.list()).find((x) => x.name === rec.tmux_session)
            : null;
          if (s && Number.isFinite(s.created)) mine = s.created;
        } catch { /* 留 null → unverifiable，见上 */ }

        const lines = [];
        for (const m of cmds) {
          const verdict = shutdown.classifyTarget(m, mine);
          if (verdict === 'match') continue;   // 正常指令，不打扰
          lines.push(shutdown.targetAlertText(verdict, {
            name: NAME, mine, theirs: m[shutdown.SESSION_FIELD] ?? null,
          }));
        }
        if (lines.length) staleCommandAlert = lines.join('\n\n');
      }
    } catch { /* 见上 */ }

    // ── `_busy`：有没有人正在跑长任务（`temp/busy/*.json` 里 declare 过的）
    //
    //   ⚠️ **只在有人在跑时才构造** —— 见下面 alerts 里那段，那不是省字节。
    //   ⚠️ 而它**不阻断**任何事：它只是让「有人在跑」这件事出现在每个人的下一轮里。
    let busyAlert = null;
    try {
      const st = busyState.anyBusy();
      if (st.busy) {
        busyAlert = {
          who: st.who,
          what: (st.records || []).map((r) => r && r.what).filter(Boolean).join(' · ') || undefined,
          since: (st.records || [])[0] && (st.records || [])[0].started_at,
          // ★ 给**时刻**，不给「多久以前」。
          //   age 在这里恒等于 0 —— 这个字段是在 poller **返回的那一刻**生成的，
          //   而真正要紧的那段（「读到它」到「动手」）在读者那一侧，poller 量不到。
          //   ⇒ 快照能带上「它什么时候拍的」，带不上「你什么时候用它」。
          polled_at: new Date().toISOString(),
          note: '这是 poll 那一刻的快照 —— 要动仓库文件就现在单独跑一次 busy.anyBusy()',
        };
      }
    } catch { /* 读不到 temp/busy/ ⇒ 没有这个字段，不影响轮询（跟上面几条一致） */ }
    // ── 告警排在 messages 之前
    //
    //   不是排版洁癖：工具 preview 只截前 2048 **字节**，排在 messages
    //   之后就会被挤出去。决定可见率的是字节数、不是条数
    //   （一条长消息就能有 3000 多字节）。
    //   ⇒ 「消息少时排后面也行」这个例外档不存在。
    //
    // ★ 而这里有个巧合值得留着：**告警该出现的轮次，恰好是 messages 为空
    //   的轮次** —— 那一轮没有任何东西跟它抢 preview。
    //   告警最需要被看见的时刻，正好是它最容易被看见的时刻。
    const alerts = {
      // ★★★ `_stale_command` 排在**所有**告警之前，包括 `_unacked`。
      //
      //   别的告警说的都是「你欠了什么」「你漏了什么」—— 读晚一点只是晚一点。
      //   这一条说的是「**下面那条消息不要执行**」，而它要拦的那个动作
      //   （关掉一个正在干活的会话）**不可恢复**。
      //
      //   ⇒ 排序判据不是「哪条更重要」，是**「读晚了的代价能不能挽回」**。
      ...(staleCommandAlert ? { _stale_command: staleCommandAlert } : {}),
      // ★ `_busy` 排在 `_stale_command` 之后、`_unacked` 之前 ——
      //   照的是这一段自己的排序判据：**「读晚了的代价能不能挽回」**。
      //     · `_stale_command` 拦的动作**不可恢复** ⇒ 它必须第一
      //     · `_busy` 读晚了 ⇒ 已经动了仓库文件 ⇒ **别人那一遍全量作废**（可挽回，但要五分钟）
      //     · `_unacked` 读晚了 ⇒ 消息重投 ⇒ 便宜
      //
      //   ★ 而它跟这里其余几条**性质不同**：
      //     那几条说的是「**你欠了什么**」（上一轮没做完）；
      //     这一条说的是「**你现在别动手**」—— 它管的是读者接下来要做的事。
      //
      //   🔴 而它**只在有人在跑时出现**，绝不打印 `busy:false`：
      //     一个 `busy:false` 是一盏**可能已经陈旧的绿灯**，而拿着它的人
      //     **更不会**去查。
      //     ⇒ **不出现 = 没有灯，而不是「查过了，没人在跑」。**
      //     而这句话不能写在这个字段里 —— 它唯一需要被读到的时刻，正是它不在的时刻
      //     ⇒ 它写在 CLAUDE.md 里。
      ...(busyAlert ? { _busy: busyAlert } : {}),
      // ★ `_unacked` 排在欠账类告警的最前：它讲的是**上一轮没做完的事**，
      //   而人（和模型）读消息时的注意力是往下走的 —— 欠账要在新活之前。
      ...(ackAlert ? { _unacked: ackAlert } : {}),
      // ★ 紧跟 `_unacked`：两条都是「上一轮没做完的事」，欠账排在新活之前。
      ...(orphanAlert ? { _thread_alert: orphanAlert } : {}),
      ...(probeAlert ? { _probe_alert: probeAlert } : {}),
      ...(waitingAlert ? { _waiting_on: waitingAlert } : {}),
    };

    if (brainMessages.length === 0) {
      emit({ ...alerts, timeout: true }, false);   // 单行 —— 见 emit 头上那段
      return;
    }

    // ★★ 每条消息上已有的 emoji 反应。**批量查，一轮一次往返。**
    //
    // ── 锚点怎么取：跟下面 `room_msg_id` / `dm_msg_id` 那两段是同一条规则 ──
    //   房间取 `room_msg_id`（房间流 stream id），私聊取 `job_id`。
    //   这两个字段**互斥出现**（见下面 `dm_msg_id` 那段），所以这里的 if/else
    //   不是猜测，是照着那条互斥关系写的。
    //
    // ⚠️ **scope 必须跟着锚点一起给** —— 两个 id 空间各自独立，
    //   查错了 scope 会读到另一条消息的反应，而那**不会报错**，
    //   只会让一条消息上凭空冒出别人点的东西。
    //
    // ⚠️⚠️ 整段 try 包住、失败降级成「没有 reactions 字段」——
    //   跟探针和 `_unacked` 同一条纪律：**一个观测性的附加字段
    //   绝不能让轮询本身挂掉**。反应读不到只是少一块信息，
    //   轮询挂掉是 agent 直接失聪。
    let reactionsFor = () => undefined;
    try {
      const roomAnchors = [], dmAnchors = [];
      for (const m of brainMessages) {
        if (m.room_hash) { if (m.room_msg_id) roomAnchors.push(m.room_msg_id); }
        else if (m.job_id) dmAnchors.push(m.job_id);
      }
      const inRoom = roomAnchors.length
        ? await reactions.listMany(redis, 'room', roomAnchors) : {};
      const inDm = dmAnchors.length
        ? await reactions.listMany(redis, 'dm', dmAnchors) : {};
      reactionsFor = (m) => (m.room_hash
        ? inRoom[m.room_msg_id]
        : inDm[m.job_id]) || undefined;
    } catch { /* 见上：降级成没有这个字段，不影响轮询 */ }

    // ★★ 这条消息所在的 thread 是不是已经「来回超过上限、人已经被通知了」。
    //   锚点规则同上面 reactions 那段（`threadCount.anchorOfPolled`）；**一轮一次往返**（一个 Lua 脚本）。
    //   ⚠️ 失败降级成「没有这个字段」—— 同上面那段纪律：观测性的附加字段绝不能让轮询挂掉。
    let overLimitFor = () => undefined;
    try {
      const anchors = brainMessages.map((m) => threadCount.anchorOfPolled(m));
      const states = await threadCount.stateOfMany(redis, anchors.filter(Boolean));
      const byMsg = new Map();
      let k = 0;
      anchors.forEach((a, i) => { if (a) byMsg.set(brainMessages[i], states[k++]); });
      overLimitFor = (m) => threadCount.overLimitField(byMsg.get(m));
    } catch { /* 见上 */ }

    // ★ 这条私聊的 `reply_to` 是不是一条超限告警（Patrick 回告警 = 那个 thread 已清零）。
    //   编排者没见过那条告警（它从 orch:out 直接推给人），光看「继续吧」不知道指哪件事 ⇒ 把告警记着的 thread 带上。
    //   一次往返；**单独一个 try**：它坏了不连带 `thread_over_limit`，反之亦然。失败 ⇒ 没有这个字段。
    let alertRefFor = () => undefined;
    try {
      const asks = brainMessages.filter((m) => !m.room_hash && m.reply_to);
      const refs = await threadCount.alertRefsMany(redis, asks.map((m) => m.reply_to));
      const byMsg = new Map(asks.map((m, i) => [m, refs[i] || undefined]));
      alertRefFor = (m) => byMsg.get(m);
    } catch { /* 见上 */ }

    emit({
      ...alerts,
      messages: brainMessages.map((m) => ({
        // ★ 复合 ID：流名 + 条目 ID。
        // 不能只给裸 ID —— ack 时必须知道是哪个流，而大脑没有义务
        // 去推断这件事。让它原样回填即可，从接口上消除猜错的可能。
        stream_id: `${m.stream}:::${m.id}`,
        stream: m.stream,
        job_id: m.job_id,
        from: m.from,
        // ★★★ 谁写的、能不能要求你动 worker、信它到什么程度。
        //
        //   **只从流条目上的章里取，不推断、不默认**（`lib/stamp.js` 的 `readStamp()`）：
        //     sender_type         human / agent / system；没有章 ⇒ "unknown"
        //     can_manage_workers  只有 human 的章能带；没有 ⇒ false
        //     trust               human ⇒ "principal" · agent ⇒ "agent" · system ⇒ "system" · 其余 ⇒ "data"
        //
        //   ⚠️ 三个字段**总是出现**（不是 `|| undefined`）：「没有章」本身就是要告诉 agent 的事实
        //     ——缺席会被读成「这版 poller 还没有这个概念」，而那正是 `expects_reply` 那段说过的
        //     「默认必须是一个说出口的值，不是一个沉默的缺席」。
        //   ⚠️ 不按 `from` 判：`from` 是展示名，任何直接 XADD 的人都能写 `from: Patrick`。
        //   ⚠️ 不按通道判：房间里 Patrick 的话照样是 principal（信任按作者定）。
        //   ⚠️ 这是「手工白名单」里的字段 —— 生产侧（serve / relay / 扇出）三处都要盖，
        //     少盖一处的表现是那条路径上的消息全成了 data，零报错。
        ...stamp.readStamp(m),
        text: m.text,
        timestamp: m.timestamp,
        redelivered: m.redelivered === true || undefined,
        // ★ `recovery`：**只给重投的消息**（新消息没有「上一次」）。重投时**一定出现** ——
        //   日志读不到也给 `{available:false, reason}`，不省略（见 recoveryFor 头注）。
        //   时间窗起点是这条流条目 id 的毫秒时间戳（≤ 首次投递时刻 ⇒ 只会多算、不会漏）。
        //   字节有上限（lib/tool-journal.js 的 RECOVERY_MAX_BYTES）：这份 JSON 的前 2048 字节是 agent 唯一保证看得见的部分。
        recovery: m.redelivered === true ? recoveryFor(m) : undefined,
        // 房间消息必须带上 room_hash —— 否则大脑不知道往哪回。
        // 回房间要写 {"room_hash":...}；写 {"username":...} 只会私聊，
        // 房间里其他人永远看不到，而且没有任何报错。
        room_hash: m.room_hash || undefined,
        // ★★ `room_msg_id`：这条发言在**房间流**里的 id —— 回它的 thread 时
        //   `reply_to` 要填的就是它。
        //
        //   ⚠️ 不能用上面那个 `stream_id` 顶替：那是**自己收件流**的 id
        //   （扇出时 q.send 新生成的），跟房间流不是同一个 id 空间。
        //   填错不报错 —— 只会挂在一条不存在的父消息上，于是显示成顶层发言，
        //   **和漏填的表现一模一样**。
        //
        //   ⚠️⚠️ 这一行不能省：`bin/serve.js` 扇出时**已经把这个字段送进流里了**，
        //   这里不往外传的话，thread 在网页那一侧验收全绿，
        //   **对所有 agent 却是空功能**（它们连填错的机会都没有）。
        //
        //   > **「功能可用」和「使用者能用」是两件事。**
        //   `bin/next.js` 是所有 agent 的唯一入口 —— 漏在这里就是
        //   **结构上没有任何 agent 能有**。
        room_msg_id: m.room_msg_id || undefined,
        // ★★ `dm_msg_id`：**私聊**这条的可回复锚点 —— 回它的 thread 时
        //   `reply_to` 填的就是它。跟 `room_msg_id` 是对称的两个字段。
        //
        // ── 它的值就是上面那个 `job_id`，为什么还要单列一个名字 ──────────
        //   `job_id` 这个名字说的是「哪个任务」，不是「可以拿它当父」。
        //   **一个能用但没有名字的能力，等于没有这个能力**（同上面 `room_msg_id` 那段：
        //   字段明明在流里，只是没往外传，agent 就结构上用不了 thread）。
        //
        //   ⚠️ 这是「同一事实不要两处表述」的一个**有意例外**：两处永远由
        //   同一行派生，不可能分叉。而不给名字的代价是使用者根本不知道它存在。
        //
        // ⚠️⚠️ **有 `room_hash` 时故意不给** —— 房间消息的 `job_id` 是扇出时
        //   **所有收件人共享的同一个值**（serve.js 扇出时 `job_id: m.job_id`），
        //   拿它当锚点会让一条房间发言的 N 份投递互相指认成同一条。
        //   房间那边必须用 `room_msg_id`（房间流的 stream id），已经在上面。
        //   ⇒ 两个字段**互斥出现**，agent 手上有哪个就用哪个，不用判断。
        dm_msg_id: m.room_hash ? undefined : (m.job_id || undefined),
        // ★ `reply_to`：**这条消息本身是不是某条发言的回复**。
        //
        //   缺了它的失效方式跟上面那条对称，而且更隐蔽：agent 拿得到
        //   `room_msg_id`（能发 thread），却看不到自己收到的这条挂在哪 ——
        //   于是它想「接着这个 thread 继续说」时，只能拿手上这条的
        //   `room_msg_id` 当父，**每一层都新开一支**。
        //
        //   ⚠️ 而它发出去的回复是合法的、也确实进了某个 thread，
        //   **只是不是它以为的那个** —— 又一次「动作静默地做错」。
        //
        //   （要不要往外传，判据不是「字段少了几个」，是**缺了它会不会让一个
        //   动作静默地做错** —— `to` / `agent_type` 缺了不会，这个会。）
        reply_to: m.reply_to || undefined,
        // ★ `{ limit, counts }` —— 这个 thread 里 agent 来回已经超过上限，**人已经被通知了**。
        //   看到它：别在这个 thread 里接着回，等人说话（poll_rules §7.4）。没超过 ⇒ 字段不出现。
        //   手工白名单的又一个字段：计数存在独立的 redis key 里，不在这里列出来 agent 就结构上看不到它。
        thread_over_limit: overLimitFor(m),
        // ★ `{ scope, root, counts, preview }` —— Patrick 这条是在回某个 thread 的超限告警，那个 thread 已经清零。
        thread_alert_ref: alertRefFor(m),
        // ★★★ `reactions`：这条消息上有哪些 emoji 反应。
        //
        //   ── 为什么这一行本身就是这个功能的成败 ────────────────────────
        //   这份白名单是**手工列的**。反应存在独立的 redis key 里，
        //   跟消息流没有任何关系 —— **不在这里列出来，agent 就结构上
        //   拿不到它**，而网页那侧照样点得动、照样显示，验收全绿。
        //
        //   跟上面 `room_msg_id` 那段是同一个坑：数据明明在，
        //   这里没往外传，就是网页侧全绿、**对所有 agent 是空功能**。
        //   这个功能的整个价值就是「agent 读到 emoji
        //   后执行对应动作」—— 漏掉这一行，剩下四段做得再对也等于零。
        //
        // ★ 每一项都自带完整语义（`label` / `action` / `effect` / `costs_quota`），
        //   由 `lib/reactions.js` 的语义表派生。**agent 不需要、也不许
        //   自己再存一份 emoji→动作的对照表** —— 两份表会各自漂移，
        //   而漂移的表现是「界面上写着 ✅ 是验收，agent 却当成别的」，零报错。
        //
        // ⚠️ 没有反应时是 `undefined`（整个字段不出现），不是 `[]`：
        //   绝大多数消息没有反应，塞一个空数组进去等于给每条消息加一行噪音，
        //   而这份 JSON 的前 2048 字节是 agent 唯一保证看得见的部分。
        reactions: reactionsFor(m),
        // ★★★ `done`：发这条的 agent 自己声明「这是任务完成报告」。
        //
        //   ── 这里是**消费侧**的白名单 ────────────────────────────────
        //   `lib/relay.js` 那段「手工白名单会漏字段」记的是**生产侧**（room_hash →
        //   reply_to → kind → expects_reply → done）—— **而这里是另一份白名单，那段注释里没有它。**
        //   两份各自维护的白名单，修一侧不会自动修另一侧，而且不报错。
        //
        // ⚠️ 漏掉它的后果**比少一个字段严重**，是**判据失效**：
        //   编排者从此**分不清「它没标 done」和「它标了但看不到」** ——
        //   两种情况在他眼前是同一个输出：安静。
        //   于是他的纠正会朝一个方向系统性偏：**只会误报「你漏标了」，
        //   永远不会误报「你多标了」**，冤枉按判据做对了的 agent。
        //   （同 `poll_rules` 那条「别让『通过』和『没查』共用沉默」。）
        //
        // ★ 走 `threads.isDone()` 而不是 `m.done`：流里读出来是字符串 `'true'`
        //   （`lib/queue.js` 读流时全过 `String()`），原样透传的话下游只要有一个
        //   人写 `=== true` 就静默失效。判成布尔再给出去。
        done: threads.isDone(m) || undefined,
        // ★ `needs_decision`：JARVIS 转述 agent 的报告时要保留这个标记（转述是新消息，字段不继承）。
        needs_decision: threads.needsDecision(m) || undefined,
        // ★ `verify`：这份完成报告**核没核过** —— 又一个手工白名单字段。
        //   漏掉它的话，编排者分不清「核验在跑（pending）」和「核过了（pass）」和「没带 evidence（missing）」，
        //   而 poll_rules §7.3 要它转达之前先看这个字段。值域见 `lib/done-verify.js` 的 `VERIFY`。
        verify: m.verify || undefined,
      })),
      // ★★ **只在这个出口注入，timeout 那个出口没有** —— 而这是**决定**，不是漏。
      //
      //   ── 量级 ────────────────────────────────────────────────
      //     [0] agent 身份约 **3 KB** ＋ [1] poll_rules 约 **13 KB** ≈ **16 KB**
      //     ⇒ 约占一轮有消息的 poll 输出的 **65%**
      //     ⇒ 而空轮只有几百字节 ⇒ 补进去 = 每个空轮 +16 KB
      //       （三个 agent × 空闲时约 6 轮/小时 ≈ **每小时 ~290 KB 灌进上下文**）
      //
      //   ── 为什么空轮不需要它 ──────────────────────────────────
      //     这个字段的用途是「**处理消息时**照着这些规则做」。
      //     空轮里没有消息要处理 ⇒ 没有它要约束的动作。
      //     🔴 **而身份的常驻载体是 CLAUDE.md（进程启动时进系统提示），不是这个字段** ——
      //       一个刚被压缩、又连续几轮没消息的 agent，靠的是那一份，不是这一行。
      //
      //   ⚠️ 没有这段注释，这个不对称读起来像「每轮都注入」。
      //     **规格和实现不一致时，「改哪个」这个决定必须被看见** ——
      //     这段注释就是那个决定被看见的地方（`test/protocol-layering.test.js` 有对应的判据）。
      _orchestrator_instructions: loadInstructions(),
    });
  } finally {
    await redis.quit();
  }
}

main().catch((err) => {
  // Redis 不可用时必须**大声失败**，不能静默丢消息 ——
  // Redis 是整条队列的单点。
  process.stdout.write(JSON.stringify({
    error: 'QUEUE_UNAVAILABLE',
    message: String(err.message || err),
    detail: 'Redis 不可达。这是队列层故障，不是你的操作有问题。',
    hint: 'redis 可能没跑：brew services start redis',
  }) + '\n');
  process.exit(1);
});
