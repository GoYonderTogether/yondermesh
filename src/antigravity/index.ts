/**
 * Antigravity 原生 adapter 模块入口（覆盖等级 A）
 *
 * 含三部分：
 *   - importer：只读扫描 conversation_summaries.db + transcript.jsonl
 *   - wrapper：agy CLI wrapper（launch/inject/resumeLast/listSessions/exportSession）
 *   - inject：MCP（mcp_config.json）+ Skills（~/.gemini/skills/）+ 5 Hooks + Always-on
 *
 * GLM-5.2 ❌：Antigravity 硬绑 Google OAuth，但 session 可被提取用于 handoff。
 */

export { AntigravityImporter, resolveAntigravityDbPath } from './importer.js';
export type { AntigravityImportOptions, AntigravityImportStats } from './importer.js';

export { AntigravityCliWrapper } from './wrapper.js';
export type {
  AntigravityWrapperOptions,
  AgyResult,
  AgyLaunchInput,
  AgyLaunchedSession,
  AgySessionListItem,
} from './wrapper.js';

export {
  registerMcp as registerAntigravityMcp,
  unregisterMcp as unregisterAntigravityMcp,
  isMcpRegistered as isMcpRegisteredInAntigravity,
  buildYmeshArgs as buildYmeshArgsForAntigravity,
  listSkills as listAntigravitySkills,
  installSkill as installAntigravitySkill,
  listHooks as listAntigravityHooks,
  registerHook as registerAntigravityHook,
  unregisterAllHooks as unregisterAllAntigravityHooks,
  setAlwaysOnContext as setAntigravityAlwaysOnContext,
  getAlwaysOnContext as getAntigravityAlwaysOnContext,
  clearAlwaysOnContext as clearAntigravityAlwaysOnContext,
  injectAll as injectAllToAntigravity,
  ANTIGRAVITY_HOOK_EVENTS,
} from './inject.js';
export type {
  McpRegistrationResult as AntigravityMcpRegistrationResult,
  SkillEntry as AntigravitySkillEntry,
  HookConfig as AntigravityHookConfig,
  AntigravityHookEvent,
  FullInjectResult as AntigravityFullInjectResult,
} from './inject.js';
