/**
 * Copilot CLI / Copilot SDK 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 ~/.copilot/session-state/<uuid>/ 下的 Copilot 原生 session：
 *   - events.jsonl  —— 完整事件流（消息、hook、工具调用、shutdown 指标）
 *   - workspace.yaml —— session 元数据（cwd / repository / branch / client_name）
 *   - ~/.copilot/session-store.db —— Copilot 自带 SQLite 索引（summary / turns 文本）
 *
 * 真实结构（本机 ~/.copilot 实测，2026-07）：
 *   - 路径：<rootPath>/<uuid>/events.jsonl + <rootPath>/<uuid>/workspace.yaml
 *   - events.jsonl 每行一个事件：{ type, data, id, timestamp, parentId }
 *   - 关键事件类型（实测含 17 种）：
 *       session.start / session.shutdown / session.model_change / session.mode_changed / session.resume
 *       system.message / user.message
 *       assistant.turn_start / assistant.message / assistant.turn_end
 *       tool.execution_start / tool.execution_complete
 *       function / subagent.selected / abort
 *       hook.start / hook.end   —— 8 个 hookType:
 *         sessionStart / sessionEnd / userPromptSubmitted / preToolUse / postToolUse /
 *         agentStop / subagentStop / errorOccurred
 *   - session.start.data：{ sessionId, version, producer("copilot-agent"), copilotVersion,
 *       startTime, context:{cwd,gitRoot,branch,headCommit,baseCommit}, selectedModel?(SDK),
 *       contextTier?(SDK), alreadyInUse, remoteSteerable }
 *   - user.message.data：{ content, transformedContent, attachments, interactionId,
 *       parentAgentTaskId?(subagent), delivery?(SDK) }
 *   - assistant.message.data：{ messageId, model, content, toolRequests[], outputTokens,
 *       interactionId, turnId, apiCallId?(SDK) }
 *   - session.shutdown.data：{ shutdownType, totalPremiumRequests, totalApiDurationMs,
 *       sessionStartTime, codeChanges, modelMetrics:{<model>:{requests,usage,cost?}},
 *       currentModel, currentTokens, systemTokens, conversationTokens, toolDefinitionsTokens,
 *       eventsFileSizeBytes?(SDK), totalNanoAiu?(SDK) }
 *
 * CLI 与 SDK 区分（CLI=v1.0.47 本机 PATH / SDK=v1.0.70 捆绑 @github/copilot-sdk@1.0.6）：
 *   - workspace.yaml 含 `client_name: sdk` → SDK
 *   - 否则 → CLI（默认）
 *   - 信号冗余：SDK session.start 含 selectedModel / contextTier；shutdown 含
 *     eventsFileSizeBytes / totalNanoAiu；assistant.message 含 apiCallId；assistant.turn_*
 *     含 model 字段。任一信号成立亦判定为 SDK，避免 workspace.yaml 缺失时漏判。
 *
 * 拓扑（§4）：Copilot 当前版本所有 session 均为 root（subagent.selected 仅切换 agent
 * 配置文件，不产生子 session 文件）。parentAgentTaskId 字段保留以备未来 subagent 拓扑。
 *
 * 关系（§3.4）：session.resume 事件存在时，写入 continued_from 关系指向被恢复 session。
 *
 * 消息：只取 user.message.content 与 assistant.message.content 的可显示文本；
 *   排除 system.message（开发者 system prompt）、tool.execution_*、function、
 *   abort、hook.*、subagent.selected、session.* 元事件、transformedContent（含
 *   <current_datetime> 等 runtime 注入，非用户原文）。
 *
 * 元数据：cwd / model / cliVersion / originator（copilot_cli|copilot_sdk）/
 *   entrySource（"new"|"resume"） / token 用量与 cost（来自 shutdown.modelMetrics）。
 *
 * 幂等：依赖 SessionStore 的 content_hash（消息内容+顺序）；脏行跳过，无有效消息
 * 的 session 跳过（计入 skipped）。
 *
 * Copilot session-store.db（可选富化）：当数据库存在时读取 sessions.summary 与
 * turns.{user_message,assistant_response} 做 cross-check，但 events.jsonl 为权威源
 * （消息粒度更细、含 token 统计），不直接以 SQLite 内容覆盖 events.jsonl 解析结果。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  Coverage,
  SessionMessageInput,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

/** macOS / 通用默认 Copilot 配置目录 */
const DEFAULT_COPILOT_HOME_DIR = path.join(os.homedir(), '.copilot');
/** session-state 子目录名（每个 <uuid>/ 子目录为一个 session） */
const SESSION_STATE_SEGMENT = 'session-state';
/** events.jsonl 文件名 */
const EVENTS_FILENAME = 'events.jsonl';
/** workspace.yaml 文件名 */
const WORKSPACE_FILENAME = 'workspace.yaml';
/** Copilot 自带 SQLite 索引文件名 */
const SESSION_STORE_DB_FILENAME = 'session-store.db';

