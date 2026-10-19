'use strict';

/**
 * 撞限额信号文件。
 *
 * 写的一方：`hooks/stop_failure.js`（Claude Code 的 StopFailure hook，撞限额那一刻由 Claude Code 自己调起）。
 * 读的一方：`lib/watchdog.js`（拿它当 pane 之外的第二个证据）。
 * ⇒ 路径、名字判据、文件形状**只在这里一份**。两边各写一份的话，改一边不报错，另一边静静地读不到。
 *
 * 文件：`<signalsDir>/rate_limit-<name>.json`
 *   { v: 1, name, at, last_at, error: 'rate_limit', session_id, message_tail }
 *   · `at`       这次撞限额**第一次**停下的时刻（毫秒）。文件已存在且读得出来 ⇒ 保留，只更新 last_at
 *                （跟 watchdog 的 `rl_since` 用 `SET NX` 是同一个意思）。
 *   · `message_tail` 是**原文截断**，这里不解析。解析只在 watchdog 一处（`extractResetHint`）。
 *
 * 这里不连 Redis、不上网、不弹通知 —— 见 hooks/stop_failure.js 头注。
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
/** `--name` 的唯一判据：防路径穿越（`../x`）。也是文件名的一部分。 */
const NAME_RE = /^[A-Za-z0-9_-]+$/;
/** `last_assistant_message` 和 `error_details` 各取最后这么多字（按码点，不按 UTF-16 单元，免得切出半个字）。 */
const TAIL_MAX = 300;
const PREFIX = 'rate_limit-';

/**
 * 信号目录。默认 `<EngLoop 根>/temp/signals/`。
 * `ENGLOOP_SIGNALS_DIR`：**只给测试隔离用**（跟 `ENGLOOP_AGENT_SETTINGS_DIR` 同一类）。
 * 每次调用现读环境变量 —— 测试在 require 之后才设它也生效。
 */
function signalsDir() {
  return process.env.ENGLOOP_SIGNALS_DIR
    ? path.resolve(process.env.ENGLOOP_SIGNALS_DIR)
    : path.join(__dirname, '..', 'temp', 'signals');
}

/** 名字不合格 ⇒ null（调用方必须当「不写 / 不读」处理）。 */
function fileFor(name, dir = signalsDir()) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  return path.join(dir, `${PREFIX}${name}.json`);
}

/** 原文的最后 n 个字。不是字符串的（error_details 可能是对象）先 JSON 化；拿不到 ⇒ ''。 */
function tail(v, n = TAIL_MAX) {
  if (v === undefined || v === null) return '';
  let s;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch (_) { s = String(v); } }
  if (typeof s !== 'string') return '';
  const cps = Array.from(s);
  return cps.length > n ? cps.slice(-n).join('') : s;
}

/** message_tail 的拼法：error_details 在前、last_assistant_message 在后（后者是会话里给人看的那句，跟 pane 上那行同源）。 */
function messageTail(input) {
  const parts = [tail(input && input.error_details), tail(input && input.last_assistant_message)].filter(Boolean);
  return parts.join('\n');
}

/**
 * 读一个 agent 的信号。**不判有效性**（那要 idle 和 TTL，在 watchdog）。
 * @returns {{state:'absent'}|{state:'bad', reason:string}|{state:'ok', sig:object}}
 */
function read(name, { dir = signalsDir() } = {}) {
  const file = fileFor(name, dir);
  if (!file) return { state: 'bad', reason: 'bad_name' };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { state: 'absent' } : { state: 'bad', reason: `read: ${e.message}` };
  }
  let sig;
  try { sig = JSON.parse(raw); } catch (_) { return { state: 'bad', reason: 'parse' }; }
  if (!sig || typeof sig !== 'object') return { state: 'bad', reason: 'shape' };
  // 文件名和内容里的 name 必须一致 —— 不一致说明有人搬过 / 写错了，不认。
  if (sig.name !== name) return { state: 'bad', reason: 'name_mismatch' };
  if (!Number.isFinite(sig.at)) return { state: 'bad', reason: 'no_at' };
  return { state: 'ok', sig };
}

/**
 * hook 的全部逻辑（抽出来是为了能直接测；hooks/stop_failure.js 只管 stdin / argv / 退出码）。
 * @returns {{written:boolean, reason?:string, file?:string, sig?:object}}
 */
function record(input, { name, dir = signalsDir(), now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || input.error !== 'rate_limit') return { written: false, reason: 'not_rate_limit' };
  const file = fileFor(name, dir);
  if (!file) return { written: false, reason: 'bad_name' };

  // 已存在、而且读得出来 ⇒ 保留原来的 `at`（这次撞限额第一次停下的时刻）。读不出来 ⇒ 当没有，重写。
  const prev = read(name, { dir });
  const at = prev.state === 'ok' ? prev.sig.at : now;
  const sig = {
    v: VERSION,
    name,
    at,
    last_at: now,
    error: 'rate_limit',
    session_id: typeof input.session_id === 'string' ? input.session_id : null,
    message_tail: messageTail(input),
  };

  fs.mkdirSync(dir, { recursive: true });
  // 先写临时文件再 rename：watchdog 永远读不到写了一半的 JSON。
  const tmp = `${file}.tmp-${process.pid}-${now}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(sig)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* 清不掉就算了 */ }
    throw e;
  }
  return { written: true, file, sig };
}

/**
 * 删信号文件 —— 只给 watchdog 用，两种情况：
 *   ① `consumed`：agent 在 `at` 之后读过队列（那次撞限额已经过去）。
 *      **比对 `at` 再删**：check() 读到它到这里删它之间，若文件被换成了另一次撞限额（at 不同），不删。
 *   ② 超过 `ttlMs` 的（按 `at`；读不出来的按 mtime）顺手删。临时文件残留同样按 mtime。
 * @returns {string[]} 删掉的文件名
 */
function sweep({ consumed = [], dir = signalsDir(), now = Date.now(), ttlMs }) {
  const removed = [];
  const rm = (f) => { try { fs.unlinkSync(f); removed.push(path.basename(f)); } catch (_) { /* 已经没了 / 删不掉：下一轮再说 */ } };

  for (const c of consumed) {
    const r = read(c.name, { dir });
    if (r.state === 'ok' && r.sig.at === c.at) rm(fileFor(c.name, dir));
  }

  if (!Number.isFinite(ttlMs)) return removed;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return removed; }
  for (const n of names) {
    if (!n.startsWith(PREFIX)) continue;
    const f = path.join(dir, n);
    const m = /^rate_limit-(.+)\.json$/.exec(n);
    if (m) {
      const r = read(m[1], { dir });
      if (r.state === 'ok') { if (now - r.sig.at > ttlMs) rm(f); continue; }
      if (r.state === 'absent') continue;
    }
    // 读不出来的、名字不合格的、`.tmp-` 残留：按 mtime
    try { if (now - fs.statSync(f).mtimeMs > ttlMs) rm(f); } catch (_) { /* 没了 */ }
  }
  return removed;
}

module.exports = {
  VERSION, NAME_RE, TAIL_MAX, PREFIX,
  signalsDir, fileFor, tail, messageTail, read, record, sweep,
};
