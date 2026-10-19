'use strict';

/**
 * 校验一个草稿，通过了才放进 outbox。**校验和发送是一步，不是两步。**
 *
 * ── 为什么要合成一步 ────────────────────────────────────────────
 * > **写文件成功 ≠ 内容能被解析。**
 * 一条 JSON 坏掉的长回复会被 relay 判成 PARSE_ERROR，收件人只收到前 200 字符，
 * 而发件人这边没有任何异常（写文件成功了）。
 *
 * 校验不能放在「写进 outbox 之后」：relay 几秒内就把文件捡走了，
 * 校验跑的时候文件已经不在 —— **在副作用发生之后才执行的检查，不是检查。**
 * 所以草稿必须先落在 relay 看不见的地方（temp/），校验通过才移进去。
 *
 * 用法:
 *   （先把内容写进 temp/draft.json）
 *   node bin/outbox-send.js temp/draft.json
 */

const fs = require('node:fs');
const path = require('node:path');

// ── 投递终点：**发件人是谁，问出来，不写死**
//
//   relay 按 outbox 目录名判发件人 ⇒ 发件人写死的话，别人用这个脚本就会以那个名字发出去。
//
//   「我是谁」复用 `lib/busy.js` 的 `whoami()`：它从 tmux 会话名推，
//   并且复用 watchdog 的 `sessionToName`（那儿的注释写着理由：
//   自己 slice 就是第二份实现，而它分叉时两边各自都「正常工作」）。
//
//   🔴 拿不到名字时**退出，不默认** —— 默认到任何一个名字，都是「以别人的身份发言」。
//     （`busy.check()` 无参抛错、`createClient` 判不出就抛，是同一个取舍。）
const { whoami } = require('../lib/busy');
// ⚠️ `ENGLOOP_OUTBOX_AS` 只为**可测**：这个文件是脚本不是模块，测试只能起子进程，
//   而子进程的 tmux 会话名必然是跑测试那个人的 ⇒ 没有它就验不了「换个人会怎样」。
//   🔴 它同时是一个**冒名口**：设了它就能以任何人的身份写 outbox。
//     留着它是因为「不可测」比「可冒名」更贵 —— 这个取舍写在这里，不藏着。
const SENDER = process.env.ENGLOOP_OUTBOX_AS || whoami();
if (!SENDER) {
  console.error('🔴 认不出发件人：不在 agent 的 tmux 会话里，而 ENGLOOP_OUTBOX_AS 也没设。');
  console.error('   不给默认值是有意的 —— 默认到任何一个名字，都是以别人的身份发言。');
  process.exit(2);
}
// 这个文件在 `bin/` 下 ⇒ `__dirname` 要跨一层才到 `temp/`（运行期文件的家）。
const TEMP = path.join(__dirname, '..', 'temp');
const PROD_OUTBOX = path.join(TEMP, 'outbox', SENDER);

// ── 本发件人 ack 过哪些 id ——「本文件未 ack」这句话的分母
//   文件名带发件人名：它躺在 temp/ 这个共享目录里，而「我 ack 过哪些」本来就是每个人各自的事实。
//   不分名字空间的话，「别人别用这个文件名」就成了一条靠纪律维持的不变量 —— 用命名把它消掉。
const ACKED_LOG = path.join(TEMP, `acked-ids-${SENDER}.json`);
const ACKED_KEEP = 200;
function readAckedLog() {
  try { const a = JSON.parse(fs.readFileSync(ACKED_LOG, 'utf8')); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }   // 没有 / 坏了 ⇒ 空 ⇒ 当作没有记录，不是崩
}

