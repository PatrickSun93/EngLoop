'use strict';

/**
 * `web/derive.js` —— 控制台的纯逻辑。
 *
 * 守的是那几条「错了不报错、只会画出一个看起来合理的界面」的判据：
 *   · 排队和在手分开：「0 / 6」和「5 / 1」画出来不一样
 *   · `rate_limited` 不进「需要你」
 *   · 不满足 `isForHuman` 的消息不进「需要你」
 *   · 当前任务不拿最后一条消息顶替
 *   · 心跳缓冲不超过 36 个点，不到 3 个点给「采样中」
 *
 * ── ★★ 每条断言都配一个让它变红的变异 ──────────────────────────────
 *   一条在实现被改坏之后**仍然绿**的断言，跟没有断言唯一的区别是它让人放心。
 *   ⇒ 下面每个用例（`CASES`）都至少被一个变异（`MUTATIONS`）杀死：
 *     变异 = 对 `web/derive.js`（或 `web/app.js`）源码做一处**字面替换**，
 *     在内存里加载改过的版本，跑它点名要杀的用例 —— **必须变红**。
 *   ⚠️ 变异只在内存里做，磁盘上的文件一个字不动。
 *   ⚠️ 变异的 `from` 串在源码里必须**恰好出现一次** —— 出现 0 次说明源码改了而变异没跟上，
 *     那时它「杀不死」任何东西却也不会报错，所以这里把它当失败。
 *
 * ★ 「摘要句里每个数字都来自输入」：BS1（用 normal 夹具对一遍，
 *   再改几个数对一遍）。其余用例：BS* 摘要句 · RD* 刚完成 · IP* 进行中。
 * ★ 泳道视图：LN* 一列的内容（三处拼接 / 去重 / 排序 / 派活只并 JARVIS 的 / 核验跟帖 / pending 标签）·
 *   LO* 谁有列、谁进窄栏 · CT* 命令条的目标里没有 agent · ST1 sendTo 只有一份 · MD1 正文只走 mdToHtml · LS1 拉失败不清空。
 *   CT2 / ST1 / MD1 / LS1 是 app.js 的源码断言（弱证据，行为在 test/web-lanes.playwright.js 里另验）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DERIVE_SRC = fs.readFileSync(path.join(ROOT, 'web', 'derive.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
// CSS 剥掉注释再断言 —— 注释里提到「省略号」不该让断言假红
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'web', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const Threads = require('../web/threads.js');
const THREADS_SRC = fs.readFileSync(path.join(ROOT, 'web', 'threads.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

/** 在内存里加载一份 threads.js 源码（UMD 的 module 分支）—— `file: 'threads'` 的变异用。 */
function loadThreads(src) {
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', src)(mod, mod.exports, require);
  return mod.exports;
}

/**
 * 在内存里加载一份 derive.js 源码（UMD 的 module 分支）。
 * ★ `atMs` 住在 threads.js ⇒ 时间解析的变异要改 threads.js 的源码，
 *   所以这里能换一个 Threads 进去（默认是磁盘上那份）。
 */
function loadDerive(src, T = Threads) {
  const mod = { exports: {} };
  const req = (p) => (p === './threads.js' ? T : require(p));
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', src)(mod, mod.exports, req);
  return mod.exports;
}

