# 夹具 `blind` —— watchdog 瞎了

`scenario.json`：`extends: "normal"` —— 这里没有的文件都从 `normal/` 拿（形状出处见 `normal/SOURCE.md`）。

| 文件 | 端点 | 出处 |
|---|---|---|
| `agents.json` | `GET /api/agents` | `lib/watchdog.js:2047` `buildAgentsPayload(findings=[], …, sessionsSeen=0)`：五组全空、`sessions_seen: 0`、`watchdog_blind: true`（`:2098`）；离线候选照常（`lib/agent-catalog.js:82`） |

要看的：顶栏下面的通栏红色 `#blind` 横幅（三个视图都有），舰队带只剩离线候选 —— 「空白不代表没事」。
