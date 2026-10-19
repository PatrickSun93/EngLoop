'use strict';
/* EngLoop 控制台 —— 前端逻辑
 *
 * 这个页面存在的**唯一判据**：人问「怎么样了」「现在呢」「还剩什么」时，
 * 不需要有人去跑命令查花名册、查 tmux、再转述。
 * 这几个问题页面答不了，这个文件就白写了。
 *
 * ⚠️ 无依赖，无框架，无图表库。改的时候别顺手引一个。
 */

// ── 状态映射：level → 三重编码 ─────────────────────────────────
//
// ★ `/api/agents` 实际会返回**十个** level，视觉档位少得多。映射表放在
//   这里、而且只有这一份 —— 散在渲染代码里的话，新增一个 level 会**静默**
//   落到 else 分支显示成正常，而那正是这个页面要消灭的那类谎言。
//
// ⚠️ `heartbeat_lost` 和 `deaf` 不能画成同一种红：
//     前者还在读队列，只是心跳没写进花名册 —— 它**没聋**，处置是查心跳；
//     后者轮询已经停了 —— 处置是推恢复指令。
//     画成同一种红等于告诉人「这两件事一样」，而它们的处置相反。
// ★ `label` 是卡片上那几个字：**每个状态都要有符号加文字**，
//   `note` 是那一句说明。三条通道各自独立，不能只靠颜色。
const STATUS = {
  ok:             { label: '在线', cls: 'live', glyph: '●', note: null },
  busy:           { label: '在忙', cls: 'live', glyph: '●', note: '久没读队列，但 outbox 还在动 —— 在忙，不是聋' },
  unknown:        { label: '还没读过队列', cls: 'off',  glyph: '○', note: '还没读过队列（可能刚起）' },
  warn:           { label: '轮询慢', cls: 'warn', glyph: '◐', note: '超过 15 分钟没读队列' },
  nudge:          { label: '已推过一把', cls: 'warn', glyph: '◐', note: '超过 20 分钟没读队列，已推过一把' },
  alert:          { label: '推了没反应', cls: 'deaf', glyph: '▲', note: '超过 30 分钟没读队列，推过仍无反应' },
  heartbeat_lost: { label: '心跳丢了', cls: 'warn', glyph: '◐', note: '在读队列，但心跳没写进花名册' },
  deaf:           { label: '失联', cls: 'deaf', glyph: '▲', note: '会话在，不在花名册 —— 轮询已停' },
  // ★★ 撞上游限额（第四档）。
  //
  //   ⚠️ **同样不能跟 `deaf` 画成一种红**，理由跟上面那条一模一样，
  //   而且更硬：deaf 的处置是「推一把」，这一档的处置是「**别碰**」——
  //   人看到红色三角的第一反应就是去救，而在这一档，
  //   **人手动推和 watchdog 自动推一样坏**（都会加速额度消耗）。
  //
  //   ★ note 里那句「也可能是它正在读这类文字」不是免责声明，是**动作指引**：
  //   判据是 pane 末尾 40 行里的字样，而一个正在写限额相关代码的 agent
  //   pane 上也有这些字。人看到状态名会当成事实，看到这句才知道要确认一眼。
  rate_limited:   { label: '限额 · 别推它', cls: 'limit', glyph: '⏸',
    note: '撞上了上游限额（额度用尽）—— 别推它，推一把只会更快撞下一次，等额度重置即可。'
        + '⚠️ 判据是 tmux pane 末尾 40 行里的限额字样，'
        + '所以也可能是它正好在读/写跟「限额」有关的文字 —— 看到这一格请去确认一眼',
    // ★ 卡片上放不下整句 note（它会把舰队带撑成半屏高）。`short` 是卡片上那一行 ——
    //   **「别推它」和「也可能是误判，去确认一眼」两半都必须在**，全文在卡片的 title 里。
    short: '别推它 —— 推一把只会更快撞下一次，等额度重置即可。⚠️ 也可能是误判，去确认一眼' },
  stale:          { label: '会话已不在', cls: 'off',  glyph: '○', note: '会话已不在，花名册残留' },
  probe_failed:   { label: '探测失败', cls: 'warn', glyph: '◐', note: '探测失败 —— 这是「查不了」，不是「它没事」' },
};
const UNMAPPED = { label: '未知状态', cls: 'warn', glyph: '◐', note: '未知状态 —— 界面没认出这个 level' };

// 走红色 tag 的 watchdog level。`blind` 是 watchdog 对自己的判定（拿不到
// tmux 列表），`zero_sessions` 是它看见了但一个会话都没有 —— 两者都比
// 任何单个 agent 失聪更严重，因为**它们让所有其它判定失去意义**。
const CRIT_LEVELS = new Set(['deaf', 'alert', 'zero_sessions', 'blind', 'probe_failed']);

// 后端错误 → 一句给人看的话。
// ★ **必须带上 `next`** —— 那是后端对这个错误给的出口（「去哪查」「要不要重试」）。
//   丢掉它，界面就退回到「诚实但无用」：说清了是什么，人还是卡在原地。
//   出口的文案住在后端、只有一份 —— 前端另写一句的话，后端改了只有一份会跟着改。
const errText = (d, status) => [
  (d && (d.message || d.error)) || `HTTP ${status}`,
  d && d.next,
].filter(Boolean).join(' —— ');

// ── 最小 markdown 渲染 ─────────────────────────────────────────
//
// ★ 为什么需要它：消息渲染一律走 `textContent`（消息内容是不可信输入），
//   而 agent 和人都在**大量写 markdown** —— 两个决定各自有道理，
//   合起来就是满屏的 `**` 和反引号。
//
// ⚠️⚠️ **顺序不能反：先转义 HTML，再替换 markdown 标记。**
//   反过来就是一个 XSS 洞，而这个页面显示的正是 agent 生成的内容。
//   转义之后，串里唯一的 `<` `>` 就只能是下面这几行自己加的标签。
//
// ⚠️ 不引 markdown 库。这里只认五种记号，**不追求完备** ——
//   认不出的原样显示，那比渲染错了好。
// ⚠️⚠️ **五个字符全转，包括引号。不要「优化」掉后两个。**
//
//   转义的正确性取决于**输出到哪个上下文**，而函数签名里没有那个信息 ——
//   通常的解法是拆成 `escHtml` / `escAttr`，**让调用点被迫说出上下文**。
//
//   **这里拆不开**：`docs/…` 的 linkify 是在**已经转义过的整段文本**上做正则
//   替换的，同一次转义的输出**一部分进文本节点、一部分进 `href="…"` 属性**。
//   没有哪个调用点只属于一种上下文，所以只能按**最严格的那个**来。
//
//   → 想省掉 `"` 和 `'` 那两次 replace 的话，先看 mdInline 里的 `<a href="…">`。
//     省掉之后一个带引号的文件名就能破出属性，而且**普通内容看不出任何异常**。
const escAll = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const esc = escAll;   // 旧名保留：调用点很多，改名的收益不值一次全文替换的风险

// ★ `docs/…` 路径变成可点的。消息里常说「落盘了」并给一个路径，而**那些路径对人来说
//   是够不到的地方** —— 点开就能看是这条唯一的用途。
//   路径已经过 esc（含引号），所以放进 href 是安全的；`data-doc` 让点击处理器
//   拿到原路径，不必再从 href 里解析。
const DOC_PATH = /\bdocs\/[A-Za-z0-9._\-/]+\.md\b/g;
function mdInline(t) {
  return t
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
    .replace(DOC_PATH, (p) => `<a class="doclink" href="#${p}" data-doc="${p}">${p}</a>`);
}

// 表格：`| a | b |` + 分隔行 `|---|---|`。
// ★ 加这个是因为调研文档里**几乎全是表格** —— 不认的话满屏竖线，
//   而那正是「渲染器认不出就原样显示」这条策略会退化得最难看的地方。
function mdTable(lines, i) {
  const row = (ln) => ln.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  if (!/^\s*\|/.test(lines[i] || '') || !/^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) return null;
  const head = row(lines[i]);
  const body = [];
  let j = i + 2;
  for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) body.push(row(lines[j]));
  const th = head.map((c) => `<th>${mdInline(c)}</th>`).join('');
  const tr = body.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('');
  return { html: `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`, next: j };
}

