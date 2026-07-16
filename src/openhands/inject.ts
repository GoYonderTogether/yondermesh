/**
 * OpenHands 扩展注入：MCP + Skills + Lifecycle Hooks + Always-on
 *
 * OpenHands（agent-server 架构）支持三种扩展机制，本模块统一封装注入/读取：
 *
 * 1. MCP servers：通过 OpenHands config.toml 的 [mcp] 段注册 stdio/sse MCP server。
 *    yondermesh MCP server 注册后，OpenHands 新 session 即可查询跨 agent 上下文。
 *
 * 2. Skills：OpenHands 自动加载 ~/.openhands/skills/ 下的 skill 目录（SKILL.md）。
 *    与 Trae/Claude Code 的 skill 机制一致。
 *
 * 3. Lifecycle hooks（6 个事件）：OpenHands 支持在 conversation 生命周期关键点
 *    注册 HTTP 回调。6 个事件：
 *      - on_conversation_start
 *      - on_conversation_end
 *      - on_user_message
 *      - on_assistant_message
 *      - on_tool_call
 *      - on_iteration_end
 *    通过 POST /api/conversations/{id}/hooks 或 config.toml [hooks] 注册。
 *
 * 4. Always-on context：通过 config.toml 的 [default_agent] / system_message 注入
 *    常驻上下文（如 yondermesh briefing）。
 *
 * 设计原则：
 *   - 与 mcp/register.ts 风格一致：read/write/isRegistered 三段式 API
 *   - 配置文件路径遵循 OpenHands 约定：~/.openhands/config.toml
 *   - 注入幂等：重复调用不堆积
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const SERVER_NAME = 'yondermesh';

/** ~/.openhands 根目录 */
function openhandsRoot(): string {
  return process.env.OPENHANDS_HOME ?? join(homedir(), '.openhands');
}

/** config.toml 路径 */
function configPath(): string {
  return join(openhandsRoot(), 'config.toml');
}

/** skills 目录 */
function skillsDir(): string {
  return join(openhandsRoot(), 'skills');
}

/** 读取 config.toml 全文（不存在返回空串） */
function readConfig(): string {
  const p = configPath();
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

/** 写 config.toml */
function writeConfig(content: string): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf-8');
}

// ─── MCP 注入 ───────────────────────────────────────────────────────────

/** ymesh 入口脚本绝对路径（与 mcp/register.ts 一致） */
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
 * 把 yondermesh MCP server 注册到 OpenHands config.toml。
 * 写入 [mcp.yondermesh] 段（幂等：先 remove 再 add）。
 */
export function registerMcp(ymeshArgs?: string[]): McpRegistrationResult {
  const args = ymeshArgs ?? buildYmeshArgs();
  const nodeBin = resolveNodeBin();
  const entry = args[0] ?? '';
  const rest = args.slice(1);

  const content = readConfig();
  const lines = content.split('\n');
  // 先移除旧块
  const cleaned = removeBlock(lines, `[mcp.${SERVER_NAME}]`);
  // 构建新块
  const block = [
    `[mcp.${SERVER_NAME}]`,
    `command = "${nodeBin}"`,
    `args = ${JSON.stringify([entry, ...rest])}`,
  ];
  cleaned.push('', ...block, '');
  writeConfig(cleaned.join('\n'));
  return { registered: true, path: configPath() };
}

/** 从 config.toml 移除 yondermesh MCP 段（幂等） */
export function unregisterMcp(): boolean {
  const content = readConfig();
  if (!content.includes(`[mcp.${SERVER_NAME}]`)) return false;
  const cleaned = removeBlock(content.split('\n'), `[mcp.${SERVER_NAME}]`);
  writeConfig(cleaned.join('\n'));
  return true;
}

export function isMcpRegistered(): boolean {
  return readConfig().includes(`[mcp.${SERVER_NAME}]`);
}

/** 构建注册用的 ymesh 参数（与 mcp/register.ts.buildYmeshArgs 一致） */
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

// ─── Skills ─────────────────────────────────────────────────────────────

export interface SkillEntry {
  name: string;
  path: string;
  hasSkillMd: boolean;
}

