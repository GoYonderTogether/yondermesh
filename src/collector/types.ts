/**
 * 采集器类型定义
 */

/** Session 来源（哪个 CLI agent） */
export type AgentType =
  | 'claude-code'
  | 'codex'
  | 'aider'
  | 'gemini-cli'
  | 'opencode'
  | 'crush'
  | 'trae-agent'
  | 'hermes'
  | 'openclaw'
  | 'yonder-agent';

/** Session 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** Session 消息记录 */
export interface SessionMessage {
  role: MessageRole;
  content: string;
  timestamp?: number;
  toolCalls?: ToolCall[];
}

/** 工具调用 */
export interface ToolCall {
  name: string;
  input: unknown;
  output?: string;
  status?: 'success' | 'error';
}

/** Session 记录 */
export interface SessionRecord {
  /** 全局唯一 ID（hash 生成） */
  id: string;
  /** 来源 agent 类型 */
  agent: AgentType;
  /** 来源设备名 */
  device: string;
  /** 项目路径 */
  projectPath: string;
  /** Session 开始时间（Unix ms） */
  startedAt: number;
  /** Session 结束时间（Unix ms） */
  endedAt?: number;
  /** 消息列表 */
  messages: SessionMessage[];
  /** 消息数 */
  messageCount: number;
  /** 摘要（LLM 生成，可选） */
  summary?: string;
}

/** 采集器配置 */
export interface CollectorConfig {
  /** agent 类型 */
  type: AgentType;
  /** session 文件路径 */
  path: string;
  /** 设备名 */
  device: string;
}

/** 采集器接口 */
export interface Collector {
  /** agent 类型 */
  readonly type: AgentType;
  /** 扫描并返回新 session（增量） */
  scan(): AsyncIterable<SessionRecord>;
  /** 获取默认 session 路径 */
  defaultPath(): string;
}

/** 查询参数 */
export interface SessionQuery {
  agent?: AgentType;
  device?: string;
  projectPath?: string;
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string;
}

/** 查询结果 */
export interface SessionQueryResult {
  sessions: SessionRecord[];
  nextCursor?: string;
  total: number;
}
