#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
改仓库文件的**补丁脚本骨架**（python 版）。

    ✅ **用法（推荐）：`import` 它，别复制它** —— 三行，十道检查全在：

            import sys; sys.path.insert(0, '<ROOT>/scripts')
            from patch_template import apply
            apply(F, SUBS)          # SUBS = [(锚点, 新内容, '这一处叫什么'), …]

    🔴 **而那条绝对路径是一个【前提】，不是一句事实**
       （**一句被写成事实的前提，不会被当成需要检查的东西**）：
         **前提：调用它的那个补丁脚本，住在【仓库外面】（scratchpad）。**
       ⇒ ⇒ 所以这里**不能**用 `require('../scripts/…')` 那种更好的解
         （相对于**文件自己的位置**、完全不依赖 cwd）——
         **因为「文件自己的位置」在仓库外，`../` 指不回来。**
       ✅ 而若哪天补丁脚本落在**仓库里**（例如 `temp/patch_x.py`），那时正确写法是：
         `sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'scripts'))`
         ⇒ ⇒ 那一版**不依赖 cwd 也不依赖 ROOT 常量**，比现在这条强。
       📌 判据钉在 `test/patch-template.test.js`【1-9..1-11】：
         【1-10】从**另一个 cwd** 照上面那三行真跑一次 ·【1-11】写成相对 `scripts` **必须失败**。

    ⚠️ **备选**：`cp scripts/patch_template.py "$SP/patch_x.py"` 之后改 `F` / `SUBS`。
       🔴 而 `cp` **是复刻的一种**，只是它复刻得比记忆准：
          副本跟源头之间**没有连接** —— 源头改了它不会跟着改，而它**看起来**是同一个东西。
          （三层分法：名字 ⇒ `CLAUDE.md` · **实现 ⇒ `scripts/`（被 import）**
            · self-test ⇒ `test/` ——「被 import」是**唯一一种不复刻的连接」**。）
    🔴 而文件名用**下划线**不是风格：**python 不能 `import` 带连字符的模块名**，
       而 `importlib.util.spec_from_file_location` 那一套是四行 ——
       ⇒ ⇒ **「一行 import」和「四行 importlib」的差别，正好是这条路会不会被走。**

🔗 **另一份在 `scripts/patch-skeleton.js`（node 版，self-test 在
   `test/patch-skeleton.test.js`）。** 两份做同一件事，**不要强行统一** ——
   这一行只为了「下一个人在其中一份里，知道另一份存在」。
   通用的是**这些检查的名字和顺序**，不是代码。
   🔴 而**引用时用名字，不用编号**（`【重新数】`，不是「第 ⑤ 步」）——
      同一件事在两份文件里的编号可以不同（一个是 ③、一个是 ⑤），
      而两份都写着「六步」⇒ 说「第 ⑤ 步」时，读另一份的人会去看另一件事。

────────────────────────────────────────────────────────────────────────
🔬 **这个文件为什么存在**

    单独跑一次 `anyBusy()` ⇒ **false** ⇒ 「地板是空的，可以动手」
    而从那一刻到按下执行之间，别人可能已经起跑了全量
    ⇒ ⇒ 脚本里的 `【busy】` 在写盘前再查一次 ⇒ 有人在跑就退 3 ⇒ **一个字节都不写**

    ★ 它挡的那一格有名字：**「凭据活得比它的条件久」**
      单独跑一次 `anyBusy()` = **一张有时效的通行证**
      放进脚本里     = **它跟着每一次写盘发生**
    🔴 而它不靠「记得遵守规矩」：复制或 import 这个模板，那几行就跟着来了。
      ⇒ ⇒ 所以这个文件的全部价值就是 **`【busy】` 那几行原样躺在里面**。

🔴 **它在 git 里，不在 scratchpad 里** ——
   **scratchpad 比 pane 还短命，它连一个会话都不一定活得过。**
   ⇒ 一个有效的防护不能躺在一个会消失的载体上。

