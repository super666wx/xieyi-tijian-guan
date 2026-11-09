/* =============================================================================
 * 协议合规审查智能体 · 前端交互层（v0.9）
 * -----------------------------------------------------------------------------
 * 职责：
 *   1) 视图路由与标签页切换（不刷新页面）
 *   2) 文本粘贴 / 文件上传 / 审查尺度等输入交互
 *   3) 提交流水线：POST /api/review → 轮询 /api/tasks/:id → 渲染五阶段状态
 *   4) 结果渲染：条款列表 / 风险汇总表 / Chart.js 可视化 / 报告预览 / 修改建议
 *   5) 导出：DOCX / PDF（打印视图）/ JSON
 *   6) 历史任务、报告管理、设置、主题切换
 *
 * 后端契约见 server.js 顶部注释，本文件不直接持有任何模型密钥。
 * ========================================================================== */

(function () {
  'use strict';

  /* ===========================================================================
   * 0. 常量与运行状态
   * ======================================================================== */

  const MAX_CHARS = 20000;
  const MAX_FILE_MB = 20;
  const THEME_KEY = 'cr-theme';
  const VIEWS = ['home', 'history', 'reports', 'settings', 'help'];

  const STAGES = ['parse', 'split', 'retrieve', 'score', 'report'];
  const STAGE_LABEL = {
    parse: '文档解析',
    split: '条款拆分',
    retrieve: '合规检索',
    score: '风险打分',
    report: '报告生成'
  };
  const LEVEL_LABEL = { high: '高风险', mid: '中风险', low: '低风险', safe: '合规' };
  const LEVEL_SHORT = { high: '高', mid: '中', low: '低', safe: '合规' };
  const DOC_TYPE_LABEL = {
    auto: '自动识别',
    service: '服务协议',
    privacy: '隐私政策',
    labor: '劳动合同',
    purchase: '采购 / 销售合同',
    other: '其他'
  };
  const SCALE_LABEL = { strict: '严格', standard: '标准', loose: '宽松' };

  /** 协议类型文案：与后端 docTypeInfo() 对齐；不含识别结果时退回所选类型 */
  function docTypeText(task) {
    if (!task) return '—';
    const selected = task.docTypeResolved || task.docType || 'auto';
    const detected = task.docTypeDetected || '';
    const label = DOC_TYPE_LABEL[selected] || DOC_TYPE_LABEL.other;
    if (!task.docType || task.docType === 'auto') {
      return `自动识别 · ${selected && selected !== 'other' ? label : docGenre(task)}`;
    }
    if (detected && detected !== selected && detected !== 'other' && (task.docTypeScore || 0) >= 6) {
      return `${label} · 识别更像${DOC_TYPE_LABEL[detected]}`;
    }
    return label;
  }

  /** 默认审查尺度记忆在浏览器本地，首页与设置页共用 */
  function savedScale() {
    try {
      const value = localStorage.getItem('cr-scale');
      return value && SCALE_LABEL[value] ? value : 'standard';
    } catch (err) {
      return 'standard';
    }
  }

  function syncDefaultScale() {
    $$('.seg-item[data-scale]').forEach((item) => item.classList.toggle('is-active', item.getAttribute('data-scale') === state.scale));
    $$('[data-default-scale]').forEach((item) => item.classList.toggle('is-active', item.getAttribute('data-default-scale') === state.scale));
    $$('[data-legend]').forEach((item) => item.classList.toggle('is-on', item.getAttribute('data-legend') === state.scale));
    try {
      localStorage.setItem('cr-scale', state.scale);
    } catch (err) {
      /* 隐私模式下 localStorage 可能不可用，忽略即可 */
    }
  }

  const state = {
    view: 'home',
    theme: 'light',
    files: [],
    scale: savedScale(),
    task: null,
    taskId: null,
    tasks: [],
    reports: [],
    charts: {},
    polling: null,
    running: false,
    logCount: 0,
    lastToast: null,
    historyFilter: 'all',
    historyQuery: ''
  };

  /* ===========================================================================
   * 1. 基础工具
   * ======================================================================== */

  const el = (id) => document.getElementById(id);
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  const esc = (value) =>
    String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));

  const pad2 = (n) => String(n).padStart(2, '0');

  function clockText(ts) {
    const d = ts ? new Date(ts) : new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function dateText(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function fmtBytes(n) {
    const size = Number(n) || 0;
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / 1024 / 1024).toFixed(2) + ' MB';
  }

  function throttle(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait);
    };
  }

  /** 后端地址提示（file:// 打开时浏览器禁止请求接口，必须走 http 服务地址） */
  const SERVE_URL = 'http://127.0.0.1:3080';

  function isFileProtocol() {
    return location.protocol === 'file:';
  }

  function networkMessage() {
    if (isFileProtocol()) {
      return '页面没有通过服务地址打开，接口不可用。请改用服务地址访问：' + SERVE_URL;
    }
    return '暂时连不上服务（' + location.host + '），请确认服务仍在运行后刷新页面。';
  }

  /** 顶部提示条：区分「本地文件打开」与「服务掉线」两种情况 */
  function showConnBanner() {
    if (document.querySelector('.conn-banner')) return;
    const bar = document.createElement('div');
    bar.className = 'conn-banner';
    const link = isFileProtocol()
      ? `<a class="conn-link" href="${SERVE_URL}/">去服务地址打开</a>`
      : '<button class="conn-link" type="button" data-retry-conn>重试连接</button>';
    bar.innerHTML =
      '<svg class="icon icon-sm"><use href="#i-alert" /></svg>' +
      '<span class="conn-text">' + esc(networkMessage()) + '</span>' +
      link;
    document.body.appendChild(bar);
    document.body.classList.add('has-conn-banner');
    const retry = bar.querySelector('[data-retry-conn]');
    if (retry) {
      retry.addEventListener('click', () => {
        hideConnBanner();
        bootHealth();
      });
    }
  }

  function hideConnBanner() {
    $$('.conn-banner').forEach((node) => node.remove());
    document.body.classList.remove('has-conn-banner');
  }

  /** 统一 fetch 封装：非 2xx 或 ok:false 一律抛错 */
  async function api(path, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    if (opts.body && typeof opts.body === 'string' && !opts.headers['Content-Type']) {
      opts.headers['Content-Type'] = 'application/json';
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (err) {
      // fetch 只在网络层失败时抛异常（服务没起 / 本地文件打开 / 被拦截）
      showConnBanner();
      throw new Error(networkMessage());
    }
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    if (!res.ok || (data && data.ok === false)) {
      const msg = (data && data.error) || `请求失败（HTTP ${res.status}）`;
      throw new Error(msg);
    }
    return data || {};
  }

  function download(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name || '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /**
   * 先取回文件再落盘。
   * 直接 <a download> 在部分浏览器 / 反向代理（隧道）下会被忽略：
   * JSON、纯文本会被当成页面打开，用户看到“没下载”。
   * 走 Blob 可以稳定触发下载，也能把失败原因说清楚。
   */
  async function downloadFile(url, name, label) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        const reason = res.status === 404 ? '文件不存在，可能已被删除' : 'HTTP ' + res.status;
        throw new Error(reason);
      }
      const blob = await res.blob();
      if (!blob.size) throw new Error('文件内容为空');
      const objectUrl = URL.createObjectURL(blob);
      download(objectUrl, name);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
      toast('已下载 ' + (label || name), 'ok');
    } catch (err) {
      toast('下载失败：' + err.message, 'error');
      pushLog('warn', 'export', '下载失败 ' + (label || name) + '：' + err.message);
    }
  }

  /* ------------------------------- Toast -------------------------------- */

  function toast(message, kind) {
    const host = el('toastHost');
    if (!host) return;
    // 同一条提示 2.5 秒内不重复弹出（例如启动自检与提交失败给出同样的连接提示）
    const now = Date.now();
    if (state.lastToast && state.lastToast.text === message && now - state.lastToast.at < 2500) return;
    state.lastToast = { text: message, at: now };
    const type = kind || 'info';
    const icon = type === 'error' ? '#i-alert' : type === 'warn' ? '#i-alert' : type === 'ok' ? '#i-check-circle' : '#i-spark';
    const node = document.createElement('div');
    node.className = 'toast toast-' + type;
    node.innerHTML = `<svg class="icon icon-sm"><use href="${icon}" /></svg><span>${esc(message)}</span>`;
    host.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .25s ease, transform .25s ease';
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      setTimeout(() => node.remove(), 260);
    }, 3200);
  }

  /* ===========================================================================
   * 2. 主题（浅色 / 深色 / 跟随系统）
   * ======================================================================== */

  const media = window.matchMedia('(prefers-color-scheme: dark)');

  function resolveTheme(mode) {
    if (mode === 'auto') return media.matches ? 'dark' : 'light';
    return mode === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(mode) {
    const dark = resolveTheme(mode) === 'dark';
    document.documentElement.classList.toggle('dark', dark);
    const sun = $('.theme-sun');
    const moon = $('.theme-moon');
    if (sun && moon) {
      sun.style.display = dark ? 'block' : 'none';
      moon.style.display = dark ? 'none' : 'block';
    }
    $$('[data-theme-set]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-theme-set') === mode);
    });
    if (state.task) renderCharts(state.task);
  }

  function setTheme(mode) {
    state.theme = mode;
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch (err) {
      /* localStorage 不可用时静默降级 */
    }
    applyTheme(mode);
  }

  function initTheme() {
    let saved = 'light';
    try {
      saved = localStorage.getItem(THEME_KEY) || 'light';
    } catch (err) {
      saved = 'light';
    }
    setTheme(saved);
    const toggle = el('themeToggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const dark = document.documentElement.classList.contains('dark');
        setTheme(dark ? 'light' : 'dark');
      });
    }
    media.addEventListener('change', () => {
      if (state.theme === 'auto') applyTheme('auto');
    });
    $$('[data-theme-set]').forEach((btn) => {
      btn.addEventListener('click', () => setTheme(btn.getAttribute('data-theme-set')));
    });
  }

  /* ===========================================================================
   * 3. 视图路由
   * ======================================================================== */

  function viewFromHash() {
    const m = (location.hash || '').match(/^#view-([a-z]+)$/);
    return m && VIEWS.indexOf(m[1]) >= 0 ? m[1] : null;
  }

  function go(view, options) {
    const target = VIEWS.indexOf(view) >= 0 ? view : 'home';
    const opts = options || {};
    state.view = target;

    $$('.view').forEach((node) => node.classList.toggle('is-active', node.getAttribute('data-view') === target));
    $$('.nav-link[data-nav]').forEach((link) => link.classList.toggle('is-active', link.getAttribute('data-nav') === target));

    if (!opts.keepScroll) window.scrollTo({ top: 0, behavior: 'smooth' });

    if (target === 'history') loadTasks();
    if (target === 'reports') loadReports();
    if (target === 'settings') loadConfig();
    if (target === 'home' && state.task) renderCharts(state.task);
  }

  function initRouter() {
    const initial = viewFromHash();
    if (initial) {
      $$('.view').forEach((node) => node.classList.toggle('is-active', node.getAttribute('data-view') === initial));
      $$('.nav-link[data-nav]').forEach((link) => link.classList.toggle('is-active', link.getAttribute('data-nav') === initial));
      state.view = initial;
      if (initial === 'history') loadTasks();
      if (initial === 'reports') loadReports();
      if (initial === 'settings') loadConfig();
    }

    window.addEventListener('hashchange', () => {
      const view = viewFromHash();
      if (view) go(view, { keepScroll: false });
    });

    $$('[data-nav-to]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        go(btn.getAttribute('data-nav-to'));
      });
    });

    // 品牌区点击回首页
    const brand = $('.brand');
    if (brand) {
      brand.style.cursor = 'pointer';
      brand.addEventListener('click', () => go('home'));
    }
  }

  /* ===========================================================================
   * 4. 结果区标签页
   * ======================================================================== */

  function activateTab(name) {
    $$('.tab[data-tab]').forEach((tab) => {
      const on = tab.getAttribute('data-tab') === name;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.tab-panel[data-panel]').forEach((panel) => panel.classList.toggle('is-active', panel.getAttribute('data-panel') === name));
    if (name === 'charts' && state.task) {
      // 隐藏状态下 canvas 尺寸为 0，切换可见后再绘制
      requestAnimationFrame(() => renderCharts(state.task));
    }
  }

  function initTabs() {
    $$('.tab[data-tab]').forEach((tab) => {
      tab.addEventListener('click', () => activateTab(tab.getAttribute('data-tab')));
    });
  }

  /* ===========================================================================
   * 5. 输入区：文本 / 文件 / 参数
   * ======================================================================== */

  /* 三种协议示例：由 /api/samples 提供（data/samples.json），加载失败时用内置兜底 */
  let SAMPLE_LIST = null;

  const SAMPLE_FALLBACK = [
    {
      key: 'cloud',
      title: '云服务协议',
      desc: '单方免责 · 自动续费 · 数据权利',
      expect: '高风险',
      text: [
        '云服务合作协议',
        '',
        '第一条 服务内容',
        '乙方按照本协议约定为甲方提供云存储与数据同步服务，服务可用性以实际运行情况为准。',
        '',
        '第二条 责任限制',
        '因乙方原因造成的损失，赔偿总额不超过甲方已支付服务费的 10%。因系统故障、第三方服务中断、政策调整等造成的损失，乙方不承担任何责任。',
        '',
        '第三条 服务变更与终止',
        '乙方有权随时变更、中止或终止本协议全部或部分服务，无需另行通知甲方，且无需承担任何责任。',
        '',
        '第四条 费用与续费',
        '服务费用以乙方最新公示价格为准，乙方有权单方面调整收费标准。服务期满后自动续费，甲方未在到期前提出异议的，视为同意续订一年。'
      ].join('\n')
    }
  ];

  async function loadSamples() {
    if (SAMPLE_LIST) return SAMPLE_LIST;
    try {
      const data = await api('/api/samples?full=1');
      const list = (data.samples || []).filter((s) => s && s.key && String(s.text || '').trim());
      SAMPLE_LIST = list.length ? list : SAMPLE_FALLBACK;
    } catch (err) {
      SAMPLE_LIST = SAMPLE_FALLBACK;
    }
    return SAMPLE_LIST;
  }

  function insertSample(sample) {
    const area = el('agreementText');
    if (!area || !sample) return;
    area.value = sample.text;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    updateCharCount();
    area.focus();
    const size = sample.text.length.toLocaleString('zh-CN');
    toast(`已插入示例：${sample.title}（${size} 字）`, 'ok');
    pushLog('ready', 'input', `示例协议已载入：${sample.title} · ${sample.desc || ''} · 预期${sample.expect || '风险'}`);
  }

  async function renderSampleMenu() {
    const list = el('sampleList');
    if (!list) return;
    list.innerHTML = '<p class="sample-loading">载入示例…</p>';
    const samples = await loadSamples();
    list.innerHTML = samples
      .map(
        (s) => `
        <button class="sample-item" type="button" role="menuitem" data-sample="${esc(s.key)}">
          <span class="sample-item-title">${esc(s.title)}<em>${esc(s.expect || '')}</em></span>
          <span class="sample-item-desc">${esc(s.desc || '')}</span>
        </button>`
      )
      .join('');
    $$('[data-sample]', list).forEach((btn) =>
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const hit = samples.find((s) => s.key === btn.getAttribute('data-sample'));
        closeSampleMenu();
        insertSample(hit);
      })
    );
  }

  function openSampleMenu() {
    const menu = el('sampleMenu');
    const btn = $('[data-action="sample-open"]');
    if (!menu || !btn) return;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    renderSampleMenu();
  }

  function closeSampleMenu() {
    const menu = el('sampleMenu');
    const btn = $('[data-action="sample-open"]');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function toggleSampleMenu() {
    const menu = el('sampleMenu');
    if (!menu) return;
    if (menu.hidden) openSampleMenu();
    else closeSampleMenu();
  }

  function updateCharCount() {
    const area = el('agreementText');
    const node = el('charCount');
    if (!area || !node) return;
    const len = area.value.length;
    node.textContent = `${len.toLocaleString('zh-CN')} / ${MAX_CHARS.toLocaleString('zh-CN')}`;
    node.classList.toggle('is-warn', len > MAX_CHARS);
    node.style.color = len > MAX_CHARS ? 'var(--danger)' : '';
  }

  function renderFileList() {
    const host = el('fileList');
    if (!host) return;
    if (!state.files.length) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    host.innerHTML = state.files
      .map(
        (file, idx) => `
        <div class="file-chip">
          <svg class="icon icon-sm"><use href="#i-file" /></svg>
          <span class="file-name">${esc(file.name)}</span>
          <span class="file-size">${fmtBytes(file.size)}</span>
          <button class="link-btn" type="button" data-remove-file="${idx}" aria-label="移除文件">移除</button>
        </div>`
      )
      .join('');

    $$('[data-remove-file]', host).forEach((btn) => {
      btn.addEventListener('click', () => {
        state.files.splice(Number(btn.getAttribute('data-remove-file')), 1);
        if (el('fileInput')) el('fileInput').value = '';
        renderFileList();
      });
    });
  }

  function addFile(file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();

    if (ext === 'doc') {
      toast('旧版 .doc 无法直接解析，请在 Word 中「另存为」.docx 后重试', 'warn');
      pushLog('warn', 'input', `已拒绝 ${file.name}：旧版 Word 格式`);
      return;
    }
    if (['txt', 'docx', 'pdf', 'md'].indexOf(ext) < 0) {
      toast('仅支持 .txt / .docx / .pdf 文件', 'warn');
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      toast(`文件超过 ${MAX_FILE_MB}MB，请压缩或改传关键条款部分`, 'warn');
      return;
    }
    state.files = [file];
    renderFileList();
    pushLog('info', 'input', `已选择文件：${file.name}（${fmtBytes(file.size)}）`);
  }

  function initInput() {
    const area = el('agreementText');
    if (area) {
      area.addEventListener('input', updateCharCount);
      updateCharCount();
    }

    $$('[data-action="sample-open"]').forEach((btn) =>
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleSampleMenu();
      })
    );

    document.addEventListener('click', (ev) => {
      const picker = el('samplePicker');
      if (!picker || picker.contains(ev.target)) return;
      closeSampleMenu();
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeSampleMenu();
    });

    $$('[data-action="clear"]').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (area) area.value = '';
        state.files = [];
        if (el('fileInput')) el('fileInput').value = '';
        renderFileList();
        updateCharCount();
        toast('已清空输入', 'info');
      })
    );

    const dropzone = el('dropzone');
    const fileInput = el('fileInput');
    if (dropzone && fileInput) {
      dropzone.addEventListener('click', () => fileInput.click());
      dropzone.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          fileInput.click();
        }
      });
      ['dragenter', 'dragover'].forEach((name) =>
        dropzone.addEventListener(name, (ev) => {
          ev.preventDefault();
          dropzone.classList.add('is-drag');
        })
      );
      ['dragleave', 'drop'].forEach((name) =>
        dropzone.addEventListener(name, (ev) => {
          ev.preventDefault();
          dropzone.classList.remove('is-drag');
        })
      );
      dropzone.addEventListener('drop', (ev) => {
        const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        addFile(file);
      });
      fileInput.addEventListener('change', () => addFile(fileInput.files && fileInput.files[0]));
    }

    // 审查尺度
    const scaleSeg = $('#inputCard .seg');
    if (scaleSeg) {
      $$('.seg-item[data-scale]', scaleSeg).forEach((btn) =>
        btn.addEventListener('click', () => {
          state.scale = btn.getAttribute('data-scale');
          $$('.seg-item[data-scale]', scaleSeg).forEach((item) => item.classList.toggle('is-active', item === btn));
          syncDefaultScale();
        })
      );
      syncDefaultScale();
    }

    const submitBtn = el('submitBtn');
    if (submitBtn) submitBtn.addEventListener('click', submitReview);

    document.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        submitReview();
      }
    });
  }

  /* ===========================================================================
   * 6. 控制台日志与五阶段进度
   * ======================================================================== */

  const LOG_LEVEL = {
    info: { text: 'INFO', cls: 'lv-info' },
    ok: { text: 'OK', cls: 'lv-ok' },
    warn: { text: 'WARN', cls: 'lv-warn' },
    err: { text: 'ERR', cls: 'lv-err' },
    agent: { text: 'AGENT', cls: 'lv-agent' },
    ready: { text: 'READY', cls: 'lv-ready' }
  };

  function pushLog(level, tag, message) {
    const body = el('logBody');
    if (!body) return;
    const meta = LOG_LEVEL[level] || LOG_LEVEL.info;
    const line = document.createElement('div');
    line.className = 'log-line';
    line.innerHTML = `<span class="log-ts">${clockText()}</span><span class="log-lv ${meta.cls}">${meta.text}</span><span class="log-tag">${esc(
      tag
    )}</span><span class="log-msg">${esc(message)}</span>`;
    const prompt = $('.log-prompt', body);
    if (prompt) body.insertBefore(line, prompt);
    else body.appendChild(line);
    state.logCount += 1;
    while (body.querySelectorAll('.log-line').length > 160) {
      const first = body.querySelector('.log-line');
      if (!first) break;
      first.remove();
    }
    body.scrollTop = body.scrollHeight;
  }

  function clearLog() {
    const body = el('logBody');
    if (!body) return;
    $$('.log-line', body).forEach((line) => line.remove());
    state.logCount = 0;
    pushLog('ready', 'system', '日志已清空，等待下一次提交 …');
  }

  function resetSteps() {
    $$('.step[data-step]').forEach((step) => step.classList.remove('is-active', 'is-done'));
    const pill = el('pipelineState');
    if (pill) {
      pill.className = 'pill pill-idle';
      pill.innerHTML = '<span class="dot"></span>流水线待启动';
    }
  }

  function syncPipeline(task) {
    const idx = STAGES.indexOf(task.stage);
    const done = task.status === 'done';
    $$('.step[data-step]').forEach((node) => {
      const i = STAGES.indexOf(node.getAttribute('data-step'));
      node.classList.toggle('is-done', done || i < idx);
      node.classList.toggle('is-active', !done && i === idx);
    });
    const pill = el('pipelineState');
    if (pill) {
      if (done) {
        pill.className = 'pill pill-done';
        pill.innerHTML = '<span class="dot"></span>流水线完成';
      } else if (task.status === 'failed') {
        pill.className = 'pill pill-fail';
        pill.innerHTML = '<span class="dot"></span>流水线中断';
      } else {
        pill.className = 'pill pill-run';
        const pct = Math.round(task.progress || 0);
        pill.innerHTML = `<span class="dot"></span>${esc(STAGE_LABEL[task.stage] || '执行中')} ${pct}%`;
      }
    }
  }

  function setTaskState(kind, text) {
    const pill = el('taskState');
    if (!pill) return;
    const cls = kind === 'run' ? 'pill-run' : kind === 'done' ? 'pill-done' : kind === 'fail' ? 'pill-fail' : 'pill-idle';
    pill.className = 'pill ' + cls;
    pill.innerHTML = '<span class="dot"></span>' + esc(text);
  }

  /* ===========================================================================
   * 7. 提交流水线
   * ======================================================================== */

  function stopPolling() {
    if (state.polling) {
      clearTimeout(state.polling);
      state.polling = null;
    }
  }

  async function submitReview() {
    if (state.running) return;

    const area = el('agreementText');
    const text = area ? area.value.trim() : '';
    const file = state.files[0];

    if (!text && !file) {
      toast('请先粘贴协议文本或上传文件', 'warn');
      if (area) area.focus();
      return;
    }
    if (text.length > MAX_CHARS && !file) {
      toast(`文本超过 ${MAX_CHARS.toLocaleString('zh-CN')} 字，请截取核心条款后再试`, 'warn');
      return;
    }

    state.running = true;
    stopPolling();
    if (area) area.value = '';
    state.files = [];
    if (el('fileInput')) el('fileInput').value = '';
    renderFileList();
    updateCharCount();

    const submitBtn = el('submitBtn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add('is-loading');
    }
    const resultCard = el('resultCard');
    if (resultCard) resultCard.classList.add('is-busy');

    resetSteps();
    clearLog();
    setTaskState('run', '提交中…');

    const docType = el('docType') ? el('docType').value : 'auto';
    pushLog('info', 'agent', `接收协议：${file ? file.name : '粘贴文本'} · ${file ? fmtBytes(file.size) : text.length + ' 字'}`);
    pushLog('info', 'agent', `参数：尺度 ${SCALE_LABEL[state.scale] || state.scale} · 类型 ${DOC_TYPE_LABEL[docType] || docType}`);
    pushLog('info', 'pipeline', '流水线启动：解析 → 拆分 → 检索 → 打分 → 报告');

    const form = new FormData();
    if (file) form.append('file', file, file.name);
    else form.append('text', text);
    form.append('filename', file ? file.name : '粘贴文本.txt');
    form.append('docType', docType);
    form.append('scale', state.scale);

    try {
      const data = await api('/api/review', { method: 'POST', body: form });
      state.taskId = data.taskId;
      state.task = data.task;
      state.logCount = 0;
      syncPipeline(data.task);
      pollTask(data.taskId);
    } catch (err) {
      pushLog('err', 'system', err.message);
      setTaskState('fail', '提交失败');
      toast(err.message, 'error');
      finishRun();
    }
  }

  function pollTask(taskId) {
    const tick = async () => {
      if (state.taskId !== taskId) return;
      try {
        const data = await api('/api/tasks/' + encodeURIComponent(taskId));
        const task = data.task;
        state.task = task;

        // 增量追加后端日志（后端返回全量，前端按已打印条数去重）
        const logs = task.logs || [];
        if (logs.length > state.logCount) {
          logs.slice(state.logCount).forEach((entry) => pushLog(normalizeLevel(entry.level), entry.tag || 'agent', entry.msg));
          state.logCount = logs.length;
        }

        syncPipeline(task);
        if (task.status === 'running') setTaskState('run', `审查中 · ${Math.round(task.progress || 0)}%`);

        if (task.status === 'done') {
          renderTask(task);
          stopPolling();
          finishRun();
          toast(`审查完成：${task.risks.length} 处风险 · 综合风险分 ${task.summary ? task.summary.score : '—'}`, 'ok');
          loadTasks({ silent: true });
          return;
        }
        if (task.status === 'failed') {
          pushLog('err', 'system', task.error || '审查失败');
          setTaskState('fail', '审查失败');
          toast(task.error || '审查失败', 'error');
          stopPolling();
          finishRun();
          return;
        }
        state.polling = setTimeout(tick, 700);
      } catch (err) {
        pushLog('warn', 'poll', '轮询失败：' + err.message + '（1.5s 后重试）');
        state.polling = setTimeout(tick, 1500);
      }
    };
    state.polling = setTimeout(tick, 600);
  }

  function normalizeLevel(level) {
    const map = { info: 'info', ok: 'ok', warn: 'warn', error: 'err', err: 'err', agent: 'agent', ready: 'ready' };
    return map[level] || 'info';
  }

  function finishRun() {
    state.running = false;
    const submitBtn = el('submitBtn');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('is-loading');
    }
    const resultCard = el('resultCard');
    if (resultCard) resultCard.classList.remove('is-busy');
  }

  /* ===========================================================================
   * 8. 结果渲染
   * ======================================================================== */

  function renderTask(task) {
    state.task = task;
    const summary = task.summary || {};

    if (el('clauseCount')) el('clauseCount').textContent = task.clauses ? task.clauses.length : 0;
    if (el('riskCount')) el('riskCount').textContent = task.risks ? task.risks.length : 0;

    renderClauses(task);
    renderRisks(task);
    renderSuggestions(task);
    renderReport(task);
    renderCharts(task);
    enableExports(task);
    chatOnTask(task);

    setTaskState('done', `已完成 · ${summary.score !== undefined ? summary.score : '—'} 分`);
    const pipelinePill = el('pipelineState');
    if (pipelinePill) {
      pipelinePill.className = 'pill pill-done';
      pipelinePill.innerHTML = '<span class="dot"></span>流水线完成';
    }
  }

  /* --------------------------- 8.1 条款列表 ------------------------------ */

  /** 条款正文：去掉与标题重复的「第X条 标题」首行，避免视觉重复 */
  function clauseBody(clause) {
    const text = String(clause.text || '');
    const firstLine = text.split('\n')[0].trim();
    if (firstLine && clause.rawNo && firstLine.indexOf(clause.rawNo) === 0 && text.indexOf('\n') > 0) {
      return text.slice(text.indexOf('\n') + 1).trim();
    }
    return text;
  }

  function clip(text, max) {
    const value = String(text === undefined || text === null ? '' : text);
    return value.length > max ? value.slice(0, max) + '…' : value;
  }

  /** 在条款正文里高亮风险命中的原句，便于对照 */
  function highlightHits(text, needles) {
    const safe = esc(text);
    const list = (needles || [])
      .map((item) => esc(String(item || '').trim()))
      .filter((item) => item.length >= 4);
    if (!list.length) return safe;
    const uniq = Array.from(new Set(list))
      .sort((a, b) => b.length - a.length)
      .slice(0, 6);
    let out = safe;
    uniq.forEach((needle) => {
      const index = out.indexOf(needle);
      if (index < 0) return;
      out = out.slice(0, index) + '<mark class="hit">' + needle + '</mark>' + out.slice(index + needle.length);
    });
    return out;
  }

  /** 依据条款类型分布推断协议大类，用于「自动识别」时的展示 */
  function docGenre(task) {
    const types = {};
    (task.clauses || []).forEach((clause) => {
      const key = clause.type || '其他';
      types[key] = (types[key] || 0) + 1;
    });
    const has = (name) => types[name] > 0;
    if (has('劳动')) return '劳动人事类';
    if (has('服务内容')) return '商务服务类';
    if (has('费用与结算')) return '商务合同类';
    if (has('个人信息') || has('保密')) return '隐私与数据类';
    if (has('知识产权')) return '知识产权类';
    return '综合协议';
  }

  function renderClauses(task) {
    const panel = $('.tab-panel[data-panel="clauses"]');
    if (!panel) return;
    const clauses = task.clauses || [];

    if (!clauses.length) {
      panel.innerHTML = emptyBlock('#i-layers', '未拆分到条款', '请检查文本是否包含「第一条」「第二条」等条款序号，或直接上传 .docx 文件。', '');
      return;
    }

    const rows = clauses
      .map((clause) => {
        const risks = (task.risks || []).filter((r) => r.clauseIndex === clause.index);
        const chips = risks
          .map(
            (r) =>
              `<button class="risk-chip is-${esc(r.level)}" type="button" data-goto-risk="${esc(r.id)}" title="${esc(
                r.name
              )}">${esc(r.name)}</button>`
          )
          .join('');
        return `
          <article class="clause-item" data-level="${esc(clause.level)}" data-clause-index="${clause.index}" data-text="${esc(
          (clause.rawNo + clause.title + clause.text).toLowerCase()
        )}">
            <header class="clause-head">
              <span class="clause-no">${esc(clause.rawNo)}</span>
              <span class="clause-title">${esc(clause.title || '未命名条款')}</span>
              <span class="clause-type">${esc(clause.type || '其他')}</span>
              <span class="level-pill is-${esc(clause.level)}">${esc(LEVEL_LABEL[clause.level] || '合规')}</span>
            </header>
            <p class="clause-text">${highlightHits(
              clauseBody(clause),
              risks.map((r) => r.evidence)
            )}</p>
            ${chips ? `<div class="clause-risks">${chips}</div>` : ''}
            ${CHAT.enabled ? `<div class="clause-actions">${askBtn('data-ask-clause', clause.index)}</div>` : ''}
          </article>`;
      })
      .join('');

    panel.innerHTML = `
      <div class="panel-toolbar">
        <div class="search-box">
          <svg class="icon icon-sm"><use href="#i-search" /></svg>
          <input type="text" id="clauseSearch" placeholder="搜索条款编号 / 关键词" />
        </div>
        <button class="btn btn-ghost btn-sm" type="button" id="clauseOnlyRisk" aria-pressed="false">
          <svg class="icon icon-sm"><use href="#i-filter" /></svg>仅看风险条款
        </button>
        <span class="toolbar-note" id="clauseNote">共 ${clauses.length} 条</span>
      </div>
      <div class="clause-list" id="clauseList">${rows}</div>`;

    const search = el('clauseSearch');
    const onlyRisk = el('clauseOnlyRisk');

    const applyFilter = () => {
      const q = (search ? search.value : '').trim().toLowerCase();
      const riskOnly = onlyRisk && onlyRisk.getAttribute('aria-pressed') === 'true';
      let shown = 0;
      $$('.clause-item', panel).forEach((node) => {
        const hitText = !q || (node.getAttribute('data-text') || '').indexOf(q) >= 0;
        const hitRisk = !riskOnly || node.getAttribute('data-level') !== 'safe';
        const show = hitText && hitRisk;
        node.style.display = show ? '' : 'none';
        if (show) shown += 1;
      });
      if (el('clauseNote')) el('clauseNote').textContent = `共 ${clauses.length} 条 · 显示 ${shown} 条`;
    };

    if (search) search.addEventListener('input', throttle(applyFilter, 120));
    if (onlyRisk) {
      onlyRisk.addEventListener('click', () => {
        const on = onlyRisk.getAttribute('aria-pressed') === 'true';
        onlyRisk.setAttribute('aria-pressed', on ? 'false' : 'true');
        onlyRisk.classList.toggle('is-on', !on);
        applyFilter();
      });
    }

    // 展开 / 收起条款原文
    $$('.clause-item', panel).forEach((node) => {
      const textNode = $('.clause-text', node);
      if (textNode) textNode.addEventListener('click', () => node.classList.toggle('is-open'));
    });

    // 风险标签跳转到风险表
    $$('[data-goto-risk]', panel).forEach((chip) =>
      chip.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = chip.getAttribute('data-goto-risk');
        activateTab('risks');
        const detail = $('.rt-detail[data-detail="' + id + '"]');
        if (detail) {
          $$('.rt-detail').forEach((node) => node.classList.toggle('is-open', node === detail));
          requestAnimationFrame(() => detail.scrollIntoView({ block: 'center', behavior: 'smooth' }));
        }
      })
    );
  }

  /* --------------------------- 8.2 风险汇总表 ---------------------------- */

  /* --------------------------- 8.2 风险汇总表 ---------------------------- */

  /** 风险卡里的「延伸参考条文」折叠块（向量检索出的同主题条文） */
  function lawRefsBlock(risk) {
    const sources = risk.sources || [];
    if (!sources.length) return '';
    return `
      <details class="law-refs">
        <summary>延伸参考（${sources.length}）</summary>
        <ul>
          ${sources
            .map(
              (s, i) => `<li>
                <span class="law-ref-name">${esc(s.lawShort)} ${esc(s.artLabel)}</span>
                <span class="law-ref-score">相关度 ${(s.score * 100).toFixed(0)}%</span>
                <p class="law-ref-text">${esc(s.text)}</p>
                <button class="law-ref-copy btn btn-ghost btn-sm" type="button" data-copy="${esc(
                  '《' + s.lawShort + '》' + s.artLabel + '：' + s.text
                )}">复制条文</button>
              </li>`
            )
            .join('')}
        </ul>
      </details>`;
  }

  /** 条文正文：单条渲染一段；规则引用多条时逐条分段 */
  function lawBody(basis) {
    const parts = (basis && basis.parts) || [];
    if (parts.length > 1) {
      return parts
        .map(
          (part) =>
            `<p class="law-text"><span class="law-part-no">${esc(part.artLabel)}</span>${esc(part.text)}</p>`
        )
        .join('');
    }
    return `<p class="law-text">${esc((basis && (basis.text || basis.quote)) || '—')}</p>`;
  }

  function renderRisks(task) {
    const panel = $('.tab-panel[data-panel="risks"]');
    if (!panel) return;
    const summary = task.summary || {};
    const risks = (task.risks || []).slice().sort((a, b) => {
      const weight = { high: 3, mid: 2, low: 1 };
      return (weight[b.level] || 0) - (weight[a.level] || 0);
    });

    const stats = `
      <div class="risk-stats">
        <div class="risk-stat"><span class="rs-num is-high">${summary.high || 0}</span><span class="rs-label">高风险</span></div>
        <div class="risk-stat"><span class="rs-num is-mid">${summary.mid || 0}</span><span class="rs-label">中风险</span></div>
        <div class="risk-stat"><span class="rs-num is-low">${summary.low || 0}</span><span class="rs-label">低风险</span></div>
        <div class="risk-stat"><span class="rs-num is-safe">${summary.compliantClauses || 0}</span><span class="rs-label">合规条款</span></div>
        <div class="risk-stat risk-stat-wide"><span class="rs-num is-brand">${summary.score || 0}</span><span class="rs-label">综合风险分 · ${esc(
      summary.levelLabel || '—'
    )}</span></div>
      </div>`;

    if (!risks.length) {
      panel.innerHTML =
        stats +
        emptyBlock('#i-check-circle', '未发现明显风险', '本次审查未命中规则库风险特征，建议结合业务实际再人工复核一次。', '');
      return;
    }

    const rows = risks
      .map((r) => {
        const basis = r.basis || {};
        return `
        <div class="rt-row is-clickable" data-risk-row="${esc(r.id)}">
          <span><span class="level-pill is-${esc(r.level)}">${esc(LEVEL_SHORT[r.level] || '—')}</span></span>
          <span class="rt-clause"><button class="rt-jump" type="button" data-jump-clause="${esc(
            String(r.clauseIndex)
          )}" title="定位到条款列表">${esc(r.clauseRawNo)}</button></span>
          <span class="rt-name">${esc(r.type)}<small>${esc(r.name)}</small></span>
          <span class="rt-basis">${esc(basis.law || '')}${esc(basis.article || '')}</span>
          <span class="rt-sug" title="${esc(r.suggestion)}">${esc(clip(r.suggestion, 48))}</span>
        </div>
        <div class="rt-detail" data-detail="${esc(r.id)}">
          <p><b>原文依据：</b>${esc(r.evidence || '—')}</p>
          <div class="law-block">
            <div class="law-head">
              <span class="law-name">${esc(basis.law || '')}${esc(basis.article || '')}</span>
              <span class="law-badge ${basis.official ? 'is-official' : 'is-digest'}">${basis.official ? '法条原文' : '要点摘录'}</span>
            </div>
            ${lawBody(basis)}
            ${lawRefsBlock(r)}
          </div>
          <p><b>修改建议：</b>${esc(r.suggestion)}</p>
          <div class="rt-actions">${askBtn('data-ask-risk', r.id)}</div>
        </div>`;
      })
      .join('');

    panel.innerHTML =
      stats +
      `<div class="risk-table">
        <div class="rt-row rt-head"><span>等级</span><span>条款</span><span>风险类型</span><span>法条依据</span><span>修改建议</span></div>
        ${rows}
      </div>
      <p class="panel-foot-note">点击任意一行展开原文依据与法条要点。</p>`;

    $$('[data-risk-row]', panel).forEach((row) =>
      row.addEventListener('click', (ev) => {
        const jump = ev.target.closest ? ev.target.closest('[data-jump-clause]') : null;
        if (jump) {
          ev.stopPropagation();
          jumpToClause(Number(jump.getAttribute('data-jump-clause')));
          return;
        }
        const detail = $('.rt-detail[data-detail="' + row.getAttribute('data-risk-row') + '"]');
        if (detail) detail.classList.toggle('is-open');
      })
    );

    $$('[data-copy]', panel).forEach((btn) =>
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await navigator.clipboard.writeText(btn.getAttribute('data-copy') || '');
          toast('法条已复制到剪贴板', 'ok');
        } catch (err) {
          toast('浏览器拒绝了剪贴板访问，请手动选中复制', 'warn');
        }
      })
    );
  }

  /** 从风险表 / 建议卡跳回条款列表并定位到具体条款 */
  function jumpToClause(index) {
    activateTab('clauses');
    const node = $('.clause-item[data-clause-index="' + index + '"]');
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('is-open');
    node.classList.add('is-flash');
    setTimeout(() => node.classList.remove('is-flash'), 1800);
  }

  /* --------------------------- 8.3 修改建议 ------------------------------ */

  function renderSuggestions(task) {
    const panel = $('.tab-panel[data-panel="suggestions"]');
    if (!panel) return;
    const risks = (task.risks || []).slice().sort((a, b) => {
      const weight = { high: 3, mid: 2, low: 1 };
      return (weight[b.level] || 0) - (weight[a.level] || 0);
    });

    if (!risks.length) {
      panel.innerHTML = emptyBlock('#i-edit', '暂无需要修改的条款', '本次审查未命中风险特征，可保留原文并定期复核。', '');
      return;
    }

    panel.innerHTML = `
      <div class="sug-list">
        ${risks
          .map(
            (r) => `
          <article class="sug-card">
            <header class="sug-head">
              <span class="level-pill is-${esc(r.level)}">${esc(LEVEL_LABEL[r.level] || '—')}</span>
              <span class="sug-title">${esc(r.clauseRawNo)} · ${esc(r.name)}</span>
            </header>
            <div class="sug-row"><span class="sug-tag before">原文</span><p>${esc(r.evidence || '（该条款命中规则特征，请人工复核原文）')}</p></div>
            <div class="sug-row"><span class="sug-tag after">建议</span><p>${esc(r.suggestion)}</p></div>
            <div class="law-block">
              <div class="law-head">
                <span class="law-name">${esc((r.basis && r.basis.law) || '—')}${esc((r.basis && r.basis.article) || '')}</span>
                <span class="law-badge ${r.basis && r.basis.official ? 'is-official' : 'is-digest'}">${
              r.basis && r.basis.official ? '法条原文' : '要点摘录'
            }</span>
              </div>
              ${lawBody(r.basis)}
              ${lawRefsBlock(r)}
            </div>
            <div class="sug-foot">
              <button class="btn btn-ghost btn-sm" type="button" data-jump-clause="${esc(
                String(r.clauseIndex)
              )}">
                <svg class="icon icon-sm"><use href="#i-search" /></svg>定位条款
              </button>
              <button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(r.suggestion)}">
                <svg class="icon icon-sm"><use href="#i-copy" /></svg>复制建议
              </button>
              ${askBtn('data-ask-risk', r.id)}
            </div>
          </article>`
          )
          .join('')}
      </div>`;

    $$('[data-copy]', panel).forEach((btn) =>
      btn.addEventListener('click', async () => {
        const text = btn.getAttribute('data-copy');
        try {
          await navigator.clipboard.writeText(text);
          toast('建议已复制到剪贴板', 'ok');
        } catch (err) {
          toast('浏览器拒绝了剪贴板访问，请手动选中复制', 'warn');
        }
      })
    );

    $$('[data-jump-clause]', panel).forEach((btn) =>
      btn.addEventListener('click', () => jumpToClause(Number(btn.getAttribute('data-jump-clause'))))
    );
  }

  /* --------------------------- 8.4 报告预览 ------------------------------ */

  /** 报告附录：去重后的法条原文 */
  function lawAppendix(risks) {
    const seen = new Map();
    risks.forEach((r) => {
      const basis = r.basis || {};
      if (!basis.text) return;
      const key = (basis.law || '') + (basis.article || '');
      if (!seen.has(key)) {
        seen.set(key, {
          label: key,
          text: basis.text,
          parts: (basis.parts || []).length > 1 ? basis.parts : null,
          official: !!basis.official,
        });
      }
      seen.get(key).n += 1;
    });
    if (!seen.size) return '<p class="rs-conclusion">本次审查引用的法条未收录原文，详见各条「要点摘录」。</p>';
    return [...seen.values()]
      .map((item) => {
        const body = item.parts
          ? item.parts
              .map(
                (part) =>
                  `<p class="rs-law-text"><span class="law-part-no">${esc(part.artLabel)}</span>${esc(
                    clip(part.text, 220)
                  )}</p>`
              )
              .join('')
          : `<p class="rs-law-text">${esc(clip(item.text, 220))}</p>`;
        return `<div class="rs-law-item">
          <p class="rs-law-name">${esc(item.label)}<span class="rs-law-tag">${item.official ? '原文' : '要点'}</span></p>
          ${body}
        </div>`;
      })
      .join('');
  }

  function renderReport(task) {
    const panel = $('.tab-panel[data-panel="report"]');
    if (!panel) return;
    const summary = task.summary || {};
    const risks = (task.risks || []).slice().sort((a, b) => {
      const weight = { high: 3, mid: 2, low: 1 };
      return (weight[b.level] || 0) - (weight[a.level] || 0);
    });
    const generatedAt = (task.report && task.report.generatedAt) || task.updatedAt || Date.now();

    const riskRows = risks
      .slice(0, 12)
      .map(
        (r) => `<tr>
          <td>${esc(LEVEL_SHORT[r.level] || '—')}</td>
          <td>${esc(r.clauseRawNo)}</td>
          <td>${esc(r.type)}</td>
          <td>${esc(((r.basis && r.basis.law) || '') + ((r.basis && r.basis.article) || ''))}</td>
        </tr>`
      )
      .join('');

    const sugBlocks = risks
      .slice(0, 5)
      .map(
        (r) => `<div class="rs-sug"><b>${esc(r.clauseRawNo)} · ${esc(r.name)}</b><br />建议：${esc(r.suggestion)}</div>`
      )
      .join('');

    panel.innerHTML = `
      <div class="report-wrap">
        <div class="report-sheet">
          <div class="rs-head">
            <span class="rs-logo"><svg class="icon"><use href="#i-shield" /></svg></span>
            <div class="rs-title-box">
              <p class="rs-title">协议合规审查报告</p>
              <p class="rs-sub">COMPLIANCE REVIEW REPORT · AI GENERATED</p>
            </div>
            <span class="pill pill-brand">已生成</span>
          </div>

          <div class="rs-meta">
            <div><span>协议类型</span><strong>${esc(docTypeText(task))}</strong></div>
            <div><span>审查尺度</span><strong>${esc(SCALE_LABEL[task.scale] || '—')}</strong></div>
            <div><span>生成时间</span><strong>${esc(dateText(generatedAt))}</strong></div>
          </div>

          <div class="rs-block">
            <p class="rs-h">一、审查结论</p>
            <p class="rs-conclusion">${esc(task.conclusion || '—')}</p>
          </div>

          <div class="rs-block">
            <p class="rs-h">二、风险清单（${risks.length} 处 · 高风险 ${summary.high || 0}）</p>
            ${
              risks.length
                ? `<table class="rs-risk-table">
                    <thead><tr><th style="width:46px">等级</th><th style="width:64px">条款</th><th style="width:76px">类型</th><th>依据</th></tr></thead>
                    <tbody>${riskRows}</tbody>
                  </table>
                  ${risks.length > 12 ? `<p class="rs-sug" style="margin-top:6px">其余 ${risks.length - 12} 处风险请在「风险汇总表」查看或导出完整报告。</p>` : ''}`
                : '<p class="rs-conclusion">未发现明显风险条款。</p>'
            }
          </div>

          <div class="rs-block">
            <p class="rs-h">三、修改建议与法条依据</p>
            <div class="rs-sug-list">${sugBlocks || '<p class="rs-conclusion">无需修改。</p>'}</div>
          </div>

          <div class="rs-block">
            <p class="rs-h">四、法条原文附录</p>
            ${lawAppendix(risks)}
          </div>

          <span class="rs-watermark">AI 生成</span>
        </div>

        <aside class="report-side">
          <p class="side-title">导出</p>
          <button class="btn btn-ghost btn-sm btn-block" type="button" data-export="docx">
            <svg class="icon icon-sm"><use href="#i-download" /></svg>导出 Word 报告
          </button>
          <button class="btn btn-ghost btn-sm btn-block" type="button" data-export="pdf">
            <svg class="icon icon-sm"><use href="#i-download" /></svg>导出 PDF 报告
          </button>
          <button class="btn btn-ghost btn-sm btn-block" type="button" data-export="json">
            <svg class="icon icon-sm"><use href="#i-download" /></svg>导出 JSON 数据
          </button>
          <p class="side-note">导出后可在「报告管理」中重新下载或删除。</p>
        </aside>
      </div>`;
  }

  /* --------------------------- 8.5 图表（Chart.js） ---------------------- */

  function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (value || '').trim() || fallback;
  }

  function chartPalette() {
    return {
      text: cssVar('--muted', '#6b7280'),
      muted: cssVar('--muted-2', '#9ca3af'),
      grid: cssVar('--border', 'rgba(0,0,0,.08)'),
      surface: cssVar('--surface', '#fff'),
      high: cssVar('--danger', '#e5484d'),
      mid: cssVar('--warn', '#d98324'),
      low: cssVar('--ok', '#12915d'),
      safe: cssVar('--muted-2', '#9ca3af'),
      brand: cssVar('--brand', '#3457f5')
    };
  }

  function destroyChart(key) {
    if (state.charts[key]) {
      state.charts[key].destroy();
      delete state.charts[key];
    }
  }

  function baseOptions(palette) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 420 },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(15,23,42,.92)', padding: 8, cornerRadius: 6 } },
      scales: {
        x: { grid: { display: false }, ticks: { color: palette.muted, font: { size: 10 } }, border: { display: false } },
        y: {
          beginAtZero: true,
          grid: { color: palette.grid, drawTicks: false },
          ticks: { color: palette.muted, font: { size: 10 }, precision: 0 },
          border: { display: false }
        }
      }
    };
  }

  function renderCharts(task) {
    if (!window.Chart || !task) return;
    const panel = $('.tab-panel[data-panel="charts"]');
    if (!panel || !panel.classList.contains('is-active')) return; // 隐藏时不绘制
    const summary = task.summary || {};
    const palette = chartPalette();
    const level = { high: summary.high || 0, mid: summary.mid || 0, low: summary.low || 0, safe: summary.compliantClauses || 0 };

    /* 1) 风险等级分布 */
    const canvasLevel = el('chartRiskLevel');
    if (canvasLevel) {
      destroyChart('level');
      canvasLevel.parentElement.classList.add('is-drawn');
      state.charts.level = new Chart(canvasLevel, {
        type: 'doughnut',
        data: {
          labels: ['高风险', '中风险', '低风险', '合规条款'],
          datasets: [
            {
              data: [level.high, level.mid, level.low, level.safe],
              backgroundColor: [palette.high, palette.mid, palette.low, palette.safe],
              borderWidth: 2,
              borderColor: palette.surface,
              hoverOffset: 6
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '62%',
          plugins: {
            legend: { position: 'right', labels: { color: palette.text, boxWidth: 10, boxHeight: 10, font: { size: 10.5 }, padding: 8 } },
            tooltip: { backgroundColor: 'rgba(15,23,42,.92)', padding: 8, cornerRadius: 6 }
          }
        }
      });
    }

    /* 2) 风险类型 TOP 5 */
    const byType = (summary.byType || []).slice(0, 5);
    const canvasType = el('chartRiskType');
    if (canvasType) {
      destroyChart('type');
      canvasType.parentElement.classList.add('is-drawn');
      const options = baseOptions(palette);
      options.indexAxis = 'y';
      options.scales = {
        x: { beginAtZero: true, grid: { color: palette.grid, drawTicks: false }, ticks: { color: palette.muted, font: { size: 10 }, precision: 0 }, border: { display: false } },
        y: { grid: { display: false }, ticks: { color: palette.text, font: { size: 10.5 } }, border: { display: false } }
      };
      state.charts.type = new Chart(canvasType, {
        type: 'bar',
        data: {
          labels: byType.map((item) => item.name),
          datasets: [{ data: byType.map((item) => item.count), backgroundColor: palette.brand, borderRadius: 5, barThickness: 12 }]
        },
        options
      });
    }

    /* 3) 条款风险热力（按条款加权） */
    const heat = summary.heat || [];
    const canvasHeat = el('chartRiskHeat');
    if (canvasHeat) {
      destroyChart('heat');
      canvasHeat.parentElement.classList.add('is-drawn');
      const colorOf = { high: palette.high, mid: palette.mid, low: palette.low, safe: palette.safe };
      const options = baseOptions(palette);
      options.scales.x = {
        grid: { display: false },
        ticks: { color: palette.muted, font: { size: 9.5 }, maxRotation: 0, autoSkip: true },
        border: { display: false }
      };
      options.plugins.tooltip = {
        backgroundColor: 'rgba(15,23,42,.92)',
        padding: 8,
        cornerRadius: 6,
        callbacks: {
          title: (items) => (heat[items[0].dataIndex] ? heat[items[0].dataIndex].rawNo : ''),
          label: (item) => '风险权重 ' + item.raw + '（' + LEVEL_LABEL[(heat[item.dataIndex] || {}).level] + '）'
        }
      };
      state.charts.heat = new Chart(canvasHeat, {
        type: 'bar',
        data: {
          labels: heat.map((item) => item.no),
          datasets: [
            {
              data: heat.map((item) => item.weight),
              backgroundColor: heat.map((item) => colorOf[item.level] || palette.safe),
              borderRadius: 4
            }
          ]
        },
        options
      });
    }

    /* 4) 条款类型构成 */
    const byClauseType = (summary.byClauseType || []).slice(0, 8);
    const canvasClause = el('chartClauseType');
    if (canvasClause) {
      destroyChart('clause');
      canvasClause.parentElement.classList.add('is-drawn');
      const options = baseOptions(palette);
      options.indexAxis = 'y';
      const typeColors = [palette.brand];
      options.scales = {
        x: {
          beginAtZero: true,
          grid: { color: palette.grid, drawTicks: false },
          ticks: { color: palette.muted, font: { size: 10 }, precision: 0 },
          border: { display: false }
        },
        y: {
          grid: { display: false },
          ticks: { color: palette.text, font: { size: 10.5 }, autoSkip: false },
          border: { display: false }
        }
      };
      state.charts.clause = new Chart(canvasClause, {
        type: 'bar',
        data: {
          labels: byClauseType.map((item) => item.name),
          datasets: [
            {
              data: byClauseType.map((item) => item.count),
              backgroundColor: byClauseType.map((item, index) => typeColors[index % typeColors.length]),
              borderRadius: 4,
              barThickness: 11
            }
          ]
        },
        options
      });
    }

    const note = $('.panel-foot-note', panel);
    if (note) {
      note.innerHTML = `数据来源：本次审查 <code>risks[]</code> 与 <code>summary</code> · 条款 ${summary.clauseCount || 0} 条 · 风险 ${
        summary.riskCount || 0
      } 处 · 图表随主题自动切换配色。`;
    }
  }

  /* --------------------------- 8.6 导出 ---------------------------------- */

  function enableExports(task) {
    $$('[data-export]').forEach((btn) => {
      btn.disabled = !(task && task.status === 'done');
      btn.removeAttribute('title');
    });
  }

  function initExports() {
    document.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-export]');
      if (!btn || btn.disabled) return;
      ev.preventDefault();
      await exportTask(btn.getAttribute('data-export'));
    });
  }

  async function exportTask(format) {
    const task = state.task;
    if (!task || task.status !== 'done') {
      toast('请先完成一次审查', 'warn');
      return;
    }
    if (format === 'pdf') {
      window.open(`/api/tasks/${encodeURIComponent(task.id)}/print`, '_blank', 'noopener');
      pushLog('info', 'export', '已打开打印视图，可在浏览器中选择「另存为 PDF」');
      toast('已打开打印视图，选择「另存为 PDF」即可', 'info');
      return;
    }
    try {
      const data = await api(`/api/tasks/${encodeURIComponent(task.id)}/export`, {
        method: 'POST',
        body: JSON.stringify({ format })
      });
      const file = data.file || {};
      await downloadFile(file.url, file.name);
      pushLog('ok', 'export', `${String(format).toUpperCase()} 报告已生成 · ${file.name} · ${fmtBytes(file.size)}`);
      loadReports({ silent: true });
    } catch (err) {
      pushLog('err', 'export', err.message);
      toast(err.message, 'error');
    }
  }

  /* --------------------------- 8.7 空状态 -------------------------------- */

  function emptyBlock(icon, title, text, note) {
    return `
      <div class="empty">
        <div class="empty-ico"><svg class="icon icon-xl"><use href="${icon}" /></svg></div>
        <p class="empty-title">${esc(title)}</p>
        <p class="empty-text">${esc(text)}</p>
        ${note ? `<p class="empty-note">${esc(note)}</p>` : ''}
      </div>`;
  }

  /* ===========================================================================
   * 9. 历史任务
   * ======================================================================== */

  async function loadTasks(options) {
    const opts = options || {};
    try {
      const data = await api('/api/tasks');
      state.tasks = data.tasks || [];
      renderTasks();
      const exportBtn = el('historyExport');
      if (exportBtn) exportBtn.disabled = state.tasks.length === 0;
    } catch (err) {
      if (!opts.silent) toast('历史任务加载失败：' + err.message, 'error');
    }
  }

  function renderTasks() {
    const host = $('#view-history .card-body');
    if (!host) return;

    const query = state.historyQuery.trim().toLowerCase();
    const filter = state.historyFilter;
    const list = state.tasks.filter((task) => {
      if (filter === 'done' && task.status !== 'done') return false;
      if (filter === 'running' && task.status !== 'running' && task.status !== 'queued') return false;
      if (filter === 'failed' && task.status !== 'failed') return false;
      if (query && (task.filename || '').toLowerCase().indexOf(query) < 0 && (task.id || '').indexOf(query) < 0) return false;
      return true;
    });

    if (!list.length) {
      host.innerHTML = emptyBlock(
        '#i-history',
        state.tasks.length ? '没有匹配的任务' : '暂无历史任务',
        state.tasks.length ? '试试切换筛选条件或清空搜索关键词。' : '完成第一次审查后，任务会自动记录在此，包含文件名、提交时间、风险数量与报告状态。',
        '任务记录仅在本次运行期间保留'
      );
      return;
    }

    host.innerHTML = `<div class="task-list">${list
      .map((task) => {
        const statusKind = task.status === 'done' ? 'done' : task.status === 'failed' ? 'fail' : 'run';
        const statusText = task.status === 'done' ? '已完成' : task.status === 'failed' ? '失败' : '审查中';
        const risk = task.summary ? task.summary.riskCount : '—';
        const score = task.summary ? task.summary.score : '—';
        return `
        <div class="task-row" data-task-id="${esc(task.id)}">
          <span class="pill pill-${statusKind}"><span class="dot"></span>${statusText}</span>
          <span class="task-name" title="${esc(task.filename)}">${esc(task.filename)}</span>
          <span class="task-meta">${esc(docTypeText(task))}</span>
          <span class="task-meta">风险 ${risk} · ${score} 分</span>
          <span class="task-meta">${esc(dateText(task.createdAt))}</span>
          <span class="task-actions">
            <button class="link-btn" type="button" data-task-open="${esc(task.id)}">查看</button>
            <button class="link-btn" type="button" data-task-del="${esc(task.id)}">删除</button>
          </span>
        </div>`;
      })
      .join('')}</div>`;

    $$('[data-task-open]', host).forEach((btn) =>
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openTask(btn.getAttribute('data-task-open'));
      })
    );
    $$('[data-task-del]', host).forEach((btn) =>
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await api('/api/tasks/' + encodeURIComponent(btn.getAttribute('data-task-del')), { method: 'DELETE' });
          toast('任务已删除', 'ok');
          loadTasks({ silent: true });
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );
    $$('.task-row', host).forEach((row) =>
      row.addEventListener('click', () => openTask(row.getAttribute('data-task-id')))
    );
  }

  async function openTask(taskId) {
    try {
      const data = await api('/api/tasks/' + encodeURIComponent(taskId));
      const task = data.task;
      state.task = task;
      state.taskId = task.id;
      go('home');
      if (task.status === 'done') {
        renderTask(task);
        activateTab('clauses');
        setTaskState('done', `已载入 · ${task.summary ? task.summary.score : '—'} 分`);
        toast('已载入历史任务：' + task.filename, 'ok');
      } else {
        toast('该任务尚未完成，状态：' + task.status, 'warn');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function initHistoryFilters() {
    const view = el('view-history');
    if (!view) return;
    $$('.seg-item', view).forEach((btn) =>
      btn.addEventListener('click', () => {
        $$('.seg-item', view).forEach((item) => item.classList.toggle('is-active', item === btn));
        const text = btn.textContent.trim();
        state.historyFilter = text === '已完成' ? 'done' : text === '审查中' ? 'running' : text === '失败' ? 'failed' : 'all';
        renderTasks();
      })
    );
    const input = $('.search-box input', view);
    if (input) {
      input.disabled = false;
      input.placeholder = '按文件名 / 任务编号搜索';
      input.addEventListener('input', throttle(() => {
        state.historyQuery = input.value;
        renderTasks();
      }, 140));
    }

    // 导出历史列表为 CSV（纯前端生成，不经过后端）
    const exportBtn = el('historyExport');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        if (!state.tasks.length) {
          toast('暂无可导出的任务', 'warn');
          return;
        }
        const head = ['任务编号', '文件名', '协议类型', '状态', '风险数', '风险分', '提交时间'];
        const rows = state.tasks.map((task) => [
          task.id,
          task.filename,
          docTypeText(task),
          task.status === 'done' ? '已完成' : task.status === 'failed' ? '失败' : '审查中',
          task.summary ? task.summary.riskCount : '',
          task.summary ? task.summary.score : '',
          dateText(task.createdAt)
        ]);
        const csv = [head]
          .concat(rows)
          .map((row) => row.map((cell) => '"' + String(cell === undefined || cell === null ? '' : cell).replace(/"/g, '""') + '"').join(','))
          .join('\r\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        download(URL.createObjectURL(blob), '审查任务列表-' + dateText(Date.now()).replace(/[^\d]/g, '') + '.csv');
        toast('任务列表已导出为 CSV', 'ok');
      });
    }
  }

  /* ===========================================================================
   * 10. 报告管理
   * ======================================================================== */

  async function loadReports(options) {
    const opts = options || {};
    try {
      const data = await api('/api/reports');
      state.reports = data.files || [];
      renderReports();
    } catch (err) {
      if (!opts.silent) toast('报告列表加载失败：' + err.message, 'error');
    }
  }

  function renderReports() {
    const host = $('#view-reports .grid');
    if (!host) return;

    if (!state.reports.length) {
      host.innerHTML = `
        <article class="card report-card" style="grid-column:1/-1">
          <div class="report-thumb">
            <svg class="icon icon-xl"><use href="#i-folder" /></svg>
            <span class="report-format">EMPTY</span>
          </div>
          <div class="report-card-head">
            <p class="report-card-title">暂无报告</p>
            <span class="report-card-tag">EMPTY</span>
          </div>
          <p class="report-card-note">完成一次审查后，点击结果区右上角的 Word / PDF / JSON 即可生成报告并归档到此处。</p>
        </article>`;
      return;
    }

    host.innerHTML = state.reports
      .map((file) => {
        const ext = (file.ext || '').toUpperCase();
        const icon = ext === 'JSON' ? '#i-file' : ext === 'MD' ? '#i-edit' : '#i-report';
        const url = `/api/reports/${encodeURIComponent(file.name)}/download`;
        return `
        <article class="card report-card">
          <div class="report-thumb">
            <svg class="icon icon-xl"><use href="${icon}" /></svg>
            <span class="report-format">${esc(ext || 'FILE')}</span>
          </div>
          <div class="report-card-head">
            <p class="report-card-title" title="${esc(file.name)}">${esc(file.name)}</p>
            <span class="report-card-tag">${fmtBytes(file.size)}</span>
          </div>
          <p class="report-card-note">生成时间：${esc(dateText(file.mtime))}</p>
          <div class="report-card-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-report-download="${esc(file.name)}">
              <svg class="icon icon-sm"><use href="#i-download" /></svg>下载
            </button>
            <button class="btn btn-ghost btn-sm" type="button" data-report-del="${esc(file.name)}">
              <svg class="icon icon-sm"><use href="#i-trash" /></svg>删除
            </button>
          </div>
        </article>`;
      })
      .join('');

    $$('[data-report-download]', host).forEach((btn) =>
      btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-report-download');
        btn.disabled = true;
        await downloadFile(`/api/reports/${encodeURIComponent(name)}/download`, name);
        btn.disabled = false;
      })
    );
    $$('[data-report-del]', host).forEach((btn) =>
      btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-report-del');
        try {
          await api('/api/reports/' + encodeURIComponent(name), { method: 'DELETE' });
          toast('已删除 ' + name, 'ok');
          loadReports({ silent: true });
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );
  }

  /* ===========================================================================
   * 11. 设置
   * ======================================================================== */

  async function loadConfig() {
    try {
      const data = await api('/api/config');
      const model = data.model || {};
      const readonly = !!data.readonly;
      const chatInfo = data.chat || {};
      const fields = [
        ['setBase', model.baseUrl || ''],
        ['setKey', ''],
        ['setTemp', model.temperature !== undefined ? model.temperature : '']
      ];
      fields.forEach(([id, value]) => {
        const node = el(id);
        if (node) {
          node.disabled = readonly;
          if (value !== '') node.value = value;
        }
      });
      const key = el('setKey');
      if (key) {
        key.disabled = readonly;
        key.value = '';
        key.placeholder = readonly
          ? model.apiKeySet
            ? '已配置'
            : '未配置'
          : model.apiKeySet
            ? '已保存，留空则不修改'
            : 'sk-...';
      }
      const modelSelect = el('setModel');
      if (modelSelect && model.model) {
        modelSelect.disabled = readonly;
        const exists = $$('option', modelSelect).some((opt) => opt.value === model.model);
        if (!exists) {
          const opt = document.createElement('option');
          opt.value = model.model;
          opt.textContent = model.model;
          modelSelect.appendChild(opt);
        }
        modelSelect.value = model.model;
      }
      const saveBtn = el('saveConfigBtn');
      if (saveBtn) {
        saveBtn.disabled = readonly;
        saveBtn.title = readonly ? '当前账号无修改权限' : '';
        if (!readonly && !saveBtn.dataset.bound) {
          saveBtn.dataset.bound = '1';
          saveBtn.addEventListener('click', saveConfig);
        }
      }
      const testBtn = el('testModel');
      const testHint = el('testModelHint');
      if (testBtn) {
        testBtn.hidden = readonly;
        testBtn.disabled = readonly;
        if (!readonly && !testBtn.dataset.bound) {
          testBtn.dataset.bound = '1';
          testBtn.addEventListener('click', testModelConnection);
        }
      }
      if (testHint) testHint.hidden = readonly;
      const chatBox = el('chatEnabled');
      if (chatBox) {
        // 用 active（实际生效值）而不是 enabled（配置值）：CHAT_ENABLED 环境变量说了算时以实际为准
        chatBox.checked = chatInfo.active !== undefined ? !!chatInfo.active : !!chatInfo.enabled;
        chatBox.disabled = readonly;
        chatBox.title = readonly ? '当前账号无修改权限' : '';
      }
      const analyzeBox = el('modelAnalyze');
      if (analyzeBox) {
        analyzeBox.checked = !!(model && model.analyze);
        analyzeBox.disabled = readonly;
        analyzeBox.title = readonly ? '当前账号无修改权限' : '';
      }
    } catch (err) {
      toast('配置读取失败：' + err.message, 'error');
    }
  }

  async function saveConfig() {
    const btn = el('saveConfigBtn');
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;
    try {
      const body = {
        model: {
          baseUrl: (el('setBase') || {}).value || '',
          model: (el('setModel') || {}).value || 'deepseek-chat',
          temperature: Number((el('setTemp') || {}).value || 0.2)
        }
      };
      const key = (el('setKey') || {}).value || '';
      if (key.trim()) body.model.apiKey = key.trim();
      const chatBox = el('chatEnabled');
      if (chatBox && !chatBox.disabled) body.chat = { enabled: !!chatBox.checked };
      const analyzeBox = el('modelAnalyze');
      if (analyzeBox && !analyzeBox.disabled) body.model.analyze = !!analyzeBox.checked;
      await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
      toast('配置已保存', 'ok');
      pushLog('ok', 'config', '模型配置已更新');
      loadConfig();
      loadChatStatus();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function testModelConnection() {
    const btn = el('testModel');
    const payload = {
      model: {
        baseUrl: (el('setBase') || {}).value || '',
        model: (el('setModel') || {}).value || 'deepseek-chat',
        apiKey: ((el('setKey') || {}).value || '').trim()
      }
    };
    if (btn) btn.disabled = true;
    toast('正在连接模型…', 'info');
    try {
      const data = await api('/api/model/test', { method: 'POST', body: JSON.stringify(payload) });
      toast(`连接成功 · ${data.model} · ${data.latencyMs}ms`, 'ok');
      pushLog('ok', 'model', `模型连通性正常 · ${data.model} · ${data.latencyMs}ms · 返回「${data.sample}」`);
    } catch (err) {
      toast('连接失败：' + err.message, 'error');
      pushLog('err', 'model', '模型连通性测试失败：' + err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function initSettingsActions() {
    const view = el('view-settings');
    if (!view) return;

    const clearBtn = $$('button', view).find((btn) => btn.textContent.indexOf('清空任务记录') >= 0);
    if (clearBtn) {
      clearBtn.disabled = false;
      clearBtn.addEventListener('click', async () => {
        try {
          const data = await api('/api/tasks');
          await Promise.all((data.tasks || []).map((task) => api('/api/tasks/' + encodeURIComponent(task.id), { method: 'DELETE' })));
          toast('任务记录已清空', 'ok');
          loadTasks({ silent: true });
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    // 默认审查尺度：与首页输入区的选择联动，并记住到下次打开
    $$('[data-default-scale]', view).forEach((btn) =>
      btn.addEventListener('click', () => {
        state.scale = btn.getAttribute('data-default-scale');
        syncDefaultScale();
        toast('默认审查尺度已改为「' + (SCALE_LABEL[state.scale] || state.scale) + '」', 'ok');
      })
    );
    syncDefaultScale();
  }

  /* ===========================================================================
   * 12b. 追问助手（悬浮问答，默认关闭）
   *
   * - 开关来自后端 config.chat.enabled（评审实例默认关，防止链接被转发后刷 Key）。
   * - 焦点：risk / clause / summary，随「问这条」按钮切换，做成请求里的 focus。
   * - 多轮：前端保留最近几轮，后端按 chat.historyRounds 再裁一次。
   * - 无 Key 时后端回本地检索结果，前端只负责渲染，不区分模式。
   * ======================================================================== */

  const CHAT = {
    ready: false,
    enabled: false,
    mode: 'local',
    open: false,
    busy: false,
    focus: null,
    taskId: null,
    messages: []
  };

  const CHAT_WELCOME =
    '我可以解释报告里的每一条：为什么判成高风险、依据哪条法律、怎么改。没有报告时也可以问通用问题，比如自动续费要注意什么。';

  const CHAT_PRESETS = {
    risk: ['这条为什么算高风险？', '用大白话说，这条对我有什么影响？', '依据的是哪条法律？', '给我一版改写建议'],
    clause: ['这条有什么问题？', '这条对我有利还是不利？', '需要改吗？怎么改？'],
    summary: ['最该改的是哪几条？', '整体风险高在哪？', '如果只能改三处，改哪里？']
  };

  function chatEls() {
    return {
      fab: el('chatFab'),
      panel: el('chatPanel'),
      body: el('chatBody'),
      form: el('chatForm'),
      input: el('chatQuestion'),
      send: el('chatSend'),
      chips: el('chatChips'),
      focusBar: el('chatFocus'),
      focusText: el('chatFocusText'),
      sub: el('chatSub'),
      modeNote: el('chatModeNote')
    };
  }

  /** 「问这条」小按钮：追问未开启时不渲染，避免页面上出现点了没用的入口 */
  function askBtn(kind, value, label) {
    if (!CHAT.enabled) return '';
    return `<button class="ask-btn" type="button" ${kind}="${esc(String(value))}"><svg class="icon"><use href="#i-spark" /></svg>${esc(
      label || '问这条'
    )}</button>`;
  }

  async function loadChatStatus() {
    try {
      const data = await api('/api/chat/status');
      const wasEnabled = CHAT.enabled;
      CHAT.enabled = !!data.enabled;
      CHAT.mode = data.mode || 'local';
      CHAT.ready = true;
      const { fab } = chatEls();
      if (fab) fab.hidden = !CHAT.enabled;
      updateChatMode();
      // 开关状态变化后重绘结果区，让「问这条」按钮跟着出现 / 消失
      if (wasEnabled !== CHAT.enabled && state.task) {
        renderClauses(state.task);
        renderRisks(state.task);
        renderSuggestions(state.task);
      }
    } catch (err) {
      /* 后端还没起 / 旧版本后端：静默，不影响主流程 */
    }
  }

  function updateChatMode() {
    const { modeNote, sub } = chatEls();
    if (modeNote) {
      modeNote.textContent =
        CHAT.mode === 'model' ? '模型作答 · 请核对所引条文' : '依据本地条文与规则作答';
    }
    if (sub && !state.task) sub.textContent = '针对本次报告提问';
  }

  /** 极简 Markdown：段落 / 列表 / **加粗** / `代码`，先转义再套标签 */
  function mdLite(text) {
    const inline = (s) =>
      esc(s)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    return String(text || '')
      .split(/\n{2,}/)
      .map((block) => {
        const lines = block.split('\n').filter((line) => line.trim() !== '');
        if (!lines.length) return '';
        const isList = lines.every((line) => /^\s*([-*]|\d+\.)\s+/.test(line));
        if (isList) {
          return '<ul>' + lines.map((line) => '<li>' + inline(line.replace(/^\s*([-*]|\d+\.)\s+/, '')) + '</li>').join('') + '</ul>';
        }
        return '<p>' + lines.map(inline).join('<br>') + '</p>';
      })
      .join('');
  }

  function chatCiteList(citations) {
    const box = document.createElement('div');
    box.className = 'chat-cites';
    citations.slice(0, 4).forEach((c) => {
      const node = document.createElement('div');
      node.className = 'chat-cite';
      node.innerHTML =
        '<b>' + esc('《' + (c.lawShort || c.law || '') + '》' + (c.artLabel || '')) + '</b>' +
        '<p>' + esc(c.text || '') + '</p>';
      box.appendChild(node);
    });
    return box;
  }

  function chatAddMessage(msg) {
    const { body } = chatEls();
    if (!body) return null;
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg' + (msg.role === 'user' ? ' is-user' : '');
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.innerHTML = mdLite(msg.content || '');
    wrap.appendChild(bubble);
    body.appendChild(wrap);
    body.scrollTop = body.scrollHeight;
    return { wrap, bubble };
  }

  function renderChips(kind) {
    const { chips } = chatEls();
    if (!chips) return;
    const list = CHAT_PRESETS[kind] || CHAT_PRESETS.summary;
    chips.innerHTML = list
      .map((q) => `<button class="chat-chip" type="button" data-q="${esc(q)}">${esc(q)}</button>`)
      .join('');
  }

  function chatSetFocus(focus, label) {
    CHAT.focus = focus || null;
    const { focusBar, focusText } = chatEls();
    if (!focusBar) return;
    focusBar.hidden = !focus;
    if (focusText) focusText.textContent = label || '';
  }

  /** 打开面板；首次打开补一条欢迎语 + 与当前上下文对应的快捷问题 */
  function chatOpen() {
    const { panel, body } = chatEls();
    if (!panel) return;
    if (!CHAT.enabled) {
      toast('追问助手当前关闭，可在「设置」中开启', 'warn');
      return;
    }
    panel.hidden = false;
    CHAT.open = true;
    if (body && !body.children.length) {
      CHAT.messages = [];
      chatAddMessage({ role: 'assistant', content: CHAT_WELCOME });
      renderChips(state.task ? 'summary' : null);
    }
    const { input } = chatEls();
    if (input) setTimeout(() => input.focus({ preventScroll: true }), 60);
  }

  function chatClose() {
    const { panel } = chatEls();
    if (panel) panel.hidden = true;
    CHAT.open = false;
  }

  /** 「问这条」：打开面板 + 设置焦点 + 给对应的问题模板 */
  function askAbout(focus, label, kind) {
    if (!CHAT.enabled) {
      toast('追问助手当前关闭，可在「设置」中开启', 'warn');
      return;
    }
    chatOpen();
    chatSetFocus(focus, label);
    renderChips(kind || 'risk');
    const { input } = chatEls();
    if (input) setTimeout(() => input.focus({ preventScroll: true }), 80);
  }

  async function chatSend(forced) {
    const { input, send, chips } = chatEls();
    const question = String(forced || (input && input.value) || '').trim();
    if (!question || CHAT.busy) return;
    if (!CHAT.enabled) {
      toast('追问助手当前关闭，可在「设置」中开启', 'warn');
      return;
    }
    if (input) {
      input.value = '';
      input.style.height = '';
    }
    if (chips) chips.innerHTML = '';
    CHAT.busy = true;
    if (send) send.disabled = true;

    const history = CHAT.messages.slice(-8).map((m) => ({ role: m.role, content: m.content }));
    CHAT.messages.push({ role: 'user', content: question });
    chatAddMessage({ role: 'user', content: question });

    const holder = chatAddMessage({ role: 'assistant', content: '' });
    const bubble = holder && holder.bubble;
    if (bubble) bubble.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span>';

    let acc = '';
    let notice = '';
    let citations = [];
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: CHAT.taskId || (state.task && state.task.id) || null,
          focus: CHAT.focus,
          question,
          history
        })
      });
      if (!res.ok) {
        let detail = null;
        try {
          detail = await res.json();
        } catch (err) {
          detail = null;
        }
        throw new Error((detail && detail.error) || '请求失败（HTTP ' + res.status + '）');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const handleFrame = (raw) => {
        raw.split('\n').forEach((line) => {
          if (line.indexOf('data:') !== 0) return;
          let obj = null;
          try {
            obj = JSON.parse(line.slice(5).trim());
          } catch (err) {
            return;
          }
          if (obj.type === 'meta') {
            citations = obj.citations || [];
            if (obj.notice) {
              notice = obj.notice;
              // 报告已过期：清掉本地 taskId / 焦点，后续提问不再反复带一个失效的报告号
              if (/过期|已不在/.test(obj.notice)) {
                CHAT.taskId = null;
                chatSetFocus(null, '');
                const { sub } = chatEls();
                if (sub) sub.textContent = '未绑定报告 · 可问通用问题';
              }
            }
            if (obj.mode && obj.mode !== CHAT.mode) {
              CHAT.mode = obj.mode;
              updateChatMode();
            }
          } else if (obj.type === 'delta' && obj.text) {
            acc += obj.text;
            if (bubble) bubble.innerHTML = mdLite(acc);
            const { body } = chatEls();
            if (body) body.scrollTop = body.scrollHeight;
          }
        });
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let index;
        while ((index = buf.indexOf('\n\n')) >= 0) {
          handleFrame(buf.slice(0, index));
          buf = buf.slice(index + 2);
        }
      }
      if (buf.trim()) handleFrame(buf);

      if (!acc && bubble) bubble.innerHTML = mdLite('（没有收到内容，请重试）');
      if (notice && holder) {
        const node = document.createElement('div');
        node.className = 'chat-meta is-warn';
        node.textContent = notice;
        holder.wrap.appendChild(node);
      }
      if (citations.length && holder) holder.wrap.appendChild(chatCiteList(citations));
      CHAT.messages.push({ role: 'assistant', content: acc || '（无内容）' });
    } catch (err) {
      if (bubble) bubble.innerHTML = '<p>' + esc('出错了：' + err.message) + '</p>';
      if (/未开启/.test(err.message)) {
        CHAT.enabled = false;
        const { fab } = chatEls();
        if (fab) fab.hidden = true;
      }
      // 兼容旧版服务端：任务过期时清掉本地报告号，下一轮就不会再顶着失效 id 请求
      if (/过期/.test(err.message)) {
        CHAT.taskId = null;
        chatSetFocus(null, '');
      }
    } finally {
      CHAT.busy = false;
      if (send) send.disabled = false;
    }
  }

  /** 任务切换：清空上一份报告的对话，避免上下文串台 */
  function chatOnTask(task) {
    if (!CHAT.enabled) return;
    const id = task ? task.id : null;
    if (CHAT.taskId === id) return;
    CHAT.taskId = id;
    CHAT.messages = [];
    chatSetFocus(null, '');
    const { body, sub } = chatEls();
    if (body) body.innerHTML = '';
    if (CHAT.open) {
      chatAddMessage({ role: 'assistant', content: CHAT_WELCOME });
      renderChips('summary');
    }
    if (sub) sub.textContent = task ? '正在围绕：' + (task.filename || '本次协议') : '未绑定报告 · 可问通用问题';
  }

  function initChat() {
    const { fab, form, input, chips } = chatEls();
    if (!fab) return;

    fab.addEventListener('click', () => (CHAT.open ? chatClose() : chatOpen()));

    const closeBtn = el('chatClose');
    if (closeBtn) closeBtn.addEventListener('click', chatClose);

    const clearBtn = el('chatClear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        CHAT.messages = [];
        const { body } = chatEls();
        if (body) body.innerHTML = '';
        chatSetFocus(null, '');
        chatAddMessage({ role: 'assistant', content: CHAT_WELCOME });
        renderChips(state.task ? 'summary' : null);
      });
    }

    const focusClear = el('chatFocusClear');
    if (focusClear) focusClear.addEventListener('click', () => chatSetFocus(null, ''));

    if (form) {
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        chatSend();
      });
    }

    if (input) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          chatSend();
        }
      });
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(108, input.scrollHeight) + 'px';
      });
    }

    if (chips) {
      chips.addEventListener('click', (ev) => {
        const chip = ev.target.closest('.chat-chip');
        if (chip) chatSend(chip.getAttribute('data-q') || chip.textContent);
      });
    }

    // 「问这条」统一委托：风险行、条款行、建议卡共用一套
    document.addEventListener('click', (ev) => {
      const ask = ev.target.closest('[data-ask-risk], [data-ask-clause], [data-ask-summary]');
      if (!ask) return;
      ev.preventDefault();
      ev.stopPropagation();
      const task = state.task;
      if (ask.hasAttribute('data-ask-risk')) {
        const id = ask.getAttribute('data-ask-risk');
        const risk = ((task && task.risks) || []).find((r) => r.id === id);
        askAbout({ type: 'risk', id }, risk ? risk.clauseRawNo + ' · ' + risk.name : id, 'risk');
      } else if (ask.hasAttribute('data-ask-clause')) {
        const index = Number(ask.getAttribute('data-ask-clause'));
        const clause = ((task && task.clauses) || []).find((c) => c.index === index);
        askAbout({ type: 'clause', index }, clause ? clause.rawNo + ' ' + (clause.title || '') : '第 ' + index + ' 条', 'clause');
      } else {
        askAbout({ type: 'summary' }, '整份报告', 'summary');
      }
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && CHAT.open) chatClose();
    });

    loadChatStatus();
  }

  /* ===========================================================================
   * 12. 初始化
   * ======================================================================== */

  async function bootHealth() {
    try {
      const data = await api('/api/health');
      hideConnBanner();
      const model = data.model || {};
      pushLog('ready', 'system', `已就绪 · 规则库 ${data.rules} 条常见风险`);
      pushLog(
        model.configured ? 'ok' : 'warn',
        'model',
        model.configured
          ? `云端模型已接入（${model.model}）`
          : '未接入云端模型，使用本地合规规则检查'
      );
      const chip = $('.status-chip');
      if (chip) chip.innerHTML = '<span class="dot dot-live"></span>本地运行 · 规则库 ' + data.rules + ' 条';
      const modelState = el('modelState');
      if (modelState) {
        modelState.textContent = model.configured ? '已接入' : '本地模式';
        modelState.className = model.configured ? 'pill pill-ok' : 'pill pill-ghost';
      }
    } catch (err) {
      pushLog('err', 'system', '无法连接服务：' + err.message);
      showConnBanner();
      toast(err.message, 'error');
    }
  }

  /* ===========================================================================
   * 3b. 弹窗（项目特色说明）：在同一页面内展开，不跳转
   * ========================================================================= */

  function openModal(name) {
    const modal = el(name === 'features' ? 'featuresModal' : name);
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add('is-modal');
    const focusTarget = modal.querySelector('[data-start-review], [data-close-modal]');
    if (focusTarget) focusTarget.focus({ preventScroll: true });
  }

  function closeModal() {
    $$('.modal').forEach((modal) => {
      modal.hidden = true;
    });
    document.body.classList.remove('is-modal');
  }

  /** 「开始审查」：关闭弹窗 → 回到首页审查 → 定位到输入区并聚焦文本框 */
  function focusReviewInput() {
    closeModal();
    go('home');
    setTimeout(() => {
      const card = el('inputCard');
      const area = el('agreementText');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (area) setTimeout(() => area.focus({ preventScroll: true }), 320);
    }, 30);
  }

  function initModals() {
    document.addEventListener('click', (ev) => {
      const opener = ev.target.closest('[data-open-modal]');
      if (opener) {
        ev.preventDefault();
        openModal(opener.getAttribute('data-open-modal'));
        return;
      }

      if (ev.target.closest('[data-close-modal]') && !ev.target.closest('[data-start-review]')) {
        ev.preventDefault();
        closeModal();
        return;
      }

      if (ev.target.closest('[data-start-review]')) {
        ev.preventDefault();
        focusReviewInput();
      }
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeModal();
    });
  }

  function init() {
    initTheme();
    initRouter();
    initModals();
    initTabs();
    initInput();
    initExports();
    initHistoryFilters();
    initSettingsActions();
    initChat();

    // 「查看报告」：浏览器无法打开服务器上的文件夹，提示后跳转到报告管理
    document.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-open-output]');
      if (!btn) return;
      ev.preventDefault();
      toast('报告生成后可在「报告管理」中下载', 'info');
      go('reports');
    });

    // 首页右侧三个导出按钮初始禁用（渲染结果后启用）
    enableExports(null);

    // 清掉 HTML 里的静态占位日志，避免与运行日志重复（占位仅用于禁用 JS 时兜底）
    const logBody = el('logBody');
    if (logBody) {
      logBody.innerHTML = '';
      state.logCount = 0;
    }

    pushLog('info', 'pipeline', '流水线已就绪：解析 → 拆分 → 检索 → 打分 → 报告');

    // 控制台右上角的地址跟随实际访问地址（换端口 / 隧道时不会显示错的地址）
    const consoleHost = document.querySelector('.console-meta');
    if (consoleHost) consoleHost.textContent = location.host || SERVE_URL.replace('http://', '');

    // 直接双击 index.html 打开时，浏览器同源策略会拦掉所有接口请求，先提示正确的入口
    if (isFileProtocol()) {
      pushLog('warn', 'system', '当前页面未通过服务地址打开，接口不可用；请改用 ' + SERVE_URL);
      showConnBanner();
    }

    bootHealth();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