function mdToHtml(src) {
  const out = [];
  // 先按代码块切开 —— 块内不做任何行内替换（`**` 在代码里是字面量）
  for (const [i, part] of String(src).split(/```/).entries()) {
    if (i % 2 === 1) { out.push(`<pre>${esc(part.replace(/^\w*\n/, ''))}</pre>`); continue; }
    const lines = esc(part).split('\n');   // ★ esc 仍然在最前面，这是整条链的前提
    const buf = [];
    for (let k = 0; k < lines.length; k++) {
      const tbl = mdTable(lines, k);
      if (tbl) { buf.push(tbl.html); k = tbl.next - 1; continue; }
      const ln = lines[k];
      const quote = /^&gt;\s?(.*)$/.exec(ln);
      buf.push(quote ? `<blockquote>${mdInline(quote[1])}</blockquote>` : mdInline(ln));
    }
    out.push(buf.join('\n'));
  }
  return out.join('');
}

// ── 复制按钮 ───────────────────────────────────────────────────
//
// ★ 复制的是**原文**（markdown 源），不是渲染后的文字 —— 这个页面上的内容
//   经常要粘回终端或者贴给别人，`**粗体**` 的星号在那边是有意义的。
//
// ⚠️ `navigator.clipboard` 要 secure context。`127.0.0.1` 算，所以本地没问题；
//    换成局域网 IP 访问就会失效 —— **那时候要让人看见失败，不能静默**。
const COPY_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" '
  + 'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'
  + '<rect x="5.6" y="5.6" width="8.4" height="8.4" rx="1.6"/>'
  + '<path d="M10.6 3.4v-.8a1.2 1.2 0 0 0-1.2-1.2H2.9a1.2 1.2 0 0 0-1.2 1.2v6.5a1.2 1.2 0 0 0 1.2 1.2h.8"/></svg>';

function copyBtn(getText, extraCls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'copy' + (extraCls ? ' ' + extraCls : '');
  b.title = '复制原文';
  b.innerHTML = COPY_SVG;                 // 自己的常量，不是外来内容
  const restore = () => { b.innerHTML = COPY_SVG; b.className = 'copy' + (extraCls ? ' ' + extraCls : ''); };
  b.onclick = async (ev) => {
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(getText());
      b.textContent = '✓'; b.className += ' ok'; b.title = '已复制';
      setTimeout(restore, 1400);
    } catch (e) {
      // 说清是什么 + 该怎么办。静默失败最坏 —— 人会以为复制成功了去粘贴。
      b.textContent = '✗'; b.className += ' bad';
      b.title = '复制失败：' + String(e.message || e)
        + '\n浏览器只在 https 或 localhost 下允许剪贴板。用 127.0.0.1 访问试试。';
      setTimeout(restore, 2600);
    }
  };
  return b;
}

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;   // ★ 一律 textContent：消息内容是不可信输入
  return n;
};

// 相对时间。**绝对时间戳要人心算才知道有没有问题**，而心算那一步
// 会在人着急的时候被跳过 —— 而人着急的时候恰恰是最需要看懂它的时候。
function ago(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  const h = Math.floor(m / 60);
  return h + 'h' + String(m % 60).padStart(2, '0') + 'm';
}
function clock(at) {
  const d = at ? new Date(at) : new Date();
  if (Number.isNaN(d.getTime())) return '--:--';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ── 频道状态 ───────────────────────────────────────────────────
// 房间和私聊共用一套消息底层，界面上只用 `#` / `@` 区分 —— 不做成两个页面。
const ORCH = 'JARVIS';
let current = { kind: 'dm', id: ORCH, name: ORCH, members: [] };
let roomList = [];
let agentNames = [];
const feeds = new Map();          // channelKey → [entry]
const seenIds = new Set();        // 去重：history 拉的和 WS 推的会重叠

const keyOf = (ch) => ch.kind + ':' + ch.id;

// 同一条房间消息会到达两次：一次从 `/history` 拉，一次从 WS 推。
// ★ 去重键**不能只靠 `id`** —— 那要求两条路径用同一个 id 空间，而那是个
//   跨进程的约定，一方改了另一方不会红。所以 id 缺席时回落到内容组合键：
//   重复显示同一句话是**看得见**的病，比静默丢一条好查得多。
/**
 * 一条消息的**锚点** —— 回复它时 `reply_to` 要填的那个值，
 * 也是 `Threads.group()` 用来认父子的那个 `id`。
 *
 * ── ★★ 为什么两种频道取不同的字段，而**不能**统一 ────────────────────
 *   房间：取**房间流的 stream id**。只有一条流 ⇒ 天然唯一；
 *         而人走 `rooms.post()` 的那条**根本没有 job_id**，
 *         统一成 job_id 的那天，人在网页里发的每条房间消息锚点都是 undefined。
 *   私聊：取 **job_id**。私聊历史是 `orch:in:human` + `orch:out` **两条流
 *         合并**读出来的，两条流各自独立计数 —— 同一毫秒各写一条就是同一个
 *         stream id（交替高频写时很常见）。
 *
 * ⇒ **不一致不是缺陷，强行统一才是。** 它们的唯一性来源本来就不同。
 *   ★ 归一的是**读取**（这个函数），不是**数据**：两个字段名在协议里各自保持。
 *
 * ⚠️ 私聊那侧**故意不回落到 `m.id`**。没有 job_id 就返回 null，
 *   调用方据此不给回复按钮 —— 回落出一个锚点的话，按钮是有了，
 *   而它生成的 `reply_to` 指向一个查不到的父，回复显示成顶层，
 *   **跟没回复过一模一样，零报错**。
 */
function anchorOf(m, kind) {
  return kind === 'room'
    ? (m.id || m.job_id || null)
    : (m.job_id || null);
}

// ── thread 分类判据在 `web/threads.js`（`Threads.kindOf`）────────────────
//
// ★ 不在这里放第二份：那两个判据跟 `group` / `rootIdOf` 是**同一个模型的四个
//   部分**，散在两个文件里迟早分叉。而且 app.js 是浏览器脚本、**Node require
//   不了** ⇒ 放这儿的判据既测不了、也做不了变异证明。
//   （`test/threads.test.js` 真测它们，`test/thread-kind-mutation.test.js` 变异守它们。）

function dedupeKey(entry) {
  if (entry.id) return 'id:' + entry.id;
  // JSON.stringify 而不是 join(分隔符)：拼接键要挑一个「正文里不会出现」的
  // 分隔符，而那个前提**没有任何东西在守**。JSON 自己处理转义，无歧义，
  // 而且全是可打印字符（用 NUL 当分隔符会让这个源文件被当成二进制）。
  return 'c:' + JSON.stringify([entry.from, entry.at, entry.text]);
}

function push(chKey, entry) {
  if (!entry.sys) {
    const k = dedupeKey(entry);
    if (seenIds.has(k)) return false;
    seenIds.add(k);
  }
  if (!feeds.has(chKey)) feeds.set(chKey, []);
  feeds.get(chKey).push(entry);
  // ★ 「需要你」跟着消息走 —— 合并到下一个宏任务里算一次（拉一批历史只算一次）
  if (!entry.sys) scheduleNeed();
  return true;
}

// ── thread 合并映射 ─────────────────────────────
//
// `{ chKey: {根A: 根B} }`。跟着 `GET /api/rooms/:hash/history` 一起来
// （`historyPayload` 里的 `merges`），**不另外请求** —— 分两次取的话，
// 中间有人合并就会让一批消息配上一张对不上的表，而错配的表不报错，
// 只会把话题画错位置。
//
// ⚠️ 私聊没有合并（那是房间功能）⇒ 取不到就是空表，`rootIdOf` 退回老行为。
const mergesByCh = new Map();
function mergesOf(ch) { return mergesByCh.get(keyOf(ch)) || null; }

// ── 渲染：对话流 ───────────────────────────────────────────────
// 哪些 thread 是展开的（key = 根消息 id）。**刷新页面就重置** ——
// 存起来的话，一个人昨天展开的 thread 会在今天的新消息里凭空张开。
const openThreads = new Set();

// ── 手动合并的交互状态 ───────────────────────────
//
// 点「并入…」进入选择态，再点另一个话题的「并到这里」落地。
// **只做手动** —— 自动识别同话题是启发式的，判错就是把两个话题搅在一起，
// 而**搅在一起比分开更难看出错**。
let mergeSource = null;   // 正在等待选择目标的那个根 id

/**
 * 「人现在是不是在看最新的」—— 底部这一小段容差。
 *
 * ★ 不能用 `=== 0`：滚动位置有小数、有 CSS 边距，人明明拖到底了也常常差几像素。
 *   差一点就判成「在读历史」，于是新消息到了不滚。
 */
const NEAR_BOTTOM_PX = 60;

/** 本次页面加载里已经处理过「今天第一次打开」的房间。见 `renderFeed()` 里的用法。 */
const expandedRooms = new Set();

/**
 * 今天是不是第一次打开这个房间。**有副作用：判过一次就记下来。**
 *
 * ★ 值存的是日期字符串（`YYYY-MM-DD`），不是布尔 —— 布尔的话「今天」和
 *   「上个月」分不开，跨天就永远不会再展开了。
 * ⚠️ `localStorage` 在隐私模式 / 禁用第三方存储的 iframe 里会**抛异常**。
 *   抛了就当「今天第一次」（展开）—— 折叠的风险是他看不到该看的，
 *   而**「查不了」绝不能降级成「已经看过了」**。
 */
function firstOpenToday(hash) {
  const key = `engloop:room-expanded:${hash}`;
  const today = new Date().toISOString().slice(0, 10);
  let seen = null;
  try { seen = localStorage.getItem(key); } catch (_) { return true; }
  if (seen === today) return false;
  try { localStorage.setItem(key, today); } catch (_) { /* 存不下就下次再展开一次 */ }
  return true;
}

function isNearBottom(feed) {
  if (!feed) return true;
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= NEAR_BOTTOM_PX;
}

/**
 * 重渲染前记住「人在看哪儿」，重渲染后放回去。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★★ **为什么修在这里，而不是在每个 `onclick` 上**
 *
 *   调 `renderFeed()` 的地方**不止展开按钮那一处**，至少十处。
 *   在每个 onclick 上各写一遍 = 十份实现，**而漏掉的那几处不报错，
 *   只会「偶尔还是跳」** —— 那是最难查的一种：人会以为是自己记错了。
 *
 * ── ⚠️ 两条会把人弹回底部的路 ────────────────
 *   `renderWithdraw()` 防的是「定时刷新」：**不能靠每 5 秒 renderFeed 一次** ——
 *   那会在人读历史时每 5 秒把他弹回底部。
 *   另一条是「用户主动展开」。在 `renderFeed()` 根上保住滚动位置，两条路一起关。
 *
 * ── 锚点为什么是「视口顶部那一段」，不是「被点的那一条」──────────
 *   被点的那条要传进来，就得每个 onclick 各传一次 —— 又回到十份实现。
 *   而视口顶部那一段是 `renderFeed()` **自己看得见**的东西：
 *     · 展开一个 thread：插入的内容在锚点**下方** ⇒ 锚点不动 = 被点那条不动
 *     · 展开「更早的话题」：插入的内容在锚点**上方** ⇒ 锚点不动 = 视口内容不动
 *   两种情况同一套逻辑，零参数。
 *
 * ⚠️ 锚点找不到时（那一段被合并/撤回没了）**什么都不做**，保持浏览器给的
 *   滚动位置 —— 不猜一个位置。猜错的表现跟「跳到底」一样难受，而且没规律。
 * ══════════════════════════════════════════════════════════════════
 */
function captureScroll(feed) {
  if (!feed) return null;
  if (isNearBottom(feed)) return { nearBottom: true };
  const top = feed.getBoundingClientRect().top;
  for (const n of feed.querySelectorAll('[data-seg]')) {
    const r = n.getBoundingClientRect();
    if (r.bottom > top) return { nearBottom: false, seg: n.dataset.seg, offset: r.top - top };
  }
  return { nearBottom: false };
}

function restoreScroll(feed, prev) {
  if (!feed) return;
  // ★ 没抓到状态（第一次渲染）也当成「在底部」—— 打开一个频道该看到最新的。
  if (!prev || prev.nearBottom) { feed.scrollTop = feed.scrollHeight; return; }
  if (prev.seg == null) return;
  let n = null;
  try { n = feed.querySelector(`[data-seg="${CSS.escape(prev.seg)}"]`); } catch (_) { n = null; }
  if (!n) return;                      // 见上：找不到就别猜
  // ── ⚠️ **先归零再量，不要用 `scrollTop += 差值`** ────────────────────
  //   `+=` 那种写法要求「量 rect 的那一刻 scrollTop 是多少」是确定的，
  //   而 `replaceChildren()` 之后它到底被浏览器重置成 0 还是保留原值，
  //   **取决于新内容够不够高**，不是一个能依赖的前提。
  //   前提错了时 scrollTop 能差出几千像素，而**断言只说
  //   「位置不对」，不会告诉你是这个前提错了**。
  //   ⇒ 归零之后 `rect.top - feed.top` 就是**绝对偏移**，只有一种解释。
  feed.scrollTop = 0;
  const abs = n.getBoundingClientRect().top - feed.getBoundingClientRect().top;
  feed.scrollTop = abs - prev.offset;
}

function renderFeed() {
  const feed = $('feed');
  // ★ 必须在 `replaceChildren()` **之前**抓 —— 之后 DOM 就没了，
  //   量出来的 scrollHeight 是清空后的，锚点也一个都找不到。
  const prevScroll = captureScroll(feed);
  const list = feeds.get(keyOf(current)) || [];
  feed.replaceChildren();

  if (!list.length) {
    feed.appendChild(el('div', 'empty', '还没有消息。'));
    return;
  }

  // ★ 房间和私聊**走同一条路径**。私聊里没有 reply_to，`group()` 会把每条
  //   都当根 —— 结果跟不分组时逐字相同。多一个 `if (isRoom)` 分支等于多一个
  //   「只在某种频道下才发生」的 bug 面，而那种 bug 最难复现。
  // ── `status` 那一档，**相邻的收成一行** ──────────
  //
  //   这类消息（比如 agent 的上线报到）没有真正的信息，收成一行小通知就够，
  //   不必各占一条消息的版面。
  //
  // ⚠️ **有回复的不收进来** —— 有人在它下面说过话，它就不再是「零信息量」了。
  //   把一条已经长出对话的消息折成一行，折掉的是那段对话。
  //
  // ⚠️ 判据只看发送者标的 `kind`（`Threads.kindOf`），**不看内容**。
  //   猜「这条像不像状态消息」迟早会把一条真正要紧的消息猜进垃圾堆，
  //   而这种误判零报错。
  // ★ 切段和「够不够新」两个判据都在 `Threads`，**不在这里** —— 它们是
  //   分组算法，放这儿就只能做源码断言，验不了边界（会不会把两段本该分开的
  //   状态粘成一段、会不会把还在聊的老话题藏掉）。
  const merges = mergesOf(current);
  const segs = Threads.segments(Threads.group(list, merges));

  // ── 今天第一次打开这个房间，**默认展开一次** ────────────────
  //
  // ★ 折叠的风险是「他看不到该看的」，而那比多几行噪音坏得多。
  //   ⇒ 每天第一次进来先让他看见全貌，之后再折起来。
  //
  // ⚠️ 存 `localStorage` 而**不是** `sessionStorage`：他刷新页面很频繁，
  //   sessionStorage 会让每次刷新都展开一次 —— **那等于没折叠**。
  // ⚠️ `expandedRooms` 是本次页面加载的去重：`renderFeed()` 每次重画都会走到
  //   这里，不去重的话第一次之后每一次都会「今天第一次」判成 false，
  //   而真正的问题是**它会在人手动折起来之后又把它展开**。
  if (current && current.kind === 'room' && current.id && !expandedRooms.has(current.id)) {
    expandedRooms.add(current.id);
    if (firstOpenToday(current.id)) {
      for (const s of segs) if (s.kind === 'thread' && s.thread.root) openThreads.add(s.thread.root.id);
    }
  }

  const { fresh, older, olderCount } = Threads.splitByAge(segs, Date.now());

  // ── 被并走的话题在原位置留一行痕迹 ────────────────────────────
  //   `pos` 用它在这批消息里**第一次出现**的下标 —— 跟 `group` 排顺序用的
  //   是同一个判据（「根第一次出现的位置」），两处不一致的话痕迹会飘到
  //   一个跟它无关的话题旁边。
  const posOf = new Map();
  list.forEach((e, i) => { if (e && e.id != null && !posOf.has(e.id)) posOf.set(e.id, i); });
  const traces = Object.keys(merges || {})
    // ⚠️ 只给**在这批里**的源留痕：源本身被条数截断时，它原来的位置根本
    //   不在这个列表上，硬插一行会插在一个任意的地方。
    .filter((from) => posOf.has(from))
    .map((from) => ({ from, to: merges[from], pos: posOf.get(from) }))
    .sort((a, b) => a.pos - b.pos);
  const traceCtx = traces.length ? { posOf, traces, state: { i: 0 } } : null;

  // ── 更早的话题折起来（**折起，不是删掉**）────────────────────
  //   折叠条放在**顶部**：消息流按时间从上往下，更早的本来就在上面，
  //   放底部会让展开后的内容从时间轴中间冒出来。
  if (older.length) feed.appendChild(renderOlderToggle(older, olderCount, fresh.length === 0));

  appendSegments(feed, fresh, traceCtx);
  // ⛔ 这里**不要**无条件 `feed.scrollTop = feed.scrollHeight`：
  //   那一行同时毁掉「展开不跳」和「读历史时别被打断」两件事，
  //   而它的症状（偶尔跳一下）看起来像浏览器的毛病，不像 bug。
  restoreScroll(feed, prevScroll);
}

/**
 * 把一串段渲染进容器。**顶层和「更早」展开区共用它** —— 两份实现会各自漂移。
 *
 * @param {object} [traceCtx] 只在顶层那次传：`{ posOf, traces, state }`，
 *   用来在被并走的话题**原来的位置**插一行痕迹（见 `renderMergeTrace`）。
 *   展开区不传 —— 同一条痕迹在两个地方各画一遍，人会以为并走了两个话题。
 */
function appendSegments(container, segs, traceCtx) {
  const flushTraces = (beforePos) => {
    if (!traceCtx) return;
    const { traces, state } = traceCtx;
    while (state.i < traces.length && traces[state.i].pos < beforePos) {
      container.appendChild(renderMergeTrace(traces[state.i]));
      state.i += 1;
    }
  };

  for (const seg of segs) {
    const rootId = (seg.kind === 'status' || seg.kind === 'dup')
      ? (seg.items[0] && seg.items[0].id)
      : (seg.thread.root && seg.thread.root.id);
    flushTraces(traceCtx ? (traceCtx.posOf.get(rootId) ?? Infinity) : 0);

    // ★ `data-seg` 是**滚动锚点**（见 captureScroll）：重渲染后靠它认出
    //   「人刚才在看的那一段」。放在段的第一个元素上，因为视口顶部先碰到它。
    //   ⚠️ 它只是个 DOM 属性，**不是消息字段** —— 没有往消息对象上加任何 key。
    if (seg.kind === 'dup') {
      const dupEl = renderDupRun(seg);
      if (rootId != null) dupEl.dataset.seg = String(rootId);
      container.appendChild(dupEl);
      continue;
    }
    if (seg.kind === 'status') {
      const runEl = renderStatusRun(seg.items);
      if (rootId != null) runEl.dataset.seg = String(rootId);
      container.appendChild(runEl);
      continue;
    }
    const rootEl = renderMsg(seg.thread.root);
    if (rootId != null) rootEl.dataset.seg = String(rootId);
    container.appendChild(rootEl);
    // ★ 合并入口挂在**段的根**上，不进 `renderMsg` —— 合并是 thread 级的操作，
    //   而 renderMsg 是根和回复共用的。挂进去的话每条回复都会长出一个
    //   「并入…」，而点它的语义是不清楚的（并走整个话题？还是这一条？）。
    const bar = renderMergeBar(seg.thread.root);
    if (bar) container.appendChild(bar);
    if (seg.thread.replies.length) container.appendChild(renderThread(seg.thread));
  }
  flushTraces(Infinity);   // 位置排在所有段之后的痕迹（原话题在最末尾）
}

/** 一条消息的短标签：谁 + 第一行的头几个字。给合并/撤销那两行认人用。 */
function threadLabel(id) {
  const list = feeds.get(keyOf(current)) || [];
  const e = list.find((x) => x && x.id === id);
  if (!e) {
    // ★ 目标不在这批历史里（条数截断）。**不编一个名字出来** ——
    //   如实说「不在这批历史里」，人才知道该往上翻，而不是以为它没了。
    return '一个不在这批历史里的话题';
  }
  const head = String(e.text || '').split('\n').find((l) => l.trim()) || '';
  const short = head.trim().length > 24 ? `${head.trim().slice(0, 24)}…` : head.trim();
  return `${e.from}「${short || '(空)'}」`;
}

/** 合并 / 撤销的接口调用。**失败必须说出来** —— 静默失败会让人以为合并了。 */
async function callMerge(method, url, body) {
  try {
    const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      // 后端的 `next` 是它给的出口，原样带出来 —— 前端另写一句的话，
      // 后端改了出口只有一份会跟着改。
      alert(`${d.error || r.status}\n\n${d.next || ''}`);
      return false;
    }
    return true;
  } catch (err) {
    alert(`合并请求没发出去：${err.message}\n\n界面没有变化 —— 别当成已经合并了。`);
    return false;
  }
}

/** 合并成功后重拉历史：映射表跟着 history 一起回，所以必须整批重取。 */
async function afterMergeChange() {
  mergeSource = null;
  if (current.kind === 'room') await loadRoomHistory(current.id);
  renderFeed();
}

/**
 * 一个话题根下面的合并操作条。
 *
 * ★★ **撤销和合并一样容易找**：被并进来的话题
 *   就列在这里，每个后面跟一个「撤销」。历史一个字没动过，所以撤销一定
 *   回得到原样 —— **把撤销藏起来等于废掉这个设计的一半。**
 *
 * 只在房间里出现：私聊没有合并（`merges` 是房间级的）。
 */
function renderMergeBar(root) {
  if (!root || root.id == null || current.kind !== 'room') return null;
  const merges = mergesOf(current) || {};
  const incoming = Object.keys(merges).filter((from) => merges[from] === root.id);
  const isSource = mergeSource === root.id;
  if (!incoming.length && !mergeSource && !isSource) {
    // 平时只挂一个很轻的入口，不占版面
    const wrap = el('div', 'mergebar');
    const b = el('button', 'merge-btn', '⊕ 并入…');
    b.title = '把这个话题并进另一个话题。历史不会被改写，随时可以撤销。';
    b.onclick = () => { mergeSource = root.id; renderFeed(); };
    wrap.appendChild(b);
    return wrap;
  }

  // ★ `has-incoming` 让这一条常亮：「这个话题并进来过东西」本身就是信息，
  //   而且撤销入口不能只有 hover 才看得见（撤销要和合并一样容易找）。
  const wrap = el('div', 'mergebar'
    + (isSource ? ' picking' : '')
    + (incoming.length ? ' has-incoming' : ''));

  if (isSource) {
    wrap.appendChild(el('span', 'merge-hint', '选一个要并进去的话题 →'));
    const cancel = el('button', 'merge-btn', '取消');
    cancel.onclick = () => { mergeSource = null; renderFeed(); };
    wrap.appendChild(cancel);
  } else if (mergeSource) {
    const b = el('button', 'merge-btn primary', '并到这里');
    b.title = `把「${threadLabel(mergeSource)}」并进这个话题`;
    b.onclick = async () => {
      const ok = await callMerge('POST',
        `/api/rooms/${encodeURIComponent(current.id)}/threads/merge`,
        { from: mergeSource, to: root.id });
      if (ok) await afterMergeChange();
    };
    wrap.appendChild(b);
    const cancel = el('button', 'merge-btn', '取消');
    cancel.onclick = () => { mergeSource = null; renderFeed(); };
    wrap.appendChild(cancel);
  } else {
    const b = el('button', 'merge-btn', '⊕ 并入…');
    b.onclick = () => { mergeSource = root.id; renderFeed(); };
    wrap.appendChild(b);
  }

  for (const from of incoming) {
    const row = el('span', 'merged-in');
    row.appendChild(el('span', null, `已并入：${threadLabel(from)}`));
    const u = el('button', 'merge-btn undo', '撤销');
    u.title = '撤销这次合并。历史从来没被改过，所以一定回得到原样。';
    u.onclick = async () => {
      const ok = await callMerge('DELETE',
        `/api/rooms/${encodeURIComponent(current.id)}/threads/merge/${encodeURIComponent(from)}`);
      if (ok) await afterMergeChange();
    };
    row.appendChild(u);
    wrap.appendChild(row);
  }
  return wrap;
}

/**
 * 被并走的话题，在它**原来的位置**留下的一行痕迹。
 *
 * ★★★ **被并走的话题不能凭空消失**。它的消息确实还在
 *   （挂到目标话题底下了），但**人是按位置找东西的** —— 他记得它在这儿。
 *   什么都不留的话，他看到的是「我那个话题不见了」，
 *   而这个仓库对「静默消失」的态度不用再重复一遍。
 *
 * ⇒ 留一行，说清去哪了，并且**就地能撤销**。
 */
function renderMergeTrace(t) {
  const wrap = el('div', 'merge-trace');
  wrap.appendChild(el('span', 'tag', '已并走'));
  wrap.appendChild(el('span', null, `${threadLabel(t.from)} → 并入 ${threadLabel(t.to)}`));
  const u = el('button', 'merge-btn undo', '撤销');
  u.title = '把这个话题放回原处。历史没被改过，撤销一定回得到原样。';
  u.onclick = async () => {
    const ok = await callMerge('DELETE',
      `/api/rooms/${encodeURIComponent(current.id)}/threads/merge/${encodeURIComponent(t.from)}`);
    if (ok) await afterMergeChange();
  };
  wrap.appendChild(u);
  return wrap;
}

/** 「更早的话题」是否展开。同 openThreads —— 刷新即重置。 */
let olderOpen = false;

/**
 * 拉多少条房间历史。
 *
 * ⚠️ **一处出处**：`loadRoomHistory` 用它发请求，`renderOlderToggle` 用它
 *   写那句「只覆盖已加载的那批」。硬编码两份的话，改了一处之后那句提示
 *   就开始报一个假数字 —— 而它恰恰是用来说明「你看到的不是全部」的。
 *
 * ★★ 它和 48 小时窗口是**两层独立的截断**，谁先生效取决于房间有多活跃：
 *   活跃房间里 200 条可能只覆盖几小时 ⇒ 时间窗口基本不起作用；
 *   冷房间里 200 条能覆盖两周 ⇒ 时间窗口折掉绝大部分。
 *   两层都不许假装自己是全部，所以那句提示里两层都点了名。
 */
const ROOM_HISTORY_COUNT = 200;

/**
 * 更早话题的折叠条。
 *
 * ★★ **N 是真数目，而且必须说出口。** 只藏不说的话，人会把看到的当成全部 ——
 *   跟「静默丢消息」是同一个形状。
 *
 * ⚠️ 措辞卡死在「**这批历史里**更早的」，不许简化成「更早的全部话题」：
 *   `loadRoomHistory` 拉的是最近 N 条（上限 1000），**时间窗口之外还有一层
 *   条数截断**。这个数字只覆盖已经加载进来的那批 —— 说成「全部」就是
 *   拿一个查不到的范围冒充查得到的。
 */
function renderOlderToggle(olderSegs, count, noneFresh) {
  const wrap = el('div', 'older');
  // ★★ `noneFresh`：48 小时内一条新话题都没有时，界面上就只剩这一个折叠条 ——
  //   **那看起来跟「这个房间是空的」一模一样**，而那正是 `rootIdOf` 环保护
  //   那段警告过的同形歧义。所以这一档要把原因说出口，不能只留一行 ▸。
  const bar = el('button', 'older-toggle',
    `${olderOpen ? '▾' : '▸'} `
    + (noneFresh ? '最近 48 小时没有新话题 · ' : '')
    + `更早的 ${count} 个话题`);
  bar.title = '默认只显示最近 48 小时有动静的话题。\n'
            + '⚠️ 判据是话题里**最新一条**的时间 —— 三天前开的话题只要昨天还在回，'
            + '它就还在上面，不会被折进来。\n'
            + `这个数字只覆盖已经加载的那批历史（最近 ${ROOM_HISTORY_COUNT} 条），`
            + '不是全部历史 —— 时间窗口之外还有一层条数截断，'
            + '活跃的房间里往往是后者先生效。';
  bar.onclick = () => { olderOpen = !olderOpen; renderFeed(); };
  wrap.appendChild(bar);
  if (olderOpen) {
    const box = el('div', 'older-items');
    appendSegments(box, olderSegs);
    wrap.appendChild(box);
  }
  return wrap;
}

/** 哪些状态行是展开的（key = 这一串里第一条的 id）。同 openThreads，刷新即重置。 */
const openStatusRuns = new Set();

/** 取第一行做摘要。**按换行切，不按字符数** —— 换行是作者自己划的边界。 */
function statusSummary(text) {
  const first = String(text || '').split('\n').find((l) => l.trim()) || '';
  const one = first.trim();
  // 第一行本身过长时仍要截，但**截断必须带省略号**：被切断的第一句读起来
  // 像一句完整的话，人会照着它下判断（同 notice 那段不按字符数切的理由）。
  return one.length > 48 ? `${one.slice(0, 48)}…` : one;
}

/**
 * 一串相邻的 `status` 消息，收成一行。
 *
 * ★★★ **降级不是丢弃**：收成一行，但**点得开、
 *   查得到**。静默消失是这个仓库最反对的形状 —— 别为了清爽把它请回来。
 *   ⇒ 这一行是个按钮，展开后是原样的完整消息，一个字不少。
 */
/** 哪些重复串是展开的（key = 这一串里第一条的 id）。同 openStatusRuns，刷新即重置。 */
const openDupRuns = new Set();

/**
 * 一串**完全相同**的消息折成一行。
 *
 * ══════════════════════════════════════════════════════════════════
 * 同一句 watchdog 告警会连续重复很多次，能占掉私聊界面的大半版面 ——
 * 「找不到信息」最主要的成因就是它。
 *
 * ★ **条数写在行上，而且是真数目** —— 只藏不说的话，人会把看到的当成全部，
 *   那跟「静默丢消息」是同一个形状（`splitByAge` 那段注释写着同一句）。
 * ★ **摘要用第一行原文，不合成语义** —— 跟 `renderStatusRun` 逐字同一个理由：
 *   猜内容会把一条真正要紧的消息猜进垃圾堆，而这种误判零报错。
 * ★ 时间显示的是**最后一条**的 —— 人要知道「这事还在发生吗」，
 *   而首末两头里，只有末尾能回答它。
 *
 * ⚠️ 展开之后是**逐条**画出来的，一条都没丢 —— 折叠的是版面，不是内容。
 * ══════════════════════════════════════════════════════════════════
 */
function renderDupRun(seg) {
  const items = seg.items || [];
  const wrap = el('div', 'duprun');
  const key = items[0] && items[0].id;
  const open = openDupRuns.has(key);

  const bar = el('button', 'dup-line' + (open ? ' open' : ''));
  bar.appendChild(el('span', 'tag', '重复'));
  bar.appendChild(el('span', 'dup-who', seg.from || '?'));
  bar.appendChild(el('span', 'dup-what', statusSummary(seg.text || '')));
  bar.appendChild(el('span', 'dup-count', `× ${items.length}`));
  bar.appendChild(el('span', 'when', clock(items[items.length - 1].at)));
  bar.title = `${items.length} 条一模一样的消息（同一个发送者、正文逐字节相同、在流里相邻）`
            + '已收起。点开逐条查看 —— **一条都没有丢**。\n'
            + '⚠️ 判据是「完全相同」，不是「看起来像」—— 内容差一个字就不会被收进来。';
  bar.onclick = () => {
    if (open) openDupRuns.delete(key); else openDupRuns.add(key);
    renderFeed();
  };
  wrap.appendChild(bar);

  if (open) {
    const box = el('div', 'duprun-items');
    for (const e of items) box.appendChild(renderMsg(e));
    wrap.appendChild(box);
  }
  return wrap;
}

function renderStatusRun(items) {
  const wrap = el('div', 'statusrun');
  const key = items[0].id;
  const open = openStatusRuns.has(key);

  // 发送者去重但**保留出现顺序** —— 「dev、dev2」读起来跟事情发生的顺序一致。
  const who = [...new Set(items.map((e) => e.from))].join('、');
  // ★ 一条时直接显示它自己的第一行；多条时只报数目。
  //   **不合成语义**（不写「已上线」之类）—— 那是猜内容，判据只看 kind。
  const what = items.length === 1
    ? statusSummary(items[0].text)
    : `${items.length} 条状态`;

  const bar = el('button', 'status-line' + (open ? ' open' : ''));
  bar.appendChild(el('span', 'tag', '状态'));
  bar.appendChild(el('span', 'status-who', who));
  bar.appendChild(el('span', 'status-what', what));
  bar.appendChild(el('span', 'when', clock(items[items.length - 1].at)));
  bar.title = items.length === 1
    ? '这是一条状态消息（上线报到 / 自检 / 心跳）。点开看全文。'
    : `${items.length} 条相邻的状态消息已收起。点开逐条查看 —— 一条都没有丢。`;
  bar.onclick = () => {
    if (open) openStatusRuns.delete(key); else openStatusRuns.add(key);
    renderFeed();
  };
  wrap.appendChild(bar);

  if (open) {
    const box = el('div', 'statusrun-items');
    for (const e of items) box.appendChild(renderMsg(e));
    wrap.appendChild(box);
  }
  return wrap;
}

/**
 * 一个 thread 的回复区：折叠条 +（展开时）回复列表。
 *
 * ★ 默认折叠 —— 这个功能就是为了解决
 *   「消息太多，真正想找的信息反而看不到」。
 *   **默认展开等于什么都没改。**
 */
/**
 * 这条消息**是给人看的**吗。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 判据全部用**现成信号**，一个新字段都不加 —— 加一个字段要改至少 7 处
 *   手工白名单（包括消费侧 `bin/next.js`），漏一处的后果是
 *   编排者分不清「它没标」和「它标了但看不到」。
 *
 *   ① 流程事件    `【流程】` 开头 **或** `Threads.expectsReply(m)`
 *   ② 完成报告    `Threads.isDone(m)`
 *   ③ 点名要他    文本里有 `@Patrick`
 *
 * ── 🔴 三条「不许这么写」 ──────────────────────
 *   · **不许**用「@xxx 请开始」这类**文本形状**认流程事件：会有假阳性 ——
 *     普通消息会因为**正文里引用了**那句话而被认成流程事件，
 *     而假阳性的方向是「把噪音留在显示区」。
 *   · **不许**写 `if (m.expects_reply)`：`'false'` 是 truthy 字符串，
 *     流里绝大多数是 `'false'` ⇒ 几乎全被判成流程事件，折叠等于没做。
 *   · **不许**拿 `expects_reply` / `done` 直接跟布尔真值比较：流里存的是
 *     **字符串** ⇒ 一条都命中不了。⇒ 一律走 `Threads.*`，判据只有一处。
 *
 *   ⚠️ 上面这句故意不照代码字面写（不写出 `m.done ` 加三个等号加 `true`）——
 *     **`test/done-notify.test.js` 的正则断言把注释也算进源码**，
 *     在注释里写出字面会让那条断言变红。
 * ══════════════════════════════════════════════════════════════════
 */
//
// ★ 判据本体在 `web/derive.js`（`Derive.isForHuman`）——
//   右栏「需要你」要用**同一条**判据，而这个文件 Node require 不了、测不到。
//   这里只是转调，**不是第二份实现**；上面那三条「不许这么写」同样适用于那边。
function isForHuman(m) {
  return Derive.isForHuman(m);
}

/**
 * 一个 thread 的回复区。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★ **分层落在这里，不在顶层。** 顶层消息（段的根）按定义都没有 `reply_to`
 *   —— 「我在起一件事」，而**起一件事 ≈ 值得看**。
 *   真正该收起来的是**回复**：agent 之间的过程讨论。
 *
 *   ⚠️ 而 ①②③ 里的那几条**也可能出现在回复里** —— 交付报告、点名、完成报告
 *   都常常是回复。埋在「▸ N 条回复」后面 = **人最需要看到的
 *   「最后结果」正好被折掉了**。
 *   ⇒ 把它们**提到折叠条外面**，其余照旧折起来。
 *
 * ★ 折叠条上的数字是**被折的那些**，不是全部回复 —— 提出来的已经看得见了，
 *   再算进「还有 N 条没看」里，那个数字就谎报了它覆盖的内容。
 * ══════════════════════════════════════════════════════════════════
 */
function renderThread(t) {
  const wrap = el('div', 'thread');
  const replies = t.replies || [];
  const lifted = replies.filter(isForHuman);
  const folded = replies.filter((r) => !isForHuman(r));

  // 提上来的那些照常渲染（带一个 class，让样式能把它跟根消息区分开）
  // `data-mid` 是**测试用的定位锚点**（跟 `data-seg` 同一个性质）：
  // e2e 要断言「这条具体的消息在折叠区外面还是里面」，而按文本找脆得多。
  // ⚠️ 它只是个 DOM 属性，**不是消息字段**。
  for (const r of lifted) {
    const n = renderMsg(r);
    n.classList.add('lifted');
    n.dataset.mid = String(r.id);
    wrap.appendChild(n);
  }

  // ★ 全被提上来时**不画折叠条** —— 一个写着「0 条回复」的按钮点开是空的，
  //   那比不画更让人困惑。
  if (!folded.length) return wrap;

  const open = openThreads.has(t.root.id);
  const bar = el('button', 'thread-toggle',
    `${open ? '▾' : '▸'} ${folded.length} 条回复`);
  bar.title = lifted.length
    ? `这条下面还有 ${folded.length} 条 agent 之间的讨论。\n`
      + `（${lifted.length} 条「给你看的」已经提到上面了：流程事件 / 完成报告 / 点名要你的）`
    : '点开看这条下面的全部回复';
  bar.onclick = () => {
    if (open) openThreads.delete(t.root.id); else openThreads.add(t.root.id);
    renderFeed();
  };
  wrap.appendChild(bar);
  if (open) {
    const box = el('div', 'thread-replies');
    for (const r of folded) {
      const n = renderMsg(r);
      n.dataset.mid = String(r.id);
      box.appendChild(n);
    }
    wrap.appendChild(box);
  }
  return wrap;
}

/** 渲染单条消息。 */
function renderMsg(e) {
  {
    if (e.sys) {
      // watchdog / 系统事件 **混在时间流里**，不另开面板 —— 它跟它旁边那条
      // 发言是同一件事的两面，拆开就看不出因果了。
      // ★ 时间在左（跟消息的时间列对齐），告警（crit）那一行是红色块。
      const row = el('div', 'sys' + (e.crit ? ' crit' : ''));
      row.appendChild(el('span', 'when', clock(e.at)));
      const line = el('div', 'sys-l');
      line.appendChild(el('span', 'tag', e.tag || 'system'));
      line.appendChild(el('span', null, e.text));
      row.appendChild(line);
      return row;
    }
    // ── ★ 分类：只影响**视觉**，不影响它在不在列表里 ──
    //
    //   ⚠️ **不**只渲染「人开的话题 + 通知」——
    //   那样的话，一条 agent 发的、没标任何东西的消息会从界面上消失，
    //   而消息静默不见是这个项目最反对的形状。
    //   ⇒ **每一条都渲染，分类只决定它长什么样**（见 kindOf 头上那段）。
    const kind = Threads.kindOf(e);
    const msg = el('div', 'msg' + (e.from === 'Patrick' ? ' human' : '')
                              + (kind === 'notice' ? ' notice' : '')
                              + (kind === 'status' ? ' status' : '')
                              + (kind === 'orphan' ? ' orphan' : ''));
    // ★ 通知 / 未归属的标签挂进 `who` 那一格（名字后面），不做 `.msg` 的第一个子元素 ——
    //   时间列在左边距里，`.msg` 的 grid 只剩 who / 空 / 复制三格，多一个元素会把整行错开。
    const who = el('span', 'who', e.from);
    // 角色小标签（编排者 / agent），数据来自 /api/agents 的 type —— 查不到就不画，不猜。
    const t = agentTypes.get(e.from);
    if (t) who.appendChild(el('span', 'role-tag', t === 'orchestrator' ? '编排者' : 'agent'));
    if (kind === 'notice') {
      // ★ 通知**必须标明是通知**，而且**总结在前、细节可展开**。
      //   标题行放在最前面，人扫一眼就知道这条不是对话的一部分。
      const tag = el('span', 'notice-tag', '通知');
      tag.title = '这是 agent 主动发起的通知，不是某个话题里的回复。\n可以回复它 —— 回复会挂在这条下面。';
      who.appendChild(tag);
    } else if (kind === 'orphan') {
      // 🔴 协议违规：agent 发的，既不是回复也没标通知。
      //   **照常显示**，但让它看得见 —— 尤其要让发它的那个 agent 看得见。
      const tag = el('span', 'orphan-tag', '未归属');
      tag.title = '这条 agent 消息既没有 reply_to 也没标 notice。\n'
                + '按协议它应该是某个话题里的回复，或者一条标明的通知。\n'
                + '**它没有消失，只是没有归属** —— 发它的 agent 需要知道这件事。';
      who.appendChild(tag);
    }
    msg.appendChild(who);
    msg.appendChild(el('span', 'when', clock(e.at)));
    // ★ 「已发送」只对自己发的那条显示，而且**它只保证进了队列**。
    //
    //   不标的话这个信息是隐含的：消息只有在 202 之后才被插进列表，
    //   所以「它出现在屏幕上」就等于「它进了队列」——
    //   **但那要人去推理，而人不会推理，人只会看。**
    //
    //   ⚠️ 措辞卡在「已发送」，不许升级成「已送达」或「已读」：
    //     已发送  进了 orch:in:human           ← 现在唯一能保证的
    //     已送达  agent 把它领走了(XREADGROUP)  ← 查得到但不是实时
    //     已读    agent ack 了                  ← 同上
    //   **这跟「写了 outbox 不等于有人看到了」是同一条，
    //     只是方向反过来**:
    //     **危险的不是没送到,是以为送到了。**
    //
    // ⚠️ 挂在 `who` 里面，不是 `msg` 下面：`.msg` 是三列 grid
    //   （auto 1fr auto = who / when / 复制按钮），**多塞一个元素会把整行错开**，
    //   而错开的样子在只有自己消息的频道里看不出来 —— agent 的消息才会歪。
    if (e.from === 'Patrick' && e.sent !== false) {
      const s = el('span', 'sent', '✓ 已发送');
      s.title = '已进入队列（bus 返回 202）。\n'
              + '这不表示编排者已经读到它 —— 那要等它下一轮轮询。';
      who.appendChild(s);
    }
    // 整条消息的复制按钮，放在名字那一行右侧
    msg.appendChild(copyBtn(() => e.text, 'msg-copy'));
    const body = el('div', 'body');
    // ★ `innerHTML` 在这里是安全的**只因为** mdToHtml 里先 esc 后替换 ——
    //   那个顺序是这一行的全部前提，改 mdToHtml 之前先读那段注释。
    //
    // ── ★★ 通知：**总结在前，细节可展开** ──────────
    //
    //   判据是**第一个空行**：第一段当总结，其余折进 <details>。
    //   ⚠️ 只有一段的通知**不折叠** —— 折一个空的「展开」出来，人点开发现
    //   什么都没有，那比不折更糟（它承诺了不存在的内容）。
    //
    //   ⚠️ 为什么不用「前 N 个字符」：那会在句子中间切断，而**被切断的第一句
    //   读起来像一句完整的话**，人会照着它下判断。空行是作者自己划的边界。
    if (kind === 'notice') {
      const raw = String(e.text || '');
      const cut = raw.indexOf('\n\n');
      const head = cut > 0 ? raw.slice(0, cut) : raw;
      const rest = cut > 0 ? raw.slice(cut + 2).trim() : '';
      const sum = el('div', 'notice-summary');
      sum.innerHTML = mdToHtml(head);
      body.appendChild(sum);
      if (rest) {
        const det = document.createElement('details');
        const sm = document.createElement('summary');
        sm.textContent = '细节';
        det.appendChild(sm);
        const more = el('div', 'notice-detail');
        more.innerHTML = mdToHtml(rest);
        det.appendChild(more);
        body.appendChild(det);
      }
    } else {
      body.innerHTML = mdToHtml(e.text);
    }
    // 每个代码块单独一个复制按钮 —— 代码块里往往是要直接粘进终端的命令，
    // 而整条消息的复制会把周围的散文一起带上。
    for (const pre of body.querySelectorAll('pre')) {
      pre.appendChild(copyBtn(() => pre.textContent, 'pre-copy'));
    }
    // 复盘时要核「这条是从哪条流查到的」—— `from` 一个字段答不了。
    if (e.stream) body.title = `${e.stream}${e.direction ? ` · ${e.direction}` : ''}`;
    msg.appendChild(body);

    // ★ 「回复」房间和私聊都有。
    //   放在 body 之后、整条消息之内，点了之后输入框上方会显示「正在回复谁」。
    //
    // ★★ 判据是 **`e.id` 在不在**，不是「这是哪种频道」——
    //   `e.id` 就是这条消息的**锚点**（房间取房间流 id，私聊取 job_id，
    //   见 `anchorOf()`）。**没有锚点的消息不给回复按钮**：
    //   老记录、导入的历史、走了别的路径的消息都可能没有。
    //
    //   ⚠️ **绝不回落到别的 id 凑一个出来**（比如私聊回落到 stream id）——
    //   那样按钮是有了，而它生成的 `reply_to` 指向一个查不到的父，
    //   于是回复显示成顶层：**跟没回复过一模一样，零报错**。
    //   ⇒ 缺席就如实呈现成「这条不能回」。这里的缺席语义跟 `expects_reply`
    //   正好相反：那边缺席必须读成一个明确的 false，这边缺席就是缺席。
    if (e.id) {
      const rb = el('button', 'reply-btn', '回复');
      rb.title = '回到这条的 thread 里 —— 不会刷在主列表上';
      rb.onclick = () => setReplyTarget(e);
      msg.appendChild(rb);
    }
    // ★ 撤回入口：只在**真撤得掉**的那条上出现
    if (e.id) {
      const wb = renderWithdraw(e);
      if (wb) msg.appendChild(wb);
    }
    // ★ 反应条：放在「回复」之后、整条消息之内。判据跟回复按钮同一条 ——
    //   **`e.id` 就是锚点**（房间取房间流 id，私聊取 job_id，见 `anchorOf()`）。
    //   没有锚点的消息不给反应条：反应挂在锚点上，没锚点就无处可挂，
    //   硬给一个的话点下去会写进一个查不回来的 key，**而界面上看起来点成功了**。
    if (e.id) msg.appendChild(renderReactions(e));
    return msg;
  }
}

// ══════════════════════════════════════════════════════════════════════
//  每条消息上的撤回入口
// ══════════════════════════════════════════════════════════════════════
//
// 撤回能力在后端（`/api/queue/items` + `/api/queue/cancel`）；右侧 agent 行的
// hover 弹层里那个入口很难找到，所以每条消息上也给一个。
//
// ══════════════════════════════════════════════════════════════════════
// ★★★ **按钮只出现在真能撤的那条消息上。**
//
//   还在队列没被领走 → 有按钮，点了真撤掉
//   已经被 agent 领走 → **没有按钮**
//
//   🚫 绝不对每条消息都画一个撤回按钮。**点一个撤不掉的东西、再收到一句
//   「已撤回」，比没有这个按钮坏得多** —— 那是给人一个错误的世界模型，
//   而他会据此以为那条指令不会执行。
//
//   （同一条线上的既有措辞：`.msg` 里那个「✓ 已发送」——它只保证进了队列，
//     不保证 agent 读到。**撤回能力的边界不能比那个措辞更宽。**）
// ══════════════════════════════════════════════════════════════════════

/**
 * 这条消息现在还撤得掉吗 —— 撤得掉就返回它在队列里的条目。
 *
 * ★ 键是 **`job_id`**，两边都有：
 *   `/api/messages` 的条目带 job_id；`/api/queue/items` 的条目也带。
 *   而私聊 entry 的 `e.id` 就是 job_id（`anchorOf(m,'dm')`），
 *   **包括刚发出还没刷新的那条** —— `POST /api/message` 的 202 响应返回
 *   job_id，回显时直接用了它。那条恰恰是最可能想撤回的。
 *
 * ⚠️ **只认 `state === 'queued'`。** `in_flight`（已投未 ack）删掉队列记录
 *   不会让 agent 停下，它会照常干完 —— 那种情况下给按钮就是在骗人。
 *
 * ⚠️⚠️ **一个如实标着的假阴性**：`/api/queue/items` 默认不含 `done`，
 *   而且只从流尾往回取 100 条。所以「找不到」有两种可能：
 *     · 已经处理完了            → 不给按钮，**对**
 *     · 落在 100 条窗口之外     → 它可能其实还在队列里，**该给却没给**
 *   后者是假阴性：人撤不了一条本来撤得掉的，得回去用右侧那个队列面板。
 *   **这个缺口没有被修掉，是有意接受的** —— 因为反过来那种
 *   （给了按钮却撤不掉）会造出一个错误的世界模型，而那是明令禁止的。
 *   ⇒ 两种错的代价不对称，所以往保守那边倒。
 *
 * ★ job_id 是 UUID，全局唯一 ⇒ 跨收件人遍历不会撞。
 *   （条目数按定义很少：积压长到需要索引时，那本身就是要报告的事。）
 */
function queuedItemFor(jobId) {
  if (!jobId) return null;
  for (const g of queueByRecipient.values()) {
    for (const it of g.items || []) {
      if (it.job_id === jobId && it.state === 'queued') return { it, recipient: g.recipient };
    }
  }
  return null;
}

/**
 * 撤回入口。**返回 null = 不画任何东西**（缺席即「撤不掉」，这是诚实的）。
 *
 * ⚠️ 房间频道一律不画。不是「先不做」——**这个动作在房间里还没有定义**：
 *   一条房间发言会被扇出成 N 份投递，「撤回它」= 撤回还没被领走的那几份，
 *   而没有任何一个 id 能代表「那条发言」。硬造一个出来，等于替人定义了
 *   一个他没要求过的语义，**而他点下去时以为的是「这条不会被处理」**。
 */
function renderWithdraw(e) {
  if (current.kind !== 'dm') return null;      // 房间：见上
  if (e.from !== 'Patrick') return null;       // 只能撤自己发的

  // ★★ 返回一个**带锚点的空壳**，即使此刻撤不掉 —— 理由是时机：
  //
  //   队列数据由 `pollQueueItems()` 刷新（挂在 `pollAgents` 上，每 5 秒），
  //   而它之后只 `renderAgents()`，**不重画消息流**。
  //   ⇒ 人刚发出一条消息时 `queueByRecipient` 还是旧的、按钮不会出现，
  //     而那恰恰是最想撤回的时刻。
  //
  //   ⚠️ **不能靠「每 5 秒 renderFeed 一次」解决**：`renderFeed` 结尾有
  //     `feed.scrollTop = feed.scrollHeight`（自动滚到底）——
  //     那会在人读历史时每 5 秒把他弹回底部。
  //     **一个为了让按钮及时出现而毁掉阅读的修法，代价比它解决的问题大。**
  //
  //   ⇒ 空壳留在原地，`refreshWithdrawBars()` 在数据刷新后只填这些壳，
  //     不碰消息流的其余部分、不动滚动位置。
  const bar = el('div', 'withdraw-bar');
  bar.dataset.job = e.id;
  fillWithdraw(bar);
  return bar;
}

/** 按当前队列数据填充一个撤回条。撤不掉就是**空的** —— 缺席即「撤不掉」。 */
function fillWithdraw(bar) {
  const hit = queuedItemFor(bar.dataset.job);
  bar.replaceChildren();
  if (!hit) return;

  const w = el('button', 'withdraw-btn', '撤回');
  w.title = `这条还在 ${hit.recipient} 的队列里、没被领走 —— 现在撤是真撤回。`;
  // ★ 复用现有的 `cancelQueueItem` —— 它已经做对了三件事：先确认、
  //   **原样呈现服务端的 reason**（尤其「晚了一步」那种）、网络失败时明说
  //   「那条消息还在队列里」。在这里另写一份请求逻辑 = 第二处出处，
  //   而那三条守卫会在第二份里悄悄少掉一条。
  w.onclick = () => cancelQueueItem(hit.it, hit.recipient);

  const rw = el('button', 'withdraw-btn rewrite', '撤回改写');
  // ★ 不叫「编辑」：队列条目不可改，改一条的实际行为是删掉再发一条新的，
  //   而新条目**排在队尾**。叫「编辑」就是名实不符。
  //   （`withdrawAndRewrite` 头上那段写了全部理由，这里不重复。）
  rw.title = '撤回它，并把原文填回输入框 —— 你改完自己发（新的那条自然排在队尾）。';
  rw.onclick = () => withdrawAndRewrite(hit.it, hit.recipient);

  bar.appendChild(w);
  bar.appendChild(rw);
}

/**
 * 队列数据刷新之后，把已经在页面上的撤回条重新填一遍。
 *
 * ★ 只动这些壳，**不重画消息流** —— 见 `renderWithdraw` 里那段（滚动位置）。
 * ★ 按 DOM 现查，不缓存节点：消息流随时可能被 `renderFeed` 整树重建。
 *   （跟 emoji 那边 `reactNodes()` 同一个理由。）
 */
function refreshWithdrawBars() {
  for (const bar of document.querySelectorAll('.withdraw-bar[data-job]')) fillWithdraw(bar);
}

// ══════════════════════════════════════════════════════════════════════
//  emoji 反应
// ══════════════════════════════════════════════════════════════════════
//
// ── ★★ 为什么批量合并写在这里，而不是 `renderFeed` 里 ────────────────
//   「渲染前一次把整屏的反应拿回来」是自然写法，但那要把反应的逻辑写进
//   `renderFeed`。这里改成：**反应条自己渲染时登记锚点**，
//   用一个微任务把同一帧登记的全部锚点合并成**一次** `POST /batch`。
//   请求次数跟写在 renderFeed 里一样是 1 次，而代码全在这一段内。
//
//   ⚠️ 微任务而不是 `setTimeout(0)`：微任务在当前同步渲染循环**结束后立刻**
//     执行，中间不会插进一帧渲染 —— 用 setTimeout 的话，整屏消息会先画出来
//     一次没有反应条的样子，然后闪一下补上。

/** 语义表。**只从后端拿，前端不留第二份** —— 两份表会各自漂移，零报错。 */
let reactSemantics = null;
/** `${scope}:${anchor}` → reactions[]（后端算好的，带完整语义） */
const reactCache = new Map();
/**
 * 还没拿到数据的锚点 —— **存 key，不存 DOM 节点**。
 *
 * ── ★★★ 为什么绝不能存节点引用 ────────────
 *   `renderFeed` 是 `replaceChildren()` **整树重建**，而轮询每几秒触发一次：
 *
 *     T0  渲染反应条 → 登记 → 发出 batch 请求
 *     T1  轮询回来 → renderFeed 重建 → 登记的那些节点全被丢弃
 *     T2  响应到达 → 回填到**已经不在文档里的节点上**
 *         ⇒ 反应不显示、零报错，而下一次渲染又会重来一遍
 *         ⇒ **「有时显示有时不显示」—— 那种 bug 最难复现**
 *
 *   还有更糟的一半：请求飞行途中人切了频道，回填会落到**另一个频道**
 *   的消息上（`select()` 里换 feeds），那比不显示还坏。
 *
 *   ⇒ 回填一律**按锚点重查当前 DOM**（`reactNodes()`）。
 *     锚点全局唯一，这一个动作同时挡住上面两种。
 *     **别假设你发请求时的那棵树还在。**
 */
const reactWanted = new Set();
/** 已经发出去、还没回来的 key —— 今天视图每次重画都会问一遍，别重复登记。 */
const reactInflight = new Set();
/** 取过但报错的 key —— 今天视图写「核验状态查不了」，不写「核验中」。 */
const reactFailed = new Set();

/**
 * 当前文档里挂着这个锚点的反应条。**每次回填前现查，不缓存节点。**
 * 查不到就说明那棵树已经被重建了 —— 那时什么都不做是对的：
 * 数据已经进了 `reactCache`，重建时 `renderReactions` 会同步画出来。
 */
function reactNodes(scope, anchor) {
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
  return document.querySelectorAll(
    `.reactions[data-scope="${esc(scope)}"][data-anchor="${esc(anchor)}"]`);
}
/** 当前还没结账的待确认动作，按锚点分组 */
const reactPending = new Map();
let reactFlushQueued = false;

/** 网页这一侧的身份。跟发消息那里用的是同一个常量来源。 */
const REACT_ME = 'Patrick';

const reactScope = () => (current.kind === 'room' ? 'room' : 'dm');
const rKey = (scope, anchor) => scope + ':' + anchor;

async function ensureReactSemantics() {
  if (reactSemantics) return reactSemantics;
  const r = await fetch('/api/reactions/semantics');
  if (!r.ok) throw new Error('语义表读不到');
  reactSemantics = await r.json();
  return reactSemantics;
}

/**
 * 渲染一条消息的反应条。
 *
 * 先返回一个占位容器，数据回来之后回填 —— **同步渲染路径上不做网络请求**。
 */
function renderReactions(e) {
  const scope = reactScope();
  const anchor = e.id;
  const bar = el('div', 'reactions');
  bar.dataset.scope = scope;
  bar.dataset.anchor = anchor;

  const k = rKey(scope, anchor);
  // ★ 缓存命中就同步画出来 —— 这也是整树重建之后反应条能立刻回来的原因：
  //   数据在 cache 里，不用再发一次请求。
  if (reactCache.has(k)) fillReactions(bar);
  else {
    // 占位：**什么都不画**（不是画一个「加载中」）——
    // 绝大多数消息没有反应，一行「加载中」会在整屏闪一遍然后消失。
    reactWanted.add(k);
    scheduleReactFetch();
  }
  return bar;
}

function scheduleReactFetch() {
  if (reactFlushQueued) return;
  reactFlushQueued = true;
  queueMicrotask(flushReactFetch);
}

async function flushReactFetch() {
  reactFlushQueued = false;
  if (!reactWanted.size) return;

  // 按 scope 分组 —— 两个 id 空间各自独立，绝不能混在一个请求里
  const byScope = new Map();
  for (const k of reactWanted) {
    const i = k.indexOf(':');
    const scope = k.slice(0, i), anchor = k.slice(i + 1);
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(anchor);
  }
  // ★ 取走就清空：这一批已经在飞了。留着的话，下一次渲染会把同一批
  //   重新登记一遍，于是同一个锚点被查两次 —— 不出错，但白打请求。
  reactWanted.clear();
  for (const [scope, anchors] of byScope) for (const a of anchors) reactInflight.add(rKey(scope, a));

  for (const [scope, anchors] of byScope) {
    try {
      await ensureReactSemantics();
      const r = await fetch('/api/reactions/batch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, anchors }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || `HTTP ${r.status}`);

      // ⚠️ **超限必须说出来**，不能悄悄少显示几条反应。
      if (d.truncated) {
        push(keyOf(current), { sys: true, crit: true, tag: 'reactions',
          at: Date.now(),
          text: `这一屏有 ${d.truncated.asked} 条消息要查反应，只查了前 ${d.truncated.used} 条 —— `
              + '剩下的反应条现在是空的，但那不表示它们没有反应。' });
      }
      for (const anchor of anchors) {
        reactCache.set(rKey(scope, anchor), (d.reactions && d.reactions[anchor]) || []);
        reactFailed.delete(rKey(scope, anchor));
      }
      await loadReactPending();
      // ★ 回填反应条会让对话流变高。人原来就在底部的话，填完仍然留在底部 ——
      //   否则刚打开一个房间，最新那几条就被反应条顶到视口下面去了。
      //   不在底部（在读历史）就不动，跟 restoreScroll 的规矩一致。
      const feedEl = $('feed');
      const stayBottom = isNearBottom(feedEl);
      for (const anchor of anchors) fulfilReactNodes(scope, anchor);
      if (stayBottom && feedEl) feedEl.scrollTop = feedEl.scrollHeight;
    } catch (err) {
      // ★★ 「读不到」必须说成「读不到」，不能画成「没有反应」——
      //   那两件事在界面上长得一模一样，而后者会让人以为自己点的东西没生效。
      //   （`rooms.httpError` 那句「这不是『房间没有消息』，是『读不到』」同理。）
      for (const anchor of anchors) {
        reactFailed.add(rKey(scope, anchor));
        // ★ 同样按锚点重查，不用飞行前的节点引用（见 `reactWanted` 头上那段）
        for (const node of reactNodes(scope, anchor)) {
          node.replaceChildren();
          const warn = el('span', 'react-err', '⚠ 反应读不到');
          warn.title = `${err.message}\n这不是「这条消息没有反应」，是没查成 —— 别据此下结论。`;
          node.appendChild(warn);
        }
      }
    } finally {
      for (const anchor of anchors) reactInflight.delete(rKey(scope, anchor));
    }
  }
  // 「刚完成」的核验状态要看反应 —— 回来了就重画（今天视图不在前台时这是空操作）
  renderToday();
}

/** 按锚点回填当前文档里的反应条。查不到节点是正常情况 —— 那棵树重建过了。 */
function fulfilReactNodes(scope, anchor) {
  for (const node of reactNodes(scope, anchor)) fillReactions(node);
}

/** 拉还没结账的待确认动作。数量很少（有一条就该有人去处理），一次全拿。 */
async function loadReactPending() {
  try {
    const r = await fetch('/api/reactions/pending');
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return;
    reactPending.clear();
    for (const p of d.pending || []) {
      const k = rKey(p.scope, p.anchor);
      if (!reactPending.has(k)) reactPending.set(k, []);
      reactPending.get(k).push(p);
    }
  } catch { /* 待确认列表拉不到时反应条照常显示 —— 降级，不阻断 */ }
}

function fillReactions(bar) {
  const { scope, anchor } = bar.dataset;
  const list = reactCache.get(rKey(scope, anchor)) || [];
  bar.replaceChildren();

  for (const x of list) {
    const mine = (x.users || []).some((u) => u.by === REACT_ME);
    const chip = el('button', 'react-chip' + (mine ? ' mine' : '') + (x.known ? '' : ' unknown'));
    chip.appendChild(el('span', 'react-emoji', x.emoji));
    chip.appendChild(el('span', 'react-count', String(x.count)));
    // ★ 未知 emoji **看得见地**标出来。静默显示成普通反应的话，
    //   点的人会以为对应动作执行了 —— 而什么都没发生。
    if (!x.known) chip.appendChild(el('span', 'react-badge', '无动作'));
    else if (x.costs_quota) chip.appendChild(el('span', 'react-badge cost', '花额度'));
    chip.title = [
      x.known ? `${x.emoji} ${x.label}` : `${x.emoji} —— ${x.notice || '没绑动作'}`,
      x.hint || '',
      `谁点的：${(x.users || []).map((u) => u.by).join('、')}`,
      mine ? '（再点一下取消我这个）' : '',
    ].filter(Boolean).join('\n');
    chip.onclick = () => toggleReaction(scope, anchor, x.emoji, mine);
    bar.appendChild(chip);
  }

  const add = el('button', 'react-add', '☺+');
  add.title = '给这条消息加一个反应';
  add.onclick = (ev) => { ev.stopPropagation(); openReactPicker(bar, add); };
  bar.appendChild(add);

  // ── 待确认动作：**看得见、可撤回** ────────────────────────────────
  for (const p of reactPending.get(rKey(scope, anchor)) || []) {
    const row = el('div', 'react-pending');
    row.appendChild(el('span', 'react-pending-tag', '待确认'));
    row.appendChild(el('span', null,
      `${p.emoji} ${p.label} —— ${p.by} 点的`
      + (p.costs_quota ? '（会花额度）' : '')));
    const okBtn = el('button', 'react-confirm', '确认执行');
    // ★★ 确认是**按钮**，不是再点一个 emoji。理由由后端跟着语义表一起吐出来，
    //   这里把它放进 title：拿同一个易误点的通道去确认它自己，
    //   两道关会被同时误点 —— 那不是两段，是一段点了两次。
    okBtn.title = (reactSemantics && reactSemantics.confirm_note)
      || '确认之后这个动作才会真正执行。';
    okBtn.onclick = () => settleReactPending(scope, anchor, p.id, 'confirm');
    const noBtn = el('button', 'react-cancel', '撤回');
    noBtn.title = '撤回这个待确认动作。**撤回不会删掉它的记录** —— 谁点的、谁撤的都留着。';
    noBtn.onclick = () => settleReactPending(scope, anchor, p.id, 'cancel');
    row.appendChild(okBtn);
    row.appendChild(noBtn);
    bar.appendChild(row);
  }
}

/**
 * 反应条下面那行一次性提示（加了 C 档 / 点了未知 emoji / 取消后 pending 还在）。
 *
 * ⚠️ **按锚点重查，不接收节点** —— 这些提示全都在一次 `await` 之后才写，
 *   而那期间轮询可能已经把整棵树重建了。写进一个被丢弃的节点 =
 *   **人点了之后什么提示都看不到**，而那正是这些提示要防的那种静默。
 */
function reactNote(scope, anchor, text, cls) {
  for (const bar of reactNodes(scope, anchor)) {
    const old = bar.querySelector('.react-note');
    if (old) old.remove();
    if (!text) continue;
    bar.appendChild(el('div', 'react-note' + (cls ? ' ' + cls : ''), text));
  }
}

/**
 * 加 / 取消一个反应。
 *
 * ★ 收 `scope, anchor` 而不是 DOM 节点 —— 跟 `reactNote` / `refreshReactions`
 *   一致：这个函数里全是 `await`，而节点随时可能被整树重建丢弃。
 */
async function toggleReaction(scope, anchor, emoji, mine) {
  try {
    const r = await fetch(`/api/reactions/${scope}/${encodeURIComponent(anchor)}`, {
      method: mine ? 'DELETE' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emoji, by: REACT_ME }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { reactNote(scope, anchor, d.next || d.message || `失败（HTTP ${r.status}）`, 'err'); return; }

    let note = '';
    if (mine) {
      // ★★ 取消了一个曾经生成过待确认动作的反应 —— **立刻说出来**。
      //   人的心智模型是「取消 = 没发生过」，而那条动作还在列表里等着被确认。
      if (d.notice) note = d.notice;
    } else if (d.semantic && !d.semantic.known) {
      note = `${emoji} 没有绑定任何动作 —— 它被记下来了，但不会触发任何事。`;
    } else if (d.pending) {
      note = `已生成一条待确认动作（${d.semantic.label}）—— 它还没执行，下面可以确认或撤回。`;
    } else if (d.semantic && d.semantic.costs_quota) {
      note = `${d.semantic.label}：已触发，这一次会消耗额度。`;
    }
    await refreshReactions(scope, anchor);
    reactNote(scope, anchor, note);
  } catch (err) {
    reactNote(scope, anchor, `没发出去：${err.message}`, 'err');
  }
}

async function settleReactPending(scope, anchor, id, what) {
  try {
    const r = await fetch(`/api/reactions/pending/${encodeURIComponent(id)}/${what}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: REACT_ME }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      // ★ 409（已经结过账）不是「失败」，是「它已经是别的状态了」。
      //   把后端给的 next 原样呈现 —— 它说得出「谁在什么时候结的」。
      reactNote(scope, anchor, d.next || d.message || `失败（HTTP ${r.status}）`, 'err');
      await refreshReactions(scope, anchor);
      return;
    }
    await refreshReactions(scope, anchor);
    reactNote(scope, anchor,
      what === 'confirm' ? '已确认，动作会被执行。' : '已撤回 —— 记录留着，看得见是谁撤的。');
  } catch (err) {
    reactNote(scope, anchor, `没发出去：${err.message}`, 'err');
  }
}

/** 重拉一条消息的反应并重画。**按锚点找节点**，同 `reactNote` 头上那段。 */
async function refreshReactions(scope, anchor) {
  const r = await fetch(`/api/reactions/${scope}/${encodeURIComponent(anchor)}`);
  const d = await r.json().catch(() => ({}));
  if (r.ok) reactCache.set(rKey(scope, anchor), d.reactions || []);
  await loadReactPending();
  fulfilReactNodes(scope, anchor);
}

/** 选 emoji 的小面板。**按档分组，并把判据写在上面** —— 人要看得见为什么有的要确认。 */
async function openReactPicker(bar, anchorBtn) {
  // ★ 先取值。`await` 之后这个 bar 可能已经被整树重建丢弃了 ——
  //   分离节点的 dataset 照样读得到，所以取值安全；**用它当挂载点才不安全**。
  const { scope, anchor } = bar.dataset;
  document.querySelectorAll('.react-picker').forEach((n) => n.remove());
  let sem;
  try { sem = await ensureReactSemantics(); }
  catch {
    reactNote(scope, anchor, '语义表读不到 —— 现在没法选 emoji（这不是「没有可选的」）。', 'err');
    return;
  }

  const pick = el('div', 'react-picker');
  const groups = [['A', '表态'], ['B', '会执行'], ['C', '要确认']];
  for (const [tier, title] of groups) {
    const items = sem.emojis.filter((x) => x.tier === tier);
    if (!items.length) continue;
    const g = el('div', 'react-group');
    const h = el('div', 'react-group-title', title);
    h.title = (sem.tiers[tier] && sem.tiers[tier].desc) || '';
    g.appendChild(h);
    for (const x of items) {
      const b = el('button', 'react-pick');
      b.appendChild(el('span', 'react-emoji', x.emoji));
      b.appendChild(el('span', 'react-pick-label', x.label));
      // ★ 花不花钱写在按钮上，**点之前**就看得见 ——
      //   写成注释的话，点按钮的人永远看不见它。
      if (x.costs_quota) b.appendChild(el('span', 'react-badge cost', '花额度'));
      if (tier === 'C') b.appendChild(el('span', 'react-badge warn', '要确认'));
      b.title = x.hint || '';
      b.onclick = () => { pick.remove(); toggleReaction(scope, anchor, x.emoji, false); };
      g.appendChild(b);
    }
    pick.appendChild(g);
  }
  const rules = el('div', 'react-rules', (sem.tier_rules || []).join('　'));
  rules.title = '分档判据 —— 决定一个 emoji 是「一点就执行」还是「要确认」。';
  pick.appendChild(rules);

  // ★ 挂载点也按锚点现查 —— `anchorBtn` 是 `await` 之前拿的，
  //   那棵树可能已经重建，挂上去的面板会**存在但看不见**（挂在分离节点上）。
  //   查不到就说明这条消息已经不在当前视图里，那时不弹面板是对的。
  const host = reactNodes(scope, anchor)[0];
  if (!host) return;
  host.appendChild(pick);
  const off = (ev) => {
    if (!pick.contains(ev.target) && ev.target !== anchorBtn) {
      pick.remove(); document.removeEventListener('click', off);
    }
  };
  setTimeout(() => document.addEventListener('click', off), 0);
}

// ── 渲染：频道标题栏 + 输入框 ──────────────────────────────────
function renderBar() {
  const isRoom = current.kind === 'room';
  $('ch-hash').textContent = isRoom ? '#' : '@';
  $('ch-name').textContent = current.name;

  const mem = $('ch-members');
  mem.replaceChildren();
  for (const m of current.members || []) mem.appendChild(el('span', 'mem', m));

  // 房间的 hash 和条数**不是装饰** —— 它是「历史的真相在哪」。
  // 房间流 append-only，拿着这个 hash 随时能把当时发生了什么重放出来。
  $('ch-sub').textContent = isRoom
    ? `${current.id} · ${current.count ?? '—'} 条 · append-only，可回溯`
    : '私聊 · 历史不保证可回溯（房间流才是真相）';

  // ★ 人只能对编排者说话。发给 agent 走的是 JARVIS 派活，不是直连 ——
  //   这里让输入框**真的禁用**，而不是让人打完字才发现发不出去。
  const canSend = isRoom || current.id === ORCH;
  $('input').disabled = !canSend;
  $('send').disabled = !canSend;
  // 改了发送键就必须说出来 —— 不说的话人按 Enter 没反应，会以为发送坏了。
  $('input').placeholder = canSend
    ? '说点什么…（Ctrl/⌘+Enter 发送，Enter 换行）'
    : `发给 ${current.name} 要通过 ${ORCH} 派活`;
  // ★ 「这条会发到哪」必须一眼可见。一行灰色小字很容易看漏，
  //   看漏的人会把私聊当成房间发言。**一条消息属于哪里，在按发送那一刻就定死了**，
  //   而发错的后果是「房间里的人永远看不到，且没有任何报错」。
  const to = $('to');
  to.textContent = isRoom ? `发到 #${current.name}` : `发到 @${current.name}（私聊）`;
  to.className = 'to ' + (isRoom ? 'to-room' : 'to-dm');
  to.title = isRoom
    ? '这条会进房间流，房间成员和所有打开页面的人都看得到'
    : `这条只有 ${current.name} 看得到，不会出现在任何房间里`;
  // 今天视图的抽屉标题是同一个 `current`
  renderDrawerHead();
}

function select(ch, { fromRoute = false } = {}) {
  current = ch;
  // ★ 未读清零 + 路由跟着走。`fromRoute` 时不回写地址栏（那正是地址栏刚给的）。
  // ★ 今天视图里换频道是换**抽屉**里的频道 —— 地址栏仍然是 `#/today`，不切视图。
  //   对话视图下次打开时停在同一个频道：tab 是按 `current` 拼路由的。
  unread.delete(keyOf(ch));
  if (!fromRoute && view !== 'today') setRoute(chatRouteOf(ch), { replace: view === 'chat' });
  closeOverlays();
  // ★★ 换频道必须清掉回复目标。**这是这个功能里最危险的一行。**
  //   不清的话：在 A 房间点了「回复」→ 切到 B 房间 → 发言 →
  //   那条带着 A 的 reply_to 进了 B，挂在一条 B 里不存在的父消息上，
  //   **于是显示成顶层 —— 跟没回复过一模一样，而且零报错。**
  //   （同一个形状：房间消息用 username 回，也是「静默地去了别处」。）
  setReplyTarget(null);
  // 展开状态也跟着清 —— thread id 是每个房间自己的 id 空间，
  // 留着只会让另一个房间里某条不相干的消息凭空张开。
  openThreads.clear();
  renderBar();
  renderFeed();
  renderChannels();
  if (ch.kind === 'room') loadRoomHistory(ch.id);
  else loadDmHistory(ch.id);
}

// ── 渲染：左栏频道 ─────────────────────────────────────────────
/**
 * 左栏一行。除了名字还有两样：
 *   · `unreadN`：这次页面加载里经 WS 推来、而你没在看的条数（`.u` 黑底小胶囊）
 *   · `st`：私聊对象的状态（STATUS 表里那一项）—— 点 + 符号，**不只靠颜色**
 * `count` 是房间流的总条数，跟未读分开画、不合成一个。
 */
function channelBtn(hash, name, count, on, onClick, { unreadN = 0, st = null } = {}) {
  const b = el('button', 'chan' + (on ? ' on' : ''));
  b.type = 'button';
  if (st) {
    const d = el('span', 'dot ' + st.cls);
    d.setAttribute('aria-hidden', 'true');
    b.appendChild(d);
  } else {
    b.appendChild(el('span', 'hash', hash));
  }
  b.appendChild(el('span', 'nm', name));
  if (st && (st.cls === 'deaf' || st.cls === 'limit' || st.cls === 'warn')) {
    const g = el('span', 'g ' + st.cls, st.glyph);
    g.title = st.label;
    b.appendChild(g);
  }
  if (unreadN) {
    const u = el('span', 'u', String(unreadN));
    u.title = `${unreadN} 条新消息（这次打开页面之后推来的）`;
    b.appendChild(u);
  }
  if (count != null) b.appendChild(el('span', 'n', String(count)));
  b.title = st ? `${hash}${name} · ${st.glyph} ${st.label}` : `${hash}${name}`;
  b.onclick = onClick;
  return b;
}

/**
 * 房间列表只显示最近这么多天的。
 *
 * ⚠️ 过滤掉的房间**不会有任何提示** —— 所以下面那个 `hidden` 计数要显示出来。
 *   一个「安静地少了几个」的列表，和一个「本来就只有这几个」的列表，长得一模一样。
 */
const ROOM_MAX_AGE_DAYS = 10;

/**
 * 房间的活跃时间。
 *
 * ★ 优先 `last_activity_at`（流里最后一条的时间），
 *   **回退 `created_at`** —— 因为 `lib/*.js` 是 bus **启动时** require 的，
 *   而 web/ 每次请求读盘：**bus 没重启时，前端可能拿到没有这个字段的数据。**
 *   回退期间的表现：排序退化成「按建房时间」，过滤会误伤活跃的老房间。
 */
function roomActiveAt(r) {
  const t = Date.parse(r.last_activity_at || r.created_at || '');
  return Number.isFinite(t) ? t : 0;
}

function renderChannels() {
  const rb = $('rooms');
  rb.replaceChildren();
  if (!roomList.length) rb.appendChild(el('div', 'empty', '还没有房间'));

  // ★ 前端**自己再排一次**，不假设后端一定排好了 ——
  //   一个没重启的旧 bus 可能返回升序。两处各自成立、互不依赖。
  const cutoff = Date.now() - ROOM_MAX_AGE_DAYS * 86400_000;
  const sorted = [...roomList].sort((a, b) => roomActiveAt(b) - roomActiveAt(a));
  const shown = sorted.filter((r) => roomActiveAt(r) >= cutoff);
  const hidden = sorted.length - shown.length;

  for (const r of shown) {
    const on = current.kind === 'room' && current.id === r.hash;
    rb.appendChild(channelBtn('#', r.name, r.message_count, on, () => select({
      kind: 'room', id: r.hash, name: r.name, members: r.members || [], count: r.message_count,
    }), { unreadN: unread.get('room:' + r.hash) || 0 }));
  }
  // ★★ 被折叠的那些**必须说出来**。只显示剩下的话，
  //   「安静地少了 7 个」和「本来就只有这 3 个」在界面上一模一样，
  //   而人会拿后者当事实去做判断。
  if (hidden > 0) {
    rb.appendChild(el('div', 'empty',
      `还有 ${hidden} 个房间超过 ${ROOM_MAX_AGE_DAYS} 天没动静，已折叠`));
  }
  // 房间列表变了 ⇒ 命令条的目标跟着变
  scheduleLanes();

  const db = $('dms');
  db.replaceChildren();
  const names = agentNames.includes(ORCH) ? agentNames : [ORCH, ...agentNames];
  for (const n of names) {
    const on = current.kind === 'dm' && current.id === n;
    // ★ 私聊**不显示条数**：那个数字要跨 `agent:<name>:in` 和 `orch:in:agent`
    //   两个流合并计数，代价不小，**而它不答任何一个问题** ——
    //   知道跟 dev 说过 31 句，对判断它现在是不是活的毫无帮助。
    db.appendChild(channelBtn('@', n, null, on, () => select({
      kind: 'dm', id: n, name: n, members: [],
    }), { unreadN: unread.get('dm:' + n) || 0, st: agentStatus.get(n) || null }));
  }
  renderTabBadges();
}

// ── 新建房间 ───────────────────────────────────────────────────
//
// ★ 成员在建的时候定死，之后改不了 —— **而漏掉一个 agent 没有任何报错**，
//   它只是收不到这个房间的消息。所以表单里必须把这句写在人按下按钮之前。
//   （「建完改不了」是当前后端的事实：有 `rooms.join()`，但没有端点。）
function renderRoomForm() {
  const box = $('room-members');
  box.replaceChildren();
  const names = agentNames.length ? agentNames : [ORCH];
  for (const n of names) {
    const label = el('label', null);
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = n; cb.checked = (n === ORCH);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(n));
    box.appendChild(label);
  }
  // ⚠️ 候选里**不放 Patrick**：人已经通过 WS 广播看到房间里的每一条了。
  //   再把他列为成员，扇出会往 orch:out 再投一份 —— 同一句话显示两遍。
}

function toggleRoomForm(show) {
  const f = $('room-form');
  const open = show ?? f.hidden;
  f.hidden = !open;
  if (open) { renderRoomForm(); $('room-name').value = ''; $('room-name').focus(); }
}

async function createRoom(ev) {
  ev.preventDefault();
  const name = $('room-name').value.trim();
  if (!name) { $('room-name').focus(); return; }
  const members = [...$('room-members').querySelectorAll('input:checked')].map((i) => i.value);
  try {
    const r = await fetch('/api/rooms', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, members }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status !== 201) throw new Error(errText(d, r.status));
    toggleRoomForm(false);
    await pollRooms();
    select({ kind: 'room', id: d.hash, name: d.name, members: d.members || [], count: 0 });
  } catch (e) {
    // 建失败要说在哪一步失败 —— 「没反应」会让人再点一次，然后建出两个同名房间。
    pushSys('bus', '✗ 房间没建成：' + String(e.message || e)
      + '。**没有房间被创建**，改完再试一次就行。', true);
    renderFeed();
  }
}

// ── 渲染：舰队带上的 agent 卡 ─────────────
//
// 每个 agent 是舰队带上的一张卡。
// **类名是 `.ag <cls>`**：三重编码（色条 / 形状 / 文字）的规则跟着卡走，
//   `test/watchdog-liveness.test.js` 守的那几条（deaf 有独立底色、limit 不借 deaf 的红）在卡上同样成立。
//
// 卡上的字段和来源：
//   状态   STATUS 表（符号 + label + note）       —— 唯一来源，不另写一份
//   当前任务 Derive.currentTask                    —— 申报 > 在手最早一条 > 「—」，**不拿最后一条消息顶替**
//   心跳   Derive 的环形缓冲（pollAgents 每 5 秒记一次 idle_ms）—— 不到 3 个点写「采样中」
//   队列   Derive.queueChips                       —— 「排队 N」「在手 M」两个都画，零也画
function avatarText(name) {
  const s = String(name || '?');
  const m = /^([A-Za-z])[A-Za-z]*?(\d+)$/.exec(s);
  if (m) return (m[1] + m[2]).slice(0, 3);
  return s.slice(0, s === s.toUpperCase() ? 1 : 2);
}

function sparkEl(name, cls) {
  const st = heartbeat.state(name);
  if (st.sampling) {
    const w = el('span', 'spark-wait', '采样中');
    w.title = `已有 ${st.n} 个点，满 ${Derive.HEARTBEAT_MIN} 个才画。`
            + '心跳曲线是这个页面自己记的（每 5 秒一个点，最多 36 个，约 3 分钟），只在内存里。'
            + '\n不到 3 个点不画线 —— 两个点连出来的斜线会被读成趋势。';
    return w;
  }
  const pts = Derive.sparkline(st.points, { w: 120, h: 16 });
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 16');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  const last = st.points[st.points.length - 1];
  svg.setAttribute('aria-label', `队列空闲时长，最近 ${st.n} 个采样，最新 ${ago(last && last.idle_ms)}`);
  const pl = document.createElementNS(NS, 'polyline');
  pl.setAttribute('points', pts);
  pl.setAttribute('fill', 'none');
  pl.setAttribute('stroke', 'currentColor');
  pl.setAttribute('stroke-width', '1.5');
  pl.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(pl);
  const t = document.createElementNS(NS, 'title');
  t.textContent = `idle_ms 的最近 ${st.n} 个采样（越低 = 越久没读队列）。这是页面自己记的，刷新即空。`;
  svg.appendChild(t);
  return svg;
}

/** 「复制 attach 命令」—— 浏览器打不开 tmux，也没有存 pane 的端点。没有会话名就不画。 */
function attachBtn(a, cls) {
  if (!a.tmux_session) return null;
  const cmd = `tmux attach -t ${a.tmux_session}`;
  const b = el('button', cls || 'act', '复制 attach 命令');
  b.type = 'button';
  b.title = `${cmd}\n\n⚠️ 进去之后先看、先存现场再动手 —— pane 是唯一没人备份的状态。`;
  b.onclick = async (ev) => {
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(cmd);
      b.textContent = '✓ 已复制';
    } catch (e) {
      // 静默失败最坏 —— 人会以为复制成功了去粘贴。
      b.textContent = '✗ 复制失败';
      b.title = `复制失败：${String(e.message || e)}\n命令是：${cmd}`;
    }
    setTimeout(() => { b.textContent = '复制 attach 命令'; }, 1600);
  };
  return b;
}

/**
 * 队列浮层的位置（舰队带横向滚，浮层是 position:fixed）。
 * ⚠️ 只存「最近悬停的是谁、它的卡在哪」—— **显隐不进 JS 状态**，仍然是 CSS 的 :hover / :focus-within
 *   （queuePopover 头上那段：JS 管显隐的话，5 秒一次的重画会把浮层在人读到一半时冲掉）。
 */
let qPopAnchor = null;
function placeQPop(pop) {
  if (!pop || !qPopAnchor) return;
  const w = 300;
  pop.style.left = Math.max(8, Math.min(qPopAnchor.left, window.innerWidth - w - 8)) + 'px';
  pop.style.top = (qPopAnchor.bottom + 4) + 'px';
}
function anchorQPop(ev) {
  const card = ev.target && ev.target.closest && ev.target.closest('.ag.has-q');
  if (!card) return;
  const r = card.getBoundingClientRect();
  qPopAnchor = { name: card.dataset.agent, left: r.left, bottom: r.bottom };
  placeQPop(card.querySelector('.q-pop'));
}

function agentRow(a, fallbackLevel) {
  const s = STATUS[a.level || fallbackLevel] || UNMAPPED;
  const orch = a.type === 'orchestrator';
  const row = el('div', 'ag ' + s.cls + (orch ? ' orch' : ' crew'));
  row.dataset.agent = a.name;

  const h = el('div', 'h');
  h.appendChild(el('span', 'av', avatarText(a.name)));
  const col = el('div', 'who-col');
  // 名字是按钮：点了去跟它的私聊（键盘也能到）
  const nm = el('button', 'ag-name', a.name);
  nm.type = 'button';
  nm.title = `打开跟 ${a.name} 的私聊`;
  nm.onclick = () => select({ kind: 'dm', id: a.name, name: a.name, members: [] });
  col.appendChild(nm);
  const st = el('div', 'st');
  st.appendChild(el('span', 'glyph', s.glyph));
  st.appendChild(el('span', 'st-t', `${s.label} · ${ago(a.idle_ms)}`));
  // 状态行窄了会被截 —— 全文放 title
  st.title = `${s.glyph} ${s.label} · 队列 ${ago(a.idle_ms)} 没读${s.note ? '\n' + s.note : ''}`;
  col.appendChild(st);
  h.appendChild(col);
  // 角色标签。`orchestrator` 和 `dev` 在数据里一直分得开 —— 界面也该分得开。
  // ★ 卡片窄，agent 的 type 收进 title（名字本身多半就是 type）；编排者的胶囊常驻。
  if (orch) h.appendChild(el('span', 'role', '编排者'));
  row.appendChild(h);

  const qi = queueByRecipient.get(a.name);
  const task = Derive.currentTask(a, qi);
  const tk = el('div', 'task' + (task.source === 'none' ? ' none' : ''), task.text);
  tk.title = task.source === 'declared' ? `当前任务（进程申报的长任务）：${task.text}`
    : task.source === 'inflight' ? `当前任务（在手条目里最早的一条，前 ${Derive.TASK_CHARS} 个字）：${task.text}`
      : '没有申报的长任务，手里也没有已投未完的条目 —— 不拿最后一条消息冒充当前任务';
  row.appendChild(tk);

  // 三个事实各答一个问题，一行放不下 —— 收进 title，但不让它们消失。
  // 队列是最强的活性证据（心跳只说明还在续期，读队列才说明在轮询）；
  // outbox 是唯一独立于 poller 的信号，用来分辨「聋了」和「在忙」。
  // ★ 申报的长任务：比 outbox 更强的证据。outbox 说「几秒前有文件进出」
  //   （目录 mtime，relay 捡走也会更新）；申报说「那个进程此刻还活着」。
  //   `pid_gone` 单独说 —— 它不是「没人申报」，是**有个任务异常退出了**。
  const busy = a.declared_busy
    ? `⏳ 申报了长任务：${a.busy_what || '?'}（进程还活着）`
    : a.busy_reason === 'pid_gone' ? '⚠ 有个申报的任务异常退出了（标记还在，进程没了）'
      : a.busy_reason === 'too_old' ? '⚠ 申报标记过期（超过兜底上限）'
        : a.busy_reason === 'corrupt' ? '⚠ 申报标记读不出来' : null;
  row.title = [
    `${s.glyph} ${s.label}${orch ? ' · 编排者' : ` · ${a.type || '类型未知'}`}`,
    s.note,
    busy,
    `队列 ${ago(a.idle_ms)} 没读`,
    `心跳 ${ago(a.since_heartbeat_ms)}`,
    `outbox ${ago(a.outbox_idle_ms)}`,
    a.ttl_s != null ? `掉册倒计时 ${Math.round(a.ttl_s / 60)} 分` : null,
    a.pending ? `待确认 ${a.pending}` : null,
    a.tmux_session ? `会话 ${a.tmux_session}` : null,
  ].filter(Boolean).join(' · ');

  if (s.note) row.appendChild(el('div', 'ag-note ' + s.cls, s.short || s.note));
  if (s.cls === 'deaf') {
    const b = attachBtn(a);
    if (b) { const acts = el('div', 'acts'); acts.appendChild(b); row.appendChild(acts); }
  }

  const f = el('div', 'f');
  f.appendChild(sparkEl(a.name, s.cls));

  // ── ★ 队列：「排队 N · 在手 M」+ hover 展开条目 ────────────────────
  //
  //   ⛔ **两个数不许合并成一个总数。**
  //   「排队 5 / 在手 1」和「排队 0 / 在手 6」总数都是 6，
  //   **但前者是它干得慢，后者是它领了一堆没干完 —— 人要做的处置完全相反。**
  //   合成一个「待处理 6」就把这个区分抹掉了，而那正是这个功能的意义。
  //   ⚠️ 「查不了」不能画成「没有」：后者会让人停止追查（queueError ⇒「队列 ?」）。
  //   判据在 `Derive.queueChips`（测得到）；这里只负责画。
  const qc = Derive.queueChips(qi, queueError);
  const w = el('span', 'q-chips');
  for (const c of qc.chips) {
    const chip = el('span', 'q-chip ' + c.cls, c.text);
    chip.title = c.title;
    w.appendChild(chip);
  }
  f.appendChild(w);
  row.appendChild(f);

  if (!qc.unknown && qi && (qi.queued || qi.in_flight)) {
    const pop = queuePopover(qi);
    // 舰队带会横向滚 ⇒ 浮层用 position:fixed（否则被滚动容器裁掉）。
    // 显隐仍然是纯 CSS；这里只把上一次悬停量到的坐标放回去 —— 5 秒重画之后浮层还在原处。
    if (qPopAnchor && qPopAnchor.name === a.name) placeQPop(pop);
    row.appendChild(pop);
    row.classList.add('has-q');
    // hover 浮层要键盘也够得到：让卡片能拿焦点（:focus-within 也会打开它）
    w.tabIndex = 0;
    w.setAttribute('aria-label', `${a.name} 的队列：${qc.chips.map((c) => c.text).join('，')}。聚焦展开条目`);
  }
  return row;
}

/**
 * hover 展开的条目列表 —— 「什么任务分给了谁」。
 *
 * ⚠️ 纯 CSS 控制显隐（`.ag.has-q:hover .q-pop`），不引入 JS 状态 ——
 *   一个「哪个浮层开着」的状态要跟每 2 秒一次的重渲染同步，
 *   而重渲染会把 DOM 换掉，于是浮层会在人读到一半时消失。
 */
function queuePopover(qi) {
  const pop = el('div', 'q-pop');
  pop.appendChild(el('div', 'q-pop-head',
    `${qi.recipient} —— 排队 ${qi.queued} · 在手 ${qi.in_flight}`));

  if (qi.errors && qi.errors.length) {
    pop.appendChild(el('div', 'q-pop-err', '⚠ ' + qi.errors.join(' · ')));
  }
  if (!qi.items.length) {
    pop.appendChild(el('div', 'q-pop-empty', '没有积压的条目'));
    return pop;
  }

  for (const it of qi.items) {
    const st = Q_STATE[it.state];
    if (!st) continue;                       // 未知状态不猜，直接不画
    const line = el('div', 'q-item ' + st.cls);
    const head = el('div', 'q-item-head');
    head.appendChild(el('span', 'q-badge ' + st.cls, st.label));
    head.appendChild(el('span', 'q-from', it.from || '?'));
    // ★ 「这条从哪条流来」—— 编排者那两条流的条目混在一起时要看得出来
    if (it.stream) head.appendChild(el('span', 'q-stream', it.stream));
    line.appendChild(head);

    const one = String(it.text || '').split('\n')[0];
    line.appendChild(el('div', 'q-text', one.slice(0, 90) + (one.length > 90 ? '…' : '')));

    // ★★★ **只有 queued 渲染按钮；in_flight 直接不渲染 —— 不要灰掉。**
    //   灰掉的按钮会让人去猜「怎样才能点亮它」，而答案是**不可能**。
    //   ⚠️ 而不渲染按钮只是**给人看的**那一半：真正的机制是服务端拒绝
    //   （见 bin/serve.js 的 DELETE 端点）—— 否则一次前端 bug 或一条手写
    //   curl 就能删掉它手里的条目，而那正是「让人以为撤回了」的后果。
    if (st.canCancel) {
      const bar = el('div', 'q-actions');
      // ── ★★★ 没有「编辑」按钮，只有「撤回改写」 ────────────────────
      //
      //   队列条目**不可改**：改一条的实际行为是删掉 + 重发一条新的，
      //   而新条目有新 id、**排在队尾**。所以按钮上写「编辑」是名实不符 ——
      //   **拿确认框补一句说明，等于承认按钮在撒谎然后打个补丁。**
      //
      //   ⇒ 如实呈现：撤回原条目 + 把原文预填进输入框，人改完自己发。
      //     于是「排到队尾」不需要任何解释 —— **那本来就是他自己新发的一条。**
      //
      //   ⚠️ 只对**人自己发的**那些开放（`orch:in:human`）：人在这个界面里
      //   只能发给编排者和房间（`canSend`），发给 agent 的活是编排者派的。
      //   给别人的条目摆一个「改写」按钮，人改完会发现自己发不出去 ——
      //   那又是一个「点了才知道不行」的按钮。
      if (it.stream === 'orch:in:human') {
        const rw = el('button', 'q-btn q-rewrite', '撤回改写');
        rw.title = '把这条撤回来，原文填进输入框 —— 你改完自己发（新发的自然排在队尾）';
        rw.onclick = () => withdrawAndRewrite(it, qi.recipient);
        bar.appendChild(rw);
      }
      const del = el('button', 'q-btn q-del', '撤回');
      del.title = '把这条从队列里撤掉 —— 它还没被领走，撤得掉';
      del.onclick = () => cancelQueueItem(it, qi.recipient);
      bar.appendChild(del);
      line.appendChild(bar);
    } else {
      // ★ 不给按钮，但**要给出路**：说清为什么没有、以及该怎么办。
      line.appendChild(el('div', 'q-noaction', st.hint));
    }
    pop.appendChild(line);
  }
  return pop;
}

function renderAgents(d) {
  const box = $('agents');
  box.replaceChildren();
  // deaf 排最前 —— 它是唯一一个「看起来正常但实际上聋了」的状态，
  // 按字母序混进列表等于把它藏起来。
  // ★★ `rate_limited` 紧跟 deaf 排在 live 之前 —— **后端分了组、前端不认，
  //   那一组就等于不存在**：撞了限额的 agent 会掉进 live 显示成绿的，
  //   人以为额度还够，接着派活接着撞。这一行就是那个「假绿」的补丁。
  const groups = [
    ...(d.deaf || []).map((a) => [a, 'deaf']),
    ...(d.rate_limited || []).map((a) => [a, 'rate_limited']),
    ...(d.live || []).map((a) => [a, 'ok']),
    ...(d.stale || []).map((a) => [a, 'stale']),
  ];
  if (!groups.length) {
    // ⚠️ watchdog 瞎了的时候，三组全空 ≠「没有 agent」—— 是「查不了」
    box.appendChild(el('div', 'empty', isBlind(d)
      ? '查不了 —— watchdog 什么都没看见；空白不代表没有 agent（见上面的横幅）'
      : '没有 agent 在线'));
  }
  // ★ 层级：编排者在最前，它管的 agent 在后。
  //   数据里一直有 `type`（`orchestrator` / `dev` / …），**界面不能把它丢掉** ——
  //   平铺时 JARVIS 和 dev 长得一样，而它们一个是管理者一个是被管理者，
  //   出事时该找谁完全不同。（卡片上有「编排者」角色胶囊 + 深色头像。）
  const rank = (a) => (a.type === 'orchestrator' ? 0 : 1);
  groups.sort((x, y) => rank(x[0]) - rank(y[0]));
  agentStatus.clear();
  agentTypes.clear();
  for (const [a, fb] of groups) {
    agentStatus.set(a.name, STATUS[a.level || fb] || UNMAPPED);
    if (a.type) agentTypes.set(a.name, a.type);
    box.appendChild(agentRow(a, fb));
  }

  // ★ 离线但可开启的 —— 排在所有在线的之后。
  //
  //   不列出来的话，一个没起的 agent 在界面上**根本不存在**：两个数据源
  //   （watchdog + 花名册）都只看得见已经存在的东西。于是「起一个 dev」
  //   只能去终端做，而这个界面存在的意义就是不必去终端。
  renderOffline(box, d);

  // ★★ 掉册留痕 —— 它讲的是**已经过去的**掉册，
  //   而那种事的特点正是「当时没人知道，现在也不会有人知道」。
  renderDropouts(box, d);

  // ⚠️ 下面仍然是 renderAgents 的一部分（统计格 + 频道列表）——
  //   `renderOffline` / `startCrew` 的定义在本文件靠后的地方，
  //   函数声明会提升，所以这里调用得到。
  // eslint-disable-next-line no-use-before-define
  renderAgentsTail(d, groups);
}

/**
 * 掉册留痕 —— 「它掉过册，被自愈救回来了」。
 *
 * ── 为什么这几行必须存在 ────────────────────────────────────────
 * agent 掉册后 `roster.heartbeat` 会自愈重建，`bin/next.js` 打一条警告 ——
 * **而那条警告只有 agent 自己的终端看得见。** 不在这里留痕的话，界面上一个字都没有。
 *
 * > **「救回来了」和「什么都没发生」在界面上长得一模一样。**
 * > 自愈越可靠，这件事就越隐蔽 —— 因为再也没有别的症状了。
 *
 * ⚠️ 只显示「发现时刻」，**不显示时长** —— TTL 过期是静默的，
 *   系统不知道它从什么时候开始不在册。编一个开始时间，
 *   会让人算出一段假的失聪时长，那比不显示更坏。
 * ★ 舰队带末尾一张虚线小卡（告警色、不用红 —— 它讲的是已经自愈的事）。
 */
function renderDropouts(box, d) {
  const drops = d.dropouts || [];
  if (!drops.length) return;
  const card = el('div', 'drops');
  card.appendChild(el('div', 'tier-label', '掉册记录 · 已自愈'));
  for (const x of drops) {
    const row = el('div', 'drop-row');
    row.appendChild(el('span', 'drop-name', x.name));
    row.appendChild(el('span', 'drop-when',
      x.detected_at ? new Date(x.detected_at).toLocaleString() : '?'));
    // ★ 这句不是免责声明，是这条记录唯一能诚实说出的东西。
    row.title = '这是**发现**的时刻，不是掉出去的时刻 —— '
      + 'TTL 过期没有事件，系统不知道它聋了多久。'
      + '\n掉册期间：别人发给它的消息被当成「发给人」推去网页，'
      + '它写出去的 outbox 没人捡。';
    card.appendChild(row);
  }
  card.appendChild(el('div', 'src-note',
    '⚠️ 上面是「发现」时刻，不是掉出去的时刻 —— 失联时长系统不知道'));
  box.appendChild(card);
}

/**
 * 离线候选 + 开启按钮。
 *
 * ⚠️ **每个按钮花的是真钱**（一次点击 = 一个新的 claude 会话），
 *   所以这里的每个交互都要求一次明确确认，且**没有任何自动点击路径**。
 */
function renderOffline(box, d) {
  const offline = d.offline_candidates || [];
  const launching = d.launching || {};
  if (!offline.length && !Object.keys(launching).length) return;

  // ★ 标注来源。
  //   这份名单是**扫 agents/ 目录**得来的，不是谁声明的：目录 ≠ 意图，
  //   一个手滑建的目录会变成这里的一个按钮。人得知道自己在看推断。
  //   （来源写在每张离线卡的 title 和卡底的小字里。）
  const srcText = d.offline_source
    ? `名单来源：扫 agents/*/CLAUDE.md（${d.offline_source}）—— 不是声明的清单`
    : null;

  for (const c of offline) {
    // ★ 沿用 `.ag.off .agent` 这套既有样式，不新造一套视觉 ——
    //   离线的 agent 仍然是一个 agent，长得像另一种东西会让人以为它是别的。
    const row = el('div', 'ag off crew mini');
    row.dataset.agent = c.name;
    const h = el('div', 'h');
    h.appendChild(el('span', 'av', avatarText(c.name)));
    const col = el('div', 'who-col');
    col.appendChild(el('span', 'ag-name', c.name));
    const stl = el('div', 'st');
    stl.appendChild(el('span', 'glyph', '○'));
    stl.appendChild(el('span', 'st-t', '未启动'));
    col.appendChild(stl);
    h.appendChild(col);
    row.appendChild(h);
    row.appendChild(el('div', 'task none', c.type ? `类型 ${c.type}` : '类型未知'));
    const f = el('div', 'f');
    f.style.justifyContent = 'flex-end';

    const st = launching[c.name];
    if (st && st.status === 'starting') {
      // 「正在起」必须跟「起失败了」分得开 —— 两者在花名册里都是「不在」。
      f.appendChild(el('span', 'ag-meta', '正在起…'));
      row.title = '起一个 agent 最长约 90 秒（要等 tmux TUI 就绪）';
    } else if (st && st.error) {
      // ★★ 失败必须说出来。不说的话它跟「正在起」一样是「它还没出现」，
      //   人会盯着一个永远不动的界面等下去。
      const m = el('span', 'ag-meta launch-err', '起失败');
      m.title = st.error;
      f.appendChild(m);
      row.appendChild(el('div', 'ag-note deaf', st.error));
    } else if (!c.type) {
      // type 推不出来时不给按钮 —— 后端也会拒。**给一个必然失败的按钮，
      // 等于给人准备一次失败。**
      f.appendChild(el('span', 'ag-meta launch-err', '类型未知'));
      row.appendChild(el('div', 'ag-note',
        'CLAUDE.md 首行不是「# 名字 — 类型 agent」，推不出类型 —— '
        + '不默认成 dev：类型错了之后的故障现场跟一切正常长得一样'));
    } else {
      const btn = el('button', 'launch-btn', '开启');
      btn.type = 'button';
      btn.title = '开一个新的 claude 会话（消耗额度），点了会先确认';
      btn.onclick = () => startCrew(c, btn);
      f.appendChild(btn);
    }
    row.appendChild(f);
    if (srcText) {
      row.appendChild(el('div', 'src-note', '扫目录推出来的，不是声明'));
      row.title = [row.title, srcText].filter(Boolean).join('\n');
    }
    box.appendChild(row);
  }
}

async function startCrew(c, btn) {
  // ⚠️ 一次明确确认，且**把代价写在确认框里**。
  //   「你确定吗」不告诉人代价是什么，等于没问。
  if (!window.confirm(
    `开启 ${c.name}（类型 ${c.type}）？\n\n`
    + '这会开一个新的 claude 会话，消耗额度。\n'
    + '起一个 agent 最长约 90 秒。')) return;
  btn.disabled = true;
  btn.textContent = '正在起…';
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(c.name)}/start`,
      { method: 'POST' });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) {
      btn.disabled = false;
      btn.textContent = '开启';
      // 后端的 message 是写给人看的（说得出为什么不能起），原样呈现。
      window.alert(`起不了 ${c.name}：\n\n${b.message || b.error || `HTTP ${r.status}`}`);
    }
    // 成功不弹窗 —— 下一次 pollAgents 会把它显示成「正在起…」，
    // 那比一个确认框更接近事实（受理 ≠ 起来了）。
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '开启';
    window.alert(`请求失败：${String(e.message || e)}`);
  }
}

/**
 * renderAgents 的后半段：顶部读数 + 舰队带的头 + 频道列表 + 现场栏。
 *
 * ⚠️ 拆出来**不是为了好看** —— 往一个很长的函数中间插代码时，
 *   多一个 `}` 就能把后半段变成孤儿，而**单元测试照样全绿**：
 *   `web/app.js` 是浏览器脚本，单元测试不 parse 它（兜底的是 run-all 里的 `node --check`）。
 */
/** watchdog 自己瞎了：sessions_seen === 0 意味着「我什么都没看见」，不是「什么都没有」。 */
function isBlind(d) {
  return !!(d && (d.watchdog_blind || d.sessions_seen === 0));
}

function renderAgentsTail(d, groups) {
  // sessions_seen：watchdog 自己的活性证据（显示在舰队带的头上）
  $('seen').textContent = d.sessions_seen != null ? `sessions_seen ${d.sessions_seen}` : 'sessions_seen ?';
  // 在线 / 总数走 Derive.fleetCounts —— 今天视图数字行的「在线」是同一个函数算的同一个值
  const fc = Derive.fleetCounts(d);
  const total = fc.total;
  const online = fc.online;
  if (isBlind(d)) {
    // ⚠️ 瞎了的时候「0/0」是一个看起来精确的假数 —— 写「查不了」
    $('s-fleet').textContent = '查不了';
    $('fleet-n').textContent = '?';
  } else {
    $('s-fleet').textContent = `${online}/${total}`;
    $('fleet-n').replaceChildren(document.createTextNode(String(online)), el('small', null, `/${total}`));
  }
  $('s-fleet-wrap').title = `在线 ${online}（live 组）/ 已知 ${total}（失联 + 限额 + 在线 + 残留）`
    + (d.offline_candidates && d.offline_candidates.length ? `，另有 ${d.offline_candidates.length} 个离线可开启` : '');
  const nDeaf = (d.deaf || []).length;
  $('s-deaf').textContent = nDeaf;
  $('s-deaf-wrap').className = 'stat' + (nDeaf ? ' bad' : '');
  // ★ 撞限额那格：**只在真发生时出现**（常驻一个 0 是噪音，见 index.html 那段）。
  //   类名用 `.limit` 而不是 `.bad` —— `.bad` 是红的，而红在这个界面里
  //   已经有「去救它」的含义了，这一档要的恰恰相反。
  const nLimit = (d.rate_limited || []).length;
  $('s-limit').textContent = nLimit;
  $('s-limit-wrap').hidden = !nLimit;
  $('s-limit-wrap').className = 'stat' + (nLimit ? ' limit' : '');
  $('s-fleet-wrap').className = 'meter' + (isBlind(d) ? ' stat bad' : '');

  agentNames = groups.map(([a]) => a.name);
  renderChannels();
  renderNeed();
}

function showBlind(html) {
  // 横幅按内容占高，视图拿剩下的 —— 布局是弹性的，这里不用再算高度。
  const b = $('blind');
  b.replaceChildren();
  if (!html) { b.className = ''; return; }
  b.appendChild(html);
  b.className = 'show';
}
function blindBanner(title, detail, hint) {
  const f = document.createDocumentFragment();
  f.appendChild(el('b', null, title));
  f.appendChild(document.createTextNode(' ' + detail));
  if (hint) f.appendChild(el('span', 'hint', hint));
  return f;
}

/**
 * /api/agents 查不了的时候，舰队带**不能**还摆着上一次的样子装作正常。
 * ⚠️ 「查不了」不能画成「没有」或「正常」：卡片变淡 + 头上写「查不了」；
 *   一次都没拿到过数据时，「读取中…」换成「查不了」。
 */
function markAgentsUnknown(why) {
  agentsSnap = { error: why };
  $('fleet').classList.add('is-stale');
  $('fleet').title = `/api/agents 查不了：${why}\n下面的卡片（如果有）是上一次拿到的样子，不是现在。`;
  $('fleet-n').textContent = '?';
  $('s-fleet').textContent = '查不了';
  $('s-fleet-wrap').className = 'meter stat bad';
  const box = $('agents');
  if (!box.querySelector('.ag')) {
    box.replaceChildren(el('div', 'empty', '查不了 —— 这不是「没有 agent」，见上面的横幅'));
  }
  renderNeed();
}

// ── 拉取 ───────────────────────────────────────────────────────
async function pollAgents() {
  let d;
  try {
    const r = await fetch('/api/agents');
    d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) {
      // ★ 「查不了」必须说成「查不了」。这个端点存在的全部目的就是让人
      //   一眼看出失聪 —— **它自己坏了的时候，画成一片空白等于对人说
      //   「一切正常」。**
      showBlind(blindBanner(
        '看不到 agent 状态。',
        d.detail || d.message || d.error || `HTTP ${r.status}`,
        d.hint || null));
      markAgentsUnknown(d.message || d.error || `HTTP ${r.status}`);
      return;
    }
  } catch (e) {
    // 说清「是什么」还不够，要说人下一步做什么。
    showBlind(blindBanner('读不到 /api/agents。', String(e.message || e),
      '这不是「没有 agent」，是「查不了」。先 curl /health：没响应说明 bus 没在跑，'
      + '用 launchctl kickstart -k gui/$UID/com.patrick.engloop 起它（不要手动 kill，'
      + 'launchd 的 KeepAlive 会跟你抢）。'));
    markAgentsUnknown(String(e.message || e));
    return;
  }

  // sessions_seen === 0 意味着「我什么都没看见」，不是「什么都没有」——
  // **至少编排者自己的会话必须在**。watchdog 瞎掉比任何单个 agent 失联更危险。
  if (d.watchdog_blind || d.sessions_seen === 0) {
    showBlind(blindBanner(
      'watchdog 什么都没看见。',
      'tmux 会话列表是空的 —— 至少编排者自己的会话应该在。舰队带空白不代表一切正常 —— 是「查不了」。',
      '多半是 bus 的 PATH 里没有 tmux（通常在 /opt/homebrew/bin）。'));
  } else {
    showBlind(null);
  }
  agentsSnap = { data: d };
  $('fleet').classList.remove('is-stale');
  $('fleet').title = '';
  // ★ 心跳缓冲：每次成功的 pollAgents 记一个点（画心跳曲线用）。只在内存里。
  const now = Date.now();
  for (const g of [d.deaf, d.rate_limited, d.live, d.stale]) {
    for (const a of g || []) heartbeat.push(a.name, a.idle_ms, now);
  }
  // 队列条目跟 agent 状态一起刷 —— 两者显示在同一张卡上，分两次拉会让
  // 「这个数字属于哪一次快照」变得说不清。
  await pollQueueItems();
  renderAgents(d);
}


/**
 * 撤回一条队列条目。
 *
 * ⚠️ 这是**破坏性动作**，先确认。而确认文案里要说清「撤的是什么」——
 *   一句「确定删除？」让人无从判断，他只知道自己点了个删除。
 *
 * ★ 服务端会**再判一次状态**（`cancelItem` 判定在前）。这里的按钮只在
 *   `queued` 上渲染，但那不是机制 —— 人点下去到请求到达之间，agent
 *   完全可能刚好领走它。**那时服务端会拒绝，而这里必须把拒绝的理由原样显示**，
 *   不能吞掉变成一句「失败了」：`reason` 里写着他下一步该做什么。
 */
async function cancelQueueItem(it, recipient, { confirmText = null } = {}) {
  const one = String(it.text || '').split('\n')[0].slice(0, 60);
  if (!confirm(confirmText
             || `撤回发给 ${recipient} 的这条？\n\n「${one}」\n\n`
                + '它还没被领走，所以这是真撤回。')) return;
  try {
    const r = await fetch('/api/queue/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: it.stream, id: it.id, group: it.group }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) {
      // ★ 原样显示服务端给的 reason —— 尤其 409（它刚好领走了）那一种：
      //   那句话告诉人「撤不掉了，去直接跟它说」，换成「失败」就丢了出路。
      push(keyOf(current), {
        sys: true, tag: 'queue', crit: true, at: Date.now(),
        text: `撤回没成功：${d.reason || d.message || d.error || `HTTP ${r.status}`}`,
      });
      renderFeed();
      return;
    }
    push(keyOf(current), {
      sys: true, tag: 'queue', at: Date.now(),
      text: `已撤回发给 ${recipient} 的一条（它还没领走，这是真撤回）。`,
    });
    renderFeed();
  } catch (e) {
    push(keyOf(current), {
      sys: true, tag: 'queue', crit: true, at: Date.now(),
      // ⚠️ 网络失败时**那条消息还在队列里** —— 不能让人以为撤掉了。
      text: `撤回请求没发出去：${String(e.message || e)} —— **那条消息还在队列里**。`,
    });
    renderFeed();
  }
  await pollQueueItems();
  await pollAgents();
}

/**
 * 「撤回改写」—— 撤回原条目 + 把原文预填进输入框，人改完自己发。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★★ 这个功能**故意不叫「编辑」**。
 *
 *   队列条目不可改：改一条的实际行为是 XDEL + XADD 一条新的，
 *   而新条目有新 id、**排在队尾**。按钮上写「编辑」就是名实不符 ——
 *   **而用确认框补一句「⚠️ 这会把它排到队尾」，等于承认按钮在撒谎
 *   然后打个补丁。**
 *
 *   如实呈现之后，那句解释根本不需要存在：**人是自己重新发的一条，
 *   它当然在队尾。**
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️★ **实现顺序：先填输入框，再执行撤回。**
 *   反过来的话，撤回失败（409：它刚被领走）时人的文字就丢了 ——
 *   而那正是最需要它还在的时候：他得知道自己刚才想说什么。
 */
async function withdrawAndRewrite(it, recipient) {
  const box = $('input');
  const one = String(it.text || '').split('\n')[0].slice(0, 60);

  // ① 先填 —— 无论撤回成不成，文字都在他手上
  box.value = String(it.text || '');
  box.focus();

  // ② 再撤。撤不掉时（竞态/已领走）服务端的 reason 会照常显示，
  //    而输入框里的原文**留着不动** —— 他可以直接跟对方说，也可以重发。
  await cancelQueueItem(it, recipient, {
    confirmText: `撤回这条并改写？\n\n「${one}」\n\n`
               + '原文已经填进输入框了 —— 撤回之后你改完自己发。\n'
               + '（新发的那条自然排在队尾。）',
  });
}

// ── 队列条目：agent 卡片旁的「排队 N · 在手 M」+ hover 展开 ──────────
//
// ★ 数据和显示都来自**同一个端点**（`/api/queue/items`）——
//   卡片旁的数字和展开的列表如果各拉各的，两边分叉时不会有任何东西变红：
//   卡片说 3 条、列表 4 条，人只会以为自己看花了。
let queueByRecipient = new Map();
// ⚠️★ 「查不了」必须跟「没有队列」分开。
//   查失败时如果只是让 chips 不显示，那**跟「队列是空的」长得一模一样** ——
//   而人看到没有数字会以为没积压，停止追查。所以留一个错误状态，
//   agentRow 里显示成一个 ⚠ 而不是什么都不显示。
let queueError = null;
/** 至少成功读回来过一次（今天视图：还没回来时写「—」，不写「排队 0 · 在手 0」）。 */
let queueLoaded = false;

async function pollQueueItems() {
  try {
    const r = await fetch('/api/queue/items');
    const d = await r.json();
    if (!r.ok || d.error) {
      queueError = errText(d, r.status);
      queueByRecipient = new Map();
      return;
    }
    queueByRecipient = new Map((d.groups || []).map((g) => [g.recipient, g]));
    queueError = null;
    queueLoaded = true;
  } catch (e) {
    queueError = String(e.message || e);
    queueByRecipient = new Map();
  }
  // ★ 每条消息上的撤回按钮跟这份数据是同一个快照 —— 数据换了就把按钮
  //   跟着更新。**放在 finally 位置（try 之外）是有意的**：查失败时
  //   `queueByRecipient` 被清空，按钮必须**跟着消失** ——
  //   留着一个基于旧数据的按钮，等于让人对着一个可能已经被领走的条目点撤回。
  refreshWithdrawBars();
}

/**
 * 一条队列条目的状态 → 给人看的说法 + 能不能撤回。
 *
 * ★★★ 这张表是整个队列面板的**唯一语义出处**。两种状态**能不能被撤回是
 *   相反的**，只看一个总数的话完全无法区分。
 */
const Q_STATE = {
  queued: {
    cls: 'q-queued', label: '未投递',
    hint: '还没投给它 —— 删除是真撤回',
    canCancel: true,
  },
  in_flight: {
    cls: 'q-inflight', label: '已在它手里',
    // ★ 这句话是**处置**，不是补充说明：人看到一条积压会想撤回它，
    //   而在这一档撤回做不到 —— 必须告诉他真正的出路是什么。
    hint: '它已经领走了，删除**不会**让它停下 —— 要撤只能直接跟它说',
    canCancel: false,
  },
};

async function pollRooms() {
  try {
    const r = await fetch('/api/rooms');
    const d = await r.json();
    if (!r.ok || d.error) return;
    roomList = d.rooms || [];
    if (current.kind === 'room') {
      const m = roomList.find((x) => x.hash === current.id);
      if (m) { current.members = m.members || []; current.count = m.message_count; current.name = m.name || current.name; renderBar(); }
    }
    renderChannels();
  } catch (_) { /* 顶栏的 WS 点已经在报连不上了，这里不重复喊 */ }
}

async function loadRoomHistory(hash) {
  const chKey = 'room:' + hash;
  try {
    // 条数走 ROOM_HISTORY_COUNT —— 「更早的 N 个话题」那句提示要引用同一个数字。
    const r = await fetch(`/api/rooms/${encodeURIComponent(hash)}/history?count=${ROOM_HISTORY_COUNT}`);
    if (r.status === 404) {
      // ⚠️ 这个 404 有**两个**含义，必须分开说：
      //   · 后端给了 JSON `{error, next}` → **这个房间**不存在
      //   · 解析不出来（express 的默认 HTML）→ **这个端点**不存在
      // 两种情况人的下一步完全不同，混成一句「404」等于什么都没说。
      const e404 = await r.json().catch(() => null);
      const body = e404 && e404.error
        ? [e404.error, e404.next].filter(Boolean).join(' —— ')
        : 'GET /api/rooms/:hash/history 返回 404，而且不是后端给的那种 404。'
          + '两种可能：bus 还没加载新代码（重启一下），或者这个端点还没做。'
          + '**这不是「房间是空的」。**';
      feeds.set(chKey, [{ sys: true, tag: 'bus', crit: true, text: body, at: Date.now() }]);
      loadedCh.delete(chKey);
      renderFeed();
      return;
    }
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(errText(d, r.status));
    const rows = d.messages || d.history || [];
    // ★ 合并表跟这批消息在**同一次响应**里，所以它们一定对得上。
    //   `|| {}` 而不是「取不到就不动」：老 bus（还没带这个字段）返回 undefined，
    //   那时该退回「没有任何合并」，**不能沿用上一次的表** —— 沿用的话，
    //   一次失败的刷新会让界面继续按一张过期的表画，而且没有任何提示。
    mergesByCh.set(chKey, d.merges || {});
    // 重拉历史 = 这个频道从头来过。**先把这批的去重键撤掉**，
    // 否则第二次打开同一个房间会因为「见过了」而渲染出一片空白。
    feeds.set(chKey, []);
    for (const m of rows) {
      // ★ `reply_to` 一路带到 feed —— 分组在渲染时做（`Threads.group`）。
      //   老消息没有这个字段 → `undefined` → 当顶层，**跟不分组时完全一样**。
      const e = { id: anchorOf(m, 'room'), from: m.from, text: m.text,
                  at: m.timestamp, reply_to: m.reply_to, kind: m.kind,
                  done: Threads.isDone(m) || undefined,
                  // ★ `sender_type`（stamp 的章）带进 feed —— 「需要你」靠它认「人类回过了」
                  sender_type: m.sender_type || undefined,
                  // ★ `expects_reply` 也带进 feed —— `isForHuman` 的 ① 认它，
                  //   三条入口都要带，漏带的话那一档在浏览器里永远不命中。过 `Threads.expectsReply`（流里是字符串）。
                  expects_reply: Threads.expectsReply(m) || undefined,
                  // ★ `verify` 带进 feed —— 「刚完成」的核验标签和跟帖合并都要它（三条入口都要带）
                  verify: m.verify || undefined };
      seenIds.delete(dedupeKey(e));
      push(chKey, e);
    }
    loadedCh.add(chKey);
    renderFeed();
  } catch (e) {
    loadedCh.delete(chKey);
    feeds.set(chKey, [{ sys: true, tag: 'bus', crit: true,
      text: '读房间历史失败：' + String(e.message || e)
        + ' —— 这不是「房间是空的」。房间流是 append-only 的历史真相，消息没丢，'
        + '重新点一下这个房间即可；一直失败就看 /health 里 redis 死活。',
      at: Date.now() }]);
    renderFeed();
  }
}

// ── 测试 / commit 两格 ─────────────────────────────────────────
//
// ★ **缓存的测试数会在最危险的时候撒谎**：你改崩了代码，页面还绿着。
//   而「测试绿不绿」正是这个页面要答的问题之一。
//
//   所以不是靠时间戳凑合，是**判过期**：跑出这个数字的 commit 不再是 HEAD、
//   或者工作区脏，这个数就**不管当前代码**，界面把它划掉。
//
//   > 一个过期的绿比没有数字更危险 ——
//   > **没有数字的时候人会去跑一遍，看到绿的时候不会。**
// 过期的四个原因。后端判，这里只翻译成人话。
// ★ 后两个是同一条规矩的延伸：**「判断不了过不过期」本身就算过期** ——
//   算成新鲜的话，git 一挂顶栏就永远绿着，而那正是最坏的方向。
const STALE_WHY = {
  commit_moved: '这个数字跑在另一个 commit 上，HEAD 已经变了 —— 它不管当前代码',
  working_tree_dirty: '工作区有未提交的改动，那些改动没被这次测试覆盖',
  git_unavailable: 'git 查不了 —— 无法判断过不过期，所以按过期算',
  dirty_unknown: 'git status 挂了 —— 工作区脏不脏未知，不当成干净',
};
// 没有记录的两种，**给的建议不一样**，所以不能压成一个「无数据」。
const NO_TESTS = {
  no_data: ['没跑过', '找不到 results/last-run.json —— 这不是「0 条测试」，是「从没跑过」。去跑一遍。'],
  corrupt: ['记录损坏', '上次跑到一半崩了，或记录缺字段 —— 重跑。一条缺字段的记录会渲染成一个看起来正常的格子。'],
};

// ★ 读数格是 `.meter.stat`（顶栏读数组里的一格）。className 整体覆盖时 **`meter` 必须带上**，
//   否则那一格掉出读数组的样式 —— 而它仍然「显示了数字」，所以不会有人发现。
const MC = (...cls) => ['meter', 'stat', ...cls].filter(Boolean).join(' ');

/** 上一次 /api/status 的结果 —— 现场栏（全量 / HEAD）跟顶栏读数用**同一份快照**。 */
let statusSnap = { kind: 'loading' };

async function pollStatus() {
  try {
    await pollStatusMeters();
  } finally {
    // 不管走哪条出口（404 / 查不了 / 正常），现场栏都按同一份快照重画
    renderLivePanels();
    renderNeed();
  }
}

async function pollStatusMeters() {
  const tw = $('s-test-wrap'), t = $('s-test'), c = $('s-commit'), cw = $('s-commit-wrap');
  let d;
  try {
    const r = await fetch('/api/status');
    if (r.status === 404) {
      // ⚠️ 只写「端点未上线」不够：人会分不清
      //    **「这是坏了还是还没做」。**
      //
      //    说清「查不到」是不够的 —— 人下一步要**做什么**才是这句话的用途。
      //    404 本身有二义（路由不存在 vs 部署滞后），页面分辨不了，
      //    **那就把两种可能都说出来，并给出各自的处置**，而不是含糊成一个词。
      t.textContent = '端点 404'; tw.className = MC('stale-data');
      tw.title = 'GET /api/status 返回 404。两种可能：\n'
        + '① bus 还没加载新代码 → 重启 bus\n'
        + '② 这个端点还没做 → 等后端\n'
        + '这不是「测试挂了」，是「问不到」。';
      c.textContent = '端点 404';
      cw.className = MC('stale-data');
      cw.title = tw.title;
      $('s-queue').textContent = '端点 404';
      $('s-queue-wrap').className = MC('stale-data');
      $('s-queue-wrap').title = tw.title;
      statusSnap = { kind: '404', why: tw.title };
      return;
    }
    d = await r.json();
    if (!r.ok || d.error) throw new Error(errText(d, r.status));
  } catch (e) {
    t.textContent = '查不了'; tw.className = MC('bad');
    tw.title = String(e.message || e);
    c.textContent = '—';
    statusSnap = { kind: 'error', why: String(e.message || e) };
    return;
  }
  statusSnap = { kind: 'ok', d };

  const run = d.tests || null;
  const git = d.git || {};
  const why = (d.stale_reasons || []).map((k) => STALE_WHY[k] || k);

  const missing = NO_TESTS[run && run.error] || (!run || run.passed == null ? NO_TESTS.no_data : null);
  if (missing) {
    t.textContent = missing[0];
    tw.className = MC('stale-data');
    tw.title = missing[1];
  } else {
    t.textContent = `${run.passed} · ${run.failed ?? '?'}`;
    const bad = (run.failed || 0) > 0;
    // 失败优先于过期：一个**失败**的结果哪怕过期了也该先跳出来。
    //
    // ⚠️ 但「优先」不等于「互斥」—— 写成三元表达式的话，
    //   **一个既失败又过期的结果只显示红，丢掉了「它是旧的」**。
    //   而那条信息有用：**一个过期的失败可能已经被修了**，
    //   人下一步该做的是「重跑一遍」而不是「去查那个失败」。
    //
    //   两个类同时给：`.bad` 管颜色和字号（所以它仍然更醒目），
    //   `.stale-data` 管划线。**红着划掉 = 失败了,而且这个结论本身是旧的。**
    tw.className = MC(bad ? 'bad' : '', d.stale ? 'stale-data' : '');
    tw.title = [
      `过 ${run.passed} · 红 ${run.failed ?? '?'}`,
      run.at ? `跑于 ${new Date(run.at).toLocaleString()}` : null,
      run.commit ? `代码版本 ${run.commit}` : null,
      run.files != null ? `${run.files} 个文件` : null,
      run.skipped && run.skipped.length ? `跳过 ${run.skipped.join(', ')}` : null,
      ...why.map((w) => '⚠ ' + w),
      d.stale_hint || null,
    ].filter(Boolean).join('\n');
  }

  // ── 队列积压 ─────────────────────────
  //
  // ⚠️ 后端用的是 XINFO GROUPS 的 pending / lag，**不是 XLEN** ——
  //   XLEN 含已消费的历史，而它在队列刚起时跟等待数答案一致，
  //   **只在跑了一阵之后才分叉**（测试时对，用久了才错）。
  //   判据在 lib/status.js 的 queueStats，这里只负责显示。
  // ★ 写成「排队 W · 在手 P」—— 跟卡片上那两个数同一套说法，**两个数分开，不合成总数**。
  //   （lag = 还没被读走 = 排队；pending = 已投递未 ack = 在手。）
  {
    const qw = $('s-queue-wrap'), qb = $('s-queue');
    const Q = d.queue;
    if (!Q) {
      // 后端没带这个字段 = 旧版 bus。**不是「队列空」** ——
      // 显示 0 会让人以为查过了。
      qb.textContent = '—';
      qw.className = MC('stale-data');
      qw.title = '这版 bus 没有队列信息（/api/status 里没有 queue 字段）。'
               + '这不是「队列是空的」，是「问不到」。重启 bus 试一次。';
    } else if (Q.error) {
      qb.textContent = '查不了';
      qw.className = MC('bad');
      qw.title = `查队列失败：${Q.message || Q.error}\n`
               + '★ 这是「查不了」，不是「没积压」。';
    } else {
      // ★★ lag 算不出来时（流被 XTRIM/XDEL 过），「排队」显示 ? 而不是 0。
      //   显示 0 的话人会停止追查 —— 而那正是这一整个页面反复在防的事。
      const waiting = Q.unknown_lag ? '?' : Q.waiting;
      qb.textContent = `排队 ${waiting} · 在手 ${Q.processing}`;
      const busy = Q.processing > 0 || (!Q.unknown_lag && Q.waiting > 0);
      qw.className = MC(Q.unknown_lag ? 'stale-data' : '', busy ? 'busy-q' : '');
      qw.title = [
        `在手 ${Q.processing}（已投递给某个消费者、还没 ack）`,
        Q.unknown_lag
          ? '排队 **算不出来** —— 有流被裁剪过，redis 给不出 lag。这不是 0。'
          : `排队 ${Q.waiting}（还没被任何消费者读走）`,
        '',
        ...(Q.streams || []).map((x) => `${x.stream} · ${x.group}`
          + ` · 在手 ${x.pending} · 排队 ${x.lag === null ? '?' : x.lag}`),
      ].join('\n');
    }
  }

  // ⚠️ git 的三项是**各自独立失败**的。`available:false` 只覆盖「连 HEAD 都
  //    拿不到」这一种极端，**它不覆盖单项失败** —— `{available:true, head:"…",
  //    commits_today:null}` 是合法组合（`rev-parse` 成功但 `git log` 挂了）。
  //
  //    所以**逐字段判 `null`**，不是判 `available`。判 available 的话
  //    `commits_today: null` 会走正常分支渲染成「—」或「0」——
  //    又一次把「查不了」显示成一个具体答案。
  if (git.available === false || git.head == null) {
    c.textContent = '查不了';
    cw.className = MC('bad');
    cw.title = 'git 不可用。bus 是 launchd 起的，PATH 比你的 shell 窄。';
  } else {
    c.textContent = git.commits_today != null ? git.commits_today : '查不了';
    cw.className = MC(git.commits_today == null ? 'bad' : '');
    cw.title = [
      `HEAD ${git.head}${git.head_subject ? ' · ' + git.head_subject : ''}`,
      '统计范围：今天 00:00 起',
      git.commits_today == null ? '⚠ 今天的 commit 数查不了（git log 挂了）—— 这不是 0' : null,
      git.dirty === true ? '工作区有未提交的改动'
        : git.dirty === false ? '工作区干净' : '⚠ 工作区脏不脏：查不了（不当成干净）',
    ].filter(Boolean).join(' · ');
  }
}

// ══ 右栏「现场」：全量测试 + HEAD ══════════════════════
//
// ★ 跟顶栏读数用**同一份** /api/status 快照（`statusSnap`）—— 两处各拉各的话，
//   分叉时不会有任何东西变红：顶栏说 5 红、面板说 0 红，人只会以为自己看花了。
// ⚠️ 「最近提交列表」**不画**：`/api/status` 的 git 只有 head / head_subject /
//   commits_today / dirty —— 编一个列表出来就是编数据。
// ⚠️ 「分文件的红」同理：`tests` 里没有逐文件结果，只画总数。
function renderLivePanels() {
  const tp = $('tests-panel'), hp = $('head-panel');
  if (!tp || !hp) return;
  const tm = $('tests-meta'), hm = $('head-meta');
  tp.replaceChildren(); hp.replaceChildren();
  tp.className = 'panel'; hp.className = 'panel';
  tp.title = ''; hp.title = '';
  tm.textContent = ''; hm.textContent = '';

  const snap = statusSnap;
  if (snap.kind === 'loading') {
    tp.appendChild(el('div', 'empty', '读取中…'));
    hp.appendChild(el('div', 'empty', '读取中…'));
    return;
  }
  if (snap.kind === '404' || snap.kind === 'error') {
    const label = snap.kind === '404' ? '端点 404' : '查不了';
    for (const p of [tp, hp]) {
      p.classList.add('stale-data');
      p.title = snap.why;
      const big = el('div', 'big');
      big.appendChild(el('b', 'bad', label));
      p.appendChild(big);
      p.appendChild(el('div', 'panel-note bad',
        snap.kind === '404'
          ? 'GET /api/status 返回 404：bus 还没加载新代码（重启 bus），或这个端点还没做。这不是「测试挂了」，是「问不到」。'
          : `/api/status 查不了：${snap.why} —— 这不是「没有结果」。`));
    }
    return;
  }

  const d = snap.d;
  const run = d.tests || null;
  const git = d.git || {};
  const why = (d.stale_reasons || []).map((k) => STALE_WHY[k] || k);

  // ── 全量测试 ──
  const missing = NO_TESTS[run && run.error] || (!run || run.passed == null ? NO_TESTS.no_data : null);
  if (missing) {
    tp.classList.add('stale-data');
    tp.title = missing[1];
    const big = el('div', 'big');
    big.appendChild(el('b', null, missing[0]));
    tp.appendChild(big);
    tp.appendChild(el('div', 'panel-note', missing[1]));
  } else {
    const failed = run.failed;
    tm.textContent = [run.commit ? String(run.commit).slice(0, 7) : null,
      run.at ? `${ago(Date.now() - Date.parse(run.at))}前` : null].filter(Boolean).join(' · ');
    const big = el('div', 'big');
    big.appendChild(el('b', null, String(run.passed)));
    big.appendChild(el('span', 'u', '过'));
    big.appendChild(el('b', (failed || 0) > 0 ? 'bad' : null, String(failed ?? '?')));
    big.appendChild(el('span', 'u', '红'));
    tp.appendChild(big);
    const total = (run.passed || 0) + (failed || 0);
    if (total > 0) {
      const split = el('div', 'split');
      split.setAttribute('aria-hidden', 'true');
      const p = el('span', 'p'); p.style.flex = String(run.passed || 0);
      const f = el('span', 'f'); f.style.flex = String(Math.max(failed || 0, failed ? total / 80 : 0));
      split.appendChild(p); if (failed) split.appendChild(f);
      tp.appendChild(split);
    }
    const kv = (k, v, cls) => {
      const row = el('div', 'kv' + (cls ? ' ' + cls : ''));
      row.appendChild(el('span', null, k));
      row.appendChild(el('span', null, v));
      tp.appendChild(row);
    };
    if (run.files != null) kv('文件数', String(run.files));
    if (run.skipped && run.skipped.length) kv('跳过', run.skipped.join(', '), 'warn');
    kv('逐文件结果', '没有这份数据 —— 只画总数');
    // 过期：整块划掉，原因写在 title（照 pollStatus 的做法）+ 一行看得见的说明
    if (d.stale) {
      tp.classList.add('stale-data');
      tp.title = [...why.map((w) => '⚠ ' + w), d.stale_hint || null].filter(Boolean).join('\n');
      tp.appendChild(el('div', 'panel-note' + ((failed || 0) > 0 ? ' bad' : ''),
        '已过期：' + (why.join('；') || '原因未知') + ' —— 一个过期的绿比没有数字更危险。'));
    }
  }

  // ── HEAD ──
  if (git.available === false || git.head == null) {
    const big = el('div', 'big');
    big.appendChild(el('b', 'bad', '查不了'));
    hp.appendChild(big);
    hp.appendChild(el('div', 'panel-note bad',
      'git 不可用。bus 是 launchd 起的，PATH 比你的 shell 窄。'));
    return;
  }
  hm.textContent = git.commits_today != null ? `今日 ${git.commits_today} 个 commit` : '今日 commit：查不了';
  const cm = el('div', 'cm');
  cm.appendChild(el('span', 'h', String(git.head).slice(0, 7)));
  const subj = el('span', 's', git.head_subject || '（提交说明查不了）');
  subj.title = git.head_subject || '';
  cm.appendChild(subj);
  hp.appendChild(cm);
  const dirty = el('div', 'kv' + (git.dirty === true ? ' warn' : git.dirty == null ? ' bad' : ''));
  dirty.appendChild(el('span', null, '工作区'));
  dirty.appendChild(el('span', null, git.dirty === true ? '有未提交的改动'
    : git.dirty === false ? '干净' : '查不了（不当成干净）'));
  hp.appendChild(dirty);
  if (git.commits_today == null) {
    hp.appendChild(el('div', 'panel-note bad', '今天的 commit 数查不了（git log 挂了）—— 这不是 0'));
  }
  hp.appendChild(el('div', 'panel-note', '只有 HEAD 一行：/api/status 不带提交列表，这里不编一个出来。'));
}


// 私聊历史。**用途不是「看聊天记录」** —— 是复盘：
// 「dev2 掉册那段时间，发给它的消息去哪了」。所以它必须真读流，
// 而且**掉册的那个恰恰是最该查的** —— 名字不在花名册不能退化成返回空。
async function loadDmHistory(name) {
  const chKey = 'dm:' + name;
  const fail = (tag, text) => {
    feeds.set(chKey, [{ sys: true, tag, crit: true, text, at: Date.now() }]);
    loadedCh.delete(chKey);
    renderFeed();
  };
  try {
    const r = await fetch(`/api/messages?to=${encodeURIComponent(name)}&count=200`);
    if (r.status === 404) {
      // 空白会被读成「没说过话」。**而且光说「查不到」也不够** ——
      // 人下一步该干什么才是这句话的用途（否则人分不清「这是坏了还是还没做」）。
      return fail('bus', 'GET /api/messages 返回 404。两种可能：bus 还没加载新代码（重启一下），'
        + '或者这个端点还没做。**这不是「没有消息」，是「问不到」。**');
    }
    const d = await r.json();
    // 后端的 `next` 是它对这个错误给的出口 —— 原样带出来，别在前端另写一句
    // （两份实现的话，后端改了出口只有一份会跟着改）。
    if (!r.ok || d.error) {
      throw new Error(errText(d, r.status));
    }
    const rows = d.messages || d.history || [];
    feeds.set(chKey, []);

    // ★ 第一行说清**你看到的这份历史有多完整**。不是装饰 ——
    //   这个端点的覆盖范围天然不全：`orch:in:agent` 里只有「它发给编排者的」，
    //   **它发给别的 agent 的消息直接进了对方收件流，不在这里**。
    //   人复盘时会把「结果里没有」读成「它没发过」，这行就是拦这个的。
    //
    //   `coverage_note` 用后端那份 —— 前端再写一遍就是第二份实现，
    //   而覆盖范围变了的时候，只有一份会跟着改。
    const src = (d.sources || [])
      .map((s) => `${s.stream || s.direction}:${s.matched ?? s.count ?? '?'}`).join(' · ');
    // ★ `registered` 是三态。`null` = **花名册查询本身失败了**，
    //   跟「查了，它不在册」不是一回事 —— 压成两态的话，redis 半挂时会
    //   显示成「它不在册」，而那正好是复盘时最容易误导人的方向。
    const regNote = d.registered === false ? `${name} 不在花名册（按约定推的流名）`
      : d.registered === null ? `⚠ 花名册本身没查成 —— 这不是「它不在册」，是「查不了」`
        : null;
    push(chKey, {
      sys: true, tag: 'bus', at: Date.now(),
      crit: d.registered === null,
      text: [
        src ? `查了 ${src}` : null,
        regNote,
        d.coverage_note || '发给其它 agent 的消息不在这里 —— 那些直接进了对方收件流',
        // ★ `coverage_note` 说的是「缺什么」，`coverage_next` 说的是「去哪查」。
        //   只显示前一半，这个缺口在页面上就是**死路** —— 而后端明明给了出口。
        d.coverage_next || null,
      ].filter(Boolean).join(' · '),
    });

    for (const m of rows) {
      // ★★ 锚点走 `anchorOf(m, 'dm')` = **job_id**，不是 `m.id`（那是 stream id）。
      //
      //   ⚠️ WS 推来的私聊消息用 `id: m.job_id`（下面 case 'message'），
      //   这里必须一致 —— 用 stream id 的话，**同一条消息刷新前后是两个不同的 id**。
      //   拉 history 会 `feeds.set(chKey, [])` 把频道整个重置，两套 id
      //   不会同时出现在一个列表里，所以平时看不出来；
      //   **但对 thread 是致命的**：父找不到 → 回复散架成顶层，
      //   而且「刚发完好好的，刷新一下就散了」。
      //
      //   ★ `reply_to` 也要带上 —— 私聊同样有 thread。
      const e = { id: anchorOf(m, 'dm'), from: m.from, text: m.text,
                  at: m.timestamp || m.at, reply_to: m.reply_to, kind: m.kind,
                  // ★ 流里读出来是字符串 `'true'`，WS 那条路径推来的是布尔 ——
                  //   `Threads.isDone` 把两种都收敛成布尔，**所以刷新前后
                  //   feed 里这个字段是同一个类型**。
                  done: Threads.isDone(m) || undefined,
                  sender_type: m.sender_type || undefined,
                  expects_reply: Threads.expectsReply(m) || undefined,
                  verify: m.verify || undefined };
      seenIds.delete(dedupeKey(e));
      // 方向和来源流留在条目上 —— 复盘时「这条从哪条流查到的」是要核的，
      // 而 `from` 一个字段答不了（同一个名字可能出现在两条流里）。
      e.stream = m.stream; e.direction = m.direction;
      push(chKey, e);
    }
    loadedCh.add(chKey);
    renderFeed();
  } catch (e) {
    // ★ 后端对「一个源查失败」是整体 503 而不是返回一半 —— 因为
    //   「它收到 12 条、一条都没发过」正好是**单向失聪的样子**，
    //   而半份数据看起来是完整的。这里把那声拒绝原样转达，不降级成空白。
    fail('bus', '读私聊历史失败：' + String(e.message || e));
  }
}

// ── 产出文件面板 ──────────────────────────────
//
// ⚠️ 跟文档面板**共用第三栏，互斥** —— `.app.with-doc` 只定义了三列，
//   两个都打开会挤成不可读的宽度。开一个必须关另一个。
//   （不是「以后再支持」：三列已经是桌面宽度的极限，第四列没地方放。）

const FICON = {
  image: '🖼', pdf: '📄', text: '📝', data: '📊', code: '📜', file: '📎',
};

function humanSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

let filesData = null;      // 上一次拿到的 /api/outputs
let filesQuery = '';

function closeFiles() {
  $('filepane').hidden = true;
  $('files-btn').classList.remove('on');
  if ($('docpane').hidden) $('app').classList.remove('with-doc');
}

function renderFiles() {
  const body = $('files-body');
  body.replaceChildren();
  const meta = $('files-meta');

  if (!filesData) { body.appendChild(el('div', 'empty', '读取中…')); return; }
  if (filesData.error) {
    meta.textContent = '';
    const d = el('div', 'empty');
    d.appendChild(el('div', null, `✗ ${filesData.message || filesData.error}`));
    // ★ 「列不出来」和「没有产出」必须分开 —— 后者是正常状态，前者要人去看权限。
    d.appendChild(el('div', null, filesData.next || '这不是「没有产出」，是「列不出来」。'));
    body.appendChild(d);
    return;
  }

  const q = filesQuery.trim().toLowerCase();
  let shownFiles = 0, shownJobs = 0;
  for (const job of filesData.jobs || []) {
    const files = q ? job.files.filter((f) => f.name.toLowerCase().includes(q)) : job.files;
    if (!files.length) continue;
    shownJobs++; shownFiles += files.length;

    const grp = el('div', 'job-grp');
    const h = el('div', 'job-h');
    h.appendChild(el('b', null, job.job_id));
    h.appendChild(el('span', null, ago(Date.now() - job.mtime) + '前'));
    grp.appendChild(h);

    for (const f of files) {
      const a = document.createElement('a');
      a.className = `frow ${f.status}`;
      // ★ 「生成中」的文件**不给链接** —— 点开一个写了一半的 PDF
      //   会得到一个损坏文件，而人会以为是生成坏了。
      if (f.status === 'ready') {
        a.href = `/api/outputs/${encodeURIComponent(job.job_id)}/${encodeURIComponent(f.name)}`;
        a.target = '_blank';
        a.rel = 'noopener';
      } else {
        a.title = '还在写（.partial）—— 写完会自动变成可点的';
      }
      a.appendChild(el('span', 'ficon', FICON[f.kind] || FICON.file));
      const nm = el('span', 'fname', f.name);
      if (f.superseded_partial) {
        // 残留的 .partial：**有个生成过程崩了**，这是唯一的痕迹
        const w = el('span', 'fwarn', ' ⚠');
        w.title = '同名的 .partial 还在 —— 说明上一次生成崩在半路，残留没清掉。';
        nm.appendChild(w);
      }
      a.appendChild(nm);
      a.appendChild(el('span', 'fstat',
        f.status === 'ready' ? '✓ 已就绪' : '⟳ 生成中'));
      a.appendChild(el('span', 'fmeta',
        f.status === 'ready' ? `${humanSize(f.size)} · ${ago(Date.now() - f.mtime)}前` : humanSize(f.size)));
      grp.appendChild(a);
    }
    body.appendChild(grp);
  }

  if (!shownJobs) {
    body.appendChild(el('div', 'empty', q
      ? `没有匹配「${filesQuery}」的文件。`
      : 'agent 还没产出过文件。约定目录：outputs/<job_id>/'));
  }
  // ★ 截断了必须说 —— 一个静默截断的列表会让人以为那就是全部。
  meta.textContent = [
    `${shownFiles} 个文件`,
    filesData.truncated ? `（只显示最近 ${(filesData.jobs || []).length}/${filesData.total} 批）` : null,
  ].filter(Boolean).join(' ');
}

async function loadFiles() {
  try {
    const r = await fetch('/api/outputs');
    const d = await r.json().catch(() => ({}));
    filesData = r.ok && !d.error ? d : { error: d.error || `HTTP ${r.status}`, message: d.message, next: d.next };
  } catch (e) {
    filesData = { error: 'fetch_failed', message: String(e.message || e) };
  }
  renderFiles();
}

function openFiles() {
  closeDoc();
  $('filepane').hidden = false;
  $('files-btn').classList.add('on');
  $('app').classList.add('with-doc');
  loadFiles();
}

// ── 文档面板 ───────────────────────────────────────────────────
function closeDoc() {
  $('docpane').hidden = true;
  if ($('filepane').hidden) $('app').classList.remove('with-doc');
}

async function openDoc(path) {
  const pane = $('docpane'), body = $('doc-body');
  closeFiles();                 // 互斥：第三栏一次只放一个
  pane.hidden = false;
  $('app').classList.add('with-doc');
  $('doc-title').textContent = path;
  $('doc-meta').textContent = '读取中…';
  body.replaceChildren();

  const fail = (msg) => {
    $('doc-meta').textContent = '';
    body.replaceChildren();
    const d = el('div', 'empty');
    d.textContent = msg;
    body.appendChild(d);
  };
  try {
    const r = await fetch('/api/docs/' + path.replace(/^docs\//, ''));
    if (r.status === 404) {
      const d = await r.json().catch(() => null);
      // ★ 后端把「拒绝」和「没找到」分成了不同状态码。前端要把那个区别
      //   转达出去 —— 混成一句「打不开」等于把后端做的功夫扔了。
      return fail(d && d.error ? errText(d, 404)
        : 'GET /api/docs 返回 404，而且不是后端给的那种 404。'
          + '两种可能：bus 还没加载新代码（重启一下），或者这个端点还没做。');
    }
    const d = await r.json();
    if (!r.ok || d.error) return fail(errText(d, r.status));
    $('doc-meta').textContent = [
      d.size != null ? Math.round(d.size / 1024) + 'KB' : null,
      d.mtime ? new Date(d.mtime).toLocaleString() : null,
    ].filter(Boolean).join(' · ');
    body.innerHTML = mdToHtml(d.content || '');
    for (const pre of body.querySelectorAll('pre')) {
      pre.appendChild(copyBtn(() => pre.textContent, 'pre-copy'));
    }
    body.scrollTop = 0;
  } catch (e) {
    fail('读不到这份文档：' + String(e.message || e)
      + ' —— 先看 bus 在不在（curl /health）。这不是「文件不存在」。');
  }
}

/** 上一次 /health 的结果 —— 顶栏 `#s-lat` 和今天视图数字行的「bus」用**同一个值**。 */
let healthSnap = { kind: 'loading' };
async function pollHealth() {
  const t0 = performance.now();
  try {
    const r = await fetch('/health');
    const d = await r.json();
    const ms = Math.round(performance.now() - t0);
    $('s-lat').textContent = d.ok ? ms + 'ms' : 'redis down';
    healthSnap = d.ok ? { kind: 'ok', ms } : { kind: 'redis_down' };
  } catch (_) {
    $('s-lat').textContent = '断开';
    healthSnap = { kind: 'down' };
  }
  renderToday();
}

// ── 桌面通知 ────────────────────
//
// 触发判据只有一个：**消息上带 `done`**，由发消息的 agent 自己标。
// 不猜文本、不按「agent 回话了」算 —— agent 报进度、提问、报完成，这三种
// 在队列里长得一模一样，判据选错的下场不是「偶尔漏一个」，是
// **人开始忽略所有通知**，那时这个功能就等于没做。
//
// ⚠️ 这一半只能在前端做（浏览器 API）。另一半（🏁 标记）在后端做 ——
//   理由写在 `lib/relay.js` 那处：标记是事实，不该取决于谁开着页面。

function notifyState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;          // 'granted' | 'denied' | 'default'
}

/**
 * 这个页面是不是被嵌在别人的框里。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★★ **`denied` 有两种成因，而它们的下一步动作完全相反。**
 *
 *   真的被拒过        浏览器记着一条拒绝记录 → 去设置里改得回来（文案对）
 *   🔴 跨源 iframe 里  **他从没见过那个对话框** → 去设置里找不到任何记录
 *                     照着那句话找，只会得出「这界面在骗我」
 *
 * ── 已确认的事实（不用再试）────────────────
 *   `notifications` **不是** Permissions Policy 特性 ——
 *   `document.featurePolicy.features()` 里没有它，
 *   `allow="notifications"` 写上去被**静默忽略**。
 *   同源 iframe 是 `default`，跨源就是 `denied`，加不加 allow 都一样。
 *   ⇒ **这条路已排除。能做的只有把话说对。**
 *
 * ⚠️ 用 try/catch：跨源时读 `window.top` 本身可能抛 SecurityError ——
 *   而**抛异常恰好就证明了「不同源」**，所以 catch 里返回 true，不是 false。
 *   （反过来写的话，最需要这个分支的场景正好落进「不是 iframe」那一支。）
 * ══════════════════════════════════════════════════════════════════
 */
function inIframe() {
  try { return window.top !== window.self; } catch (_) { return true; }
}

/** `denied` 时该对人说什么 —— 两种成因两句话，**下一步都得是可执行的**。 */
function deniedText(kind) {
  if (inIframe()) {
    // ★ 不提「浏览器设置」：他在这个 iframe 里从没被问过，设置里没有记录可改。
    //   唯一真正可行的下一步是**换个地方打开**。
    return kind === 'title'
      ? '这个页面被嵌在 iframe 里 —— 跨源 iframe 拿不到通知权限，'
        + '浏览器设置里也找不到记录。直接开 127.0.0.1:9969 就能开通知'
      : '通知在 iframe 里开不了 —— 跨源 iframe 的通知权限恒为 denied，'
        + '而且你**从没见过那个对话框**，所以浏览器设置里没有任何记录可改。'
        + '直接在新标签页打开 127.0.0.1:9969，在那里开通知。';
  }
  return kind === 'title'
    ? '你（或浏览器）拒绝过通知权限 —— 页面要不回来了，'
      + '得去浏览器地址栏左边的设置里把「通知」改成允许'
    : '通知权限之前被拒过 —— 页面自己要不回来。'
      + '去地址栏左边的图标 → 通知 → 允许，然后刷新。';
}

function renderNotifyBtn() {
  const b = $('notify-btn');
  if (!b) return;
  const st = notifyState();
  // ★ 三种「不弹」的原因必须在按钮上分得开 —— 它们的下一步动作完全不同：
  //   没支持 = 换浏览器；没授权 = 点这个按钮；被拒 = 只能去浏览器设置里改，
  //   **点按钮已经没用了**。压成一个「通知 ✕」的话，人会一直点那个按钮。
  const M = {
    unsupported: ['通知 ✕', '这个浏览器没有 Notification API —— 换 Chrome/Edge'],
    granted: ['通知 ✓', '任务完成时会弹桌面通知。点通知跳到那条消息。'],
    // ★ 两处文案都走 `deniedText()`（这里和 `askNotify()`）——
    //   **只改一处等于没改**：按钮 title 说对了、点下去的提示还在骗人，
    //   而人多半是点了才去看提示的。
    denied: ['通知 ⛔', deniedText('title')],
    default: ['通知 —', '点一下开启：任务完成时弹桌面通知'],
  };
  const [label, title] = M[st] || M.default;
  b.textContent = label;
  b.title = title;
}

async function askNotify() {
  const st = notifyState();
  if (st === 'unsupported') return;
  if (st === 'denied') {
    // 点了也没用，所以**说出来**，而不是静静地什么都不发生。
    pushSys('bus', deniedText('sys'), true, Date.now());
    renderFeed();
    return;
  }
  if (st === 'granted') { renderNotifyBtn(); return; }
  try { await Notification.requestPermission(); } catch (_) { /* 老浏览器回调式，忽略 */ }
  renderNotifyBtn();
}

/**
 * 一条完成报告到了 —— 该不该弹。
 *
 * ⚠️ **页面正被盯着的时候不弹**（`document.hasFocus()`）：那一刻消息本身
 *   就在他眼前，桌面通知是纯噪音。而通知一旦变成噪音，人会关掉它，
 *   于是**他真正离开时也收不到了** —— 那才是这个功能存在的场景。
 *
 * ⚠️ 不用 `visibilityState`：标签页在另一个没聚焦的窗口里时它仍是
 *   `'visible'`，而那时人根本没在看。`hasFocus()` 判的是「这个页面
 *   现在拿着键盘焦点」，跟「他正在看」贴得更近。
 */
function onDoneMessage(m, scope) {
  if (!Threads.isDone(m)) return;

  // ── ① 让后端刚打的 🏁 立刻可见 ────────────────────────────────
  //
  // ★★ **不做这一步，🏁 要等到下次刷新页面才出现。**
  //   `renderReactions` 的规则是「缓存命中就同步画，不再请求」——
  //   而 thread 的根**早就渲染过了**，它的反应条一定在缓存里，
  //   于是后端刚加上去的那个 🏁 永远等不到一次重查。
  //
  //   症状会长成最难查的那种：**通知弹了、消息也到了，就是没有标记**，
  //   而 F5 一下它又在了 —— 「刷新前后不一致」，两边各自都「能用」。
  //
  //   anchor 取 `reply_to || 自己`，跟 `lib/relay.js` 打标那处**必须是
  //   同一个算法** —— 两边各算各的话，前端会去查一个后端没打过的锚点，
  //   然后画出一个空的反应条，同样零报错。
  const anchor = m.reply_to || anchorOf(m, scope);
  if (anchor != null) {
    const k = rKey(scope, String(anchor));
    reactCache.delete(k);
    reactFailed.delete(k);
    reactWanted.add(k);
    scheduleReactFetch();
  }

  // ── ② 桌面通知 ──────────────────────────────────────────────
  // ★ 弹不弹、标题写什么由 `Threads.doneNotice` 定：核验在跑（verify:pending）不弹，
  //   等那条 verify:pass 的跟帖再弹；没核过的标题里写「未验证」。判据在 threads.js 里测得到。
  const notice = Threads.doneNotice(m);
  if (!notice.notify) return;
  if (notifyState() !== 'granted') return;
  if (document.hasFocus()) return;
  const who = m.from || '?';
  const body = String(m.text || '').slice(0, 160);
  try {
    const n = new Notification(notice.title, {
      body,
      // ★ `tag` 按发送者分组：同一个 agent 连报两条，第二条**替换**第一条而不是
      //   叠成两个。不加的话一次批量收尾能糊满整个屏幕角。
      tag: 'engloop-done-' + who,
      renotify: false,
    });
    n.onclick = () => {
      window.focus();
      // 跳到那个 agent 的私聊频道。房间来的完成报告跳不过去 ——
      // 那需要房间 hash，而通知里只有发送者；先聚焦窗口已经够用了。
      if (!m.room_hash) select({ kind: 'dm', id: who, name: who, members: [] });
      n.close();
    };
  } catch (_) {
    // 通知构造失败（某些平台在权限 granted 下仍会抛）不能影响消息渲染 ——
    // 消息本身已经进 feed 了，这里挂掉会连带整个 WS 路由那一轮。
  }
}

// ── WebSocket ──────────────────────────────────────────────────
let ws = null;
let retry = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');

  ws.onopen = () => {
    retry = 0; $('wsdot').className = 'on'; $('wsdot').title = 'WebSocket 已连接';
    // ★ 点旁边带字（不只靠颜色）
    $('ws').className = 'ws on'; $('ws-text').textContent = '已连接';
    $('ws').title = 'WebSocket 已连接 · 后面那个数是 bus /health 的往返时间';
  };
  ws.onclose = () => {
    $('wsdot').className = 'off';
    $('wsdot').title = 'WebSocket 断开 —— 页面停在最后一帧，不再更新';
    $('ws').className = 'ws off'; $('ws-text').textContent = '断开';
    $('ws').title = 'WebSocket 断开 —— 页面停在最后一帧，不再更新（正在重连）';
    // 断线不重连的话，页面就变成一张**看起来正常的静态快照** ——
    // 那是这个页面自己的失聪，跟它要检测的病是同一种。
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** retry);
  };
  ws.onerror = () => { try { ws.close(); } catch (_) { /* onclose 会接手重连 */ } };

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    route(m);
  };
}

