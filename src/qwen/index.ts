/**
 * Qwen Code 接入模块入口（覆盖等级 A）
 *
 * 提供：
 *   - 原生 session 导入（importer，扫描 ~/.qwen/projects）
 *   - CLI / HTTP wrapper（wrapper，launch / inject / getStream / extractSession）
 *   - 注入器（inject，MCP / hooks / always-on system prompt）
 */

// 原生 adapter
export { QwenCodeImporter, resolveQwenProjectsPath } from './importer.js';
export type { QwenImportOptions, QwenImportStats } from './importer.js';

// Wrapper
export {
  launch as launchQwen,
  launchSync as launchQwenSync,
  detectServe as detectQwenServe,
  inject as injectQwenMessage,
  getStream as getQwenStream,
  extractSession as extractQwenSession,
  transferSession as transferQwenSession,
} from './wrapper.js';
export type {
  QwenLaunchOptions,
  QwenLaunchHandle,
  QwenServeConfig,
  QwenSessionContext,
} from './wrapper.js';

// 注入器
export {
  registerMcp as registerQwenMcp,
  unregisterMcp as unregisterQwenMcp,
  isMcpRegistered as isQwenMcpRegistered,
  configureHooks as configureQwenHooks,
  clearHooks as clearQwenHooks,
  injectSystemPrompt as injectQwenSystemPrompt,
  readSystemPrompt as readQwenSystemPrompt,
  removeSystemPrompt as removeQwenSystemPrompt,
  injectAll as injectAllQwen,
  isQwenInstalled,
  qwenSettingsPath,
  qwenGlobalPromptPath,
  buildYmeshArgs as buildQwenYmeshArgs,
} from './inject.js';
export type {
  QwenHookConfig,
  QwenInjectResult,
} from './inject.js';
