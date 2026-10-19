/* EngLoop 任务图页面 —— 列出图、节点状态；等批的图给一个「批准」按钮。
 *
 * ★ 只读 + 一个按钮。重派 / 放弃 留在 CLI（node bin/graph.js retry|cancel）：
 *   那两个是编排者处理异常时的动作，放在网页上会让「谁在决定」变得不清楚。
 * ★ 状态以 bus 为准，5 秒一刷；页面自己不算任何东西（不推断、不补默认）。
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const dur = (s) => (s == null ? '—' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

  async function approve(id) {
    if (!confirm(`批准任务图 ${id}？\n批了它就开跑：会占用图里的 agent、会派 worker（花额度）。`)) return;
    const r = await fetch(`/api/graphs/${encodeURIComponent(id)}/approve`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) alert(`✗ ${d.message || r.status}`);
    load();
  }
  window.__approveGraph = approve;

  async function load() {
    try {
      const r = await fetch('/api/graphs');
      if (!r.ok) { $('err').textContent = `读不了 /api/graphs（${r.status}）—— 这不是「没有图」`; return; }
      const { graphs } = await r.json();
      $('err').textContent = '';
      if (!graphs.length) { $('list').textContent = '（还没有图）'; return; }
      const parts = [];
      for (const g of graphs) {
        const vr = await fetch(`/api/graphs/${encodeURIComponent(g.id)}`);
        if (!vr.ok) { parts.push(`<div class="g err">${esc(g.id)}：读不了（${vr.status}）</div>`); continue; }
        const v = await vr.json();
        const rows = v.nodes.map((n) => `<tr>
          <td>${n.parent ? '└ ' : ''}${esc(n.id)}</td>
          <td class="st-${esc(n.state)}">${esc(n.state)}</td>
          <td>${esc(n.kind === 'work' ? `work:${n.assignee}` : n.assignee)}</td>
          <td>${dur(n.waited_s)}</td>
          <td><span class="why">${esc(n.why)}</span>${n.hold ? `<br><span class="hold">⏸ ${esc(n.hold)}</span>` : ''}</td>
        </tr>`).join('');
        const btn = v.meta.status === 'awaiting_approval'
          ? `<button onclick="__approveGraph('${esc(g.id)}')">批准开跑</button>` : '';
        parts.push(`<div class="g">
          <h2>${esc(g.id)} · ${esc(v.meta.status)}${btn}</h2>
          <div class="meta">${esc(v.meta.goal)}<br>${esc(v.meta.status_why)} · 目录 ${esc(v.meta.dir)}</div>
          <table><tr><th>节点</th><th>状态</th><th>assignee</th><th>已等</th><th>why</th></tr>${rows}</table>
        </div>`);
      }
      $('list').innerHTML = parts.join('');
    } catch (e) {
      $('err').textContent = `bus 连不上：${e.message}`;
    }
  }
  load();
  setInterval(load, 5000);
}());
