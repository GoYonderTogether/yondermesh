// scripts/loop/verify/dispatch-matrix.mjs
// 调研每个已装、可 trigger 的 CLI 的 send 投递 + 回话完整性，产出双向能力矩阵。
// 覆盖：cli-spawn / http-api / ws-rpc / tmux / applescript 各通道。
// 矩阵产出即 exit 0（个别 CLI 失败是调研结果——揭示哪些只能单向/需登录——不是本 loop 失败）。
//
// 并发：限制为 4（默认 Promise.all 全开 25 进程时 SQLite 审计写会撞锁，导致
// 本可工作的 CLI（antigravity/vibe/hermes）假性失败）。4 并发把总时长压在
// 2–3 分钟内，仍在 scan.mjs 的 5 分钟 execSync 超时内。
//
// 分类（替代原"失败/单向/双向"两分法）：
//   - 跳过：未安装   （which <bin> 找不到 / IDE .app 不存在）—— 不算失败
//   - 双向           （delivered && response 非空）
//   - 单向           （delivered && response 空）
//   - 需登录/配置    （delivered=false 且 error/exitCode 命中认证模式）—— 揭示原因，不算硬失败
//   - 失败           （delivered=false 且非以上）—— 真正需要修的
import { execFile, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const REPORT_DIR = join(REPO, 'tasks', 'loops', 'reports');
mkdirSync(REPORT_DIR, { recursive: true });

// 无 trigger 通道的 —— send 会直接拒绝，跳过并记录
const NO_TRIGGER = new Set(['cass', 'omp', 'gsd-pi', 'cursor', 'trae', 'trae-cn']);

// ─── BIN_MAP / IDE_APP_NAME（与 src/trigger/adapter.ts 同步）──────────────────
// 用途：在 send 前预检 which <bin>，未安装的 CLI 直接跳过（不算失败）。
// 注意：这是 trigger adapter BIN_MAP 的镜像——adapter.ts 是 SSOT，这里只复制
// 必要字段做预检。新增 CLI 时两处都要改（adapter 改完 sync 这里）。
const BIN_MAP = {
  'claude-code': 'claude', 'claude': 'claude', 'codex': 'codex', 'hermes': 'hermes',
  'gemini': 'gemini', 'goose': 'goose', 'aider': 'aider', 'amp': 'amp',
  'factory': 'droid', 'vibe': 'vibe', 'codebuddy': 'cbc', 'trae-cli': 'trae-cli',
  'trae-ide': 'trae', 'opencode': 'opencode', 'qwen': 'qwen', 'openhands': 'openhands',
  'kimi': 'kimi', 'openclaw': 'openclaw', 'pi': 'pi', 'copilot': 'copilot',
  'crush': 'crush', 'cline': 'cline', 'continue': 'cn', 'antigravity': 'agy',
  'windsurf': 'windsurf', 'cursor-ide': 'cursor', 'chatgpt': 'chatgpt',
};

// IDE 类 CLI（不能 which <bin>，要看 .app 是否存在）
const IDE_CLIS = new Set(['trae-ide', 'windsurf', 'cursor-ide', 'chatgpt']);
const IDE_APP_NAME = {
  'trae-ide': 'Trae', 'windsurf': 'Windsurf', 'cursor-ide': 'Cursor', 'chatgpt': 'ChatGPT',
};

// ─── 认证/配置失败模式（从实测 stderr 归纳）──────────────────────────────────
// 命中即归为"需登录/配置"，不算硬失败（CLI 本身工作，只是没配好凭据）。
const AUTH_PATTERNS = [
  /authentic/i, /\blogin\b|\blog in\b/i, /api[_ -]?key/i, /\bcredits?\b/i,
  /\bdeposit\b/i, /auth[_ -]?type/i, /\bprovider[s]?\b.*config/i,
  /not.*logged/i, /log in using/i, /out of credits/i,
  /config:.*null|expected object, received null/i,  // continue: ~/.continue/config.json
  /no providers configured/i,                       // crush
  /policy/i,                                          // copilot: org policy
  /gateway.*failed|gateway closed/i,                 // openclaw: gateway
  /manual authorization/i,                            // gemini
  /认证失败|模型未配置|未配置/i,                        // kimi 等 CLI 的中文认证错误
];

// ─── 能力缺失模式（CLI 本身不支持 --mode new，不是代码 bug）──────────────────
// 命中即归为"能力缺失（跳过）"，不算失败。
const NO_NEW_MODE_RE = /不支持.*new.*模式|不支持.*new.*mode/i;

/** which <bin> —— 不可达返回 false */
function binInstalled(bin) {
  try {
    const r = spawnSync('which', [bin], { encoding: 'utf-8', timeout: 2000 });
    return r.status === 0 && (r.stdout ?? '').trim().length > 0;
  } catch {
    return false;
  }
}

/** IDE 类：看 .app 是否存在；fallback 看 which <bin> */
function ideInstalled(cli) {
  const appName = IDE_APP_NAME[cli];
  if (appName && process.platform === 'darwin') {
    const paths = [
      `/Applications/${appName}.app`,
      `${process.env.HOME ?? ''}/Applications/${appName}.app`,
    ];
    if (paths.some((p) => p && existsSync(p))) return true;
  }
  const bin = BIN_MAP[cli];
  return bin ? binInstalled(bin) : false;
}

/** 预检 CLI 是否安装 */
function isInstalled(id) {
  if (IDE_CLIS.has(id)) return ideInstalled(id);
  const bin = BIN_MAP[id];
  return bin ? binInstalled(bin) : false;
}

// ─── 并发池（concurrency=4）────────────────────────────────────────────────
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runOne);
  await Promise.all(workers);
  return results;
}

