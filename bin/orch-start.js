#!/usr/bin/env node
'use strict';

/**
 * 起编排者 —— 一个跑在 tmux 里、永不退出的 interactive claude 会话。
 *
 * 最小启动任务：启动指令只说「进入你的循环」，
 * 不要夹带具体工作。夹带会让 agent 抢跑在计划前面。
 *
 * 用法:
 *   node bin/orch-start.js                起
 *   node bin/orch-start.js --peek         看它在干什么
 *   node bin/orch-start.js --stop         优雅停（等它把手上的活收尾）
 *   node bin/orch-start.js --stop --force 强杀（等于 kill -9）
 *   node bin/orch-start.js --nudge        卡住时推一把（发 ESC）
 *   node bin/orch-start.js --bypass-permissions   回滚：不带 sandbox 起（会警告）
 *
 * --stop 需要 bus 在跑：READY_TO_SHUTDOWN 是 agent 写的 outbox 文件，
 * 只有 bus 进程里的 relay 看得见它（见 lib/shutdown.js）。
 */

const path = require('node:path');
const tmux = require('../lib/tmux');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const shutdown = require('../lib/shutdown');
const { writeAgentSettings } = require('../lib/agent-settings');
const launch = require('../lib/agent-launch');

const ORCH_NAME = 'JARVIS';
// 会话名走 roster.sessionFor —— 约定的唯一出处。花名册自愈重建时要填出同一个
// 名字，这里另写一个 'orch' 字面量的话，两边分叉不会有任何东西变红。
const SESSION = roster.sessionFor(ORCH_NAME, 'orchestrator');
const ROOT = path.join(__dirname, '..');

const KICKSTART = '进入你的循环：现在运行 node bin/next.js（Bash timeout 设 600000），处理拿到的消息，然后立刻再次运行它。';

async function start() {
  if (!tmux.available()) {
    console.error('✗ 没装 tmux');
    process.exit(1);
  }
  if (await tmux.exists(SESSION)) {
    console.error(`✗ 会话 ${SESSION} 已在运行。--peek 查看，--stop 停止。`);
    process.exit(1);
  }

  // 编排者也要登记花名册 —— 否则 agent 写 {"username":"JARVIS"} 时，
  // relay 查不到它，会当成「发给人」推去 WebSocket，编排者永远收不到。
  // 它的收件流是 orch:in:agent（优先级低于 orch:in:human）。
  const redis = q.createClient();
  // 收件流同样走 roster.inboxFor —— 唯一出处。编排者是这条约定里唯一的例外
  // （orch:in:agent 而不是 agent:JARVIS:in），例外写在两个地方就是等着分叉。
  const inbox = roster.inboxFor(ORCH_NAME, 'orchestrator');
  await roster.register(redis, ORCH_NAME, {
    type: 'orchestrator', cwd: ROOT, tmux_session: SESSION, stream: inbox,
  }, 86400);   // 编排者常驻，给长 TTL；agent 靠 90s 心跳
  await q.ensureGroup(redis, inbox, roster.groupFor(ORCH_NAME, 'orchestrator'));
  await redis.quit();
  console.log(`✓ 编排者已登记花名册（${ORCH_NAME} → ${inbox}）`);

  // ── 权限 ──────────────────────────────────────────────────────────────
  //   不用 `--dangerously-skip-permissions` 起：根目录那份 settings 里**没有 deny**（只有压缩补回 hook），
  //   跳过权限 ⇒ 编排者实际上什么约束都没有。
  //   跟 agent 同一个生成器（lib/agent-settings.js，kind 'orchestrator'）：dontAsk ＋ sandbox；
  //   写集 = 仓库根 ＋ 兄弟目录 worktrees；能读 admin token 和用户表；localhost ＋ tmux socket 放行。
  //   ⚠️ **不带** `--setting-sources user`：根 `.claude/settings.json` 的压缩补回 hook 要加载。
  //   `--bypass-permissions` 是回滚开关，跟 agent-start 同一个写法和警告。
  const bypass = process.argv.includes('--bypass-permissions');
  let permFlags;
  if (bypass) {
    permFlags = '--dangerously-skip-permissions';
    console.warn('⚠️  --bypass-permissions：编排者没有 sandbox、没有 deny，任何注入的指令都以完整权限执行');
  } else {
    const settingsFile = writeAgentSettings({ kind: 'orchestrator', name: ORCH_NAME, type: 'orchestrator', cwd: ROOT });
    permFlags = launch.shellJoin(launch.permissionArgs({ kind: 'orchestrator', settingsFile }));
    console.log(`✓ 权限: dontAsk + sandbox（${path.relative(ROOT, settingsFile)}）`);
  }
  // 模型从能力表取：orchestrator 那一格是 INHERIT ⇒ 不传。
  const modelFlags = launch.shellJoin(launch.modelArgs('orchestrator'));
  // `env -u …`：剥掉 Claude Code 的会话态变量 —— 从一个 Claude Code 会话里起编排者时，
  // tmux server 的环境带着那个会话的身份（清单在 lib/agent-launch.js）。
  const cmd = `${launch.envUnsetPrefix()} claude ${permFlags}${modelFlags ? ` ${modelFlags}` : ''} ${JSON.stringify(KICKSTART)}`;
  // 编排者的类型固定是 orchestrator（它不是 agent，没有 --type 参数）。
  // hooks/check_security.js 读不到这个变量会 fail-closed 拒掉一切工具调用。
  await tmux.spawn(SESSION, {
    cwd: ROOT,
    command: cmd,
    env: { ENGLOOP_AGENT_TYPE: 'orchestrator' },
  });
  console.log(`✓ 已起会话 ${SESSION}`);

  const r = await tmux.waitFor(SESSION, /shift\+tab|for shortcuts|esc to interrupt|❯/, 90000, 2000);
  if (r.ok) {
    console.log('✓ TUI 就绪，编排者应已进入循环');
    console.log(`  看它干活: tmux attach -t ${SESSION}   （Ctrl-b d 脱离）`);
  } else {
    console.log(`⚠ 90 秒内没等到 TUI 就绪（${r.reason}），--peek 看看`);
  }
}

