#!/usr/bin/env node
'use strict';

/**
 * 「谁花的」—— 按 agent 看 token 消耗。
 *
 * 没有它的时候，这个问题只能靠 ps 看 CPU 分钟数去猜。
 *
 * 用法：
 *   node bin/cost.js                      按 agent（默认，只算 EngLoop）
 *   node bin/cost.js --by session|day|model
 *   node bin/cost.js --since YYYY-MM-DD   只看这天起
 *   node bin/cost.js --all                连别的项目一起（默认排除）
 *   node bin/cost.js --live               此刻谁在跑（pid/pane/名字）
 *   node bin/cost.js --check              上下文守恒自检
 *
 * **不出美元，也不要加。** 理由见 lib/cost.js 文件头：订阅制下那个量
 * 不存在，算出来既是编造的又是无关的。
 */

const cost = require('../lib/cost');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const n = (x) => x.toLocaleString('en-US');
const pad = (x, w) => String(x).padStart(w);

if (flag('--help') || flag('-h')) {
  console.log([
    '「谁花的」—— 按 agent 看 token 消耗。',
    '',
    '  node bin/cost.js                      按 agent（默认，只算 EngLoop）',
    '  node bin/cost.js --by session|day|model',
    '  node bin/cost.js --since 2026-08-10   只看这天起',
    '  node bin/cost.js --all                连别的项目一起（默认排除）',
    '  node bin/cost.js --live               此刻谁在跑（pid/pane/名字）',
    '  node bin/cost.js --check              上下文守恒自检',
    '',
    '不出美元 —— 订阅制下那个量不存在，理由见 lib/cost.js 文件头。',
  ].join('\n'));
  process.exit(0);
}

// ── --live：此刻谁在跑 ──────────────────────────────────────────
if (flag('--live')) {
  const rows = cost.liveSessions();
  if (!rows.length) {
    console.log('~/.claude/sessions 里一个都没有。');
    process.exit(0);
  }
  console.log(`${pad('pid', 7)}  ${'agent'.padEnd(12)} ${'name'.padEnd(18)} ${'tmux'.padEnd(18)} ${'活'.padEnd(3)} cwd`);
  for (const r of rows) {
    console.log(`${pad(r.pid, 7)}  ${String(r.agent || '—').padEnd(12)} ${String(r.name || '—').padEnd(18)} ${String(r.tmux || '—').padEnd(18)} ${(r.alive ? '✓' : '✗').padEnd(3)} ${r.cwd || '—'}`);
  }
  // 文件在而进程没了，是 watchdog 想知道的信号，不是噪音。
  const stale = rows.filter((r) => !r.alive).length;
  if (stale) console.log(`\n⚠ ${stale} 条记录的进程已经不在了（文件还在）。`);
  process.exit(0);
}

// ── 收集 ────────────────────────────────────────────────────────
const all = flag('--all');
const since = opt('--since');
const by = opt('--by', 'agent');

const t0 = Date.now();
const { entries, scannedFiles, rawRows, duplicateRows, conflicts } = cost.collect({ all, since });
const ms = Date.now() - t0;

if (!entries.length) {
  console.log('没有匹配的记录。');
  console.log(`（扫了 ${n(scannedFiles)} 个会话文件、${n(rawRows)} 行带 usage 的记录${since ? `，--since ${since}` : ''}${all ? '' : '，只算 EngLoop'}）`);
  process.exit(0);
}

