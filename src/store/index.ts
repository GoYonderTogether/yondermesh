/**
 * Session Store 模块入口
 */

export { SessionStore } from './session-store.js';
export { SCHEMA } from './schema.js';
export { normalizeSource, expandSource, extractCanonicalId, sessionMatchKey } from './source-aliases.js';
export type {
  Coverage,
  IngestResult,
  MessageRole,
  Presence,
  Relationship,
  RelationshipInput,
  RelationType,
  RevisionRecord,
  Retention,
  ScanRun,
  ScanRunFinishInput,
  ScanRunStartInput,
  ScanRunStatus,
  SessionIngestInput,
  SessionMessage,
  SessionMessageInput,
  SessionQuery,
  SessionStats,
  SessionRecord,
  SessionTopology,
  SourceInstance,
  SourceInstanceInput,
} from './types.js';
