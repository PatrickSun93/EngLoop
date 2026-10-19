'use strict';

/**
 * **代码里不再出现旧的那个概念名**（它只是概念，不出现在代码里任何位置）。
 *
 * 旧名字是三个字母，现在一律叫 agent（常驻、受编排者管理的那一类在代码标识符里用限定词 `crew`）。
 * 这个文件自己也不能含那三个字母 —— 否则它第一个就被自己抓到 ⇒ 下面的正则是**拼出来的**。
 *
 * 判据就是这两条命令，原样跑，**输出必须为空**：
 *   ① `git grep -niE <旧名> -- . <例外>`              内容
 *   ② `git ls-files | grep -iE <旧名>`（去掉例外目录）    文件名 / 目录名
 *
 * 例外只有这几个路径：
 *   docs/（不是代码）· vendor/（v1 存档，原样保留）· experiments/ · HANDOFF.md（内部记录）
 *   · agents/<name>/SESSION*（agent 自己写的会话笔记，是叙事不是代码）
 * ⚠️ **各 agent 实例自己的 `CLAUDE.md` 不在例外里** —— 那是运行时提示，里面有流名、路径、首行格式。
 *
 * ⚠️ 射程：只看**被 git 跟踪**的文件。没跟踪的（temp/、history/、各 agent 目录里没进 git 的东西）
 *   由 `scripts/migrate-agent-names.js` 负责，不归这条。
 *
 * 单跑：`node test/no-legacy-names.test.js`
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

// ★ 拼出来，不写字面量（见文件头）
const OLD = ['p', 'u', 'p'].join('');
const EXCLUDE_PATHSPEC = [':!docs', ':!vendor', ':!experiments', ':!HANDOFF.md', ':!agents/*/SESSION*'];
const EXCLUDE_DIR_RE = /^(docs|vendor|experiments)\//;

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

console.log('\n旧名字的闸\n');

// ── ① 内容 ─────────────────────────────────────────────────────────────
{
  const r = git(['grep', '-niE', OLD, '--', '.', ...EXCLUDE_PATHSPEC]);
  // git grep：0 = 有命中，1 = 没有命中，其它 = 出错。**出错不能当成「没有命中」**。
  ok(r.code === 0 || r.code === 1, '① git grep 跑成了（退出码 0 或 1，不是出错）', `code=${r.code} ${r.err.trim()}`);
  const lines = r.out.split('\n').filter(Boolean);
  ok(r.code === 1 && lines.length === 0,
    `① 内容里没有旧名字（${lines.length} 行命中）`,
    '\n    ' + lines.slice(0, 200).join('\n    ') + (lines.length > 200 ? `\n    …共 ${lines.length} 行` : ''));
}

// ── ② 文件名 / 目录名 ─────────────────────────────────────────────────
{
  const r = git(['ls-files']);
  ok(r.code === 0, '② git ls-files 跑成了', r.err.trim());
  const all = r.out.split('\n').filter(Boolean);
  const re = new RegExp(OLD, 'i');
  const hits = all.filter((f) => re.test(f) && !EXCLUDE_DIR_RE.test(f));
  ok(hits.length === 0, `② 被跟踪的文件路径里没有旧名字（${hits.length} 个命中）`,
    '\n    ' + hits.join('\n    '));
  // 阴性对照：ls-files 真的列出了东西（否则「0 个命中」恒真）
  ok(all.length > 100, `② 阴性对照：ls-files 列出了 ${all.length} 个文件（不是空列表）`);
}

// ── 阳性对照：同一套判据，喂一行带旧名字的文本必须命中 ──────────────────
//   ⚠️ 样本**不能**从 OLD 拼 —— 那样 OLD 拼错了样本跟着错，对照恒绿。
//     ⇒ 用字符码独立写一份。
{
  const upper = String.fromCharCode(0x50, 0x55, 0x50);
  const lower = String.fromCharCode(0x70, 0x75, 0x70);
  const sample = `const x = '${upper}'; // ${lower}s/dev · is${upper[0]}${lower.slice(1)}`;
  ok(new RegExp(OLD, 'i').test(sample) && sample.match(new RegExp(OLD, 'gi')).length === 3,
    '阳性对照：判据对大写、复数、驼峰都会命中（没有大小写 / 子串例外）');
  // 同一条 git grep 放到改名之前那个 commit（BEFORE）上 ⇒ 必须有命中
  const BEFORE = '6695671';
  const has = git(['cat-file', '-e', `${BEFORE}^{commit}`]).code === 0;
  if (has) {
    const r = git(['grep', '-ciE', OLD, BEFORE, '--', '.', ...EXCLUDE_PATHSPEC]);
    const n = r.out.split('\n').filter(Boolean).reduce((s, l) => s + Number(l.split(':').pop() || 0), 0);
    ok(r.code === 0 && n > 1000, `阳性对照：同一条命令在改名前的 ${BEFORE} 上命中 ${n} 行（> 1000）`);
  } else {
    console.log(`  ⚠ 这个克隆里没有 ${BEFORE} —— 跳过「改名前必须命中」那条对照（不是通过）`);
  }
  // 例外清单本身没有吞掉代码目录
  ok(!EXCLUDE_DIR_RE.test('lib/x.js') && !EXCLUDE_DIR_RE.test('agents/dev/CLAUDE.md'),
    '阳性对照：lib/ 和 agents/<name>/CLAUDE.md 不在例外里');
}

console.log(`\n  通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
