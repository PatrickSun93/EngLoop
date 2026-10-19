'use strict';

/**
 * 变异跑手 —— 把 `lib/rooms.js` 的某一处判据**故意弄坏**，再跑
 * `test/rooms-flow.test.js`，看它红不红。
 *
 * ★★ 为什么要有这个东西 ────────────────────────────────────────────
 * 「74 条断言全绿」证明不了断言有用。一份把 `flowStatus` 写成
 * `return {state: null}` 的空实现，也可以全绿 —— 只要断言本身写松了。
 * **能证明断言有用的，只有「把被测的东西弄坏，它必须红」。**
 *
 * ★ 而且不只看「红了」，还要看**红在哪一条**（父测试 grep `✗` 行）——
 *   一个拼写错误也能让整份测试红，那种红什么都没证明。
 *
 * ⚠️ **磁盘上的 `lib/rooms.js` 一个字都不动。** 变异后的源码用
 *   `Module._compile` 塞进 require.cache，只活在这个子进程里。
 *   （直接改文件再改回来的话，中间那几秒别人跑全量就会被误伤，
 *   而且这个进程要是崩在中间，坏代码就留在磁盘上了。）
 *
 * ⚠️ 放在 `test/fixtures/` 下是**故意的**：`lib/queue.js` 的测试库判定是
 *   「入口路径在 test/ 下（含子目录）」，所以子进程照样连测试库、不碰 db 0。
 *
 * 用法：`node test/fixtures/rooms-flow-mutant-runner.js <变异名>`
 *       变异名见下面 MUTANTS；`none` 是不变异的正控。
 */

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const ROOMS = path.resolve(__dirname, '..', '..', 'lib', 'rooms.js');

/** 被变异折磨的两份测试。`test` 字段选一个，默认 flow。 */
const TESTS = {
  flow: path.resolve(__dirname, '..', 'rooms-flow.test.js'),
  gate: path.resolve(__dirname, '..', 'rooms-gate.test.js'),
  advance: path.resolve(__dirname, '..', 'rooms-advance.test.js'),
  http: path.resolve(__dirname, '..', 'rooms-http.test.js'),
};

/**
 * 每条变异都写清**弄坏了什么**、以及**期望哪条断言接住它**。
 * 期望值由父测试 `rooms-flow-mutation.test.js` 校验，两边共用这张表。
 *
 * ★ `expectFail: null` = 正控，期望**绿**。每份测试都要有一个自己的正控 ——
 *   否则那份测试的红只能证明「注入机制坏了」，证不了断言有分辨力。
 */
