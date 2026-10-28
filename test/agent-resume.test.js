'use strict';

/**
 * DUR1 S3 ＋ DUR3：agent-start 接回会话的判据和参数拼接（单元级）。DUR3 起接回是**默认**，`--fresh` 明确不接。
 *
 * 真跑 agent-start（私有 tmux ＋ 假 claude，从假 claude 自己收到的 argv 里读）在 `test/launch-hygiene.test.js`【7b】。
 * 这里守的是纯函数：`resumePlan()`（能不能接回）、`resumeFlags()`（`--resume` / `--fresh`）、
 * `claudeCommand()` / `defaultKick()`（拼出来的那一条命令）。
 * 真起 tmux ＋ 真 claude 的 resume 验收不在这里（要在人的机器上做，步骤见 PR 描述）。
 *
 * 单跑：`node test/agent-resume.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const J = require('../lib/tool-journal');
const launch = require('../lib/agent-launch');
const { claudeCommand, defaultKick, resumeFlags } = require('../bin/agent-start');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-resume-test-')));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const SID = '98240ccc-f28e-421d-ab27-079d390d5758';

console.log('\n══ S3 · --resume ══════════════════════════════\n');

// 一份「真在」的 transcript：DUR3 起 resumePlan 要看它在不在（内容不读）
const TRANSCRIPT = path.join(TMP, 'projects', `${SID}.jsonl`);
fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
fs.writeFileSync(TRANSCRIPT, '{}\n');

console.log('【1】resumePlan：能接回 / 不能接回（退回全新会话 ＋ 警告）');
{
  const cwd = path.join(TMP, 'dev');
  fs.mkdirSync(cwd, { recursive: true });
  const rec = (o = {}) => ({ session_id: SID, cwd, transcript_path: TRANSCRIPT, type: 'dev', ...o });
  const yes = J.resumePlan({ record: rec(), cwd, type: 'dev' });
  ok(yes.resume === true && yes.sessionId === SID, '记录在、cwd 和 type 相同、transcript 在 ⇒ 接回', JSON.stringify(yes));

  const other = J.resumePlan({ record: rec({ cwd: path.join(TMP, 'other-worktree') }), cwd, type: 'dev' });
  ok(other.resume === false && /全新会话/.test(other.warn) && other.warn.includes('other-worktree') && other.warn.includes(cwd),
    'cwd 不同（换了 worktree）⇒ 不接回，警告里两个 cwd 都写出来', JSON.stringify(other));

  const link = path.join(TMP, 'dev-link');
  fs.symlinkSync(cwd, link);
  const viaLink = J.resumePlan({ record: rec(), cwd: link, type: 'dev' });
  ok(viaLink.resume === true, '同一个目录经软链到达 ⇒ 按 realpath 比，算相同（hook 收到的 cwd 是解析过的）', JSON.stringify(viaLink));

  const none = J.resumePlan({ record: null, reason: '没有 dev.session', cwd });
  ok(none.resume === false && none.warn.includes('没有 dev.session') && /全新会话/.test(none.warn), '没有记录 ⇒ 不接回，原因带上');

  const bad = J.resumePlan({ record: rec({ session_id: 'not-a-uuid; rm -rf /' }), cwd, type: 'dev' });
  ok(bad.resume === false && /不是 UUID/.test(bad.warn), 'session_id 不是 UUID ⇒ 不接回（它要进命令行）');

  // ── DUR3 R2：transcript 还在才接回（`claude --resume <找不到的 id>` 会 exit 1 ⇒ agent 起不来）──
  const gone = path.join(TMP, 'projects', 'gone-0000.jsonl');
  const noFile = J.resumePlan({ record: rec({ transcript_path: gone }), cwd, type: 'dev' });
  ok(noFile.resume === false && /transcript 已不在/.test(noFile.warn) && noFile.warn.includes(gone) && /全新会话/.test(noFile.warn),
    '★ transcript 不在 ⇒ 不接回，警告说「transcript 已不在」并带上路径', JSON.stringify(noFile));
  const rel = J.resumePlan({ record: rec({ transcript_path: path.relative(process.cwd(), TRANSCRIPT) }), cwd, type: 'dev' });
  ok(rel.resume === false && /transcript 已不在/.test(rel.warn), 'transcript_path 不是绝对路径 ⇒ 不接回（不按进程 cwd 去解析它）', JSON.stringify(rel));
  const legacy = J.resumePlan({ record: { session_id: SID, cwd, source: 'startup', at: 'x' }, cwd, type: 'dev' });
  ok(legacy.resume === false && /旧格式记录/.test(legacy.warn) && /全新会话/.test(legacy.warn),
    '★ 旧格式记录（DUR1 写的：没有 transcript_path、没有 type）⇒ 不接回，警告说「旧格式记录」（不推路径，理由见 resumePlan）', JSON.stringify(legacy));

  // ── DUR3 R3：类型变了不接回 ──
  const typed = J.resumePlan({ record: rec({ type: 'review' }), cwd, type: 'dev' });
  ok(typed.resume === false && typed.warn.includes('review') && typed.warn.includes('dev') && /全新会话/.test(typed.warn),
    '★ 记录是 review、这次是 dev ⇒ 不接回，警告里两个类型都写出来', JSON.stringify(typed));
  const untyped = J.resumePlan({ record: rec({ type: null }), cwd, type: 'dev' });
  ok(untyped.resume === true, '记录里没有 type（hook 命令行没给 --type）⇒ 这一条不拦', JSON.stringify(untyped));
  const noTypeAsked = J.resumePlan({ record: rec({ type: 'review' }), cwd });
  ok(noTypeAsked.resume === true, '调用方没给 type ⇒ 这一条不拦（只在两边都有时比）', JSON.stringify(noTypeAsked));
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
  fs.writeFileSync(path.join(dir, 'dev.session'), JSON.stringify({ session_id: SID, cwd: TMP, transcript_path: TRANSCRIPT, type: 'dev', source: 'startup', at: 'x' }));
  const good = J.readSession('dev', { dir });
  const plan = J.resumePlan({ ...good, cwd: TMP, type: 'dev' });
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
  // `--fresh`（以及接不回时）resumeId 是 null ⇒ **一个字节都不能变**：这是 DUR1 之前那一行的原样拼法
  //   （DUR1 时这条叫「不带 --resume 时逐字节相同」；DUR3 起不带参数是接回，同一个保证挪到了 --fresh 上）
  const legacy = `${launch.envUnsetPrefix()} claude ${permFlags} ${modelFlags} ${JSON.stringify(prompt)}`
    + ` --append-system-prompt-file ${JSON.stringify(personaFile)}`;
  ok(fresh === legacy, '--fresh（不带 resumeId）⇒ 跟改动前的拼法逐字节相同', `${fresh}\n     ≠ ${legacy}`);
  const res = claudeCommand({ permFlags, modelFlags, prompt, personaFile, resumeId: SID });
  ok(res.includes(` --resume ${SID} `), '带 resumeId ⇒ 有 `--resume <id>`', res);
  ok(res.replace(` --resume ${SID}`, '') === fresh, '★ 去掉 `--resume <id>` 之后跟全新会话那条逐字节相同（权限 / 模型 / --append-system-prompt-file 都在）');
  const noModel = claudeCommand({ permFlags, modelFlags: '', prompt, personaFile, resumeId: SID });
  ok(!noModel.includes('--model') && noModel.includes(`--resume ${SID}`), '能力表是 INHERIT（不传 --model）时也拼得对');
}

console.log('\n【4】kick：不接回那句不变；接回时换成「你刚被重启，先看 recovery」');
{
  const legacyKick = '你是 dev。进入你的循环：先向编排者 JARVIS 报到（写一条 outbox 消息说你已上线），然后运行 poller 等待指令。不要做别的。';
  ok(defaultKick('dev') === legacyKick, '不接回（--fresh / 接不回）⇒ 跟改动前那句逐字相同');
  const k = defaultKick('dev', { resumed: true });
  ok(k !== legacyKick && /重启/.test(k) && /recovery/.test(k) && /报到/.test(k) && /poller/.test(k),
    'resume ⇒ 说明刚被重启、先报到、跑 poller、重投消息先看 recovery', k);
  ok(!/部署|修复|实现/.test(k), '仍然是最小启动任务：不夹带具体工作');
}

console.log('\n【5】resumeFlags（DUR3）：默认接回 · --resume 等于默认 · --fresh 不接 · 两个都给 ⇒ 报错');
{
  const base = ['node', 'bin/agent-start.js', '--name', 'dev'];
  const dflt = resumeFlags(base);
  ok(dflt.fresh === false && !dflt.error, '★ 两个都不给 ⇒ 试着接回（fresh:false）', JSON.stringify(dflt));
  const r = resumeFlags([...base, '--resume']);
  ok(r.fresh === false && !r.error, '--resume ⇒ 等于默认，不报错（手指和文档里还写着它）', JSON.stringify(r));
  const f = resumeFlags([...base, '--fresh']);
  ok(f.fresh === true && !f.error, '★ --fresh ⇒ fresh:true', JSON.stringify(f));
  const both = resumeFlags([...base, '--resume', '--fresh']);
  ok(typeof both.error === 'string' && both.error.includes('--resume') && both.error.includes('--fresh'), '★ --resume --fresh ⇒ error（不猜）', JSON.stringify(both));
  const both2 = resumeFlags([...base, '--fresh', '--type', 'dev', '--resume']);
  ok(typeof both2.error === 'string', '顺序反过来、中间夹着别的参数 ⇒ 照样 error');
}

console.log(`\n  通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
