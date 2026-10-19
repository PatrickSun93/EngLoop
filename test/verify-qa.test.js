'use strict';

/**
 * verify-complete 的 QA —— **真 worker 池（type test）＋ 假 claude**：
 *   一次全 PASS ⇒ pass · 一次有 FAIL ⇒ fail · 一次不回 ⇒ fail（超时短）· 池没开 ⇒ fail 且说清楚
 *
 * 链路：verify(code evidence ＋ qa) ⇒ 夹具上重跑测试 ⇒ XADD work:test（from VERIFY）⇒ 池 ⇒ 假 claude（cwd = 临时树）
 *       ⇒ 池按 from 改道 ⇒ verify:reply:<job_id> ⇒ 逐条解析
 * 隔离：测试库（allocTestDb）、夹具在系统临时目录、基线缓存在临时目录。
 * ⚠️ 池会 provision `workers/test/`（写进 worktree 路径）—— 已知副作用，提交前 `git checkout -- workers/`。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const q = require('../lib/queue');
const V = require('../lib/verify-complete');
const { makeFixture } = require('./verify-fixture');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));
const brief = (r) => `${r.verdict} · missing=${JSON.stringify(r.missing).slice(0, 500)}`;

async function main() {
  console.log('\nverify-complete QA（真 test 池 ＋ 假 claude）\n');
  // ★ code 型核验要套 sandbox-exec；这个进程本身在限制性 sandbox 里时第二层套不上（返工 1）。
  //   ⏭ = run-all 的「整个文件跳过」，汇总里单独列出来，不算通过也不算失败。
  if (!require('../lib/sandbox-profile').available()) {
    console.log('  ⏭ 跳过整个文件：sandbox-exec 在这里套不上（多半是这个进程本身已经在 sandbox 里）');
    return;
  }
  const testDb = q.allocTestDb();
  if (testDb === null) { ok(false, '拿不到测试库'); return; }
  const url = q.withDb(q.DEFAULTS.url, testDb);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-vqa-'));

  // 假 claude：从 -p 的 brief 里数出 QA 项；项的原文里有标记就照标记答
  const fake = path.join(tmp, 'fake-claude.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const a = process.argv; const t = a[a.indexOf('-p') + 1] || '';
const items = [...t.matchAll(/^QA (\\d+)\\. (.*)$/gm)].map((m) => ({ i: m[1], text: m[2] }));
if (/FAKE_SILENT/.test(t)) { setTimeout(() => {}, 60_000); return; }
const out = ['我核过了。'];
// cwd 就是 commit 的干净副本：真去读一个文件当证据（证明 job 的 cwd 传对了）
let src = ''; try { src = require('fs').readFileSync('lib/math.js', 'utf8').split('\\n')[0]; } catch (e) { src = 'cwd 里没有 lib/math.js：' + process.cwd(); }
for (const it of items) out.push('QA ' + it.i + ': ' + (/FAKE_FAIL/.test(it.text) ? 'FAIL — 实际不成立' : 'PASS — 读了 lib/math.js：' + src));
setTimeout(() => process.stdout.write(out.join('\\n') + '\\n'), 300);
`);
  fs.chmodSync(fake, 0o755);
  process.env.ENGLOOP_CLAUDE_BIN = fake;

  const redis = q.createClient(url);
  const blocking = q.createClient(url);
  const poolConn = q.createClient(url);
  await redis.flushdb();
  const { startPool } = require('../lib/worker-pool');
  const logs = [];
  const getRedis = async () => ({ redis, blocking });
  const cache = path.join(tmp, 'cache');
  const fx = makeFixture();
  let pool = null;
  try {
    fx.branch('qa');
    fx.write('lib/extra.js', 'exports.x = 1;\n');
    const sha = fx.commit('qa 夹具');
    const ev = (qa) => ({ kind: 'code', repo: fx.repo, commit: sha, tests: 'node test/run.js', qa });

    // ── 池没开 ⇒ fail，且说清楚 ──────────────────────────────────────────────
    const r0 = await V.verify(ev(['加法对']), { cacheRoot: cache, getRedis, qaTimeoutMs: 3000 });
    ok(r0.verdict === 'fail' && r0.missing.some((m) => /work:test 没有活的消费者/.test(m)), '池没开 ⇒ fail，原因写「work:test 没有活的消费者」', brief(r0));

    pool = startPool(poolConn, { type: 'test', concurrency: 2, mode: 'print', onLog: (m) => logs.push(m), timeoutMs: 20_000 });
    // 等池在组里出现（XINFO CONSUMERS 有它）
    for (let i = 0; i < 50; i++) {
      try { if ((await redis.xinfo('CONSUMERS', 'work:test', 'work:test')).length) break; } catch (_) { /* 组还没建 */ }
      await new Promise((r) => setTimeout(r, 100));
    }

    // ── 全 PASS ⇒ pass ───────────────────────────────────────────────────────
    const t1 = Date.now();
    const r1 = await V.verify(ev(['add 2+3 等于 5', 'sub 5-3 等于 2']), { cacheRoot: cache, getRedis, qaTimeoutMs: 20_000 });
    ok(r1.verdict === 'pass', `两项都 PASS ⇒ pass（${Date.now() - t1}ms）`, brief(r1));
    const qaChecks = r1.checks.filter((c) => c.name.startsWith('QA '));
    ok(qaChecks.length === 2 && qaChecks.every((c) => c.ok && /exports\.add/.test(c.detail)),
      '逐条两项都在，证据里是 worker 在 cwd（commit 的临时树）里读到的 lib/math.js', JSON.stringify(qaChecks).slice(0, 300));

    // ── 有一条 FAIL ⇒ fail ───────────────────────────────────────────────────
    const r2 = await V.verify(ev(['add 2+3 等于 5', 'mul 是除法 FAKE_FAIL']), { cacheRoot: cache, getRedis, qaTimeoutMs: 20_000 });
    ok(r2.verdict === 'fail', '第 2 项 FAIL ⇒ fail', brief(r2));
    ok(r2.missing.length === 1 && /QA 2/.test(r2.missing[0]) && /FAIL/.test(r2.missing[0]), 'missing 只有 QA 2 那一条', JSON.stringify(r2.missing));

    // ── 不回 ⇒ fail（超时短）────────────────────────────────────────────────
    const t3 = Date.now();
    const r3 = await V.verify(ev(['FAKE_SILENT 随便什么']), { cacheRoot: cache, getRedis, qaTimeoutMs: 2500 });
    const el = Date.now() - t3;
    ok(r3.verdict === 'fail' && r3.missing.some((m) => /没回/.test(m)), `test worker 不回 ⇒ fail（${el}ms）`, brief(r3));
    ok(el < 15_000, '超时是短的（2.5 秒的 QA 上限 ＋ 跑测试）', String(el));

    // ── 结果确实没进编排者 / 网页那条流 ──────────────────────────────────────
    const crewIn = await redis.xrange('orch:in:agent', '-', '+');
    ok(crewIn.length === 0, 'QA 的 worker 结果一条都没进 orch:in:agent（编排者和网页不该看到中间结果）', String(crewIn.length));
    ok(fx.worktrees() === 1, '临时树都清掉了');
  } finally {
    if (pool) await pool.stop();
    fx.cleanup();
    await Promise.all([redis, blocking, poolConn].map((c) => c.quit().catch(() => {})));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .catch((e) => { fail++; console.log(`  ✗ 测试本身崩了：${e.stack}`); })
  .finally(() => {
    console.log(`\n通过 ${pass} · 失败 ${fail}`);
    process.exit(fail ? 1 : 0);
  });
