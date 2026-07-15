// scripts/docs/gen-adapters.mjs
//
// Generate site/reference/adapters.md and site/zh/reference/adapters.md from
// the CLI adapter directories under src/. Each adapter folder (claude, codex,
// aider, ...) becomes one row in the support matrix; we detect coverage level
// (A = native importer, B = markdown/wrapper importer, C = extractor-only) by
// the files present.
//
// Run:  node scripts/docs/gen-adapters.mjs
// CI:   invoked by sync-all.mjs; check-drift.mjs asserts no diff after re-run.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const srcDir = join(repoRoot, 'src');
const siteRoot = join(repoRoot, 'site');

// Skip these src/ subdirs — they are not CLI adapters.
const NON_ADAPTER_DIRS = new Set([
  'bin', 'daemon', 'mcp', 'mount', 'store', 'install', 'extract', 'briefing',
  'sync', 'limited', 'factory', 'index.ts',
]);

// Coverage level rules:
//   A — native importer (Importer class reading native session files)
//   B — markdown / wrapper importer (parse exported md, git log, etc.)
//   C — extractor only (no full import; partial coverage)
//   ? — unknown / unread
function classifyAdapter(name, files) {
  const has = (f) => files.includes(f);
  if (has('importer.ts') && has('index.ts')) return 'A';
  if (has('extractor.ts') && !has('importer.ts')) return 'C';
  if (has('wrapper.ts') || has('inject.ts')) return 'B';
  if (has('importer.ts')) return 'A';
  return '?';
}

function extractAdapterSummary(name, files) {
  // Try to read the index.ts header comment for a one-line summary.
  const indexPath = join(srcDir, name, 'index.ts');
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
  const entries = readdirSync(srcDir, { withFileTypes: true });
  const adapters = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (NON_ADAPTER_DIRS.has(e.name)) continue;
    const dir = join(srcDir, e.name);
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    if (!files.some((f) => f.endsWith('.ts'))) continue;
    const level = classifyAdapter(e.name, files);
    const summary = extractAdapterSummary(e.name, files);
    adapters.push({ name: e.name, level, files, summary });
  }
  // Stable ordering: A first, then B, then C, then ?, alphabetical within.
  const order = { A: 0, B: 1, C: 2, '?': 3 };
  adapters.sort((a, b) => (order[a.level] - order[b.level]) || a.name.localeCompare(b.name));
  return adapters;
}

function renderEn(adapters) {
  const out = [];
  out.push('---');
  out.push('title: CLI Adapters');
  out.push('description: Support matrix for CLI agents that yondermesh can harvest sessions from.');
  out.push('outline: [2, 3]');
  out.push('---');
  out.push('');
  out.push('> **Auto-generated** from `src/*/`. Do not edit by hand — run `npm run sync` in `site/` to regenerate.');
  out.push('');
  out.push('yondermesh reads native session formats from each supported CLI agent. Coverage levels:');
  out.push('');
  out.push('- **A** — Native importer: reads the CLI\'s native session files (JSONL / session DB) directly');
  out.push('- **B** — Wrapper / markdown importer: parses exported markdown, git log, or wrapper output');
  out.push('- **C** — Extractor only: partial coverage (e.g. live transcript hook); no full historical import yet');
  out.push('');
  out.push('## Support Matrix');
  out.push('');
  out.push('| CLI | Coverage | Adapter dir | Notes |');
  out.push('|---|---|---|---|');
  for (const a of adapters) {
    const notes = a.summary || '—';
    out.push(`| \`${a.name}\` | ${a.level} | [\`src/${a.name}/\`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/${a.name}) | ${notes} |`);
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

function renderZh(adapters) {
  const out = [];
  out.push('---');
  out.push('title: CLI 适配器');
  out.push('description: yondermesh 可采集 session 的 CLI agent 支持矩阵。');
  out.push('outline: [2, 3]');
  out.push('---');
  out.push('');
  out.push('> **自动生成** 自 `src/*/`，请勿手动编辑 — 在 `site/` 目录运行 `npm run sync` 重新生成。');
  out.push('');
  out.push('yondermesh 直接读取各 CLI agent 的原生 session 格式。覆盖等级：');
  out.push('');
  out.push('- **A** — 原生 importer：直接读取 CLI 原生 session 文件（JSONL / session DB）');
  out.push('- **B** — Wrapper / markdown importer：解析导出的 markdown、git log 或 wrapper 输出');
  out.push('- **C** — 仅 extractor：部分覆盖（如实时 transcript hook），尚未支持完整历史导入');
  out.push('');
  out.push('## 支持矩阵');
  out.push('');
  out.push('| CLI | 覆盖等级 | 适配器目录 | 说明 |');
  out.push('|---|---|---|---|');
  for (const a of adapters) {
    const notes = a.summary || '—';
    out.push(`| \`${a.name}\` | ${a.level} | [\`src/${a.name}/\`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/${a.name}) | ${notes} |`);
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
const enPath = join(siteRoot, 'reference', 'adapters.md');
const zhPath = join(siteRoot, 'zh', 'reference', 'adapters.md');
mkdirSync(dirname(enPath), { recursive: true });
mkdirSync(dirname(zhPath), { recursive: true });
writeFileSync(enPath, renderEn(adapters), 'utf-8');
writeFileSync(zhPath, renderZh(adapters), 'utf-8');

console.log(`[gen-adapters] wrote ${enPath.replace(repoRoot + '/', '')}`);
console.log(`[gen-adapters] wrote ${zhPath.replace(repoRoot + '/', '')}`);
console.log(`[gen-adapters] ${adapters.length} adapters: A=${adapters.filter(a => a.level === 'A').length} B=${adapters.filter(a => a.level === 'B').length} C=${adapters.filter(a => a.level === 'C').length} ?=${adapters.filter(a => a.level === '?').length}`);
