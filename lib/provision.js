'use strict';

/**
 * 把 `templates/<type>/` 整个下发到一个 agent 的工作目录。
 *
 * ── 为什么住在 lib 而不是 bin ────────────────────────────────────
 * agent 启动（`bin/agent-start.js`）和 worker（`lib/worker-*`）都要用它 ——
 * 而 **lib 依赖 bin 是反向依赖**：`bin/` 下的是入口脚本，天然带副作用，
 * 也天然不可测。
 *
 * ── ★ 两种覆盖策略，因为两种 agent 的性质不同 ─────────────────────
 *
 *   **resident agent**（`keepEdited: true`，默认）
 *     已有文件 >50 字符就不覆盖。守的是**让记忆跨重启存活**
 *     —— agent 自己往 CLAUDE.md 里记的东西，不能被下一次启动抹掉。
 *
 *   **worker**（`keepEdited: false`）
 *     **无条件覆盖。** worker 是 episodic 的：prompt 进、stdout 出，
 *     **它没有记忆要保护**。那条规则对它不仅无用，**还有害** ——
 *     工作目录里一份手工建的旧 `CLAUDE.md` 副本会被「>50 字符就保留」
 *     保护下来，盖住模板。
 *
 *     > **一条守「别覆盖有价值的东西」的规则，正在守一份没有价值的东西 ——
 *     >   因为它只认字符数，不认来源。**
 *
 *     「>50 字符」是个**代理指标**，它代理的是「这里面有 agent 自己攒的东西」。
 *     代理指标在它的假设成立时很好用，**而没人会注意到假设什么时候不成立了。**
 * ────────────────────────────────────────────────────────────────
 */

const fs = require('node:fs');
const path = require('node:path');
// ★ 模板目录在哪，只有一个出处 —— 见下面 `templateDirFor` 那处的说明。
const { templateDirFor, discoverTypes } = require('./template-discovery');

const ROOT = path.join(__dirname, '..');
const ORCH = 'JARVIS';
// 唯一一个「声明身份」的模板文件。白名单判据只作用在它身上（见循环里的说明）。
const IDENTITY_FILE = 'CLAUDE.md';

/** 模板里认识的占位符。写了别的，agent 会读到字面的 `{{XXX}}`。 */
function fillPlaceholders(text, name, cwd) {
  return text
    .replaceAll('{{AGENT_NAME}}', name)
    .replaceAll('{{ORCH}}', ORCH)
    .replaceAll('{{ENGLOOP}}', ROOT)
    .replaceAll('{{GROUP}}', `agent:${name}`)
    .replaceAll('{{STREAM}}', `agent:${name}:in`)
    .replaceAll('{{CWD}}', cwd);
}

/**
 * 这份文件**点名到这个 agent** 了吗？
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────
 * `keepEdited` 用的判据是「已有文件 >50 字符就保留」。这个文件的头注释
 * 写下了它的问题：
 *
 *   > 「>50 字符」是个**代理指标**，它代理的是「这里面有 agent 自己攒的东西」。
 *   > 代理指标在它的假设成立时很好用，**而没人会注意到假设什么时候不成立了。**
 *
 * 一个假设不成立的情形：**agent 的 cwd 是一棵 git worktree 的根**时，
 * 那里躺着的是 `git checkout` 带出来的**仓库根 CLAUDE.md**
 * （首行「# EngLoop 编排者引导」，正文「你是这个系统的编排者」）。
 *
 *   长度 > 50  ⇒ 只看长度的判据说「有内容，保留」
 *   ⇒ provision 报 `kept:['CLAUDE.md']`（一行正常输出）
 *   ⇒ **agent 读到的最内层身份是「你是这个系统的编排者」**
 *
 * ⚠️ **这不是放宽 `keepEdited`**（那条规则本身是对的）。
 *   规则想守的是「别覆盖 agent 自己攒的东西」，而长度回答不了「这内容是**谁的**」。
 *   这里补的正是它缺的那一半问句。
 *
 * ── 为什么是白名单，不是黑名单 ────────────────────────────────────
 *   黑名单（「认出编排者引导就覆盖」）的失效是**静默**的：
 *     认不出的毒药 → 当成「用户内容」保留 → agent 拿到错身份，**零信号**
 *   白名单（「认不出这是谁的就覆盖」）的失效是**有声**的：
 *     文件里没有这个名字 → 覆盖它 → 出现在 `overwritten` 里 → 有事件
 *   ⇒ 两种都会错，而**错的方向不同**。选那个错了会响的。
 *
 * ⚠️ 判据是**子串在不在**，不是长度比较 ——
 *   `String.prototype.length` 是 UTF-16 码元数，拿它比中文内容很容易出错。
 *   也不用正则：`name` 是外部输入，正则要转义，而 `includes` 不需要。
 *
 * @param {string} text 目标文件的内容
 * @param {string} name provision 的第一个参数（agent 是它的名字，worker 是它的 type）
 */
