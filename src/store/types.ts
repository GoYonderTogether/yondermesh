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
  /** 元数据（LOOP-012） */
  model?: string;
  cliVersion?: string;
  originator?: string;
  entrySource?: string;
  threadSource?: string;
  estimatedCostUsd?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  toolCallCount?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  grandTotalTokens?: number;
  apiCallCount?: number;
  /** session 文件的实际 mtime（由 importer stat 文件传入），用于活跃度判定 */
  fileModifiedAt?: number;
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
  /** 精确 projectPath 匹配 */
  projectPath?: string;
  /** startedAt 闭区间起点（含） */
  startedAtFrom?: number;
  /** startedAt 闭区间终点（含） */
  startedAtTo?: number;
  /** cwd 前缀匹配（目录边界安全，LIKE 特殊字符转义） */
  cwdPrefix?: string;
  /** projectPath 前缀匹配（目录边界安全） */
  projectPrefix?: string;
  limit?: number;
  /** 是否包含 archived（被去重的）session，默认 false */
  includeArchived?: boolean;
  /** 按模型过滤 */
  model?: string;
}

/** session 列表项 */
export interface SessionRecord {
  id: string;
  deviceId: string;
  sourceInstanceId: string;
  nativeSessionId: string;
  source: string;
  cwd: string | null;
  projectPath: string | null;
  topology: SessionTopology;
  presence: Presence;
  retention: Retention;
  contentHash: string;
  currentRevisionId: number | null;
  messageCount: number;
  startedAt: number | null;
  lastSeenAt: number;
  /** 元数据（LOOP-012） */
  model: string | null;
  cliVersion: string | null;
  originator: string | null;
  entrySource: string | null;
  threadSource: string | null;
  estimatedCostUsd: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  toolCallCount: number | null;
  fileModifiedAt: number | null;
}

/** 查询统计结果 */
export interface SessionStats {
  totalSessions: number;
  rootSessions: number;
  subagentSessions: number;
  totalMessages: number;
}

/** 活跃度分级 */
export type ActivityStatus = 'live' | 'idle' | 'stopped' | 'stale';

/** 活跃 session 摘要项（最近 N 分钟内有 lastSeenAt 的 session） */
export interface ActiveSessionSummary {
  sessionId: string;
  nativeSessionId: string;
  source: string;
  cwd: string | null;
  projectPath: string | null;
  topology: SessionTopology;
  lastSeenAt: number;
  messageCount: number;
  /** session 文件的实际 mtime（活跃度判定的依据） */
  fileModifiedAt: number;
  /** 最近 LIVE_THRESHOLD_MS 内有 lastSeenAt 视为 live（正在写入） */
  isLive: boolean;
  /** 活跃度分级 */
  activityStatus: ActivityStatus;
  /** 进程是否存活（true=运行中，false=已退出，null=未检测） */
  processAlive: boolean | null;
}

/** 活跃 session 聚合摘要 */
export interface ActiveSummary {
  /** 最近 withinMs 内活跃的 session 数 */
  totalActive: number;
  /** 最近 LIVE_THRESHOLD_MS 内正在写入的 session 数 */
  liveCount: number;
  /** 活跃但非 LIVE（LIVE_THRESHOLD_MS ~ STALE_THRESHOLD_MS 之间）的 session 数 */
  idleCount: number;
  /** 超过 STALE_THRESHOLD_MS 未活动的 session 数 */
  staleCount: number;
  /** 进程已退出的 session 数（仅在使用 processAliveChecker 时统计） */
  stoppedCount: number;
  /** 活跃 session 中 subagent 数 */
  subagentActive: number;
  /** 活跃 session 中 root 数 */
  rootActive: number;
  /** 按 source 分组统计 */
  bySource: Record<string, number>;
  /** 按 fileModifiedAt 倒序排列的活跃 session 列表 */
  sessions: ActiveSessionSummary[];
}

/** 等待审阅的 session */
export interface AwaitingReviewSession {
  sessionId: string;
  nativeSessionId: string;
  source: string;
  cwd: string | null;
  projectPath: string | null;
  topology: SessionTopology;
  messageCount: number;
  fileModifiedAt: number;
  /** 最后一条消息的角色 */
  lastRole: MessageRole;
  /** 最后一条消息的内容预览（前 100 字符） */
  lastMessagePreview: string;
}
