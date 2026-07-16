/**
 * Crush 原生 adapter 模块入口（覆盖等级 A）
 *
 * 三个职责：
 *   - importer.ts: 只读导入项目级 <cwd>/.crush/crush.db（含 parent_session_id 拓扑）
 *   - wrapper.ts : `crush run` 非交互子进程封装（stdout 文本流 + 接力 handoff）
 *   - inject.ts  : MCP / Skills / Always-on / PreToolUse Hook 注入到 ~/.config/crush/
 *
 * 别名（src/store/source-aliases.ts）：
 *   crush（canonical）/ crush-cli / crush_cli / crushcli
 */

export {
  CrushImporter,
  resolveCrushDbPath,
} from './importer.js';
export type { CrushImportOptions, CrushImportStats } from './importer.js';

export {
  CrushWrapper,
  DEFAULT_CRUSH_CONFIG_DIR,
} from './wrapper.js';
export type {
  CrushLaunchOptions,
  CrushLaunchResult,
  ExtractedCrushSession,
  CrushHandoffPayload,
} from './wrapper.js';

export {
  CrushInjector,
  resolveCrushJsonPath,
  resolveCrushMdPath,
} from './inject.js';
export type {
  CrushMcpServerDef,
  CrushHookDef,
  CrushInjectResult,
  CrushInjectOptions,
} from './inject.js';
