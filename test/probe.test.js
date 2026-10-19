'use strict';

/**
 * 存活探针 + 待回复账本（`lib/probe.js` / `lib/waiting.js`）。
 *
 * 这两个模块的共同点：**它们的正确行为大部分时候是「不说话」** ——
 * 所以阴性对照比阳性用例更重要。一个永远不报的检测器和一个永远在报的
 * 检测器，都是坏的，而前者看起来跟「一切正常」一模一样。
 *
 * ⚠️ 状态文件一律走 `ENGLOOP_PROBE_STATE` / `ENGLOOP_WAITING_STATE` 指到
 *   临时文件。往生产状态里塞测试探针，会留下一条**永远不会销账的告警** ——
 *   而「一直报」会让人对真告警脱敏，那是这类检测器最坏的坏法。
 *   末尾有正控：跑完比对生产文件没被碰过。
 *
 * 单跑：`node test/probe.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-probe-'));
const STATE = path.join(TMP, 'probe-state.json');
const WSTATE = path.join(TMP, 'waiting.json');
process.env.ENGLOOP_PROBE_STATE = STATE;
process.env.ENGLOOP_WAITING_STATE = WSTATE;

// ★ 正控的基线必须在**任何 probe/waiting 代码跑起来之前**取 —— 见【11】。
const prodProbeExistedBefore = fs.existsSync(
  path.join(__dirname, '..', 'temp', 'probe-state-JARVIS.json'));
const prodWaitExistedBefore = fs.existsSync(
  path.join(__dirname, '..', 'temp', 'waiting-JARVIS.json'));

const probe = require('../lib/probe');
const waiting = require('../lib/waiting');

const NOW = 1786400000000;
const MIN = 60000;

console.log('\n【1】load —— 读不到 / 读坏了，都要返回 null');
{
  try { fs.unlinkSync(STATE); } catch { /* 本来就没有 */ }
  ok(probe.load('X') === null, '文件不存在 → null');
  fs.writeFileSync(STATE, '{ 这不是 JSON');
  ok(probe.load('X') === null, '文件损坏 → null（不抛）');
  // ★ 两种都返回 null，是因为它们的**修法相同**：都表示「检测器没在保护你」。
  //   区分它们只会让调用方多一个分支，而两个分支做的事一样。
}

console.log('\n【2】★ 检测器缺席时必须出声 —— 这是它最容易被漏掉的一条');
{
  const line = probe.alertLine(null, NOW);
  ok(typeof line === 'string' && line.includes('未启用'), '状态为 null → 报「未启用」');
  ok(/timeout/.test(line), '★ 告警里点明「此刻的 timeout 无法区分」', line);
  // ★ 大多数检测器在自己没上岗时是沉默的，而**沉默正好被读成一切正常**。
  //   让它在缺席时喊，等于把它自己也纳入监测范围。
}

console.log('\n【3】阴性对照 —— 一切正常时必须闭嘴');
{
  const healthy = { last_sent_ms: NOW - 5 * MIN, last_returned_ms: NOW - 4 * MIN, pending: [] };
  ok(probe.alertLine(healthy, NOW) === null, '刚发过、没有在途 → null');
  const inflight = { last_sent_ms: NOW - MIN, last_returned_ms: null, pending: [{ id: 'a', sent_ms: NOW - MIN }] };
  ok(probe.alertLine(inflight, NOW) === null, '探针刚发出 1 分钟、还在途 → 不报（没超时）');
  // ⇒ 这两条是这个模块的全部价值所在：**它平时不说话**，
  //   所以它开口时人才会当回事。
}

