'use strict';

/**
 * 【4a】第①步：`ENGLOOP_AGENT_TYPE` 注入。
 *
 * ── 这个文件守的是什么 ──────────────────────────────────────────
 * `hooks/check_security.js` 靠这个变量知道对面是谁，**读不到就 fail-closed
 * 拒掉一切工具调用**。所以注入这条线断了，后果不是「少了个变量」，是
 * **那个 agent 一个工具都用不了，而且它自己只会看到一连串 REJECT**。
 *
 * 更阴的是 worker 那条：不显式传的话它**继承 bus 进程的环境**，而 bus 是
 * orchestrator —— 于是一个 eval worker 会被当成 orchestrator，**拿到它不该
 * 有的 Bash**。那是「检测失败当 dev」同一类陷阱翻转过来的样子：
 * **继承一个错的身份，比读不到身份更危险** —— 后者 fail-closed，前者一路绿灯。
 *
 * ★ 所以这里的断言全都盯着「**变量真的到了那个进程里吗**」，
 *   而不是「函数被调用时带了那个参数吗」。
 * ────────────────────────────────────────────────────────────────
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tmux = require('../lib/tmux');
const { runPrint } = require('../lib/worker-runner');
const { startPool } = require('../lib/worker-pool');
const q = require('../lib/queue');

const ROOT = path.join(__dirname, '..');
const VAR = 'ENGLOOP_AGENT_TYPE';

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-inject-'));

/** 一个假的 claude：只把它看到的环境变量打出来。 */
function fakeClaude() {
  const p = path.join(TMP, 'fake-claude.js');
  fs.writeFileSync(p, `#!/usr/bin/env node\nprocess.stdout.write('SAW=' + (process.env.${VAR} || '<未设置>'));\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

async function main() {
  console.log('\n【1】★ worker（print 模式）：变量真的进了子进程');
  // 用假 claude 把它实际看到的环境打出来 —— 这才是「到了那个进程里」的证据，
  // 而不是「传了参数」
  const bin = fakeClaude();
  const r1 = await runPrint({ text: 'x', type: 'eval' }, {
    cwd: TMP, timeoutMs: 10_000, agentType: 'eval',
    // runPrint 通过 ENGLOOP_CLAUDE_BIN 找可执行文件
    ...(process.env.ENGLOOP_CLAUDE_BIN = bin, {}),
  });
  ok(r1.ok === true, '假 claude 跑起来了', JSON.stringify(r1).slice(0, 200));
  ok(r1.output === 'SAW=eval', `★ 子进程看到 ${VAR}=eval（实际: ${r1.output}）`);

  console.log('\n【2】★ 不传 agentType 时，worker 会继承 bus 的身份 —— 这正是要防的');
  // 模拟 bus 进程是 orchestrator 的情形
  const savedType = process.env[VAR];
  process.env[VAR] = 'orchestrator';
  const r2 = await runPrint({ text: 'x', type: 'eval' }, { cwd: TMP, timeoutMs: 10_000 });
  ok(r2.output === 'SAW=orchestrator',
    '★ 不传就继承 bus 的 orchestrator —— eval worker 会被当成编排者拿到 Bash');
  const r3 = await runPrint({ text: 'x', type: 'eval' }, { cwd: TMP, timeoutMs: 10_000, agentType: 'eval' });
  ok(r3.output === 'SAW=eval', '★ 传了就覆盖掉继承来的身份（这条是修复的核心）');
  if (savedType === undefined) delete process.env[VAR]; else process.env[VAR] = savedType;

  console.log('\n【3】worker-pool 把池的 type 传下去');
  // ⚠️ 必须用真类型，不能编一个（比如 'injecttest'）：`startPool`
  //   「算不出工具白名单就拒绝启动」，编出来的类型会被它拒掉。
  //   这一节验的是「agentType 透传」，跟具体是哪个类型无关，所以用真类型即可。
  let sawOpts = null;
  const redis = q.createClient();
  const STREAM = 'work:solve';
  await redis.del(STREAM, 'orch:in:agent');
  await q.ensureGroup(redis, STREAM, 'work:solve');
  const pool = startPool(redis, {
    type: 'solve', concurrency: 1, onLog: () => {},
    runner: async (task, opts) => { sawOpts = opts; return { ok: true, ms: 1, output: 'done' }; },
  });
  await q.send(redis, STREAM, { from: 'test', text: 'hi', agent_type: 'solve' });
  for (let i = 0; i < 40 && !sawOpts; i++) await wait(100);
  pool.stop();
  ok(sawOpts && sawOpts.agentType === 'solve',
    `★ runner 收到 agentType=池的 type（实际: ${sawOpts && sawOpts.agentType}）`);
  await redis.del(STREAM, 'orch:in:agent');
  await redis.quit();

  console.log('\n【4】★ tmux 会话：变量进了会话环境（resident 那条路）');
  // 真起一个会话验，因为要证明的是「tmux -e 真的把变量放进了会话环境」，
  // 而不是「参数拼对了」。跑完立刻杀掉。
  const session = `solve_${process.pid}`;
  let sessionEnv = '';
  try {
    await tmux.spawn(session, { cwd: TMP, command: 'sleep 30', env: { [VAR]: 'dev' } });
    const r = spawnSync('tmux', ['show-environment', '-t', session, VAR], { encoding: 'utf8' });
    sessionEnv = (r.stdout || '').trim();
  } finally {
    await tmux.kill(session).catch(() => {});
  }
  ok(sessionEnv === `${VAR}=dev`, `★ 会话环境里有 ${VAR}=dev（实际: ${sessionEnv || '空'}）`);
  ok(!(await tmux.exists(session)), '测试会话已清理');

  console.log('\n【5】★ 在注入点校验类型 —— 不认识就拒绝启动，而不是等 hook 拒');
  // 注入一个能力表不认识的字符串，hook 会拒掉这个 agent 的每一次工具调用，
  // 而故障现场跟「hook 正常工作」一样。所以要在这里失败，信息才完整。
  const bad = spawnSync('node', [path.join(ROOT, 'bin', 'agent-start.js'),
    '--name', 'solve', '--type', 'no-such-type'], { encoding: 'utf8', cwd: ROOT });
  ok(bad.status === 1, '未知类型 → 退出码 1（没去起会话）');
  ok(/不认识的 agent 类型/.test(bad.stderr), '错误信息说清是类型名的问题');
  ok(/orchestrator/.test(bad.stderr) && /eval/.test(bad.stderr),
    '★ 列出了可选类型 —— 打错名字的人立刻就能改对');

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
