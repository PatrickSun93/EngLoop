#!/usr/bin/env bash
# 停掉整个 EngLoop。
#
# ── 为什么有两个模式 ────────────────────────────────────────────
#   广播风暴（房间自激、多个进程一起空转）会很快烧光订阅额度。
#   **那种时候没时间等一轮 594 秒的优雅关停。**
#
#   默认   优雅：发 SHUTDOWN_REQUEST，等 agent 收好尾（最长一轮轮询）
#   --now  立即：直接 kill 会话。**止损用，会丢掉 agent 手上没发出的东西**
#          （消息不丢——它们还在 Redis 的 PEL 里，下次起来会重投）
# ────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")"

# ⚠️ 变量后面紧跟全角标点时一律写成 `${X}`，不写 `$X`。
#   macOS 自带的 bash 3.2 在 UTF-8 locale 下会把「）」的第一个字节（0xEF）也算进变量名：
#   `"（HTTP $CODE）"` 读的是一个叫 `CODE\xef` 的变量 ⇒ `set -u` 下脚本当场退出。
#   2026-10-30 实物：bus 接受了第一个 agent 的关停请求，脚本在打印「接受了」那行时崩掉，
#   剩下的 agent 一个都没收到请求。test/sh-var-boundary.test.js 扫所有 .sh 守着这条。

PORT="${ENGLOOP_PORT:-9969}"
MODE="graceful"
# 有一步没做成就记一笔，**不挡后面的步骤**，最后用非 0 退出码报出来。
STEP_FAIL=0
[ "${1:-}" = "--now" ] || [ "${1:-}" = "-f" ] && MODE="now"

