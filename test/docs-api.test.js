'use strict';

/**
 * `GET /api/docs` / `GET /api/docs/<path>` —— 让人在网页上打开 agent 写的文档。
 *
 * ── 这个文件的重心在一个地方：**路径穿越** ──────────────────────
 * 所有穿越尝试都**真的造出目标文件**（在 root 之外），然后断言**读不到**。
 * 不造靶子的话，「拦住了」和「那个文件本来就不存在」长得一模一样 ——
 * **那种绿最像真绿**（没有阳性对照时，
 * 「什么都没验到」跟「防线生效」同形）。
 *
 * ── 第二重心：403 和 404 必须分得开 ────────────────────────────
 * 「拒绝了」被渲染成「没找到」的话，**人会以为文件名写错，
 * 然后去找一个不存在的问题**。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const docs = require('../lib/docs');

/**
 * ★★ 发**原始**路径，不经过 URL 规范化。
 *
 * ── 为什么不能用 `fetch` 测穿越 ──────────────────────────────────
 * `fetch('http://…/api/docs/../SECRET.md')` 里，
 * **undici 在发出请求之前就把路径规范化成了 `/api/SECRET.md`** ——
 * 那条路由不存在，express 回一个默认的 **404 HTML**。
 *
 * 于是「不是 200」「没泄漏 SECRET」两条断言**都会通过，
 * 而防线一次都没被走到。** 以为验的是 `resolveSafe`，
 * 实际验的是 undici 的 URL 规范化。
 *
 * > **「以为验了 A，实际验的是 B」** ——
 * > 这里是客户端替被测代码把活干了。
 *
 * ⚠️ 而真实攻击者**不用 fetch** —— `curl --path-as-is`、手写 socket、
 *   一个不规范化的代理，都能把原始路径送到服务端。**所以防线必须在，
 *   而测试必须用一个不规范化的客户端。**
 *
 * `http.request` 的 `path` 选项原样发送，正是这里要的。
 */
function rawGet(port, rawPath) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: rawPath, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch (_) { /* HTML 或别的 */ }
          resolve({ status: res.statusCode, body, json });
        });
      });
    req.on('error', (e) => resolve({ status: 0, body: '', json: null, error: e.message }));
    req.end();
  });
}

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

/**
 * 造一棵真的目录树：
 *
 *   <tmp>/SECRET.md          ← root **之外**的诱饵（穿越成功就能读到它）
 *   <tmp>/outside/leak.md    ← 符号链接的目标
 *   <tmp>/docs/              ← root
 *     ok.md
 *     research/deep.md
 *     notes.txt              ← 非 .md
 *     link.md      → ../../outside/leak.md   （符号链接指到外面）
 *     subdir       → ../outside              （目录符号链接）
 */
