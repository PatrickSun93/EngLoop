'use strict';

/**
 * done 流程接上独立核验（`lib/verify-complete.js`）。
 *
 * ── 流程 ────────────────────────────────────────────────────────────────
 *   relay 看到 `done:true`：
 *     带 evidence（code / doc）⇒ **先不打 🏁**，打 ⏳（by system），**另起进程**跑核验（`begin`）
 *         ⇒ 子进程核完自己调 `finish`：
 *            pass         ⇒ ⏳ 换成 🏁，往原 thread 发一条 `verify:"pass"` 的跟帖（网页弹通知、编排者看得到 verdict）
 *            fail         ⇒ ⏳ 换成 🔙，给那个 agent 发一条 system 章的打回（哪几项没过 ＋ 原样输出）
 *                           同一件活第 3 次 fail ⇒ 不再打回，通知编排者
 *            unverifiable ⇒ 🏁 ＋ 跟帖写明「未验证」
 *     kind none      ⇒ 照旧 🏁，流里 `verify:"none"`（通知文字带「未验证」）
 *     没带 evidence  ⇒ 照旧 🏁，流里 `verify:"missing"`（通知文字带「未验证（没带 evidence）」）
 *       ⚠️ 不把「没 evidence」变成拒绝：老 agent 的 CLAUDE.md 拿不到新纪律（keepEdited），一拒就全断。
 *
 * ── 为什么是**子进程自己**落结果，而不是 bus 等子进程退出再落 ─────────────
 *   核验要跑全量两遍（基线 ＋ commit），十几分钟。bus 在这期间重启的话，
 *   「等子进程退出」那个回调就没了 ⇒ ⏳ 永远挂在 thread 上，没有任何报错。
 *   ⇒ 子进程 detached ＋ unref，自己连 redis、自己换标记、自己发消息：bus 死了它照样把活干完。
 *   （代价：子进程本身被杀的话 ⏳ 也会挂住 —— 日志在 `<cacheRoot>/logs/`，没做自动清扫。）
 *
 * ── 打回用 🔙，不是 🔁 ──────────────────────────────────────────────────────
 *   🔁 在 `lib/reactions.js` 的语义表里早就是 **C 档「重跑」**（破坏性、花额度、两段式）——
 *   `reactions.add` 打它会**生成一条待人确认的「重跑」动作**，而且界面上它的说明是「消耗额度」。
 *   系统自动打一个会排进人的确认队列的 emoji，等于把「核验没过」写成了「请你批一次重跑」。
 *   ⇒ 换成 A 档（纯标记）的 🔙「核验没过 · 已打回」；⏳ 同样登记成 A 档「核验中」。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const q = require('./queue');
const roster = require('./roster');
const reactions = require('./reactions');
const stamp = require('./stamp');
const V = require('./verify-complete');

const EMOJI = Object.freeze({ PENDING: '⏳', PASS: '🏁', BOUNCED: '🔙' });
/** 同一件活最多自动打回几次。第 MAX+1 次 fail ⇒ 通知编排者、不再打回。 */
const MAX_BOUNCES = 2;
const BOUNCE_TTL_SEC = 7 * 86_400;
/** evidence 原样上 argv（传给子进程）—— 有上限：一份几十 KB 的 evidence 本身就不对。 */
const MAX_EVIDENCE_BYTES = 20_000;

/** 写进流里的 `verify` 字段的值（前端、poller 读的就是它）。 */
const VERIFY = Object.freeze({
  PENDING: 'pending',      // 有 evidence，核验在跑 —— 先别当成做完了
  PASS: 'pass',
  FAIL: 'fail',
  UNVERIFIABLE: 'unverifiable',
  NONE: 'none',            // kind none：没有可核的产物
  MISSING: 'missing',      // 没带 evidence
  NOT_WIRED: 'not_wired',  // 带了 evidence，但这个 relay 没接核验（测试 / 老调用方）—— 说出来，不装成核过
});

/**
 * 一条 done 消息该怎么走。**纯函数**（relay 调；测试直接喂）。
 * @returns {string} VERIFY 的一个值
 */
function modeOf(evidence, { wired }) {
  if (evidence === undefined || evidence === null) return VERIFY.MISSING;
  if (evidence && typeof evidence === 'object' && evidence.kind === 'none') return VERIFY.NONE;
  // ★ 其余**一律去核**，包括格式不对的 evidence：核验会把「格式不对」报成 fail 打回 ——
  //   这里要是把它当成「没带」，agent 写错一个字段就静默退回成「未验证」，而它以为自己被核过了。
  return wired ? VERIFY.PENDING : VERIFY.NOT_WIRED;
}

/**
 * 「同一件活」的键 —— 打回计数按它累计。
 * ★ 优先用 thread（`reply_to`）：agent 修完在同一个 thread 里再报，就是同一件活。
 *   没挂 thread 的完成报告每次都是新的根 ⇒ 退到 evidence 指的东西（同一棵工作树 / 同一组文件）。
 */
