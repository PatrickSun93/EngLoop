'use strict';

/**
 * 「泳道」视图的 e2e。
 *
 *   node test/web-lanes.playwright.js
 *
 * ★ 连的是**预览服务器**（`scripts/web-preview.js`，随机端口、夹具），**绝不连 9969**。服务器在这个进程里起、跑完关掉。
 * ★ Mac 上 playwright 用系统 Chrome（`channel: 'chrome'`），不下载浏览器。
 * ⚠️ 跟另外几个 `*.playwright.js` 一样**不进 `test/run-all.js`**（它只收 `*.test.js`）。要跑就单独跑这一个文件。
 * ⚠️ 预览服务器的写操作回 200 `{ok:true, preview:true}`，而页面认的是 202 —— 所以「发出去了没有」在预览里
 *   一律显示成没发出去。要看本地回显的那几条用 `page.route` 回一个 202（照 bin/serve.js 的形状），
 *   要验「请求路径对不对」的那条照原样打到预览服务器上。
 *
 * 守的：
 *   L1 失联那一列有救援面板，「复制 attach 命令」能点（剪贴板里是那条命令）；没有 tmux_session 的不显示这个按钮
 *   L2 点窄栏里的限额砖 ⇒ 展开成一列；跨过一次 5 秒重绘仍是展开的；刷新后还是展开的（localStorage）
 *   L3 命令条选「#eng-loop」⇒ 发送 ⇒ 预览服务器收到 POST /api/rooms/<hash>/post（不是 /api/message）
 *   L4 焦点在 agent 列时，命令条目标没变，灰字提示出现；发出去的正文原样（不加 @dev）；本地回显出现在编排者那一列
 *   L5 messages-error 场景：报错的那一列写「查不了」，其余列正常；拉失败时保留旧内容并标上「这是 HH:MM 的内容」
 *   L6 390 宽：tab 切换列，没有整页横向滚动
 * 另外顺手看的：
 *   L7 命令条不截 Tab；Alt+↑↓ 换目标
 *   L8 XSS：正文里的 <img onerror> 被转义（泳道 + 派活行）
 *   L9 超过 6 行的正文折起来；「展开」扛得住 5 秒重绘
 *   L10 编排者那一列的派活行只有 JARVIS 派的（senior 发给 dev 的不算）
 *   L11 agents-error / blind：不画列，画「查不了」
 */

const path = require('node:path');
const { chromium } = require('playwright');
const preview = require(path.join(__dirname, '..', 'scripts', 'web-preview.js'));

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const ENG = 'eng-loop-7f3a9c21d0b4';
const lane = (n) => `#lanes .lane[data-lane="${n}"]`;
const isMsgs = (to) => (u) => u.pathname === '/api/messages' && u.searchParams.get('to') === to;

async function openLanes(browser, url, scenario, viewport = { width: 1440, height: 900 }, before = null) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (before) await before(page);
  await page.goto(`${url}?scenario=${scenario}#/lanes`);
  return { ctx, page, errors };
}

