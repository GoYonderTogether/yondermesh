/**
 * Hermes 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 ~/.hermes/state.db（Hermes 的 SQLite session store），解析 session 元数据、
 * user/assistant 可显示消息与 parent_session_id 谱系关系并入库。
 *
 * 真实结构（本机 ~/.hermes 实测，2026-07）：
 *   - DB 路径：~/.hermes/state.db（profile-aware，默认主 profile）
 *   - sessions 表：id (TEXT PK)、source (cli/feishu/acp/subagent)、model、cwd、
 *       parent_session_id (树结构)、started_at (REAL epoch 秒)、ended_at、
 *       message_count、tool_call_count、input/output/cache tokens、estimated_cost_usd、
 *       api_call_count、title、archived
 *   - messages 表：session_id (FK)、role (user/assistant/tool/session_meta)、content、
 *       tool_call_id、tool_calls、tool_name、timestamp (REAL epoch 秒)、active (0/1)、
 *       compacted (0/1)
 *   - JSONL 文件 ~/.hermes/sessions/*.jsonl：每行 {role, content, timestamp}，
 *       是部分 session 的 transcript 导出（state.db 是权威源，JSONL 作为补充）
 *
 * 核心约束（与 claude/codex/cass 一致）：
 *   - 只读：以 readOnly 模式打开 state.db，绝不写入 Hermes 私有 DB。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = sessions.id（如 20260515_170149_08eb5d）
 *   - 拓扑（§4）：parent_session_id IS NOT NULL 或 source='subagent' → topology=subagent
 *   - 关系（§3.4）：subagent 的 parent_session_id 指向同次扫描已入库 session 时写 spawned_by
 *   - 消息：只取 user/assistant 的可显示文本；tool/session_meta/空内容排除
 *   - 幂等：依赖 SessionStore 的 content_hash 判定
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  Coverage,
  MessageRole,
  SessionMessageInput,
  SessionTopology,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

// node:sqlite 实验性内置，vitest/vite 静态解析会误判为裸包；
// 用 createRequire 运行时加载，绕过 vite 预优化（同 store / cass 的做法）。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** 默认 Hermes home 目录 */
const DEFAULT_HERMES_HOME = path.join(os.homedir(), '.hermes');

/** state.db 文件名（相对 Hermes home） */
const STATE_DB_FILENAME = 'state.db';

/** JSONL session 导出目录名 */
const SESSIONS_DIRNAME = 'sessions';

/** 导入器选项 */
export interface HermesImportOptions {
  /** 直接指定 Hermes home 目录，默认 ~/.hermes */
  hermesHome?: string;
  /** 直接指定 state.db 路径，优先级高于 hermesHome */
  dbPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface HermesImportStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** hermes source instance id */
  sourceInstanceId: string;
  /** 扫描到的 session 总数（state.db 中的非 archived session） */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 session 数（无有效消息） */
  skipped: number;
  /** 入库的 subagent session 数 */
  subagents: number;
  /** 有 parent 但父未入库、未写 spawned_by 的 subagent 数 */
  unlinkedSubagents: number;
  /** 写入的 spawned_by 关系数 */
  relationships: number;
}

/** state.db sessions 行（松散） */
interface HermesSessionRow {
  id: string;
  source: string | null;
  model: string | null;
  cwd: string | null;
  parent_session_id: string | null;
  started_at: number;
  ended_at: number | null;
  message_count: number;
  tool_call_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  estimated_cost_usd: number | null;
  api_call_count: number | null;
  title: string | null;
  archived: number;
}

/** state.db messages 行（松散） */
interface HermesMessageRow {
  role: string;
  content: string | null;
  timestamp: number;
  active: number;
}

/** 解析 Hermes home 目录：hermesHome 选项 > 默认 ~/.hermes */
export function resolveHermesHome(options: { hermesHome?: string } = {}): string {
  return options.hermesHome ?? DEFAULT_HERMES_HOME;
}

/** 解析 state.db 路径：dbPath 选项 > hermesHome/state.db */
export function resolveHermesDbPath(options: { dbPath?: string; hermesHome?: string } = {}): string {
  if (options.dbPath) return options.dbPath;
  return path.join(resolveHermesHome(options), STATE_DB_FILENAME);
}

