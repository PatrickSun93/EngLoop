'use strict';

/**
 * 聊天室 —— 多方协作通道。
 *
 * ── 每房间一个流，但不是每参与者一个消费者组 ──────────────────────────────────────────────
 * 直观的设计是「每房间一个流，每参与者一个消费者组」，用来替掉 v1 的
 * `line_count` 水位管理（~60 LOC）。前半句照做，后半句没有：
 *
 * 如果让每个参与者直接去读房间流，agent 就得同时读多个流、而且每个流
 * 的消费者组名还不一样（房间用参与者名，收件流用 orch/agent:x）。
 * 那会改动那个**不能动**的收件接口（receive = 一次阻塞前台调用）——
 * 大脑的循环写在协议 markdown 里，接口一变循环就断。
 *
 * 所以：房间流仍然是唯一的历史真相（可回溯、可重放），但由 **bus** 用
 * 一个消费者组去读，再扇出到各参与者已有的收件流。agent 侧零改动 ——
 * 它照常读自己的收件流，只是消息上多了 room_hash 字段。
 *
 * 这跟 v1 的房间扇出函数是同一个形状，
 * 区别在于水位由消费者组维护，不用自己记 line_count。
 * ──────────────────────────────────────────────────────────────
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
// ★ 只为查「谁有自己的收件流」—— 扇出过滤和 members 端点都要问这个问题。
//   （不构成循环依赖：roster 只 require queue。）
const roster = require('./roster');
// thread 合并的旁路映射。只在 historyPayload 里用 —— 它得跟历史一起送到浏览器，
// 因为上溯找根发生在那边。（不构成循环依赖：thread-merge 不 require 任何本地模块。）
const threadMerge = require('./thread-merge');
// 章（`sender_type` 等）的字段名只在 lib/stamp.js 里写一次。
const stampLib = require('./stamp');
// `done` 的判据只有一处出处（前后端共用）—— 只在 fanOutPlan 的 broadcast 里用。
// `bin/serve.js`、`lib/relay.js` 已经这么引了。（不构成循环依赖：threads.js 不 require 任何模块。）
const threads = require('../web/threads.js');

const META = (hash) => `engloop:room:${hash}`;
const INDEX = 'engloop:rooms';
const stream = (hash) => `room:${hash}`;

function makeHash(name) {
  // ── 🔴 掺 8 字节随机 —— 只用 `名字:Date.now()` 不够 ────────────
  //
  //   **时间戳精度不够**：连着两次 `create(redis, 同名)` 落在同一毫秒
  //   ⇒ 同一个 hash（`test/rooms-gate.test.js` 的「两个同名房间目录不同」会间歇红，
  //   症状跟「按房间名推导目录」**逐字一样**：`a.flow_dir === b.flow_dir`）。
  //
  //   🔴 生产后果比测试红严重，因为 `create()` 里两步都是**静默**的：
  //     `redis.set(META(hash), …)` ⇒ **直接覆盖，没有任何警告**
  //     `redis.sadd(INDEX, hash)`  ⇒ 集合去重 ⇒ 索引里只剩一个
  //     ⇒ **先建的那个房间静默消失**，而没有一处会报错。
  //   触发条件窄（同名 ＋ 同毫秒）：人手点不会，**而脚本批量建会，测试也会**。
  //
  //   ⚠️ **不要换成进程内计数器**：那只保同进程唯一，而两个进程同毫秒建同名房间
  //     照样撞 —— 而这个系统里「两个进程同时建房间」正是它的常态。
  //
  //   ✅ 随机部分**不改变语义**：全仓没有任何地方从名字反推 hash
  //     （查房间一律走 `META(hash)` / `INDEX`）。生产调用点只有下面的 `create()`；
  //     它也被导出给测试直接调（见文件末那段注释）。
  return crypto.createHash('sha1')
    .update(`${name}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`)
    .digest('hex')
    .slice(0, 12);
}

// ── 流程字段 ────────────
//
// 房间 meta 上多三个字段（flow / stage / assignee），让「现在轮到谁」
// 有一个**不依赖任何人记忆**的答案 —— JARVIS 会被上下文压缩，一个
// 靠「记得现在是 review 阶段」维持的流程在压缩之后就断了，**而且不报错，
// 它看起来只是安静了**。
//
// ⛔ **状态、判据（查产出文件）、发消息是分开的三层**：
//    判据错的症状是「流程停在原地」，发消息错的症状是「有人收到不该收的活」。
//    合起来的话，出问题时分不清是哪一半坏了。

const FLOW_DIR = path.join(__dirname, '..', 'protocols', 'flows');

/** 阶段产出放哪（相对仓库根）。★ 只有这一个出处 —— 生成和解析都用它。 */
const FLOWS_REL = 'docs/flows';
const REPO_ROOT = path.join(__dirname, '..');
const FLOW_DIR_MISSING = 'FLOW_DIR_MISSING';

/**
 * 流程跑完之后 stage 停在这个值上。**它不是 stages 里的一个阶段。**
 *
 * ⚠️ 所以一个模板里出现叫 `done` 的阶段是非法的 —— 那会让「跑完了」和
 *   「正在跑那个叫 done 的阶段」在 meta 里长得一模一样。`validateFlow`
 *   拦这一条。
 */
const STAGE_DONE = 'done';

/**
 * `flowStatus` 的判别字段。
 *
 * ★★ `NO_FLOW` 和 `DONE` 必须分开 —— 这两个在「现在没人被点名」这件事上
 *   表现完全一样（assignee 都是 null），**而处置完全相反**：前者是普通
 *   聊天房间的常态，后者是流程走到了终点。合成一个「空闲」状态的话，
 *   人看见的是同一句话，而他要做的事不一样。
 */
const FLOW_STATE = {
  NO_FLOW: 'no_flow',             // flow:null —— 普通聊天房间
  NOT_STARTED: 'not_started',     // 绑了流程，但 stage 还没落
  RUNNING: 'running',             // 正在某个阶段上
  DONE: 'done',                   // 跑完了
  UNKNOWN_FLOW: 'unknown_flow',   // flow 有值，但模板**读不到**
  INVALID_FLOW: 'invalid_flow',   // 模板读到了，但结构非法
  INVALID_STAGE: 'invalid_stage', // stage 不在这个模板的阶段表里
};

/**
 * 给读出来的 meta 补上流程字段。
 *
 * ★★ 为什么归一化收在 `get()` 里，而不是让调用方各写一句 `meta.flow || null` ──
 * redis 里存的是 JSON 字符串，**老格式的房间里根本没有这几个键**。
 * 于是读出来是 `undefined`，而 `undefined` 和 `null` 不是一回事：
 * `JSON.stringify` 会把前者整个键丢掉，`'flow' in meta` 对它是 false。
 * 一个「读到 undefined 就当普通房间」的约定，只要有**一个**调用方忘了写，
 * 那一处就会把老房间判成别的东西 —— **而它不会报错**。
 *
 * `get()` 是所有读的唯一入口（list / join / leave / post / historyPayload /
 * membersHandler 全都过它），收在这里就没有第二个地方需要记得这件事。
 * 跟 `expectsReply` 收口是同一个理由。
 *
 * ★ 有个**好的**副作用：join/leave 会把归一化后的 meta 写回 redis，
 *   于是老房间被动过一次之后自然带上这三个字段（lazy migration）。
 *   ⚠️ 但**不能反过来依赖它** —— 一个从没被 join 过的老房间永远是老格式，
 *   所以归一化必须每次读都做，不能当成一次性迁移。
 */
function withFlowDefaults(meta) {
  if (!meta) return meta;
  meta.flow = meta.flow ?? null;
  meta.stage = meta.stage ?? null;
  meta.assignee = meta.assignee ?? null;
  // ★ `flow_dir` 跟另外三个一样要归一化 —— 老房间读出来是 null。
  //   它是**存下来的**，不是算出来的（见 makeFlowDir / flowDirFor）。
  meta.flow_dir = meta.flow_dir ?? null;
  // ★ `stage_entered_at`：判据靠它分辨「这份产出是不是这一轮的」。
  //   老房间读出来是 null —— 而 null 会让那条比对**退化**，
  //   所以 stageGate 在缺它的时候会把这件事喊出来。
  meta.stage_entered_at = meta.stage_entered_at ?? null;
  // ── ★ `flow_snapshot`：绑流程那一刻的**阶段名序列** ─────
  //
  //   它回答的是别处回答不了的一个问题：**「这次模板改动，会不会把正在跑的
  //   房间改道？」** —— 那是**新旧两份**的关系，而 `validateFlow(def)` 只收
  //   一份，它的签名里没有那个信息。
  //
  // ⚠️⚠️ **`null` 有两种含义，而它们在代码里长得一样：**
  //     ① 绑流程时还没有这个字段（老房间）→ **不知道模板变没变**
  //     ② 模板没变过                        → **知道它没变**
  //   ⇒ **绝不能把 ① 当成 ②。** 那样一个真的被改道的老房间会安静地走去另一格。
  //   所以 `flowStatus` 在缺它的时候要**自曝**「没做漂移比对」——
  //   跟 `stage_entered_at` 缺失时的处理逐字同一个道理。
  meta.flow_snapshot = meta.flow_snapshot ?? null;
  // ── ★ `frozen`：`tasks` 这类阶段 gate 通过那一刻，产出文件的指纹 ────────
  //
  //   ★ **它必须存在 meta 上，不能存在 `flow_dir` 下的文件里** ——
  //     那样它跟被冻结的东西同目录、同权限，改规格的人可以顺手一起改；
  //     而且那个文件自己也有「它是不是最新的」这个问题（递归）。
  //   **meta 由 gate 写，agent 不直接写** —— 分离是天然的。
  meta.frozen = meta.frozen ?? null;
  // ── ★ `unfrozen`：解冻**追加**一条，不清掉 `frozen` ────────────────
  //   清掉的话，「它变了」这个事实就消失了，下游只知道「现在对得上」。
  //   追加之后，下游看到的不是「对不上」，是「**它变了，变了这些**」。
  meta.unfrozen = Array.isArray(meta.unfrozen) ? meta.unfrozen : [];
  return meta;
}

/**
 * 产出目录名 —— **绑流程时生成一次，之后存在 meta 上再也不变。**
 *
 * ★★ 为什么不从任何东西推导（这条比格式本身重要）───────────────────
 * ```
 * 按流程名推导    → 两个房间绑同一套流程 → 撞同一个 DESIGN.md，互相覆盖
 * 按房间名推导    → 房间名不唯一；而且**一改名目录就分叉了**，
 *                   症状是「之前写的 DESIGN.md 不见了」
 * 按 room_hash    → 唯一，但人翻文件时得先查 hash 才知道是哪个房间
 * ✅ 生成一次存下来 → 唯一 + 可读 + 改名不影响
 * ```
 * > **从可变的东西推导标识符，将来一定会分叉 —— 而分叉时不会有任何报错。**
 *
 * ★ 存**相对仓库根**的路径，不存绝对路径 —— 绝对路径换台机器就错了，
 *   而 meta 是会被 dump/restore 的。
 */
function makeFlowDir(hash, name) {
  return `${FLOWS_REL}/${hash}-${slugify(name)}`;
}

/**
 * @param {object} [opts]
 * @param {string|null} [opts.flow]      绑哪套流程。**不传 = null = 普通聊天房间。**
 * @param {string|null} [opts.stage]
 * @param {string|null} [opts.assignee]
 *
 * ★ 三个都可选且默认 null —— 现有调用 `create(redis, name)` 一个字不用改。
 *
 * ⚠️ 给了 `flow` **不等于流程启动了**：stage 仍然是 null（`not_started`）。
 *   「绑定」和「启动」是两件事，启动要先核对角色都在花名册里
 *   （缺一个就拒绝启动，并说出缺谁）—— 那一步不在这里（见 checkRoles / bindFlow）。
 *
 * ★ 给了 `flow` 就**顺手生成一次 flow_dir**（绑定时生成，之后不再变）。
 *   `flow_dir` 可以显式传：传 `null` 能造出「绑了流程却没有目录」那个坏状态，
 *   测试要用它 —— 而生产路径上出现那个状态，说明绑定那一步漏了。
 */
async function create(redis, name, {
  flow = null, stage = null, assignee = null,
  flow_dir = undefined, stage_entered_at = undefined,
} = {}) {
  const hash = makeHash(name);
  const now = new Date().toISOString();
  const meta = {
    hash, name, created_at: now, members: [],
    flow, stage, assignee,
    flow_dir: flow_dir !== undefined ? flow_dir : (flow ? makeFlowDir(hash, name) : null),
    // ★ 落在 stage 上而不是 flow 上：换阶段就要换时间戳，绑流程不用。
    //   显式传 null 能造出「在某个阶段上、却不知道什么时候进来的」那个坏状态。
    stage_entered_at: stage_entered_at !== undefined ? stage_entered_at : (stage ? now : null),
  };
  await redis.set(META(hash), JSON.stringify(meta));
  await redis.sadd(INDEX, hash);
  return meta;
}

