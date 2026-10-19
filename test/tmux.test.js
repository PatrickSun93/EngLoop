'use strict';

const t = require('../lib/tmux');

const S = 'engloop_tmux_test';
let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

async function main() {
  ok(t.available(), 'tmux 可用');

  console.log('\n【1】命名校验（会话名是共享的命名空间）');
  ok(t.validName('orch'), 'orch 合法');
  ok(t.validName('agent_dev'), 'agent_dev 合法');
  ok(t.validName('job_eval_a1b2'), 'job_eval_a1b2 合法');
  ok(!t.validName('crew dev'), '含空格非法');
  ok(!t.validName('agent:dev'), '含冒号非法（tmux 用它做 window 分隔）');
  ok(!t.validName(''), '空名非法');

  await t.kill(S);

  console.log('\n【2】起会话 / 探活');
  ok(!(await t.exists(S)), '起之前不存在');
  await t.spawn(S, { cwd: process.cwd(), command: 'bash -c "echo ENGLOOP_MARKER; sleep 60"' });
  ok(await t.exists(S), '起之后存在');

  console.log('\n【3】撞名必须拒绝，不能静默接管');
  let threw = false;
  try {
    await t.spawn(S, { cwd: process.cwd(), command: 'bash -c "sleep 5"' });
  } catch (e) {
    threw = /已存在/.test(e.message);
  }
  ok(threw, '同名再起时抛错（防止把新任务接到活会话上）');

  console.log('\n【4】peek 能看到内容');
  const r = await t.waitFor(S, /ENGLOOP_MARKER/, 10000, 500);
  ok(r.ok, 'waitFor 等到了标记（不是固定 sleep）');
  const pane = await t.peek(S, 20);
  ok(pane.includes('ENGLOOP_MARKER'), 'capture-pane 拿到回滚缓冲');

  console.log('\n【5】list 列得出来');
  const sessions = await t.list();
  ok(sessions.some((s) => s.name === S), `list 包含 ${S}`);

  console.log('\n【6】kill');
  ok(await t.kill(S), 'kill 成功');
  ok(!(await t.exists(S)), 'kill 之后不存在');

  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const PROBE = path.join(__dirname, 'fixtures', 'tmux-list-probe.js');

  console.log('\n【7】★ list 必须区分「没有会话」和「我查不了」');
  {
    // ── 为什么要区分 ────────────────────────────────────────────────
    // bus 用 nohup 起时 PATH 只有 /usr/bin:/bin:...，而 tmux 在 /opt/homebrew/bin。
    // `list()` 要是 `catch { return [] }` —— watchdog 的枚举源就全空、
    // `GET /api/agents` 三格全空，**页面显示「没有异常」，跟「真的没有异常」
    // 长得一模一样**，失聪检测本身瞎了也没人看得出来。
    //
    // ★ 唯一真实的复现条件是「找不到 tmux 命令」，那要一个 PATH 不同的**进程**。
    //   在本进程里 mock 掉 execFile 只验得到实现细节，验不到「换个环境它怎么表现」。
    // ─────────────────────────────────────────────────────────────────
    // ⚠️ 「受限 PATH」造不出这个复现：tmuxBin() 的 fallback
    //   会找到 /opt/homebrew/bin/tmux —— 那正是【1】的修复生效的证据，见【8】里那条。
    //   **两个修复的复现条件不同，守卫也必须分开**：
    //     · 「路径能找到」→ 受限 PATH 下**成功**
    //     · 「查不了要说出来」→ 指向一个真的不存在的 tmux
    //   合成一条的话，修好其中一个就会把另一个的守卫也变绿。
    const blind = spawnSync(process.execPath, [PROBE], {
      encoding: 'utf8',
      env: { ...process.env, ENGLOOP_TMUX_BIN: '/nonexistent/bin/tmux' },
    });
    let out = null;
    try { out = JSON.parse(blind.stdout); } catch (_) { /* 下面断言会报 */ }

    ok(out !== null, '探针输出可解析', (blind.stdout || blind.stderr || '').slice(0, 200));
    ok(out?.ok === false,
      '★ 找不到 tmux 时**不返回空数组** —— 返回 [] 等于谎报「没有会话」');
    ok(out?.code === 'TMUX_UNAVAILABLE',
      '★ 错误可区分（code=TMUX_UNAVAILABLE），上层才能显式报「查不了」');
    ok(/查不了|不是「没有会话」/.test(out?.message || ''),
      '★ 错误信息把两者的区别说出来了（读日志的人不必自己推断）');

    // ★ 阴性对照：tmux 能用时，「没有会话」仍然是合法的空数组，不是错误。
    //   没有这条的话，「一律抛错」的实现也能过上面三条 —— 而那会让
    //   一个干净的机器上 watchdog 每 60 秒报一次假警。
    const okRun = spawnSync(process.execPath, [PROBE], { encoding: 'utf8' });
    let out2 = null;
    try { out2 = JSON.parse(okRun.stdout); } catch (_) { /* 下面断言会报 */ }
    ok(out2?.ok === true,
      '★ 阴性对照：tmux 可用时正常返回（不是「一律抛错」的实现）',
      (okRun.stdout || okRun.stderr || '').slice(0, 200));
    ok(Array.isArray(out2?.sessions), '正常路径返回的是数组');
  }

  console.log('\n【7c】★★ list() 必须验证自己解析出来的东西（结构对、内容错那一类）');
  {
    // ── 要防的形状 ──────────────────────────────────────────────────
    // `list()` 要是返回 `agent_dev_1785970068_0` —— **三个字段粘在一起，
    // 整行成了 name**。后果：sessionToName 反查失败 → 正常 agent 被判 deaf；
    // **watchdog 的 stale 分支据此 unregister → 活着的 agent 被删出花名册**。
    //
    // ★ 它难发现的原因：**返回值的结构是完整的**（是数组、有 name
    //   字段、长度也对），**只是内容错了。任何断言「返回了 N 个会话」的
    //   测试都会通过。**
    //
    // ⚠️ 这种解析错误跟环境有关 —— 同一份代码、同一个 socket，
    //   在别的机器上可能解析正确。**一个只在别的环境里发生的解析错误，只有解析器
    //   自己能发现** —— 所以下面第 ③ 条（喂假输入）是唯一守得住的那条，
    //   ①② 在解析正确的机器上本来就绿。
    // ─────────────────────────────────────────────────────────────────

    // ① 往返：list() 给的名字，exists() 要找得到（跨两个不同实现）
    const sessions = await t.list();
    ok(sessions.length > 0, '（前置）当前有会话可验', JSON.stringify(sessions));
    for (const s of sessions) {
      // eslint-disable-next-line no-await-in-loop
      const found = await t.exists(s.name);
      ok(found === true,
        `★ 往返：list() 给的 "${s.name}"，exists() 找得到`);
    }

    // ② 直接守这次这个具体的坏法：名字不带「_<时间戳>_<数字>」后缀
    for (const s of sessions) {
      ok(!/_\d{9,}_\d+$/.test(s.name),
        `★ "${s.name}" 不含粘连产生的数字后缀（字段粘连就是这个形状）`);
    }
    // 顺带：字段真的被切开了，不是全挤在 name 里
    ok(sessions.every((s) => Number.isFinite(s.created) && s.created > 0),
      '★ created 解析成了数字 —— 粘连时它会是 NaN');

    // ③ ★★ 喂假输入：解析器必须**抛错**，不能把脏数据当事实。
    //    这条是唯一在「本机复现不出来」时仍然有效的守卫。
    const dirty = 'agent_dev_1785970068_0\norch_1785970066_0';
    let threw = null;
    try { t.parseList(dirty); } catch (e) { threw = e; }
    ok(threw !== null,
      '★★ 粘在一起的输出 → **抛错**，不是返回一个带后缀的假名字');
    ok(threw && threw.code === 'TMUX_UNAVAILABLE',
      '★ 而且错误可区分，上层能显式报「查不了」而不是「没有会话」');
    ok(threw && /解析不了|格式对不上/.test(threw.message),
      '★ 错误信息说清是「解析不了」，不是「没有会话」', threw && threw.message);

    // 阴性对照：正常输出要正常解析（否则「一律抛错」的实现也能过上面三条）
    const clean = 'orch|1785970066|0\nagent_dev|1785970068|1';
    const parsed = t.parseList(clean);
    ok(parsed.length === 2 && parsed[0].name === 'orch' && parsed[1].name === 'agent_dev',
      '★ 阴性对照：正常输出照常解析（不是「一律抛错」的实现）', JSON.stringify(parsed));
    ok(parsed[1].attached === true && parsed[0].attached === false,
      'attached 也解析对了（三个字段都在用，不是只看第一个）');
    ok(t.parseList('') .length === 0, '空输出 → 空数组（那是合法的「没有会话」）');
  }

  console.log('\n【7b】★ exists() 同病 —— 而且它的下游是关停超时的「回查事实」');
  {
    // `exists()` 要是 `catch { return false }` 就犯同样的错，
    // **而 false 的含义是「会话不存在」**。
    //
    // 最坏的下游是 `lib/shutdown.js` 的 W4：kill 之后回查会话还在不在，
    // 用来判断强杀有没有真的生效。tmux 不可用时 exists() 说 false →
    // **报告一次没有发生的成功**。而 W4 存在的全部理由就是「不拿命令返回值
    // 当结果，要回查事实」—— **回查本身撒谎的话，那层防护是空的。**
    //
    // ⚠️ 这是 list() 的同一个问题在隔壁函数里的另一半：区分「查不了」的能力
    //   在同一个文件里，必须两个函数都用上。
    const EPROBE = path.join(__dirname, 'fixtures', 'tmux-exists-probe.js');

    const blind = spawnSync(process.execPath, [EPROBE, 'whatever'], {
      encoding: 'utf8',
      env: { ...process.env, ENGLOOP_TMUX_BIN: '/nonexistent/bin/tmux' },
    });
    let e1 = null;
    try { e1 = JSON.parse(blind.stdout); } catch (_) { /* 下面断言会报 */ }

    ok(e1?.ok === false,
      '★ 查不了时**不返回 false** —— false 的含义是「会话不存在」，那是谎话',
      (blind.stdout || blind.stderr || '').slice(0, 200));
    ok(e1?.code === 'TMUX_UNAVAILABLE', '★ 错误可区分，上层才能保守处理');

    // ★ 阴性对照：tmux 能用、会话真的不存在 → 仍然是 false，不是错误。
    //   没有这条的话，「一律抛错」的实现也能过上面两条 —— 而那会让
    //   每一次正常的「会话在不在」查询都变成异常。
    const real = spawnSync(process.execPath, [EPROBE, 'definitely_not_a_session'], {
      encoding: 'utf8',
    });
    let e2 = null;
    try { e2 = JSON.parse(real.stdout); } catch (_) { /* 下面断言会报 */ }
    ok(e2?.ok === true && e2.exists === false,
      '★ 阴性对照：会话真的不存在 → false（不是「一律抛错」的实现）',
      (real.stdout || real.stderr || '').slice(0, 200));

    // ★ 下游守卫：W4 拿到这个错时**不能**判成「已收掉」。
    //   shutdown.js 有这一支（「回查失败 → 保守地记为没收掉」），
    //   只有 exists() 不撒谎时它才走得到。
    const shutdown = require('../lib/shutdown');
    ok(typeof shutdown.timeoutAlertText === 'function',
      '关停超时的人向告警仍由 shutdown.js 生成（没被绕过）');
  }

  console.log('\n【8】★ tmux 路径只有一个出处（launchd/nohup 的最小 PATH 找不到它）');
  {
    // `bin/serve.sh` 已经为 **node** 解决过同一个问题（launchd 不加载 profile，
    // 所以它自己解析 nvm 路径）。**tmux 是同一个问题，也要自己解析路径。**
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    // ★ 符号级断言：所有调用点都要走 tmuxBin()。
    //   ⚠️ 排除 tmuxBin() 自己那一处：它**必须**裸调 'tmux' 去探测 PATH，
    //   那是解析器本身，不是调用点（不排除的话这条会误红）。
    const callSites = src.replace(/function tmuxBin\(\)[\s\S]*?\n}/, '');
    ok(!/run\('tmux'|execFileSync\('tmux'/.test(callSites),
      '★ 解析器之外没有裸的 `\'tmux\'` 当命令名 —— 全部走 tmuxBin()');
    ok((src.match(/tmuxBin\(\)/g) || []).length >= 9,
      '★ 九个调用点都换过来了（抽了没删原处 = 制造第二份实现）');

    ok(typeof t.tmuxBin() === 'string' && t.tmuxBin().length > 0,
      'tmuxBin() 返回一个可用的命令名/路径');
    ok(t.available() === true, 'available() 也走同一份解析（本机 tmux 装着）');

    // ★ 显式指定要能覆盖候选列表 —— 装在非常规位置的人不该被硬编码挡住
    const custom = spawnSync(process.execPath, ['-e',
      'process.stdout.write(require("./lib/tmux").tmuxBin())'], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ENGLOOP_TMUX_BIN: '/custom/path/tmux' },
    });
    ok(custom.stdout === '/custom/path/tmux',
      '★ ENGLOOP_TMUX_BIN 能覆盖（硬编码候选列表不该是死路）',
      JSON.stringify((custom.stdout || custom.stderr || '').slice(0, 120)));

    // ★★ 这条是【1】自己的守卫：**launchd/nohup 的最小 PATH 下也要能用**。
    //    它跟【7】那几条前提不同 —— 【7】守「查不了要说出来」，
    //    这条守「本来就不该查不了」。合成一条的话，修好一个会把另一个变绿。
    const restricted = spawnSync(process.execPath, [PROBE], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },   // ← launchd 的真实 PATH
    });
    let out3 = null;
    try { out3 = JSON.parse(restricted.stdout); } catch (_) { /* 下面断言会报 */ }
    ok(out3?.ok === true,
      '★ 受限 PATH（launchd/nohup 的那种）下仍然查得到 —— bus 由 launchd 起时 PATH 就这么窄',
      JSON.stringify((restricted.stdout || restricted.stderr || '').slice(0, 200)));
    ok(Array.isArray(out3?.sessions),
      '而且返回的是真会话列表，不是降级成空数组');
  }

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('✗ 异常:', e.message);
  await t.kill(S);
  process.exit(1);
});
