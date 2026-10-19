'use strict';

/**
 * emoji 反应 → 触发动作。
 *
 * 对一条消息点一个 emoji，agent 读到之后执行对应动作。
 * 这个文件是**语义表 + 判定 + 存储**的唯一出处；`bin/serve.js` 只挂路由。
 *
 * ── 为什么整个判定在 lib/ 而不在 bin/serve.js 的路由回调里 ──────────────
 * 跟 `rooms.historyHandler` 头上那段（lib/rooms.js）是同一条理由：
 * **bin/ 的入口脚本没法被测试 require —— 一 require 就起服务占端口。**
 * 而一段测试看不见的判定，就是一段没有守卫的判定。
 *
 * ── 为什么不往房间流里 XADD 一条反应 ──────────────────────────────────
 * 反应会被取消、会变；房间流是 append-only 的历史真相。
 * 把可变状态写进不可变的流里，「取消」就只能表达成「再追加一条否定它的记录」，
 * 于是**读的人必须重放整条流才知道现在有几个 👍** —— 而重放逻辑一旦有两份
 * （前端一份、agent 一份），两边的计数会各自漂移，**而漂移没有任何报错**。
 * ⇒ 反应是旁路数据，独立 key，跟历史分开。
 */

const crypto = require('node:crypto');

// ══════════════════════════════════════════════════════════════════════
//  存储 key
// ══════════════════════════════════════════════════════════════════════
//
// 命名法参 `lib/rooms.js` 的 META/INDEX。
//
// ★★ **锚点种类（scope）编进 key，不是可选的。**
//
//   房间消息的锚点是 `room_msg_id`（房间流的 stream id），
//   私聊的锚点是 `dm_msg_id`（= job_id，UUID）。
//   `bin/next.js` 保证这两个字段**互斥出现** —— agent 手上永远只有一个。
//
//   ⇒ 「这是哪一种锚点」这个信息在**调用点一定拿得到**。
//     拿得到还不存进 key，等于故意把它扔掉，然后祈祷两个 id 空间不会撞。
//
//   ⚠️ 撞了的症状：**一条消息上冒出别人的反应，而且不报错。**
//     stream id 是 `<毫秒>-<序号>`、job_id 是 UUID，眼下确实不会撞 ——
//     但那是两个格式各自的**当前**长相，不是任何东西在守的约束。
//     key 里带上 scope 之后，这件事从「不会撞」变成「撞不了」。

const KEY = (scope, anchor) => `engloop:react:${scope}:${anchor}`;

/** 一条待确认动作（C 档两段式的第一段落在这里）。 */
const PENDING = (id) => `engloop:react:pending:${id}`;
/** 待确认动作的索引。ZSET，score = 创建毫秒 —— 界面要按时间倒序列出来。 */
const PENDING_INDEX = 'engloop:react:pendings';

/** 合法的锚点种类。**只有这两个** —— 见上面那段。 */
const SCOPES = ['room', 'dm'];

const BAD_SCOPE = 'BAD_SCOPE';
const BAD_INPUT = 'BAD_INPUT';
const PENDING_NOT_FOUND = 'PENDING_NOT_FOUND';
const PENDING_SETTLED = 'PENDING_SETTLED';

// ══════════════════════════════════════════════════════════════════════
//  语义表 —— emoji → 动作
// ══════════════════════════════════════════════════════════════════════
//
// ★★★ **这是唯一出处。** HTTP 把它吐给前端渲染，`bin/next.js` 把它投给 agent。
//   三边都从这一个常量派生，**不许任何一边自己再写一份** ——
//   两份表会各自漂移，而漂移的表现是「界面上写着 ✅ 是验收，agent 却当成别的」，
//   零报错。（`web/threads.js` 头上讲的是同一个形状。）
//
// ── 分档判据（进 B 档要三条全中，缺一条就归 C）────────────────────────
//
//   ① 产物是**追加的、可撤的、看得见的**
//   ② **不消耗 Patrick 的额度** —— 或者消耗了就在界面上明写（`costs_quota`）
//   ③ 误点的代价 ≤ 多一条消息
//
//   ⚠️ 判据 ② 管的是「钱」这一维：🔁 进 C 档的理由之一是「会消耗额度」，
//     而 ❓（让 agent 展开解释）**同样要那个 agent 真跑一轮，同样花钱**。
//     没有 ② 的话，一张表里就用了两把尺子。
//     ⇒ ❓ 留 B 档，但**必须明写它花钱**。
//
//   ★ 所以这三行判据写在这里、写在表的正上方 ——
//     下一个往表里加 emoji 的人得**看得见尺子**，否则他会临时造一把。
//
// ── `costs_quota` 为什么是数据不是注释 ──────────────────────────────────
//   注释只活在读代码的人眼里，**而点按钮的人永远看不见它**。
//   这个字段要一路吐到界面上：点之前就知道自己在花钱。
//   写成注释 = 这条要求等于没做。

