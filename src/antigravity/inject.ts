/**
 * Antigravity 扩展注入：MCP（mcp_config.json）+ Skills + 5 Hooks
 *
 * Antigravity（Google IDE）的扩展机制：
 *
 * 1. MCP servers：通过 ~/.gemini/config/mcp_config.json 注册（与 Gemini CLI 共享）。
 *    形态（JSON）：
 *      {
 *        "mcpServers": {
 *          "yondermesh": {
 *            "command": "/path/to/node",
 *            "args": ["/path/to/ymesh", "mcp"],
 *            "env": {}
 *          }
 *        }
 *      }
 *    Antigravity 启动新会话时加载这些 MCP server。
 *
 * 2. Skills：Antigravity 自动加载 ~/.gemini/skills/ 下的 skill 目录（SKILL.md）。
 *    与 Gemini CLI 的 skill 机制一致。
 *
 * 3. Hooks（5 个事件）：Antigravity 支持 5 个 lifecycle hook（与 Gemini CLI 一致）：
 *      - PreToolCall：工具调用前
 *      - PostToolCall：工具调用后
 *      - UserPromptSubmit：用户提交 prompt 时
 *      - Notification：通知事件
 *      - Stop：会话停止时
 *    通过 ~/.gemini/config/settings.json 的 hooks 字段注册。
 *
 * 4. Always-on context：通过 settings.json 的 systemPrompt 字段注入常驻提示。
 *
 * 设计原则：
 *   - 与 mcp/register.ts 风格一致：read/write/isRegistered 三段式
 *   - JSON 操作采用 JSON.parse/stringify（不引入额外依赖）
 *   - 注入幂等：重复调用不堆积
 *
 * GLM-5.2 ❌：Antigravity 硬绑 Google OAuth，无法切换到 GLM-5.2。
 *   注入 yondermesh MCP 后，Antigravity 会话可查询跨 agent 上下文，
 *   但其自身推理仍走 Google 模型；session 内容可被提取用于 handoff。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const SERVER_NAME = 'yondermesh';

/** ~/.gemini 根目录（与 Gemini CLI 共享） */
function geminiRoot(): string {
  return process.env.GEMINI_HOME ?? join(homedir(), '.gemini');
}

/** mcp_config.json 路径 */
function mcpConfigPath(): string {
  return join(geminiRoot(), 'config', 'mcp_config.json');
}

/** settings.json 路径（hooks + always-on） */
function settingsPath(): string {
  return join(geminiRoot(), 'config', 'settings.json');
}

/** skills 目录 */
function skillsDir(): string {
  return join(geminiRoot(), 'skills');
}

