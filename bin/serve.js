#!/usr/bin/env node
'use strict';

/**
 * EngLoop bus —— 只搬运字节，不含任何 LLM 逻辑（核心性质）。
 *
 * ── 不挂起 HTTP 等回复 ────────────────────────────────────────────
 * 把 HTTP 请求挂起、等 outbox 出现回复的话，HTTP 超时（分钟级）
 * 和大脑的轮询（594 秒）两个时间尺度对不上，
 * 长任务必然踩坑，只能靠「先 ACK 再 followup」绕。
 *
 * 所以 POST 立即 202，所有回复走 WebSocket。这个矛盾从根上没有了。
 * ───────────────────────────────────────────────────────────────
 *
 *   浏览器 --POST--> bus --XADD--> orch:in:human --> agent(next.js)
 *   浏览器 <--WS---- bus <--XREAD-- orch:out <--relay-- agent 写的 outbox 文件
 */

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');
const q = require('../lib/queue');
const { startRelay, planRelays } = require('../lib/relay');
const os = require('node:os');
const roster = require('../lib/roster');
const watchdog = require('../lib/watchdog');
const catalog = require('../lib/agent-catalog');
const launch = require('../lib/agent-ui-start');
const { startPool } = require('../lib/worker-pool');
const rooms = require('../lib/rooms');
const reactions = require('../lib/reactions');
const threadMerge = require('../lib/thread-merge'); const threadCount = require('../lib/thread-count'); // 人的发言清零 thread 计数
// 只为 `KINDS`（kind 的合法值域，唯一出处）。UMD、零依赖，引它成不了环。
const threads = require('../web/threads.js');
const messages = require('../lib/messages');
const queueItems = require('../lib/queue-items');
const status = require('../lib/status');
const docs = require('../lib/docs');
const tmux = require('../lib/tmux');
const shutdown = require('../lib/shutdown');
const history = require('../lib/history');
const outputs = require('../lib/outputs');
const portRegistry = require('./port-registry');
const auth = require('../lib/auth');
const stamp = require('../lib/stamp');
const graphRunner = require('../lib/graph-runner');
const verifyLib = require('../lib/verify-complete');
const doneVerify = require('../lib/done-verify');

// ── 端口来自注册表，不在这里再写一个默认值 ──────────────────────
// 用到这个数字的不止这里（还有 `bus-restart.js`、`placeholder-server.js`、
// `preflight.sh`）。各写一份 `ENGLOOP_PORT || 9969` 的话，
// 两个服务各自默认同一个端口，谁都没错，撞了才知道。
//
// `BUS.host` 也从注册表来 —— 启动地址和**启动前的试探地址**必须是同一个值，
// 不然试探回答的是另一个问题（见 `bin/port-registry.js` 头部）。
const BUS = portRegistry.resolve('bus');
const PORT = BUS.port;
const ROOT = path.join(__dirname, '..');

// ── 隔离模式（让 e2e 能在编排者活着的时候跑）──────────────────────
//
// 编排者是常驻进程。没有隔离模式的话，`test/e2e.test.js` 只能「orch 会话在跑 → 跳过」，
// 而它是唯一测「人 → bus → 队列 → agent → relay → bus → 人」整条链的文件 ——
// **那一圈在系统正常运行时就永远跑不到**，单元层再绿也盖不住它。
//
// ⚠️ 隔离是**下面这张表一起**，少一件就会去碰生产：
//
//   ①  redis db     ENGLOOP_REDIS_URL          不然写进生产流,跟真编排者抢消息
//   ②  端口         ENGLOOP_PORT               不然占了 9969 起不来
//   ③  outbox 根    ENGLOOP_OUTBOX_ROOT        ★ 少了这个,测试写的假回复会被
//                                                **真 relay 捡走并发给人**
//   ④  tmux         隔离模式下用 no-op         ★★ 少了这个,测试 bus 的 watchdog 会
//                                                枚举到真会话、判它失聪、
//                                                **往真会话里打字**
//   ⑤  历史导出     ENGLOOP_HISTORY_ROOT       往生产 history/ 里追假消息
//   ⑥  产出目录     ENGLOOP_OUTPUTS_ROOT       同上
//   ⑦  漏挂告警     ENGLOOP_THREAD_ALERT_DIR   ★ 见下面那条
//   ⑧  admin token  ENGLOOP_ADMIN_TOKEN_FILE   ★ 少了这个,测试 bus 每起一次就**换掉生产
//                                                bus 的 CLI 钥匙** ⇒ `agent-start --stop` 401
//   ⑨  任务图目录   ENGLOOP_GRAPHS_ROOT        ★ 调度器会把 worker 的输出**写成文件**（节点的 produces）。
//                                                不隔离的话，测试图只能建在生产 docs/flows/ 下面
//   ⑩  核验缓存     ENGLOOP_VERIFY_CACHE       ★ 完成核验的基线结果按 sha 缓存、核验日志也在这里。
//                                                测试 bus 用假的测试命令跑出来的「基线」写进生产缓存的话，
//                                                **同一个 sha 的真核验会命中一份假基线**
//   ⑪  session 文件 ENGLOOP_WEB_SESSIONS_FILE  ★ 登录 / 登出 / 作废时整份重写。测试 bus 写进生产路径的话，
//                                                **生产 bus 下次重启加载的是测试用户的 session 表**，
//                                                Patrick 已登录的手机全部掉线
//   ⑫  登录 token   ENGLOOP_LOGIN_TOKENS_FILE  一次性登录链接的 token 表。测试 bus 换 token 时会重写它 ⇒
//                                                刚生成、还没点开的真链接被冲掉
//
// ★ ③④ 不是一眼能想到的 —— 直觉上只会去换 redis 和端口。
//   **「隔离」这个词会让人以为它是一件事，实际上它是「所有出口都要堵」。**
//
// ⚠️⚠️ **这张表逐条列出、不写总数** —— 一个**自己不会更新的数字**，
//   正是人用来判断「是不是漏了一件」的东西，而出口的数量会随功能增长。
//   加出口时**在这张表里加一行**，不要写一个总数。
const ISOLATED = process.env.ENGLOOP_ISOLATED === '1';
const OUTBOX = process.env.ENGLOOP_OUTBOX_ROOT || path.join(ROOT, 'temp', 'outbox');
// ★ 产出目录、历史导出：不隔离的话，
//   **一个测试 bus 会往生产的 `history/` 里追加它自己那些假消息。**
//   > **「所有出口都要堵」这句话的麻烦在于：出口的数量会随功能增长。**
//   > 每加一个往外写的东西，就要回来问一次「隔离模式下它写去哪」。
const OUTPUTS_ROOT = process.env.ENGLOOP_OUTPUTS_ROOT
  || (ISOLATED ? path.join(os.tmpdir(), 'engloop-isolated-outputs') : path.join(ROOT, 'outputs'));
const HISTORY_ROOT = process.env.ENGLOOP_HISTORY_ROOT
  || (ISOLATED ? path.join(os.tmpdir(), 'engloop-isolated-history') : path.join(ROOT, 'history'));
// ★ 漏挂 thread 的告警状态文件。
//
// ── 为什么要在这里按 ISOLATED 显式分支 ────────────────────────────
//   `lib/thread-alert.js` 有两层防污染：`threadAlertDir` 参数，
//   以及默认值里的 `isTestProcess()`（判 `require.main` 在不在 `test/` 下）。
//   **两层都接不住 e2e** —— 因为 e2e 不是「测试脚本自己 require 那个模块」，
//   它 **spawn 了一个隔离 bus 子进程**，那个进程的入口就是 `bin/serve.js`。
//
//   > **进程级判据天然覆盖不了「同一程序的隔离实例」。**
//   > `isTestProcess()` 不是不够聪明 —— 它回答的是另一个问题。
//   > 该问的不是「我是不是测试」，是「**我这个实例是不是隔离的**」，
//   > 而那件事实例自己知道（`ENGLOOP_ISOLATED`），一个字都不用猜。
//
//   ⚠️⚠️ 而 `threadAlertDir` 参数**两侧都要传**：**测试**调用方漏传，跑一次套件就往
//   编排者的生产状态文件里追假告警（被假告警刷过几轮，读者就学会忽略那个告警）；
//   **生产**调用方漏传，就是下面这一行。
//   ⇒ 即 `lib/relay.js` 那段「函数支持透传 ≠ 调用方真的传了，这个形状会再长回来」。
//
// ⚠️ `ISOLATED` 那个分支是**兜底**，而兜底只有被真跑过才算数：
//   `test/e2e.test.js` **故意不设** `ENGLOOP_THREAD_ALERT_DIR`，就是为了让
//   这一行每次 e2e 都真的执行到。理由和「别顺手让 cleanup 删掉那个目录」
//   一起写在 e2e 那边的隔离验收段 —— 想动这里之前先读那段。
const THREAD_ALERT_DIR = process.env.ENGLOOP_THREAD_ALERT_DIR
  || (ISOLATED ? path.join(os.tmpdir(), 'engloop-isolated-thread-alert') : undefined);
// ★ 本机 CLI 的 admin token 文件。
//   bus 每次启动都换新 token 并覆盖这个文件 ⇒ 一个隔离 bus 写进生产路径的话，
//   **生产 bus 手里的 token 和文件里的对不上**，`agent-start --stop` 从此 401。
const ADMIN_TOKEN_FILE = process.env.ENGLOOP_ADMIN_TOKEN_FILE
  || (ISOLATED ? path.join(os.tmpdir(), `engloop-isolated-admin-${process.pid}.token`) : auth.ADMIN_TOKEN_FILE);
