'use strict';

const fs = require('node:fs');
const path = require('node:path');
const q = require('../lib/queue');
const { semaphore, startPool } = require('../lib/worker-pool');

// ⚠️ 必须是 `lib/agent-capabilities.js` 里**真实存在**的类型。
//   编出来的类型名（如 'testeval'）会让 `startPool` 拒绝启动：
//   「算不出工具白名单就拒绝启动」是有意的约束 —— 一个类型名如果不在能力表里，
//   就算不出它的准入白名单，而「算不出」顺流而下会变成「什么都能用」。
//   （测试跑在 db15，`work:eval` 流不碰生产。）
const TYPE = 'eval';
const STREAM = `work:${TYPE}`;
const GROUP = `work:${TYPE}`;
const REPLY = 'orch:in:agent';

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n【1】信号量：并发上限');
  const sem = semaphore(2);
  await sem.acquire(); await sem.acquire();
  ok(sem.active === 2, '两个占满');
  let third = false;
  sem.acquire().then(() => { third = true; });
  await wait(50);
  ok(third === false, '第三个被挡住（不是排队失败，是等）');
  sem.release();
  await wait(50);
  ok(third === true, '有位置就放行');
  sem.release(); sem.release();

  console.log('\n【2】池：领活 → 跑 → ack → 回报');
  const redis = q.createClient();
  await redis.del(STREAM, REPLY);
  await q.ensureGroup(redis, STREAM, GROUP);

  const logs = [];
  // 注入假 runner —— 只验编排逻辑，不真调 LLM
  const fake = async (task) => {
    await wait(120);
    if (/BOOM/.test(task.text)) return { ok: false, ms: 120, reason: 'error', error: '故意失败' };
    return { ok: true, ms: 120, output: `处理完毕: ${task.text.slice(0, 20)}` };
  };

  const pool = startPool(redis, {
    type: TYPE, concurrency: 2, runner: fake, onLog: (m) => logs.push(m),
  });

  const good = await q.send(redis, STREAM, { from: 'JARVIS', text: '算个数', agent_type: TYPE });
  for (let i = 0; i < 60 && (await redis.xlen(REPLY)) === 0; i++) await wait(100);

  const replies = await redis.xrange(REPLY, '-', '+');
  ok(replies.length >= 1, '结果回到了 orch:in:agent');
  const o = {}; const f0 = replies[0][1];
  for (let i = 0; i < f0.length; i += 2) o[f0[i]] = f0[i + 1];
  ok(/处理完毕/.test(o.text), '带上了 worker 的输出');
  ok(o.job_id === good.job_id, 'job_id 贯通（幂等键 + 归因）');
  ok((await q.pending(redis, STREAM, GROUP)).count === 0, '成功后 ack，PEL 清零');

  console.log('\n【3】失败不 ack —— 宁可重跑不可丢活');
  await q.send(redis, STREAM, { from: 'JARVIS', text: 'BOOM 这个会失败', agent_type: TYPE });
  await wait(1200);
  ok((await q.pending(redis, STREAM, GROUP)).count === 1, '失败的留在 PEL 等重投');
  const all = await redis.xrange(REPLY, '-', '+');
  const last = {}; const fl = all[all.length - 1][1];
  for (let i = 0; i < fl.length; i += 2) last[fl[i]] = fl[i + 1];
  ok(/失败/.test(last.text) && /重投/.test(last.text), '失败也回报，并说明会重投');

  pool.stop();
  await redis.del(STREAM, REPLY);

  console.log('\n【4】★ 幂等去重：同一个 job_id 重投，不重跑，但**照常回报**');
  // 单独起一个池：runner 数调用次数，短 TTL 便于测过期
  let calls = 0;
  const counting = async (task) => {
    calls++;
    await wait(80);
    if (/PERM/.test(task.text)) return { ok: false, ms: 80, reason: 'spawn', error: '环境坏了', permanent: true };
    if (/THROW/.test(task.text)) throw new Error('runner 跑到一半炸了');
    if (/BOOM/.test(task.text)) return { ok: false, ms: 80, reason: 'error', error: '故意失败' };
    return { ok: true, ms: 80, output: `跑了第 ${calls} 次` };
  };
  const pool2 = startPool(redis, {
    type: TYPE, concurrency: 2, runner: counting, onLog: (m) => logs.push(m), dedupeTtlSec: 3,
  });

  /** 把同一条消息（同 job_id）投两次，返回收到的回报文本 */
  async function sendTwice(text, jobId) {
    await redis.del(REPLY);
    await q.send(redis, STREAM, { from: 'JARVIS', text, agent_type: TYPE, job_id: jobId });
    for (let i = 0; i < 40 && (await redis.xlen(REPLY)) === 0; i++) await wait(100);
    const first = await redis.xrange(REPLY, '-', '+');

    // ── 🔴 等**去重记录落地**，不是等回报 ────────────────────────────────
    //
    //     `replyAndAck` 里 `send` 排在 `remember` 之前
    //       ⇒ 回报出现时去重记录**还没落地**，余量只有几毫秒。
    //     ⇒ ⇒ 在「回报出现」之后就重投，验的是「**回报出现之后立刻重投 ⇒ 不该重跑**」——
    //       而那句话**系统从没承诺过**，而且同一个文件里 C10b 明说它不成立：
    //       「并发窗口内投两次 ⇒ runner 被调 2 次 —— **这是 at-least-once 的已知代价**」
    //     ⇒ ⇒ ⇒ 「回报之后几毫秒内」**就是那个并发窗口的尾巴**。
    //
    //   ★ 那种写法的症状是**只在机器忙的时候红**
    //     ⇒ 那不是「低概率 flaky」，是**一个余量极小的竞态** —— 两者的修法完全不同。
    //
    //   ✅ 所以等系统真正承诺的那个东西：**记录落地之后重投 ⇒ 不重跑**。
    //   ⚠️ 而 `dedupeKey` 从 `pool2` 拿，**不自己拼** —— 见 worker-pool.js 那段注释。
    const dkey = pool2.dedupeKey(jobId);
    let landed = false;
    for (let i = 0; i < 40 && !landed; i += 1) {
      if (await redis.get(dkey)) { landed = true; break; }
      await wait(100);
    }
    // 🔴 超时要 **fail-loud**：静默继续的话它会退化成「立刻重投」——
    //   而那正是上面说的那个竞态形状，且没人会知道它退化了。
    ok(landed, `（前提）去重记录在 4 秒内落地了 —— key: ${dkey}`,
      `记录一直没出现。key=${dkey}`);

    await q.send(redis, STREAM, { from: 'JARVIS', text, agent_type: TYPE, job_id: jobId });
    for (let i = 0; i < 40 && (await redis.xlen(REPLY)) < first.length + 1; i++) await wait(100);
    const both = await redis.xrange(REPLY, '-', '+');
    const texts = both.map(([, f]) => {
      const o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1];
      return o.text;
    });
    return texts;
  }

  // ══ 🔴 下面这两条红了吗？先问一句，再下结论 ═══════════════════════
  //
  //   ❓ **这一刻，机器上还有别人在跑东西吗？**（另一个人的全量 / 一批并发测试）
  //
  //   · **有** ⇒ 按 `sendTwice` 上面那段的分析，机器忙时它**不该**红。
  //             🔴 而它红了 ⇒ **那段分析不成立** ——
  //             「判据在验一句系统没承诺的话」这个结论错了，窗口在别处。
  //             ⇒ ⇒ 该做的是**重新找窗口**，而不是「又一个 flaky，重跑一次」。
  //   · **没有** ⇒ 那是一个新东西，跟那个竞态无关。
  //
  //   ── 那个竞态 ──────────────────────────────────────────────────────
  //     · `replyAndAck` 里 `send` 排在 `remember` 之前
  //       ⇒ **回报出现时去重记录还没落地，余量只有几毫秒**
  //     · 在「回报出现」之后就立刻重投 ⇒ 撞的正是那几毫秒
  //     · 而 C10b 明说那一格是**已知代价**：「并发窗口内投两次 ⇒ runner 被调 2 次」
  //     ⇒ ⇒ 所以 `sendTwice` 等的是**记录落地**，不是回报出现 ——
  //       「回报之后立刻重投 ⇒ 不该重跑」**系统从没承诺过**。
  //     那种写法的症状是**空闲时绿、超载时红** ——
  //       那不是「低概率 flaky」，是**一个余量极小的竞态**，而两者的修法完全不同。
  //
  const before = calls;
  const okTexts = await sendTwice('算个数', 'dedupe-ok-1');
  ok(calls === before + 1, `runner 只被调用一次（调了 ${calls - before} 次）`);
  ok(okTexts.length === 2, `第二次投递**仍然收到回报**（收到 ${okTexts.length} 条）`);
  // ★ 这条才是关键：只测「没重跑」不够 —— 那也可能是第二次啥都没干、
  //   调用方拿到一个空成功。必须断言第二次拿到的是**正确的结果**。
  ok(okTexts[0] === okTexts[1] && /跑了第/.test(okTexts[1] || ''),
    '★ 第二次的回报内容跟第一次一模一样（不是空成功）', JSON.stringify(okTexts));
  ok((await q.pending(redis, STREAM, GROUP)).count === 0, '重投那条也被 ack 了');

  // ── 【4b】🔴 **并发窗口内投两次 ⇒ 跑两次** ──────────────────────────────
  //
  //   ★ 上面【4】那节验的是**串行重投**：它 `await` 到第一条**跑完**（REPLY 有内容）
  //     才投第二条 —— 那时去重键已经写好了，所以第二条命中缓存。
  //   🔴 而**同时**投两条是另一回事，而且它是这个池的真实语义：
  //
  //       worker-pool.js:477/482   XREADGROUP … **count: concurrency**（默认 2）
  //                                ⇒ 两条同 job_id 的消息**同一批**被领走
  //       worker-pool.js:424-438   remember() 在**跑完之后**才 SET dedupeKey
  //       ⇒ 第二个 handle() 查去重时，第一个**还在跑、还没写** ⇒ 查到空 ⇒ 照常执行
  //
  //   ⚠️⚠️ **期望值是 2，而这不是待修的 bug —— 它是 at-least-once 的定义本身。**
  //     worker-pool.js:424 那条注释写着：
  //       「跑完再写 → 写之前崩了，重投会重跑一次。**重跑一次好过丢一次活**」
  //     改成「领取时就写去重键」会引入一个更坏的失败模式：
  //     **写了键但没跑完就崩 ⇒ 那个活彻底丢了**，而它没有任何症状。
  //
  //   ⇒ 所以这条断言存在的目的**不是守一个正确行为，是守住一个已知代价**：
  //     它变红的那天，说明有人改了投递语义，而那需要重新想一遍上面这段。
  //
  //   ── 怎么从日志认出这个形状 ────────────────────────────────────────
  //     「一次执行、回报两次」和「入队两次、执行一次」都能解释「收到两条回报」，
  //     而**两个都不是**。能分辨的是 bus 日志里这两行：
  //         [pool:solve] ▶ c10-dup- 开始（并发 1/2）
  //         [pool:solve] ▶ c10-dup- 开始（**并发 2/2**）
  //     而「命中去重」那行一次都不出现。
  //     ⇒ **能解释观测，不等于是那个原因。**
  {
    const beforeConc = calls;
    await redis.del(REPLY);
    const JID = 'dedupe-concurrent-1';
    // ★ 两条**同时**投 —— 不等第一条跑完。这就是跟【4】唯一的区别。
    await Promise.all([
      q.send(redis, STREAM, { from: 'JARVIS', text: '算个数', agent_type: TYPE, job_id: JID }),
      q.send(redis, STREAM, { from: 'JARVIS', text: '算个数', agent_type: TYPE, job_id: JID }),
    ]);
    for (let i = 0; i < 60 && (await redis.xlen(REPLY)) < 2; i += 1) await wait(100);
    const ran = calls - beforeConc;
    ok(ran === 2,
      `🔴 C10b 并发窗口内投两次 ⇒ runner 被调用 **2** 次（实际 ${ran}）`
      + ' —— **这是 at-least-once 的已知代价，不是待修的 bug**');
    ok((await redis.xlen(REPLY)) === 2,
      `🔴 C10b 而且**回报两条**（实际 ${await redis.xlen(REPLY)}）`
      + ' —— 派活的人看到两条完成回报时，它真的跑了两次');

    // ★ 正控（C10c）：**同一个池、同一个 job_id，串行投第三次 ⇒ 不再跑**
    //   没有它，上面那个 2 可能只是「去重从来就没生效过」。
    const beforeThird = calls;
    await q.send(redis, STREAM, { from: 'JARVIS', text: '算个数', agent_type: TYPE, job_id: JID });
    for (let i = 0; i < 40 && (await redis.xlen(REPLY)) < 3; i += 1) await wait(100);
    ok(calls === beforeThird,
      '🔴 C10c 正控：等前两条跑完之后**再投一次** ⇒ runner **没有**再被调用'
      + `（调了 ${calls - beforeThird} 次）⇒ 去重键确实在工作，上面那个 2 不是「去重从没生效」`);
    ok((await redis.xlen(REPLY)) === 3,
      '🔴 C10c 而它**照样收到回报**（用的是缓存的结果）—— 调用方并不知道这是第三次投递');
  }


  console.log('\n【5】要重投的失败不写记录 —— 否则就是宣布这活干完了');
  const beforeBoom = calls;
  await redis.del(REPLY);
  await q.send(redis, STREAM, { from: 'JARVIS', text: 'BOOM 会失败', agent_type: TYPE, job_id: 'dedupe-boom-1' });
  await wait(600);
  await q.send(redis, STREAM, { from: 'JARVIS', text: 'BOOM 会失败', agent_type: TYPE, job_id: 'dedupe-boom-1' });
  await wait(600);
  ok(calls === beforeBoom + 2, `失败的活重投时真的重跑了（跑了 ${calls - beforeBoom} 次）`);
  ok((await q.pending(redis, STREAM, GROUP)).count === 2, '两条都留在 PEL 等重投');

  // ★ 「返回失败」和「抛异常」是两条不同的路径：前者走 else 分支主动跳过
  //   记录，后者是 remember() 压根没执行到。都必须不留记录。
  const beforeThrow = calls;
  await q.send(redis, STREAM, { from: 'JARVIS', text: 'THROW 中途崩', agent_type: TYPE, job_id: 'dedupe-throw-1' });
  await wait(600);
  await q.send(redis, STREAM, { from: 'JARVIS', text: 'THROW 中途崩', agent_type: TYPE, job_id: 'dedupe-throw-1' });
  await wait(600);
  ok(calls === beforeThrow + 2, `runner 抛异常时也不留记录，重投真的重跑（跑了 ${calls - beforeThrow} 次）`);
  ok(await redis.exists(`dedupe:worker:${TYPE}:dedupe-throw-1`) === 0, '崩掉的活没有留下去重记录');

  console.log('\n【6】永久失败也要记 —— 否则 bus 一重启它又试一遍');
  const beforePerm = calls;
  const permTexts = await sendTwice('PERM 环境坏了', 'dedupe-perm-1');
  ok(calls === beforePerm + 1, `永久失败只跑一次（跑了 ${calls - beforePerm} 次）`);
  ok(permTexts.length === 2 && permTexts[0] === permTexts[1] && /永久失败/.test(permTexts[1] || ''),
    '★ 重投也拿到同一条永久失败回报', JSON.stringify(permTexts));

  console.log('\n【8】★ 准入层：worker 真的拿到了 --allowedTools（那个参数曾是死的）');
  {
    // ── 背景 ────────────────────────────────────────────────────────
    // `worker-runner.runPrint` 收 `allowedTools`、也有对应的 if 分支，
    // **但收了不等于有人传** —— 没有调用方传它时，它就是一个「以为有防护、
    // 实际没有」的死参数。
    //
    // ⚠️ 危险在于 `if (allowedTools) args.push(...)`：**不传 = 完全不限制**。
    //   所以「查不到能力」顺流而下会变成「什么都能用」。
    // ────────────────────────────────────────────────────────────────
    const caps = require('../lib/agent-capabilities');

    // ① 白名单本身对不对
    const evalTools = caps.allowedToolsFor('eval');
    ok(/WebFetch/.test(evalTools) && /WebSearch/.test(evalTools),
      '★ eval 拿得到 Web 工具（它是唯一能上网的）');
    ok(!/\bBash\b/.test(evalTools),
      '★★ eval **拿不到 Bash** —— 那是 prompt injection→RCE 链路的断点');
    const devTools = caps.allowedToolsFor('dev');
    ok(/\bBash\b/.test(devTools), '★ dev 拿得到 Bash');
    // ⚠️⚠️ dev 的 Web 是「拿得到」—— 这是有意的决定，不是遗漏。
    //
    //   ★ 上面 eval 那两条仍然守着原来的规矩(能上网 → 不给 Bash)。
    //     **两条并排放,那条被推翻的线才看得见** ——
    //     dev 现在 web + bash 都有,而 eval 那条注释写着
    //     「拿不到 Bash —— 那是 prompt injection→RCE 链路的断点」。
    //     **dev 没有那个断点。**
    ok(/WebFetch/.test(devTools) && /WebSearch/.test(devTools),
      '★ dev 也拿得到 Web');
    ok(/\bBash\b/.test(devTools) && /WebFetch/.test(devTools),
      '★★ 阴性对照的反面:确认 dev **同时**有 Bash 和 Web —— 那个组合是这条配置的实质');
    ok(caps.allowedToolsFor('nosuchtype') === null,
      '★ 未知类型返回 null —— 不返回「什么都不给」的默认对象');

    // ② ★ 接线：池真的把它传给了 runner。**这条守的是「线接上了」，
    //    而上面那几条只守「白名单算得对」—— 两个前提不同。**
    const seen = [];
    const spy = async (task, opts) => {
      seen.push(opts);
      return { ok: true, ms: 1, output: 'ok' };
    };
    await redis.del(STREAM, REPLY);
    await q.ensureGroup(redis, STREAM, GROUP);
    const pool8 = startPool(redis, { type: TYPE, concurrency: 1, runner: spy, onLog: () => {} });
    await q.send(redis, STREAM, { from: 'JARVIS', text: '探针', agent_type: TYPE });
    for (let i = 0; i < 60 && seen.length === 0; i++) await wait(100);
    pool8.stop();

    ok(seen.length > 0, 'runner 被调用了', JSON.stringify(seen));
    ok(typeof seen[0]?.allowedTools === 'string' && seen[0].allowedTools.length > 0,
      '★★ 池真的传了 allowedTools（摘掉传参这条就红）', JSON.stringify(seen[0]));
    ok(seen[0]?.allowedTools === caps.allowedToolsFor(TYPE),
      '★ 而且用的是能力表算出来的那份，不是另写的一份');
    ok(seen[0]?.agentType === TYPE, 'agentType 也照旧传着（执行层靠它认身份）');

    // ── ★★ disallowedTools：**这才是真正起作用的那层** ──────────────
    //   真调用 claude 的结果：
    //     --allowedTools "Read,Write,..."（不含 Bash） → **Bash 照样能跑**
    //     --disallowedTools "Bash"                     → 被拒 ✓
    //   **`--allowedTools` 是「额外允许」，不禁止未列出的工具。**
    //
    // ⚠️ 所以上面那几条 allowedTools 的断言**守的是意图，不是防护**。
    //   一个前提更好但不生效的防护，**防护数是 0 不是 1**。
    //   （只读 `--help` 会得出「白名单就够了」的结论 —— **读文档不是验证**。）
    // ────────────────────────────────────────────────────────────────
    // ── ★ `resident`：形态，跟 `bash` 是**两个独立维度** ──────────────
    //   只看 dev 和 eval 的话，「有 bash」和「常驻」**恰好完全相关**，
    //   很容易拿能力当形态的代理（「有 Bash ⇒ 必须有 poller 循环」）。
    //   **第三个样本一来就不成立。**
    //
    //   > **两个独立维度在小样本上完全相关，不代表其中一个能代理另一个。**
    //
    //   下面这条守的正是「它们独立」—— 有了 test/solve/write 之后，
    //   **存在「有 bash 但不常驻」的类型**，那是这个字段存在的全部理由。
    // ────────────────────────────────────────────────────────────────
    const all = Object.entries(caps.CAPABILITIES);
    ok(all.every(([, c]) => typeof c.resident === 'boolean'),
      '★ 每个类型都显式声明了 resident（不是靠 bash 推断）');
    ok(all.some(([, c]) => c.bash === true && c.resident === false),
      '★★ 存在「有 bash 但不常驻」的类型 —— **那是这个字段存在的理由**，'
      + '没有它就说明两个维度又退回相关了');
    ok(caps.CAPABILITIES.dev.resident === true
      && caps.CAPABILITIES.orchestrator.resident === true,
      '常驻的两个：dev / orchestrator');
    ok(all.filter(([, c]) => !c.resident).length >= 4,
      '★ 阴性对照：worker 类型有四个（不是「全都常驻」或「全都不常驻」）');

    const evalDenied = caps.disallowedToolsFor('eval');
    ok(/\bBash\b/.test(evalDenied),
      '★★ eval 的 disallowedTools 含 Bash —— prompt injection→RCE 链路的断点');
    ok(!/WebFetch|WebSearch/.test(evalDenied),
      '★ 但不禁 Web —— eval 是唯一该上网的（否则它干不了活）');

    // ── ★★ 只禁 Bash 不够 ────────────────────────────────────────────
    //   `disallowedTools` 把 eval 的 Bash 真的拦住之后，**模型会改用 Write
    //   建出同一个文件**。只堵一个出口等于没堵。
    //
    //   `templates/eval/.claude/settings.json` 明确 `deny: [Bash, Write, ...]`
    //   —— **但 worker 走 `-p` 模式，那个文件根本不参与**。
    //   > **一个正确的决定 + 正确的理由 + 写在不参与运行的地方 = 零。**
    // ────────────────────────────────────────────────────────────────
    for (const t of ['Write', 'Edit', 'NotebookEdit']) {
      ok(new RegExp(`\\b${t}\\b`).test(evalDenied),
        `★★ eval 禁 ${t} —— 能读外部内容的，连落盘也不给`);
    }

    // ── ★★ 两个函数**严格互补**：这才是「偏差没地方产生」的证明 ──────
    //   如果「`allowedToolsFor` 按 web 滤掉 WRITE_TOOLS，
    //   而 `disallowedToolsFor` 里没有对应的另一半」——
    //   **同一个事实在两个函数里各自表述，偏差必然产生**。
    //   第四维 `write` 让两边从同一格派生，下面这条就恒成立。
    // ────────────────────────────────────────────────────────────────
    const ALL_MANAGED = ['Bash', ...caps.WEB_TOOLS, 'Write', 'Edit', 'NotebookEdit'];
    for (const [t] of all) {
      const A = new Set(String(caps.allowedToolsFor(t)).split(','));
      const D = new Set(String(caps.disallowedToolsFor(t)).split(',').filter(Boolean));
      const both = ALL_MANAGED.filter((x) => A.has(x) && D.has(x));
      const neither = ALL_MANAGED.filter((x) => !A.has(x) && !D.has(x));
      ok(both.length === 0, `★★ ${t}: 没有工具同时被给和被禁`, both.join(','));
      ok(neither.length === 0,
        `★★ ${t}: 每个受管工具都有明确归属（不是「没提到」）`, neither.join(','));
    }

    // ★ NotebookEdit 不在 BASE_TOOLS 里 ——「基础工具」那个概念假设了
    //   「所有 agent 都需要这些」，而那个假设对 worker 不成立。
    ok(!caps.BASE_TOOLS.includes('NotebookEdit'),
      '★ NotebookEdit 已从 BASE_TOOLS 移出（四个 worker 一个都不需要它）');
    ok(!caps.BASE_TOOLS.includes('Write') && !caps.BASE_TOOLS.includes('Edit'),
      '★ 写盘工具全部只随 write 维度发放，不在「基础」里');

    // 阴性对照：不是「谁都不给」
    ok(/\bWrite\b/.test(caps.allowedToolsFor('dev')), '★ 阴性对照：dev 仍然有 Write');
    ok(!/\bWrite\b/.test(caps.disallowedToolsFor('dev')), '★ 阴性对照：dev 不禁 Write');
    ok(!caps.CAPABILITIES.test.write && caps.CAPABILITIES.test.bash,
      '★ test：有 bash 没 write —— **交诊断不交补丁**（write 跟 bash 也是独立的两维）');

    // ── ★★ `review`：四维全 false，这张表里唯一的纯读者 ────────────────
    //   用途是 ShipFlow 的 12 个只读角色。而 `security-reviewer` 的定义写着
    //   「Flags concerns with file:line evidence; **doesn't fix**」——
    //
    //   > **`write:false` 把那句人格约束变成机制约束。**
    //   > 写在提示词里的「你不该改代码」，跟工具层根本没给它 Write，
    //   > **在它真想改的那一刻是两回事。**
    {
      const rAllow = caps.allowedToolsFor('review');
      const rDeny = caps.disallowedToolsFor('review');

      // ★★ 它**没有引入任何新机制** —— allowed 恰好等于 BASE_TOOLS。
      //   有人给它加特殊分支的话，这条会红。
      ok(rAllow === caps.BASE_TOOLS.join(','),
        '★★ review 的 allowed **恰好等于 BASE_TOOLS** —— 四个已有维度的一个组合，'
        + '没有新机制（需要新机制才表达得了的话，说明维度选错了）',
        `实际 ${rAllow}`);

      for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit', ...caps.WEB_TOOLS]) {
        ok(new RegExp(`\\b${t}\\b`).test(rDeny), `★★ review 禁 ${t}`);
      }
      // ★ Write 和 Edit **两个都要**：Bash 被禁之后
      //   模型会**改用 Write 建出同一个文件**。
      //   `wiring.test.js` 的原话：**禁掉一个工具不等于禁掉它能达成的效果。**
      ok(/\bWrite\b/.test(rDeny) && /\bEdit\b/.test(rDeny),
        '★★ Write 和 Edit 同时禁 —— 只禁一个的话，另一个就是绕道');

      ok(!/\bBash\b/.test(rAllow) && !/WebFetch/.test(rAllow) && !/\bWrite\b/.test(rAllow),
        '★ allowed 里一个都没漏进来');
      ok(caps.CAPABILITIES.review.resident === false,
        '★ review 是 worker 形态（一次性），不是常驻');

      // ★ 阴性对照：不是「所有类型都被禁光了」——
      //   缺了它，一个「disallowedToolsFor 恒返回全集」的实现也能过上面每一条。
      ok(!/\bBash\b/.test(caps.disallowedToolsFor('solve')),
        '★ 阴性对照：solve 不禁 Bash（否则「全禁」的实现也能过）');
      ok(/\bWrite\b/.test(caps.allowedToolsFor('solve')),
        '★ 阴性对照：solve 仍有 Write');
    }

    const devDenied = caps.disallowedToolsFor('dev');
    // ⚠️ 同上:dev 的 deny 里不含 Web。
    //   ★ 这里断言「deny 里**没有** Web」,而不是不写这条断言 ——
    //     不写的话,哪天有人把 deny 加回来,不会有任何东西红。
    //     **一个被推翻的规矩,仍然值得一条守卫盯着它保持被推翻的状态。**
    ok(!/WebFetch|WebSearch/.test(devDenied),
      '★ dev 的 deny 里没有 Web');
    ok(!/\bBash\b/.test(devDenied),
      '★ 阴性对照：dev 不禁 Bash（否则「全禁」的实现也能过上面几条）');
    ok(caps.disallowedToolsFor('nosuchtype') === null,
      '★ 未知类型 → null（跟 allowedToolsFor 一致，调用方 fail-closed）');

    // ★ 接线：池真的把它传下去了。**这条跟上面那几条前提不同** ——
    //   白名单/黑名单算得对 ≠ 它被传到了 worker 手上。
    ok(typeof seen[0]?.disallowedTools === 'string' && /\bBash\b/.test(seen[0].disallowedTools),
      '★★ 池真的传了 disallowedTools，而且 eval 的那份含 Bash',
      JSON.stringify(seen[0]));
    ok(seen[0]?.disallowedTools === caps.disallowedToolsFor(TYPE),
      '★ 用的是能力表算出来的那份，不是另写的一份');

    // ★ argv 层：worker-runner 真的把它拼进了命令行参数
    const runnerSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'worker-runner.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(/--disallowedTools/.test(runnerSrc),
      '★ worker-runner 把 --disallowedTools 拼进 argv');
    ok((runnerSrc.match(/--disallowedTools/g) || []).length >= 2,
      '★ 两条启动路径都拼了（runPrint 和 runTmux —— 只改一边不算修完）');

    // ③ 未知类型必须**在启动时炸**，不能静默不传
    let threw = false;
    try {
      startPool(redis, { type: 'definitely_not_a_type', runner: spy, onLog: () => {} });
    } catch (_) { threw = true; }
    ok(threw,
      '★★ 未知类型 → startPool 抛错。**不能静默不传** —— 那等于完全不限制');
  }

  console.log('\n【7】TTL 到期后同一个 job_id 会重跑');
  const beforeTtl = calls;
  await redis.del(REPLY);
  await q.send(redis, STREAM, { from: 'JARVIS', text: '算个数', agent_type: TYPE, job_id: 'dedupe-ttl-1' });
  for (let i = 0; i < 40 && (await redis.xlen(REPLY)) === 0; i++) await wait(100);
  ok(calls === beforeTtl + 1, '第一次跑了');
  await wait(3300);   // dedupeTtlSec = 3
  await q.send(redis, STREAM, { from: 'JARVIS', text: '算个数', agent_type: TYPE, job_id: 'dedupe-ttl-1' });
  await wait(800);
  ok(calls === beforeTtl + 2, `记录过期后重投会真的重跑（共跑 ${calls - beforeTtl} 次）`);

  pool2.stop();

  // ── 【4c】🔴 **per-job `timeout_ms` 真的被读到了** ──────────────────────
  //
  //   ⚠️⚠️ **不许只断言「relay 把 timeout_ms 写进了消息」** ——
  //     relay 校验了它、写进了消息，而 `worker-pool` 可能**一个字都没读**。
  //     表现是「设了 5 分钟，10 分钟才被杀」—— **零报错**。
  //
  //   ★ 这是上面 `allowedTools` 那个死参数的镜像：
  //     那边是「收了，没人传」；这边是**「传了，没人收」**。
  //     ⇒ 一段记录着某个坑的注释，防不住那个坑的镜像版本。
  //
  //   ⇒ 所以这一节断言的是 **pool 交给 runner 的那个 `timeoutMs` 到底是几**，
  //     而不是「消息里有没有那个字段」。
  {
    // ⚠️ **用 `review` 这个独立的 type/流** —— 上面那些用的是 `eval`。
    //   用同一个 `TYPE` 的话，这个 pool 跟 pool2 **抢同一条流的消息**：
    //   这里的断言拿到 `undefined`（消息被 pool2 的 runner 领走了），
    //   而 pool2 那边的 C10c 也跟着红 —— 两个测试互相污染。
    //   ★ 而两边红的样子完全不像同一个原因：一边是「undefined」，一边是「多跑了一次」。
    const RT = 'review';
    const RSTREAM = `work:${RT}`;
    const seen = [];
    const capturing = async (task, opts) => {
      seen.push(opts && opts.timeoutMs);
      await wait(20);
      return { ok: true, ms: 20, output: 'captured' };
    };
    const POOL_TIMEOUT = 600_000;
    const pool4c = startPool(redis, {
      type: RT, concurrency: 1, runner: capturing, onLog: () => {}, timeoutMs: POOL_TIMEOUT,
    });
    await redis.del(REPLY);

    // ① job 带一个**更小**的 timeout_ms ⇒ pool 必须用它
    await q.send(redis, RSTREAM, {
      from: 'JARVIS', text: 'x', agent_type: RT, job_id: 'tmo-small-1', timeout_ms: 120_000,
    });
    for (let i = 0; i < 40 && seen.length < 1; i += 1) await wait(100);
    ok(seen[0] === 120_000,
      `🔴 job 带 timeout_ms=120000 ⇒ **pool 交给 runner 的就是 120000**（实际 ${seen[0]}）`
      + ' —— 这条断言的是「被读到了」，不是「写进去了」');

    // ② 🔴 正控：**不带** timeout_ms ⇒ 必须退回池的默认值
    //   没有它，上面那条可能只是「pool 永远传 msg 里的某个值」或者巧合。
    await q.send(redis, RSTREAM, {
      from: 'JARVIS', text: 'x', agent_type: RT, job_id: 'tmo-none-1',
    });
    for (let i = 0; i < 40 && seen.length < 2; i += 1) await wait(100);
    ok(seen[1] === POOL_TIMEOUT,
      `🔴 正控：不带 timeout_ms ⇒ 退回**池的默认值** ${POOL_TIMEOUT}（实际 ${seen[1]}）`);

    // ③ 🔴 只能调小：比池大的值必须被夹到池的上界
    //   入口（lib/relay.js 的 resolveWork）已经会拒绝它，这里是**第二道**。
    //   ⚠️ 而「夹住」在这一层是对的，在入口层是错的 —— 入口夹住的话
    //     发起方以为自己拿到了更长的时间；这里夹住是最后一道防线。
    await q.send(redis, RSTREAM, {
      from: 'JARVIS', text: 'x', agent_type: RT, job_id: 'tmo-big-1', timeout_ms: 1_800_000,
    });
    for (let i = 0; i < 40 && seen.length < 3; i += 1) await wait(100);
    ok(seen[2] === POOL_TIMEOUT,
      `🔴 比池大的 timeout_ms（1800000）被夹到池的上界 ${POOL_TIMEOUT}（实际 ${seen[2]}）`
      + ' —— **只能调小**：更大的话 autoclaim 的重投窗口会先到 ⇒ 同一个 job 并发跑两份');

    // ④ 非法值退回默认（不是崩、也不是 0）
    await q.send(redis, RSTREAM, {
      from: 'JARVIS', text: 'x', agent_type: RT, job_id: 'tmo-bad-1', timeout_ms: 'ten',
    });
    for (let i = 0; i < 40 && seen.length < 4; i += 1) await wait(100);
    ok(seen[3] === POOL_TIMEOUT,
      `非法 timeout_ms（"ten"）退回池的默认值（实际 ${seen[3]}）—— 不是 0、不是 NaN`);

    pool4c.stop();
  }

  await redis.del(STREAM, REPLY);

  // ★ 【9】会 provision 出一个 `workers/review/`，而 `workers/` 是被 git 追踪的 ——
  //   留一个在那，会变成一条谁都说不清哪来的未追踪目录。
  //   ⚠️ 声明放在块外，是为了**文件末尾那个「清到真干净为止」的循环够得着**：
  //   `pool.stop()` 只设标志、不等在途任务，清一次可能赶在它重建之前。
  const workersReview = path.join(__dirname, '..', 'workers', 'review');
  const reviewPreexisted = fs.existsSync(workersReview);

  console.log('\n【9】★★ 执行目录按 job 走，而模板目的地**不跟着走**');
  {
    // ── 背景 ────────────────────────────────────────────────────────
    //   `security-reviewer` 这类 worker 跑在 `workers/review/` 里，
    //   **它看不到任何要审的代码** —— 而它照样会输出一份看起来很像回事的
    //   审查报告。所以「执行目录按 job 走」是接入审查类 worker 的硬前置。
    //
    //   ⚠️ 而「把 cwd 换成 msg.cwd」是错的：`provision` 用的是同一个变量，
    //   它是无条件覆盖模式，**只准写进 `workers/` 之下**。直接替换的后果不是
    //   崩，是每个带 cwd 的 job 都回一句 `provision_failed` —— 下面 ④ 守这个。
    // ────────────────────────────────────────────────────────────────
    const crypto = require('node:crypto');
    const os = require('node:os');
    const { execFile } = require('node:child_process');

    // ★ 用 `review` 不是 `eval`：`work:review` 是独立的一条流，跟上面几个池
    //   零竞争（pool2.stop() 之后 loop 可能还阻塞在 claimNext 里没退干净）。
    //   而 review 正是这个功能的目标场景 —— ShipFlow 那 12 个只读角色。
    const RTYPE = 'review';
    const RSTREAM = `work:${RTYPE}`;

    // ★★ 证据字符串**测试运行时当场生成**，不用固定串。
    //   固定串有三条被伪造的路：被缓存命中、被谁硬编码进实现、被模型猜中。
    //   **随机串把这三条同时断掉，而且每次跑都不一样。**
    //   （比固定的 `HEADING=Example Domain` 那种证据硬一级。）
    const canary = crypto.randomBytes(16).toString('hex');
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-cwd-'));
    fs.writeFileSync(path.join(targetDir, 'canary.txt'), canary);

    // ★★ **真子进程**，不是记下 `opts.cwd` 的 spy。
    //   记 opts 只能证明「传了」。这里读的是**相对路径** `canary.txt` ——
    //   只有进程真的站在那个目录里才读得到。**只看文件系统的结果，
    //   不看参数、不看自述。**
    const readCanary = (task, opts) => new Promise((resolve) => {
      execFile(process.execPath, ['-e',
        "const fs=require('fs');process.stdout.write("
        + "fs.existsSync('canary.txt')?fs.readFileSync('canary.txt','utf8'):'NO_CANARY')"],
      { cwd: opts.cwd },
      (err, stdout) => resolve(err
        ? { ok: false, ms: 1, reason: 'error', error: String(err.message) }
        : { ok: true, ms: 1, output: String(stdout).trim() }));
    });

    await redis.del(RSTREAM, REPLY);
    await q.ensureGroup(redis, RSTREAM, `work:${RTYPE}`);
    const pool9 = startPool(redis, {
      type: RTYPE, concurrency: 1, runner: readCanary, onLog: (m) => logs.push(m),
    });

    /** 投一条，等回报，返回最后一条的文本 */
    async function runOne(fields) {
      await redis.del(REPLY);
      await q.send(redis, RSTREAM, { from: 'JARVIS', agent_type: RTYPE, ...fields });
      for (let i = 0; i < 60 && (await redis.xlen(REPLY)) === 0; i++) await wait(100);
      const rows = await redis.xrange(REPLY, '-', '+');
      if (!rows.length) return '';
      const o = {}; const f = rows[rows.length - 1][1];
      for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1];
      return o.text || '';
    }

    // ① 带 cwd → worker 真的站在那个目录里
    const withCwd = await runOne({ text: '读 canary', cwd: targetDir });
    ok(withCwd.includes(canary),
      '★★ 带 cwd 的 job：worker **真的跑在那个目录里**（读到了只有那里才有的随机串）',
      withCwd.slice(0, 200));

    // ② ★ 阴性对照。**缺了它，一个「恒读到」的实现也能过 ①。**
    const noCwd = await runOne({ text: '读 canary' });
    ok(!noCwd.includes(canary) && /NO_CANARY/.test(noCwd),
      '★★ 阴性对照：不带 cwd 的 job 回落到默认目录，读不到那个串（默认值没被改坏）',
      noCwd.slice(0, 200));

    // ③ ★★ provision **没有**跟着 job 的 cwd 跑出去。
    //    （跟出去的话，它会把 templates/eval/ 写进仓库根，覆盖编排者的 CLAUDE.md。）
    ok(!fs.existsSync(path.join(targetDir, 'CLAUDE.md'))
      && !fs.existsSync(path.join(targetDir, '.claude')),
    '★★ 模板**没有**被写进 job 指定的目录 —— provision 的目的地不跟着 job 走');
    // ★ 而且不是「两边都没写」—— 模板确实下发了，只是下发到了 workers/<type>/。
    ok(fs.existsSync(path.join(workersReview, 'CLAUDE.md')),
      '★ 阴性对照：模板确实下发了（下发到 workers/review/），不是 provision 整个没跑');

    // ④ 直接替换 cwd 的写法会在这里红 —— 它的症状不是崩，是这一句。
    ok(!/provision/.test(withCwd),
      '★★ 带仓库外 cwd 的 job **没有**变成 provision_failed'
      + '（「把 cwd 换成 msg.cwd」的实现会在这条红，而 ① 只会告诉你「没读到」）',
      withCwd.slice(0, 200));

    // ⑤ cwd 不存在时错误信息要说得出自己是谁。
    //   `isPermanent` 认 ENOENT，而**claude 二进制找不到也是 ENOENT** ——
    //   两个原因撞同一条错误信息，人会先去查 claude 装没装。
    const badCwd = await runOne({ text: '读 canary', cwd: path.join(targetDir, 'nope') });
    ok(/cwd 不存在/.test(badCwd),
      '★ job 的 cwd 不存在 → 错误直指路径，不跟「claude 二进制找不到」混在一起',
      badCwd.slice(0, 200));

    pool9.stop();
    fs.rmSync(targetDir, { recursive: true, force: true });
    await redis.del(RSTREAM, REPLY);
    // workers/review/ 在下面那个「清到真干净为止」的循环里擦 —— 见声明处。
  }

  console.log('\n【10】★★ 人格跟着 worker 走，不跟着 runCwd 走');
  {
    // ── 背景：这是拆开 cwd 之后长出来的第二个洞 ──────────────────────
    //   worker 站在被审的项目里，claude 自动读到的 CLAUDE.md 就是**那个项目的**。
    //   而审 EngLoop 自己时 —— 仓库根那份是编排者引导，
    //   开头第一句是「你是这个系统的编排者，你不会退出」。
    //   **一个 review worker 读到它会去当第二个 JARVIS，而且不会报错。**
    //
    // ⚠️ 下面这几条守的是**接线**（参数传对了没有），**不是「冲突时谁赢」** ——
    //   后者只有真调一次 claude 才证明得了，spy 证明不了。两个前提不同，
    //   别把这一节读成「人格已经赢了」。
    // ────────────────────────────────────────────────────────────────
    const os = require('node:os');
    const RTYPE = 'review';
    const RSTREAM = `work:${RTYPE}`;
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-persona-'));

    const seen = [];
    const spy = async (task, opts) => { seen.push(opts); return { ok: true, ms: 1, output: 'ok' }; };

    await redis.del(RSTREAM, REPLY);
    await q.ensureGroup(redis, RSTREAM, `work:${RTYPE}`);
    const pool10 = startPool(redis, {
      type: RTYPE, concurrency: 1, runner: spy, onLog: (m) => logs.push(m),
    });
    await q.send(redis, RSTREAM, { from: 'JARVIS', text: '探针', agent_type: RTYPE, cwd: targetDir });
    for (let i = 0; i < 60 && seen.length === 0; i++) await wait(100);
    pool10.stop();

    ok(seen.length > 0, 'runner 被调用了', JSON.stringify(seen));
    ok(typeof seen[0]?.appendSystemPromptFile === 'string' && seen[0].appendSystemPromptFile.length > 0,
      '★★ 池真的传了 appendSystemPromptFile（不传的话人格静默缺席）',
      JSON.stringify(seen[0]));
    ok(seen[0]?.appendSystemPromptFile === path.join(workersReview, 'CLAUDE.md'),
      '★★ 人格指向 workers/review/CLAUDE.md —— **provision 刚下发的那一份，出处只有一个**',
      String(seen[0]?.appendSystemPromptFile));

    // ★★ 这条才是这一节的实质：**两个目录同时成立，而且方向相反。**
    //   只断言人格路径对，一个「人格和 cwd 都用默认值」的实现也能过。
    ok(seen[0]?.cwd === targetDir
      && seen[0]?.appendSystemPromptFile !== path.join(targetDir, 'CLAUDE.md'),
    '★★ 同一次调用里：**活在 job 给的目录里干，人格从 workers/ 来** —— '
      + '人格没有跟着 runCwd 走（跟着走的话，审 EngLoop 时读到的就是编排者引导）',
    JSON.stringify({ cwd: seen[0]?.cwd, persona: seen[0]?.appendSystemPromptFile }));

    // ★ argv 层：两条启动路径都要拼。**只改一边不算修完** ——
    //   `--disallowedTools` 就在 runTmux 上漏过一次，而那条路径还带着
    //   `--dangerously-skip-permissions`。
    const runnerSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'worker-runner.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok((runnerSrc.match(/--append-system-prompt-file/g) || []).length >= 2,
      '★★ runPrint 和 runTmux **两条**路径都拼了 --append-system-prompt-file',
      `实际出现 ${(runnerSrc.match(/--append-system-prompt-file/g) || []).length} 次`);

    fs.rmSync(targetDir, { recursive: true, force: true });
    await redis.del(RSTREAM, REPLY);
  }

  console.log('\n【11】★★ 报告和事实相符：七条回报路径，说的和做的必须一致');
  {
    // ── 背景 ────────────────────────────────────────────────────────
    //   用 `res.permanent`（**原因**）去代理「这条 ack 没 ack」（**行为**）是错的：
    //   `permanent ⇒ 已 ack` 成立，**反向不成立** ——
    //   于是 `provision_failed` / `persona_missing` 两条会**ack 了却说
    //   「未确认，将被重投」**，人会去等一个永远不会来的重投。
    //
    // ★★ 判据是「**两者一致**」，不是「文案对」。
    //   把期望文案抄进断言，是**恒真检查**最常见的生成方式：它永远绿，
    //   因为它比较的是同一个东西的两份拷贝。
    //   下面比的是两个**独立的事实**：PEL 里还在不在（行为）× 文案说了什么（说法）。
    //   **它们能不一致 —— 所以它能红。**
    // ────────────────────────────────────────────────────────────────
    const os = require('node:os');

    /** @param pending PEL 条数（行为） @param text 回报文本（说法） */
    function consistent(label, text, pending) {
      const saysRetry = /将被重投/.test(text);
      const saysStopped = /已停止重投/.test(text);
      const saysDone = /完成 \d+s\]/.test(text);
      const claims = [saysRetry, saysStopped, saysDone].filter(Boolean).length;
      // ★ 「一句都没声明」也是不一致 —— 沉默的回报让人无从判断要不要等
      ok(claims === 1, `★ ${label}: 回报恰好做一个声明（做了 ${claims} 个）`,
        text.slice(0, 140));
      ok(saysRetry === (pending > 0),
        `★★ ${label}: 说法和行为一致（说「将被重投」=${saysRetry}，PEL 里还剩 ${pending} 条）`,
        text.slice(0, 140));
    }

    /** 起一个池、投一条、等回报、量 PEL。返回最后一条回报的文本 + PEL 条数。 */
    async function runPath({ type, runner, fields = {}, twice = false }) {
      const S = `work:${type}`;
      await redis.del(S, REPLY);
      await q.ensureGroup(redis, S, S);
      const pool = startPool(redis, { type, concurrency: 1, runner, onLog: () => {} });
      const read = async () => {
        const rows = await redis.xrange(REPLY, '-', '+');
        return rows.map(([, f]) => {
          const o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1];
          return o.text || '';
        });
      };
      await q.send(redis, S, { from: 'JARVIS', text: '探针', agent_type: type, ...fields });
      for (let i = 0; i < 60 && (await redis.xlen(REPLY)) === 0; i++) await wait(100);
      if (twice) {
        // 同 job_id 再投一次 —— 走去重命中那条路径
        await q.send(redis, S, { from: 'JARVIS', text: '探针', agent_type: type, ...fields });
        for (let i = 0; i < 60 && (await redis.xlen(REPLY)) < 2; i++) await wait(100);
      }
      await wait(250);                       // 让 ack 落地再量 PEL
      const pending = (await q.pending(redis, S, S)).count;
      const texts = await read();
      pool.stop();
      await redis.del(S, REPLY);
      return { text: texts[texts.length - 1] || '', pending, texts };
    }

    const okRunner = async () => ({ ok: true, ms: 1000, output: 'ok' });
    const permRunner = async () => ({ ok: false, ms: 1, reason: 'spawn', error: '环境坏了', permanent: true });
    const failRunner = async () => ({ ok: false, ms: 1, reason: 'error', error: '故意失败' });

    // ① 成功
    const r1 = await runPath({ type: 'eval', runner: okRunner });
    consistent('成功', r1.text, r1.pending);

    // ② 永久失败 —— ack 了
    const r2 = await runPath({ type: 'eval', runner: permRunner });
    consistent('永久失败', r2.text, r2.pending);

    // ③ ★ 普通失败 —— **七条里唯一真的会被重投的一条**，也只有它该说「将被重投」
    const r3 = await runPath({ type: 'eval', runner: failRunner });
    consistent('普通失败（要重投）', r3.text, r3.pending);
    ok(r3.pending === 1, '★ 阴性对照：确实有一条留在 PEL（否则「一致」是靠两边都空达成的）');

    // ④ 去重命中重放
    const r4 = await runPath({ type: 'eval', runner: okRunner, fields: { job_id: 'consistency-dup' }, twice: true });
    consistent('去重命中', r4.text, r4.pending);
    // ★★ 「一字不差地重放」—— 这个性质靠的是「能被重放的路径全在 replyAndAck
    //    这一侧」。谁把某条挪到另一侧，这里就从「一字不差」变成「一字之差」。
    ok(r4.texts.length === 2 && r4.texts[0] === r4.texts[1],
      '★★ 重投命中缓存时**一字不差**地重放了同一句话', JSON.stringify(r4.texts));

    // ⑤ bad_cwd
    const r5 = await runPath({ type: 'eval', runner: okRunner, fields: { cwd: '/definitely/not/a/dir' } });
    consistent('bad_cwd', r5.text, r5.pending);

    // ⑥ provision_failed
    //   ★ 用 `orchestrator` —— 它是能力表里**唯一没有模板目录**的类型。
    ok(require('../lib/template-discovery').templateDirFor('orchestrator') === null,
      '★★ 前置：orchestrator 确实没有模板目录 —— **这条一红，下面测的就不是 '
      + 'provision_failed 了，而测试不会告诉你**');
    const r6 = await runPath({ type: 'orchestrator', runner: okRunner });
    consistent('provision_failed', r6.text, r6.pending);
    ok(/provision/.test(r6.text), '★ 而且它确实走的是 provision 失败那条', r6.text.slice(0, 140));

    // ⑦ persona_missing —— 造一个「有模板目录、但里面没有 CLAUDE.md」的根
    const tplRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-tplroot-'));
    fs.mkdirSync(path.join(tplRoot, 'write', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tplRoot, 'write', '.claude', 'settings.json'), '{}');
    const savedRoots = process.env.ENGLOOP_TEMPLATE_ROOTS;
    process.env.ENGLOOP_TEMPLATE_ROOTS = tplRoot;   // defaultRoots 每次读 env，不缓存
    let r7;
    try {
      r7 = await runPath({ type: 'write', runner: okRunner });
    } finally {
      if (savedRoots === undefined) delete process.env.ENGLOOP_TEMPLATE_ROOTS;
      else process.env.ENGLOOP_TEMPLATE_ROOTS = savedRoots;
      fs.rmSync(tplRoot, { recursive: true, force: true });
    }
    consistent('persona_missing', r7.text, r7.pending);
    ok(/persona_missing|CLAUDE\.md/.test(r7.text),
      '★ 而且它确实走的是「人格文件不在」那条（不是 provision 失败）', r7.text.slice(0, 140));

    // 清理测试建出来的 workers 子目录
    for (const t of ['orchestrator', 'write']) {
      const d = path.join(__dirname, '..', 'workers', t);
      if (!fs.existsSync(path.join(d, 'CLAUDE.md'))) fs.rmSync(d, { recursive: true, force: true });
    }
  }

  // ★ stop() 只设标志，**不等在途任务**：loop 可能还阻塞在 claimNext 里，
  //   返回后照样把手上那条处理完、写完去重记录 —— 写在清理之后。
  //   清一次的话会漏下一条 dedupe-ttl-1 那样的去重记录在库里。
  //   谁弄脏谁擦干净，所以这里清到真干净为止，不是清一次就算数。
  for (let i = 0; i < 10; i++) {
    const leftover = [
      ...await redis.keys(`dedupe:worker:${TYPE}:*`),
      ...await redis.keys('dedupe:worker:review:*'),   // 【9】走的是 work:review 那条流
    ];
    // 测试前不存在才擦 —— 别人先建好的不归这个测试删。
    if (!reviewPreexisted) fs.rmSync(workersReview, { recursive: true, force: true });
    if (!leftover.length && (reviewPreexisted || !fs.existsSync(workersReview))) break;
    if (leftover.length) await redis.del(...leftover);
    await wait(200);
  }
  console.log('\n【★停止语义】🔴 stop() 返回之后，池**不能再从流里领到任何东西**');
  {
    // ══════════════════════════════════════════════════════════════
    // 这一条守的是一个竞态：
    //   `while (!stopped)` 的判断在 `claimNext` **之前**，而 claimNext 阻塞
    //   最多 5 秒。于是 `stop()` 返回之后，一个还卡在里面的 loop 仍然会
    //   醒来、领走消息、并把它跑完 —— **而调用方以为池已经停了。**
    //   （没有 `if (stopped) break` 的话，`stop()` 返回之后几毫秒 runner 就会被调用。）
    //
    // ⚠️⚠️ **必须用第二个 redis 连接来投这条消息。**
    //   共用一个连接的话，池阻塞在 claimNext 时**独占它**，`q.send` 会被
    //   排到 5 秒之后才真正生效 —— 那时 loop 早退出了，
    //   **这条断言就永远绿，而它什么都没测到。**
    //   （这也正是同一个 bug 在全量里只是偶发的原因：本文件别处的 send
    //     跟池共用连接，能不能立刻进流取决于池那一刻在不在阻塞里。）
    // ══════════════════════════════════════════════════════════════
    const sender = q.createClient();
    const S3 = 'work:eval';
    await redis.del(S3, REPLY);
    let stopCalls = 0;
    const p3 = startPool(redis, {
      type: 'eval', concurrency: 1, onLog: () => {},
      runner: async () => { stopCalls++; await wait(30); return { ok: true, ms: 30, output: 'S' }; },
    });
    await wait(400);                      // 让它真的进入 claimNext 的阻塞

    // ★ 阳性对照先跑：证明这条链路是通的（否则下面那个 0 什么都不证明）
    await q.send(sender, S3, { from: 'T', text: '池活着时投的', agent_type: 'eval', job_id: 'alive-x' });
    for (let i = 0; i < 30 && stopCalls === 0; i++) await wait(100);
    ok(stopCalls === 1,
      '★★ 阳性对照：池活着时投一条，runner **确实被调用** —— 下面那个 0 才有意义',
      `stopCalls=${stopCalls}`);

    // ★★★ 正题：stop() 之后投的，一条都不许被处理
    const before3 = stopCalls;
    // ★★★ **故意不 await** —— 这一行是这条断言的全部强度所在。
    //
    //   `await p3.stop()` 会等 loop 完全退出，于是「领到了但不处理」那一层
    //   **根本不会被执行到** —— 断言照样绿，而它测的是另一件事。
    //   （变异验证：撤掉 `if (stopped) break` 之后，
    //     带 await 的版本**仍然全绿**。）
    //
    //   而**现有调用方全都是 `pool.stop();` 不 await 的**（本文件别处、
    //   `bin/serve.js` 都是），所以不 await 才是要守的那个场景。
    p3.stop();
    await q.send(sender, S3, { from: 'T', text: 'stop 之后投的', agent_type: 'eval', job_id: 'after-x' });
    await wait(2000);
    ok(stopCalls === before3,
      '★★★ stop() 返回之后投的消息**一条都没被处理**（这就是那个竞态本身）',
      `stop 前 ${before3} → stop 后 ${stopCalls}`);
    // ⚠️ 已经领走的留在 PEL 不 ack —— **宁可重跑不可丢活**，不是丢弃
    ok((await redis.xlen(S3)) >= 1,
      '★★ 而那条消息还在流里（没被吞掉）—— 停止不等于丢活');

    await sender.quit();
    await redis.del(S3, REPLY);
  }

  await redis.quit();

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.message); process.exit(1); });
