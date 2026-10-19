'use strict';

/**
 * `GET /api/messages?to=<name>` —— 私聊历史。
 *
 * ── 这个端点的用途定死了它的验收标准 ────────────────────────────
 * 用途是「**某个 agent 掉册时，停摆期间发给它的消息去哪了**」。
 * 所以这个文件里最重的两条是：
 *
 *   ①  **不在花名册的名字照样查得到** —— 掉册的那个恰恰是最该查的那个。
 *       「不在册 → 空列表」会让这个端点在它唯一的用途上失效，
 *       **而且失效得像「查过了，没有消息」。**
 *
 *   ②  **一个源查不了就整体 503，不返回一半** —— 缺一半的历史长成
 *       「它收到 12 条、一条都没发过」，**而那恰好是单向失聪的样子**。
 *       一份不完整的复盘会把人引向相反的结论，比没有结果更坏。
 *
 * 跟 room-console-api 一样：起自己的 express app 打真 HTTP，
 * **不起真 bus**（bus 一起来 watchdog 会对着真 agent 发恢复指令）。
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const messages = require('../lib/messages');

const AGENT = 'msgtestcrew';
const IN = `agent:${AGENT}:in`;
const ORCH_IN_CREW = 'orch:in:agent';

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

function serve(redis) {
  const app = express();
  app.get('/api/messages', messages.handler(redis));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function main() {
  const redis = q.createClient();
  await redis.del(IN, ORCH_IN_CREW);
  await roster.unregister(redis, AGENT).catch(() => {});

  // 造历史：两条发给它的，一条它发出的，交替时间
  await q.send(redis, IN, { from: 'JARVIS', to: AGENT, text: '第一条：派活', agent_type: 'dev' });
  await new Promise((r) => setTimeout(r, 5));
  await q.send(redis, ORCH_IN_CREW, { from: AGENT, to: 'JARVIS', text: '第二条：我的回复', agent_type: 'dev' });
  await new Promise((r) => setTimeout(r, 5));
  await q.send(redis, IN, { from: 'JARVIS', to: AGENT, text: '第三条：再派一件', agent_type: 'dev' });
  // 噪音：别的 agent 发给编排者的，不该出现在 AGENT 的历史里
  await q.send(redis, ORCH_IN_CREW, { from: 'someoneelse', to: 'JARVIS', text: '不相干', agent_type: 'dev' });

  const app = await serve(redis);

  console.log('\n【1】★ 合并两条流，按时间正序');
  {
    const r = await fetch(`${app.base}/api/messages?to=${AGENT}`);
    const b = await r.json();
    ok(r.status === 200, `200（实际 ${r.status}）`, JSON.stringify(b).slice(0, 300));
    ok(b.messages.length === 3, '三条（收 2 + 发 1）',
      JSON.stringify(b.messages?.map((m) => m.text)));
    ok(b.messages[0].text === '第一条：派活'
       && b.messages[1].text === '第二条：我的回复'
       && b.messages[2].text === '第三条：再派一件',
      '★★ 按时间交错排序 —— 两条流合并，顺序是「谁先说的」',
      JSON.stringify(b.messages?.map((m) => m.text)));
    ok(!b.messages.some((m) => m.text === '不相干'),
      '★ 别人发给编排者的没混进来（orch:in:agent 是所有 agent 共用的）');
  }

  console.log('\n【2】★ direction：收 / 发要分得开');
  {
    const b = await (await fetch(`${app.base}/api/messages?to=${AGENT}`)).json();
    const dirs = b.messages.map((m) => m.direction);
    ok(dirs[0] === 'in' && dirs[1] === 'out' && dirs[2] === 'in',
      '★★ 每条带 direction —— 复盘问的就是「发给它的」和「它发出的」哪个断了',
      JSON.stringify(dirs));
    ok(b.messages.every((m) => typeof m.stream === 'string'),
      '★ 每条带来源流名 —— 说得出这条是从哪读出来的');
  }

  console.log('\n【3】★★ 不在花名册照样查得到 —— 这是这个端点的全部用途');
  {
    // ── 掉册的那个恰恰是最该查的那个 ────────────────────────────────
    // 「不在册 → 空列表」会让这个端点在它唯一的用途上失效，
    // 而且失效得像「查过了，没有消息」。
    ok(await roster.lookup(redis, AGENT) === null,
      `（前置）${AGENT} 确实不在花名册`);

    const b = await (await fetch(`${app.base}/api/messages?to=${AGENT}`)).json();
    ok(b.messages.length === 3,
      '★★ 不在册，三条历史照样查得到',
      `实际 ${b.messages.length} 条`);
    ok(b.registered === false,
      '★★ 但明确标出「不在册」—— 那是复盘线索，不是准入判据',
      JSON.stringify(b.registered));

    // ★ 阴性对照：在册时 registered 必须是 true。
    //   缺了它，一个「永远返回 false」的实现也能过上面那条。
    await roster.register(redis, AGENT, { type: 'dev', stream: IN }, 120);
    const b2 = await (await fetch(`${app.base}/api/messages?to=${AGENT}`)).json();
    ok(b2.registered === true, '★ （阴性对照）在册时 registered=true');
    ok(b2.type === 'dev', '★ 在册时带上 type');
    ok(b2.messages.length === 3, '★ 在册时查到的是同一批 —— 在不在册不影响读流');
    await roster.unregister(redis, AGENT);
  }

  console.log('\n【4】★★ sources：覆盖范围必须可见');
  {
    // ── 这个端点天然查不全 ──────────────────────────────────────────
    // 「它发出的」只覆盖发给编排者的那部分。它发给**另一个 agent** 的消息
    // 由 relay 直接投进对方的收件流，不经过这里。
    // 不说出来的话，人会把「结果里没有」读成「它没发过」——
    // 而这个端点的读者正在复盘一次事故，那种误读的代价是查错方向。
    const b = await (await fetch(`${app.base}/api/messages?to=${AGENT}`)).json();
    // ⚠️ 这里是 4 条不是 2 条，**因为 AGENT 没注册进花名册**（本测试从没注册它）。
    //   不在册的名字可能是掉册的 agent、也可能是人，两者在花名册里长得一模一样 ——
    //   所以 agent 那两条流之外，人那两条（orch:in:human / orch:out）也一起查。
    //   见 lib/messages.js 的 sourcesFor：不这么做的话 `?to=Patrick` 会返回 0 条，
    //   而这个端点的文件头自己写着「不在册不能返回空」。
    ok(Array.isArray(b.sources) && b.sources.length === 4,
      '★ 列出了实际查的全部四条流（不在册 ⇒ agent 两条 + 人两条）', JSON.stringify(b.sources));
    ok(b.sources.some((s) => s.stream === IN && s.direction === 'in' && s.matched === 2),
      '★ 收件流查到 2 条', JSON.stringify(b.sources));
    ok(b.sources.some((s) => s.stream === ORCH_IN_CREW && s.direction === 'out'
                          && s.filtered_by_from === AGENT && s.matched === 1),
      '★★ 发出那条流标明了「按 from 过滤」—— 它是所有 agent 共用的，不说等于漏了个前提',
      JSON.stringify(b.sources));
    ok(/其它 agent/.test(b.coverage_note || ''),
      '★★ 明说了「发给其它 agent 的不在这里」—— 沉默的缺口会被读成「没有」',
      JSON.stringify(b.coverage_note));

    // ★★ 说清缺口**还不够**，人接着要问「那去哪查」。
    //   而这个缺口有一个干净的出口：那些消息在对方的收件流里，
    //   也就是用**对方的名字**再查一次这个端点。
    //   不给出口的话，人会把「查不到」当成「没发生」—— 诚实但无用。
    ok(/api\/messages\?to=/.test(b.coverage_next || ''),
      '★★ 缺口配了真出口：用对方的名字再查一次',
      JSON.stringify(b.coverage_next));
    ok(/direction=in/.test(b.coverage_next || ''),
      '★ 而且说清在那边长什么样（会以 direction=in 出现）',
      JSON.stringify(b.coverage_next));
  }

  console.log('\n【5】★ 编排者的流不一样，不能拿 agent 那套削一截凑');
  {
    const srcs = messages.sourcesFor('JARVIS', 'orchestrator');
    const names = srcs.map((s) => s.stream);
    ok(names.includes('orch:in:human') && names.includes('orch:in:agent'),
      '★ 编排者收件是两条（人发的 + agent 发的）', JSON.stringify(names));
    ok(names.includes('orch:out'), '★ 发出走 orch:out');
    ok(!names.includes('agent:JARVIS:in'),
      '★★ **不是** agent:JARVIS:in —— 那是个没有消费者的黑洞流（roster.js 记着这颗雷）',
      JSON.stringify(names));

    // ★ 不在册时按名字猜。猜错会返回空，所以流名必须出现在响应里（【4】守着）。
    const guessed = messages.sourcesFor('JARVIS', null).map((s) => s.stream);
    ok(guessed.includes('orch:out'),
      '★ 不在册时 JARVIS 仍被当成编排者 —— 而它掉册恰恰是最该查的时候');
    const crew = messages.sourcesFor('dev', null).map((s) => s.stream);
    ok(crew.includes('agent:dev:in') && crew.includes('orch:in:agent'),
      '★ 阴性对照：别的名字当 agent 处理', JSON.stringify(crew));
  }

  console.log('\n【6】★ count');
  {
    const b = await (await fetch(`${app.base}/api/messages?to=${AGENT}&count=2`)).json();
    ok(b.messages.length === 2, 'count=2 → 两条');
    ok(b.messages[1].text === '第三条：再派一件',
      '★ 取的是**最近**两条', JSON.stringify(b.messages.map((m) => m.text)));
    ok(messages.parseCount('99999999') === messages.COUNT_MAX,
      '★ 上限跟 rooms 那边一样 —— 一个 URL 不该能让 bus 卡住');
    ok(messages.parseCount('abc') === messages.COUNT_DEFAULT, '非法值回落默认');
  }

  console.log('\n【7】★ 没给 to → 400，说得出该怎么写');
  {
    const r = await fetch(`${app.base}/api/messages`);
    ok(r.status === 400, `400（实际 ${r.status}）`);
    const b = await r.json();
    ok(/api\/messages\?to=/.test(b.message || ''),
      '★ 报错里给出正确写法（收到 400 的人要的是下一步动作，不是一个诊断）',
      JSON.stringify(b));
  }

  console.log('\n【8】★★ 一个源查不了 → 整体 503，绝不返回一半');
  {
    // ── 为什么部分结果比没有结果更坏 ────────────────────────────────
    // `orch:in:agent` 挂了而收件流没挂时，返回的结果长成
    // 「它收到 12 条、一条都没发过」—— **而那恰好是单向失聪的样子**
    // （收得到，发出去没人捡，它自己不知道）。
    // 人会据此断定「它没在回话」，而真相是「查不到它有没有回话」。
    const dead = q.createClient({ lazyConnect: true });
    dead.status = 'end';
    const bad = await serve(dead);
    const r = await fetch(`${bad.base}/api/messages?to=${AGENT}`);
    const b = await r.json();
    ok(r.status === 503, `★★ 503（实际 ${r.status}）`, JSON.stringify(b).slice(0, 200));
    ok(b.messages === undefined,
      '★★ 没有 messages 字段 —— 半份历史会让复盘得出相反的结论',
      JSON.stringify(b).slice(0, 200));
    await bad.close();
    dead.disconnect();

    // ★★ 真正的那一半：**只有一个源坏**。上面那种是两个都坏，
    //   而「两个都坏」任何实现都会失败 —— 它证不了「部分失败也拒绝」。
    //   这里用一个只对特定流抛错的假 redis，造出真正的部分失败。
    const half = {
      xrevrange: async (stream) => {
        if (stream === ORCH_IN_CREW) throw new Error('模拟：这条流查不了');
        return [];
      },
    };
    let thrown = null;
    try {
      await messages.historyPayload(half, AGENT, 50, { registry: null });
    } catch (e) { thrown = e; }
    ok(thrown !== null,
      '★★ 只有一个源坏（另一个正常返回空）→ 照样抛，不返回那份空的',
      '没抛 = 会把「查不了」降级成「没有消息」');
    ok(thrown?.code === messages.PARTIAL_UNAVAILABLE,
      '★ 带专用 code，跟「整个 redis 挂了」分得开', `实际 ${thrown?.code}`);
    ok(new RegExp(ORCH_IN_CREW).test(thrown?.message || ''),
      '★★ 错误里点名了**是哪条流** —— 「有一部分查不了」不说是哪部分等于没说',
      JSON.stringify(thrown?.message));

    const { status, body } = messages.httpError(thrown);
    ok(status === 503 && body.error === messages.PARTIAL_UNAVAILABLE,
      '★ httpError 翻成 503 + 专用 error 码', JSON.stringify(body).slice(0, 150));
    ok(/不是「没有消息」/.test(body.detail || ''),
      '★★ 响应里明说这不是「没有消息」—— 读的人正在复盘，那个区别就是结论本身',
      JSON.stringify(body.detail));

    // ★★ 这个端点的读者**正在复盘一次事故**，而复盘时最危险的动作
    //   是拿着半份数据往下推。所以出口的第一句必须是「别下结论」。
    ok(/别拿这次的结果下任何结论/.test(body.next || ''),
      '★★ 出口第一句就是「先别下结论」—— 对复盘的人，这比任何诊断都重要',
      JSON.stringify(body.next));
    ok(/api\/agents/.test(body.next || ''),
      '★ 并指向另一个独立信号源（/api/agents 看它现在在不在线）',
      JSON.stringify(body.next));
  }

  await app.close();

  console.log('\n【9】★ 接线：serve.js 真的挂了这个路由');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'serve.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(/app\.get\(\s*['"`]\/api\/messages['"`]/.test(code),
      '★★ 路由挂上了 —— handler 写得再对，没挂就是 404 Cannot GET',
      (code.match(/.*api\/messages.*/g) || []).join(' | '));
    ok(/messages\.handler\(\s*redis\s*\)/.test(code),
      '★★ 用的是 lib 里那个被测过的 handler，不是在回调里又实现一遍',
      (code.match(/.*messages\.handler.*/g) || []).join(' | '));
    ok(/require\(['"`]\.\.\/lib\/messages['"`]\)/.test(code),
      '★ 而且真的 require 了它');
  }

  console.log('\n【10】★★★ 私聊 thread 的锚点：为什么必须是 job_id 而不是 stream id');
  {
    // ── 这一节证明的是一件**关于数据本身**的事，不是关于某段代码 ──────
    //   `/api/messages` 把**两条流合并**成一个列表（这个文件【1】验过）。
    //   前端要在这个列表里按 `reply_to` 找父消息 —— 那就要求每条有一个
    //   **在合并后仍然唯一**的 id。
    //
    //   ★ 下面用**显式 stream id** 往两条流各写一条（redis 允许指定 id）。
    //     这不是「构造一个巧合」——它把一个 42.5% 的概率事件变成确定事件，
    //     好让这条断言**每次都跑得到**。「尚未发生」和「不会发生」是两件事。
    await redis.del(IN, ORCH_IN_CREW);
    const SAME = '9999999999999-0';   // 两条流用同一个 id
    const ts = new Date(9999999999999).toISOString();
    await redis.xadd(IN, SAME, 'from', 'JARVIS', 'to', AGENT, 'text', '同 id 甲',
      'agent_type', 'dev', 'timestamp', ts, 'job_id', 'job-AAA');
    await redis.xadd(ORCH_IN_CREW, SAME, 'from', AGENT, 'to', 'JARVIS', 'text', '同 id 乙',
      'agent_type', 'dev', 'timestamp', ts, 'job_id', 'job-BBB', 'reply_to', 'job-AAA');

    const app2 = await serve(redis);
    const b = await (await fetch(`${app2.base}/api/messages?to=${AGENT}`)).json();
    await app2.close();

    const rows = b.messages || [];
    ok(rows.length === 2, '（前置）两条都读出来了', JSON.stringify(rows.map((m) => m.text)));
    // ★★★ 决定性的一条：合并之后 stream id **不唯一**
    ok(rows.length === 2 && rows[0].id === rows[1].id,
      '★★★ 两条不同的消息在合并列表里有**相同的 stream id** —— '
      + '拿它当 thread 锚点，回复会挂到错的那条上，而且零报错',
      JSON.stringify(rows.map((m) => m.id)));
    // ★★★ 而 job_id 唯一 —— 这就是选它的全部理由
    ok(rows.length === 2 && rows[0].job_id !== rows[1].job_id,
      '★★★ 同一批数据里 job_id 是不同的 —— 锚点选它，这一类问题不存在',
      JSON.stringify(rows.map((m) => m.job_id)));
    ok(rows.every((m) => typeof m.job_id === 'string' && m.job_id),
      '★★ 每条都带 job_id —— 前端拿它当锚点的前提');
    // reply_to 要能一路读出来（前端靠它认父子）
    const child = rows.find((m) => m.text === '同 id 乙');
    ok(child && child.reply_to === 'job-AAA',
      '★★ reply_to 原样读得出来，且指向的是**父的 job_id**',
      JSON.stringify(child && child.reply_to));
    // 阴性对照：确认上面那条 id 相等不是「所有字段都相等」那种平凡成立
    ok(rows[0].text !== rows[1].text,
      '★ 阴性对照：两条的正文不同 —— id 相等是真碰撞，不是同一条被读了两遍');

    await redis.del(IN, ORCH_IN_CREW);
  }

  console.log('\n【11】★★ 查一个「人」的名字 —— 不能静默返回空');
  {
    // ── 查「人」的历史 ──────────────────────────────────────────────
    //   按 agent 约定推出来的 `agent:Patrick:in` 根本不存在（Patrick 是人），
    //   只查它的话 `GET /api/messages?to=Patrick` 会返回 **0 条**。
    //   人的消息在 `orch:in:human`（他发的）和 `orch:out`（发给他的）。
    //
    //   ⚠️ 文件头那条①写着「不在册不能返回空，掉册的那个恰恰最该查」——
    //   对「人」这个身份同样成立，否则失效得像「查过了，没有消息」。
    const HUMAN = 'msgtesthuman';
    const IN_HUMAN = 'orch:in:human';
    const OUT = 'orch:out';
    // ⚠️ 上面那个 app 在【8】末尾就 close 了，这里得自己起一个。
    const app3 = await serve(redis);
    await redis.del(IN_HUMAN, OUT);
    await q.send(redis, IN_HUMAN, { from: HUMAN, to: 'JARVIS', text: '人说的话' });
    await new Promise((r) => setTimeout(r, 5));
    await q.send(redis, OUT, { from: 'JARVIS', to: HUMAN, text: '编排者回他的' });
    // 噪音：发给**别人**的，不该出现在他的历史里
    await q.send(redis, OUT, { from: 'JARVIS', to: 'someoneelse', text: '不相干' });

    const b = await (await fetch(`${app3.base}/api/messages?to=${HUMAN}`)).json();
    ok(b.messages.length === 2, '★★ 查得到 2 条（不是 0）',
      JSON.stringify(b.messages.map((m) => m.text)));
    ok(b.messages.some((m) => m.text === '人说的话' && m.direction === 'out'),
      '★ 他发出的那条，direction=out');
    ok(b.messages.some((m) => m.text === '编排者回他的' && m.direction === 'in'),
      '★ 发给他的那条，direction=in');
    ok(!b.messages.some((m) => m.text === '不相干'),
      '★★ 阴性对照：发给别人的不混进来 —— orch:out 是所有人共用的一条流，'
      + '不按 to 过滤的话会把整个系统的出站消息都倒给他');

    const outSrc = b.sources.find((s) => s.stream === OUT);
    ok(outSrc && outSrc.filtered_by_to === HUMAN,
      '★★ sources 里标明 orch:out 是按 **to** 过滤的 —— '
      + '塞进 filtered_by_from 的话，读的人会以为查的是他发出的消息',
      JSON.stringify(outSrc));
    ok(outSrc && outSrc.filtered_by_from === null,
      '★ 而 filtered_by_from 保持 null，两件事不共用一个名字');

    await redis.del(IN_HUMAN, OUT);
    await app3.close();
  }

  await redis.del(IN, ORCH_IN_CREW);
  await roster.unregister(redis, AGENT).catch(() => {});
  await redis.quit();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
