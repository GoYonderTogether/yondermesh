// scripts/docs/sync-all.mjs
//
// Orchestrator: regenerate every auto-generated doc page from source.
// Currently runs:
//   - gen-cli-docs.mjs       (CLI reference from `ymesh help`)
//   - gen-adapters.mjs       (adapter matrix from src/*/)
//
// Add new generators here as the docs grow.
//
// Run:  node scripts/docs/sync-all.mjs
// CI:   check-drift.mjs asserts no diff after this runs.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = __dirname;

const generators = ['gen-cli-docs.mjs', 'gen-adapters.mjs'];

let failed = 0;
for (const gen of generators) {
  const path = join(scriptsDir, gen);
  const result = spawnSync('node', [path], {
    stdio: 'inherit',
    cwd: scriptsDir,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  if (result.status !== 0) {
    console.error(`[sync-all] ${gen} failed with exit ${result.status}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`[sync-all] ${failed}/${generators.length} generators failed`);
  process.exit(1);
}
console.log(`[sync-all] all ${generators.length} generators succeeded`);
