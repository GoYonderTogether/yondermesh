/**
 * trae-cli 模块入口（覆盖等级 B）
 *
 * trae-cli（trae-agent）无 Skills / Hooks / Always-on，session 以 trajectory JSON 落盘。
 * 与 Trae IDE 的 'trae' source 严格区分（source='trae_cli'）。
 */

export { TraeCliImporter, parseTrajectory } from './importer.js';
export type {
  TraeCliImportOptions,
  TraeCliImportStats,
  ParsedTrajectory,
} from './importer.js';

export {
  buildTraeCliRunCommand,
  buildTraeCliInteractiveCommand,
  inject,
  GLM_DEFAULT_PROVIDER,
  GLM_DEFAULT_MODEL,
  GLM_DEFAULT_BASE_URL,
} from './wrapper.js';
export type { BuildTraeCliRunOptions, TraeCliCommand, TraeCliInjectResult } from './wrapper.js';

export {
  generateTraeCliConfig,
  generateTraeCliConfigWithYondermesh,
  generateTraeSystemPrompt,
  DEFAULT_CONFIG_FILE,
} from './inject.js';
export type {
  TraeCliConfigOptions,
  TraeMcpServer,
  TraeSystemPromptOptions,
} from './inject.js';
