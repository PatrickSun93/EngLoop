'use strict';

/**
 * 模板类型自动发现。
 *
 * ── 这个文件里有一条会红的接线断言（【5】）──────────────────────
 * 发现机制写出来只是一半。**另一半是「有没有人用它」** —— 而最容易漏的
 * 正是后一半。所以【5】直接断言那两处生产提示**真的用了发现机制**，
 * 没用的话它是红的。
 * ────────────────────────────────────────────────────────────────
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const td = require('../lib/template-discovery');
const { discoverTypes, usableTypesHint } = td;
const { CAPABILITIES } = require('../lib/agent-capabilities');

const ROOT = path.join(__dirname, '..');
const TPL_ROOT = path.join(ROOT, 'templates');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

/** 造一个假的 templates 根目录，内容由调用方给。 */
function fakeTemplates(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-tpl-'));
  for (const [type, files] of Object.entries(spec)) {
    fs.mkdirSync(path.join(dir, type), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, type, name), content);
    }
  }
  return dir;
}

function main() {
  console.log('\n【1】真扫仓库里的 templates/');
  {
    const d = discoverTypes();
    ok(Array.isArray(d.usable) && d.usable.length > 0, '发现了可用类型', JSON.stringify(d));
    ok(d.usable.includes('dev'), 'dev 可用（有模板 + 在能力表里）');
    ok(d.usable.includes('eval'), 'eval 可用');
    for (const t of d.usable) {
      ok(fs.existsSync(path.join(TPL_ROOT, t)), `${t} 的模板目录真的存在`);
      ok(CAPABILITIES[t] !== undefined, `${t} 在能力表里真的有登记`);
    }
  }

  console.log('\n【2】★ usable ≠ 能力表的键 —— 这正是当前那个缺陷');
  {
    // ── 守的是什么 ────────────────────────────────────────────────
    // 能力表有 6 个类型，templates/ 下只有 2 个目录。两处生产代码把
    // 前者当成「可选类型」告诉用户 —— **于是用户被告知可以起 solve，
    // 实际起会抛「没有模板目录」。**
    //
    // ⚠️ 这一条**不是**断言「usable 一定比能力表短」。哪天三个模板补齐了，
    //   两者会相等，那时它该绿而不是红 —— 所以判据写成「usable ⊆ 能力表
    //   且每一个都真有模板」，那是**永远该成立的关系**，不是此刻的数量差。
    //   （把此刻的现状钉进断言，等于让补齐模板这件正确的事变红。）
    const d = discoverTypes();
    const known = Object.keys(CAPABILITIES);
    ok(d.usable.every((t) => known.includes(t)),
      '★ usable 是能力表的子集 —— 发现机制不会凭空造出没登记的类型');
    ok(d.usable.every((t) => fs.existsSync(path.join(TPL_ROOT, t))),
      '★ usable 里每一个都真有模板目录 —— 不会告诉用户一个起不来的类型');
    ok(d.missingTemplate.every((t) => !fs.existsSync(path.join(TPL_ROOT, t))),
      '★ missingTemplate 里的确实都没有模板目录');
    // 现状记录（不是断言）：orchestrator 故意没有模板（编排者是手工起的），
    // test/solve/write 是还没建。**发现机制只报事实，「哪些缺失可接受」是
    // 策略，不该硬编码进来。**
    console.log(`  · 当前缺模板的类型：${d.missingTemplate.join(', ') || '（无）'}`);
  }

  console.log('\n【3】★★ fail-closed：读不到就抛，绝不返回空数组');
  {
    // ── 这一节是整个模块最要紧的地方 ──────────────────────────────
    // 「一个模板都没有」是一个**完全合法的答案**。读不到目录时返回空数组，
    // 调用方分不清「真的没有」和「发现机制坏了」，然后照着空列表告诉用户
    // 「可选：」后面什么都没有。
    //
    // `lib/tmux.js` 的 list() 要是这么做，watchdog 就会误判健康的 agent：
    // **命令失败 → 返回空数组 → 上层理解成「没有会话」→ 一个合法的答案。**
    let threw = null;
    try {
      discoverTypes({ templatesDir: path.join(os.tmpdir(), 'engloop-no-such-dir-xyz') });
    } catch (e) { threw = e; }
    ok(threw !== null,
      '★★ 目录不存在 → 抛异常（返回空数组的话，调用方会把「坏了」当成「没有」）');
    ok(/读不到/.test(String(threw && threw.message)),
      '★ 而且说得出是「读不到」，不只是「失败了」', String(threw && threw.message));

    // 目录在、但一个子目录都没有 —— 同样是坏了，不是合法的空。
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-tpl-empty-'));
    let threw2 = null;
    try { discoverTypes({ templatesDir: emptyRoot }); } catch (e) { threw2 = e; }
    ok(threw2 !== null,
      '★★ 根目录存在但一个类型目录都没有 → 也抛（部署坏了，不是「合法的空」）');
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }

  console.log('\n【4】三类不一致各自认得出来');
  {
    // 用假 templates 根目录造出三种情况，**每种都先证明造的确实是这一种**。
    const dir = fakeTemplates({
      dev: { 'CLAUDE.md': 'x' },              // 两边都齐 → usable
      nosuchtype: { 'CLAUDE.md': 'x' },       // 有模板、能力表没有 → missingCapability
      eval: {},                               // 有目录但是空的 → empty
    });
    ok(fs.existsSync(path.join(dir, 'nosuchtype')) && CAPABILITIES.nosuchtype === undefined,
      '（造）nosuchtype 确实有目录、且确实不在能力表里');
    ok(fs.readdirSync(path.join(dir, 'eval')).length === 0,
      '（造）eval 目录确实是空的');

    const d = discoverTypes({ templatesDir: dir });
    ok(d.usable.includes('dev'), 'dev → usable');
    ok(d.missingCapability.includes('nosuchtype'),
      '★ 有模板但能力表没登记 → missingCapability（起它会被 isKnownType 拒）');
    ok(d.empty.includes('eval'),
      '★ 目录空的 → empty，而不是 usable（判据跟 provision() 对齐：它对空目录抛）');
    ok(!d.usable.includes('eval'),
      '★★ 空目录**不算**可用 —— 「发现说可用、下发却抛异常」是最难查的那种不一致');
    ok(d.missingTemplate.includes('solve'),
      '★ 能力表有、这个假根目录里没有 → missingTemplate');

    // 给人看的那一行要把不一致说出来，不能沉默地少几个类型
    const hint = usableTypesHint({ templatesDir: dir });
    ok(hint.includes('dev'), '提示里有可用类型');
    ok(hint.includes('solve'),
      '★ 提示里**点名**了「缺模板起不来」的类型 —— 沉默消失比没提过更难查',
      hint);
    ok(hint.includes('nosuchtype'), '★ 也点名了「有模板但没登记」的', hint);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n【6】★★ 多根目录：模板不再只在本仓库');
  // ── 为什么需要它 ────────────────────────────────────────────────
  // 外部平台的角色定义在**它自己的仓库**里。不支持多根的话，
  // 那些目录得长在 EngLoop 仓库里，**每接一个平台就长一批**。
  //
  // 选多根而不是「一个根放软链」的三条理由：
  //   ① 软链会把 realpath 那个坑引到这条路上（`lib/docs.js` 里有同一个坑）
  //   ② git 里看不出软链指向哪 —— 换台机器就断，而断的样子跟
  //      「这个角色不存在」同形
  //   ③ 多根是显式配置**可以被测试断言**；软链是文件系统层的隐式依赖
  {
    const a = fakeTemplates({ dev: { 'CLAUDE.md': 'x' } });
    const b = fakeTemplates({ review: { 'CLAUDE.md': 'y' }, solve: { 'CLAUDE.md': 'z' } });

    const d = discoverTypes({ roots: [a, b] });
    ok(d.usable.includes('dev') && d.usable.includes('review') && d.usable.includes('solve'),
      '★★ 两个根里的类型合并到一起', JSON.stringify(d.usable));
    ok(d.dirOf.dev === a && d.dirOf.review === b,
      '★★ 记得住每个类型来自哪个根 —— **provision 要靠它去对的地方拷**',
      JSON.stringify(d.dirOf));
    ok(td.templateDirFor('review', { roots: [a, b] }) === path.join(b, 'review'),
      '★ templateDirFor 给出完整路径');
    ok(td.templateDirFor('nosuch', { roots: [a, b] }) === null, '★ 没有的类型 → null');

    // ★★ 同名冲突：先声明的赢，**但必须说出来**。
    const c = fakeTemplates({ dev: { 'CLAUDE.md': '另一份 dev' } });
    const dc = discoverTypes({ roots: [a, c] });
    ok(dc.dirOf.dev === a, '★ 先声明的根赢');
    ok(dc.conflicts.length === 1 && dc.conflicts[0].name === 'dev'
       && dc.conflicts[0].chosen === a && dc.conflicts[0].shadowed === c,
      '★★ 冲突进**返回值**，不只是日志 —— bus 是 detached 起的，console 没人看。'
      + '选错的后果是一个 agent 用了别人的定义在跑，**而它看起来完全正常**',
      JSON.stringify(dc.conflicts));
    ok(/同名模板/.test(usableTypesHint({ roots: [a, c] })),
      '★ 提示行里也说了', usableTypesHint({ roots: [a, c] }));

    // ★★ 一个根读不到：**不致命，但不许静默**
    const ghost = path.join(os.tmpdir(), `engloop-nonexistent-${Date.now()}`);
    const dm = discoverTypes({ roots: [a, ghost] });
    ok(dm.usable.includes('dev'),
      '★★ 一个根读不到，另一个照常给出答案 —— 外部平台仓库没克隆不该让整个系统起不来');
    ok(dm.unreadableRoots.length === 1 && dm.unreadableRoots[0].root === ghost,
      '★★ 但读不到的根**进返回值** —— 少一个根会让某些类型静默地不在列表里，'
      + '而「这个类型不存在」和「放它的仓库没克隆」是两件事',
      JSON.stringify(dm.unreadableRoots));
    ok(/读不到/.test(usableTypesHint({ roots: [a, ghost] })),
      '★★ 提示行点名了 —— 否则人会以为那些类型不存在',
      usableTypesHint({ roots: [a, ghost] }));

    // ★★ 全部读不到 → 抛（fail-closed 没被多根削弱）
    let threw = false;
    try { discoverTypes({ roots: [ghost, `${ghost}-2`] }); } catch (_) { threw = true; }
    ok(threw,
      '★★ **所有**根都读不到 → 照样抛。多根不能把 fail-closed 削弱成「尽力而为」');

    for (const dir2 of [a, b, c]) fs.rmSync(dir2, { recursive: true, force: true });
  }

  console.log('\n【6b】★ 配置从 env 来，没配 = 跟以前完全一样');
  {
    ok(td.defaultRoots({}).length === 1 && td.defaultRoots({})[0] === td.TPL_ROOT,
      '★★ 没设环境变量 → 只有本仓库的 templates/（**行为跟以前一字不差**）');

    const two = td.defaultRoots({ [td.ROOTS_ENV]: `/a${path.delimiter}/b` });
    ok(two.length === 2 && two[0] === '/a' && two[1] === '/b',
      `★ 用 path.delimiter（"${path.delimiter}"）分隔，跟 PATH 一个习惯`,
      JSON.stringify(two));
    ok(td.defaultRoots({ [td.ROOTS_ENV]: '  ' }).length === 1,
      '★ 空白值回落到默认，不是「零个根」（那会让全部类型消失）');
    ok(td.defaultRoots({ [td.ROOTS_ENV]: `/a${path.delimiter}${path.delimiter}/b` }).length === 2,
      '★ 连续分隔符不产生空路径项');

    // ★ 老参数 templatesDir 必须还能用 —— 一堆测试在用它。
    //   删掉等于让「为了可测」的入参变成一次破坏性变更。
    const t = fakeTemplates({ dev: { 'CLAUDE.md': 'x' } });
    ok(discoverTypes({ templatesDir: t }).usable.includes('dev'),
      '★★ 老参数 `templatesDir`（单个）仍然可用 —— 不做破坏性变更');
    ok(td.resolveRoots({ templatesDir: t }).length === 1, '★ 它被归一成单元素数组');
    fs.rmSync(t, { recursive: true, force: true });
  }

  console.log('\n【5】★ 接线：两处「可选：」提示真的换成发现机制了');
  {
    // ── 判据不是「函数写出来了」，是「生产路径上有没有人用」 ──────────
    //
    // 最容易漏的是后一半 —— 函数写好、单测传参数就绿、
    // **没有任何东西断言真实调用方用了它**。所以这一节直接读那两个文件。
    //
    // ⚠️ 静态断言在这里是**唯一可行**的做法，而且它弱：
    //   两处提示都在错误分支里（类型不认识时才打印），要走到它得起一个
    //   真 agent 并故意传错类型 —— 而 agent-start 会真的开 tmux 会话。
    //   **代价不成比例，所以这里退回读源码。** 明说它验不了什么：
    //   **它验不了「打印出来的内容对不对」，只验「有没有改用发现机制」。**
    //
    // ★ 断言的形状特意选成**两条对偶**：一条要求新写法出现，一条要求旧写法
    //   消失。只留前者的话，两种写法并存也会绿 —— 而并存正是分叉的第一天。
    const files = [
      ['lib/worker-pool.js', 112],
      ['bin/agent-start.js', 58],
    ];
    for (const [rel] of files) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const code = src.split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

      // ★ 查「接没接上这个模块」，不查「调了哪个函数」。
      //
      //   写成 `/usableTypesHint|discoverTypes/` 是错的：契约规定
      //   「safeHint 永不抛、给错误处理路径用」，
      //   `bin/agent-start.js` 那一处恰好长在错误处理路径里，按契约它必须用
      //   `safeHint` —— **于是用对了函数，测试却会红。**
      //
      //   > **断言具体函数名，意味着模块每导出一个新的合法入口就要改一次测试。**
      //   > **「有没有接上这个模块」才是这一节真正想守的东西 ——
      //   >   具体用哪个入口由契约决定，不该由测试的正则决定。**
      //
      //   跟 wiring【7】那条同一判据：**守结果不守机制，机制变了测试不该红。**
      ok(/template-discovery/.test(code),
        `★ ${rel} 接上了发现机制`,
        '源码里没有出现 lib/template-discovery');
      ok(!/Object\.keys\(\s*(capabilities\.)?CAPABILITIES\s*\)/.test(code),
        `★ ${rel} 里没有残留 Object.keys(CAPABILITIES) 的旧写法（两种并存 = 分叉第一天）`,
        '源码里仍然出现 Object.keys(CAPABILITIES)');
    }
  }

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
