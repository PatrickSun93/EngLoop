'use strict';

/**
 * 探针：让 `runPrint` 跑一个**必然失败**的子进程，把返回值原样吐出来。
 *
 * ── 为什么必须是独立进程 ────────────────────────────────────────
 * `worker-runner` 用模块级变量 `_claudeBin` 缓存二进制路径，**一个进程里
 * 只解析一次**。所以「注入假 claude」和「用真 claude」不能在同一个进程里
 * 先后进行 —— 后者会拿到前者缓存下来的假路径。
 *
 * wiring【6】要假的（造失败），【7】要真的（试越界），于是【6】搬到这里。
 * ────────────────────────────────────────────────────────────────
 *
 * 假二进制路径由父进程通过 ENGLOOP_CLAUDE_BIN 传进来。
 * 输出走 stdout，一行 JSON —— 父进程解析它做断言。
 */

const { runPrint } = require('../../lib/worker-runner');

async function main() {
  const r = await runPrint(
    { text: '这个任务永远不会被执行 —— 二进制是假的，它只会往 stderr 喊一声然后退出' },
    // agentType：runPrint 要算出启动配置才起子进程（算不出 ⇒ permanent，不带 sandbox 不起）。
    //   这个探针验的是「失败的子进程说过的话能不能传出来」，跟类型无关 ⇒ 随便给一个真类型。
    { cwd: process.cwd(), timeoutMs: 15_000, agentType: 'review' },
  );
  process.stdout.write(JSON.stringify(r));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ probe_error: String(e && e.message || e) }));
});