// ── `--dry-run`：只校验，不落地 ─────
//
// 这个工具的成功路径就是投递 ⇒ 直接跑它做阳性/阴性/边界验证，阴性和边界那几例会真的发出去
// （发给在册 agent 的会真的到；发给随便一个 room_hash 的会凭空建一个永久的 `room:<hash>` stream）。
//
// > **★ 判据：一个「成功路径 = 产生副作用」的工具，**
// > **不存在无副作用的端到端测试 —— 除非它自己提供一条不产生副作用的路径。**
//
// 验证时除了审被测物对不对，还要审「跑它会发生什么」。
//
// ── `--test-outbox <dir>`：走完**整条**路径，只把终点换个目录
//
//   > **dry-run 必须走**完全相同的判定路径**，只在最后一步分叉。**
//
//   `--dry-run` 满足这一条（出口在全部校验之后、落地之前），
//   ⚠️ 但 `mkdirSync` / `writeFileSync` / `renameSync` / `rmSync` 这四步它一步都不走
//   ⇒ 它验的是**校验逻辑**，不是**落地逻辑**。
//   `--test-outbox` 不分叉，只把 OUTBOX 换成另一个目录 ⇒ 落地路径**全程被执行**。
//   两个都留着，因为它们覆盖的东西不同：
//
//     --dry-run           验校验逻辑（最快，日常发消息前顺手跑）
//     --test-outbox <dir> 验**整条**路径含落地（改了落地代码时用）
//
// ⛔ 用显式参数，不用环境变量：
//   **环境变量能静默把真实消息投到别处** —— 忘了 unset 就是一次静默失联，
//   而它跟「一切正常」在输出上完全一样。命令行参数每次都必须重新打出来。
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const tbIdx = argv.indexOf('--test-outbox');
const TEST_OUTBOX = tbIdx >= 0 ? argv[tbIdx + 1] : null;
// ⚠️ `tbIdx < 0 ||` 这一段不能省：
//   没有 `--test-outbox` 时 tbIdx = **-1** ⇒ `tbIdx + 1` = **0**
//   ⇒ `i !== 0` 会把**草稿路径本身**排除掉 ⇒ src=undefined ⇒ 所有不带参数的调用全报用法。
const src = argv.filter((a, i) => !a.startsWith('--') && (tbIdx < 0 || i !== tbIdx + 1))[0];
if (!src || (tbIdx >= 0 && !TEST_OUTBOX)) {
  console.error('用法: node bin/outbox-send.js <草稿文件> [--dry-run] [--test-outbox <dir>]');
  console.error('  --dry-run            跑完全部校验并打印结果，**不写 outbox、不删草稿**');
  console.error('                       ⚠️ 落地那四步（mkdir/write/rename/rm）它不走');
  console.error('  --test-outbox <dir>  走**整条**路径（含落地），只把终点换成 <dir>');
  process.exit(2);
}

let raw;
try {
  raw = fs.readFileSync(src, 'utf8');
} catch (err) {
  console.error(`✗ 读不到草稿: ${err.message}`);
  process.exit(1);
}

let obj;
try {
  obj = JSON.parse(raw);
} catch (err) {
  console.error(`✗ 不是合法 JSON，**没有发送**: ${err.message}`);
  // 「解析失败」不说在哪，跟没说一样
  const m = String(err.message).match(/position (\d+)/);
  if (m) {
    const pos = Number(m[1]);
    console.error(`  出错位置 ${pos} 附近:`);
    console.error(`  …${raw.slice(Math.max(0, pos - 100), pos)}[[HERE]]${raw.slice(pos, pos + 100)}…`);
  }
  process.exit(1);
}

// ── 纯 ack：没有收件人也没有话要说，只是要 ack 掉一条无需回复的消息 ──
//
//   「不用回」**不等于**「不用 ack」：不 ack 的话 60 秒后它照样重投。
//   没有收件人就拒发的话，唯一的出路是硬造一条没人需要的回复。
//
//   `lib/relay.js` 明确支持这种形状（四条同时满足才放行）——
//   **一个校验器比被校验的协议更严，会把合法用法挡在外面。**
const isAckOnly = String(obj.text ?? '') === ''
  && !obj.username && !obj.room_hash && !obj.work
  && (Array.isArray(obj.ack) ? obj.ack.length > 0 : Boolean(obj.ack));

