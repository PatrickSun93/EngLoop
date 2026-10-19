'use strict';

/**
 * agy 后端的**源码级内存变异**：把关键的一行在内存里改掉，要求 `test/agy-backend.test.js`
 * 里**指定的那条**判据变红。一个字节都不落盘（`scripts/_srcmut-hook.js`）。判档同 `scripts/mutate-launch.js`：
 *   ✅ killed   指定的那条出现在 `✗` 行里，且跑到了总结行
 *   ⚠️ crashed  没有总结行 —— 不算 killed
 *   🔴 survived 跑完了，指定的那条仍是 `✓`
 *
 * 不覆盖其他后端相关的变异（比如钥匙漏到别的 backend）。
 * 用法：node scripts/mutate-agy.js [A1 A5 …]   不进 run-all。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(__dirname, '_srcmut-hook.js');
const F = (p) => path.join(ROOT, p);
const T = 'test/agy-backend.test.js';

const MUTANTS = [
  { id: 'A1', what: '能力表：backends 没写时默认成全放',
    file: 'lib/agent-capabilities.js', from: '  if (!Array.isArray(b) || !b.length) {', to: '  if (!Array.isArray(b) || !b.length) return BACKENDS.slice();\n  if (false) {',
    expect: '某一格没写 backends ⇒ 抛' },
  { id: 'A2', what: 'worker-pool：去掉 linked worktree 闸',
    file: 'lib/worker-pool.js', from: "    if (backend !== 'claude') {\n      const wt = msg.cwd", to: "    if (false) {\n      const wt = msg.cwd",
    expect: 'cwd 是主工作树 ⇒ 池拒' },
  { id: 'A3', what: 'agy-backend：linkedWorktree 把主工作树也当 linked',
    file: 'lib/agy-backend.js', from: '  if (path.resolve(gitDir) === path.resolve(common)) {', to: '  if (false) {',
    expect: '主工作树 ⇒ 拒' },
  { id: 'A4', what: 'runAgy：不包 sandbox-exec（直接起 agy）',
    file: 'lib/agy-backend.js', from: '  const argv = sandbox.wrap(profileFile, [', to: '  const argv = (profileFile, [',
    expect: 'agy 真被包进了那份 profile' },
  { id: 'A5', what: 'runAgy：去掉 --project',
    file: 'lib/agy-backend.js', from: "      '--project', agy.projectId,\n", to: '',
    expect: '--project <专用 project>' },
  { id: 'A6', what: 'runAgy：HOME 回落成真 HOME',
    file: 'lib/agy-backend.js', from: '  const env = { HOME: agy.home,', to: '  const env = { HOME: os.homedir(),',
    expect: 'HOME = 专用 HOME' },
  { id: 'A7', what: 'profile：写集丢掉 git 元数据',
    file: 'lib/agy-backend.js', from: "      path.join(wt.common, 'objects'),\n      path.join(wt.common, 'worktrees', wt.name),\n", to: '',
    expect: '写集：这棵 worktree 的 git 元数据四项' },
  { id: 'A8', what: 'sandbox-profile：不传 network 也放开出站',
    file: 'lib/sandbox-profile.js', from: "...(network === 'open' ? [", to: '...(true ? [',
    expect: '不传 network ⇒ 不放开出站' },
  { id: 'A9', what: 'runAgy：不看 stderr 的 print timeout',
    file: 'lib/agy-backend.js', from: "  if (/print timeout/i.test(err)) return", to: '  if (false) return',
    expect: 'stderr 有 print timeout ⇒ 失败' },
  { id: 'A10', what: 'runAgy：SUCCESS 就算成功（不看 response 空）',
    file: 'lib/agy-backend.js', from: '  if (!response) return', to: '  if (false) return',
    expect: 'SUCCESS 但 response 空' },
  { id: 'A11', what: 'profile：拒读里少了 Keychains（push 绕过 wt-merge 的唯一一层）',
    file: 'lib/agy-backend.js', from: "  return ['Library/Keychains', '.ssh',", to: "  return ['.ssh',",
    expect: '推送凭据整棵拒读' },
  { id: 'A12', what: 'runAgy：sandbox 起不来也照起',
    file: 'lib/agy-backend.js', from: '    if (!sandbox.available()) {', to: '    if (false) {',
    expect: 'sandbox 起不来 ⇒ sandbox_unavailable' },
  { id: 'A13', what: 'runAgy：env 透传 bus 的 process.env',
    file: 'lib/agy-backend.js', from: "  const env = { HOME: agy.home, TMPDIR: tmpdir, PATH: process.env.PATH || '/usr/bin:/bin' };",
    to: '  const env = { ...process.env, HOME: agy.home, TMPDIR: tmpdir };',
    expect: 'env 从零开始' },
  { id: 'A14', what: 'relay：不按能力表校验 backend',
    file: 'lib/relay.js', from: '    if (!allowed.includes(backend)) {', to: '    if (false) {',
    expect: 'write ＋ agy ⇒ bad_backend' },
  { id: 'A15', what: 'worker-pool：不按能力表校验 backend',
    file: 'lib/worker-pool.js', from: '    if (!allowedBackends.includes(backend)) {', to: '    if (false) {',
    expect: '不在 backends 里的后端 ⇒ 池再拒一次' },
  { id: 'A16', what: 'agent-settings：专用 HOME 不进 claude agent 的拒读',
    file: 'lib/agent-settings.js', from: "  const secretTrees = kind === 'orchestrator' ? [] : secretDirs();", to: '  const secretTrees = [];',
    expect: 'agent：Read 规则 ＋ sandbox denyRead 都有专用 HOME' },
  { id: 'A17', what: 'runAgy：cwd 里有 AGENTS.md 也照起',
    file: 'lib/agy-backend.js', from: '    if (ctx.length) {', to: '    if (false) {',
    expect: 'cwd 里有 AGENTS.md ⇒ 不起' },
  { id: 'A18', what: 'worker-pool：claude 路径的 runner 参数里也多一个 backend 键',
    file: 'lib/worker-pool.js', from: "...(backend === 'claude' ? {} : { backend })", to: '...{ backend }',
    expect: '不带 backend ⇒ 传给 runner 的参数跟以前一样' },
  { id: 'A19', what: 'runAgy：显式给的 agy 路径不在时往下找（Mac 上会找到真 agy）',
    file: 'lib/agy-backend.js', from: '  if (explicit) return fs.existsSync(explicit) ? explicit : null;', to: '  if (explicit && fs.existsSync(explicit)) return explicit;',
    expect: '显式给的路径不在 ⇒ null' },
  { id: 'A20', what: 'agy-backend：不看「terminating N background task(s)」（后台任务被杀判成成功）',
    file: 'lib/agy-backend.js', from: '  if (bgKilled) {', to: '  if (false) {',
    expect: '后台任务被杀' },
  { id: 'A21', what: 'profile：拒读里少了 Patrick 自己的 ~/.gemini',
    file: 'lib/agy-backend.js', from: ", '.netrc', '.gemini'].map(", to: ", '.netrc'].map(",
    expect: 'Patrick 自己的 ~/.gemini' },
  { id: 'A22', what: 'agy-config：专用 HOME 退回成 dirname(ROOT)（从 linked worktree 跑时推错）',
    file: 'lib/agy-config.js', from: 'const agyHomeFor = (root) => path.join(path.dirname(mainWorktree(root)),', to: 'const agyHomeFor = (root) => path.join(path.dirname(path.resolve(root)),',
    expect: '从 linked worktree 推出来的专用 HOME' },
  { id: 'A23', what: 'agy-config：.git 文件里没有 gitdir: 行时回退成 ROOT（fail-open）',
    file: 'lib/agy-config.js', from: '  if (!m) throw new Error(', to: '  if (!m) return path.resolve(root);\n  if (false) throw new Error(',
    expect: '推不出 common dir ⇒ 抛' },
  { id: 'A24', what: 'agy-config：commondir 读不出时回退成 ROOT（fail-open）',
    file: 'lib/agy-config.js', from: ' } catch (e) {\n    throw new Error(`agy-config：读不出', to: ' } catch (e) {\n    return path.resolve(root);\n    throw new Error(`agy-config：读不出',
    expect: '推不出 common dir ⇒ 抛' },
];

function runOne(m) {
  const env = { ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${HOOK}`.trim(),
    ENGLOOP_SRCMUT: JSON.stringify({ file: F(m.file), from: m.from, to: m.to }) };
  const r = spawnSync('node', [F(T)], { cwd: ROOT, env, encoding: 'utf8', timeout: 300000 });
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
  console.log(`${icon} ${m.id} ${r.verdict.padEnd(8)} ${m.what}`);
  console.log(`     ${r.summary} · 红 ${r.red} 条 · 指定那条：${r.first || '（没红）'}`);
  if (r.tail) console.log(`     ${r.tail.replace(/\n/g, '\n     ')}`);
}
console.log(`\n变异 ${list.length} 个 · 被指定判据杀掉 ${killed} 个`);
process.exit(killed === list.length ? 0 : 1);
