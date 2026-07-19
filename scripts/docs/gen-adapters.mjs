// scripts/docs/gen-adapters.mjs
//
// Generate site/reference/adapters.md and site/zh/reference/adapters.md from
// the SINGLE SOURCE OF TRUTH: src/adapters/registry.ts (ADAPTERS). Reading the
// registry (not scanning src/*/ directories) means internal modules like
// mcp/, sync/, sdk/ can never leak into the matrix, and every count (total /
// harvest / mount / send-reachable / coverage) is derived programmatically so
// it cannot drift from code.
//
// Run:  node scripts/docs/gen-adapters.mjs
// CI:   invoked by sync-all.mjs; check-drift.mjs asserts no diff after re-run.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const srcDir = join(repoRoot, 'src');
const siteRoot = join(repoRoot, 'site');

// Pull the registry via tsx (the registry is TypeScript; .mjs can't import it
// directly). We write a temp dumper module and run it with `tsx` — this avoids
// shell-escaping issues that break `tsx -e` on multi-line scripts. The loader
// function is stringified so we can recover the source directory
// (`() => import('../claude/index.js')` → `claude`).
function loadRegistry() {
  const dumperPath = join(__dirname, '.dump-adapters.mjs');
  const regUrl = 'file://' + join(srcDir, 'adapters', 'registry.ts').replace(/\\/g, '/');
  const dumper = [
    `import { ADAPTERS } from ${JSON.stringify(regUrl)};`,
    `const rows = ADAPTERS.map((a) => {`,
    `  const s = a.importerLoader ? String(a.importerLoader) : '';`,
    `  const m = s.match(/\\.\\.\\/([\\w-]+)\\/index/);`,
    `  return {`,
    `    id: a.id, displayName: a.displayName, coverage: a.coverage,`,
    `    dir: m ? m[1] : null, hasImporter: !!a.importerLoader,`,
    `    hasMount: Array.isArray(a.mountCapabilities) && a.mountCapabilities.length > 0,`,
    `    channels: Array.isArray(a.channels) ? a.channels : [],`,
    `  };`,
    `});`,
    `process.stdout.write(JSON.stringify(rows));`,
  ].join('\n');
  writeFileSync(dumperPath, dumper, 'utf-8');
  try {
    const out = execFileSync('npx', ['tsx', dumperPath], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    return JSON.parse(out);
  } finally {
    rmSync(dumperPath, { force: true });
  }
}

function extractAdapterSummary(dir) {
  if (!dir) return '';
  const indexPath = join(srcDir, dir, 'index.ts');
  if (!existsSync(indexPath)) return '';
  try {
    const text = readFileSync(indexPath, 'utf-8');
    const lines = text.split('\n').slice(0, 20);
    for (const raw of lines) {
      const m = raw.match(/^\s*(?:\/\/|\/\*+\s*)\s*(.+)$/);
      if (m && m[1].trim().length > 8 && !m[1].includes('Copyright') && !m[1].includes('@')) {
        return m[1].trim().replace(/^yondermesh\s*[-—:]\s*/, '');
      }
    }
  } catch {
    // ignore
  }
  return '';
}

function listAdapters() {
  const rows = loadRegistry();
  const adapters = rows.map((r) => ({
    name: r.id,
    dir: r.dir,
    level: r.coverage,
    sendReachable: r.channels.length > 0,
    channels: r.channels,
    hasMount: r.hasMount,
    hasImporter: r.hasImporter,
    summary: extractAdapterSummary(r.dir),
  }));
  // Stable ordering: A first, then B, then C, then ?, alphabetical within.
  const order = { A: 0, B: 1, C: 2, '?': 3 };
  adapters.sort((a, b) => (order[a.level] - order[b.level]) || a.name.localeCompare(b.name));
  return adapters;
}

// Canonical counts — the single place these numbers are computed for docs.
function computeCounts(adapters) {
  return {
    total: adapters.length,
    harvest: adapters.filter((a) => a.hasImporter).length,
    mount: adapters.filter((a) => a.hasMount).length,
    send: adapters.filter((a) => a.sendReachable).length,
    A: adapters.filter((a) => a.level === 'A').length,
    B: adapters.filter((a) => a.level === 'B').length,
    C: adapters.filter((a) => a.level === 'C').length,
  };
}

function renderEn(adapters, counts) {
  const out = [];
  out.push('---');
  out.push('title: CLI Adapters');
  out.push('description: Support matrix for CLI agents that yondermesh can harvest sessions from.');
  out.push('outline: [2, 3]');
  out.push('---');
  out.push('');
  out.push('> **Auto-generated** from `src/adapters/registry.ts`. Do not edit by hand — run `npm run sync` in `site/` to regenerate.');
  out.push('');
  out.push('## Coverage at a glance');
  out.push('');
  out.push('| Metric | Count | Meaning |');
  out.push('|---|---|---|');
  out.push(`| Registered | **${counts.total}** | Total CLI adapters in the registry |`);
  out.push(`| Harvest | **${counts.harvest}** | Have a session importer (\`ymesh scan\`) |`);
  out.push(`| Mountable | **${counts.mount}** | Can receive MCP / skill / plugin mounts |`);
  out.push(`| Send-reachable | **${counts.send}** | Reachable by synchronous \`send\` (non-empty trigger channels) |`);
  out.push(`| Coverage A / B / C | **${counts.A} / ${counts.B} / ${counts.C}** | Native / wrapper / extractor-only |`);
  out.push('');
  out.push('Coverage levels:');
  out.push('');
  out.push('- **A** — Native importer: reads the CLI\'s native session files (JSONL / session DB) directly');
  out.push('- **B** — Wrapper / markdown importer: parses exported markdown, git log, or wrapper output');
  out.push('- **C** — Extractor only: partial coverage (e.g. live transcript hook); no full historical import yet');
  out.push('');
  out.push('## Support Matrix');
  out.push('');
  out.push('| CLI | Coverage | Send | Adapter dir | Notes |');
  out.push('|---|---|---|---|---|');
  for (const a of adapters) {
    const notes = a.summary || '—';
    const send = a.sendReachable ? '✅' : '—';
    const dirCell = a.dir
      ? `[\`src/${a.dir}/\`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/${a.dir})`
      : '—';
    out.push(`| \`${a.name}\` | ${a.level} | ${send} | ${dirCell} | ${notes} |`);
  }
  out.push('');
  out.push('## Adding a New Adapter');
  out.push('');
  out.push('1. Create `src/<cli-name>/` with `index.ts` exporting an `Importer` class.');
  out.push('2. Add the adapter to `src/bin/ymesh.ts` `cmdScan()` so `ymesh scan` invokes it.');
  out.push('3. Re-run `npm run sync` in `site/` — this page updates automatically.');
  out.push('4. Run `npm run check-drift` in `site/` to verify no other docs drifted.');
  out.push('');
  return out.join('\n');
}

function renderZh(adapters, counts) {
  const out = [];
  out.push('---');
  out.push('title: CLI 适配器');
  out.push('description: yondermesh 可采集 session 的 CLI agent 支持矩阵。');
  out.push('outline: [2, 3]');
  out.push('---');
  out.push('');
  out.push('> **自动生成** 自 `src/adapters/registry.ts`，请勿手动编辑 — 在 `site/` 目录运行 `npm run sync` 重新生成。');
  out.push('');
  out.push('## 覆盖概览');
  out.push('');
  out.push('| 口径 | 数量 | 含义 |');
  out.push('|---|---|---|');
  out.push(`| 注册总数 | **${counts.total}** | 注册表中的 CLI 适配器总数 |`);
  out.push(`| 采集 | **${counts.harvest}** | 有 session importer（\`ymesh scan\`）|`);
  out.push(`| 可挂载 | **${counts.mount}** | 可接收 MCP / skill / plugin 挂载 |`);
  out.push(`| send 可达 | **${counts.send}** | 可被同步 \`send\` 触达（有非空触发通道）|`);
  out.push(`| 覆盖 A / B / C | **${counts.A} / ${counts.B} / ${counts.C}** | 原生 / wrapper / 仅 extractor |`);
  out.push('');
  out.push('覆盖等级：');
  out.push('');
  out.push('- **A** — 原生 importer：直接读取 CLI 原生 session 文件（JSONL / session DB）');
  out.push('- **B** — Wrapper / markdown importer：解析导出的 markdown、git log 或 wrapper 输出');
  out.push('- **C** — 仅 extractor：部分覆盖（如实时 transcript hook），尚未支持完整历史导入');
  out.push('');
  out.push('## 支持矩阵');
  out.push('');
  out.push('| CLI | 覆盖等级 | send | 适配器目录 | 说明 |');
  out.push('|---|---|---|---|---|');
  for (const a of adapters) {
    const notes = a.summary || '—';
    const send = a.sendReachable ? '✅' : '—';
    const dirCell = a.dir
      ? `[\`src/${a.dir}/\`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/${a.dir})`
      : '—';
    out.push(`| \`${a.name}\` | ${a.level} | ${send} | ${dirCell} | ${notes} |`);
  }
  out.push('');
  out.push('## 新增适配器');
  out.push('');
  out.push('1. 新建 `src/<cli-name>/`，包含 `index.ts` 导出 `Importer` 类。');
  out.push('2. 在 `src/bin/ymesh.ts` 的 `cmdScan()` 中注册，让 `ymesh scan` 调用它。');
  out.push('3. 在 `site/` 目录运行 `npm run sync` —— 本页会自动更新。');
  out.push('4. 在 `site/` 目录运行 `npm run check-drift` 验证其他文档无漂移。');
  out.push('');
  return out.join('\n');
}

const adapters = listAdapters();
const counts = computeCounts(adapters);
const enPath = join(siteRoot, 'reference', 'adapters.md');
const zhPath = join(siteRoot, 'zh', 'reference', 'adapters.md');
mkdirSync(dirname(enPath), { recursive: true });
mkdirSync(dirname(zhPath), { recursive: true });
writeFileSync(enPath, renderEn(adapters, counts), 'utf-8');
writeFileSync(zhPath, renderZh(adapters, counts), 'utf-8');

console.log(`[gen-adapters] wrote ${enPath.replace(repoRoot + '/', '')}`);
console.log(`[gen-adapters] wrote ${zhPath.replace(repoRoot + '/', '')}`);
console.log(`[gen-adapters] total=${counts.total} harvest=${counts.harvest} mount=${counts.mount} send=${counts.send} | A=${counts.A} B=${counts.B} C=${counts.C}`);
