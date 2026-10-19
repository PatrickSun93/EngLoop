'use strict';

/**
 * `scripts/web-preview.js` —— 控制台的预览服务器。
 *
 *   【1】随机端口起得来；每个场景的每个端点都回 200（或者场景规定的错误码）
 *   【2】传 9969 时退出（而且**不去连** 9969 —— 只看退出码和 stderr）
 *   【3】require 列表里没有 queue、watchdog、redis、tmux
 *   【4】写操作回 {ok:true, preview:true}；场景走 cookie；夹具时间按「现在」换算
 *
 * ⚠️ 这个测试起的是**预览服务器**（随机端口），不碰真 bus、不碰 Redis、不碰 tmux。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'web-preview.js');
const FIX = path.join(ROOT, 'test', 'fixtures', 'web-preview');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

/** 读源码里所有 require('…') 的模块名。注释里的不算（先剥注释）。 */
function requiresOf(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}
const FORBIDDEN = /queue|watchdog|redis|tmux|^\.\.?\/lib\/|\/lib\//i;
const ALLOWED = new Set(['node:fs', 'node:path', 'node:http', 'express', 'ws']);

function startPreview() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--port', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill(); reject(new Error(`预览服务器 8 秒内没报出地址：${out}${err}`)); }, 8000);
    child.stdout.on('data', (b) => {
      out += b;
      const m = /PREVIEW_URL (http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(out);
      if (m) { clearTimeout(t); resolve({ child, url: m[1], port: Number(m[2]) }); }
    });
    child.stderr.on('data', (b) => { err += b; });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`预览服务器提前退出 ${code}：${err}`)); });
  });
}

async function get(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: r.status, json, text, headers: r.headers };
}

