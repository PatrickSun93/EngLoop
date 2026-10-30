'use strict';

/**
 * shell 脚本里，`$变量` 后面不能紧跟非 ASCII 字符 —— 要写成 `${变量}`。
 *
 * ── 为什么这个文件存在 ──────────────────────────────────────────
 * macOS 自带的 bash 3.2 在 UTF-8 locale 下，会把紧跟在变量名后面的多字节字符的
 * 第一个字节也算进变量名：`"（HTTP $CODE）"` 读的是 `CODE\xef`。脚本开着 `set -u`
 * ⇒ 当场退出；没开 ⇒ 静默换成空串。
 *
 * 2026-10-30 实物：stop.sh 第一个 agent 的关停请求被 bus 接受了，脚本在打印「接受了」那行崩掉，
 * 剩下的 agent 一个都没收到请求。而 test/launchd.test.js 里跑 stop.sh 的那几轮一直是绿的 ——
 * 它们的 env 里没有 LANG，bash 跑在 C locale 下，正好躲开。
 *
 * ★ 它检的是写法，不是「跑起来对不对」：只扫非注释行里的 `$名字` ＋ 紧跟一个非 ASCII 字节。
 *   `${名字}`、`$1`、`$?` 这些不会把后面的字节读进去，不报。
 *   跑起来的那一面在 test/launchd.test.js 的 g4（UTF-8 locale 下真跑 stop.sh）。
 *
 * 单跑：`node test/sh-var-boundary.test.js`
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const ROOT = path.join(__dirname, '..');
const BAD = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/;

/** 一个文件里所有违规的行（跳过以 # 开头的注释行 —— 注释里引用反例是正常的）。 */
function offenders(text) {
  return text.split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => !/^\s*#/.test(line) && BAD.test(line));
}

console.log('\n【1】扫描器本身认得出反例（否则下面的全绿说明不了什么）');
{
  ok(offenders('echo "（HTTP $CODE）"').length === 1, '★（正控）`$CODE）` ⇒ 抓到');
  ok(offenders('echo "（HTTP ${CODE}）"').length === 0, '`${CODE}）` ⇒ 不报');
  ok(offenders('  # 反例：`"（HTTP $CODE）"`').length === 0, '注释行里的反例 ⇒ 不报');
  ok(offenders('echo "$1）" "$?。"').length === 0, '位置参数 / 特殊参数 ⇒ 不报（它们不会把后面的字节读进去）');
}

console.log('\n【2】仓库里所有被 git 跟踪的 .sh');
{
  const ls = spawnSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf8' });
  const files = ls.status === 0 ? ls.stdout.split('\n').filter(Boolean) : [];
  ok(files.includes('stop.sh') && files.includes('start.sh'),
    `（前置）git ls-files 列出了 .sh（共 ${files.length} 个，含 stop.sh、start.sh）`, ls.stderr);
  for (const f of files) {
    const bad = offenders(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    ok(bad.length === 0, `${f}：没有 \`$变量\` 紧跟非 ASCII 字符`,
      bad.map((b) => `第 ${b.n} 行：${b.line.trim()}`).join(' | '));
  }
}

console.log('\n【3】前提：本机 /bin/bash 在 UTF-8 下真的会出这个错（只报告，不判失败）');
{
  const r = spawnSync('/bin/bash', ['-c', 'set -u; CODE=200; echo "HTTP $CODE）"'],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } });
  const v = spawnSync('/bin/bash', ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0];
  console.log(`  · ${v}`);
  console.log(r.status !== 0
    ? `  · 会：exit ${r.status}，${r.stderr.trim().slice(0, 80)} ⇒ 【2】守的是一个真会发生的崩溃`
    : '  · 这个 bash 不会（新版本按字符判断变量名）⇒ 【2】在这台机器上只是写法约束');
}

console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
