'use strict';

/**
 * 核心队列模块 —— 整个 EngLoop 的地基。
 *
 * v1 的 claudecode_next.js 用 419 行手写的队列语义
 * （PID 锁 / 读后删占位 / 僵尸锁探活 / 突发窗口 / 优先级排序），
 * 在 Redis Streams 下坍缩成一行：
 *
 *     XREADGROUP GROUP orch orch-1 BLOCK 594000 COUNT 50 STREAMS orch:in:human >
 *
 *   BLOCK  = 长轮询        COUNT = 突发批量 drain
 *   GROUP  = 单消费者锁     流的先后 = 优先级
 *
 * 本模块只暴露 claim / ack / send / autoclaim 四个原语，
 * Bash-blocking 适配器和 MCP 适配器都是它的薄包装。
 */

const Redis = require('ioredis');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const DEFAULTS = {
  url: process.env.ENGLOOP_REDIS_URL || 'redis://127.0.0.1:6379',
  blockMs: 594000, // 9.9 分钟，配 600s Bash timeout。别随意改
  count: 50,
};

// ── 测试与生产的物理隔离 ────────────────────────────────────────
//
// 测试碰到生产流的形态很多：抢消息、清 orch:out、测试之间共享流、
// del 掉 orch:in:human / orch:in:agent / deadletter。
//
// 收件流连同消费者组一起被删时，编排者会失聪：next.js 每次 exit 1，
// 而协议要求它立刻重跑 —— 于是变成一个看起来很忙、实际一条消息
// 也收不到的活锁。
//
// 逐处去修靠的是人记得，下一个新写的测试照样能踩。所以做成
// 物理隔离：测试进程连测试库（1–15），生产留在 db 0，测试想删也够不着。
// 对以后新写的测试自动生效，不需要任何人记得任何事。
//
// ⚠️ 判定必须**保守到宁可漏**。反向误判 —— 把生产进程认成测试、连去
// db 15 —— 比原问题严重得多：那是整个系统静默失联，没有任何报错。
// 所以只认「入口脚本正好躺在本仓库的 test/ 目录里」这一种情况，
// bin/ 下的东西永远不匹配；拿不到入口（REPL、-e）时一律算生产。
const TEST_DIR = path.join(__dirname, '..', 'test');
const BIN_DIR = path.join(__dirname, '..', 'bin');

// 测试库的**默认/回退**编号。测试进程会各自抢一个编号
// （见下面的 allocTestDb），这个常量只在 ENGLOOP_TEST_DB 显式
// 指定时才是最终答案。
const TEST_DB = Number(process.env.ENGLOOP_TEST_DB || 15);

// ── 测试与测试之间的隔离 ────────────────────────────────────────
//
// 上面那层解决了「测试 vs 生产」。它没解决「测试 vs 测试」：两个进程同时
// npm test，就在 db 15 里搅动同一批流名，谁先谁后随机。后果不是「偶尔
// 失败」，是**制造假红和假绿，让验收本身不可信** —— 正确的代码会被判成有问题。
//
// 所以每个测试进程抢一个自己的库（1–15），生产的 0 号谁也碰不到。
//
// ⚠️ 为什么是文件锁而不是 redis SETNX（三个独立理由）：
//   1. createClient 是**同步**函数，而 db 编号必须在 new Redis(url) 那一刻
//      就定下来（它编码在 url 里）。SETNX 是异步的，塞不进去。改成 async
//      要动所有调用点，包括生产入口 bin/ 下的东西 —— 为一个测试设施去改
//      生命线的调用形状，风险和收益不成比例。
//   2. 「先同步建 client、抢占完成后再 select」这个折中更糟：抢占返回之前
//      调用方发出的命令会打在默认库上，**而且不报错**。那正是本模块在消灭
//      的那类隐形错误。
//   3. 释放要挂在 process.on('exit') 上，而 exit 回调**只能跑同步代码** ——
//      异步的 SETNX/DEL 发不出去就被 exit 掉了。文件锁的 unlinkSync 正好同步。
//
// ⚠️ 这里用 `process.kill(pid, 0)` 探活，而**花名册的设计明确不用 PID 探活**
//    （"Roster via TTL heartbeat, not sibling-dir scan + PID probe"）。
//    两者不矛盾，是两个场景：
//      · 花名册 —— bus 要判断一个 agent 还在不在，而那个
//        agent 是别的 tmux 会话里的 claude 进程，bus 既拿不到它的 pid 也
//        追不动它，只能靠 TTL 心跳。
//      · 这里是**同一台机器上的测试进程抢一个本地资源**，pid 就写在锁文件
//        里、就在同一台机器上，kill(pid,0) 是直接可靠的事实查询。
//    进程死没死是实时的事实，不是超时推断 —— 能问就别猜。
//    但 pid 会被复用：崩溃进程的号被无关进程占了的话，探活会一直说「活着」，
//    那个库就永久漏了。所以再叠一层 mtime 陈旧判定兜底 —— 而持有者会定期
//    touch 自己的锁（见 releaseOnExit 里的心跳），所以 mtime 超时的必然是
//    已经死掉的进程。**没有那个心跳，mtime 就不是兜底而是上限**：跑满
//    15 分钟的活进程会被抢掉库，两边静默共用。
//
// 跨机器不行（锁在本地 tmpdir）。这是接受的代价：部署形态是一台常开的
// 机器，没有跨机跑测试的场景，db 编号本来也是「这台 redis 的这 15 个库」。
const TEST_DB_MIN = 1;
const TEST_DB_MAX = 15;