/** app.js 里 CRIT_LEVELS 的字面值 —— **从源码读**，不在测试里抄一份（抄的那份验的是抄件）。 */
function critFrom(appSrc) {
  const m = /const CRIT_LEVELS = new Set\((\[[^\]]*\])\)/.exec(appSrc);
  if (!m) return null;
  return new Set(JSON.parse(m[1].replace(/'/g, '"')));
}

// ── 用例用的输入 ──────────────────────────────────────────────────────
const agent = (name, level, extra = {}) => ({ name, level, type: 'dev', idle_ms: 1000, tmux_session: `engloop_${name}`, ...extra });
const texts = (r) => r.chips.map((c) => c.text);
const HOUR = 3600_000;
const NOW = 1_800_000_000_000;
const NOAG = { deaf: [], live: [], stale: [] };
const ids = (r) => r.items.map((i) => (i.msg ? i.msg.id : i.key)).join(',');
/** 人类判据：认 stamp 的章（跟 app.js 的 isHumanMsg 同一个思路，不看名字） */
const HUMAN_STAMP = (m) => m.sender_type === 'human';
const ORCH_OUT = require('./fixtures/synthetic/orch-out-sample.json').messages;
/** 真数据量级：同一份快照，三个「现在」。 */
function magnitude(D) {
  const last = Math.max(...ORCH_OUT.map((m) => m.at));
  const feeds = new Map([['dm:JARVIS', ORCH_OUT]]);
  const run = (extra) => D.needYou({ agents: NOAG, feeds, ...extra }).items.length;
  const withHuman = new Map([['dm:JARVIS', [...ORCH_OUT,
    { id: 'h', from: 'someone', sender_type: 'human', text: '收到', at: last + 1000 }]]]);
  return {
    base: run({ now: last, windowMs: Infinity }),
    atLast: run({ now: last }),
    later13h: run({ now: last + 13 * HOUR }),
    later36h: run({ now: last + 36 * HOUR }),
    // 只因为 done 而没收的条数（完成报告只放「刚完成」）
    doneSkipped: D.needYou({ agents: NOAG, feeds, now: last }).filtered.done,
    answered: D.needYou({ agents: NOAG, feeds: withHuman, now: last + 2000, isHuman: HUMAN_STAMP }).items.length,
  };
}
const MAG = magnitude(require('../web/derive.js'));

// ── 「今天」视图用的输入 ──────────────────────────────────────────────────────────
const MIN = 60_000;
/** 「刚完成」的报告 / 核验跟帖 / 反应 */
const rep = (id, extra = {}) => ({ id, from: 'dev', text: '完成 ' + id, done: 'true', at: NOW - 60 * MIN, sender_type: 'agent', ...extra });
const fol = (id, to, verify = 'pass', extra = {}) => ({ id, from: 'dev', text: '✅ 独立核验通过', done: 'true', verify,
  reply_to: to, sender_type: 'system', kind: 'notice', at: NOW - 50 * MIN, ...extra });
const rx = (emoji, at) => ({ emoji, count: 1, users: [{ by: 'system', at }] });

/**
 * 夹具 normal → 页面会拿到的那几份输入（形状照 app.js 的 loadRoomHistory / loadDmHistory：
 * 房间 id = stream id、at = timestamp（ISO）；私聊 id = job_id）。
 * 时间按 `scripts/web-preview.js` 的 resolveTimes 换算 —— 跟预览服务器回响应时同一个函数。
 * `tweak` 改几个数，证明输出跟着输入走（不是写死的）。
 */
const FX_DIR = path.join(ROOT, 'test', 'fixtures', 'web-preview', 'normal');
const { resolveTimes } = require('../scripts/web-preview.js');
/** 固定在某天 23:00（本地）—— 「今天 00:00」那个起点就盖得住夹具里 3 小时内的全部消息 */
const FX_NOW = () => new Date(2026, 9, 14, 23, 0, 0).getTime();
function fixtureInputs(now, tweak = {}) {
  const rd = (rel) => resolveTimes(JSON.parse(fs.readFileSync(path.join(FX_DIR, rel), 'utf8')), now);
  const feeds = [];
  for (const r of rd('rooms.json').rooms) {
    const rel = `rooms/${r.hash}.json`;
    if (!fs.existsSync(path.join(FX_DIR, rel))) continue;
    feeds.push(['room:' + r.hash, rd(rel).messages.map((m) => ({ id: m.id, from: m.from, text: m.text, at: m.timestamp,
      reply_to: m.reply_to, kind: m.kind, done: Threads.isDone(m) || undefined, sender_type: m.sender_type, verify: m.verify }))]);
  }
  for (const f of fs.readdirSync(path.join(FX_DIR, 'messages')).sort()) {
    const d = rd('messages/' + f);
    feeds.push(['dm:' + d.name, d.messages.map((m) => ({ id: m.job_id, from: m.from, text: m.text, at: m.timestamp,
      reply_to: m.reply_to, kind: m.kind, done: Threads.isDone(m) || undefined, sender_type: m.sender_type, verify: m.verify }))]);
  }
  const rmap = new Map();
  const rj = rd('reactions.json');
  for (const scope of Object.keys(rj)) for (const [a, list] of Object.entries(rj[scope])) rmap.set(`${scope}:${a}`, list);
  const status = { kind: 'ok', d: rd('status.json') };
  const agents = rd('agents.json');
  if (tweak.passed) status.d.tests.passed += tweak.passed;
  if (tweak.failed) status.d.tests.failed += tweak.failed;
  for (let i = 0; i < (tweak.deaf || 0); i++) agents.deaf.push({ ...agents.deaf[0], name: 'deaf' + i });
  // batch 端点对没有反应的锚点不回那个 key ⇒ 页面记成 []（app.js flushReactFetch 同一个做法）
  return { feeds, reactions: (k) => rmap.get(k) || [], status, agents,
           loaded: { rooms: feeds.filter(([k]) => k.startsWith('room:')).length, dms: feeds.filter(([k]) => k.startsWith('dm:')).length } };
}
/** 输出里允许出现的数：全量的过 / 红、按 level 数的 agent 个数（直接从夹具 tally）、报告条数。 */
function allowedNumbers(inp, s) {
  const out = new Set([inp.status.d.tests.passed, inp.status.d.tests.failed,
    s.counts.reports, s.counts.verified, s.counts.orphanVerdicts].map(String));
  const tally = new Map();
  for (const [g, fb] of [['deaf', 'deaf'], ['rate_limited', 'rate_limited'], ['live', 'ok'], ['stale', 'stale']]) {
    for (const a of inp.agents[g] || []) {
      const lv = a.level || fb;
      if (lv !== 'ok' && lv !== 'busy') tally.set(lv, (tally.get(lv) || 0) + 1);
    }
  }
  for (const n of tally.values()) out.add(String(n));
  return out;
}
const numbersIn = (t) => String(t).match(/\d+/g) || [];

const CASES = [
  // ── 队列：两个数 ──
  { id: 'Q1', label: '★★★ 排队和在手分开：「排队 0 · 在手 6」和「排队 5 · 在手 1」画出来**不一样**（总数都是 6）',
    run: ({ D }) => JSON.stringify(texts(D.queueChips({ queued: 0, in_flight: 6 })))
                 !== JSON.stringify(texts(D.queueChips({ queued: 5, in_flight: 1 }))) },
  { id: 'Q2', label: '★★ 两格各说各的数：0/6 → 「排队 0」「在手 6」（零也画）',
    run: ({ D }) => JSON.stringify(texts(D.queueChips({ queued: 0, in_flight: 6 }))) === JSON.stringify(['排队 0', '在手 6']) },
  { id: 'Q3', label: '★★ 5/1 → 「排队 5」「在手 1」，**没有**哪一格写着总数 6',
    run: ({ D }) => { const t = texts(D.queueChips({ queued: 5, in_flight: 1 })); return t[0] === '排队 5' && t[1] === '在手 1' && !t.some((x) => /\b6\b/.test(x)); } },
  { id: 'Q4', label: '★★ 队列查不了 ⇒「队列 ?」，**不是**「排队 0 · 在手 0」（查不了 ≠ 没有）',
    run: ({ D }) => { const r = D.queueChips({ queued: 0, in_flight: 0 }, 'HTTP 503'); return r.unknown === true && texts(r).join() === '队列 ?'; } },

  // ── 需要你 ──
  { id: 'N1', label: '★★★ `rate_limited` 不进「需要你」—— 即使调用方传进来的 crit 里有它',
    run: ({ D }) => {
      const r = D.needYou({
        agents: { deaf: [agent('dev3', 'deaf')], rate_limited: [agent('dev2', 'rate_limited')],
                  live: [agent('dev4', 'rate_limited')], stale: [] },
        crit: new Set(['deaf', 'rate_limited']),
      });
      return r.items.some((i) => i.agent && i.agent.name === 'dev3')
          && !r.items.some((i) => i.level === 'rate_limited');
    } },
  { id: 'N2', label: '★★★ app.js 的 CRIT_LEVELS 里**没有** rate_limited，而 deaf / alert 在（从源码读）',
    run: ({ app }) => { const c = critFrom(app); return !!c && !c.has('rate_limited') && c.has('deaf') && c.has('alert'); } },
  { id: 'N3', label: '★★★ 不满足 isForHuman 的消息不进「需要你」（含 expects_reply / done 是字符串 \'false\' 的那种）',
    run: ({ D }) => {
      const feeds = new Map([['room:r1', [
        { id: 'a', from: 'dev', text: '普通的过程讨论', at: 1 },
        { id: 'b', from: 'dev', text: '看起来像问题吗？', at: 2, expects_reply: 'false' },
        { id: 'c', from: 'dev', text: '还没完', at: 3, done: 'false' },
        // 只带 done 的不进「需要你」 ⇒ 正例用 done + @Patrick
        { id: 'd', from: 'dev', text: '跑完了 @Patrick', at: 4, done: 'true' },
      ]]]);
      const r = D.needYou({ agents: { deaf: [], live: [], stale: [] }, feeds, now: 10 });
      return r.items.length === 1 && r.items[0].msg.id === 'd';
    } },
  { id: 'N4', label: '★★ 三种信号各自都进得来：【流程】 / expects_reply=\'true\' / @Patrick；**只带 done=\'true\' 的不进**（完成报告只放「刚完成」）',
    run: ({ D }) => {
      const feeds = new Map([['dm:JARVIS', [
        { id: '1', from: 'JARVIS', text: '【流程】@dev 请开始', at: 1 },
        { id: '2', from: 'senior', text: '要不要包含 Linux', at: 2, expects_reply: 'true' },
        { id: '3', from: 'dev', text: '完成', at: 3, done: 'true' },
        { id: '4', from: 'JARVIS', text: '@Patrick 看一下', at: 4 },
      ]]]);
      const r = D.needYou({ agents: { deaf: [], live: [], stale: [] }, feeds, now: 10 });
      return r.items.length === 3 && !r.items.some((i) => i.msg.id === '3') && r.filtered.done === 1;
    } },
  { id: 'N5', label: '★★ ①（失联的 agent）排在 ②（给人看的消息）前面',
    run: ({ D }) => {
      const feeds = new Map([['dm:JARVIS', [{ id: 'x', from: 'dev', text: '@Patrick', at: Date.now() }]]]);
      const r = D.needYou({ agents: { deaf: [agent('dev3', 'deaf')], live: [], stale: [] }, feeds, crit: new Set(['deaf']) });
      return r.items.length === 2 && r.items[0].type === 'agent' && r.items[1].type === 'message';
    } },
  { id: 'N6', label: '★★ 点过「收起」的那条不再出现（按 频道|锚点 记）',
    run: ({ D }) => {
      const m = { id: 'x', from: 'dev', text: '@Patrick', at: 1 };
      const feeds = new Map([['dm:dev', [m]]]);
      const r = D.needYou({ agents: { deaf: [], live: [], stale: [] }, feeds, now: 10, dismissed: new Set([D.dismissKey('dm:dev', m)]) });
      // 阴性对照：不收起时它在 —— 否则「0 条」可能是被别的规则滤掉的
      const r0 = D.needYou({ agents: { deaf: [], live: [], stale: [] }, feeds, now: 10 });
      return r.items.length === 0 && r0.items.length === 1;
    } },
  { id: 'N7', label: '★★★ 没条目时**不等于没事**：/api/agents 查不了 ⇒ health.agents = error（调用方据此写「查不了」）',
    run: ({ D }) => { const r = D.needYou({ agents: null, agentsError: 'HTTP 500', statusState: '404' }); return r.items.length === 0 && r.health.agents === 'error' && r.health.status === '404'; } },

  // ── 删掉 `if (isHuman(m)) continue;` 必须有用例变红 —— 就是这一条 ──
  { id: 'N8', label: '★★★ 人自己发的消息不进「需要你」—— 即使它带 @Patrick、expects_reply=\'true\'（isForHuman 为真）',
    run: ({ D }) => {
      const mine = { id: 'h1', from: 'Patrick', sender_type: 'human', at: NOW - 1000,
                     text: '@Patrick 提醒自己：明天看报告', expects_reply: 'true' };
      const feeds = new Map([['room:r', [mine]], ['dm:JARVIS', [{ ...mine, id: 'h2' }]]]);
      const r = D.needYou({ agents: NOAG, feeds, now: NOW, isHuman: HUMAN_STAMP });
      // 前置：它确实满足 isForHuman（否则「不进」可能是被 isForHuman 挡的，这条就什么都没证明）
      const pre = D.isForHuman(mine);
      // 阴性对照：同一条换成 agent 发 ⇒ 进（两个频道各一条）
      const asAgent = (m) => ({ ...m, from: 'senior', sender_type: 'agent' });
      const r0 = D.needYou({ agents: NOAG, now: NOW, isHuman: HUMAN_STAMP,
        feeds: new Map([['room:r', [asAgent(mine)]], ['dm:JARVIS', [asAgent({ ...mine, id: 'h2' })]]]) });
      return pre && r.items.length === 0 && r0.items.length === 2;
    } },

  // ── 时间窗 + 人类已经回过 ──
  { id: 'R1', label: '★★★ 时间窗（at 是数字毫秒）：25 小时前的等你回复不进，23 小时前的进',
    run: ({ D }) => {
      const now = 1_800_000_000_000;
      const feeds = new Map([['dm:JARVIS', [
        { id: 'old', from: 'dev', text: '要不要合？', expects_reply: 'true', at: now - 25 * HOUR },
        { id: 'new', from: 'dev', text: '要不要合？', expects_reply: 'true', at: now - 23 * HOUR },
      ]]]);
      const r = D.needYou({ agents: NOAG, feeds, now });
      return ids(r) === 'new' && r.filtered.outOfWindow === 1;
    } },
  { id: 'R2', label: '★★★ 时间窗（at 是 ISO 字符串）：同样 25h 不进、23h 进 —— 房间历史进 feed 时 at 就是这种',
    run: ({ D }) => {
      const now = Date.parse('2026-10-13T12:00:00Z');
      const feeds = new Map([['room:r', [
        { id: 'old', from: 'dev', text: '要不要合？', expects_reply: 'true', at: new Date(now - 25 * HOUR).toISOString() },
        { id: 'new', from: 'dev', text: '要不要合？', expects_reply: 'true', at: new Date(now - 23 * HOUR).toISOString() },
      ]]]);
      return ids(D.needYou({ agents: NOAG, feeds, now })) === 'new';
    } },
  { id: 'R3', label: '★★★ 私聊：人类在这条**之后**说过话 ⇒ 不进',
    run: ({ D }) => {
      const feeds = new Map([['dm:JARVIS', [
        { id: 'q', from: 'JARVIS', text: '@Patrick 要不要重启？', at: NOW - 3000 },
        { id: 'h', from: 'Patrick', sender_type: 'human', text: '先别动', at: NOW - 1000 },
      ]]]);
      const r = D.needYou({ agents: NOAG, feeds, now: NOW, isHuman: HUMAN_STAMP });
      return r.items.length === 0 && r.filtered.answered === 1;
    } },
  { id: 'R4', label: '★★ 私聊：人类的话在这条**之前** ⇒ 还进（回过 ≠ 说过话）',
    run: ({ D }) => {
      const feeds = new Map([['dm:JARVIS', [
        { id: 'h', from: 'Patrick', sender_type: 'human', text: '查一下', at: NOW - 3000 },
        { id: 'q', from: 'JARVIS', text: '@Patrick 查完了，要不要重启？', at: NOW - 1000 },
      ]]]);
      return ids(D.needYou({ agents: NOAG, feeds, now: NOW, isHuman: HUMAN_STAMP })) === 'q';
    } },
  { id: 'R5', label: '★★★ 房间：人类在**同一个线程**里回过（reply_to 指向线程根）⇒ 不进',
    run: ({ D }) => {
      const feeds = new Map([['room:r', [
        { id: 'root', from: 'JARVIS', text: '【流程】@dev 请开始', at: NOW - 5000, kind: 'notice' },
        { id: 'd', from: 'dev', text: '跑完了', done: 'true', reply_to: 'root', at: NOW - 4000 },
        { id: 'h', from: 'Patrick', sender_type: 'human', text: '好', reply_to: 'root', at: NOW - 1000 },
      ]]]);
      // 线程根那条【流程】本身也在同一个线程里 ⇒ 也算回过
      return D.needYou({ agents: NOAG, feeds, now: NOW, isHuman: HUMAN_STAMP }).items.length === 0;
    } },
  { id: 'R6', label: '★★ 房间：人类回的是**别的线程** ⇒ 还进',
    run: ({ D }) => {
      const feeds = new Map([['room:r', [
        { id: 'root', from: 'JARVIS', text: '普通话题', at: NOW - 5000, kind: 'notice' },
        { id: 'd', from: 'dev', text: '跑完了 @Patrick', done: 'true', reply_to: 'root', at: NOW - 4000 },
        { id: 'other', from: 'senior', text: '另一件事', at: NOW - 3000, kind: 'notice' },
        { id: 'h', from: 'Patrick', sender_type: 'human', text: '好', reply_to: 'other', at: NOW - 1000 },
      ]]]);
      return ids(D.needYou({ agents: NOAG, feeds, now: NOW, isHuman: HUMAN_STAMP })) === 'd';
    } },
  { id: 'R7', label: '★★ 「人类」由调用方的判据决定，**不按名字写死**：署名 alice 但盖了 human 章的回复也算',
    run: ({ D }) => {
      const feeds = new Map([['dm:JARVIS', [
        { id: 'q', from: 'JARVIS', text: '@Patrick 要不要重启？', at: NOW - 3000 },
        { id: 'h', from: 'alice', sender_type: 'human', text: '先别动', at: NOW - 1000 },
      ]]]);
      return D.needYou({ agents: NOAG, feeds, now: NOW, isHuman: HUMAN_STAMP }).items.length === 0;
    } },
  { id: 'R8', label: '★★★ 失联 agent 不受时间窗影响（now 推到一年后仍在）',
    run: ({ D }) => {
      const r = D.needYou({ agents: { deaf: [agent('dev3', 'deaf')], live: [], stale: [] },
        crit: new Set(['deaf']), now: Date.now() + 365 * 24 * HOUR });
      return r.items.length === 1 && r.items[0].type === 'agent';
    } },
  { id: 'R9', label: `★★ 量级（合成样本 synthetic/orch-out-sample.json —— 结构取自一份 48h 真实快照，${ORCH_OUT.length} 条，进「需要你」的 ${MAG.base} 条）：「现在」= 最后一条 ⇒ ${MAG.atLast} 条；`
      + `13 小时后再打开 ⇒ ${MAG.later13h} 条；人类在最后一条之后说过话 ⇒ ${MAG.answered} 条`
      + `；只因为是完成报告而没收的 ${MAG.doneSkipped} 条；36 小时后 ⇒ ${MAG.later36h} 条`
      + '（只带 done 的完成报告只放「刚完成」，不进「需要你」）',
    run: ({ D }) => {
      const m = magnitude(D);
      return m.base === 1 && m.atLast === 1 && m.later13h === 1 && m.later36h === 0 && m.answered === 0 && m.doneSkipped === 15;
    } },

  // ── 舰队卡名字不许省略号 ──
  { id: 'C1', label: '★★ .ag-name 不用省略号（text-overflow 不是 ellipsis），太长就折行',
    run: ({ css }) => { const r = /\.ag-name\{([^}]*)\}/.exec(css); return !!r && !/text-overflow:\s*ellipsis/.test(r[1]) && /white-space:\s*normal/.test(r[1]); } },
  { id: 'C2', label: '★★ 卡片最小宽度 176px，放不下时舰队带（.cards）自己横向滚',
    run: ({ css }) => /\.ag\{[^}]*min-width:176px/.test(css) && /\.cards\{[^}]*overflow-x:auto/.test(css) },
  { id: 'W4', label: '★★ 「需要你」的标题和角标用的是**过滤之后**的条数',
    run: ({ app }) => /const n = r\.items\.length;/.test(app) && /needCount = n;/.test(app) },
  { id: 'W5', label: '★★ app.js 的 isHumanMsg 认章（sender_type）和 whoami，**不写死名字**',
    run: ({ app }) => { const f = /function isHumanMsg\(m\) \{([\s\S]*?)\n\}/.exec(app); return !!f && /sender_type/.test(f[1]) && /EngLoopAuth/.test(f[1]) && !/Patrick/.test(f[1]); } },

  // ── 当前任务 ──
  { id: 'T1', label: '★★★ 当前任务**不拿最后一条消息顶替**：没申报、手里没条目 ⇒「—」，即使给了消息列表',
    run: ({ D }) => {
      const r = D.currentTask(agent('dev', 'ok'), { items: [] }, [{ from: 'dev', text: '好的，收到' }]);
      return r.text === '—' && r.source === 'none';
    } },
  { id: 'T2', label: '★★ ① 申报了长任务 ⇒ busy_what（压过在手条目）',
    run: ({ D }) => {
      const r = D.currentTask(agent('dev', 'ok', { declared_busy: true, busy_what: 'test/run-all.js' }),
        { items: [{ id: '1-0', state: 'in_flight', text: '别的' }] });
      return r.text === 'test/run-all.js' && r.source === 'declared';
    } },
  { id: 'T3', label: '★★ ② 否则取**在手**条目里**最早**的一条（排队的不算，晚到的不算）',
    run: ({ D }) => {
      const r = D.currentTask(agent('dev', 'ok', { declared_busy: false }), { items: [
        { id: '1700000000000-0', state: 'queued', text: '排队的最早那条' },
        { id: '1700000005000-0', state: 'in_flight', text: '在手但晚的' },
        { id: '1700000002000-0', state: 'in_flight', text: '在手且最早' },
      ] });
      return r.text === '在手且最早' && r.source === 'inflight';
    } },
  { id: 'T4', label: '★ 正文前 40 个字，超出加省略号（按字符切，中文不切半个）',
    run: ({ D }) => {
      const long = '字'.repeat(50);
      const r = D.currentTask(agent('dev', 'ok'), { items: [{ id: '1-0', state: 'in_flight', text: long }] });
      return Array.from(r.text).length === 41 && r.text.endsWith('…') && D.TASK_CHARS === 40;
    } },

  // ── 心跳缓冲 ──
  { id: 'H1', label: '★★★ 心跳缓冲不超过 36 个点（推 50 个之后剩 36 个，留下的是最新的）',
    run: ({ D }) => {
      const hb = D.createHeartbeat();
      for (let i = 0; i < 50; i++) hb.push('dev', i * 1000, i);
      const p = hb.points('dev');
      return D.HEARTBEAT_MAX === 36 && p.length === 36 && p[p.length - 1].idle_ms === 49000 && p[0].idle_ms === 14000;
    } },
  { id: 'H2', label: '★★★ 不到 3 个点 ⇒「采样中」，不画线',
    run: ({ D }) => {
      const hb = D.createHeartbeat();
      hb.push('dev', 1000, 1); hb.push('dev', 2000, 2);
      const st = hb.state('dev');
      return st.sampling === true && st.label === '采样中' && D.sparkline(hb.points('dev')) === null;
    } },
  { id: 'H3', label: '★★ 满 3 个点就画（阴性对照：上一条不是「永远采样中」）',
    run: ({ D }) => {
      const hb = D.createHeartbeat();
      [1000, 5000, 2000].forEach((v, i) => hb.push('dev', v, i));
      const st = hb.state('dev');
      const pts = D.sparkline(st.points);
      return st.sampling === false && typeof pts === 'string' && pts.split(' ').length === 3;
    } },
  { id: 'H4', label: '★ idle_ms 是 null（查不到）的点不算数 —— 两个真点 + 一个 null 仍是「采样中」',
    run: ({ D }) => {
      const hb = D.createHeartbeat();
      hb.push('qa', null, 1); hb.push('qa', 1000, 2); hb.push('qa', 2000, 3);
      return hb.state('qa').sampling === true;
    } },

  // ── 接线（源码断言 —— 弱证据，只证明「渲染路径用的是这里的判据」）──
  { id: 'W1', label: '★★ app.js 的卡片用 Derive.queueChips / Derive.currentTask 画（判据只有一处）',
    run: ({ app }) => /Derive\.queueChips\(qi, queueError\)/.test(app) && /Derive\.currentTask\(a, qi\)/.test(app) },
  { id: 'W2', label: '★★ app.js 的 isForHuman 只是转调 Derive.isForHuman（不是第二份实现）',
    run: ({ app }) => /function isForHuman\(m\) \{\s*return Derive\.isForHuman\(m\);\s*\}/.test(app) },
  { id: 'W3', label: '★ 「需要你」用 Derive.needYou，并把 app.js 的 CRIT_LEVELS 传进去',
    run: ({ app }) => /Derive\.needYou\(\{/.test(app) && /const crit = CRIT_LEVELS;/.test(app) },

  // ══ 「今天」视图 ════════════════════════════
  // ── 摘要句：briefSummary ──
  { id: 'BS1', label: '★★★ 摘要句里每个数字都来自输入：用 normal 夹具对一遍，再把夹具改几个数（全量 +7 / +2、多一个失联）对一遍 —— 数字跟着变、设计稿上的 3932 不会自己冒出来',
    run: ({ D }) => {
      const now = FX_NOW();
      const base = fixtureInputs(now);
      const s0 = D.briefSummary({ ...base, now, savedSince: null });
      const allowed0 = allowedNumbers(base, s0);
      const nums0 = numbersIn(s0.line1 + s0.line2);
      const okBase = nums0.every((n) => allowed0.has(n))
        && s0.line2.includes(`全量 ${base.status.d.tests.passed} 过 / ${base.status.d.tests.failed} 红`)
        && s0.line2.includes('1 个失联') && s0.line2.includes('1 个限额');
      // 改过的夹具：全量 3939 / 7，多一个失联 —— 输出必须跟着变
      const tw = fixtureInputs(now, { passed: 7, failed: 2, deaf: 1 });
      const s1 = D.briefSummary({ ...tw, now, savedSince: null });
      const allowed1 = allowedNumbers(tw, s1);
      return okBase && numbersIn(s1.line1 + s1.line2).every((n) => allowed1.has(n))
        && s1.line2.includes('全量 3939 过 / 7 红') && s1.line2.includes('2 个失联') && !/3932/.test(s1.line2);
    } },
  { id: 'BS2', label: '★★★ 「以来」那句只数起点**之后**的完成报告（夹具：起点 60 分钟前 ⇒ 4 条，其中 2 条已核验；起点今天 0 点 ⇒ 7 条）',
    run: ({ D }) => {
      const now = FX_NOW();
      const base = fixtureInputs(now);
      const s60 = D.briefSummary({ ...base, now, savedSince: String(now - 60 * MIN) });
      const sDay = D.briefSummary({ ...base, now, savedSince: null });
      return s60.counts.reports === 4 && s60.counts.verified === 2 && /^自 \d\d:\d\d 以来：4 条完成报告（2 条已核验）。/.test(s60.line1)
        && sDay.counts.reports === 7 && sDay.line1.startsWith('今天：7 条完成报告（2 条已核验）。');
    } },
  { id: 'BS3', label: '★★★ status 404 ⇒ 第二句写「全量：端点 404」，**不写数字**',
    run: ({ D }) => {
      const s = D.briefSummary({ now: NOW, status: { kind: '404', why: 'Cannot GET' }, agents: { deaf: [], live: [], stale: [] } });
      const part = s.line2.split(' · ')[0];
      return part === '现在：全量：端点 404' && !/\d/.test(part.replace('404', ''));
    } },
  { id: 'BS4', label: '★★★ /api/agents 报错 ⇒ 写「agent 状态查不了」，**不写**「agent 都正常」（即使手上还有上一次的数据）',
    run: ({ D }) => {
      const stale = { deaf: [], live: [agent('dev', 'ok')], rate_limited: [], stale: [] };
      const s = D.briefSummary({ now: NOW, status: { kind: 'ok', d: { tests: { passed: 1, failed: 0 } } },
        agents: stale, agentsError: 'HTTP 500' });
      // 阴性对照：同样的数据、没有报错 ⇒「agent 都正常」—— 所以上面那条不是「永远写查不了」
      const s0 = D.briefSummary({ now: NOW, status: { kind: 'ok', d: { tests: { passed: 1, failed: 0 } } }, agents: stale });
      return s.line2.includes('agent 状态查不了') && !s.line2.includes('都正常') && s0.line2.includes('agent 都正常');
    } },
  { id: 'BS5', label: '★★ 「现在」那句不进「以来」那句：全量和失联只出现在第二句（设计稿把两种混在一起了）',
    run: ({ D }) => {
      const now = FX_NOW();
      const s = D.briefSummary({ ...fixtureInputs(now), now, savedSince: String(now - 60 * MIN) });
      return s.line2.startsWith('现在：') && !/全量|失联|限额/.test(s.line1) && /全量/.test(s.line2);
    } },
  { id: 'SN1', label: '★★ 起点：读不到 / 坏的 / 超过 7 天 ⇒ 今天 00:00（写「今天」）；7 天内 ⇒ 用存的值',
    run: ({ D }) => {
      const day0 = new Date(NOW); day0.setHours(0, 0, 0, 0);
      const a = D.resolveSince(null, NOW), b = D.resolveSince('garbage', NOW);
      const c = D.resolveSince(String(NOW - 8 * 24 * HOUR), NOW), d = D.resolveSince(String(NOW - 6 * 24 * HOUR), NOW);
      return [a, b, c].every((x) => x.today && x.ms === day0.getTime()) && !d.today && d.ms === NOW - 6 * 24 * HOUR;
    } },
  { id: 'HL1', label: '★★★ 0 条但 /api/status 404 ⇒「查不了有没有事在等你」+ 端点，**不准**写「没有要你处理的事」；agents 不正常时条数写「N+?」',
    run: ({ D }) => {
      const a = D.helloLine({ count: 0, health: { agents: 'ok', status: '404' } });
      const b = D.helloLine({ count: 0, health: { agents: 'ok', status: 'ok' } });
      const c = D.helloLine({ count: 3, health: { agents: 'error', status: 'ok' } });
      return a.kind === 'unknown' && a.text.includes('查不了') && a.text !== '没有要你处理的事。' && a.detail.includes('/api/status 404')
        && b.text === '没有要你处理的事。' && c.text === '有 3+? 件事在等你。';
    } },

  // ── 刚完成：recentDone ──
  { id: 'RD1', label: '★★★ 跟帖合并：「pending 报告 + pass 跟帖（system 章、同一个 from、reply_to 指向报告）」只出 **1 行**，状态是通过',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [rep('a', { verify: 'pending' }), fol('f', 'a')]]], now: NOW });
      return r.rows.length === 1 && r.rows[0].id === 'a' && r.rows[0].verify.state === 'pass' && r.rows[0].verify.label === '已独立核验';
    } },
  { id: 'RD2', label: '★★★ sender_type 不是 system 的同形消息**不合并**（那是 agent 自己又报了一次完成，不是核验结论）',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [rep('a', { verify: 'pending' }), fol('f', 'a', 'pass', { sender_type: 'agent' })]]],
        now: NOW, reactions: new Map([['room:a', []], ['room:f', []]]) });
      const a = r.rows.find((x) => x.id === 'a');
      return r.rows.length === 2 && !!a && a.verify.state !== 'pass';
    } },
  { id: 'RD3', label: '★★★ 跟帖的原报告不在列表里 ⇒ 跟帖**自己成一行**，标「核验结论（原报告没加载）」—— 不准丢',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [fol('f', 'not-loaded', 'unverifiable')]]], now: NOW });
      return r.rows.length === 1 && r.rows[0].orphanVerdict === true && r.rows[0].verify.state === 'unverifiable';
    } },
  { id: 'RD4', label: '★★★ pending + 🔙 ⇒「核验没过 · 已打回」（红）',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [rep('a', { verify: 'pending' })]]], now: NOW,
        reactions: new Map([['room:a', [rx('🔙', NOW - 30 * MIN)]]]) });
      return r.rows[0].verify.state === 'bounced' && r.rows[0].verify.cls === 'bad' && r.rows[0].verify.label === '核验没过 · 已打回';
    } },
  { id: 'RD5', label: '★★★ pending、没有反应 ⇒「核验中」',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [rep('a', { verify: 'pending' })]]], now: NOW, reactions: new Map([['room:a', []]]) });
      return r.rows[0].verify.state === 'verifying' && r.rows[0].verify.label === '核验中';
    } },
  { id: 'RD6', label: '★★★ pending + 🏁、没有跟帖 ⇒「核验已结束 · 结论没加载到」，**不是**「通过」（pass 和 unverifiable 都贴 🏁）',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [rep('a', { verify: 'pending' })]]], now: NOW,
        reactions: new Map([['room:a', [rx('🏁', NOW - 30 * MIN)]]]) });
      const v = r.rows[0].verify;
      return v.state === 'ended_unknown' && v.label === '核验已结束 · 结论没加载到' && v.cls !== 'ok' && v.label !== '已独立核验';
    } },
  { id: 'RD7', label: '★★★ 没有 verify 字段 ⇒「未验证」（缺字段不能读成核过了）',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['dm:JARVIS', [rep('a')]]], now: NOW });
      return r.rows[0].verify.label === '未验证' && r.rows[0].verify.cls !== 'ok';
    } },
  { id: 'RD8', label: '★★★ 24 小时窗口：25 小时前的不出现，23 小时前的出现',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [rep('old', { at: NOW - 25 * HOUR }), rep('new', { at: NOW - 23 * HOUR })]]], now: NOW });
      return r.rows.length === 1 && r.rows[0].id === 'new' && D.DONE_WINDOW_MS === 24 * HOUR;
    } },
  { id: 'RD9', label: '★★ 超过 max（8）条时只给 8 行，并给出剩余条数（「还有 N 条」）',
    run: ({ D }) => {
      const list = Array.from({ length: 11 }, (_, i) => rep('m' + i, { at: NOW - (i + 1) * MIN }));
      const r = D.recentDone({ feeds: [['room:r', list]], now: NOW });
      return r.rows.length === 8 && r.total === 11 && r.more === 3 && r.rows[0].id === 'm0' && D.DONE_MAX === 8;
    } },
  { id: 'RD10', label: '★★ 一条报告有好几条跟帖 ⇒ 用**最新**的那条（先 unverifiable、后 pass ⇒ 通过）',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [rep('a', { verify: 'pending' }),
        fol('f1', 'a', 'unverifiable', { at: NOW - 50 * MIN }), fol('f2', 'a', 'pass', { at: NOW - 40 * MIN })]]], now: NOW });
      return r.rows.length === 1 && r.rows[0].verify.state === 'pass';
    } },
  { id: 'RD11', label: '★★ 报告本身是 thread 里的回复时，跟帖指向 thread 根（relay 的锚点 = reply_to || 自己）⇒ 仍然合进那份报告',
    run: ({ D }) => {
      const root = { id: 'T', from: 'JARVIS', text: '【流程】@dev 请开始', at: NOW - 2 * HOUR, kind: 'notice' };
      const r = D.recentDone({ feeds: [['room:r', [root, rep('b', { verify: 'pending', reply_to: 'T' }), fol('f', 'T')]]], now: NOW });
      return r.rows.length === 1 && r.rows[0].id === 'b' && r.rows[0].verify.state === 'pass';
    } },
  { id: 'RD12', label: '★★ 同一个锚点上有更新的报告 ⇒ 旧的那份 pending 不读反应（反应说的是新那份）⇒「结论不确定」',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [rep('b1', { verify: 'pending', reply_to: 'T', at: NOW - 90 * MIN }),
        rep('b2', { verify: 'pending', reply_to: 'T', at: NOW - 30 * MIN })]]], now: NOW,
        reactions: new Map([['room:T', [rx('🔙', NOW - 20 * MIN)]]]) });
      const by = Object.fromEntries(r.rows.map((x) => [x.id, x.verify.state]));
      return by.b1 === 'superseded' && by.b2 === 'bounced';
    } },
  { id: 'RD13', label: '★★ 反应还没取到 ⇒「读取中」并要求批量去取；取过但报错 ⇒「查不了」—— 都不是「核验中」',
    run: ({ D }) => {
      const feeds = [['room:r', [rep('a', { verify: 'pending' })]]];
      const r1 = D.recentDone({ feeds, now: NOW });
      const r2 = D.recentDone({ feeds, now: NOW, reactionsFailed: new Set(['room:a']) });
      return r1.rows[0].verify.state === 'reactions_loading' && r1.wanted.length === 1 && r1.wanted[0].anchor === 'a'
        && r2.rows[0].verify.state === 'reactions_error' && r2.wanted.length === 0;
    } },
  { id: 'FX1', label: '★★ 夹具 normal 对一遍（test/fixtures/web-preview/normal/SOURCE.md「刚完成」那几条）：合并 / 打回 / 核验中 / 已结束 / 未验证 / 原报告没加载 / 超过 24h 不出现',
    run: ({ D }) => {
      const now = FX_NOW();
      const f = fixtureInputs(now);
      const r = D.recentDone({ feeds: f.feeds, reactions: f.reactions, now, max: Infinity });
      const st = Object.fromEntries(r.rows.map((x) => [x.id, x.verify.state]));
      const orphan = r.rows.find((x) => x.orphanVerdict);
      return st['1791000021500-0'] === 'pass' && !('1791000022000-0' in st)
        && st['1791000020500-0'] === 'bounced' && st['1791000022500-0'] === 'verifying'
        && st['1791000021000-0'] === 'ended_unknown' && st['j-dev-r1'] === 'absent'
        && !!orphan && orphan.id === '1791000023000-0' && !('1790999990000-0' in st);
    } },
  { id: 'DT1', label: '★ 标题：第一行、去掉 markdown 标记、最多 60 个字（跳过代码围栏行）',
    run: ({ D }) => D.doneTitle('~~~\n## **W1** 合入后 `全量` 跑完') === 'W1 合入后 全量 跑完'
      && Array.from(D.doneTitle('字'.repeat(80))).length === 61 },

  // ── 进行中：inProgress ──
  { id: 'IP1', label: '★★★ 「派出 N 分钟」从 stream id 算，**不从 at / timestamp 算**（id 是 14 分钟前、timestamp 是 2 分钟前 ⇒ 14）',
    run: ({ D }) => {
      const qi = { items: [{ id: `${NOW - 14 * MIN}-0`, state: 'in_flight', text: '跑全量',
        timestamp: new Date(NOW - 2 * MIN).toISOString(), at: NOW - 2 * MIN }] };
      const rows = D.inProgress({ agents: { live: [agent('dev', 'ok')] }, queueOf: () => qi, now: NOW });
      return rows[0].right.text === '派出 14 分钟' && /不是从开始干算/.test(rows[0].right.title);
    } },
  { id: 'IP2', label: '★★ 申报中 ⇒「申报中」不写时长；队列查不了 ⇒ 不写「空闲」；限额那行写 STATUS.rate_limited.note；按名字排、不放 deaf / stale',
    run: ({ D }) => {
      const rows = D.inProgress({
        agents: { live: [agent('zed', 'ok', { declared_busy: true, busy_what: 'run-all' }), agent('amy', 'ok')],
                  rate_limited: [agent('dev2', 'rate_limited')], deaf: [agent('dev3', 'deaf')], stale: [agent('old', 'stale')] },
        queueError: 'HTTP 503', now: NOW, statusTable: { rate_limited: { note: 'NOTE-X', label: '限额 · 别推它' } } });
      const by = Object.fromEntries(rows.map((r) => [r.name, r]));
      return rows.map((r) => r.name).join() === 'amy,dev2,zed'
        && by.zed.right.text === '申报中' && by.amy.right.text !== '空闲' && by.amy.right.text === '队列查不了'
        && by.dev2.task.text === 'NOTE-X';
    } },

  // ── 「今天」视图接线（源码断言 —— 弱证据，只证明「两处用的是同一个函数 / 同一套节点」）──
  { id: 'W6', label: '★★ 今天视图的「等你处理」和右栏：同一次 needYou 计算、同一个渲染函数（variant 只换样子）',
    run: ({ app }) => (app.split('Derive.needYou(').length - 1) === 1
      && /renderNeedInto\(\$\('need'\), lastNeed, 'narrow'\)/.test(app) && /renderNeedInto\(box, L, 'wide'\)/.test(app) },
  { id: 'W7', label: '★★ 抽屉里没有第二套对话渲染：#feed 和 #composer 是**被移进去的**同一组节点（不是克隆、不是另画一份）',
    run: ({ app }) => /host\.appendChild\(feed\);\s*host\.appendChild\(comp\);/.test(app) && !/cloneNode/.test(app) },

  // ══ 完成报告与重报 ════════════════════════════
  // ── 完成报告不进「需要你」──
  { id: 'ND1', label: '★★★ 只带 done 的 ⇒ 不进「需要你」（filtered.done 记 1）；done + @Patrick ⇒ 进；done + expects_reply=\'true\' ⇒ 进',
    run: ({ D }) => {
      const feeds = new Map([['room:r', [
        { id: 'only', from: 'dev', text: '跑完了', done: 'true', at: NOW - 3000 },
        { id: 'men', from: 'dev', text: '跑完了 @Patrick 看一眼', done: 'true', at: NOW - 2000 },
        { id: 'exp', from: 'dev', text: '跑完了，要不要合？', done: 'true', expects_reply: 'true', at: NOW - 1000 },
      ]]]);
      const r = D.needYou({ agents: NOAG, feeds, now: NOW });
      const got = r.items.map((i) => i.msg.id).sort().join();
      return got === 'exp,men' && r.filtered.done === 1;
    } },
  { id: 'ND2', label: '★★★ 但 isForHuman 没改：完成报告**仍然**被提到线程折叠条外面（app.js renderThread 用 isForHuman 挑 lifted）',
    run: ({ D, app }) => D.isForHuman({ from: 'dev', text: '跑完了', done: 'true', reply_to: 'root' }) === true
      && D.forHumanReasons({ done: 'true', text: 'x' }).join() === 'done'
      && /const lifted = replies\.filter\(isForHuman\);/.test(app) },

  // ── 重报后 ⏳ 期间不能判成「已打回」──
  { id: 'RD16', label: '★★★ 复现（M1）：v1 pending、v2 重报 pending（reply_to v1），锚点上 🔙（旧）+ ⏳（新）⇒ v2 =「核验中」，**不是**「已打回」',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [
        rep('100-0', { verify: 'pending', at: NOW - 30 * MIN }),
        rep('200-0', { verify: 'pending', reply_to: '100-0', at: NOW - 5 * MIN }),
      ]]], now: NOW, reactions: new Map([['room:100-0', [rx('🔙', NOW - 20 * MIN), rx('⏳', NOW - 4 * MIN)]]]) });
      const by = Object.fromEntries(r.rows.map((x) => [x.id, x.verify.state]));
      return by['200-0'] === 'verifying' && by['100-0'] === 'superseded';
    } },
  { id: 'RD17', label: '★★★ 🔙（旧）+ 🏁（新）、没有 ⏳ ⇒「已结束 · 结论没加载到」（重报后核验做不了：unverifiable 不摘 🔙）',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [rep('a', { verify: 'pending' })]]], now: NOW,
        reactions: new Map([['room:a', [rx('🔙', NOW - 40 * MIN), rx('🏁', NOW - 10 * MIN)]]]) });
      return r.rows[0].verify.state === 'ended_unknown';
    } },
  { id: 'RD18', label: '★★ 只有 ⏳ ⇒「核验中」',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [rep('a', { verify: 'pending' })]]], now: NOW,
        reactions: new Map([['room:a', [rx('⏳', NOW - 10 * MIN)]]]) });
      return r.rows[0].verify.state === 'verifying';
    } },

  // ── watchdog 看不见时摘要句不写「都正常」──
  { id: 'BS6', label: '★★★ sessions_seen 0（live 组里的 agent 照样带 level）⇒ 第二句写「查不了」，**不写**「都正常」',
    run: ({ D }) => {
      const st = { kind: 'ok', d: { tests: { passed: 1, failed: 0 } } };
      const s = D.briefSummary({ now: NOW, status: st, agents: { sessions_seen: 0, deaf: [], live: [agent('dev', 'ok')], stale: [] } });
      return s.line2.includes('查不了') && !s.line2.includes('都正常');
    } },
  { id: 'BS6b', label: '★★★ watchdog_blind: true 同样 ⇒「查不了」，不写「都正常」',
    run: ({ D }) => {
      const st = { kind: 'ok', d: { tests: { passed: 1, failed: 0 } } };
      const s = D.briefSummary({ now: NOW, status: st, agents: { watchdog_blind: true, sessions_seen: 3, deaf: [], live: [agent('dev', 'ok')], stale: [] } });
      return s.line2.includes('查不了') && !s.line2.includes('都正常');
    } },

  // ── 四条（各有一个变异要杀）──
  { id: 'RD19', label: '★★ system 章、done、reply_to 都对，但 verify: \'pending\' ⇒ **不是**核验跟帖（不合并）',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [rep('a', { verify: 'pending' }), fol('f', 'a', 'pending')]]], now: NOW,
        reactions: new Map([['room:a', []]]) });
      // 它不是跟帖 ⇒ 它自己是一份（重报的）完成报告：两行；旧那份被同锚点的新报告取代，新那份按反应判
      const a = r.rows.find((x) => x.id === 'a'), f = r.rows.find((x) => x.id === 'f');
      return r.rows.length === 2 && !!a && !!f && a.verify.state === 'superseded' && f.verify.state === 'verifying';
    } },
  { id: 'RD20', label: '★★ 跟帖的 reply_to 指向**别人**的完成报告 ⇒ 不合并（跟帖自己成一行）',
    run: ({ D }) => {
      const r = D.recentDone({ feeds: [['room:r', [rep('a', { verify: 'pending', from: 'senior' }), fol('f', 'a')]]], now: NOW,
        reactions: new Map([['room:a', []]]) });
      const a = r.rows.find((x) => x.id === 'a');
      const f = r.rows.find((x) => x.id === 'f');
      return r.rows.length === 2 && a.verify.state === 'verifying' && !!f && f.orphanVerdict === true;
    } },
  { id: 'SN2', label: '★★ 存的起点比 now 晚（时钟回拨 / 坏值）⇒ 今天 00:00，写「今天」',
    run: ({ D }) => {
      const r = D.resolveSince(String(NOW + 10 * MIN), NOW);
      const s = D.briefSummary({ now: NOW, savedSince: String(NOW + 10 * MIN) });
      return r.today === true && s.line1.startsWith('今天');
    } },
  { id: 'BS7', label: '★★ 一个 warn 的 agent ⇒ 第二句有「1 个轮询慢」，不写「都正常」',
    run: ({ D }) => {
      const s = D.briefSummary({ now: NOW, status: { kind: 'ok', d: { tests: { passed: 1, failed: 0 } } },
        agents: { deaf: [], live: [agent('dev', 'ok'), agent('senior', 'warn')], stale: [] } });
      return s.line2.includes('1 个轮询慢') && !s.line2.includes('都正常');
    } },

  // ══ 「泳道」视图 ══════════════════════════════
  // ── laneEntries：三处拼接 / 去重 / 排序 / 派活只并 JARVIS 的 / 核验跟帖 / pending 标签 ──
  { id: 'LN1', label: '★★★ 三处拼接：私聊历史（in / out）+ 已加载房间里**它自己**的发言（别人的不收）+ 编排者那一列的派活',
    run: ({ D }) => {
      const dev = D.laneEntries({ name: 'dev', orchName: 'JARVIS',
        dm: [{ id: '10-0', stream: 'agent:dev:in', direction: 'in', from: 'JARVIS', to: 'dev', text: '派活', timestamp: NOW - 30 * MIN, job_id: 'j1' },
             { id: '11-0', stream: 'orch:in:agent', direction: 'out', from: 'dev', to: 'orchestrator', text: '收到', timestamp: NOW - 29 * MIN, job_id: 'j2' }],
        roomFeeds: [['room:h1', [{ id: '100-0', from: 'dev', text: '房间里我说的', at: NOW - 20 * MIN },
                                 { id: '101-0', from: 'senior', text: '别人说的', at: NOW - 19 * MIN }]],
                    ['dm:dev', [{ id: 'x', from: 'dev', text: '私聊 feed 不算房间', at: NOW - 18 * MIN }]]] });
      const orch = D.laneEntries({ name: 'JARVIS', orchName: 'JARVIS',
        dm: [{ id: '1-0', stream: 'orch:in:human', direction: 'in', from: 'Patrick', to: 'orchestrator', text: '人说的', timestamp: NOW - 40 * MIN }],
        roomFeeds: [['room:h1', [{ id: '102-0', from: 'JARVIS', text: '编排者在房间里说的', at: NOW - 10 * MIN }]]],
        orchExtra: [['dev', [{ id: '10-0', stream: 'agent:dev:in', direction: 'in', from: 'JARVIS', to: 'dev', text: '派活', timestamp: NOW - 30 * MIN, job_id: 'j1' }]]] });
      const k = (r) => r.entries.map((e) => e.kind).join(',');
      return k(dev) === 'in,out,room' && dev.entries[2].text === '房间里我说的' && dev.entries[2].chKey === 'room:h1'
        && k(orch) === 'in,disp,room' && orch.entries[1].to === 'dev' && orch.merged.join() === 'dev';
    } },
  { id: 'LN2', label: '★★★ 去重：同一条从两处来只出一条 —— 房间流那份 + 扇出进收件流的那份（room_hash + room_msg_id）；私聊行 + 本地回显（同一个 job_id）；同一行给两遍',
    run: ({ D }) => {
      const row = { id: '11-0', stream: 'orch:in:agent', direction: 'out', from: 'dev', to: 'orchestrator', text: '收到', timestamp: NOW - 29 * MIN, job_id: 'j2' };
      const fan = { id: '12-0', stream: 'orch:in:agent', direction: 'out', from: 'dev', to: 'JARVIS', text: '房间里我说的',
                    timestamp: NOW - 20 * MIN, job_id: 'jr', room_hash: 'h1', room_msg_id: '100-0' };
      const r = D.laneEntries({ name: 'dev', dm: [row, fan, { ...row }],
        roomFeeds: [['room:h1', [{ id: '100-0', from: 'dev', text: '房间里我说的', at: NOW - 20 * MIN }]]],
        local: [{ id: 'j2', from: 'dev', text: '收到', at: NOW - 29 * MIN }] });
      // 阴性对照：不同的 job_id 的本地回显 ⇒ 照收（不是「本地回显一律丢」）
      const r0 = D.laneEntries({ name: 'dev', dm: [row], local: [{ id: 'j-new', from: 'Patrick', text: '新的', at: NOW }] });
      return r.entries.length === 2 && r.entries.filter((e) => e.kind === 'room').length === 1 && r0.entries.length === 2;
    } },
  { id: 'LN3', label: '★★★ 排序：数字和 ISO 混着的时间按真时间排（新的在下）；时间优先于 stream id；判不出时间的排最后、不丢',
    run: ({ D }) => {
      const r = D.laneEntries({ name: 'dev', dm: [
        { id: '9000000000000-0', stream: 's', direction: 'in', from: 'a', text: 'B（ISO，第二）', timestamp: new Date(NOW - 20 * MIN).toISOString() },
        { id: '1000000000000-0', stream: 's', direction: 'in', from: 'a', text: 'C（数字，第三）', timestamp: NOW - 10 * MIN },
        { id: 'bad', stream: 's', direction: 'in', from: 'a', text: 'D（没有时间，最后）' },
        { id: '1500000000000-0', stream: 's', direction: 'in', from: 'a', text: 'A（数字字符串，第一）', timestamp: String(NOW - 30 * MIN) },
      ] });
      return r.entries.map((e) => e.text[0]).join('') === 'ABCD' && r.entries[3].t === null;
    } },
  { id: 'LN4', label: '★★★ 编排者那一列只并 `from === JARVIS` 的派活：别人（senior）发给 dev 的**不并**；JARVIS 在房间里说的话扇出进收件流的那份**也不算派活**',
    run: ({ D }) => {
      const rows = [
        { id: '10-0', stream: 'agent:dev:in', direction: 'in', from: 'JARVIS', to: 'dev', text: '派活', timestamp: NOW - 30 * MIN, job_id: 'j1' },
        { id: '13-0', stream: 'agent:dev:in', direction: 'in', from: 'senior', to: 'dev', text: '帮我看一眼', timestamp: NOW - 25 * MIN, job_id: 'j3' },
        { id: '14-0', stream: 'agent:dev:in', direction: 'in', from: 'JARVIS', to: 'dev', text: '【流程】房间里的话', timestamp: NOW - 24 * MIN,
          job_id: 'jr2', room_hash: 'h1', room_msg_id: '105-0' },
      ];
      const r = D.laneEntries({ name: 'JARVIS', orchName: 'JARVIS', orchExtra: [['dev', rows]] });
      // 非编排者的列不并（orchExtra 传错了地方也不会冒出派活行）
      const nd = D.laneEntries({ name: 'senior', orchName: 'JARVIS', orchExtra: [['dev', rows]] });
      return r.entries.length === 1 && r.entries[0].kind === 'disp' && r.entries[0].text === '派活' && nd.entries.length === 0;
    } },
  { id: 'LN5', label: '★★ 核验结论跟帖（system 章、verify pass、reply_to）⇒ 灰色系统行「核验结论：<标签>」，不是这个 agent 说的话、也不带 🏁',
    run: ({ D }) => {
      const r = D.laneEntries({ name: 'dev', dm: [
        { id: '20-0', stream: 'orch:in:agent', direction: 'out', from: 'dev', text: '完成', done: 'true', verify: 'pending', timestamp: NOW - 9 * MIN, job_id: 'jr' },
        { id: '21-0', stream: 'orch:in:agent', direction: 'out', from: 'dev', text: '✅ 独立核验通过', done: 'true', verify: 'pass',
          sender_type: 'system', reply_to: 'jr', timestamp: NOW - 8 * MIN, job_id: 'jv' }] });
      const v = r.entries[1];
      return v.kind === 'verdict' && v.done === null && v.verdict.label === D.doneState('pass').label && r.entries[0].kind === 'out' && !!r.entries[0].done;
    } },
  { id: 'LN6', label: '★★★ `verify: pending` 的完成标签是「已提交核验」—— **不是**「核验中」，**也不是**「通过」/「已独立核验」（泳道不取反应）',
    run: ({ D }) => {
      const r = D.laneEntries({ name: 'dev', roomFeeds: [['room:h', [{ id: '1-0', from: 'dev', text: '完成', done: true, verify: 'pending', at: NOW }]]] });
      const l = r.entries[0].done.label;
      return l === '已提交核验' && D.laneDoneState({ verify: 'pending' }).label === '已提交核验'
        && !/核验中|通过|已独立核验/.test(l) && D.laneDoneState({}).label === D.verifyLabel('none');
    } },
  { id: 'LF1', label: '★ 超过 6 行的正文折起来：7 行折、6 行不折',
    run: ({ D }) => D.laneFolds('1\n2\n3\n4\n5\n6\n7') === true && D.laneFolds('1\n2\n3\n4\n5\n6') === false },
  { id: 'LC1', label: '★★ 列头 ⓘ：后端的 coverage_note **原样**放进去；房间数写真实的；编排者那一列写清并了哪几个 agent',
    run: ({ D }) => {
      const note = '「发出」只覆盖发给编排者的那部分（orch:in:agent / orch:out）。它发给其它 agent 的消息由 relay 直接投进对方的收件流，不在这里。';
      const t = D.laneCoverage({ name: 'JARVIS', orchName: 'JARVIS', rooms: 3, merged: ['dev', 'senior'],
        payload: { sources: [{ stream: 'orch:in:human', direction: 'in', matched: 2 }], coverage_note: note } });
      const t2 = D.laneCoverage({ name: 'dev', orchName: 'JARVIS', rooms: 3, error: 'PARTIAL_UNAVAILABLE' });
      return t.includes(note) && t.includes('已加载的 3 个房间') && t.includes('dev、senior') && t.includes('orch:in:human（in）2 条')
        && t2.includes('查不了 —— PARTIAL_UNAVAILABLE') && !t2.includes('③');
    } },

  // ── laneLayout：谁有列、谁进窄栏、什么顺序 ──
  { id: 'LO1', label: '★★★ `rate_limited` **不在**列里（按组认、也按 level 认）、进窄栏；stale 也进窄栏',
    run: ({ D }) => {
      const L = D.laneLayout({ live: [agent('JARVIS', 'ok', { type: 'orchestrator' }), agent('dev4', 'rate_limited')],
        deaf: [], rate_limited: [agent('dev2', 'rate_limited')], stale: [agent('old', 'stale')] }, { orchName: 'JARVIS' });
      const lanes = L.lanes.map((r) => r.name), dock = L.dock.map((r) => r.name);
      return !lanes.includes('dev2') && !lanes.includes('dev4') && !lanes.includes('old')
        && dock.join() === 'dev2,dev4,old' && lanes.join() === 'JARVIS';
    } },
  { id: 'LO2', label: '★★★ 顺序：编排者第一，**失联的紧跟其后**（救援面板在视野里），其余按名字',
    run: ({ D }) => {
      const L = D.laneLayout({ live: [agent('zed', 'ok'), agent('amy', 'warn'), agent('JARVIS', 'ok', { type: 'orchestrator' }), agent('old2', 'alert')],
        deaf: [agent('dev3', 'deaf')], rate_limited: [], stale: [] }, { orchName: 'JARVIS' });
      const names = L.lanes.map((r) => r.name).join();
      return names === 'JARVIS,dev3,old2,amy,zed' && L.lanes[1].lost === true && L.lanes[3].lost === false
        && D.laneLayout(null) === null;
    } },

  // ── 命令条：目标里没有 agent ──
  { id: 'CT1', label: '★★★ 命令条的目标 = 编排者 + 房间，**不含任何 agent** —— 就算把 agent 列表塞给它也一样',
    run: ({ D }) => {
      const t = D.cmdTargets({ orchName: 'JARVIS', rooms: [{ hash: 'h1', name: 'eng-loop' }], agents: ['dev', 'senior', 'dev3'] });
      return t.length === 2 && t[0].kind === 'dm' && t[0].id === 'JARVIS' && t[1].kind === 'room' && t[1].id === 'h1'
        && !t.some((x) => x.kind === 'dm' && x.id !== 'JARVIS');
    } },
  { id: 'CT2', label: '★★★ app.js 里命令条的目标表**只**从 `Derive.cmdTargets({ orchName: ORCH, rooms: cmdRooms() })` 来（一处、不带 agent），发送前还挡一次「不是编排者的私聊」（源码断言）',
    run: ({ app }) => (app.split('Derive.cmdTargets(').length - 1) === 1
      && /return Derive\.cmdTargets\(\{ orchName: ORCH, rooms: cmdRooms\(\) \}\);\n\}/.test(app)
      && /if \(t\.kind !== 'room' && t\.id !== ORCH\) \{/.test(app) },
  { id: 'CT3', label: '★★ 焦点在 agent 的列 ⇒ 灰字「要给 dev 派活，发给 JARVIS」；焦点在编排者 / 没有焦点 ⇒ 没有',
    run: ({ D }) => D.cmdFocusHint({ focus: 'dev', orchName: 'JARVIS' }) === '要给 dev 派活，发给 JARVIS'
      && D.cmdFocusHint({ focus: 'JARVIS', orchName: 'JARVIS' }) === null && D.cmdFocusHint({ orchName: 'JARVIS' }) === null },

  // ── 发送只有一份 / 正文只走 mdToHtml / 拉失败不清空（源码断言 —— 弱证据，e2e 另验行为）──
  { id: 'ST1', label: '★★★ `sendTo` 只有一份：`/api/message` 和 `/api/rooms/…/post` 在 app.js 里各只出现一次，composer 和命令条都调 sendTo',
    run: ({ app }) => (app.match(/'\/api\/message'/g) || []).length === 1
      // 认的是代码里那种模板串（`/api/rooms/${…}/post`）—— 注释里的 `/api/rooms/:hash/post` 不算
      && (app.match(/\/api\/rooms\/\$\{[^}]*\}\/post`/g) || []).length === 1
      && (app.match(/async function sendTo\(/g) || []).length === 1
      && /async function send\(\)[\s\S]*?await sendTo\(target, text, \{ replyTo: replyingTo, box \}\)/.test(app)
      && /async function cmdSend\(\)[\s\S]*?await sendTo\(t, text, \{ box \}\)/.test(app) },
  { id: 'MD1', label: '★★★ 正文只走 `mdToHtml`（先 esc 再替换）：app.js 里每一处 `innerHTML =` 右边要么是 mdToHtml(…)、要么是自己的 SVG 常量；mdToHtml 只有一份',
    run: ({ app }) => {
      const sets = app.match(/innerHTML = [^;]+;/g) || [];
      return sets.length > 0 && sets.every((s) => /^innerHTML = (mdToHtml\(|COPY_SVG;)/.test(s))
        && (app.match(/function mdToHtml\(/g) || []).length === 1
        && /tx\.innerHTML = mdToHtml\(e\.text\);/.test(app);
    } },
  { id: 'LS1', label: '★★★ 某一列拉失败：**不清空**上次的内容（fetchLane 的 catch 里不碰 rows / payload），只记错误',
    run: ({ app }) => {
      const m = /async function fetchLane\([\s\S]*?\n\}\n/.exec(app);
      if (!m) return false;
      const c = m[0].split('} catch (e) {')[1] || '';
      return c.length > 0 && /cur\.error = /.test(c) && !/cur\.rows\s*=/.test(c) && !/cur\.payload\s*=/.test(c);
    } },
];

const MUTATIONS = [
  { id: 'M-Q-total', file: 'derive', kills: ['Q1', 'Q2', 'Q3'],
    why: '两格都改成写总数（合成「待处理 N」）',
    from: "text: `排队 ${queued}`,", to: 'text: `待处理 ${queued + inFlight}`,',
    also: [["text: `在手 ${inFlight}`,", 'text: `待处理 ${queued + inFlight}`,']] },
  { id: 'M-Q-zero', file: 'derive', kills: ['Q2'],
    why: '零那格不画字（「排队 0」变空）',
    from: "text: `排队 ${queued}`,", to: "text: queued ? `排队 ${queued}` : '',", also: [] },
  { id: 'M-Q-err', file: 'derive', kills: ['Q4'],
    why: '查不了时当成「没有积压」',
    from: 'if (queueError) {', to: 'if (false) {', also: [] },
  { id: 'M-N-limit', file: 'derive', kills: ['N1'],
    why: '去掉「rate_limited 不收」那一行',
    from: "if (a.level === 'rate_limited') continue;", to: '', also: [] },
  { id: 'M-N-crit', file: 'app', kills: ['N2'],
    why: '有人把 rate_limited 加进 CRIT_LEVELS',
    from: "const CRIT_LEVELS = new Set(['deaf',", to: "const CRIT_LEVELS = new Set(['rate_limited', 'deaf',", also: [] },
  { id: 'M-N-human', file: 'derive', kills: ['N3'],
    why: '不过 isForHuman 就收',
    from: 'if (!isForHuman(m)) continue;', to: '', also: [] },
  { id: 'M-N-truthy', file: 'derive', kills: ['N3'],
    why: "把 expects_reply 当真值判（'false' 是 truthy 字符串）",
    from: "if (Threads.expectsReply(m)) out.push('expects_reply');", to: "if (m.expects_reply) out.push('expects_reply');", also: [] },
  { id: 'M-N-mention', file: 'derive', kills: ['N4'],
    why: '漏掉 @Patrick 那一档',
    from: "if (/@Patrick\\b/i.test(text)) out.push('mention');", to: '', also: [] },
  { id: 'M-N-order', file: 'derive', kills: ['N5'],
    why: '② 排到 ① 前面',
    from: 'items: items.concat(msgs),', to: 'items: msgs.concat(items),', also: [] },
  { id: 'M-N-self', file: 'derive', kills: ['N8'],
    why: '删掉「人自己说的话不算」那一行（N8 守的就是这一行）',
    from: 'if (isHuman(m)) continue;', to: '', also: [] },
  { id: 'M-N-dismiss', file: 'derive', kills: ['N6'],
    why: '无视「收起」',
    from: 'if (dismissed.has(key)) continue;', to: '', also: [] },
  { id: 'M-N-health', file: 'derive', kills: ['N7'],
    why: '查不了画成正常',
    from: "agents: agentsError ? 'error' : (agents ? 'ok' : 'unknown'),", to: "agents: 'ok',", also: [] },
  { id: 'M-R-window', file: 'derive', kills: ['R1', 'R2', 'R9'],
    why: '去掉时间窗',
    from: 'if (t !== null && now - t > windowMs) { outOfWindow++; continue; }', to: '', also: [] },
  // ⚠️ `atMs` 的实现在 threads.js（derive 只留别名）⇒ 这条变异改 threads.js 的源码。
  { id: 'M-R-iso', file: 'threads', kills: ['R2'],
    why: '只认数字型 at（ISO 字符串判不出时间 ⇒ 留着）',
    from: "if (typeof at === 'string' && at.trim()) {", to: 'if (false) {', also: [] },
  { id: 'M-R-answered', file: 'derive', kills: ['R3', 'R5', 'R7', 'R9'],
    why: '去掉「人类回过」的判断',
    from: 'if (answeredByHuman(arr, i, isRoom, isHuman, isRoom ? mergesOf(chKey) : null)) { answered++; continue; }', to: '', also: [] },
  { id: 'M-R-before', file: 'derive', kills: ['R4'],
    why: '私聊里人类**任何时候**说过话都算回过（不看先后）',
    from: "    if (!isRoom) {\n      for (let j = idx + 1; j < list.length; j++) {", to: "    if (!isRoom) {\n      for (let j = 0; j < list.length; j++) {", also: [] },
  { id: 'M-R-anythread', file: 'derive', kills: ['R6'],
    why: '房间里人类回了**任何**线程都算',
    from: 'if (h.reply_to === m.id || Threads.rootIdOf(h, byId, merges) === root) return true;', to: 'return true;', also: [] },
  { id: 'M-R-name', file: 'derive', kills: ['R7'],
    why: '人类判据写死成名字 Patrick',
    from: 'if (h && !h.sys && isHuman(h)) return true;', to: "if (h && !h.sys && h.from === 'Patrick') return true;", also: [] },
  { id: 'M-R-agentwin', file: 'derive', kills: ['R8'],
    why: '失联 agent 也套时间窗',
    from: 'if (!crit.has(a.level)) continue;', to: 'if (!crit.has(a.level) || now - (a.at || 0) > windowMs) continue;', also: [] },
  { id: 'M-C-ellipsis', file: 'css', kills: ['C1'],
    why: '名字改回省略号',
    from: 'white-space:normal;overflow-wrap:anywhere;text-overflow:clip;', to: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', also: [] },
  { id: 'M-C-minw', file: 'css', kills: ['C2'],
    why: '卡片可以缩到 0 宽',
    from: '.ag{flex:1 0 176px;min-width:176px;', to: '.ag{flex:1 1 0;min-width:0;', also: [] },
  { id: 'M-W-count', file: 'app', kills: ['W4'],
    why: '角标数字用过滤之前的条数',
    from: 'const n = r.items.length;', to: 'const n = r.items.length + r.filtered.outOfWindow + r.filtered.answered;', also: [] },
  { id: 'M-W-human-name', file: 'app', kills: ['W5'],
    why: 'isHumanMsg 写死名字',
    from: '  if (!m) return false;\n  if (m.sender_type)', to: "  if (!m) return false;\n  if (m.from === 'Patrick') return true;\n  if (m.sender_type)", also: [] },
  { id: 'M-T-last', file: 'derive', kills: ['T1'],
    why: '拿最后一条消息顶替当前任务',
    from: "return { text: '—', source: 'none' };",
    to: "{ const ms = arguments[2] || []; if (ms.length) return { text: ms[ms.length - 1].text, source: 'last' }; } return { text: '—', source: 'none' };",
    also: [] },
  { id: 'M-T-declared', file: 'derive', kills: ['T2'],
    why: '无视申报',
    from: 'if (agent && agent.declared_busy === true) {', to: 'if (false) {', also: [] },
  { id: 'M-T-latest', file: 'derive', kills: ['T3'],
    why: '取最晚那条',
    from: '.sort((a, b) => cmpStreamId(a.id, b.id))[0];', to: '.sort((a, b) => cmpStreamId(b.id, a.id))[0];', also: [] },
  { id: 'M-T-queued', file: 'derive', kills: ['T3'],
    why: '排队的也算「在手」',
    from: "filter((it) => it && it.state === 'in_flight')", to: "filter((it) => it && it.state !== 'done')", also: [] },
  { id: 'M-T-chars', file: 'derive', kills: ['T4'],
    why: '截 80 个字',
    from: 'const TASK_CHARS = 40;', to: 'const TASK_CHARS = 80;', also: [] },
  { id: 'M-H-cap', file: 'derive', kills: ['H1'],
    why: '环形缓冲不封顶（翻倍）',
    from: 'while (arr.length > max) arr.shift();', to: 'while (arr.length > max * 2) arr.shift();', also: [] },
  { id: 'M-H-min', file: 'derive', kills: ['H2'],
    why: '一个点就画线',
    from: "if (pts.length < min) return { sampling: true, label: '采样中', n: pts.length, points: [] };",
    to: "if (pts.length < 1) return { sampling: true, label: '采样中', n: pts.length, points: [] };", also: [] },
  { id: 'M-H-spark', file: 'derive', kills: ['H2'],
    why: 'sparkline 不管点数够不够',
    from: '    if (pts.length < min) return null;\n', to: '\n', also: [] },
  { id: 'M-H-never', file: 'derive', kills: ['H3'],
    why: '永远「采样中」',
    from: "if (pts.length < min) return { sampling: true, label: '采样中', n: pts.length, points: [] };",
    to: "return { sampling: true, label: '采样中', n: pts.length, points: [] };", also: [] },
  { id: 'M-H-null', file: 'derive', kills: ['H4'],
    why: '把 null 点也算数',
    from: "const pts = (buf.get(name) || []).filter((p) => p.idle_ms != null);", to: 'const pts = (buf.get(name) || []);', also: [] },
  { id: 'M-W-chips', file: 'app', kills: ['W1'],
    why: '卡片自己算队列（不走 Derive）',
    from: 'const qc = Derive.queueChips(qi, queueError);', to: 'const qc = { chips: [] };', also: [] },
  { id: 'M-W-human', file: 'app', kills: ['W2'],
    why: 'app.js 里又写了一份判据',
    from: 'return Derive.isForHuman(m);', to: "return /@Patrick/.test(String(m && m.text));", also: [] },
  { id: 'M-W-need', file: 'app', kills: ['W3'],
    why: '「需要你」传了一个自造的 crit',
    from: 'const crit = CRIT_LEVELS;', to: "const crit = new Set(['deaf']);", also: [] },

  // ══ 「今天」视图 ═══════════════════════════════════════════════════════════════
  { id: 'M-BS-hard', file: 'derive', kills: ['BS1'],
    why: '摘要句里的全量写死成设计稿上那个数（3932）',
    from: "parts.push(`全量${tr.stale ? '（过时）' : ''} ${tr.passed} 过 /", to: "parts.push(`全量${tr.stale ? '（过时）' : ''} 3932 过 /", also: [] },
  { id: 'M-BS-levels', file: 'derive', kills: ['BS1'],
    why: 'agent 计数只数 deaf 组（漏掉限额那组）',
    from: "    for (const a of agents.rate_limited || []) add(a, 'rate_limited');\n", to: '\n', also: [] },
  { id: 'M-BS-since', file: 'derive', kills: ['BS2'],
    why: '「以来」那句不切起点（把整段历史都算进来）',
    from: 'const after = all.filter((r) => r.at !== null && r.at > since.ms);', to: 'const after = all;', also: [] },
  { id: 'M-BS-404', file: 'derive', kills: ['BS3'],
    why: 'status 404 不当「端点 404」处理',
    from: "if (k === '404') return { state: '404', text: '端点 404' };\n    if (k === 'error') return { state: 'error', text: '查不了' };\n    if (k !== 'ok') return { state: 'loading', text: '—' };\n    const d = status.d",
    to: "if (k === 'error') return { state: 'error', text: '查不了' };\n    if (k !== 'ok') return { state: 'loading', text: '—' };\n    const d = status.d", also: [] },
  { id: 'M-BS-agentserr', file: 'derive', kills: ['BS4'],
    why: '/api/agents 报错时还拿上一次的数据数（写成「agent 都正常」）',
    from: "    if (agentsError) {\n      parts.push('agent 状态查不了');", to: "    if (false) {\n      parts.push('agent 状态查不了');", also: [] },
  { id: 'M-BS-mix', file: 'derive', kills: ['BS5'],
    why: '把「现在」的全量读数塞进「以来」那句（设计稿的写法）',
    from: "    if (orphanVerdicts) line1 += `另有 ${orphanVerdicts} 条核验结论（原报告没加载）。`;",
    to: "    if (orphanVerdicts) line1 += `另有 ${orphanVerdicts} 条核验结论（原报告没加载）。`;\n    { const t0 = testsReading(status); if (t0.state === 'ok') line1 += `全量 ${t0.passed} 过。`; }", also: [] },
  { id: 'M-SN-7d', file: 'derive', kills: ['SN1'],
    why: '起点不封顶（7 天改成 70 天）',
    from: 'const SINCE_MAX_MS = 7 * DAY_MS;', to: 'const SINCE_MAX_MS = 70 * DAY_MS;', also: [] },
  { id: 'M-HL-none', file: 'derive', kills: ['HL1'],
    why: '0 条就写「没有要你处理的事」，不管端点正不正常',
    from: "if (!bad.length) return { kind: 'none', text: '没有要你处理的事。', bad };", to: "return { kind: 'none', text: '没有要你处理的事。', bad };", also: [] },
  { id: 'M-RD-merge', file: 'derive', kills: ['RD1', 'RD10', 'RD11'],
    why: '认不出核验跟帖（跟帖当成第二份完成报告）',
    from: "return !!m && !m.sys && Threads.isDone(m) && m.sender_type === 'system'", to: 'return false', also: [] },
  { id: 'M-RD-stamp', file: 'derive', kills: ['RD2'],
    why: '不看 sender_type —— agent 自己又报一次也被合并成「核验通过」',
    from: "return !!m && !m.sys && Threads.isDone(m) && m.sender_type === 'system'", to: 'return !!m && !m.sys && Threads.isDone(m)', also: [] },
  { id: 'M-RD-orphan', file: 'derive', kills: ['RD3', 'FX1'],
    why: '原报告没加载的跟帖直接丢掉',
    from: 'if (target === undefined) orphans.push(i);', to: 'if (target === undefined) { /* 丢掉 */ }', also: [] },
  { id: 'M-RD-back', file: 'derive', kills: ['RD4', 'FX1'],
    why: '不看 🔙（打回的读成「核验中」）',
    from: 'const back = emojiAt(rs, VERIFY_EMOJI.BOUNCED);', to: 'const back = null;', also: [] },
  { id: 'M-RD-verifying', file: 'derive', kills: ['RD5', 'FX1'],
    why: 'pending 没反应 ⇒ 当成通过',
    from: "else state = 'verifying';", to: "else state = 'pass';", also: [] },
  { id: 'M-RD-flag', file: 'derive', kills: ['RD6', 'FX1'],
    why: '🏁 读成「通过」',
    from: "else if (flag !== null) state = 'ended_unknown';", to: "else if (flag !== null) state = 'pass';", also: [] },
  { id: 'M-RD-absent', file: 'derive', kills: ['RD7'],
    why: '没有 verify 字段 ⇒ 当成核过了',
    from: "state = m.verify == null || m.verify === '' ? 'absent' : String(m.verify);",
    to: "state = m.verify == null || m.verify === '' ? 'pass' : String(m.verify);", also: [] },
  { id: 'M-RD-window', file: 'derive', kills: ['RD8', 'FX1'],
    why: '去掉 24 小时窗口',
    from: 'const inWindow = (t) => t === null || now - t <= windowMs;', to: 'const inWindow = () => true;', also: [] },
  { id: 'M-RD-more', file: 'derive', kills: ['RD9'],
    why: '截断了不说剩几条',
    from: 'more: Math.max(0, plain - cap)', to: 'more: 0', also: [] },
  { id: 'M-RD-latest', file: 'derive', kills: ['RD10'],
    why: '好几条跟帖时用第一条（不是最新那条）',
    from: 'if (!prev || newer(arr[i], i, prev.m, prev.idx)) verdictOf.set(j, { m: arr[i], idx: i });',
    to: 'if (!prev) verdictOf.set(j, { m: arr[i], idx: i });', also: [] },
  { id: 'M-RD-anchor', file: 'derive', kills: ['RD11'],
    why: '只认 reply_to === 报告 id（relay 的锚点是 thread 根时合并不上）',
    from: '          for (const j of reports) if (j < i && arr[j].from === f.from && anchorOf(arr[j]) === to) target = j;\n',
    to: '\n', also: [] },
  { id: 'M-RD-super', file: 'derive', kills: ['RD12'],
    why: '同一个锚点上的旧报告也读反应（新那份的 🔙 记到旧那份上）',
    from: 'if (reports.some((k) => k > j && anchorOf(arr[k]) === anchor)) {', to: 'if (false) {', also: [] },
  { id: 'M-RD-failed', file: 'derive', kills: ['RD13'],
    why: '反应读不到画成「读取中」（查不了 ≠ 还没回来）',
    from: "if (failedR.has(rk)) state = 'reactions_error';", to: "if (false) state = 'reactions_error';", also: [] },
  { id: 'M-DT-fence', file: 'derive', kills: ['DT1'],
    why: '标题不跳代码围栏行',
    from: "if (!t || /^(```|~~~)/.test(t)) continue;", to: 'if (!t) continue;', also: [] },
  { id: 'M-IP-at', file: 'derive', kills: ['IP1'],
    why: '「派出 N 分钟」改成按条目的 timestamp 算',
    from: 'const ms = dispatchedMs(task.id, now);',
    to: "const ms = (() => { const it = ((qi && qi.items) || []).find((x) => x.id === task.id); const t = it && atMs(it.timestamp); return t === null || t === undefined ? null : now - t; })();",
    also: [] },
  { id: 'M-IP-idle', file: 'derive', kills: ['IP2'],
    why: '队列查不了时写「空闲」',
    from: "} else if (task.source === 'none' && queueError) {", to: '} else if (false) {', also: [] },
  { id: 'M-W-need2', file: 'app', kills: ['W6'],
    why: '今天视图自己再算一次「需要你」（两处会对不上）',
    from: "renderNeedInto(box, L, 'wide');", to: "renderNeedInto(box, { ...L, r: Derive.needYou({ feeds }) }, 'wide');", also: [] },
  { id: 'M-W-clone', file: 'app', kills: ['W7'],
    why: '抽屉里放一份克隆（第二套 DOM：草稿和回复中不跟着走）',
    from: 'host.appendChild(feed);', to: 'host.appendChild(feed.cloneNode(true));', also: [] },

  // ══ 完成报告与重报 ════════════════════════════════════════════════════════
  { id: 'M-ND-doneonly', file: 'derive', kills: ['ND1', 'R9'],
    why: '去掉「只带 done 的不收」（完成报告又回到「需要你」）',
    from: "if (why.length === 1 && why[0] === 'done') { doneOnly++; continue; }", to: '', also: [] },
  { id: 'M-ND-forhuman', file: 'derive', kills: ['ND2'],
    why: '错的改法：从 isForHuman 里拿掉 done（线程里的完成报告就不提出来了）',
    from: "if (Threads.isDone(m)) out.push('done');                     // ②", to: '', also: [] },
  { id: 'M-RD-hourglass', file: 'derive', kills: ['RD16'],
    why: '不看 ⏳（重报后旧的 🔙 记到新报告头上）',
    from: "if (running !== null) state = 'verifying';", to: "if (false) state = 'verifying';", also: [] },
  { id: 'M-RD-hourglass-ended', file: 'derive', kills: ['RD16', 'RD18'],
    why: '⏳ 读成「已结束」',
    from: "if (running !== null) state = 'verifying';", to: "if (running !== null) state = 'ended_unknown';", also: [] },
  { id: 'M-RD-back-always-wins', file: 'derive', kills: ['RD17'],
    why: '🔙 永远赢（不跟 🏁 比时间）',
    from: "else if (back !== null && (flag === null || !(flag > back))) state = 'bounced';", to: "else if (back !== null) state = 'bounced';", also: [] },
  { id: 'M-BS-blind', file: 'derive', kills: ['BS6', 'BS6b'],
    why: 'watchdog 看不见时照样按 level 数（会写「agent 都正常」）',
    from: '} else if (agents.watchdog_blind || agents.sessions_seen === 0) {', to: '} else if (false) {', also: [] },
  { id: 'M-RD-verify-any', file: 'derive', kills: ['RD19'],
    why: '认跟帖时不看 verify ∈ {pass, unverifiable}',
    from: "      && (m.verify === 'pass' || m.verify === 'unverifiable')\n", to: '\n', also: [] },
  { id: 'M-RD-any-from', file: 'derive', kills: ['RD20'],
    why: '按 id 找报告时不比 from（别人的报告也合并）',
    from: 'String(arr[j].id) === to && arr[j].from === f.from);', to: 'String(arr[j].id) === to);', also: [] },
  { id: 'M-SN-future', file: 'derive', kills: ['SN2'],
    why: '起点在未来也照用',
    from: 'if (t === null || t > now || now - t > SINCE_MAX_MS)', to: 'if (t === null || now - t > SINCE_MAX_MS)', also: [] },
  { id: 'M-BS-warn', file: 'derive', kills: ['BS7'],
    why: 'warn 算正常',
    from: "const NORMAL_LEVELS = new Set(['ok', 'busy']);", to: "const NORMAL_LEVELS = new Set(['ok', 'busy', 'warn']);", also: [] },

  // ══ 「泳道」══
  { id: 'M-LN-room', file: 'derive', kills: ['LN1'],
    why: '房间那一处不拼',
    from: 'if (!m || m.sys || m.from !== name) continue;', to: 'continue;', also: [] },
  { id: 'M-LN-room-anyone', file: 'derive', kills: ['LN1'],
    why: '房间里谁说的都收（不看 from）',
    from: 'if (!m || m.sys || m.from !== name) continue;', to: 'if (!m || m.sys) continue;', also: [] },
  { id: 'M-LN-orch-none', file: 'derive', kills: ['LN1'],
    why: '编排者那一列不并派活（只看 /api/messages?to=JARVIS —— 它本身不含派活）',
    from: '    if (name === orchName) {\n      for (const [crew, rows] of orchExtra || []) {', to: '    if (false) {\n      for (const [crew, rows] of orchExtra || []) {', also: [] },
  { id: 'M-LN-dedupe', file: 'derive', kills: ['LN2'],
    why: '不去重',
    from: 'if (keys.some((k) => seen.has(k))) return;', to: '', also: [] },
  { id: 'M-LN-fankey', file: 'derive', kills: ['LN2'],
    why: '扇出进收件流的那份不按房间流的键认（只按收件流自己的 stream id）',
    from: "if (m.room_hash && m.room_msg_id != null) keys.push(`room:${m.room_hash}|${m.room_msg_id}`);", to: '', also: [] },
  { id: 'M-LN-iso', file: 'derive', kills: ['LN3'],
    why: '只认数字型时间（ISO 判不出 ⇒ 退到 stream id）',
    from: 'const t = atMs(raw);', to: "const t = typeof raw === 'number' ? raw : null;", also: [] },
  { id: 'M-LN-desc', file: 'derive', kills: ['LN3'],
    why: '新的排在上面',
    from: '        return a.t - b.t;\n      }\n      return a.ord - b.ord;', to: '        return b.t - a.t;\n      }\n      return a.ord - b.ord;', also: [] },
  { id: 'M-LN-orch-from', file: 'derive', kills: ['LN4'],
    why: '派活不看 from（别人发给 agent 的也画成 JARVIS 派的）',
    from: 'if (m.from !== orchName) continue;      // ★★', to: '// ★★', also: [] },
  { id: 'M-LN-orch-room', file: 'derive', kills: ['LN4'],
    why: '房间扇出的那份也当派活',
    from: 'if (!m || m.sys || m.room_hash) continue;', to: 'if (!m || m.sys) continue;', also: [] },
  { id: 'M-LN-orch-anylane', file: 'derive', kills: ['LN4'],
    why: '任何一列都并派活',
    from: '    if (name === orchName) {\n      for (const [crew, rows] of orchExtra || []) {', to: '    if (true) {\n      for (const [crew, rows] of orchExtra || []) {', also: [] },
  { id: 'M-LN-verdict', file: 'derive', kills: ['LN5'],
    why: '核验跟帖当成这个 agent 自己的完成报告',
    from: "if (isVerdictFollowup(m)) { e.kind = 'verdict';", to: "if (false) { e.kind = 'verdict';", also: [] },
  { id: 'M-LN-pending-verifying', file: 'derive', kills: ['LN6'],
    why: 'pending 写成「核验中」',
    from: "if (v === 'pending') return doneState('submitted');", to: "if (v === 'pending') return doneState('verifying');", also: [] },
  { id: 'M-LN-pending-pass', file: 'derive', kills: ['LN6'],
    why: 'pending 读成通过',
    from: "if (v === 'pending') return doneState('submitted');", to: "if (v === 'pending') return doneState('pass');", also: [] },
  { id: 'M-LN-pending-none', file: 'derive', kills: ['LN6'],
    why: '没有 pending 那一档（照 doneState 的老写法 ⇒「未验证」）',
    from: "if (v === 'pending') return doneState('submitted');", to: '', also: [] },
  { id: 'M-LF-7', file: 'derive', kills: ['LF1'],
    why: '7 行才折',
    from: 'const LANE_FOLD_LINES = 6;', to: 'const LANE_FOLD_LINES = 7;', also: [] },
  { id: 'M-LC-note', file: 'derive', kills: ['LC1'],
    why: 'ⓘ 里不放后端的 coverage_note（自己另写一句）',
    from: 'if (payload.coverage_note) lines.push(payload.coverage_note);', to: "lines.push('发给别人的不在这里');", also: [] },
  { id: 'M-LO-limit', file: 'derive', kills: ['LO1'],
    why: 'rate_limited 也画成一列（只有 stale 进窄栏）',
    from: "if (fb === 'rate_limited' || fb === 'stale' || DOCK_LEVELS.includes(level)) dock.push(row);", to: "if (fb === 'stale') dock.push(row);", also: [] },
  { id: 'M-LO-limit-level', file: 'derive', kills: ['LO1'],
    why: '只按组认、不按 level 认（live 组里带 rate_limited 的混进列）',
    from: "if (fb === 'rate_limited' || fb === 'stale' || DOCK_LEVELS.includes(level)) dock.push(row);", to: "if (fb === 'rate_limited' || fb === 'stale') dock.push(row);", also: [] },
  { id: 'M-LO-order', file: 'derive', kills: ['LO2'],
    why: '失联的不往前排（按名字混进去）',
    from: 'const rank = (r) => (r.orch ? 0 : r.lost ? 1 : 2);', to: 'const rank = (r) => (r.orch ? 0 : 2);', also: [] },
  { id: 'M-CT-crew', file: 'derive', kills: ['CT1'],
    why: '把 agent 加进命令条的目标列表',
    from: "function cmdTargets({ orchName = 'JARVIS', rooms = [] /* , agents —— 故意不用 */ } = {}) {",
    to: "function cmdTargets({ orchName = 'JARVIS', rooms = [], agents = [] } = {}) {",
    also: [["      out.push({ kind: 'room', id: r.hash,", "      for (const n of agents) if (!out.some((x) => x.id === n)) out.push({ kind: 'dm', id: n, name: n, label: '@' + n });\n      out.push({ kind: 'room', id: r.hash,"]] },
  { id: 'M-CT-app-crew', file: 'app', kills: ['CT2'],
    why: 'app.js 那边把 agent 拼进目标表',
    from: 'return Derive.cmdTargets({ orchName: ORCH, rooms: cmdRooms() });',
    to: "return Derive.cmdTargets({ orchName: ORCH, rooms: cmdRooms() }).concat(agentNames.filter((n) => n !== ORCH).map((n) => ({ kind: 'dm', id: n, name: n, label: '@' + n })));", also: [] },
  { id: 'M-CT-guard', file: 'app', kills: ['CT2'],
    why: '去掉 cmdSend 里「不是编排者的私聊不发」那一道',
    from: "if (t.kind !== 'room' && t.id !== ORCH) {", to: 'if (false) {', also: [] },
  { id: 'M-CT-hint', file: 'derive', kills: ['CT3'],
    why: '焦点在 agent 时把目标说成那个 agent（提示写成「发给 dev」）',
    from: 'return `要给 ${focus} 派活，发给 ${orchName}`;', to: 'return `发给 ${focus}`;', also: [] },
  { id: 'M-ST-second', file: 'app', kills: ['ST1'],
    why: '命令条自己再写一份 POST /api/message',
    from: 'const r = await sendTo(t, text, { box });',
    to: "const r = await fetch('/api/message', { method: 'POST', body: JSON.stringify({ text }) }).then(() => ({ ok: true }));", also: [] },
  { id: 'M-ST-composer', file: 'app', kills: ['ST1'],
    why: 'composer 不走 sendTo（自己发房间那条）',
    from: 'const r = await sendTo(target, text, { replyTo: replyingTo, box });',
    to: "const r = await fetch(`/api/rooms/${encodeURIComponent(target.id)}/post`, { method: 'POST' }).then(() => ({ ok: true }));", also: [] },
  { id: 'M-MD-raw', file: 'app', kills: ['MD1'],
    why: '泳道正文直接塞 innerHTML（不转义）',
    from: 'tx.innerHTML = mdToHtml(e.text);', to: 'tx.innerHTML = e.text;', also: [] },
  { id: 'M-MD-own', file: 'app', kills: ['MD1'],
    why: '派活行另写一个渲染器',
    from: 'one.innerHTML = mdToHtml(first);', to: "one.innerHTML = first.replace(/`([^`]+)`/g, '<code>$1</code>');", also: [] },
  { id: 'M-LS-clear', file: 'app', kills: ['LS1'],
    why: '拉失败时清空旧内容',
    from: '    cur.error = String(e.message || e);\n    cur.errorDetail = e.detail || cur.error;',
    to: '    cur.rows = null;\n    cur.payload = null;\n    cur.error = String(e.message || e);\n    cur.errorDetail = e.detail || cur.error;', also: [] },
];

