// scripts/loop/scan.mjs
//
// 跑某个 loop 的 verifier 命令，据 exit code 回写 status（passed/failed）+ last_run。
// 若 passed 且 feature 关联，把 docs/features.yaml 对应 feature 置 shipped，并跑 check-features 校验。
// draft 状态不跑（卡人工审核）。
//
// Run:  node scripts/loop/scan.mjs <id|all>

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadLoop, saveLoop, listLoops, nowStamp, REPO_ROOT } from './loop-lib.mjs';

const FEATURES_YAML = join(REPO_ROOT, 'docs', 'features.yaml');

function runVerifier(cmd) {
  // execSync 在非零 exit 时抛错；捕获 stdout/stderr
  try {
    const out = execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 5 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.slice(-2000) };
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    return { ok: false, out: String(out).slice(-2000) };
  }
}

function setFeatureShipped(featureId) {
  if (!featureId || !existsSync(FEATURES_YAML)) return { changed: false };
  const text = readFileSync(FEATURES_YAML, 'utf-8');
  const lines = text.split('\n');
  let inBlock = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const idMatch = lines[i].match(/^\s*-\s+id:\s*(.+?)\s*$/);
    if (idMatch) {
      inBlock = idMatch[1] === featureId;
      continue;
    }
    if (inBlock && /^\s*status:\s*/.test(lines[i])) {
      const cur = lines[i].replace(/^\s*status:\s*/, '').trim();
      if (cur !== 'shipped') {
        const indent = lines[i].match(/^(\s*)/)[1];
        lines[i] = `${indent}status: shipped`;
        changed = true;
      }
    }
  }
  if (changed) writeFileSync(FEATURES_YAML, lines.join('\n'), 'utf-8');
  return { changed };
}

function scanOne(id) {
  let loop;
  try {
    loop = loadLoop(id);
  } catch (e) {
    console.error(`[scan] ${id}: ${e.message}`);
    return;
  }

  if (loop.status === 'draft') {
    console.log(`[scan] ${id}: 状态为 draft，需先人工审核改为 approved 再跑。`);
    return;
  }
  if (!loop.verifier) {
    console.error(`[scan] ${id}: 未设 verifier，无法判定完成。`);
    return;
  }

  console.log(`[scan] ${id}: 跑 verifier → ${loop.verifier}`);
  loop.status = 'running';
  loop.last_run = nowStamp();
  saveLoop(loop);

  const { ok, out } = runVerifier(loop.verifier);
  loop = loadLoop(id); // 重读以防 running 被外部改
  loop.status = ok ? 'passed' : 'failed';
  loop.last_run = nowStamp();
  saveLoop(loop);
  console.log(`[scan] ${id}: ${ok ? '✓ PASSED' : '✗ FAILED'}`);
  if (!ok) console.log(out.split('\n').slice(-15).join('\n'));

  if (ok && loop.feature) {
    const { changed } = setFeatureShipped(loop.feature);
    if (changed) {
      console.log(`[scan] ${id}: features.yaml 的 '${loop.feature}' → shipped`);
      // 校验 features.yaml 仍合法
      try {
        execSync('node scripts/docs/check-features.mjs', { cwd: REPO_ROOT, stdio: 'inherit' });
      } catch {
        console.error(`[scan] ${id}: ⚠ features.yaml 校验失败，请人工查`);
      }
    }
  }
}

const target = process.argv[2] || 'all';
if (target === 'all') {
  for (const l of listLoops()) scanOne(l.id);
} else {
  scanOne(target);
}