// 跟 roster.TTL_SEC 一个量级，有先例可循。持有者每 1/3 个周期 touch 一次，
// 所以这个数衡量的是「多久没有心跳算死」，不是「测试最多能跑多久」。
const LOCK_STALE_MS = 900_000;

/** 编号校验单独成函数：两个入口（TEST_DB / _JOIN）要给出一样的拒绝，别写两遍。 */
function assertDbNumber(n, varName) {
  if (!Number.isInteger(n) || n < TEST_DB_MIN || n > TEST_DB_MAX) {
    throw new Error(
      `${varName}=${process.env[varName]} 不是 ${TEST_DB_MIN}–${TEST_DB_MAX} 之间的整数。`
      + ' db 0 是生产库，永远不能从这里进去。',
    );
  }
}

function testDbLockPath(db) {
  return path.join(os.tmpdir(), `engloop-testdb-${db}.lock`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);   // 信号 0 = 只探测，不真发信号
    return true;
  } catch (err) {
    // EPERM = 进程存在，只是不归当前用户管。存在就算活着。
    return err.code === 'EPERM';
  }
}

/** 锁是不是可以抢走：写锁的进程已经死了，或者锁老到 pid 可能已被复用。 */
function lockIsStale(file) {
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) return true;
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    // ★ 读不出有效 pid ≠ 陈旧。
    //   直接写 `!pidAlive(Number(''))` 的话，空内容算出 pid=0，判成
    //   「进程已死」，于是把别人的锁删了抢走 —— **两个进程拿到同一个库**，
    //   正是这套机制要防的那件事。
    //   （下面的 link 占位已经消除了「文件已建、内容未写」的窗口，这一条
    //     是第二层保险：拿不准就当被占用，交给 mtime 兜底，别猜。）
    if (!Number.isInteger(pid) || pid <= 0) return false;
    return !pidAlive(pid);
  } catch (_) {
    return true;   // 读不到（多半是刚被别人清掉）→ 当它不存在
  }
}

/**
 * 原子占位：先把 pid 写进临时文件，再 link 到锁名上。
 *
 * ★ 为什么不用 `fs.openSync(file, 'wx')`：那个调用本身是原子的，但
 *   「文件出现」和「pid 写进去」之间有一个窗口 —— 另一个进程在这个窗口里
 *   读到的是**空文件**，于是两个并发进程会抢到同一个库。
 *   link 的目标一出现，内容就已经是完整的，没有那个窗口。
 *
 * @returns {boolean} 抢到了没有
 */
function tryClaimLock(file) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, String(process.pid));
    fs.linkSync(tmp, file);   // 目标已存在 → EEXIST，原子
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* 没建成就没得删 */ }
  }
}

/**
 * 回收一个判定为陈旧的锁。
 *
 * ★ 不能直接 unlink —— 两个进程可能同时判定同一个陈旧锁、同时删、同时抢，
 *   结果又是两个进程一个库。改成先 rename 到一个唯一的临时名：rename 是
 *   原子的，**只有一个进程能搬走那个 inode**，搬到的那个才赢得回收权。
 *   没抢到的会拿到 ENOENT，它就知道该让路。
 *
 * @returns {boolean} 是不是本进程回收的
 */
function reclaimStaleLock(file) {
  const grave = `${file}.stale.${process.pid}`;
  try {
    fs.renameSync(file, grave);
    fs.unlinkSync(grave);
    return true;
  } catch (_) {
    return false;   // 别人先搬走了
  }
}

// ★ 按**进程**缓存，不是按 client。
//   一个测试进程会建多个 client（isolation.test.js 自己就建两个）。不缓存的话
//   同一个进程的两个 client 会抢到不同的库，测试自己先乱掉 —— 症状又是
//   「数据莫名其妙看不见」。
let allocatedTestDb = null;
let flushedTestDb = false;
// ★ 「本进程加入的是别人开好的库」—— 它唯一的作用是**关掉下面的 flushdb**。
//   不能用「allocatedTestDb 是怎么来的」去推：那是状态，而清库是破坏性动作，
//   必须由一个**明确说出来的意图**触发（见 allocTestDb 里 _JOIN 那段）。
let joinedTestDb = false;

/**
 * 给本进程抢一个测试库编号（1–15）。同一进程内幂等。
 * 抢不到就**大声失败** —— 15 个库全占满时静默共用一个，就又回到测试互相搅动的问题。
 */
