#!/usr/bin/env node
'use strict';

/**
 * 压缩补回：上下文刚被压缩，把**压缩掉的那一段里**几样摘要最容易丢、而后面最常要用的东西，
 * 用规则抽出来，印给新的上下文。由根 `.claude/settings.json` 的 SessionStart(compact) hook 调用。
 *
 * ── 为什么是这几样，而不是「把要紧的工具输出原文补回去」──────────────
 *   ① 压缩后**还需要原文**的工具输出很少（约 4%），而且多半是一个**标识**（比如浏览器标签页 ID）；
 *   ② 「这个调用做过」比「它说了什么」更常被需要（约 23%：改过的文件、有副作用的命令、发出的东西）；
 *   ③ 让模型判断「还要不要」没有价值（它对几乎每条都说要）⇒ 这里**只用规则**。
 *   ⇒ 所以补回的是：最近收到的要求 · 做过的事 · 还在用的标识 · 开头读过的文件（只给路径）· 被撤回的说法 ·
 *     交接文件的新旧。**它不是摘要**，只是线索：以协议、文件和 git 为准。
 *
 * ── 输入 ───────────────────────────────────────────────────────
 *   hook 的 stdin：{ session_id, transcript_path, cwd, source: "compact", ... }。
 *   会话记录（JSONL）里，每次压缩留下一条 `{type:"system", subtype:"compact_boundary"}`；
 *   ⇒ **刚压缩掉的那一段 = 倒数第二条分界线（没有就从头）到最后一条之间。**
 *
 * ── 谁看到什么 ─────────────────────────────────────────────────
 *   根目录那份 hook 在**每一个** agent 的会话里都会跑（compaction-notice.txt 自己写着）。
 *   ⇒ `.claude/compaction-notice.txt` 只印给工作目录**恰好是仓库根**的那一个（JARVIS）；补回人人都有。
 *
 * ── 🔴 它不许挡住任何东西 ─────────────────────────────────────────
 *   读不到、解析不了、出任何错 ⇒ 印一句「补回没做成」，退出 0。hook 命令里还有 `|| cat notice` 兜底。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NOTICE = path.join(ROOT, '.claude', 'compaction-notice.txt');
const LIMIT = { asks: 5, done: 20, ids: 15, idsPerKind: 5, reads: 10, retracted: 5, total: 6000 };
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MUTATING = /\b(git (commit|push|checkout|reset|merge|rebase|tag|stash)|rm |mv |mkdir|npm (i|install|ci)\b|pip install|uv (add|sync)|brew install|launchctl|kill|pkill|tmux (new|kill)|chmod|ln -s|docker (run|compose))/;
// 只认**自己更正自己**的说法；光有「推翻」「撤回」两个字不算（谈论这个功能本身的句子里全是它们）。
const RETRACT = /(我说错|我错了|说错了|说反了|我撤回|我收回|撤回(上|前|刚)|收回(上|前|刚)|先更正|更正一下|纠正一下|结论不成立|这条不成立|I was wrong|I retract|correction:)/i;
const IDS = [
  ['commit', /\[[\w/.-]+ ([0-9a-f]{7,12})\]/g],                                          // git commit 的输出
  ['commit', /\b[0-9a-f]{7,12}\.\.([0-9a-f]{7,12})\s+\S+\s+->/g],                         // git push 的输出（commit -q 时只剩它）
  ['run', /\b(\d{8}-\d{6}-[0-9a-f]{6})\b/g],                                             // suitehost 的运行
  ['job', /"job_id"\s*:\s*"([0-9a-f-]{36})"/g],                                           // 总线上的任务
  ['tab', /\btab(?:Id|_id)?["']?\s*[:=]\s*["']?(\d{3,})/gi],                             // 浏览器标签页
];

const clip = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const textOf = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '');

/** 会话记录 → 事件，只留刚压缩掉的那一段。 */
function region(lines) {
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* 半行、坏行：跳过 */ }
  }
  const bounds = entries.map((e, i) => (e.type === 'system' && e.subtype === 'compact_boundary' ? i : -1)).filter((i) => i >= 0);
  const end = bounds.length ? bounds[bounds.length - 1] : entries.length;
  const start = bounds.length > 1 ? bounds[bounds.length - 2] + 1 : 0;
  const events = [];
  for (const e of entries.slice(start, end)) {
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isCompactSummary || e.isMeta) continue;
    const content = (e.message || {}).content;
    if (typeof content === 'string') {
      if (e.type === 'user' && !content.trimStart().startsWith('<')) events.push({ kind: 'ask', text: content });
      continue;
    }
    for (const b of content || []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && b.text && b.text.trim()) {
        if (e.type === 'user' && !b.text.trimStart().startsWith('<')) events.push({ kind: 'ask', text: b.text });
        if (e.type === 'assistant') events.push({ kind: 'said', text: b.text });
      } else if (b.type === 'tool_use') {
        events.push({ kind: 'call', id: b.id, name: b.name, input: b.input || {} });
      } else if (b.type === 'tool_result') {
        events.push({ kind: 'result', id: b.tool_use_id, text: textOf(b.content) });
      }
    }
  }
  return events;
}

/** poller 收到的消息（EngLoop 的「要求」大多从这里来，不是从人直接打的字）。 */
function polled(text) {
  const out = [];
  const re = /"from"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text))) {
    let body = m[2];
    try { body = JSON.parse(`"${m[2]}"`); } catch { /* 留原样 */ }
    out.push(`${m[1]}：${body}`);
  }
  return out;
}

