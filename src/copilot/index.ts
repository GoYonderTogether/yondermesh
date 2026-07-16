/**
 * Copilot CLI / SDK 模块入口（覆盖等级 A）
 *
 * 三个职责：
 *   - importer.ts: 只读扫描 ~/.copilot/session-state/<uuid>/events.jsonl，解析为 ymesh session
 *   - wrapper.ts : 程序化控制 Copilot 启动 / --connect 介入 / 流式获取 / 跨设备转交
 *   - inject.ts  : MCP / Skills / 8 Hooks / Always-on 注入到 ~/.copilot/
 *
 * 别名（src/store/source-aliases.ts）：
 *   copilot（canonical）/ copilot_cli / copilot-cli / copilot_sdk / copilot-sdk
 *   CLI 与 SDK 区分走 originator 字段（copilot_cli | copilot_sdk），不污染 source。
 */

export {
  CopilotImporter,
  resolveCopilotHomePath,
  resolveCopilotSessionStatePath,
  COPILOT_HOOK_TYPES,
  COPILOT_EVENT_TYPES,
} from './importer.js';
export type {
  CopilotImportOptions,
  CopilotImportStats,
  CopilotHookType,
  CopilotEventType,
} from './importer.js';

export {
  CopilotWrapper,
  createCopilotWrapper,
  getDefaultCopilotWrapper,
  resetDefaultCopilotWrapper,
} from './wrapper.js';
export type {
  CopilotWrapperOptions,
  CopilotSessionListItem,
  CopilotLaunchResult,
  CopilotStreamCallbacks,
  CopilotSessionExtract,
} from './wrapper.js';

export {
  CopilotInjector,
  createCopilotInjector,
  YONDERMESH_BLOCK_START,
  YONDERMESH_BLOCK_END,
  defaultYondermeshAwarenessBlock,
} from './inject.js';
export type {
  CopilotInjectOptions,
  CopilotMcpServerDef,
  CopilotSkillDef,
  CopilotHookDef,
  CopilotAlwaysOnDef,
  CopilotInjectResult,
} from './inject.js';
