/**
 * 需求与响应提取器类型定义
 *
 * 从 SessionStore 中提取某项目的全部 user 消息（需求）和 assistant 消息（响应），
 * 分别存为两个 NDJSONL 文件，每行一条记录，行号 = ID（1-based），支持精确索引。
 */

import type { MessageRole } from '../store/types.js';

/** 一条提取出的消息记录（NDJSONL 中的一行） */
export interface ExtractEntry {
  /** 全局递增 ID（在该项目的 requirements 或 responses 文件内唯一），1-based，等于行号 */
  id: number;
  /** yondermesh 内部 session ID（可用于反查 store） */
  sessionId: string;
  /** 原生 session ID（CLI 工具的原始标识） */
  sessionNativeId: string;
  /** 来源 CLI（codex / claude / cass 等） */
  source: string;
  /** 消息在 session 内的序号 */
  seq: number;
  /** 消息角色 */
  role: MessageRole;
  /** 消息时间戳（epoch ms，可能缺失） */
  timestamp?: number;
  /** session 开始时间（epoch ms） */
  sessionStartedAt?: number;
  /** session 工作目录 */
  cwd: string | null;
  /** 消息文本内容 */
  content: string;
}

/** 提取选项 */
export interface ExtractOptions {
  /** cwd 前缀匹配（推荐：目录边界安全） */
  cwdPrefix?: string;
  /** projectPath 精确匹配 */
  projectPath?: string;
  /** session 起始时间下界（含） */
  startedAtFrom?: number;
  /** session 起始时间上界（含） */
  startedAtTo?: number;
  /** 数据库路径（默认 ~/.yondermesh/yondermesh.db） */
  dbPath?: string;
}

/** 提取结果摘要（同时作为 index.json 的内容） */
export interface ExtractResult {
  /** 项目哈希（sha256 前 16 位） */
  projectHash: string;
  /** 项目路径（cwdPrefix 或 projectPath） */
  projectPath: string;
  /** 需求文件路径 */
  requirementsFile: string;
  /** 响应文件路径 */
  responsesFile: string;
  /** 索引文件路径 */
  indexFile: string;
  /** 需求（user 消息）总数 */
  requirementCount: number;
  /** 响应（assistant 消息）总数 */
  responseCount: number;
  /** session 总数 */
  sessionCount: number;
  /** 本次提取时间戳 */
  extractedAt: number;
}

/** 查询选项 */
export interface QueryOptions {
  /** 按精确 ID 查找（= 行号，1-based） */
  id?: number;
  /** 关键词模糊匹配（大小写不敏感，匹配 content） */
  keyword?: string;
  /** 按 session ID 过滤 */
  sessionId?: string;
  /** 返回条数上限 */
  limit?: number;
  /** 跳过前 N 条 */
  offset?: number;
  /** session 起始时间下界（按 sessionStartedAt，回退到 timestamp） */
  startedAtFrom?: number;
  /** session 起始时间上界（按 sessionStartedAt，回退到 timestamp） */
  startedAtTo?: number;
}

/** 查询结果条目（与 ExtractEntry 同形） */
export type QueryEntry = ExtractEntry;

/** 文件类型 */
export type ExtractKind = 'requirements' | 'responses';
