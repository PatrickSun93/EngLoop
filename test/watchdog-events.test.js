'use strict';

/**
 * watchdog 的结构化事件出口（`onEvent`）。
 *
 * ── 它治的是什么 ────────────────────────────────────────────────
 * 没有它的话 watchdog 说的话**只有 console 一个去处**，而 bus 是 detached
 * spawn 起来的 —— 那个 console 进了一个没人看的日志文件。
 * 于是除了够到 alert 档位走 q.send 的那几条，**watchdog 的每一次判定人都收不到**。
 * 中间那几档（busy / warn / heartbeat_lost / 冷却中没动手）恰恰是
 * 「现在该不该管它」最需要人来判断的时候。
 *
 * ── 这个文件里最重要的一条 ──────────────────────────────────────
 * **`deaf` 和 `heartbeat_lost` 必须是两个不同的 level。**
 * 它们的处置**完全相反**：前者要推恢复指令，后者明确**不能**推
 * （它没停，推它只会掩盖「心跳为什么没写进去」那个真 bug）。
 * 把它们压成一档「告警」，人就会对着一个正在正常轮询的 agent 动手 ——
 * 给它连发恢复指令。
 *
 * ⚠️ 这里测的是 `act()` 和 `start()` 的**行为**，接线（serve.js 有没有
 *    真的把 onEvent 接到 broadcast 上）在文件末尾用源码断言守 ——
 *    bin/ 的入口脚本没法被 require，那是这个项目一贯的做法。
 */

const fs = require('node:fs');
const path = require('node:path');
const q = require('../lib/queue');
const roster = require('../lib/roster');
const watchdog = require('../lib/watchdog');

const OUT_T = 'engloop:wdevt:out';
const S = 'engloop:wdevt:in';

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const fakeTmux = {
  list: async () => [],
  exists: async () => true,
  nudge: async () => {},
  submit: async () => {},
};

/** 跑一次 act，把事件收进数组。冷却 key 先清掉，除非 keepCooldown。 */
async function runAct(redis, findings, { keepCooldown = false, tmuxApi = fakeTmux } = {}) {
  if (!keepCooldown) {
    for (const f of findings) {
      for (const kind of ['deaf', 'heartbeat_lost', 'nudge', 'zero_sessions', 'blind']) {
        await redis.del(watchdog.COOLDOWN_KEY(kind, f.name));
      }
    }
  }
  const events = [];
  await watchdog.act(redis, findings, {
    onLog: () => {}, onEvent: (e) => events.push(e), outStream: OUT_T, tmuxApi,
  });
  return events;
}

const finding = (over) => ({
  name: 'evtcrew', type: 'dev', tmux_session: 'agent_evtcrew',
  stream: S, group: 'agent:evtcrew', idleMs: 1_000, pending: 0, ...over,
});

