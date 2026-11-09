/**
 * 协议体检官 · 后端骨架
 * ---------------------------------------------------------------------------
 * 定位：极简 Node.js + Express 服务。只负责
 *   1) 静态页面托管（index.html / css / js / vendor）
 *   2) 文件接收与文本提取（txt / docx / pdf）
 *   3) 审查流水线编排：解析 → 条款拆分 → 合规检索 → 风险打分 → 报告生成
 *   4) 结果缓存（内存）与报告导出（./output/）
 *
 * 【后续接入 Agent 流水线】真正的语义推理在 ./lib 之外的两处：
 *   - analyzeWithModel()：接了 DeepSeek / OpenAI 兼容接口，config.json 填 apiKey 即启用；
 *   - RULES 规则库：本地合规知识库基线，模型不可用时保证演示不中断。
 * 未配置 key 时自动降级为「规则引擎」模式，页面会明确标注当前引擎。
 *
 * 启动：node server.js   →  http://127.0.0.1:3080
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

/* =========================================================================
 * 0. 配置
 * ========================================================================= */

const DEFAULT_CONFIG = {
  app: { name: '协议体检官', version: '0.9.0', port: 3080, host: '127.0.0.1' },
  model: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutMs: 60000,
    enabled: true,
    /* 审查阶段是否叠加模型复核：默认关闭，让判定与分数只由规则层决定（同一份文本永远同一结果）。
     * 模型仍用于追问助手；需要模型补充疑点时，在设置页打开，或启动时 MODEL_ANALYZE=1。 */
    analyze: false
  },
  review: { defaultScale: 'standard', maxChars: 20000, maxFileMB: 20, stagePacingMs: 220, maxRisksPerClause: 3 },
  law: { enabled: true, indexFile: './data/law/index.json', topK: 3, minScore: 0.12 },
  export: { outputDir: './output', formats: ['json', 'docx', 'md'] },
  access: { enabled: false, user: 'judge', password: '', ttlHours: 12 },
  /* 追问助手（RAG 问答）：默认关闭，避免公网口令链接被转发后消耗 API 额度。
   * 打开方式：设置页「追问助手」开关、config.json chat.enabled、或启动时 CHAT_ENABLED=1。 */
  chat: {
    enabled: true,
    model: '',
    temperature: 0.3,
    maxTokens: 700,
    historyRounds: 4,
    maxQuestionChars: 500,
    ratePerMin: 20,
    ratePerDay: 300,
    topK: 4
  }
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let config = DEFAULT_CONFIG;
let configMtime = 0;
try {
  // 注意：Windows 记事本 / PowerShell 保存的 JSON 可能带 BOM，这里先剥掉再解析
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
  config = deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  configMtime = fs.statSync(CONFIG_PATH).mtimeMs;
} catch (e) {
  console.warn('[config] 读取失败，使用默认配置：', e.message);
}

/* 热加载：开发者在本机（3080）改完设置写盘后，评审实例（3090）无需重启即可读到新配置。
 * 只在文件 mtime 变化时重读，正常请求只多一次 stat。 */
function reloadConfigIfChanged() {
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (!st.mtimeMs || st.mtimeMs === configMtime) return false;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    config = deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
    configMtime = st.mtimeMs;
    if (CHAT_ENV === null) CHAT_ON = !!(config.chat && config.chat.enabled);
    console.log('[config] 检测到 config.json 变更，已热加载');
    return true;
  } catch (e) {
    return false;
  }
}

/* 容器 / 云托管部署时用环境变量注入密钥，避免把 Key 写进镜像或仓库。
 * 环境变量优先级高于 config.json，但没有环境变量时行为完全不变。 */
if (process.env.MODEL_BASE_URL) config.model.baseUrl = process.env.MODEL_BASE_URL;
if (process.env.MODEL_API_KEY) config.model.apiKey = process.env.MODEL_API_KEY;
if (process.env.MODEL_NAME) config.model.model = process.env.MODEL_NAME;
if (process.env.MODEL_ENABLED) config.model.enabled = process.env.MODEL_ENABLED !== 'false';
if (process.env.MODEL_ANALYZE) config.model.analyze = /^(1|true|yes|on)$/i.test(String(process.env.MODEL_ANALYZE));
if (process.env.CHAT_ENABLED) config.chat.enabled = /^(1|true|yes|on)$/i.test(String(process.env.CHAT_ENABLED));
if (process.env.CHAT_MODEL) config.chat.model = process.env.CHAT_MODEL;