function claimsIdentity(text, name) {
  // 这个形式是**模板自己定的**：六个模板第 3 行全是 `你是 **{{AGENT_NAME}}**，…`，
  // 而 `fillPlaceholders` 把 {{AGENT_NAME}} 换成 name ⇒ 填充后就是下面这个串。
  // ⇒ 判据和被判对象来自同一个出处，不是另写一个格式去猜它。
  //
  // ── ★ 必须在**行首** ─────────────────────────────────────────────
  //   挡的是「引用式 / 缩进式的举例」：`> 你是 **dev**`、缩进两格的示例块……
  //   这类文字出现在一份**讲身份判据的防护文本**里是很自然的，而它们不是声明。
  //
  //   ⚠️ 它**挡不住行首式的举例**（比如模板 CLAUDE.md 里在行首举的例子）。
  //   ⇒ 所以它**不单独成立**，跟 `countClaims(text, name) === 1` **配对使用**：
  //     两个各挡一半，而能弄坏其中一个的输入碰不到另一个（两者的失效条件不相交）。
  //
  //   ⚠️ 不用正则：`name` 是外部输入，正则要转义，而按行 `startsWith` 不需要。
  const needle = `你是 **${name}**`;
  return String(text).split('\n').some((line) => line.startsWith(needle));
}

/**
 * 这份文件点名了这个 agent **几次**？
 *
 * ── 为什么它跟 `claimsIdentity` 是两个函数 ──────────────────────────
 *
 *   `claimsIdentity` 问的是「**有没有**点名这个 agent」。
 *   如果这份文件里除了真的身份声明之外，
 *   **还有一处把那个句式当例子写了出来**（比如一段告诉 agent「判据长什么样」的防护文本），
 *   那么真声明被换掉之后 `claimsIdentity` **仍然为真** —— 它命中的是那个例子。
 *
 *   > **一个判据，如果它的模式串会被写进它要检查的那个对象，它就自我失效。**
 *   > 而这种失效造成的是**假绿**（举例被当成身份声明）—— 假绿没有人会来查。
 *
 *   ⇒ 这个函数**不是给 `claimsIdentity` 加固**（加固是「让判据更难被骗」），
 *     它问一个**不同的问题**：「**只点名了一次吗**」
 *     ⇒ 而那恰好**看得见**使前者失效的那个条件。
 *   ★ 失效条件不相交：能弄坏前者的（多出一处举例）**正好让后者变红**。
 *
 * ⚠️ 已知弱点：它数的是**出现次数**，分不出「哪一次是真的」。
 *   两处都是真声明（比如 agent 手抄了一遍）也会红 —— 而那时红是对的：
 *   **两个身份声明本身就该被人看一眼。**
 *
 * ── ★ 口径必须跟 `claimsIdentity` 一致：**只数行首** ──────────────────
 *
 *   如果这里是全文计数，而 `claimsIdentity` 有行首要求，
 *   同一份文件（行首声明 ＋ 一处**引用式**举例）会得到：
 *       claimsIdentity = true  （行首要求正确地忽略了那处引用）
 *       countClaims    = 2     （裸计数把它数了进去）⇒ **红**
 *   ⇒ ⇒ **两个函数在同一类输入上互相拆台** —— 而行首要求存在的全部理由，
 *        就是「引用式举例不该算一次声明」。
 *
 *   ✅ 统一口径之后的期望：
 *       只有行首声明                       → 1  绿
 *       行首声明 ＋ 引用式/缩进式举例      → 1  绿（举例不算，这正是行首要求想要的）
 *       行首声明 ＋ **行首式**举例          → 2  🔴 红（该红）
 *       只有缩进举例、**没有**真声明        → 0  🔴 红（全文计数会得 1 ⇒ 绿，那是漏的）
 *
 *   ★ 两个函数问的仍然是**不同的问题**（「有没有」 vs 「几次」）——
 *     统一的是**「什么算一次声明」这个口径**，不是问题本身。
 */
function countClaims(text, name) {
  const needle = `你是 **${name}**`;
  return String(text).split('\n').filter((line) => line.startsWith(needle)).length;
}

