/**
 * Gemini CLI 注入器 — MCP 注册 / hooks 配置 / skills 挂载 / always-on system prompt
 *
 * Gemini CLI（v0.50.0）支持：
 *   - MCP servers：配置在 ~/.gemini/settings.json 的 mcpServers 字段
 *   - Hooks：11 个 hook 事件（`gemini hooks` 命令管理）
 *   - Skills：`gemini skills link <path>` 挂载本地 skill 目录
 *   - System prompt：~/.gemini/GEMINI.md 全局 context 文件（always-on）
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

/** ~/.gemini/settings.json 路径 */
export function geminiSettingsPath(): string {
  return join(homedir(), '.gemini', 'settings.json');
}

/** 读取 Gemini settings.json（不存在或损坏返回空对象） */
function readGeminiSettings(): Record<string, unknown> {
  const p = geminiSettingsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/** 写入 Gemini settings.json */
function writeGeminiSettings(config: Record<string, unknown>): void {
  const p = geminiSettingsPath();
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
 * 将 yondermesh MCP server 注册到 Gemini CLI 的 settings.json。
 * 幂等：重复调用覆盖旧配置。
 */
export function registerMcp(ymeshArgs?: string[]): boolean {
  const nodeBin = resolveNodeBin();
  if (!nodeBin) return false;
  const args = ymeshArgs ?? buildYmeshArgs();

  const config = readGeminiSettings();
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  (config.mcpServers as Record<string, unknown>)[SERVER_NAME] = {
    command: nodeBin,
    args,
    env: {},
  };
  writeGeminiSettings(config);
  return true;
}

/** 从 Gemini CLI 注销 yondermesh MCP server */
export function unregisterMcp(): boolean {
  const config = readGeminiSettings();
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !(SERVER_NAME in servers)) return false;
  delete servers[SERVER_NAME];
  writeGeminiSettings(config);
  return true;
}

/** 查询 yondermesh MCP server 是否已注册到 Gemini */
export function isMcpRegistered(): boolean {
  const config = readGeminiSettings();
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  return !!(servers && SERVER_NAME in servers);
}

// ─── Skills 挂载 ────────────────────────────────────────────────────────

/**
 * 将本地 skill 目录链接到 Gemini CLI（`gemini skills link <path>`）。
 * 幂等：Gemini skills link 自身会处理已存在情况。
 *
 * 返回命令是否成功执行。
 */
export function linkSkill(skillPath: string): boolean {
  try {
    const r = spawnSync('gemini', ['skills', 'link', skillPath], {
      encoding: 'utf8',
      timeout: 10000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 卸载指定 skill（`gemini skills uninstall <name>`）。
 */
export function unlinkSkill(skillName: string): boolean {
  try {
    const r = spawnSync('gemini', ['skills', 'uninstall', skillName], {
      encoding: 'utf8',
      timeout: 10000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 列出已安装的 skills（`gemini skills list`） */
export function listSkills(): string[] {
  try {
    const r = spawnSync('gemini', ['skills', 'list'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    if (r.status !== 0 || !r.stdout) return [];
    // 解析输出：每行一个 skill 名（跳过表头/空行）
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('-') && !l.toLowerCase().startsWith('name'));
  } catch {
    return [];
  }
}

// ─── Hooks 配置 ────────────────────────────────────────────────────────

/**
 * Gemini CLI 的 11 个 hook 事件（atlas 实测）：
 *   PreSessionStart, PostSessionStart, PrePrompt, PostPrompt,
 *   PreToolCall, PostToolCall, PreFileEdit, PostFileEdit,
 *   PreCommand, PostCommand, SessionEnd
 */
export const GEMINI_HOOK_EVENTS = [
  'PreSessionStart',
  'PostSessionStart',
  'PrePrompt',
  'PostPrompt',
  'PreToolCall',
  'PostToolCall',
  'PreFileEdit',
  'PostFileEdit',
  'PreCommand',
  'PostCommand',
  'SessionEnd',
] as const;

/** 单个 hook 配置 */
export interface GeminiHookConfig {
  /** hook 事件名（见 GEMINI_HOOK_EVENTS） */
  event: string;
  /** 要执行的命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
}

/**
 * 通过 `gemini hooks add` 配置 hooks。
 *
 * Gemini CLI 的 hooks 通过 `gemini hooks` 子命令管理（非 settings.json）。
 * 幂等：同 event+command 重复添加会被 Gemini 自身去重或覆盖。
 *
 * 返回成功添加的数量。
 */
export function configureHooks(hooks: GeminiHookConfig[]): { added: number; failed: number } {
  let added = 0;
  let failed = 0;
  for (const hook of hooks) {
    const cmdStr = `${hook.command} ${(hook.args ?? []).join(' ')}`.trim();
    try {
      const r = spawnSync(
        'gemini',
        ['hooks', 'add', hook.event, '--command', cmdStr],
        { encoding: 'utf8', timeout: 10000 },
      );
      if (r.status === 0) added++;
      else failed++;
    } catch {
      failed++;
    }
  }
  return { added, failed };
}

/** 移除指定 event 下的所有 hooks（`gemini hooks remove <event>`） */
export function clearHooks(event: string): boolean {
  try {
    const r = spawnSync('gemini', ['hooks', 'remove', event], {
      encoding: 'utf8',
      timeout: 10000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ─── Always-on system prompt ────────────────────────────────────────────

/** ~/.gemini/GEMINI.md 全局 system prompt 路径 */
export function geminiGlobalPromptPath(): string {
  return join(homedir(), '.gemini', 'GEMINI.md');
}

/**
 * 写入全局 always-on system prompt（~/.gemini/GEMINI.md）。
 *
 * Gemini CLI 启动时自动加载 GEMINI.md 作为 system context，
 * 实现无需 hooks 的 always-on 介入。
 * 幂等：覆盖写入。
 */
export function injectSystemPrompt(content: string): string {
  const p = geminiGlobalPromptPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
  return p;
}

/** 读取已注入的全局 system prompt，不存在返回 null */
export function readSystemPrompt(): string | null {
  const p = geminiGlobalPromptPath();
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** 移除全局 system prompt 文件 */
export function removeSystemPrompt(): boolean {
  const p = geminiGlobalPromptPath();
  if (!existsSync(p)) return false;
  try {
    writeFileSync(p, '', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ─── 组合：一次性接入 ──────────────────────────────────────────────────

/** 一次性接入结果 */
export interface GeminiInjectResult {
  mcp: boolean;
  hooks: { added: number; failed: number };
  skills: { linked: string[]; failed: string[] };
  systemPrompt: string | null;
  errors: string[];
}

/**
 * 一次性完成 Gemini CLI 的 yondermesh 接入：
 *   1. 注册 MCP server（settings.json）
 *   2. 配置 session handoff hooks（PrePrompt / SessionEnd）
 *   3. 链接 yondermesh-diagnose skill（如本地存在）
 *   4. 注入 always-on system prompt
 */
export function injectAll(
  options: {
    ymeshArgs?: string[];
    systemPrompt?: string;
    enableHooks?: boolean;
    skillPaths?: string[];
  } = {},
): GeminiInjectResult {
  const errors: string[] = [];
  let mcp = false;
  let hooks = { added: 0, failed: 0 };
  const skills = { linked: [] as string[], failed: [] as string[] };
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
      const cmd = nodeBin;
      const args = [ymeshEntry, 'hook', 'gemini'];
      const cmdStr = `${cmd} ${args.join(' ')}`.trim();
      hooks = configureHooks([
        { event: 'PrePrompt', command: cmdStr },
        { event: 'SessionEnd', command: cmdStr },
      ]);
    } catch (e) {
      errors.push(`Hooks: ${String(e)}`);
    }
  }

  // Skills
  const skillPaths = options.skillPaths ?? defaultSkillPaths();
  for (const sp of skillPaths) {
    if (!existsSync(sp)) {
      skills.failed.push(sp);
      continue;
    }
    if (linkSkill(sp)) {
      skills.linked.push(sp);
    } else {
      skills.failed.push(sp);
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

  return { mcp, hooks, skills, systemPrompt, errors };
}

/** 默认 skill 路径：yondermesh release 自带的 skill 目录 */
function defaultSkillPaths(): string[] {
  const releaseSkills = join(homedir(), '.yondermesh', 'releases', 'current', 'skills');
  const out: string[] = [];
  const candidates = ['yondermesh-diagnose'];
  for (const name of candidates) {
    const p = join(releaseSkills, name);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/**
 * 检测 gemini CLI 是否可用（PATH 中存在）。
 */
export function isGeminiInstalled(): boolean {
  try {
    const r = spawnSync('gemini', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}