function allocTestDb() {
  if (allocatedTestDb !== null) return allocatedTestDb;

  // ── ★ 显式指定编号：**两个意图，两个变量名** ────
  //
  //   「显式指定编号」（CI 或人工排查时需要一个固定的库）里藏着两件事：
  //     ✅「固定编号」  = 要 13 号房
  //     🔴「不参与抢占」= 不管里面有没有人
  //   需要固定库的理由**只支持前者**。而后者的代价是：不抢锁，下面还会
  //   `flushdb` ⇒ **别人正用着的库，被一个「只是想看看」的探针清空**。
  //
  //   ⇒ 拆成两个，各自把意图写在名字里：
  //     ENGLOOP_TEST_DB=<n>       **独占它**     ⇒ 抢锁；抢不到就抛
  //     ENGLOOP_TEST_DB_JOIN=<n>  **加入已开的那一间**（子进程跟父进程同库）
  //                               ⇒ 要求锁已被一个活进程占着，**且绝不 flushdb**
  //
  //   ★ 为什么非拆不可：**独占者清库是合理的（房是他开的），
  //     加入者清库是灾难（房不是他开的）** —— 而只用一个变量的话，清库由
  //     「testDb 非空」触发，也就是由「碰巧是谁先来」决定，而不是由意图决定。
  //
  //   ⚠️ **故意没做的**：
  //     _JOIN 只检查「锁被一个活 pid 占着」，**不检查那个 pid 是不是自己的祖先**。
  //     所以它挡不住「两个无关进程共用一个库」—— 它比裸 URL 强（裸 URL 连
  //     「有人占着」都不要求），但不是完整形式。查祖先是下一档。
  if (process.env.ENGLOOP_TEST_DB_JOIN) {
    const n = Number(process.env.ENGLOOP_TEST_DB_JOIN);
    assertDbNumber(n, 'ENGLOOP_TEST_DB_JOIN');
    const file = testDbLockPath(n);
    if (!fs.existsSync(file)) {
      throw new Error(
        `ENGLOOP_TEST_DB_JOIN=${n}：没有任何进程占着 db ${n}（锁 ${file} 不存在）。\n`
        + '_JOIN 的意思是「加入一间已经开好的房」。房不存在时**不能**默默开一间 ——\n'
        + '那会退回成「不抢锁就用」，正是这个变量要消灭的病。\n'
        + `要独占一个库：ENGLOOP_TEST_DB=${n}。`,
      );
    }
    if (lockIsStale(file)) {
      throw new Error(
        `ENGLOOP_TEST_DB_JOIN=${n}：占着 db ${n} 的进程已经不在了（锁 ${file} 判为陈旧）。\n`
        + '继续用它 = 用一个没人负责清理的库。'
        + `要独占它：ENGLOOP_TEST_DB=${n}（那条路会回收陈旧锁）。`,
      );
    }
    joinedTestDb = true;   // ← createClient 里的 flushdb 靠它关掉
    allocatedTestDb = n;
    return allocatedTestDb;
  }

  if (process.env.ENGLOOP_TEST_DB) {
    const n = TEST_DB;
    assertDbNumber(n, 'ENGLOOP_TEST_DB');
    const file = testDbLockPath(n);
    // 跟下面那个扫描循环同样的两次机会：直接抢；撞上陈旧锁就回收再抢一次。
    let got = tryClaimLock(file);
    if (!got && lockIsStale(file) && reclaimStaleLock(file)) got = tryClaimLock(file);
    if (!got) {
      throw new Error(
        `ENGLOOP_TEST_DB=${n}：db ${n} 正被别的进程占着（锁 ${file}）。\n`
        + '不静默共用是有意的 —— 共用一个库时两边的数据会互相消失，'
        + '而症状是「数据莫名其妙看不见」，最难查。\n'
        + '三条路：换一个编号 · 不指定让它自动分配 · '
        + `就是要跟占着它的那个进程同库（父子进程）⇒ ENGLOOP_TEST_DB_JOIN=${n}。`,
      );
    }
    releaseOnExit(file);
    allocatedTestDb = n;
    return allocatedTestDb;
  }

  for (let db = TEST_DB_MAX; db >= TEST_DB_MIN; db--) {
    const file = testDbLockPath(db);
    // 两次机会：第一次直接抢；撞上了就看是不是陈旧锁，是就回收掉再抢一次。
    // 回收失败（别人先回收了）就让路，换下一个编号 —— 不跟人抢同一个坑。
    for (let attempt = 0; attempt < 2; attempt++) {
      if (tryClaimLock(file)) {
        allocatedTestDb = db;
        releaseOnExit(file);
        return db;
      }
      if (attempt === 0 && lockIsStale(file) && reclaimStaleLock(file)) continue;
      break;   // 真占着，或者回收权被别人拿走了 → 换下一个编号
    }
  }

  throw new Error(
    `测试库 ${TEST_DB_MIN}–${TEST_DB_MAX} 全被占用，抢不到。`
    + ` 锁在 ${os.tmpdir()}/engloop-testdb-*.lock。`
    + ' 要么真有 15 个测试进程在跑，要么有陈旧锁没清掉 —— 宁可跑不起来，也不静默共用一个库。',
  );
}

