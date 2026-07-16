/**
 * Continue CLI 原生 adapter 模块入口（覆盖等级 A）
 *
 * 三件套：
 *   - importer：只读扫描 ~/.continue/sessions/<uuid>.json + sessions.json 索引
 *     + `cn ls --json` fallback，解析为 ymesh StoredSession 入库
 *     （来源标记 `continue`，A 级原生 adapter）
 *   - wrapper：`cn` CLI 封装（launch / inject / fork / extractSession / transferSession）
 *   - inject：MCP / Skills / Always-on rules 三件套注入（config.yaml，幂等）
 */

export {
  ContinueImporter,
  CONTINUE_CONFIG_DIR,
  CONTINUE_SESSIONS_DIR,
  CONTINUE_SESSIONS_INDEX,
} from './importer.js';
export type {
  ContinueImportOptions,
  ContinueImportStats,
} from './importer.js';

export {
  ContinueCliWrapper,
  extractSession,
  transferSession,
  isContinueInstalled,
  CONTINUE_EVENTS_FILE,
} from './wrapper.js';
export type {
  ContinueWrapperOptions,
  ContinueCliResult,
  ContinueLaunchInput,
  ContinueLaunchedSession,
  ContinueInjectInput,
  ContinueSessionListItem,
  ContinueExtractResult,
  ContinueTransferResult,
} from './wrapper.js';

export {
  registerMcp as registerContinueMcp,
  unregisterMcp as unregisterContinueMcp,
  isMcpRegistered as isMcpRegisteredInContinue,
  buildYmeshArgs as buildYmeshArgsForContinue,
  listSkills as listContinueSkills,
  installSkill as installContinueSkill,
  injectBundledSkills as injectContinueBundledSkills,
  setAlwaysOnRules as setContinueAlwaysOnRules,
  clearAlwaysOnRules as clearContinueAlwaysOnRules,
  getAlwaysOnRulesVersion as getContinueAlwaysOnRulesVersion,
  injectContinue,
  uninstallContinueInjection,
  CONTINUE_CONFIG_PATH,
  CONTINUE_SKILLS_DIR,
} from './inject.js';
export type {
  ContinueMcpRegistrationResult,
  ContinueSkillEntry,
  ContinueInjectResult,
  ContinueInjectOptions,
} from './inject.js';
