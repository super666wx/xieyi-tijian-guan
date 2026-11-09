/**
 * 文件上传专项测试：模拟真实用户从「拖拽区 / 选择文件」上传 .docx 走完整流水线
 * 运行：node tools/file-test.js
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:3080';
const SHOT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
const DOCX = path.join(__dirname, '房屋租赁合同样例.docx');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(DOCX)) throw new Error('缺少样例文件：' + DOCX);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1200'],
    defaultViewport: { width: 1600, height: 1200 }
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await sleep(500);

  // 1. 选择 docx 文件
  const input = await page.$('#fileInput');
  await input.uploadFile(DOCX);
  await sleep(600);

  const chipText = await page.evaluate(() => {
    const box = document.querySelector('#fileList');
    return box ? box.innerText.trim() : '';
  });
  console.log(chipText ? 'OK: 文件已进入待提交列表 → ' + chipText.replace(/\s+/g, ' ') : 'FAIL: 文件未被接受');
  if (!chipText) process.exitCode = 1;

  await page.screenshot({ path: path.join(SHOT_DIR, 'file-selected.png') });

  // 2. 提交
  await page.click('#submitBtn');
  try {
    await page.waitForFunction(() => {
      const node = document.querySelector('#taskState');
      return node && node.innerText.includes('已完成');
    }, { timeout: 45000 });
    console.log('OK: docx 上传并完成审查');
  } catch (err) {
    const state = await page.evaluate(() => (document.querySelector('#taskState') || {}).innerText);
    console.log('FAIL: 审查未完成，状态=' + state);
    process.exitCode = 1;
  }
  await sleep(600);
  await page.screenshot({ path: path.join(SHOT_DIR, 'file-result.png') });

  const summary = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('[data-tab]')].map((t) => t.innerText.replace(/\s+/g, ' ').trim());
    return tabs.join(' | ');
  });
  console.log('标签页：' + summary);

  // 3. 旧版 .doc 应给出明确提示（构造一个假 doc 头）
  const fakeDoc = path.join(__dirname, '_legacy.doc');
  const head = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  fs.writeFileSync(fakeDoc, Buffer.concat([head, Buffer.alloc(1024)]));
  await page.evaluate(() => document.querySelector('[data-action="clear"]').click());
  await sleep(300);
  const input2 = await page.$('#fileInput');
  await input2.uploadFile(fakeDoc);
  await sleep(600);
  const toastText = await page.evaluate(() => {
    // toast 会堆叠，取最后一条（最新提示）
    const list = document.querySelectorAll('.toast');
    const t = list.length ? list[list.length - 1] : null;
    return t ? t.innerText.trim() : '';
  });
  console.log(toastText && toastText.includes('.docx') ? 'OK: 旧版 .doc 有明确提示 → ' + toastText : 'WARN: 未捕获 .doc 提示（' + toastText + '）');
  fs.unlinkSync(fakeDoc);

  await page.screenshot({ path: path.join(SHOT_DIR, 'file-legacy-doc.png') });

  console.log('控制台错误：', errors.length ? errors.join(' / ') : '无');
  if (errors.length) process.exitCode = 1;
  await browser.close();
})().catch((err) => {
  console.error('测试异常：', err);
  process.exitCode = 1;
});
