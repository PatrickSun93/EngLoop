#!/usr/bin/env node
'use strict';

/**
 * Stop hook —— agent 每结束一个回合，跑**它改动范围内**的快测；有失败就拦回去继续修。
 *
 * 由 `lib/agent-settings.js` 挂给**有写能力**的类型，命令里带 `--settings <那个 agent 的框架配置>`。
 *
 * ── 🔴 测试在 sandbox 里跑 ──────────────────────────────────────────────
 *   测试文件就是 agent 写的代码。不套 sandbox 的话，agent 写一个读 `temp/bus-admin.token`、改一行源码让映射命中、
 *   结束回合 ⇒ 这个 hook 在 sandbox 外跑它 ⇒ 钥匙落进 agent 读得到的地方（「agent 读不到钥匙」这条被绕过）。
 *   ⇒ 用 `sandbox-exec` 把测试套进跟那个 agent **同一套** 拒读（钥匙）＋ 写白名单里：
 *     · 拒读 = 配置里的 `sandbox.filesystem.denyRead`（agent-settings 的 secretPaths）
 *     · 写   = 工作树（让正常测试能写 scratch），但抠掉 `temp/agent-settings`（agent 的权限配置）、`hooks`、`.claude`
 *              —— 那三处是提权路径（下回合就生效）；钥匙本身靠拒读挡，不靠这里
 *     · 网络 = 只放 localhost（测试要连 Redis / 隔离 bus）
 *   拿不到配置 / sandbox-exec 不在 ⇒ **不跑测试、放行**（exit 0 ＋ stderr 说明）——
 *   既不能把 agent 卡死，也**绝不**退回成不带 sandbox 去跑（那就是上面那个洞）。
 *
 * ── 逻辑 ────────────────────────────────────────────────────────────────
 *   ① stop_hook_active === true ⇒ 放行（防死循环；Claude Code 自己也有连续 8 次上限）
 *   ② cwd 不在 git 里，或 git status 里没有改动的 .js ⇒ 放行（必须快，每个回合都触发）
 *   ③ 改动 ⇒ 测试：lib/x.js / bin/x.js ⇒ test/x.test.js（存在才算）；改的就是 test/*.test.js ⇒ 它本身；映射不到 ⇒ 放行
 *   ④ sandbox 里逐个跑，总时长上限 120 秒。超时 ⇒ 放行 ＋ 说明。有失败 ⇒ exit 2，stderr 写哪个文件哪几条。
 *
 * 退出码：0 放行 · 2 拦（stderr 给模型看）。**任何意外都放行**（hook 自己坏了不能把 agent 卡死）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sandbox = require('../lib/sandbox-profile');

const BUDGET_MS = Number(process.env.ENGLOOP_STOP_HOOK_BUDGET_MS) > 0 ? Number(process.env.ENGLOOP_STOP_HOOK_BUDGET_MS) : 120_000;
const MAX_LINES = 20;

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

// ★ 框架自己的 git 调用都走它：带上 GIT_HARDEN，fsmonitor / hooks / pager 钉死 ——
//   测试即使在 .git 里配了外部命令（.git 的写权限也已经抠掉），这些调用也不执行它。
function gitRun(cwd, args, timeout = 10_000) {
  return spawnSync('git', ['-C', cwd, ...sandbox.GIT_HARDEN, ...args],
    { encoding: 'utf8', timeout, env: { ...process.env, ...sandbox.GIT_HARDEN_ENV } });
}

/** `git status --porcelain -z` ⇒ 改动（含未跟踪）的路径，相对仓库根。删掉的不算（没有可跑的东西）。 */
function changedPaths(top) {
  const r = gitRun(top, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (r.status !== 0) return null;
  const out = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const p = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++;          // 改名：-z 下原名在下一段，跳过
    if (xy.includes('D')) continue;
    out.push(p);
  }
  return out;
}

/** 改动的文件 ⇒ 要跑的测试文件（相对仓库根，去重、排序）。**纯函数**，导出给测试。 */
function testsFor(paths, exists) {
  const want = new Set();
  for (const p of paths) {
    let m = /^test\/([^/]+\.test\.js)$/.exec(p);
    if (m) { want.add(p); continue; }
    m = /^(?:lib|bin)\/([^/]+)\.js$/.exec(p);
    if (m) {
      const t = `test/${m[1]}.test.js`;
      if (exists(t)) want.add(t);
    }
  }
  return [...want].sort();
}

