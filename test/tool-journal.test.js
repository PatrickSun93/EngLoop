'use strict';

/**
 * `hooks/tool_journal.js` ＋ `lib/tool-journal.js` 的写入一侧（DUR1 S1）。
 *
 * 跑的是**真的 hook 进程**（spawn node，stdin 喂 JSON）—— 「退出码 0、stdout 为空」只有进程级才证明得了：
 * 函数级测试里 `record()` 抛了就是抛了，而 hook 要保证的恰恰是「抛了也 exit 0、一个字节都不印到 stdout」。
 *
 * stdin 的形状取自实测（Claude Code 2.1.312，见 lib/tool-journal.js 头注），不是照文档想象的。
 * 日志目录走 `ENGLOOP_JOURNAL_DIR` 指到临时目录 —— 不碰生产的 temp/journal/。
 *
 * 单跑：`node test/tool-journal.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const J = require('../lib/tool-journal');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'tool_journal.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-journal-test-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

/** 跑一次 hook。stdin 是对象就 JSON 化，字符串就原样喂。 */
function runHook(args, stdin, dir) {
  return spawnSync('node', [HOOK, ...args], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: { ...process.env, ENGLOOP_JOURNAL_DIR: dir },
    timeout: 20_000,
  });
}
// 读不出（文件不在 / 有坏行）⇒ []：判据红在自己那条上，而不是整份测试崩掉（崩了的变异不算被杀）
const lines = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const size = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };

// 实测形状（打码）
const SID = '11111111-2222-3333-4444-555555555555';
const pre = (id, tool, input) => ({ session_id: SID, transcript_path: '/x.jsonl', cwd: '/w', prompt_id: 'p', permission_mode: 'dontAsk',
  hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id });
const post = (id, tool, input) => ({ ...pre(id, tool, input), hook_event_name: 'PostToolUse', tool_response: { stdout: 'x' }, duration_ms: 3 });
const postFail = (id, tool, input, interrupt = false) => ({ ...pre(id, tool, input), hook_event_name: 'PostToolUseFailure',
  error: 'Exit code 1', is_interrupt: interrupt, duration_ms: 3 });

console.log('\n══ tool_journal hook ══════════════════════════════\n');

console.log('【1】intent / outcome 按 tool_use_id 配对，三个事件三种行');
{
  const dir = path.join(TMP, 'pair');
  const runs = [
    runHook(['--event', 'intent', '--name', 'dev'], pre('toolu_A', 'Bash', { command: 'echo hi', description: 'd' }), dir),
    runHook(['--event', 'outcome', '--name', 'dev'], post('toolu_A', 'Bash', { command: 'echo hi' }), dir),
    runHook(['--event', 'intent', '--name', 'dev'], pre('toolu_B', 'Bash', { command: 'ls /nope' }), dir),
    runHook(['--event', 'failure', '--name', 'dev'], postFail('toolu_B', 'Bash', { command: 'ls /nope' }, true), dir),
  ];
  ok(runs.every((r) => r.status === 0 && r.stdout === ''), '四次都 exit 0、stdout 为空', JSON.stringify(runs.map((r) => [r.status, r.stdout, r.stderr])));
  const L = lines(path.join(dir, 'dev.jsonl'));
  ok(L.length === 4, '写了 4 行', String(L.length));
  ok(L[0].phase === 'intent' && L[0].tool_use_id === 'toolu_A' && L[0].tool_name === 'Bash' && L[0].session_id === SID
    && typeof L[0].at === 'string' && L[0].input_summary.includes('echo hi'),
    'intent：phase / tool_use_id / tool_name / input_summary / session_id / at', JSON.stringify(L[0]));
  ok(L[1].phase === 'outcome' && L[1].tool_use_id === 'toolu_A' && L[1].ok === true && !('input_summary' in L[1]),
    'PostToolUse ⇒ outcome，同一个 tool_use_id，ok:true（outcome 不重复带输入）', JSON.stringify(L[1]));
  ok(L[3].phase === 'outcome' && L[3].tool_use_id === 'toolu_B' && L[3].ok === false && L[3].interrupted === true,
    'PostToolUseFailure ⇒ outcome ok:false（is_interrupt 带过来）', JSON.stringify(L[3]));
}

console.log('\n【2】截断：input_summary ≤ 1 KB，一行 ≤ 4 KB，多字节字不切半');
{
  const dir = path.join(TMP, 'trunc');
  const longCmd = `echo ${'汉'.repeat(3000)}`;   // 9 KB
  runHook(['--event', 'intent', '--name', 'dev'], pre('toolu_L', 'Bash', { command: longCmd }), dir);
  // Write 的 content 很长，后面还跟着一个字段：先各截字段，后面那个字段不被挤掉
  runHook(['--event', 'intent', '--name', 'dev'], pre('toolu_W', 'Write', { file_path: '/w/a.txt', content: 'x'.repeat(50_000), mode: 'tail-field' }), dir);
  // 控制字符：JSON 转义一个变六个 ⇒ 1 KB 的摘要能放大成 6 KB 的一行。
  //   （tool_input 是对象时 summarize 里那次 JSON.stringify 已经转义过、不会再放大六倍 ——
  //     所以这里喂一个**字符串**形态的 tool_input，那才是会撞上 4 KB 的那条路。）
  runHook(['--event', 'intent', '--name', 'dev'], pre('toolu_C', 'Bash', '\u0001'.repeat(5000)), dir);
  const raw = fs.readFileSync(path.join(dir, 'dev.jsonl'), 'utf8').split('\n').filter(Boolean);
  const L = raw.map((l) => JSON.parse(l));
  ok(L.length === 3, '三行都写了', String(L.length));
  ok(Buffer.byteLength(L[0].input_summary) <= J.INPUT_MAX && L[0].truncated === true,
    `长命令：input_summary ${Buffer.byteLength(L[0].input_summary)} B ≤ ${J.INPUT_MAX}，标了 truncated`);
  ok(!L[0].input_summary.includes('\uFFFD'), '没有切出半个字（没有 U+FFFD）');
  ok(L[1].input_summary.includes('"file_path":"/w/a.txt"') && L[1].input_summary.includes('tail-field'),
    'Write：content 先各截 ⇒ file_path 和排在 content 后面的字段都还在', L[1].input_summary.slice(-80));
  const maxLine = Math.max(...raw.map((l) => Buffer.byteLength(`${l}\n`)));
  ok(maxLine <= J.LINE_MAX, `每行 ≤ ${J.LINE_MAX} B（最长 ${maxLine} B，含控制字符放大那一行）`);
  ok(L[2].truncated === true && Buffer.byteLength(`${raw[2]}\n`) <= J.LINE_MAX, '控制字符那行被再砍过、仍是合法 JSON');
}