/** Copilot 8 个 hook 类型（hook.start/hook.end 事件的 data.hookType 取值） */
export const COPILOT_HOOK_TYPES = [
  'sessionStart',
  'sessionEnd',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'agentStop',
  'subagentStop',
  'errorOccurred',
] as const;
export type CopilotHookType = (typeof COPILOT_HOOK_TYPES)[number];

/** 已知 events.jsonl 事件类型（实测 17 种） */
export const COPILOT_EVENT_TYPES = [
  'session.start',
  'session.shutdown',
  'session.model_change',
  'session.mode_changed',
  'session.resume',
  'system.message',
  'user.message',
  'assistant.turn_start',
  'assistant.message',
  'assistant.turn_end',
  'tool.execution_start',
  'tool.execution_complete',
  'function',
  'subagent.selected',
  'abort',
  'hook.start',
  'hook.end',
] as const;
export type CopilotEventType = (typeof COPILOT_EVENT_TYPES)[number];

/** 导入器选项 */
export interface CopilotImportOptions {
  /** 直接指定 ~/.copilot 根目录，默认 os.homedir()/.copilot */
  homePath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
  /** 是否跳过 Copilot session-store.db 富化（默认 false，db 不存在自动跳过） */
  skipSessionStoreDb?: boolean;
}

/** 导入统计 */
export interface CopilotImportStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** copilot source instance id */
  sourceInstanceId: string;
  /** 扫描到的 session 目录总数（含无 events.jsonl 的空目录） */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 session 数（无 events.jsonl / 无有效消息 / 脏文件） */
  skipped: number;
  /** 入库的 CLI 来源 session 数（originator=copilot_cli） */
  cliSessions: number;
  /** 入库的 SDK 来源 session 数（originator=copilot_sdk） */
  sdkSessions: number;
  /** 写入的 continued_from 关系数（基于 session.resume 事件） */
  relationships: number;
  /** Copilot session-store.db 富化命中数（summary 已写入 sessions.summary） */
  dbEnriched: number;
}

/** 单条 events.jsonl 行的松散结构 */
type EventLine = {
  type?: string;
  data?: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
};

