'use strict';

/**
 * 「有哪些 agent 可以起」—— 扫 `agents/` 目录得出的候选清单。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * `/api/agents` 的两个数据源（`watchdog.check` + `roster.list`）
 * **都只看得见「已经存在的」**。一个没起的 agent 不在花名册里，
 * 所以界面上根本不知道有它 —— 于是「起一个 dev」这件事只能在终端做。
 *
 * ── ⚠️ 这个做法的代价 ──────────────────────────────────────────────
 * 扫目录的问题是**目录 ≠ 意图**：一个手滑建的目录
 * 会变成界面上的一个按钮。所以响应里必须**标注来源**（`source: 'agents-dir'`），
 * 让人知道这份清单是扫出来的、不是谁声明的。
 *
 * 一个目录可能**没有 CLAUDE.md** —— 目录在，但 provision 从没对它跑过。
 * 所以判据不是「目录存在」，是**有模板**。
 *
 * ── ★ 两条必须排除的 ─────────────────────────────────────────────
 * ① **编排者自己**（`agents/JARVIS/`）。`bin/agent-start.js` 明确拒绝起
 *    orchestrator 类型 —— 界面上给它一个按钮，是给人准备一次必然的失败。
 * ② **没有模板的目录**。见上。
 */

const fs = require('node:fs');
const path = require('node:path');
const capabilities = require('./agent-capabilities');

const ROOT = path.join(__dirname, '..');
const ORCH_NAME = 'JARVIS';

/** 这份清单的来源标记。**响应里必须带**，见文件头。 */
const SOURCE = 'agents-dir';

/**
 * 从 CLAUDE.md 第一行推 type。模板首行形如 `# dev — dev agent`。
 *
 * ⚠️ **解析文本是脆的，所以推不出来时返回 null，不猜 `'dev'`。**
 *   猜错的后果不是「起不来」，是**起来一个类型错的 agent** ——
 *   而 type 决定 hook 的权限清单和 watchdog 的消费者组，
 *   错了之后的故障现场跟「hook 正常工作」长得一模一样（全是 REJECT）。
 *   `bin/agent-start.js` 那段注释记着这颗雷。
 */
function typeFromTemplate(file) {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0] || '';
    // `# <name> — <type> agent`
    const m = first.match(/^#\s*\S+\s*—\s*(\S+)\s+agent\s*$/);
    const t = m && m[1];
    return t && capabilities.isKnownType(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * 扫出候选清单。**只描述磁盘上有什么，不查花名册** ——
 * 「在不在线」由调用方拿 roster 去比对，两件事分开才测得动。
 *
 * @returns {Array<{name, type, type_source, cwd, source}>}
 */
function scan(root = ROOT) {
  const dir = path.join(root, 'agents');
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // 目录不存在 = 没有候选。**这不是错误** —— 一个还没起过任何 agent 的
    // 仓库就是这样。
    return [];
  }

  const out = [];
  for (const name of names) {
    if (name === ORCH_NAME) continue;          // ① 见文件头
    const cwd = path.join(dir, name);
    const tpl = path.join(cwd, 'CLAUDE.md');
    if (!fs.existsSync(tpl)) continue;          // ② 见文件头
    const type = typeFromTemplate(tpl);
    out.push({
      name,
      type,
      // ★ type 推不出来时前端必须让人选，所以来源要说得出。
      type_source: type ? 'claude-md-heading' : null,
      cwd,
      source: SOURCE,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 候选里减去「已经在册的」= 界面上要显示成「离线、可开启」的那些。
 *
 * @param {Array} candidates scan() 的结果
 * @param {Array} registry   roster.list() 的结果
 */
function offline(candidates, registry) {
  const online = new Set((registry || []).map((r) => r && r.name).filter(Boolean));
  return (candidates || []).filter((c) => !online.has(c.name));
}

module.exports = { SOURCE, ORCH_NAME, scan, offline, typeFromTemplate };