function workKeyOf({ from, replyTo, anchor, evidence }) {
  let k;
  if (replyTo) k = `thread:${replyTo}`;
  else if (evidence && evidence.kind === 'code' && typeof evidence.repo === 'string') k = `repo:${evidence.repo}`;
  else if (evidence && evidence.kind === 'doc' && Array.isArray(evidence.files)) k = `files:${[...evidence.files].map(String).sort().join(',')}`;
  else k = `anchor:${anchor}`;
  return `${from}|${k}`;
}
const bounceKey = (workKey) => `verify:bounces:${crypto.createHash('sha1').update(workKey).digest('hex').slice(0, 20)}`;

/** 通知 / 跟帖里那一句「这是谁的哪条完成报告」。 */
const whose = (job) => `${job.from} 的完成报告（${job.scope === 'room' ? `房间 ${job.room_hash}` : '私聊'} · thread ${job.anchor}）`;

/**
 * bus 侧：打 ⏳、起子进程。**不等它**（relay 不能被一个十几分钟的核验堵住）。
 *
 * @param {object} o
 * @param {object} o.redis
 * @param {string} o.orchName      编排者名（第 3 次 fail 通知它）—— 必传，不在这里再埋一处 'JARVIS'
 * @param {string} o.cacheRoot     基线缓存 / 日志的根（隔离 bus 给临时目录，见 serve.js 隔离表第 ⑩ 条）
 * @param {object} [o.env]         子进程环境（默认 process.env ＋ ENGLOOP_VERIFY_CACHE）
 * @param {function} [o.spawnImpl] 测试注入
 */