sessions() { tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^(orch|agent_)' || true; }

echo "EngLoop 停止 — 模式: $MODE"
echo

# ── 1. agent ────────────────────────────────────────────────────
CUR=$(sessions)
if [ -z "$CUR" ]; then
  echo "  agent: 没有在跑的会话"
else
  echo "  agent: $(echo "$CUR" | tr '\n' ' ')"
  if [ "$MODE" = "graceful" ]; then
    # ── 关停端点要凭据 ──────────────────────────────────────────────
    #   `POST /api/agents/:name/shutdown` 挂着 busAuth.requireManage（bin/serve.js）。
    #   不带凭据 ⇒ 每个请求都 401 ⇒ 一条都没送到，而下面照样白等 660 秒再强杀。
    #   本机 CLI 的凭据是 bus 每次启动写出的 admin token（lib/auth.js 的 ADMIN_TOKEN_FILE，
    #   同一个环境变量、同一个默认路径），跟 bin/bus-restart.js、bin/agent-start.js 同一种用法：
    #   `Authorization: Bearer <token>`。
    #
    #   ⚠️ token 不进命令行参数（`ps` 看得见）：printf 是 bash 内建、不起进程，
    #     header 经管道进 curl 的 stdin（`-H @-`），argv 里只有「@-」两个字符。
    TOKEN_FILE="${ENGLOOP_ADMIN_TOKEN_FILE:-temp/bus-admin.token}"
    TOKEN=""
    if [ ! -r "$TOKEN_FILE" ]; then
      echo "    ✗ 读不到 bus 的 admin token（${TOKEN_FILE}）—— bus 没在跑，或者不是这份 checkout 起的"
    else
      TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")
      if ! [[ "$TOKEN" =~ ^[0-9a-f]{64}$ ]]; then
        echo "    ✗ admin token 格式不对（${TOKEN_FILE}）—— 重启 bus 会重写它"
        TOKEN=""
      fi
    fi

    ACCEPTED=""   # bus 回了 2xx 或 409 的会话 —— 只有它们值得等
    REJECTED=""   # 没送到的（其余状态码 / bus 无响应 / 没钥匙）
    for s in $CUR; do
      name="${s#agent_}"; [ "$s" = "orch" ] && name="JARVIS"
      printf "    关停 %-14s " "$name"
      if [ -z "$TOKEN" ]; then
        echo "✗ 没发（没有 admin token）"
        REJECTED="$REJECTED $name"
        continue
      fi
      RESP=$(printf 'Authorization: Bearer %s\n' "$TOKEN" \
        | curl -s -m 8 -w '\n%{http_code}' -H @- -X POST "http://127.0.0.1:$PORT/api/agents/$name/shutdown" \
            -H 'content-type: application/json' -d '{"reason":"stop.sh"}' 2>/dev/null)
      CODE="${RESP##*$'\n'}"
      BODY="${RESP%$'\n'*}"; [ "$BODY" = "$RESP" ] && BODY=""
      case "$CODE" in
        2[0-9][0-9]) echo "✓ bus 接受了（HTTP ${CODE}）"; ACCEPTED="$ACCEPTED $s" ;;
        # 409 = 这个 agent 之前收到的关停请求还在进行（bin/serve.js 按名字查 shutdownTracker.isPending）。
        #   它会自己走完四步，不走的话 bus 的 shutdownTracker 到时也会收掉 ⇒ 跟 2xx 一样等。
        #   当成「没送到」的话会直接强杀，把它正在做的收尾掐断（10-30 第二次跑 stop.sh 时 dev 就是这样被杀的）。
        409) echo "✓ 已经在关停中（HTTP 409，之前的请求还在进行）⇒ 照样等它"; ACCEPTED="$ACCEPTED $s" ;;
        *) [ -z "$CODE" ] || [ "$CODE" = "000" ] && CODE="000（bus 无响应）"
           echo "✗ 没送到（HTTP ${CODE}）$(printf '%s' "$BODY" | head -c 80)"
           REJECTED="$REJECTED $name" ;;
      esac
    done
    TOKEN=""

    # ★ 等待只对「请求被 bus 接受了」的会话有意义：没收到关停指令的 agent 不会自己走，
    #   等 660 秒只会白等。没送到的直接进下面的兜底强杀。
    [ -n "$REJECTED" ] && echo "    ✗ 这几个的关停请求没送到，不等它们，直接兜底强杀:$REJECTED"
    if [ -n "$ACCEPTED" ]; then
      waiting() { local cur; cur=$(sessions); for a in $ACCEPTED; do echo "$cur" | grep -qxF "$a" && echo "$a"; done; }
      # 等它们自己走完四步。最长一轮轮询 + 余量。
      echo "    等待收尾:${ACCEPTED}（最长 660 秒，Ctrl-C 可中断后用 --now）"
      # 每轮先查再睡 6 秒 ⇒ 第 i 轮查的时候已经等了 (i-1)*6 秒。
      for i in $(seq 1 110); do
        [ -z "$(waiting)" ] && { echo "    ✓ 被接受的都优雅退出了（约 $(( (i-1)*6 )) 秒）"; break; }
        printf "\r    还剩 %s 个 … %ss " "$(waiting | wc -l | tr -d ' ')" "$(( (i-1)*6 ))"
        sleep 6
      done
      echo
    else
      echo "    没有一个关停请求被接受 ⇒ 不等，直接兜底强杀"
    fi
  fi
  # 兜底 / --now：直接杀
  for s in $(sessions); do
    tmux kill-session -t "$s" 2>/dev/null
    # ★ 不信 kill 的返回值，回查事实
    if tmux has-session -t "$s" 2>/dev/null; then
      echo "    ✗ $s 仍在，has-session 说它还活着"
    else
      echo "    ✓ 已收 $s"
    fi
  done
fi

# ── 1.5 launchd ─────────────────────────────────────────────────
#
# ⚠️ 必须排在杀 bus **之前**。
#   launchd 的 job 开着 KeepAlive（OnDemand=false）时，
#   `pkill -9` 之后 launchd 立刻把它拉回来。那时三个判据
#   （无进程 / 端口空 / 页面不通）**全部为真** —— 而那个真只维持几秒。
#
#   ★ 查「当下的事实」不够，还要查**谁会让它回来**。
#
#   · label 只有一处（bin/launchd.js），这里现取，不写字面量。
#   · 只 bootout，**不删 plist**：文件在 = launchd 模式，下次 ./start.sh 会重新 bootstrap。
#   · 判「在册」用 `launchctl print gui/<uid>/<label>`（跟 bin/launchd.js、bus-restart.js 同一个问法），
#     不用 `launchctl list | grep`：子串匹配会把 <label>.别的 也认成它。
#
# ⚠️ 取不到 label（node 不在 PATH、launchd.js 坏了）⇒ **大声说，照样往下停 bus**。
#   这是止损脚本（--now 是给广播风暴准备的），不该因为 node 出问题就停住。在这里退出从来不比往下走好：
#     没装 launchd ⇒ 停 bus 就是对的；装了 ⇒ 停掉的会被 KeepAlive 拉回来，跟不停一样。
#   ⇒ 只记一笔 STEP_FAIL，最后退出码非 0。
if LABEL=$(node bin/launchd.js label 2>/dev/null) && [ -n "$LABEL" ]; then
  TARGET="gui/$(id -u)/$LABEL"
  if launchctl print "$TARGET" >/dev/null 2>&1; then
    echo
    echo "  launchd: $LABEL 在册（KeepAlive 会自动重启，先 bootout）"
    launchctl bootout "$TARGET" 2>/dev/null
    sleep 2
    if launchctl print "$TARGET" >/dev/null 2>&1; then
      echo "    ✗ 仍在册 —— 手动: launchctl bootout $TARGET"
      STEP_FAIL=$((STEP_FAIL+1))
    elif [ "$(node bin/launchd.js mode)" = "launchd" ]; then
      echo "    ✓ 已 bootout。plist 留着 ⇒ 仍是 launchd 模式：下次 ./start.sh 会重新 bootstrap"
      echo "      （不想要 launchd 了：node bin/launchd.js uninstall）"
    else
      echo "    ✓ 已 bootout。plist 已经不在 ⇒ 下次 ./start.sh 走 nohup"
    fi
  fi