const TIERS = {
  A: { effect: 'none',      desc: '表态型 —— 不触发任何动作' },
  B: { effect: 'immediate', desc: '动作型 —— 一点就执行，动作只增不减' },
  C: { effect: 'confirm',   desc: '破坏性 —— 只产生待确认动作，确认了才执行' },
};

const SEMANTICS = {
  // ── A 档 · 表态型 ───────────────────────────────────────────────
  '👍': { tier: 'A', action: null, costs_quota: false, label: '认可',
          hint: '只计数、只显示，不触发任何动作。' },
  '👀': { tier: 'A', action: null, costs_quota: false, label: '我看到了',
          hint: '「已读但还没回」这个状态本来在界面上不可见 —— 这个 emoji 就是让它可见。' },
  '🔥': { tier: 'A', action: null, costs_quota: false, label: '这条重要',
          hint: '只是标记，不改任何优先级 —— 改了就不是 A 档了。' },
  // ★★ **系统自己会打的那一个** —— agent 报告任务完成时，relay 把它打在
  //   那条 thread 的根上（`by: 'system'`）。人也可以自己点，语义一样。
  //
  //   ── 为什么不是 ✅ ──────────────────────────────────────────────────
  //   ✅ 已经占了位，而且是 **B 档**：语义是「Patrick 看过并认可了」，
  //   会触发 `mark_verified` 并回执给发送者。让系统自动往上打 ✅ 的话：
  //
  //     ① 每条完成报告都会自动触发一次 mark_verified 回执 —— 那是**动作**，
  //        而 A 档和 B 档的分界线就是「有没有动作」。系统替人点 B 档，
  //        等于把那条分界线抹掉了。
  //     ② 更要命的是界面上：「机器说它干完了」和「人验收过了」会变成
  //        **同一个符号**。而这两件事一个是待办、一个是已办 ——
  //        **它们的区别正是这个标记存在的全部理由。**
  //
  //   ⇒ 🏁 只陈述事实（这条 thread 里有 agent 报了完成），不表态、不触发动作。
  //     ✅ 留给 Patrick 自己点。两个都在 = 「它说完了，我也认了」；
  //     只有 🏁 = 「等你看」。
  '🏁': { tier: 'A', action: null, costs_quota: false, label: '任务完成',
          hint: 'agent 报完成时系统自动打在 thread 根上（by: system）。纯标记，不触发动作 —— 验收请点 ✅。' },
  // ★★ 独立核验的两个中间态（`lib/done-verify.js`）。都是系统打的、都是 A 档纯标记。
  //   ⚠️ 打回**不用 🔁**：🔁 在下面 C 档是「重跑」—— 系统打它会给 Patrick 的确认队列塞一条
  //     「重跑（花额度）」的待确认动作，把「核验没过」说成了「请你批一次重跑」。
  '⏳': { tier: 'A', action: null, costs_quota: false, label: '核验中',
          hint: 'agent 报了完成、带了 evidence，独立核验正在跑（by: system）。核完换成 🏁 或 🔙。' },
  '🔙': { tier: 'A', action: null, costs_quota: false, label: '核验没过 · 已打回',
          hint: '独立核验没过，系统已经把没过的项打回给那个 agent（by: system）。同一件活第 3 次没过会转给编排者。' },

  // ── B 档 · 动作型（三条判据全中）─────────────────────────────────
  '✅': { tier: 'B', action: 'mark_verified', costs_quota: false, label: '验收通过',
          hint: '给这条打「已验收」标记并回执给发送者。只加标记，不删不改任何东西。' },
  '📌': { tier: 'B', action: 'pin_to_summary', costs_quota: false, label: '记进会话摘要',
          hint: '把这条追加进那个 agent 的会话摘要。纯追加。' },
  // ★ 这一条就是判据 ② 的实例：它满足 ①③，但**花钱**，所以必须明写。
  '❓': { tier: 'B', action: 'explain', costs_quota: true, label: '展开解释',
          hint: '让发这条的 agent 展开解释一次。⚠️ 会触发一次 agent 调用（花额度）。' },

  // ── C 档 · 破坏性 —— 两段式，绝不一点就执行 ──────────────────────
  //
  // ⚠️ 这一档的全部价值是**它的分量**。往这里塞一个其实无害的 emoji，
  //   人会开始习惯性地点「确认」—— 那时两段式就退化成一段点了两次。
  '❌': { tier: 'C', action: 'undo', costs_quota: false, label: '撤销 / 否决',
          hint: '撤销这条对应的动作。撤销本身可能不可逆 —— 所以要确认。' },
  '🛑': { tier: 'C', action: 'stop_agent', costs_quota: false, label: '让它停下',
          hint: '停掉那个 agent。它手上的上下文会一起丢掉 —— 所以要确认。' },
  '🔁': { tier: 'C', action: 'rerun', costs_quota: true, label: '重跑',
          hint: '重跑这个任务。⚠️ 消耗额度，而且可能覆盖已有产物 —— 所以要确认。' },
};