// 直接用 repo 的 dist/bin/ymesh.js（而非安装的 ymesh 符号链接到 release），
// 确保对 src/bin/ymesh.ts 的修改在 build 后即时生效，无需更新 release。
const YMESH_BIN = process.env.YMESH_BIN || 'node';
const YMESH_ARGS_PREFIX = process.env.YMESH_BIN
  ? []
  : [join(REPO, 'dist', 'bin', 'ymesh.js')];

// ─── 单个 CLI 的 send 投递 ─────────────────────────────────────────────────
// 带"database is locked"重试：在有 ymesh mcp 长跑时，SQLite 审计写会撞锁。
// cmdSend 已设 busy_timeout=5s，但若锁仍被持有超过 5s，send 抛错并输出 JSON
// error。重试 3 次 × 2s 退避，给 mcp server 短暂释放锁的窗口。
function sendOnceRaw(id) {
  return new Promise((resolve) => {
    // ymesh send 内部用 --timeout 控制 trigger 超时；execFile 的 timeout 给
    // 整个 ymesh 进程兜底（含 SQLite 审计写）。30s trigger + 20s 缓冲。
    // 总时长预算：25 CLI / 4 并发 × ~35s ≈ 220s，留余量在 scan.mjs 5 分钟内。
    execFile(
      YMESH_BIN,
      [...YMESH_ARGS_PREFIX, 'send', '--cli', id, '--mode', 'new', '--message', '只回复两个字符: ok',
       '--json', '--timeout', '30000'],
      { encoding: 'utf-8', timeout: 50000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        // execFile 在 exit code != 0 时返回 err，但 ymesh --json 即使 delivered=false
        // 也会先打印 JSON 再 exit 2。优先从 stdout 恢复 JSON，丢掉 err.message。
        if (stdout) {
          const m = stdout.match(/\{[\s\S]*\}/);
          if (m) {
            try {
              resolve({ id, result: JSON.parse(m[0]) });
              return;
            } catch { /* fallthrough */ }
          }
        }
        if (err) {
          // 真正没产出 JSON：execFile 超时 / spawn 失败 / 进程被杀 / SQLite 锁
          const reason = err.killed
            ? `超时被杀（${err.signal ?? 'SIGTERM'}）`
            : String(err.message).split('\n')[0].slice(0, 100);
          resolve({ id, error: reason, stderr: err.stderr ? String(err.stderr).slice(0, 300) : '' });
          return;
        }
        resolve({ id, error: 'no JSON output' });
      },
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 包装 sendOnceRaw 加重试：SQLite locked / 超时被杀 都重试
 *  检测锁的两个来源：
 *    1. sendOnceRaw 返回 error（无 JSON 输出，旧 ymesh 二进制场景）
 *    2. sendOnceRaw 返回 result 但 result.error 含 "database is locked"
 *       （新 ymesh 二进制在 cmdSend catch 中输出 JSON error 的场景） */
async function sendOne(id) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await sendOnceRaw(id);
    // 检测锁错误（两个来源都要查）
    const lockHit =
      /database is locked|SQLITE_BUSY/i.test(last.error || '') ||
      /database is locked|SQLITE_BUSY/i.test(last.stderr || '') ||
      /database is locked|SQLITE_BUSY/i.test(last.result?.error || '');
    const killed = /被杀|SIGTERM/i.test(last.error || '');
    if (!lockHit && !killed) return last;  // 非锁错误或成功 → 返回
    if (attempt < 2) await sleep(2000 * (attempt + 1));  // 2s, 4s 退避
  }
  // 3 次都失败：返回最后一次（去掉 stderr 字段，让上层分类正常工作）
  const { id: _id, error, result, stderr: _stderr } = last;
  return { id, error, result };
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

// 直接遍历 BIN_MAP 的所有 CLI（不依赖 `ymesh mcp call agents`——后者调用 cass
// 元扫描器，在有 6 个 ymesh mcp 长跑时 SQLite 撞锁会卡 8+ 分钟）。
// isInstalled() 已经做 which/ls 预检，未装的会标"跳过：未安装"。
const cliIds = Object.keys(BIN_MAP);

// 预检：把 installed 但 binary/app 不存在的直接标跳过
const tasks = cliIds.map((id) => {
  if (NO_TRIGGER.has(id)) return Promise.resolve({ id, skipped: 'no_trigger' });
  if (!isInstalled(id)) return Promise.resolve({ id, skipped: 'not_installed' });
  return sendOne(id);
});

const results = await runPool(tasks, 4, (t) => t);

// ─── 分类汇总 ──────────────────────────────────────────────────────────────
const rows = [];
let covered = 0;
let bidirectional = 0;
let oneWay = 0;
let authNeeded = 0;
let failed = 0;
let skipped = 0;

for (const r of results) {
  if (r.skipped) {
    skipped++;
    const reason = r.skipped === 'no_trigger' ? '无 trigger 通道' : '未安装（跳过）';
    rows.push(`| ${r.id} | — | 跳过：${reason} | — | — |`);
    continue;
  }
  covered++;
  // 有 JSON result 时优先用 result（含 delivered/response/error 等结构化字段）；
  // 仅在无 result（spawn 失败 / 超时被杀 / 无 JSON 输出）时用 r.error。
  if (!r.result) {
    failed++;
    rows.push(`| ${r.id} | ? | ❌ 失败 | — | ${r.error || '无输出'} |`);
    continue;
  }
  const d = r.result;
  const delivered = !!d.delivered;
  const reply = (d.response || '').trim().length > 0;
  if (delivered && reply) {
    bidirectional++;
    rows.push(`| ${r.id} | ${d.channel || '?'} | ✅已投递 | ✅有回复 | ✅双向 |`);
    continue;
  }
  if (delivered) {
    oneWay++;
    rows.push(`| ${r.id} | ${d.channel || '?'} | ✅已投递 | ⚠️无回复/读不到 | ⚠️单向 |`);
    continue;
  }
  // delivered=false：检查是否能力缺失（CLI 不支持 new 模式——不是代码 bug）
  const errMsg = String(d.error || '');
  if (NO_NEW_MODE_RE.test(errMsg)) {
    skipped++;
    rows.push(`| ${r.id} | ${d.channel || '?'} | ⏭️能力缺失 | — | 不支持 new 模式 |`);
    continue;
  }
  // 检查是否认证/配置问题
  const isAuth = AUTH_PATTERNS.some((p) => p.test(errMsg))
    || d.exitCode === 41   // gemini 的认证失败 exit code
    || d.exitCode === 4;   // 部分 CLI 的认证/退出码
  if (isAuth) {
    authNeeded++;
    const reason = errMsg.slice(0, 100) || `exit ${d.exitCode}`;
    rows.push(`| ${r.id} | ${d.channel || '?'} | 🔒需登录/配置 | — | ${reason} |`);
    continue;
  }
  failed++;
  const reason = errMsg.slice(0, 100) || `exit ${d.exitCode ?? '?'}`;
  rows.push(`| ${r.id} | ${d.channel || '?'} | ❌失败 | — | ${reason} |`);
}

const md = [
  '# 跨 agent 派发能力矩阵',
  '',
  '生成于 loop:verify-dispatch-matrix。揭示每个 CLI 的投递与回话能力（双向 / 单向 / 需登录 / 失败 / 跳过）。',
  '',
  '**双向** = delivered && response 非空（真正调用 agent 并拿到回复）。',
  '**单向** = delivered 但 response 空（仅投递；GUI 自动化读不到 Electron 回复，或焦点在编辑器导致 Cmd+V 粘到 Untitled 缓冲区未真正调用 agent）。',
  '**需登录/配置** = delivered=false 且 error 命中认证/配置模式（CLI 本身工作，只是没配凭据）。',
  '**能力缺失** = CLI 不支持 --mode new（不是代码 bug，是 CLI 自身能力限制，不算失败）。',
  '**跳过** = 无 trigger 通道，或 binary/IDE-app 未安装（不算失败）。',
  '',
  '| CLI | 通道 | 投递 | 回话 | 分类/原因 |',
  '|---|---|---|---|---|',
  ...rows,
  '',
  `覆盖：${covered} 个可 trigger CLI（双向 ${bidirectional} / 单向 ${oneWay} / 需登录 ${authNeeded} / 失败 ${failed}）+ 跳过 ${skipped}`,
].join('\n');
writeFileSync(join(REPORT_DIR, 'dispatch-matrix.md'), md);
console.log(md);
process.exit(0);
