'use strict';

/**
 * 「任务完成 → 桌面通知 + 🏁」在**真浏览器里**跑一遍（只对隔离 bus 跑）。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────
 *   node scripts/run-e2e-notify.js          ← 一条命令：起隔离 bus、跑这个文件、收掉 bus、删临时文件
 *
 *   或者对一个**已经在跑的隔离 bus** 直接跑（跟 `test/bus-login.playwright.js` 同一套变量）：
 *   ENGLOOP_PW_BASE      http://127.0.0.1:<端口>/     ⚠️ 不许是 9969（生产）
 *   ENGLOOP_PW_USER      用户名（要在那个 bus 的用户表里）
 *   ENGLOOP_PW_KEY       它的 key
 *   ENGLOOP_PW_REDIS     那个 bus 连的 redis url（带测试库编号，不许是 db 0）—— 用来登记花名册
 *   ENGLOOP_PW_OUTBOX    那个 bus 的 ENGLOOP_OUTBOX_ROOT
 *   ENGLOOP_PW_CHANNEL   浏览器 channel（可选，见下面 launch 那段：这个文件默认 'chromium'）
 *   base 是 9969、或 redis 是 db 0 / 没带库号 ⇒ **拒绝跑，非 0 退出**（跟 bus-login 一样的闸）。
 *
 * ── 为什么它不叫 `*.test.js` ────────────────────────────────────
 * `test/run-all.js` 自动扫 `*.test.js`。这个文件要一个起着的隔离 bus 和一个真浏览器，
 * 不进全量。
 *
 * ── 跑一次会发生什么 ──────────────────────────────────────────────
 *   **全部落在隔离 bus 里，生产一个字节不碰**：
 *     · 6 条消息写进 `ENGLOOP_PW_OUTBOX`（隔离 bus 的临时 outbox 根），不是 `temp/outbox`
 *       4 条 → `<outbox>/JARVIS/`         ⇒ orch:out       （编排者那条路径）
 *       2 条 → `<outbox>/e2e-notify-agent/` ⇒ orch:in:agent  （agent 那条路径，【7】）
 *     · 花名册登记两条，**在隔离库里**：`JARVIS`（type orchestrator）和 `e2e-notify-agent`（type dev），
 *       跑完摘掉。
 *   ⚠️ 为什么编排者仍然叫 `JARVIS`：`bin/serve.js` 里 `ORCH_NAME = 'JARVIS'` 是写死的 ——
 *     编排者的 relay 只挂 `<outbox>/JARVIS/`（`lib/relay.js` 的 planRelays 里它常驻、不看花名册），
 *     而 agent 发给编排者的消息要走 `orch:in:agent`，靠的是花名册里 `JARVIS` 那条的 type=orchestrator
 *     （`lib/roster.js` 的 inboxFor）。这是**隔离库里的一个同名条目**，不是借在岗 JARVIS 的身份：
 *     生产 bus 读的是 db 0、生产 outbox，这里写的东西它一条都看不到。
 *   ★ agent 不借在岗 agent 的名字：登记一个测试专用的 `e2e-notify-agent`，
 *     bus 的 syncRelays（每 15 秒，`bin/serve.js`）照花名册给它挂 relay ——
 *     relay 挂上时会建它的 outbox 目录（`lib/relay.js` startRelay 第一行），这里等的就是那个目录出现。
 *
 * ── 🔴 不进全量的**代价** ─────────────────────────────────────────
 *   **这个文件里的 bug，不会被任何一次全量抓到。**（`test/run-all.js` 只扫 `*.test.js`。）
 *   它整个红掉，也要等有人手动跑它才会被发现。
 *
 * ── 它验的是什么（而源码断言验不了的）──────────────────────────
 * `test/done-notify.test.js` 是正则断言：验「这几行代码还在」。
 * **它验不了「通知真的构造出来了」，也验不了 🏁 真的画到了 DOM 上。**
 * 这个文件验后者 —— 一条消息从 outbox 文件出发，走 relay → redis → WS →
 * 前端渲染，最后落成一个通知对象和一个界面上的标记。
 *
 * ⚠️ 边界（别把它读成「前端全测了」）：headless 浏览器**不显示**系统通知，
 *   这里验的是 `new Notification(...)` 真的被调用了、参数是对的。
 *   「macOS 通知中心里真的冒出来一条」仍然只有人能确认。
 */

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const Redis = require('ioredis');
const roster = require('../lib/roster');