function releaseOnExit(file) {
  const release = () => { try { fs.unlinkSync(file); } catch (_) { /* 已经没了 */ } };

  // ★ 定期 touch 刷新 mtime —— 没有这个，上面那条 mtime 判定就不是「兜底」
  //   而是「上限」：一个跑满 15 分钟、活得好好的测试进程，锁会因为「太老」
  //   被第二个进程抢走，两边静默共用一个库。那正是这套机制要消灭的原病。
  //
  //   加了心跳，mtime 才真的只在持有者**死了**的时候才超时（死了就不再
  //   刷新），pid 复用的兜底作用原样保留。
  //
  //   ⚠️ 必须 unref()：不然测试跑完了还被这个定时器吊着不退出 ——
  //      那就从「锁偶尔失效」变成「每个测试都挂住」，比原问题严重得多。
  const beat = setInterval(() => {
    try { fs.utimesSync(file, new Date(), new Date()); } catch (_) { /* 锁没了就算了 */ }
  }, LOCK_STALE_MS / 3);
  beat.unref();

  process.on('exit', release);
  // Ctrl-C / kill 不会触发 'exit'，留下的陈旧锁虽然有 pid 探活兜底，
  // 但那要等到下一个进程来抢时才清 —— 顺手擦干净更好。
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
}

function isTestProcess(mainFile) {
  // 参数只为让自检测试能喂各种路径进来验判定本身；生产路径永远走 require.main。
  //
  // 用 arguments.length 而不是 `mainFile || …`：后者会把显式传进来的空值
  // 悄悄换成 require.main，于是「入口为空时算什么」这条根本测不到 ——
  // 断言看着是绿的，测的却是另一回事。
  const main = arguments.length > 0 ? mainFile : (require.main && require.main.filename);
  if (!main) return false;
  // ★★ **前缀判定，不是 dirname 相等** —— `test/` 的子目录也算测试。
  //
  //   用 `path.dirname(main) === TEST_DIR` 的话，放在 **`test/fixtures/`** 的探针
  //   `dirname` 是 `test/fixtures`，**不等于** `test`，于是被判成**生产进程**、连 db 0，
  //   它的 `redis.del(..., 'orch:in:agent')` 会**删掉编排者的收件流**，未读消息全丢。
  //   这个判据的失败方向恰好最坏：判成生产 → 连生产库 → 而且不报错。
  //
  //   ⚠️ `test/fixtures/` 下放探针是**完全正常的做法**，所以判据本身必须覆盖子目录。
  const resolved = path.resolve(main);
  return resolved === TEST_DIR || resolved.startsWith(TEST_DIR + path.sep);
}

/**
 * **正面**判定：这是不是一个生产入口。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *   `isTestProcess()` 问的是「是不是测试」，答案只有是/否 ——
 *   而「否」里装着**两种完全不同的东西**：
 *     · `bin/serve.js`（bus）· `bin/next.js`（poller）⇒ **确定是生产**，db 0 是生命线
 *     · scratchpad 里的临时探针        ⇒ **不知道是什么**
 *   只有 `isTestProcess` 的话，它们走同一条分支、拿到同一个 db 0：
 *   一个无参 `createClient()` 的探针会往**生产库**写数据；而绕开它的办法
 *   （裸 URL 指定某个测试库编号）又**绕过了测试库的锁**。
 *   两条路都通向「没参与协调」 —— 这个函数提供的是中间那条正确的路。
 *
 * ⚠️ 前缀判定，不是 dirname 相等 —— 理由跟 `isTestProcess` 那条一样
 *   （子目录里的脚本不能被漏判）。
 *
 * ⚠️ 扫不到的那一格：**launchd / cron / 手工命令行里在 `bin/` 之外的
 *   node 入口**。加这类入口时，要么放进 `bin/`，要么显式给 url。
 */
function isProductionEntry(mainFile) {
  const main = arguments.length > 0 ? mainFile : (require.main && require.main.filename);
  if (!main) return false;
  const resolved = path.resolve(main);
  return resolved === BIN_DIR || resolved.startsWith(BIN_DIR + path.sep);
}

function withDb(url, db) {
  try {
    const u = new URL(url);
    u.pathname = `/${db}`;
    return u.toString();
  } catch (_) {
    return url; // 解析不了就别自作聪明，原样返回
  }
}

/**
 * @param {string} [url] 显式指定时**完全听调用方的** —— 隔离逻辑不介入。
 *   自检测试靠这个口子去连 db 0 验证生产数据没被动过。
 */
