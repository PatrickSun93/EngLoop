#!/usr/bin/env node
'use strict';

/**
 * 控制台的预览服务器。
 *
 *   npm run preview                              # 随机端口，场景默认 normal
 *   node scripts/web-preview.js --port 4310      # 指定端口（**9969 会被拒绝**）
 *   浏览器开 http://127.0.0.1:<端口>/?scenario=blind
 *
 * ── 为什么要它 ──────────────────────────────────────────────────────
 * ⚠️ **不能起真 bus 来预览。** `test/room-console-api.test.js` 开头写着原因：
 *   bus 一起来，watchdog 就去枚举真 tmux 会话，会给真 agent 发恢复指令。
 * ⇒ 这个服务器只做两件事：托管**本工作树**的 `web/`，`/api/*` 和 `/health`
 *   从 `test/fixtures/web-preview/<场景>/` 读 JSON 返回。
 *
 * ── 三条硬规矩（`test/web-preview.test.js` 守着）──────────────────────
 *   ① **绝不绑 9969**（生产 bus 的端口）：传 9969 直接退出，退出码 2。
 *   ② **不 require** `lib/watchdog*`、`lib/queue`、任何会连 Redis 或 tmux 的模块 ——
 *      这个文件只 require node 内置、express、ws。测试读源码断言 require 列表。
 *   ③ 写操作（POST / PUT / DELETE）一律回 `{ok:true, preview:true}`，**不转发到任何地方**。
 *      唯一的例外是 `POST /api/reactions/batch` —— 它是个「用 POST 发的读」
 *      （body 里放一批锚点），回的是夹具里的反应，不写任何东西。
 *
 * ── 场景 ───────────────────────────────────────────────────────────
 *   `?scenario=<名字>` 选场景，写进 cookie `preview_scenario`，之后的轮询都用同一个。
 *   每个场景目录有 `scenario.json`：
 *     { "description": "…", "extends": "normal" | null,
 *       "status": { "<夹具文件>": 500 | { "code": 404, "html": "Cannot GET …" } } }
 *   找文件时先看场景目录，没有再看 `extends` 指的那个（只一层）。
 *   **哪个文件回了这个请求**写在响应头 `x-preview-fixture` 里 —— 预览出了怪样子时，
 *   第一件事是看它从哪来。
 *
 * ── 时间 ───────────────────────────────────────────────────────────
 *   夹具里的时间写成 `"@now-5m"`（→ ISO 字符串）或 `"@now-5m|ms"`（→ 毫秒数），
 *   回响应时按**当前时间**换算。理由：页面按 `Date.now()` 判「48 小时内」「10 天内」，
 *   写死的时间戳过两天就会让整个预览变成「更早的话题」，而那通常不是要看的东西。
 *   单位：s / m / h / d。不带偏移的 `"@now"` 就是此刻。
 *   ★ stream id 也能写成相对的：`"@now-14m-0"` → `"<那一刻的毫秒数>-0"`。
 *     理由：页面的「派出 N 分钟」按 stream id 算（那是进队列的时刻）；id 写死而 timestamp 是相对的，
 *     预览里就会出现「派出 247 小时」这种夹具自己造出来的数。
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');

const BUS_PORT = 9969;
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'web-preview');
const DEFAULT_SCENARIO = 'normal';
const COOKIE = 'preview_scenario';

// ── 参数 ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { port: 0, host: '127.0.0.1', fixtures: FIXTURES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 后面要跟一个值`);
      i += 1;
      return v;
    };
    if (a === '--port') out.port = Number(val());
    else if (a === '--host') out.host = val();
    else if (a === '--fixtures') out.fixtures = path.resolve(val());
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) {
    throw new Error(`--port 要是 0–65535 的整数（0 = 随机），收到 ${out.port}`);
  }
  return out;
}

/**
 * ① 9969 是生产 bus 的端口。**预览服务器绝不碰它** —— 绑上去的话，真 bus 起不来；
 *   而反过来（真 bus 已在跑）时，浏览器里开着的那个控制台会连到预览上，人会把夹具当真。
 */
function assertNotBusPort(port) {
  if (Number(port) === BUS_PORT) {
    const e = new Error(`端口 ${BUS_PORT} 是生产 bus 的端口，预览服务器不绑它。换一个端口，或者不传 --port（随机）。`);
    e.code = 'BUS_PORT_REFUSED';
    throw e;
  }
}

// ── 夹具 ───────────────────────────────────────────────────────────────
const SCENARIO_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

function listScenarios(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'scenario.json')))
      .map((d) => d.name).sort();
  } catch (_) { return []; }
}

function readScenario(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name, 'scenario.json'), 'utf8'));
}

const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const NOW_RE = /^@now(?:([+-])(\d+(?:\.\d+)?)([smhd]))?(\|ms)?$/;
/** stream id 的相对写法：`@now-14m-0` ⇒ `<毫秒>-0`（最后那段是序号） */
const NOW_ID_RE = /^@now(?:([+-])(\d+(?:\.\d+)?)([smhd]))?-(\d+)$/;

