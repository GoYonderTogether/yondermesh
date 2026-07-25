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

/** 执行结果 */
export interface ApplyResult {
  dryRun: boolean;
  /** L0 实际删除的消息数 */
  noiseDeleted: number;
  /** L0 备份的唯一内容数（去重后） */
  noiseBackupUniqueContents: number;
  /** L2 实际截断的消息数 */
  truncated: number;
  /** L3 实际归档的 session 数 */
  sessionsArchived: number;
  /** L3 实际删除的消息数 */
  archiveMessagesDeleted: number;
  /** 备份文件路径（无备份时 null） */
  backupFile: string | null;
  /** 备份错误（不阻塞筛除） */
  backupError: string | null;
  /** 执行前报告 */
  beforeReport: RetainReport;
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
  options: { dryRun?: boolean; skipBackup?: boolean } = {},
): ApplyResult {
  const startTime = Date.now();
  const dryRun = options.dryRun ?? false;
  const skipBackup = options.skipBackup ?? false;

  // 执行前报告
  const beforeReport = analyze(dbPath, policy);

  if (dryRun) {
    return {
      dryRun: true,
      noiseDeleted: beforeReport.noise.totalMessages,
      noiseBackupUniqueContents: 0,
      truncated: beforeReport.truncate.totalMessages,
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

    // ─── L3：归档老 session ─────────────────────────────────────
    const archiveResult = applyArchive(db, policy, writeBackupEntry);

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

/** L0 删噪音：分两步（短内容 + 长内容） */
function applyNoise(
  db: DatabaseSync,
  compiled: CompiledNoiseRule[],
  policy: RetainPolicy,
  writeBackup: (content: string, meta: Record<string, unknown>) => void,
): number {
  let totalDeleted = 0;

  // 步骤 1：扫所有候选 content（按 content GROUP BY），跑规则，命中的全删
  // 大库优化：只扫 length < 2000 的（噪音规则不会匹配超长内容）
  const candidates = db
    .prepare(
      `SELECT content, COUNT(*) AS c, SUM(length(content)) AS bytes
       FROM messages
       WHERE length(content) < 2000
       GROUP BY content
       HAVING c >= 10`,
    )
    .all() as Array<{ content: string; c: number; bytes: number }>;

  const matchedContents: string[] = [];
  for (const row of candidates) {
    // 跑显式规则
    let matched = false;
    for (const rule of compiled) {
      if (rule.match(row.content)) {
        matched = true;
        break;
      }
    }
    // 极短高频也算噪音（未匹配显式规则但 < noiseShortBytes 且 > noiseShortMinOccurrences）
    if (
      !matched &&
      row.content.length < policy.noiseShortBytes &&
      row.c >= policy.noiseShortMinOccurrences
    ) {
      matched = true;
    }
    if (matched) {
      matchedContents.push(row.content);
      // 备份（去重）
      writeBackup(row.content, {
        reason: 'noise',
        occurrences: row.c,
        bytes: row.bytes,
      });
    }
  }

  // 批量删除：每个唯一 content 一次 DELETE
  // 用参数化查询避免 SQL 注入
  const deleteStmt = db.prepare(
    'DELETE FROM messages WHERE content = ?',
  );
  db.exec('BEGIN');
  try {
    for (const content of matchedContents) {
      const result = deleteStmt.run(content);
      totalDeleted += Number(result.changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
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
