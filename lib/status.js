'use strict';

/**
 * `GET /api/status` —— 顶栏的「测试」格和「commit」格。
 *
 * ── 这个端点存在的全部理由是那个「过期」判定 ────────────────────
 * 只显示「983/0 · 12 分钟前」，人还是会读成「现在是绿的」。
 * 显示「983/0 · 跑在 <旧 commit>，HEAD 已经是 <新 commit>」，人一眼看出
 * **这个数字不管当前代码**。
 *
 * > **一个过期的绿，比没有数字更危险 ——**
 * > **没有数字的时候人会去跑一遍，看到绿的时候不会。**
 *
 * ── 三条同形的规矩，全都是「查不了 ≠ 没有」──────────────────────
 * 这个文件里所有分支都在处理同一件事的三个面：
 *
 *   · 没有 `last-run.json`      → `no_data`，**不是** 0/0
 *   · git 命令跑不了            → `git_unavailable`，**不是** `dirty:false`
 *   · commit 对不上 / 工作区脏  → `stale:true`，**不是** 悄悄显示那个绿数字
 *
 * 第二条（`watchdog` 查 tmux 也是同一个形状）：bus 是 launchd 起的，
 * PATH 跟你的 shell 不同，**一个查不到的结果会被当成「一切正常」，
 * 而且没人会发现**。「查不了」降级成「干净的」正好是最坏的方向。
 *
 * ⚠️ **这个端点绝不自己跑测试。** 页面 5 秒一刷，跑一次几分钟 ——
 *   那会把 bus 拖死，而且「每次刷新都在跑测试」这件事本身就是个故障。
 *   它只读 `results/last-run.json`，那个文件由 `test/run-all.js` 写。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'results');
const LAST_RUN = path.join(RESULTS_DIR, 'last-run.json');

/**
 * 读上一次全量的结果。
 *
 * 返回 `{ ok: true, data }` 或 `{ ok: false, reason }` ——
 * **`reason` 分得开三种**，因为它们该让人做的事不一样：
 *   `no_data`  从来没跑过        → 去跑一遍
 *   `unreadable` 文件在但读不了  → 看权限/磁盘
 *   `corrupt`  文件在但不是 JSON → 上次跑到一半崩了，重跑
 *
 * 压成一个「没有数据」的话，第三种会被当成第一种 —— 而它其实是个信号。
 */
function readLastRun(file = LAST_RUN) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'no_data' : 'unreadable',
             detail: String(err.message) };
  }
  try {
    const data = JSON.parse(raw);
    // 形状校验：缺字段的记录比没有记录更坏 —— 它会渲染成一个看起来正常的格子。
    if (typeof data.passed !== 'number' || typeof data.failed !== 'number') {
      return { ok: false, reason: 'corrupt', detail: '缺 passed/failed 字段' };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: 'corrupt', detail: String(err.message) };
  }
}

/**
 * 当前 git 状态。**跑不了就说跑不了。**
 *
 * ⚠️ 每一项都单独失败：`git log --since` 挂了不该把 HEAD 也带走。
 *   一个「全有或全无」的实现会让顶栏在小故障时整格消失。
 */
function gitInfo({ cwd = ROOT, run = null } = {}) {
  const exec = run || ((args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  }));

  const out = { available: true, head: null, head_subject: null, dirty: null, commits_today: null };
  try {
    out.head = exec(['rev-parse', '--short', 'HEAD']).trim();
  } catch (err) {
    // 连 HEAD 都拿不到 = git 本身不可用（没装、不在 PATH、不是仓库）。
    // 这一条塌了，下面几条问什么都没意义。
    return {
      available: false,
      error: 'git_unavailable',
      message: String(err.message || err),
      detail: '拿不到当前 HEAD，所以**无法判断上次测试跑的是不是这份代码** —— '
            + '这不是「代码没变」，是「查不了」。',
      hint: 'bus 多半是 launchd/nohup 起的，PATH 跟你的 shell 不同（git 通常在 /usr/bin）。',
      head: null, head_subject: null, dirty: null, commits_today: null,
    };
  }

  try {
    // HEAD 的标题（commit message 首行）。一个短 hash 认不出是哪次改动，
    // 而人要判断「上次测试跑的是不是这份代码」时，标题比 hash 好认。
    // ★ 空标题 → null，**不是空字符串**：`""` 会在界面上渲染成一个
    //   看不见的存在，跟「拿到了但是空的」分不开。
    out.head_subject = exec(['log', '-1', '--format=%s']).trim() || null;
  } catch (_) {
    // 拿不到标题不影响 hash —— 单项失败不该把整格弄没。
    out.head_subject = null;
  }

  try {
    // ★ `--porcelain` 的空输出 = 干净。**非空 = 脏**，不看具体内容。
    out.dirty = exec(['status', '--porcelain']).trim().length > 0;
  } catch (_) {
    // ★ 查不了脏不脏 → **null，不是 false**。
    //   false 是「我查过了，是干净的」，那正好是最坏的方向：
    //   一堆没验过的改动会被显示成「已验证」。
    out.dirty = null;
  }

  try {
    const log = exec(['log', '--since=midnight', '--oneline']).trim();
    out.commits_today = log ? log.split('\n').length : 0;
  } catch (_) {
    out.commits_today = null;
  }
  return out;
}

