'use strict';

/**
 * agy（Antigravity CLI）后端的配置 —— **唯一出处**。
 *
 * ── 专用 HOME ────────────────────────────────────────────────────────────
 *   worker 不用用户自己的 `~/.gemini`（状态目录必须可写，
 *   而用户日常的 agy 不在 sandbox 里、读同一个目录的 settings.json / hooks.json / skills ⇒ 那是一条跨出 sandbox 的持久化路径）。
 *   ⇒ worker 用一个专用 HOME：`<EngLoop 的上级目录>/EngLoop-agy-home`（不在任何仓库里）。
 *   这个 HOME 要事先用 agy 登录一次。
 *   ⚠️ 这个目录里有 agy 的登录凭据 ⇒ 它进 `agent-settings.secretDirs()` ⇒ 所有 claude agent 拒读（编排者除外，跟钥匙一样）。
 *
 * ── 专用 project ─────────────────────────────────────────────────────────
 *   不带 `--project` ⇒ agy 落到默认 project：工作区和终端都在默认 project 配的那个大目录（不是 EngLoop）、TURBO 预设
 *   （文件会落进别的仓库）。⇒ 一律带专用 project。
 *   这个 project 建在**专用 HOME 的** `.gemini/config/projects/` 下（名字 `empty`，resources 只有 `<专用 HOME>/empty`，settings 空）。
 *   缺了 ⇒ runAgy `permanent` 拒，**不回退到默认 project**。
 *   id 存在 `config/agy-project.json`（`{ "projectId": "<uuid>" }`，私有仓库提交，**不进公开导出**）：
 *   文件不在、读不出、不是 JSON、字段不是字符串 ⇒ id 为 `''` ⇒ runAgy 照「project id 没配」拒（`agy_config`）。
 *   读的是仓库里的文件，不是环境变量 —— 下面「没有环境变量覆盖」的理由照旧成立。
 *
 * ── 「上级目录」按**主工作树**算，不按 ROOT ──────────────────────────────
 *   代码可能从一棵 linked worktree（`EngLoop-worktrees/<x>`）里跑 ⇒ `dirname(ROOT)` 会推成 `EngLoop-worktrees/EngLoop-agy-home`：
 *   `secretDirs()` 拒读一个不存在的目录，**真专用 HOME 对 claude agent 可读**（fail-open）。
 *   ⇒ 按 git-common-dir 的上级（主工作树）推。不起 git 子进程：读 `ROOT/.git` ——
 *     目录 ⇒ ROOT 就是主工作树；文件 ⇒ 按 `gitdir:` 找到 `<common>/worktrees/<x>`，再按里面的 `commondir` 找到 common dir；
 *     都没有（不是 git 检出）⇒ ROOT 自己。`.git` 是文件却读不出 common dir ⇒ **抛**（不回退成 dirname(ROOT)，那条就是 fail-open）。
 *
 * 测试不改这里：runAgy 收 `opts.agy = { home, projectId }`（依赖注入）。**没有环境变量覆盖** ——
 * 一个能改 HOME / project 的环境变量，就是一个能把 worker 指回用户的 `~/.gemini` 或默认 project 的开关。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** `root` 所在仓库的主工作树（`root` 是 linked worktree 时 ≠ root） */
function mainWorktree(root) {
  const dotGit = path.join(path.resolve(root), '.git');
  let st;
  try { st = fs.statSync(dotGit); } catch (_) { return path.resolve(root); }
  if (st.isDirectory()) return path.resolve(root);
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
  if (!m) throw new Error(`agy-config：${dotGit} 是文件，但没有 gitdir: 行 ⇒ 推不出主工作树`);
  const gitDir = path.resolve(path.resolve(root), m[1]);
  let common;
  try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch (e) {
    throw new Error(`agy-config：读不出 ${gitDir}/commondir ⇒ 推不出主工作树（${e.message}）`);
  }
  return path.dirname(common);
}

/** 专用 HOME：**主工作树**的兄弟目录 */
const agyHomeFor = (root) => path.join(path.dirname(mainWorktree(root)), 'EngLoop-agy-home');

/** 专用 project id 的出处（私有仓库里提交的一个文件；公开版里没有它） */
const PROJECT_FILE = path.join(ROOT, 'config', 'agy-project.json');

/**
 * 读专用 project id。任何一种「读不到」都回 `''`，不抛 —— 这个模块被 `agent-settings.secretDirs()` 引用，
 * 抛错会连累所有 agent 起不来；而 `''` 在 runAgy 那里是 fail-closed 的（`agy_config` 拒，不落到默认 project）。
 */
function projectIdFrom(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
  try {
    const v = JSON.parse(raw).projectId;
    return typeof v === 'string' ? v : '';
  } catch (_) { return ''; }
}

const AGY_CONFIG = Object.freeze({
  /** 专用 HOME：EngLoop 主工作树的兄弟目录 */
  home: agyHomeFor(ROOT),
  /** 专用 project 的 id（在专用 HOME 下建的） */
  projectId: projectIdFrom(PROJECT_FILE),
});

module.exports = { AGY_CONFIG, agyHomeFor, mainWorktree, projectIdFrom, PROJECT_FILE };
