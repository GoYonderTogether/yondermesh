/**
 * Copilot CLI / SDK 扩展注入 —— MCP / Skills / Hooks / Always-on
 *
 * 把 yondermesh 提供的能力（MCP server、skill、always-on 上下文、8 个 hook 回调）
 * 注入到 ~/.copilot/ 配置中，让本机所有 Copilot session 自动获得 yondermesh 视野。
 *
 * 注入位置（D1-D10 中 D5 hooks / D9 MCP 注入）：
 *   1. MCP        ~/.copilot/mcp-config.json   —— 写入 mcpServers.{name}（JSON 合并）
 *   2. Skills     ~/.copilot/skills/<name>     —— symlink 到 yondermesh release 的 skill 目录
 *                                                  （Copilot 当前未官方支持 skills/，预留目录；
 *                                                   实际加载需通过 --additional-mcp-config 或
 *                                                   由 launch 时显式指定）
 *   3. Hooks      ~/.copilot/hooks.json        —— 8 个 hookType → yondermesh 回调命令
 *                                                  （Copilot 1.0.x 尚未读取此文件；预留配置
 *                                                   供未来版本或 daemon 直接订阅 events.jsonl 用）
 *   4. Always-on  ~/.copilot/AGENTS.md         —— 注入 yondermesh awareness 段落
 *                  或 COPILOT_SYSTEM_PROMPT env —— 仅对 launch() 子进程生效（不污染全局）
 *
 * 设计取舍：
 *   - 幂等：所有写入可重复执行，旧段落 / 旧 entry 自动覆盖
 *   - 不破坏既有配置：mcp-config.json 与 AGENTS.md 采用"段落边界"安全替换
 *   - 反向操作：每个 inject* 都有对应的 uninject*，便于 uninstall
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { COPILOT_HOOK_TYPES, resolveCopilotHomePath } from './importer.js';

/** inject 选项 */
export interface CopilotInjectOptions {
  /** Copilot home 目录，默认 ~/.copilot */
  homePath?: string;
}

/** MCP server 定义（与 mount/types.ts McpServerDef 同构） */
export interface CopilotMcpServerDef {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Skill 注入定义 */
export interface CopilotSkillDef {
  /** skill 名（symlink 文件名） */
  name: string;
  /** symlink 指向的真实 skill 目录绝对路径 */
  targetPath: string;
}

/** Hook 回调定义 */
export interface CopilotHookDef {
  /** hook 类型（8 种之一） */
  hookType: (typeof COPILOT_HOOK_TYPES)[number];
  /** 触发时执行的命令（如 `ymesh hook copilot sessionStart`） */
  command: string;
  /** 超时（毫秒），默认 5000 */
  timeoutMs?: number;
}

/** always-on 上下文段落定义 */
export interface CopilotAlwaysOnDef {
  /** 段落内容（Markdown 文本，会嵌入到 AGENTS.md 中） */
  block: string;
  /** 段落标识（用于幂等替换，默认 'yondermesh'） */
  id?: string;
}

/** 注入结果 */
export interface CopilotInjectResult {
  /** 注入类型 */
  kind: 'mcp' | 'skill' | 'hooks' | 'always-on';
  /** 目标文件 / 路径 */
  target: string;
  /** 是否成功 */
  success: boolean;
  /** 详情 / 错误信息 */
  message: string;
}

/** always-on 段落边界标记（与 mount/types.ts 同源） */
export const YONDERMESH_BLOCK_START = '<!-- YONDERMESH_AWARENESS_START -->';
export const YONDERMESH_BLOCK_END = '<!-- YONDERMESH_AWARENESS_END -->';

const MCP_CONFIG_FILENAME = 'mcp-config.json';
const SKILLS_DIRNAME = 'skills';
const HOOKS_CONFIG_FILENAME = 'hooks.json';
const AGENTS_MD_FILENAME = 'AGENTS.md';

/** 安全读取 JSON 文件（不存在 / 损坏 → 返回空对象） */
function readJsonSafe(filePath: string): Record<string, unknown> {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 安全写入 JSON 文件（带格式化） */
function writeJsonSafe(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** 安全读取文本文件（不存在 → 空串） */
function readTextSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** 在文本中替换 yondermesh 段落（幂等） */
function replaceBlock(content: string, blockId: string, newBlock: string | null): string {
  const startMarker = `<!-- YONDERMESH_${blockId.toUpperCase()}_START -->`;
  const endMarker = `<!-- YONDERMESH_${blockId.toUpperCase()}_END -->`;
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx >= 0 && endIdx > startIdx) {
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + endMarker.length);
    if (newBlock === null) {
      return (before + after).replace(/^\n+/, '').replace(/\n+$/, '\n');
    }
    return `${before}${startMarker}\n${newBlock}\n${endMarker}${after}`;
  }
  if (newBlock === null) return content;
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n\n' : '\n';
  return `${content}${prefix}${startMarker}\n${newBlock}\n${endMarker}\n`;
}

/**
 * Copilot 扩展注入器。
 *
 * 用法：
 *   const inj = new CopilotInjector();
 *   await inj.injectMcp('yondermesh', { command: 'ymesh', args: ['mcp', 'serve'] });
 *   await inj.injectAlwaysOn({ block: '## yondermesh awareness\n...' });
 *   await inj.injectHooks([
 *     { hookType: 'sessionStart', command: 'ymesh hook copilot sessionStart' },
 *     ...
 *   ]);
 *   await inj.injectSkill({ name: 'ymesh-awareness', targetPath: '/path/to/skill' });
 */
export class CopilotInjector {
  readonly options: Required<CopilotInjectOptions>;

