'use strict';

/**
 * DUR1（工具调用日志 · 重投 recovery · `--resume`）的**源码级内存变异**：把关键一行在内存里删掉 / 改掉，
 * 要求指定测试里**指定的那条**判据变红。一个字节都不落盘（`scripts/_srcmut-hook.js`）。
 * 判档同 `scripts/mutate-launch.js`：
 *   ✅ killed   指定的那条出现在 `✗` 行里，且跑到了总结行
 *   ⚠️ crashed  没有总结行 —— 不算 killed
 *   🔴 survived 跑完了，指定的那条仍是 `✓`
 *
 * ★ 变异经 NODE_OPTIONS 跟进子进程：hook 进程、bin/next.js、agent-start 都是测试 spawn 出来的 ——
 *   只在测试进程里变的话，「hook 里没变」⇒ 判据恒绿。
 *
 * 用法：node scripts/mutate-dur1.js            全部
 *       node scripts/mutate-dur1.js D3 D7      只跑这几个
 * 不进 run-all。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(__dirname, '_srcmut-hook.js');
const F = (p) => path.join(ROOT, p);

const T_HOOK = 'test/tool-journal.test.js';
const T_REC = 'test/tool-journal-recovery.test.js';
const T_SET = 'test/agent-settings.test.js';
const T_RES = 'test/agent-resume.test.js';
const T_LH = 'test/launch-hygiene.test.js';

const MUTANTS = [
  // ── S1 写入 ──
  { id: 'D1', what: 'hook：吞异常之后不退 0（异常冒泡 ⇒ 非零退出）',
    file: 'hooks/tool_journal.js', test: T_HOOK, from: '  try { main(); } catch (e) {', to: '  { main(); } {',
    expect: '日志目录是个文件（mkdir 失败）：exit 0、stdout 空' },
  { id: 'D2', what: 'hook：往 stdout 印一行（PreToolUse 的 stdout 会被当成权限决定）',
    file: 'hooks/tool_journal.js', test: T_HOOK, from: '  process.exit(0);\n}', to: '  process.stdout.write("{}\\n");\n  process.exit(0);\n}',
    expect: '四次都 exit 0、stdout 为空' },
  { id: 'D3', what: 'lib：PostToolUseFailure 也记成 ok:true',
    file: 'lib/tool-journal.js', test: T_HOOK, from: "const ok = event === 'outcome';", to: 'const ok = true;',
    expect: 'PostToolUseFailure ⇒ outcome ok:false' },
  { id: 'D4', what: 'lib：outcome 不带 tool_use_id（配不上对）',
    file: 'lib/tool-journal.js', test: T_HOOK, from: "  return { phase: 'outcome', ...base,", to: "  return { phase: 'outcome', ...base, tool_use_id: null,",
    expect: 'PostToolUse ⇒ outcome，同一个 tool_use_id' },
  { id: 'D5', what: 'lib：不截断 input_summary',
    file: 'lib/tool-journal.js', test: T_HOOK, from: '  const c = capBytes(json, INPUT_MAX);', to: '  const c = { text: json, cut: false };',
    expect: '长命令：input_summary' },
  { id: 'D6', what: 'lib：不做「一行 ≤ 4 KB」的最后一道（控制字符转义放大）',
    file: 'lib/tool-journal.js', test: T_HOOK, from: '  while (Buffer.byteLength(line) > LINE_MAX && o.input_summary) {', to: '  while (false) {',
    expect: '每行 ≤' },
  { id: 'D7', what: 'lib：字段不先各截（Write 的长 content 把后面的字段挤掉）',
    file: 'lib/tool-journal.js', test: T_HOOK, from: "      const c = capBytes(v, k === 'command' ? INPUT_MAX : FIELD_MAX);", to: '      const c = { text: v, cut: false };',
    expect: '排在 content 后面的字段都还在' },
  { id: 'D8', what: 'lib：不轮转',
    file: 'lib/tool-journal.js', test: T_HOOK, from: '  if (size > ROTATE_BYTES) {', to: '  if (false) {',
    expect: '.1 是刚才那份大文件' },
  { id: 'D9', what: 'lib：截断按 UTF-16 下标切（切出半个字）',
    file: 'lib/tool-journal.js', test: T_HOOK, from: "  t = t.replace(/\\uFFFD+$/, '');", to: '',
    expect: '没有切出半个字' },
  // ── S1 挂载 ──
  { id: 'D10', what: 'agent-settings：编排者不挂 journal',
    file: 'lib/agent-settings.js', test: T_SET, from: "  if (kind !== 'worker') {\n    hooks.PreToolUse", to: "  if (kind === 'crew') {\n    hooks.PreToolUse",
    expect: 'orchestrator/JARVIS：PreToolUse 挂了 journal' },
  { id: 'D11', what: 'agent-settings：worker 也挂 journal',
    file: 'lib/agent-settings.js', test: T_SET, from: "  if (kind !== 'worker') {\n    hooks.PreToolUse", to: '  if (true) {\n    hooks.PreToolUse',
    expect: '★ worker **没挂** journal' },
  { id: 'D12', what: 'agent-settings：编排者也挂 check_security',
    file: 'lib/agent-settings.js', test: T_SET, from: "  if (kind !== 'orchestrator') {\n    hooks.PreToolUse = [{", to: '  if (true) {\n    hooks.PreToolUse = [{',
    expect: '★ 编排者**仍然没有** check_security' },
  { id: 'D13', what: 'agent-settings：不挂 PostToolUseFailure（失败的调用看起来像崩溃）',
    file: 'lib/agent-settings.js', test: T_SET, from: "    hooks.PostToolUseFailure = [journalEntry('failure')];\n", to: '',
    expect: 'PostToolUseFailure 挂了 journal' },
  { id: 'D14', what: 'agent-settings：journal 的 --name 写成固定值（冒名）',
    file: 'lib/agent-settings.js', test: T_SET, from: '--name ${shellJoin([name])}`;\n  const journalEntry', to: "--name dev`;\n  const journalEntry",
    expect: '--name 是它自己的名字' },
  // ── S2 ──
  { id: 'D15', what: 'recovery：删掉「没有 outcome」那一支（全当成已完成）',
    file: 'lib/tool-journal.js', test: T_REC, from: '  let open = intents.filter((e) => !e.tool_use_id || !outcomes.has(e.tool_use_id));', to: '  let open = [];',
    expect: '没有 outcome 的：Read 和 Bash 两条' },
  { id: 'D16', what: 'recovery：只读工具也说「可能已生效」',
    file: 'lib/tool-journal.js', test: T_REC, from: 'advice: READONLY_TOOLS.has(e.tool_name) ? ADVICE_READONLY : ADVICE_MAYBE', to: 'advice: ADVICE_MAYBE',
    expect: '只读 ⇒「只读，可以重做」' },
  { id: 'D17', what: 'recovery：上限不报 total（total 写成 shown）',
    file: 'lib/tool-journal.js', test: T_REC, from: '  return { shown: items.length, total: arr.length, items };', to: '  return { shown: items.length, total: items.length, items };',
    expect: '已完成、可能有副作用：total 58' },
  { id: 'D18', what: 'recovery：读不到日志时省略字段（返回 undefined）',
    file: 'lib/tool-journal.js', test: T_REC, from: 'const unavailable = (reason) => ({ available: false, reason });', to: 'const unavailable = () => undefined;',
    expect: 'recovery 在，available:false，带 reason' },
  { id: 'D19', what: 'recovery：不按时间窗过滤',
    file: 'lib/tool-journal.js', test: T_REC, from: 'return Number.isFinite(t) && t >= from;', to: 'return true;',
    expect: '时间窗之前的调用不出现' },
  { id: 'D20', what: 'recovery：不排除本次 poll 自己',
    file: 'lib/tool-journal.js', test: T_REC, from: '  if (last && isPollerCall(last)) {', to: '  if (false) {',
    expect: '没有 outcome 的：Read 和 Bash 两条' },
  { id: 'D21', what: 'recovery：没有固定说明',
    file: 'lib/tool-journal.js', test: T_REC, from: '    note: NOTE,\n', to: '',
    expect: '带固定说明' },
  { id: 'D22', what: 'recovery：不读轮转出去的 .1',
    file: 'lib/tool-journal.js', test: T_REC, from: '  for (const f of [`${file}.1`, file]) {', to: '  for (const f of [file]) {',
    expect: '轮转出去的 .1 里的窗内调用也读到了' },
  { id: 'D23', what: 'recovery：不做字节上限',
    file: 'lib/tool-journal.js', test: T_REC, from: '  while (Buffer.byteLength(JSON.stringify(rec)) > maxBytes) {', to: '  while (false) {',
    expect: '最坏情况' },
  { id: 'D24', what: 'next.js：重投消息不带 recovery（接线被摘掉）',
    file: 'bin/next.js', test: T_REC, from: "        recovery: m.redelivered === true ? recoveryFor(m) : undefined,\n", to: '',
    expect: 'recovery.available = true' },
  { id: 'D25', what: 'next.js：新消息也带 recovery',
    file: 'bin/next.js', test: T_REC, from: 'recovery: m.redelivered === true ? recoveryFor(m) : undefined,', to: 'recovery: recoveryFor(m),',
    expect: '新消息：没有 redelivered、没有 recovery' },
  { id: 'D26', what: 'recovery：失败的调用不列（只列 ok:true）',
    file: 'lib/tool-journal.js', test: T_REC, from: "  const effectful = finished.filter((e) => !READONLY_TOOLS.has(e.tool_name));", to: "  const effectful = finished.filter((e) => !READONLY_TOOLS.has(e.tool_name) && outcomes.get(e.tool_use_id).ok === true);",
    expect: '失败的 Bash 也列' },
  // ── S3 ──
  { id: 'D27', what: 'resumePlan：不比 cwd',
    file: 'lib/tool-journal.js', test: T_RES, from: "  if (typeof record.cwd !== 'string' || real(record.cwd) !== real(cwd)) {", to: '  if (false) {',
    expect: 'cwd 不同（换了 worktree）⇒ 不接回' },
  { id: 'D28', what: 'resumePlan：按字面比 cwd（不取 realpath）',
    file: 'lib/tool-journal.js', test: T_RES, from: 'real(record.cwd) !== real(cwd)', to: 'record.cwd !== cwd',
    expect: '同一个目录经软链到达' },
  { id: 'D29', what: 'resumePlan：不校验 session_id 格式',
    file: 'lib/tool-journal.js', test: T_RES, from: "  if (typeof record.session_id !== 'string' || !UUID_RE.test(record.session_id)) {", to: '  if (false) {',
    expect: 'session_id 不是 UUID' },
  { id: 'D30', what: 'claudeCommand：resume 时丢掉 --append-system-prompt-file',
    file: 'bin/agent-start.js', test: T_RES, from: "    + ` --append-system-prompt-file ${JSON.stringify(personaFile)}`;", to: "    + (resumeId ? '' : ` --append-system-prompt-file ${JSON.stringify(personaFile)}`);",
    expect: '去掉 `--resume <id>` 之后跟全新会话那条逐字节相同' },
  { id: 'D31', what: 'defaultKick：resume 时还发原来那句',
    file: 'bin/agent-start.js', test: T_RES, from: '  return resumed\n', to: '  return false\n',
    expect: 'resume ⇒ 说明刚被重启' },
  { id: 'D32', what: 'agent-start：--resume 不生效（判据算了，结果没进命令）',
    file: 'bin/agent-start.js', test: T_LH, from: '    personaFile, resumeId,\n', to: '    personaFile, resumeId: null,\n',
    expect: '★ --resume ⇒ argv 里有 `--resume <记录的 id>`' },
  { id: 'D33', what: 'agent-start：cwd 不同时静默退回（不打警告）',
    file: 'bin/agent-start.js', test: T_LH, from: '    else console.warn(`  ⚠️  --resume 没接回：${plan.warn}`);', to: '',
    expect: 'cwd 不同 ⇒ 打警告' },
  { id: 'D34', what: 'agent-start：不带 --resume 也接回（不再是 opt-in）',
    file: 'bin/agent-start.js', test: T_LH, from: "  const wantResume = process.argv.includes('--resume');", to: '  const wantResume = true;',
    expect: '不带 --resume ⇒ 不接回' },
];

function runOne(m) {
  const env = { ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${HOOK}`.trim(),
    ENGLOOP_SRCMUT: JSON.stringify({ file: F(m.file), from: m.from, to: m.to }) };
  const r = spawnSync('node', [F(m.test)], { cwd: ROOT, env, encoding: 'utf8', timeout: 300000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const summary = /通过 \d+ · 失败 \d+/.exec(out);
  const red = out.split('\n').filter((l) => /^\s*✗/.test(l));
  const hit = red.some((l) => l.includes(m.expect));
  const verdict = !summary ? 'crashed' : hit ? 'killed' : 'survived';
  return { verdict, summary: summary ? summary[0] : `（无总结行，exit ${r.status}）`, red: red.length,
    first: (red.find((l) => l.includes(m.expect)) || red[0] || '').trim().slice(0, 140),
    tail: summary ? '' : out.slice(-300) };
}

const pick = process.argv.slice(2);
const list = pick.length ? MUTANTS.filter((m) => pick.includes(m.id)) : MUTANTS;
let killed = 0;
for (const m of list) {
  const r = runOne(m);
  if (r.verdict === 'killed') killed += 1;
  const icon = { killed: '✅', crashed: '⚠️', survived: '🔴' }[r.verdict];
  console.log(`${icon} ${m.id} ${r.verdict.padEnd(8)} ${m.what}  ⇒ ${m.test}`);
  console.log(`     ${r.summary} · 红 ${r.red} 条 · 指定那条：${r.first || '（没红）'}`);
  if (r.tail) console.log(`     ${r.tail.replace(/\n/g, '\n     ')}`);
}
console.log(`\n变异 ${list.length} 个 · 被指定判据杀掉 ${killed} 个`);
process.exit(killed === list.length ? 0 : 1);