/** 解析 JSONL sessions 目录路径 */
export function resolveHermesSessionsDir(options: { hermesHome?: string } = {}): string {
  return path.join(resolveHermesHome(options), SESSIONS_DIRNAME);
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Hermes 原生导入器。
 *
 * 用法：
 *   const importer = new HermesImporter(store, { deviceId });
 *   const stats = importer.import();
 */
export class HermesImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: HermesImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): HermesImportStats {
    const dbPath = resolveHermesDbPath(this.options);
    const hermesHome = resolveHermesHome(this.options);
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. state.db 必须可读
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Hermes state.db 不存在: ${dbPath}`);
    }
    const stat = fs.statSync(dbPath);
    if (!stat.isFile()) {
      throw new Error(`Hermes state.db 路径不是文件: ${dbPath}`);
    }

    // 2. 注册 coverage=A 的 hermes source instance（rootPath=Hermes home）
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'hermes',
      rootPath: hermesHome,
      coverage: 'A' as Coverage,
    });

    // 3. 开始 scan_run
    const runId = this.store.startScanRun({
      sourceInstanceId: instance.id,
      deviceId,
    });

    try {
      const counts = this.scanDb(dbPath, instance.id, deviceId);
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

  /** 把 scan_run 标记为 failed 并写 error */
  private finishRunFailed(runId: number, err: unknown): void {
    try {
      this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
    } catch {
      /* scan_run 记录写入失败不应掩盖导致扫描失败的原始错误 */
    }
  }

  /**
   * 扫描 state.db（两遍）：
   *   第一遍——读取所有非 archived session，逐条入库（流式读取消息，单 session 内存可控）
   *   第二遍——建 subagent→parent 的 spawned_by 关系
   */
  private scanDb(
    dbPath: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<HermesImportStats, 'scanRunId' | 'sourceInstanceId'> {
    // 以 readOnly 打开 Hermes DB，绝不写入
    const hermesDb = new DatabaseSync(dbPath, { readOnly: true });

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

    try {
      // —— 第一遍：逐 session 读取并入库 ——
      // 排除 archived=1 的 session；按 started_at 升序（父先入库）
      const sessionStmt = hermesDb.prepare(
        `SELECT id, source, model, cwd, parent_session_id, started_at, ended_at,
                message_count, tool_call_count, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, estimated_cost_usd,
                api_call_count, title, archived
         FROM sessions
         WHERE archived = 0
         ORDER BY started_at ASC`,
      );

      const messageStmt = hermesDb.prepare(
        `SELECT role, content, timestamp, active
         FROM messages
         WHERE session_id = ?
         ORDER BY timestamp ASC, id ASC`,
      );

      for (const rowRaw of sessionStmt.all()) {
        const row = rowRaw as unknown as HermesSessionRow;
        scanned++;

        // 读取该 session 的消息（流式：单 session 消息读完即释放）
        const messages = this.extractMessages(messageStmt.all(row.id) as unknown as HermesMessageRow[]);
        if (messages.length === 0) {
          skipped++; // 无有效消息 → 跳过
          continue;
        }

        const topology: SessionTopology = this.resolveTopology(row);
        const startedAtMs = Math.round(row.started_at * 1000);

        const result = this.store.ingestSession({
          deviceId,
          sourceInstanceId,
          nativeSessionId: row.id,
          source: 'hermes',
          cwd: row.cwd ?? undefined,
          projectPath: row.cwd ?? undefined,
          startedAt: startedAtMs,
          topology,
          sourceKind: 'A',
          messages,
          model: row.model ?? undefined,
          estimatedCostUsd: row.estimated_cost_usd ?? undefined,
          totalInputTokens: row.input_tokens ?? undefined,
          totalOutputTokens: row.output_tokens ?? undefined,
          totalCacheReadTokens: row.cache_read_tokens ?? undefined,
          totalCacheCreationTokens: row.cache_write_tokens ?? undefined,
          toolCallCount: row.tool_call_count ?? undefined,
          apiCallCount: row.api_call_count ?? undefined,
          entrySource: row.source ?? undefined,
          originator: row.source === 'feishu' ? 'feishu' : undefined,
        });

        sessionIdByNative.set(row.id, result.sessionId);

        if (topology === 'subagent') {
          subagents++;
          subRecords.push({
            internalId: result.sessionId,
            parentNativeId: row.parent_session_id ?? undefined,
          });
        }

        if (result.created) inserted++;
        else if (result.newRevision) updated++;
        else unchanged++;
      }
    } finally {
      hermesDb.close();
    }

    // —— 第二遍：subagent → parent spawned_by（仅可验证父）——
    for (const sub of subRecords) {
      if (!sub.parentNativeId) continue;
      const parentId = sessionIdByNative.get(sub.parentNativeId);
      if (!parentId || parentId === sub.internalId) {
        unlinkedSubagents++;
        continue;
      }
      this.store.addRelationship({
        fromSessionId: sub.internalId,
        toSessionId: parentId,
        relationType: 'spawned_by',
        evidence: 'hermes sessions.parent_session_id',
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

  /**
   * 解析拓扑：parent_session_id IS NOT NULL 或 source='subagent' → subagent；否则 root。
   */
  private resolveTopology(row: HermesSessionRow): SessionTopology {
    if (row.parent_session_id !== null && row.parent_session_id.length > 0) {
      return 'subagent';
    }
    if (row.source === 'subagent') {
      return 'subagent';
    }
    return 'root';
  }

  /**
   * 从 state.db messages 行提取可显示消息：
   *   - 只取 role=user/assistant 的非空 content
   *   - role=tool（工具结果）/session_meta（元数据）排除
   *   - active=0（已删除）排除
   *   - content 为 NULL 或空白排除
   *   - timestamp 从 epoch 秒转 epoch 毫秒
   */
  private extractMessages(rows: HermesMessageRow[]): SessionMessageInput[] {
    const messages: SessionMessageInput[] = [];
    for (const row of rows) {
      if (row.active === 0) continue; // 已删除消息跳过
      if (row.role !== 'user' && row.role !== 'assistant') continue; // 仅 user/assistant
      if (typeof row.content !== 'string' || row.content.trim().length === 0) continue;

      const role = (row.role === 'assistant' ? 'assistant' : 'user') as MessageRole;
      const timestampMs = Math.round(row.timestamp * 1000);
      messages.push({ role, content: row.content, timestamp: timestampMs });
    }
    return messages;
  }
}
