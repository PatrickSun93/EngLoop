'use strict';

/**
 * 「你刚发出去的那条没挂 thread」—— 把网页上的红标签，送到唯一看不到网页的人眼前。
 *
 * ── 这个模块补的是一个「设计对了、但对象错了」的洞 ─────────────────
 * `web/threads.js:128-131` 已经把判据定完了：agent 发的、既没 `reply_to`
 * 又没标 `notice` 的那条叫 `orphan`，它照常渲染但**打一个看得见的标记**，
 * 理由那行写着「**发它的 agent 才知道自己漏标了**」。
 *
 *   > 那个标记画在网页上。**而发消息的 agent 永远不会打开网页。**
 *
 * 于是「让漏标可见」这件事，恰好对唯一需要看见它的人不可见。
 * **「功能可用」和「使用者能用」是两件事**：提示画在了 agent 看不到的那一侧，
 * 网页侧再正确也没有用。
 *
 * ⇒ 把标记搬到 agent 唯一必然会读的地方：**poller 的返回值**。
 *   跟 `_unacked`（`bin/next.js`）同构 ——「上一轮少做了一步、
 *   没有任何东西会报错、只能下一轮告诉你」。
 *
 * ══════════════════════════════════════════════════════════════
 * 🚫 **这里绝不替他把父挂上，一条都不挂。**
 *
 *   「没填 `reply_to` 就自动挂到最近收到的那条」是明确不做的，
 *   它比漏填更坏，坏在同一个方向上：
 *
 *   > 每条都挂上了，网页上再也看不到红标签 ——
 *   > **看起来很整齐，只是全挂错。**
 *
 *   漏填是**可见**的错，自动兜底是**不可见**的错。这个模块只做前者的
 *   放大器。哪天有人想在这里加一个「聪明一点的默认值」：它省掉的是
 *   一次填写，换来的是从此没有任何人能发现挂错了。
 * ══════════════════════════════════════════════════════════════
 */

const fs = require('node:fs');
const path = require('node:path');

// ★ 判据不在这个文件里 —— 直接问 `web/threads.js`。它是 UMD 就是为了这个
//   （那个文件头上写着：抽出来做 UMD 双导出，好让测试 `require()` 真的执行它）。
const { kindOf } = require('../web/threads.js');
// 只用它的 `isTestProcess` —— 「这个进程是不是测试」这件事在仓库里只有一处判据，
// 它保证 `test/fixtures/` 下的脚本不会被判成生产（判错会删掉编排者的收件流）。
const q = require('./queue');

const ROOT = path.join(__dirname, '..');

/** 最多留几条。够他认出「哪几条漏了」，不是流水账。超出的不静默吞，见 `record`。 */
const KEEP = 10;

/** 预览留多少字 —— 只要够认出是哪一条。截断必须带省略号，理由见 `previewOf`。 */
const PREVIEW = 40;

/** 保留区留多少条。够翻回去查一次「那批告警到底是什么」就行，不是归档。 */
const SETTLED_KEEP = 30;

/**
 * 状态文件放哪。
 *
 * ⚠️ 这里跟 `lib/waiting.js:38-41` 有一处**故意的不同**，别改回去对齐：
 *   那边的 `ENGLOOP_WAITING_STATE` 覆盖的是**整个文件路径**，所有 name
 *   共用一份。那边成立，是因为读写都发生在 per-agent 的 poller 里，
 *   **一个进程只有一个 name**。
 *
 *   这里不成立：**写的那一侧是 relay，而 relay 是中心进程** ——
 *   队伍里每个 agent 的 outbox 都从它手上过。共用一份文件的后果是
 *   **dev 的漏填报给了 dev2**，而两边都不会报错：dev2 收到一条自己
 *   看不懂的告警（多半当噪音忽略），dev 什么也没收到。
 *   ⇒ 覆盖只到**目录**这一层。「按名分文件」任何时候都不能被关掉。
 *
 * ⚠️ 可注入目录不是「为了可测」的装饰 —— 同 `relay.js` 的 `deadletterRoot`：
 *   那个参数防的是测试往生产死信目录里写文件。
 *   这里污染的形态是「跑一次全量，某个 agent 下一轮收到几条凭空冒出来的
 *   漏填告警」，而它指的那几条消息根本不存在。
 */
