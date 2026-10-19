'use strict';

/**
 * 【T】测试与测试之间的隔离。
 *
 * ── 这个文件守的是什么 ──────────────────────────────────────────
 * isolation.test.js 守「测试碰不到生产」。这个守「测试碰不到别的测试」。
 * 两层都要在。
 *
 * 病是这样的：db 15 是共用的，两个进程同时 npm test 就在同一个库里搅动
 * 同一批流名（orch:in:agent / orch:out / deadletter …），谁先谁后随机。
 * 后果不是「偶尔失败」，是**制造假红和假绿，让验收本身不可信** ——
 * 可能把一份正确的代码判成有问题。
 *
 * 指纹：
 *   · 红的断言每次不一样、且独占跑就绿 = 并发
 *   · 红的断言每次一样                 = 真 bug
 * ────────────────────────────────────────────────────────────────
 *
 * ★ 测试方法上最要紧的两条：
 *
 * 1. **必须真并发** —— spawn 两个子进程同时跑，不是 spawnSync 串行。
 *    串行跑测不出这个 bug，那样测出来的绿是假绿。
 *
 * 2. **必须有对照组** —— 光证明「隔离之后互相看不见」不够，那也可能是
 *    因为这个测试压根没本事看见任何东西。所以再跑一组**强制共用同一个库**
 *    的，断言它们**确实**看得见对方的数据。对照组一红，说明正式组的绿是
 *    假的。这跟 isolation.test.js 里那个 decoy 是同一个道理：要证明的不是
 *    「什么都没发生」，是「该发生的发生了，只是打在了对的地方」。
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const q = require('../lib/queue');

const ROOT = path.join(__dirname, '..');
const WORKER = path.join(__dirname, 'mutual-isolation-worker.js');
const STREAM = 'orch:in:agent';

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

/** 起一个子进程，拿它的 JSON 结果。给了 url 就让它用那个库（对照组）。 */
function runWorker(tag, url) {
  return new Promise((resolve) => {
    const args = [WORKER, tag];
    if (url) args.push(url);
    const p = spawn('node', args, { cwd: ROOT });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      try {
        resolve(JSON.parse(out));
      } catch (_) {
        resolve({ tag, error: `exit=${code} stdout=${out.slice(0, 200)} stderr=${err.slice(0, 200)}` });
      }
    });
  });
}

async function main() {
  console.log('\n【1】分配：每个测试进程一个自己的库');
  const mine = q.allocTestDb();
  ok(Number.isInteger(mine) && mine >= q.TEST_DB_MIN && mine <= q.TEST_DB_MAX,
    `本进程分到 db ${mine}`);
  ok(mine !== 0, '★ 绝不是生产库 db 0');
  ok(q.allocTestDb() === mine, '同进程内幂等（多个 client 不会各抢一个）');

  // 主进程占住这个库 —— 下面对照组要用它，占着才不会被别人抢走
  const redis = q.createClient();
  await redis.ping();
  ok(redis.options.db === mine, 'createClient() 连的就是分到的那个库');

  console.log('\n【2】★ 两个进程真并发跑同一批会互相踩的操作');
  // spawn 两个，Promise.all 同时启动 —— 串行的话这个 bug 根本不出现
  const [a, b] = await Promise.all([runWorker('alpha'), runWorker('beta')]);
  ok(!a.error && !b.error, '两个子进程都正常结束', `${a.error || ''} ${b.error || ''}`);
  ok(a.db !== b.db, `★ 两个进程拿到不同的库（alpha=db${a.db} beta=db${b.db}）`);
  ok(a.db !== mine && b.db !== mine, `都没抢走主进程占着的 db ${mine}`);
  ok(a.foreign === 0, `★ alpha 看不到任何别人的数据（看到 ${a.foreign} 条）`);
  ok(b.foreign === 0, `★ beta 看不到任何别人的数据（看到 ${b.foreign} 条）`);
  // ── ★★ 进程**内部**前后是不是同一个库 ───────────────────────────
  //
  //   要分辨的形状：`alpha=0/beta=20` 和 `alpha=20/beta=0`（对称翻转），
  //   **而总数是 20 不是 40**。两个库确实不同（a.db!==b.db 是绿的），
  //   所以不是「两个进程互相影响」。
  //
  //   > **一个进程拿到 0 的意思是：它写进去的地方和它读出来的地方不是同一个。**
  //
  //   ⇒ 假设：worker 进程**内部**前后拿到了不同的 db。而 `a.db` 报的是
  //     **第一次**那个，所以 `a.db !== b.db` 照样通过 —— **那条断言看不见这件事。**
  //
  // ★ 这两条平时不红；价值在于
  //   **下次它红的时候，会直接指出成因，而不是又一次让人从 mine=0 去猜**。
  ok(a.db === a.dbAtRead,
    `★★ alpha 进程内部前后是同一个库（写时 db${a.db} · 读时 db${a.dbAtRead}）`);
  ok(b.db === b.dbAtRead,
    `★★ beta 进程内部前后是同一个库（写时 db${b.db} · 读时 db${b.dbAtRead}）`);

  ok(a.mine === 20 && b.mine === 20, `各自的 20 条一条不少（alpha=${a.mine} beta=${b.mine}）`);

  console.log('\n【3】★ 对照组：强制共用一个库，必须真的撞上对方');
  // 这一组证明上面那组的绿不是假绿。用主进程占着的库 —— 显式传 url 走的是
  // 「完全听调用方的」那条路，不抢占也不清库，所以两个子进程真的共用一个库。
  await redis.del(STREAM);
  const sharedUrl = q.withDb(q.DEFAULTS.url, mine);
  const [c, d] = await Promise.all([
    runWorker('gamma', sharedUrl),
    runWorker('delta', sharedUrl),
  ]);
  ok(!c.error && !d.error, '对照组两个子进程都正常结束', `${c.error || ''} ${d.error || ''}`);
  ok(c.db === mine && d.db === mine, `对照组确实共用 db ${mine}`);
  ok(c.foreign > 0 || d.foreign > 0,
    '★ 对照组确实看得见对方的数据 —— 证明【2】的绿是真绿，不是这个测试瞎了',
    `gamma 看到 ${c.foreign} 条、delta 看到 ${d.foreign} 条`);

  await redis.del(STREAM);
  await redis.quit();

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
