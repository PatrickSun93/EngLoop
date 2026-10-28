'use strict';

/**
 * DUR1 S2：`bin/next.js` 交出一条 `redelivered: true` 的消息时，附上 `recovery`。
 *
 * 跑的是**真的 `bin/next.js` 子进程**，连本进程分到的测试库（隔离 bus：`ENGLOOP_REDIS_URL` 指过去，
 * 理由同 test/wiring.test.js 文件头）。重投是真的 XAUTOCLAIM 捞出来的：
 *   旧消费者领走（进 PEL）⇒ `XCLAIM … IDLE 120000` 把空闲时间改成 2 分钟（等价于「等 60 秒」，不用真等）
 *   ⇒ next.js 的 autoclaim（minIdleMs 60000）把它捞回来、打上 redelivered。
 * 日志是一份假的 `temp/journal/<name>.jsonl`，行用 `lib/tool-journal.js` 的 `lineFor()` 生成 ——
 * **跟 hook 写的是同一个函数**：写的一侧改了字段名，这里读不到会红，而不是两边各自绿。
 *
 * 所有按人分的状态（日志、探针、waiting、thread 告警、busy）都指到临时目录 —— 夹具活在生产状态之外。
 *
 * 单跑：`node test/tool-journal-recovery.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const J = require('../lib/tool-journal');

const ROOT = path.join(__dirname, '..');
const NEXT_JS = path.join(ROOT, 'bin', 'next.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-recovery-test-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

function runNext(agent, journalDir) {
  const db = q.allocTestDb();
  const env = {
    ...process.env,
    ENGLOOP_REDIS_URL: `redis://127.0.0.1:6379/${db}`,
    ENGLOOP_AGENT_TYPE: 'dev',
    ENGLOOP_JOURNAL_DIR: journalDir,
    ENGLOOP_OUTBOX_ROOT: path.join(TMP, 'outbox'),
    ENGLOOP_PROBE_STATE: path.join(TMP, `probe-${agent}.json`),
    ENGLOOP_WAITING_STATE: path.join(TMP, `waiting-${agent}.json`),
    ENGLOOP_THREAD_ALERT_DIR: path.join(TMP, 'thread-alert'),
    ENGLOOP_BUSY_ROOT: path.join(TMP, 'busy'),
  };
  const r = spawnSync('node', [NEXT_JS, '--group', `agent:${agent}`, '--consumer', `${agent}-1`,
    '--streams', `agent:${agent}:in`, '--name', agent, '--block', '500'], { cwd: ROOT, encoding: 'utf8', env, timeout: 30_000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* 下面报 */ }
  return { r, out };
}

/** 造一条「被旧消费者领走、空闲 2 分钟」的消息，返回它的流条目 id。 */
async function redeliverable(redis, agent, text) {
  const stream = `agent:${agent}:in`;
  const group = `agent:${agent}`;
  await redis.del(stream);
  await roster.register(redis, agent, { type: 'dev', cwd: TMP, tmux_session: `agent_${agent}` });
  await q.ensureGroup(redis, stream, group);
  const sent = await q.send(redis, stream, { from: 'tester', to: agent, text });
  await q.claimNext(redis, { streams: [stream], group, consumer: 'old-consumer', blockMs: 100 });
  await redis.xclaim(stream, group, 'old-consumer', 0, sent.id, 'IDLE', 120000);
  return sent.id;
}

/** 按 hook 的格式写一份假日志。events: [event, input, offsetMsFromEntry] */
function writeJournal(dir, name, entryId, events, { rotated = [], garbage = 0 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const t0 = J.entryMs(entryId);
  const fmt = (list) => list.map(([ev, input, off]) => J.fitLine(J.lineFor(ev, input, t0 + off))).join('');
  if (rotated.length) fs.writeFileSync(path.join(dir, `${name}.jsonl.1`), fmt(rotated));
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), fmt(events) + '{broken line\n'.repeat(garbage));
}
const call = (id, tool, input) => ({ session_id: 'sid', tool_use_id: id, tool_name: tool, tool_input: input });