const MUTANTS = {
  // ★ 正控：什么都不改。它必须**绿** —— 否则下面那些红说明的是
  //   「注入机制坏了」，而不是「断言有分辨力」。
  none: {
    what: '不变异（正控 · flow）',
    from: "'use strict';",
    to: "'use strict';",
    expectFail: null,
  },

  'none-gate': {
    what: '不变异（正控 · gate）',
    test: 'gate',
    from: "'use strict';",
    to: "'use strict';",
    expectFail: null,
  },

  'none-advance': {
    what: '不变异（正控 · advance）',
    test: 'advance',
    from: "'use strict';",
    to: "'use strict';",
    expectFail: null,
  },

  // ── 推进（advance）：唯一会写状态、唯一会发消息的地方 ──────────────────────
  // ⚠️⚠️ **这套跑手证明不了「源码断言」的分辨力** ────────────────────
  //   变异后的源码只活在 require.cache 里，**磁盘上的 lib/rooms.js 一个字没动**
  //   —— 而源码断言（rooms-advance.test.js【2】）读的正是磁盘文件。
  //   所以这条变异红的是**行为**断言（时间戳没跟着换），源码断言照样绿。
  //
  //   ★ 这是工具**说不出**的那一部分，跟 require-probe 只看得见主进程一样，
  //     必须写出来 —— 否则「变异全过」会被读成「源码断言也验过了」。
  //     源码断言的分辨力由它自己那一节的**假源码自检**负责。
  'adv-enterstage-bypass': {
    what: '绕过 enterStage，逐个赋值 stage/assignee（时间戳就丢了）',
    test: 'advance',
    from: '  Object.assign(meta, enterStage(meta, { stage: nextName }));',
    to: '  meta.stage = nextName; meta.assignee = nextRole;',
    expectFail: 'stage_entered_at 跟着换了',
  },

  'adv-no-roster-check': {
    what: '不核对下一个角色在不在花名册里',
    test: 'advance',
    from: '    if (!registry.some((a) => a.name === nextRole)) {',
    to: '    if (false) {',
    expectFail: '说得出缺的是谁',
  },

  // ★ 「查不了」被当成「都在」
  'adv-roster-fail-open': {
    what: '花名册查不了时假装都在（fail-open）',
    test: 'advance',
    from: '    const registry = await roster.list(redis).catch(() => null);',
    to: "    const registry = await roster.list(redis).catch(() => [{ name: 'arch' }, { name: 'senior' }, { name: 'test' }]);",
    expectFail: '查不了就不推进',
  },

  'adv-reject-ignored': {
    what: '无视「打回」判决，一律走下一个阶段',
    test: 'advance',
    // ⚠️ 锚点要跟着源码走（这行带着 `!starting &&`）。对不上时**会 exit 3** ——
    //    不会静默变成 no-op，而是明说「这条已经不再变异任何东西了」。
    from: '  const rejected = !starting && !!(Array.isArray(cur.verdict) && def.reject_verdict',
    to: '  const rejected = false && !!(Array.isArray(cur.verdict) && def.reject_verdict',
    expectFail: '判决「打回」→ 退回 spec',
  },

  'adv-broadcast-wants-reply': {
    what: '广播那条也要求回复（自激的入口）',
    test: 'advance',
    from: '    expects_reply: false,',
    to: '    expects_reply: true,',
    expectFail: '没有人动手',
  },

  // ★ 把 false 写成字符串 —— `'false'` 是 truthy，会引发广播风暴
  'adv-post-false-string': {
    what: "post 把 expects_reply 写成字符串（含 'false'）",
    test: 'advance',
    from: "    ...(expects_reply === true ? ['expects_reply', 'true'] : []),",
    to: "    'expects_reply', String(expects_reply === true),",
    expectFail: '根本没有这个字段',
  },

  'adv-no-rework-word': {
    what: '打回时点名说「开始」而不是「重做」',
    test: 'advance',
    from: "    const verb = rejected ? '**重做**' : '开始';",
    to: "    const verb = '开始';",
    expectFail: '说的是「重做」不是「新活」',
  },

  // ── 阶段判据 ────────────────────────────────────────────
  //
  // ★★ 头一条：**把判据改成只看文件在不在，必须红。**
  //    「3 字节的 DESIGN.md 也满足存在且非空」——
  //    只有这条变异能证明判据不止看存在。
  'gate-exists-only': {
    what: '判据退化成「只查存在 + 非空」，不查小节结构',
    test: 'gate',
    from: '  const { missing, empty } = checkSections(text, requires);',
    to: '  const { missing, empty } = { missing: [], empty: [] };',
    expectFail: '而 stageGate 拒绝它',
  },

  'gate-no-empty-check': {
    what: '查小节标题在不在，但不查小节下面有没有正文',
    test: 'gate',
    from: '    if (!sectionBody(doc, head).some((l) => l.trim().length > 0)) empty.push(req);',
    to: '    /* mutant: 不查空小节 */',
    expectFail: '三个小节都只有标题',
  },

  'gate-no-fence': {
    what: 'headingsOf 不管代码围栏（围栏里的 # 也当标题）',
    test: 'gate',
    from: "    if (/^(```|~~~)/.test(t)) { inFence = !inFence; return; }",
    to: '    /* mutant: 不管围栏 */',
    expectFail: '判三节全缺',
  },

  'gate-verdict-fulltext': {
    what: '判决词在**全文**里找，而不是只在判决小节里找',
    test: 'gate',
    from: "  const body = sectionBody(doc, head).join('\\n');",
    to: '  const body = String(text);',
    expectFail: '正文里的「打回」不算数',
  },

  'none-http': {
    what: '不变异（正控 · http）',
    test: 'http',
    from: "'use strict';",
    to: "'use strict';",
    expectFail: null,
  },

  // ── HTTP 入口 ──────────────────────────────────────────────
  //
  // ★ 这几条守的是**状态码**和**绑定三步的顺序**。端点的价值全在这上面，
  //   而它们恰好是「行为看起来正常、只有码不对」的那一类。
  'http-no-role-check': {
    what: '绑流程时不校验角色在不在花名册里',
    test: 'http',
    from: '  await checkRoles(redis, def);                        // ① 角色',
    to: '  /* mutant: 不校验角色 */',
    expectFail: '409（不是 200 先绑上再说）',
  },

  'http-roster-fail-open': {
    what: 'checkRoles 里花名册查不了时当成空册（503 会变成 409）',
    test: 'http',
    from: '  const registry = await roster.list(redis).catch(() => null);',
    to: '  const registry = await roster.list(redis).catch(() => []);',
    expectFail: '查不了 → 503',
  },

  'http-no-mkdir': {
    what: '绑流程时不建产出目录',
    test: 'http',
    from: '  try { fs.mkdirSync(abs, { recursive: true }); }      // ② 目录',
    to: '  try { /* mutant: 不建目录 */ }',
    expectFail: '目录**真的建出来了**',
  },

  'http-allow-rebind': {
    what: '允许给已经绑过流程的房间改绑',
    test: 'http',
    from: '  if (meta.flow !== null) {',
    to: '  if (false) {',
    expectFail: '改绑 → 409',
  },

  // ★ 「它还在干」被做成 4xx —— 界面会把「还没写完」显示成红色故障
  'http-advance-4xx': {
    what: 'advanced:false 时返回 409 而不是 200',
    test: 'http',
    from: '    try { res.json(await advance(redis, req.params.hash)); }',
    to: '    try { const rr = await advance(redis, req.params.hash); res.status(rr.advanced ? 200 : 409).json(rr); }',
    expectFail: '「它还在干」是正常状态',
  },

  // ★ 少了「启动」那一格：绑完之后永远没有人被点名，而且不报错
  'http-no-start': {
    what: 'advance 不处理 not_started（流程起不来）',
    test: 'http',
    from: '  const starting = g.state === FLOW_STATE.NOT_STARTED;',
    to: '  const starting = false;',
    expectFail: '打一次 advance 就**启动**了',
  },

  // ── 「这份产出是不是这一轮的」──────────────────────────────────────
  //
  // ★★ 不做这条比对的后果不是「判错一次」，是**流程自己转圈**：
  //    打回 → 旧产出还在且结构完整 → 判据放行 → 又推回去。
  //    每一步看起来都对，没有任何一处报错。
  'gate-no-stale-check': {
    what: '去掉 mtime 比对（旧产出照样算数）',
    test: 'gate',
    from: '  } else if (out.mtime_ms !== null && out.mtime_ms < sinceMs) {',
    to: '  } else if (false) {',
    expectFail: '旧产出不够格',
  },

  'gate-stale-strict': {
    what: '同毫秒算「旧」（`<=` 而不是 `<`）',
    test: 'gate',
    from: '  } else if (out.mtime_ms !== null && out.mtime_ms < sinceMs) {',
    to: '  } else if (out.mtime_ms !== null && out.mtime_ms <= sinceMs) {',
    expectFail: '同毫秒算本轮',
  },

  // ★ 判据被削弱时保持沉默 —— **在最需要提醒的那一刻最安静。**
  'gate-stale-silent': {
    what: '缺 stage_entered_at 时不自曝（悄悄退化）',
    test: 'gate',
    from: "    out.reasons.push('⚠️ 没有 stage_entered_at，**没做**「是不是本轮产出」的比对 —— '",
    to: "    if (false) out.reasons.push('⚠️ 没有 stage_entered_at，**没做**「是不是本轮产出」的比对 —— '",
    expectFail: '而且**自曝**',
  },

  'gate-empty-requires-bypass': {
    what: 'requires 为空的阶段绕过本轮比对（那条早返回是天然的绕过口）',
    test: 'gate',
    from: '    out.ok = !staleFail;',
    to: '    out.ok = true;',
    expectFail: 'requires 为空的阶段**也**逃不过本轮比对',
  },

  // ── flow_dir：**存下来的，不是算出来的** ──────────────────────────
  //
  // ★★ 这三条守的是同一句话：**从可变的东西推导标识符，将来一定会分叉，
  //    而分叉那天不会有任何报错。** 三种「看起来更聪明」的写法各变一次。
  'gate-flowdir-fallback': {
    what: 'flowDirFor 在缺 flow_dir 时**兜底算一个**（而不是报错）',
    test: 'gate',
    from: '  const rel = meta && meta.flow_dir;',
    to: "  let rel = (meta && meta.flow_dir) || makeFlowDir((meta && meta.hash) || 'x', meta && meta.name);",
    expectFail: '不算一个出来',
  },

  'gate-flowdir-by-name': {
    what: '生成 flow_dir 时不带 room_hash，只按房间名推导',
    test: 'gate',
    from: '    flow_dir: flow_dir !== undefined ? flow_dir : (flow ? makeFlowDir(hash, name) : null),',
    to: "    flow_dir: flow_dir !== undefined ? flow_dir : (flow ? FLOWS_REL + '/' + slugify(name) : null),",
    expectFail: '两个**同名**房间目录不同',
  },

  'gate-flowdir-traversal': {
    what: 'flowDirFor 去掉路径校验（绝对路径和 .. 就通了）',
    test: 'gate',
    from: "  if (path.isAbsolute(rel) || rel.split(/[\\\\/]+/).includes('..')) {",
    to: '  if (false) {',
    expectFail: '拒绝 flow_dir=',
  },

  'gate-verdict-first': {
    what: '两个判决词同时出现时取第一个，而不是拒绝',
    test: 'gate',
    from: '  if (hit.length > 1) {',
    to: '  if (false) {',
    expectFail: '两个判决词同时出现',
  },

  'no-normalize': {
    what: 'get() 不再把老 meta 的 flow 补成 null',
    from: '  meta.flow = meta.flow ?? null;',
    to: '  /* mutant: 不归一化 flow */',
    expectFail: 'flow 读出来是 null',
  },

  'merge-noflow-done': {
    what: 'FLOW_STATE.DONE 和 NO_FLOW 合成同一个值',
    from: "  DONE: 'done',                   // 跑完了",
    to: "  DONE: 'no_flow',                  // mutant: 跟 NO_FLOW 合并",
    expectFail: '两个 state 值确实不相等',
  },

  'no-whitelist': {
    what: 'loadFlow 去掉流程名白名单（路径穿越就通了）',
    from: "!/^[A-Za-z0-9_-]+$/.test(name)",
    to: "false",
    expectFail: 'loadFlow 拒绝它',
  },

  'always-noflow': {
    what: 'flowStatus 无视 meta，一律返回 no_flow（「永远返回同一个东西」的空实现）',
    from: '  if (meta.flow === null) {',
    to: '  if (true) {',
    expectFail: '两者 state 不同',
  },
};