/** 从框架配置算这个 agent 跑测试该用的 sandbox profile。读不出来返回 null ⇒ 调用方放行。 */
function profileFor(settingsFile, root) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (_) { return null; }
  const fsc = cfg && cfg.sandbox && cfg.sandbox.filesystem;
  if (!fsc || !Array.isArray(fsc.denyRead)) return null;   // 配置形状不对 ⇒ 当拿不到，放行（不猜一个写集）
  // 写集 = 工作树（正常测试要写 scratch），抠掉提权路径；拒读 = 钥匙；额外放 tmp（测试起隔离 bus）。
  return sandbox.buildProfile({
    allowWrite: [root, ...(Array.isArray(fsc.allowWrite) ? fsc.allowWrite : [])],
    denyRead: fsc.denyRead,
    // ★ denyRead 里有**目录**（agy 专用 HOME，agent-settings.secretDirs）—— `literal` 管不住目录里的文件
    //   ⇒ 是目录的那几项再按 subpath 拒一次。判「是不是目录」看磁盘：目录还不存在时 literal 那一条也就够了（里面没东西）。
    denyReadTree: fsc.denyRead.filter((p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }),
    reDenyWrite: [
      path.join(root, 'temp', 'agent-settings'),
      path.join(root, 'hooks'),
      path.join(root, '.claude'),
      // ★ `.git`（目录或指针文件）—— 测试往 .git/config 写 fsmonitor / hooks，之后框架在 sandbox 外跑 git 就执行它。
      //   工作树的 git 元数据目录（linked worktree 在主仓库的 .git/worktrees/ 下）本来就不在白名单里（只放了 root ＋ tmp），所以这里抠 root/.git 就够。
      path.join(root, '.git'),
    ],
    allowTmp: true,
  });
}

function failuresOf(out) {
  return (out.match(/^[ \t]*✗.*$/gm) || []).map((l) => l.trim()).slice(0, MAX_LINES);
}

function main() {
  const t0 = Date.now();
  const input = readInput();
  if (input.stop_hook_active === true) return 0;

  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const top = gitRun(cwd, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return 0;
  const root = top.stdout.trim();
  const changed = changedPaths(root);
  if (!changed || !changed.some((p) => p.endsWith('.js'))) return 0;

  const tests = testsFor(changed, (rel) => fs.existsSync(path.join(root, rel)));
  if (!tests.length) return 0;

  // ── 🔴 sandbox 装置：缺一样就放行，绝不退回成不带 sandbox 跑 ──
  const settingsFile = argValue('--settings');
  if (!settingsFile) {
    process.stderr.write('[stop_check] 没拿到 --settings（框架配置路径）⇒ 不确定该用哪套 sandbox，这次不跑测试、放行。\n');
    return 0;
  }
  if (!sandbox.available()) {
    // available() 真套一次探针：没装 sandbox-exec，或这个进程本身已经在限制性 sandbox 里（第二层套不上，exit 71）
    process.stderr.write(`[stop_check] ${sandbox.SANDBOX_EXEC} 在这里套不上（没装，或这个进程本身已在 sandbox 里）⇒ 不能把测试关进 sandbox，这次不跑、放行（不退回成不带 sandbox 跑）。\n`);
    return 0;
  }
  const profile = profileFor(settingsFile, root);
  if (!profile) {
    process.stderr.write(`[stop_check] 读不出 ${settingsFile} 的 sandbox 配置 ⇒ 不跑测试、放行。\n`);
    return 0;
  }
  const sbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-stop-sb-'));
  const profileFile = path.join(sbDir, 'profile.sb');
  fs.writeFileSync(profileFile, profile);

  try {
    const failed = [];
    for (const t of tests) {
      const left = BUDGET_MS - (Date.now() - t0);
      if (left <= 0) {
        process.stderr.write(`[stop_check] 范围内快测超过 ${BUDGET_MS / 1000} 秒预算，没跑完（还剩 ${tests.slice(tests.indexOf(t)).join(', ')}）—— 这次不拦。\n`);
        return 0;
      }
      const argv = sandbox.wrap(profileFile, [process.execPath, path.join(root, t)]);
      const r = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', timeout: left, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
      if (r.error && r.error.code === 'ETIMEDOUT') {
        process.stderr.write(`[stop_check] ${t} 跑到 ${BUDGET_MS / 1000} 秒预算用完还没结束 —— 这次不拦。\n`);
        return 0;
      }
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const sums = [...out.matchAll(/通过 (\d+) · 失败 (\d+)/g)];
      const last = sums.length ? sums[sums.length - 1] : null;
      const nFail = last ? Number(last[2]) : null;
      if (r.status !== 0 || (nFail !== null && nFail > 0)) {
        const lines = failuresOf(out);
        failed.push(`${t}：${last ? `失败 ${nFail}` : '没报出总数'}（exit ${r.status}）\n`
          + (lines.length ? lines.map((l) => `    ${l}`).join('\n') : `    ${out.trim().split('\n').slice(-8).join('\n    ')}`));
      }
    }
    if (!failed.length) return 0;
    process.stderr.write(`[stop_check] 你改动范围内的测试没过 —— 修好再结束这个回合（跑的是 ${tests.join(', ')}；不是全量；在 sandbox 里跑）：\n`
      + `${failed.join('\n')}\n`
      + '如果这些失败跟你的改动无关（改动前就红），在回复里说明是哪几条、为什么，然后再结束。\n'
      + '如果失败是「权限不足 / EPERM」：测试要写工作树外、或读钥匙 —— 那是 sandbox 按设计拦的，不是你的改动坏了。\n');
    return 2;
  } finally {
    fs.rmSync(sbDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  let code = 0;
  try { code = main(); } catch (e) {
    process.stderr.write(`[stop_check] hook 自己出错了，这次不拦：${e.message}\n`);
    code = 0;
  }
  process.exit(code);
}

module.exports = { testsFor, changedPaths, profileFor, BUDGET_MS };