function build(events) {
  const calls = new Map(events.filter((e) => e.kind === 'call').map((e) => [e.id, e]));
  const asks = [], done = [], ids = new Map(), reads = [], retracted = [];
  for (const e of events) {
    if (e.kind === 'ask') asks.push(`人：${e.text}`);
    if (e.kind === 'said') {
      for (const s of e.text.split(/(?<=[。！？.!?])\s*|\n+/)) if (RETRACT.test(s)) retracted.push(s);
    }
    if (e.kind === 'call') {
      const inp = e.input;
      if (EDIT_TOOLS.has(e.name) && inp.file_path) {
        if (/temp\/outbox\//.test(inp.file_path) && inp.content) {
          let msg = {};
          try { msg = JSON.parse(inp.content); } catch { /* 不是 JSON */ }
          const to = msg.username || (msg.room_hash && `房间 ${msg.room_hash}`) || (msg.work && `任务 ${msg.work}`) || '?';
          done.push(`发给 ${to}：${clip(msg.text || '', 80)}`);
        } else done.push(`${e.name === 'Write' ? '写了' : '改了'} ${inp.file_path}`);
      } else if (e.name === 'Bash' && inp.command && MUTATING.test(inp.command)) {
        done.push(`跑了 ${clip(inp.command.replace(/^(\s*cd\s+\S+\s*&&\s*)+/, ''), 120)}`);   // 开头的 cd 只占地方
      } else if (e.name === 'Read' && inp.file_path && !reads.includes(inp.file_path)) {
        reads.push(inp.file_path);
      }
    }
    if (e.kind === 'result') {
      const call = calls.get(e.id);
      if (call && call.name === 'Bash' && /bin\/next\.js/.test(call.input.command || '')) asks.push(...polled(e.text));
      if (call && call.name === 'Read' && /temp\/poll-[\w-]+\.json/.test(call.input.file_path || '')) asks.push(...polled(e.text));
      for (const [kind, re] of IDS) {
        for (const m of e.text.matchAll(re)) {
          const key = `${kind} ${m[1]}`;
          ids.delete(key);
          ids.set(key, call ? call.name : '?');   // 最后一次出现的排在最后
        }
      }
    }
  }
  const last = (xs, n) => xs.slice(-n);
  const uniq = (xs) => xs.filter((x, i) => xs.lastIndexOf(x) === i);
  return {
    asks: last(uniq(asks), LIMIT.asks).map((x) => clip(x, 240)),
    done: last(done, LIMIT.done),
    // 每类只留最近几个：一次列目录就能吐出几十个运行 id，不能让它把 commit 挤掉
    ids: last([...ids].filter(([k], i, all) => all.slice(i + 1).filter(([j]) => j.split(' ')[0] === k.split(' ')[0]).length < LIMIT.idsPerKind)
      .map(([k, by]) => `${k}（来自 ${by}）`), LIMIT.ids),
    reads: reads.slice(0, LIMIT.reads),
    retracted: last(uniq(retracted.map((s) => clip(s, 200))), LIMIT.retracted),
  };
}

function freshness(cwd, isRoot, now = Date.now()) {
  const file = isRoot ? path.join(ROOT, 'agents', 'JARVIS', 'SESSION_SUMMARY.md') : path.join(cwd, 'SESSION_SUMMARY.md');
  if (!fs.existsSync(file)) return `${path.relative(ROOT, file) || file}：不存在`;
  const hours = Math.floor((now - fs.statSync(file).mtimeMs) / 3600000);
  return `${path.relative(ROOT, file)} 上次更新在 ${hours} 小时前${hours > 24 ? ' ⚠️ 超过 24 小时：压缩前的事多半没写进去，先补它' : ''}`;
}

// 大小写不敏感的文件系统上 engloop 和 EngLoop 是同一个目录 ⇒ 比之前先换成磁盘上的真名。
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

function render(input, now = Date.now()) {
  const cwd = real(input.cwd || process.cwd());
  const isRoot = cwd === real(ROOT);
  const parts = [];
  if (isRoot && fs.existsSync(NOTICE)) parts.push(fs.readFileSync(NOTICE, 'utf8').trimEnd());
  const head = '══ 压缩补回（bin/compact-carry.js：从压缩掉的那一段会话记录里用规则抽的线索，不是摘要；以协议、文件、git 为准）══';
  let carry;
  try {
    if (!input.transcript_path || !fs.existsSync(input.transcript_path)) throw new Error('hook 没给会话记录，或文件不在');
    const c = build(region(fs.readFileSync(input.transcript_path, 'utf8').split('\n')));
    const block = (title, xs, empty) => [`【${title}】`, ...(xs.length ? xs.map((x) => `· ${x}`) : [`· ${empty}`])].join('\n');
    carry = [head,
      block('最近收到的要求', c.asks, '（这一段里没有）'),
      block('这一段做过的事', c.done, '（没有改文件、发消息或有副作用的命令）'),
      block('还在用的标识', c.ids, '（没有）'),
      block('这一段开头读过的文件（要用时重读，别凭印象）', c.reads, '（没有）'),
      block('被撤回或推翻的说法（别再当成结论）', c.retracted, '（没有）'),
      `【交接文件】${freshness(cwd, isRoot, now)}`].join('\n');
  } catch (e) {
    carry = `${head}\n（补回没做成：${e.message}。先重读你的 SESSION_SUMMARY.md。）`;
  }
  if (carry.length > LIMIT.total) carry = `${carry.slice(0, LIMIT.total - 20)}\n…（截到 ${LIMIT.total} 字）`;
  parts.push(carry);
  return parts.join('\n\n');
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* 没有 stdin 或不是 JSON：按空输入 */ }
  try {
    process.stdout.write(`${render(input)}\n`);
  } catch (e) {
    process.stdout.write(`（压缩补回没做成：${e.message}）\n`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { region, polled, build, freshness, render, LIMIT };