async function get(redis, hash) {
  const raw = await redis.get(META(hash));
  return raw ? withFlowDefaults(JSON.parse(raw)) : null;
}

/**
 * 房间清单。
 *
 * ── ★ `last_activity_at`：为什么不能只有 `created_at` ──────
 * 界面要按「最近的排前面」并且「只显示最近 N 天的」。
 * 而 **`created_at` 答不了这两个问题**：一个十天前建、现在还在用的房间，
 * 按 `created_at` 排会沉到底、按 `created_at` 过滤会**直接消失**。
 *
 * ⚠️ 而「消失」这件事**不报错、不留痕** —— 人只会觉得「那个房间怎么没了」，
 *   然后去别处找原因。一个让人「看不见」的误判，比让人「看错」的误判更难被发现。
 *
 * ⇒ 取流里最后一条的 id（Redis stream id 的前半段**就是毫秒时间戳**，
 *   不用额外存字段），空房间回退到 `created_at`。
 *
 * 代价：每个房间多一次 `XREVRANGE … COUNT 1`。房间是个位数量级，可接受；
 * 真到了三位数再谈缓存。
 */
async function list(redis) {
  const hashes = await redis.smembers(INDEX);
  const out = [];
  for (const h of hashes) {
    const m = await get(redis, h);
    if (!m) continue;
    m.message_count = await redis.xlen(stream(h)).catch(() => 0);
    // ★ 只取最后一条的 **id**，不读字段 —— id 的前半段就是入流时的毫秒时间戳。
    //   用它而不是消息里的 `timestamp`：后者是发送方写的，可能缺、可能是别的时区；
    //   而 id 是 Redis 自己盖的章，**在这条流里永远单调递增**。
    const last = await redis.xrevrange(stream(h), '+', '-', 'COUNT', 1).catch(() => []);
    const ms = last && last[0] ? Number(String(last[0][0]).split('-')[0]) : NaN;
    m.last_activity_at = Number.isFinite(ms)
      ? new Date(ms).toISOString()
      : m.created_at;   // 空房间：用建房时间，而不是 null —— null 会让前端的排序和过滤各自猜一次
    out.push(m);
  }
  // ★ **降序** —— 最近活动的排最前。按 `created_at` 升序的话，
  //   最老的房间永远在最上面，而它多半是最不需要看的那个。
  return out.sort((a, b) => String(b.last_activity_at).localeCompare(String(a.last_activity_at)));
}

async function join(redis, hash, member) {
  const meta = await get(redis, hash);
  if (!meta) throw new Error(`房间不存在: ${hash}`);
  if (!meta.members.includes(member)) {
    meta.members.push(member);
    await redis.set(META(hash), JSON.stringify(meta));
  }
  return meta;
}

async function leave(redis, hash, member) {
  const meta = await get(redis, hash);
  if (!meta) return null;
  meta.members = meta.members.filter((m) => m !== member);
  await redis.set(META(hash), JSON.stringify(meta));
  return meta;
}

/**
 * 发言。写进房间流（历史真相），扇出由 bus 负责。
 * 不在这里直接扇出 —— 那样发言者要知道所有人的收件流，耦合太深。
 *
 * ── `reply_to` ─────────────────────────────────
 * 值是**被回复那条的房间流 stream id**，也就是本函数上一次的返回值 `id`。
 * 跟 `fanOutPlan` 里 broadcast 的 `id`、`history()` 里每条的 `id` 是
 * **同一个 id 空间** —— 三处必须一致，否则前端摞不起来（而且不会报错，
 * 只会静静地把每条回复都显示成顶层）。
 *
 * ★ **可选**。没传就不写这个字段 —— 于是：
 *   · 没有 thread 字段的老消息读出来 `reply_to === undefined`
 *   · 新的顶层发言同样 `undefined`
 *   **两者在下游行为一致（都当顶层），所以不需要迁移。**
 *
 * ⚠️ **只存不验**：这里不检查那个 id 是否真的存在于本房间流里。
 *   理由是写入路径上多一次 `XRANGE` 会把发言变成两次往返，而**存一个指向
 *   不存在消息的 reply_to，后果只是那条回复被当成顶层显示** —— 比发言变慢便宜。
 *   代价写在这里：它没验过。
 */
async function post(redis, hash, { from, text, reply_to = null, expects_reply = false, stampFields = null }) {
  const meta = await get(redis, hash);
  if (!meta) throw new Error(`房间不存在: ${hash}`);
  // ★ 章：调用方给的 `stampFields` 只认 lib/stamp.js 产出的那两个字段
  //   （`pick()` 过一遍）—— 这里不接受任意字段，免得这个参数变成「往房间流里写任何东西」的口子。
  //   不传 = 不盖章 ⇒ 读的一侧判 `unknown` ⇒ `trust:"data"`。
  const sealed = stampFields ? stampLib.pick(stampFields) : {};
  const id = await redis.xadd(
    stream(hash), '*',
    'from', String(from), 'text', String(text),
    'room_hash', hash, 'room_name', meta.name,
    'timestamp', new Date().toISOString(),
    // ★ 空值一律不写字段（而不是写 'null' 字符串）—— Redis stream 的字段值
    //   只能是字符串，写进去就成了字面量 "null"，下游 `if (m.reply_to)` 会当真。
    ...(reply_to ? ['reply_to', String(reply_to)] : []),
    // ★★ `expects_reply` 同理，而且这一个更狠：**只在 true 时写字段，
    //   绝不写 `'false'`** —— redis 里存的都是字符串，而 `'false'` 在 JS 里
    //   是 **truthy**，下游一个 `if (msg.expects_reply)` 就会把每条广播判成
    //   「要求回复」，agent 互相回复的广播风暴就原封不动地回来。
    //   不写字段 → `expectsReply()` 的白名单认不出 → false。**方向是对的那一边。**
    //   （判据的唯一出处是 `expectsReply()`，见它头上那段。）
    ...(expects_reply === true ? ['expects_reply', 'true'] : []),
    ...Object.entries(sealed).flat(),
  );
  return {
    id, hash, from, text,
    ...(reply_to ? { reply_to: String(reply_to) } : {}),
    expects_reply: expects_reply === true,
  };
}

/** 读历史。房间流是 append-only，随时可回溯 —— v1 那边是 chatlog.jsonl。 */
async function history(redis, hash, count = 50) {
  const rows = await redis.xrevrange(stream(hash), '+', '-', 'COUNT', count);
  return rows.reverse().map(([id, fields]) => {
    const o = { id };
    for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
    return o;
  });
}

// ── HTTP 层要用的三块（放这里而不是 bin/serve.js 的路由回调里）──────
//
// 理由跟 `watchdog.buildAgentsPayload` / `shutdown.timeoutAlertText` 一样：
// **bin/ 的入口脚本没法被测试 require（会立刻起服务、占端口）。
// 一段没法被测试看见的判定，就是一段没有守卫的判定。**

const ROOM_NOT_FOUND = 'ROOM_NOT_FOUND';

const COUNT_DEFAULT = 50;
const COUNT_MAX = 1000;

/**
 * 解析 `?count=`。
 *
 * ★ 非法值**回落到默认值，不报 400** —— 这个端点是给界面刷房间用的，
 *   一个打错的 count 不该让整个房间显示不出来。
 *
 * ⚠️ 但上限必须有：`XREVRANGE ... COUNT 99999999` 会把整条流拉进内存再
 *   序列化成 JSON。没上限的话，一个 URL 就能让 bus 卡住 —— 而 bus 卡住
 *   等于所有 agent 的 relay 一起停。
 */
function parseCount(raw, { def = COUNT_DEFAULT, max = COUNT_MAX } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), max);
}

/**
 * 房间历史的响应体。
 *
 * ★ **房间不存在时抛错，绝不返回空 messages。**
 *   「这个房间没有消息」和「没有这个房间」在界面上长得一模一样，
 *   而后者意味着请求方拿着一个错的 hash —— 静默返回 `[]` 等于告诉他
 *   「一切正常，只是还没人说话」。`/api/agents` 头上那段注释讲的是同一件事。
 *
 * ★ 顺带把 name / members 一起返回：界面要显示房间标题和成员，
 *   否则它得再打一次 `/api/rooms` 才画得出顶栏。
 */
async function historyPayload(redis, hash, count = COUNT_DEFAULT) {
  const meta = await get(redis, hash);
  if (!meta) {
    const err = new Error(`房间不存在: ${hash}`);
    err.code = ROOM_NOT_FOUND;
    throw err;
  }
  return {
    hash: meta.hash,
    name: meta.name,
    members: meta.members,
    count,
    messages: await history(redis, hash, count),
    // ★★ thread 合并的旁路映射 ——**必须跟历史一起送出去。**
    //
    //   合并存在服务端，而上溯找根发生在**浏览器里**（`Threads.rootIdOf`）。
    //   不把表送过去的话：服务端合并成功、前端不知道、**界面纹丝不动** ——
    //   人会以为合并没生效，然后反复点。
    //
    //   ⚠️ 同一个形状 `bin/next.js` 里的 `room_msg_id` 那段也记着：数据已经在流里了、
    //   只是没往外传，于是功能在一侧全绿，对另一侧却是空功能。**「功能可用」和
    //   「使用者能用」是两件事**，而这里的使用者是浏览器。
    //
    //   ⚠️ 跟着 history 走、不另开一个端点：两次请求之间可能有人合并，
    //   那样前端会拿到一批消息配一张对不上的表 —— 而错配的表**不会报错**，
    //   只会把两个话题画错位置。
    merges: await threadMerge.map(redis, hash),
  };
}

/**
 * 把异常翻译成 HTTP 状态 + 响应体。
 *
 * ⚠️ 判据是 `err.code`，**不是** `err.message.includes('不存在')` ——
 *   已有的 `POST /api/rooms/:hash/post` 用的是后者，而那种写法有两个问题：
 *   改一个字的文案就会把 404 变成 503；而一个碰巧含「不存在」三个字的
 *   Redis 错误会被报成 404。
 *
 * ★ **每种错误都带 `next`（该做什么）**，不只是 `error`（是什么）。
 *
 *   > **诚实但无用的错误消息，人还是会去猜** —— 而且比假装没事更难发现，
 *   > 因为**写的人看那句话时，脑子里已经有了它省略掉的那部分上下文**
 *   > （写 `"房间不存在: abc"` 的人知道「所以去 /api/rooms 核一下 hash」，读的人不知道）。
 */
function httpError(err) {
  if (err && err.code === ROOM_NOT_FOUND) {
    return {
      status: 404,
      body: {
        error: String(err.message),
        next: '去 GET /api/rooms 看现有房间列表核对 hash；'
            + '也可能这个房间已经被删了 —— 两种情况这个端点都答不出来，'
            + '但房间列表能。',
      },
    };
  }
  return {
    status: 503,
    body: {
      error: 'QUEUE_UNAVAILABLE',
      message: String((err && err.message) || err),
      // ★ 这句是给读的人定性的：**「查不了」不是「没有」**，
      //   所以正确动作是重试，不是据此得出「这房间是空的」。
      next: '这不是「房间没有消息」，是「读不到」—— 别据此下结论。'
          + 'redis 恢复后重试即可；bus 的 GET /health 能看它现在的死活。',
    },
  };
}

/**
 * `GET /api/rooms/:hash/history` 的 handler。
 *
 * ★★ 为什么整个 handler 在这里，而不是 `bin/serve.js` 的路由回调里 ──────
 * 这个端点的**全部价值**是「房间不存在时返回 404，而不是 200 + 空数组」。
 * 而那件事**只在真的走一遍 HTTP 才验得到** —— 一条静态断言最多证明源码里
 * 出现过 `historyPayload` 这个词，证不了状态码是几。
 *
 * ⚠️ 而这个项目**不能靠起一个真 bus 来测**：bus 一起来 watchdog 就会枚举
 *   真的 tmux 会话，而测试库的花名册是空的 —— 于是**每个真 agent 都会被判
 *   失聪，被 submit 一条恢复指令**。测试会去打断正在干活的人。
 *
 * 所以 handler 做成一个能挂到任意 express app 上的函数：测试起自己的 app、
 * 自己的端口，打真 HTTP，**没有 bus 的任何副作用**。
 */
function historyHandler(redis) {
  return async (req, res) => {
    try {
      const payload = await historyPayload(
        redis, req.params.hash, parseCount(req.query.count));
      res.json(payload);
    } catch (err) {
      const { status, body } = httpError(err);
      res.status(status).json(body);
    }
  };
}

/**
 * `POST /api/rooms/:hash/members` 的 handler —— 加人/踢人。
 *
 * ── ★★ 为什么它**不拒绝**把人（不在花名册的名字）加进成员表 ──────────
 * 成员表现在混着两个用途：
 *   · **路由** —— 消息扇给谁
 *   · **展示** —— 房间里有谁（顶栏那一行）
 *
 * 人**需要**出现在展示里（他确实是房间参与者），**不该**出现在路由里
 * （广播已经把消息推到他浏览器了，再扇一份就是重复）。
 *
 * > **拒绝加入 = 用路由的理由否决了一个合法的展示需求。**
 *
 * 所以修的是扇出（`fanOutPlan` 的 `routable` 过滤），不是这个端点。
 * 端点照常接受，但在响应里**说清哪些成员不会被扇到**（`no_inbox`）——
 * 那不是错误，是一个人该知道的事实。
 */
