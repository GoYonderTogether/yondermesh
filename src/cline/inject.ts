/**
 * Cline 扩展注入器 —— MCP / Skills / Always-on
 *
 * Cline 是多形态（CLI + VS Code + SDK），扩展落点：
 *   - MCP：~/.cline/data/settings/cline_mcp_settings.json 的 mcpServers 键
 *       （VS Code settings 与 CLI 共用同一配置目录，CLI `cline mcp` 也写此文件）
 *   - Skills：~/.cline/skills/ 或 ~/.agents/skills/（`cline skill` 转发到 npx skills，
 *       默认 --agent cline；本注入器直接 symlink，避免依赖 npx 运行时）
 *   - Always-on：~/.cline/.clinerules（每次 session 启动读取注入到上下文）
 *
 * 设计约束：
 *   - 幂等：mount/unmount 可重复调用，已挂载不堆积（先 remove 再 add）。
 *   - always-on 段落用边界标记包裹（与 mount/strategies.ts 一致），便于精确移除。
 *   - 失败只返回 MountResult，不抛出，便于批量挂载时部分失败不中断。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONTEXT_BLOCK_START, CONTEXT_BLOCK_END } from '../mount/types.js';

/** Cline 默认数据目录 */
const DEFAULT_CLINE_DATA_DIR = path.join(os.homedir(), '.cline');
/** MCP settings 相对路径 */
const CLINE_MCP_SETTINGS_REL = path.join('data', 'settings', 'cline_mcp_settings.json');
/** skills 目录相对路径（cline skill 也用此目录） */
const CLINE_SKILLS_REL = 'skills';
/** always-on 指令文件名（相对数据目录） */
const CLINE_RULES_FILENAME = '.clinerules';
/** 共享 skills 目录（npx skills 默认 --agent cline 也落此） */
const SHARED_AGENTS_SKILLS_DIR = path.join(os.homedir(), '.agents', 'skills');