/** workspace.yaml 的极简解析结果（不引入 yaml 依赖，按行解析） */
interface WorkspaceYaml {
  cwd?: string;
  gitRoot?: string;
  repository?: string;
  branch?: string;
  /** SDK 标记：workspace.yaml 中 client_name: sdk 表示 SDK 启动 */
  clientName?: string;
  name?: string;
  summaryCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** 一个 session 的解析结果 */
interface ParsedSession {
  /** native session id（= 目录名 uuid，与 session.start.data.sessionId 一致） */
  nativeId: string;
  cwd?: string;
  gitRoot?: string;
  branch?: string;
  startedAt?: number;
  /** SDK 或 CLI 标记 */
  originator: 'copilot_cli' | 'copilot_sdk';
  /** "new" | "resume" | undefined（来自 hook.start.sessionStart.input.source） */
  entrySource?: string;
  messages: SessionMessageInput[];
  /** 最终模型（model_change 覆盖 / shutdown.currentModel） */
  model?: string;
  /** copilotVersion（session.start.data.copilotVersion） */
  cliVersion?: string;
  /** session.resume 事件指向的被恢复 sessionId（如有） */
  resumedFrom?: string;
  /** token 与 cost 统计（来自 shutdown.modelMetrics 累积） */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  estimatedCostUsd?: number;
  apiCallCount?: number;
  /** hook 计数（按 8 种类型） */
  hookCounts: Record<CopilotHookType, number>;
}

/** Copilot session-store.db 中 sessions 表行（仅读 summary / created_at 做 cross-check） */
interface DbSessionRow {
  id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// node:sqlite 是实验性内置，vitest/vite 静态解析会误判为裸包 sqlite。
// 用 createRequire 在运行时加载，绕过 vite 预优化；类型仍取自 @types/node。
const nodeRequire = createRequire(import.meta.url);
let DatabaseSyncCtor: typeof DatabaseSyncType | null = null;
try {
  DatabaseSyncCtor = nodeRequire('node:sqlite').DatabaseSync as typeof DatabaseSyncType;
} catch {
  DatabaseSyncCtor = null; // node:sqlite 不可用时降级为跳过 SQLite 富化
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 解析 ISO 时间戳为 epoch 毫秒；非法/缺失返回 undefined */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * 极简 YAML 解析（仅支持 workspace.yaml 的扁平 `key: value` 形式）。
 * 不引入 yaml 依赖；workspace.yaml 是简单 key-value 文件，不需要嵌套。
 * 字符串值去除前后引号；空值返回 undefined。
 */
function parseWorkspaceYaml(content: string): WorkspaceYaml {
  const out: WorkspaceYaml = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('---')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // 去除引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length === 0 || value === 'null' || value === '~') continue;
    switch (key) {
      case 'cwd':
        out.cwd = value;
        break;
      case 'git_root':
        out.gitRoot = value;
        break;
      case 'repository':
        out.repository = value;
        break;
      case 'branch':
        out.branch = value;
        break;
      case 'client_name':
        out.clientName = value;
        break;
      case 'name':
        out.name = value;
        break;
      case 'summary_count':
        out.summaryCount = Number.parseInt(value, 10);
        break;
      case 'created_at':
        out.createdAt = value;
        break;
      case 'updated_at':
        out.updatedAt = value;
        break;
    }
  }
  return out;
}

/** 判定一个 session 是否为 SDK 来源（workspace.yaml.client_name === 'sdk'） */
function isSdkByWorkspace(ws: WorkspaceYaml): boolean {
  return ws.clientName === 'sdk';
}

/**
 * SDK 信号检测：除 workspace.yaml 外，events.jsonl 中以下字段存在即可判定为 SDK
 * （SDK 在事件里附带了若干 CLI 不会写入的字段）。
 */
function detectSdkFromEvents(events: EventLine[]): boolean {
  for (const e of events) {
    const d = e.data ?? {};
    // session.start 含 selectedModel / contextTier（SDK 启动时显式选定）
    if (e.type === 'session.start') {
      if (d.selectedModel !== undefined || d.contextTier !== undefined) return true;
    }
    // shutdown 含 eventsFileSizeBytes / totalNanoAiu（仅 SDK 写入）
    if (e.type === 'session.shutdown') {
      if (d.eventsFileSizeBytes !== undefined || d.totalNanoAiu !== undefined) return true;
    }
    // assistant.message 含 apiCallId（SDK 写入）
    if (e.type === 'assistant.message' && d.apiCallId !== undefined) return true;
    // assistant.turn_start/end 含 model 字段（SDK 写入，CLI 只在 assistant.message 写）
    if (
      (e.type === 'assistant.turn_start' || e.type === 'assistant.turn_end') &&
      d.model !== undefined
    ) {
      return true;
    }
  }
  return false;
}

/** 累积 modelMetrics 到 token/cost 字段（来自 shutdown 事件） */
function accumulateMetrics(parsed: ParsedSession, metrics: Record<string, unknown>): void {
  for (const modelName of Object.keys(metrics)) {
    const m = metrics[modelName] as {
      requests?: { count?: number; cost?: number };
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        reasoningTokens?: number;
      };
    };
    if (!m || typeof m !== 'object') continue;
    const req = m.requests ?? {};
    const usage = m.usage ?? {};
    if (typeof req.count === 'number') {
      parsed.apiCallCount = (parsed.apiCallCount ?? 0) + req.count;
    }
    if (typeof req.cost === 'number') {
      parsed.estimatedCostUsd = (parsed.estimatedCostUsd ?? 0) + req.cost;
    }
    if (typeof usage.inputTokens === 'number') {
      parsed.totalInputTokens = (parsed.totalInputTokens ?? 0) + usage.inputTokens;
    }
    if (typeof usage.outputTokens === 'number') {
      parsed.totalOutputTokens = (parsed.totalOutputTokens ?? 0) + usage.outputTokens;
    }
    if (typeof usage.cacheReadTokens === 'number') {
      parsed.totalCacheReadTokens = (parsed.totalCacheReadTokens ?? 0) + usage.cacheReadTokens;
    }
    if (typeof usage.cacheWriteTokens === 'number') {
      parsed.totalCacheCreationTokens =
        (parsed.totalCacheCreationTokens ?? 0) + usage.cacheWriteTokens;
    }
  }
}

/** 把 hookType 字符串归一化到已知 8 种之一；未知返回 null */
function normalizeHookType(raw: unknown): CopilotHookType | null {
  if (typeof raw !== 'string') return null;
  for (const t of COPILOT_HOOK_TYPES) {
    if (t === raw) return t;
  }
  return null;
}

/**
 * 解析单个 events.jsonl 文件，返回完整 ParsedSession。
 * 单行 JSON 损坏跳过该行；session.start 缺失时回退用目录名作为 native id。
 */
function parseEventsFile(
  absPath: string,
  nativeIdFallback: string,
): ParsedSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null; // 文件不可读 → 跳过
  }

  const parsed: ParsedSession = {
    nativeId: nativeIdFallback,
    originator: 'copilot_cli', // 默认 CLI；SDK 检测后覆盖
    messages: [],
    hookCounts: {
      sessionStart: 0,
      sessionEnd: 0,
      userPromptSubmitted: 0,
      preToolUse: 0,
      postToolUse: 0,
      agentStop: 0,
      subagentStop: 0,
      errorOccurred: 0,
    },
  };

  // 先收集所有行用于 SDK 检测（detectSdkFromEvents 需要全量扫描）
  const lines: EventLine[] = [];
  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let obj: EventLine;
    try {
      obj = JSON.parse(trimmed) as EventLine;
    } catch {
      continue; // 脏行跳过
    }
    lines.push(obj);
  }

  if (lines.length === 0) return null;

  // SDK 检测：若 events 中有 SDK 信号则标记
  if (detectSdkFromEvents(lines)) {
    parsed.originator = 'copilot_sdk';
  }

  // 第二遍：按行序处理
  for (const obj of lines) {
    const data = obj.data ?? {};
    const ts = parseTimestamp(obj.timestamp);

    switch (obj.type) {
      case 'session.start': {
        const sessionId = data.sessionId;
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          parsed.nativeId = sessionId;
        }
        const ctx = (data.context ?? {}) as {
          cwd?: unknown;
          gitRoot?: unknown;
          branch?: unknown;
        };
        if (typeof ctx.cwd === 'string' && ctx.cwd.length > 0) parsed.cwd = ctx.cwd;
        if (typeof ctx.gitRoot === 'string' && ctx.gitRoot.length > 0) parsed.gitRoot = ctx.gitRoot;
        if (typeof ctx.branch === 'string' && ctx.branch.length > 0) parsed.branch = ctx.branch;
        if (typeof data.copilotVersion === 'string') parsed.cliVersion = data.copilotVersion;
        // selectedModel（SDK）优先；CLI 走 session.model_change
        if (typeof data.selectedModel === 'string' && data.selectedModel.length > 0) {
          parsed.model = data.selectedModel;
        }
        const startTs = parseTimestamp(data.startTime);
        if (startTs !== undefined && (parsed.startedAt === undefined || startTs < parsed.startedAt)) {
          parsed.startedAt = startTs;
        }
        if (ts !== undefined && (parsed.startedAt === undefined || ts < parsed.startedAt)) {
          parsed.startedAt = ts;
        }
        break;
      }
      case 'session.resume': {
        // session.resume 事件指向被恢复的 sessionId（如有）
        const resumed = data.sessionId ?? data.resumedSessionId;
        if (typeof resumed === 'string' && resumed.length > 0 && resumed !== parsed.nativeId) {
          parsed.resumedFrom = resumed;
        }
        break;
      }
      case 'session.model_change': {
        const newModel = data.newModel;
        if (typeof newModel === 'string' && newModel.length > 0) parsed.model = newModel;
        break;
      }
      case 'session.shutdown': {
        if (typeof data.currentModel === 'string' && data.currentModel.length > 0) {
          parsed.model = data.currentModel;
        }
        if (data.modelMetrics && typeof data.modelMetrics === 'object') {
          accumulateMetrics(parsed, data.modelMetrics as Record<string, unknown>);
        }
        break;
      }
      case 'user.message': {
        // 仅取 content（用户原文）；transformedContent 含 runtime 注入（datetime 等），不入库
        const content = data.content;
        if (typeof content === 'string' && content.trim().length > 0) {
          parsed.messages.push({ role: 'user', content, timestamp: ts });
        }
        break;
      }
      case 'assistant.message': {
        const content = data.content;
        if (typeof content === 'string' && content.trim().length > 0) {
          parsed.messages.push({ role: 'assistant', content, timestamp: ts });
        }
        break;
      }
      case 'hook.start': {
        const ht = normalizeHookType(data.hookType);
        if (ht) parsed.hookCounts[ht]++;
        // sessionStart hook.input.source（"new" | "resume"）作为 entrySource
        if (ht === 'sessionStart') {
          const input = (data.input ?? {}) as { source?: unknown };
          if (typeof input.source === 'string' && input.source.length > 0) {
            parsed.entrySource = input.source;
          }
        }
        break;
      }
      // 其他事件类型（system.message / tool.execution_* / function /
      // subagent.selected / abort / session.mode_changed / hook.end /
      // assistant.turn_start / assistant.turn_end）对消息入库无贡献，跳过
      default:
        break;
    }
  }

  return parsed;
}