  constructor(options: CopilotInjectOptions = {}) {
    this.options = {
      homePath: options.homePath ?? resolveCopilotHomePath(),
    };
  }

  /** ~/.copilot/ 根目录 */
  get homePath(): string {
    return this.options.homePath;
  }

  /** mcp-config.json 完整路径 */
  get mcpConfigPath(): string {
    return path.join(this.homePath, MCP_CONFIG_FILENAME);
  }

  /** skills 目录绝对路径（~/.copilot/skills/） */
  get skillsDir(): string {
    return path.join(this.homePath, SKILLS_DIRNAME);
  }

  /** hooks.json 完整路径 */
  get hooksConfigPath(): string {
    return path.join(this.homePath, HOOKS_CONFIG_FILENAME);
  }

  /** AGENTS.md 完整路径 */
  get agentsMdPath(): string {
    return path.join(this.homePath, AGENTS_MD_FILENAME);
  }

  // ─── MCP 注入 ───────────────────────────────────────────────────────

  /**
   * 注入一个 MCP server 到 ~/.copilot/mcp-config.json。
   * 文件格式：{ "mcpServers": { "<name>": { command, args, env } } }
   * 幂等：同名 entry 覆盖；文件不存在自动创建。
   */
  injectMcp(name: string, server: CopilotMcpServerDef): CopilotInjectResult {
    const target = this.mcpConfigPath;
    try {
      const config = readJsonSafe(target);
      if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        config.mcpServers = {};
      }
      (config.mcpServers as Record<string, CopilotMcpServerDef>)[name] = server;
      writeJsonSafe(target, config);
      return {
        kind: 'mcp',
        target,
        success: true,
        message: `mcpServers.${name} written to ${target}`,
      };
    } catch (e) {
      return {
        kind: 'mcp',
        target,
        success: false,
        message: String(e),
      };
    }
  }

  /**
   * 移除一个 MCP server。
   * 幂等：name 不存在也返回 success=true。
   */
  uninjectMcp(name: string): CopilotInjectResult {
    const target = this.mcpConfigPath;
    try {
      const config = readJsonSafe(target);
      const servers = config.mcpServers as Record<string, unknown> | undefined;
      if (servers && servers[name]) {
        delete servers[name];
        writeJsonSafe(target, config);
        return { kind: 'mcp', target, success: true, message: `mcpServers.${name} removed` };
      }
      return { kind: 'mcp', target, success: true, message: `mcpServers.${name} not present` };
    } catch (e) {
      return { kind: 'mcp', target, success: false, message: String(e) };
    }
  }

