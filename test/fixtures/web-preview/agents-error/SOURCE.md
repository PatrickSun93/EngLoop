# 夹具 `agents-error` —— /api/agents 返回 500

`scenario.json`：`extends: "normal"`，`status: { "agents.json": 500 }`。其余文件从 `normal/` 拿。

| 文件 | 端点 | 出处 |
|---|---|---|
| `agents.json` | `GET /api/agents`（500） | `bin/serve.js:884`，那个 catch 的非 tmux 分支：`{ error: 'agents_probe_failed', message }` |

要看的：`#blind` 横幅写「看不到 agent 状态」，舰队带写「查不了」而不是「没有 agent」，
「需要你」的条数写成 `N + ?`、并列出 `/api/agents 查不了 · /api/status 正常`。
