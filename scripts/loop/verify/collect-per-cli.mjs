// scripts/loop/verify/collect-per-cli.mjs
// 验证采集 per-CLI：对每个本机已装、可采集的 CLI，断言 `ymesh sessions --source <X>` 可查（返回合法 JSON）。
// 产出 tasks/loops/reports/collect-per-cli.md 矩阵（含"无 session / 需登录"等情形）。
// exit 0 = 全部可查；exit 1 = 有查询报错。
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const REPORT_DIR = join(REPO, 'tasks', 'loops', 'reports');
mkdirSync(REPORT_DIR, { recursive: true });

// C 级仅发现 / 仅挂载占位 —— 不采集，查询无意义，跳过并记录
const NO_COLLECT = new Set(['chatgpt', 'cursor', 'trae', 'trae-cn']);

let installed = [];
try {
  installed = JSON.parse(execSync(`ymesh mcp call agents '{"installed_only":true}'`, { encoding: 'utf-8' })).agents || [];
} catch (e) {
  console.error('无法获取已装 agents:', e.message);
  process.exit(1);
}

const rows = [];
let errors = 0;
for (const a of installed) {
  const id = a.id;
  if (NO_COLLECT.has(id)) { rows.push(`| ${id} | — | 跳过：C 级/仅挂载，不采集 |`); continue; }
  try {
    const out = execSync(`ymesh sessions --source ${id} --include-archived --json`, { encoding: 'utf-8', timeout: 30000 });
    const n = (JSON.parse(out).sessions || []).length;
    rows.push(n > 0 ? `| ${id} | ✅ 可查 | ${n} 条 session |` : `| ${id} | ⚠ 可查但无数据 | 0 条（该 CLI 本机未产生 session，或需登录） |`);
  } catch (e) {
    errors++;
    rows.push(`| ${id} | ❌ 查询报错 | ${String(e.message).slice(0, 60)} |`);
  }
}
const md = ['# 采集 per-CLI 验证矩阵', '', '生成于 loop:verify-collect-per-cli。', '', '| CLI | 查询 | 结果 |', '|---|---|---|', ...rows, '', `查询报错数：${errors}`].join('\n');
writeFileSync(join(REPORT_DIR, 'collect-per-cli.md'), md);
console.log(md);
process.exit(errors > 0 ? 1 : 0);
