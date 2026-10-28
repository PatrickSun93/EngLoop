'use strict';

/**
 * lib/agent-settings.js —— agent 的框架持有权限配置。
 *
 * 这里只守**生成出来的形状**。「sandbox 真的拦住了」这件事单元测试证明不了 ——
 * 那要用真的 `claude -p` 在 /private/tmp 之外的夹具上测（见模块头注）。
 * ⇒ 这份测试防的是「有人改坏了生成逻辑而没人发现」，不是「sandbox 是否生效」。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildCrewSettings, writeCrewSettings, isTrusted, trustRoot, TRUST_DIALOG, GIT_DENY,
} = require('../lib/agent-settings');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const ROOT = '/fake/engloop';
const CWD = '/fake/work/dev';

console.log('\n【1】dev：能写、能上网、能跑 Bash');
{
  const s = buildCrewSettings({ name: 'dev', type: 'dev', cwd: CWD, root: ROOT });
  const p = s.permissions;
  ok(p.defaultMode === 'dontAsk', 'defaultMode = dontAsk（会弹框的一律拒绝，不卡会话）');
  ok(s.sandbox.enabled === true && s.sandbox.allowUnsandboxedCommands === false,
    'sandbox 开着，且不许不带 sandbox 重试');
  ok(s.sandbox.failIfUnavailable === true, 'sandbox 起不来就拒绝启动');
  ok(p.allow.includes(`Edit(//fake/work/dev/**)`), '能写自己的 cwd（绝对路径写成 //abs）');
  ok(p.allow.includes(`Edit(//fake/engloop/temp/outbox/dev/**)`), '能写自己的 outbox');
  ok(!p.allow.some((r) => r === 'Edit' || r === 'Write' || r === 'Bash'),
    '没有不带路径的 Edit/Write/Bash allow —— 那会放行写别人的 outbox 和自己的配置', JSON.stringify(p.allow));
  ok(p.deny.includes('Edit(//fake/engloop/temp/agent-settings/**)'), '自己的启动配置写不到');
  ok(p.deny.includes('Edit(//fake/work/dev/.claude/**)'), 'cwd 的 .claude/ 写不到');
  ok(GIT_DENY.every((r) => p.deny.includes(r)), 'git 基线全在 deny 里');
  ok(p.allow.includes('WebFetch'), 'web 能力 ⇒ 放 WebFetch/WebSearch 工具（由 hook 的 url_policy 再管）');
  ok(s.sandbox.network.allowedDomains.length === 0, 'Bash 外网一律不放 —— 新依赖要人批（url_policy）');
  const w = s.sandbox.filesystem.allowWrite;
  ok(w.includes('/fake/engloop/temp/poll-dev.json') && !w.includes('/fake/engloop/temp'),
    'temp/ 按文件放行，不放整个目录（否则能写别人的 poll 文件）', JSON.stringify(w));
  ok(w.every((f) => !f.includes('agent-settings')), 'sandbox 写集里没有 agent-settings');
  ok(s.sandbox.network.allowLocalBinding === true, 'localhost 放行（Redis；阴性对照：去掉就 EPERM）');
  ok(/tmux-\d+\/default$/.test(s.sandbox.network.allowUnixSockets[0]), 'tmux socket 放行（阴性对照：去掉就 EPERM）');
  const cmd = s.hooks.PreToolUse[0].hooks[0].command;
  ok(cmd.includes('/fake/engloop/hooks/check_security.js') && !cmd.includes('{{'),
    'hook 用绝对路径，没有未填的占位符（agents/dev 那份就是 {{ENGLOOP}}）', cmd);
}

console.log('\n【2】能力表里不给的，配置里也不给');
{
  const s = buildCrewSettings({ name: 't1', type: 'test', cwd: CWD, root: ROOT });
  ok(s.permissions.deny.includes('Bash') === false, 'test 有 bash ⇒ 不 deny Bash');
  ok(s.permissions.deny.includes('Edit(//fake/work/dev/**)'), 'test 没有 write ⇒ cwd 写被 deny');
  ok(!s.permissions.allow.includes('WebFetch'), 'test 没有 web ⇒ 不放 web 工具');
  const e = buildCrewSettings({ name: 'e1', type: 'eval', cwd: CWD, root: ROOT });
  ok(e.permissions.deny.includes('Bash'), 'eval 没有 bash ⇒ deny Bash');
  let threw = false;
  try { buildCrewSettings({ name: 'x', type: 'nope', cwd: CWD, root: ROOT }); } catch { threw = true; }
  ok(threw, '不认识的类型 ⇒ 抛，不猜');
}

console.log('\n【3】落盘');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-agentsettings-'));
  const file = writeCrewSettings({ name: 'dev', type: 'dev', cwd: CWD, root });
  ok(file === path.join(root, 'temp', 'agent-settings', 'dev.json'), '写在 temp/agent-settings/<name>.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(j.permissions.defaultMode === 'dontAsk', '落盘的是合法 JSON，内容就是 build 的结果');
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\n【4】trust：按 git 根精确匹配，不看祖先');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-trust-'));
  const cj = path.join(dir, 'claude.json');
  fs.writeFileSync(cj, JSON.stringify({ projects: {
    '/v/work': { hasTrustDialogAccepted: true },
    '/v/work/EngLoop': { hasTrustDialogAccepted: true },
    '/v/work/seen-but-declined': { hasTrustDialogAccepted: false },
  } }));
  ok(isTrusted('x', { claudeJson: cj, root: '/v/work/EngLoop' }), '根被信任 ⇒ true');
  // 上级目录被信任，它下面一棵 worktree 照样弹框
  ok(!isTrusted('x', { claudeJson: cj, root: '/v/work/EngLoop-worktrees/dev1' }),
    '只有祖先被信任 ⇒ false（这种情况会弹 trust 框）');
  ok(!isTrusted('x', { claudeJson: cj, root: '/v/work/seen-but-declined' }), '记录在、但没点过 Yes ⇒ false');
  ok(!isTrusted('x', { claudeJson: path.join(dir, 'nope.json'), root: '/v/work/EngLoop' }),
    '~/.claude.json 读不到 ⇒ false（多拒一次有声，漏一次是卡死的 agent）');
  ok(trustRoot(path.join(__dirname, 'does', 'not', 'exist')) === path.resolve(__dirname, '..'),
    'cwd 还不存在 ⇒ 用最近的祖先问 git，拿到仓库根');
  ok(TRUST_DIALOG.test('Quick safety check: Is this a project you created or one you trust?')
    && TRUST_DIALOG.test('❯ No, exit\n   Yes, I trust this folder'), '认得出 2.1.295 的 trust 对话框原文');
  ok(!TRUST_DIALOG.test('❯ \n ⏵⏵ don\'t ask on (shift+tab to cycle)'), '正常就绪的 pane 不误判');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n【5】agent-start 不再默认 bypass');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'agent-start.js'), 'utf8');
  // 命令前面多了 `env -u …` 前缀（剥掉会话态环境变量）。拼法在 claudeCommand() 里（DUR1 S3 抽出来的，`return` 那一行）。
  const line = src.split('\n').find((l) => /return `\$\{launch\.envUnsetPrefix\(\)\} claude /.test(l));
  ok(line && !line.includes('--dangerously-skip-permissions') && line.includes('${permFlags}'),
    '启动命令走 permFlags，不写死 bypass', line && line.trim());
  ok(/includes\('--bypass-permissions'\)/.test(src), 'bypass 只能通过显式的 --bypass-permissions 拿到');
  // 参数在 lib/agent-launch.js 里 ⇒ 断言**生成出来的 argv**，不 grep 源码里的串。
  //   agent-start 那一行要真的调它（kind 'crew'）；它产出什么，下面直接调来看。
  const permLine = src.split('\n').find((l) => /^\s*permFlags = launch\.shellJoin\(launch\.permissionArgs\(\{ kind: 'crew'/.test(l)) || '';
  const pa = require('../lib/agent-launch').permissionArgs({ kind: 'crew', settingsFile: '/x.json' });
  ok(permLine && pa.join(' ').includes('--setting-sources user'),
    'cwd 的 .claude/settings.json 不加载（它的 allow 会跨层合并 ⇒ 能 Write 别人的 outbox）', JSON.stringify(pa));
  // ⚠️ 先要求它**在**：删掉那行时 indexOf = -1，「-1 < 任何位置」恒真（变异会活下来）。
  const pre = src.indexOf('if (!isTrusted(cwd))');
  ok(pre >= 0 && pre < src.indexOf('roster.register('),
    'trust 预检在登记花名册之前（拒绝启动时不留一条永不报到的在册记录）');
  ok(/TRUST_DIALOG\.test\(r\.pane\)/.test(src), '起来之后再看一眼 pane（`❯` 也是对话框的光标）');
}

console.log('\n【6】QA 产物：所有类型都写不了');
{
  // 真 claude 上的效果（Write / Bash 被拒 ＋ 去掉之后能写的阴性对照）这里测不到；这里钉住配置的形状。
  const S = require('../lib/agent-settings');
  const root = '/R';
  for (const type of ['dev', 'eval', 'test', 'solve', 'write', 'review']) {
    const s = S.buildCrewSettings({ name: 'q', type, cwd: '/W', root });
    const deny = s.permissions.deny;
    const dw = s.sandbox.filesystem.denyWrite || [];
    const want = ['/W/docs/flows/*/TEST_REPORT.md', '/R/docs/flows/*/TEST_REPORT.md', '/W/**/QA*.md', '/R/temp/verify-cache/**'];
    ok(want.every((p) => deny.includes(`Edit(/${p})`)) && want.every((p) => dw.includes(p)) && dw.includes('/R/temp/verify-cache'),
      `${type}：Edit deny 和 sandbox denyWrite 都盖住 TEST_REPORT.md / QA*.md / temp/verify-cache`, JSON.stringify(dw));
  }
}

console.log('\n【7】三种 kind 都挂 StopFailure（编排者也挂），matcher rate_limit，--name 是自己的名字');
{
  const S = require('../lib/agent-settings');
  const R = '/fake/engloop';
  const cases = [
    { kind: 'crew', name: 'dev', type: 'dev', cwd: CWD },
    { kind: 'crew', name: 't1', type: 'test', cwd: CWD },            // 没有写能力的 agent 也挂（Stop 只给能写的，这个不挑）
    { kind: 'orchestrator', name: 'JARVIS', type: 'orchestrator', cwd: R },
    { kind: 'worker', name: 'worker-review', type: 'review', cwd: '/proj' },
  ];
  for (const c of cases) {
    const s = S.buildAgentSettings({ ...c, root: R });
    const sf = s.hooks.StopFailure;
    const h = sf && sf.length === 1 && sf[0].hooks && sf[0].hooks.length === 1 ? sf[0].hooks[0] : null;
    ok(sf && sf[0].matcher === 'rate_limit', `${c.kind}/${c.name}：有 StopFailure，matcher = rate_limit`, JSON.stringify(sf));
    const m = h && /^node "([^"]+)" --name (\S+)$/.exec(h.command);
    ok(m && m[1] === '/fake/engloop/hooks/stop_failure.js', `${c.kind}/${c.name}：命令是 node <root>/hooks/stop_failure.js（绝对路径）`, h && h.command);
    ok(m && m[2] === c.name, `${c.kind}/${c.name}：--name 是它自己的名字（生成时写死）`, m && m[2]);
    ok(h && h.type === 'command' && h.timeout === 10, `${c.kind}/${c.name}：type command，timeout 10`);
  }
  const o = S.buildAgentSettings({ kind: 'orchestrator', name: 'JARVIS', type: 'orchestrator', cwd: R, root: R });
  // 编排者的例外有两个：StopFailure 和工具调用日志（【8】）。要守的照旧：没有 check_security、没有 Stop。
  ok(!JSON.stringify(o.hooks).includes('check_security') && !o.hooks.Stop,
    '★ 编排者**仍然没有** check_security（也没有 Stop）—— 例外只有 StopFailure 和 journal', JSON.stringify(Object.keys(o.hooks)));
  const odd = S.buildAgentSettings({ kind: 'crew', name: "a'b $(x)", type: 'dev', cwd: CWD, root: R });
  ok(odd.hooks.StopFailure[0].hooks[0].command.endsWith(`--name 'a'\\''b $(x)'`),
    '不合格的名字被单引号整个引起来（shell 不展开 $()；hook 自己再按 NAME_RE 拒）', odd.hooks.StopFailure[0].hooks[0].command);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-agentsettings-'));
  const j = JSON.parse(fs.readFileSync(writeCrewSettings({ name: 'dev', type: 'dev', cwd: CWD, root }), 'utf8'));
  ok(j.hooks.StopFailure && j.hooks.StopFailure[0].matcher === 'rate_limit', '落盘的那份里也有');
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\n【8】工具调用日志（DUR1）：crew 和编排者挂，worker 不挂；编排者仍然没有 check_security');
{
  const S = require('../lib/agent-settings');
  const R = '/fake/engloop';
  const JRE = /^node "([^"]+)" --event (\S+) --name (\S+)$/;
  /** 某个事件上挂着的 journal 条目（matcher ＋ 解析出来的命令），没有 ⇒ [] */
  const journalOn = (s, ev) => (s.hooks[ev] || []).flatMap((e) => e.hooks.map((h) => ({ matcher: e.matcher, h, m: JRE.exec(h.command) })))
    .filter((x) => x.m && x.m[1] === '/fake/engloop/hooks/tool_journal.js');
  const want = { PreToolUse: 'intent', PostToolUse: 'outcome', PostToolUseFailure: 'failure' };
  for (const c of [
    { kind: 'crew', name: 'dev', type: 'dev', cwd: CWD },
    { kind: 'crew', name: 't1', type: 'test', cwd: CWD },
    { kind: 'orchestrator', name: 'JARVIS', type: 'orchestrator', cwd: R },
  ]) {
    const s = S.buildAgentSettings({ ...c, root: R });
    for (const [ev, event] of Object.entries(want)) {
      const js = journalOn(s, ev);
      ok(js.length === 1 && js[0].matcher === '*' && js[0].m[2] === event && js[0].h.type === 'command' && js[0].h.timeout === 5,
        `${c.kind}/${c.name}：${ev} 挂了 journal（matcher *，--event ${event}，timeout 5）`, JSON.stringify(s.hooks[ev]));
      ok(js.length === 1 && js[0].m[3] === c.name, `${c.kind}/${c.name}：${ev} 的 journal --name 是它自己的名字`, js[0] && js[0].m[3]);
    }
  }
  const crew = S.buildAgentSettings({ kind: 'crew', name: 'dev', type: 'dev', cwd: CWD, root: R });
  ok(/check_security\.js/.test(crew.hooks.PreToolUse[0].hooks[0].command) && crew.hooks.PreToolUse.length === 2,
    'crew：PreToolUse[0] 仍是 check_security，journal 排在它后面（并行跑，顺序不影响结论）', JSON.stringify(crew.hooks.PreToolUse));
  const ss = journalOn(crew, 'SessionStart');
  ok(ss.length === 1 && ss[0].m[2] === 'session' && ss[0].m[3] === 'dev', 'crew：SessionStart 挂了 journal（--event session，给 --resume 记 session_id）', JSON.stringify(crew.hooks.SessionStart));

  const o = S.buildAgentSettings({ kind: 'orchestrator', name: 'JARVIS', type: 'orchestrator', cwd: R, root: R });
  ok(!JSON.stringify(o.hooks).includes('check_security'), '★ 编排者**仍然没有** check_security（PreToolUse 上只有 journal）', JSON.stringify(o.hooks.PreToolUse));
  ok((o.hooks.PreToolUse || []).length === 1, '编排者的 PreToolUse 只有一个条目（journal）');
  ok(!o.hooks.SessionStart, '编排者不挂 SessionStart（--resume 只在 agent-start 上；根 .claude/settings.json 的压缩补回不受影响）');

  for (const type of ['review', 'solve']) {
    const w = S.buildAgentSettings({ kind: 'worker', name: `worker-${type}`, type, cwd: '/proj', root: R });
    ok(!JSON.stringify(w.hooks).includes('tool_journal') && !w.hooks.PostToolUse && !w.hooks.PostToolUseFailure && !w.hooks.SessionStart,
      `★ worker **没挂** journal（${type}）`, JSON.stringify(Object.keys(w.hooks)));
    ok(/check_security\.js/.test(w.hooks.PreToolUse[0].hooks[0].command) && w.hooks.PreToolUse.length === 1, `worker（${type}）的 PreToolUse 仍然只有 check_security`);
  }

  const odd = S.buildAgentSettings({ kind: 'crew', name: "a'b $(x)", type: 'dev', cwd: CWD, root: R });
  ok(odd.hooks.PostToolUse[0].hooks[0].command.endsWith(`--name 'a'\\''b $(x)'`), '不合格的名字被单引号整个引起来（hook 自己再按 NAME_RE 拒）');
}

console.log(`\n  通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
