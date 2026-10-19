'use strict';
/**
 * `bin/outbox-send.js` —— **发件人是谁，由 `whoami()` 决定，不写死**
 *
 * ── 这个文件为什么存在 ──────────────────────────────────────────────
 *   投递终点要是**硬编码 `'dev'`** ⇒ 这个脚本就只有一个人能用：
 *   别人用它，消息进 `temp/outbox/dev/` ⇒ 而 relay 按目录名判发件人
 *   ⇒ ⇒ **他会以 dev 的身份发出去**。
 *
 *   而「有没有一个**每次发消息都会跑**的脚本」直接决定漏 ack 的多少 ——
 *   所以每个 agent 都要能用它。
 *
 * ── ⚠️ 这一组判据必须**成对** ──────────────────────────────────────
 *   只验「dev 的路径里有 dev」的话，**一个仍然写死 dev 的实现照样全绿**。
 *   ⇒ 所以每一条都用**两个不同的发件人**跑，断言的是「它跟着变」，不是「它等于某个值」。
 *
 * ── 🔴 而 `sent-jobs.json` 是**反向**的那一条 ──────────────────────
 *   它记「哪个 (work, job_id) 已经派过」，而那个语义**跨发件人成立**：
 *   senior 派过的 job，dev 再派一次同样是重复。
 *   ⇒ ⇒ 所以它**有意不按发件人分** —— 而这条判据钉住那个「有意」，
 *     否则下一个人「顺手把它也分了」时，去重会静默失效。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'bin', 'outbox-send.js');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); } else {
    fail += 1;
    console.log(`  ✗ ${msg}${detail !== undefined ? `  → ${detail}` : ''}`);
  }
}

// ★ 一个最小的合法草稿。`--dry-run` **不落地**，所以它不会真发出去。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-send-test-'));
const DRAFT = path.join(TMP, 'draft.json');
fs.writeFileSync(DRAFT, JSON.stringify({
  room_hash: '7ad0d1dcde8c',
  text: '判据用的草稿 —— --dry-run 不落地',
}));

/** 跑一次 dry-run，返回它打印出来的四个路径。 */
function run(as, { stripTmux = false } = {}) {
  const env = { ...process.env };
  if (as === null) delete env.ENGLOOP_OUTBOX_AS;
  else env.ENGLOOP_OUTBOX_AS = as;
  if (stripTmux) { delete env.TMUX; delete env.TMUX_PANE; }
  const r = spawnSync(process.execPath, [SCRIPT, DRAFT, '--dry-run'], {
    cwd: ROOT, encoding: 'utf8', timeout: 20_000, env,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // 🔴 **行首锚**，不是宽松匹配：
  //   `outbox` 用 `/outbox\\s*:/` 会匹配到另一行的 **`--test-outbox: 终点已改为`**
  //   ⇒ ⇒ 那样即使它红对了，证据也是从另一行来的 —— 换个实现就可能绿错。
  //   ★ 要问的是「红的原因是那件事吗」，同口径重跑答不了它。
  const grab = (label) => {
    const m = out.match(new RegExp(`^  ${label}\\s*:\\s*(\\S+)`, 'm'));
    return m ? m[1] : null;
  };
  return {
    code: r.status,
    as: grab('as'),
    outbox: grab('outbox'),
    ackedLog: grab('ackedLog'),
    pollJson: grab('pollJson'),
    sentJobs: grab('sentJobs'),
    out,
  };
}

/**
 * 🔴 走**整条**路径（含落地），只把终点换成一个临时目录。
 *   —— 而这正是 `--test-outbox` 那个 flag 存在的理由。
 */
function runReal(as) {
  const box = fs.mkdtempSync(path.join(TMP, 'box-'));
  const draft = path.join(TMP, `draft-${as}.json`);
  // ⚠️ 每次重写：真发路径会 `rmSync(src)` 把草稿删掉（那是它该做的）
  fs.writeFileSync(draft, JSON.stringify({ room_hash: '7ad0d1dcde8c', text: '走整条路径' }));
  const r = spawnSync(process.execPath, [SCRIPT, draft, '--test-outbox', box], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, ENGLOOP_OUTBOX_AS: as },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // 🔴 **行首锚**，不是宽松匹配：
  //   `outbox` 用 `/outbox\\s*:/` 会匹配到另一行的 **`--test-outbox: 终点已改为`**
  //   ⇒ ⇒ 那样即使它红对了，证据也是从另一行来的 —— 换个实现就可能绿错。
  //   ★ 要问的是「红的原因是那件事吗」，同口径重跑答不了它。
  const grab = (label) => {
    const m = out.match(new RegExp(`^  ${label}\\s*:\\s*(\\S+)`, 'm'));
    return m ? m[1] : null;
  };
  return {
    code: r.status,
    as: grab('as'),
    outbox: grab('outbox'),
    landed: fs.readdirSync(box).filter((f) => f.endsWith('.json')),
    draftGone: !fs.existsSync(draft),
    box,
    out,
  };
}

function main() {
  console.log('\n══ bin/outbox-send.js · 发件人不写死 ══════════════════\n');

  const a = run('alpha-agent');
  const b = run('beta-agent');

  console.log('【1】两个不同的发件人 ⇒ 三个路径都跟着变');
  ok(a.code === 0 && b.code === 0,
    '（前提）两次 dry-run 都退出码 0', JSON.stringify({ a: a.code, b: b.code }));
  ok(a.as === 'alpha-agent' && b.as === 'beta-agent',
    '★ 脚本报出的发件人 = 传进去的那个', JSON.stringify({ a: a.as, b: b.as }));

  for (const [key, label] of [
    ['outbox', '投递终点'],
    ['ackedLog', '已 ack 记录'],
    ['pollJson', 'poll 落盘'],
  ]) {
    ok(a[key] && b[key] && a[key] !== b[key],
      `🔴 ${label}（${key}）**跟着发件人变** —— 只验一个名字的话，写死的实现照样全绿`,
      JSON.stringify({ a: a[key], b: b[key] }));
    ok(a[key] && a[key].includes('alpha-agent') && b[key].includes('beta-agent'),
      `${label} 里带的是**各自**的名字`, JSON.stringify({ a: a[key], b: b[key] }));
  }

  console.log('\n【2】🔴 而 `sent-jobs.json` **有意不分** —— 反向的那一条');
  ok(a.sentJobs && b.sentJobs && a.sentJobs === b.sentJobs,
    '🔴 换了发件人，`sentJobs` **仍然是同一个文件** —— 它防的是「同一个 job 被派两次」，'
    + '而那个语义跨发件人成立；分了它，去重会**静默**失效',
    JSON.stringify({ a: a.sentJobs, b: b.sentJobs }));
  ok(a.sentJobs && !a.sentJobs.includes('alpha-agent'),
    '`sentJobs` 的路径里**不含**发件人名', a.sentJobs);

  console.log('\n【2b】🔴 输出里**不许**出现写死的发件人名');
  // 🔴 那行「发送成功后的提醒」不能打印写死的
  //   `--group agent:dev --consumer dev-1 --streams agent:dev:in --name dev`：
  //   别的 agent 照着跑 ⇒ **他会领走 dev 的消息**。
  //   ⇒ ⇒ 而它比路径错更隐蔽：**它不会失败，它会成功地做错事**。
  //   ★ 只验**路径**的判据抓不到它 —— 这一行依赖的是「**发件人是谁**」。
  //     这一条补的就是那个维度。
  for (const [who, r] of [['alpha-agent', a], ['beta-agent', b]]) {
    ok(!/agent:dev\b|dev-1\b|--name dev\b/.test(r.out),
      `🔴 ${who} 的输出里**不含**写死的 \`agent:dev\` / \`dev-1\` / \`--name dev\` —— `
      + '一条命令，只有在它对所有读到它的人都成立时，才该被打印出来',
      JSON.stringify((r.out.match(/agent:dev\S*|dev-1|--name dev/g) || []).slice(0, 3)));
  }

  console.log('\n【3】🔴 认不出发件人 ⇒ **抛，不默认**');
  const none = run(null, { stripTmux: true });
  ok(none.code === 2,
    '🔴 没有 tmux 会话、也没有覆盖变量 ⇒ **退出码 2** —— '
    + '默认到任何一个名字，都是以别人的身份发言', String(none.code));
  ok(/认不出发件人/.test(none.out),
    '而它说得出**为什么**退出（不是一个裸的非零码）',
    JSON.stringify(none.out.slice(0, 80)));

  console.log('\n【4】🔴 观察点在**真发那条路径**上也打得出来（`--test-outbox`，含落地）');
  // 🔴 那五行观察点不能只放在
  //   `if (DRY) { … process.exit(0) }` 块里 ⇒ 否则**真发那条路什么都不打**，
  //   照「先看 `as :` 再信」去看时，一个路径都看不到。
  //   ⇒ ⇒ 而真发才是要紧的那条：**dry-run 发错了没事，真发发错了就以别人的身份说了话。**
  //
  // ★ 而这一组补的是上面 14 条**结构上的**盲区，不是它们不够仔细：
  //   它们**全部**跑 `--dry-run` ⇒ 观察点被搬回 DRY 块里，**它们一条都不会红**。
  //   ⇒ 判据的射程 ≠ 那句话的范围。
  const ra = runReal('alpha-agent');
  const rb = runReal('beta-agent');
  ok(ra.code === 0 && rb.code === 0,
    '（前提）两次真发都退出码 0', JSON.stringify({ a: ra.code, b: rb.code }));
  ok(ra.landed.length === 1 && rb.landed.length === 1,
    '🔴 **真的落地了** —— 这一组走的是含副作用的那条路，不是又一次 dry-run',
    JSON.stringify({ a: ra.landed, b: rb.landed }));
  ok(ra.draftGone && rb.draftGone,
    '（同一条路的第二个印记）草稿被删了 —— dry-run 会保留它',
    JSON.stringify({ a: ra.draftGone, b: rb.draftGone }));
  ok(ra.as === 'alpha-agent' && rb.as === 'beta-agent',
    '🔴 ★ 真发路径上 `as :` **打得出来，而且是各自的名字**（两个 agent 的名字不能串）',
    JSON.stringify({ a: ra.as, b: rb.as }));
  ok(ra.outbox === ra.box && rb.outbox === rb.box,
    '🔴 而 `outbox :` 打的是**这一次真正的终点**，不是 `PROD_OUTBOX` —— '
    + '原来那行写死 `PROD_OUTBOX`，在 `--test-outbox` 下会说一句假话，'
    + '而且是在唯一会去看它的那个场景里',
    JSON.stringify({ a: [ra.outbox, ra.box], b: [rb.outbox, rb.box] }));
  // 🔴 这一条不断言具体**措辞**（如「不是生产 outbox」）——
  //   那样在坏版本上红的原因会是**措辞不同**，不是「观察点在 DRY 块里」。
  //   ⇒ 信那个红，会去修一个没坏的东西。
  // ✅ 断言**那一行上有一个警示标记** —— 措辞可以变，而「有没有标出来」不变。
  const boxLine = (ra.out.match(/^  outbox\s*:.*$/m) || [''])[0];
  ok(boxLine.includes(ra.box) && /⚠/.test(boxLine),
    '而 `outbox` 那一行**在终点被换掉时带一个警示标记** —— '
    + '免得有人把测试终点读成真的投出去了（断言的是「有标记」，不是某一句措辞）',
    JSON.stringify(boxLine.slice(0, 90)));

  console.log('\n【5】🔴 观察点在**落地之前**打 —— 而这个属性在成功路径上**看不见**');
  // 观察点该在落地之前打，还是之后？
  //   · 之前 ⇒ **出错时也看得到「发件人是谁」**，而那正是要防的场景
  //   · 之后 ⇒ 只有成功时才看得到
  //   ⇒ 而这一格的病因就是「出事的那条路沉默」⇒ 选**之前**。
  //
  // 🔴 而这一条为什么必须单独存在：**成功路径上，观察点在落地前还是落地后，输出一模一样**
  //   ⇒ ⇒ 「被占住的空位看不见」：要让空位露出来，得让落地**失败**一次。
  //
  // 📊 验这一条要用对变异体：
  //   🔴 ① 「那五行整段搬到 `mkdirSync` 之后」**不行** —— 它同时落在了
  //      `if (DRY)` 的 `exit(0)` **之后** ⇒ dry-run 也打不出观察点了
  //      ⇒ 【1】【2】那几条陪着一起红
  //      ⇒ ⇒ **它验的不是「落地前 vs 落地后」，是「有没有观察点」**
  //   ✅ ② 「dry-run 保留自己那一份 ＋ 真发在落地**成功之后**打一份」
  //      ⇒ 红的应该只有这一条（变异体若没抄那个 ⚠️，「警示标记」那条也会偶然红）
  //
  // ★ **一个变异体给出的红，可能验的是它自己，而不是你想验的那件事** ——
  //   而两者在输出里都只是一个 ✗。
  const doomed = path.join(TMP, 'doomed.json');
  fs.writeFileSync(doomed, JSON.stringify({ room_hash: '7ad0d1dcde8c', text: '落地必败' }));
  // `/dev/null` 不是目录 ⇒ 在它下面 mkdir 必然 ENOTDIR（macOS / Linux 都是）
  const dead = spawnSync(process.execPath, [SCRIPT, doomed, '--test-outbox', '/dev/null/x'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, ENGLOOP_OUTBOX_AS: 'probe-agent' },
  });
  const deadOut = `${dead.stdout || ''}${dead.stderr || ''}`;
  ok(dead.status !== 0 && /ENOTDIR|ENOENT/.test(deadOut),
    '（前提）这一次落地**真的失败了** —— 否则下一条验的是成功路径，等于没验',
    JSON.stringify({ code: dead.status, err: (deadOut.match(/Error: \S+/) || [''])[0] }));
  ok(/^  as : probe-agent/m.test(deadOut),
    '🔴 ★ **落地失败时，`as :` 已经打出来了** —— 观察点在副作用之前。'
    + '移到之后的话，这一条红而上面 20 条全绿',
    JSON.stringify((deadOut.match(/^  as :.*/m) || ['（没有这一行）'])[0]));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${'─'.repeat(50)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
