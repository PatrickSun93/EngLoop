'use strict';

/**
 * agent 产出的文档 —— 让人在网页上打得开。
 *
 * ── 它治的是什么 ────────────────────────────────────────────────
 * 「落盘了」对 agent 是完成，**对人是一个够不到的地方**。
 * agent 说「写好了」，人得能在网页上打开它。
 *
 * ── 🔴 这个模块的全部风险在路径穿越 ──────────────────────────────
 * `GET /api/docs/../../etc/passwd`、URL 编码的 `%2e%2e%2f`、
 * 符号链接指到仓库外、绝对路径。
 *
 * ★★ **判据是「解析后的真实路径必须在 docs/ 里面」，不是「字符串里没有 `..`」。**
 *   后者是**拿一个词当能力的代理**（字符串匹配会误中，也会漏）。
 *   `..` 有太多写法：`%2e%2e`、`....//`、符号链接、绝对路径，
 *   **而 `path.resolve` + `realpath` 之后它们全都变成同一个东西。**
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const DOCS_DIR = 'docs';

/**
 * ★★ `root` 自己也要 `realpath`。
 *
 * macOS 上外置盘的挂载路径可能本身就是符号链接 —— 不解的话，
 * 下面那次「真实路径还在不在 root 里」的比较会**永远失败**，
 * 把每一个合法文件都判成越界。
 * **那是一个「过度安全」的 bug，症状是「什么都打不开」，
 * 而它看起来像是防线在正常工作。**
 */
function docsRoot(repo = REPO_ROOT) {
  const p = path.join(repo, DOCS_DIR);
  try { return fs.realpathSync(p); } catch (_) { return p; }
}

const MAX_BYTES = 2 * 1024 * 1024;   // 2MB
const ALLOWED_EXT = ['.md'];

const ERR = {
  OUTSIDE: 'PATH_OUTSIDE_DOCS',
  EXT: 'EXTENSION_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
  TOO_BIG: 'TOO_BIG',
  READ_FAILED: 'READ_FAILED',
};

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * 把请求里的相对路径解析成一个**确认在 docs/ 里面**的绝对路径。
 *
 * ── ★★ 顺序有讲究，反了会把「拒绝」渲染成「没找到」──────────────
 *
 *   1. `path.resolve`                     ← 不需要文件存在
 *   2. `path.relative` 判越界              ← 挡 `..` 和绝对路径
 *   3. `realpathSync`                     ← 挡符号链接（需要文件存在）
 *   4. 再判一次（realpath 之后）
 *
 * **先做不需要文件存在的检查。** 反过来的话，`../../etc/nonexistent`
 * 会在第 3 步抛 ENOENT → 被归成 404「文件不存在」，
 * **而它其实是一次越界尝试** —— 人看到 404 会以为文件名写错了。
 *
 * ⚠️ 第 4 步不能省：第 2 步只看字面路径，一个**在 docs/ 里、但指向仓库外**
 *   的符号链接能通过它。
 */
function resolveSafe(rel, { root = docsRoot() } = {}) {
  const raw = String(rel == null ? '' : rel);

  // null 字节：fs 会拒，但报出来的错很难懂 —— 提前挡，说人话。
  if (raw.includes('\0')) {
    throw fail(ERR.OUTSIDE, '路径里有空字节', { requested: raw.slice(0, 80) });
  }

  const resolved = path.resolve(root, raw);
  const relToRoot = path.relative(root, resolved);
  // `''` = 它就是 root 自己（一个目录，不是文件）
  if (relToRoot === '' || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw fail(ERR.OUTSIDE, `路径超出 ${DOCS_DIR}/ 之外`, { requested: raw.slice(0, 200) });
  }

  // 扩展名白名单。**白名单漏项响亮，黑名单漏项静默** ——
  // 前者拒绝一个该放的（人立刻发现），后者放行一个不该放的（没人发现）。
  if (!ALLOWED_EXT.includes(path.extname(resolved).toLowerCase())) {
    throw fail(ERR.EXT, `只放行 ${ALLOWED_EXT.join(' / ')}`, { requested: raw.slice(0, 200) });
  }

  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') throw fail(ERR.NOT_FOUND, '文件不存在', { requested: raw.slice(0, 200) });
    throw fail(ERR.READ_FAILED, String(err.message));
  }

  // ★ 第二道：符号链接指到外面 —— 第 2 步的字面检查看不见这个。
  const relReal = path.relative(root, real);
  if (relReal === '' || relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw fail(ERR.OUTSIDE, `符号链接指向 ${DOCS_DIR}/ 之外`, { requested: raw.slice(0, 200) });
  }
  return { abs: real, rel: relReal };
}