/** 列出 OpenHands 已安装的 skills（~/.openhands/skills/<name>/SKILL.md） */
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
 * 把一个 skill 目录（含 SKILL.md）软链/复制到 ~/.openhands/skills/<name>。
 * 已存在同名 skill 不覆盖（幂等）。
 */
export function installSkill(sourceDir: string, name?: string): { installed: boolean; path: string; reason?: string } {
  const skillName = name ?? sourceDir.split('/').pop() ?? 'skill';
  const target = join(skillsDir(), skillName);
  if (existsSync(target)) {
    return { installed: false, path: target, reason: 'skill already exists' };
  }
  mkdirSync(skillsDir(), { recursive: true });
  // 使用 symlink（与 trae/antigravity skill 机制一致）
  try {
    symlinkSync(sourceDir, target, 'dir');
    return { installed: true, path: target };
  } catch {
    // symlink 失败 → 回退无操作（不递归复制，避免隐式大拷贝）
    return { installed: false, path: target, reason: 'symlink failed' };
  }
}

// ─── Lifecycle Hooks（6 事件） ──────────────────────────────────────────

/** OpenHands 支持的 6 个 lifecycle hook 事件 */
export const OPENHANDS_HOOK_EVENTS = [
  'on_conversation_start',
  'on_conversation_end',
  'on_user_message',
  'on_assistant_message',
  'on_tool_call',
  'on_iteration_end',
] as const;

export type OpenHandsHookEvent = (typeof OPENHANDS_HOOK_EVENTS)[number];

export interface HookConfig {
  event: OpenHandsHookEvent;
  /** 回调 URL，OpenHands 会 POST 事件 payload 到此 URL */
  callbackUrl: string;
}

/**
 * 读取 config.toml 中已注册的 yondermesh hooks。
 * 形态：[[hooks.yondermesh]] 数组段，每项 event + callback_url。
 */
export function listHooks(): HookConfig[] {
  const content = readConfig();
  const hooks: HookConfig[] = [];
  const lines = content.split('\n');
  let inBlock = false;
  let cur: Partial<HookConfig> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === `[[hooks.${SERVER_NAME}]]`) {
      inBlock = true;
      cur = {};
      continue;
    }
    if (inBlock && /^\[/.test(trimmed)) {
      // 块结束
      if (cur.event && cur.callbackUrl) hooks.push(cur as HookConfig);
      inBlock = false;
      cur = {};
    }
    if (inBlock) {
      const m = /^event\s*=\s*"([^"]+)"/.exec(trimmed);
      if (m) cur.event = m[1] as OpenHandsHookEvent;
      const m2 = /^callback_url\s*=\s*"([^"]+)"/.exec(trimmed);
      if (m2) cur.callbackUrl = m2[1];
    }
  }
  if (inBlock && cur.event && cur.callbackUrl) hooks.push(cur as HookConfig);
  return hooks;
}

/**
 * 注册一个 lifecycle hook（幂等：同 event+callbackUrl 不重复）。
 * 写入 [[hooks.yondermesh]] 数组段。
 */
export function registerHook(event: OpenHandsHookEvent, callbackUrl: string): { registered: boolean; path: string } {
  const existing = listHooks();
  if (existing.some((h) => h.event === event && h.callbackUrl === callbackUrl)) {
    return { registered: true, path: configPath() };
  }
  const content = readConfig();
  const lines = content.split('\n');
  // 先移除旧 yondermesh hooks 段
  const cleaned = removeAllHookBlocks(lines);
  // 收集除新加项外的已注册项
  const toWrite = [...existing, { event, callbackUrl }];
  for (const h of toWrite) {
    cleaned.push('', `[[hooks.${SERVER_NAME}]]`, `event = "${h.event}"`, `callback_url = "${h.callbackUrl}"`);
  }
  cleaned.push('');
  writeConfig(cleaned.join('\n'));
  return { registered: true, path: configPath() };
}