async function main() {
  const srv = await preview.start({ port: 0 });
  if (srv.port === preview.BUS_PORT) throw new Error('预览服务器落到了 9969 —— 不该发生');
  console.log(`预览服务器：${srv.url}（不是 bus）`);
  const origin = srv.url.replace(/\/$/, '');
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const { ctx, page, errors } = await openLanes(browser, srv.url, 'normal');
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await page.waitForSelector(`${lane('dev3')} .rescue`);
    await page.waitForSelector(`${lane('dev')} .le`);
    await page.waitForTimeout(800);   // 预载的房间历史回来

    console.log('\n【L0】谁有列、什么顺序');
    {
      const names = await page.$$eval('#lanes .lane', (ns) => ns.map((n) => n.dataset.lane));
      ok(names[0] === 'JARVIS' && names[1] === 'dev3', '★★ 编排者第一，失联的紧跟其后', names.join(','));
      ok(!names.includes('dev2'), '★★★ 撞限额的 dev2 **不在**列里', names.join(','));
      ok(await page.locator('#lanes-dock .tile[data-agent="dev2"]').count() === 1, '★★ dev2 在右侧窄栏里');
    }

    console.log('\n【L1】失联那一列：救援面板 · 复制 attach 命令 · 还能滚、还能选中文字');
    {
      const r = page.locator(`${lane('dev3')} .rescue`);
      const txt = await r.textContent();
      ok(/没读队列/.test(txt) && txt.includes('会话在，不在花名册 —— 轮询已停'), '★★ 标题「… 没读队列」，正文是 STATUS.deaf.note（不另写）', txt);
      const btn = r.getByRole('button', { name: '复制 attach 命令' });
      ok(await btn.count() === 1, '★★ 有「复制 attach 命令」');
      ok(await r.getByRole('button', { name: '私聊 JARVIS' }).count() === 1, '★ 有「私聊 JARVIS」');
      ok(await r.getByRole('button', { name: /打开 tmux|存下 pane/ }).count() === 0, '★ 没有「打开 tmux」「存下 pane」（浏览器做不到）');
      await btn.click();
      const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => 'ERR ' + e.message);
      ok(clip === 'tmux attach -t engloop_dev3', '★★★ 点了之后剪贴板里是那条命令', clip);
      const log = await page.locator(`${lane('dev3')} .log`).evaluate((n) => {
        const s = getComputedStyle(n);
        return { oy: s.overflowY, us: s.userSelect, op: Number(s.opacity), filter: s.filter };
      });
      ok(log.oy === 'auto' && log.us !== 'none' && log.op < 1 && log.filter === 'none',
        '★★ 内容变灰（opacity，不用 filter），但还能滚、还能选中文字', JSON.stringify(log));
      // 救援面板不盖住内容：日志区的底边在面板的顶边之上
      const lb = await page.locator(`${lane('dev3')} .log`).boundingBox();
      const rb = await r.boundingBox();
      ok(lb && rb && lb.y + lb.height <= rb.y + 1, '★ 救援面板压在底部，不盖住内容', JSON.stringify([lb, rb]));
    }
    {
      // 没有 tmux_session ⇒ 不显示按钮（用 route 改 /api/agents 的那一份）
      const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p2 = await c2.newPage();
      await p2.route((u) => u.pathname === '/api/agents', async (route) => {
        const res = await route.fetch();
        const d = await res.json();
        for (const a of d.deaf || []) delete a.tmux_session;
        await route.fulfill({ response: res, json: d });
      });
      await p2.goto(`${srv.url}?scenario=normal#/lanes`);
      await p2.waitForSelector(`${lane('dev3')} .rescue`);
      ok(await p2.locator(`${lane('dev3')} .rescue`).getByRole('button', { name: '复制 attach 命令' }).count() === 0,
        '★★★ 没有 tmux_session ⇒ 不显示「复制 attach 命令」');
      ok(await p2.locator(`${lane('dev3')} .rescue`).getByRole('button', { name: '私聊 JARVIS' }).count() === 1, '★ 「私聊 JARVIS」照样在');
      await c2.close();
    }

    console.log('\n【L2】点窄栏的限额砖 ⇒ 展开成一列；跨过一次 5 秒重绘仍是展开的；刷新后还在');
    {
      await page.locator('#lanes-dock .tile[data-agent="dev2"]').click();
      await page.waitForSelector(lane('dev2'));
      ok(await page.locator(lane('dev2')).isVisible(), '★★ dev2 展开成了一列');
      ok(await page.locator('#lanes-dock .tile[data-agent="dev2"]').getAttribute('aria-pressed') === 'true', '★ 砖是按下的');
      const cls = await page.locator(lane('dev2')).getAttribute('class');
      ok(/limit/.test(cls) && !/deaf|lost/.test(cls), '★★ 它是紫色那一档（limit），不是失联的红', cls);
      await page.waitForTimeout(6000);
      ok(await page.locator(lane('dev2')).isVisible(), '★★★ 6 秒后（跨过一次 5 秒重绘）仍然是展开的');
      await page.reload();
      await page.waitForSelector(`${lane('dev')} .le`);
      ok(await page.locator(lane('dev2')).count() === 1, '★★ 展开状态存 localStorage：刷新后还在');
      await page.locator(lane('dev2')).getByRole('button', { name: '收回' }).click();
      ok(await page.locator(lane('dev2')).count() === 0, '★ 「收回」⇒ 收回窄栏');
      await page.waitForTimeout(800);
    }

    console.log('\n【L3】命令条选「#eng-loop」⇒ 发送 ⇒ 预览服务器收到 POST /api/rooms/<hash>/post');
    {
      const opts = await page.$$eval('#cmd-target option', (os) => os.map((o) => o.textContent));
      ok(opts[0] === '@JARVIS（私聊）' && opts.slice(1).every((t) => t.startsWith('#')),
        '★★★ 目标只有编排者和房间，没有 agent', opts.join(' | '));
      await page.selectOption('#cmd-target', `room:${ENG}`);
      ok((await page.locator('#cmd-to').textContent()) === '发到 #eng-loop', '★★ 收件人提示：「发到 #eng-loop」');
      const posts = [];
      page.on('request', (rq) => { if (rq.method() === 'POST' && /\/api\/(message|rooms\/)/.test(rq.url())) posts.push(rq); });
      await page.locator('#cmd-input').fill('L3：发到房间');
      const [rq] = await Promise.all([
        page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/rooms/')),
        page.locator('#cmd-send').click(),
      ]);
      const res = await rq.response();
      const body = res ? await res.json() : null;
      ok(new URL(rq.url()).pathname === `/api/rooms/${ENG}/post`, '★★★ 路径是 /api/rooms/<hash>/post', rq.url());
      ok(!!body && body.ok === true && body.preview === true, '★ 预览服务器回 {ok:true, preview:true}', JSON.stringify(body));
      const pd = rq.postDataJSON();
      ok(pd && pd.text === 'L3：发到房间' && !('reply_to' in pd) && !('from' in pd), '★★ 只发顶层消息（不带 reply_to、不自报 from）', JSON.stringify(pd));
      await page.waitForTimeout(300);
      ok(posts.length === 1 && !posts.some((r) => r.url().includes('/api/message')), '★★ 没有往 /api/message 发', posts.map((r) => r.url()).join(' '));
      // 预览回的是 200 不是 202 ⇒ 页面按「没发出去」处理：字还给输入框（跟 composer 同一份 sendTo）
      ok((await page.locator('#cmd-input').inputValue()) === 'L3：发到房间', '★ （预览回 200 ≠ 202）字还在输入框里 —— 跟 composer 同一套失败处理');
      ok(/没发出去/.test(await page.locator('#cmd-status').textContent()), '★ 命令条下面说了「没发出去」');
      // 记住的目标：刷新后还是 #eng-loop
      await page.reload();
      await page.waitForSelector(`${lane('dev')} .le`);
      ok((await page.$eval('#cmd-target', (s) => s.value)) === `room:${ENG}`, '★ 上次选的目标存 localStorage：刷新后还是 #eng-loop');
      await page.selectOption('#cmd-target', 'dm:JARVIS');
    }

    console.log('\n【L4】焦点在 agent 列 ⇒ 目标不变、灰字提示；正文原样发出；本地回显进编排者那一列');
    {
      const before = await page.$eval('#cmd-target', (s) => s.value);
      ok(await page.locator('#cmd-hint').isHidden(), '（前置）焦点不在 agent 列时没有灰字');
      await page.locator(`${lane('dev')} .log`).click();
      ok((await page.$eval('#cmd-target', (s) => s.value)) === before, '★★★ 命令条目标没变', before);
      ok(await page.locator('#cmd-hint').isVisible() && (await page.locator('#cmd-hint').textContent()) === '要给 dev 派活，发给 JARVIS',
        '★★★ 灰字「要给 dev 派活，发给 JARVIS」', await page.locator('#cmd-hint').textContent());
      ok(/focus/.test(await page.locator(lane('dev')).getAttribute('class')), '★ dev 那一列标成焦点');
      // 发出去：用 route 回 202（bin/serve.js 的形状：{ok, job_id}）—— 这条只验正文和本地回显
      const isMsgPost = (u) => u.pathname === '/api/message';
      await page.route(isMsgPost, (route) => route.fulfill({
        status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, job_id: 'j-l4-echo', id: '1799999999999-0' }) }));
      await page.locator('#cmd-input').fill('L4：看一下 dev 的全量');
      const [rq] = await Promise.all([
        page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/message'),
        page.locator('#cmd-send').click(),
      ]);
      const pd = rq.postDataJSON();
      ok(pd && pd.text === 'L4：看一下 dev 的全量', '★★★ 正文原样发出去（没有自动加 @dev）', JSON.stringify(pd));
      await page.waitForSelector(`${lane('JARVIS')} .le.in >> text=L4：看一下 dev 的全量`);
      ok(await page.locator(`${lane('JARVIS')} .le.in`, { hasText: 'L4：看一下 dev 的全量' }).count() === 1, '★★ 本地回显出现在编排者那一列（Patrick → JARVIS）');
      ok(/已发到 @JARVIS/.test(await page.locator('#cmd-status').textContent()), '★ 命令条下面写「已发到 @JARVIS」');
      ok((await page.locator('#cmd-input').inputValue()) === '', '★ 发出去之后输入框清空');
      await page.unroute(isMsgPost);
    }

    console.log('\n【L7】命令条不截 Tab；Alt+↑↓ 换目标');
    {
      await page.locator('#cmd-input').focus();
      await page.keyboard.press('Tab');
      ok(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'cmd-send', '★★★ 在输入框里按 Tab ⇒ 焦点走到「发送」（没被截走）',
        await page.evaluate(() => document.activeElement && document.activeElement.id));
      await page.locator('#cmd-input').focus();
      await page.keyboard.press('Shift+Tab');
      ok(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'cmd-target', '★★ Shift+Tab ⇒ 回到目标选择（<select>，Tab 走得到）');
      const v0 = await page.$eval('#cmd-target', (s) => s.value);
      await page.locator('#cmd-input').focus();
      await page.keyboard.press('Alt+ArrowDown');
      const v1 = await page.$eval('#cmd-target', (s) => s.value);
      ok(v0 === 'dm:JARVIS' && v1 === `room:${ENG}` && (await page.locator('#cmd-to').textContent()) === '发到 #eng-loop',
        '★ Alt+↓ ⇒ 换到下一个目标（提示跟着变）', `${v0} → ${v1}`);
      await page.keyboard.press('Alt+ArrowUp');
      ok((await page.$eval('#cmd-target', (s) => s.value)) === 'dm:JARVIS', '★ Alt+↑ ⇒ 换回来');
    }

    console.log('\n【L9】超过 6 行的正文折起来；「展开」扛得住 5 秒重绘');
    {
      const b = page.locator(`${lane('JARVIS')} .unfold`).first();
      ok(await b.count() === 1 && /展开（共 \d+ 行）/.test(await b.textContent()), '★★ 长消息（senior 的 8 行审阅意见）有「展开」', await b.textContent().catch(() => ''));
      const tx = page.locator(`${lane('JARVIS')} .le`, { has: page.locator('.unfold') }).locator('.tx');
      ok(/fold/.test(await tx.getAttribute('class')), '（前置）默认是折起来的');
      await b.click();
      ok(!/fold/.test(await tx.getAttribute('class')), '★ 点了展开');
      await page.waitForTimeout(6000);
      ok(!/fold/.test(await page.locator(`${lane('JARVIS')} .le`, { has: page.locator('.unfold') }).locator('.tx').getAttribute('class'))
        && (await page.locator(`${lane('JARVIS')} .unfold`).first().textContent()) === '收起', '★★★ 6 秒后仍然是展开的');
    }

    console.log('\n【L10】编排者那一列的派活行只有 JARVIS 派的');
    {
      const disp = await page.$$eval(`${lane('JARVIS')} .le.disp`, (ns) => ns.map((n) => n.textContent));
      ok(disp.some((t) => t.includes('→ dev') && t.includes('W1 合入后跑一遍全量')), '★★★ 有「→ dev」的派活行（从 dev 的收件流并进来的）', disp.join(' | '));
      ok(disp.some((t) => t.includes('→ senior')) && disp.some((t) => t.includes('→ dev3')), '★★ senior、dev3 的派活也在', disp.join(' | '));
      ok(!disp.some((t) => t.includes('那两条红')), '★★★ senior 发给 dev 的那条**不在**编排者那一列（不是派活）');
      ok(await page.locator(`${lane('dev')} .le.in`, { hasText: '那两条红' }).count() === 1, '★ 它在 dev 那一列里（senior → dev）');
      // 去重：dev 在 #eng-loop 说的「开始了，预计 12 分钟。」也扇出进了 orch:in:agent —— dev 那一列只出一次
      ok(await page.locator(`${lane('dev')} .le`, { hasText: '开始了，预计 12 分钟。' }).count() === 1, '★★ 同一条从两处来（房间流 + 扇出进收件流）只出一次');
      ok(await page.locator(`${lane('dev')} .ldone`, { hasText: '已提交核验' }).count() >= 1, '★★ pending 的完成报告写「已提交核验」');
      ok(await page.locator('#lanes .ldone', { hasText: /核验中/ }).count() === 0, '★★ 泳道里没有「核验中」');
      ok(await page.locator(`${lane('dev')} .le.sysl`, { hasText: '核验结论：已独立核验' }).count() >= 1, '★ 核验跟帖是灰色系统行「核验结论：…」');
      const info = await page.locator(`${lane('JARVIS')} .lh .info`).getAttribute('title');
      ok(/已加载的 \d+ 个房间/.test(info) && /并进了 .*dev/.test(info) && info.includes('它发给其它 agent 的消息由 relay 直接投进对方的收件流'),
        '★★ ⓘ 写了覆盖范围：coverage_note 原样、房间个数、并了哪几个 agent', info);
    }
    ok(errors.length === 0, '页面没有抛错', errors.join(' | '));
    await ctx.close();

    console.log('\n【L8】XSS：正文里的 <img onerror> 被转义');
    {
      const { ctx: c, page: p, errors: e8 } = await openLanes(browser, srv.url, 'normal', undefined, async (p) => {
        await p.route(isMsgs('qa'), (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          name: 'qa', registered: true, type: 'qa', count: 100, sources: [], coverage_note: 'x',
          messages: [{ id: '1790000099000-0', stream: 'agent:qa:in', direction: 'in', from: 'JARVIS', to: 'qa', job_id: 'j-xss',
            timestamp: new Date().toISOString(), text: '<img src=x onerror="window.__xss=1">**粗**\n<script>window.__xss=2</script>' }] }) }));
      });
      await p.waitForSelector(`${lane('qa')} .le`);
      await p.waitForSelector(`${lane('JARVIS')} .le.disp >> text=→ qa`);
      await p.waitForTimeout(500);
      ok(await p.locator('#lanes img').count() === 0 && await p.locator('#lanes script').count() === 0, '★★★ 泳道里没有 <img> / <script> 元素（被转义成文字）');
      ok((await p.locator(`${lane('qa')} .tx`).first().textContent()).includes('<img src=x'), '★★ 原文按文字显示出来');
      ok(await p.locator(`${lane('qa')} .tx strong`).count() === 1, '★ markdown 照常渲染（**粗**）—— 走的是 mdToHtml');
      ok(await p.evaluate(() => window.__xss) === undefined, '★★★ onerror / script 没有执行');
      ok(e8.length === 0, '页面没有抛错', e8.join(' | '));
      await c.close();
    }

    console.log('\n【L5】messages-error：报错的那一列写「查不了」，其余列正常；拉失败保留旧内容');
    {
      const { ctx: c, page: p, errors: e5 } = await openLanes(browser, srv.url, 'messages-error');
      await p.waitForSelector(`${lane('dev')} .lane-err:not([hidden])`);
      await p.waitForTimeout(800);
      const err = await p.locator(`${lane('dev')} .lane-err`).textContent();
      ok(/^查不了：PARTIAL_UNAVAILABLE/.test(err), '★★★ dev 那一列写「查不了：PARTIAL_UNAVAILABLE …」', err);
      ok(/一次都没拿到过/.test(err), '★★ 一次都没拿到过 ⇒ 说清楚（不是「没有消息」）', err);
      ok(await p.locator(`${lane('dev')} .le.room`).count() > 0, '★ 房间里 dev 的发言照样在（那部分不经过这个端点）');
      ok(await p.locator(`${lane('senior')} .lane-err`).isHidden() && await p.locator(`${lane('senior')} .le`).count() > 0, '★★ 其余列正常（senior 有内容、没有报错行）');
      ok(await p.locator(`${lane('JARVIS')} .lane-err`).isHidden(), '★ 编排者那一列正常');
      const info = await p.locator(`${lane('JARVIS')} .lh .info`).getAttribute('title');
      ok(/并进了/.test(info) && !/并进了[^\n]*dev[、 ]/.test(info.replace('dev3', 'd3')), '★★ ⓘ 照实写：没取到 dev 的收件流，就不说并进了 dev', info);
      ok(e5.length === 0, '页面没有抛错', e5.join(' | '));
      await c.close();
    }
    {
      // 先拿到过（normal），之后才报错：保留旧内容，标上是几点的
      const { ctx: c, page: p } = await openLanes(browser, srv.url, 'normal');
      await p.waitForSelector(`${lane('senior')} .le`);
      await p.waitForTimeout(800);
      const n0 = await p.locator(`${lane('senior')} .le`).count();
      await p.route(isMsgs('senior'), (route) => route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: 'QUEUE_UNAVAILABLE', message: 'redis 断了', next: 'redis 恢复后重试' }) }));
      await p.evaluate(() => refreshLanes());   // 不等 30 秒：直接触发一轮重拉
      await p.waitForSelector(`${lane('senior')} .lane-err:not([hidden])`);
      const err = await p.locator(`${lane('senior')} .lane-err`).textContent();
      ok(/^查不了：QUEUE_UNAVAILABLE/.test(err) && /下面是 \d\d:\d\d 的内容/.test(err), '★★★ 写「查不了」并标上「下面是 HH:MM 的内容」', err);
      ok(await p.locator(`${lane('senior')} .le`).count() === n0 && n0 > 0, '★★★ 旧内容还在，没清空', `${n0}`);
      ok(/redis 恢复后重试/.test(await p.locator(`${lane('senior')} .lane-err`).getAttribute('title')), '★ 后端的 next 在 title 里');
      await c.close();
    }

    console.log('\n【L6】390 宽：tab 切换列，没有整页横向滚动');
    {
      const { ctx: c, page: p, errors: e6 } = await openLanes(browser, srv.url, 'normal', { width: 390, height: 844 });
      await p.waitForSelector('#lanes-tabs .ltab');
      await p.waitForTimeout(800);
      const vis = () => p.$$eval('#lanes .lane', (ns) => ns.filter((n) => n.getClientRects().length).map((n) => n.dataset.lane));
      ok((await vis()).join() === 'JARVIS', '★★ 一次只显示一列（默认编排者）', (await vis()).join());
      await p.locator('#lanes-tabs .ltab', { hasText: 'dev' }).filter({ hasNotText: 'dev3' }).filter({ hasNotText: 'dev2' }).click();
      ok((await vis()).join() === 'dev', '★★★ 点 tab「dev」⇒ 换成 dev 那一列', (await vis()).join());
      const grp = await p.locator('#lanes-tabs .ltab-grp').textContent().catch(() => '');
      ok(grp === '收起的' && await p.locator('#lanes-tabs .ltab', { hasText: 'dev2' }).count() === 1, '★★ 窄栏里的 dev2 在 tab 的最后，「收起的」一组');
      await p.locator('#lanes-tabs .ltab', { hasText: 'dev2' }).click();
      ok((await vis()).join() === 'dev2', '★ 点 dev2 ⇒ 显示它那一列', (await vis()).join());
      const hs = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
        || document.body.scrollWidth > document.body.clientWidth);
      ok(!hs, '★★★ 没有整页横向滚动');
      ok(await p.locator('#cmd').isVisible() && await p.locator('#cmd-input').isVisible(), '★★ 命令条照样在底部');
      const cb = await p.locator('#cmd').boundingBox();
      ok(cb && Math.round(cb.y + cb.height) <= 844 && cb.y > 600, '★ 命令条贴着视口底部', JSON.stringify(cb));
      ok(e6.length === 0, '页面没有抛错', e6.join(' | '));
      await c.close();
    }

    console.log('\n【L12】对话视图的 composer 走的是同一份 sendTo（拆出来之后行为没变）');
    {
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await c.newPage();
      const e12 = [];
      p.on('pageerror', (e) => e12.push(e.message));
      const isPost = (u) => u.pathname === '/api/message' || /^\/api\/rooms\/[^/]+\/post$/.test(u.pathname);
      await p.route(isPost, (route) => {
        const room = route.request().url().includes('/api/rooms/');
        route.fulfill({ status: 202, contentType: 'application/json',
          body: JSON.stringify(room ? { ok: true, id: '1799999999998-0' } : { ok: true, job_id: 'j-l12' }) });
      });
      await p.goto(`${srv.url}?scenario=normal#/chat/dm/JARVIS`);
      await p.waitForSelector('#feed .msg');
      await p.locator('#input').fill('L12：composer 私聊');
      const [r1] = await Promise.all([p.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/')), p.locator('#send').click()]);
      ok(new URL(r1.url()).pathname === '/api/message', '★★ 私聊 ⇒ POST /api/message', r1.url());
      await p.waitForSelector('#feed .msg >> text=L12：composer 私聊');
      ok((await p.locator('#input').inputValue()) === '', '★ 本地回显出现、输入框清空');
      await p.goto(`${srv.url}?scenario=normal#/chat/room/${ENG}`);
      await p.waitForSelector('#feed .msg');
      await p.locator('#input').fill('L12：composer 房间');
      const [r2] = await Promise.all([p.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/')), p.locator('#send').click()]);
      ok(new URL(r2.url()).pathname === `/api/rooms/${ENG}/post`, '★★ 房间 ⇒ POST /api/rooms/<hash>/post', r2.url());
      await p.waitForSelector('#feed .msg >> text=L12：composer 房间');
      ok(true, '★ 房间里的本地回显也出现了');
      // 失败那条路：非 202 ⇒ 系统行报错 + 字还给输入框
      await p.unroute(isPost);
      await p.locator('#input').fill('L12：预览回 200');
      await p.locator('#send').click();
      await p.waitForSelector('#feed .sys.crit >> text=没发出去');
      ok((await p.locator('#input').inputValue()) === 'L12：预览回 200', '★★ 非 202 ⇒ 当前频道里出现「没发出去」，字还给输入框');
      ok(e12.length === 0, '页面没有抛错', e12.join(' | '));
      await c.close();
    }

    console.log('\n【L11】agents-error / blind：不画列，画「查不了」');
    for (const sc of ['agents-error', 'blind']) {
      const { ctx: c, page: p } = await openLanes(browser, srv.url, sc);
      await p.waitForSelector('#lanes-cant:not([hidden])');
      const t = await p.locator('#lanes-cant').textContent();
      ok(/查不了/.test(t) && await p.locator('#lanes-body').isHidden(), `★★★ ${sc}：写「查不了」，不画列、不画空白`, t);
      ok(await p.locator('#cmd').isVisible(), `★ ${sc}：命令条还在（发给 JARVIS 不依赖 /api/agents）`);
      await c.close();
    }
  } finally {
    await browser.close();
    await new Promise((r) => srv.server.close(r));
    srv.wss.close();
  }
  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); console.log(`\n  通过 ${pass} · 失败 ${fail + 1}\n`); process.exit(1); });