// ── --check：自检。两层，强弱分开标 ─────────────────────────────
if (flag('--check')) {
  let bad = false;

  // 【1】硬检查：去重策略的正确性前提。这条破了，统计就在丢数据。
  console.log('【1】去重一致性（硬检查）');
  console.log(`  ${n(rawRows)} 行原始记录 → ${n(entries.length)} 次调用，压掉 ${n(duplicateRows)} 行重复`);
  if (!conflicts.length) {
    console.log('  ✓ 同一 requestId 的多行 usage 全部一致 —— 「取最大」不会丢数据。');
  } else {
    console.log(`  ✗ ${n(conflicts.length)} 个 requestId 的多行 usage 不一致，去重正在丢数据：`);
    for (const c of conflicts.slice(0, 5)) {
      console.log(`    ${c.key}  ${c.a.output}/${c.a.cacheRead} vs ${c.b.output}/${c.b.cacheRead}`);
    }
    bad = true;
  }

  // 【2】参考：字段语义自检。**不决定退出码** —— 已知会被
  //     「一个 session 里交错两条上下文链」误报，理由见 lib/cost.js。
  const { checked, violations, minorExcess, maxMinor } = cost.checkContextConservation(entries);
  console.log('\n【2】上下文守恒（参考，不决定退出码）');
  console.log(`  检查了 ${n(checked)} 对相邻调用`);
  if (minorExcess) {
    console.log(`  · ${n(minorExcess)} 处小幅超出，最大 ${n(maxMinor)} token —— 本轮新输入被写进缓存后下轮读回，正常。`);
  }
  if (!violations.length) {
    console.log('  ✓ 无数量级异常。');
  } else {
    console.log(`  ⚠ ${n(violations.length)} 处超出上限 1.5 倍以上，逐条看是不是链交错：`);
    for (const v of violations.slice(0, 10)) {
      console.log(`    ${v.sessionId.slice(0, 8)} @ ${v.at}  上限 ${n(v.ceiling)} 实际 ${n(v.actual)}`);
    }
    if (violations.length > 10) console.log(`    …还有 ${n(violations.length - 10)} 处`);
  }

  process.exit(bad ? 1 : 0);
}

// ── 报表 ────────────────────────────────────────────────────────
let rows;
try {
  rows = cost.aggregate(entries, { by });
} catch (e) {
  console.error(`✗ ${e.message}（可用：agent / session / day / model）`);
  process.exit(1);
}

const W = { key: Math.max(12, ...rows.map((r) => r.key.length)) };
console.log(`${'output'.padStart(12)} ${'input'.padStart(9)} ${'cache创建'.padStart(13)} ${'cache读取'.padStart(16)} ${'调用'.padStart(7)}  ${by}`);
console.log('─'.repeat(12 + 10 + 14 + 17 + 8 + 2 + W.key));
for (const r of rows) {
  console.log(`${pad(n(r.output), 12)} ${pad(n(r.input), 9)} ${pad(n(r.cacheCreate), 13)} ${pad(n(r.cacheRead), 16)} ${pad(n(r.calls), 7)}  ${r.key}`);
}

const tot = rows.reduce((a, r) => ({
  output: a.output + r.output, input: a.input + r.input,
  cacheCreate: a.cacheCreate + r.cacheCreate, cacheRead: a.cacheRead + r.cacheRead,
  calls: a.calls + r.calls,
}), { output: 0, input: 0, cacheCreate: 0, cacheRead: 0, calls: 0 });
console.log('─'.repeat(12 + 10 + 14 + 17 + 8 + 2 + W.key));
console.log(`${pad(n(tot.output), 12)} ${pad(n(tot.input), 9)} ${pad(n(tot.cacheCreate), 13)} ${pad(n(tot.cacheRead), 16)} ${pad(n(tot.calls), 7)}  合计`);

console.log(`\n扫了 ${n(scannedFiles)} 个会话文件 · ${n(rawRows)} 行原始记录 → 去重后 ${n(entries.length)} 次调用 · ${ms}ms`);
console.log(all
  ? '⚠ --all：包含了别的项目，这不是 EngLoop 的开销。'
  : '只统计 EngLoop 工作目录下的 agent（--all 看全机）。');
// 这行不是凑数：cache_read 常比 output 大三个数量级，
// 只看第一列会得出完全不同的「谁在烧」。
if (tot.cacheRead > tot.output * 50) {
  console.log(`★ cache读取 是 output 的 ${Math.round(tot.cacheRead / tot.output)} 倍 —— 只按 output 排名会误判。四列一起看。`);
}
