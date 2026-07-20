// scripts/docs/features-json.mjs
//
// 把 docs/features.yaml 导出成 JSON，供 PPT（python）等非 mjs 消费方读取。
// 单一解析器在 mjs 这边，python 只读 JSON——避免维护第二份 yaml 解析器。
//
// Run:  node scripts/docs/features-json.mjs

import { loadFeatures } from './features-lib.mjs';

const features = loadFeatures();
process.stdout.write(JSON.stringify(features));
