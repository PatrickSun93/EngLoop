'use strict';

/**
 * `lib/thread-hint.js` —— 发送前的 thread 归属提醒。
 *
 * ── 为什么这个文件存在 ──────────────────────────────────────────
 * `_thread_alert` 会反复响，形状每次一样，
 * 而那条告警**明写着修法**。⇒ **纪律对这个形状无效。**
 * ⇒ 修法只能挂在一个会自己发生的位置上 —— 而发消息必然经过 `bin/outbox-send.js`。
 *
 * ★ 而它检的第二件（`kind` 拼错）比第一件值钱：
 *   `lib/relay.js:718` 把不在 `KINDS` 里的 kind **静默丢掉** ⇒ 下一轮 `_thread_alert`
 *   确实会响，**而它会说「补 `reply_to`」** —— 指向一个错误的修法。
 *   ⇒ 一条告警在该响的时候响了，**而它说的原因是错的**。
 *
 * 单跑：`node test/thread-hint.test.js`
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { threadHint } = require('../lib/thread-hint');
const { KINDS } = require('../web/threads.js');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

console.log('\n【1】五个场景 —— 该响的响，不该响的安静');
{
  const h1 = threadHint({ username: 'Patrick', text: '正文' });
  ok(!!h1 && /既没有/.test(h1), '★ 有正文 ＋ 有收件人 ＋ 无 reply_to 无 kind ⇒ 报', String(h1));

  ok(threadHint({ username: 'Patrick', text: '正文', reply_to: '123-0' }) === null,
    '★ 带 reply_to ⇒ 安静');
  ok(threadHint({ username: 'Patrick', text: '正文', kind: 'notice' }) === null,
    '★ kind 合法 ⇒ 安静');

  const h3 = threadHint({ username: 'Patrick', text: '正文', kind: 'notic' });
  ok(!!h3 && /notic/.test(h3), '★★ kind 拼错 ⇒ 报，而且**把那个拼错的值打出来**', String(h3));
  ok(!!h3 && /静默丢掉/.test(h3), '★★ 而且说得出后果是「被静默丢掉」，不是「补 reply_to」', String(h3));

  ok(threadHint({ ack: ['s:::1-0'] }) === null, '★ 纯 ack（无正文无收件人）⇒ 安静');
}

console.log('\n【2】边界 —— 一条都不许返回「空内容的告警」');
{
  ok(threadHint({ username: 'Patrick', text: '   ' }) === null, '只有空白的正文 ⇒ 安静');
  ok(threadHint({ text: '正文' }) === null, '有正文而没有收件人 ⇒ 不在射程内');
  ok(threadHint({ username: 'Patrick' }) === null, '有收件人而没有正文 ⇒ 不在射程内');
  ok(threadHint() === null, '什么都不传 ⇒ 安静（不许抛）');
  ok(threadHint({ username: 'Patrick', text: '正文', kind: '' }) !== null,
    '★ `kind: ""` 算「没设」⇒ 报（空串不是一个合法标注）');
  const all = [
    threadHint({ username: 'P', text: 't' }),
    threadHint({ username: 'P', text: 't', kind: 'x' }),
  ];
  ok(all.every((s) => typeof s === 'string' && s.trim().length > 20),
    '★ 报出来的每一条都有实际内容（> 20 字）—— 不许出现空告警');
}

console.log('\n【3】★★ KINDS 只能有一个出处 —— 这条防的是「抄一份值域」');
{
  // relay 用 `web/threads.js` 的 KINDS 做白名单；提醒文本里若抄了一份，
  // 两边分叉时**各自都「正常工作」**，而人会照着提醒去写一个 relay 不认的值。
  const h = threadHint({ username: 'P', text: 't' });
  for (const k of KINDS) {
    ok(h.includes(`"${k}"`), `★ 提醒文本里列出了 "${k}"（来自 web/threads.js 的 KINDS）`);
  }
  ok(KINDS.every((k) => threadHint({ username: 'P', text: 't', kind: k }) === null),
    '★★ KINDS 里的每一个值都被接受 —— 而这条随 KINDS 自动扩展');
}

console.log('\n【4】★★ 变异对照 —— 旧行为（不检 kind）在同一输入上给 null');
{
  // ⚠️ 这是**这个 bug 的复现**，不是被测代码的副本。
  //   它存在的唯一理由：让「新旧行为不同」成为一条能红的判据。
  const legacy = (e) => {
    const hasText = String(e.text ?? '').trim().length > 0;
    const hasTarget = !!(e.room_hash || e.username);
    if (!hasText || !hasTarget) return null;
    if (e.kind || e.reply_to) return null;   // ← 旧：kind 只要有值就放行，不看值域
    return '…';
  };
  const bad = { username: 'P', text: 't', kind: 'notic' };
  ok(legacy(bad) === null, '（前置）旧行为在拼错的 kind 上确实沉默');
  ok(threadHint(bad) !== null, '★★ 而新行为报 —— 两者在同一输入上不同');
}

console.log('\n【5】★ 而它真的挂在 outbox-send 上（不是只有函数对）');
{
  // 上面四组验的是那个函数。这一条验**调用点存在且会执行** ——
  // 纯函数层全绿，不等于「调用点传对了」；只有静态证据是不够的。
  const draft = path.join(__dirname, 'fixtures', 'thread-hint-probe.json');
  require('node:fs').writeFileSync(draft,
    JSON.stringify({ username: '__thread_hint_probe__', text: '判据用，不会真发' }));
  const r = spawnSync(process.execPath,
    [path.join(__dirname, '..', 'bin', 'outbox-send.js'), draft, '--dry-run'],
    { encoding: 'utf8', cwd: path.join(__dirname, '..'),
      env: { ...process.env, ENGLOOP_OUTBOX_AS: 'JARVIS' } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  ok(/既没有/.test(out), '★★ dry-run 的输出里真的出现了那条提醒', out.split('\n').slice(-3).join(' / '));
  // ⚠️ 位置判据：提醒必须在 dry-run 出口**之前** —— 否则真发那条路看不见它
  //   （否则可观测性只加在了没有副作用的那条路上）
  const iHint = out.indexOf('既没有');
  const iDry = out.indexOf('--dry-run');
  ok(iHint >= 0 && iDry >= 0 && iHint < iDry,
    '★★ 而它打在 dry-run 结论**之前** ⇒ 真发那条路也看得见',
    `hint@${iHint} dry@${iDry}`);
  require('node:fs').rmSync(draft, { force: true });
}

console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
