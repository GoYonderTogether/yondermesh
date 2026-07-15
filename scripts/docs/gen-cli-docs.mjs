// scripts/docs/gen-cli-docs.mjs
//
// Generate site/reference/cli.md and site/zh/reference/cli.md from `ymesh help`.
// The CLI surface is the canonical source of truth — the doc page is a rendered view.
//
// Run:  node scripts/docs/gen-cli-docs.mjs
// CI:   invoked by sync-all.mjs; check-drift.mjs asserts no diff after re-run.

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const siteRoot = join(repoRoot, 'site');

// Run `ymesh help` (or `npm run dev -- help` from repo root if ymesh isn't on PATH).
function runHelp() {
  const candidates = [
    ['ymesh', ['help']],
    ['npm', ['run', 'dev', '--', 'help', '--no-install']],
  ];
  for (const [cmd, args] of candidates) {
    try {
      const out = execSync([cmd, ...args].join(' '), {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 60_000,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      if (out && out.includes('yondermesh')) return out;
    } catch {
      // try next
    }
  }
  throw new Error('could not run `ymesh help` — is ymesh installed / npm dev available?');
}

// Escape angle brackets so VitePress/Vue template compiler doesn't treat
// <path>, <n>, <id>, ... placeholders as HTML tags inside markdown tables.
function escapeDesc(s) {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Parse the help output into structured sections.
function parseHelp(text) {
  const lines = text.split('\n');
  const commands = [];
  const sections = { commands: [], options: [], subFilters: [], examples: [] };
  let mode = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('命令:')) { mode = 'cmd'; continue; }
    if (line.startsWith('通用选项:')) { mode = 'opt'; continue; }
    if (line.startsWith('sessions 过滤选项:')) { mode = 'subfilter'; continue; }
    if (line.startsWith('extract 选项:')) { mode = 'subfilter'; continue; }
    if (line.startsWith('handoff 选项:')) { mode = 'subfilter'; continue; }
    if (line.startsWith('示例:')) { mode = 'example'; continue; }
    if (line.startsWith('安装方式:')) { mode = null; continue; }

    if (mode === 'cmd' && line.startsWith('  ')) {
      const m = line.match(/^\s{2,}(\S+)\s+(.*)$/);
      if (m) sections.commands.push({ name: m[1], desc: m[2].trim() });
    } else if (mode === 'opt' && line.startsWith('  ')) {
      const m = line.match(/^\s{2,}(--\S+)\s+(.*)$/);
      if (m) sections.options.push({ flag: m[1], desc: m[2].trim() });
    } else if (mode === 'subfilter' && line.startsWith('  ')) {
      const m = line.match(/^\s{2,}(--\S+)\s+(.*)$/);
      if (m) sections.subFilters.push({ flag: m[1], desc: m[2].trim() });
    } else if (mode === 'example' && line.startsWith('  ')) {
      sections.examples.push(line.trim());
    }
  }
  return sections;
}

function renderEn(parsed, version) {
  const out = [];
  out.push('---');
  out.push('title: CLI Commands');
  out.push('description: Complete reference for the ymesh CLI.');
  out.push('outline: [2, 3]');
  out.push('---');
  out.push('');
  out.push('> **Auto-generated** from `ymesh help`. Do not edit by hand — run `npm run sync` in `site/` to regenerate.');
  out.push(`> yondermesh version: \`${version}\``);
  out.push('');
  out.push('## Synopsis');
  out.push('');
  out.push('```bash');
  out.push('ymesh <command> [options]');
  out.push('ymesh <command> --json          # JSON output for scripts');
  out.push('ymesh <command> --db <path>     # override DB path');
  out.push('```');
  out.push('');
  out.push('## Commands');
  out.push('');
  out.push('| Command | Description |');
  out.push('|---|---|');
  for (const c of parsed.commands) {
    out.push(`| \`ymesh ${c.name}\` | ${escapeDesc(c.desc)} |`);
  }
  out.push('');
  out.push('## Global Options');
  out.push('');
  out.push('| Flag | Description |');
  out.push('|---|---|');
  for (const o of parsed.options) {
    out.push(`| \`${o.flag}\` | ${escapeDesc(o.desc)} |`);
  }
  out.push('');
  out.push('## Filter Options');
  out.push('');
  out.push('Used by `sessions`, `extract`, and `handoff`.');
  out.push('');
  out.push('| Flag | Description |');
  out.push('|---|---|');
  for (const f of parsed.subFilters) {
    out.push(`| \`${f.flag}\` | ${escapeDesc(f.desc)} |`);
  }
  out.push('');
  out.push('## Examples');
  out.push('');
  out.push('```bash');
  for (const e of parsed.examples) out.push(e);
  out.push('```');
  out.push('');
  return out.join('\n');
}

function renderZh(parsed, version) {
  const out = [];
  out.push('---');
  out.push('title: CLI 命令');
  out.push('description: ymesh CLI 完整命令参考。');
  out.push('outline: [2, 3]');
  out.push('---');
  out.push('');
  out.push('> **自动生成** 自 `ymesh help`，请勿手动编辑 — 在 `site/` 目录运行 `npm run sync` 重新生成。');
  out.push(`> yondermesh 版本：\`${version}\``);
  out.push('');
  out.push('## 用法');
  out.push('');
  out.push('```bash');
  out.push('ymesh <command> [options]');
  out.push('ymesh <command> --json          # 以 JSON 输出，便于脚本消费');
  out.push('ymesh <command> --db <path>     # 指定数据库路径');
  out.push('```');
  out.push('');
  out.push('## 命令');
  out.push('');
  out.push('| 命令 | 说明 |');
  out.push('|---|---|');
  for (const c of parsed.commands) {
    out.push(`| \`ymesh ${c.name}\` | ${escapeDesc(c.desc)} |`);
  }
  out.push('');
  out.push('## 通用选项');
  out.push('');
  out.push('| 参数 | 说明 |');
  out.push('|---|---|');
  for (const o of parsed.options) {
    out.push(`| \`${o.flag}\` | ${escapeDesc(o.desc)} |`);
  }
  out.push('');
  out.push('## 过滤选项');
  out.push('');
  out.push('用于 `sessions`、`extract`、`handoff` 命令。');
  out.push('');
  out.push('| 参数 | 说明 |');
  out.push('|---|---|');
  for (const f of parsed.subFilters) {
    out.push(`| \`${f.flag}\` | ${escapeDesc(f.desc)} |`);
  }
  out.push('');
  out.push('## 示例');
  out.push('');
  out.push('```bash');
  for (const e of parsed.examples) out.push(e);
  out.push('```');
  out.push('');
  return out.join('\n');
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
  return pkg.version;
}

// Top-level execution
const help = runHelp();
const parsed = parseHelp(help);
const version = readVersion();

const enPath = join(siteRoot, 'reference', 'cli.md');
const zhPath = join(siteRoot, 'zh', 'reference', 'cli.md');
mkdirSync(dirname(enPath), { recursive: true });
mkdirSync(dirname(zhPath), { recursive: true });
writeFileSync(enPath, renderEn(parsed, version), 'utf-8');
writeFileSync(zhPath, renderZh(parsed, version), 'utf-8');

console.log(`[gen-cli-docs] wrote ${enPath.replace(repoRoot + '/', '')}`);
console.log(`[gen-cli-docs] wrote ${zhPath.replace(repoRoot + '/', '')}`);
console.log(`[gen-cli-docs] ${parsed.commands.length} commands, ${parsed.options.length} global options, ${parsed.subFilters.length} filter options`);
