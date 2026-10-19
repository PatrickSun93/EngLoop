#!/usr/bin/env bash
# 启动 EngLoop。
#
#   ./start.sh                    只起 bus + 编排者
#   ./start.sh dev                再起一个 dev
#   ./start.sh dev qa             起多个
#
# ── bus 的两种起法 ──────────────────────────────────────────────
#   默认 nohup：`nohup bash bin/serve.sh`
#   装了 launchd（`node bin/launchd.js install`）：`node bin/launchd.js start`（bootstrap / kickstart）
#   判据是 `node bin/launchd.js mode`：~/Library/LaunchAgents/<label>.plist 在不在。
#   两条路都进 bin/serve.sh ⇒ bus 的 node 路径、PATH、worker 池类型、日志只在那里写一次。
#
# ── 三个坑，都固化在这里 ────────────────────────────────────────
#   1. PATH：bus 要调 tmux，而 nohup 不加载 shell profile
#      → tmux.list() 会静默返回空，watchdog 就瞎了
#      → bus 的 PATH 在 bin/serve.sh 里；这里那行只给这个脚本自己用
#   2. 端口：pkill + sleep 3 不够，端口没释放就起 = EADDRINUSE
#      → 而 /health 照常 200，崩溃的 bus 和健康的 bus 从外面一模一样
#   3. 日志：`>` 会让失败的启动抹掉成功那次的记录 → 一律用 `>>`
# ────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")"

PORT="${ENGLOOP_PORT:-9969}"
# 这一行是**脚本自己**用的（tmux / redis-cli / lsof）。bus 的 PATH 在 bin/serve.sh 里。
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"   # 坑 1

# ── worker 池的类型：在 bin/serve.sh 里（唯一出处）──────────────────
#   `ENGLOOP_WORKER_TYPES` 只在 serve.sh 里设（bin/serve.js 默认只起 'eval'，漏设的话 review 池会
#   **静默消失**）。nohup 和 launchd 两条路都进 serve.sh，所以不在这里再写一份 ——
#   写在这里的话，launchd 那条路就拿不到。
#   要临时换池：`ENGLOOP_WORKER_TYPES=eval ./start.sh`，环境变量照样传进 serve.sh。

echo "EngLoop 启动"
echo

# ── 0. 前置 ─────────────────────────────────────────────────────
command -v tmux  >/dev/null || { echo "✗ 找不到 tmux";  exit 1; }
command -v node  >/dev/null || { echo "✗ 找不到 node";  exit 1; }
redis-cli ping >/dev/null 2>&1 || { echo "✗ Redis 没在跑（brew services start redis）"; exit 1; }
echo "  ✓ tmux · node · redis"

# ── 1. bus ──────────────────────────────────────────────────────
BUSMODE=$(node bin/launchd.js mode) || { echo "✗ 判不了 bus 的起法（node bin/launchd.js mode 失败）"; exit 1; }
# ── 「bus 在不在」只认 /health 自报的身份，不看端口 ──────────────────────────
#   `lsof -ti ":$PORT" -sTCP:LISTEN` 会把**任何地址**上的监听都算上：别的地址上有一个不相干的
#   进程监听同一个端口时，bus 停着，这里却会打「✓ bus 已在跑」然后跳过起 bus。
#   bus 自己只绑 127.0.0.1，/health 回 `service: "engloop-bus"`。
bus_alive() {
  curl -s -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      try { process.exit(JSON.parse(s).service === "engloop-bus" ? 0 : 1); } catch (_) { process.exit(1); }
    });' 2>/dev/null
}
# 127.0.0.1:$PORT 上的监听者（pid 列表）。别的地址上的不算 —— 它们不挡 bus 绑 127.0.0.1。
loopback_listeners() { lsof -nP -iTCP@127.0.0.1:"$PORT" -sTCP:LISTEN -t 2>/dev/null; }
if bus_alive; then
  echo "  ✓ bus 已在跑（127.0.0.1:${PORT}/health 自报 engloop-bus）"
