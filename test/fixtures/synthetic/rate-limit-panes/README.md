# `synthetic/rate-limit-panes/` —— 喂给 `watchdog` 出口解析器的**合成**样本

> 这些 `.txt` 是**造出来的**，不是从生产 pane 截的。它们替代 `test/fixtures/rate-limit-panes/`
> 里那几份真实样本（真实的那份不进公开版，内容是真实会话）。测试在私有仓库和公开版里**都读这一份**。
>
> ⚠️ 一个字节都不许随手加：文件头说明写在这里，不写进样本 —— 往样本里加一行，就是改了被测的输入。

## 🔴 `cat` 它们不安全

它们都会命中 `RATE_LIMIT_RE`（那是它们的用途）。打印到任何 agent 的 pane 里，
会让 watchdog 把那个 agent 判成撞了限额。用程序读，只输出属性（长度 / 位置 / 解析结果）。

## 每一份保住了真实样本的哪些结构

判据靠的是**结构**，不是那些行的文字。合成时保住的是判据依赖的每一项：

| 文件 | 行数 | resets 行 | 第一个 IANA 形状 | 判据靠它验什么 |
|---|---|---|---|---|
| `line-only.txt` | 1 | `2:10pm (America/Los_Angeles)` | `America/Los_Angeles` | 一行里读得出时区（它是 pane 里的一行，不是一份 pane） |
| `40lines-orch.txt` | 40 | 行 32 · `7:10pm` | `temp/outbox` | 整段取第一个 IANA 形状会取到文件路径 ⇒ 时区解析必须锚定在 resets 行 |
| `40lines-agent.txt` | 40 | 行 32 · `7:10pm` | `bin/next` | 同上，第二个污染源 |
| `39lines-agent-two-digit-hour.txt` | 39 | 行 30 · `12:10pm` | `bin/next` | 两位数小时；重置时刻在被发现之前就过了（陈提示） |
| `multi-reset.txt` | 50 | 行 9 `12:10pm` · 行 25 / 32 `6:50pm` | `bin/next` | 多行 resets 时取**最后**那个（取第一个的实现在这份上给出 12:10pm） |

另外五份共同的：文案是不带介词的形状（`RESET_TIME_RE[1]` 命中，`RESET_TIME_RE[0]` 不命中）；
resets 行上只有一个合法时区名。

## 它们验不了什么

真实 pane 里那些**我们没想到的**行（别的污染形状、别的文案变体）—— 合成样本只装得下我们想到的。
上游文案一变，这里不会自己跟着变；那时要回到真实 pane 上去量，再按上表的结构补一份合成的。
