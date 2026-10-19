'use strict';

/**
 * 按 thread 数 agent 来回（`lib/thread-count.js`）的**源码级内存变异**：把一行在内存里改掉，要求**指定的那条**判据变红。
 * 一个字节都不落盘（`scripts/_srcmut-hook.js`，NODE_OPTIONS 带进 bus 和 poller 子进程）。
 *
 * 判档跟 `scripts/mutate-verify.js` 一样：
 *   ✅ killed     指定的那条（label 子串）出现在 `✗` 行里，且跑到了总结行
 *   ⚠️ crashed    没有总结行（进程崩了 / 超时）—— **不算 killed**
 *   🔴 survived   跑完了，而指定的那条仍是 `✓`
 *
 * M1–M7 是计数逻辑本身；W1–W5 是接线（调用点 / poller 字段 / poller 降级）；
 * S1 是批量结果错位，A1–A8 是回复告警即清零。
 *
 * 用法：node scripts/mutate-thread-count.js          全部（~3 分钟；W2 W3 起隔离 bus）
 *       node scripts/mutate-thread-count.js M1 W2    只跑这几个
 * 不进 run-all。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(__dirname, '_srcmut-hook.js');
const F = (p) => path.join(ROOT, p);
const TC = 'lib/thread-count.js';
const UNIT = 'test/thread-count.test.js';
const RELAY = 'test/relay.test.js';
const BUS = 'test/bus-auth.test.js';

const MUTANTS = [
  // ── 计数逻辑 ──
  { id: 'M1', what: '`>` 改成 `>=`（各 2 条就触发）',
    file: TC, from: 'tonumber(h[i + 1]) > limit', to: 'tonumber(h[i + 1]) >= limit',
    test: UNIT, expect: 'a 2 · b 2 ⇒ 不触发' },
  { id: 'M2', what: '「至少两个 agent」改成「至少一个」',
    file: TC, from: 'const MIN_AGENTS = 2;', to: 'const MIN_AGENTS = 1;',
    test: UNIT, expect: 'a 5 · b 1 ⇒ 一次都没触发' },
  { id: 'M3', what: '不排除 system（system 也数进来回）',
    file: TC, from: "return sender_type === 'agent' && kind !== 'status';",
    to: "return (sender_type === 'agent' || sender_type === 'system') && kind !== 'status';",
    test: UNIT, expect: 'system 发 3 条 ⇒ 不触发' },
  { id: 'M4', what: '人的消息不清零',
    file: TC, from: "  redis.call('DEL', KEYS[2])\n", to: '',
    test: UNIT, expect: '计数和「已告警」全清了' },
  { id: 'M5', what: '去掉「只告警一次」（超过以后每条都触发）',
    file: TC, from: "if redis.call('HSETNX', KEYS[2], '${ALERTED_FIELD}', ARGV[7]) == 1 then",
    to: "if redis.call('HSET', KEYS[2], '${ALERTED_FIELD}', ARGV[7]) >= 0 then",
    test: UNIT, expect: '第 4 轮 ⇒ 不再触发' },
  { id: 'M6', what: 'record 的异常往外抛（relay 的 drain 被打断）',
    file: TC, from: '      error: String((err && err.message) || err) });\n    return null;',
    to: '      error: String((err && err.message) || err) });\n    throw err;',
    test: RELAY, expect: '没有 error 事件' },
  { id: 'M7', what: '找根时不查父，直接用 reply_to（多层链断开）',
    file: TC, from: '  const parentRoot = await redis.get(rootKey(scope, replyTo));\n  return parentRoot || String(replyTo);',
    to: '  return String(replyTo);',
    test: UNIT, expect: 'J2 / J3 / J4 的根都是 J1' },
  // ── 接线 ──
  { id: 'W1', what: 'relay 不调 recordAndAlert',
    file: 'lib/relay.js', from: '        await threadCount.recordAndAlert(redis, {\n',
    to: '        if (false) await threadCount.recordAndAlert(redis, {\n',
    test: RELAY, expect: '第 6 条（两方各 3）⇒ orch:out 多了一条告警' },
  { id: 'W2', what: 'bus 的 /api/message 不清零',
    file: 'bin/serve.js', from: "    await threadCount.recordAndAlert(redis, { scope: 'dm',",
    to: "    if (false) await threadCount.recordAndAlert(redis, { scope: 'dm',",
    test: BUS, expect: '/api/message ⇒ 计数和「已告警」清零' },
  { id: 'W3', what: 'bus 的房间发言不清零',
    file: 'bin/serve.js', from: '    await threadCount.recordAndAlert(redis, { scope: threadCount.roomScope(r.hash),',
    to: '    if (false) await threadCount.recordAndAlert(redis, { scope: threadCount.roomScope(r.hash),',
    test: BUS, expect: '/api/rooms/:hash/post ⇒ 计数和「已告警」清零' },
  { id: 'W4', what: 'poller 不带 thread_over_limit',
    file: 'bin/next.js', from: '        thread_over_limit: overLimitFor(m),\n', to: '',
    test: UNIT, expect: '已告警 thread 里的那条带 thread_over_limit' },
  { id: 'W5', what: 'poller 查询失败不降级（异常漏到 main）',
    file: 'bin/next.js', from: '      overLimitFor = (m) => threadCount.overLimitField(byMsg.get(m));\n    } catch { /* 见上 */ }',
    to: '      overLimitFor = (m) => threadCount.overLimitField(byMsg.get(m));\n    } finally { /* 不降级 */ }',
    test: UNIT, expect: '查询失败 ⇒ 轮询照常返回' },
  // ── 批量结果按消息下标取 ⇒ 没锚点的那条之后全错位 ──
  { id: 'S1', what: 'next.js 按消息下标取 states（states[k++] → states[i]）',
    file: 'bin/next.js', from: 'byMsg.set(brainMessages[i], states[k++])', to: 'byMsg.set(brainMessages[i], states[i])',
    test: UNIT, expect: 'S1：「没锚点 · 已告警 · 没告警」' },
  // ── 回复告警即清零 ──
  { id: 'A1', what: '发告警时不记 alertref',
    file: TC, from: '    await redis.set(alertRefKey(sent.job_id),', to: '    if (false) await redis.set(alertRefKey(sent.job_id),',
    test: UNIT, expect: 'alertref：告警的 job_id' },
  { id: 'A2', what: '/api/message 不查 alertref（回复告警不清零）',
    file: 'bin/serve.js', from: '    if (sent.reply_to) await threadCount.resetByAlertReply(', to: '    if (false) await threadCount.resetByAlertReply(',
    test: BUS, expect: '回复告警 ⇒ 那个 JARVIS ↔ agent thread 清零' },
  { id: 'A3', what: 'resetByAlertReply 查到了却不清零',
    file: TC, from: '    await resetThread(redis, ref.scope, ref.root);\n', to: '',
    test: UNIT, expect: '告警记着的那个 thread：计数和「已告警」清零' },
  { id: 'A4', what: '告警 from 写回 system（落进一个不能回复的频道）',
    file: TC, from: '    from: ALERT_FROM,\n    to: threads.HUMAN,', to: "    from: 'system',\n    to: threads.HUMAN,",
    test: BUS, expect: 'WS 推来的告警 from=JARVIS' },
  { id: 'A5', what: 'poller 不带 thread_alert_ref',
    file: 'bin/next.js', from: '        thread_alert_ref: alertRefFor(m),\n', to: '',
    test: UNIT, expect: '回复告警的那条带 thread_alert_ref' },
  { id: 'A6', what: 'poller 的 alertref 查询失败不降级',
    file: 'bin/next.js', from: '      alertRefFor = (m) => byMsg.get(m);\n    } catch { /* 见上 */ }', to: '      alertRefFor = (m) => byMsg.get(m);\n    } finally { /* 不降级 */ }',
    test: UNIT, expect: 'alertref 查询失败 ⇒ 轮询照常返回' },
  { id: 'A7', what: 'alertref 不存在时当成错误',
    file: TC, from: '    const ref = await alertRefOf(redis, replyTo);\n    if (!ref) return null;', to: "    const ref = await alertRefOf(redis, replyTo);\n    if (!ref) throw new Error('没有 alertref');",
    test: UNIT, expect: 'alertref 不存在 ⇒ 返回 null，不抛、不报失败事件' },
  { id: 'A8', what: '批量读 alertref 用 MGET（坏 key 静默读成「不是告警」）',
    file: TC, from: "\"local out = {} for i = 1, #KEYS do out[i] = redis.call('GET', KEYS[i]) or '' end return out\",",
    to: "\"local v = redis.call('MGET', unpack(KEYS)) local out = {} for i = 1, #KEYS do out[i] = v[i] or '' end return out\",",
    test: UNIT, expect: 'alertref key 类型不对 ⇒ alertRefsMany 抛' },
];

