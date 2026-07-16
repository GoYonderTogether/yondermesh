/**
 * OpenHands 原生 adapter 模块入口（覆盖等级 A）
 *
 * 含三部分：
 *   - importer：只读扫描 conversations/<conv_id>/events/event-*.json
 *   - wrapper：HTTP API wrapper（launch/inject/interrupt/fork/pause/run）
 *   - inject：MCP + Skills + 6 lifecycle hooks + Always-on 注入
 */

export { OpenHandsImporter, resolveOpenHandsWorkspace } from './importer.js';
export type { OpenHandsImportOptions, OpenHandsImportStats } from './importer.js';

export { OpenHandsApiWrapper } from './wrapper.js';
export type {
  OpenHandsWrapperOptions,
  ApiResult as OpenHandsApiResult,
  LaunchConversationInput,
  LaunchedConversation,
} from './wrapper.js';

export {
  registerMcp,
  unregisterMcp,
  isMcpRegistered as isMcpRegisteredInOpenHands,
  buildYmeshArgs as buildYmeshArgsForOpenHands,
  listSkills as listOpenHandsSkills,
  installSkill as installOpenHandsSkill,
  listHooks as listOpenHandsHooks,
  registerHook as registerOpenHandsHook,
  unregisterAllHooks as unregisterAllOpenHandsHooks,
  setAlwaysOnContext as setOpenHandsAlwaysOnContext,
  getAlwaysOnContext as getOpenHandsAlwaysOnContext,
  clearAlwaysOnContext as clearOpenHandsAlwaysOnContext,
  injectAll as injectAllToOpenHands,
  OPENHANDS_HOOK_EVENTS,
} from './inject.js';
export type {
  McpRegistrationResult as OpenHandsMcpRegistrationResult,
  SkillEntry as OpenHandsSkillEntry,
  HookConfig as OpenHandsHookConfig,
  OpenHandsHookEvent,
  FullInjectResult as OpenHandsFullInjectResult,
} from './inject.js';
