/**
 * OpenCode 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 OpenCode 原生 SQLite 数据库，解析 session / message / part 并入库
 * （architecture.md §2.2 / §3.4）。
 *
 * 真实结构（本机 OpenCode v1.17.16 实测，2026-07）：
 *   - 数据库：~/.local/share/opencode/opencode.db（SQLite，可经 `opencode db path` 解析）
 *     （早期版本曾用 ~/.opencode/sessions/*.jsonl；v1.17+ 统一迁入 SQLite）
 *   - session 表：id(ses_xxx) / parent_id(子 agent) / directory(cwd) / title / version /
 *       model(JSON {id,providerID,variant}) / cost / tokens_input / tokens_output /
 *       tokens_reasoning / tokens_cache_read / tokens_cache_write / time_created /
 *       time_updated / time_archived / project_id / agent
 *   - message 表：id(msg_xxx) / session_id / time_created / data(JSON {role,time,agent,model})
 *       · data.role = user | assistant
 *   - part 表：id(prt_xxx) / message_id / session_id / time_created /
 *       data(JSON {type, text, ...})
 *       · type 分布：text(可显示) / tool(工具调用) / reasoning(思维链) /
 *         step-start / step-finish / patch / compaction / file / subtask
 *       · 仅 type=text 的 part.text 为可显示文本
 *   - project 表：id(hash) / worktree(项目根路径) / name
 *   - session.parent_id 非空 → subagent（spawned_by 关系指向父 session.id）
 *
 * 核心约束：
 *   - 只读：以 readOnly 打开 opencode.db，绝不写入 OpenCode 私有库（架构 §2 关键取舍）。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = session.id（ses_xxx，全局唯一稳定）
 *   - 拓扑（§4）：parent_id 非空 → topology=subagent；否则 root。
 *   - 关系（§3.4）：subagent 的 parent_id 指向同次扫描已入库 session 时写 spawned_by；
 *     否则不猜测，保持独立 session。关系在所有 session 入库后再建（两遍处理）。
 *   - 消息：只取 message 中 user/assistant 的 type=text part 拼接为可显示文本；
 *     排除 reasoning(思维链) / tool / step-* / patch / compaction / file / subtask。
 *     一个 message 的多个 text part 按 part 序拼接（同 claude 多 text 块处理）。
 *   - 幂等：依赖 SessionStore 的 content_hash 判定（消息内容+顺序）；脏数据跳过，
 *     无有效消息的 session 跳过。
 *   - 流式：按 session 逐条读取消息，单次只持有一个 session 的消息，内存不随总量线性增长。
 */

import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  Coverage,
  MessageRole,
  SessionMessageInput,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

// node:sqlite 实验性内置，vitest/vite 静态解析会误判为裸包；
// 用 createRequire 运行时加载，绕过 vite 预优化（同 store / cass 的做法）。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** macOS / Linux 默认 OpenCode 数据目录（XDG） */
const DEFAULT_OPENCODE_DATA_DIR = path.join(
  os.homedir(),
  '.local',
  'share',
  'opencode',
);
/** 默认 DB 文件名 */
const OPENCODE_DB_FILENAME = 'opencode.db';

/** 导入器选项 */
export interface OpenCodeImportOptions {
  /** 直接指定 opencode.db 路径，优先级最高 */
  dbPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface OpenCodeImportStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** opencode source instance id */
  sourceInstanceId: string;
  /** 扫描到的 session 总数 */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 session 数（无有效消息 / 脏数据） */
  skipped: number;
  /** 入库的 subagent 数 */
  subagents: number;
  /** 有 parent_id 但父未入库、未写 spawned_by 的 subagent 数 */
  unlinkedSubagents: number;
  /** 写入的 spawned_by 关系数 */
  relationships: number;
}

/** session 行的松散结构 */
interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string | null;
  title: string | null;
  version: string | null;
  model: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  time_created: number | null;
  time_archived: number | null;
  project_id: string | null;
  agent: string | null;
}

