'use strict';

/**
 * 对话历史导出
 *
 * ★ 这个文件守的核心那条不是「导出跑通了」，是：
 *
 *   > **一个跑起来了但写了空文件的导出器，跟没有导出器
 *   >   在加 MAXLEN 那一刻长得一模一样 —— 而那一刻之后没有第二次机会。**
 *
 *   所以每一节都**从文件读回来跟原流比对**，不是只看文件存在、
 *   也不是只看返回值。返回值和文件是两个东西，而出事的时候它们会分叉。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const q = require('../lib/queue');
const h = require('../lib/history');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const readAll = (file) => fs.readFileSync(file, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function main() {
  const redis = q.createClient();
  const S1 = 'orch:out', S2 = 'orch:in:human', S3 = 'agent:histcrew:in';
  const ROOM = 'room:deadbeef';
  await redis.del(S1, S2, S3, ROOM);

  console.log('\n【1】纯函数：kind 分类');
  ok(h.kindOf('orch:out') === 'orch:out', 'orch:out');
  // ★ 顺序敏感的那一对 —— 「人说的」和「agent 说的」必须分开，
  //   那是这张表里最要紧的一条区分。
  ok(h.kindOf('orch:in:human') === 'in:human', 'orch:in:human → in:human');
  ok(h.kindOf('orch:in:agent') === 'in:agent', 'orch:in:agent → in:agent');
  ok(h.kindOf('orch:in:human') !== h.kindOf('orch:in:agent'),
    '★ 人发的和 agent 发的不能归成同一类');
  ok(h.kindOf('agent:dev:in') === 'agent:in', 'agent:<name>:in');
  ok(h.kindOf('room:abc123') === 'room', 'room:*');
  ok(h.kindOf('deadletter') === 'deadletter', 'deadletter');
  ok(h.kindOf('work:eval') === 'work', 'work:*');
  ok(h.kindOf('something:else') === 'other',
    '★ 认不出的归 other,不是丢掉 —— 未知类型也要进历史');

  console.log('\n【2】纯函数：ts 用 Stream ID，不是消息里的 timestamp');
  {
    const rec = h.toRecord('orch:out', '1786118253591-0',
      ['from', 'JARVIS', 'text', 'hi', 'timestamp', '1999-01-01T00:00:00Z']);
    ok(rec.ts === 1786118253591, '★ ts 来自 Stream ID（redis 写入那一刻的事实）');
    ok(rec.payload.timestamp === '1999-01-01T00:00:00Z',
      '★★ 而消息自己写的 timestamp **原样留在 payload 里**');
    // 两个都留的理由：正常路径上它们一致，只在出问题时分叉 ——
    // 而那正是要查的时候。只留一个就等于提前决定了「哪个是对的」。
    ok(h.dayOf(rec.ts) === '2026-08-07', 'dayOf 按 UTC 切天');
  }

  console.log('\n【3】★★ payload：不认识的字段原样带着，不做白名单');
  {
    const rec = h.toRecord('room:abc', '1-0',
      ['from', 'dev', 'text', 'x', 'room_hash', 'abc', 'job_id', 'J1', 'agent_type', 'dev']);
    ok(rec.room_hash === 'abc', 'room_hash 进了顶层字段');
    ok(rec.payload.job_id === 'J1' && rec.payload.agent_type === 'dev',
      '★★ job_id / agent_type 这些没在规格里的字段也留着');
    // ⚠️ 字段不做白名单:白名单会把 room_hash 这类字段吃掉,
    //   读的人只能从 text 前缀猜房间名。
    //   而导出这边丢掉的东西 **永远找不回来。**
    ok(!('job_id' in rec) , 'payload 里的字段不重复挤进顶层');
  }

  console.log('\n【4】★★ 端到端：导出后从文件读回来，跟原流对得上');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-hist-'));
  {
    await q.send(redis, S1, { from: 'JARVIS', to: 'Patrick', text: '第一条' });
    await q.send(redis, S2, { from: 'Patrick', to: 'orchestrator', text: '第二条' });
    await q.send(redis, S3, { from: 'JARVIS', to: 'histcrew', text: '第三条' });
    await q.send(redis, ROOM, { from: 'dev', text: '房间发言', room_hash: 'deadbeef' });

    const r = await h.exportAll(redis, { root, streams: [S1, S2, S3, ROOM] });

    // ★ 先断返回值 —— 「写了多少条」是调用方唯一能拿到的活性证据。
    ok(r.written === 4, '★ 返回值说它写了 4 条', JSON.stringify(r));
    ok(r.files.length >= 1, '至少写了一个文件');

    // ★★ 再从文件读回来。**返回值和文件是两个东西** ——
    //   一个只更新计数器不写文件的实现，能让上面那条绿。
    const rows = r.files.flatMap(readAll);
    ok(rows.length === 4, '★★ 文件里真的有 4 行', `${rows.length}`);

    const texts = rows.map((x) => x.text).sort();
    ok(JSON.stringify(texts) === JSON.stringify(['第一条', '第三条', '第二条', '房间发言'].sort()),
      '★★ 四条内容一字不差地在文件里', JSON.stringify(texts));

    const room = rows.find((x) => x.kind === 'room');
    ok(room && room.room_hash === 'deadbeef', '★ 房间那条的 room_hash 没丢');
    ok(rows.every((x) => typeof x.id === 'string' && x.id.includes('-')),
      '★★ 每行都带 Stream ID（去重和续传的唯一依据）');
    ok(rows.every((x) => Number.isFinite(x.ts)), '每行都有 ts');
  }

  console.log('\n【5】★★ 幂等：再导一次不会重复（Patrick 的「按 id 去重」）');
  {
    const before = h.exportAll ? null : null;
    const r2 = await h.exportAll(redis, { root, streams: [S1, S2, S3, ROOM] });
    ok(r2.written === 0, '★★ 第二次一条都没写', JSON.stringify(r2));
    ok(r2.skipped === 4, '★ 而且它说得出跳过了 4 条（不是「什么都没发生」）');

    const rows = r2.files.flatMap(readAll);
    ok(rows.length === 4, '★★ 文件里仍然是 4 行，没有翻倍', `${rows.length}`);
    void before;
  }

  console.log('\n【6】★ 增量：新消息进来，只导新的那条');
  {
    await q.send(redis, S1, { from: 'JARVIS', to: 'Patrick', text: '第五条' });
    const r3 = await h.exportAll(redis, { root, streams: [S1, S2, S3, ROOM] });
    ok(r3.written === 1, '★ 只写了新增的那 1 条', JSON.stringify(r3));
    ok(r3.skipped === 4, '旧的 4 条被跳过');
    const rows = r3.files.flatMap(readAll);
    ok(rows.length === 5, '文件里现在 5 行');
    ok(rows.filter((x) => x.text === '第五条').length === 1, '新那条只出现一次');
  }

  console.log('\n【7】★★ 单向：导出不碰 redis，流一条都没少');
  {
    // 第一条硬要求:导出是单向的。
    // ⚠️ 一个「导完就裁」的实现会让上面所有断言照样绿 ——
    //   而它正是这个功能存在的理由要防的事。
    const lens = {};
    for (const s of [S1, S2, S3, ROOM]) lens[s] = await redis.xlen(s);
    await h.exportAll(redis, { root, streams: [S1, S2, S3, ROOM] });
    let intact = true;
    for (const s of [S1, S2, S3, ROOM]) if ((await redis.xlen(s)) !== lens[s]) intact = false;
    ok(intact, '★★ 导出前后流长度不变（导出只读，绝不裁剪）', JSON.stringify(lens));

    // ★ 阴性对照：证明这条断言**抓得住**裁剪 —— 手动裁一条，长度确实会变。
    //   没有它,一个「xlen 永远返回同一个数」的假象也能让上面那条绿。
    await redis.xtrim(S1, 'MAXLEN', 1);
    ok((await redis.xlen(S1)) !== lens[S1],
      '★ 阴性对照：真裁剪的话 xlen 会变（所以上面那条不是恒绿）');
  }

  console.log('\n【8】★ 坏行不静默跳过');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-hist2-'));
    fs.writeFileSync(path.join(dir, '2026-08-07.jsonl'), '{坏的\n{"id":"1-0","stream":"x"}\n');
    const { ids, bad } = h.readExistingIds(path.join(dir, '2026-08-07.jsonl'));
    ok(bad === 1, '★ 坏行被数出来了（不是静默跳过）');
    ok(ids.has(h.keyOf('x', '1-0')),
      '★ 好行的 id 照常收进去（用 h.keyOf 拼，不在测试里另写一份分隔符）');
    // ⚠️ 别写成 `ids.has('x 1-0')` 手拼分隔符:**实现里那个「空格」是 NUL 字节**。
    //   ★ 两层:
    //     · 分隔符只该有一处出处(h.keyOf)——测试自己拼就是第二份实现
    //     · 而且**NUL 会让 grep 失效**:文件里有 NUL,`grep ids.add` 返回空,
    //       跟「那行代码不存在」完全同形。
    // ⚠️ 为什么坏行必须报:静默跳过的话那些 id 会被当成「没导出过」
    //   而重复追加 —— **文件越坏,重复越多**,而没有任何信号。
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【9】★ canary 流被排除，别的都导');
  {
    ok(h.isConversation('orch:out') === true, 'orch:out 要导');
    ok(h.isConversation('work:eval') === true,
      '★ work:* 也导 —— 内容是真活儿,不是心跳');
    ok(h.isConversation('deadletter') === true,
      '★★ deadletter 也导 —— **没送到的那部分也是对话,而且它最该留**');
    ok(h.isConversation('isolation:canary:123') === false,
      'canary 是测试产物,排除');
  }

  fs.rmSync(root, { recursive: true, force: true });
  await redis.del(S1, S2, S3, ROOM);
  await redis.quit();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.message, e.stack); process.exit(1); });
