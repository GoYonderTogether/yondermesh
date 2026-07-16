/**
 * Goose 原生 adapter（覆盖等级 A）
 *
 * 只读导入本机 Goose（Block）的 session 存储到 Session Vault。
 *
 * 真实结构（任务规格 + Goose v1.43.0）：
 *   - 配置目录：~/.config/goose/（XDG，非 ~/.goose/）
 *   - 数据目录：~/.local/share/goose/
 *   - SQLite sessions.db，含 parent_session_id（拓扑）、archived_at（归档）
 *
 * 核心约束：
 *   - 只读：以 readOnly 打开 sessions.db，绝不写入 Goose DB（架构 §2 关键取舍）。
 *   - 流式：按 session 逐条读取消息，单次只持有一个 session 的消息（LOOP-002 验收门）。
 *   - provenance：source='goose'，coverage=A；nativeSessionId 取 session_id。
 *   - 拓扑：parent_session_id 非空 → topology=subagent，并建 spawned_by 关系
 *     （父在同次扫描入库时）；否则 topology=root。
 *   - 归档：archived_at 非空 → retention 标记为 archived（不参与默认查询）。
 *     注：SessionStore.ingestSession 默认 retention=live；归档由后续
 *     deduplicateCrossSource 或显式 update 处理。此处通过跳过 archived 会话
 *     的消息归档避免重复，但仍记录其身份与关系。
 *   - 幂等：依赖 SessionStore 的 content_hash 判定，重复导入不新增 revision。
 *
 * GLM-5.2 ✅：Goose 内置 zhipu provider，可通过 ZHIPU_BASE_URL 自定义端点接入。
 */

import { createRequire } from 'node:module';
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

// node:sqlite 实验性内置，用 createRequire 运行时加载（同 store/cass 做法）
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** macOS / XDG 默认 Goose 数据目录 */
const DEFAULT_GOOSE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'goose');

/** sessions.db 文件名 */
const GOOSE_DB_FILENAME = 'sessions.db';

/** 导入器选项 */
export interface GooseImportOptions {
  /** 直接指定 sessions.db 路径，优先级最高 */
  dbPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface GooseImportStats {
  /** 本次 scan_run id */
  scanRunId: number;
  /** goose source instance id */
  sourceInstanceId: string;
  /** 扫描到的 session 总数 */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 session 数（无消息 / 脏数据） */
  skipped: number;
  /** 入库的 subagent session 数 */
  subagents: number;
  /** 有 parent_session_id 但父未入库、未写 spawned_by 的 subagent 数 */
  unlinkedSubagents: number;
  /** 写入的 spawned_by 关系数 */
  relationships: number;
  /** 被归档（archived_at 非空）的 session 数 */
  archived: number;
}

/** sessions 行 */
interface GooseSessionRow {
  session_id: string;
  parent_session_id: string | null;
  archived_at: number | null;
  working_dir: string | null;
  started_at: number | null;
  model: string | null;
  description: string | null;
}

/** messages 行 */
interface GooseMessageRow {
  idx: number;
  role: string;
  content: string;
  created_at: number | null;
}

/** 解析 sessions.db 路径：dbPath 选项 > GOOSE_DATA_DIR > 默认 XDG 路径 */
export function resolveGooseDbPath(options: { dbPath?: string } = {}): string {
  if (options.dbPath) return options.dbPath;
  const dataDir = process.env.GOOSE_DATA_DIR ?? DEFAULT_GOOSE_DATA_DIR;
  return path.join(dataDir, GOOSE_DB_FILENAME);
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Goose 原生导入器。
 *
 * 用法：
 *   const importer = new GooseImporter(store, { deviceId });
 *   const stats = importer.import();
 */
export class GooseImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: GooseImportOptions = {},
  ) {}