async function main() {
  const redis = q.createClient();
  console.log('\n══ S2 · 重投消息的 recovery ══════════════════════════════\n');

  console.log('【1】有日志：配对、分类、shown/total、排除本次 poll');
  {
    const agent = 'recoverytesta';
    const id = await redeliverable(redis, agent, '把 X 部署一下');
    const dir = path.join(TMP, 'jA');
    const edits = [];
    for (let i = 0; i < 55; i++) {
      edits.push(['intent', call(`toolu_e${i}`, 'Edit', { file_path: `/w/f${i}.js` }), 1000 + i * 10]);
      edits.push(['outcome', call(`toolu_e${i}`, 'Edit', {}), 1001 + i * 10]);
    }
    writeJournal(dir, agent, id, [
      // 时间窗之前（这条消息入流之前）的调用：不该出现
      ['intent', call('toolu_before', 'Edit', { file_path: '/w/before-window' }), -60_000],
      ['outcome', call('toolu_before', 'Edit', {}), -59_000],
      ...edits,
      ['intent', call('toolu_grep', 'Grep', { pattern: 'x' }), 5000],
      ['outcome', call('toolu_grep', 'Grep', {}), 5001],
      ['intent', call('toolu_done', 'Write', { file_path: '/w/done-write', content: 'y' }), 6000],
      ['outcome', call('toolu_done', 'Write', {}), 6001],
      ['intent', call('toolu_fail', 'Bash', { command: 'make deploy-half' }), 7000],
      ['failure', call('toolu_fail', 'Bash', {}), 7001],
      // 没有 outcome 的两条：一条只读、一条可能有副作用
      ['intent', call('toolu_openread', 'Read', { file_path: '/w/a.txt' }), 8000],
      ['intent', call('toolu_open', 'Bash', { command: 'touch /w/flag' }), 9000],
      // 本次 poll 自己（outcome 要等这个进程退出才会有）
      ['intent', call('toolu_poll', 'Bash', { command: 'node bin/next.js --group agent:x' }), 10_000],
    ], {
      // 轮转出去的那份里也有窗内的调用：要读到
      rotated: [['intent', call('toolu_rot', 'Edit', { file_path: '/w/rotated' }), 500], ['outcome', call('toolu_rot', 'Edit', {}), 501]],
      garbage: 1,
    });
    const { r, out } = runNext(agent, dir);
    ok(r.status === 0 && out, 'next.js 正常退出、stdout 是 JSON', (r.stderr || r.stdout || '').slice(0, 300));
    const m = out && out.messages && out.messages.find((x) => x.stream_id === `agent:${agent}:in:::${id}`);
    ok(m && m.redelivered === true, '这条是 autoclaim 捞回来的（redelivered:true）', JSON.stringify(m && { r: m.redelivered }));
    const rec = m && m.recovery;
    ok(rec && rec.available === true, 'recovery.available = true', String(JSON.stringify(rec)).slice(0, 200));
    ok(rec && rec.note === J.NOTE, '带固定说明（日志 fail-open：「这里没有」不等于「没做过」）');
    const no = rec && rec.no_outcome;
    ok(no && no.total === 2 && no.shown === 2 && no.items.map((x) => x.tool_name).join(',') === 'Read,Bash',
      '没有 outcome 的：Read 和 Bash 两条（本次 poll 不算）', JSON.stringify(no));
    const it = (i) => (no && no.items[i]) || {};
    ok(it(0).advice === J.ADVICE_READONLY && it(1).advice === J.ADVICE_MAYBE,
      '只读 ⇒「只读，可以重做」；其余 ⇒「可能已生效，重复之前先检查」', JSON.stringify(no && no.items.map((x) => x.advice)));
    ok(String(it(1).input_summary).includes('touch /w/flag'), '列出 input_summary');
    ok(rec && rec.excluded_current_poll === 1, '本次 poll 自己那条被排除，并且报了数');
    const done = rec && rec.completed_with_side_effects;
    ok(done && done.total === 58 && done.shown === J.LIST_MAX && done.items.length === J.LIST_MAX,
      `已完成、可能有副作用：total 58（55 Edit ＋ 轮转那份 1 ＋ Write ＋ 失败的 Bash），shown ${J.LIST_MAX}`, JSON.stringify(done && { shown: done.shown, total: done.total }));
    const last2 = done ? done.items.slice(-2) : [];
    ok(last2.length === 2 && last2[0].tool_name === 'Write' && last2[0].ok === true && last2[1].tool_name === 'Bash' && last2[1].ok === false,
      '列的是最近的那几条；失败的 Bash 也列（ok:false —— 非零退出不等于什么都没改）', JSON.stringify(last2));
    const all = JSON.stringify(rec) || '';
    ok(rec && rec.readonly_completed === 1, '已完成的只读调用只报数（Grep 1 条）');
    ok(rec && rec.unparsable_lines === 1, '坏行跳过并报数');
    // 轮转那份：它在 total 里（58 里那 1 条），shown 的是最近 10 条所以不一定看得到 —— 直接用库函数再确认一次
    const wide = J.buildRecovery({ name: agent, entryId: id, dir, limit: 100, maxBytes: 1e9 });
    ok(wide.completed_with_side_effects.items.some((x) => x.input_summary.includes('/w/rotated')), '轮转出去的 .1 里的窗内调用也读到了');
    // 时间窗：用不截断的那份看（最近 10 条里本来就不会有最旧那条 —— 在截断的列表上断言「不出现」是恒真的）
    ok(!JSON.stringify(wide).includes('before-window') && wide.completed_with_side_effects.total === 58, '时间窗之前的调用不出现（不截断的那份里也没有）');
    const bytes = Buffer.byteLength(all);
    ok(rec && bytes <= J.RECOVERY_MAX_BYTES, `这条消息额外加了 ${bytes} B（上限 ${J.RECOVERY_MAX_BYTES}）`);
  }

  console.log('\n【2】读不到日志 ⇒ recovery: {available:false, reason}，不省略');
  {
    const agent = 'recoverytestb';
    const id = await redeliverable(redis, agent, '再来一条');
    const { r, out } = runNext(agent, path.join(TMP, 'jB-empty'));
    const m = out && out.messages && out.messages.find((x) => x.stream_id === `agent:${agent}:in:::${id}`);
    ok(r.status === 0 && m && m.redelivered === true, '捞回来了', (r.stderr || '').slice(0, 200));
    ok(m && 'recovery' in m && m.recovery.available === false && typeof m.recovery.reason === 'string' && m.recovery.reason.length > 0,
      'recovery 在，available:false，带 reason', JSON.stringify(m && m.recovery));
  }

  console.log('\n【3】不是重投的消息 ⇒ 没有 recovery 字段');
  {
    const agent = 'recoverytestc';
    const stream = `agent:${agent}:in`;
    await redis.del(stream);
    await roster.register(redis, agent, { type: 'dev', cwd: TMP, tmux_session: `agent_${agent}` });
    await q.ensureGroup(redis, stream, `agent:${agent}`);
    await q.send(redis, stream, { from: 'tester', to: agent, text: '新消息' });
    const { out } = runNext(agent, path.join(TMP, 'jA'));
    const m = out && out.messages && out.messages[0];
    ok(m && m.redelivered === undefined && !('recovery' in m), '新消息：没有 redelivered、没有 recovery', JSON.stringify(m && Object.keys(m)));
  }

  console.log('\n【4】字节上限：病态日志（1 KB 的多字节 / 控制字符摘要）也压在上限内，shown 跟着变小、total 不变');
  {
    const dir = path.join(TMP, 'jD');
    const id = `${Date.now() - 5000}-0`;
    const ev = [];
    for (let i = 0; i < 40; i++) {
      ev.push(['intent', call(`toolu_x${i}`, 'Bash', { command: (i % 2 ? '\u0001' : '汉').repeat(2000) }), 100 + i]);
      if (i % 2) ev.push(['outcome', call(`toolu_x${i}`, 'Bash', {}), 100 + i]);
    }
    writeJournal(dir, 'stress', id, ev);
    const rec = J.buildRecovery({ name: 'stress', entryId: id, dir });
    const bytes = Buffer.byteLength(JSON.stringify(rec));
    ok(bytes <= J.RECOVERY_MAX_BYTES, `最坏情况 ${bytes} B ≤ ${J.RECOVERY_MAX_BYTES}`);
    const a = rec.no_outcome; const b = rec.completed_with_side_effects;
    ok(a.total === 20 && b.total === 20 && a.shown === a.items.length && b.shown === b.items.length && a.shown + b.shown < 2 * J.LIST_MAX,
      `被压过：shown ${a.shown}/${a.total} · ${b.shown}/${b.total}（shown 跟条目数一致，total 是真数）`);
  }

  await redis.quit();
  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
