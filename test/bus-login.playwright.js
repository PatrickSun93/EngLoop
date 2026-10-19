'use strict';

/**
 * 浏览器那一圈：登录框 → 登录 → WS 连上 → 发消息（盖章）→ 收到 WS 推送。
 *
 * ⚠️ 不进 run-all（跟 `e2e-signal-layering.playwright.js` 一样）：它要一个**已经在跑的隔离 bus**，
 *   而且要知道那个 bus 的用户 key、测试库、outbox 根 —— 这些都在环境变量里给：
 *
 *   ENGLOOP_PW_BASE      http://127.0.0.1:<端口>     ⚠️ 不许是 9969（生产）
 *   ENGLOOP_PW_USER      用户名（要在那个 bus 的用户表里）
 *   ENGLOOP_PW_KEY       它的 key
 *   ENGLOOP_PW_REDIS     那个 bus 连的 redis url（带测试库编号）—— 用来核对流条目上的章
 *   ENGLOOP_PW_OUTBOX    那个 bus 的 ENGLOOP_OUTBOX_ROOT —— 模拟 JARVIS 回一句，看 WS 推不推
 *
 *   node test/bus-login.playwright.js
 *
 *   或者一条命令（起隔离 bus → 跑本文件 → 收掉 bus、删临时文件）：
 *   node scripts/run-e2e-notify.js test/bus-login.playwright.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const Redis = require('ioredis');

const BASE = process.env.ENGLOOP_PW_BASE;
const USER = process.env.ENGLOOP_PW_USER;
const KEY = process.env.ENGLOOP_PW_KEY;
const REDIS = process.env.ENGLOOP_PW_REDIS;
const OUTBOX = process.env.ENGLOOP_PW_OUTBOX;

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

async function main() {
  if (!BASE || !USER || !KEY || !REDIS || !OUTBOX) {
    console.error('缺环境变量：ENGLOOP_PW_BASE / _USER / _KEY / _REDIS / _OUTBOX（见文件头）');
    process.exit(2);
  }
  if (/:9969\b/.test(BASE) || !/\/\d+$/.test(REDIS) || /\/0$/.test(REDIS)) {
    console.error('拒绝：这个脚本只对隔离 bus（非 9969、测试库）跑。');
    process.exit(2);
  }
  const redis = new Redis(REDIS);
  // 没装 playwright 自带的浏览器时，ENGLOOP_PW_CHANNEL=chrome 用系统 Chrome（临时 profile，不碰你自己的）
  const browser = await chromium.launch(process.env.ENGLOOP_PW_CHANNEL ? { channel: process.env.ENGLOOP_PW_CHANNEL } : {});
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));

  console.log('\n【1】没登录 ⇒ 弹登录框');
  // ★ 打开页面的默认视图是「今天」，对话流 / 输入框在「今天」视图里是隐藏的。
  //   这个测试要的是对话视图 ⇒ 直接打开它的路由。
  await page.goto(new URL('#/chat/dm/JARVIS', BASE).href, { waitUntil: 'domcontentloaded' });
  const overlay = await page.waitForSelector('#login-overlay', { timeout: 10000 }).catch(() => null);
  ok(!!overlay, '页面打开就弹出登录框（/api/* 401 被 auth.js 接住）');
  const dot0 = await page.getAttribute('#wsdot', 'class');
  ok(dot0 !== 'on', `登录前 WS 没连上（#wsdot=${dot0}）`);

  console.log('\n【2】错 key ⇒ 框里说错了；对的 key ⇒ 重载、WS 连上');
  await page.fill('#login-user', USER);
  await page.fill('#login-key', 'wrong-key');
  await page.click('#login-form button[type=submit]');
  await page.waitForFunction(() => document.getElementById('login-err').textContent.length > 0, null, { timeout: 5000 });
  ok(/不对/.test(await page.textContent('#login-err')), '错 key ⇒ 显示「用户名或 key 不对」');
  await page.fill('#login-key', KEY);
  await Promise.all([page.waitForNavigation({ timeout: 10000 }), page.click('#login-form button[type=submit]')]);
  await page.waitForFunction(() => document.getElementById('wsdot').className === 'on', null, { timeout: 10000 })
    .catch(() => null);
  ok(await page.getAttribute('#wsdot', 'class') === 'on', '登录后 WS 连上（#wsdot=on）');
  ok(!(await page.$('#login-overlay')), '登录后没有登录框');
  const cookies = await page.context().cookies();
  const c = cookies.find((x) => x.name === 'engloop_session');
  ok(c && c.httpOnly && c.sameSite === 'Strict', 'session cookie：HttpOnly · SameSite=Strict', JSON.stringify(c && { httpOnly: c.httpOnly, sameSite: c.sameSite }));
  ok(!(await page.evaluate(() => document.cookie)).includes('engloop_session'), 'JS 读不到 session cookie（HttpOnly）');

  console.log('\n【3】发消息 ⇒ 流里盖了 session 的章');
  const MARK = `PW-${Date.now()}`;
  await page.fill('#input', `browser says ${MARK}`);
  await page.click('#send');
  let entry = null;
  for (let i = 0; i < 20 && !entry; i++) {
    const rows = await redis.xrange('orch:in:human', '-', '+');
    for (const [, f] of rows) {
      const o = {}; for (let k = 0; k < f.length; k += 2) o[f[k]] = f[k + 1];
      if (String(o.text).includes(MARK)) entry = o;
    }
    if (!entry) await page.waitForTimeout(250);
  }
  ok(entry && entry.from === USER && entry.sender_type === 'human' && entry.can_manage_workers === '1',
    `流条目：from=${USER} · sender_type=human · can_manage_workers="1"`, JSON.stringify(entry));

  console.log('\n【4】JARVIS 回一句 ⇒ 浏览器收到 WS 推送');
  const REPLY = `reply ${MARK}`;
  fs.mkdirSync(path.join(OUTBOX, 'JARVIS'), { recursive: true });
  fs.writeFileSync(path.join(OUTBOX, 'JARVIS', `${Date.now()}.json`), JSON.stringify({ username: USER, text: REPLY }));
  const got = await page.waitForFunction((t) => document.body.innerText.includes(t), REPLY, { timeout: 15000 })
    .then(() => true).catch(() => false);
  ok(got, '回复出现在页面上（WS 推送，没有刷新页面）');

  ok(errs.length === 0, '页面没有 JS 异常', errs.join(' | '));
  await browser.close();
  await redis.quit();
  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
