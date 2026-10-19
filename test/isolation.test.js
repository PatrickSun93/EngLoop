'use strict';

/**
 * 测试与生产的隔离自检。
 *
 * ── 这个文件存在的理由 ──────────────────────────────────────────
 * 「测试不许碰生产流」这条规矩靠人记得是守不住的：常见的模式是
 * 写测试的人知道规矩，但顺手 del 一个流名，而那个流名恰好是生产在用的。
 *
 * 所以规矩被下沉成了物理隔离：测试进程连 db 15，生产在 db 0。
 * 而这个文件负责证明**隔离本身没坏** —— 否则它就是一层假保护，
 * 比没有保护更危险（大家会以为自己安全了）。
 *
 * 最硬的一条是【4】：真的去跑一遍会删生产流名的动作，
 * 然后回 db 0 检查生产数据还在不在。不是推理，是实际执行。
 * ────────────────────────────────────────────────────────────────
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const q = require('../lib/queue');

const ROOT = path.join(__dirname, '..');
const PROD_URL = 'redis://127.0.0.1:6379/0';

// 生产在用的流。测试文件里出现这些名字 + 破坏性操作，就是要防的那类事故。
const PROD_STREAMS = ['orch:in:human', 'orch:in:agent', 'orch:out', 'deadletter'];

// ══════════════════════════════════════════════════════════════════
// 🔴 测试库编号：**预约一个**，不写死
//
// ── 为什么不能写死 ────────────────────────────────────────────────
//   写死的号（如 `ENGLOOP_TEST_DB: '13'`、`const D = 1`）⇒ 两个实例同时跑
//   ⇒ 同一个号、同一把锁、而【5e–5h】还会 `rmSync` 那把锁
//     ⇒ **必然互相破坏**，而它跟机器负载**毫无关系**：空闲机器上并发跑两遍照样挂。
//   而它在全量里的样子是：`execFileSync` 抛 ⇒ 未捕获
//   ⇒ **整个文件死** ⇒ `broken 1 · silent [...]` ⇒ 全量少一大截，
//   而**总数看起来仍然像个正常的数**。
//
//   🔴 它只在**两个人同时跑全量**时触发 —— 平时排队跑就看不到它。
//
// ── 为什么是「预约」而不是「换个号」或「pid 化」──────────────────────
//   · 换个号 ⇒ 两个实例照样撞，只是换个地方撞
//   · pid 化 ⇒ `ENGLOOP_TEST_DB` 的语义**就是**「抢一个固定编号」，
//     而【5b】【5e–5h】验的正是那个语义 ⇒ 号必须是一个确定的数
//   ✅ ⇒ 所以：在**另一个命名空间**里预约一个号（`engloop-isolation-claim-N.lock`），
//     而**生产那把锁一直是空的** ⇒ 子进程照旧去抢它 ⇒ 被验的语义一个字没变。
//
// ── ⚠️ 两格已知的洞，明写 ────────────────────────────────────────
//   ① **TOCTOU**：`existsSync(生产锁)` 和「用它」之间，生产侧可以占走那个号。
//      ⇒ 后果是 **fail-loud**：子进程抢不到 ⇒ 【5b】红，而它会说
//        「设了变量却没拿到那个库」—— 一句看得懂的话。
//      ⇒ 修它要把两把不同的锁原子化，代价远大于收益 ⇒ **标着不修**。
//      🔴 而标出来的理由：**否则那条偶发红，会被当成又一个 flaky。**
//   ② **陈旧的预约不判**：写预约的进程死掉 ⇒ 那个号会一直被跳过。
//      ⇒ 后果不是撞车，是**号池变小**；攒够 15 个之后下面那个 throw 会开始误报。
//      ⇒ 所以那句 throw **带分母**（真的占满 / 全是尸体，两种成因会说同一句话）。
//      ⇒ 有意不复刻 `lib/queue.js` 的 lockIsStale：**先让文案说清，再看它会不会真发生**。
// ══════════════════════════════════════════════════════════════════
const claimPathFor = (n) => path.join(os.tmpdir(), `engloop-isolation-claim-${n}.lock`);

function reserveTestDb() {
  let byOthers = 0;
  let byProd = 0;
  // ★ 生产的自动分配是 **15 → 1** 扫（`lib/queue.js` 的 allocTestDb）
  //   ⇒ 这里**从 1 往上**走，方向相反 ⇒ 撞上的概率最小。
  for (let n = q.TEST_DB_MIN; n <= q.TEST_DB_MAX; n += 1) {
    if (!q.tryClaimLock(claimPathFor(n))) { byOthers += 1; continue; }
    if (fs.existsSync(q.testDbLockPath(n))) {
      fs.rmSync(claimPathFor(n), { force: true });
      byProd += 1;
      continue;
    }
    return { db: n, release: () => fs.rmSync(claimPathFor(n), { force: true }) };
  }
  // 🔴 扫完没有 return 的话会返回 undefined ⇒ 子进程拿到 ENGLOOP_TEST_DB=undefined
  //   ⇒ 它在子进程里抛 ⇒ execFileSync 再抛 ⇒ **伪装成这个文件本来要修的那个 bug**。
  //   ⇒ ⇒ 所以这里在**父进程**抛，而且带分母。
  throw new Error(
    '测试库号全被占：扫过 ' + (q.TEST_DB_MAX - q.TEST_DB_MIN + 1) + ' 个，'
    + byOthers + ' 个被别的 isolation 实例预约、' + byProd + ' 个生产锁在。'
    + '⚠️ 两种成因会说这同一句话：真的占满 vs 预约/生产锁全是尸体 —— 所以这里报分母。');
}

const RESERVED = reserveTestDb();
// ★ 用 exit 钩子还回去：这个文件末尾是 process.exit()，而 finally 不一定跑得到。
process.on('exit', () => { try { RESERVED.release(); } catch (_) { /* 已经没了 */ } });

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