/** markdown 的首个 `# ` 标题。列表里只有路径的话，人得逐个点开才知道哪份是哪份。 */
function titleOf(text) {
  const m = String(text).match(/^\s*#\s+(.+?)\s*$/m);
  return m ? m[1].slice(0, 200) : null;
}

/**
 * 列出 docs/ 下的 markdown。
 *
 * ⚠️ **不跟符号链接。** 一个指向仓库外的目录链接会让整棵树漏出去，
 *   **而单文件端点那道防线在这里根本没被走到** —— 列表是另一条路径。
 */
function list({ root = docsRoot(), maxTitleBytes = 4096 } = {}) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      // ★ 符号链接一律跳过（目录和文件都是）—— 见上。
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile()) continue;
      if (!ALLOWED_EXT.includes(path.extname(e.name).toLowerCase())) continue;

      let st;
      try { st = fs.statSync(abs); } catch (_) { continue; }

      let title = null;
      try {
        // 只读开头拿标题 —— 为了列一个目录去整份读进来是没必要的
        const fd = fs.openSync(abs, 'r');
        const buf = Buffer.alloc(Math.min(maxTitleBytes, st.size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        title = titleOf(buf.toString('utf8'));
      } catch (_) { /* 拿不到标题不影响列出这个文件 */ }

      files.push({
        path: path.relative(root, abs),
        size: st.size,
        // ★ mtime 是「这份东西什么时候产的」—— 跟文件头那行来源注释是一对。
        mtime: st.mtime.toISOString(),
        title,
      });
    }
  };
  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root: DOCS_DIR, count: files.length, max_bytes: MAX_BYTES, files };
}

/** 读一份。路径安全由 `resolveSafe` 保证。 */
function read(rel, { root = docsRoot() } = {}) {
  const { abs, rel: relPath } = resolveSafe(rel, { root });

  let st;
  try { st = fs.statSync(abs); } catch (err) {
    throw fail(ERR.NOT_FOUND, '文件不存在', { requested: relPath });
  }
  if (!st.isFile()) throw fail(ERR.NOT_FOUND, '不是一个文件', { requested: relPath });

  // ★ 上限。现有文件都很小，但这些文件是 agent 写的，**它们的大小不受任何东西约束**，
  //   而 bus 的内存不该赌在这上面。
  if (st.size > MAX_BYTES) {
    throw fail(ERR.TOO_BIG, `文件 ${st.size} 字节，超过上限 ${MAX_BYTES}`, {
      requested: relPath, size: st.size, max: MAX_BYTES,
    });
  }

  let content;
  try { content = fs.readFileSync(abs, 'utf8'); } catch (err) {
    throw fail(ERR.READ_FAILED, String(err.message), { requested: relPath });
  }
  return { path: relPath, size: st.size, mtime: st.mtime.toISOString(),
           title: titleOf(content), content };
}

/**
 * 翻译成 HTTP。
 *
 * ★★ **403 和 404 必须分开。**
 *   「拒绝了」被渲染成「没找到」的话，**人会以为文件名写错了，
 *   然后去找一个不存在的问题**。而真相是这个请求被主动挡下来了。
 *
 * ★ 每一种都带 `next`（该做什么）。
 */
function httpError(err) {
  const code = err && err.code;
  if (code === ERR.OUTSIDE) {
    return { status: 403, body: {
      error: code,
      message: String(err.message),
      requested: err.requested,
      next: `**这是「拒绝了」，不是「没找到」** —— 请求的路径落在 ${DOCS_DIR}/ 之外。`
          + `如果你只是想看某份文档，先 GET /api/docs 拿列表，用那里面的 path。`,
    } };
  }
  if (code === ERR.EXT) {
    return { status: 415, body: {
      error: code, message: String(err.message), requested: err.requested,
      next: `这个端点只放行 ${ALLOWED_EXT.join(' / ')}。别的文件请直接在仓库里读。`,
    } };
  }
  if (code === ERR.NOT_FOUND) {
    return { status: 404, body: {
      error: code, message: String(err.message), requested: err.requested,
      next: 'GET /api/docs 看现有的有哪些 —— 也可能这份文档还没被写出来。',
    } };
  }
  if (code === ERR.TOO_BIG) {
    return { status: 413, body: {
      error: code, message: String(err.message),
      requested: err.requested, size: err.size, max: err.max,
      next: '太大了，这个端点不给。直接在仓库里读那个文件。',
    } };
  }
  return { status: 500, body: {
    error: ERR.READ_FAILED,
    message: String((err && err.message) || err),
    next: '**这不是「文件不存在」，是「读不了」** —— 多半是权限或磁盘问题，查一下 bus 的日志。',
  } };
}

/** `GET /api/docs` */
function listHandler({ root = undefined } = {}) {
  return (_req, res) => {
    try { res.json(list(root ? { root } : {})); }
    catch (err) {
      const { status, body } = httpError(err);
      res.status(status).json(body);
    }
  };
}

/**
 * `GET /api/docs/<path>`
 *
 * ⚠️ Express 5 的通配符是 `*splat`，`req.params.splat` 是**数组**（路径段）。
 *   兼容字符串写法，免得路由形状一改这里就静默拿到 undefined。
 */
function readHandler({ root = undefined } = {}) {
  return (req, res) => {
    const p = req.params.splat !== undefined ? req.params.splat : req.params[0];
    const rel = Array.isArray(p) ? p.join('/') : String(p == null ? '' : p);
    try { res.json(read(rel, root ? { root } : {})); }
    catch (err) {
      const { status, body } = httpError(err);
      res.status(status).json(body);
    }
  };
}

module.exports = {
  list, read, resolveSafe, httpError, listHandler, readHandler, titleOf, docsRoot,
  ERR, MAX_BYTES, ALLOWED_EXT, DOCS_DIR,
};
