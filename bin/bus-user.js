#!/usr/bin/env node
'use strict';

/**
 * bus 的用户表管理。
 *
 * 用法:
 *   node bin/bus-user.js add <username> [--manage]   生成随机 key、写进用户表、把 key 打印一次
 *   node bin/bus-user.js list                        列出用户（不含 key）
 *
 * ★ 同名再 add 一次 = **换 key**（旧 key 立刻失效 —— 对已登录的浏览器要等它的 session 过期或 bus 重启）。
 * ★ 不带 `--manage` 就是 `can_manage_workers: false`，并且**打印出来**：
 *   一个默认值只有在被说出口的时候才不算「静默」。
 * ⚠️ key 只打印这一次，用户表里存的是它的 sha256（理由见 `lib/auth.js` 头注）。
 *
 * 用户表路径：`config/users.json`（gitignored），`ENGLOOP_USERS_FILE` 可改。
 */

const fs = require('node:fs');
const path = require('node:path');
const auth = require('../lib/auth');

function usage(code = 2) {
  process.stderr.write('用法:\n'
    + '  node bin/bus-user.js add <username> [--manage]\n'
    + '  node bin/bus-user.js list\n');
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
  const key = auth.newKey();
  const existing = readExisting(file);
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
  console.log('  已登录的浏览器在 bus 重启后要重新登录（session 存在 bus 内存里）。');
}

main(process.argv.slice(2));