  /** 判定某个 MCP server 是否已注入 */
  isMcpInjected(name: string): boolean {
    const config = readJsonSafe(this.mcpConfigPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return !!(servers && servers[name]);
  }

  // ─── Skills 注入 ─────────────────────────────────────────────────────

  /**
   * 注入一个 skill：在 ~/.copilot/skills/<name> 创建 symlink 指向 targetPath。
   *
   * 注意：Copilot 1.0.x 当前未官方读取 ~/.copilot/skills/ 目录（无原生 skill 概念）。
   * 此方法预留目录结构，便于未来 Copilot 支持 skill 或通过 --additional-mcp-config
   * 显式加载。当前实际生效需通过 launch() 时显式传 --additional-mcp-config @<path>。
   *
   * 幂等：旧 symlink 删除后重建；targetPath 不存在时失败。
   */
  injectSkill(skill: CopilotSkillDef): CopilotInjectResult {
    const skillsDir = this.skillsDir;
    const linkPath = path.join(skillsDir, skill.name);
    try {
      if (!fs.existsSync(skill.targetPath)) {
        return {
          kind: 'skill',
          target: linkPath,
          success: false,
          message: `skill target 不存在: ${skill.targetPath}`,
        };
      }
      fs.mkdirSync(skillsDir, { recursive: true });
      // 已存在则先删除（用 unlinkSync 而非 rmSync，避免 rmSync 跟随 symlink
      // 把 target 目录当成需要 recursive 删除的目录而抛 EISDIR）
      try {
        fs.unlinkSync(linkPath);
      } catch {
        // 不存在 → 忽略
      }
      fs.symlinkSync(skill.targetPath, linkPath, 'dir');
      return {
        kind: 'skill',
        target: linkPath,
        success: true,
        message: `symlink ${linkPath} -> ${skill.targetPath}`,
      };
    } catch (e) {
      return {
        kind: 'skill',
        target: linkPath,
        success: false,
        message: String(e),
      };
    }
  }

  /** 移除一个 skill symlink */
  uninjectSkill(name: string): CopilotInjectResult {
    const linkPath = path.join(this.skillsDir, name);
    try {
      fs.unlinkSync(linkPath);
      return { kind: 'skill', target: linkPath, success: true, message: `removed ${linkPath}` };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { kind: 'skill', target: linkPath, success: true, message: `not present: ${linkPath}` };
      }
      return { kind: 'skill', target: linkPath, success: false, message: String(e) };
    }
  }

  /** 判定某个 skill 是否已注入 */
  isSkillInjected(name: string): boolean {
    try {
      return fs.lstatSync(path.join(this.skillsDir, name)).isSymbolicLink();
    } catch {
      return false;
    }
  }

  // ─── Hooks 注入（8 个 hookType） ─────────────────────────────────────

  /**
   * 批量注入 8 个 hook 回调到 ~/.copilot/hooks.json。
   *
   * 文件格式：
   *   {
   *     "hooks": {
   *       "sessionStart":         [{ "command": "...", "timeout": 5000 }],
   *       "sessionEnd":            [...],
   *       "userPromptSubmitted":   [...],
   *       "preToolUse":            [...],
   *       "postToolUse":           [...],
   *       "agentStop":             [...],
   *       "subagentStop":          [...],
   *       "errorOccurred":         [...]
   *     }
   *   }
   *
   * 注意：Copilot 1.0.x 当前不会主动读取此文件；hooks 实际触发由 Copilot 内置
   * （events.jsonl 中的 hook.start/hook.end 事件即由 Copilot 自身发出）。
   * 此配置文件供 yondermesh daemon 订阅 events.jsonl 时使用，并预留对未来
   * Copilot 版本原生支持 hooks 的兼容点。
   *
   * 幂等：相同 command 替换；不同 command 追加。
   */
  injectHooks(hooks: CopilotHookDef[]): CopilotInjectResult {
    const target = this.hooksConfigPath;
    try {
      const config = readJsonSafe(target);
      if (!config.hooks || typeof config.hooks !== 'object') {
        config.hooks = {};
      }
      const hooksMap = config.hooks as Record<string, Array<{ command: string; timeout: number }>>;
      for (const h of hooks) {
        const entry = { command: h.command, timeout: h.timeoutMs ?? 5000 };
        if (!hooksMap[h.hookType]) {
          hooksMap[h.hookType] = [];
        }
        // 去重：相同 command 替换
        const existing = hooksMap[h.hookType]!;
        const idx = existing.findIndex((e) => e.command === entry.command);
        if (idx >= 0) existing[idx] = entry;
        else existing.push(entry);
      }
      writeJsonSafe(target, config);
      return {
        kind: 'hooks',
        target,
        success: true,
        message: `${hooks.length} hooks written to ${target}`,
      };
    } catch (e) {
      return { kind: 'hooks', target, success: false, message: String(e) };
    }
  }