/** 读取 JSON 文件（不存在返回 null） */
function readJson(p: string): Record<string, unknown> | null {
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 写 JSON 文件（pretty print） */
function writeJson(p: string, data: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ─── MCP 注入（mcp_config.json） ─────────────────────────────────────────

/** ymesh 入口脚本绝对路径 */
function resolveYmeshEntry(): string {
  const installed = join(homedir(), '.yondermesh', 'bin', 'ymesh');
  if (existsSync(installed)) return installed;
  return '';
}

function resolveNodeBin(): string {
  return process.execPath;
}

export interface McpRegistrationResult {
  registered: boolean;
  path: string;
}

/**
 * 把 yondermesh MCP server 注册到 Antigravity mcp_config.json。
 * 幂等：先移除旧 yondermesh 条目再写入。
 */
export function registerMcp(ymeshArgs?: string[]): McpRegistrationResult {
  const args = ymeshArgs ?? buildYmeshArgs();
  const nodeBin = resolveNodeBin();
  const entry = args[0] ?? '';
  const rest = args.slice(1);

  const p = mcpConfigPath();
  const data = readJson(p) ?? {};
  const mcpServers = (data.mcpServers as Record<string, unknown> | undefined) ?? {};
  // 幂等覆盖
  mcpServers[SERVER_NAME] = {
    type: 'stdio',
    command: nodeBin,
    args: [entry, ...rest],
    env: {},
  };
  data.mcpServers = mcpServers;
  writeJson(p, data);
  return { registered: true, path: p };
}

/** 从 mcp_config.json 移除 yondermesh MCP server（幂等） */
export function unregisterMcp(): boolean {
  const p = mcpConfigPath();
  const data = readJson(p);
  if (!data) return false;
  const mcpServers = data.mcpServers as Record<string, unknown> | undefined;
  if (!mcpServers || !(SERVER_NAME in mcpServers)) return false;
  delete mcpServers[SERVER_NAME];
  data.mcpServers = mcpServers;
  writeJson(p, data);
  return true;
}

export function isMcpRegistered(): boolean {
  const data = readJson(mcpConfigPath());
  if (!data) return false;
  const mcpServers = data.mcpServers as Record<string, unknown> | undefined;
  return !!mcpServers && SERVER_NAME in mcpServers;
}

/** 构建注册用的 ymesh 参数 */
export function buildYmeshArgs(extraDbPath?: string): string[] {
  const entry = resolveYmeshEntry();
  if (entry) {
    const args = [entry, 'mcp'];
    if (extraDbPath) args.push('--db', extraDbPath);
    return args;
  }
  const devEntry = join(process.cwd(), 'dist', 'bin', 'ymesh.js');
  const args = [devEntry, 'mcp'];
  if (extraDbPath) args.push('--db', extraDbPath);
  return args;
}

// ─── Skills（~/.gemini/skills/） ────────────────────────────────────────

export interface SkillEntry {
  name: string;
  path: string;
  hasSkillMd: boolean;
}

/** 列出 Antigravity 已安装的 skills（~/.gemini/skills/<name>/SKILL.md） */
export function listSkills(): SkillEntry[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const skillPath = join(dir, e.name);
    const skillMd = join(skillPath, 'SKILL.md');
    out.push({ name: e.name, path: skillPath, hasSkillMd: existsSync(skillMd) });
  }
  return out;
}

/**
 * 把一个 skill 目录（含 SKILL.md）软链到 ~/.gemini/skills/<name>。
 * 已存在同名 skill 不覆盖（幂等）。
 */
export function installSkill(
  sourceDir: string,
  name?: string,
): { installed: boolean; path: string; reason?: string } {
  const skillName = name ?? sourceDir.split('/').pop() ?? 'skill';
  const target = join(skillsDir(), skillName);
  if (existsSync(target)) {
    return { installed: false, path: target, reason: 'skill already exists' };
  }
  mkdirSync(skillsDir(), { recursive: true });
  try {
    symlinkSync(sourceDir, target, 'dir');
    return { installed: true, path: target };
  } catch {
    return { installed: false, path: target, reason: 'symlink failed' };
  }
}

// ─── Lifecycle Hooks（5 事件） ──────────────────────────────────────────

/** Antigravity 支持的 5 个 lifecycle hook 事件（与 Gemini CLI 一致） */
export const ANTIGRAVITY_HOOK_EVENTS = [
  'PreToolCall',
  'PostToolCall',
  'UserPromptSubmit',
  'Notification',
  'Stop',
] as const;

export type AntigravityHookEvent = (typeof ANTIGRAVITY_HOOK_EVENTS)[number];

export interface HookConfig {
  event: AntigravityHookEvent;
  /** 回调命令（Antigravity 通过 shell 执行该命令，stdin 传事件 payload） */
  command: string;
  /** 可选 timeout（秒） */
  timeout?: number;
}

/**
 * 读取 settings.json 中已注册的 yondermesh hooks。
 * 形态：settings.json 的 hooks.<event>.yondermesh = [{ command, timeout }]
 */
export function listHooks(): HookConfig[] {
  const data = readJson(settingsPath());
  if (!data) return [];
  const hooks = data.hooks as Record<string, Record<string, unknown>> | undefined;
  if (!hooks) return [];
  const out: HookConfig[] = [];
  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    const eventBlock = hooks[event];
    if (!eventBlock || typeof eventBlock !== 'object') continue;
    const ymEntries = eventBlock[SERVER_NAME];
    if (!Array.isArray(ymEntries)) continue;
    for (const entry of ymEntries as Array<Record<string, unknown>>) {
      const command = typeof entry.command === 'string' ? entry.command : '';
      const timeout = typeof entry.timeout === 'number' ? entry.timeout : undefined;
      if (command) out.push({ event, command, timeout });
    }
  }
  return out;
}

