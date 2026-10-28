'use strict';

/**
 * DUR1 S3：`agent-start --resume` 的判据和参数拼接（单元级）。
 *
 * 真跑 agent-start（私有 tmux ＋ 假 claude，从假 claude 自己收到的 argv 里读）在 `test/launch-hygiene.test.js`【7b】。
 * 这里守的是两个纯函数：`resumePlan()`（能不能接回）和 `claudeCommand()` / `defaultKick()`（拼出来的那一条命令）。
 * 真起 tmux ＋ 真 claude 的 resume 验收不在这里（要在人的机器上做，步骤见 PR 描述）。
 *
 * 单跑：`node test/agent-resume.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const J = require('../lib/tool-journal');
const launch = require('../lib/agent-launch');
const { claudeCommand, defaultKick } = require('../bin/agent-start');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-resume-test-')));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const SID = '98240ccc-f28e-421d-ab27-079d390d5758';

console.log('\n══ S3 · --resume ══════════════════════════════\n');

console.log('【1】resumePlan：能接回 / 不能接回（退回全新会话 ＋ 警告）');
{
  const cwd = path.join(TMP, 'dev');
  fs.mkdirSync(cwd, { recursive: true });
  const yes = J.resumePlan({ record: { session_id: SID, cwd }, cwd });
  ok(yes.resume === true && yes.sessionId === SID, '记录在、cwd 相同 ⇒ 接回', JSON.stringify(yes));

  const other = J.resumePlan({ record: { session_id: SID, cwd: path.join(TMP, 'other-worktree') }, cwd });
  ok(other.resume === false && /全新会话/.test(other.warn) && other.warn.includes('other-worktree') && other.warn.includes(cwd),
    'cwd 不同（换了 worktree）⇒ 不接回，警告里两个 cwd 都写出来', JSON.stringify(other));

  const link = path.join(TMP, 'dev-link');
  fs.symlinkSync(cwd, link);
  const viaLink = J.resumePlan({ record: { session_id: SID, cwd }, cwd: link });
  ok(viaLink.resume === true, '同一个目录经软链到达 ⇒ 按 realpath 比，算相同（hook 收到的 cwd 是解析过的）', JSON.stringify(viaLink));

  const none = J.resumePlan({ record: null, reason: '没有 dev.session', cwd });
  ok(none.resume === false && none.warn.includes('没有 dev.session') && /全新会话/.test(none.warn), '没有记录 ⇒ 不接回，原因带上');

  const bad = J.resumePlan({ record: { session_id: 'not-a-uuid; rm -rf /', cwd }, cwd });
  ok(bad.resume === false && /不是 UUID/.test(bad.warn), 'session_id 不是 UUID ⇒ 不接回（它要进命令行）');
}

console.log('\n【2】readSession → resumePlan：读得到 / 不在 / 坏了');
{
  const dir = path.join(TMP, 'journal');
  fs.mkdirSync(dir, { recursive: true });
  const miss = J.readSession('dev', { dir });
  ok(miss.record === null && /没有 dev\.session/.test(miss.reason), '不在 ⇒ record null，reason 说清', JSON.stringify(miss));
  fs.writeFileSync(path.join(dir, 'dev.session'), '{oops');
  const broken = J.readSession('dev', { dir });
  ok(broken.record === null && /不是合法 JSON/.test(broken.reason), '坏了 ⇒ record null，reason 说清');
  fs.writeFileSync(path.join(dir, 'dev.session'), JSON.stringify({ session_id: SID, cwd: TMP, source: 'startup', at: 'x' }));
  const good = J.readSession('dev', { dir });
  const plan = J.resumePlan({ ...good, cwd: TMP });
  ok(plan.resume === true && plan.sessionId === SID, '读得到 ⇒ 接回');
  ok(J.readSession('../x', { dir }).record === null, '名字不合格 ⇒ 不读');
}

console.log('\n【3】claudeCommand：resume 时只多一个 `--resume <id>`，其余参数一个不变');
{
  const permFlags = launch.shellJoin(['--permission-mode', 'dontAsk', '--setting-sources', 'user', '--settings', '/s/dev.json']);
  const modelFlags = launch.shellJoin(['--model', 'opus']);
  const personaFile = '/w/dev dir/CLAUDE.md';
  const prompt = '你是 dev。进入你的循环';
  const fresh = claudeCommand({ permFlags, modelFlags, prompt, personaFile });
  // 不传 --resume 时**一个字节都不能变**：这是改动之前那一行的原样拼法
  const legacy = `${launch.envUnsetPrefix()} claude ${permFlags} ${modelFlags} ${JSON.stringify(prompt)}`
    + ` --append-system-prompt-file ${JSON.stringify(personaFile)}`;
  ok(fresh === legacy, '不带 resumeId ⇒ 跟改动前的拼法逐字节相同', `${fresh}\n     ≠ ${legacy}`);
  const res = claudeCommand({ permFlags, modelFlags, prompt, personaFile, resumeId: SID });
  ok(res.includes(` --resume ${SID} `), '带 resumeId ⇒ 有 `--resume <id>`', res);
  ok(res.replace(` --resume ${SID}`, '') === fresh, '★ 去掉 `--resume <id>` 之后跟全新会话那条逐字节相同（权限 / 模型 / --append-system-prompt-file 都在）');
  const noModel = claudeCommand({ permFlags, modelFlags: '', prompt, personaFile, resumeId: SID });
  ok(!noModel.includes('--model') && noModel.includes(`--resume ${SID}`), '能力表是 INHERIT（不传 --model）时也拼得对');
}

console.log('\n【4】kick：默认那句不变；resume 时换成「你刚被重启，先看 recovery」');
{
  const legacyKick = '你是 dev。进入你的循环：先向编排者 JARVIS 报到（写一条 outbox 消息说你已上线），然后运行 poller 等待指令。不要做别的。';
  ok(defaultKick('dev') === legacyKick, '不 resume ⇒ 跟改动前那句逐字相同（不传参时的默认值不能变）');
  const k = defaultKick('dev', { resumed: true });
  ok(k !== legacyKick && /重启/.test(k) && /recovery/.test(k) && /报到/.test(k) && /poller/.test(k),
    'resume ⇒ 说明刚被重启、先报到、跑 poller、重投消息先看 recovery', k);
  ok(!/部署|修复|实现/.test(k), '仍然是最小启动任务：不夹带具体工作');
}

console.log(`\n  通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
