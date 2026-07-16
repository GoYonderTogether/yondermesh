/**
 * 统一挂载系统类型定义
 *
 * 三种扩展类型 x 多种挂载策略 x N 个 CLI = 一个矩阵。
 */

/** 扩展类型 */
export type ExtensionType = 'mcp-server' | 'skill' | 'plugin' | 'cli-inject';

/** 挂载策略类型 */
export type MountStrategyType =
  | 'mcp-json'      // JSON 配置文件写入 mcpServers 键 (Cursor/Gemini/Windsurf/Continue/Factory)
  | 'mcp-toml'      // TOML 配置文件写入 [mcp_servers.*] 段 (Codex)
  | 'mcp-toml-array' // TOML 配置文件写入 [[mcp_servers]] array-of-tables (Vibe)
  | 'skill-symlink' // skill 目录 symlink (Codex/Cursor/Trae/Continue/Windsurf/Factory/Vibe/CodeBuddy)
  | 'claude-mcp'    // claude mcp add/remove CLI (Claude Code)
  | 'always-on'     // 注入全局指令文件段落 (AGENTS.md/CLAUDE.md/GEMINI.md/.cursorrules)
  | 'cli-inject'    // CLI 链式注入（openclaw/kimi/aider 等无标准 mount 点的 CLI）
  | 'unsupported';  // CLI 不支持该扩展类型（用于 status 显示与统计过滤）

/** MCP Server 定义 */
export interface McpServerDef {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** 要挂载的扩展 */
export interface Extension {
  type: ExtensionType;
  name: string;
  mcp?: McpServerDef;
  skillPath?: string;
  /** always-on 段落内容（strategy=always-on 时） */
  contextBlock?: string;
}

/** 单次挂载结果 */
export interface MountResult {
  strategy: MountStrategyType;
  target: string;
  extension: string;
  success: boolean;
  message: string;
}

/** 挂载状态快照 */
export interface MountStatus {
  cli: string;
  extension: string;
  type: ExtensionType;
  strategy: MountStrategyType;
  mounted: boolean;
  detail?: string;
}

/** CLI 注册表条目 */
export interface CliTarget {
  id: string;
  displayName: string;
  homeDir: string;
  detect: (home: string) => boolean;
  capabilities: CliCapability[];
}

/** 某个 CLI 支持的挂载能力 */
export interface CliCapability {
  strategy: MountStrategyType;
  extensionTypes: ExtensionType[];
  resolve: (home: string) => Record<string, string>;
}

/** always-on 段落的边界标记 */
export const CONTEXT_BLOCK_START = '<!-- YONDERMESH_AWARENESS_START -->';
export const CONTEXT_BLOCK_END = '<!-- YONDERMESH_AWARENESS_END -->';
