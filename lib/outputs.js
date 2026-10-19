'use strict';

/**
 * agent 产出物 —— `outputs/<job_id>/<file>`
 *
 * ══════════════════════════════════════════════════════════════════
 * 把 agent 的产出物变成一等公民：消息只是文本，
 * 而实际交付的是文件 —— 报告、图表、文档。人要能直接看到、搜索、打开。
 *
 * 文件从哪来，有三个选项。**选 A（约定输出目录），理由是**：
 * 一个编出来的状态比没有状态更糟 —— 它给人一个虚假的完成预期。
 *
 * 这条判据用在这里：
 *
 *   A 扫目录        文件在磁盘上是**事实**
 *   B outbox 元数据  是**声明** —— 要 agent 记得写
 *   C worker stdout  更弱：非结构化，而且 worker 崩了就什么都没有
 *
 * ★ B 要求 agent「记得」写元数据 —— 一个靠记性的步骤，在内容长的时候必然会掉。
 *   而分叉的样子是：面板上列着一个不存在的文件，或者一个存在的文件不在面板上。
 * ══════════════════════════════════════════════════════════════════
 *
 * ── 「生成中」怎么判：用文件系统的事实，不用声明 ──────────────────
 *
 *   写的时候      <name>.partial
 *   写完          rename 成 <name>          ← **rename 是原子的**
 *
 * ⚠️ **不用「mtime 多久没变 = 写完了」** —— 那是猜。
 *   一个慢的生成过程会被判成写完，**而它跟真写完长得一模一样**，
 *   人会去打开一个只写了一半的 PDF。
 *
 * ⚠️ 也不用「文件大小不再增长」：同一个毛病，只是换了个观测量。
 *   **两者都是拿一个间接信号代理一个直接事实，而直接事实是可以有的
 *   （原子 rename）—— 有直接的就不该用间接的。**
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_ROOT = process.env.ENGLOOP_OUTPUTS_ROOT || path.join(ROOT, 'outputs');

const PARTIAL_EXT = '.partial';

/**
 * job_id 的合法形状。**这是个安全判定，不是格式洁癖** ——
 * `job_id` 来自消息，而它会被拼进文件路径。
 *
 * ⚠️ 判据是**白名单**（只允许 `[A-Za-z0-9_-]`），不是「黑名单挡 `..`」：
 *   `..%2f`、`....//`、绝对路径、符号链接名 —— 黑名单永远漏一个。
 *   （同 `lib/docs.js` 那条路径穿越判定，只是那边是读、这边是列。）
 */
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function isValidJobId(id) {
  return typeof id === 'string' && JOB_ID_RE.test(id);
}

/** 一个文件名是不是「还在写」 */
function isPartial(name) {
  return name.endsWith(PARTIAL_EXT);
}

/** `report.pdf.partial` → `report.pdf` */
function finalName(name) {
  return isPartial(name) ? name.slice(0, -PARTIAL_EXT.length) : name;
}

/**
 * 按扩展名给个类型标签，前端拿去选图标。
 *
 * ★ 认不出的归 `file`，**不是丢掉也不是猜** ——
 *   一个显示不出图标的文件仍然要出现在列表里。
 */
function kindOf(name) {
  const ext = path.extname(finalName(name)).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (['.pdf'].includes(ext)) return 'pdf';
  if (['.md', '.markdown', '.txt'].includes(ext)) return 'text';
  if (['.json', '.jsonl', '.yaml', '.yml', '.csv'].includes(ext)) return 'data';
  if (['.js', '.ts', '.py', '.sh', '.html', '.css'].includes(ext)) return 'code';
  return 'file';
}

/**
 * 列出一个 job 的产出。
 *
 * ⚠️ 同名的 `x` 和 `x.partial` 同时存在时，**以最终名那份为准**并标
 *   `superseded_partial: true` —— 那说明上一次写了一半、这次写成了，
 *   而残留的 .partial 没清掉。**报出来，别当没看见**：
 *   一个一直在的 .partial 是「有个生成过程崩了」的唯一痕迹。
 */
