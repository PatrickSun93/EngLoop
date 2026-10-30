'use strict';

/**
 * bus 的身份与鉴权。
 *
 * ── 为什么「bus 绑 127.0.0.1」不够 ──────────────────────────────────────
 *   agent 的 sandbox 开了 `allowLocalBinding`（Redis 要它）⇒ **agent 的 Bash 能打 bus**。
 *   所以发件人不能由客户端自己填，生命周期端点（起 / 停 / 强杀 agent）也不能谁都能调。
 *
 * ── 两种凭据，一个主体形状 ───────────────────────────────────────────────
 *   ① 浏览器：`POST /api/login {username, key}` ⇒ HttpOnly + SameSite=Strict 的 session cookie
 *   ② 本机 CLI：bus 每次启动写 `temp/bus-admin.token`（0600，每次换新），
 *      `Authorization: Bearer <token>`，主体 `local-admin`、`can_manage_workers: true`
 *   ⇒ 都落成 `{ username, can_manage_workers, via }`，下游只看这个。
 *
 * ── 用户表：`config/users.json`（gitignored），只存 key 的 sha256 ─────────
 *   不存明文 `key`，存 `key_sha256`，理由：
 *   agent 的 `Read` 是全放行的（`lib/agent-settings.js`），用户表一旦被读到，
 *   明文 key 就等于那个用户的登录 ⇒ 登录后发的话盖 `principal` 章。
 *   agent-settings 里同时 deny 了这个文件 —— 两层，任何一层失效另一层还在。
 *   key 是 32 字节随机数 ⇒ 不需要慢哈希（没有可猜的空间）。
 *
 * ── session：内存为主，落盘到 `temp/web-sessions.json`，**不存 Redis** ────────
 *   Redis 对每个 agent 都是**可写**的（sandbox 放行 localhost，poller 要它）。
 *   session 存在 Redis 里 ⇒ agent 写一条 `session:<它自己编的 id> → <某个用户>`，
 *   再带上那个 cookie 就是那个用户。存 id 的哈希也挡不住（它可以写自己 id 的哈希）。
 *   ⇒ 判据是「**agent 写不写得到**」，不是「内存还是磁盘」。
 *   `temp/web-sessions.json` 写不到：agent sandbox 的写集是 temp/ 下**按文件**列的白名单
 *   （`lib/agent-settings.js` 的 allowWrite），Edit 只放自己的 cwd ⇒ 两层都没有它；
 *   它又进了 `secretPaths` ⇒ 也读不到（读到的只是 sid 的摘要，本来也换不出 cookie，拦它是两层里的另一层）。
 *   🔴 **这个文件一旦进了任何 agent 的写集，它就等于 Redis 那一格** —— `test/auth-session.test.js` 守着这条。
 *   取舍：以前 bus 每重启一次所有浏览器都要重登（手机上要重新输 key，而 key 只打印一次）；
 *     落盘之后重启不掉登录。代价是多一个要保护的文件，以及每个请求现读一次用户表（见 principalOf）。
 *
 * ── 一次性登录链接（`node bin/bus-user.js login <name>`）────────────────────
 *   token 存 `temp/login-tokens.json`（只存 sha256，10 分钟过期，用过即删）。
 *   丢了 key 时进来的路，**不换 key** —— 换 key 会把这个用户别的设备一起踢掉。
 *   写不到它的理由同上：agent 往里写一条自己 token 的摘要 = 以任何用户登录。
 *
 * ⚠️ 没有静默默认值：用户表缺失 / 为空 / 有一条不合法 ⇒ **bus 拒绝启动**，
 *   错误信息里写着要跑的那条命令。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

const USERS_FILE = process.env.ENGLOOP_USERS_FILE || path.join(ROOT, 'config', 'users.json');
const ADMIN_TOKEN_FILE = process.env.ENGLOOP_ADMIN_TOKEN_FILE || path.join(ROOT, 'temp', 'bus-admin.token');
// ★ 放 temp/ 而不是 config/：跟 bus-admin.token 同一类（bus 运行时写的状态、gitignored），
//   而 temp/ 在 agent sandbox 里是**按文件**放行写的 —— 不在白名单上的文件谁都写不到。
//   config/ 是人手改的配置，放进去会让「这个文件能不能手改」变得含糊。
const WEB_SESSIONS_FILE = process.env.ENGLOOP_WEB_SESSIONS_FILE || path.join(ROOT, 'temp', 'web-sessions.json');
const LOGIN_TOKENS_FILE = process.env.ENGLOOP_LOGIN_TOKENS_FILE || path.join(ROOT, 'temp', 'login-tokens.json');

const COOKIE = 'engloop_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000;
const ADMIN_NAME = 'local-admin';
/** 用户名的字符集 —— 它会进流的 `from` 字段、进网页、进 outbox 路由。 */
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const ADD_HINT = 'node bin/bus-user.js add <username> --manage';
const LOGIN_HINT = 'node bin/bus-user.js login <username>';

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** 定长比较两个 hex 摘要（长度不同直接 false，不抛）。 */
function digestEqual(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function authError(msg) {
  const e = new Error(msg);
  e.code = 'AUTH_CONFIG';
  return e;
}

/**
 * 读用户表。任何不合法都**抛**，信息里说怎么修。
 * @returns {Array<{username:string, key_sha256:string, can_manage_workers:boolean}>}
 */
function loadUsers(file = USERS_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') {
      throw authError(`用户表不存在：${file}\n`
        + `  bus 不再接受「客户端自己说自己是谁」—— 先建一个用户：\n    ${ADD_HINT}\n`
        + '  （它会生成随机 key、写进用户表、把 key 打印一次。浏览器用它登录。）');
    }
    throw authError(`用户表读不了：${file}（${e.code || e.message}）—— 看一眼文件权限。`);
  }
  let users;
  try { users = JSON.parse(raw); } catch (e) {
    throw authError(`用户表不是合法 JSON：${file}（${e.message}）\n`
      + `  手改坏了的话，删掉它重新跑：${ADD_HINT}`);
  }
  if (!Array.isArray(users) || users.length === 0) {
    throw authError(`用户表是空的：${file}\n  一个用户都没有 ⇒ 谁都登录不了。先跑：\n    ${ADD_HINT}`);
  }
  const seen = new Set();
  users.forEach((u, i) => {
    const where = `${file} 第 ${i + 1} 条`;
    if (!u || typeof u !== 'object') throw authError(`${where} 不是对象`);
    if (typeof u.username !== 'string' || !USERNAME_RE.test(u.username)) {
      throw authError(`${where}：username 必须匹配 ${USERNAME_RE}（实际 ${JSON.stringify(u.username)}）`);
    }
    if (u.username === ADMIN_NAME) {
      throw authError(`${where}：「${ADMIN_NAME}」是本机 admin token 的主体名，保留，不能当用户名`);
    }
    if (seen.has(u.username)) throw authError(`${where}：username「${u.username}」重复`);
    seen.add(u.username);
    if ('key' in u) {
      throw authError(`${where}：有明文 \`key\` 字段 —— 用户表只存 \`key_sha256\`。\n`
        + `  用 ${ADD_HINT} 重新生成（明文 key 被谁读到就等于他能以「${u.username}」登录）`);
    }
    if (typeof u.key_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(u.key_sha256)) {
      throw authError(`${where}：key_sha256 必须是 64 位小写 hex —— 用 ${ADD_HINT} 生成，别手填`);
    }
    // ★ 必须是**写出来的**布尔：缺了不默认成 false —— 「忘了写」和「决定不给」要分得开。
    if (typeof u.can_manage_workers !== 'boolean') {
      throw authError(`${where}：can_manage_workers 必须写明 true 或 false`
        + `（实际 ${JSON.stringify(u.can_manage_workers)}）`);
    }
  });
  return users.map((u) => ({
    username: u.username, key_sha256: u.key_sha256, can_manage_workers: u.can_manage_workers,
  }));
}