async function main() {
  console.log('\n【1】判定：谁算测试进程');
  ok(q.isTestProcess() === true, '我自己（test/ 下的脚本）算测试进程');
  ok(q.isTestProcess(path.join(ROOT, 'test', 'queue.test.js')) === true, 'test/ 下的其它测试也算');
  ok(q.isTestProcess(path.join(ROOT, 'bin', 'next.js')) === false, '★ bin/next.js 不算 —— 它是编排者的生命线');
  ok(q.isTestProcess(path.join(ROOT, 'bin', 'serve.js')) === false, '★ bin/serve.js 不算');
  ok(q.isTestProcess(path.join(ROOT, 'lib', 'queue.js')) === false, 'lib/ 下的不算');
  // ⚠️ `test/` 的子目录**也算**测试进程。「只认正好一层」是错的期望：
  //   探针放在 `test/fixtures/` 会被判成**生产进程**、连 db 0，
  //   `redis.del(..., 'orch:in:agent')` 会删掉编排者收件流的未读消息。
  //
  //   > **一条测试可以替一个从一开始就有害的决定站岗 —— 而且它一直是绿的。**
  //
  //   详细守卫见下面【★危】那节（含 `test-backup/` 的阴性对照）。
  ok(q.isTestProcess(path.join(ROOT, 'test', 'sub', 'deep.test.js')) === true,
    '★ `test/` 的子目录**算**测试进程（这条翻转过，见注释）');
  ok(q.isTestProcess('') === false, '拿不到入口时算生产（宁可漏判，不可误判）');

  console.log('\n【2】连接：默认去哪');
  // ★ 每个测试进程各抢一个测试库（1–15），没有固定编号。
  //   要守的意图是「测试进程绝不连生产库 0」，所以显式断言「不是 0」，
  //   而不是断言某个固定编号。
  ok(q.TEST_DB === 15, `测试库的默认/回退编号是 db ${q.TEST_DB}`);
  const mine = q.allocTestDb();
  ok(Number.isInteger(mine) && mine >= q.TEST_DB_MIN && mine <= q.TEST_DB_MAX,
    `本进程分到的测试库 db ${mine} 在 ${q.TEST_DB_MIN}–${q.TEST_DB_MAX} 内`);
  ok(mine !== 0, '★ 分到的绝不是 db 0（这是上面那两条断言原本的意图）');
  ok(q.allocTestDb() === mine, '同一进程内幂等 —— 多个 client 不会抢到不同的库');
  ok(q.withDb('redis://127.0.0.1:6379', 15) === 'redis://127.0.0.1:6379/15', 'withDb 补上 db');
  ok(q.withDb('redis://127.0.0.1:6379/0', 15) === 'redis://127.0.0.1:6379/15', 'withDb 替换已有的 db');
  ok(q.withDb('不是个 url', 15) === '不是个 url', '解析不了就原样返回，不自作聪明');

  const auto = q.createClient();
  await auto.ping();
  ok(auto.options.db === mine, `★ 测试进程里 createClient() 自动连到分到的库 db ${mine}`);
  ok(auto.options.db !== 0, '★ 无论分到哪个，都绝不是生产库 db 0');

  const explicit = q.createClient(PROD_URL);
  await explicit.ping();
  ok(explicit.options.db === 0, '显式给 url 时完全听调用方的（自检靠这个口子看生产库）');

  console.log('\n【3】隔离确实生效：写测试库，生产库看不见');
  const probe = `isolation:probe:${process.pid}`;
  await auto.xadd(probe, '*', 'hello', 'world');
  ok(await auto.exists(probe) === 1, '测试库里写进去了');
  ok(await explicit.exists(probe) === 0, '★ 生产库里根本看不到这个 key');
  await auto.del(probe);

  console.log('\n【4】★ 真跑：跑那两个会删生产流的测试，生产数据必须毫发无伤');
  // 先在生产库立一个标记 —— 用测试专属的 key 名，不动任何真流
  const canary = `isolation:canary:${process.pid}`;
  await explicit.xadd(canary, '*', 'alive', '1');

  // 记录生产库里那几个真流的现状，跑完要一模一样
  const before = {};
  for (const s of PROD_STREAMS) {
    before[s] = { exists: await explicit.exists(s), len: await explicit.xlen(s).catch(() => 0) };
  }

  // 用探针脚本模拟「一个测试进程 del 掉那四个生产流名」这个动作。
  //
  // ⚠️ 不直接 fork relay.test.js 和 worker.test.js：那两个文件在一次 npm test 里
  // 会各跑两遍（这里一遍、run-all 自己一遍），两遍共享测试库状态，结果开始依赖
  // 残留 —— 测试之间有了顺序依赖，红的文件每轮都不一样。
  //
  // 而要证明的其实很窄：**del 生产流名时删掉的是测试库的同名流，不是 db0 的真流**。
  // 探针直接针对这个动作，不掺杂别的测试逻辑，也不跟任何测试文件耦合。
  // （也不用 stdio:'ignore'：子进程失败时哪条断言红了会被原地丢掉，
  //   外面只剩一个退出码。）
  const delRun = spawnSync('node', [path.join(ROOT, 'test', 'del-probe.js')], {
    cwd: ROOT, encoding: 'utf8',
  });
  let probeOut = null;
  try { probeOut = JSON.parse(delRun.stdout || '{}'); } catch (_) { /* 下面断言会报 */ }

  ok(delRun.status === 0 && probeOut?.ok === true,
    '★ 探针在测试库里建了那四个流又删掉了 —— 删除动作真的发生了',
    `exit=${delRun.status} out=${(delRun.stdout || '').slice(0, 200)} err=${(delRun.stderr || '').slice(0, 200)}`);
  // 同样从固定值改成范围：探针是子进程，会抢到跟父进程不同的编号。
  // 原意图「探针连的是测试库不是生产库」显式保留在第二条。
  ok(Number.isInteger(probeOut?.db)
     && probeOut.db >= q.TEST_DB_MIN && probeOut.db <= q.TEST_DB_MAX,
    `★ 探针连在测试库范围内（db ${probeOut?.db}）`);
  ok(probeOut?.db !== 0, '★ 探针绝不在生产库 db 0 上执行删除');
  ok(probeOut?.db !== mine, '★ 探针作为子进程抢到了跟父进程不同的库');
  ok(Array.isArray(probeOut?.stillThere) && probeOut.stillThere.length === 0,
    '★ 四个流在测试库里被删干净了', JSON.stringify(probeOut?.stillThere));

  ok(await explicit.exists(canary) === 1, '★ 生产库的标记还在（测试没有伸进 db 0）');

  // ★ 判据是「没被删」，不是「没变过」。
  //
  // 不断言「长度一模一样」—— 那条会随机变红：这是活系统，
  // bus 随时可能把一条 outbox 投进 orch:out，长度自然就涨了。
  // 「偶发」红也不能靠重跑到绿，要把断言写对：
  // 测试有能力删流、没能力给流写东西，所以**变长是正常的，变短或消失才是事故**。
  let intact = true;
  const damage = [];
  for (const s of PROD_STREAMS) {
    const now = { exists: await explicit.exists(s), len: await explicit.xlen(s).catch(() => 0) };
    if (before[s].exists === 1 && now.exists === 0) {
      intact = false;
      damage.push(`${s} 被删掉了`);
    } else if (now.len < before[s].len) {
      intact = false;
      damage.push(`${s} 变短了 ${before[s].len} → ${now.len}`);
    }
  }
  ok(intact, '★ 四个生产流一个没少（变长是活系统的正常呼吸，变短才是出事）', damage.join('; '));
  await explicit.del(canary);

  console.log('\n【5】★ 生产进程绝不能被误判（误判 = 整个系统静默失联）');
  // 不能直接跑 bin/next.js 来验 —— 它会**真的领走**一条消息，把人的话
  // 拖进 PEL 等 60 秒 autoclaim。测试不该有那种副作用。
  //
  // 改成起一个 test/ 之外的脚本，只问 createClient 连了哪个库。
  // 它落在 tmpdir，路径天然不等于 TEST_DIR —— 正好就是生产入口的处境。
  // ── 这一节分成**三条** ──────────────────────────────────────────────
  //
  //   「`test/` 之外一律判为生产」和「生产进程连 db 0」
  //   在 `createClient` 里其实是**两格**：
  //     `bin/` 下 ⇒ db 0（**生命线**）· 而 `bin//test/` 之外 ⇒ **判不出是什么**
  //   ⇒ ⇒ 一个落在 tmpdir 的探针演的是**后者**，验不了**前者**。
  //
  //   🔴 「生产进程仍然连 db 0 —— 隔离没有误伤生命线」那一条，
  //     探针要放到它真正描述的那个位置（`bin/` 下）。
  // ────────────────────────────────────────────────────────────────
  const binProbe = path.join(ROOT, 'bin', `engloop-isolation-binprobe-${process.pid}.js`);
  fs.writeFileSync(binProbe, `
    const q = require(${JSON.stringify(path.join(ROOT, 'lib', 'queue.js'))});
    const c = q.createClient();
    process.stdout.write(JSON.stringify({ db: c.options.db, isTest: q.isTestProcess() }));
    c.disconnect();
  `);
  let prodProbe;
  try {
    prodProbe = JSON.parse(execFileSync('node', [binProbe], { encoding: 'utf8' }));
  } finally {
    fs.rmSync(binProbe, { force: true });
  }
  ok(prodProbe.isTest === false, '★ test/ 之外的入口一律判为生产');
  ok(prodProbe.db === 0, '★ 生产进程仍然连 db 0 —— 隔离没有误伤生命线');

  console.log('\n【5c】🔴 而 `bin/` 和 `test/` **都不是**的入口 ⇒ 抛错，不给默认值');
  {
    // 要防的形状：一个 scratchpad 探针 `createClient()` 无参 ⇒ 落 db 0
    //   ⇒ 往生产库写房间，留下孤儿索引项。
    const strayProbe = path.join(os.tmpdir(), `engloop-stray-probe-${process.pid}.js`);
    fs.writeFileSync(strayProbe, `
      const q = require(${JSON.stringify(path.join(ROOT, 'lib', 'queue.js'))});
      try { const c = q.createClient(); process.stdout.write(JSON.stringify({ threw: false, db: c.options.db })); c.disconnect(); }
      catch (e) { process.stdout.write(JSON.stringify({ threw: true, msg: String(e.message) })); }
    `);
    let stray;
    try {
      stray = JSON.parse(execFileSync('node', [strayProbe], { encoding: 'utf8' }));
    } finally {
      fs.rmSync(strayProbe, { force: true });
    }
    ok(stray.threw === true,
      '★★ tmpdir 里的探针 ⇒ **抛错**，而不是静默落 db 0',
      JSON.stringify(stray).slice(0, 80));
    ok(stray.threw && stray.msg.includes('ENGLOOP_TEST_DB') && stray.msg.includes('bin/'),
      '★ 而错误消息里**带着出路** —— 响了之后有可执行的动作，否则它就是下一个恒真告警');

    // ── `node -e`：`require.main === undefined`，而这是最常用的那条路径 ──
    const eOut = execFileSync('node', ['-e', `
      const q = require(${JSON.stringify(path.join(ROOT, 'lib', 'queue.js'))});
      try { const c = q.createClient(); process.stdout.write('nothrow:' + c.options.db); c.disconnect(); }
      catch (e) { process.stdout.write('threw'); }
    `], { encoding: 'utf8' });
    ok(eOut === 'threw',
      '★★ `node -e`（`require.main` 是 undefined）⇒ **也抛** —— 这条单列，因为它是日常探针最常见的写法',
      eOut);
  }

  console.log('\n【5d】⚠️ `bin/` 下的入口 ＋ 残留的 `ENGLOOP_TEST_DB` ⇒ **连测试库，而且要响一声**');
  {
    // ── 这一格是一种静默事故形态 ──────────────────────────────────────
    //   ③（环境变量）排在 ④（bin/）之前是**有意**的：`ENGLOOP_TEST_DB=13 node bin/serve.js`
    //   正是那个变量存在的理由。
    //   🔴 而它的代价是：**生产入口 ＋ 环境里残留一个变量 ⇒ bus 静默连测试库**，
    //     日志上跟正常启动一模一样 —— 直到有人发现「消息发出去了，没有人收到」。
    //   ⇒ 处置：**不拒绝**（人工排查合法）· **不静默**（残留是事故）。
    //
    //   ⚠️ **两半都要断言** —— 只验「拿到了那个库」的话，一个**不打印**的实现也能过。
    const binEnvProbe = path.join(ROOT, 'bin', `engloop-binenv-probe-${process.pid}.js`);
    fs.writeFileSync(binEnvProbe, `
      const q = require(${JSON.stringify(path.join(ROOT, 'lib', 'queue.js'))});
      const c = q.createClient();
      process.stdout.write(String(c.options.db));
      c.disconnect();
    `);
    // ⚠️ 用 spawnSync 而不是 execFileSync：**stdout 和 stderr 要分开取** ——
    //   而这一格的两条断言，一条看 stdout（拿到哪个库）、一条看 stderr（有没有响）。
    let out = ''; let errText = '';
    try {
      const r = spawnSync('node', [binEnvProbe], {
        encoding: 'utf8', env: { ...process.env, ENGLOOP_TEST_DB: String(RESERVED.db) },
      });
      out = r.stdout || ''; errText = r.stderr || '';
    } finally {
      fs.rmSync(binEnvProbe, { force: true });
    }
    ok(String(out).trim() === String(RESERVED.db),
      '★ 生产入口 ＋ 设了变量 ⇒ **拿到那个库**（不拒绝 —— 人工排查是合法用法）', String(out));
    ok(errText.includes('生产入口') && errText.includes('unset'),
      '★★ **而且 stderr 响了一声** —— 只验上面那条的话，一个**不打印**的实现也能过',
      errText.slice(0, 90));
  }

  // ── 【5b】**先验那条出路** ──────────────────────────────────────────
  //
  //   `createClient` 有一条禁令：判不出是什么进程 ⇒ 抛错。
  //   而它给出的出路之一是「设 `ENGLOOP_TEST_DB`」——
  //   🔴 这条出路本身要有测试在用，否则没人知道它通不通。
  //
  //   > **给一条禁令配一条出路时，那条出路的可用性要先验，不能顺带假设 ——
  //   >   否则结果是「旧路被禁，而新路也不通」，比不加禁令更坏。**
  console.log('\n【5b】★ 出路先验：`test/` 下的入口 ＋ `ENGLOOP_TEST_DB` ⇒ 连到指定的那个库');
  {
    const envProbe = path.join(ROOT, 'test', 'fixtures', `engloop-envdb-probe-${process.pid}.js`);
    fs.writeFileSync(envProbe, `
      const q = require(${JSON.stringify(path.join(ROOT, 'lib', 'queue.js'))});
      const c = q.createClient();
      process.stdout.write(JSON.stringify({ db: c.options.db, isTest: q.isTestProcess() }));
      c.disconnect();
    `);
    try {
      const envProbeOut = JSON.parse(execFileSync('node', [envProbe], {
        encoding: 'utf8',
        env: { ...process.env, ENGLOOP_TEST_DB: String(RESERVED.db) },
      }));
      ok(envProbeOut.isTest === true,
        '（前提）探针在 `test/fixtures/` 下 ⇒ 判成测试进程', JSON.stringify(envProbeOut));
      ok(envProbeOut.db === RESERVED.db,
        `★★ 设了 \`ENGLOOP_TEST_DB=${RESERVED.db}\` ⇒ **真的连到 db ${RESERVED.db}**`
        + ' —— 这条是禁令的出路，先验它通',
        JSON.stringify(envProbeOut));
    } finally {
      fs.rmSync(envProbe, { force: true });
    }
  }

  // ── 【5e–5h】`ENGLOOP_TEST_DB` 抢锁 · `_JOIN` 加入 ──────────────────
  //
  //   这四条是同一个问题的四个面：`ENGLOOP_TEST_DB` 要是**不抢锁**，
  //   而 `createClient` 又会 `flushdb` ⇒ **别人正用着的库，被一个探针清空**。
  //   而它正是禁令消息里**推荐的第一条出路** ——
  //   不抢锁的话，就是禁掉了「污染」，推荐了「清空」。
  //
  //   ★ 四条必须成对出现，缺哪一半哪一半就恒真：
  //     5e 抢得到 ⇒ 拿到      /  5f 已被占 ⇒ **抛**（只有 5e 的话，一个从不抢锁的实现全绿）
  //     5g JOIN 到活锁 ⇒ 拿到 **且数据还在** / 5h JOIN 到空位 ⇒ **抛**
  //     ⚠️ 5g 的「**且数据还在**」是这四条里最容易漏的一半 ——
  //        只验「拿到那个库」的话，**一个照样 flushdb 的实现也能过**。
  //
  //   ⚠️ 号从 `RESERVED.db` 来（文件头那个预约）——**不写死**。
  //     「1 号最后才被别人拿走」只对**别的测试自动分配**成立，
  //     🔴 它**看不见另一个 `isolation.test.js` 实例** —— 后者要是写死同一个 1，
  //       跟扫描顺序毫无关系。
  console.log('\n【5e–5h】★★ `ENGLOOP_TEST_DB` 抢锁 · `_JOIN` 加入（而**加入者不许清库**）');
  {
    const D = RESERVED.db;
    const lockFile = q.testDbLockPath(D);   // ★ 不再自己拼路径：第二份实现会漂
    const dbUrl = `redis://127.0.0.1:6379/${D}`;
    const lockProbe = path.join(ROOT, 'test', 'fixtures', `engloop-lock-probe-${process.pid}.js`);
    fs.writeFileSync(lockProbe, `
      const q = require(${JSON.stringify(path.join(ROOT, 'lib', 'queue.js'))});
      (async () => {
        let c;
        try {
          c = process.env.PROBE_URL ? q.createClient(process.env.PROBE_URL) : q.createClient();
        } catch (e) {
          process.stdout.write(JSON.stringify({ threw: String(e.message).slice(0, 200) }));
          return;
        }
        try {
          if (process.env.PROBE_SET) await c.set('__join_canary__', process.env.PROBE_SET);
          const v = await c.get('__join_canary__');
          process.stdout.write(JSON.stringify({ db: c.options.db, canary: v }));
        } finally { c.disconnect(); }
      })();
    `);
    const run = (env) => {
      const r = spawnSync('node', [lockProbe], {
        encoding: 'utf8',
        env: { ...process.env, ENGLOOP_TEST_DB: '', ENGLOOP_TEST_DB_JOIN: '', ...env },
      });
      try { return JSON.parse(r.stdout || '{}'); } catch (_) { return { raw: `${r.stdout || ''}${r.stderr || ''}`.slice(0, 160) }; }
    };
    try {
      // 【5e】没人占着 ⇒ 抢得到
      fs.rmSync(lockFile, { force: true });
      const r5e = run({ ENGLOOP_TEST_DB: String(D) });
      ok(r5e.db === D,
        '【5e】没人占着 ⇒ `ENGLOOP_TEST_DB=1` **抢得到**，拿到 db 1', JSON.stringify(r5e));

      // 【5f】🔴 被一个**活**进程占着 ⇒ 抛。锁里写本进程的 pid ⇒ 它一定不陈旧。
      fs.writeFileSync(lockFile, String(process.pid));
      const r5f = run({ ENGLOOP_TEST_DB: String(D) });
      ok(typeof r5f.threw === 'string' && r5f.threw.includes('正被别的进程占着'),
        '【5f】🔴 锁已被占 ⇒ **抛，而不是静默共用** —— 这一条守的正是要防的那件事本身',
        JSON.stringify(r5f).slice(0, 130));

      // 【5g】★★★ `_JOIN` 到那把活锁：拿得到，**而且库没被清空**
      //   种子用**显式 url**（第①格，从不清库）写进去 ⇒ 于是这一格断言的
      //   是 `_JOIN` 那条路的清库行为，不掺别的。
      const seeded = run({ PROBE_URL: dbUrl, PROBE_SET: 'alive-1787' });
      ok(seeded.canary === 'alive-1787',
        '（前提）显式 url 往 db 1 写了一个 canary —— 而显式 url 不清库',
        JSON.stringify(seeded));
      const r5g = run({ ENGLOOP_TEST_DB_JOIN: String(D) });
      ok(r5g.db === D,
        '【5g】`_JOIN=1` 到一把**活锁** ⇒ 拿到 db 1', JSON.stringify(r5g));
      ok(r5g.canary === 'alive-1787',
        '【5g】★★★ **而 canary 还在** ⇒ 加入者**没有清库** —— 只验上面那条的话，'
        + '一个照样 flushdb 的实现也能过', JSON.stringify(r5g));

      // 【5i】★ 而 `bin/` 下的入口 ＋ **_JOIN** ⇒ 拿到那个库，**而且不响那一声**
      //   跟【5d】成对：5d 断言「`ENGLOOP_TEST_DB` ⇒ **响**」，5i 断言「_JOIN ⇒ **不响**」。
      //   🔴 只有 5i 的话，一个**从不打印**的实现全绿；只有 5d 的话，一个
      //     **见测试库就打印**的实现全绿 —— 而后者会让 protocol-layering
      //     每跑一遍打两条修不掉的告警。**两条一起才钉得住「什么时候该响」。**
      const binJoinProbe = path.join(ROOT, 'bin', `engloop-binjoin-probe-${process.pid}.js`);
      fs.writeFileSync(binJoinProbe, `
        const q = require(${JSON.stringify(path.join(ROOT, 'lib', 'queue.js'))});
        const c = q.createClient();
        process.stdout.write(String(c.options.db));
        c.disconnect();
      `);
      try {
        fs.writeFileSync(lockFile, String(process.pid));   // 造一把活锁给它加入
        const rj = spawnSync('node', [binJoinProbe], {
          encoding: 'utf8',
          env: { ...process.env, ENGLOOP_TEST_DB: '', ENGLOOP_TEST_DB_JOIN: String(D) },
        });
        ok(String(rj.stdout || '').trim() === String(D),
          '【5i】`bin/` 下的入口 ＋ `_JOIN` ⇒ 拿到 db 1（子进程要跟父进程同库）',
          String(rj.stdout || '').slice(0, 60));
        ok(!String(rj.stderr || '').includes('生产入口'),
          '【5i】★★ **而它不响那一声** —— 这里没人能 unset 那个变量（它是子进程正常工作的条件）'
          + '⇒ 响了就是恒真告警。而残留形态由【5h】守着（锁没了 ⇒ 抛）',
          String(rj.stderr || '').slice(0, 90));
      } finally {
        fs.rmSync(binJoinProbe, { force: true });
      }

      // 【5h】🔴 `_JOIN` 到一个没人占的编号 ⇒ 抛（不能默默开一间）
      fs.rmSync(lockFile, { force: true });
      const r5h = run({ ENGLOOP_TEST_DB_JOIN: String(D) });
      ok(typeof r5h.threw === 'string' && r5h.threw.includes('没有任何进程占着'),
        '【5h】🔴 `_JOIN` 到空位 ⇒ **抛** —— 默默开一间就退回成「不抢锁就用」',
        JSON.stringify(r5h).slice(0, 130));
    } finally {
      // 收尾：锁和 canary 都是这一格造出来的，都得还回去。
      fs.rmSync(lockFile, { force: true });
      spawnSync('node', ['-e', `const R=require('ioredis');const c=new R(${JSON.stringify(dbUrl)});c.del('__join_canary__').then(()=>c.quit());`],
        { cwd: ROOT, encoding: 'utf8' });
      fs.rmSync(lockProbe, { force: true });
    }
  }

  // ── 【6a/6b】两个根可以被环境变量覆盖 ────────────────────────────────
  //
  //   `lib/watchdog.js` 的 OUTBOX_ROOT 和 `lib/relay.js` 的 DEADLETTER_ROOT
  //   默认是 `temp/<x>`，跟仓库里同一条惯例的其余几个一样可以覆盖
  //   （`ENGLOOP_OUTBOX_ROOT` / `_HISTORY_ROOT` / `_OUTPUTS_ROOT` / `_THREAD_ALERT_DIR`）。
  //
  //   ⚠️ **两半都要验**：只验「设了变量 ⇒ 用它」的话，一个**永远用环境变量、
  //     没设就返回 undefined** 的实现也能过；而那会让生产悄悄写到别处。
  //     所以「**没设 ⇒ 仍然是原路径**」那一半是这里真正的保护。
  console.log('\n【6a/6b】★ `ENGLOOP_OUTBOX_ROOT` / `ENGLOOP_DEADLETTER_ROOT` 可覆盖，而默认不变');
  {
    const rootProbe = path.join(ROOT, 'test', 'fixtures', `engloop-roots-probe-${process.pid}.js`);
    fs.writeFileSync(rootProbe, `
      const w = require(${JSON.stringify(path.join(ROOT, 'lib', 'watchdog.js'))});
      const r = require(${JSON.stringify(path.join(ROOT, 'lib', 'relay.js'))});
      process.stdout.write(JSON.stringify({ outbox: w.OUTBOX_ROOT, deadletter: r.DEADLETTER_ROOT }));
    `);
    const read = (env) => {
      const res = spawnSync('node', [rootProbe], {
        encoding: 'utf8',
        env: { ...process.env, ENGLOOP_OUTBOX_ROOT: '', ENGLOOP_DEADLETTER_ROOT: '', ...env },
      });
      try { return JSON.parse(res.stdout || '{}'); } catch (_) { return { raw: `${res.stdout || ''}${res.stderr || ''}`.slice(0, 160) }; }
    };
    try {
      const set = read({ ENGLOOP_OUTBOX_ROOT: '/tmp/engloop-probe-outbox',
                         ENGLOOP_DEADLETTER_ROOT: '/tmp/engloop-probe-deadletter' });
      ok(set.outbox === '/tmp/engloop-probe-outbox',
        '【6a】设了 `ENGLOOP_OUTBOX_ROOT` ⇒ watchdog 用它', JSON.stringify(set));
      ok(set.deadletter === '/tmp/engloop-probe-deadletter',
        '【6b】设了 `ENGLOOP_DEADLETTER_ROOT` ⇒ relay 用它', JSON.stringify(set));

      const unset = read({});
      ok(unset.outbox === path.join(ROOT, 'temp', 'outbox'),
        '【6a】★★ **没设 ⇒ 仍然是 `temp/outbox`** —— 只验上面那条的话，一个永远读环境变量的实现也能过',
        JSON.stringify(unset));
      ok(unset.deadletter === path.join(ROOT, 'temp', 'deadletter'),
        '【6b】★★ **没设 ⇒ 仍然是 `temp/deadletter`**（同上，这一半才是生产的保护）',
        JSON.stringify(unset));
    } finally {
      fs.rmSync(rootProbe, { force: true });
    }
  }

  // ── 【6c】watchdog 的三个测试文件：**不许直接调 `check()`** ─────────────
  //
  //   直接调 `watchdog.check(redis, {…})` 而不传 `outboxRoot`
  //   ⇒ 读的是**生产** `temp/outbox/`。所以每个文件一个包装器 `wdCheck()`，
  //   它无条件塞一个 `os.tmpdir()` 下的空目录进去。
  //
  //   🔴 而这一条是**存在型**的（数源码里的调用点），不是效果型 —— 如实标着：
  //     它挡的是「以后有人又写了一个直接调用」，**挡不住**「包装器里那个 root 写错了」。
  //     效果型的那半没有：`check()` 读没读生产目录，这件事在测试外面观测不到。
  //
  //   ⚠️ 数的时候**要跳过注释行** —— 不跳的话，注释里提到的
  //     `watchdog.check()` 会被算成调用点，得出假红。
  console.log('\n【6c】★ watchdog 三个测试文件里，直接调用只剩包装器那一处');
  {
    const files = ['watchdog.test.js', 'watchdog-liveness.test.js', 'watchdog-orphan-pel.test.js'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))          // 跳过注释行
        .join('\n');
      const direct = (src.match(/\b(?:wd|watchdog)\.check\(/g) || []).length;
      const viaWrapper = (src.match(/\bwdCheck\(/g) || []).length;
      ok(direct === 1,
        `【6c】${f}：非注释的直接调用 = ${direct}（只该剩包装器那一处）`, String(direct));
      ok(viaWrapper >= 2,
        `【6c】${f}：确实有调用走包装器（${viaWrapper} 处）—— 否则「只剩 1 处」可能是因为它一次都不调`,
        String(viaWrapper));
    }
  }

  // ── 【6d】那份生产快照里的测试产物，不许落进被断言的那一段 ──────────
  //
  //   `test/fixtures/orch-out-48h.json` 是**生产** orch:out 的 48 小时快照 ——
  //   而它继承了生产当时的状态：**294 条里 20 条是 e2e/自动化测试产物**（`_provenance`）。
  //
  //   🔴 那份清单不能用**内容 grep** 生成 —— 它分不出「**在用**这些词」和
  //       「**在谈论**这些词」：编排者发给用户的真消息里也会提到 Playwright / 自动化测试。
  //       ⇒ ⇒ 照内容清单去清理，会删掉真实生产消息。
  //     ★ 所以下面不只验「清单非空」，而是把清单钉在一个**可推导**的性质上。
  //   而 `test/e2e-signal-layering.playwright.js` 拿它的 `longestDupRun` 做断言。
  //
  //   ⚠️ 「污染没碰到那一串」靠人工核对的话，**有效期只到下一次有人改那份夹具为止**。
  //     这条判据把它变成会自己红的东西。
  //
  //   ★ 而第一条断言（**重算 == 声明值**）不是凑数：如果这里算「重复串」的口径跟
  //     写那个值的人不是同一个，那下面那个「区间」就指着错的地方，
  //     而「零重叠」这个结论**照样能算出来** —— 一个碰巧对的结论。
  console.log('\n【6d】★ 生产快照里的测试产物 vs 被断言的那一段重复串');
  // ★ 公开版里没有这份真实快照，也没有读它的那个 e2e —— 两个**都**不在才跳过。
  //   只缺快照、而读它的 e2e 还在 ⇒ 不跳，照常读 ⇒ 红在 ENOENT 上（快照不能默默丢掉）。
  const FX6D = path.join(ROOT, 'test/fixtures/orch-out-48h.json');
  const FX6D_USER = path.join(ROOT, 'test/e2e-signal-layering.playwright.js');
  if (!fs.existsSync(FX6D) && !fs.existsSync(FX6D_USER)) {
    console.log('  （跳过：快照和读它的 e2e 都不在 —— 公开版就是这样）');
  } else {
    const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/orch-out-48h.json'), 'utf8'));
    const ms = FX.messages;
    let best = [0, 0, 0];
    for (let i = 0; i < ms.length;) {
      let j = i;
      while (j + 1 < ms.length && ms[j + 1].text === ms[i].text) j += 1;
      if (j - i + 1 > best[0]) best = [j - i + 1, i, j];
      i = j + 1;
    }
    const [runLen, from, to] = best;
    ok(runLen === FX.longestDupRun,
      `【6d】（前提）重算的最长重复串 = 声明值 ${FX.longestDupRun} —— 口径一致，下面那个区间才指得对`,
      String(runLen));
    const idx = (FX._provenance || {}).test_artifact_indices || [];
    ok(idx.length > 0,
      `【6d】_provenance 里确实列了测试产物（${idx.length} 条）—— 否则「零重叠」可能只是因为清单是空的`,
      String(idx.length));

    // 🔴 而「非空」太弱：**一份只剩 1 条的清单也过**。把它钉在一个可推导的性质上，
    //   于是清单漂了会红，而不是只在「空了」的时候红。
    const derived = ms.map((m, k) => [k, m])
      .filter(([, m]) => String(m.text || '').startsWith('【自动化测试'))
      .map(([k]) => k);
    const diff = [...idx.filter((k) => !derived.includes(k)),
      ...derived.filter((k) => !idx.includes(k))];
    ok(JSON.stringify(idx) === JSON.stringify(derived),
      `【6d】🔴 ★ 清单 == 结构口径推导出的集合（${derived.length} 条）——`
      + '**双向**：多一条、少一条都红',
      JSON.stringify(diff));

    // ★ 第二个口径：**时间**，跟内容完全无关 —— 脚本连着发，间隔以秒计；
    //   而真消息之间是分钟到小时。两个口径的失效模式不同 ⇒ 这才算复验。
    const tight = [];
    for (let k = 1; k < ms.length; k += 1) {
      const gap = ms[k].at - ms[k - 1].at;
      if (gap >= 0 && gap < 5000) tight.push(k);
    }
    ok(tight.length > 0 && tight.every((k) => idx.includes(k)),
      `【6d】★ 第二个口径：间隔 < 5 秒的 ${tight.length} 条**全部落在清单里** —— `
      + '而它跟内容无关',
      JSON.stringify(tight.filter((k) => !idx.includes(k))));

    // ★ ＋ 把数字本身也钉住：重新抓一份快照时这条会红 ——
    //   **而那正是要的**：新快照要重新分类，不能沿用旧清单。
    ok(idx.length === 20,
      '【6d】清单是 **20** 条（用结构 ＋ 时间两个口径定的）—— '
      + '重新抓快照时它会红，而那时要做的是**重新分类**，不是改这个数',
      String(idx.length));

    const inside = idx.filter((k) => k >= from && k <= to);
    ok(inside.length === 0,
      `【6d】★★ 那 ${idx.length} 条测试产物**没有一条**落在被断言的 [${from}, ${to}] 里`,
      JSON.stringify(inside));
  }

  // ── 【7】`bin/heartbeat.js` —— 位置给它 db 0，而它创造不出任何记录 ────────
  //
  //   它在 `bin/` 下 ⇒ 拿到**生产库**。而判据要验它，就不能让 `test/` 下的代码
  //   自己去连 db 0 —— 所以：**spawn 它，读它的 stdout**（它写完自己回查 ttl）。
  //
  //   🔴 而「它创造不出记录」这一条是这里最要紧的：它调 `roster.heartbeat` 时
  //     **不传 info** ⇒ 不在册就 `need_info` ⇒ 什么都不写。
  //     ⇒ ⇒ 所以下面这条判据可以拿一个**不存在的名字**去跑真的生产入口，
  //       而生产花名册一个字节都不多 —— 而那一点本身要断言，不能只是相信。
  console.log('\n【7】★ `bin/heartbeat.js`：只续期，创造不出记录');
  {
    const HB = path.join(ROOT, 'bin', 'heartbeat.js');
    const prod = q.createClient(PROD_URL);
    try {
      const before = (await prod.keys('engloop:roster:*')).length;
      const r1 = spawnSync('node', [HB, '__nosuchagent_probe__'], { encoding: 'utf8' });
      const out1 = String(r1.stdout || '').trim();
      const after = (await prod.keys('engloop:roster:*')).length;
      ok(/need_info/.test(out1),
        '【7a】不在册的名字 ⇒ **need_info**（它连自愈重建那条路都走不到）', out1.slice(0, 80));
      ok(after === before,
        `【7b】★★★ 而**生产花名册一个都没多**（${before} → ${after}）—— 这一条才是它敢连 db 0 的理由`,
        `${before} → ${after}`);

      // ★ 阴性对照：不在 tmux 里 ⇒ **什么都不做，而且说出口**
      //   （「什么都没做」和「坏了」的退出码都是 0 ⇒ 判别量只能是那句话）
      const r2 = spawnSync('node', [HB], {
        encoding: 'utf8',
        env: { ...process.env, TMUX: '', TMUX_PANE: '' },
      });
      const out2 = String(r2.stdout || '').trim();
      ok(/未刷心跳/.test(out2),
        '【7c】不在 agent 的 tmux 会话里 ⇒ **说出口**（退出码分不开「没做」和「坏了」）',
        out2.slice(0, 80));
      ok(!/renewed/.test(out2),
        '【7d】而那一次**没有 renewed** —— 只验上面那句话的话，一个「打印完照样刷」的实现也能过',
        out2.slice(0, 80));
    } finally {
      prod.disconnect();
    }
  }

  console.log('\n【★危】`test/` 的子目录也必须被判成测试进程');
  {
    // ── 判「测试进程」不能只看 `path.dirname(main) === TEST_DIR` ──────────
    //   探针放在 **`test/fixtures/`** 时 `dirname` 是 `test/fixtures`，
    //   **不等于** `test`，于是它被判成**生产进程**、连了 db 0，
    //   然后 `redis.del(..., 'orch:in:agent')` 会把 JARVIS 的未读消息全删了。
    //
    // > **一个「在 test 目录下就算测试」的判据，对 `test/` 的子目录不成立。
    // >   而它的失败方向恰好最坏：判成生产 → 连生产库 → 而且不报错。**
    //
    //   ⚠️ `test/fixtures/` 下放探针是**完全正常的做法** —— 所以修的是判据本身，
    //   不是「以后小心点」。**「小心点」和「让下一个人不用小心」是两回事。**
    // ────────────────────────────────────────────────────────────────
    const inFixtures = path.join(ROOT, 'test', 'fixtures', 'whatever-probe.js');
    ok(q.isTestProcess(inFixtures) === true,
      '★★ `test/fixtures/` 下的文件判成测试进程（这条红过一次，代价是一条收件流）');

    const deeper = path.join(ROOT, 'test', 'fixtures', 'nested', 'deep.js');
    ok(q.isTestProcess(deeper) === true, '★ 更深的子目录也算');

    ok(q.isTestProcess(path.join(ROOT, 'test', 'queue.test.js')) === true,
      'test/ 本身照旧（子目录的判定没有弄坏 test/ 本身）');

    // ★ 阴性对照：**前缀相同但不在里面的目录不许放行**。
    //   用 `startsWith(TEST_DIR)` 而不带分隔符的话，`test-backup/` 会被放进来 ——
    //   跟 `workers-backup/` 那条同一个坑。
    ok(q.isTestProcess(path.join(ROOT, 'test-backup', 'x.js')) === false,
      '★★ `test-backup/` 不算测试目录（前缀相同 ≠ 在里面）');
    ok(q.isTestProcess(path.join(ROOT, 'lib', 'queue.js')) === false,
      '★ 阴性对照：lib/ 下的仍然判生产（不是「一律算测试」）');
    ok(q.isTestProcess(path.join(ROOT, 'bin', 'serve.js')) === false,
      '★ 阴性对照：bin/ 入口仍然判生产 —— 那是生命线，绝不能被隔离误伤');
  }

  console.log('\n【★】架构级守卫：主连接不许跑阻塞命令');
  {
    // ── 它守的不是行为，是「哪条连接被用在哪里」 ──────────────────────
    // `bin/serve.js` 的约定是「redis = 普通命令 / blocking = 阻塞读」。
    // **只写在注释里的约定挡不住新代码**：比如内部
    // `claimNext(redis, {blockMs:5000})` 会把主连接独占，
    // `/health`、`/api/agents` 变慢甚至超时，
    // **而 /api/agents 是唯一「一眼看出失聪」的路。**
    //
    // ⚠️ **约定不是机制** —— 所以这里用守卫钉住它。
    //
    // ★ 普通单测测不出这类问题，**因为每个函数单独看都对** ——
    //   `claimNext` 对、`startPool` 对、传参也对，错的是连接的用途。
    // ────────────────────────────────────────────────────────────────
    const guarded = q.nonBlockingOnly(q.createClient(), 'probe');

    // ① 带 BLOCK 参数的 xreadgroup → 抛
    let threw = null;
    try {
      await guarded.xreadgroup('GROUP', 'g', 'c', 'BLOCK', '5000', 'STREAMS', 's', '>');
    } catch (e) { threw = e; }
    ok(threw !== null, '★ 主连接跑 XREADGROUP ... BLOCK → 抛错');
    ok(threw && /不许跑阻塞命令/.test(threw.message),
      '★ 错误信息直说原因（不是一个泛型 TypeError）', threw && threw.message.slice(0, 60));
    ok(threw && /q\.createClient/.test(threw.message),
      '★ 而且给出下一步动作（自己开一条），不只是拒绝');

    // ② 原生阻塞命令 → 抛（不带 BLOCK 参数，靠命令名认）
    let threw2 = null;
    try { await guarded.blpop('k', 0); } catch (e) { threw2 = e; }
    ok(threw2 !== null && /不许跑阻塞命令/.test(threw2.message),
      '★ BLPOP 这类原生阻塞命令也拦（它没有 BLOCK 参数）');

    // ③ ★ 阴性对照：**不带 BLOCK 的 xreadgroup 要放行**。
    //    没有这条的话，「一律拦 xreadgroup」的实现也能过上面两条 ——
    //    而那会把非阻塞的领取也拦死，比原来的问题更糟。
    const stream = 'guardprobe';
    await guarded.del(stream);
    await q.ensureGroup(guarded, stream, 'g');
    await q.send(guarded, stream, { from: 't', text: 'x' });
    let noBlockOk = true;
    try {
      await guarded.xreadgroup('GROUP', 'g', 'c', 'COUNT', '1', 'STREAMS', stream, '>');
    } catch (_) { noBlockOk = false; }
    ok(noBlockOk, '★ 阴性对照：不带 BLOCK 的 XREADGROUP 正常放行');

    // ④ 阴性对照：普通命令一概不受影响
    await guarded.set('guardprobe:k', 'v');
    ok((await guarded.get('guardprobe:k')) === 'v', '★ 阴性对照：GET/SET 照常工作');
    ok(typeof guarded.options === 'object' && guarded.options.db === q.allocTestDb(),
      '★ 非函数属性（options.db）也读得到 —— 代理没挡住它');

    await guarded.del(stream, 'guardprobe:k');
    await guarded.quit();
  }

  console.log('\n【★b】接线：bus 的主连接真的被包了，pool 有自己的连接');
  {
    // 上面那节验的是守卫本身好不好用；这节验**它真的被用在了 serve.js 里**。
    // 前提不同：守卫可以完美无缺而没人用它。
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'serve.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(/nonBlockingOnly\(\s*q\.createClient\(\)/.test(src),
      '★ 主连接包了 nonBlockingOnly');
    ok(!/startPool\(redis\b/.test(src),
      '★★ 没有把主连接传给 startPool（池会用阻塞命令独占它）');
    ok(/poolClients/.test(src),
      '★ 池有自己的连接（每池一条 —— 共用一条还是会互相排队）');
    ok(/poolClients\.map\(\(c\) => c\.quit\(\)\)/.test(src),
      '关停时也收池的连接（漏掉会让优雅关停变成超时强杀）');
  }

  console.log('\n【6】★★★ 同一条规矩的文件系统版：agent 状态文件不许写进生产 temp/');
  // ── 同一类问题，载体是文件 ────────────────────────────────────────
  //   `lib/thread-alert.js` 的状态文件默认落在 `temp/thread-alert-<name>.json`，
  //   而写它的是 **relay —— 中心进程**。测试一跑 `startRelay`，要是写进
  //   **JARVIS 的生产状态文件**，它下一轮就会收到一堆**假阳性**告警。
  //   > 而那个告警的全部资产就是可信 —— 它不修任何东西，它只说一句话；
  //   >   假阳性多了，读的人就学会忽略它。
  //
  // ⚠️ 那个模块有 `dir` 参数和 env 逃生口，但不能指望每个测试调用方都记得传 ——
  //   这正是本文件开头那句话（「靠人记得是不行的」）在文件系统上的复刻。
  //   ⇒ 修法同样是下沉：默认值自己认出测试进程，不传任何东西也污染不了。
  {
    const ta = require('../lib/thread-alert');
    const prodRoot = path.resolve(path.join(ROOT, 'temp'));

    // 【1】已经证明本进程算测试进程，所以这里拿到的就是「测试该去的地方」。
    const mine = path.resolve(ta.statePath('JARVIS'));
    ok(path.dirname(mine) !== prodRoot,
      '★★★ 测试进程里，JARVIS 的状态文件**不落在生产 temp/ 根下**', mine);
    ok(mine.startsWith(prodRoot + path.sep),
      '仍在 temp/ 底下（隔离的是「哪个文件」，不是「哪块盘」——方便一起清理）', mine);

    // ★★ 阴性对照：**真的跑一个生产入口**，证明它确实会落在生产位置。
    //   同【4】的风格——不是推理，是实际执行。没有这一条，上面两条可能只是
    //   「两个路径长得不一样」，而判据本身是恒真的死条件。
    //
    // ⚠️ 探针脚本必须放在 `test/` **外面**：`test/fixtures/` 也算测试进程
    //   （见【★危】那节），放进去就测不到生产分支了。
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-prodentry-'));
    const probeFile = path.join(probeDir, 'prod-entry.js');
    fs.writeFileSync(probeFile,
      `const ta = require(${JSON.stringify(path.join(ROOT, 'lib', 'thread-alert.js'))});\n`
      + 'process.stdout.write(ta.statePath("JARVIS"));\n');
    const r = spawnSync('node', [probeFile], {
      encoding: 'utf8',
      // 清掉逃生口：这一条要验的是**没有任何人传参数时**的默认行为。
      env: { ...process.env, ENGLOOP_THREAD_ALERT_DIR: '' },
    });
    const prodPath = path.resolve((r.stdout || '').trim());
    ok(path.dirname(prodPath) === prodRoot,
      '★★ 对照：生产入口（test/ 外面）确实落在 temp/ 根下 —— 所以上面那条不是恒真',
      `${r.status !== 0 ? `exit ${r.status} ${r.stderr}` : prodPath}`);
    ok(prodPath !== mine,
      '★★★ 两者确实是两个不同的文件 —— 测试写自己那份，碰不到生产那份');
    fs.rmSync(probeDir, { recursive: true, force: true });
  }

  await auto.quit();
  await explicit.quit();

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
