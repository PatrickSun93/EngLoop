#!/usr/bin/env node
'use strict';

/**
 * bus 的 launchd 起法：生成 plist、装、卸、查状态、判模式。
 *
 *   node bin/launchd.js print       打印生成的 plist，不动任何东西
 *   node bin/launchd.js status      装没装（文件在不在）、在没在册、pid
 *   node bin/launchd.js install     写 ~/Library/LaunchAgents/<label>.plist ＋ launchctl bootstrap
 *   node bin/launchd.js uninstall   launchctl bootout ＋ 删文件
 *   node bin/launchd.js mode        打印 launchd 或 nohup（start.sh 用）
 *   node bin/launchd.js label       打印 label（stop.sh 用）
 *   node bin/launchd.js start       launchd 模式下把 bus 起起来（start.sh 用）：没在册 ⇒ bootstrap，在册 ⇒ kickstart
 *
 * ── 两种起法，一个入口 ──────────────────────────────────────────────
 *   默认 nohup：`./start.sh` ⇒ `nohup bash bin/serve.sh`。
 *   装了 launchd（这个文件 `install` 过）：`./start.sh` ⇒ `launchctl bootstrap`，plist 里调的也是 `bin/serve.sh`。
 *   ⇒ 两条路都经过 `bin/serve.sh`：node 路径、PATH、worker 池类型、日志只在那里写一次。
 *   （每条启动路径各维护一份环境的话，漏一条不报错 —— `ENGLOOP_WORKER_TYPES`、
 *     stdout 的去向、`PATH` 都会这样分叉。）
 *
 * ── 模式的判据：plist 文件在不在 ────────────────────────────────────
 *   **文件在就是 launchd 模式，跟当前在不在册无关。** `./stop.sh` 会 bootout（KeepAlive 会把杀掉的 bus
 *   拉回来，见 stop.sh 1.5 段），但不删文件 ⇒ 下次 `./start.sh` 应该重新 bootstrap，而不是退回 nohup。
 *   拿「在册」当判据的话，stop 之后的下一次 start 会悄悄换成 nohup。
 *
 * ── 测试缝 ──────────────────────────────────────────────────────────
 *   每个 `launchctl` 调用都走 `opts.run(args)`（跟 `bus-restart.js` 的 `launchdStatus({ run })` 同一个约定：
 *   成功返回 stdout，失败抛错、错误上带 stdout/stderr）。`HOME`、checkout 根、uid、找 bus 进程的函数也都能注入。
 *   ⇒ 测试用临时 HOME ＋ 假 run，**从不碰真 launchctl、从不写真 ~/Library/LaunchAgents**。
 *
 * ⚠️ 不托管 Claude 会话：launchd 只起 bus（它再管队列 / relay / watchdog）。
 *   编排者和 agent 还是 `./start.sh` 起 —— 理由：登录前没人能点信任对话框。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ★ label 的**唯一出处**。bus-restart.js 和 stop.sh 都从这里取（stop.sh 用 `node bin/launchd.js label`）。
//   环境变量覆盖（`ENGLOOP_LAUNCHD_LABEL`）也只在这一处。
const LABEL = process.env.ENGLOOP_LAUNCHD_LABEL || 'com.patrick.engloop';

const ROOT = path.join(__dirname, '..');

// launchd 自己的限流间隔。bus 崩了以后最快 10 秒拉一次，不会被 launchd 判成崩溃循环。
const THROTTLE_S = 10;

/** 读 HOME：显式给的 > $HOME > os.homedir()。测试给临时目录。 */
function homeOf(opts = {}) {
  return opts.home || process.env.HOME || os.homedir();
}
function rootOf(opts = {}) {
  return opts.root || ROOT;
}
function labelOf(opts = {}) {
  return opts.label || module.exports.LABEL;
}
function uidOf(opts = {}) {
  return opts.uid !== undefined ? opts.uid : process.getuid();
}

function plistPath(opts = {}) {
  return path.join(homeOf(opts), 'Library', 'LaunchAgents', `${labelOf(opts)}.plist`);
}
function domain(opts = {}) {
  return `gui/${uidOf(opts)}`;
}
function target(opts = {}) {
  return `${domain(opts)}/${labelOf(opts)}`;
}

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * 生成 plist。路径只从 checkout 根和 HOME 来，**不写死任何一段**。
 *
 * ⚠️ 这里**不放 EnvironmentVariables**：PATH、worker 池类型、node 路径都在 `bin/serve.sh` 里。
 *   在 plist 里再写一份，就是第二份环境 —— 那正是「两条路都经过 serve.sh」要消掉的东西。
 */