// ══════════════════════════════════════════════════════════════════════
//  判定
// ══════════════════════════════════════════════════════════════════════

/**
 * emoji 的规范化形式。**存之前、查表之前都过这里 —— 一处出处。**
 *
 * ── 为什么必须有它（两个后果，第二个更狠）─────────────────────────────
 *
 *   同一个 emoji 有不止一种码点写法，最常见的是带不带**变体选择符**
 *   U+FE0F（`👍` vs `👍️`）。前端在不同路径上送来的可能不一样。
 *
 *   ① **幂等破**：同一个人点两次落成两个不同的 field ⇒ 计数变 2。
 *   ② ★★ **更狠的那个**：`classify()` 把带 VS16 的那个判成「未知 emoji」
 *      ⇒ **一个表里明明有的动作，因为多了一个隐形码点而不触发**，
 *      而界面上那个 emoji 还老老实实显示着。
 *      **全绿、没报错、动作没发生** ——「动作静默地去了别处」。
 *
 * ⚠️ **两个调用点必须用同一个函数**：只规范化存储那侧，查表那侧照样判成未知；
 *   只规范化查表那侧，同一个人的两次点击照样落成两条。
 *   分成两份实现的话，它们会各自漂移，而漂移的表现就是上面那两条。
 *
 * ⚠️ NFC 在前、剥 VS16 在后：NFC 不会消掉 VS16（它不是组合记号），
 *   顺序反过来结果一样 —— 但写死一个顺序，省得下一个人去想它到底要不要紧。
 */
// ★ 正则里写 `\uFE0E` `\uFE0F` 这样的转义，不要把字符本身贴进去 —— 它们**不可见**，
//   贴进源码之后这一行看起来像 `/[]/`，下一个人会以为是个空字符类删掉它。
const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/g;

function normalizeEmoji(raw) {
  return String(raw == null ? '' : raw).normalize('NFC').replace(VARIATION_SELECTORS, '');
}

/**
 * 查表用的索引 —— 键是**规范化之后**的。
 *
 * ★ 连 `SEMANTICS` 自己的键也过一遍规范化：表是人手写的，
 *   下一个加 emoji 的人很可能从某个网页复制一个带 VS16 的字符进来。
 *   那时表里那一条会**永远查不中**，而代码看起来完全正常。
 */
const SEMANTICS_INDEX = new Map(
  Object.entries(SEMANTICS).map(([k, v]) => [normalizeEmoji(k), v]),
);

/**
 * 未知 emoji 的分类结果。
 *
 * ★★ **存下来、显示出来、不触发任何动作，并且让点它的人看得见「没绑动作」。**
 *
 *   静默吞掉的话，人点完看到那个 emoji 出现在消息上，**会以为动作执行了** ——
 *   而实际上什么都没发生。那正是这个仓库最反对的形状：
 *   一个动作静默地去了别处，所有信号都是绿的。
 *
 * ⚠️ 注意它 `known: false` 但**不是错误**：加反应这个动作本身成功了。
 *   返回 4xx 是另一种静默 —— 界面会把它当成「加失败了」而不显示，
 *   于是这个 emoji 从此不存在，**人连「我点过一个没绑动作的 emoji」都不知道**。
 */
function unknownOf(emoji) {
  return {
    emoji,
    known: false,
    tier: null,
    action: null,
    effect: 'none',
    costs_quota: false,
    label: '未绑定动作',
    hint: '这个 emoji 没有绑定任何动作 —— 它被记下来了，但不会触发任何事。',
    notice: '这个 emoji 没绑动作',
  };
}

/**
 * emoji → 它是什么、会做什么。**纯函数，不碰 redis。**
 *
 * 返回值一定非空 —— 未知 emoji 走 `unknownOf`，不返回 null。
 * ⚠️ 返回 null 的话，每一个调用方都得记得判空，而**漏判的表现是崩在渲染里**，
 *   一条消息的反应条整个消失。让它总是返回一个结构完整的对象，调用方无从漏判。
 */
function classify(emoji) {
  // ★★ 查表**必须**走规范化 —— 而且必须走 `SEMANTICS_INDEX`，不是 `SEMANTICS`。
  //   直查原表的话，带 VS16 的 `👍️` 判成未知：表里明明有这一条，
  //   动作却不触发，界面上那个 emoji 还照常显示着。
  //
  //   ⚠️ 规范化函数和索引都在、而这一行直查原表的话，`normalizeEmoji`
  //     就是一段没有调用方的死代码，而它看起来完全像已经修好了。
  //     「函数支持」和「调用方真的用了」是两件事（`lib/relay.js` 里同一条）。
  const e = normalizeEmoji(emoji);
  const s = SEMANTICS_INDEX.get(e);
  if (!s) return unknownOf(e);
  return {
    // ★ 返回**规范化之后**的形式：它就是存储里用的那个，
    //   两边不一致的话，前端拿 classify 的结果去比对存储里的 emoji 会对不上。
    emoji: e,
    known: true,
    tier: s.tier,
    action: s.action,
    effect: TIERS[s.tier].effect,
    costs_quota: s.costs_quota,
    label: s.label,
    hint: s.hint,
  };
}