function createLauncher({ redis, orchName, cacheRoot, env = null, spawnImpl = spawn, onLog = () => {}, root = path.join(__dirname, '..') }) {
  if (!redis) throw new Error('done-verify 需要 redis');
  if (!orchName) throw new Error('done-verify 需要 orchName（不给默认值）');
  if (!cacheRoot) throw new Error('done-verify 需要 cacheRoot（基线缓存和核验日志放哪；不给默认值）');
  const bin = path.join(root, 'bin', 'verify-complete.js');

  async function begin(job0) {
    const job = {
      v: 1,
      id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      orch: orchName,
      at: new Date().toISOString(),
      ...job0,
    };
    job.work_key = workKeyOf({ from: job.from, replyTo: job.reply_to, anchor: job.anchor, evidence: job.evidence });
    await reactions.add(redis, { scope: job.scope, anchor: String(job.anchor), emoji: EMOJI.PENDING, by: 'system' });

    const raw = JSON.stringify(job);
    if (Buffer.byteLength(JSON.stringify(job.evidence ?? null)) > MAX_EVIDENCE_BYTES) {
      const r = { verdict: 'fail', kind: null, checks: [{ name: 'evidence 大小', ok: false, detail: `超过 ${MAX_EVIDENCE_BYTES} 字节` }],
        missing: [`evidence 超过 ${MAX_EVIDENCE_BYTES} 字节 —— 验收项写原文就够，输出不用贴进来（核验自己会跑）`], ms: 0 };
      return { job, started: false, result: await finish(redis, job, r) };
    }
    const logDir = path.join(cacheRoot, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${job.id}.log`);
    const fd = fs.openSync(logFile, 'a');
    let child;
    try {
      child = spawnImpl(process.execPath, [bin, '--done-job', Buffer.from(raw).toString('base64')], {
        cwd: root,
        env: { ...(env || process.env), ENGLOOP_VERIFY_CACHE: cacheRoot },
        detached: true,
        stdio: ['ignore', fd, fd],
      });
    } catch (e) {
      fs.closeSync(fd);
      return { job, started: false, result: await spawnFailed(e) };
    }
    fs.closeSync(fd);
    // ★ 起不来（ENOENT 之类）是异步报的 —— 不接住的话 ⏳ 永远挂着
    child.on('error', (e) => { spawnFailed(e).catch((err) => onLog(`[verify] ✗ 起不来、落结果也失败：${err.message}`)); });
    child.unref();
    onLog(`[verify] ⏳ ${whose(job)} ⇒ 核验子进程 pid ${child.pid}，日志 ${logFile}`);
    return { job, started: true, pid: child.pid, logFile };

    async function spawnFailed(e) {
      onLog(`[verify] ✗ 核验进程起不来：${e.message}`);
      return finish(redis, job, { verdict: 'unverifiable', kind: job.evidence && job.evidence.kind,
        checks: [{ name: '核验进程', ok: false, detail: `起不来：${e.message}` }], missing: [], ms: 0 });
    }
  }

  return { begin };
}

/** 换标记：先摘 ⏳，再打新的。摘不掉（本来就没有）不算错。 */
async function swap(redis, job, to, { clear = [] } = {}) {
  const base = { scope: job.scope, anchor: String(job.anchor), by: 'system' };
  for (const e of [EMOJI.PENDING, ...clear]) await reactions.remove(redis, { ...base, emoji: e }).catch(() => {});
  await reactions.add(redis, { ...base, emoji: to });
}

/**
 * 子进程侧：把核验结果落回 thread。**也可以在进程内直接调**（测试、起不来时兜底）。
 * @returns {Promise<{action, bounces?}>}
 */
async function finish(redis, job, r, { maxBounces = MAX_BOUNCES } = {}) {
  const bkey = bounceKey(job.work_key || workKeyOf({ from: job.from, replyTo: job.reply_to, anchor: job.anchor, evidence: job.evidence }));
  const summary = V.summarize(r);
  // ★ 核的范围：code evidence 的 tests 不是不带参数的 `node test/run-all.js` 时，
  //   在跟帖里明说「agent 自选的 <命令>，不是全量」—— 否则网页通知只看到「已独立核验」，看不出它核的是不是全部。
  const ev = job.evidence;
  const scope = (ev && ev.kind === 'code' && typeof ev.tests === 'string' && ev.tests.trim() !== 'node test/run-all.js')
    ? `\n范围：agent 自选的 \`${ev.tests}\`，不是全量。` : '';

  if (r.verdict === 'pass' || r.verdict === 'unverifiable') {
    await swap(redis, job, EMOJI.PASS, { clear: r.verdict === 'pass' ? [EMOJI.BOUNCED] : [] });
    if (r.verdict === 'pass') await redis.del(bkey);
    // 往**原来那条流**发跟帖：私聊给编排者的 ⇒ 编排者收到 verdict、网页弹通知；房间的 ⇒ 房间里看得到
    await q.send(redis, job.stream, {
      // ★ from 写原报告人：这条跟帖属于他那份完成报告（网页按 from 归频道、挂到他的 thread 上）；
      //   **章是 system** —— 说的是「框架核过了」，不是他又说了一遍。
      from: job.from,
      ...stamp.SYSTEM,
      to: job.to,
      text: `${r.verdict === 'pass' ? '✅ 独立核验通过' : '⚪ 未验证（核验做不了）'} —— ${whose(job)}${r.verdict === 'pass' ? scope : ''}\n${summary}`,
      agent_type: 'system',
      reply_to: String(job.anchor),
      kind: 'notice',
      done: 'true',
      verify: r.verdict === 'pass' ? VERIFY.PASS : VERIFY.UNVERIFIABLE,
      ...(job.room_hash ? { room_hash: job.room_hash, expects_reply: 'false' } : {}),
    });
    return { action: r.verdict === 'pass' ? 'passed' : 'unverifiable' };
  }

  // ── fail ─────────────────────────────────────────────────────────────────
  await swap(redis, job, EMOJI.BOUNCED);
  const n = await redis.incr(bkey);
  await redis.expire(bkey, BOUNCE_TTL_SEC);
  const missing = r.missing.map((m) => `· ${m}`).join('\n');
  const crew = await roster.lookup(redis, job.from).catch(() => null);

  if (n <= maxBounces && crew && crew.stream) {
    await q.send(redis, crew.stream, {
      from: 'system',
      ...stamp.SYSTEM,
      to: job.from,
      text: `🔙 你报的完成没过独立核验（这件活第 ${n} 次，${maxBounces} 次之后不再自动打回、转给编排者）。\n`
        + `没过的：\n${missing}\n\n原样输出（截断）：\n${summary}\n\n`
        + `修完再标一次 done（同样带 evidence），回复挂在同一个 thread：reply_to = ${job.anchor}`,
      agent_type: 'system',
      ...(job.scope === 'dm' ? { reply_to: String(job.anchor) } : {}),
    });
    return { action: 'bounced', bounces: n };
  }

  // 第 maxBounces+1 次（或者 agent 不在册、打回不了）⇒ 通知编排者
  await q.send(redis, roster.inboxFor(job.orch, 'orchestrator'), {
    from: 'system',
    ...stamp.SYSTEM,
    to: job.orch,
    text: `⚠️ ${whose(job)} 第 ${n} 次没过独立核验 —— ${crew ? '已打回过 ' + maxBounces + ' 次，不再自动打回' : '它不在花名册里，打回不了'}。\n`
      + `没过的：\n${missing}\n\n${summary}\n\n下一步可选：看一眼是不是核验本身的问题（基线 flaky？环境？）· 自己接手 · 转问 Patrick。`,
    agent_type: 'system',
  });
  return { action: 'escalated', bounces: n };
}

module.exports = { createLauncher, finish, modeOf, workKeyOf, bounceKey, EMOJI, VERIFY, MAX_BOUNCES, MAX_EVIDENCE_BYTES };
