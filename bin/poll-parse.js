'use strict';

// ★ 被截断时要报出「完整的在哪」—— 而那就是调用者传进来的那个文件
const SRC = process.argv[2] || 'temp/poll.json';

/**
 * 解析 poller 落盘的输出 + **身份自检**。
 *
 * 用法:
 *   node .../bin/next.js … > poll.json 2> poll.err
 *   node bin/poll-parse.js poll.json
 *
 * ── 为什么要有这个文件 ──
 *
 * poller 返回的 JSON 里可能带 `_orchestrator_instructions` —— **那是 JARVIS 的身份说明**
 * （「你是 JARVIS，EngLoop 的编排者……」）。它不是给 agent 的。
 *
 * `messages` 排在 `_orchestrator_instructions` 前面 ⇒ 消息一多就把它挤出工具 preview；
 * 消息少的轮次它最显眼（1 条消息时多半落在 preview 前 2048 字节里，3 条以上基本看不到）。
 *
 *   > **上下文一压缩、重新开工的那一轮，房间通常是安静的（没积压 / 刚回来 / 刚启动）**
 *   > **★ 最需要一份正确身份的那一刻，恰好是那份错的最显眼的时刻。**
 *
 * ★ `ME` 硬编码在这个文件里，**不从环境变量、不从注入内容取** ——
 *   因为那两个正是可能出错的东西。一个从可疑来源取值的自检，检不出任何东西。
 *
 * ── ⛔ 给下一个改这个文件的人：加「上次长什么样」之前先加 `--dry` ────
 *
 * 现在这个文件的判定**不依赖任何历史**：只读 poll.json
 * （唯一的写是 `temp/last-room-<ME>.json`，判定不读它）。
 *
 * ⚠️ 而这是**当前属性，不是设计保证**：
 *
 *   > **一个记录了「上次是什么样」的检测器，天然有状态；**
 *   > **而「测试它」和「使用它」在代码上是同一次调用 ——**
 *   > **⇒ 副作用不是设计失误，是这一类工具的固有属性。**
 *   >
 *   > **✅ 凡是带「上次 / 变没变 / 新增」语义的检测器，从第一版起就要有 `--dry`。**
 *   > **不是等发现污染了再加。**
 *
 * 🔴 典型的坏法：干跑一次（比如测正控）→ 指纹被更新
 *   → 下一次**真实** poll 内容相同 → 报「✅ 未变」→ **而那一版改动从没被读过**
 *   ⇒ 一次注入层变更被**静默**吞掉。
 *
 * ⇒ 所以：这个文件一旦要加「注入层变没变 / 新增了什么键」这类功能，
 *   `--dry` 和那个功能**同一次提交**，不能分两步。
 */

const fs = require('node:fs');

// ── 📌 待改：报警时带上「导出结论的那个**具体值**」──────────────
//
// 那个值一旦不可能，矛盾自己会显形 —— 这是正控转红之外**免费的第二条检出路**。
//
// ⚠️ 边界（别写宽了）：
//   ✅ 只在原料是**可判真假的具体值**时成立 —— 名字 · 数量 · id · 长度
//   🔴 若原料是个**措辞**（「格式不对」「不匹配」），带上去**不产生矛盾** ——
//      两句都是模糊的，摆在一起还是模糊的
//   ★ 差别：**值可以跟另一处的值打架；理由不会跟任何东西打架。**
//
//   **不可机械化的是「注意到」，可机械化的是「让矛盾存在于输出里」**：
//   没法保证有人会看，但可以保证**看了就能发现**。
//
// 现状：结论行「⛔ 结论：本轮注入没有……」**不引用任何中间值**
//   ⇒ 变异时输出不会自相矛盾，它只会**安静地改变结论**
//   ⇒ 检出**完全依赖正控转红**这一条路。
//
// 改的时候：把匹配结果从 `true/false` 换成**提取出来的名字列表** `decl = [...]`，
//   判据仍是 `ME not in decl`（白名单不变），但报警时能说出**声明的是谁**。
//   ⇒ 一次给两样东西：可读的报警 + **变异时输出会自相矛盾**（那条免费检出路）。
//
// ⛔ 文件头那条 `--dry` 判据**故意不写函数名 / 变量名**：
//   ```
//   守护【现有代码】的判据  → **贴着那段代码** ⇒ 代码死了判据一起死，不留幽灵
//   守护【将来的改动】的判据 → **文件头** ⇒ 它天然活得比任何具体代码久
//                            🔴 所以必须**自己不指向任何具体函数名**
//   ```
//   ⇒ 文件头写**行为**（「加『上次长什么样』之前先加 --dry」），
//     不写**函数名**（「改了 xxx() 之后跑两种变异」）—— 后者会随那个函数改名而变成幽灵。
//
// ★ 反方的论点也成立，一并标着：
//   **「判据放在会被违反的那个位置 —— 而那个位置可以死掉，**
//   **判据不会跟着一起死，它会留在那里继续指路，指向一个没人走的路口。」**