function createClient(url, { onStatus } = {}) {
  // 没显式给 url 且跑在测试里 → 强制换到测试库。
  // 注意这里连 ENGLOOP_REDIS_URL 也一起改 db：环境变量指的是「连哪台」，
  // 不该顺带决定「测试能不能碰生产数据」。要换测试库用 ENGLOOP_TEST_DB。
  // ── 四格判定。顺序就是优先级 ─────────────────────
  //   ① 显式给了 url        ⇒ **完全听调用方的**（自检靠这个口子看生产库）
  //   ② `test/` 下          ⇒ 抢一个测试库
  //   ③ 设了 ENGLOOP_TEST_DB / _JOIN ⇒ **显式声明是测试**
  //     （前者抢锁后清库；后者要求别人已占着、而且不清库 —— 见 allocTestDb）
  //   ④ `bin/` 下           ⇒ db 0（**生命线**：bus / poller / agent-start 必须无仪式地连上）
  //   🔴 ⑤ 四样都不是        ⇒ **抛错，不给默认值**
  //
  //   ⑤ 为什么不给默认：默认到 db 0 是**静默**的，临时探针会悄悄往生产库写数据。
  //   而抛错是**响亮**的 —— `busy.check()` 做的是同一个取舍。
  let testDb = null;
  if (!url) {
    if (isTestProcess()) {
      testDb = allocTestDb();
    } else if (process.env.ENGLOOP_TEST_DB || process.env.ENGLOOP_TEST_DB_JOIN) {
      // ★ 走 allocTestDb 而不是直接 `= TEST_DB`：抢锁 / 加入的判定只有一份实现。
      //   （直接赋值的话，「显式编号」这条路会**绕过整个锁机制**。）
      testDb = allocTestDb();
      // ── 🔴 ③ 排在 ④ 之前是**有意**的（`ENGLOOP_TEST_DB=13 node bin/serve.js`
      //   正是那个变量存在的理由 —— CI 或人工排查时需要一个固定的库）。
      //
      //   而它同时造出一个**静默的生产事故形态**：
      //     **`bin/` 下的生产入口 ＋ 环境里残留一个 `ENGLOOP_TEST_DB`
      //       ⇒ bus 静默连测试库**，而日志上跟正常启动一模一样 ——
      //     直到有人发现「消息都发出去了，而没有人收到」。
      //
      //   ⇒ 修法不是拒绝（人工排查是合法用法），是**响一声**：
      //     不拒绝 · 不静默 · 而照着做（unset）之后**它会安静** ⇒ 不是恒真告警。
      //   ⚠️ **只对 `ENGLOOP_TEST_DB` 响，_JOIN 不响** —— 而理由不是「_JOIN 更安全」：
      //     这条警告要求「照着做（unset）之后它会安静」。而 _JOIN 的合法用法
      //     （测试的子进程连 `bin/next.js`）里，**没有人能 unset 它** ——
      //     它是那个子进程正常工作的必要条件 ⇒ 于是警告变成**恒真**，
      //     而一个修不掉又反复出现的告警，是训练人忽略告警的最快方式
      //     （protocol-layering 测试每跑一遍就会打两条）。
      //   ✅ 而 _JOIN 的「残留」形态本来就是**响亮**的：测试进程一退出，锁就没了
      //     ⇒ 下一个带着残留 _JOIN 的进程直接**抛**（test/isolation.test.js【5h】钉的就是这一条）。
      //     ⇒ 所以这里不响，不是放过它，是**那一格已经有人守着，而且守得更硬**。
      if (isProductionEntry() && process.env.ENGLOOP_TEST_DB) {
        const who = (require.main && require.main.filename) || '(unknown)';
        process.stderr.write(
          `⚠️ 生产入口 ${who} 连的是**测试库 db ${testDb}**（ENGLOOP_TEST_DB 被设置）`
          + ' —— 排查完记得 unset，否则消息会发进一个没有人读的库。\n',
        );
      }
    } else if (!isProductionEntry()) {
      const main = (require.main && require.main.filename) || '(undefined —— 多半是 node -e)';
      throw new Error(
        `createClient() 判不出你是什么进程（require.main = ${main}，既不在 bin/ 也不在 test/）。\n`
        + '三条路，挑一条**显式**说出来：\n'
        + '  · 我是测试/探针 ⇒ 设 ENGLOOP_TEST_DB=<1-15>（会**抢锁并清空**那个库）\n'
        + '  · 我要跟某个正在跑的进程同库 ⇒ 设 ENGLOOP_TEST_DB_JOIN=<1-15>（不清库）\n'
        + `  · 我要连指定的库 ⇒ createClient('redis://127.0.0.1:6379/<db>')\n`
        + '  · 我是生产入口   ⇒ 入口放在 bin/ 下\n'
        + '不给默认值是有意的：这里要是默认到 db 0，一个判错的探针就会往**生产库**里写数据。',
      );
    }
  }
  const target = url || (testDb !== null ? withDb(DEFAULTS.url, testDb) : DEFAULTS.url);
  const client = new Redis(target, {
    // ── 可见性 ≠ 可恢复性，别混成一件事 ─────────────────────────
    // 设计要求 "refuse writes loudly rather than silently drop"。
    // 但据此写成 `if (times > 5) return null`（放弃重连）的话，
    // 后果比静默丢消息更糟：redis 抖一下，连接永久死亡，
    // **redis 恢复后 bus 也回不来**（POST 一直 503），而进程还活着所以 launchd 不会救它。
    //
    // 正确的分层：
    //   连接层 → 无限重试（带退避上限），保证可自愈
    //   请求层 → 立即失败（maxRetriesPerRequest 小），保证调用方立刻知道
    // 大声失败说的是「这一次请求要立刻报错」，不是「以后再也不连了」。
    maxRetriesPerRequest: 2,
    retryStrategy(times) {
      return Math.min(times * 200, 3000); // 永不放弃，最长 3 秒一试
    },
  });

  // ioredis 的 'error' 是 EventEmitter 事件 —— 没有监听器时 Node 会把
  // 整个栈打到 stderr。对 next.js 这种「stdout 是协议通道」的进程，
  // 那堆栈会淹掉大脑该看的 JSON。这里吞掉并转成状态回调。
  client.on('error', (err) => {
    if (onStatus) onStatus('error', err);
  });
  client.on('ready', () => { if (onStatus) onStatus('ready'); });

  // ★ 抢到的库先清一次：上一个进程崩在半路的话，锁被判陈旧回收了，但它
  //   写进去的数据还在。捞到别人的残留 = 又一次「数据莫名其妙对不上」。
  //
  //   只清一次（按进程），不是每个 client 都清 —— 同进程的第二个 client
  //   再清一次会把第一个刚写的数据抹掉，同样是那个形状的 bug。
  //
  //   不用 await：ioredis 的命令队列是 FIFO，这条排在所有后续命令之前，
  //   所以 createClient 可以保持同步。
  //
  //   ⚠️ 那个 FIFO 保证**只在同一条连接内成立**。同进程的第二个 client 是
  //      另一条连接，它发的 flushdb 和第一个 client 已经发出的写命令之间
  //      没有任何顺序保证。所以 flushedTestDb 这个标志不是优化，是
  //      **正确性必需** —— 看着像冗余也别删。
  // 🔴 `!joinedTestDb`：**加入者不清库**。
  //   父测试写了一条消息 → 子进程带 _JOIN 连进来 →
  //   若它也 flush，**父进程刚写的那条立刻消失**，而症状是「读不到」。
  //   ⇒ `flushedTestDb` 是**进程内**的标志 ⇒ 多进程共用一个库时，
  //     每个子进程都会各自清一次 —— 用途要求共享，实现假定独占。
  if (testDb !== null && !flushedTestDb && !joinedTestDb) {
    // ⚠️ 清库前硬检查编号。误清 db 0 比这个模块要解决的所有问题加起来还严重
    //    一万倍，所以宁可整个测试跑不起来，也不要它安静地跑在错的库上。
    if (!(Number.isInteger(testDb) && testDb >= TEST_DB_MIN && testDb <= TEST_DB_MAX)) {
      throw new Error(`拒绝清库：db=${testDb} 不在 ${TEST_DB_MIN}–${TEST_DB_MAX} 内`);
    }
    flushedTestDb = true;
    client.flushdb().catch((err) => {
      // 不能静默：清不掉就意味着后面的测试跑在脏库上，红了也找不到原因
      if (onStatus) onStatus('error', err);
      else console.error(`[queue] 测试库 db${testDb} 清理失败：${err.message}`);
    });
  }

  return client;
}

