'use strict';

/**
 * worker 池的写入 fence（DUR2 S4）—— 被 autoclaim 接管的那一方不再回报。
 *
 * 场景：A 领走一条 job、正在跑；B 通过**真的** `loop()` → `q.autoclaim` 把它接管；
 *   然后 A 跑完。fence 之前 A 会照常回报 + ack + 写去重记录 ⇒ 派活的人收到两条「完成」。
 *
 * ── 怎么让 B 的 autoclaim 真的接得到 ────────────────────────────────
 *   池的 autoclaim 门槛是 `timeoutMs + 60_000`，最小也要 60 秒 —— 测试等不起。
 *   ⇒ 用 `XCLAIM … IDLE <ms> JUSTID` 把这条的 idle **拨**到一个夹在两个门槛中间的值：
 *       B（timeoutMs=1000）门槛 61 秒   ≤  拨到 120 秒  <  A（默认 600 秒）门槛 660 秒
 *   ⇒ 只有 B 会接，A 自己的 loop 不会把它捞回去。owner 仍是 A（XCLAIM 给 A 自己），
 *     **接管这一步走的是 B 的生产代码**，不是测试替它 XCLAIM 给 B。
 *   ⚠️ 两个池在同一进程 ⇒ 默认消费者名相同（`eval-pool-<pid>`）⇒ 必须传 `consumer`。
 *
 * ── 每个池一条自己的连接 ────────────────────────────────────────────
 *   池在 claimNext 里 BLOCK 5000 独占连接；共用一条的话 A 的回报会排在 B 的阻塞读后面，
 *   测的就不是 fence 而是排队。
 *
 * ── 变异（只在内存里）─────────────────────────────────────────────
 *   `node test/worker-fence.test.js --mutant <名>`：把 `lib/worker-pool.js` 或 `lib/queue.js` 的源码改坏后
 *   `Module._compile` 进 require.cache，**磁盘上的文件一个字不动**（同 worker-stop-mutant-runner.js）。
 *   `--list` 交出变异表；`test/worker-fence-mutation.test.js` 逐条跑、断言红在对应那一条。
 *   ★ 断言只有这一份 —— 变异跑的就是这个文件本身，不是一份同构副本。
 */

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const POOL = path.resolve(__dirname, '..', 'lib', 'worker-pool.js');
const QUEUE = path.resolve(__dirname, '..', 'lib', 'queue.js');

// 每条变异：改哪个文件 · 弄坏了什么 · 锚点 · 期望**哪几条**断言红（子串匹配 ✗ 行）。expectFail: null = 正控。
//   fence 分两半：判定在 queue.js 的 Lua（`SEND_IF_OWNER_LUA`），用判定结果在 worker-pool.js。两半都要变。
const LUA_OWNER = "if p[1][2] ~= ARGV[3] then return {0, p[1][2]} end";
const LUA_MISSING = "if #p == 0 then return {0, ''} end";
const LUA_WRITE = "return {1, redis.call('XADD', KEYS[2], '*', unpack(ARGV, 4))}";
const ACK_GATE = '    if (!(await send(msg, res, short, false))) return;';
const MUTANTS = {
  none: { file: 'pool', what: '不变异（正控）', from: "'use strict';", to: "'use strict';", expectFail: null },
  'no-fence': {
    file: 'pool',
    what: '撤掉 fence：回报一律走普通 q.send',
    from: '      r = await q.sendIfOwner(redis, target, payload, { pelStream: stream, group, id: msg.id, consumer });',
    to: '      r = { sent: true, ...(await q.send(redis, target, payload)) };',
    expectFail: ['S4-1 A 被接管后跑完 ⇒ A 不回报', 'S4-2 B 已 ack ⇒ A 跑完也不回报',
      'S4-3 A 被接管后失败 ⇒ A 不回报「将被重投」'],
  },
  'ack-ignores-fence': {
    file: 'pool',
    what: 'replyAndAck 不看 send 的结果（回报被拦了，照样写去重 + ack）',
    from: ACK_GATE,
    to: '    await send(msg, res, short, false);',
    expectFail: ['S4-1 A 不 ack', 'S4-1 A 不写去重记录', 'S4-2 A 没有覆盖 B 的去重记录'],
  },
  'owner-not-compared': {
    file: 'queue',
    what: 'Lua 只看「在不在 PEL」、不比 owner',
    from: LUA_OWNER,
    to: '-- 变异：不比 owner',
    expectFail: ['S4-1 A 被接管后跑完 ⇒ A 不回报'],
  },
  'missing-treated-as-mine': {
    file: 'queue',
    what: 'Lua 把「不在 PEL」当成自己的',
    from: LUA_MISSING,
    to: "if #p == 0 then return {1, redis.call('XADD', KEYS[2], '*', unpack(ARGV, 4))} end",
    expectFail: ['S4-2 B 已 ack ⇒ A 跑完也不回报'],
  },
  'write-before-check': {
    file: 'queue',
    what: 'Lua 先 XADD 再判（判定照报「被拦」，但回报已经写出去了）',
    from: "local ok, p = pcall(redis.call, 'XPENDING'",
    to: "redis.call('XADD', KEYS[2], '*', unpack(ARGV, 4))\nlocal ok, p = pcall(redis.call, 'XPENDING'",
    expectFail: ['S4-1 A 被接管后跑完 ⇒ A 不回报'],
  },
  'always-closed': {
    file: 'queue',
    what: 'Lua 一律拒写（连自己的都拦）',
    from: LUA_WRITE,
    to: "return {0, 'nobody'}",
    expectFail: ['S4-0 没被接管 ⇒ 照常回报'],
  },
  'script-fail-closed': {
    file: 'queue',
    what: 'Lua 里 XPENDING 报错时拒写（fail-closed）',
    from: "  local id = redis.call('XADD', KEYS[2], '*', unpack(ARGV, 4))\n  return {2, id, tostring(p.err or p)}",
    to: "  return {0, ''}",
    expectFail: ['S4-5 组不存在（NOGROUP）⇒ 脚本 fail-open，照写'],
  },
  'eval-fail-closed': {
    file: 'pool',
    what: 'EVAL 本身失败时拒写（fail-closed）',
    from: "      await q.send(redis, target, payload);\n      return true;",
    to: '      return false;',
    expectFail: ['S4-4 fence 脚本失败 ⇒ fail-open，照常回报'],
  },
};

