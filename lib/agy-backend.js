'use strict';

/**
 * agy（Antigravity CLI）当一次性写代码 worker 的后端。
 *
 * ── 做法：sandbox-exec 包**整个** agy 进程 ─────────────────────────────
 *   agy 自己的 `--sandbox` 只关终端，文件读写工具不在里面 ⇒ 文件工具能读到钥匙、往主仓库和别的项目写文件、
 *   直接改 main 的 ref。而它把终端关得太死（cwd 都写不进、git 不认 worktree）⇒ 正常的活也干不了。
 *   ⇒ 用框架自己的 `lib/sandbox-profile.js` 把 agy 进程整个包起来：终端、文件工具、它的子进程同在一个 sandbox。
 *   `sandbox-exec` 不可用 ⇒ **不起 worker**（permanent），没有不带 sandbox 的退路（跟 failIfUnavailable 同一个原则）。
 *
 * ── 已知并接受的取舍（写在这里，不藏）────────────────────────────
 *   · **网络全开**。seatbelt 按地址 / 端口放、不按域名，agy 要连 Google ⇒ 只能整体放开 ⇒ 它的 Bash 也能上网。
 *     后果 ①：`git push` 到真 remote 没有网络层的拦截 —— 本机这一层靠「拒读真实用户目录下的推送凭据」（下面 credentialTrees）堵上
 *       （不拒读时 `HOME=<真 HOME> git ls-remote <私有仓库>` 会走 osxkeychain 成功，拒读 ~/Library/Keychains 后失败）。
 *       远端若没开分支保护 ⇒ **这是唯一一层**。
 *     后果 ②：拒读名单以外、这个用户能读的一切都能直接发出去。**这里不加网络过滤**。
 *   · agy 的 Bash 能碰到 agy 自己的 Google 登录（它就在专用 HOME 里，agy 要读它）—— 接受。
 *     ⇒「读不到登录凭据」这条边界对 agy 不要求；专用 HOME 本身进 agent-settings.secretDirs() ⇒ 所有 **claude** agent 拒读。
 *     ⚠️ 接受的只是**专用 HOME 那一份**。用户日常 agy 的登录（真实用户目录下的 `~/.gemini`）worker 用不着 ⇒ 拒读。
 *
 * ── agy 的行为事实（每一条都决定了下面某段代码）────────────────────────────
 *   · 写集要比「cwd ＋ 状态目录 ＋ TMPDIR」多出这棵 worktree 的 git 元数据四项，不然 commit 失败。
 *   · 专用 HOME（agy 每次起终端都重写状态目录里的 bin/agentapi，状态目录必须可写；用户日常的 agy 读同一个目录 ⇒ 不能共用）。
 *   · 必须带 `--project <专用 project>`：不带就落到默认 project（工作区可能是整个上层目录，文件会落进别的仓库）。
 *   · 超时 = **exit 0 ＋ status SUCCESS ＋ 空 response**，唯一信号是 stderr 的 `print timeout` ⇒ 只看 exit / status 会把超时当成功。
 *   · 超时的第二种样子：agy 把命令放到后台、先回一句「在等」，
 *     到了 --print-timeout 杀掉后台任务 ⇒ exit 0 ＋ SUCCESS ＋ **response 非空**，stderr 里没有 `print timeout`，
 *     只有 `terminating N background task(s) on exit` ⇒ 那一行也判超时。
 *   · 人格拼进 prompt 开头：agy 读 cwd 往上到 git 根的 `AGENTS.md` / `GEMINI.md`，不读 `CLAUDE.md`。
 *   · 终端起不来时 agy **不一定按 prompt 停下**，可能自己去读写配置目录 —— 专用 HOME 让这件事只影响它自己；人格里也写了「停下报告」。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync, execFileSync } = require('node:child_process');
const { AGY_CONFIG } = require('./agy-config');
const agentSettings = require('./agent-settings');
const sandboxProfile = require('./sandbox-profile');

const ROOT = path.join(__dirname, '..');

/** agy 读的上下文文件名（读这两个，不读 CLAUDE.md）。 */
const CONTEXT_FILES = ['AGENTS.md', 'GEMINI.md'];

/** worktree 分支名约定（lib/agent-worktree.js 的 branchFor）。 */
const WT_BRANCH_RE = /^wt\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 超时比 `--print-timeout` 多给一点：让 agy 自己先到点、按它的方式收尾，execFile 的 kill 是兜底。 */
const KILL_GRACE_MS = 60_000;

function gitOut(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...sandboxProfile.GIT_HARDEN, ...args],
    { encoding: 'utf8', env: { ...process.env, ...sandboxProfile.GIT_HARDEN_ENV } });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