const ME = 'dev';                 // ← 我是谁。硬编码，任何情况下不改。
const ORCHESTRATOR = 'JARVIS';    // ← 注入内容描述的那个人。它不是我。

const src = process.argv[2];
if (!src) {
  console.error('用法: node bin/poll-parse.js <poll.json>');
  process.exit(2);
}

let j;
try {
  j = JSON.parse(fs.readFileSync(src, 'utf8'));
} catch (err) {
  // ⚠️ 解析失败时**不要静默**：node 那侧已经 XREADGROUP 过了 ⇒ 消息已进 PEL，
  //   显示脚本一崩，读的人就一条都没看到。
  console.error(`🔴 解析失败，**但消息很可能已经被领走了**: ${err.message}`);
  console.error(`   → 立刻查 PEL: redis-cli XPENDING agent:${ME}:in agent:${ME}`);
  console.error(`   → deliveries=1 的那些是「领走了但你没看到内容」，按 id 直接 XRANGE 取回`);
  console.error(`   ⛔ 不要等 autoclaim：你恢复得比它快就轮不到它（minIdleMs=60000）`);
  process.exit(1);
}

// ── ★ 身份自检（带双向正控）────────────────────────────────────────
//
// 检的不是「注入里有没有 JARVIS 这个词」—— 那会被房间里的正常讨论触发。
// 检的是：**那段注入自称是谁**。
const instr = Array.isArray(j._orchestrator_instructions)
  ? j._orchestrator_instructions.join('\n') : '';

