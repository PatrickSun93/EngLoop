'use strict';

/**
 * bin/compact-carry.js —— 压缩之后补回线索。
 *
 * ── 这个文件守什么 ────────────────────────────────────────────
 *   ① **只看刚压缩掉的那一段**：倒数第二条 compact_boundary（没有就从头）到最后一条之间；
 *      更早那段、压缩摘要本身、子 agent 的记录、坏行 —— 都不算；
 *   ② 每一栏抽到的是对的东西，而且有上限（取最近的 N 条）；
 *   ③ notice 只印给工作目录**恰好是仓库根**的那一个（JARVIS）；
 *   ④ 🔴 **任何错都不挡住压缩**：印一句「补回没做成」，退出 0；
 *   ⑤ 根 `.claude/settings.json` 的 hook 先跑它，而原来的 `cat notice` 兜底还在。
 *
 *   ★ 会话记录全是这里现造的假数据（tmpdir），不读任何真实会话。
 *   ★ 断言看的是**子进程真实的 stdout 和退出码**，以及导出函数的返回值。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'compact-carry.js');
const { region, polled, build, freshness, LIMIT } = require(CLI);

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

let reachedEnd = false;
process.on('exit', (code) => {
  if (!reachedEnd && code === 0) {
    console.error('\n✗ 测试没跑到终点就退出了（exit 0）—— **这不是「通过」。**');
    process.exitCode = 1;
  }
});

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'compact-carry-')));

// ── 造会话记录的几个小工具 ───────────────────────────────────────
let n = 0;
const human = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const call = (name, input) => {
  const id = `toolu_${++n}`;
  return [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }, id];
};
const result = (id, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
const tool = (name, input, out = 'ok') => { const [c, id] = call(name, input); return [c, result(id, out)]; };
const boundary = () => ({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' });
const summary = (text) => ({ type: 'user', isCompactSummary: true, message: { role: 'user', content: text } });
const lines = (entries) => entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)));
const write = (name, entries) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, `${lines(entries).join('\n')}\n`);
  return f;
};

function hook(input, raw) {
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8', input: raw !== undefined ? raw : JSON.stringify(input) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function main() {
  console.log('【1】只看刚压缩掉的那一段');
  {
    const ev = region(lines([
      human('第一段的要求'), ...tool('Edit', { file_path: '/a/old.js' }),
      boundary(), summary('这是压缩摘要，不算'),
      human('第二段的要求'), ...tool('Edit', { file_path: '/a/mid.js' }),
      '{这一行坏了', { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '子 agent 的话，不算' }] } },
      boundary(), summary('第二次的摘要'),
      human('压缩之后的话，不算'), ...tool('Edit', { file_path: '/a/new.js' }),
    ]));
    const texts = ev.filter((e) => e.kind === 'ask').map((e) => e.text);
    const files = ev.filter((e) => e.kind === 'call').map((e) => e.input.file_path);
    ok(texts.join('|') === '第二段的要求' && files.join('|') === '/a/mid.js',
       '两条分界线 ⇒ 只取它们之间（摘要、子 agent、坏行、分界之后的都不算）', JSON.stringify({ texts, files }));
    const one = region(lines([human('开头'), ...tool('Edit', { file_path: '/a/x.js' }), boundary(), human('之后')]));
    ok(one.filter((e) => e.kind === 'ask').map((e) => e.text).join('|') === '开头', '一条分界线 ⇒ 从头到它');
    const none = region(lines([human('还没压缩过'), said('好')]));
    ok(none.length === 2, '没有分界线 ⇒ 整份记录（手动跑的时候）');
    const meta = region(lines([human('<command-name>/compact</command-name>'), { type: 'user', isMeta: true, message: { content: '元信息' } }, boundary()]));
    ok(meta.length === 0, '以 < 开头的系统文字和 isMeta 不当成人的要求');
  }

  console.log('【2】最近收到的要求：人打的字 ＋ poller 收到的消息');
  {
    const poll = JSON.stringify({ messages: [{ stream_id: 's-1', job_id: 'j', from: 'Patrick', text: '把 "周报" 那份报告跑一下' }] });
    const c = build(region(lines([
      human('人直接打的字'),
      ...tool('Bash', { command: 'ENGLOOP_AGENT_TYPE=orchestrator node bin/next.js' }, poll),
      ...tool('Read', { file_path: '/x/temp/poll-dev.json' }, JSON.stringify({ messages: [{ from: 'senior', text: '审一下 EL2' }] })),
      ...tool('Bash', { command: 'cat notes.txt' }, '{"from":"不是 poller","text":"不算"}'),
      boundary(),
    ])));
    ok(c.asks.length === 3 && c.asks[0] === '人：人直接打的字', '人打的字带「人：」', JSON.stringify(c.asks));
    ok(c.asks[1] === 'Patrick：把 "周报" 那份报告跑一下', 'bin/next.js 的结果里抽出「谁：说了什么」（引号还原）', c.asks[1]);
    ok(c.asks[2] === 'senior：审一下 EL2', 'Read temp/poll-*.json 也算');
    ok(!c.asks.some((a) => a.includes('不算')), '别的命令输出里的 from/text 不算');
    ok(polled('{"from":"A","text":"x\\ny"}')[0] === 'A：x\ny', '正文里的转义还原');
    const many = build(region(lines([...Array.from({ length: 9 }, (_, i) => human(`要求 ${i}`)), human('长'.repeat(500)), boundary()])));
    ok(many.asks.length === LIMIT.asks && many.asks[0] === '人：要求 5', `只留最近 ${LIMIT.asks} 条`, JSON.stringify(many.asks.slice(0, 2)));
    ok(many.asks[LIMIT.asks - 1].length === 240 && many.asks[LIMIT.asks - 1].endsWith('…'), '每条截到 240 字');
  }

  console.log('【3】这一段做过的事：改过的文件、发出的消息、有副作用的命令');
  {
    const c = build(region(lines([
      ...tool('Edit', { file_path: '/r/lib/a.js', old_string: 'x', new_string: 'y' }),
      ...tool('Write', { file_path: '/r/docs/b.md', content: '...' }),
      ...tool('Write', { file_path: '/r/temp/outbox/JARVIS/1.json', content: JSON.stringify({ username: 'Patrick', text: '收到，开始做', ack: 's' }) }),
      ...tool('Write', { file_path: '/r/temp/outbox/JARVIS/2.json', content: JSON.stringify({ room_hash: 'abc123', text: '房间里说一句' }) }),
      ...tool('Bash', { command: 'git commit -m "EL2"' }, '[main 1a2b3c4] EL2\n 3 files changed'),
      ...tool('Bash', { command: 'ls -la && git status' }),
      ...tool('Bash', { command: 'rm -rf temp/old' }),
      ...tool('Bash', { command: 'cd /a/very/long/path && cd sub && git push -q origin main' }),
      boundary(),
    ])));
    ok(c.done[0] === '改了 /r/lib/a.js' && c.done[1] === '写了 /r/docs/b.md', '改文件、写文件 ⇒ 路径', JSON.stringify(c.done));
    ok(c.done[2] === '发给 Patrick：收到，开始做' && c.done[3] === '发给 房间 abc123：房间里说一句', '写进 outbox 的 ⇒ 发给谁、说了什么');
    ok(c.done[4] === '跑了 git commit -m "EL2"' && c.done[5] === '跑了 rm -rf temp/old' && c.done.length === 7,
       '有副作用的命令记下来；只读的命令（ls、git status）不记');
    ok(c.done[6] === '跑了 git push -q origin main', '开头的 cd … && 去掉（它只占地方）', c.done[6]);
    const many = build(region(lines([...Array.from({ length: 30 }, (_, i) => tool('Edit', { file_path: `/f${i}` })).flat(), boundary()])));
    ok(many.done.length === LIMIT.done && many.done[0] === '改了 /f10', `只留最近 ${LIMIT.done} 条`);
  }

  console.log('【4】还在用的标识：commit、运行、任务、标签页');
  {
    const c = build(region(lines([
      ...tool('Bash', { command: 'git commit -m x' }, '[EL2-draft/work 9f8e7d6] x'),
      ...tool('Bash', { command: 'node tools/batch.js run weekly --input history=h.log' },
        '{"run":"20261009-081500-a1b2c3","status":"review"}'),
      ...tool('Read', { file_path: '/r/temp/poll-dev.json' }, '{"job_id":"0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"}'),
      ...tool('mcp__claude-in-chrome__tabs_create_mcp', {}, '{"tabId": 1234567}'),
      ...tool('Bash', { command: 'git commit -m y' }, '[main 9f8e7d6] y again'),
      ...tool('Bash', { command: 'git push origin main' }, 'To github.com:x/y.git\n   1a2b3c4..5d6e7f8  main -> main'),
      boundary(),
    ])));
    ok(c.ids.includes('run 20261009-081500-a1b2c3（来自 Bash）'), '批处理工具的运行 id（形如 20261009-081500-a1b2c3）', JSON.stringify(c.ids));
    ok(c.ids.includes('job 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0（来自 Read）'), '总线任务 id');
    ok(c.ids.includes('tab 1234567（来自 mcp__claude-in-chrome__tabs_create_mcp）'), '浏览器标签页 id');
    ok(c.ids[c.ids.length - 1] === 'commit 5d6e7f8（来自 Bash）' && !c.ids.some((x) => x.includes('1a2b3c4')),
       'git push 的 a..b ⇒ 推上去的那个 b', JSON.stringify(c.ids));
    ok(c.ids.filter((x) => x.startsWith('commit 9f8e7d6')).length === 1 && c.ids[c.ids.length - 2].startsWith('commit 9f8e7d6'),
       '同一个标识只留一条，排在它最后出现的位置');
    const runs = Array.from({ length: 30 }, (_, i) => `20261009-0815${String(i).padStart(2, '0')}-a1b2c3`).join('\n');
    const many = build(region(lines([
      ...Array.from({ length: 8 }, (_, i) => tool('Bash', { command: 'git commit' }, `[main ${(0xabc0000 + i).toString(16)}] m`)).flat(),
      ...tool('Bash', { command: 'ls temp/batch-runs' }, runs),
      ...Array.from({ length: 8 }, (_, i) => tool('mcp__claude-in-chrome__navigate', {}, `{"tabId": ${5000 + i}}`)).flat(),
      boundary(),
    ])));
    const kinds = (k) => many.ids.filter((x) => x.startsWith(`${k} `));
    ok(many.ids.length === LIMIT.ids && [kinds('commit'), kinds('run'), kinds('tab')].every((xs) => xs.length === LIMIT.idsPerKind),
       `每类最多 ${LIMIT.idsPerKind} 个、一共最多 ${LIMIT.ids} 个 ⇒ 一次列目录吐出 30 个运行 id 也挤不掉 commit`, JSON.stringify(many.ids));
    ok(kinds('commit')[0].startsWith(`commit ${(0xabc0000 + 3).toString(16)}`) && kinds('tab')[4].startsWith('tab 5007'), '每类留的是最近的');
  }

  console.log('【5】开头读过的文件 · 被撤回的说法');
  {
    const c = build(region(lines([
      ...Array.from({ length: 14 }, (_, i) => tool('Read', { file_path: `/r/doc${i % 12}.md` })).flat(),
      said('测试 29 个全过。我说错了，是 28 个，第 29 个没跑到。'),
      said('结论：Laya 有用。'),
      said('上面那个结论不成立：Laya 没有用。'),
      said('正常的一句话，什么都没改。'),
      said('EL2 要补回被推翻的结论，也要补回撤回的说法。'),
      boundary(),
    ])));
    ok(c.reads.length === LIMIT.reads && c.reads[0] === '/r/doc0.md' && c.reads[9] === '/r/doc9.md',
       `开头读的前 ${LIMIT.reads} 个（去重，只给路径）`, JSON.stringify(c.reads));
    ok(c.retracted.length === 2 && c.retracted[0].startsWith('我说错了') && c.retracted[1].startsWith('上面那个结论不成立'),
       '自己更正自己的那一句（只要那一句）；谈论「推翻」「撤回」的句子不算', JSON.stringify(c.retracted));
  }

  console.log('【6】notice 只给仓库根的那一个；补回人人都有');
  {
    const t = write('t6.jsonl', [human('做 EL2'), ...tool('Edit', { file_path: '/r/bin/x.js' }), boundary(), summary('s')]);
    const crew = path.join(tmp, 'agents', 'dev');
    fs.mkdirSync(crew, { recursive: true });
    const atRoot = hook({ cwd: ROOT, transcript_path: t, source: 'compact' });
    // 公开版里没有这个 notice 文件 ⇒ 仓库根也只有补回；有文件时照旧先印它
    const noticeFile = path.join(ROOT, '.claude', 'compaction-notice.txt');
    const notice = fs.existsSync(noticeFile) ? fs.readFileSync(noticeFile, 'utf8').trimEnd() : '';
    ok(atRoot.code === 0 && (notice ? atRoot.out.startsWith(notice) : atRoot.out.startsWith('══ 压缩补回')),
      notice ? '工作目录是仓库根 ⇒ 先印 notice' : '工作目录是仓库根、notice 文件不在 ⇒ 不崩，只有补回', atRoot.out.slice(0, 80));
    ok(atRoot.out.includes('【最近收到的要求】\n· 人：做 EL2') && atRoot.out.includes('· 改了 /r/bin/x.js'), '…然后是补回');
    const atCrew = hook({ cwd: crew, transcript_path: t, source: 'compact' });
    ok(atCrew.code === 0 && !atCrew.out.includes('COMPACTION OVERRIDE') && atCrew.out.startsWith('══ 压缩补回'),
       '工作目录是 agents/dev ⇒ 没有 notice，只有补回', atCrew.out.slice(0, 80));
    const empty = write('t6b.jsonl', [boundary()]);
    const e = hook({ cwd: crew, transcript_path: empty });
    ok(e.out.includes('【这一段做过的事】\n· （没有改文件、发消息或有副作用的命令）'), '某一栏空着 ⇒ 明说「没有」，不省略');
  }

  console.log('【7】交接文件的新旧');
  {
    const crew = path.join(tmp, 'agents', 'senior');
    fs.mkdirSync(crew, { recursive: true });
    ok(/SESSION_SUMMARY\.md：不存在$/.test(freshness(crew, false)), '没有 ⇒ 说不存在', freshness(crew, false));
    const f = path.join(crew, 'SESSION_SUMMARY.md');
    fs.writeFileSync(f, 'x');
    const now = fs.statSync(f).mtimeMs;
    ok(/上次更新在 2 小时前$/.test(freshness(crew, false, now + 2.5 * 3600000)), '新的 ⇒ 只报几小时前');
    ok(/上次更新在 30 小时前 ⚠️ 超过 24 小时/.test(freshness(crew, false, now + 30 * 3600000)), '超过 24 小时 ⇒ 警告');
    ok(freshness(ROOT, true).startsWith(path.join('agents', 'JARVIS', 'SESSION_SUMMARY.md')), '仓库根 ⇒ 看 agents/JARVIS 的那份');
  }

  console.log('【8】🔴 任何错都不挡住压缩：一句话，退出 0');
  {
    const crew = path.join(tmp, 'agents', 'dev');
    for (const [label, input, raw] of [
      ['hook 没给 transcript_path', { cwd: crew }],
      ['transcript_path 指向不存在的文件', { cwd: crew, transcript_path: path.join(tmp, 'nope.jsonl') }],
      ['transcript_path 是个目录', { cwd: crew, transcript_path: tmp }],
      ['stdin 不是 JSON', null, 'not json at all'],
      ['stdin 是空的', null, ''],
    ]) {
      const r = hook(input, raw === undefined ? undefined : raw);
      ok(r.code === 0 && /补回没做成|【最近收到的要求】/.test(r.out) && r.err === '', `${label} ⇒ 退出 0，stdout 有话，stderr 空`,
         `code=${r.code} out=${r.out.slice(0, 100)} err=${r.err.slice(0, 100)}`);
    }
    const bad = hook({ cwd: crew, transcript_path: path.join(tmp, 'nope.jsonl') });
    ok(bad.out.includes('补回没做成') && bad.out.includes('SESSION_SUMMARY.md'), '说清楚没做成，并指向交接文件');
  }

  console.log('【9】总长有上限');
  {
    const t = write('t9.jsonl', [
      ...Array.from({ length: 40 }, (_, i) => tool('Edit', { file_path: `/r/${'很长的目录名/'.repeat(60)}${i}.js` })).flat(),
      boundary(),
    ]);
    const r = hook({ cwd: path.join(tmp, 'agents', 'dev'), transcript_path: t });
    ok(r.code === 0 && r.out.length <= LIMIT.total + 1 && r.out.trimEnd().endsWith(`（截到 ${LIMIT.total} 字）`),
       `补回不超过 ${LIMIT.total} 字，截断处明说`, `len=${r.out.length}`);
  }

  console.log('【10】根 settings.json：先跑它，cat 兜底还在');
  {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
    const hooks = s.hooks.SessionStart.filter((h) => h.matcher === 'compact').flatMap((h) => h.hooks);
    const cmd = hooks.length === 1 ? hooks[0].command : '';
    // 仓库根的写法不写死（本机绝对路径 / "$CLAUDE_PROJECT_DIR" 都算），顺序写死
    const ROOTISH = '(?:\\/\\S+|"\\$CLAUDE_PROJECT_DIR")';
    ok(new RegExp(`^node ${ROOTISH}\\/bin\\/compact-carry\\.js \\|\\| `).test(cmd), 'compact hook 先跑 compact-carry.js', cmd.slice(0, 90));
    ok(new RegExp(`\\|\\| cat ${ROOTISH}\\/\\.claude\\/compaction-notice\\.txt \\|\\| echo `).test(cmd), '它起不来 ⇒ 退回 cat notice ⇒ 再退回 echo');
    ok(!s.permissions && !(s.hooks && s.hooks.PreToolUse), '根配置里仍然没有 permissions、PreToolUse');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  reachedEnd = true;
  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  process.exitCode = fail ? 1 : 0;
}

main();