const argMutant = process.argv[2] === '--mutant' ? process.argv[3] : null;
if (process.argv[2] === '--list') { process.stdout.write(JSON.stringify(MUTANTS)); process.exit(0); }
if (argMutant) {
  const m = MUTANTS[argMutant];
  if (!m) { console.error(`未知变异 "${argMutant}"。可选：${Object.keys(MUTANTS).join(' / ')}`); process.exit(2); }
  const file = m.file === 'queue' ? QUEUE : POOL;
  const src = fs.readFileSync(file, 'utf8');
  // ★ 锚点找不到 ⇒ 这条变异已经失效。不拦的话替换变成 no-op，报告「没红」，人会去查断言。
  if (!src.includes(m.from)) {
    console.error(`✗ 变异锚点找不到：${JSON.stringify(m.from)}`);
    console.error(`  → ${path.basename(file)} 改过了。把锚点更到新代码上，**不要**直接删掉这条变异 —— 它守的判据还在。`);
    process.exit(3);
  }
  // 先进 cache 再编译；queue.js 变异时 worker-pool 的 require('./queue') 会命中这份
  const mod = new Module(file, null);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  require.cache[file] = mod;
  mod._compile(src.split(m.from).join(m.to), file);
  mod.loaded = true;
  console.log(`【变异 ${argMutant}】${m.what}`);
}

const q = require('../lib/queue');
const { startPool } = require(POOL);

const TYPE = 'eval';
const STREAM = `work:${TYPE}`;
const GROUP = `work:${TYPE}`;
const REPLY = 'orch:in:agent';
const A_NAME = 'eval-fence-A';
const B_NAME = 'eval-fence-B';

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(50); }
  return false;
}

/** 每个 job 一道闸：runner 停在闸前，测试决定它什么时候、以什么结果跑完。 */
function gates() {
  const map = new Map();
  const get = (id) => {
    if (!map.has(id)) { let open; const p = new Promise((r) => { open = r; }); map.set(id, { p, open }); }
    return map.get(id);
  };
  const called = [];
  const runner = async (task) => { called.push(task.job_id); return get(task.job_id).p; };
  return { runner, called, open: (id, res) => get(id).open(res) };
}