/** 消费者组不存在就建。已存在时 Redis 抛 BUSYGROUP，属正常。 */
async function ensureGroup(redis, stream, group) {
  try {
    await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    return 'created';
  } catch (err) {
    if (String(err.message).includes('BUSYGROUP')) return 'exists';
    throw err;
  }
}

/** Redis 返回的是扁平数组 [k1,v1,k2,v2...]，转成对象 */
function fieldsToObject(arr) {
  const out = {};
  for (let i = 0; i < arr.length; i += 2) out[arr[i]] = arr[i + 1];
  return out;
}

/**
 * 阻塞领取消息。这是「receive = 一次阻塞前台调用」的实现。
 *
 * 返回 [] 表示阻塞到超时也没消息 —— 调用方据此输出 {timeout:true} 并重新进入循环。
 */
async function claimNext(redis, { streams, group, consumer, blockMs, count }) {
  const list = Array.isArray(streams) ? streams : [streams];
  // 多个流按数组顺序读 = 优先级（human 流永远排在 agent 流前面，
  // 而不是在进程内排序 —— 后者会被一阵 agent 刷屏打垮）
  for (const stream of list) {
    await ensureGroup(redis, stream, group);
  }

  const args = [
    'GROUP', group, consumer,
    'BLOCK', String(blockMs ?? DEFAULTS.blockMs),
    'COUNT', String(count ?? DEFAULTS.count),
    'STREAMS', ...list, ...list.map(() => '>'),
  ];

  const res = await redis.xreadgroup(...args);
  if (!res) return [];

  const messages = [];
  for (const [stream, entries] of res) {
    for (const [id, fields] of entries) {
      messages.push({ stream, id, ...fieldsToObject(fields) });
    }
  }
  return messages;
}

/** 确认处理完毕。没有 ack 的消息会滞留 PEL，之后被 autoclaim 重投。 */
async function ack(redis, stream, group, ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length === 0) return 0;
  return redis.xack(stream, group, ...list);
}

/**
 * 投递。每条消息必须带 job_id / agent_type / tmux_session / timestamp
 * —— job_id 兼作幂等键和用量归因的 join key。
 */
// 必备字段。除此之外的键**原样透传** ——
// 不用白名单：凡不在表里的字段静默丢弃的话，房间扇出明明带了
// room_hash，到大脑手上就没了，agent 只能从 text 前缀里猜房间名、
// 再回头查 Redis 才找得到 hash。白名单在管道中间丢数据且不报错，
// 是最难查的一类 bug。
const REQUIRED_FIELDS = ['job_id', 'from', 'to', 'text', 'agent_type', 'tmux_session', 'timestamp'];

