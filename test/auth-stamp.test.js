'use strict';

/**
 * lib/auth.js ＋ lib/stamp.js ＋ bin/bus-user.js 的单元层。
 *
 * 真 bus 上的那一圈（路由顺序、401/403、upgrade、扇出带章、poller 输出）在 `test/bus-auth.test.js`；
 * 这里守的是**判据本身**：用户表的每一种坏法都拒、章的每一种缺法都落到 data、
 * 只有 human 的章能带管理权。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const auth = require('../lib/auth');
const stamp = require('../lib/stamp');
const { buildCrewSettings } = require('../lib/agent-settings');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-authunit-'));
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

console.log('\n【1】用户表：每一种坏法都拒，并说出修法');
{
  const w = (name, v) => { const f = path.join(tmp, name); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); return f; };
  const good = { username: 'Patrick', key_sha256: auth.sha256('k'), can_manage_workers: true };
  ok(throwsWith(() => auth.loadUsers(path.join(tmp, 'nope.json')), /bus-user\.js add/), '缺失 ⇒ 抛，信息里有 bus-user.js add');
  ok(throwsWith(() => auth.loadUsers(w('empty.json', [])), /空的[\s\S]*bus-user\.js add/), '空数组 ⇒ 抛');
  ok(throwsWith(() => auth.loadUsers(w('bad.json', '{nope')), /不是合法 JSON/), '坏 JSON ⇒ 抛');
  ok(throwsWith(() => auth.loadUsers(w('plain.json', [{ ...good, key: 'x' }])), /明文/), '明文 key ⇒ 抛（只存 sha256）');
  ok(throwsWith(() => auth.loadUsers(w('nomanage.json', [{ username: 'P', key_sha256: good.key_sha256 }])),
    /can_manage_workers 必须写明/), '★ 没写 can_manage_workers ⇒ 抛（不默认成 false）');
  ok(throwsWith(() => auth.loadUsers(w('strmanage.json', [{ ...good, can_manage_workers: 'true' }])),
    /can_manage_workers 必须写明/), '★ can_manage_workers 是字符串 "true" ⇒ 抛');
  ok(throwsWith(() => auth.loadUsers(w('dup.json', [good, good])), /重复/), '重名 ⇒ 抛');
  ok(throwsWith(() => auth.loadUsers(w('admin.json', [{ ...good, username: 'local-admin' }])), /保留/),
    'local-admin 是保留名 ⇒ 抛');
  ok(throwsWith(() => auth.loadUsers(w('hash.json', [{ ...good, key_sha256: 'abc' }])), /64 位/), '摘要格式不对 ⇒ 抛');
  const u = auth.loadUsers(w('good.json', [good]));
  ok(u.length === 1 && u[0].username === 'Patrick' && u[0].can_manage_workers === true, '合法的读得出来');
}

console.log('\n【2】createAuth：登录、Bearer、cookie、过期');
{
  let now = 1_000_000;
  const users = [
    { username: 'Patrick', key_sha256: auth.sha256('kp'), can_manage_workers: true },
    { username: 'Viewer', key_sha256: auth.sha256('kv'), can_manage_workers: false },
  ];
  const token = auth.newAdminToken();
  const a = auth.createAuth({ adminToken: token, getUsers: () => users, ttlMs: 1000, now: () => now });
  ok(a.login('Patrick', 'wrong') === null && a.login('Nobody', 'kp') === null && a.login('Patrick', '') === null,
    '错 key / 不存在的用户 / 空 key ⇒ null');
  const s = a.login('Patrick', 'kp');
  ok(s && s.principal.username === 'Patrick' && s.principal.can_manage_workers === true, '对的 key ⇒ session');
  ok(![...a.sessions.keys()].includes(s.sid), 'session 表里存的是 sid 的摘要，不是 sid 本身');
  const p = a.principalOf({ cookie: `x=1; ${auth.COOKIE}=${s.sid}` });
  ok(p && p.username === 'Patrick' && p.via === 'session', 'cookie ⇒ 主体');
  const b = a.principalOf({ authorization: `Bearer ${token}` });
  ok(b && b.username === 'local-admin' && b.can_manage_workers === true, 'admin token ⇒ local-admin / can_manage_workers');
  ok(a.principalOf({ authorization: 'Bearer nope', cookie: `${auth.COOKIE}=${s.sid}` }) === null,
    '★ 带了错的 Bearer ⇒ null（不回落到 cookie —— 否则 token 失效会被 cookie 掩盖）');
  ok(a.principalOf({}) === null && a.principalOf({ cookie: `${auth.COOKIE}=forged` }) === null, '没凭据 / 编的 sid ⇒ null');
  now += 1001;
  ok(a.principalOf({ cookie: `${auth.COOKIE}=${s.sid}` }) === null, '过期 ⇒ null');

  // 中间件：401 vs 403
  const res = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  let nexted = false;
  const r1 = res(); a.requireAuth({ headers: {} }, r1, () => { nexted = true; });
  ok(r1.code === 401 && !nexted, 'requireAuth 无凭据 ⇒ 401');
  const sv = a.login('Viewer', 'kv');
  const r2 = res(); nexted = false;
  a.requireManage({ headers: { cookie: `${auth.COOKIE}=${sv.sid}` } }, r2, () => { nexted = true; });
  ok(r2.code === 403 && !nexted && r2.body.error === 'FORBIDDEN', '★ requireManage：Viewer ⇒ 403（不是 401）');
  const r3 = res(); nexted = false;
  a.requireManage({ headers: { authorization: `Bearer ${token}` } }, r3, () => { nexted = true; });
  ok(nexted && r3.code === 0, 'requireManage：admin token ⇒ 放行');
}

console.log('\n【3】admin token 文件');
{
  const f = path.join(tmp, 'sub', 'bus-admin.token');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'old', { mode: 0o644 });
  const t = auth.writeAdminToken(f);
  ok((fs.statSync(f).mode & 0o777) === 0o600, '★ 覆盖一个 0644 的旧文件后是 0600（rename，不是原地写）');
  ok(auth.readAdminToken(f) === t, '读回来的就是写进去的');
  ok(auth.writeAdminToken(f) !== t, '每次写都换新');
  let code = null;
  try { auth.readAdminToken(path.join(tmp, 'none.token')); } catch (e) { code = e.code; }
  ok(code === 'NO_ADMIN_TOKEN', '读不到 ⇒ 抛 NO_ADMIN_TOKEN（不返回空串让调用方不带凭据去请求）');
}

console.log('\n【4】readStamp：只从条目里取，不推断、不默认');
{
  const r = (e) => JSON.stringify(stamp.readStamp(e));
  const H1 = stamp.readStamp({ ...stamp.HUMAN({ username: 'Patrick', can_manage_workers: true }) });
  ok(H1.sender_type === 'human' && H1.can_manage_workers === true && H1.trust === 'principal', 'human ＋ "1" ⇒ principal / true', r(H1));
  const H0 = stamp.readStamp(stamp.HUMAN({ username: 'V', can_manage_workers: false }));
  ok(H0.trust === 'principal' && H0.can_manage_workers === false, 'human ＋ "0" ⇒ principal / false');
  ok(stamp.readStamp(stamp.AGENT).trust === 'agent', 'agent ⇒ agent');
  ok(stamp.readStamp(stamp.SYSTEM).trust === 'system', 'system ⇒ system');
  const none = stamp.readStamp({ from: 'Patrick', text: 'x' });
  ok(none.sender_type === 'unknown' && none.trust === 'data' && none.can_manage_workers === false,
    '★ 没有章（from 写着 Patrick）⇒ unknown / data / false', r(none));
  ok(stamp.readStamp({ sender_type: 'Human', can_manage_workers: '1' }).trust === 'data', '大小写不对 ⇒ data');
  ok(stamp.readStamp({ sender_type: 'agent', can_manage_workers: '1' }).can_manage_workers === false,
    '★ agent 章 ＋ "1" ⇒ false（只有 human 的章能带管理权）');
  ok(stamp.readStamp({ can_manage_workers: '1' }).can_manage_workers === false, '只有 "1" 没有 sender_type ⇒ false');
  ok(stamp.readStamp({ sender_type: 'human' }).can_manage_workers === false, 'human 没写 can_manage_workers ⇒ false');
  ok(stamp.readStamp(undefined).trust === 'data', 'undefined 不抛');
  ok(throwsWith(() => stamp.HUMAN({}), /没有主体/), 'HUMAN() 没有主体 ⇒ 抛（路由前面漏了中间件）');
  ok(stamp.HUMAN({ username: 'x', can_manage_workers: 'false' }).can_manage_workers === '0',
    "can_manage_workers: 'false'（truthy 字符串）⇒ \"0\"");
  const pk = stamp.pick({ from: 'a', text: 'b', sender_type: 'human', can_manage_workers: '1', room_hash: 'r' });
  ok(JSON.stringify(pk) === '{"sender_type":"human","can_manage_workers":"1"}', 'pick 只挑章的两个字段', JSON.stringify(pk));
}

console.log('\n【5】bin/bus-user.js');
{
  const f = path.join(tmp, 'cli', 'users.json');
  const run = (...a) => spawnSync('node', [path.join(ROOT, 'bin', 'bus-user.js'), ...a],
    { encoding: 'utf8', env: { ...process.env, ENGLOOP_USERS_FILE: f } });
  const r1 = run('add', 'Patrick', '--manage');
  const key = (r1.stdout.match(/key（只打印这一次[^）]*）：(\S+)/) || [])[1];
  ok(r1.status === 0 && key, 'add Patrick --manage ⇒ 打印一次 key', r1.stdout + r1.stderr);
  const users = auth.loadUsers(f);
  ok(users.length === 1 && users[0].can_manage_workers === true && users[0].key_sha256 === auth.sha256(key),
    '用户表里是 key 的 sha256，can_manage_workers:true');
  ok(!fs.readFileSync(f, 'utf8').includes(key), '★ 用户表里没有明文 key');
  ok((fs.statSync(f).mode & 0o777) === 0o600, '用户表 0600');
  const r2 = run('add', 'Viewer');
  ok(r2.status === 0 && /can_manage_workers=false/.test(r2.stdout), '不带 --manage ⇒ 说出 can_manage_workers=false');
  const r3 = run('add', 'Patrick');
  ok(r3.status === 0 && /换了 key/.test(r3.stdout) && auth.loadUsers(f).length === 2, '同名再 add ⇒ 换 key，不重复');
  ok(run('add', 'local-admin').status === 2 && run('add', 'bad name').status === 2, '保留名 / 非法名 ⇒ 退 2');
  ok(run('nope').status === 2, '不认识的子命令 ⇒ 退 2 ＋ 用法');
}

console.log('\n【6】agent 读不到 bus 的钥匙（agent-settings）');
{
  const s = buildCrewSettings({ name: 'dev', type: 'dev', cwd: '/fake/work/dev', root: '/fake/engloop' });
  const dr = s.sandbox.filesystem.denyRead || [];
  ok(dr.includes('/fake/engloop/temp/bus-admin.token') && dr.includes('/fake/engloop/config/users.json'),
    '★ sandbox.filesystem.denyRead 有 admin token 和用户表（拦 Bash 的 cat）', JSON.stringify(dr));
  ok(s.permissions.deny.includes('Read(//fake/engloop/temp/bus-admin.token)')
    && s.permissions.deny.includes('Read(//fake/engloop/config/users.json)'),
  '★ permissions.deny 有两条 Read(//…)（拦 Read 工具）');
  ok(!s.sandbox.filesystem.allowWrite.some((w) => w.endsWith('bus-admin.token') || w.endsWith('users.json')),
    '写集里也没有它们');
}

console.log('\n【7】接线：auth.js 在 app.js 之前加载；serve.js 的闸门在路由之前');
{
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const ia = html.indexOf('<script src="/auth.js">');
  const ib = html.indexOf('<script src="/app.js">');
  // ⚠️ 两个都要 >= 0：缺一个时 indexOf = -1，「-1 < 任何位置」恒真
  ok(ia >= 0 && ib >= 0 && ia < ib, '★ index.html 里 auth.js 在 app.js 之前（它要先包住 fetch）');
  // 只看代码行，注释里同一个串不算（断言命中注释里的同一个串 ⇒ 假绿）
  const code = fs.readFileSync(path.join(ROOT, 'bin', 'serve.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const gate = code.indexOf("app.use('/api', busAuth.requireAuth)");
  const login = code.indexOf("app.post('/api/login'");
  const firstApi = code.search(/app\.(get|post|delete)\('\/api\/(?!login)/);
  ok(gate >= 0 && login >= 0 && login < gate && firstApi > gate,
    '★ /api/login 在闸门之前，其余 /api/* 路由全在闸门之后', `login=${login} gate=${gate} firstApi=${firstApi}`);
  ok(!/from\s*=\s*'Patrick'/.test(code), '★ serve.js 的代码里没有 `from = \'Patrick\'` 这个客户端默认值了');
  const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/body:\s*JSON\.stringify\(\{\s*from:/.test(app), 'web/app.js 发消息不再自报 from');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
