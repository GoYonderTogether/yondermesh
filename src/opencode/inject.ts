/**
 * OpenCode 提示词注入（MCP / Skills / AGENTS.md / Hooks）
 *
 * 把 ymesh 能力注入 OpenCode 运行时，让 OpenCode 的 agent 能发现并调用 ymesh：
 *   - MCP 注入：在 OpenCode 配置的 `mcp` 段注册 ymesh MCP server
 *   - Skills 注入：在 `~/.config/opencode/skills/<name>/SKILL.md` 写入 skill
 *   - Always-on 注入：在 `~/.config/opencode/AGENTS.md` 追加 ymesh 指引段（幂等）
 *   - Hook 注入：在配置注册 lifecycle hooks（SessionStart/SessionEnd 等）
 *
 * 真实位置（本机 v1.17.16 实测，2026-07）：
 *   - 主配置：~/.config/opencode/opencode.jsonc（JSONC，含注释）与
 *     ~/.config/opencode/opencode.json（纯 JSON，含 mcp 段）
 *   - AGENTS.md：~/.config/opencode/AGENTS.md（全局 always-on 指引，已存在）
 *   - skills：~/.config/opencode/skills/<name>/SKILL.md（用户 skill 目录）
 *   - skill 目录内可含 references/ 子目录（参考 OpenCode 官方 cloudflare skill 结构）
 *
 * 设计：
 *   - 幂等：AGENTS.md 用 ymesh 专属标记段（<!-- YMESH_START/END -->）覆盖更新；
 *     MCP/skill 按 name 幂等写入。
 *   - 不破坏用户既有配置：MCP 合并而非覆盖；AGENTS.md 保留非 ymesh 段。
 *   - 零依赖：仅用 node:fs / node:path；JSONC 用内置 strip 处理注释。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** OpenCode 配置目录（XDG：~/.config/opencode） */
export const OPENCODE_CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');
/** 主配置（JSONC，含注释） */
export const OPENCODE_JSONC = path.join(OPENCODE_CONFIG_DIR, 'opencode.jsonc');
/** 纯 JSON 配置（含 mcp 段，优先注入目标，避免破坏 JSONC 注释） */
export const OPENCODE_JSON = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');
/** 全局 always-on 指引文件 */
export const OPENCODE_AGENTS_MD = path.join(OPENCODE_CONFIG_DIR, 'AGENTS.md');
/** 用户 skill 根目录 */
export const OPENCODE_SKILLS_DIR = path.join(OPENCODE_CONFIG_DIR, 'skills');

/** AGENTS.md 中 ymesh 段的边界标记（幂等更新） */
const YMESH_MARK_START = '<!-- YMESH_START -->';
const YMESH_MARK_END = '<!-- YMESH_END -->';

/** MCP server 配置 */
export interface McpServerConfig {
  /** MCP server 名（配置键） */
  name: string;
  /** 启动命令（如 ["node", "/path/to/ymesh-mcp.js"] 或 ["ymesh", "mcp"]） */
  command: string[];
  /** 类型，默认 "local" */
  type?: 'local' | 'remote';
  /** 远程 URL（type=remote 时） */
  url?: string;
  /** 是否启用，默认 true */
  enabled?: boolean;
  /** 环境变量 */
  env?: Record<string, string>;
}

/** Skill 注入选项 */
export interface SkillInjectOptions {
  /** skill 名（目录名），如 "ymesh-handoff" */
  name: string;
  /** SKILL.md 内容（markdown，可含 frontmatter） */
  content: string;
  /** 额外参考文件：相对 skill 目录的路径 → 内容 */
  references?: Record<string, string>;
}

/** Hook 注册（OpenCode 6 个 lifecycle hook） */
export interface HookConfig {
  /** hook 事件：SessionStart / SessionEnd / PreToolUse / PostToolUse / UserPromptSubmit / Stop */
  event:
    | 'session.start'
    | 'session.end'
    | 'tool.pre'
    | 'tool.post'
    | 'prompt.submit'
    | 'stop';
  /** 执行命令 */
  command: string[];
  /** 匹配模式（可选） */
  matcher?: string;
}

/** 注入结果 */
export interface InjectResult {
  /** 注入的文件路径 */
  path: string;
  /** 是否为新建（true）或更新既有（false） */
  created: boolean;
  /** 动作描述 */
  action: string;
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 确保目录存在（递归创建，幂等） */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * strip JSONC 注释与尾随逗号，返回可被 JSON.parse 的纯 JSON 文本。
 * 处理：// 行注释、/* 块注释、尾随逗号。
 * 保守实现：不在字符串内部误删。
 */
function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    // 字符串内部：原样输出，注意转义
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += next!;
        i += 2;
        continue;
      }
      if (c === stringChar) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      i++;
      continue;
    }
    // 行注释 // ...
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    // 块注释 /* ... */
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // 去尾随逗号：,] 或 ,}
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** 安全读 JSON（或 JSONC）文件；不存在返回 undefined */
function readJsonSafe(filePath: string): unknown | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(stripJsonc(raw));
  } catch (e) {
    throw new Error(`解析 JSONC 失败 ${filePath}: ${errorMessage(e)}`);
  }
}