const OUTPUT_DIR = path.resolve(ROOT, config.export.outputDir || './output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/* ---- 法条库（本地向量检索） ----
 * data/law/raw/*.html 是抓取下来的法律法规原文，tools/build-law-index.js 切成条文并建成向量索引。
 * 检索完全本地、离线可用，不依赖任何外部接口。索引缺失时自动降级为规则自带的条文摘要。
 */
const rag = require('./lib/rag');
const llaw = config.law || {};
const LAW_KEY_BY_NAME = {
  民法典: 'minfadian',
  个人信息保护法: 'gerenxinxi',
  劳动合同法: 'laodong',
  消费者权益保护法: 'xiaofei',
  电子商务法: 'dianzi',
  网络交易监督管理办法: 'wangluojiaoyi',
  合同行政监督管理办法: 'hetongjianguan',
  著作权法: 'zhuzuoquan',
  民事诉讼法: 'minsu',
};
let lawIndex = null;
if (llaw.enabled !== false) {
  try {
    lawIndex = rag.load(llaw.indexFile ? path.resolve(ROOT, llaw.indexFile) : undefined);
  } catch (e) {
    console.warn('[law] 索引加载失败：', e.message);
  }
}

function lawKeyOf(name) {
  const clean = String(name || '').replace(/[《》\s]/g, '');
  const hit = Object.keys(LAW_KEY_BY_NAME).find((key) => clean.includes(key));
  return hit ? LAW_KEY_BY_NAME[hit] : null;
}

function articleNosOf(label) {
  const text = String(label || '');
  const hits = text.match(/\d+/g);
  if (hits && hits.length) return hits.map(Number).filter((n) => n > 0);
  const cn = text.match(/[一二三四五六七八九十百千零〇两]+/g) || [];
  return cn.map((part) => rag.cnToInt(part)).filter((n) => n > 0);
}

function articleNoOf(label) {
  return articleNosOf(label)[0] || null;
}

/** 查规则所引条文的官方原文（找不到返回 null；多条文时合并） */
function officialArticle(lawName, articleLabel) {
  if (!lawIndex) return null;
  const key = lawKeyOf(lawName);
  if (!key) return null;
  const arts = articleNosOf(articleLabel);
  if (!arts.length) return null;
  const docs = arts.map((art) => lawIndex.getArticle(key, art)).filter(Boolean);
  if (!docs.length) return null;
  const first = docs[0];
  return {
    law: first.law,
    lawShort: first.lawShort,
    lawKey: first.lawKey,
    art: first.art,
    artLabel: articleLabel,
    text: docs.map((doc) => doc.text).join('\n'),
    parts: docs.map((doc) => ({ art: doc.art, artLabel: doc.artLabel, text: doc.text })),
  };
}

/* ---- 访问口令（评审用：链接 + 账号密码） ----
 * 开启方式（优先级从高到低）：
 *   1) 环境变量 ACCESS_PASSWORD（可选 ACCESS_USER，默认 judge）
 *   2) config.json → access.password
 * 未开启时行为与本地演示完全一致，不影响开发调试。
 */
const ACCESS_PASSWORD = String(process.env.ACCESS_PASSWORD || config.access.password || '');
const ACCESS_USER = String(process.env.ACCESS_USER || config.access.user || 'judge');
const ACCESS_TTL = Number(process.env.ACCESS_TTL_HOURS || config.access.ttlHours || 12);
const ACCESS_ON = ACCESS_PASSWORD.length > 0 && (config.access.enabled || !!process.env.ACCESS_PASSWORD || !!config.access.password);
/* 角色：口令实例（评委/使用者）为 reviewer，本机免登录实例（3080）为 developer。
 * reviewer 只能查看模型接入状态，不能修改，也不能写盘——避免演示时被误改（或恶意改）配置。
 * 真要在口令实例里改配置：启动前设 CONFIG_EDITABLE=1。 */
const ROLE = ACCESS_ON ? 'reviewer' : 'developer';
const CONFIG_READONLY =
  ROLE !== 'developer' && !/^(1|true|yes)$/i.test(String(process.env.CONFIG_EDITABLE || ''));
/* 追问助手的总开关。评审实例默认关闭：链接一旦被转发，问答会消耗开发者的 API 额度。 */
const CHAT_ENV = process.env.CHAT_ENABLED ? /^(1|true|yes|on)$/i.test(String(process.env.CHAT_ENABLED)) : null;
let CHAT_ON = CHAT_ENV === null ? !!(config.chat && config.chat.enabled) : CHAT_ENV;
const SESSION_COOKIE = 'cr_session';
const SESSION_KEY = crypto.createHash('sha256').update('cr-session::' + ACCESS_PASSWORD).digest();

/* =========================================================================
 * 1. 工具函数
 * ========================================================================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const uid = (prefix = 't') => prefix + '_' + crypto.randomBytes(6).toString('hex');
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function log(task, level, tag, msg) {
  if (!task) return;
  task.logs.push({ ts: nowTime(), level, tag, msg });
  if (task.logs.length > 400) task.logs.shift();
}

/* =========================================================================
 * 2. 合规规则库（本地知识基线）
 *    level: high / mid / low
 *    patterns: 命中任意一条即判定；evidence 取命中所在的整句
 * ========================================================================= */

const RULES = [
  {
    id: 'R01',
    type: '责任限制',
    level: 'high',
    name: '单方免责 / 责任上限过低',
    patterns: [
      /不承担(任何|一切|相关)?(责任|损失|赔偿)/,
      /(赔偿|责任|损失赔偿)[^。；\n]{0,14}(总额|上限|限额)[^。；\n]{0,8}(不超过|不高于|以[^。；\n]{0,10}为限)/,
      /(损失|后果|风险)[^。；\n]{0,10}(自行|自负|由[^。；\n]{0,6}承担)/
    ],
    basis: {
      law: '《中华人民共和国民法典》',
      article: '第 497 条',
      quote: '提供格式条款一方不合理地免除或者减轻其责任、加重对方责任、限制对方主要权利的，该格式条款无效。'
    },
    suggestion:
      '把「一概免责」改为过错责任：仅对非因故意或重大过失造成的直接损失设赔偿上限，且上限与合同总金额挂钩（如「不低于合同总金额的 100%」），并保留人身损害、故意重大过失不得限制的例外。'
  },
  {
    id: 'R02',
    type: '单方变更',
    level: 'high',
    name: '单方变更 / 终止权（无需通知）',
    patterns: [
      /(有权|可以)?\s*(随时|单方面|单方)[^。；\n]{0,10}(变更|修改|调整|终止|解除|中止|停止)/,
      /(无需|无须|不需|不必)[^。；\n]{0,6}(另行)?(通知|征得同意|取得同意)[^。；\n]{0,10}(变更|修改|调整|终止|解除)/
    ],
    basis: {
      law: '《中华人民共和国民法典》',
      article: '第 496 条',
      quote: '采用格式条款订立合同的，提供格式条款的一方应当遵循公平原则确定当事人之间的权利和义务，并采取合理的方式提示对方注意免除或者减轻其责任等与对方有重大利害关系的条款。'
    },
    suggestion:
      '单方变更应限于「非实质性调整」，并约定提前 15–30 日以显著方式通知；涉及价格、责任、服务范围的实质性变更，须经对方书面同意，对方不同意时有权无责终止。'
  },
  {
    id: 'R03',
    type: '解释权',
    level: 'mid',
    name: '最终解释权归一方',
    patterns: [/(最终|唯一|排他)?解释权[^。；\n]{0,8}(归|属于)[^。；\n]{0,10}(所有|享有|一方)?/, /本(协议|活动|规则)[^。；\n]{0,10}最终解释权/],
    basis: {
      law: '《合同行政监督管理办法》',
      article: '第 8 条',
      quote: '经营者不得以格式条款等方式作出「最终解释权归本店所有」等排除或者限制消费者权利的规定。'
    },
    suggestion: '删除「最终解释权」表述，改为：条款理解发生争议时，按通常理解解释；有两种以上解释的，作出不利于提供格式条款一方的解释（《民法典》第 498 条）。'
  },
  {
    id: 'R04',
    type: '自动续费',
    level: 'mid',
    name: '自动续费 / 默示同意',
    patterns: [
      /(自动|默认|期满后自动)[^。；\n]{0,6}(续费|续订|续期|延期)/,
      /(未|不)[^。；\n]{0,6}(提出|表示)[^。；\n]{0,6}(异议|反对)[^。；\n]{0,6}视为[^。；\n]{0,6}(同意|接受|续订)/
    ],
    basis: {
      law: '《网络交易监督管理办法》',
      article: '第 18 条',
      quote: '网络交易经营者采取自动展期、自动续费等方式提供服务的，应当在消费者接受服务前和自动展期、自动续费等日期前五日，以显著方式提请注意。'
    },
    suggestion: '自动续费须在扣费前 5 日以短信/站内信显著提示，并提供与开通同等便捷的取消入口；不得以「未提出异议」推定同意。'
  },
  {
    id: 'R05',
    type: '个人信息',
    level: 'high',
    name: '个人信息收集 / 对外提供授权过宽',
    patterns: [
      /(收集|获取|使用|处理)[^。；\n]{0,10}(个人信息|用户信息|身份信息|通讯录|位置信息)/,
      /(向|提供给)?[^。；\n]{0,6}(第三方|关联方|合作伙伴)[^。；\n]{0,6}(提供|共享|披露|transfer)[^。；\n]{0,10}(个人信息|用户信息|数据)/
    ],
    basis: {
      law: '《中华人民共和国个人信息保护法》',
      article: '第 13、17、23 条',
      quote: '处理个人信息应当取得个人同意，并以显著方式、清晰易懂的语言真实、准确、完整地告知处理目的、方式、种类、保存期限；向第三方提供的，应当告知接收方名称、联系方式、处理目的并取得单独同意。'
    },
    suggestion:
      '按「最小必要」原则逐项列明收集字段与用途，敏感信息单独同意；对外提供须列明接收方清单并取得单独同意，同时提供撤回同意与删除的路径。'
  },
  {
    id: 'R06',
    type: '知识产权',
    level: 'mid',
    name: '成果 / 内容权利归属失衡',
    patterns: [
      /(全部|所有|无偿|永久|不可撤销)[^。；\n]{0,10}(知识产权|著作权|版权|成果|所有权)[^。；\n]{0,10}(归|属于)/,
      /(知识产权|著作权|版权|成果)[^。；\n]{0,16}(无偿|永久|不可撤销)[^。；\n]{0,10}(归|属于|许可|授权)/,
      /(授予|许可)[^。；\n]{0,6}(永久|不可撤销|无偿)[^。；\n]{0,10}(使用|许可|授权)/
    ],
    basis: {
      law: '《中华人民共和国著作权法》',
      article: '第 19 条',
      quote: '受委托创作的作品，著作权的归属由委托人和受托人通过合同约定；合同未作明确约定或者没有订立合同的，著作权属于受托人。'
    },
    suggestion: '区分「委托成果」与「既有知识产权」：委托成果可约定归委托方，但受托方既有工具、模板、组件保留权利并授予使用许可；避免「永久无偿不可撤销」的概括授权。'
  },
  {
    id: 'R07',
    type: '争议解决',
    level: 'mid',
    name: '管辖法院 / 仲裁机构单方倾斜',
    patterns: [
      /(由|在)[^。；\n]{0,10}(本公司|甲方|乙方|提供方)[^。；\n]{0,8}(所在地|住所地)[^。；\n]{0,6}(法院|人民法院|仲裁)/,
      /(争议|纠纷)[^。；\n]{0,12}(提交|由)[^。；\n]{0,12}(仲裁委员会|仲裁机构)/
    ],
    basis: {
      law: '《中华人民共和国民事诉讼法》',
      article: '第 35 条',
      quote: '合同或者其他财产权益纠纷的当事人可以书面协议选择被告住所地、合同履行地、合同签订地、原告住所地、标的物所在地等与争议有实际联系的地点的人民法院管辖。'
    },
    suggestion: '改为「由被告住所地或合同履行地人民法院管辖」，或约定中立的仲裁机构；避免仅约定一方所在地法院，增加相对方维权成本。'
  },
  {
    id: 'R08',
    type: '违约责任',
    level: 'mid',
    name: '违约金过高 / 单方罚则',
    patterns: [
      /违约金[^。；\n]{0,12}(按|为|每日|每逾期)[^。；\n]{0,10}(\d{1,3}\s*%|万分之|千分之|倍)/,
      /(逾期|迟延)[^。；\n]{0,10}(按|每日)[^。；\n]{0,8}(万分之|千分之|\d\s*%)/,
      /违约金[^。；\n]{0,12}(相当于|不低于|至少|为)[^。；\n]{0,10}(\d{1,2}|[一二三四五六七八九十]{1,3})\s*个?月(的)?工资/,
      /(双倍|三倍|数倍)[^。；\n]{0,6}(返还|赔偿|支付)/,
      /(\d{1,3}\s*%|万分之[一二三四五六七八九十]+|千分之[一二三四五六七八九十]+)[^。；\n]{0,10}(支付|收取|作为|承担)[^。；\n]{0,4}违约金/,
      /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*个?月(的)?工资[^。；\n]{0,6}(违约金|违约赔偿|罚款)/
    ],
    basis: {
      law: '《中华人民共和国民法典》',
      article: '第 585 条',
      quote: '约定的违约金过分高于造成的损失的，人民法院或者仲裁机构可以根据当事人的请求予以适当减少。'
    },
    suggestion: '违约金水平应与可预见损失相当（一般不超过损失的 130%），并对双方设置对等标准；同时明确违约金与继续履行、赔偿损失的关系。'
  },
  {
    id: 'R09',
    type: '费用退还',
    level: 'mid',
    name: '概不退款 / 押金不退',
    patterns: [/(概不|不予|一律不)[^。；\n]{0,4}(退|返还)[^。；\n]{0,6}(款|费|押金|保证金)?/, /(押金|保证金|预付款)[^。；\n]{0,10}(不予|不再)[^。；\n]{0,4}(退还|返还)/],
    basis: {
      law: '《中华人民共和国民法典》',
      article: '第 497 条',
      quote: '不合理地免除或者减轻其责任、加重对方责任、限制对方主要权利的格式条款无效。'
    },
    suggestion: '按服务实际履行比例退还剩余费用，明确可扣除的合理成本范围与计算方式；押金应在服务结束后 15 个工作日内无息退还。'
  },
  {
    id: 'R10',
    type: '格式条款提示',
    level: 'mid',
    name: '重要条款未尽提示说明义务',
    patterns: [/(视为|即视为)[^。；\n]{0,8}(已(阅读|理解|同意|知悉))/, /(勾选|点击)[^。；\n]{0,10}(即|视为)[^。；\n]{0,8}(同意|接受)[^。；\n]{0,6}(全部|本协议)/],
    basis: {
      law: '《中华人民共和国民法典》',
      article: '第 496 条',
      quote: '未履行提示或者说明义务，致使对方没有注意或者理解与其有重大利害关系的条款的，对方可以主张该条款不成为合同的内容。'
    },
    suggestion: '对免责、限责、管辖、自动续费等重大条款采用加粗/弹窗单独确认，并保留用户确认记录；避免以「点击即视为同意全部条款」概括推定。'
  },
  {
    id: 'R11',
    type: '单方解除',
    level: 'mid',
    name: '解除权不对等',
    patterns: [/(有权|可以)[^。；\n]{0,8}(立即|直接)[^。；\n]{0,8}(解除|终止)[^。；\n]{0,8}(本协议|合同|服务)/, /(解除|终止)[^。；\n]{0,10}(无需|无须)[^。；\n]{0,6}(承担|赔偿)[^。；\n]{0,6}(责任|损失)/],
    basis: {
      law: '《中华人民共和国民法典》',
      article: '第 563、565 条',
      quote: '当事人一方迟延履行债务或者有其他违约行为致使不能实现合同目的，可以解除合同；解除权行使应通知对方。'
    },
    suggestion: '约定双向对等的解除条件与通知期，明确解除后的费用结算、数据导出与交接义务，避免仅一方享有无责解除权。'
  },
  {
    id: 'R12',
    type: '价格调整',
    level: 'mid',
    name: '单方调价 / 费用变更',
    patterns: [/(有权|保留)[^。；\n]{0,10}(调整|变更|上调)[^。；\n]{0,8}(价格|费用|收费标准|费率)/, /(价格|费用)[^。；\n]{0,10}(以|按)[^。；\n]{0,8}(实际|最新|公示)[^。；\n]{0,6}(为准)/],
    basis: {
      law: '《中华人民共和国消费者权益保护法》',
      article: '第 26 条',
      quote: '经营者在经营活动中使用格式条款的，应当以显著方式提请消费者注意商品或者服务的数量和质量、价款或者费用、履行期限和方式等与消费者有重大利害关系的内容。'
    },
    suggestion: '调价应提前 30 日通知并允许用户在调价生效前无责终止；已支付周期内价格锁定，不得追溯调整。'
  },
  {
    id: 'R13',
    type: '举证责任',
    level: 'mid',
    name: '举证责任 / 风险转移',
    patterns: [/(由|均由)[^。；\n]{0,6}(用户|乙方|消费者|承租人|买方|客户|甲方)[^。；\n]{0,8}承担[^。；\n]{0,8}(举证责任|证明责任)/, /(风险|损失)[^。；\n]{0,10}(自|在)[^。；\n]{0,8}(交付|发出|上传)[^。；\n]{0,6}(时|后)[^。；\n]{0,8}(转移|由[^。；\n]{0,6}承担)/],
    basis: {
      law: '《中华人民共和国民法典》',
      article: '第 604、605 条',
      quote: '标的物毁损、灭失的风险，在标的物交付之前由出卖人承担，交付之后由买受人承担，但是法律另有规定或者当事人另有约定的除外。'
    },
    suggestion: '举证责任按「谁主张谁举证」分配，服务方可就系统日志、交付记录承担相应举证义务；风险转移节点与验收标准一并明确。'
  },
  {
    id: 'R14',
    type: '通知送达',
    level: 'low',
    name: '通知送达视为条款',
    patterns: [/(公告|站内信|邮件|短信)[^。；\n]{0,10}(即视为|视为)[^。；\n]{0,8}(送达|通知|知悉)/],
    basis: {
      law: '《中华人民共和国民法典》',
      article: '第 137、139 条',
      quote: '以非对话方式作出的意思表示，到达相对人时生效。'
    },
    suggestion: '采用「发送 + 合理到达」双重标准，并约定联系方式变更的告知义务；仅以公告方式通知重大事项不足以证明到达。'
  },
  {
    id: 'R15',
    type: '权利义务转让',
    level: 'low',
    name: '单方转让合同权利义务',
    patterns: [/(有权|可以)[^。；\n]{0,8}(将本协议|将本合同|将[^。；\n]{0,6}权利义务)[^。；\n]{0,8}(转让|转移)[^。；\n]{0,6}(给)?[^。；\n]{0,8}/],
    basis: {
      law: '《中华人民共和国民法典》',
      article: '第 545、551 条',
      quote: '债务人将债务的全部或者部分转移给第三人的，应当经债权人同意。'
    },
    suggestion: '转让须经对方书面同意，且受让方应具备履约能力；因转让导致服务质量下降的，原合同方承担连带责任。'
  },
  {
    id: 'R16',
    type: '不可抗力',
    level: 'low',
    name: '不可抗力范围被不当扩大',
    patterns: [/(不可抗力)[^。；\n]{0,14}(包括但不限于|含)[^。；\n]{0,16}(政策|监管|系统故障|第三方|网络)/],
    basis: {
      law: '《中华人民共和国民法典》',
      article: '第 180、590 条',
      quote: '不可抗力是不能预见、不能避免且不能克服的客观情况。'
    },
    suggestion: '将「系统故障、第三方服务中断、政策调整」等可预见、可控制事项排除在不可抗力之外，作为服务连续性义务处理。'
  },
  {
    id: 'R17',
    type: '竞业限制',
    level: 'mid',
    name: '竞业 / 排他限制过宽',
    patterns: [
      /(不得|禁止|不能)[^。；\n]{0,10}(从事|经营|任职)[^。；\n]{0,10}(同类|竞争|相似|同行|同业)[^。；\n]{0,8}(业务|行业|产品|工作)?/,
      /(竞业限制|竞业禁止)[^。；\n]{0,16}(三|四|五|六|七|八|九|十)[^。；\n]{0,3}年/,
      /(竞业限制|竞业禁止)[^。；\n]{0,24}(无需|不支付|不予支付|不再支付)[^。；\n]{0,8}(补偿|经济补偿)/
    ],
    basis: {
      law: '《中华人民共和国劳动合同法》',
      article: '第 23、24 条',
      quote: '对负有保密义务的劳动者，用人单位可以在劳动合同或者保密协议中与劳动者约定竞业限制条款，并约定在解除或者终止劳动合同后，在竞业限制期限内按月给予劳动者经济补偿。'
    },
    suggestion: '竞业限制应限定在「同类竞争业务 + 特定岗位」，期限不超过 2 年，并按月支付补偿；对普通用户协议不应设置概括竞业义务。'
  },
  {
    id: 'R18',
    type: '免责声明',
    level: 'mid',
    name: '服务「不作任何保证」',
    patterns: [/(不保证|不作任何保证|不承担任何保证)[^。；\n]{0,20}(准确|完整|适用|及时|持续|可用)/, /(服务|产品)[^。；\n]{0,10}(按现状|as is)[^。；\n]{0,10}(提供|交付)/i],
    basis: {
      law: '《中华人民共和国民法典》',
      article: '第 506 条',
      quote: '合同中的下列免责条款无效：（一）造成对方人身损害的；（二）因故意或者重大过失造成对方财产损失的。'
    },
    suggestion: '保留合理的服务质量承诺（如可用性 99.5%、故障响应时限），仅对不可控因素作有限免责，并明确免责不影响法定责任。'
  },
  {
    id: 'R19',
    type: '劳动人事',
    level: 'mid',
    name: '试用期超出法定期限',
    patterns: [
      /试用期[^。；\n]{0,10}(不超过|为|最长)?[^。；\n]{0,6}(七|八|九|十|十二|半年|一年)[^。；\n]{0,3}(个月|年)/
    ],
    basis: {
      law: '《中华人民共和国劳动合同法》',
      article: '第 19 条',
      quote: '劳动合同期限三个月以上不满一年的，试用期不得超过一个月；一年以上不满三年的，不得超过二个月；三年以上固定期限和无固定期限的，不得超过六个月。'
    },
    suggestion: '试用期按合同期限设置（1 年以内 ≤1 个月、1–3 年 ≤2 个月、3 年以上 ≤6 个月）；同一用人单位与同一劳动者只能约定一次试用期，且试用期工资不得低于本单位相同岗位最低档工资的 80%。'
  },
  {
    id: 'R20',
    type: '期限与续期',
    level: 'mid',
    name: '租赁期限超过法定上限',
    patterns: [/(租赁|租期|租用)[^。；\n]{0,10}(期限|期间)[^。；\n]{0,6}(为|是)?[^。；\n]{0,4}(二十[一二三四五六七八九]?|三十[一二三四五六七八九]?|四十[一二三四五六七八九]?|(?:[2-9][1-9]))[^。；\n]{0,2}年/],
    basis: {
      law: '《中华人民共和国民法典》',
      article: '第 705 条',
      quote: '租赁期限不得超过二十年。超过二十年的，超过部分无效。'
    },
    suggestion: '将租期控制在 20 年以内；确需长期使用的，约定「期满后双方另行协商续租」，并明确续租条件与调价机制，避免被认定为超过法定上限的部分无效。'
  },
  {
    id: 'R21',
    type: '消费者权益',
    level: 'mid',
    name: '默认勾选 / 强制搭售',
    patterns: [
      /(默认|自动)[^。；\n]{0,6}(勾选|选中|开通|订购|购买)/,
      /(不得|不可)[^。；\n]{0,8}(取消|关闭|退订)[^。；\n]{0,8}(套餐|服务|选项)/,
      /(必须|需)[^。；\n]{0,6}(同时|一并)[^。；\n]{0,6}(购买|订购|开通)/
    ],
    basis: {
      law: '《中华人民共和国电子商务法》',
      article: '第 18 条',
      quote: '搭售商品或者服务，应当以显著方式提请消费者注意，不得将搭售商品或者服务作为默认同意的选项。'
    },
    suggestion: '所有付费项改为用户主动勾选、默认不选中；提供单独关闭/退订入口，且退订路径不劣于开通路径。'
  },
  {
    id: 'R22',
    type: '个人信息',
    level: 'high',
    name: '个人信息跨境 / 向境外提供',
    patterns: [
      /(传输|提供|共享|存储)[^。；\n]{0,12}(境外|国外|海外|港澳台)/,
      /(跨境)[^。；\n]{0,10}(传输|提供|处理)/
    ],
    basis: {
      law: '《中华人民共和国个人信息保护法》',
      article: '第 38 条、第 39 条',
      quote: '向境外提供个人信息的，应当取得个人的单独同意，并履行安全评估、标准合同或者认证等法定程序。'
    },
    suggestion: '如确需跨境，须单独列明接收方、目的、字段与保存期限，取得单独同意并完成安全评估或标准合同备案；否则删除跨境条款，改为境内存储。'
  }
];

const LEVEL_WEIGHT = { high: 3, mid: 2, low: 1, safe: 0 };
const LEVEL_LABEL = { high: '高风险', mid: '中风险', low: '低风险', safe: '合规' };

/* =========================================================================
 * 3. 文本解析
 * ========================================================================= */

/** 旧版 Word（.doc）是 OLE 复合文档，mammoth 无法解析，需给出明确提示 */
function looksLikeLegacyDoc(buffer) {
  return buffer && buffer.length > 8 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
}

/** 从 docx（zip）里取出指定条目并解压，作为 mammoth 失败时的兜底解析 */
function readZipEntry(buffer, entryName) {
  let offset = 0;
  while (offset + 30 < buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    if (name === entryName) {
      const raw = buffer.slice(dataStart, dataStart + compSize);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    offset = dataStart + compSize;
  }
  return null;
}

/** 从 word/document.xml 提取纯文本（段落换行，制表符保留） */
function textFromDocumentXml(xml) {
  return xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** 文本解码：优先 UTF-8，BOM 为 UTF-16 时按其解码，乱码严重时再试 GBK */
function decodeTextBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.slice(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const utf8 = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > utf8.length * 0.02) {
    try {
      const decoded = new TextDecoder('gbk').decode(buffer);
      if (decoded && !decoded.includes('\uFFFD')) return decoded;
    } catch (err) {
      /* 无 GBK 支持时保持 UTF-8 结果 */
    }
  }
  return utf8;
}

async function extractTextFromFile(file) {
  const name = file.originalname || '';
  const ext = path.extname(name).toLowerCase();
  const buffer = file.buffer || Buffer.alloc(0);

  if (!buffer.length) throw Object.assign(new Error('文件内容为空，请重新选择文件'), { code: 'EMPTY_FILE' });

  if (ext === '.txt' || ext === '.md' || ext === '.text') {
    return decodeTextBuffer(buffer);
  }

  if (ext === '.doc') {
    throw Object.assign(
      new Error('这是旧版 Word（.doc）文件，暂不支持直接解析。请在 Word 中点「另存为」选择 .docx 后重新上传'),
      { code: 'LEGACY_DOC' }
    );
  }

  if (ext === '.docx') {
    if (looksLikeLegacyDoc(buffer)) {
      throw Object.assign(
        new Error('该文件实际是旧版 Word（.doc）格式，请在 Word 中另存为 .docx 后重新上传'),
        { code: 'LEGACY_DOC' }
      );
    }
    let text = '';
    try {
      const mammoth = require('mammoth');
      const res = await mammoth.extractRawText({ buffer });
      text = (res && res.value) || '';
    } catch (err) {
      text = '';
    }
    if (!text.trim()) {
      // 兜底：直接解压 word/document.xml 抽文本，兼容部分非标准 docx
      const xml = readZipEntry(buffer, 'word/document.xml');
      if (xml) text = textFromDocumentXml(xml.toString('utf8'));
    }
    if (!text.trim()) {
      throw Object.assign(
        new Error('未能从该 Word 文件中读到文字，请确认文档未加密、内容不是纯图片，或直接粘贴正文'),
        { code: 'EMPTY_DOCX' }
      );
    }
    return text;
  }

  if (ext === '.pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    let text = '';
    try {
      const res = await parser.getText();
      text = (res && (res.text || (typeof res === 'string' ? res : ''))) || '';
    } finally {
      if (typeof parser.destroy === 'function') await parser.destroy().catch(() => {});
    }
    if (!text.trim()) {
      throw Object.assign(
        new Error('该 PDF 未提取到文字，可能是扫描件或图片型 PDF。请上传可复制文字的 PDF，或直接粘贴正文'),
        { code: 'EMPTY_PDF' }
      );
    }
    return text;
  }

  throw Object.assign(
    new Error('暂不支持该文件类型，请上传 .txt、.docx 或 .pdf 文件'),
    { code: 'UNSUPPORTED_TYPE' }
  );
}

/* =========================================================================
 * 4. 条款拆分
 * ========================================================================= */

const CN = '一二三四五六七八九十百千零〇两';
const HEAD_TOKEN = new RegExp(`^(第[${CN}\\d]+[条章节])|^([一二三四五六七八九十]+\\s*[、.．])|^(\\d+\\s*[、.．])|^(（[${CN}\\d]+）)`);

function cleanText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitClauses(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const headFlags = lines.map((l) => HEAD_TOKEN.test(l));
  const headCount = headFlags.filter(Boolean).length;

  const chunks = [];
  if (headCount >= 3) {
    // 行式：每行一个标题，后续行归入该条
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      if (headFlags[i]) {
        if (cur) chunks.push(cur);
        cur = { head: lines[i], body: [] };
      } else if (cur) {
        cur.body.push(lines[i]);
      }
    }
    if (cur) chunks.push(cur);
    return chunks.map((c, idx) => makeClause(idx, c.head, c.body.join('\n')));
  }

  // 内联式：整段按「第X条」切
  const parts = text.split(new RegExp(`(?=第[${CN}\\d]+条)`)).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return parts.map((p, idx) => {
      const nl = p.indexOf('\n');
      const head = nl > 0 && nl < 60 ? p.slice(0, nl) : p.slice(0, Math.min(24, p.length));
      const body = nl > 0 && nl < 60 ? p.slice(nl + 1) : p.slice(head.length);
      return makeClause(idx, head, body);
    });
  }

  // 兜底：按句子聚合
  const sentences = text.split(/(?<=[。；！？])/).map((s) => s.trim()).filter(Boolean);
  const groups = [];
  let buf = '';
  for (const s of sentences) {
    buf += s;
    if (buf.length >= 120) { groups.push(buf); buf = ''; }
  }
  if (buf.trim()) groups.push(buf);
  return groups.map((g, idx) => makeClause(idx, '', g, true));
}