const id = process.argv[2];

// ★ 让父测试拿到**同一张表**，而不是自己抄一份期望值 ——
//   抄的那天两边会分叉，症状是「变异测试绿着，测的却是旧判据」。
if (id === '--list') { process.stdout.write(JSON.stringify(MUTANTS)); process.exit(0); }

const m = MUTANTS[id];
if (!m) {
  console.error(`未知变异 "${id}"。可选：${Object.keys(MUTANTS).join(' / ')}`);
  process.exit(2);
}

const src = fs.readFileSync(ROOMS, 'utf8');

// ★★ 锚点必须存在，否则**这条变异已经失效了**。
//   少了这一步，lib/rooms.js 一改，替换就变成 no-op —— 于是变异跑手报告
//   「测试没红」，人会去查测试，而真相是变异根本没发生。
//   **一个悄悄不再变异的变异测试，比没有更坏。**
if (!src.includes(m.from)) {
  console.error(`✗ 变异锚点找不到：${JSON.stringify(m.from)}`);
  console.error('  → lib/rooms.js 改过了，这条变异已经失效。'
    + '去 test/fixtures/rooms-flow-mutant-runner.js 里把锚点更到新代码上，'
    + '**不要**直接删掉这条 —— 它守的判据还在。');
  process.exit(3);
}

const mutated = src.split(m.from).join(m.to);

const mod = new Module(ROOMS, null);
mod.filename = ROOMS;
mod.paths = Module._nodeModulePaths(path.dirname(ROOMS));
// 先进 cache 再编译：编译过程里 require('./roster') 照常走，
// 而任何回头 require('lib/rooms') 的地方拿到的都是这份变异版。
require.cache[ROOMS] = mod;
mod._compile(mutated, ROOMS);
mod.loaded = true;   // 不设这个，Module._load 会当成「循环依赖里未完成的模块」

const target = TESTS[m.test || 'flow'];
console.log(`【变异 ${id}】${m.what}  → 跑 ${path.basename(target)}`);
require(target);
