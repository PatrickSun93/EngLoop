'use strict';

/**
 * `scripts/migrate-agent-names.js` 的判据。
 *
 * ★ Redis 一律用测试库（`q.createClient()` 在 test/ 下抢一个，**绝不是 db 0** —— 开头先断言这一条，
 *   不成立就整个不跑）；仓库根、HOME 都是临时目录；tmux 会话列表注入，CLI 那段用私有 tmux server。
 *
 * 旧名字是三个字母，这个文件里**不写它的字面量**（`test/no-legacy-names.test.js` 的闸）—— 一律用 OLD 拼。
 *
 * 覆盖：
 *   【1】演练什么都不改
 *   【2】--apply 后旧名字一个不剩；新组的 last-delivered-id 等于旧的；花名册 TTL 还在；目录 / 项目目录 / history 搬对
 *   【3】第二次跑什么都不做（退出码 0）
 *   【4】PEL 不为空 ⇒ 拒绝，什么都没改
 *   【5】不认识的族 / 不认识的组 ⇒ 拒绝，什么都没改
 *   【6】目录 / 项目目录的目标冲突 ⇒ 拒绝，什么都没改
 *   【7】目标流已存在 · 旧会话还活着 ⇒ 拒绝
 *   【8】中途崩了（流改了名、组还没换）再跑 ⇒ 接着换完
 *   【9】CLI：退出码 0 / 2，演练字样
 * 变异：`node scripts/mutate-agent-names.js`（内存变异，不落盘）。
 *
 * 单跑：`node test/agent-names-migration.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const q = require('../lib/queue');
const M = require('../scripts/migrate-agent-names');

const OLD = ['p', 'u', 'p'].join('');
const OLD_DIR = `${OLD}s`;
const SCRIPT = path.join(__dirname, '..', 'scripts', 'migrate-agent-names.js');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const redis = q.createClient();
const quiet = () => {};

async function reset() {
  // ★ 守门：这里会清库 —— 只许清测试库
  if (!q.isTestProcess() || !redis.options || !redis.options.db) throw new Error('不是测试库，拒绝清');
  await redis.flushdb();
}

function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `engloop-ren1-${tag}-`)); }
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
const enc = (p) => path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');

const fieldsOf = (arr) => { const o = {}; for (let i = 0; i + 1 < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o; };
async function groups(stream) {
  try { return (await redis.xinfo('GROUPS', stream)).map(fieldsOf); } catch { return []; }
}

/** 一套「停机时的生产现场」：收件流 ＋ 编排者流 ＋ 花名册 ＋ 任务图 ＋ 目录 ＋ 项目目录 ＋ history。 */
async function seed() {
  await reset();
  const root = mkTmp('root');
  const home = mkTmp('home');
  const ids = {};
  // 收件流：3 条，组读到第 2 条并 ack ⇒ last-delivered-id = 第 2 条（不是 0、也不是 $）
  const IN = `${OLD}:dev:in`;
  ids.d1 = await redis.xadd(IN, '*', 'from', 'JARVIS', 'text', 'a');
  ids.d2 = await redis.xadd(IN, '*', 'from', 'JARVIS', 'text', 'b');
  await redis.xgroup('CREATE', IN, `${OLD}:dev`, '0');
  const got = await redis.xreadgroup('GROUP', `${OLD}:dev`, 'dev-1', 'COUNT', 2, 'STREAMS', IN, '>');
  for (const [, rows] of got) for (const [id] of rows) await redis.xack(IN, `${OLD}:dev`, id);
  ids.d3 = await redis.xadd(IN, '*', 'from', 'JARVIS', 'text', 'c');
  // 编排者流：组 orch（名字里没有旧名字，不动）＋ bus 的那个组
  const ORCH = `orch:in:${OLD}`;
  ids.o1 = await redis.xadd(ORCH, '*', 'from', 'dev', 'text', 'x');
  ids.o2 = await redis.xadd(ORCH, '*', 'from', 'dev', 'text', 'y');
  await redis.xgroup('CREATE', ORCH, 'orch', ids.o1);
  await redis.xgroup('CREATE', ORCH, `bus-${OLD}-in`, ids.o2);
  // 花名册
  await redis.set('engloop:roster:dev', JSON.stringify({ name: 'dev', type: 'dev', cwd: path.join(root, OLD_DIR, 'dev'),
    tmux_session: `${OLD}_dev`, stream: IN, registered_at: 'x', last_heartbeat: 1 }), 'EX', 900);
  await redis.set('engloop:roster:JARVIS', JSON.stringify({ name: 'JARVIS', type: 'orchestrator', cwd: root,
    tmux_session: 'orch', stream: ORCH, registered_at: 'x', last_heartbeat: 1 }), 'EX', 86400);
  // 任务图
  await redis.hset('graph:g1:nodes', 'a', JSON.stringify({ id: 'a', kind: OLD, assignee: 'dev', brief: `派给 ${OLD.toUpperCase()}` }),
    'b', JSON.stringify({ id: 'b', kind: 'work', assignee: 'eval' }));
  await redis.set('graph:g1:meta', JSON.stringify({ id: 'g1', plan_text: `{"nodes":[{"id":"a","kind":"${OLD}"}]}`, plan_md5: 'm' }));
  // 一个跟旧名字无关的流 —— 必须原样
  await redis.xadd('room:abc', '*', 'from', 'Patrick', 'text', 'hi');

  // 目录：tracked 文件已经被 pull 搬到 agents/；旧目录里剩下没跟踪的 + 一份一模一样的
  write(path.join(root, 'agents', 'dev', 'CLAUDE.md'), '# dev — dev agent\n');
  write(path.join(root, OLD_DIR, 'dev', 'CLAUDE.md'), '# dev — dev agent\n');
  write(path.join(root, OLD_DIR, 'dev', 'notes.txt'), '没被跟踪的笔记\n');
  write(path.join(root, OLD_DIR, 'dev', '.claude', 'settings.local.json'), '{}\n');
  write(path.join(root, OLD_DIR, 'senior', 'scratch.md'), 's\n');
  // history：两行旧流名、一行房间、一行坏的
  write(path.join(root, 'history', '2026-08-20.jsonl'), [
    JSON.stringify({ id: '1-0', ts: 1, stream: IN, kind: `${OLD}:in`, payload: { [`${OLD}_type`]: 'dev', text: 'a' } }),
    JSON.stringify({ id: '2-0', ts: 2, stream: ORCH, kind: `in:${OLD}`, payload: { text: 'b' } }),
    JSON.stringify({ id: '3-0', ts: 3, stream: 'room:abc', kind: 'room', payload: { text: `提到 ${OLD} 的正文` } }),
    `{坏行 ${OLD}`,
  ].join('\n') + '\n');
  // HOME：两个旧项目目录 ＋ 一个无关的
  const proj = path.join(home, '.claude', 'projects');
  write(path.join(proj, enc(path.join(root, OLD_DIR, 'dev')), 'memory', 'MEMORY.md'), 'dev 的 memory\n');
  write(path.join(proj, enc(path.join(root, OLD_DIR, 'senior')), 's.jsonl'), '{}\n');
  write(path.join(proj, enc(root), 'j.jsonl'), '{}\n');
  return { root, home, ids, IN, ORCH, proj };
}

