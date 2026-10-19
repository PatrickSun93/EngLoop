'use strict';

/**
 * 变异 runner —— 把 `bin/next.js` 的探针那段搬到错误的位置，看测试是否必须转红。
 *
 * ⚠️ **磁盘上的 `bin/next.js` 全程一个字不动。** 源码读进内存做字符串替换，
 *   再用 `Module._compile` 在子进程里执行。改文件的做法一旦中途崩掉，
 *   会把变异版本留在磁盘上 —— 而那正是最难发现的一种污染。
 *
 * ⚠️ redis / roster 用 `require.cache` 预填的 mock 顶掉。**不是为了省事** ——
 *   这里要验的是**控制流位置**，让它去连真 redis 只会引入一个跟被测属性
 *   无关的失败源。
 *
 * 用法:
 *   node test/fixtures/probe-position-mutant-runner.js --list
 *   node test/fixtures/probe-position-mutant-runner.js none
 *   node test/fixtures/probe-position-mutant-runner.js alert-after-return
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..', '..');
const TARGET = path.join(ROOT, 'bin', 'next.js');

/**
 * 每条变异：把源码里的 `find` 换成 `replace`，模拟一个「看起来很合理」的写法。
 * ★ 表在这里是唯一出处，父测试用 `--list` 问它要，不许抄第二份。
 */
const MUTANTS = {
  none: {
    desc: '正控 —— 不改任何东西，必须绿',
    find: null,
    replace: null,
  },
  'alert-after-return': {
    desc: '★ 把探针那段挪到 timeout 的 return 之后（= dev 那个 exit(0) 陷阱的同构体）',
    // 把整段 try 块换成空，然后在 return 之后再算 —— 也就是 timeout 轮永远算不到。
    find: '    let probeAlert = null;',
    replace: '    if (messages.length === 0) {\n'
      + '      process.stdout.write(JSON.stringify({ timeout: true }) + "\\n");\n'
      + '      return;\n'
      + '    }\n'
      + '    let probeAlert = null;',
  },
  'alerts-after-messages': {
    desc: '★ 告警字段排到 messages 之后（preview 前 2048 字节里就看不见了）',
    // ⚠️ 两处一起改 —— 这条变异模拟的是「有人调整了字段顺序」，
    //   **不是「有人删掉了告警」**。删掉太好发现了；移位才是那个
    //   「字段还在、输出仍然合法、只是人永远看不见」的坏法。
    edits: [
      { find: '      ...alerts,\n      messages: brainMessages.map((m) => ({',
        replace: '      messages: brainMessages.map((m) => ({' },
      { find: '      _orchestrator_instructions: loadInstructions(),',
        replace: '      _orchestrator_instructions: loadInstructions(),\n      ...alerts,' },
    ],
  },
  'unacked-after-return': {
    desc: '★ 把「没 ack」检查挪到 timeout 的 return 之后（跟探针同一个陷阱）',
    find: '    let ackAlert = null;',
    replace: '    if (messages.length === 0) {\n'
      + '      process.stdout.write(JSON.stringify({ timeout: true }) + "\\n");\n'
      + '      return;\n'
      + '    }\n'
      + '    let ackAlert = null;',
  },
  'stale-after-return': {
    desc: '★ 把「关停指令是不是发给本会话」的判定挪到告警对象构造之后',
    // ── 这条跟上面几条的形状一样，但触发轮次相反 ────────────────────
    //   探针 / `_unacked` 那两条的陷阱在 **timeout 轮**（messages 为空）。
    //   `_stale_command` 恰好相反：**它只在有消息的轮次才可能出现**
    //   （关停指令本身就是一条消息）。
    //
    //   ⇒ 所以这条变异插的是「**有**消息就提前输出并 return」，
    //     而不是照抄上面那句 `if (messages.length === 0)`。
    //     照抄的话变异对它完全无效 —— **而测试会照样绿**，
    //     那正是「一个永远绿的变异测试」的来路。
    //
    // ★ 变异后的输出仍然是合法 JSON、仍然带着全部 messages ——
    //   **没有异常、没有红字，只是那条「不要执行这个关停指令」再也不出现。**
    find: '    let staleCommandAlert = null;',
    replace: '    if (brainMessages.length > 0) {\n'
      + '      process.stdout.write(JSON.stringify({\n'
      + '        messages: brainMessages.map((m) => ({\n'
      + '          stream_id: `${m.stream}:::${m.id}`, from: m.from, text: m.text })),\n'
      + '      }) + "\\n");\n'
      + '      return;\n'
      + '    }\n'
      + '    let staleCommandAlert = null;',
  },
  'no-harvest-ack': {
    desc: '摘走探针但不 ack —— 60 秒后 PEL 重投，探针自己变成故障',
    find: '          try { await q.ack(redis, m.stream, GROUP, [m.id]); } catch',
    replace: '          try { /* 变异：不 ack */ } catch',
  },
};