/**
 * 注册一个 lifecycle hook（幂等：同 event+command 不重复）。
 * 写入 settings.json 的 hooks.<event>.yondermesh 数组。
 */
export function registerHook(
  event: AntigravityHookEvent,
  command: string,
  opts: { timeout?: number } = {},
): { registered: boolean; path: string } {
  const p = settingsPath();
  const data = readJson(p) ?? {};
  const hooks = (data.hooks as Record<string, Record<string, unknown[]>> | undefined) ?? {};

  const eventBlock = hooks[event] ?? {};
  const existing = (eventBlock[SERVER_NAME] as Array<Record<string, unknown>>) ?? [];
  // 幂等检查
  const exists = existing.some(
    (e) => typeof e.command === 'string' && e.command === command,
  );
  if (!exists) {
    existing.push({ command, ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}) });
  }
  eventBlock[SERVER_NAME] = existing;
  hooks[event] = eventBlock;
  data.hooks = hooks;
  writeJson(p, data);
  return { registered: true, path: p };
}

/** 移除所有 yondermesh hooks（所有事件下的 yondermesh 条目） */
export function unregisterAllHooks(): boolean {
  const p = settingsPath();
  const data = readJson(p);
  if (!data) return false;
  const hooks = data.hooks as Record<string, Record<string, unknown>> | undefined;
  if (!hooks) return false;
  let removed = false;
  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    const eventBlock = hooks[event];
    if (eventBlock && typeof eventBlock === 'object' && SERVER_NAME in eventBlock) {
      delete eventBlock[SERVER_NAME];
      removed = true;
    }
  }
  if (removed) {
    data.hooks = hooks;
    writeJson(p, data);
  }
  return removed;
}

// ─── Always-on context ──────────────────────────────────────────────────

/**
 * 注入常驻上下文（systemPrompt）。
 * 写入 settings.json 顶层 systemPrompt 字段（幂等覆盖）。
 */
export function setAlwaysOnContext(context: string): { set: boolean; path: string } {
  const p = settingsPath();
  const data = readJson(p) ?? {};
  data.systemPrompt = context;
  writeJson(p, data);
  return { set: true, path: p };
}

export function getAlwaysOnContext(): string | null {
  const data = readJson(settingsPath());
  if (!data) return null;
  const sp = data.systemPrompt;
  return typeof sp === 'string' ? sp : null;
}

export function clearAlwaysOnContext(): boolean {
  const p = settingsPath();
  const data = readJson(p);
  if (!data || data.systemPrompt === undefined) return false;
  delete data.systemPrompt;
  writeJson(p, data);
  return true;
}

// ─── 组合操作 ───────────────────────────────────────────────────────────

export interface FullInjectResult {
  mcp: McpRegistrationResult;
  hooksRegistered: number;
  alwaysOnSet: boolean;
}

/**
 * 一次性注入全部扩展：MCP + 5 个 lifecycle hooks + Always-on。
 * skills 需单独 installSkill。
 */
export function injectAll(opts: {
  ymeshArgs?: string[];
  hookCommand?: string;
  alwaysOnContext?: string;
}): FullInjectResult {
  const mcp = registerMcp(opts.ymeshArgs);

  let hooksRegistered = 0;
  if (opts.hookCommand) {
    for (const event of ANTIGRAVITY_HOOK_EVENTS) {
      registerHook(event, opts.hookCommand);
      hooksRegistered++;
    }
  }

  let alwaysOnSet = false;
  if (opts.alwaysOnContext !== undefined) {
    alwaysOnSet = setAlwaysOnContext(opts.alwaysOnContext).set;
  }

  return { mcp, hooksRegistered, alwaysOnSet };
}
