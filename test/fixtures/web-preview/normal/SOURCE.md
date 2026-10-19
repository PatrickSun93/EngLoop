# 夹具 `normal` —— 每个文件照哪个 handler 抄的

预览服务器：`scripts/web-preview.js`。行号是写这份夹具时的，不保证还对。
时间写成 `@now-5m`（ISO）或 `@now-5m|ms`（毫秒），回响应时按当前时间换算（见脚本头注）。

| 文件 | 端点 | 出处（形状照这里抄） |
|---|---|---|
| `health.json` | `GET /health` | `bin/serve.js:219` 回调里那个对象：`ok / service / redis / ws_clients / uptime_s` |
| `whoami.json` | `GET /api/whoami` | `bin/serve.js:247`：`username / can_manage_workers / via` |
| `agents.json` | `GET /api/agents` | `bin/serve.js:837` → `lib/watchdog.js:2047` `buildAgentsPayload()`（`shape()` 的字段、`deaf / stale / rate_limited / orphan_pel / live` 五组、`sessions_seen`、`watchdog_blind`）；回调里再加的 `offline_candidates`（`lib/agent-catalog.js:82` `scan()` 的条目）、`offline_source`、`launching`、`dropouts`（`lib/roster.js:238` 写进去的记录：`name / type / detected_at`） |
| `queue-items.json` | `GET /api/queue/items` | `bin/serve.js:512` → `lib/queue-items.js:178` `listAll()`：`groups[]` 每组 `recipient / queued / in_flight / items / streams / errors`；条目是流字段 + `state`（`classify()` `:75`）+ `stream / group`（`:216`） |
| `status.json` | `GET /api/status` | `bin/serve.js:467` → `lib/status.js:289` `handler()`：`buildStatusPayload()` `:131`（`tests / git / stale / stale_reasons / stale_hint`）+ `queueStats()` `:242`（`queue`）。`tests` 里**没有逐文件结果** —— 页面只画总数 |
| `rooms.json` | `GET /api/rooms` | `bin/serve.js:317` → `lib/rooms.js:253` `list()`：meta（`create()` `:217` + `withFlowDefaults()`）+ `message_count` + `last_activity_at`。`pdp-review` 故意是 15 天前 —— 看左栏「还有 1 个房间超过 10 天没动静，已折叠」 |
| `rooms/<hash>.json` | `GET /api/rooms/:hash/history` | `bin/serve.js:399` → `lib/rooms.js:479` `historyHandler()` → `:392` `historyPayload()`：`hash / name / members / count / messages / merges`；消息是流条目（`post()` `:313` 写的 `from / text / timestamp / reply_to / expects_reply`，relay 写的 `kind / done / verify`） |
| `messages/<name>.json` | `GET /api/messages?to=<name>` | `bin/serve.js:452` → `lib/messages.js:156` `historyPayload()`：`name / registered / type / count / sources / coverage_note / coverage_next / messages`；条目带 `stream / direction`（`readSource()` `:136`） |
| `outputs.json` | `GET /api/outputs` | `bin/serve.js:551` → `lib/outputs.js:144` `listAll()`：`jobs / total / truncated / root`；文件条目 `:124`（`name / kind / size / mtime / status / superseded_partial`） |
| `docs-list.json` | `GET /api/docs` | `bin/serve.js:581` → `lib/docs.js:236` `listHandler()` → `:122` `list()`：`root / count / max_bytes / files` |
| `docs/TASK_UI-redesign.md.json` | `GET /api/docs/TASK_UI-redesign.md` | `bin/serve.js:582` → `lib/docs.js:252` `readHandler()` → `:163` `read()`：`path / size / mtime / title / content`（内容是摘录，不是全文） |
| `reactions-semantics.json` | `GET /api/reactions/semantics` | `bin/serve.js:433` → `lib/reactions.js:261` `semanticsPayload()` —— **直接调这个函数生成的**，不是手抄 |
| `reactions.json` | `POST /api/reactions/batch`、`GET /api/reactions/:scope/:anchor` | 预览自己的格式：`{ room: {锚点: [...]}, dm: {...} }`。每个反应是 `lib/reactions.js:427` `list()` 的元素（`classify(emoji)` + `count` + `users`）；batch 的响应形状照 `:719` `batchHandler()`（`scope / reactions / truncated`） |
| `reactions-pending.json` | `GET /api/reactions/pending` | `bin/serve.js:435` → `lib/reactions.js` `listPendingHandler()`：`pending / all` |