function makeClause(index, head, body, noHead = false) {
  const headLine = (head || '').trim();
  const bodyText = (body || '').trim();
  const text = (headLine + (bodyText ? '\n' + bodyText : '')).trim();
  const m = headLine.match(HEAD_TOKEN);
  const rawNo = m ? m[0].replace(/\s+/g, '') : `第${index + 1}条`;
  const title = headLine && !noHead ? headLine.replace(HEAD_TOKEN, '').replace(/^[、.．\s]+/, '').slice(0, 28) : '';
  return {
    index,
    no: String(index + 1),
    rawNo,
    title: title || (bodyText ? bodyText.slice(0, 18) + (bodyText.length > 18 ? '…' : '') : '条款 ' + (index + 1)),
    text,
    charCount: text.length,
    type: '',
    level: 'safe',
    riskIds: []
  };
}

/* 条款类型分类（关键词计分） */
const TYPE_KEYWORDS = [
  ['劳动人事', ['劳动', '劳动合同', '员工', '用人', '试用期', '竞业', '离职', '工资', '薪酬', '社保']],
  ['争议解决', ['管辖', '仲裁', '诉讼', '争议解决', '适用法律']],
  ['责任与赔偿', ['赔偿', '责任', '免责', '损失', '违约金', '上限']],
  ['个人信息', ['个人信息', '隐私', '数据收集', '用户信息', '共享', '匿名化', '授权同意']],
  ['知识产权', ['知识产权', '著作权', '商标', '专利', '成果', '版权']],
  ['费用与结算', ['费用', '价款', '支付', '结算', '发票', '价格', '退款']],
  ['保密义务', ['保密', '商业秘密', '不得披露', '机密']],
  ['解除与终止', ['解除', '终止', '续费', '续订', '到期']],
  ['服务内容', ['服务内容', '服务范围', '交付', '工作内容', '验收', '可用性', '服务']],
  ['期限与生效', ['期限', '生效', '有效期', '履行', '签署']]
];

function classifyClause(text) {
  let best = { name: '其他', score: 0 };
  for (const [name, words] of TYPE_KEYWORDS) {
    let score = 0;
    for (const w of words) {
      const hit = text.split(w).length - 1;
      if (hit > 0) score += Math.min(2, hit);
    }
    if (score > best.score) best = { name, score };
  }
  return best.name;
}

/* =========================================================================
 * 5. 规则引擎：风险识别
 * ========================================================================= */

function pickEvidence(clauseText, pattern) {
  const m = clauseText.match(pattern);
  if (!m) return '';
  const at = m.index || 0;
  const start = Math.max(0, clauseText.lastIndexOf('。', at) + 1, clauseText.lastIndexOf('\n', at) + 1);
  let end = clauseText.length;
  const stops = ['。', '；', '\n'].map((c) => clauseText.indexOf(c, at)).filter((i) => i > 0);
  if (stops.length) end = Math.min(...stops) + 1;
  const sentence = clauseText.slice(start, end).trim();
  return sentence.length > 160 ? sentence.slice(0, 160) + '…' : sentence || m[0];
}

