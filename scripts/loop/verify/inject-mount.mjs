// scripts/loop/verify/inject-mount.mjs
// 验证 MCP 挂载面不变式：
//   1. agents {include_mounts:true} 返回非空（已装 CLI > 0）
//   2. ymesh mount status exit 0
//   3. 至少一个已装 CLI 的 mountStrategies 含 "mcp"
//   4. 至少一个 mcp 挂载策略真生效：对应配置文件含 yondermesh 入口
// exit 0 = 全部不变式成立；exit 1 = 有不变式被违反。
import { execSync } from 'node:child_process';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = os.homedir();

function fail(msg) {
  console.error(`[verify-inject-mount] FAIL: ${msg}`);
  process.exit(1);
}

// --- 1. agents 返回非空 ---
let agents = [];
try {
  const out = execSync(`ymesh mcp call agents '{"installed_only":true,"include_mounts":true}' 2>/dev/null`, { encoding: 'utf-8', timeout: 30000 });
  agents = JSON.parse(out).agents || [];
} catch (e) {
  fail(`agents 工具调用失败: ${e.message}`);
}
if (agents.length === 0) fail('agents 工具返回空（已装 CLI 应 > 0）');

// --- 2. ymesh mount status exit 0 ---
try {
  execSync('ymesh mount status', { encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'ignore', 'ignore'] });
} catch (e) {
  fail(`ymesh mount status 失败: ${e.message}`);
}

// --- 3. 至少一个 CLI 的 mountStrategies 含 "mcp" ---
const withMcp = agents.filter((a) => Array.isArray(a.mountStrategies) && a.mountStrategies.includes('mcp'));
if (withMcp.length === 0) {
  fail(`无任何已装 CLI 的 mountStrategies 含 "mcp"（期望 >=1）`);
}

// --- 4. 至少一个 mcp 挂载策略真生效：对应配置文件含 yondermesh 入口 ---
const MCP_CONFIG_CANDIDATES = [
  join(HOME, '.codex', 'config.toml'),        // codex mcp-toml 策略
  join(HOME, '.claude.json'),                  // claude-code claude-mcp 策略
  join(HOME, '.claude', 'claude_mcp_config.json'), // 旧式 claude mcp 配置
  join(HOME, '.gemini', 'settings.json'),      // gemini mcp-json 策略
  join(HOME, '.config', 'opencode', 'config.json'), // opencode
  join(HOME, '.kimi', 'config.toml'),          // kimi
];

let mcpEffective = false;
let effectivePath = '';
for (const p of MCP_CONFIG_CANDIDATES) {
  if (!existsSync(p)) continue;
  try {
    const text = readFileSync(p, 'utf-8');
    if (text.includes('yondermesh')) {
      mcpEffective = true;
      effectivePath = p;
      break;
    }
  } catch { /* skip */ }
}

// 兜底：若以上文件都不在，用 ymesh mount status 输出确认有 MOUNTED 行
if (!mcpEffective) {
  try {
    const out = execSync('ymesh mount status 2>/dev/null', { encoding: 'utf-8', timeout: 15000 });
    if (/MOUNTED/i.test(out) && /mcp/i.test(out)) {
      mcpEffective = true;
      effectivePath = '(mount status 输出含 mcp MOUNTED)';
    }
  } catch { /* skip */ }
}

if (!mcpEffective) {
  fail(`未发现任何已生效的 mcp 挂载（检查 ${MCP_CONFIG_CANDIDATES.length} 个候选配置文件均无 yondermesh 入口，且 mount status 无 mcp MOUNTED）`);
}

console.log(`[verify-inject-mount] PASS: ${agents.length} 个已装 CLI，${withMcp.length} 个含 mcp 挂载策略；生效配置: ${effectivePath}`);