function renderPlist(opts = {}) {
  const root = rootOf(opts);
  const home = homeOf(opts);
  const label = labelOf(opts);
  const s = (v) => `<string>${xmlEscape(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- 由 node bin/launchd.js 生成，别手改：改了下次 install 会被覆盖。 -->',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${s(label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    ${s('/bin/bash')}`,
    `    ${s(path.join(root, 'bin', 'serve.sh'))}`,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  ${s(root)}`,
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    `  <integer>${THROTTLE_S}</integer>`,
    // bus 自己的日志在 temp/bus.log（serve.sh 里 exec >> 那一行）。这两个文件只接得到
    // serve.sh 改写 stdout 之前的输出：比如「找不到 node」「cd 失败」。
    '  <key>StandardOutPath</key>',
    `  ${s(path.join(home, 'Library', 'Logs', 'engloop.out'))}`,
    '  <key>StandardErrorPath</key>',
    `  ${s(path.join(home, 'Library', 'Logs', 'engloop.err'))}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function defaultRun(args) {
  return execFileSync('launchctl', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  });
}
const runOf = (opts = {}) => opts.run || defaultRun;

// 「launchctl 跑得起来、说没这个服务」的那几种说法。跟 bus-restart.js launchdStatus 同一份白名单的意思：
// 只有这几种算「确定不在册」，别的失败都是「不知道」。
const NOT_FOUND_RE = /Could not find service|No such process|not find/i;

/**
 * 在不在册。
 * @returns {{loaded:true, pid:number|null}|{loaded:false}|{error:string, detail:string}}
 *
 * ★ 查不了要返回 error，不许猜「不在」（跟 bus-restart.js launchdStatus 同一条）。
 */
function loaded(opts = {}) {
  try {
    const out = String(runOf(opts)(['print', target(opts)]) || '');
    const m = out.match(/^\s*pid\s*=\s*(\d+)/m);
    return { loaded: true, pid: m ? Number(m[1]) : null };
  } catch (err) {
    const text = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    if (NOT_FOUND_RE.test(text)) return { loaded: false };
    return { error: 'launchctl_unavailable', detail: String(err.message || err).slice(0, 200) };
  }
}

/** 文件在 ⇒ launchd，不在 ⇒ nohup。**只看文件**，理由见文件头。 */
function mode(opts = {}) {
  return fs.existsSync(plistPath(opts)) ? 'launchd' : 'nohup';
}

function status(opts = {}) {
  const file = plistPath(opts);
  const installed = fs.existsSync(file);
  let matches = null;
  if (installed) {
    try { matches = fs.readFileSync(file, 'utf8') === renderPlist(opts); } catch (_) { matches = null; }
  }
  return {
    label: labelOf(opts),
    plist: file,
    mode: installed ? 'launchd' : 'nohup',
    installed,
    // 装着的那份跟现在会生成的一不一致（checkout 搬过家、HOME 变了 ⇒ false）
    matches,
    ...loaded(opts),
  };
}

/** 找 bus 进程。默认借 bus-restart.js 那一份（按进程枚举，不看端口）。懒加载：两边互相 require。 */
function findBusPidsOf(opts = {}) {
  if (opts.findBusPids) return opts.findBusPids;
  return () => require('./bus-restart').findBusPids();
}

/**
 * 装：写 plist ＋ bootstrap。
 *
 * ★★ bus 已经在跑（而不是 launchd 起的）⇒ **拒绝**，让人先 `./stop.sh`。
 *   不然 bootstrap 会再起一个：两个实例，一个抢不到端口但照跑自己的 setInterval。
 *   判据是**按进程枚举**（bus-restart.js findBusPids），不是看端口 ——
 *   端口空着时，另一个 serve.js 仍可能在跑。
 *
 * @returns {{ok:true, plist:string}|{ok:false, reason:string, message:string}}
 */
function install(opts = {}) {
  const run = runOf(opts);
  const file = plistPath(opts);

  const lc = loaded(opts);
  if (lc.error) {
    return { ok: false, reason: 'launchctl_unavailable',
      message: `查不了 ${labelOf(opts)} 在不在册（${lc.detail}）。查不了 ≠ 不在册，什么都没做。` };
  }
  if (lc.loaded) {
    return { ok: false, reason: 'already_loaded',
      message: `${labelOf(opts)} 已经在册（pid ${lc.pid ?? '无'}）。要重装：先 node bin/launchd.js uninstall。` };
  }

  let pids;
  try {
    pids = findBusPidsOf(opts)();
  } catch (err) {
    return { ok: false, reason: 'ps_failed',
      message: `查不到进程列表（${err.message}）。查不了 ≠ 没有 bus 在跑，什么都没做。` };
  }
  if (pids.length) {
    return { ok: false, reason: 'bus_running',
      message: `bus 正在跑（pid ${pids.join(', ')}），而它不是 launchd 起的。`
        + '先 ./stop.sh 停掉，再 install —— 不然会有两个 bus。' };
  }

  // 写文件。原来就有一份（stop.sh 之后文件留着、不在册）⇒ 记下来，bootstrap 失败时放回去。
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(homeOf(opts), 'Library', 'Logs'), { recursive: true });
  fs.writeFileSync(file, renderPlist(opts));
  try {
    run(['bootstrap', domain(opts), file]);
  } catch (err) {
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
    return { ok: false, reason: 'bootstrap_failed',
      message: `launchctl bootstrap 失败：${String(err.stderr || err.message).trim().slice(0, 300)}`
        + `（plist ${before === null ? '已删掉' : '已还原成原来那份'}，状态跟 install 之前一样）` };
  }
  return { ok: true, plist: file };
}

