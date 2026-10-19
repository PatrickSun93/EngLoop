'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const q = require('../lib/queue');
const { startRelay, tryRepair, resolveTarget } = require('../lib/relay');
const roster = require('../lib/roster');
const rooms = require('../lib/rooms');
const reactions = require('../lib/reactions');
// 只为 `isDone`（判据唯一出处）—— 测试里也不许自己写第二份判定：
// 写 `=== true` 的话，这条测试会跟它要防的那个 bug 一起绿。
const threads = require('../web/threads.js');

// ── 临时目录回收 —— 不回收的话，每跑一遍全量这两个文件一共漏 9 个 ──────────
//
//   九个前缀（`workbox/workdl/workbox2/workdl2/crewbox/crewbox2/dl/dl2/dl3`）
//   都在 `$TMPDIR` 下建 `engloop-*` 目录，跑一遍留一份。
//
//   🔴 **只在退出码 0 时删** —— 异常退出要**留现场**（去掉 `code === 0` 那个判断，
//     异常时现场也会被删掉）。
//   ⚠️ 而 `SIGKILL` 时这个回调根本不跑 ⇒ 目录留着 —— 那个方向是对的，不修。
const TMPDIRS = [];
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); TMPDIRS.push(d); return d; };
process.on('exit', (code) => {
  if (code !== 0) return;
  for (const d of TMPDIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清不掉就算了 */ } }
});


const OUT = 'orch:out';
const DL = 'deadletter';
const IN = 'orch:in:human';

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function drainStream(redis, stream) {
  const res = await redis.xrange(stream, '-', '+');
  const out = [];
  for (const [, fields] of res) {
    const o = {};
    for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
    out.push(o);
  }
  return out;
}

