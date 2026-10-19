'use strict';

/**
 * **「纯 ack」的四个条件 —— 钉住的是【形状】，不是那句话。**
 *
 * ── 为什么要钉形状 ────────────────────────────────────────────
 *   「纯 ack 文件是**设计支持**的：`{"ack":[…],"text":""}`」这句话**省略了条件**：
 *   那个例子里**没有收件人字段**，而那不是省略，**是条件**。
 *   ⇒ 带 `room_hash` 的纯 ack ⇒ ⇒ 入口会拒：`✗ 缺 text`。
 *   ★ 「纯 ack」这个名字可以指三样东西：
 *       **没内容**的回复 · **没地址**的 ack（＝不投递，入口认的是这个）
 *       · 那个**字面例子**
 *   ⇒ ⇒ **一条转述过、但从没执行过的规矩，跟一条执行过的，在文字上没有任何区别。**
 *     分开它们的只有一件事：**去用一次** —— 而这个文件就是把那一次固定下来。
 *
 * ── ⚠️ 为什么用 `--dry-run`：它**没有副作用**，而且走同一条判定路径 ────────
 *   `bin/outbox-send.js:100-104` 逐字：**「dry-run 必须走完全相同的判定路径，
 *   只在最后一步分叉」** ＋「出口在**全部校验之后、落地之前**」。
 *   🔬 而 `grep -n 'createClient|redis' bin/outbox-send.js` ⇒ **0 处** —— 它根本不碰 redis。
 *   ⇒ ⇒ 所以这组判据不落文件、不 ack、不投递。
 *
 * 单跑：`node test/outbox-ack-only.test.js`
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SEND = path.join(ROOT, 'bin', 'outbox-send.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-ackonly-'));

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

/** 把一个草稿喂给入口的 `--dry-run`，回 { code, out } */
const dry = (obj, name) => {
  const f = path.join(TMP, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  const r = spawnSync('node', [SEND, f, '--dry-run'],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

console.log('\n【1】「纯 ack」的四个条件 —— 入口（`bin/outbox-send.js --dry-run`）');

// ── 正控放在最前面：一条**正常**消息必须过 ────────────────────────────
//   🔴 没有它，下面两条「必须被拒」的绿，可能只是**入口拒绝一切**（比如路径写错、
//     node 起不来）—— 而那种红跟「校验在工作」在退出码上完全相同。
const normal = dry({ ack: ['s:::1-0'], room_hash: 'deadbeefcafe', text: '一句话' }, 'normal');
ok(normal.code === 0 && /房间 deadbeefcafe/.test(normal.out),
  '【1-1】★（正控）一条**正常**的房间消息 ⇒ 退 0，且 `to` 是那个房间 —— '
  + '否则下面两条的「被拒」说明不了任何事',
  `code=${normal.code} · ${normal.out.trim().split('\n').slice(-3).join(' | ')}`);

// ── ① 合法的纯 ack：**不带任何收件人字段** ────────────────────────────
const pure = dry({ ack: ['s:::1-0'] }, 'pure');
ok(pure.code === 0 && /纯 ack，不投递/.test(pure.out),
  '【1-2】🔴 ★★ `{"ack":[…]}`（**不带收件人字段**）⇒ 退 0 且打印「**纯 ack，不投递**」 —— '
  + '「没地址」不是缺陷，它就是「不投递」这个语义的表达方式',
  `code=${pure.code} · ${pure.out.trim().split('\n').slice(-3).join(' | ')}`);

// ── ② 带 room_hash 而 text 为空 ⇒ 必须被拒 ──
const roomEmpty = dry({ ack: ['s:::1-0'], room_hash: 'deadbeefcafe', text: '' }, 'room-empty');
ok(roomEmpty.code !== 0 && /缺 text/.test(roomEmpty.out),
  '【1-3】🔴 ★★ `{"ack":[…],"room_hash":…,"text":""}` ⇒ **必须被拒**（`缺 text`） —— '
  + '带了地址就不算 ack-only，于是要求有正文',
  `code=${roomEmpty.code} · ${roomEmpty.out.trim().split('\n').slice(-2).join(' | ')}`);

// ── ③ 带 work 而 text 为空 ⇒ 入口拒。**而末端不拒** —— 见【1-5】 ────────
const workEmpty = dry({ ack: ['s:::1-0'], work: 'dev', text: '' }, 'work-empty');
ok(workEmpty.code !== 0 && /缺 text/.test(workEmpty.out),
  '【1-4】🔴 ★ `{"ack":[…],"work":…,"text":""}` ⇒ **入口拒**（入口的 `isAckOnly` 多一条 `!work`）',
  `code=${workEmpty.code} · ${workEmpty.out.trim().split('\n').slice(-2).join(' | ')}`);

console.log('\n【2】而**末端**（`lib/relay.js`）的同名判定 —— 它跟入口**不是同一套**');

// ── 🔴 两层的 isAckOnly 已经分叉，而分叉点是 `work` ─────────────────────
//   `bin/outbox-send.js:167`  text==='' && !username && !room_hash && **!work** && ack非空
//   `lib/relay.js:545`        text==='' && !username && !room_hash &&            acks.length>0
//   ⇒ ⇒ 一个 `{"ack":[…],"work":"dev","text":""}` **直接写进 `temp/outbox/<name>/`**：
//     入口拒（上面【1-4】）· 而末端判为 ack-only ⇒ `continue`（`:578`）
//     ⇒ ⇒ worker 通路那段在 `:581` 之后 ⇒ **永远走不到** ⇒ **`work` 被静默丢掉**。
//   ⚠️ 而**这条判据不说它是 bug**：引入 `work` 的那次改动明确写过
//     「同一条规则在**入口层和末端层，正确答案相反**」—— 所以它**可能是刻意的**。
//     而 `lib/relay.js:528-540` 那段逐条解释四条为什么是四条的注释里，**一个字没提 `work`**。
//     ⇒ ⇒ 两种解释都举得出证据 ⇒ **这一格要人裁**，而判据只负责把现状钉住：
//       它是刻意的 ⇒ 把那个理由抄到这里 · 它是漏的 ⇒ 修好那天这条会红。
//
//   🔴 而这条**只断言源码里含不含那个 token** —— 它**判不了**「末端有没有对应的校验」。
//     （「**『末端提到了那个字段』≠『末端有对应的校验』**」。）
const relaySrc = fs.readFileSync(path.join(ROOT, 'lib', 'relay.js'), 'utf8');
const block = (relaySrc.match(/const isAckOnly[\s\S]{0,240}?;/) || [''])[0];

ok(block.length > 0 && !/\bwork\b/.test(block),
  '【2-1】🔴 ★★ 末端 `lib/relay.js` 的 `isAckOnly` **不含 `work`** —— '
  + '⚠️ 这条只看**源码里有没有这个词**，它判不了「末端有没有对应的校验」；'
  + '而这个分叉是不是刻意的 **要人裁**',
  JSON.stringify(block.replace(/\s+/g, ' ').slice(0, 160)));

// ── 阴性对照：那段里**确实有** username / room_hash ────────────────────
//   没有它，【2-1】的绿可能只是「这个正则什么都没抓到」。
ok(/\busername\b/.test(block) && /\broom_hash\b/.test(block),
  '【2-2】★（阴性对照）那一段里**确实含** `username` 和 `room_hash` —— '
  + '否则【2-1】的绿只是「正则没抓到东西」',
  JSON.stringify(block.replace(/\s+/g, ' ').slice(0, 160)));

// ⚠️ 还有**第三个条件**，而它**入口检查不了**：
//   **③ 那些 id 里至少要有一个还没被 ack 过** —— 否则 `runAcks` 的 `ok === 0`
//     ⇒ ⇒ `lib/relay.js:558` 把它存进 deadletter（`reason:'ack_only_all_failed'`）。
//   🔴 而 `bin/outbox-send.js` **不碰 redis**（`grep -n 'createClient|redis'` ⇒ **0 处**）
//     ⇒ ⇒ 它**判不了**一个 id 有没有被 ack 过。
//   ⇒ 所以上面四条覆盖的是 ①（不带收件人字段）和 ②（ack 非空），**③ 覆盖不到** ——
//     写在这里，免得这四条看起来把「纯 ack」验完了。

console.log('\n【3】🔴 而**末端的行为**：喂 relay 一个 `{ack, work, text:""}`，`work` 会怎样');

// ── 为什么这一段是**行为型**，而上面【2】那条是文本型 ──────────────────
//   文本型判据（grep 源码里有没有 `work`）**两个方向都会错**——
//     `isAckOnly` 抽成函数 / 改名 / 拆行 ⇒ **红，而行为没变**
//     有人写成 `!('work' in entry)` 补上了 ⇒ **绿，而洞已经补好了**
//   ⇒ ⇒ 而装置**一直在仓库里**：`test/relay.test.js` 就是这么测 relay 的
//     （`startRelay({outboxDir, from, redis, onEvent})` ＋ 往临时目录写 JSON）。
//   ★ 它叫 `relay.test.js`，不叫「怎么测 relay」——
//     **一个东西的可发现性，取决于它的名字长得像不像要找的那个问题。**
//
//   ⚠️ 而它必须包在 async IIFE 里：**CommonJS 不允许顶层 `await`** ——
//     直接写会得到 `ERR_AMBIGUOUS_MODULE_SYNTAX`（node 以为这是 ESM）。
//     ⇒ 而那个报错**不提 await 两个字**，它说的是「模块语法有歧义」——
//     ★ 又一次「响了，而报的是错的原因」：错在 await，而它报的是模块类型。
(async () => {
  const q = require('../lib/queue');
  const { startRelay } = require('../lib/relay');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ★ 这个文件在 `test/` 下 ⇒ `isTestProcess()` 认前缀 ⇒ **自动拿测试 db**，不碰生产。
  const redis = q.createClient();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-ackwork-'));
  const dlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-ackwork-dl-'));
  const events = [];
  const relay = startRelay({ outboxDir: outDir, from: 'senior', redis,
    onEvent: (e) => events.push(e), deadletterRoot: dlRoot });

  const feed = async (obj, tag) => {
    const before = events.length;
    fs.writeFileSync(path.join(outDir, `${tag}.json`), JSON.stringify(obj));
    await wait(600);
    return events.slice(before);
  };

  // ── ① `text:""` ＋ `work` ⇒ 末端判为 ack-only ⇒ **worker 那支根本走不到** ──
  //   （ack 的 id 是编的 ⇒ `ok === 0` ⇒ 走 `ack_only_all_failed` 那一支；
  //     而**那一支本身就证明了 ack-only 分支被选中了** —— 这正是要看的东西。）
  const swallowed = await feed(
    { ack: ['nosuch:::1-0'], work: 'dev', text: '' }, 'work-empty');
  const kinds1 = swallowed.map((e) => e.type + (e.reason ? `/${e.reason}` : ''));
  ok(kinds1.some((k) => k.startsWith('ack_only') || k.includes('ack_only_all_failed'))
     && !kinds1.some((k) => k.startsWith('work')),
    '【3-1】🔴 ★★ `{ack,work,text:""}` ⇒ 末端走 **ack-only** 那一支，`work` **一次都没被看** —— '
    + '而入口是拒它的（【1-4】）⇒ ⇒ **两层对同一个输入给出不同答案**。'
    + '⚠️ 这条**不说它是 bug**：引入 `work` 时的设计说明写的就是'
    + '「同一条规则在入口层和末端层，正确答案相反」—— **要人裁**',
    JSON.stringify(kinds1));

  // ── ② 对照：同样带 `work`，而 `text` 非空 ⇒ **不是 ack-only** ⇒ 走 worker 那支 ──
  //   没有它，①的绿可能只是「这个 relay 实例什么都不做」。
  const routed = await feed(
    { ack: ['nosuch:::1-0'], work: 'dev', text: '一句话' }, 'work-text');
  const kinds2 = routed.map((e) => e.type + (e.reason ? `/${e.reason}` : ''));
  ok(kinds2.length > 0 && !kinds2.some((k) => k.startsWith('ack_only')),
    '【3-2】★（对照）同样带 `work` 而 **`text` 非空** ⇒ **不走 ack-only** —— '
    + '所以①里 `work` 被吞，取决的是 `text` 空不空，不是这个 relay 什么都不做',
    JSON.stringify(kinds2));

  relay.stop();
  await redis.quit();
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(dlRoot, { recursive: true, force: true });

  // ★ 汇总放在这里面 —— 否则它会在【3】跑完之前就打印（而那正是「顶层 await」要解决的事）
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  // 🔴 而 catch 不能省：async IIFE 里抛出去的错**默认只打一行 UnhandledRejection**，
  //   而进程**可能仍然退 0** ⇒ ⇒ 那就是一条恒绿的判据。
  console.log(`  ✗ 【3】整段没跑完：${e && e.message}`);
  console.log(`\n  通过 ${pass} · 失败 ${fail + 1}`);
  process.exit(1);
});