function analyzeByRules(clauses, scale) {
  const risks = [];
  const maxPerClause = config.review.maxRisksPerClause || 3;

  for (const clause of clauses) {
    const hits = [];
    for (const rule of RULES) {
      for (const p of rule.patterns) {
        const m = p.exec(clause.text);
        if (m) {
          hits.push({ rule, evidence: pickEvidence(clause.text, p), matched: m[0] });
          break;
        }
      }
      if (hits.length >= maxPerClause * 2) break;
    }

    // 审查尺度：严格=全部；标准=全部但每条款最多 2 条、低风险让位；宽松=只报高风险
    let kept = hits.slice().sort((a, b) => LEVEL_WEIGHT[b.rule.level] - LEVEL_WEIGHT[a.rule.level]);
    if (scale === 'loose') kept = kept.filter((h) => h.rule.level === 'high');
    else if (scale === 'standard') kept = kept.filter((h, i) => h.rule.level !== 'low' || i < 2);

    for (const { rule, evidence, matched } of kept.slice(0, maxPerClause)) {
      const basis = Object.assign({}, rule.basis);
      let sources = [];

      // ① 规则自带的条号 → 从法条库里取官方原文（比摘要更可信）
      const official = officialArticle(basis.law, basis.article);
      if (official) {
        basis.text = official.text;
        basis.official = true;
        basis.artLabel = official.artLabel;
        basis.parts = official.parts && official.parts.length > 1 ? official.parts : null;
      } else {
        // 法条库未收录该法条时，退回规则自带的条文要点，前端会标注「要点摘录」
        basis.text = basis.quote;
        basis.official = false;
      }

      // ② 向量检索同主题条文，作为「延伸参考」（限定在同一部法律内，避免跨法条噪音）
      if (lawIndex) {
        try {
          const query = [matched, evidence].filter(Boolean).join(' ') || rule.name;
          const topK = llaw.topK || 3;
          const minScore = typeof llaw.minScore === 'number' ? llaw.minScore : 0.15;
          const basisKey = lawKeyOf(basis.law);
          sources = lawIndex
            .search(query, topK + 4)
            .filter((item) => item.score >= minScore)
            .filter((item) => !basisKey || item.lawKey === basisKey)
            .filter((item) => !(official && item.lawKey === official.lawKey && item.art === official.art))
            .slice(0, topK)
            .map((item) => ({
              id: item.id,
              law: item.law,
              lawShort: item.lawShort,
              art: item.art,
              artLabel: item.artLabel,
              text: item.text,
              score: item.score,
            }));
        } catch (e) {
          sources = [];
        }
      }

      const risk = {
        id: `K${String(risks.length + 1).padStart(3, '0')}`,
        clauseIndex: clause.index,
        clauseNo: clause.no,
        clauseRawNo: clause.rawNo,
        ruleId: rule.id,
        type: rule.type,
        level: rule.level,
        levelLabel: LEVEL_LABEL[rule.level],
        name: rule.name,
        evidence,
        basis,
        sources,
        suggestion: rule.suggestion,
        engine: 'rules'
      };
      risks.push(risk);
      clause.riskIds.push(risk.id);
      if (LEVEL_WEIGHT[rule.level] > LEVEL_WEIGHT[clause.level]) clause.level = rule.level;
    }
    if (!clause.type) clause.type = classifyClause(clause.text);
  }
  return risks;
}

/* =========================================================================
 * 6. 大模型审查（可选，DeepSeek / OpenAI 兼容）
 * ========================================================================= */

function buildModelPrompt(clauses, scale) {
  const clauseBlock = clauses
    .map((c) => `【${c.rawNo}】${c.text.replace(/\n/g, ' ').slice(0, 400)}`)
    .join('\n')
    .slice(0, 12000);

  return [
    {
      role: 'system',
      content:
        '你是中国合同与协议合规审查专家，熟悉《民法典》《个人信息保护法》《消费者权益保护法》《劳动合同法》及监管规章。' +
        '你的任务是逐条审查协议，识别风险条款、违规条款与不公平格式条款，并给出可落地的修改建议。' +
        '严格输出 JSON，不要输出解释性文字。'
    },
    {
      role: 'user',
      content:
        `审查尺度：${scale === 'strict' ? '严格（法规零容忍）' : scale === 'loose' ? '宽松（仅报重大风险）' : '标准（业务可接受）'}\n` +
        `请审查以下协议条款：\n${clauseBlock}\n\n` +
        '输出 JSON：{"overall":"一句话总体结论","risks":[{"clauseNo":"条款序号，纯数字","type":"风险类型","level":"high|mid|low","name":"风险点名称","evidence":"原文依据（不超过80字）","basis":{"law":"法律法规名称","article":"条款号","quote":"法条要点"},"suggestion":"修改建议（不超过120字）"}]}\n' +
        '要求：最多返回 12 条最值得修的条款；clauseNo 必须是给定条款序号；无法判断时宁缺毋滥。'
    }
  ];
}

async function analyzeWithModel(clauses, scale, task) {
  const cfg = config.model;
  if (!cfg.enabled || !cfg.apiKey) return null;
  if (cfg.analyze === false) {
    log(task, 'warn', 'model', '审查阶段只使用规则库（模型复核未开启），判定与分数不受模型影响');
    return null;
  }
  const url = String(cfg.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  log(task, 'agent', 'model', `调用模型 ${cfg.model} · ${url}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        response_format: { type: 'json_object' },
        messages: buildModelPrompt(clauses, scale)
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs || 60000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(content);
    if (!parsed || !Array.isArray(parsed.risks)) throw new Error('模型返回结构不符合预期');
    return parsed;
  } catch (err) {
    log(task, 'warn', 'model', `模型调用失败，降级为规则引擎：${err.message}`);
    return null;
  }
}

function mergeModelRisks(clauses, modelResult, rulesRisks) {
  if (!modelResult) return rulesRisks;
  const merged = rulesRisks.slice();
  const byNo = new Map(clauses.map((c) => [String(c.no), c]));
  for (const r of modelResult.risks.slice(0, 20)) {
    const clause = byNo.get(String(r.clauseNo || '').replace(/[^\d]/g, ''));
    if (!clause) continue;
    const level = ['high', 'mid', 'low'].includes(r.level) ? r.level : 'mid';
    const dup = merged.find((x) => x.clauseIndex === clause.index && x.type === r.type);
    if (dup) continue;
    const risk = {
      id: `M${String(merged.length + 1).padStart(3, '0')}`,
      clauseIndex: clause.index,
      clauseNo: clause.no,
      clauseRawNo: clause.rawNo,
      ruleId: r.ruleId || 'MODEL',
      type: r.type || '模型识别',
      level,
      levelLabel: LEVEL_LABEL[level],
      name: r.name || '模型识别风险',
      evidence: String(r.evidence || '').slice(0, 160),
      basis: {
        law: r?.basis?.law || '《中华人民共和国民法典》',
        article: r?.basis?.article || '相关条款',
        quote: r?.basis?.quote || ''
      },
      suggestion: String(r.suggestion || '').slice(0, 220),
      engine: 'model'
    };
    merged.push(risk);
    clause.riskIds.push(risk.id);
    if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[clause.level]) clause.level = level;
  }
  return merged;
}

/* =========================================================================
 * 7. 打分与汇总
 * ========================================================================= */

function summarize(clauses, risks) {
  const high = risks.filter((r) => r.level === 'high').length;
  const mid = risks.filter((r) => r.level === 'mid').length;
  const low = risks.filter((r) => r.level === 'low').length;
  const weighted = high * 3 + mid * 2 + low * 1;
  const clauseCount = clauses.length;

  // 风险分：0（无风险）→ 99（极高）；加权风险 + 高风险密度双因子
  const density = clauseCount ? weighted / clauseCount : 0;
  const score =
    weighted === 0
      ? 0
      : clamp(Math.round(weighted * 2.4 + high * 4 + mid * 1.2 + Math.min(6, density * 3)), 4, 99);

  const typeMap = new Map();
  for (const r of risks) typeMap.set(r.type, (typeMap.get(r.type) || 0) + 1);
  const byType = [...typeMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  const clauseTypeMap = new Map();
  for (const c of clauses) clauseTypeMap.set(c.type || '其他', (clauseTypeMap.get(c.type || '其他') || 0) + 1);
  const byClauseType = [...clauseTypeMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  const heat = clauses.map((c) => ({
    no: c.no,
    rawNo: c.rawNo,
    level: c.level,
    weight: LEVEL_WEIGHT[c.level] || 0
  }));

  const level =
    high >= 3 || score >= 75 ? 'high' : high >= 1 || score >= 45 ? 'mid' : mid >= 1 || score >= 20 ? 'low' : 'safe';

  return {
    clauseCount,
    riskCount: risks.length,
    high,
    mid,
    low,
    safe: clauseCount - clauses.filter((c) => c.riskIds.length > 0).length,
    compliantClauses: clauses.filter((c) => c.riskIds.length === 0).length,
    weighted,
    score,
    level,
    levelLabel: { high: '高风险协议', mid: '中风险协议', low: '低风险协议', safe: '合规状态良好' }[level],
    byType,
    byClauseType,
    heat,
    totalChars: clauses.reduce((n, c) => n + c.charCount, 0)
  };
}

function buildConclusion(summary, risks, scale) {
  if (!summary.riskCount) {
    return `本次审查共拆分 ${summary.clauseCount} 条条款，未发现明显违规或显失公平的表述，整体合规状态良好。建议保留现有条款并定期复核监管要求变化。`;
  }
  const top = risks
    .slice()
    .sort((a, b) => LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level])
    .slice(0, 3)
    .map((r) => `${r.clauseRawNo}（${r.type}）`)
    .join('、');
  return (
    `本次审查共拆分 ${summary.clauseCount} 条条款，识别风险 ${summary.riskCount} 处，其中高风险 ${summary.high} 处、中风险 ${summary.mid} 处、低风险 ${summary.low} 处，` +
    `综合风险分 ${summary.score}，判定为${summary.levelLabel}。` +
    `问题最集中的条款为 ${top}，建议优先按修改建议逐条替换，并在签署前完成一次回归复核（审查尺度：${
      scale === 'strict' ? '严格' : scale === 'loose' ? '宽松' : '标准'
    }）。`
  );
}

/* =========================================================================
 * 8. 流水线编排
 * ========================================================================= */

/* ---- 协议类型：只用于标注与提示，不参与规则命中与打分 ---- */
const DOC_TYPES = {
  auto: '自动识别',
  service: '服务协议',
  privacy: '隐私政策',
  labor: '劳动合同',
  purchase: '采购 / 销售合同',
  other: '其他'
};

function docTypeLabel(code) {
  return DOC_TYPES[code] || DOC_TYPES.other;
}

/* 关键词加权：命中多、命中权重高的类型胜出；总分 < 6 视为无法判断 */
const DOC_TYPE_HINTS = {
  labor: [
    ['劳动合同', 6],
    ['用人单位', 3],
    ['劳动者', 3],
    ['试用期', 3],
    ['竞业限制', 3],
    ['社会保险', 3],
    ['加班', 2],
    ['离职', 2],
    ['工资', 1]
  ],
  privacy: [
    ['隐私政策', 6],
    ['个人信息', 3],
    ['个人信息保护法', 4],
    ['cookie', 3],
    ['处理者', 2],
    ['收集', 2],
    ['第三方共享', 3],
    ['授权同意', 3]
  ],
  service: [
    ['服务协议', 5],
    ['用户协议', 4],
    ['云服务', 3],
    ['订阅', 2],
    ['服务费', 2],
    ['自动续费', 2],
    ['平台', 1],
    ['账户', 1]
  ],
  purchase: [
    ['采购合同', 6],
    ['销售合同', 5],
    ['供货', 3],
    ['货款', 3],
    ['买方', 3],
    ['卖方', 3],
    ['交货', 3],
    ['验收', 2]
  ]
};

function detectDocType(text) {
  const src = String(text || '').toLowerCase();
  let best = { code: 'other', score: 0 };
  for (const code of Object.keys(DOC_TYPE_HINTS)) {
    let score = 0;
    for (const [kw, weight] of DOC_TYPE_HINTS[code]) {
      let idx = -1;
      let hits = 0;
      const needle = kw.toLowerCase();
      while ((idx = src.indexOf(needle, idx + 1)) !== -1) hits += 1;
      if (hits) score += weight * Math.min(hits, 4);
    }
    if (score > best.score) best = { code, score };
  }
  return best.score >= 6 ? best : { code: 'other', score: best.score };
}

/** 条款类型分布 → 粗略文书门类，仅用于「自动识别」没把握时的兜底文案 */
function clauseGenre(task) {
  const types = {};
  (task.clauses || []).forEach((c) => {
    const key = c.type || '其他';
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

/**
 * 报告里怎么描述「协议类型」：
 * - 选了自动识别 → 「自动识别 · <识别结果>」
 * - 手选了但与识别结果不一致 → 「<所选> · 识别更像 <识别结果>」（审查结论不受影响）
 */
function docTypeInfo(task) {
  const selected = task.docTypeResolved || task.docType || 'auto';
  const detected = task.docTypeDetected || '';
  if (!task.docType || task.docType === 'auto') {
    const label = selected && selected !== 'other' ? docTypeLabel(selected) : clauseGenre(task);
    return { label: `自动识别 · ${label}`, note: '' };
  }
  const label = docTypeLabel(selected);
  if (detected && detected !== selected && detected !== 'other' && (task.docTypeScore || 0) >= 6) {
    return { label, note: `识别更像${docTypeLabel(detected)}；所选类型只影响标注，不影响审查结论` };
  }
  return { label, note: '' };
}

const tasks = new Map();
const TASK_TTL_MS = 1000 * 60 * 60 * 6;

function newTask(fields) {
  const task = {
    id: uid('rv'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    filename: fields.filename || '未命名协议.txt',
    source: fields.source || 'text',
    docType: fields.docType || 'auto',
    docTypeDetected: fields.docTypeDetected || '',
    docTypeResolved: fields.docTypeResolved || fields.docType || 'auto',
    docTypeScore: fields.docTypeScore || 0,
    scale: fields.scale || config.review.defaultScale,
    status: 'queued',
    stage: 'parse',
    progress: 0,
    engine: 'rules',
    model: config.model.model,
    text: '',
    clauses: [],
    risks: [],
    summary: null,
    conclusion: '',
    logs: [],
    error: ''
  };
  tasks.set(task.id, task);
  // 清理过期任务
  for (const [id, t] of tasks) if (Date.now() - t.updatedAt > TASK_TTL_MS) tasks.delete(id);
  return task;
}

const STAGE_LABEL = {
  parse: '文档解析',
  split: '条款拆分',
  retrieve: '合规检索',
  score: '风险打分',
  report: '报告生成'
};

async function runPipeline(task, rawText) {
  const pacing = Number(config.review.stagePacingMs) || 0;
  let t0 = Date.now();
  const stageStart = async (stage, progress) => {
    task.stage = stage;
    task.progress = progress;
    log(task, 'info', stage, `▶ ${STAGE_LABEL[stage]} 开始`);
  };
  const stageEnd = async (stage, progress, msg) => {
    const used = Date.now() - t0;
    await sleep(Math.max(0, pacing - used));
    t0 = Date.now();
    task.progress = progress;
    log(task, 'ok', stage, `✔ ${STAGE_LABEL[stage]} 完成 · ${msg}`);
  };

  try {
    task.status = 'running';

    /* --- 1. 解析 --- */
    await stageStart('parse', 8);
    const text = cleanText(rawText);
    if (!text) throw Object.assign(new Error('未提取到有效文本，请检查文件内容或直接粘贴协议正文'), { code: 'EMPTY_TEXT' });
    task.text = text.length > config.review.maxChars ? text.slice(0, config.review.maxChars) : text;
    await stageEnd('parse', 20, `${text.length} 字 · ${task.source === 'file' ? '文件解析' : '文本输入'}`);

    /* --- 2. 条款拆分 --- */
    await stageStart('split', 30);
    const clauses = splitClauses(task.text).filter((clause) => {
      // 只去掉条款序号后判断剩余正文：单行条款（「第一条 ……」）的正文就是 title 本身，
      // 早期版本连 title 一起减掉，会把这类条款整条丢掉，导致短协议报「未能拆分出条款」。
      const body = String(clause.text || '')
        .replace(clause.rawNo || '', '')
        .replace(/\s/g, '');
      return body.length >= 4;
    });
    if (!clauses.length) throw Object.assign(new Error('未能拆分出条款，请确认协议包含「第一条」等条款结构'), { code: 'NO_CLAUSE' });
    task.clauses = clauses;
    await stageEnd('split', 45, `${clauses.length} 条 · 平均 ${Math.round(task.text.length / clauses.length)} 字/条`);

    /* --- 3. 合规检索（规则库 + 可选模型） --- */
    await stageStart('retrieve', 55);
    log(task, 'agent', 'rule', `加载合规规则库：${RULES.length} 条规则 · 审查尺度 ${task.scale}`);
    await sleep(pacing / 2);
    let risks = analyzeByRules(clauses, task.scale);
    log(task, 'ok', 'rule', `规则命中 ${risks.length} 处风险点`);
    const modelResult = await analyzeWithModel(clauses, task.scale, task);
    if (modelResult) {
      risks = mergeModelRisks(clauses, modelResult, risks);
      task.engine = 'model+rules';
      log(task, 'ok', 'model', `模型补充后共 ${risks.length} 处风险点`);
    } else {
      task.engine = 'rules';
      log(task, 'warn', 'model', '未配置模型密钥或调用失败，本次使用本地规则引擎');
    }
    task.risks = risks;
    await stageEnd('retrieve', 70, `${risks.length} 处风险 · 引擎 ${task.engine}`);

    /* --- 4. 风险打分 --- */
    await stageStart('score', 78);
    task.summary = summarize(clauses, risks);
    task.conclusion = buildConclusion(task.summary, risks, task.scale);
    await stageEnd('score', 88, `综合风险分 ${task.summary.score} · ${task.summary.levelLabel}`);

    /* --- 5. 报告生成 --- */
    await stageStart('report', 92);
    task.report = {
      title: '协议体检报告',
      generatedAt: new Date().toISOString(),
      conclusion: task.conclusion,
      sections: [
        { key: 'conclusion', title: '一、审查结论' },
        { key: 'risks', title: '二、风险清单' },
        { key: 'suggestions', title: '三、修改建议与法条依据' }
      ]
    };
    await stageEnd('report', 100, '报告结构已生成，可预览与导出');

    task.status = 'done';
    task.stage = 'done';
    task.updatedAt = Date.now();
    log(task, 'ok', 'system', `审查完成，用时 ${((Date.now() - task.createdAt) / 1000).toFixed(1)}s`);
  } catch (err) {
    task.status = 'failed';
    task.error = err.message || '审查失败';
    task.updatedAt = Date.now();
    log(task, 'err', task.stage, `✖ 失败：${task.error}`);
    console.error('[pipeline]', err);
  }
}

/* =========================================================================
 * 9. 报告导出：JSON / Markdown / DOCX（零依赖 ZIP 写入）
 * ========================================================================= */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** 生成 store 模式（不压缩）的 ZIP，Word 可正常打开 */
function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

const xmlEscape = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function docxParagraph(text, opts = {}) {
  const { bold = false, size = 21, align = 'left', color = '1F2937', spaceAfter = 100 } = opts;
  return (
    `<w:p><w:pPr><w:spacing w:after="${spaceAfter}" w:line="300" w:lineRule="auto"/><w:jc w:val="${align}"/></w:pPr>` +
    `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/></w:rPr>` +
    `<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`
  );
}

function docxTable(rows, widths) {
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const body = rows
    .map((cells, ri) => {
      const tcs = cells
        .map((cell, ci) => {
          const shade = ri === 0 ? '<w:shd w:val="clear" w:fill="EEF2FF"/>' : '';
          return (
            `<w:tc><w:tcPr><w:tcW w:w="${widths[ci]}" w:type="dxa"/>${shade}</w:tcPr>` +
            docxParagraph(String(cell), { bold: ri === 0, size: 18, spaceAfter: 0 }) +
            `</w:tc>`
          );
        })
        .join('');
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join('');
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9638" w:type="dxa"/>` +
    `<w:tblBorders>` +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>`)
      .join('') +
    `</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>` +
    docxParagraph('', { spaceAfter: 60 })
  );
}

function buildDocx(task) {
  const s = task.summary || {};
  const typeInfo = docTypeInfo(task);
  const typeCell = typeInfo.note ? `${typeInfo.label}（${typeInfo.note}）` : typeInfo.label;
  const rows = [['等级', '条款', '风险类型', '法条依据', '修改建议']];
  for (const r of task.risks) {
    rows.push([
      r.levelLabel,
      `${r.clauseRawNo}`,
      r.type,
      `${r.basis.law}${r.basis.article}`,
      r.suggestion.slice(0, 90) + (r.suggestion.length > 90 ? '…' : '')
    ]);
  }
  if (rows.length === 1) rows.push(['—', '—', '未发现明显风险', '—', '保持现有条款并定期复核']);

  const doc =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    docxParagraph('协议体检报告', { bold: true, size: 36, align: 'center', spaceAfter: 120 }) +
    docxParagraph(`生成时间：${new Date().toLocaleString('zh-CN')}`, { size: 18, align: 'center', color: '6B7280', spaceAfter: 240 }) +
    docxParagraph('一、基本信息', { bold: true, size: 24, spaceAfter: 120 }) +
    docxTable(
      [
        ['文件名', task.filename],
        ['协议类型', typeCell],
        ['审查尺度', task.scale === 'strict' ? '严格' : task.scale === 'loose' ? '宽松' : '标准'],
        ['审查引擎', task.engine === 'rules' ? '规则检查' : '模型复核 + 规则检查'],
        ['条款 / 风险数', `${s.clauseCount || 0} 条 / ${s.riskCount || 0} 处`],
        ['综合风险分', `${s.score || 0}（${s.levelLabel || '—'}）`]
      ],
      [1800, 7838]
    ) +
    docxParagraph('二、审查结论', { bold: true, size: 24, spaceAfter: 120 }) +
    docxParagraph(task.conclusion || '', { size: 21 }) +
    docxParagraph('三、风险清单', { bold: true, size: 24, spaceAfter: 120 }) +
    docxTable(rows, [900, 1100, 1600, 2600, 3438]) +
    docxParagraph('四、修改建议与法条依据', { bold: true, size: 24, spaceAfter: 120 }) +
    task.risks
      .slice(0, 12)
      .map(
        (r) =>
          docxParagraph(`${r.clauseRawNo} · ${r.name}（${r.levelLabel}）`, { bold: true, size: 21, spaceAfter: 40 }) +
          docxParagraph(`原文：${r.evidence || '—'}`, { size: 19, color: '4B5563', spaceAfter: 40 }) +
          docxParagraph(`依据：${r.basis.law}${r.basis.article}${r.basis.quote ? ' — ' + r.basis.quote : ''}`, { size: 19, color: '4B5563', spaceAfter: 40 }) +
          docxParagraph(`建议：${r.suggestion}`, { size: 19, spaceAfter: 160 })
      )
      .join('') +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1200" w:bottom="1440" w:left="1200" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>` +
    `</w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>` +
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>` +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>`)
      .join('') +
    `</w:tblBorders></w:tblPr></w:style>` +
    `</w:styles>`;

  return zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: doc },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: styles }
  ]);
}

