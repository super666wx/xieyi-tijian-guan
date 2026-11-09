'use strict';

/**
 * 法条向量检索（本地、离线、零依赖）
 * ------------------------------------------------------------------
 * 做法：把每一条法律条文切成一个 chunk，用「中文字符二元组 + 词频-逆文档频率（TF-IDF）」
 * 表示成稀疏向量，查询时同样向量化后用余弦相似度排序。
 *
 * 为什么不用神经网络 embedding：
 *   - 比赛现场可能没有外网，huggingface.co 在部分网络下不可达；
 *   - 本地 ONNX 模型动辄 100MB+，启动慢，演示机器不一定扛得住。
 * 这个实现完全本地、秒级启动，中文法条检索效果已经足够（见 tools/rag-test.js 的样例）。
 * 想要更强的语义检索，把 embedQuery()/embedDoc() 换成任意 embedding API 即可。
 */

const fs = require('fs');
const path = require('path');

const LAW_META = {
  minfadian: { name: '中华人民共和国民法典', short: '民法典' },
  gerenxinxi: { name: '中华人民共和国个人信息保护法', short: '个人信息保护法' },
  laodong: { name: '中华人民共和国劳动合同法', short: '劳动合同法' },
  xiaofei: { name: '中华人民共和国消费者权益保护法', short: '消费者权益保护法' },
  dianzi: { name: '中华人民共和国电子商务法', short: '电子商务法' },
  wangluojiaoyi: { name: '网络交易监督管理办法', short: '网络交易监督管理办法' },
  hetongjianguan: { name: '合同行政监督管理办法', short: '合同行政监督管理办法' },
  zhuzuoquan: { name: '中华人民共和国著作权法', short: '著作权法' },
  minsu: { name: '中华人民共和国民事诉讼法', short: '民事诉讼法' },
};

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };

/** 「一百二十三」→ 123 */
function cnToInt(text) {
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of String(text)) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (digit === 0) digit = 1;
      section += digit * unit;
      digit = 0;
    }
  }
  total += section + digit;
  return total;
}

function decodeBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buffer.subarray(3));
  }
  const head = buffer.subarray(0, 2048).toString('latin1');
  const declared = /charset=["']?([\w-]+)/i.exec(head);
  if (declared) {
    const label = declared[1].toLowerCase();
    try {
      return new TextDecoder(label === 'gb2312' ? 'gbk' : label).decode(buffer);
    } catch (error) {
      /* 落到下面的自动判断 */
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    return new TextDecoder('gbk').decode(buffer);
  }
}

function decodeEntities(text) {
  const named = {
    nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…', middot: '·',
    times: '×', divide: '÷', rarr: '→', larr: '←', copy: '©', reg: '®', deg: '°', plusmn: '±',
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (all, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (all, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (all, name) => (name.toLowerCase() in named ? named[name.toLowerCase()] : ' '));
}

function htmlToText(html) {
  let text = String(html);
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/\u00a0/g, ' ');
  text = text.replace(/[ \t\u3000]+/g, ' ');
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/\n{2,}/g, '\n');
  return text.trim();
}

/** 把整部法律的文本按「第X条」切成条文
 *  只在行首 / 句号后出现「第X条」时才算条文标题，避免把「本法第五百零六条」这类交叉引用切开
 */
function splitArticles(text) {
  const re = /(?:^|[\n。；])\s*第([一二三四五六七八九十百千零〇两]{1,8})条/g;
  const marks = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const headStart = match.index + match[0].indexOf('第');
    marks.push({ index: headStart, end: re.lastIndex, label: '第' + match[1] + '条', num: cnToInt(match[1]) });
  }
  const articles = [];
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i];
    const next = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(mark.end, next).replace(/\s+/g, ' ').trim();
    if (body.length < 6) continue;
    articles.push({ num: mark.num, label: mark.label, body });
  }
  return articles;
}

const STOP_TERMS = new Set(['本条', '本款', '该项', '依照', '按照', '规定', '应当', '可以', '不得']);

