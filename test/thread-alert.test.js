'use strict';

/**
 * 漏挂 thread 的发送侧告警（`lib/thread-alert.js`）。
 *
 * ── 这个文件守的是什么 ──────────────────────────────────────────
 * 这个模块的价值全在**它和网页那一侧说的是不是同一件事**。
 * 它报的每一条，网页上都该有一个红色「未归属」标签；它没报的，网页上就不该有。
 *
 *   > **两边不一致，比根本没有这个告警更坏** —— 他看到的每一次「没问题」，
 *   > 都在教他这个检查器可以信。等他真的信了，漏填就彻底看不见了。
 *
 * 所以下面最贵的几条不是「功能对不对」，是**判据对齐**：
 *   · 拼错的 `kind: "notic"` —— relay 会把这个值整个丢掉，网页渲染成 orphan。
 *     照 agent 的原值判就会得出「他标了 notice」⇒ 网页红着、告警绿着。
 *   · 谁算「人」—— 判据只有 `web/threads.js` 一处出处，这里不许有第二份。
 *
 * ⚠️ 全部行为测试，不做源码断言：模块是 Node 可 require 的，
 *   而源码断言验得了「函数存在」，验不了它拿到拼错的 kind 会不会放行。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TA = require('../lib/thread-alert');
const T = require('../web/threads.js');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

// ⚠️ 临时目录，绝不碰生产 temp/ —— 同 relay 的 deadletterRoot 那条。
//   这里污染的形态是「某个真 agent 下一轮收到
//   几条凭空冒出来的漏填告警，而它指的消息根本不存在」。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-thread-alert-'));

// 造一条「已经写进流里」的消息。注意字段是**规范化之后**的值。
const sent = (o) => ({ from: 'dev2', ...o });

function main() {
  console.log('\n【1】★★★ 判据对齐：跟 web/threads.js 的 orphan 完全同进同退');
  {
    ok(TA.isOrphan(sent({})) === true,
      'agent 发的、没 reply_to、没 kind ⇒ orphan（网页红标签）');
    ok(TA.isOrphan(sent({ reply_to: 'abc' })) === false,
      '填了 reply_to ⇒ 不报');
    ok(TA.isOrphan(sent({ kind: 'notice' })) === false,
      '标了 notice ⇒ 不报（通知本来就不该挂在谁下面）');
    ok(TA.isOrphan(sent({ kind: 'reply', reply_to: 'abc' })) === false,
      'reply + 有父 ⇒ 不报');

    // ★★ `status`（①.5）：上线报到 / 自检通过 / 心跳 **不算违规**。
    //   它本来就不该有 `reply_to` —— 它不在回复任何人。报它是判据错，
    //   而一个持续误报的判据会诱使人放宽它，最后连真 orphan 也不报了。
    //
    // ★ 这一条不需要在本模块里写任何代码：判据复用 `kindOf`，
    //   `web/threads.js` 认了 `status`，这里就自动跟着认 —— 一处出处的收益。
    ok(TA.isOrphan(sent({ kind: 'status' })) === false,
      '★★ 标了 status ⇒ 不报（上线报到不是漏挂 thread）');

    // ★ 阴性对照：这几条要是全都返回 true，上面四条里有三条会假装通过。
    const all = ['', 'notice', 'reply'].map((k) => TA.isOrphan(sent({ kind: k, reply_to: k ? 'p' : '' })));
    ok(JSON.stringify(all) === '[true,false,false]',
      '★ 三种输入给出三种不同结果 —— 不是恒真也不是恒假', JSON.stringify(all));
  }

  console.log('\n【2】★★★ 拼错的 kind：relay 丢掉它 ⇒ 网页是 orphan ⇒ 这里必须也报');
  // 这条是整个文件里最贵的一条。`lib/relay.js` 对 kind 只透传认识的三个值，
  // `"notic"` 会被整个丢掉 —— 流里没有 kind，网页照 orphan 渲染。
  // ⇒ 传进来的 kind 已经是 undefined，这里必须报。
  //   照 agent 的原值判的那个写法，会在这里放行 —— **那就是网页红、告警绿**。
  {
    const normalized = ['topic', 'reply', 'notice'].includes('notic') ? 'notic' : undefined;
    ok(normalized === undefined, '前提：relay 的白名单确实把 "notic" 丢掉了');
    ok(TA.isOrphan(sent({ kind: normalized })) === true,
      '★★ 规范化之后是 undefined ⇒ 报（跟网页一致）');
    ok(TA.isOrphan(sent({ kind: 'notic' })) === true,
      '★ 就算原值漏进来了也照样报 —— 不认识的值不能当成标过了');
  }

  console.log('\n【3】「谁算人」只有一处出处 —— 不在这个文件里复制第二份');
  {
    ok(TA.isOrphan({ from: T.HUMAN }) === false,
      `${T.HUMAN} 发的顶层消息是 topic，不是 orphan（判据取自 web/threads.js）`);
    ok(TA.isOrphan({ from: 'dev2' }) === true,
      'agent 发的同形状消息才是 orphan');
  }

  console.log('\n【4】记一笔 → 报出来 → **读了就销**');
  {
    const name = 'case4';
    ok(TA.alertLine(TA.take(name, DIR)) === null,
      '没漏填时返回 null（不是空串 —— 空串会造出一个有字段没内容的告警）');

    TA.record(name, { at: Date.now(), to: 'JARVIS', room: false, preview: '我做完了' }, DIR);
    const line = TA.alertLine(TA.take(name, DIR));
    ok(typeof line === 'string' && line.includes('1 条'), '报出 1 条', String(line).slice(0, 40));
    ok(line.includes('我做完了'), '★ 预览里能认出是哪一条');
    ok(line.includes('reply_to'), '★ 修法具体到字段名，不是「请挂 thread」');
    ok(line.includes('dm_msg_id') && line.includes('room_msg_id'),
      '★ 两个锚点字段都点名 —— 房间和私聊填的不是同一个');

    ok(TA.alertLine(TA.take(name, DIR)) === null,
      '★★ 第二次读已经空了 —— 读了就销，不累积到「改正为止」（一直报会脱敏）');
  }

  console.log('\n【5】★★ 按名分文件：dev 的漏填不许报给 dev2');
  // 这是这个模块跟 lib/waiting.js 故意不同的那一处（那边 env 覆盖整个文件路径）。
  // 写的那一侧是 relay —— **中心进程，所有 agent 的 outbox 都从它手上过**。
  // 串了的后果：dev2 收到一条自己看不懂的告警（多半当噪音忽略），dev 什么也没收到。
  {
    TA.record('devA', { at: Date.now(), to: 'JARVIS', preview: 'A 的消息' }, DIR);
    TA.record('devB', { at: Date.now(), to: 'JARVIS', preview: 'B 的消息' }, DIR);

    const a = TA.alertLine(TA.take('devA', DIR));
    ok(a.includes('A 的消息') && !a.includes('B 的消息'),
      '★★ devA 只看到自己那条', a.includes('B 的消息') ? '串味了' : '');
    const b = TA.alertLine(TA.take('devB', DIR));
    ok(b.includes('B 的消息') && !b.includes('A 的消息'), '★★ devB 同理');

    ok(TA.statePath('devA', DIR) !== TA.statePath('devB', DIR),
      '两个名字落到两个文件');
    ok(TA.statePath('devA', DIR).startsWith(DIR),
      '★ 注入的目录真的生效了 —— 否则这几条是在生产 temp/ 里跑的', TA.statePath('devA', DIR));
  }

  console.log('\n【6】名字消毒：路径穿越写不出目录外面');
  // ⚠️ 判据是**解析之后还在不在目录里**，不是「文件名里有没有 `..`」——
  //   后者是代理指标：消毒后的名字是 `.._.._etc_evil`，`..` 作为文件名的
  //   字面字符完全无害，照那个判法会误报。而误报会诱使人放宽它。
  {
    const root = path.resolve(DIR) + path.sep;
    // ⚠️ 层数要够：`thread-alert-..` 会被当成**一个目录名**（`..` 前面没有分隔符），
    //   它自己就吃掉一层。少一个 `..` 的输入根本逃不出去，对照就成了假的。
    const EVIL = '../../../etc/evil';

    const p = path.resolve(TA.statePath(EVIL, DIR));
    ok(p.startsWith(root), '★ 解析之后仍在目录内 —— 判的是「写不出去」', p);

    // ★ 阴性对照：**同一个名字**不经消毒真的会跑到目录外面。
    //   没有这一条，上面那条可能是条恒真的死判据。
    const naive = path.resolve(path.join(DIR, `thread-alert-${EVIL}.json`));
    ok(!naive.startsWith(root),
      '★★ 对照：同样的名字不消毒真的逃出去了 —— 所以上面那条不是恒真', naive);
  }

  console.log('\n【7】★★ 超出上限不静默吞 —— 数字是他判断严重程度的依据');
  {
    const name = 'case7';
    const n = TA.KEEP + 3;
    for (let i = 0; i < n; i++) {
      TA.record(name, { at: Date.now(), to: 'JARVIS', preview: `第 ${i} 条` }, DIR);
    }
    const line = TA.alertLine(TA.take(name, DIR));
    ok(line.includes(`${n} 条`), `★★ 说的是总数 ${n}，不是留下的 ${TA.KEEP}`, line.slice(0, 60));
    ok(line.includes('另有 3 条'), '★ 被截掉的那几条被明说了，不是悄悄没了');
    ok(line.includes(`第 ${n - 1} 条`), '留下的是最近的');
    ok(!line.includes('第 0 条'), '最早的那条确实被截了（对照）');
  }

  console.log('\n【8】预览截断带省略号 —— 不让半句话冒充整句');
  {
    // ⚠️ 跟长消息折叠那边同一条判据：被切断的第一句读起来像一句完整的话，
    //   人会照着它下判断。
    const long = '这是一句很长的话'.repeat(20);
    const p = TA.previewOf(long);
    ok(p.length === TA.PREVIEW + 1, `截到 ${TA.PREVIEW} 字 + 一个省略号（实际 ${p.length}）`);
    ok(p.endsWith('…'), '★ 截断处有省略号');
    ok(TA.previewOf('短的') === '短的', '★ 没超长的不加省略号（对照）');
    ok(TA.previewOf('') === '(空)', '空文本有个说法，不是渲染成空白');
    ok(TA.previewOf('多行\n\n文本').includes(' '), '换行压平，不破坏告警的行结构');
  }

  console.log('\n【9】房间和私聊分得开 —— 两边该填的锚点字段不同');
  {
    const name = 'case9';
    TA.record(name, { at: Date.now(), to: 'someone', room: true, preview: '房间发言' }, DIR);
    const line = TA.alertLine(TA.take(name, DIR));
    ok(line.includes('房间'), '★ 房间那条标出来了');
  }

  console.log('\n【10】状态文件坏了 / 不存在 ⇒ 没有告警，不抛');
  // 「读不到」在这里是常态（多数轮次确实没漏填），不是故障 ——
  // 跟探针相反，那边「没有状态」本身就是要报的东西。
  {
    ok(TA.alertLine(TA.take('never-existed', DIR)) === null, '没有文件 ⇒ null');

    const name = 'case10';
    fs.writeFileSync(TA.statePath(name, DIR), '{ 这不是 JSON');
    let threw = false;
    let line;
    try { line = TA.alertLine(TA.take(name, DIR)); } catch { threw = true; }
    ok(!threw, '★ 坏文件不抛异常 —— 观测机制不能拖垮轮询');
    ok(line === null, '坏文件 ⇒ 没有告警');
  }

  console.log('\n【11】★★★ 销 ≠ 删：读走的进保留区，事后查得到');
  // 「这个文件先不动，留作证据」这个决定，**poller 每轮都在读、读即删的话根本做不了** ——
  // 等去查的时候证据已经被机制自己吃光了。所以读走的告警要留档。
  // `lib/waiting.js` 的 settled 区写过同一条：
  // 「如果同时也从文件里消失，就再也没有任何东西能证明它存在过」。
  {
    const name = 'case12';
    TA.record(name, { at: Date.now(), to: 'JARVIS', preview: '这条会被读走' }, DIR);

    const line = TA.alertLine(TA.take(name, DIR));
    ok(line.includes('这条会被读走'), '（前置）它确实报出来过');

    ok(TA.alertLine(TA.take(name, DIR)) === null,
      '★ 读走之后不再报 —— 告警不重复（脱敏那条还在）');

    const kept = TA.settledOf(name, DIR);
    ok(kept.length === 1, '★★★ 但它没被删掉，在保留区里', String(kept.length));
    ok(kept[0].preview === '这条会被读走', '★★ 内容原样留着，查得到它到底是什么');
    ok(Number.isFinite(kept[0].taken_at),
      '★ 带 taken_at —— 查的时候要分得清是哪一轮读走的');

    // ★★★ 这一条守的是一个静默 bug：`record` 写文件时若不带上 settled，
    //   **每记一条新告警就会把上一轮的留档冲掉**。不报错 —— 文件还在、
    //   告警照常，只有事后来查的那一刻才发现空了，而那时已经晚了。
    TA.record(name, { at: Date.now(), to: 'JARVIS', preview: '新的一条' }, DIR);
    ok(TA.settledOf(name, DIR).length === 1,
      '★★★ 记新告警**不会冲掉**已有的留档', String(TA.settledOf(name, DIR).length));
    const line2 = TA.alertLine(TA.take(name, DIR));
    ok(line2.includes('新的一条') && !line2.includes('这条会被读走'),
      '★★ 保留区**不参与告警** —— 混进去就变回「一直报」了');
    ok(TA.settledOf(name, DIR).length === 2, '两轮的留档都在');
  }

  console.log('\n【12】保留区有上限，不是归档');
  {
    const name = 'case13';
    for (let i = 0; i < TA.SETTLED_KEEP + 5; i++) {
      TA.record(name, { at: Date.now(), to: 'JARVIS', preview: `第 ${i} 条` }, DIR);
      TA.take(name, DIR);   // 每记一条就读走一次 —— 模拟每轮 poll
    }
    const kept = TA.settledOf(name, DIR);
    ok(kept.length === TA.SETTLED_KEEP, `留最近 ${TA.SETTLED_KEEP} 条`, String(kept.length));
    ok(kept[0].preview === `第 ${TA.SETTLED_KEEP + 4} 条`,
      '★ 最新的排在最前面 —— 查证据总是从最近一次查起', kept[0].preview);
  }

  console.log('\n【13】★★★ 存活探针不算违规 —— 收到它的人**修不了**它');
  // ── 探针不许被报成 orphan ─────────────────────────────────────────
  //   探针是 poller **写进 agent outbox 目录**的普通文件，于是 relay 眼里
  //   它和 agent 亲手写的一样 ⇒ 会被判成 orphan ⇒ 报给那个 agent。
  //   **而它修不了** —— 那条 outbox 不是它写的。
  //   更糟的是探针周期性重发，所以这个误报会一直回来：
  //   **一个修不掉又反复出现的告警，是训练人忽略告警的最快方式。**
  //
  // ★ 判据：只对「他做得了主的事」告警。
  //
  // ⚠️ 这一节**真调 `probe.maybeSend()` 再读它写出来的文件**，不假设它写了什么 ——
  //   假设的话，哪天有人把那个 `kind` 删掉，这里照样绿。
  {
    const probe = require('../lib/probe');
    const boxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-probebox-'));
    const prevRoot = process.env.ENGLOOP_OUTBOX_ROOT;
    process.env.ENGLOOP_OUTBOX_ROOT = boxRoot;   // 不注入就会往生产 outbox 真发一条
    try {
      const id = probe.maybeSend('probetestcrew', null, Date.now());
      ok(typeof id === 'string', '（前置）探针发出去了', String(id));

      const dir = path.join(boxRoot, 'probetestcrew');
      const files = fs.readdirSync(dir);
      ok(files.length === 1, '（前置）outbox 里有它写的那个文件', String(files.length));
      ok(!fs.existsSync(path.join(__dirname, '..', 'temp', 'outbox', 'probetestcrew')),
        '★★ 注入生效了 —— 生产 outbox 里没有这个假 agent 的目录');

      const entry = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
      // relay 会用白名单过一遍 kind，这里照它的规范化来判 —— 同【2】那条。
      const normalized = ['topic', 'reply', 'notice', 'status'].includes(entry.kind)
        ? entry.kind : undefined;
      ok(TA.isOrphan({ from: 'probetestcrew', kind: normalized, reply_to: entry.reply_to }) === false,
        '★★★ 探针**不算** orphan —— 收到它的人修不了它，报了只会教他忽略告警');

      // ★ 阴性对照：同一条探针**去掉 kind** 之后确实会被报。
      //   没有这一条，上面那条可能只是「什么都不报」。
      ok(TA.isOrphan({ from: 'probetestcrew', kind: undefined }) === true,
        '★★ 对照：拿掉那个 kind，它立刻变回违规 —— 所以上面那条不是恒真');
    } finally {
      if (prevRoot === undefined) delete process.env.ENGLOOP_OUTBOX_ROOT;
      else process.env.ENGLOOP_OUTBOX_ROOT = prevRoot;
      fs.rmSync(boxRoot, { recursive: true, force: true });
    }
  }

  console.log('\n【14】告警文本给的是**对的那一档** —— 引错修法比不给修法更坏');
  {
    const name = 'case14';
    TA.record(name, { at: Date.now(), to: 'JARVIS', preview: 'x' }, DIR);
    const line = TA.alertLine(TA.take(name, DIR));
    ok(line.includes('notice') && line.includes('status'),
      '★★ 两档都给了 —— 只提 notice 的话，'
      + '会把「上线报到」引向错的档', line.slice(-120));
  }

  console.log('\n【15】🚫 这个模块只报告，不替人挂父');
  // 不做「没填就挂到最近那条」。这里守的是行为：
  // 检查一条 orphan 之后，那个对象上不会凭空多出一个 reply_to。
  {
    const msg = sent({});
    TA.isOrphan(msg);
    ok(!('reply_to' in msg), '★★ isOrphan 没有给它补上 reply_to');

    const name = 'case11';
    TA.record(name, { at: Date.now(), to: 'JARVIS', preview: 'x' }, DIR);
    const line = TA.alertLine(TA.take(name, DIR));
    ok(/不会|绝不|🚫/.test(line), '★ 告警文本里明说了系统不会替他挂');
  }

  // ⚠️ 这一行的格式是**协议**，不是排版：`test/run-all.js` 用
  //   `/通过 (\d+) · 失败 (\d+)/` 提取成绩。写成「通过 N，失败 M」的话它匹配不到，
  //   于是这个文件被判成「没报出总数 = 在打印总结前就退出了」并计入未通过 ——
  //   **一个全绿的文件在全量报告里显示成红的**，而原因只是一个逗号。
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  process.exit(fail ? 1 : 0);
}

main();
