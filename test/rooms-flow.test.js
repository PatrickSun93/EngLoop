'use strict';

/**
 * 房间流程 —— meta 三个字段 + 向后兼容 + 只读状态查询。
 *
 * ⛔ 这份测试只验状态，不验推进、不验发消息，所以这里**一条断言都不该**去验
 *   「阶段推进了」或「谁收到了消息」（那两样另有测试）。
 *   分开测的理由：判据错的症状是「流程停在原地」，
 *   发消息错的症状是「有人收到不该收的活」，合起来测就分不清是哪一半坏了。
 *
 * ── 这份测试的两条要求（不接受「跑绿了」）──
 *
 * ① **向后兼容必须验在真的老数据上。** 「新建的房间能读出 flow:null」
 *    证不了任何东西 —— 新建的房间是测试自己写进去的，三个键本来就在。
 *    所以下面【2】直接往 redis 写一个**没有这三个键**的 JSON，
 *    而且先断言它确实没有（正控），再断言读出来是 null。
 *
 * ② **每组断言都要有分辨力。** 一个「flowStatus 永远返回 {state:null}」的
 *    空实现不许通过这份测试 —— 所以凡是断言「是 X」的地方，
 *    附近就有一条断言「另一个输入下**不是** X」。
 */

const fs = require('node:fs');
const path = require('node:path');
const q = require('../lib/queue');
const rooms = require('../lib/rooms');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const PREFIX = 'TEST-FLOW-';
const FLOW = 'design-spec-build';
// 临时的坏模板 —— 为了让 INVALID_FLOW 那条分支**真的被走到**，
// 而不是只靠纯函数 validateFlow 推断它会走到。finally 里删。
const BAD_FLOW = 'TESTBAD-broken-flow';
const BAD_PATH = path.join(rooms.FLOW_DIR, `${BAD_FLOW}.json`);

async function cleanup(redis) {
  for (const h of await redis.smembers(rooms.INDEX)) {
    const raw = await redis.get(rooms.META(h));
    // INDEX 里指向一个没有 META 的孤儿 —— 只摘索引，不碰别的
    if (!raw) { await redis.srem(rooms.INDEX, h); continue; }
    let m = null;
    try { m = JSON.parse(raw); } catch { /* 别人的坏数据不归这里清 */ }
    if (m && String(m.name || '').startsWith(PREFIX)) {
      await redis.del(rooms.META(h), rooms.stream(h));
      await redis.srem(rooms.INDEX, h);
    }
  }
}

/**
 * ⚠️ 删临时坏模板。**必须在 `process.exit()` 之前调用** ——
 * `process.exit` 是立即终止，promise 的 `.finally` 根本轮不到跑，
 * 文件会留在 `protocols/flows/` 里被下一个人当成真模板。
 * （所以两条出口路径各调一次，而不是指望一个统一的收尾钩子。）
 */
function rmBadFlow() {
  try { fs.unlinkSync(BAD_PATH); } catch { /* 没写成就没得删 */ }
}

/** 直接写一个**老格式**的 meta（没有 flow 三个键的形状）。 */
async function writeLegacyRoom(redis, name) {
  const hash = `legacy${Math.floor(Math.random() * 1e6)}`.slice(0, 12).padEnd(12, '0');
  const legacy = { hash, name, created_at: new Date().toISOString(), members: ['JARVIS'] };
  await redis.set(rooms.META(hash), JSON.stringify(legacy));
  await redis.sadd(rooms.INDEX, hash);
  return hash;
}