console.log('\n【3】轮转：超过 5 MB ⇒ 改名成 .1（只留一份），新行写进新文件');
{
  const dir = path.join(TMP, 'rot');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'dev.jsonl');
  fs.writeFileSync(`${file}.1`, 'old-rotated\n');
  fs.writeFileSync(file, 'x'.repeat(J.ROTATE_BYTES + 1));
  const r = runHook(['--event', 'intent', '--name', 'dev'], pre('toolu_R', 'Read', { file_path: '/a' }), dir);
  ok(r.status === 0 && r.stdout === '', 'exit 0、stdout 空');
  ok(size(`${file}.1`) === J.ROTATE_BYTES + 1, '.1 是刚才那份大文件（旧的 .1 被覆盖）');
  const L = lines(file);
  ok(L.length === 1 && L[0].tool_use_id === 'toolu_R', '新文件只有新写的这一行');
  const before = size(file);
  runHook(['--event', 'outcome', '--name', 'dev'], post('toolu_R', 'Read', { file_path: '/a' }), dir);
  ok(size(file) > before && size(`${file}.1`) === J.ROTATE_BYTES + 1, '没超过就不轮转（追加在原文件）');
}

console.log('\n【4】写失败 / 坏输入 ⇒ 退出码 0 且 stdout 为空（hook 永远不做决定）');
{
  const asFile = path.join(TMP, 'not-a-dir');
  fs.writeFileSync(asFile, 'i am a file');
  const cases = [
    ['日志目录是个文件（mkdir 失败）', runHook(['--event', 'intent', '--name', 'dev'], pre('toolu_X', 'Bash', { command: 'x' }), asFile)],
    ['日志文件是个目录（append 失败）', (() => {
      const d = path.join(TMP, 'filedir'); fs.mkdirSync(path.join(d, 'dev.jsonl'), { recursive: true });
      return runHook(['--event', 'intent', '--name', 'dev'], pre('toolu_X', 'Bash', { command: 'x' }), d);
    })()],
    ['垃圾 stdin', runHook(['--event', 'intent', '--name', 'dev'], '{not json', path.join(TMP, 'junk'))],
    ['空 stdin', runHook(['--event', 'intent', '--name', 'dev'], '', path.join(TMP, 'empty'))],
    ['没给 --name', runHook(['--event', 'intent'], pre('toolu_X', 'Bash', { command: 'x' }), path.join(TMP, 'noname'))],
    ['--name 带路径穿越', runHook(['--event', 'intent', '--name', '../evil'], pre('toolu_X', 'Bash', { command: 'x' }), path.join(TMP, 'trav'))],
    ['不认识的 --event', runHook(['--event', 'allow', '--name', 'dev'], pre('toolu_X', 'Bash', { command: 'x' }), path.join(TMP, 'badev'))],
  ];
  for (const [what, r] of cases) {
    ok(r.status === 0 && r.stdout === '', `${what}：exit 0、stdout 空`, JSON.stringify([r.status, r.stdout, (r.stderr || '').slice(0, 120)]));
  }
  ok(/没记上/.test(cases[0][1].stderr), '写失败时 stderr 留一行（verbose 模式里看得见）', cases[0][1].stderr);
  ok(!fs.existsSync(path.join(TMP, 'noname')) && !fs.existsSync(path.join(TMP, 'trav')) && !fs.existsSync(path.join(TMP, 'evil.jsonl'))
    && !fs.existsSync(path.join(TMP, 'badev')),
    '名字不合格 / event 不认识 ⇒ 什么都不写');
}

console.log('\n【5】SessionStart ⇒ <name>.session（整份覆盖，给 --resume 用）');
{
  const dir = path.join(TMP, 'sess');
  const ss = (sid, source) => ({ session_id: sid, transcript_path: '/x.jsonl', cwd: '/w/dev', hook_event_name: 'SessionStart', source });
  const r1 = runHook(['--event', 'session', '--name', 'dev'], ss(SID, 'startup'), dir);
  const SID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const r2 = runHook(['--event', 'session', '--name', 'dev'], ss(SID2, 'clear'), dir);
  ok(r1.status === 0 && r1.stdout === '' && r2.status === 0 && r2.stdout === '', 'exit 0、stdout 空');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'dev.session'), 'utf8'));
  ok(rec.session_id === SID2 && rec.cwd === '/w/dev' && rec.source === 'clear' && typeof rec.at === 'string',
    '后一次覆盖前一次（/clear 换了新 id ⇒ 记的是新的）', JSON.stringify(rec));
  ok(!fs.existsSync(path.join(dir, 'dev.jsonl')), 'session 事件不往 jsonl 里写');
  ok(fs.readdirSync(dir).every((f) => !f.includes('.tmp-')), '没有留下临时文件');
}

console.log(`\n  通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
