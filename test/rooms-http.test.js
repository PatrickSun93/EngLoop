'use strict';

/**
 * 房间流程的 HTTP 入口。
 *
 * ── 为什么必须走**真 HTTP** ──────────────────────────────────────
 * 这几个端点的价值**全在状态码上**：
 * ```
 * 已经绑过了 → 409（不是 200 悄悄改绑）
 * 角色不在册 → 409（不是 200 绑上再说）
 * 模板是坏的 → 400（不是 500）
 * 还不够格   → **200**（不是 4xx —— 「它还在干」是正常状态）
 * ```
 * lib 层最多能断言「抛了个带 code 的错」，**状态码是几只有真走一遍才知道**。
 *
 * ⚠️ 不起真 bus：bus 一起来 watchdog 就会枚举真 tmux 会话，
 *    而测试库花名册是空的 → 每个真 agent 都会被判失聪并收到恢复指令。
 *    所以挂到测试自己的 express 上，监听端口 0。
 *
 * ⚠️ 这份测试会**在仓库里真的建目录**（`docs/flows/<hash>-httptest-…`）——
 *    绑流程时 mkdir 是被测行为之一。收尾按 `httptest` 前缀删干净。
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const rooms = require('../lib/rooms');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const PREFIX = 'HTTPTEST-';
const MARK = 'httptest';          // slugify 之后的样子，收尾按它清目录
const FLOW = 'design-spec-build';
const ROLES = ['arch', 'senior', 'test'];

function serve(redis) {
  const app = express();
  app.use(express.json());
  app.post('/api/rooms', rooms.createHandler(redis));
  app.post('/api/rooms/:hash/flow', rooms.bindFlowHandler(redis));
  app.get('/api/rooms/:hash/flow', rooms.flowStatusHandler(redis));
  app.post('/api/rooms/:hash/advance', rooms.advanceHandler(redis));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

const jpost = async (url, body) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
};
const jget = async (url) => {
  const r = await fetch(url);
  return { status: r.status, body: await r.json() };
};

function cleanupDirs() {
  const base = rooms.DOCS_FLOWS;
  if (!fs.existsSync(base)) return;
  for (const d of fs.readdirSync(base)) {
    if (d.includes(MARK)) fs.rmSync(path.join(base, d), { recursive: true, force: true });
  }
}

async function cleanupRooms(redis) {
  for (const h of await redis.smembers(rooms.INDEX)) {
    const raw = await redis.get(rooms.META(h));
    if (!raw) { await redis.srem(rooms.INDEX, h); continue; }
    let m = null;
    try { m = JSON.parse(raw); } catch { /* 别人的坏数据不归这里清 */ }
    if (m && String(m.name || '').startsWith(PREFIX)) {
      await redis.del(rooms.META(h), rooms.stream(h));
      await redis.srem(rooms.INDEX, h);
    }
  }
}