function membersHandler(redis) {
  return async (req, res) => {
    const { add = [], remove = [] } = req.body || {};
    if (!Array.isArray(add) || !Array.isArray(remove)) {
      return res.status(400).json({
        error: 'add/remove must be arrays',
        next: '形如 {"add":["dev"],"remove":["dev2"]}；两个都可省，但给了就得是数组。',
      });
    }
    if (!add.length && !remove.length) {
      return res.status(400).json({
        error: 'nothing to do',
        next: '给 add 或 remove 至少一个非空数组。',
      });
    }
    try {
      const hash = req.params.hash;
      if (!(await get(redis, hash))) {
        const err = new Error(`房间不存在: ${hash}`);
        err.code = ROOM_NOT_FOUND;
        throw err;
      }
      for (const m of remove) await leave(redis, hash, String(m));
      let meta = await get(redis, hash);
      for (const m of add) meta = await join(redis, hash, String(m));

      // ★ 谁会被扇到、谁只靠广播 —— 这是加人之后人立刻该知道的事，
      //   否则要等到「为什么他没收到」时才被问。
      const registry = await roster.list(redis).catch(() => null);
      const routable = registry === null ? null : new Set(registry.map((a) => a.name));
      res.json({
        hash,
        name: meta.name,
        members: meta.members,
        // null = 花名册没查成（跟「查了，谁都不在册」不是一回事）
        no_inbox: routable === null ? null : meta.members.filter((m) => !routable.has(m)),
        no_inbox_note: routable === null
          ? '花名册查询失败，**查不出**谁有收件流 —— 这不是「都有」。'
          : '这些成员没有自己的收件流（不在花名册），**不会被扇出** —— '
          + '他们通过 WebSocket 广播看到房间消息。人属于这一类，这是正常的；'
          + '一个本该在册的 agent 出现在这里，说明它掉册了。',
      });
    } catch (err) {
      const { status, body } = httpError(err);
      res.status(status).json(body);
    }
  };
}

/**
 * 一条房间消息该分发给谁 —— **纯函数**，bus 的 fanOutRoom 照着它动手。
 *
 * ★★ 广播和扇出的成员表**不一样**，这是这个函数存在的唯一理由：
 *
 *   · `deliveries` **跳过发言者** —— 否则 agent 会收到自己刚说的话，
 *     并且可能再回一遍。
 *   · `broadcast` **不跳过任何人** —— 浏览器前面坐的是人，
 *     **人要看到房间里的全部发言，包括自己刚发的那条。**
 *
 *   把这两个规则写在同一个循环里的话，谁都会顺手让它们共用那个 `continue`
 *   —— 而那样做的后果是「自己说的话在自己屏幕上不出现」，
 *   看起来像消息发丢了，实际上是发出去了。**分开返回，就没法共用。**
 *
 * ★ 广播的 `text` 是**原文**，deliveries 的带 `[房间 X]` 前缀。
 *   前缀是给 agent 用的（它只有一个收件流，需要知道这条来自哪个房间）；
 *   浏览器已经拿到 room_hash + room_name 了，再加前缀是重复。
 */
/**
 * @param {object} meta          房间元信息
 * @param {object} msg           房间流里的一条
 * @param {Set<string>|null} routable
 *   **有自己收件流的成员名**（在花名册里的）。传 null = 不过滤（旧行为）。
 *
 * ── ★★ 为什么要过滤，以及判据为什么不是「是不是人」 ─────────────────
 * 成员表里有「Patrick」时，扇出会给他也投一份 —— 而他不在花名册，
 * `roster.lookup` 查不到，于是回落到 `orch:out`。**bus 消费 orch:out 又
 * broadcast 一次** → 同一句话在他屏幕上出现两遍。
 *
 * 没有广播时那条回落路径是唯一一条，所以不重复；**有了广播，它就成了重复。**
 *
 * ⚠️ 判据是「**有没有自己的收件流**」，不是「是不是人」——
 *   这个系统有一条明确的性质：**不区分收件人是人还是 agent**。
 *   而「不在花名册 → 没有专属收件流 → 回落到 orch:out」这条兜底的目的是
 *   **「消息别丢」**，而广播已经保证了不丢。
 *
 *   **掉册的 agent 也适用**：它读不到 `orch:out`（那是 bus 消费推 WS 的），
 *   那条回落对它本来就没用。所以这不是额外的区分，
 *   **是路由本来就该问的那个问题。**
 */
/**
 * 这条房间消息**要不要求收件人回复**。房间协议里唯一的判据出处。
 *
 * ── ★★ 为什么这是个函数，而不是一句 `if (msg.expects_reply)` ──────────
 * `lib/queue.js` 的 `send()` 最后一步是 `flat.push(k, String(v))` ——
 * **每个字段进 redis 之前都被 String() 掉了**。于是 `expects_reply: false`
 * 到了收件人手里是字符串 `'false'`，**而 `'false'` 在 JS 里是 truthy**。
 *
 *   `if (msg.expects_reply)`  →  `'false'` 为真  →  **每条房间广播都被判成
 *   「要求回复」** —— agent 互相回复的广播风暴原封不动地回来，
 *   而且前面还立着一个看起来「已经修好了」的字段。**零报错。**
 *
 * 反过来写 `msg.expects_reply === true` 也一样坏：redis 里读回来的 `'true'`
 * 不全等于 `true`，于是**显式要求回复的那条路径静默失效** —— 默认路径照常
 * 工作，测试全绿，只有真需要人回话的那次没人回。
 *
 * ★ 两个方向都错，而且**错的表现都是「看起来在工作」**。所以判据收进这一个
 *   函数，调用方一律问它，不许在别处自己写比较 —— 跟 `rooms.stream()`
 *   收口是同一个理由（见 relay.js 的 `resolveTarget`）。
 *
 * ⚠️ 白名单不是黑名单：**只有明确说「要」的才算要**。认不出来的一律 false ——
 *   这个方向上判错的代价是「一条该回的没回」（人看得见、能补），
 *   反方向是「一条不该回的回了」（自激，而自激看不见）。
 */
function expectsReply(msg) {
  const v = msg && msg.expects_reply;
  return v === true || v === 'true' || v === 1 || v === '1';
}

function fanOutPlan(meta, msg, routable = null) {
  // ★ 算一次，broadcast 和 deliveries 共用 —— 两边分别算的话就有两个判据，
  //   而它们一分叉，人在浏览器上看到的和 agent 收到的就是两回事。
  const wants = expectsReply(msg);
  return {
    broadcast: {
      // ★ `type` 是浏览器的路由键，只能是 'room_message' 这个字面值。
      type: 'room_message',
      // ★★ `id` 是**房间流的 stream id** —— 前端拿它跟
      //   `/api/rooms/:hash/history` 拉来的那批去重。history 里每条的
      //   `id` 也是同一个来源（`XREVRANGE` 返回的条目 id），
      //   **两边必须是同一个 id 空间**，否则去重永远匹配不上：
      //   刷新页面时每条消息会显示两遍，而且没有任何报错。
      //   （不能用 job_id 顶替：人走 rooms.post() 的那条根本没有 job_id。）
      id: msg.id || null,
      room_hash: meta.hash,
      room_name: meta.name,
      from: msg.from,
      text: msg.text,
      // 时序是判断因果的线索（watchdog 事件要跟发言交织排序），所以必须带。
      // 房间流里每条都有 timestamp：人走 post() 写的，agent 走 q.send 写的。
      at: msg.timestamp || null,
      job_id: msg.job_id || null,
      // ★ `reply_to` 走**同一个 id 空间**（见 post() 头上那段）。
      //
      //   ⚠️ 这里必须显式列出来，理由和 relay.js 里 `room_hash` 那段一样：
      //   **broadcast 是手工拼的白名单** —— 漏一个字段不会报错，
      //   只会让每条 thread 回复在实时推送里显示成顶层，
      //   **而刷新页面（走 history）之后又摞回去了**。
      //   那种「刷新前后不一致」最难查，因为两边各自都「能用」。
      reply_to: msg.reply_to || null,
      // ★★ `expects_reply` —— 同一个「白名单漏字段」的形状。
      //
      //   broadcast 是给浏览器的，人不会因为一个字段而自激，所以这里带上它
      //   不是为了掐链 —— 是为了让**人看得见这条是知会还是派活**。
      //   缺了它，界面上「房间里说了句话」和「房间里点名要你回」长得一样，
      //   而分不清这两者正是广播风暴的根因。
      //
      //   ⚠️ 这里给的是 `wants`（规范化过的布尔），不是 `msg.expects_reply`
      //   原值 —— 直接透传原值的话，前端拿到的是字符串 `'false'`，
      //   它那边一个 `if` 就又踩回同一个坑。**规范化必须发生在出口，
      //   不能指望每个消费方各自记得。**
      expects_reply: wants,
      // ★★ `done` / `verify` / `sender_type` —— 同一个形状：只有 history 带、实时推送不带的话
      //   ⇒ 刷新前后不一致（房间完成报告的通知实时不弹、核验跟帖实时不合并）。
      //
      // `done`：给前端 `onDoneMessage`（房间完成报告的桌面通知）和「今天」视图的「刚完成」。
      //   ⚠️ 规范化成布尔，理由跟 `expects_reply` 一字不差：流里读回来是字符串 `'false'`，
      //   而它是 truthy。判据走 `threads.isDone`（唯一出处），不在这里另写一份比较。
      done: threads.isDone(msg),
      // `needs_decision`：「这条话在等 Patrick 拍板」。规范化成布尔（理由同上），判据走 `threads.needsDecision`。
      needs_decision: threads.needsDecision(msg),
      // `verify`：给前端决定通知弹不弹、写不写「未验证」（值域见 lib/done-verify.js）。
      //   原样透传，没有就是 null。
      verify: msg.verify || null,
      // `sender_type`：给前端认核验结论跟帖（`system`）、「需要你」认「人类回过了」（`human`）。
      //   原样透传，没有就是 null（**不**走 readStamp —— 那会把缺失改写成 `unknown`）。
      //   字段名从 lib/stamp.js 取，不写死。
      [stampLib.SENDER_FIELD]: msg[stampLib.SENDER_FIELD] || null,
    },
    deliveries: meta.members
      .filter((member) => member !== msg.from)
      // ★ 没有收件流的成员不扇出 —— 广播已经覆盖他们了，再投一份就是重复。
      //   `routable === null` 时不过滤（保留旧行为，给不关心路由的调用方）。
      .filter((member) => routable === null || routable.has(member))
      // ★★ `expects_reply` 挂在**每一条投递**上 —— 这是掐断自激的那一处。
      //   agent 只有一个收件流，房间广播和派给它的活在里面长得一模一样
      //   （两个语义不同的东西共用一个通道）。
      //   这个字段就是让它们长得不一样的那样东西。
      .map((member) => ({
        member,
        text: `[房间 ${meta.name}] ${msg.text}`,
        expects_reply: wants,
      })),
    // ★ 被跳过的要**说出来**，不能静默省略：一个「消息没扇给他」的事实
    //   如果只存在于代码里，下次有人查「为什么 X 没收到」时无从下手。
    skipped_no_inbox: routable === null ? [] : meta.members
      .filter((member) => member !== msg.from && !routable.has(member)),
  };
}

// ── 流程状态：只读 ───────────────────────────────────────────────────
//
// ★★ 为什么**先**做这个只读查询，而不是先做推进逻辑 ────────────────────
//   看不见状态就没法调试后面所有东西。流程卡住的症状是「安静」——
//   没有报错、没有异常、房间看起来就是没人说话。而「没人说话」的成因至少有
//   五种（没绑流程 / 跑完了 / 模板读不到 / stage 写坏了 / 就是在等人干活），
//   **它们在房间界面上长得一模一样**。这个函数存在的全部意义，
//   是让这五种分得开。

/**
 * 读一个流程模板。读不到返回 null。
 *
 * ★ **流程是数据不是代码**：加一个流程 = 加一个 json 文件，
 *   这里一行都不用改，而且它可以被人读、被 diff、被 review。
 *
 * ⚠️ 名字必须先过白名单再拼路径。`flow` 的值来自 redis 上的房间 meta，
 *   而 meta 是 HTTP 端点写得进去的 —— `../../../etc/passwd` 拼进
 *   `path.join` 会读到仓库外面去。白名单而不是黑名单，理由跟
 *   `expectsReply` 那段一样：**认不出来的一律拒绝**。
 *
 * ★ **不缓存**。这是给人调试用的低频调用，而缓存会让「改了模板，
 *   为什么状态没变」变成一个要重启才解释得通的问题。将来 advance()
 *   变高频了再谈缓存 —— 那时候要连**失效**一起谈，不能只谈命中。
 */