/**
 * job 的 cwd 是不是一棵 **linked worktree 的根**、在 `wt/<name>` 分支上。
 * 新后端的产出永远先落在分支上；进 main 只有一条路：verify-complete（全量）→ 编排者 wt-merge。
 * 要求是**根**，不是子目录：写集按 cwd 算，子目录的话 worktree 根上别的文件改不了、AGENTS.md 检查也会少一段。
 * @returns {{ ok: true, top, gitDir, common, branch, name } | { ok: false, error }}
 */
function linkedWorktree(cwd) {
  let real;
  try { real = fs.realpathSync(cwd); } catch (_) { return { ok: false, error: `cwd 不存在：${cwd}` }; }
  const top = gitOut(real, ['rev-parse', '--show-toplevel']);
  if (!top) return { ok: false, error: `cwd 不在 git 里：${real}` };
  if (fs.realpathSync(top) !== real) return { ok: false, error: `cwd 要是 worktree 的根（${top}），不是它下面的子目录：${real}` };
  const gitDir = gitOut(real, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = gitOut(real, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!gitDir || !common) return { ok: false, error: `读不出 git 目录：${real}` };
  if (path.resolve(gitDir) === path.resolve(common)) {
    return { ok: false, error: `cwd 是主工作树，不是 linked worktree：${real} —— 用 \`node bin/agent-start.js --name <名字> --worktree\` 建一棵，或者 \`git worktree add -b wt/<名字> …\`` };
  }
  const branch = gitOut(real, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch || !WT_BRANCH_RE.test(branch)) {
    return { ok: false, error: `linked worktree 的当前分支要形如 wt/<名字>（实际：${branch || '(detached)'}）—— 产出要落在 wt 分支上，进 main 只走 wt-merge` };
  }
  return { ok: true, top: real, gitDir: path.resolve(gitDir), common: path.resolve(common), branch, name: path.basename(gitDir) };
}

/** cwd 往上到 git 根这一段里有没有 agy 会读的上下文文件（有 ⇒ 别人写的东西会混进它的系统上下文）。 */
function contextFilesOnPath(cwd, top) {
  const found = [];
  let d = path.resolve(cwd);
  const stop = path.resolve(top);
  for (;;) {
    for (const f of CONTEXT_FILES) if (fs.existsSync(path.join(d, f))) found.push(path.join(d, f));
    if (d === stop || path.dirname(d) === d) break;
    d = path.dirname(d);
  }
  return found;
}

/**
 * 真实用户目录下的推送凭据 —— **按 os.userInfo().homedir 算，不按 HOME**：
 * 进程里的 HOME 是专用 HOME，而 worker 可以在 Bash 里把 HOME 改回去。
 * ~/.git-credentials、~/.netrc 一起拒（存在与否都拒）。
 * `.gemini`：用户**自己的** agy 登录（不拒读就能读到，而网络是开的 ⇒ 读到就能发出去）——
 * worker 的 agy 用的是专用 HOME 里那一份，这一份它用不着。
 */
function credentialTrees(realHome = os.userInfo().homedir) {
  return ['Library/Keychains', '.ssh', '.config/gh', '.git-credentials', '.netrc', '.gemini'].map((p) => path.join(realHome, p));
}

/**
 * agy 那个 sandbox 的 profile（包整个 agy 进程，拒读推送凭据）。
 * @param {object} o
 * @param {string} o.cwd      job cwd（linked worktree 的根）
 * @param {object} o.wt       linkedWorktree() 的结果
 * @param {string} o.home     专用 HOME（agy 的状态目录在它下面，必须可写）
 * @param {string} o.tmpdir   这个 job 私有的 TMPDIR
 * @param {string} [o.root]   EngLoop 根（钥匙位置）
 * @param {string} [o.realHome]
 */
function buildAgyProfile({ cwd, wt, home, tmpdir, root = ROOT, realHome }) {
  return sandboxProfile.buildProfile({
    allowWrite: [
      cwd,
      // ★ git 元数据四项：commit 要写对象、这棵 worktree 的 index/HEAD、wt/* 分支的 ref 和 reflog（少了它们 ⇒ commit 失败）
      path.join(wt.common, 'objects'),
      path.join(wt.common, 'worktrees', wt.name),
      path.join(wt.common, 'refs', 'heads', 'wt'),
      path.join(wt.common, 'logs', 'refs', 'heads', 'wt'),
      home,
      tmpdir,
    ],
    denyRead: agentSettings.secretPaths(root),
    // 推送凭据整棵拒读（网络全开时，本机这一层对 push 的唯一堵法）。专用 HOME **不在**这里 —— agy 要读它登录。
    denyReadTree: credentialTrees(realHome),
    reDenyWrite: [
      ...agentSettings.mainRefGuard(cwd),
      path.join(cwd, '.git'),   // worktree 的 .git 指针文件：改了它就能把 git 指到别处
    ],
    reDenyWriteRegex: [sandboxProfile.gitExecConfigRegex(wt.common)],
    network: 'open',            // 有意全开，见文件头「已知并接受的取舍」
  });
}

/**
 * agy 二进制：真实用户目录下的 ~/.local/bin/agy → which agy。找不到 ⇒ null（调用方 permanent）。
 * 显式给了（测试注入）就**只认它**，不在就 null —— 不往下找：在 Mac 上往下找会找到真 agy，测试就真去调了。
 */
function resolveAgyBin(explicit, realHome = os.userInfo().homedir) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const home = path.join(realHome, '.local', 'bin', 'agy');
  if (fs.existsSync(home)) return home;
  try {
    const w = execFileSync('which', ['agy'], { encoding: 'utf8' }).trim();
    if (w) return w;
  } catch (_) { /* 落到 null */ }
  return null;
}

