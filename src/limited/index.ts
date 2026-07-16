/**
 * Limited agents 模块入口（Aider / Amp / ChatGPT Desktop / trae-cli）
 *
 * 汇总四个「能力有限」agent 的子模块，并导出 session-bridge 转交器。
 */

// Session Bridge（核心转交器）
export {
  toNeutralMessages,
  toNeutralJsonl,
  parseNeutralJsonl,
  buildHandoffPrompt,
  convertSession,
} from './session-bridge.js';
export type { NeutralMessage, SessionData, LimitedSourceCli } from './session-bridge.js';

// Aider
export { AiderImporter, parseAiderMarkdown, AIDER_HISTORY_FILENAME } from '../aider/index.js';
export { buildAiderCommand, GLM_MODEL_ARG, GLM_DEFAULT_BASE_URL } from '../aider/index.js';
export {
  buildReadArgs,
  buildConventionsReadArgs,
  detectConventionFiles,
  generateAiderConfYml,
} from '../aider/index.js';
export type {
  AiderImportOptions,
  AiderImportStats,
  ParsedAiderSession,
  BuildAiderCommandOptions,
  AiderCommand,
} from '../aider/index.js';

// Amp
export {
  AmpImporter,
  parseAmpExport,
  parseAmpThreadLog,
  AMP_AUTH_HELPER,
} from '../amp/index.js';
export {
  buildAmpListCommand,
  buildAmpExportCommand,
  buildAmpMarkdownCommand,
  buildAmpNewThreadCommand,
  buildAmpContinueCommand,
} from '../amp/index.js';
export {
  generateAmpMcpConfig,
  generateAmpMcpInline,
  generateAmpAgentsMd,
  generateAmpPluginHook,
  detectGlobalAgentsMd,
} from '../amp/index.js';
export type {
  AmpImportOptions,
  AmpImportStats,
  AmpCommandRunner,
  ParsedAmpThread,
  AmpGlobalOptions,
} from '../amp/index.js';

// ChatGPT Desktop
export { ChatGptExtractor, detectChatGptDesktop } from '../chatgpt/index.js';
export type {
  ChatGptDetection,
  ChatGptExtractOptions,
  ChatGptExtractStats,
} from '../chatgpt/index.js';

// trae-cli
export { TraeCliImporter, parseTrajectory } from '../trae-cli/index.js';
export {
  buildTraeCliRunCommand,
  buildTraeCliInteractiveCommand,
} from '../trae-cli/index.js';
export {
  generateTraeCliConfig,
  generateTraeCliConfigWithYondermesh,
  generateTraeSystemPrompt,
} from '../trae-cli/index.js';
export type {
  TraeCliImportOptions,
  TraeCliImportStats,
  ParsedTrajectory,
  BuildTraeCliRunOptions,
  TraeCliCommand,
} from '../trae-cli/index.js';
