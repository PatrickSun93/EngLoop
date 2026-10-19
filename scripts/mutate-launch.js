'use strict';

/**
 * 启动卫生的**源码级内存变异**：把启动卫生的关键一行在内存里删掉 / 改掉，要求 `test/launch-hygiene.test.js`
 * 里**指定的那条**判据变红。一个字节都不落盘（`scripts/_srcmut-hook.js`）。判档同 `scripts/mutate-bus-auth.js`：
 *   ✅ killed   指定的那条出现在 `✗` 行里，且跑到了总结行
 *   ⚠️ crashed  没有总结行 —— 不算 killed
 *   🔴 survived 跑完了，指定的那条仍是 `✓`
 *
 * ★ 变异经 NODE_OPTIONS 跟进 agent-start / orch-start 子进程、私有 tmux server 里起的命令（假 claude 也是 node，
 *   它不 require 被变异的文件，钩子对它是空操作）。
 *
 * 用法：node scripts/mutate-launch.js            全部（每个 ~10 秒）
 *       node scripts/mutate-launch.js L3 L7      只跑这几个
 * 不进 run-all。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(__dirname, '_srcmut-hook.js');
const F = (p) => path.join(ROOT, p);
const T = 'test/launch-hygiene.test.js';

const MUTANTS = [
  // ── 权限 ──
  { id: 'L1', what: 'orch-start：按 agent 的方式拼权限（带 --setting-sources user ⇒ 根 .claude/settings.json 不加载）',
    file: 'bin/orch-start.js', from: "launch.permissionArgs({ kind: 'orchestrator', settingsFile })", to: "launch.permissionArgs({ kind: 'crew', settingsFile })",
    expect: '**不**带 --setting-sources' },
  { id: 'L2', what: 'worker-runner：tmux 路径回到 bypass',
    file: 'lib/worker-runner.js', from: 'const flags = [launch.shellJoin(la.args)];', to: "const flags = ['--dangerously-skip-permissions'];",
    expect: 'argv：没有 bypass；dontAsk' },
  { id: 'L3', what: 'agent-settings：编排者重新带上 sandbox',
    file: 'lib/agent-settings.js', from: "if (kind === 'orchestrator') return { permissions, sandbox: { enabled: false }, hooks };", to: '',
    expect: '编排者没有 sandbox：sandbox 段只有 enabled:false' },
  { id: 'L3b', what: 'agent-settings：编排者 allow 里没有 Bash（没有 sandbox 时什么命令都跑不了）',
    file: 'lib/agent-settings.js', from: "allow.push('Bash', `Edit(${abs(root)}/**)`", to: "allow.push(`Edit(${abs(root)}/**)`",
    expect: 'allow 显式有 Bash' },
  { id: 'L4', what: 'agent-settings：编排者也拒读钥匙（它就用不了 admin token 了）',
    file: 'lib/agent-settings.js', from: "const secretFiles = kind === 'orchestrator' ? [] : secretPaths(root);", to: 'const secretFiles = secretPaths(root);',
    expect: '钥匙**不**拒读' },
  { id: 'L5', what: 'worker-runner：print 路径不带 --settings',
    file: 'lib/worker-runner.js', from: '    args.push(...la.args);\n', to: '',
    expect: 'argv：dontAsk，没有 bypass' },
  // ── 模型 ──
  { id: 'L6', what: 'agent-start：模型不按自己的类型取（写死成别的类型那一格）',
    file: 'bin/agent-start.js', from: 'launch.modelArgs(type)', to: "launch.modelArgs('review')",
    expect: '--model opus（= 能力表 dev 那一格）' },
  { id: 'L7', what: 'agent-capabilities：缺 model 时静默退回「继承」',
    file: 'lib/agent-capabilities.js', from: "if (typeof caps.model !== 'string' || !caps.model) {", to: 'if (false) {',
    expect: '某一格没写 model ⇒ 抛' },
  // ── 环境变量 ──
  { id: 'L8', what: 'agent-start：命令不带 env -u 前缀',
    file: 'bin/agent-start.js', from: 'command: `${launch.envUnsetPrefix()} claude ', to: 'command: `claude ',
    expect: 'CLAUDECODE 没了（tmux server 里有）' },
  { id: 'L9', what: 'worker-runner：print 路径透传 process.env',
    file: 'lib/worker-runner.js', from: 'env: launch.stripSessionEnv(process.env, ', to: 'env: Object.assign({}, process.env, ',
    expect: 'CLAUDECODE / ENTRYPOINT 没了' },
  { id: 'L10', what: 'agent-launch：按前缀剥（连用户配置一起剥）',
    file: 'lib/agent-launch.js', from: 'for (const k of SESSION_ENV) delete out[k];', to: 'for (const k of Object.keys(out)) if (/^(CLAUDE|ANTHROPIC)/.test(k)) delete out[k];',
    expect: '用户配置（ANTHROPIC_API_KEY' },
  { id: 'L11', what: 'agent-launch：清单里漏了 CLAUDECODE',
    file: 'lib/agent-launch.js', from: "  'CLAUDECODE',\n", to: '',
    expect: 'tmux server 里的 CLAUDECODE / SSE_PORT 没传进来' },
  { id: 'L12', what: 'worker-runner：tmux 路径的提示词前面没有 `--`',
    file: 'lib/worker-runner.js', from: "${flags.join(' ')} -- ${launch.shellJoin([task.text])}", to: "${flags.join(' ')} ${launch.shellJoin([task.text])}",
    expect: '提示词在 `--` 之后' },
  // ── worktree / wt-merge ──
  { id: 'L13', what: 'wt-merge：不看 verify 结论是不是 pass',
    file: 'lib/agent-worktree.js', from: "if (v.verdict !== 'pass') {", to: 'if (false) {',
    expect: '记录是 fail ⇒ 拒' },
  { id: 'L14', what: 'wt-merge：不查交集改动',
    file: 'lib/agent-worktree.js', from: 'const overlap = dirty.filter((f) => incoming.has(f));', to: 'const overlap = [];',
    expect: '跟要合的文件有交集 ⇒ 拒' },
  { id: 'L15', what: 'wt-merge：不查调用者',
    file: 'lib/agent-worktree.js', from: "if (who && who !== 'orchestrator') {", to: 'if (false) {',
    expect: 'agent（ENGLOOP_AGENT_TYPE=dev）调用 ⇒ 拒' },
  { id: 'L16', what: 'wt-merge：fast-forward（不带 --no-ff）',
    file: 'lib/agent-worktree.js', from: "['merge', '--no-ff', '-m', msg, branch]", to: "['merge', '-m', msg, branch]",
    expect: '--no-ff：合并 commit 两个父' },
  { id: 'L17', what: 'agent-worktree：已存在的 worktree 也去算落后数时当成 0',
    file: 'lib/agent-worktree.js', from: "      behind: behind.ok ? Number(behind.out) : null };\n  }", to: '      behind: 0 };\n  }',
    expect: '落后 main ⇒ 报出落后几个 commit' },
  { id: 'L19', what: 'agent-settings：linked worktree 里的 agent 不抠主仓库的 main（能 update-ref 绕过 wt-merge）',
    file: 'lib/agent-settings.js', from: 'const denyWrite = [...qa, ...mainRefGuard(cwd)];', to: 'const denyWrite = [...qa];',
    expect: 'agent 配置的 sandbox denyWrite 里带着它' },
  { id: 'L20', what: 'agent-settings：mainRefGuard 连不存在的 loose 本体也 deny',
    file: 'lib/agent-settings.js', from: '  if (exists(loose)) out.push(loose);', to: '  out.push(loose);',
    expect: '不存在的 loose 本体**不** deny' },
  { id: 'L21', what: 'agent-settings：main 是 loose 时也 deny packed-refs.lock（agent 删不了任何分支）',
    file: 'lib/agent-settings.js', from: '  if (!exists(loose) && inPacked) out.push(packed, `${packed}.lock`);', to: '  out.push(`${packed}.lock`);',
    expect: '**不碰** packed-refs / packed-refs.lock' },
  { id: 'L22', what: 'agent-settings：main 只在 packed-refs 里时不 deny packed-refs',
    file: 'lib/agent-settings.js', from: '  if (!exists(loose) && inPacked) out.push(packed, `${packed}.lock`);', to: '',
    expect: 'packed：deny packed-refs 本体' },
  { id: 'L23', what: 'wt-merge：不看 pass 是不是全量',
    file: 'lib/agent-worktree.js', from: 'if (!full && !allowPartial) {', to: 'if (false) {',
    expect: 'tests 是 --only（agent 自己选的范围）⇒ 拒 verify_partial' },
  { id: 'L24', what: 'verify-complete：isFullSuite 认带参数的 run-all',
    file: 'lib/verify-complete.js', from: '!p.error && p.argv.length === 2 && ', to: '!p.error && ',
    expect: 'tests 是 --only（agent 自己选的范围）⇒ 拒 verify_partial' },
  { id: 'L25', what: 'wt-merge：--allow-partial 不写进 commit message',
    file: 'lib/agent-worktree.js', from: "${full ? '' : '（不是全量，--allow-partial）'}", to: '',
    expect: '--allow-partial ⇒ 合并、打警告、commit message 写明' },
  { id: 'L18', what: 'verify-complete：结论不按 sha 落盘',
    file: 'lib/verify-complete.js', from: '  rep.sha = sha;', to: '',
    expect: '结论按那个 sha 落盘' },
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
