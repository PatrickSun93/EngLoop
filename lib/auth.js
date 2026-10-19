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
 * ── session 存**内存**，不存 Redis ───────────────────────────────────────
 *   Redis 对每个 agent 都是**可写**的（sandbox 放行 localhost，poller 要它）。
 *   session 存在 Redis 里 ⇒ agent 写一条 `session:<它自己编的 id> → <某个用户>`，
 *   再带上那个 cookie 就是那个用户。存 id 的哈希也挡不住（它可以写自己 id 的哈希）。
 *   ⇒ **内存是 agent 唯一碰不到的地方**。代价：bus 重启后浏览器要重新登录一次
 *     （`web/auth.js` 收到 401 会弹登录框）。
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

const COOKIE = 'engloop_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const ADMIN_NAME = 'local-admin';
/** 用户名的字符集 —— 它会进流的 `from` 字段、进网页、进 outbox 路由。 */
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const ADD_HINT = 'node bin/bus-user.js add <username> --manage';

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

/** 生成一个新 key（给 bin/bus-user.js 用）。 */
function newKey() { return crypto.randomBytes(32).toString('base64url'); }

/**
 * 写 admin token：0600，每次启动换新。
 * ★ 先写临时文件再 rename —— 直接覆盖的话，`writeFileSync` 的 `mode` 只在**新建**时生效，
 *   一个被人 chmod 过的旧文件会保留旧权限。
 */
function newAdminToken() { return crypto.randomBytes(32).toString('hex'); }

function writeAdminToken(file = ADMIN_TOKEN_FILE, token = newAdminToken()) {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('writeAdminToken: token 必须是 64 位 hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return token;
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
 */
function createAuth({ adminToken, getUsers, ttlMs = SESSION_TTL_MS, now = () => Date.now() }) {
  if (!adminToken) throw new Error('createAuth: 没有 adminToken');
  if (typeof getUsers !== 'function') throw new Error('createAuth: 没有 getUsers');
  const adminDigest = sha256(adminToken);
  /** sid 的 sha256 → { username, can_manage_workers, exp } */
  const sessions = new Map();

  function login(username, key) {
    if (typeof username !== 'string' || typeof key !== 'string' || !key) return null;
    const u = getUsers().find((x) => x.username === username);
    // 用户不存在也要算一次哈希 —— 别让「有没有这个用户」从耗时上漏出去
    const ok = digestEqual(sha256(key), u ? u.key_sha256 : sha256('\0nobody'));
    if (!u || !ok) return null;
    const sid = crypto.randomBytes(32).toString('base64url');
    // 只存 sid 的摘要：内存被 dump 出来时也拿不到能用的 cookie
    sessions.set(sha256(sid), { username: u.username, can_manage_workers: u.can_manage_workers, exp: now() + ttlMs });
    return { sid, principal: { username: u.username, can_manage_workers: u.can_manage_workers, via: 'session' } };
  }

  function logout(sid) { if (sid) sessions.delete(sha256(sid)); }

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
    return { username: s.username, can_manage_workers: s.can_manage_workers, via: 'session' };
  }

  const UNAUTH = {
    error: 'UNAUTHENTICATED',
    message: '没有凭据，或凭据失效（bus 重启后 session 会清空）。',
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
          next: `key 只在 ${ADD_HINT} 时打印一次；丢了就重新 add 一次（会覆盖旧 key）。` });
      }
      res.setHeader('Set-Cookie', `${COOKIE}=${r.sid}; HttpOnly; SameSite=Strict; Path=/; `
        + `Max-Age=${Math.floor(ttlMs / 1000)}`);
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
    login, logout, principalOf, requireAuth, requireManage, loginHandler, logoutHandler, verifyClient,
    sessions,
  };
}

module.exports = {
  USERS_FILE, ADMIN_TOKEN_FILE, COOKIE, SESSION_TTL_MS, ADMIN_NAME, USERNAME_RE, ADD_HINT,
  sha256, loadUsers, newKey, newAdminToken, writeAdminToken, readAdminToken, parseCookies, createAuth,
};
