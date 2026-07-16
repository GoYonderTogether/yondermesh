/**
 * Crush 扩展注入器 —— MCP / Skills / Always-on / Hook
 *
 * Crush（Charm）扩展落点：
 *   - MCP：crush.json 的 `mcp` 键（格式 { "name": { type, command, args, timeout } }）
 *   - Skills：~/.agents/skills/（自动发现，symlink；Crush 与 Cline 共享此目录）
 *   - Always-on：~/.config/crush/CRUSH.md（每次 session 启动读取注入上下文）
 *   - Hook：crush.json 的 `hooks` 键，PreToolUse（Claude Code 兼容）
 *
 * crush.json 位置：默认 ~/.config/crush/crush.json（全局），可经 configPath 选项指定
 * 项目级路径。Crush 会合并全局与项目级配置。
 *
 * 设计约束：
 *   - 幂等：mount/unmount 可重复调用，已挂载不堆积（先 remove 再 add）。
 *   - always-on 段落用边界标记包裹（与 mount/strategies.ts 一致），便于精确移除。
 *   - Hook 按 name 去重，避免重复堆积同名 hook。
 *   - 失败只返回结果对象，不抛出，便于批量挂载时部分失败不中断。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONTEXT_BLOCK_START, CONTEXT_BLOCK_END } from '../mount/types.js';

/** Crush 默认配置目录（~/.config/crush） */
export const DEFAULT_CRUSH_CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? ''}/.config`,
  'crush',
);
/** crush.json 文件名 */
const CRUSH_JSON_FILENAME = 'crush.json';
/** always-on 指令文件名（相对配置目录） */
const CRUSH_MD_FILENAME = 'CRUSH.md';
/** 共享 skills 目录（Crush 自动发现） */
const SHARED_AGENTS_SKILLS_DIR = path.join(process.env.HOME ?? '', '.agents', 'skills');

/** MCP server 定义（crush.json mcp 键的值） */
export interface CrushMcpServerDef {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** 超时秒数，默认 30 */
  timeout?: number;
}

/** Hook 定义（PreToolUse 等，Claude Code 兼容） */
export interface CrushHookDef {
  /** hook 名称（用作去重键） */
  name: string;
  /** 工具名匹配正则，如 "^bash$" */
  matcher?: string;
  /** 执行命令 */
  command: string;
}

/** 注入结果 */
export interface CrushInjectResult {
  kind: 'mcp' | 'skill' | 'always-on' | 'hook';
  target: string;
  extension: string;
  success: boolean;
  message: string;
}

/** 注入器选项 */
export interface CrushInjectOptions {
  /** Crush 配置目录，默认 ~/.config/crush */
  configDir?: string;
  /** 直接指定 crush.json 路径，优先级最高（覆盖 configDir） */
  configPath?: string;
}

/** 解析 crush.json 路径：configPath 选项 > configDir 拼接 */
export function resolveCrushJsonPath(options: { configPath?: string; configDir?: string } = {}): string {
  if (options.configPath) return options.configPath;
  const dir = options.configDir ?? DEFAULT_CRUSH_CONFIG_DIR;
  return path.join(dir, CRUSH_JSON_FILENAME);
}

/** 解析 Crush always-on 指令文件路径 */
export function resolveCrushMdPath(options: { configDir?: string } = {}): string {
  const dir = options.configDir ?? DEFAULT_CRUSH_CONFIG_DIR;
  return path.join(dir, CRUSH_MD_FILENAME);
}

/** 安全读 JSON：失败返回空对象 */
function readJsonSafe(filePath: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

/** 安全写 JSON（自动建目录，2 空格缩进 + 尾换行） */
function writeJsonSafe(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** 安全读文本：失败返回空串 */
function readTextSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/** 移除 always-on 边界标记段落 */
function removeBlock(content: string): string {
  const startIdx = content.indexOf(CONTEXT_BLOCK_START);
  if (startIdx === -1) return content;
  const endIdx = content.indexOf(CONTEXT_BLOCK_END);
  if (endIdx === -1) return content; // 残缺标记不处理
  let before = content.slice(0, startIdx).trimEnd();
  let after = content.slice(endIdx + CONTEXT_BLOCK_END.length).replace(/^\s*\n/, '');
  if (before && after) return before + '\n\n' + after;
  return before + after;
}

/**
 * Crush 扩展注入器。
 *
 * 用法：
 *   const inj = new CrushInjector();
 *   inj.injectMcp('yondermesh', { command: 'node', args: ['ymesh', 'mcp'] });
 *   inj.injectSkill('skill-creator', '/path/to/skill-dir');
 *   inj.injectAlwaysOn('yondermesh 已就位…');
 *   inj.injectHook('PreToolUse', { name: 'ymesh-audit', matcher: '^bash$', command: '...' });
 *   inj.mountAll({ mcp, skills, contextBlock, hooks });
 */
export class CrushInjector {
  private readonly configDir: string;
  private readonly configPath: string;

  constructor(options: CrushInjectOptions = {}) {
    this.configDir = options.configDir ?? DEFAULT_CRUSH_CONFIG_DIR;
    this.configPath = options.configPath ?? path.join(this.configDir, CRUSH_JSON_FILENAME);
  }

  // ─── MCP ─────────────────────────────────────────────────────────────

  /**
   * 向 crush.json 的 `mcp` 键写入一个 MCP server。
   * crush mcp 格式：{ "name": { "type": "stdio", "command", "args", "timeout" } }
   * 幂等：先移除同名条目再写入。
   */
  injectMcp(name: string, server: CrushMcpServerDef): CrushInjectResult {
    try {
      const config = readJsonSafe(this.configPath);
      if (!config.mcp) config.mcp = {};
      config.mcp[name] = {
        type: 'stdio',
        command: server.command,
        args: server.args,
        timeout: server.timeout ?? 30,
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      };
      writeJsonSafe(this.configPath, config);
      return { kind: 'mcp', target: this.configPath, extension: name, success: true, message: `written to ${this.configPath}` };
    } catch (e) {
      return { kind: 'mcp', target: this.configPath, extension: name, success: false, message: String(e) };
    }
  }

  /** 移除一个 MCP server 条目 */
  removeMcp(name: string): CrushInjectResult {
    try {
      const config = readJsonSafe(this.configPath);
      if (config.mcp && config.mcp[name]) {
        delete config.mcp[name];
        writeJsonSafe(this.configPath, config);
      }
      return { kind: 'mcp', target: this.configPath, extension: name, success: true, message: `removed from ${this.configPath}` };
    } catch (e) {
      return { kind: 'mcp', target: this.configPath, extension: name, success: false, message: String(e) };
    }
  }

  /** 检测 MCP server 是否已挂载 */
  isMcpMounted(name: string): boolean {
    const config = readJsonSafe(this.configPath);
    return !!(config.mcp && config.mcp[name]);
  }

  // ─── Skills ──────────────────────────────────────────────────────────

  /**
   * 把 skill 目录 symlink 到 ~/.agents/skills/<name>（Crush 自动发现此目录）。
   * 幂等：先移除旧链接再创建。
   */
  injectSkill(name: string, skillPath: string): CrushInjectResult {
    try {
      fs.mkdirSync(SHARED_AGENTS_SKILLS_DIR, { recursive: true });
      const linkPath = path.join(SHARED_AGENTS_SKILLS_DIR, name);
      // 移除旧链接（不管指向哪里）
      try { fs.unlinkSync(linkPath); } catch { try { fs.rmSync(linkPath, { force: true }); } catch { /* */ } }
      fs.symlinkSync(skillPath, linkPath, 'dir');
      return { kind: 'skill', target: linkPath, extension: name, success: true, message: `linked to ${linkPath}` };
    } catch (e) {
      return { kind: 'skill', target: SHARED_AGENTS_SKILLS_DIR, extension: name, success: false, message: String(e) };
    }
  }

  /** 移除 skill symlink */
  removeSkill(name: string): CrushInjectResult {
    const linkPath = path.join(SHARED_AGENTS_SKILLS_DIR, name);
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) fs.unlinkSync(linkPath);
      return { kind: 'skill', target: linkPath, extension: name, success: true, message: `unlinked ${linkPath}` };
    } catch {
      return { kind: 'skill', target: linkPath, extension: name, success: true, message: 'not mounted' };
    }
  }

  /** 检测 skill 是否已挂载 */
  isSkillMounted(name: string): boolean {
    try {
      const p = path.join(SHARED_AGENTS_SKILLS_DIR, name);
      return fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  }

  // ─── Always-on ───────────────────────────────────────────────────────

  /**
   * 向 ~/.config/crush/CRUSH.md 注入一个带边界标记的段落。
   * 每次新 session 启动时 Crush 读取 CRUSH.md 注入到上下文。
   * 幂等：先移除已有段落再追加。
   */
  injectAlwaysOn(contextBlock: string): CrushInjectResult {
    const mdPath = resolveCrushMdPath({ configDir: this.configDir });
    try {
      let content = readTextSafe(mdPath);
      content = removeBlock(content);
      const block = `${CONTEXT_BLOCK_START}\n${contextBlock}\n${CONTEXT_BLOCK_END}\n`;
      content = content.trimEnd() + '\n\n' + block;
      fs.mkdirSync(path.dirname(mdPath), { recursive: true });
      fs.writeFileSync(mdPath, content, 'utf-8');
      return { kind: 'always-on', target: mdPath, extension: 'yondermesh-awareness', success: true, message: `injected into ${mdPath}` };
    } catch (e) {
      return { kind: 'always-on', target: mdPath, extension: 'yondermesh-awareness', success: false, message: String(e) };
    }
  }

  /** 移除 always-on 段落 */
  removeAlwaysOn(): CrushInjectResult {
    const mdPath = resolveCrushMdPath({ configDir: this.configDir });
    try {
      let content = readTextSafe(mdPath);
      content = removeBlock(content).trimEnd();
      if (content) content += '\n';
      fs.writeFileSync(mdPath, content, 'utf-8');
      return { kind: 'always-on', target: mdPath, extension: 'yondermesh-awareness', success: true, message: `removed from ${mdPath}` };
    } catch (e) {
      return { kind: 'always-on', target: mdPath, extension: 'yondermesh-awareness', success: false, message: String(e) };
    }
  }

  /** 检测 always-on 段落是否已注入 */
  isAlwaysOnMounted(): boolean {
    const mdPath = resolveCrushMdPath({ configDir: this.configDir });
    return readTextSafe(mdPath).includes(CONTEXT_BLOCK_START);
  }

  // ─── Hook（PreToolUse，Claude Code 兼容） ─────────────────────────────

  /**
   * 向 crush.json 的 `hooks.<event>` 数组写入一个 hook。
   * Crush 的 hooks 格式（Claude Code 兼容）：
   *   { "hooks": { "PreToolUse": [ { name, matcher, command } ] } }
   * 按 name 去重：先移除同名 hook 再追加。
   */
  injectHook(event: string, hook: CrushHookDef): CrushInjectResult {
    try {
      const config = readJsonSafe(this.configPath);
      if (!config.hooks) config.hooks = {};
      if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
      const arr = config.hooks[event] as Array<Record<string, unknown>>;
      // 按 name 去重
      const filtered = arr.filter((h) => h.name !== hook.name);
      const entry: Record<string, unknown> = { name: hook.name, command: hook.command };
      if (hook.matcher) entry.matcher = hook.matcher;
      filtered.push(entry);
      config.hooks[event] = filtered;
      writeJsonSafe(this.configPath, config);
      return { kind: 'hook', target: this.configPath, extension: `${event}:${hook.name}`, success: true, message: `written to ${this.configPath}` };
    } catch (e) {
      return { kind: 'hook', target: this.configPath, extension: `${event}:${hook.name}`, success: false, message: String(e) };
    }
  }

  /** 移除一个 hook（按 event + name） */
  removeHook(event: string, name: string): CrushInjectResult {
    try {
      const config = readJsonSafe(this.configPath);
      if (config.hooks && Array.isArray(config.hooks[event])) {
        config.hooks[event] = (config.hooks[event] as Array<Record<string, unknown>>)
          .filter((h) => h.name !== name);
        if ((config.hooks[event] as unknown[]).length === 0) delete config.hooks[event];
        writeJsonSafe(this.configPath, config);
      }
      return { kind: 'hook', target: this.configPath, extension: `${event}:${name}`, success: true, message: `removed from ${this.configPath}` };
    } catch (e) {
      return { kind: 'hook', target: this.configPath, extension: `${event}:${name}`, success: false, message: String(e) };
    }
  }

  /** 检测 hook 是否已挂载（按 event + name） */
  isHookMounted(event: string, name: string): boolean {
    const config = readJsonSafe(this.configPath);
    if (!config.hooks || !Array.isArray(config.hooks[event])) return false;
    return (config.hooks[event] as Array<Record<string, unknown>>).some((h) => h.name === name);
  }

  // ─── 批量 ────────────────────────────────────────────────────────────

  /**
   * 一次性挂载 MCP + Skills + Always-on + Hooks。
   * 任一失败不中断其余；返回全部结果。
   */
  mountAll(input: {
    mcp?: { name: string; server: CrushMcpServerDef };
    skills?: Array<{ name: string; path: string }>;
    contextBlock?: string;
    hooks?: Array<{ event: string; hook: CrushHookDef }>;
  }): CrushInjectResult[] {
    const results: CrushInjectResult[] = [];
    if (input.mcp) {
      results.push(this.injectMcp(input.mcp.name, input.mcp.server));
    }
    for (const s of input.skills ?? []) {
      results.push(this.injectSkill(s.name, s.path));
    }
    if (input.contextBlock) {
      results.push(this.injectAlwaysOn(input.contextBlock));
    }
    for (const h of input.hooks ?? []) {
      results.push(this.injectHook(h.event, h.hook));
    }
    return results;
  }

  /** 移除全部（按名称） */
  unmountAll(input: {
    mcpName?: string;
    skillNames?: string[];
    alwaysOn?: boolean;
    hooks?: Array<{ event: string; name: string }>;
  }): CrushInjectResult[] {
    const results: CrushInjectResult[] = [];
    if (input.mcpName) results.push(this.removeMcp(input.mcpName));
    for (const n of input.skillNames ?? []) results.push(this.removeSkill(n));
    if (input.alwaysOn) results.push(this.removeAlwaysOn());
    for (const h of input.hooks ?? []) results.push(this.removeHook(h.event, h.name));
    return results;
  }
}