// ── 用户名不分大小写 ────────────────────────────────────────────────────
//   10-28 手机登录连败三次：库里是 `Patrick`，手机键盘把首字母打成了小写。
//   ★ **比较**不分大小写，**主体名**用表里的原样写法 —— relay 按名字投递、流的 `from`、
//     网页署名都认这个写法，登录时换成用户手打的写法就会投错地方。
//   ⚠️ loadUsers 仍然只拒「完全同名」：只差大小写的两条（手改过文件）**不拒启动**，
//     只在启动时警告（caseCollisions）、登录时拒（findUser 不唯一）——
//     拒启动会把另一个合法用户也一起关在外面，而冲突只影响那一个名字。

/** 不分大小写地找用户。`matches` 多于一个 = 用户表里有只差大小写的条目。 */
function findUser(users, username) {
  const want = String(username).toLowerCase();
  const matches = users.filter((u) => u.username.toLowerCase() === want);
  return { user: matches.length === 1 ? matches[0] : null, matches };
}

/** 只差大小写的名字组，比如 `[['Patrick','patrick']]`。给启动警告和 bus-user 用。 */
function caseCollisions(users) {
  const groups = new Map();
  for (const u of users) {
    const k = u.username.toLowerCase();
    groups.set(k, [...(groups.get(k) || []), u.username]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** session / token 里记的 key 指纹：key_sha256 的前 16 位。换 key ⇒ 指纹变 ⇒ 旧 session 作废。 */
const keyFingerprint = (keySha256) => String(keySha256).slice(0, 16);

/** 生成一个新 key（给 bin/bus-user.js 用）。 */
function newKey() { return crypto.randomBytes(32).toString('base64url'); }

/**
 * 写一个只给 bus 用的文件：0600。
 * ★ 先写临时文件再 rename —— 直接覆盖的话，`writeFileSync` 的 `mode` 只在**新建**时生效，
 *   一个被人 chmod 过的旧文件会保留旧权限；rename 也让读的一方永远看不到写了一半的文件。
 */
function writeSecretFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** 写 admin token：0600，每次启动换新。 */
function newAdminToken() { return crypto.randomBytes(32).toString('hex'); }

function writeAdminToken(file = ADMIN_TOKEN_FILE, token = newAdminToken()) {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('writeAdminToken: token 必须是 64 位 hex');
  writeSecretFile(file, `${token}\n`);
  return token;
}

// ── session 文件 ────────────────────────────────────────────────────────
//   形状：`{ "<sid 的 sha256>": { username, can_manage_workers, exp, key_fp } }`
//   ★ 只有 sid 的摘要 ⇒ 文件被读走也拿不到能用的 cookie。
//   ★ 坏了 / 不存在 ⇒ 当空表、说一行，**bus 照起** —— 最坏后果是大家重登一次，
//     而「bus 起不来」的后果是谁都进不来。

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * 读 session 文件，按**当前用户表**复核。
 * 作废的三种：过期 · 用户已删（按表里原样写法找）· key 指纹对不上（换过 key）。
 * @returns {{ sessions: Map, warn: string|null, loaded: number, expired: number, revoked: number }}
 */
function loadSessions(file, { users, now = Date.now() }) {
  const out = { sessions: new Map(), warn: null, loaded: 0, expired: 0, revoked: 0 };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    out.warn = e.code === 'ENOENT'
      ? `session 文件不存在（${file}）—— 当空表，第一次登录时建出来`
      : `⚠ session 文件读不了（${file}：${e.code || e.message}）—— 当空表，所有浏览器要重登一次`;
    return out;
  }
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { obj = null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    out.warn = `⚠ session 文件不是合法的 JSON 对象（${file}）—— 当空表，所有浏览器要重登一次；下次登录时覆盖它`;
    return out;
  }
  for (const [k, s] of Object.entries(obj)) {
    // 形状不对的条目当作不存在 —— 手改坏的一条不该拖垮其余的
    if (!HEX64.test(k) || !s || typeof s.username !== 'string' || typeof s.can_manage_workers !== 'boolean'
      || typeof s.exp !== 'number' || typeof s.key_fp !== 'string') { out.revoked += 1; continue; }
    if (s.exp <= now) { out.expired += 1; continue; }
    if (!sessionStillValid(s, users)) { out.revoked += 1; continue; }
    out.sessions.set(k, { username: s.username, can_manage_workers: s.can_manage_workers, exp: s.exp, key_fp: s.key_fp });
    out.loaded += 1;
  }
  return out;
}

/**
 * 这条 session 对**当前**用户表还成立吗：用户还在（原样写法）、key 没换过。
 * ★ 按原样写法找，不按小写 —— session 里存的是登录时的主体名；表里改了大小写 = 换了一个名字，
 *   主体名要跟着变，旧 session 带着旧名字继续发言会投错地方。
 */
function sessionStillValid(s, users) {
  const u = users.find((x) => x.username === s.username);
  return !!u && typeof s.key_fp === 'string' && s.key_fp === keyFingerprint(u.key_sha256);
}

/** 写 session 文件：先扔掉过期的，再原子写、0600。 */
function saveSessions(file, sessions, now = Date.now()) {
  const obj = {};
  for (const [k, s] of sessions) {
    if (s.exp <= now) { sessions.delete(k); continue; }
    obj[k] = s;
  }
  writeSecretFile(file, `${JSON.stringify(obj, null, 2)}\n`);
}

// ── 一次性登录 token ────────────────────────────────────────────────────
//   形状：`{ "<token 的 sha256>": { username, exp } }`
//   写的一方是 `bin/bus-user.js login`（bus 不在跑也能生成），读 / 删的一方是 bus（每次现读）。
//   ⚠️ 两个进程读改写同一个文件，有一个窗口：bus 读到 {A} → CLI 读到 {A} → bus 删 A 写 {} →
//     CLI 写 {A, B} ⇒ **A 复活**。⇒ bus 另在内存里记「用过的摘要」直到它过期（createAuth 的 consumed），
//     复活的 A 在这个 bus 上用不了；bus 恰好在那 10 分钟里重启才会漏 —— 窗口窄到可以接受，写在这里让人知道。

/** 读 token 文件。不存在 / 坏了 ⇒ 空表（token 本来就是一次性的，丢了重新生成一个）。 */
function readLoginTokens(file) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  return obj;
}

function writeLoginTokens(file, tokens, now = Date.now()) {
  const keep = {};
  for (const [k, t] of Object.entries(tokens)) {
    if (HEX64.test(k) && t && typeof t.exp === 'number' && t.exp > now) keep[k] = t;
  }
  writeSecretFile(file, `${JSON.stringify(keep, null, 2)}\n`);
}

/**
 * 生成一个一次性登录 token，摘要写进 token 文件。**不碰用户表、不换 key。**
 * @returns {{ token: string, exp: number }}
 */
function createLoginToken({ file = LOGIN_TOKENS_FILE, username, ttlMs = LOGIN_TOKEN_TTL_MS, now = Date.now() }) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw new Error('createLoginToken: username 不合法');
  const token = crypto.randomBytes(32).toString('base64url');
  const tokens = readLoginTokens(file);
  const exp = now + ttlMs;
  tokens[sha256(token)] = { username, exp };
  writeLoginTokens(file, tokens, now);
  return { token, exp };
}