/**
 * 把两边拼成响应体。**纯函数** —— 过期判定是这个端点的核心，
 * 它必须能被测试看见（bin/ 的路由回调看不见）。
 */
function buildStatusPayload(lastRun, git, now = Date.now()) {
  const tests = lastRun.ok
    ? {
        passed: lastRun.data.passed,
        failed: lastRun.data.failed,
        files: lastRun.data.files ?? null,
        at: lastRun.data.at ?? null,
        age_ms: lastRun.data.at ? now - Date.parse(lastRun.data.at) : null,
        commit: lastRun.data.commit ?? null,
        dirty_when_run: lastRun.data.dirty ?? null,
        skipped: lastRun.data.skipped ?? null,
      }
    : null;

  // ── 过期判定 ────────────────────────────────────────────────────
  // 两个独立的原因，**分开列**：修法不一样。
  //   commit 变了     → 重跑一遍就行
  //   工作区脏        → 那些改动根本还没验过，跑之前先想清楚要不要提交
  const reasons = [];
  if (!tests) {
    reasons.push(lastRun.reason);              // no_data / unreadable / corrupt
  } else {
    if (!git.available) {
      // ★ **查不了当前 HEAD = 无法判断过不过期**，这本身就该算过期。
      //   算成「新鲜」的话，git 一挂顶栏就会永远显示一个绿数字。
      reasons.push('git_unavailable');
    } else {
      if (tests.commit && git.head && tests.commit !== git.head) reasons.push('commit_moved');
      if (git.dirty === true) reasons.push('working_tree_dirty');
      // 查不了脏不脏，同样不能当成干净
      if (git.dirty === null) reasons.push('dirty_unknown');
    }
  }

  return {
    at: now,
    tests,
    // ★ 没有数据时**不是** 0/0 —— 「从没跑过」和「跑过全绿」在一个空对象里
    //   长得一模一样，而前者应该催人去跑。
    tests_error: tests ? undefined : { reason: lastRun.reason, detail: lastRun.detail },
    git,
    // ★★ 这三个字段是这个端点的全部价值。
    //   `stale` 只回答「能不能拿这个数字当当前状态用」——
    //   **不能的时候，为什么不能必须一起给出来**，否则人只会看到一个红点。
    stale: reasons.length > 0,
    stale_reasons: reasons,
    stale_hint: reasons.length ? staleHint(reasons, tests, git) : null,
  };
}

/**
 * 一句人话。收到「过期」的人需要的是下一步动作，不是一个诊断。
 *
 * ★ 每一条都是「**是什么** + **该做什么**」两半。
 *   只写前半的话，人会自己补一个后半 —— 而他补的那个跟你想的往往不是同一个。
 */
function staleHint(reasons, tests, git) {
  const parts = [];
  if (reasons.includes('no_data')) {
    parts.push('从来没跑过全量 —— 这不是「零个失败」，是「没有数据」。跑 `node test/run-all.js`。');
  }
  if (reasons.includes('corrupt') || reasons.includes('unreadable')) {
    parts.push('上次的结果文件读不出来（多半是跑到一半崩了）。重跑 `node test/run-all.js`。');
  }
  if (reasons.includes('git_unavailable')) {
    parts.push('拿不到当前 HEAD，**无法判断这个数字管不管当前代码** —— 别把它当成绿的。'
      + '先修 git 可用性（多半是 bus 的 PATH），在那之前这个数字只能当「不知道」。');
  }
  if (reasons.includes('commit_moved')) {
    parts.push(`这个数字跑在 ${tests.commit}，HEAD 已经是 ${git.head} —— **它不管当前代码**。`
      + '重跑 `node test/run-all.js` 就会更新。');
  }
  if (reasons.includes('working_tree_dirty')) {
    parts.push('工作区有没提交的改动，**那些改动没被这次测试覆盖**。'
      + '重跑一遍就能覆盖到它们（不用先提交 —— 跑的是磁盘上的代码）。');
  }
  if (reasons.includes('dirty_unknown')) {
    parts.push('查不了工作区脏不脏，所以不能保证这个数字覆盖了当前代码。'
      + '自己 `git status` 看一眼，或者直接重跑一遍最省事。');
  }
  return parts.join(' ');
}

