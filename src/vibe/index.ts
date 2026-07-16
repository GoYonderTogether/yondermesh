/**
 * Vibe 模块入口（覆盖等级 A）
 */

export { VibeImporter, resolveVibeSessionsPath } from './importer.js';
export type { VibeImportOptions, VibeImportStats } from './importer.js';

export {
  VIBE_HOME,
  VIBE_SESSIONS_DIR,
  VIBE_CONFIG_PATH,
  VIBE_HOOKS_PATH,
  VIBE_SKILLS_DIR,
  VIBE_AGENTS_MD,
  detectVibe,
  vibeExec,
  vibeResumeArgs,
  inject,
  listVibeSessionDirs,
} from './wrapper.js';
export type { VibeDetect, VibeExecOptions, VibeExecResult, VibeInjectWrapperResult } from './wrapper.js';

export {
  vibeContextBlock,
  buildVibeExtensions,
  vibeHooksContent,
  injectVibeMcp,
  injectVibeSkill,
  injectVibeAlwaysOn,
  injectVibeHooks,
  injectVibeAll,
  removeVibeAll,
  checkVibeInjection,
} from './inject.js';
export type { VibeInjectResult } from './inject.js';