/**
 * 语义表的对外形态 —— HTTP 吐给前端、`bin/next.js` 投给 agent 的都是它。
 *
 * ★ 由 `SEMANTICS` 派生，不是另抄一份。加一个 emoji 只改上面那个常量。
 */
function semanticsPayload() {
  return {
    tiers: TIERS,
    emojis: Object.keys(SEMANTICS).map((e) => classify(e)),
    // ★ 判据跟着表一起吐出去 —— 界面上要能看到「为什么这个要确认那个不要」。
    //   人不知道判据的话，两段式在他眼里就只是「有时候要多点一下」。
    tier_rules: [
      '① 产物是追加的、可撤的、看得见的',
      '② 不消耗额度 —— 或者消耗了就明写（costs_quota）',
      '③ 误点的代价 ≤ 多一条消息',
    ],
    // ★★ 确认走按钮，不走 emoji。理由必须跟着吐出去，否则下一个人会「顺手」
    //   给确认也绑一个 emoji，而那一步会静默地把两段式拆掉。
    confirm_ui: 'button',
    confirm_note: 'C 档的确认用界面按钮，**不用 emoji** —— '
      + 'emoji 之所以需要两段式，前提就是它是个极易误点的通道；'
      + '拿同一个易误点的通道去确认它自己，两道关会被同时误点，'
      + '那不是两段，是一段点了两次。',
  };
}

// ══════════════════════════════════════════════════════════════════════
//  存储
// ══════════════════════════════════════════════════════════════════════

function assertScope(scope) {
  if (!SCOPES.includes(scope)) {
    const err = new Error(`scope 必须是 ${SCOPES.join(' / ')}，收到: ${JSON.stringify(scope)}`);
    err.code = BAD_SCOPE;
    throw err;
  }
}

function assertNonEmpty(name, v) {
  if (typeof v !== 'string' || !v.trim()) {
    const err = new Error(`${name} 必须是非空字符串，收到: ${JSON.stringify(v)}`);
    err.code = BAD_INPUT;
    throw err;
  }
}

/**
 * 一条反应在 HASH 里的 field。
 *
 * ★ `JSON.stringify([emoji, by])` 而不是 `emoji + 某个分隔符 + by`。
 *   拼接键要挑一个「两边正文里都不会出现」的分隔符，而**那个前提没有任何
 *   东西在守** —— emoji 是任意 unicode、用户名是人取的。
 *   JSON 自己处理转义，无歧义。（`web/app.js` 里是同一条；用 NUL 当分隔符
 *   还会让整个文件被当成二进制。）
 *
 * ⚠️ 一个人对同一条消息点同一个 emoji 两次 = 同一个 field = HSET 覆盖。
 *   **幂等是设计出来的，不是碰巧** —— 重复点击、重发请求、前端重试，
 *   三条路径都指望它。用「emoji → 用户数组」那种结构的话，这三条路径
 *   每一条都能把同一个人塞进数组两次，而计数会悄悄多一个。
 */
// ★★ emoji 在这里过 `normalizeEmoji` —— 跟 `classify()` **同一个函数**。
//   只规范化查表那侧的话，同一个人的两次点击照样落成两个 field（幂等破）；
//   只规范化存储这侧的话，查表照样判成未知（动作不触发）。
//   两侧共用一个函数，这两种漂移都不可能发生。
const fieldOf = (emoji, by) => JSON.stringify([normalizeEmoji(emoji), by]);

function parseField(f) {
  try {
    const [emoji, by] = JSON.parse(f);
    if (typeof emoji === 'string' && typeof by === 'string') return { emoji, by };
  } catch { /* 落到下面 */ }
  // ⚠️ 解析不了的 field **不丢弃**，报成一条可见的坏数据。
  //   丢弃的话，界面上少一个反应，而没有任何人知道少了。
  return null;
}

/**
 * 加一个反应。
 *
 * 返回 `{ ok, scope, anchor, emoji, by, at, semantic, pending }`：
 * · `semantic` 是 `classify()` 的结果 —— 调用方据此知道触发了什么、花不花钱。
 * · `pending` 只在 C 档出现：那条待确认动作的记录。
 *
 * ★★ **C 档在这里只落一条 pending，绝不执行动作。**
 *   误点必须**当场可见**，而不是当场生效。
 */
async function add(redis, { scope, anchor, emoji, by, at = null }) {
  assertScope(scope);
  assertNonEmpty('anchor', anchor);
  assertNonEmpty('emoji', emoji);
  assertNonEmpty('by', by);

  const ts = at || Date.now();
  await redis.hset(KEY(scope, anchor), fieldOf(emoji, by), String(ts));

  const semantic = classify(emoji);
  let pending = null;
  if (semantic.effect === 'confirm') {
    pending = await createPending(redis, { scope, anchor, emoji, by, at: ts, semantic });
  }
  return { ok: true, scope, anchor, emoji, by, at: ts, semantic, pending };
}