// ★ 任务图目录的根。调度器**只许**在它下面读 PLAN.json、
//   写 worker 的产出 —— 生产是 docs/flows/（图的产出要提交进仓库，跟房间流程同一个目录）。
const GRAPHS_ROOT = process.env.ENGLOOP_GRAPHS_ROOT
  || (ISOLATED ? path.join(os.tmpdir(), 'engloop-isolated-graphs') : path.join(ROOT, 'docs', 'flows'));
// ★ 完成核验的基线缓存 ＋ 核验日志。生产 = temp/verify-cache
//   （agent 写不进去：lib/agent-settings.js 的 Edit deny ＋ sandbox denyWrite —— QA 结论不许出现在 agent 能写的地方）。
const VERIFY_CACHE = process.env.ENGLOOP_VERIFY_CACHE
  || (ISOLATED ? path.join(os.tmpdir(), `engloop-isolated-verify-${process.pid}`) : verifyLib.DEFAULT_CACHE_ROOT);
// ★ session 落盘 ＋ 一次性登录 token（隔离表 ⑪ ⑫）。隔离兜底带 pid：
//   两个并发的隔离 bus 共用一份的话，后写的整份覆盖先写的。
//   ⚠️ 要测「重启后 session 还在」的测试**必须显式给** ENGLOOP_WEB_SESSIONS_FILE —— 兜底路径随 pid 变，
//   重启之后是另一个文件（那正是兜底该有的样子：没说要共享，就不共享）。
const WEB_SESSIONS_FILE = process.env.ENGLOOP_WEB_SESSIONS_FILE
  || (ISOLATED ? path.join(os.tmpdir(), `engloop-isolated-web-sessions-${process.pid}.json`) : auth.WEB_SESSIONS_FILE);
const LOGIN_TOKENS_FILE = process.env.ENGLOOP_LOGIN_TOKENS_FILE
  || (ISOLATED ? path.join(os.tmpdir(), `engloop-isolated-login-tokens-${process.pid}.json`) : auth.LOGIN_TOKENS_FILE);

// ── 身份与鉴权 ──────────────────────────────────────────────────
//
// ★ 用户表缺失 / 为空 / 不合法 ⇒ **拒绝启动**（78 = EX_CONFIG，跟端口配置错同一类）。
//   不给默认用户、不退回「不鉴权」：那正是鉴权要消灭的状态，
//   而一个「起来了但谁都能调」的 bus 跟一个正常的 bus 从外面看一模一样。
// ★ 每次登录都现读用户表 —— `bin/bus-user.js add` 之后不用重启 bus。
//   启动时这一次是**闸门**：读不过就不起。
try {
  const users = auth.loadUsers(auth.USERS_FILE);
  // ★ 只差大小写的名字不拒启动（拒了会把别的用户一起关在外面），但要说出来：
  //   那个名字从此登录不了（匹配不唯一 ⇒ 拒），而登录方只看到「用户名或 key 不对」。
  for (const g of auth.caseCollisions(users)) {
    console.error(`[bus] ⚠ 用户表里有只差大小写的名字：${g.join(' / ')} —— 这个名字登录会被拒（匹配不唯一）。`
      + `删掉或改名其中一个：${auth.USERS_FILE}`);
  }
} catch (e) {
  console.error(`[bus] ✗ 拒绝启动：${e.message}`);
  process.exit(78);
}
// token 先在内存里生成，**绑上端口之后才写文件**（见 server.listen 回调）——
// 先写的话，一个撞端口起不来的第二个 bus 会把正在跑的那个 bus 的钥匙换掉。
const ADMIN_TOKEN = auth.newAdminToken();
const busAuth = auth.createAuth({
  adminToken: ADMIN_TOKEN,
  getUsers: () => auth.loadUsers(auth.USERS_FILE),
  sessionsFile: WEB_SESSIONS_FILE,
  loginTokensFile: LOGIN_TOKENS_FILE,
  log: (m) => console.error(m),
});
{
  // 加载结果打一行：「重启后还登着几个」是这个功能唯一的活性证据。
  // 没有 loadReport = createAuth 没拿到 sessionsFile ⇒ session 只在内存里 —— 也要说出来，不能静默退化。
  const r = busAuth.loadReport;
  if (!r) {
    console.error('[auth] ⚠ session 没有落盘文件 —— bus 重启后所有浏览器要重登');
  } else {
    if (r.warn) console.error(`[auth] ${r.warn}`);
    console.log(`[auth] session 文件 ${r.file}：恢复 ${r.loaded} 条 · 过期丢弃 ${r.expired} 条`
      + ` · 作废 ${r.revoked} 条（用户已删 / key 换过 / 条目坏了）`);
  }
}
// ── 页面不内联在这个文件里 ──────────────────────────────────────
// 把 HTML/CSS/JS 塞进一个模板字符串常量的话，**想改样式的人得先在一个
// 几百行的 .js 里找 CSS**，而且编辑器对模板字符串里的 CSS 没有任何语法支持 ——
// 拼错一个属性名要等到浏览器里才发现。
//
// 所以 `web/` 是普通静态文件。serve.js 只管路由和托管。
const WEB = path.join(ROOT, 'web');

const IN_HUMAN = 'orch:in:human';
const OUT = 'orch:out';
const OUT_GROUP = 'bus';
// 编排者的名字。⚠️ 这是一条散在多处的约定（这里、`orch-start.js`、
// `watchdog.js` 各有一份 'JARVIS'），还没有唯一出处。
const ORCH_NAME = 'JARVIS';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ⚠️ 两个连接，不是一个。
//
// Redis 的阻塞命令（XREADGROUP BLOCK）会**独占整条连接**直到返回。
// 共用一个 client 的话，deliverLoop 阻塞 5 秒期间，HTTP 进来的 XADD
// 会排在它后面等 —— POST 从毫秒级劣化到秒级，而且完全没有报错，
// 只是「有点慢」。这类 bug 在压测时才暴露，很难查。
//
//   redis      普通命令：XADD / PING / XACK
//   blocking   专供长阻塞读，独占无所谓
// ★ 主连接包了一层守卫：**拿它跑阻塞命令会当场抛错**。
//   光有上面那段注释拦不住：新代码照样会拿主连接跑
//   `claimNext(redis, {blockMs:5000})`，bus 的每个 HTTP 请求
//   慢好几秒，`/api/agents` 甚至超时。**约定不是机制，新代码不会读注释。**
const redis = q.nonBlockingOnly(q.createClient(), 'bus:main');
const blocking = q.createClient();
const blocking2 = q.createClient();  // 房间扇出专用（阻塞命令独占连接）
const blocking3 = q.createClient();  // agent → 编排者 那条流专用（同上，阻塞独占）
const clients = new Set();
let redisHealthy = true;

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

// ── HTTP ────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  let redisPing = 'down';
  try {
    redisPing = (await redis.ping()).toLowerCase();
    redisHealthy = true;
  } catch (_) {
    redisHealthy = false;
  }
  res.json({
    ok: redisHealthy,
    service: 'engloop-bus',
    redis: redisPing,
    ws_clients: clients.size,
    uptime_s: Math.round(process.uptime()),
  });
});

// ── 鉴权闸门 ────────────────────────────────────────────────────
//
// ★ `/health`、`/api/login`、`/api/login-token` 之外，**所有 `/api/*` 都要 session 或 admin token** —— 读接口也要：
//   `/api/messages` 能读到所有人的对话，而 agent 的 sandbox 放行了 localhost。
// ★ 顺序就是机制：两个登录入口挂在闸门**之前**，其余 `/api/*` 全在**之后**。
//   新加的 `/api/*` 路由只要写在这行下面就自动受保护 —— 不靠每个路由记得加中间件。
// ⚠️ 静态页面（web/）不受保护：登录框本身要能加载出来，而页面里没有数据，数据全走 /api。
//   一次性登录链接打开的就是首页（`/#login-token=…`），由 web/auth.js 读出 token 再 POST 到 /api/login-token。
app.post('/api/login', busAuth.loginHandler());
app.post('/api/login-token', busAuth.loginTokenHandler());
app.use('/api', busAuth.requireAuth);
app.post('/api/logout', busAuth.logoutHandler());
/** 网页用它知道「我是谁」（本地回显的署名、登录框要不要弹）。 */
app.get('/api/whoami', (req, res) => res.json({
  username: req.principal.username, can_manage_workers: req.principal.can_manage_workers, via: req.principal.via,
}));

