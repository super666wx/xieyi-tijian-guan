/**
 * 接口回归测试（不需要浏览器）
 * 用法：node tools/api-test.js  或  npm run test:api
 * 前提：服务已在 http://127.0.0.1:3080 运行（npm start）
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:3080';
const SAMPLE = path.join(__dirname, '房屋租赁合同样例.docx');

const TEXT = `服务协议

第一条 服务内容
乙方为甲方提供数据同步服务。

第二条 责任限制
因乙方原因造成的损失，赔偿总额不超过甲方已支付费用的 10%，乙方不承担任何其他责任。

第三条 单方变更
乙方有权随时变更或终止本协议，无需另行通知甲方。

第四条 自动续费
服务期满后自动续费，甲方未提出异议的视为同意续订一年。

第五条 争议解决
因本协议产生的争议由乙方所在地人民法院管辖。
`;

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`OK   ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTask(id, timeout = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const res = await fetch(`${BASE}/api/tasks/${id}`);
    if (!res.ok) throw new Error('任务查询失败：' + res.status);
    const data = await res.json();
    if (data.task.status === 'done' || data.task.status === 'failed') return data.task;
    await sleep(400);
  }
  throw new Error('等待任务超时');
}

(async () => {
  console.log(`\n接口测试 → ${BASE}\n`);

  /* 1. 健康检查 */
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('健康检查', health.ok === true, `v${health.app.version} · 规则 ${health.rules} 条`);
  check('规则库 ≥ 20 条', health.rules >= 20, `${health.rules} 条`);

  /* 2. 文本提交 */
  const created = await (
    await fetch(`${BASE}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: TEXT, filename: '接口测试.txt', docType: 'service', scale: 'standard' })
    })
  ).json();
  check('文本提交返回 taskId', !!created.taskId, created.taskId);

  const task = await waitTask(created.taskId);
  check('任务完成', task.status === 'done', `clauses=${task.clauses.length} risks=${task.risks.length}`);
  check('条款拆分', task.clauses.length >= 5, `${task.clauses.length} 条`);
  check('命中风险', task.risks.length >= 3, `${task.risks.length} 处`);
  check('综合分在 0–99', task.summary.score >= 0 && task.summary.score <= 99, `${task.summary.score}（${task.summary.levelLabel}）`);
  check('每条风险都有法条依据', task.risks.every((r) => r.basis && r.basis.law && r.basis.article));
  check('每条风险都有修改建议', task.risks.every((r) => typeof r.suggestion === 'string' && r.suggestion.length > 8));

  /* 3. 任务列表 */
  const list = await (await fetch(`${BASE}/api/tasks`)).json();
  check('任务列表包含新任务', Array.isArray(list.tasks) && list.tasks.some((t) => t.id === created.taskId));

  /* 4. 导出 JSON */
  const exp = await (
    await fetch(`${BASE}/api/tasks/${created.taskId}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'json' })
    })
  ).json();
  check('导出 JSON 返回文件信息', !!(exp.file && exp.file.url), exp.file ? exp.file.name : '');
  if (exp.file && exp.file.url) {
    const dl = await fetch(BASE + exp.file.url);
    check('JSON 可下载', dl.ok, `HTTP ${dl.status}`);
  }

  /* 5. 导出 Word */
  const docx = await (
    await fetch(`${BASE}/api/tasks/${created.taskId}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'docx' })
    })
  ).json();
  check('导出 Word 返回文件信息', !!(docx.file && docx.file.size > 10000), docx.file ? `${Math.round(docx.file.size / 1024)} KB` : '');

  /* 6. 打印页 */
  const print = await fetch(`${BASE}/api/tasks/${created.taskId}/print`);
  const printHtml = await print.text();
  check('报告打印页', print.ok && printHtml.includes('协议体检报告'));

  /* 7. 报告列表 */
  const reports = await (await fetch(`${BASE}/api/reports`)).json();
  check('报告列表', Array.isArray(reports.files) && reports.files.length > 0, `${reports.files.length} 个文件`);

  /* 8. 文件上传（docx） */
  if (fs.existsSync(SAMPLE)) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(SAMPLE)]), '房屋租赁合同样例.docx');
    form.append('scale', 'standard');
    const up = await (await fetch(`${BASE}/api/review`, { method: 'POST', body: form })).json();
    check('docx 上传返回 taskId', !!up.taskId);
    if (up.taskId) {
      const t2 = await waitTask(up.taskId);
      check('docx 解析并完成', t2.status === 'done' && t2.clauses.length >= 5, `${t2.clauses.length} 条条款`);
    }
  } else {
    console.log('SKIP docx 上传（样例文件不存在）');
  }

  /* 9. 错误处理 */
  const notFound = await fetch(`${BASE}/api/does-not-exist`);
  check('未知接口返回 404', notFound.status === 404);

  const badTask = await fetch(`${BASE}/api/tasks/rv_not_exist`);
  check('未知任务返回 404', badTask.status === 404);

  console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n测试中断：', err.message);
  process.exit(1);
});