/** 补齐必备字段 + 透传其余字段，压平成 XADD 的参数。`send` 和 `sendIfOwner` 共用 —— 两份拷贝会分叉。 */
function buildPayload(msg) {
  const payload = {
    job_id: msg.job_id || cryptoRandomId(),
    from: msg.from || 'unknown',
    to: msg.to || '',
    text: msg.text || '',
    agent_type: msg.agent_type || 'unknown',
    tmux_session: msg.tmux_session || '',
    timestamp: msg.timestamp || new Date().toISOString(),
  };
  // 透传调用方给的其它字段（room_hash 等），不丢
  for (const [k, v] of Object.entries(msg)) {
    if (!REQUIRED_FIELDS.includes(k) && v !== undefined && v !== null) {
      payload[k] = v;
    }
  }
  const flat = [];
  for (const [k, v] of Object.entries(payload)) flat.push(k, String(v));
  return { payload, flat };
}

async function send(redis, stream, msg) {
  const { payload, flat } = buildPayload(msg);
  const id = await redis.xadd(stream, '*', ...flat);
  return { id, ...payload };
}

/**
 * 把滞留在 PEL、超过 minIdleMs 没被 ack 的消息重投给本消费者。
 *
 * ★ 这是 v2 相对 v1 的**正确性提升**：v1 的 delete 就是 claim，
 *   brain 在 unlink 之后、真正处理之前挂掉 → 消息永久消失且无记录。
 *   这里它还在 PEL 里，捞得回来。
 *
 * 代价：at-least-once 语义 → 有副作用的 handler 必须幂等（用 job_id 去重）。
 */
async function autoclaim(redis, { stream, group, consumer, minIdleMs = 60000, count = 50 }) {
  await ensureGroup(redis, stream, group);
  const [, entries] = await redis.xautoclaim(
    stream, group, consumer, String(minIdleMs), '0', 'COUNT', String(count),
  );
  return (entries || []).map(([id, fields]) => ({
    stream, id, redelivered: true, ...fieldsToObject(fields),
  }));
}

/** 未确认消息概览，watchdog 和运维用 */
async function pending(redis, stream, group) {
  await ensureGroup(redis, stream, group);
  const res = await redis.xpending(stream, group);
  return { count: res?.[0] ?? 0, min: res?.[1], max: res?.[2], consumers: res?.[3] || [] };
}

// KEYS[1] = PEL 所在的流  KEYS[2] = 要写的流
// ARGV[1] = group  ARGV[2] = 条目 id  ARGV[3] = 期望的 owner  ARGV[4..] = XADD 的字段
// 返回 { 状态, 值, 说明 }：1 = 已写（值 = 新 id）· 0 = 被拦（值 = 现 owner，'' = 已不在 PEL）
//                        · 2 = 查询失败、照写（fail-open，说明 = 错误信息）
const SEND_IF_OWNER_LUA = `
local ok, p = pcall(redis.call, 'XPENDING', KEYS[1], ARGV[1], ARGV[2], ARGV[2], 1)
if not ok then
  local id = redis.call('XADD', KEYS[2], '*', unpack(ARGV, 4))
  return {2, id, tostring(p.err or p)}
end
if #p == 0 then return {0, ''} end
if p[1][2] ~= ARGV[3] then return {0, p[1][2]} end
return {1, redis.call('XADD', KEYS[2], '*', unpack(ARGV, 4))}
`;

/**
 * **只有当 PEL 里那条现在还归 `consumer` 时**才往 `stream` 里写 —— 查和写在一个 Lua 里，原子。
 *
 * ★ 给 worker 池的写入 fence 用（`lib/worker-pool.js` 的 `fencedSend`）：
 *   autoclaim 换了 owner 之后，原消费者在写结果之前问一句「还是我的吗」。
 *
 * ★★ 为什么是一个 EVAL，而不是先 `XPENDING` 再 `send`：
 *   ① **少一次往返。** 池的连接被 `claimNext` 的 BLOCK 5000 独占，池里每多一句串行命令，
 *     后面的 SET/XACK 就可能被挤到**下一个** BLOCK 后面（多等最多 5 秒）。
 *     实测：先查再写那一版让 `test/worker.test.js` 去重那几条稳定变红（TTL 3 秒的记录
 *     在测试轮询到之前就过期了）—— `worker-pool.js` 里 `replyStreamFor` 那段注释早就预言过。
 *     一个 EVAL 占的正好是原来 XADD 那个位置，时序跟加 fence 之前一样。
 *   ② **查和写之间没有窗口了。** Redis 单线程执行脚本，查完到写完之间谁也插不进来。
 *     （到 ack 那段窗口还在 —— 见 worker-pool.js 那段注释。）
 *
 * 返回 `{ sent: true, id, payload }`；被拦 ⇒ `{ sent: false, owner }`（`owner = null` = 已不在 PEL）；
 *   查询本身失败（NOGROUP 等）⇒ **照写**，`{ sent: true, id, payload, failOpen: '<错误>' }`。
 *
 * ⚠️ **不 ensureGroup**（跟 `pending` 不同）：组不在时 XPENDING 报 NOGROUP，走 fail-open ——
 *   悄悄建一个空组再答「不在 PEL」会把「组都没了」伪装成「已被别人 ack」，那就是拦掉了不该拦的回报。
 * ⚠️ 两个 key 在一个脚本里 ⇒ **只对单实例 Redis 成立**（cluster 下它们可能不在同一个 slot）。
 *   部署形态就是一台机器一个 Redis；哪天上 cluster，这里是要改的地方之一。
 */