async function main() {
  const redis = q.createClient();
  await cleanupRooms(redis);
  cleanupDirs();
  for (const r of ROLES) {
    await roster.register(redis, r, { type: 'dev', stream: `agent:${r}:in` }, 300);
  }
  const app = await serve(redis);

  // ───────────────────────────────────────────────────────────────
  console.log('\n【1】POST /api/rooms 老调用一个字不用改');
  {
    const r = await jpost(`${app.base}/api/rooms`, { name: `${PREFIX}普通房间`, members: ['Patrick'] });
    ok(r.status === 201, '201', String(r.status));
    ok(r.body.flow === null && r.body.flow_dir === null,
      '★ 不给 flow 就是普通聊天房间 —— 现有界面的调用行为不变');
    ok(r.body.members.includes('Patrick'), 'members 照旧');
    const bad = await jpost(`${app.base}/api/rooms`, {});
    ok(bad.status === 400 && !!bad.body.next, '缺 name → 400，而且带 next');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【2】POST /api/rooms 带 flow —— 顺带建目录');
  let bound;
  {
    const r = await jpost(`${app.base}/api/rooms`, { name: `${PREFIX}建时绑`, flow: FLOW });
    ok(r.status === 201, '201', JSON.stringify(r.body).slice(0, 120));
    bound = r.body;
    ok(bound.flow === FLOW, 'flow 落了');
    ok(bound.flow_dir === `docs/flows/${bound.hash}-${MARK}-建时绑`,
      '★ flow_dir = <room_hash>-<slug>，存的是相对路径', bound.flow_dir);
    ok(fs.existsSync(path.join(rooms.REPO_ROOT, bound.flow_dir)),
      '★★ 目录**真的建出来了** —— 不建的话判据永远报「文件不在」，'
      + '而那跟「他还没开始写」长得一模一样');
    ok(bound.stage === null,
      '★ 绑定 ≠ 启动：stage 仍是 null（这是两件事，第二件要打 advance）');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【3】★★ 角色不在花名册 → 409，而且失败留下的状态是无害的');
  {
    await roster.unregister(redis, 'senior');
    const r = await jpost(`${app.base}/api/rooms`, { name: `${PREFIX}缺角色`, flow: FLOW });
    ok(r.status === 409, '409（不是 200 先绑上再说）', String(r.status));
    ok(r.body.error === rooms.ROLES_MISSING, 'error 码是 ROLES_MISSING', r.body.error);
    ok(String(r.body.message).includes('senior'), '★ 说得出缺的是谁', r.body.message);
    ok(String(r.body.next).includes('agent-start'), '★ next 给了怎么补', r.body.next);

    // ★ createHandler 是先建房间再绑流程 —— 绑失败之后房间还在，但它是**普通房间**
    const all = await rooms.list(redis);
    const left = all.find((m) => m.name === `${PREFIX}缺角色`);
    ok(!!left && left.flow === null && left.flow_dir === null,
      '★★ 失败留下的是一个 flow:null 的普通房间 —— **无害的那一种**。'
      + '半绑状态（flow 有值但目录/角色没准备好）才是有毒的');
    await roster.register(redis, 'senior', { type: 'dev', stream: 'agent:senior:in' }, 300);
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【4】POST /:hash/flow 事后绑 · 改绑被拒 · 坏输入');
  {
    const plain = await jpost(`${app.base}/api/rooms`, { name: `${PREFIX}事后绑` });
    const r = await jpost(`${app.base}/api/rooms/${plain.body.hash}/flow`, { flow: FLOW });
    ok(r.status === 200, '200', JSON.stringify(r.body).slice(0, 120));
    ok(fs.existsSync(path.join(rooms.REPO_ROOT, r.body.flow_dir)), '目录也建了');
    ok(String(r.body.next).includes('advance'),
      '★ 响应里说清「绑好了但还没启动，去打 advance」—— '
      + '不说的话人会绑完等着它自己动', r.body.next);

    const again = await jpost(`${app.base}/api/rooms/${plain.body.hash}/flow`, { flow: FLOW });
    ok(again.status === 409 && again.body.error === rooms.FLOW_ALREADY_BOUND,
      '★★ 改绑 → 409。保留旧目录会让两套产出混在一起，换新目录会让旧产出**原地失联** ——'
      + '两种都不报错，所以不猜', String(again.status));

    const p2 = await jpost(`${app.base}/api/rooms`, { name: `${PREFIX}坏输入` });
    const unknown = await jpost(`${app.base}/api/rooms/${p2.body.hash}/flow`, { flow: 'no-such-flow' });
    ok(unknown.status === 400 && unknown.body.error === rooms.FLOW_UNKNOWN,
      '模板不存在 → 400', String(unknown.status));
    ok(String(unknown.body.next).includes('protocols/flows/'), '★ next 给了具体路径');

    const traversal = await jpost(`${app.base}/api/rooms/${p2.body.hash}/flow`, { flow: '../../package' });
    ok(traversal.status === 400,
      '★ 路径穿越串 → 400（loadFlow 的白名单挡在前面）', String(traversal.status));

    const noBody = await jpost(`${app.base}/api/rooms/${p2.body.hash}/flow`, {});
    ok(noBody.status === 400, '不给 flow → 400');

    const gone = await jpost(`${app.base}/api/rooms/deadbeefcafe/flow`, { flow: FLOW });
    ok(gone.status === 404,
      '★ 房间不存在 → 404（不是 400 —— 「没这个房间」和「参数不对」是两回事）',
      String(gone.status));
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【5】GET /:hash/flow —— 回答「为什么它不动」');
  {
    const r = await jget(`${app.base}/api/rooms/${bound.hash}/flow`);
    ok(r.status === 200, '200');
    ok(r.body.state === rooms.FLOW_STATE.NOT_STARTED, 'not_started', r.body.state);
    ok(r.body.can_advance === false && r.body.gate === null,
      '★ 还没启动 → 没走判据（gate 是 null，不是一个假的「不够格」）');
    ok('why' in r.body && 'gate' in r.body,
      '★★ 返回的是 roomGate 而不是 flowStatus —— 打开这个端点的时刻，'
      + '人问的是「为什么它不动」，而答案在 gate 里');

    const gone = await jget(`${app.base}/api/rooms/deadbeefcafe/flow`);
    ok(gone.status === 404, '★ 房间不存在 → 404，不是 200 + 一个空状态', String(gone.status));
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【6】★★ POST /:hash/advance —— 启动那一格');
  {
    const r = await jpost(`${app.base}/api/rooms/${bound.hash}/advance`);
    ok(r.status === 200, '200');
    ok(r.body.advanced === true && r.body.started === true,
      '★★ 绑好的房间打一次 advance 就**启动**了 —— 少了这一格，'
      + '绑完之后永远没有人被点名，而且不报错', JSON.stringify(r.body.why).slice(0, 80));
    ok(r.body.to_stage === 'design' && r.body.assignee === 'arch', '进第一阶段，点名 arch');
    ok(Array.isArray(r.body.messages) && r.body.messages.length === 2,
      '★ 响应带上真发出去的那两条 —— 让人看得见它发了什么，而不是只看到 advanced:true',
      String(r.body.messages && r.body.messages.length));
    ok(r.body.messages[0].expects_reply === false && r.body.messages[1].expects_reply === true,
      '★★ 一条广播（没人动手）+ 一条点名（只有那一个动手）');

    const st = await jget(`${app.base}/api/rooms/${bound.hash}/flow`);
    ok(st.body.state === rooms.FLOW_STATE.RUNNING && st.body.stage === 'design', '状态跟上了');
    ok(st.body.gate && st.body.gate.exists === false,
      '★ 现在 gate 有内容了：DESIGN.md 还不存在', st.body.why);
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【7】★★ 还不够格 → **200**，不是 4xx');
  {
    const r = await jpost(`${app.base}/api/rooms/${bound.hash}/advance`);
    ok(r.status === 200,
      '★★ 「它还在干」是正常状态，不是请求错误 —— 做成 4xx 的话，'
      + '界面会把「还没写完」显示成红色故障', String(r.status));
    ok(r.body.advanced === false, 'advanced:false');
    ok(String(r.body.why).includes('DESIGN.md'), '★ why 说得出差什么', r.body.why);
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【8】端到端：写产出 → 推得动');
  {
    const dir = path.join(rooms.REPO_ROOT, bound.flow_dir);
    fs.writeFileSync(path.join(dir, 'DESIGN.md'),
      '## 问题\n现在轮到谁没人知道。\n## 方案\n状态存房间上。\n## 取舍\n宁可慢。\n', 'utf8');
    const r = await jpost(`${app.base}/api/rooms/${bound.hash}/advance`);
    ok(r.body.advanced === true && r.body.to_stage === 'spec' && r.body.assignee === 'senior',
      '★★ arch 把 DESIGN.md 写完 → design 推到 spec，点名 senior',
      JSON.stringify([r.body.to_stage, r.body.assignee]));
    ok(r.body.messages[1].text.includes('SPEC.md'), '派活里写明下一份产出');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【9】花名册查不了 → 503（不是「都在」）');
  {
    const plain = await jpost(`${app.base}/api/rooms`, { name: `${PREFIX}册查不了` });
    const real = roster.list;
    roster.list = async () => { throw new Error('redis 抖了'); };
    let r;
    try { r = await jpost(`${app.base}/api/rooms/${plain.body.hash}/flow`, { flow: FLOW }); }
    finally { roster.list = real; }
    ok(r.status === 503 && r.body.error === rooms.ROSTER_UNAVAILABLE,
      '★★ 查不了 → 503，**不是**当成「角色都在」放行', String(r.status));
    ok(String(r.body.message).includes('不是「都在」'), '★ 说清了两者的区别', r.body.message);
    const after = await rooms.get(redis, plain.body.hash);
    ok(after.flow === null, '★ 而且没留下半绑状态');
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【10】★ 源码断言：四条路由真的挂在 bin/serve.js 上');
  {
    // handler 再对，没挂上去也是零。而挂载写在 bin/ 里，测试 require 不了它。
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'serve.js'), 'utf8');
    const want = [
      ["app.post('/api/rooms', rooms.createHandler(redis))", 'POST /api/rooms'],
      ["app.post('/api/rooms/:hash/flow', rooms.bindFlowHandler(redis))", 'POST :hash/flow'],
      ["app.get('/api/rooms/:hash/flow', rooms.flowStatusHandler(redis))", 'GET :hash/flow'],
      ["app.post('/api/rooms/:hash/advance', rooms.advanceHandler(redis))", 'POST :hash/advance'],
    ];
    for (const [line, label] of want) ok(src.includes(line), `${label} 挂了`, line);
    // 自检：这几条判据认得出「没挂」的情形（否则一个空字符串也能全绿）
    ok(!src.includes("app.post('/api/rooms/:hash/nope', rooms.nopeHandler(redis))"),
      '★ 自检：不存在的路由确实查不到 —— 上面那几条不是恒真');
  }

  await app.close();
  for (const r of ROLES) await roster.unregister(redis, r).catch(() => {});
  await cleanupRooms(redis);
  cleanupDirs();
  await redis.quit();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('✗ 异常:', (e && e.stack) || e);
  cleanupDirs();
  process.exit(1);
});
