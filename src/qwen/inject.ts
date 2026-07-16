/**
 * Qwen Code 注入器 — MCP 注册 / hooks 配置 / always-on system prompt
 *
 * Qwen Code（v0.19.8）支持：
 *   - MCP servers：配置在 ~/.qwen/settings.json 的 mcpServers 字段（与 Claude Code 兼容）
 *   - Hooks：Claude Code 兼容 hooks（`qwen hooks` 管理，settings.json 配置）
 *   - System prompt：项目级 QWEN.md / 全局 context 文件（always-on 替代）
 *
 * 本模块提供幂等的注册/注销/查询函数，与 mcp/register.ts 风格一致。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const SERVER_NAME = 'yondermesh';

/** ymesh 入口脚本绝对路径（优先安装 symlink，回退 dist） */
function resolveYmeshEntry(): string {
  const installed = join(homedir(), '.yondermesh', 'bin', 'ymesh');
  if (existsSync(installed)) return installed;
  return join(process.cwd(), 'dist', 'bin', 'ymesh.js');
}

/** node 可执行文件路径 */
function resolveNodeBin(): string {
  return process.execPath;
}

/** ~/.qwen/settings.json 路径 */
export function qwenSettingsPath(): string {
  return join(homedir(), '.qwen', 'settings.json');
}

/** 读取 Qwen settings.json（不存在或损坏返回空对象） */
function readQwenSettings(): Record<string, unknown> {
  const p = qwenSettingsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/** 写入 Qwen settings.json */
function writeQwenSettings(config: Record<string, unknown>): void {
  const p = qwenSettingsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
}

// ─── MCP 注册 ──────────────────────────────────────────────────────────

/** 构建注册用的 ymesh 参数 */
export function buildYmeshArgs(extraDbPath?: string[]): string[] {
  const entry = resolveYmeshEntry();
  const args = [entry, 'mcp'];
  if (extraDbPath) args.push('--db', ...extraDbPath);
  return args;
}

/**
 * 将 yondermesh MCP server 注册到 Qwen Code 的 settings.json。
 * 幂等：重复调用覆盖旧配置。
 */
export function registerMcp(ymeshArgs?: string[]): boolean {
  const nodeBin = resolveNodeBin();
  if (!nodeBin) return false;
  const args = ymeshArgs ?? buildYmeshArgs();

  const config = readQwenSettings();
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  (config.mcpServers as Record<string, unknown>)[SERVER_NAME] = {
    command: nodeBin,
    args,
    env: {},
  };
  writeQwenSettings(config);
  return true;
}

/** 从 Qwen Code 注销 yondermesh MCP server */
export function unregisterMcp(): boolean {
  const config = readQwenSettings();
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !(SERVER_NAME in servers)) return false;
  delete servers[SERVER_NAME];
  writeQwenSettings(config);
  return true;
}

/** 查询 yondermesh MCP server 是否已注册到 Qwen */
export function isMcpRegistered(): boolean {
  const config = readQwenSettings();
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  return !!(servers && SERVER_NAME in servers);
}

// ─── Hooks 配置（Claude Code 兼容）──────────────────────────────────────

/** 单个 hook 配置 */
export interface QwenHookConfig {
  /** hook 事件名，如 PreToolUse / PostToolUse / UserPromptSubmit / Stop */
  event: string;
  /** 匹配的工具名（仅 PreToolUse/PostToolUse 有效），缺省匹配全部 */
  matcher?: string;
  /** 要执行的命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
}

/**
 * 配置 Qwen Code 的 hooks（Claude Code 兼容格式）。
 *
 * Qwen Code 的 hooks 写在 settings.json 的 hooks 字段，结构为：
 *   { hooks: { <EventName>: [ { matcher?, hooks: [{ type: "command", command }] } ] } }
 *
 * 幂等：同 event+command 的 hook 不重复添加。
 */
export function configureHooks(hooks: QwenHookConfig[]): { added: number; skipped: number } {
  const config = readQwenSettings();
  if (!config.hooks || typeof config.hooks !== 'object') {
    config.hooks = {};
  }
  const hooksObj = config.hooks as Record<string, unknown[]>;

  let added = 0;
  let skipped = 0;

  for (const hook of hooks) {
    const list = hooksObj[hook.event] ?? [];
    const cmdStr = `${hook.command} ${(hook.args ?? []).join(' ')}`.trim();
    // 幂等检查：同 command 已存在则跳过
    const exists = list.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const e = entry as { hooks?: unknown };
      const inner = Array.isArray(e.hooks) ? (e.hooks as Array<{ command?: string }>) : [];
      return inner.some((h) => h && h.command === cmdStr);
    });
    if (exists) {
      skipped++;
      continue;
    }
    list.push({
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      hooks: [{ type: 'command', command: cmdStr }],
    });
    hooksObj[hook.event] = list;
    added++;
  }

  writeQwenSettings(config);
  return { added, skipped };
}

