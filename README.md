# EngLoop

多智能体编排：一个常驻的编排者（JARVIS）和若干常驻 agent，各自跑在一个 tmux 会话里的 Claude Code 中，
通过 Redis Streams 收发消息；一次性的 worker（eval / review / solve / test / write）由 bus 里的 worker 池按需拉起。
人通过本机网页（`http://127.0.0.1:9969`）跟它们对话。

## 需要什么

- macOS（launchd、sandbox 相关的部分只在 macOS 上有）
- Node.js 22+
- Redis（开 AOF；只用 Streams）
- tmux
- Claude Code CLI（`claude`）

## 起停

```bash
npm ci
node bin/bus-user.js add <用户名> --manage   # 生成网页登录用的 key（只存哈希，key 打印一次）
./start.sh                     # 起 bus（默认 nohup）+ 编排者；./stop.sh 停
open http://127.0.0.1:9969     # 聊天界面
tmux attach -t orch            # 坐进编排者会话
./start.sh dev                 # 再起一个名叫 dev 的常驻 agent
node bin/agent-start.js --list # 看谁在线
./bin/preflight.sh             # 自检
```

`config/users.json` 不进 git；形状见 `config/users.json.template`。

## bus 的两种起法

默认 **nohup**。装了 launchd 之后起、停、重启都走 launchd。两条路都进 `bin/serve.sh`：
node 路径、`PATH`、worker 池类型、日志（`temp/bus.log`）只在那里写一次。

| | nohup（默认） | launchd（`node bin/launchd.js install` 之后） |
|---|---|---|
| 判据 | `~/Library/LaunchAgents/<label>.plist` 不在 | 那个文件在 |
| 起 | `./start.sh` ⇒ `nohup bash bin/serve.sh` | `./start.sh` ⇒ `launchctl bootstrap`（在册就 `kickstart`） |
| 停 | `./stop.sh` ⇒ 按进程杀 `bin/serve.js` | `./stop.sh` ⇒ 先 `launchctl bootout`，再按进程杀；不删 plist |
| 重启 | `node bin/bus-restart.js` | `node bin/bus-restart.js` ⇒ `launchctl kickstart -k` |
| 崩了 | 没人拉 | KeepAlive |
| 登录后 | 不起，要手动 `./start.sh` | 登录就起（RunAtLoad） |

```bash
node bin/launchd.js print       # 看生成的 plist，不动任何东西
node bin/launchd.js status      # 装没装、在没在册、pid
node bin/launchd.js install     # 写 plist ＋ bootstrap（bus 正以 nohup 跑着时会拒绝：先 ./stop.sh）
node bin/launchd.js uninstall   # bootout ＋ 删 plist，之后回到 nohup
```

launchd 只托管 bus（它再管队列、relay、watchdog）。编排者和 agent 还是 `./start.sh` 起。
Redis 不归这里管（比如用 `brew services`）。

## 目录

| 路径 | 是什么 |
|---|---|
| `bin/` | 入口：bus（`serve.js`）、poller（`next.js`）、起 agent（`agent-start.js`）、任务图（`graph.js`）… |
| `lib/` | 队列、relay、花名册、watchdog、worker 池、房间、任务图调度、完成核验… |
| `web/` | 网页界面 |
| `hooks/` | Claude Code hook（安全检查、Stop 检查） |
| `protocols/` | 每轮注入给 agent 的身份与轮询规则；`flows/` 是房间流程模板 |
| `templates/` | 各类 agent / worker 的 `CLAUDE.md` 与 `.claude/settings.json` 模板 |
| `workers/` | worker 的工作目录（每次派活由 `lib/provision.js` 从模板重新渲染） |
| `agents/` | 常驻 agent 的工作目录（`agent-start.js` 起 agent 时按模板生成；公开版里一开始没有） |
| `test/` | 测试；`node test/run-all.js` 跑全部 |

## 测试

```bash
node test/run-all.js                 # 全部（每个文件一个子进程）
node test/run-all.js --only queue.test.js
```

测试用 Redis 的 1–15 号库（自动抢一个空闲的，锁在系统临时目录），**从不碰 db 0**；
不连 9969 上的 bus。少数测试依赖本机环境（tmux、macOS sandbox），在别的环境里会红。

## License

License: MIT（见 `LICENSE`）。
