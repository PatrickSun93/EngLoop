'use strict';

/**
 * `hooks/stop_failure.js`（StopFailure hook）。
 *
 * 每一条都**真的起 hook 子进程**、从 stdin 喂 JSON（字段名照 Claude Code 2.1.299 二进制里读出来的那组造：
 * session_id / transcript_path / cwd / hook_event_name / error / error_details / last_assistant_message）。
 * 信号目录用 `ENGLOOP_SIGNALS_DIR` 指到临时目录 —— 不碰生产的 temp/signals/。
 *
 * ⚠️ 施工纪律（同 watchdog-rate-limit-* 的 X1 自查）：本文件不出现能命中 watchdog 入口判据（RATE_LIMIT_RE）的
 *   字面文本 —— 读它、cat 它不会污染任何 pane。文件末尾自查。
 *
 * 变异：test/stopfailure-mutation.test.js 用 `node -r test/fixtures/e15-mutant-preload.js` 跑本文件；
 *   这里起子进程时把自己的 `process.execArgv` 透传下去，变异才进得了 hook 子进程。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'stop_failure.js');
const sig = require('../lib/rate-limit-signal');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => (c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`)));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-e15-hook-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 清不掉就算了 */ } });

let n = 0;
const freshDir = () => { const d = path.join(TMP, `s${++n}`); return d; };

/** 起一次 hook。input 是对象就 JSON 化；字符串原样喂。 */
function runHook({ input, name = 'e15hook', dir, args }) {
  const argv = [...process.execArgv, HOOK, ...(args || ['--name', name])];
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  const r = spawnSync(process.execPath, argv, {
    input: stdin, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, ENGLOOP_SIGNALS_DIR: dir },
  });
  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}