────────────────────────────────────────────────────────────────────────
✅ **自证：`python3 scripts/patch_template.py --self-test`**

   六道检查**每一道都有一个正控**（喂一个「它应该抓住」的输入，看它抓不抓得住）。
   其中 `【重新数】` 那道是 **①档**：喂的是一次真实改坏 `test/bus-restart.test.js`
   的那个形状（新内容里逐字包含下一个锚点）。其余五道是 **②档**（构造的）。
   ⇒ 而这一步不是洁癖：**一个从没响过的防护，没有证据说它会响**（「纸上成立」
     的防护常见的死法：恒假 · 恒真 · 落错 db · 报了错的原因）。
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # scripts/ 的上一层 = 仓库根

# ══════════════════════════════════════════════════════════════════════
# ⬇⬇⬇  你只改这两处  ⬇⬇⬇
# ══════════════════════════════════════════════════════════════════════

F = os.path.join(ROOT, 'test', '改成你要动的那个文件.js')

SUBS = [
    # (锚点, 新内容, 这一处叫什么)
    #
    # 🔴 顺序有讲究：**先换活代码，再插注释** ——
    #    把被替换掉的原文抄进注释当文档是这个仓库的写法，
    #    而那会让「新内容里逐字包含下一个锚点」**必然发生**（见 `【重新数】`）。
    #
    # ('原文…', '新内容…', '① 干什么'),
]

# ══════════════════════════════════════════════════════════════════════
# ⬆⬆⬆  下面不用改  ⬆⬆⬆
# ══════════════════════════════════════════════════════════════════════


def size(s):
    """★【两个单位】python 的 len(str) 数的是**字符** —— 中文低估三倍。
    只看字符数，很容易以为一份文件少了一半。"""
    return '%d 字符 / %d 字节' % (len(s), len(s.encode('utf-8')))


def _busy_probe():
    g = subprocess.run(
        ['node', '-e',
         "const b=require('./lib/busy');const r=b.anyBusy();"
         "process.stdout.write(JSON.stringify({busy:r.busy,reason:r.reason,who:r.who}))"],
        cwd=ROOT, capture_output=True, text=True)
    import json
    try:
        return json.loads(g.stdout)
    except Exception:
        # 🔴 查不了 ≠ 没人在忙 —— fail-closed
        return {'busy': True, 'reason': 'probe_failed', 'who': ['(查不了)'],
                'stderr': (g.stderr or '')[:200]}


def guard_busy(probe=_busy_probe):
    """★【busy】有人在跑长任务就**一个字节都不写**。

    ⚠️ 而它的射程边界要一起记：`anyBusy()` 只看**declare 过的长任务** ——
       它**答不了**「有没有人正在写文件」（写文档的人不会为写文档去 declare）。
       ⇒ 所以它挡住的是「跟一个宣告过的长任务撞车」，**不是全部撞车**。
       ⇒ ⇒ 那一半靠**先在房间里喊一声**，没有别的办法。
    """
    import json
    st = probe()
    print(('⛔ 有人在跑' if st['busy'] else '✅ 没人在跑')
          + ' （reason=%s who=%s）' % (st.get('reason'),
                                      json.dumps(st.get('who'), ensure_ascii=False)))
    if st['busy']:
        sys.exit(3)


def _git_status(path):
    rel = os.path.relpath(path, ROOT)
    return subprocess.run(['git', 'status', '--porcelain', '--', rel],
                          cwd=ROOT, capture_output=True, text=True).stdout.strip()


def guard_mine(path, status_fn=None):
    """★【mine】落盘前再确认一次：**这个文件从 HEAD 起没人动过**。

    理由不是洁癖：按规矩要先**在房间里喊过「我要动这个文件」**才动手 ——
    而万一在那之后有人抢先改了它，我这一笔会**静默地把他的改动覆盖掉**
    （我的 `【命中数】` 只验锚点在不在，锚点在别人改过的文件里照样在）。

    ⚠️ 它答的是「跟 HEAD 比动没动」，**不是「是不是我动的」** ——
       我自己的上一笔没提交时它也会红。那时候看一眼 diff 再决定，别直接放行。
    """
    d = (status_fn or (lambda: _git_status(path)))()
    if d:
        print('🔴 %s 已经被改过了：%r —— 而我喊过要改它 ⇒ 先去问，不写盘'
              % (os.path.basename(path), d))
        sys.exit(3)
    print('✅ %s 跟 HEAD 一致（没人在改）' % os.path.basename(path))


