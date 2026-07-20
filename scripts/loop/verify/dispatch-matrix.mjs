// scripts/loop/verify/dispatch-matrix.mjs
// 调研每个已装、可 trigger 的 CLI 的 send 投递 + 回话完整性，产出双向能力矩阵。
// 覆盖：cli-spawn / http-api / ws-rpc / tmux / applescript 各通道。
// 矩阵产出即 exit 0（个别 CLI 失败是调研结果——揭示哪些只能单向/需登录——不是本 loop 失败）。
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const REPORT_DIR = join(REPO, 'tasks', 'loops', 'reports');
mkdirSync(REPORT_DIR, { recursive: true });

// 无 trigger 通道的 —— send 会直接拒绝，跳过并记录
const NO_TRIGGER = new Set(['cass', 'omp', 'gsd-pi', 'cursor', 'trae', 'trae-cn']);

let installed = [];
try {
  installed = JSON.parse(execSync(`ymesh mcp call agents '{"installed_only":true}'`, { encoding: 'utf-8' })).agents || [];
} catch (e) { console.error(e.message); process.exit(1); }

const rows = [];
let covered = 0;
for (const a of installed) {
  const id = a.id;
  if (NO_TRIGGER.has(id)) { rows.push(`| ${id} | — | 跳过：无 trigger 通道 | — |`); continue; }
  covered++;
  try {
    const r = JSON.parse(execSync(`ymesh send --cli ${id} --mode new --message "只回复两个字符: ok" --json`, { encoding: 'utf-8', timeout: 60000 }));
    const delivered = !!r.delivered;
    const reply = (r.response || '').trim().length > 0;
    rows.push(`| ${id} | ${r.channel || '?'} | ${delivered ? '✅已投递' : '❌未投递'} | ${reply ? '✅有回复' : '⚠️无回复/读不到'} |`);
  } catch (e) {
    rows.push(`| ${id} | ? | ❌ 失败 | ${String(e.message).slice(0, 50)} |`);
  }
}
const md = ['# 跨 agent 派发能力矩阵', '', '生成于 loop:verify-dispatch-matrix。揭示每个 CLI 的投递与回话能力（双向 vs 单向 vs 需登录）。', '', '| CLI | 通道 | 投递 | 回话 |', '|---|---|---|---|', ...rows, '', `覆盖：${covered} 个可 trigger CLI`].join('\n');
writeFileSync(join(REPORT_DIR, 'dispatch-matrix.md'), md);
console.log(md);
process.exit(0);
