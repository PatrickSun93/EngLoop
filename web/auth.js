/* EngLoop 控制台 —— 登录
 *
 * bus 对所有 /api/* 和 /ws 要凭据。浏览器的凭据是一个 HttpOnly session cookie，
 * 由 POST /api/login {username, key} 设下；同源 fetch 和 WebSocket 握手会自动带上它，
 * 所以 app.js 里的几十处 fetch 一个字都不用改。
 *
 * 这个文件只做一件事：**任何 /api 请求拿到 401 ⇒ 弹一个最小的登录框**。
 *   · 包住 window.fetch —— 必须在 app.js 之前加载（index.html 里的顺序就是机制）
 *   · 登录成功 ⇒ 整页重载：WS 重连、所有面板重新拉一遍，比逐个补救简单也不会漏
 *   · session 落盘（bus 重启不掉）；过期 / 换 key / 用户被删 ⇒ 下一次请求 401 ⇒ 框会自己弹出来
 *
 * ── 一次性登录链接：`/#login-token=<token>`（`node bin/bus-user.js login <name>` 打印的）──
 *   token 在 `#` 后面 ⇒ 服务器从来看不到这个 URL 里的它；这里读出来、POST /api/login-token 换 session。
 *   ★ 先用 history.replaceState 把它从地址栏抹掉，再发请求：
 *     成不成它都已经没用了（一次性），留在地址栏里只会被收藏、被同步进别的设备的历史。
 *   成功 ⇒ 跳到首页（同 key 登录：整页重载）；失败 ⇒ 登录框里说清是无效 / 过期 / 用过。
 *
 * ⚠️ 不好看是有意的。它只要做到：弹得出来、说得清为什么。
 */
(function () {
  'use strict';
  const realFetch = window.fetch.bind(window);
  let shown = false;

  function showLogin(reason) {
    // 已经弹了：只换掉说明 —— 一次性链接失败的原因可能比「随便哪个 401」晚到一拍，要盖过它
    if (shown) {
      const why = document.getElementById('login-why');
      if (why && reason) why.textContent = reason;
      return;
    }
    shown = true;
    const wrap = document.createElement('div');
    wrap.id = 'login-overlay';
    wrap.setAttribute('style', 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;'
      + 'justify-content:center;background:rgba(0,0,0,.45)');
    wrap.innerHTML = '<form id="login-form" style="background:var(--panel,#fff);color:var(--ink,#000);'
      + 'padding:20px 24px;border-radius:8px;min-width:280px;max-width:90vw;font:14px var(--sans,sans-serif)">'
      + '<div style="font-weight:600;margin-bottom:8px">登录 EngLoop</div>'
      + '<div id="login-why" style="color:var(--ink-3,#666);font-size:12px;margin-bottom:12px"></div>'
      + '<label>用户名<br><input id="login-user" autocomplete="username" style="width:100%;margin:4px 0 10px"></label>'
      + '<label>key<br><input id="login-key" type="password" autocomplete="current-password" style="width:100%;margin:4px 0 10px"></label>'
      + '<div id="login-err" style="color:var(--deaf,#a8412c);font-size:12px;min-height:1em;margin-bottom:8px"></div>'
      + '<button type="submit">登录</button>'
      + '<div style="color:var(--ink-3,#666);font-size:11px;margin-top:10px">还没有 key：在本机跑 '
      + '<code>node bin/bus-user.js add &lt;用户名&gt; --manage</code></div>'
      + '</form>';
    document.body.appendChild(wrap);
    document.getElementById('login-why').textContent = reason
      || 'bus 要求登录（没登录过，或者 session 过期 / key 换过）。';
    document.getElementById('login-user').focus();
    document.getElementById('login-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const username = document.getElementById('login-user').value.trim();
      const key = document.getElementById('login-key').value.trim();
      const err = document.getElementById('login-err');
      err.textContent = '';
      try {
        const r = await realFetch('/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, key }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { err.textContent = `✗ ${d.message || r.status}${d.next ? ' ' + d.next : ''}`; return; }
        location.reload();
      } catch (e) {
        err.textContent = `✗ bus 连不上：${e.message}`;
      }
    });
  }

  const whenBody = (fn) => (document.body ? fn() : document.addEventListener('DOMContentLoaded', fn));

  // ── 一次性登录链接 ──
  //   换 session 的这一拍里，app.js 的请求照样会 401 —— 那时不弹通用的框（成功了马上就重载），
  //   失败时由下面带原因的那次 showLogin 弹。
  let redeeming = false;
  const tokenMatch = /^#login-token=([A-Za-z0-9_-]+)$/.exec(location.hash || '');
  if (tokenMatch) {
    redeeming = true;
    history.replaceState(null, '', location.pathname + location.search);
    const fail = (why) => { redeeming = false; whenBody(() => showLogin(`✗ 一次性登录链接没用上：${why}`)); };
    realFetch('/api/login-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokenMatch[1] }),
    }).then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (r.ok) { location.replace('/'); return; }
      fail(`${d.message || r.status}${d.next ? ' ' + d.next : ''}`);
    }).catch((e) => fail(`bus 连不上（${e.message}）`));
  }
  // DOM 可能还没好（app.js 启动时就开始拉数据）
  const on401 = () => { if (!redeeming) whenBody(() => showLogin()); };

  window.fetch = async function (input, init) {
    const r = await realFetch(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (r.status === 401 && !/\/api\/login$/.test(url)) on401();
    return r;
  };

  /** 「我是谁」。app.js 的本地回显用它署名；401 时 fetch 包装会弹框。 */
  window.EngLoopAuth = {
    me: null,
    ready: realFetch('/api/whoami').then(async (r) => {
      if (r.status === 401) { on401(); return null; }
      const d = await r.json().catch(() => null);
      window.EngLoopAuth.me = d && d.username;
      return d;
    }).catch(() => null),
    showLogin,
  };
}());
