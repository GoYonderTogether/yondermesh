/**
 * Cursor IDE 集成模块入口
 *
 * 覆盖等级 B（兼容 importer）—— Cursor 把 session 存在加密/内部的 SQLite，
 * ymesh 通过破解读取 cursorDiskKV 表（明文 JSON BLOB）提取 chat history。
 *
 * 三个组件：
 *   - extractor：从 state.vscdb + agent-transcripts JSONL 提取 session 入库
 *   - wrapper：hook 事件处理 + 单 session 提取/转交
 *   - inject：MCP / Skills / Hooks / Always-on rules 注入
 */

export {
  CursorIdeExtractor,
} from './extractor.js';
export type {
  CursorIdeExtractOptions,
  CursorIdeExtractStats,
} from './extractor.js';

export {
  CURSOR_HOOKS_PATH,
  CURSOR_HOOK_EVENTS,
  CURSOR_CORE_HOOK_EVENTS,
  handleCursorHookEvent,
  extractSession,
  transferSession,
  openCursorWorkspace,
} from './wrapper.js';
export type {
  CursorHookPayload,
  HookHandleResult,
  ExtractSessionResult,
  TransferSessionResult,
} from './wrapper.js';

export {
  CURSOR_CONFIG_DIR,
  CURSOR_MCP_PATH,
  CURSOR_SKILLS_DIR,
  CURSOR_RULES_PATH,
  CURSOR_RULES_ALT_PATH,
  injectCursorIde,
  uninstallCursorIdeInjection,
} from './inject.js';
export type {
  CursorInjectOptions,
  CursorInjectResult,
} from './inject.js';
