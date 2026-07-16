/**
 * OpenClaw 原生 adapter 模块入口（覆盖等级 A）
 *
 * 包含：
 *   - importer：只读扫描 ~/.openclaw session 文件并入库
 *   - wrapper：OpenClawController（WebSocket RPC + CLI 双通道）
 *   - inject：CliChainInjector（CLI 链式注入，替代 MCP/Skill/Always-on）
 */

export { OpenClawImporter, resolveOpenClawPath } from './importer.js';
export type { OpenClawImportOptions, OpenClawImportStats } from './importer.js';

export {
  OpenClawController,
} from './wrapper.js';
export type {
  OpenClawControllerOptions,
  LaunchResult,
  StreamEvent,
  TransferredSession,
} from './wrapper.js';

export { CliChainInjector } from './inject.js';
export type { CliChainInjectorOptions, InjectionResult } from './inject.js';