/**
 * CLI 读 admin token。读不到 ⇒ **抛**，不降级成不带凭据去请求
 * （那样拿到的 401 会被读成「bus 拒绝了」，而真正的原因是「我没拿到钥匙」）。
 */
function readAdminToken(file = ADMIN_TOKEN_FILE) {
  let t;
  try { t = fs.readFileSync(file, 'utf8').trim(); } catch (e) {
    const err = new Error(`读不到 bus 的 admin token：${file}（${e.code || e.message}）\n`
      + '  这个文件由 bus 每次启动时写出 ⇒ bus 没在跑，或者跑着的是别处的 bus / 旧代码。\n'
      + '  先确认 bus 起着（node bin/bus-restart.js status），再重试。');
    err.code = 'NO_ADMIN_TOKEN';
    throw err;
  }
  if (!/^[0-9a-f]{64}$/.test(t)) {
    const err = new Error(`admin token 格式不对：${file} —— 重启 bus 会重写它`);
    err.code = 'NO_ADMIN_TOKEN';
    throw err;
  }
  return t;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * @param {object} o
 * @param {string}   o.adminToken
 * @param {function} o.getUsers   () => users（每次登录现读 —— 加用户不用重启 bus）
 * @param {number}   [o.ttlMs]
 * @param {function} [o.now]
 * @param {string}   [o.sessionsFile]     session 落盘的文件。不给 ⇒ 只存内存（单测用；bus 一定给）
 * @param {string}   [o.loginTokensFile]  一次性登录 token 的文件。不给 ⇒ 没有 token 登录
 * @param {function} [o.log]              bus 日志（拒绝原因、落盘失败）
 */
function createAuth({
  adminToken, getUsers, ttlMs = SESSION_TTL_MS, now = () => Date.now(),
  sessionsFile = null, loginTokensFile = null, log = (m) => console.error(m),
}) {
  if (!adminToken) throw new Error('createAuth: 没有 adminToken');
  if (typeof getUsers !== 'function') throw new Error('createAuth: 没有 getUsers');
  const adminDigest = sha256(adminToken);
  /** sid 的 sha256 → { username, can_manage_workers, exp, key_fp } */
  let sessions = new Map();
  /** 用过的 token 摘要 → 它的 exp。挡「token 文件被 CLI 写回旧版本、用过的又复活」（见 readLoginTokens 上面那段）。 */
  const consumed = new Map();
  /** 启动时加载的结果，给 bus 打一行日志、给测试看。 */
  let loadReport = null;

  if (sessionsFile) {
    let users = [];
    // serve.js 启动时已经过了一次 loadUsers 闸门 ⇒ 这里抛只可能是那之后一瞬间被改坏了；
    // 当空用户表处理 ⇒ 所有落盘的 session 作废（fail-closed），bus 照起。
    try { users = getUsers(); } catch (e) { log(`[auth] ⚠ 加载 session 时读不了用户表：${e.message}`); }
    const r = loadSessions(sessionsFile, { users, now: now() });
    sessions = r.sessions;
    loadReport = { file: sessionsFile, loaded: r.loaded, expired: r.expired, revoked: r.revoked, warn: r.warn };
    // 有条目被扔掉 ⇒ 当场写回，别让作废的摘要在文件里多躺一周
    if (r.expired || r.revoked) persist();
  }

  /** 写盘。失败只说、不抛：登录本身已经成了，最坏是 bus 重启后要重登。 */
  function persist() {
    if (!sessionsFile) return;
    try { saveSessions(sessionsFile, sessions, now()); } catch (e) {
      log(`[auth] ⚠ session 没落盘（${sessionsFile}：${e.code || e.message}）—— bus 重启后这些浏览器要重登`);
    }
  }

  function issueSession(u) {
    const sid = crypto.randomBytes(32).toString('base64url');
    // 只存 sid 的摘要：内存被 dump 出来、文件被读走时都拿不到能用的 cookie
    sessions.set(sha256(sid), {
      username: u.username, can_manage_workers: u.can_manage_workers, exp: now() + ttlMs,
      key_fp: keyFingerprint(u.key_sha256),
    });
    persist();
    return { sid, principal: { username: u.username, can_manage_workers: u.can_manage_workers, via: 'session' } };
  }

  /** 匹配不唯一 ⇒ 拒，并在 bus 日志里说清是哪几个名字（登录方只看到「不对」—— 别把用户表结构告诉外人）。 */
  function logAmbiguous(how, username, matches) {
    log(`[auth] ✗ ${how}被拒：「${username}」不分大小写匹配到 ${matches.length} 个用户`
      + `（${matches.map((m) => m.username).join(' / ')}）—— 用户表里有只差大小写的条目，删掉或改名其中一个`);
  }

  function login(username, key) {
    if (typeof username !== 'string' || typeof key !== 'string' || !key) return null;
    const { user: u, matches } = findUser(getUsers(), username);
    // 用户不存在也要算一次哈希 —— 别让「有没有这个用户」从耗时上漏出去
    const ok = digestEqual(sha256(key), u ? u.key_sha256 : sha256('\0nobody'));
    if (matches.length > 1) { logAmbiguous('登录', username, matches); return null; }
    if (!u || !ok) return null;
    return issueSession(u);
  }

  /**
   * 用一次性 token 换 session。
   * @returns {{ok:true, sid, principal} | {ok:false, reason:'invalid'|'used'|'expired'|'no_user'|'store'}}
   *   'store' = token 文件写不回去（删不掉它）⇒ **拒**：删不掉就不是「一次性」了。
   */
  function redeemLoginToken(token) {
    if (!loginTokensFile) return { ok: false, reason: 'invalid' };
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return { ok: false, reason: 'invalid' };
    const t0 = now();
    for (const [k, exp] of consumed) if (exp <= t0) consumed.delete(k);
    const h = sha256(token);
    if (consumed.has(h)) return { ok: false, reason: 'used' };
    const tokens = readLoginTokens(loginTokensFile);
    const rec = tokens[h];
    if (!rec || typeof rec.exp !== 'number' || typeof rec.username !== 'string') return { ok: false, reason: 'invalid' };
    // ★ 先删、再判过期 / 用户：拿到就作废，不管后面成不成 —— 一条链接只有一次机会
    delete tokens[h];
    consumed.set(h, rec.exp);
    try { writeLoginTokens(loginTokensFile, tokens, t0); } catch (e) {
      log(`[auth] ✗ 一次性登录被拒：token 文件写不回去（${loginTokensFile}：${e.code || e.message}）—— 删不掉它就不是一次性的`);
      return { ok: false, reason: 'store' };
    }
    if (rec.exp <= t0) return { ok: false, reason: 'expired' };
    const { user: u, matches } = findUser(getUsers(), rec.username);
    if (matches.length > 1) { logAmbiguous('一次性登录', rec.username, matches); return { ok: false, reason: 'no_user' }; }
    if (!u) return { ok: false, reason: 'no_user' };
    return { ok: true, ...issueSession(u) };
  }

  function logout(sid) {
    if (!sid) return;
    if (sessions.delete(sha256(sid))) persist();
  }

  /** 从请求头里认主体。认不出 ⇒ null（由调用方决定 401）。 */
  function principalOf(headers) {
    const h = headers || {};
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(h.authorization || ''));
    if (m) {
      // ★ 带了 Bearer 就只认 Bearer —— 错的 token 不回落到 cookie，
      //   否则「我的 token 过期了」会被一个碰巧还在的 cookie 掩盖。
      return digestEqual(sha256(m[1]), adminDigest)
        ? { username: ADMIN_NAME, can_manage_workers: true, via: 'admin-token' }
        : null;
    }
    const sid = parseCookies(h.cookie)[COOKIE];
    if (!sid) return null;
    const key = sha256(sid);
    const s = sessions.get(key);
    if (!s) return null;
    if (s.exp <= now()) { sessions.delete(key); return null; }
    // ★ 每次都跟**当前**用户表核一遍：删了用户 / 换了 key ⇒ 这条 session 当场作废。
    //   以前 session 只活到 bus 重启，「换 key 后旧设备要等重启才掉」还说得过去；
    //   落盘之后它能活满 7 天 ⇒ 不核的话，`bus-user add` 换 key 对已登录的设备一周不生效。
    //   代价：每个请求现读一次用户表（几百字节的 JSON，跟 login 现读是同一个函数）。
    //   用户表读不了 ⇒ 拒（fail-closed）：「用户表坏了」时放行旧 session，等于不再核。
    let users;
    try { users = getUsers(); } catch (e) {
      log(`[auth] ✗ 核对 session 时读不了用户表：${e.message}`);
      return null;
    }
    if (!sessionStillValid(s, users)) { sessions.delete(key); persist(); return null; }
    return { username: s.username, can_manage_workers: s.can_manage_workers, via: 'session' };
  }

  const UNAUTH = {
    error: 'UNAUTHENTICATED',
    message: '没有凭据，或凭据失效（session 过期、用户被删、或者 key 换过）。',
    next: '浏览器：POST /api/login {username, key}（页面会弹登录框）。'
      + `本机 CLI：Authorization: Bearer <${path.relative(ROOT, ADMIN_TOKEN_FILE) || ADMIN_TOKEN_FILE} 的内容>。`
      + `还没有账号：${ADD_HINT}`,
  };

  /** express 中间件：没有主体 ⇒ 401。 */
  function requireAuth(req, res, next) {
    const p = principalOf(req.headers);
    if (!p) return res.status(401).json(UNAUTH);
    req.principal = p;
    return next();
  }

  /**
   * 生命周期动作：在 requireAuth 之后，还要 `can_manage_workers === true`。
   * ★ 403 不是 401 —— 「你是谁」已经回答了，这里回答的是「你能不能」。
   *   混成一个的话，被拒的人会去重新登录，然后再被拒一次。
   */
  function requireManage(req, res, next) {
    const p = req.principal || principalOf(req.headers);
    if (!p) return res.status(401).json(UNAUTH);
    req.principal = p;
    if (p.can_manage_workers !== true) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: `「${p.username}」没有 can_manage_workers —— 起 / 停 agent、撤回队列条目要这个权限。`,
        next: '要授权的话在 config/users.json 里把这个用户的 can_manage_workers 改成 true，重新登录。',
      });
    }
    return next();
  }

  function setSessionCookie(res, sid) {
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; `
      + `Max-Age=${Math.floor(ttlMs / 1000)}`);
  }

  function loginHandler() {
    return (req, res) => {
      const { username, key } = req.body || {};
      let r;
      try { r = login(username, key); } catch (e) {
        // 用户表在运行中被改坏了 —— 说出来，别当成「密码错」
        return res.status(500).json({ error: 'AUTH_CONFIG', message: e.message });
      }
      if (!r) {
        return res.status(401).json({ error: 'BAD_CREDENTIALS', message: '用户名或 key 不对。',
          next: `丢了 key：在本机跑 ${LOGIN_HINT} 拿一条一次性登录链接（不换 key）；`
            + `或者 ${ADD_HINT} 换一个新 key（这个用户别的设备会一起掉线）。` });
      }
      setSessionCookie(res, r.sid);
      return res.json({ ok: true, username: r.principal.username,
        can_manage_workers: r.principal.can_manage_workers });
    };
  }

  /**
   * `POST /api/login-token {token}`：一次性链接换 session，cookie 跟 key 登录**同一个**。
   * ★ 为什么是 POST、token 走 body，而链接里的 token 在 `#` 后面（`web/auth.js` 读出来再 POST）：
   *   ① `#` 后面的部分浏览器不发给服务器 ⇒ 不进任何访问日志、转发进程的日志、Referer；
   *   ② 聊天软件的链接预览会替你 GET 一次链接 —— 换 session 的动作要是挂在 GET 上，
   *      预览那一下就把一次性 token 用掉了，人点开时只看到「已用过」。
   */
  function loginTokenHandler() {
    const MSG = {
      invalid: '这条登录链接无效（链接不完整，或者已经用过 —— bus 重启前用过的也算）。',
      used: '这条登录链接已经用过了 —— 每条只能用一次。',
      expired: '这条登录链接过期了（生成后 10 分钟内有效）。',
      no_user: '这条链接对应的用户已经不在用户表里了（或者名字不唯一，见 bus 日志）。',
      store: 'bus 删不掉这条 token（token 文件写不了），为了保证一次性，拒绝登录 —— 看 bus 日志。',
    };
    return (req, res) => {
      const { token } = req.body || {};
      let r;
      try { r = redeemLoginToken(token); } catch (e) {
        return res.status(500).json({ error: 'AUTH_CONFIG', message: e.message });
      }
      if (!r.ok) {
        return res.status(r.reason === 'store' ? 500 : 401).json({
          error: 'BAD_LOGIN_TOKEN', reason: r.reason, message: MSG[r.reason] || MSG.invalid,
          next: `在本机重新生成一条：${LOGIN_HINT}` });
      }
      setSessionCookie(res, r.sid);
      return res.json({ ok: true, username: r.principal.username,
        can_manage_workers: r.principal.can_manage_workers });
    };
  }

  function logoutHandler() {
    return (req, res) => {
      logout(parseCookies(req.headers.cookie)[COOKIE]);
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      res.json({ ok: true });
    };
  }

  /**
   * `ws` 的 verifyClient：upgrade 时校验，失败**拒绝 upgrade**（401）。
   * ★ 不能「先连上、再检查、再断开」—— `connection` 回调里第一件事就是把它加进
   *   广播集合，中间那一拍它已经能收到别人的消息了。
   */
  function verifyClient(info, cb) {
    const p = principalOf(info.req.headers);
    if (!p) return cb(false, 401, 'Unauthorized');
    info.req.principal = p;
    return cb(true);
  }

  return {
    login, logout, redeemLoginToken, principalOf, requireAuth, requireManage,
    loginHandler, loginTokenHandler, logoutHandler, verifyClient,
    sessions, loadReport,
  };
}

module.exports = {
  USERS_FILE, ADMIN_TOKEN_FILE, WEB_SESSIONS_FILE, LOGIN_TOKENS_FILE,
  COOKIE, SESSION_TTL_MS, LOGIN_TOKEN_TTL_MS, ADMIN_NAME, USERNAME_RE, ADD_HINT, LOGIN_HINT,
  sha256, loadUsers, findUser, caseCollisions, keyFingerprint, newKey, newAdminToken, writeAdminToken,
  readAdminToken, parseCookies, loadSessions, saveSessions, readLoginTokens, createLoginToken, createAuth,
};
