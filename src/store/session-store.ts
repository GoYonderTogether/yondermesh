/**
 * Session Store —— 基于 node:sqlite 的本机 Session Vault 存储
 *
 * 核心契约（LOOP-001）：
 *   - 身份 = device_id + source_instance_id + native_session_id（§3.1）
 *   - 内容幂等：content_hash 基于消息内容，相同内容不新增 revision
 *   - 内容变化：生成新 revision，revision_number 递增，保留历史
 *   - 关系：单独建表，双向可查，幂等
 *
 * content_hash 只覆盖消息内容（role + content + 顺序），不含 timestamp：
 * 单纯时间抖动不算内容变化，避免无意义 revision。
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { SCHEMA, SCHEMA_INDEXES } from './schema.js';
import { MIGRATION_COLUMNS, MIGRATION_BACKFILLS } from './schema.js';
import type { ProcessAliveChecker } from './process-detector.js';
import type {
  ActiveSessionSummary,
  ActiveSummary,
  ActivityStatus,
  AwaitingReviewSession,
  Coverage,
  IngestResult,
  Presence,
  Relationship,
  RelationshipInput,
  RevisionRecord,
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

/** 行记录的松散类型 */
type Row = Record<string, unknown>;

/** LIVE 阈值：最近 2 分钟内有 lastSeenAt 视为正在写入，与 MCP server 保持一致 */
export const LIVE_THRESHOLD_MS = 120_000;

/** STALE 阈值：超过此时间未修改文件视为已停止 */
export const STALE_THRESHOLD_MS = 30 * 60_000; // 30 分钟

import { expandSource, normalizeSource, sessionMatchKey } from './source-aliases.js';