function route(m) {
  switch (m.type) {
    case 'hello':
      return;

    case 'message': {
      // agent → 人。归到发言者的私聊频道。
      const chKey = 'dm:' + (m.from || ORCH);
      // ★ 锚点走同一个函数（这里本来就是 job_id，改成 anchorOf 是为了
      //   **只有一处知道「私聊取哪个字段」**）；`reply_to` 必须带上 ——
      //   漏掉它的话实时推送显示成顶层、刷新走 history 又摞回去，
      //   刷新前后不一致（room_message 那条注释里同一个警告）。
      // ★ `done` 跟着进 feed —— 渲染要它（🏁 那一行标记）、
      //   `onDoneMessage` 也要它。判定过 `Threads.isDone` 一次就够，
      //   后端推来的已经是布尔（`bin/serve.js` 那处判过了），这里再判一次
      //   是为了**历史那条路径**（走 /api/messages 拿到的是字符串 'true'）
      //   跟这条路径落进 feed 的形状一致 —— 两条路径给出不同类型的同一个
      //   字段，是「刷新前后不一致」的经典长法。
      const pushedDm = push(chKey, { id: anchorOf(m, 'dm'), from: m.from, text: m.text,
                    at: m.at, reply_to: m.reply_to || undefined, kind: m.kind || undefined,
                    done: Threads.isDone(m) || undefined,
                    expects_reply: Threads.expectsReply(m) || undefined,
                    // bin/serve.js 推的 message 带 verify（不带 sender_type —— 核验跟帖要刷新后才合并得上）
                    verify: m.verify || undefined, sender_type: m.sender_type || undefined });
      if (pushedDm) bumpUnread(chKey);
      onDoneMessage(m, 'dm');
      // 私聊推送不带 `to` ⇒ 派给 agent 的活推不过来，泳道那一列防抖 3 秒重拉
      laneNudge(m.from);
      break;
    }

    case 'room_message': {
      const chKey = 'room:' + m.room_hash;
      // ⚠️ `reply_to` 必须跟着走。漏掉的话**实时推送里这条显示成顶层，
      //   而刷新页面（走 history）之后它又摞回去了** —— 刷新前后不一致
      //   是最难查的一类，因为两边各自都「能用」。
      const pushedRoom = push(chKey, { id: anchorOf(m, 'room'), from: m.from, text: m.text,
                    at: m.at, reply_to: m.reply_to, kind: m.kind,
                    done: Threads.isDone(m) || undefined,
                    expects_reply: Threads.expectsReply(m) || undefined,
                    verify: m.verify || undefined, sender_type: m.sender_type || undefined });
      // 自己发的那条 WS 推回来时已经被本地回显去重了（push 返回 false），不算未读
      if (pushedRoom && m.from !== REACT_ME) bumpUnread(chKey);
      onDoneMessage(m, 'room');
      break;
    }

    // ⚠️ 字面值是 `watchdog`，**不是** `watchdog_event`。后端有一条断言把它
    //   钉死了（9 档判定逐个验 type）—— 改它之前先确认后端那条断言也一起改。
    case 'watchdog': {
      // watchdog 事件进**当前**频道的时间流 —— 它是全局事件，而人正在看的
      // 那条流才是它需要出现的地方（时序关系只有在同一条流里才成立）。
      //
      // ★ `blind` 是 watchdog 对**自己**的判定（它连 tmux 列表都拿不到）。
      //   跟 deaf 同级 —— 一个瞎掉的看门狗比任何单个 agent 失聪都危险。
      const crit = CRIT_LEVELS.has(m.level);
      // 冷却期内的重复判定**照样显示**，只是标出来。不显示的话
      // 「这轮判定它仍然失聪」和「这轮根本没检查」在界面上同形 ——
      // 而那两件事一个是「问题还在」，一个是「我不知道」。
      const text = (m.text || `${m.name || '?'} · ${m.level || ''}`)
        + (m.throttled ? '（冷却中，未重复动作）' : '');
      pushSys('watchdog', text, crit, m.at);
      break;
    }

    case 'shutdown': {
      const timeout = m.outcome === 'timeout';
      // 「它是自己走的」和「我们等不下去了」是两件事 —— 混在一起会掩盖
      // 一个卡死的 agent。
      pushSys('bus', `${m.name} 关停：${timeout ? '超时强杀' : '正常收尾'}`
        + (m.detail ? ` —— ${m.detail}` : ''), timeout, Date.now());
      break;
    }

    case 'error':
      pushSys('bus', `${m.error}: ${m.message || ''}`, true, Date.now());
      break;

    default:
      // 未知类型不静默丢弃 —— 后端加了新事件而前端没跟上时，
      // 「什么都没显示」和「没发生什么」在页面上同形。
      pushSys('bus', `未识别的事件 type=${m.type} —— 后端推了一种前端没认出的事件。`
        + '别的功能不受影响，但**这条的内容你看不到**。刷新页面试一次（可能是旧版 JS），'
        + '还这样就是前后端版本不同步。', false, Date.now());
  }
  renderFeed();
  scheduleLanes();   // 房间那部分直接从 feeds 里来，不用拉
}

