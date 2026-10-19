'use strict';

/**
 * 变异测试 —— 守着「探针告警放在 `bin/next.js` 的**那个位置**」真的有用。
 *
 * ★★ 它回答的不是「告警内容对不对」（那是 `probe.test.js` 的事），
 *    而是**「位置是不是那个起作用的东西」**。
 *
 * 为什么必须有它：`probe.js` 的断言全绿，也**不能证明**告警会在
 * timeout 轮出现 —— 那取决于调用点在 `if (messages.length === 0) return`
 * 的哪一侧，而那一行不在 `probe.js` 里。
 *
 * > 同构的坑：timeout 轮提前 `process.exit(0)` 的话，
 * > **探针没回来的表现就是一直 timeout ⇒ 检查器恰好在它唯一该报警的场景里不执行。**
 * > 一段自信的注释说明不了位置对不对，做了变异才知道。
 *
 * ⚠️ 磁盘上的 `bin/next.js` 全程一个字不动（见 runner 头部）。
 *
 * 单跑：`node test/probe-position-mutation.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const RUNNER = path.join(__dirname, 'fixtures', 'probe-position-mutant-runner.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-mut-'));

// ⚠️ 跟 runner **共用同一张表**（问它要，不在这里抄）——
//   抄的那天两边会分叉，症状是「变异测试绿着，但测的是旧判据」。
const MUTANTS = (() => {
  const r = spawnSync(process.execPath, [RUNNER, '--list'], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return {}; }
})();

/** 预置一个「有探针超时 30 分钟没回」的状态 —— 这样告警一定该出现。 */
function stateWithOverdue() {
  const p = path.join(TMP, `state-${Math.random().toString(36).slice(2)}.json`);
  const now = Date.now();
  fs.writeFileSync(p, JSON.stringify({
    last_sent_ms: now - 30 * 60000,
    last_returned_ms: now - 90 * 60000,
    pending: [{ id: 'OVERDUE1', sent_ms: now - 30 * 60000 }],
  }));
  return p;
}

function run(id, { messages = [], pending = 0 } = {}) {
  const r = spawnSync(process.execPath, [RUNNER, id], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      ENGLOOP_PROBE_STATE: stateWithOverdue(),
      ENGLOOP_WAITING_STATE: path.join(TMP, 'no-waiting.json'),
      MUT_MESSAGES: JSON.stringify(messages),
      MUT_PENDING: String(pending),
    },
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 下面按 null 处理 */ }
  return { status: r.status, parsed, raw: `${r.stdout || ''}${r.stderr || ''}` };
}

console.log('\n【0】变异表（跟 runner 共用一份）');
for (const [k, v] of Object.entries(MUTANTS)) console.log(`  · ${k.padEnd(22)} ${v}`);
ok(Object.keys(MUTANTS).length === 6, '六条变异都在表里', String(Object.keys(MUTANTS)));

console.log('\n【1】★ 正控 —— 不改代码，timeout 轮必须带告警');
{
  const r = run('none');
  ok(r.status === 0, 'runner 正常退出', r.raw.slice(0, 200));
  const out = r.parsed && r.parsed.stdout || '';
  ok(out.includes('_probe_alert'), '★★ messages 为空的那一轮，告警出现了', out.slice(0, 200));
  ok(out.includes('OVERDUE1'), '告警点名了超时的那条探针', out.slice(0, 200));
  ok(out.includes('timeout'), '同时仍然是一个合法的 timeout 输出', out.slice(0, 120));
  // ★ 这一条就是整个机制的命门：**告警该出现的轮次，正是 messages 为空的轮次。**
}

console.log('\n【2】★★ 变异 alert-after-return —— 挪到 return 之后，告警必须消失');
{
  const r = run('alert-after-return');
  const out = r.parsed && r.parsed.stdout || '';
  ok(!out.includes('_probe_alert'),
    '★★ 挪到 timeout 的 return 之后 → 告警 0 次（原版 1 次）', out.slice(0, 200));
  ok(out.includes('timeout'), '而它看起来仍然是一次完全正常的轮询', out.slice(0, 120));
  // ★★ 这条变异的价值：它**没有制造任何错误**。
  //   没有异常、没有红字、输出仍然合法 —— 只是那个检测器再也不会开口。
  //   **故障把检测器一起带走了，而现场跟一切正常一模一样。**
}

console.log('\n【3】变异 alerts-after-messages —— 排到 messages 之后');
{
  const msgs = [{ stream: 'orch:in:human', id: '1-0', from: 'Patrick', text: 'x'.repeat(2400) }];
  const base = run('none', { messages: msgs });
  const mut = run('alerts-after-messages', { messages: msgs });
  const bOut = (base.parsed && base.parsed.stdout) || '';
  const mOut = (mut.parsed && mut.parsed.stdout) || '';
  const head = (s) => Buffer.from(s, 'utf8').slice(0, 2048).toString('utf8');
  ok(head(bOut).includes('_probe_alert'), '★ 原版：告警落在前 2048 字节内');
  ok(!head(mOut).includes('_probe_alert'),
    '★★ 变异：排到 messages 之后 → 前 2048 字节里找不到它', head(mOut).slice(-120));
  ok(mOut.includes('_probe_alert'),
    '⚠️ 而它其实还在输出里 —— 只是人看不到。**这正是最难发现的那种坏法**');
}

