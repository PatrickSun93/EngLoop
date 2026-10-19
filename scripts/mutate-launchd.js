'use strict';

/**
 * launchd 起法（`bin/launchd.js` / `stop.sh` / `bin/serve.sh`）的变异：每条要求**指定的那条**判据变红。
 *   JS 文件：`scripts/_srcmut-hook.js` 在内存里改，一个字节都不落盘。
 *   shell 脚本：`ENGLOOP_SHMUT` ⇒ 测试把脚本的**副本**放进临时目录再改（仓库里的那份不动）。
 * 判档同 `scripts/mutate-launch.js`：
 *   ✅ killed   指定的那条出现在 `✗` 行里，且跑到了总结行
 *   ⚠️ crashed  没有总结行 —— 不算 killed
 *   🔴 survived 跑完了，指定的那条仍是 `✓`
 *
 * 用法：node scripts/mutate-launchd.js          全部
 *       node scripts/mutate-launchd.js D2 D3    只跑这几个
 * 不进 run-all。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(__dirname, '_srcmut-hook.js');
const F = (p) => path.join(ROOT, p);

const MUTANTS = [
  { id: 'D1', what: 'launchd.js：mode 改成「在册才算 launchd」',
    kind: 'js', file: 'bin/launchd.js',
    from: "return fs.existsSync(plistPath(opts)) ? 'launchd' : 'nohup';",
    to: "return (fs.existsSync(plistPath(opts)) && loaded(opts).loaded === true) ? 'launchd' : 'nohup';",
    test: 'test/launchd.test.js', expect: '★ 文件在、不在册' },
  { id: 'D2', what: 'stop.sh：label 写回字面量',
    kind: 'sh', file: 'stop.sh',
    from: 'LABEL=$(node bin/launchd.js label 2>/dev/null)', to: 'LABEL="com.patrick.engloop"',
    test: 'test/launchd.test.js', expect: '★ 在册 ⇒ stop.sh bootout 的是' },
  { id: 'D3', what: 'serve.sh：去掉 PATH',
    kind: 'sh', file: 'bin/serve.sh',
    from: 'export PATH="$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"', to: '',
    test: 'test/serve-sh-env.test.js', expect: '③ bus 的子进程 command -v claude' },
  { id: 'D4', what: 'launchd.js：install 去掉「bus 在跑就拒绝」',
    kind: 'js', file: 'bin/launchd.js',
    from: '  if (pids.length) {', to: '  if (false) {',
    test: 'test/launchd.test.js', expect: '★★ bus 在跑（不是 launchd 起的）⇒ install 拒绝' },
  // 取不到 label 时退回成 `exit 1`（bus 不停）
  { id: 'D5', what: 'stop.sh：取不到 label 就 exit 1（不往下停 bus）',
    kind: 'sh', file: 'stop.sh',
    from: '  STEP_FAIL=$((STEP_FAIL+1))   # 取不到 label：记一笔，照样往下停 bus', to: '  exit 1',
    test: 'test/launchd.test.js', expect: '★ 取不到 label ⇒ bus 那一步照样执行了' },
];

function runOne(m) {
  const env = { ...process.env };
  if (m.kind === 'js') {
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require=${HOOK}`.trim();
    env.ENGLOOP_SRCMUT = JSON.stringify({ file: F(m.file), from: m.from, to: m.to });
  } else {
    env.ENGLOOP_SHMUT = JSON.stringify({ file: m.file, from: m.from, to: m.to });
  }
  const r = spawnSync('node', [F(m.test)], { cwd: ROOT, env, encoding: 'utf8', timeout: 300000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const summary = [...out.matchAll(/通过 \d+ · 失败 \d+/g)].pop();
  const red = out.split('\n').filter((l) => /^\s*✗/.test(l));
  const hit = red.some((l) => l.includes(m.expect));
  const verdict = !summary ? 'crashed' : hit ? 'killed' : 'survived';
  return { verdict, summary: summary ? summary[0] : `（无总结行，exit ${r.status}）`, red: red.length,
    first: (red.find((l) => l.includes(m.expect)) || red[0] || '').trim().slice(0, 160),
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
  console.log(`     ${r.summary} · 红 ${r.red} 条 · 指定那条：${r.first || '（没红）'}`);
  if (r.tail) console.log(`     ${r.tail.replace(/\n/g, '\n     ')}`);
}
console.log(`\n变异 ${list.length} 个 · 被指定判据杀掉 ${killed} 个`);
process.exit(killed === list.length ? 0 : 1);
