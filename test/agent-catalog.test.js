'use strict';

/**
 * 离线 agent 清单（`lib/agent-catalog.js`）+ 从界面开启（`lib/agent-ui-start.js`）。
 *
 * ── 这两个模块里最重的两条 ──────────────────────────────────────
 * ①  **「正在起」和「起失败了」必须分得开** —— 两者在花名册里都是
 *     「它不在」。分不开的话人会盯着一个永远不动的界面等下去。
 *     而且 `agent-start` **退出码 0 不等于它在册**（「改了 ≠ 生效了」）
 *     —— 所以以花名册为准，不以退出码为准。
 *
 * ②  **那个按钮花真钱**（一次点击 = 一个新的 claude 会话）。
 *     所以「已经在线了还给起一次」这种事必须被拒，
 *     而不是「顺便重启一下」。
 *
 * 单跑：`node test/agent-catalog.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const catalog = require('../lib/agent-catalog');
const launch = require('../lib/agent-ui-start');

// ── 造一个假的仓库根，不碰真 agents/ ────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-cat-'));
function mkCrew(name, firstLine) {
  const d = path.join(TMP, 'agents', name);
  fs.mkdirSync(d, { recursive: true });
  if (firstLine !== null) fs.writeFileSync(path.join(d, 'CLAUDE.md'), `${firstLine}\n\n正文`);
}
mkCrew('alpha', '# alpha — dev agent');
mkCrew('beta', '# beta — eval agent');
mkCrew('JARVIS', '# JARVIS — orchestrator agent');   // ① 编排者，必须排除
mkCrew('ghost', null);                              // ② 没有 CLAUDE.md
mkCrew('weird', '随便写的第一行');                  // 推不出 type
mkCrew('faketype', '# faketype — nosuchtype agent');  // 类型不在能力表里

console.log('\n【1】扫目录 —— 判据是「有模板」，不是「目录存在」');
{
  const list = catalog.scan(TMP);
  const names = list.map((c) => c.name);
  ok(names.includes('alpha') && names.includes('beta'), '有模板的进清单', JSON.stringify(names));
  ok(!names.includes('ghost'),
    '★★ 没有 CLAUDE.md 的目录不算 —— **目录 ≠ 意图**，'
    + '一个目录在、provision 却从没对它跑过的 agent 就是这种');
  ok(!names.includes('JARVIS'),
    '★★ 编排者自己排除 —— agent-start 明确拒绝起 orchestrator，'
    + '给它一个按钮等于给人准备一次必然的失败');
  ok(list.every((c) => c.source === 'agents-dir'),
    '★ 每条带来源标记 —— '
    + '人得知道自己在看一份扫出来的名单，不是谁声明的');
}

console.log('\n【2】★ type 推不出来时返回 null，绝不猜 dev');
{
  const byName = Object.fromEntries(catalog.scan(TMP).map((c) => [c.name, c]));
  ok(byName.alpha.type === 'dev' && byName.alpha.type_source === 'claude-md-heading',
    '首行合规 → 推出 dev，并说得出是从哪推的');
  ok(byName.beta.type === 'eval', '推出 eval');
  ok(byName.weird.type === null,
    '★★ 首行不合规 → null（**不猜 dev**）—— 起一个类型错的 agent，'
    + 'hook 会 fail-closed 拒掉它每一次工具调用，'
    + '而那个现场跟「hook 正常工作」长得一模一样');
  ok(byName.faketype.type === null,
    '★ 能力表不认识的类型也当推不出 —— 解析出来 ≠ 能用');
  ok(byName.weird.type_source === null, '推不出时来源也是 null，不留一个假出处');
}

console.log('\n【3】offline —— 候选减去在册的');
{
  const list = catalog.scan(TMP);
  const off = catalog.offline(list, [{ name: 'alpha' }]);
  ok(!off.some((c) => c.name === 'alpha'), 'alpha 在册 → 不算离线');
  ok(off.some((c) => c.name === 'beta'), 'beta 不在册 → 算离线');
  ok(catalog.offline(list, []).length === list.length, '花名册为空 → 全部离线');
  ok(catalog.offline([], [{ name: 'x' }]).length === 0, '没有候选 → 空');
}

console.log('\n【4】★★ start 的三道拒绝 —— 每一道都花钱，所以都要挡住');
{
  launch.clear();
  const candidates = catalog.scan(TMP);
  const spawnFn = () => ({ stderr: null, stdout: null, on: () => {}, kill: () => {} });

  const r1 = launch.start('nosuch', { candidates, registry: [], spawnFn });
  ok(!r1.ok && r1.code === 'UNKNOWN_CREW', '① 不在候选清单里 → 拒');

  const r2 = launch.start('alpha', { candidates, registry: [{ name: 'alpha' }], spawnFn });
  ok(!r2.ok && r2.code === 'ALREADY_ONLINE',
    '★★ ② 已经在册 → 拒，**不「顺便重启一下」** —— '
    + '重启和开启花的额度一样，但只有一个是他点它时想要的');

  const r3 = launch.start('weird', { candidates, registry: [], spawnFn });
  ok(!r3.ok && r3.code === 'TYPE_UNKNOWN', '★ ③ 类型推不出 → 拒（不默认 dev）');
  ok(/不默认成 dev/.test(r3.message), '★ 而且说得出为什么不默认', r3.message);

  const r4 = launch.start('alpha', { candidates, registry: [], spawnFn });
  ok(r4.ok && r4.type === 'dev', '合法请求 → 受理');
  const r5 = launch.start('alpha', { candidates, registry: [], spawnFn });
  ok(!r5.ok && r5.code === 'ALREADY_STARTING', '★ 正在起的不重复起（连点两下不会花两次钱）');
  launch.clear();
}

console.log('\n【5】★★★ 退出码 0 ≠ 它在册 —— 这是本文件最重的一条');
{
  launch.clear();
  const candidates = catalog.scan(TMP);
  const handlers = {};
  const spawnFn = () => ({
    stderr: { on: () => {} }, stdout: { on: () => {} },
    on: (ev, fn) => { handlers[ev] = fn; }, kill: () => {},
  });
  launch.start('alpha', { candidates, registry: [], spawnFn });
  ok(launch.snapshot().alpha.status === 'starting', '受理后是 starting');

  handlers.exit(0);   // agent-start 成功退出
  ok(launch.snapshot().alpha.status === 'spawned',
    '★ 退出码 0 → 标 spawned，**不是「成功了」** —— 它只说明命令跑完了');

  // 花名册里还是没有它 —— 这正是最隐蔽的那种失败。
  const snap = launch.settleAgainstRoster([]);
  ok(snap.alpha.status === 'not_in_roster',
    '★★★ 进程正常退出、花名册里却没有 → 单独一种状态');
  ok(/tmux attach/.test(snap.alpha.error || ''),
    '★ 而且给出下一步动作（去看那个会话），不只是报告一个状态', snap.alpha.error);

  // 阴性对照：真在册了 → 记录消失（界面自然会把它显示成在线的）
  launch.clear();
  launch.start('beta', { candidates, registry: [], spawnFn });
  handlers.exit(0);
  const snap2 = launch.settleAgainstRoster([{ name: 'beta' }]);
  ok(!snap2.beta, '★ 阴性对照：真上线了 → 记录清掉，不留一条假的「正在起」');
  launch.clear();
}

console.log('\n【6】spawn 失败要带得出原因');
{
  launch.clear();
  const candidates = catalog.scan(TMP);
  const handlers = {};
  let stderrCb;
  const spawnFn = () => ({
    stderr: { on: (_e, fn) => { stderrCb = fn; } }, stdout: { on: () => {} },
    on: (ev, fn) => { handlers[ev] = fn; }, kill: () => {},
  });
  launch.start('alpha', { candidates, registry: [], spawnFn });
  stderrCb('✗ 不认识的 agent 类型 "xxx"');
  handlers.exit(1);
  const s = launch.snapshot().alpha;
  ok(s.status === 'spawn_failed', '非零退出 → spawn_failed');
  ok(/退出码 1/.test(s.error) && /不认识的 agent 类型/.test(s.error),
    '★★ 错误里带上 stderr —— 只说「起失败了」的话，'
    + '人得自己去终端重跑一遍才知道为什么', s.error);
  launch.clear();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
