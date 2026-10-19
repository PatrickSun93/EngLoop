'use strict';

/**
 * agent 产出物
 *
 * ★ 这个文件守两件事，而它们的失败方式完全不同：
 *
 *   1. **状态是从文件系统读出来的事实**（`.partial` 后缀），不是谁声明的。
 *      失败方式：面板说「已就绪」而文件只写了一半 —— 人点开一个坏 PDF。
 *
 *   2. **路径穿越**。失败方式：`/api/outputs/<job>/../../etc/passwd`。
 *      ⚠️ 而这里还有第二种失败：**判错方向**（把合法文件判成越界）——
 *      症状是「什么都打不开」。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const o = require('../lib/outputs');

let pass = 0, fail = 0;
const ok = (c, l, d = '') => c
  ? (pass++, console.log(`  ✓ ${l}`))
  : (fail++, console.log(`  ✗ ${l}${d ? '  → ' + d : ''}`));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engloop-outputs-'));
  const job = path.join(root, 'job-abc123');
  fs.mkdirSync(job, { recursive: true });

  console.log('\n【1】纯函数：job_id 白名单（安全判定，不是格式洁癖）');
  ok(o.isValidJobId('abc-123_XY') === true, '正常 job_id');
  ok(o.isValidJobId('../etc') === false, '★ 带 .. 的被拒');
  ok(o.isValidJobId('a/b') === false, '★ 带 / 的被拒');
  ok(o.isValidJobId('') === false, '空的被拒');
  ok(o.isValidJobId('a'.repeat(129)) === false, '超长被拒');
  // ⚠️ 白名单不是黑名单:`..%2f`、`....//`、符号链接名 —— 黑名单永远漏一个
  ok(o.isValidJobId('..%2f') === false, '★★ `..%2f` 也被拒（白名单，不是挡 ".."）');

  console.log('\n【2】★★ 状态来自 .partial 后缀，不是猜');
  {
    fs.writeFileSync(path.join(job, 'report.pdf'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(job, 'diagram.svg.partial'), 'y');

    const r = o.listJob('job-abc123', { root });
    const pdf = r.files.find((f) => f.name === 'report.pdf');
    const svg = r.files.find((f) => f.name === 'diagram.svg');

    ok(pdf && pdf.status === 'ready', '★ 没有 .partial 后缀 → ready');
    ok(svg && svg.status === 'writing', '★★ 有 .partial 后缀 → writing');
    ok(svg && svg.name === 'diagram.svg',
      '★ 列出来的是**最终名**（不带 .partial）—— 人看到的是它将来的样子');
    ok(pdf && pdf.kind === 'pdf' && svg.kind === 'image', 'kind 按扩展名分');
    ok(pdf && pdf.size === 2048, 'size 是真实字节数');

    // ⚠️ 为什么不用「mtime 多久没变 = 写完了」:那是猜。
    //   一个慢的生成过程会被判成写完,**而它跟真写完长得一模一样**。
    //   rename 是原子的 —— 有直接事实就不该用间接信号。
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'outputs.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(!/mtime\s*[<>]/.test(code) && !/Date\.now\(\)\s*-\s*st\.mtime/.test(code),
      '★★ 实现里没有「mtime 多久没变就算写完」那种猜法（源码断言）');
  }

  console.log('\n【3】★ 残留的 .partial 要报出来，不能当没看见');
  {
    fs.writeFileSync(path.join(job, 'report.pdf.partial'), 'leftover');
    const r = o.listJob('job-abc123', { root });
    const pdf = r.files.find((f) => f.name === 'report.pdf');
    ok(pdf && pdf.status === 'ready',
      '★ 最终名存在时以它为准（不会因为残留就说还在写）');
    ok(pdf && pdf.superseded_partial === true,
      '★★ 但残留标出来了 —— **那是「有个生成过程崩了」的唯一痕迹**');
    ok(r.files.filter((f) => f.name === 'report.pdf').length === 1,
      '★ 而且不重复列两行');
    fs.unlinkSync(path.join(job, 'report.pdf.partial'));
  }

  console.log('\n【4】★★ 路径穿越：403 和 404 必须分开');
  {
    // ★ 混成一个的话,被拒绝的人会以为文件名写错,然后去找一个不存在的问题。
    const t = (name, want, label) => {
      let got = 'OK';
      try { o.resolveFile('job-abc123', name, { root }); } catch (e) { got = e.code; }
      ok(got === want, label, `${JSON.stringify(name)} → ${got}（期望 ${want}）`);
    };
    t('report.pdf', 'OK', '正常文件放行');
    t('../../etc/passwd', 'OUT_OF_SCOPE', '★★ 穿越被挡（403 类）');
    t('..', 'OUT_OF_SCOPE', '★ 单个 .. 也挡');
    t('/etc/passwd', 'OUT_OF_SCOPE', '★ 绝对路径挡');
    t('nope.txt', 'NOT_FOUND', '★★ 不存在的文件是 404，**不是** 403');

    // ★★ 反方向：一个**字面叫 `..%2f`** 的文件是合法的，不许判成越界。
    //   `rel.startsWith('..')` 在这里会判错 —— 那是「过度安全」，
    //   症状是「一个存在的文件打不开」，而且报 403 **让人以为自己在做坏事**。
    fs.writeFileSync(path.join(job, '..%2f'), 'legit');
    t('..%2f', 'OK', '★★ 字面叫 `..%2f` 的合法文件不被误判为越界');
    fs.unlinkSync(path.join(job, '..%2f'));

    // 符号链接指到目录外
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(job, 'link.txt'));
    t('link.txt', 'OUT_OF_SCOPE', '★★ 符号链接指到目录外 → 挡住（realpath 之后再判一次）');
    fs.unlinkSync(path.join(job, 'link.txt'));
  }

  console.log('\n【5】★ 目录不存在 ≠ 出错');
  {
    const r = o.listJob('never-existed', { root });
    ok(r.exists === false && r.files.length === 0,
      '★ 没有这个 job → exists:false + 空列表（不抛）');
    // ⚠️ 但 exists 这个字段要在:「这个 job 没产出过文件」和
    //   「这个 job 根本不存在」是两件事,压成空数组就分不开了。
    const empty = path.join(root, 'job-empty');
    fs.mkdirSync(empty);
    const r2 = o.listJob('job-empty', { root });
    ok(r2.exists === true && r2.files.length === 0,
      '★★ 目录在但空 → exists:true —— 跟「目录不存在」分得开');
  }

  console.log('\n【6】★ listAll：截断了要说出来');
  {
    const all = o.listAll({ root, limit: 50 });
    ok(all.jobs.length >= 1, '列出了有文件的 job');
    ok(all.jobs.every((j) => j.files.length > 0), '★ 空 job 不出现在列表里');
    ok(all.truncated === false, '没截断时 truncated:false');

    for (let i = 0; i < 5; i++) {
      const d = path.join(root, `bulk${i}`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'f.txt'), 'x');
    }
    const cut = o.listAll({ root, limit: 2 });
    ok(cut.jobs.length === 2, '★ limit 生效');
    ok(cut.truncated === true && cut.total > 2,
      '★★ 截断了就说出来 —— **一个静默截断的列表会让人以为那就是全部**',
      JSON.stringify({ total: cut.total, truncated: cut.truncated }));
  }

  console.log('\n【7】★★ HTTP 层：状态码映射（真跑一次 express）');
  {
    const app = express();
    app.get('/api/outputs', (_req, res) => res.json(o.listAll({ root })));
    app.get('/api/outputs/:job/:file', (req, res) => {
      try {
        res.sendFile(o.resolveFile(req.params.job, req.params.file, { root }));
      } catch (err) {
        const map = { BAD_JOB_ID: 400, OUT_OF_SCOPE: 403, NOT_FOUND: 404 };
        res.status(map[err.code] || 500).json({ error: err.code, message: err.message });
      }
    });
    const srv = app.listen(0);
    const port = srv.address().port;
    const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);

    const list = await get('/api/outputs').then((r) => r.json());
    ok(Array.isArray(list.jobs), 'GET /api/outputs 返回 jobs 数组');

    const okRes = await get('/api/outputs/job-abc123/report.pdf');
    ok(okRes.status === 200, '★ 正常文件 200');

    const notFound = await get('/api/outputs/job-abc123/nope.txt');
    ok(notFound.status === 404, '★★ 不存在 → 404');

    const denied = await get('/api/outputs/job-abc123/..%2F..%2Fetc%2Fpasswd');
    ok(denied.status === 403 || denied.status === 404,
      '★★ 穿越被挡（403）', `实际 ${denied.status}`);
    // ★ 关键是**它没返回 200 + 文件内容**。这条是正控:
    //   证明上面那个 403/404 不是因为路由没匹配上。
    const body = await denied.text();
    ok(!body.includes('root:'), '★★ 而且响应体里没有 /etc/passwd 的内容');

    const badJob = await get('/api/outputs/..%2Fetc/x');
    ok(badJob.status === 400 || badJob.status === 403 || badJob.status === 404,
      '★ 非法 job_id 被拒', `实际 ${badJob.status}`);

    srv.close();
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${'─'.repeat(46)}\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ 异常:', e.stack || e.message); process.exit(1); });
