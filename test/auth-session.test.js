'use strict';

/**
 * 登录三处修复（TASK_S1A）的单元层：用户名不分大小写 · session 落盘 · 一次性登录 token。
 *
 * 真 bus 上的那一圈（重启后同一个 cookie 还是 200、删掉文件重启后 401、链接 POST 换 cookie、
 * 换 key 后旧 cookie 当场 401）在 `test/bus-session.test.js`。这里守的是**判据本身**。
 *
 * ── 为什么要单独守「写集」──────────────────────────────────────────────
 *   session 文件和 token 文件**被 agent 写到 = 能以任何用户登录**（写一条自己 sid / token 的摘要）。
 *   那是 `lib/auth.js` 头注里「为什么不存 Redis」的同一格。拒读只是第二层 ——
 *   ⇒ 【5】既断言它们在 denyRead 里，也断言**它们不在任何 agent 的写集里**。
 *
 * 变异（不落盘）：`scripts/mutate-bus-auth.js` 的 S1–S9。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const auth = require('../lib/auth');
const { buildCrewSettings, buildAgentSettings, secretPaths } = require('../lib/agent-settings');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-authsession-'));
const cookieOf = (sid) => ({ cookie: `${auth.COOKIE}=${sid}` });
const mode = (f) => fs.statSync(f).mode & 0o777;

const P = { username: 'Patrick', key_sha256: auth.sha256('kp'), can_manage_workers: true };
const V = { username: 'Viewer', key_sha256: auth.sha256('kv'), can_manage_workers: false };

console.log('\n【1】用户名不分大小写（R1）');
{
  const logs = [];
  const a = auth.createAuth({ adminToken: auth.newAdminToken(), getUsers: () => [P, V], log: (m) => logs.push(m) });
  const s1 = a.login('patrick', 'kp');
  ok(s1 && s1.principal.username === 'Patrick', '★ 小写 patrick ＋ 对的 key ⇒ 登录成功，主体名是表里的原样写法 Patrick',
    JSON.stringify(s1 && s1.principal));
  const s2 = a.login('PATRICK', 'kp');
  ok(s2 && s2.principal.username === 'Patrick', '全大写 PATRICK 也行');
  ok(a.login('patrick', 'kv') === null, '大小写放宽不等于 key 放宽：patrick ＋ Viewer 的 key ⇒ null');

  const dupUsers = [P, { username: 'patrick', key_sha256: auth.sha256('kp2'), can_manage_workers: false }];
  ok(JSON.stringify(auth.caseCollisions(dupUsers)) === '[["Patrick","patrick"]]', 'caseCollisions 找出只差大小写的那组',
    JSON.stringify(auth.caseCollisions(dupUsers)));
  ok(auth.caseCollisions([P, V]).length === 0, '没有冲突 ⇒ 空');
  const b = auth.createAuth({ adminToken: auth.newAdminToken(), getUsers: () => dupUsers, log: (m) => logs.push(m) });
  ok(b.login('patrick', 'kp2') === null && b.login('Patrick', 'kp') === null,
    '★ 表里有 Patrick 和 patrick ⇒ 两个写法、各自对的 key 都被拒（匹配不唯一）');
  ok(logs.some((m) => /匹配到 2 个用户/.test(m) && /Patrick \/ patrick/.test(m)), '★ 拒绝原因写进 bus 日志（说出是哪两个名字）',
    JSON.stringify(logs));
  const users = auth.loadUsers((() => { const f = path.join(tmp, 'dupcase.json'); fs.writeFileSync(f, JSON.stringify(dupUsers)); return f; })());
  ok(users.length === 2, 'loadUsers 不因只差大小写而拒（拒启动会把别的用户一起关在外面；警告在 serve.js 启动时打）');
}

console.log('\n【2】bus-user add：只差大小写的名字被拒');
{
  const f = path.join(tmp, 'cli-add', 'users.json');
  const run = (...a) => spawnSync('node', [path.join(ROOT, 'bin', 'bus-user.js'), ...a],
    { encoding: 'utf8', env: { ...process.env, ENGLOOP_USERS_FILE: f } });
  ok(run('add', 'Patrick', '--manage').status === 0, '（前置）add Patrick');
  const before = fs.readFileSync(f, 'utf8');
  const r = run('add', 'patrick');
  ok(r.status === 1 && /已经有「Patrick」/.test(r.stderr), '★ 已有 Patrick，再 add patrick ⇒ 退 1，说出原名',
    `status=${r.status} ${r.stderr}`);
  ok(/bus-user\.js add Patrick/.test(r.stderr) && /bus-user\.js login Patrick/.test(r.stderr), '提示里给了换 key 和一次性链接两条命令');
  ok(fs.readFileSync(f, 'utf8') === before, '★ 用户表一个字节都没动（没有悄悄生成第二个用户）');
  const r2 = run('add', 'Patrick');
  ok(r2.status === 0 && /换了 key/.test(r2.stdout) && auth.loadUsers(f).length === 1, '同名同写法再 add ⇒ 仍是换 key（现有行为不变）',
    r2.stdout + r2.stderr);
}

console.log('\n【3】session 落盘（R2）');
{
  const file = path.join(tmp, 'sess', 'web-sessions.json');
  let users = [P, V];
  let now = 1_000_000;
  const logs = [];
  const mk = () => auth.createAuth({ adminToken: auth.newAdminToken(), getUsers: () => users, ttlMs: 10_000,
    now: () => now, sessionsFile: file, log: (m) => logs.push(m) });

  const a = mk();
  ok(a.loadReport && /不存在/.test(a.loadReport.warn || '') && a.sessions.size === 0, '文件不存在 ⇒ 不抛、当空表、说一行',
    JSON.stringify(a.loadReport));
  const s = a.login('Patrick', 'kp');
  ok(fs.existsSync(file) && mode(file) === 0o600, '登录 ⇒ 写出 session 文件，权限 0600', fs.existsSync(file) ? mode(file).toString(8) : '不存在');
  const raw = fs.readFileSync(file, 'utf8');
  const obj = JSON.parse(raw);
  const rec = obj[auth.sha256(s.sid)];
  ok(rec && rec.username === 'Patrick' && rec.can_manage_workers === true && rec.exp === now + 10_000,
    '文件里的 key 是 sid 的 sha256，值是 {username, can_manage_workers, exp}', raw);
  ok(rec && rec.key_fp === auth.keyFingerprint(P.key_sha256) && rec.key_fp.length === 16, '记录里带 key 指纹（key_sha256 前 16 位）');
  ok(!raw.includes(s.sid), '★ 文件里没有 sid 原文（被读走也换不出 cookie）');
  ok(!fs.readdirSync(path.dirname(file)).some((n) => n.endsWith('.tmp')), '没有残留的 .tmp（先写临时文件再 rename）');

  const b = mk();   // 「bus 重启」
  const pb = b.principalOf(cookieOf(s.sid));
  ok(pb && pb.username === 'Patrick' && pb.via === 'session' && b.loadReport.loaded === 1,
    '★ 新实例（= bus 重启）加载文件 ⇒ 同一个 cookie 还认得', JSON.stringify({ pb, r: b.loadReport }));

  const s2 = b.login('Viewer', 'kv');
  b.logout(s2.sid);
  ok(!(auth.sha256(s2.sid) in JSON.parse(fs.readFileSync(file, 'utf8'))), '登出 ⇒ 文件里那条也删了');
  ok(mk().principalOf(cookieOf(s2.sid)) === null, '登出后重启 ⇒ 那个 cookie 不认');

  // 过期：加载时扔掉，并写回文件
  now += 20_000;
  const c = mk();
  ok(c.loadReport.expired === 1 && c.loadReport.loaded === 0 && c.principalOf(cookieOf(s.sid)) === null,
    '过期的条目加载时扔掉', JSON.stringify(c.loadReport));
  ok(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length === 0, '扔掉之后当场写回（作废的摘要不在文件里多躺）');

  // 用户被删 / key 换过 ⇒ 加载时作废
  const sp = mk().login('Patrick', 'kp');
  const sv = mk().login('Viewer', 'kv');
  users = [{ ...P, key_sha256: auth.sha256('kp-new') }];          // Patrick 换 key，Viewer 被删
  const d = mk();
  ok(d.loadReport.revoked === 2 && d.loadReport.loaded === 0, '★ 加载时按用户表复核：换了 key 的、删了的用户 ⇒ 两条都作废',
    JSON.stringify(d.loadReport));
  ok(d.principalOf(cookieOf(sp.sid)) === null && d.principalOf(cookieOf(sv.sid)) === null, '作废之后两个 cookie 都 null');

  // 鉴权时也核：同一个实例里换 key ⇒ 下一个请求就掉
  users = [P, V];
  const e = mk();
  const se = e.login('Patrick', 'kp');
  ok(e.principalOf(cookieOf(se.sid)) !== null, '（前置）登录着');
  users = [{ ...P, key_sha256: auth.sha256('kp-again') }, V];
  ok(e.principalOf(cookieOf(se.sid)) === null, '★ 鉴权时也核：不重启、换了 key ⇒ 下一个请求就 null');
  users = [P, V];
  ok(e.principalOf(cookieOf(se.sid)) === null, '换回去也不复活（作废时已经删掉）');
  const se2 = e.login('Patrick', 'kp');
  users = () => { throw new Error('用户表坏了'); };
  const broken = auth.createAuth({ adminToken: auth.newAdminToken(), getUsers: () => users(), now: () => now,
    sessionsFile: path.join(tmp, 'sess', 'other.json'), log: (m) => logs.push(m) });
  ok(broken.principalOf(cookieOf(se2.sid)) === null, '用户表读不了 ⇒ session 一律拒（fail-closed），不抛');
  users = [P, V];

  // 主体名改了大小写 = 换了名字 ⇒ 旧 session 作废（按原样写法核）
  const sc = mk().login('Patrick', 'kp');
  users = [{ ...P, username: 'patrick' }, V];
  ok(mk().principalOf(cookieOf(sc.sid)) === null, '表里 Patrick 改成 patrick ⇒ 旧 session 作废（主体名要跟着变）');
  users = [P, V];
}

console.log('\n【3b】session 文件坏了 / 写不了 ⇒ 不崩');
{
  const logs = [];
  const bad = path.join(tmp, 'bad', 'web-sessions.json');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, '{not json');
  let a;
  try {
    a = auth.createAuth({ adminToken: auth.newAdminToken(), getUsers: () => [P], sessionsFile: bad, log: (m) => logs.push(m) });
  } catch (e) { a = null; logs.push(`抛了：${e.message}`); }
  ok(a && a.sessions.size === 0 && /不是合法/.test(a.loadReport.warn || ''), '★ 坏 JSON ⇒ 不抛、当空表、警告', JSON.stringify(a && a.loadReport));
  const s = a && a.login('Patrick', 'kp');
  ok(s && JSON.parse(fs.readFileSync(bad, 'utf8'))[auth.sha256(s.sid)], '下一次登录把坏文件覆盖成合法的');

  fs.writeFileSync(bad, JSON.stringify({ zz: 1, [auth.sha256('x')]: { username: 'Patrick' } }));
  const b = auth.createAuth({ adminToken: auth.newAdminToken(), getUsers: () => [P], sessionsFile: bad, log: (m) => logs.push(m) });
  ok(b.loadReport.revoked === 2 && b.sessions.size === 0, '形状不对的条目当作不存在（不拖垮其余的）', JSON.stringify(b.loadReport));

  const dirAsFile = path.join(tmp, 'bad', 'isadir');
  fs.mkdirSync(dirAsFile);
  const c = auth.createAuth({ adminToken: auth.newAdminToken(), getUsers: () => [P], sessionsFile: dirAsFile, log: (m) => logs.push(m) });
  const sc = c.login('Patrick', 'kp');
  ok(/读不了/.test(c.loadReport.warn || '') && sc && c.principalOf(cookieOf(sc.sid)),
    '文件读不了、也写不了（路径是个目录）⇒ 登录照样成（只在内存里）', JSON.stringify(c.loadReport));
  ok(logs.some((m) => /session 没落盘/.test(m)), '写不了 ⇒ bus 日志里说「没落盘、重启后要重登」');
}

console.log('\n【4】一次性登录 token（R3）');
{
  const tf = path.join(tmp, 'tok', 'login-tokens.json');
  let users = [P, V];
  let now = 5_000_000;
  const logs = [];
  const mk = () => auth.createAuth({ adminToken: auth.newAdminToken(), getUsers: () => users, now: () => now,
    loginTokensFile: tf, log: (m) => logs.push(m) });

  const { token, exp } = auth.createLoginToken({ file: tf, username: 'Patrick', now });
  const raw = fs.readFileSync(tf, 'utf8');
  ok(exp === now + 10 * 60 * 1000, '过期时间 10 分钟');
  ok(mode(tf) === 0o600 && JSON.parse(raw)[auth.sha256(token)] && !raw.includes(token),
    'token 文件 0600，只存 sha256（文件里没有 token 原文）', raw);

  const a = mk();
  const r1 = a.redeemLoginToken(token);
  ok(r1.ok && r1.principal.username === 'Patrick' && r1.principal.via === 'session' && a.principalOf(cookieOf(r1.sid)),
    '★ token 换 session：principal 是 Patrick，cookie 能用', JSON.stringify(r1));
  ok(!(auth.sha256(token) in auth.readLoginTokens(tf)), '★ 用过即删：文件里没有它了');
  const r2 = a.redeemLoginToken(token);
  ok(!r2.ok && r2.reason === 'used', '★ 同一个 token 再用 ⇒ used', JSON.stringify(r2));
  const r3 = mk().redeemLoginToken(token);
  ok(!r3.ok && r3.reason === 'invalid', '换一个实例（= bus 重启后）再用 ⇒ invalid（文件里已经删了）', JSON.stringify(r3));

  // 复活：CLI 和 bus 同时读改写，把用过的 token 写回了文件
  const t2 = auth.createLoginToken({ file: tf, username: 'Patrick', now }).token;
  const snapshot = fs.readFileSync(tf, 'utf8');
  const b = mk();
  ok(b.redeemLoginToken(t2).ok, '（前置）t2 用掉');
  fs.writeFileSync(tf, snapshot);
  const r4 = b.redeemLoginToken(t2);
  ok(!r4.ok && r4.reason === 'used', '★ token 文件被写回旧版本（用过的又出现）⇒ 同一个 bus 上仍是 used', JSON.stringify(r4));

  // 过期
  const t3 = auth.createLoginToken({ file: tf, username: 'Patrick', now }).token;
  now += 10 * 60 * 1000 + 1;
  const r5 = mk().redeemLoginToken(t3);
  ok(!r5.ok && r5.reason === 'expired', '★ 过了 10 分钟 ⇒ expired', JSON.stringify(r5));

  // 用户名不分大小写 · 用户被删 · 乱写的 token
  const t4 = auth.createLoginToken({ file: tf, username: 'patrick', now }).token;
  const r6 = mk().redeemLoginToken(t4);
  ok(r6.ok && r6.principal.username === 'Patrick', 'token 里记的是 patrick ⇒ 匹配到 Patrick，主体名用原样写法', JSON.stringify(r6));
  const t5 = auth.createLoginToken({ file: tf, username: 'Viewer', now }).token;
  users = [P];
  const r7 = mk().redeemLoginToken(t5);
  ok(!r7.ok && r7.reason === 'no_user', '用户被删 ⇒ no_user', JSON.stringify(r7));
  users = [P, V];
  ok(mk().redeemLoginToken('nope').reason === 'invalid' && mk().redeemLoginToken(undefined).reason === 'invalid'
    && mk().redeemLoginToken('A'.repeat(43)).reason === 'invalid', '乱写的 / 没给 / 不存在的 token ⇒ invalid');

  // 删不掉 ⇒ 拒
  const t6 = auth.createLoginToken({ file: tf, username: 'Patrick', now }).token;
  fs.chmodSync(path.dirname(tf), 0o500);
  let r8;
  try { r8 = mk().redeemLoginToken(t6); } finally { fs.chmodSync(path.dirname(tf), 0o700); }
  ok(!r8.ok && r8.reason === 'store' && logs.some((m) => /删不掉它就不是一次性的/.test(m)),
    '★ token 文件写不回去（删不掉）⇒ 拒，并在日志里说原因', JSON.stringify(r8));
}

console.log('\n【4b】bin/bus-user.js login');
{
  const uf = path.join(tmp, 'cli-login', 'users.json');
  const tf = path.join(tmp, 'cli-login', 'login-tokens.json');
  const env = { ...process.env, ENGLOOP_USERS_FILE: uf, ENGLOOP_LOGIN_TOKENS_FILE: tf, ENGLOOP_PORT: '19961' };
  const run = (...a) => spawnSync('node', [path.join(ROOT, 'bin', 'bus-user.js'), ...a], { encoding: 'utf8', env });
  ok(run('add', 'Patrick', '--manage').status === 0, '（前置）add Patrick');
  const usersBefore = fs.readFileSync(uf, 'utf8');
  const r = run('login', 'patrick');
  const url = (r.stdout.match(/(http\S+#login-token=\S+)/) || [])[1] || '';
  const token = (url.match(/#login-token=([A-Za-z0-9_-]+)$/) || [])[1];
  ok(r.status === 0 && url.startsWith('http://127.0.0.1:19961/#login-token='),
    '★ login patrick ⇒ 打印一条链接，host 默认是 bus 的地址（端口跟 ENGLOOP_PORT 走）', r.stdout + r.stderr);
  ok(token && auth.readLoginTokens(tf)[auth.sha256(token)].username === 'Patrick', 'token 的摘要进了 token 文件，用户名是原样写法 Patrick');
  ok(fs.readFileSync(uf, 'utf8') === usersBefore, '★ 用户表一个字节都没动（不换 key）');
  ok(/key 没换/.test(r.stdout), '输出里说了 key 没换');
  const a = auth.createAuth({ adminToken: auth.newAdminToken(), getUsers: () => auth.loadUsers(uf), loginTokensFile: tf });
  ok(a.redeemLoginToken(token).ok && a.redeemLoginToken(token).reason === 'used', 'CLI 生成的 token 能用一次、第二次 used（bus 不在跑也能生成）');
  const hostOf = (...h) => (run('login', 'Patrick', '--host', ...h).stdout.match(/(http\S+)#login-token=/) || [])[1];
  ok(hostOf('phone-gw.example') === 'http://phone-gw.example:19961/', '--host 只给 host ⇒ 沿用 bus 的端口', hostOf('phone-gw.example'));
  ok(hostOf('phone-gw.example:8443') === 'http://phone-gw.example:8443/', '--host host:port ⇒ 原样');
  ok(hostOf('https://phone-gw.example/') === 'https://phone-gw.example/', '--host 完整 URL ⇒ 原样（去掉末尾的 /）');
  const nobody = run('login', 'nobody');
  ok(nobody.status === 1 && /没有「nobody」/.test(nobody.stderr) && /Patrick/.test(nobody.stderr), '不存在的用户 ⇒ 退 1，列出已有的');
  ok(run('login').status === 2 && run('login', 'Patrick', '--host').status === 2 && run('login', 'Patrick', '--bogus').status === 2,
    '少参数 / --host 没给值 / 不认识的参数 ⇒ 退 2');
  fs.writeFileSync(uf, JSON.stringify([...auth.loadUsers(uf), { username: 'patrick', key_sha256: auth.sha256('x'), can_manage_workers: false }]));
  const amb = run('login', 'PATRICK');
  ok(amb.status === 1 && /匹配到 2 个用户/.test(amb.stderr), '表里只差大小写的两条 ⇒ login 退 1，不发一条注定被拒的链接');
}

console.log('\n【5】session 文件、token 文件：agent 读不到、也写不到');
{
  const root = '/fake/engloop';
  const files = [path.join(root, 'temp', 'web-sessions.json'), path.join(root, 'temp', 'login-tokens.json')];
  ok(files.every((f) => secretPaths(root).includes(f)), 'secretPaths 里有这两个文件', JSON.stringify(secretPaths(root)));
  const under = (f, dir) => f === dir || f.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
  const editDirs = (s) => s.permissions.allow.map((r) => /^Edit\(\/(\/.*?)(?:\/\*\*)?\)$/.exec(r)).filter(Boolean).map((m) => m[1]);
  for (const [label, s] of [
    ['crew dev', buildCrewSettings({ name: 'dev', type: 'dev', cwd: '/fake/work/dev', root })],
    ['crew 在仓库里（agents/dev）', buildCrewSettings({ name: 'dev', type: 'dev', cwd: path.join(root, 'agents', 'dev'), root })],
    ['worker', buildAgentSettings({ kind: 'worker', name: 'w1', type: 'solve', cwd: '/fake/work/w1', root })],
  ]) {
    const dr = s.sandbox.filesystem.denyRead || [];
    ok(files.every((f) => dr.includes(f)), `★ ${label}：sandbox.filesystem.denyRead 有两者（拦 Bash 的 cat）`, JSON.stringify(dr));
    ok(files.every((f) => s.permissions.deny.includes(`Read(/${f})`)), `${label}：permissions.deny 有两条 Read(//…)（拦 Read 工具）`);
    const aw = s.sandbox.filesystem.allowWrite || [];
    // 两张表都不能是空的 —— 空表上「不覆盖」恒真，下面两条就没有分辨力
    ok(aw.length > 0 && editDirs(s).length > 0, `${label}：（前置）写集和 Edit 放行都读出了条目`, `${aw.length} / ${editDirs(s).length}`);
    ok(!files.some((f) => aw.some((w) => under(f, w))), `★ ${label}：sandbox 写集里没有它们、也没有它们的上级目录（写得到 = 能伪造登录）`,
      JSON.stringify(aw));
    ok(!files.some((f) => editDirs(s).some((d) => under(f, d))), `★ ${label}：Edit 放行的目录不覆盖它们`, JSON.stringify(editDirs(s)));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
