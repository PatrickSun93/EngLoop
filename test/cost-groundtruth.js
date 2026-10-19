'use strict';

/**
 * 正控：同一次调用，两个独立通道对账。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个脚本存在的理由，跟单测守的东西**不是一回事**：
 *
 *   test/cost.test.js 证明的是「读字段没读错」。
 *   这个脚本证明的是「**落盘这件事本身没骗人**」——
 *   jsonl 里那些数字，确实就是这次 API 调用真实发生的用量。
 *
 * 办法：跑一次 `claude -p --output-format json`，它**在 stdout 直接
 * 返回 usage**。同一次调用同时也落了 jsonl。两个通道互相独立，
 * 逐字段必须相等。
 *
 * ⚠️ **这个脚本要花额度**（一次 hello 级调用），所以：
 *   · 文件名故意不带 `.test.js` —— `test/run-all.js` 只收 `.test.js`，
 *     它不会被 `npm test` 自动跑到。
 *   · 手动跑：`node test/cost-groundtruth.js`
 *
 * 「代码跑通了」不算验证 —— 这个项目已经被「测试全绿但字段是字符串
 * "false"」坑过一次。所以要有一次真实调用的对账。
 * ══════════════════════════════════════════════════════════════════
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const cost = require('../lib/cost');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

function claudeBin() {
  const cands = [
    process.env.ENGLOOP_CLAUDE_BIN,
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
}

// cwd 用一个**空的临时目录**：它会得到自己的 projects 目录，
// 里面只有这一次调用 —— 不用在几万行里大海捞针。
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-cost-gt-'));

function run(bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, [
      '-p', '只回答 OK 两个字，不要使用任何工具，不要做任何别的事。',
      '--output-format', 'json',
      // 禁工具：让这次运行只有一次 API 调用，对账才是一对一的。
      '--disallowedTools', 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task',
    ], { cwd: workdir, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr}`));
      resolve(stdout);
    });
  });
}

async function main() {
  console.log('\n【正控】claude -p 的 stdout usage  vs  它自己落盘的 jsonl');
  console.log(`  临时工作目录：${workdir}`);

  let bin;
  try {
    bin = claudeBin();
  } catch (_) {
    console.log('  ⏭ 找不到 claude 可执行文件，跳过');
    console.log('\n通过 0 · 失败 0');
    return;
  }

  console.log('  跑一次真实调用（会花一点额度）…');
  const stdout = await run(bin);

  let res;
  try {
    res = JSON.parse(stdout);
  } catch (e) {
    console.log(`  ✗ stdout 不是 JSON：${stdout.slice(0, 300)}`);
    fail++;
    return;
  }

  const sid = res.session_id || res.sessionId;
  ok(!!sid, 'stdout 带 session_id', JSON.stringify(Object.keys(res)));
  ok(!!res.usage, 'stdout 带 usage', JSON.stringify(Object.keys(res)));
  if (!sid || !res.usage) return;

  const su = res.usage;
  console.log(`  stdout: in=${su.input_tokens} out=${su.output_tokens} `
    + `cache_rd=${su.cache_read_input_tokens} cache_cr=${su.cache_creation_input_tokens}`);

  // ── 找它落盘的 jsonl ──────────────────────────────────────────
  // 不去猜「cwd 怎么编码成目录名」—— 直接找文件名等于 session_id 的那个。
  // 猜编码规则正是这个项目一直在反对的「从文本推断状态」。
  const projects = cost.PROJECTS_DIR;
  let file = null;
  for (const d of fs.readdirSync(projects)) {
    const p = path.join(projects, d, `${sid}.jsonl`);
    if (fs.existsSync(p)) { file = p; break; }
  }
  ok(!!file, `落盘的 jsonl 找得到（${sid}）`, `在 ${projects} 下找不到`);
  if (!file) return;
  console.log(`  jsonl:  ${file}`);

  const raw = cost.readSessionFile(file);
  ok(raw.length > 0, `jsonl 里读出计量记录（原始 ${raw.length} 行）`);

  const { entries, duplicateRows, conflicts } = cost.dedupe(raw);
  console.log(`  去重：${raw.length} 行 → ${entries.length} 次调用（压掉 ${duplicateRows} 行）`);
  ok(conflicts.length === 0, '同一 requestId 的多行 usage 一致',
    conflicts.length ? JSON.stringify(conflicts[0]) : '');

  // ── 核心断言：两个通道逐字段相等 ──────────────────────────────
  //
  // 禁了工具，所以这次运行只有一次 API 调用，stdout 的 usage 就是
  // 那一次的用量。求和只是为了不依赖「一定只有一条」这个假设 ——
  // 真有多条时求和才是对的口径，而下面那条断言会报出是不是多条。
  const sum = entries.reduce((a, e) => ({
    input: a.input + e.input, output: a.output + e.output,
    cacheRead: a.cacheRead + e.cacheRead, cacheCreate: a.cacheCreate + e.cacheCreate,
  }), { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });

  console.log(`  jsonl:  in=${sum.input} out=${sum.output} `
    + `cache_rd=${sum.cacheRead} cache_cr=${sum.cacheCreate}`);

  ok(entries.length === 1, `这次运行只有 1 次 API 调用（实际 ${entries.length}）`);
  ok(sum.output === su.output_tokens, `output_tokens 对上：${sum.output} == ${su.output_tokens}`);
  ok(sum.input === su.input_tokens, `input_tokens 对上：${sum.input} == ${su.input_tokens}`);
  ok(sum.cacheRead === (su.cache_read_input_tokens || 0),
    `cache_read 对上：${sum.cacheRead} == ${su.cache_read_input_tokens || 0}`);
  ok(sum.cacheCreate === (su.cache_creation_input_tokens || 0),
    `cache_creation 对上：${sum.cacheCreate} == ${su.cache_creation_input_tokens || 0}`);

  // ── 归属：这次调用的 cwd 不在 EngLoop 下，必须被排除 ──────────
  //
  // 守的是那条「别的项目混进来就是错的数字，而它看起来完全合理」。
  ok(cost.agentOf(entries[0].cwd) === null,
    `临时目录不算 EngLoop 的开销（cwd=${entries[0].cwd}）`);

  // ★ stdout 里还有 total_cost_usd —— **故意不用它**。
  //   订阅制下那个数不是实付，见 lib/cost.js 文件头。
  if (res.total_cost_usd !== undefined) {
    console.log(`  （stdout 里有 total_cost_usd=${res.total_cost_usd}，`
      + '故意不采信：订阅制下它不是实付金额）');
  }
}

main()
  .catch((e) => { fail++; console.log(`  ✗ 跑挂了：${e.message}`); })
  .finally(() => {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n通过 ${pass} · 失败 ${fail}\n`);
    process.exit(fail === 0 ? 0 : 1);
  });