// node:sqlite 是实验性内置，vitest/vite 静态解析会误判为裸包 sqlite。
// 用 createRequire 在运行时加载，绕过 vite 预优化；类型仍取自 @types/node。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export class SessionStore {
  private readonly db: DatabaseSyncType;

  constructor(location: string) {
    this.db = new DatabaseSync(location);
    // 启用外键约束，保证 source_instance / session / revision 引用完整
    this.db.exec('PRAGMA foreign_keys = ON');
    this.ensureSchema();
  }

  /** 应用 schema（幂等，可重复调用） */
  ensureSchema(): void {
    // 顺序很重要：先建表，再跑列迁移（ALTER TABLE ADD COLUMN），
    // 最后建索引——部分索引引用了迁移新增的列（如 idx_msg_thread → thread_id）。
    this.db.exec(SCHEMA);
    this.runMigrations();
    this.db.exec(SCHEMA_INDEXES);
  }

  /** 幂等列迁移：检测列是否存在，缺失才 ALTER TABLE ADD COLUMN */
  private runMigrations(): void {
    for (const { table, column, type } of MIGRATION_COLUMNS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      const exists = cols.some((c) => c.name === column);
      if (!exists) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
    // 数据回填（幂等）
    for (const { check, sql } of MIGRATION_BACKFILLS) {
      const row = this.db.prepare(check).get() as Row | undefined;
      if (row && !row.has) {
        this.db.exec(sql);
      }
    }
  }

  /** 写入元数据列（首次入库和更新时调用） */
  private updateMetadata(sessionId: string, input: SessionIngestInput): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if (input.model !== undefined) { sets.push('model = ?'); params.push(input.model); }
    if (input.cliVersion !== undefined) { sets.push('cli_version = ?'); params.push(input.cliVersion); }
    if (input.originator !== undefined) { sets.push('originator = ?'); params.push(input.originator); }
    if (input.entrySource !== undefined) { sets.push('entry_source = ?'); params.push(input.entrySource); }
    if (input.threadSource !== undefined) { sets.push('thread_source = ?'); params.push(input.threadSource); }
    if (input.estimatedCostUsd !== undefined) { sets.push('estimated_cost_usd = ?'); params.push(input.estimatedCostUsd); }
    if (input.totalInputTokens !== undefined) { sets.push('total_input_tokens = ?'); params.push(input.totalInputTokens); }
    if (input.totalOutputTokens !== undefined) { sets.push('total_output_tokens = ?'); params.push(input.totalOutputTokens); }
    if (input.toolCallCount !== undefined) { sets.push('tool_call_count = ?'); params.push(input.toolCallCount); }
    if (input.totalCacheReadTokens !== undefined) { sets.push('total_cache_read_tokens = ?'); params.push(input.totalCacheReadTokens); }
    if (input.totalCacheCreationTokens !== undefined) { sets.push('total_cache_creation_tokens = ?'); params.push(input.totalCacheCreationTokens); }
    if (input.grandTotalTokens !== undefined) { sets.push('grand_total_tokens = ?'); params.push(input.grandTotalTokens); }
    if (input.apiCallCount !== undefined) { sets.push('api_call_count = ?'); params.push(input.apiCallCount); }

    if (sets.length === 0) return;
    params.push(sessionId);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /** 列出所有业务表（不含 sqlite 内部表） */
  listTables(): string[] {
    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Row[];
    return rows.map((r) => r.name as string);
  }

  // ─── 来源实例 ─────────────────────────────────────────────────────────

  /** 注册来源实例，按 device+source+rootPath 幂等 */
  registerSourceInstance(input: SourceInstanceInput): SourceInstance {
    const id = this.identityHash(input.deviceId, input.source, input.rootPath ?? '');
    const now = Date.now();
    const coverage: Coverage = input.coverage ?? 'B';
    this.db
      .prepare(
        `INSERT INTO source_instances (id, device_id, source, root_path, coverage, presence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'present', ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(id, input.deviceId, input.source, input.rootPath ?? null, coverage, now, now);

    const row = this.db
      .prepare('SELECT * FROM source_instances WHERE id = ?')
      .get(id) as Row;
    return this.rowToSourceInstance(row);
  }

  /** 读取来源实例（按 id），不存在返回 undefined */
  getSourceInstance(id: string): SourceInstance | undefined {
    const row = this.db
      .prepare('SELECT * FROM source_instances WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? this.rowToSourceInstance(row) : undefined;
  }

  // ─── Session 入库 ────────────────────────────────────────────────────

  /** 入库一个 session：首次创建 / 内容幂等 / 内容变化生成新 revision */
  ingestSession(input: SessionIngestInput): IngestResult {
    const sessionId = this.identityHash(
      input.deviceId,
      input.sourceInstanceId,
      input.nativeSessionId,
    );
    const hash = this.contentHash(input.messages);
    const messageCount = input.messages.length;
    const now = Date.now();

    this.db.exec('BEGIN');
    try {
      const existing = this.db
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get(sessionId) as Row | undefined;

      // 首次创建：session + revision 1 + 消息
     if (!existing) {
      const startedAt = input.startedAt ?? now;
      const fileModifiedAt = input.fileModifiedAt ?? now;
      this.db
        .prepare(
          `INSERT INTO sessions
             (id, device_id, source_instance_id, native_session_id, source, cwd, project_path,
              topology, presence, retention, sync_state, content_hash, current_revision_id,
              message_count, started_at, last_seen_at, ended_at, created_at, updated_at, file_modified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'present', 'live', 'local', ?, NULL, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          sessionId,
          input.deviceId,
          input.sourceInstanceId,
          input.nativeSessionId,
          input.source,
          input.cwd ?? null,
          input.projectPath ?? null,
          input.topology ?? 'root',
          hash,
          messageCount,
          startedAt,
          now,
          now,
          now,
          fileModifiedAt,
        );
       // 写入元数据列（如果有值）
       this.updateMetadata(sessionId, input);

        const revisionId = this.insertRevision(sessionId, 1, hash, messageCount, input.sourceKind);
        this.insertMessages(sessionId, revisionId, input.messages);
        this.db
          .prepare('UPDATE sessions SET current_revision_id = ? WHERE id = ?')
          .run(revisionId, sessionId);

        this.db.exec('COMMIT');
        return { sessionId, created: true, newRevision: true, revisionNumber: 1, messageCount };
      }

      // 已存在：比较内容
      if (existing.content_hash === hash) {
        // 内容幂等：只刷新 last_seen_at（表示"最近被 ymesh 看到"）
        // 不刷新 updated_at —— updated_at 只在内容真的变化时更新，用于反映"最近真实活动"
        this.db
          .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
          .run(now, sessionId);
        // 即使内容不变也刷新元数据（model、tokens、cost 等可能由 adapter 新增解析）
        this.updateMetadata(sessionId, input);
        const revRow = this.db
          .prepare('SELECT revision_number FROM session_revisions WHERE id = ?')
          .get(existing.current_revision_id as number) as Row | undefined;
        this.db.exec('COMMIT');
        return {
          sessionId,
          created: false,
          newRevision: false,
          revisionNumber: (revRow?.revision_number as number) ?? 0,
          messageCount: existing.message_count as number,
        };
      }

     // 内容变化：新 revision
     const nextNumber =
       ((this.db
         .prepare('SELECT COALESCE(MAX(revision_number), 0) AS n FROM session_revisions WHERE session_id = ?')
         .get(sessionId) as Row).n as number) + 1;
     const revisionId = this.insertRevision(sessionId, nextNumber, hash, messageCount, input.sourceKind);
     this.insertMessages(sessionId, revisionId, input.messages);
     const fileModifiedAtUpdate = input.fileModifiedAt ?? now;
     this.db
       .prepare(
         `UPDATE sessions
          SET current_revision_id = ?, content_hash = ?, message_count = ?, last_seen_at = ?, updated_at = ?, file_modified_at = ?
          WHERE id = ?`,
       )
       .run(revisionId, hash, messageCount, now, now, fileModifiedAtUpdate, sessionId);
     this.updateMetadata(sessionId, input);

      this.db.exec('COMMIT');
      return { sessionId, created: false, newRevision: true, revisionNumber: nextNumber, messageCount };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 读取当前 revision 的消息 */
  getMessages(sessionId: string): SessionMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.seq, m.role, m.content, m.timestamp
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.session_id = ? AND m.revision_id = s.current_revision_id
         ORDER BY m.seq`,
      )
      .all(sessionId) as Row[];
    return rows.map((r) => ({
      seq: r.seq as number,
      role: r.role as SessionMessage['role'],
      content: r.content as string,
      timestamp: (r.timestamp as number | null) ?? undefined,
    }));
  }

  /** 读取 session 的全部 revision 历史（升序） */
  getRevisions(sessionId: string): RevisionRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM session_revisions WHERE session_id = ? ORDER BY revision_number',
      )
      .all(sessionId) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      revisionNumber: r.revision_number as number,
      contentHash: r.content_hash as string,
      messageCount: r.message_count as number,
      sourceKind: (r.source_kind as Coverage | null) ?? null,
      recordedAt: r.recorded_at as number,
    }));
  }

  // ─── 关系 ────────────────────────────────────────────────────────────

  /** 写入关系（from→to，type），幂等 */
  addRelationship(input: RelationshipInput): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO session_relationships (from_session_id, to_session_id, relation_type, evidence, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(from_session_id, to_session_id, relation_type) DO NOTHING`,
      )
      .run(input.fromSessionId, input.toSessionId, input.relationType, input.evidence ?? null, now);
  }

  /** 查询涉及某 session 的全部关系（双向，带 direction） */
  queryRelationships(sessionId: string): Relationship[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM session_relationships WHERE from_session_id = ? OR to_session_id = ?',
      )
      .all(sessionId, sessionId) as Row[];
    return rows.map((r) => {
      const from = r.from_session_id as string;
      return {
        fromSessionId: from,
        toSessionId: r.to_session_id as string,
        relationType: r.relation_type as Relationship['relationType'],
        evidence: (r.evidence as string | null) ?? null,
        direction: from === sessionId ? 'outgoing' : 'incoming',
      };
    });
  }

  // ─── 查询 ────────────────────────────────────────────────────────────

  /**
   * 转义 LIKE 特殊字符（_ % \），使前缀匹配按字面量工作。
   * 返回转义后的 pattern，调用方需用 ESCAPE '\' 子句。
   */
  private escapeLike(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }

  /**
   * 构建多维查询的 WHERE 条件和参数。
   * cwdPrefix / projectPrefix 使用 LIKE + ESCAPE 实现目录边界安全的前缀匹配：
   *   '/foo' 匹配 cwd='/foo' 或 cwd='/foo/...'
   *   但不匹配 cwd='/foobar'（边界 '_' 被转义为字面量）
   */
  private buildQueryConditions(query: SessionQuery): { where: string; params: (string | number)[] } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // 默认排除 archived（被去重的）session
    if (!query.includeArchived) {
      conditions.push("retention = 'live'");
    }

    if (query.deviceId) {
      conditions.push('device_id = ?');
      params.push(query.deviceId);
    }
    if (query.source) {
      // 展开别名：--source claude → IN ('claude', 'claude-code', 'claude_code')
      const aliases = expandSource(query.source);
      if (aliases.length === 1) {
        conditions.push('source = ?');
        params.push(aliases[0]!);
      } else {
        conditions.push(`source IN (${aliases.map(() => '?').join(', ')})`);
        params.push(...aliases);
      }
    }
    if (query.topology) {
      conditions.push('topology = ?');
      params.push(query.topology);
    }
    if (query.cwd !== undefined) {
      if (query.cwd === null) {
        conditions.push('cwd IS NULL');
      } else {
        conditions.push('cwd = ?');
        params.push(query.cwd);
      }
    }
    if (query.projectPath !== undefined) {
      if (query.projectPath === null) {
        conditions.push('project_path IS NULL');
      } else {
        conditions.push('project_path = ?');
        params.push(query.projectPath);
      }
    }
    if (query.startedAtFrom !== undefined) {
      conditions.push('started_at >= ?');
      params.push(query.startedAtFrom);
    }
    if (query.startedAtTo !== undefined) {
      conditions.push('started_at <= ?');
      params.push(query.startedAtTo);
    }
    if (query.cwdPrefix !== undefined) {
      // 规范化：去尾部斜杠，使 /repo/ 与 /repo 等价
      const cwdNorm = query.cwdPrefix.replace(/\/+$/, '');
      const cwdEsc = this.escapeLike(cwdNorm);
      conditions.push("(cwd = ? OR cwd LIKE ? ESCAPE '\\')");
      params.push(cwdNorm, cwdEsc + '/%');
    }
    if (query.projectPrefix !== undefined) {
      const projNorm = query.projectPrefix.replace(/\/+$/, '');
      const projEsc = this.escapeLike(projNorm);
      conditions.push("(project_path = ? OR project_path LIKE ? ESCAPE '\\')");
      params.push(projNorm, projEsc + '/%');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return { where, params };
  }

  /** 多维查询 session 列表 */
  querySessions(query: SessionQuery): SessionRecord[] {
    const { where, params } = this.buildQueryConditions(query);
    const limit = query.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY last_seen_at DESC LIMIT ?`)
      .all(...params, limit) as Row[];
    return rows.map((r) => this.rowToSession(r));
  }

  /** 按 id 获取单条 session，不存在返回 undefined */
  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId) as Row | undefined;
    return row ? this.rowToSession(row) : undefined;
  }

  /** 统计（与 querySessions 同过滤语义） */
  getSessionStats(query: SessionQuery): SessionStats {
    const { where, params } = this.buildQueryConditions(query);

    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_sessions,
           COALESCE(SUM(CASE WHEN topology = 'root' THEN 1 ELSE 0 END), 0) AS root_sessions,
           COALESCE(SUM(CASE WHEN topology = 'subagent' THEN 1 ELSE 0 END), 0) AS subagent_sessions,
           COALESCE(SUM(message_count), 0) AS total_messages
         FROM sessions ${where}`,
      )
      .get(...params) as Row;

    return {
      totalSessions: totals.total_sessions as number,
      rootSessions: totals.root_sessions as number,
      subagentSessions: totals.subagent_sessions as number,
      totalMessages: totals.total_messages as number,
    };
  }

  /**
   * 活跃 session 摘要：返回最近 withinMs 内有 lastSeenAt 的 session 聚合统计。
   *
   * 实现要点：
   *   - 直查 sessions 表（retention='live'），按 last_seen_at 倒序
   *   - 不拉消息，只读必要列
   *   - 在 store 层完成聚合（liveCount / subagentActive / rootActive / bySource）
   *   - isLive 判定：now - lastSeenAt < LIVE_THRESHOLD_MS（与 MCP server 一致）
   */
  getActiveSessionsSummary(
    withinMs: number = 30 * 60 * 1000,
    processAliveChecker?: ProcessAliveChecker,
  ): ActiveSummary {
    const now = Date.now();
    const threshold = now - withinMs;

    // 用 file_modified_at（文件实际 mtime）判定活跃度，不受扫描时间影响。
    // COALESCE 回退到 updated_at 兼容未迁移的老数据。
    const rows = this.db
      .prepare(
        `SELECT id, native_session_id, source, cwd, project_path, topology,
                last_seen_at, updated_at, file_modified_at, message_count
         FROM sessions
         WHERE retention = 'live' AND COALESCE(file_modified_at, updated_at) >= ?
         ORDER BY COALESCE(file_modified_at, updated_at) DESC`,
      )
      .all(threshold) as Row[];

    // 进程检测：如果提供了 checker，一次性查询所有候选 session 的进程存活状态
    const aliveIds = processAliveChecker
      ? processAliveChecker(rows.map((r) => r.native_session_id as string))
      : null;
    const hasProcessInfo = aliveIds !== null;

    const sessions: ActiveSessionSummary[] = rows.map((r) => {
      const fileModifiedAt = (r.file_modified_at as number | null) ?? (r.updated_at as number);
      const ageMs = now - fileModifiedAt;
      const isLive = ageMs < LIVE_THRESHOLD_MS;
      const nativeId = r.native_session_id as string;

      let activityStatus: ActivityStatus;
      let processAlive: boolean | null;

      if (hasProcessInfo) {
        processAlive = aliveIds!.has(nativeId);
        if (processAlive) {
          // 进程在 → 用 mtime 区分 active writing vs waiting
          activityStatus = isLive ? 'live' : 'idle';
        } else if (ageMs < STALE_THRESHOLD_MS) {
          // 进程检测不到 + 文件近期有更新 → session ID 可能未暴露在 ps args 中
          //（如 codex、trae 等 IDE-based agent），不能判定为 stopped
          activityStatus = isLive ? 'live' : 'idle';
        } else {
          // 进程检测不到 + 文件也超过 STALE 阈值 → 确实已停止
          activityStatus = 'stopped';
        }
      } else {
        // 无进程检测 → 退回 mtime-only（不降低准确性）
        processAlive = null;
        activityStatus = isLive
          ? 'live'
          : ageMs < STALE_THRESHOLD_MS
            ? 'idle'
            : 'stale';
      }

      return {
        sessionId: r.id as string,
        nativeSessionId: nativeId,
        source: r.source as string,
        cwd: (r.cwd as string | null) ?? null,
        projectPath: (r.project_path as string | null) ?? null,
        topology: r.topology as SessionTopology,
        lastSeenAt: r.last_seen_at as number,
        messageCount: r.message_count as number,
        fileModifiedAt,
        isLive,
        activityStatus,
        processAlive,
      };
    });

    const bySource: Record<string, number> = {};
    let liveCount = 0;
    let idleCount = 0;
    let staleCount = 0;
    let stoppedCount = 0;
    let subagentActive = 0;
    let rootActive = 0;

    for (const s of sessions) {
      bySource[s.source] = (bySource[s.source] ?? 0) + 1;
      if (s.activityStatus === 'live') liveCount++;
      else if (s.activityStatus === 'idle') idleCount++;
      else if (s.activityStatus === 'stopped') stoppedCount++;
      else staleCount++;
      if (s.topology === 'subagent') subagentActive++;
      if (s.topology === 'root') rootActive++;
    }

    return {
      totalActive: sessions.length,
      liveCount,
      idleCount,
      staleCount,
      stoppedCount,
      subagentActive,
      rootActive,
      bySource,
      sessions,
    };
  }

  /**
   * 找出等待用户审阅的 session：最后一条消息是 assistant + 文件近期有活动。
   *
   * 判定逻辑：
   *   - retention = 'live'
   *   - file_modified_at 在 withinMs 窗口内（默认 30 分钟）
   *   - 当前 revision 的最后一条消息 role = 'assistant'
   *
   * 性能：单条 SQL 用子查询取每个 session 的最后一条消息，走索引。
   */
  getSessionsAwaitingReview(withinMs: number = 30 * 60 * 1000): AwaitingReviewSession[] {
    const now = Date.now();
    const threshold = now - withinMs;

    const rows = this.db
      .prepare(
        `SELECT s.id, s.native_session_id, s.source, s.cwd, s.project_path,
                s.topology, s.message_count,
                COALESCE(s.file_modified_at, s.updated_at) AS file_modified_at,
                lm.role AS last_role, lm.content AS last_content
         FROM sessions s
         JOIN messages lm ON lm.id = (
           SELECT m.id FROM messages m
           WHERE m.session_id = s.id AND m.revision_id = s.current_revision_id
           ORDER BY m.seq DESC LIMIT 1
         )
         WHERE s.retention = 'live'
           AND COALESCE(s.file_modified_at, s.updated_at) >= ?
           AND lm.role = 'assistant'
         ORDER BY file_modified_at DESC`,
      )
      .all(threshold) as Row[];

    return rows.map((r) => ({
      sessionId: r.id as string,
      nativeSessionId: r.native_session_id as string,
      source: r.source as string,
      cwd: (r.cwd as string | null) ?? null,
      projectPath: (r.project_path as string | null) ?? null,
      topology: r.topology as SessionTopology,
      messageCount: r.message_count as number,
      fileModifiedAt: r.file_modified_at as number,
      lastRole: r.last_role as SessionMessage['role'],
      lastMessagePreview: (r.last_content as string).slice(0, 100),
    }));
  }

  // ─── 跨源去重 ──────────────────────────────────────────────────────────

  /**
   * 跨源去重：cass (coverage B) 导入的 session 如果与原生 adapter (coverage A)
   * 导入的是同一个物理 session，标记 B 为 import_alias_of 并设 retention=archived。
   *
   * 匹配键 = normalizeSource(source) + extractCanonicalId(native_session_id)
   * 例如 cass 的 `-Users-zoran/.../6378ff08-....jsonl` 和原生 `6378ff08-...` 匹配。
   *
   * 幂等：已标记为 archived 的 session 不会重复处理。
   */
  deduplicateCrossSource(): { deduped: number; total: number; unique: number } {
    // 取出 source_instance 的 coverage 映射
    const instances = this.db
      .prepare('SELECT id, coverage FROM source_instances')
      .all() as Row[];
    const coverageMap = new Map<string, Coverage>();
    for (const inst of instances) {
      coverageMap.set(inst.id as string, inst.coverage as Coverage);
    }

    // 取出全部 live session（尚未被标记 archived 的）
    const sessions = this.db
      .prepare("SELECT id, source_instance_id, source, native_session_id FROM sessions WHERE retention = 'live'")
      .all() as Row[];

    // 按 matchKey 分组
    const groups = new Map<string, Array<{ id: string; coverage: Coverage }>>();
    for (const s of sessions) {
      const key = sessionMatchKey(s.source as string, s.native_session_id as string);
      const cov = coverageMap.get(s.source_instance_id as string) ?? 'B';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ id: s.id as string, coverage: cov });
    }

    let deduped = 0;
    const now = Date.now();
    const updateRetention = this.db
      .prepare("UPDATE sessions SET retention = 'archived', updated_at = ? WHERE id = ? AND retention = 'live'");

    for (const [, group] of groups) {
      if (group.length < 2) continue;
      // 找出 A 覆盖的 session 作为 canonical
      const aSessions = group.filter((s) => s.coverage === 'A');
      if (aSessions.length === 0) continue; // 无 A 覆盖，无法去重
      const canonical = aSessions[0]!;
      // B 覆盖的标记为 archived 并建关系
      for (const s of group) {
        if (s.coverage !== 'B') continue;
        updateRetention.run(now, s.id);
        this.addRelationship({
          fromSessionId: s.id,
          toSessionId: canonical.id,
          relationType: 'import_alias_of',
          evidence: 'cross-source dedup: B coverage matched to A by sessionMatchKey',
        });
        deduped++;
      }
    }

    return { deduped, total: sessions.length, unique: sessions.length - deduped };
  }

  /**
   * 按真实 CLI agent 分组统计（排除 archived）。
   * 返回按 count 降序排列的 { source, count, rootCount, subagentCount } 列表。
   */
 getSourceBreakdown(): Array<{ source: string; count: number; rootCount: number; subagentCount: number }> {
   const rows = this.db
     .prepare(
       `SELECT source, topology, message_count FROM sessions WHERE retention = 'live'`,
     )
     .all() as Row[];
   // 在 TS 层按 normalizeSource 聚合
   const map = new Map<string, { count: number; rootCount: number; subagentCount: number }>();
   for (const r of rows) {
     const key = normalizeSource(r.source as string);
     if (!map.has(key)) map.set(key, { count: 0, rootCount: 0, subagentCount: 0 });
     const e = map.get(key)!;
     e.count++;
     if ((r.topology as string) === 'root') e.rootCount++;
     if ((r.topology as string) === 'subagent') e.subagentCount++;
   }
   return [...map.entries()]
     .map(([source, v]) => ({ source, ...v }))
     .sort((a, b) => b.count - a.count);
 }

  // ─── agent_messages ──────────────────────────────────────────────────

  /** 投递一条跨 session 消息，返回消息 id */
  postMessage(input: {
    toSessionId?: string;
    toProject?: string;
    fromSessionId?: string;
    body: string;
    kind?: string;
  }): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO agent_messages (to_session_id, to_project, from_session_id, body, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.toSessionId ?? null,
        input.toProject ?? null,
        input.fromSessionId ?? null,
        input.body,
        input.kind ?? 'info',
        now,
      );
    return Number(result.lastInsertRowid);
  }

  /** 查询 agent 间消息（读取时自动标记为已读） */
  queryAgentMessages(filter: {
    forSessionId?: string;
    forProject?: string;
    sinceMs?: number;
    unreadOnly?: boolean;
  }): Array<{
    id: number;
    toSessionId: string | null;
    toProject: string | null;
    fromSessionId: string | null;
    body: string;
    kind: string;
    createdAt: number;
    readAt: number | null;
  }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.forSessionId) {
      conditions.push('to_session_id = ?');
      params.push(filter.forSessionId);
    }
    if (filter.forProject) {
      conditions.push('to_project = ?');
      params.push(filter.forProject);
    }
    if (filter.sinceMs) {
      conditions.push('created_at >= ?');
      params.push(filter.sinceMs);
    }
    if (filter.unreadOnly) {
      conditions.push('read_at IS NULL');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT id, to_session_id, to_project, from_session_id, body, kind, created_at, read_at
         FROM agent_messages ${where} ORDER BY created_at ASC`,
      )
      .all(...params) as Row[];

    // 自动标记为已读
    const updateRead = this.db.prepare('UPDATE agent_messages SET read_at = ? WHERE id = ? AND read_at IS NULL');
    const now = Date.now();
    for (const r of rows) {
      updateRead.run(now, r.id as number);
    }

    return rows.map((r) => ({
      id: r.id as number,
      toSessionId: (r.to_session_id as string) ?? null,
      toProject: (r.to_project as string) ?? null,
      fromSessionId: (r.from_session_id as string) ?? null,
      body: r.body as string,
      kind: r.kind as string,
      createdAt: r.created_at as number,
      readAt: (r.read_at as number) ?? null,
    }));
  }

  // ─── scan_runs ───────────────────────────────────────────────────────

  /** 开始一次扫描，返回 run id */
  startScanRun(input: ScanRunStartInput): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO scan_runs (source_instance_id, device_id, started_at, status)
         VALUES (?, ?, ?, 'running')`,
      )
      .run(input.sourceInstanceId ?? null, input.deviceId ?? null, now);
    return Number(result.lastInsertRowid);
  }

  /** 结束一次扫描，写入统计与状态 */
  finishScanRun(runId: number, input: ScanRunFinishInput): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE scan_runs
         SET ended_at = ?, status = ?, sessions_seen = ?, sessions_new = ?,
             sessions_updated = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        now,
        input.status,
        input.sessionsSeen ?? 0,
        input.sessionsNew ?? 0,
        input.sessionsUpdated ?? 0,
        input.error ?? null,
        runId,
      );
  }

  /** 读取一次扫描记录 */
  getScanRun(runId: number): ScanRun {
    const row = this.db
      .prepare('SELECT * FROM scan_runs WHERE id = ?')
      .get(runId) as Row;
    if (!row) throw new Error(`scan_run 不存在: ${runId}`);
    return {
      id: row.id as number,
      sourceInstanceId: (row.source_instance_id as string | null) ?? null,
      deviceId: (row.device_id as string | null) ?? null,
      startedAt: row.started_at as number,
      endedAt: (row.ended_at as number | null) ?? null,
      status: row.status as ScanRunStatus,
      sessionsSeen: row.sessions_seen as number,
      sessionsNew: row.sessions_new as number,
      sessionsUpdated: row.sessions_updated as number,
      error: (row.error as string | null) ?? null,
    };
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }

  // ─── 私有助手 ────────────────────────────────────────────────────────

  /**
   * 身份指纹：sha256。用 JSON.stringify 包裹避免字段值拼接碰撞
   * （例如 device="a b" + source="c" 与 device="a" + source="b c"）。
   */
  private identityHash(...parts: string[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  /**
   * 内容指纹：只看消息内容与顺序，不看 timestamp。用 JSON.stringify 规范化，
   * 消息内容里的任意特殊字符都会被 JSON 转义，保证无歧义、无碰撞。
   */
  private contentHash(messages: SessionMessageInput[]): string {
    const norm = JSON.stringify(messages.map((m, i) => [i, m.role, m.content]));
    return createHash('sha256').update(norm).digest('hex');
  }

  /** 插入一条 revision，返回自增 id */
  private insertRevision(
    sessionId: string,
    revisionNumber: number,
    hash: string,
    messageCount: number,
    sourceKind: Coverage | undefined,
  ): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO session_revisions (session_id, revision_number, content_hash, message_count, source_kind, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, revisionNumber, hash, messageCount, sourceKind ?? null, now);
    return Number(result.lastInsertRowid);
  }

  /** 批量插入某 revision 的消息快照 */
  private insertMessages(sessionId: string, revisionId: number, messages: SessionMessageInput[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO messages (session_id, revision_id, seq, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    );
    messages.forEach((m, i) => {
      stmt.run(sessionId, revisionId, i, m.role, m.content, m.timestamp ?? null);
    });
  }

  private rowToSourceInstance(row: Row): SourceInstance {
    return {
      id: row.id as string,
      deviceId: row.device_id as string,
      source: row.source as string,
      rootPath: (row.root_path as string | null) ?? null,
      coverage: row.coverage as Coverage,
      presence: row.presence as Presence,
    };
  }

  private rowToSession(row: Row): SessionRecord {
    return {
      id: row.id as string,
      deviceId: row.device_id as string,
      sourceInstanceId: row.source_instance_id as string,
      nativeSessionId: row.native_session_id as string,
      source: row.source as string,
      cwd: (row.cwd as string | null) ?? null,
      projectPath: (row.project_path as string | null) ?? null,
      topology: row.topology as SessionTopology,
      presence: row.presence as Presence,
      retention: row.retention as SessionRecord['retention'],
      contentHash: row.content_hash as string,
      currentRevisionId: (row.current_revision_id as number | null) ?? null,
      messageCount: row.message_count as number,
      startedAt: (row.started_at as number | null) ?? null,
      lastSeenAt: row.last_seen_at as number,
      model: (row.model as string | null) ?? null,
      cliVersion: (row.cli_version as string | null) ?? null,
      originator: (row.originator as string | null) ?? null,
      entrySource: (row.entry_source as string | null) ?? null,
      threadSource: (row.thread_source as string | null) ?? null,
      estimatedCostUsd: (row.estimated_cost_usd as number | null) ?? null,
      totalInputTokens: (row.total_input_tokens as number | null) ?? null,
      totalOutputTokens: (row.total_output_tokens as number | null) ?? null,
      toolCallCount: (row.tool_call_count as number | null) ?? null,
      fileModifiedAt: (row.file_modified_at as number | null) ?? null,
    };
  }
}