逐个文件：`rooms/eng-loop-7f3a9c21d0b4.json`、`rooms/w1-agy-2b8e61f0a9c3.json`、`rooms/ui-redesign-c41d07e5b2aa.json`、
`rooms/pdp-review-0a1b2c3d4e5f.json`；`messages/JARVIS.json`、`messages/dev.json`、`messages/senior.json`、
`messages/dev3.json`（`registered: false`）、`messages/dev2.json`、`messages/qa.json`（空）。

## 这个场景里特意放了什么

- 6 个 agent：`JARVIS`（编排者，ok）、`dev`（ok，申报了长任务）、`senior`（warn）、`dev3`（deaf）、`dev2`（rate_limited）、`qa`（unknown）。另有离线候选 `designer`、一条掉册记录。
- `#eng-loop`：话题 + 折叠的回复、状态消息（`kind: status`）连成一串、`【流程】` 通知（`expects_reply`）、带 `done` 和代码块的完成报告、`@Patrick` 的提问、未归属消息、三条完全相同的 watchdog 通知（重复折叠）、`docs/…` 链接、反应。
- 私聊 `JARVIS`：`j-pat-3` 那条同时在 `queue-items.json` 里是 `queued` —— 看「撤回 / 撤回改写」按钮。
- 4 天前的话题（`#eng-loop` 的 `1791000001000-0` + 它的回复 `1791000002000-0`，`timestamp` 都是 `@now-4d`，ISO 字符串）：**会被折进「更早的 1 个话题」**。
  房间历史的 `at` 来自 `timestamp`（ISO 字符串）：时间解析只认数字的话判不出时间，就不折。
  时间解析只有一份（`Threads.atMs`，数字和 ISO 都认），超过 48 小时没动静的房间话题会被折起来。

## 「今天」视图的「刚完成」用的那几条（`#w1-agy`）

完成报告的 `verify` 由 relay 写进流（`lib/relay.js:841`，值来自 `lib/done-verify.js:63` `modeOf()`）；
核验的结论有两种落法，**页面要分得清**：

- pass / unverifiable ⇒ 原报告上的反应换成 🏁（`done-verify.js:176`），**并且**往原来那条流发一条跟帖（`:179-192`）：
  `from` = 原报告人、`sender_type: system`（`stamp.SYSTEM`）、`done: 'true'`、`verify: 'pass' | 'unverifiable'`（`:190`）、`reply_to` = 锚点（`:187`）。
- fail ⇒ **只**把反应换成 🔙（`:197`），流里没有跟帖 ⇒ 原报告的 `verify` 永远停在 `pending`。

锚点 = `报告.reply_to || 报告自己`（`lib/relay.js:881`）—— 下面几条报告都是顶层消息，所以锚点就是它们自己的 id。

| id | 时间 | 是什么 | 对应 | 「刚完成」里应该显示 |
|---|---|---|---|---|
| `1790999990000-0` | `@now-26h` | `done`，`verify: none` | `modeOf()` `:65` | **不出现**（超过 24 小时） |
| `1791000020000-0` | `@now-3h` | `done`，`verify: none`（原有的） | `:65` | 「未验证」 |
| `1791000020500-0` | `@now-2h` | `pending` 报告；`reactions.json` 里锚点上有 🔙，**没有跟帖** | fail ⇒ `:197` | 「核验没过 · 已打回」（红） |
| `1791000021000-0` | `@now-70m` | `pending` 报告；锚点上有 🏁，**没有跟帖** | pass / unverifiable 都贴 🏁 `:176` | 「核验已结束 · 结论没加载到」（灰，**不是**通过） |
| `1791000021500-0` | `@now-50m` | `pending` 报告；锚点上有 🏁 | `:176` | 跟下一条合成**一行**，「已独立核验」 |
| `1791000022000-0` | `@now-45m` | 核验跟帖：`sender_type: system`、同一个 `from: dev`、`verify: pass`、`reply_to: 1791000021500-0` | `:179-192` | **不单独成行**（合进上一条） |
| `1791000022500-0` | `@now-25m` | `pending` 报告，**没有反应** | 核验还在跑（真实情况下锚点上有 ⏳，`:114`） | 「核验中」 |
| `1791000023000-0` | `@now-15m` | 核验跟帖：`verify: unverifiable`，`reply_to` 指向一条**不在这批里**的报告 | `:179-192` | 自己成一行，「核验结论（原报告没加载）」+「未验证：核验做不了」 |

另外两条原有的：`#eng-loop` 的 `1791000012000-0`（`verify: pass` 直接写在报告上 —— 老夹具的写法，页面照字段显示「已独立核验」）、
私聊 `JARVIS` 的 `j-dev-r1`（**没有 `verify` 字段** ⇒「未验证」：缺字段不能读成核过了）。

