'use strict';

/**
 * `GET /api/status` —— 顶栏的测试格和 commit 格。
 *
 * ── 这个文件里几乎每一条都在验同一件事的一个面 ──────────────────
 *
 *   > **一个过期的绿，比没有数字更危险 ——**
 *   > **没有数字的时候人会去跑一遍，看到绿的时候不会。**
 *
 * 所以三种「不能当绿用」的情况都必须**说出来**，而不是悄悄显示那个数字：
 *   · 没有 last-run.json  → `no_data`，**不是** 0/0
 *   · git 跑不了          → `git_unavailable`，**不是** dirty:false
 *   · commit 变了 / 工作区脏 → `stale:true`
 *
 * 第二条的形状：bus 是 launchd 起的、PATH 跟 shell 不同，
 * **一个查不到的结果会被当成「一切正常」，而且没人发现。**
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const status = require('../lib/status');
const q = require('../lib/queue');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

/** 假 git：按参数返回预设值，或抛错。 */
function fakeGit(spec) {
  return (args) => {
    const key = args.join(' ');
    const v = spec[key];
    if (v === undefined) throw new Error(`fake git: 没配 ${key}`);
    if (v instanceof Error) throw v;
    return v;
  };
}

const GIT_OK = fakeGit({
  'rev-parse --short HEAD': 'a778028\n',
  'log -1 --format=%s': 'Fixture commit A\n',
  'status --porcelain': '',
  'log --since=midnight --oneline': 'a778028 x\ndef5678 y\n',
});

