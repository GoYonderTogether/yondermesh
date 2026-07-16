/**
 * Hermes Agent 原生 adapter 模块入口
 *
 * 覆盖等级 A（原生 adapter）：只读扫描 ~/.hermes/state.db
 *
 * 导出：
 *   - HermesImporter：session 导入器（state.db → ymesh SessionStore）
 *   - HermesController：CLI 链式 wrapper（launch/inject/interrupt/extract/transfer）
 *   - 提示词注入：always-on（SOUL.md）/ launch-time / hook
 */

export { HermesImporter, resolveHermesDbPath, resolveHermesHome, resolveHermesSessionsDir } from './importer.js';
export type { HermesImportOptions, HermesImportStats } from './importer.js';

export { HermesController, resolveHermesHome as resolveWrapperHome } from './wrapper.js';
export type {
  LaunchOptions,
  LaunchResult,
  HermesSessionSummary,
  NeutralMessage,
  ExtractedSession,
  TransferPackage,
} from './wrapper.js';

export {
  injectAlwaysOn,
  removeAlwaysOn,
  buildLaunchPrefix,
  buildLaunchEnv,
  installSessionStartHook,
  removeSessionStartHook,
  injectAll,
  removeAll,
  DEFAULT_AWARENESS_BLOCK,
} from './inject.js';
export type { InjectOptions, SessionStartHookConfig, InjectResult } from './inject.js';
