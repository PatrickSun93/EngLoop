#!/usr/bin/env node
'use strict';

/**
 * bus 的用户表管理。
 *
 * 用法:
 *   node bin/bus-user.js add <username> [--manage]      生成随机 key、写进用户表、把 key 打印一次
 *   node bin/bus-user.js list                           列出用户（不含 key）
 *   node bin/bus-user.js login <username> [--host <h>]  打印一条一次性登录链接（10 分钟内有效，**不换 key**）
 *
 * ★ 同名（同写法）再 add 一次 = **换 key**：旧 key 立刻失效，已登录的设备下一个请求就掉线
 *   （bus 每个请求都拿 session 里的 key 指纹跟当前用户表核 —— `lib/auth.js` principalOf）。
 * ★ 只差大小写的名字（已有 `Patrick`，又 add `patrick`）⇒ **报错退出**：
 *   登录本来就不分大小写，悄悄生成第二个用户只会让这个名字从此谁都登不进（匹配不唯一 ⇒ 拒）。
 * ★ 不带 `--manage` 就是 `can_manage_workers: false`，并且**打印出来**：
 *   一个默认值只有在被说出口的时候才不算「静默」。
 * ⚠️ key 只打印这一次，用户表里存的是它的 sha256（理由见 `lib/auth.js` 头注）。
 *   丢了 key ⇒ 用 `login` 拿一次性链接进来，别急着重新 add（那会把别的设备一起踢掉）。
 *
 * ── `login` 的链接地址 ────────────────────────────────────────────────────
 *   默认 `http://<bus 的 host>:<bus 的端口>` —— 跟 bus 自己 listen 的地址同一个出处
 *   （`bin/port-registry.js` 的注册表 ＋ `ENGLOOP_PORT`）。bus 只绑 127.0.0.1，
 *   所以默认链接只在本机能打开；手机要走的那条路（比如 tailnet 上的转发）不在这个仓库里，
 *   ⇒ 那时加 `--host <那个地址>`：只给 host 就沿用 bus 的端口，给 `host:port` 或完整 URL 就原样用。
 * ★ token 在链接的 `#` 后面：浏览器不把它发给服务器（不进任何日志），
 *   聊天软件的链接预览也用不掉它 —— 见 `lib/auth.js` 的 loginTokenHandler。
 * ★ bus 不在跑也能生成：token 写进文件，bus 用的时候现读（跟用户表一样）。
 *
 * 用户表路径：`config/users.json`（gitignored），`ENGLOOP_USERS_FILE` 可改。
 * token 文件：`temp/login-tokens.json`，`ENGLOOP_LOGIN_TOKENS_FILE` 可改（要跟 bus 用的同一份）。
 */

const fs = require('node:fs');
const path = require('node:path');
const auth = require('../lib/auth');
const portRegistry = require('./port-registry');

function usage(code = 2) {
  process.stderr.write('用法:\n'
    + '  node bin/bus-user.js add <username> [--manage]\n'
    + '  node bin/bus-user.js list\n'
    + '  node bin/bus-user.js login <username> [--host <host|host:port|URL>]\n');
  process.exit(code);
}

function readExisting(file) {
  if (!fs.existsSync(file)) return [];
  // 已有的文件必须是合法的 —— 坏文件上「追加」会把坏的部分一起写回去
  try { return auth.loadUsers(file); } catch (e) {
    if (/是空的/.test(e.message)) return [];
    process.stderr.write(`✗ 现有用户表不合法，不动它：\n${e.message}\n`
      + `  确认可以丢掉的话：rm ${file} 再 add。\n`);
    process.exit(1);
  }
}

function write(file, users) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** 链接的前半段。见文件头「login 的链接地址」。 */
function linkBase(host) {
  const bus = portRegistry.resolve('bus');
  if (!host) return `http://${bus.host}:${bus.port}`;
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, '');
  return /:\d+$/.test(host) ? `http://${host}` : `http://${host}:${bus.port}`;
}