function listJob(jobId, { root = DEFAULT_ROOT } = {}) {
  if (!isValidJobId(jobId)) {
    const e = new Error(`job_id 形状不合法：只允许 [A-Za-z0-9_-]，最长 128`);
    e.code = 'BAD_JOB_ID';
    throw e;
  }
  const dir = path.join(root, jobId);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { job_id: jobId, files: [], exists: false };
    throw err;
  }

  const finals = new Set(names.filter((n) => !isPartial(n)));
  const files = [];
  for (const name of names) {
    const partial = isPartial(name);
    const shown = finalName(name);
    // 最终名已经在了 → 这个 .partial 是残留，不单独列一行
    if (partial && finals.has(shown)) continue;
    let st;
    try { st = fs.statSync(path.join(dir, name)); } catch (_) { continue; }
    if (!st.isFile()) continue;
    files.push({
      name: shown,
      kind: kindOf(name),
      size: st.size,
      mtime: st.mtimeMs,
      // ★ 状态是**从文件名读出来的事实**，不是谁声明的
      status: partial ? 'writing' : 'ready',
      superseded_partial: !partial && names.includes(name + PARTIAL_EXT),
    });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return { job_id: jobId, files, exists: true };
}

/**
 * 列出所有 job。
 *
 * @param {number} limit 最多返回几个 job（按最近修改排序）
 * ★ 截断了要说出来（`truncated`）——**一个静默截断的列表，会让人以为
 *   那就是全部**，而「全部」正是这个面板的用途。
 */
function listAll({ root = DEFAULT_ROOT, limit = 50 } = {}) {
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidJobId(d.name))
      .map((d) => d.name);
  } catch (err) {
    if (err.code === 'ENOENT') return { jobs: [], total: 0, truncated: false, root };
    throw err;
  }

  const jobs = [];
  for (const id of dirs) {
    const j = listJob(id, { root });
    if (!j.files.length) continue;
    j.mtime = Math.max(...j.files.map((f) => f.mtime));
    jobs.push(j);
  }
  jobs.sort((a, b) => b.mtime - a.mtime);
  const total = jobs.length;
  return { jobs: jobs.slice(0, limit), total, truncated: total > limit, root };
}

/**
 * 解析一个产出文件的真实路径，**带路径穿越判定**。
 *
 * ⚠️ 顺序跟 `lib/docs.js` 完全一致，而且顺序有讲究：
 *   `resolve` → `relative`（挡 `..`/绝对路径，不需要文件存在）
 *   → `realpath`（挡符号链接，需要文件存在）→ 再 `relative`
 *
 *   反过来的话，`../nonexistent` 会先在 realpath 上抛 ENOENT，
 *   **被归成 404 而不是 403** —— 而那两个对读的人意思完全不同：
 *   404 让他以为文件名写错，403 告诉他这条路不许走。
 */
function resolveFile(jobId, name, { root = DEFAULT_ROOT } = {}) {
  if (!isValidJobId(jobId)) {
    const e = new Error('job_id 形状不合法');
    e.code = 'BAD_JOB_ID';
    throw e;
  }
  const base = path.resolve(root, jobId);
  const target = path.resolve(base, String(name || ''));

  // ★ `rel.startsWith('..')` 是**不精确的**：一个字面叫 `..%2f` 的文件
  //   （合法文件名）会被判成越界。那是「过度安全」那一类 bug，
  //   症状是「一个存在的文件打不开」，而且报的还是 403，
  //   **让人以为自己在做坏事**。
  //   精确判据：rel 正好是 `..`，或者以 `..` + 分隔符开头。
  const rel = path.relative(base, target);
  const escapes = (r) => r === '..' || r.startsWith('..' + path.sep);
  if (escapes(rel) || path.isAbsolute(rel)) {
    const e = new Error('越界：解析后的路径不在这个 job 的目录里');
    e.code = 'OUT_OF_SCOPE';
    throw e;
  }
  let real;
  try {
    real = fs.realpathSync(target);
  } catch (err) {
    const e = new Error('文件不存在');
    e.code = 'NOT_FOUND';
    throw e;
  }
  // ★ realpath 之后再判一次 —— 符号链接可以指到目录外
  const realBase = fs.realpathSync(base);
  const rel2 = path.relative(realBase, real);
  if (escapes(rel2) || path.isAbsolute(rel2)) {
    const e = new Error('越界：符号链接指向了这个 job 的目录之外');
    e.code = 'OUT_OF_SCOPE';
    throw e;
  }
  return real;
}

module.exports = {
  DEFAULT_ROOT, PARTIAL_EXT, JOB_ID_RE,
  isValidJobId, isPartial, finalName, kindOf,
  listJob, listAll, resolveFile,
};
