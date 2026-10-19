'use strict';

/**
 * 探针：在**一个真实的独立进程**里尝试绑一个端口，挂上 `installListenErrorHandler`。
 *
 * 存在的理由：这个 handler 的全部价值在**它怎么结束这个进程** ——
 * 打什么诊断、用哪个退出码。这两件事在测试进程里验不到：
 *   · `process.exit(78)` 在测试进程里调用会把测试自己杀掉
 *   · 断言「handler 被注册了」是无效测试 —— 就像 argv 里有 `--allowedTools`
 *     那个 flag，不等于它生效了
 *
 * 所以必须真起一个进程、真去绑一个被占的端口、真读它的退出码。
 *
 * 用法:  node test/fixtures/port-listen-probe.js <port>
 * 结果:  绑上了   → stdout 打 LISTENING，exit 0
 *        绑不上   → stderr 打诊断，  exit 78
 */

const http = require('node:http');
const reg = require('../../bin/port-registry');

const port = Number(process.argv[2]);
if (!Number.isInteger(port)) {
  console.error('用法: node test/fixtures/port-listen-probe.js <port>');
  process.exit(2);
}

const target = {
  name: 'probe',
  port,
  host: '127.0.0.1',
  source: 'registry',
  desc: '探针用的假服务',
  start: 'node bin/bus-restart.js',
  env: 'ENGLOOP_PORT',
};

const server = http.createServer((req, res) => res.end('ok'));
reg.installListenErrorHandler(server, target);

server.listen(port, '127.0.0.1', () => {
  // 绑上了就立刻退出 —— 探针不需要真的服务任何请求
  process.stdout.write('LISTENING\n');
  server.close(() => process.exit(0));
});
