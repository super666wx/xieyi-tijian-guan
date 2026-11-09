'use strict';

/**
 * 构建法条向量索引
 * ------------------------------------------------------------------
 * 用法：
 *   node tools/build-law-index.js            # 重建索引
 *   npm run law:build                        # 同上
 *
 * 流程：data/law/raw/*.html（法律法规原文） → 按「第X条」切条 → TF-IDF 稀疏向量 → data/law/index.json
 * 说明：完全本地运行，不需要联网，也不依赖任何模型文件。
 */

const path = require('path');
const rag = require('../lib/rag');

const startedAt = Date.now();
const result = rag.buildIndex();
const costs = Date.now() - startedAt;

console.log('法条索引已生成');
console.log('  文件：' + path.relative(process.cwd(), result.outFile));
console.log('  条文：' + result.docCount + ' 条');
console.log('  词表：' + result.termCount + ' 个词');
console.log('  体积：' + (result.bytes / 1024 / 1024).toFixed(2) + ' MB');
console.log('  耗时：' + costs + ' ms');