/**
 * agy 的一次输出 ⇒ 结果。**四种都判失败**：exit≠0、status≠SUCCESS、stderr 有 `print timeout`、response 为空。
 * ⚠️ 超时的表现是 exit 0 ＋ "status":"SUCCESS" ＋ 空 response ＋ stderr `[agy] print timeout after …` ⇒ 只看前两样会当成功。
 */
function parseAgyResult({ code, stdout, stderr, killed }) {
  const out = String(stdout || '');
  const err = String(stderr || '');
  if (killed) return { ok: false, reason: 'timeout', error: 'agy 超时，被 kill（--print-timeout 之后还没退）' };
  if (/print timeout/i.test(err)) return { ok: false, reason: 'timeout', error: `agy 到了 --print-timeout：${err.trim().split('\n')[0].slice(0, 300)}` };
  let j = null;
  try { j = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || ''); } catch (_) { /* 下面报 */ }
  // 超时的第二种样子：后台任务在 --print-timeout 被杀，而 exit 0 ＋ SUCCESS ＋ response 非空（「在等」那一句）
  const bgKilled = err.split('\n').find((l) => /terminating \d+ background task/i.test(l));
  if (bgKilled) {
    const said = j && typeof j.response === 'string' ? j.response.trim().slice(0, 200) : '';
    return { ok: false, reason: 'timeout', error: `agy 到了 --print-timeout，后台任务被杀：${bgKilled.trim().slice(0, 300)}${said ? `（它的 response：${said}）` : ''}` };
  }
  if (code !== 0) return { ok: false, reason: 'error', error: `agy exit ${code}：${(j && j.error) || err.trim().slice(0, 300) || out.slice(0, 300)}` };
  if (!j) return { ok: false, reason: 'error', error: `agy 的输出不是 JSON：${out.slice(0, 300)}` };
  if (j.status !== 'SUCCESS') return { ok: false, reason: 'error', error: `agy status=${j.status}：${String(j.error || '').slice(0, 300)}` };
  const response = typeof j.response === 'string' ? j.response.trim() : '';
  if (!response) return { ok: false, reason: 'error', error: 'agy 返回了空 response（超时也是这个样子 —— 当失败处理）' };
  return { ok: true, output: response };
}

const permanentFail = (reason, error) => ({ ok: false, ms: 0, reason, permanent: true, error, via: 'agy' });

/**
 * 跑一次 agy。返回形状跟 worker-runner.runPrint 一样（ok / ms / reason / permanent / output / error），外加 via:'agy'。
 *
 * @param {{ text: string }} task
 * @param {object} opts
 * @param {string} opts.cwd                 job cwd（必须是 linked worktree 的根）
 * @param {number} [opts.timeoutMs]
 * @param {string} opts.appendSystemPromptFile  人格文件（workers/solve/AGY.md）—— 拼进 prompt 开头，不落进 cwd
 * @param {string} [opts.root]
 * @param {{home: string, projectId: string}} [opts.agy]  默认 lib/agy-config.js 那一处
 * @param {object} [deps]  测试注入：{ sandbox, agyBin, realHome }。**没有环境变量开关**。
 */