/**
 * 卸：bootout ＋ 删文件。bootout 失败就**不删文件**：删了的话 mode 变成 nohup，
 * 下次 start.sh 再起一个 nohup bus，而 launchd 那个还在。
 */
function uninstall(opts = {}) {
  const run = runOf(opts);
  const file = plistPath(opts);
  const lc = loaded(opts);
  if (lc.error) {
    return { ok: false, reason: 'launchctl_unavailable',
      message: `查不了 ${labelOf(opts)} 在不在册（${lc.detail}）。什么都没做。` };
  }
  if (lc.loaded) {
    try {
      run(['bootout', target(opts)]);
    } catch (err) {
      return { ok: false, reason: 'bootout_failed',
        message: `launchctl bootout 失败：${String(err.stderr || err.message).trim().slice(0, 300)}（plist 没删）` };
    }
  }
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return { ok: true, bootedOut: !!lc.loaded, removed: existed, plist: file };
}

/**
 * launchd 模式下把 bus 起起来（start.sh 用）。
 *   不在册 ⇒ bootstrap（stop.sh bootout 之后的正常情况）
 *   在册   ⇒ kickstart（不带 -k：没在跑就起，在跑就什么都不做）
 */
function start(opts = {}) {
  const run = runOf(opts);
  const file = plistPath(opts);
  if (!fs.existsSync(file)) {
    return { ok: false, reason: 'not_installed',
      message: `${file} 不在 —— 这不是 launchd 模式。nohup 起法：./start.sh 会自己走 bin/serve.sh。` };
  }
  const lc = loaded(opts);
  if (lc.error) {
    return { ok: false, reason: 'launchctl_unavailable',
      message: `查不了 ${labelOf(opts)} 在不在册（${lc.detail}）。什么都没做。` };
  }
  const args = lc.loaded ? ['kickstart', target(opts)] : ['bootstrap', domain(opts), file];
  try {
    run(args);
  } catch (err) {
    return { ok: false, reason: `${args[0]}_failed`,
      message: `launchctl ${args.join(' ')} 失败：${String(err.stderr || err.message).trim().slice(0, 300)}` };
  }
  return { ok: true, action: args[0] };
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const fail = (r) => { console.error(`✗ ${r.message}`); process.exitCode = 1; };
  switch (cmd) {
    case 'print':
      process.stdout.write(renderPlist());
      return;
    case 'label':
      console.log(module.exports.LABEL);
      return;
    case 'mode':
      console.log(mode());
      return;
    case 'status': {
      const s = status();
      console.log(`label     ${s.label}`);
      console.log(`plist     ${s.plist}  ${s.installed ? '在' : '不在'}`
        + (s.installed && s.matches === false ? '（跟现在生成的不一样 —— checkout 或 HOME 变过？重装：uninstall 再 install）' : ''));
      console.log(`mode      ${s.mode}`);
      if (s.error) console.log(`在册      查不了（${s.detail}）—— 不是「不在册」，是不知道`);
      else console.log(`在册      ${s.loaded ? `是 · pid ${s.pid ?? '无（没在跑）'}` : '否'}`);
      if (s.error) process.exitCode = 1;
      return;
    }
    case 'install': {
      const r = install();
      if (!r.ok) return fail(r);
      console.log(`✓ 已写 ${r.plist} 并 bootstrap。之后 ./start.sh / ./stop.sh 都走 launchd。`);
      console.log('  查状态: node bin/launchd.js status');
      return;
    }
    case 'uninstall': {
      const r = uninstall();
      if (!r.ok) return fail(r);
      console.log(`✓ ${r.bootedOut ? '已 bootout，' : '本来就不在册，'}${r.removed ? `已删 ${r.plist}` : 'plist 本来就不在'}。`
        + '之后 ./start.sh 走 nohup。');
      return;
    }
    case 'start': {
      const r = start();
      if (!r.ok) return fail(r);
      console.log(`✓ launchctl ${r.action}`);
      return;
    }
    default:
      console.error('用法: node bin/launchd.js print|status|install|uninstall|mode|label|start');
      process.exitCode = 2;
  }
}

module.exports = {
  LABEL, THROTTLE_S,
  plistPath, domain, target, renderPlist, loaded, mode, status, install, uninstall, start, main,
};

// ⚠️ 必须在 module.exports 赋值**之后**：labelOf() 读的是 module.exports.LABEL（测试换得掉的那一处）。
if (require.main === module) main();
