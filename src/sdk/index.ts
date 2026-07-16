/**
 * yondermesh Adapter SDK —— 入口
 *
 * 导出所有公共类型、抽象基类与脚手架。外部 adapter 开发者只需：
 *   import { BaseImporter, BaseWrapper, BaseInjector, scaffoldAdapter } from '@yondermesh/sdk';
 *
 * 规范见 `specs/adapter-spec.md`。
 */

// ─── 公共类型（再导出供单点 import） ───────────────────────────────────
export type {
  BaseImporterOptions,
  BaseInjectorOptions,
  Importer,
  ImporterStats,
  Injector,
  InjectorResult,
  InjectResult,
  LaunchOptions,
  LaunchResult,
  NeutralMessage,
  NeutralSession,
  ParsedSession,
  SessionSummary,
  StreamEvent,
  TransferPackage,
  Wrapper,
} from './types.js';
export { CONTEXT_BLOCK_START, CONTEXT_BLOCK_END, DEFAULT_AWARENESS_BLOCK } from './types.js';
// 领域类型再导出
export type {
  Coverage,
  MessageRole,
  RelationType,
  Relationship,
  RelationshipInput,
  Retention,
  SessionIngestInput,
  SessionMessageInput,
  SessionRecord,
  SessionTopology,
} from '../store/types.js';
export type {
  CliCapability,
  CliTarget,
  Extension,
  ExtensionType,
  McpServerDef,
  MountResult,
  MountStatus,
  MountStrategyType,
} from '../mount/types.js';

// ─── 抽象基类 ──────────────────────────────────────────────────────────
export { BaseImporter } from './base-importer.js';
export { BaseWrapper } from './base-wrapper.js';
export { BaseInjector } from './base-injector.js';

// ─── 模板与脚手架 ──────────────────────────────────────────────────────
export {
  TemplateImporter,
  TemplateWrapper,
  TemplateInjector,
  createTemplateAdapter,
} from './template.js';
export type { TemplateAdapter } from './template.js';
export { scaffoldAdapter } from './scaffold.js';
export type { ScaffoldFile, ScaffoldOptions } from './scaffold.js';