/**
 * 取消一个反应。
 *
 * ⚠️ **只删这个人自己那一条**（field 里带着 by）。
 *   删整个 emoji 的话，一个人的取消会把别人的反应一起抹掉 —— 而被抹掉的人
 *   什么提示都不会收到，他只会在某次刷新之后发现自己点的东西没了。
 *
 * ★ 返回 `removed: false` 而不是报错：取消一个本来就不存在的反应是**无害且
 *   常见**的（重复点击、两个标签页）。报错会让界面弹一个没有意义的红。
 *   但也**不谎报成功** —— 调用方拿得到真实结果。
 *
 * ★★ 已经产生的 pending **不跟着撤销**。取消反应 ≠ 撤销那条待确认动作：
 *   pending 有自己的生命周期和自己的撤销入口（`cancelPending`），
 *   而且它必须留痕。悄悄跟着消失的话，人会以为「我把 emoji 取消了，那件事
 *   就没发生过」—— **而它其实已经在待确认列表里躺着了。**
 */
async function remove(redis, { scope, anchor, emoji, by }) {
  assertScope(scope);
  assertNonEmpty('anchor', anchor);
  assertNonEmpty('emoji', emoji);
  assertNonEmpty('by', by);

  const n = await redis.hdel(KEY(scope, anchor), fieldOf(emoji, by));
  const e = normalizeEmoji(emoji);

  // ★★★ 判据留住了，还得**当场把真相说出来**。
  //
  //   上面那段说「已经产生的 pending 不跟着撤销」，那是对的。
  //   **但人的心智模型是「取消 = 没发生过」**。判据对、而人的模型不同，
  //   差额就落在人身上：他以为撤干净了，那条待确认动作还在列表里等着被谁确认。
  //
  //   ⇒ 所以取消一个曾经生成过 pending 的反应时，把「那边还有一条」
  //     一起返回，前端显示它：**不是消除它，是让它当场可见。**
  //
  // ⚠️ 只查 open 的：已确认/已撤销的那些不需要人再去处理，
  //   报出来只会让这条提示变成噪音，而噪音多了人就不看提示了。
  const open = await listPending(redis, { limit: 200 });
  const stillOpen = open.filter((p) => p.scope === scope
    && p.anchor === anchor
    && p.by === by
    && normalizeEmoji(p.emoji) === e);

  return {
    ok: true,
    removed: n > 0,
    scope, anchor, emoji: e, by,
    // 空数组而不是 undefined：调用方无从漏判（跟 classify 永不返回 null 同理）
    pending_still_open: stillOpen,
    notice: stillOpen.length
      ? `这条反应取消了，但它生成的待确认动作还在（${stillOpen.length} 条）——`
        + '要撤那个动作得去待确认列表里撤。'
      : null,
  };
}

/**
 * 读一条消息上的全部反应，按 emoji 聚合。
 *
 * 返回 `{ scope, anchor, reactions: [...], malformed: [...] }`。
 * 每个 reaction 带着 `classify()` 的全部字段 —— 前端不需要（也不许）
 * 自己再查一次语义表。
 */
async function list(redis, scope, anchor) {
  assertScope(scope);
  assertNonEmpty('anchor', anchor);

  const h = await redis.hgetall(KEY(scope, anchor));
  const byEmoji = new Map();
  const malformed = [];

  for (const [f, ts] of Object.entries(h || {})) {
    const p = parseField(f);
    if (!p) { malformed.push(f); continue; }
    if (!byEmoji.has(p.emoji)) byEmoji.set(p.emoji, []);
    byEmoji.get(p.emoji).push({ by: p.by, at: Number(ts) || null });
  }

  const reactions = [...byEmoji.entries()].map(([emoji, users]) => ({
    ...classify(emoji),
    count: users.length,
    // 谁点的要按时间排 —— 界面上「谁先点的」是有意义的信息
    users: users.sort((a, b) => (a.at || 0) - (b.at || 0)),
  }));
  // 已知的排前面、未知的沉底；同组按人数多的在前。
  reactions.sort((a, b) => (Number(b.known) - Number(a.known)) || (b.count - a.count));

  return { scope, anchor, reactions, malformed };
}

/**
 * 批量读 —— 拉历史时一次把整屏消息的反应带出来。
 *
 * ★ 不做成「前端逐条打一次 HTTP」：一屏 50 条就是 50 个请求，
 *   而 bus 卡住等于所有 agent 的 relay 一起停（`lib/rooms.js` 同理）。
 */