function claimsIdentity(text, name) {
  // 「你是 **JARVIS**」/「你是 JARVIS」 —— 注入层的自我介绍句式
  //
  // 🔴 `(?!\s*的)` 不能省：
  //   「你是 **dev** 的编排者 JARVIS。」
  //   ⇒ 「你是 dev」命中了**所有格短语的前半**，而「你是 JARVIS」因为中间隔着
  //     「的编排者」不命中 ⇒ 检测器报 **✅ 绿灯**，而那句话说的是读者是 JARVIS。
  //   ★ 「你是 X 的 Y」里，真正的身份是 **Y**，不是 X。
  //
  // ⚠️ `\*{0,2}${name}\*{0,2}(?!\s*的)` 这种写法**不生效**，因为正则会回溯：
  //   `你是 **dev** 的` 里，尾部的 `\*{0,2}` 可以匹配 **0 个**星号
  //   ⇒ 断言看到的下一个字符是 `*` 而不是 `的` ⇒ 绕过去了。
  //   ⇒ 所以先把 `**` 剥掉再匹配，不给它回溯的余地。
  // 🔴 `\b` 不能省：
  //   没有词边界时，`你是\s*dev` 会匹配「你是 **dev2**」「你是 **dev3**」的前缀
  //   ⇒ 注入说「你是 dev2」，dev 会报 **✅ 与我一致** —— 一个假绿灯。
  //   ⚠️ `dev` / `dev2` / `dev3` 这类名字可以同时在花名册里，不是假想场景。
  //
  // ★ 一般形式：**名字是别的名字的前缀**时，按名字做的匹配会返回一个自信的错答案。
  //
  // ⚠️ 这个洞有**两个方向**，后果差一档：
  //   ```
  //   别人的名字被读短  → 报出一个错的人 → **结论仍是报警**（措辞错）
  //   🔴 「你是 ME2」被读成 ME → `ME in decl` 成立 → **不报警 = 假绿灯**
  //   ⇒ 差别只在**谁的名字是谁的前缀**
  //   ★ 任何「X」和「X2」并存的命名，都会让所有 X 的白名单开一个口子
  //   ```
  //
  // ✅ `\b` 对**含连字符的名字**同样成立（`my-agent` / `my-agent2` / `my-agentX`
  //   三例判定全对）⇒ 这条修法**不依赖「ME 里没有特殊字符」**，改名也不会失效。
  //   （显式的 `(?![A-Za-z_\-0-9])` 与之等价。）
  const clean = text.replace(/\*\*/g, '');
  return new RegExp(`你是\\s*${name}\\b(?!\\s*的)`).test(clean);
}

