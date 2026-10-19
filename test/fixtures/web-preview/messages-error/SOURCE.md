# 夹具 `messages-error` —— 某一个 agent 的 `/api/messages` 返回 503

`scenario.json`：`extends: "normal"`，`status: { "messages/dev.json": 503 }`。其余文件从 `normal/` 拿。
预览服务器不用改：场景目录里的 `messages/dev.json` 盖住 `normal/` 的那份，`status` 表按同一个相对路径给它 503
（`scripts/web-preview.js` 的 `loadFixture()`：先找场景目录、再找 `extends`，状态码按 `rel` 查）。

| 文件 | 端点 | 出处 |
|---|---|---|
| `messages/dev.json` | `GET /api/messages?to=dev`（503） | `bin/serve.js:452` → `lib/messages.js:262` `handler()` 的 catch → `:229` `httpError()` 的 `PARTIAL_UNAVAILABLE` 分支：`{ error, message, detail, next }`。错误本身来自 `:156` `historyPayload()` —— **任何一个源查失败就整体抛，不返回一半**（`:170-181`）。**这份 body 是直接调 `httpError()` 生成的**，不是手抄（`err.code = PARTIAL_UNAVAILABLE`，message 里点名 `orch:in:agent`） |

要看的（泳道视图）：

- `dev` 那一列：头上一行红字「查不了：PARTIAL_UNAVAILABLE —— …」，title 里是后端的 `next`；
  一次都没拿到过时写「这一列的私聊历史一次都没拿到过（下面只有房间里的发言）」——房间里 dev 的发言照样在（那部分从 `feeds` 来，不经过这个端点）。
  **不准画成「没有消息」。**
- 先在 `normal` 里拿到过、之后才报错的情况（e2e 用 `page.route` 造）：**保留上次的内容**，写「下面是 HH:MM 的内容」。
- 其余列正常。编排者那一列的 ⓘ 写「并进了 … 的收件流」时**不含 dev**（dev 的收件流没取到）—— 所以 dev 的派活行在这个场景里不出现，ⓘ 照实写。
