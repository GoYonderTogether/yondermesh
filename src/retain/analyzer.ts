/**
 * Retention Analyzer —— 扫描数据库，报告可筛除/可截断/可归档的消息量。
 *
 * 只读不改。`ymesh retain analyze` 调用此模块。
 *
 * 三类报告：
 *   - L0 noise：匹配噪音规则的消息数 + 字节数
 *   - L2 truncate：超长消息数 + 可节省字节数
 *   - L3 archive：超 TTL 的 session 数 + 涉及消息数
 */

import { DatabaseSync } from 'node:sqlite';
import {
  compileNoiseRules,
} from './policy.js';
import type {
  CompiledNoiseRule,
  RetainPolicy,
} from './policy.js';
import { classifySessions } from './session-classifier.js';
import type { SessionClassification } from './session-classifier.js';

/** L0 噪音报告 */
export interface NoiseReport {
  /** 每条规则的命中消息数 */
  perRule: Array<{ name: string; messages: number; bytes: number }>;
  /** 极短高频内容的命中（< noiseShortBytes 且出现 > noiseShortMinOccurrences） */
  shortHighFreq: Array<{ content: string; occurrences: number; bytes: number }>;
  /** 总计可删除消息数 */
  totalMessages: number;
  /** 总计可释放字节数 */
  totalBytes: number;
}

/** L2 截断报告 */
export interface TruncateReport {
  /** 每条规则的命中消息数 + 可节省字节数 */
  perRule: Array<{
    role: string;
    maxBytes: number;
    keepBytes: number;
    messages: number;
    savedBytes: number;
  }>;
  totalMessages: number;
  totalSavedBytes: number;
}

/** L3 归档报告 */
export interface ArchiveReport {
  /** 超过 TTL 的 session 数 */
  sessionsToArchive: number;
  /** 涉及消息数 */
  messagesAffected: number;
  /** 涉及字节数 */
  bytesAffected: number;
  /** 最早 session 的 started_at */
  oldestStartedAt: number | null;
  /** TTL 截止时间戳（olderThanDays 之前） */
  cutoffTimestamp: number;
}

/** 完整报告 */
export interface RetainReport {
  databasePath: string;
  scannedAt: number;
  totalMessages: number;
  totalBytes: number;
  noise: NoiseReport;
  truncate: TruncateReport;
  archive: ArchiveReport;
  /** Session 级分类报告（SL0/SL1/SL2） */
  session: SessionClassification;
  /** 综合预期：筛除后剩余消息数 */
  projectedRemainingMessages: number;
  /** 综合预期：筛除后剩余字节数 */
  projectedRemainingBytes: number;
}

/**
 * 扫描数据库生成报告。
 *
 * 实现：用 SQL 预筛 + JS 精筛。
 * - SQL 负责按长度/role/时间粗筛出候选集（避免全表扫到 JS）
 * - JS 负责跑正则/前缀规则（SQLite 正则需 load extension，JS 更稳）
 *
 * 噪音扫描分两步：
 * 1. 按 content GROUP BY 拿到 (content, count) 对，长度 < noiseShortBytes 的全过一遍规则
 * 2. 长度 >= noiseShortBytes 但匹配 regex/prefix 规则的，单独扫一次
 *
 * 大库优化：content GROUP BY 会全表扫，但只取 (content, COUNT, SUM(length))，
 * 不取正文本身（除短内容），内存可控。
 */