function buildMarkdown(task) {
  const s = task.summary || {};
  const typeInfo = docTypeInfo(task);
  const lines = [
    `# 协议体检报告`,
    ``,
    `- 文件：${task.filename}`,
    `- 协议类型：${typeInfo.label}${typeInfo.note ? `（${typeInfo.note}）` : ''}`,
    `- 审查尺度：${task.scale}`,
    `- 引擎：${task.engine}`,
    `- 条款数：${s.clauseCount} · 风险数：${s.riskCount}（高 ${s.high} / 中 ${s.mid} / 低 ${s.low}）`,
    `- 综合风险分：${s.score}（${s.levelLabel}）`,
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    ``,
    `## 一、审查结论`,
    ``,
    task.conclusion,
    ``,
    `## 二、风险清单`,
    ``,
    `| 等级 | 条款 | 风险类型 | 法条依据 | 修改建议 |`,
    `| --- | --- | --- | --- | --- |`
  ];
  for (const r of task.risks) {
    lines.push(`| ${r.levelLabel} | ${r.clauseRawNo} | ${r.type} | ${r.basis.law}${r.basis.article} | ${String(r.suggestion).replace(/\|/g, '/')} |`);
  }
  lines.push('', `## 三、修改建议与法条依据`, '');
  for (const r of task.risks) {
    lines.push(`### ${r.clauseRawNo} · ${r.name}（${r.levelLabel}）`, '', `- 原文：${r.evidence || '—'}`, `- 依据：${r.basis.law}${r.basis.article} ${r.basis.quote || ''}`, `- 建议：${r.suggestion}`, '');
  }
  return lines.join('\n');
}

async function exportReport(task, format) {
  // 目录可能被手动删除，写入前补建，避免导出直接抛 ENOENT
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const base = `compliance-${task.id}-${stamp}`;
  if (format === 'json') {
    const name = `${base}.json`;
    const payload = {
      meta: {
        taskId: task.id,
        filename: task.filename,
        docType: task.docType,
        docTypeLabel: docTypeInfo(task).label,
        docTypeDetected: task.docTypeDetected || '',
        scale: task.scale,
        engine: task.engine,
        model: task.model,
        generatedAt: new Date().toISOString(),
        app: config.app.name,
        version: config.app.version
      },
      summary: task.summary,
      conclusion: task.conclusion,
      clauses: task.clauses,
      risks: task.risks
    };
    await fsp.writeFile(path.join(OUTPUT_DIR, name), JSON.stringify(payload, null, 2), 'utf8');
    return { name, size: Buffer.byteLength(JSON.stringify(payload)), mime: 'application/json' };
  }
  if (format === 'md') {
    const name = `${base}.md`;
    const md = buildMarkdown(task);
    await fsp.writeFile(path.join(OUTPUT_DIR, name), md, 'utf8');
    return { name, size: Buffer.byteLength(md), mime: 'text/markdown' };
  }
  if (format === 'docx') {
    const name = `${base}.docx`;
    const buf = buildDocx(task);
    await fsp.writeFile(path.join(OUTPUT_DIR, name), buf);
    return { name, size: buf.length, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  throw Object.assign(new Error('不支持的导出格式：' + format), { code: 'BAD_FORMAT' });
}

/* =========================================================================
 * 10. Express 应用
 * ========================================================================= */

const app = express();
app.use(express.json({ limit: '32mb' }));
app.use(express.urlencoded({ extended: true, limit: '32mb' }));

/* ---- 10.1 访问口令：登录页、会话与守门中间件（仅在 ACCESS_ON 时挂载） ---- */

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const index = part.indexOf('=');
      if (index < 0) return;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key) out[key] = decodeURIComponent(value);
    });
  return out;
}

