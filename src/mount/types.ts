/**
 * 统一挂载系统类型定义
 *
 * 三种扩展类型 × 多种挂载策略 × N 个 CLI = 一个矩阵。
 * 这里定义矩阵的两条轴。
 */

/** 扩展类型 */
export type ExtensionType = 'mcp-server' | 'skill' | 'plugin';

/** 挂载策略类型 */
export type MountStrategyType =
  | 'mcp-json'      // JSON 配置文件写入 mcpServers 键 (Cursor/Gemini/Windsurf/Continue)
  | 'mcp-toml'      // TOML 配置文件写入 [mcp_servers.*] 段 (Codex)
  | 'skill-symlink' // skill 目录 symlink (Codex/Cursor/Trae/Continue/Windsurf)
  | 'claude-mcp';   // claude mcp add/remove CLI (Claude Code)

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
  /** MCP server 定义（type=mcp-server 时） */
  mcp?: McpServerDef;
  /** skill 源目录路径（type=skill 时） */
  skillPath?: string;
}

/** 单次挂载结果 */
export interface MountResult {
  strategy: MountStrategyType;
  target: string; // CLI id
  extension: string; // extension name
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
  /** 家目录相对于 home，如 '.codex' */
  homeDir: string;
  /** 是否已安装 */
  detect: (home: string) => boolean;
  /** 支持的挂载策略和对应配置 */
  capabilities: CliCapability[];
}

/** 某个 CLI 支持的挂载能力 */
export interface CliCapability {
  strategy: MountStrategyType;
  /** 支持的扩展类型 */
  extensionTypes: ExtensionType[];
  /**
   * 计算挂载路径或配置文件路径。
   * home = 用户家目录
   * 返回策略所需的路径参数。
   */
  resolve: (home: string) => Record<string, string>;
}
