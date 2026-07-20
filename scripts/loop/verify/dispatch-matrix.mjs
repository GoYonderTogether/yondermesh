// scripts/loop/verify/dispatch-matrix.mjs
// 调研每个已装、可 trigger 的 CLI 的 send 投递 + 回话完整性，产出双向能力矩阵。
// 覆盖：cli-spawn / http-api / ws-rpc / tmux / applescript 各通道。
// 矩阵产出即 exit 0（个别 CLI 失败是调研结果——揭示哪些只能单向/需登录——不是本 loop 失败）。
//
// 并行执行所有 CLI 的 send（每个最多 60s），把顺序 4–5 分钟压到 ~1 分钟，
// 避免 scan.mjs 的 5 分钟 execSync 超时。判断条件不变：矩阵产出即 exit 0。
import { execSync, execFile } from 'node:child_process';
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

// 单个 CLI 的 send 投递（并行执行单元）。超时/失败都 resolve，不 reject，
// 让 Promise.all 等到全部完成再统一汇总——个别失败是调研结果，不影响 exit code。
function sendOne(id) {
  return new Promise((resolve) => {
    execFile(
      'ymesh',
      ['send', '--cli', id, '--mode', 'new', '--message', '只回复两个字符: ok', '--json'],
      { encoding: 'utf-8', timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ id, error: String(err.message).slice(0, 50) });
          return;
        }
        try {
          resolve({ id, result: JSON.parse(stdout) });
        } catch (e) {
          resolve({ id, error: String(e.message).slice(0, 50) });
        }
      },
    );
  });
}

const promises = installed.map((a) => {
  const id = a.id;
  if (NO_TRIGGER.has(id)) return Promise.resolve({ id, skipped: true });
  return sendOne(id);
});

const results = await Promise.all(promises);

const rows = [];
let covered = 0;
let bidirectional = 0;   // delivered && response 非空 —— 真正调用 agent 并拿到回复
let oneWay = 0;          // delivered 但 response 空 —— 仅投递（可能是 GUI 自动化读不到回复，或只创建了内存文件未真正调用 agent）
let failed = 0;          // 投递失败
for (const r of results) {
  if (r.skipped) {
    rows.push(`| ${r.id} | — | 跳过：无 trigger 通道 | — | — |`);
    continue;
  }
  covered++;
  if (r.error) {
    failed++;
    rows.push(`| ${r.id} | ? | ❌ 失败 | — | ${r.error} |`);
    continue;
  }
  const delivered = !!r.result.delivered;
  const reply = (r.result.response || '').trim().length > 0;
  if (delivered && reply) bidirectional++;
  else if (delivered) oneWay++;
  else failed++;
  // 双向 = delivered && response 非空（真正调用 agent 并拿到回复）
  // 单向 = delivered 但 response 空（仅投递；可能是 GUI 自动化读不到 Electron 回复，
  //        也可能是焦点在编辑器导致 Cmd+V 粘到 Untitled 缓冲区未真正调用 agent）
  const bidirMark = (delivered && reply) ? '✅双向' : (delivered ? '⚠️单向' : '❌无');
  rows.push(`| ${r.id} | ${r.result.channel || '?'} | ${delivered ? '✅已投递' : '❌未投递'} | ${reply ? '✅有回复' : '⚠️无回复/读不到'} | ${bidirMark} |`);
}

const md = [
  '# 跨 agent 派发能力矩阵',
  '',
  '生成于 loop:verify-dispatch-matrix。揭示每个 CLI 的投递与回话能力（双向 vs 单向 vs 需登录）。',
  '',
  '**双向** = delivered && response 非空（真正调用 agent 并拿到回复）。',
  '**单向** = delivered 但 response 空（仅投递；可能是 GUI 自动化读不到 Electron 回复，也可能是焦点在编辑器导致 Cmd+V 粘到 Untitled 缓冲区未真正调用 agent）。',
  '',
  '| CLI | 通道 | 投递 | 回话 | 双向 |',
  '|---|---|---|---|---|',
  ...rows,
  '',
  `覆盖：${covered} 个可 trigger CLI（双向 ${bidirectional} / 单向 ${oneWay} / 失败 ${failed}）`,
].join('\n');
writeFileSync(join(REPORT_DIR, 'dispatch-matrix.md'), md);
console.log(md);
process.exit(0);
