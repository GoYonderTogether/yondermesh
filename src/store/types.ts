/**
 * Session Store 领域类型
 *
 * 身份三元组：device_id + source_instance_id + native_session_id
 * （见 architecture.md §3.1，禁止只用 CLI 名和 session id）
 */

/** 覆盖等级（architecture.md §2.2）：A 原生 adapter / B 兼容 importer / C discovery */
export type Coverage = 'A' | 'B' | 'C';

/** 正交状态 - presence（architecture.md §3.3） */
export type Presence = 'present' | 'missing' | 'unknown';

/** 正交状态 - retention（architecture.md §3.3） */
export type Retention = 'live' | 'archived' | 'purged';

/** 拓扑角色（architecture.md §4 拓扑维度） */
export type SessionTopology = 'root' | 'subagent' | 'sidechain';

/** Session 关系类型（architecture.md §3.4，单独建模，不塞 parent_id） */
export type RelationType =
  | 'spawned_by'
  | 'sidechain_of'
  | 'continued_from'
  | 'import_alias_of'
  | 'derived_from';

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** 扫描运行状态 */
export type ScanRunStatus = 'running' | 'completed' | 'failed';

/** 来源实例注册输入 */
export interface SourceInstanceInput {
  deviceId: string;
  source: string;
  rootPath?: string;
  coverage?: Coverage;
}

/** 来源实例记录 */
export interface SourceInstance {
  id: string;
  deviceId: string;
  source: string;
  rootPath: string | null;
  coverage: Coverage;
  presence: Presence;
}

/** 消息输入 */
export interface SessionMessageInput {
  role: MessageRole;
  content: string;
  timestamp?: number;
}

/** Session 入库输入 */
export interface SessionIngestInput {
  deviceId: string;
  sourceInstanceId: string;
  nativeSessionId: string;
  source: string;
  cwd?: string;
  projectPath?: string;
  startedAt?: number;
  topology?: SessionTopology;
  /** 本次内容来源等级，写入 revision 以保留 provenance */
  sourceKind?: Coverage;
  messages: SessionMessageInput[];
}

/** 入库结果 */
export interface IngestResult {
  sessionId: string;
  /** 是否首次创建 session */
  created: boolean;
  /** 是否产生了新 revision（内容变化） */
  newRevision: boolean;
  /** 当前 revision 号 */
  revisionNumber: number;
  /** 当前消息数 */
  messageCount: number;
}

/** 读取到的消息（当前 revision） */
export interface SessionMessage {
  seq: number;
  role: MessageRole;
  content: string;
  timestamp?: number;
}

/** Revision 记录 */
export interface RevisionRecord {
  id: number;
  sessionId: string;
  revisionNumber: number;
  contentHash: string;
  messageCount: number;
  sourceKind: Coverage | null;
  recordedAt: number;
}

/** 关系写入输入 */
export interface RelationshipInput {
  fromSessionId: string;
  toSessionId: string;
  relationType: RelationType;
  evidence?: string | null;
}

/** 查询到的关系（带方向标记） */
export interface Relationship extends RelationshipInput {
  evidence: string | null;
  direction: 'outgoing' | 'incoming';
}

/** scan_run 启动输入 */
export interface ScanRunStartInput {
  sourceInstanceId?: string;
  deviceId?: string;
}

/** scan_run 结束输入 */
export interface ScanRunFinishInput {
  status: ScanRunStatus;
  sessionsSeen?: number;
  sessionsNew?: number;
  sessionsUpdated?: number;
  error?: string;
}

/** scan_run 记录 */
export interface ScanRun {
  id: number;
  sourceInstanceId: string | null;
  deviceId: string | null;
  startedAt: number;
  endedAt: number | null;
  status: ScanRunStatus;
  sessionsSeen: number;
  sessionsNew: number;
  sessionsUpdated: number;
  error: string | null;
}

/** session 列表查询过滤 */
export interface SessionQuery {
  deviceId?: string;
  source?: string;
  topology?: SessionTopology;
  cwd?: string;
  limit?: number;
}

/** session 列表项 */
export interface SessionRecord {
  id: string;
  deviceId: string;
  sourceInstanceId: string;
  nativeSessionId: string;
  source: string;
  cwd: string | null;
  topology: SessionTopology;
  presence: Presence;
  retention: Retention;
  contentHash: string;
  currentRevisionId: number | null;
  messageCount: number;
  startedAt: number | null;
  lastSeenAt: number;
}
