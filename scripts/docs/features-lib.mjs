// scripts/docs/features-lib.mjs
//
// features.yaml 的读写与校验工具，供 check-features.mjs / features-json.mjs 复用。
// 只解析本项目用到的极小 YAML 子集：顶层 `features:` 列表，每项是
//   - id: <str>
//     name: <str>
//     category: <str>
//     stage: <int>
//     status: <shipped|preview|building|planned|dropped>
//     code: [path/, path/]   # 内联数组；可为空 []
// 不引入 yaml 依赖（零新增依赖原则）。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 本文件在 <repoRoot>/scripts/docs/ 下，repoRoot 为父仓库根。
export const REPO_ROOT = join(__dirname, '..', '..');
export const FEATURES_PATH = join(REPO_ROOT, 'docs', 'features.yaml');

export const STATUSES = ['shipped', 'preview', 'building', 'planned', 'dropped'];
export const REQUIRED_FIELDS = ['id', 'name', 'category', 'stage', 'status', 'code'];

// 解析内联数组 `[a, b/]`；空数组返回 []。
function parseInlineArray(raw) {
  const s = raw.trim();
  if (s === '[]') return [];
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
  }
  // 非数组形式则当单值（容错）。
  return [s];
}

// 把一段文本解析成 features 数组。
export function parseFeaturesYaml(text) {
  const lines = text.split(/\r?\n/);
  const features = [];
  let inFeatures = false;
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().startsWith('#') || raw.trim() === '') continue;

    // 顶层 key
    if (/^[A-Za-z_]+:\s*$/.test(raw) || /^[A-Za-z_]+:/.test(raw) && !raw.startsWith(' ')) {
      const m = raw.match(/^([A-Za-z_]+):/);
      if (m && m[1] === 'features') inFeatures = true;
      else inFeatures = false;
      continue;
    }

    if (!inFeatures) continue;

    // 列表项起点：`  - id: xxx`
    const itemStart = raw.match(/^\s+-\s+id:\s*(.+?)\s*$/);
    if (itemStart) {
      if (cur) features.push(cur);
      cur = { id: itemStart[1].trim() };
      continue;
    }

    // 列表项内的键值：`    key: value`
    const kv = raw.match(/^\s+([A-Za-z_]+):\s*(.*)$/);
    if (kv && cur) {
      const [, key, val] = kv;
      if (key === 'code') cur[key] = parseInlineArray(val);
      else if (key === 'stage') cur[key] = Number(val);
      else cur[key] = val.trim();
    }
  }
  if (cur) features.push(cur);
  return features;
}

// 读取并解析 docs/features.yaml。
export function loadFeatures(path = FEATURES_PATH) {
  if (!existsSync(path)) {
    throw new Error(`features.yaml 未找到：${path}`);
  }
  return parseFeaturesYaml(readFileSync(path, 'utf-8'));
}

// 校验一条 feature 的字段完整性与状态合法性。返回错误字符串数组（空=通过）。
export function validateFeature(f) {
  const errs = [];
  for (const k of REQUIRED_FIELDS) {
    if (!(k in f)) errs.push(`字段缺失：${k}`);
  }
  if (f.status && !STATUSES.includes(f.status)) {
    errs.push(`status 非法：${f.status}（合法值：${STATUSES.join('|')}）`);
  }
  if (f.stage !== undefined && !Number.isInteger(Number(f.stage))) {
    errs.push(`stage 必须是整数：${f.stage}`);
  }
  if (f.code !== undefined && !Array.isArray(f.code)) {
    errs.push(`code 必须是数组`);
  }
  return errs;
}

// 校验 code 路径是否真实存在。返回 {missing: [...], feature}。
export function checkCodePaths(f, root = REPO_ROOT) {
  const missing = [];
  for (const p of f.code || []) {
    if (!existsSync(join(root, p))) missing.push(p);
  }
  return missing;
}