/** MCP server 定义 */
export interface ClineMcpServerDef {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** 注入结果 */
export interface ClineInjectResult {
  kind: 'mcp' | 'skill' | 'always-on';
  target: string;
  extension: string;
  success: boolean;
  message: string;
}

/** 注入器选项 */
export interface ClineInjectOptions {
  /** Cline 数据目录，默认 ~/.cline */
  dataDir?: string;
}

/** 解析 Cline MCP settings 文件路径 */
export function resolveClineMcpSettingsPath(options: { dataDir?: string } = {}): string {
  const dir = options.dataDir ?? DEFAULT_CLINE_DATA_DIR;
  return path.join(dir, CLINE_MCP_SETTINGS_REL);
}

/** 解析 Cline skills 目录路径 */
export function resolveClineSkillsDir(options: { dataDir?: string } = {}): string {
  const dir = options.dataDir ?? DEFAULT_CLINE_DATA_DIR;
  return path.join(dir, CLINE_SKILLS_REL);
}

/** 解析 Cline always-on 指令文件路径 */
export function resolveClineRulesPath(options: { dataDir?: string } = {}): string {
  const dir = options.dataDir ?? DEFAULT_CLINE_DATA_DIR;
  return path.join(dir, CLINE_RULES_FILENAME);
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
 * Cline 扩展注入器。
 *
 * 用法：
 *   const inj = new ClineInjector();
 *   inj.injectMcp('yondermesh', { command: 'node', args: ['ymesh', 'mcp'] });
 *   inj.injectSkill('skill-creator', '/path/to/skill-dir');
 *   inj.injectAlwaysOn('yondermesh 已就位…');
 *   inj.mountAll({ mcp, skills, contextBlock });
 */
export class ClineInjector {
  private readonly dataDir: string;

  constructor(options: ClineInjectOptions = {}) {
    this.dataDir = options.dataDir ?? DEFAULT_CLINE_DATA_DIR;
  }

  // ─── MCP ─────────────────────────────────────────────────────────────

  /**
   * 向 cline_mcp_settings.json 的 mcpServers 键写入一个 MCP server。
   * 幂等：先移除同名条目再写入。
   */
  injectMcp(name: string, server: ClineMcpServerDef): ClineInjectResult {
    const configPath = resolveClineMcpSettingsPath({ dataDir: this.dataDir });
    try {
      const config = readJsonSafe(configPath);
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers[name] = {
        command: server.command,
        args: server.args,
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      };
      writeJsonSafe(configPath, config);
      return { kind: 'mcp', target: configPath, extension: name, success: true, message: `written to ${configPath}` };
    } catch (e) {
      return { kind: 'mcp', target: configPath, extension: name, success: false, message: String(e) };
    }
  }

  /** 移除一个 MCP server 条目 */
  removeMcp(name: string): ClineInjectResult {
    const configPath = resolveClineMcpSettingsPath({ dataDir: this.dataDir });
    try {
      const config = readJsonSafe(configPath);
      if (config.mcpServers && config.mcpServers[name]) {
        delete config.mcpServers[name];
        writeJsonSafe(configPath, config);
      }
      return { kind: 'mcp', target: configPath, extension: name, success: true, message: `removed from ${configPath}` };
    } catch (e) {
      return { kind: 'mcp', target: configPath, extension: name, success: false, message: String(e) };
    }
  }

  /** 检测 MCP server 是否已挂载 */
  isMcpMounted(name: string): boolean {
    const configPath = resolveClineMcpSettingsPath({ dataDir: this.dataDir });
    const config = readJsonSafe(configPath);
    return !!(config.mcpServers && config.mcpServers[name]);
  }

  // ─── Skills ──────────────────────────────────────────────────────────

  /**
   * 把 skill 目录 symlink 到 ~/.cline/skills/<name>。
   * 优先 symlink 到 ~/.cline/skills/（CLI 本地目录）；
   * 若该目录不可写或不存在则回退 symlink 到 ~/.agents/skills/（共享目录，
   * cline skill 默认 --agent cline 也读此目录）。
   * 幂等：先移除旧链接再创建。
   */
  injectSkill(name: string, skillPath: string): ClineInjectResult {
    const clineSkillsDir = resolveClineSkillsDir({ dataDir: this.dataDir });
    try {
      fs.mkdirSync(clineSkillsDir, { recursive: true });
      const linkPath = path.join(clineSkillsDir, name);
      // 移除旧链接（不管指向哪里）
      try { fs.unlinkSync(linkPath); } catch { try { fs.rmSync(linkPath, { force: true }); } catch { /* */ } }
      fs.symlinkSync(skillPath, linkPath, 'dir');
      return { kind: 'skill', target: linkPath, extension: name, success: true, message: `linked to ${linkPath}` };
    } catch (e) {
      // 回退到共享 ~/.agents/skills/ 目录
      try {
        fs.mkdirSync(SHARED_AGENTS_SKILLS_DIR, { recursive: true });
        const linkPath = path.join(SHARED_AGENTS_SKILLS_DIR, name);
        try { fs.unlinkSync(linkPath); } catch { try { fs.rmSync(linkPath, { force: true }); } catch { /* */ } }
        fs.symlinkSync(skillPath, linkPath, 'dir');
        return { kind: 'skill', target: linkPath, extension: name, success: true, message: `linked to shared ${linkPath}` };
      } catch (e2) {
        return { kind: 'skill', target: clineSkillsDir, extension: name, success: false, message: `${String(e)}; fallback: ${String(e2)}` };
      }
    }
  }

  /** 移除 skill symlink */
  removeSkill(name: string): ClineInjectResult {
    const clineSkillsDir = resolveClineSkillsDir({ dataDir: this.dataDir });
    const linkPath = path.join(clineSkillsDir, name);
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) fs.unlinkSync(linkPath);
      return { kind: 'skill', target: linkPath, extension: name, success: true, message: `unlinked ${linkPath}` };
    } catch {
      // cline 目录无此链接 → 尝试共享目录
      const sharedPath = path.join(SHARED_AGENTS_SKILLS_DIR, name);
      try {
        const stat = fs.lstatSync(sharedPath);
        if (stat.isSymbolicLink()) fs.unlinkSync(sharedPath);
        return { kind: 'skill', target: sharedPath, extension: name, success: true, message: `unlinked shared ${sharedPath}` };
      } catch {
        return { kind: 'skill', target: linkPath, extension: name, success: true, message: 'not mounted' };
      }
    }
  }

