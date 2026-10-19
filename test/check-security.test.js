'use strict';

/**
 * hooks/check_security.js 的测试。
 *
 * ── 这个文件守的是什么 ──────────────────────────────────────────
 * hook 靠**退出码**工作：2 = 拒绝，0 = 放行。搞反了就是全放行，而且从
 * 外面完全看不出来 —— 所以每条断言都直接看退出码，不看别的。
 *
 * ★ 安全测试最容易变成「看起来在守着什么」。两个防假绿的做法：
 *
 * 1. **阴性对照**：不能只测「该拒的拒了」。一个无条件 exit 2 的实现能
 *    通过全部拒绝测试，而它会让每个 agent 都动不了。所以必须同时断言
 *    **该放的放了**（npm test、node script.js、git status、eval 用 WebFetch）。
 * 2. **变异验证**：写完摘掉被测的那根线，看对应的断言是不是真的红。
 *    见文件末尾 —— 那一段是手动跑的，不在自动测试里。
 * ────────────────────────────────────────────────────────────────
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'check_security.js');
const REAL_POLICY = path.join(ROOT, 'config', 'url_policy.json');

// ★ 测试**从不碰真的 policy 文件**，全部指向临时文件。
//
// 把真文件挪走再挪回来测「缺失」那条，有个很阴的失败模式：
// 测试崩在中间 → policy 留在缺失状态 → 按 fail-closed 所有 web 调用被拒 →
// **而故障现场跟「hook 正常工作」一模一样，都是 REJECT**。
// 测试的清理动作只在正常路径上执行，是最不可靠的一环。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-policy-'));
const MISSING_POLICY = path.join(TMP, 'does-not-exist.json');

/** 写一份临时 policy，返回它的路径。 */
function tmpPolicy(name, content) {
  const p = path.join(TMP, `${name}.json`);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

// 跟真文件同构的一份，用来测「策略正常时的判定」
const GOOD_POLICY = tmpPolicy('good', {
  require_https: true,
  block_raw_ip: true,
  blocked_domains: ['github.com', 'npmjs.com', 'localhost'],
  blocked_domain_patterns: ['*.github.com', '*.internal'],
});

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

/**
 * 跑一次 hook。返回退出码。
 * @param {object|string} payload  给 stdin 的内容（字符串则原样喂，用来测畸形输入）
 * @param {object} env             额外环境变量；显式传 null 表示删掉那个变量
 */
function runHook(payload, env = {}) {
  const childEnv = {
    ...process.env,
    ENGLOOP_AGENT_TYPE: 'dev',
    ENGLOOP_URL_POLICY: GOOD_POLICY,   // 默认用临时的那份，个别用例再覆盖
    ...env,
  };
  for (const k of Object.keys(env)) if (env[k] === null) delete childEnv[k];
  const r = spawnSync('node', [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: childEnv,
    encoding: 'utf8',
  });
  return { code: r.status, stderr: r.stderr || '' };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const web = (tool, url) => ({ tool_name: tool, tool_input: url ? { url } : {} });

const REJECT = 2;
const ALLOW = 0;

function main() {
  console.log('\n【1】★ 三处 fail-closed —— 本次移植的核心');
  // A：畸形输入要是在这里 exit(0)，整个 hook 就变成空操作
  ok(runHook('这不是 json').code === REJECT, '畸形 stdin → 拒绝（v1 是放行全部检查）');
  ok(runHook('').code === REJECT, '★ 空 stdin 也拒绝（JSON.parse("") 同样抛错）');
  ok(/无法解析/.test(runHook('{坏').stderr), '错误信息说清了为什么拒');

  // B：检测失败不能当 dev —— dev 是有 Bash 的那个 → 方向会翻转
  ok(runHook(bash('npm test'), { ENGLOOP_AGENT_TYPE: null }).code === REJECT,
    '类型变量缺失 → 拒绝（v1 默认当 dev）');
  ok(/ENGLOOP_AGENT_TYPE/.test(runHook(bash('npm test'), { ENGLOOP_AGENT_TYPE: null }).stderr),
    '错误信息点名了缺哪个变量');
  ok(runHook(bash('npm test'), { ENGLOOP_AGENT_TYPE: 'wat' }).code === REJECT,
    '不认识的类型 → 拒绝');
  ok(/不认识/.test(runHook(bash('npm test'), { ENGLOOP_AGENT_TYPE: 'wat' }).stderr),
    '★「没设」和「设了个不认识的」分开报（修法不同）');

  // C：policy 缺失 → 拒绝。指向一个不存在的路径，**不碰真文件**
  const asEvalNoPolicy = { ENGLOOP_AGENT_TYPE: 'eval', ENGLOOP_URL_POLICY: MISSING_POLICY };
  const noPolicy = runHook(web('WebFetch', 'https://example.com'), asEvalNoPolicy);
  ok(noPolicy.code === REJECT, 'policy 文件缺失 → 拒绝（v1 是跳过整段 URL 检查）');
  ok(/策略/.test(noPolicy.stderr), '错误信息说清是策略文件的问题');

  // D：规格没点到的第四处 —— 文件在、JSON 合法、但内容是空的。
  // `{}` 会让 http + 裸 IP 双重违规的 URL 照样放行，因为每个开关
  // 都是 undefined。「没人说过话」不能等同于「有人说了不用查」。
  const emptyPolicy = runHook(web('WebFetch', 'http://1.2.3.4/x'), {
    ENGLOOP_AGENT_TYPE: 'eval', ENGLOOP_URL_POLICY: tmpPolicy('empty', {}),
  });
  const partialPolicy = runHook(web('WebFetch', 'https://ok.example.com/x'), {
    ENGLOOP_AGENT_TYPE: 'eval',
    ENGLOOP_URL_POLICY: tmpPolicy('partial', { require_https: true, block_raw_ip: true, blocked_domains: [] }),
  });
  const badJson = runHook(web('WebFetch', 'https://ok.example.com/x'), {
    ENGLOOP_AGENT_TYPE: 'eval', ENGLOOP_URL_POLICY: tmpPolicy('badjson', '{这不是 json'),
  });
  ok(emptyPolicy.code === REJECT, '★ policy 是空对象（JSON 合法）→ 拒绝，不是静默放行');
  ok(partialPolicy.code === REJECT, '★ policy 缺一个字段 → 拒绝（不完整的策略等于没策略）');
  ok(/缺字段/.test(partialPolicy.stderr), '错误信息点名了缺哪个字段');
  ok(badJson.code === REJECT, 'policy 是坏 JSON → 拒绝');

  // ★ 真文件从头到尾没被动过 —— 这条断言是给「测试自己别留残留」上的锁
  ok(fs.existsSync(REAL_POLICY), '★ 真的 config/url_policy.json 一直在（测试只用临时文件）');

  console.log('\n【1b】★ 真实输入样本（照 Claude Code 实际发给 hook 的完整载荷，不是最小结构）');
  // 上面那些用例喂的是**想象出来的**最小结构。这一节喂的是真实抓到的完整
  // 载荷 —— 多了 session_id / transcript_path / cwd / permission_mode /
  // effort / hook_event_name / tool_use_id 这些字段。
  //
  // ★ 守的是：将来有人改解析逻辑（比如改成严格 schema 校验），
  //   只用简化样本测的话不会红，而真实输入会被拒 —— 那时**每个 agent 的
  //   每次工具调用都被拒**，故障现场跟「hook 正常工作」一模一样。
  const REAL_BASH = {
    session_id: '00000000-0000-4000-8000-000000000001',
    transcript_path: '/home/x/.claude/projects/y/z.jsonl',
    cwd: '/private/var/folders/tmp/probe',
    prompt_id: '00000000-0000-4000-8000-000000000002',
    permission_mode: 'bypassPermissions',
    effort: { level: 'xhigh' },
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hello-from-probe', description: 'Echo test string' },
    tool_use_id: 'toolu_000000000000000000000001',
  };
  const REAL_WEB = {
    ...REAL_BASH,
    tool_name: 'WebFetch',
    tool_input: { url: 'https://example.com', prompt: '这个页面的内容是什么？' },
  };
  ok(runHook(REAL_BASH).code === ALLOW, '★ 真实 Bash 载荷（含全部额外字段）→ 放行');
  ok(runHook({ ...REAL_BASH, tool_input: { command: 'rm -rf /' } }).code === REJECT,
    '真实结构 + 违规命令 → 拒（说明 command 字段真的被读到了）');
  ok(runHook(REAL_WEB, { ENGLOOP_AGENT_TYPE: 'eval' }).code === ALLOW,
    '★ 真实 WebFetch 载荷 → 放行');
  ok(runHook({ ...REAL_WEB, tool_input: { url: 'https://github.com/x', prompt: 'p' } },
    { ENGLOOP_AGENT_TYPE: 'eval', ENGLOOP_URL_POLICY: REAL_POLICY }).code === REJECT,
    '★ 真实结构 + 被禁域名 → 拒（说明 tool_input.url 真的被读到了，不是读到 undefined 然后放行）');

  console.log('\n【2】工具级能力分离');
  ok(runHook(bash('npm test'), { ENGLOOP_AGENT_TYPE: 'eval' }).code === REJECT,
    '★ eval 用 Bash → 拒（它是唯一能上网的，所以绝不能执行代码）');
  // ⚠️⚠️ dev 开放上网是明确的决定。**这条从「拒」翻成了「放行」。**
  //
  //   ★ 它翻过来意味着能力分离对 dev 已经不成立:web + bash + write 三样都有,
  //     所以网页内容能进它的上下文,而它能执行任意命令、写任意文件。
  //     **提示注入因此从「读到一段可疑文字」升级成「任意代码执行」。**
  //
  //   ★★ 留这段注释是因为:这条断言现在长得像「dev 本来就该能上网」,
  //     而实际上它是一个被推翻的不变量。**下一个人看到绿的,不会知道曾经有过一条线。**
  //     eval 那条（下面第一行）仍然守着原来的规矩 —— 两条并排放,差别才看得见。
  ok(runHook(web('WebFetch', 'https://example.com'), { ENGLOOP_AGENT_TYPE: 'dev' }).code === ALLOW,
    '★ dev 用 WebFetch → **放行**（明确放开的;此前是拒）');
  ok(runHook(web('WebSearch'), { ENGLOOP_AGENT_TYPE: 'solve' }).code === REJECT,
    'solve 用 WebSearch → 拒');
  ok(runHook(web('WebFetch', 'https://example.com'), { ENGLOOP_AGENT_TYPE: 'write' }).code === REJECT,
    'write 用 WebFetch → 拒');
  ok(runHook(bash('node x.js'), { ENGLOOP_AGENT_TYPE: 'orchestrator' }).code === ALLOW,
    'orchestrator 用 Bash → 放行');

  console.log('\n【3】★ 阴性对照：该放的必须放');
  // 只测拒绝的话，一个无条件 exit 2 的实现能通过上面每一条
  ok(runHook(web('WebFetch', 'https://example.com'), { ENGLOOP_AGENT_TYPE: 'eval' }).code === ALLOW,
    '★ eval 用 WebFetch → **放行**（否则「全拒」实现也能过全部测试）');
  ok(runHook(web('WebSearch'), { ENGLOOP_AGENT_TYPE: 'eval' }).code === ALLOW,
    'eval 用 WebSearch → 放行（没有 URL 可查）');
  ok(runHook(bash('npm test')).code === ALLOW, 'npm test → 放行');
  ok(runHook(bash('node test/run-all.js')).code === ALLOW, 'node script.js → 放行');
  ok(runHook(bash('git status --short')).code === ALLOW, 'git status → 放行');
  ok(runHook(bash('ls -la /opt/project')).code === ALLOW,
    '★ 绝对路径 → 放行（v1 拒绝，v2 删了那条：会误伤，而误伤的结局是整个 hook 被关掉）');
  ok(runHook({ tool_name: 'Read', tool_input: {} }).code === ALLOW, '非受检工具（Read）→ 放行');

  console.log('\n【4】命令级：现在只剩三条灾难性误操作');
  // ⚠️ 命令级规则已放开（限制太多会挡住正常工作）。
  //
  //   拿掉的八条:&& || ; 串联 · 管道 · $() 反引号 · 重定向 · node -e/-p ·
  //             python/pip · curl/wget · ssh · 连续引号
  //
  //   ★ 判据（拿掉时定的，往回加时先问这一句）:
  //     **这条拦的是灾难，还是写法?**
  //     拿掉的八条全是后者 —— 它们挡的是写法，不是真正危险的操作。
  ok(runHook(bash('rm -rf /')).code === REJECT, '★ rm -rf / → 拒（灾难,不是写法）');
  ok(runHook(bash('del /f x')).code === REJECT, 'del /f → 拒');
  ok(runHook(bash('format c:')).code === REJECT, 'format → 拒');

  console.log('\n【4b】★ 阴性对照：拿掉的那八条现在真的放行了');
  // 没有这一节的话，一个「什么都拒」的实现能让【4】全绿
  ok(runHook(bash('cd /tmp && ls')).code === ALLOW, '&& 串联 → 放行');
  ok(runHook(bash('cat x | grep y')).code === ALLOW, '管道 → 放行');
  ok(runHook(bash('echo $(whoami)')).code === ALLOW, '$() 命令替换 → 放行');
  ok(runHook(bash('node x.js > out.txt')).code === ALLOW, '输出重定向 → 放行');
  ok(runHook(bash('node -e "console.log(1)"')).code === ALLOW, 'node -e → 放行');
  ok(runHook(bash('python3 script.py')).code === ALLOW, '★ python3 → 放行（三个 agent 都撞过这条）');
  ok(runHook(bash('pip install x')).code === ALLOW, 'pip → 放行');
  ok(runHook(bash('curl https://example.com')).code === ALLOW,
    'curl → 放行（web 工具开了之后,禁它已经没有意义）');
  ok(runHook(bash('ssh host')).code === ALLOW, 'ssh → 放行');

  console.log('\n【5】URL 策略（eval 才走得到这里）');
  const asEval = { ENGLOOP_AGENT_TYPE: 'eval' };
  ok(runHook(web('WebFetch', 'http://example.com'), asEval).code === REJECT, 'http → 拒（require_https）');
  ok(runHook(web('WebFetch', 'https://1.2.3.4/x'), asEval).code === REJECT, '裸 IP → 拒');
  ok(runHook(web('WebFetch', 'https://localhost/x'), asEval).code === REJECT, '被禁域名 → 拒');
  ok(runHook(web('WebFetch', 'https://foo.internal/x'), asEval).code === REJECT, '匹配禁止模式 → 拒');
  ok(runHook(web('WebFetch', '不是个 url'), asEval).code === REJECT, '非法 URL → 拒');
  ok(runHook(web('WebFetch', 'https://good.example.com/x'), asEval).code === ALLOW,
    '★ 正常 https 域名 → 放行（阴性对照）');

  console.log('\n【6】policy 的内容真的在起作用（不是硬编码在代码里）');
  // 只测「该拒的拒了」证明不了判定来自 policy —— 那也可能是写死在代码里的。
  // 换一份 require_https:false 的 policy，同一个 http URL 必须放行。
  const permissive = tmpPolicy('permissive', {
    require_https: false, block_raw_ip: false, blocked_domains: [], blocked_domain_patterns: [],
  });
  ok(runHook(web('WebFetch', 'http://example.com'), { ...asEval, ENGLOOP_URL_POLICY: permissive }).code === ALLOW,
    '★ require_https:false 时 http → 放行（证明判定读的是 policy）');
  ok(runHook(web('WebFetch', 'https://1.2.3.4/x'), { ...asEval, ENGLOOP_URL_POLICY: permissive }).code === ALLOW,
    '★ block_raw_ip:false 时裸 IP → 放行（同上）');

  console.log('\n【7】真实 policy 拦的是「能取代码的地方」（v1 的网页安全协议）');
  // 这几条直接跑**真的** config/url_policy.json，确认它内容对得上协议
  const realPolicy = { ENGLOOP_AGENT_TYPE: 'eval', ENGLOOP_URL_POLICY: REAL_POLICY };
  ok(runHook(web('WebFetch', 'https://github.com/x/y'), realPolicy).code === REJECT, '代码仓库 github.com → 拒');
  ok(runHook(web('WebFetch', 'https://raw.githubusercontent.com/x'), realPolicy).code === REJECT,
    '子域 raw.githubusercontent.com → 拒');
  ok(runHook(web('WebFetch', 'https://www.npmjs.com/package/x'), realPolicy).code === REJECT,
    '包 registry npmjs.com → 拒');
  ok(runHook(web('WebFetch', 'https://stackoverflow.com/q/1'), realPolicy).code === REJECT,
    '代码问答站 stackoverflow.com → 拒');
  ok(runHook(web('WebFetch', 'https://docs.python.org/3/'), realPolicy).code === ALLOW,
    '★ 官方文档站 → 放行（协议明说可以做研究）');
  ok(runHook(web('WebFetch', 'https://arxiv.org/abs/1234'), realPolicy).code === ALLOW,
    '★ 论文站 → 放行');

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();

/*
 * ── 变异验证记录（手动跑，不在自动测试里）────────────────────────
 * 一条永远绿的安全测试没有价值。每条线摘掉之后，必须有断言变红：
 *
 *   摘 fail-closed A（改回 exit 0）      → 【1】前三条红
 *   摘 fail-closed B（缺变量时默认 dev） → 【1】第四、五条红
 *   摘 fail-closed C（policy 缺失跳过）  → 【1】最后两条红
 *   摘工具级 web 判定                    → 【2】dev/solve/write 三条红
 *   摘工具级 bash 判定                   → 【2】eval 用 Bash 那条红
 *   摘任意一条命令规则                   → 【4】对应那条红
 *   把 reject 的 exit 2 改成 exit 0      → 几乎全红（退出码是唯一的接口）
 */