console.log('\n【4】探针超时 → 报警，且长度不随严重程度增长');
{
  const one = { last_sent_ms: NOW - 30 * MIN, pending: [{ id: 'p1', sent_ms: NOW - 30 * MIN }] };
  const l1 = probe.alertLine(one, NOW);
  ok(l1 && l1.includes('p1') && l1.includes('30 分钟'), '单条超时 → 报 id + 分钟数', l1);

  const many = {
    last_sent_ms: NOW - 10 * MIN,
    pending: [
      { id: 'p1', sent_ms: NOW - 90 * MIN },
      { id: 'p2', sent_ms: NOW - 60 * MIN },
      { id: 'p3', sent_ms: NOW - 40 * MIN },
    ],
  };
  const l3 = probe.alertLine(many, NOW);
  ok(l3.includes('p1'), '三条超时 → 只点名最老的那条', l3);
  ok(!l3.includes('p2') && !l3.includes('p3'), '★ 其余两条不列出来', l3);
  ok(l3.includes('另有 2 条'), '但给出计数，信息不丢', l3);
  ok(l3.split('\n').length === 1, '★ 恒定一行', JSON.stringify(l3));
  // ★★ 判据：**告警长度不能随故障严重程度增长。**
  //   越严重越长的告警，会在最该被看见的时候把自己挤出 2048 字节的
  //   工具 preview —— 那就成了「为了不聋，改成瞎」。
  ok(l3.length < l1.length + 40, '★ 三条超时的告警不比一条长多少',
    `1条=${l1.length} 3条=${l3.length}`);
}

console.log('\n【5】★ 「从没发过」和「刚销完账」必须分得开');
{
  // 这条守的是 settle 里那句「last_sent_ms 不清空」。
  // 只存「在途探针」的话两者都是 pending 空 —— 于是
  // **「探针方自己停了、根本没发探针」这种故障一点痕迹都不留。**
  const settled = { last_sent_ms: NOW - 2 * MIN, last_returned_ms: NOW - MIN, pending: [] };
  ok(probe.alertLine(settled, NOW) === null, '刚销完账 → 闭嘴');

  const neverSent = { last_sent_ms: null, last_returned_ms: null, pending: [] };
  const line = probe.alertLine(neverSent, NOW);
  ok(line && line.includes('60 分钟没发出'), '★ 从没发过 → 报警（同样是 pending 空）', line);
  ok(/不等于/.test(line), '并说明「没有告警」不等于链路健康', line);

  const stale = { last_sent_ms: NOW - 120 * MIN, last_returned_ms: NOW - 119 * MIN, pending: [] };
  ok(probe.alertLine(stale, NOW) !== null, '太久没发 → 报警（哪怕上次是成功的）');
}

console.log('\n【6】harvest —— 判据是 from + 前缀两个都要');
{
  const msgs = [
    { from: 'JARVIS', text: 'PROBE-123 自环', stream: 'orch:in:agent', id: '1-0' },
    { from: 'dev', text: 'PROBE-999 我在讨论探针机制', stream: 'orch:in:agent', id: '2-0' },
    { from: 'JARVIS', text: '这不是探针', stream: 'orch:in:agent', id: '3-0' },
  ];
  const r = probe.harvest(msgs, 'JARVIS');
  ok(r.ids.length === 1 && r.ids[0] === '123', '摘出自己的探针');
  ok(r.kept.length === 2, '其余两条留给大脑');
  // ★ 阴性对照：**别人正文里提到 PROBE- 不能被误销账。**
  //   讨论探针的消息很常见，只看前缀的话每一条都会被吃掉。
  ok(r.kept.some((m) => m.from === 'dev'), '★ 别人提到 PROBE- 前缀 → 不摘（不误销账）');
  ok(r.acks.length === 1 && r.acks[0].id === '1-0',
    '★ 返回可 ack 的原始消息（摘走不 ack = 60 秒后永远重投）');
}

console.log('\n【7】settle —— 销账不抹掉「发出过」这个事实');
{
  const s = { last_sent_ms: NOW - 5 * MIN, last_returned_ms: null, pending: [{ id: 'a', sent_ms: NOW - 5 * MIN }] };
  probe.settle(s, ['a'], NOW);
  ok(s.pending.length === 0, '在途清掉');
  ok(s.last_sent_ms === NOW - 5 * MIN, '★ last_sent_ms 保留（见【5】的理由）');
  ok(s.last_returned_ms === NOW, 'last_returned_ms 写入');
}

