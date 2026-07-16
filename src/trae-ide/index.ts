/**
 * Trae IDE 集成模块入口
 *
 * 覆盖等级 B（兼容 importer，summary-only）—— Trae 把 session 存在 SQLCipher 加密的
 * SQLite（database.db）+ JSONL 摘要（~/.trae-cn/memory/projects）。
 *
 * SQLCipher 破解失败（key 极可能从 macOS Keychain 派生），降级为 B 级 JSONL 摘要采集。
 * 130+ 个 session_memory_*.jsonl 文件可读，足以提取 session 摘要并支持跨 agent 转交。
 *
 * 三个组件：
 *   - extractor：从 JSONL 摘要提取 session 入库 + SQLCipher 破解尝试
 *   - wrapper：单 session 提取/转交 + 活跃 session 主动观察（替代 hooks）
 *   - inject：Always-on rules / 项目级 MCP / Skills 注入
 */

export {
  TraeIdeExtractor,
  tryCrackTraeSqlcipher,
} from './extractor.js';
export type {
  TraeIdeExtractOptions,
  TraeIdeExtractStats,
} from './extractor.js';

export {
  TRAE_CONFIG_DIRS,
  TRAE_RULES_START,
  TRAE_RULES_END,
  traeRulesPath,
  extractSession,
  transferSession,
  observeActiveSessions,
  openTraeWorkspace,
} from './wrapper.js';
export type {
  TraeExtractSessionResult,
  TraeTransferSessionResult,
  TraeActiveSessionObservation,
} from './wrapper.js';

export {
  TRAE_PROJECT_MCP_DIR,
  TRAE_PROJECT_MCP_FILE,
  injectTraeIde,
  uninstallTraeIdeInjection,
} from './inject.js';
export type {
  TraeInjectOptions,
  TraeInjectResult,
} from './inject.js';