function stateDir(dir) {
  if (dir) return dir;
  if (process.env.ENGLOOP_THREAD_ALERT_DIR) return process.env.ENGLOOP_THREAD_ALERT_DIR;

  // ★★★ **测试进程自动落到别处 —— 不靠调用方记得传参数。**
  //
  //   上面那个 `dir` 参数和 env 逃生口，测试调用方（比如 `startRelay` 的那些）
  //   不一定会传。不传的话，跑一次测试套件就往**生产状态文件**里追一批假记录，
  //   某个 agent 下一轮会收到一串全是假阳性的漏填告警。
  //
  //   而这个模块的全部资产就是「可信」—— 它不修任何东西，它只说一句话。
  //   **一个被习惯性忽略的告警等于没有告警**，而假阳性正是让人学会忽略它的东西。
  //
  // ⚠️ 所以不能指望「调用方记得传参数」：
  //   `lib/relay.js` 里写着「函数支持透传 ≠ 调用方真的传了，
  //   这个形状会再长回来」。
  //   ⇒ 默认值本身必须是安全的。判定复用 `queue.isTestProcess()`
  //   （看 `require.main` 在不在 `test/` 下），跟「测试不许碰生产库」同一个出处。
  if (q.isTestProcess()) return path.join(ROOT, 'temp', 'test-thread-alert');

  return path.join(ROOT, 'temp');
}

/** name 来自目录名，仍然要消毒 —— 路径穿越的代价是写到仓库外面去。 */
function safeSeg(s) {
  return String(s == null ? '' : s).replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
}

function statePath(name, dir) {
  return path.join(stateDir(dir), `thread-alert-${safeSeg(name)}.json`);
}

/**
 * 这条**已经写进流里**的消息算不算 orphan。
 *
 * ⚠️⚠️ 传进来的必须是**规范化之后**的值，不是 agent 在 outbox 里写的原值。
 *   `lib/relay.js` 对 `kind` 只透传认识的三个值，拼错的 `"notic"` 会被
 *   整个丢掉 ⇒ 流里没有 kind ⇒ 网页把它渲染成 orphan（那段注释是故意
 *   这么设计的：「让它退化成没标，于是人看得见自己拼错了」）。
 *
 *   这里要是照 agent 的原值判，就会得出「他标了 notice，不用提醒」——
 *   **网页红着，告警是绿的**。而两边不一致比没有告警更坏：
 *   他看到的每一次「没问题」，都在教他这个检查器可以信。
 *
 * ★ 判据本身不复制过来，直接调 `kindOf`。「谁能开话题」在 `web/threads.js`
 *   里是唯一出处（见 `HUMAN` 的注释：复制出第二份，两处就会分叉）。
 *   而在这里分叉的具体表现，正是上一段那个：红标签和告警各说各的。
 */
function isOrphan(sent) {
  if (!sent) return false;
  return kindOf({
    from: sent.from,
    kind: sent.kind,
    reply_to: sent.reply_to,
  }) === 'orphan';
}

function loadRaw(name, dir) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(name, dir), 'utf8'));
    return {
      items: Array.isArray(s && s.items) ? s.items.filter(Boolean) : [],
      dropped: Number.isFinite(s && s.dropped) ? s.dropped : 0,
      settled: Array.isArray(s && s.settled) ? s.settled.filter(Boolean) : [],
    };
  } catch {
    // 读不到 = 上一轮没漏填 = 常态，不是故障。跟 `waiting.load` 同档，
    // 跟探针相反（那边「没有状态」本身就是要报的东西）。
    return { items: [], dropped: 0, settled: [] };
  }
}