elif [ -n "$(loopback_listeners)" ]; then
  # /health 不通（或者回的不是 engloop-bus），而 127.0.0.1:$PORT 被别人占着 ⇒
  # 再起一个 bus 只会绑失败（EADDRINUSE），而且失败会被下面那段等 /health 的循环误读。
  echo "  ✗ 127.0.0.1:${PORT} 被一个不是 engloop-bus 的进程占着（/health 没有自报 engloop-bus）："
  for p in $(loopback_listeners); do echo "      $(ps -o pid=,command= -p "$p" 2>/dev/null || echo "$p （ps 查不到）")"; done
  echo "    不起第二个 bus。先弄清楚它是什么、停掉它，或者换端口：ENGLOOP_PORT=<端口> ./start.sh"
  exit 1
else
  OTHER=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1"("$2") "$9}' | tr '\n' ' ')
  [ -n "$OTHER" ] && echo "  · 提示：端口 ${PORT} 在别的地址上有监听（不影响 bus 绑 127.0.0.1）：$OTHER"
  mkdir -p temp
  if [ "$BUSMODE" = "launchd" ]; then
    # 装了 launchd：交给它起（stop.sh bootout 过 ⇒ bootstrap；还在册 ⇒ kickstart）。
    # ⚠️ 不能在这里 nohup 一个：KeepAlive 那个也会起来 ⇒ 两个 bus。
    echo "  · launchd 模式（$(node bin/launchd.js label)）"
    node bin/launchd.js start || { echo "  ✗ launchd 起 bus 失败（上面那行是 launchctl 的原话）"; exit 1; }
  else
    # serve.sh 自己把输出追加进 temp/bus.log；这里的 >> 接的是它改写 stdout 之前的那几行
    # （比如「找不到 node」）。坑 3：追加不覆盖。
    nohup bash bin/serve.sh >> temp/bus.log 2>&1 &
  fi
  # 起完之后等的也是同一个判据：/health 自报 engloop-bus（不是「端口上有人回 200」）。
  for i in $(seq 1 20); do
    bus_alive && break
    sleep 1
  done
  if bus_alive; then
    echo "  ✓ bus 起来了"
  else
    echo "  ✗ bus 没起来（$BUSMODE 模式），看 temp/bus.log 最后几行："
    tail -5 temp/bus.log
    [ "$BUSMODE" = "launchd" ] && echo "    launchd 那边：node bin/launchd.js status · ~/Library/Logs/engloop.err"
    exit 1
  fi
fi

# ── 2. 编排者 ───────────────────────────────────────────────────
if tmux has-session -t orch 2>/dev/null; then
  echo "  ✓ JARVIS 已在跑"
else
  node bin/orch-start.js >/dev/null 2>&1 && echo "  ✓ JARVIS 起来了" || echo "  ✗ JARVIS 起失败"
  sleep 6
fi

# ── 3. agent ──────────────────────────────────────────────────────
for p in "$@"; do
  if tmux has-session -t "agent_$p" 2>/dev/null; then
    echo "  ✓ $p 已在跑"
  else
    node bin/agent-start.js --name "$p" --type dev >/dev/null 2>&1 \
      && echo "  ✓ $p 起来了" || echo "  ✗ $p 起失败"
    sleep 4
  fi
done

# ── 4. ★ 主动查一个数字，不看「有没有报错」──────────────────────
#    bus 崩溃时 /health 可能照常 200。
#    「没有异常」和「看不见异常」长得一模一样，所以必须查具体的值。
echo
sleep 8
curl -s -m 8 "http://127.0.0.1:$PORT/api/agents" 2>/dev/null | python3 -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception: print('  ✗ /api/agents 没有返回 JSON —— bus 可能没真起来'); sys.exit(1)
n = d.get('sessions_seen')
print('  sessions_seen =', n, '(0 表示 watchdog 看不见 tmux，不是没有 agent)' if n == 0 else '')
for k, lab in (('live','在线'), ('heartbeat_lost','心跳丢'), ('deaf','失联'), ('stale','过期')):
    v = [x['name'] for x in d.get(k, [])]
    if v: print('  %-8s %s' % (lab, ', '.join(v)))
" 2>/dev/null

echo
echo "  控制台  http://127.0.0.1:$PORT"
echo "  bus     $BUSMODE 模式（node bin/launchd.js status 看详情）"
echo "  停止    ./stop.sh          （优雅，最长等一轮轮询）"
echo "          ./stop.sh --now    （立即，止损用）"
