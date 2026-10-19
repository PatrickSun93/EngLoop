'use strict';

/**
 * 生成 `sandbox-exec` 的 profile。
 *
 * ── 为什么要有它 ─────────────────────────────────────────────────────────
 *   两处「替 agent 跑测试」（Stop hook、verify-complete）都在 agent 的 **sandbox 之外**
 *   执行 agent 写的代码（测试文件就是代码）⇒「agent 读不到钥匙」的保证会被绕过：
 *   agent 写一个读 `temp/bus-admin.token` 的测试、改一行源码让映射命中、结束回合，钥匙就落进它读得到的地方。
 *   ⇒ 这两处跑测试时套一层 `sandbox-exec`：**读** deny 钥匙、**写** 收成白名单、**网络**只放 localhost。
 *
 * ── 跟 agent-settings 的 sandbox 的关系 ─────────────────────────────────────
 *   那个是 Claude Code 自己的 sandbox（给 agent 的会话用，JSON 配置）。这个是 `sandbox-exec`（macOS SBPL），
 *   给「替 agent 跑测试」的那个 node 进程用。两者各管各的进程，但**拒读的那份钥匙清单取同一个来源**
 *   （`agent-settings` 导出的 `secretPaths`）—— 各写一份早晚漂移，而漂移的表现是「这边还拦着、那边放了」。
 *
 * ── SBPL 的几个点（macOS 上实测）────────────────────────────────────────────
 *   · `(allow default)` 打底，再逐条 deny / 把 deny 回收一部分。顺序：后面的规则覆盖前面的。
 *   · 路径要用**真实路径**（macOS 上 /tmp → /private/tmp、/var → /private/var）—— 不归一会漏。
 *   · `subpath` 管一棵目录树，`literal` 管一个确切文件。
 *   · 写白名单：`(deny file-write*)` 之后 `(allow file-write* (subpath …))` ⇒ 白名单外 EPERM、白名单内能写。
 *   · 网络：`(deny network-outbound (remote ip "*:*"))` 之后放 `localhost:*` ⇒ 连 127.0.0.1:6379 成功、连公网 IP EPERM。
 *   · 🔴 **setuid 程序在任何 sandbox-exec profile 里都 exec 不了**（连 `(allow default)` 都不行，
 *     `execvp() of '/bin/ps' failed: Operation not permitted`）—— 平台性质，profile 里没有规则能放开它。
 *     ⇒ 要 `ps` 的测试（bus-restart、port-registry 那几条）在 sandbox 里必红，基线和改动后一样红；
 *       所以核验的基线**也在同一个 sandbox 里量**（同一把尺子），这几条两边对消 ——
 *       代价：这几条测试里出的回退，核验抓不到。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * sandbox-exec **能不能真的套上** —— 不是「文件在不在」。调用方拿 false 要**放行 / unverifiable**，
 * 绝不退回成不带 sandbox 跑。
 *
 * 🔴 为什么要真套一次：已经在一个**限制性** seatbelt 里的进程，再
 *   `sandbox-exec` 一层 ⇒ `sandbox_apply: Operation not permitted`、exit 71。只查文件存在的话，
 *   这个 exit 71 会被读成「测试红了」—— Stop hook 拿它 exit 2、核验拿它当「没结果」，
 *   **而那几条断言其实一行都没跑**。在生产路径（bus 起的核验子进程、Claude Code 起的 hook）上不会有这层嵌套；
 *   它出现在「核验 EngLoop 自己」时：EngLoop 里测 sandbox 的那几个测试文件，跑在核验的 sandbox 里面。
 * ⇒ 用一份跟真 profile 同样限制性（deny file-write*）的探针去套 /usr/bin/true，套得上才算能用。结果缓存一次。
 */
let usableCache = null;
function available() {
  if (usableCache !== null) return usableCache;
  try {
    if (!fs.existsSync(SANDBOX_EXEC)) { usableCache = false; return usableCache; }
    const r = require('node:child_process').spawnSync(SANDBOX_EXEC,
      ['-p', '(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))', '/usr/bin/true'],
      { timeout: 10_000 });
    usableCache = r.status === 0;
  } catch { usableCache = false; }
  return usableCache;
}