/** 递归列出模板目录下的所有文件，返回相对路径（含 `.claude/settings.json` 这种）。 */
function listTemplateFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...listTemplateFiles(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * 下发模板。
 *
 * ── 为什么是整个目录，不只是 CLAUDE.md ──────────────────────────
 * 只下发 `templates/<type>/CLAUDE.md` 的话，模板目录里的其它文件
 * （`.claude/settings.json`）**永远不会到达工作目录，而且不报错** ——
 * agent 照常启动、照常跑，只是没有权限配置。
 *
 * 那不只是「少了个文件」：**settings.json 不下发 = 权限配置永远不生效**。
 * 能力分离在纸面上成立、在运行时不成立，而且从外面看一切正常。
 *
 * ⚠️ `keepEdited` 的判断是**逐文件**的，不是整个目录 —— 否则
 *   「CLAUDE.md 有内容」会导致新增的 settings.json 也被跳过，
 *   而那正好是安全配置。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.keepEdited=true] 已有文件 >50 字符就保留（见文件头）
 * @throws 模板目录不存在 / 是空的 / 写失败 —— **一律抛，不返回失败标志**。
 *   调用方必须让 agent 起不来：**一个没有 hook 的 agent，跑起来和有 hook 的
 *   看起来一模一样。**
 */
