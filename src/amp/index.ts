/**
 * Amp 模块入口（覆盖等级 B / 降级 C）
 *
 * Amp SaaS 封闭，thread 在云端，但 `amp threads export` 可取回完整 JSON。
 */

export {
  AmpImporter,
  parseAmpExport,
  parseAmpThreadLog,
  AMP_AUTH_HELPER,
} from './importer.js';
export type {
  AmpImportOptions,
  AmpImportStats,
  AmpCommandRunner,
  ParsedAmpThread,
} from './importer.js';

export {
  buildAmpListCommand,
  buildAmpExportCommand,
  buildAmpMarkdownCommand,
  buildAmpNewThreadCommand,
  buildAmpContinueCommand,
  inject,
} from './wrapper.js';
export type { AmpGlobalOptions, AmpInjectResult } from './wrapper.js';

export {
  generateAmpMcpConfig,
  generateAmpMcpInline,
  generateAmpAgentsMd,
  generateAmpPluginHook,
  detectGlobalAgentsMd,
  AMP_HOOK_EVENTS,
} from './inject.js';
export type {
  AmpMcpServer,
  AmpMcpConfigOptions,
  AmpAgentsMdOptions,
  AmpPluginHookOptions,
  AmpHookEvent,
} from './inject.js';
