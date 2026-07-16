/**
 * yondermesh Adapter SDK —— 公共类型定义
 *
 * 从 store / mount 领域类型中提取 adapter 开发所需的公共接口，供外部 adapter
 * 直接 import 使用。规范见 `specs/adapter-spec.md`。
 *
 * 命名约定：本文件定义结构化契约接口（Importer / Wrapper / Injector），
 * 抽象基类（BaseImporter / BaseWrapper / BaseInjector）在各自的 base-*.ts 中实现
 * 这些契约，二者名称不同以避免在 index.ts 重复导出冲突。
 */

import type { SessionMessageInput, SessionTopology } from '../store/types.js';
import type { MountStrategyType } from '../mount/types.js';

// ─── 领域类型再导出（供外部 adapter 单点 import） ─────────────────────
export type {
  Coverage,
  MessageRole,
  RelationType,
  Relationship,
  RelationshipInput,
  Retention,
  SessionIngestInput,
  SessionMessageInput,
  SessionRecord,
  SessionTopology,
} from '../store/types.js';
export type {
  CliCapability,
  CliTarget,
  Extension,
  ExtensionType,
  McpServerDef,
  MountResult,
  MountStatus,
  MountStrategyType,
} from '../mount/types.js';
export { CONTEXT_BLOCK_START, CONTEXT_BLOCK_END } from '../mount/types.js';

// ─── Importer 契约 ─────────────────────────────────────────────────────

/** Importer 导入统计（SDK 形态，与各 agent 的 *ImportStats 字段对齐） */
export interface ImporterStats {
  /** 本次 scan_run id */
  scanRunId: number;
  /** source instance id */
  sourceInstanceId: string;
  /** 扫描到的文件总数 */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的文件数（无有效消息 / 脏文件） */
  skipped: number;
}

/** 子类 parse() 返回的解析结果 */
export interface ParsedSession {
  /** native session id（UUID 优先，便于跨源 matchKey 匹配） */
  nativeId: string;
  /** 子 agent 的父根 native id（仅 subagent 有；根为 undefined） */
  parentRootNativeId?: string;
  /** 工作目录 */
  cwd?: string;
  /** 项目路径 */
  projectPath?: string;
  /** 开始时间（epoch ms） */
  startedAt?: number;
  /** 拓扑角色 */
  topology: SessionTopology;
  /** 是否 sidechain（true 时额外写 sidechain_of 关系） */
  sidechain?: boolean;
  /** 可显示消息（仅 user/assistant 文本，排除 thinking/tool_use） */
  messages: SessionMessageInput[];
  /** 元数据（A 级应尽量提供） */
  model?: string;
  cliVersion?: string;
  originator?: string;
  entrySource?: string;
  threadSource?: string;
  estimatedCostUsd?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  toolCallCount?: number;
}

/** Importer 契约：扫描 session 文件并写入 SessionStore */
export interface Importer {
  import(): ImporterStats;
}

/** BaseImporter 构造选项 */
export interface BaseImporterOptions {
  /** 设备 id，默认 os.hostname() */
  deviceId: string;
  /** 直接指定扫描根目录（覆盖 resolveRootPath） */
  rootPath?: string;
}

// ─── Wrapper 契约 ──────────────────────────────────────────────────────

/** 启动选项 */
export interface LaunchOptions {
  /** 模型名（如 glm-5.2、claude-opus-4-7） */
  model?: string;
  /** provider（如 custom/openai/auto） */
  provider?: string;
  /** 预加载 skill 列表 */
  skills?: string[];
  /** 工作目录 */
  cwd?: string;
  /** 超时毫秒，默认 120000 */
  timeoutMs?: number;
  /** 附加环境变量 */
  env?: Record<string, string>;
}

/** 启动结果 */
export interface LaunchResult {
  /** session id */
  sessionId: string;
  /** assistant 最终响应文本 */
  response: string;
  /** 完整 stdout */
  stdout: string;
  /** stderr */
  stderr: string;
  /** 退出码 */
  exitCode: number;
}