// ── 硬错误：这些不发 ──
const fatal = [];
if (!isAckOnly && (!obj.text || typeof obj.text !== 'string')) fatal.push('缺 text（或不是字符串）');
// ── `work`（worker 通路）────────────────────────
//
//   同上：没有这一项的话，一条完全合法的 `{work:"solve", job_id, text}`
//   会被判成「不知道发给谁」。
//   ★ 所以协议长出新目标类型时，**这里必须同时长** —— 而且没有任何东西会提醒你。
if (!isAckOnly && !obj.username && !obj.room_hash && !obj.work) fatal.push('既没有 username / room_hash / work —— 这条不知道发给谁');
// 三者互斥（跟 lib/relay.js 的 resolveWork 同一条规则；那边是权威，这里只是早一步拦住）
{
  const targets = [obj.username && 'username', obj.room_hash && 'room_hash', obj.work && 'work'].filter(Boolean);
  if (targets.length > 1) fatal.push(`同时有 ${targets.join(' / ')} —— 这三者互斥`);
}
// ── 🔴 job_id 重复检测 ──────────────
//
//   **同一个 job_id 在并发窗口内投两次 ⇒ 它会跑两次、烧两份额度、把副作用做两遍。**
//   去重键保护的是「重投」，不是「重复投递」——
//   因为 remember() 在**跑完之后**才写，而 XREADGROUP 一次领 concurrency 条。
//
//   outbox-send.js **每次是一个新进程**（一条命令一次）⇒ 进程内没有历史 ⇒ 历史落到文件里。
// ★ **这一个有意不按发件人分** —— 它记的是「哪个 (work, job_id) 已经派过」，
//   而那个语义**跨发件人成立**：别人派过的 job，再派一次同样是重复。
//   ⇒ 顺手把它也按发件人分的话，去重就失效了，而且**不报错**。
const SENT_JOBS = path.join(TEMP, "sent-jobs.json");
const JOB_TTL_MS = 24 * 3600 * 1000;   // 跟 worker 的 dedupeTtlSec(86400) 同源
if (obj.work && obj.job_id) {
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(SENT_JOBS, "utf8")); } catch (_) { seen = {}; }
  const now = Date.now();
  // 顺手清过期的 —— 不清的话这个文件会无限长
  for (const k of Object.keys(seen)) if (now - seen[k] > JOB_TTL_MS) delete seen[k];
  const key = obj.work + ":" + obj.job_id;
  if (seen[key]) {
    const age = Math.round((now - seen[key]) / 1000);
    fatal.push(`job_id "${obj.job_id}" 在 ${age} 秒前投过 work:${obj.work} —— `
      + "同一个 job_id 再投一次**不是幂等**：它会跑两次、烧两份额度。"
      + "真要重跑就换一个 job_id。");
  } else if (!DRY) {
    seen[key] = now;
    try { fs.writeFileSync(SENT_JOBS, JSON.stringify(seen)); } catch (_) { /* 记不上不阻断 */ }
  }
}
if (obj.work && !obj.job_id) {
  // 去重键是 dedupe:worker:<type>:<job_id>。缺了它 relay 会拒绝，
  // 这里早一步说出来，省一次往返。
  fatal.push('work 消息缺 job_id —— 它是去重键，relay 不会替你生成');
}
if (obj.username && obj.room_hash) {
  // 房间消息用 username 回**只会私聊发起人，房间里其他人永远看不到，
  // 而且没有任何报错** —— 这是最容易犯又最难发现的错，所以这里判成硬错误。
  fatal.push('同时有 username 和 room_hash —— 房间消息只该用 room_hash');
}
// ── ★ ack 必须是复合格式 `<stream>:::<id>`（消除档）────
//
// 为显示而裁剪过的值（比如 `.split(':::')` 只取后半段）流回协议层时，
// `lib/relay.js` 拿到不含 `:::` 的 id 直接 `ack_failed` —— 而那个事件只进 bus 的 stdout，**当事人看不到**。
//
// ⚠️ 后果是静默的：文件被捡走、投递成功、outbox 清空 —— 全部绿灯，
//   而那条消息 60 秒后回来，看起来像「又一条新消息」。
//
// ★ 这一行属于「消除」档：它不要求任何人记得检查格式，
//   格式错的文件**根本发不出去**。
// 🔴 用**精确格式**，不用 `includes(':::')`：
//   多个 id 拼成一个串时（比如 zsh 默认不做词分割，空格分隔的 id 列表被当成一个参数），
//   `includes(':::')` 会放行 —— `{"ack":"a:::1-0 b:::2-0 c:::3-0"}` 里当然含 `:::`，
//   而实际一条都 ack 不掉。
//
// ★ `^\S+:::\d+-\d+$` —— 恰好一个 id，不含空白。
//   实际形如 `agent:dev:in:::1700000000000-0`（流名自带冒号，所以用 \S+ 不用字符类）。
const ACK_RE = /^\S+:::\d+-\d+$/;
const badAcks = (Array.isArray(obj.ack) ? obj.ack : (obj.ack ? [obj.ack] : []))
  .filter((a) => !ACK_RE.test(String(a)));
