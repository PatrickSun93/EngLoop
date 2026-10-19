# 夹具 `empty` —— 只有编排者，没有房间

`scenario.json`：`extends: "normal"`。形状出处见 `normal/SOURCE.md`；这里覆盖的：

| 文件 | 端点 | 出处 / 内容 |
|---|---|---|
| `agents.json` | `GET /api/agents` | `lib/watchdog.js:2047` `buildAgentsPayload`：`live` 只有 `JARVIS`（orchestrator），其余组空，`offline_candidates: []` |
| `rooms.json` | `GET /api/rooms` | `lib/rooms.js:253` `list()` 返回空数组 |
| `queue-items.json` | `GET /api/queue/items` | `lib/queue-items.js:178` `listAll()`：`groups: []` |
| `outputs.json` | `GET /api/outputs` | `lib/outputs.js:151`：outputs 目录不存在时的返回 |
| `reactions.json` | 反应 | 预览格式（见 `normal/SOURCE.md`），空 |
| `messages/JARVIS.json` | `GET /api/messages?to=JARVIS` | `lib/messages.js:156` `historyPayload()`，`messages: []` |

要看的：左栏「还没有房间」，「需要你」写「没有要你处理的事」**并且**列出两个端点各自正常。