async function main() {
  // `--bypass-permissions` 是 start 的修饰，不是子命令 ⇒ 不占 argv[2] 的位置
  const flag = process.argv.slice(2).find((a) => a !== '--bypass-permissions');

  if (flag === '--peek') {
    if (!(await tmux.exists(SESSION))) return console.log('会话未运行');
    console.log(await tmux.peek(SESSION, Number(process.argv[3]) || 50));
    return;
  }
  if (flag === '--stop') {
    // 默认优雅。编排者尤其不该被 kill -9 —— 它手上那条消息通常是人刚发的，
    // 强杀等于让人的话停在 PEL 里等 60 秒 autoclaim，而那时可能已经没有
    // 别的消费者了（编排者只有一个）。
    if (process.argv.includes('--force')) {
      const redis = q.createClient();
      await roster.unregister(redis, ORCH_NAME).catch(() => {});
      await redis.quit();
      console.log(await tmux.kill(SESSION)
        ? '✓ 已强杀（它手上未 ack 的消息留在 PEL，等下次编排者起来自己捞回）'
        : '会话本来就没跑');
      return;
    }
    try {
      const r = await shutdown.stopViaBus(ORCH_NAME, {
        reason: 'orch-start.js --stop',
        onLog: (m) => console.log(m),
      });
      console.log(`✓ 编排者已优雅关停（${r.mode}）`);
    } catch (e) {
      console.error(`✗ 优雅关停没走成：${e.message}`);
      if (e.code === 'BUS_UNREACHABLE') {
        console.error('  bus 没在跑，关停请求送不到。先起 bus（./bin/serve.sh），');
        console.error('  或明说强杀：node bin/orch-start.js --stop --force');
      }
      process.exit(1);
    }
    return;
  }
  if (flag === '--nudge') {
    if (!(await tmux.exists(SESSION))) return console.log('会话未运行');
    await tmux.nudge(SESSION, 'Escape');
    console.log('✓ 已发 ESC（1 秒内可打断阻塞中的工具调用）');
    return;
  }
  await start();
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
