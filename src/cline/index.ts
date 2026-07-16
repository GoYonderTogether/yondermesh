/**
 * Cline 原生 adapter 模块入口（覆盖等级 A）
 *
 * 三个职责：
 *   - importer.ts: 只读扫描 ~/.cline/data/db/sessions.db（A 级优先），回退 JSON transcript
 *   - wrapper.ts : `cline --json` headless 子进程封装（NDJSON 流 + 接力 handoff）
 *   - inject.ts  : MCP / Skills / Always-on 注入到 ~/.cline/
 *
 * 别名（src/store/source-aliases.ts）：
 *   cline（canonical）/ cline-cli / cline_cli / clinecli
 */

export {
  ClineImporter,
  resolveClineDataDir,
  resolveClineDbPath,
  resolveClineSessionsDir,
} from './importer.js';
export type { ClineImportOptions, ClineImportStats } from './importer.js';

export {
  ClineWrapper,
  DEFAULT_CLINE_DATA_DIR,
} from './wrapper.js';
export type {
  ClineThinkingLevel,
  ClineLaunchOptions,
  ClineNdjsonEvent,
  ClineLaunchResult,
  ExtractedClineSession,
  ClineHandoffPayload,
} from './wrapper.js';

export {
  ClineInjector,
  resolveClineMcpSettingsPath,
  resolveClineSkillsDir,
  resolveClineRulesPath,
} from './inject.js';
export type {
  ClineMcpServerDef,
  ClineInjectResult,
  ClineInjectOptions,
} from './inject.js';