app.post('/api/message', async (req, res) => {
  // ★ `reply_to` 可选：不传 = 顶层发言（既有行为，老客户端零改动）。
  //   跟房间那条 `/api/rooms/:hash/post` 对称 —— 没有它，私聊里
  //   一篇复盘长文和一句随口的问题只能在同一列里平级堆着。
  //
  // ★★ 值是 **job_id**，不是 stream id。这一行是整件事的关键，理由见下面
  //   q.send 那处的注释 —— 简单说：私聊的历史是**两条流合并**读出来的，
  //   而两条流的 stream id 会撞。
  // ★ `kind`（thread 模型）：`topic` / `reply` / `notice`。
  //   不传时**不猜** —— 让下游按「有没有 reply_to」推断（见 web/app.js 的 kindOf）。
  //   在这里猜一个值的话，「人没标」和「人标了 topic」就再也分不开了。
  //
  // ★★ `from` **不从 body 取** —— 取 session / token 的主体名。
  //   body 里写了 `from` 也照收不误、只是不用：老客户端（每次都在 body 里带
  //   `from`）不用改就能继续发，而冒名的那一半没有任何效果。
  //   同时盖章：`sender_type: human` ＋ `can_manage_workers` —— agent 只按这个章决定听不听。
  const { text, reply_to = null, kind = null } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }
  const from = req.principal.username;

  try {
    const sent = await q.send(redis, IN_HUMAN, {
      from, text, to: 'orchestrator', agent_type: 'orchestrator',
      ...stamp.HUMAN(req.principal),
      // ★★★ 私聊 thread 的锚点是 `job_id`，房间那边是房间流的 stream id
      //   —— **这个不一致是对的，别去「统一」它。**
      //
      //   房间：只有一条流 ⇒ stream id 天然唯一；而人走 `rooms.post()`
      //         的那条**根本没有 job_id**（见 `lib/rooms.js` 的 `post()`）。
      //   私聊：`lib/messages.js` 把 `orch:in:human`（人发的）和
      //         `orch:out`（agent 发的）**合并**成一个列表 —— 两条流各自
      //         独立计数，同一毫秒各写一条就是同一个 id（交替高频写时
      //         **撞 id 很常见**）。而两侧都有 job_id（randomUUID）。
      //
      //   ⇒ 两边的唯一性来源不同，各自取了正确的那个。
      //     **合并成一个字段的话，房间那条没有 job_id 的路径会静默变成
      //     `undefined`** —— 而 undefined 的 reply_to 表现为「顶层发言」，
      //     跟没填一模一样，零报错。
      ...(reply_to ? { reply_to: String(reply_to) } : {}),
      // ★ 同 relay 那处：只认识白名单里的值，别的一律丢掉 ——
      //   拼错的值退化成「没标」，于是它走可见的那条路，而不是变成一个
      //   前端不认识的分类静默落进 else。
      //
      // ⚠️ 值域**不在这里定义** —— 唯一出处是 `web/threads.js` 的 `KINDS`。
      //   各写一份数组的话，加新值时很容易只改 relay + kindOf，
      //   **漏掉这条「人从网页发」的入口**。
      //   少改一处不报错，两个方向的症状还不同（字段被丢掉 / 前端不认），
      //   所以三处都来引同一个数组。
      ...(threads.KINDS.includes(kind) ? { kind } : {}),
    });
    // 人在这个 thread 里说话了 ⇒ agent 来回计数清零（`lib/thread-count.js`）。永远不抛 —— 消息已经进流了，失败只记一行日志。
    await threadCount.recordAndAlert(redis, { scope: 'dm', id: sent.job_id, reply_to: sent.reply_to, from, sender_type: 'human' }, { onEvent: (e) => console.log(`[thread-count] ${JSON.stringify(e)}`) });
    // 回的是一条超限告警 ⇒ 清告警记着的那个 thread（它可能在 agent 私聊 / 房间里，人在网页上碰不到）。永远不抛。
    if (sent.reply_to) await threadCount.resetByAlertReply(redis, sent.reply_to, { onEvent: (e) => console.log(`[thread-count] ${JSON.stringify(e)}`) });
    // 立即 202。不 await 回复 —— 回复什么时候来就什么时候从 WS 推。
    res.status(202).json({ accepted: true, job_id: sent.job_id });
  } catch (err) {
    // Redis 不可用时必须**大声拒绝**，绝不能假装收下。
    // Redis 是整条队列的单点。
    redisHealthy = false;
    res.status(503).json({
      error: 'QUEUE_UNAVAILABLE',
      message: String(err.message || err),
      accepted: false,
    });
  }
});

app.get('/api/rooms', async (_req, res) => {
  try { res.json({ rooms: await rooms.list(redis) }); }
  catch (e) { res.status(503).json({ error: 'QUEUE_UNAVAILABLE', message: e.message }); }
});

/**
 * 建房间。`flow` 可选 —— 给了就顺带绑流程（建目录 + 校验角色都在花名册里）。
 *
 * ★ handler 在 lib/rooms.js 里，这里只挂载。理由跟下面 history 那条一样，
 *   而且更实：这些端点的价值**全在状态码上**（404/409/400/200），
 *   而状态码只有真走一遍 HTTP 才验得到 —— 写在这个回调里就没法测。
 */
app.post('/api/rooms', rooms.createHandler(redis));

/**
 * 事后绑流程。⚠️ **已经绑过的拒绝改绑（409）** —— 保留旧目录会让两套产出
 * 混在一起，换新目录会让旧产出原地失联，两种都不报错。
 */
app.post('/api/rooms/:hash/flow', rooms.bindFlowHandler(redis));

/**
 * 流程状态。返回 `roomGate`（比 flowStatus 多了 gate / can_advance / why）——
 * ★ 打开这个端点的时刻，人问的是**「为什么它不动」**，答案在 gate 里。
 */
app.get('/api/rooms/:hash/flow', rooms.flowStatusHandler(redis));

/**
 * 手工推进一格。⚠️ **这是整套流程里唯一会发派活消息的地方**（先不做自动触发）。
 * `advanced:false` 返回 200 —— 「它还在干」是正常状态，不是请求错误。
 */
app.post('/api/rooms/:hash/advance', rooms.advanceHandler(redis));

// ── 任务图 ──────────────────────────────────────────────────────
//
// ★ handler 和调度逻辑全在 `lib/graph-runner.js`（判据在 `lib/graph.js`），这里只挂载 ——
//   理由同上面 rooms 那几条：bin/ 的入口脚本测不到。
// ★ 挂在鉴权闸门**之后**（上面 `app.use('/api', busAuth.requireAuth)`）：读要登录；
//   起图 / 批 / 重派 / 放弃要 `can_manage_workers` —— 起一张图会派活、花额度。
// ⚠️ 推进**不靠任何人来调**：下面 server.listen 回调里有一个 interval（跟 watchdog 同一种挂法）。
//   对比 `rooms.advance`：只有一个 HTTP 入口、靠编排者记得去调 —— 编排者压缩之后流程就安静地停住。
const graphs = graphRunner.createRunner({
  redis, orchName: ORCH_NAME, graphsRoot: GRAPHS_ROOT, repoRoot: ROOT,
  // ★ 没写 verify 的节点 ⇒ `bin/verify-complete.js --graph-node <图目录> <节点>`
  //   （核产出 ＋ 节点目录里可选的 EVIDENCE.json）。命令由这里拼，参数单引号转义 —— 图目录来自 redis。
  //   PLAN.json 里写了 verify 的节点照旧只认它（md5 冻结那条不变）。
  defaultVerify: verifyLib.graphDefaultVerify({ root: ROOT, graphsRoot: GRAPHS_ROOT }),
  onLog: (m) => console.log(m),
});
app.get('/api/graphs', graphs.listHandler());
app.get('/api/graphs/:id', graphs.getHandler());
app.post('/api/graphs', busAuth.requireManage, graphs.startHandler());
app.post('/api/graphs/:id/approve', busAuth.requireManage, graphs.approveHandler());
app.post('/api/graphs/:id/retry/:node', busAuth.requireManage, graphs.retryHandler());
app.post('/api/graphs/:id/cancel', busAuth.requireManage, graphs.cancelHandler());

app.post('/api/rooms/:hash/post', async (req, res) => {
  // ★ `reply_to` 可选：不传 = 顶层发言（既有行为，老客户端零改动）。
  // ★★ `from` 取主体、盖人类的章 —— 理由同 `/api/message`。
  //   ⚠️ 房间里 Patrick 的话**照样是 principal**：信任按作者定，不按通道定
  //   （「房间发言一律 data」在这里不成立 —— 人大量在房间里说话）。
  const { text, reply_to = null } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const r = await rooms.post(redis, req.params.hash, {
      from: req.principal.username, text, reply_to, stampFields: stamp.HUMAN(req.principal),
    });
    // 同上，房间这条（scope = room:<hash>，锚点 = 房间流 stream id）。永远不抛。
    await threadCount.recordAndAlert(redis, { scope: threadCount.roomScope(r.hash), id: r.id, reply_to: r.reply_to, from: r.from, sender_type: 'human' }, { onEvent: (e) => console.log(`[thread-count] ${JSON.stringify(e)}`) });
    res.status(202).json({ accepted: true, ...r });
  } catch (e) {
    res.status(e.message.includes('不存在') ? 404 : 503).json({ error: e.message });
  }
});

/**
 * 房间历史。**没有它，房间界面打开就是空的** —— 流里的话一条都读不出来，
 * 只有连上 WS 之后新说的才看得见。
 *
 * ★ handler 整个在 `lib/rooms.js` 里，这里只有挂载。理由跟 `/api/agents`
 *   用 buildAgentsPayload 一样，只是更进一步：这个端点的全部价值是
 *   **「房间不存在 → 404，不是 200 + 空数组」**，而那件事只有真走一遍 HTTP
 *   才验得到。写在这个回调里的话，唯一能验它的办法是起一个真 bus ——
 *   **而 bus 一起来 watchdog 就会对着真 agent 发恢复指令。**
 */
app.get('/api/rooms/:hash/history', rooms.historyHandler(redis));

/**
 * 房间成员编辑。`{"add":["dev"],"remove":["dev2"]}`，两个都可省。
 *
 * ★ **不拒绝把人加进成员表** —— 成员表混着「路由」和「展示」两个用途，
 *   人需要在展示里、不该在路由里。拒绝加入等于用路由的理由否决展示需求。
 *   修的是扇出（下面 `fanOutRoom` 的 `routable` 过滤），不是这个端点。
 *   响应里的 `no_inbox` 说清谁只靠广播收消息。
 */
app.post('/api/rooms/:hash/members', rooms.membersHandler(redis));