function cmdLogin(rest, file) {
  const hostIdx = rest.indexOf('--host');
  const host = hostIdx >= 0 ? rest[hostIdx + 1] : null;
  if (hostIdx >= 0 && (!host || host.startsWith('--'))) usage();
  const args = rest.filter((a, i) => !(hostIdx >= 0 && (i === hostIdx || i === hostIdx + 1)));
  const name = args.find((a) => !a.startsWith('--'));
  if (!name || args.some((a) => a.startsWith('--')) || args.length !== 1) usage();

  const users = readExisting(file);
  const { user, matches } = auth.findUser(users, name);
  if (matches.length > 1) {
    process.stderr.write(`✗「${name}」不分大小写匹配到 ${matches.length} 个用户：${matches.map((m) => m.username).join(' / ')}\n`
      + `  这个名字在 bus 上登录会被拒（匹配不唯一）—— 先在 ${file} 里删掉或改名其中一个。\n`);
    process.exit(1);
  }
  if (!user) {
    process.stderr.write(`✗ 用户表里没有「${name}」（${file}）。`
      + (users.length ? `已有：${users.map((u) => u.username).join(', ')}\n` : `\n  先建一个：${auth.ADD_HINT}\n`));
    process.exit(1);
  }
  const { token, exp } = auth.createLoginToken({ file: auth.LOGIN_TOKENS_FILE, username: user.username });
  const url = `${linkBase(host)}/#login-token=${token}`;
  const mins = Math.round(auth.LOGIN_TOKEN_TTL_MS / 60000);
  console.log(`✓ 一次性登录链接：${user.username}（${mins} 分钟内有效，到 ${new Date(exp).toLocaleTimeString()}；只能用一次）`);
  console.log('');
  console.log(`  ${url}`);
  console.log('');
  console.log('  key 没换 —— 这个用户别的设备不受影响。');
  if (!host) {
    console.log('  ⚠ 这是 bus 自己的地址（只在本机能打开）。手机走别的地址进来的话，加 --host <那个地址> 重新生成。');
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const file = auth.USERS_FILE;

  if (cmd === 'list') {
    const users = readExisting(file);
    if (!users.length) {
      console.log(`（${file} 里没有用户 —— bus 会拒绝启动。先跑：${auth.ADD_HINT}）`);
      return;
    }
    for (const u of users) console.log(`${u.username}\tcan_manage_workers=${u.can_manage_workers}`);
    return;
  }

  if (cmd === 'login') return cmdLogin(rest, file);

  if (cmd !== 'add') usage();
  const name = rest.find((a) => !a.startsWith('--'));
  const unknownFlags = rest.filter((a) => a.startsWith('--') && a !== '--manage');
  if (!name || unknownFlags.length) usage();
  if (!auth.USERNAME_RE.test(name)) {
    process.stderr.write(`✗ 用户名必须匹配 ${auth.USERNAME_RE}\n`);
    process.exit(2);
  }
  if (name === auth.ADMIN_NAME) {
    process.stderr.write(`✗「${auth.ADMIN_NAME}」是本机 admin token 的主体名，保留\n`);
    process.exit(2);
  }
  const manage = rest.includes('--manage');
  const existing = readExisting(file);
  // ★ 只差大小写 ⇒ 拒（见文件头）。同写法的不算冲突 —— 那是换 key。
  const clash = existing.filter((u) => u.username !== name && u.username.toLowerCase() === name.toLowerCase());
  if (clash.length) {
    process.stderr.write(`✗ 已经有「${clash[0].username}」了 —— 用户名登录时不分大小写，「${name}」会跟它撞。\n`
      + `  要给它换 key：node bin/bus-user.js add ${clash[0].username}${manage ? ' --manage' : ''}\n`
      + `  只是丢了 key：node bin/bus-user.js login ${clash[0].username}（一次性登录链接，不换 key）\n`);
    process.exit(1);
  }
  const key = auth.newKey();
  const users = existing.filter((u) => u.username !== name);
  const replaced = users.length !== existing.length;
  users.push({ username: name, key_sha256: auth.sha256(key), can_manage_workers: manage });
  write(file, users);
  // 写完再读一遍：bus 启动时用的是同一个校验 —— 这里过不了，bus 也起不来
  auth.loadUsers(file);

  console.log(`✓ ${replaced ? '换了 key' : '加了用户'}：${name}  can_manage_workers=${manage}`
    + (manage ? '' : '（不能起 / 停 agent；要的话加 --manage 重跑）'));
  console.log(`  用户表：${file}`);
  console.log('');
  console.log(`  key（只打印这一次，浏览器登录用）：${key}`);
  console.log('');
  if (replaced) console.log('  旧 key 已失效：用旧 key 登录着的设备，下一个请求就会被要求重新登录。');
  console.log(`  丢了 key 不用再 add：${auth.LOGIN_HINT} 拿一条一次性登录链接。`);
}

main(process.argv.slice(2));