async function sendIfOwner(redis, stream, msg, { pelStream, group, id, consumer }) {
  const { payload, flat } = buildPayload(msg);
  const [state, value, note] = await redis.eval(
    SEND_IF_OWNER_LUA, 2, pelStream, stream, group, id, consumer, ...flat,
  );
  if (Number(state) === 0) return { sent: false, owner: value ? String(value) : null };
  return {
    sent: true, id: String(value), payload,
    ...(Number(state) === 2 ? { failOpen: String(note || 'unknown') } : {}),
  };
}

function cryptoRandomId() {
  return require('node:crypto').randomUUID();
}

// ── 架构级守卫：这条连接不许跑阻塞命令 ──────────────────────────────
//
// ★ 为什么需要它，而不是靠注释
//
// `bin/serve.js` 里写着「redis = 普通命令 / blocking = 专供长阻塞读」。
// **那条约定只活在注释里** —— 后加进来的代码（比如 worker pool 内部用
// `claimNext(redis, { blockMs: 5000 })` 领任务）会**把主连接独占掉**。
// 后果：bus 里每一个走 redis 的 HTTP 请求排在 BLOCK 后面
// —— `/health`、`/api/agents` 慢好几秒甚至超时，
// **而 `/api/agents` 是唯一「一眼看出失聪」的路**。
//
// ⚠️ **约定不是机制，新代码不会读注释。**
//
// ★ 这类 bug 普通单测测不出来，**因为每个函数单独看都对**：
//   `claimNext` 没错、`startPool` 没错、传参也没错 ——
//   错的是「哪条连接被用在哪里」，那是**架构约束，需要架构级的守卫**。
//
// 用法：`const redis = q.nonBlockingOnly(q.createClient())`
//   —— 之后任何人拿这条连接跑阻塞命令，**立刻抛错**，而不是悄悄变慢。
const BLOCKING_COMMANDS = new Set([
  'blpop', 'brpop', 'blmove', 'brpoplpush', 'bzpopmin', 'bzpopmax', 'blmpop', 'bzmpop', 'wait',
]);
// 这两个只有带 BLOCK 参数时才阻塞，所以要看参数而不是命令名
const BLOCK_ARG_COMMANDS = new Set(['xread', 'xreadgroup']);

function nonBlockingOnly(client, label = 'redis') {
  const trap = (cmd) => function guarded(...args) {
    const flat = args.flat(Infinity).map((a) => String(a).toLowerCase());
    const blocking = BLOCKING_COMMANDS.has(cmd)
      || (BLOCK_ARG_COMMANDS.has(cmd) && flat.includes('block'));
    if (blocking) {
      throw new Error(
        `[${label}] 这条连接不许跑阻塞命令（${cmd}）。`
        + ' Redis 的阻塞命令会**独占整条连接**，其它命令全排在它后面 ——'
        + ' 而这条连接是给普通命令（XADD/XACK/GET）用的。'
        + ' 需要阻塞读就自己开一条：q.createClient()。'
        + '（主连接被阻塞命令独占时，bus 的每个 HTTP 请求都会慢好几秒。）');
    }
    return client[cmd](...args);
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') {
        const lower = prop.toLowerCase();
        if (BLOCKING_COMMANDS.has(lower) || BLOCK_ARG_COMMANDS.has(lower)) return trap(lower);
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

module.exports = {
  DEFAULTS,
  REQUIRED_FIELDS,
  nonBlockingOnly,
  TEST_DB,
  TEST_DB_MIN,
  TEST_DB_MAX,
  createClient,
  isTestProcess,   // 导出仅为让 test/isolation.test.js 能验证判定本身
  // ── 🔴 下面两个导出**仅供 `test/isolation.test.js` 预约一个测试库编号** ────────
  //   （它们跟上面那几个是同一档的**弱保证**：注释说「仅供测试」，
  //     而没有任何东西阻止别人在生产路径上用它们。）
  //
  //   为什么必须导出，而不是让测试自己拼/自己实现：
  //     · `tryClaimLock` 的注释里记着一个坑——不用 openSync(file,'wx')：
  //       文件出现和 pid 写进去之间有窗口，另一个进程读到空文件 ⇒ 两个并发
  //       进程抢到同一个库 ⇒ **复刻它 = 复刻一个专门修过那个坑的原语，
  //       而复刻件会漏掉那个修**。
  //     · `testDbLockPath` 是一个**路径约定** ⇒ 第二份实现会漂，而漂了不报错。
  //   🔴 而 `reclaimStaleLock` **有意不导出**：测试**不判 stale**（它只报分母），
  //     ⇒ 导出一个用不到的东西，就是白白扩大公开面。
  tryClaimLock,
  testDbLockPath,
  isProductionEntry, // 同上：验「bin/ 下算生产、别处不算」
  allocTestDb,     // 同上：验「每个测试进程拿到的编号不同」
  withDb,
  ensureGroup,
  claimNext,
  ack,
  send,
  autoclaim,
  pending,
  sendIfOwner,
};