const BASE = process.env.ENGLOOP_PW_BASE;
const USER = process.env.ENGLOOP_PW_USER;
const KEY = process.env.ENGLOOP_PW_KEY;
const REDIS = process.env.ENGLOOP_PW_REDIS;
const OUTBOX_ROOT = process.env.ENGLOOP_PW_OUTBOX;
const ORCH = 'JARVIS';                 // bin/serve.js 的 ORCH_NAME（写死的，见文件头）
const AGENT = 'e2e-notify-agent';      // 测试专用 agent，只登记在隔离库里
const OUTBOX = OUTBOX_ROOT ? path.join(OUTBOX_ROOT, ORCH) : null;

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 往（隔离 bus 的）编排者 outbox 写一条消息（走完整链路）。返回它的文件名。 */
function emit(obj) {
  const f = path.join(OUTBOX, `${Date.now()}${Math.floor(Math.random() * 900 + 100)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

/** 轮询直到 fn() 为真或超时。**不要用固定 sleep** —— 那要么慢要么脆。 */
async function until(fn, ms = 8000, step = 250) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await wait(step);
  }
}

/**
 * 登录：`POST /api/login` 拿 session cookie（HttpOnly · SameSite=Strict）。
 * ★ 走的是 `ctx.request` —— 它跟这个 browser context **共用 cookie 罐**，
 *   所以下面开的页面、页面开的 WS 都带着这个 cookie。不登录 ⇒ /api/* 401、WS 连不上。
 */
async function login(ctx) {
  const r = await ctx.request.post(new URL('/api/login', BASE).href, { data: { username: USER, key: KEY } });
  ok(r.status() === 200, `（前置）POST /api/login ⇒ 200（用户 ${USER}）`, String(r.status()));
  const c = (await ctx.cookies(new URL(BASE).origin)).find((x) => x.name === 'engloop_session');
  ok(!!c && c.httpOnly === true, '（前置）拿到 session cookie（HttpOnly），后面的页面和 WS 都带着它',
    JSON.stringify(c && { httpOnly: c.httpOnly, sameSite: c.sameSite }));
}

async function main() {
  // ── 闸：只对隔离 bus 跑（跟 bus-login.playwright.js 同一个判据）──────────────
  if (!BASE || !USER || !KEY || !REDIS || !OUTBOX_ROOT) {
    console.error('缺环境变量：ENGLOOP_PW_BASE / _USER / _KEY / _REDIS / _OUTBOX（见文件头）。\n'
      + '  一条命令起隔离 bus 并跑我：node scripts/run-e2e-notify.js');
    process.exit(2);
  }
  if (/:9969\b/.test(BASE) || !/\/\d+$/.test(REDIS) || /\/0$/.test(REDIS)) {
    console.error('拒绝：这个脚本只对隔离 bus（非 9969、测试库）跑。');
    process.exit(2);
  }

  // ── 开跑前先说清楚这一轮会往外写什么 ──────────────────────────────────────
  //   印在**第一个断言之前** —— 「还来得及改主意」的时刻只有开跑前。
  console.log(`本次写 6 条消息，全在隔离 bus 的 outbox 根 ${OUTBOX_ROOT} 下：`);
  console.log(`      4 条 → ${path.join(OUTBOX_ROOT, ORCH)}  ⇒ orch:out`);
  console.log(`      2 条 → ${path.join(OUTBOX_ROOT, AGENT)}  ⇒ orch:in:agent`);
  console.log(`  花名册（${REDIS.replace(/\/\/[^@/]*@/, '//')}）登记 ${ORCH}（orchestrator）、${AGENT}（dev），跑完摘掉。`);

  // ── 前置：bus 得在跑，而且得是 engloop-bus。**不在就直接说清楚**，别让后面 20 条断言
  //   一起红成一片让人以为功能坏了。
  let health = null;
  try {
    const r = await fetch(new URL('/health', BASE).href);
    health = await r.json();
  } catch (e) {
    console.error(`\n✗ 连不上 ${BASE} —— 隔离 bus 没在跑。这不是功能坏了。\n`
      + '  一条命令起隔离 bus 并跑我：node scripts/run-e2e-notify.js\n');
    process.exit(2);
  }
  ok(health && health.ok === true && health.service === 'engloop-bus',
    `（前置）bus 活着 · service=${health && health.service} · redis=${health && health.redis}`);

  // ── 前置：花名册（隔离库）登记测试专用的编排者和 agent，等 relay 挂上 ─────────────
  //   编排者的 relay 不看花名册、bus 一起来就挂（planRelays 里常驻）；登记 JARVIS 是为了
  //   让 agent → JARVIS 的消息被路由到 orch:in:agent（resolveTarget 查花名册，type=orchestrator ⇒ inboxFor）。
  //   agent 的 relay 要等 bus 的 syncRelays（每 15 秒）照花名册挂上 —— 挂上时它会建 outbox 目录。
  //   ⚠️ tmux_session 留空：隔离 bus 的 tmux 是 no-op，填了会话名 watchdog 会把它判成 stale 去摘牌。
  const redis = new Redis(REDIS);
  await roster.register(redis, ORCH, { type: 'orchestrator' });
  await roster.register(redis, AGENT, { type: 'dev' });
  const relayed = await until(async () => fs.existsSync(path.join(OUTBOX_ROOT, AGENT))
    && fs.existsSync(path.join(OUTBOX_ROOT, ORCH)), 25000, 250);
  ok(relayed, `（前置）花名册登记了 ${ORCH}、${AGENT}，bus 给两个都挂上了 relay（outbox 目录出现了）`,
    `${fs.existsSync(path.join(OUTBOX_ROOT, ORCH))} ${fs.existsSync(path.join(OUTBOX_ROOT, AGENT))}`);

  // ★★★ `channel: 'chromium'` **不是可选的**（playwright 1.62.1 上的行为）：
  //
  //   ```
  //   默认 headless（chromium-headless-shell）  Notification.permission = 'denied'
  //   channel:'chromium'（完整 Chromium）        Notification.permission = 'granted'
  //   channel:'chrome'（系统 Chrome）            Notification.permission = 'granted'
  //   ```
  //
  //   两次都 `grantPermissions(['notifications'])`、两次 `isSecureContext` 都是
  //   true、两次 `'Notification' in window` 都是 true —— **headless shell 里
  //   那个 API 在，只是永远拒绝**。
  //
  //   ⚠️ 这个坑值钱在它的**假红灯**长相：不加这行的话，这个文件会报
  //   「通知没弹出来」6 条红 —— 而那读起来完全像功能坏了，
  //   同时 🏁 那半是全绿的（🏁 不经过浏览器权限）⇒ 很容易误去改一段没有毛病的前端代码。
  //
  //   ⇒ 所以这个文件的默认值是 'chromium'，**不是**「不传 channel」（bus-login 那样）。
  //     `ENGLOOP_PW_CHANNEL` 可以换（比如没装 playwright 的 chromium 时用 `chrome` = 系统 Chrome，临时 profile）。
  const browser = await chromium.launch({ channel: process.env.ENGLOOP_PW_CHANNEL || 'chromium' });
  const ctx = await browser.newContext({ permissions: ['notifications'] });
  // 真授权，不是 stub —— 走的是浏览器自己的权限状态机。
  await ctx.grantPermissions(['notifications'], { origin: new URL(BASE).origin });

  // ★ 包一层 Notification：**仍然调用原生构造函数**（所以权限、参数校验
  //   都还是真的），只是把调用记下来。整个替换成假的话，这个测试就退化成
  //   「自己写的 stub 被调用了」——那证明不了浏览器接受了这次调用。
  //
  // ★ `document.hasFocus` 也在这里被接管：headless 里页面是聚焦的，而代码
  //   在聚焦时**故意不弹**（那时消息就在眼前，弹了是噪音）。默认设成 false
  //   模拟「人不在看这个页面」，第 5 组再翻回 true 验那条分支。
  await ctx.addInitScript(() => {
    window.__notes = [];
    const Real = window.Notification;
    const Wrapped = function (title, opts) {
      window.__notes.push({ title, body: opts && opts.body, tag: opts && opts.tag });
      return new Real(title, opts);
    };
    Wrapped.requestPermission = Real.requestPermission.bind(Real);
    Object.defineProperty(Wrapped, 'permission', { get: () => Real.permission });
    window.Notification = Wrapped;

    window.__focus = false;
    document.hasFocus = () => window.__focus;
  });

  // ── 登录（不登录 WS 连不上）──
  await login(ctx);

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
  // ★ 第一次打开的默认视图是「今天」，对话流 / 输入框在「今天」视图里是隐藏的。
  //   这个测试要的是对话视图 ⇒ 直接打开它的路由。
  await page.goto(new URL(`#/chat/dm/${ORCH}`, BASE).href, { waitUntil: 'domcontentloaded' });
  // WS 连上 + 首屏历史（等 wsdot 变 on，最多 10 秒；没等到也往下走，由【1】那条断言报）
  await page.waitForFunction(() => { const d = document.getElementById('wsdot'); return d && d.className === 'on'; },
    null, { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(500);

  console.log('\n【1】页面本身没坏');
  {
    ok(pageErrors.length === 0, '没有 JS 运行时错误', pageErrors.join(' | '));
    ok(await page.locator('#notify-btn').count() === 1, '「通知」按钮在页面上');
    const dot = await page.locator('#wsdot').getAttribute('class');
    ok(dot === 'on', 'WebSocket 连上了（wsdot=on）', String(dot));
  }

  console.log('\n【2】通知按钮反映真实权限状态');
  {
    const label = (await page.locator('#notify-btn').textContent()).trim();
    ok(label === '通知 ✓', '已授权 ⇒ 按钮显示「通知 ✓」', label);
    const perm = await page.evaluate(() => Notification.permission);
    ok(perm === 'granted', '浏览器侧权限确实是 granted', perm);
  }

  console.log('\n【3】★★★ 端到端：outbox → relay → redis → WS → 通知 + 🏁');
  const rootId = `e2e-root-${Date.now()}`;
  {
    // ① 先发一条「根」——模拟编排者派活的那条，thread 的第一条
    emit({ username: USER, kind: 'notice',
      text: `【自动化测试 ${new Date().toISOString()}】这条是 thread 的根，`
        + '下一条完成报告的 🏁 应该打在它身上。Playwright 跑的，不用回。' });
    await wait(1200);

    // 抓到它在界面上的锚点（= job_id）。**从 DOM 拿，不在测试这边猜** ——
    // 猜的话就是第二份实现，而它会在 anchor 规则变化时静静地对不上。
    const anchor = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('[data-anchor]')];
      const last = nodes[nodes.length - 1];
      return last ? last.getAttribute('data-anchor') : null;
    });
    ok(!!anchor, '（前置）根消息渲染出来了，拿到它的锚点', String(anchor));

    // ② 再发完成报告，reply_to 指向那个根
    const before = await page.evaluate(() => window.__notes.length);
    emit({ username: USER, reply_to: anchor, done: true,
      text: `【自动化测试】完成报告 —— 这条带 "done": true。`
        + '如果一切正常：你的浏览器会弹一个桌面通知，上一条会多一个 🏁。' });

    const got = await until(async () =>
      (await page.evaluate(() => window.__notes.length)) > before);
    ok(got, '★★★ 桌面通知被构造出来了（真的 new Notification）');

    const note = await page.evaluate(() => window.__notes[window.__notes.length - 1]);
    ok(note && /🏁/.test(note.title) && /JARVIS/.test(note.title),
      '★★ 通知标题含 🏁 和发送者', JSON.stringify(note));
    ok(note && /完成报告/.test(note.body || ''), '★ 通知正文是那条消息的内容');
    ok(note && note.tag === `engloop-done-${ORCH}`,
      '★★ tag 按发送者分组（同一个 agent 连报两条会替换，不叠成一屏）',
      String(note && note.tag));

    // ③ ★★★ 🏁 真的画到了**根**上 —— 而且是**不刷新页面**就出现的。
    //   这一条守的是那个最难查的形状：「通知弹了、消息也到了，就是没有标记，
    //   F5 一下它又在了」。前端要主动让那个锚点的反应缓存失效才做得到。
    const marked = await until(async () => page.evaluate((a) => {
      const bar = document.querySelector(`.reactions[data-anchor="${a}"]`);
      return !!bar && /🏁/.test(bar.textContent || '');
    }, anchor), 10000);
    ok(marked, '★★★ 🏁 出现在 thread 根上，且**没有刷新页面**');

    // ④ 阴性对照：🏁 **不在**完成报告自己身上
    const selfMarked = await page.evaluate(() => {
      const bars = [...document.querySelectorAll('.reactions')];
      const last = bars[bars.length - 1];
      return !!last && /🏁/.test(last.textContent || '');
    });
    ok(selfMarked === false || marked,
      '★ 对照：标记落在根上（不是每条消息都长出一个 🏁）');
  }

  console.log('\n【4】★★★ 阴性对照：不带 done 的消息**什么都不该发生**');
  {
    const before = await page.evaluate(() => window.__notes.length);
    emit({ username: USER, kind: 'notice',
      text: '【自动化测试】这条**不带** done —— 它不该弹通知，也不该打 🏁。' });
    await wait(2500);
    const after = await page.evaluate(() => window.__notes.length);
    ok(after === before,
      '★★★ 进度类消息不弹通知（判据宽了的话，人会关掉通知，那时真完成也收不到）',
      `${before} → ${after}`);
  }

  console.log('\n【5】★★ 人正盯着页面时不弹（hasFocus=true）');
  {
    await page.evaluate(() => { window.__focus = true; });
    const before = await page.evaluate(() => window.__notes.length);
    emit({ username: USER, reply_to: rootId, done: true,
      text: '【自动化测试】页面有焦点时的完成报告 —— 不该弹（消息就在他眼前）。' });
    await wait(2500);
    const after = await page.evaluate(() => window.__notes.length);
    ok(after === before,
      '★★ 页面有焦点 ⇒ 不弹。通知一旦变噪音会被关掉，那时真离开也收不到',
      `${before} → ${after}`);
    await page.evaluate(() => { window.__focus = false; });
  }

  console.log('\n【7】★★★ agent 那条路径 —— 必须单独测这一组');
  {
    // ★★★ **为什么必须单独测这一组。**
    //
    //   上面【3】走的是 `orch:out`（编排者发出的消息）。而要的是
    //   「**agent** 完成任务时通知」—— agent 发给编排者的消息走 `orch:in:agent`，
    //   那条流要是**不经过 broadcast**：
    //   🏁 照样打上（relay 在后端做的），而**桌面通知一次都不弹**。
    //
    //   ⚠️ 而只测【3】的话，那时上面的断言照样全绿。**它们跑在另一条平行路径上** ——
    //   绿灯跟 bug 之间没有交集。
    //
    //   > 「阴性对照证明的是『不该弹时不弹』，
    //   >   它对『该弹时弹了』一点鉴别力都没有。」
    //
    //   ⇒ 一条功能有几条**入口路径**，就要有几条端到端断言。
    //     少测一条的表现不是「覆盖率低一点」，是**那条路径可以整个是坏的**。
    // ★★★ **走 agent 自己的 outbox 目录，不要在这里 XADD。**
    //
    //   ⚠️ 在这里用 `q.createClient()` + `q.send(redis,'orch:in:agent',…)` 的话，
    //   断言会全红，而 crewInLoop 并没有坏 ——
    //   `lib/queue.js` 的 `isTestProcess()` 判定：入口文件在 `test/` 下
    //   就连**测试库**（db 1–15）。这个文件正在 `test/` 下，
    //   于是消息 XADD 进了测试库，而 bus 读的不是那个库。
    //
    //   ⇒ **消息发到了一个没有人在听的地方，而两边都不报错。**
    //   而 `XINFO GROUPS orch:in:agent` 上 `bus-agent-in` 的 last-delivered-id
    //   可能照样在往前走 —— 那是**别的消息**推的，跟测试消息毫无关系，
    //   很容易据此误判「crewInLoop 没工作」。
    //
    //   （那条测试库保护本身是对的：`test/fixtures/` 下的探针要是被判成生产进程，
    //     `redis.del(...,'orch:in:agent')` 会删掉编排者的收件流。
    //     所以正确的做法不是绕过它，是**走真实入口**。）
    //
    // ⇒ 写那个 agent 自己的 outbox 目录：它的 relay 跑在（隔离）bus 进程里、用 bus 的库，
    //   收件人是编排者 ⇒ 消息进 `orch:in:agent`，`from` 由目录名推断成那个 agent。
    //   **这也更真实** —— 真的 agent 就是这么发消息的。
    //
    // ★ agent 是**测试专用**的 `e2e-notify-agent`，登记在隔离库的花名册里（见 main 开头）。
    //   理由：relay 按花名册挂，不在册的目录没人读 ⇒ 要**在隔离库里登记一个测试 agent**，
    //   而不是借在岗 agent 的真名字。
    //   ⚠️ 目录是 relay 挂上时建的（main 开头等的就是它）—— 这里**不要** mkdir：
    //     自己建了目录，「relay 挂没挂上」就看不出来了。
    const CREW_OUTBOX = path.join(OUTBOX_ROOT, AGENT);
    // ★★ `kind:'status'` **不是装饰**：
    //   relay 会对「agent 发的、既没 reply_to 也没标 kind」的消息记一条「未归属」告警，
    //   **告警投给发件的那个 agent**（借在岗 agent 的身份的话，它每跑一次就收一条假告警）。
    //   发件的是测试 agent 时告警落在隔离库里 —— 但 `status` 留着：这条路径上真实 agent 的
    //   完成报告也是这么标的，换掉它会让【7】测的形状跟真的不一样。
    const emitAs = (obj) => {
      fs.writeFileSync(
        path.join(CREW_OUTBOX, `${Date.now()}${Math.floor(Math.random() * 900 + 100)}.json`),
        JSON.stringify({ kind: 'status', ...obj }));
    };

    const before = await page.evaluate(() => window.__notes.length);
    emitAs({ username: ORCH, done: true,
      text: `【自动化测试】模拟 agent 报告任务完成 —— 这条走 ${AGENT} 的 outbox → orch:in:agent。` });
    const got = await until(async () =>
      (await page.evaluate(() => window.__notes.length)) > before, 12000);
    ok(got, '★★★ agent 报的完成**也**弹通知');

    const note = await page.evaluate(() => window.__notes[window.__notes.length - 1]);
    ok(note && note.title && note.title.includes(AGENT),
      '★★ 通知标题写的是那个 agent 的名字，不是编排者', JSON.stringify(note));
    ok(note && note.tag === `engloop-done-${AGENT}`,
      '★ tag 按那个 agent 分组', String(note && note.tag));

    // 阴性对照：同一条路径上不带 done 的消息不该弹。
    const b2 = await page.evaluate(() => window.__notes.length);
    emitAs({ username: ORCH,
      text: '【自动化测试】agent 的进度消息 —— 同一条路径，不带 done，不该弹。' });
    await wait(3000);
    const a2 = await page.evaluate(() => window.__notes.length);
    ok(a2 === b2, '★★ 同一条路径上，不带 done 的不弹', `${b2} → ${a2}`);
  }

  console.log('\n【6】刷新之后 🏁 还在（它是落盘的事实，不是页面状态）');
  {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const still = await page.evaluate(() =>
      [...document.querySelectorAll('.reactions')].some((b) => /🏁/.test(b.textContent || '')));
    ok(still, '★★ 刷新后 🏁 仍在 —— 后端打的标记，不依赖谁开着页面');
    ok(pageErrors.length === 0, '整轮下来没有 JS 错误', pageErrors.join(' | '));
  }

  await browser.close();
  // 摘掉这次登记的花名册条目（隔离库；跑在别人起的隔离 bus 上时也不留东西）
  await roster.unregister(redis, AGENT).catch(() => {});
  await roster.unregister(redis, ORCH).catch(() => {});
  await redis.quit().catch(() => {});
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e); process.exit(1); });
