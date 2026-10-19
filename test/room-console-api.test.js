'use strict';

/**
 * 控制台要的两件后端能力，验的是**真 HTTP 状态码**和**真接线**。
 *
 * ── 为什么单靠 lib 层的断言不够 ──────────────────────────────────
 * `GET /api/rooms/:hash/history` 的全部价值是「房间不存在 → **404**」。
 * 而 lib 层只能断言「historyPayload 抛了一个带 code 的错」——
 * **状态码是几，只有真走一遍 HTTP 才知道**。
 * 一个把 catch 写成 `res.json({messages:[]})` 的实现，lib 层测试全绿。
 *
 * ── 为什么不起真 bus ────────────────────────────────────────────
 * ⚠️ bus 一起来 watchdog 就会枚举**真的 tmux 会话**，而测试库的花名册是空的
 *    —— 于是每个真 agent 都会被判失聪，**被 submit 一条恢复指令**。
 *    测试会去打断正在干活的人。
 *
 * 所以：handler 从 `lib/rooms.js` 拿（生产用的是同一个函数），
 * 挂到测试自己的 express app 上，监听端口 0（随机空闲端口）。
 * **路由路径和挂载**这两件 handler 管不到的事，在末尾用源码断言守。
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const q = require('../lib/queue');
const rooms = require('../lib/rooms');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

/** 起一个只挂了这一个路由的 app。返回 base URL + 关闭函数。 */
function serve(redis) {
  const app = express();
  app.use(express.json());
  app.get('/api/rooms/:hash/history', rooms.historyHandler(redis));
  app.post('/api/rooms/:hash/members', rooms.membersHandler(redis));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function main() {
  const redis = q.createClient();

  // 残留清理
  for (const h of await redis.smembers(rooms.INDEX)) {
    const m = await rooms.get(redis, h);
    if (m && /^APITEST-/.test(m.name)) {
      await redis.del(rooms.META(h), rooms.stream(h));
      await redis.srem(rooms.INDEX, h);
    }
  }

  const room = await rooms.create(redis, 'APITEST-复盘');
  await rooms.join(redis, room.hash, 'JARVIS');
  await rooms.join(redis, room.hash, 'dev');
  for (const [from, text] of [['Patrick', '第一句'], ['JARVIS', '第二句'], ['dev', '第三句']]) {
    await rooms.post(redis, room.hash, { from, text });
  }

  const app = await serve(redis);

  console.log('\n【1】★ 正常房间：200 + 全部历史 + 顶栏要的元信息');
  {
    const r = await fetch(`${app.base}/api/rooms/${room.hash}/history`);
    const b = await r.json();
    ok(r.status === 200, `200（实际 ${r.status}）`);
    ok(Array.isArray(b.messages) && b.messages.length === 3,
      '三条历史', JSON.stringify(b).slice(0, 200));
    ok(b.messages[0].text === '第一句' && b.messages[2].text === '第三句',
      '顺序是 append-only 的正序（不是 xrevrange 的倒序）');
    ok(b.messages[1].from === 'JARVIS', '发言人正确');
    ok(b.name === 'APITEST-复盘' && b.members.includes('dev'),
      '★ 带 name / members —— 界面画顶栏不用再打一次 /api/rooms');
  }

  console.log('\n【2】★★ 房间不存在 → 404，不是 200 + 空数组');
  {
    // ── 这一条是这个端点存在的全部理由 ──────────────────────────────
    // 「这个房间没人说话」和「没有这个房间」在界面上都是一片空白，
    // 而后者意味着请求方拿着一个错的 hash。静默返回 `[]` 等于对他说
    // 「一切正常，只是还没人说话」。`/api/agents` 头上那段注释骂的是同一件事。
    const r = await fetch(`${app.base}/api/rooms/deadbeefcafe/history`);
    const b = await r.json();
    ok(r.status === 404, `★★ 404（实际 ${r.status}）`, JSON.stringify(b));
    ok(b.messages === undefined,
      '★★ 而且**没有** messages 字段 —— 一个空数组会被界面当成「空房间」渲染',
      JSON.stringify(b));
    ok(/不存在/.test(b.error || ''), '★ 说得出是哪种错', JSON.stringify(b));
  }

  console.log('\n【3】★ 阴性对照：存在但没消息的房间 → 200 + 空数组');
  {
    // 缺了这条，一个「查不到消息就 404」的实现也能让【2】变绿 ——
    // 而那会让一个刚建好、还没人说话的房间打不开。
    const empty = await rooms.create(redis, 'APITEST-空房间');
    const r = await fetch(`${app.base}/api/rooms/${empty.hash}/history`);
    const b = await r.json();
    ok(r.status === 200, `★ 200（实际 ${r.status}）`);
    ok(Array.isArray(b.messages) && b.messages.length === 0,
      '★ 空数组 —— 两种「空」必须分得开', JSON.stringify(b));
    await redis.del(rooms.META(empty.hash), rooms.stream(empty.hash));
    await redis.srem(rooms.INDEX, empty.hash);
  }

  console.log('\n【4】★ count 参数');
  {
    const r = await fetch(`${app.base}/api/rooms/${room.hash}/history?count=2`);
    const b = await r.json();
    ok(b.messages.length === 2, 'count=2 → 两条');
    ok(b.messages[1].text === '第三句',
      '★ 取的是**最近**两条（xrevrange 后 reverse），不是最早两条',
      JSON.stringify(b.messages.map((m) => m.text)));

    const bad = await fetch(`${app.base}/api/rooms/${room.hash}/history?count=abc`);
    ok(bad.status === 200,
      '★ 打错的 count 不报 400 —— 不该让整个房间显示不出来', `实际 ${bad.status}`);
    ok((await bad.json()).messages.length === 3, '回落到默认 50，三条都在');

    const huge = await fetch(`${app.base}/api/rooms/${room.hash}/history?count=99999999`);
    ok((await huge.json()).count === rooms.COUNT_MAX,
      '★★ 超大值被夹到上限 —— 没有它，一个 URL 就能让 bus 把整条流拉进内存');
  }

  console.log('\n【5】★★ Redis 挂了 → 503 QUEUE_UNAVAILABLE，不是空房间');
  {
    // ── 「查不了」不能降级成「没有」──────────────────────────────────
    // 这是 `/api/agents` 那段注释讲了三遍的东西：一个坏掉的查询返回空列表，
    // 等于对着人说「一切正常」。这里造一个真的连接失败来验它。
    const dead = q.createClient({ lazyConnect: true });
    dead.status = 'end';                       // 不连接，任何命令都会失败
    const bad = await serve(dead);
    const r = await fetch(`${bad.base}/api/rooms/${room.hash}/history`);
    const b = await r.json();
    ok(r.status === 503, `★★ 503（实际 ${r.status}）`, JSON.stringify(b));
    ok(b.error === 'QUEUE_UNAVAILABLE',
      '★★ 错误码跟 /api/message、/api/rooms 是同一个', JSON.stringify(b));
    ok(b.messages === undefined,
      '★★ 没有 messages 字段 —— 「Redis 挂了」绝不能长得像「这个房间是空的」',
      JSON.stringify(b));
    await bad.close();
    dead.disconnect();
  }

  console.log('\n【5b】★★ 成员编辑端点：接受人，但说清谁只靠广播');
  {
    // ── 为什么不拒绝把人加进成员表 ──────────────────────────────────
    // 成员表混着「路由」（扇给谁）和「展示」（房间里有谁）两个用途。
    // 人**需要**在展示里，**不该**在路由里。
    // **拒绝加入 = 用路由的理由否决了一个合法的展示需求。**
    // 所以修的是扇出，不是这个端点。
    const post = (body, h = room.hash) => fetch(`${app.base}/api/rooms/${h}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const r = await post({ add: ['Patrick', 'dev2'] });
    const b = await r.json();
    ok(r.status === 200, `200（实际 ${r.status}）`, JSON.stringify(b).slice(0, 200));
    ok(b.members.includes('Patrick'),
      '★★ 人加得进去 —— 不拒绝，因为展示需求是合法的', JSON.stringify(b.members));
    ok(Array.isArray(b.no_inbox) && b.no_inbox.includes('Patrick'),
      '★★ 但明确列出「他没有收件流，只靠广播」—— 这不是错误，是人该知道的事实',
      JSON.stringify(b.no_inbox));
    ok(/不会被扇出/.test(b.no_inbox_note || ''),
      '★ 说清那意味着什么', JSON.stringify(b.no_inbox_note));
    ok(/掉册/.test(b.no_inbox_note || ''),
      '★★ 并点出另一种可能：一个本该在册的 agent 出现在这里 = 它掉册了。'
      + '**同一个字段，两种完全不同的含义，不说的话人只会看到一个名字**',
      JSON.stringify(b.no_inbox_note));

    const r2 = await post({ remove: ['dev2'] });
    ok((await r2.json()).members.includes('dev2') === false, '★ remove 生效');

    const bad = await post({ add: 'dev' });
    ok(bad.status === 400, `★ add 不是数组 → 400（实际 ${bad.status}）`);
    ok(/add.*remove/.test((await bad.json()).next || ''),
      '★ 400 给出正确写法（收到错误的人要的是下一步）');

    const empty = await post({});
    ok(empty.status === 400, '★ 空请求 → 400，不是静默成功');

    const ghost = await post({ add: ['x'] }, 'deadbeefcafe');
    ok(ghost.status === 404, `★★ 房间不存在 → 404（实际 ${ghost.status}）`);

    // 清理：把 Patrick 摘掉，别留在测试房间里
    await post({ remove: ['Patrick'] });
  }

  await app.close();

  console.log('\n【6】★ 接线：serve.js 真的挂了这个路由、真的用了 lib 的 handler');
  {
    // 这个项目栽过六次「写了但没接线」。上面五节全绿而这根线是断的时候，
    // 房间界面照样是空的 —— 而且没有任何报错。
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'serve.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    ok(/app\.get\(\s*['"`]\/api\/rooms\/:hash\/history['"`]/.test(code),
      '★★ 路由路径挂上了 —— handler 写得再对，没挂就是 404 Cannot GET',
      (code.match(/.*rooms\/:hash.*/g) || []).join(' | '));
    ok(/rooms\.historyHandler\(\s*redis\s*\)/.test(code),
      '★★ 用的是 lib 里那个被测过的 handler，不是在回调里又实现一遍',
      (code.match(/.*historyHandler.*/g) || []).join(' | '));

    ok(/app\.post\(\s*['"`]\/api\/rooms\/:hash\/members['"`]/.test(code),
      '★★ 成员编辑路由挂上了', (code.match(/.*hash\/members.*/g) || []).join(' | '));
    ok(/rooms\.membersHandler\(\s*redis\s*\)/.test(code),
      '★★ 用的是 lib 里那个 handler');
  }

  console.log('\n【7】★★ 接线：房间消息真的广播给浏览器了');
  {
    // ── fanOutRoom 以前只扇到各参与者的收件流，浏览器什么都收不到 ──────
    // 房间界面因此是「只进不出」：人说的话进得去，谁说了什么都看不见。
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'serve.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    const i = code.indexOf('async function fanOutRoom');
    ok(i > 0, '（前置）找到了 fanOutRoom', `indexOf=${i}`);
    // 切到函数结尾（下一个顶格 `}` 之后）—— 切不准会让下面的断言指错方向
    const body = code.slice(i, code.indexOf('\n}', i));
    ok(body.length > 200, '（前置）切到了函数体', `长度 ${body.length}`);

    ok(/rooms\.fanOutPlan\(/.test(body),
      '★★ 用的是被测过的 fanOutPlan —— 两个成员表的差别在那里，不在这里重写',
      body.slice(0, 300));
    ok(/broadcast\(\s*plan\.broadcast\s*\)/.test(body),
      '★★ 真的 broadcast 了 —— 少了这一行，房间界面永远收不到任何发言',
      body.slice(0, 400));

    // ★★ 广播必须在 deliveries 循环**外面**。
    //
    //   写进循环里的话，一条消息会被广播 N 次（N = 成员数减一），
    //   **而且发言者自己那条会一次都不广播** —— 因为 deliveries 里没有它。
    //   症状是「别人说的话我看到好几遍，我自己说的话看不见」，
    //   而这两个症状看起来毫无关联，很难联想到是同一行代码。
    const iBroadcast = body.indexOf('broadcast(plan.broadcast)');
    const iLoop = body.indexOf('for (const d of plan.deliveries)');
    ok(iBroadcast > 0 && iLoop > 0, '（前置）两处都找到了',
      `broadcast=${iBroadcast} loop=${iLoop}`);
    ok(iBroadcast < iLoop,
      '★★ broadcast 在 deliveries 循环之前 —— 写进循环里会「别人的看好几遍、自己的看不见」',
      `broadcast=${iBroadcast} loop=${iLoop}`);

    // ★ 老的那行 `if (member === m.from) continue` 必须已经不在了 ——
    //   它还在就说明扇出没走 plan，那两个成员表又变回一份实现了。
    ok(!/member\s*===\s*m\.from/.test(body),
      '★ 旧的「跳过发言者」判断已经收进 fanOutPlan，不在 bus 里留第二份',
      body.slice(0, 400));

    // ★★ 扇出真的传了 routable —— 不传的话「同一句话显示两遍」还在，
    //   而 fanOutPlan 的单测（传了 routable）照样全绿。
    ok(/fanOutPlan\(meta,\s*m,\s*routable\)/.test(body),
      '★★ fanOutPlan 真的收到了 routable —— 少了它那个重复 bug 原封不动，'
      + '而单测发现不了（单测自己传了参数）',
      (body.match(/.*fanOutPlan.*/g) || []).join(' | '));
    ok(/registry\s*===\s*null\s*\?\s*null\s*:/.test(body),
      '★★ 花名册查不了时传 null（不过滤），**不是当成「谁都没有收件流」**——'
      + '后者会让 redis 抖一下时所有 agent 集体收不到房间消息，且没有任何报错',
      (body.match(/.*registry.*/g) || []).join(' | '));

    // ── ★★★ `expects_reply` 必须出现在**投递的 payload** 里 ──
    //
    //   这一组守的位置是有讲究的：**漏字段从来不发生在纯函数里，
    //   发生在这个手工白名单上。** 字段可以这样漏掉 ——
    //   fanOutPlan 的单测一路绿灯，而投出去的消息体里没有那个字段。
    //   （「函数支持透传」和「调用方真的传了」是两件事。）
    //
    //   ⇒ 所以 rooms.test.js 里那 20 条全绿，**证明不了 agent 收得到这个字段**。
    ok(/expects_reply:/.test(body),
      '★★★ 扇出的 payload 里有 expects_reply —— 少了它，agent 分不出'
      + '「房间知会」和「派给我的活」，就会互相触发、自激',
      (body.match(/.*expects_reply.*/g) || []).join(' | '));
    ok(/expects_reply:\s*d\.expects_reply\s*===\s*true/.test(body),
      '★★ 值取自 plan.deliveries（判据只有 rooms.expectsReply 一处），'
      + '不在这里现算第二个 if',
      (body.match(/.*expects_reply.*/g) || []).join(' | '));
    // ★★ 守「不许退化成条件展开」。
    //   写成 `...(d.expects_reply ? {…} : {})` 的话，「不要求回复」时字段
    //   **整个消失** —— 而字段消失和「老版本压根没有这个概念」在收件人眼里
    //   一模一样。**默认必须是一个说出口的 false，不是一个沉默的缺席。**
    //   （room_hash / reply_to 用条件展开是对的：那两个缺席就是「没有」。）
    ok(!/\.\.\.\(\s*[\w.]*expects_reply/.test(body),
      '★★ expects_reply **不是**条件展开 —— 缺席和 false 在收件人眼里没有区别',
      (body.match(/.*expects_reply.*/g) || []).join(' | '));
  }

  await redis.del(rooms.META(room.hash), rooms.stream(room.hash));
  await redis.srem(rooms.INDEX, room.hash);
  await redis.quit();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
