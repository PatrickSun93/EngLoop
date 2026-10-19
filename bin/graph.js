#!/usr/bin/env node
'use strict';

/**
 * 任务图 CLI。**只是 bus 的 HTTP 客户端** ——
 * 状态和调度全在 bus 里（`lib/graph-runner.js`），这里一行判断都不做。
 *
 * 用法:
 *   node bin/graph.js start <目录>          校验 PLAN.json、冻结、开跑（或停在 awaiting_approval）
 *   node bin/graph.js approve <id>          批一张等批的图（要 can_manage_workers —— admin token 就是）
 *   node bin/graph.js status [<id>]         不给 id：列所有图；给 id：节点表（状态 · assignee · 已等多久 · why）
 *   node bin/graph.js retry <id> <节点>     把 failed / blocked 的节点放回 pending
 *   node bin/graph.js cancel <id>           放弃整张图（已派出去的活不收回）
 *
 * ★ 为什么走 HTTP 而不是直连 redis：起图要过**人工闸**和**鉴权**，
 *   直连 redis 的 CLI 两样都能绕过 —— 而 agent 也连得上 redis。
 * ★ 凭据：bus 写的 admin token（`temp/bus-admin.token`，`ENGLOOP_ADMIN_TOKEN_FILE` 可改）。
 *   读不到 ⇒ 报错退出，**不降级成不带凭据去请求**（拿回的 401 会被读成「bus 拒绝了」）。
 */

const path = require('node:path');
const auth = require('../lib/auth');
const portRegistry = require('./port-registry');

function usage(code = 2) {
  process.stderr.write('用法:\n'
    + '  node bin/graph.js start <目录>\n'
    + '  node bin/graph.js approve <id>\n'
    + '  node bin/graph.js status [<id>]\n'
    + '  node bin/graph.js retry <id> <节点>\n'
    + '  node bin/graph.js cancel <id>\n');
  process.exit(code);
}

async function call(method, p, body) {
  const bus = portRegistry.resolve('bus');
  const base = `http://${bus.host}:${bus.port}`;
  let token;
  try { token = auth.readAdminToken(auth.ADMIN_TOKEN_FILE); } catch (e) {
    throw new Error(`读不到 bus 的 admin token（${auth.ADMIN_TOKEN_FILE}）：${e.message} —— bus 在跑吗？`);
  }
  let r;
  try {
    r = await fetch(`${base}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`bus 不可达（${base}）：${e.message}`);
  }
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`${r.status} ${json.error || ''}：${json.message || ''}${json.next ? `\n  下一步：${json.next}` : ''}`);
    e.status = r.status;
    throw e;
  }
  return json;
}

const pad = (s, n) => { const t = String(s ?? ''); return t.length >= n ? t : t + ' '.repeat(n - t.length); };
function dur(s) {
  if (s == null) return '—';
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'start') {
    if (!a) usage();
    const r = await call('POST', '/api/graphs', { dir: path.resolve(a) });
    console.log(`✓ 图 ${r.id}：${r.nodes} 个节点 · 状态 ${r.status}（${r.why}）`);
    console.log(`  目录 ${r.dir} · 房间 ${r.room_hash}`);
    if (r.not_in_roster_now.length) console.log(`  ⚠ 现在不在册的 agent：${r.not_in_roster_now.join(' / ')} —— 轮到它们之前要起好，否则节点停在 pending`);
    if (r.status === 'awaiting_approval') console.log(`  ⏸ 等 Patrick 批：网页 /graphs.html，或 node bin/graph.js approve ${r.id}（在他批了之后）`);
    return;
  }
  if (cmd === 'approve') {
    if (!a) usage();
    const r = await call('POST', `/api/graphs/${encodeURIComponent(a)}/approve`);
    console.log(`✓ 图 ${r.id} → ${r.status}`);
    return;
  }
  if (cmd === 'retry') {
    if (!a || !b) usage();
    const r = await call('POST', `/api/graphs/${encodeURIComponent(a)}/retry/${encodeURIComponent(b)}`);
    console.log(`✓ 图 ${r.id} 节点 ${r.node} → ${r.state}`);
    return;
  }
  if (cmd === 'cancel') {
    if (!a) usage();
    const r = await call('POST', `/api/graphs/${encodeURIComponent(a)}/cancel`);
    console.log(`✓ 图 ${r.id} → ${r.status}`);
    return;
  }
  if (cmd === 'status') {
    if (!a) {
      const r = await call('GET', '/api/graphs');
      if (!r.graphs.length) { console.log('（没有图）'); return; }
      for (const g of r.graphs) {
        const counts = Object.entries(g.counts).map(([k, v]) => `${k} ${v}`).join(' · ');
        console.log(`${pad(g.id, 24)} ${pad(g.status, 18)} ${g.nodes} 个节点（${counts}）  ${g.goal}`);
      }
      return;
    }
    const v = await call('GET', `/api/graphs/${encodeURIComponent(a)}`);
    console.log(`图 ${v.meta.id} · ${v.meta.status}（${v.meta.status_why}）`);
    console.log(`目标：${v.meta.goal}`);
    console.log(`目录：${v.meta.dir} · 房间 ${v.meta.room_hash}\n`);
    console.log(`${pad('节点', 16)}${pad('状态', 12)}${pad('assignee', 14)}${pad('已等', 7)}why`);
    for (const n of v.nodes) {
      const name = `${n.parent ? '└ ' : ''}${n.id}`;
      const who = n.kind === 'work' ? `work:${n.assignee}` : n.assignee;
      console.log(`${pad(name, 16)}${pad(n.state, 12)}${pad(who, 14)}${pad(dur(n.waited_s), 7)}${n.why || ''}`
        + (n.hold ? `\n${' '.repeat(49)}⏸ ${n.hold}` : ''));
    }
    return;
  }
  usage();
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
