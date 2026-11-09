/**
 * 端到端 UI 冒烟测试（仅供本地验收，不参与运行时）
 * 用法：node tools/ui-test.js
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:3080';
const SHOT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    defaultViewport: { width: 1600, height: 1400, deviceScaleFactor: 1 },
    args: ['--hide-scrollbars', '--disable-gpu']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('[console] ' + msg.text());
  });
  page.on('pageerror', (err) => errors.push('[pageerror] ' + err.message));

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });

  // 1. 插入示例并提交
  await page.click('[data-action="sample"]');
  await sleep(200);
  await page.click('#submitBtn');

  // 2. 等待流水线完成（最多 40s）
  await page.waitForFunction(
    () => {
      const pill = document.getElementById('taskState');
      return pill && pill.textContent.indexOf('已完成') >= 0;
    },
    { timeout: 40000 }
  );
  await sleep(900);
  await page.screenshot({ path: path.join(SHOT_DIR, 'run-clauses.png') });
  console.log('OK: 首页审查结果（条款列表）');

  // 3. 风险汇总表
  await page.click('.tab[data-tab="risks"]');
  await sleep(500);
  await page.screenshot({ path: path.join(SHOT_DIR, 'run-risks.png') });
  console.log('OK: 风险汇总表');

  // 4. 图表
  await page.click('.tab[data-tab="charts"]');
  await sleep(1200);
  await page.screenshot({ path: path.join(SHOT_DIR, 'run-charts.png') });
  console.log('OK: 风险可视化');

  // 5. 报告预览
  await page.click('.tab[data-tab="report"]');
  await sleep(500);
  await page.screenshot({ path: path.join(SHOT_DIR, 'run-report.png') });
  console.log('OK: 报告预览');

  // 6. 修改建议
  await page.click('.tab[data-tab="suggestions"]');
  await sleep(400);
  await page.screenshot({ path: path.join(SHOT_DIR, 'run-suggestions.png') });
  console.log('OK: 修改建议');

  // 7. 导出 JSON（拦截下载）
  const client = await page.target().createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(__dirname, '..', 'output') });
  const exportResp = page.waitForResponse((r) => r.url().includes('/export'), { timeout: 20000 });
  await page.click('[data-export="json"]');
  const resp = await exportResp;
  const json = await resp.json();
  console.log('OK: 导出 JSON →', json.file && json.file.name);

  // 8. 历史任务
  await page.click('.nav-link[data-nav="history"]');
  await sleep(900);
  await page.screenshot({ path: path.join(SHOT_DIR, 'run-history.png') });
  console.log('OK: 历史任务');

  // 8b. 历史列表导出 CSV
  await page.click('#historyExport');
  await sleep(600);
  console.log('OK: 导出历史列表 CSV');

  // 9. 报告管理
  await page.click('.nav-link[data-nav="reports"]');
  await sleep(900);
  await page.screenshot({ path: path.join(SHOT_DIR, 'run-reports.png') });
  await page.click('[data-open-output]');
  await sleep(400);
  console.log('OK: 报告管理');

  // 10. 设置
  await page.click('.nav-link[data-nav="settings"]');
  await sleep(900);
  await page.screenshot({ path: path.join(SHOT_DIR, 'run-settings.png') });
  console.log('OK: 设置页');

  // 11. 深色模式
  await page.click('#themeToggle');
  await page.click('.nav-link[data-nav="home"]');
  await sleep(600);
  await page.click('.tab[data-tab="charts"]');
  await sleep(1000);
  await page.screenshot({ path: path.join(SHOT_DIR, 'run-dark.png') });
  console.log('OK: 深色模式（图表）');

  // 12. 窄屏（1100）
  await page.setViewport({ width: 1100, height: 1200 });
  await sleep(500);
  await page.screenshot({ path: path.join(SHOT_DIR, 'run-narrow.png') });
  console.log('OK: 1100px 窄屏');

  // 13. 项目特色：页内弹窗（不跳页），点「开始审查」回到输入区
  await page.setViewport({ width: 1440, height: 1100 });
  await page.click('#themeToggle');
  await page.click('.nav-link[data-nav="home"]');
  await sleep(600);
  await page.screenshot({ path: path.join(SHOT_DIR, 'home-hero.png') });

  const beforeUrl = page.url();
  await page.click('[data-open-modal="features"]');
  await sleep(500);
  const modalState = await page.evaluate(() => {
    const modal = document.querySelector('#featuresModal');
    return { open: !!modal && !modal.hidden, url: location.href };
  });
  if (!modalState.open) throw new Error('项目特色弹窗未打开');
  if (modalState.url !== beforeUrl) throw new Error('项目特色弹窗导致页面跳转：' + modalState.url);
  await page.screenshot({ path: path.join(SHOT_DIR, 'modal-features.png') });
  console.log('OK: 项目特色为页内弹窗（未跳页）');

  await page.click('#featuresModal [data-start-review]');
  await sleep(900);
  const afterStart = await page.evaluate(() => ({
    closed: document.querySelector('#featuresModal').hidden,
    focused: document.activeElement ? document.activeElement.id : '',
    home: document.querySelector('#view-home').classList.contains('is-active')
  }));
  if (!afterStart.closed || !afterStart.home || afterStart.focused !== 'agreementText') {
    throw new Error('弹窗内「开始审查」未回到输入区：' + JSON.stringify(afterStart));
  }
  console.log('OK: 弹窗内「开始审查」回到输入区');

  console.log('\n控制台错误：', errors.length ? errors : '无');
  await browser.close();
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