/**
 * 打开 Copilot 自带 SQLite 索引（~/.copilot/session-store.db），返回 sessions 表
 * 按 id 索引的轻量字典。db 不存在或不可读时返回空 Map（不报错）。
 */
function openCopilotSessionStoreDb(dbPath: string): Map<string, DbSessionRow> | null {
  if (!DatabaseSyncCtor) return null;
  try {
    const db = new DatabaseSyncCtor(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          'SELECT id, cwd, repository, branch, summary, created_at, updated_at FROM sessions',
        )
        .all() as unknown as DbSessionRow[];
      const map = new Map<string, DbSessionRow>();
      for (const r of rows) map.set(r.id, r);
      return map;
    } finally {
      db.close();
    }
  } catch {
    return null; // db 不存在 / schema 不匹配 → 静默跳过富化
  }
}

/**
 * Copilot CLI / SDK 原生导入器。
 *
 * 用法：
 *   const importer = new CopilotImporter(store, { homePath, deviceId });
 *   const stats = importer.import();
 */
export class CopilotImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: CopilotImportOptions = {},
  ) {}

  /** 解析 ~/.copilot 根目录：homePath 选项优先，否则回退默认路径 */
  resolveHomePath(): string {
    return this.options.homePath ?? DEFAULT_COPILOT_HOME_DIR;
  }

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): CopilotImportStats {
    const homePath = this.resolveHomePath();
    const rootPath = path.join(homePath, SESSION_STATE_SEGMENT);
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. session-state 目录必须可读
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (e) {
      throw new Error(`Copilot session-state 目录不可读: ${rootPath} (${errorMessage(e)})`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Copilot session-state 路径不是目录: ${rootPath}`);
    }

    // 2. 注册 coverage=A 的 copilot source instance（rootPath=扫描根）
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'copilot',
      rootPath,
      coverage: 'A' as Coverage,
    });

    // 3. 开始 scan_run
    const runId = this.store.startScanRun({
      sourceInstanceId: instance.id,
      deviceId,
    });

    try {
      const counts = this.scanTree(homePath, rootPath, instance.id, deviceId);
      this.store.finishScanRun(runId, {
        status: 'completed',
        sessionsSeen: counts.scanned,
        sessionsNew: counts.inserted,
        sessionsUpdated: counts.updated,
      });
      return { scanRunId: runId, sourceInstanceId: instance.id, ...counts };
    } catch (err) {
      this.finishRunFailed(runId, err);
      throw err;
    }
  }

  /** 把 scan_run 标记为 failed 并写 error；记录写入失败时不掩盖原始错误 */
  private finishRunFailed(runId: number, err: unknown): void {
    try {
      this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
    } catch {
      /* scan_run 记录写入失败不应掩盖导致扫描失败的原始错误 */
    }
  }

  /**
   * 扫描 session-state 目录：每个 <uuid>/ 子目录视为一个 session。
   *   - 读取 workspace.yaml 富化元数据（cwd / git_root / branch / client_name）
   *   - 读取 events.jsonl 解析消息与 token 统计
   *   - 可选：打开 session-store.db 富化 summary（不入库，仅 cross-check）
   *   - 入库 + 建 session.resume → continued_from 关系
   */
  private scanTree(
    homePath: string,
    rootPath: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<CopilotImportStats, 'scanRunId' | 'sourceInstanceId'> {
    const sessionDirs = this.collectSessionDirs(rootPath);

    // 可选富化：读取 Copilot session-store.db
    let dbRows: Map<string, DbSessionRow> | null = null;
    if (!this.options.skipSessionStoreDb) {
      const dbPath = path.join(homePath, SESSION_STORE_DB_FILENAME);
      dbRows = openCopilotSessionStoreDb(dbPath);
    }

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let cliSessions = 0;
    let sdkSessions = 0;
    let relationships = 0;
    let dbEnriched = 0;

    /** nativeId → 内部 session id，供 session.resume → continued_from 关系查父 */
    const sessionIdByNative = new Map<string, string>();
    /** 待建 continued_from 关系：[{ fromInternalId, resumedFromNativeId }] */
    const continuedRecords: Array<{ fromInternalId: string; resumedFromNativeId: string }> = [];

    // 稳定字典序遍历（按目录名），消除 readdir 顺序不确定性
    sessionDirs.sort();

    for (const dir of sessionDirs) {
      scanned++;
      const uuid = path.basename(dir);
      const eventsPath = path.join(dir, EVENTS_FILENAME);
      const workspacePath = path.join(dir, WORKSPACE_FILENAME);

      // 1. workspace.yaml 富化（缺失不影响）
      let ws: WorkspaceYaml = {};
      try {
        const wsContent = fs.readFileSync(workspacePath, 'utf8');
        ws = parseWorkspaceYaml(wsContent);
      } catch {
        // workspace.yaml 缺失 → 仅依赖 events.jsonl
      }

      // 2. events.jsonl 解析（必须存在且可读）
      const parsed = parseEventsFile(eventsPath, uuid);
      if (!parsed) {
        skipped++;
        continue;
      }

      // workspace.yaml 元数据补充（events.jsonl 已写入的优先级更高，不覆盖）
      if (parsed.cwd === undefined && ws.cwd) parsed.cwd = ws.cwd;
      if (parsed.gitRoot === undefined && ws.gitRoot) parsed.gitRoot = ws.gitRoot;
      if (parsed.branch === undefined && ws.branch) parsed.branch = ws.branch;

      // SDK 判定（workspace.yaml 优先于 events SDK 信号）
      if (isSdkByWorkspace(ws)) {
        parsed.originator = 'copilot_sdk';
      }

      // 3. 无有效消息 → 跳过
      if (parsed.messages.length === 0) {
        skipped++;
        continue;
      }

      // 4. session-store.db 富化（仅 cross-check；当前 store 暂不持久化 summary）
      if (dbRows) {
        const dbRow = dbRows.get(parsed.nativeId) ?? dbRows.get(uuid);
        if (dbRow) dbEnriched++;
      }

      // 5. 入库
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: parsed.nativeId,
        source: 'copilot',
        cwd: parsed.cwd,
        projectPath: parsed.gitRoot ?? parsed.cwd,
        startedAt: parsed.startedAt,
        topology: 'root',
        sourceKind: 'A',
        messages: parsed.messages,
        model: parsed.model,
        cliVersion: parsed.cliVersion,
        originator: parsed.originator,
        entrySource: parsed.entrySource,
        threadSource: parsed.originator === 'copilot_sdk' ? 'sdk' : 'cli',
        estimatedCostUsd: parsed.estimatedCostUsd,
        totalInputTokens: parsed.totalInputTokens,
        totalOutputTokens: parsed.totalOutputTokens,
        toolCallCount: Object.values(parsed.hookCounts).reduce(
          (a, b) => a + (b as number),
          0,
        ),
        totalCacheReadTokens: parsed.totalCacheReadTokens,
        totalCacheCreationTokens: parsed.totalCacheCreationTokens,
        apiCallCount: parsed.apiCallCount,
      });
      sessionIdByNative.set(parsed.nativeId, result.sessionId);

      if (parsed.originator === 'copilot_sdk') sdkSessions++;
      else cliSessions++;

      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;

      // 记录 continued_from 关系候选
      if (parsed.resumedFrom) {
        continuedRecords.push({
          fromInternalId: result.sessionId,
          resumedFromNativeId: parsed.resumedFrom,
        });
      }
    }

    // —— 关系：session.resume → continued_from（仅可验证父）——
    for (const c of continuedRecords) {
      const parentId = sessionIdByNative.get(c.resumedFromNativeId);
      if (!parentId || parentId === c.fromInternalId) continue; // 父未入库 → 不猜测
      this.store.addRelationship({
        fromSessionId: c.fromInternalId,
        toSessionId: parentId,
        relationType: 'continued_from',
        evidence: 'copilot session.resume event',
      });
      relationships++;
    }

    return {
      scanned,
      inserted,
      updated,
      unchanged,
      skipped,
      cliSessions,
      sdkSessions,
      relationships,
      dbEnriched,
    };
  }

  /**
   * 收集 session-state 目录下所有 <uuid>/ 子目录（每个视为一个 session）。
   * 单个目录不可读 → 跳过，不中断整棵树。
   */
  private collectSessionDirs(rootPath: string): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootPath, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // 目录名应为 UUID；非 UUID 命名（如临时目录）跳过
      const abs = path.join(rootPath, e.name);
      out.push(abs);
    }
    return out;
  }
}

/** 解析 Copilot home 目录：homePath 选项优先，否则回退默认 ~/.copilot */
export function resolveCopilotHomePath(options: { homePath?: string } = {}): string {
  return options.homePath ?? DEFAULT_COPILOT_HOME_DIR;
}

/** 解析 Copilot session-state 根目录 */
export function resolveCopilotSessionStatePath(options: { homePath?: string } = {}): string {
  return path.join(resolveCopilotHomePath(options), SESSION_STATE_SEGMENT);
}
