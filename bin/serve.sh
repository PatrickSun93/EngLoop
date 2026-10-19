#!/bin/bash
# bus 的**唯一**入口：两种起法都经过这里 ——
#   nohup    ./start.sh ⇒ `nohup bash bin/serve.sh`
#   launchd  plist（`node bin/launchd.js print` 生成）⇒ `/bin/bash <根>/bin/serve.sh`
#   重启     bin/bus-restart.js ⇒ spawn 这个脚本（或 launchd 下 kickstart）
# ⇒ node 路径、PATH、worker 池类型、日志**只在这里写一次**。
#
# 为什么不让 plist 直接调 node：你的 node 装在 nvm 下
# ($HOME/.nvm/versions/node/vX/bin/node)，而 launchd **不加载**
# 你的 shell profile。plist 里写死绝对路径的话，nvm 升一次版本就断。
#
# 这里自己解析 node 路径，plist 只认这个脚本。

set -u
cd "$(dirname "$0")/.." || exit 78   # 78 = EX_CONFIG

# 按优先级找 node：nvm 默认版本 → nvm 任意版本 → 系统 PATH
NODE=""
if [ -s "$HOME/.nvm/alias/default" ]; then
  V=$(cat "$HOME/.nvm/alias/default")
  case "$V" in v*) : ;; *) V="v$V" ;; esac
  [ -x "$HOME/.nvm/versions/node/$V/bin/node" ] && NODE="$HOME/.nvm/versions/node/$V/bin/node"
fi
if [ -z "$NODE" ]; then
  NODE=$(ls -1d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -1)
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  NODE=$(command -v node 2>/dev/null)
fi
if [ -z "$NODE" ]; then
  echo "[engloop] FATAL: 找不到 node" >&2
  exit 78
fi

# ── PATH ────────────────────────────────────────────────────────
# launchd 给的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，不加载 shell profile。
# PATH 只在这里设：每条启动路径各维护一份环境的话，漏一条不报错。
#
# 逐个是谁要：
#   $NODE_DIR          node —— agent 在会话里跑 `node bin/next.js`，hook 是 `node hooks/check_security.js`
#                      （找不到 node ⇒ hook 失败 ⇒ check_security fail-closed，工具调用全被拒）。
#                      放第一个：子进程拿到的 node 跟 bus 自己是同一个版本。
#   $HOME/.local/bin   claude（orch-start.js / agent-start.js 在 tmux 里起的是裸 `claude`，没有兜底路径）、agy
#   /opt/homebrew/bin  tmux（lib/tmux.js 有兜底，但 tmux 会话里的 shell 没有）、redis-cli、python3
#   /usr/local/bin     Intel Mac 的 homebrew
#   系统四个           git、ps、which、env、launchctl、sandbox-exec、lsof
#
# ⚠️ 不继承调用方的 PATH：launchd 下没有那个东西。继承的话，nohup 起的 bus 能用、
#   launchd 起的不能用，而两边从外面看一样。
#   要加目录就加在这一行，两种起法一起生效。
NODE_DIR=$(dirname "$NODE")
export PATH="$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# ── 日志落盘 ────────────────────────────────────────────────────
# 不重定向的话，bus 的 stdout/stderr 继承自调用方，而启动路径
# （start.sh / launchd）都不给它文件 ⇒ fd 0/1/2 全是 `/dev/null`。
#
# ⚠️ 症状是**静默**：所有 console.log / 未捕获异常 / relay 事件一个字都不落盘，
#   而 bus 看起来完全正常（/api/agents 200、消息照收照发）。
#   出事时唯一能查的东西不存在，**而没有任何迹象提示它不存在**。
#
# ★ 加在**脚本里面**而不是各自的启动行上 —— 所有启动路径一次全覆盖：
#   每条启动路径各自维护一份，漏一条不报错。
#
# 追加不覆盖：重启不该抹掉上一次崩溃前写下的东西。
LOG="${ENGLOOP_BUS_LOG:-$PWD/temp/bus.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
exec >> "$LOG" 2>&1
echo ""
echo "[engloop] ═══ bus 启动 $(date -u '+%Y-%m-%dT%H:%M:%SZ') · pid $$ ═══"

echo "[engloop] node: $NODE"
echo "[engloop] PATH: $PATH"

# worker 池类型 —— 唯一出处（start.sh 不设，它走这个脚本）。
# 不设这行，serve.js 默认只起 'eval'（见 bin/serve.js: `?? 'eval'`），
# review 池会**静默消失**：work:review 无消费者，不报错、不超时。
# test：完成核验的 qa 项派给 work:test 独立核（bin/verify-complete.js）——没有这个池，带 qa 的 evidence 一律判 fail（会说清原因）。
export ENGLOOP_WORKER_TYPES="${ENGLOOP_WORKER_TYPES:-eval,review,solve,test}"

exec "$NODE" bin/serve.js