反应在 `reactions.json` 的 `room` 下，键是锚点；`users[].at` 写成 `@now-…|ms`。页面用 `POST /api/reactions/batch` 一次取齐（`scripts/web-preview.js:239`）。
`rooms.json` 里 `#w1-agy` 的 `message_count` / `last_activity_at` 跟着改成 71 / `@now-15m`。

`test/web-derive.test.js` 的 FX1 用这份夹具对一遍上表最后一列；BS1 / BS2 用它对摘要句的数字。

## 其余场景在「今天」视图里该看到的

- `empty`：问候下面写「没有要你处理的事。」，「等你处理」写「没有要你处理的事」**并且**列出两个端点各自正常；「刚完成」空；「进行中」只有 JARVIS。
- `blind`：「在线」写「查不了」；摘要第二句写「agent 状态查不了（watchdog 什么都没看见）」；「进行中」写「查不了」。
- `agents-error`：「在线」写「?」、「队列」写「?」（队列条目跟 /api/agents 一起拉，那次没拉成）；条数写「N+?」；第二句写「agent 状态查不了」。
- `status-404`：「今日 commit」「全量」写「端点 404」（划掉）；第二句写「全量：端点 404」，不写数字。

## 队列条目的 `id`

`queue-items.json` 里条目的 `id`（stream id）写成 `@now-14m-0` 这种相对写法，预览服务器回响应时换成
`<那一刻的毫秒数>-<序号>`（`scripts/web-preview.js` 的 `resolveTimes`），跟同一条的 `timestamp` 对得上。
理由：今天视图的「派出 N 分钟」**按 stream id 算**（进队列的时刻，`lib/queue-items.js` 不给领取时间）——
id 要是写死成 `1791…-0` 而 `timestamp` 是相对的，预览里就会显示成「派出 247 小时」—— 那是夹具自己造出来的数。

## 「泳道」用的那几条（`messages/*.json`）

泳道的一列 = `GET /api/messages?to=<名字>` + 已加载房间里它的发言 +（编排者那一列）各 agent 收件流里 `from: JARVIS` 的派活。
下面这些是为了把三处拼接、去重、排序都撑起来加的：

| 文件 | id | 是什么 | 泳道里应该看到 |
|---|---|---|---|
| `dev.json` | `1790000006000-0` | `agent:dev:in`，`from: JARVIS`（原有的派活） | dev 那一列「JARVIS → dev」；**编排者那一列一行「→ dev」派活行** |
| `dev.json` | `1790000007500-0` | `agent:dev:in`，`from: senior` —— agent 之间的话（`lib/messages.js` 文件头：只在对方收件流里） | dev 那一列「senior → dev」；编排者那一列**没有**（不是派活） |
| `dev.json` | `1790000006800-0` | `orch:in:agent`，dev 在 `#eng-loop` 的发言扇出进编排者收件流的那份：`room_hash` + `room_msg_id: 1791000011000-0`（`bin/serve.js:1059-1076`），**不带 done / verify** | dev 那一列只出**一次**（跟房间流里那条去重）；编排者那一列「dev → JARVIS · #eng-loop」 |
| `dev.json` | `1789000001000-0` | `orch:in:agent`，完成报告 `done: 'true'`、`verify: 'pending'`，**9 行**；`timestamp` 是毫秒数（`@now-26h\|ms`） | 「🏁 已提交核验」、折起来带「展开（共 9 行）」 |
| `dev.json` | `1789000002000-0` | 核验跟帖：`sender_type: system`、`verify: pass`、`reply_to: j-dev-r0`（`lib/done-verify.js:179-192`）；`timestamp` 是 ISO | 灰色系统行「核验结论：已独立核验」 |
| `dev.json` | `1790000007000-0` | 原有的「收到，开始跑。」，`timestamp` 改成毫秒数 | 时间混用数字和 ISO，照真时间排 |
| `senior.json` / `JARVIS.json` | `1790000008500-0` | senior 的审阅意见（`orch:in:agent`），**8 行**，`timestamp` 毫秒数 | 折起来；`JARVIS.json` 里同一条是 `direction: in` |
| `JARVIS.json` | `1790000006800-0`、`1790000007000-0` | 上面 dev 那两条在编排者收件流里的同一份（`orch:in:agent` 不按 from 过滤） | 编排者那一列「dev → JARVIS」 |

⚠️ 那两条完成报告 / 核验跟帖故意放在 **25–26 小时前**：今天视图的「刚完成」（24 小时窗）和摘要句
（`test/web-derive.test.js` 的 BS2 数的是今天 00:00 之后的报告条数）不受影响 —— 不改「今天」视图的数。
`sources[].matched` 跟着改成实际条数。
