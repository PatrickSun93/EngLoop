'use strict';

/**
 * 阶段判据 —— **查产出文件够不够格推进，不写状态、不发消息。**
 *
 * ★★ 这份测试的中心是**一条阴性对照**：
 *
 *   > 造一个 DESIGN.md 只有标题没有内容的情况，断言流程**不**推进
 *   > （判据有分辨力，不是恒真）。
 *
 *   一个「查文件在不在 + 非不非空」的实现，对那个文件会**放行** ——
 *   所以下面每次断言「拒绝」的地方，都先断言一句「它确实存在且非空」，
 *   把那个弱实现会走的路显式摆出来。
 *
 * 变异证明见 `test/rooms-flow-mutation.test.js`（`gate-*` 那几条）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const q = require('../lib/queue');
const rooms = require('../lib/rooms');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const PREFIX = 'TEST-GATE-';
const DESIGN = {
  name: 'design', role: 'arch', produces: 'DESIGN.md',
  requires: ['## 问题', '## 方案', '## 取舍'],
};
const REVIEW = {
  name: 'review', role: 'arch', produces: 'REVIEW.md',
  requires: ['## 判决'], verdict: ['通过', '打回'],
};

let TMP;
function write(name, content) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}
/** 正控：证明这份内容对「只查存在且非空」的实现是**放行**的。 */
function looksDoneToWeakGate(name) {
  const p = path.join(TMP, name);
  return fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim().length > 0;
}

async function cleanupRooms(redis) {
  for (const h of await redis.smembers(rooms.INDEX)) {
    const raw = await redis.get(rooms.META(h));
    if (!raw) { await redis.srem(rooms.INDEX, h); continue; }
    let m = null;
    try { m = JSON.parse(raw); } catch { /* 别人的坏数据不归这里清 */ }
    if (m && String(m.name || '').startsWith(PREFIX)) {
      await redis.del(rooms.META(h), rooms.stream(h));
      await redis.srem(rooms.INDEX, h);
    }
  }
}

