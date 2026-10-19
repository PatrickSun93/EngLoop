'use strict';

/**
 * 改名迁移的**源码级内存变异**：迁移脚本和闸各改掉一行，要求**指定的那条**判据变红。
 * 一个字节都不落盘（`scripts/_srcmut-hook.js`，NODE_OPTIONS 带进 CLI 子进程）。
 *
 * 判档跟 `scripts/mutate-thread-count.js` 一样：
 *   ✅ killed     指定的那条（label 子串）出现在 `✗` 行里，且跑到了总结行
 *   ⚠️ crashed    没有总结行（进程崩了 / 超时）—— **不算 killed**
 *   🔴 survived   跑完了，而指定的那条仍是 `✓`
 *
 * 用法：node scripts/mutate-agent-names.js          全部（~1 分钟）
 *       node scripts/mutate-agent-names.js G1 G4    只跑这几个
 * 不进 run-all。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(__dirname, '_srcmut-hook.js');
const F = (p) => path.join(ROOT, p);
const MIG = 'scripts/migrate-agent-names.js';
const T = 'test/agent-names-migration.test.js';
const GATE = 'test/no-legacy-names.test.js';

const MUTANTS = [
  { id: 'G1', what: '演练也真做（`--apply` 不看了）',
    file: MIG, from: '  if (!apply) {', to: '  if (false) {',
    test: T, expect: '【1】★ 演练前后现场逐字节相同' },
  { id: 'G2', what: '新组从 0 建（不按旧组的 last-delivered-id）',
    file: MIG, from: "const args = ['CREATE', stream, g.to, g.lastId];", to: "const args = ['CREATE', stream, g.to, '0'];",
    test: T, expect: '【2】★★ 新组 agent:dev 的 last-delivered-id 等于旧组的' },
  { id: 'G3', what: '花名册改值时丢了 TTL',
    file: MIG, from: "if (r.pttl > 0) await redis.set(r.key, r.after, 'PX', r.pttl);", to: 'if (false) {}',
    test: T, expect: '【2】★ 花名册的 TTL 还在' },
  { id: 'G4', what: 'history 不改流名',
    file: MIG, from: '      o.stream = to;', to: '',
    test: T, expect: '【2】★ history 里的 stream / kind 换成新流名' },
  { id: 'G5', what: '任务图节点的 kind 不改',
    file: MIG, from: 'if (n && n.kind === OLD) P.graphNodes.push(', to: 'if (false) P.graphNodes.push(',
    test: T, expect: '【2】任务图节点 kind → crew' },
  { id: 'G6', what: '「没什么可做」永远不成立（不幂等）',
    file: MIG, from: 'function nothingToDo(P) {\n  return ', to: 'function nothingToDo(P) {\n  return false && ',
    test: T, expect: '【3】★ 第二次：「没什么可做」、退出码 0' },
  { id: 'G7', what: 'PEL 不为空也放行',
    file: MIG, from: "if (g.pending > 0) refuse('PEL 不为空', `${key}", to: "if (false) refuse('PEL 不为空', `${key}",
    test: T, expect: '【4】★ 拒绝，并说出是哪个流、几条' },
  { id: 'G8', what: '不认识的族不拒绝（跳过、接着做别的）',
    file: MIG, from: "      refuse('不认识的族',", to: "      if (0) refuse('不认识的族',",
    test: T, expect: '【5】★★ 不认识的族时什么都没改' },
  { id: 'G9', what: '目录冲突时覆盖目标',
    file: MIG, from: "      else refuse('目录冲突',", to: '      else P.dirMoves.push({ from, to }); if (0) refuse(\'目录冲突\',',
    test: T, expect: '【6】★★ 目标没被覆盖、什么都没改' },
  { id: 'G10', what: '项目目录目标已存在也不拒',
    file: MIG, from: "if (fs.existsSync(to)) refuse('项目目录冲突',", to: "if (false) refuse('项目目录冲突',",
    test: T, expect: '【6】项目目录目标已存在 ⇒ 拒绝' },
  { id: 'G11', what: '目标流已存在也不拒（RENAMENX 之前不查）',
    file: MIG, from: '    if (await redis.exists(to)) {', to: '    if (false) {',
    test: T, expect: '【7】目标流已存在 ⇒ 拒绝' },
  { id: 'G12', what: '不看旧名字的 tmux 会话',
    file: MIG, from: "if (mapSession(s)) refuse('会话还活着',", to: "if (false) refuse('会话还活着',",
    test: T, expect: '【7】旧名字的 tmux 会话还活着 ⇒ 拒绝' },
  { id: 'G13', what: '不收拾新流上残留的旧组（中途崩了再跑接不上）',
    file: MIG, from: '      P.groupFixes.push({ stream: s, ...g, from: g.name, to: gto });', to: '',
    test: T, expect: '【8】★ 新流上残留的旧组被换成 agent:dev' },
  { id: 'L1', what: '闸的正则拼错（永远命中不了）',
    file: GATE, from: "const OLD = ['p', 'u', 'p'].join('');", to: "const OLD = ['z', 'z', 'z'].join('');",
    test: GATE, expect: '阳性对照：判据对大写、复数、驼峰都会命中' },
  { id: 'L2', what: '闸把 lib/ 也当成例外（例外清单吞了代码目录）',
    file: GATE, from: "const EXCLUDE_DIR_RE = /^(docs|vendor|experiments)\\//;", to: "const EXCLUDE_DIR_RE = /^(docs|vendor|experiments|lib)\\//;",
    test: GATE, expect: '阳性对照：lib/ 和 agents/<name>/CLAUDE.md 不在例外里' },
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
