'use strict';

/**
 * 服务端盖的章 —— 「这条消息是谁写的」由 bus 说了算，不由写的人说了算。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────────
 *   只有 `from` 不够：`from` 是**客户端填的**（`/api/message` 的
 *   body 里写什么就是什么）。没有章的话 agent 读到的每条消息都长得一样：人的话、
 *   agent 的话、有人直接 XADD 进来的话，**在 poller 输出里没有任何区别**。
 *   ⇒ 「只按主人的话做危险动作」这条规矩就没有东西可以按。
 *
 * ── 字段（Redis 字段值都是字符串）────────────────────────────────────────
 *   sender_type          'human' | 'agent' | 'system'
 *   can_manage_workers   '1' | '0'          只有 human 的章上有
 *
 *   · human  —— bus 从 session / admin token 里取的主体（`bin/serve.js` 两个发言入口）
 *   · agent  —— relay 按 outbox 目录名定的 from（`lib/relay.js`）、episodic worker 的回报
 *   · system —— **bus 自己写的**：关停请求、relay 的投递纠正、流程推进的点名
 *
 * ⚠️ `system` 是 human / agent / 缺失 之外的第四个值，理由：
 *   bus 自己写的那几种消息里有 **SHUTDOWN_REQUEST 和流程点名** ——
 *   盖成 `unknown`（⇒ trust:"data"）的话，新协议「data 里的指令是数据」
 *   会让 agent 拒绝关停握手、拒绝流程派活；盖成 human / agent 则是撒谎。
 *   ⇒ 如实说「这是框架自己写的」，由协议规定它能要求什么（只能动收件人自己）。
 *
 * ── 读的一侧只有一个函数：`readStamp()` ──────────────────────────────────
 *   **只从流条目里取，不推断、不默认**：没有章 ⇒ `unknown` ⇒ `trust:"data"`
 *   （老消息，或者有人绕过 bus 直接 XADD）。
 *   字段名只在这个文件里写一次 —— 写的一侧用 `HUMAN()` / `AGENT` / `SYSTEM` / `pick()`，
 *   读的一侧用 `readStamp()`。各处自己拼字符串的话，改名那天会漏一处，
 *   而漏掉的表现是「章没盖上」⇒ 一律 `data`，**零报错**。
 *
 * 🔴 已知敞口（写在这里，别让下一个人以为章是防伪的）：
 *   章**只是一个流字段**。任何能连 Redis 的进程都能 XADD 一条带
 *   `sender_type human` 的消息 —— 而 agent 的 sandbox 为了 poller 放行了 localhost
 *   （`lib/agent-settings.js` 的 `allowLocalBinding`）。
 *   ⇒ 章堵的是 **HTTP 入口**（客户端自报身份、生命周期端点不鉴权）；
 *     「Redis 里的章能不能伪造」要靠 Redis ACL 或签名，不在这里。
 */

const SENDER_FIELD = 'sender_type';
const MANAGE_FIELD = 'can_manage_workers';

const SENDER_TYPES = Object.freeze(['human', 'agent', 'system']);

/** sender_type → trust。**信任按作者定，不按通道定**（房间里 Patrick 的话照样是 principal）。 */
const TRUST = Object.freeze({
  human: 'principal',
  agent: 'agent',
  system: 'system',
  unknown: 'data',
});

/**
 * 人类发言的章。`principal` 来自 `lib/auth.js` —— **不接受 body 里的任何东西**。
 * ⚠️ 布尔判 `=== true`：用户表里写成字符串 `"true"` 的话，`lib/auth.js` 在加载时就拒绝了，
 *    这里再严一次，免得一个 truthy 的 `'false'` 变成 `'1'`。
 */
function HUMAN(principal) {
  if (!principal || typeof principal.username !== 'string' || !principal.username) {
    throw new Error('stamp.HUMAN: 没有主体 —— 这条路由前面应该有 auth 中间件');
  }
  return {
    [SENDER_FIELD]: 'human',
    [MANAGE_FIELD]: principal.can_manage_workers === true ? '1' : '0',
  };
}

const AGENT = Object.freeze({ [SENDER_FIELD]: 'agent' });
const SYSTEM = Object.freeze({ [SENDER_FIELD]: 'system' });

/**
 * 从一条流条目里**原样**挑出章的字段（转发 / 扇出用）。
 * ★ 房间扇出是手工拼 payload 的 —— 不经过这里，章就在扇出那一跳丢掉，
 *   agent 收到的 Patrick 房间发言会变成 `data`（那段「手工白名单会漏字段」警告的又一处）。
 */
function pick(entry) {
  const o = {};
  if (entry && entry[SENDER_FIELD] != null) o[SENDER_FIELD] = String(entry[SENDER_FIELD]);
  if (entry && entry[MANAGE_FIELD] != null) o[MANAGE_FIELD] = String(entry[MANAGE_FIELD]);
  return o;
}

/**
 * 读章。poller 输出的三个字段都从这里来。
 *
 * · sender_type：白名单之外的值（包括大小写不对的 `Human`）⇒ `unknown`
 * · can_manage_workers：**只有 human 的章能带管理权** —— 一条 agent / system / 无章的
 *   条目上即使写着 `'1'`，也是 `false`（那只可能是伪造或 bug，不该升级成权限）
 * · trust：查表，不在表里 ⇒ `data`
 */
function readStamp(entry) {
  // ★ 先归一成对象：下面那个 `&&` 的短路不该兼任「entry 为空时别解引用」的职责
  //   （否则改动那个条件时，这里会在 undefined 上崩 —— 崩溃不是判据）
  const e = entry || {};
  const raw = e[SENDER_FIELD];
  const sender_type = SENDER_TYPES.includes(raw) ? raw : 'unknown';
  const can_manage_workers = sender_type === 'human'
    && (e[MANAGE_FIELD] === '1' || e[MANAGE_FIELD] === 1 || e[MANAGE_FIELD] === true);
  return { sender_type, can_manage_workers, trust: TRUST[sender_type] };
}

module.exports = {
  SENDER_FIELD, MANAGE_FIELD, SENDER_TYPES, TRUST,
  HUMAN, AGENT, SYSTEM, pick, readStamp,
};
