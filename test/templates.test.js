'use strict';

/**
 * agent 模板自检。**遍历 `templates/` 下每一个类型**，不是给每个类型写一份。
 *
 * ── 为什么是遍历 ────────────────────────────────────────────────
 * 给每个类型写一份的话，第四个类型出现时很可能就没人写了 —— 而那个没人写的
 * 就是漏网的那个。遍历意味着**新加一个模板目录，这些检查自动覆盖到它**。
 * 「不给例外开口子，比处理例外更省事。」
 *
 * ── 守的是什么 ──────────────────────────────────────────────────
 * **同一件事写在两个地方，迟早分叉，而分叉的那天不会有人发现** ——
 * 两边都在「正常工作」，只是准许的东西不一样了。
 * 例：协议里写着 `find` 被禁，settings.json 的 allow 列表里 find 却是允许的。
 *
 *   · `lib/agent-capabilities.js` 说这个类型有没有 web / 有没有 bash
 *   · `templates/<type>/.claude/settings.json` 是实际生效的那份
 * 不一致 = 能力分离在纸面上成立、运行时不成立。
 *
 * ★ 模板是给 LLM 读的文本，**没有任何东西会因为它写错而在运行时报错**。
 *   所以能测的部分要测狠一点 —— 尤其**自相矛盾**：一份模板要是同时写着
 *   「你没有 Bash」和「跑 node bin/next.js」，一个没有 Bash 的 agent 跑不了
 *   node，它会卡住，而且不知道为什么。
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  CAPABILITIES, allowedToolsFor, disallowedToolsFor,
} = require('../lib/agent-capabilities');

const ROOT = path.join(__dirname, '..');
const TPL_ROOT = path.join(ROOT, 'templates');
const WEB_TOOLS = ['WebSearch', 'WebFetch', 'Fetch'];

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const types = fs.readdirSync(TPL_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();

function main() {
  console.log(`\n【1】发现 ${types.length} 个模板: ${types.join(', ')}`);
  ok(types.length > 0, '至少有一个模板');
  for (const t of types) {
    ok(CAPABILITIES[t] !== undefined,
      `${t} 在能力表里有登记`,
      '模板目录存在但 lib/agent-capabilities.js 里没有这个类型 —— 起它时会被拒');
    ok(fs.existsSync(path.join(TPL_ROOT, t, 'CLAUDE.md')), `${t} 有 CLAUDE.md`);
  }

  console.log('\n【2】★ settings.json 必须跟能力表一致（防两份配置漂移）');
  for (const t of types) {
    const sp = path.join(TPL_ROOT, t, '.claude', 'settings.json');
    if (!fs.existsSync(sp)) {
      // 没有 settings 不算错（orchestrator 那份还没排到），但要说出来 ——
      // **没有权限配置 = 没有工具级约束**，这件事不该悄无声息
      console.log(`  · ${t} 没有 .claude/settings.json（无工具级约束，待排期）`);
      continue;
    }
    const cfg = JSON.parse(fs.readFileSync(sp, 'utf8'));
    const caps = CAPABILITIES[t];
    const allow = cfg.permissions.allow || [];
    const deny = cfg.permissions.deny || [];

    if (caps.bash) {
      ok(allow.includes('Bash'), `${t}: 能力表说有 bash → allow 里有 Bash`);
      ok(!deny.includes('Bash'), `${t}: 有 bash → deny 里没有 Bash`);
    } else {
      ok(!allow.includes('Bash'), `${t}: 能力表说没有 bash → allow 里没有 Bash`);
      ok(deny.includes('Bash'),
        `★ ${t}: 没有 bash → Bash 还要**显式** deny（说出来的禁令比没说出来的默许可靠）`);
    }

    const allowedWeb = WEB_TOOLS.filter((w) => allow.includes(w));
    const deniedWeb = WEB_TOOLS.filter((w) => deny.includes(w));
    if (caps.web) {
      ok(allowedWeb.length > 0, `${t}: 能力表说有 web → allow 里有 web 工具`);
      ok(deniedWeb.length === 0, `${t}: 有 web → 没有被 deny 掉`, deniedWeb.join(','));
    } else {
      ok(allowedWeb.length === 0, `${t}: 能力表说没有 web → allow 里没有 web 工具`, allowedWeb.join(','));
      ok(deniedWeb.length === WEB_TOOLS.length,
        `★ ${t}: 没有 web → 三个 web 工具全部显式 deny`,
        `只 deny 了 ${deniedWeb.join(',') || '零个'}`);
    }
  }

  console.log('\n【2b】★★ 逐个工具核对两份配置 —— 检查面跟着配置长，不靠人记得回来加');
  // ── 为什么上面【2】不够 ────────────────────────────────────────────
  //
  // 【2】声称守的是「防两份配置漂移」，**但它只查 Bash 和三个 web 工具** ——
  // 而漂移完全可能出在 **Write / Edit / NotebookEdit** 上：
  //
  //   · `agent-capabilities.js` 的 BASE_TOOLS **给了** eval 一个 Write
  //   · `templates/eval/.claude/settings.json` **deny 了** Write
  //
  // **两份配置对同一个工具给出相反的答案，而【2】全绿。**
  //
  // 这不是「断言写错了」——【2】的每一条都是对的。**它是「检查面比它声称的窄」**：
  // 断言没问题，但它只看了配置的一部分。而**没看的那部分可能正是出事的那部分**。
  //
  // ★ 所以这一节不是「把那三个工具名加进去」——那样下次多一个工具，
  //   同一个洞会再开一次。**它遍历两份配置的并集**：任何一边新增一个工具，
  //   检查面自动跟着长，**不需要任何人记得回来改这里。**
  //
  // ⚠️ 判据是**结论一致**，不是「两份写法一样」：
  //   命令行那份用「白名单 + 黑名单」表达，settings 那份用「allow + deny」表达。
  //   同一个工具在两套语言里问的都是同一个问题：**这个类型到底能不能用它。**
  for (const t of types) {
    const sp = path.join(TPL_ROOT, t, '.claude', 'settings.json');
    if (!fs.existsSync(sp)) continue;
    const cfg = JSON.parse(fs.readFileSync(sp, 'utf8'));
    const allow = cfg.permissions.allow || [];
    const deny = cfg.permissions.deny || [];

    const cliAllow = String(allowedToolsFor(t) || '').split(',').filter(Boolean);
    const cliDeny = String(disallowedToolsFor(t) || '').split(',').filter(Boolean);

    // 并集 = 两份配置里出现过的每一个工具名
    const every = [...new Set([...allow, ...deny, ...cliAllow, ...cliDeny])].sort();
    ok(every.length > 0, `${t}: 两份配置里至少提到过一个工具（否则这一节什么都没查）`);

    const disagree = [];
    for (const tool of every) {
      // 「settings 那份准不准」：deny 优先于 allow（settings.json 的语义）
      const bySettings = deny.includes(tool) ? false : (allow.includes(tool) ? true : null);
      // 「命令行那份准不准」：disallowed 优先（它才是真正起作用的那层）
      const byCli = cliDeny.includes(tool) ? false : (cliAllow.includes(tool) ? true : null);

      // null = 那一份没表态。**没表态不算矛盾** —— 两份配置的覆盖面本来就不同，
      // 强求「都必须提到」会把一堆无害的差异报成错，那种噪音会训练人忽略这一节。
      if (bySettings !== null && byCli !== null && bySettings !== byCli) {
        disagree.push(`${tool}（settings=${bySettings ? '给' : '禁'} / 命令行=${byCli ? '给' : '禁'}）`);
      }
    }
    ok(disagree.length === 0,
      `★★ ${t}: 两份配置对每一个工具的结论一致`,
      `矛盾项：${disagree.join('；')}`);
  }

  console.log('\n【3】★ hook 挂上了，而且指向真实存在的脚本');
  for (const t of types) {
    const sp = path.join(TPL_ROOT, t, '.claude', 'settings.json');
    if (!fs.existsSync(sp)) continue;
    const raw = fs.readFileSync(sp, 'utf8');
    const cfg = JSON.parse(raw);
    ok(cfg.hooks && cfg.hooks.PreToolUse, `${t}: PreToolUse hook 已挂`);
    ok(!('_pending_hooks' in cfg),
      `${t}: 没有残留的 _pending_hooks（挂上了就该把备用副本去掉，否则两份会分叉）`);
    const cmd = JSON.stringify(cfg.hooks && cfg.hooks.PreToolUse);
    ok(/check_security\.js/.test(cmd), `${t}: 指向 check_security.js`);
    // 占位符替换后要指向一个真实存在的文件 —— 指错了 hook 静默不生效
    ok(fs.existsSync(path.join(ROOT, 'hooks', 'check_security.js')),
      `${t}: hooks/check_security.js 真的存在`);
    const matcher = (cfg.hooks.PreToolUse[0] || {}).matcher || '';
    ok(/Bash/.test(matcher) && /WebFetch/.test(matcher),
      `${t}: matcher 覆盖 Bash 和 WebFetch`, matcher);
  }

  console.log('\n【4】★ CLAUDE.md 不能自相矛盾');
  /** 这个词可以出现，但出现它的每一行都必须带否定。 */
  function onlyNegated(md, needle, label) {
    const hits = md.split('\n').filter((l) => l.includes(needle));
    const bad = hits.filter((l) => !/不要|不需要|做不到|不该|❌|没有/.test(l));
    ok(bad.length === 0, label, bad.join(' | '));
  }
  for (const t of types) {
    const md = fs.readFileSync(path.join(TPL_ROOT, t, 'CLAUDE.md'), 'utf8');
    const caps = CAPABILITIES[t];

    // ── ★ 按 `resident` 分，不按 `bash` 分 ──────────────────────────
    //
    // 不写成「有 bash ⇒ 必须有 poller 循环」。**那只在 dev/eval
    // 两个样本上碰巧成立**：dev 有 bash 且常驻、eval 无 bash 且一次性，
    // **两个独立维度在这两个样本上恰好完全相关，于是断言拿「能力」当了
    // 「形态」的代理。** test/solve/write 三个「有 bash 的 worker」一来就散了。
    //
    // ★★ 而且 `/bin\/next\.js/.test(md)` 这种判据**会给假绿**——
    //   它只检查那个字符串出现过。**明确禁止** poller 的 worker 模板
    //   （里面写着「不要碰 `bin/next.js`」）会让一条名叫「有 poller 循环」的
    //   断言全绿。**断言的名字说的是「有」，实际验的是「提到过」——
    //   而「禁止」也是一种提到。**
    //
    // 所以两边都用「说的是这件事」级别的判据：
    //   · 常驻 → **查命令行参数**（`--group` / `--streams`）。
    //     禁止句里不会带参数 —— 那是个硬判据，不靠语义、不靠语气。
    //     （不查「语气是不是肯定的」：那种判断靠正则很脆。）
    //   · worker → 复用 `onlyNegated()`：出现该词的每一行都必须带否定。
    if (caps.resident) {
      ok(/--group/.test(md) && /--streams/.test(md),
        `★ ${t}(常驻): poller 循环是**真的一条能跑的命令**（带 --group / --streams 参数）`,
        '只提到 bin/next.js 不算 —— 禁止句里也会提到它');
    } else {
      // worker 不该被要求跑 poller。用「只能出现在否定句里」而不是「不许出现」：
      // 模板里那句「**不要**碰 bin/next.js」恰恰是对的，粗断言会逼着人删掉它。
      onlyNegated(md, 'bin/next.js',
        `★ ${t}(worker): poller 只出现在「不要跑」的句子里`);
    }

    // ── 能力那一维单独查，不再跟形态搅在一起 ──
    if (!caps.bash) {
      ok(/没有 Bash/.test(md), `${t}(无 bash): 明确告诉它自己没有 Bash`);
    }

    // ── ★★ 有 Bash 的 worker：那句禁令是**仅有的一道防线**，理由必须写在模板里 ──
    //
    // eval 也被告知「不要跑 poller」，但**它没有 Bash，想跑也跑不了** ——
    // 能力本身兜住了底。**有 Bash 的 worker 想跑就真能跑起来**，而一旦跑起来
    // 它会真的从队列里领走一条本该给别人的消息，滞留 60 秒，**且没有任何报错**。
    //
    // > **同一句禁令，在 eval 那里是双保险的第二道，在这三个类型这里是唯一一道 ——
    // >   而文本一模一样。从字面上完全看不出区别，删掉它的人会以为删的是一句提醒。**
    //
    // 所以理由必须长在**会被读到的地方**：worker 只读自己那份 CLAUDE.md，
    // 它不会去读 `agent-capabilities.js` 的注释，也不知道 eval 那份长什么样。
    if (!caps.resident && caps.bash) {
      ok(/唯一的那道防线|唯一一道防线/.test(md) && /Bash/.test(md),
        `★★ ${t}(有 bash 的 worker): 写明了「不要跑 poller」对它是**唯一**的防线`,
        '只写禁令不写理由 —— 下一个人会以为那只是一句提醒');
    }
  }

  console.log('\n【5】占位符跟 provision() 支持的那套对得上');
  const SUPPORTED = ['{{AGENT_NAME}}', '{{ORCH}}', '{{ENGLOOP}}', '{{GROUP}}', '{{STREAM}}', '{{CWD}}'];
  for (const t of types) {
    const used = new Set();
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else for (const m of fs.readFileSync(p, 'utf8').matchAll(/\{\{[A-Z_]+\}\}/g)) used.add(m[0]);
      }
    };
    walk(path.join(TPL_ROOT, t));
    const bad = [...used].filter((u) => !SUPPORTED.includes(u));
    ok(bad.length === 0, `${t}: 没有 provision 不认识的占位符（否则 agent 读到字面的 {{XXX}}）`, bad.join(','));
  }

  console.log('\n【6】能力的唯一数据源只有一份');
  for (const t of types) {
    const bad = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (!p.endsWith('settings.json') && /"(capabilities|bash|web)"\s*:/.test(fs.readFileSync(p, 'utf8'))) bad.push(p);
      }
    };
    walk(path.join(TPL_ROOT, t));
    ok(bad.length === 0, `${t}: 没有第二份能力声明（唯一数据源是 lib/agent-capabilities.js）`, bad.join(','));
    // agent_info.json 故意不存在 —— 不实现类型自动发现就不建它。
    // 这条守着「别好心把它加回来」：别处的文字里可能还写着「靠 agent_info.json 自动发现」。
    ok(!fs.existsSync(path.join(TPL_ROOT, t, 'agent_info.json')),
      `${t}: 没有 agent_info.json（没有读者的文件 = 没接线）`);
  }

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