async function main() {
  console.log('\n【3】require 列表（先跑：它不需要起服务）');
  {
    const reqs = requiresOf(SRC);
    ok(reqs.length >= 4, `（前提）读到 ${reqs.length} 个 require：${reqs.join(', ')}`);
    ok(!reqs.some((r) => FORBIDDEN.test(r)),
      '★★★ 没有 require queue / watchdog / redis / tmux / lib/*', reqs.filter((r) => FORBIDDEN.test(r)).join(', '));
    ok(reqs.every((r) => ALLOWED.has(r)),
      '★★ 只 require node 内置 + express + ws（白名单，新加一个就要在这里过一次眼）',
      reqs.filter((r) => !ALLOWED.has(r)).join(', '));
    // 阴性对照：这个检查认得出违规的写法（否则上面是恒真的）
    const bad = requiresOf("const q = require('../lib/queue');\nconst w = require(\"../lib/watchdog-events\");\n// require('ioredis')");
    ok(bad.length === 2 && bad.every((r) => FORBIDDEN.test(r)),
      '★ 阴性对照：require(\'../lib/queue\') 和 watchdog 被认出来；注释里的 ioredis 不算', JSON.stringify(bad));
  }

  console.log('\n【2】★★★ 传 9969 时退出（不起服务、不连那个端口）');
  {
    const r = spawnSync(process.execPath, [SCRIPT, '--port', '9969'], { cwd: ROOT, encoding: 'utf8', timeout: 8000 });
    ok(r.status === 2, `★★★ --port 9969 ⇒ 退出码 2（实际 ${r.status}）`);
    ok(/9969/.test(r.stderr) && !/PREVIEW_URL/.test(r.stdout), '★ 说清了为什么（stderr 里有 9969），而且没报出地址', r.stderr.trim());
    const P = require(SCRIPT);
    let threw = null;
    try { P.assertNotBusPort(9969); } catch (e) { threw = e.code; }
    ok(threw === 'BUS_PORT_REFUSED', '★ assertNotBusPort(9969) 抛 BUS_PORT_REFUSED');
    let threw2 = null;
    try { P.assertNotBusPort(9970); P.assertNotBusPort(0); } catch (e) { threw2 = e; }
    ok(threw2 === null, '★ 阴性对照：9970 和 0 不抛（不是「什么端口都拒」）');
    ok(/assertNotBusPort\(port\);\s*\n\s*const app = createPreviewApp/.test(SRC),
      '★ start() 在建服务之前先断言端口（被 require 来用的那条路也拦得住）');
  }

  console.log('\n【1】★★ 随机端口起得来，每个场景的每个端点都回该回的码');
  const { child, url, port } = await startPreview();
  try {
    ok(port > 0 && port !== 9969, `起在随机端口 ${port}`);
    const scenarios = fs.readdirSync(FIX).filter((d) => fs.existsSync(path.join(FIX, d, 'scenario.json'))).sort();
    const want = ['normal', 'blind', 'agents-error', 'status-404', 'empty', 'busy-queue'];
    ok(want.every((s) => scenarios.includes(s)), `六个场景都在：${want.join(' / ')}`, scenarios.join(', '));

    // `messages-error` 场景里 dev 的私聊历史 503（泳道「查不了，保留旧内容」用）
    const EXPECT = { 'agents-error': { '/api/agents': 500 }, 'status-404': { '/api/status': 404 },
      'messages-error': { '/api/messages?to=dev': 503 } };
    const BASE_EPS = ['/health', '/api/whoami', '/api/agents', '/api/queue/items', '/api/status', '/api/rooms',
      '/api/outputs', '/api/reactions/semantics', '/api/reactions/pending', '/api/messages?to=JARVIS'];
    for (const sc of scenarios) {
      const eps = [...BASE_EPS];
      // 这个场景里出现的房间、agent 的历史也都要拿得到 —— 页面会去点它们
      const rooms = await get(`${url}api/rooms?scenario=${sc}`);
      for (const r of (rooms.json && rooms.json.rooms) || []) eps.push(`/api/rooms/${r.hash}/history?count=200`);
      const ag = await get(`${url}api/agents?scenario=${sc}`);
      if (ag.status === 200) {
        for (const g of ['deaf', 'rate_limited', 'live', 'stale']) {
          for (const a of ag.json[g] || []) eps.push(`/api/messages?to=${encodeURIComponent(a.name)}`);
        }
      }
      const bad = [];
      for (const ep of [...new Set(eps)]) {
        const sep = ep.includes('?') ? '&' : '?';
        const r = await get(`${url}${ep.slice(1)}${sep}scenario=${sc}`);
        const code = (EXPECT[sc] || {})[ep] || 200;
        if (r.status !== code) bad.push(`${ep} ${r.status}≠${code}`);
      }
      ok(!bad.length, `${sc}：${new Set(eps).size} 个端点都回了该回的码`, bad.join(' · '));
    }

    // 场景规定的错误码，单独钉一次（上面那条只是「对得上表」）
    const e1 = await get(`${url}api/agents?scenario=agents-error`);
    ok(e1.status === 500 && e1.json && e1.json.error === 'agents_probe_failed', '★ agents-error：/api/agents 500，body 照 bin/serve.js 那个 catch 的形状');
    // messages-error —— 只有 dev 那一个名字 503，body 是 lib/messages.js httpError() 的 PARTIAL_UNAVAILABLE 形状；别的名字照常 200
    const me = await get(`${url}api/messages?to=dev&count=100&scenario=messages-error`);
    const { httpError: msgHttpError, PARTIAL_UNAVAILABLE } = require('../lib/messages.js');
    const shape = Object.keys(msgHttpError(Object.assign(new Error('x'), { code: PARTIAL_UNAVAILABLE })).body).sort().join();
    ok(me.status === 503 && me.json && me.json.error === 'PARTIAL_UNAVAILABLE' && Object.keys(me.json).sort().join() === shape,
      '★ messages-error：/api/messages?to=dev 503，字段跟 httpError() 的 PARTIAL_UNAVAILABLE 分支一致', JSON.stringify(me.json));
    const ms = await get(`${url}api/messages?to=senior&scenario=messages-error`);
    ok(ms.status === 200 && ms.json && ms.json.name === 'senior', '★ messages-error：别的名字照常 200（只坏一列）');
    const e2 = await get(`${url}api/status?scenario=status-404`);
    ok(e2.status === 404 && /Cannot GET/.test(e2.text) && e2.json === null,
      '★ status-404：/api/status 404 而且是 HTML（express 默认那种，不是后端的 JSON）');
    const bl = await get(`${url}api/agents?scenario=blind`);
    ok(bl.json && bl.json.sessions_seen === 0 && bl.json.watchdog_blind === true, '★ blind：sessions_seen 0');
    const bq = await get(`${url}api/queue/items?scenario=busy-queue`);
    const gq = Object.fromEntries(((bq.json && bq.json.groups) || []).map((g) => [g.recipient, [g.queued, g.in_flight]]));
    ok(JSON.stringify(gq.dev) === '[0,6]' && JSON.stringify(gq.senior) === '[5,1]', '★ busy-queue：dev 0/6、senior 5/1', JSON.stringify(gq));
    const em = await get(`${url}api/agents?scenario=empty`);
    const er = await get(`${url}api/rooms?scenario=empty`);
    ok(em.json && em.json.live.length === 1 && em.json.live[0].type === 'orchestrator' && er.json.rooms.length === 0,
      '★ empty：只有编排者，没有房间');

    console.log('\n【4】写操作 / 场景 cookie / 夹具时间 / 静态文件');
    const w1 = await get(`${url}api/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' });
    ok(w1.status === 200 && w1.json && w1.json.ok === true && w1.json.preview === true, '★★ POST /api/message ⇒ {ok:true, preview:true}');
    const w2 = await get(`${url}api/rooms/x/threads/merge/y`, { method: 'DELETE' });
    ok(w2.json && w2.json.preview === true, '★ DELETE 也一样，不转发');
    const rb = await get(`${url}api/reactions/batch`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'room', anchors: ['1791000004000-0', 'nope'] }) });
    ok(rb.status === 200 && rb.json && rb.json.reactions && Array.isArray(rb.json.reactions['1791000004000-0'])
       && !('nope' in rb.json.reactions), '★ POST /api/reactions/batch 是「用 POST 发的读」：回夹具里的反应');

    const c1 = await fetch(`${url}?scenario=agents-error`);
    const cookie = (c1.headers.get('set-cookie') || '').split(';')[0];
    ok(/^preview_scenario=agents-error$/.test(cookie), '★ ?scenario= 写进 cookie', cookie);
    const c2 = await get(`${url}api/agents`, { headers: { cookie } });
    ok(c2.status === 500, '★★ 之后的轮询（不带 query、只带 cookie）用同一个场景');
    const c3 = await get(`${url}api/agents?scenario=nope`);
    ok(c3.status === 400 && c3.json && Array.isArray(c3.json.scenarios), '★ 不认识的场景 ⇒ 400 并列出有哪些');

    const st = await get(`${url}api/status?scenario=normal`);
    const age = Date.now() - Date.parse(st.json.tests.at);
    ok(age > 0 && age < 3600_000, `★ 夹具时间按「现在」换算（@now-6m ⇒ ${Math.round(age / 1000)} 秒前）`);
    ok(st.headers.get('x-preview-fixture') === 'test/fixtures/web-preview/normal/status.json',
      '★ 响应头说清了是哪个夹具文件回的', st.headers.get('x-preview-fixture'));
    const inh = await get(`${url}api/status?scenario=blind`);
    ok(inh.headers.get('x-preview-fixture') === 'test/fixtures/web-preview/normal/status.json',
      '★ 场景里没有的文件从 extends 那个场景拿（blind 的 status 来自 normal）');
    // ★ 队列条目的 stream id 也按「现在」换算 —— 「派出 N 分钟」按 id 算
    const qi = await get(`${url}api/queue/items?scenario=normal`);
    const first = qi.json && qi.json.groups && qi.json.groups[0] && qi.json.groups[0].items[0];
    const idAge = first ? Date.now() - Number(String(first.id).split('-')[0]) : NaN;
    ok(first && /^\d+-0$/.test(first.id) && idAge > 13 * 60_000 && idAge < 15 * 60_000,
      `★★ 队列条目的 stream id 按「现在」换算（@now-14m-0 ⇒ ${Math.round(idAge / 60_000)} 分钟前，id ${first && first.id}）`);
    const bqi = await get(`${url}api/queue/items?scenario=busy-queue`);
    const ids = (bqi.json.groups || []).flatMap((g) => g.items.map((it) => it.id));
    ok(ids.length > 0 && ids.every((x) => /^\d+-\d+$/.test(x) && Date.now() - Number(x.split('-')[0]) < 3600_000),
      '★ busy-queue 的条目 id 也是相对的（都在 1 小时内，不会显示成「派出几百小时」）', ids.slice(0, 3).join(', '));
    const nf = await get(`${url}api/graphs?scenario=normal`);
    ok(nf.status === 501 && nf.json && nf.json.error === 'preview_no_fixture',
      '★ 没有夹具的 GET 回 501 说清楚，**不**回空数组冒充「没有数据」');
    const trav = await get(`${url}api/docs/..%2F..%2Fscenario?scenario=normal`);
    ok(trav.status !== 200, '★ /api/docs 带 .. 读不到夹具目录外面', String(trav.status));

    const idx = await get(url);
    ok(idx.status === 200 && /<script src="\/derive\.js"><\/script>/.test(idx.text), '★ 托管的是本工作树的 web/（index.html 里有 derive.js）');
    const font = await fetch(`${url}fonts/Geist-Variable.woff2`);
    ok(font.status === 200, '★ 字体从 web/fonts/ 本地出（不连 Google Fonts）');
  } finally {
    child.kill();
  }

  console.log('\n【5】每个夹具目录都有 SOURCE.md（写清每个文件对应哪个 handler）');
  for (const d of fs.readdirSync(FIX).filter((x) => fs.existsSync(path.join(FIX, x, 'scenario.json')))) {
    const p = path.join(FIX, d, 'SOURCE.md');
    const has = fs.existsSync(p);
    const files = fs.readdirSync(path.join(FIX, d), { recursive: true })
      .filter((f) => f.endsWith('.json') && f !== 'scenario.json');
    const txt = has ? fs.readFileSync(p, 'utf8') : '';
    const missing = files.filter((f) => !txt.includes(path.basename(f).replace(/\.json$/, '')) && !txt.includes(f));
    ok(has && !missing.length, `${d}/SOURCE.md 在，而且提到了这个目录里的每个夹具`, missing.join(', '));
  }

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('✗ 异常:', (e && e.stack) || e);
  console.log(`\n  通过 ${pass} · 失败 ${fail + 1}\n`);
  process.exit(1);
});
