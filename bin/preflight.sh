#!/bin/bash
# 登录后自检 —— 一眼确认 EngLoop 该跑的都跑起来了。
#
# 为什么需要它：这台机器**故意不开自动登录**（安全权衡），所以重启后必须
# 手动登录一次。那一刻是唯一的人工介入点，自检放在这里最省事 ——
# 不依赖你记得去查什么。
#
# 用法：  ./bin/preflight.sh
# 建议：  加进 shell profile，或做成登录项

set -u
cd "$(dirname "$0")/.." || exit 1

# 端口问注册表要，**不在这里再写一份默认值**。
# shell 没法 require 那个模块，所以它给了个 CLI 出口。
# 问不到就停 —— 拿一个猜的端口去自检，报出来的「不可达」是假的。
PORT=$(node bin/port-registry.js --port bus 2>&1)
if ! printf '%s' "$PORT" | grep -qE '^[0-9]+$'; then
  printf '  \033[31m✗\033[0m 问不到 bus 的端口: %s\n' "$PORT"
  printf '    自检不能拿一个猜的端口继续 —— 那样报出来的「不可达」是假的。\n'
  exit 1
fi
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

echo
echo "EngLoop 自检 · $(date '+%Y-%m-%d %H:%M')"
echo "──────────────────────────────────────────"

# 1. 开机时长 —— 如果刚重启，说明这是一次「断电要人管」的恢复
UP=$(uptime | sed -E 's/.*up ([^,]+(, [0-9]+ (hrs?|mins?))?),.*/\1/')
echo "  系统已运行 $UP"

# 2. redis
if redis-cli ping >/dev/null 2>&1; then
  AOF=$(redis-cli info persistence 2>/dev/null | grep -c '^aof_enabled:1')
  [ "$AOF" = "1" ] && ok "redis 在线，AOF 已开" || warn "redis 在线，但 AOF 没开"
else
  bad "redis 不可达 —— brew services start redis"
fi

# 3. EngLoop server
HEALTH=$(curl -s -m 3 "http://127.0.0.1:${PORT}/health" 2>/dev/null)
if [ -n "$HEALTH" ]; then
  PID=$(printf '%s' "$HEALTH" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
  ok "EngLoop 在线 (pid ${PID:-?}, :${PORT})"
else
  bad "EngLoop 不可达 —— ./start.sh（nohup / launchd 两种模式它都认得）"
fi

# 4. launchd 托管状态（跑着 ≠ 被托管；手动起的重启后不会回来）
#   redis 一直该由 brew services 托管。bus 默认 nohup：没装 launchd 不算错，
#   装了（plist 在）才要求在册。label / 模式都问 bin/launchd.js（唯一出处）。
if launchctl list 2>/dev/null | grep -q "homebrew.mxcl.redis"; then
  ok "launchd 托管 homebrew.mxcl.redis"
else
  bad "launchd 未托管 homebrew.mxcl.redis —— 重启后不会自己回来（brew services start redis）"
fi
BUSLABEL=$(node bin/launchd.js label 2>/dev/null)
if [ "$(node bin/launchd.js mode 2>/dev/null)" = "launchd" ]; then
  if launchctl print "gui/$(id -u)/$BUSLABEL" >/dev/null 2>&1; then
    ok "launchd 托管 $BUSLABEL"
  else
    bad "launchd 模式（plist 在）但 $BUSLABEL 不在册 —— ./start.sh 会重新 bootstrap"
  fi
else
  warn "bus 是 nohup 模式（没装 launchd）—— 重启 / 登录后要手动 ./start.sh；要自启：node bin/launchd.js install"
fi

# 5. tmux 会话（orch / agent_*）
SESS=$(tmux ls 2>/dev/null | wc -l | tr -d ' ')
if [ "$SESS" = "0" ]; then
  echo "  · 无 tmux 会话（还没起任何 agent 时正常）"
else
  echo "  · tmux 会话 $SESS 个:"
  tmux ls 2>/dev/null | sed 's/^/      /'
fi

echo "──────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  printf '  \033[32m全部正常\033[0m\n\n'
else
  printf '  \033[31m%d 项异常 —— 见上面的修复命令\033[0m\n\n' "$FAIL"
  exit 1
fi