console.log('\n【8】maybeSend —— 写的是 outbox 文件，不是直接进流');
{
  const s = { last_sent_ms: NOW, pending: [] };
  ok(probe.maybeSend('TESTAGENT', s, NOW + MIN) === null, '刚发过 → 不重复发');
  // ⚠️ 真发一条会写进 temp/outbox/TESTAGENT/，那个目录 relay 不监听
  //   （花名册里没有 TESTAGENT），所以不会产生副作用。
  const id = probe.maybeSend('TESTAGENT', null, NOW);
  ok(id === String(NOW), '从没发过 → 发一条');
  const dir = path.join(__dirname, '..', 'temp', 'outbox', 'TESTAGENT');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  ok(files.length > 0, '★ 落的是 outbox 文件 —— 抄近路直接 send 进流，'
    + '验的就是一条没人走的路（relay 那段正是最该被验的）');
  const body = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  ok(body.username === 'TESTAGENT', 'username = 自己（自环）');
  ok(body.text.startsWith('PROBE-'), '文本带前缀，回来时认得出');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n【9】waiting —— ★ 位置跟探针相反，阴性对照是它的全部意义');
{
  const items = [
    { id: 'w1', who: 'Patrick', what: 'workers 进不进 git', since_ms: NOW - 5 * 3600000 },
    { id: 'w2', who: 'Patrick', what: 'kind 界面样式', since_ms: NOW - 2 * 3600000 },
    { id: 'w3', who: 'dev', what: '探针结果', since_ms: NOW - 3600000 },
  ];
  ok(waiting.alertLine([], items, NOW) === null, '★ 账本非空 + 没人说话 → 闭嘴');
  ok(waiting.alertLine([{ from: 'bus' }], items, NOW) === null,
    '★ 说话的不是账上那个人 → 闭嘴');
  ok(waiting.alertLine([{ from: 'Patrick' }], [], NOW) === null, '账本为空 → 闭嘴');
  // ⇒ 上面三条阴性是它的全部意义。**沉默在这里是正确行为**，
  //   而在探针那边沉默是漏报 —— 两个检查器判据相反，不是其中一个写错了。

  const line = waiting.alertLine([{ from: 'Patrick' }], items, NOW);
  ok(line && line.includes('Patrick'), 'Patrick 开口 → 提醒', line);
  ok(line.includes('workers 进不进 git'), '★ 点名最老的那条', line);
  ok(line.includes('等 2 件'), '其余给计数（同样恒定一行）', line);
  ok(!line.includes('探针结果'), '★ dev 那条不提 —— 说话的是 Patrick', line);
  ok(line.split('\n').length === 1, '恒定一行');
  ok(/不等于他回答了/.test(line),
    '★★ 必须钉着「他说话 ≠ 他回答了这件事」—— 少了这句，'
    + '触发点会被读成「这件事完了」，等于把这一档偷偷降级成「工具能销账」');
}

console.log('\n【10】★★ 按 reply_to 自动销账 —— 把销账从人手里搬进工具手里');
{
  const items = [
    { id: 'e1', who: 'Patrick', what: 'workers 进不进 git', since_ms: NOW - 3600000 },
    { id: 'e2', who: 'Patrick', what: 'kind 界面样式', since_ms: NOW - 7200000 },
  ];
  ok(waiting.askJobId('e1') === 'ask-e1', 'askJobId 拼出提问用的 job_id');

  // 阴性对照 ①：他说话了，但没有 reply_to → **不销账**。
  const noReply = waiting.autoSettle(items, [{ from: 'Patrick', text: '随便说一句' }]);
  ok(noReply.settled.length === 0 && noReply.remaining.length === 2,
    '★★ 他开口但没回复具体哪条 → 一条都不销 —— '
    + '「他说话」不等于「他回答了这件事」，这条边界不能被推断掉');

  // 阴性对照 ②：reply_to 指向别的东西（普通消息）→ 不销账。
  const other = waiting.autoSettle(items, [{ from: 'Patrick', reply_to: 'some-uuid-1234' }]);
  ok(other.settled.length === 0, '★ reply_to 指向普通消息 → 不销（只认精确匹配）');

  // 阳性：reply_to 精确命中 → 销掉那一条，**只销那一条**。
  const hit = waiting.autoSettle(items, [{ from: 'Patrick', reply_to: 'ask-e1' }]);
  ok(hit.settled.length === 1 && hit.settled[0].id === 'e1', '★★ 精确命中 → 销账');
  ok(hit.remaining.length === 1 && hit.remaining[0].id === 'e2',
    '★★ 另一条原封不动 —— 回答了一个问题不等于回答了全部');

  const line = waiting.settledLine(hit.settled);
  ok(line && line.includes('workers 进不进 git'), '销账要报出来', line);
  ok(line.split('\n').length === 1, '同样恒定一行');
  // ★ 为什么销账也要出声：静默销账等于账本自己变短了，
  //   而人分不清那一条是被答掉了还是被吃掉了。
}

console.log('\n【10b】🔴 误销的回归 —— 销账通知必须贴出「他当时说了什么」');
{
  // ── 误销的形状 ──────────────────────────────────────────────
  //   一条提问消息里问了两件事（① bus 重启 ② 开发什么），
  //   人回复那条、正文「1 做」（答的是②），
  //   机制照 reply_to 精确匹配把 ①**销掉了** —— 他一个字没说过那件事。
  //
  //   ★ 根因不在代码：reply_to 证明得了「他在回复这条消息」，
  //     证明不了「他回答了这条消息里的哪个问题」。
  //   ⇒ 修法不是消除误销，是**让误销当场可见**。
  const items = [{ id: 'r1', who: 'Patrick', what: 'bus 要不要重启', since_ms: NOW - 3600000 }];
  const msgs = [{ from: 'Patrick', reply_to: 'ask-r1', text: '1 做' }];
  const { settled } = waiting.autoSettle(items, msgs, NOW);

  ok(settled[0].settled_by_text === '1 做',
    '★★★ 记下了**他当时说的那句话** —— 这一个字段就是整个修复');
  ok(typeof settled[0].settled_at === 'number', '记了销账时刻');

  const line = waiting.settledLine(settled);
  ok(line.includes('1 做'),
    '★★★ 销账通知里贴出那句话 —— 有这一行的话，'
    + '`←他说的是「1 做」` 一眼就看得出不对', line);
  ok(/误销/.test(line) && /恢复/.test(line),
    '★★ 而且当场告诉人这可能是误销、以及它还能恢复 —— '
    + '**漏销只是继续提醒，误销是一个没答的问题被标成答过了**', line);
  ok(line.split('\n').length === 1, '仍然恒定一行');

  // ★ 长度不随条数增长（跟探针同一条约束）
  const many = waiting.autoSettle(
    [items[0], { id: 'r2', who: 'Patrick', what: '另一件', since_ms: NOW }],
    [{ from: 'Patrick', reply_to: 'ask-r1', text: '1 做' },
      { from: 'Patrick', reply_to: 'ask-r2', text: '好' }], NOW).settled;
  const l2 = waiting.settledLine(many);
  ok(l2.includes('等 2 件') && l2.split('\n').length === 1,
    '★ 两条也是一行 + 计数', l2);
}

console.log('\n【11】★ 正控：生产状态文件全程没被碰过');
{
  // 隔离生效的证据不是「设了环境变量所以应该没事」，是取一个实际的值。
  const prodProbe = path.join(__dirname, '..', 'temp', 'probe-state-JARVIS.json');
  const prodWait = path.join(__dirname, '..', 'temp', 'waiting-JARVIS.json');
  ok(probe.statePath('JARVIS') === STATE, 'ENGLOOP_PROBE_STATE 覆盖生效');
  ok(waiting.statePath('JARVIS') === WSTATE, 'ENGLOOP_WAITING_STATE 覆盖生效');

  // ── 🔴 别写成这样 ──────────────────────────────────────────────────
  //     ok(!fs.existsSync(prodProbe) || fs.readFileSync(prodProbe,'utf8').length >= 0, …)
  //   ⇒ `length >= 0` 对任何字符串都成立 ⇒ **整条恒真**，它一个字节都没验。
  //   ★ 而它顶着「★ 正控」的标题 —— 一条自称正控、而什么都不验的判据，
  //     比没有正控更坏：**它占住了那个位置**，于是没人会再来加一条真的。
  //   （「只断言没有 X」那一类的极端形态：**连「没有 X」都没断言**。）
  //
  //   ✅ 判的是：**本测试没有创建它** —— 跑前不存在 ⇒ 跑后必须仍然不存在。
  //   ⚠️ 而射程如实写着：**真 agent 的 poller 此刻也在写这个文件** ——
  //     所以「它已经存在」这一支这里什么都不说（说了就是 flaky）。
  //     ⇒ 那一半由 `test/e2e.test.js` 的隔离验收管（它比对的是**新增**）。
  ok(!(prodProbeExistedBefore === false && fs.existsSync(prodProbe)),
    '★ 本测试没有**创建**生产探针状态（跑前不存在的，跑后仍不存在）', prodProbe);
  ok(!(prodWaitExistedBefore === false && fs.existsSync(prodWait)),
    '★ 本测试没有**创建**生产账本', prodWait);
}

console.log('\n【12】★ statePath 三档优先级 —— state 跟着 outbox 走');
{
  // 🔴 要防的形状：测试 spawn `bin/next.js` 时
  //   传了 `ENGLOOP_REDIS_URL` 而没传 outbox / probe state ⇒ 那个子进程的探针
  //   写进**生产**；编排者恰好掉册时 relay 当它是人 ⇒ 推给人看，
  //   pending 永远销不掉 ⇒ 告警报「可能已失聪」，而那个 agent 收发全通。
  //
  // ★ 所以有一层兜底：**设了 `ENGLOOP_OUTBOX_ROOT` 就自动隔离 state**。
  //   ⇒ 它挡的是「记得隔离 outbox、忘了 state」这一类（**半隔离**）——
  //     而半隔离比不隔离更坏：探针**发得出、回不来**，留下永不销账的 pending。
  const envBefore = { s: process.env.ENGLOOP_PROBE_STATE, o: process.env.ENGLOOP_OUTBOX_ROOT };
  try {
    const FAKE_ROOT = path.join(TMP, 'fake-outbox-root');

    // ① 显式 `ENGLOOP_PROBE_STATE` 优先级最高 —— 连 outbox root 也压不过它
    process.env.ENGLOOP_OUTBOX_ROOT = FAKE_ROOT;
    process.env.ENGLOOP_PROBE_STATE = STATE;
    ok(probe.statePath('JARVIS') === STATE,
      '【12-1】显式 `ENGLOOP_PROBE_STATE` 优先 —— outbox root 压不过它', probe.statePath('JARVIS'));

    // ② ★★ 只设 outbox root ⇒ state 跟着它走（兜底那一层）
    delete process.env.ENGLOOP_PROBE_STATE;
    ok(probe.statePath('JARVIS') === path.join(FAKE_ROOT, 'probe-state-JARVIS.json'),
      '【12-2】★★ 只设 `ENGLOOP_OUTBOX_ROOT` ⇒ **state 落进那个 root**',
      probe.statePath('JARVIS'));

    // ③ 阴性对照：两个都不设 ⇒ 回到生产路径。
    //   ★ 没有这一条的话，一个「statePath 永远返回 outbox root 下那个路径」的
    //     实现也能过 ②，而它会让**生产 poller 的账本搬家** —— 那是更坏的坏法。
    delete process.env.ENGLOOP_OUTBOX_ROOT;
    ok(probe.statePath('JARVIS')
        === path.join(__dirname, '..', 'temp', 'probe-state-JARVIS.json'),
      '【12-3】（阴性）两个都不设 ⇒ 仍然是生产路径', probe.statePath('JARVIS'));

    // ④ 而按 agent 分开这条性质，不能被 ② 破坏
    process.env.ENGLOOP_OUTBOX_ROOT = FAKE_ROOT;
    ok(probe.statePath('dev') !== probe.statePath('JARVIS'),
      '【12-4】隔离路径下**仍然按 agent 分开** —— 否则 dev 的探针会销掉 JARVIS 的账');
  } finally {
    if (envBefore.s === undefined) delete process.env.ENGLOOP_PROBE_STATE;
    else process.env.ENGLOOP_PROBE_STATE = envBefore.s;
    if (envBefore.o === undefined) delete process.env.ENGLOOP_OUTBOX_ROOT;
    else process.env.ENGLOOP_OUTBOX_ROOT = envBefore.o;
  }
  ok(probe.statePath('JARVIS') === STATE, '【12-5】（收尾）环境已还原，后续判据不受影响');
}

console.log('\n【13】★ 污染快照 fixture —— 它是一份**历史**证据，不是当前状态');
{
  // 🔴 这份 fixture 是 `temp/probe-state-*.json` 被污染时的样子：永久 pending
  //   分布在**不存在的 agent** 名下（`wiringtestcrew`、`__layering_probe` …）。
  //   成因是测试 spawn `bin/next.js` 时没传隔离变量 —— 见本文件【12】的头。
  //
  //   而清盘和留证是**冲突**的：
  //     不清 ⇒ 探针告警一直报「可能已失聪」⇒ 而 `lib/probe.js` 文件头逐字写着
  //            「一个修不掉又反复出现的告警，是训练人忽略告警的最快方式」
  //     清了 ⇒ 那些文件名（= 「测试写生产还有别的入口」的现成证据）一起没了
  //   ✅ 解法跟 `orch-out` 快照那份 fixture 同构：**证据落进 git，真文件清掉**。
  const FIX = path.join(__dirname, 'fixtures', 'synthetic', 'probe-state-sample.json');
  const fx = JSON.parse(fs.readFileSync(FIX, 'utf8'));
  const entries = Object.values(fx.entries);

  ok(entries.length > 0 && fx._provenance && fx._provenance.taken_at,
    '【13-1】（前提）fixture 读得出来，而且带 `_provenance`', String(entries.length));

  const sum = entries.reduce((a, e) => a + e.pending_count, 0);
  ok(sum === fx._provenance.totals.pending_total,
    '【13-2】自洽：逐条 pending 之和 === `_provenance.totals.pending_total`',
    `${sum} vs ${fx._provenance.totals.pending_total}`);

  // ★★ 而这一条守的是拍快照时最容易犯的那个错：
  //   `in_tmux` 全是 `false` —— 连正在跑的真 agent 也是。
  //   成因：session 名（`orch` / `agent_dev`）和 agent 名（`JARVIS` / `dev`）**不是同一个
  //   命名空间**，而 `tmux list-sessions` 给的是前者。
  //   ⇒ 一个全 false 的列**看起来完全正常** —— 它只是「都没在跑」。
  //   ⇒ ⇒ 而由它推出的判据会把每个真 agent 都判成污染（误报率 100%）。
  ok(entries.some((e) => e.in_tmux === true),
    '【13-3】★★ `in_tmux` **不全是 false** —— 全 false 说明拿 session 名比了 agent 名',
    JSON.stringify(entries.filter((e) => e.in_tmux).map((e) => e.file)));

  // 元凶指向的测试文件必须还在。红了不是 bug，是**该去更新 fixture** ——
  // 而没有这一条，fixture 会静静地指向一堆不存在的路径。
  const culprits = [...new Set(entries.map((e) => e.culprit).filter(Boolean)
    .map((c) => c.split('（')[0].split(':')[0].trim()))];
  const missing = culprits.filter((f) => !fs.existsSync(path.join(__dirname, '..', f)));
  // （≥2：合成夹具只保留了公开版里也存在的两个元凶文件，见夹具的 `_provenance.what`；前提只是「不为空」）
  ok(culprits.length >= 2 && missing.length === 0,
    '【13-4】fixture 点名的元凶文件都还在（红 ⇒ 去更新 fixture，不是去改这条）',
    `culprits=${culprits.join(',')} missing=${missing.join(',')}`);

  // ── ★★ 【13-5】`classification` 那一列必须能被 `classification_rule` 重算出来 ──
  //
  //   🔴 成因：检测判据拿 `classification` 当**期望值**；要是那一列只存在于造 fixture 的
  //     **一次性脚本**里，「期望值」就来自一个**不可复现的过程**：谁都没法重算它、也没法反驳它。
  //   ✅ 规则写进 `_provenance.classification_rule`，这一条把**规则和数据绑在一起**：
  //     改了一边没改另一边 ⇒ 红。
  //
  //   ⚠️ 而它证明不了那份判断**对** —— 它只证明**这一列是那条规则的输出**。
  //     ⇒ 这个射程写在这里，免得下一个人把它读成「分类已经被验证过了」。
  //
  //   🔴 而**别拿「规则重算出来全对」当证据**：规则是对着**那一列的值**写的
  //     ⇒ 从值反推一条能重算出它们的规则，全对是**必然**的。
  //     它和「规则独立写、恰好也对」在数字上一模一样
  //     （「两个错的方向相同时，它们会互相确认」）。
  //   ✅ 这份分类可信的理由**不在这条判据里**，在它的三个输入上：
  //     `pending_count` 读文件量 · `in_tmux` 用 `tmux list-sessions` 量 ·
  //     `culprit` 在三个测试文件的源码里 ⇒ ⇒ **谁都能自己重测一遍再算一次**。
  //     那句话写在 fixture 的 `_provenance.classification_rule._why_you_can_trust_it`，
  //     而它**可证伪**（重测对不上就红）—— 这一条只守「规则和数据没脱钩」。
  const rule = fx._provenance.classification_rule;
  const recompute = (e) => {
    if (e.culprit && e.pending_count > 0) return '测试污染（元凶已确认）';
    if (e.pending_count > 0 && !e.in_tmux) return '测试污染（元凶未确认）';
    if (e.in_tmux) return '真 agent';
    return '历史 agent / 临时 agent（pending 0，无害）';
  };
  const mismatched = entries.filter((e) => recompute(e) !== e.classification);
  ok(rule && Array.isArray(rule.rules) && rule.rules.length === 4 && mismatched.length === 0,
    '【13-5】★★ `classification` 是 `classification_rule` 的输出（规则与数据绑在一起）',
    `rules=${rule && rule.rules && rule.rules.length} mismatched=${mismatched.map((e) => e.file).join(',')}`);
}

console.log('\n【14】★ `classifyPollution` vs 那份真实快照 —— 期望值**全部来自夹具**');
{
  // 这一组跟【13】不重叠：【13】验**夹具自己自洽**，这里验**分类器跟夹具的人工分类一致**。
  //
  //   ⚠️ 而代价一并写着：夹具的 `classification` / `in_tmux` 两列是**人工填的**
  //     ⇒ ⇒ 所以这组验的是「分类器 == 那份人工判断」。**那份判断错了，这组会忠实地跟着错。**
  //     而这一格换不掉：有几条连元凶都没追到（`_provenance.known_gaps` 里写着）
  //     —— 没有别的出处可以对。
  const fx14 = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'synthetic', 'probe-state-sample.json'), 'utf8'));
  const E = fx14.entries;
  const names = Object.keys(E);
  const polluted = names.filter((n) => /测试污染/.test(String(E[n].classification))).sort();
  const live = names.filter((n) => E[n].in_tmux === true).sort();

  ok(names.length >= 12 && polluted.length > 0 && live.length > 0,
    `【14-1】（前提）夹具 ${names.length} 条 · 标为污染 ${polluted.length} · in_tmux ${live.length}`
    + ' —— 三个都非零，否则下面每一条都可能恒真',
    JSON.stringify({ n: names.length, polluted: polluted.length, live: live.length }));

  const got = probe.classifyPollution(E, live);
  const expect = polluted.filter((n) => !live.includes(n));
  const missed = polluted.filter((n) => live.includes(n));

  ok(JSON.stringify(got) === JSON.stringify(expect),
    `【14-2】🔴 ★ 分类器选出的 == 「夹具标的污染」减去「in_tmux 的」（${expect.length} 条）`
    + ' —— **双向**：多一个少一个都红',
    JSON.stringify({ got, expect }));

  // ── 🔴 这一条**故意断言一个已知漏报还在** ──────────────────────────
  //   它红的时候有两种可能，而**动作相反** —— 所以失败信息里印的是那个集合本身：
  //     · 还是 `["JARVIS"]`，而分类器多选了 ⇒ **判据变强了** ⇒ 来把这条对照删掉
  //     · 集合里**多了别的名字**         ⇒ **又有一个在 tmux 里的 agent 被污染了** ⇒ 去查它
  //   （一个「断言缺陷还在」的判据，必须让人分得出这两种。）
  ok(JSON.stringify(missed) === JSON.stringify(['JARVIS']),
    '【14-3】🔴 ★★ 被减掉的正好是 `["JARVIS"]` —— **已知漏报**：'
    + '掉册但 tmux 还在的真 agent 被污染时，这条判据看不见它',
    `被减掉: ${JSON.stringify(missed)} · 分类器选出: ${JSON.stringify(got)}`);

  // ── 阴性对照 ①：把「pending 非空」那半拿掉 ⇒ 会多选 4 个 ─────────────
  //   而那 4 个正是**退役 agent 留下的干净文件** ⇒ 所以这一条验的是
  //   「那半个条件真的在起作用」，不是写着好看。
  const nameOnly = names.filter((n) => !live.includes(n)).sort();
  const extra = nameOnly.filter((n) => !got.includes(n));
  ok(extra.length === 4 && extra.every((n) => (E[n].pending || []).length === 0),
    '【14-4】★ 只按名字选 ⇒ 会多出 **4** 个，而它们**全是 pending 0** —— '
    + '于是【14-2】不是「只靠名字」选出来的',
    JSON.stringify(extra));

  // ── 阴性对照 ②：三个真 agent 一个都不被选 ──────────────────────────
  //   而 `JARVIS` 那一刻 pending **非空** ⇒ 挡住他的只能是「名字是 agent」那半。
  // ── ⚠️【14-6】**存在型**：`run-all.js` 那个 `|| undefined` 不许被「清理」掉 ────
  //
  //   `probe_pollution_added: probeAdded || undefined` —— 而这一行的分辨力全在
  //   **`[]` 是 truthy** 这件事上：
  //     `[]`     ⇒ truthy ⇒ **照样写进 json** ⇒ 读作「**查了，没有**」
  //     `null`   ⇒ falsy  ⇒ 字段**缺席**     ⇒ 读作「**判不了**」（另有一行说明是哪一种）
  //   🔴 而下一个人为了「让 json 干净点」把它改成 `probeAdded.length ? … : undefined`
  //     ⇒ ⇒ `[]` 消失 ⇒ **「没污染」和「没查」又变回同一个东西**
  //     ⇒ 而那个改动**看起来完全合理** —— 谁会想留一个空数组在 json 里？
  //
  //   ⚠️ 这个行为不显眼：读那一行的人不一定会想到 `[]` 是 truthy。
  //     「它现在做对了」≠「它会一直做对」——
  //       区别在于**有没有东西拦着它被改回去**。
  //
  //   ⚠️ 退档理由（不是笼统的「效果型太贵」）：那一行只在 `run-all.js` 的**末尾**执行
  //     ⇒ 效果型要**真跑一遍全量**（几分钟）才碰得到它 —— 而判据不该为一行三元表达式付这个。
  //   ⚠️ 而它守不住的那格：**换个写法但语义一样**（`probeAdded ?? undefined`）⇒ 它会红，
  //     而红得**不对** ⇒ ⇒ 所以红的时候**先看语义变没变**，再决定是改代码还是改这条。
  const runAllSrc = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
  const padLine = (runAllSrc.match(/probe_pollution_added:.*/) || [''])[0].trim();
  ok(/^probe_pollution_added:\s*probeAdded \|\| undefined,?$/.test(padLine),
    '【14-6】⚠️ **存在型**：`probe_pollution_added: probeAdded || undefined` —— '
    + '`[]` 必须写得进 json（它是 truthy），否则「没污染」和「没查」同形',
    JSON.stringify(padLine));

  ok(!got.includes('dev') && !got.includes('senior') && !got.includes('JARVIS')
     && (E.JARVIS.pending || []).length > 0,
  '【14-5】★ 三个真 agent 都没被选，而 `JARVIS` 那一刻 pending 非空 —— '
    + '所以挡住他的只能是「名字是 agent」那半',
  JSON.stringify({ got, jarvisPending: (E.JARVIS.pending || []).length }));
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
