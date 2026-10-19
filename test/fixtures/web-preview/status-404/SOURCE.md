# 夹具 `status-404` —— /api/status 返回 404

`scenario.json`：`extends: "normal"`，`status: { "status.json": { "code": 404, "html": "…Cannot GET /api/status…" } }`。
**没有** `status.json` 文件 —— 回的是 express 找不到路由时的默认 HTML（没挂这个路由的老 bus 就是这样），
不是后端给的 JSON。其余文件从 `normal/` 拿。

要看的：顶栏「全量 / 今日 commit / 队列」三格都写「端点 404」并划掉，右栏全量和 HEAD 两块写「端点 404」+ 两种可能
（bus 没加载新代码 / 端点还没做）—— 「问不到」不是「测试挂了」。