else
  echo
  echo "  ✗ launchd: 取不到 label（node bin/launchd.js label 失败）—— 查不了 bus 是不是 launchd 托管的"
  echo "    照样往下停 bus。如果装了 launchd，bus 会被 KeepAlive 拉回来 —— 手动跑："
  echo "      launchctl bootout gui/$(id -u)/<label>    （label 见 bin/launchd.js 里的 LABEL）"
  STEP_FAIL=$((STEP_FAIL+1))   # 取不到 label：记一笔，照样往下停 bus
fi

# ── 2. bus ──────────────────────────────────────────────────────
#
# ⚠️ 按进程找，不是按端口找。
#   按端口找（`lsof -ti :PORT -sTCP:LISTEN | head -1`）只杀得到监听端口的那一个 ——
#   而可能有**两个** serve.js 在跑。脚本会报「✓ 端口已释放」，watchdog 和页面照常活着。
#   **「端口空了」不等于「bus 停了」**，第二个实例没抢到端口但仍在跑
#   自己的 setInterval（watchdog、房间扇出、relay 同步全在里面）。
echo
BUSPIDS=$(pgrep -f "bin/serve.js" || true)
if [ -z "$BUSPIDS" ]; then
  echo "  bus: 没有在跑的进程"
else
  echo "  bus: $(echo "$BUSPIDS" | tr '\n' ' ')"
  for p in $BUSPIDS; do kill "$p" 2>/dev/null; done
  for i in $(seq 1 15); do
    pgrep -f "bin/serve.js" >/dev/null || break
    sleep 1
  done
  if pgrep -f "bin/serve.js" >/dev/null; then
    echo "    SIGTERM 后 15 秒仍在，强杀"
    pkill -9 -f "bin/serve.js" 2>/dev/null
    sleep 2
  fi
  # ★ 三个判据都查 —— 少查一个就会漏掉上面那种情况
  pgrep -f "bin/serve.js" >/dev/null \
    && echo "    ✗ 仍有 serve.js 进程" || echo "    ✓ 无 serve.js 进程"
  # ★ 只看 127.0.0.1 上的监听：bus 只绑 127.0.0.1，而别的地址上可能有不相干的进程
  #   监听同一个端口 —— `lsof -ti :PORT` 会把它也算上（bus 已停，这里却报 ✗）。
  lsof -nP -iTCP@127.0.0.1:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1 \
    && echo "    ✗ 127.0.0.1:$PORT 仍被监听" || echo "    ✓ 127.0.0.1:$PORT 已释放"
  curl -s -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 \
    && echo "    ✗ 页面仍有响应" || echo "    ✓ 页面已停"
fi

# ── 3. 状态残留（不清 Redis —— 消息和历史要留着）────────────────
echo
LEFT=$(sessions | wc -l | tr -d ' ')
echo "  剩余 agent 会话: $LEFT"
echo "  Redis 未动 —— 未 ack 的消息留在 PEL，下次启动会重投"
echo
[ "$LEFT" = "0" ] || { echo "✗ 还有 $LEFT 个没停干净"; exit 1; }
if [ "$STEP_FAIL" -gt 0 ]; then
  echo "✗ agent 和 bus 那几步跑完了，但有 $STEP_FAIL 步没做成（看上面的 ✗）"
  exit 1
fi
echo "✓ 已全部停止"
