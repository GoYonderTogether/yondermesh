/**
 * WorkBuddy / CodeBuddy 模块入口（覆盖等级 A）
 */

export { CodeBuddyImporter, resolveCodeBuddyPath } from './importer.js';
export type { CodeBuddyImportOptions, CodeBuddyImportStats } from './importer.js';

export {
  CODEBUDDY_HOME,
  CODEBUDDY_MODELS_JSON,
  CODEBUDDY_HOOKS_PATH,
  CODEBUDDY_SKILLS_DIR,
  CODEBUDDY_AGENTS_MD,
  detectCodeBuddy,
  cbcExec,
  cbcResumeArgs,
  inject,
} from './wrapper.js';
export type { CodeBuddyDetect, CodeBuddyExecOptions, CodeBuddyExecResult, CodeBuddyInjectWrapperResult } from './wrapper.js';

export {
  codeBuddyContextBlock,
  buildCodeBuddyExtensions,
  codeBuddyHooksContent,
  injectCodeBuddyMcp,
  injectCodeBuddySkill,
  injectCodeBuddyAlwaysOn,
  injectCodeBuddyHooks,
  injectCodeBuddyAll,
  removeCodeBuddyAll,
  checkCodeBuddyInjection,
  codeBuddyHookTypes,
} from './inject.js';
export type { CodeBuddyInjectResult, CodeBuddyHookType } from './inject.js';
