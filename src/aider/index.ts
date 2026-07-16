/**
 * Aider 模块入口（覆盖等级 B）
 *
 * Aider 无 MCP / Skills / Hooks，session 以 per-project markdown 落盘。
 * 本模块提供：
 *   - importer：解析 .aider.chat.history.md → 结构化 session 入库
 *   - wrapper：构造 aider CLI argv + env（GLM-5.2 非交互姿势）
 *   - inject：--read / .aider.conf.yml 替代 MCP/Skill 注入上下文
 */

export { AiderImporter, parseAiderMarkdown, AIDER_HISTORY_FILENAME } from './importer.js';
export type { AiderImportOptions, AiderImportStats, ParsedAiderSession } from './importer.js';

export {
  buildAiderCommand,
  inject,
  GLM_MODEL_ARG,
  GLM_DEFAULT_BASE_URL,
} from './wrapper.js';
export type { BuildAiderCommandOptions, AiderCommand, AiderInjectResult } from './wrapper.js';

export {
  buildReadArgs,
  buildConventionsReadArgs,
  detectConventionFiles,
  generateAiderConfYml,
  CONVENTIONS_FILENAME,
  CONVENTIONS_CANDIDATES,
} from './inject.js';
export type { AiderConfYmlOptions } from './inject.js';