/** 系统行。默认进**当前**频道；`chKey` 给了就进那个频道（命令条发失败时报在目标频道里）。 */
function pushSys(tag, text, crit, at, chKey) {
  push(chKey || keyOf(current), { sys: true, tag, text, crit, at: at || Date.now() });
}

// ── 发送 ───────────────────────────────────────────────────────
// ── 回复目标（thread）─────────────────────────────────────────
//
// ⚠️ **切换频道必须清掉它**。不清的话，你在 A 房间点了「回复」、切到 B 房间
//   发言，那条会带着 A 的 reply_to 发出去 —— 挂在一条 B 里不存在的父消息上，
//   于是显示成顶层。**跟没回复过一模一样，零报错。**
//   （这跟「房间消息用 username 回」是同一个形状的坑。）
let replyTarget = null;

/**
 * 设定「正在回复谁」。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★★ **回复目标归一到 thread 的根，不是被点的那一条**
 *
 *   点 thread 里第 5 条回复 → 如果存第 5 条，`reply_to` 指向它
 *   ⇒ **两层变三层**，而下一次又变四层。
 *
 *   归一到根之后：**点任何一条，回复都挂在同一个根下面 —— 永远两层。**
 *
 * ⚠️ 判错时的症状**要好几轮对话才看得见**（第一层嵌套时界面还正常），
 *   而那时人只会觉得「界面有点乱」，不会想到是这一行的判据错了。
 *   ⇒ 所以它有一条变异守着（`rootOf` 改成返回被点的那条必须红）。
 * ══════════════════════════════════════════════════════════════════
 *
 * ★ 复用 `Threads.rootIdOf`，**不新写一个上溯函数** —— 那边已经有
 *   环保护（`post()` 明确写着 `reply_to` **只存不验**，流里可以合法存在
 *   A→B→A，没有环保护会让整个频道渲染不出来）和「父不在这批里就当根」。
 *   写第二个的那天，两个上溯规则会分叉，而分叉时两边各自都「能用」。
 */