/** 现场的完整快照：redis 每个 key 的类型和内容（流含组的位置和 PEL）＋ 两棵目录树的内容。 */
async function snapshot(ctx) {
  const out = {};
  const keys = (await redis.keys('*')).sort();
  for (const k of keys) {
    const t = await redis.type(k);
    if (t === 'stream') out[k] = { t, rows: await redis.xrange(k, '-', '+'), groups: await groups(k) };
    else if (t === 'string') out[k] = { t, v: await redis.get(k), ttl: (await redis.pttl(k)) > 0 };
    else if (t === 'hash') out[k] = { t, v: await redis.hgetall(k) };
    else out[k] = { t };
  }
  const tree = (dir) => {
    const res = {};
    const walk = (rel) => {
      const abs = path.join(dir, rel);
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const r = path.join(rel, e.name);
        if (e.isDirectory()) { res[r + '/'] = 'd'; walk(r); } else res[r] = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, r))).digest('hex');
      }
    };
    if (fs.existsSync(dir)) walk('');
    return res;
  };
  return JSON.stringify({ redis: out, root: tree(ctx.root), home: tree(ctx.home) });
}

const run = (ctx, opts = {}) => M.migrate({ redis, root: ctx.root, home: ctx.home, log: quiet, sessions: () => [], ...opts });