  /** 执行一次完整导入，返回统计并写 scan_runs */
  import(): GooseImportStats {
    const dbPath = resolveGooseDbPath(this.options);

    let goose: DatabaseSyncType;
    try {
      goose = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
      throw new Error(`Goose sessions.db 不可读: ${dbPath} (${errorMessage(e)})`);
    }

    try {
      this.assertGooseSchema(goose, dbPath);

      const deviceId = this.options.deviceId ?? os.hostname();
      const rootPath = path.dirname(dbPath);
      const instance = this.store.registerSourceInstance({
        deviceId,
        source: 'goose',
        rootPath,
        coverage: 'A' as Coverage,
      });

      const runId = this.store.startScanRun({
        sourceInstanceId: instance.id,
        deviceId,
      });

      try {
        const counts = this.streamImport(goose, instance.id, deviceId);
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
      goose.close();
    }
  }

  private finishRunFailed(runId: number, err: unknown): void {
    try {
      this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
    } catch {
      /* 不掩盖原始错误 */
    }
  }

  /**
   * 校验 Goose schema：sessions 表必需列 + messages 表必需列。
   * 列名变更即在此捕获，给清晰错误。
   */
  private assertGooseSchema(goose: DatabaseSyncType, dbPath: string): void {
    const required: Record<string, string[]> = {
      sessions: ['session_id', 'parent_session_id', 'archived_at'],
      messages: ['session_id', 'role', 'content'],
    };
    const tableInfo = goose.prepare('SELECT name FROM pragma_table_info(?)');
    const missingTables: string[] = [];
    const missingCols: string[] = [];
    for (const [table, cols] of Object.entries(required)) {
      const rows = tableInfo.all(table) as { name: string }[];
      if (rows.length === 0) {
        missingTables.push(table);
        continue;
      }
      const present = new Set(rows.map((r) => r.name));
      for (const c of cols) {
        if (!present.has(c)) missingCols.push(`${table}.${c}`);
      }
    }
    if (missingTables.length > 0 || missingCols.length > 0) {
      const parts: string[] = [];
      if (missingTables.length > 0) parts.push(`缺少表 ${missingTables.join(', ')}`);
      if (missingCols.length > 0) parts.push(`缺少列 ${missingCols.join(', ')}`);
      throw new Error(`Goose schema 不匹配: ${dbPath} — ${parts.join('；')}`);
    }
  }

  /**
   * 流式导入：遍历 sessions，逐条查询其消息并 upsert。
   * 两遍处理：先入库所有 session，再建 subagent→parent spawned_by 关系。
   * archived_at 非空的 session 仍入库（保留拓扑与关系），但计数 archived。
   */
  private streamImport(
    goose: DatabaseSyncType,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<GooseImportStats, 'scanRunId' | 'sourceInstanceId'> {
    const sessStmt = goose.prepare(
      `SELECT session_id, parent_session_id, archived_at, working_dir, started_at, model, description
       FROM sessions
       ORDER BY session_id`,
    );
    const msgStmt = goose.prepare(
      'SELECT idx, role, content, created_at FROM messages WHERE session_id = ? ORDER BY idx',
    );

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let subagents = 0;
    let unlinkedSubagents = 0;
    let relationships = 0;
    let archived = 0;

    /** session_id → 内部 session id，供 subagent 查父 */
    const internalIdByNative = new Map<string, string>();
    /** 已入库的 subagent：{internalId, parentNativeId} */
    const subRecords: Array<{ internalId: string; parentNativeId?: string }> = [];

    for (const row of sessStmt.iterate()) {
      const s = row as unknown as GooseSessionRow;
      scanned++;

      const nativeSessionId = s.session_id;
      const parentNativeId = s.parent_session_id && s.parent_session_id.length > 0
        ? s.parent_session_id
        : undefined;
      const topology: SessionTopology = parentNativeId ? 'subagent' : 'root';
      const cwd = s.working_dir ?? undefined;

      if (s.archived_at !== null) archived++;

      const msgRows = msgStmt.all(s.session_id) as unknown as GooseMessageRow[];
      const messages: SessionMessageInput[] = [];
      for (const m of msgRows) {
        const content = (m.content ?? '').trim();
        if (!content) continue;
        const role = this.normalizeRole(m.role);
        if (!role) continue;
        messages.push({
          role,
          content: m.content,
          timestamp: m.created_at ?? undefined,
        });
      }

      // 无消息的 session 仍记录身份与拓扑（便于关系建联），但计入 skipped 桶
      // —— 仅当确实无消息时跳过消息入库；session 行本身不入库（与 cass 一致：
      //   无有效消息 → 跳过该 session）
      if (messages.length === 0) {
        skipped++;
        continue;
      }

      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId,
        source: 'goose',
        cwd,
        projectPath: cwd,
        startedAt: s.started_at ?? undefined,
        topology,
        sourceKind: 'A',
        messages,
        model: s.model ?? undefined,
      });
      internalIdByNative.set(nativeSessionId, result.sessionId);

      if (topology === 'subagent') {
        subagents++;
        subRecords.push({ internalId: result.sessionId, parentNativeId });
      }

      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    // 建关系：subagent → parent spawned_by（仅可验证父）
    for (const sub of subRecords) {
      if (!sub.parentNativeId) {
        unlinkedSubagents++;
        continue;
      }
      const parentId = internalIdByNative.get(sub.parentNativeId);
      if (!parentId || parentId === sub.internalId) {
        unlinkedSubagents++;
        continue;
      }
      this.store.addRelationship({
        fromSessionId: sub.internalId,
        toSessionId: parentId,
        relationType: 'spawned_by',
        evidence: 'goose sessions.parent_session_id',
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
      archived,
    };
  }

  /**
   * 归一化 Goose 消息 role 到 yondermesh MessageRole；未知返回 null（跳过）。
   * Goose 真实角色：user / assistant / tool / system。
   */
  private normalizeRole(role: string | null | undefined): MessageRole | null {
    switch (role) {
      case 'user':
      case 'assistant':
      case 'system':
      case 'tool':
        return role;
      default:
        return null;
    }
  }
}
