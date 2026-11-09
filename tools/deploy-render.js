#!/usr/bin/env node
/**
 * 一键部署到 Render：本地仓库 → GitHub 私有仓库 → Render Docker 服务
 *
 * 为什么用脚本：这台机器上 PowerShell 的 Invoke-WebRequest 和 curl.exe 都连不上外网
 * （schannel 凭证错误），只有 node 的 fetch 能出网；git 也必须加 http.sslBackend=openssl。
 * 所以整个部署流程统一用 node 完成，可重复执行。
 *
 * 用法（PowerShell）：
 *   $env:GITHUB_TOKEN='ghp_xxx'          # 需要 repo + workflow 权限
 *   $env:RENDER_API_KEY='rnd_xxx'        # Render → Account Settings → API Keys
 *   node tools\deploy-render.js
 *
 * 可选环境变量：
 *   REPO_NAME      仓库名，默认 xieyi-tijian-guan
 *   SERVICE_NAME   Render 服务名，默认同仓库名
 *   BRANCH         分支，默认 main
 *   REGION         区域，默认 singapore
 *   PLAN           套餐，默认 free
 *   REPO_PRIVATE   默认 1（私有仓库，需要 Render 已连接 GitHub）；0 = 公开仓库
 *   ACCESS_USER / ACCESS_PASSWORD  默认 hfk / 000000
 *   MODEL_API_KEY  默认从本地 config.json 读取（不会打印、不会写进仓库）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GH = process.env.GITHUB_TOKEN;
const RK = process.env.RENDER_API_KEY;
const REPO_NAME = process.env.REPO_NAME || 'xieyi-tijian-guan';
const SERVICE_NAME = process.env.SERVICE_NAME || REPO_NAME;
const BRANCH = process.env.BRANCH || 'main';
const REGION = process.env.REGION || 'singapore';
const PLAN = process.env.PLAN || 'free';
const REPO_PRIVATE = (process.env.REPO_PRIVATE || '1') !== '0';
const ACCESS_USER = process.env.ACCESS_USER || 'hfk';
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '000000';
const MODEL_BASE_URL = process.env.MODEL_BASE_URL || 'https://api.deepseek.com/v1';
const MODEL_NAME = process.env.MODEL_NAME || 'deepseek-chat';

function die(msg) {
  console.error('\n✖ ' + msg + '\n');
  process.exit(1);
}

function readLocalKey() {
  if (process.env.MODEL_API_KEY) return process.env.MODEL_API_KEY.trim();
  const p = path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) return '';
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    return String((cfg.model && cfg.model.apiKey) || '').trim();
  } catch (e) {
    return '';
  }
}

async function ghJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + GH,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'xieyi-deploy',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}

async function renderJson(method, url, payload) {
  const res = await fetch('https://api.render.com/v1' + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + RK,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!GH) die('缺少 GITHUB_TOKEN。请在 GitHub → Settings → Developer settings → Personal access tokens 生成（勾选 repo 与 workflow）。');
  if (!RK) die('缺少 RENDER_API_KEY。请在 Render → Account Settings → API Keys 生成。');

  const apiKey = readLocalKey();
  if (!apiKey) die('没找到模型 Key：config.json 里 model.apiKey 为空，且未设置 MODEL_API_KEY。云端追问助手会没有 AI 能力。');

  /* ---------- 1. GitHub 用户与仓库 ---------- */
  console.log('① 校验 GitHub 令牌…');
  const me = await ghJson('https://api.github.com/user');
  if (!me.ok) die('GitHub 令牌无效（HTTP ' + me.status + '）：' + JSON.stringify(me.body).slice(0, 300));
  const login = me.body.login;
  console.log('   GitHub 账号：' + login);

  const scopes = me.headers;
  console.log('② 确保仓库 ' + login + '/' + REPO_NAME + ' 存在…');
  let repo = await ghJson('https://api.github.com/repos/' + login + '/' + REPO_NAME);
  if (repo.status === 404) {
    repo = await ghJson('https://api.github.com/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name: REPO_NAME,
        description: '协议体检官 · 合同/协议合规审查智能体（容器部署）',
        private: REPO_PRIVATE,
        has_issues: false,
        has_wiki: false,
        auto_init: false,
      }),
    });
    if (!repo.ok) die('创建仓库失败（HTTP ' + repo.status + '）：' + JSON.stringify(repo.body).slice(0, 400));
    console.log('   已创建' + (REPO_PRIVATE ? '私有' : '公开') + '仓库。');
  } else if (!repo.ok) {
    die('读取仓库失败（HTTP ' + repo.status + '）：' + JSON.stringify(repo.body).slice(0, 400));
  } else {
    console.log('   仓库已存在（' + repo.body.full_name + '）。');
  }

  /* ---------- 2. 推送代码 ---------- */
  console.log('③ 推送本地代码到 GitHub…');
  const remote = 'https://x-access-token:' + GH + '@github.com/' + login + '/' + REPO_NAME + '.git';
  try {
    const out = execFileSync(
      'git',
      [
        '-c', 'http.sslBackend=openssl',
        '-c', 'credential.helper=',
        'push', '--quiet', remote, 'HEAD:refs/heads/' + BRANCH, '--force',
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (out && out.trim()) console.log('   ' + out.trim());
  } catch (e) {
    const msg = String((e.stderr || '') + (e.stdout || '') || e.message);
    if (/workflow/i.test(msg)) {
      die('推送被拒：令牌缺少 workflow 权限。请重新生成令牌时勾选 workflow，或把 .github 目录去掉后重试。\n' + msg);
    }
    die('推送失败：\n' + msg.split('\n').slice(0, 8).join('\n'));
  }
  console.log('   已推送分支 ' + BRANCH + '。');

  /* ---------- 3. Render 账号 ---------- */
  console.log('④ 读取 Render 账号…');
  const owners = await renderJson('GET', '/owners?limit=20');
  if (!owners.ok) {
    const hint = /401|403/.test(String(owners.status))
      ? '（API Key 无效或已删除）'
      : '';
    die('读取 Render 账号失败（HTTP ' + owners.status + '）' + hint + '：' + JSON.stringify(owners.body).slice(0, 300));
  }
  const owner = (owners.body || [])[0] && (owners.body[0].owner || owners.body[0]);
  if (!owner || !owner.id) die('Render 账号里没有可用的 workspace：' + JSON.stringify(owners.body).slice(0, 300));
  console.log('   workspace：' + (owner.name || owner.email || owner.id));

  /* ---------- 4. 创建 / 复用服务 ---------- */
  const envVars = [
    { key: 'ACCESS_USER', value: ACCESS_USER },
    { key: 'ACCESS_PASSWORD', value: ACCESS_PASSWORD },
    { key: 'MODEL_BASE_URL', value: MODEL_BASE_URL },
    { key: 'MODEL_NAME', value: MODEL_NAME },
    { key: 'MODEL_API_KEY', value: apiKey },
    { key: 'CHAT_ENABLED', value: '1' },
    { key: 'NODE_ENV', value: 'production' },
  ];

  console.log('⑤ 查找已有服务 ' + SERVICE_NAME + ' …');
  const list = await renderJson('GET', '/services?limit=50&name=' + encodeURIComponent(SERVICE_NAME));
  const existing = (list.body || [])
    .map((it) => it.service || it)
    .find((s) => s && s.name === SERVICE_NAME);

  let service = existing;
  if (existing) {
    console.log('   复用服务 ' + existing.id + '，更新环境变量后重新部署。');
    const upd = await renderJson('PUT', '/services/' + existing.id, { serviceDetails: { envVars } });
    if (!upd.ok) console.warn('   环境变量更新失败（HTTP ' + upd.status + '）：' + JSON.stringify(upd.body).slice(0, 300));
    const dep = await renderJson('POST', '/services/' + existing.id + '/deploys', { clearCache: 'do_not_clear' });
    if (!dep.ok) die('触发部署失败（HTTP ' + dep.status + '）：' + JSON.stringify(dep.body).slice(0, 400));
    console.log('   已触发新部署 ' + (dep.body && dep.body.id));
  } else {
    console.log('   创建 Docker 服务…');
    const created = await renderJson('POST', '/services', {
      type: 'web_service',
      name: SERVICE_NAME,
      ownerId: owner.id,
      repo: 'https://github.com/' + login + '/' + REPO_NAME,
      branch: BRANCH,
      autoDeploy: 'yes',
      serviceDetails: {
        env: 'docker',
        plan: PLAN,
        region: REGION,
        healthCheckPath: '/api/health',
        envSpecificDetails: { dockerfilePath: './Dockerfile', dockerContext: './' },
        envVars,
      },
    });
    if (!created.ok) {
      const body = JSON.stringify(created.body || '').slice(0, 600);
      if (/github|repo|not found|permission/i.test(body)) {
        die('创建服务失败。多半是 Render 还没连 GitHub（或没给这个仓库授权）。\n' +
          '请在 Render 控制台 → Settings → GitHub → Connect GitHub，选 All repositories，然后重跑本脚本。\n' +
          'HTTP ' + created.status + '：' + body);
      }
      die('创建服务失败（HTTP ' + created.status + '）：' + body);
    }
    service = created.body.service || created.body;
    console.log('   服务已创建：' + service.id);
  }

  /* ---------- 5. 等构建 ---------- */
  const sid = service.id;
  console.log('⑥ 等待构建与上线（首次约 3–8 分钟）…');
  const started = Date.now();
  let lastStatus = '';
  let url = (service.serviceDetails && service.serviceDetails.url) || ('https://' + SERVICE_NAME + '.onrender.com');
  for (let i = 0; i < 240; i++) {
    await sleep(5000);
    const svc = await renderJson('GET', '/services/' + sid);
    if (svc.ok) {
      const s = svc.body.service || svc.body;
      if (s.serviceDetails && s.serviceDetails.url) url = s.serviceDetails.url;
      const status = (s.serviceDetails && s.serviceDetails.lastDeployStatus) || '';
      if (status && status !== lastStatus) {
        lastStatus = status;
        console.log('   [' + Math.round((Date.now() - started) / 1000) + 's] ' + status);
      }
      if (status === 'live') break;
      if (['build_failed', 'canceled', 'deactivated', 'pre_deploy_failed'].includes(status)) {
        const logs = await renderJson('GET', '/services/' + sid + '/logs?limit=60');
        console.error(JSON.stringify(logs.body, null, 2).slice(0, 3000));
        die('构建失败：' + status + '（日志见上，或到 Render 控制台查看）');
      }
    }
  }

  /* ---------- 6. 验收 ---------- */
  console.log('⑦ 验收 ' + url + ' …');
  let ok = false;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(url + '/api/health', { headers: { 'User-Agent': 'xieyi-deploy' } });
      const j = await r.json().catch(() => null);
      if (r.ok && j) {
        console.log('   健康检查 OK：规则 ' + j.rules + ' 条，法条 ' + (j.law && j.law.articles) + ' 条，模型 ' +
          ((j.model && j.model.configured) ? '已接入' : '未接入'));
        ok = true;
        break;
      }
      console.log('   health HTTP ' + r.status + '，5 秒后重试…');
    } catch (e) {
      console.log('   尚未就绪（' + e.message + '），5 秒后重试…');
    }
    await sleep(5000);
  }

  console.log('\n================ 部署完成 ================');
  console.log('固定网址：' + url);
  console.log('账号：' + ACCESS_USER + '    口令：' + ACCESS_PASSWORD);
  console.log('提交给评委：' + url + '  （账号 ' + ACCESS_USER + ' / 口令 ' + ACCESS_PASSWORD + '）');
  console.log('==========================================');
  if (!ok) {
    console.log('注意：健康检查还没通过，可能是实例在冷启动（免费档休眠后约 40–60 秒）。');
    console.log('过一分钟再打开网址即可；若仍打不开，到 Render 控制台看日志。');
  }
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
