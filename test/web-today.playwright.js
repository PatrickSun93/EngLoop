'use strict';

/**
 * 「今天」视图的 e2e。
 *
 *   node test/web-today.playwright.js
 *
 * ★ 连的是**预览服务器**（`scripts/web-preview.js`，随机端口、夹具），**绝不连 9969**。
 *   服务器在这个进程里起、跑完关掉。
 * ★ Mac 上 playwright 没装自带浏览器：用系统 Chrome（`channel: 'chrome'`）。不下载浏览器。
 * ⚠️ 跟另外两个 `*.playwright.js` 一样**不进 `test/run-all.js`**（它只收 `*.test.js`）——
 *   全量跑在没有 Chrome 的机器上时不该因为这个红。要跑就单独跑这一个文件。
 *
 * 守的四件事：
 *   E1 在今天视图点「等你处理」卡的「跳过去」⇒ 抽屉里出现那条消息，地址栏还是 #/today
 *   E2 在抽屉里打一段草稿（和「回复中」）⇒ 切到对话视图还在；再切回来还在
 *   E3 在今天视图收起一条 ⇒ 切到对话视图，右栏里也没有这条
 *   E4 等 6 秒（跨过一次 5 秒重绘），抽屉状态和草稿还在
 * 另外两条顺手看的：
 *   E5 窄屏（390）：抽屉默认收起，打开时盖住全屏，不出现整页横向滚动
 *   E6 对话视图 #eng-loop：4 天前的话题折进「更早的 1 个话题」
 */

const path = require('node:path');
const { chromium } = require('playwright');
const preview = require(path.join(__dirname, '..', 'scripts', 'web-preview.js'));

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const SENIOR_Q = '1791000013000-0';     // #eng-loop：senior 的 @Patrick 提问（expects_reply）
const FLOW = '1791000010000-0';         // #eng-loop：JARVIS 的【流程】通知

