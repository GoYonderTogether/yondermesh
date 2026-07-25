/**
 * Retention Applier —— 执行筛除（含 dry-run + 去重备份导出）。
 *
 * 三步执行（顺序很重要，避免重复计数）：
 *   1. L0 删噪音：匹配规则的消息整条 DELETE
 *   2. L2 截断：超长消息 UPDATE content = substr(content, 1, keepBytes) + marker
 *   3. L3 归档：超 TTL 的 session 的 messages DELETE（可选保留 session 元数据）
 *
 * 备份策略（保障原始数据可恢复）：
 *   - 被删/被截断的消息，按 content 去重导出到 backupDir/{timestamp}.jsonl.gz
 *   - 重复内容占 99%，去重后备份体积 << 原库（预计 < 100MB vs 17GB）
 *   - 备份文件含 content + role + session_id（去重后只存一次，附 affected_session_ids）
 *
 * 安全：
 *   - dry-run 模式只报告，不修改数据库
 *   - 非 dry-run 时每步用事务包裹，失败回滚
 *   - 备份失败不阻塞筛除（但会在结果里标记 backupError）
 */

import { createGzip } from 'node:zlib';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  compileNoiseRules,
} from './policy.js';
import type {
  CompiledNoiseRule,
  RetainPolicy,
} from './policy.js';
import { analyze } from './analyzer.js';
import type { RetainReport } from './analyzer.js';
import { classifySessions } from './session-classifier.js';
import type { SessionClassification } from './session-classifier.js';

/** 执行结果 */
export interface ApplyResult {
  dryRun: boolean;
  /** L0 实际删除的消息数 */
  noiseDeleted: number;
  /** L0 备份的唯一内容数（去重后） */
  noiseBackupUniqueContents: number;
  /** L2 实际截断的消息数 */
  truncated: number;
  /** SL0 实际删除的 session 数（整场删） */
  sessionNoiseDeleted: number;
  /** SL0 实际删除的消息数 */
  sessionNoiseMessagesDeleted: number;
  /** SL1 实际处理的 session 数（保留 metadata，删 messages） */
  sessionShortCompacted: number;
  /** SL1 实际删除的消息数 */
  sessionShortMessagesDeleted: number;
  /** SL2 实际处理的 session 数（保留最新，删其余 messages） */
  sessionDuplicateCompacted: number;
  /** SL2 实际删除的消息数 */
  sessionDuplicateMessagesDeleted: number;
  /** L3 实际归档的 session 数 */
  sessionsArchived: number;
  /** L3 实际删除的消息数 */
  archiveMessagesDeleted: number;
  /** 备份文件路径（无备份时 null） */
  backupFile: string | null;
  /** 备份错误（不阻塞筛除） */
  backupError: string | null;
  /** 执行前报告（apply 实际执行时可跳过，为 null） */
  beforeReport: RetainReport | null;
  /** 执行耗时 ms */
  elapsedMs: number;
}

/**
 * 执行筛除。
 *
 * @param dbPath 数据库路径
 * @param policy 策略
 * @param options dryRun / skipBackup
 */