function signSession(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + ACCESS_TTL * 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifySession(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');
  if (!sig || sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data && data.exp > Date.now() ? data : null;
  } catch (err) {
    return null;
  }
}

function isAuthed(req) {
  return !!verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function loginPage(message) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>访问验证 · 协议体检官</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    background: radial-gradient(1200px 600px at 50% -10%, #e8efff 0%, #f4f6fb 45%, #eef2f9 100%);
    color: #0f172a; padding: 24px; }
  .card { width: min(420px, 100%); background: #fff; border: 1px solid #e4e8f1; border-radius: 18px;
    box-shadow: 0 18px 50px rgba(15, 23, 42, .12); padding: 30px 28px 26px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
  .logo { width: 36px; height: 36px; border-radius: 11px; display: grid; place-items: center;
    background: linear-gradient(135deg, #3b6cf6, #7c4dff); color: #fff; font-weight: 700; font-size: 15px; }
  .brand h1 { margin: 0; font-size: 15.5px; letter-spacing: .01em; }
  .brand p { margin: 2px 0 0; font-size: 10.5px; letter-spacing: .12em; color: #8b95a9; }
  h2 { margin: 0 0 6px; font-size: 19px; }
  .sub { margin: 0 0 20px; font-size: 12.5px; color: #6b7688; line-height: 1.7; }
  label { display: block; font-size: 12px; font-weight: 600; color: #4a5568; margin: 14px 0 6px; }
  input { width: 100%; height: 42px; padding: 0 12px; border-radius: 10px; border: 1px solid #dbe2ee;
    background: #fbfcfe; font-size: 13.5px; color: #0f172a; outline: none; transition: .16s; }
  input:focus { border-color: #3b6cf6; background: #fff; box-shadow: 0 0 0 3px rgba(59, 108, 246, .12); }
  button { width: 100%; height: 44px; margin-top: 22px; border: 0; border-radius: 11px; cursor: pointer;
    color: #fff; font-size: 14px; font-weight: 600; letter-spacing: .02em;
    background: linear-gradient(135deg, #3b6cf6, #7c4dff); box-shadow: 0 8px 20px rgba(59, 108, 246, .28); }
  button:hover { filter: brightness(1.05); }
  .err { margin-top: 16px; padding: 9px 12px; border-radius: 9px; font-size: 12.5px;
    color: #b42318; background: #fef3f2; border: 1px solid #fecdca; }
  .foot { margin-top: 18px; font-size: 11px; color: #8b95a9; text-align: center; line-height: 1.7; }
</style></head>
<body>
  <form class="card" method="post" action="/login">
    <div class="brand">
      <span class="logo">✓</span>
      <div><h1>协议体检官</h1><p>AGREEMENT CHECKUP</p></div>
    </div>
    <h2>访问验证</h2>
    <label for="u">账号</label>
    <input id="u" name="user" autocomplete="username" required autofocus />
    <label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">进入体检台</button>
    ${message ? `<p class="err">${xmlEscape(message)}</p>` : ''}
    <p class="foot">本地规则引擎 · 协议文本不写入数据库</p>
  </form>
</body></html>`;
}

if (ACCESS_ON) {
  app.get('/login', (req, res) => {
    if (isAuthed(req)) return res.redirect('/');
    res.setHeader('cache-control', 'no-store');
    res.type('html').send(loginPage(''));
  });

  app.post('/login', (req, res) => {
    const body = req.body || {};
    const user = String(body.user || '').trim();
    const password = String(body.password || '');
    if (safeEqual(user, ACCESS_USER) && safeEqual(password, ACCESS_PASSWORD)) {
      res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=${signSession(ACCESS_USER)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ACCESS_TTL * 3600}`
      );
      return res.redirect('/');
    }
    res.status(401).setHeader('cache-control', 'no-store');
    res.type('html').send(loginPage('账号或密码不正确，请核对后再试。'));
  });

  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect('/login');
  });

  app.use((req, res, next) => {
    // 健康检查对容器平台与监控公开（只返回版本、规则数、法条数这类元信息，不含任何配置与用户数据）
    if (req.path === '/api/health') return next();
    if (isAuthed(req)) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: '登录已过期，请重新进入访问验证页', login: '/login' });
    }
    return res.redirect('/login');
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (config.review.maxFileMB || 10) * 1024 * 1024, files: 1 }
});

const publicTask = (t) => {
  const { logs, ...rest } = t;
  return { ...rest, logs: logs.slice(-120) };
};

app.get('/api/health', (req, res) => {
  reloadConfigIfChanged();
  const runningPort = Number(process.env.PORT || config.app.port || 3080);
  res.json({
    ok: true,
    app: Object.assign({}, config.app, { port: runningPort }),
    model: { provider: config.model.provider, model: config.model.model, configured: !!config.model.apiKey },
    chat: { enabled: CHAT_ON, mode: chatMode() },
    rules: RULES.length,
    law: lawIndex ? { articles: lawIndex.docCount, terms: lawIndex.termCount, model: 'tfidf-bigram-v1' } : null,
    tasks: tasks.size,
    uptime: Math.round(process.uptime())
  });
});

/* ---- 法条库检索 ---- */
app.get('/api/law/stats', (req, res) => {
  res.json({
    ok: true,
    ready: !!lawIndex,
    articles: lawIndex ? lawIndex.docCount : 0,
    terms: lawIndex ? lawIndex.termCount : 0,
    model: 'tfidf-bigram-v1',
    laws: (lawIndex && lawIndex.laws) || null
  });
});

app.get('/api/law/search', (req, res) => {
  if (!lawIndex) return res.status(503).json({ ok: false, error: '法条库未就绪' });
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: '缺少查询词 q' });
  const k = Math.min(20, Math.max(1, Number(req.query.k) || 5));
  const hits = lawIndex.search(q.slice(0, 400), k);
  res.json({ ok: true, query: q, hits });
});

app.get('/api/law/article', (req, res) => {
  if (!lawIndex) return res.status(503).json({ ok: false, error: '法条库未就绪' });
  const law = lawKeyOf(req.query.law) || String(req.query.law || '');
  const art = articleNoOf(req.query.art);
  if (!law || !art) return res.status(400).json({ ok: false, error: '缺少 law / art 参数' });
  const doc = lawIndex.getArticle(law, art);
  if (!doc) return res.status(404).json({ ok: false, error: '未收录该条文' });
  res.json({ ok: true, article: doc });
});

/* ---- 示例协议（「插入示例」用，也让演示/批测复用同一份语料） ---- */
const SAMPLES_PATH = path.join(__dirname, 'data', 'samples.json');
let samplesCache = null;

function loadSamples() {
  if (samplesCache) return samplesCache;
  try {
    const raw = fs.readFileSync(SAMPLES_PATH, 'utf8').replace(/^\uFEFF/, '');
    const list = JSON.parse(raw);
    samplesCache = Array.isArray(list)
      ? list
          .filter((s) => s && s.key && String(s.text || '').trim())
          .map((s) => ({
            key: String(s.key),
            title: String(s.title || s.key),
            desc: String(s.desc || ''),
            expect: String(s.expect || ''),
            chars: String(s.text).length,
            text: String(s.text)
          }))
      : [];
  } catch (err) {
    console.warn('[samples] 读取 data/samples.json 失败：' + err.message);
    samplesCache = [];
  }
  return samplesCache;
}

app.get('/api/samples', (req, res) => {
  const list = loadSamples();
  const withText = /^(1|true|yes)$/i.test(String(req.query.full || ''));
  res.json({
    ok: true,
    samples: list.map((s) => (withText ? s : { key: s.key, title: s.title, desc: s.desc, expect: s.expect, chars: s.chars }))
  });
});

app.get('/api/samples/:key', (req, res) => {
  const hit = loadSamples().find((s) => s.key === String(req.params.key));
  if (!hit) return res.status(404).json({ ok: false, error: '没有这个示例协议' });
  res.json({ ok: true, sample: hit });
});

/* ---- 配置读写 ---- */
app.get('/api/config', (req, res) => {
  reloadConfigIfChanged();
  const key = config.model.apiKey || '';
  res.json({
    role: ROLE,
    readonly: CONFIG_READONLY,
    app: config.app,
    // 评审模式只回「是否已配置」，连 Key 的首尾片段都不给
    model: {
      ...config.model,
      apiKey: key && !CONFIG_READONLY ? key.slice(0, 4) + '••••••' + key.slice(-2) : '',
      apiKeySet: !!key
    },
    review: config.review,
    export: config.export,
    chat: { ...chatCfg(), active: CHAT_ON, mode: chatMode() },
    rules: RULES.length
  });
});

app.post('/api/model/test', async (req, res) => {
  if (CONFIG_READONLY) {
    return res.status(403).json({
      ok: false,
      error: '当前账号无修改权限'
    });
  }
  const input = (req.body && req.body.model) || {};
  const cfg = {
    baseUrl: input.baseUrl || config.model.baseUrl,
    apiKey: input.apiKey || config.model.apiKey,
    model: input.model || config.model.model,
    timeoutMs: Math.min(config.model.timeoutMs || 60000, 20000)
  };
  if (!cfg.apiKey) return res.status(400).json({ ok: false, error: '还没有填写 API Key' });
  const url = String(cfg.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const started = Date.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: 32,
        messages: [
          { role: 'system', content: '你是连通性测试助手，只用一句话回答。' },
          { role: 'user', content: '回复「连接正常」四个字。' }
        ]
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs)
    });
    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 160);
      throw new Error(`HTTP ${r.status} ${detail}`.trim());
    }
    const data = await r.json();
    const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (!content) throw new Error('接口没有返回内容，请检查模型名是否正确');
    res.json({ ok: true, model: cfg.model, latencyMs: Date.now() - started, sample: String(content).slice(0, 60) });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err.message || err).slice(0, 200) });
  }
});

app.post('/api/config', async (req, res) => {
  if (CONFIG_READONLY) {
    return res.status(403).json({
      ok: false,
      error: '当前账号无修改权限，此处仅展示当前配置'
    });
  }
  const body = req.body || {};
  const patch = {};
  if (body.model) {
    patch.model = { ...body.model };
    if (!patch.model.apiKey || patch.model.apiKey.includes('•')) delete patch.model.apiKey; // 掩码不动
    delete patch.model.apiKeySet;
  }
  if (body.review) patch.review = body.review;
  if (body.chat && typeof body.chat === 'object') {
    patch.chat = body.chat;
    delete patch.chat.active;
    delete patch.chat.mode;
  }
  config = deepMerge(config, patch);
  if (CHAT_ENV === null) CHAT_ON = !!(config.chat && config.chat.enabled);
  if (body.clearApiKey) config.model.apiKey = '';
  try {
    await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    configMtime = fs.statSync(CONFIG_PATH).mtimeMs;
    res.json({
      ok: true,
      model: { ...config.model, apiKey: config.model.apiKey ? '******' : '' },
      chat: { ...chatCfg(), active: CHAT_ON, mode: chatMode() }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: '配置保存失败：' + err.message });
  }
});

/* =========================================================================
 * 12b. 追问助手（RAG 问答）
 *   - 只依据：本次任务 + 本地 1958 条法条库检索结果；不做开放域闲聊。
 *   - 有 Key 走模型流式输出（SSE）；无 Key / 调用失败自动降级为「本地检索」，
 *     只回条文原文 + 规则判断，不生成文字——保证现场无网也能用。
 *   - 默认关闭；评审实例（带口令）尤其要按需开启，避免链接被转发后消耗额度。
 * ========================================================================= */

const CHAT_HITS = new Map();

function chatCfg() {
  return Object.assign({}, DEFAULT_CONFIG.chat, config.chat || {});
}

function chatMode() {
  return config.model.apiKey && config.model.enabled !== false ? 'model' : 'local';
}

function clientIp(req) {
  const raw = String((req.headers && req.headers['x-forwarded-for']) || '');
  return raw.split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'local';
}

/** 每分钟 / 每天两级配额，防止公网链接被转发后把 Key 刷爆 */
function takeChatQuota(req) {
  const cfg = chatCfg();
  const ip = clientIp(req);
  const now = Date.now();
  let rec = CHAT_HITS.get(ip);
  if (!rec) {
    rec = { minStart: now, minCount: 0, dayStart: now, dayCount: 0 };
    CHAT_HITS.set(ip, rec);
  }
  if (now - rec.minStart > 60000) { rec.minStart = now; rec.minCount = 0; }
  if (now - rec.dayStart > 86400000) { rec.dayStart = now; rec.dayCount = 0; }
  const maxMin = Math.max(1, Number(cfg.ratePerMin) || 20);
  const maxDay = Math.max(1, Number(cfg.ratePerDay) || 300);
  if (rec.minCount >= maxMin) return { ok: false, error: `问得有点快，休息一下再问（每分钟最多 ${maxMin} 次）` };
  if (rec.dayCount >= maxDay) return { ok: false, error: `今天的追问额度已用完（每天 ${maxDay} 次）` };
  rec.minCount += 1;
  rec.dayCount += 1;
  return { ok: true };
}

/** 把「报告 + 聚焦条款/风险 + 检索到的法条」拼成可追溯的材料 */
/** 从问题里猜领域，用来把检索结果收窄到相关法律（猜不到就不过滤） */
const LAW_DOMAIN_HINTS = [
  { key: 'gerenxinxi', words: ['个人信息', '隐私', '人脸', '通讯录', '位置信息', '敏感信息'] },
  { key: 'laodong', words: ['劳动', '员工', '工资', '加班', '试用期', '竞业', '社保', '解除劳动'] },
  { key: 'wangluojiaoyi', words: ['自动续费', '自动展期', '网络交易', '电商', '平台', '店铺', '消费者'] },
  { key: 'hetongjianguan', words: ['格式条款', '最终解释权', '霸王条款', '行政处罚', '市场监管'] },
  { key: 'zhuzuoquan', words: ['著作权', '版权', '作品', '侵权', '转载'] },
  { key: 'dianzi', words: ['电子签名', '电子合同', '电子数据', '电子认证'] },
  { key: 'minsu', words: ['诉讼', '管辖', '仲裁', '举证', '法院', '调解'] },
  { key: 'minfadian', words: ['合同', '违约金', '定金', '免责', '解除', '履行', '赔偿', '格式条款', '意思表示'] }
];

function preferredLawKeys(text) {
  const source = String(text || '');
  const keys = [];
  LAW_DOMAIN_HINTS.forEach((item) => {
    if (item.words.some((word) => source.indexOf(word) >= 0)) keys.push(item.key);
  });
  return keys;
}