console.log('\n【4】变异 no-harvest-ack —— 摘走探针却不 ack');
{
  const probeMsg = [{
    stream: 'orch:in:agent', id: '9-0', from: 'MUTTEST',
    text: 'PROBE-OVERDUE1 自环存活探针',
  }];
  const base = run('none', { messages: probeMsg });
  const mut = run('no-harvest-ack', { messages: probeMsg });
  ok((base.parsed.acked || []).length === 1, '★ 原版：探针被 ack 掉了',
    JSON.stringify(base.parsed.acked));
  ok((mut.parsed.acked || []).length === 0,
    '★★ 变异：没 ack —— 60 秒后 PEL 重投，探针自己变成那个故障',
    JSON.stringify(mut.parsed.acked));
  ok(!base.parsed.stdout.includes('PROBE-OVERDUE1'),
    '★ 探针不进大脑（对大脑透明）', base.parsed.stdout.slice(0, 150));
}

console.log('\n【4b】★★★ 「领了没 ack」告警 —— 干活那一轮最容易漏 ack');
{
  // 漏 ack 的典型形状是「那一轮的主要动作是干活」，
  // 而且不是自己发现的（靠 60 秒后 redelivered 才知道）；
  // 把它写成纪律拦不住 ⇒ **纪律对这个形状无效**，所以要由 poller 来喊。
  // ══════════════════════════════════════════════════════════════════
  // ★★★ 判据是**字段在不在**，不是「输出里有没有这个词」
  //
  //   不能写 `stdout.includes('_unacked')`：poller 的输出里
  //   **带着 `_orchestrator_instructions`（协议全文）** —— 于是：
  //
  //     · 协议里只要出现一次 `_unacked` 这个字面量，
  //       「不该喊」的那几条**就会变红**
  //     · 而「该喊」的那几条**同时变成恒真** —— 这一档更坏，它不会红，
  //       只是从此再也证明不了任何事
  //
  //   ⚠️ `/重投/` 这种词尤其：协议正文里「重投」出现很多次，
  //   文本匹配会是一条一直绿着的死断言。
  //
  //   ⇒ 所以解析 JSON、看字段。位置那条（下面 2048 字节）**保持文本检查**，
  //     因为它测的就是字面位置，而协议排在最后、落不进那个窗口。
  // ══════════════════════════════════════════════════════════════════
  const payloadOf = (r) => {
    try { return JSON.parse((r.parsed && r.parsed.stdout) || ''); } catch { return null; }
  };

  const clean = payloadOf(run('none', { pending: 0 }));
  ok(clean && !('_unacked' in clean), '★ 阴性对照：PEL 空 → 不喊（它平时必须闭嘴）');

  const owing = payloadOf(run('none', { pending: 3 }));
  const line = (owing && owing._unacked) || '';
  ok(Boolean(owing && '_unacked' in owing), '★★★ PEL 有 3 条 → timeout 轮也喊', line.slice(0, 160));
  ok(/还有 3 条/.test(line), '★ 报得出具体条数', line.slice(0, 160));
  ok(/重投/.test(line), '★ 并说清后果（会重投，副作用可能做两遍）', line.slice(0, 160));

  // ★ 本轮刚领的不算 —— 否则每一轮有消息的时候它都会喊，
  //   而「每轮都喊」正是让人开始忽略它的那条路。
  const justClaimed = payloadOf(run('none', {
    pending: 1,
    messages: [{ stream: 'orch:in:human', id: '1-0', from: 'Patrick', text: 'hi' }],
  }));
  ok(justClaimed && !('_unacked' in justClaimed),
    '★★ 本轮刚领的 1 条不算欠账 —— 大脑还没轮到处理它',
    JSON.stringify(justClaimed && justClaimed._unacked));

  const mut = payloadOf(run('unacked-after-return', { pending: 3 }));
  ok(mut && !('_unacked' in mut),
    '★★ 变异：挪到 return 之后 → 告警消失（跟探针同一个陷阱）',
    JSON.stringify(mut && mut._unacked));

  // ★ 排在最前：欠账要在新活之前被看到。
  const withMsg = run('none', {
    pending: 5,
    messages: [{ stream: 'orch:in:human', id: '2-0', from: 'Patrick', text: 'x'.repeat(2400) }],
  });
  const head = Buffer.from(withMsg.parsed.stdout || '', 'utf8').slice(0, 2048).toString('utf8');
  ok(head.includes('_unacked'), '★★ 忙轮也落在 preview 前 2048 字节内', head.slice(0, 100));
}