async function main() {
  const dir = mkTmp('engloop-outbox-');
  const redis = q.createClient();
  await redis.del(OUT, DL, IN);

  console.log('\n【1】纯函数：JSON 修复');
  ok(tryRepair('{"username":"Patrick","text":"hi"}')?.text === 'hi', '正常 JSON 直接解析');
  const broken = '{"username":"Patrick","text":"他说"你好"然后走了"}';
  ok(tryRepair(broken)?.text?.includes('你好'), '抢救 text 里未转义的引号');
  ok(tryRepair('完全不是 json') === null, '救不了的返回 null');

  console.log('\n【2】路由判定（花名册）');
  ok((await resolveTarget(redis, { room_hash: 'abc', text: 'x' }))?.stream === 'room:abc', 'room_hash → 房间流');
  ok((await resolveTarget(redis, { username: 'Patrick', text: 'x' }))?.stream === 'orch:out', '不在册（是人）→ 出向流');
  await roster.register(redis, 'testcrew', { type: 'dev', stream: 'agent:testcrew:in' }, 30);
  const crewTarget = await resolveTarget(redis, { username: 'testcrew', text: 'x' });
  ok(crewTarget?.stream === 'agent:testcrew:in', '在册（是 agent）→ 它的收件流');
  ok(crewTarget?.agent === true, '标记为 agent');
  await roster.unregister(redis, 'testcrew');
  ok((await resolveTarget(redis, { username: 'testcrew', text: 'x' }))?.stream === 'orch:out', '摘牌后不再路由到 agent 流');
  ok((await resolveTarget(redis, { text: 'x' })) === null, '无目标 → null（走死信）');

  console.log('\n【2b】★ 房间流名只有一份出处（relay 不许自己拼）');
  {
    // ── 为什么这处比普通重复更值得守 ─────────────────────────────
    // relay 要是自己拼 `room:${hash}`，就跟 rooms.js 导出的 stream() 成了两份。
    // 两边分叉的后果，**正好是协议里用最重措辞警告的那个**：消息投进一个
    // 没人读的流，**房间里其他人永远看不到，而且没有任何报错**。
    // 差别在于协议警告的是「人写错了 username」，这里是**代码自己投错流** ——
    // **协议能拦住人，拦不住代码。**
    // ─────────────────────────────────────────────────────────────
    const t = await resolveTarget(redis, { room_hash: 'abc', text: 'x' });

    // ★ 四条都要，而且它们抓的是**不同的**东西 —— 变异验证：
    //   · 改 rooms.stream 的前缀 → 只有「值本身对」红
    //   · 让 relay 退回自己拼   → 只有两条源码断言红
    //
    // ⚠️ 特别注意第二条的局限：**「同源」抓的是「已经分歧」，抓不到
    //   「已经分叉但还没分歧」** —— 而后者正是所有分叉的第一天。
    //   刚复制出去的那一刻两边算出来一模一样，同源断言全绿。
    //   **所以它替代不了源码断言，源码断言也替代不了它。**
    ok(t?.stream === 'room:abc',
      '★ 值本身对（前缀被改成别的，这条会红）');
    ok(t?.stream === rooms.stream('abc'),
      '★ 而且跟 rooms.stream() 同源（值分歧了这条才红）');

    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(/rooms\.stream\(/.test(src), '★ relay.js 调 rooms.stream');
    ok(!/`room:\$\{/.test(src), '★ relay.js 里没有自己拼房间流名的字面量');
  }

  console.log('\n【3】端到端：写文件 → 进流');
  const events = [];
  // ★★ `deadletterRoot` 指到临时目录 —— **不许写进生产的 temp/deadletter/**。
  //   没有这个参数的话，跑一次全量就会往生产死信目录里写测试产物。
  //
  //   > **死信目录的全部用途是「这里面每一条都是真的没人处理过」。**
  //   > 混进测试产物之后，人捞的时候分不出哪条是真的 ——
  //   > **而分不出的代价是他会把真的那条也当成测试残留。**
  //
  //   跟 `lib/queue.js` 那套「测试不许碰生产库」是同一条规矩，换了个载体。
  const dlRoot = mkTmp('engloop-dl-');
  const relay = startRelay({
    outboxDir: dir, from: 'JARVIS', redis, onEvent: (e) => events.push(e),
    deadletterRoot: dlRoot,
  });

  fs.writeFileSync(
    path.join(dir, `${Date.now()}.json`),
    JSON.stringify({ username: 'Patrick', text: '收到，我看一下' }),
  );
  await wait(400);

  const out = await drainStream(redis, OUT);
  ok(out.length === 1, '消息进了 orch:out');
  ok(out[0]?.text === '收到，我看一下', '内容正确');
  ok(out[0]?.from === 'JARVIS', 'from 是 relay 配置的发送者');
  ok(!!out[0]?.job_id, '自动补了 job_id');

  console.log('\n【4】读后删：文件被消费掉，不会重复投递');
  ok(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length === 0, 'outbox 已清空');

  console.log('\n【5】坏 JSON 回弹给发送者，不静默丢');
  fs.writeFileSync(path.join(dir, `${Date.now() + 1}.json`), '{这不是 json');
  await wait(400);
  const bounced = await drainStream(redis, IN);
  ok(bounced.some((m) => m.text?.startsWith('PARSE_ERROR')), '收到 PARSE_ERROR 回弹');

  console.log('\n【5b】★★ 原文落盘：预览会被截断，路径不会');
  // ── 为什么要落盘 ────────────────────────────────────────────────
  // 一条长回复 JSON 坏了 → 走 parse_error → 收件人**只收到前
  // 200 字符**。关键那句要是在第 300 字符，它就整个消失，
  // **而两边都不会知道错过了什么。**
  //
  // > **截断多少都可能正好切掉关键那句，而路径是定长的。**
  //
  // ⚠️ 落盘是**唯一**能保住内容的机会：`readThenDelete()` 已经把原文件删了。
  {
    const NEEDLE = 'ZHEJUHUAZAI-DI-300-ZIFU-NEEDLE';
    // 造一个「预览截断处之后才出现关键句」的坏 JSON
    const longBad = `{这不是 json ${'填充'.repeat(200)} ${NEEDLE} 尾巴`;
    ok(longBad.slice(0, 200).includes(NEEDLE) === false,
      '（前置）关键句确实落在 200 字符预览之外 —— 否则这一节验不到东西');

    fs.writeFileSync(path.join(dir, `${Date.now() + 11}.json`), longBad);
    await wait(400);

    const ev = events.filter((e) => e.type === 'parse_error').pop();
    ok(ev && typeof ev.saved === 'string',
      '★★ parse_error 事件带上了落盘路径', JSON.stringify(ev));
    ok(ev && fs.existsSync(ev.saved), '★ 那个文件真的在磁盘上', ev && ev.saved);

    const onDisk = fs.readFileSync(ev.saved, 'utf8');
    ok(onDisk.includes(NEEDLE),
      '★★ **落盘的是完整原文** —— 那句在第 300 字符的话还在',
      `${onDisk.length} 字符`);
    ok(onDisk === longBad, '★ 一字不差（不是又截了一次）');

    const note = await drainStream(redis, IN);
    // ⚠️ 按 `ev.saved` 找，不是按「第一条 PARSE_ERROR」找 ——
    //   【5】那条也是 PARSE_ERROR，**而且它也带路径**（落盘对所有
    //   parse_error 生效）。按前缀 find 会拿到一条**看起来完全对**的消息：
    //   是 PARSE_ERROR、也有路径，**只是不是这一节造的那条**。
    //   （那样红的时候，断言失败详情里那个路径明明在，但它属于另一条消息。）
    const pe = note.find((m) => m.text?.includes(ev.saved));
    ok(pe !== undefined,
      '★★ 回弹给发送者的通知里**给了路径** —— 人能自己去捞完整的那份',
      JSON.stringify(note.map((m) => String(m.text).slice(0, 60))));
    ok(pe && !pe.text.includes(NEEDLE),
      '★ 而通知本身仍然是截断的（预览 + 路径，两个都要：'
      + '预览一眼看出是哪条，路径保证没截断的那份还在）');

    // ★ 存 .txt 不存 .json：死信内容**按定义是有问题的**。
    //   叫 .json 会让人拿 JSON 工具去开它、**然后失败第二次** ——
    //   而第二次失败看起来像「捞出来的东西也是坏的」。
    ok(ev.saved.endsWith('.txt'),
      '★★ 存成 .txt —— 一个坏 JSON 叫 .json 会让人失败第二次', ev.saved);

    fs.rmSync(path.dirname(ev.saved), { recursive: true, force: true });
  }

  console.log('\n【5c】★ 落盘失败不能让死信处理炸掉，但必须出声');
  {
    // ── 「连丢东西这件事都丢了」是这条路上最坏的结果 ──
    //   落盘失败时，那份内容**已经没有第二个副本**（原文件删了）。
    //   这时候最不能做的是静默 —— 人至少要知道「有东西没了」。
    const relay2 = require('../lib/relay');
    // 指向一个不可写的路径（用一个已存在的**文件**当目录）
    const blocker = path.join(dir, '__not_a_dir__');
    fs.writeFileSync(blocker, 'x');
    const saved = relay2.saveDeadLetter('内容', { from: 'dev', reason: 'x', root: blocker });
    ok(saved.ok === false, '★ 写不了时返回 ok:false，**不抛**（抛了会把死信处理带走）');
    ok(typeof saved.error === 'string' && saved.error.length > 0,
      '★ 说得出为什么写不了', JSON.stringify(saved.error));

    const note = relay2.savedNote(saved);
    ok(/没有第二个副本/.test(note),
      '★★ 通知文本明说**这份内容已经没了** —— 而不是含糊地说「保存失败」',
      JSON.stringify(note));
    ok(!/已存/.test(note), '★ 阴性对照：失败时不会说「已存」');

    const okSaved = relay2.saveDeadLetter('内容', {
      from: 'dev', reason: 'x', root: path.join(dir, '__dl__'),
    });
    ok(/已存/.test(relay2.savedNote(okSaved)) && okSaved.ok,
      '★ 阴性对照：成功时给出路径');

    // ★ from 决定一个**写盘路径** —— 不信任它的形状（docs.js 做的是同样的判断，
    //   那边的代价是读到不该读的，这边是写到不该写的）。
    const evil = relay2.saveDeadLetter('x', {
      from: '../../etc', reason: 'y', root: path.join(dir, '__dl2__'),
    });
    ok(evil.ok && !evil.path.includes('..'),
      '★★ 路径分隔符被清掉了，写不出 __dl2__ 之外', evil.path);

    fs.rmSync(blocker, { force: true });
    fs.rmSync(path.join(dir, '__dl__'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, '__dl2__'), { recursive: true, force: true });
  }

  console.log('\n【5d】★★ 测试不许往**生产**死信目录里写');
  {
    // ── 测试不许往生产死信目录写 ────────────────────────────────────
    // `startRelay` 不带 `deadletterRoot` 参数时，
    // 跑一次全量就会往生产的 `temp/deadletter/` 里写测试产物。
    //
    // > **死信目录的全部用途是「这里面每一条都是真的没人处理过」。**
    // > 混进测试产物之后，人捞的时候分不出哪条是真的 ——
    // > **而分不出的代价是他会把真的那条也当成测试残留。**
    //
    // ⚠️ 判据是「**这一节跑完，生产目录里的文件数没变**」——
    //   不是「源码里出现了 deadletterRoot 这个词」。后者是拿词当能力的代理。
    const prodRoot = require('../lib/relay').DEADLETTER_ROOT;
    const countProd = () => {
      try {
        return fs.readdirSync(prodRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .reduce((n, d) => {
            try { return n + fs.readdirSync(path.join(prodRoot, d.name)).length; }
            catch (_) { return n; }
          }, 0);
      } catch (_) { return 0; }   // 目录不存在 = 0，那也是个合法状态
    };

    const before = countProd();
    // 造一条必然走死信的（无收件人 + 有话说）
    fs.writeFileSync(path.join(dir, `${Date.now() + 77}.json`),
      JSON.stringify({ text: '这条没有收件人，必进死信' }));
    await wait(400);

    ok(events.some((e) => e.type === 'deadletter'),
      '（前置）确实走了死信路径 —— 否则这一节什么都没验到');
    ok(countProd() === before,
      '★★ 生产死信目录的文件数**没变** —— 测试的死信落在自己的临时目录里',
      `之前 ${before}，之后 ${countProd()}`);

    // ★ 阳性对照：那条死信真的落盘了（落在临时目录）——
    //   缺了它，一个「根本没落盘」的实现也能让上面那条绿。
    const dlEv = events.filter((e) => e.type === 'deadletter').pop();
    ok(dlEv && dlEv.saved && dlEv.saved.startsWith(dlRoot),
      '★★ 而它确实落盘了，且落在测试自己的根下', dlEv && dlEv.saved);
    ok(dlEv && fs.existsSync(dlEv.saved), '★ 文件真的在');

    // ⚠️ 清掉这一节往 deadletter **流**里造的那条 —— 【7】断言的是
    //   「流里恰好 1 条」，不清的话它会红。
    //   **而那个红跟【7】测的东西毫无关系** —— 它是这一节的副作用。
    //   跟上面那个死信目录污染是同一族，只是载体从文件系统换成了 redis 流：
    //   **一个测试的产物变成了另一个测试的前提。**
    await redis.del(DL);
  }

  console.log('\n【5e】★★ PARSE_ERROR 要送到**写坏它的那个 agent**，不是只送编排者');
  {
    // ── 要防的形状 ──────────────────────────────────────────────────
    //   硬编码 `q.send(redis, 'orch:in:human', { to: from, … })` 的话：
    //   **`to` 写着 dev，却投进了编排者的流。**
    //   后果是**写坏 JSON 的 agent 永远不知道自己写坏了** —— 它以为
    //   消息发出去了（危险的不是发不出去，是你以为发出去了）。
    //
    // ⚠️ 上面【5】【5b】用的 relay 是 `from: 'JARVIS'`（编排者）——
    //   **这条路径对编排者故意不生效**（编排者本来就读 orch:in:human，
    //   再发一条会让它以为写坏了两个文件）。所以那些断言全部继续成立，
    //   而这一节要的是**另一条路径**：from 是一个 agent。
    const CREW = 'parsecrew';
    const CREW_IN = `agent:${CREW}:in`;
    await redis.del(CREW_IN);
    await roster.register(redis, CREW, { type: 'dev', stream: CREW_IN }, 30);

    // ★ 正控：先证明这个查询看得见 CREW_IN 上的东西。
    //   没有它，下面「收到了」和「查不到」长得一样 ——
    //   而一个空结果最不需要解释，所以最容易被当成结论。
    await q.send(redis, CREW_IN, { from: 'test', text: 'CONTROL-PROBE' });
    const probe = await drainStream(redis, CREW_IN);
    ok(probe.some((m) => m.text === 'CONTROL-PROBE'),
      '★ 正控：这个查询确实看得见 agent:parsecrew:in 上的消息');
    await redis.del(CREW_IN);
    await redis.del(IN);

    const crewDir = mkTmp('engloop-crewbox-');
    const crewEvents = [];
    const crewRelay = startRelay({
      outboxDir: crewDir, from: CREW, redis,
      onEvent: (e) => crewEvents.push(e),
      deadletterRoot: mkTmp('engloop-dl2-'),
    });
    fs.writeFileSync(path.join(crewDir, `${Date.now()}.json`), '{坏了 agent-CASE');
    await wait(400);

    const toCrew = await drainStream(redis, CREW_IN);
    const toOrch = await drainStream(redis, IN);
    ok(toCrew.some((m) => String(m.text).startsWith('PARSE_ERROR')),
      '★★ **写坏 JSON 的 agent 自己收到了 PARSE_ERROR**（这条是修的那个 bug）',
      JSON.stringify(toCrew.map((m) => String(m.text).slice(0, 40))));
    ok(toOrch.some((m) => String(m.text).startsWith('PARSE_ERROR')),
      '★ 编排者那条**照旧还在** —— 这是「多一个目标」不是「改目标」');

    const pe = crewEvents.filter((e) => e.type === 'parse_error').pop();
    // ★ 事件里看得出投给了谁。**看不出的话这类 bug 能藏很久** ——
    //   只有 file / saved 的事件，投对投错完全一样。
    ok(pe && Array.isArray(pe.delivered_to) && pe.delivered_to.includes(CREW_IN)
       && pe.delivered_to.includes('orch:in:human'),
      '★★ 事件里带了投递目标，两个都在', JSON.stringify(pe && pe.delivered_to));
    ok(pe && pe.author_notified === true, '★ author_notified 为真');

    crewRelay.stop();

    // ★★ 阴性对照：**不在册**的 agent 通知不到 —— 而那必须说得出来。
    //   「没通知到」和「通知到了」不能长一样，否则又是一次
    //   「查不了」被读成「没事」。
    await roster.unregister(redis, CREW);
    await redis.del(CREW_IN, IN);
    const offDir = mkTmp('engloop-crewbox2-');
    const offEvents = [];
    const offRelay = startRelay({
      outboxDir: offDir, from: CREW, redis,
      onEvent: (e) => offEvents.push(e),
      deadletterRoot: mkTmp('engloop-dl3-'),
    });
    fs.writeFileSync(path.join(offDir, `${Date.now()}.json`), '{坏了 OFFLINE-CASE');
    await wait(400);

    const offEv = offEvents.filter((e) => e.type === 'parse_error').pop();
    ok(offEv && offEv.author_notified === false,
      '★★ 不在册时 author_notified 为 false —— **说得出「没通知到」**');
    ok(offEv && offEv.delivered_to.length === 1
       && offEv.delivered_to[0] === 'orch:in:human',
      '★ 而编排者那条仍然发了（队伍里出了什么事它要知道）',
      JSON.stringify(offEv && offEv.delivered_to));
    ok((await drainStream(redis, IN)).some((m) => String(m.text).startsWith('PARSE_ERROR')),
      '★ 阴性对照的正控：编排者那条确实到了，不是整个投递都没跑');

    offRelay.stop();
    await redis.del(CREW_IN, IN);
  }

  console.log('\n【6】ack：复合 ID 生效，裸 ID 拒绝（不猜流名）');
  const inMsg = await q.send(redis, 'orch:in:agent', { from: 'dev', text: 'crew 报到' });
  await q.claimNext(redis, { streams: 'orch:in:agent', group: 'orch', consumer: 'o1', blockMs: 300 });
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 1, '未 ack 时滞留 PEL');

  const pendingIds = await redis.xpending('orch:in:agent', 'orch', '-', '+', 10);
  const targetId = pendingIds[0][0];
  fs.writeFileSync(path.join(dir, `${Date.now() + 3}.json`), JSON.stringify({
    username: 'Patrick', text: '处理完了', ack: `orch:in:agent:::${targetId}`,
  }));
  await wait(500);
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 0, '复合 ID → PEL 清零');

  const inMsg2 = await q.send(redis, 'orch:in:agent', { from: 'dev', text: '第二条' });
  await q.claimNext(redis, { streams: 'orch:in:agent', group: 'orch', consumer: 'o1', blockMs: 300 });
  const p2 = await redis.xpending('orch:in:agent', 'orch', '-', '+', 10);
  fs.writeFileSync(path.join(dir, `${Date.now() + 4}.json`), JSON.stringify({
    username: 'Patrick', text: '裸 ID 试试', ack: p2[0][0],   // 没有流名
  }));
  await wait(500);
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 1, '裸 ID 被拒绝，PEL 仍滞留（不静默猜错流）');
  ok(events.some((e) => e.type === 'ack_failed' && /缺少流名/.test(e.error || '')), '发出 ack_failed 事件说明原因');
  await redis.del('orch:in:agent');

  console.log('\n【7】无目标 → 死信流（绝不静默丢失）');
  fs.writeFileSync(
    path.join(dir, `${Date.now() + 2}.json`),
    JSON.stringify({ text: '我没写收件人' }),
  );
  await wait(400);
  const dead = await drainStream(redis, DL);
  ok(dead.length === 1, '进了 deadletter 流');

  console.log('\n【8】纯 ack：无收件人 + 无话可说 → 只 ack 不投递（四条件同时满足）');

  // 造一条滞留在 PEL 里的入向消息，返回它的 ID
  async function pendMsg(text) {
    await q.send(redis, 'orch:in:agent', { from: 'dev', text });
    await q.claimNext(redis, { streams: 'orch:in:agent', group: 'orch', consumer: 'o1', blockMs: 300 });
    const p = await redis.xpending('orch:in:agent', 'orch', '-', '+', 10);
    return p[p.length - 1][0];
  }

  await redis.del(OUT, DL, 'orch:in:agent');

  const idA = await pendMsg('这条不需要回复');
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 1, '（前置）消息滞留 PEL');
  fs.writeFileSync(path.join(dir, `${Date.now() + 10}.json`), JSON.stringify({
    text: '', ack: `orch:in:agent:::${idA}`,
  }));
  await wait(500);
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 0, 'ack 生效，PEL 清零');
  ok((await drainStream(redis, OUT)).length === 0, '没有产生任何投递');
  ok((await drainStream(redis, DL)).length === 0, '没有进死信');
  ok(events.some((e) => e.type === 'ack_only'), '发出 ack_only 事件');

  const idB = await pendMsg('第一条');
  const idC = await pendMsg('第二条');
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 2, '（前置）两条滞留 PEL');
  fs.writeFileSync(path.join(dir, `${Date.now() + 11}.json`), JSON.stringify({
    text: '', ack: [`orch:in:agent:::${idB}`, `orch:in:agent:::${idC}`],
  }));
  await wait(500);
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 0, 'ack 传数组同样走得通');
  ok((await drainStream(redis, OUT)).length === 0, '数组情形也没有投递');

  // ── ★ `text` 字段**根本不存在**（不是空字符串）─────────────────
  //
  // agent 真会这么写：发现格式不对之后按正确形状重发、「保险起见」把上一条也一起 ack，
  // 两条都被覆盖 ⇒ 「缺 text 会不会落死信」在现场永远没有答案，所以要在这里验。
  //
  // ⚠️ 而上面三处断言全部用 `text: ''`（显式空串）—— **没有一条覆盖这一侧**。
  //   代码上它们是等价的（relay 里是 `String(entry.text ?? '')`，`??` 把
  //   `undefined` 兜成 `''`），但**「代码上等价」和「验过」是两回事**。
  const idA2 = await pendMsg('缺 text 字段的纯 ack');
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 1, '（前置）消息滞留 PEL');
  await redis.del(OUT, DL);
  fs.writeFileSync(path.join(dir, `${Date.now() + 10.5}.json`), JSON.stringify({
    ack: `orch:in:agent:::${idA2}`,      // ★ 故意不写 text
  }));
  await wait(500);
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 0,
    '★★ `text` 字段不存在时同样走纯 ack —— 不是只有显式空串才算');
  ok((await drainStream(redis, DL)).length === 0,
    '★ 而且没进死信（纯 ack 不算无目标）');
  ok((await drainStream(redis, OUT)).length === 0, '★ 也没有产生投递');

  console.log('\n【9】负向：任何一条不满足就照旧走原路径');

  // 有 username → 照旧投递（text 空也投），不走纯 ack 分支
  await redis.del(OUT);
  const idD = await pendMsg('x');
  fs.writeFileSync(path.join(dir, `${Date.now() + 12}.json`), JSON.stringify({
    username: 'Patrick', text: '', ack: `orch:in:agent:::${idD}`,
  }));
  await wait(500);
  ok((await drainStream(redis, OUT)).length === 1, '有 username → 照旧投进 orch:out');
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 0, '有 username → ack 仍绑在投递之后');

  // 有 room_hash → 照旧投进房间流
  const ROOM = 'room:ackonly-neg';
  await redis.del(ROOM);
  const idE = await pendMsg('x');
  fs.writeFileSync(path.join(dir, `${Date.now() + 13}.json`), JSON.stringify({
    room_hash: 'ackonly-neg', text: '', ack: `orch:in:agent:::${idE}`,
  }));
  await wait(500);
  ok((await drainStream(redis, ROOM)).length === 1, '有 room_hash → 照旧投进房间流');
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 0, '有 room_hash → ack 仍绑在投递之后');

  // text 非空 + 无收件人 → 照旧走死信，且 ack 不生效（这是「有话没说出去就 ack」要防的）
  await redis.del(DL);
  const idF = await pendMsg('x');
  fs.writeFileSync(path.join(dir, `${Date.now() + 14}.json`), JSON.stringify({
    text: '我有话要说，但没写收件人', ack: `orch:in:agent:::${idF}`,
  }));
  await wait(500);
  ok((await drainStream(redis, DL)).length === 1, 'text 非空 + 无收件人 → 照旧进死信');
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 1, 'text 非空 → ack 不生效，消息留在 PEL 等重投');
  await q.ack(redis, 'orch:in:agent', 'orch', idF);

  // 空文件但没带 ack → 什么都不表达，照旧进死信（「没人处理的进死信」这条不被削弱）
  await redis.del(DL);
  fs.writeFileSync(path.join(dir, `${Date.now() + 15}.json`), JSON.stringify({ text: '' }));
  await wait(500);
  ok((await drainStream(redis, DL)).length === 1, '空文件没带 ack → 照旧进死信，不静默吞掉');

  console.log('\n【10】纯 ack 的失败兜底：一条都没 ack 成就必须留下原文');

  // ack 是空数组 → 压根不算「带了 ack」。这一条专防 Boolean([]) === true：
  // 用 Boolean 判会让空数组钻进纯 ack 分支，一条 ack 不执行就把文件删了。
  await redis.del(DL);
  fs.writeFileSync(path.join(dir, `${Date.now() + 16}.json`), JSON.stringify({ text: '', ack: [] }));
  await wait(500);
  const deadEmpty = await drainStream(redis, DL);
  ok(deadEmpty.length === 1, 'ack 为空数组 → 照旧进死信，不被当成纯 ack');
  ok(/"ack":\[\]/.test(deadEmpty[0]?.text || ''), '死信里是完整原文，捞得回来');

  // ack 格式全错 → 命中纯 ack 分支，但一条都没成 → 原文必须留下
  await redis.del(DL);
  fs.writeFileSync(path.join(dir, `${Date.now() + 17}.json`), JSON.stringify({
    text: '', ack: '裸ID没有三冒号',
  }));
  await wait(500);
  const deadBare = await drainStream(redis, DL);
  ok(deadBare.length === 1, 'ack 格式全错 → 进死信，不静默删掉');
  ok(/裸ID没有三冒号/.test(deadBare[0]?.text || ''), '死信里带着写错的那个 ID，能照着改');
  ok(events.some((e) => e.type === 'deadletter' && e.reason === 'ack_only_all_failed'),
    '死信理由说清是 ack 全失败，不跟「没写收件人」混为一谈');

  // ack 指向不存在的流 → XACK 返回 0，不报错但也没生效，同样算没 ack 成
  await redis.del(DL);
  fs.writeFileSync(path.join(dir, `${Date.now() + 18}.json`), JSON.stringify({
    text: '', ack: 'nosuch:stream:::1-0',
  }));
  await wait(500);
  const deadNoop = await drainStream(redis, DL);
  ok(deadNoop.length === 1, 'XACK 返回 0（noop）也算失败 → 进死信');
  ok(events.some((e) => e.type === 'ack_noop'), '发出 ack_noop 事件说明没生效');
  // 捞回来的人下一步就是照着改流名，改哪个得一眼看见
  ok(/nosuch:stream/.test(deadNoop[0]?.text || ''), '死信原文里看得出是哪个流名写错了');

  // 部分成功 → 不进死信：没成的那几条会自然重投，系统自愈
  await redis.del(DL);
  const idG = await pendMsg('部分成功用例');
  fs.writeFileSync(path.join(dir, `${Date.now() + 19}.json`), JSON.stringify({
    text: '', ack: [`orch:in:agent:::${idG}`, '这条是裸ID'],
  }));
  await wait(500);
  ok((await q.pending(redis, 'orch:in:agent', 'orch')).count === 0, '部分成功：有效的那条真的 ack 掉了');
  ok((await drainStream(redis, DL)).length === 0, '部分成功不进死信（死信只装完全没被处理的）');
  const partial = events.filter((e) => e.type === 'ack_only').pop();
  ok(partial?.ok === 1 && partial?.total === 2, 'ack_only 带 ok=1 total=2，一眼看出有一条没成');

  console.log('\n【11】★★★ expects_reply 透传：房间带、私聊不带（防房间里互相回复的广播风暴）');
  {
    // ── 为什么这一组必须**真跑一遍 relay**，不能只用源码正则 ──────────
    //   relay.js 那段 payload 是**手工拼的白名单**：新字段（`room_hash`、
    //   `reply_to` 这类）漏加的症状是
    //   「投进了正确的流，但消息体里没有字段」，**零报错**。
    //   源码正则守得住「那行字在不在」，守不住「它真的进了流」。
    const RM = 'room:er-test';
    await redis.del(RM);

    // ① 房间 + 显式要求回复 → 字段进流，值为 'true'
    fs.writeFileSync(path.join(dir, `${Date.now() + 20}.json`), JSON.stringify({
      room_hash: 'er-test', text: 'dev 你回我一下', expects_reply: true,
    }));
    await wait(500);
    // ② 房间 + 什么都没写 → 字段**照样进流**，值为 'false'
    fs.writeFileSync(path.join(dir, `${Date.now() + 21}.json`), JSON.stringify({
      room_hash: 'er-test', text: '我把日志清了',
    }));
    await wait(500);

    const roomMsgs = await drainStream(redis, RM);
    ok(roomMsgs.length === 2, '（前置）两条都进了房间流', String(roomMsgs.length));
    ok(roomMsgs[0]?.expects_reply === 'true',
      '★★ 显式 expects_reply:true → 房间流里是 "true"（relay 真的透传了）',
      JSON.stringify(roomMsgs[0]?.expects_reply));
    ok(roomMsgs[1]?.expects_reply === 'false',
      '★★★ 什么都没写 → 房间流里是 **"false"，不是字段缺席** ——'
      + '缺席要靠下游猜默认值，而猜错的方向就是那场风暴',
      JSON.stringify(roomMsgs[1]?.expects_reply));
    // 判据端到端：拿 redis 读回来的原始字符串喂给唯一那个判据函数
    ok(rooms.expectsReply(roomMsgs[0]) === true && rooms.expectsReply(roomMsgs[1]) === false,
      '★★ 两条真实消息喂进 rooms.expectsReply() 得到 true / false',
      JSON.stringify([roomMsgs[0]?.expects_reply, roomMsgs[1]?.expects_reply]));

    // ③ ★★★ 私聊**绝不能**带这个字段 —— 这是这一组里最容易写反的一条。
    //
    //   两种消息在这个字段上默认值**相反**：
    //     私聊 = 派活 → 默认要回（协议里「派了活要回话」那条）
    //     房间 = 知会 → 默认不回
    //   给私聊也盖一个 `expects_reply: false`，等于把那条协议整个关掉：
    //   agent 从此收到活也不吭声。**那是比广播风暴更安静的坏** ——
    //   风暴看得见（满屏消息），这个看不见（什么都不发生）。
    await redis.del(OUT);
    fs.writeFileSync(path.join(dir, `${Date.now() + 22}.json`), JSON.stringify({
      username: 'Patrick', text: '私聊派活',
    }));
    await wait(500);
    const dm = (await drainStream(redis, OUT))[0];
    ok(!!dm, '（前置）私聊那条投出去了', JSON.stringify(dm));
    ok(dm && !('expects_reply' in dm),
      '★★★ 私聊消息里**根本没有** expects_reply 字段 —— 协议第 6 条不受影响',
      JSON.stringify(Object.keys(dm || {})));
    // 阴性对照：确认上一条不是平凡成立的（同一个 `in` 检查在房间那条上为真）
    ok('expects_reply' in roomMsgs[1],
      '★★ 阴性对照：同一个 `in` 检查在房间消息上是 true —— 不是「谁都没有这个字段」');

    await redis.del(RM);
  }

  console.log('\n【12】★★★ done 透传 + 🏁 自动打在 thread 根上');
  {
    // agent 报「任务完成」时标 `done`。两个产物：
    //   ① 流里带 `done` ⇒ 前端才弹得出桌面通知
    //   ② thread 的**根**上被打一个 🏁 ⇒ 人事后翻回去找得到
    //
    // ⚠️ ② 必须在**后端**发生。前端打的话，人睡觉时报的完成第二天翻回去
    //   是没有标记的 —— 而那正是这个标记最有用的时刻。
    //   所以它在这里测，不在某个「前端有没有写这段代码」的源码断言里测。
    const rk = (anchor) => `engloop:react:dm:${anchor}`;

    await redis.del(OUT);

    // ── ① 带 reply_to 的完成报告：🏁 打在**根**上，不是打在它自己身上
    const ROOT = 'root-job-id-0001';
    await redis.del(rk(ROOT));
    fs.writeFileSync(path.join(dir, `${Date.now() + 40}.json`), JSON.stringify({
      username: 'Patrick', text: '活干完了，验证在容器里跑的', reply_to: ROOT, done: true,
    }));
    await wait(500);
    const doneMsg = (await drainStream(redis, OUT))[0];
    ok(!!doneMsg, '（前置）完成报告投出去了', JSON.stringify(doneMsg));
    // ⚠️ 流里读回来是**字符串** 'true'（queue.js 全过 String()）——
    //   断言故意写成走判据函数，而不是 `=== true`：写 `=== true` 的话
    //   这条测试会跟它要防的那个 bug 一起绿。
    ok(doneMsg && threads.isDone(doneMsg),
      '★★ 流里带 done，且 Threads.isDone 认得出来（读回来是字符串 \'true\'）',
      JSON.stringify(doneMsg && doneMsg.done));

    // ★ `list()` 返回的是 `{scope, anchor, reactions:[…]}` —— 取 `.reactions`。
    const rootReacts = (await reactions.list(redis, 'dm', ROOT)).reactions;
    ok(rootReacts.some((r) => r.emoji === '🏁'),
      '★★★ 🏁 打在 thread 的**根**上（reply_to 指的那条）',
      JSON.stringify(rootReacts));
    ok(rootReacts.some((r) => r.emoji === '🏁'
      && (r.users || []).some((u) => u.by === 'system')),
      "★★ by='system' —— 界面上要分得开「机器说完了」和「Patrick 点的 ✅」",
      JSON.stringify(rootReacts));
    // 阴性对照：**不是**打在这条消息自己身上（那样 thread 根上永远不会有标记）
    const selfReacts = (await reactions.list(redis, 'dm', doneMsg.job_id)).reactions;
    ok(selfReacts.length === 0,
      '★★★ 阴性对照：🏁 **没有**打在完成报告自己身上',
      JSON.stringify(selfReacts));

    // ── ② 没有 reply_to 的完成报告：它自己就是根
    await redis.del(OUT);
    fs.writeFileSync(path.join(dir, `${Date.now() + 41}.json`), JSON.stringify({
      username: 'Patrick', text: '顶层完成报告', done: true,
    }));
    await wait(500);
    const solo = (await drainStream(redis, OUT))[0];
    const soloReacts = (await reactions.list(redis, 'dm', solo.job_id)).reactions;
    ok(soloReacts.some((r) => r.emoji === '🏁'),
      '★ 没有 reply_to 时，🏁 打在它自己身上（它自己就是根）',
      JSON.stringify(soloReacts));
    await redis.del(rk(solo.job_id));

    // ── ③ ★★★ 阴性对照：**没标 done 的消息什么都不该发生**
    //   这一条守的是「误报」那一侧。判据要是宽了（比如按「agent 回话了」算），
    //   人会收到一串假通知，然后关掉通知 —— 那时这个功能等于没做，
    //   而且它坏得**没有任何报错**。
    await redis.del(OUT);
    const ROOT2 = 'root-job-id-0002';
    await redis.del(rk(ROOT2));
    fs.writeFileSync(path.join(dir, `${Date.now() + 42}.json`), JSON.stringify({
      username: 'Patrick', text: '进度：我看到一半，还没完', reply_to: ROOT2,
    }));
    await wait(500);
    const prog = (await drainStream(redis, OUT))[0];
    ok(prog && !('done' in prog),
      '★★★ 没标 done 的消息，流里**根本没有** done 这个字段',
      JSON.stringify(Object.keys(prog || {})));
    ok(prog && !threads.isDone(prog), '★ 判据对它是 false');
    const noReacts = (await reactions.list(redis, 'dm', ROOT2)).reactions;
    ok(noReacts.length === 0,
      '★★★ 它的 thread 根上一个反应都没有 —— 进度不该打 🏁',
      JSON.stringify(noReacts));

    // ── ④ agent 写成字符串 "true" 也认（outbox 是手写 JSON，两种写法都自然）
    await redis.del(OUT);
    const ROOT3 = 'root-job-id-0003';
    await redis.del(rk(ROOT3));
    fs.writeFileSync(path.join(dir, `${Date.now() + 43}.json`), JSON.stringify({
      username: 'Patrick', text: '完成（字符串写法）', reply_to: ROOT3, done: 'true',
    }));
    await wait(500);
    const strDone = (await drainStream(redis, OUT))[0];
    ok(strDone && threads.isDone(strDone), '★★ `"done":"true"` 字符串写法也认');
    ok((await reactions.list(redis, 'dm', ROOT3)).reactions.some((r) => r.emoji === '🏁'),
      '★★ 字符串写法同样打上了 🏁');

    await redis.del(rk(ROOT), rk(ROOT2), rk(ROOT3), OUT);
  }

  console.log('\n【13】★★ 两个 agent 在一个 thread 里来回到第 3 轮 ⇒ orch:out 多一条 system 章的告警（房间 ＋ 私聊）');
  {
    // 两个真 relay、两个发件目录：JARVIS（上面那个）＋ 一个对手。判的是**真的写进流里**的东西。
    const sysAlerts = async () => (await drainStream(redis, OUT)).filter((m) => m.sender_type === 'system' && m.kind === 'notice');
    const lastOf = async (stream) => { const r = await redis.xrevrange(stream, '+', '-', 'COUNT', 1); return r[0]; };
    const fieldsOf = (row) => { const o = { id: row[0] }; for (let i = 0; i < row[1].length; i += 2) o[row[1][i]] = row[1][i + 1]; return o; };

    // ── 房间：JARVIS ↔ tcpeer，每条回上一条（房间流 stream id），第一条挂在一条人发的根上
    const peerDir = mkTmp('engloop-outbox-peer-');
    const peerEvents = [];
    const peer = startRelay({ outboxDir: peerDir, from: 'tcpeer', redis, onEvent: (e) => peerEvents.push(e), deadletterRoot: mkTmp('engloop-dl-peer-') });
    const RH = 'tc-relay';
    await redis.del(OUT, rooms.stream(RH));
    let parent = 'H0-human-root';
    const sendRoom = async (d, i) => {
      fs.writeFileSync(path.join(d, `${Date.now()}-${i}.json`), JSON.stringify({ room_hash: RH, text: `第 ${i} 条`, reply_to: parent }));
      await wait(350);
      parent = (await lastOf(rooms.stream(RH)))[0];
    };
    for (let i = 1; i <= 5; i++) await sendRoom(i % 2 ? dir : peerDir, i);
    ok((await redis.xlen(rooms.stream(RH))) === 5, '（前置）5 条都进了房间流（投递没被拦）');
    ok((await sysAlerts()).length === 0, '★ JARVIS 3 · tcpeer 2 ⇒ orch:out 里没有告警');
    await sendRoom(peerDir, 6);
    const a1 = await sysAlerts();
    ok(a1.length === 1, '★★ 第 6 条（两方各 3）⇒ orch:out 多了一条告警', String(a1.length));
    // from 是编排者的名字（章仍是 system）—— 网页按 from 归频道，写 system 就进了一个不能回复的频道
    ok(a1[0] && a1[0].to === 'Patrick' && a1[0].from === 'JARVIS' && a1[0].sender_type === 'system',
      '告警发给 Patrick，from JARVIS · 章 system', JSON.stringify(a1[0]));
    ok(a1[0] && /JARVIS 3 条/.test(a1[0].text) && /tcpeer 3 条/.test(a1[0].text)
      && a1[0].text.includes(`scope：room:${RH}`) && a1[0].text.includes('根：H0-human-root'),
      '★ 正文：两方条数、scope、根（人发的那条）', a1[0] && a1[0].text);
    ok(peerEvents.some((e) => e.type === 'thread_over_limit'), '触发那一侧的 relay 报了 thread_over_limit 事件', JSON.stringify(peerEvents.map((e) => e.type)));
    await sendRoom(dir, 7);
    ok((await sysAlerts()).length === 1, '★ 第 7 条 ⇒ 不再告警（只一次）');
    ok((await redis.xlen(rooms.stream(RH))) === 7, '7 条全部投进了房间流');

    // ── 私聊：JARVIS → tcdm（在册 agent），tcdm → JARVIS（在册编排者），reply_to 填对方那条的 job_id
    await roster.register(redis, 'tcdm', { type: 'dev', stream: 'agent:tcdm:in' }, 60);
    await roster.register(redis, 'JARVIS', { type: 'orchestrator', stream: 'orch:in:agent' }, 60);
    const dmDir = mkTmp('engloop-outbox-tcdm-');
    const dmRelay = startRelay({ outboxDir: dmDir, from: 'tcdm', redis, deadletterRoot: mkTmp('engloop-dl-tcdm-') });
    await redis.del(OUT, 'agent:tcdm:in', 'orch:in:agent');
    let dmParent = 'D0-human-root';
    const sendDm = async (fromJarvis, i) => {
      fs.writeFileSync(path.join(fromJarvis ? dir : dmDir, `${Date.now()}-${i}.json`),
        JSON.stringify({ username: fromJarvis ? 'tcdm' : 'JARVIS', text: `私聊第 ${i} 条`, reply_to: dmParent }));
      await wait(350);
      dmParent = fieldsOf(await lastOf(fromJarvis ? 'agent:tcdm:in' : 'orch:in:agent')).job_id;
    };
    for (let i = 1; i <= 5; i++) await sendDm(i % 2 === 1, i);
    ok((await sysAlerts()).length === 0, '★ 私聊 JARVIS 3 · tcdm 2 ⇒ 没有告警');
    await sendDm(false, 6);
    const d1 = await sysAlerts();
    ok(d1.length === 1 && /scope：dm/.test(d1[0].text) && d1[0].text.includes('根：D0-human-root'),
      '★★ 私聊第 6 条 ⇒ 一条告警，scope dm、根是人发的那条', JSON.stringify(d1.map((m) => m.text)));
    ok((await redis.xlen('agent:tcdm:in')) === 3 && (await redis.xlen('orch:in:agent')) === 3, '私聊 6 条全部投递了（3 ＋ 3）');

    peer.stop(); dmRelay.stop();
    await roster.unregister(redis, 'tcdm'); await roster.unregister(redis, 'JARVIS');
    await redis.del(OUT, rooms.stream(RH), 'agent:tcdm:in', 'orch:in:agent');
  }

  console.log('\n【14】★★ record 抛错 ⇒ 消息照样投递，onEvent 说出来，同一批后面的文件照常处理');
  {
    const tc = require('../lib/thread-count');
    await redis.del(OUT);
    await redis.hset(tc.rootKey('dm', 'BROKEN-PARENT'), 'x', '1');   // 根映射类型不对 ⇒ GET 抛 WRONGTYPE
    const before = events.length;
    const t = Date.now();
    // 两个文件在同一个 debounce 窗口里写 ⇒ 同一次 drain
    fs.writeFileSync(path.join(dir, `${t}-a.json`), JSON.stringify({ username: 'Patrick', text: '父的映射坏了', reply_to: 'BROKEN-PARENT' }));
    fs.writeFileSync(path.join(dir, `${t}-b.json`), JSON.stringify({ username: 'Patrick', text: '同一批第二条', kind: 'notice' }));
    await wait(600);
    const out = await drainStream(redis, OUT);
    const ev = events.slice(before);
    ok(out.some((m) => m.text === '父的映射坏了'), '★★ record 抛错的那条照样投递了');
    ok(ev.some((e) => e.type === 'thread_count_failed' && /WRONGTYPE/.test(e.error)), '★★ 并且 onEvent 报了 thread_count_failed', JSON.stringify(ev.map((e) => e.type)));
    ok(out.some((m) => m.text === '同一批第二条'), '★★ 同一批里后面那个文件照常投递', JSON.stringify(out.map((m) => m.text)));
    ok(!ev.some((e) => e.type === 'error'), '★ 没有 error 事件（异常没漏到 drain 外面）', JSON.stringify(ev.filter((e) => e.type === 'error')));
    await redis.del(OUT, tc.rootKey('dm', 'BROKEN-PARENT'));
  }

  relay.stop();
  await redis.del(OUT, DL, IN, ROOM, 'orch:in:agent');
  await redis.quit();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e); process.exit(1); });
