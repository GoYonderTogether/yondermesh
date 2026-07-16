/**
 * OpenCode 原生 adapter 模块入口（覆盖等级 A）
 *
 * 三件套：
 *   - importer：只读扫描本机 OpenCode SQLite（~/.local/share/opencode/opencode.db）
 *     解析 session/message/part 入库（D1-D10 数据维度全覆盖）
 *   - wrapper：HTTP API controller，实时控制运行中 session
 *     （launch / inject 中途注入 / interrupt / SSE 流订阅 / extract / transfer）
 *   - inject：MCP / Skills / AGENTS.md / Hooks 提示词注入（幂等）
 */

export {
  OpenCodeImporter,
  resolveOpenCodeDbPath,
} from './importer.js';
export type {
  OpenCodeImportOptions,
  OpenCodeImportStats,
} from './importer.js';

export {
  OpenCodeController,
} from './wrapper.js';
export type {
  OpenCodeControllerOptions,
  OpenCodeSessionInfo,
  OpenCodeMessage,
  NeutralSession,
} from './wrapper.js';

export {
  injectMcp,
  removeMcp,
  injectSkill,
  removeSkill,
  injectAgentsMd,
  removeAgentsMd,
  injectHooks,
  injectAll,
  OPENCODE_CONFIG_DIR,
  OPENCODE_JSONC,
  OPENCODE_JSON,
  OPENCODE_AGENTS_MD,
  OPENCODE_SKILLS_DIR,
  DEFAULT_AGENTS_MD,
} from './inject.js';
export type {
  McpServerConfig,
  SkillInjectOptions,
  HookConfig,
  InjectResult,
  InjectAllOptions,
} from './inject.js';