function buildChatContext(task, focus, question) {
  const cfg = chatCfg();
  const materials = [];
  const citations = [];
  const seen = new Set();
  const addCitation = (doc) => {
    if (!doc || !doc.lawKey || (!doc.art && !doc.text)) return;
    const key = doc.lawKey + '#' + (doc.art || doc.artLabel || '');
    if (seen.has(key)) return;
    seen.add(key);
    citations.push({
      key,
      law: doc.law,
      lawShort: doc.lawShort,
      lawKey: doc.lawKey,
      art: doc.art,
      artLabel: doc.artLabel,
      text: doc.text
    });
  };

  /** 规则自带的法条依据（比自由检索准得多，优先使用） */
  const addBasis = (basis, ruleId) => {
    if (!basis || !(basis.text || basis.quote)) return;
    const law = basis.law || '';
    const artLabel = basis.artLabel || basis.article || '';
    addCitation({
      law,
      lawShort: String(law).replace(/[《》]/g, ''),
      lawKey: lawKeyOf(law) || 'rule:' + (ruleId || 'R'),
      art: articleNoOf(artLabel) || 0,
      artLabel,
      text: basis.text || basis.quote
    });
  };

  let focusText = '';
  let focusLabel = '';

  if (task) {
    const s = task.summary || {};
    materials.push(
      `【报告】${task.filename || '未命名协议'}（${task.docType || 'auto'}）· 引擎 ${task.engine || 'rules'} · 综合 ${
        s.score === undefined ? '—' : s.score
      } 分 ${s.levelLabel || ''} · 风险 高${s.high || 0} 中${s.mid || 0} 低${s.low || 0}`
    );
    if (task.conclusion) materials.push(`【总体结论】${String(task.conclusion).slice(0, 300)}`);
  }

  const f = focus || {};
  const clauseOf = (index) => (task ? (task.clauses || []).find((c) => c.index === Number(index)) : null);

  if (task && f.type === 'risk') {
    const risk = (task.risks || []).find((r) => r.id === String(f.id || ''));
    if (risk) {
      const clause = clauseOf(risk.clauseIndex);
      focusLabel = `${risk.clauseRawNo} · ${risk.name}`;
      materials.push(
        `【聚焦条款】${clause ? `${clause.rawNo} ${clause.title || ''}\n${clause.text}` : risk.evidence || '（未取到条款原文）'}`
      );
      materials.push(`【规则判断】${risk.type} · ${risk.levelLabel || risk.level} · 命中原句「${risk.evidence || ''}」`);
      if (risk.suggestion) materials.push(`【修改建议】${risk.suggestion}`);
      if (risk.basis && (risk.basis.text || risk.basis.quote)) {
        const quote = risk.basis.text || risk.basis.quote;
        materials.push(`【报告引用的法条】${risk.basis.law || ''}${risk.basis.artLabel || risk.basis.article || ''}：${quote}`);
        addBasis(risk.basis, risk.ruleId);
      }
      focusText = [risk.name, risk.type, risk.evidence, clause ? clause.text : ''].join(' ');
    }
  } else if (task && f.type === 'clause') {
    const clause = clauseOf(f.index);
    if (clause) {
      focusLabel = `${clause.rawNo} ${clause.title || ''}`.trim();
      materials.push(`【聚焦条款】${clause.rawNo} ${clause.title || ''}\n${clause.text}`);
      const risks = (task.risks || []).filter((r) => r.clauseIndex === clause.index);
      if (risks.length) {
        materials.push('【该条款命中的风险】');
        risks.forEach((r) => {
          materials.push(`- ${r.name}（${r.levelLabel || r.level}）：${r.evidence || ''} → ${r.suggestion || ''}`);
          addBasis(r.basis, r.ruleId);
        });
      }
      focusText = [clause.title, clause.text, risks.map((r) => r.name).join(' ')].join(' ');
    }
  } else if (f.type === 'law' && lawIndex) {
    const key = f.lawKey ? String(f.lawKey) : lawKeyOf(f.law);
    const art = Number(f.art) || articleNoOf(f.article || f.artLabel);
    if (key && art) {
      const doc = lawIndex.getArticle(key, art);
      if (doc) {
        focusLabel = `《${doc.lawShort}》${doc.artLabel}`;
        addCitation(doc);
        focusText = doc.text;
        materials.push(`【聚焦法条】《${doc.lawShort}》${doc.artLabel}：${doc.text}`);
      }
    }
  } else if (task) {
    // 没指定焦点：给全局摘要 + 最严重的几条，够回答「最该改哪里」
    materials.push('【本次最严重的问题】');
    (task.risks || [])
      .slice()
      .sort((a, b) => ({ high: 3, mid: 2, low: 1 }[b.level] || 0) - ({ high: 3, mid: 2, low: 1 }[a.level] || 0))
      .slice(0, 6)
      .forEach((r) => materials.push(`- ${r.clauseRawNo} ${r.name}（${r.levelLabel || r.level}）：${r.suggestion || ''}`));
  }

  // 只有在「材料里没有法条依据」时才做自由检索：
  // TF-IDF 对口语化问题区分度有限，乱塞不相干条文比不塞更糟 —— 所以既要按分数收敛，也要按问题领域收窄。
  if (lawIndex && !citations.length) {
    const domain = preferredLawKeys(question);
    const globalFocus = !focus || focus.type === 'summary';
    // 已经按报告问「先改哪几条」时，问题的措辞本身没有法律关键词，
    // 硬检索只会捞出《民事诉讼法》这种无关条文 —— 有领域词时才检索，且只取一条。
    if (globalFocus && task && !domain.length) {
      // 跳过自由检索
    } else {
      const query = [focusText, question].filter(Boolean).join(' ').slice(0, 300);
      const pool = query ? lawIndex.search(query, Math.max(1, Math.min(12, Number(cfg.topK) || 4))) : [];
      const scoped = domain.length ? pool.filter((hit) => domain.indexOf(hit.lawKey) >= 0) : pool;
      const hits = scoped.length ? scoped : pool;
      const top = hits.length ? hits[0].score || 0 : 0;
      const floor = Math.max(0.12, top * 0.85);
      hits
        .filter((hit) => (hit.score || 0) >= floor)
        .slice(0, globalFocus && task ? 1 : 2)
        .forEach(addCitation);
    }
  }
  if (citations.length) {
    materials.push('【检索到的法条】');
    citations.slice(0, 6).forEach((c) => materials.push(`《${c.lawShort}》${c.artLabel}：${c.text}`));
  }

  return { materials, citations, focusLabel };
}

function chatSystemPrompt() {
  return [
    '你是「协议体检官」的追问助手，负责解释本次协议审查报告里的结论，帮非法律专业的用户读懂条款。',
    '硬性规则：',
    '1. 只能依据下面【材料】与【检索到的法条】回答；材料里没有的，直接说「当前材料里没有这部分信息」。',
    '2. 引用法条时必须写明法律名称与条号，并逐字引用条文原文；不得改写条文，也不得虚构条号。',
    '3. 不提供法律意见、胜诉可能性，也不预测具体纠纷的结果。',
    '4. 用中文回答：先一句话结论，再「依据」，最后「建议」；总长度不超过 300 字，可以用短列表。',
    '5. 与本次协议审查无关的问题，礼貌拒绝，并把话题引回报告。'
  ].join('\n');
}

function buildChatMessages(ctx, history, question) {
  const blocks = [];
  if (ctx.materials.length) blocks.push(ctx.materials.join('\n'));
  if (ctx.focusLabel) blocks.push('【当前聚焦】' + ctx.focusLabel);
  const user = (blocks.length ? blocks.join('\n\n') + '\n\n' : '') + '【用户问题】' + question;
  return [{ role: 'system', content: chatSystemPrompt() }, ...history, { role: 'user', content: user }];
}