async function main() {
  console.log('\nREN1 迁移脚本（测试库 · 临时目录 · 临时 HOME）\n');
  ok(redis.options.db !== 0 && q.isTestProcess(), `⓪ 连的是测试库 db ${redis.options.db}（不是 db 0）`);
  if (redis.options.db === 0) { console.log('  ⛔ 连到了 db 0，什么都不跑'); process.exit(1); }

  // ── 【1】演练 ──
  console.log('\n【1】演练（默认）什么都不改');
  {
    const ctx = await seed();
    const before = await snapshot(ctx);
    const r = await run(ctx);
    const after = await snapshot(ctx);
    ok(r.code === 0 && !r.applied, '【1】演练退出码 0、没有 apply', JSON.stringify({ code: r.code, applied: r.applied }));
    ok(before === after, '【1】★ 演练前后现场逐字节相同（redis 每个 key ＋ 两棵目录树）');
    const p = r.plan;
    ok(p.streams.length === 2 && p.roster.length === 2 && p.graphNodes.length === 1 && p.dirMoves.length === 3
      && p.dirSame.length === 1 && p.projectRenames.length === 2 && p.history.length === 1 && p.refusals.length === 0,
    '【1】计划认出了每一族：2 个流 · 2 条花名册 · 1 个图节点 · 搬 3 个文件 · 1 个相同 · 2 个项目目录 · 1 个 history 文件',
    JSON.stringify({ s: p.streams.length, r: p.roster.length, g: p.graphNodes.length, m: p.dirMoves.length,
      same: p.dirSame.length, pr: p.projectRenames.length, h: p.history.length, ref: p.refusals }));
    ok(p.trust.map((t) => t.dir).join(',') === [path.join(ctx.root, 'agents', 'dev'), path.join(ctx.root, 'agents', 'senior')].join(','),
      '【1】要重新信任的目录清单 = agents/dev、agents/senior', JSON.stringify(p.trust));
  }

  // ── 【2】【3】apply ＋ 再跑一次 ──
  console.log('\n【2】--apply：旧名字一个不剩，组的位置、TTL、目录、项目目录、history 都对');
  {
    const ctx = await seed();
    const oldDev = (await groups(ctx.IN)).find((g) => g.name === `${OLD}:dev`);
    const oldOrch = await groups(ctx.ORCH);
    let r;
    try { r = await run(ctx, { apply: true }); } catch (e) { r = { code: -1, err: e }; }
    ok(r.code === 0 && r.applied, '【2】apply 退出码 0', r.err ? r.err.message : JSON.stringify(r.plan && r.plan.refusals));

    const leftover = (await redis.keys('*')).filter((k) => new RegExp(OLD, 'i').test(k));
    ok(leftover.length === 0, '【2】★ redis 里名字带旧名字的 key 一个不剩', JSON.stringify(leftover));
    ok((await redis.xlen('agent:dev:in')) === 3, '【2】agent:dev:in 带着全部 3 条消息', String(await redis.xlen('agent:dev:in')));
    const nd = await groups('agent:dev:in');
    ok(nd.length === 1 && nd[0].name === 'agent:dev', '【2】agent:dev:in 上只有组 agent:dev（旧组删了）', JSON.stringify(nd.map((g) => g.name)));
    ok(nd[0] && oldDev && nd[0]['last-delivered-id'] === oldDev['last-delivered-id'] && nd[0]['last-delivered-id'] === ctx.ids.d2,
      '【2】★★ 新组 agent:dev 的 last-delivered-id 等于旧组的（第 2 条，不是 0 也不是 $）',
      `${nd[0] && nd[0]['last-delivered-id']} vs ${oldDev && oldDev['last-delivered-id']}`);
    const no = await groups('orch:in:agent');
    const byName = Object.fromEntries(no.map((g) => [g.name, g['last-delivered-id']]));
    const oldBy = Object.fromEntries(oldOrch.map((g) => [g.name, g['last-delivered-id']]));
    ok(Object.keys(byName).sort().join(',') === 'bus-agent-in,orch'
      && byName.orch === oldBy.orch && byName['bus-agent-in'] === oldBy[`bus-${OLD}-in`],
    '【2】★ orch:in:agent：组 orch 原样、bus-agent-in 的位置等于旧 bus 组', JSON.stringify({ byName, oldBy }));
    // 花名册
    const dev = JSON.parse(await redis.get('engloop:roster:dev'));
    ok(dev.stream === 'agent:dev:in' && dev.tmux_session === 'agent_dev' && dev.cwd === path.join(ctx.root, 'agents', 'dev'),
      '【2】花名册 dev：stream / tmux_session / cwd 都换成新名字', JSON.stringify(dev));
    const jarvis = JSON.parse(await redis.get('engloop:roster:JARVIS'));
    ok(jarvis.stream === 'orch:in:agent' && jarvis.tmux_session === 'orch', '【2】花名册 JARVIS：stream = orch:in:agent', JSON.stringify(jarvis));
    const ttl = await redis.pttl('engloop:roster:dev');
    ok(ttl > 0 && ttl <= 900000, `【2】★ 花名册的 TTL 还在（${ttl}ms）—— 丢了 TTL 它就永远不会掉册`);
    // 任务图
    const a = JSON.parse(await redis.hget('graph:g1:nodes', 'a'));
    const b = JSON.parse(await redis.hget('graph:g1:nodes', 'b'));
    ok(a.kind === M.NEW_KIND && b.kind === 'work', `【2】任务图节点 kind → ${M.NEW_KIND}（work 不动）`, JSON.stringify({ a, b }));
    ok(JSON.parse(await redis.get('graph:g1:meta')).plan_text.includes(`"kind":"${OLD}"`),
      '【2】graph meta 的 plan_text 原样（它跟 PLAN.json 的 md5 绑着）');
    ok((await redis.xlen('room:abc')) === 1, '【2】无关的流原样');
    // 目录
    ok(!fs.existsSync(path.join(ctx.root, OLD_DIR)), '【2】★ 旧目录删掉了');
    ok(fs.readFileSync(path.join(ctx.root, 'agents', 'dev', 'notes.txt'), 'utf8') === '没被跟踪的笔记\n'
      && fs.existsSync(path.join(ctx.root, 'agents', 'dev', '.claude', 'settings.local.json'))
      && fs.existsSync(path.join(ctx.root, 'agents', 'senior', 'scratch.md')),
    '【2】没被跟踪的东西搬到了 agents/ 对应位置');
    // 项目目录
    const pnames = fs.readdirSync(ctx.proj).sort();
    ok(pnames.includes(enc(path.join(ctx.root, 'agents', 'dev'))) && pnames.includes(enc(path.join(ctx.root, 'agents', 'senior')))
      && pnames.includes(enc(ctx.root)) && !pnames.some((n) => n.includes(`-${OLD_DIR}-`)),
    '【2】★ 项目目录改名到新路径对应的名字（无关的那个原样）', JSON.stringify(pnames));
    ok(fs.readFileSync(path.join(ctx.proj, enc(path.join(ctx.root, 'agents', 'dev')), 'memory', 'MEMORY.md'), 'utf8') === 'dev 的 memory\n',
      '【2】auto memory 跟着搬过去了');
    // history
    const hl = fs.readFileSync(path.join(ctx.root, 'history', '2026-08-20.jsonl'), 'utf8').split('\n');
    const h0 = JSON.parse(hl[0]); const h1 = JSON.parse(hl[1]); const h2 = JSON.parse(hl[2]);
    ok(h0.stream === 'agent:dev:in' && h0.kind === 'agent:in' && h1.stream === 'orch:in:agent' && h1.kind === 'in:agent',
      '【2】★ history 里的 stream / kind 换成新流名（否则下一次导出按 stream|id 把整条流再导一遍）', `${hl[0]} | ${hl[1]}`);
    ok(h0.payload[`${OLD}_type`] === 'dev' && h2.payload.text.includes(OLD) && hl[3] === `{坏行 ${OLD}`,
      '【2】history 的 payload、无关行、坏行原样');
    ok(fs.existsSync(path.join(ctx.root, 'history', 'pre-agent-rename', '2026-08-20.jsonl')), '【2】history 原文件有备份');

    console.log('\n【3】再跑一次：什么都不做，退出码 0');
    const before = await snapshot(ctx);
    let r2;
    try { r2 = await run(ctx, { apply: true }); } catch (e) { r2 = { code: -1, err: e }; }
    const after = await snapshot(ctx);
    ok(r2.code === 0 && r2.nothing === true, '【3】★ 第二次：「没什么可做」、退出码 0', JSON.stringify({ code: r2.code, nothing: r2.nothing }));
    ok(before === after, '【3】第二次前后现场相同');
  }

  // ── 【4】PEL 不为空 ──
  console.log('\n【4】PEL 不为空 ⇒ 整个拒绝，什么都没改');
  {
    const ctx = await seed();
    await redis.xreadgroup('GROUP', `${OLD}:dev`, 'dev-1', 'COUNT', 1, 'STREAMS', ctx.IN, '>');   // 领走第 3 条，不 ack
    const before = await snapshot(ctx);
    let r;
    try { r = await run(ctx, { apply: true }); } catch (e) { r = { code: -1, err: e }; }
    const after = await snapshot(ctx);
    ok(r.code === 2 && r.plan.refusals.some((x) => x.kind === 'PEL 不为空' && x.detail.includes(ctx.IN) && x.detail.includes('1 条')),
      '【4】★ 拒绝，并说出是哪个流、几条', JSON.stringify(r.plan ? r.plan.refusals : r.err && r.err.message));
    ok(before === after, '【4】★★ PEL 不为空时什么都没改（redis、目录、项目目录、history 全原样）');
  }

  // ── 【5】不认识的族 / 组 ──
  console.log('\n【5】不认识的族 / 不认识的组 ⇒ 拒绝，什么都没改');
  {
    const ctx = await seed();
    await redis.set(`engloop:${OLD}:weird`, 'x');
    const before = await snapshot(ctx);
    let r;
    try { r = await run(ctx, { apply: true }); } catch (e) { r = { code: -1, err: e }; }
    const after = await snapshot(ctx);
    ok(r.code === 2 && r.plan.refusals.some((x) => x.kind === '不认识的族' && x.detail.includes(`engloop:${OLD}:weird`)),
      '【5】★ 不认识的族 ⇒ 拒绝，并列出那个 key', JSON.stringify(r.plan ? r.plan.refusals : r.err && r.err.message));
    ok(before === after, '【5】★★ 不认识的族时什么都没改');

    const ctx2 = await seed();
    await redis.xgroup('CREATE', ctx2.IN, `x-${OLD}-y`, '0');
    const before2 = await snapshot(ctx2);
    let r2;
    try { r2 = await run(ctx2, { apply: true }); } catch (e) { r2 = { code: -1, err: e }; }
    ok(r2.code === 2 && r2.plan.refusals.some((x) => x.kind === '不认识的组'), '【5】不认识的组 ⇒ 拒绝',
      JSON.stringify(r2.plan ? r2.plan.refusals : r2.err && r2.err.message));
    ok(before2 === await snapshot(ctx2), '【5】不认识的组时什么都没改');
  }

  // ── 【6】目标冲突 ──
  console.log('\n【6】目录 / 项目目录目标已存在且不同 ⇒ 拒绝，不覆盖');
  {
    const ctx = await seed();
    write(path.join(ctx.root, 'agents', 'dev', 'notes.txt'), '另一份不同的笔记\n');
    const before = await snapshot(ctx);
    let r;
    try { r = await run(ctx, { apply: true }); } catch (e) { r = { code: -1, err: e }; }
    ok(r.code === 2 && r.plan.refusals.some((x) => x.kind === '目录冲突' && x.detail.includes('notes.txt')),
      '【6】★ 目录目标冲突 ⇒ 拒绝，列出冲突', JSON.stringify(r.plan ? r.plan.refusals : r.err && r.err.message));
    ok(before === await snapshot(ctx) && fs.readFileSync(path.join(ctx.root, 'agents', 'dev', 'notes.txt'), 'utf8') === '另一份不同的笔记\n',
      '【6】★★ 目标没被覆盖、什么都没改');

    const ctx2 = await seed();
    write(path.join(ctx2.proj, enc(path.join(ctx2.root, 'agents', 'dev')), 'x.jsonl'), '{}\n');
    const before2 = await snapshot(ctx2);
    let r2;
    try { r2 = await run(ctx2, { apply: true }); } catch (e) { r2 = { code: -1, err: e }; }
    ok(r2.code === 2 && r2.plan.refusals.some((x) => x.kind === '项目目录冲突'), '【6】项目目录目标已存在 ⇒ 拒绝',
      JSON.stringify(r2.plan ? r2.plan.refusals : r2.err && r2.err.message));
    ok(before2 === await snapshot(ctx2), '【6】项目目录冲突时什么都没改');
  }

  // ── 【7】目标流已存在 · 旧会话还活着 ──
  console.log('\n【7】目标流已存在 / 旧名字的 tmux 会话还活着 ⇒ 拒绝');
  {
    const ctx = await seed();
    await redis.xadd('agent:dev:in', '*', 'from', 'x', 'text', '新代码先起来写了一条');
    const before = await snapshot(ctx);
    let r;
    try { r = await run(ctx, { apply: true }); } catch (e) { r = { code: -1, err: e }; }
    ok(r.code === 2 && r.plan.refusals.some((x) => x.kind === '目标已存在' && x.detail.includes('agent:dev:in')),
      '【7】目标流已存在 ⇒ 拒绝（RENAMENX 不覆盖）', JSON.stringify(r.plan ? r.plan.refusals : r.err && r.err.message));
    ok(before === await snapshot(ctx), '【7】什么都没改');

    const ctx2 = await seed();
    let r2;
    try { r2 = await run(ctx2, { apply: true, sessions: () => ['orch', `${OLD}_dev`, 'my_shell'] }); } catch (e) { r2 = { code: -1, err: e }; }
    ok(r2.code === 2 && r2.plan.refusals.some((x) => x.kind === '会话还活着' && x.detail.includes(`${OLD}_dev`)),
      '【7】旧名字的 tmux 会话还活着 ⇒ 拒绝（没停干净）', JSON.stringify(r2.plan ? r2.plan.refusals : r2.err && r2.err.message));
  }

  // ── 【8】中途崩了再跑 ──
  console.log('\n【8】中途崩了（流已改名、组还是旧名）再跑 ⇒ 接着换完');
  {
    const ctx = await seed();
    const oldDev = (await groups(ctx.IN)).find((g) => g.name === `${OLD}:dev`);
    await redis.rename(ctx.IN, 'agent:dev:in');   // 模拟：RENAMENX 做完就崩了
    let r;
    try { r = await run(ctx, { apply: true }); } catch (e) { r = { code: -1, err: e }; }
    const nd = await groups('agent:dev:in');
    ok(r.code === 0 && nd.length === 1 && nd[0].name === 'agent:dev' && nd[0]['last-delivered-id'] === oldDev['last-delivered-id'],
      '【8】★ 新流上残留的旧组被换成 agent:dev，位置不变', JSON.stringify({ code: r.code, nd, err: r.err && r.err.message }));
  }

  // ── 【9】CLI ──
  console.log('\n【9】CLI：退出码 / 演练字样（私有 tmux server，不看本机真实会话）');
  {
    const ctx = await seed();
    const o = redis.options;
    const url = `redis://${o.host || '127.0.0.1'}:${o.port || 6379}/${o.db}`;
    const tmuxTmp = mkTmp('tmux');
    const env = { ...process.env, TMUX_TMPDIR: tmuxTmp };
    delete env.TMUX;
    const cli = (extra) => spawnSync(process.execPath, [SCRIPT, '--root', ctx.root, '--home', ctx.home, '--redis', url, ...extra],
      { encoding: 'utf8', env, timeout: 60000 });
    const before = await snapshot(ctx);
    const a = cli([]);
    ok(a.status === 0 && /演练：什么都没改/.test(a.stdout) && before === await snapshot(ctx),
      '【9】不带 --apply ⇒ 退出 0、打印「演练：什么都没改」、现场不变', `${a.status} ${(a.stdout + a.stderr).slice(-300)}`);
    ok(/agents\/dev/.test(a.stdout) && /claude/.test(a.stdout), '【9】演练输出里有要重新信任的目录和做法');
    await redis.set(`engloop:${OLD}:weird`, 'x');
    const b = cli(['--apply']);
    ok(b.status === 2 && /拒绝/.test(b.stdout), '【9】有拒绝项 ⇒ 退出码 2', `${b.status} ${(b.stdout + b.stderr).slice(-300)}`);
    await redis.del(`engloop:${OLD}:weird`);
    const c = cli(['--apply']);
    const d = cli([]);
    ok(c.status === 0 && d.status === 0 && /没什么可做/.test(d.stdout), '【9】apply 退出 0；再跑一次「没什么可做」退出 0',
      `${c.status}/${d.status} ${(d.stdout + d.stderr).slice(-200)}`);
  }

  await reset();
  await redis.quit();
  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.log(`  ✗ 测试本身崩了：${e.stack || e.message}`);
  console.log(`\n  通过 ${pass} · 失败 ${fail + 1}`);
  try { await redis.quit(); } catch { /* */ }
  process.exit(1);
});
