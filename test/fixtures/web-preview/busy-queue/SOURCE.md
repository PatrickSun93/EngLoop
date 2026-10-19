# 夹具 `busy-queue` —— 总数一样、处置相反

`scenario.json`：`extends: "normal"`。形状出处见 `normal/SOURCE.md`；这里覆盖的：

| 文件 | 端点 | 出处 / 内容 |
|---|---|---|
| `queue-items.json` | `GET /api/queue/items` | `lib/queue-items.js:178` `listAll()`：`dev` 排队 0 · 在手 6，`senior` 排队 5 · 在手 1（条目 `state` 照 `classify()` `:75`） |
| `agents.json` | `GET /api/agents` | 同 normal，只是 `dev` 没申报长任务（`declared_busy: false`）—— 卡片上的「当前任务」退到在手条目里最早那一条 |

要看的：两张卡上「排队 / 在手」两个胶囊各写各的数，**没有**一个「6」的总数。

## 队列条目的 `id`

`queue-items.json` 里条目的 `id`（stream id）写成 `@now-14m-0` 这种相对写法，预览服务器回响应时换成
`<那一刻的毫秒数>-<序号>`（`scripts/web-preview.js` 的 `resolveTimes`），跟同一条的 `timestamp` 对得上。
理由：今天视图的「派出 N 分钟」**按 stream id 算**（进队列的时刻，`lib/queue-items.js` 不给领取时间）——
id 要是写死成 `1791…-0` 而 `timestamp` 是相对的，预览里就会显示成「派出 247 小时」—— 那是夹具自己造出来的数。