console.log('\n【4c】★★ 关停指令的会话标识判定 —— 位置错了它就再也不开口');
{
  // 要防的场景：agent 从流里领到一条**几天前**的 SHUTDOWN_REQUEST，把
  // 几分钟前刚起的会话关掉，零报错。判定在 `lib/shutdown.js`
  // （`classifyTarget`，纯函数、单测覆盖四档），**而它在 `bin/next.js` 的
  // 哪一侧被调用，决定了告警会不会出现** —— 这条变异守的就是那个位置。
  //
  // ⚠️⚠️ 跟探针 / `_unacked` 那两条**触发轮次相反**：
  //   那两条的陷阱在 timeout 轮；这一条只在**有消息**的轮次才可能出现
  //   （关停指令本身就是一条消息）。所以变异插的是「有消息就提前 return」。
  //
  // ── ⓘ 正控里出现的是哪一档告警，说清楚 ────────────────────────────
  //   runner 的 fakeRoster **没有 `lookup`** ⇒ 判定拿不到本会话的 created
  //   ⇒ 落到第四档 `unverifiable`（「检查器不可用，这条指令没有被验证」）。
  //   **这不影响本条要验的属性** —— 这里验的是「位置决定它开不开口」，
  //   哪一档开口都算开口。四档各自判对不对是 `test/shutdown.test.js` 的事。
  //   ★ 写出来是因为：不写的话，下一个人看到 `unverifiable` 会以为是 bug。
  const cmd = [{
    stream: 'agent:dev:in', id: '7-0', from: 'bus',
    text: 'SHUTDOWN_REQUEST —— bus 请求你优雅关停（原因：变异测试）。',
    target_session_created: '1786393909',
  }];
  const payloadOf = (r) => {
    try { return JSON.parse((r.parsed && r.parsed.stdout) || ''); } catch { return null; }
  };

  const base = payloadOf(run('none', { messages: cmd }));
  ok(base && '_stale_command' in base,
    '★★ 原版：收到关停指令 → `_stale_command` 出现',
    JSON.stringify(base && Object.keys(base)));
  ok(base && /不要执行|没有被验证/.test(base._stale_command || ''),
    '★ 而且它说的是「不要执行 / 没有被验证」', String(base && base._stale_command).slice(0, 80));

  // ★ 阴性对照：没有关停指令的轮次**必须闭嘴**。
  //   少了它，「原版出现」也可能是它对每一轮都喊 —— 那样这个告警两天后就没人看了。
  const quiet = payloadOf(run('none', {
    messages: [{ stream: 'orch:in:human', id: '8-0', from: 'Patrick', text: '普通消息' }],
  }));
  ok(quiet && !('_stale_command' in quiet),
    '★★ 阴性对照：没有关停指令 → 不喊（它平时必须闭嘴）',
    JSON.stringify(quiet && quiet._stale_command));

  // ★★ 变异：判定挪到告警对象构造之后 → 告警消失，而输出仍然合法
  const mut = payloadOf(run('stale-after-return', { messages: cmd }));
  ok(mut && !('_stale_command' in mut),
    '★★ 变异：挪到 alerts 构造之后 → 告警 0 次（原版 1 次）',
    JSON.stringify(mut && mut._stale_command));
  ok(mut && Array.isArray(mut.messages) && mut.messages.length === 1,
    '⚠️ 而它仍然是一次完全正常的轮询 —— 消息照常送达，**只是那句「不要执行」不见了**');

  // ★ 位置那条：它必须落在 preview 前 2048 字节内（跟 `_unacked` 同一档）。
  //   ⚠️ 这一条**保持文本检查**，因为它测的就是字面位置 —— 换成解析字段
  //     就测不到「它排在第几个」了。（协议全文排在最后，落不进这个窗口。）
  const busy = run('none', {
    messages: [...cmd, { stream: 'orch:in:human', id: '9-0', from: 'Patrick', text: 'x'.repeat(2400) }],
  });
  const head = Buffer.from(busy.parsed.stdout || '', 'utf8').slice(0, 2048).toString('utf8');
  ok(head.includes('_stale_command'),
    '★★ 忙轮也落在 preview 前 2048 字节内（排在所有告警之前）', head.slice(0, 90));
}

console.log('\n【5】★ 锚点失效必须大声 —— 而不是静默退化成摆设');
{
  // 源码改了之后 find 找不到，runner 必须 exit(3) 并说清楚。
  // 不这样的话，变异会「跑了但什么都没改」，然后测试照常绿 ——
  // **一个永远绿的变异测试，比没有变异测试更危险。**
  const r = spawnSync(process.execPath, [RUNNER, 'alert-after-return'], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, MUT_ANCHOR_PROBE: '1', ENGLOOP_PROBE_STATE: stateWithOverdue() },
  });
  ok(r.status === 0 || r.status === 3, 'runner 要么正常跑、要么 exit(3) 报锚点失效',
    `status=${r.status}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.rmSync(path.join(__dirname, '..', 'temp', 'outbox', 'MUTTEST'), { recursive: true, force: true });

console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