function fixture() {
  // ★ 连 tmp 根都要 realpath：macOS 的 /var/folders 本身就是符号链接，
  //   不解的话下面那些「预期能读到」的断言会全红 —— 而红的原因跟被测代码无关。
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-docs-')));
  const root = path.join(base, 'docs');
  fs.mkdirSync(path.join(root, 'research'), { recursive: true });
  fs.mkdirSync(path.join(base, 'outside'), { recursive: true });

  fs.writeFileSync(path.join(base, 'SECRET.md'), '# 机密\n不该被读到\n');
  fs.writeFileSync(path.join(base, 'outside', 'leak.md'), '# 泄漏\n');
  fs.writeFileSync(path.join(root, 'ok.md'), '# 正常文档\n\n正文。\n');
  fs.writeFileSync(path.join(root, 'research', 'deep.md'), '# 深一层\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), '不是 markdown');

  try { fs.symlinkSync(path.join(base, 'outside', 'leak.md'), path.join(root, 'link.md')); }
  catch (_) { /* 有的文件系统不支持，下面的断言会说明 */ }
  try { fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'subdir')); }
  catch (_) { /* 同上 */ }

  return { base, root, clean: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function serve(root) {
  const app = express();
  app.get('/api/docs', docs.listHandler({ root }));
  app.get('/api/docs/*splat', docs.readHandler({ root }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

async function main() {
  const fx = fixture();
  const app = await serve(fx.root);
  // ★ 一律走 rawGet —— 见上面那段注释：fetch 会在客户端把 `../` 吃掉。
  const get = (p) => rawGet(app.port, p);

  console.log('\n【0】（前置）诱饵真的存在 —— 否则下面「读不到」全是假绿');
  {
    ok(fs.existsSync(path.join(fx.base, 'SECRET.md')),
      '★★ root 之外真的有一份 SECRET.md —— **穿越成功就能读到它**');
    ok(fs.readFileSync(path.join(fx.base, 'SECRET.md'), 'utf8').includes('机密'),
      '★ 而且内容认得出来');
  }

  console.log('\n【1】★ 正常路径读得到');
  {
    const r = await get('/api/docs/ok.md');
    ok(r.status === 200, `200（实际 ${r.status}）`, r.body.slice(0, 200));
    ok(r.json.content.includes('正文'), '内容对');
    ok(r.json.title === '正常文档', '★ 带 title（列表里只有路径的话人得逐个点开）');
    ok(typeof r.json.mtime === 'string' && !Number.isNaN(Date.parse(r.json.mtime)),
      '★ 带 mtime —— 「这份东西什么时候产的」');

    const deep = await get('/api/docs/research/deep.md');
    ok(deep.status === 200, '★ 子目录也读得到（多段路径）');
    ok(deep.json.path === path.join('research', 'deep.md'), '★ path 是相对 docs/ 的');
  }

  console.log('\n【2】★★ 路径穿越 —— 真靶子 + 原始路径（不经客户端规范化）');
  {
    // ⚠️ 用 `fetch` 的话这一节**什么都验不到**：undici 在客户端就把
    //   `../` 吃掉了，请求变成 `/api/SECRET.md` → express 默认 404 HTML。
    //   两条断言（不是 200、没泄漏）**都绿**，而防线一次没被走到。
    //   所以走 `rawGet`（`http.request` 原样发路径），并且**断言它真的
    //   到了被测的 handler**（响应是 JSON 且带 error 码，不是 express 的 HTML）。
    const attempts = [
      ['../SECRET.md', '相对路径上跳'],
      ['../../SECRET.md', '跳两层'],
      ['research/../../SECRET.md', '先进再跳'],
      ['%2e%2e%2fSECRET.md', 'URL 编码的 ..'],
      ['%2e%2e/%2e%2e/SECRET.md', '编码 + 多层'],
      ['....//SECRET.md', '「去掉 .. 之后仍是 ..」那种写法'],
      ['..%2fSECRET.md', '混合编码'],
      ['..%252fSECRET.md', '双重编码'],
    ];
    for (const [p, label] of attempts) {
      const r = await get(`/api/docs/${p}`);
      ok(!r.body.includes('不该被读到'),
        `★★ ${label}（${p}）→ **没读到 SECRET.md**`, r.body.slice(0, 160));
      ok(r.status !== 200, `★ ${label} → 不是 200（实际 ${r.status}）`);
    }

    // ★★ 阳性对照：至少证明**这条路径真的走到了被测的 handler**。
    //   缺了它，「被 express 路由表挡在门外」跟「防线拦住了」在上面那些
    //   断言里长得一模一样。
    const probe = await get('/api/docs/../SECRET.md');
    ok(probe.json !== null,
      '★★ 响应是 **JSON** 而不是 express 的默认 404 HTML —— '
      + '证明请求真的进了 docs 的 handler，不是被路由表挡在门外',
      probe.body.slice(0, 160));
    ok(probe.json && probe.json.error === docs.ERR.OUTSIDE,
      '★★ 而且是 **docs 自己的**越界错误码 —— 这才是「防线拦住了」的证据',
      JSON.stringify(probe.json));
  }

  console.log('\n【3】★★ 符号链接指到外面 —— 字面检查看不见这个');
  {
    // `../` 那种字面上就看得出来；**符号链接的路径字符串完全合法**，
    // 只有 realpath 之后才暴露。这是第二道防线专门挡的。
    if (fs.existsSync(path.join(fx.root, 'link.md'))) {
      const r = await get('/api/docs/link.md');
      ok(r.status === 403, `★★ 符号链接指到 root 外 → 403（实际 ${r.status}）`,
        r.body.slice(0, 200));
      ok(!r.body.includes('泄漏'), '★★ 而且内容没漏出来', r.body.slice(0, 200));
      ok(r.json && r.json.error === docs.ERR.OUTSIDE, '★ 错误码说得出是越界');
    } else {
      ok(false, '（前置）符号链接没造出来 —— 这一节什么都没验到');
    }

    // 目录符号链接：`subdir/leak.md` 字面上完全在 docs/ 里
    if (fs.existsSync(path.join(fx.root, 'subdir'))) {
      const r = await get('/api/docs/subdir/leak.md');
      ok(r.status === 403,
        `★★ 穿过目录符号链接 → 403（实际 ${r.status}）—— 这条路径字面上完全合法`);
    }
  }

  console.log('\n【4】★★ 四种拒绝，四个状态码 —— 混成一个人会查错方向');
  {
    const r403 = await get('/api/docs/../SECRET.md');
    ok(r403.status === 403, `越界 → 403（实际 ${r403.status}）`, r403.body.slice(0, 160));
    ok(r403.json.error === docs.ERR.OUTSIDE, '越界 → PATH_OUTSIDE_DOCS');
    ok(/不是「没找到」/.test(r403.json.next || ''),
      '★★ 403 的出口**先定性**：这是「拒绝了」不是「没找到」——'
      + '否则人会以为文件名写错，去找一个不存在的问题',
      JSON.stringify(r403.json.next));

    const r404 = await get('/api/docs/nosuchfile.md');
    ok(r404.status === 404, `不存在 → 404（实际 ${r404.status}）`);
    ok(/api\/docs/.test(r404.json.next || ''), '★ 404 的出口：去列表看有哪些');
    ok(/还没被写出来/.test(r404.json.next || ''),
      '★★ 并点出第二种可能（这份文档还没产出来）—— 那跟「名字写错了」是两件事');

    const r415 = await get('/api/docs/notes.txt');
    ok(r415.status === 415, `非 .md → 415（实际 ${r415.status}）`);
    ok(r415.json.error === docs.ERR.EXT, '★ 415 说得出是扩展名');

    // ★★ 三个**状态码**必须互不相同 —— 缺了这条，一个「全都 404」的实现
    //   也能过上面每一条（它们各自只断言自己那个）。
    const statuses = new Set([r403.status, r404.status, r415.status]);
    ok(statuses.size === 3, '★★ 三种状态码互不相同', JSON.stringify([...statuses]));
    const codes = new Set([r403.json.error, r404.json.error, r415.json.error]);
    ok(codes.size === 3, '★★ 三种错误码也互不相同', JSON.stringify([...codes]));
  }

  console.log('\n【5】★ 大小上限');
  {
    const big = path.join(fx.root, 'big.md');
    fs.writeFileSync(big, `# 大\n${'x'.repeat(docs.MAX_BYTES + 1024)}`);
    const r = await get('/api/docs/big.md');
    ok(r.status === 413, `★ 超限 → 413（实际 ${r.status}）`, r.body.slice(0, 160));
    ok(r.json.size > docs.MAX_BYTES && r.json.max === docs.MAX_BYTES,
      '★ 说得出实际多大、上限多少', JSON.stringify(r.json).slice(0, 200));
    ok(/直接在仓库里读/.test(r.json.next || ''), '★ 给了出口');
    fs.rmSync(big);

    // 「现在最大 20KB，不设限也没事」—— **「现在没事」不是「不用管」**：
    // 这些文件是 agent 写的，大小不受任何东西约束。
    ok(docs.MAX_BYTES > 0 && Number.isFinite(docs.MAX_BYTES), '★ 上限是个有限数');
  }

  console.log('\n【6】★★ 列表：不跟符号链接（单文件那道防线在这里没被走到）');
  {
    const b = (await get('/api/docs')).json;
    const paths = b.files.map((f) => f.path);
    ok(paths.includes('ok.md'), '列出了 ok.md');
    ok(paths.includes(path.join('research', 'deep.md')), '递归列出子目录');
    ok(!paths.includes('notes.txt'), '★ 非 .md 不列（白名单）');

    ok(!paths.includes('link.md'),
      '★★ 符号链接文件**不列** —— 列出来等于告诉人「这里有份文档」，'
      + '而点开是 403', JSON.stringify(paths));
    ok(!paths.some((p) => p.startsWith('subdir')),
      '★★ **没有跟着目录符号链接走出去** —— 那会让整棵外部树漏进列表，'
      + '而单文件端点那道防线在这条路径上根本没被走到',
      JSON.stringify(paths));

    const okRow = b.files.find((f) => f.path === 'ok.md');
    ok(typeof okRow.size === 'number' && okRow.size > 0, '★ 带 size');
    ok(typeof okRow.mtime === 'string', '★ 带 mtime');
    ok(okRow.title === '正常文档', '★ 带 title');
  }

  console.log('\n【7】★ docsRoot 自己也 realpath');
  {
    // ── 一个「过度安全」的 bug，症状是「什么都打不开」──────────────
    // macOS 上 /Volumes 或 /var 可能是符号链接。root 不解的话，
    // realpath 之后的比较会**永远失败**，把每个合法文件都判成越界。
    // 而那看起来像是防线在正常工作。
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'docs.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const fn = code.slice(code.indexOf('function docsRoot'));
    ok(/realpathSync/.test(fn.slice(0, 300)),
      '★★ docsRoot 里对 root 自己做了 realpath', fn.slice(0, 200));

    // 行为验证：真实仓库的 docs/ 读得出东西（那条路径上有 /Volumes）
    // ⚠️ 公开版的仓库里没有 docs/ 下的 .md ⇒ 那时换一个**确定有软链**的仓库根来验同一件事。
    //   而「磁盘上有 .md、列出来却是 0」照样红 —— 换路只在「本来就一个都没有」时发生。
    const mdOnDisk = (() => {
      const d = path.join(__dirname, '..', 'docs');
      try { return fs.readdirSync(d, { recursive: true }).some((f) => String(f).endsWith('.md')); } catch { return false; }
    })();
    if (mdOnDisk) {
      const real = docs.list();
      ok(real.count > 0,
        '★★ 真实仓库的 docs/ 列得出文件 —— root 没 realpath 的话这里会是 0',
        JSON.stringify(real).slice(0, 200));
    } else {
      // tmp/real/docs/a.md，而仓库根传的是指向 tmp/real 的软链。
      // 用 read()：它拿文件的 realpath 跟 root 比 —— root 没解开的话判成越界（PATH_OUTSIDE_DOCS）
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-docs-symroot-'));
      fs.mkdirSync(path.join(base, 'real', 'docs'), { recursive: true });
      fs.writeFileSync(path.join(base, 'real', 'docs', 'a.md'), '# A\n');
      fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
      let got = null; let err = '';
      try { got = docs.read('a.md', { root: docs.docsRoot(path.join(base, 'link')) }); } catch (e) { err = e.code || e.message; }
      ok(got && got.title === 'A',
        '★★ 仓库根是软链时 docs/ 里的文件照样读得到 —— root 没 realpath 的话会判成越界（仓库里没有 docs/*.md，改用临时软链根）',
        err || JSON.stringify(got).slice(0, 200));
      fs.rmSync(base, { recursive: true, force: true });
    }
  }

  console.log('\n【8】★ 顺序：先判越界，再看存不存在');
  {
    // ── 反了的话，`../nonexistent.md` 会在 realpath 那步抛 ENOENT →
    //    被归成 404「文件不存在」，**而它其实是一次越界尝试**。
    const r = await get('/api/docs/../nonexistent-outside.md');
    ok(r.status === 403,
      `★★ 越界且目标不存在 → **403 不是 404**（实际 ${r.status}）—— `
      + '归成 404 的话，一次越界尝试会被读成「文件名写错了」',
      r.body.slice(0, 200));
    ok(r.json && r.json.error === docs.ERR.OUTSIDE, '★ 错误码是越界');
  }

  console.log('\n【9】★ 接线：serve.js 挂了两个路由，用的是 lib 的 handler');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'serve.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(/app\.get\(\s*['"`]\/api\/docs['"`]/.test(code), '★★ 列表路由挂上了');
    ok(/app\.get\(\s*['"`]\/api\/docs\/\*splat['"`]/.test(code),
      '★★ 单文件路由挂上了，用的是 Express 5 的命名通配符',
      (code.match(/.*api\/docs.*/g) || []).join(' | '));
    ok(/docs\.listHandler\(/.test(code) && /docs\.readHandler\(/.test(code),
      '★★ 用的是 lib 里那两个被测过的 handler');
  }

  await app.close();
  fx.clean();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
