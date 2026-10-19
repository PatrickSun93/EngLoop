'use strict';

/**
 * 规格冻结 + 模板漂移检测。
 *
 * ── 它守的是什么 ──────────────────────────────────────────────────
 * 没有冻结时，`TASKS.md` 可以在 dev 正在读它的时候被改好几版。
 * 各方为了回答「手上这份是不是 gate 认的那份」，只能临时拿 md5 互相核对，
 * 来回的「推进停住 → 推进恢复」「独立验过」「别按错版本开工」
 * **没有一条推进了任何工作。**
 *
 * ── 🔴 这份测试的中心是四条正控 ─────────────────────────────────
 *   M2  把 `survey` 插在**中间** → `stageDrift` **必须**检出
 *   F2  gate 过后改产出一个字节 → `frozenCheck` **必须**红
 *   F3  （反向）不改时 **不许**误报
 *   U2  `diff_note` 为空 → `unfreeze` **必须**拒绝
 * **少一条，对应的判据就可能是恒真的。**
 */

const fs = require('node:fs');
const path = require('node:path');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const rooms = require('../lib/rooms');

let pass = 0; let fail = 0;
const ok = (c, l, d = '') => (c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`)));

const TPL_NAME = 'flowtest-freeze';
const TPL = path.join(rooms.FLOW_DIR, `${TPL_NAME}.json`);
const ROOM = 'TEST-FREEZE-room';

const BASE = [
  { name: 'tasks', role: 'senior', produces: 'TASKS.md', requires: ['## A'] },
  { name: 'dev', role: 'dev', produces: 'DEV_REPORT.md', requires: ['## B'] },
  { name: 'review', role: 'senior', produces: 'REVIEW.md', requires: ['## C'], verdict: ['通过', '打回'] },
];
const SURVEY = { name: 'survey', role: 'dev', produces: 'SURVEY.md', requires: ['## S'] };

const writeTpl = (stages) => fs.writeFileSync(TPL, JSON.stringify({
  description: '测试用，跑完即删',
  stages,
  on_reject: 'dev',
  reject_verdict: '打回',
}, null, 2));

async function main() {
  const redis = q.createClient();
  // 🔴 这个文件会 del 房间、写 protocols/flows/ 下的临时模板 —— 只能在测试库上跑。
  //   （`lib/queue.js` 的测试库判据错一次，`del` 掉的就是生产的编排者收件流。）
  if (!q.isTestProcess() || redis.options.db === 0) {
    console.error(`🔴 拒绝运行：只能在测试库上跑。isTestProcess=${q.isTestProcess()} db=${redis.options.db}`);
    process.exit(1);
  }

  // ══ 【0】stageDrift —— 纯函数，M 组那条正控的核心 ═══════════════════
  //   ★ 端到端只能验「这一次」，喂数据能验「这一类」。
  console.log('\n【0】stageDrift：三种返回值必须分得开');
  const OLD = ['tasks', 'dev', 'review'];
  const FIRST = ['survey', 'tasks', 'dev', 'review'];
  const MID = ['tasks', 'survey', 'dev', 'review'];
  const RENAME = ['planning', 'dev', 'review'];

  ok(rooms.stageDrift(OLD, FIRST, 'tasks') === null,
    '加在**最前** → null（安全改动，不报，不制造噪音）',
    JSON.stringify(rooms.stageDrift(OLD, FIRST, 'tasks')));
  const mid = rooms.stageDrift(OLD, MID, 'tasks');
  ok(mid && mid.kind === 'next_changed' && mid.from === 'dev' && mid.to === 'survey',
    '🔴 M2 正控：插在**中间** → 检出 next_changed（dev → survey）', JSON.stringify(mid));
  const gone = rooms.stageDrift(OLD, RENAME, 'tasks');
  ok(gone && gone.kind === 'stage_gone', '改名 → stage_gone', JSON.stringify(gone));
  ok(rooms.stageDrift(OLD, FIRST, 'review') === null, '末格（新旧都走向 done）→ null');

  // ★★ 「判不了」必须**跟「没变」长得不一样** —— 两种都返回 null 的话，
  //   就只能靠一句注释「不许读成安全」拦着：
  //   **注释拦不住下一个人写 `if (!drift) { /* 安全 */ }`，而那行看起来完全正常。**
  const unk = rooms.stageDrift(null, MID, 'tasks');
  ok(unk && unk.kind === 'unknown', '🔴 判不了 → `{kind:"unknown"}`（**真值**）', JSON.stringify(unk));
  ok(!!unk === true && !!rooms.stageDrift(OLD, FIRST, 'tasks') === false,
    '★ `if (drift)` 这种最自然的写法：**「判不了」进分支、「没变」不进** —— 不需要任何人记得');
  const bad = rooms.stageDrift(OLD, MID, 'nosuchstage');
  ok(bad && bad.kind === 'unknown', 'stage 不在快照序列里 → unknown（状态坏了，不是「没影响」）');

  // ══ 造现场 ═══════════════════════════════════════════════════════
  await roster.register(redis, 'senior', { type: 'dev' }, 300);
  await roster.register(redis, 'dev', { type: 'dev' }, 300);
  writeTpl(BASE.slice());
  const hash = rooms.makeFlowDir ? null : null;   // 占位：下面用 create 的返回值
  const room = await rooms.create(redis, ROOM);
  const h = room.hash || room;
  await rooms.bindFlow(redis, h, TPL_NAME);
  const meta0 = await rooms.get(redis, h);
  const dir = rooms.flowDirFor(meta0);
  fs.mkdirSync(dir, { recursive: true });

  console.log('\n【1】bindFlow 记下了阶段序列（漂移检测的前提）');
  ok(meta0.flow_snapshot && Array.isArray(meta0.flow_snapshot.stages),
    'meta.flow_snapshot.stages 存在', JSON.stringify(meta0.flow_snapshot));
  ok(meta0.flow_snapshot.stages.join(',') === 'tasks,dev,review',
    '记的是**名字序列**，不是整份 def（别的字段改了不影响走哪一格，存进来只会变噪音）');

  // 启动 → survey?（这个模板没有 survey）→ tasks
  await rooms.advance(redis, h, { from: 'JARVIS' });
  let g = await rooms.roomGate(redis, h);
  ok(g.stage === 'tasks', `（前置）启动后在 tasks（实际 ${g.stage}）`);
  ok(g.next && g.next.name === 'dev', `（前置）下一格是 dev（实际 ${g.next && g.next.name}）`);

  console.log('\n【2】M1 / M2 / M3：改一个**正在被用**的模板');
  writeTpl([SURVEY, ...BASE]);                                  // 加在最前
  g = await rooms.roomGate(redis, h);
  ok(g.stage === 'tasks' && g.next && g.next.name === 'dev',
    'M1 加在**最前** → `(cur, nxt)` 一个都没变（下标各 +1，相对顺序不变）',
    JSON.stringify({ stage: g.stage, next: g.next && g.next.name }));
  ok(g.drift === null, 'M1 而且 drift 是 null（**查过了，没变**）', JSON.stringify(g.drift));

  writeTpl([BASE[0], SURVEY, ...BASE.slice(1)]);                // 插在中间
  g = await rooms.roomGate(redis, h);
  ok(g.next && g.next.name === 'survey',
    '（现场）插在中间 → 房间的下一格真的变了（dev → survey）', JSON.stringify(g.next));
  ok(g.state === rooms.FLOW_STATE.RUNNING,
    '（现场）而 state 仍是 running、`validateFlow` 也通过 —— **原来零信号的就是这一格**');
  ok(g.drift && g.drift.kind === 'next_changed' && g.drift.from === 'dev' && g.drift.to === 'survey',
    '🔴 M2 正控：`drift` 把它**检出来了**', JSON.stringify(g.drift));
  ok(/被改道/.test(String(g.note || '')), 'M2 note 里也说了（文本给人读，字段给程序判）');

  writeTpl([{ ...BASE[0], name: 'planning' }, ...BASE.slice(1)]); // 改名
  g = await rooms.roomGate(redis, h);
  ok(g.state === rooms.FLOW_STATE.INVALID_STAGE,
    'M3 改现有阶段名 → INVALID_STAGE（这一条本来就有防护，会响）', String(g.state));

  writeTpl([SURVEY, ...BASE]);                                  // 复位成安全版

  // ══ 【3】F 组：冻结 ═══════════════════════════════════════════════
  console.log('\n【3】F1–F4：冻结');
  const tasksMd = path.join(dir, 'TASKS.md');
  fs.writeFileSync(tasksMd, '## A\n第一版内容\n');
  const adv = await rooms.advance(redis, h, { from: 'JARVIS' });
  ok(adv.advanced && adv.to_stage === 'dev', `（前置）tasks 通过 gate，推进到 dev（${adv.to_stage}）`, adv.why);

  const meta1 = await rooms.get(redis, h);
  ok(meta1.frozen && meta1.frozen.md5 && meta1.frozen.file === 'TASKS.md'
     && meta1.frozen.stage === 'tasks' && typeof meta1.frozen.bytes === 'number' && meta1.frozen.at,
  'F1 meta.frozen 有 stage / file / md5 / bytes / at', JSON.stringify(meta1.frozen));
  ok(meta1.frozen.md5 === rooms.md5Of('## A\n第一版内容\n'),
    'F1 md5 算的是**gate 判定时读到的那份文本**（跟手算的一致）');

  const c1 = await rooms.frozenCheck(redis, h);
  ok(c1.ok === true, 'F3 正控（反向）：**没改动时不许误报**', JSON.stringify(c1).slice(0, 120));
  ok(/对上了/.test(c1.reason), 'F4 而且它自己说得出结论 —— dev 不用问任何人');

  fs.writeFileSync(tasksMd, '## A\n第一版内容\n ');           // 改一个字节（末尾加空格）
  const c2 = await rooms.frozenCheck(redis, h);
  ok(c2.ok === false, '🔴 F2 正控：gate 过后改**一个字节** → 校验必须红', JSON.stringify(c2).slice(0, 120));
  ok(/没有任何解冻记录/.test(c2.reason) && /停下来问/.test(c2.reason),
    'F2 而且它分得开「被静默改过」和「你拿错了文件」，并叫人停下来问', c2.reason.slice(0, 100));

  // ══ 【4】U 组：解冻 ═══════════════════════════════════════════════
  console.log('\n【4】U1–U4：解冻');
  let threw = null;
  try { await rooms.unfreeze(redis, h, { to_md5: 'x', by: 'senior', diff_note: '   ' }); }
  catch (e) { threw = e; }
  ok(!!threw && /diff_note/.test(String(threw.message)),
    '🔴 U2 正控：`diff_note` 空 → **拒绝解冻**', String(threw && threw.message).slice(0, 80));

  const before = (await rooms.get(redis, h)).frozen.md5;
  const newMd5 = rooms.md5Of(fs.readFileSync(tasksMd, 'utf8'));
  const list = await rooms.unfreeze(redis, h, {
    to_md5: newMd5, by: 'senior',
    diff_note: '判据没动，只补理由；dev 已做的 C/D 两组不受影响。',
  });
  const meta2 = await rooms.get(redis, h);
  ok(Array.isArray(list) && list.length === 1, 'U1 解冻**追加**一条记录', JSON.stringify(list).slice(0, 90));
  ok(list[0].from_md5 === before, 'U1 旧 md5 **留在链上**（不是被清掉）', list[0].from_md5);
  ok(meta2.frozen && meta2.frozen.md5 === newMd5, 'U1 而 frozen.md5 更新到新版（两个问题两个答案）');

  const c3 = await rooms.frozenCheck(redis, h);
  ok(c3.ok === true, 'U3 解冻后对得上了（这条路被真的走了一遍）');

  fs.writeFileSync(tasksMd, '## A\n第三版\n');                 // 再改一次，制造对不上
  const c4 = await rooms.frozenCheck(redis, h);
  ok(c4.ok === false && /被正式解冻过 1 次/.test(c4.reason) && /不受影响/.test(c4.reason),
    'U4 对不上时说得出「**它变了，变了这些**」，而不只是「对不上」', c4.reason.slice(0, 120));

  // ══ 【5】S3：survey 的 requires 正控 ══════════════════════════════
  console.log('\n【5】S3 正控：SURVEY.md 缺一节 → gate 必须不过');
  const surveyDef = SURVEY;
  fs.writeFileSync(path.join(dir, 'SURVEY.md'), '（连标题都没有）\n');
  // ⚠️ 签名是 `stageGate(baseDir, stageDef, { since })`，返回字段是 `ok` 不是 `pass` ——
  //   参数顺序写反（`(stageDef, baseDir, …)`）的话，两条都会红在
  //   「没给阶段定义 —— 判不了」上。**那条 reason 正确地说了它判不了**，
  //   而不是默默返回 false —— 否则这两条会假绿（第一条期望的就是 false）。
  const gateBad = rooms.stageGate(dir, surveyDef, { since: new Date(0).toISOString() });
  ok(gateBad.ok === false, '🔴 缺小节 → 不通过', JSON.stringify(gateBad.reasons || []).slice(0, 110));
  fs.writeFileSync(path.join(dir, 'SURVEY.md'), '## S\n数了 93 条。\n');
  const gateOk = rooms.stageGate(dir, surveyDef, { since: new Date(0).toISOString() });
  ok(gateOk.ok === true, '（反向）补上小节 → 通过 —— 判据有分辨力，不是恒假',
    JSON.stringify(gateOk.reasons || []).slice(0, 110));

  // ══ 【6】S2：**真** senior-dev.json 跑到底 survey → tasks → dev → review ══
  //   ⚠️ 用的是仓库里那份真模板（不是副本）—— S2 要验的正是「加了 survey 之后
  //     这条流程还走得通」，而验一个副本只能证明副本走得通。
  //   ⚠️ 但房间是测试房间、库是测试库 ⇒ 生产的房间一个都不碰。
  console.log('\n【6】S2：真 senior-dev.json 跑到底');
  const room2 = await rooms.create(redis, 'TEST-FREEZE-e2e');
  const h2 = room2.hash || room2;
  await rooms.bindFlow(redis, h2, 'senior-dev');
  const meta2b = await rooms.get(redis, h2);
  const dir2 = rooms.flowDirFor(meta2b);
  fs.mkdirSync(dir2, { recursive: true });
  ok(meta2b.flow_snapshot.stages.join(' → ') === 'survey → tasks → dev → review',
    'S2 绑上真模板，四格顺序是 survey → tasks → dev → review',
    JSON.stringify(meta2b.flow_snapshot.stages));

  const PRODUCE = {
    survey: ['SURVEY.md', '## 我数了什么\n数了 x\n## 数出来是多少\n93\n## 这推翻了什么假设\n推翻了 63\n## 我没查的\n别的房间\n'],
    tasks: ['TASKS.md', '## 我的理解\nx\n## 任务清单\nx\n## 验收判据\nx\n'],
    dev: ['DEV_REPORT.md', '## 改了什么\nx\n## 验了什么在哪验的\nx\n'],
    // ★ 判决词写在「## 判决」下：
    //   `senior-dev.json` 的 review 阶段有 `verdict_in: "## 判决"`。
    //   ⚠️ 没有它的话 `readVerdict` 用 `verdict_in || requires[0]`，
    //     而 `requires[0]` 是「## 逐条对账」—— **那一节天生就要讨论判据，
    //     因而天生就会写到「打回」二字**。流水线能通过，只是因为那一节里「打回」恰好 0 次。
    //     ★ 一个只在「写得仔细」时才发作的缺陷 —— **它专门惩罚认真的那一次。**
    review: ['REVIEW.md', '## 逐条对账\n这条不成立就该打回。\n## 判决\n通过\n'],
  };
  const walked = [];
  let step = await rooms.advance(redis, h2, { from: 'JARVIS' });   // 启动 → survey
  walked.push(step.to_stage);
  // ⚠️ 循环上限要**比阶段数多一次** —— 最后那次是 review → done。
  //   写成 `i < 4` 会停在 review：走到了最后一格，但没走**出去**。
  //   ★ 「跑到底」的判据是走到 `STAGE_DONE`，不是「走完四格」——
  //     而那两个数差 1，写错了看起来像「差一点」，实际是漏了整条收尾路径。
  for (let i = 0; i < 6 && step.advanced; i++) {
    const st = step.to_stage;
    if (st === rooms.STAGE_DONE) break;
    const [file, body] = PRODUCE[st];
    fs.writeFileSync(path.join(dir2, file), body);
    step = await rooms.advance(redis, h2, { from: 'JARVIS' });
    if (step.advanced) walked.push(step.to_stage);
  }
  ok(walked.join(' → ') === `survey → tasks → dev → review → ${rooms.STAGE_DONE}`,
    `S2 逐格推进走到底：${walked.join(' → ')}`,
    `walked=${JSON.stringify(walked)} 最后一次 advance: advanced=${step.advanced} why=${step.why}`);

  const metaEnd = await rooms.get(redis, h2);
  ok(metaEnd.frozen && metaEnd.frozen.stage === 'review',
    'S2 每一格都冻了自己那一份，最后停在 review', JSON.stringify(metaEnd.frozen));
  // 清掉第二个测试房间
  fs.rmSync(dir2, { recursive: true, force: true });
  await redis.del(rooms.META(h2));
  await redis.srem(rooms.INDEX, h2).catch(() => {});
  await redis.del(`room:${h2}`);

  // ══ 【7】V 组：判决词从**哪一节**读 ═════════════════════════════════
  console.log('\n【7】V1–V3：verdict_in');
  const realRev = rooms.loadFlow('senior-dev').stages.find((x) => x.name === 'review');
  ok(realRev && realRev.verdict_in === '## 判决',
    'V2（前置）senior-dev 的 review 阶段有 verdict_in', JSON.stringify(realRev && realRev.verdict_in));
  for (const n of ['senior-dev', 'design-spec-build']) {
    ok(rooms.validateFlow(rooms.loadFlow(n)) === null,
      `V2 ${n} 加完之后 validateFlow 仍返回 null`, String(rooms.validateFlow(rooms.loadFlow(n))));
  }
  // 🔴 V1 正控：**「## 逐条对账」里放「打回」**，而「## 判决」写「通过」
  //   —— 不加这条，没有任何东西证明 `verdict_in` 真的被读了
  //   （不加 verdict_in 时这份文本会被读成「打回」）。
  const v1 = rooms.readVerdict('## 逐条对账\nM2 那条不成立就该打回。\n## 判决\n通过\n', realRev);
  ok(v1.verdict === '通过',
    '🔴 V1 正控：对账节里有「打回」、判决节写「通过」→ 读出**通过**', JSON.stringify(v1));
  // ★ 反过来喂一次：把 verdict_in 拿掉 ——必须读成别的
  const revNoVin = { ...realRev }; delete revNoVin.verdict_in;
  const v1b = rooms.readVerdict('## 逐条对账\nM2 那条不成立就该打回。\n## 判决\n通过\n', revNoVin);
  ok(v1b.verdict !== '通过',
    '★ V1 反证：**去掉 verdict_in 之后同一份文本读不出「通过」** —— 这条改动真的起了作用',
    JSON.stringify(v1b));
  // 🔴 V3 反向正控：判决节里同时出现两个词 → 必须拒绝猜
  const v3 = rooms.readVerdict('## 逐条对账\nx\n## 判决\n通过 打回\n', realRev);
  ok(v3.verdict === null && /判不出是哪一个/.test(String(v3.reason)),
    '🔴 V3 反向正控：判决节里两个词都有 → **报「判不出」，不替人猜**', JSON.stringify(v3).slice(0, 110));

  // ══ 清理 ═════════════════════════════════════════════════════════
  fs.rmSync(TPL, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  await redis.del(rooms.META(h));
  await redis.srem(rooms.INDEX, h).catch(() => {});
  await redis.del(`room:${h}`);
  await roster.unregister(redis, 'senior');
  await roster.unregister(redis, 'dev');
  ok(!fs.existsSync(TPL), '临时模板已删（`flowtest-*.json` 不许留在仓库里）');

  await redis.quit();
  console.log(`\n${'─'.repeat(50)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('✗ 异常:', e.stack || e.message);
  try { fs.rmSync(TPL, { force: true }); } catch (_) { /* ignore */ }
  process.exit(1);
});
