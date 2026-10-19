'use strict';

/**
 * verify-complete 的夹具：一个临时 git 仓库，里面一个最小的 node 项目和它的测试。
 * 不是 `.test.js`（run-all 不会把它当测试跑），给 verify-complete / done-verify 的测试共用。
 *
 * 项目：`lib/math.js`（add / sub / mul）＋ `test/math.test.js`（每个函数一条断言）
 *       ＋ `test/run.js` —— 一个最小的 runner，按 `test/run-all.js` 的机器可读格式
 *       （`engloop-test-results/1`）把逐条失败写到 `ENGLOOP_TEST_RESULTS`。
 * ⚠️ 不直接用 EngLoop 的 run-all：它依赖 EngLoop 的 lib/，夹具仓库里没有。夹具验的是
 *    verify-complete 对「那个格式」的判定，runner 只是格式的生产者。
 *
 * `breakFn('mul')` 把某个函数改坏 ⇒ 那条断言红；`commit()` 提交并返回 sha。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNNER = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
const out = { schema: 'engloop-test-results/1', files: [], total: { pass: 0, fail: 0, broken: 0 } };
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
  const o = (r.stdout || '') + (r.stderr || '');
  const m = [...o.matchAll(/通过 (\\d+) · 失败 (\\d+)/g)].pop();
  const pass = m ? Number(m[1]) : 0;
  const fail = m ? Number(m[2]) : 0;
  const bad = r.status !== 0 || fail > 0 || !m;
  const failures = bad ? [...o.matchAll(/^[ \\t]*✗[ \\t]*(.*)$/gm)].map((x) => x[1].split('  → ')[0].trim()) : [];
  out.files.push({ file: f, pass, fail, exit: r.status, reported: Boolean(m), skipped: false, failures });
  out.total.pass += pass; out.total.fail += fail;
}
if (process.env.ENGLOOP_TEST_RESULTS) fs.writeFileSync(process.env.ENGLOOP_TEST_RESULTS, JSON.stringify(out));
console.log('合计 通过 ' + out.total.pass + ' · 失败 ' + out.total.fail);
process.exit(out.total.fail ? 1 : 0);
`;

/** 「老版本 runner」：只打人类输出、不写机器可读结果（模拟 run-all 还没有 --json 时的老基线）。 */
const OLD_RUNNER = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.test.js')).sort()) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
}
`;

const MATH = {
  add: 'exports.add = (a, b) => a + b;',
  sub: 'exports.sub = (a, b) => a - b;',
  mul: 'exports.mul = (a, b) => a * b;',
};
const BROKEN = {
  add: 'exports.add = (a, b) => a + b + 1;',
  sub: 'exports.sub = (a, b) => b - a;',
  mul: 'exports.mul = (a, b) => a + b;',
};

const TEST = `'use strict';
const m = require('../lib/math');
let pass = 0, fail = 0;
const ok = (c, l, d) => c ? (pass++, console.log('  ✓ ' + l)) : (fail++, console.log('  ✗ ' + l + '  → ' + d));
ok(m.add(2, 3) === 5, 'add 2+3=5', 'got ' + m.add(2, 3) + ' at ' + Date.now());
ok(m.sub(5, 3) === 2, 'sub 5-3=2', 'got ' + m.sub(5, 3) + ' at ' + Date.now());
ok(m.mul(2, 3) === 6, 'mul 2*3=6', 'got ' + m.mul(2, 3) + ' at ' + Date.now());
console.log('通过 ' + pass + ' · 失败 ' + fail);
process.exit(fail ? 1 : 0);
`;

function sh(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
  return String(r.stdout).trim();
}

/**
 * @param {string} [parent] 夹具放哪（默认系统临时目录）。Stop hook 的真 claude 测要放在 /private/tmp 之外。
 * @param {object} [o.broken] 初始（main 上）就坏掉的函数，比如 { add: true } ⇒ 基线就有一条失败
 * @param {boolean} [o.oldRunner] main 上的 runner 不写机器可读结果
 */
function makeFixture(parent = os.tmpdir(), { broken = {}, oldRunner = false } = {}) {
  const repo = fs.mkdtempSync(path.join(parent, 'engloop-vfix-'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const mathSrc = (b) => `${Object.keys(MATH).map((k) => (b[k] ? BROKEN[k] : MATH[k])).join('\n')}\n`;
  sh(parent, ['init', '-q', '-b', 'main', repo]);
  sh(repo, ['config', 'user.email', 'fixture@example.invalid']);
  sh(repo, ['config', 'user.name', 'fixture']);
  write('lib/math.js', mathSrc(broken));
  write('test/math.test.js', TEST);
  write('test/run.js', oldRunner ? OLD_RUNNER : RUNNER);
  write('.gitignore', 'node_modules/\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-q', '-m', 'base']);
  let state = { ...broken };
  return {
    repo,
    git: (args) => sh(repo, args),
    write,
    branch(name) { sh(repo, ['checkout', '-q', '-B', name, 'main']); state = { ...broken }; },
    setBroken(b) { state = { ...b }; write('lib/math.js', mathSrc(state)); },
    useNewRunner() { write('test/run.js', RUNNER); },
    commit(msg = 'change') {
      sh(repo, ['add', '-A']);
      sh(repo, ['commit', '-q', '--allow-empty', '-m', msg]);
      return sh(repo, ['rev-parse', 'HEAD']);
    },
    head: () => sh(repo, ['rev-parse', 'HEAD']),
    worktrees: () => sh(repo, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length,
    cleanup() { fs.rmSync(repo, { recursive: true, force: true }); },
  };
}

module.exports = { makeFixture, RUNNER, OLD_RUNNER };