function envOf(deriveSrc, appSrc, cssSrc = CSS_SRC, threadsSrc = null) {
  const T = threadsSrc === null ? Threads : loadThreads(threadsSrc);
  return { D: loadDerive(deriveSrc, T), T, app: appSrc, css: cssSrc };
}
const safe = (fn, env) => { try { return fn(env) === true; } catch (_) { return false; } };

console.log('\n【1】原样的 derive.js / app.js：每条都绿');
const env0 = envOf(DERIVE_SRC, APP_SRC);
for (const c of CASES) ok(safe(c.run, env0), `${c.id} ${c.label}`);

console.log('\n【2】★★ 每个变异都让它点名的那几条变红（变异只在内存里做）');
const killedBy = new Map(CASES.map((c) => [c.id, []]));
for (const m of MUTATIONS) {
  const src = m.file === 'derive' ? DERIVE_SRC : m.file === 'css' ? CSS_SRC
    : m.file === 'threads' ? THREADS_SRC : APP_SRC;
  const edits = [[m.from, m.to], ...(m.also || [])];
  let mutated = src;
  let stale = null;
  for (const [a, b] of edits) {
    const n = mutated.split(a).length - 1;
    if (n !== 1) { stale = `「${a.slice(0, 50)}」在源码里出现 ${n} 次（要恰好 1 次）`; break; }
    mutated = mutated.replace(a, () => b);
  }
  if (stale) { ok(false, `${m.id}（${m.why}）—— 变异过期：${stale}`); continue; }
  let env;
  try {
    env = m.file === 'derive' ? envOf(mutated, APP_SRC)
      : m.file === 'css' ? envOf(DERIVE_SRC, APP_SRC, mutated)
        : m.file === 'threads' ? envOf(DERIVE_SRC, APP_SRC, CSS_SRC, mutated) : envOf(DERIVE_SRC, mutated);
  } catch (e) {
    ok(false, `${m.id}（${m.why}）—— 改过的源码加载不起来：${e.message}（一个语法错的变异什么都证明不了）`);
    continue;
  }
  for (const id of m.kills) {
    const c = CASES.find((x) => x.id === id);
    const red = !safe(c.run, env);
    if (red) killedBy.get(id).push(m.id);
    ok(red, `${m.id}（${m.why}）⇒ ${id} 变红`);
  }
}

console.log('\n【3】★★★ 覆盖：每一条断言都至少被一个变异杀死过');
for (const c of CASES) {
  const ks = killedBy.get(c.id);
  ok(ks.length > 0, `${c.id} 被 ${ks.length ? ks.join(', ') : '（没有任何变异）'} 杀死`);
}

console.log('\n【4】自检：变异装置本身认得出「没变」');
{
  // 阴性对照：一个什么都不改的「变异」不该让任何用例变红 —— 否则上面的红可能是装置自己造的
  const env = envOf(DERIVE_SRC.replace('const TASK_CHARS = 40;', () => 'const TASK_CHARS = 40;'), APP_SRC);
  ok(CASES.every((c) => safe(c.run, env)), '★ 恒等替换之后全部仍然绿（红不是加载装置造出来的）');
  ok(critFrom('no such thing') === null, '★ CRIT_LEVELS 读不到时返回 null（N2 不会在读失败时假绿）');
}

console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