/** SBPL 字符串字面量转义（反斜杠、双引号）。路径里出现这些的概率低，但不转义就是注入。 */
const sb = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** 路径归一成真实路径；不存在的父目录也要能写（临时树还没建子目录），所以取最近一个存在的祖先去 realpath。 */
function realish(p) {
  let d = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(d)) {
    tail.unshift(path.basename(d));
    const up = path.dirname(d);
    if (up === d) return path.resolve(p);
    d = up;
  }
  try { return path.join(fs.realpathSync(d), ...tail); } catch { return path.resolve(p); }
}

/**
 * 生成 profile 文本。
 *
 * @param {object} o
 * @param {string[]} o.allowWrite    **白名单**：只有这些目录（subpath）能写。空 ⇒ 全不能写（＋下面那几个设备）。
 * @param {string[]} o.denyRead      拒读的确切文件（钥匙）。
 * @param {string[]} [o.reDenyWrite] 在 allowWrite 之后再**抠掉**的子树（SBPL 后面的规则覆盖前面的）——
 *        Stop hook 放行整棵工作树让正常测试能写 scratch，但工作树里的 `temp/agent-settings`（agent 自己的权限配置）、
 *        `hooks`（下一回合就跑的钩子）要再抠掉：那两处是提权路径。
 * @param {string[]} [o.reDenyWriteRegex] 同 reDenyWrite，但按**正则**抠（SBPL `(regex ...)`）—— 给「白名单里一棵树放着，
 *        但树下所有 `.../config`、`.../hooks` 都要抠掉」这种按后缀的规则用（git 元数据目录里能让 git 执行命令的那几个文件）。
 * @param {boolean} [o.allowTmp]     额外把系统临时目录整个加进写白名单（EngLoop 的测试起隔离 bus，写 os.tmpdir()/engloop-isolated-*）。
 * @param {string[]} [o.denyReadTree] 拒读的**整棵目录**（`subpath`）—— 比如 agy 的专用 HOME（登录凭据）、真实用户目录下的推送凭据
 *        （`~/Library/Keychains`、`~/.ssh`、`~/.config/gh` …）。`denyRead` 是 `literal`，管不住目录里的文件。
 * @param {'localhost'|'open'} [o.network='localhost'] 出站网络。
 *        `localhost`（默认）：只放本机 —— 生成结果跟加这个参数之前**逐字节一样**（测试断言）。
 *        `open`：全放（agy 的进程要连 Google，seatbelt 按地址 / 端口放、不按域名 ⇒ 只能整体放开；这是已接受的取舍）。
 *        ⚠️ 实测：在末尾拼 `(allow network-outbound)` **无效**（盖不过前面那条带过滤器的 deny），
 *          必须是 `(allow network-outbound (remote ip "*:*"))`。
 * @returns {string}
 */
function buildProfile({ allowWrite = [], denyRead = [], reDenyWrite = [], reDenyWriteRegex = [], allowTmp = false,
  denyReadTree = [], network = 'localhost' } = {}) {
  if (network !== 'localhost' && network !== 'open') throw new Error(`buildProfile: network 只能是 localhost / open（收到 ${JSON.stringify(network)}）`);
  const writes = allowWrite.map(realish);
  if (allowTmp) writes.push(realish(os.tmpdir()));
  const reads = denyRead.map(realish);
  const readTrees = denyReadTree.map(realish);
  const reDeny = reDenyWrite.map(realish);

  const lines = [
    '(version 1)',
    '(allow default)',
    '',
    '; ── 钥匙：拒读（取 agent-settings 的 secretPaths 同一份）──',
    ...reads.map((r) => `(deny file-read* (literal ${sb(r)}))`),
    ...readTrees.map((r) => `(deny file-read* (subpath ${sb(r)}))`),
    '',
    '; ── 网络：只放 localhost（Redis、隔离 bus）──',
    '(deny network-outbound (remote ip "*:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    '',
    '; ── 写：全拒，再按白名单放（subpath = 一棵树）──',
    '(deny file-write*)',
    // node / 测试进程要写的设备文件：stdout/stderr 走继承的 fd，但 /dev/null 这类按路径打开要显式放。
    '(allow file-write* (literal "/dev/null") (literal "/dev/dtracehelper") (literal "/dev/tty"))',
    // ★ 伪终端：tmux 起会话要开 /dev/ptmx 再写分到的 /dev/ttysNNN —— 不放的话
    //   tmux 报「create window failed: fork failed: Operation not permitted」，bus-auth / bus-restart 那几条
    //   起私有 tmux 会话的测试全红。范围：只有这两类设备节点（不是 /dev 整个）；它们给的是「开一个终端」，
    //   不给读钥匙、不给写工作树外的文件。
    '(allow file-write* (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))',
    ...writes.map((w) => `(allow file-write* (subpath ${sb(w)}))`),
    // ★ 白名单里再抠掉的（放在 allow 之后 ⇒ 覆盖它）——提权路径
    ...(reDeny.length || reDenyWriteRegex.length ? ['', '; ── 白名单里再抠掉：agent 的权限配置、钩子、.git ──',
      ...reDeny.map((d) => `(deny file-write* (subpath ${sb(d)}))`),
      ...reDenyWriteRegex.map((re) => `(deny file-write* (regex #${sb(re)}))`)] : []),
    '',
    // ★ 网络全开放在最后（后面的规则覆盖前面的）—— 只有显式 network:'open' 才有这一段。
    ...(network === 'open' ? ['; ── 网络：全放（显式 network:open）──', '(allow network-outbound (remote ip "*:*"))', ''] : []),
  ];
  return lines.join('\n');
}