export function analyze(
  dbPath: string,
  policy: RetainPolicy,
  compiled?: CompiledNoiseRule[],
): RetainReport {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const compiledRules = compiled ?? compileNoiseRules(policy.noise);

    // 总览
    const totalRow = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM messages) AS msg_count,
           (SELECT COALESCE(SUM(length(content)), 0) FROM messages) AS msg_bytes`,
      )
      .get() as { msg_count: number; msg_bytes: number };

    const noiseReport = scanNoise(db, policy, compiledRules);
    const truncateReport = scanTruncate(db, policy);
    const archiveReport = scanArchive(db, policy);

    // Session 级分类（SL0/SL1/SL2）—— 只读，但需要读写模式以建临时表
    // 改用 readOnly: false 重新打开（analyze 主连接是只读的）
    let sessionClassification: SessionClassification;
    const dbRw = new DatabaseSync(dbPath);
    try {
      dbRw.exec('PRAGMA busy_timeout = 5000');
      dbRw.exec('PRAGMA journal_mode = WAL');
      sessionClassification = classifySessions(dbRw, policy, compiledRules);
    } finally {
      dbRw.close();
    }

    // 综合预期（保守估计：各层独立累加，实际有重叠会少删一些）
    // 顺序：L0 删噪音 → L2 截断 → SL0 整场删 → SL1 删短 session 消息 → SL2 删重复 → L3 归档
    const afterNoiseMessages =
      totalRow.msg_count - noiseReport.totalMessages;
    const afterNoiseBytes = totalRow.msg_bytes - noiseReport.totalBytes;
    const projectedRemainingMessages = Math.max(
      0,
      afterNoiseMessages -
        truncateReport.totalMessages -
        sessionClassification.totalNoiseMessages -
        sessionClassification.totalShortMessages -
        sessionClassification.totalDuplicateMessages -
        archiveReport.messagesAffected,
    );
    const projectedRemainingBytes = Math.max(
      0,
      afterNoiseBytes -
        truncateReport.totalSavedBytes -
        sessionClassification.totalNoiseBytes -
        sessionClassification.totalShortBytes -
        sessionClassification.totalDuplicateBytes -
        archiveReport.bytesAffected,
    );

    return {
      databasePath: dbPath,
      scannedAt: Date.now(),
      totalMessages: totalRow.msg_count,
      totalBytes: totalRow.msg_bytes,
      noise: noiseReport,
      truncate: truncateReport,
      archive: archiveReport,
      session: sessionClassification,
      projectedRemainingMessages,
      projectedRemainingBytes,
    };
  } finally {
    db.close();
  }
}

/** L0 噪音扫描 */
function scanNoise(
  db: DatabaseSync,
  policy: RetainPolicy,
  compiled: CompiledNoiseRule[],
): NoiseReport {
  const perRule = new Map<string, { messages: number; bytes: number }>();

  // 步骤 1：扫短内容（< noiseShortBytes），按 content GROUP BY
  // 这些内容少且小，全取到 JS 里跑规则
  const shortRows = db
    .prepare(
      `SELECT content, COUNT(*) AS c, SUM(length(content)) AS bytes
       FROM messages
       WHERE length(content) < ?
       GROUP BY content
       HAVING c >= ?`,
    )
    .all(policy.noiseShortBytes, 1) as Array<{
    content: string;
    c: number;
    bytes: number;
  }>;

  const shortHighFreq: Array<{ content: string; occurrences: number; bytes: number }> = [];

  for (const row of shortRows) {
    // 先跑显式规则
    let matched = false;
    for (const rule of compiled) {
      if (rule.match(row.content)) {
        const prev = perRule.get(rule.name) ?? { messages: 0, bytes: 0 };
        perRule.set(rule.name, {
          messages: prev.messages + row.c,
          bytes: prev.bytes + row.bytes,
        });
        matched = true;
        break; // 一条消息只算一次
      }
    }
    // 未匹配显式规则但高频 → 归入 shortHighFreq
    if (!matched && row.c >= policy.noiseShortMinOccurrences) {
      shortHighFreq.push({
        content: row.content,
        occurrences: row.c,
        bytes: row.bytes,
      });
    }
  }

  // 步骤 2：扫长内容（>= noiseShortBytes）匹配 regex/prefix 规则
  // 这些规则可能匹配长内容（如 "API Error: 502..." 是长字符串）
  // 简化：对所有 regex/prefix 规则，扫一遍长内容
  // 大库优化：只扫 length 在合理范围的（避免扫几 MB 的内容）
  // 实际上长内容的噪音主要是 API Error 类，长度通常 < 1000B
  const longRows = db
    .prepare(
      `SELECT content, COUNT(*) AS c, SUM(length(content)) AS bytes
       FROM messages
       WHERE length(content) >= ? AND length(content) < 2000
       GROUP BY content
       HAVING c >= 10`,
    )
    .all(policy.noiseShortBytes) as Array<{
    content: string;
    c: number;
    bytes: number;
  }>;

  for (const row of longRows) {
    for (const rule of compiled) {
      if (rule.match(row.content)) {
        const prev = perRule.get(rule.name) ?? { messages: 0, bytes: 0 };
        perRule.set(rule.name, {
          messages: prev.messages + row.c,
          bytes: prev.bytes + row.bytes,
        });
        break;
      }
    }
  }

  // 汇总
  const perRuleList = Array.from(perRule.entries())
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.messages - a.messages);

  const totalMessages =
    perRuleList.reduce((s, r) => s + r.messages, 0) +
    shortHighFreq.reduce((s, r) => s + r.occurrences, 0);
  const totalBytes =
    perRuleList.reduce((s, r) => s + r.bytes, 0) +
    shortHighFreq.reduce((s, r) => s + r.bytes, 0);

  return {
    perRule: perRuleList,
    shortHighFreq: shortHighFreq.sort((a, b) => b.occurrences - a.occurrences).slice(0, 20),
    totalMessages,
    totalBytes,
  };
}

/** L2 截断扫描 */
function scanTruncate(
  db: DatabaseSync,
  policy: RetainPolicy,
): TruncateReport {
  const perRule: TruncateReport['perRule'] = [];

  for (const rule of policy.truncate) {
    // 命中此规则的消息数 + 可节省字节数
    // 可节省 = SUM(length - keepBytes) （length > maxBytes 的消息）
    const row = db
      .prepare(
        `SELECT
           COUNT(*) AS messages,
           COALESCE(SUM(length(content) - ?), 0) AS saved_bytes
         FROM messages
         WHERE role = ? AND length(content) > ?`,
      )
      .get(rule.keepBytes, rule.role, rule.maxBytes) as {
      messages: number;
      saved_bytes: number;
    };

    perRule.push({
      role: rule.role,
      maxBytes: rule.maxBytes,
      keepBytes: rule.keepBytes,
      messages: row.messages,
      savedBytes: row.saved_bytes,
    });
  }

  return {
    perRule,
    totalMessages: perRule.reduce((s, r) => s + r.messages, 0),
    totalSavedBytes: perRule.reduce((s, r) => s + r.savedBytes, 0),
  };
}

/** L3 归档扫描 */
function scanArchive(
  db: DatabaseSync,
  policy: RetainPolicy,
): ArchiveReport {
  const cutoff = Date.now() - policy.archive.olderThanDays * 24 * 60 * 60 * 1000;

  // 用 started_at 判断老旧（last_seen_at 被采集器持续刷新，不能反映真实年龄）
  const row = db
    .prepare(
      `SELECT
         COUNT(DISTINCT s.id) AS sessions,
         COUNT(m.id) AS messages,
         COALESCE(SUM(length(m.content)), 0) AS bytes,
         MIN(s.started_at) AS oldest
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       WHERE s.started_at < ? AND m.id IS NOT NULL`,
    )
    .get(cutoff) as {
    sessions: number;
    messages: number;
    bytes: number;
    oldest: number | null;
  };

  return {
    sessionsToArchive: row.sessions,
    messagesAffected: row.messages,
    bytesAffected: row.bytes,
    oldestStartedAt: row.oldest,
    cutoffTimestamp: cutoff,
  };
}
