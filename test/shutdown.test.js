'use strict';

/**
 * 优雅关停测试。
 *
 * ── 这个功能的测试有个特殊难点 ──────────────────────────────────
 * 要测的是「agent 关停自己」，而跑测试的就是 agent。天真地测一下，
 * 测试就把自己杀了 —— 而且是在测试跑完之前，所以你连结果都看不到。
 *
 * 解法三条，缺一不可：
 *
 *   1. kill 是**注入**的。lib/shutdown.js 自己不 require tmux，杀谁由调用方给。
 *      测试传一个只记账的假 kill —— 于是测试进程里根本不存在能杀死
 *      任何东西的代码路径。这不是「小心不要杀」，是「想杀也杀不了」。
 *
 *   2. 时钟是**注入**的。超时逻辑收 now 参数，测试直接跳三分钟，
 *      不用真等，也就不需要在真实时间里维持一个待关停状态。
 *
 *   3. 真 tmux 只对**替身会话**验证。起一个跑 sleep 的一次性会话，
 *      对它走完整流程。它不是 agent，杀了没有代价。名字前缀写死成
 *      engloop_shutdown_test，测试里另有一条断言守着它不等于任何真实会话名。
 *
 * 另外：全程不碰 orch:* 和 agent:* 流。测试用 test:shutdown:in。
 * （relay.test.js 会 del orch:in:human —— 在活系统上跑那个是有代价的，
 *   这里不重蹈。）
 * ────────────────────────────────────────────────────────────────
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const tmux = require('../lib/tmux');
const { startRelay } = require('../lib/relay');
const sd = require('../lib/shutdown');

const S = sd.SENTINEL;
const TEST_AGENT = 'shutdowntestcrew';
const TEST_STREAM = 'test:shutdown:in';
const TEST_SESSION = 'engloop_shutdown_test';

// 真实会话名，测试绝不能碰
const REAL_SESSIONS = ['orch', 'agent_dev', 'agent_test'];

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 只记账、不杀任何东西的假 kill。
 *
 * `exists` 的用途：kill 之后要**回查事实**，不拿命令返回值当结果。
 * 默认回查为 false = 「杀掉之后会话确实没了」，即正常路径。
 * 想模拟「kill 说成功但会话还在」，构造时传 `{ stillThere: true }`。
 */
function fakeKiller({ stillThere = false } = {}) {
  const killed = [];
  return {
    killed,
    kill: async (session) => { killed.push(session); return true; },
    exists: async () => stillThere,
  };
}

async function drain(redis, stream) {
  const res = await redis.xrange(stream, '-', '+');
  return res.map(([, f]) => {
    const o = {};
    for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1];
    return o;
  });
}

