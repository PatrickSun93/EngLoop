#!/usr/bin/env node
'use strict';

/**
 * 暂停 / 恢复一个常驻 agent 的循环（S1B R3）。
 *
 *   node bin/agent-pause.js <name>         放暂停标记：它下一次结束回合时 loop_guard 放行、停住；watchdog 不推它、不告警
 *   node bin/agent-pause.js <name> --off   撤掉标记（它不会自己醒 —— 要它回来，给它发条消息或用 watchdog / agent-start 的办法推一把）
 *   node bin/agent-pause.js --list         看谁在暂停
 *
 * ── 它是什么、不是什么 ─────────────────────────────────────────────────
 *   · 它是**机制**：标记在 `temp/loop-guard/<name>.paused`，crew 的 sandbox 写不到 ⇒ agent 不能自己给自己放暂停逃出循环。
 *     （编排者没有 sandbox，它的 Bash 写得到 —— 见 lib/loop-guard.js 头注。）
 *   · 它**不打断**正在跑的回合：agent 手上的活照做完，到回合结束那一刻才停。要立刻停，那是 agent-start --stop 的事。
 *   · 「人说停就停」（根 CLAUDE.md 第三条纪律、protocols/poll_rules.md §5）10-30 改成「停动作、不停 poller」，
 *     「彻底停」指向这个命令：由人在终端跑，agent 不给自己跑（否则只有终端能撤，手机上叫不醒）。
 *
 * 退出码：0 成功 · 2 用法错。
 */

const lg = require('../lib/loop-guard');

function usage(msg) {
  if (msg) console.error(`✗ ${msg}`);
  console.error('用法: node bin/agent-pause.js <name> [--off] | --list');
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const pos = args.filter((a) => !a.startsWith('--'));
  const unknown = flags.filter((f) => f !== '--off' && f !== '--list');
  if (unknown.length) usage(`不认识的参数 ${unknown.join(' ')}`);

  if (flags.includes('--list') || (!pos.length && !flags.length)) {
    if (pos.length || flags.includes('--off')) usage('--list 不带名字、不带 --off');
    const rows = lg.listPaused();
    if (!rows.length) { console.log('没有 agent 在暂停'); return; }
    for (const r of rows) console.log(`⏸  ${r.name}${r.at ? `（自 ${r.at}${r.by ? `，${r.by}` : ''}）` : ''}`);
    return;
  }
  if (pos.length !== 1) usage('一次只给一个名字');
  const name = pos[0];
  if (!lg.NAME_RE.test(name)) usage(`名字不合格 "${name}"（只许字母数字 _ -）`);

  if (flags.includes('--off')) {
    const removed = lg.clearPaused(name);
    console.log(removed ? `▶  ${name} 的暂停标记已撤掉。它不会自己醒 —— 要它回来，给它发条消息，或等 watchdog 的 15/20/30 分钟那套。`
      : `${name} 本来就没有暂停标记`);
    return;
  }
  const already = lg.isPaused(name);
  const file = lg.setPaused(name, { by: process.env.USER || null });
  console.log(`⏸  ${name} ${already ? '已经在暂停（标记时刻已刷新）' : '已暂停'}：${file}`);
  console.log('   它手上的回合照常做完；回合结束时 loop_guard 放行、它停住；watchdog 不推它、不告警。撤销：--off');
}

main();