if (badAcks.length) {
  fatal.push(`ack 格式不对（要恰好一个 "<stream>:::<id>"，不能拼接、不能有空格）：`
    + `${JSON.stringify(badAcks)} —— relay 会静默丢弃它，那些消息 60 秒后会重投`);
}

// ── ★ 房间正文不许自带 `[房间 xxx] ` 前缀（消除档）──────
//
// `bin/serve.js` 扇出时会给每条房间消息加一个 `[房间 <名字>] ` 前缀 ⇒
// 源头自带一个的话，收件人看到两个。
//
// 成因是模仿：收到的消息都带这个前缀，而它是系统加的，不是作者写的 ——
// 照着收到的样子写，就把它抄进了源文。（跟上面「为显示而裁剪的 ack 流回协议层」
// 是同一条边界的反方向。）
//
// ⚠️ 「源头 1 + 扇出 0」和「源头 0 + 扇出 1」在收件侧观测完全相同；
//   要定死只能回房间流的原始条目（`XREVRANGE room:<hash>`）。
//
// ★ 这一行属于「消除」档：带前缀的**发不出去**。只写进文档只到检测档 ——
//   而这个错恰恰发生在「在模仿而不是在遵守规矩」的时候，那时不会去查文档。
if (obj.room_hash && /^\s*\[房间\s/.test(String(obj.text ?? ''))) {
  fatal.push('房间正文自带 `[房间 …] ` 前缀 —— 扇出会再加一个，对方看到两个。去掉它');
}

if (fatal.length) {
  for (const f of fatal) console.error(`✗ ${f}`);
  console.error('**没有发送。**');
  process.exit(1);
}

// ── 软警告：发，但说出来 ──
//
//   > **软警告在「以为知道原因」的时候最容易被忽略。**
//   > 不是没看见，是**看见了并驳回了它** —— 驳回用的理由来自上一次的正确经验。
//   所以措辞是：**问一个必须回答的问题，而不是给一个可以驳回的判断。**
//
//   不改成硬失败：它看不到这一轮收了什么，硬失败会挡住每一次正常的
//   「已提前 ack」，**而那会让人很快学会无脑绕过它，那时它才真的没用了**。
// ── ★★ 「没 ack」分三档，不是一句话 ───────────────────────
//
//   **「先 ACK 再干活」是一条纯靠记得的规矩，撑不住。**
//   而判据是现成的：`temp/poll-<name>.json` 知道这一轮收了什么
//   ⇒ 把「记得判断这条该不该带 ack」换成「工具替你判断」。
//
// ⚠️⚠️ **必须分三档，不能只有「提醒/不提醒」两档**：
//
//   本轮有消息 + 没 ack   🔴 **该 ack 却没 ack** —— 这是真问题
//   本轮没消息（timeout）  ✅ **主动发起，正常** —— 一个字都不说
//   poll.json 读不了       ⚠️ **「查不了」不许降级成「不用 ack」**
//
//   ★ 中间那一档的理由：对每一条主动发起的消息都喊一次「没有 ack」的话，
//   **一个恒定提醒的工具很快会被无视** —— 那时它连真该提醒的那次也一起失效了。
// 🔴 按发件人分，**没有 fallback**：回落到别人的 poll.json ⇒
//   拿「别人这一轮收了什么」去对「我 ack 了什么」⇒ 一份看起来正常而完全无关的报告，
//   那比不报更坏。找不到就**跳过并说一句为什么**（见下面两处 existsSync）。
const POLL_FOR_ACK = path.join(TEMP, `poll-${SENDER}.json`);
let pollDue = null;                       // null = 读不了；[] = 本轮没消息
try {
  const p = JSON.parse(fs.readFileSync(POLL_FOR_ACK, 'utf8'));
  pollDue = (p.messages || []).map((m) => m.stream_id).filter(Boolean);
} catch (_) { pollDue = null; }

if (!obj.ack) {
  if (pollDue === null) {
    // 「查不了」保持是「查不了」，不降级成「不用 ack」
    console.error(`⚠ 这条没有 ack，而且**读不到 ${path.basename(POLL_FOR_ACK)}**（查不了 ≠ 不用 ack）。`);
    console.error('   这一回合 poll 过吗？poll 的输出落盘了吗？');
  } else if (pollDue.length) {
    // 上一轮末尾已经 ack 过、这一轮开头那条不再带 ack 是正常用法 ⇒ 无条件报 🔴 会每轮都触发，等于没有告警。
    //   ⇒ 拿 `acked-ids-<name>.json` 当分母：全在记录里 ⇒ 说事实；有不在的 ⇒ 才报红。
    const _log = new Set(readAckedLog());
    const _new = pollDue.filter((id) => !_log.has(id));
    if (_new.length) {
      console.error(`🔴 **这条没有 ack，而本轮 poll 里有 ${_new.length} 条我从来没 ack 过**：`);
      for (const id of _new) console.error(`     ${id}`);
      console.error('   ⇒ 这一轮的别的 outbox 文件里 ack 过它们了吗？');
      console.error('   没有的话就是漏了（60 秒后重投，而你那时正在干别的）。');
    } else {
      console.error(`ℹ 这条没带 ack，而本轮 poll 那 ${pollDue.length} 条我上一轮都 ack 过了`);
    }
  }
  // else: 本轮 poll 没有消息 ⇒ 这是主动发起的一条,**什么都不说**
}

// ── ★ 差集自检：本轮 due 的 stream_id 和这个文件 ack 的 id，逐块对比 ─────
//
//   「这一轮要 ack 什么」这个念头在注意力被占满时不会出现；而发送器手上就有全部素材：
//   poll.json 有本轮 due，参数里有 ack 了什么 ⇒ 工具替你对，并把差集打出来。
//
// ⚠️ 不阻断发送：一轮里可以有多个 outbox 文件，这一条只 ack 一部分是完全正常的。
//   它报的是**事实**（还剩这些没 ack），不是错误判定。
//
// > ✅ **一个比对两个集合的检查，`A−B` / `B−A` / `A∩B` 三块都要有明确输出。**
// > **少写一块，那一块的错误就是静默的。**
//   按「会怎么错」建判据，会漏掉想不到的那一种（只算 `due − acked` 会漏掉
//   「ack 了不存在的 id」；只补「全错」又会漏掉「混了一条」）；把集合关系列全则不需要预判。
//
//   同理：任何 `if 条件: 告警` 都要问「else 打什么」。下面 `if (missing.length)`、
//   `if (stray.length)` 共同的 else 是「这一块没问题」，由 `ℹ 本轮 poll 共 N 条 · ack 了 M 条`
//   那一行承担 ⇒ 它**必须无条件打印**。
//
// 一个容易混的来源：消息 id（形如 `1700000000000-0`，在 poll.json 里）和 outbox 文件名
// （形如 `1700000001234.json`）都是 13 位毫秒时间戳 ⇒ 上面的格式检查只管形状、不管来源，
// 拿错了照样放行；下面「交集为零」那一档专门抓它。拿错通常是因为发完上一条没有 poll 就写了下一条。
//
// ⚠️ 局限：比的是 `poll.json` 的内容，而那是**上一轮**写的 ⇒ 不 poll 就发消息时，基准是陈旧的。
//   ⇒ 它真正的语义不是「你漏 ack 了」，是「**你的 ack 跟本轮 poll 对不上**」——
//     等价于「没 poll」或「抄错了来源」。两种都该停下来看。
const POLL_JSON = path.join(TEMP, `poll-${SENDER}.json`);
try {
  if (fs.existsSync(POLL_JSON)) {
    const poll = JSON.parse(fs.readFileSync(POLL_JSON, 'utf8'));
    const due = (poll.messages || []).map((m) => m.stream_id).filter(Boolean);
    const acked = new Set(Array.isArray(obj.ack) ? obj.ack : (obj.ack ? [obj.ack] : []));
    const missing = due.filter((id) => !acked.has(id));
    if (due.length) {
      const hit = due.length - missing.length;
      console.error(`ℹ 本轮 poll 共 ${due.length} 条 · 这个文件 ack 了 ${hit} 条`);
      // 🔴 ack 非空、但与本轮 poll **交集为零** ⇒ ack 的来源错了
      //   （典型：拿上一条 outbox 的**文件名**当了消息 id，两者都是 13 位毫秒时间戳）。
      //   ⚠️ 它不会误伤「一轮发多个 outbox 文件」—— 那种情况下每个文件的 ack
      //   都是本轮 due 的**非空子集**，交集不可能为零。
      // 🔴 反向差集：ack 里有**不属于本轮 due** 的 id。
      //   只算「due 里哪些没被 ack」的话，反过来那一半是静默的：
      //   ack 了 3 条、其中 1 条来源错，输出只会说「ack 了 2 条」。
      //   ⚠️ 它跟 hit===0 那条不重叠：那条管「全错」，这条管「混了一个」。
      const dueSet = new Set(due);
      const stray = [...acked].filter((a) => !dueSet.has(a));
      if (stray.length && hit > 0) {
        console.error(`⚠ ack 里有 ${stray.length} 条**不属于本轮 poll**（其余 ${hit} 条是对的）：`);
        for (const s of stray.slice(0, 5)) console.error(`     ${s}`);
        console.error(`     ⇒ 上一轮漏掉的补 ack？还是抄错了来源？两种都该确认一次`);
      }
      if (acked.size > 0 && hit === 0) {
        console.error(`🔴🔴 这个文件的 ack **一条都不在本轮 poll 里** —— 来源很可能错了`);
        console.error(`     常见成因：拿**上一条 outbox 的文件名**当了消息 id（两者都是 13 位时间戳）`);
        console.error(`     ⇒ 先确认：这一回合**poll 过了吗**？id 是从 poll.json 抄的吗？`);
        console.error(`     本轮 due: ${due.slice(0, 3).join(' ')}${due.length > 3 ? ' …' : ''}`);
      }
      if (missing.length) {
        // 只报「还剩 N 条没 ack」的话，开头那条不带 ack 的正常用法会每轮都触发 ⇒
        //   拿 `acked-ids-<name>.json` 当分母，把「上一轮已 ack 过」摘出去。
        const log = new Set(readAckedLog());
        const already = missing.filter((id) => log.has(id));
        const truly = missing.filter((id) => !log.has(id));
        console.error(`ℹ 本文件未 ack：${missing.length} 条`
          + (already.length ? `（其中 ${already.length} 条在我上一轮的已 ack 记录里）` : ''));
        if (truly.length) {
          // 报**事实**（不在 `acked-ids-<name>.json` 里），不报**判定**（从来没 ack 过）：
          //   这份记录只记经过这个脚本的 ack —— 直接写 outbox 文件的纯 ack 它看不见，
          //   断言「没发生过」需要的数据它本来就没有。
          console.error(`🔴 而这 ${truly.length} 条**不在 ${path.basename(ACKED_LOG)} 里**：`);
          for (const id of truly.slice(0, 8)) console.error(`     ${id}`);
          if (truly.length > 8) console.error(`     …还有 ${truly.length - 8} 条`);
          console.error('     ⚠️ 而它**只记经过这个脚本的 ack** —— 你在别处 ack 过的，它看不见');
          console.error('     ⇒ 这一回合还有别的 outbox 文件要发吗？没有的话就是漏了');
        }
      }
    }
  }
} catch (err) {
  // ⚠️ 自检坏了必须说出来 —— 静默失败的自检 = 一个恒绿的灯
  console.error(`⚠ 差集自检没跑成（不影响发送）: ${err.message}`);
}

// ── 落地：同目录 staging + rename(2)（消除档）──
//
//   直接 `writeFileSync(dest, raw)` 的话：`fs.watch` 在 **create** 就触发 ——
//   **文件名先出现，内容随后写入**，兜住那个缝的只有 relay 的
//   `DEBOUNCE_MS = 30`（`lib/relay.js`），而它没有任何 size / 稳定性判断。
//
//   三档：
//     检测  「验一遍」          → 要求下一个人**记得做**
//     余量  「30ms 通常够」      → 不要求记得，但**要求环境不变**
//     消除  同目录 rename(2)    → **什么都不要求**
//
//   > **中间那档最难查：它不靠记忆，靠的是一个没人会去复查的常数 ——**
//   > **而它平时的表现和正确一模一样。**
//
//   （几 KB 是一次 write 系统调用，对 30ms 是微秒级 —— 直接写实务上几乎不会
//    出事。但「几乎不会」和「不可能」差一整档，而这一档是免费的。）
//
// 两个前提，缺一不可：
//   · staging 放在 **OUTBOX 目录内部** ⇒ 必然同一文件系统 ⇒ `renameSync` 就是 rename(2)
//   · 后缀**不是** `.json` ⇒ relay 的 `readdirSync().filter(f => f.endsWith('.json'))`
//     天然忽略它（`lib/relay.js`）—— 不用改 relay 一行
//
// ⚠️ 边界：校验失败时那个 `.tmp` 会留在 outbox 目录里（relay 看不见，不影响投递，
//   但会攒）。用时间戳命名，攒了也能一眼看出是哪次。
// ⚠️ dry-run 的出口在 mkdir / write / rename / rm 全部之前 ——
//   dry-run 必须在**任何**副作用之前返回。
// ── 发件人 ＋ 它决定的几个路径 —— **两条路径都打**
//
//   「以谁的身份发」是一个决定，必须有输出暴露它。只在 dry-run 里打的话，
//   真发时一个路径都看不到 —— 而方向正好是反的：dry-run 发错了没事，
//   真发发错了就以别人的身份说了话。可观测性要加在有副作用的那条路上。
//
// ⚠️ `OUTBOX` 在这里定义（而不是在落地处）：`--test-outbox` 模式下真正的终点不是 `PROD_OUTBOX`，
//   打印 `PROD_OUTBOX` 会在唯一会去看它的那个场景里说一句假话。
const OUTBOX = TEST_OUTBOX || PROD_OUTBOX;
console.log(`  as : ${SENDER}`);
console.log(`  outbox   : ${OUTBOX}${TEST_OUTBOX ? '   ⚠️ --test-outbox（不是生产 outbox）' : ''}`);
console.log(`  ackedLog : ${ACKED_LOG}`);
console.log(`  pollJson : ${POLL_JSON}`);
// `sentJobs` 有意不带发件人名（见上面「job_id 重复检测」）
console.log(`  sentJobs : ${SENT_JOBS}   （有意共享，不按发件人分）`);

// ── thread 归属提醒 ── 判定在 `lib/thread-hint.js`，那里写着为什么
//   位置：在观察点之后、dry-run 出口之前 —— 两条路都要看得见它。
//   ⚠️ fail-open：这个检查自己坏了不该让人发不出话。
try {
  const hint = require('../lib/thread-hint').threadHint(obj);
  if (hint) console.log(`  ${hint}`);
} catch (_) { /* 同 bin/next.js 那几个 alert：检查坏了不拖垮主路径 */ }

if (DRY) {
  console.log('✅ 校验全部通过（--dry-run，**没有写 outbox，草稿保留**）');
  console.log(`  ${Buffer.byteLength(raw)} 字节 · text ${String(obj.text ?? '').length} 字`);
  console.log(`  ack: ${JSON.stringify(obj.ack)}`);
  console.log(`  to : ${isAckOnly ? '（纯 ack，不投递）'
    : obj.room_hash ? `房间 ${obj.room_hash}` : obj.username}`);
  process.exit(0);
}

// ⚠️ 分叉**只有 `OUTBOX` 这一个值**（定义在上面的观察点处，好让两条路都打得出它）
//   —— 下面的 mkdir / write / rename / rm 一行都不变：判定逻辑不分叉，只改终点。
if (TEST_OUTBOX) console.log(`⚠️  --test-outbox: 终点已改为 ${OUTBOX}（不是生产 outbox）`);

fs.mkdirSync(OUTBOX, { recursive: true });
const stamp = Date.now();
const staging = path.join(OUTBOX, `.staging-${stamp}.tmp`);
const dest = path.join(OUTBOX, `${stamp}.json`);
fs.writeFileSync(staging, raw);
fs.renameSync(staging, dest);   // 同卷 rename(2)：名字出现那一刻内容就是全的
fs.rmSync(src, { force: true });

// ── 记下这一次 ack 掉的 id
//   挂在**发送成功之后**，不是校验通过之后 ——
//   校验过了但没落地的那条，它 ack 的东西并没有真的被 ack。
try {
  const mine = Array.isArray(obj.ack) ? obj.ack : (obj.ack ? [obj.ack] : []);
  if (mine.length) {
    const merged = [...readAckedLog(), ...mine].slice(-ACKED_KEEP);
    fs.writeFileSync(ACKED_LOG, JSON.stringify(merged));
  }
} catch (e) { console.error('⚠ 记 acked-ids 失败（不影响这次发送）：' + e.message); }

// 「⏱ 记得再 poll」**必须挂在「已发送」这一行上**，不能放在独立行里：
//   调用方常用 `| grep -E "已发送|to :|✗"` 只看确认行，独立的提醒行会被滤掉。
//   任何 grep 都必然匹配这一行，因为 grep 的目的就是确认「发出去了」。
//   这仍然不是消除档（随时能写 `| head -1`），但它把「被滤掉」从默认变成了得刻意为之。
console.log(`✓ 已发送 → ${path.basename(dest)}   ⏱ 这一回合还没 poll 的话，现在就去`);
console.log(`  ${Buffer.byteLength(raw)} 字节 · text ${String(obj.text ?? '').length} 字`);
console.log(`  ack: ${JSON.stringify(obj.ack)}`);
console.log(`  to : ${isAckOnly ? '（纯 ack，不投递）'
  : obj.room_hash ? `房间 ${obj.room_hash}` : obj.username}`);

// ── 心跳提醒 ───────────────────────────────────────
//
// 判断型触发点（「我要开始一段不看消息的活」）在注意力被占满时最先失灵 ——
// 「埋头干」没有一个清晰的开始瞬间。所以这条提醒挂在**一个真实发生的事件**上：
// 你刚发出了一条消息。它打印在那个事件的输出里，不需要你想起来去读任何文档。
//
// ⛔ 为什么这里**不直接替你跑**短轮询：
//   那会真的收到消息 → 它进了你的 PEL → **你欠一个 ack 而不自知**。
//   **一个替你做事、而把后果藏起来的工具，比一句提醒危险。**
console.log('');
console.log('  ⏱  写 outbox **不刷花名册** —— 心跳只由 next.js 刷（roster TTL 900s）');
console.log('     手上这件还要接着干的话，顺手跑一次（3 秒，输出**不要**丢掉）：');
console.log('     node ../../bin/next.js \\');
// 这里不打印具体的 `--group … --name …`：写死某个 agent 的参数，别人照着跑就会用那个
//   agent 的消费者身份读它的收件流 ⇒ 它的消息被领走进别人的 PEL，而它看不到、也不知道。
//   这行只是一段文本，不会失败，只会成功地做错事。
//   按 SENDER 拼也不行：编排者读的流跟 agent 不同（不是 `agent:<name>:in`）。
//   **一条命令，只有在它对所有读到它的人都成立时，才该被打印出来。**
console.log('       （跑你自己那条 poller 命令 —— 参数各人不同，这里故意不写）');
