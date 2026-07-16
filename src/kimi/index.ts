/**
 * Kimi 原生 adapter 模块入口（覆盖等级 A）
 *
 * 包含：
 *   - importer：只读扫描 ~/.kimi session 文件并入库
 *   - wrapper：KimiController（Wire 协议 JSONRPCSteerMessage + ACP + CLI）
 *   - inject：KimiWireInjector（Wire 协议注入 + CLI 链式注入）
 */

export { KimiImporter, resolveKimiPath } from './importer.js';
export type { KimiImportOptions, KimiImportStats } from './importer.js';

export {
  KimiController,
} from './wrapper.js';
export type {
  KimiControllerOptions,
  KimiLaunchResult,
  WireEvent,
  SteerMessage,
  KimiTransferredSession,
} from './wrapper.js';

export { KimiWireInjector } from './inject.js';
export type {
  KimiInjectorOptions,
  KimiInjectionResult,
  SteerInjectionResult,
} from './inject.js';