function setReplyTarget(e) {
  if (!e) { replyTarget = null; renderReplyBar(); $('input').focus(); return; }
  // 在**当前频道**里上溯 —— byId 只含这个频道的消息，跨频道的 id 本来就
  // 不该被找到（换频道会清 replyTarget，见 select()）。
  const cur = feeds.get(keyOf(current)) || [];
  const byId = new Map(cur.filter((x) => x && x.id != null).map((x) => [x.id, x]));
  // ★ 带上合并映射：话题被并走之后，回复它要挂到**合并后的那个根**上。
  //   不带的话流里存的 `reply_to` 指向旧根 —— 界面上看不出来（group 认映射），
  //   但撤销合并的那天这条回复会跳回原话题里。
  const rootId = Threads.replyTargetIdOf(e, byId, mergesOf(current));
  const root = byId.get(rootId) || e;
  replyTarget = {
    id: rootId,                       // ★ 存**根**的 id —— 归一的全部就是这一行
    from: root.from,
    text: root.text,
    // 人点的是哪一条 —— 只用于回复条上那句「（你点的是 thread 里第 N 条）」，
    // **不参与 reply_to**。留着是因为「我点了 A 却回给了 B」如果不说出来，
    // 看起来像点错了。
    clickedId: e.id,
    clickedDiffers: rootId !== e.id,
  };
  renderReplyBar();
  $('input').focus();
}