  /** 注入 yondermesh 默认 8 个 hook 全集（指向 ymesh hook copilot <hookType>） */
  injectDefaultYmeshHooks(opts: { ymeshBin?: string } = {}): CopilotInjectResult {
    const bin = opts.ymeshBin ?? 'ymesh';
    const hooks: CopilotHookDef[] = COPILOT_HOOK_TYPES.map((hookType) => ({
      hookType,
      command: `${bin} hook copilot ${hookType}`,
      timeoutMs: 5000,
    }));
    return this.injectHooks(hooks);
  }

  /**
   * 移除某个 hookType 下的指定 command（不指定 command 则清空整个 hookType）。
   */
  uninjectHook(hookType: (typeof COPILOT_HOOK_TYPES)[number], command?: string): CopilotInjectResult {
    const target = this.hooksConfigPath;
    try {
      const config = readJsonSafe(target);
      const hooksMap = config.hooks as Record<string, Array<{ command: string }> | undefined> | undefined;
      if (!hooksMap || !hooksMap[hookType]) {
        return { kind: 'hooks', target, success: true, message: `${hookType} not present` };
      }
      if (command === undefined) {
        delete hooksMap[hookType];
      } else {
        hooksMap[hookType] = hooksMap[hookType]!.filter((e) => e.command !== command);
        if (hooksMap[hookType]!.length === 0) delete hooksMap[hookType];
      }
      writeJsonSafe(target, config);
      return { kind: 'hooks', target, success: true, message: `${hookType}${command ? `/${command}` : ''} removed` };
    } catch (e) {
      return { kind: 'hooks', target, success: false, message: String(e) };
    }
  }

  /** 列出当前已配置的所有 hooks（按 8 种类型分组） */
  listHooks(): Record<string, Array<{ command: string; timeout: number }>> {
    const config = readJsonSafe(this.hooksConfigPath);
    return (config.hooks as Record<string, Array<{ command: string; timeout: number }>>) ?? {};
  }

  // ─── Always-on 注入 ─────────────────────────────────────────────────

