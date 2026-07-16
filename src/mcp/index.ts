/**
 * yondermesh MCP 模块入口
 *
 * 三个对外暴露：
 *   - MCP_TOOLS：yondermesh 暴露给其他 agent 的 MCP 工具注册表（含 handler）
 *   - McpServer：stdio JSON-RPC server 实现（旧版工具集）
 *   - register/unregister：将 MCP server 注册到 Claude Code / Codex 配置
 *
 * 注意：tools.ts 的 McpToolDef（带 handler）与 server.ts 的 McpToolDef（仅 schema）
 * 同名但结构不同，本入口只导出 tools.ts 版本作为新规范；server.ts 的旧 schema 类型
 * 不再从本入口导出，需要时直接 import from './server.js'。
 */

// tools.ts（新 MCP 工具集 — 含 handler）
export { MCP_TOOLS, loadWrapper, findTool, listToolSchemas } from './tools.js';
export type {
  McpToolHandler,
  McpToolResponse,
  McpToolDef,
} from './tools.js';

// server.ts（旧版 MCP server 实现）
export { McpServer, parseRelativeTime } from './server.js';
export type { McpToolResult, McpServerOptions } from './server.js';

// register.ts（注册到 Claude Code / Codex）
export {
  registerAll,
  unregisterAll,
  checkRegistration,
  buildYmeshArgs,
} from './register.js';
export type {
  RegistrationResult,
  RegistrationStatus,
} from './register.js';

// codex-handoff.ts（任务接管 handoff 包构造）
export {
  buildSessionHandoff,
  buildCodexHandoff,
  buildClaudeHandoff,
  findCodexSessionFile,
  findClaudeSessionFile,
} from './codex-handoff.js';
export type {
  HandoffPackage,
  HandoffMessage,
  HandoffSessionMeta,
  CompactedSummary,
  BuildHandoffOptions,
} from './codex-handoff.js';