async function main() {
  console.log('\n【0】测试自身的安全护栏');
  ok(!REAL_SESSIONS.includes(TEST_SESSION), `替身会话名 ${TEST_SESSION} 不是任何真实会话`);
  ok(!TEST_STREAM.startsWith('orch:') && !TEST_STREAM.startsWith('agent:'), '测试流不碰生产流');
  ok(!['JARVIS', 'dev', 'test'].includes(TEST_AGENT), '测试 agent 名不与真实 agent 撞名');
  {
    // lib/shutdown.js 不 require tmux —— 结构上就无法自己杀东西
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'shutdown.js'), 'utf8');
    ok(!/require\(['"]\.\/tmux['"]\)/.test(src), 'shutdown.js 不 require tmux（kill 必须注入）');
  }

  console.log('\n【1】★ 破坏性信号只认开头');
  ok(sd.classify(`${S} 我处理完了，走了`) === 'ready', '开头出现 → ready');
  ok(sd.classify(S) === 'ready', '整条就是 token → ready');
  ok(sd.classify(`\n\n  ${S}`) === 'ready', '前面只有空白 → 仍然 ready');
  ok(sd.classify('none of this matters') === 'none', '不含 token → none');
  ok(sd.classify('') === 'none', '空字符串 → none');
  ok(sd.classify(undefined) === 'none', 'undefined 不抛错');

  console.log('\n【2】★ 自我指涉不能自杀（谈论 token 不等于发出 token）');
  ok(sd.classify(`我做完后会发 ${S}`) === 'mid_message', '叙述意图 ≠ 执行意图');
  ok(sd.classify(`收到，稍后发 ${S}。现在开始跑测试。`) === 'mid_message', '句中出现不触发');
  ok(sd.classify(`用 includes 判定的话，"${S}" 出现在引号里也会中招`) === 'mid_message', '引号里也只是 mid_message');
  // ↓ 这两条是关键：协议自己的文本里就含 token，用 includes 会当场自锁
  ok(sd.classify(sd.correctionText()) === 'mid_message', '纠正消息本身不触发关停');
  ok(sd.classify(`SHUTDOWN_REQUEST 请你发 ${S}`) === 'mid_message', '关停请求文本不触发关停');
  ok(sd.classify(`ready_to_shutdown 小写`) === 'none', '小写不算（更可能是在讨论它）');

  console.log('\n【3】记账器：正常路径（kill 是假的，杀不到东西）');
  {
    const { killed, kill, exists } = fakeKiller();
    const t = sd.createTracker({ kill, exists });
    t.request(TEST_AGENT, TEST_SESSION, { now: 0 });
    ok(t.isPending(TEST_AGENT), '请求后进入 pending');
    ok(killed.length === 0, '只是请求，还没杀');
    const r = await t.ready(TEST_AGENT);
    ok(r?.outcome === 'graceful', '收到就绪 → graceful');
    ok(killed[0] === TEST_SESSION, '杀的是请求过的那个会话');
    ok(!t.isPending(TEST_AGENT), '结束后移出 pending');
  }

  console.log('\n【4】★ 没请求过就发就绪信号 → 不杀（只动被点名的）');
  {
    const { killed, kill, exists } = fakeKiller();
    const t = sd.createTracker({ kill, exists });
    const r = await t.ready('someRandomAgent');
    ok(r === null, '未请求的 ready 返回 null');
    ok(killed.length === 0, '一个都没杀 —— 防连锁关停');
  }

  console.log('\n【5】超时：静默判定（假时钟，不真等 3 分钟）');
  {
    const { killed, kill, exists } = fakeKiller();
    const t = sd.createTracker({ kill, exists, quietMs: 180_000, hardMs: 600_000 });
    t.request(TEST_AGENT, TEST_SESSION, { now: 0 });

    ok((await t.tick({ now: 179_000 })).length === 0, '静默 179s 还不杀');
    const out = await t.tick({ now: 181_000 });
    ok(out.length === 1 && out[0].outcome === 'timeout', '静默 181s → 超时杀');
    ok(/静默/.test(out[0].detail), '记录了是超时杀的，且说明原因');
    ok(killed[0] === TEST_SESSION, '杀的仍是被点名的那个');
  }

  console.log('\n【6】★ 忙 ≠ 聋：有活动就不该被杀');
  {
    const { killed, kill, exists } = fakeKiller();
    const t = sd.createTracker({ kill, exists, quietMs: 180_000, hardMs: 600_000 });
    t.request(TEST_AGENT, TEST_SESSION, { now: 0 });
    // 模拟一个守协议的忙碌 agent：每 2 分钟发一次进度
    for (const at of [120_000, 240_000, 360_000, 480_000]) {
      t.activity(TEST_AGENT, { now: at });
      ok((await t.tick({ now: at + 1000 })).length === 0, `${at / 1000}s 有活动 → 不杀`);
    }
    ok(killed.length === 0, '整个过程一次都没杀（它在干活，不是卡死）');

    // 但硬上限必须兜住「一直发消息就是不停」的病
    t.activity(TEST_AGENT, { now: 599_000 });
    const out = await t.tick({ now: 601_000 });
    ok(out.length === 1 && /不肯停/.test(out[0].detail), '硬上限到了照杀，且说明是有活动但不停');
  }

  console.log('\n【7】relay 端到端：真文件 → 真流 → 事件（仍然不杀东西）');
  const redis = q.createClient();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-shutdown-'));
  await redis.del(TEST_STREAM);
  await roster.register(redis, TEST_AGENT, {
    type: 'dev', stream: TEST_STREAM, tmux_session: TEST_SESSION,
  }, 60);

  const events = [];
  const relay = startRelay({
    outboxDir: dir, from: TEST_AGENT, redis, ackGroup: `agent:${TEST_AGENT}`,
    onEvent: (e) => events.push(e),
  });

  // 7a：中间出现 token → 投递照常 + 回弹纠正 + 不触发关停
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({
    username: TEST_AGENT, text: `任务收到，做完我会发 ${S}`,
  }));
  await wait(500);
  ok(events.some((e) => e.type === 'relayed'), '原消息照常投递（不因为含 token 就吞掉）');
  ok(events.some((e) => e.type === 'sentinel_misplaced'), '触发 sentinel_misplaced');
  ok(!events.some((e) => e.type === 'shutdown_ready'), '★ 没有触发 shutdown_ready');
  {
    const got = await drain(redis, TEST_STREAM);
    const bounce = got.filter((m) => m.text?.startsWith('SENTINEL_MISPLACED'));
    ok(bounce.length === 1, '回弹了一条纠正给发送方');
    ok(bounce[0].from === 'bus', '纠正来自 bus');
    ok(sd.classify(bounce[0].text) === 'mid_message', '★ 纠正消息自身不会引发第二次关停判定');
  }

  // 7b：开头出现 → 先投递 + ack，再触发就绪
  events.length = 0;
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({
    username: 'Patrick', text: `${S} 手上的活收尾完毕，ack 已发，停止轮询。`,
  }));
  await wait(500);
  const iRelayed = events.findIndex((e) => e.type === 'relayed');
  const iReady = events.findIndex((e) => e.type === 'shutdown_ready');
  ok(iReady > -1, '触发 shutdown_ready');
  ok(iRelayed > -1 && iRelayed < iReady, '★ 先把临终消息投出去，再报告就绪（不能先杀后投）');
  ok(events[iReady].name === TEST_AGENT, '报告的是发送者本人（from 由目录推断，伪造不了）');

  relay.stop();

  console.log('\n【8】真 tmux：只对替身会话验证注入点接得对');
  await tmux.kill(TEST_SESSION);
  await tmux.spawn(TEST_SESSION, { cwd: process.cwd(), command: 'bash -c "sleep 120"' });
  ok(await tmux.exists(TEST_SESSION), '替身会话已起（它不是 agent，杀了没有代价）');
  {
    const t = sd.createTracker({ kill: (s) => tmux.kill(s), exists: (s) => tmux.exists(s) });   // ← 这里才是真 kill
    t.request(TEST_AGENT, TEST_SESSION);
    const r = await t.ready(TEST_AGENT);
    ok(r?.killed === true, '真的把替身会话杀掉了');
    ok(!(await tmux.exists(TEST_SESSION)), '会话确实没了 —— 注入点接对了');
  }
  for (const s of REAL_SESSIONS) {
    // 上面全程只可能杀 TEST_SESSION；这条守着「没有误伤」这件事本身
    ok(s !== TEST_SESSION, `全程未把 ${s} 作为目标`);
  }

  console.log('\n【9】requestShutdown 写进流的内容');
  await redis.del(TEST_STREAM);
  await sd.requestShutdown(redis, TEST_AGENT, { reason: '测试' });
  {
    const got = await drain(redis, TEST_STREAM);
    ok(got.length === 1, '请求进了 agent 的收件流');
    ok(got[0].text.startsWith('SHUTDOWN_REQUEST'), '开头是 SHUTDOWN_REQUEST');
    ok(got[0].text.includes(S), '正文告诉它该发什么 token');
    ok(sd.classify(got[0].text) !== 'ready', '★ 请求文本自身不是 ready（否则 bus 自锁）');
    ok(got[0].text.includes('不要再运行 next.js'), '明确说了停止轮询');
    // 意图必须完整落在 text 里 —— next.js 的 stdout 不透传 agent_type
    ok(/1\.[\s\S]*2\.[\s\S]*3\.[\s\S]*4\./.test(got[0].text), '四步顺序写在正文里（大脑只看得到 text）');
  }
  let threw = null;
  await sd.requestShutdown(redis, 'nobody-here').catch((e) => { threw = e; });
  ok(threw && /不在花名册/.test(threw.message), '不在册的 agent → 抛错而不是往空处发');

  // ───────────────────────────────────────────────────────────────
  console.log('\n【10】★★ 会话标识：一条关停指令针对的是哪个会话实例');
  {
    // 防的是这件事：agent 从流里领到一条**好几天前**的 SHUTDOWN_REQUEST，
    // 把一个刚起的新会话关掉，零报错。
    // 根因是消费者组的 last-delivered-id 跨会话持久，而会话是短暂的。
    const F = sd.SESSION_FIELD;
    const MINE = 1786746447;      // 收件方当前会话的 created（tmux 的真实量级）
    const THEIRS = 1786393909;    // 上一个会话的

    // ── 四档判定 ──
    ok(sd.classifyTarget({ [F]: String(MINE) }, MINE) === 'match',
      '① 标识对得上 → match');
    ok(sd.classifyTarget({ [F]: String(THEIRS) }, MINE) === 'mismatch',
      '② 标识对不上 → mismatch（这就是 dev2 那条 4 天前的指令）');
    ok(sd.classifyTarget({}, MINE) === 'unstamped',
      '③ 没带标识（老指令）→ unstamped');
    ok(sd.classifyTarget({ [F]: String(THEIRS) }, null) === 'unverifiable',
      '④ 我拿不到自己的标识 → unverifiable（检查器坏了，不是「不匹配」）');

    // ★★ 顺序判据：**先判「验不了」再判「它没带」**。
    //   反过来的话，一条老指令在 tmux 故障时会被判成 unstamped 并拒绝 ——
    //   那个拒绝是**碰巧对**的（收件方那时根本没能力判断），而碰巧对和对
    //   混在一起，下次就分不清了。
    ok(sd.classifyTarget({}, null) === 'unverifiable',
      '★★ 既没带标识、我也验不了 → unverifiable（不是 unstamped）');

    // ★ 空串不算「盖过章」。填了假值的字段比没有这个字段更坏 ——
    //   它会被当成盖过章的，然后拿空串去比对，永远 mismatch。
    ok(sd.classifyTarget({ [F]: '' }, MINE) === 'unstamped',
      '★ 空字符串标识 → 当成没盖章，不是 mismatch');

    // ★ 类型：redis 里所有字段都是**字符串**，比对必须跨类型成立。
    ok(sd.classifyTarget({ [F]: String(MINE) }, MINE) === 'match'
      && sd.classifyTarget({ [F]: MINE }, MINE) === 'match',
      '★ 字符串和数字都比得对 —— redis 存的是字符串');

    // ── 措辞 ──
    const unver = sd.targetAlertText('unverifiable');
    ok(unver.includes('没有被验证'), '★★ unverifiable 的文案说的是「没有被验证」');
    ok(!unver.includes('已放行'),
      '★★★ **不许出现「已放行」** —— 那听起来像一个正常结果，'
      + '于是没人会去修那个坏掉的检查器');
    const mis = sd.targetAlertText('mismatch', { mine: MINE, theirs: THEIRS });
    ok(mis.includes(String(THEIRS)) && mis.includes(String(MINE)),
      '★ mismatch 的文案把两个值都摆出来 —— 人要能自己核对');
    ok(mis.includes('不要执行'), '★ 而且明说「不要执行」');
    ok(sd.targetAlertText('match') === null,
      '★ 正控：match 不产生任何告警 —— 上面几条不是「对什么都报」');

    // ── 发起侧：盖章 / 不盖章 ──
    const stamped = await sd.requestShutdown(redis, TEST_AGENT, {
      stream: TEST_STREAM, reason: '会话标识测试', targetSessionCreated: MINE,
    });
    ok(stamped.stamped === true, '发起侧拿到 created → 盖章');

    const unstamped = await sd.requestShutdown(redis, TEST_AGENT, {
      stream: TEST_STREAM, reason: '会话标识测试（查不到 created）',
    });
    ok(unstamped.stamped === false, '★ 拿不到 created → 照发但不盖章，并如实报告');

    // ★★ 端到端：字段真的进了流吗。
    //   「requestShutdown 返回 stamped:true」和「流里那条真的带着这个字段」
    //   是两件事（一个函数写好了，不等于有调用方）。所以这里去流里读回来。
    const rows = await redis.xrevrange(TEST_STREAM, '+', '-', 'COUNT', 2);
    const flat = rows.map(([, f]) => {
      const o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1]; return o;
    });
    const withStamp = flat.find((o) => o[F] != null);
    const without = flat.find((o) => o[F] == null);
    ok(withStamp && String(withStamp[F]) === String(MINE),
      '★★ 盖章那条**真的把字段写进了流**（不是只在返回值里）',
      JSON.stringify(withStamp && withStamp[F]));
    ok(without !== undefined,
      '★ 阴性对照：没盖章那条流里**确实没有**这个字段 —— 不是每条都被加上');

    // ★★★ 把两端接起来：从流里读回来的那条，判定必须是 match。
    //   这一条才是「发起侧和收取侧对得上」的证据 —— 前面那些各测各的。
    ok(sd.classifyTarget(withStamp, MINE) === 'match',
      '★★★ 流里读回来的那条 → classifyTarget 判 match（两侧真的对得上）');
    ok(sd.classifyTarget(withStamp, THEIRS) === 'mismatch',
      '★★★ 阴性对照：换一个会话去读同一条 → mismatch（否则它对谁都 match）');

    // ★★★ 调用方真的传了吗 —— 「参数收了、没人传」是常见形状
    //   （`runPrint` 收 allowedTools 也是这个形状）。
    //   `requestShutdown` 支持这个参数 ≠ 有人传它。不传 = 永远不盖章
    //   = 这一整套判定是死代码，**而单元测试照样全绿**（上面那些都是
    //     测试自己传参数调的）。
    //   ⚠️ 源码断言是弱证据，但 `bin/serve.js` 测试 require 不了（一 require
    //     就起服务占端口），这是唯一能守住它的位置。
    {
      const serveSrc = fs.readFileSync(path.join(__dirname, '..', 'bin', 'serve.js'), 'utf8');
      ok(/targetSessionCreated,?\s*\n?\s*\}\)/.test(serveSrc)
        || serveSrc.includes('targetSessionCreated,'),
        '★★★ bin/serve.js 真的把 targetSessionCreated 传进去了（否则整套判定是死代码）');
      ok(serveSrc.includes('tmux.list()'),
        '★ 而且它真的去查了 tmux 的 created —— 不是传了个 null 应付');
      ok(!serveSrc.includes('targetSessionCreatedNopeDoesNotExist'),
        '★ 自检：不存在的串确实查不到 —— 上面两条不是恒真');
    }
  }

  // 清理。
  // orch:out 也要收 —— 7b 那条发给 Patrick 的消息（不在册 → 走出向流）
  // 会留在测试库里，下一轮别的测试如果断言 orch:out 的条数就会莫名其妙地红。
  // 测试库是共享的，谁弄脏谁擦干净。
  await roster.unregister(redis, TEST_AGENT);
  await redis.del(TEST_STREAM, 'orch:out');
  await redis.quit();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('✗ 异常:', e.stack || e.message);
  await tmux.kill(TEST_SESSION).catch(() => {});
  process.exit(1);
});