function runOne(m) {
  const specs = (m.spec || [{ from: m.from, to: m.to }]).map((s) => ({ file: F(m.file), from: s.from, to: s.to }));
  const env = { ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${HOOK}`.trim(),
    ENGLOOP_SRCMUT: JSON.stringify(specs) };
  const r = spawnSync('node', [F(m.test)], { cwd: ROOT, env, encoding: 'utf8', timeout: 600_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const summary = /通过 \d+ · 失败 \d+/.exec(out);
  const red = out.split('\n').filter((l) => /^\s*✗/.test(l));
  const hit = red.some((l) => l.includes(m.expect));
  const verdict = !summary ? 'crashed' : hit ? 'killed' : 'survived';
  return { verdict, summary: summary ? summary[0] : `（无总结行，exit ${r.status}）`, red: red.length,
    first: (red.find((l) => l.includes(m.expect)) || red[0] || '').trim().slice(0, 140),
    tail: summary ? '' : out.slice(-400) };
}

const pick = process.argv.slice(2);
const list = pick.length ? MUTANTS.filter((m) => pick.includes(m.id)) : MUTANTS;
let killed = 0;
for (const m of list) {
  const r = runOne(m);
  if (r.verdict === 'killed') killed += 1;
  const icon = { killed: '✅', crashed: '⚠️', survived: '🔴' }[r.verdict];
  console.log(`${icon} ${m.id} ${r.verdict.padEnd(8)} ${m.what}`);
  console.log(`     ${path.basename(m.test)}：${r.summary} · 红 ${r.red} 条 · 指定那条：${r.first || '（没红）'}`);
  if (r.tail) console.log(`     ${r.tail.replace(/\n/g, '\n     ')}`);
}
console.log(`\n${killed}/${list.length} killed`);
process.exit(killed === list.length ? 0 : 1);