async function main() {
  const redis = q.createClient();
  await cleanup(redis);

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【1】流程模板：仓库里那个文件本身是好的');
  {
    const def = rooms.loadFlow(FLOW);
    ok(!!def, `protocols/flows/${FLOW}.json 读得到`);
    ok(rooms.validateFlow(def) === null,
      '★ 提交进仓库的模板通过体检 —— 这条守的是「数据文件没写坏」，'
      + '而模板写坏的症状是房间安静地推不动',
      String(rooms.validateFlow(def)));
    ok(Array.isArray(def.stages) && def.stages.length === 5,
      '五个阶段', def && JSON.stringify((def.stages || []).map((s) => s.name)));
    ok(def.stages[0].name === 'design' && def.stages[0].role === 'arch',
      '第一阶段是 design/arch');
    ok(def.on_reject === 'spec', 'review 打回退到 spec');
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【2】★★ 向后兼容 —— 验在**真的老数据**上，不是新建的房间');
  let legacyHash;
  {
    legacyHash = await writeLegacyRoom(redis, `${PREFIX}老房间`);

    // 正控：先证明这条数据**确实**没有那三个键。
    // 少了这一条，下面全组断言就可能是在一个「其实有键」的对象上平凡成立。
    const raw = JSON.parse(await redis.get(rooms.META(legacyHash)));
    ok(!('flow' in raw) && !('stage' in raw) && !('assignee' in raw)
      && !('flow_dir' in raw) && !('stage_entered_at' in raw),
      '★ 正控：写进去的确实是老格式（五个键一个都没有）', JSON.stringify(raw));

    let meta = null, threw = null;
    try { meta = await rooms.get(redis, legacyHash); } catch (e) { threw = e; }
    ok(threw === null, '★★ get() 读老 meta **不抛错**', threw && threw.message);
    ok(meta && meta.flow === null, '★★ flow 读出来是 null（不是 undefined）',
      meta && JSON.stringify(meta.flow));
    ok(meta && 'flow' in meta && 'stage' in meta && 'assignee' in meta
      && 'flow_dir' in meta && 'stage_entered_at' in meta,
      '★ 五个键都被补上了 —— `undefined` 和 `null` 不是一回事，'
      + '前者 JSON.stringify 之后整个键会消失',
      meta && JSON.stringify(Object.keys(meta)));
    ok(meta && meta.stage === null && meta.assignee === null
      && meta.flow_dir === null && meta.stage_entered_at === null,
      'stage / assignee / flow_dir / stage_entered_at 同样归一化');
    ok(meta && meta.members.length === 1 && meta.members[0] === 'JARVIS',
      '老数据的其它字段原样保留 —— 归一化不是覆盖');

    // list() 也走 get()，老房间不能让整个列表崩掉
    let listed = null, listThrew = null;
    try { listed = await rooms.list(redis); } catch (e) { listThrew = e; }
    ok(listThrew === null, 'list() 里混着老房间也不抛', listThrew && listThrew.message);
    ok(listed && listed.some((r) => r.hash === legacyHash && r.flow === null),
      'list() 返回的老房间同样归一化');

    // flowStatus 对老房间的判定
    const st = await rooms.flowStatus(redis, legacyHash);
    ok(st.state === rooms.FLOW_STATE.NO_FLOW,
      '★ 老房间 = 普通聊天房间（no_flow），不是「坏了」也不是「跑完了」', st.state);
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【3】lazy migration：老房间被 join 过之后，redis 里就带上三个键了');
  {
    await rooms.join(redis, legacyHash, 'dev2');
    const raw = JSON.parse(await redis.get(rooms.META(legacyHash)));
    ok('flow' in raw && raw.flow === null,
      '★ 写回去的 meta 带上了 flow:null（归一化的副作用，是好的）',
      JSON.stringify(raw));
    // ⚠️ 但**不能反过来依赖它**：从没被 join 过的房间永远是老格式。
    //    所以下面再造一个，证明「没被动过的老房间」照样读得对。
    const untouched = await writeLegacyRoom(redis, `${PREFIX}没被动过的老房间`);
    const m = await rooms.get(redis, untouched);
    ok(m.flow === null,
      '★★ 没被 join 过的老房间照样读出 flow:null —— 归一化是**每次读都做**，'
      + '不是一次性迁移（这条塌了的话，只有被动过的房间是好的）');
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【4】create()：不传 = 普通房间；传了 flow ≠ 流程已启动');
  let plain, bound;
  {
    plain = await rooms.create(redis, `${PREFIX}普通房间`);
    ok(plain.flow === null && plain.stage === null && plain.assignee === null,
      '★ create(redis, name) 老签名一个字不用改，默认就是普通房间');

    bound = await rooms.create(redis, `${PREFIX}绑了流程`, { flow: FLOW });
    ok(bound.flow === FLOW && bound.stage === null,
      '★ 绑了流程但 stage 仍是 null —— 「绑定」和「启动」是两件事');
    const st = await rooms.flowStatus(redis, bound.hash);
    ok(st.state === rooms.FLOW_STATE.NOT_STARTED, 'state = not_started', st.state);
    ok(st.next && st.next.name === 'design',
      '★ 下一步说得出是 design（不是「不知道」）', JSON.stringify(st.next));
    ok(/花名册/.test(st.note),
      '★ note 提醒启动前要核对角色在花名册里 —— 不做的后果是活派出去没人收');
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【5】★★ 阴性对照：flow 有值的房间，状态跟普通房间**不同**');
  {
    const a = await rooms.flowStatus(redis, plain.hash);
    const b = await rooms.flowStatus(redis, bound.hash);
    ok(a.state !== b.state,
      '★★ 两者 state 不同 —— 一个「永远返回同一个东西」的实现过不了这条',
      `${a.state} vs ${b.state}`);
    ok(a.next === null && b.next !== null, '★ 普通房间没有下一步，流程房间有');
    ok(a.note !== b.note, 'note 也不同（人读的那句话真的分了情况）');
    ok(a.flow === null && b.flow === FLOW, 'flow 字段各自透传');
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【6】★★ no_flow 和 done 必须分得开（两者 assignee 都是 null）');
  {
    const done = await rooms.create(redis, `${PREFIX}跑完了`,
      { flow: FLOW, stage: rooms.STAGE_DONE, assignee: null });
    const a = await rooms.flowStatus(redis, plain.hash);
    const d = await rooms.flowStatus(redis, done.hash);

    ok(a.assignee === null && d.assignee === null,
      '★ 正控：两个房间「现在没人被点名」这件事上**表现一样** —— '
      + '所以光看 assignee 分不开，这正是要 state 的理由');
    ok(a.state === rooms.FLOW_STATE.NO_FLOW && d.state === rooms.FLOW_STATE.DONE,
      '★★ 而 state 把它们分开了', `${a.state} vs ${d.state}`);
    ok(d.state !== a.state, '★★ 两个 state 值确实不相等（不是同一个常量的两个名字）');
    ok(/终点/.test(d.note) && /常态/.test(a.note),
      '★ note 说清了处置不同：一个是正常终点，一个是普通房间的常态');
    ok(d.current === null && d.next === null, '跑完了没有当前阶段、没有下一步');
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【7】running：在哪个阶段 / 轮到谁 / 下一步是什么');
  {
    const r = await rooms.create(redis, `${PREFIX}进行中`,
      { flow: FLOW, stage: 'design', assignee: 'arch' });
    const st = await rooms.flowStatus(redis, r.hash);
    ok(st.state === rooms.FLOW_STATE.RUNNING, 'state = running', st.state);
    ok(st.current && st.current.name === 'design' && st.current.role === 'arch',
      '★ 「在哪个阶段」', JSON.stringify(st.current && st.current.name));
    ok(st.assignee === 'arch', '★ 「轮到谁」');
    ok(st.next && st.next.name === 'spec' && st.next.role === 'senior',
      '★ 「下一步是什么」', JSON.stringify(st.next));
    ok(st.current.produces === 'DESIGN.md', '产出文件说得出');
    ok(Array.isArray(st.current.requires) && st.current.requires.includes('## 问题'),
      '★ 判据一起带出来 —— 「它为什么不推进」的答案永远在这个列表里',
      JSON.stringify(st.current.requires));

    // 分辨力：换一个 stage，返回的东西必须跟着变
    const r2 = await rooms.create(redis, `${PREFIX}进行中2`,
      { flow: FLOW, stage: 'tasks', assignee: 'senior' });
    const st2 = await rooms.flowStatus(redis, r2.hash);
    ok(st2.current.name === 'tasks' && st2.next.name === 'test',
      '★★ 换个 stage，current/next 跟着变 —— 不是写死的', JSON.stringify([st2.current.name, st2.next.name]));
    ok(st.state === st2.state && st.current.name !== st2.current.name,
      '★ 同为 running 但阶段不同 —— state 粒度对，没把两件事混成一个');
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【8】review 有**两条**出路 —— 只报一条就是给了假象');
  {
    const r = await rooms.create(redis, `${PREFIX}review中`,
      { flow: FLOW, stage: 'review', assignee: 'arch' });
    const st = await rooms.flowStatus(redis, r.hash);
    ok(st.next && st.next.name === 'tasks', '通过 → tasks', JSON.stringify(st.next));
    ok(st.next_on_reject && st.next_on_reject.name === 'spec',
      '★★ 打回 → spec，两条路都说出来了', JSON.stringify(st.next_on_reject));
    ok(Array.isArray(st.current.verdict) && st.current.verdict.includes('打回'),
      'verdict 词表带出来了', JSON.stringify(st.current.verdict));

    // 阴性对照：不带 verdict 的阶段**没有**第二条路
    const d = await rooms.create(redis, `${PREFIX}design中`,
      { flow: FLOW, stage: 'design', assignee: 'arch' });
    const sd = await rooms.flowStatus(redis, d.hash);
    ok(sd.next_on_reject === null,
      '★★ 阴性对照：design 阶段没有打回路径 —— next_on_reject 不是恒非空');
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【9】最后一个阶段：next 是 null，但**不是** done');
  {
    const r = await rooms.create(redis, `${PREFIX}最后一阶段`,
      { flow: FLOW, stage: 'test', assignee: 'test' });
    const st = await rooms.flowStatus(redis, r.hash);
    ok(st.state === rooms.FLOW_STATE.RUNNING,
      '★★ 还在跑（不是 done）—— 这两个都 next:null，混了就会以为流程结束了', st.state);
    ok(st.next === null && st.current.name === 'test', 'next 为空但 current 还在');
    ok(new RegExp(`"${rooms.STAGE_DONE}"`).test(st.note),
      '★ note 说清「满足后 stage 走到 done」');
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【10】assignee 跟阶段角色对不上 —— 要说出来');
  {
    const r = await rooms.create(redis, `${PREFIX}人不对`,
      { flow: FLOW, stage: 'design', assignee: 'senior' });   // design 该是 arch
    const st = await rooms.flowStatus(redis, r.hash);
    ok(/不一致/.test(st.note),
      '★ 角色名就是 agent 名、中间没有映射层，所以对不上就是状态坏了', st.note);
    const good = await rooms.create(redis, `${PREFIX}人对`,
      { flow: FLOW, stage: 'design', assignee: 'arch' });
    const sg = await rooms.flowStatus(redis, good.hash);
    ok(!/不一致/.test(sg.note), '★ 阴性对照：对得上就不报（不是恒报）');
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【11】坏输入：读不到 / 结构坏 / stage 不认识 —— 三种要分得开');
  {
    const unknown = await rooms.create(redis, `${PREFIX}模板不存在`,
      { flow: 'no-such-flow-xyz', stage: 'design' });
    const su = await rooms.flowStatus(redis, unknown.hash);
    ok(su.state === rooms.FLOW_STATE.UNKNOWN_FLOW, 'flow 读不到 → unknown_flow', su.state);
    ok(/protocols\/flows\/no-such-flow-xyz\.json/.test(su.note),
      '★ note 里给了该去看的**具体路径**（每种错误都带「该做什么」）');

    const badStage = await rooms.create(redis, `${PREFIX}阶段名不认识`,
      { flow: FLOW, stage: '第六阶段' });
    const sb = await rooms.flowStatus(redis, badStage.hash);
    ok(sb.state === rooms.FLOW_STATE.INVALID_STAGE, 'stage 不认识 → invalid_stage', sb.state);
    ok(/design/.test(sb.note) && /test/.test(sb.note),
      '★ note 列出合法阶段有哪些 —— 否则人得自己去翻模板文件');
    ok(su.state !== sb.state,
      '★★ 「模板读不到」和「stage 写坏了」是两个 state —— 修法不同：'
      + '一个去看文件在不在，一个去看状态怎么写成这样的');

    // 结构坏的模板：真写一个坏文件，让 INVALID_FLOW 那条分支**真的被走到**
    fs.writeFileSync(BAD_PATH, JSON.stringify({
      stages: [{ name: 'design', role: 'arch' }, { name: rooms.STAGE_DONE, role: 'x' }],
    }), 'utf8');
    const badFlow = await rooms.create(redis, `${PREFIX}模板结构坏`,
      { flow: BAD_FLOW, stage: 'design' });
    const sf = await rooms.flowStatus(redis, badFlow.hash);
    ok(sf.state === rooms.FLOW_STATE.INVALID_FLOW,
      '★ 模板读到了但结构坏 → invalid_flow（跟 unknown_flow 分开）', sf.state);
    ok(/被流程终点占用/.test(sf.note),
      '★★ 说得出坏在哪：有个阶段叫 done，那会让「跑完了」和「正在跑这个阶段」'
      + '在 meta 里长得一模一样', sf.note);
    ok(sf.state !== su.state && sf.state !== sb.state, '三种坏输入三个 state');
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【12】validateFlow 逐条（纯函数）');
  {
    const base = () => ({ stages: [{ name: 'a' }, { name: 'b' }], on_reject: 'a' });
    ok(rooms.validateFlow(base()) === null, '正常模板通过');
    ok(typeof rooms.validateFlow(null) === 'string', 'null 被拒');
    ok(typeof rooms.validateFlow({ stages: [] }) === 'string', '空 stages 被拒');
    ok(typeof rooms.validateFlow({ stages: [{ role: 'x' }] }) === 'string', '阶段缺 name 被拒');
    ok(typeof rooms.validateFlow({ stages: [{ name: 'a' }, { name: 'a' }] }) === 'string',
      '★ 阶段重名被拒 —— 重名的话 stage 指向哪一个是不确定的');
    ok(typeof rooms.validateFlow({ stages: [{ name: rooms.STAGE_DONE }] }) === 'string',
      `★★ 叫 "${rooms.STAGE_DONE}" 的阶段被拒`);
    ok(typeof rooms.validateFlow({ stages: [{ name: 'a' }], on_reject: 'zzz' }) === 'string',
      '★ on_reject 指向不存在的阶段被拒 —— 否则打回那天才发现退不回去');
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【13】★★ 路径穿越：flow 名来自 redis，是外部写得进去的');
  {
    // 正控：先证明穿越的目标**真的存在且能读** —— 否则「返回 null」
    // 可能只是因为那个文件恰好不在，白名单有没有都一样。
    const target = path.join(rooms.FLOW_DIR, '..', '..', 'package.json');
    ok(fs.existsSync(target),
      '★ 正控：穿越目标 ../../package.json 确实存在 —— 没有白名单的话读得到它',
      target);
    ok(rooms.loadFlow('../../package') === null, '★★ 而 loadFlow 拒绝它（白名单）');
    ok(rooms.loadFlow('/etc/passwd') === null, '绝对路径被拒');
    ok(rooms.loadFlow('') === null && rooms.loadFlow(null) === null, '空 / null 被拒');
    ok(rooms.loadFlow(FLOW) !== null,
      '★ 阴性对照：合法名字照常读得到 —— 白名单不是把所有东西都挡了');

    // 端到端：一个 flow 被写成穿越串的房间，flowStatus 不抛、报 unknown_flow
    const evil = await rooms.create(redis, `${PREFIX}穿越`, { flow: '../../package', stage: 'design' });
    let st = null, threw = null;
    try { st = await rooms.flowStatus(redis, evil.hash); } catch (e) { threw = e; }
    ok(threw === null, 'flowStatus 不抛', threw && threw.message);
    ok(st && st.state === rooms.FLOW_STATE.UNKNOWN_FLOW, '报 unknown_flow', st && st.state);
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【14】★ 房间不存在 → 抛错，不是「没绑流程」');
  {
    let threw = null, got = null;
    try { got = await rooms.flowStatus(redis, 'deadbeefcafe'); } catch (e) { threw = e; }
    ok(threw !== null, '★★ 抛错了（没有静默返回一个看起来正常的 no_flow）',
      got && JSON.stringify(got));
    ok(threw && threw.code === rooms.ROOM_NOT_FOUND,
      '★ 判据是 err.code，跟 historyPayload 同一条 —— 不是 message 里找关键字',
      threw && threw.code);
    const { status } = rooms.httpError(threw);
    ok(status === 404, '★ 走 httpError 是 404，跟现有房间端点一致', String(status));
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n【15】⛔ 范围守卫 —— **这条线在第四步之后重新划过一次**');
  {
    // ── ★★ 守卫线划在 lib/rooms.js 的「推进」那段之前 ────────────────────────────────────
    //   之前的只读段（flowStatus / stageGate / roomGate）不写状态、不发消息；
    //   advance 在线的后面。
    //
    //   ⚠️ 一条被移动过的守卫线，可信度跟没被动过的不一样。
    //   **它再红时，第一个问题是「范围又变了，还是真漏了」** ——
    //   而不是顺手再挪一次。挪多了，它就已经不守任何东西了。
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rooms.js'), 'utf8');
    const iStatus = src.indexOf('async function flowStatus');
    const iWrite = src.indexOf('// ── 推进：第四步');
    ok(iStatus > 0 && iWrite > iStatus, '两个锚点都在，且顺序对', `${iStatus} / ${iWrite}`);

    const readOnly = src.slice(iStatus, iWrite);
    ok(!/redis\.set\(|xadd\(/.test(readOnly),
      '★★ flowStatus / stageGate / roomGate 这一段**仍然**不写状态、不发消息 —— '
      + '「看得见」和「动得了」分开，出问题时才分得清是哪一半');

    // ── ★★ 判据是「换阶段的写入口只有一处」，不是「redis.set 只出现一次」 ─────────────────
    //   `bindFlow` 也 set 一次（写的是 flow/flow_dir），所以数「写状态区里
    //   `redis.set(META(` 出现几次」会误报：它只是「换阶段的入口只有一个」的
    //   **代理指标**，而 bindFlow 写的根本不是阶段。⇒ 不挪范围，换判据。
    //
    //   > **一个用代理指标表达的判据，在系统长出新东西时会误报 ——
    //   > 而误报会诱使人放宽它。正确的做法是把它换成真正想说的那件事。**
    const writeSide = src.slice(iWrite);
    const entries = (writeSide.match(/Object\.assign\(meta, enterStage\(/g) || []).length;
    ok(entries === 1,
      '★★ 换阶段的写入口**只有一处** —— `Object.assign(meta, enterStage(` 只出现一次',
      String(entries));
    ok(!/meta\.stage\s*=|meta\.assignee\s*=/.test(writeSide),
      '★★ 而且写状态那一整段里，没有任何地方绕过 enterStage 直接赋 stage/assignee');
    ok(/meta\.flow\s*=/.test(writeSide),
      '★ 自检：这个正则**确实**匹配得上「直接给 meta 某个字段赋值」'
      + '（bindFlow 里的 `meta.flow =` 就是）—— 所以上面那条不是恒真');
    ok(typeof rooms.advance === 'function' && typeof rooms.enterStage === 'function',
      '★ 第四步的两个函数都在（这条现在是正控，不再是禁令）');
  }

  await cleanup(redis);
  rmBadFlow();
  await redis.quit();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('✗ 异常:', (e && e.stack) || e);
  rmBadFlow();
  process.exit(1);
});