function sanitizeHistory(list, rounds) {
  if (!Array.isArray(list)) return [];
  const max = Math.max(0, Math.min(20, Number(rounds) || 0)) * 2;
  const out = [];
  list.slice(-max).forEach((m) => {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    const content = String((m && m.content) || '').slice(0, 2000).trim();
    if (content) out.push({ role, content });
  });
  if (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function streamModelChat(messages, onDelta, signal) {
  const cfg = chatCfg();
  const url = String(config.model.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.model.apiKey}` },
    body: JSON.stringify({
      model: cfg.model || config.model.model,
      temperature: Number(cfg.temperature === undefined ? 0.3 : cfg.temperature),
      max_tokens: Math.max(128, Number(cfg.maxTokens) || 700),
      stream: true,
      messages
    }),
    signal
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || line.indexOf('data:') !== 0) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch (e) { continue; }
      const delta = json && json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
      if (delta) { text += delta; onDelta(delta); }
    }
  }
  return text;
}

/** 无 Key / 模型失败时的回答：只摘录条文与规则，不生成 */
function localChatAnswer(task, focus, citations, opts, question) {
  const lines = [
    opts && opts.reason
      ? `（${opts.reason}，以下为本地检索与摘录，不做改写。）`
      : '（以下为本地检索与原文摘录，不做改写。）'
  ];
  const f = focus || {};
  const CAPABILITY_RE = /(你能做|能做什么|能干什么|会什么|有什么功能|怎么用|如何使用|你是谁|帮助|help)/i;
  if (!task && !f.type) {
    if (CAPABILITY_RE.test(String(question || ''))) {
      // 「你能做什么」这类元问题：说清能力边界，而不是甩一句错误
      lines.push(
        '',
        '我能做这三件事：',
        '1. 解释报告里的每一条风险：为什么判成高/中/低，依据哪部法的第几条，怎么改。',
        '2. 把命中的法条原句摘给你，方便逐字核对，不做法律意见。',
        '3. 给可执行的改法：单方免责、自动续费、竞业限制无补偿这类条款，怎么改成双方都能签的版本。',
        '',
        '现在还没有可用的报告：把协议粘贴或上传到左侧，点「启动自动审查」，出结果后在这里问「第X条为什么是高风险」「要改哪三处」都可以。',
        '也可以直接问通用问题，例如「自动续费的合规红线是什么」「竞业限制必须给补偿吗」。'
      );
    } else {
      lines.push('', '（没有报告上下文，下面只给本地法条库里检索到的条文，具体到某份协议还需要先审查。）');
      if (citations.length) {
        lines.push('', '【检索到的条文】');
        citations.slice(0, 3).forEach((c) => lines.push(`《${c.lawShort}》${c.artLabel}：${c.text}`));
      } else {
        lines.push('', '本地法条库没有检索到直接相关的条文，换个说法再问，或先把协议粘贴到左侧做一次审查。');
      }
    }
  } else if (task && f.type === 'risk') {
    const risk = (task.risks || []).find((r) => r.id === String(f.id || ''));
    if (risk) {
      lines.push('', `【这条说的是】${risk.clauseRawNo} ${risk.name}`);
      lines.push(`【规则判断】${risk.type} · ${risk.levelLabel || risk.level}`);
      if (risk.evidence) lines.push(`【命中的原句】${risk.evidence}`);
      if (risk.suggestion) lines.push('', `【建议改法】${risk.suggestion}`);
    }
  } else if (task && f.type === 'clause') {
    const clause = (task.clauses || []).find((c) => c.index === Number(f.index));
    if (clause) {
      lines.push('', `【${clause.rawNo}】${clause.title || ''}`, clause.text);
      const hits = (task.risks || []).filter((r) => r.clauseIndex === clause.index);
      if (hits.length) {
        lines.push('', '【命中的风险】');
        hits.forEach((r) => lines.push(`- ${r.name}（${r.levelLabel || r.level}）：${r.suggestion || ''}`));
      }
    }
  } else if (task && (f.type === 'summary' || !f.type)) {
    // 没指定条款：按严重程度给「先改哪几条」，这才是用户真正要的答案
    const ordered = (task.risks || [])
      .slice()
      .sort((a, b) => ({ high: 3, mid: 2, low: 1 }[b.level] || 0) - ({ high: 3, mid: 2, low: 1 }[a.level] || 0));
    const s = task.summary || {};
    lines.push('', `【整体】${s.score === undefined ? '' : s.score + ' 分 · '}高风险 ${s.high || 0} 条 · 中风险 ${
      s.mid || 0
    } 条 · 低风险 ${s.low || 0} 条`);
    if (!ordered.length) {
      lines.push('', '本次没有命中风险规则，可以继续问具体条款。');
    } else {
      lines.push('', '【优先处理】');
      ordered.slice(0, 3).forEach((r, i) => {
        lines.push(`${i + 1}. ${r.clauseRawNo || ''} ${r.name}（${r.levelLabel || r.level}）`);
        if (r.suggestion) lines.push(`   → ${r.suggestion}`);
      });
    }
  }
  if (citations.length) {
    lines.push('', '【可对照的法条】');
    citations.slice(0, 3).forEach((c) => lines.push(`《${c.lawShort}》${c.artLabel}：${c.text}`));
  } else {
    lines.push('', '本地法条库没有检索到直接相关的条文。可以换个说法再问；在「设置」里接入模型后，会得到逐句解释。');
  }
  lines.push('', '以上为条文摘录与规则说明，不构成法律意见。');
  return lines.join('\n');
}

app.get('/api/chat/status', (req, res) => {
  reloadConfigIfChanged();
  const cfg = chatCfg();
  res.json({
    ok: true,
    enabled: CHAT_ON,
    mode: chatMode(),
    model: config.model.model,
    role: ROLE,
    maxQuestionChars: cfg.maxQuestionChars,
    historyRounds: cfg.historyRounds
  });
});

app.post('/api/chat', async (req, res) => {
  reloadConfigIfChanged();
  const cfg = chatCfg();
  if (!CHAT_ON) {
    return res.status(403).json({
      ok: false,
      error: '追问助手未开启，可在「设置」中打开'
    });
  }
  const quota = takeChatQuota(req);
  if (!quota.ok) return res.status(429).json({ ok: false, error: quota.error });

  const body = req.body || {};
  const question = String(body.question || '').trim().slice(0, Math.max(20, Number(cfg.maxQuestionChars) || 500));
  if (!question) return res.status(400).json({ ok: false, error: '请输入问题' });
  const wantedTaskId = body.taskId ? String(body.taskId) : '';
  const task = wantedTaskId ? tasks.get(wantedTaskId) || null : null;
  // 报告已不在内存（服务重启 / 超过 6 小时）时不直接报错：
  // 丢掉条款焦点，改为「不带报告」的回答，并用 notice 告知原因（前端显示成黄色提示条）。
  const taskGone = !!wantedTaskId && !task;
  const focus = !taskGone && body.focus && typeof body.focus === 'object' ? body.focus : null;
  const ctx = buildChatContext(task, focus, question);
  const history = sanitizeHistory(body.history, cfg.historyRounds);

  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  // 注意：不要监听 req 的 close —— 请求体被中间件读完时它就会触发（Node 24 上尤其明显），
  // 会把「正常请求」误判成「客户端断开」。只认 res 的 close。
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = (obj) => {
    if (closed || res.writableEnded) return;
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
  };

  const mode = chatMode();
  send({
    type: 'meta',
    mode,
    model: mode === 'model' ? cfg.model || config.model.model : 'local-rag',
    citations: ctx.citations,
    focus: ctx.focusLabel || '',
    notice: taskGone
      ? '这份报告已过期（服务重启或超过 6 小时），本轮先按通用问题回答；重新审查一份协议后，就能结合报告逐条解释。'
      : undefined
  });

  if (mode === 'model') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    res.on('close', () => controller.abort());
    let streamed = 0;
    try {
      await streamModelChat(
        buildChatMessages(ctx, history, question),
        (delta) => {
          streamed += String(delta).length;
          send({ type: 'delta', text: delta });
        },
        controller.signal
      );
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 200);
      send({
        type: 'meta',
        mode: 'local',
        model: 'local-rag',
        citations: ctx.citations,
        notice: '模型调用失败，已降级为本地检索：' + msg
      });
      if (streamed > 0) {
        // 已经吐了一部分模型文本：不再重复贴本地整段，避免答非所问的拼接
        send({ type: 'delta', text: '\n\n（模型连接中断，以上为已生成的部分；完整解释可稍后重试。）' });
      } else {
        send({ type: 'delta', text: localChatAnswer(task, focus, ctx.citations, { reason: '模型调用失败，已降级为本地检索' }, question) });
      }
    } finally {
      clearTimeout(timer);
    }
  } else {
    send({ type: 'delta', text: localChatAnswer(task, focus, ctx.citations, null, question) });
  }

  send({ type: 'done' });
  if (!res.writableEnded) res.end();
});

/* ---- 审查任务 ---- */
app.post('/api/review', upload.single('file'), async (req, res) => {
  try {
    const body = req.body || {};
    let text = body.text || '';
    let filename = body.filename || '';
    let source = 'text';

    if (req.file) {
      source = 'file';
      filename = filename || req.file.originalname;
      text = await extractTextFromFile(req.file);
    }
    if (!String(text || '').trim()) {
      return res.status(400).json({ ok: false, error: '请粘贴协议文本或上传文件后再提交' });
    }
    if (String(text).length > (config.review.maxChars || 20000) * 4) {
      return res.status(413).json({ ok: false, error: '文本过长，请先截断到关键条款后再试' });
    }

    const requestedType = String(body.docType || 'auto');
    const detected = detectDocType(String(text).slice(0, 20000));
    const task = newTask({
      filename: filename || (source === 'file' ? '协议文件' : '粘贴文本.txt'),
      source,
      docType: requestedType,
      docTypeDetected: detected.code,
      docTypeResolved: requestedType === 'auto' ? detected.code : requestedType,
      docTypeScore: detected.score,
      scale: body.scale || config.review.defaultScale
    });
    log(task, 'info', 'system', `任务 ${task.id} 已创建 · 来源 ${source === 'file' ? '文件上传' : '文本粘贴'}`);
    log(
      task,
      'info',
      'system',
      `参数：尺度 ${task.scale} · 类型 ${docTypeLabel(requestedType)}（识别为 ${docTypeLabel(detected.code)}，分 ${detected.score}）· 引擎 ${
        config.model.apiKey ? '模型+规则' : '规则'
      }`
    );

    // 异步执行流水线，前端轮询 /api/tasks/:id
    setImmediate(() => runPipeline(task, text));

    res.json({ ok: true, taskId: task.id, task: publicTask(task) });
  } catch (err) {
    const statusMap = {
      UNSUPPORTED_TYPE: 415,
      EMPTY_TEXT: 422,
      EMPTY_FILE: 422,
      EMPTY_DOCX: 422,
      EMPTY_PDF: 422,
      LEGACY_DOC: 422
    };
    const code = statusMap[err.code] || 500;
    res.status(code).json({ ok: false, error: err.message || '提交失败' });
  }
});

app.get('/api/tasks', (req, res) => {
  const list = [...tasks.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => ({
      id: t.id,
      filename: t.filename,
      docType: t.docType,
      scale: t.scale,
      status: t.status,
      stage: t.stage,
      progress: t.progress,
      engine: t.engine,
      createdAt: t.createdAt,
      summary: t.summary ? { riskCount: t.summary.riskCount, score: t.summary.score, level: t.summary.level, clauseCount: t.summary.clauseCount } : null
    }));
  res.json({ ok: true, tasks: list });
});

app.get('/api/tasks/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: '任务不存在或已过期' });
  res.json({ ok: true, task: publicTask(t) });
});

app.delete('/api/tasks/:id', (req, res) => {
  const ok = tasks.delete(req.params.id);
  res.json({ ok });
});

/* ---- 报告 ---- */
app.post('/api/tasks/:id/export', async (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: '任务不存在' });
  if (t.status !== 'done') return res.status(409).json({ ok: false, error: '审查尚未完成' });
  const format = (req.body && req.body.format) || 'json';
  try {
    const file = await exportReport(t, format);
    res.json({ ok: true, file: { ...file, url: `/api/reports/${encodeURIComponent(file.name)}/download` } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/reports', async (req, res) => {
  try {
    const names = await fsp.readdir(OUTPUT_DIR);
    const files = [];
    for (const name of names) {
      // 跳过 .gitkeep 之类的隐藏文件，它们不是可下载的报告
      if (name.startsWith('.')) continue;
      const st = await fsp.stat(path.join(OUTPUT_DIR, name)).catch(() => null);
      if (!st || !st.isFile()) continue;
      files.push({ name, size: st.size, mtime: st.mtimeMs, ext: path.extname(name).slice(1).toLowerCase() });
    }
    files.sort((a, b) => b.mtime - a.mtime);
    res.json({ ok: true, files });
  } catch (err) {
    res.json({ ok: true, files: [] });
  }
});

app.get('/api/reports/:name/download', (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(OUTPUT_DIR, name);
  if (!file.startsWith(OUTPUT_DIR) || !fs.existsSync(file)) return res.status(404).send('not found');
  res.download(file, name);
});

app.delete('/api/reports/:name', async (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(OUTPUT_DIR, name);
  if (!file.startsWith(OUTPUT_DIR)) return res.status(400).json({ ok: false });
  try {
    await fsp.unlink(file);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ ok: false, error: '文件不存在' });
  }
});

/* ---- 报告打印页（导出 PDF 用浏览器「打印为 PDF」） ---- */
app.get('/api/tasks/:id/print', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t || t.status !== 'done') return res.status(404).send('任务不存在或未完成');
  const s = t.summary || {};
  const rows = t.risks
    .map(
      (r) =>
        `<tr><td>${xmlEscape(r.levelLabel)}</td><td>${xmlEscape(r.clauseRawNo)}</td><td>${xmlEscape(r.type)}</td><td>${xmlEscape(
          r.basis.law + r.basis.article
        )}</td><td>${xmlEscape(r.suggestion)}</td></tr>`
    )
    .join('');
  res.type('html').send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${xmlEscape(
    t.filename
  )} · 协议体检报告</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Microsoft YaHei","PingFang SC",sans-serif; color:#111827; font-size:12px; line-height:1.75; }
  h1 { font-size:20px; text-align:center; margin:0 0 4px; }
  .sub { text-align:center; color:#6b7280; font-size:11px; margin-bottom:18px; }
  h2 { font-size:14px; margin:18px 0 8px; padding-left:8px; border-left:3px solid #3a5bfd; }
  table { width:100%; border-collapse:collapse; font-size:10.5px; }
  th,td { border:1px solid #d1d5db; padding:5px 6px; text-align:left; vertical-align:top; }
  th { background:#eef2ff; }
  .meta { display:flex; flex-wrap:wrap; gap:6px 24px; font-size:11px; color:#374151; }
  .kpi { display:flex; gap:10px; margin:10px 0; }
  .kpi div { flex:1; border:1px solid #e5e7eb; border-radius:6px; padding:8px; text-align:center; }
  .kpi b { display:block; font-size:16px; }
  .sug { border:1px solid #e5e7eb; border-radius:6px; padding:8px 10px; margin-bottom:8px; }
  .sug p { margin:2px 0; }
  .toolbar { text-align:right; margin-bottom:10px; }
  .toolbar button { padding:6px 14px; border:1px solid #3a5bfd; background:#3a5bfd; color:#fff; border-radius:6px; cursor:pointer; }
  @media print { .toolbar { display:none; } }
</style></head><body>
<div class="toolbar"><button onclick="window.print()">打印 / 另存为 PDF</button></div>
<h1>协议体检报告</h1>
<div class="sub">生成时间：${new Date().toLocaleString('zh-CN')} · 引擎：${xmlEscape(
    t.engine === 'rules' ? '规则检查' : '模型复核 + 规则检查'
  )}</div>
<div class="meta"><span>文件：${xmlEscape(t.filename)}</span><span>协议类型：${xmlEscape(
    docTypeInfo(t).label +
      (docTypeInfo(t).note ? '（' + docTypeInfo(t).note + '）' : '')
  )}</span><span>审查尺度：${xmlEscape(t.scale)}</span><span>条款数：${s.clauseCount || 0}</span></div>
<div class="kpi"><div><b>${s.riskCount || 0}</b>风险条款</div><div><b>${s.high || 0}</b>高风险</div><div><b>${
    s.mid || 0
  }</b>中风险</div><div><b>${s.low || 0}</b>低风险</div><div><b>${s.score || 0}</b>综合风险分</div></div>
<h2>一、审查结论</h2><p>${xmlEscape(t.conclusion)}</p>
<h2>二、风险清单</h2>
<table><thead><tr><th style="width:56px">等级</th><th style="width:64px">条款</th><th style="width:96px">风险类型</th><th style="width:120px">法条依据</th><th>修改建议</th></tr></thead><tbody>${
    rows || '<tr><td colspan="5">未发现明显风险</td></tr>'
  }</tbody></table>
<h2>三、修改建议与法条依据</h2>
${t.risks
  .slice(0, 12)
  .map(
    (r) =>
      `<div class="sug"><p><b>${xmlEscape(r.clauseRawNo)} · ${xmlEscape(r.name)}（${xmlEscape(r.levelLabel)}）</b></p>
       <p>原文：${xmlEscape(r.evidence || '—')}</p>
       <p>依据：${xmlEscape(r.basis.law + r.basis.article)}${r.basis.quote ? ' — ' + xmlEscape(r.basis.quote) : ''}</p>
       <p>建议：${xmlEscape(r.suggestion)}</p></div>`
  )
  .join('')}
</body></html>`);
});

/* ---- 静态资源 ---- */
app.use(
  express.static(ROOT, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('cache-control', 'no-store');
    }
  })
);

app.use((req, res) => {
  res.status(404).json({ ok: false, error: '接口或资源不存在：' + req.path });
});

/* eslint-disable no-unused-vars */
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: `文件超过 ${config.review.maxFileMB}MB 限制` });
  }
  console.error('[server]', err);
  res.status(500).json({ ok: false, error: err.message || '服务器内部错误' });
});

const PORT = Number(process.env.PORT || config.app.port || 3080);
const HOST = process.env.HOST || config.app.host || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`\n  协议体检官  v${config.app.version}`);
  console.log(`  ▸ 访问地址   http://${HOST}:${PORT}`);
  console.log(`  ▸ 规则库     ${RULES.length} 条`);
  console.log(`  ▸ 模型        ${config.model.model}（${config.model.apiKey ? '已配置 Key' : '未配置 Key，规则引擎模式'}）`);
  console.log(`  ▸ 访问口令   ${ACCESS_ON ? `已开启（账号 ${ACCESS_USER}，会话 ${ACCESS_TTL} 小时）` : '未开启（本机演示模式）'}`);
  if (config.access.enabled && !ACCESS_PASSWORD) {
    console.warn('  ! config.json 里 access.enabled=true 但 password 为空，已忽略访问口令。');
  }
  console.log(`  ▸ 输出目录   ${OUTPUT_DIR}\n`);
});

module.exports = { app, RULES, splitClauses, analyzeByRules, buildDocx };