/** 移除指定 event 下的所有 hooks，或全部 hooks（event 未指定时） */
export function clearHooks(event?: string): number {
  const config = readQwenSettings();
  const hooksObj = config.hooks as Record<string, unknown[]> | undefined;
  if (!hooksObj) return 0;
  if (event) {
    const n = (hooksObj[event]?.length ?? 0);
    delete hooksObj[event];
    writeQwenSettings(config);
    return n;
  }
  const total = Object.keys(hooksObj).reduce((s, k) => s + (hooksObj[k]?.length ?? 0), 0);
  config.hooks = {};
  writeQwenSettings(config);
  return total;
}

// ─── Always-on system prompt ────────────────────────────────────────────

/** ~/.qwen/QWEN.md 全局 system prompt 路径 */
export function qwenGlobalPromptPath(): string {
  return join(homedir(), '.qwen', 'QWEN.md');
}

/**
 * 写入全局 always-on system prompt（~/.qwen/QWEN.md）。
 *
 * Qwen Code 在启动时会读取全局 context 文件作为 system prompt 前缀，
 * 实现无需 hooks 的 always-on 介入（每次会话自动加载）。
 * 幂等：覆盖写入。
 */
export function injectSystemPrompt(content: string): string {
  const p = qwenGlobalPromptPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
  return p;
}

/** 读取已注入的全局 system prompt，不存在返回 null */
export function readSystemPrompt(): string | null {
  const p = qwenGlobalPromptPath();
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** 移除全局 system prompt 文件 */
export function removeSystemPrompt(): boolean {
  const p = qwenGlobalPromptPath();
  if (!existsSync(p)) return false;
  try {
    writeFileSync(p, '', 'utf8'); // 清空而非删除（避免 Qwen 报错）
    return true;
  } catch {
    return false;
  }
}

// ─── 组合：一次性接入 ──────────────────────────────────────────────────

/** 一次性接入结果 */
export interface QwenInjectResult {
  mcp: boolean;
  hooks: { added: number; skipped: number };
  systemPrompt: string | null;
  errors: string[];
}

/**
 * 一次性完成 Qwen Code 的 yondermesh 接入：
 *   1. 注册 MCP server
 *   2. 配置 session handoff hooks（UserPromptSubmit / Stop）
 *   3. 注入 always-on system prompt
 */
export function injectAll(
  options: {
    ymeshArgs?: string[];
    systemPrompt?: string;
    enableHooks?: boolean;
  } = {},
): QwenInjectResult {
  const errors: string[] = [];
  let mcp = false;
  let hooks = { added: 0, skipped: 0 };
  let systemPrompt: string | null = null;

  // MCP
  try {
    mcp = registerMcp(options.ymeshArgs);
  } catch (e) {
    errors.push(`MCP: ${String(e)}`);
  }

  // Hooks
  if (options.enableHooks !== false) {
    try {
      const ymeshEntry = resolveYmeshEntry();
      const nodeBin = resolveNodeBin();
      const handoffCmd = nodeBin;
      const handoffArgs = [ymeshEntry, 'hook', 'qwen'];
      hooks = configureHooks([
        {
          event: 'UserPromptSubmit',
          command: handoffCmd,
          args: handoffArgs,
        },
        {
          event: 'Stop',
          command: handoffCmd,
          args: handoffArgs,
        },
      ]);
    } catch (e) {
      errors.push(`Hooks: ${String(e)}`);
    }
  }

  // System prompt
  if (options.systemPrompt !== undefined) {
    try {
      systemPrompt = injectSystemPrompt(options.systemPrompt);
    } catch (e) {
      errors.push(`SystemPrompt: ${String(e)}`);
    }
  }

  return { mcp, hooks, systemPrompt, errors };
}

/**
 * 检测 qwen CLI 是否可用（PATH 中存在）。
 */
export function isQwenInstalled(): boolean {
  try {
    const r = spawnSync('qwen', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}