async function main() {
  const srv = await preview.start({ port: 0 });
  if (srv.port === preview.BUS_PORT) throw new Error('预览服务器落到了 9969 —— 不该发生');
  console.log(`预览服务器：${srv.url}（不是 bus）`);
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.url}?scenario=normal#/today`);
    await page.waitForSelector('#today-need .ni.wide');
    await page.waitForTimeout(800);   // 预载的房间历史回来

    console.log('\n【E1】「跳过去」⇒ 抽屉里出现那条消息，地址栏还是 #/today');
    {
      const card = page.locator('#today-need .ni.wide', { hasText: 'senior 等你回复' });
      ok(await card.count() === 1, '今天视图里有「senior 等你回复」那张卡');
      await card.getByRole('button', { name: '跳过去' }).click();
      const sel = `#drawer-body #feed [data-seg="${SENIOR_Q}"], #drawer-body #feed [data-mid="${SENIOR_Q}"]`;
      let shown = false;
      try { await page.waitForSelector(sel, { state: 'visible', timeout: 5000 }); shown = true; } catch (_) { shown = false; }
      ok(shown, '★★★ 抽屉里出现了那条消息（#drawer-body #feed 里，可见）');
      ok(await page.evaluate(() => location.hash) === '#/today', '★★★ 地址栏还是 #/today', await page.evaluate(() => location.hash));
      ok(await page.locator('#view-today').isVisible() && !(await page.locator('#view-chat').isVisible()), '★★ 没切视图（今天视图还在前台）');
      ok((await page.locator('#drawer-name').textContent()) === 'eng-loop', '★ 抽屉标题换成了 #eng-loop',
        await page.locator('#drawer-name').textContent());
      ok(await page.locator('#feed').count() === 1 && await page.locator('#input').count() === 1, '★★ 页面上只有一个 #feed、一个 #input（没有第二套）');
    }

    console.log('\n【E2】抽屉里的草稿和「回复中」⇒ 切到对话视图还在；再切回来还在');
    const DRAFT = 'e2e 草稿：切视图之后还在吗';
    {
      // 「回复中」：在抽屉里点某条消息的「回复」
      await page.locator('#drawer-body #feed .reply-btn').first().click();
      const replyingBefore = (await page.locator('#replying').textContent()) || '';
      ok(await page.locator('#replying').isVisible() && replyingBefore.length > 0, '（前置）抽屉里进入了「回复中」', replyingBefore);
      await page.locator('#drawer-body #input').fill(DRAFT);
      await page.locator('#tab-chat').click();
      await page.waitForFunction(() => location.hash.startsWith('#/chat/'));
      ok(await page.locator('#chat-main #input').inputValue() === DRAFT, '★★★ 切到对话视图：草稿还在（同一个 textarea）');
      ok(await page.locator('#chat-main #replying').isVisible()
        && (await page.locator('#chat-main #replying').textContent()) === replyingBefore, '★★ 「回复中」也还在');
      ok(await page.evaluate(() => location.hash) === '#/chat/room/eng-loop-7f3a9c21d0b4',
        '★★ 对话视图停在抽屉里刚才那个频道', await page.evaluate(() => location.hash));
      await page.locator('#tab-today').click();
      await page.waitForFunction(() => location.hash === '#/today');
      ok(await page.locator('#drawer-body #input').inputValue() === DRAFT, '★★★ 再切回今天视图：草稿还在');
      ok(await page.locator('#drawer-body #replying').isVisible(), '★★ 「回复中」还在');
    }

    console.log('\n【E3】今天视图里收起一条 ⇒ 对话视图右栏里也没有这条');
    {
      const card = page.locator('#today-need .ni.wide', { hasText: 'JARVIS 等你回复' });
      ok(await card.count() === 1, '（前置）今天视图里有「JARVIS 等你回复」（【流程】那条）');
      const nBefore = await page.locator('#today-need .ni').count();
      await card.getByRole('button', { name: '收起' }).click();
      ok(await page.locator('#today-need .ni.wide', { hasText: 'JARVIS 等你回复' }).count() === 0, '★★ 今天视图里立刻没了');
      ok(await page.locator('#today-need .ni').count() === nBefore - 1, '★ 只少了这一张');
      // 右栏（对话视图里）—— 不切视图也能查 DOM：两处是同一次计算画出来的
      ok(await page.locator('#need .ni', { hasText: 'JARVIS 等你回复' }).count() === 0, '★★★ 右栏里也没有这条（还没切视图就已经没了）');
      await page.locator('#tab-chat').click();
      await page.waitForFunction(() => location.hash.startsWith('#/chat/'));
      ok(await page.locator('#need .ni', { hasText: 'JARVIS 等你回复' }).count() === 0, '★★★ 切到对话视图：右栏里没有这条');
      ok(await page.locator('#need .ni', { hasText: 'senior 等你回复' }).count() === 1, '★ 对照：别的条目还在（不是整个右栏空了）');
      await page.locator('#tab-today').click();
      await page.waitForFunction(() => location.hash === '#/today');
    }

    console.log('\n【E4】等 6 秒（跨过一次 5 秒重绘）：抽屉状态和草稿还在');
    {
      // 收起抽屉 ⇒ 6 秒后仍收起；草稿还在（节点只是看不见）
      await page.locator('#drawer-x').click();
      ok(await page.locator('#view-today').evaluate((n) => n.classList.contains('drawer-closed')), '（前置）抽屉收起了');
      await page.waitForTimeout(6000);
      ok(await page.locator('#view-today').evaluate((n) => n.classList.contains('drawer-closed')), '★★★ 6 秒后抽屉仍是收起的（重绘没把它打开）');
      ok(await page.locator('#drawer-body #input').inputValue() === DRAFT, '★★★ 草稿还在');
      await page.locator('#drawer-open').click();
      ok(await page.locator('#drawer').isVisible(), '把手点开 ⇒ 抽屉回来了');
      await page.waitForTimeout(6000);
      ok(await page.locator('#drawer').isVisible(), '★★ 打开着的抽屉 6 秒后仍然打开');
      ok(await page.locator('#drawer-body #input').inputValue() === DRAFT, '★★ 草稿还在');
      ok(await page.locator('#drawer-body #replying').isVisible(), '★ 「回复中」还在');
      // 收起状态存 localStorage：刷新之后还是同一个状态
      await page.locator('#drawer-x').click();
      await page.reload();
      await page.waitForSelector('#today-need .ni.wide');
      ok(await page.locator('#view-today').evaluate((n) => n.classList.contains('drawer-closed')), '★ 收起状态存在 localStorage：刷新后仍收起');
      await page.locator('#drawer-open').click();
    }
    ok(errors.length === 0, '页面没有抛错', errors.join(' | '));

    console.log('\n【E5】窄屏 390：抽屉默认收起，打开时盖住全屏，不出现整页横向滚动');
    {
      const nctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const np = await nctx.newPage();
      await np.goto(`${srv.url}?scenario=normal#/today`);
      await np.waitForSelector('#today-need .ni.wide');
      ok(await np.locator('#view-today').evaluate((n) => n.classList.contains('drawer-closed')), '★★ 窄屏默认收起');
      const hs = () => np.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
        || document.body.scrollWidth > document.body.clientWidth);
      ok(!(await hs()), '★★ 没有整页横向滚动（收起时）');
      await np.locator('#drawer-open').click();
      const box = await np.locator('#drawer').boundingBox();
      ok(!!box && box.x === 0 && box.y === 0 && Math.round(box.width) === 390 && Math.round(box.height) === 844,
        '★★ 打开时盖住全屏', JSON.stringify(box));
      ok(await np.locator('#drawer-x').isVisible(), '★ 有关闭按钮');
      ok(!(await hs()), '★★ 没有整页横向滚动（打开时）');
      await np.locator('#drawer-x').click();
      ok(await np.locator('#view-today').evaluate((n) => n.classList.contains('drawer-closed')), '关掉了');
      await nctx.close();
    }

    console.log('\n【E6】对话视图 #eng-loop：4 天前的话题折进「更早的 1 个话题」');
    {
      const cctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const cp = await cctx.newPage();
      await cp.goto(`${srv.url}?scenario=normal#/chat/room/eng-loop-7f3a9c21d0b4`);
      await cp.waitForSelector('#feed .msg');
      const t = (await cp.locator('#feed .older-toggle').textContent().catch(() => '')) || '';
      ok(/更早的 1 个话题/.test(t), '★★★ 有「更早的 1 个话题」（4 天前那个房间话题，at 是 ISO 字符串）', t);
      ok(await cp.locator('#feed [data-seg="1791000001000-0"]').count() === 0, '★★ 那个话题默认不在最近区');
      await cctx.close();
    }
  } finally {
    await browser.close();
    await new Promise((r) => srv.server.close(r));
    srv.wss.close();
  }
  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