async function main() {
  const redis = q.createClient();
  await redis.del(S, OUT_T);

  console.log('\n【1】★★ deaf 和 heartbeat_lost 是两个 level —— 处置完全相反');
  {
    const deafEv = await runAct(redis, [finding({ level: 'deaf', idleMs: 1_000_000 })]);
    const hbEv = await runAct(redis, [finding({ level: 'heartbeat_lost', idleMs: 430_000 })]);

    ok(deafEv.length === 1 && hbEv.length === 1, '两种各发一条事件',
      `deaf=${deafEv.length} hb=${hbEv.length}`);
    ok(deafEv[0]?.level === 'deaf', 'deaf 的 level 是 deaf', `实际 ${deafEv[0]?.level}`);
    ok(hbEv[0]?.level === 'heartbeat_lost',
      'heartbeat_lost 的 level 是 heartbeat_lost', `实际 ${hbEv[0]?.level}`);
    ok(deafEv[0]?.level !== hbEv[0]?.level,
      '★★ 两者的 level 不同 —— 界面把它们画成同一种红，人就会对一个正在轮询的 agent 动手');

    // ★ level 不同还不够：**动作也必须不同**，否则「分了两档」只是个标签。
    ok(deafEv[0]?.action === 'submit',
      '★★ deaf → action=submit（真的推了恢复指令）', `实际 ${deafEv[0]?.action}`);
    ok(hbEv[0]?.action === 'report',
      '★★ heartbeat_lost → action=report（只报给人，**没推**）', `实际 ${hbEv[0]?.action}`);
    ok(/未推送恢复指令/.test(hbEv[0]?.text || ''),
      '★★ 而且文本里明说了「未推送恢复指令」—— 人看到「不在花名册」会想去救它，而救它正是错的',
      JSON.stringify(hbEv[0]?.text));

    // ── ★★ **「我没救它」不等于告诉他「他也不该救」** ─────────────
    // 前一句诚实地陈述了 watchdog 做了什么。但读的人下一步要做的判断是
    // 「那我要不要动手」—— 那个问题上一句答不了，**于是他会自己填一个**，
    // 而他填的默认答案（去救它）正好是错的。
    ok(/你也不用去救它|不用去救/.test(hbEv[0]?.text || ''),
      '★★ 明确对**人**说「你也不用去救它」—— 光说「我没推」，人会自己动手',
      JSON.stringify(hbEv[0]?.text));
    ok(/心跳为什么没写进去/.test(hbEv[0]?.text || ''),
      '★★ 并指出真正该查的东西 —— 否则这条告警只是「别管它」，不是一个可行动的信号',
      JSON.stringify(hbEv[0]?.text));
    ok(/消息，非 ESC/.test(deafEv[0]?.text || ''),
      '★ deaf 的文本说清推的是哪一种（对失聪发 ESC 是 W2 修掉的旧错法）',
      JSON.stringify(deafEv[0]?.text));
  }

  console.log('\n【2】★ 每条事件都带时间戳 —— 少了它就没法跟发言交织排序');
  {
    const ev = (await runAct(redis, [finding({ level: 'deaf' })]))[0];
    ok(typeof ev?.at === 'string' && !Number.isNaN(Date.parse(ev.at)),
      '★ at 是可解析的时间戳', JSON.stringify(ev?.at));
    ok(ev?.type === 'watchdog',
      '★★ type 是字面值 `watchdog` —— 前端 switch 的路由键，改一个字全部事件消失',
      `实际 ${ev?.type}`);
    ok(ev?.name === 'evtcrew', '带 agent 名');
    ok(ev?.tmux_session === 'agent_evtcrew', '带会话名（恢复命令要用它）');
    ok(typeof ev?.text === 'string' && ev.text.length > 10, '带一句人话');

    // ★ 时序是原型第三个设计决定的全部依据：「dev3 那条恢复指令，正是紧接在
    //   它停止发言之后」—— 没有时间戳就交织不出这个因果。
    const t = Date.parse(ev.at);
    ok(Math.abs(Date.now() - t) < 10_000, '★ 时间戳是本轮的，不是某个固定值');
  }

  console.log('\n【3】★ 冷却中**照发**事件，只标 throttled');
  {
    const f = [finding({ level: 'deaf', idleMs: 1_000_000 })];
    const first = await runAct(redis, f);                       // 清冷却，第一次
    const second = await runAct(redis, f, { keepCooldown: true }); // 冷却仍在

    ok(first[0]?.throttled === false, '（前置）第一次没被节流');
    ok(second.length === 1,
      '★★ 冷却中仍然发事件 —— 不发的话「这轮判定它仍失聪」和「这轮没检查」在界面上同形',
      `实际发了 ${second.length} 条`);
    ok(second[0]?.throttled === true,
      '★ 但标了 throttled=true', JSON.stringify(second[0]));
    ok(second[0]?.action === 'none',
      '★★ 而且 action 是 none —— 判定成立 ≠ 动手了，压成一条会让人以为已经推过',
      `实际 ${second[0]?.action}`);
    ok(second[0]?.level === 'deaf', '★ level 不因节流而改变（它仍然是失聪）');
  }

  console.log('\n【4】★ ok / unknown 不发事件（唯一一处替界面做的减法）');
  {
    const ev = await runAct(redis, [
      finding({ level: 'ok' }), finding({ level: 'unknown', idleMs: null }),
    ]);
    ok(ev.length === 0,
      '★ 正常状态不进对话流 —— 每 60 秒 N 条「一切正常」会把因果线索冲掉',
      JSON.stringify(ev));

    // ★ 阴性对照：缺了它，一个「什么都不发」的实现也能让上面这条绿。
    const ev2 = await runAct(redis, [finding({ level: 'warn', idleMs: 900_000 })]);
    ok(ev2.length === 1 && ev2[0].level === 'warn',
      '★ （阴性对照）warn 照发 —— 它还没到动手档位，但值得被看见',
      JSON.stringify(ev2));
  }

  console.log('\n【4b】★★ type 是路由键，判定放 level —— 每一档都不许把分支名写进 type');
  {
    // ── 这是跟前端的契约，不是风格 ──────────────────────────────────
    // 前端 `route()` 是一个 `switch (m.type)`，认不出的落到「未识别的事件」。
    // 所以哪怕只有一档把 `type` 写成分支名（`deaf_detected` 之类），
    // **那一档就会在界面上彻底消失，而后端这边毫无察觉** ——
    // `onEvent:(e)=>broadcast(e)` 原样透传，没有任何东西会报错。
    //
    // ⚠️⚠️ **这一节同时是那个字面值的唯一权威。**
    //   后端和前端各自「按对方改」时，两条消息在队列里交错，
    //   **结果是两边永远相反，且两边各自都认为已经对齐了。**
    //   钉在这里之后，改它的门槛变成「先改这条断言」——
    //   **一个值由两个人分别改，就是上面那个形状。**
    //
    // ⚠️ 逐档验，不是抽查一档：出口是一档一档接上的，漏一档的形状就长这样。
    const TYPE = 'watchdog';
    const all = [
      finding({ level: 'deaf', idleMs: 1_000_000 }),
      finding({ level: 'heartbeat_lost', idleMs: 430_000 }),
      finding({ level: 'stale' }),
      finding({ level: 'probe_failed', probe_error: 'boom' }),
      finding({ level: 'warn', idleMs: 900_000 }),
      finding({ level: 'busy', idleMs: 1_300_000, outboxIdleMs: 42_000 }),
      finding({ level: 'nudge', idleMs: 1_300_000 }),
      finding({ level: 'alert', idleMs: 1_900_000, pending: 3 }),
      finding({ name: 'watchdog', level: 'zero_sessions', sessionsSeen: 0 }),
    ];
    const evs = [];
    for (const f of all) evs.push(...await runAct(redis, [f]));

    ok(evs.length === all.length, `（前置）${all.length} 档各发了一条`, `实际 ${evs.length}`);
    const wrong = evs.filter((e) => e.type !== TYPE);
    ok(wrong.length === 0,
      `★★ **每一档**的 type 都是 \`${TYPE}\` —— 漏一档，那一档在界面上就彻底消失`,
      `不合格的：${JSON.stringify(wrong.map((e) => ({ level: e.level, type: e.type })))}`);
    // ★ 把实际值打出来 —— 前端那边要对齐时，看这一行就够，不用来回问。
    console.log(`     └─ 契约字面值：type === ${JSON.stringify(TYPE)}（前端 switch 的 case）`);
    ok(new Set(evs.map((e) => e.level)).size === all.length,
      '★★ 而**判定各不相同地留在 level 里** —— 缺了这条，一个「type 和 level 都写死」的实现也能过上面那条',
      JSON.stringify(evs.map((e) => e.level)));
  }

  console.log('\n【5】★ 每一个会动手/会记一笔的档位都有出口，一个都不许静默');
  {
    // ── 为什么要逐档验 ──────────────────────────────────────────────
    // 加一个出口很容易只接上最显眼的那两档（deaf / alert），
    // 而**中间那几档才是这次要救的东西** —— 它们以前只存在于没人看的日志里。
    const cases = [
      ['stale', finding({ level: 'stale' }), 'unregister'],
      ['probe_failed', finding({ level: 'probe_failed', probe_error: 'boom' }), 'none'],
      ['warn', finding({ level: 'warn', idleMs: 900_000 }), 'none'],
      ['busy', finding({ level: 'busy', idleMs: 1_300_000, outboxIdleMs: 42_000 }), 'none'],
      ['nudge', finding({ level: 'nudge', idleMs: 1_300_000 }), 'esc'],
      ['alert', finding({ level: 'alert', idleMs: 1_900_000, pending: 3 }), 'report'],
      ['zero_sessions', finding({ name: 'watchdog', level: 'zero_sessions', sessionsSeen: 0 }), 'report'],
    ];
    for (const [label, f, expectAction] of cases) {
      const ev = await runAct(redis, [f]);
      ok(ev.length === 1, `★ ${label} 发了事件`, JSON.stringify(ev));
      ok(ev[0]?.level === label, `★ ${label} 的 level 原样带出去`, `实际 ${ev[0]?.level}`);
      ok(ev[0]?.action === expectAction,
        `★ ${label} → action=${expectAction}`, `实际 ${ev[0]?.action}`);
    }
  }

  console.log('\n【6】★ busy 事件要带 outbox_idle_ms —— 那是「忙 vs 聋」的唯一证据');
  {
    const ev = (await runAct(redis, [
      finding({ level: 'busy', idleMs: 1_300_000, outboxIdleMs: 42_000 }),
    ]))[0];
    ok(ev?.outbox_idle_ms === 42_000,
      '★ 带上了 outbox_idle_ms —— 人得自己看得见「idle 大」到底是聋还是忙',
      JSON.stringify(ev));
    ok(ev?.idle_ms === 1_300_000, '★ 也带 idle_ms（两个数并排才判断得了）');

    // Infinity 不是合法 JSON —— 跟 buildAgentsPayload 一样显式转 null。
    const ev2 = (await runAct(redis, [
      finding({ level: 'nudge', idleMs: 1_300_000, outboxIdleMs: Infinity }),
    ]))[0];
    ok(ev2?.outbox_idle_ms === null,
      '★ 从没有过 outbox 活动 → null，不是 Infinity（后者 JSON.stringify 会静默变 null）',
      JSON.stringify(ev2));
  }

  console.log('\n【7】★ onEvent 抛异常不能把这一轮判定带走');
  {
    // watchdog 是最后一道防线。一个写坏的输出口不该让它停止工作 ——
    // 而它停止工作的现场跟「一切正常」完全一样。
    const seen = [];
    await watchdog.act(redis, [
      finding({ name: 'boom1', level: 'warn', idleMs: 900_000 }),
      finding({ name: 'boom2', level: 'warn', idleMs: 900_000 }),
    ], {
      onLog: (m) => seen.push(m),
      onEvent: () => { throw new Error('回调坏了'); },
      outStream: OUT_T, tmuxApi: fakeTmux,
    });
    ok(seen.some((m) => /onEvent 回调抛异常/.test(m)),
      '★ 回调抛异常被接住并记了一笔（不是静默吞掉）', JSON.stringify(seen));
    ok(seen.filter((m) => /onEvent 回调抛异常/.test(m)).length === 2,
      '★★ 第一个 finding 的回调炸了，第二个照样被处理 —— 判定没被输出口带走',
      JSON.stringify(seen));
  }

  console.log('\n【8】★★ watchdog 自己瞎了也要出声 —— 这是最该发的那条');
  {
    // ── 为什么它比别的都重要 ────────────────────────────────────────
    // watchdog 瞎了的现场跟「一切正常」完全一样：没有告警、页面三格全空。
    // **如果只有正常判定推得出事件、而「我瞎了」推不出，那界面上的安静
    // 就同时代表两件相反的事。**
    await redis.del(watchdog.COOLDOWN_KEY('blind', 'watchdog'), OUT_T);
    const blindTmux = {
      ...fakeTmux,
      list: async () => {
        throw Object.assign(new Error('看不到 tmux 会话列表'), { code: 'TMUX_UNAVAILABLE' });
      },
    };
    const events = [];
    const wd = watchdog.start(redis, {
      intervalMs: 3_600_000, onLog: () => {},
      onEvent: (e) => events.push(e), outStream: OUT_T, tmuxApi: blindTmux,
    });
    await wd.tick();
    wd.stop();

    const blind = events.filter((e) => e.level === 'blind');
    ok(blind.length >= 1, '★★ 检查失败时发了 level=blind 的事件', JSON.stringify(events));
    ok(/看不见/.test(blind[0]?.text || ''),
      '★★ 文本说的是「我看不见有没有 agent 出问题」，不是「没有 agent 出问题」',
      JSON.stringify(blind[0]?.text));
    ok(blind[0]?.action === 'report' || blind[0]?.action === 'none',
      'action 是 report 或 none', `实际 ${blind[0]?.action}`);
    ok(typeof blind[0]?.at === 'string', '带时间戳');
    ok(blind[0]?.type === 'watchdog',
      '★★ 它走的是 start() 里另一条独立的发送路径 —— type 同样得是 `watchdog`',
      `实际 ${blind[0]?.type}`);

    // ★ 再跑一轮：冷却拦住了「报给人」，但事件照发（标 throttled）。
    const events2 = [];
    const wd2 = watchdog.start(redis, {
      intervalMs: 3_600_000, onLog: () => {},
      onEvent: (e) => events2.push(e), outStream: OUT_T, tmuxApi: blindTmux,
    });
    await wd2.tick();
    wd2.stop();
    const blind2 = events2.filter((e) => e.level === 'blind');
    ok(blind2.length >= 1,
      '★★ 第二轮仍然发事件 —— 持续瞎着的时候界面不该恢复安静',
      JSON.stringify(events2));
    ok(blind2[0]?.throttled === true,
      '★ 但标了 throttled（给人的那条被冷却拦住了）', JSON.stringify(blind2[0]));
  }

  console.log('\n【8b】★★ 编排者失聪的告警：打破「安静 = 没事」那个同形');
  {
    // ── 为什么这一套必须跟 agent 那套分开 ────────────────────────────
    // **编排者失聪是这个系统里唯一一种「没有任何人能发现」的故障**：
    //
    // > JARVIS 失聪 → 网页没有新消息 → 而「没有新消息」跟「大家都没事」
    // > 长得一模一样。而唯一的发现者（人）恰好是通过它才能看到东西的。
    //
    // 这条告警的**全部价值在于打破那个同形** —— 它是「有新东西出现」，
    // 而失聪的表现是「没有东西出现」。
    const orch = watchdog.deafAlertText({
      name: 'JARVIS', type: 'orchestrator', tmux_session: 'orch',
    });
    const crew = watchdog.deafAlertText({
      name: 'dev', type: 'dev', tmux_session: 'agent_dev',
    });

    ok(orch !== crew, '★★ 两种 type 生成不同的话 —— 它们对人的含义完全不同');
    ok(/安静是假的/.test(orch),
      '★★ 编排者那套点破「你现在看到的安静是假的」—— 这是它存在的全部理由',
      JSON.stringify(orch.slice(0, 80)));
    ok(/大家都没事/.test(orch),
      '★★ 而且点名了那个会被误读成的意思，不是泛泛说「出问题了」');

    // ★★ 旧的通用文案对编排者说了一件**不成立**的事：
    //   「发给它的消息会被当成『发给人』投进 orch:out，可能出现在你这里」——
    //   人发给编排者的消息进 `orch:in:human`，**没有人消费，不会出现在 orch:out**。
    //   照着那句话找，人会去一个不会有东西的地方等。
    ok(!/出现在你这里/.test(orch),
      '★★ 编排者那套**不再说**「会出现在你这里」—— 那对编排者不成立，'
      + '会把人指向一个不会有东西的地方',
      JSON.stringify(orch));
    ok(/orch:in:human/.test(orch) && /没有丢/.test(orch),
      '★★ 而是说清消息实际在哪（堆在 orch:in:human）、没丢、但没人读',
      JSON.stringify(orch));

    // ★ 两套都以「下一步做什么」收尾，不是以诊断收尾。
    ok(/orch-start/.test(orch),
      '★ 编排者那套给出可直接跑的重启命令', JSON.stringify(orch.slice(-120)));
    ok(/tmux has-session/.test(orch),
      '★ 而且先给一个更便宜的动作（确认会话还在），不是一上来就重启');
    ok(/agent-start/.test(crew) && /dev/.test(crew),
      '★ agent 那套给的是 agent-start，且点名了是哪个 agent', JSON.stringify(crew.slice(-120)));

    // ★ 阴性对照：agent 那套**保留**「出现在你这里」—— 对它是成立的
    //   （agent 掉册时，别人发给它的消息经 relay 的 resolveTarget 会被当成人）。
    //   缺了这条，一个「两套都删掉那句」的实现也能过上面那条。
    ok(/出现在你这里/.test(crew),
      '★★ （阴性对照）agent 那套保留那句 —— 对 agent 它是成立的，删掉就丢了一条真信息',
      JSON.stringify(crew));

    // ★ 接线：deaf 分支真的用了这个函数，而不是内联又写了一遍。
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'watchdog.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(/text:\s*deafAlertText\(f\)/.test(code),
      '★★ deaf 分支真的调它 —— 内联重写一份的话，这个函数测得再全也没用',
      (code.match(/.*deafAlertText.*/g) || []).join(' | '));
  }

  console.log('\n【9】★ 接线：serve.js 真的把 onEvent 接到了 broadcast 上');
  {
    // 这个项目栽过六次「写了但没接线」。lib 层全绿而那根线是断的时候，
    // 上面每一条都照样通过。
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'serve.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    const startCall = code.slice(code.indexOf('watchdog.start('));
    ok(startCall.length > 50, '（前置）切到了 watchdog.start 的调用',
      `indexOf=${code.indexOf('watchdog.start(')}`);
    ok(/onEvent\s*:/.test(startCall.slice(0, 300)),
      '★★ watchdog.start 真的传了 onEvent —— 没传的话事件出口存在但没人接',
      startCall.slice(0, 200));
    ok(/onEvent\s*:\s*\(?\s*e\s*\)?\s*=>\s*broadcast\(/.test(startCall.slice(0, 300)),
      '★★ 而且接的是 broadcast（推给浏览器），不是又一个 console.log',
      startCall.slice(0, 200));
  }

  await redis.del(S, OUT_T);
  await roster.unregister(redis, 'evtcrew').catch(() => {});
  await redis.quit();
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