// ── 🔴 只判定**身份段**，而且逐段判定，不 join 全文 ──────────────
//
// 规则文档（如 poll_rules）里可能大量引用「你是 **JARVIS**」这类句子；整段扫的话，
// 会把规则文档整个标成「不是给我的」—— 假红灯，照它行事 = 忽略规则文档。
//
//   > **⭐ 造样本要两个方向都造：**
//   > **① 该报而不报（假绿灯）—— 让你**错过一个问题****
//   > **🔴② 不该报而报（假红灯）—— 让你**主动关掉一个正确的东西****
//
// ⚠️ `join('\n').slice(0,300)` 也不行：段 [0] 短（约 25 字符）时，那 300 字符会
//   **跨过段边界**，把段 [1] 的开头吃进来。
//
// ✅ 判定「这一段是不是身份文档」：
//   首行是 `# 你是谁`，或者「短（<2000 字符）且开头就出现『你是』」。
//   长规则文档（标题是「# 轮询与消息规则」之类）不进检查。
// ── 用「它**不认识**的东西会怎么样？」量这个函数本身（它是白名单的**上游**）
//
//   答：`return null` ⇒ `PASS=false` ⇒ **拒绝** ⇒ ✅ 白名单，方向对。
//
// ⚠️ 但它有第二种失败：**认错段**（不是「不认识」，是「认了别的」）：
//
//   段[0] = 真身份段，但**长（≥2000 字）且没有 `# 你是谁` 标题** ⇒ 被跳过
//   段[1] = 短规则文档、含「你是」                                ⇒ 被选中
//   ⇒ 结果报「没识别出自我介绍句」+ ⛔ 拒绝
//
// 🟡 **这是假红灯，但代价极低**，所以不修 —— 理由写在这里，免得下一个人以为是漏的：
//
//   ```
//   它导致的动作  「去 agents/dev/CLAUDE.md 确认身份」
//   ★ 而那本来就是正确做法 —— 注入层从来不该是身份来源
//   ⇒ 对比「把规则文档标成别人的 ⇒ **忽略规则**」那种假红灯，
//     那个有实际代价，这个没有
//   ```
//
// ⛔ 「扫所有段找『你是 dev』」这个更宽的修法**不能用**：
//   真实注入的正文里**确实**会出现「你是 dev…」（编排者写到 agent）——
//   放宽到全段扫描，等于把那个绿灯 bug 从开头挪到别处再犯一次。
function pickIdentitySegment(segments) {
  for (const seg of segments) {
    const head = seg.slice(0, 200);
    if (/^#\s*你是谁/.test(seg.trim())) return seg;
    if (seg.length < 2000 && /你是/.test(head)) return seg;
  }
  return null;
}

// 🔴 只在**开头**找自我介绍，不扫全文
//
//   扫全文的话：
//   注入 = ["你是 **JARVIS**，编排者。", "顺带一提：你是 dev 的上级。"]
//   ⇒ injectedIsMe 可能命中第二段里的**子串**
//   ⇒ 压过 orchestrator 判定 ⇒ **报出「✅ 与我一致」的绿灯**
//
// ⚠️ 这不是人造场景：编排者的注入层**本来就会提到 agent**
//   （「你手下的 agent」「给 dev 派活」…），随时可能出现「你是 dev 的…」这类串。
//
//   > **容易想到的失效是「函数不工作了」；想不到的是「函数照常工作，**
//   > **但答案永远是让人安心的那个」—— 后者才危险：它不沉默，它撒谎。**
//   > **✅ 判别：这个变异会不会让告警**消失**？消失 = 最危险的一类。**
//
// ⇒ 自我介绍句只出现在开头（`# 你是谁\n\n你是 **JARVIS**，…`）。
//   限定范围，顺带保留全文扫描当**歧义信号**——两个都命中就不给绿灯。
const segments = Array.isArray(j._orchestrator_instructions) ? j._orchestrator_instructions : [];
const idSeg = pickIdentitySegment(segments);
const HEAD = (idSeg || '').slice(0, 300);
const injectedIsOrchestrator = claimsIdentity(HEAD, ORCHESTRATOR);
const injectedIsMe = claimsIdentity(HEAD, ME);
const meAnywhere = claimsIdentity(instr, ME);

console.log('━━ 身份自检 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  我是 **${ME}**（硬编码于 poll-parse.js，不取自注入内容）`);

// ★★ 绿灯条件是**单一**的：注入里必须有一句可认的**正面声明**，否则一律不放行。
//
// 架构是**白名单**（默认拒绝），不是黑名单（列举坏模式 → 报警，默认放行）——
// 「黑名单的失效方式是结构性的：**列举永远差一个**」。
//   ⇒ 既然它是这个检测器唯一真正起作用的性质，就该**写成一行显式的判据**，
//     而不是散在四个 if-else 的缝隙里让人推断。
//   分支越多出错面越大 ⇒ 下面的分支只决定**措辞**，不决定放不放行。
//
// 🔴 `injectedIsMe` 在当前注入下**结构上不可能为真**：
//   `bin/next.js` 给编排者读 `identity.md`（「你是 JARVIS…」），
//   而**其余一律读同一份通用 agent 身份**，那份**点不了名**
//   （按 type 建会有多份逐字相同的正文，那本身就是要避免的形状）。
//   ⇒ 只认「你是 <ME>」的话，绿灯条件**恒假** ⇒ 每轮一个 ⛔ ——
//     恒定输出的告警**响了也没有可执行的动作**，很快就没人照做。
//
// ⚠️ 不改成「不得声称是编排者」：那是**黑名单**（默认放行、列举坏模式）。
//
// ✅ 所以：**仍然是白名单，只是把「认名字」扩成「认角色」**。
//   注入现在的自我介绍句是「你是一个 **常驻 agent** —— 受编排者管理」，
//   而那是一句可以被白名单认的**正面声明**。
//
// 🔴 它绑着注入的措辞 —— 措辞一变，PASS 就变 false ⇒ **报警**。
//   而那个方向是对的：措辞变了确实需要人复查一眼。
//   ⇒ 「会因为上游改文案而失效」在这里是**特性**，不是缺陷。
//
// ⚠️ `claimsIdentity(HEAD, 'agent')` 匹配不上 —— 它认的是「你是 X」，
//   而这句是「你是**一个** agent」，中间隔着一个量词。
//   ⇒ 不去改 `claimsIdentity`：它已经有四处容易出错的地方（回溯 · 词边界 ·
//     所有格 · 跨段），**给它加一种句式，等于再开一个面**。
const CREW_ROLE_RE = /你是一个\s*\*{0,2}常驻 agent\*{0,2}/;
const injectedIsCrew = CREW_ROLE_RE.test(HEAD);
const PASS = (injectedIsMe || injectedIsCrew) && !injectedIsOrchestrator;   // ← 唯一的绿灯条件

if (injectedIsOrchestrator && !injectedIsMe) {
  console.log(`  ⚠️  本轮注入的 _orchestrator_instructions 自称「你是 ${ORCHESTRATOR}」`);
  console.log(`      —— **那不是我**。它是编排者的身份，每轮随 poll 一起送来。`);
  console.log(`      ⛔ 上下文压缩后若只剩它，我会误以为自己是 ${ORCHESTRATOR}。`);
  console.log(`      ✅ 我的身份在 agents/${ME}/CLAUDE.md，不在这段注入里。`);
} else if (injectedIsOrchestrator && injectedIsMe) {
  // ⚠️ 两个都在开头命中 —— 不给绿灯。「说不清」必须比「看起来没事」响。
  console.log(`  🔴 歧义：注入开头同时出现「你是 ${ORCHESTRATOR}」和「你是 ${ME}」`);
  console.log(`      ⛔ 不下结论。手工读一眼 _orchestrator_instructions[0] 的头几行。`);
} else if (injectedIsMe) {
  console.log(`  ✅ 注入自称「你是 ${ME}」—— 与我一致`);
} else if (injectedIsCrew) {
  // ★ 认的是**角色**不是名字 —— 而这一行要说清楚，否则下一个人会以为注入点了我的名
  console.log('  ✅ 注入自称「你是一个 **常驻 agent**」—— 角色一致（它按 type 走，**点不了名**）');
  console.log(`      ⚠️ 而它没说我是谁 —— 「我是 ${ME}」仍然只由 agents/${ME}/CLAUDE.md 决定`);
} else if (!instr) {
  console.log(`  ⚠️  本轮没有 _orchestrator_instructions（可能是 timeout 轮）`);
} else if (!idSeg) {
  // ✅ 注入里没有身份段（全是长规则文档）——**这不是问题，不要报红**
  //   把规则文档当成「别人的身份」而关掉它，就是假红灯。
  // ⚠️ 措辞要同时说清两件**不同**的事，否则跟下面那行 ⛔ 读起来像矛盾：
  //   ① 这些规则文档**该读**（它们不是「别人的身份」）
  //   ② 但它们**不构成身份声明** —— 我是谁仍然只由 CLAUDE.md 决定
  console.log(`  ℹ️  注入 ${segments.length} 段全是规则文档，无身份段`);
  console.log(`      ✅ 这些文档**是给我的，照读**（把它们当「别人的」= 假红灯）`);
} else {
  console.log(`  ⚠️  身份段存在但没识别出自我介绍句 —— 句式可能变了，检测器要复查`);
}
// ⛔ 兜底断言：万一将来有人加了分支却忘了让它拒绝，这一行会喊出来。
//   （上面每个分支的措辞都可以改，而这一行管的是**结论**。）
if (!PASS) {
  console.log('  ⛔ 结论：本轮注入**没有**一句可认的身份/角色声明，或者它自称是编排者 ⇒ 不作为我的身份依据');
}
// ★ 双向正控：证明这个检测器**能分辨**，而不只是能跑
//   （正控证明查询能跑，不证明查询能分辨）
const ctlPos = claimsIdentity('你是 **JARVIS**，EngLoop 的编排者', ORCHESTRATOR);
const ctlNeg = claimsIdentity('你是 **JARVIS**，EngLoop 的编排者', ME);
// ★ 变异正控：一个「函数照常工作但答案永远让我安心」的样本，必须仍然报警
//   （判别标准是「这个变异会不会让告警**消失**」）
const ctlMut = (() => {
  const m = '你是 **JARVIS**，编排者。\n顺带一提：你是 dev 的上级。';
  return claimsIdentity(m.slice(0, 300), ORCHESTRATOR);   // 必须仍然 true
})();
console.log(`  ★ 双向正控  阳性(该报警的样本)=${ctlPos ? '✅' : '🔴'}  `
  + `阴性(不该报警的)=${ctlNeg ? '🔴 误报' : '✅'}  `
  + `变异(让告警消失的样本)=${ctlMut ? '✅ 仍报警' : '🔴 被吞'}`);
if (!ctlPos || ctlNeg || !ctlMut) {
  console.log('  🔴 正控没过 —— 上面那行身份结论**不算数**');
}
if (meAnywhere && !injectedIsMe) {
  console.log(`  ℹ️  注入正文别处提到「你是 ${ME}…」（正常：编排者会写到我）——`);
  console.log(`      已按开头判定，未被它影响（正文别处提到「你是 X」不算身份声明，算了就是假绿灯）。`);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// ── 消息 ────────────────────────────────────────────────────────
const msgs = j.messages || [];
// ── 🔴 poller 的告警字段 ─────────────────────────────
//
//   `bin/next.js` 把告警算好放在 payload 里；这里不显示的话，
//   **字段存在、正确，而按文档读消息的人看不见它们。**
//
// ★ 顺序照 `bin/next.js` 里那段排序判据：
//     「排序判据不是『哪条更重要』，是**『读晚了的代价能不能挽回』**」
//   ⇒ `_stale_command` 第一：它拦的动作（关掉一个正在干活的会话）**不可恢复**
//   ⇒ `_unacked` 次之：读晚了 ⇒ 消息重投 ⇒ 便宜
//   ⇒ `_busy` 读晚了 ⇒ 已经动了仓库文件 ⇒ 别人那一遍全量作废（可挽回，但要几分钟）
//
// ⚠️ 位置在**身份自检之后、消息之前**：先知道「我是谁」，再看「我别做什么」，
//   而两者都要排在消息前面 —— 消息一多就会把它们挤出 preview。
//
// 🔴 `_busy` **只打 `polled_at` 原样，绝不算「N 秒前」**：
//   那个减法的右操作数是「**你动手的时刻**」，而显示层不知道它。
//   读的人自己减，至少知道自己在减什么；显示层替他算，他就不知道了。
for (const [key, label] of [
  ['_stale_command', '⛔ 关停指令告警'],
  ['_unacked', '⚠️ 漏 ack'],
]) {
  if (typeof j[key] === 'string' && j[key]) {
    console.log(`\n━━ ${label}（${key}）━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    for (const line of j[key].split('\n')) console.log('  ' + line);
  }
}
if (j._busy && typeof j._busy === 'object') {
  console.log('\n━━ ⏸ 有人在跑长任务（_busy）━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  who : ${JSON.stringify(j._busy.who)}`);
  if (j._busy.what) console.log(`  what: ${j._busy.what}`);
  if (j._busy.since) console.log(`  since     : ${j._busy.since}`);
  console.log(`  polled_at : ${j._busy.polled_at}   ← 快照时刻。**从这里到你动手那段，只有你算得出**`);
}

console.log(`消息数 ${msgs.length}${j.timeout ? ' (timeout)' : ''}`);

// ── 自环探针销账 ───────────────────────────────────────────────
//
// ⚠️⚠️ 这一段**必须在下面那行 `if (!msgs.length) process.exit(0)` 之前**。
//
//   探针没回来的表现**就是**一直 timeout ⇒ msgs 为空 ⇒ exit 先跑掉
//   ⇒ 检查器恰好在它唯一该报警的场景里不执行。
//
//   ★ 这是一类常见的错：把检测器放在一个「**故障本身会阻止它运行**」的位置
//     （同类：`ps eww` 截断 · 行式解析吃换行 · `| tail` 裁剪）。
//   ⛔ 挪动这一段之前先想清楚上面这句 —— 它看起来只是「顺序问题」。
try {
  const { reconcile } = require('./self-probe.js');
  const { lines } = reconcile(msgs);
  if (lines.length) {
    console.log('━━ 自环探针 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const l of lines) console.log(l);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
} catch (e) {
  // 探针是附加设施，坏了不该拖垮解析主路径 —— 但**要吭声**，
  // 静默 catch 会让「探针检查从此不工作」长得跟「没有 pending」一模一样。
  console.log(`⚠️ 自环探针检查异常（不影响下面的消息解析）: ${e.message}`);
}

// ── ⛔ 循环守卫：**这一行必须在下面那个 exit 之前** ────────────────────
//
//   掉出循环的致命动作发生在 **poll 返回 timeout 之后**：那一刻会觉得「没事了，
//   该跟人汇报一下」，然后输出终端文本 ⇒ 回合结束 ⇒ 循环死。
//   `outbox-send.js` 的「⏱ 现在就去 poll」挂在写完 outbox 那一刻，管不到这里。
//   ⇒ 把提醒挂到危险时刻本身：poll 一返回就打，尤其 timeout 轮。
//
// ★★ 它必须排在 `exit(0)` 前面 —— 跟上面探针那段是同一个陷阱：
//    timeout 轮正是它唯一真正需要工作的轮次，也正是 exit 会先跑掉的轮次。
//    （放后面的话，它只在「有消息」时出现 —— 而有消息那轮本来就不会停。）
console.log('');
console.log('⛔ 下一个动作**只能是 poller**。不要在这里给人写总结 ——');
console.log('   终端文本不是通道,而且写它 = 回合结束 = 循环停止 = 900 秒后掉册。');
console.log('   要回答人：写 outbox（username 填 Patrick / JARVIS），然后立刻再 poll。');

if (!msgs.length) process.exit(0);

// ── 「等某人回话」账本：**只在那个人开口的这一轮**提醒 ──────────────
//
// ⓘ 这一段放在 exit 之后是**对的**，跟上面探针那段的理由正好相反：
//     探针  「一直没消息」**是**故障的样子  ⇒ 静默 = 漏报 ⇒ 必须在 exit 前
//   ★ 这里  「那个人没说话」**是**预期状态  ⇒ 静默 = 正确行为
//   判据不是「有没有早退」，是**那条安静的路径上藏着故障还是常态**。
try {
  const { reconcile: waitingReconcile } = require('./waiting-on.js');
  const { lines } = waitingReconcile(msgs);
  if (lines.length) {
    console.log('━━ 你在等的人开口了 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const l of lines) console.log(l);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
} catch (e) {
  console.log(`⚠️ 等待账本检查异常（不影响下面的消息解析）: ${e.message}`);
}

console.log(JSON.stringify(msgs.map((m) => m.stream_id)));

// 🔴 timeout 轮手上没有 room_hash：「room_hash 每次从当轮消息里取」这条规矩，
//   在【没有当轮消息】时不适用。而 `> temp/poll-<name>.json` 这个重定向
//   已经把上一轮的数据覆盖掉了 ⇒ 只剩「照抄一个记住的字面值」（规矩禁止的）或「不发」。
//   ✅ 所以这里在**有消息**的那一轮把它存下来 —— 取值仍然来自数据，
//     只是数据源从「当轮消息」变成「最近一次有消息的那轮」。
//   ⚠️ 射程：房间 hash 若在两轮之间变了，这个值就是旧的 —— 它比字面值好，不比当轮好。
if (msgs.length) {
  const withRoom = msgs.filter((m) => m.room_hash);
  if (withRoom.length) {
    const last = withRoom[withRoom.length - 1];
    try {
      fs.writeFileSync(require('node:path').join(__dirname, '..', 'temp', `last-room-${ME}.json`),
        JSON.stringify({ room_hash: last.room_hash, at: new Date(last.timestamp || Date.now()).toISOString(), from: last.from }));
    } catch (e) { console.log(`  ⚠️ 存 last-room 失败：${e.message}`); }
  }
}

// ⭐ 【投影会静默丢弃它没选的字段】：只印自己挑的那几个字段的话，
//   新出现的字段（比如 `redelivered`）每轮都在，而读输出的人看不见。
// ★ 修法不是「加一行印 redelivered」（那只解决这一个），是**印出不认识的那些** ——
//   它对**下一个还不知道名字的字段**同样有效。
//
// 🔴 而这份清单是手写的 —— 它跟 `Object.keys(m)` 那个枚举是一个混合体：
//   **分子（每轮实有的字段）是读的，分母（认识哪些）是手写的**
//   ⇒ 漏写一项（其实认识它）⇒ 它被报出来 ⇒ **假阳性：吵，但安全**
//   🔴 多写一项（其实不认识它）⇒ **它被静默排除** ⇒ **假阴性** ——
//      而那正是这段代码要防的那个洞的自指版本。
// ⚠️ 不给它挂自动检查：判「这个字段名在本文件里被引用过没有」判不准
//   （字段可以经解构 / 转发 / 模板串用掉）⇒ 判不准就别挂。
//   ⇒ 如实标着：**它会飘，而唯一的反驳来自数据 —— 某天一个新字段出现却没被报出来**
//
// 📌 名字用 KNOWN 不用 HANDLED：它的语义是「**认识的**」，不是「处理了的」
//   （`stream`/`job_id`/`timestamp` 这几个并不处理，而它们不该每轮报噪音）
const KNOWN = new Set(['stream_id', 'stream', 'job_id', 'from', 'text', 'timestamp',
  'room_hash', 'room_msg_id', 'reply_to']);
{
  const extras = msgs
    .map((m) => [m.stream_id, Object.keys(m).filter((k) => !KNOWN.has(k))])
    .filter(([, ks]) => ks.length)
    .map(([id, ks]) => `${id} → ${JSON.stringify(ks)}`);
  // 🔴 结论行是一个表达式的值（写的时候就没法恒真），而输入（条数）印在同一行
  console.log(extras.length === 0
    ? `  ⓘ 本轮 ${msgs.length} 条，没有我不认识的字段（含 redelivered ⇒ **都不是重投**）`
    : `  ⚠️ 本轮 **${extras.length}/${msgs.length}** 条带着我不认识的字段：\n     ${extras.join('\n     ')}`);
}


let priv = 0;
for (const m of msgs) {
  if (!m.room_hash) {
    priv++;
    // ★ 截断必须**自报长度** —— 否则「被截断的」和「本来就这么长的」在输出上一样
    {
      const full = String(m.text || '');
      const shown = full.slice(0, 1500);
      const more = full.length > shown.length
        ? `\n… ⚠️ **本条共 ${full.length} 字，上面只显示了 ${shown.length} 字。完整内容在 ${SRC}（这个文件里是完整的）**`
        : '';
      console.log(`\n[🔴 私聊/可能派活] ${m.from}\n${shown}${more}`);
    }
  }
}
if (!priv) console.log('(无私聊 = 无派活)');

for (const m of msgs) {
  let i = -1;
  while ((i = m.text.indexOf(`@${ME}`, i + 1)) >= 0) {
    {
      const full = String(m.text || '');
      const shown = full.slice(i, i + 300);
      const more = full.length > i + shown.length
        ? ` … ⚠️ **本条共 ${full.length} 字（这里只是点名处前后 ${shown.length} 字）。完整在 ${SRC}**`
        : '';
      console.log(`\n[点名 ${m.from}] ${shown.replace(/\n/g, ' ')}${more}`);
    }
  }
}
