#!/usr/bin/env node
'use strict';

/**
 * 「做完了」的独立核验 —— 命令行入口。判据全在 `lib/verify-complete.js`（bin/ 测不到，理由同 serve.js）。
 *
 * 用法：
 *   node bin/verify-complete.js --evidence <文件|->            核一份 evidence（- = stdin）
 *   node bin/verify-complete.js --graph-node <图目录> <节点>     任务图节点（graph-runner 的 defaultVerify 指过来）
 *   node bin/verify-complete.js --done-job <base64 JSON>       bus 起的：核完把结果落回 thread（lib/done-verify.js）
 *
 * 选项：
 *   --main <ref>              基线分支（默认 main）。**不从 evidence 读** —— 让 agent 挑基线等于让它挑「本来就红」的那个
 *   --graphs-root <dir>       --graph-node 时：图目录必须在它下面
 *   --tests-timeout-ms <n>    一次 tests 的上限（默认 30 分钟）
 *   --qa-timeout-ms <n>       等 test worker 的上限（默认 12 分钟）
 *
 * 输出：stdout 一行 JSON `{ verdict, kind, checks, missing, ms }`（--done-job 还会打日志行，最后一行是 JSON）。
 * 退出码：0 pass · 1 fail · 3 unverifiable · 2 用法错。
 *
 * 环境：ENGLOOP_VERIFY_CACHE（基线缓存 / 锁的根，默认 temp/verify-cache）；QA 和 --done-job 要连 redis
 *   （bin/ 下 ⇒ `ENGLOOP_REDIS_URL` 指哪就连哪，见 lib/queue.js 的四格判定）。
 */

const fs = require('node:fs');
const V = require('../lib/verify-complete');

const argv = process.argv.slice(2);
function opt(flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || (v.startsWith('--') && v !== '-')) usage(`${flag} 后面要跟一个值`);
  return v;
}
function usage(msg) {
  process.stderr.write(`verify-complete: ${msg}\n`
    + '用法：--evidence <文件|-> | --graph-node <图目录> <节点> | --done-job <base64>  [--main ref] [--tests-timeout-ms n] [--qa-timeout-ms n]\n');
  process.exit(2);
}
function num(flag) {
  const v = opt(flag);
  if (v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) usage(`${flag} 要是正数（收到 ${v}）`);
  return n;
}

let clients = null;
async function getRedis() {
  if (!clients) {
    const q = require('../lib/queue');
    clients = { redis: q.createClient(), blocking: q.createClient() };
  }
  return clients;
}
async function closeRedis() {
  if (!clients) return;
  await Promise.all([clients.redis.quit(), clients.blocking.quit()].map((p) => p.catch(() => {})));
}

const common = {
  mainRef: opt('--main') || undefined,
  testsTimeoutMs: num('--tests-timeout-ms'),
  qaTimeoutMs: num('--qa-timeout-ms'),
  getRedis,
  log: (m) => process.stderr.write(`${m}\n`),
};

const EXIT = { pass: 0, fail: 1, unverifiable: 3 };

async function main() {
  const evArg = opt('--evidence');
  const gi = argv.indexOf('--graph-node');
  const jobArg = opt('--done-job');

  if (evArg !== null) {
    const raw = evArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(evArg, 'utf8');
    let ev;
    try { ev = JSON.parse(raw); } catch (e) { usage(`evidence 不是合法 JSON：${e.message}`); }
    const r = await V.verify(ev, common);
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return EXIT[r.verdict];
  }

  if (gi !== -1) {
    const dir = argv[gi + 1];
    const nid = argv[gi + 2];
    if (!dir || !nid) usage('--graph-node 要两个参数：<图目录> <节点 id>');
    const r = await V.verifyGraphNode(dir, nid, { ...common, graphsRoot: opt('--graphs-root') || undefined });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    // ★ 调度器只看退出码（graph-runner.runVerify）：pass 才是 0
    return r.verdict === 'pass' ? 0 : 1;
  }

  if (jobArg !== null) {
    const DV = require('../lib/done-verify');
    let job;
    try { job = JSON.parse(Buffer.from(jobArg, 'base64').toString('utf8')); } catch (e) { usage(`--done-job 解不开：${e.message}`); }
    const t0 = new Date().toISOString();
    common.log(`[verify] ${t0} 开始核验 ${job.from} 的完成报告（anchor ${job.anchor}，kind ${job.evidence && job.evidence.kind}）`);
    const r = await V.verify(job.evidence, common);
    common.log(V.summarize(r, 20_000));
    const { redis } = await getRedis();
    const act = await DV.finish(redis, job, r);
    common.log(`[verify] 落回 thread：${JSON.stringify(act)}`);
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return EXIT[r.verdict];
  }

  usage('要给 --evidence、--graph-node 或 --done-job 之一');
  return 2;
}

main()
  .then(async (code) => { await closeRedis(); process.exit(code); })
  .catch(async (e) => {
    // ★ 崩了不能被读成「过了」：退出码 1，原样把堆栈打出来
    process.stderr.write(`verify-complete 崩了：${e.stack || e.message}\n`);
    await closeRedis();
    process.exit(1);
  });
