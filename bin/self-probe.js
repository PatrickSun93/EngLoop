'use strict';

/**
 * 自环探针 —— 验「消息进不进得来」，不是「进程活不活着」。
 *
 * ── 它要解决的东西 ──────────────────────────────────────────────
 *
 * poller 返回 `{"timeout":true}` 通常读成「没人说话」。但 relay 挂了、
 * consumer group 坏了、收件流被改名 —— **全都长成同一个 `{"timeout":true}`。**
 *
 * 「连续几轮 timeout → 查一次 bus」这种兜底有两个毛病：
 *   ① 重新触发判据如果是「上次查过之后又收到过消息」—— 而 bus 挂掉**不产生消息**
 *      ⇒ 条件永远不满足 ⇒ 规矩永久关闭，恰在它该工作的场景里
 *   ② `bus --status` 验的是**进程在 + HTTP 有响应**，而消息进得来还要过
 *      relay / 流名 / consumer group / ack 游标
 *
 * ⇒ 探针发给**自己**（`username: ME`，`ME = whoami()`，relay 投进 `agent:<ME>:in`）。
 *
 *   🔴 收件人不能写死成某个 agent：`bin/outbox-send.js` 的**发件人**是 `whoami()`，
 *     写死的话别的 agent 跑它，就是以自己的身份往别人的收件流投一条「请 ack 我」的假消息。
 *     两个方向都答错：
 *       · 收不到 ≠ 自己聋了      —— 那条链本来就不是自己的
 *       · 收到   ≠ 自己的链活着  —— 活着的是别人的
 *     而且它还**往别人那儿写东西**。
 *     工具不应默认以某个特定 agent 的身份行动。
 *   下一轮 poller 收得到 = 端到端那条真链是活的。收不到 = 自己聋了，
 *   **而且是自己发现的，不用等人来问。**
 *
 * ⚠️ 非破坏性：不用停任何东西，随时能跑。
 *
 * 用法:
 *   node bin/self-probe.js          ← 发一条探针（并落 pending）
 *   node bin/self-probe.js --status ← 只看 pending，不发
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// ── 🔴 「我是谁」问出来，不写死 —— 见下面 `load(ME)` 那一段 ──
const { whoami } = require('../lib/busy');
const ME = whoami();

const HERE = __dirname;

// ── ⚠️ 落盘路径可被环境变量覆盖 —— 用例绝不能写生产文件 ─────────────────
//
//   🔴 往生产 `probe-pending.json` 里塞一条假探针、测完没摘干净，后果不是「测试数据脏」，
//      是**一条永远不会销账的告警**：那个 id 永远不会有消息回来 ⇒ 每一轮都报「可能聋了」
//      ⇒ 而一个永不消失的假告警，会让人对**真**告警脱敏。
//      ★ 检测器最坏的坏法不是不报，是一直报。
//
//   ⇒ 用例一律走 **`ENGLOOP_PROBE_PENDING`** 指到临时文件，生产路径碰都不碰。
//   🔴 这个变量名不能跟 `lib/probe.js` 读的 `ENGLOOP_PROBE_STATE` 共用：那个名字在那边
//     表示「生产的、**按名字分的**状态文件」。同一个变量两个含义 ⇒ 设了它，
//     `statePath('dev')` 和 `statePath('senior')` 指向同一个文件，**名字被完全忽略**
//     ⇒ `reconcile()` 那段检查就不再跟生产路径走。
//     ⚠️ 不读旧名（没有兼容层），理由是判据：
//       「两个模块设同一个变量 ⇒ 拿到的路径必须不同」——
//       兼容层会让这条**恒假**，也就是把这个 bug 保留下来。
//       失效的方向是安全的：谁还设着旧名字，`PENDING` 走默认（生产 pending 文件）
//       ⇒ **那本来就是正确行为**。
// 🔴 这是**运行时数据**，不是代码。
//   放在 `HERE` 的话它会落进 `bin/`（git 跟踪的目录）⇒ 探针状态污染仓库。
//   ★ 分界：**代码进仓库，数据留在 temp/**（temp/ 是 gitignored 的）。
const PENDING = process.env.ENGLOOP_PROBE_PENDING
  || path.join(HERE, '..', 'temp', 'probe-pending.json');
const DRAFT = path.join(HERE, '..', 'temp', 'draft-probe-auto.json');   // 同上：数据留 temp/

// ★ 窗口用**绝对时间**，不用「轮数」——
//   轮数在 timeout 轮是 9.9 分钟，在忙轮可能是几秒，同一个「两轮」差两个数量级
//   —— **看起来像度量、其实没测量任何东西**。
const STALE_MS = 20 * 60 * 1000;

// ── 🔴 「自己停了」这种故障也要留下痕迹 ─────────────────────────────
//
//   **探针免疫的是「没人说话」，不免疫「自己停了」。**
//   探针是 agent 自己发的 —— 它要是卡在某个工具调用里没回到循环，探针根本不会发，
//   而 **「没发出去」和「发出去没回来」，事后看长得一模一样。**
//
//   🔴 只存「在途的探针」、销账即删的话 ⇒
//      从没发过 = pending 空 = **检测器完全静默** = 看起来跟一切正常一样。
//      **没有告警会被读成没有问题**，而真相是检测器压根没在工作。
//
//   ⇒ 所以落盘要记「**发出**」这个事实本身，不能只记「等待中的」。
// 超过这么久没发过探针 → 检测器实际上没在工作。
//
// ★★ **从 `lib/probe.js` 派生 + 余量，不自己再写一个 60 分钟。**
//   硬编码一个跟 poller 的 `RESEND_AFTER_MS` **恰好相等**的数，会在边界上抖：
//   poller 正好到点才补发，而这里在同一刻已经开始报警。
//   ⇒ 每小时闪一次假警，而**一个会规律性假警的告警，人很快就不看了**。
//
// ⚠️ 更要紧的是「自己再写一个数」这件事本身：两个数即使现在一样，
//   poller 那边改了之后这里不会有任何东西变红 —— 分叉的表现是
//   「告警时机不对」，没有报错。
const PROBE_LIB = (() => {
  try { return require(path.join(HERE, '..', 'lib', 'probe.js')); } catch { return null; }
})();
const SEND_DUE_MS = (PROBE_LIB ? PROBE_LIB.RESEND_AFTER_MS : 60 * 60 * 1000) + 10 * 60 * 1000;

const EMPTY = { pending: [], last_sent_ms: null, last_returned_ms: null };

function loadState() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch { return { ...EMPTY, missing: true }; }
  // 兼容旧格式（裸数组）—— 它没有 last_sent_ms，只能标成未知
  if (Array.isArray(raw)) return { pending: raw, last_sent_ms: null, last_returned_ms: null };
  return { pending: raw.pending || [], last_sent_ms: raw.last_sent_ms ?? null, last_returned_ms: raw.last_returned_ms ?? null };
}
function saveState(s) {
  fs.writeFileSync(PENDING, JSON.stringify({
    pending: s.pending, last_sent_ms: s.last_sent_ms, last_returned_ms: s.last_returned_ms,
  }, null, 2) + '\n');
}

// ── 对外：给 poll-parse.js 用 ───────────────────────────────────
//
// ⚠️⚠️ 调用它的地方**必须在 poll-parse 的 `if (!msgs.length) process.exit(0)` 之前**。
//
//   探针没回来的表现**就是**一直 timeout ⇒ msgs 为空 ⇒ 那行 exit 会先跑掉,
//   于是检查器**恰好在它唯一该报警的场景里不执行**。
//
//   ★ 检测器不能放在一个「**故障本身会阻止它运行**」的位置。
function reconcile(msgs) {
  const st = loadState();
  const lines = [];
  const now = Date.now();
  let changed = false;

  // ── ① 先查「探针本身还在不在发」——**这一段在 pending 为空时也必须跑** ────
  //
  //   ⛔ 早退（`if (!pending.length) return`）会把下面这个检查一起跳掉,
  //     而 pending 为空**正是**「agent 停了、从没发过」的样子。
  //   ★ 同一个陷阱在 poll-parse.js 那边是 `process.exit(0)`,在这里是 early return。
  //     形状一样:**故障把检测器一起带走了。**
  // ══════════════════════════════════════════════════════════════════
  // ★★★ 判据来源是**生产路径那份**（`lib/probe.js` 的 state），不是本文件自己那份。
  //
  // ── 探针有**两个**发送方，各写各的状态文件 ──────────────────────────
  //     temp/probe-pending.json    ← 本文件（手动跑 self-probe.js 时）
  //     temp/probe-state-<名字>.json ← `bin/next.js` 的 `probe.maybeSend`
  //                                   （poller **自动**补发，不依赖人记得）
  //
  //   只读前者的话，poller 刚自动发过、也收到了，这里却会报「距上次发探针很久…… 没人在测」。
  //   两个观测者各自都对，合起来是一句假话。
  //
  // ── 为什么按生产路径定，而不是取两者较新的 ──────────────────────
  //   两个方向的代价不对称，**修法只按坏的那一边定**：
  //     ① 按提示多发一条   → 虚报，白发一条，无害
  //     ② poller 的自动探针停了，而有人在手动发 → **这一段永远不报警**
  //        ⇒ 漏报，而且正好漏在「生产路径上的检测器坏了」这种情况
  //   取较新的那个会保留 ②。⇒ 判据必须跟着**生产路径**走。
  //
  // ⚠️ 它检测的是「**poller 还在跑，但自动探针没发出来**」——
  //   poller 整个停了的话根本不会有人看到这行输出（它就是 agent 的循环）。
  //   那种情况由花名册 TTL / watchdog 负责，不是这里。
  // ══════════════════════════════════════════════════════════════════
  const prodState = (() => {
    // ── 🔴 查的是**自己**的探针状态，不写死某个 agent ────────────────
    //
    //   三个 agent 都跑这个脚本。写死一个名字，其余的 agent 检查的就是**别人的**探针状态
    //   ⇒ 失效方向是**漏报**，而且正好漏在它唯一该说话的时候：
    //       自己的探针停了、而别人的还在发 ⇒ **这一段一声不吭**。
    //   各 agent 的 `last_sent_ms` 平时都在阈值内，读谁的结论都一样 ⇒ 这种分叉平时看不出来。
    //
    //   🔴 拿不到名字**不许默认成任何人** —— 走下面「查不了」那一支。
    //     「不知道该查谁的探针」和「探针没问题」是两件事。
    //
    //   ⚠️ 相关的两个坑：
    //   · 环境变量 `ENGLOOP_PROBE_PENDING` 必须跟 `lib/probe.js` 的 `ENGLOOP_PROBE_STATE`
    //     分开（见文件开头 `PENDING` 那一段）：共用一个名字时 `statePath(<任何名字>)`
    //     **指向同一个文件** ⇒ 下面这句 `load(ME)` 会去读 self-probe 自己的 pending 文件，
    //     这段检查静默地不再跟生产路径走。
    //   · `lib/probe.js` 的 `load()` 对「损坏的 JSON」和「文件不存在」**都返回 null**
    //     ⇒ 下面 `null` 那一支只能说「读不到」，不能说「从来没发过探针」。
    if (!ME) return undefined;
    try { return require(path.join(HERE, '..', 'lib', 'probe.js')).load(ME); }
    catch { return undefined; }        // 读不了 → 下面按「查不了」处理，不静默当成健康
  })();

  // 状态文件的**路径**（只为让人自己分辨上面那两种输入）。推不出来就不打，绝不猜。
  const prodStatePath = (() => {
    if (!ME) return null;
    try { return require(path.join(HERE, '..', 'lib', 'probe.js')).statePath(ME); }
    catch { return null; }
  })();

  if (prodState === undefined) {
    lines.push(ME
      ? '  ⚠️ **查不了**生产路径的探针状态（lib/probe.js 读失败）'
      : '  ⚠️ **推不出我是谁**（不在 agent 的 tmux 会话里）⇒ 这一轮没有给出任何探针结论');
    lines.push('     ⛔ 这不是「探针没在发」，是「我不知道它在不在发」—— 别据此下结论。');
  } else if (prodState === null) {
    // ── 🔴 说「读不到」，不说「从来没发过」 ────────────────────────────
    //
    //   `lib/probe.js` 的 `load()`：**读不到和读坏了都返回 null**，
    //   「都表示『检测器没在保护你』，**由调用方统一报告**，这里不区分」。
    //   它自己那个下游（`alertLine` 的 ②）说的是「状态文件读不到」—— **对两种输入都真**。
    //
    //   🔴 说「**从来没发过探针**」对「文件坏了」**是假的**，而且方向反了：
    //     文件坏了说明**这条链出问题了**，比「还没开始」严重。
    //     「没有记录说明那条路径没跑起来」同样不成立。
    //
    //   ⚠️ 下面那行路径**不只是给人看的**：它是「文件不存在 / 文件解不开」的分辨依据。
    lines.push('  ⚠️ **读不到**生产路径的落盘记录 —— 这个检测器现在没在保护我');
    lines.push('     ⇒ 两种输入都会走到这里（`lib/probe.js` 的 `load()` 对两者都返回 null）：');
    lines.push('       · **文件不存在** ⇒ poller 那条自动补发的路径没跑起来');
    lines.push('       · **文件在但解不开** ⇒ 落盘那一步坏了 —— 而那跟「没发过」不是一回事');
    lines.push(`     ⇒ 自己分辨：看 ${prodStatePath || '(路径也推不出来)'} 在不在、能不能 JSON.parse`);
  } else if (prodState.last_sent_ms == null) {
    lines.push('  ⚠️ 生产路径的落盘记录里没有「上次发出」时间 —— 下一轮自动补发即可自愈');
  } else {
    const since = now - prodState.last_sent_ms;
    if (since > SEND_DUE_MS) {
      lines.push(`  ⚠️ 距上次发探针 ${Math.round(since / 60000)} 分钟（阈值 ${Math.round(SEND_DUE_MS / 60000)} 分）`);
      lines.push('     ⇒ poller 本该自动补发却没有 —— 手动跑一次看它报什么：node bin/self-probe.js');
      lines.push('     ⛔ 在这之前,「没有告警」**不等于**链路健康 —— 只等于没人在测。');
    }
  }

  const pending = st.pending;
  if (!pending.length) return { lines, changed: false };

  const texts = (msgs || []).map((m) => String(m.text || ''));
  const stillOpen = [];

  for (const p of pending) {
    const hit = texts.findIndex((t) => t.includes(`[SELF-PROBE ${p.id}]`));
    if (hit >= 0) {
      const inStreamId = (msgs[hit] || {}).stream_id || '';
      // 入流真实时间 = stream_id 前面那串毫秒。**这是测量值，不是估算。**
      const inMs = Number(String(inStreamId).split(':').pop().split('-')[0]);
      const relayMs = Number.isFinite(inMs) && p.outbox_ms ? inMs - p.outbox_ms : null;
      lines.push(`  ✅ 探针 ${p.id} 回来了 —— 端到端链路活着`);
      if (relayMs !== null) {
        lines.push(`     relay 真实延迟 ${relayMs} ms（outbox 文件名 → 入流 id，两端都是测量值）`);
      }
      st.last_returned_ms = Number.isFinite(inMs) ? inMs : now;
      changed = true;
      continue;
    }
    const age = now - p.sent_ms;
    if (age > STALE_MS) {
      lines.push(`  🔴🔴 探针 ${p.id} 发出 ${Math.round(age / 60000)} 分钟没回来（阈值 ${STALE_MS / 60000} 分）`);
      lines.push(`       ⇒ **我可能聋了**：relay / 流名 / consumer group / ack 游标，查这一段。`);
      lines.push(`       ⛔ 别把这轮的 timeout 读成「没人说话」——那正是聋了的样子。`);
      stillOpen.push(p);
    } else {
      lines.push(`  ⏳ 探针 ${p.id} 在途 ${Math.round(age / 1000)}s（未到 ${STALE_MS / 60000} 分阈值，不判定）`);
      stillOpen.push(p);
    }
  }

  if (changed) saveState({ ...st, pending: stillOpen });
  return { lines, changed };
}

module.exports = { reconcile, STALE_MS, SEND_DUE_MS, PENDING };

// ── 直接运行 = 发一条探针 ───────────────────────────────────────
if (require.main === module) {
  const st = loadState();

  if (process.argv.includes('--status')) {
    // ── ★ 先说「**读的是哪个文件**」，再说读到了什么 ──────────────────
    //
    //   「pending 0 条」有**两种**成因：真的没有 / **读错了文件** ——
    //   不打出路径，人没有任何办法分辨。
    //
    //   ⇒ 它也是 `test/poll-parse.test.js`【2】**正向的那一半**：
    //     那条只断言「`bin/` 下**没有**这些数据文件」——
    //     而「数据没跟着搬」和「**根本没有那些数据**」是同一个绿。
    //   ★ 判据需要看见一个内部值时，先问「**人需不需要看见它**」——
    //     需要 ⇒ 打出来（谁都受益）· 不需要 ⇒ 才谈导出。
    console.log(`状态文件: ${PENDING}`);
    console.log(`草稿文件: ${DRAFT}`);
    console.log(`pending 探针 ${st.pending.length} 条:`);
    for (const p of st.pending) {
      console.log(`  ${p.id}  发出 ${Math.round((Date.now() - p.sent_ms) / 1000)}s 前`);
    }
    console.log(`上次发出: ${st.last_sent_ms ? new Date(st.last_sent_ms).toISOString() : '(无记录)'}`);
    console.log(`上次回来: ${st.last_returned_ms ? new Date(st.last_returned_ms).toISOString() : '(无记录)'}`);
    process.exit(0);
  }

  // ── 🔴 推不出我是谁 ⇒ **什么都不发**，而不是默认成某个人 ──────────────
  //
  //   跟上面 `load(ME)` 那一支同一条理由，只是方向反过来：
  //     `load` 那侧答的是「**检查谁的**」· 这侧答的是「**发给谁**」。
  //   ⇒ 这侧错了的代价更重：它会**往别人的收件流写一条要求他 ack 的假消息**。
  //   ⇒ 所以拿不到名字时不许挑一个人：退出码非 0，说出口，一条都不发。
  //
  //   ⚠️ 「什么都没做」和「坏了」在退出码上要分得开 —— 这里用 2，
  //     跟 `bin/heartbeat.js` 那支「不在 tmux 里就静静地什么都不做」**故意不同**：
  //     心跳没刷是无害的，而探针没发会让人以为「链路没问题」。
  if (!ME) {
    console.error('🔴 推不出我是谁（不在 agent 的 tmux 会话里）⇒ **一条探针都没发**。');
    console.error('   ⛔ 这不是「链路坏了」，是「我不知道该发给谁」—— 别据此下结论。');
    process.exit(2);
  }

  const id = Date.now();
  fs.writeFileSync(DRAFT, JSON.stringify({
    username: ME,
    text: `[SELF-PROBE ${id}] 自环探针（自动）。收到 = outbox → relay → agent:${ME}:in 这条真链活着。\n`
        + `⚠️ 不是真消息，不要按内容做任何事。ack 掉它就行 —— poll-parse 会自动认领并销账。`,
  }) + '\n');

  // 复用 outbox-send.js：**校验和发送是一步**，这里不另起一条投递路径。
  const out = execFileSync('node', [path.join(HERE, 'outbox-send.js'), DRAFT], { encoding: 'utf8' });
  process.stdout.write(out);

  // outbox 文件名那串毫秒是 outbox-send.js 用真实 Date.now() 生成的 ⇒ 可当测量值。
  const m = out.match(/已发送 → (\d{13})\.json/);
  const outboxMs = m ? Number(m[1]) : null;
  if (!outboxMs) {
    console.log('⚠️ 没能从发送输出里解析 outbox 文件名 —— 延迟这一项这轮测不了（探针本身仍有效）');
  }

  st.pending.push({ id, sent_ms: id, outbox_ms: outboxMs });
  // ★ `last_sent_ms` 记的是「**发出**」这个事实,销账不会清它 ——
  //   否则「agent 停了、根本没发」这种故障连痕迹都不留。
  st.last_sent_ms = id;
  saveState(st);
  console.log(`\n📌 已记 pending + last_sent（${PENDING}）—— 下一轮 poll-parse 会自动认领或告警`);
}
