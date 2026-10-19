'use strict';

/**
 * 长任务申报（`lib/busy.js`）—— 补 watchdog 的 outbox 判据无解的那一类。
 *
 * ── 病灶 ────────────────────────────────────────────────────────
 * watchdog 的 outbox 判据是「还在写 outbox 就是忙，不是聋」。**它对一整类情况无解**：
 * **跑单次长 Bash 调用的 agent，在调用期间没有执行权，写不了任何东西。**
 * （`lib/watchdog.js` 里那段长注释写明了这是「无解，不是覆盖不全」。）
 *
 * 例：`node test/run-all.js` 一跑几分钟，压在 NUDGE_MS 附近，
 * 跑它的 agent 会被推一把。**而测试规模还在涨。**
 *
 * ── 这个文件里最重的一条 ────────────────────────────────────────
 * **判据是 `process.kill(pid, 0)`，不是时间戳。** 标记残留时 pid 不存在，
 * 否决**自动失效** —— 不用清理、不用猜「长任务该跑多久」。
 * 猜出来的 TTL 短了误伤、长了留后门；pid 存活是**事实**。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const busy = require('../lib/busy');
const watchdog = require('../lib/watchdog');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-busy-'));

async function main() {
  console.log('\n【1】★ declare / check 的正路');
  {
    const root = tmpRoot();
    const c = busy.declare('跑全量', { root, name: 'testcrew' });
    ok(c.declared === true, '申报成功');
    ok(fs.existsSync(busy.fileFor('testcrew', root)), '标记文件真的写出来了');

    const r = busy.check('testcrew', { root });
    ok(r.busy === true, '★ check 说它在忙', JSON.stringify(r));
    ok(r.reason === 'running', 'reason=running');
    ok(r.record.what === '跑全量', '★ 带上「在跑什么」—— 人要判断放过它对不对');
    ok(r.record.pid === process.pid, '记的是这个进程的 pid');

    c.release();
    const after = busy.check('testcrew', { root });
    ok(after.busy === false && after.reason === 'no_marker',
      '★ release 之后标记没了', JSON.stringify(after));

    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('\n【2】★★ 判据是 pid 存活，不是时间戳 —— 用真进程验');
  {
    // ── 这一条是这个模块的全部价值 ──────────────────────────────────
    // 标记残留（进程崩了没删）→ pid 不存在 → **否决自动失效**。
    // 不用清理、不用猜 TTL。
    const root = tmpRoot();

    // 真起一个子进程，拿它的 pid 造一个「别人写的」标记
    const child = spawn('node', ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 150));
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(busy.fileFor('ghost', root), JSON.stringify({
      agent: 'ghost', pid: child.pid, what: '真子进程', started_at: new Date().toISOString(),
    }));

    const alive = busy.check('ghost', { root });
    ok(alive.busy === true,
      `★ 子进程活着（pid ${child.pid}）→ 判为忙`, JSON.stringify(alive));

    // ★★ 杀掉它，标记**原封不动**留在磁盘上
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    ok(fs.existsSync(busy.fileFor('ghost', root)),
      '（前置）标记文件还在 —— 这正是「残留」的现场');

    const dead = busy.check('ghost', { root });
    ok(dead.busy === false,
      '★★ 进程死了 → **否决自动失效**，不需要任何清理', JSON.stringify(dead));
    ok(dead.reason === 'pid_gone',
      '★★ 而且说得出为什么是 pid_gone，不是「没有标记」——'
      + '后者意味着没人申报过，前者意味着**有个任务异常退出了**',
      JSON.stringify(dead));

    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('\n【3】★ 兜底 max age —— 它不是判据');
  {
    const root = tmpRoot();
    fs.mkdirSync(root, { recursive: true });
    // pid 用自己的（一定活着），只把时间推老
    fs.writeFileSync(busy.fileFor('old', root), JSON.stringify({
      agent: 'old', pid: process.pid, what: 'x',
      started_at: new Date(Date.now() - busy.MAX_AGE_MS - 60_000).toISOString(),
    }));
    const r = busy.check('old', { root });
    ok(r.busy === false && r.reason === 'too_old',
      '★ 进程活着但标记太旧 → 不信（挡 pid 复用和伪造）', JSON.stringify(r));

    // ★ 阴性对照：没超上限的照常算数。缺了它，一个「永远 too_old」的实现也能过。
    fs.writeFileSync(busy.fileFor('fresh', root), JSON.stringify({
      agent: 'fresh', pid: process.pid, what: 'x',
      started_at: new Date(Date.now() - 60_000).toISOString(),
    }));
    ok(busy.check('fresh', { root }).busy === true,
      '★ （阴性对照）一分钟前申报的照常算数');

    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('\n【4】★ 坏标记不算「在忙」，而且说得出是哪种坏');
  {
    const root = tmpRoot();
    fs.mkdirSync(root, { recursive: true });

    fs.writeFileSync(busy.fileFor('bad', root), '{ 这不是 json');
    const c1 = busy.check('bad', { root });
    ok(c1.busy === false && c1.reason === 'corrupt', '★ 坏 JSON → corrupt');

    fs.writeFileSync(busy.fileFor('nopid', root), JSON.stringify({ agent: 'nopid' }));
    const c2 = busy.check('nopid', { root });
    ok(c2.busy === false && c2.reason === 'corrupt', '★ 缺 pid → corrupt');

    ok(busy.check('从来没有过', { root }).reason === 'no_marker',
      '★★ 「没有标记」跟「标记坏了」分得开 —— 压成一个布尔的话，'
      + '「它没在跑」和「标记写坏了」在日志里长得一样');

    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('\n【5】★★ 拿不到 agent 名 → 不写，但出声');
  {
    // ── 两个选项都不选，第三个成立 ──────────────────────────────────
    // 写通用名 = 给所有 agent 开后门（一个 agent 的标记保护所有人）；
    // 静默不写 = 失去保护且无人知道。
    //
    // > **「拿不到 agent 名」和「这次不是某个 agent 在跑」是同一个情形。**
    //
    // `run-all.js` 不在 tmux 里跑是完全正常的（人在自己终端跑、CI 跑），
    // 而那时候本来就不该有任何 agent 免疫 watchdog。
    const root = tmpRoot();
    const logs = [];
    const c = busy.declare('x', { root, name: null, onLog: (m) => logs.push(m) });
    ok(c.declared === false, '★★ 拿不到名字 → 不写标记');
    ok(fs.readdirSync(root).length === 0,
      '★★ 而且**一个文件都没写** —— 没有「通用名」那种后门',
      JSON.stringify(fs.readdirSync(root)));
    ok(logs.some((m) => /没在 agent 的 tmux 会话里/.test(m)),
      '★★ 但说出来了 —— 静默不写 = 失去保护且无人知道', JSON.stringify(logs));
    ok(typeof c.release === 'function', '★ release 仍然可调用（调用方不用判分支）');
    c.release();
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('\n【6】★★ whoami：从 tmux 会话名反推，不用 ENGLOOP_AGENT_TYPE');
  {
    // ── 为什么不能用那个环境变量 ────────────────────────────────────
    // ① 它是**类型**不是**名字** —— dev2 / dev3 的类型都是 `dev`，
    //    标记文件会互相覆盖
    // ② 它是启动时注入的，而 dev 自己那条「poller 必须带前缀」的**已知绕过**
    //    就建在它上面 —— 把这个模块架在一个绕过之上是把两个问题绑在一起
    const fakeTmux = (session) => () => session;

    ok(busy.whoami({ env: {}, run: fakeTmux('agent_dev') }) === null,
      '★ 不在 tmux 里（没有 TMUX 环境变量）→ null，连问都不问');

    ok(busy.whoami({ env: { TMUX: '/tmp/x,1,0' }, run: fakeTmux('agent_dev\n') }) === 'dev',
      '★★ 从会话名 agent_dev 反推出 dev');
    ok(busy.whoami({ env: { TMUX: 'x' }, run: fakeTmux('orch\n') }) === 'JARVIS',
      '★★ 编排者的会话名 orch → JARVIS（不是「orch」）');
    ok(busy.whoami({ env: { TMUX: 'x' }, run: fakeTmux('my_own_shell\n') }) === null,
      '★★ 人自己开的会话 → null —— 它不是 agent，不该有标记');
    ok(busy.whoami({ env: { TMUX: 'x' }, run: () => { throw new Error('boom'); } }) === null,
      '★ tmux 查不了 → null（失去保护，但不会写错名字）');

    // ★ 反推走的是 watchdog 那份唯一实现，不是自己 slice 一刀。
    //   `watchdog-liveness` 里有往返断言守着它跟 `roster.sessionFor` 互逆。
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'busy.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(/sessionToName/.test(code),
      '★★ 用 watchdog.sessionToName —— 自己 `slice(\'agent_\'.length)` 就是第二份实现',
      (code.match(/.*slice.*/g) || []).join(' | '));
    ok(!/ENGLOOP_AGENT_TYPE/.test(code),
      '★★ **没有**用 ENGLOOP_AGENT_TYPE —— 那是类型不是名字，而且它是个已知绕过',
      (code.match(/.*ENGLOOP.*/g) || []).join(' | '));
  }

  console.log('\n【7】★★ levelFor：申报了就不推，而且优先于 outbox 判据');
  {
    const QUIET = 999_999;   // outbox 早就静默了

    ok(watchdog.levelFor({ minIdle: watchdog.NUDGE_MS, outboxIdle: QUIET }) === 'nudge',
      '（前置）光看 outbox 的话，这一组会被推');
    ok(watchdog.levelFor({ minIdle: watchdog.NUDGE_MS, outboxIdle: QUIET, declaredBusy: true })
       === 'busy',
      '★★ 申报了 → busy，**不推** —— 这正是跑全量那几分钟的现场');
    ok(watchdog.levelFor({ minIdle: watchdog.ALERT_MS, outboxIdle: QUIET, declaredBusy: true })
       === 'busy',
      '★★ alert 档也盖住 —— 否则会报「已推送 ESC…此后仍无活动」，而根本没推');

    // ★ 阴性对照：没申报的照推。缺了它，一个「永不 nudge」的实现也能全绿。
    ok(watchdog.levelFor({ minIdle: watchdog.NUDGE_MS, outboxIdle: QUIET, declaredBusy: false })
       === 'nudge',
      '★★ 阴性对照：没申报 → 照推');
    ok(watchdog.levelFor({ minIdle: 0, declaredBusy: true }) === 'ok',
      '★ idle 小的时候申报与否都不影响（还没到动手档位）');
    ok(watchdog.levelFor({ minIdle: null, declaredBusy: true }) === 'unknown',
      '★ 查不到消费者仍是 unknown，不被申报改写');
    ok(watchdog.levelFor({ minIdle: 999, probeError: 'x', declaredBusy: true }) === 'probe_failed',
      '★ 探测失败优先 —— 查询本身坏了时别拿坏数据做判断');
  }

  console.log('\n【8】★ 这个信号要能被人看见');
  {
    const payload = watchdog.buildAgentsPayload(
      [{ name: 'x', type: 'dev', tmux_session: 'agent_x', level: 'busy',
         idleMs: 1_300_000, outboxIdleMs: null, pending: 0,
         declaredBusy: true, busy_reason: 'running', busy_what: 'test/run-all.js' }],
      [{ name: 'x', ttl_s: 800, last_heartbeat: Date.now() }],
    );
    const row = payload.live.find((r) => r.name === 'x');
    ok(row.declared_busy === true, '★ /api/agents 带上 declared_busy');
    ok(row.busy_what === 'test/run-all.js',
      '★★ 而且带「在跑什么」—— 人看这一行才能判断「放过它」对不对');
    ok(row.busy_reason === 'running', '★ 带 busy_reason');

    const p2 = watchdog.buildAgentsPayload(
      [{ name: 'y', type: 'dev', tmux_session: 'agent_y', level: 'nudge',
         idleMs: 1_300_000, pending: 0, declaredBusy: false, busy_reason: 'pid_gone' }],
      [{ name: 'y', ttl_s: 800, last_heartbeat: Date.now() }],
    );
    ok(p2.live[0].busy_reason === 'pid_gone',
      '★★ `pid_gone` 出现在响应里 —— 它跟 `no_marker` 不是一回事：'
      + '**后者是没人申报过，前者是有个任务异常退出了**');
  }

  console.log('\n【9】★ 接线：run-all.js 真的申报了');
  {
    const runAll = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
    ok(/busy\.declare\(/.test(runAll),
      '★★ run-all.js 真的调了 declare —— 不调的话这整个模块是死的');
    ok(/claim\.release\(\)/.test(runAll), '★ 跑完主动收掉标记');

    const wd = fs.readFileSync(path.join(__dirname, '..', 'lib', 'watchdog.js'), 'utf8');
    const wdCode = wd.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(/busy\.check\(/.test(wdCode),
      '★★ watchdog 真的查了标记 —— 不查的话 declare 写了也没人看');
    ok(/declaredBusy:\s*busyRec\.busy/.test(wdCode),
      '★★ 而且把结果**传进了 levelFor** —— 查了不用等于没查',
      (wdCode.match(/.*declaredBusy.*/g) || []).join(' | '));
  }


  // ══════════════════════════════════════════════════════════════════
  // 🔴 `anyBusy()` —— 「有没有**任何人**在忙」
  //
  //   为什么它是**新名字**而不是 `check()` 的无参重载：
  //   `lib/rooms.js` 的 `unfreeze` 注释里那句 **「两个问题两个答案」**。
  //   「他在不在忙」和「有没有任何人在忙」是两个问题，共用一个函数名
  //   等于让第二个问题**借第一个的可信度**：
  //   `check("dev2")` 返回 `pid_gone`（**真的读了文件、真的判了 pid，它是对的**），
  //   于是「它工作」容易被推广成「`check()` 也工作」，而 `check()` 无参会读
  //   `temp/busy/undefined.json` —— 一个永远不存在的文件 ⇒ **永远 no_marker**。
  //
  //   ⚠️ **这一组必须成对**：只验「有人在忙 ⇒ true」的话，一个恒真的实现也能过；
  //   而 `temp/busy/` 里可能躺着很久以前的陈标记，**恒真是一条真实可达的失效路径**。
  // ══════════════════════════════════════════════════════════════════
  console.log('\n【anyBusy：有没有**任何人**在忙】');
  {
    const T = tmpRoot();
    // ★ 两个 pid 都从**系统**拿，一个都不编 —— pid 会被复用，
    //   一个随手写的数字有小概率真的活着 ⇒ **判据偶发翻转**（比恒假更难查）。
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;   // 刚退出的子进程
    const livePid = process.pid;                                    // 本进程，一定活着
    ok(Number.isInteger(deadPid) && deadPid > 0,
      '（前提）拿到了一个刚退出的子进程 pid —— 夹具里的 pid 是系统事实，不是编出来的数', String(deadPid));

    ok(busy.anyBusy({ root: T }).busy === false
      && busy.anyBusy({ root: T }).reason === 'no_marker',
      '① 空目录 ⇒ busy=false · reason=no_marker');

    fs.writeFileSync(path.join(T, 'ghost.json'), JSON.stringify({
      agent: 'ghost', pid: deadPid, what: '一个刚退出的子进程', started_at: new Date().toISOString(),
    }));
    const stale = busy.anyBusy({ root: T });
    ok(stale.busy === false,
      '🔴 ② **正控**：只有 pid_gone 的标记 ⇒ busy **false**（否则陈标记会让它恒真 —— 而恒真和恒假一样没用）',
      JSON.stringify(stale));
    ok(stale.reason === 'all_stale',
      '② 而 reason 是 **all_stale** 不是 no_marker —— 「有标记但都死了」和「一个都没有」是两种情况',
      stale.reason);
    ok(stale.skipped.length === 1 && stale.skipped[0].agent === 'ghost'
      && stale.skipped[0].reason === 'pid_gone',
      '② 而被跳过的那个**被返回了** —— 压成一个 false 就查不出「跳过了谁、为什么」',
      JSON.stringify(stale.skipped));

    fs.writeFileSync(path.join(T, 'liveone.json'), JSON.stringify({
      agent: 'liveone', pid: livePid, what: '这个测试进程自己', started_at: new Date().toISOString(),
    }));
    const live = busy.anyBusy({ root: T });
    ok(live.busy === true && live.who.includes('liveone'),
      '🔴 ③ 有一个活进程的标记 ⇒ busy **true** 且 who 里有它', JSON.stringify(live.who));
    ok(live.skipped.some((x) => x.agent === 'ghost'),
      '③ 而那个死的仍在 skipped 里 —— 活的和死的**同时**被报告');

    // ── 🔴 ④ `check(name)` 的行为**不许**因此改变
    ok(busy.check('liveone', { root: T }).busy === true,
      '④ check("liveone") 仍然 true（按名字问的那条路一个字没动）');
    ok(busy.check('ghost', { root: T }).reason === 'pid_gone',
      '④ check("ghost") 仍然报 pid_gone');
    ok(busy.check('nobody-here', { root: T }).reason === 'no_marker',
      '④ check("一个不存在的名字") 仍然报 no_marker —— **无参调用要是不抛，拿到的就是这个**');

    // ── 🔴 ⑤ `check()` **无参必须抛错** ——
    //   而抛错不是防御性编程：**它把一次静默的恒假，换成一次响亮的失败**。
    let threw = null;
    try { busy.check(); } catch (e) { threw = e; }
    ok(threw instanceof TypeError,
      '🔴 ⑤ **check() 无参抛 TypeError**（不抛的话它会静默返回 no_marker）',
      threw ? threw.constructor.name : '没抛');
    ok(threw && /anyBusy/.test(threw.message),
      '⑤ 而错误信息里**指出了该用哪个函数** —— 一个只说「你错了」的错误，会让人再猜一次',
      threw ? String(threw.message).slice(0, 60) : '');

    fs.rmSync(T, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