/** 移除所有 [[hooks.yondermesh]] 块 */
export function unregisterAllHooks(): boolean {
  const content = readConfig();
  if (!content.includes(`[[hooks.${SERVER_NAME}]]`)) return false;
  const cleaned = removeAllHookBlocks(content.split('\n'));
  writeConfig(cleaned.join('\n'));
  return true;
}

// ─── Always-on context ──────────────────────────────────────────────────

/**
 * 注入常驻上下文（system message / default_agent 提示）。
 * 写入 [default_agent] 段的 system_message 字段（幂等覆盖）。
 *
 * Always-on 上下文用于让每个新 session 都带上 yondermesh briefing，
 * 使 agent 知道它处于 mesh 中、可查询其他 agent 上下文。
 */
export function setAlwaysOnContext(context: string): { set: boolean; path: string } {
  const content = readConfig();
  const lines = content.split('\n');
  const cleaned = removeBlock(lines, `[default_agent]`);
  cleaned.push('', `[default_agent]`, `system_message = ${JSON.stringify(context)}`, '');
  writeConfig(cleaned.join('\n'));
  return { set: true, path: configPath() };
}

export function getAlwaysOnContext(): string | null {
  const content = readConfig();
  const lines = content.split('\n');
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[default_agent]') {
      inBlock = true;
      continue;
    }
    if (inBlock && /^\[/.test(trimmed)) break;
    if (inBlock) {
      const m = /^system_message\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(trimmed);
      if (m) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return null;
}

export function clearAlwaysOnContext(): boolean {
  const content = readConfig();
  if (!content.includes('[default_agent]')) return false;
  const cleaned = removeBlock(content.split('\n'), '[default_agent]');
  writeConfig(cleaned.join('\n'));
  return true;
}

// ─── 组合操作 ───────────────────────────────────────────────────────────

export interface FullInjectResult {
  mcp: McpRegistrationResult;
  skillsInstalled: number;
  hooksRegistered: number;
  alwaysOnSet: boolean;
}

/**
 * 一次性注入全部扩展：MCP + Always-on + 全部 6 个 lifecycle hooks。
 * skills 需单独 installSkill（依赖具体 skill 源目录）。
 */
export function injectAll(opts: {
  ymeshArgs?: string[];
  hookCallbackBaseUrl?: string;
  alwaysOnContext?: string;
}): FullInjectResult {
  const mcp = registerMcp(opts.ymeshArgs);

  let hooksRegistered = 0;
  if (opts.hookCallbackBaseUrl) {
    const base = opts.hookCallbackBaseUrl.replace(/\/+$/, '');
    for (const event of OPENHANDS_HOOK_EVENTS) {
      registerHook(event, `${base}/hooks/${event}`);
      hooksRegistered++;
    }
  }

  let alwaysOnSet = false;
  if (opts.alwaysOnContext !== undefined) {
    const r = setAlwaysOnContext(opts.alwaysOnContext);
    alwaysOnSet = r.set;
  }

  return {
    mcp,
    skillsInstalled: 0,
    hooksRegistered,
    alwaysOnSet,
  };
}

// ─── 内部辅助 ───────────────────────────────────────────────────────────

/**
 * 从行数组中移除指定 section 块（含其子段 [x.y.z]）。
 * sectionHeader 形如 `[mcp.yondermesh]`；匹配该行到下一个同级 `[xxx]` 之间（含子段 `[mcp.yondermesh.env]`）。
 */
function removeBlock(lines: string[], sectionHeader: string): string[] {
  const out: string[] = [];
  let skipping = false;
  const base = sectionHeader.replace(/\].*$/, ''); // `[mcp.yondermesh`
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === sectionHeader || trimmed.startsWith(base + '.')) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^\[/.test(trimmed) && !trimmed.startsWith(base + '.')) {
        skipping = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  // 清理尾部空行
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

/** 移除所有 [[hooks.yondermesh]] 数组项块 */
function removeAllHookBlocks(lines: string[]): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === `[[hooks.${SERVER_NAME}]]`) {
      skipping = true;
      continue;
    }
    if (skipping) {
      // 数组项块到下一个 [[ 或 [ 顶层段结束
      if (/^\[/.test(trimmed)) {
        skipping = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}