/** session 摘要（listSessions 用） */
export interface SessionSummary {
  id: string;
  source?: string | null;
  model?: string | null;
  cwd?: string | null;
  title?: string | null;
  parentSessionId?: string | null;
  messageCount: number;
  startedAt: number;
  lastActiveAt: number;
  archived?: boolean;
}

/** 中性消息格式（跨 agent） */
export interface NeutralMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: number;
  model?: string;
  tool_calls?: unknown[];
}

/** 中性 session 格式（extractSession 输出 / transferSession 输入） */
export interface NeutralSession {
  /** 来源 CLI 标识 */
  source: string;
  /** 原 CLI 的 session id */
  sessionId: string;
  model: string | null;
  cwd: string | null;
  topology: 'root' | 'subagent';
  parentSessionId: string | null;
  startedAt: number;
  messages: NeutralMessage[];
  metadata: {
    messageCount: number;
    toolCallCount: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number | null;
  };
}

/** 转交包（transferSession 输出） */
export interface TransferPackage {
  sourceCli: string;
  targetCli: string;
  session: NeutralSession;
  /** 可直接喂给目标 CLI 的转交提示词 */
  handoffPrompt: string;
  generatedAt: number;
}

/** 流式事件 */
export type StreamEvent =
  | { type: 'message'; role: 'user' | 'assistant'; content: string; timestamp?: number }
  | { type: 'tool'; name: string; input?: unknown; output?: unknown }
  | { type: 'done'; exitCode: number }
  | { type: 'error'; message: string };

/** Wrapper 中途注入结果 */
export interface InjectResult {
  success: boolean;
  message: string;
  sessionId?: string;
}

/** Wrapper 契约：CLI 链式调用 */
export interface Wrapper {
  launch(prompt: string, opts?: LaunchOptions): Promise<LaunchResult>;
  inject(sessionId: string, message: string): Promise<InjectResult>;
  interrupt(sessionId: string): Promise<void>;
  getStream(sessionId: string): AsyncIterable<StreamEvent>;
  listSessions(): SessionSummary[];
  extractSession(sessionId: string): NeutralSession;
  transferSession(sessionId: string, targetCli: string): TransferPackage;
}

// ─── Injector 契约 ─────────────────────────────────────────────────────

/** Injector 单次注入结果 */
export interface InjectorResult {
  /** 注入策略 */
  strategy: MountStrategyType;
  /** 目标文件 / 目录路径 */
  target: string;
  /** 是否成功 */
  success: boolean;
  /** 消息 */
  message: string;
}

/** Injector 契约：幂等挂载 / 卸载 ymesh 扩展 */
export interface Injector {
  injectAll(): Promise<void>;
  uninjectAll(): Promise<void>;
}

/** BaseInjector 构造选项 */
export interface BaseInjectorOptions {
  /** home 目录，默认 os.homedir() */
  home?: string;
  /** 自定义 awareness 块内容（默认用 DEFAULT_AWARENESS_BLOCK） */
  awarenessBlock?: string;
}

/** SDK 默认 awareness 块内容（与 src/hermes/inject.ts 对齐） */
export const DEFAULT_AWARENESS_BLOCK = `# Yondermesh Awareness

You are running on a machine with yondermesh (ymesh) installed — a self-hosted
agent context bus that indexes sessions from all CLI agents (Claude Code, Codex,
Hermes, and more) into a unified local store.

Key implications for your operation:
- Your conversations are being indexed by ymesh. Other agents on this machine
  can query your session history via ymesh (read-only, for context sharing).
- You can hand off tasks to other agents: use "ymesh handoff <session_id>" to
  generate a transfer package, or ask the user to invoke it.
- Cross-session context is available: other agents' recent work is queryable
  via "ymesh sessions" or the ymesh MCP server.
- To check who else is working right now: "ymesh active".

You do NOT need to call ymesh yourself unless explicitly asked. Just be aware
that your session context may be shared with other agents on this machine for
continuity purposes.`;