  /**
   * 注入 always-on 上下文段落到 ~/.copilot/AGENTS.md。
   *
   * Copilot 1.0.x 在 session 启动时读取 ~/.copilot/AGENTS.md（如存在）作为系统
   * prompt 的追加段落。段落由 YONDERMESH_AWARENESS_START/END 标记包裹，便于
   * 幂等替换；多个段落（不同 blockId）可共存。
   *
   * 幂等：相同 blockId 的旧段落被新 block 替换；block=null 则删除该 blockId。
   */
  injectAlwaysOn(def: CopilotAlwaysOnDef): CopilotInjectResult {
    const target = this.agentsMdPath;
    try {
      const blockId = def.id ?? 'awareness';
      const content = readTextSafe(target);
      const next = replaceBlock(content, blockId, def.block);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, next, 'utf8');
      return {
        kind: 'always-on',
        target,
        success: true,
        message: `block '${blockId}' written to ${target}`,
      };
    } catch (e) {
      return { kind: 'always-on', target, success: false, message: String(e) };
    }
  }

  /** 移除某个 always-on 段落（按 blockId） */
  uninjectAlwaysOn(blockId: string = 'awareness'): CopilotInjectResult {
    const target = this.agentsMdPath;
    try {
      const content = readTextSafe(target);
      const next = replaceBlock(content, blockId, null);
      if (next.trim().length === 0) {
        // 文件已空 → 删除
        try {
          fs.unlinkSync(target);
        } catch {
          // ignore
        }
      } else {
        fs.writeFileSync(target, next, 'utf8');
      }
      return { kind: 'always-on', target, success: true, message: `block '${blockId}' removed` };
    } catch (e) {
      return { kind: 'always-on', target, success: false, message: String(e) };
    }
  }

  /** 判定某个 always-on blockId 是否已注入 */
  isAlwaysOnInjected(blockId: string = 'awareness'): boolean {
    const content = readTextSafe(this.agentsMdPath);
    const startMarker = `<!-- YONDERMESH_${blockId.toUpperCase()}_START -->`;
    return content.includes(startMarker);
  }

  /**
   * 生成 COPILOT_SYSTEM_PROMPT 环境变量值（用于 CopilotWrapper.launch 时
   * 通过 env 注入到子进程，不污染全局 AGENTS.md）。
   *
   * Copilot 1.0.x 在 session 启动时若 COPILOT_SYSTEM_PROMPT 已设置，
   * 会将其追加到 system.message.content 末尾。
   */
  buildSystemPromptEnv(block: string): { COPILOT_SYSTEM_PROMPT: string } {
    return { COPILOT_SYSTEM_PROMPT: block };
  }

  // ─── 一键全注入 / 全卸载 ─────────────────────────────────────────────

  /**
   * 一键注入 yondermesh 默认全套（MCP + AGENTS.md awareness + 8 hooks）。
   * 用于 `ymesh mount copilot` 命令。
   *
   * @param opts.mcpServer yondermesh MCP server 启动命令（默认 { command: 'ymesh', args: ['mcp', 'serve'] }）
   * @param opts.agentsBlock AGENTS.md awareness 段落内容
   * @param opts.ymeshBin ymesh 二进制路径（默认 'ymesh'，用于 hooks 命令）
   */
  injectAll(opts: {
    mcpServer?: CopilotMcpServerDef;
    agentsBlock?: string;
    ymeshBin?: string;
  } = {}): CopilotInjectResult[] {
    const results: CopilotInjectResult[] = [];
    const mcpServer = opts.mcpServer ?? { command: 'ymesh', args: ['mcp', 'serve'] };
    results.push(this.injectMcp('yondermesh', mcpServer));

    if (opts.agentsBlock) {
      results.push(this.injectAlwaysOn({ block: opts.agentsBlock, id: 'awareness' }));
    }

    results.push(this.injectDefaultYmeshHooks({ ymeshBin: opts.ymeshBin }));
    return results;
  }

  /**
   * 一键卸载 yondermesh 全套（MCP + AGENTS.md awareness 段落 + 8 hooks）。
   * 用于 `ymesh unmount copilot` 命令。
   */
  uninjectAll(opts: { ymeshBin?: string } = {}): CopilotInjectResult[] {
    const results: CopilotInjectResult[] = [];
    results.push(this.uninjectMcp('yondermesh'));
    results.push(this.uninjectAlwaysOn('awareness'));
    const bin = opts.ymeshBin ?? 'ymesh';
    for (const hookType of COPILOT_HOOK_TYPES) {
      // 移除 ymesh 默认 command
      results.push(this.uninjectHook(hookType, `${bin} hook copilot ${hookType}`));
    }
    return results;
  }
}

/** 函数式入口：创建一个 CopilotInjector */
export function createCopilotInjector(options: CopilotInjectOptions = {}): CopilotInjector {
  return new CopilotInjector(options);
}

/** 默认的 yondermesh awareness 段落（用于 AGENTS.md） */
export function defaultYondermeshAwarenessBlock(opts: { deviceId?: string } = {}): string {
  const deviceId = opts.deviceId ?? os.hostname();
  return [
    '## yondermesh awareness',
    '',
    `本机已挂载 yondermesh（device: ${deviceId}）。`,
    'yondermesh 是自托管的 agent 上下文总线，让本机所有 AI CLI agent 互相看见、查询、接力。',
    '',
    '可用工具：',
    '- ymesh MCP server（已通过 ~/.copilot/mcp-config.json 注入）：查询跨源 session、转交任务',
    '- ymesh CLI: `ymesh sessions list` / `ymesh handoff` / `ymesh mount status`',
    '',
    '当前 session 启动后，yondermesh daemon 会自动采集 events.jsonl 并入库（read-only）。',
  ].join('\n');
}