// ── thread 合并（手动，可撤销）─────────────────────────────────────
//
// ★ 判据和存储全在 `lib/thread-merge.js`，这里**只有挂载行** —— 同上面那条。
//
// ★ 合并表本身不另开读端点：它跟着 `GET /api/rooms/:hash/history` 一起回
//   （`historyPayload` 里的 `merges`）。分两次请求的话，中间有人合并就会让
//   前端拿到一批消息配一张对不上的表 —— **错配的表不报错，只会把话题画错位置。**
app.post('/api/rooms/:hash/threads/merge', threadMerge.mergeHandler(redis));
app.delete('/api/rooms/:hash/threads/merge/:from', threadMerge.unmergeHandler(redis));

// ── emoji 反应 ────────────────────────────────────────────────────────
//
// ★ 判定、语义表、存储全在 `lib/reactions.js`，这里**只有挂载行** ——
//   跟上面 rooms 那几条同一条理由：这些端点的价值全在状态码上
//   （非法 scope→400、已结账的动作→409、不存在的 pending→404），
//   而状态码只有真走一遍 HTTP 才验得到。
//
// ⚠️ **顺序**：`semantics` / `pending` 这两条固定路径必须排在
//   `:scope/:anchor` 前面。眼下不排也不会撞（那两条只有一段路径，
//   而 `:scope/:anchor` 要两段），**但那是当前路由形状的巧合，不是约束** ——
//   将来谁把它改成 `:scope/:anchor?` 或加一层可选段，`pending`
//   就会被当成一个 scope 吞掉，而症状是「待确认列表突然空了」，零报错。
app.get('/api/reactions/semantics', reactions.semanticsHandler());
app.post('/api/reactions/batch', reactions.batchHandler(redis));
app.get('/api/reactions/pending', reactions.listPendingHandler(redis));
app.post('/api/reactions/pending/:id/confirm', reactions.confirmHandler(redis));
app.post('/api/reactions/pending/:id/cancel', reactions.cancelHandler(redis));
app.get('/api/reactions/:scope/:anchor', reactions.listHandler(redis));
app.post('/api/reactions/:scope/:anchor', reactions.addHandler(redis));
app.delete('/api/reactions/:scope/:anchor', reactions.removeHandler(redis));

/**
 * 私聊历史。用途是**复盘**：「某个 agent 掉册时，停摆期间发给它的消息去哪了」。
 *
 * ★ 真读流，不是内存缓冲 —— 那种复盘往往发生在**重启之后**，
 *   而缓冲重启就没了：一个只在进程活着时有效的历史，恰好在最需要它的
 *   时刻是空的。
 *
 * ★ 名字不在花名册**照查** —— 掉册的那个恰恰是最该查的那个。
 *   判定和覆盖范围都在 `lib/messages.js`，那里有注释讲为什么。
 */
app.get('/api/messages', messages.handler(redis));

/**
 * 顶栏的「测试」格和「commit」格。
 *
 * ★★ 它的全部价值是那个**过期判定**：只显示「983/0 · 12 分钟前」，
 *   人还是会读成「现在是绿的」；显示「跑在 <旧 sha>，HEAD 已经是 <新 sha>」，
 *   人一眼看出这个数字不管当前代码。
 *
 *   > **一个过期的绿，比没有数字更危险 ——**
 *   > **没有数字的时候人会去跑一遍，看到绿的时候不会。**
 *
 * ⚠️ **它不跑测试，只读 `results/last-run.json`。** 页面 5 秒一刷，
 *   跑一次几分钟 —— 那会把 bus 拖死，而「每次刷新都在跑测试」本身就是个事故。
 */
app.get('/api/status', status.handler({ redis }));

/**
 * 队列**条目**（面板用）—— 按收件人分组，每条带能不能撤回的状态。
 *
 * ★★ **一个端点喂两个展示位**：agent 卡片旁的「排队 N · 在手 M」和
 *   hover 展开的条目列表。为各自方便造两个端点的话，两边的数**会分叉**，
 *   而分叉时没有任何东西会红 —— 卡片说 3 条、展开列表 4 条，
 *   人只会以为自己看花了。
 *
 * ⚠️ 判定逻辑全在 `lib/queue-items.js`（可测），这里**只挂路由 + 调它**。
 *   理由不只是「不用等 bus 重启就能测」——**长在 bin/ 里的判定
 *   结构上没有防线**（`relayPlan` 那段注释讲的是同一件事）。
 */
/**
 * 撤回一条队列条目。
 *
 * ★★★ **「只有未投递的才能撤」这条规则的机制在服务端，不在前端。**
 *   前端对已投递的条目不渲染按钮 —— 那是给人看的那一半。
 *   一次前端 bug、一条手写 curl 都能绕过它，而绕过的后果正是这个功能
 *   要防的那个：**人以为撤回了，agent 照常干完。**
 *
 * ⚠️ 判定和删除合在 `queueItems.cancelItem()` 里（判定在前）——
 *   拆成「先查状态、再调删除」会开一个窗口：agent 正好在两步之间领走它。
 */
// ★ 生命周期动作 ⇒ `requireManage`（没有 can_manage_workers ⇒ 403）。
app.post('/api/queue/cancel', busAuth.requireManage, async (req, res) => {
  const { stream, id, group = null } = req.body || {};
  if (!stream || !id) {
    return res.status(400).json({ error: 'stream and id required' });
  }
  try {
    const r = await queueItems.cancelItem(redis, String(stream), String(id), group);
    // ★ 409 而不是 400：请求本身没写错，是**这条的状态不允许**。
    //   两者对人的含义不同 —— 前者「你写错了」，后者「你来晚了」。
    if (!r.ok) return res.status(r.state === 'in_flight' ? 409 : 400).json(r);
    res.json(r);
  } catch (err) {
    res.status(503).json({
      error: 'QUEUE_UNAVAILABLE', message: String(err.message || err),
      next: '看 /health 里 redis 死活。**撤回失败时那条消息还在队列里**，没有被删掉。',
    });
  }
});

app.get('/api/queue/items', async (_req, res) => {
  try {
    res.json(await queueItems.listAll(redis, { count: 100, orchName: ORCH_NAME }));
  } catch (err) {
    redisHealthy = false;
    // ★ 带 `next` —— 「诚实但无用」的错误消息会让人卡在原地。
    res.status(503).json({
      error: 'QUEUE_UNAVAILABLE',
      message: String(err.message || err),
      next: '看 /health 里 redis 死活；队列条目读不出来**不代表队列是空的**。',
    });
  }
});

/**
 * agent 产出的文档。**「落盘了」对 agent 是完成，对人是一个够不到的地方。**
 *
 * ★★ 这两个端点的全部风险在**路径穿越**，判定在 `lib/docs.js`：
 *   **「解析后的真实路径必须在 docs/ 里面」**，不是「字符串里没有 `..`」。
 *   而且 403（拒绝）和 404（没找到）分开 ——
 *   **混成一个的话，被拒绝的人会以为文件名写错，然后去找一个不存在的问题。**
 *
 * ⚠️ Express 5 的通配符必须命名（`*splat`），`req.params.splat` 是数组。
 */
/**
 * agent 的产出物。
 *
 *   GET /api/outputs                列出所有 job 和它们的文件
 *   GET /api/outputs/:job/:file     取一个文件
 *
 * ★ 文件从哪来：**扫约定目录 `outputs/<job_id>/`**，不是从消息元数据里带。
 *   理由：「一个编出来的 45% 比没有进度更糟」——
 *   **文件在磁盘上是事实，元数据是声明，而声明会跟事实分叉。**
 *   判据和「生成中」怎么判都在 `lib/outputs.js`。
 *
 * ⚠️ 路径穿越判定跟 `/api/docs/*` 同一套顺序（resolve → relative →
 *   realpath → relative），而 403/404 **必须分开** ——
 *   混成一个的话，被拒绝的人会以为文件名写错，然后去找一个不存在的问题。
 */
app.get('/api/outputs', (_req, res) => {
  try {
    res.json(outputs.listAll({ root: OUTPUTS_ROOT }));
  } catch (err) {
    res.status(500).json({
      error: 'outputs_list_failed',
      message: String(err.message || err),
      next: '这不是「没有产出」，是「列不出来」。看一眼 outputs/ 目录的权限。',
    });
  }
});

app.get('/api/outputs/:job/:file', (req, res) => {
  try {
    const real = outputs.resolveFile(req.params.job, req.params.file, { root: OUTPUTS_ROOT });
    res.sendFile(real);
  } catch (err) {
    const map = { BAD_JOB_ID: 400, OUT_OF_SCOPE: 403, NOT_FOUND: 404 };
    const code = map[err.code] || 500;
    res.status(code).json({
      error: err.code || 'outputs_read_failed',
      message: String(err.message || err),
      // ★ 403 和 404 给不同的下一步 —— 那正是把它们分开的全部理由
      next: code === 403 ? '这条路不许走（不是文件名写错）。'
          : code === 404 ? '这个 job 目录下没有这个文件 —— 可能还在生成（.partial）。'
          : null,
    });
  }
});

app.get('/api/docs', docs.listHandler());
app.get('/api/docs/*splat', docs.readHandler());

// 静态托管。放在所有 `/api/*` 之后 —— 顺序无所谓（static 只回应真实存在的
// 文件），但排在后面能保证将来加的路由不会被一个同名文件悄悄遮住。
app.use(express.static(WEB, { index: 'index.html', extensions: false }));

