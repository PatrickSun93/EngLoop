'use strict';

/**
 * bus 鉴权的**源码级内存变异**：把鉴权 / 盖章 / 读章的关键一行在内存里删掉（或改掉），
 * 要求**指定的那条**判据变红。一个字节都不落盘（`scripts/_srcmut-hook.js`）。
 *
 * ── 为什么要「指定的那条」，不是「有红就算」──────────────────────────────
 *   假绿有两种常见形状：断言命中了注释里的同一个串、`indexOf` 的 -1 恒小于任何位置 ——
 *   这类判据在变异下**照样绿**。
 *   反过来，一个把 bus 弄崩的变异会让**所有**判据一起红，那也证明不了某一条判据有分辨力。
 *   ⇒ 判档：
 *     ✅ killed     指定的那条（label 子串）出现在 `✗` 行里，且跑到了总结行
 *     ⚠️ crashed    没有总结行（进程崩了 / 超时）—— **不算 killed**
 *     🔴 survived   跑完了，而指定的那条仍是 `✓`
 *
 * 用法：node scripts/mutate-bus-auth.js            全部
 *       node scripts/mutate-bus-auth.js M3 M7      只跑这几个
 *
 * ⚠️ bus-auth 那份每跑一次 ~25 秒（要等 relay 挂上），全部跑完约 5 分钟。不进 run-all。
 *   S1–S16 是登录三处修复（用户名不分大小写 · session 落盘 · 一次性登录 token）：
 *   单元那份几秒一个，bus-session 那份（起停隔离 bus 五次）约 15 秒一个。
 *   只跑这一组：node scripts/mutate-bus-auth.js S1 S2 … S16
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(__dirname, '_srcmut-hook.js');
const F = (p) => path.join(ROOT, p);
const INTEG = 'test/bus-auth.test.js';
const UNIT = 'test/auth-stamp.test.js';
// 登录三处修复（TASK_S1A）：用户名不分大小写 · session 落盘 · 一次性登录 token
const S_UNIT = 'test/auth-session.test.js';
const S_INTEG = 'test/bus-session.test.js';

const MUTANTS = [
  { id: 'M1', what: 'serve.js：/api/message 的 from 改回从 body 取',
    file: 'bin/serve.js', from: 'const from = req.principal.username;',
    to: 'const from = (req.body && req.body.from) || req.principal.username;',
    test: INTEG, expect: 'body 写 from:"Mallory" ⇒ 流条目的 from' },
  { id: 'M2', what: 'serve.js：shutdown 端点拿掉 requireManage',
    file: 'bin/serve.js', from: "app.post('/api/agents/:name/shutdown', busAuth.requireManage, async",
    to: "app.post('/api/agents/:name/shutdown', async",
    test: INTEG, expect: '/api/agents/__nobody__/shutdown can_manage_workers:false 的 session ⇒ 403' },
  { id: 'M3', what: 'serve.js：WS 不做 verifyClient',
    file: 'bin/serve.js', from: 'verifyClient: busAuth.verifyClient', to: 'verifyClient: undefined',
    test: INTEG, expect: '/ws 无凭据 ⇒ upgrade 被拒' },
  { id: 'M4', what: 'serve.js：房间扇出不带章',
    file: 'bin/serve.js', from: '...stamp.pick(m),', to: '',
    test: INTEG, expect: '扇出到 agent 收件流的那份' },
  { id: 'M5', what: 'serve.js：拿掉 /api 闸门',
    file: 'bin/serve.js', from: "app.use('/api', busAuth.requireAuth);", to: '',
    test: INTEG, expect: 'POST /api/message 无凭据 ⇒ 401' },
  { id: 'M6', what: 'relay.js：agent 消息不盖章',
    file: 'lib/relay.js', from: '...stamp.AGENT,\n          to: target.to,', to: 'to: target.to,',
    test: INTEG, expect: 'agent 消息 ⇒ trust:"agent"' },
  { id: 'M7', what: 'next.js：poller 输出不带三个字段',
    file: 'bin/next.js', from: '...stamp.readStamp(m),', to: '',
    test: INTEG, expect: '人类（Patrick）消息 ⇒ trust:"principal"' },
  { id: 'M8', what: 'stamp.js：没有章默认成 human',
    file: 'lib/stamp.js', from: "SENDER_TYPES.includes(raw) ? raw : 'unknown'", to: "SENDER_TYPES.includes(raw) ? raw : 'human'",
    test: INTEG, expect: '手工 XADD、不带章' },
  { id: 'M9', what: 'stamp.js：管理权不要求 human 章',
    file: 'lib/stamp.js', from: "const can_manage_workers = sender_type === 'human'\n    && (", to: 'const can_manage_workers = (',
    test: UNIT, expect: 'agent 章 ＋ "1" ⇒ false' },
  { id: 'M10', what: 'shutdown.js：关停请求不盖 system 章',
    file: 'lib/shutdown.js', from: '    ...stamp.SYSTEM,\n', to: '',
    test: INTEG, expect: 'SHUTDOWN_REQUEST ⇒ trust:"system"' },
  { id: 'M11', what: 'rooms.js：房间发言不写章',
    file: 'lib/rooms.js', from: '...Object.entries(sealed).flat(),', to: '',
    test: INTEG, expect: '房间流条目：from=Patrick · sender_type=human' },
  { id: 'M12', what: 'auth.js：requireManage 不查 can_manage_workers',
    file: 'lib/auth.js', from: 'if (p.can_manage_workers !== true) {', to: 'if (false) {',
    test: UNIT, expect: 'requireManage：Viewer ⇒ 403' },
  { id: 'M13', what: 'agent-settings.js：不 denyRead 钥匙',
    file: 'lib/agent-settings.js', from: 'filesystem: { allowWrite, denyRead: secrets, denyWrite },', to: 'filesystem: { allowWrite, denyWrite },',
    test: UNIT, expect: 'sandbox.filesystem.denyRead' },
  { id: 'M14', what: 'agent-settings.js：不加 Read(//…) deny',
    file: 'lib/agent-settings.js', from: '    ...secretFiles.map((f) => `Read(${abs(f)})`),\n', to: '',
    test: UNIT, expect: 'permissions.deny 有两条 Read' },

  // ── S：TASK_S1A ──
  { id: 'S1', what: 'auth.js：用户名比较不转小写',
    file: 'lib/auth.js', from: 'users.filter((u) => u.username.toLowerCase() === want)', to: 'users.filter((u) => u.username === String(username))',
    test: S_UNIT, expect: '小写 patrick ＋ 对的 key ⇒ 登录成功' },
  // ★ 匹配不唯一有两道：findUser 只在唯一时给 user ＋ login 里显式拒并写日志。
  //   只拆一道时另一道兜住 ⇒ 「都被拒」那条照样绿（实测：只改 findUser 是 survived）。
  //   ⇒ S2 两道一起拆，验「拒」那条；S2b 只拆 login 那道，验「写日志」那条。
  { id: 'S2', what: 'auth.js：匹配不唯一时取第一个（两道一起拆）',
    specs: [
      { file: 'lib/auth.js', from: 'user: matches.length === 1 ? matches[0] : null', to: 'user: matches[0] || null' },
      { file: 'lib/auth.js', from: "if (matches.length > 1) { logAmbiguous('登录', username, matches); return null; }", to: '' },
    ],
    test: S_UNIT, expect: '表里有 Patrick 和 patrick ⇒ 两个写法' },
  { id: 'S2b', what: 'auth.js：login 匹配不唯一时不写日志',
    file: 'lib/auth.js', from: "if (matches.length > 1) { logAmbiguous('登录', username, matches); return null; }", to: '',
    test: S_UNIT, expect: '拒绝原因写进 bus 日志' },
  { id: 'S3', what: 'bus-user.js：add 不查只差大小写的名字',
    file: 'bin/bus-user.js', from: 'if (clash.length) {', to: 'if (false) {',
    test: S_UNIT, expect: '已有 Patrick，再 add patrick ⇒ 退 1' },
  { id: 'S4', what: 'auth.js：createAuth 不加载 session 文件',
    file: 'lib/auth.js', from: 'const r = loadSessions(sessionsFile, { users, now: now() });\n    sessions = r.sessions;',
    to: 'const r = loadSessions(sessionsFile, { users, now: now() });',
    test: S_UNIT, expect: '新实例（= bus 重启）加载文件' },
  { id: 'S5', what: 'auth.js：加载时不按用户表复核',
    file: 'lib/auth.js', from: '    if (!sessionStillValid(s, users)) { out.revoked += 1; continue; }\n', to: '',
    test: S_UNIT, expect: '加载时按用户表复核' },
  { id: 'S6', what: 'auth.js：鉴权时不按用户表复核',
    file: 'lib/auth.js', from: 'if (!sessionStillValid(s, users)) { sessions.delete(key); persist(); return null; }', to: '',
    test: S_UNIT, expect: '鉴权时也核：不重启、换了 key' },
  { id: 'S7', what: 'auth.js：session 文件不设 0600',
    file: 'lib/auth.js', from: 'fs.writeFileSync(tmp, text, { mode: 0o600 });\n  fs.chmodSync(tmp, 0o600);', to: 'fs.writeFileSync(tmp, text);',
    test: S_UNIT, expect: '写出 session 文件，权限 0600' },
  { id: 'S8', what: 'auth.js：session 表的键存 sid 原文',
    file: 'lib/auth.js', from: 'sessions.set(sha256(sid), {', to: 'sessions.set(sid, {',
    test: S_UNIT, expect: '文件里的 key 是 sid 的 sha256' },
  { id: 'S9', what: 'auth.js：token 用过不删',
    file: 'lib/auth.js', from: '    delete tokens[h];\n    consumed.set(h, rec.exp);', to: '    consumed.set(h, rec.exp);',
    test: S_UNIT, expect: '用过即删：文件里没有它了' },
  { id: 'S10', what: 'auth.js：不在内存里记用过的 token',
    file: 'lib/auth.js', from: "if (consumed.has(h)) return { ok: false, reason: 'used' };", to: '',
    test: S_UNIT, expect: 'token 文件被写回旧版本' },
  { id: 'S11', what: 'auth.js：token 不判过期',
    file: 'lib/auth.js', from: "if (rec.exp <= t0) return { ok: false, reason: 'expired' };", to: '',
    test: S_UNIT, expect: '过了 10 分钟 ⇒ expired' },
  { id: 'S12', what: 'auth.js：token 文件写不回去也放行',
    file: 'lib/auth.js', from: "      return { ok: false, reason: 'store' };\n", to: '',
    test: S_UNIT, expect: 'token 文件写不回去（删不掉）⇒ 拒' },
  { id: 'S13', what: 'agent-settings.js：secretPaths 漏掉 session / token 文件',
    file: 'lib/agent-settings.js', from: "    path.join(root, 'temp', 'web-sessions.json'), path.join(root, 'temp', 'login-tokens.json'),\n", to: '',
    test: S_UNIT, expect: 'crew dev：sandbox.filesystem.denyRead 有两者' },
  { id: 'S14', what: 'agent-settings.js：写集放行整个 temp/',
    file: 'lib/agent-settings.js', from: "    path.join(temp, 'plugin-runs'),\n", to: "    path.join(temp, 'plugin-runs'), temp,\n",
    test: S_UNIT, expect: 'crew dev：sandbox 写集里没有它们' },
  { id: 'S15', what: 'serve.js：createAuth 不给 sessionsFile',
    file: 'bin/serve.js', from: '  sessionsFile: WEB_SESSIONS_FILE,\n', to: '',
    test: S_INTEG, expect: '重启后同一个 cookie：/api/whoami 200' },
  { id: 'S16', what: 'serve.js：/api/login-token 挂在闸门之后',
    file: 'bin/serve.js', from: "app.post('/api/login-token', busAuth.loginTokenHandler());\napp.use('/api', busAuth.requireAuth);",
    to: "app.use('/api', busAuth.requireAuth);\napp.post('/api/login-token', busAuth.loginTokenHandler());",
    test: S_INTEG, expect: 'token 换 cookie：200' },
];

function runOne(m) {
  const env = { ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${HOOK}`.trim(),
    // `specs`：一个变异要同时改几处时用（_srcmut-hook 收数组）
    ENGLOOP_SRCMUT: JSON.stringify(m.specs ? m.specs.map((s) => ({ ...s, file: F(s.file) }))
      : { file: F(m.file), from: m.from, to: m.to }) };
  const r = spawnSync('node', [F(m.test)], { cwd: ROOT, env, encoding: 'utf8', timeout: 240000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const summary = /通过 \d+ · 失败 \d+/.exec(out);
  const red = out.split('\n').filter((l) => /^\s*✗/.test(l));
  const hit = red.some((l) => l.includes(m.expect));
  const verdict = !summary ? 'crashed' : hit ? 'killed' : 'survived';
  return { verdict, summary: summary ? summary[0] : `（无总结行，exit ${r.status}）`, red: red.length,
    first: (red.find((l) => l.includes(m.expect)) || red[0] || '').trim().slice(0, 140),
    tail: summary ? '' : out.slice(-300) };
}

const pick = process.argv.slice(2);
const list = pick.length ? MUTANTS.filter((m) => pick.includes(m.id)) : MUTANTS;
let killed = 0;
for (const m of list) {
  const r = runOne(m);
  if (r.verdict === 'killed') killed += 1;
  const icon = { killed: '✅', crashed: '⚠️', survived: '🔴' }[r.verdict];
  console.log(`${icon} ${m.id} ${r.verdict.padEnd(8)} ${m.what}`);
  console.log(`     ${path.basename(m.test)}：${r.summary} · 红 ${r.red} 条 · 指定那条：${r.first || '（没红）'}`);
  if (r.tail) console.log(`     ${r.tail.replace(/\n/g, '\n     ')}`);
}
console.log(`\n变异 ${list.length} 个 · 被指定判据杀掉 ${killed} 个`);
process.exit(killed === list.length ? 0 : 1);