/** 照 2.1.299 二进制里那组字段名造一份输入。 */
function hookInput(over = {}) {
  return {
    session_id: 'sess-e15-0001',
    transcript_path: '/tmp/none.jsonl',
    cwd: '/tmp',
    hook_event_name: 'StopFailure',
    error: 'rate_limit',
    error_details: '429 too many requests',
    last_assistant_message: "You've hit your limit · resets 3:00pm (America/Los_Angeles)",
    ...over,
  };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n══ StopFailure hook ══════════════════════════════\n');

  console.log('【1】error = rate_limit ⇒ 写信号文件，形状对');
  {
    const dir = freshDir();
    const t0 = Date.now();
    const r = runHook({ input: hookInput(), dir });
    const t1 = Date.now();
    const file = path.join(dir, 'rate_limit-e15hook.json');
    ok(r.status === 0, 'exit 0', `exit=${r.status} ${r.stderr}`);
    ok(fs.existsSync(file), '写到 <dir>/rate_limit-<name>.json', fs.existsSync(dir) ? fs.readdirSync(dir).join(',') : '(目录不在)');
    const j = fs.existsSync(file) ? readJson(file) : {};
    ok(j.v === 1 && j.name === 'e15hook' && j.error === 'rate_limit' && j.session_id === 'sess-e15-0001',
      'v / name / error / session_id 都在', JSON.stringify(j));
    ok(Number.isFinite(j.at) && j.at >= t0 && j.at <= t1 && j.last_at === j.at,
      '第一次：at = last_at = 写入时刻（毫秒）', JSON.stringify({ at: j.at, last_at: j.last_at, t0, t1 }));
    ok(typeof j.message_tail === 'string' && j.message_tail.includes('resets 3:00pm (America/Los_Angeles)')
      && j.message_tail.includes('429 too many requests'),
      'message_tail 带着 last_assistant_message 和 error_details 的原文（不解析）', JSON.stringify(j.message_tail));
    ok(!('raw' in j) && !('tz' in j) && !('reset_at' in j), 'hook 里**不解析**：没有 raw / tz / reset_at 之类的字段');
    ok(fs.readdirSync(dir).length === 1, '目录里只有这一个文件（临时文件已 rename 掉，没有残留）', fs.readdirSync(dir).join(','));
  }

  console.log('\n【2】其他 error ⇒ 不写');
  for (const e of ['overloaded', 'authentication_failed', 'billing_error', 'server_error', 'unknown', undefined]) {
    const dir = freshDir();
    const r = runHook({ input: hookInput({ error: e }), dir });
    ok(r.status === 0 && !fs.existsSync(dir), `error=${e} ⇒ exit 0，什么都不写（目录都不建）`,
      `exit=${r.status} exists=${fs.existsSync(dir)}`);
  }

  console.log('\n【3】第二次触发：保留 at，只更新 last_at');
  {
    const dir = freshDir();
    runHook({ input: hookInput({ session_id: 'first' }), dir });
    const file = path.join(dir, 'rate_limit-e15hook.json');
    const a = readJson(file);
    await sleep(30);
    const r = runHook({ input: hookInput({ session_id: 'second', last_assistant_message: 'second time' }), dir });
    const b = readJson(file);
    ok(r.status === 0, '第二次也 exit 0');
    ok(b.at === a.at, '🔴 保留 at（撞墙后第一次停下的时刻）—— 跟 rl_since 的 NX 同一个意思',
      JSON.stringify({ first: a.at, second: b.at }));
    ok(b.last_at > a.last_at, 'last_at 更新到第二次', JSON.stringify({ first: a.last_at, second: b.last_at }));
    ok(b.session_id === 'second' && b.message_tail.includes('second time'), 'session_id / message_tail 换成最新那次');
    // 读不出来的旧文件 ⇒ 当没有：at 重新从这次算
    fs.writeFileSync(file, '{ 这不是 JSON');
    const t0 = Date.now();
    runHook({ input: hookInput(), dir });
    const c = readJson(file);
    ok(c.at >= t0 && c.at === c.last_at, '旧文件读不出来 ⇒ 重写，at 从这次算', JSON.stringify(c));
  }

  console.log('\n【4】--name 只认 ^[A-Za-z0-9_-]+$（防路径穿越）');
  for (const bad of ['../x', '..', 'a/b', 'a b', '', 'x.json', '$(id)']) {
    const base = freshDir();
    const dir = path.join(base, 'signals');
    fs.mkdirSync(dir, { recursive: true });
    const r = runHook({ input: hookInput(), dir, args: ['--name', bad] });
    const leaked = [...fs.readdirSync(dir), ...fs.readdirSync(base).filter((f) => f !== 'signals')];
    ok(r.status === 0 && leaked.length === 0, `--name ${JSON.stringify(bad)} ⇒ exit 0，信号目录里和它上一层都没写任何东西`,
      `exit=${r.status} 写出了 ${leaked.join(',')}`);
  }
  {
    const dir = freshDir();
    const r = runHook({ input: hookInput(), dir, args: [] });
    ok(r.status === 0 && !fs.existsSync(dir), '没有 --name ⇒ exit 0，不写');
  }

  console.log('\n【5】坏输入 / 写不了 ⇒ 都 exit 0');
  for (const [label, input] of [['垃圾', 'not json {{{'], ['空', ''], ['数组', '[1,2]'], ['null', 'null']]) {
    const dir = freshDir();
    const r = runHook({ input, dir });
    ok(r.status === 0 && !fs.existsSync(dir), `stdin 是${label} ⇒ exit 0，不写`, `exit=${r.status}`);
  }
  {
    // 信号目录的上一层是个**普通文件** ⇒ mkdir 必然失败（ENOTDIR），跟权限位无关（root 下也成立）
    const blocker = path.join(freshDir() + '-file');
    fs.writeFileSync(blocker, 'x');
    const r = runHook({ input: hookInput(), dir: path.join(blocker, 'signals') });
    ok(r.status === 0, '目录建不出来（上一层是文件）⇒ 仍然 exit 0', `exit=${r.status}`);
    ok(/没写成信号/.test(r.stderr), '而 stderr 说了一句（输出被忽略，但手工跑时看得见）', r.stderr.trim());
  }
  if (process.getuid && process.getuid() !== 0) {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o500);
    const r = runHook({ input: hookInput(), dir });
    fs.chmodSync(dir, 0o700);
    ok(r.status === 0 && fs.readdirSync(dir).length === 0, '目录只读 ⇒ exit 0，没写出东西（也没留临时文件）',
      `exit=${r.status} ${fs.readdirSync(dir).join(',')}`);
  }

  console.log('\n【6】message_tail 截断到上限（各取最后 TAIL_MAX 个字）');
  {
    const dir = freshDir();
    const lam = `${'甲'.repeat(800)}LAM-END`;
    const det = { type: 'error', error: { message: `${'x'.repeat(900)}DET-END` } };
    runHook({ input: hookInput({ last_assistant_message: lam, error_details: det }), dir });
    const j = readJson(path.join(dir, 'rate_limit-e15hook.json'));
    const parts = j.message_tail.split('\n');
    ok(sig.TAIL_MAX === 300, '上限是 300');
    ok(parts.length === 2 && Array.from(parts[0]).length === 300 && Array.from(parts[1]).length === 300,
      '两段各 300 字（按码点算，中文不会被切成半个）', JSON.stringify(parts.map((p) => Array.from(p).length)));
    ok(parts[0].endsWith('DET-END"}}') && parts[1].endsWith('LAM-END'),
      '取的是**尾巴**（恢复时刻那句在最后）；error_details 是对象 ⇒ 先 JSON 化', JSON.stringify(parts.map((p) => p.slice(-12))));
    ok(Array.from(j.message_tail).length <= 2 * sig.TAIL_MAX + 1, `总长 ≤ 2×${sig.TAIL_MAX}+1`);
  }

  console.log('\n【7】生成的配置里那条命令，原样交给 shell 也能用');
  {
    const AS = require('../lib/agent-settings');
    const dir = freshDir();
    const s = AS.buildAgentSettings({ kind: 'crew', name: 'e15cmd', type: 'dev', cwd: '/fake/w', root: ROOT });
    const cmd = s.hooks.StopFailure[0].hooks[0].command;
    // ⚠️ 透传 execArgv：变异要能进到这个子进程（node 只在命令开头那个 `node` 上）
    const shellCmd = cmd.replace(/^node /, `node ${process.execArgv.map((a) => `'${a}'`).join(' ')} `);
    const r = spawnSync('/bin/sh', ['-c', shellCmd], {
      input: JSON.stringify(hookInput()), encoding: 'utf8', env: { ...process.env, ENGLOOP_SIGNALS_DIR: dir },
    });
    ok(r.status === 0 && fs.existsSync(path.join(dir, 'rate_limit-e15cmd.json')),
      `sh -c '${cmd.replace(ROOT, '<root>')}' ⇒ 写出 rate_limit-e15cmd.json`, `exit=${r.status} ${r.stderr}`);
  }

  console.log('\n【8】hook 不连 Redis、不上网、不弹通知（源码里没有那些依赖）');
  {
    const src = ['hooks/stop_failure.js', 'lib/rate-limit-signal.js']
      .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    const allowed = ['node:fs', 'node:path', '../lib/rate-limit-signal'];
    ok(reqs.length > 0 && reqs.every((r) => allowed.includes(r)),
      `只 require ${allowed.join(' / ')}（没有 queue / ioredis / http / net / child_process）`, JSON.stringify(reqs));
    ok(!/osascript|notify|terminal-notifier/i.test(src), '没有桌面通知');
  }

  console.log('\n【X】施工纪律自查');
  {
    const watchdog = require('../lib/watchdog');
    const me = fs.readFileSync(__filename, 'utf8');
    ok(watchdog.looksRateLimited(me) === false, '🔴 本文件源码喂进入口判据 = false ⇒ cat 它不会污染任何 pane');
    const real = fs.readFileSync(path.join(__dirname, 'fixtures', 'synthetic', 'rate-limit-panes', 'line-only.txt'), 'utf8');
    ok(watchdog.looksRateLimited(real) === true, '★ 阴性对照：同一个检查器对 fixture 返回 true ⇒ 它不是恒假的');
  }

  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
