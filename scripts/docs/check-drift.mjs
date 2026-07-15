// scripts/docs/check-drift.mjs
//
// Drift detector: regenerate all auto-generated doc pages and verify the
// committed versions match. If anything changed, fail with a hint.
//
// Run:  node scripts/docs/check-drift.mjs
// CI:   .github/workflows/docs-check.yml runs this on every PR.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

// 1. Re-run sync.
const syncResult = spawnSync('node', [join(__dirname, 'sync-all.mjs')], {
  stdio: 'inherit',
  cwd: repoRoot,
  env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
});
if (syncResult.status !== 0) {
  console.error('[check-drift] sync-all failed; cannot verify drift');
  process.exit(1);
}

// 2. Check git diff for the auto-generated files only.
const targets = [
  'site/reference/cli.md',
  'site/zh/reference/cli.md',
  'site/reference/adapters.md',
  'site/zh/reference/adapters.md',
];
const diff = spawnSync('git', ['diff', '--stat', '--', ...targets], {
  cwd: repoRoot,
  encoding: 'utf-8',
});

if (diff.status !== 0) {
  console.error('[check-drift] git diff failed');
  process.exit(1);
}

if (diff.stdout.trim() === '') {
  console.log('[check-drift] no drift; auto-generated docs are up to date.');
  process.exit(0);
}

console.error('[check-drift] DRIFT DETECTED — auto-generated docs are out of sync with source.');
console.error('');
console.error(diff.stdout);
console.error('Run `npm run sync` in `site/` and commit the result, then push again.');
process.exit(1);