  /** 检测 skill 是否已挂载（cline 目录或共享目录任一存在即可） */
  isSkillMounted(name: string): boolean {
    const clineSkillsDir = resolveClineSkillsDir({ dataDir: this.dataDir });
    try {
      const p = path.join(clineSkillsDir, name);
      if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) return true;
    } catch { /* */ }
    try {
      const p = path.join(SHARED_AGENTS_SKILLS_DIR, name);
      if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) return true;
    } catch { /* */ }
    return false;
  }

  // ─── Always-on ───────────────────────────────────────────────────────

  /**
   * 向 ~/.cline/.clinerules 注入一个带边界标记的段落。
   * 每次新 session 启动时 Cline 读取 .clinerules 注入到上下文。
   * 幂等：先移除已有段落再追加。
   */
  injectAlwaysOn(contextBlock: string): ClineInjectResult {
    const rulesPath = resolveClineRulesPath({ dataDir: this.dataDir });
    try {
      let content = readTextSafe(rulesPath);
      content = removeBlock(content);
      const block = `${CONTEXT_BLOCK_START}\n${contextBlock}\n${CONTEXT_BLOCK_END}\n`;
      content = content.trimEnd() + '\n\n' + block;
      fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
      fs.writeFileSync(rulesPath, content, 'utf-8');
      return { kind: 'always-on', target: rulesPath, extension: 'yondermesh-awareness', success: true, message: `injected into ${rulesPath}` };
    } catch (e) {
      return { kind: 'always-on', target: rulesPath, extension: 'yondermesh-awareness', success: false, message: String(e) };
    }
  }

  /** 移除 always-on 段落 */
  removeAlwaysOn(): ClineInjectResult {
    const rulesPath = resolveClineRulesPath({ dataDir: this.dataDir });
    try {
      let content = readTextSafe(rulesPath);
      content = removeBlock(content).trimEnd();
      if (content) content += '\n';
      fs.writeFileSync(rulesPath, content, 'utf-8');
      return { kind: 'always-on', target: rulesPath, extension: 'yondermesh-awareness', success: true, message: `removed from ${rulesPath}` };
    } catch (e) {
      return { kind: 'always-on', target: rulesPath, extension: 'yondermesh-awareness', success: false, message: String(e) };
    }
  }

  /** 检测 always-on 段落是否已注入 */
  isAlwaysOnMounted(): boolean {
    const rulesPath = resolveClineRulesPath({ dataDir: this.dataDir });
    return readTextSafe(rulesPath).includes(CONTEXT_BLOCK_START);
  }

  // ─── 批量 ────────────────────────────────────────────────────────────

  /**
   * 一次性挂载 MCP + Skills + Always-on。
   * 任一失败不中断其余；返回全部结果。
   */
  mountAll(input: {
    mcp?: { name: string; server: ClineMcpServerDef };
    skills?: Array<{ name: string; path: string }>;
    contextBlock?: string;
  }): ClineInjectResult[] {
    const results: ClineInjectResult[] = [];
    if (input.mcp) {
      results.push(this.injectMcp(input.mcp.name, input.mcp.server));
    }
    for (const s of input.skills ?? []) {
      results.push(this.injectSkill(s.name, s.path));
    }
    if (input.contextBlock) {
      results.push(this.injectAlwaysOn(input.contextBlock));
    }
    return results;
  }

  /** 移除全部（按名称） */
  unmountAll(input: {
    mcpName?: string;
    skillNames?: string[];
    alwaysOn?: boolean;
  }): ClineInjectResult[] {
    const results: ClineInjectResult[] = [];
    if (input.mcpName) results.push(this.removeMcp(input.mcpName));
    for (const n of input.skillNames ?? []) results.push(this.removeSkill(n));
    if (input.alwaysOn) results.push(this.removeAlwaysOn());
    return results;
  }
}