/**
 * 队列积压：**处理中**（已投递未 ack）和**等待**（还没被读走）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️★ 别用 `XLEN` 当等待数：
 *
 *   > XLEN 是流的**总长度，包含已消费的历史**。
 *
 *   这个陷阱的形状是：
 *   **队列刚起、没有历史的时候，XLEN 和「等待数」答案一致** ——
 *   **只在跑了一阵之后才分叉。所以它测试时是对的，用久了才错。**
 *
 * 正确的两个来源，都在 `XINFO GROUPS`：
 *
 *   pending   已投递给某个消费者、还没 ack   → **处理中**
 *   lag       还没被这个组读过的条数         → **等待**（Redis 7+）
 *
 * ⚠️⚠️ `lag` 可能是 `null` —— 流被 `XDEL`/`XTRIM` 过之后 redis 算不出来。
 *   那时候**「0」和「不知道」绝不能长成一样**：前者说「没积压」，
 *   后者说「我答不了这个问题」，而人看到 0 会停止追查。
 *   所以有 `unknown_lag` 这个布尔，页面必须把它显示出来。
 * ══════════════════════════════════════════════════════════════════
 *
 * 算哪些流：**编排者和 agent 的入向流** —— 那才是「有多少活没处理」。
 *   不算 `orch:out`：它的积压意思是「bus 没推给浏览器」，是另一件事，
 *   混进来会让一个前端断连显示成「agent 有活没干」。
 */
async function queueStats(redis, { streams = null } = {}) {
  let names = streams;
  if (!names) {
    names = [];
    for (const k of await redis.keys('*')) {
      if (!/^(orch:in:|agent:[^:]+:in$)/.test(k)) continue;
      if ((await redis.type(k)) === 'stream') names.push(k);
    }
  }
  names.sort();

  let processing = 0, waiting = 0, unknownLag = false;
  const detail = [];
  for (const s of names) {
    let groups = [];
    try {
      groups = await redis.xinfo('GROUPS', s);
    } catch (_) {
      continue;                      // 流不存在或没有组 —— 不是错误
    }
    for (const g of groups) {
      const o = {};
      for (let i = 0; i < g.length; i += 2) o[g[i]] = g[i + 1];
      const p = Number(o.pending) || 0;
      // ★ `lag` 是 null 时**不当 0 算** —— 那正是要区分的两件事。
      const lagRaw = o.lag;
      const hasLag = lagRaw !== null && lagRaw !== undefined && lagRaw !== '';
      const l = hasLag ? Number(lagRaw) : null;
      if (!hasLag) unknownLag = true;
      processing += p;
      if (l !== null) waiting += l;
      detail.push({ stream: s, group: o.name, pending: p, lag: l });
    }
  }
  return { processing, waiting, unknown_lag: unknownLag, streams: detail };
}

/**
 * `GET /api/status` 的 handler。
 *
 * ⚠️ 只读文件 + 跑几条 git 命令，**不跑测试**（见文件头）。
 *
 * ★ `redis` 可选：给了就带上队列积压。**不给不是错误** ——
 *   测试和别的调用方不该被迫准备一个 redis 才能拿测试状态。
 *   但给了却查失败**要说出来**（`queue.error`），不能悄悄回落成没有队列信息：
 *   **「没积压」和「查不到积压」在页面上会长成同一个样子。**
 */
function handler({ file = LAST_RUN, cwd = ROOT, gitRun = null, redis = null } = {}) {
  return async (_req, res) => {
    try {
      const payload = buildStatusPayload(readLastRun(file), gitInfo({ cwd, run: gitRun }));
      if (redis) {
        try {
          payload.queue = await queueStats(redis);
        } catch (err) {
          payload.queue = { error: 'queue_probe_failed', message: String(err.message || err) };
        }
      }
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: 'status_failed', message: String(err.message || err) });
    }
  };
}

/**
 * 写 `results/last-run.json`。给 `test/run-all.js` 用。
 *
 * ★ `commit` 和 `dirty` 记的是**跑测试那一刻**的状态，不是读的时候 ——
 *   这两个字段的全部用途就是跟「现在」比对，记成现在的话恒等，
 *   **过期判定会永远返回「新鲜」**。
 */
function writeLastRun(summary, { file = LAST_RUN, cwd = ROOT, gitRun = null } = {}) {
  const git = gitInfo({ cwd, run: gitRun });
  const record = {
    ...summary,
    at: new Date().toISOString(),
    commit: git.head,
    dirty: git.dirty,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

module.exports = {
  readLastRun, gitInfo, buildStatusPayload, staleHint, handler, writeLastRun,
  queueStats,
  LAST_RUN, RESULTS_DIR,
};
