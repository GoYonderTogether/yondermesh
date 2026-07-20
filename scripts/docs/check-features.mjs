// scripts/docs/check-features.mjs
//
// 功能状态漂移校验器（pre-commit 钩子 + 手动都跑这个）。
// 只校验、不重写文件（状态以人为准）。
//   - 解析 docs/features.yaml
//   - 每条 feature 字段完整、status 合法
//   - 每条 code 路径真实存在（抓失效引用）
//   - id 唯一
// 有任何未解决错误 → exit 1（钩子据此拦截提交）。
//
// Run:  node scripts/docs/check-features.mjs
// Fix:  无自动 fix（状态语义需人判断；code 引用错了改 yaml 即可）。

import { loadFeatures, validateFeature, checkCodePaths, REPO_ROOT } from './features-lib.mjs';

let problems = 0;
const report = (msg) => { console.error(`  ✗ ${msg}`); problems++; };

console.log('[check-features] 校验 docs/features.yaml');

let features;
try {
  features = loadFeatures();
} catch (e) {
  console.error(`[check-features] 读取失败：${e.message}`);
  process.exit(1);
}

if (features.length === 0) {
  console.error('[check-features] features 列表为空');
  process.exit(1);
}

const seenIds = new Set();
for (const f of features) {
  const tag = f.id || '<无 id>';
  const errs = validateFeature(f);
  for (const e of errs) report(`[${tag}] ${e}`);

  if (f.id && seenIds.has(f.id)) report(`[${tag}] id 重复`);
  if (f.id) seenIds.add(f.id);

  const missing = checkCodePaths(f);
  for (const m of missing) report(`[${tag}] code 路径不存在：${m}`);
}

if (problems > 0) {
  console.error(`\n[check-features] ${problems} 个问题。修正 docs/features.yaml 后重试（或临时 --no-verify 跳过）。`);
  process.exit(1);
}

const byStatus = {};
for (const f of features) byStatus[f.status] = (byStatus[f.status] || 0) + 1;
const summary = Object.entries(byStatus).map(([k, v]) => `${k}:${v}`).join('  ');
console.log(`[check-features] 通过：${features.length} 项（${summary}）`);
