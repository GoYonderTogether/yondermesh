/**
 * Windsurf 兼容 adapter 模块入口（覆盖等级 B）
 *
 * 三件套：
 *   - extractor：扫描 hook transcript（~/.yondermesh/windsurf-transcripts/）
 *     解析为 ymesh StoredSession 入库。Windsurf 的 cascade .pb 文件加密不可读，
 *     通过 POST_CASCADE_RESPONSE_WITH_TRANSCRIPT hook 采集完整 transcript 作为
 *     A 级采集入口（来源标记 `windsurf`，B 级兼容 importer）。
 *   - wrapper：12 个 Cascade Hook 事件处理 + session 提取 + 转交
 *   - inject：MCP / Skills / Hooks / Always-on rules 四件套注入（幂等）
 */

export {
  WindsurfExtractor,
  WINDSURF_CONFIG_DIR,
  WINDSURF_CASCADE_DIR,
  WINDSURF_TRANSCRIPTS_DIR,
} from './extractor.js';
export type {
  WindsurfExtractOptions,
  WindsurfExtractStats,
} from './extractor.js';

export {
  handleWindsurfHookEvent,
  extractSession,
  transferSession,
  openWindsurfWorkspace,
  WINDSURF_CASCADE_HOOK_EVENTS,
  WINDSURF_PRIMARY_HOOK_EVENT,
  WINDSURF_CORE_HOOK_EVENTS,
  WINDSURF_EVENTS_FILE,
} from './wrapper.js';
export type {
  WindsurfHookPayload,
  HookHandleResult,
  ExtractSessionResult,
  TransferSessionResult,
} from './wrapper.js';

export {
  injectWindsurf,
  uninstallWindsurfInjection,
  WINDSURF_MCP_PATH,
  WINDSURF_MCP_ALT_PATH,
  WINDSURF_SKILLS_DIR,
  WINDSURF_HOOKS_TEMPLATE_PATH,
  WINDSURF_RULES_PATH,
} from './inject.js';
export type {
  WindsurfInjectOptions,
  WindsurfInjectResult,
} from './inject.js';