# 🔴 **这个串必须每次运行现生成** —— 不能是字面量，**也不该是一个固定的常量**。
#   **拼接**（`'a' + 'b'`）不够：拼出来的**仍然是一个固定的串** ——
#      哪天有谁把它整条写进某个文件，误报就回来了，而那时没人记得为什么。
#      而**现生成**的串**不可能**事先出现在任何文件里 ⇒ ⇒ **自指从根上消失**。
#   ★ node 版和 python 版**各自独立**会撞上同一个自指缺陷 ——
#     ⇒ ⇒ 所以它不是谁的手滑，是「**哨兵住在它要检查的文件里**」这个形状本身的性质。
# ── 这个坑长什么样 ─────────────────────────────────────────────────────
#   哨兵要是一整条字面量，拿这个模板去改**它自己**时，`【正控】` 会在本文件里命中 1 处 ⇒ **误报**：
#     「🔴 正控失败：一个不该存在的串命中了」，一个字节没写。
#   ★ 它红得**对**（fail-closed），只是红的**原因**不是它想报的那个 ——
#     而「响了，但报的是错的原因」也是一种坏防护。
def _nonsense():
    import time, os as _os
    return ('\u200b<<正控·' + str(time.time_ns()) + '·'
            + _os.urandom(6).hex() + '>>\u200b')


def _count_as_line(src, anchor):
    """把锚点当**整行**数：只有「行首 … 行尾」完全对上才算一处。

    ⇒ 它和 `src.count()` 的差在于**行边界**：`            n = x`（12 空格）
      包含 `        n = x`（8 空格）作为子串，而作为整行它们是两行不同的东西。
    """
    if '\n' in anchor.strip('\n'):
        return None                      # 多行锚点，这个口径不适用
    a = anchor.strip('\n')
    return sum(1 for line in src.split('\n') if line == a)


def _resolve(p):
    """相对路径按 **ROOT** 解析，不按 cwd。

    🔴 node 版的同一个坑：写 `require('./scripts/patch-skeleton')`，而补丁脚本在 `temp/` ⇒ 去找了
      `temp/scripts/…` ⇒ `MODULE_NOT_FOUND`。
    ⇒ 这边同一个形状是：补丁脚本可能从任何 cwd 跑起来，而 `F` 常常写成相对路径。
    """
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