function provision(name, cwd, type, { keepEdited = true, roots, templatesDir, now = Date.now() } = {}) {
  // ★★ 路径 fail-closed。
  //
  //   `startPool` 的 `cwd` 默认是 `process.cwd()`（bus 跑在仓库根），
  //   而 worker 每次运行前都做无条件覆盖式 provision ⇒ 不拦的话，
  //   **每调度一个 eval worker，就把 `templates/eval/` 写进仓库根一次**：
  //     · `CLAUDE.md` → 变成「你是 eval worker，不要跑 poller」
  //       —— **编排者的引导被换成了一次性 worker 的**
  //     · `.claude/settings.json` → deny 掉 Bash（编排者唯一能跑 poller 的方式）
  //       + 挂上它明确排除的 PreToolUse hook + 它的 SessionStart hook 没了
  //
  //   **三件里任意一件都能让编排者失能，而且是静默的。**
  //
  // ⚠️ **「写成功」和「写对地方」是两件事，而前者不保证后者。**
  //   「provision 失败必须让 worker 起不来」管的是失败；
  //   **这里管的是另一个方向：provision 成功了，只是写错了地方。**
  //   而它的后果比失败严重得多：失败是响亮的（worker 起不来），
  //   **写错地方是静默的（悄悄改掉别人的配置）。**
  //
  // ── 为什么范围约束绑在 `keepEdited === false` 上 ────────────────
  //   `agent-start --cwd ../some-project` 是合法用法（agent 可以在任意项目目录），
  //   所以不能无条件要求「必须在 workers/ 下」。
  //   **危险的是「无条件覆盖」这个动作本身，所以约束跟着它走** ——
  //   **越危险的写法，允许的范围越窄。**
  const resolved = path.resolve(cwd);
  const repoRoot = path.resolve(ROOT);
  const workersRoot = path.join(repoRoot, 'workers');

  if (resolved === repoRoot) {
    throw new Error(
      `provision 拒绝往仓库根目录下发（${resolved}）。`
      + ' 那会覆盖项目自己的 CLAUDE.md 和 .claude/settings.json。'
      + ' agent 的工作目录应该是 agents/<name>/ 或 workers/<type>/。');
  }

  if (!keepEdited) {
    // `path.relative` 判从属：结果以 `..` 开头或是绝对路径 = 不在里面。
    // **比 startsWith 字符串匹配可靠** —— 后者会把 `workers-backup/` 也放进来。
    const rel = path.relative(workersRoot, resolved);
    const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!inside) {
      throw new Error(
        `provision 的**无条件覆盖**模式只允许写进 workers/ 之下，`
        + `而目标是 ${resolved}。`
        + ' 无条件覆盖会抹掉目标目录里的同名文件 —— 范围必须收窄。'
        + '（范围不收窄的话，比如把 templates/eval/ 写进仓库根，'
        + ' 就会覆盖编排者的 CLAUDE.md 和 .claude/settings.json。）');
    }
  }

  fs.mkdirSync(cwd, { recursive: true });

  // ★★ 模板目录**问发现机制要**，不自己拼 `ROOT/templates/<type>`。
  //
  //   自己拼的话，多根支持下会出现 `lib/template-discovery.js` 头上写的
  //   那种最难查的不一致：
  //
  //   > **发现说这个类型可用，下发却抛「没有模板目录」—— 两边各自都「对」。**
  //
  //   外部根（比如 ShipFlow 的那些角色）里的类型会全部踩这个：
  //   `discoverTypes` 说 usable，`provision` 在本仓库的 templates/ 里找不到。
  const tplDir = templateDirFor(type, { roots, templatesDir });
  if (!tplDir || !fs.existsSync(tplDir)) {
    // ★ 说得出**在哪些根里找过** —— 「没有模板目录」不说明找过哪里的话，
    //   人不知道是该建目录还是该配 ENGLOOP_TEMPLATE_ROOTS。
    let where = '（列不出模板根）';
    try { where = discoverTypes({ roots, templatesDir }).roots.join(path.delimiter); }
    catch (err) { where = `（模板根读不到：${err.message}）`; }
    throw new Error(`没有模板目录: 类型 ${type} 在这些模板根里都找不到 —— ${where}`);
  }

  const files = listTemplateFiles(tplDir);
  if (files.length === 0) throw new Error(`模板目录是空的: ${tplDir}`);

  const written = [];
  const kept = [];
  // ★ 被「不点名」判据覆盖掉的那些。**它必须能被调用方看见** ——
  //   这是白名单相对黑名单唯一的优势（失效有声），而优势只在有人读得到时才成立。
  const overwritten = [];
  // ★ 原文被改名保留到哪儿了。跟 `overwritten` 是**同一件事的两个面**：
  //   前者说「盖了什么」，后者说「原来那份去哪了」——
  //   而只报前者的话，读的人会以为原文没了。
  const superseded = [];
  for (const rel of files) {
    const dest = path.join(cwd, rel);
    if (keepEdited && fs.existsSync(dest) && fs.readFileSync(dest, 'utf8').length > 50) {
      // ── 长度说「这里有内容」，它说不了「这内容是**这个 agent 的**」──
      //
      // ⚠️ **只对身份文件生效。** 其余文件（`.claude/settings.json` 等）里
      //   本来就不会出现「你是 **X**」这句话 —— 对它们套白名单等于**无条件覆盖**，
      //   那会把 agent 手工改过的 settings 抹掉。
      //   ⇒ 判据的适用范围必须跟它的能力范围一致：
      //     它只认得出「身份声明」，所以它只许管声明身份的那个文件。
      if (rel !== IDENTITY_FILE || claimsIdentity(fs.readFileSync(dest, 'utf8'), name)) {
        kept.push(rel);
        continue;
      }
      // ── 走到这里 = 身份文件有内容(>50)、而它**没有点名这个 agent** ──────
      //
      // ★ **不直接盖掉，先改名**。
      //
      //   直接盖掉的话，会付一个不必要的代价：一个 agent 如果重写过自己的
      //   CLAUDE.md、并且在重写时丢掉了那句点名，它攒的东西就没了。
      //   而**那个代价是可以整个消掉的，不是只能记录得更醒目**：
      //
      //     毒药真正有害的不是「它存在」，是「**它在层叠会读到的那个位置**」。
      //     改名之后它还在磁盘上，而 `CLAUDE.md.superseded-<ts>` 不是
      //     Claude Code 会加载的文件名 ⇒ **它离开了生效位置**。
      //
      //   ⇒ 于是三件事同时成立：毒药失效 · 原文一个字节没丢 · 有两个信号
      //     （返回值里的 `overwritten`/`superseded` + 磁盘上多出一个文件）。
      //
      // ⚠️ 已知取舍：`.superseded-*` 会出现在 `git status` 里。
      //   那**是有意的** —— 它就是第二个信号。而它只在起 agent 那一刻产生，
      //   不在跑测试时产生，所以不会污染 `worktree_changed_during_run`。
      const bak = `${dest}.superseded-${now}`;
      fs.renameSync(dest, bak);
      superseded.push(`${rel} → ${path.basename(bak)}`);
      overwritten.push(rel);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fillPlaceholders(fs.readFileSync(path.join(tplDir, rel), 'utf8'), name, cwd));
    written.push(rel);
  }

  return {
    provisioned: written.length > 0,
    written,
    kept,
    // ★ 调用方拿它来说「覆盖了一份有内容、但不是你的身份文件」。
    //   ⚠️ 它不是错误 —— 覆盖正是这条判据想要的行为。它是一个**需要被说出来**的事实。
    overwritten,
    // ★ 原文改名去了哪（形如 `CLAUDE.md → CLAUDE.md.superseded-1787329999999`）。
    superseded,
    reason: written.length ? `已下发 ${written.length} 个文件` : `全部保留不覆盖（${kept.join(', ')}）`,
  };
}

// ★ `claimsIdentity` 也导出：判据要验它的行为，就必须调**它本人** ——
//   复写一份逻辑去验，验的是复写件。
module.exports = { provision, listTemplateFiles, fillPlaceholders, claimsIdentity, countClaims, IDENTITY_FILE };