/** 口语 → 法条用词（查询侧扩展，提升召回） */
const SYNONYMS = [
  ['押金', ['定金', '保证金']],
  ['不退', ['不予退还', '不予返还']],
  ['退款', ['返还', '退还']],
  ['最终解释权', ['解释权']],
  ['单方变更', ['擅自变更', '变更']],
  ['单方解除', ['解除', '终止']],
  ['随时终止', ['随时解除', '终止']],
  ['自动续费', ['自动展期', '续费']],
  ['自动续订', ['自动展期', '续订']],
  ['大数据', ['自动化决策']],
  ['杀熟', ['自动化决策', '差别待遇']],
  ['隐私', ['个人信息']],
  ['人脸', ['生物识别', '敏感个人信息']],
  ['竞业', ['竞业限制']],
  ['违约金', ['违约金', '损失赔偿']],
  ['免责', ['免除责任', '免责条款']],
  ['格式条款', ['格式条款']],
  ['管辖', ['管辖', '协议管辖']],
  ['仲裁', ['仲裁']],
  ['知识产权', ['著作权', '职务作品']],
  ['转让', ['转让', '权利义务一并转让']],
  ['定金', ['定金']],
  ['租金', ['租金', '租赁']],
];

function tokenize(text) {
  const tokens = [];
  const clean = String(text).replace(/[\s]+/g, ' ');
  const cjkRe = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
  let match;
  while ((match = cjkRe.exec(clean)) !== null) {
    const run = match[0];
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const gram = run.slice(i, i + 2);
      if (!STOP_TERMS.has(gram)) tokens.push(gram);
    }
  }
  const latinRe = /[a-z0-9]{2,}/gi;
  while ((match = latinRe.exec(clean)) !== null) tokens.push(match[0].toLowerCase());
  return tokens;
}

function counterOf(tokens) {
  const map = new Map();
  tokens.forEach((token) => map.set(token, (map.get(token) || 0) + 1));
  return map;
}

/** 读取 data/law/raw/*.html，切条、去重，返回 chunk 列表 */
function readCorpus(rawDir) {
  const files = fs.readdirSync(rawDir).filter((name) => /\.html?$/i.test(name));
  const byKey = new Map();
  files.forEach((file) => {
    const key = path.basename(file, path.extname(file)).toLowerCase();
    const meta = LAW_META[key] || { name: key, short: key };
    const html = decodeBuffer(fs.readFileSync(path.join(rawDir, file)));
    const text = htmlToText(html);
    splitArticles(text).forEach((article) => {
      if (article.num <= 0) return;
      const id = key + '#' + article.num;
      const previous = byKey.get(id);
      if (!previous || previous.body.length < article.body.length) {
        byKey.set(id, {
          id,
          lawKey: key,
          law: meta.name,
          lawShort: meta.short,
          art: article.num,
          artLabel: article.label,
          body: article.body.slice(0, 2600),
        });
      }
    });
  });
  return Array.from(byKey.values()).sort((a, b) => (a.lawKey === b.lawKey ? a.art - b.art : a.lawKey.localeCompare(b.lawKey)));
}

function buildIndex(options) {
  const opts = Object.assign({ rawDir: path.join(__dirname, '..', 'data', 'law', 'raw'), outFile: path.join(__dirname, '..', 'data', 'law', 'index.json') }, options);
  const chunks = readCorpus(opts.rawDir);
  if (!chunks.length) throw new Error('没有找到任何法条，检查 ' + opts.rawDir);

  const df = new Map();
  const docTokens = chunks.map((chunk) => {
    const tf = counterOf(tokenize(chunk.body));
    Array.from(tf.keys()).forEach((token) => df.set(token, (df.get(token) || 0) + 1));
    return tf;
  });

  const total = chunks.length;
  const idf = new Map();
  df.forEach((count, token) => {
    // 太罕见（只出现在 1 条）和太普遍（超过 60% 条文）的词都不带信息量
    if (count < 2 || count > total * 0.6) return;
    idf.set(token, Math.log((total + 1) / (count + 1)) + 1);
  });

  const terms = Array.from(idf.keys());
  const termIndex = new Map(terms.map((term, index) => [term, index]));

  const docs = chunks.map((chunk, i) => {
    const weights = new Map();
    docTokens[i].forEach((tf, token) => {
      const weight = idf.get(token);
      if (!weight) return;
      weights.set(termIndex.get(token), (1 + Math.log(tf)) * weight);
    });
    let norm = 0;
    weights.forEach((value) => { norm += value * value; });
    norm = Math.sqrt(norm) || 1;
    const vec = Array.from(weights.entries())
      .map(([index, value]) => [index, Math.round((value / norm) * 10000) / 10000])
      .sort((a, b) => a[0] - b[0]);
    return {
      id: chunk.id,
      law: chunk.law,
      lawShort: chunk.lawShort,
      lawKey: chunk.lawKey,
      art: chunk.art,
      artLabel: chunk.artLabel,
      text: chunk.body,
      vec,
    };
  });

  const index = {
    model: 'tfidf-bigram-v1',
    builtAt: new Date().toISOString(),
    docCount: docs.length,
    termCount: terms.length,
    terms,
    docs,
  };
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  fs.writeFileSync(opts.outFile, JSON.stringify(index));
  return { outFile: opts.outFile, docCount: docs.length, termCount: terms.length, bytes: fs.statSync(opts.outFile).size };
}