function buildMocks({ messages }) {
  const qPath = require.resolve(path.join(ROOT, 'lib', 'queue.js'));
  const rPath = require.resolve(path.join(ROOT, 'lib', 'roster.js'));
  const acked = [];
  let pendingCalls = 0;
  const fakeQ = {
    DEFAULTS: { blockMs: 1 },
    createClient: () => ({ quit: async () => {} }),
    autoclaim: async () => [],
    claimNext: async () => messages,
    ack: async (_r, stream, _g, ids) => { acked.push(`${stream}:${ids.join(',')}`); },
    send: async () => {},
    // PEL 里积压的条数。用 MUT_PENDING 注入**总数**，默认 0（= 没有欠账）。
    //
    // ⚠️ 只在**第一条流**上返回，其余返回 0 —— next.js 会遍历 STREAMS
    //   （orch:in:human + orch:in:agent）累加。让每条流都返回同一个数，
    //   总数会翻倍，**而那是 mock 造出来的分布，不是真实的**：
    //   真实里一条消息只躺在它自己那条流的 PEL 里。
    //   （每条流都返回同一个数的话，「3 条」会测出来是 6 条。）
    pending: async () => {
      const n = pendingCalls === 0 ? Number(process.env.MUT_PENDING || 0) : 0;
      pendingCalls += 1;
      return { count: n, consumers: [] };
    },
  };
  const fakeRoster = {
    TTL_SEC: 900,
    groupFor: () => 'orch',
    inboxFor: (n) => `agent:${n}:in`,
    heartbeat: async () => 'ok',
  };
  require.cache[qPath] = { id: qPath, filename: qPath, loaded: true, exports: fakeQ };
  require.cache[rPath] = { id: rPath, filename: rPath, loaded: true, exports: fakeRoster };
  return { acked };
}

async function run(id) {
  const m = MUTANTS[id];
  if (!m) { console.error(`未知变异: ${id}`); process.exit(2); }

  let src = fs.readFileSync(TARGET, 'utf8');
  // 单处写 find/replace，多处写 edits —— 两种形式在这里归一，下面只有一条路径。
  const edits = m.edits || (m.find ? [{ find: m.find, replace: m.replace }] : []);
  for (const e of edits) {
    if (!src.includes(e.find)) {
      // ★ 锚点找不到必须**大声失败**，不能当成「变异没生效但测试还是绿的」——
      //   那会让整个变异测试静默退化成摆设，而**一个永远绿的变异测试
      //   比没有变异测试更危险**：它还在为那份自信背书。
      console.error(`ANCHOR_MISSING: 变异 ${id} 的锚点在 bin/next.js 里找不到了。`);
      console.error(`  锚点: ${JSON.stringify(e.find.slice(0, 60))}…`);
      console.error('  ⇒ 源码改过，这条变异已失效。修锚点，别删这条。');
      process.exit(3);
    }
    src = src.replace(e.find, e.replace);
  }

  const { acked } = buildMocks({ messages: JSON.parse(process.env.MUT_MESSAGES || '[]') });

  // ⚠️ 顶掉 argv 里的 agent 名 —— 不然 next.js 默认叫 JARVIS，
  //   补发探针时会写进**生产 outbox**，relay 真的会把它发出去。
  //   一个为了验证而产生真实副作用的测试，比没有测试更糟。
  process.argv = [process.argv[0], TARGET, '--name', 'MUTTEST'];

  const out = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };

  const mod = new Module(TARGET, null);
  mod.filename = TARGET;
  mod.paths = Module._nodeModulePaths(path.dirname(TARGET));
  try {
    mod._compile(src, TARGET);
  } catch (err) {
    process.stdout.write = origWrite;
    console.error('COMPILE_ERROR', err.message);
    process.exit(4);
  }
  // main() 是异步的，等它把 stdout 写完
  await new Promise((r) => setTimeout(r, 150));
  process.stdout.write = origWrite;

  console.log(JSON.stringify({ stdout: out.join(''), acked }));
}

if (process.argv.includes('--list')) {
  const list = {};
  for (const [k, v] of Object.entries(MUTANTS)) list[k] = v.desc;
  console.log(JSON.stringify(list, null, 2));
} else {
  run(process.argv[2] || 'none');
}
