/**
 * yondermesh — 自托管 Agent 上下文总线
 *
 * 让用户所有设备上、所有 CLI 里的 AI agent 共享同一份工作现场：
 * 互相看见、互相查询、互相接力。
 */

// Session Store（LOOP-001）
export { SessionStore, SCHEMA } from './store/index.js';
export type {
  Coverage,
  IngestResult,
  MessageRole,
  Presence,
  RelationType,
  Relationship,
  RelationshipInput,
  RevisionRecord,
  Retention,
  ScanRun,
  ScanRunFinishInput,
  ScanRunStartInput,
  SessionIngestInput,
  SessionMessage,
  SessionQuery,
  SessionRecord,
  SessionTopology,
  SourceInstance,
  SourceInstanceInput,
} from './store/index.js';

// cass 历史导入（LOOP-002，覆盖等级 B）
export { CassImporter, resolveCassDbPath } from './cass/index.js';
export type { CassImportOptions, CassImportStats } from './cass/index.js';

// Claude Code 原生 adapter（LOOP-003，覆盖等级 A）
export { ClaudeCodeImporter, resolveClaudeProjectsPath } from './claude/index.js';
export type { ClaudeImportOptions, ClaudeImportStats } from './claude/index.js';

// Codex 原生 adapter（LOOP-004，覆盖等级 A）
export { CodexImporter, resolveCodexSessionsPath } from './codex/index.js';
export type { CodexImportOptions, CodexImportStats } from './codex/index.js';

// 后续 Loop 的骨架导出（暂保留）
export { McpServer } from './mcp/server.js';
export { SyncAgent } from './sync/agent.js';
export { BriefingGenerator } from './briefing/generator.js';
export type { YondermeshConfig } from './daemon/config.js';
