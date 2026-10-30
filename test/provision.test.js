'use strict';

/**
 * provision() —— 模板下发。
 *
 * ── 这个文件守的是什么 ──────────────────────────────────────────
 * 如果只下发 `templates/<type>/CLAUDE.md` 一个文件，模板目录里的
 * 其它文件（`.claude/settings.json`）就**永远到不了工作目录，而且不报错** ——
 * agent 照常启动、照常跑，只是没有权限配置。
 *
 * 那不只是「少了个文件」：**settings.json 不下发 = 权限配置永远不生效**。
 * 能力分离在纸面上成立、运行时不成立，从外面看一切正常。
 *
 * 所以这里的每条断言都盯着「**东西真的到了那儿吗**」，而不是「函数返回了吗」。
 * ────────────────────────────────────────────────────────────────
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// ⚠️ 它在 `lib/provision.js` 而不在 `bin/agent-start.js`：
//   **worker 也要用它，而 lib 依赖 bin 是反向依赖**（bin 下的是入口脚本，
//   天然带副作用、天然不可测）。
const { provision, listTemplateFiles, fillPlaceholders, claimsIdentity, countClaims, isExternalCwd, PERSONA_DIR } = require('../lib/provision');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

// 旧的（cwd 在 EngLoop 之内）行为的各节用 ROOT/temp/ 下的目录 —— 在 tmpdir 里它们是「外部 cwd」，
// 走的是另一条路（不往 cwd 写任何东西，见【8】）。temp/ 在 .gitignore 里。
fs.mkdirSync(path.join(ROOT, 'temp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(ROOT, 'temp', 'engloop-provision-'));
// 外部 cwd 的各节：tmpdir 在 ROOT 之外；身份文件落在这里的 personas/，不是生产的 temp/personas/
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-provision-ext-'));
const read = (p) => fs.readFileSync(p, 'utf8');

function main() {
  console.log('\n【1】★ 多文件 + 子目录：模板里的东西必须全都到达');
  // eval 模板有 CLAUDE.md 和 .claude/settings.json —— 后者最容易掉，
  // 因为它在子目录里，而且是隐藏目录
  const cwd1 = path.join(TMP, 'eval-fresh');
  const r1 = provision('evaltest', cwd1, 'eval');
  ok(r1.provisioned === true, '报告说下发了');
  ok(fs.existsSync(path.join(cwd1, 'CLAUDE.md')), 'CLAUDE.md 到了');
  ok(fs.existsSync(path.join(cwd1, '.claude', 'settings.json')),
    '★ .claude/settings.json 也到了（子目录 + 隐藏目录，最容易掉的那个）');
  ok(r1.written.length === 2, `written 列出了两个文件（实际 ${r1.written.length}）`, r1.written.join(','));

  console.log('\n【2】占位符在**每个**文件里都替换了');
  // 只在 CLAUDE.md 里替换是不够的 —— settings.json 里有 {{ENGLOOP}}
  const md = read(path.join(cwd1, 'CLAUDE.md'));
  const cfg = read(path.join(cwd1, '.claude', 'settings.json'));
  ok(!md.includes('{{'), 'CLAUDE.md 里没有残留的占位符');
  ok(!cfg.includes('{{'), '★ settings.json 里也没有残留（子目录文件同样要替换）');
  ok(md.includes('evaltest'), 'CLAUDE.md 里 {{AGENT_NAME}} 换成了名字');
  ok(cfg.includes(ROOT), 'settings.json 里 {{ENGLOOP}} 换成了仓库根路径');
  ok(md.includes(cwd1), '{{CWD}} 换成了工作目录');

  console.log('\n【3】★ 不覆盖是**逐文件**判断，不是整个目录');
  // 不覆盖守的是「让记忆跨重启存活」—— agent 自己往 CLAUDE.md 里记的
  // 东西不能被下一次启动抹掉。但如果按整目录判断，「CLAUDE.md 有内容」
  // 会连带跳过新增的 settings.json，而那正好是安全配置。
  // ── ⚠️ 「让记忆跨重启存活」靠的是**改名保留**，不是留在原地 ─────────────
  //   不点名的旧文件**改名到 .superseded-<ts>**，模板落到生效位置
  //             ⇒ 断言「.superseded-<ts> 的内容 === mine」
  //   ⇒ 防的是「agent 攒的东西不能没了」，
  //     而它一个字节也没少，只是不在 `CLAUDE.md` 这个文件名下了。
  //   （`mine` 里没有「你是 **evaltest**」⇒ 白名单不命中 ⇒ 走改名路径。这是**故意的**：
  //     这一节要覆盖的正是「文件有内容、但它不是这个 agent 的」那种情况。）
  const NOW2 = 1787330000000;   // 固定时间源 ⇒ 判据能算出 .superseded 的文件名
  const cwd2 = path.join(TMP, 'eval-existing');
  fs.mkdirSync(cwd2, { recursive: true });
  const mine = '# 这是我自己写的内容，超过五十个字符，绝对不能被下一次启动抹掉。'.repeat(2);
  fs.writeFileSync(path.join(cwd2, 'CLAUDE.md'), mine);
  const r2 = provision('evaltest', cwd2, 'eval', { now: NOW2 });
  ok(read(path.join(cwd2, `CLAUDE.md.superseded-${NOW2}`)) === mine,
    '已有的 CLAUDE.md 保住了（记忆跨重启存活）—— 而它现在存活在 .superseded-<ts> 下'
    + '（白名单：没点名到这个 agent 的旧副本改名保留）');
  ok(fs.existsSync(path.join(cwd2, '.claude', 'settings.json')),
    '★ 而 settings.json 照样下发了 —— 一个文件被保留不该拖累别的');
  ok(r2.overwritten.includes('CLAUDE.md')
    && r2.superseded.length === 1 && r2.superseded[0].includes(`superseded-${NOW2}`)
    && r2.written.includes(path.join('.claude', 'settings.json')),
    'overwritten / superseded / written 分别列清楚了'
    + '（白名单：没点名到这个 agent 的旧副本改名保留）',
    JSON.stringify(r2));

  console.log('\n【4】短文件会被覆盖（>50 字符才算「有内容」）');
  const cwd3 = path.join(TMP, 'eval-stub');
  fs.mkdirSync(cwd3, { recursive: true });
  fs.writeFileSync(path.join(cwd3, 'CLAUDE.md'), '占位');
  provision('evaltest', cwd3, 'eval');
  ok(read(path.join(cwd3, 'CLAUDE.md')).length > 50, '短占位文件被模板覆盖了');

  console.log('\n【5】旧形状不能退化：模板只有一个文件时照样能用');
  // 改成目录下发之后，单文件模板必须仍然正常 —— 守的是「新功能别把老路踩坏」。
  //
  // ★ 不拿真实模板（比如 `templates/dev/`）当单文件样本：真实模板会增删文件，
  //   **断言就绑在一个偶然事实上**。所以自己造一个
  //   真正的单文件模板，不受任何真实模板增删的影响。
  console.log('\n【★】worker 用 keepEdited:false —— 无条件覆盖');
  {
    // ── 两种 agent 的性质不同，覆盖策略也必须不同 ────────────────────
    //   resident agent：>50 字符就保留 —— 守「让记忆跨重启存活」
    //   worker：**无条件覆盖** —— 它是 episodic 的，prompt 进 stdout 出，
    //           **没有记忆要保护**
    //
    // 例：`workers/eval/CLAUDE.md` 若是一份手工建的旧副本，
    // **「>50 字符就保留」会保护它盖住模板** ——
    // 于是 `.claude/settings.json` 永远到不了 worker 的运行目录，
    // **hook 对 worker 根本挂不上。**
    //
    // > **一条守「别覆盖有价值的东西」的规则，会去守一份没有价值的东西 ——
    // >   因为它只认字符数，不认来源。**
    // ────────────────────────────────────────────────────────────────
    // ⚠️ 必须在 `workers/` 之下 —— 无条件覆盖模式的范围约束（见【★危】那节）。
    //   用 tmpdir 的话会被这条约束拦下。
    const cwdW = path.join(__dirname, '..', 'workers', '__provision_force_probe__');
    fs.rmSync(cwdW, { recursive: true, force: true });
    fs.mkdirSync(path.join(cwdW, '.claude'), { recursive: true });
    // ⚠️ 这一行的长度是整节的**前提**，所以断言它，别靠人数。
    //   一串中文里「声称超过五十个字符」很容易实际不到 —— 那样两条对照会直接红。
    const stale = `这是一份手工建的旧副本，没有任何价值。${'补'.repeat(40)}`;
    ok(stale.length > 50, `（前提）旧副本超过 50 字符，才会触发保留规则（实际 ${stale.length}）`);
    fs.writeFileSync(path.join(cwdW, 'CLAUDE.md'), stale);

    // 默认策略（agent）：会保留那份旧副本
    //
    // ── ⚠️ 下面两条锁定的是修复，不是缺陷 ───────────────────
    //   改名保留之前，这里的对照断言锁定的是「旧副本被保留在原地」这个缺陷：
    //     · 「（对照）默认 keepEdited:true 时，旧副本被保留 —— **这正是问题所在**」
    //     · 「（对照）旧内容原封不动」
    //   ⇒ 一条锁定缺陷的对照断言，在缺陷被修之后必须跟着变；
    //     否则它会永远红，然后被人当噪音关掉 —— 而关掉之后，
    //     **连那个缺陷曾经存在过这件事都消失了。**
    const NOW_W = 1787330000000;
    const keep = provision('evaltest', cwdW, 'eval', { now: NOW_W });
    ok(keep.overwritten.includes('CLAUDE.md'),
      '（对照）默认 keepEdited:true 时，**不点名**的旧副本被覆盖（白名单判据）'
      + '（白名单：没点名到这个 agent 的旧副本改名保留）');
    ok(fs.readFileSync(path.join(cwdW, `CLAUDE.md.superseded-${NOW_W}`), 'utf8') === stale,
      '（对照）旧内容**一个字节没丢**，改名保留在 .superseded-<ts>'
      + '（白名单：没点名到这个 agent 的旧副本改名保留）');

    // ── 🔴 白名单**放行**那一半 ──
  //
  //   上面三条验的全是「不点名 ⇒ 被覆盖」——**拒绝**那一半。
  //   没有「点名 ⇒ 被保留」的话 ⇒ `claimsIdentity` **恒返回 false** 这个变异能全绿活下来。
  //   ★ 而这两半合起来才是白名单：**只验拒绝，等于只验了「它会覆盖」，
  //     而没验「它**只**覆盖该覆盖的」** —— 后者才是 agent 的笔记不被抹掉的那条保证。
  {
    const cwdKeep = path.join(__dirname, '..', 'workers', '__provision_allow_probe__');
    fs.rmSync(cwdKeep, { recursive: true, force: true });
    fs.mkdirSync(path.join(cwdKeep, '.claude'), { recursive: true });
    // 一份**点名到这个 agent** 的文件，后面跟着「它自己攒的东西」
    const mineKeep = '# evaltest — eval worker\n\n你是 **evaltest**，一个受编排者 JARVIS 管理的常驻 agent。\n\n'
      + '## 我自己记的东西\n\n' + '这一段是 agent 往自己 CLAUDE.md 里写的，绝对不能被下一次启动抹掉。'.repeat(3);
    fs.writeFileSync(path.join(cwdKeep, 'CLAUDE.md'), mineKeep);
    const rk = provision('evaltest', cwdKeep, 'eval', { now: 1787340000009 });

    ok(rk.kept.includes('CLAUDE.md'),
      '🔴 **B26 白名单放行**：点名到这个 agent 的 CLAUDE.md **被保留**（`kept` 里有它）',
      JSON.stringify(rk));
    ok(read(path.join(cwdKeep, 'CLAUDE.md')) === mineKeep,
      '🔴 **B26 白名单放行**：而它的内容**一个字节没动**（agent 攒的东西还在）');
    ok((rk.superseded || []).length === 0,
      '🔴 **B26 白名单放行**：没有产生任何 `.superseded-*` 文件（不该改名的没被改名）',
      JSON.stringify(rk.superseded));

    // ── 🔴 B27 正控：**同一份内容**，只去掉那一行点名 ⇒ 必须走改名路径 ──
    //   ★ 变量只有一个（那一行在不在）⇒ 这一格红、上一格绿，两者合起来才证明
    //     白名单**分得开**，而不是「它对什么都放行」或「它对什么都拒绝」。
    {
      const cwdCtl = path.join(__dirname, '..', 'workers', '__provision_allow_ctl__');
      fs.rmSync(cwdCtl, { recursive: true, force: true });
      fs.mkdirSync(path.join(cwdCtl, '.claude'), { recursive: true });
      const noClaim = mineKeep.split('\n').filter((l) => !l.startsWith('你是 **evaltest**')).join('\n');
      ok(noClaim.length > 50, '（前提）去掉那一行之后仍然 >50 字符 —— 否则走的是「短文件」那条路');
      fs.writeFileSync(path.join(cwdCtl, 'CLAUDE.md'), noClaim);
      const rc = provision('evaltest', cwdCtl, 'eval', { now: 1787340000010 });
      ok(rc.overwritten.includes('CLAUDE.md') && (rc.superseded || []).length === 1,
        '🔴 **B27 正控**：只去掉那一行点名 ⇒ 同一份内容改走**改名**路径',
        JSON.stringify(rc));
      fs.rmSync(cwdCtl, { recursive: true, force: true });
    }
    // ★ 直接调那两个导出的函数 —— 判据要验它们的行为，就必须调**它们本人**
    ok(claimsIdentity(mineKeep, 'evaltest') === true,
      '🔴 `claimsIdentity` 对这份文件返回 true（这是上面三条成立的前提，单独断言它）');
    ok(countClaims(mineKeep, 'evaltest') === 1,
      '🔴 **B20** `countClaims === 1`（只点名一次 —— 而 ≠1 说明判据可能正在被一处**引用**骗到）');

    // ── B21 正控：多抄一遍**行首**的声明 ⇒ countClaims 必须变 2 ──
    const dup = mineKeep + '\n你是 **evaltest**，这一行是抄的\n';
    ok(countClaims(dup, 'evaltest') === 2,
      '🔴 **B21 正控**：行首多一处同样的句式 ⇒ `countClaims === 2`（否则 B20 恒绿）');
    // ── B22 正控：**缩进**的举例不该被数进去（这正是行首要求存在的理由）──
    const quoted = mineKeep + '\n> 你是 **evaltest**  ← 这是一处引用，不是声明\n';
    ok(countClaims(quoted, 'evaltest') === 1 && claimsIdentity(quoted, 'evaltest') === true,
      '🔴 **B22 正控**：引用式/缩进式的举例**不算**一次声明 —— 两个函数口径一致');

    // ── 🔴 B24：**只有**引用式举例、没有任何行首声明 ⇒ 必须 0，不是 1 ──
    //   ★ 这一格是 `countClaims` 存在的真正理由：
    //     口径不限行首的话它会是 1 ⇒ B20 绿 ——
    //     **而 B20 要「让『判据正在被骗』这件事可见」，却会在最该被看见的那一格里是绿的。**
    const onlyQuoted = '# 某份文档\n\n> 你是 **evaltest**  ← 只有这一处引用，没有真声明\n' + 'x'.repeat(80);
    ok(countClaims(onlyQuoted, 'evaltest') === 0,
      '🔴 **B24**：只有引用、没有行首声明 ⇒ `countClaims === 0`（≠1 ⇒ 红 ⇒ 「一个声明都没有」也被抓到）');
    ok(claimsIdentity(onlyQuoted, 'evaltest') === false,
      '🔴 **B24 配对**：而 `claimsIdentity` 对同一份返回 false —— 两个函数**同向**，不再互相拆台');

    fs.rmSync(cwdKeep, { recursive: true, force: true });
  }

  // worker 策略：无条件覆盖
    const force = provision('evaltest', cwdW, 'eval', { keepEdited: false });
    ok(force.kept.length === 0, '★ keepEdited:false 时一个都不保留');
    ok(force.written.includes('CLAUDE.md'), '★ 旧副本被覆盖了');
    ok(fs.readFileSync(path.join(cwdW, 'CLAUDE.md'), 'utf8') !== stale,
      '★★ 内容真的换成了模板的（不是只报告说覆盖了）');
    ok(fs.existsSync(path.join(cwdW, '.claude', 'settings.json')),
      '★★ `.claude/settings.json` 到位了 —— 那是 hook 挂载的前提');
    fs.rmSync(cwdW, { recursive: true, force: true });
  }

  console.log('\n【★危】provision 绝不往仓库根目录下发');
  {
    // ── 为什么要拦仓库根 ──────────────────────
    //   把「每次运行前 provision」接进 worker 池之后，
    //   `startPool` 那个一直无害的默认值 `cwd = process.cwd()`
    //   **就等于「无条件覆盖仓库根的 CLAUDE.md」**
    //   （编排者引导被换成 eval worker 的、
    //   `.claude/settings.json` 被换成 deny 掉 Bash 的那份）。
    //
    // > **一个一直无害的默认值，会因为别处新增一个动作而变成破坏性的。**
    // > **而它不会有任何提示 —— 那个默认值本身一个字都没改。**
    //
    //   改默认值只治了那一个调用方；**这条治所有调用方**：
    //   一个会覆盖文件的函数，必须自己拒绝明显不该写的位置。
    // ────────────────────────────────────────────────────────────────
    const ROOT_DIR = path.join(__dirname, '..');
    let threw = null;
    try { provision('x', ROOT_DIR, 'eval', { keepEdited: false }); } catch (e) { threw = e; }
    ok(threw !== null, '★★ 往仓库根下发 → 抛错');
    ok(threw && /仓库根目录/.test(threw.message),
      '★ 错误说清是哪种位置不许写', threw && threw.message.slice(0, 60));

    // 相对路径也要拦（`path.resolve` 之后才比较）
    let threw2 = null;
    try { provision('x', path.join(ROOT_DIR, 'agents', '..'), 'eval'); } catch (e) { threw2 = e; }
    ok(threw2 !== null, '★ 绕一圈指回根目录的路径也拦得住（比较的是 resolve 之后的）');

    // ★★ 无条件覆盖模式：范围收窄到 `workers/` 之下。
    //   **危险的是「无条件覆盖」这个动作，所以约束跟着它走** ——
    //   越危险的写法，允许的范围越窄。
    //   （不能无条件要求 workers/：`agent-start --cwd ../some-project` 是合法用法。）
    let threw3 = null;
    try {
      provision('x', path.join(TMP, 'outside-workers'), 'eval', { keepEdited: false });
    } catch (e) { threw3 = e; }
    ok(threw3 !== null,
      '★★ 无条件覆盖模式下，写 workers/ 之外 → 抛错');
    ok(threw3 && /workers\//.test(threw3.message),
      '★ 错误说清允许的范围', threw3 && threw3.message.slice(0, 50));

    // 阴性对照：workers/ 之下允许（否则「一律拒绝」的实现也能过）
    const okDir = path.join(ROOT_DIR, 'workers', '__provision_probe__');
    const rw = provision('x', okDir, 'eval', { keepEdited: false });
    ok(rw.provisioned === true, '★ 阴性对照：workers/ 之下照常无条件覆盖');
    fs.rmSync(okDir, { recursive: true, force: true });

    // ★ `workers-backup/` 这种前缀相同但不在里面的，不许放行 ——
    //   用 path.relative 判从属，不是 startsWith 字符串匹配。
    let threw4 = null;
    try {
      provision('x', path.join(ROOT_DIR, 'workers-backup', 'eval'), 'eval', { keepEdited: false });
    } catch (e) { threw4 = e; }
    ok(threw4 !== null,
      '★ `workers-backup/` 这种前缀相同的目录不算「在 workers/ 之下」');

    // 阴性对照：正常目录照常下发，别拦过头
    const fine = path.join(TMP, 'normal-dir');
    const r = provision('x', fine, 'eval');
    ok(r.provisioned === true, '★ 阴性对照：正常目录照常下发（不是「一律拒绝」）');

    // ★ 接线：worker 池的默认 cwd 不再是 process.cwd()
    const poolSrc = fs.readFileSync(path.join(ROOT_DIR, 'lib', 'worker-pool.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(!/cwd\s*=\s*process\.cwd\(\)/.test(poolSrc),
      '★★ startPool 的 cwd 默认值不再是 process.cwd()（那个默认在有了 provision 之后是破坏性的）');
    ok(/workers/.test(poolSrc),
      '★ 默认值指向 workers/<type>/ —— 跟 bin/serve.js 传的是同一个值');
  }

  console.log('\n【★b】接线：worker 池每次运行前 provision，失败就不跑');
  {
    // ★ **不是池启动时下发，是每个 worker 跑之前** ——
    //   那样每个 worker 拿到的一定是当下的模板，
    //   **不存在「跑着旧配置的 worker」这种状态**。
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'worker-pool.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    ok(/require\('\.\/provision'\)/.test(src), '★ worker-pool 引入了 provision');
    ok(/keepEdited:\s*false/.test(src), '★★ 用的是无条件覆盖（不是 agent 那套保留规则）');

    // ★ 位置：必须在 run() **之前**。放后面等于「跑完了才配置」。
    const idxProv = src.indexOf('provision(');
    const idxRun = src.indexOf('await run(');
    ok(idxProv > 0 && idxRun > idxProv,
      '★★ provision 在 run() 之前 —— 放后面等于「跑完才配置」');

    // ★ fail loud：失败要 return，不能继续往下跑
    const seg = src.slice(idxProv, idxRun);
    ok(/catch/.test(seg) && /return/.test(seg),
      '★★ provision 失败时 return，**不是记条日志继续跑** —— '
      + '一个没有 hook 的 worker，跑起来和有 hook 的看起来一模一样');
    ok(!/remember\(/.test(seg),
      '★ 失败不写去重记录（模板修好后重投该能成功，缓存一条失败更难查）');
  }

  // ⚠️ 建在 `templates/` 里的东西一律用 finally 清 —— 那是**共享目录**，
  //   残留会让别的 agent 的 `discoverTypes` 多出一个假类型。
  //   （清理原本裸写在调用之后：`provision()` 自己抛的话就到不了那一行。
  //    注意暴露点不是「断言失败」—— 清理排在断言之前，那时它已经跑完了。）
  const soloType = '__provision_test_solo__';
  const soloTpl = path.join(ROOT, 'templates', soloType);
  let r4;
  try {
    fs.mkdirSync(soloTpl, { recursive: true });
    fs.writeFileSync(path.join(soloTpl, 'CLAUDE.md'), '我是 {{AGENT_NAME}}，工作目录 {{CWD}}。');
    r4 = provision('solotest', path.join(TMP, 'solo-fresh'), soloType);
  } finally {
    fs.rmSync(soloTpl, { recursive: true, force: true });
  }
  const cwd4 = path.join(TMP, 'solo-fresh');
  ok(fs.existsSync(path.join(cwd4, 'CLAUDE.md')), '单文件模板照常下发');
  ok(r4.written.length === 1, `written 只有一个（实际 ${r4.written.length}）`);
  ok(read(path.join(cwd4, 'CLAUDE.md')).includes('solotest'), '占位符照常替换');

  // 顺带确认真实的 dev 模板（现在是多文件）也没问题
  const cwd4b = path.join(TMP, 'dev-fresh');
  provision('devtest', cwd4b, 'dev');
  ok(fs.existsSync(path.join(cwd4b, '.claude', 'settings.json')),
    'dev 模板的 settings.json 也下发了（它已经不是单文件模板了）');

  console.log('\n【6】模板不存在 / 空目录 → 大声失败，不静默跳过');
  let threwMissing = false;
  try { provision('x', path.join(TMP, 'nope'), 'no-such-type'); } catch (_) { threwMissing = true; }
  ok(threwMissing, '模板目录不存在 → 抛异常（不是「什么都不做然后返回成功」）');

  const emptyTpl = path.join(ROOT, 'templates', '__provision_test_empty__');
  fs.mkdirSync(emptyTpl, { recursive: true });
  let threwEmpty = false;
  try { provision('x', path.join(TMP, 'nope2'), '__provision_test_empty__'); } catch (_) { threwEmpty = true; }
  fs.rmSync(emptyTpl, { recursive: true, force: true });
  ok(threwEmpty, '★ 模板目录是空的 → 抛异常（否则 agent 会在没有任何指令的情况下启动）');

  console.log('\n【6b】★★ 多根：provision 必须去发现机制指的那个根拷');
  // ── 这根线漏掉的后果，正是 template-discovery 头注里说的那种 ──
  //
  // > **发现说这个类型可用，下发却抛「没有模板目录」—— 两边各自都「对」。**
  //
  // 外部根里的类型会**全部**踩这个：
  // `discoverTypes` 说 usable，而 provision 在本仓库的 templates/ 里找不到。
  //
  // ⚠️ 这是**行为**断言，不是静态断言 —— 「provision 里出现了 templateDirFor
  //   这个词」证明不了它真的去对的地方拷了。
  {
    // ⚠️ 「本仓库没有的类型」这个前提会随着模板增删失效：
    //   用一个真实名字（比如 `review`）的话，哪天 `templates/review/` 被建出来，
    //   **三条断言会变红，而红的原因跟它们要守的东西毫无关系** ——
    //   看起来像「多根发现坏了」，实际是这个测试的前提没了。
    //
    //   ★ 所以**把那个前提变成一条显式断言**（下面第一条），
    //   名字也用一眼能看出「不该出现在 templates/ 下」的形状；
    //   万一还是有人建了，前置断言会直接说出「前提没了」，
    //   不会让人去查一个不存在的多根 bug。
    const EXT_ONLY = '__external_only_probe__';
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-extroot-'));
    fs.mkdirSync(path.join(extRoot, EXT_ONLY), { recursive: true });
    fs.writeFileSync(path.join(extRoot, EXT_ONLY, 'CLAUDE.md'),
      '你是 {{AGENT_NAME}}，一个只读审查者。这份模板来自外部根。');

    // ★★ 前置断言：本节全部结论都建立在「本仓库没有这个类型」之上。
    //   它红了的话，下面三条的绿或红都不算数 —— 先修前提。
    ok(!fs.existsSync(path.join(ROOT, 'templates', EXT_ONLY)),
      `★★ （前提）本仓库 templates/ 下没有 ${EXT_ONLY} —— 有的话本节结论全部作废`,
      '有人在 templates/ 下建了这个测试专用的类型名，换一个即可');

    const dest = path.join(ROOT, 'workers', '__provision_multiroot_test__');
    const built = provision('reviewtest', dest, EXT_ONLY, {
      keepEdited: false,
      roots: [path.join(ROOT, 'templates'), extRoot],
    });

    ok(built.written.includes('CLAUDE.md'),
      '★★ 从**第二个根**拷到了 —— 本仓库的 templates/ 里没有这个类型',
      JSON.stringify(built));
    const got = fs.readFileSync(path.join(dest, 'CLAUDE.md'), 'utf8');
    ok(/来自外部根/.test(got),
      '★★ 内容真的是外部根那一份（不是碰巧在本仓库找到了同名的）', got.slice(0, 80));
    ok(/reviewtest/.test(got), '★ 占位符照常替换');

    // ★ 阴性对照：不配那个根就找不到 —— 否则上面两条可能是「反正到处都找」
    //
    // ⚠️ 这个对照的 cwd 必须单独起名并在下面清掉：provision 会先 `mkdirSync(cwd)`
    //   再去找模板，找不到才抛 —— **不清的话每跑一次就在 `workers/` 下留一个空目录**，
    //   而且不会有人发现，原因是：
    //
    //   > **`git status` 干净 ≠ 文件系统干净 —— git 不跟踪空目录。**
    //
    //   拿 git 当「跑测试有没有留脏」的判据，验的是「跟踪的文件变没变」，
    //   **不是「目录里多没多东西」**。判据的能力范围对不上断言的类型。
    const negDest = path.join(ROOT, 'workers', '__provision_multiroot_test2__');
    let threw = false;
    try {
      provision('reviewtest', negDest,
        EXT_ONLY, { keepEdited: false, roots: [path.join(ROOT, 'templates')] });
    } catch (_) { threw = true; }
    ok(threw,
      `★★ 阴性对照：只给本仓库那个根 → 找不到 ${EXT_ONLY}，抛错。`
      + '**证明上面那条真的是从外部根拿到的**');

    fs.rmSync(dest, { recursive: true, force: true });
    fs.rmSync(negDest, { recursive: true, force: true });
    fs.rmSync(extRoot, { recursive: true, force: true });
  }

  console.log('\n【7】辅助函数');
  ok(listTemplateFiles(path.join(ROOT, 'templates', 'eval')).includes(path.join('.claude', 'settings.json')),
    'listTemplateFiles 会递归进子目录');
  ok(fillPlaceholders('{{AGENT_NAME}}/{{CWD}}', 'n', '/c') === 'n//c', 'fillPlaceholders 替换正确');

  console.log('\n【8】★★ 外部 cwd：不往别人的项目目录里写任何东西');
  {
    // 成因：Patrick 手动在 resume / teams-meeting-plugin 等项目里起 claude，被下发进去的
    // .claude/settings.json（hook + deny）拦住、被 CLAUDE.md 当成 agent。agent 会话本身不需要它们：
    // 权限走 --settings + --setting-sources user，身份走 --append-system-prompt-file。
    const proj = path.join(EXT, 'some-project');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'README.md'), 'x');
    const personasDir = path.join(EXT, 'personas');
    const r = provision('evaltest', proj, 'eval', { personasDir });
    ok(r.external === true && r.provisioned === true, '报告说是外部 cwd、下发了');
    ok(fs.readdirSync(proj).join() === 'README.md', '★ cwd 里只有原来的 README.md —— 没有 CLAUDE.md、没有 .claude/',
      fs.readdirSync(proj).join());
    ok(r.personaFile === path.join(personasDir, 'evaltest.md') && fs.existsSync(r.personaFile), '身份文件在 personasDir/<name>.md');
    const md = read(r.personaFile);
    ok(!md.includes('{{') && md.includes('evaltest') && md.includes(proj), '占位符已替换（名字、{{CWD}}）');
    ok(claimsIdentity(md, 'evaltest'), '渲染出来的文件点名了这个 agent（agent-start 的门认它）');
    ok(r.skipped.includes(path.join('.claude', 'settings.json')) && r.written.length === 1, 'settings.json 被跳过且报出来了（不是静默少一个）', JSON.stringify(r.skipped));
    ok(r.overwritten.length === 0 && r.superseded.length === 0, '没有 overwritten / superseded —— 没碰任何已有文件');
    // 重启：身份文件是 EngLoop 的，每次重新渲染
    fs.writeFileSync(r.personaFile, 'stale');
    provision('evaltest', proj, 'eval', { personasDir });
    ok(read(r.personaFile).includes('evaltest'), '再起一次会重新渲染（它是框架生成的，不是 agent 的笔记）');
    // 阴性对照：ROOT 内的 cwd 行为不变（旧各节已覆盖；这里直接钉）
    const inner = path.join(TMP, 'inner-agent');
    const ri = provision('evaltest', inner, 'eval');
    ok(!ri.external && fs.existsSync(path.join(inner, 'CLAUDE.md')) && fs.existsSync(path.join(inner, '.claude', 'settings.json'))
      && ri.personaFile === path.join(inner, 'CLAUDE.md'), '阴性对照：ROOT 内 cwd 照旧下发两个文件，personaFile 是 cwd/CLAUDE.md');
    // 名字进文件名 ⇒ 不许逃出 personasDir
    let threw = false;
    try { provision('../evil', proj, 'eval', { personasDir }); } catch (_) { threw = true; }
    ok(threw && !fs.existsSync(path.join(EXT, 'evil.md')), '名字带路径成分 ⇒ 抛，且没写出 personasDir 之外');
    ok(PERSONA_DIR === path.join(ROOT, 'temp', 'personas'), '默认 personasDir 在 EngLoop 自己的 temp/ 下');
    // 判据本身
    ok(!isExternalCwd(path.join(ROOT, 'agents', 'dev')) && !isExternalCwd(path.join(ROOT, 'workers', 'eval'))
      && !isExternalCwd(`${ROOT}-worktrees/dev`), 'ROOT 内、workers/、<ROOT>-worktrees/ 之下都不是外部');
    ok(isExternalCwd(`${ROOT}-backup/x`) && isExternalCwd('/tmp/some-project') && isExternalCwd(path.dirname(ROOT)),
      '阴性对照：名字相近的 <ROOT>-backup/、/tmp、ROOT 的父目录都是外部（不是 startsWith 式的误放）');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(EXT, { recursive: true, force: true });

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
