'use strict';

/**
 * `web/*.js` 能不能被解析。
 *
 * ── 为什么这个文件存在 ──────────────────────────────────────────
 * 往 `web/app.js` 的 `renderAgents` 中间插代码时多写一个 `}`，
 * 就能把函数后半段变成孤儿代码，**而全量测试全绿。**
 *
 * 原因很简单也很吓人：`web/` 下的脚本是浏览器加载的，**没有任何测试会
 * require 它们** —— 于是整个 web 目录在测试眼里是一堆纯文本。
 * wiring.test.js 里那些源码断言用的是正则，正则读一个语法错误的文件
 * 一样读得下去。
 *
 * > ⚠️ 而这个缺口的表现是：**页面整个白掉，而 CI 全绿。**
 * > 同一个缺口的另一面：脚本切片错误删掉几个函数，测试只红几条源码断言。
 *
 * ★ 它检的是「能不能解析」，**不是「跑起来对不对」**。
 *   这条边界要写下来，免得下一个人以为 web 已经被测了。
 *
 * 单跑：`node test/web-syntax.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const WEB = path.join(__dirname, '..', 'web');

/** 用 `node --check` 真的解析一遍 —— 不是正则，不是「看起来像」。 */
function checkSyntax(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return { ok: r.status === 0, err: `${r.stderr || ''}`.trim() };
}

console.log('\n【1】web/ 下每个 .js 都要能解析');
{
  const files = fs.readdirSync(WEB).filter((f) => f.endsWith('.js'));
  ok(files.length > 0, `（前置）找到 ${files.length} 个脚本：${files.join(', ')}`);
  for (const f of files) {
    const r = checkSyntax(path.join(WEB, f));
    ok(r.ok, `★ ${f} 语法正确`, r.err.split('\n').slice(0, 3).join(' / '));
  }
}

console.log('\n【2】★★ 阴性对照 —— 这个检查器真的抓得到东西');
{
  // 没有这一条的话，一个「永远返回 ok」的实现也能让上面全绿 ——
  // 而那正是这个文件要防的那种缺陷：一个不会失败的检查器，
  // 跟没有检查器**唯一的区别是它让人放心**。
  const tmp = path.join(os.tmpdir(), `engloop-syntax-${process.pid}.js`);
  fs.writeFileSync(tmp, 'function a() {\n  return 1;\n}\n}\n');  // 多一个 }
  const bad = checkSyntax(tmp);
  ok(!bad.ok, '★★ 多一个 `}` 的文件必须被判为不合法');
  ok(/SyntaxError/.test(bad.err), '★ 而且错误里说得出是语法错', bad.err.slice(0, 80));

  fs.writeFileSync(tmp, 'function a() { return 1; }\n');
  ok(checkSyntax(tmp).ok, '★ 阴性对照的阴性对照：合法文件不误报');
  fs.rmSync(tmp, { force: true });
}

console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