/** 输入框上方那条「正在回复 X」。**看不见它的话，人不知道这条会发到哪。** */
function renderReplyBar() {
  const bar = $('replying');
  if (!bar) return;
  if (!replyTarget) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.hidden = false;
  bar.replaceChildren();
  const one = String(replyTarget.text || '').split('\n')[0];
  bar.appendChild(el('span', 'replying-to',
    `↳ 回复 ${replyTarget.from}：${one.slice(0, 60)}${one.length > 60 ? '…' : ''}`));
  // ★ 点的和回的不是同一条时**必须说出来**：回复目标被归一到了 thread 的根
  //   （见 setReplyTarget）。不说的话人会以为自己点错了 ——
  //   **一个正确但出乎意料的行为，跟一个 bug 在屏幕上长得一样。**
  if (replyTarget.clickedDiffers) {
    const n = el('span', 'replying-note', '（你点的是这个话题里的一条回复 —— 回复会挂到话题下面，保持两层）');
    n.title = '这个系统里 thread 永远只有两层：话题 + 回复。\n'
            + '点 thread 里任何一条，回复都挂在话题本身下面。';
    bar.appendChild(n);
  }
  const x = el('button', 'replying-x', '取消');
  x.title = '取消之后这条会作为新的顶层发言发出去';
  x.onclick = () => setReplyTarget(null);
  bar.appendChild(x);
}

/**
 * 对话视图 composer 的发送：读输入框的**薄壳**，真正发送的是 `sendTo`。
 * 这里只剩 composer 自己的事：读 / 清输入框、带「回复中」的 reply_to、发完展开那个 thread。
 */
async function send() {
  const box = $('input');
  const text = box.value.trim();
  if (!text || box.disabled) return;
  box.value = '';
  box.style.height = 'auto';
  // ★ 私聊也能回 thread。`replyTarget.id` 已经是规范化过的锚点（房间=房间流 id，私聊=job_id）。
  const replyingTo = replyTarget ? replyTarget.id : null;
  const target = current;
  const r = await sendTo(target, text, { replyTo: replyingTo, box });
  if (!r.ok) return;
  // ★ 发完把那个 thread 展开 —— 否则自己刚发的回复藏在折叠条后面，
  //   屏幕上什么都没变化，**看起来像没发出去**。
  //
  //   ⚠️ 展开的必须是**根**的 id，不是 `replyingTo`：回复一条回复时
  //   那两个不是同一个。用 `rootIdOf` 上溯 —— 这也是它被导出的原因。
  if (replyingTo) {
    const cur = feeds.get(keyOf(target)) || [];
    const byId = new Map(cur.filter((x) => x && x.id != null).map((x) => [x.id, x]));
    openThreads.add(Threads.rootIdOf(byId.get(replyingTo) || { id: replyingTo }, byId));
    // 发完就清 —— 下一句默认是新的顶层发言。**不清的话人会连着往同一个
    // thread 里灌而不自知**（输入框看起来是空的，没有任何提示）。
    setReplyTarget(null);
  }
  renderFeed();
}

/**
 * ★★ 发送**只有这一份**：对话视图的 composer（`send()`）和泳道的命令条
 *   （`cmdSend()`）都调它。下面三件事两处必须一样，所以只写在这里：
 *   · 非 202 ⇒ pushSys 报错，**把字还给输入框**（`box`）
 *   · 本地回显（进目标频道的 feed）
 *   · 房间走 `/api/rooms/:hash/post`，私聊走 `/api/message`
 * ⚠️ 私聊只能发给编排者：`POST /api/message` 一律进 `orch:in:human`（bin/serve.js），后端没有「人直接发给 agent」的接口。
 *   composer 那边靠 `renderBar` 禁用输入框，命令条那边靠目标表里没有 agent（`Derive.cmdTargets`）+ `cmdSend` 再挡一次。
 * @returns {Promise<{ok: boolean, error?: string, id?: string|null}>}
 */
async function sendTo(target, text, { replyTo = null, box = null } = {}) {
  const isRoom = target.kind === 'room';
  const chKey = keyOf(target);
  const url = isRoom ? `/api/rooms/${encodeURIComponent(target.id)}/post` : '/api/message';
  // ★ 房间和私聊都带 reply_to（私聊也能回 thread）。
  //   `replyTarget.id` 已经是规范化过的锚点（房间=房间流 id，私聊=job_id），
  //   两条路径在这里不需要再分叉。
  const replyingTo = replyTo || null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // ★ 不带 `from`：发件人由 bus 从登录 session 里取，body 里写了也不用。
      body: JSON.stringify({ text,
                             ...(replyingTo ? { reply_to: replyingTo } : {}) }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status !== 202) {
      // Redis 不可用时 bus **大声拒绝**。界面必须把那声拒绝转达出去 ——
      // 把发失败画成发出去了，是这里能犯的最坏的错。
      // ★ 「字已经还给你了」必须说出来 —— 否则人会以为要重打一遍，
      //   而重打的过程里那段话往往就变了。
      const why = `${d.error || r.status}${d.message ? ' —— ' + d.message : ''}`;
      pushSys('bus', `✗ 没发出去：${why}`
        + '。**消息没进队列，没有人收到它。** 你的字还在输入框里，直接再按一次发送就行。', true, null, chKey);
      if (box) box.value = text;    // 把字还给人，别让它消失
      renderFeed();
      return { ok: false, error: why };
    }
    // 本地回显。房间的那条 WS 还会推回来一次，靠 id 去重。
    // ★ 回显也要带 reply_to，否则**自己发的回复会先在顶层闪一下**，
    //   等 WS 推回来才跳进 thread 里 —— 那个跳动看起来像发错了地方。
    // ★ 锚点走 anchorOf：房间的 202 响应带 `id`（房间流 id），
    //   私聊的带 `job_id` —— 而**哪种频道取哪个字段只有那一个函数知道**。
    //   别写成 `d.id || d.job_id`：两种情况恰好都对，
    //   但它是第二处「知道该取哪个」的代码，跟 anchorOf 分叉时不会有任何症状。
    const id = anchorOf(d, isRoom ? 'room' : 'dm');
    push(chKey, { id, from: 'Patrick', text, at: Date.now(), sender_type: 'human',
                  ...(replyingTo ? { reply_to: replyingTo } : {}) });
    renderFeed();
    return { ok: true, id };
  } catch (e) {
    const why = String(e.message || e);
    pushSys('bus', '✗ 没发出去：' + why, true, null, chKey);
    if (box) box.value = text;
    renderFeed();
    return { ok: false, error: why };
  }
}

// ══════════════════════════════════════════════════════════════════════
//  共用外壳：视图路由 · 未读 · 需要你 · ⌘K 跳转 · 窄屏开合
// ══════════════════════════════════════════════════════════════════════
//
// ★ 这一段只读现有的 API（/api/agents、/api/status、各频道历史），
//   全部状态都在内存或 localStorage 里。

/** 每个 agent 的状态（STATUS 表里那一项）—— 私聊列表的点和符号用它。 */
const agentStatus = new Map();
/** agent → type —— 消息上的「编排者 / agent」小标签用它。查不到就不画。 */
const agentTypes = new Map();
/** 心跳环形缓冲（Derive.createHeartbeat）。只在内存里，刷新即空。 */
const heartbeat = Derive.createHeartbeat();
/** 上一次 /api/agents 的结果：`{data}` 或 `{error}`；还没拿到过 = null。「需要你」据此说「查不了」。 */
let agentsSnap = null;
/** 未读：这次页面加载里经 WS 推来、而你没在看的条数。chKey → n。只在内存里。 */
const unread = new Map();

function bumpUnread(chKey) {
  // 正在看的那个频道不算未读（对话视图打开着、而且就是它）
  if ((view === 'chat' || (view === 'today' && drawerOpen())) && chKey === keyOf(current)) return;
  unread.set(chKey, (unread.get(chKey) || 0) + 1);
}

// ── 路由：#/today · #/chat/<room|dm>/<id> · #/lanes ─────────────────────
//
// ★ 上次用的视图存 localStorage；第一次打开默认「今天」。
// ⚠️ `localStorage` 在隐私模式 / 禁用存储的 iframe 里会**抛异常** —— 读写一律包 try/catch
//   （`firstOpenToday()` 那段同一条）。读不到就当第一次打开。
// ⚠️ 消息里的 `docs/…` 链接也是 `#docs/...` 形状的 hash —— 只认 `#/` 开头的才是路由。
const ROUTE_KEY = 'engloop:last-route';
let view = 'today';

function chatRouteOf(ch) {
  return `/chat/${ch.kind === 'room' ? 'room' : 'dm'}/${encodeURIComponent(ch.id)}`;
}

function parseRoute(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (!h.startsWith('/')) return null;
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'today') return { view: 'today' };
  if (parts[0] === 'lanes') return { view: 'lanes' };
  if (parts[0] === 'chat') {
    if ((parts[1] === 'room' || parts[1] === 'dm') && parts[2]) {
      let id = parts[2];
      try { id = decodeURIComponent(parts[2]); } catch (_) { /* 坏的编码就原样用 */ }
      return { view: 'chat', kind: parts[1], id };
    }
    return { view: 'chat' };
  }
  return null;
}

function saveRoute(r) {
  try { localStorage.setItem(ROUTE_KEY, r); } catch (_) { /* 存不下就下次默认「今天」 */ }
}

/** 改地址栏。`replace` 用 replaceState —— 不触发 hashchange，也不往历史里塞一堆频道切换。 */
function setRoute(r, { replace = false } = {}) {
  const want = '#' + r;
  if (location.hash === want) { saveRoute(r); return; }
  if (replace) { history.replaceState(null, '', want); saveRoute(r); applyRoute(); return; }
  location.hash = want;          // hashchange → applyRoute
}

let routed = false;   // 第一次 applyRoute 之前不算「离开」过今天视图
function applyRoute() {
  const r = parseRoute(location.hash);
  if (!r) return;                // 不是路由（比如 #docs/...），不动
  const prev = view;
  // ★ 「离开今天视图」的三种情况之一（另两种是 visibilitychange → hidden、pagehide，见启动段）
  if (routed && prev === 'today' && r.view !== 'today') recordTodayLeave();
  routed = true;
  view = r.view;
  // 对话流 + composer 跟着视图走：今天 ⇒ 抽屉，其余 ⇒ 对话视图中间（同一套节点，不复制）
  placeChatColumn();
  for (const v of ['today', 'chat', 'lanes']) {
    $('view-' + v).hidden = v !== view;
    const tab = $('tab-' + v);
    tab.setAttribute('aria-selected', v === view ? 'true' : 'false');
    tab.tabIndex = v === view ? 0 : -1;
  }
  // 节点挪过之后滚动位置被浏览器归零了 —— 看得见的话按挪之前记的锚放回去
  if (feedVisible()) restoreScroll($('feed'), chatScrollMemo);
  if (view === 'today') {
    applyDrawer();
    renderDrawerHead();
    renderToday();
  }
  if (view === 'chat') {
    if (r.kind && (r.kind !== current.kind || r.id !== current.id)) {
      const room = r.kind === 'room' ? roomList.find((x) => x.hash === r.id) : null;
      select({ kind: r.kind, id: r.id, name: room ? room.name : r.id,
               members: room ? room.members || [] : [], count: room ? room.message_count : undefined },
             { fromRoute: true });
    }
    unread.delete(keyOf(current));
    // `#/chat`（不带频道，比如占位页里那个链接）⇒ 地址栏补成当前频道，复制出去的链接才指得准
    if (!r.kind) history.replaceState(null, '', '#' + chatRouteOf(current));
    saveRoute(chatRouteOf(current));
    // 从别的视图切回来时，对话流要落到该落的位置（隐藏期间渲染的那次量不到高度）
    renderFeed();
  } else {
    saveRoute('/' + view);
  }
  closeOverlays();
  renderChannels();
  // 进泳道视图 ⇒ 立刻画（隐藏期间不画），上次拉取超过 30 秒就重拉一轮
  if (view === 'lanes') {
    renderLanes();
    if (Date.now() - laneFetchedAt >= LANE_REFRESH_MS) refreshLanes();
  }
}

function initialRoute() {
  if (parseRoute(location.hash)) { applyRoute(); return; }
  let saved = null;
  try { saved = localStorage.getItem(ROUTE_KEY); } catch (_) { saved = null; }
  const r = saved && parseRoute('#' + saved) ? saved : '/today';
  history.replaceState(null, '', '#' + r);
  applyRoute();
}

// ── 顶栏的两个角标：今天 = 「需要你」条数，对话 = 未读数 ───────────────
let needCount = null;   // null = 还算不出来（agents 和 status 都还没回来）
function renderTabBadges() {
  const tn = $('tab-today-n'), cn = $('tab-chat-n');
  if (!tn || !cn) return;
  tn.hidden = !needCount;
  tn.textContent = needCount ? String(needCount) : '';
  tn.title = needCount ? `${needCount} 件需要你处理` : '';
  let u = 0;
  for (const n of unread.values()) u += n;
  cn.hidden = !u;
  cn.textContent = u ? String(u) : '';
  cn.title = u ? `${u} 条未读（这次打开页面之后推来的）` : '';
}

// ── 需要你 ─────────────────────────────────────────────────────────────
//
// 规则在 `Derive.needYou`（测得到）：① CRIT_LEVELS 里的 agent（**rate_limited 不算**）
// 排在 ② `isForHuman` 且没被「收起」的消息前面。
// ★ 「收起」记在 localStorage，按「频道 + 锚点」记（房间 = 房间流 stream id，
//   私聊 = job_id —— 私聊那侧的条目上没有 stream id，见 `anchorOf()`）。
// ⚠️ 没有条目时**同时**说清两个端点各自正不正常 —— 查不了不能画成没事。
const DISMISS_KEY = 'engloop:need-dismissed';
const DISMISS_MAX = 500;
let dismissed = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); }
  catch (_) { return new Set(); }
})();
function dismissNeed(key) {
  dismissed.add(key);
  const arr = [...dismissed].slice(-DISMISS_MAX);
  dismissed = new Set(arr);
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify(arr)); } catch (_) { /* 存不下：这次页面里仍然收起 */ }
  renderNeed();
}

const NEED_SHOW_MAX = 12;

/**
 * 这条是人类发的吗 —— 「需要你」用它判「人类已经回过了」。
 * ★ 先认 stamp 的章（`sender_type`，bus 从登录 session 盖的），没有章再认 whoami 的用户名。
 *   **不按名字写死**：换个人登录，判据跟着走。
 * ⚠️ 本地回显那条自己带 `sender_type: 'human'`（202 之后插进去的，见 send()）。
 */
function isHumanMsg(m) {
  if (!m) return false;
  if (m.sender_type) return m.sender_type === 'human';
  const me = window.EngLoopAuth && window.EngLoopAuth.me;
  return !!me && m.from === me;
}
let needQueued = false;
function scheduleNeed() {
  if (needQueued) return;
  needQueued = true;
  setTimeout(() => { needQueued = false; renderNeed(); }, 0);
}

function chLabel(chKey) {
  const i = chKey.indexOf(':');
  const kind = chKey.slice(0, i), id = chKey.slice(i + 1);
  if (kind === 'room') {
    const r = roomList.find((x) => x.hash === id);
    return '#' + (r ? r.name : id);
  }
  return '@' + id;
}

/**
 * 「跳过去」：打开那个频道、定位到那条消息。
 * ★ 在今天视图里点 ⇒ **在右侧抽屉里**打开（改 `current`，地址栏仍是 `#/today`，不切视图）；
 *   别的视图照旧切到对话视图。对话视图下次打开时停在同一个频道（tab 按 `current` 拼路由）。
 */
function jumpToMessage(chKey, id) {
  const i = chKey.indexOf(':');
  const kind = chKey.slice(0, i), cid = chKey.slice(i + 1);
  const room = kind === 'room' ? roomList.find((x) => x.hash === cid) : null;
  const ch = { kind, id: cid, name: room ? room.name : cid, members: room ? room.members || [] : [],
               count: room ? room.message_count : undefined };
  if (view === 'today') {
    setDrawer(true);
    if (keyOf(current) !== chKey) select(ch);
  } else if (view !== 'chat' || keyOf(current) !== chKey) {
    if (view !== 'chat') setRoute(chatRouteOf(ch));
    if (keyOf(current) !== chKey) select(ch);
  }
  // 历史可能还在路上 —— 找得到就滚过去，找不到不猜位置
  const tryScroll = (n) => {
    let node = null;
    try {
      node = document.querySelector(`#feed [data-mid="${CSS.escape(String(id))}"], #feed [data-seg="${CSS.escape(String(id))}"]`);
    } catch (_) { node = null; }
    if (node) {
      node.scrollIntoView({ block: 'center' });
      // 定位到了要看得出来是哪一条（尤其在 400px 的抽屉里）
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 1600);
      return;
    }
    if (n > 0) setTimeout(() => tryScroll(n - 1), 250);
  };
  tryScroll(8);
}

/** 打开一个频道：今天视图里开在抽屉里，别的视图切到对话视图（「私聊」按钮用它）。 */
function openChannel(ch) {
  if (view === 'today') { setDrawer(true); select(ch); return; }
  if (view !== 'chat') setRoute(chatRouteOf(ch));
  select(ch);
}

/**
 * 重画一个容器，**键盘焦点留在原来那个按钮上**。
 * ★ 「需要你」和「刚完成」每 5 秒跟着轮询重画一次（重画不能把状态冲掉）——
 *   用 Tab 走到某个按钮上的人，下一次重画会把焦点甩回 body。按 `data-fk` 找回同一个按钮。
 */
function rebuildKeepFocus(box, build) {
  const a = document.activeElement;
  const fk = a && box.contains(a) && a.dataset ? a.dataset.fk : null;
  box.replaceChildren();
  build(box);
  if (fk) {
    let n = null;
    try { n = box.querySelector(`[data-fk="${CSS.escape(fk)}"]`); } catch (_) { n = null; }
    if (n) n.focus({ preventScroll: true });
  }
}

/** 上一次「需要你」的计算结果 —— 右栏和今天视图**用同一次计算**。 */
let lastNeed = null;

function renderNeed() {
  const crit = CRIT_LEVELS;
  const statusState = statusSnap.kind === 'ok' ? 'ok' : statusSnap.kind === 'loading' ? 'unknown' : statusSnap.kind;
  // ⚠️ watchdog 瞎了时 ① 算不出来（三组全空不等于没人失联）⇒ 跟「查不了」同样处理
  const blind = !!(agentsSnap && agentsSnap.data && isBlind(agentsSnap.data));
  const r = Derive.needYou({
    agents: agentsSnap && agentsSnap.data ? agentsSnap.data : null,
    agentsError: agentsSnap && agentsSnap.error ? agentsSnap.error : (blind ? 'watchdog_blind' : null),
    statusState,
    feeds,
    dismissed,
    crit,
    now: Date.now(),
    isHuman: isHumanMsg,
    mergesOf: (chKey) => mergesByCh.get(chKey) || null,
  });
  const n = r.items.length;
  const agentsBad = r.health.agents !== 'ok';
  needCount = n;
  // ★ 滤掉了要说出来：时间窗外的、人类已经回过的各有几条
  const filt = `（另有 ${r.filtered.outOfWindow} 条超过 ${Math.round(Derive.NEED_WINDOW_MS / 3600000)} 小时、`
             + `${r.filtered.answered} 条你已经回过，不列）`;
  // ★ 只因为是完成报告而没收的 —— 它们在今天视图的「刚完成」里，
  //   **不是被藏起来**，所以不进「另有 N 条…」那行，只放进 title。
  const doneNote = r.filtered.done
    ? `\n另有 ${r.filtered.done} 条完成报告没列在这里 —— 完成报告只放在今天视图的「刚完成」里` : '';
  lastNeed = { r, n, blind, agentsBad, filt, doneNote };
  if ($('need-n')) {
    $('need-n').textContent = agentsBad ? `${n} + ?` : String(n);
    $('need-n').title = (agentsBad ? '/api/agents 查不了（或 watchdog 什么都没看见）—— 失联的 agent 现在数不出来\n' : '') + filt + doneNote;
    $('need-btn').title = $('need-n').title;
    $('need-btn-n').textContent = agentsBad ? `${n}+?` : String(n);
  }
  renderTabBadges();
  if ($('need')) renderNeedInto($('need'), lastNeed, 'narrow');
  renderToday();
  // 泳道跟着同一拍重画（消息到了 / 每 5 秒的 agents 轮询）—— 合并到下一个宏任务里画一次
  scheduleLanes();
}

/** 两个端点各自正不正常 —— 「没有条目」时必须一起给出去（查不了不能画成没事）。 */
function needHealth(r, blind) {
  const h = el('div', 'need-health');
  const part = (name, st) => el('span', st === 'ok' ? null : 'bad',
    `${name} ${st === 'ok' ? '正常' : st === '404' ? '端点 404' : st === 'unknown' ? '还没回来'
      : (name === '/api/agents' && blind) ? '回了，但 watchdog 什么都没看见' : '查不了'}`);
  h.appendChild(document.createTextNode('端点：'));
  h.appendChild(part('/api/agents', r.health.agents));
  h.appendChild(document.createTextNode(' · '));
  h.appendChild(part('/api/status', r.health.status));
  return h;
}

/**
 * 把「需要你」画进一个容器。**右栏（`narrow`）和今天视图（`wide`）用的是这同一个函数**：
 * 条目、按钮、「收起」完全一样，只换样式和说明的长短。
 * 在一处点「收起」⇒ `dismissNeed` ⇒ `renderNeed` 同一次计算重画两处 ⇒ 另一处立刻消失。
 */