/** 把夹具里的 `@now±N<单位>` 换成真时间。纯函数，导出给测试。 */
function resolveTimes(v, now = Date.now()) {
  if (typeof v === 'string') {
    const idm = NOW_ID_RE.exec(v);
    if (idm) {
      const off = idm[1] ? (idm[1] === '-' ? -1 : 1) * Number(idm[2]) * UNIT[idm[3]] : 0;
      return `${Math.round(now + off)}-${idm[4]}`;
    }
    const m = NOW_RE.exec(v);
    if (!m) return v;
    const off = m[1] ? (m[1] === '-' ? -1 : 1) * Number(m[2]) * UNIT[m[3]] : 0;
    const t = now + off;
    return m[4] ? t : new Date(t).toISOString();
  }
  if (Array.isArray(v)) return v.map((x) => resolveTimes(x, now));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = resolveTimes(x, now);
    return o;
  }
  return v;
}

/**
 * 找一个夹具文件。返回 `{ file, body, status, html }`，找不到返回 null。
 * ⚠️ `rel` 只能是夹具目录里的相对路径 —— 拼路径之前先挡掉 `..`，
 *   免得 `/api/docs/../../…` 这类请求读到夹具目录外面去。
 */
function loadFixture(dir, scenario, rel) {
  if (rel.split(/[\\/]/).some((p) => p === '..' || p === '')) return null;
  const sc = readScenario(dir, scenario);
  const chain = [scenario];
  if (sc.extends) chain.push(sc.extends);
  for (const name of chain) {
    const file = path.join(dir, name, rel);
    if (!file.startsWith(path.join(dir, name) + path.sep)) return null;
    if (!fs.existsSync(file)) continue;
    const st = (sc.status || {})[rel];
    const status = typeof st === 'number' ? st : (st && st.code) || 200;
    const html = st && typeof st === 'object' ? st.html || null : null;
    const body = html ? null : resolveTimes(JSON.parse(fs.readFileSync(file, 'utf8')));
    return { file: path.relative(ROOT, file), body, status, html };
  }
  // 状态码覆盖可以单独存在（比如 status-404 不需要一个 status.json 文件）
  const st = (sc.status || {})[rel];
  if (st && typeof st === 'object' && st.html) {
    return { file: `${scenario}/scenario.json#status`, body: null, status: st.code || 404, html: st.html };
  }
  return null;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ── 服务器 ─────────────────────────────────────────────────────────────
function createPreviewApp({ fixtures = FIXTURES, web = WEB } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // 场景：query > cookie > 默认。query 里给了就写进 cookie，之后的轮询都用它。
  app.use((req, res, next) => {
    const q = req.query && req.query.scenario;
    const fromCookie = parseCookies(req.headers.cookie)[COOKIE];
    const want = q || fromCookie || DEFAULT_SCENARIO;
    const known = listScenarios(fixtures);
    if (!SCENARIO_NAME.test(want) || !known.includes(want)) {
      return res.status(400).json({
        error: 'unknown_scenario', message: `没有这个场景：${want}`,
        scenarios: known, next: `用 ?scenario=<名字> 选一个：${known.join(' / ')}`,
      });
    }
    if (q) res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(q)}; Path=/; SameSite=Lax`);
    req.scenario = want;
    res.setHeader('x-preview-scenario', want);
    next();
  });

  const send = (req, res, rel, { notFound = null } = {}) => {
    const fx = loadFixture(fixtures, req.scenario, rel);
    if (!fx) {
      if (notFound) return notFound();
      return res.status(501).json({
        error: 'preview_no_fixture',
        message: `预览场景「${req.scenario}」里没有 ${rel}`,
        next: `这是预览服务器的限制，不是 bus 的行为。要看它就在 test/fixtures/web-preview/${req.scenario}/ 下补一个 ${rel}。`,
      });
    }
    res.setHeader('x-preview-fixture', fx.file);
    if (fx.html) return res.status(fx.status).type('html').send(fx.html);
    return res.status(fx.status).json(fx.body);
  };

  // 预览自己的说明（不是 bus 的端点）
  app.get('/__preview', (req, res) => {
    const known = listScenarios(fixtures);
    res.json({
      scenario: req.scenario,
      scenarios: known.map((n) => ({ name: n, description: readScenario(fixtures, n).description || '' })),
    });
  });

  app.get('/health', (req, res) => send(req, res, 'health.json'));
  app.get('/api/whoami', (req, res) => send(req, res, 'whoami.json'));
  app.get('/api/agents', (req, res) => send(req, res, 'agents.json'));
  app.get('/api/queue/items', (req, res) => send(req, res, 'queue-items.json'));
  app.get('/api/status', (req, res) => send(req, res, 'status.json'));
  app.get('/api/rooms', (req, res) => send(req, res, 'rooms.json'));
  app.get('/api/rooms/:hash/history', (req, res) => send(req, res, `rooms/${req.params.hash}.json`));
  app.get('/api/messages', (req, res) => {
    const to = String(req.query.to || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(to)) {
      return res.status(400).json({ error: 'bad_name', message: `to 不合法：${to}` });
    }
    return send(req, res, `messages/${to}.json`);
  });
  app.get('/api/outputs', (req, res) => send(req, res, 'outputs.json'));
  app.get('/api/docs', (req, res) => send(req, res, 'docs-list.json'));
  app.get('/api/docs/*splat', (req, res) => {
    const rel = [].concat(req.params.splat).join('/');
    return send(req, res, `docs/${rel}.json`);
  });
  app.get('/api/reactions/semantics', (req, res) => send(req, res, 'reactions-semantics.json'));
  app.get('/api/reactions/pending', (req, res) => send(req, res, 'reactions-pending.json'));

  // 反应：夹具是 `{ room: {锚点: [...]}, dm: {...} }`，两个读端点从同一份里取
  const reactionsOf = (req) => {
    const fx = loadFixture(fixtures, req.scenario, 'reactions.json');
    return { fx, map: fx && fx.status === 200 ? fx.body : null };
  };
  // ③ 的唯一例外：它是「用 POST 发的读」，不写任何东西
  app.post('/api/reactions/batch', (req, res) => {
    const { fx, map } = reactionsOf(req);
    const { scope, anchors } = req.body || {};
    if (!Array.isArray(anchors)) return res.status(400).json({ error: 'BAD_INPUT', message: 'anchors 必须是数组' });
    if (fx) res.setHeader('x-preview-fixture', fx.file);
    const all = (map && map[scope]) || {};
    const reactions = {};
    for (const a of anchors) if (all[a] && all[a].length) reactions[a] = all[a];
    return res.json({ scope, reactions, truncated: null });
  });
  app.get('/api/reactions/:scope/:anchor', (req, res) => {
    const { fx, map } = reactionsOf(req);
    if (fx) res.setHeader('x-preview-fixture', fx.file);
    const list = ((map && map[req.params.scope]) || {})[req.params.anchor] || [];
    return res.json({ scope: req.params.scope, anchor: req.params.anchor, reactions: list, malformed: 0 });
  });

  // ③ 写操作：一律假成功，不转发到任何地方
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.setHeader('x-preview-write', 'dropped');
    return res.json({ ok: true, preview: true });
  });
  // 其余 GET /api/*：没有夹具就说没有，**不**回空数组冒充「没有数据」
  app.use('/api', (req, res) => res.status(501).json({
    error: 'preview_no_fixture',
    message: `预览服务器没有 ${req.method} ${req.path} 的夹具`,
    next: '这是预览服务器的限制，不是 bus 的行为。',
  }));

  app.use(express.static(web, { index: 'index.html', extensions: false }));
  return app;
}

function start({ port = 0, host = '127.0.0.1', fixtures = FIXTURES, web = WEB } = {}) {
  assertNotBusPort(port);
  const app = createPreviewApp({ fixtures, web });
  const server = http.createServer(app);
  // /ws：接上就保持连接，只发一条 hello（app.js 认这个 type、什么都不做）。
  // 不推夹具消息 —— 截图要稳定；要看实时推送，在页面里用 route() 喂。
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', preview: true }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      // 随机端口理论上也可能落到 9969 —— 落到了就关掉重来一次，不留着
      if (actual === BUS_PORT) {
        server.close(() => resolve(start({ port: 0, host, fixtures, web })));
        return;
      }
      resolve({ server, wss, port: actual, url: `http://${host}:${actual}/` });
    });
  });
}

module.exports = { start, createPreviewApp, assertNotBusPort, parseArgs, resolveTimes, loadFixture,
                   listScenarios, BUS_PORT };

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    assertNotBusPort(args.port);
  } catch (e) {
    console.error(`web-preview: ${e.message}`);
    process.exit(2);
  }
  if (args.help) {
    console.log('用法：node scripts/web-preview.js [--port N] [--host 127.0.0.1] [--fixtures DIR]');
    process.exit(0);
  }
  start(args).then(({ url }) => {
    console.log(`PREVIEW_URL ${url}`);
    console.log('场景（加 ?scenario=<名字>）：');
    for (const n of listScenarios(args.fixtures)) {
      console.log(`  ${url}?scenario=${n}  —— ${readScenario(args.fixtures, n).description || ''}`);
    }
    console.log('⚠️ 这是夹具，不是 bus。写操作一律回 {ok:true, preview:true}，不转发到任何地方。');
  }).catch((e) => {
    console.error(`web-preview: 起不来：${e.message}`);
    process.exit(1);
  });
}