async function main() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-gate-'));

  // ───────────────────────────────────────────────────────────────
  console.log('\n【1】产出文件还不在 → 不够格，而且说得出找的是哪个路径');
  {
    const g = rooms.stageGate(TMP, DESIGN);
    ok(g.ok === false, '不够格');
    ok(g.exists === false, 'exists=false');
    ok(g.reasons.join('').includes('DESIGN.md'),
      '★ 理由里带具体路径 —— 「产出文件不在」不带路径的话，人得自己猜去哪找',
      JSON.stringify(g.reasons));
  }

  console.log('\n【2】文件在但整个是空的');
  {
    write('DESIGN.md', '   \n\n  \t\n');
    const g = rooms.stageGate(TMP, DESIGN);
    ok(g.ok === false, '不够格');
    ok(g.exists === true && g.bytes > 0,
      '★ 正控：文件确实在、字节数也不为 0 —— 「非空」得看有没有非空白字符',
      `bytes=${g.bytes}`);
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【3】★★ 只有标题、没有正文 —— 规格 §五① 的验收第一条');
  {
    write('DESIGN.md', '## 问题\n## 方案\n## 取舍\n');
    ok(looksDoneToWeakGate('DESIGN.md'),
      '★ 正控：它「存在且非空」，而且三个约定小节**一个不缺** —— '
      + '一个只查存在性、甚至只查标题在不在的实现，到这里都会放行');
    const g = rooms.stageGate(TMP, DESIGN);
    ok(g.ok === false, '★★ 而 stageGate 拒绝它');
    ok(g.missing_sections.length === 0,
      '★ 而且拒绝的理由**不是**「缺小节」—— 标题确实都在',
      JSON.stringify(g.missing_sections));
    ok(g.empty_sections.length === 3,
      '★★ 是「三个小节都只有标题、没有正文」', JSON.stringify(g.empty_sections));
    ok(g.reasons.join('').includes('## 方案'),
      '★ 差什么说得具体（缺哪一节，不是「格式不对」）', JSON.stringify(g.reasons));
  }

  console.log('\n【4】缺小节 vs 空小节 —— 两种要分开报');
  {
    write('DESIGN.md', '## 问题\n有问题。\n\n## 方案\n');
    const g = rooms.stageGate(TMP, DESIGN);
    ok(g.ok === false, '不够格');
    ok(JSON.stringify(g.missing_sections) === JSON.stringify(['## 取舍']),
      '★ 缺的那一节精确列出（只有取舍，不是三条全报）', JSON.stringify(g.missing_sections));
    ok(JSON.stringify(g.empty_sections) === JSON.stringify(['## 方案']),
      '★★ 空壳那一节单独列出 —— 「还没写到那儿」和「放了个空壳」是两件事',
      JSON.stringify(g.empty_sections));
  }

  console.log('\n【5】齐了 → 够格');
  {
    write('DESIGN.md', '# 设计\n\n## 问题\n现在轮到谁没人知道。\n\n## 方案\n状态存房间上。\n\n## 取舍\n宁可慢。\n');
    const g = rooms.stageGate(TMP, DESIGN);
    ok(g.ok === true, '★ 够格了', JSON.stringify(g.reasons));
    ok(g.missing_sections.length === 0 && g.empty_sections.length === 0, '没有缺的也没有空的');
    ok(g.checked_sections.length === 3,
      '★ 报出**实际检查了哪几节** —— 让检查打出它检查了什么',
      JSON.stringify(g.checked_sections));
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【6】★ 前缀匹配：多写几个字不该让流程停下，但层级要管住');
  {
    write('DESIGN.md', '## 问题与背景\n有。\n## 方案（第二版）\n有。\n## 取舍\n有。\n');
    ok(rooms.stageGate(TMP, DESIGN).ok === true,
      '★ `## 问题与背景` 满足 `## 问题` —— 全等匹配的话，人多写三个字流程就停了，而他看不出为什么');

    write('DESIGN.md', '### 问题\n有。\n## 方案\n有。\n## 取舍\n有。\n');
    const g = rooms.stageGate(TMP, DESIGN);
    ok(g.ok === false && g.missing_sections.includes('## 问题'),
      '★★ 阴性对照：`### 问题` **不**满足 `## 问题`（层级不同）',
      JSON.stringify(g.missing_sections));
  }

  console.log('\n【7】★★ 围栏里的 `#` 不是标题 —— 否则判据能被一个代码块绕过');
  {
    write('DESIGN.md', '# 设计\n\n```\n## 问题\n## 方案\n## 取舍\n```\n');
    ok(looksDoneToWeakGate('DESIGN.md'),
      '★ 正控：全文**确实包含**那三个字符串 —— 一个 `text.includes()` 的实现会放行');
    const g = rooms.stageGate(TMP, DESIGN);
    ok(g.ok === false && g.missing_sections.length === 3,
      '★★ 而 stageGate 判三节全缺：它们在代码块里，一个都不是标题',
      JSON.stringify(g.missing_sections));
  }

  console.log('\n【8】★ 子标题不截断小节 —— 内容写在 `###` 下面也算数');
  {
    write('DESIGN.md', '## 问题\n### 细节\n正文在子标题下面。\n\n## 方案\n有。\n\n## 取舍\n有。\n');
    const g = rooms.stageGate(TMP, DESIGN);
    ok(g.ok === true,
      '★ 用「下一个任意标题」截断的实现会把这里判成空小节 —— 那是个假红灯，症状同样是流程停在原地',
      JSON.stringify(g.empty_sections));
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【9】review 的判决词');
  {
    write('REVIEW.md', '## 判决\n通过。设计站得住。\n');
    let g = rooms.stageGate(TMP, REVIEW);
    ok(g.ok === true && g.verdict === '通过', '★ 读出「通过」', JSON.stringify(g.verdict));

    write('REVIEW.md', '## 判决\n打回，第二节没说清。\n');
    g = rooms.stageGate(TMP, REVIEW);
    ok(g.ok === true && g.verdict === '打回', '★ 读出「打回」', JSON.stringify(g.verdict));

    write('REVIEW.md', '## 判决\n还行吧。\n');
    g = rooms.stageGate(TMP, REVIEW);
    ok(g.ok === false && g.verdict === null,
      '★ 一个判决词都没有 → 不够格（不是默认通过）', JSON.stringify(g.reasons));
    ok(g.reasons.join('').includes('通过') && g.reasons.join('').includes('打回'),
      '★ 理由里列出合法判决词有哪些');

    write('REVIEW.md', '## 判决\n大体通过，但第三节打回重写。\n');
    g = rooms.stageGate(TMP, REVIEW);
    ok(g.ok === false && g.verdict === null,
      '★★ 两个判决词同时出现 → **拒绝**，不是取第一个 —— '
      + '取第一个等于让排版顺序决定流程走向，而写的人不知道有这条规则',
      JSON.stringify(g.reasons));
  }

  console.log('\n【10】★★ 判决词只在判决小节里找，不在全文里找');
  {
    write('REVIEW.md', '## 背景\n上一轮被打回过，这次已经改了。\n\n## 判决\n通过。\n');
    const g = rooms.stageGate(TMP, REVIEW);
    ok(g.verdict === '通过' && g.ok === true,
      '★★ 正文里的「打回」不算数 —— 全文搜的实现会把这份判成两个词冲突（或直接判成打回），'
      + '而它的判决其实是通过', JSON.stringify([g.verdict, g.reasons]));
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【11】produces 不安全 → 拒绝，不去找一个永远找不到的文件');
  {
    for (const bad of ['../../../etc/passwd', 'a/b.md', 'ADR-NNN-*.md', '', null, '..']) {
      const g = rooms.stageGate(TMP, { ...DESIGN, produces: bad });
      ok(g.ok === false && g.exists === false,
        `拒绝 produces=${JSON.stringify(bad)}`, JSON.stringify(g.reasons));
    }
    ok(rooms.safeProduces('DESIGN.md') === true, '★ 阴性对照：正常文件名照常通过');
  }

  console.log('\n【12】★ requires 为空 → 判据退化了，必须说出来');
  {
    write('X.md', 'x');
    const g = rooms.stageGate(TMP, { name: 'x', produces: 'X.md' });
    ok(g.ok === true, '一个字节也通过（这就是退化）');
    ok(g.reasons.join('').includes('只查'),
      '★★ 但 reasons 明说了「只查到文件存在且非空」—— '
      + '不说的话，调用方看到 ok:true 会以为结构查过了', JSON.stringify(g.reasons));
    ok(g.checked_sections.length === 0, 'checked_sections 是空的，不假装查过');
  }

  // ───────────────────────────────────────────────────────────────
  const redis = q.createClient();
  await cleanupRooms(redis);

  console.log('\n【13】★★ flow_dir 是**存下来的**，不是算出来的');
  {
    ok(rooms.slugify('EngLoop Improve!') === 'engloop-improve', 'slug 正常', rooms.slugify('EngLoop Improve!'));
    ok(rooms.slugify('   ') === 'room', '空名字有兜底');

    const a = await rooms.create(redis, `${PREFIX}engloop improve`, { flow: 'design-spec-build' });
    ok(a.flow_dir === `docs/flows/${a.hash}-test-gate-engloop-improve`,
      '★ 绑流程时生成一次：<room_hash>-<slug>（hash 保唯一，slug 保可读）', a.flow_dir);
    ok(rooms.flowDirFor(a) === path.join(rooms.REPO_ROOT, a.flow_dir),
      'flowDirFor 把它拼成绝对路径', rooms.flowDirFor(a));
    ok(!path.isAbsolute(a.flow_dir),
      '★ meta 里存的是**相对**路径 —— 绝对路径换台机器就错了，而 meta 是会被 dump/restore 的');

    const b = await rooms.create(redis, `${PREFIX}engloop improve`, { flow: 'design-spec-build' });
    ok(a.flow_dir !== b.flow_dir,
      '★★ 两个**同名**房间目录不同 —— 「按房间名推导」的实现在这条红',
      `${a.flow_dir} vs ${b.flow_dir}`);

    // ★★ 改名不影响：这条是「存下来」相对「推导」的全部价值所在
    const meta = await rooms.get(redis, a.hash);
    meta.name = `${PREFIX}改了个名`;
    await redis.set(rooms.META(a.hash), JSON.stringify(meta));
    const renamed = await rooms.get(redis, a.hash);
    ok(renamed.name !== a.name, '正控：名字确实改了', renamed.name);
    ok(renamed.flow_dir === a.flow_dir,
      '★★ 而 flow_dir 一个字没变 —— 从可变的东西推导，改名那天目录就分叉了，'
      + '症状是「我昨天写的 DESIGN.md 不见了」，而不是任何一条报错', renamed.flow_dir);

    // ⛔ 不兜底
    const noDir = await rooms.create(redis, `${PREFIX}没目录`,
      { flow: 'design-spec-build', flow_dir: null });
    let threw = null;
    try { rooms.flowDirFor(noDir); } catch (e) { threw = e; }
    ok(threw && threw.code === rooms.FLOW_DIR_MISSING,
      '★★ 绑了流程却没有 flow_dir → **报错**，不算一个出来', threw && threw.message);
    ok(threw && /不替你算一个/.test(threw.message),
      '★ 错误里说清为什么不兜底：算出来的规则和存下来的规则将来会分叉，而分叉不报错');

    for (const bad of ['/etc/passwd', '../../etc', 'docs/../../etc', '']) {
      let t = null;
      try { rooms.flowDirFor({ hash: 'x', flow_dir: bad }); } catch (e) { t = e; }
      ok(t && t.code === rooms.FLOW_DIR_MISSING,
        `拒绝 flow_dir=${JSON.stringify(bad)}（它存在 redis 上，是外部写得进去的）`);
    }

    const plain2 = await rooms.create(redis, `${PREFIX}普通房间2`);
    ok(plain2.flow_dir === null, '★ 阴性对照：不绑流程就没有 flow_dir');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【14】roomGate：接起来，但非 running 的房间不判据');
  {
    const plain = await rooms.create(redis, `${PREFIX}普通房间`);
    const r1 = await rooms.roomGate(redis, plain.hash, { baseDir: TMP });
    ok(r1.can_advance === false, '普通房间不能推进');
    ok(r1.gate === null,
      '★★ 而且 gate 是 null —— 没走判据。「没绑流程」和「DESIGN.md 缺一节」'
      + '合成一个 ok:false 的话，人查到这里就断线了');
    ok(r1.why.includes(rooms.FLOW_STATE.NO_FLOW), 'why 里说得出现在是哪个 state', r1.why);

    const running = await rooms.create(redis, `${PREFIX}进行中`,
      { flow: 'design-spec-build', stage: 'design', assignee: 'arch' });

    write('DESIGN.md', '## 问题\n## 方案\n## 取舍\n');   // 只有标题
    const r2 = await rooms.roomGate(redis, running.hash, { baseDir: TMP });
    ok(r2.can_advance === false && r2.gate && r2.gate.empty_sections.length === 3,
      '★★ running 的房间真的走了判据，而只有标题的产出**不推进**', r2.why);
    ok(r2.state === rooms.FLOW_STATE.RUNNING && r2.stage === 'design',
      'roomGate 顺带把状态一起带出来（少打一次 flowStatus）');

    write('DESIGN.md', '## 问题\n有。\n## 方案\n有。\n## 取舍\n有。\n');
    const r3 = await rooms.roomGate(redis, running.hash, { baseDir: TMP });
    ok(r3.can_advance === true, '★ 补上正文之后够格了 —— 判据真的在看文件内容，不是看房间状态');

    // ⛔ 只读：判据说了「够格」，但状态一个字都没变
    const after = await rooms.get(redis, running.hash);
    ok(after.stage === 'design' && after.assignee === 'arch',
      '★★ can_advance:true 之后 stage/assignee **原封不动** —— '
      + '这一步只回答问题，推进是第四步');

    const gone = await rooms.create(redis, `${PREFIX}目录不存在`,
      { flow: 'design-spec-build', stage: 'design', assignee: 'arch' });
    const r4 = await rooms.roomGate(redis, gone.hash,
      { baseDir: path.join(TMP, '并不存在的子目录') });
    ok(r4.can_advance === false && r4.gate.exists === false,
      '★ 目录整个不存在也是「不够格」，不是抛异常', r4.why);

    // ★★ 缺 flow_dir：一个**可预期**的坏状态（老房间被事后绑流程就会这样）
    const noDir = await rooms.create(redis, `${PREFIX}running无目录`,
      { flow: 'design-spec-build', stage: 'design', assignee: 'arch', flow_dir: null });
    const r5 = await rooms.roomGate(redis, noDir.hash);   // ★ 故意不注入 baseDir
    ok(r5.can_advance === false && r5.error_code === rooms.FLOW_DIR_MISSING,
      '★★ running 但缺 flow_dir → 不推进，并给出 error_code —— '
      + '抛出去的话调用方多半会吞掉，而它要的恰恰是「为什么推不动」这句话', r5.why);
    ok(r5.gate === null, '★ 没走判据（连去哪找文件都不知道，判什么）');
    ok(r5.why.includes('不替你算一个'), '★ why 里带着「为什么不兜底」', r5.why);

    const st5 = await rooms.flowStatus(redis, noDir.hash);
    ok(st5.note.includes('却没有 flow_dir'),
      '★ flowStatus 也把这个缺口说出来 —— 不用等到 roomGate 才发现', st5.note.slice(-80));
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【15】★★ 这份产出是不是**这一轮**的（stage_entered_at vs mtime）');
  {
    write('DESIGN.md', '## 问题\n有。\n## 方案\n有。\n## 取舍\n有。\n');
    const fileMs = fs.statSync(path.join(TMP, 'DESIGN.md')).mtimeMs;

    // 本轮开始于文件写完**之后** → 这份是上一轮遗留的
    const g1 = rooms.stageGate(TMP, DESIGN, { since: new Date(fileMs + 1000).toISOString() });
    ok(g1.ok === false && g1.stale === true, '★★ 旧产出不够格');
    ok(g1.missing_sections.length === 0 && g1.empty_sections.length === 0,
      '★ 正控：拒绝的理由**不是**结构问题 —— 结构完全合格，'
      + '正是这一点让旧产出能在只查结构的判据下蒙混过关');
    ok(g1.reasons.join('').includes('本轮之前'), '理由说清了', JSON.stringify(g1.reasons));

    // 本轮开始于文件写完**之前** → 这份是本轮的
    const g2 = rooms.stageGate(TMP, DESIGN, { since: new Date(fileMs - 1000).toISOString() });
    ok(g2.ok === true && g2.stale === false, '★ 阴性对照：本轮写的就够格');
    ok(g2.reasons.join('').includes('touch'),
      '★★ 措辞如实：只验到「被写过」这一层，touch 一下就满足', JSON.stringify(g2.reasons));
    ok(!g2.reasons.join('').includes('已重做') && !g2.reasons.join('').includes('内容已更新'),
      '★★ 不出现它证明不了的词 —— 判据没法知道内容有没有真的改');

    // ⚠️ 这里**必须直接传数字**。传 `new Date(Math.floor(fileMs)).toISOString()` 不行：
    //   mtimeMs 带小数（1786…368.123）—— floor 之后的时间**严格小于**它，
    //   于是这条根本不是「同毫秒」，`<=` 的变异照样绿。
    //   **一条声称测 X 的断言，其实没测到 X。**
    ok(rooms.toMs(fileMs) === fileMs, '正控：toMs 原样接受数字（这条是上面那句的前提）');
    ok(rooms.stageGate(TMP, DESIGN, { since: fileMs }).ok === true,
      '★ 同毫秒算本轮（`>=`）—— 反过来会把刚写的文件判成旧的，那是个假红灯');

    // 缺字段 / 坏字段 → 判据退化，两种都要自曝，而且说的不是同一句话
    const g3 = rooms.stageGate(TMP, DESIGN);
    ok(g3.ok === true && g3.since_ms === null, '没有 since 时不做比对（退化）');
    ok(g3.reasons.join('').includes('没做'),
      '★★ 而且**自曝**：一份上一轮遗留的文件在这里会被判为够格', JSON.stringify(g3.reasons));

    const g4 = rooms.stageGate(TMP, DESIGN, { since: '不是一个时间' });
    ok(g4.ok === true && g4.since_ms === null, '坏时间戳同样不做比对');
    ok(g4.reasons.join('').includes('解析不出'),
      '★ 坏数据导致的退化，跟「没有这个字段」一样要说出来');
    ok(g3.reasons.join('') !== g4.reasons.join(''),
      '★★ 两种退化说的不是同一句话 —— 「字段没有」和「字段是坏的」，修法不同');

    // requires 为空的阶段也要过这条比对，否则那是个绕过口
    write('X.md', 'x');
    const xMs = fs.statSync(path.join(TMP, 'X.md')).mtimeMs;
    const g5 = rooms.stageGate(TMP, { name: 'x', produces: 'X.md' },
      { since: new Date(xMs + 1000).toISOString() });
    ok(g5.ok === false && g5.stale === true,
      '★★ requires 为空的阶段**也**逃不过本轮比对 —— 那条早返回是个天然的绕过口');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【16】★★ 端到端：打回退回 spec，旧 SPEC.md 不该让流程立刻转回去');
  {
    // 上一轮的 SPEC.md（结构完整）
    write('SPEC.md', '## 范围\n上一轮写的。\n## 验收判据\n上一轮写的。\n');
    // ⚠️ 必须让 write 严格早于 create 至少 1ms，否则同毫秒会被 `>=` 放行，
    //    这条测试就成了随机红绿的 flaky。
    await new Promise((r) => setTimeout(r, 20));

    const room = await rooms.create(redis, `${PREFIX}打回重做`,
      { flow: 'design-spec-build', stage: 'spec', assignee: 'senior' });
    ok(!!room.stage_entered_at, '★ create 带 stage 时顺手落了 stage_entered_at', room.stage_entered_at);

    const g = await rooms.roomGate(redis, room.hash, { baseDir: TMP });
    ok(g.can_advance === false && g.gate.stale === true,
      '★★ 旧 SPEC.md 结构完整，但它是打回**之前**写的 → 不推进。'
      + '少了这条，第四步会立刻把它推回 review，**senior 根本没机会重做**', g.why);
    ok(g.gate.missing_sections.length === 0 && g.gate.empty_sections.length === 0,
      '★ 正控：结构确实是完整的 —— 只查结构的判据到这里会放行，流程开始转圈');

    await new Promise((r) => setTimeout(r, 20));
    write('SPEC.md', '## 范围\n这一轮重写的。\n## 验收判据\n这一轮重写的。\n');
    const g2 = await rooms.roomGate(redis, room.hash, { baseDir: TMP });
    ok(g2.can_advance === true, '★ senior 真的重写之后才够格', g2.why);

    // 缺 stage_entered_at 的房间：判据退化，flowStatus 和 roomGate 两边都要说
    const noTs = await rooms.create(redis, `${PREFIX}没时间戳`,
      { flow: 'design-spec-build', stage: 'spec', assignee: 'senior', stage_entered_at: null });
    const g3 = await rooms.roomGate(redis, noTs.hash, { baseDir: TMP });
    ok(g3.can_advance === true && g3.why.includes('没做'),
      '★ 缺 stage_entered_at → 比对退化（够格），但 why 里喊出来了', g3.why);
    const st = await rooms.flowStatus(redis, noTs.hash);
    ok(st.note.includes('没有 stage_entered_at'),
      '★★ flowStatus 也说 —— 同一个缺口在两个入口都答得出，人从哪边进来都不会被卡住');
  }

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
