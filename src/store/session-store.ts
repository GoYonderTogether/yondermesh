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
import { SCHEMA, SCHEMA_INDEXES, SCHEMA_FTS, FTS_REBUILD_MIGRATION } from './schema.js';
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
  ToolCall,
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

/**
 * 清理关键字并分词：保留字母 / 数字 / 下划线 / CJK / 空白，其余替换为空白。
 *
 * 返回有效 token 列表（空白分隔）。空关键字返回空数组。
 * 用于 trigram FTS5 MATCH（≥3 字符 token）+ LIKE 回退（<3 字符 token）。
 */
export function tokenizeKeyword(keyword: string): string[] {
  const cleaned = keyword
    .replace(/[^\p{L}\p{N}_\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned.split(' ').filter(Boolean);
}

/**
 * FTS 自动陈旧检查的行数上限。
 *
 * 低于此值：构造时直接做精确检查（COUNT(*) 便宜，保持"小库自动回填"体验）。
 * 高于此值：推迟检查（deferred）——1300 万行上 COUNT(*) 实测 44.5s，不能进热路径。
 * 可用环境变量 YONDERMESH_FTS_AUTOCHECK_MAX_MB 覆盖。
 */
/**
 * FTS 自动陈旧检查的**体积**门槛（MB）。
 *
 * 为什么用体积而不是 MAX(rowid)：rowid 删除后不会回退。实测线上库压缩后只剩
 * 37 万行、530MB，MAX(rowid) 仍停在 1685 万 —— 于是明明很便宜的自检被永久
 * 推迟，`ymesh status` 一直显示「大库，精确检查约需数十秒」，纯误导。
 *
 * 体积与自检成本同向（messages 是主表）：12GB → 44s，530MB → 62ms。
 * 默认 1GB 约对应数秒级上限。
 */
const FTS_AUTOCHECK_MAX_MB = Number(process.env.YONDERMESH_FTS_AUTOCHECK_MAX_MB ?? 1024);

/**
 * 当前 FTS schema 版本。改动 FTS 结构（索引范围 / rowid 映射 / 分词器）时必须 +1，
 * 否则老库不会重建，行为会静默不一致。
 *   v1 = 全消息索引
 *   v2 = 仅 user + 截断 500（删除走 UNINDEXED 的 message_id 列 → O(n) 全表扫）
 *   v3 = 仅 user + 截断 500 + **rowid = messages.id**（删除 O(1)）
 */
const FTS_SCHEMA_VERSION = 'v3';

/**
 * 历史 revision 正文的保留策略：
 *   current-only（默认）= 只保留 current revision 的消息正文，旧 revision 只留元数据
 *   keep               = 保留每一版正文（旧的 O(N²) 行为，仅排障/研究时用）
 *
 * 为什么默认 current-only：每次内容变化都整份重写消息，存储量随对话长度**平方增长**。
 * 实测 claude-code 会话 986 条消息 → 2082 个 revision → 193 万行；13GB 库里
 * 97% 是这种被覆盖的历史副本，而产品侧没有任何读路径会读它们。
 */
export type RevisionBodyMode = 'current-only' | 'keep';

/** 压缩评估结果（只读） */
export interface CompactAnalysis {
  revisionBodyMode: RevisionBodyMode;
  /** 含历史副本的 session 数 */
  sessionsWithSupersededRevisions: number;
  /** 可回收的历史副本行数 */
  prunableRevisionRows: number;
  /** messages 表当前总行数（含待回收的历史副本） */
  messageRowsTotal: number;
  /** 真正的存活行数 = 总行数 − 可回收历史副本（各 session 的当前 revision） */
  liveMessageRows: number;
  ftsRows: number;
  /** 孤儿行数（session 已不存在；compact 会清掉） */
  orphanRows: number;
  dbBytes: number;
  freeBytes: number;
}

/** 压缩执行参数 */
export interface CompactOptions {
  sessionLimit?: number;
  budgetMs?: number;
  rebuildFts?: boolean;
  vacuum?: boolean;
  /** 阶段回调（CLI 打进度用；daemon 可忽略） */
  onPhase?: (phase: 'prune' | 'purge-orphans' | 'rebuild-fts' | 'backfill-fts' | 'vacuum') => void;
}

/** 压缩执行结果 */
export interface CompactReport {
  revisionBodyMode: RevisionBodyMode;
  deletedRevisionRows: number;
  /** 清掉的孤儿行数（session 已不存在的历史遗留） */
  purgedOrphanRows: number;
  ftsRebuilt: boolean;
  ftsBackfilled: number;
  vacuumed: boolean;
  elapsedMs: number;
}

export class SessionStore {
  private readonly db: DatabaseSyncType;
  /** FTS 未同步时的数据量（供 CLI/MCP 按需提示，不再自动打印）。 */
  private ftsStale: { userMsgTotal: number; ftsTotal: number } | null = null;
  /** 大库下把 FTS 陈旧检查推迟（避免每条命令付 40s+ 的全表 COUNT）。 */
  private ftsCheckDeferred = false;
  /** FTS 刚被重建（迁移后），需要回填；大库上交给 `ymesh compact` / `sync fts`。 */
  private ftsNeedsBackfill = false;

  constructor(location: string) {
    this.db = new DatabaseSync(location);
    // 启用外键约束，保证 source_instance / session / revision 引用完整
    this.db.exec('PRAGMA foreign_keys = ON');
    // 并发安全：busy_timeout 让短时锁竞争自动重试，避免立即抛 SQLITE_BUSY；
    // WAL 模式允许读写并发（subagent 并行跑 verifier 时不再互相阻塞）
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.ensureSchema();
  }

  /** 应用 schema（幂等，可重复调用） */
  ensureSchema(): void {
    // 顺序很重要：先建表，再跑列迁移（ALTER TABLE ADD COLUMN），
    // 最后建索引——部分索引引用了迁移新增的列（如 idx_msg_thread → thread_id）。
    this.db.exec(SCHEMA);
    this.runMigrations();
    this.db.exec(SCHEMA_INDEXES);

    // FTS schema 版本管理：fts_version 记录结构版本，不一致就重建（重建 → 回填）。
    //
    // 为什么必须按版本号重建而不是原地改：rowid 映射无法 ALTER，只能重建 FTS 表。
    // 历史：v1 全消息 → v2 仅 user → v3 rowid 化（删除从 O(n) 变 O(1)）。
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    const ftsVersionRow = this.db
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get('fts_version') as Row | undefined;
    const currentFtsSql =
      ((this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'")
        .get() as Row | undefined)?.sql as string) ?? '';
    const recordedVersion = (ftsVersionRow?.value as string | undefined) ?? null;

    // contentless 是历史上一个错误的 v2 实现，即使版本号对也要重建
    const needsRebuild =
      recordedVersion !== FTS_SCHEMA_VERSION || currentFtsSql.includes("content=''");

    if (needsRebuild) {
      this.db.exec(FTS_REBUILD_MIGRATION);
      this.db.exec(SCHEMA_FTS);
      this.db
        .prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)')
        .run('fts_version', FTS_SCHEMA_VERSION);
      this.ftsNeedsBackfill = true;
    } else {
      // 版本一致：确保 schema 存在（CREATE IF NOT EXISTS 幂等）
      this.db.exec(SCHEMA_FTS);
    }

    // FTS 陈旧检查的**成本闸门**：旧实现在构造里直接跑
    //   SELECT COUNT(*) FROM messages WHERE role='user'  + COUNT(*) FROM messages_fts
    // 在 1300 万行的 messages 表上实测 **44.5 秒/次 × 2**，于是每条命令
    //（连「只有 27 条消息的 session 详情」也一样）都要等 90 秒以上。
    // 现在：先用 O(1) 的 PRAGMA 探测库体积——
    //   · 小库 → 立刻做精确检查（便宜，保持自动回填体验）
    //   · 大库 → 推迟（deferred），只在显式需要时（status / sync fts / 搜索路径）
    //     调 ensureFtsChecked()
    // O(1) 体积探测（PRAGMA page_count × page_size），不用 MAX(rowid)——
    // 后者删除后不回退，会把「已经变小」的库一直当大库。
    const dbBytes = this.dbSizeInfo().dbBytes;
    const withinBudget = dbBytes <= FTS_AUTOCHECK_MAX_MB * 1024 * 1024;
    if (withinBudget) {
      this.syncFtsIfStale();
    } else {
      // 大库：不在这里回填（会阻塞每条命令）。迁移后的空 FTS 由
      // `ymesh compact` / `ymesh sync fts` 分批补，状态见 ftsStaleInfo()。
      this.ftsCheckDeferred = true;
      if (this.ftsNeedsBackfill) {
        const r = this.db
          .prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'user'")
          .get() as Row;
        this.ftsStale = { userMsgTotal: (r.n as number) ?? 0, ftsTotal: 0 };
      }
    }
  }

  /**
   * 显式执行 FTS 陈旧检查（大库下由 status / sync fts / 搜索路径调用）。
   * 幂等：只真正跑一次。大库上单次开销约数十秒，调用方需自行告知用户。
   */
  ensureFtsChecked(): void {
    if (!this.ftsCheckDeferred) return;
    this.ftsCheckDeferred = false;
    this.syncFtsIfStale();
  }

  /**
   * 回填 messages_fts：旧库升级到 FTS 时，触发器只能同步新写入的 messages，
   * 历史 messages 需要一次性回填。幂等（NOT IN 防重复）。
   *
   * v2 策略：只回填 user 消息，content 截断到 500 字符。
   *
   * 快速路径：FTS 行数 >= user messages 行数 → 已同步，跳过。
   * 大库保护：user messages > 50000 且 FTS 空 → 跳过自动回填（避免阻塞所有命令），
   *           由 `ymesh sync fts` 显式触发（分批回填）。
   */
  private syncFtsIfStale(): void {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM messages WHERE role = 'user') AS m,
           (SELECT COUNT(*) FROM messages_fts) AS f`,
      )
      .get() as Row;
    const userMsgTotal = (row.m as number) ?? 0;
    const ftsTotal = (row.f as number) ?? 0;
    if (ftsTotal >= userMsgTotal) return; // 已同步
    // 大库保护：user messages > 50000 且 FTS 未完全同步（差距 > 1000）时跳过自动回填。
    // 自动回填是单事务全量 INSERT，大表上会阻塞数分钟~数小时，拖死所有 store 构造。
    // 由 `ymesh sync fts` 显式分批回填（游标法，不阻塞其他命令）。
    if (userMsgTotal > 50_000 && userMsgTotal - ftsTotal > 1000) {
      // 只记录状态，**不在这里打印**：SessionStore 是低层组件，每次构造都往
      // stderr 喷提示会污染所有命令（含 --json）。由 CLI/MCP 在「需要 FTS 的
      // 命令」（search / query / status / doctor）里按需提示。见 ftsStaleInfo()。
      this.ftsStale = { userMsgTotal, ftsTotal };
      return;
    }
    // rowid 必须等于 messages.id（v3 约定，删除才能 O(1)）。
    // 只回填 current revision：历史 revision 的正文对检索零价值，却是重复放大的来源。
    this.db.exec(`
      INSERT INTO messages_fts(rowid, content, session_id, message_id, revision_id)
      SELECT m.id, substr(m.content, 1, 500), m.session_id, m.id, m.revision_id
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.role = 'user'
        AND m.revision_id = s.current_revision_id
        AND m.id NOT IN (SELECT message_id FROM messages_fts)
    `);
  }

  /**
   * 显式分批回填 messages_fts（供 `ymesh sync fts` 调用）。
   *
   * v2 策略：只回填 user 消息，content 截断到 500 字符。
   *
   * 与 syncFtsIfStale 的区别：
   *   - 公开方法，不跳过大库
   *   - 用游标法（id > MAX(message_id)）走索引，O(batchSize) 而非 O(n) 全表扫描
   *   - 单事务提交每批，避免事务过大
   *   - 返回进度 { total, done, remaining }，调用方可循环或打印进度
   *
   * 游标法安全性：
   *   - messages.id 单调递增（INTEGER PRIMARY KEY）
   *   - 按 id 升序连续回填，MAX(message_id) 即回填进度
   *   - 中断后重启从 MAX 继续，事务原子保证无部分写入
   *   - id 间隙（DELETE 留下）不影响——间隙里的 id 本就不存在
   */
  syncFtsBatch(batchSize: number = 5000): { total: number; done: number; remaining: number } {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM messages WHERE role = 'user') AS m,
           (SELECT COUNT(*) FROM messages_fts) AS f`,
      )
      .get() as Row;
    const total = (row.m as number) ?? 0;
    const done = (row.f as number) ?? 0;
    const remaining = Math.max(0, total - done);
    if (remaining === 0) return { total, done, remaining: 0 };

    // 游标：已回填区间的最大 message_id。首次回填时为 0，从 messages 最小 id 开始。
    const cursorRow = this.db
      .prepare('SELECT COALESCE(MAX(message_id), 0) AS cur FROM messages_fts')
      .get() as Row;
    const cursor = (cursorRow.cur as number) ?? 0;

    // 取游标之后的下一批 user 消息（id > cursor 走主键索引，O(batchSize)）
    const batch = this.db
      .prepare(
        `SELECT m.id AS id, m.content AS content, m.session_id AS session_id, m.revision_id AS revision_id
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE m.role = 'user' AND m.revision_id = s.current_revision_id AND m.id > ?
         ORDER BY m.id ASC LIMIT ?`,
      )
      .all(cursor, batchSize) as Array<{
        id: number;
        content: string;
        session_id: string;
        revision_id: number;
      }>;

    if (batch.length === 0) return { total, done, remaining: 0 };

    // rowid = messages.id（v3 约定）
    const insert = this.db.prepare(
      'INSERT INTO messages_fts(rowid, content, session_id, message_id, revision_id) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const m of batch) {
        // 截断到 500 字符（与触发器保持一致）
        const truncated = m.content.length > 500 ? m.content.substring(0, 500) : m.content;
        insert.run(m.id, truncated, m.session_id, m.id, m.revision_id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const newDone = done + batch.length;
    return { total, done: newDone, remaining: Math.max(0, total - newDone) };
  }

  /** 幂等列迁移：检测列是否存在，缺失才 ALTER TABLE ADD COLUMN */
  private runMigrations(): void {
    this.migrateToolCallsCascade();
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

  /**
   * 把 message_tool_calls 的 message_id 外键升级为 ON DELETE CASCADE。
   *
   * 为什么必须迁移：初版建表时外键没写级联，于是任何 `DELETE FROM messages`
   * （compact 回收历史副本、retain 删噪音）都会直接抛 FOREIGN KEY constraint failed。
   * SQLite 不能 ALTER 外键，只能按「建新表 → 拷数据 → 换名」重建。
   *
   * 幂等：检测 PRAGMA foreign_key_list 里 messages 外键的 on_delete 是否为 CASCADE。
   * 老库上是一次性成本（本项目实测 15.8 万行，秒级）。
   */
  private migrateToolCallsCascade(): void {
    const exists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_tool_calls'")
      .get() as Row | undefined;
    if (!exists) return;
    const fks = this.db.prepare("PRAGMA foreign_key_list('message_tool_calls')").all() as Row[];
    const msgFk = fks.find((f) => String(f.table) === 'messages');
    if (msgFk && String(msgFk.on_delete).toUpperCase() === 'CASCADE') return;

    // PRAGMA foreign_keys 在事务内无效，必须在事务外切换
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS message_tool_calls_mig (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id   INTEGER NOT NULL,
          session_id   TEXT NOT NULL,
          call_seq     INTEGER NOT NULL,
          tool_name    TEXT NOT NULL,
          tool_input   TEXT,
          UNIQUE (message_id, call_seq),
          FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
        INSERT OR IGNORE INTO message_tool_calls_mig (id, message_id, session_id, call_seq, tool_name, tool_input)
          SELECT id, message_id, session_id, call_seq, tool_name, tool_input FROM message_tool_calls;
        DROP TABLE message_tool_calls;
        ALTER TABLE message_tool_calls_mig RENAME TO message_tool_calls;
        COMMIT;
      `);
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_mtc_message ON message_tool_calls(message_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_mtc_session ON message_tool_calls(session_id)');
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

  /** 列出所有业务表（不含 sqlite 内部表与 FTS5 影子表） */
  listTables(): string[] {
    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE TABLE ''%' ORDER BY name",
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
      const fileModifiedAt = this.resolveLastActivity(input, now);
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
        // loop build-tool-calls-schema §D2：内容不变也补 attach toolCalls
        // （老 session 在 toolCalls 字段加入前入库，reimport 时 importer 现在能提取 toolCalls；
        //   content_hash 不含 toolCalls 故不产生新 revision，用 INSERT OR IGNORE 幂等补写）
        const hasToolCalls = input.messages.some((m) => m.toolCalls && m.toolCalls.length > 0);
        if (hasToolCalls) {
          const revId = existing.current_revision_id as number;
          const existingMsgs = this.db
            .prepare('SELECT id, seq FROM messages WHERE session_id = ? AND revision_id = ? ORDER BY seq')
            .all(sessionId, revId) as Array<{ id: number; seq: number }>;
          const seqToId = new Map<number, number>();
          for (const r of existingMsgs) seqToId.set(r.seq, r.id);
          const tcStmt = this.db.prepare(
            'INSERT OR IGNORE INTO message_tool_calls (message_id, session_id, call_seq, tool_name, tool_input) VALUES (?, ?, ?, ?, ?)',
          );
          this.attachToolCallsBySeqInner(sessionId, input.messages, seqToId, tcStmt);
        }
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
     // 旧 revision 的正文到此为止就没用了（没有任何读路径会读历史 revision 的消息），
     // 立刻删掉，避免「每变一次就多存一份全文」的平方级膨胀。revision 元数据保留。
     this.pruneSupersededRevisionBodies(sessionId, revisionId);
     const fileModifiedAtUpdate = this.resolveLastActivity(input, now);
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

  /** 读取当前 revision 的消息（含结构化 toolCalls，LEFT JOIN message_tool_calls） */
  getMessages(sessionId: string): SessionMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.seq, m.role, m.content, m.timestamp,
                COALESCE((
                   SELECT json_group_array(json_object('callSeq', t.call_seq, 'toolName', t.tool_name, 'toolInput', t.tool_input))
                   FROM message_tool_calls t WHERE t.message_id = m.id
                   ORDER BY t.call_seq
                 ), '[]') AS tool_calls_json
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.session_id = ? AND m.revision_id = s.current_revision_id
         ORDER BY m.seq`,
      )
      .all(sessionId) as Array<Row & { tool_calls_json: string }>;
    return rows.map((r) => {
      const msg: SessionMessage = {
        seq: r.seq as number,
        role: r.role as SessionMessage['role'],
        content: r.content as string,
        timestamp: (r.timestamp as number | null) ?? undefined,
      };
      const json = r.tool_calls_json ?? '[]';
      if (json && json !== '[]') {
        try {
          const arr = JSON.parse(json) as Array<{ callSeq: number; toolName: string; toolInput?: string | null }>;
          if (Array.isArray(arr) && arr.length > 0) {
            const toolCalls: ToolCall[] = arr.map((a) => {
              const tc: ToolCall = {
                callSeq: a.callSeq,
                toolName: a.toolName,
              };
              if (a.toolInput !== undefined && a.toolInput !== null) {
                tc.toolInput = a.toolInput;
              }
              return tc;
            });
            if (toolCalls.length > 0) msg.toolCalls = toolCalls;
          }
        } catch {
          /* tool_calls_json 损坏 → 跳过，不影响 messages 读取 */
        }
      }
      return msg;
    });
  }

  /**
   * 把 toolCalls 补 attach 到已存在 session 的当前 revision 的 messages。
   *
   * 按 (session_id, seq) 在 current_revision_id 下定位 message_id，
   * 然后 INSERT OR IGNORE into message_tool_calls（幂等：UNIQUE message_id+call_seq）。
   *
   * 用于 reimport：旧 importer 没采集 toolCalls 的 session，reimport 重新跑
   * importer 拿到带 toolCalls 的 messages，但内容未变（content_hash 相同）不会产生
   * 新 revision；此时用本方法把 toolCalls 补到现有 messages 上，无需新 revision。
   *
   * 入参 messages 的顺序与原 ingestSession 一致（seq = 数组索引）。
   *
   * @returns 实际新插入的 tool_call 行数（重复跑返回 0）
   */
  attachToolCallsBySeq(sessionId: string, messages: SessionMessageInput[]): number {
    const revRow = this.db
      .prepare('SELECT current_revision_id AS rid FROM sessions WHERE id = ?')
      .get(sessionId) as Row | undefined;
    if (!revRow || revRow.rid === null || revRow.rid === undefined) return 0;
    const revisionId = revRow.rid as number;

    const rows = this.db
      .prepare(
        'SELECT id, seq FROM messages WHERE session_id = ? AND revision_id = ? ORDER BY seq',
      )
      .all(sessionId, revisionId) as Array<{ id: number; seq: number }>;
    const seqToId = new Map<number, number>();
    for (const r of rows) seqToId.set(r.seq, r.id);

    const tcStmt = this.db.prepare(
      'INSERT OR IGNORE INTO message_tool_calls (message_id, session_id, call_seq, tool_name, tool_input) VALUES (?, ?, ?, ?, ?)',
    );

    let inserted = 0;
    this.db.exec('BEGIN');
    try {
      inserted = this.attachToolCallsBySeqInner(sessionId, messages, seqToId, tcStmt);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return inserted;
  }

  /**
   * attachToolCallsBySeq 的内部实现，不管理事务（供 ingestSession 在已开事务内调用）。
   * 由调用方保证事务边界。返回实际新插入的 tool_call 行数。
   */
  private attachToolCallsBySeqInner(
    sessionId: string,
    messages: SessionMessageInput[],
    seqToId: Map<number, number>,
    tcStmt: ReturnType<DatabaseSyncType['prepare']>,
  ): number {
    let inserted = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.toolCalls || msg.toolCalls.length === 0) continue;
      const messageId = seqToId.get(i);
      if (messageId === undefined) continue;
      for (const tc of msg.toolCalls) {
        const r = tcStmt.run(messageId, sessionId, tc.callSeq, tc.toolName, tc.toolInput ?? null);
        if (r.changes > 0) inserted++;
      }
    }
    return inserted;
  }

  /**
   * 统计某 session 当前 revision 的 message_tool_calls 行数。
   * 用于 reimport 后报告「补了 N 条 tool_calls」。
   */
  countToolCalls(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM message_tool_calls t
         JOIN messages m ON m.id = t.message_id
         JOIN sessions s ON s.id = m.session_id
         WHERE t.session_id = ? AND m.revision_id = s.current_revision_id`,
      )
      .get(sessionId) as Row;
    return (row.c as number) ?? 0;
  }

  /**
   * 统计指定 source（一个或多个 source label）的 session 数和 toolCalls 总数（当前 revision）。
   * 用于 reimport 命令的前后对比报告（loop build-tool-calls-schema §D3）。
   */
  sourceToolCallStats(sourceLabels: string[]): { sessions: number; toolCalls: number } {
    if (sourceLabels.length === 0) return { sessions: 0, toolCalls: 0 };
    const placeholders = sourceLabels.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT s.id) AS sessions,
                COALESCE(SUM(
                  (SELECT COUNT(*) FROM message_tool_calls t
                   JOIN messages m ON m.id = t.message_id
                   WHERE m.session_id = s.id AND m.revision_id = s.current_revision_id)
                ), 0) AS tool_calls
         FROM sessions s
         WHERE s.source IN (${placeholders})`,
      )
      .get(...sourceLabels) as Row;
    return {
      sessions: (row.sessions as number) ?? 0,
      toolCalls: (row.tool_calls as number) ?? 0,
    };
  }

  // ─── 历史 revision 正文的保留策略与回收 ──────────────────────────────

  /**
   * 当前的历史 revision 正文保留策略。
   * 默认 current-only：只保留 current revision 正文（旧版只留 hash/count/时间）。
   */
  getRevisionBodyMode(): RevisionBodyMode {
    return this.getMeta('revision_bodies') === 'keep' ? 'keep' : 'current-only';
  }

  /**
   * 切换历史 revision 正文保留策略。
   * keep 只建议排障时临时打开——它会恢复平方级膨胀。
   */
  setRevisionBodyMode(mode: RevisionBodyMode): void {
    this.setMeta('revision_bodies', mode);
  }

  /**
   * 删除某 session 中「非 current revision」的消息正文，返回删除行数。
   *
   * 走 idx_messages_session(session_id, revision_id, seq)，单 session 删除是索引区间扫描。
   * FTS 侧由 messages_fts_ad 触发器按 rowid 同步删除（v3 起 O(1)）。
   */
  pruneSupersededRevisionBodies(sessionId: string, keepRevisionId: number): number {
    if (this.getRevisionBodyMode() === 'keep') return 0;
    const r = this.db
      .prepare('DELETE FROM messages WHERE session_id = ? AND revision_id != ?')
      .run(sessionId, keepRevisionId);
    return Number(r.changes);
  }

  /**
   * 统计「历史 revision 正文」的存量（只读，供 compact 报告）。
   */
  countSupersededRevisionStore(): { sessions: number; rows: number } {
    const sRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions s
         WHERE EXISTS (
           SELECT 1 FROM messages m
           WHERE m.session_id = s.id AND m.revision_id != s.current_revision_id
         )`,
      )
      .get() as Row;
    const rRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.revision_id != s.current_revision_id`,
      )
      .get() as Row;
    return { sessions: (sRow.n as number) ?? 0, rows: (rRow.n as number) ?? 0 };
  }

  /**
   * 分批回收历史 revision 正文，返回本轮删除的行数。
   * @param sessionLimit 本轮最多处理多少个 session（控制单次耗时，便于 daemon 定时跑）
   */
  pruneSupersededRevisionBodiesBatch(sessionLimit: number = 50): number {
    if (this.getRevisionBodyMode() === 'keep') return 0;
    const targets = this.db
      .prepare(
        `SELECT s.id AS id, s.current_revision_id AS cur FROM sessions s
         WHERE s.current_revision_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM messages m
             WHERE m.session_id = s.id AND m.revision_id != s.current_revision_id
           )
         LIMIT ?`,
      )
      .all(sessionLimit) as Array<{ id: string; cur: number }>;
    if (targets.length === 0) return 0;
    let deleted = 0;
    this.db.exec('BEGIN');
    try {
      for (const t of targets) {
        const r = this.db
          .prepare('DELETE FROM messages WHERE session_id = ? AND revision_id != ?')
          .run(t.id, t.cur);
        deleted += Number(r.changes);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return deleted;
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
    // 区间交集：started_at <= activeTo AND 最近活动 >= activeFrom
    // 用 file_modified_at（文件真实 mtime）判定"那天有没有在干活"——与
    // getActiveSessionsSummary 同一约定，不受"ymesh 什么时候扫到它"影响。
    if (query.activeFrom !== undefined) {
      conditions.push('COALESCE(file_modified_at, last_seen_at, updated_at, created_at) >= ?');
      params.push(query.activeFrom);
    }
    if (query.activeTo !== undefined) {
      conditions.push('COALESCE(started_at, created_at) <= ?');
      params.push(query.activeTo);
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

    // 关键字全文检索：trigram FTS5 MATCH（≥3 字符 token）+ LIKE 回退（<3 字符 token）
    // 只命中当前 revision 的消息（旧 revision 内容不召回）
    if (query.keyword !== undefined) {
      const tokens = tokenizeKeyword(query.keyword);
      if (tokens.length === 0) {
        // 无有效 token：不可能匹配任何消息，直接返回空结果
        conditions.push('1 = 0');
      } else {
        const longTokens = tokens.filter((t) => t.length >= 3);
        const shortTokens = tokens.filter((t) => t.length < 3);
        // 长token（≥3字符）：走 FTS5 trigram MATCH（子串匹配，大小写不敏感）
        if (longTokens.length > 0) {
          // 每个 token 用双引号包裹（phrase，避免 FTS5 语法字符干扰），空格连接（AND）
          const matchExpr = longTokens.map((t) => `"${t}"`).join(' ');
          // 性能史（同一台机、13M 消息库）：
          //   · 从 sessions 侧关联：对每个 session 重扫 FTS 命中集 → 直接超时
          //   · 从 FTS 侧关联 + current_revision 子查询：3.2s（为了排除旧 revision 的重复命中）
          //   · 现在：FTS 只含 current revision（v3 回填 + ingest 清理保证），
          //     不再需要那层子查询，非关联 IN 即可，1s 以内。
          conditions.push(
            `sessions.id IN (SELECT f.session_id FROM messages_fts f WHERE f.messages_fts MATCH ?)`,
          );
          params.push(matchExpr);
        }
        // 短token（<3字符）：trigram 无法索引，回退到 LIKE 子串匹配
        for (const t of shortTokens) {
          const lowered = t.toLowerCase();
          // 转义 LIKE 特殊字符
          const escaped = lowered.replace(/[%_\\]/g, '\\$&');
          conditions.push(
            `EXISTS (
              SELECT 1 FROM messages m
              WHERE m.session_id = sessions.id
                AND m.revision_id = sessions.current_revision_id
                AND LOWER(m.content) LIKE ? ESCAPE '\\'
            )`,
          );
          params.push(`%${escaped}%`);
        }
      }
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

  /**
   * 把「用户手里可能拿到的任意一种 id」解析成 DB 主键 `id`。
   *
   * 背景（为什么需要）：本库有**两套 id 并存**——
   *   · `id`                = sha256(content) 派生，DB 主键（CLI 多处引用）
   *   · `native_session_id` = 各 CLI 自己的 id（pi 是 UUID，claude/codex 是各自的文件名 id）
   * 而 `ymesh sessions` 列表里显示的是**截断的 hash**，`ymesh mailbox` / `ymesh inject`
   * 用的却是 native id —— 用户几乎必然拿错 id 去用，得到一句「session not found」。
   *
   * 本方法让两者可以互换：完整 hash / 完整 native id / 任一的**唯一前缀**都能解析。
   *
   * @returns 解析出的 DB 主键 id；找不到返回 null
   * @throws 当传入前缀匹配到多个 session（歧义）时抛错，并列出候选，避免猜错
   */
  resolveSessionId(input: string): string | null {
    const key = input.trim();
    if (!key) return null;

    // 1. 精确匹配（两种 id 都试）
    const exact = this.db
      .prepare('SELECT id FROM sessions WHERE id = ? OR native_session_id = ? LIMIT 1')
      .get(key, key) as Row | undefined;
    if (exact?.id) return String(exact.id);

    // 2. 前缀匹配（用户在列表里复制到的常是截断 id）
    const rows = this.db
      .prepare(
        `SELECT id FROM sessions
          WHERE id LIKE ? OR native_session_id LIKE ?
          LIMIT 6`,
      )
      .all(`${key}%`, `${key}%`) as Row[];

    if (rows.length === 0) return null;
    if (rows.length === 1) return String(rows[0].id);

    const candidates = rows.map((r) => String(r.id).slice(0, 16)).join(', ');
    throw new Error(
      `session id 前缀「${key}」不唯一，匹配到 ${rows.length} 个（${candidates}…）。请给更长的前缀或完整 id。`,
    );
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

  /**
   * FTS 未同步信息（仅当大库保护触发回填跳过时有值）。
   *
   * 供 CLI/MCP 在**需要全文搜索的命令**里提示用户跑 `ymesh sync fts`；
   * 不再从构造里打印，避免污染与 FTS 无关的命令输出。
   */
  ftsStaleInfo(): { userMsgTotal: number; ftsTotal: number } | null {
    return this.ftsStale;
  }

  /** FTS 陈旧检查是否被推迟（大库）。为 true 时调用方应先 ensureFtsChecked()。 */
  isFtsCheckDeferred(): boolean {
    return this.ftsCheckDeferred;
  }

  /** 供调用方渲染成一行提示。 */
  static formatFtsStaleHint(info: { userMsgTotal: number; ftsTotal: number }): string {
    return (
      `user 消息 ${info.userMsgTotal} 条，FTS 全文索引仅回填 ${info.ftsTotal} 条（未同步）。` +
      ` 全文搜索会漏结果；跑 \`ymesh sync fts\` 分批回填即可（不阻塞其它命令）。`
    );
  }


  // ─── workspaces：工作目录的归属与分组（人为判断） ─────────────────────

  /** 列出所有已标记的工作目录。 */
  listWorkspaces(): Array<{
    path: string;
    label: string | null;
    groupName: string | null;
    note: string | null;
    createdAt: number;
    updatedAt: number;
  }> {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY group_name NULLS LAST, path')
      .all() as Row[];
    return rows.map((r) => ({
      path: r.path as string,
      label: (r.label as string | null) ?? null,
      groupName: (r.group_name as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    }));
  }

  /** 取一个工作目录的标记。 */
  getWorkspace(path: string): {
    path: string;
    label: string | null;
    groupName: string | null;
    note: string | null;
  } | null {
    const r = this.db.prepare('SELECT * FROM workspaces WHERE path = ?').get(path) as
      | Row
      | undefined;
    if (!r) return null;
    return {
      path: r.path as string,
      label: (r.label as string | null) ?? null,
      groupName: (r.group_name as string | null) ?? null,
      note: (r.note as string | null) ?? null,
    };
  }

  /** 新增/更新一个工作目录标记（部分字段缺省则保留原值）。 */
  upsertWorkspace(input: {
    path: string;
    label?: string | null;
    groupName?: string | null;
    note?: string | null;
  }): void {
    const now = Date.now();
    const existing = this.getWorkspace(input.path);
    if (existing) {
      this.db
        .prepare(
          'UPDATE workspaces SET label = ?, group_name = ?, note = ?, updated_at = ? WHERE path = ?',
        )
        .run(
          input.label !== undefined ? input.label : existing.label,
          input.groupName !== undefined ? input.groupName : existing.groupName,
          input.note !== undefined ? input.note : existing.note,
          now,
          input.path,
        );
      return;
    }
    this.db
      .prepare(
        'INSERT INTO workspaces (path, label, group_name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.path,
        input.label ?? null,
        input.groupName ?? null,
        input.note ?? null,
        now,
        now,
      );
  }

  /** 删掉一个工作目录标记（只删标记，不动任何 session）。 */
  removeWorkspace(path: string): boolean {
    const r = this.db.prepare('DELETE FROM workspaces WHERE path = ?').run(path);
    return Number(r.changes) > 0;
  }


  // ─── 增量扫描索引（scanned_files）────────────────────────────────────

  /**
   * 批量取「文件 → 上次扫描时的 mtime/size」。
   *
   * 供 importer 在**读文件之前**判断能不能跳过 —— 这是完整扫描最大的优化点：
   * 实测 claude 111 个文件读全文要 1809ms，而 stat 全部只要 1ms。
   */
  getScannedFileStates(
    paths: string[],
  ): Map<string, { mtime: number; size: number }> {
    const out = new Map<string, { mtime: number; size: number }>();
    if (paths.length === 0) return out;
    // SQLite 变量上限 999 → 分批
    const CHUNK = 500;
    for (let i = 0; i < paths.length; i += CHUNK) {
      const slice = paths.slice(i, i + CHUNK);
      const marks = slice.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT path, mtime, size FROM scanned_files WHERE path IN (${marks})`)
        .all(...slice) as Row[];
      for (const r of rows) {
        out.set(r.path as string, {
          mtime: r.mtime as number,
          size: r.size as number,
        });
      }
    }
    return out;
  }

  /** 记录一批文件已扫描（幂等 upsert）。 */
  markFilesScanned(entries: Array<{ path: string; mtime: number; size: number }>): void {
    if (entries.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO scanned_files (path, mtime, size, scanned_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, scanned_at = excluded.scanned_at`,
    );
    for (const e of entries) stmt.run(e.path, e.mtime, e.size, now);
  }

  /** 清掉一批文件的增量索引（文件已不存在时用，避免索引无限增长）。 */
  forgetScannedFiles(paths: string[]): void {
    if (paths.length === 0) return;
    const CHUNK = 500;
    for (let i = 0; i < paths.length; i += CHUNK) {
      const slice = paths.slice(i, i + CHUNK);
      const marks = slice.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM scanned_files WHERE path IN (${marks})`).run(...slice);
    }
  }

  /** 增量索引的规模（诊断用）。 */
  getScannedFileCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM scanned_files').get() as Row | undefined;
    return (r?.n as number) ?? 0;
  }


  // ─── 通用 KV（daemon 状态、一次性标记等）────────────────────────────

  /** 读一个元数据值（表已在构造时建好，见 schema_meta）。 */
  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as
      | Row
      | undefined;
    return r ? ((r.value as string) ?? null) : null;
  }

  /** 写一个元数据值（幂等）。 */
  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)')
      .run(key, value);
  }

  // ─── 压缩：回收历史 revision 正文 + 重建检索索引 ──────────────────────

  /** 只读评估：有多少历史副本可回收（`ymesh compact --dry-run`）。 */
  compactAnalyze(): CompactAnalysis {
    const store = this.countSupersededRevisionStore();
    const ftsRows = (
      this.db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as Row
    ).n as number;
    const totalRows = (
      this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as Row
    ).n as number;
    const pageInfo = this.db.prepare('PRAGMA page_count').get() as Row | undefined;
    const freeInfo = this.db.prepare('PRAGMA freelist_count').get() as Row | undefined;
    const pageSize = this.db.prepare('PRAGMA page_size').get() as Row | undefined;
    const pageCount = (pageInfo?.page_count as number) ?? 0;
    const freeCount = (freeInfo?.freelist_count as number) ?? 0;
    const pageBytes = (pageSize?.page_size as number) ?? 4096;
    return {
      revisionBodyMode: this.getRevisionBodyMode(),
      sessionsWithSupersededRevisions: store.sessions,
      prunableRevisionRows: store.rows,
      messageRowsTotal: totalRows,
      liveMessageRows: Math.max(0, totalRows - store.rows),
      ftsRows,
      orphanRows: this.countOrphanRows(),
      dbBytes: pageCount * pageBytes,
      freeBytes: freeCount * pageBytes,
    };
  }

  /**
   * 执行压缩。默认**只做增量回收**（触发器在位，逐 session 按索引删除）。
   *
   * 大库一次性回收（几十万行以上）必须用 `rebuildFts`：
   * 走触发器逐行删 FTS 是 O(删除行数 × FTS 查找)，而重建 FTS 的成本只和
   * **存活 rows** 成正比（清理后通常只剩 2%~3%）。
   *
   * @param options.sessionLimit 每批处理的 session 数（控制单次事务大小）
   * @param options.budgetMs     时间预算，超出即返回（daemon 定时任务用）
   * @param options.rebuildFts   先 DROP FTS（连带触发器）再重建 + 回填
   * @param options.vacuum       结束时 VACUUM 归还磁盘（需要无其他写事务）
   */
  compactApply(options: CompactOptions = {}): CompactReport {
    const started = Date.now();
    const sessionLimit = options.sessionLimit ?? 200;
    const budgetMs = options.budgetMs ?? Number.POSITIVE_INFINITY;
    const rebuildFts = options.rebuildFts ?? false;
    let deletedRows = 0;
    let ftsRebuilt = false;
    let ftsBackfilled = 0;

    if (rebuildFts) {
      // 关掉触发器并丢掉 FTS：大批量删除不再逐行走 FTS
      options.onPhase?.('prune');
      this.db.exec('DROP TRIGGER IF EXISTS messages_fts_ai');
      this.db.exec('DROP TRIGGER IF EXISTS messages_fts_ad');
      this.db.exec('DROP TRIGGER IF EXISTS messages_fts_au');
      this.db.exec('DROP TABLE IF EXISTS messages_fts');
      ftsRebuilt = true;
    }

    // 分批回收历史 revision 正文
    for (;;) {
      const n = this.pruneSupersededRevisionBodiesBatch(sessionLimit);
      deletedRows += n;
      if (n === 0) break;
      if (Date.now() - started > budgetMs) break;
    }

    // 孤儿行：老版本 retain 用自己的连接删 session 时没开外键，留下了
    // 「session 已不存在」的 messages / session_revisions（线上实测 3.3 万行）。
    // 它们在任何查询里都看不见（全都 JOIN sessions），但一直占空间。
    options.onPhase?.('purge-orphans');
    const purgedOrphanRows = this.purgeOrphanRows();

    if (ftsRebuilt) {
      // 重建 FTS + 触发器（在删除之后：这样回填量只和存活消息量成正比）
      options.onPhase?.('rebuild-fts');
      this.db.exec(SCHEMA_FTS);
      this.setMeta('fts_version', FTS_SCHEMA_VERSION);
      this.ftsNeedsBackfill = false;
      // 回填（同样分批，避免单事务过大）
      options.onPhase?.('backfill-fts');
      for (;;) {
        const before = this.countFtsRows();
        this.syncFtsBatch(5000);
        const after = this.countFtsRows();
        ftsBackfilled += after - before;
        if (after === before) break;
      }
    }

    if (options.vacuum) {
      options.onPhase?.('vacuum');
      // VACUUM 不能在事务里跑；先合并 WAL，再整体重建文件。
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // 有并发读时 checkpoint 可能拿不到写锁，不阻塞后续 VACUUM 尝试
      }
      this.db.exec('VACUUM');
    }

    return {
      revisionBodyMode: this.getRevisionBodyMode(),
      deletedRevisionRows: deletedRows,
      purgedOrphanRows,
      ftsRebuilt,
      ftsBackfilled,
      vacuumed: options.vacuum ?? false,
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * 库文件体积与空闲页（O(1)，走 PRAGMA，不进全表扫描）。
   *
   * 为什么不直接 stat 文件：WAL 里可能还有没合并的页，而且「空闲页」才是
   * 「空间没还给磁盘」的信号（删了行但没 VACUUM 时 free 会很大）。
   */
  dbSizeInfo(): { dbBytes: number; freeBytes: number } {
    const pageInfo = this.db.prepare('PRAGMA page_count').get() as Row | undefined;
    const freeInfo = this.db.prepare('PRAGMA freelist_count').get() as Row | undefined;
    const pageSize = this.db.prepare('PRAGMA page_size').get() as Row | undefined;
    const pageCount = (pageInfo?.page_count as number) ?? 0;
    const freeCount = (freeInfo?.freelist_count as number) ?? 0;
    const pageBytes = (pageSize?.page_size as number) ?? 4096;
    return { dbBytes: pageCount * pageBytes, freeBytes: freeCount * pageBytes };
  }

  /**
   * 清掉孤儿行：session_id 指向已不存在的 session 的 messages / session_revisions /
   * message_tool_calls。
   *
   * 来源：老版本 `retain apply` 用自己的连接直接 `DELETE FROM sessions`，
   * 而那个连接没开 PRAGMA foreign_keys，于是既不级联也不报错。
   * 这些行任何查询都看不见（全部 JOIN sessions），属于纯占空间。
   */
  purgeOrphanRows(): number {
    let removed = 0;
    this.db.exec('BEGIN');
    try {
      const t = this.db
        .prepare(
          'DELETE FROM message_tool_calls WHERE session_id NOT IN (SELECT id FROM sessions)',
        )
        .run();
      removed += Number(t.changes);
      // messages 删除会通过触发器同步清理 FTS（v3 起按 rowid，O(1)）
      const m = this.db
        .prepare('DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)')
        .run();
      removed += Number(m.changes);
      const r = this.db
        .prepare('DELETE FROM session_revisions WHERE session_id NOT IN (SELECT id FROM sessions)')
        .run();
      removed += Number(r.changes);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return removed;
  }

  /** 孤儿行统计（只读） */
  countOrphanRows(): number {
    const m = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)')
      .get() as Row;
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM session_revisions WHERE session_id NOT IN (SELECT id FROM sessions)',
      )
      .get() as Row;
    return ((m.n as number) ?? 0) + ((r.n as number) ?? 0);
  }

  /** FTS 当前行数（诊断用） */
  countFtsRows(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as Row).n as number;
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

  /**
   * 解析「最后活动时间」——adapter 没显式给 fileModifiedAt 时的兜底。
   *
   * 为什么不能直接用 Date.now()：那是**扫描时间**。DB 类数据源（hermes /
   * opencode / cass / trae-ide）没有文件 mtime，旧实现于是把「ymesh 什么时候
   * 扫到它」当成了「它什么时候活跃」。后果实测过：
   *   · 一次全量扫描（reimport --force）之后，活跃列表从 3 个涨到 66 个
   *   · 晨报的「今天有哪些 agent 在干活」被历史会话灌满
   *   · 投递器判 idle 也用这个字段 → 刚扫过的死会话被当成"还在忙"
   *
   * 现在改成：adapter 给了就用它的（文件 mtime 最准）；没给就用**消息里最大的
   * 时间戳**——「最后一次说话」才是这个 session 真实的活跃时刻。
   * 时间戳按秒给的源（少数 adapter）会被归一成毫秒；未来时间戳按 now 处理。
   */
  private resolveLastActivity(input: SessionIngestInput, now: number): number {
    if (input.fileModifiedAt !== undefined) return input.fileModifiedAt;
    // 2001-01-01 之前的"时间戳"对 agent 会话没有意义（测试桩/脏数据里常见
    // timestamp: 1），当作无效，避免把历史时间算成活跃时间。
    const MIN_VALID_MS = Date.UTC(2001, 0, 1);
    let maxTs = 0;
    for (const m of input.messages) {
      const ts = m.timestamp;
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
      // 秒级时间戳（< 1e12）归一成毫秒
      const ms = ts < 1_000_000_000_000 ? Math.round(ts * 1000) : Math.round(ts);
      if (ms < MIN_VALID_MS) continue;
      if (ms > maxTs) maxTs = ms;
    }
    if (maxTs === 0) return now; // 一条带时间的消息都没有：只能退回扫描时间
    return Math.min(maxTs, now); // 未来时间戳（时钟漂移/脏数据）按 now 处理
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

  /** 批量插入某 revision 的消息快照（含结构化 toolCalls） */
  private insertMessages(sessionId: string, revisionId: number, messages: SessionMessageInput[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO messages (session_id, revision_id, seq, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tcStmt = this.db.prepare(
      'INSERT OR IGNORE INTO message_tool_calls (message_id, session_id, call_seq, tool_name, tool_input) VALUES (?, ?, ?, ?, ?)',
    );
    messages.forEach((m, i) => {
      const r = stmt.run(sessionId, revisionId, i, m.role, m.content, m.timestamp ?? null);
      if (m.toolCalls && m.toolCalls.length > 0) {
        const messageId = Number(r.lastInsertRowid);
        for (const tc of m.toolCalls) {
          tcStmt.run(messageId, sessionId, tc.callSeq, tc.toolName, tc.toolInput ?? null);
        }
      }
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
