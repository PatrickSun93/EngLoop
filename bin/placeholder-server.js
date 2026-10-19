/**
 * 占位 server —— 只为验证 launchd 能不能无人值守把 EngLoop 拉起来。
 *
 * 它不做任何 EngLoop 的实际工作，只暴露 /health，让重启验收有个可探测的目标。
 * 真 bus 是 bin/serve.js，这里只是它的替身。
 */

'use strict';

const http = require('node:http');
const { execFile } = require('node:child_process');
const portRegistry = require('./port-registry');

// 端口从注册表来。
// ⚠️ 它跟真 bus **故意**共用一个端口（它就是 bus 的替身），所以两者同时
//   起必然冲突。两边各写一份 `ENGLOOP_PORT || 9969` 的话，
//   冲突时谁都不知道自己在跟谁抢；走注册表，冲突会指名道姓地报出来。
const BUS = portRegistry.resolve('bus');
const PORT = BUS.port;
const startedAt = new Date().toISOString();

function redisPing(cb) {
  execFile('/opt/homebrew/bin/redis-cli', ['ping'], { timeout: 2000 }, (err, stdout) => {
    cb(err ? 'down' : String(stdout).trim().toLowerCase());
  });
}

const server = http.createServer((req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  // 顺带探 redis —— 重启验收要同时确认两个服务都回来了
  redisPing((redis) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'engloop-placeholder',
        started_at: startedAt,
        uptime_s: Math.round(process.uptime()),
        pid: process.pid,
        redis,
        node: process.version,
      }),
    );
  });
});

// 绑不上要响亮地死，不是抛个没人看的堆栈（见 bin/serve.js 同处的说明）
portRegistry.installListenErrorHandler(server, BUS);

server.listen(PORT, BUS.host, () => {
  process.stdout.write(`[engloop] placeholder listening on ${BUS.host}:${PORT}\n`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    process.stdout.write(`[engloop] ${sig} received, closing\n`);
    server.close(() => process.exit(0));
  });
}