function createSearcher(index) {
  const termIndex = new Map(index.terms.map((term, i) => [term, i]));
  const idf = new Map();
  const total = index.docs.length;
  // 用文档向量反推不了 df，这里重新按 docs 里出现过的 term 估一个 idf
  const docFreq = new Map();
  index.docs.forEach((doc) => {
    doc.vec.forEach(([termId]) => docFreq.set(termId, (docFreq.get(termId) || 0) + 1));
  });
  docFreq.forEach((count, termId) => {
    idf.set(termId, Math.log((total + 1) / (count + 1)) + 1);
  });

  function expandQuery(query) {
    const text = String(query);
    let extra = '';
    SYNONYMS.forEach(([key, words]) => {
      if (text.indexOf(key) >= 0) extra += ' ' + words.join(' ');
    });
    return extra ? text + extra : text;
  }

  function embedQuery(query) {
    const tf = counterOf(tokenize(expandQuery(query)));
    const weights = new Map();
    tf.forEach((count, token) => {
      const termId = termIndex.get(token);
      if (termId === undefined) return;
      const weight = idf.get(termId);
      if (!weight) return;
      weights.set(termId, (1 + Math.log(count)) * weight);
    });
    let norm = 0;
    weights.forEach((value) => { norm += value * value; });
    norm = Math.sqrt(norm) || 0;
    if (!norm) return [];
    return Array.from(weights.entries()).map(([termId, value]) => [termId, value / norm]);
  }

  function search(query, topK) {
    const qvec = embedQuery(query);
    if (!qvec.length) return [];
    const limit = Math.max(1, topK || 3);
    const scored = [];
    index.docs.forEach((doc) => {
      let dot = 0;
      let i = 0;
      let j = 0;
      while (i < qvec.length && j < doc.vec.length) {
        const a = qvec[i];
        const b = doc.vec[j];
        if (a[0] === b[0]) {
          dot += a[1] * b[1];
          i += 1;
          j += 1;
        } else if (a[0] < b[0]) {
          i += 1;
        } else {
          j += 1;
        }
      }
      if (dot > 0.01) scored.push({ score: dot, doc });
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((item) => ({
      id: item.doc.id,
      law: item.doc.law,
      lawShort: item.doc.lawShort,
      lawKey: item.doc.lawKey,
      art: item.doc.art,
      artLabel: item.doc.artLabel,
      text: item.doc.text,
      score: Math.round(item.score * 1000) / 1000,
    }));
  }

  function getArticle(lawKey, art) {
    return index.docs.find((doc) => doc.lawKey === lawKey && doc.art === Number(art)) || null;
  }

  const laws = {};
  index.docs.forEach((doc) => {
    laws[doc.lawShort] = (laws[doc.lawShort] || 0) + 1;
  });

  return { search, getArticle, laws, docCount: index.docs.length, termCount: index.terms.length };
}

let cached = null;

function load(indexFile) {
  if (cached) return cached;
  const file = indexFile || path.join(__dirname, '..', 'data', 'law', 'index.json');
  if (!fs.existsSync(file)) return null;
  const index = JSON.parse(fs.readFileSync(file, 'utf8'));
  cached = Object.assign({ file, builtAt: index.builtAt }, createSearcher(index));
  return cached;
}

module.exports = { buildIndex, load, splitArticles, htmlToText, cnToInt, tokenize, LAW_META };