function tmpRun(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-status-'));
  const file = path.join(dir, 'last-run.json');
  if (data !== null) fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return { dir, file, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function main() {
  console.log('\n【1】★ readLastRun：三种「没数据」要分得开');
  {
    const t = tmpRun(null);
    const missing = status.readLastRun(t.file);
    ok(missing.ok === false && missing.reason === 'no_data',
      '★ 文件不存在 → no_data', JSON.stringify(missing));

    const t2 = tmpRun('{ 这不是 json');
    const bad = status.readLastRun(t2.file);
    ok(bad.ok === false && bad.reason === 'corrupt',
      '★★ 文件在但不是 JSON → corrupt，**不是** no_data —— 后者说「去跑一遍」，'
      + '前者说「上次跑到一半崩了」，是两个信号',
      JSON.stringify(bad));

    const t3 = tmpRun({ at: '2026-08-07T00:00:00Z' });   // 缺 passed/failed
    const partial = status.readLastRun(t3.file);
    ok(partial.ok === false && partial.reason === 'corrupt',
      '★★ 缺 passed/failed 也算 corrupt —— 一条缺字段的记录会渲染成一个'
      + '**看起来正常的格子**，比没有记录更坏',
      JSON.stringify(partial));

    const t4 = tmpRun({ passed: 983, failed: 0, files: 22, commit: 'a778028' });
    const good = status.readLastRun(t4.file);
    ok(good.ok === true && good.data.passed === 983, '★ 正常记录读得出来');

    [t, t2, t3, t4].forEach((x) => x.clean());
  }

  console.log('\n【2】★★ 过期判定：commit 对不上 → stale');
  {
    const lastRun = { ok: true, data: { passed: 983, failed: 0, files: 22,
      at: new Date().toISOString(), commit: 'a778028', dirty: false } };

    const same = status.buildStatusPayload(lastRun, status.gitInfo({ run: GIT_OK }));
    ok(same.stale === false,
      '★ 阴性对照：commit 一样 + 工作区干净 → 不过期',
      JSON.stringify(same.stale_reasons));
    ok(same.tests.passed === 983 && same.tests.failed === 0, '数字透传');

    const moved = status.buildStatusPayload(lastRun, status.gitInfo({
      run: fakeGit({
        'rev-parse --short HEAD': 'b12f3c4\n',
        'log -1 --format=%s': 'Fixture commit B\n',
        'status --porcelain': '',
        'log --since=midnight --oneline': '',
      }),
    }));
    ok(moved.stale === true,
      '★★ HEAD 变了 → 过期（这个数字跑的是另一份代码）');
    ok(moved.stale_reasons.includes('commit_moved'), '★ 原因是 commit_moved',
      JSON.stringify(moved.stale_reasons));
    ok(/a778028/.test(moved.stale_hint) && /b12f3c4/.test(moved.stale_hint),
      '★★ 提示里**两个 hash 都在** —— 只说「过期了」人不知道差多远',
      JSON.stringify(moved.stale_hint));
    // ★ 说清「是什么」之后要说「该做什么」。两个 hash 是诊断，不是动作。
    ok(/run-all/.test(moved.stale_hint),
      '★★ 而且给出动作（重跑）—— 两个 hash 是诊断，人还要自己想下一步',
      JSON.stringify(moved.stale_hint));
  }

  console.log('\n【3】★★ 工作区脏 → 过期（那些改动根本没验过）');
  {
    const lastRun = { ok: true, data: { passed: 983, failed: 0,
      at: new Date().toISOString(), commit: 'a778028', dirty: false } };
    const p = status.buildStatusPayload(lastRun, status.gitInfo({
      run: fakeGit({
        'rev-parse --short HEAD': 'a778028\n',
        'log -1 --format=%s': 'Fixture commit A\n',
        'status --porcelain': ' M lib/rooms.js\n?? web/\n',
        'log --since=midnight --oneline': 'a778028 x\n',
      }),
    }));
    ok(p.stale === true, '★★ commit 一样但工作区脏 → 仍然过期');
    ok(p.stale_reasons.includes('working_tree_dirty'), '★ 原因是 working_tree_dirty');
    ok(/没被这次测试覆盖/.test(p.stale_hint),
      '★ 提示说清「那些改动没被覆盖」，不是笼统的「有改动」', JSON.stringify(p.stale_hint));
    // ★★ 这一条的出口有个反直觉的点，必须说出来 ——
    //   人看到「工作区脏」的第一反应是「那我先提交」，**而那不是必要的**：
    //   跑的是磁盘上的代码，不是 HEAD。不说的话他会多做一步，
    //   甚至为了让顶栏变绿而提交一堆没验过的改动。
    ok(/不用先提交/.test(p.stale_hint),
      '★★ 出口点明「不用先提交」—— 否则人会为了让顶栏变绿而提交没验过的改动',
      JSON.stringify(p.stale_hint));
  }

  console.log('\n【4】★★ git 查不了 → 说「查不了」，不是「干净的」');
  {
    // ── 查不了 ≠ 干净 ──────────────────────────
    // bus 是 launchd 起的，PATH 跟 shell 不同。把「查不了」降级成
    // 「工作区干净」正好是最坏的方向：一堆没验过的改动会显示成「已验证」。
    const g = status.gitInfo({ run: fakeGit({}) });   // 什么都没配 → rev-parse 就抛
    ok(g.available === false, '★ git 不可用时 available=false');
    ok(g.error === 'git_unavailable', '★ 带专用错误码', JSON.stringify(g.error));
    ok(g.dirty !== false,
      '★★ dirty **不是 false** —— 「查不了」降级成「干净的」是最坏的方向',
      `实际 dirty=${JSON.stringify(g.dirty)}`);
    ok(/查不了/.test(g.detail || ''),
      '★★ 明说「这不是代码没变，是查不了」', JSON.stringify(g.detail));
    ok(/PATH/.test(g.hint || ''), '★ 给出常见原因（launchd 的 PATH）');

    const p = status.buildStatusPayload(
      { ok: true, data: { passed: 983, failed: 0, commit: 'a778028',
                          at: new Date().toISOString() } }, g);
    ok(p.stale === true,
      '★★ git 查不了 → **算过期**。算成新鲜的话 git 一挂顶栏就永远绿着');
    ok(p.stale_reasons.includes('git_unavailable'), '★ 原因说得出');

    // ★ 单项失败不该带走别的：HEAD 拿得到、status 挂了 → dirty 为 null 而不是 false
    const partial = status.gitInfo({
      run: fakeGit({
        'rev-parse --short HEAD': 'a778028\n',
        'log -1 --format=%s': 'Fixture commit A\n',
        'status --porcelain': new Error('boom'),
        'log --since=midnight --oneline': 'a778028 x\n',
      }),
    });
    ok(partial.available === true && partial.head === 'a778028',
      '★ HEAD 拿得到就照给 —— 一项失败不该把整格弄没');
    ok(partial.dirty === null,
      '★★ 查不了脏不脏 → **null**，不是 false', `实际 ${JSON.stringify(partial.dirty)}`);

    // ★ head_subject 同一条规矩：单项失败 → null，不是空串。
    //   `""` 会在界面上渲染成一个看不见的存在，跟「拿到了但是空的」分不开。
    const noSubject = status.gitInfo({
      run: fakeGit({
        'rev-parse --short HEAD': 'a778028\n',
        'log -1 --format=%s': new Error('boom'),
        'status --porcelain': '',
        'log --since=midnight --oneline': '',
      }),
    });
    ok(noSubject.head === 'a778028',
      '★ 拿不到标题不影响 hash —— 单项失败不该把整格弄没');
    ok(noSubject.head_subject === null,
      '★★ 拿不到标题 → **null**，不是空字符串',
      `实际 ${JSON.stringify(noSubject.head_subject)}`);

    const emptySubject = status.gitInfo({
      run: fakeGit({
        'rev-parse --short HEAD': 'a778028\n',
        'log -1 --format=%s': '\n',            // 空标题（真有人这么 commit）
        'status --porcelain': '',
        'log --since=midnight --oneline': '',
      }),
    });
    ok(emptySubject.head_subject === null,
      '★ 空标题也归 null —— 空串在界面上是个看不见的存在',
      `实际 ${JSON.stringify(emptySubject.head_subject)}`);

    // ★ git 整个不可用时也要有这个字段（缺字段和 null 在前端不是一回事：
    //   `'head_subject' in git` 会是 false，而前端写 `git.head_subject ?? …` 才安全）
    ok('head_subject' in g && g.head_subject === null,
      '★ git 完全不可用时 head_subject 也在，值是 null',
      JSON.stringify(g.head_subject));
    const pp = status.buildStatusPayload(
      { ok: true, data: { passed: 1, failed: 0, commit: 'a778028' } }, partial);
    ok(pp.stale_reasons.includes('dirty_unknown'),
      '★★ 而且它照样让整体判成过期 —— 不能保证覆盖了当前代码',
      JSON.stringify(pp.stale_reasons));
  }

  console.log('\n【5】★★ 没有 last-run.json → no_data，不是 0/0');
  {
    // 「从来没跑过」和「跑过、全绿」在一个空对象里长得一模一样，
    // 而前者应该催人去跑。
    const p = status.buildStatusPayload({ ok: false, reason: 'no_data' },
      status.gitInfo({ run: GIT_OK }));
    ok(p.tests === null,
      '★★ tests 是 null，**不是 {passed:0,failed:0}** —— 后者会渲染成一个绿的 0 失败',
      JSON.stringify(p.tests));
    ok(p.tests_error?.reason === 'no_data', '★ 明确给出原因');
    ok(p.stale === true, '★★ 而且算过期');
    ok(/从来没跑过/.test(p.stale_hint) && /run-all/.test(p.stale_hint),
      '★ 提示给出可直接跑的命令', JSON.stringify(p.stale_hint));
  }

  console.log('\n【6】★ 真 HTTP：形状对不对');
  {
    const t = tmpRun({ passed: 983, failed: 0, files: 22, skipped: ['e2e.test.js'],
      at: new Date(Date.now() - 60_000).toISOString(), commit: 'a778028', dirty: true });
    const app = express();
    app.get('/api/status', status.handler({ file: t.file, gitRun: GIT_OK }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.on('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const b = await (await fetch(`${base}/api/status`)).json();
    ok(b.tests.passed === 983 && b.tests.failed === 0, '数字出来了');
    ok(b.tests.age_ms >= 55_000 && b.tests.age_ms <= 70_000,
      `★ age_ms 算的是「多久之前跑的」（${Math.round(b.tests.age_ms / 1000)}s）`);
    ok(b.tests.dirty_when_run === true,
      '★★ 记着**跑那一刻**工作区脏不脏 —— 那是「这个数字覆盖了什么」的一部分');
    ok(Array.isArray(b.tests.skipped) && b.tests.skipped.includes('e2e.test.js'),
      '★★ 跳过的文件跟数字一起给 —— **警告跟数字分开印等于没写**',
      JSON.stringify(b.tests.skipped));
    ok(b.git.head === 'a778028' && b.git.commits_today === 2,
      '★ git 的实时部分：HEAD + 今天的 commit 数',
      JSON.stringify(b.git));
    ok(b.git.head_subject === 'Fixture commit A',
      '★ 带 HEAD 的标题 —— **一个短 hash 认不出是哪次改动**，而人要判断的正是'
      + '「上次测试跑的是不是这份代码」',
      JSON.stringify(b.git.head_subject));
    ok(b.stale === false, '阴性对照：这一组不过期');

    await new Promise((r) => server.close(r));
    t.clean();
  }

  console.log('\n【7】★★ writeLastRun 记的是**跑那一刻**的状态');
  {
    // ── 这一条守的是过期判定的地基 ──────────────────────────────────
    // commit/dirty 的全部用途是跟「现在」比对。记成读取时刻的话两者恒等，
    // **过期判定会永远返回「新鲜」** —— 一个恒绿的过期检查比没有更坏。
    const t = tmpRun(null);
    const rec = status.writeLastRun({ passed: 5, failed: 0, files: 1 },
      { file: t.file, gitRun: GIT_OK });
    ok(rec.commit === 'a778028', '★ 写进了跑那一刻的 commit');
    ok(rec.dirty === false, '★ 写进了跑那一刻的 dirty');
    ok(typeof rec.at === 'string' && !Number.isNaN(Date.parse(rec.at)), '★ 带时间戳');

    const back = status.readLastRun(t.file);
    ok(back.ok && back.data.passed === 5, '★ 写完能读回来（形状自洽）');

    // ★★ 真正的守卫：拿一个**不同的** HEAD 去判，必须变过期。
    //   如果 writeLastRun 记的是读取时刻，这条会绿着 —— 因为两边永远相同。
    const later = status.buildStatusPayload(back, status.gitInfo({
      run: fakeGit({
        'rev-parse --short HEAD': 'deadbee\n',
        'log -1 --format=%s': '别的 commit\n',
        'status --porcelain': '',
        'log --since=midnight --oneline': '',
      }),
    }));
    ok(later.stale === true && later.stale_reasons.includes('commit_moved'),
      '★★ 之后 HEAD 变了 → 那条记录变成过期的。**这条红了说明 commit 记成了读取时刻**',
      JSON.stringify(later.stale_reasons));

    t.clean();
  }

  console.log('\n【8】★ 接线：run-all.js 真的写，serve.js 真的挂，而且 status 不跑测试');
  {
    const runAll = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
    ok(/status\.writeLastRun\(/.test(runAll),
      '★★ run-all.js 真的调了 writeLastRun —— 不调的话 last-run.json 永远不更新，'
      + '而顶栏会显示一个越来越旧的绿数字');
    ok(/passed:\s*totalPass/.test(runAll) && /failed:\s*totalFail/.test(runAll),
      '★ 写的是这一轮真实的合计，不是写死的数');
    ok(/skipped:/.test(runAll),
      '★ 跳过的文件也写进去（「这个合计覆盖不到什么」要跟数字一起走）');

    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'serve.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(/app\.get\(\s*['"`]\/api\/status['"`]/.test(code), '★★ 路由挂上了');
    ok(/status\.handler\(/.test(code), '★★ 用的是 lib 里那个 handler');

    // ★★ 这个端点**绝不能**自己跑测试：页面 5 秒一刷，跑一次几分钟，
    //   会把 bus 拖死 —— 而且「每次刷新都在跑测试」本身就是个事故。
    //
    // ⚠️ 判据是**它启动了哪些子进程**，不是「源码里有没有 run-all 这个词」。
    //   后者会红 —— 因为 `staleHint()` 里给人的建议
    //   正是「跑 `node test/run-all.js`」。**那种断言匹配的是一句提示文本，
    //   跟这个端点跑不跑测试毫无关系**，而它红的时候会让人去删一句正确的提示。
    //   （「关键词出现过」≠「说的是这件事」，见 wiring.test.js。）
    const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'status.js'), 'utf8');
    const libCode = libSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    // ⚠️ 也不能用 `\bexec\s*\(`：它会匹配到 `gitInfo()` 里那个叫 `exec`
    //   的**注入点局部变量**（测试自己用它注假 git）。`exec` 这个名字太通用，
    //   拿它当「子进程调用」的代理必然误伤。
    //
    //   判据换成**这个模块从 child_process 引入了什么能力** —— 它比数调用点
    //   更靠上游，也不吃命名巧合：想跑测试就得先有 spawn 之类的东西进来。
    const imp = libCode.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"`]node:child_process['"`]\)/);
    ok(imp !== null, '（前置）找到了 child_process 的 require', libCode.slice(0, 200));
    const imported = (imp ? imp[1] : '').split(',').map((s) => s.trim()).filter(Boolean);
    ok(imported.length === 1 && imported[0] === 'execFileSync',
      '★★ 从 child_process **只引入了 execFileSync** —— 引入 spawn/exec 这条就红',
      `实际引入了：${imported.join(', ')}`);

    const execCalls = libCode.match(/execFileSync\(\s*(['"`])([^'"`]+)\1/g) || [];
    ok(execCalls.length > 0,
      '（前置）确实有 execFileSync 调用 —— 一个都没有的话下面那条是空转');
    ok(execCalls.every((c) => /['"`]git['"`]/.test(c)),
      '★★ 它启动的子进程**只有 git**（几毫秒）—— 换成 `execFileSync("node", [...run-all])` 这条就红',
      `实际：${execCalls.join(' | ')}`);
  }


  console.log('\n【Q】★★ 队列积压：等待数不是 XLEN（Patrick 亲自栽过的地方）');
  {
    // ══════════════════════════════════════════════════════════════
    // 别用 XLEN 当等待数 —— XLEN 是流的总长度，包含已消费的历史。
    //
    // ★★ 这一节的核心不是「等待数对不对」，是**抓住那个分叉点**：
    //   队列刚起、还没人消费时，XLEN 和等待数**答案一致** ——
    //   所以一个用 XLEN 的实现，在新流上完全正确。
    //   **它只在消费之后才错，而那时候没有任何报错。**
    // ══════════════════════════════════════════════════════════════
    const redis = q.createClient();
    const S = 'orch:in:qtest', G = 'orch';
    await redis.del(S);
    await q.ensureGroup(redis, S, G);
    for (let i = 0; i < 3; i++) await q.send(redis, S, { from: 't', text: `x${i}` });

    const before = await status.queueStats(redis, { streams: [S] });
    ok(before.waiting === 3, '塞 3 条没人消费 → 等待 3', JSON.stringify(before));
    ok(before.processing === 0, '还没投递出去 → 处理中 0');
    ok((await redis.xlen(S)) === 3,
      '（前置）此刻 XLEN 也是 3 —— **一个用 XLEN 的实现在这里完全正确**');

    // 消费 2 条（领了不 ack）→ 它们变成「处理中」
    await q.claimNext(redis, { streams: [S], group: G, consumer: 'c1', count: 2, blockMs: 200 });
    const mid = await status.queueStats(redis, { streams: [S] });
    ok(mid.processing === 2, '★ 领了没 ack 的 2 条 → 处理中 2', JSON.stringify(mid));
    ok(mid.waiting === 1, '★★ 而等待剩 1 —— **XLEN 此刻仍然是 3**');
    ok((await redis.xlen(S)) === 3,
      '★★ 分叉点：XLEN 还是 3，等待已经是 1。**用 XLEN 的实现从这一刻起开始骗人**');

    // ack 掉 → 处理中归零，等待不变
    const rows = await redis.xrange(S, '-', '+');
    await q.ack(redis, S, G, rows[0][0]);
    const after = await status.queueStats(redis, { streams: [S] });
    ok(after.processing === 1, 'ack 一条 → 处理中 1');
    ok(after.waiting === 1, '等待不受 ack 影响（它数的是「还没被读走」）');

    // ★★ lag 算不出来时,「0」和「不知道」必须分得开。
    //   XTRIM 之后 redis 就给不出 lag 了 —— 而那正是最容易被读成「没积压」的时刻。
    await redis.xtrim(S, 'MAXLEN', 1);
    const trimmed = await status.queueStats(redis, { streams: [S] });
    ok(trimmed.unknown_lag === true || trimmed.waiting !== null,
      '★ 裁剪之后要么报 unknown_lag,要么仍算得出 —— 不许悄悄变成 0',
      JSON.stringify(trimmed));
    if (trimmed.unknown_lag) {
      ok(trimmed.streams.some((x) => x.lag === null),
        '★★ 明细里那条流的 lag 是 null（不是 0）—— 「查不了」和「没有」分开');
    } else {
      ok(true, '（这个 redis 版本裁剪后仍算得出 lag —— 那也可以，只要不假装是 0）');
    }

    await redis.del(S);
    await redis.quit();
  }

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