function renderNeedInto(box, ctx, variant) {
  const { r, n, blind, agentsBad, filt } = ctx;
  const wide = variant === 'wide';
  rebuildKeepFocus(box, () => {
    if (!n) {
      // ⚠️ 查不了不能画成「没事」
      box.appendChild(el('div', 'empty need-empty', agentsBad
        ? '现在说不出有没有要你处理的事 —— 失联的 agent 查不了。'
        : '没有要你处理的事'));
      box.appendChild(needHealth(r, blind));
      // 今天视图里这行小字在区块标题旁边（renderTodayNeed），右栏里放在底下
      if (!wide && (r.filtered.outOfWindow || r.filtered.answered)) box.appendChild(el('div', 'need-more', filt));
      return;
    }
    if (agentsBad || r.health.status !== 'ok') box.appendChild(needHealth(r, blind));
    for (const it of r.items.slice(0, NEED_SHOW_MAX)) box.appendChild(needCard(it, variant));
    // ★ 截断了必须说 —— 一个静默截断的列表会让人以为那就是全部。
    if (n > NEED_SHOW_MAX) {
      box.appendChild(el('div', 'need-more', `还有 ${n - NEED_SHOW_MAX} 条没列出来（只列最新的 ${NEED_SHOW_MAX} 条）`));
    }
    if (!wide && (r.filtered.outOfWindow || r.filtered.answered)) box.appendChild(el('div', 'need-more', filt));
  });
}

const NEED_DESC_CHARS = 120;

/** 「需要你」的一张卡。`variant: 'wide'` 是今天视图的样子（多一行类别、说明写正文前 120 个字）。 */
function needCard(it, variant) {
  const wide = variant === 'wide';
  if (it.type === 'agent') {
    const a = it.agent;
    const s = STATUS[a.level] || UNMAPPED;
    const card = el('div', 'ni red' + (wide ? ' wide' : ''));
    card.appendChild(el('span', 'g', s.glyph));
    if (wide) card.appendChild(el('span', 'k', `${s.label} · ${ago(a.idle_ms)}`));
    card.appendChild(el('span', 'tt', wide ? `${a.name} ${s.label}` : `${a.name} ${s.label} · ${ago(a.idle_ms)}`));
    card.appendChild(el('span', 'dd', s.note || ''));
    const aa = el('span', 'aa');
    const b = attachBtn(a, 'pb red');
    if (b) { b.dataset.fk = `${it.key}|attach`; aa.appendChild(b); }
    const go = el('button', 'pb ghost', '私聊');
    go.type = 'button';
    go.dataset.fk = `${it.key}|dm`;
    go.onclick = () => openChannel({ kind: 'dm', id: a.name, name: a.name, members: [] });
    aa.appendChild(go);
    card.appendChild(aa);
    return card;
  }
  const m = it.msg;
  const done = it.reasons.includes('done');
  const card = el('div', 'ni' + (done ? ' done' : '') + (wide ? ' wide' : ''));
  // 标题只用信号本身（forHumanReasons 的类型 + 发言人），**不按文本猜「这是个问题」**
  const why = it.reasons.includes('expects_reply') ? ['?', `${m.from} 等你回复`, '等你回复']
    : it.reasons.includes('mention') ? ['@', `${m.from} 点名你`, '点名你']
      : done ? ['🏁', `${m.from} 标了完成`, '完成报告']
        : ['▸', `${m.from} · 流程事件`, '流程事件'];
  card.appendChild(el('span', 'g', why[0]));
  const text = String(m.text || '');
  if (wide) {
    card.appendChild(el('span', 'k', `${why[2]} · ${chLabel(it.chKey)} · ${clock(m.at)}`));
    card.appendChild(el('span', 'tt', why[1]));
    // 说明 = 消息正文的前 120 个字，**原文，不改写**（按字符切，不切半个字）
    const chars = Array.from(text);
    const dd = el('span', 'dd', chars.length > NEED_DESC_CHARS ? chars.slice(0, NEED_DESC_CHARS).join('') + '…' : text);
    dd.title = text;
    card.appendChild(dd);
  } else {
    card.appendChild(el('span', 'tt', why[1]));
    const one = text.split('\n').find((l) => l.trim()) || '';
    const dd = el('span', 'dd', `${chLabel(it.chKey)} · ${clock(m.at)} · ${one.length > 60 ? one.slice(0, 60) + '…' : one}`);
    dd.title = text;
    card.appendChild(dd);
  }
  const aa = el('span', 'aa');
  const go = el('button', 'pb', '跳过去');
  go.type = 'button';
  go.dataset.fk = `${it.key}|go`;
  go.title = variant === 'wide' ? '在右边的对话抽屉里打开这个频道，定位到这条' : '打开这个频道，定位到这条';
  go.onclick = () => jumpToMessage(it.chKey, m.id);
  const no = el('button', 'pb ghost', '收起');
  no.type = 'button';
  no.dataset.fk = `${it.key}|no`;
  no.title = '在这个浏览器里不再把它列进「需要你」（记在 localStorage，消息本身不受影响）';
  no.onclick = () => dismissNeed(it.key);
  aa.appendChild(go);
  aa.appendChild(no);
  card.appendChild(aa);
  return card;
}

// ══ 「今天」视图 ══════════════════════════════════
//
// ★ 一个新端点都不加、一次新 fetch 都不发：全部读顶栏和右栏已经在用的那几份快照 ——
//   `agentsSnap`（pollAgents）· `statusSnap`（pollStatus）· `queueByRecipient` / `queueError`（pollQueueItems）·
//   `healthSnap`（pollHealth）· `feeds` · `reactCache`。**顶栏读数和数字行共用同一份状态**，
//   各 fetch 各的话两处会对不上，而那种分叉不会让任何东西变红。
// ★ 唯一的新请求是「刚完成」那几条 pending 报告的反应 —— 走现有的 `/api/reactions/batch`
//   批量通道（`reactWanted` → `flushReactFetch`），不每条发一个。
// ★ 拼句子、判状态的都在 `web/derive.js`（测得到）；这里只管画。

/** 上次离开今天视图的时刻（摘要句的起点）。读写都包 try/catch —— 读不到就当第一次打开（今天 00:00）。 */
const SINCE_KEY = 'engloop:today-left-at';
let briefSinceSaved = (() => {
  try { return localStorage.getItem(SINCE_KEY); } catch (_) { return null; }
})();
function recordTodayLeave() {
  const t = String(Date.now());
  briefSinceSaved = t;
  try { localStorage.setItem(SINCE_KEY, t); } catch (_) { /* 存不下：这次页面里仍然按它算 */ }
}

/** 已经拉过历史的频道（「只数已加载的频道」那个 ⓘ 要用真的数）。拉失败的会被删掉。 */
const loadedCh = new Set();
function loadedCounts() {
  let rooms = 0, dms = 0;
  for (const k of loadedCh) { if (k.startsWith('room:')) rooms++; else dms++; }
  return { rooms, dms };
}

/** 「刚完成」点了「还有 N 条」之后全部展开 —— 存在内存里，5 秒重画冲不掉。 */
let doneExpanded = false;

function renderToday() {
  if (view !== 'today' || !$('view-today')) return;
  renderTodayHello();
  renderTodayNumbers();
  renderTodayNeed();
  renderTodayDone();
  renderTodayWip();
}

function renderTodayHello() {
  const now = new Date();
  $('today-date').textContent = Derive.dateLine(now);
  const me = window.EngLoopAuth && window.EngLoopAuth.me;
  $('today-hi').textContent = Derive.greeting(now, me || null);
  const L = lastNeed;
  const hl = Derive.helloLine({
    count: L ? L.n : 0,
    health: L ? L.r.health : { agents: 'unknown', status: 'unknown' },
    blind: !!(L && L.blind),
  });
  const line = $('today-line');
  line.replaceChildren();
  line.className = 'line' + (hl.kind === 'unknown' ? ' cant' : '');
  line.appendChild(document.createTextNode(hl.text));
  if (hl.kind === 'unknown') line.appendChild(el('span', 'cant-why', hl.detail));

  const s = Derive.briefSummary({
    now: now.getTime(),
    savedSince: briefSinceSaved,
    feeds,
    reactions: reactCache,
    reactionsFailed: reactFailed,
    mergesOf: (chKey) => mergesByCh.get(chKey) || null,
    loaded: loadedCounts(),
    status: statusSnap,
    agents: agentsSnap && agentsSnap.data ? agentsSnap.data : null,
    agentsError: agentsSnap && agentsSnap.error ? agentsSnap.error : null,
  });
  $('brief-since').textContent = s.line1;
  $('brief-info').title = s.info;
  $('brief-info').setAttribute('aria-label', s.info);
  $('brief-now').textContent = s.line2;
}

/** 数字行的一格。 */
function todayNum(label, value, { cls = '', title = '', small = null, smallCls = '' } = {}) {
  const n = el('div', 'num' + (cls ? ' ' + cls : ''));
  n.appendChild(el('span', null, label));
  const b = el('b', null, value);
  if (small != null) b.appendChild(el('small', smallCls || null, small));
  n.appendChild(b);
  if (title) n.title = title;
  return n;
}

function renderTodayNumbers() {
  const box = $('today-numbers');
  box.replaceChildren();
  // 在线 —— 跟顶栏「舰队」同一个值（同一份 agentsSnap、同一个 fleetCounts）
  {
    const a = agentsSnap;
    if (!a) box.appendChild(todayNum('在线', '—', { title: '/api/agents 还没回来' }));
    else if (a.error) box.appendChild(todayNum('在线', '?', { cls: 'bad', title: `/api/agents 查不了：${a.error}` }));
    else {
      const fc = Derive.fleetCounts(a.data);
      if (fc.blind) box.appendChild(todayNum('在线', '查不了', { cls: 'bad', title: 'watchdog 什么都没看见（sessions_seen 0）—— 「0/0」是一个看起来精确的假数' }));
      else box.appendChild(todayNum('在线', String(fc.online), { small: ` / ${fc.total}`, title: $('s-fleet-wrap').title }));
    }
  }
  // 今日 commit
  {
    const c = Derive.commitReading(statusSnap);
    box.appendChild(todayNum('今日 commit', c.text, {
      cls: c.state === 'ok' || c.state === 'loading' ? '' : c.state === '404' ? 'stale-data' : 'bad',
      title: $('s-commit-wrap').title }));
  }
  // 全量 —— 跟顶栏同一个 statusSnap、同一套写法
  {
    const t = Derive.testsReading(statusSnap);
    if (t.state === 'ok') {
      const bad = (t.failed || 0) > 0;
      box.appendChild(todayNum('全量', String(t.passed), {
        cls: t.stale ? 'stale-data' : '', small: ` · ${t.failed == null ? '?' : t.failed}`, smallCls: bad ? 'bad' : '',
        title: $('s-test-wrap').title }));
    } else {
      box.appendChild(todayNum('全量', t.text, {
        cls: t.state === 'loading' ? '' : t.state === 'error' ? 'bad' : 'stale-data', title: $('s-test-wrap').title }));
    }
  }
  // 队列 —— /api/queue/items，「排队 N · 在手 M」两个数都写，零也写；查不了写「?」
  {
    if (queueError) {
      box.appendChild(todayNum('队列', '?', { cls: 'bad',
        title: `队列条目查不出来 —— 这不是「没有积压」，是「我答不了这个问题」。\n${queueError}` }));
    } else if (!queueLoaded && agentsSnap && agentsSnap.error) {
      // 队列条目跟 /api/agents 一起拉（pollAgents 成功之后才拉）—— agents 查不了时它也没拉成
      box.appendChild(todayNum('队列', '?', { cls: 'bad',
        title: '队列条目是跟 /api/agents 一起拉的，/api/agents 查不了，这一次没拉成 —— 这不是「没有积压」' }));
    } else if (!queueLoaded) {
      box.appendChild(todayNum('队列', '—', { title: '/api/queue/items 还没回来' }));
    } else {
      let q = 0, f = 0;
      for (const g of queueByRecipient.values()) { q += Number(g.queued || 0); f += Number(g.in_flight || 0); }
      box.appendChild(todayNum('队列', `排队 ${q} · 在手 ${f}`, { cls: 'q2',
        title: '来自 /api/queue/items（跟舰队卡上的数同一份）。两个数分开写，不合成总数：\n'
             + '排队 = 还没投给它的 · 在手 = 已经投给它、还没确认处理完的' }));
    }
  }
  // bus —— pollHealth 测的往返（顶栏 #s-lat 的同一个值）
  {
    const h = healthSnap;
    const title = '浏览器到 bus 的 HTTP 往返时间（GET /health），不是 bus 内部的延迟';
    if (h.kind === 'ok') box.appendChild(todayNum('bus', String(h.ms), { small: ' ms', title }));
    else if (h.kind === 'redis_down') box.appendChild(todayNum('bus', 'redis down', { cls: 'bad', title: title + '\n/health 回了，但 redis 不通' }));
    else if (h.kind === 'down') box.appendChild(todayNum('bus', '断开', { cls: 'bad', title: title + '\n/health 没有响应' }));
    else box.appendChild(todayNum('bus', '—', { title }));
  }
}

function renderTodayNeed() {
  const L = lastNeed;
  const box = $('today-need');
  const c = $('today-need-n'), note = $('today-need-filtered');
  if (!L) { box.replaceChildren(el('div', 'empty', '读取中…')); c.textContent = '—'; note.textContent = ''; return; }
  c.textContent = L.agentsBad ? `${L.n}+?` : String(L.n);
  c.title = $('need-n') ? $('need-n').title : '';
  // ★ 滤掉了就要说出来：数字来自 needYou().filtered
  const f = L.r.filtered;
  note.textContent = (f.outOfWindow || f.answered)
    ? `另有 ${f.outOfWindow} 条已过 ${Math.round(Derive.NEED_WINDOW_MS / 3600000)} 小时 · ${f.answered} 条已回过` : '';
  note.title = (L.filt + L.doneNote).trim();
  renderNeedInto(box, L, 'wide');
}

function chanText(chKey) {
  return chKey.startsWith('room:') ? chLabel(chKey) : '私聊';
}

function renderTodayDone() {
  const box = $('today-done');
  const r = Derive.recentDone({
    feeds, reactions: reactCache, reactionsFailed: reactFailed, now: Date.now(),
    max: doneExpanded ? Infinity : Derive.DONE_MAX,
    mergesOf: (chKey) => mergesByCh.get(chKey) || null,
  });
  // pending 报告的反应：走现有的批量通道，一次取齐（不每条发一个请求）
  let want = false;
  for (const w of r.wanted) {
    const k = rKey(w.scope, w.anchor);
    if (reactCache.has(k) || reactInflight.has(k) || reactFailed.has(k)) continue;
    reactWanted.add(k);
    want = true;
  }
  if (want) scheduleReactFetch();

  const lc = loadedCounts();
  $('today-done-note').textContent = `24 小时内 · 只数已加载的 ${lc.rooms} 个房间、${lc.dms} 个私聊`;
  rebuildKeepFocus(box, () => {
    if (!r.rows.length) {
      box.appendChild(el('div', 'empty', '过去 24 小时里，已加载的频道没有完成报告。'));
      return;
    }
    for (const row of r.rows) {
      const b = el('button', 'dn');
      b.type = 'button';
      b.dataset.fk = 'done|' + row.key;
      b.title = '在右边的对话抽屉里打开，定位到这条';
      b.appendChild(el('span', 'ic', row.orphanVerdict ? (row.verify.state === 'pass' ? '✓' : '⚪') : '🏁'));
      const tt = el('span', 'tt', row.title);
      tt.appendChild(el('span', null, ` · ${row.from || '?'} · ${chanText(row.chKey)}`));
      if (row.chKey.startsWith('dm:')) tt.title = `私聊 @${row.chKey.slice(3)}`;
      b.appendChild(tt);
      b.appendChild(el('span', 'tm', row.at === null ? '时间未知' : clock(row.at)));
      const ev = el('span', 'ev');
      if (row.orphanVerdict) {
        const o = el('span', 'tag muted', '核验结论（原报告没加载）');
        o.title = '这条是核验结论跟帖，它指向的那份完成报告不在已加载的消息里 —— 单独列出来，不丢掉';
        ev.appendChild(o);
      }
      const v = el('span', 'tag' + (row.verify.cls ? ' ' + row.verify.cls : ''), row.verify.label);
      v.title = row.verify.title || '';
      ev.appendChild(v);
      if (row.replies) ev.appendChild(el('span', 'tag', `${row.replies} 条回复`));
      b.appendChild(ev);
      b.onclick = () => jumpToMessage(row.chKey, row.id);
      box.appendChild(b);
    }
    if (r.more) {
      const more = el('button', 'dn-more', `还有 ${r.more} 条`);
      more.type = 'button';
      more.dataset.fk = 'done|more';
      more.onclick = () => { doneExpanded = true; renderTodayDone(); };
      box.appendChild(more);
    }
  });
}

function renderTodayWip() {
  const box = $('today-wip');
  rebuildKeepFocus(box, () => {
    const a = agentsSnap;
    if (!a) { box.appendChild(el('div', 'empty', '读取中…')); return; }
    if (a.error) { box.appendChild(el('div', 'empty bad', `查不了 —— /api/agents 报错：${a.error}。这不是「没人在干活」。`)); return; }
    if (isBlind(a.data)) { box.appendChild(el('div', 'empty bad', '查不了 —— watchdog 什么都没看见；空白不代表没人在干活。')); return; }
    const rows = Derive.inProgress({
      agents: a.data,
      queueOf: (name) => queueByRecipient.get(name) || null,
      queueError: queueError || (queueLoaded ? null : '队列还没读回来'),
      now: Date.now(),
      statusTable: STATUS,
    }) || [];
    if (!rows.length) { box.appendChild(el('div', 'empty', '没有在线的 agent（失联的在上面「等你处理」里）')); return; }
    for (const row of rows) {
      const s = STATUS[row.level] || UNMAPPED;
      const wr = el('div', 'wr' + (row.level === 'rate_limited' ? ' limit' : ''));
      const who = el('span', 'who');
      const g = el('span', 'g ' + s.cls, s.glyph);
      g.setAttribute('aria-hidden', 'true');
      who.appendChild(g);
      who.appendChild(el('span', 'nm', row.name));
      who.title = `${row.name} · ${s.glyph} ${s.label}`;
      wr.appendChild(who);
      const mid = el('div', 'mid');
      const lab = el('div', 'lab' + (row.task.source === 'none' ? ' none' : ''), row.task.text);
      lab.title = row.task.source === 'declared' ? '进程申报的长任务（busy_what）'
        : row.task.source === 'inflight' ? '在手条目里最早一条的正文前 40 个字'
          : row.task.source === 'rate_limited' ? s.note : '没申报、手里也没有在手条目 —— 不拿最后一条消息顶替';
      mid.appendChild(lab);
      const qs = el('div', 'qs');
      for (const c of row.q.chips) { const ch = el('span', 'q-chip ' + c.cls, c.text); ch.title = c.title; qs.appendChild(ch); }
      mid.appendChild(qs);
      wr.appendChild(mid);
      const st = el('span', 'st ' + s.cls, row.right.text);
      st.title = row.right.title || '';
      wr.appendChild(st);
      box.appendChild(wr);
    }
  });
}

// ── 右侧对话抽屉 ─────────────────────────────────────────────────────────
//
// ★★ **同一套渲染，不准再写一套**：进今天视图时，把对话视图中间那一栏的
//   DOM 节点（`#feed` + `#composer`）**整个移进**抽屉；回到对话视图时再移回去。
//   ⇒ 草稿（textarea 的值）、「回复中」（`#replying` + `replyTarget`）、展开状态都跟着节点走，
//     不用同步两份；节点 id 也不会重复。renderFeed / jumpToMessage 照样按 `#feed` 找。
// ⚠️ 节点被移动（或被 display:none）时浏览器会把滚动位置归零 ⇒ 移之前按 `captureScroll` 记一个锚，
//   能看见之后按它放回去（跟 renderFeed 同一套 restoreScroll）。
// ⚠️ 收起状态存 localStorage（宽屏）。窄屏（< 900px）默认收起、打开时盖住全屏 —— 那时的开合只在内存里。
const DRAWER_KEY = 'engloop:today-drawer';
let drawerWideOpen = (() => {
  try { return localStorage.getItem(DRAWER_KEY) !== 'closed'; } catch (_) { return true; }
})();
let drawerNarrowOpen = false;
const narrowMQ = window.matchMedia ? window.matchMedia('(max-width: 899px)') : { matches: false };
let chatScrollMemo = null;

function drawerOpen() { return narrowMQ.matches ? drawerNarrowOpen : drawerWideOpen; }
function feedVisible() { const f = $('feed'); return !!f && f.getClientRects().length > 0; }

function setDrawer(open) {
  if (drawerOpen() === open) { applyDrawer(); return; }
  if (!open && feedVisible()) chatScrollMemo = captureScroll($('feed'));
  if (narrowMQ.matches) drawerNarrowOpen = open;
  else {
    drawerWideOpen = open;
    try { localStorage.setItem(DRAWER_KEY, open ? 'open' : 'closed'); } catch (_) { /* 存不下：这次页面里仍然生效 */ }
  }
  applyDrawer();
  if (open && view === 'today') restoreScroll($('feed'), chatScrollMemo);
}

function applyDrawer() {
  const open = drawerOpen();
  const v = $('view-today');
  v.classList.toggle('drawer-closed', !open);
  $('drawer-x').setAttribute('aria-expanded', String(open));
  $('drawer-open').setAttribute('aria-expanded', String(open));
}

/** 抽屉标题：当前频道名 + 成员（房间）或「私聊」。 */
function renderDrawerHead() {
  if (!$('drawer-name')) return;
  const isRoom = current.kind === 'room';
  $('drawer-hash').textContent = isRoom ? '#' : '@';
  $('drawer-name').textContent = current.name;
  $('drawer-sub').textContent = isRoom ? ((current.members || []).join('、') || '房间') : '私聊';
  $('drawer-open-name').textContent = (isRoom ? '#' : '@') + current.name;
}

/** 对话流 + composer 放在哪：今天视图 ⇒ 抽屉；其余 ⇒ 对话视图中间那一栏。 */
function placeChatColumn() {
  const feed = $('feed'), comp = $('composer');
  const host = view === 'today' ? $('drawer-body') : $('chat-main');
  if (!feed || !comp || !host || feed.parentElement === host) return;
  if (feedVisible()) chatScrollMemo = captureScroll(feed);
  host.appendChild(feed);
  host.appendChild(comp);
}

/**
 * 「需要你」要看得见**所有**频道里给人看的消息，不只是当前打开的那个。
 * ⇒ 启动时把最近的房间和在线 agent 的私聊历史各拉一次（之后靠 WS 推）。
 * ⚠️ 只拉一次、有上限：页面轮询的频率是别人机器上的负载。
 */
const PREFETCH_ROOMS = 6;
const PREFETCH_DMS = 8;
let prefetched = false;
function prefetchForNeed() {
  if (prefetched) return;
  if (!roomList.length && !agentNames.length) return;
  prefetched = true;
  const cutoff = Date.now() - ROOM_MAX_AGE_DAYS * 86400_000;
  const rooms = [...roomList].sort((a, b) => roomActiveAt(b) - roomActiveAt(a))
    .filter((r) => roomActiveAt(r) >= cutoff).slice(0, PREFETCH_ROOMS);
  for (const r of rooms) if (!feeds.has('room:' + r.hash)) loadRoomHistory(r.hash);
  for (const n of agentNames.slice(0, PREFETCH_DMS)) if (!feeds.has('dm:' + n)) loadDmHistory(n);
}

// ── ⌘K 跳转：只跳房间、私聊、agent —— **不搜消息**（没有那个后端）────────
function jumpOptions(q) {
  const s = q.trim().toLowerCase();
  const out = [];
  for (const r of roomList) out.push({ k: '房间', label: '#' + r.name, go: () => ({ kind: 'room', id: r.hash, name: r.name, members: r.members || [], count: r.message_count }) });
  const names = agentNames.includes(ORCH) ? agentNames : [ORCH, ...agentNames];
  for (const n of names) {
    const st = agentStatus.get(n);
    out.push({ k: '私聊', label: '@' + n + (st ? ` ${st.glyph} ${st.label}` : ''), go: () => ({ kind: 'dm', id: n, name: n, members: [] }) });
  }
  return s ? out.filter((o) => o.label.toLowerCase().includes(s)) : out;
}
let jumpSel = 0;
function renderJump() {
  const list = $('jump-list');
  const opts = jumpOptions($('jump').value).slice(0, 20);
  list.replaceChildren();
  if (!opts.length) list.appendChild(el('div', 'jump-empty', '没有匹配的房间或 agent（这里不搜消息内容）'));
  jumpSel = Math.min(jumpSel, Math.max(0, opts.length - 1));
  opts.forEach((o, i) => {
    const b = el('button', 'jump-opt');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', i === jumpSel ? 'true' : 'false');
    b.appendChild(el('span', 'k', o.k));
    b.appendChild(el('span', null, o.label));
    b.onmousedown = (ev) => { ev.preventDefault(); doJump(o); };
    list.appendChild(b);
  });
  list.hidden = false;
  $('jump').setAttribute('aria-expanded', 'true');
  return opts;
}
function closeJump() {
  $('jump-list').hidden = true;
  $('jump').setAttribute('aria-expanded', 'false');
}
function doJump(o) {
  const ch = o.go();
  closeJump();
  $('jump').value = '';
  $('jump').blur();
  if (view !== 'chat') setRoute(chatRouteOf(ch));
  select(ch);
}

// ── 窄屏：左栏 / 右栏的开合 ────────────────────────────────────────────
function closeOverlays() {
  for (const [pane, btn] of [['chan-nav', 'nav-btn'], ['live', 'need-btn']]) {
    $(pane).classList.remove('open');
    $(btn).setAttribute('aria-expanded', 'false');
  }
}
function toggleOverlay(pane, btn) {
  const open = !$(pane).classList.contains('open');
  closeOverlays();
  if (open) {
    if (view !== 'chat') setRoute(chatRouteOf(current), { replace: true });
    $(pane).classList.add('open');
    $(btn).setAttribute('aria-expanded', 'true');
  }
}

// ══ 「泳道」视图 ════════════════════════════════════
//
// 每个 agent 一列，按时间排出它收到的和发出的消息；底部一条命令条。
// ★ 拼什么、怎么去重、谁有列、命令条能发给谁 —— 都在 `web/derive.js`（测得到）；这里只管取数据和画。
// ★ 唯一的新请求是每一列的 `GET /api/messages?to=<名字>&count=100`：
//   · 泳道**看得见**时（视图是 lanes、页面可见）每 30 秒重拉一次 —— 页面轮询的频率是别人机器上的负载（prefetchForNeed）。
//   · WS 的私聊推送（`message`）不带 `to` ⇒ 派给 agent 的活**推不过来**，只能靠重拉；收到某个 agent 的推送就把它那一列防抖 3 秒重拉。
//   · 房间那部分直接从 `feeds` 里来（房间历史 + `room_message` 推送），不另拉。
// ⚠️ 某一列拉失败：**保留上次拿到的内容**，标上「这是 HH:MM 的内容」，不清空。
// ⚠️ 每 5 秒跟着轮询重画一次：日志区**只在内容变了时**重建 ——
//   失联那一列要能往回翻、能选中文字，每 5 秒重建一次 DOM 会把选区和滚动位置冲掉。
const LANE_COUNT = 100;
const LANE_REFRESH_MS = 30000;
const LANE_DEBOUNCE_MS = 3000;
/** name → `{ payload, rows, okAt, error, errorDetail, loading }`。`rows` 是最后一次**成功**拿到的。 */
const laneData = new Map();
let laneFetchedAt = 0;
const laneTimers = new Map();
/** 窄栏里点开成一列的（存 localStorage，读写包 try/catch）。 */
const LANES_OPEN_KEY = 'engloop:lanes-expanded';
let lanesExpanded = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(LANES_OPEN_KEY) || '[]')); } catch (_) { return new Set(); }
})();
/** 点了「展开」的长消息（按条目键）。只在内存里 —— 5 秒重画冲不掉，刷新页面才收回。 */
const laneUnfolded = new Set();
/** 焦点在哪一列（最后点过 / Tab 进过的那列）。命令条据此写「要给 dev 派活，发给 JARVIS」。 */
let laneFocus = null;
/** 窄屏时显示的那一列（tab）。 */
let laneSel = null;
/** name → 那一列的 DOM 和各部分的签名（签名没变就不重建）。 */
const laneDom = new Map();
const CMD_TARGET_KEY = 'engloop:cmd-target';
let cmdTargetKey = (() => { try { return localStorage.getItem(CMD_TARGET_KEY) || null; } catch (_) { return null; } })();
let cmdTargetsSig = '';
/** 窄栏小砖上「一个词的状态」。没在表里的用 STATUS 的 label。 */
const TILE_WORD = { rate_limited: '限额', stale: '已不在' };

function lanesVisible() { return view === 'lanes' && document.visibilityState === 'visible'; }

let lanesQueued = false;
function scheduleLanes() {
  if (lanesQueued) return;
  lanesQueued = true;
  setTimeout(() => { lanesQueued = false; renderLanes(); }, 0);
}

/** 当前的布局（`Derive.laneLayout`）。agents 还没回来 / 报错 / watchdog 看不见 ⇒ null。 */
function laneLayoutNow() {
  const a = agentsSnap;
  if (!a || a.error || !a.data || isBlind(a.data)) return null;
  return Derive.laneLayout(a.data, { orchName: ORCH });
}
/** 要画成一列的：所有列 + 窄栏里点开的 +（窄屏时）tab 选中的那个窄栏 agent。 */
function laneColumns(L) {
  const cols = L.lanes.slice();
  for (const r of L.dock) if (lanesExpanded.has(r.name) || (narrowMQ.matches && laneSel === r.name)) cols.push(r);
  return cols;
}

async function fetchLane(name) {
  const cur = laneData.get(name) || { payload: null, rows: null, okAt: null, error: null, errorDetail: null };
  cur.loading = true;
  laneData.set(name, cur);
  try {
    const r = await fetch(`/api/messages?to=${encodeURIComponent(name)}&count=${LANE_COUNT}`);
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.error) {
      // 列头那一行只写错误码（一列 320px 宽，放不下整段说明）；message / detail / next 原样进 title
      const e = new Error(d && d.error ? `${d.error}（HTTP ${r.status}）` : `HTTP ${r.status}`);
      // 后端的 `next` 是它对这个错误给的出口 —— 原样带进 title，不在前端另写一句
      e.detail = d ? [d.message, d.detail, d.next].filter(Boolean).join('\n') || errText(d, r.status) : (r.status === 404
        ? 'GET /api/messages 返回 404（不是后端给的那种）—— bus 还没加载新代码，或者这个端点不在。这不是「没有消息」。'
        : `HTTP ${r.status}`);
      throw e;
    }
    cur.payload = d;
    cur.rows = d.messages || d.history || [];
    cur.okAt = Date.now();
    cur.error = null;
    cur.errorDetail = null;
  } catch (e) {
    // ★ **不清空**上一次的 rows / payload —— 人要往回翻；只标上它是几点的
    cur.error = String(e.message || e);
    cur.errorDetail = e.detail || cur.error;
  }
  cur.loading = false;
  scheduleLanes();
}

/** 重拉所有列（只在泳道看得见时）。 */
function refreshLanes() {
  if (!lanesVisible()) return;
  const L = laneLayoutNow();
  if (!L) return;
  laneFetchedAt = Date.now();
  for (const r of laneColumns(L)) fetchLane(r.name);
}

/** 收到某个 agent 的私聊推送 ⇒ 它那一列防抖 3 秒重拉（只在泳道看得见时）。 */
function laneNudge(name) {
  if (!name || !lanesVisible()) return;
  clearTimeout(laneTimers.get(name));
  laneTimers.set(name, setTimeout(() => { laneTimers.delete(name); if (lanesVisible()) fetchLane(name); }, LANE_DEBOUNCE_MS));
}

function saveLanesExpanded() {
  try { localStorage.setItem(LANES_OPEN_KEY, JSON.stringify([...lanesExpanded])); } catch (_) { /* 存不下：这次页面里仍然展开 */ }
}
function toggleDockLane(name) {
  if (lanesExpanded.has(name)) lanesExpanded.delete(name); else lanesExpanded.add(name);
  saveLanesExpanded();
  renderLanes();
  if (lanesExpanded.has(name) && !laneData.has(name)) fetchLane(name);
}

