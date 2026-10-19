'use strict';

/**
 * 推进 —— **到这里流程才会动。**
 *
 * ★★ 这份测试盯的两件事，比「推进对不对」更靠前：
 *
 * ① **换阶段的唯一入口是 `enterStage`。** 三个字段（stage / assignee /
 *    stage_entered_at）必须一起变。漏掉时间戳的后果不是「少个字段」，
 *    是**闸门在、水从旁边流过去**：打回退回 spec 时时间戳还是上一次的，
 *    旧 SPEC.md 就又满足判据了。**而且比没有闸门更糟 —— 有个字段让人
 *    以为已经防住了。** 所以除了行为断言，这里还有**源码断言**。
 *
 * ② **先落状态，再发消息。** 反过来的话消息发出去了、状态没写，
 *    重启后会再派一次，而那个角色**会收到两条一样的派活**。
 *    顺序同样用源码断言钉住 —— 行为测试看不见「谁先谁后」。
 *
 * ⚠️ 这份测试会真的往房间流里写消息，但跑在**测试库**上
 *    （lib/queue.js 的判定：入口在 test/ 下）。不会打扰任何真 agent。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const rooms = require('../lib/rooms');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const PREFIX = 'TEST-ADV-';
const FLOW = 'design-spec-build';
const ROLES = ['arch', 'senior', 'test'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TMP;
const write = (name, content) => fs.writeFileSync(path.join(TMP, name), content, 'utf8');
const DESIGN_OK = '## 问题\n有。\n## 方案\n有。\n## 取舍\n有。\n';
const SPEC_OK = '## 范围\n有。\n## 验收判据\n有。\n';

async function cleanupRooms(redis) {
  for (const h of await redis.smembers(rooms.INDEX)) {
    const raw = await redis.get(rooms.META(h));
    if (!raw) { await redis.srem(rooms.INDEX, h); continue; }
    let m = null;
    try { m = JSON.parse(raw); } catch { /* 别人的坏数据不归我清 */ }
    if (m && String(m.name || '').startsWith(PREFIX)) {
      await redis.del(rooms.META(h), rooms.stream(h));
      await redis.srem(rooms.INDEX, h);
    }
  }
}

/** 房间流里每条的 expects_reply —— ★ 一律问 `rooms.expectsReply()`，不自己写比较。 */
async function msgs(redis, hash) {
  return (await rooms.history(redis, hash, 50)).map((m) => ({
    text: m.text, wants: rooms.expectsReply(m), raw: m.expects_reply,
  }));
}