// ── WebSocket ───────────────────────────────────────────────────
const server = http.createServer(app);
// ★ upgrade 时就校验（verifyClient），失败**拒绝 upgrade**（401）——
//   不是「连上再踢」：`connection` 回调第一件事就是加进广播集合，
//   连上那一拍它已经能收到所有人的回复了。
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: busAuth.verifyClient });

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', service: 'engloop-bus' }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ── 出向：消费 orch:out，推给所有 WS 客户端 ──────────────────────
async function deliverLoop() {
  const consumer = `bus-${process.pid}`;
  for (;;) {
    try {
      const msgs = await q.claimNext(blocking, {
        streams: OUT, group: OUT_GROUP, consumer, blockMs: 5000, count: 20,
      });
      redisHealthy = true;
      for (const m of msgs) {
        // ★★ `reply_to` 必须跟着走 —— 这里的字段是手工列的，跟 room_message 那条
        //   （`room_hash`、`reply_to`）是同一类容易漏的地方。
        //   漏掉的后果：实时推送里这条显示成顶层，而刷新页面（走
        //   `/api/messages`）之后它又摞回去了。**刷新前后不一致最难查，
        //   因为两边各自都「能用」。**
        //
        //   ⚠️ `job_id` 这里就是私聊 thread 的**锚点**（前端 web/app.js
        //   拿它当 `id` 用）。不要再加一个 `id: m.id` —— 那是
        //   `orch:out` 的 stream id，跟 `orch:in:human` 的会撞。
        broadcast({ type: 'message', from: m.from, text: m.text, job_id: m.job_id,
          // ★★ `kind` 必须跟着走 —— **「手工白名单会漏字段」的又一处**。
          //   漏了它，agent 标的 notice 在实时推送里退化成普通消息，
          //   而**刷新页面（走 /api/messages）之后又变回通知** —— 刷新前后不一致，
          //   两边各自都「能用」，最难查。
          at: m.timestamp, reply_to: m.reply_to || null, kind: m.kind || null,
          // ★★ `done` 必须跟着走 —— 漏掉它的症状比漏别的字段都轻微，
          //   所以更容易被放过：
          //   通知不弹。没有红标签、没有错位、刷新也变不出来 ——
          //   人只会觉得「这次它没报完成吧」。
          //
          //   ⚠️ 流里读出来是**字符串** `'true'`（`lib/queue.js` 读流时全过
          //   `String(v)`），所以必须过 `threads.isDone()` 而不是 `m.done`：
          //   原样透传的话前端拿到 `'true'`，只要哪个读者写了 `=== true`
          //   就静默失效。**在这里判成布尔，下游拿到的就是一个干净的事实。**
          done: threads.isDone(m), verify: m.verify || null,   // verify：完成报告核没核过（前端据此决定通知弹不弹、写不写「未验证」）
          needs_decision: threads.needsDecision(m),   // 判成布尔；流里是字符串 'true'
          // sender_type：stamp 的章，给前端认核验跟帖（system）、「需要你」认「人类回过了」。
          //   原样透传，没有就是 null；字段名从 lib/stamp.js 取，不写死。
          [stamp.SENDER_FIELD]: m[stamp.SENDER_FIELD] || null });
        await q.ack(redis, OUT, OUT_GROUP, m.id);
      }
    } catch (err) {
      redisHealthy = false;
      broadcast({ type: 'error', error: 'QUEUE_UNAVAILABLE', message: String(err.message || err) });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ── agent → 编排者 的私聊也要推到浏览器 ──────────────────────────
//
// ★★★ **为什么非加不可**：`deliverLoop` 只读 `orch:out`（编排者发出的那条流）。
//   而 agent 发给编排者的消息走 `orch:in:agent` —— **结构上不经过任何 broadcast**。
//
//   不推的话：agent 报「任务完成」标了 `done`，relay 把 🏁 打上了
//   （那是后端做的、落盘的），**而人的桌面通知一次都不弹** ——
//   因为那条消息从来没到过浏览器，要翻到那个 agent 的频道才看得见。
//
//   ⚠️ 只测「编排者转达」那条路径（`orch:out`）的断言会全绿 —— 它跟真正要测的那条**平行**。
//   **绿灯会跑在 bug 的旁边**：
//   阴性对照证明的是「不该弹时不弹」，它对「该弹时弹了」一点鉴别力都没有。
//
// ★ 用**独立的消费者组**，跟编排者自己的 `orch` 组互不干扰 ——
//   Redis 消费者组各自维护游标，这里读走一条**不会**让编排者少收一条。
const CREW_IN = 'orch:in:agent';
const CREW_IN_GROUP = 'bus-agent-in';

async function crewInLoop() {
  const consumer = `bus-${process.pid}`;

  // ★★ group 必须从 `'$'` 建，**不能用 `q.ensureGroup`（它用 `'0'`）**。
  //   从 0 建的话，第一次启动会把整条流的历史全推一遍：人的屏幕上
  //   刷一屏几天前的旧消息，**而且每条带 done 的都会弹一个桌面通知**。
  //   ⚠️ 这个错只会在**第一次部署**那一瞬间发生，之后 group 已存在、
  //   位置也走过去了 —— 也就是说它**测不出来、只坑一次**，而那一次
  //   正好是使用者第一次看到这个功能。
  try {
    await redis.xgroup('CREATE', CREW_IN, CREW_IN_GROUP, '$', 'MKSTREAM');
  } catch (err) {
    if (!String(err.message).includes('BUSYGROUP')) {
      console.error('[bus] agent-in group 建不了：', String(err.message || err));
    }
  }

  for (;;) {
    try {
      const msgs = await q.claimNext(blocking3, {
        streams: CREW_IN, group: CREW_IN_GROUP, consumer, blockMs: 5000, count: 20,
      });
      for (const m of msgs) {
        // 字段跟 deliverLoop 那条**保持一致** —— 前端 `case 'message'` 是
        // 同一个分支处理这两条路径，少给一个字段就是两条路径行为分叉，
        // 而分叉的表现是「agent 的消息在界面上跟编排者的长得不一样」。
        broadcast({ type: 'message', from: m.from, text: m.text, job_id: m.job_id,
          at: m.timestamp, reply_to: m.reply_to || null, kind: m.kind || null,
          done: threads.isDone(m), verify: m.verify || null,   // verify：完成报告核没核过（前端据此决定通知弹不弹、写不写「未验证」）
          needs_decision: threads.needsDecision(m),   // 判成布尔；流里是字符串 'true'
          // sender_type：跟 deliverLoop 那条一致 —— 字段名从 lib/stamp.js 取。
          [stamp.SENDER_FIELD]: m[stamp.SENDER_FIELD] || null });
        await q.ack(redis, CREW_IN, CREW_IN_GROUP, m.id);
      }
    } catch (err) {
      // ⚠️ **不 broadcast QUEUE_UNAVAILABLE** —— deliverLoop 已经在报同一件事，
      //   两条循环同时喊会让界面上出现成对的红条，看起来像两个故障。
      console.error('[bus] agent-in 循环出错：', String(err.message || err));
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ── 入向：agent 写的 outbox 文件 → 流 ──────────────────────────────
//
// 每个 agent 一个子目录 temp/outbox/<name>/：
//   · from 从目录名推断，agent 无法伪造成别人
//   · ack 用它自己的消费者组
// 监听谁由下面的 syncRelays 按花名册定期重扫决定。
const relays = new Map();

// ── 优雅关停 ────────────────────────────────────────────────────
//
// 为什么记账器住在 bus 而不是 CLI 里：READY_TO_SHUTDOWN 是 agent 写的
// outbox 文件，而文件被 relay 读完就删了。relay 跑在 bus 进程内，
// 只有这里能看见那条消息。CLI 是另一个进程，它看不到，所以 --stop
// 只能来求 bus 代劳（POST /api/agents/:name/shutdown）。
//
// kill 是注入进去的，shutdown.js 自己不碰 tmux —— 测试里因此不存在
// 任何能杀死真会话的代码路径。
const shutdownTracker = shutdown.createTracker({
  kill: (session) => tmux.kill(session),
  // kill 之后回查事实 —— tmux.kill 的返回值有二义（会话本来就没了 vs kill 失败）
  exists: (session) => tmux.exists(session),
  onLog: (m) => console.log(m),
  onDone: async (rec) => {
    // 摘牌。不摘也行（TTL 会到期），但留着会让 relay 和路由多认它 15 分钟。
    await roster.unregister(redis, rec.name).catch(() => {});
    const r = relays.get(rec.name);
    if (r) { r.stop(); relays.delete(rec.name); }
    broadcast({
      type: 'shutdown',
      name: rec.name,
      outcome: rec.outcome,          // 'graceful' | 'timeout'
      detail: rec.detail || undefined,
      killed: rec.killed,
    });
    // 超时强杀必须留痕给人看见 —— 「它是自己走的」和「等不下去被强杀了」
    // 是两件事，混在一起会掩盖一个卡死的 agent。
    if (rec.outcome === 'timeout') {
      // ★ 文本由 lib/shutdown.js 的 timeoutAlertText() 生成 —— 它按
      //   **kill 之后的回查结果**决定说辞，而不是按「调用过那个函数」。
      //   放在 lib 里是为了可测（bin/ 的入口脚本没法被测试 require）。
      await q.send(redis, OUT, {
        from: 'bus', to: 'Patrick', agent_type: 'system',
        text: shutdown.timeoutAlertText(rec),
      }).catch(() => {});
    }
  },
});

setInterval(() => {
  shutdownTracker.tick().catch((e) => console.error('[shutdown] tick 失败:', e.message));
}, 10_000);

// 请求关停。立即 202 —— 等待是异步的，别把 HTTP 挂起（见文件头）。
// ★ requireManage：支持 `force`（等于 kill -9）的端点，而 agent 的 Bash 打得到 localhost。
app.post('/api/agents/:name/shutdown', busAuth.requireManage, async (req, res) => {
  const { name } = req.params;
  const { reason = '', force = false } = req.body || {};
  try {
    const rec = await roster.lookup(redis, name);
    if (!rec) return res.status(404).json({ error: `不在花名册: ${name}` });

    if (force) {
      const killed = await tmux.kill(rec.tmux_session);
      await roster.unregister(redis, name);
      return res.json({ mode: 'force', killed });
    }
    if (shutdownTracker.isPending(name)) {
      return res.status(409).json({ error: '已经在关停中', pending: shutdownTracker.list() });
    }

    // ★★ 查目标会话的 `created`，盖在这条关停指令上。
    //
    //   为什么在这里查而不是在 `lib/shutdown.js` 里查：那个模块**有意不碰
    //   tmux**（kill / exists 都是注入的，`test/shutdown.test.js` 有一条
    //   断言守着它不 require tmux）—— 自己去 exec tmux 的话，它就再也没法
    //   在没有 tmux 的环境里测。
    //
    // ⚠️ `tmux.list()` **查不了时会抛**（TMUX_UNAVAILABLE），不是返回 `[]` ——
    //   返回 `[]` 的话（比如 PATH 里没有 tmux），页面会一直显示
    //   「没有异常」，跟真的没有异常长得一模一样。所以这里 catch 成 null，
    //   让 requestShutdown 走「不盖章」那条路 —— **照发，但如实报告没盖上**。
    let targetSessionCreated = null;
    try {
      const s = (await tmux.list()).find((x) => x.name === rec.tmux_session);
      if (s && Number.isFinite(s.created)) targetSessionCreated = s.created;
    } catch (e) {
      console.error(`[shutdown] ⚠ 查不到 ${rec.tmux_session} 的会话标识（${e.code || e.message}）`
        + ' —— 这条关停指令不会盖章，收取侧会拒绝执行它。');
    }

    const sent = await shutdown.requestShutdown(redis, name, {
      reason, stream: rec.stream, targetSessionCreated,
    });
    // ★ 没盖上章是**一个需要人知道的事实**，不是内部细节：
    //   收取侧会因此拒绝执行，人得知道为什么关停「没反应」。
    if (!sent.stamped) {
      console.error(`[shutdown] ⚠ 发给 ${name} 的关停指令**没有会话标识** ——`
        + ' 收取侧会拒绝它。tmux 不可用？先修那个，或者用 force。');
    }
    shutdownTracker.request(name, rec.tmux_session);
    res.status(202).json({
      mode: 'graceful', name, session: rec.tmux_session,
      // ★ 一起返回给调用方（CLI / 页面）—— 让「为什么关不掉」在响应里就能看出来，
      //   而不是要人去翻 bus 的终端日志。
      session_stamped: sent.stamped,
      quiet_timeout_s: shutdown.QUIET_MS / 1000,
      hard_timeout_s: shutdown.HARD_MS / 1000,
    });
  } catch (err) {
    res.status(503).json({ error: 'QUEUE_UNAVAILABLE', message: String(err.message || err) });
  }
});

// CLI 轮询这个看走没走。不在 pending 里 = 已经结束（或从没开始）。
/**
 * 在线状态。**只读** —— 这个端点上不加任何操作（关停、重启）。
 * 「一眼看清状态」和「能动手」是两件事，后者要单独设计权限。
 *
 * ── 为什么这个端点必须存在 ──────────────────────────────────────
 * **失聪是这个系统最危险的故障，而它的表现是「一切看起来正常，只是没人
 * 说话」。人唯一能察觉它的地方就是在线列表** —— 没有它，
 * 页面上看不出谁在线、谁掉册了。
 *
 * 失聪时外部信号往往只有「掉册」这一个，人得看得到它。
 * watchdog 是自动那条路（它自己也会瞎），**这是人工那条路。
 * 两条都要有。**
 *
 * ★ 判定直接用 watchdog.check() —— 它内部走 classifySessions()，
 *   跟 watchdog 自己的判定**是同一份实现**。页面和 watchdog 各算一遍的话，
 *   两边迟早不一致，**而不一致的时候没人会发现**（它们各自都「正常」）。
 */
app.get('/api/agents', async (_req, res) => {
  try {
    const [probe, registry, drops] = await Promise.all([
      watchdog.check(redis),
      roster.list(redis),
      // ★ 掉册留痕。**自愈成功是最容易被彻底遗忘的那种事故** ——
      //   掉册被自愈救回时，警告只打在 agent 自己的终端里，
      //   界面上一个字都没有。不留痕的话，除非人恰好来问，它不会留下任何痕迹。
      roster.dropouts(redis, 5),
    ]);
    // 组装逻辑在 lib/watchdog.js 里 —— bin/ 的回调没法被测试看见，
    // 而这是对外声称「谁在线」的地方，必须有守卫。
    //
    // ★ `sessionsSeen` 必须一起传：没有它的话，「三格全空」和「一切正常」
    //   在这个响应里长得一模一样。
    const payload = watchdog.buildAgentsPayload(
      probe.findings, registry, Date.now(), probe.sessionsSeen);

    // ★ 离线但可开启的 agent。**两个既有数据源都只看得见「已经存在的」**，
    //   所以一个没起的 agent 在界面上根本不存在 —— 起它只能去终端。
    //
    // ⚠️ `source: 'agents-dir'` 必须跟着走（标注来源）：
    //   这份清单是**扫目录**扫出来的，不是谁声明的。
    //   目录 ≠ 意图，人得知道自己在看一份推断出来的名单。
    const candidates = catalog.scan();
    payload.offline_candidates = catalog.offline(candidates, registry);
    payload.offline_source = catalog.SOURCE;
    // ★★ 每次都拿花名册给「正在起」的记录结账 —— agent-start 退出码 0
    //   不等于它在册。不结账的话，「正在起」和「起完了但没上线」
    //   在界面上是同一个样子：都是「它还没出现」。
    payload.launching = launch.settleAgainstRoster(registry);
    payload.dropouts = drops;

    res.json(payload);
  } catch (err) {
    // ★ 「查不了」要说成「查不了」，不能降级成一份空列表。
    //   这个端点存在的全部目的就是让人一眼看出失聪 —— **它自己坏了的时候，
    //   返回空三格等于对着人说「一切正常」。**
    if (err.code === 'TMUX_UNAVAILABLE') {
      return res.status(503).json({
        error: 'tmux_unavailable',
        message: err.message,
        detail: '看不到 tmux 会话列表，所以**无法判断谁在线** —— '
              + '这不是「没有 agent」，是「查不了」。',
        hint: 'bus 多半是 nohup/launchd 起的，PATH 里没有 tmux（通常在 /opt/homebrew/bin）。',
      });
    }
    res.status(500).json({ error: 'agents_probe_failed', message: err.message });
  }
});

/**
 * 从界面开启一个离线的 agent。
 *
 * ⚠️ **这个动作花额度**（一次点击 = 一个新的 claude 会话）。所以它是 POST、
 *   要人主动点，而且 `lib/agent-ui-start.js` 里没有任何自动触发路径 ——
 *   不重试、不「检测到离线就起」。跟「派活前先请示」是同一条规矩。
 *
 * ★ 202 不是 200：起一个 agent 要等 TUI 就绪（最长 90 秒），这里只是**受理**。
 *   真结果去 `/api/agents` 的 `launching` 字段看 —— 那边拿花名册结账。
 */
app.post('/api/agents/:name/start', busAuth.requireManage, async (req, res) => {
  try {
    const registry = await roster.list(redis);
    const r = launch.start(req.params.name, { candidates: catalog.scan(), registry });
    if (!r.ok) {
      // 400 而不是 500：这几种全是「你要起的东西不对」，不是服务器坏了。
      return res.status(400).json({ error: r.code, message: r.message });
    }
    res.status(202).json({
      accepted: true, name: r.name, type: r.type,
      detail: '已受理。起一个 agent 最长约 90 秒 —— '
            + '真结果看 /api/agents 的 launching 字段，那边以花名册为准。',
    });
  } catch (err) {
    res.status(500).json({ error: 'launch_failed', message: String(err.message || err) });
  }
});

app.get('/api/agents/:name/shutdown', async (req, res) => {
  const { name } = req.params;
  const pending = shutdownTracker.isPending(name);
  const alive = await roster.lookup(redis, name).catch(() => null);
  res.json({ name, pending, still_registered: Boolean(alive) });
});

// ── 完成核验：relay 看到带 evidence 的 done ⇒ 打 ⏳、起 detached 子进程核、子进程自己落结果 ──
//   一个 bus 一个 launcher，所有 relay 共用（它没有状态，只有配置）。
const doneVerifier = doneVerify.createLauncher({
  redis, orchName: ORCH_NAME, cacheRoot: VERIFY_CACHE, root: ROOT,
  onLog: (m) => console.log(m),
});

function relayFor(name, ackGroup) {
  const dir = path.join(OUTBOX, name);
  return startRelay({
    outboxDir: dir,
    from: name,
    redis,
    ackGroup,
    doneVerifier,
    // ★★ 漏挂告警目录（见文件头那张隔离表 ⑦）。**这一行就是「生产调用方要传」的那一半**：
    //   `threadAlertDir` 参数是为了防污染，测试调用方和生产调用方两侧都要传。
    //   隔离模式下不传，e2e 的隔离 bus 就会把假告警写进真 agent 的状态文件
    //   （被假告警刷过几轮，agent 就学会忽略那个告警）。
    threadAlertDir: THREAD_ALERT_DIR,
    onEvent: (e) => {
      // ★ agent 写出任何一个文件都是「它还活着」的证据 —— 重置静默计时器。
      // 关停等待的主判据是生命迹象而不是墙钟：一个正在跑测试、还没读到
      // 关停请求的 agent 是忙，不是聋，不该被当成卡死杀掉。
      shutdownTracker.activity(name);

      if (e.type === 'shutdown_ready') {
        console.log(`[shutdown] ← ${name} 说 ${shutdown.SENTINEL}`);
        shutdownTracker.ready(name).catch((err) => console.error('[shutdown]', err.message));
        return;
      }
      if (e.type === 'sentinel_misplaced') {
        console.error(`[shutdown] ⚠ ${name} 消息中间出现 ${shutdown.SENTINEL}，不触发；`
                    + `已${e.bounced ? '回弹纠正' : '尝试回弹但它不在花名册'}`);
        return;
      }

      // 所有事件都要落日志。漏掉 ack_noop / ack_failed 的话，
      // ack 静默不生效时日志里一片正常，查不出原因。
      if (e.type === 'error' || e.type === 'parse_error' || e.type === 'deadletter') {
        console.error(`[relay:${name}] ✗ ${e.type}`, e.file || '', e.error || e.reason || '');
      } else if (e.type === 'ack_failed') {
        console.error(`[relay:${name}] ✗ ack_failed id=${e.id} ${e.error}`);
      } else if (e.type === 'ack_noop') {
        console.error(`[relay:${name}] ⚠ ack 没生效（XACK 返回 0）stream=${e.stream} id=${e.id} group=${e.group}`);
      } else if (e.type === 'acked') {
        console.log(`[relay:${name}] ✓ ack ${e.stream} ${e.id}`);
      } else if (e.type === 'relayed') {
        console.log(`[relay:${name}] → ${e.stream}`);
      } else {
        console.log(`[relay:${name}] ${e.type}`, JSON.stringify(e).slice(0, 120));
      }
    },
  });
}

async function syncRelays() {
  try {
    const agents = await roster.list(redis);
    // ★ 「谁该挂、谁该摘」的判定**只有一份实现**，在 lib/relay.js 的 planRelays()。
    //   这里只照着算好的计划动手 —— 别在这个回调里重算一遍，那正是
    //   「抽公共函数的动作本身制造第二份实现」那个坑。
    const { add, remove } = planRelays({
      agents, current: relays.keys(), orchName: ORCH_NAME,
    });

    for (const [name, group] of add) {
      relays.set(name, relayFor(name, group));
      console.log(`[bus] 挂上 relay: ${name} (ack 组 ${group})`);
    }
    for (const name of remove) {
      relays.get(name).stop();
      relays.delete(name);
      console.log(`[bus] 摘掉 relay: ${name}（已不在花名册）`);
    }
  } catch (err) {
    console.error('[bus] syncRelays 失败:', err.message);
  }
}

syncRelays();
setInterval(syncRelays, 15000);

// ── 房间扇出 ────────────────────────────────────────────────────
// 房间流是历史真相；bus 消费它并分发到各参与者的收件流。
// 这样 agent 侧零改动（收件接口不能动），只是消息多了 room_hash。
const roomConsumers = new Map();

async function fanOutRoom(hash) {
  const meta = await rooms.get(redis, hash);
  if (!meta) return;
  const st = rooms.stream(hash);
  const group = 'bus-fanout';
  const msgs = await q.claimNext(blocking2, {
    streams: st, group, consumer: `bus-${process.pid}`, blockMs: 100, count: 20,
  }).catch(() => []);

  // 没消息就别往下走 —— 下面那次 roster.list 是每 2 秒 × 每个房间一次，
  // 而绝大多数 tick 是空的。
  if (!msgs.length) return;

  // ★ 谁有自己的收件流。**没有的不扇出** —— 广播已经把消息推到浏览器了，
  //   再往 `orch:out` 投一份会被 deliverLoop 消费并 broadcast **第二次**，
  //   同一句话在人的屏幕上出现两遍。
  //
  //   ⚠️ 花名册查不了时传 `null`（= 不过滤，退回旧行为）。**不能当成
  //   「谁都没有收件流」** —— 那会让所有 agent 在 redis 抖一下时集体收不到
  //   房间消息，而且没有任何报错。**「查不了」不许降级成一个具体答案。**
  const registry = await roster.list(redis).catch(() => null);
  const routable = registry === null ? null : new Set(registry.map((a) => a.name));

  for (const m of msgs) {
    // ★ 分发计划来自 `rooms.fanOutPlan()`（纯函数，可测）。**广播和扇出的
    //   成员表不一样**：扇出跳过发言者，广播不跳 —— 浏览器前面坐的是人，
    //   人要看到房间里的全部发言，包括自己刚发的那条。
    //   两条规则要是共用同一个 `continue`，
    //   后果是「自己说的话在自己屏幕上不出现」，看起来像发丢了。
    const plan = rooms.fanOutPlan(meta, m, routable);

    // ★ 广播排在扇出**之前**：它是纯内存操作、不会失败，而扇出要走 redis
    //   和 roster 查询。扇出中途抛错时这条已经推给人了 —— **人看得见「房间
    //   里说了这句话」，这比一致地什么都看不见更接近真相。**
    //   （房间流才是历史真相；界面刷新会从 /api/rooms/:hash/history 重读，
    //     所以这里丢一条比重一条更糟。）
    broadcast(plan.broadcast);

    for (const d of plan.deliveries) {
      const rec = await roster.lookup(redis, d.member);
      const target = rec ? rec.stream : 'orch:out';
      await q.send(redis, target, {
        from: m.from,
        to: d.member,
        text: d.text,
        agent_type: 'room',
        job_id: m.job_id,
        room_hash: hash,
        // ★★ `room_msg_id`：**这条发言在房间流里的 id** —— agent 想回它的
        //   thread 时，`reply_to` 要填的就是这个。
        //
        //   ⚠️ 不能让 agent 用它收到的那个 `stream_id` 顶替：那是**它自己
        //   收件流**的 id（`q.send` 新生成的），跟房间流不是同一个 id 空间。
        //   填错了不会报错 —— 只会挂在一条不存在的父消息上，
        //   于是那条回复被当成顶层显示。**和漏填的表现一模一样。**
        //
        //   ★ 字段名不叫 `id`：这个 payload 里 `id` 已经被 q.send 用掉了，
        //   同名两义就是「一个名字指两样东西」的坑。
        room_msg_id: m.id,
        // ★★ 章跟着走 —— 房间流里那条的 `sender_type` / `can_manage_workers`
        //   **原样**带到每个收件人的收件流。漏了它，人在房间里的话到 agent 那边
        //   就成了 `trust:"data"`，**零报错**（这个 payload 是手工白名单，见上面几条）。
        ...stamp.pick(m),
        // ★ `reply_to`：这条发言**自己**挂在哪条下面（顶层发言没有这个字段）。
        //   缺了它，agent 拿得到 room_msg_id 能发 thread，却看不见自己收到的
        //   这条属于哪个 thread —— 想接着说只能拿手上这条当父，**每层新开一支**。
        //   ⚠️ 而它发出去的回复是合法的、也进了某个 thread，只是不是它以为的那个。
        //
        //   ⚠️⚠️ 这一行和 `bin/next.js` 那一行是**串联的两个缺口**：
        //   只补一个，现象跟没补一模一样（agent 那边仍然看不到）——
        //   而「修对了一半」和「没修」在观测上完全相同，
        //   于是第一个动手的人会判自己修错了。两处必须一起验。
        ...(m.reply_to ? { reply_to: m.reply_to } : {}),
        // ★★ `expects_reply`（防广播风暴）——
        //   **这是 agent 那一侧唯一能看到的「这条要不要回」。**
        //
        //   值来自 `plan.deliveries`，不是在这里现算：判据只有
        //   `rooms.expectsReply()` 一处，而那个纯函数是被测过的。
        //   在这里写第二个 `if` 就是又开一个会分叉的出处。
        //
        //   ⚠️ **不能写成 `...(d.expects_reply ? {...} : {})`** ——
        //   那样「不要求回复」的时候字段整个消失，而字段消失和
        //   「这是个老版本、压根没有这个概念的消息」在收件人眼里一模一样。
        //   **默认必须是一个说出口的 false，不是一个沉默的缺席。**
        //   （room_hash / reply_to 用条件展开是对的：那两个缺席就是「没有」，
        //     这个字段缺席却要靠收件人猜默认值 —— 语义不同，写法就不同。）
        //
        //   ⚠️ 进 redis 会被 `String()` 成 `'false'`，而 `'false'` 是 truthy。
        //   收件方**必须**用 `rooms.expectsReply()` 判，不许自己写 `if`。
        expects_reply: d.expects_reply === true,
      });
    }
    await q.ack(redis, st, group, m.id);
  }
}

async function roomTick() {
  try {
    for (const h of await redis.smembers(rooms.INDEX)) {
      await fanOutRoom(h);
    }
  } catch (err) {
    console.error('[rooms] 扇出失败:', err.message);
  }
}
setInterval(roomTick, 2000);

// ── worker 池 ───────────────────────────────────────────────────
// resident tier 是常驻会话；worker 是 episodic —— 领一个活、干完、退出。
// 每种类型一个池，semaphore 限并发（起步值 2）。
//
// mode 默认 'print'（按技术优劣选）。
// 要换回 tmux 模式：ENGLOOP_WORKER_MODE=tmux
// ⚠️ `.filter(Boolean)` 不是防御性代码，防的是一个真坑：
//   `''.split(',')` 返回 `['']` —— 所以设 ENGLOOP_WORKER_TYPES='' 想关掉 worker，
//   实际会起一个 `type: ''` 的池，去 `workers/` 这个目录里找一个不存在的模板。
//   **「关掉」和「起了一个坏的」在启动日志上几乎看不出区别。**
//   隔离模式需要真能关掉它（一个测试 bus 不该去烧 claude 额度）。
const WORKER_TYPES = (process.env.ENGLOOP_WORKER_TYPES ?? 'eval')
  .split(',').map((s) => s.trim()).filter(Boolean);
// ★ **每个池一条自己的连接** —— 池内部用 `claimNext(..., blockMs:5000)` 领任务，
//   那是阻塞命令，会独占整条连接。
//
//   不是「共用一条新的」：多个池各自阻塞，共用还是会互相排队。
//   池内部自我阻塞可以接受 —— 它的 reply/ack 最多等 5 秒，
//   **而那不影响 HTTP，HTTP 才是要保护的东西。**
//
//   传主连接会当场抛错（`nonBlockingOnly` 守着）—— 这正是那个守卫的用途：
//   **让「谁能阻塞」从注释变成机制。**
const poolClients = WORKER_TYPES.map(() => q.createClient());
const pools = WORKER_TYPES.map((t, i) => startPool(poolClients[i], {
  type: t.trim(),
  concurrency: Number(process.env.ENGLOOP_WORKER_CONCURRENCY || 2),
  cwd: path.join(ROOT, 'workers', t.trim()),
  onLog: (m) => console.log(m),
}));

// ── 失聪看门狗 ──────────────────────────────────────────────────
// 用**服务端事实**判断 agent 是否还在读队列，而不是靠它自己汇报。
// 依赖 agent 自己排 cron 的活性检测，agent 聋了它也跟着聋。
//
// 注意它治不了根：「大脑就是不再调用 poll」是提示词遵从问题，
// 没有任何队列能修好。这里只做检测 + ESC 推一把 + 上报。
//
// ★ `onEvent` 是 watchdog 说给**人**听的出口，`onLog` 是说给日志听的。
//
//   只有 onLog 的话：bus 是 detached spawn 起来的，那个 console
//   进了一个没人看的日志文件 —— **watchdog 每一次判定，人都收不到**，
//   除非它够到 alert 档位走 q.send。中间那些（busy / warn / heartbeat_lost /
//   冷却中没动手）**只存在于日志里**，而那几档恰恰是「现在该不该管它」
//   最需要人来判断的时候。
//
//   事件带 `at` 和 `level`：界面把它跟 agent 的发言按时间交织排在同一条流里，
//   **而那个时序关系是判断因果的唯一线索**。
// ★★ 隔离模式下换掉 tmux 出口 —— 这是隔离里唯一会直接操作生产会话的一处。
//
//   一个连着**测试 redis** 的 watchdog，会枚举到**真的** tmux 会话
//   （tmux 不分测试库），发现 orch 在跑但测试库的花名册里没有它 →
//   判失聪 → `tmuxApi.submit(orch, 恢复指令)` → **往真编排者的会话里打字**。
//
//   > **一个隔离得不彻底的测试环境，会去操作生产会话。**
//
// ★ 为什么是「换成假的」而不是「关掉 watchdog」：
//   关掉的话，隔离环境里这段逻辑就没跑过 —— **而「没跑」和「跑了没事」
//   在结果上长得一样**。
//   换成 no-op 让它照常跑完整个判定链，只是最后那个出口不通到真会话。
//
//   `watchdog.start` 本来就接 `tmuxApi`（为了测试可注入），
//   这里只是把它接上 —— 不是新开口子。
const NOOP_TMUX = {
  list: () => [],          // 枚举不到会话 → 一个 agent 都不会被判失聪
  exists: () => false,
  nudge: () => {},
  submit: () => {},
};
const wd = watchdog.start(redis, {
  intervalMs: 60_000,
  onLog: (m) => console.log(m),
  onEvent: (e) => broadcast(e),
  ...(ISOLATED ? { tmuxApi: NOOP_TMUX } : {}),
  // ★ loop_guard 的快速兜底（S1B）：bus 正在关停的 agent 不推 —— 关停记账器只在这个进程里，watchdog 自己看不到。
  isShuttingDown: (name) => shutdownTracker.isPending(name),
});

// ★ **绑不上时必须响亮地死。**
//
// 没有 error handler 的话：EADDRINUSE 会抛未捕获异常，进程带着一段
// 堆栈崩掉 —— 而 bus 是 detached spawn 起来的，stderr 进了日志文件**没人看**。
// 于是「起失败了」和「起好了」在人这边长得一模一样。
//
// 挂上之后：说清是什么、给出能直接跑的修复命令、用一个**专用退出码**（78），
// 让脚本能把「端口冲突」跟别的崩法分开，而不是去 grep 日志文本。
//
// ⚠️ 这个 handler 是**最终判据**，`port-registry.assertAvailable()` 那种
//   启动前试探替代不了它 —— 试探成功到真正 listen 之间有个消不掉的窗口。
portRegistry.installListenErrorHandler(server, BUS);

// ── 对话历史导出 ────────────────────────────────────────────────
//
// Redis → `history/<date>.jsonl`，单向、按 Stream ID 去重、绝不裁流。
// 全部逻辑在 `lib/history.js`（含那三条硬要求各防什么）。
//
// ★ 为什么启动时先导一次、而不是只等第一个 interval：
//   bus 重启是最常见的操作，**而「刚重启完」正是人最可能去看历史的时候**。
//   等 5 分钟的话，那 5 分钟里页面上的历史是旧的，而它跟「导出坏了」同形。
//
// ⚠️ 每次都把 `written` 打出来 —— 那是这个功能唯一的活性证据。
//   一个跑起来了但写 0 条的导出器，**跟没有导出器在加 MAXLEN 那一刻长得一样**，
//   而那一刻之后没有第二次机会。
const HISTORY_EVERY_MS = Number(process.env.ENGLOOP_HISTORY_INTERVAL_MS || 300_000);
// 任务图调度器的 tick（默认 15 秒）。环境变量只给测试把它调快。
const GRAPH_TICK_MS = Number(process.env.ENGLOOP_GRAPH_TICK_MS || 15_000);
async function exportHistory(why) {
  try {
    const r = await history.exportAll(redis, { root: HISTORY_ROOT });
    // 写 0 条是**正常**的（没新消息）——所以那两种情况要说得出区别：
    // 「跳过 N 条」证明它确实读到了流，「一条都没读到」才是可疑的。
    console.log(`[history] ${why}: 写入 ${r.written} 条 · 跳过 ${r.skipped} 条`
      + ` · ${r.streams} 个流 → ${HISTORY_ROOT}`
      + (r.badLines ? `  ⚠ 历史文件里有 ${r.badLines} 行读不动` : '')
      + (r.streams === 0 ? '  ⚠ **一个流都没枚举到** —— 这不是「没有历史」，是「我什么都没看到」' : ''));
  } catch (e) {
    // ⚠️ 导出失败不能把 bus 带走，但**绝不静默** ——
    //   一个安静停止的导出器，会让人在加 MAXLEN 之前以为历史一直在存。
    console.error(`[history] ✗ 导出失败（${why}）：${e.message}`
      + ' —— **这段时间的历史没有落盘**，加 MAXLEN 之前先修好这个。');
  }
}

server.listen(PORT, BUS.host, () => {
  // ★ 绑上端口之后才写 token 文件（理由见 ADMIN_TOKEN 那段）。写不了 ⇒ 退出：
  //   一个 CLI 拿不到钥匙的 bus，`agent-start --stop` 全部 401，而 bus 自己看起来一切正常。
  try {
    auth.writeAdminToken(ADMIN_TOKEN_FILE, ADMIN_TOKEN);
  } catch (e) {
    console.error(`[bus] ✗ admin token 写不了（${ADMIN_TOKEN_FILE}）：${e.message} —— 退出`);
    process.exit(78);
  }
  console.log(`[bus] http://${BUS.host}:${PORT}  ws://${BUS.host}:${PORT}/ws`);
  console.log(`[bus] 鉴权：用户表 ${auth.USERS_FILE} · admin token ${ADMIN_TOKEN_FILE}（0600，本次启动新换）`
    + ` · session ${WEB_SESSIONS_FILE} · 登录 token ${LOGIN_TOKENS_FILE}`);
  console.log(`[bus] outbox: ${OUTBOX}`);
  if (ISOLATED) console.log('[bus] ⚠ 隔离模式：tmux 出口已换成 no-op，history 写临时目录');
  deliverLoop();
  crewInLoop();
  // ── 任务图调度器：每 tick 推一格。启动先跑一次 —— bus 重启后接着 redis 里的状态跑。
  //   tick 内部串行、不叠：上一 tick 没完，这一 tick 直接复用它。
  const graphTick = () => graphs.tick().catch((e) => console.error(`[graph] ✗ tick 失败：${e.message}`));
  console.log(`[bus] 任务图：根目录 ${GRAPHS_ROOT} · 每 ${GRAPH_TICK_MS / 1000}s 一 tick`);
  graphTick();
  setInterval(graphTick, GRAPH_TICK_MS).unref();
  exportHistory('启动');
  setInterval(() => exportHistory('定期'), HISTORY_EVERY_MS).unref();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[bus] ${sig}, 关闭中`);
    wd.stop();
    for (const p of pools) p.stop();
    for (const r of relays.values()) r.stop();
    // 池的连接也要收 —— 漏掉的话进程会被那几条挂着的连接吊住，
    // 靠下面 3 秒的兜底 exit 强退，**而那会让「优雅关停」变成「超时强杀」**。
    server.close(() => Promise.all(
      [redis.quit(), blocking.quit(), blocking2.quit(), blocking3.quit(),
        ...poolClients.map((c) => c.quit())],
    ).then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000);
  });
}