/**
 * 一段文本的 md5。**冻结判据的唯一出处** —— 三处要用（gate 写、下游对、解冻记）。
 * 各写各的话，早晚有一个用了别的编码或别的算法，而那时两边算出来的数不一样，
 * **症状是「永远对不上」，而没有任何东西会说是哪一边错了。**
 */
function md5Of(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

/**
 * 一次模板改动，会不会把**正在跑的某个房间**改道。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★★ **为什么这是一个新函数，而不是塞进 `validateFlow`**
 *
 *   `validateFlow(def)` 只收**一份** def ⇒ 它能回答的是「这份模板自身合法吗」。
 *   而这里要回答的是「**这次改动**（旧 → 新）会不会改道」——
 *   **那是两份之间的关系，它的签名里没有那个信息。**
 *   往 `validateFlow` 里塞逻辑不会让它长出它没有的输入。
 *
 * ── 三种改动方式，后果完全不同 ────
 *
 *   | 改动          | idx        | nxt        | 有信号吗 |
 *   |---------------|------------|------------|----------|
 *   | 改现有阶段名  | -1         | —          | ✅ INVALID_STAGE，会响 |
 *   | 加在**最前**  | 各自 +1    | **不变**   | ✅ 零影响（相对顺序不变） |
 *   | 加在中间/后面 | 不变       | **变了**   | 🔴 **零信号** —— 通过 validateFlow、
 *                                              state 仍是 running、房间静静走去另一格 |
 *
 *   ★ 新阶段加在最前，只是碰巧对正在跑的房间零影响（新元素插在下标 0，
 *     后面所有下标各自 +1 而相对顺序不变）。业务上该加在哪是另一回事，
 *     两者没有任何关系 —— 别把「零影响」当成加在最前的理由，也别依赖它。
 *
 * ⚠️ **纯函数**（不碰 redis、不读文件）：「插在中间必须被检出」这条正控测试
 *   全靠能直接喂数据给它。
 *
 * @param {string[]} oldNames 改动**前**的阶段名序列
 * @param {string[]} newNames 改动**后**的阶段名序列
 * @param {string}   curStage 那个房间当前在哪一格
 * ── 🔴 三种返回值，**「判不了」必须跟「没变」长得不一样** ─────────────
 *
 *   ```
 *   无漂移   null                                   「查过了，没变」
 *   有漂移   { kind: 'next_changed' | 'stage_gone', … }
 *   判不了   { kind: 'unknown', why }               ← **真值**，`if (drift)` 会进去
 *   ```
 *
 *   ⚠️ 三种都返回 `null`、再靠一句注释「调用方不许把 null 读成安全」拦着是不够的
 *   （跟 `flowStatus` 那一层 `flow_snapshot === null` 的两种含义是同一个洞）：
 *
 *   > **注释拦不住下一个调用方写 `if (!drift) { /* 安全 *\/ }`，
 *   >   而那行代码看起来完全正常。**
 *
 *   ⇒ 「判不了返回真值」，**最自然的写法 `if (drift)` 会走进分支，
 *     调用方被迫处理它** —— 不需要任何人记得。
 *     （跟「选运行时检测而不是改动时检查」是同一个理由。）
 *
 * @returns {null | { kind, cur, from, to } | { kind:'unknown', why }}
 */
function stageDrift(oldNames, newNames, curStage) {
  if (!Array.isArray(oldNames) || !Array.isArray(newNames)) {
    return { kind: 'unknown', why: '拿不到新旧两份阶段序列 —— **判不了**，不是「没变」。' };
  }
  if (typeof curStage !== 'string' || !curStage) {
    return { kind: 'unknown', why: '不知道这个房间当前在哪一格 —— **判不了**，不是「没变」。' };
  }
  const oi = oldNames.indexOf(curStage);
  if (oi < 0) {
    // 旧序列里就没有它 —— 那说明 stage 跟绑流程时记下的序列对不上，
    // **状态本身有问题**，而不是「这次改动没影响」。
    return {
      kind: 'unknown',
      why: `当前阶段 "${curStage}" 不在绑流程时记下的序列 [${oldNames.join(' → ')}] 里 —— `
         + '**判不了**这次改动有没有影响它。要么快照是坏的，要么 stage 被写坏了。',
    };
  }
  const oldNext = oi + 1 < oldNames.length ? oldNames[oi + 1] : STAGE_DONE;
  const ni = newNames.indexOf(curStage);
  if (ni < 0) {
    // 当前阶段被改名/删掉了 —— `flowStatus` 那边会落进 INVALID_STAGE（会响），
    // 这里仍然报出来，因为**「会响」和「说清是什么变了」是两件事**。
    return { kind: 'stage_gone', cur: curStage, from: oldNext, to: null };
  }
  const newNext = ni + 1 < newNames.length ? newNames[ni + 1] : STAGE_DONE;
  if (oldNext === newNext) return null;                       // 安全改动
  return { kind: 'next_changed', cur: curStage, from: oldNext, to: newNext };
}

function loadFlow(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(FLOW_DIR, `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 模板结构体检。合法返回 null，非法返回**一句人话**（会原样进 note）。
 *
 * ★ 「读不到模板」和「模板读到了但是坏的」分成两个 state，
 *   因为修法完全不同：前者去看文件在不在，后者去看文件里写了什么。
 */
function validateFlow(def) {
  if (!def || typeof def !== 'object') return '模板不是一个 JSON 对象。';
  if (!Array.isArray(def.stages) || !def.stages.length) return '模板里 stages 不是非空数组。';
  const names = [];
  for (const [i, s] of def.stages.entries()) {
    if (!s || typeof s.name !== 'string' || !s.name) return `第 ${i + 1} 个阶段没有 name。`;
    if (s.name === STAGE_DONE) {
      return `有一个阶段叫 "${STAGE_DONE}" —— 这个词被流程终点占用了，`
           + '留着它，「跑完了」和「正在跑这个阶段」在 meta 里会长得一模一样。';
    }
    if (names.includes(s.name)) return `阶段名 "${s.name}" 出现了两次 —— 那样 stage 指向哪个是不确定的。`;
    names.push(s.name);
  }
  if (def.on_reject != null && !names.includes(def.on_reject)) {
    return `on_reject 指向 "${def.on_reject}"，但阶段表里没有这个名字。`;
  }

  // ── ★★ 「哪个判决词触发打回」必须写明，不许有默认值 ──────────────────
  //
  //   `verdict: ["通过","打回"]` 只是词表，`on_reject: "spec"` 只说退到哪 ——
  //   **中间缺一句「哪个词触发它」**。靠数组下标（verdict[1] 是打回）是最坏的
  //   写法：改一下词表顺序，流程的走向就悄悄反过来了。
  //
  //   ⚠️ 而且**不能有默认值**：默认「都当通过」→ 打回静默失效；
  //   默认「都当打回」→ 流程永远退回去。**两个方向都错，而且都不报错。**
  //   所以缺了就判模板非法，让人在配置阶段就看见。
  const verdictStages = def.stages.filter((s) => Array.isArray(s.verdict) && s.verdict.length);
  if (verdictStages.length) {
    if (typeof def.reject_verdict !== 'string' || !def.reject_verdict) {
      return `有带 verdict 的阶段（${verdictStages.map((s) => s.name).join(' / ')}），`
           + '却没有流程级的 reject_verdict —— 那样就判不出哪个判决词该触发 on_reject，'
           + '而任何一个默认值都会让流程静默走错方向。';
    }
    for (const s of verdictStages) {
      if (!s.verdict.includes(def.reject_verdict)) {
        return `reject_verdict 是 "${def.reject_verdict}"，但阶段 "${s.name}" 的 `
             + `verdict 词表里没有它（有：${s.verdict.join(' / ')}）。`;
      }
    }
    if (def.on_reject == null) {
      return `reject_verdict 有了，却没有 on_reject —— 判出「打回」之后不知道退到哪个阶段。`;
    }
  }
  return null;
}

/**
 * 一个阶段对外的样子。
 *
 * ★ `requires` 一起带出来 —— 这里**不查**它们（查文件是 `stageGate` 的活），
 *   但**判据看得见**是调试推进的前提：「它为什么不推进」的答案
 *   永远在这个列表里，而藏在模板文件里的话，人得先知道去哪个文件找。
 */
function stageView(s) {
  return {
    name: s.name,
    role: s.role ?? null,
    produces: s.produces ?? null,
    requires: Array.isArray(s.requires) ? s.requires : [],
    ...(s.verdict ? { verdict: s.verdict } : {}),
  };
}

/**
 * 「这个房间在哪个阶段、轮到谁、下一步是什么」—— **只读，不写任何状态，
 * 不发任何消息。**
 *
 * ★ 房间不存在时**抛错**，绝不返回一个看起来正常的 `no_flow`。
 *   跟 `historyPayload` 是同一条：「这个房间没绑流程」和「没有这个房间」
 *   静默合并的话，等于告诉拿着错 hash 的人「一切正常，只是还没开始」。
 *
 * @returns {Promise<object>} `{ hash, name, state, flow, stage, assignee,
 *   current, next, next_on_reject, note }`
 */
async function flowStatus(redis, hash) {
  const meta = await get(redis, hash);
  if (!meta) {
    const err = new Error(`房间不存在: ${hash}`);
    err.code = ROOM_NOT_FOUND;
    throw err;
  }

  const base = {
    hash: meta.hash,
    name: meta.name,
    flow: meta.flow,
    stage: meta.stage,
    assignee: meta.assignee,
    flow_dir: meta.flow_dir,
    stage_entered_at: meta.stage_entered_at,
    current: null,
    next: null,
    next_on_reject: null,
  };

  // ★ 绑了流程却没有产出目录 —— 判据将来会找不到文件，而症状同样是「安静」。
  //   在状态里就说出来，别等到 roomGate 那一步才发现。
  const dirWarn = (meta.flow !== null && !meta.flow_dir)
    ? '。⚠️ 这个房间绑了流程**却没有 flow_dir** —— 绑定那一步漏了。'
      + '判据找不到产出目录，而且不会替它算一个（算出来的规则会跟存下来的分叉）。'
    : '';

  if (meta.flow === null) {
    return {
      ...base,
      state: FLOW_STATE.NO_FLOW,
      note: '普通聊天房间，没绑流程 —— 这里「没人被点名」是常态，不是卡住。'
          + `★ 这跟 state:"${FLOW_STATE.DONE}"（流程跑完了）不是一回事，`
          + '两者 assignee 都是 null，处置却相反。',
    };
  }

  const def = loadFlow(meta.flow);
  if (!def) {
    return {
      ...base,
      state: FLOW_STATE.UNKNOWN_FLOW,
      note: `绑的流程是 "${meta.flow}"，但模板读不到。`
          + `去看 protocols/flows/${meta.flow}.json：文件不在、JSON 坏了、`
          + '或者名字里有 `[A-Za-z0-9_-]` 之外的字符（那种会被直接拒绝，防路径穿越）。'
          + '⚠️ 这个房间推不动，而症状是「安静」—— 不查这里没人会告诉你。',
    };
  }

  const bad = validateFlow(def);
  if (bad) {
    return {
      ...base,
      state: FLOW_STATE.INVALID_FLOW,
      note: `模板 protocols/flows/${meta.flow}.json 读到了，但它是坏的：${bad}`,
    };
  }

  if (meta.stage === STAGE_DONE) {
    return {
      ...base,
      state: FLOW_STATE.DONE,
      note: `流程 "${meta.flow}" 跑完了（${def.stages.map((s) => s.name).join(' → ')} 全过了）。`
          + '没人被点名是**正常终点**，不是卡住。',
    };
  }

  if (meta.stage === null) {
    const first = def.stages[0];
    return {
      ...base,
      state: FLOW_STATE.NOT_STARTED,
      next: stageView(first),
      note: `绑了流程 "${meta.flow}"，还没启动。第一个阶段是 ${first.name}（角色 ${first.role}）。`
          + '⚠️ 启动前要核对每个角色都在花名册里，缺一个就该拒绝启动并说出缺谁 —— '
          + '不做的后果是流程「启动了」、活派出去了、**没有任何人收到**（规格 §二·五）。'
          + dirWarn,
    };
  }

  const idx = def.stages.findIndex((s) => s.name === meta.stage);
  if (idx < 0) {
    return {
      ...base,
      state: FLOW_STATE.INVALID_STAGE,
      note: `stage 是 "${meta.stage}"，但流程 "${meta.flow}" 里没有这个阶段`
          + `（有：${def.stages.map((s) => s.name).join(' → ')}，外加终点 "${STAGE_DONE}"）。`
          + '要么模板被改过、要么状态被写坏了 —— 哪一种得人来定，程序猜不了。',
    };
  }

  const cur = def.stages[idx];
  const nxt = def.stages[idx + 1] || null;

  // ── ★★ 模板漂移：**这次模板改动，会不会把这个房间改道** ────────────
  //
  //   `idx < 0` 那一支（上面）管的是「找不到当前阶段」—— 那种会响。
  //   这一段管的是**更隐蔽的那种**：`idx` 找得到、`state` 仍是 `running`、
  //   `validateFlow` 照样通过，**而 `nxt` 已经变了**。
  //   例：把 `survey` 插在 `tasks` 之后，停在 `tasks` 的房间
  //   下一格从 `dev` 变成了 `survey`，**一个信号都没有**。
  //
  // ⚠️⚠️ `flow_snapshot` 为 `null` 时**必须自曝**，不许静默当成「没变过」：
  //   「绑流程时还没有这个字段」和「模板没变过」在代码里长得一样，
  //   而前者不该报、后者该报 —— 把前者当后者，一个真被改道的老房间会安静地走错。
  //   （跟 `stage_entered_at` 缺失时的处理逐字同一个道理。）
  //   ★ `stageDrift` 自己处理 `snapNames === null` —— 它返回 `{kind:'unknown'}`
  //     而不是 `null`，所以这里**不需要**再写一次「有没有快照」的分支。
  //     少一个分支 = 少一处「两种含义共用一个值」的机会。
  const snapNames = meta.flow_snapshot && Array.isArray(meta.flow_snapshot.stages)
    ? meta.flow_snapshot.stages
    : null;
  const drift = stageDrift(snapNames, def.stages.map((s) => s.name), meta.stage);
  let driftWarn = '';
  if (drift && drift.kind === 'unknown') {
    driftWarn = `。⚠️ **没做**「模板改动会不会改道」的比对：${drift.why}`
      + (snapNames ? '' : '（这个房间绑流程时还没有 flow_snapshot 这个字段。）');
  } else if (drift) {
    driftWarn = '。🔴 **模板被改过，而且这个房间被改道了**：'
      + `"${drift.cur}" 的下一格原来是 "${drift.from}"，现在是 "${drift.to}"。`
      + `绑流程时记下的阶段序列是 [${(snapNames || []).join(' → ')}]，`
      + `现在是 [${def.stages.map((s) => s.name).join(' → ')}]。`
      + '**这不是状态坏了，是模板变了** —— 哪一份才对，得人来定。';
  }
  // ★ review 这类带 verdict 的阶段**有两条出路**。只报 `next` 会给出
  //   「下一步一定是 tasks」的假象，而它可能被打回 —— 两条都说出来。
  const rejectTo = cur.verdict && def.on_reject
    ? def.stages.find((s) => s.name === def.on_reject) || null
    : null;

  const note = [
    `阶段 ${cur.name}（角色 ${cur.role}）·`,
    meta.assignee
      ? `已点名 ${meta.assignee}`
      : '⚠️ assignee 为空 —— 这个阶段还没派人，流程不会自己动',
    `· 产出 ${cur.produces}，判据要求含：${(cur.requires || []).join(' / ') || '（无）'}`,
    // ⚠️ 角色名就是 agent 名，中间**没有映射层**（有意的设计选择）。
    //   所以 assignee 跟 role 对不上就是状态坏了，而不是「映射到别人了」。
    meta.assignee && meta.assignee !== cur.role
      ? `。⚠️ assignee "${meta.assignee}" 跟这个阶段的角色 "${cur.role}" 不一致 —— `
        + '角色名就是 agent 名，中间没有映射层，所以这不是「映射过去了」，是状态坏了'
      : '',
    nxt ? `。满足判据后进 ${nxt.name}（${nxt.role}）` : `。这是最后一个阶段，满足后 stage 走到 "${STAGE_DONE}"`,
    rejectTo ? `；判决打回则退到 ${rejectTo.name}（${rejectTo.role}）` : '',
    '。★ 这一步只读状态，**不会自己推进** —— 判据检查和发消息是后面两步。',
    dirWarn,
    // ★ 缺 stage_entered_at 时，判据分不出「本轮产出」和「上一轮遗留」——
    //   而那正是打回之后流程空转的入口。状态查询里就说出来。
    meta.stage_entered_at ? '' :
      '⚠️ 这个阶段没有 stage_entered_at —— 判据**没法**分辨产出是不是这一轮写的，'
      + '打回重做时旧产出会原样满足判据。',
    driftWarn,
  ].join('');

  return {
    ...base,
    state: FLOW_STATE.RUNNING,
    current: stageView(cur),
    next: nxt ? stageView(nxt) : null,
    next_on_reject: rejectTo ? stageView(rejectTo) : null,
    // ★ `drift` 出现在**返回值里**，不只在 note 的文本里 ——
    //   文本给人读，字段给程序判。只有文本的话，任何自动检查都得去正则匹配一段话，
    //   而那段话改一个字它就静默失效。
    drift,
    // ★ `frozen` / `unfrozen` 一起带出来：下游要回答「手上这份是不是 gate 认的那份」，
    //   而它不该为此再发一次请求（那正是这套机制要消掉的往返）。
    frozen: meta.frozen,
    unfrozen: meta.unfrozen,
    note,
  };
}

// ── 阶段判据：这个阶段的产出够不够格推进 ─────────────────────────────
//
// **推进的判据必须是可检验的事实，不是自述。**
//   ❌ arch 说「我设计完了」        ← 自述
//   ✅ DESIGN.md 存在 · 非空 · 约定的小节都在
//
// ⛔ 这一节**只查、只读、只回答「够不够格」**。它不写 meta、不发消息、
//    不动 stage —— 那是 `advance` 的事。分开的理由：判据错的症状是
//    「流程停在原地」，发消息错的症状是「有人收到不该收的活」。
//
// ★★ 这一节真正难的地方：
//    **判据不能只查存在性 —— 一个 3 字节的 DESIGN.md 也满足「存在且非空」。**
//    所以下面查的是**结构**，而且查到「小节下面有没有东西」这一层：
//    一个只有五个标题、一行正文都没有的 DESIGN.md **不许通过**。
//
// ⚠️ **判据的上限也要说清**：每节写一个字的文件会通过。那是**质量**问题，
//    归 review 阶段管 —— 编排者只做调度，不做评审。
//    两者一混，「流程卡住了」和「JARVIS 觉得写得不够好」会变得无法区分。

const DOCS_FLOWS = path.join(REPO_ROOT, FLOWS_REL);

/**
 * `produces` 只允许**简单文件名**。
 *
 * ⚠️ 它来自模板文件，而模板是人写的、也可能是从别处拷来的 ——
 *   `../../../etc/passwd` 拼进 path.join 就读到仓库外面去了。
 *   跟 `loadFlow` 的白名单同一个理由，只是这里挡的是路径分隔符。
 *
 * ★ 通配（`ADR-NNN-*.md`）和「一个阶段多个产出」暂时不支持 ——
 *   ADR 这类产出就是那种形状，但**认不出来就拒绝**，
 *   而不是悄悄当成一个叫 `ADR-NNN-*.md` 的文件去找（那会永远找不到，
 *   而症状是流程安静地停在原地）。
 */
function safeProduces(name) {
  return typeof name === 'string' && name.length > 0
    && !name.includes('/') && !name.includes('\\')
    && name !== '.' && name !== '..' && !name.includes('\0')
    && !name.includes('*') && !name.includes('?');
}

/**
 * 时间 → 毫秒数。ISO 字符串和数字都吃，认不出来返回 `null`。
 *
 * ★ 认不出来时**不替调用方决定**该怎么办 —— `stageGate` 拿到 null 会说
 *   「所以本轮比对没做」。在这里静默回落成 0 或 Date.now() 的话，
 *   一个坏掉的时间戳会变成「所有文件都算本轮的」或者「全都算旧的」，
 *   两个方向都不报错。
 */
function toMs(t) {
  if (t === null || t === undefined) return null;
  if (typeof t === 'number') return Number.isFinite(t) ? t : null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 把 markdown 切成标题 —— 判据的地基。
 *
 * ⚠️ **围栏里的 `#` 不算标题。** 少了这一步，一个把所有约定小节写进
 *   ```` ``` ```` 代码块里的文件会通过判据 —— 它「包含那几个标题」，
 *   但那几个标题一个都不是标题。**判据能被这么绕过，就等于没有判据。**
 *
 * ⚠️ 层级要留着：找一个小节的正文时，得在**同级或更高级**的下一个标题处
 *   截断。用「下一个任意标题」截的话，`### 子节` 会把子节内容切出去，
 *   于是一个内容全写在子标题下的小节被判成「空的」—— 假红灯比假绿灯少见，
 *   但一样会让流程停在原地。
 */
function headingsOf(text) {
  const lines = String(text).split(/\r?\n/);
  const heads = [];
  let inFence = false;
  lines.forEach((raw, at) => {
    const t = raw.trim();
    if (/^(```|~~~)/.test(t)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = /^(#{1,6})\s+\S/.exec(t);
    if (m) heads.push({ level: m[1].length, text: t, at });
  });
  return { lines, heads };
}

/** 一个小节的正文行（不含标题行本身）。 */
function sectionBody({ lines, heads }, head) {
  const next = heads.find((h) => h.at > head.at && h.level <= head.level);
  return lines.slice(head.at + 1, next ? next.at : lines.length);
}

/**
 * 约定的小节到齐了没、每一节下面有没有东西。
 *
 * ★ 标题匹配是**前缀**（`## 问题与背景` 满足 `## 问题`），不是全等。
 *   全等的话，人多写三个字流程就停了，而他看不出为什么。
 *   而 `### 问题` 不满足 `## 问题` —— 前缀比较天然把层级也比进去了。
 *
 * @returns {{missing: string[], empty: string[]}}
 *   `missing` = 标题根本不在；`empty` = 标题在、下面一行正文都没有。
 *   ★★ **两者必须分开报**：前者是「他还没写到那儿」，
 *   后者是「他放了个空壳」—— 后一种正是「看起来做完了」的形状。
 */
function checkSections(text, requires) {
  const doc = headingsOf(text);
  const missing = [], empty = [];
  for (const req of requires) {
    const head = doc.heads.find((h) => h.text.startsWith(req));
    if (!head) { missing.push(req); continue; }
    if (!sectionBody(doc, head).some((l) => l.trim().length > 0)) empty.push(req);
  }
  return { missing, empty };
}

/**
 * 读判决词（review 那类阶段）。
 *
 * ★★ **只在判决小节里找，不在全文里找。** 全文搜「打回」的话，
 *   一份正文里写着「上一轮被打回的那处已经改了」的 REVIEW.md 会被判成打回 ——
 *   而它的判决其实是通过。**判据踩到自己要判的词，是最难查的一类错。**
 *
 * ★ 判决小节默认是 `requires[0]`（模板里 review 的 requires 就是 `["## 判决"]`），
 *   模板可以用 `verdict_in` 显式指定。
 *
 * ⚠️ **同时出现两个判决词 → 拒绝，不是「取第一个」。**
 *   取第一个等于让排版顺序决定流程走向，而写的人根本不知道有这条规则。
 *   说不清就是说不清 —— 报出来让人改，比替他猜便宜得多。
 */
function readVerdict(text, stageDef) {
  const words = Array.isArray(stageDef.verdict) ? stageDef.verdict : [];
  if (!words.length) return { verdict: null, reason: null };

  const where = stageDef.verdict_in
    || (Array.isArray(stageDef.requires) && stageDef.requires[0]) || null;
  if (!where) {
    return { verdict: null, reason: '模板给了 verdict 词表，却没说去哪个小节里找（requires 是空的，也没有 verdict_in）。' };
  }
  const doc = headingsOf(text);
  const head = doc.heads.find((h) => h.text.startsWith(where));
  if (!head) return { verdict: null, reason: `判决小节「${where}」不在文件里。` };

  const body = sectionBody(doc, head).join('\n');
  const hit = words.filter((w) => body.includes(w));
  if (!hit.length) {
    return { verdict: null, reason: `判决小节「${where}」里没有出现约定的判决词（${words.join(' / ')}）。` };
  }
  if (hit.length > 1) {
    return {
      verdict: null,
      reason: `判决小节「${where}」里同时出现了 ${hit.join(' 和 ')} —— 判不出是哪一个。`
            + '（不替你猜：取第一个等于让排版顺序决定流程走向。）',
    };
  }
  return { verdict: hit[0], reason: null };
}

/**
 * **纯函数**：给一个目录和一个阶段定义，回答「够不够格推进」。
 *
 * ★ 不自己决定目录 —— 目录策略在 `flowDirFor` 里，可以单独换掉。
 *   混在一起的话，「判据对不对」和「文件该放哪」两个问题会一起改，
 *   而它们的验证方式完全不同。
 *
 * @returns {{ok: boolean, ...}} `reasons` 是**人话**，说清差什么；
 *   `missing_sections` / `empty_sections` 说清**差哪一节**（不是「格式不对」）。
 */
function stageGate(baseDir, stageDef, { since = null } = {}) {
  const out = {
    ok: false,
    stage: (stageDef && stageDef.name) || null,
    role: (stageDef && stageDef.role) || null,
    produces: (stageDef && stageDef.produces) || null,
    path: null,
    exists: false,
    bytes: 0,
    mtime_ms: null,
    since_ms: null,
    stale: false,
    checked_sections: [],
    missing_sections: [],
    empty_sections: [],
    verdict: null,
    reasons: [],
  };
  if (!stageDef || typeof stageDef !== 'object') {
    out.reasons.push('没给阶段定义 —— 判不了。');
    return out;
  }
  if (!safeProduces(stageDef.produces)) {
    out.reasons.push(`模板里这个阶段的 produces 是 ${JSON.stringify(stageDef.produces)}，`
      + '不是一个简单文件名（不许带路径分隔符、`..`、通配符）。'
      + '★ 没有可检验的产出就没有可检验的事实 —— 宁可在这里报错，也不要去找一个永远找不到的文件。');
    return out;
  }

  const p = path.join(baseDir, stageDef.produces);
  out.path = p;
  let text = null;
  try { text = fs.readFileSync(p, 'utf8'); } catch { /* 下面统一报 */ }
  if (text === null) {
    out.reasons.push(`产出文件还不在：${p}`);
    return out;
  }
  out.exists = true;
  out.bytes = Buffer.byteLength(text, 'utf8');
  // ── ★★ 指纹在**判定用的那一份文本**上算，不是「通过之后再读一次」──────
  //
  //   gate 判定时读到一份内容，而作者可能同时还在改，落盘的已经是另一份。
  //   ⇒ **gate 认的那份，在 gate 通过的那一刻可能已经不在磁盘上了。**
  //   「通过之后再读一次」会冻结一份 gate 从来没验过的内容，**而且不报错**。
  //   ⇒ 用同一个 `text` 变量，判定和指纹说的是同一件事。
  out.md5 = md5Of(text);
  try { out.mtime_ms = fs.statSync(p).mtimeMs; } catch { /* 读得到却 stat 不到，当没有 */ }
  if (!text.trim()) {
    out.reasons.push(`${stageDef.produces} 存在，但整个是空的（只有空白）。`);
    return out;
  }

  // ── ★★ 这份产出是**这一轮**的吗 ────────────────────────────────────
  //
  //   不做这条比对的后果是流程**自己转圈**：
  //   ```
  //   review 判「打回」→ stage 退回 spec → 旧 SPEC.md 还在、结构完整
  //   → 判据说「够格」→ 又推回 review → 负责 spec 的人根本没机会重做
  //   ```
  //   **每一步看起来都对，没有任何一处会报错** —— 而接上 `advance` 之后，
  //   它每转一圈就是一次真实的派活消息。
  //
  // ⚠️ 而这条比对**能验到的只有「本轮之后被写过」**：`touch` 一下就满足。
  //   内容有没有真的改，判据证明不了 —— 所以下面的措辞里不许出现「已重做」
  //   这种它证明不了的词。**能验到哪一层就说哪一层。**
  const sinceMs = toMs(since);
  out.since_ms = sinceMs;
  let staleFail = false;
  if (since === null || since === undefined) {
    // ★ 判据退化自曝：**缺字段导致判据变弱时，弱下去的那一部分
    //   要自己喊出来**，不能只在有字段的时候才诚实。
    out.reasons.push('⚠️ 没有 stage_entered_at，**没做**「是不是本轮产出」的比对 —— '
      + '一份上一轮遗留的文件在这里会被判为够格。');
  } else if (sinceMs === null) {
    out.reasons.push(`⚠️ stage_entered_at 解析不出时间（${JSON.stringify(since)}），`
      + '同样**没做**本轮比对 —— 坏数据导致的退化，跟「没有这个字段」一样要说出来。');
  } else if (out.mtime_ms !== null && out.mtime_ms < sinceMs) {
    // ★ 用 `<` 判旧（即 `mtime >= since` 算本轮）：同毫秒时放行。
    //   反过来（严格 `>`）会把一个刚写的文件判成旧的 —— 那是个假红灯，
    //   症状是流程停在原地而没人知道为什么，比放行一个同毫秒文件难查得多。
    out.stale = true;
    staleFail = true;
    out.reasons.push(`产出文件是**本轮之前**写的（mtime ${new Date(out.mtime_ms).toISOString()}`
      + ` 早于进入本阶段的时刻 ${new Date(sinceMs).toISOString()}）—— 这一轮还没有人动过它。`);
  }

  const requires = Array.isArray(stageDef.requires) ? stageDef.requires : [];
  out.checked_sections = requires.slice();
  if (!requires.length) {
    // ★★ 判据退化时**必须说出来**（「让检查打出它实际检查了什么」）。
    //   一个 `requires: []` 的阶段，这里能给的最强结论只是「文件非空」——
    //   而调用方看到 ok:true 会以为查过结构了。
    out.ok = !staleFail;
    out.reasons.push('⚠️ 模板没给 requires，所以这里**只查到了「文件存在且非空」**。'
      + '3 个字节也算通过 —— 判据弱到这个程度，得让读的人知道。');
    return out;
  }

  const { missing, empty } = checkSections(text, requires);
  out.missing_sections = missing;
  out.empty_sections = empty;
  if (missing.length) out.reasons.push(`缺小节：${missing.join(' / ')}`);
  if (empty.length) {
    out.reasons.push(`这些小节有标题、下面一行正文都没有：${empty.join(' / ')}`
      + '（★ 只有标题的产出**不算做完** —— 规格 §五① 就是这条）');
  }

  const v = readVerdict(text, stageDef);
  out.verdict = v.verdict;
  if (v.reason) out.reasons.push(v.reason);

  out.ok = !missing.length && !empty.length && !v.reason && !staleFail;
  if (out.ok) {
    out.reasons.push(`${stageDef.produces} 齐了：${requires.join(' / ')} 都在且都有正文`
      + (out.verdict ? `，判决 = ${out.verdict}` : '')
      // ⚠️ 措辞到此为止 —— 不说「已重做」「内容已更新」，那些它证明不了。
      + (out.since_ms !== null
        ? '，且在本轮之后被写过（⚠️ 只验到「被写过」这一层：touch 一下就满足，'
          + '内容有没有真的改，判据证明不了）'
        : ''));
  }
  return out;
}

/** 房间名 → 目录名里能用的那一段。**只在 `makeFlowDir` 里用一次。** */
function slugify(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'room';
}

/**
 * 房间的产出目录（绝对路径）—— **只读 `meta.flow_dir`，绝不算一个出来。**
 *
 * ★★ 缺字段时**报错而不是兜底**，这是这个函数最重要的一条 ────────────
 *   兜底算一个的话，系统里就有了两套规则：绑定时存的那个，和读取时算的那个。
 *   它们**平时给出同样的答案**，所以没人会发现；等房间改了名、或者绑定那一步
 *   换了生成规则，两套就分叉了 —— 而分叉的症状是
 *   **「之前写的 DESIGN.md 不见了」，不是任何一条报错。**
 *
 * ⚠️ 也校验一次路径：`flow_dir` 存在 redis 上，是外部写得进去的。
 *   绝对路径和 `..` 一律拒绝 —— 跟 `loadFlow` 的白名单同一个理由。
 *
 * @throws {Error} `err.code === FLOW_DIR_MISSING`
 */
function flowDirFor(meta) {
  const rel = meta && meta.flow_dir;
  const bad = (msg) => {
    const err = new Error(msg);
    err.code = FLOW_DIR_MISSING;
    return err;
  };
  if (!rel || typeof rel !== 'string') {
    throw bad(`房间 ${(meta && meta.hash) || '?'} 绑了流程，却没有 flow_dir。`
      + '★ 这是绑定那一步漏了 —— **我不替你算一个**：算出来的规则和存下来的规则'
      + '将来会分叉，而分叉那天不会有任何报错。修法是把 flow_dir 补进这个房间的 meta。');
  }
  if (path.isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) {
    throw bad(`flow_dir 不合法：${JSON.stringify(rel)} —— 只接受仓库内的相对路径`
      + '（不许绝对路径、不许 `..`）。它存在 redis 上，是外部写得进去的。');
  }
  return path.join(REPO_ROOT, rel);
}

/**
 * 把 `flowStatus` 和 `stageGate` 接起来：**这个房间现在够不够格推进**。
 *
 * ⛔ 仍然只读 —— 它回答问题，不改变任何东西。
 *
 * ★ 非 `running` 的房间**不判据**，而且要说清为什么：一个 `no_flow` 的
 *   房间「不够格推进」是对的，但理由跟「DESIGN.md 缺一节」完全不同，
 *   合成一个 `ok:false` 的话，人查到这里就断线了。
 */
async function roomGate(redis, hash, { baseDir = null } = {}) {
  const status = await flowStatus(redis, hash);
  const base = { ...status, base_dir: baseDir, gate: null };
  if (status.state !== FLOW_STATE.RUNNING) {
    return {
      ...base,
      can_advance: false,
      why: `房间不在 running（现在是 ${status.state}）—— 没有「当前阶段」可判。${status.note}`,
    };
  }

  // ★ 缺 flow_dir 是一个**可预期**的状态（老房间被事后绑流程时就会出现），
  //   所以这里把异常翻译成一个正常返回值 —— 抛出去的话调用方多半会吞掉，
  //   而它需要的恰恰是「为什么推不动」这句话。
  let dir = baseDir;
  if (!dir) {
    try { dir = flowDirFor(status); }
    catch (err) {
      return { ...base, can_advance: false, error_code: err.code, why: String(err.message) };
    }
  }

  const def = loadFlow(status.flow);
  const stageDef = def.stages.find((s) => s.name === status.stage);
  // ★ `since` 从房间状态来，不是这里现算 —— 判据要回答的是
  //   「产出比**进入这个阶段的时刻**新吗」，而那个时刻只有 meta 知道。
  const gate = stageGate(dir, stageDef, { since: status.stage_entered_at });
  return {
    ...base,
    base_dir: dir,
    gate,
    can_advance: gate.ok,
    why: gate.reasons.join('；'),
  };
}

// ── 推进：第四步（到这里流程才会动）─────────────────────────────────

/**
 * 进入一个阶段 —— **三个字段一起算出来。纯函数，不写 redis、不发消息。**
 *
 * ★★ 它存在的唯一理由是：**换阶段时 `stage_entered_at` 必须跟着换。**
 *   靠注释提醒「记得也更新时间戳」是一条会被跳过的规矩；把三个字段绑成
 *   一个返回值，调用方就**没法**只改 stage 不改时间戳。
 *
 *   忘了刷新的后果不是「少了个字段」，是**闸门在、水从旁边流过去**：
 *   打回退回 spec 时时间戳还是上一次进 spec 的时刻 → 旧 SPEC.md 的 mtime
 *   晚于它 → 判据说「本轮的」→ 放行 → 又推回 review。
 *   **而且比没有闸门更糟：现在有个字段让人以为已经防住了。**
 *
 * ⚠️ **「回退」也是「进入」。** review 打回时同样要走这里 ——
 *   那一次最容易被写成「只改 stage」，因为它感觉像「回到原来那个阶段」
 *   而不是「进入一个新阶段」。**在人的直觉里不是，在这个机制里必须是。**
 *
 * ★ `assignee` 不传就从模板的 `role` 取 —— 谁负责哪个阶段是模板定的，
 *   让调用方重复指定就是第二个真相来源。传了但跟 role 不一致 → 抛：
 *   角色名就是 agent 名，中间没有映射层。
 */
function enterStage(meta, { stage, assignee = undefined } = {}) {
  if (typeof stage !== 'string' || !stage) {
    throw new Error('enterStage: stage 必须是非空字符串。');
  }
  if (!meta || meta.flow == null) {
    throw new Error('enterStage: 这个房间没绑流程，没有阶段可进。');
  }
  const at = new Date().toISOString();

  if (stage === STAGE_DONE) {
    if (assignee !== undefined && assignee !== null) {
      throw new Error(`enterStage: 流程走到 "${STAGE_DONE}" 了，不该再点名任何人`
        + `（给的是 ${JSON.stringify(assignee)}）。`);
    }
    return { stage: STAGE_DONE, assignee: null, stage_entered_at: at };
  }

  const def = loadFlow(meta.flow);
  if (!def) throw new Error(`enterStage: 流程模板 "${meta.flow}" 读不到。`);
  const s = def.stages.find((x) => x.name === stage);
  if (!s) {
    throw new Error(`enterStage: "${stage}" 不在流程 "${meta.flow}" 的阶段表里`
      + `（有：${def.stages.map((x) => x.name).join(' → ')}）。`);
  }
  const role = s.role ?? null;
  const who = assignee === undefined ? role : assignee;
  if (who !== role) {
    throw new Error(`enterStage: 阶段 "${stage}" 的角色是 ${JSON.stringify(role)}，`
      + `不能派给 ${JSON.stringify(who)} —— 角色名就是 agent 名，中间没有映射层。`);
  }
  return { stage, assignee: who, stage_entered_at: at };
}

/**
 * 推进一格。**这是整个流程里唯一会写状态、唯一会发消息的地方。**
 *
 * ```
 * 1. roomGate 判够不够格      → 不够就什么都不做（它还在干）
 * 2. review 读 verdict        → 决定下一个 stage 是 tasks 还是 spec
 * 3. 核对下一个角色在花名册里  → 不在就拒绝，并说出缺谁
 * 4. enterStage → 先落 redis
 * 5. 广播 expects_reply:false
 * 6. 点名 expects_reply:true
 * ```
 *
 * ⚠️⚠️ **第 4 步必须在 5、6 之前。** 反过来的话消息发出去了、状态没写，
 *   重启后会再派一次，**而那个角色会收到两条一样的派活**
 *   （跟 relay 的 remember-before-ack 同一条）。
 *   `test/rooms-advance.test.js` 有一条源码断言守着这个顺序。
 *
 * ⚠️ **第 6 步是这整件事里唯一烧额度的动作** —— 所以第 3 步的校验是真挡，
 *   不是提醒。而「花名册查不了」按**不能推进**处理：查询失败不等于「都在」。
 */
async function advance(redis, hash, { baseDir = null, from = 'JARVIS' } = {}) {
  const g = await roomGate(redis, hash, { baseDir });
  const out = {
    advanced: false,
    hash,
    from_stage: g.stage,
    to_stage: null,
    assignee: null,
    rejected: false,
    started: false,
    why: g.why,
    messages: [],
  };
  // ── ★★ 「启动」也是推进一格 ──────────────────────────────────────
  //   绑流程只落 flow + flow_dir，**stage 仍然是 null**（not_started）——
  //   而 roomGate 只对 running 判据。所以少了这一段，一个刚绑好流程的房间
  //   **永远推不动，也永远没有人被点名**：人会看见「绑好了」，
  //   然后什么都不发生，而且不报错。
  //
  //   放在 advance 里而不是单独一个 start()，是为了复用同一套
  //   「角色在册校验 → 先落状态 → 广播 → 点名」——两个入口的话，
  //   校验漏在其中一个上不会被任何测试发现。
  const starting = g.state === FLOW_STATE.NOT_STARTED;
  if (!starting && !g.can_advance) return out;   // 它还在干 —— 什么都不做

  const def = loadFlow(g.flow);
  const idx = starting ? -1 : def.stages.findIndex((s) => s.name === g.stage);
  const cur = starting ? null : def.stages[idx];

  // ★ 打回判定走**模板里写明的那个词**，不靠 verdict 数组的下标 ——
  //   靠下标的话，改一下词表顺序，流程走向就悄悄反过来了。
  const rejected = !starting && !!(Array.isArray(cur.verdict) && def.reject_verdict
    && g.gate.verdict === def.reject_verdict);
  const nextName = starting
    ? def.stages[0].name
    : (rejected
      ? def.on_reject
      : (def.stages[idx + 1] ? def.stages[idx + 1].name : STAGE_DONE));
  const nextDef = def.stages.find((s) => s.name === nextName) || null;
  const nextRole = nextDef ? (nextDef.role ?? null) : null;

  if (nextName !== STAGE_DONE) {
    const registry = await roster.list(redis).catch(() => null);
    if (registry === null) {
      out.why = '花名册查不了 —— **这不是「都在」**。查不了就不推进：'
        + '下一步是发派活消息，发出去没人收的话，房间看起来「正在进行中」而实际没人在干。';
      return out;
    }
    if (!registry.some((a) => a.name === nextRole)) {
      out.why = `下一阶段 "${nextName}" 的角色是 "${nextRole}"，**花名册里没有它** —— 不推进。`
        + '硬推的话 relay 查不到它，会把这条派活投给 Patrick，'
        + `而房间看起来一切正常（规格 §二·五）。在册的：${registry.map((a) => a.name).join(' / ') || '(空)'}`;
      return out;
    }
  }

  // ★ 启动时 roomGate 不算目录（它只对 running 算），这里补一次。
  //   缺 flow_dir 就停在这 —— 派活消息里要写产出路径，写不出来就别发。
  let dir = baseDir || g.base_dir;
  if (!dir) {
    try { dir = flowDirFor(g); }
    catch (err) { out.why = String(err.message); out.error_code = err.code; return out; }
  }

  // ── 4. 先落状态 ──
  // ⚠️ 三个字段只能来自 enterStage，所以这里是 Object.assign 而不是逐个赋值 ——
  //    源码断言盯的就是这一行的形状。
  const meta = await get(redis, hash);
  Object.assign(meta, enterStage(meta, { stage: nextName }));
  // ── ★★ 冻结：**刚刚通过 gate 的那一格**的产出，指纹记进 meta ──────────
  //
  //   ⚠️ 用的是 `g.gate.md5` —— **gate 判定时读到的那份文本算出来的**，
  //     不是「推进成功之后再去读一次文件」。后者会冻结一份 gate 从来没验过的
  //     内容，而且不报错（理由见 `stageGate` 里算指纹那段）。
  //
  //   ⚠️ 只在**正常推进**时冻（`!starting && !rejected`）：
  //     · 启动那一次没有「刚通过的产出」
  //     · 打回那一次产出被判为不合格，**冻一份不合格的东西没有意义，
  //       而且会让下游以为它是权威版本**
  //
  //   ★ 覆盖上一次的 `frozen` 是对的：每一格冻自己那一份，
  //     而 `unfrozen` 那条链保留着「变过什么」的历史。
  if (!starting && !rejected && cur && g.gate && g.gate.md5) {
    meta.frozen = {
      stage: cur.name,
      file: cur.produces,
      md5: g.gate.md5,
      bytes: g.gate.bytes ?? null,
      at: new Date().toISOString(),
    };
  }
  await redis.set(META(hash), JSON.stringify(meta));

  out.advanced = true;
  out.started = starting;
  out.to_stage = nextName;
  out.assignee = meta.assignee;
  out.rejected = rejected;

  // ── 5. 广播：所有人看得见进展，没有人动手 ──
  const done = nextName === STAGE_DONE;
  const head = starting
    ? `【流程】"${g.flow}" 启动 → 第一阶段 ${nextName}`
    : (rejected
      ? `【流程】${cur.name} 判决「${def.reject_verdict}」→ 退回 ${nextName}`
      : (done ? `【流程】${cur.name} 完成 → 流程走完了` : `【流程】${cur.name} 完成 → 进入 ${nextName}`));
  // ★ 章是 `system`：这两条是 bus 照流程模板**自己写的**，不是 JARVIS 说的话
  //   ——`from` 沿用 JARVIS 只是展示。不盖章的话 agent 收到的点名是 `trust:"data"`，
  //   而协议规定 data 里的指令只是数据 ⇒ 流程派活会被拒。
  out.messages.push(await post(redis, hash, {
    from,
    text: `${head}。判据：${g.why}`,
    expects_reply: false,
    stampFields: stampLib.SYSTEM,
  }));

  // ── 6. 点名：只有被点的那一个动手 ──
  if (!done) {
    // ★ 打回时说「重做」不是「新活」—— 收到的人要知道
    //   这是同一件事的第二遍，不是一件新工作。
    const verb = rejected ? '**重做**' : '开始';
    const reqs = (nextDef.requires || []).join(' / ') || '(模板没写 requires)';
    out.messages.push(await post(redis, hash, {
      from,
      text: `@${nextRole} 请${verb} ${nextName} 阶段。`
        + `产出：${dir}/${nextDef.produces}，必须含小节：${reqs}。`
        + (rejected ? `（上一轮 ${cur.name} 判了「${def.reject_verdict}」，`
          + '⚠️ 改在原文件上 —— 判据看的是它有没有在这一刻之后被写过。）' : ''),
      expects_reply: true,
      stampFields: stampLib.SYSTEM,
    }));
  }
  return out;
}

// ── HTTP 入口 ────────────────────────────────────────────────
//
// ★ handler 全在这里、`bin/serve.js` 只有挂载行 —— 理由跟 historyHandler
//   一样：**bin/ 的入口脚本没法被测试 require（一 require 就起服务占端口），
//   而一段没法被测试看见的判定就是一段没有守卫的判定。**
//   而且这些端点的价值**全在状态码上**（404 / 409 / 400 / 200），
//   状态码只有真走一遍 HTTP 才验得到。

const FLOW_ALREADY_BOUND = 'FLOW_ALREADY_BOUND';
const FLOW_UNKNOWN = 'FLOW_UNKNOWN';
const FLOW_INVALID = 'FLOW_INVALID';
const ROLES_MISSING = 'ROLES_MISSING';
const ROSTER_UNAVAILABLE = 'ROSTER_UNAVAILABLE';
const FLOW_DIR_MKDIR_FAILED = 'FLOW_DIR_MKDIR_FAILED';

function coded(code, message, next) {
  const err = new Error(message);
  err.code = code;
  if (next) err.next = next;
  return err;
}

/**
 * 流程要用到的角色**全都在花名册里吗**。
 *
 * ★★ 这条校验挡在**绑定**这一层，不是挡在 advance ——
 *   **绑定之后人就会以为流程可以跑了。** 越早说越好。
 *
 * ⚠️ `roster.list` 失败 → 拒绝，**不当成「都在」**。
 *   查询失败 ≠ 没有问题，而这条校验后面就是唯一烧额度的动作。
 */
async function checkRoles(redis, def) {
  const roles = [...new Set(def.stages.map((s) => s.role).filter(Boolean))];
  const registry = await roster.list(redis).catch(() => null);
  if (registry === null) {
    throw coded(ROSTER_UNAVAILABLE,
      '花名册查不了 —— **这不是「都在」**，是「查不出来」。',
      '别据此认为角色齐了。redis 恢复后重试；bus 的 GET /health 能看它现在的死活。');
  }
  const have = new Set(registry.map((a) => a.name));
  const missing = roles.filter((r) => !have.has(r));
  if (missing.length) {
    throw coded(ROLES_MISSING,
      `流程需要的角色不在花名册里：${missing.join(' / ')}（需要：${roles.join(' / ')}）。`,
      `起对应的 agent：node bin/agent-start.js --name ${missing[0]} --type dev。`
      + '★ 角色名就是 agent 名，中间没有映射层 —— 硬绑的话流程会卡在一个不存在的人身上，'
      + '而症状是「安静」（规格 §二·五）。'
      + `当前在册：${registry.map((a) => a.name).join(' / ') || '(空)'}`);
  }
  return roles;
}

/**
 * 绑流程。**校验 → mkdir → 写 meta，顺序是有理由的。**
 *
 * ★★ ② 在 ③ 之前，跟 advance 的「先落状态再发消息」方向相反，
 *   但理由是同一条：**让失败留下的状态是无害的那一种。**
 *   · 先写 meta 后 mkdir 失败 → 房间「绑了流程但目录不存在」，
 *     而判据的症状是「文件不在」——**跟「他还没开始写」分不开**
 *   · 先 mkdir 后写 meta 失败 → 只剩一个空目录，**无害**，
 *     而且 `recursive:true` 幂等，下次绑定照样能用
 *
 * ⚠️ **已经绑过的房间拒绝改绑**（409）。保留旧 flow_dir → 两套流程的产出混在
 *   一个目录；换新 flow_dir → **旧产出原地失联**（文件还在，没人再看它）。
 *   两条都不报错 —— 所以不猜，让人明说要迁移。
 */
/**
 * 解冻：**追加**一条版本变更，**不清掉 `frozen`**。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 清掉的话，「它变了」这个事实就消失了 —— 下游只知道「现在对得上」。
 *   追加之后，下游看到的不是「对不上」，是「**它变了，变了这些**」。
 *
 * 🔴 **`diff_note` 不带就不放行。**
 *   一份差异说明（「新增 3 / 改 3 / 没动的那一长串」）能让下游只重读该重读的
 *   那几条，而不是全部返工 —— 这条机制把「改规格的人写清差异」变成必须做的事。
 *
 * ⚠️ 「已做的部分怎么算」**不由这个函数判**（继续 / 作废都是错的默认）——
 *   由发起解冻的人在 `diff_note` 里逐条标（例：「C/D 两组一个字没动，不返工」）。
 * ══════════════════════════════════════════════════════════════════
 *
 * @returns 新的 meta.unfrozen 数组
 * @throws  diff_note 为空 / 房间不存在 / 还没冻过
 */
async function unfreeze(redis, hash, { to_md5 = null, by = null, diff_note = '' } = {}) {
  const meta = await get(redis, hash);
  if (!meta) throw coded(ROOM_NOT_FOUND, `房间不存在: ${hash}`);
  if (!meta.frozen) {
    throw coded(FLOW_INVALID, '这个房间还没有 frozen 记录 —— 没冻过的东西解不了冻。',
      '冻结是 gate 通过那一刻写的。stage 还没推进过的话，先推进。');
  }
  if (typeof diff_note !== 'string' || !diff_note.trim()) {
    throw coded(FLOW_INVALID, '解冻必须带 `diff_note` —— 空的不放行。',
      '写清**改了什么、哪些判据变了、下游已做的哪些部分不受影响**。'
      + '★ 不带说明的解冻等于把「它变了」这个事实丢掉，下游只会看到「对不上」，'
      + '而那时它分不出是规格变了还是自己拿错了文件。');
  }
  const entry = {
    from_md5: meta.frozen.md5,
    to_md5: to_md5 || null,
    at: new Date().toISOString(),
    by: by || null,
    diff_note: diff_note.trim(),
  };
  meta.unfrozen = Array.isArray(meta.unfrozen) ? meta.unfrozen : [];
  meta.unfrozen.push(entry);
  // ★ `frozen.md5` 跟着更新到新版（下游对的是「现在 gate 认哪一份」），
  //   **而旧的 md5 留在 unfrozen 那条链里** —— 两个问题两个答案。
  if (to_md5) { meta.frozen = { ...meta.frozen, md5: to_md5, at: entry.at }; }
  await redis.set(META(hash), JSON.stringify(meta));
  return meta.unfrozen;
}

/**
 * 「手上这份，是不是 gate 认的那份？」—— **下游自己对，不问任何人。**
 *
 * ★ 这正是这套机制存在的理由：靠问人来回答这个问题，会花掉好几方好几轮
 *   「推进停住 / 推进恢复 / 独立验过」的消息，**而那些消息不推进任何工作。**
 *
 * @returns {{ ok, reason, frozen, actual_md5, changed }}
 *   `ok: true`  对得上
 *   `ok: false` + `changed`（若有 unfrozen 记录）—— **说得出「它变了，变了这些」**
 *   ⚠️ `ok: null` = **判不了**（没冻过 / 文件读不到）—— 不许当成 `true`
 */
async function frozenCheck(redis, hash, { baseDir = null } = {}) {
  const meta = await get(redis, hash);
  if (!meta) throw coded(ROOM_NOT_FOUND, `房间不存在: ${hash}`);
  const frozen = meta.frozen;
  const unfrozen = Array.isArray(meta.unfrozen) ? meta.unfrozen : [];
  if (!frozen) {
    return {
      ok: null, frozen: null, actual_md5: null, changed: unfrozen,
      reason: '这个房间没有 frozen 记录 —— **判不了**，不是「没问题」。'
            + '（老房间、或者还没有任何一格通过 gate。）',
    };
  }
  let dir = baseDir;
  if (!dir) { try { dir = flowDirFor(meta); } catch { dir = null; } }
  if (!dir) return { ok: null, frozen, actual_md5: null, changed: unfrozen, reason: '算不出产出目录 —— 判不了。' };
  const p = path.join(dir, frozen.file);
  let text = null;
  try { text = fs.readFileSync(p, 'utf8'); } catch { /* 下面报 */ }
  if (text === null) {
    return { ok: null, frozen, actual_md5: null, changed: unfrozen, reason: `读不到 ${p} —— **判不了**。` };
  }
  const actual = md5Of(text);
  if (actual === frozen.md5) {
    return { ok: true, frozen, actual_md5: actual, changed: unfrozen, reason: '对上了 —— 这就是 gate 认的那份。' };
  }
  // ★ 对不上时**先看有没有解冻记录** —— 「它被正式改过」和「拿错了文件」
  //   是两件完全不同的事，而它们的表现（md5 不等）一模一样。
  const last = unfrozen.length ? unfrozen[unfrozen.length - 1] : null;
  return {
    ok: false,
    frozen,
    actual_md5: actual,
    changed: unfrozen,
    reason: last
      ? `对不上，**而且它被正式解冻过 ${unfrozen.length} 次**。最近一次（${last.at}，由 ${last.by || '未署名'}）说：\n`
        + `${last.diff_note}\n`
        + `⇒ 这不是「你拿错了文件」，是「规格变了」。按上面那段只重读该重读的部分。`
      : `对不上，**而且没有任何解冻记录** —— gate 认的是 ${frozen.md5}，你手上是 ${actual}。\n`
        + '⇒ 要么它被静默改过（该有人解释），要么你读的不是 gate 认的那份。**停下来问，别自己解释。**',
  };
}

async function bindFlow(redis, hash, flowName) {
  const meta = await get(redis, hash);
  if (!meta) throw coded(ROOM_NOT_FOUND, `房间不存在: ${hash}`);
  if (meta.flow !== null) {
    throw coded(FLOW_ALREADY_BOUND,
      `这个房间已经绑了流程 "${meta.flow}"（目录 ${meta.flow_dir}）。`,
      '不支持改绑：保留旧目录会让两套流程的产出混在一起，换新目录会让旧产出原地失联 —— '
      + '两种都不报错。要换流程请新建一个房间。');
  }
  if (typeof flowName !== 'string' || !flowName) {
    throw coded(FLOW_UNKNOWN, 'flow 必须是一个非空字符串。',
      '看 protocols/flows/ 下有哪些模板，用文件名（不带 .json）。');
  }
  const def = loadFlow(flowName);
  if (!def) {
    throw coded(FLOW_UNKNOWN, `流程模板 "${flowName}" 读不到。`,
      `去看 protocols/flows/${flowName}.json：文件不在、JSON 坏了，`
      + '或者名字里有 `[A-Za-z0-9_-]` 之外的字符（那种会被直接拒绝，防路径穿越）。');
  }
  const bad = validateFlow(def);
  if (bad) {
    throw coded(FLOW_INVALID, `模板 protocols/flows/${flowName}.json 是坏的：${bad}`,
      '改模板文件本身。**不静默接受一个跑不动的流程** —— 绑上了才发现的话，'
      + '症状是房间安静地推不动。');
  }

  await checkRoles(redis, def);                        // ① 角色

  const rel = makeFlowDir(hash, meta.name);
  const abs = flowDirFor({ ...meta, flow_dir: rel });
  try { fs.mkdirSync(abs, { recursive: true }); }      // ② 目录
  catch (e) {
    throw coded(FLOW_DIR_MKDIR_FAILED, `产出目录建不出来：${abs} —— ${e.message}`,
      '检查权限/磁盘。**没建成就不绑** —— 否则判据会一直报「文件不在」，'
      + '而那跟「他还没开始写」长得一模一样。');
  }

  meta.flow = flowName;                                // ③ 状态
  meta.flow_dir = rel;
  // ★ 绑流程那一刻记下阶段名序列 —— 之后模板被改了，`flowStatus` 拿它对一遍
  //   就知道这个房间会不会被改道（见 `stageDrift`）。
  //   ⚠️ 只存**名字**，不存整份 def：def 里别的字段（produces / requires / 文案）
  //   改了不影响这个房间走哪一格，**存进来只会让「变了」这个信号变成噪音**。
  meta.flow_snapshot = { stages: def.stages.map((s) => s.name), at: new Date().toISOString() };
  await redis.set(META(hash), JSON.stringify(meta));
  return meta;
}

/**
 * 状态码翻译。★ 每种错误都带 `next`（该做什么），不只是 `error`（是什么）。
 */
function flowHttpError(err) {
  const map = {
    [ROOM_NOT_FOUND]: 404,
    [FLOW_ALREADY_BOUND]: 409,
    [ROLES_MISSING]: 409,
    [FLOW_UNKNOWN]: 400,
    [FLOW_INVALID]: 400,
    [ROSTER_UNAVAILABLE]: 503,
    [FLOW_DIR_MISSING]: 500,
    [FLOW_DIR_MKDIR_FAILED]: 500,
  };
  const status = err && map[err.code];
  if (!status) return httpError(err);   // 回落到已有的 404/503 那套
  return {
    status,
    body: {
      error: err.code,
      message: String(err.message),
      next: err.next || '（这条没写 next —— 补上它，诚实但无用的错误消息，人还是会去猜。）',
    },
  };
}

/** `POST /api/rooms` —— 老调用（只给 name/members）一个字都不用改。 */
function createHandler(redis) {
  return async (req, res) => {
    const { name, members = [], flow = null } = req.body || {};
    if (!name) {
      return res.status(400).json({ error: 'name required', next: '形如 {"name":"engloop-improve"}；flow 可选。' });
    }
    try {
      const meta = await create(redis, name);
      for (const m of members) await join(redis, meta.hash, String(m));
      // ★ 绑流程走**跟事后绑同一条路径** —— 两条路径的话，校验漏在其中一个上
      //   不会被任何测试发现。
      if (flow) await bindFlow(redis, meta.hash, String(flow));
      res.status(201).json(await get(redis, meta.hash));
    } catch (err) {
      const { status, body } = flowHttpError(err);
      res.status(status).json(body);
    }
  };
}

/** `POST /api/rooms/:hash/flow` —— 事后绑。 */
function bindFlowHandler(redis) {
  return async (req, res) => {
    const { flow = null } = req.body || {};
    try {
      const meta = await bindFlow(redis, req.params.hash, flow && String(flow));
      res.json({
        hash: meta.hash,
        name: meta.name,
        flow: meta.flow,
        flow_dir: meta.flow_dir,
        stage: meta.stage,
        // ★ 绑定 ≠ 启动。不说清的话，人绑完会等着它自己动。
        next: '绑好了，但**流程还没启动**（stage 仍是 null）。'
            + `打 POST /api/rooms/${meta.hash}/advance 走第一格 —— 那一步才会点名第一个角色。`,
      });
    } catch (err) {
      const { status, body } = flowHttpError(err);
      res.status(status).json(body);
    }
  };
}

/**
 * `GET /api/rooms/:hash/flow` —— 返回 `roomGate`（flowStatus 的超集）。
 *
 * ★ 为什么不是 flowStatus：**这个端点被打开的时刻，人心里的问题是「为什么它不动」**，
 *   而那个答案在 `gate.missing_sections / empty_sections / stale` 里。
 *   给 flowStatus 的话他还得再调一次别的才知道差什么。
 *   （代价是一次 statSync + readFileSync，值。）
 */
function flowStatusHandler(redis) {
  return async (req, res) => {
    try { res.json(await roomGate(redis, req.params.hash)); }
    catch (err) {
      const { status, body } = flowHttpError(err);
      res.status(status).json(body);
    }
  };
}

/**
 * `POST /api/rooms/:hash/advance` —— 手工触发一次推进。
 *
 * ⚠️ **`advanced:false` 返回 200，不是 4xx。** 「它还在干」是正常状态，
 *   不是请求错误 —— 做成 4xx 的话界面会把「还没写完」显示成红色故障。
 *
 * ★ 响应里带 `messages`（这次真发出去的那两条），让人**看得见它发了什么**，
 *   而不是只看到一个 `advanced:true`。
 */
function advanceHandler(redis) {
  return async (req, res) => {
    try { res.json(await advance(redis, req.params.hash)); }
    catch (err) {
      const { status, body } = flowHttpError(err);
      res.status(status).json(body);
    }
  };
}

module.exports = {
  create, get, list, join, leave, post, history, stream, META, INDEX,
  // ★ `makeHash` 导出**只为测试**：它是「同名连建会不会撞」这条的唯一出处。
  //   而测试必须调它本身 —— 走 `create()` 的话中间隔着两次 redis await，
  //   **那两次 await 就够跨过一毫秒** ⇒ 只靠时间戳的实现在那条路径上只是**间歇**红，
  //   而直接连着调 50 次 makeHash，只靠时间戳的实现几乎必撞、掺随机的实现不撞。
  makeHash,
  // HTTP 层（导出给 bin/serve.js 和测试 —— 见上面那段「bin/ 测不到」）
  parseCount, historyPayload, httpError, historyHandler, membersHandler, fanOutPlan,
  // ★ `expectsReply` 必须导出：它是判据的**唯一出处**，而唯一出处的意思是
  //   别的模块要用它就得拿得到。拿不到的话它们只会各自写一个 `if`，
  //   而那正是这个函数存在的原因。
  expectsReply,
  ROOM_NOT_FOUND, COUNT_DEFAULT, COUNT_MAX,
  // ── 流程（只读那一半）──
  // ★ `withFlowDefaults` 也导出：别处如果绕开 get() 直接读了 meta
  //   （比如批量迁移脚本），它得拿得到同一个归一化，否则又会有第二个判据。
  flowStatus, loadFlow, validateFlow, withFlowDefaults,
  FLOW_STATE, STAGE_DONE, FLOW_DIR,
  // ── 阶段判据（只读）──
  // ── 推进（唯一会写状态、唯一会发消息的地方）──
  enterStage, advance,
  // ── HTTP 入口 ──
  bindFlow, checkRoles, flowHttpError,
  createHandler, bindFlowHandler, flowStatusHandler, advanceHandler,
  FLOW_ALREADY_BOUND, FLOW_UNKNOWN, FLOW_INVALID,
  ROLES_MISSING, ROSTER_UNAVAILABLE, FLOW_DIR_MKDIR_FAILED,
  stageGate, roomGate, checkSections, readVerdict, headingsOf,
  // ── 规格冻结 ──────────────────────────────
  // ★ `stageDrift` 必须是纯函数且导出：「把 survey 插在中间必须被检出」这条
  //   正控全靠能直接喂数据给它 —— 端到端跑一遍只能验「这一次」，
  //   喂数据能验「这一类」。
  stageDrift, md5Of, unfreeze, frozenCheck,
  safeProduces, toMs, flowDirFor, makeFlowDir, slugify,
  DOCS_FLOWS, FLOWS_REL, REPO_ROOT, FLOW_DIR_MISSING,
};
