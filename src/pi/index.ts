/**
 * Pi Agent 家族原生 adapter 模块入口（覆盖等级 A）
 *
 * 三个 CLI（Pi / oh-my-pi / gsd-pi）共享 JSONL v3 树结构格式 + RPC steer 中途介入能力，
 * 因此共享同一 importer / wrapper / injector / rpc client，通过配置目录路径区分 source：
 *   - pi     → ~/.pi/agent/   (source=pi,     cli=pi)
 *   - omp    → ~/.omp/agent/  (source=omp,    cli=omp)
 *   - gsd-pi → ~/.gsd/agent/  (source=gsd-pi, cli=gsd)
 */

// Importer：JSONL v3 解析 + entry 树保留 + 三 flavor 探测
export {
  PiImporter,
  resolvePiFlavors,
  resolveFlavorSessionsDir,
} from './importer.js';
export type {
  PiFlavor,
  PiFlavorConfig,
  PiImportOptions,
  PiImportStats,
  PiFlavorStats,
  PiEntry,
  PiNeutralSession,
} from './importer.js';

// Wrapper：统一控制器（launch / inject / abort / getStream / listSessions / extractSession / transferSession）
export {
  PiController,
  encodeCwd,
  errorMessage,
} from './wrapper.js';
export type {
  PiSource,
  PiSessionSummary,
  PiSessionHandle,
  PiLaunchOptions,
  PiTransferResult,
  PiControllerOptions,
} from './wrapper.js';

// Injector：MCP / Skills / AGENTS.md / Hooks / pi-mcp-adapter 注入
export { PiInjector } from './inject.js';
export type {
  McpServerDef,
  McpConfig,
  PiInjectResult,
  PiInjectorOptions,
} from './inject.js';

// RPC client：stdin/stdout JSONL 协议（steer / follow_up / abort / switch_session）
export { PiRpcClient, RpcError } from './rpc.js';
export type {
  PiCli,
  RpcCommand,
  RpcResponseOk,
  RpcResponseErr,
  RpcResponse,
  RpcEvent,
  RpcImage,
  RpcClientOptions,
} from './rpc.js';