/** project 行 */
interface ProjectRow {
  id: string;
  worktree: string | null;
}

/** message 行（带 part 文本聚合结果） */
interface MessageAgg {
  /** message.data.role */
  role: string;
  /** message.time_created */
  timeCreated: number | null;
  /** 该 message 的所有 text part 拼接（按 part 顺序） */
  text: string;
  /** 该 message 的 tool part 数（用于统计 toolCallCount） */
  toolCount: number;
}

/** 一个 session 的解析结果 */
interface ParsedSession {
  nativeId: string;
  parentNativeId?: string;
  cwd?: string;
  projectPath?: string;
  startedAt?: number;
  topology: 'root' | 'subagent';
  messages: SessionMessageInput[];
  model?: string;
  cliVersion?: string;
  agent?: string;
  estimatedCostUsd?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  toolCallCount?: number;
}

/** 解析 model JSON 字段为可读字符串 */
function parseModelField(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as { id?: string; providerID?: string; modelID?: string };
    // session.model 用 {id, providerID, variant}；message.data.model 用 {providerID, modelID}
    const id = obj.id ?? obj.modelID;
    if (typeof id === 'string' && id.length > 0) return id;
    return undefined;
  } catch {
    // 非 JSON（极少数脏数据），按原样保留
    return raw.length > 0 ? raw : undefined;
  }
}

/**
 * 解析 OpenCode 数据库路径。
 * 优先级：options.dbPath > `opencode db path` 命令输出 > 默认 XDG 路径。
 * `opencode db path` 失败（CLI 不可用 / 超时）时回退默认路径。
 */