async function main() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-adv-'));
  const redis = q.createClient();
  await cleanupRooms(redis);
  for (const r of ROLES) {
    await roster.register(redis, r, { type: 'dev', stream: `agent:${r}:in` }, 300);
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【1】enterStage —— 三个字段一起，纯函数');
  {
    const meta = { hash: 'h', name: 'n', flow: FLOW, stage: 'design', assignee: 'arch' };
    const before = Date.now();
    const r = rooms.enterStage(meta, { stage: 'spec' });
    const after = Date.now();
    ok(Object.keys(r).sort().join(',') === 'assignee,stage,stage_entered_at',
      '★★ 恰好返回三个字段 —— 调用方**没法**只拿 stage 不拿时间戳',
      JSON.stringify(Object.keys(r)));
    ok(r.stage === 'spec' && r.assignee === 'senior',
      '★ assignee 不传就从模板的 role 取（谁负责哪个阶段是模板定的）');
    const ms = Date.parse(r.stage_entered_at);
    ok(ms >= before && ms <= after, '★ 时间戳是「现在」', `${before} ≤ ${ms} ≤ ${after}`);

    ok(rooms.enterStage(meta, { stage: 'spec', assignee: 'senior' }).assignee === 'senior',
      '显式传对的角色可以');
    let threw = null;
    try { rooms.enterStage(meta, { stage: 'spec', assignee: 'dev2' }); } catch (e) { threw = e; }
    ok(threw && /没有映射层/.test(threw.message),
      '★★ 传一个跟 role 不一致的人 → 抛。角色名就是 agent 名，中间没有映射层', threw && threw.message);

    threw = null;
    try { rooms.enterStage(meta, { stage: '第六阶段' }); } catch (e) { threw = e; }
    ok(threw && /不在流程/.test(threw.message), '阶段名不认识 → 抛');

    threw = null;
    try { rooms.enterStage({ flow: null }, { stage: 'spec' }); } catch (e) { threw = e; }
    ok(threw && /没绑流程/.test(threw.message), '普通房间没有阶段可进 → 抛');

    const d = rooms.enterStage(meta, { stage: rooms.STAGE_DONE });
    ok(d.stage === rooms.STAGE_DONE && d.assignee === null && !!d.stage_entered_at,
      '★ 走到 done：assignee 清空，时间戳照样刷');
    threw = null;
    try { rooms.enterStage(meta, { stage: rooms.STAGE_DONE, assignee: 'arch' }); } catch (e) { threw = e; }
    ok(threw && /不该再点名/.test(threw.message), '★ done 了还点名 → 抛');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【2】★★ 源码断言：换阶段的唯一入口 + 先落状态再发消息');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rooms.js'), 'utf8');
    const start = src.indexOf('async function advance(');
    const end = src.indexOf('\nmodule.exports', start);
    ok(start > 0 && end > start, '定位到 advance 的函数体');
    const body = src.slice(start, end);

    ok(body.includes('Object.assign(meta, enterStage('),
      '★★ 三个字段整体赋值 —— 逐个 `meta.stage = …` 的写法漏掉时间戳不会报错');
    ok(!/stage_entered_at/.test(body),
      '★★ advance 里**不出现** stage_entered_at —— 时间戳只能来自 enterStage。'
      + '它自己造一个的话，enterStage 就不再是唯一入口了');
    ok(!/meta\.stage\s*=|meta\.assignee\s*=/.test(body),
      '★ 也没有绕过去直接赋值的地方');

    const iSet = body.indexOf('redis.set(rooms.META') >= 0
      ? body.indexOf('redis.set(rooms.META') : body.indexOf('redis.set(META(');
    const iPost = body.indexOf('await post(redis');
    ok(iSet > 0 && iPost > 0, '两处都找得到', `set@${iSet} post@${iPost}`);
    ok(iSet < iPost,
      '★★ **先落状态（redis.set）再发消息（post）**。反过来的话消息发出去了、'
      + '状态没写，重启后会再派一次 —— 那个角色收到两条一样的派活', `set@${iSet} post@${iPost}`);

    // ── ★★ 那谁来守这几条守卫？──────────────────────────────────────
    //   `rooms-flow-mutation.test.js` **证明不了**它们：变异后的源码只活在
    //   require.cache 里，而这几条读的是**磁盘文件** —— 磁盘没动，它们照样绿。
    //   （`adv-enterstage-bypass` 那条变异红的是行为断言，不是这里。）
    //
    //   所以喂一段**假源码**当场自检：证明上面三条判据认得出「坏形状」。
    //   不做的话，一个写错的正则（比如少个反斜杠）会让这三条恒真，
    //   而它们在通过列表里看起来跟别的一模一样。
    const fakeBad = 'async function advance() {\n'
      + '  meta.stage = nextName;\n'
      + '  meta.assignee = nextRole;\n'
      + '  meta.stage_entered_at = new Date().toISOString();\n'
      + '  await post(redis, hash, {});\n'
      + '  await redis.set(META(hash), JSON.stringify(meta));\n}';
    ok(!fakeBad.includes('Object.assign(meta, enterStage('),
      '★ 自检：坏形状确实**没有**整体赋值 —— 所以上面第一条认得出它');
    ok(/stage_entered_at/.test(fakeBad),
      '★ 自检：坏形状确实自己造了时间戳 —— 所以上面第二条认得出它');
    ok(/meta\.stage\s*=|meta\.assignee\s*=/.test(fakeBad),
      '★ 自检：那个正则真的匹配得上直接赋值（少个反斜杠就会恒不匹配）');
    ok(fakeBad.indexOf('await redis.set(META(') > fakeBad.indexOf('await post(redis'),
      '★★ 自检：坏形状里 post **早于** set —— 所以上面那条顺序断言认得出它。'
      + '这一条塌了说明顺序判据本身写反了或写空了');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【3】不够格 → 什么都不做（它还在干）');
  {
    const room = await rooms.create(redis, `${PREFIX}还在干`,
      { flow: FLOW, stage: 'design', assignee: 'arch' });
    write('DESIGN.md', '## 问题\n## 方案\n## 取舍\n');   // 只有标题
    const r = await rooms.advance(redis, room.hash, { baseDir: TMP });
    ok(r.advanced === false, '没推进');
    const after = await rooms.get(redis, room.hash);
    ok(after.stage === 'design' && after.assignee === 'arch',
      '★ 状态一个字没变', JSON.stringify([after.stage, after.assignee]));
    ok((await msgs(redis, room.hash)).length === 0,
      '★★ 而且**一条消息都没发** —— 不够格时静默是对的，'
      + '每条派活都烧额度，「它还在干」不该产生任何广播');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【4】够格 → 落状态 + 一条广播 + 一条点名');
  let flowRoom;
  {
    flowRoom = await rooms.create(redis, `${PREFIX}正常推进`,
      { flow: FLOW, stage: 'design', assignee: 'arch' });
    await sleep(20);
    write('DESIGN.md', DESIGN_OK);
    const before = await rooms.get(redis, flowRoom.hash);
    const r = await rooms.advance(redis, flowRoom.hash, { baseDir: TMP });
    ok(r.advanced === true && r.to_stage === 'spec' && r.assignee === 'senior',
      '★ design → spec，点名 senior', JSON.stringify([r.to_stage, r.assignee]));

    const after = await rooms.get(redis, flowRoom.hash);
    ok(after.stage === 'spec' && after.assignee === 'senior', '状态落了');
    ok(after.stage_entered_at !== before.stage_entered_at,
      '★★ stage_entered_at 跟着换了', `${before.stage_entered_at} → ${after.stage_entered_at}`);

    const ms = await msgs(redis, flowRoom.hash);
    ok(ms.length === 2, `恰好两条消息（${ms.length} 条）`, JSON.stringify(ms.map((m) => m.text.slice(0, 20))));
    ok(ms[0].wants === false,
      '★★ 广播 `expects_reply` 判为 false —— 所有人看得见进展，**没有人动手**');
    ok(ms[0].raw === undefined,
      '★★ 而且 redis 里**根本没有这个字段**（不是字符串 "false"）—— '
      + "'false' 是 truthy，写进去就会引发广播风暴", JSON.stringify(ms[0].raw));
    ok(ms[1].wants === true, '★ 点名那条判为 true —— 只有被点的那一个动手');
    ok(ms[1].text.includes('@senior') && ms[1].text.includes('SPEC.md'),
      '★ 点名文本说清谁、产出什么', ms[1].text.slice(0, 60));
    ok(ms[1].text.includes('## 验收判据'),
      '★ 连判据要求都写在派活里 —— 让他不用去翻模板才知道要写什么小节');

    // ★★ 推进之后立刻再推一次：新阶段的产出还不存在 → 不该连推
    const again = await rooms.advance(redis, flowRoom.hash, { baseDir: TMP });
    ok(again.advanced === false,
      '★★ 紧接着再调一次不会连推 —— 新阶段的 SPEC.md 还不存在。'
      + '这条守的是「一个阶段只点名一次」（自激的入口）', again.why);
    ok((await msgs(redis, flowRoom.hash)).length === 2, '★ 消息数还是 2，没有多发');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【5】★★ 打回：退回 spec，而且**时间戳必须刷新**');
  {
    // 先把 spec 做完，推进到 review
    await sleep(20);
    write('SPEC.md', SPEC_OK);
    let r = await rooms.advance(redis, flowRoom.hash, { baseDir: TMP });
    ok(r.advanced === true && r.to_stage === 'review', 'spec → review', r.to_stage);

    const specMtime = fs.statSync(path.join(TMP, 'SPEC.md')).mtimeMs;

    // arch 判「打回」
    await sleep(20);
    write('REVIEW.md', '## 判决\n打回，第二节没说清。\n');
    const beforeReject = await rooms.get(redis, flowRoom.hash);
    r = await rooms.advance(redis, flowRoom.hash, { baseDir: TMP });
    ok(r.advanced === true && r.rejected === true && r.to_stage === 'spec',
      '★ 判决「打回」→ 退回 spec', JSON.stringify([r.to_stage, r.rejected]));

    const afterReject = await rooms.get(redis, flowRoom.hash);
    ok(afterReject.assignee === 'senior', '重新点名 senior');
    ok(afterReject.stage_entered_at !== beforeReject.stage_entered_at,
      '★★★ **退回也刷新了 stage_entered_at** —— 「回退」在直觉里不是「进入」，'
      + '在这个机制里必须是', `${beforeReject.stage_entered_at} → ${afterReject.stage_entered_at}`);
    ok(Date.parse(afterReject.stage_entered_at) > specMtime,
      '★★★ 而且新时间戳**晚于那份旧 SPEC.md** —— 所以判据现在会拦住它。'
      + '这一条塌了就是流程空转：旧产出满足判据 → 立刻又推回 review',
      `${Date.parse(afterReject.stage_entered_at)} vs ${specMtime}`);

    const gate = await rooms.roomGate(redis, flowRoom.hash, { baseDir: TMP });
    ok(gate.can_advance === false && gate.gate.stale === true,
      '★★★ 端到端闭合：打回之后立刻判据 → **不够格**（旧 SPEC.md 是上一轮的）', gate.why);

    const ms = await msgs(redis, flowRoom.hash);
    const last = ms[ms.length - 1];
    ok(last.wants === true && last.text.includes('重做'),
      '★★ 点名文本说的是「重做」不是「新活」（规格 §五④）', last.text.slice(0, 60));
    ok(last.text.includes('打回'), '★ 而且带上了上一轮的判决词');

    // senior 真的重写 → 又够格了
    await sleep(20);
    write('SPEC.md', '## 范围\n这一轮重写的。\n## 验收判据\n这一轮重写的。\n');
    r = await rooms.advance(redis, flowRoom.hash, { baseDir: TMP });
    ok(r.advanced === true && r.to_stage === 'review', '★ 重写之后才推得动', r.why);
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【6】★★ 角色不在花名册 → 不推进，且说得出缺谁');
  {
    const room = await rooms.create(redis, `${PREFIX}缺角色`,
      { flow: FLOW, stage: 'tasks', assignee: 'senior' });
    await sleep(20);
    write('TASKS.md', '## 任务清单\n有。\n');

    await roster.unregister(redis, 'test');          // tasks 的下一阶段角色是 test
    const r = await rooms.advance(redis, room.hash, { baseDir: TMP });
    ok(r.advanced === false, '★★ 不推进 —— 派出去 relay 查不到会投给 Patrick，'
      + '而房间看起来一切正常', r.why);
    ok(r.why.includes('test'), '★ 说得出缺的是谁', r.why);
    ok((await msgs(redis, room.hash)).length === 0,
      '★★ 一条消息都没发 —— 校验发生在**发消息之前**，这是唯一烧额度的动作');
    const after = await rooms.get(redis, room.hash);
    ok(after.stage === 'tasks', '★ 状态也没动（不是「先改了再说」）');

    await roster.register(redis, 'test', { type: 'dev', stream: 'agent:test:in' }, 300);
    const r2 = await rooms.advance(redis, room.hash, { baseDir: TMP });
    ok(r2.advanced === true && r2.to_stage === 'test',
      '★ 阴性对照：角色回来了就推得动 —— 这条证明上面拦的是「不在册」，不是别的', r2.why);
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【7】★ 花名册**查不了** ≠ 都在');
  {
    const room = await rooms.create(redis, `${PREFIX}查不了`,
      { flow: FLOW, stage: 'design', assignee: 'arch' });
    await sleep(20);
    write('DESIGN.md', DESIGN_OK);

    const real = roster.list;
    roster.list = async () => { throw new Error('redis 抖了'); };
    let r;
    try { r = await rooms.advance(redis, room.hash, { baseDir: TMP }); }
    finally { roster.list = real; }

    ok(r.advanced === false, '★★ 查不了就不推进');
    ok(r.why.includes('不是「都在」'),
      '★ 而且说清了「查不了」和「都在」不是一回事', r.why);
    ok((await msgs(redis, room.hash)).length === 0, '没发消息');

    const r2 = await rooms.advance(redis, room.hash, { baseDir: TMP });
    ok(r2.advanced === true,
      '★ 阴性对照：花名册恢复后照常推进 —— 上面拦的是查询失败本身');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【8】最后一个阶段 → done，只广播、不点名');
  {
    const room = await rooms.create(redis, `${PREFIX}收尾`,
      { flow: FLOW, stage: 'test', assignee: 'test' });
    await sleep(20);
    write('TEST_REPORT.md', '## 结论\n都过了。\n');
    const r = await rooms.advance(redis, room.hash, { baseDir: TMP });
    ok(r.advanced === true && r.to_stage === rooms.STAGE_DONE, '★ 走到 done', r.to_stage);

    const after = await rooms.get(redis, room.hash);
    ok(after.assignee === null, '★ assignee 清空 —— 没人在办了');
    const st = await rooms.flowStatus(redis, room.hash);
    ok(st.state === rooms.FLOW_STATE.DONE, 'flowStatus 报 done', st.state);

    const ms = await msgs(redis, room.hash);
    ok(ms.length === 1, `★★ 只有一条消息（${ms.length} 条）—— 流程完了就没人要被点名了`);
    ok(ms[0].wants === false, '★ 而且那一条是广播，不要求任何人回复');

    const again = await rooms.advance(redis, room.hash, { baseDir: TMP });
    ok(again.advanced === false && (await msgs(redis, room.hash)).length === 1,
      '★ done 之后再调不会有任何动作', again.why);
  }

  for (const r of ROLES) await roster.unregister(redis, r).catch(() => {});
  await cleanupRooms(redis);
  await redis.quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('✗ 异常:', (e && e.stack) || e);
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