/** 原子写文件（先写临时文件再 rename，避免半写） */
function writeFileAtomic(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-ymesh`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ─── MCP 注入 ────────────────────────────────────────────────────────────

/**
 * 注入 MCP server 到 OpenCode 配置（opencode.json 的 mcp 段，幂等按 name）。
 * 优先写 opencode.json（纯 JSON，不破坏 jsonc 注释）；不存在则创建。
 */
export function injectMcp(config: McpServerConfig): InjectResult {
  const existed = fs.existsSync(OPENCODE_JSON);
  const root = (readJsonSafe(OPENCODE_JSON) as Record<string, unknown> | undefined) ?? {};
  const mcp = (root.mcp as Record<string, unknown> | undefined) ?? {};
  mcp[config.name] = {
    type: config.type ?? 'local',
    command: config.command,
    enabled: config.enabled ?? true,
    ...(config.url ? { url: config.url } : {}),
    ...(config.env ? { env: config.env } : {}),
  };
  root.mcp = mcp;
  writeFileAtomic(OPENCODE_JSON, JSON.stringify(root, null, 2) + '\n');
  return {
    path: OPENCODE_JSON,
    created: !existed,
    action: `MCP server "${config.name}" ${existed ? '更新' : '注册'}`,
  };
}

/** 移除已注入的 MCP server（按 name） */
export function removeMcp(name: string): InjectResult {
  const root = readJsonSafe(OPENCODE_JSON) as Record<string, unknown> | undefined;
  const mcp = root?.mcp as Record<string, unknown> | undefined;
  if (mcp && mcp[name]) {
    delete mcp[name];
    root!.mcp = mcp;
    writeFileAtomic(OPENCODE_JSON, JSON.stringify(root, null, 2) + '\n');
    return { path: OPENCODE_JSON, created: false, action: `MCP server "${name}" 已移除` };
  }
  return { path: OPENCODE_JSON, created: false, action: `MCP server "${name}" 不存在（无需移除）` };
}

// ─── Skills 注入 ─────────────────────────────────────────────────────────

/**
 * 注入 skill：在 ~/.config/opencode/skills/<name>/SKILL.md 写入内容。
 * 幂等：同名 skill 覆盖更新；references 同步写入。
 */
export function injectSkill(options: SkillInjectOptions): InjectResult {
  const skillDir = path.join(OPENCODE_SKILLS_DIR, options.name);
  const skillFile = path.join(skillDir, 'SKILL.md');
  const existed = fs.existsSync(skillFile);
  ensureDir(skillDir);
  writeFileAtomic(skillFile, options.content);
  // 写参考文件
  if (options.references) {
    for (const [rel, content] of Object.entries(options.references)) {
      const refPath = path.join(skillDir, rel);
      writeFileAtomic(refPath, content);
    }
  }
  return {
    path: skillFile,
    created: !existed,
    action: `skill "${options.name}" ${existed ? '更新' : '创建'}`,
  };
}

/** 移除 skill（删除整个目录） */
export function removeSkill(name: string): InjectResult {
  const skillDir = path.join(OPENCODE_SKILLS_DIR, name);
  if (!fs.existsSync(skillDir)) {
    return { path: skillDir, created: false, action: `skill "${name}" 不存在` };
  }
  fs.rmSync(skillDir, { recursive: true, force: true });
  return { path: skillDir, created: false, action: `skill "${name}" 已移除` };
}

// ─── AGENTS.md 注入 ──────────────────────────────────────────────────────

/**
 * 注入 always-on 指引到 AGENTS.md（幂等）。
 * ymesh 段用 YMESH_MARK_START / YMESH_MARK_END 包裹；重复调用只更新段内内容，
 * 保留文件其余部分（用户手动编辑 / 其他工具注入的段）。
 * 文件不存在时创建。
 */
export function injectAgentsMd(content: string): InjectResult {
  const existed = fs.existsSync(OPENCODE_AGENTS_MD);
  const block = `${YMESH_MARK_START}\n${content}\n${YMESH_MARK_END}`;
  let raw: string;
  try {
    raw = fs.readFileSync(OPENCODE_AGENTS_MD, 'utf8');
  } catch {
    // 文件不存在 → 直接写 ymesh 段
    writeFileAtomic(OPENCODE_AGENTS_MD, `${block}\n`);
    return { path: OPENCODE_AGENTS_MD, created: true, action: 'AGENTS.md 创建并注入 ymesh 段' };
  }
  const startIdx = raw.indexOf(YMESH_MARK_START);
  const endIdx = raw.indexOf(YMESH_MARK_END);
  let next: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // 已有 ymesh 段 → 替换段内内容
    next = raw.slice(0, startIdx) + block + raw.slice(endIdx + YMESH_MARK_END.length);
  } else {
    // 标记缺失或损坏 → 追加到文件末尾
    next = raw.endsWith('\n') ? raw + '\n' + block + '\n' : raw + '\n\n' + block + '\n';
  }
  writeFileAtomic(OPENCODE_AGENTS_MD, next);
  return {
    path: OPENCODE_AGENTS_MD,
    created: !existed,
    action: existed ? 'AGENTS.md ymesh 段更新' : 'AGENTS.md ymesh 段追加',
  };
}

/** 移除 AGENTS.md 中的 ymesh 段（保留其余内容） */
export function removeAgentsMd(): InjectResult {
  if (!fs.existsSync(OPENCODE_AGENTS_MD)) {
    return { path: OPENCODE_AGENTS_MD, created: false, action: 'AGENTS.md 不存在' };
  }
  const raw = fs.readFileSync(OPENCODE_AGENTS_MD, 'utf8');
  const startIdx = raw.indexOf(YMESH_MARK_START);
  const endIdx = raw.indexOf(YMESH_MARK_END);
  if (startIdx === -1 || endIdx === -1) {
    return { path: OPENCODE_AGENTS_MD, created: false, action: 'AGENTS.md 无 ymesh 段' };
  }
  const before = raw.slice(0, startIdx);
  const after = raw.slice(endIdx + YMESH_MARK_END.length);
  const next = (before + after).replace(/\n{3,}/g, '\n\n');
  writeFileAtomic(OPENCODE_AGENTS_MD, next);
  return { path: OPENCODE_AGENTS_MD, created: false, action: 'AGENTS.md ymesh 段已移除' };
}

// ─── Hooks 注入 ──────────────────────────────────────────────────────────

/**
 * 注入 lifecycle hooks 到 OpenCode 配置（opencode.json 的 hooks 段，幂等）。
 *
 * 写 opencode.json（纯 JSON）而非 opencode.jsonc，避免破坏 jsonc 注释。
 * OpenCode 会合并两份配置。config 顶层 hooks 段为前向兼容写入
 * （若 schema 不识别则被忽略，不报错）。每个 hook 按 event+command 去重。
 */
export function injectHooks(hooks: HookConfig[]): InjectResult[] {
  const existed = fs.existsSync(OPENCODE_JSON);
  const root = (readJsonSafe(OPENCODE_JSON) as Record<string, unknown> | undefined) ?? {};
  const existingHooks = (root.hooks as Record<string, unknown[]> | undefined) ?? {};
  const result: InjectResult[] = [];

  for (const h of hooks) {
    const list = (existingHooks[h.event] as unknown[] | undefined) ?? [];
    // 去重：command 数组字符串化后比较
    const sig = JSON.stringify(h.command);
    const dup = list.some(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        JSON.stringify((e as { command?: unknown }).command) === sig,
    );
    if (!dup) {
      list.push({
        command: h.command,
        ...(h.matcher ? { matcher: h.matcher } : {}),
      });
      existingHooks[h.event] = list;
    }
    result.push({
      path: OPENCODE_JSON,
      created: !existed,
      action: `hook "${h.event}" ${dup ? '已存在' : '注册'}`,
    });
  }
  root.hooks = existingHooks;
  writeFileAtomic(OPENCODE_JSON, JSON.stringify(root, null, 2) + '\n');
  return result;
}

// ─── 一键全注入 ──────────────────────────────────────────────────────────

/** 全量注入选项 */
export interface InjectAllOptions {
  /** ymesh MCP server 配置；不传则用默认 [ymesh, mcp] */
  mcp?: McpServerConfig;
  /** AGENTS.md 指引内容；不传则用默认 ymesh 指引 */
  agentsMd?: string;
  /** 要注入的 hooks；不传则跳过 hooks */
  hooks?: HookConfig[];
}

/** 默认 AGENTS.md 指引内容 */
export const DEFAULT_AGENTS_MD = `## ymesh (YonderMesh)

ymesh is a self-hosted Agent Context Bus. To leverage cross-session / cross-device context:

- **Query sessions**: Use the ymesh MCP tools to search sessions across all your agents
  (Claude Code, Codex, OpenCode, ...) by cwd, time, model, or topology.
- **Hand off tasks**: Use ymesh to transfer session context to another agent or device.
- **Discover active sessions**: Query ymesh for currently-live sessions before starting
  redundant work.

When the user asks about other agents' work, prior sessions, or cross-device context,
reach for ymesh MCP tools BEFORE re-reading files or re-running searches.`;

/**
 * 一键全量注入（MCP + AGENTS.md + Hooks）。
 * 幂等：可安全重复调用。返回各步结果。
 */
export function injectAll(options: InjectAllOptions = {}): InjectResult[] {
  const results: InjectResult[] = [];
  const mcp = options.mcp ?? {
    name: 'ymesh',
    command: ['ymesh', 'mcp'],
    type: 'local' as const,
    enabled: true,
  };
  results.push(injectMcp(mcp));
  results.push(injectAgentsMd(options.agentsMd ?? DEFAULT_AGENTS_MD));
  if (options.hooks && options.hooks.length > 0) {
    results.push(...injectHooks(options.hooks));
  }
  return results;
}