/** 把一条命令包进 sandbox-exec 的 argv。profile 走 `-f <文件>`（profile 可能几 KB，`-p` 塞 argv 不稳）。 */
function wrap(profileFile, argv) {
  return [SANDBOX_EXEC, '-f', profileFile, ...argv];
}

/**
 * 框架自己跑 git 时**强制关掉**会让 git 执行外部命令的那几个配置（命令行 `-c` 优先级最高）。
 *
 * ── 为什么 ──────────────────────────────────────────────────────────────────
 *   sandbox 里的测试即使改不了 `.git/config`（已抠），git 执行外部命令的开关还可能来自别处
 *   （已存在的配置、被重指的 gitdir、以后新加的调用路径）。这一层**不依赖**「配置没被改」——
 *   它在**每一条**框架的 git 调用上，把危险开关钉死。
 * ── 查实了会在框架调用路径上触发的（status / worktree add|remove|prune / rev-parse / merge-base / show / log）──
 *   · `core.fsmonitor`  —— `git status` 会 spawn 它。关。
 *   · `core.hooksPath` / 钩子 —— `git worktree add` 检出时跑 post-checkout 钩子。指到 /dev/null。
 *   · `core.pager`      —— 非交互（spawnSync 无 tty）本不分页，仍钉成 cat，省得哪天改了调用方式。
 *   ⚠️ 关不掉的（写进这里，别假装关了）：`filter.*.smudge/clean/process`（`worktree add` 检出时按 .gitattributes 跑）
 *     没有单个 `-c` 能全禁 —— 它的防线是**抠掉 `.git/config`**（命令里配不进 filter），不是这一层。
 *     `GIT_CONFIG_NOSYSTEM=1` ＋ 不让测试写 $HOME/.gitconfig（sandbox 没放 $HOME）堵住「从别处注入配置」。
 */
const GIT_HARDEN = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat'];
const GIT_HARDEN_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };

/**
 * 一棵 git 元数据目录下，所有会让 git 执行命令的文件（config / config.worktree / hooks）的 SBPL 正则。dir 已 realpath。
 *
 * ⚠️ SBPL 正则的两个实测坑（macOS）：
 *   · **字面点用 `[.]`，不要用 `\.`** —— `\.` 在 SBPL 里匹配不上（config\.worktree 会漏网）。
 *   · 不转义 `/`。
 */
function gitExecConfigRegex(gitMetaDir) {
  const esc = realish(gitMetaDir).replace(/[[\]{}()*+?^$|\\]/g, '\\$&').replace(/\./g, '[.]');
  // <dir>/（可带一层 worktrees/<name>/）下的 config、config.worktree、hooks/**。config[.]worktree 排在 config 前（下一行）。
  return `^${esc}(/worktrees/[^/]+)?/(config[.]worktree|config|hooks(/.*)?)$`;
}

module.exports = {
  available, buildProfile, wrap, realish, SANDBOX_EXEC,
  GIT_HARDEN, GIT_HARDEN_ENV, gitExecConfigRegex,
};
