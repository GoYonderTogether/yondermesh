/**
 * Gemini CLI 接入模块入口（覆盖等级 A）
 *
 * 提供：
 *   - 原生 session 导入（importer，扫描 ~/.gemini/tmp）
 *   - CLI wrapper（wrapper，launch / inject / getStream / extractSession）
 *   - 注入器（inject，MCP / hooks / skills / always-on system prompt）
 */

// 原生 adapter
export { GeminiImporter, resolveGeminiSessionsPath } from './importer.js';
export type { GeminiImportOptions, GeminiImportStats } from './importer.js';

// Wrapper
export {
  launch as launchGemini,
  launchSync as launchGeminiSync,
  inject as injectGeminiMessage,
  getStream as getGeminiStream,
  extractSession as extractGeminiSession,
  transferSession as transferGeminiSession,
  listLocalSessions as listLocalGeminiSessions,
} from './wrapper.js';
export type {
  GeminiLaunchOptions,
  GeminiLaunchHandle,
  GeminiSessionContext,
} from './wrapper.js';

// 注入器
export {
  registerMcp as registerGeminiMcp,
  unregisterMcp as unregisterGeminiMcp,
  isMcpRegistered as isGeminiMcpRegistered,
  linkSkill as linkGeminiSkill,
  unlinkSkill as unlinkGeminiSkill,
  listSkills as listGeminiSkills,
  configureHooks as configureGeminiHooks,
  clearHooks as clearGeminiHooks,
  injectSystemPrompt as injectGeminiSystemPrompt,
  readSystemPrompt as readGeminiSystemPrompt,
  removeSystemPrompt as removeGeminiSystemPrompt,
  injectAll as injectAllGemini,
  isGeminiInstalled,
  geminiSettingsPath,
  geminiGlobalPromptPath,
  buildYmeshArgs as buildGeminiYmeshArgs,
  GEMINI_HOOK_EVENTS,
} from './inject.js';
export type {
  GeminiHookConfig,
  GeminiInjectResult,
} from './inject.js';