def apply(path, subs, check_busy=True, check_mine=True, status_fn=None):
    """跑完全部检查 ⇒ 才写盘。返回 (旧串, 新串)。

    ★【staged】边验边写会在半路留下一个**改坏了的文件** ——
       全部通过之后一次性落，失败时磁盘上一个字节都没变。
    """
    if check_busy:
        guard_busy()
    path = _resolve(path)
    if check_mine:
        guard_mine(path, status_fn=status_fn)

    src = open(path, encoding='utf-8').read()
    orig = src

    # ★【正控】先搜一个**不存在**的串 —— 它必须是 0。
    #   ⚠️ ②档（构造的）：它验的是「count 不会命中一切」，
    #      **验不了**「我的锚点写对了」。别把它当成后者。
    bogus = _nonsense()
    if src.count(bogus) != 0:
        print('🔴 正控失败：一个不该存在的串命中了 —— 计数机制本身有问题，不写盘')
        sys.exit(1)

    for i, sub in enumerate(subs):
        old, new, tag = sub[0], sub[1], sub[2]
        if len(sub) > 3 and sub[3] == 'all':
            # ★【改完剩 0】改名字用这个 —— 见 `【命中数】` 旁边那条边界
            n = src.count(old)
            if n == 0:
                print('🔴 %s：一处都没命中 —— 不写盘' % tag)
                sys.exit(1)
            src = src.replace(old, new)
            if src.count(old) != 0:
                print('🔴 %s：全替换之后还剩 %d 处 —— 不写盘' % (tag, src.count(old)))
                sys.exit(1)
            print('✅ %s：全替换 %d 处，剩 0' % (tag, n))
            continue
        # ★【命中数】是「**恰好 1 次**」，不是「找得到」。
        #   ⚠️ 而它有一条**适用边界**：
        #     「恰好 1 次」适合**改一个锚点**；而**改一个名字**（同一个串出现 N 处）时，
        #     它要人**事先猜准 N** ⇒ 很容易猜错（漏一处 · 猜 6 处其实 5 处）。
        #     ✅ 那种活用第四个元素 `'all'`：**全替换 ＋ 断言替换后剩 0 处** ——
        #        事后确认「没剩」，而不需要事先知道有几处。
        #   ⇒ 「以为改一处、其实改了三处」和「锚点漂了、一处都没改」**都会当场停**。
        #   ⚠️ 而它防不住的那格：**锚点写错但恰好唯一命中** ⇒ 只有跑判据才发现。
        n = src.count(old)
        if n != 1:
            print('🔴 %s：在**当前串**里命中 %d 次，应当 1 —— 一个字都不写' % (tag, n))
            print('   锚点 = %r' % (old[:120] + ('…' if len(old) > 120 else '')))
            # ★ 而只报「命中 2 次」会把人推向**加长锚点**，而不是看见成因。
            #   判据：**子串数 ≥ 2 而「整行」数恰好 1** ⇒ 成因只有一个：
            #     有一句**缩进更深**的同一行，逐字包含了这个锚点。
            #   🔴 ①档：真实出现过的形状（12 空格那行包含 8 空格的锚点）。
            #   ★ 而这一格要记的不只是这个判据，还有那句：**位置是稀缺的，判据不是** ——
            #     「这个**判据**判不准」不等于「这个**位置**挂不了」。
            #     ⇒ ⇒ **放弃一个位置之前，先换一个判据再试一次。**
            if n >= 2 and _count_as_line(src, old) == 1:
                print('   ⚠️ 而「整行」只命中 1 次 ⇒ **有一句缩进更深的同一行逐字包含了锚点**')
                print('   ✅ 修法：锚点带上前后换行（或先换活代码、再插注释），别去加长它')
            sys.exit(1)
        print('✅ %s：命中 1' % tag)
        src = src.replace(old, new)

        # ★【重新数】🔴 ①档 —— `test/bus-restart.test.js` 真的这样被改坏过：
        #   `src.replace(A, A2).replace(B, B2)`，而 **A2 里逐字包含 B**
        #   （把被替换掉的原文抄进注释当文档 —— 那是这个仓库的写法）
        #   ⇒ 第二次 replace 换掉了**刚写的那句注释** ⇒ 文件红（`ReferenceError`），
        #   ⇒ ⇒ 而 count 守卫**验的是原始串** ⇒ **它一声没吭**。
        #   ✅ 所以每一步之后，在**当前串**上重新数一遍后面所有的锚点。
        #
        #   🔴 ⚠️ **而这一圈前瞻没有独立的探测力** ——
        #      因为上面 `【命中数】` 已经在**当前串**上数了，走到第二处时它自己会看见「2 处」。
        #      `test/patch-template.test.js`【1-6】钉着这个现状：**单独关掉任何一道，
        #      self-test 仍然 9/0；两道一起关，①档那道才变红。**
        #      ⇒ ⇒ 所以它的价值是**诊断**（提前一步 ＋ 说出成因），不是探测。
        #      ★ 把它**当成探测**的话，会写出一条恒真的负控，
        #        并把它的绿读成「这段代码是必要的」。
        #   ⚠️ 用 `enumerate` 的 `i`，**别用 `subs.index(...)`** ——
        #      两处内容碰巧相同时 `index()` 回的是**第一个**，于是它会重复检查前面那段、
        #      而把真正在后面的那处**跳过去** ⇒ 一个只在特定输入下才发生的漏检。
        for old2, _new2, tag2 in subs[i + 1:]:
            m = src.count(old2)
            if m != 1:
                print('🔴 【重新数】%s 之后，后面那个锚点 %s 在当前串里变成 %d 处（应当 1）'
                      % (tag, tag2, m))
                print('   ⇒ 多半是**新内容里逐字包含了它**（把原文抄进注释时必然发生）')
                print('   ✅ 修法：先换活代码、再插注释；或把注释里的副本改掉一个字')
                sys.exit(1)

    # ★【语法】🔴 **在写盘之前**验，不在写盘之后。
    #
    #     **「一个检查放在动作【之后】，它就不是 guard 了 —— 它是事后报告。**
    #       而两者在输出里一模一样：都是一行带 ✅/🔴 的字。」**
    #   🔴 ①档：顺序要是「写盘 ⇒ `node --check` ⇒ 红 ⇒ `sys.exit(1)`」
    #     ⇒ ⇒ **那个坏文件已经在盘上了**，只能 `git checkout --` 收拾。
    #   ✅ 改法：把新内容先写到一个**临时文件**，在那上面 `node --check`，
    #     过了才写目标 ⇒ ⇒ 失败时磁盘上目标文件**一个字节都没变**。
    if path.endswith('.js'):
        import tempfile
        fd, probe = tempfile.mkstemp(suffix='.js')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                fh.write(src)
            r = subprocess.run(['node', '--check', probe], capture_output=True, text=True)
        finally:
            try: os.unlink(probe)
            except OSError: pass
        # ★【表达式】结论行是**表达式的值**，而且**把输入印在同一行** ——
        #   `print('✅ 语法')` 写在 if 里的话，它印的是写的人**以为**的那个分支。
        print(('✅ 语法（写盘前）' if r.returncode == 0 else '🔴 语法坏了，**没写盘** ')
              + os.path.basename(path)
              + ('' if r.returncode == 0 else '  → ' + (r.stderr or '')[:300]))
        if r.returncode != 0:
            sys.exit(1)

    open(path, 'w', encoding='utf-8').write(src)
    d = len(src.encode('utf-8')) - len(orig.encode('utf-8'))
    print('✅ 落盘 %s：%s → %s（%+d 字节）'
          % (os.path.basename(path), size(orig), size(src), d))

    # ── 下面这段是**被换掉的旧顺序**，留着解释它为什么错 ────────────────
    # ★【语法】.js 改完当场 `node --check` —— 它比跑判据快，而且错得更清楚。
    #   🔴 **而它只验语法，不验绑定**（`--check` 通过的文件照样会崩）：
    #     它检不出 **未定义的变量**（`fs is not defined`）· **不存在的方法**（`os.realpathSync`）
    #     · **拼错的属性名**（`during_run` / `h.at`）
    #   ✅ 唯一便宜的地方：那三样都 **fail-loud**（当场崩），不是恒绿
    #   ⇒ 而补它的动作是：**动手前把被断言的东西 `console.log(Object.keys(x))` 打出来**
    #   （旧顺序逐字如下，**它是注释，不是代码** ——
    #     它要是留成**活代码**，就会在写盘之后**再跑一次** `node --check`：
    #     说它「留着解释」，而它其实还在执行。
    #       ⇒ ⇒ **一段被称作注释的代码，跟一段注释在文件里长得不一样，而在读的人眼里一样。**）
    #
    #       if path.endswith('.js'):
    #           r = subprocess.run(['node', '--check', **path**], …)   ← 验的是**已经写下去的**那个
    #           if r.returncode != 0: sys.exit(1)                      ← 而坏文件已经在盘上了

    # ★【UTC】报时刻用 ISO ——「自带 Z」比「记得加时区」可靠。
    #   裸的本地时（`06:36:04`）在一屋子用 UTC 的人那里
    #   会被直接读成 `06:36Z` ⇒ **差 7 小时**。
    import datetime
    mt = datetime.datetime.fromtimestamp(
        os.path.getmtime(path), datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
    print('🕐 mtime %s' % mt)
    return orig, src


# ══════════════════════════════════════════════════════════════════════
#  自证：六道检查各喂一个「它应该抓住」的输入
# ══════════════════════════════════════════════════════════════════════

def _self_test():
    import tempfile
    ok = fail = 0

    def case(name, fn, want_exit, note):
        nonlocal ok, fail
        try:
            fn()
            got = 0
        except SystemExit as e:
            got = e.code or 0
        good = got == want_exit
        print(('  ✓ ' if good else '  ✗ ') + name + '  （退出码 %s，应当 %s）%s'
              % (got, want_exit, note))
        if good:
            ok += 1
        else:
            fail += 1

    d = tempfile.mkdtemp(prefix='patch-template-selftest-')
    p = os.path.join(d, 'x.js')
    BASE = 'const a = 1;\nconst b = 2;\nconst c = 3;\n'

    def fresh():
        open(p, 'w', encoding='utf-8').write(BASE)

    print('\n【正控】六道检查，每道喂一个「它应该抓住」的输入')

    # ── 【busy】②档（构造）：注入一个「有人在跑」的读数 ──────────────
    case('【busy】有人在跑 ⇒ 退 3',
         lambda: guard_busy(probe=lambda: {'busy': True, 'reason': 'running',
                                           'who': ['JARVIS']}),
         3, ' ②档·构造')
    case('【busy】没人在跑 ⇒ 放行',
         lambda: guard_busy(probe=lambda: {'busy': False, 'reason': 'all_stale',
                                           'who': []}),
         0, ' ②档·构造（阴性对照）')
    case('【busy】查不了 ⇒ **也**退 3（fail-closed）',
         lambda: guard_busy(probe=lambda: {'busy': True, 'reason': 'probe_failed',
                                           'who': ['(查不了)']}),
         3, ' ②档·构造')

    # ── 【mine】②档 ─────────────────────────────────────────────
    case('【mine】文件跟 HEAD 不一致 ⇒ 退 3',
         lambda: guard_mine(p, status_fn=lambda: ' M test/x.js'),
         3, ' ②档·构造')
    case('【mine】干净 ⇒ 放行',
         lambda: guard_mine(p, status_fn=lambda: ''),
         0, ' ②档·构造（阴性对照）')

    # ── 【命中数】②档：0 处 / 2 处 ────────────────────────────────
    fresh()
    case('【命中数】锚点 0 处 ⇒ 退 1，且**文件没被动过**',
         lambda: apply(p, [('不存在的锚点', 'X', '① 测试')],
                       check_busy=False, check_mine=False),
         1, ' ②档·构造')
    assert open(p, encoding='utf-8').read() == BASE, '🔴 失败时文件被改了'

    fresh()
    open(p, 'w', encoding='utf-8').write(BASE + 'const b = 2;\n')
    case('【命中数】锚点 2 处 ⇒ 退 1',
         lambda: apply(p, [('const b = 2;', 'const b = 9;', '① 测试')],
                       check_busy=False, check_mine=False),
         1, ' ②档·构造')

    # ── 【命中数·成因】🔴 ①档：缩进更深的同一行 ─────────────────────
    #   `            n = x`（12 空格）逐字包含
    #   `        n = x`（8 空格）⇒ 子串数 2，而整行数 1。
    fresh()
    open(p, 'w', encoding='utf-8').write('        n = x;\n            n = x;\n')
    case('【命中数】子串 2 · 整行 1 ⇒ 退 1，且**指出成因**',
         lambda: apply(p, [('        n = x;', '        n = y;', '① 测试')],
                       check_busy=False, check_mine=False),
         1, ' 🔴 ①档·缩进更深的同一行')
    case('【_count_as_line】整行口径：12 空格那行不算',
         lambda: sys.exit(0 if _count_as_line(
             '        n = x;\n            n = x;\n', '        n = x;') == 1 else 1),
         0, ' 🔴 ①档·同一个输入')

    # ── 【重新数】🔴 ①档：回放那个真实改坏过文件的形状 ─────────────
    #   新内容里**逐字包含**下一个锚点（把原文抄进注释当文档时必然发生）
    fresh()
    case('【重新数】🔴 新内容里逐字包含下一个锚点 ⇒ 退 1',
         lambda: apply(p, [
             ('const a = 1;', 'const a = 11;\n// 原来是 const b = 2; —— 抄进注释当文档', '① 活代码'),
             ('const b = 2;', 'const b = 22;', '② 下一处'),
         ], check_busy=False, check_mine=False),
         1, ' 🔴 ①档·真实改坏过文件的形状')
    assert open(p, encoding='utf-8').read() == BASE, '🔴 失败时文件被改了'

    # ── 阴性对照：正常两处替换要能过 ────────────────────────────────
    fresh()
    case('【全绿】正常两处 ⇒ 写盘',
         lambda: apply(p, [('const a = 1;', 'const a = 11;', '① 一'),
                           ('const b = 2;', 'const b = 22;', '② 二')],
                       check_busy=False, check_mine=False),
         0, ' 阴性对照')
    got = open(p, encoding='utf-8').read()
    assert got == 'const a = 11;\nconst b = 22;\nconst c = 3;\n', '🔴 落盘内容不对：%r' % got

    # ── 【正控·现生成】哨兵不许是常量 ─────────────────────────────────
    #   ②档（构造）。而它守的是**误报**那一侧：一个固定的哨兵串，哪天被谁整条
    #   写进某个文件，`【正控】` 就会在那个文件上永远报红 —— 而报的原因是错的。
    a1, a2 = _nonsense(), _nonsense()
    case('【正控】哨兵**每次现生成**（两次不相等）',
         lambda: sys.exit(0 if a1 != a2 else 1), 0, ' ②档·构造')
    case('【正控】哨兵**不在模板自己里**（自指为 0）',
         lambda: sys.exit(0 if open(__file__, encoding='utf-8').read().count(a1) == 0 else 1),
         0, ' 🔴 ①档·拿模板改自己时会误报的形状')

    # ── 【语法·写盘前】🔴 ①档：「写盘 ⇒ node --check ⇒ 红 ⇒ exit」会留下坏文件 ──
    #   那种顺序下 ⇒ ⇒ **坏文件已经在盘上**。
    #   这一条喂一个**会产生语法错**的替换，然后断言：退 1 **且目标文件逐字未变**。
    fresh()
    case('【语法】新内容有语法错 ⇒ 退 1，且**目标文件一个字节没变**',
         lambda: apply(p, [('const a = 1;', 'const a = (((;', '① 造语法错')],
                       check_busy=False, check_mine=False),
         1, ' 🔴 ①档·写盘后才验语法会留下坏文件的形状')
    assert open(p, encoding='utf-8').read() == BASE, '🔴 语法错时文件被写了'

    # ── 【_resolve】相对路径按 ROOT，不按 cwd ─────────────────────────
    case('【_resolve】相对 ⇒ 拼 ROOT · 绝对 ⇒ 原样',
         lambda: sys.exit(0 if (_resolve('test/x.js') == os.path.join(ROOT, 'test/x.js')
                                and _resolve('/tmp/x.js') == '/tmp/x.js') else 1),
         0, ' 🔴 ①档·按 cwd 解析相对路径导致 MODULE_NOT_FOUND 的同形')

    import shutil
    shutil.rmtree(d, ignore_errors=True)
    print('\n  通过 %d · 失败 %d' % (ok, fail))
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        sys.exit(_self_test())
    if not SUBS:
        print('🔴 `SUBS` 是空的 —— 你多半是直接跑了模板本身。')
        print("   ✅ 推荐：import 它 —— sys.path.insert(0, '<ROOT>/scripts')"
              " ⇒ from patch_template import apply ⇒ apply(F, SUBS)")
        print('   ✅ 或者 `python3 scripts/patch_template.py --self-test` 看十道检查会不会响')
        sys.exit(2)
    apply(F, SUBS)