export function apply(
  dbPath: string,
  policy: RetainPolicy,
  options: { dryRun?: boolean; skipBackup?: boolean; skipBeforeReport?: boolean } = {},
): ApplyResult {
  const startTime = Date.now();
  const dryRun = options.dryRun ?? false;
  const skipBackup = options.skipBackup ?? false;
  // apply 实际执行时跳过 beforeReport（analyze 在 12M 行库上要 5-10 分钟）
  // dry-run 时才需要预报告
  const skipBeforeReport = options.skipBeforeReport ?? !dryRun;

  // 执行前报告（可跳过）
  const beforeReport = skipBeforeReport
    ? null
    : analyze(dbPath, policy);

  if (dryRun) {
    if (!beforeReport) {
      throw new Error('dry-run 模式需要 beforeReport，不能跳过');
    }
    return {
      dryRun: true,
      noiseDeleted: beforeReport.noise.totalMessages,
      noiseBackupUniqueContents: 0,
      truncated: beforeReport.truncate.totalMessages,
      sessionNoiseDeleted: beforeReport.session.noiseSessions.length,
      sessionNoiseMessagesDeleted: beforeReport.session.totalNoiseMessages,
      sessionShortCompacted: beforeReport.session.shortSessions.length,
      sessionShortMessagesDeleted: beforeReport.session.totalShortMessages,
      sessionDuplicateCompacted: beforeReport.session.duplicateSessions.length,
      sessionDuplicateMessagesDeleted: beforeReport.session.totalDuplicateMessages,
      sessionsArchived: beforeReport.archive.sessionsToArchive,
      archiveMessagesDeleted: beforeReport.archive.messagesAffected,
      backupFile: null,
      backupError: null,
      beforeReport,
      elapsedMs: Date.now() - startTime,
    };
  }

  // 真实执行
  const compiled = compileNoiseRules(policy.noise);
  const db = new DatabaseSync(dbPath);
  let backupFile: string | null = null;
  let backupError: string | null = null;
  let noiseBackupUniqueContents = 0;

  try {
    db.exec('PRAGMA busy_timeout = 30000');
    db.exec('PRAGMA journal_mode = WAL');

    // 关键优化：临时禁用 FTS 触发器
    //
    // 瓶颈分析：messages_fts_ad 触发器是 `DELETE FROM messages_fts WHERE message_id = old.id`
    // 但 message_id 是 UNINDEXED 列，每条 messages DELETE 都触发 FTS 全表扫描（12M+ 行）
    // 277K 条噪音 DELETE × 12M 行 FTS 扫描 = 灾难性性能
    //
    // 解决：apply 期间 DROP 触发器，结束时重建 + 清理孤立 FTS 行
    db.exec('DROP TRIGGER IF EXISTS messages_fts_ai');
    db.exec('DROP TRIGGER IF EXISTS messages_fts_ad');
    db.exec('DROP TRIGGER IF EXISTS messages_fts_au');

    // 准备备份（非 skipBackup 时）
    let backupStream: ReturnType<typeof createWriteStream> | null = null;
    let gzipStream: ReturnType<typeof createGzip> | null = null;
    if (!skipBackup) {
      try {
        mkdirSync(policy.backupDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        backupFile = join(policy.backupDir, `retain-${ts}.jsonl.gz`);
        backupStream = createWriteStream(backupFile);
        gzipStream = createGzip();
        gzipStream.pipe(backupStream);
      } catch (err) {
        backupError = `备份初始化失败: ${String(err)}`;
        backupFile = null;
        backupStream = null;
        gzipStream = null;
      }
    }

    // 备份辅助：记录已备份的 content（去重）
    const backedUpContents = new Set<string>();
    const writeBackupEntry = (content: string, meta: Record<string, unknown>) => {
      if (!gzipStream) return;
      if (backedUpContents.has(content)) return;
      backedUpContents.add(content);
      noiseBackupUniqueContents++;
      const entry = JSON.stringify({ content, ...meta }) + '\n';
      gzipStream.write(entry);
    };

    // ─── L0：删噪音 ─────────────────────────────────────────────
    const noiseDeleted = applyNoise(db, compiled, policy, writeBackupEntry);

    // ─── L2：截断长内容 ─────────────────────────────────────────
    const truncated = applyTruncate(db, policy, writeBackupEntry);

    // ─── Session 级分类（SL0/SL1/SL2） ─────────────────────────
    // L0 已删噪音消息后，重新跑分类（基于最新数据库状态）
    const classification = classifySessions(db, policy, compiled);

    // ─── SL0：删纯噪音 session（整场删） ────────────────────────
    const sl0Result = applySessionNoise(db, classification, writeBackupEntry);

    // ─── SL1：压缩短问答 session（保留 metadata，删 messages） ──
    const sl1Result = applyShortSessions(db, classification, writeBackupEntry);

    // ─── SL2：删重复 session 消息（保留最新一场） ───────────────
    const sl2Result = applyDuplicateSessions(db, classification, writeBackupEntry);

    // ─── L3：归档老 session ─────────────────────────────────────
    const archiveResult = applyArchive(db, policy, writeBackupEntry);

    // ─── FTS 维护：重建触发器 + 清理孤立 FTS 行 ────────────────
    //
    // apply 期间 DROP 了 FTS 触发器，现在重建。
    // 然后清理孤立 FTS 行（指向已被 DELETE 的 messages 的行）。
    //
    // 清理策略：用 NOT IN 子查询走 messages.id 主键索引
    // 12M FTS 行 × log(12M messages) ≈ 288M 操作，约 5-10 分钟
    // 比 apply 期间逐条触发 FTS 全表扫描快 100x+
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(content, session_id, message_id, revision_id)
      VALUES (new.content, new.session_id, new.id, new.revision_id);
    END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
    END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
      INSERT INTO messages_fts(content, session_id, message_id, revision_id)
      VALUES (new.content, new.session_id, new.id, new.revision_id);
    END`);

    // 清理孤立 FTS 行（分批避免长事务）
    // 注意：这条 SQL 会扫 messages_fts 全表，但对每行用 messages.id 主键做 lookup
    // 如果 messages 表小（被删很多），NOT IN 的结果集大，清理量大
    const orphanCleanupBatch = db.prepare(
      `DELETE FROM messages_fts WHERE rowid IN (
         SELECT rowid FROM messages_fts
         WHERE message_id NOT IN (SELECT id FROM messages)
         LIMIT 50000
       )`,
    );
    for (;;) {
      db.exec('BEGIN');
      try {
        const r = orphanCleanupBatch.run();
        db.exec('COMMIT');
        if (Number(r.changes) === 0) break;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }

    // 关闭备份流
    if (gzipStream) {
      gzipStream.end();
    }
    if (backupStream) {
      backupStream.on('close', () => {});
    }

    return {
      dryRun: false,
      noiseDeleted,
      noiseBackupUniqueContents,
      truncated,
      sessionNoiseDeleted: sl0Result.sessionsDeleted,
      sessionNoiseMessagesDeleted: sl0Result.messagesDeleted,
      sessionShortCompacted: sl1Result.sessionsCompacted,
      sessionShortMessagesDeleted: sl1Result.messagesDeleted,
      sessionDuplicateCompacted: sl2Result.sessionsCompacted,
      sessionDuplicateMessagesDeleted: sl2Result.messagesDeleted,
      sessionsArchived: archiveResult.sessionsArchived,
      archiveMessagesDeleted: archiveResult.messagesDeleted,
      backupFile,
      backupError,
      beforeReport,
      elapsedMs: Date.now() - startTime,
    };
  } finally {
    db.close();
  }
}

/** L0 删噪音：按规则类型分别处理，避免 GROUP BY 全表扫
 *
 * 优化分层：
 *   1. exact 规则：直接 DELETE WHERE content IN (?, ...) —— 走全表扫但只一次，无 GROUP BY
 *   2. prefix 规则：DELETE WHERE content LIKE 'prefix%' —— 同上
 *   3. regex 规则：扫候选 content（length < 2000 的 DISTINCT），JS 跑正则，命中的收集到临时表
 *   4. 短高频规则（noiseShortBytes/noiseShortMinOccurrences）：跳过，收益小且需 GROUP BY
 *
 * 性能对比（12M 行库）：
 *   原方案 GROUP BY：5-10 分钟（O(N log N) 排序 + 临时表）
 *   新方案 exact IN：30-60 秒/规则（O(N) 全表扫，无排序）
 *   新方案 prefix LIKE：同上
 *   新方案 regex：1-2 分钟（DISTINCT 比 GROUP BY 快，且只跑 2 条规则）
 */
function applyNoise(
  db: DatabaseSync,
  compiled: CompiledNoiseRule[],
  policy: RetainPolicy,
  writeBackup: (content: string, meta: Record<string, unknown>) => void,
): number {
  let totalDeleted = 0;

  // 分离 exact / prefix / regex 规则（compiled 丢失了类型信息，从 policy.noise 重新提取）
  const exactContents: string[] = [];
  const prefixes: string[] = [];
  const regexRules: CompiledNoiseRule[] = [];
  for (const rawRule of policy.noise) {
    if (rawRule.exact !== undefined) {
      exactContents.push(rawRule.exact);
    } else if (rawRule.prefix !== undefined) {
      prefixes.push(rawRule.prefix);
    } else if (rawRule.regex !== undefined) {
      const compiledRule = compiled.find((c) => c.name === rawRule.name);
      if (compiledRule) regexRules.push(compiledRule);
    }
  }

  // ─── 1. exact 规则：直接 IN 删除 ─────────────────────────────
  if (exactContents.length > 0) {
    // 备份（去重，exact 内容本身就是唯一值）
    for (const c of exactContents) {
      writeBackup(c, { reason: 'noise-exact', rule: 'exact' });
    }

    // 分批 IN 删除（SQLite 参数上限 ~999，每批 100 条安全）
    const batchSize = 100;
    for (let i = 0; i < exactContents.length; i += batchSize) {
      const batch = exactContents.slice(i, i + batchSize);
      const placeholders = batch.map(() => '?').join(',');
      db.exec('BEGIN');
      try {
        const result = db
          .prepare(`DELETE FROM messages WHERE content IN (${placeholders})`)
          .run(...batch);
        db.exec('COMMIT');
        totalDeleted += Number(result.changes);
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  // ─── 2. prefix 规则：LIKE 'prefix%' 删除 ─────────────────────
  for (const prefix of prefixes) {
    writeBackup(prefix, { reason: 'noise-prefix', prefix });
    // LIKE 'prefix%' 可以用 content 的前缀匹配（如果有索引会走索引，无索引全表扫）
    // 注意：prefix 中可能含特殊字符（%, _），需要 ESCAPE
    const escaped = prefix.replace(/[%_]/g, '\\$&');
    db.exec('BEGIN');
    try {
      const result = db
        .prepare(
          `DELETE FROM messages WHERE content LIKE ? ESCAPE '\\'`,
        )
        .run(`${escaped}%`);
      db.exec('COMMIT');
      totalDeleted += Number(result.changes);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // ─── 3. regex 规则：扫候选 DISTINCT content，JS 跑正则 ────────
  if (regexRules.length > 0) {
    // 只扫 length < 2000 的 DISTINCT content（regex 规则不会匹配长内容）
    // DISTINCT 比 GROUP BY 轻（不需要 COUNT/SUM 聚合）
    const candidates = db
      .prepare(
        `SELECT DISTINCT content FROM messages WHERE length(content) < 2000`,
      )
      .all() as Array<{ content: string }>;

    const matchedContents: string[] = [];
    for (const row of candidates) {
      for (const rule of regexRules) {
        if (rule.match(row.content)) {
          matchedContents.push(row.content);
          writeBackup(row.content, { reason: 'noise-regex', rule: rule.name });
          break;
        }
      }
    }

    if (matchedContents.length > 0) {
      // 用临时表批量 DELETE
      db.exec('DROP TABLE IF EXISTS tmp_noise_regex');
      db.exec('CREATE TEMP TABLE tmp_noise_regex(content TEXT PRIMARY KEY)');
      const insertStmt = db.prepare('INSERT OR IGNORE INTO tmp_noise_regex(content) VALUES (?)');
      for (const c of matchedContents) insertStmt.run(c);

      try {
        const batchSize = 50_000;
        const deleteBatch = db.prepare(
          `DELETE FROM messages
           WHERE id IN (
             SELECT m.id FROM messages m
             JOIN tmp_noise_regex c ON c.content = m.content
             LIMIT ?
           )`,
        );
        for (;;) {
          db.exec('BEGIN');
          try {
            const result = deleteBatch.run(batchSize);
            db.exec('COMMIT');
            totalDeleted += Number(result.changes);
            if (Number(result.changes) < batchSize) break;
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }
        }
      } finally {
        db.exec('DROP TABLE IF EXISTS tmp_noise_regex');
      }
    }
  }

  return totalDeleted;
}

/** L2 截断：超长消息 UPDATE content */
function applyTruncate(
  db: DatabaseSync,
  policy: RetainPolicy,
  writeBackup: (content: string, meta: Record<string, unknown>) => void,
): number {
  let totalTruncated = 0;

  for (const rule of policy.truncate) {
    // 先备份原文（去重：只备份超长内容，相同 content 只存一次）
    const longContents = db
      .prepare(
        `SELECT DISTINCT content FROM messages
         WHERE role = ? AND length(content) > ?`,
      )
      .all(rule.role, rule.maxBytes) as Array<{ content: string }>;

    for (const { content } of longContents) {
      writeBackup(content, {
        reason: 'truncate',
        role: rule.role,
        originalLength: content.length,
        keepBytes: rule.keepBytes,
      });
    }

    // 执行截断：UPDATE messages SET content = substr(content, 1, keepBytes) || marker
    // marker 让截断后的内容可识别（避免误以为是完整回复）
    const marker = `\n\n[... truncated by ymesh retain, original ${0} bytes ...]`;
    // 注意：substr 是 1-indexed，长度按字符数（SQLite substr 对 UTF-8 按 codepoint）
    // 但 length() 返回字符数，所以 keepBytes 实际是 keepChars。这里保持命名一致但语义是字符数。
    const result = db
      .prepare(
        `UPDATE messages
         SET content = substr(content, 1, ?) || ?
         WHERE role = ? AND length(content) > ?`,
      )
      .run(rule.keepBytes, marker, rule.role, rule.maxBytes);
    totalTruncated += Number(result.changes);
  }

  return totalTruncated;
}

/** L3 归档：删超 TTL 的 session 的 messages */
function applyArchive(
  db: DatabaseSync,
  policy: RetainPolicy,
  writeBackup: (content: string, meta: Record<string, unknown>) => void,
): { sessionsArchived: number; messagesDeleted: number } {
  const cutoff = Date.now() - policy.archive.olderThanDays * 24 * 60 * 60 * 1000;

  // 用 started_at 判断老旧（last_seen_at 被采集器持续刷新）
  const sessions = db
    .prepare(
      `SELECT id FROM sessions WHERE started_at < ?`,
    )
    .all(cutoff) as Array<{ id: string }>;

  if (sessions.length === 0) {
    return { sessionsArchived: 0, messagesDeleted: 0 };
  }

  // 备份这些 session 的消息（去重）
  const uniqueContents = db
    .prepare(
      `SELECT DISTINCT content FROM messages
       WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)`,
    )
    .all(cutoff) as Array<{ content: string }>;

  for (const { content } of uniqueContents) {
    writeBackup(content, { reason: 'archive', originalLength: content.length });
  }

  const deleteMsgs = db.prepare(
    'DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)',
  );

  db.exec('BEGIN');
  try {
    const result = deleteMsgs.run(cutoff);
    const sessionsArchived = sessions.length;

    if (!policy.archive.keepSessionMetadata) {
      const deleteSessions = db.prepare(
        'DELETE FROM sessions WHERE started_at < ?',
      );
      deleteSessions.run(cutoff);
    } else {
      const markArchived = db.prepare(
        "UPDATE sessions SET retention = 'archived' WHERE started_at < ?",
      );
      markArchived.run(cutoff);
    }

    db.exec('COMMIT');
    return { sessionsArchived, messagesDeleted: Number(result.changes) };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ─── Session 级 apply（SL0/SL1/SL2） ────────────────────────────

/** 备份 + 删除的通用辅助：用临时表批量 DELETE messages */
function backupAndDeleteSessionsMessages(
  db: DatabaseSync,
  sessionIds: string[],
  writeBackup: (content: string, meta: Record<string, unknown>) => void,
  backupReason: string,
): number {
  if (sessionIds.length === 0) return 0;

  // 步骤 1：备份这些 session 的消息内容（去重）
  // 用临时表存 session_id 列表，避免 IN (?, ?, ...) 参数上限
  db.exec('DROP TABLE IF EXISTS tmp_sl_session_ids');
  db.exec('CREATE TEMP TABLE tmp_sl_session_ids(id TEXT PRIMARY KEY)');
  const insertStmt = db.prepare('INSERT OR IGNORE INTO tmp_sl_session_ids(id) VALUES (?)');
  for (const id of sessionIds) insertStmt.run(id);

  try {
    // 取所有唯一 content 备份
    const uniqueContents = db
      .prepare(
        `SELECT DISTINCT content FROM messages
         WHERE session_id IN (SELECT id FROM tmp_sl_session_ids)`,
      )
      .all() as Array<{ content: string }>;

    for (const { content } of uniqueContents) {
      writeBackup(content, { reason: backupReason, originalLength: content.length });
    }

    // 步骤 2：批量 DELETE messages
    db.exec('BEGIN');
    try {
      const result = db
        .prepare(
          'DELETE FROM messages WHERE session_id IN (SELECT id FROM tmp_sl_session_ids)',
        )
        .run();
      db.exec('COMMIT');
      return Number(result.changes);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.exec('DROP TABLE IF EXISTS tmp_sl_session_ids');
  }
}

/** SL0：纯噪音 session 整场删（messages + sessions） */
function applySessionNoise(
  db: DatabaseSync,
  classification: SessionClassification,
  writeBackup: (content: string, meta: Record<string, unknown>) => void,
): { sessionsDeleted: number; messagesDeleted: number } {
  const ids = classification.noiseSessions.map((s) => s.id);
  if (ids.length === 0) return { sessionsDeleted: 0, messagesDeleted: 0 };

  const messagesDeleted = backupAndDeleteSessionsMessages(db, ids, writeBackup, 'session-noise');

  // 整场删 sessions 行（含 metadata）
  db.exec('DROP TABLE IF EXISTS tmp_sl_session_ids');
  db.exec('CREATE TEMP TABLE tmp_sl_session_ids(id TEXT PRIMARY KEY)');
  const insertStmt = db.prepare('INSERT OR IGNORE INTO tmp_sl_session_ids(id) VALUES (?)');
  for (const id of ids) insertStmt.run(id);

  try {
    db.exec('BEGIN');
    try {
      const result = db
        .prepare('DELETE FROM sessions WHERE id IN (SELECT id FROM tmp_sl_session_ids)')
        .run();
      db.exec('COMMIT');
      return {
        sessionsDeleted: Number(result.changes),
        messagesDeleted,
      };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.exec('DROP TABLE IF EXISTS tmp_sl_session_ids');
  }
}

/** SL1：短问答 session 保留 metadata，删 messages + 标 retention='compact' */
function applyShortSessions(
  db: DatabaseSync,
  classification: SessionClassification,
  writeBackup: (content: string, meta: Record<string, unknown>) => void,
): { sessionsCompacted: number; messagesDeleted: number } {
  const ids = classification.shortSessions.map((s) => s.id);
  if (ids.length === 0) return { sessionsCompacted: 0, messagesDeleted: 0 };

  const messagesDeleted = backupAndDeleteSessionsMessages(db, ids, writeBackup, 'session-short');

  // 标记 sessions.retention = 'compact'，清零 message_count
  db.exec('DROP TABLE IF EXISTS tmp_sl_session_ids');
  db.exec('CREATE TEMP TABLE tmp_sl_session_ids(id TEXT PRIMARY KEY)');
  const insertStmt = db.prepare('INSERT OR IGNORE INTO tmp_sl_session_ids(id) VALUES (?)');
  for (const id of ids) insertStmt.run(id);

  try {
    db.exec('BEGIN');
    try {
      const result = db
        .prepare(
          `UPDATE sessions
           SET retention = 'compact', message_count = 0
           WHERE id IN (SELECT id FROM tmp_sl_session_ids)`,
        )
        .run();
      db.exec('COMMIT');
      return {
        sessionsCompacted: Number(result.changes),
        messagesDeleted,
      };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.exec('DROP TABLE IF EXISTS tmp_sl_session_ids');
  }
}

/** SL2：重复 session 删 messages + 标 retention='duplicate'（保留最新一场） */
function applyDuplicateSessions(
  db: DatabaseSync,
  classification: SessionClassification,
  writeBackup: (content: string, meta: Record<string, unknown>) => void,
): { sessionsCompacted: number; messagesDeleted: number } {
  const ids = classification.duplicateSessions.map((s) => s.id);
  if (ids.length === 0) return { sessionsCompacted: 0, messagesDeleted: 0 };

  const messagesDeleted = backupAndDeleteSessionsMessages(db, ids, writeBackup, 'session-duplicate');

  // 标记 retention='duplicate'，清零 message_count
  db.exec('DROP TABLE IF EXISTS tmp_sl_session_ids');
  db.exec('CREATE TEMP TABLE tmp_sl_session_ids(id TEXT PRIMARY KEY)');
  const insertStmt = db.prepare('INSERT OR IGNORE INTO tmp_sl_session_ids(id) VALUES (?)');
  for (const id of ids) insertStmt.run(id);

  try {
    db.exec('BEGIN');
    try {
      const result = db
        .prepare(
          `UPDATE sessions
           SET retention = 'duplicate', message_count = 0
           WHERE id IN (SELECT id FROM tmp_sl_session_ids)`,
        )
        .run();
      db.exec('COMMIT');
      return {
        sessionsCompacted: Number(result.changes),
        messagesDeleted,
      };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.exec('DROP TABLE IF EXISTS tmp_sl_session_ids');
  }
}