export function resolveOpenCodeDbPath(options: { dbPath?: string } = {}): string {
  if (options.dbPath) return options.dbPath;
  // 尝试通过 CLI 解析（权威路径，跟随版本/平台差异）
  try {
    const out = execSync('opencode db path', {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out.length > 0) return out;
  } catch {
    // CLI 不可用 → 回退默认
  }
  return path.join(DEFAULT_OPENCODE_DATA_DIR, OPENCODE_DB_FILENAME);
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * OpenCode 原生导入器。
 *
 * 用法：
 *   const importer = new OpenCodeImporter(store, { dbPath, deviceId });
 *   const stats = importer.import();
 */
export class OpenCodeImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: OpenCodeImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): OpenCodeImportStats {
    const dbPath = resolveOpenCodeDbPath(this.options);
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. 以 readOnly 打开 OpenCode DB（绝不写入）
    let ocdb: DatabaseSyncType;
    try {
      ocdb = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
      throw new Error(
        `OpenCode 数据库不可读（readOnly）: ${dbPath} (${errorMessage(e)})`,
      );
    }

    try {
      // 2. 注册 coverage=A 的 opencode source instance（rootPath=扫描根）
      const instance = this.store.registerSourceInstance({
        deviceId,
        source: 'opencode',
        rootPath: dbPath,
        coverage: 'A' as Coverage,
      });

      // 3. 开始 scan_run
      const runId = this.store.startScanRun({
        sourceInstanceId: instance.id,
        deviceId,
      });

      try {
        const counts = this.scanAll(ocdb, instance.id, deviceId);
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
    } finally {
      ocdb.close();
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
   * 扫描全部 session（两遍）：
   *   第一遍——逐 session 读取消息并入库，收集 nativeId→internalId 映射。
   *   第二遍——建 subagent→parent 的 spawned_by 关系（仅可验证父）。
   */
  private scanAll(
    ocdb: DatabaseSyncType,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<OpenCodeImportStats, 'scanRunId' | 'sourceInstanceId'> {
    // 预读 project 表（id → worktree），用于 session.project_path 映射
    const projectWorktree = this.loadProjects(ocdb);

    const sessions = this.loadSessions(ocdb);

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let subagents = 0;
    let unlinkedSubagents = 0;
    let relationships = 0;

    /** nativeId → 内部 session id，供 subagent 查父 */
    const sessionIdByNative = new Map<string, string>();
    /** 已入库的 subagent：{internalId, parentNativeId} */
    const subRecords: Array<{ internalId: string; parentNativeId?: string }> = [];

    const msgStmt = ocdb.prepare(
      `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id`,
    );
    const partStmt = ocdb.prepare(
      `SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id`,
    );

    // —— 第一遍：逐 session 入库 ——
    for (const s of sessions) {
      scanned++;
      const parsed = this.parseSession(s, projectWorktree, msgStmt, partStmt);
      if (!parsed) {
        skipped++; // 无有效消息 → 跳过
        continue;
      }
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: parsed.nativeId,
        source: 'opencode',
        cwd: parsed.cwd,
        projectPath: parsed.projectPath,
        startedAt: parsed.startedAt,
        topology: parsed.topology,
        sourceKind: 'A',
        messages: parsed.messages,
        model: parsed.model,
        cliVersion: parsed.cliVersion,
        originator: parsed.agent,
        estimatedCostUsd: parsed.estimatedCostUsd,
        totalInputTokens: parsed.totalInputTokens,
        totalOutputTokens: parsed.totalOutputTokens,
        totalCacheReadTokens: parsed.totalCacheReadTokens,
        totalCacheCreationTokens: parsed.totalCacheCreationTokens,
        toolCallCount: parsed.toolCallCount,
      });
      sessionIdByNative.set(parsed.nativeId, result.sessionId);
      if (parsed.topology === 'subagent') {
        subagents++;
        subRecords.push({
          internalId: result.sessionId,
          parentNativeId: parsed.parentNativeId,
        });
      }
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    // —— 第二遍：subagent → parent spawned_by（仅可验证父）——
    for (const sub of subRecords) {
      if (!sub.parentNativeId) continue; // 无 parent_id → 无法建关系
      const parentId = sessionIdByNative.get(sub.parentNativeId);
      if (!parentId || parentId === sub.internalId) {
        // 父未在本扫描入库 → 保持独立，不捏造关系
        unlinkedSubagents++;
        continue;
      }
      this.store.addRelationship({
        fromSessionId: sub.internalId,
        toSessionId: parentId,
        relationType: 'spawned_by',
        evidence: 'opencode session.parent_id',
      });
      relationships++;
    }

    return {
      scanned,
      inserted,
      updated,
      unchanged,
      skipped,
      subagents,
      unlinkedSubagents,
      relationships,
    };
  }

  /** 一次性加载 project 表为内存映射（id → worktree） */
  private loadProjects(ocdb: DatabaseSyncType): Map<string, string> {
    const map = new Map<string, string>();
    const rows = ocdb.prepare('SELECT id, worktree FROM project').all() as unknown as ProjectRow[];
    for (const r of rows) {
      if (r.worktree) map.set(r.id, r.worktree);
    }
    return map;
  }

  /** 加载全部 session 行（按 time_created 升序，保证 root 通常先于 subagent 入库） */
  private loadSessions(ocdb: DatabaseSyncType): SessionRow[] {
    return ocdb
      .prepare(
        `SELECT id, parent_id, directory, title, version, model, cost,
                tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write,
                time_created, time_archived, project_id, agent
         FROM session
         ORDER BY time_created ASC, id ASC`,
      )
      .all() as unknown as SessionRow[];
  }

  /**
   * 解析单个 session：读取其 message + part，提取可显示文本。
   * 单 session 解析失败或无有效消息返回 null（跳过）。
   * 流式：逐 message 读取并立即消费，单次只持有一个 session 的消息。
   */
  private parseSession(
    s: SessionRow,
    projectWorktree: Map<string, string>,
    msgStmt: ReturnType<DatabaseSyncType['prepare']>,
    partStmt: ReturnType<DatabaseSyncType['prepare']>,
  ): ParsedSession | null {
    const nativeId = s.id;
    const parentNativeId =
      s.parent_id && s.parent_id.length > 0 ? s.parent_id : undefined;
    const topology: 'root' | 'subagent' = parentNativeId ? 'subagent' : 'root';

    const cwd = s.directory ?? undefined;
    const projectPath = s.project_id
      ? (projectWorktree.get(s.project_id) ?? undefined)
      : undefined;

    const messages: SessionMessageInput[] = [];
    let toolCallCount = 0;

    // 逐 message 读取（流式：每条消息读毕即消费）
    const msgRows = msgStmt.all(nativeId) as unknown as Array<{
      id: string;
      time_created: number | null;
      data: string;
    }>;
    for (const m of msgRows) {
      const agg = this.aggregateMessage(m.id, m.time_created, m.data, partStmt);
      if (!agg) continue; // 非 user/assistant 或无文本 → 跳过
      toolCallCount += agg.toolCount;
      const role = (agg.role === 'assistant' ? 'assistant' : 'user') as MessageRole;
      messages.push({
        role,
        content: agg.text,
        timestamp: agg.timeCreated ?? undefined,
      });
    }

    if (messages.length === 0) return null; // 无有效消息 → 跳过

    return {
      nativeId,
      parentNativeId,
      cwd,
      projectPath,
      startedAt: s.time_created ?? undefined,
      topology,
      messages,
      model: parseModelField(s.model),
      cliVersion: s.version ?? undefined,
      agent: s.agent ?? undefined,
      estimatedCostUsd: s.cost ?? undefined,
      totalInputTokens: s.tokens_input ?? undefined,
      totalOutputTokens: s.tokens_output ?? undefined,
      totalCacheReadTokens: s.tokens_cache_read ?? undefined,
      totalCacheCreationTokens: s.tokens_cache_write ?? undefined,
      toolCallCount: toolCallCount > 0 ? toolCallCount : undefined,
    };
  }

  /**
   * 聚合一个 message 的所有 part：
   *   - role 取 message.data.role（仅 user/assistant 才返回，其他返回 null）
   *   - text 取所有 type=text 的 part.text 拼接（按 part 顺序，\n 连接）
   *   - toolCount 统计 type=tool 的 part 数（用于 toolCallCount 元数据）
   *   - reasoning / step-* / patch / compaction / file / subtask 一律排除
   *   - 脏 part JSON 跳过
   *   - 无 text part 的 user/assistant message 返回 null（不产出空消息）
   */
  private aggregateMessage(
    messageId: string,
    timeCreated: number | null,
    dataJson: string,
    partStmt: ReturnType<DatabaseSyncType['prepare']>,
  ): MessageAgg | null {
    // 解析 message.data 拿 role
    let role = '';
    try {
      const data = JSON.parse(dataJson) as { role?: unknown };
      role = typeof data.role === 'string' ? data.role : '';
    } catch {
      return null; // 脏 message → 跳过
    }
    if (role !== 'user' && role !== 'assistant') return null;

    // 读 part
    const partRows = partStmt.all(messageId) as unknown as Array<{ data: string }>;
    const textParts: string[] = [];
    let toolCount = 0;
    for (const p of partRows) {
      try {
        const pdata = JSON.parse(p.data) as { type?: unknown; text?: unknown };
        if (pdata.type === 'text' && typeof pdata.text === 'string') {
          if (pdata.text.length > 0) textParts.push(pdata.text);
        } else if (pdata.type === 'tool') {
          toolCount++;
        }
      } catch {
        // 脏 part → 跳过
      }
    }
    if (textParts.length === 0) return null; // 无可显示文本 → 不产出
    return {
      role,
      timeCreated,
      text: textParts.join('\n'),
      toolCount,
    };
  }
}