async function listMany(redis, scope, anchors) {
  assertScope(scope);
  const out = {};
  for (const a of anchors || []) {
    if (typeof a !== 'string' || !a) continue;
    const r = await list(redis, scope, a);
    // ★ 只放**有反应**的：空对象一路传到前端，等于让它给每条消息都渲染一个
    //   空反应条。没有反应的消息在界面上应该跟改动之前一模一样。
    if (r.reactions.length) out[a] = r.reactions;
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
//  待确认动作（C 档的第一段）
// ══════════════════════════════════════════════════════════════════════

const PENDING_OPEN = 'pending';
const PENDING_CONFIRMED = 'confirmed';
const PENDING_CANCELLED = 'cancelled';

async function createPending(redis, { scope, anchor, emoji, by, at, semantic }) {
  const rec = {
    id: crypto.randomUUID(),
    status: PENDING_OPEN,
    scope, anchor, emoji, by, at,
    action: semantic.action,
    label: semantic.label,
    costs_quota: semantic.costs_quota,
    hint: semantic.hint,
    resolved_at: null,
    resolved_by: null,
  };
  await redis.set(PENDING(rec.id), JSON.stringify(rec));
  await redis.zadd(PENDING_INDEX, at, rec.id);
  return rec;
}

/**
 * ⚠️ **不设 TTL，也不删记录。**
 *
 *   一条悄悄过期的待确认动作 = 静默消失：人点了 🛑，界面上出现「待确认」，
 *   他去忙别的，回来发现它不见了 —— **而「已执行」和「过期消失」在界面上
 *   长得一模一样**。留着它、并且把状态写在脸上，才答得出「那件事到底做没做」。
 *
 * ★ 取消也只改状态不删记录 —— 误销的修法不是消除它，是让它当场可见。
 *   撤销过什么本身就是要留痕的事实。
 */
async function getPending(redis, id) {
  const raw = await redis.get(PENDING(id));
  if (!raw) {
    const err = new Error(`待确认动作不存在: ${id}`);
    err.code = PENDING_NOT_FOUND;
    throw err;
  }
  return JSON.parse(raw);
}

async function settlePending(redis, id, status, byWho) {
  // ★★ `by` **必填**。
  //
  //   可选的话，一条没带 body 的撤回会存 `resolved_by: null` —— 不报错。
  //   后果：**一条查不到是谁撤的撤回记录**，而这条记录存在的全部理由
  //   就是留痕。
  //   ⇒ 没有署名的留痕，事后等于没记，**而它长得跟一条完整记录一模一样**。
  //
  // ── 跟「未知 emoji 走 200」是同一条判据的两面 ──────────────────────
  //   ```
  //   未知 emoji 缺席动作 → 200  缺席是一个**真实且合法的状态**（人确实
  //                              点了个没绑动作的 emoji）→ 如实呈现
  //   by 缺席            → 400  撤回这个动作**必然有人做** ⇒ 缺席不是状态,
  //                              是一条**丢失的事实** → 必须拦
  //   ```
  //   **判据不是「缺席要不要报错」，是「缺席代表一个真实状态，
  //   还是代表一个丢失的事实」。**
  //
  // ⚠️ 校验排在 `getPending` **之前**：跟 `add()` 的顺序一致（先验输入再碰存储），
  //   而且一个没带 by 的请求本来就不该产生任何一次 redis 往返。
  assertNonEmpty('by', byWho);
  const rec = await getPending(redis, id);
  // ★ 已经结过账的**不许再结一次**，而且要说清它现在是什么状态。
  //   静默覆盖的话，一条已经取消的动作会被第二次点击改成「已确认」并执行 ——
  //   而点的人以为自己只是重复点了一下。
  if (rec.status !== PENDING_OPEN) {
    const err = new Error(`这条待确认动作已经是「${rec.status}」，不能再改`);
    err.code = PENDING_SETTLED;
    err.record = rec;
    throw err;
  }
  rec.status = status;
  rec.resolved_at = Date.now();
  // ★ 不写 `|| null` —— 上面已经保证它是非空字符串。留着那个回落的话，
  //   校验一旦被绕过（比如有人加了个新的调用路径），它会**悄悄存回 null**，
  //   于是这道校验变成一段看起来生效、实际有后门的代码。
  //
  // ★★★ 一般判据（管的远不止这一行）：
  //
  //   > **校验和回落同时存在时，回落就是那条校验的后门。**
  //
  //   两者表达的是**互相矛盾**的意图：校验说「这个值必须有」，
  //   回落说「没有也行，我给你补一个」。它们同时存在时，代码里就有了
  //   两条对同一件事的规定，而**执行的永远是后到的那条**。
  //
  //   ⚠️ 危险在于它不会报错，而且**看起来像防御性编程**：
  //     校验在、回落也在，读代码的人两样都看见了，会觉得这里格外稳。
  //     实际上只要有任何一条路径绕过校验（新调用方、重构、参数改名），
  //     回落会**安静地把那个被禁止的状态存进去** —— 而校验的全部目的
  //     就是不让那个状态存在。
  //
  //   ⇒ 决定了要校验，就**删掉回落**；决定了要回落，就别假装在校验。
  rec.resolved_by = byWho;
  await redis.set(PENDING(rec.id), JSON.stringify(rec));
  return rec;
}

const confirmPending = (redis, id, by) => settlePending(redis, id, PENDING_CONFIRMED, by);
const cancelPending = (redis, id, by) => settlePending(redis, id, PENDING_CANCELLED, by);

/**
 * 列出待确认动作。默认**只列还没结账的** —— 那是界面上要人处理的东西。
 * `all: true` 连已确认/已取消一起列（留痕看得见）。
 */
async function listPending(redis, { all = false, limit = 50 } = {}) {
  const ids = await redis.zrevrange(PENDING_INDEX, 0, Math.max(0, limit - 1));
  const out = [];
  for (const id of ids) {
    const raw = await redis.get(PENDING(id));
    if (!raw) continue;   // 索引里有、记录没了 —— 跳过，不崩
    const rec = JSON.parse(raw);
    if (all || rec.status === PENDING_OPEN) out.push(rec);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
//  HTTP handler —— `bin/serve.js` 只有挂载行
// ══════════════════════════════════════════════════════════════════════
//
// 理由见文件头：bin/ 的入口脚本测试 require 不了（一 require 就起服务占端口），
// 而这几个端点的价值**全在状态码上** —— 「非法 scope 是 400 不是 500」这种事
// 只有真走一遍 HTTP 才验得到，lib 层最多能断言「抛了个带 code 的错」。

/**
 * 错误 → 状态码。
 *
 * ★ 每一条都带 `next` —— 告诉拿到这个错的人**下一步该干什么**。
 *   （`lib/rooms.js` 的惯例。一个只说「失败了」的响应，
 *   会让人去猜；而猜错的方向通常是「重试一次试试」。）
 */
function httpError(err) {
  const code = err && err.code;
  if (code === BAD_SCOPE) {
    return { status: 400, body: {
      error: BAD_SCOPE,
      message: String(err.message),
      next: `scope 只能是 ${SCOPES.join(' / ')}：房间消息用 room（锚点是 room_msg_id），`
          + '私聊用 dm（锚点是 dm_msg_id）。这两个字段互斥出现，手上有哪个就用哪个。',
    } };
  }
  if (code === BAD_INPUT) {
    return { status: 400, body: {
      error: BAD_INPUT, message: String(err.message),
      next: '形如 {"emoji":"👍","by":"Patrick"}，两个都不能是空串。',
    } };
  }
  if (code === PENDING_NOT_FOUND) {
    return { status: 404, body: {
      error: PENDING_NOT_FOUND, message: String(err.message),
      next: 'GET /api/reactions/pending 看现在还有哪些没结账的；'
          + '也可能它已经被别人确认或撤回了 —— 那种情况下它还在，只是不在默认列表里'
          + '（带 ?all=1 能看到）。',
    } };
  }
  if (code === PENDING_SETTLED) {
    // ★ 409 而不是 400：请求本身没毛病，是**状态**不允许。
    //   而且把当前记录一起返回 —— 人要知道的是「它现在到底是什么」，
    //   不是「你失败了」。
    return { status: 409, body: {
      error: PENDING_SETTLED, message: String(err.message),
      record: err.record || null,
      next: '这条动作已经结过账了（confirmed / cancelled）。它没有丢，'
          + '带 ?all=1 查得到是谁在什么时候结的。',
    } };
  }
  return { status: 503, body: {
    error: 'QUEUE_UNAVAILABLE',
    message: String((err && err.message) || err),
    // ★ 跟 rooms.js 同一条：**「查不了」不是「没有」**。
    next: '这不是「这条消息没有反应」，是「读不到」—— 别据此下结论。'
        + 'redis 恢复后重试即可；bus 的 GET /health 能看它现在的死活。',
  } };
}

const send = (res, status, body) => res.status(status).json(body);
const fail = (res, err) => { const { status, body } = httpError(err); send(res, status, body); };

/** `GET /api/reactions/semantics` —— 语义表。前端渲染反应条要它。 */
function semanticsHandler() {
  return (_req, res) => send(res, 200, semanticsPayload());
}

/** `GET /api/reactions/:scope/:anchor` */
function listHandler(redis) {
  return async (req, res) => {
    try {
      send(res, 200, await list(redis, req.params.scope, req.params.anchor));
    } catch (err) { fail(res, err); }
  };
}

/**
 * `POST /api/reactions/:scope/:anchor` —— body `{ emoji, by }`。
 *
 * ★ 未知 emoji 走 **200**，不是 4xx（见 `unknownOf` 头上那段）：
 *   加反应这个动作本身成功了。4xx 会让界面当成「加失败了」而不显示它，
 *   于是人连「我点过一个没绑动作的 emoji」都不知道 —— 又一种静默。
 */
function addHandler(redis) {
  return async (req, res) => {
    try {
      const { emoji, by } = req.body || {};
      send(res, 200, await add(redis, {
        scope: req.params.scope, anchor: req.params.anchor, emoji, by,
      }));
    } catch (err) { fail(res, err); }
  };
}

/** `DELETE /api/reactions/:scope/:anchor` —— body `{ emoji, by }`。 */
function removeHandler(redis) {
  return async (req, res) => {
    try {
      const { emoji, by } = req.body || {};
      send(res, 200, await remove(redis, {
        scope: req.params.scope, anchor: req.params.anchor, emoji, by,
      }));
    } catch (err) { fail(res, err); }
  };
}

/**
 * `POST /api/reactions/batch` —— body `{ scope, anchors: [...] }`。
 *
 * 界面刷一屏消息要一次拿到全部反应。**不让前端逐条打一次** ——
 * 一屏 50 条就是 50 个请求，而 bus 卡住等于所有 agent 的 relay 一起停
 * （`lib/rooms.js` 是同一条理由）。
 *
 * ★★ **路径是单段 `/batch`，不是 `/:scope/batch`。**
 *   后者跟 `/api/reactions/:scope/:anchor` 是同一个形状（两段），
 *   要靠**注册顺序**才不打架 —— 而顺序是一种没有任何东西在守的约定：
 *   下一个人把路由重排一下（或者按字母排序整理一遍），
 *   `batch` 就会被当成一个 anchor 吞掉，**症状是「反应条整屏空白」，零报错**。
 *   单段路径从形状上就撞不了，不需要任何人记得顺序。
 *
 * ⚠️ `anchors` 有上限：没有上限的话，一个请求就能让 bus 打几万次 redis。
 *   跟 `rooms.parseCount` 的 `COUNT_MAX` 同一条理由。
 */
const BATCH_MAX = 500;

function batchHandler(redis) {
  return async (req, res) => {
    try {
      const { scope, anchors } = req.body || {};
      if (!Array.isArray(anchors)) {
        return send(res, 400, {
          error: BAD_INPUT,
          message: 'anchors 必须是数组',
          next: '形如 {"scope":"room","anchors":["1786…-0","1786…-1"]}',
        });
      }
      // ★ 超限**截断 + 在响应里说清截了**，不是静默丢也不是报 400：
      //   报 400 会让整屏反应都显示不出来（一个太长的请求害掉全部）；
      //   静默截断则是「界面上少了几条反应而没人知道」。
      const capped = anchors.slice(0, BATCH_MAX);
      send(res, 200, {
        scope,
        reactions: await listMany(redis, scope, capped),
        truncated: anchors.length > BATCH_MAX ? { asked: anchors.length, used: capped.length } : null,
      });
    } catch (err) { fail(res, err); }
  };
}

/** `GET /api/reactions/pending` —— `?all=1` 连结过账的一起列（留痕）。 */
function listPendingHandler(redis) {
  return async (req, res) => {
    try {
      const all = req.query.all === '1' || req.query.all === 'true';
      send(res, 200, { pending: await listPending(redis, { all }), all });
    } catch (err) { fail(res, err); }
  };
}

/**
 * `POST /api/reactions/pending/:id/confirm` —— C 档两段式的**第二段**。
 *
 * ★★ 这是那条破坏性动作真正被批准的地方，而它是一个**按钮**，不是 emoji。
 *   理由跟着语义表一起吐给前端（`semanticsPayload().confirm_note`）：
 *   拿同一个易误点的通道去确认它自己，两道关会被同时误点。
 *
 * ⚠️ 这里只把状态改成 confirmed，**不执行动作本身** —— 执行是下一段
 *   （投递给 agent）的事。合起来做的话，「批准」和「执行」两件事的失败
 *   会长成同一个样子，而它们的修法完全不同。
 */
function confirmHandler(redis) {
  return async (req, res) => {
    try {
      const by = (req.body && req.body.by) || null;
      send(res, 200, { ok: true, record: await confirmPending(redis, req.params.id, by) });
    } catch (err) { fail(res, err); }
  };
}

/** `POST /api/reactions/pending/:id/cancel` —— 撤回。**改状态，不删记录。** */
function cancelHandler(redis) {
  return async (req, res) => {
    try {
      const by = (req.body && req.body.by) || null;
      send(res, 200, { ok: true, record: await cancelPending(redis, req.params.id, by) });
    } catch (err) { fail(res, err); }
  };
}

module.exports = {
  // key / 常量
  KEY, PENDING, PENDING_INDEX, SCOPES,
  BAD_SCOPE, BAD_INPUT, PENDING_NOT_FOUND, PENDING_SETTLED,
  PENDING_OPEN, PENDING_CONFIRMED, PENDING_CANCELLED,
  // 语义表（唯一出处）
  SEMANTICS, TIERS, classify, semanticsPayload,
  // 存储
  add, remove, list, listMany, fieldOf, parseField,
  // 待确认动作
  createPending, getPending, confirmPending, cancelPending, listPending,
  // 规范化（导出是为了让测试验它本身，不是给别的模块另起一份用法）
  normalizeEmoji,
  // HTTP
  httpError, semanticsHandler, listHandler, addHandler, removeHandler,
  listPendingHandler, confirmHandler, cancelHandler, batchHandler, BATCH_MAX,
};