/** 时间：今天的写 HH:MM，更早的带日期；判不出 ⇒「时间未知」（不藏）。 */
function laneTime(t) {
  if (t == null) return '时间未知';
  const d = new Date(t);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return clock(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${clock(t)}`;
}
function roomNameOf(hash) {
  const r = roomList.find((x) => x.hash === hash);
  return r ? r.name : hash;
}
/** `to: 'orchestrator'`（agent 发给编排者、人发给编排者都这么写）⇒ 编排者的名字。 */
function toName(to) { return to === 'orchestrator' ? ORCH : to; }

/** 一条正文：**只走 mdToHtml**（先 esc 再替换）。超过 6 行折起来，「展开」状态存内存、扛得住 5 秒重画。 */
function laneBody(e) {
  const wrap = document.createDocumentFragment();
  const tx = el('div', 'tx');
  // ★ innerHTML 在这里安全**只因为** mdToHtml 先 esc 后替换（renderMsg 那段同一条）
  tx.innerHTML = mdToHtml(e.text);
  wrap.appendChild(tx);
  if (Derive.laneFolds(e.text)) {
    const open = laneUnfolded.has(e.key);
    if (!open) tx.classList.add('fold');
    const n = e.text.split('\n').length;
    const b = el('button', 'unfold', open ? '收起' : `展开（共 ${n} 行）`);
    b.type = 'button';
    b.dataset.fk = 'unfold|' + e.key;
    b.setAttribute('aria-expanded', String(open));
    b.onclick = () => {
      if (laneUnfolded.has(e.key)) laneUnfolded.delete(e.key); else laneUnfolded.add(e.key);
      renderLanes();
    };
    wrap.appendChild(b);
  }
  return wrap;
}

function laneEntryEl(e, name) {
  if (e.kind === 'verdict') {
    // 核验结论跟帖：灰色系统行，不当成这个 agent 自己说的话
    const n = el('div', 'le sysl');
    n.dataset.seg = e.key;
    n.appendChild(el('span', 'ts', laneTime(e.t)));
    const s = el('span', 'v', `核验结论：${e.verdict.label}`);
    s.title = `${e.from || '?'} 那份完成报告的核验结论跟帖（sender_type: system，verify = ${e.msg.verify}）—— `
            + `这是 bus 发的，不是 ${e.from || '?'} 自己说的话`;
    n.appendChild(s);
    return n;
  }
  if (e.kind === 'disp') {
    // 派活行（只在编排者那一列）：时间 → 收件人  正文第一行
    const n = el('div', 'le disp');
    n.dataset.seg = e.key;
    n.appendChild(el('span', 'ts', laneTime(e.t)));
    n.appendChild(el('b', null, `→ ${e.to}`));
    const one = el('span', 'one');
    const first = e.text.split('\n').find((l) => l.trim()) || '';
    one.innerHTML = mdToHtml(first);
    one.title = `${ORCH} 派给 ${e.to} 的活（${e.stream || `agent:${e.to}:in`}）：\n${e.text}`;
    n.appendChild(one);
    return n;
  }
  const n = el('div', 'le ' + e.kind);
  n.dataset.seg = e.key;
  const ts = el('div', 'ts');
  if (e.kind === 'room') {
    // 房间发言：#房间名 · 时间，点一下跳到对话视图里那个频道
    const b = el('button', 'rlink', `#${roomNameOf(e.roomHash)} · ${laneTime(e.t)}`);
    b.type = 'button';
    b.dataset.fk = 'room|' + e.key;
    b.title = `在对话视图里打开 #${roomNameOf(e.roomHash)}，定位到这条`;
    b.onclick = () => jumpToMessage(e.chKey, e.id);
    ts.appendChild(b);
  } else if (e.kind === 'in') {
    ts.appendChild(el('b', null, e.from || '?'));
    ts.appendChild(document.createTextNode(` → ${name} · ${laneTime(e.t)}`));
    if (e.roomHash) ts.appendChild(document.createTextNode(` · #${roomNameOf(e.roomHash)}`));
  } else {
    ts.appendChild(document.createTextNode(laneTime(e.t)));
    if (e.to) ts.appendChild(document.createTextNode(` → ${toName(e.to)}`));
    if (e.roomHash) ts.appendChild(document.createTextNode(` · #${roomNameOf(e.roomHash)}`));
  }
  if (e.stream) ts.title = `来自 ${e.stream}${e.msg.direction ? `（${e.msg.direction}）` : ''}`;
  else if (e.src === 'local') ts.title = '这次页面里推来的 / 本地回显（还没被重拉覆盖）';
  n.appendChild(ts);
  n.appendChild(laneBody(e));
  if (e.done) {
    // 🏁 + 标签：**只看 verify 字段**，不取反应（pending ⇒「已提交核验」）
    const d = el('span', 'ldone' + (e.done.cls ? ' ' + e.done.cls : ''), `🏁 ${e.done.label}`);
    d.title = e.done.title || '';
    n.appendChild(d);
  }
  return n;
}

/** 列头。每次重画都重建（idle_ms 每 5 秒在变）；焦点留在原来的按钮上。 */
function laneHeadFill(h, row, cov, dockRow) {
  const a = row.agent;
  const s = STATUS[row.level] || UNMAPPED;
  rebuildKeepFocus(h, () => {
    const r1 = el('div', 'r1');
    r1.appendChild(el('span', 'nm', row.name));
    const st = el('span', 'st ' + s.cls);
    st.appendChild(el('span', 'glyph', s.glyph));
    st.appendChild(document.createTextNode(' ' + s.label));
    st.title = `${s.glyph} ${s.label}${s.note ? '\n' + s.note : ''}`;
    r1.appendChild(st);
    if (row.orch) r1.appendChild(el('span', 'role', '编排者'));
    const info = el('button', 'info', 'ⓘ');
    info.type = 'button';
    info.dataset.fk = 'info|' + row.name;
    info.title = cov;
    info.setAttribute('aria-label', `${row.name} 这一列的覆盖范围：${cov}`);
    r1.appendChild(info);
    if (dockRow) {
      const x = el('button', 'pb ghost lx', '收回');
      x.type = 'button';
      x.dataset.fk = 'collapse|' + row.name;
      x.title = '收回窄栏';
      x.onclick = () => toggleDockLane(row.name);
      r1.appendChild(x);
    }
    h.appendChild(r1);

    // 跟舰队卡同一个字段、同一种写法：「队列 N 没读」；「排队 N · 在手 M」两个数（Derive.queueChips）；心跳曲线复用 sparkEl
    const meta = el('div', 'meta');
    const idle = el('span', 'idle', `队列 ${ago(a.idle_ms)} 没读`);
    idle.title = `idle_ms · 心跳 ${ago(a.since_heartbeat_ms)} · outbox ${ago(a.outbox_idle_ms)}`
               + (a.tmux_session ? ` · 会话 ${a.tmux_session}` : '');
    meta.appendChild(idle);
    const lqi = queueByRecipient.get(row.name) || null;
    const chips = el('span', 'q-chips');
    for (const c of Derive.queueChips(lqi, queueError).chips) {
      const ch = el('span', 'q-chip ' + c.cls, c.text);
      ch.title = c.title;
      chips.appendChild(ch);
    }
    meta.appendChild(chips);
    meta.appendChild(sparkEl(row.name, s.cls));
    h.appendChild(meta);

    // 当前任务（Derive.currentTask，经 wipRow）+ 右边那格（派出 N 分钟 / 申报中 / 空闲）—— 跟今天视图「进行中」同一个函数
    const w = Derive.wipRow({ agent: a, level: row.level, qi: lqi,
      queueError: queueError || (queueLoaded ? null : '队列还没读回来'), now: Date.now(), statusTable: STATUS });
    const now = el('div', 'now' + (w.task.source === 'none' ? ' none' : ''));
    const t = el('span', 't', w.task.text);
    t.title = w.task.source === 'declared' ? `当前任务（进程申报的长任务）：${w.task.text}`
      : w.task.source === 'inflight' ? `当前任务（在手条目里最早的一条，前 ${Derive.TASK_CHARS} 个字）：${w.task.text}`
        : w.task.source === 'rate_limited' ? (s.note || '')
          : '没有申报的长任务，手里也没有已投未完的条目 —— 不拿最后一条消息冒充当前任务';
    now.appendChild(t);
    const rt = el('span', 'r', w.right.text);
    rt.title = w.right.title || '';
    now.appendChild(rt);
    h.appendChild(now);
  });
}

/** 失联那一列底部的救援面板。按钮只在会话名变了时重建（「✓ 已复制」不会被 5 秒重画冲掉）。 */
function laneRescueFill(dom, row) {
  const a = row.agent;
  const s = STATUS[row.level] || UNMAPPED;
  let box = dom.rescue;
  if (!box) {
    box = el('div', 'rescue');
    box.setAttribute('role', 'group');
    box.appendChild(el('div', 'h'));
    box.appendChild(el('p'));
    box.appendChild(el('div', 'a'));
    dom.root.appendChild(box);
    dom.rescue = box;
    dom.rescueTmux = undefined;
  }
  box.setAttribute('aria-label', `${row.name} 失联 —— 救援`);
  // 写法跟舰队卡一样：「ago(idle_ms) 没读队列」；正文是 STATUS 表里那句 note，不另写
  box.children[0].textContent = `${s.glyph} ${ago(a.idle_ms)} 没读队列`;
  box.children[1].textContent = s.note || '';
  if (dom.rescueTmux !== (a.tmux_session || null)) {
    dom.rescueTmux = a.tmux_session || null;
    const acts = box.children[2];
    acts.replaceChildren();
    const b = attachBtn(a, 'pb red');          // 没有 tmux_session ⇒ null，不显示
    if (b) acts.appendChild(b);
    const go = el('button', 'pb ghost', `私聊 ${ORCH}`);
    go.type = 'button';
    go.title = `打开跟 ${ORCH} 的私聊 —— 要不要救、怎么救，让编排者去做`;
    go.onclick = () => openChannel({ kind: 'dm', id: ORCH, name: ORCH, members: [] });
    acts.appendChild(go);
  }
}

function laneDomFor(name) {
  let dom = laneDom.get(name);
  if (dom) return dom;
  const root = el('section', 'lane');
  root.dataset.lane = name;
  root.setAttribute('aria-label', `${name} 泳道`);
  const head = el('div', 'lh');
  const err = el('div', 'lane-err');
  err.hidden = true;
  const log = el('div', 'log');
  log.tabIndex = 0;
  log.setAttribute('aria-label', `${name} 的消息`);
  root.append(head, err, log);
  dom = { root, head, err, log, rescue: null, logSig: null, stick: true };
  log.addEventListener('scroll', () => { dom.stick = isNearBottom(log); }, { passive: true });
  laneDom.set(name, dom);
  return dom;
}

function renderLane(row, dockRow) {
  const name = row.name;
  const dom = laneDomFor(name);
  const s = STATUS[row.level] || UNMAPPED;
  dom.root.className = 'lane ' + s.cls + (row.lost ? ' lost' : '') + (dockRow ? ' docked' : '')
    + (laneFocus === name ? ' focus' : '') + (laneSel === name ? ' sel' : '');
  const data = laneData.get(name) || null;
  const isOrch = name === ORCH;

  // ③ 编排者那一列：并进已经取过的 agent 收件流（只取 rows —— 拉失败的那列保留的旧 rows 也算，ⓘ 里照实写）
  const orchExtra = [];
  if (isOrch) for (const [n, d] of laneData) if (n !== ORCH && d.rows) orchExtra.push([n, d.rows]);
  const res = Derive.laneEntries({
    name, orchName: ORCH,
    dm: data && data.rows ? data.rows : [],
    roomFeeds: [...feeds].filter(([k]) => k.startsWith('room:')),
    orchExtra,
    local: (feeds.get('dm:' + name) || []).filter((m) => m && !m.sys && !m.stream),
  });
  const cov = Derive.laneCoverage({ name, orchName: ORCH, payload: data && data.payload,
    error: data && data.error, rooms: loadedCounts().rooms, merged: isOrch ? res.merged : null });
  laneHeadFill(dom.head, row, cov, dockRow);

  // 拉失败：写「查不了」，**保留上次的内容**并标上是几点的
  if (data && data.error) {
    dom.err.hidden = false;
    dom.err.textContent = `查不了：${data.error}`
      + (data.okAt ? ` · 下面是 ${clock(data.okAt)} 的内容` : ' · 这一列的私聊历史一次都没拿到过（下面只有房间里的发言）');
    dom.err.title = `GET /api/messages?to=${name}：${data.error}\n${data.errorDetail || ''}\n\n这不是「没有消息」—— 是查不了。` + (data.okAt ? `下面是 ${clock(data.okAt)} 拿到的内容，没有清空。` : '');
  } else {
    dom.err.hidden = true;
    dom.err.textContent = '';
  }

  const ents = res.entries;
  const empty = !ents.length
    ? (!data || (data.loading && !data.okAt) ? 'loading' : data.error && !data.okAt ? 'cant' : 'none') : '';
  const sig = empty + '#' + ents.map((e) => e.key + (e.done ? ':' + e.done.state : '')
    + (laneUnfolded.has(e.key) ? '+' : '') + (e.kind === 'room' ? ':' + roomNameOf(e.roomHash) : '')).join('|');
  if (sig !== dom.logSig) {
    const log = dom.log;
    const visible = log.clientHeight > 0;
    const prev = visible && !dom.stick ? captureScroll(log) : null;
    const a = document.activeElement;
    const fk = a && log.contains(a) && a.dataset ? a.dataset.fk : null;
    log.replaceChildren();
    if (!ents.length) {
      log.appendChild(el('div', 'empty', empty === 'loading' ? '读取中…'
        : empty === 'cant' ? '查不了 —— 见上面那行。这不是「没有消息」。'
          : '这一列没有消息（覆盖范围见列头的 ⓘ）'));
    }
    for (const e of ents) log.appendChild(laneEntryEl(e, name));
    dom.logSig = sig;
    if (dom.stick || !prev) log.scrollTop = log.scrollHeight;
    else restoreScroll(log, prev);
    if (fk) {
      let n = null;
      try { n = log.querySelector(`[data-fk="${CSS.escape(fk)}"]`); } catch (_) { n = null; }
      if (n) n.focus({ preventScroll: true });
    }
  }

  if (row.lost) laneRescueFill(dom, row);
  else if (dom.rescue) { dom.rescue.remove(); dom.rescue = null; }
  return dom;
}

function renderLanes() {
  if (view !== 'lanes' || !$('view-lanes')) return;
  renderCmdBar();
  const cant = $('lanes-cant'), body = $('lanes-body'), tabs = $('lanes-tabs');
  const a = agentsSnap;
  if (!a || a.error || !a.data || isBlind(a.data)) {
    // ⚠️ agents 报错或者 watchdog 看不见：**不画列，画一块「查不了」**（跟今天视图「进行中」同一种写法）。不准画成空白。
    body.hidden = true;
    tabs.replaceChildren();
    cant.hidden = false;
    cant.replaceChildren(el('div', 'box' + (a ? ' bad' : ''), !a ? '读取中…'
      : a.error ? `查不了 —— /api/agents 报错：${a.error}。这不是「没有 agent」，泳道画不出来。`
        : '查不了 —— watchdog 什么都没看见（sessions_seen 0）；空白不代表没有 agent。'));
    return;
  }
  cant.hidden = true;
  body.hidden = false;
  const L = Derive.laneLayout(a.data, { orchName: ORCH });
  const all = [...L.lanes, ...L.dock];
  if (!laneSel || !all.some((r) => r.name === laneSel)) laneSel = L.lanes.length ? L.lanes[0].name : (L.dock[0] || {}).name || null;
  if (narrowMQ.matches) laneFocus = laneSel;
  const cols = laneColumns(L);
  const dockNames = new Set(L.dock.map((r) => r.name));

  // 列：按顺序放好（只在顺序变了时挪 —— 挪节点会丢滚动位置）
  const box = $('lanes');
  const want = cols.map((r) => renderLane(r, dockNames.has(r.name)).root);
  const have = [...box.children];
  if (want.length !== have.length || want.some((n, i) => n !== have[i])) box.replaceChildren(...want);
  for (const [n, d] of laneDom) if (!cols.some((r) => r.name === n)) { d.root.remove(); laneDom.delete(n); }
  if (!cols.length) box.replaceChildren(el('div', 'empty lanes-none', '没有 agent 在线'));

  // 没拉过的列（新出现的、刚点开的）补拉一次
  if (lanesVisible()) for (const r of cols) if (!laneData.has(r.name)) fetchLane(r.name);

  // 右侧窄栏：撞限额的 + 会话已不在的。点一下展开成一列，再点收回
  rebuildKeepFocus($('lanes-dock'), (dock) => {
    dock.appendChild(el('span', 'lbl', '收起'));
    if (!L.dock.length) { dock.appendChild(el('span', 'lbl none', '—')); return; }
    for (const r of L.dock) {
      const s = STATUS[r.level] || UNMAPPED;
      const open = lanesExpanded.has(r.name);
      const t = el('button', 'tile ' + s.cls);
      t.type = 'button';
      t.dataset.fk = 'tile|' + r.name;
      t.dataset.agent = r.name;
      t.setAttribute('aria-pressed', String(open));
      t.appendChild(el('b', null, r.name));
      const g = el('span', 'tg', s.glyph);
      g.setAttribute('aria-hidden', 'true');
      t.appendChild(g);
      t.appendChild(el('small', null, TILE_WORD[r.level] || s.label));
      t.title = `${r.name} · ${s.glyph} ${s.label}${s.note ? '\n' + s.note : ''}\n点一下${open ? '收回' : '展开成一列'}`;
      t.onclick = () => toggleDockLane(r.name);
      dock.appendChild(t);
    }
  });

  // 窄屏的 tab：名字 + STATUS 符号；窄栏里的放最后，「收起的」一组
  rebuildKeepFocus(tabs, (tb) => {
    const tab = (r) => {
      const s = STATUS[r.level] || UNMAPPED;
      const b = el('button', 'ltab ' + s.cls);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(laneSel === r.name));
      b.dataset.fk = 'ltab|' + r.name;
      b.appendChild(el('span', 'tg', s.glyph));
      b.appendChild(document.createTextNode(' ' + r.name));
      b.title = `${r.name} · ${s.glyph} ${s.label}`;
      b.onclick = () => {
        laneSel = r.name;
        laneFocus = r.name;
        renderLanes();
        const d = laneDom.get(r.name);
        if (d && d.stick) d.log.scrollTop = d.log.scrollHeight;
      };
      return b;
    };
    for (const r of L.lanes) tb.appendChild(tab(r));
    if (L.dock.length) {
      tb.appendChild(el('span', 'ltab-grp', '收起的'));
      for (const r of L.dock) tb.appendChild(tab(r));
    }
  });
}

// ── 命令条 ───────────────────────────────────────────────────────────────
//
// ★ 目标只有两类：**编排者，或者某个房间** —— `Derive.cmdTargets` 不收 agent 列表。
// ★ 发送走 `sendTo`（跟 composer 同一份），只发顶层消息，不带 reply_to。
// ★ Tab 不截：目标是一个真的 `<select>`，Tab 走得到；输入框里 Alt+↑ / Alt+↓ 换目标。
function cmdRooms() {
  const cutoff = Date.now() - ROOM_MAX_AGE_DAYS * 86400_000;
  return [...roomList].sort((a, b) => roomActiveAt(b) - roomActiveAt(a)).filter((r) => roomActiveAt(r) >= cutoff);
}
function cmdTargetList() {
  return Derive.cmdTargets({ orchName: ORCH, rooms: cmdRooms() });
}
function cmdTarget() {
  const list = cmdTargetList();
  return list.find((t) => keyOf(t) === cmdTargetKey) || list[0];
}
function setCmdTarget(key) {
  cmdTargetKey = key;
  try { localStorage.setItem(CMD_TARGET_KEY, key); } catch (_) { /* 存不下：这次页面里仍然生效 */ }
  renderCmdBar();
}

function renderCmdBar() {
  const sel = $('cmd-target');
  if (!sel) return;
  const list = cmdTargetList();
  const sig = list.map((t) => keyOf(t) + '=' + t.label).join('|');
  if (sig !== cmdTargetsSig) {
    // 只在目标表变了时重建 <select>（5 秒重画不能把展开着的下拉冲掉）
    cmdTargetsSig = sig;
    sel.replaceChildren();
    for (const t of list) {
      const o = document.createElement('option');
      o.value = keyOf(t);
      o.textContent = t.label;
      sel.appendChild(o);
    }
  }
  const t = cmdTarget();
  if (sel.value !== keyOf(t)) sel.value = keyOf(t);
  const isRoom = t.kind === 'room';
  // 收件人提示紧挨着输入框，样式跟 composer 的 #to 一样
  const to = $('cmd-to');
  to.textContent = isRoom ? `发到 #${t.name}` : `发到 @${t.name}（私聊）`;
  to.className = 'to ' + (isRoom ? 'to-room' : 'to-dm');
  to.title = isRoom ? '这条会进房间流，房间成员和所有打开页面的人都看得到'
    : `这条只有 ${t.name} 看得到，不会出现在任何房间里`;
  // 焦点在某个 agent 的列上：目标**不换**，旁边写一行灰字
  const hint = Derive.cmdFocusHint({ focus: laneFocus, orchName: ORCH });
  const hn = $('cmd-hint');
  hn.hidden = !hint;
  hn.textContent = hint || '';
  hn.title = hint ? `人只能对编排者说话：POST /api/message 一律进 ${ORCH} 的收件流，没有「直接发给 agent」的接口。正文原样发出去，不会自动加 @${laneFocus}。` : '';
}

function cmdStatus(text, cls, action) {
  const s = $('cmd-status');
  s.replaceChildren();
  s.className = 'cmd-status' + (cls ? ' ' + cls : '');
  if (!text) return;
  s.appendChild(document.createTextNode(text));
  if (action) {
    const b = el('button', 'cmd-go', action.label);
    b.type = 'button';
    b.onclick = action.run;
    s.appendChild(b);
  }
}

async function cmdSend() {
  const box = $('cmd-input');
  const text = box.value.trim();
  if (!text) return;
  const t = cmdTarget();
  // ★★ 双保险：目标表里本来就没有 agent；万一有，这里也不发（发出去会进编排者的收件流，界面却写着发给 agent）
  if (t.kind !== 'room' && t.id !== ORCH) {
    cmdStatus(`✗ 没发：命令条只能发给 ${ORCH} 或房间 —— 给 ${t.id} 派活要通过 ${ORCH}`, 'bad');
    return;
  }
  box.value = '';
  box.style.height = 'auto';
  cmdStatus('发送中…');
  // 命令条只发顶层消息，不带 reply_to；人写的话原样发出去（不加 @ 前缀）
  const r = await sendTo(t, text, { box });
  const label = t.kind === 'room' ? `#${t.name}` : `@${t.name}`;
  if (!r.ok) {
    cmdStatus(`✗ 没发出去：${r.error}。消息没进队列，没有人收到它。你的字还在输入框里，再按一次发送就行。`, 'bad');
    return;
  }
  const chKey = keyOf(t);
  cmdStatus(`✓ 已发到 ${label} · ${clock(Date.now())}`, 'ok', t.kind === 'room'
    ? { label: `在对话视图里看 #${t.name}`, run: () => jumpToMessage(chKey, r.id) }
    : null);
  if (t.kind === 'dm') laneNudge(t.id);     // 本地回显已经在那一列里了；3 秒后重拉一次换成流里的那条
  scheduleLanes();
}

// ── 主题 ───────────────────────────────────────────────────────
// 三层：:root 亮 → 媒体查询跟随系统 → data-theme 手动压过系统。
// ⚠️ localStorage 读写包 try/catch（隐私模式会抛）—— 读不到就跟随系统。
let saved = null;
try { saved = localStorage.getItem('engloop-theme'); } catch (_) { saved = null; }
if (saved) document.documentElement.setAttribute('data-theme', saved);
$('theme').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const sysDark = matchMedia('(prefers-color-scheme:dark)').matches;
  const next = cur ? (cur === 'dark' ? 'light' : 'dark') : (sysDark ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('engloop-theme', next); } catch (_) { /* 存不下：这次页面里仍然生效 */ }
};

// ── 启动 ───────────────────────────────────────────────────────
$('send').onclick = send;
$('doc-close').onclick = closeDoc;
$('files-close').onclick = closeFiles;
$('files-btn').onclick = () => ($('filepane').hidden ? openFiles() : closeFiles());
$('notify-btn').onclick = askNotify;
$('files-q').oninput = (e) => { filesQuery = e.target.value; renderFiles(); };
// ★ 面板开着的时候跟着刷 —— 「生成中 → 已就绪」这个变化是它的主要用途,
//   而那个变化只有重新扫目录才看得到。
//   ⚠️ 只在开着时刷:关着还刷等于给一个没人看的面板打接口。
setInterval(() => { if (!$('filepane').hidden) loadFiles(); }, 5000);
// 事件委托：消息是动态渲染的，逐个绑监听器会随重渲染泄漏。
$('feed').addEventListener('click', (ev) => {
  const a = ev.target.closest('a.doclink');
  if (!a) return;
  ev.preventDefault();
  // 文档面板住在对话视图里 —— 从今天视图的抽屉点进来就先切过去，不然点了没反应
  if (view !== 'chat') setRoute(chatRouteOf(current));
  openDoc(a.dataset.doc);
});
// ★ 舰队带每 5 秒重画一次，高度可能变（多一行 note、多一张卡）—— 对话流的**框**跟着变矮，
//   而浏览器保持 scrollTop 不动 ⇒ 原来贴着底的人，最新那几条被挤到视口下面。
//   ⇒ 记住「人是不是贴着底」（只在 scroll 事件里更新），框变了尺寸时贴着底的就留在底部。
//   不贴底（在读历史）就不动 —— 跟 restoreScroll 的规矩一致。
let feedStuck = true;
$('feed').addEventListener('scroll', () => { feedStuck = isNearBottom($('feed')); }, { passive: true });
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    const f = $('feed');
    if (feedStuck && f) f.scrollTop = f.scrollHeight;
  }).observe($('feed'));
}
$('agents').addEventListener('mouseover', anchorQPop);
$('agents').addEventListener('focusin', anchorQPop);
$('agents').addEventListener('scroll', () => { qPopAnchor = null; }, { passive: true });
$('new-room').onclick = () => toggleRoomForm();
$('room-cancel').onclick = () => toggleRoomForm(false);
$('room-form').addEventListener('submit', createRoom);
// Ctrl/⌘ + Enter 发送，单独 Enter 换行。
// ★ 这个页面上的消息经常是多段的（派活、复盘、规格），**换行比发送常用** ——
//   而「按 Enter 就发出去」会让人写到一半被迫发出，然后补一条「接上面」。
//   ⌘ 一并认：macOS 上手会自己去按它，不认的话人会以为发送坏了。
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
});
$('input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 180) + 'px';
});

// ── 外壳的接线 ──────────────────────────────────────────
const VIEWS = ['today', 'chat', 'lanes'];
for (const v of VIEWS) {
  $('tab-' + v).onclick = () => setRoute(v === 'chat' ? chatRouteOf(current) : '/' + v);
}
// tablist 的键盘：左右方向键在三个视图之间走（ARIA tabs 的约定）
$('tab-today').parentElement.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const i = VIEWS.indexOf(view);
  const next = VIEWS[(i + (e.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
  e.preventDefault();
  $('tab-' + next).click();
  $('tab-' + next).focus();
});
window.addEventListener('hashchange', applyRoute);
$('nav-btn').onclick = () => toggleOverlay('chan-nav', 'nav-btn');
$('need-btn').onclick = () => {
  // 今天视图里「等你处理」就在这一页 —— 滚过去，不把人带去对话视图
  if (view === 'today') { $('today-need-sec').scrollIntoView({ block: 'start' }); return; }
  toggleOverlay('live', 'need-btn');
};
// 窄屏左栏里点了频道就收起（select() 里会 closeOverlays）
$('jump').addEventListener('focus', () => { jumpSel = 0; renderJump(); });
$('jump').addEventListener('input', () => { jumpSel = 0; renderJump(); });
$('jump').addEventListener('blur', () => setTimeout(closeJump, 120));
$('jump').addEventListener('keydown', (e) => {
  const opts = jumpOptions($('jump').value).slice(0, 20);
  if (e.key === 'ArrowDown') { e.preventDefault(); jumpSel = Math.min(jumpSel + 1, opts.length - 1); renderJump(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); jumpSel = Math.max(jumpSel - 1, 0); renderJump(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (opts[jumpSel]) doJump(opts[jumpSel]); }
  else if (e.key === 'Escape') { e.preventDefault(); closeJump(); $('jump').blur(); }
});
document.addEventListener('keydown', (e) => {
  // ⌘K / Ctrl+K：聚焦跳转框
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    $('jump').focus();
    $('jump').select();
  } else if (e.key === 'Escape') {
    closeOverlays();
  }
});

// ── 今天视图的接线 ───────────────────────────────────────────────
$('drawer-x').onclick = () => setDrawer(false);
$('drawer-open').onclick = () => setDrawer(true);
if (narrowMQ.addEventListener) narrowMQ.addEventListener('change', applyDrawer);
// 「离开」的另两种：页面被切走 / 关掉 —— 只在**当时在今天视图上**时才记
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && routed && view === 'today') recordTodayLeave();
});
window.addEventListener('pagehide', () => { if (routed && view === 'today') recordTodayLeave(); });
// 日期行每分钟更新一次（5 秒的轮询也会顺带重画；这一条保证轮询停了时钟也不停）
setInterval(() => renderToday(), 60000);
// whoami 回来了才知道问候里写谁
if (window.EngLoopAuth && window.EngLoopAuth.ready) window.EngLoopAuth.ready.then(() => renderToday());

// ── 泳道的接线 ───────────────────────────────────────────────────
// 泳道看得见时每 30 秒重拉一次各列（看不见就不拉）
setInterval(() => { if (lanesVisible()) refreshLanes(); }, LANE_REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (lanesVisible() && Date.now() - laneFetchedAt >= LANE_REFRESH_MS) refreshLanes();
});
if (narrowMQ.addEventListener) narrowMQ.addEventListener('change', scheduleLanes);
// 焦点在哪一列：点过或者 Tab 进过的那一列（命令条据此写灰字提示；目标不换）
const markLaneFocus = (ev) => {
  const lane = ev.target && ev.target.closest && ev.target.closest('.lane');
  if (!lane || laneFocus === lane.dataset.lane) return;
  laneFocus = lane.dataset.lane;
  for (const n of $('lanes').querySelectorAll('.lane')) n.classList.toggle('focus', n.dataset.lane === laneFocus);
  renderCmdBar();
};
$('lanes').addEventListener('focusin', markLaneFocus);
$('lanes').addEventListener('pointerdown', markLaneFocus);
$('cmd-send').onclick = cmdSend;
$('cmd-target').addEventListener('change', (e) => setCmdTarget(e.target.value));
$('cmd-input').addEventListener('keydown', (e) => {
  // Ctrl/⌘ + Enter 发送，Enter 换行（跟 composer 一样）
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cmdSend(); return; }
  // Alt+↑ / Alt+↓ 换目标。⚠️ **不截 Tab**：截了键盘用户就出不去这个输入框
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const list = cmdTargetList();
    const i = Math.max(0, list.findIndex((t) => keyOf(t) === keyOf(cmdTarget())));
    const next = list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length];
    setCmdTarget(keyOf(next));
  }
});
$('cmd-input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 160) + 'px';
});
// Alt+1…9：跳到第 N 列（只在焦点**不在**输入框里时认；⌘1–⌘9 是浏览器切标签页的，拦不住，不做）
document.addEventListener('keydown', (e) => {
  if (view !== 'lanes' || !e.altKey || e.metaKey || e.ctrlKey || !/^Digit[1-9]$/.test(e.code || '')) return;
  const tg = e.target && e.target.tagName;
  if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT') return;
  const lanes = [...$('lanes').querySelectorAll('.lane')];
  const n = lanes[Number(e.code.slice(5)) - 1];
  if (!n) return;
  e.preventDefault();
  if (narrowMQ.matches) { laneSel = n.dataset.lane; renderLanes(); }
  n.querySelector('.log').focus();
});

renderBar();
renderFeed();
// ★ 只**渲染**状态，不请求权限 —— 请求必须等用户点按钮。
//   理由写在 index.html 那个按钮头上：自动请求会被 Chrome 判成 denied，
//   而 denied 之后页面自己再也要不回来。
renderNotifyBtn();
loadDmHistory(current.id);
initialRoute();
renderLivePanels();
renderNeed();
const firstAgents = pollAgents(); setInterval(pollAgents, 5000);
const firstRooms = pollRooms();  setInterval(pollRooms, 15000);
// 「需要你」要看得见别的频道：第一轮 agents 和 rooms 都回来之后，各拉一次最近的历史
Promise.allSettled([firstAgents, firstRooms]).then(prefetchForNeed);
pollHealth(); setInterval(pollHealth, 10000);
// 测试结果和 commit 变得慢，而且 /api/status 要 shell 出去跑 git —— 别跟着
// 5 秒那档刷。**页面轮询的频率是别人机器上的负载**，不是免费的。
pollStatus(); setInterval(pollStatus, 30000);
connect();