async function main() {
  const ctl = q.createClient();
  const connA = q.createClient();
  const connB = q.createClient();
  const connC = q.createClient();
  await ctl.del(STREAM, REPLY);
  await q.ensureGroup(ctl, STREAM, GROUP);

  const logs = [];
  const A = gates();
  const B = gates();
  const poolA = startPool(connA, {
    type: TYPE, concurrency: 1, consumer: A_NAME, runner: A.runner, onLog: (m) => logs.push(`A ${m}`),
  });
  const dkey = (jid) => poolA.dedupeKey(jid);
  const replies = async (jid) => (await ctl.xrange(REPLY, '-', '+'))
    .map(([, f]) => { const o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1]; return o; })
    .filter((o) => o.job_id === jid);
  // 判据自己查 PEL（不经被测的 sendIfOwner）—— 拿被测代码去验被测代码，判据跟着它一起错。
  const owner = async (id) => { const r = await ctl.xpending(STREAM, GROUP, id, id, 1); return r && r[0] ? r[0][1] : null; };
  const cachedOutput = async (jid) => { const r = await ctl.get(dkey(jid)); return r ? JSON.parse(r).output : null; };

  /** A 领走 → 把 idle 拨过 B 的门槛 → 起 B，让 B 的 loop 真的 autoclaim 它 */
  async function takeover(jid) {
    const sent = await q.send(ctl, STREAM, { from: 'JARVIS', text: `fence ${jid}`, agent_type: TYPE, job_id: jid });
    ok(await until(() => A.called.includes(jid)), `（前提）${jid}: A 领走了它，runner 停在闸前`);
    await ctl.xclaim(STREAM, GROUP, A_NAME, 0, sent.id, 'IDLE', 120000, 'JUSTID');
    const poolB = startPool(connB, {
      type: TYPE, concurrency: 1, consumer: B_NAME, timeoutMs: 1000, runner: B.runner,
      onLog: (m) => logs.push(`B ${m}`),
    });
    ok(await until(() => B.called.includes(jid)), `（前提）${jid}: B 的 loop 通过 autoclaim 接走了它`);
    ok((await owner(sent.id)) === B_NAME, `（前提）${jid}: PEL 里的 owner 现在是 B`, String(await owner(sent.id)));
    return { poolB, id: sent.id };
  }

  console.log('\n【S4-0】正常路径：没被接管 ⇒ 行为不变');
  {
    const jid = 'fence-0';
    const sent = await q.send(ctl, STREAM, { from: 'JARVIS', text: 'plain', agent_type: TYPE, job_id: jid });
    await until(() => A.called.includes(jid));
    A.open(jid, { ok: true, ms: 5, output: 'A 正常完成' });
    await until(async () => poolA.active === 0 && (await replies(jid)).length >= 1);
    const r = await replies(jid);
    ok(r.length === 1 && /A 正常完成/.test(r[0].text || ''), 'S4-0 没被接管 ⇒ 照常回报', JSON.stringify(r.map((x) => x.text)));
    ok((await owner(sent.id)) === null, 'S4-0 而且照常 ack（不在 PEL 了）');
    ok((await cachedOutput(jid)) === 'A 正常完成', 'S4-0 而且照常写了去重记录');
    ok(!logs.some((l) => /fenced/.test(l) && l.includes(jid)), 'S4-0 没有 fenced 日志');
  }

  console.log('\n【S4-1】A 被 B 接管，A 先跑完 ⇒ A 被 fence（owner 不是自己）');
  {
    const jid = 'fence-1';
    const { poolB, id } = await takeover(jid);
    A.open(jid, { ok: true, ms: 5, output: 'A 的结果（被接管之后才跑完）' });
    ok(await until(() => poolA.active === 0), `（前提）${jid}: A 的 handle 跑完了（下面的「没回报」不是「还没轮到」）`);
    ok((await replies(jid)).length === 0, 'S4-1 A 被接管后跑完 ⇒ A 不回报',
      JSON.stringify((await replies(jid)).map((x) => x.text)));
    // ★ XACK 不看 owner —— A 要是 ack 了，这条会从 PEL 里消失，B 的也没了。
    ok((await owner(id)) === B_NAME, 'S4-1 A 不 ack —— 条目仍在 PEL、仍归 B', String(await owner(id)));
    ok((await ctl.exists(dkey(jid))) === 0, 'S4-1 A 不写去重记录');
    ok(logs.some((l) => l.startsWith('A ') && /fenced/.test(l) && l.includes(jid)
      && l.includes(`原 owner=${A_NAME}`) && l.includes(`新 owner=${B_NAME}`)),
    'S4-1 A 打了一行 fenced 日志（job_id、原 owner、新 owner）');

    B.open(jid, { ok: true, ms: 5, output: 'B 的结果' });
    await until(async () => poolB.active === 0 && (await replies(jid)).length >= 1);
    const r = await replies(jid);
    ok(r.length === 1 && /B 的结果/.test(r[0].text || ''), 'S4-1 B 正常回报（恰好一条，是 B 的结果）',
      JSON.stringify(r.map((x) => x.text)));
    ok((await owner(id)) === null, 'S4-1 B 正常 ack');
    ok((await cachedOutput(jid)) === 'B 的结果', 'S4-1 去重记录是 B 写的');
    await poolB.stop();
  }

  console.log('\n【S4-2】A 被 B 接管，B 先跑完并 ack ⇒ A 跑完时条目已不在 PEL');
  {
    const jid = 'fence-2';
    const { poolB, id } = await takeover(jid);
    B.open(jid, { ok: true, ms: 5, output: 'B 先完成' });
    await until(async () => poolB.active === 0 && (await replies(jid)).length >= 1);
    ok((await replies(jid)).length === 1 && (await owner(id)) === null, 'S4-2 B 先跑完：回报并 ack 了（它受 fence 影响，不算场景前提）');
    A.open(jid, { ok: true, ms: 5, output: 'A 后完成' });
    ok(await until(() => poolA.active === 0), `（前提）${jid}: A 的 handle 跑完了（下面的「没回报」不是「还没轮到」）`);
    const r = await replies(jid);
    ok(r.length === 1 && /B 先完成/.test(r[0].text || ''), 'S4-2 B 已 ack ⇒ A 跑完也不回报',
      JSON.stringify(r.map((x) => x.text)));
    ok((await cachedOutput(jid)) === 'B 先完成', 'S4-2 A 没有覆盖 B 的去重记录', String(await cachedOutput(jid)));
    ok(logs.some((l) => l.startsWith('A ') && /fenced/.test(l) && l.includes(jid) && /已不在 PEL/.test(l)),
      'S4-2 A 的 fenced 日志说明「已不在 PEL」');
    await poolB.stop();
  }

  console.log('\n【S4-3】A 被接管后**失败**（replyAndRetry 那条）⇒ 同样不回报');
  {
    const jid = 'fence-3';
    const { poolB } = await takeover(jid);
    A.open(jid, { ok: false, ms: 5, reason: 'error', error: 'A 失败了' });
    ok(await until(() => poolA.active === 0), `（前提）${jid}: A 的 handle 跑完了（下面的「没回报」不是「还没轮到」）`);
    ok((await replies(jid)).length === 0, 'S4-3 A 被接管后失败 ⇒ A 不回报「将被重投」',
      JSON.stringify((await replies(jid)).map((x) => x.text)));
    B.open(jid, { ok: true, ms: 5, output: 'B 接手完成' });
    await until(async () => poolB.active === 0 && (await replies(jid)).length >= 1);
    const r = await replies(jid);
    ok(r.length === 1 && /B 接手完成/.test(r[0].text || ''), 'S4-3 B 正常回报（恰好一条）',
      JSON.stringify(r.map((x) => x.text)));
    await poolB.stop();
  }

  await poolA.stop();

  console.log('\n【S4-4】fence 脚本本身失败（EVAL 抛）⇒ fail-open（= DUR2 之前的行为）');
  {
    // 只让 eval 抛，其余命令原样 —— 模拟的是「这一次脚本调用失败」，不是连接整体坏掉。
    const broken = new Proxy(connC, {
      get(t, p, r) {
        if (p === 'eval') return () => Promise.reject(new Error('模拟：脚本被拒'));
        const v = Reflect.get(t, p, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const C = gates();
    const poolC = startPool(broken, {
      type: TYPE, concurrency: 1, consumer: 'eval-fence-C', runner: C.runner, onLog: (m) => logs.push(`C ${m}`),
    });
    const jid = 'fence-4';
    const sent = await q.send(ctl, STREAM, { from: 'JARVIS', text: 'probe', agent_type: TYPE, job_id: jid });
    await until(() => C.called.includes(jid));
    C.open(jid, { ok: true, ms: 5, output: 'C 完成' });
    await until(async () => poolC.active === 0 && (await replies(jid)).length >= 1);
    ok((await replies(jid)).length === 1, 'S4-4 fence 脚本失败 ⇒ fail-open，照常回报');
    ok((await owner(sent.id)) === null, 'S4-4 而且照常 ack');
    ok(logs.some((l) => l.startsWith('C ') && /fail-open/.test(l) && l.includes(jid)), 'S4-4 失败被说出来了（日志）');
    await poolC.stop();
  }

  console.log('\n【S4-5】脚本里 XPENDING 报错（组不存在 ⇒ NOGROUP）⇒ 脚本自己 fail-open，照写');
  {
    // 直接调原语，不起池：池的 loop 每轮都 ensureGroup，造不出「组不在」的那一刻。
    // ⚠️ 'work:fence-nogroup' 这个流**不建组** —— 这正是要测的那一支。
    await ctl.del('work:fence-nogroup');
    const before = (await replies('fence-5')).length;
    const r = await q.sendIfOwner(ctl, REPLY, { from: 'T', text: 'nogroup', agent_type: TYPE, job_id: 'fence-5' },
      { pelStream: 'work:fence-nogroup', group: 'work:fence-nogroup', id: '1-0', consumer: 'whoever' });
    ok(r.sent === true && (await replies('fence-5')).length === before + 1,
      'S4-5 组不存在（NOGROUP）⇒ 脚本 fail-open，照写', JSON.stringify(r));
    ok(/NOGROUP/i.test(r.failOpen || ''), 'S4-5 而且把原因带回来了（failOpen 字段）', JSON.stringify(r));
  }

  await ctl.del(STREAM, REPLY);
  for (const c of [ctl, connA, connB, connC]) await c.quit();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
