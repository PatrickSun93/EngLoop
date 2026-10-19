'use strict';

/**
 * 「任务完成 → 桌面通知 + 🏁」这条链路的**接线**。
 *
 * ── 这个文件守的是什么 ──────────────────────────────────────────
 * 行为那一半已经被真正执行的测试守住了：
 *   · `test/threads.test.js` 【9】 —— 判据 `isDone` 的规范化和正交性
 *   · `test/relay.test.js`   【12】 —— done 透传 + 🏁 打在 thread 根上（端到端）
 *   · `test/reactions.test.js`【1】 —— 🏁 必须留在 A 档
 *
 * **剩下的一半在浏览器里，没有任何测试 require 得动它。** 而这一半恰好是
 * 「弹不弹通知」——它坏掉的样子是**什么都不发生**：没有报错、没有红标签、
 * 刷新也变不出来。人只会觉得「这次它大概没报完成吧」。
 *
 * ⚠️ 所以这里是**源码断言**（读文件 + 正则），边界要说清楚：
 *   它验的是「这几处接线还在」，**不是「通知真的弹得出来」**。
 *   Notification 是浏览器 API，node 里没有它。
 *   （同 `web-syntax.test.js` 那条边界：那个文件验的是「能不能解析」，
 *     不是「跑起来对不对」。两个文件加起来仍然不等于前端被测了。）
 *
 * 单跑：`node test/done-notify.test.js`
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const SERVE = fs.readFileSync(path.join(ROOT, 'bin/serve.js'), 'utf8');
const NEXT = fs.readFileSync(path.join(ROOT, 'bin/next.js'), 'utf8');
const TPL = fs.readFileSync(path.join(ROOT, 'templates/dev/CLAUDE.md'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

function main() {
  console.log('\n【1】前端：done 消息触发 onDoneMessage');
  {
    ok(/function onDoneMessage\(m, scope\)/.test(APP),
      'onDoneMessage 存在，并且收 scope（私聊和房间是两个 id 空间）');

    // ★★ **两条路径都要调** —— 只接私聊的话，房间里报的完成静默无通知，
    //   而那正好是「什么都不发生」那一类：没人会收到「你漏了一处」的提示。
    ok(/onDoneMessage\(m, 'dm'\)/.test(APP), "★★ WS 私聊那条路径调了（'dm'）");
    ok(/onDoneMessage\(m, 'room'\)/.test(APP), "★★ WS 房间那条路径调了（'room'）");

    // ★ 判据只有一处出处。前端自己写 `m.done === true` 的话，
    //   从流里读回来的字符串 'true' 会被判成 false —— **刷新之后就不弹了**。
    ok(/Threads\.isDone\(/.test(APP), '★ 前端走 Threads.isDone，不自己写判据');
    ok(!/\bm\.done\s*===\s*true/.test(APP),
      "★★ 前端**没有**私判 `m.done === true`（那会漏掉流里的字符串 'true'）");
  }

  console.log('\n【2】前端：权限**不许**自动请求');
  {
    // ★★★ Chrome 会把非用户手势触发的 requestPermission() 直接判成 denied，
    //   而 denied 之后**页面自己再也要不回来** —— 用户得去浏览器设置里手动改。
    //   一次「省事」的自动请求，代价是这个功能对这台机器上的这个站点永久失效。
    ok(/function askNotify\(/.test(APP), 'askNotify 存在（点按钮才走这里）');
    const reqCount = (APP.match(/requestPermission\(/g) || []).length;
    ok(reqCount === 1,
      '★★★ 全文件只有**一处** requestPermission —— 多出来的那处几乎必然在初始化路径',
      `实际 ${reqCount} 处`);
    ok(/\$\('notify-btn'\)\.onclick = askNotify/.test(APP),
      '★ 按钮绑到了 askNotify');
    ok(/<button id="notify-btn"/.test(HTML), '★ index.html 里有这个按钮');

    // 启动段只 render 状态，不请求。
    ok(/renderNotifyBtn\(\);\s*\n\s*loadDmHistory/.test(APP),
      '★★ 启动时只渲染按钮状态（renderNotifyBtn），没有顺手请权限');
  }

  console.log('\n【3】前端：三种「不弹」要分得开');
  {
    // 它们的下一步动作完全不同：换浏览器 / 点按钮 / 去浏览器设置。
    // 压成一个「✕」的话，被拒过的人会一直点那个已经没用的按钮。
    for (const st of ['unsupported', 'granted', 'denied', 'default']) {
      ok(new RegExp(`\\b${st}:`).test(APP), `按钮文案区分了 ${st}`);
    }
  }

  console.log('\n【4】前端：🏁 要立刻可见，不能等刷新');
  {
    // ★★ thread 的根早就渲染过 ⇒ 它的反应条一定在 reactCache 里 ⇒
    //   `renderReactions` 命中缓存就不再请求 ⇒ 后端刚打的 🏁 永远等不到重查。
    //   症状：通知弹了、消息也到了，就是没有标记，F5 一下它又在了。
    ok(/reactCache\.delete\(k\)/.test(APP),
      '★★ 收到完成报告时让那个锚点的反应缓存失效');
    ok(/reactWanted\.add\(k\)[\s\S]{0,80}scheduleReactFetch\(\)/.test(APP),
      '★★ 失效之后重新登记并触发拉取（光删缓存等于把反应条清空）');
    // anchor 算法必须跟 lib/relay.js 打标那处一致，否则查的锚点后端没打过。
    ok(/m\.reply_to \|\| anchorOf\(m, scope\)/.test(APP),
      '★★★ anchor = reply_to || 自己 —— 跟 relay 打标那处是同一个算法');
  }

  console.log('\n【5】后端：WS 推送带 done');
  {
    // 漏了它的症状比别的字段遗漏（room_hash / reply_to / kind / expects_reply）
    // 都轻微：只是通知不弹。没有错位、没有红标签、刷新也变不出来。
    ok(/done: threads\.isDone\(m\)/.test(SERVE),
      '★★ broadcast 里带 done，且过判据函数（流里读回来是字符串）');
    ok(!/done: m\.done/.test(SERVE),
      "★ **没有**原样透传 m.done（那会把字符串 'true' 丢给前端）");
  }

  console.log('\n【5b】★★★ 两条路径都要能到浏览器');
  {
    // ★★★ `deliverLoop` 只读 `orch:out`（编排者发出的）。agent 发给编排者的
    //   消息走 `orch:in:agent` —— 不接这一路的话它**结构上不经过任何 broadcast**。
    //   后果：agent 报完成、🏁 打上了（后端做的），**桌面通知一次都不弹**。
    //   而 Playwright 断言照样全绿 —— 它们跑在另一条平行路径上。
    ok(/const CREW_IN = 'orch:in:agent'/.test(SERVE),
      '★★★ bus 读 orch:in:agent（agent → 编排者 那条流）');
    ok(/async function crewInLoop\(/.test(SERVE) && /\n  crewInLoop\(\);/.test(SERVE),
      '★★ crewInLoop 定义了**而且真的被调用**（定义了不调用是这一类的经典漏法）');

    // ★★ group 必须从 '$' 建。`q.ensureGroup` 用的是 '0' —— 那会在**第一次
    //   部署的那一瞬间**把整条流的历史全推一遍，每条带 done 的都弹一个通知。
    //   ⚠️ 这个错测不出来、只坑一次，而那一次正好是人第一次看到这个功能。
    ok(/xgroup\('CREATE', CREW_IN, CREW_IN_GROUP, '\$'/.test(SERVE),
      "★★★ agent-in 的消费者组从 '$' 建（用 ensureGroup 的 '0' 会把历史全推一遍）");
    ok(!/ensureGroup\([^)]*CREW_IN/.test(SERVE),
      '★★ 没有拿 ensureGroup 建这个组');

    // 两条路径的 broadcast 字段必须一致 —— 前端是同一个 case 分支处理它们，
    // 少给一个字段 = 两条路径行为分叉，表现是「agent 的消息跟我的长得不一样」。
    // ⚠️ 窗口开到 2500：deliverLoop 那条 broadcast 中间夹着大段注释，
    //   600 字符切不到它的收尾 `});`，于是只匹配到一条 —— 而下面那句
    //   `every(...)` 在只有一条时**恒真**。两条断言一起绿，实际只验了一半。
    const broadcasts = SERVE.match(/broadcast\(\{ type: 'message'[\s\S]{0,2500}?\}\);/g) || [];
    ok(broadcasts.length === 2, '★ 恰好两条 message 广播路径', `实际 ${broadcasts.length}`);
    ok(broadcasts.every((b) => /done: threads\.isDone\(m\)/.test(b)),
      '★★★ 两条路径**都**带 done，且都过判据函数');
    for (const f of ['from:', 'text:', 'job_id:', 'reply_to:', 'kind:']) {
      ok(broadcasts.every((b) => b.includes(f)), `两条路径都带 ${f.replace(':', '')}`);
    }
    // ★★ `sender_type` —— 只有 /api/messages 带、实时推送不带的话
    //   ⇒ 核验跟帖实时认不出、刷新后才合并。字段名必须从 stamp 取。
    ok(broadcasts.every((b) => /\[stamp\.SENDER_FIELD\]: m\[stamp\.SENDER_FIELD\]/.test(b)),
      '★★ 两条路径都带 sender_type，且字段名走 stamp.SENDER_FIELD');
    ok(broadcasts.every((b) => !/\bsender_type:/.test(b)),
      '★ 两条路径都**没有**写死 `sender_type:` 字符串（改名那天会静默漏一处）');
  }

  console.log('\n【5c】★★★ 编排者自己也要看得见 done（消费侧白名单）');
  {
    // ★★★ `bin/next.js` 给 agent 展示消息的那份白名单是**手工列的**，
    //   跟 relay 那份是两份各自维护的东西。漏在这一侧的话：
    //   agent 标了 done，编排者**看不见**。
    //
    //   ⚠️ 它的后果不是「少个字段」，是**判据失效**：编排者分不清
    //   「它没标」和「它标了但我看不到」—— 两种在他眼前都是安静。
    //   于是纠正只会朝一个方向偏：**只会误报「你漏标了」**，冤枉做对了的 agent。
    ok(/done: threads\.isDone\(m\) \|\| undefined/.test(NEXT),
      '★★★ next.js 把 done 透传给 agent（漏了它，编排者的纠正会系统性偏向误报）');
    ok(/require\('\.\.\/web\/threads\.js'\)/.test(NEXT),
      '★ 判据走同一个 threads.isDone，不自己写第二份');
  }

  console.log('\n【6】agent 模板里写了这件事');
  {
    // 不写进模板的话，只有「派活时被提醒过的那些 agent」会标 —— 重启就忘。
    ok(/"done"\s*:\s*true/.test(TPL), 'dev 模板里给了 done 的写法');
    ok(/只在真做完时标|一律不标/.test(TPL),
      '★★ 模板明写「进度不要标」—— 假通知会让人关掉通知，那时真完成也收不到');
    ok(/🏁[\s\S]{0,200}✅/.test(TPL),
      '★ 模板说清了 🏁（它说完了）和 ✅（人验收了）不是一回事');
  }

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
