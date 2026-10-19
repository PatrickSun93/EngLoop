'use strict';

/**
 * 完成核验接进 done 流程 —— **隔离 bus、真 relay、真核验子进程、夹具仓库**：
 *   带 code evidence 的 done ⇒ 先 ⏳（核验在跑时 relay 照常投别的消息）⇒ pass 后 🏁 ＋ 一条 verify:pass 的 system 跟帖
 *   fail ⇒ 🔙 ＋ agent 收到 `trust:"system"` 的打回（带没过的那条）· 第三次 fail ⇒ 编排者收到通知、agent 不再收打回
 *   没带 evidence ⇒ 🏁 ＋ verify:missing ＋ 通知标题「未验证（没带 evidence）」· kind none ⇒ 🏁 ＋「未验证」
 *
 * 隔离：`bin/serve.js` 头注 ①–⑩ 全设 ＋ ENGLOOP_ISOLATED=1 ＋ 自己的用户表 ＋ 测试库。不起 worker 池。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const q = require('../lib/queue');
const auth = require('../lib/auth');
const roster = require('../lib/roster');
const stamp = require('../lib/stamp');
const reactions = require('../lib/reactions');
const Threads = require('../web/threads.js');
const { makeFixture } = require('./verify-fixture');

const PORT = 19987;                    // 生产 9969 · e2e 19969 · bus-auth 19977 · graph-e2e 19983
const ROOT = path.join(__dirname, '..');
const CREW = 'vcrew';

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fieldsOf = ([id, f]) => { const o = { id }; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1]; return o; };

async function main() {
  console.log('\n完成核验 × done 流程（隔离 bus ＋ 真核验子进程）\n');
  // ★ 核验子进程要套 sandbox-exec；这个进程本身在限制性 sandbox 里时第二层套不上（返工 1）⇒ 整个文件跳过（⏭）。
  if (!require('../lib/sandbox-profile').available()) {
    console.log('  ⏭ 跳过整个文件：sandbox-exec 在这里套不上（多半是这个进程本身已经在 sandbox 里）');
    return;
  }
  const testDb = q.allocTestDb();
  if (testDb === null) { ok(false, '拿不到测试库'); return; }
  const testUrl = q.withDb(q.DEFAULTS.url, testDb);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-dverify-'));
  const dirs = {};
  for (const d of ['outbox', 'state', 'tmux', 'graphs', 'history', 'outputs', 'verify']) {
    dirs[d] = path.join(tmp, d);
    fs.mkdirSync(dirs[d], { recursive: true });
  }
  const usersFile = path.join(tmp, 'users.json');
  fs.writeFileSync(usersFile, JSON.stringify([{ username: 'Patrick', key_sha256: auth.sha256(auth.newKey()), can_manage_workers: true }]));
  const childEnv = { ...process.env };
  delete childEnv.TMUX; delete childEnv.TMUX_PANE;
  delete childEnv.ENGLOOP_TEST_DB; delete childEnv.ENGLOOP_TEST_DB_JOIN;
  Object.assign(childEnv, {
    ENGLOOP_REDIS_URL: testUrl,                                     // ①
    ENGLOOP_PORT: String(PORT),                                      // ②
    ENGLOOP_OUTBOX_ROOT: dirs.outbox,                                // ③
    ENGLOOP_ISOLATED: '1',                                           // ④ tmux no-op
    ENGLOOP_HISTORY_ROOT: dirs.history,                              // ⑤
    ENGLOOP_OUTPUTS_ROOT: dirs.outputs,                              // ⑥
    ENGLOOP_THREAD_ALERT_DIR: path.join(dirs.state, 'thread-alert'), // ⑦
    ENGLOOP_ADMIN_TOKEN_FILE: path.join(tmp, 'bus-admin.token'),     // ⑧
    ENGLOOP_GRAPHS_ROOT: dirs.graphs,                                // ⑨
    ENGLOOP_VERIFY_CACHE: dirs.verify,                               // ⑩
    ENGLOOP_USERS_FILE: usersFile,
    TMUX_TMPDIR: dirs.tmux,
    ENGLOOP_WAITING_STATE: path.join(dirs.state, 'waiting.json'),
    ENGLOOP_BUSY_ROOT: path.join(dirs.state, 'busy'),
    ENGLOOP_DEADLETTER_ROOT: path.join(dirs.state, 'deadletter'),
    ENGLOOP_WORKER_TYPES: '',
    ENGLOOP_GRAPH_TICK_MS: '600000',
  });

  const redis = q.createClient(testUrl);
  await redis.flushdb();
  await roster.register(redis, 'JARVIS', { type: 'orchestrator', tmux_session: '' });
  await roster.register(redis, CREW, { type: 'dev', tmux_session: '' });

  const fx = makeFixture();
  let bus = null;
  const busLog = [];
  process.on('exit', () => {
    try { if (bus && bus.exitCode === null) bus.kill('SIGKILL'); } catch (_) { /* 已经没了 */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    fx.cleanup();
  });
  bus = spawn('node', [path.join(ROOT, 'bin', 'serve.js')], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  bus.stdout.on('data', (d) => busLog.push(String(d)));
  bus.stderr.on('data', (d) => busLog.push(String(d)));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch (_) { await wait(200); }
  }
  ok(up, `⓪ 隔离 bus 起来了（:${PORT}，db ${testDb}）`, busLog.join('').slice(-400));
  if (!up) return;
  await wait(800);   // relay 在启动后第一次 syncRelays 挂上

  const say = (obj) => fs.writeFileSync(path.join(dirs.outbox, CREW, `${Date.now()}${Math.floor(Math.random() * 1000)}.json`), JSON.stringify(obj));
  const until = async (fn, ms = 30_000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await wait(150);
    }
  };
  const orchIn = async () => (await redis.xrange('orch:in:agent', '-', '+')).map(fieldsOf);
  const crewIn = async () => (await redis.xrange(`agent:${CREW}:in`, '-', '+')).map(fieldsOf);
  const emojis = async (anchor) => (await reactions.list(redis, 'dm', anchor)).reactions.map((r) => r.emoji);
  /** 发一条 done，等它进 orch:in:agent，返回那条流条目（它的 job_id 就是私聊 thread 的锚点）。 */
  const sendDone = async (tag, extra) => {
    say({ username: 'JARVIS', text: `做完了 ${tag}`, done: true, ...extra });
    return until(async () => (await orchIn()).find((m) => m.text === `做完了 ${tag}`));
  };

  // ── 1. 带 code evidence ⇒ ⏳ ⇒ 🏁（核验期间 relay 不被堵）────────────────────
  console.log('【1】code evidence ⇒ ⏳ ⇒ pass ⇒ 🏁');
  fx.branch('passing');
  // 一个慢测试：让核验子进程跑 ~3 秒，期间看 relay 还投不投别的消息
  fx.write('test/slow.test.js', "setTimeout(() => { console.log('  ✓ slow'); console.log('通过 1 · 失败 0'); }, 3000);\n");
  const good = fx.commit('加一个慢测试');
  const m1 = await sendDone('P', { evidence: { kind: 'code', repo: fx.repo, commit: good, tests: 'node test/run.js' } });
  ok(m1 && m1.verify === 'pending' && m1.done === 'true', '流里那条 done 带 verify:"pending"', JSON.stringify(m1).slice(0, 200));
  const a1 = m1 && m1.job_id;
  const hourglass = await until(async () => (await emojis(a1)).includes('⏳') && 1, 5000);
  ok(hourglass && !(await emojis(a1)).includes('🏁'), '先打 ⏳，**没有**打 🏁', JSON.stringify(await emojis(a1)));
  say({ username: 'JARVIS', text: '核验期间的另一条' });
  const other = await until(async () => (await orchIn()).find((m) => m.text === '核验期间的另一条'), 5000);
  ok(other && (await emojis(a1)).includes('⏳'), '★ 核验还在跑（⏳ 还在）时，relay 照样投了下一条 —— 没被核验堵住', JSON.stringify(await emojis(a1)));
  const flag = await until(async () => { const e = await emojis(a1); return e.includes('🏁') && !e.includes('⏳') && e; }, 60_000);
  ok(Boolean(flag), 'pass 之后 ⏳ 换成 🏁', JSON.stringify(await emojis(a1)) + busLog.join('').slice(-600));
  const verdict = (await orchIn()).find((m) => m.verify === 'pass' && m.reply_to === a1);
  ok(verdict && stamp.readStamp(verdict).trust === 'system' && verdict.from === CREW && verdict.done === 'true',
    '原 thread 里多了一条 verify:"pass" 的跟帖（system 章、挂在锚点上、编排者收得到）', JSON.stringify(verdict).slice(0, 300));
  ok(Threads.doneNotice(m1).notify === false && Threads.doneNotice(verdict).notify === true
    && /已独立核验/.test(Threads.doneNotice(verdict).title),
  '通知：pending 那条不弹，pass 跟帖弹、标题写「已独立核验」', Threads.doneNotice(verdict).title);
  // tests 不是全量（这里是 node test/run.js）⇒ 跟帖里明说范围
  ok(verdict && /范围：agent 自选的 `node test\/run\.js`，不是全量/.test(verdict.text),
    '核验范围不是全量时，通过的跟帖写明「范围：agent 自选的 …，不是全量」', verdict && verdict.text.split('\n')[0]);

  // ── 2. fail ⇒ 🔙 ＋ agent 收到 system 打回；第三次 ⇒ 编排者 ────────────────────
  console.log('\n【2】fail ⇒ 🔙 ＋ 打回；第三次 ⇒ 编排者');
  fx.branch('failing');
  fx.setBroken({ mul: true });
  const bad = fx.commit('弄坏 mul');
  const evBad = { kind: 'code', repo: fx.repo, commit: bad, tests: 'node test/run.js' };
  const anchors = [];
  for (let i = 1; i <= 3; i++) {
    const before = (await crewIn()).length;
    const beforeOrch = (await orchIn()).filter((m) => m.from === 'system').length;
    const m = await sendDone(`F${i}`, { evidence: evBad });
    anchors.push(m && m.job_id);
    const done = await until(async () => (await emojis(m.job_id)).includes('🔙') && 1, 60_000);
    ok(Boolean(done) && !(await emojis(m.job_id)).includes('⏳') && !(await emojis(m.job_id)).includes('🏁'),
      `第 ${i} 次：⏳ 换成 🔙（没有 🏁）`, JSON.stringify(await emojis(m.job_id)));
    await wait(400);
    const got = (await crewIn()).slice(before);
    const orchGot = (await orchIn()).filter((x) => x.from === 'system').slice(beforeOrch);
    if (i <= 2) {
      ok(got.length === 1 && stamp.readStamp(got[0]).trust === 'system' && /mul 2\*3=6/.test(got[0].text) && new RegExp(`第 ${i} 次`).test(got[0].text),
        `第 ${i} 次：${CREW} 收到一条 trust:"system" 的打回，点名了没过的那条（mul 2*3=6）`, JSON.stringify(got.map((x) => x.text.slice(0, 120))));
      ok(orchGot.length === 0, `第 ${i} 次：编排者没收到（还没到上限）`, String(orchGot.length));
    } else {
      ok(got.length === 0, `第 3 次：${CREW} **不再**收到打回`, JSON.stringify(got.map((x) => x.text.slice(0, 80))));
      ok(orchGot.length === 1 && stamp.readStamp(orchGot[0]).trust === 'system' && /第 3 次没过独立核验/.test(orchGot[0].text),
        '第 3 次：编排者（orch:in:agent）收到一条 system 通知「第 3 次没过」', JSON.stringify(orchGot.map((x) => x.text.slice(0, 160))));
    }
  }

  // ── 3. 没带 evidence / kind none ⇒ 照旧 🏁，标「未验证」──────────────────────
  console.log('\n【3】没带 evidence / kind none');
  const m3 = await sendDone('N', {});
  const f3 = await until(async () => (await emojis(m3.job_id)).includes('🏁') && 1, 5000);
  ok(Boolean(f3) && !(await emojis(m3.job_id)).includes('⏳'), '没带 evidence ⇒ 直接 🏁（不打 ⏳，不起核验）');
  ok(m3.verify === 'missing' && Threads.doneNotice(m3).notify && /未验证（没带 evidence）/.test(Threads.doneNotice(m3).title),
    '流里 verify:"missing"，通知标题带「未验证（没带 evidence）」', `${m3.verify} · ${Threads.doneNotice(m3).title}`);
  const m4 = await sendDone('X', { evidence: { kind: 'none', reason: '回答一个问题' } });
  const f4 = await until(async () => (await emojis(m4.job_id)).includes('🏁') && 1, 5000);
  ok(Boolean(f4) && m4.verify === 'none' && /（未验证）$/.test(Threads.doneNotice(m4).title),
    'kind none ⇒ 🏁，verify:"none"，通知标题带「未验证」', `${m4.verify} · ${Threads.doneNotice(m4).title}`);

  // ── 4. 核验日志落在 ⑩ 指的目录，不在生产 temp/ ────────────────────────────────
  const logs = fs.existsSync(path.join(dirs.verify, 'logs')) ? fs.readdirSync(path.join(dirs.verify, 'logs')) : [];
  ok(logs.length === 4, `核验日志 4 份（1 pass ＋ 3 fail）都在隔离目录 ⑩ 下`, String(logs.length));
  ok(!fs.existsSync(path.join(ROOT, 'temp', 'verify-cache', 'logs'))
    || !fs.readdirSync(path.join(ROOT, 'temp', 'verify-cache', 'logs')).some((f) => logs.includes(f)),
  '生产 temp/verify-cache 里没有这次的日志');

  // ── 5. 编排者的 poller 读得到 verify（编排者转达前要先看这个字段）────
  console.log('\n【5】真 poller（bin/next.js，以 JARVIS 身份）');
  const { execFileSync } = require('node:child_process');
  const seen = [];
  for (let i = 0; i < 8; i++) {
    const out = execFileSync('node', [path.join(ROOT, 'bin', 'next.js'), '--block', '1500'], {
      cwd: ROOT, encoding: 'utf8', env: { ...childEnv, ENGLOOP_PROBE_STATE: path.join(dirs.state, 'probe-JARVIS.json') },
    });
    const o = JSON.parse(out);
    seen.push(...(o.messages || []));
    if (seen.some((m) => m.verify === 'pass') && seen.some((m) => m.text === '做完了 P')) break;
  }
  const pP = seen.find((m) => m.text === '做完了 P');
  const pV = seen.find((m) => m.verify === 'pass');
  const pN = seen.find((m) => m.text === '做完了 N');
  ok(pP && pP.verify === 'pending' && pP.done === true, 'poller：带 evidence 的那条 ⇒ verify:"pending"', JSON.stringify(pP && { verify: pP.verify, done: pP.done }));
  ok(pV && pV.trust === 'system' && pV.reply_to === a1, 'poller：核验通过的跟帖 ⇒ verify:"pass"、trust:"system"、挂在同一个 thread', JSON.stringify(pV && { trust: pV.trust, reply_to: pV.reply_to }));
  ok(pN && pN.verify === 'missing', 'poller：没带 evidence 的 ⇒ verify:"missing"', JSON.stringify(pN && pN.verify));

  await redis.quit();
  await new Promise((resolve) => { bus.once('exit', resolve); bus.kill('SIGTERM'); });
}

main()
  .catch((e) => { fail++; console.log(`  ✗ 测试本身崩了：${e.stack}`); })
  .finally(() => {
    console.log(`\n通过 ${pass} · 失败 ${fail}`);
    process.exit(fail ? 1 : 0);
  });
