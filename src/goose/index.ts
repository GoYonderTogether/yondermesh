/**
 * Goose 原生 adapter 模块入口（覆盖等级 A）
 *
 * 含三部分：
 *   - importer：只读扫描 ~/.local/share/goose/sessions.db（parent_session_id 拓扑）
 *   - wrapper：goose CLI wrapper（launch/inject/fork/resume/list/export）
 *   - inject：MCP（config.yaml extensions:）+ Skills（~/.agents/skills/）+ Always-on
 */

export { GooseImporter, resolveGooseDbPath } from './importer.js';
export type { GooseImportOptions, GooseImportStats } from './importer.js';

export { GooseCliWrapper } from './wrapper.js';
export type {
  GooseWrapperOptions,
  CliResult as GooseCliResult,
  GooseLaunchInput,
  GooseLaunchedSession,
} from './wrapper.js';

export {
  registerMcp as registerGooseMcp,
  unregisterMcp as unregisterGooseMcp,
  isMcpRegistered as isMcpRegisteredInGoose,
  buildYmeshArgs as buildYmeshArgsForGoose,
  listSkills as listGooseSkills,
  installSkill as installGooseSkill,
  setAlwaysOnContext as setGooseAlwaysOnContext,
  getAlwaysOnContext as getGooseAlwaysOnContext,
  clearAlwaysOnContext as clearGooseAlwaysOnContext,
  injectAll as injectAllToGoose,
} from './inject.js';
export type {
  McpRegistrationResult as GooseMcpRegistrationResult,
  SkillEntry as GooseSkillEntry,
  FullInjectResult as GooseFullInjectResult,
} from './inject.js';
