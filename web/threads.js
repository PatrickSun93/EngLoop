'use strict';

/**
 * 把一条平铺的房间消息流摞成「根 + 回复」两层。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────
 * 这段逻辑最容易错的地方**不是「代码写没写」，是「拿到畸形输入时怎么办」**：
 * 父消息不在这批里、父子互指成环、reply_to 指向自己。**那些都是行为，
 * 而 `test/` 对 `web/app.js` 只能做源码断言**（读文件 + 正则）——
 *
 *   > 源码断言验得了「这个函数存在」，**验不了它拿到孤儿回复会不会把它吃掉**。
 *
 * 所以抽出来做 UMD 双导出：浏览器 `<script>` 拿 `window.Threads`，
 * 测试 `require()` **真的执行它**。
 *
 * ⚠️ **不要在 app.js 里再写一份**。同 `test/history.test.js` 里那条：
 *   「分隔符只该有一处出处 —— 测试自己拼就是第二份实现」。
 *   两份实现的分组逻辑会各自漂移，而**漂移的表现是「刷新前后消息位置不一样」**，
 *   没有任何报错。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Threads = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * 上溯找根。返回根的 id；找不到父就返回当前这条自己的 id。
   *
   * @param {object} entry  这条消息
   * @param {Map} byId      这批消息 id → 消息
   * @param {object} [merges] 合并映射 `{根A: 根B}`。不传 = 只沿 reply_to 上溯。
   *
   * ══════════════════════════════════════════════════════════════
   * ★★★ **这个函数有两种前进方式，而它们必须共用同一个 `seen`。**
   *
   *   ```
   *   ① 沿 reply_to 往上   —— 消息树本来就有的
   *   ② 沿合并映射跳过去 —— 「这个话题并进了那个话题」
   *   ```
   *
   *   ⚠️ 只针对 reply_to 的环保护只挡得住 ①（`post()` 明确 reply_to **只存不验**，
   *   流里可以合法存在 A→B→A）。**合并映射是另一条成环路径**：
   *   A 并入 B、B 又并入 A —— 而那条路径上一条 `reply_to` 都没有，
   *   只管 reply_to 的 `seen` 完全碰不到它。
   *
   *   ⚠️⚠️ 而且注意 ② 让循环**不再只在「有 reply_to」时前进**：
   *   一条没有父的根，也可能因为被并入而要继续跳。所以这里是
   *   `for(;;)` + 两个 continue，不是 `while (cur.reply_to)` ——
   *   **把映射塞进 while 条件里是不够的**，那样没有 reply_to 的根
   *   根本进不了循环。
   *
   *   漏掉任何一半的后果都一样：浏览器卡死在循环里，
   *   而症状是**「点开房间一片空白」—— 跟「这个房间是空的」长得一模一样**。
   *
   * ★ 服务端（`lib/thread-merge.js`）**也**会拒绝成环的合并。那不是重复：
   *   那一层让人立即看到错误、能改；这一层保证**数据已经坏了的时候**
   *   （手工改表、旧版本写入、别的路径）房间还画得出来。
   *   只做任何一层都不够，理由写在那个文件头上。
   * ══════════════════════════════════════════════════════════════
   */
  function rootIdOf(entry, byId, merges) {
    if (!entry) return null;
    let id = entry.id;
    let node = entry;
    const seen = new Set();

    for (;;) {
      if (id == null || seen.has(id)) break;   // ← 两种跳转共用这一个 seen
      seen.add(id);

      // ① 沿 reply_to 上溯。
      //   ★★ 父不在这批里（history 只拉了 200 条，父被截断了）→ 不走这条 ——
      //   当前这条就当根。**绝不能因为「找不到父」就把它丢掉**，那是静默丢消息，
      //   而人看到的是「我明明回过这条，它不见了」。
      //   （落不到这条时还要再问一次 ②：一个孤儿根同样可能被并走。）
      if (node && node.reply_to != null && byId.has(node.reply_to)) {
        node = byId.get(node.reply_to);
        id = node.id;
        continue;
      }

      // ② 沿合并映射跳。
      //   ⚠️ 目标可能**不在这批里**（它的消息被条数截断了）—— 那也照跳，
      //   `node` 置空即可：id 本身就是要找的根。同 ① 的精神：
      //   拿不到对象不等于这条关系不存在。
      const to = merges && merges[id];
      if (to != null && to !== id) {
        id = to;
        node = byId.get(to) || null;
        continue;
      }

      return id;
    }
    return id;
  }

  /**
   * @param {Array} list 平铺的消息（要有 id；reply_to 可选）
   * @returns {Array} [{ root, replies: [] }]，按 root 在原列表中的先后排
   *
   * ★ **一层嵌套**：回复的回复挂到**根**上，不开第二层。
   *   所以 A←B←C 里 C 和 B 都在 A 底下平铺。
   */
  function group(list, merges) {
    const rows = Array.isArray(list) ? list : [];
    const byId = new Map();
    for (const e of rows) if (e && e.id != null) byId.set(e.id, e);

    const buckets = new Map();   // rootId -> { root, replies }
    const orphanSys = [];        // 没有 id 的（系统事件等）—— 原样按顺序留在顶层

    for (const e of rows) {
      if (!e || e.id == null) { orphanSys.push({ root: e, replies: [] }); continue; }
      const rid = rootIdOf(e, byId, merges);
      if (!buckets.has(rid)) {
        // 根本身可能还没被扫到（回复排在父前面 —— 乱序到达时会发生）。
        // 先占位，等扫到真根时补上。
        //
        // ⚠️ `|| e` 这个兜底在没有合并时**永远走不到**（rid 要么是批里的父、
        //   要么是 e 自己）。**有合并时它是真实分支**：话题被并入的
        //   目标可能因为条数截断而不在这批里 —— 那时这一组只能拿组里的
        //   第一条当展示用的根。
        buckets.set(rid, { root: byId.get(rid) || e, replies: [] });
      }
      const b = buckets.get(rid);
      // ★★ 判据是**「它是不是这一组的展示根」**，不是 `e.id !== rid`。
      //   两者在没有合并时等价；有合并时不等价，而不等价的那一刻会出事：
      //   上面那个兜底把 e 当成了 root，可 `e.id !== rid` 仍然成立
      //   ⇒ **同一条消息既是 root 又进 replies，界面上显示两遍。**
      if (b.root !== e) b.replies.push(e);
    }

    // ★ 顺序按「根第一次出现的位置」，不是按 Map 插入序 ——
    //   乱序到达时后者会把整段历史的顺序打乱，而人看到的是消息在跳。
    const out = [];
    const emitted = new Set();
    for (const e of rows) {
      if (!e || e.id == null) continue;
      const rid = rootIdOf(e, byId, merges);
      if (emitted.has(rid)) continue;
      emitted.add(rid);
      out.push(buckets.get(rid));
    }
    return orphanSys.length ? mergeSys(rows, out, orphanSys, merges) : out;
  }

  /**
   * 系统事件（`sys: true`，没有 id）必须留在**它原来的时间位置**上。
   *
   * ⚠️ 把它们一股脑推到末尾是错的：`renderFeed` 头上写着
   *   「watchdog / 系统事件**混在时间流里**，不另开面板 —— 它跟它旁边那条
   *   发言是同一件事的两面，拆开就看不出因果了」。
   *   thread 化不能把那个性质弄丢。
   */
  function mergeSys(rows, threads, _orphanSys, merges) {
    const out = [];
    const emitted = new Set();
    const byId = new Map();
    for (const e of rows) if (e && e.id != null) byId.set(e.id, e);
    // ★★ key 用 `rootIdOf(t.root)` 重算，**不能用 `t.root.id`**。
    //   没有合并时两者恒等（展示根就是真根）；有合并时不一定：
    //   目标不在这批里时，展示根是组里第一条消息，它的 `id` 不是这一组的
    //   rootId ⇒ 下面 `threadByRoot.get(rid)` 查不到 ⇒ **整组消息被静默丢掉**。
    const threadByRoot = new Map(
      threads.map((t) => [t.root && rootIdOf(t.root, byId, merges), t]));
    for (const e of rows) {
      if (!e) continue;
      if (e.id == null) { out.push({ root: e, replies: [] }); continue; }
      const rid = rootIdOf(e, byId, merges);
      if (emitted.has(rid)) continue;
      emitted.add(rid);
      const t = threadByRoot.get(rid);
      if (t) out.push(t);
    }
    return out;
  }

  // ── thread 模型的另外两个判据 ──────────────────────────────────────
  //
  // ★ 为什么放在这里而不是 `app.js`：这两个跟 `group` / `rootIdOf` 是**同一个
  //   模型的四个部分**，散在两个文件里迟早分叉。而且 `app.js` 是浏览器脚本，
  //   **Node require 不了它** ⇒ 放那儿的判据既测不了、也做不了变异证明。
  //   这个文件是 UMD（浏览器 + Node 都能用），已经有 `test/threads.test.js` 真测它。

  /** 谁算「人」。⚠️ 唯一出处 —— 散出去第二份，两处对「谁能开话题」迟早会分叉。 */
  const HUMAN = 'Patrick';

  /**
   * `kind` 的合法值域 —— **发送者能标的那些**。唯一出处。
   *
   * ══════════════════════════════════════════════════════════════
   * ── 为什么要有这个常量 ──────────────────────────────────────────
   *   值域用到的地方不止两处（relay 的白名单 + 下面的 `kindOf`），
   *   还有 `bin/serve.js` 里人从网页发消息的那条入口。
   *   三处少改任何一处都不报错，两个方向的症状还不同：
   *   ```
   *   漏改写入侧 → 字段被丢掉 → 退化成「没标」→ 落进 orphan
   *   漏改读取侧 → 字段进了流但前端不认 → 同样落进 orphan
   *   ```
   *
   *   「记住有几处」这件事本身就会出错，**出错的方式恰好是漏掉一处**。
   *
   *   ⇒ 所以值域收在这里，写入侧（`lib/relay.js` / `bin/serve.js`）都来引它。
   *   加一档 = 改一行，而不是记住三个地方。
   *
   * ⚠️⚠️ **`orphan` 绝不能加进来。** 看到它不在数组里，第一反应一定是
   *   「漏了一个」—— 没漏。它是 `kindOf` 的**输出**，不是发送者能标的**输入**：
   *   ```
   *   KINDS            发送者可以标的值
   *   kindOf 的返回值   KINDS ∪ { orphan }
   *   ```
   *   加进来的话 agent 就能自己标 `kind:"orphan"`，而那一档的全部意义
   *   恰恰是「**没有人标它**」—— 一条自称 orphan 的消息让这个诊断失去意义。
   *
   * ⚠️ 光有这个常量**还不够**：它保证写入侧透传同一批值，
   *   保证不了 `kindOf` 认识数组里的每个值。守住那一条的是
   *   `test/threads.test.js` 里那条**随 KINDS 自动扩展**的断言
   *   （对每个 k：`kindOf({kind:k}) === k`）—— 加值域时它自己就覆盖了新值，
   *   不需要谁记得补测试。
   * ══════════════════════════════════════════════════════════════
   */
  const KINDS = ['topic', 'reply', 'notice', 'status'];

  /**
   * 一条消息属于哪一类：`topic` / `reply` / `notice` / `orphan`。
   *
   * ★★ **只有人能开话题**。agent 的每一条要么是某个
   *   thread 里的回复，要么是标了 `notice` 的通知。
   *
   * ⚠️ 而 `orphan`（agent 发的、既没 reply_to 也没标 notice）是**故意存在**的：
   *   「顶层只渲染人开的话题 + 通知」——**照字面做，一条 agent
   *   没标的消息会从界面上消失**，而消息静默不见是这个项目最反对的形状。
   *   ⇒ 它照常渲染，但打一个看得见的标记。**发它的 agent 才知道自己漏标了。**
   *
   * ⚠️ 老消息（没有 kind 字段之前写进流的）既没 kind 也没 reply_to ⇒ 人发的当 topic、
   *   agent 发的当 orphan。**不追溯、不回填**（同「不做历史回填」）。
   */
  function kindOf(e) {
    if (!e) return 'topic';

    // ★★ 第一行：**显式标注优先于结构推断**，而且只认 `KINDS` 里的值。
    //
    //   ── 顺序不能动 ────────────────────────────────────────────
    //   它必须排在 `reply_to` 判定**之前**。一条标了 `status` 又碰巧带
    //   `reply_to` 的消息，作者的意思是「这是状态」——
    //   反过来的话，上线报到只要挂了个父就会被算成普通回复。
    //
    //   ── 为什么 `status` 是单独一档、不让它去当 orphan ──────────
    //   `orphan` 的含义是「按协议它该挂在某处却没挂」。而上线报到、心跳
    //   **本来就不该有 `reply_to`** —— 它们不在回复任何人。把它们算成违规
    //   是**判据错，不是行为错**，而一个持续误报的判据会诱使人去放宽它，
    //   最后连真正的 orphan 也不报了。
    //
    //   ⚠️ 这一行**不认识**的值（拼错的 `"notic"`、将来某个只加了一半的新档）
    //   会掉到下面去 —— 退化成「没标」，走 orphan 那条**可见**的路。
    //   那是有意的：让人看得见自己拼错了，而不是落进一个前端不认识的分类。
    if (KINDS.includes(e.kind)) return e.kind;

    if (e.reply_to) return 'reply';
    return e.from === HUMAN ? 'topic' : 'orphan';
  }

  /**
   * 这条消息是不是「任务完成」的报告。
   *
   * ══════════════════════════════════════════════════════════════
   * ★★★ **为什么它是一个独立字段，而不是 `KINDS` 里的第五档**
   *   （用 `done: true` 而不是 `kind:"done"`，理由如下 —— 写出来是因为看起来很想把它并回去。）
   *
   *   `kindOf` 的第一行是**显式标注优先于结构推断**，而且那个顺序不能动。
   *   于是「done 进 KINDS」会撞上它：
   *
   *   ```
   *   agent 报完成 = 回复派给它的活 ⇒ 它带 reply_to
   *   标了 kind:"done" ⇒ kindOf 返回 'done'，**不再返回 'reply'**
   *   ⇒ 这条消息从它所在的 thread 里掉出来，渲染成顶层
   *   ```
   *
   *   而这个功能的另一半需求恰恰是「**在那条 thread 的第一条打标记**」——
   *   它必须还留在 thread 里，才知道根是谁。**两个需求会互相拆台。**
   *
   * ⇒ 「在 thread 里是什么角色」和「这条是不是完成报告」是**正交**的两件事。
   *   一条消息可以既是 `reply` 又是 done。塞进同一个字段 = 用一个位子
   *   装两个维度，而丢掉的那一维不会报错，只会让消息悄悄换个位置。
   *
   * ⚠️ **规范化在这里做，只做一次。** Redis 流的字段全过 `String(v)`
   *   （`lib/queue.js:433`），所以写进去的 `true` 读出来是字符串 `'true'`。
   *   每个读者各判一次的话，早晚有一个只判 `=== true` —— 而它的表现是
   *   **通知不弹、标记不打，零报错**。
   * ══════════════════════════════════════════════════════════════
   */
  function isDone(e) {
    if (!e) return false;
    const v = e.done;
    return v === true || v === 'true' || v === '1' || v === 1;
  }

  /**
   * 一条完成报告的**桌面通知**：弹不弹、标题写什么。
   *
   * ★ 判据在这里、不在 `web/app.js`：app.js 跑在浏览器里测不到，而「未验证」三个字
   *   要出现在哪几种情况里是**规格**，得有测试钉住。
   * ★ `verify` 由 relay 写进流（值域见 `lib/done-verify.js` 的 `VERIFY`）：
   *   `pending` ⇒ **不弹**：核验在跑，结论会以一条 `verify:"pass"` 的跟帖到达（那条才弹）；
   *   没过的不弹 —— 打回给 agent 了，不是「做完了」。
   * ⚠️ 没有 `verify` 字段（有核验之前写进流的消息）⇒ 照样弹，但写「未验证」—— 缺席不能被读成「核过了」。
   */
  // ★ 这张表放在 `doneNotice` 外面并导出 —— 「今天」视图「刚完成」那一栏的
  //   核验标签用**同一份文案**（`web/derive.js` 的 `verifyLabel`）。两份文案的话，通知说「未验证」、
  //   列表说「已核验」，人不知道该信哪个。
  const VERIFY_SUFFIX = Object.freeze({
    pass: '（已独立核验）',
    none: '（未验证）',
    missing: '（未验证（没带 evidence））',
    unverifiable: '（未验证：核验做不了）',
    not_wired: '（未验证：这个 bus 没接核验）',
  });

  function doneNotice(m) {
    if (!isDone(m)) return { notify: false, title: null };
    const who = (m && m.from) || '?';
    const v = m && m.verify;
    if (v === 'pending' || v === 'fail') return { notify: false, title: null };
    return { notify: true, title: `🏁 ${who} 报告任务完成${VERIFY_SUFFIX[v] || '（未验证）'}` };
  }

  /**
   * 这条消息在等回复（`@X 请开始 Y 阶段` 那一类）。
   *
   * ══════════════════════════════════════════════════════════════
   * ⚠️⚠️ **必须判字符串** —— 跟 `isDone` 逐字同一个理由：
   *   Redis 流的字段全过 `String(v)`（`lib/queue.js:433`），
   *   写进去的 `true` 读出来是 `'true'`，`false` 读出来是 **`'false'`**。
   *
   *   🔴 而这一档比 `done` 更容易写错，因为写成 `if (e.expects_reply)` 也「像是对的」：
   *   **`'false'` 是个 truthy 字符串。**
   *   夹具 `test/fixtures/room-28cb2fbf3d1a.json`（84 条真实消息）里：
   *
   *     值 `'true'`   3 条   ← 真正在等回复的
   *     值 `'false'` 75 条   ← 🔴 truthy 写法会把它们全部算成「在等回复」
   *     缺失          6 条
   *
   *   ⇒ 按 truthy 写，**78/84 = 93% 被判成「流程事件」，折叠等于没做**；
   *     按 `=== true`（只认布尔）写，**3 条真样本一条都命中不了**。
   *   **两种写法都不报错**，区别只在界面上折不折得动。
   *
   * ── ⚠️ 这是第二份实现，说清楚它为什么可以存在 ──────────────────
   *   `lib/rooms.js:538` 已经有一份**逐字相同**的判定。前端引不了 `lib/`
   *   （`web/` 是浏览器脚本），所以这里再写一份。
   *   ★ 但它是**能被合并的那种两份**：这个文件是 UMD 双导出的，
   *     `lib/relay.js` 已经反过来引过这里的 `KINDS` 和 `isDone`。
   *     ⇒ **将来该由 `lib/rooms.js` 来引这个函数**，而不是各改各的。
   *   **改这里的判据时，`lib/rooms.js:538` 要一起改** —— 分叉了不会报错，
   *   只会让前后端对同一条消息给出不同的答案。
   * ══════════════════════════════════════════════════════════════
   */
  function expectsReply(e) {
    if (!e) return false;
    const v = e.expects_reply;
    return v === true || v === 'true' || v === 1 || v === '1';
  }

  /**
   * 「这条话在等 Patrick 做决定」—— `needs_decision` 字段的判据，**唯一出处**。
   *
   * 白名单跟 `expectsReply` 逐字一样：流里每个字段都被 String() 过，`'false'` 是 truthy，
   * 所以后端、前端一律走这里，**不许**写 `if (m.needs_decision)` 或 `=== true`。
   * 它跟 `done` / `expects_reply` / `kind` 正交（不是第五个 kind，理由同 `isDone`）。
   * 为什么不复用 `expects_reply`：那个字段的语义是「扇出时收件 agent 该不该回」，
   * 房间和私聊默认值相反；「等 Patrick 拍板」是给人看的另一个维度。
   */
  function needsDecision(e) {
    if (!e) return false;
    const v = e.needs_decision;
    return v === true || v === 'true' || v === 1 || v === '1';
  }

  /**
   * 回复这一条时，`reply_to` 该填谁 —— **它所在 thread 的根，不是它自己**。
   *
   * ══════════════════════════════════════════════════════════════
   * ★★★ 点 thread 里第 5 条回复 → 如果填第 5 条，**两层变三层**，
   *   下一次变四层。归一到根之后：**点任何一条，永远两层。**
   *
   * ⚠️ 这个 bug 的症状**要好几轮对话才看得见**（第一层嵌套时界面还正常），
   *   那时人只会觉得「界面有点乱」，不会想到是这个函数的判据错了。
   *   ⇒ 有一条变异守着它（改成 `return entry.id` 必须红）。
   * ══════════════════════════════════════════════════════════════
   *
   * ★ 复用 `rootIdOf` —— 那边有环保护（`post()` 明确「reply_to 只存不验」，
   *   流里可以合法存在 A→B→A）和「父不在这批里就当根」。**不写第二个上溯。**
   */
  function replyTargetIdOf(entry, byId, merges) {
    if (!entry || entry.id == null) return null;
    // ★ 也要吃 `merges`：话题被并走之后，回复它应该挂到**合并后的那个根**上。
    //   不传的话，新回复会挂回旧根 —— 界面上它跟着合并后的组显示（因为
    //   `group` 认映射），但**流里存的 reply_to 指向旧根**。撤销合并时，
    //   这条回复会跳回原来那个话题里，而人早就把它当成新话题的一部分了。
    return rootIdOf(entry, byId, merges);
  }

  /**
   * 把 `group()` 的结果切成一段段：**相邻的 `status` 归成一段**，其余各自一段。
   *
   * ── 为什么这个切法在这里、不在 `app.js` 里 ──────────────────────
   * 它是个**分组算法**，而分组算法的危险从来不在「功能写没写」，在边界：
   * 中间夹一条普通消息要不要断开、有回复的 status 算不算、空列表。
   * **那些都是行为**，而 `test/` 对 `app.js` 只能做源码断言 ——
   * 验得了 `renderStatusRun` 这个函数存在，**验不了它会不会把两段本该
   * 分开的状态粘成一段**。放这里，`test/threads.test.js` 真的执行它。
   * （同 `group` / `rootIdOf` 抽出来的理由，那段注释在文件头上。）
   *
   * @returns {Array} `[{ kind:'status', items:[根消息…] } | { kind:'thread', thread }]`
   */
  function segments(threads) {
    const rows = Array.isArray(threads) ? threads : [];
    const out = [];
    let run = null;

    for (const t of rows) {
      if (!t || !t.root) continue;
      const replies = Array.isArray(t.replies) ? t.replies : [];

      // ⚠️ **有回复的 status 不收进来。** 有人在它下面说过话，它就不再是
      //   「零信息量」了 —— 把它折成一行，折掉的是那段对话。
      //   这条判据看的是 thread 结构，不是消息内容。
      if (kindOf(t.root) === 'status' && replies.length === 0) {
        if (!run) { run = { kind: 'status', items: [] }; out.push(run); }
        run.items.push(t.root);
        continue;
      }

      // ★ 遇到任何非 status（或带回复的 status）就**断开当前这一串**。
      //   不断开的话，两段被普通对话隔开的状态会被粘成一段，
      //   而合并行只显示最后一条的时间 —— 于是那一行谎报了它覆盖的时间范围。
      run = null;
      out.push({ kind: 'thread', thread: t });
    }
    return coalesceDups(out);
  }

  /**
   * 把**相邻的、完全相同的**消息收成一段。
   *
   * ══════════════════════════════════════════════════════════════
   * **病**：同一句 watchdog 告警可以在一个私聊窗口里占掉大多数条目，
   * 而且**在流里完全连续**。那不是「层次不清」，是**一条消息刷了几百遍**。
   *
   * ── 🔴 判据用「逐字节相同」，**不许用前缀或相似度** ──────────────
   *   最保守的判据（同 `from` + `text` 逐字节相同 + 相邻 + 无回复）
   *   就能把这种重复串全部命中 —— 既然逐字节就够，就绝不放宽。
   *
   *   > 误合并的代价是**两条不同的消息被吃掉一条，而且不报错**；
   *   > 漏合并的代价只是多几行。**不对称，取保守的那一侧。**
   *
   *   （跟 `kindOf` 那句「判据只看发送者标的 kind，**不看内容**」和
   *     不许「按 `@xxx 请开始` 的文本形状认流程事件」是同一条理由：
   *     形状判据自带假阳性，而假阳性在这里是**不可逆的信息丢失**。）
   *
   * ── 两条从 status run 那边照搬的警告 ──────────────────────────
   *   ① **有回复的不收进来** —— 有人在它下面说过话，它就不再是零信息量的了。
   *      把一条已经长出对话的消息折成一行，折掉的是那段对话。
   *   ② **遇到不匹配的就断开当前这一串** —— 不断开的话，两段被普通对话隔开的
   *      重复会被粘成一段，**而合并行只显示最后一条的时间 ⇒ 那一行谎报了
   *      它覆盖的时间范围**。
   *
   * ⚠️ **只有 ≥2 条才成段。** 单独一条保持原样 —— 否则每条普通消息都会变成
   *   一个「重复 1 次」的段，那是把一个显示问题换成另一个。
   *
   * ★ 做成**后处理**而不是塞进 `segments()` 的主循环：主循环里要同时维护
   *   status 串和重复串两个状态，而它们的断开条件不一样 ——
   *   两个状态机缠在一个循环里，边界会互相污染（哪一个先断、断了要不要
   *   把另一个也断掉），而那种 bug 只在特定序列上出现。
   * ══════════════════════════════════════════════════════════════
   *
   * @returns 段数组，其中重复的那些变成 `{ kind:'dup', from, text, items:[根消息…] }`
   */
  function coalesceDups(segs) {
    const rows = Array.isArray(segs) ? segs : [];
    const out = [];
    // 一个段能不能参与合并：**只有没有回复的 thread 段**（见警告①）。
    const plain = (s) => s && s.kind === 'thread' && s.thread && s.thread.root
      && (!Array.isArray(s.thread.replies) || s.thread.replies.length === 0);
    const same = (a, b) => a && b && a.from === b.from && a.text === b.text;

    for (const s of rows) {
      const prev = out[out.length - 1];

      // 接在已有的重复串后面
      if (plain(s) && prev && prev.kind === 'dup' && same(prev, s.thread.root)) {
        prev.items.push(s.thread.root);
        continue;
      }
      // 前一个是普通段，且跟这个完全相同 → **升级**成重复串（这是第 2 条，成段）
      if (plain(s) && plain(prev) && same(prev.thread.root, s.thread.root)) {
        out[out.length - 1] = {
          kind: 'dup',
          from: s.thread.root.from,
          text: s.thread.root.text,
          items: [prev.thread.root, s.thread.root],
        };
        continue;
      }
      // 其余一律原样入列 —— 这一步就是警告②说的「断开」：
      // 只要 push 了别的东西，上面两条 `prev` 判定下一轮就都不成立了。
      out.push(s);
    }
    return out;
  }

  // ── 只显示最近两天的话题 ──────────────────────────────────────────

  /**
   * 滚动窗口 48 小时。
   *
   * ★★ **滚动窗口，不是「今天 + 昨天」的自然日。** 自然日的话**午夜一到
   *   界面突然少掉一半** —— 而午夜前后照样有人在用。滚动没有跳变。
   */
  const RECENT_MS = 48 * 60 * 60 * 1000;

  /**
   * `at` → 毫秒。数字（或纯数字串）直接用，ISO 字符串走 `Date.parse`；都不是 ⇒ `null`。
   *
   * ★ 时间解析**只有这一份**，导出；`web/derive.js` 的 `atMs` 指向同一个函数。
   *   两份判据（比如 `lastActivityOf` 另判一次「只认数字」）会各管一半：
   *   「需要你」认得房间历史的 ISO 字符串，「更早的话题」认不得，
   *   于是几天前的房间话题**永远赖在最近区**。
   * ⚠️ 返回 `null` 的调用方一律按「判不出 ⇒ 不藏」处理（见 `splitByAge`）。
   */
  function atMs(at) {
    if (typeof at === 'number') return Number.isFinite(at) ? at : null;
    if (typeof at === 'string' && at.trim()) {
      if (/^\d+$/.test(at.trim())) return Number(at);
      const t = Date.parse(at);
      return Number.isFinite(t) ? t : null;
    }
    return null;
  }

  /**
   * 一个段的「最后活动时间」。
   *
   * ★★★ **thread 取里面最新的一条，不是根。**
   *   一个三天前开的话题、昨天还在回 —— **它是活的**。按根的时间算会
   *   **恰好把最活跃的老话题藏起来**，而那是最不该藏的那一类。
   *   这个错的症状是「我明明还在聊的那个话题不见了」，并且不报错。
   */
  function lastActivityOf(seg) {
    if (!seg) return null;
    const times = [];
    // ★ 走 `atMs` —— 房间历史的 `at` 是 ISO 字符串（来自 `timestamp`），
    //   只认数字的话房间话题一律「判不出时间」、永远不折。
    const take = (e) => {
      const t = e ? atMs(e.at) : null;
      if (t !== null) times.push(t);
    };
    // ★ `dup` 跟 `status` 一样是「一段里若干条」—— 取里面最新的那条。
    //   漏掉它的话 `lastActivityOf` 返回 null，那一段会被当成「时间判不出来」
    //   而永远不折进「更早的话题」—— 一个几百条的重复串永远赖在最近区。
    if (seg.kind === 'status' || seg.kind === 'dup') (seg.items || []).forEach(take);
    else if (seg.thread) {
      take(seg.thread.root);
      (seg.thread.replies || []).forEach(take);
    }
    return times.length ? Math.max.apply(null, times) : null;
  }

  /** 折叠掉的**顶层项**数：一个 thread 算 1 个，一段 status 算它里面的条数。 */
  function countTopLevel(segs) {
    let n = 0;
    // `dup` 同 `status`：一段里有几条就算几条 —— 折叠条上那个数字是**真数目**，
    // 报少了跟「只藏不说」是同一个形状。
    for (const s of segs || []) {
      n += (s && (s.kind === 'status' || s.kind === 'dup')) ? (s.items || []).length : 1;
    }
    return n;
  }

  /**
   * 按滚动窗口切成「最近的」和「更早的」。
   *
   * @returns `{ fresh, older, olderCount }` —— olderCount 是**真数目**，
   *   给「更早的 N 个话题」那一行用。只藏不说的话人会把看到的当成全部，
   *   跟「静默丢消息」是同一个形状。
   *
   * ★ **在 `segments()` 之后过滤，不在之前。**
   *   反过来的话，被过滤掉的话题会让原本**不相邻**的两段 status 变成相邻，
   *   于是它们被粘成一段 —— 而合并行只显示最后一条的时间，
   *   **那一行就谎报了它覆盖的范围**。段的边界该由原始相邻关系决定，
   *   跟「哪些够新」无关。
   *
   * ⚠️ **时间判不出来的一律当「新」，不折。**
   *   `at` 缺失或解析不出来时（`atMs` 返回 null），不知道它是什么时候的 ——
   *   而「不知道」绝不能降级成「很旧，藏起来」。这个仓库对静默消失的态度
   *   在 `kindOf` / `rootIdOf` 两处都写过：**宁可它碍眼，不可它消失。**
   */
  function splitByAge(segs, now, windowMs) {
    const rows = Array.isArray(segs) ? segs : [];
    const win = (typeof windowMs === 'number' && windowMs > 0) ? windowMs : RECENT_MS;
    const nowOk = typeof now === 'number' && isFinite(now);
    const fresh = [];
    const older = [];
    for (const s of rows) {
      if (!s) continue;
      const last = lastActivityOf(s);
      if (!nowOk || last === null) { fresh.push(s); continue; }   // 见上：判不出 ⇒ 不藏
      (now - last <= win ? fresh : older).push(s);
    }
    return { fresh, older, olderCount: countTopLevel(older) };
  }

  return {
    group, rootIdOf, kindOf, replyTargetIdOf, segments,
    splitByAge, lastActivityOf, countTopLevel, RECENT_MS, HUMAN,
    // 时间解析只有这一份：`web/derive.js` 的 `atMs` 就是它
    atMs,
    // 相邻重复的归并。导出给测试 —— 它的边界（只有 ≥2 条才成段、
    // 有回复的不收、不相邻的断开）全是**行为**，源码断言验不了。
    coalesceDups,
    // `expects_reply` 的规范化。跟 `isDone` 并排 —— 判据只有一处。
    // ⚠️ `lib/rooms.js:538` 还有一份逐字相同的，改这里要一起改（见函数注释）。
    expectsReply,
    // `needs_decision` 的规范化，同样判据只有一处（见函数注释）。
    needsDecision,
    // ★ `isDone` 跟 `KINDS` 同一个理由导出给写入侧：判据只有一处。
    //   `lib/relay.js`（写进流）、`bin/serve.js`（推 WS）、`web/app.js`
    //   （弹通知）三边都来引它。
    isDone,
    // 完成报告的桌面通知（弹不弹、标题）—— 判据放这里是为了测得到（见函数注释）
    doneNotice,
    // 核验状态的文案表（`doneNotice` 用它拼标题，「今天」视图的「刚完成」用它画标签）
    VERIFY_SUFFIX,
    // ★ `KINDS` 导出给**写入侧**：`lib/relay.js` 和 `bin/serve.js` 的白名单
    //   都从这里取。它们是 Node，而这个文件是 UMD、零依赖 —— require 得了，
    //   也成不了环。
    KINDS,
  };
}));