function runAgy(task, opts = {}, deps = {}) {
  const sandbox = deps.sandbox || sandboxProfile;
  const { cwd, timeoutMs = 600_000, appendSystemPromptFile, root = ROOT } = opts;
  const agy = opts.agy || AGY_CONFIG;
  return new Promise((resolve) => {
    // ① sandbox 起不来 ⇒ 不起
    if (!sandbox.available()) {
      resolve(permanentFail('sandbox_unavailable', 'sandbox-exec 用不了 ⇒ agy worker 不起（没有不带 sandbox 的退路）'));
      return;
    }
    // ② 配置：专用 HOME 在、project id 有 —— 缺了不回退到用户的 HOME / 默认 project
    if (!agy || typeof agy.projectId !== 'string' || !agy.projectId) {
      resolve(permanentFail('agy_config', 'agy 的专用 project id 没配（lib/agy-config.js）—— 不带 --project 会落到默认 project（工作区是默认 project 配的那个大目录，不是 EngLoop）'));
      return;
    }
    if (typeof agy.home !== 'string' || !fs.existsSync(agy.home) || !fs.statSync(agy.home).isDirectory()) {
      resolve(permanentFail('agy_config', `agy 的专用 HOME 不在：${agy && agy.home} —— 先用它登录一次（HOME=<它> agy）`));
      return;
    }
    // ③ 二进制
    const bin = resolveAgyBin(deps.agyBin, deps.realHome);
    if (!bin) { resolve(permanentFail('agy_missing', '找不到 agy 可执行文件（~/.local/bin/agy、PATH 里都没有）')); return; }
    // ④ linked worktree 闸（worker-pool 已查过一次；这里是第二道 —— runAgy 也可能被直接调用）
    const wt = linkedWorktree(cwd || '');
    if (!wt.ok) { resolve(permanentFail('not_linked_worktree', wt.error)); return; }
    // ⑤ 上下文文件：cwd → git 根这一段有 AGENTS.md / GEMINI.md ⇒ 不起（别人写的东西会进 agy 的系统上下文）
    const ctx = contextFilesOnPath(wt.top, wt.top);
    if (ctx.length) { resolve(permanentFail('agy_context_file', `cwd 里有 agy 会读的上下文文件：${ctx.join('、')} —— 删掉或改名再派`)); return; }
    // ⑥ 人格
    let persona;
    try { persona = fs.readFileSync(appendSystemPromptFile, 'utf8'); } catch (e) {
      resolve(permanentFail('persona_missing', `agy 的人格文件读不到：${appendSystemPromptFile}（${e.code || e.message}）`));
      return;
    }

    // ⑦ 每个 job 私有的 TMPDIR（在写集里）和放 profile 的目录（**不在**写集里：agy 改不了自己的 sandbox 规则）
    let tmpdir; let profDir;
    try {
      tmpdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-agy-tmp-')));
      profDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-agy-prof-')));
    } catch (e) { resolve({ ok: false, ms: 0, reason: 'error', error: `建临时目录失败：${e.message}`, via: 'agy' }); return; }
    const cleanup = () => {
      for (const d of [tmpdir, profDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 已经没了 */ } }
    };
    const profileFile = path.join(profDir, 'agy.sb');
    try {
      fs.writeFileSync(profileFile, buildAgyProfile({ cwd: wt.top, wt, home: agy.home, tmpdir, root, realHome: deps.realHome }));
    } catch (e) { cleanup(); resolve({ ok: false, ms: 0, reason: 'error', error: `写 sandbox profile 失败：${e.message}`, via: 'agy' }); return; }

    const prompt = `${persona.trim()}\n\n---\n\n## 这次的任务\n\n${task.text}`;
    const argv = sandbox.wrap(profileFile, [
      bin, '-p', prompt,
      '--output-format', 'json',
      '--print-timeout', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
      '--project', agy.projectId,
      // 显式带：不依赖用户全局 settings.json 的 always-proceed（默认值下的行为没验证过）
      '--dangerously-skip-permissions',
    ]);
    // env 从零开始（env -i）：HOME = 专用 HOME、私有 TMPDIR、PATH。不传 ANTHROPIC_*、不传 Claude Code 的会话变量、不传 bus 的任何东西。
    const env = { HOME: agy.home, TMPDIR: tmpdir, PATH: process.env.PATH || '/usr/bin:/bin' };

    const started = Date.now();
    execFile(argv[0], argv.slice(1), {
      cwd: wt.top, env, timeout: timeoutMs + KILL_GRACE_MS, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      cleanup();
      const ms = Date.now() - started;
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const r = parseAgyResult({ code, stdout, stderr, killed: Boolean(err && err.killed) });
      resolve({ ...r, ms, via: 'agy', stderr: String(stderr || '').slice(0, 1000) });
    });
  });
}

module.exports = {
  runAgy, linkedWorktree, contextFilesOnPath, credentialTrees, buildAgyProfile, parseAgyResult, resolveAgyBin,
  CONTEXT_FILES, WT_BRANCH_RE,
};
