/**
 * MCP Server 注册器 — LOOP-011b
 *
 * 将 yondermesh MCP server 注册到 Claude Code 和 Codex 的配置中。
 * 注册后新 session 立即可用；正在运行的 session 需要重连。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SERVER_NAME = 'yondermesh';

/** ymesh 入口脚本的绝对路径 */
function resolveYmeshEntry(): string {
  // 优先使用 install 后的 symlink 路径
  const installedPath = join(homedir(), '.yondermesh', 'bin', 'ymesh');
  if (existsSync(installedPath)) return installedPath;

  // 回退到 node + dist 路径（开发环境）
  return '';
}

/** node 可执行文件路径 */
function resolveNodeBin(): string | null {
  return process.execPath;
}

export interface RegistrationResult {
  claude: boolean;
  codex: boolean;
  errors: string[];
}

export interface RegistrationStatus {
  claude: { registered: boolean; path: string | null };
  codex: { registered: boolean; path: string | null };
}

// -- Claude Code (~/.claude.json) ----------------------------------------

function claudeConfigPath(): string {
  return join(homedir(), '.claude.json');
}

function readClaudeConfig(): Record<string, unknown> {
  const p = claudeConfigPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function writeClaudeConfig(config: Record<string, unknown>): void {
  writeFileSync(claudeConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

// -- Codex (~/.codex/config.toml) ----------------------------------------

function codexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

function readCodexConfig(): string {
  const p = codexConfigPath();
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

function writeCodexConfig(content: string): void {
  writeFileSync(codexConfigPath(), content, 'utf-8');
}

/**
 * 从 TOML 中提取 [mcp_servers.yondermesh] 段的起止行号。
 * 返回 [startIndex, endIndex]（endIndex 是下一个 [ 开头的行或文件末尾）。
 */
function findCodexServerBlock(lines: string[]): [number, number] | null {
  const header = `[mcp_servers.${SERVER_NAME}]`;
  let startIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) {
      startIdx = i;
      break;
    }
    // 处理 [mcp_servers.yondermesh.env] 子段
    if (lines[i].trim().startsWith(header.replace(']', ''))) {
      startIdx = i;
      break;
    }
  }

  if (startIdx === -1) return null;

  // 找到这个块后面第一个不缩进的 [ 开头的行（同级别 section）
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\[/.test(line) && !lines[i].trim().startsWith(`[mcp_servers.${SERVER_NAME}`)) {
      endIdx = i;
      break;
    }
  }

  return [startIdx, endIdx];
}

// -- 公开 API ------------------------------------------------------------

export function registerToClaude(ymeshArgs: string[]): boolean {
  const nodeBin = resolveNodeBin();
  if (!nodeBin) return false;

  const config = readClaudeConfig();
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  servers[SERVER_NAME] = {
    type: 'stdio',
    command: nodeBin,
    args: ymeshArgs,
    env: {},
  };

  writeClaudeConfig(config);
  return true;
}

export function unregisterFromClaude(): boolean {
  const config = readClaudeConfig();
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !(SERVER_NAME in servers)) return false;

  delete servers[SERVER_NAME];
  writeClaudeConfig(config);
  return true;
}

export function isRegisteredInClaude(): boolean {
  const config = readClaudeConfig();
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  return !!(servers && SERVER_NAME in servers);
}

export function registerToCodex(ymeshArgs: string[]): boolean {
 const content = readCodexConfig();
  const lines = content.split('\n');

  // 如果已存在，先删除旧块
  const existing = findCodexServerBlock(lines);
  let working = lines;
  if (existing) {
    working = [...lines.slice(0, existing[0]), ...lines.slice(existing[1])];
  }

  // 构建新块
  const nodeBin = resolveNodeBin();
  if (!nodeBin) return false;

  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = "${nodeBin}"`,
    `args = ${JSON.stringify(ymeshArgs)}`,
  ];

  // 追加到文件末尾（确保前面有空行）
  if (working.length > 0 && working[working.length - 1].trim() !== '') {
    working.push('');
  }
  working.push(...block);
  working.push('');

  writeCodexConfig(working.join('\n'));
  return true;
}

export function unregisterFromCodex(): boolean {
  const content = readCodexConfig();
  const lines = content.split('\n');
  const block = findCodexServerBlock(lines);
  if (!block) return false;

  // 删除块，同时吃掉前面的空行
  let startRemove = block[0];
  while (startRemove > 0 && lines[startRemove - 1].trim() === '') {
    startRemove--;
  }

  const updated = [...lines.slice(0, startRemove), ...lines.slice(block[1])];
  writeCodexConfig(updated.join('\n'));
  return true;
}

export function isRegisteredInCodex(): boolean {
  const content = readCodexConfig();
  return content.includes(`[mcp_servers.${SERVER_NAME}]`);
}

// -- 组合操作 ------------------------------------------------------------

/** 构建注册用的 ymesh 参数（优先使用安装路径，回退到开发路径） */
export function buildYmeshArgs(extraDbPath?: string): string[] {
  const entry = resolveYmeshEntry();

  if (entry) {
    const args = [entry, 'mcp'];
    if (extraDbPath) {
      args.push('--db', extraDbPath);
    }
    return args;
  }

  // 开发环境回退
  const devEntry = join(process.cwd(), 'dist', 'bin', 'ymesh.js');
  const args = [devEntry, 'mcp'];
  if (extraDbPath) {
    args.push('--db', extraDbPath);
  }
  return args;
}

/** 注册到全部已安装的 CLI agent */
export function registerAll(ymeshArgs: string[]): RegistrationResult {
  const errors: string[] = [];
  let claude = false;
  let codex = false;

  // Claude Code
  if (existsSync(claudeConfigPath())) {
    try {
      claude = registerToClaude(ymeshArgs);
    } catch (e) {
      errors.push(`Claude: ${String(e)}`);
    }
  }

  // Codex
  if (existsSync(codexConfigPath())) {
    try {
      codex = registerToCodex(ymeshArgs);
    } catch (e) {
      errors.push(`Codex: ${String(e)}`);
    }
  }

  return { claude, codex, errors };
}

/** 从全部 CLI agent 注销 */
export function unregisterAll(): RegistrationResult {
  const errors: string[] = [];
  let claude = false;
  let codex = false;

  try {
    claude = unregisterFromClaude();
  } catch (e) {
    errors.push(`Claude: ${String(e)}`);
  }

  try {
    codex = unregisterFromCodex();
  } catch (e) {
    errors.push(`Codex: ${String(e)}`);
  }

  return { claude, codex, errors };
}

/** 查询注册状态 */
export function checkRegistration(): RegistrationStatus {
  return {
    claude: {
      registered: isRegisteredInClaude(),
      path: claudeConfigPath(),
    },
    codex: {
      registered: isRegisteredInCodex(),
      path: codexConfigPath(),
    },
  };
}
