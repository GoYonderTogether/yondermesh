/**
 * Factory Droid 模块入口（覆盖等级 A）
 */

export { FactoryDroidImporter, resolveFactorySessionsPath } from './importer.js';
export type { FactoryImportOptions, FactoryImportStats } from './importer.js';

export {
  FACTORY_HOME,
  FACTORY_SESSIONS_DIR,
  detectFactoryDroid,
  droidExec,
  droidResumeArgs,
  inject,
  listFactorySessionIds,
} from './wrapper.js';
export type { FactoryDroidDetect, FactoryExecOptions, FactoryExecResult, FactoryInjectWrapperResult } from './wrapper.js';

export {
  FACTORY_HOOKS_PATH,
  FACTORY_MCP_PATH,
  FACTORY_SKILLS_DIR,
  FACTORY_AGENTS_MD,
  factoryContextBlock,
  buildFactoryExtensions,
  factoryHooksContent,
  injectFactoryMcp,
  injectFactorySkill,
  injectFactoryAlwaysOn,
  injectFactoryHooks,
  injectFactoryAll,
  removeFactoryAll,
  checkFactoryInjection,
} from './inject.js';
export type { FactoryInjectResult } from './inject.js';