/**
 * 截出预览。**截断处必须带 `…`。**
 *
 * ⚠️ 不带的话，被切断的第一句读起来像一句完整的话 —— 人（和模型）会照着
 *   它下判断。这跟长消息折叠那边是同一条判据：宁可让截断显眼，
 *   也不能让半句话冒充整句。
 */
function previewOf(text) {
  const one = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!one) return '(空)';
  return one.length > PREVIEW ? `${one.slice(0, PREVIEW)}…` : one;
}

/**
 * 记一笔。
 *
 * ★ **投递成功之后才调。** 没送出去的那条不存在「挂错 thread」的问题，
 *   而先记后投会在投递失败时留下一条永远解释不了的告警 ——
 *   他去翻自己发过的消息，那条根本不在。
 *
 * ⚠️ 超出 `KEEP` 的不静默丢：`dropped` 累计，`alertLine` 会把它说出来。
 *   静默截断的读法是「一共就这几条」，而那正好是他据以判断严重程度的数字。
 */
function record(name, item, dir) {
  try {
    const p = statePath(name, dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const prev = loadRaw(name, dir);
    const all = [...prev.items, item];
    const items = all.slice(-KEEP);
    fs.writeFileSync(p, JSON.stringify({
      items,
      dropped: prev.dropped + (all.length - items.length),
      // ⚠️ **保留区必须原样带过去。** 漏掉这一行，每记一条新告警就会把
      //   上一轮读走的留档冲掉 —— 而留档存在的全部理由就是事后查得到。
      //   这个漏法不报错：文件还在、告警照常，只有查证据的那一刻才发现空了。
      settled: prev.settled,
    }, null, 2));
    return true;
  } catch {
    // 记不下来不能影响投递 —— 这个模块是观测，不是链路。
    return false;
  }
}

/**
 * 读出并清空。
 *
 * ★ **读了就销**，不累积到「改正为止」。
 *   `lib/waiting.js:14-19` 记着「一直报会脱敏」最安静的那一种：
 *   **文件还在、内容还对、人不再打开它** —— 从外面看跟一切正常完全一样。
 *   一条永不消失的告警，最后等于没有这个字段。
 *
 *   ⇒ 每轮报的只是**上一轮真实发生的**。他继续漏，下一轮继续有，
 *   不靠累积施压；他改对了，告警**当轮就消失** —— 那一下才是反馈。
 *
 * ⚠️ 清空发生在读到的那一刻，所以 agent 那一轮崩了，这条告警就丢了。
 *   这个代价是认的：丢一次的后果是「下次再犯时才提醒」，
 *   而它换掉的是「一直报到脱敏」—— 后者会把整个字段废掉，且没人会发现。
 *
 * ══════════════════════════════════════════════════════════════
 * ★★★ **但「销」不等于「删」** —— 读走的移进 `settled` 保留区。
 *
 *   收到可疑告警的 agent 想「把这个文件留着当证据」是做不到的：
 *   **它的 poller 每一轮都在读，读即删。** 不留档的话，等有人去查，
 *   证据已经被机制自己吃光了。
 *
 *   `lib/waiting.js` 里有同一条：
 *   > **如果同时也从文件里消失，就再也没有任何东西能证明它存在过。**
 *
 * ⚠️ 保留区**不参与告警**（`alertLine` 只看 `items`）——
 *   它是留给事后查证的，不是拿来累积施压的。混进告警就变回「一直报」了。
 * ══════════════════════════════════════════════════════════════
 */
function take(name, dir) {
  const state = loadRaw(name, dir);
  if (!state.items.length && !state.dropped) return state;

  try {
    const p = statePath(name, dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // ★ 打上 `taken_at`：查的时候要能分清「哪一轮读走的」，
    //   否则保留区只是一堆没有时间轴的旧记录。
    const now = Date.now();
    const moved = state.items.map((it) => ({ ...it, taken_at: now }));
    fs.writeFileSync(p, JSON.stringify({
      items: [],
      dropped: 0,
      // 新的排在前面（同 waiting 的 settled）—— 查证据总是从最近一次查起。
      settled: [...moved, ...state.settled].slice(0, SETTLED_KEEP),
    }, null, 2));
  } catch {
    // 写不回去就退一步、不留档：至少把文件删掉，别让同一批告警重复报。
    // **重复报的代价（脱敏）比丢掉留档更贵** —— 留档是查证据用的，
    // 告警是每轮都要用的。
    try { fs.unlinkSync(statePath(name, dir)); } catch { /* 没有就没有 */ }
  }
  return state;
}

function hhmm(ms) {
  if (!Number.isFinite(ms)) return '??:??';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 告警文本。没有漏填就返回 `null`（**不是空字符串**）——
 * `bin/next.js` 那边用 `cond ? {字段} : {}` 决定字段在不在，空串会造出一个
 * 存在但没内容的 `_thread_alert`，读的人只能理解成「有问题但没说是什么」。
 *
 * ★ 修法必须**具体到字段名**，而且区分房间/私聊：两边锚点字段不同
 *   （`room_msg_id` / `dm_msg_id`，`bin/next.js:388-393` 说明了为什么互斥）。
 *   只说「请挂 thread」等于把他刚犯的那个错原样退回给他。
 */
function alertLine(state) {
  const items = (state && state.items) || [];
  const dropped = (state && state.dropped) || 0;
  if (!items.length) return null;

  const lines = items.map((it) => {
    const where = it && it.room ? '房间' : (it && it.to) || '?';
    return `  · ${hhmm(it && it.at)} → ${where} · 「${previewOf(it && it.preview)}」`;
  });

  const more = dropped > 0
    ? `\n  （另有 ${dropped} 条更早的没列出来 —— 只留最近 ${KEEP} 条）`
    : '';

  return `⚠️ 你上一轮发出的 ${items.length + dropped} 条消息没挂 thread，`
    + '网页上它们标着红色「未归属」：\n'
    + lines.join('\n') + more + '\n'
    + '修法：回复时带上 `reply_to`，值**原样回填**你收到那条消息里的 '
    + '`room_msg_id`（房间）或 `dm_msg_id`（私聊），两个字段互斥，手上有哪个用哪个。\n'
    // ⚠️ 这句话要列全 `kind` 的每一档：只提 `notice` 的话，
    //   一条上线报到/心跳（该标 status）会被引去标 notice，
    //   成了「把一条纯状态伪装成通知」。
    //   > **一个告警把人引向错的修法，比不给修法更坏。**
    //   加值域时**必须回来改这句话** —— 判据和给人的建议是两处，会分叉。
    + '如果那条不是回复：主动通知标 `kind:"notice"`；'
    + '上线报到 / 自检 / 心跳这类纯状态标 `kind:"status"`。\n'
    + '🚫 系统**不会**替你挂 ——「没填就挂到最近那条」是被点名反对的：'
    + '每条都挂上了，看起来很整齐，只是全挂错。';
}

/**
 * 读保留区 —— 事后查「那一批告警到底是什么」。
 *
 * ★ 只读不改，也**不参与任何告警**。它存在的唯一场景是有人事后来问
 *   「上一轮报的那些是真的吗」—— 没有保留区的话，那时答案早已被 `take()` 删掉。
 */
function settledOf(name, dir) {
  return loadRaw(name, dir).settled;
}

module.exports = {
  isOrphan, record, take, alertLine, settledOf,
  // 导出给测试：**这几个是「告警会不会凭空出现/凭空消失」的全部机关所在。**
  statePath, previewOf, KEEP, PREVIEW, SETTLED_KEEP,
};
