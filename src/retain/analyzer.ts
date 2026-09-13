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

import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import {
  compileNoiseRules,
} from './policy.js';
import type {
  CompiledNoiseRule,
  RetainPolicy,
} from './policy.js';
import { classifySessions } from './session-classifier.js';
import type { SessionClassification } from './session-classifier.js';

// node:sqlite 是实验性内置，vitest/vite 静态解析会误判为裸包 sqlite（同 SessionStore 的处理）
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};
/** 类型位与值位同名 */
type DatabaseSync = DatabaseSyncType;

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
  /**
   * 是否为**抽样估算**（大库）。
   *
   * 为什么需要：本机 messages 有 15.4M 行、content 总量 4.4GB。精确分析的每一趟
   * 都要把 content 全读一遍，实测单趟 `SUM(length(content))` 就 132 秒、
   * 5 趟合计 8~9 分钟 —— 交互上等于不可用。
   * 所以大库改为「抽 K 条样本 → 算比例 → 外推」，并在报告里**明确标注**
   * 这是估算，附样本量，别让人误当成精确值。
   */
  sampled: boolean;
  /** 抽样条数（sampled=true 时有效） */
  sampleSize: number;
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
/**
 * 超过这个行数就走抽样估算。
 * 50 万行以下精确分析仍在秒级，没必要牺牲准确性。
 */
const SAMPLE_THRESHOLD_ROWS = 500_000;
/** 抽样条数：太少外推不稳，太多又慢（这几千次是按主键查，很快） */
const SAMPLE_SIZE = 5_000;

export function analyze(
  dbPath: string,
  policy: RetainPolicy,
  compiled?: CompiledNoiseRule[],
): RetainReport {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const compiledRules = compiled ?? compileNoiseRules(policy.noise);

    // 大库快路径：MAX(rowid) 是 O(1)（实测 0.038s，而 COUNT(*) 要 22.5s）。
    // 用它判断规模，超阈值就走抽样 —— 精确分析在这个量级上要 8~9 分钟。
    const maxRowidRow = db
      .prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM messages')
      .get() as { m: number };
    const approxRows = maxRowidRow.m ?? 0;
    if (approxRows > SAMPLE_THRESHOLD_ROWS) {
      return analyzeSampled(db, policy, compiledRules, approxRows);
    }

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
      sampled: false,
      sampleSize: 0,
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

/**
 * 大库抽样估算。
 *
 * 做法：在 [1, maxRowid] 里随机取 K 个 rowid（主键查找，几千次很快），
 * 对样本跑**与精确路径完全相同的规则**，得到「样本里各类占比」，
 * 再按 `maxRowid / 样本实际命中数` 外推到全库。
 *
 * 诚实性：报告里 sampled=true + sampleSize，CLI 会打印「这是估算」。
 * 想要精确值用 `--exact`（会跑 8~9 分钟）。
 *
 * 口径说明：用 MAX(rowid) 当总量而不是 COUNT(*)——
 * 后者在这个量级要 22.5 秒。若库里有大量删除导致 rowid 稀疏，
 * 估算会偏高；报告里同时给出样本量的置信说明。
 */
function analyzeSampled(
  db: DatabaseSync,
  policy: RetainPolicy,
  compiled: CompiledNoiseRule[],
  maxRowid: number,
): RetainReport {
  // 1) 抽 rowid（去重，避免重复计数）
  const picked = new Set<number>();
  while (picked.size < SAMPLE_SIZE) picked.add(1 + Math.floor(Math.random() * maxRowid));
  const ids = [...picked];
  const marks = ids.map(() => '?').join(',');

  const rows = db
    .prepare(
      `SELECT rowid AS rid, role, length(content) AS len, content
         FROM messages WHERE rowid IN (${marks})`,
    )
    .all(...ids) as Array<{ rid: number; role: string; len: number; content: string }>;

  const scale = rows.length > 0 ? maxRowid / rows.length : 0;

  // 2) 在样本上跑规则
  let noiseMsgs = 0;
  let noiseBytes = 0;
  let shortMsgs = 0;
  let shortBytes = 0;
  let truncMsgs = 0;
  let truncBytes = 0;
  let totalBytes = 0;
  const shortFreq = new Map<string, number>();
  const perRule = new Map<string, { messages: number; bytes: number }>();
  const truncPerRule: Array<{ role: string; maxBytes: number; keepBytes: number; messages: number; savedBytes: number }> =
    policy.truncate.map((t) => ({ role: t.role, maxBytes: t.maxBytes, keepBytes: t.keepBytes, messages: 0, savedBytes: 0 }));

  for (const r of rows) {
    totalBytes += r.len;
    if (r.len < policy.noiseShortBytes) {
      shortMsgs++;
      shortBytes += r.len;
      shortFreq.set(r.content, (shortFreq.get(r.content) ?? 0) + 1);
      for (const rule of compiled) {
        if (rule.match(r.content)) {
          noiseMsgs++;
          noiseBytes += r.len;
          const prev = perRule.get(rule.name) ?? { messages: 0, bytes: 0 };
          perRule.set(rule.name, { messages: prev.messages + 1, bytes: prev.bytes + r.len });
          break;
        }
      }
    }
    // 截断：按 role 对应的规则
    const tr = truncPerRule.find((t) => t.role === r.role);
    if (tr && r.len > tr.maxBytes) {
      truncMsgs++;
      const saved = r.len - tr.keepBytes;
      truncBytes += saved;
      tr.messages++;
      tr.savedBytes += saved;
    }
  }

  const totalMessages = Math.round(maxRowid);
  const estTotalBytes = Math.round(totalBytes * scale);

  const noise: NoiseReport = {
    totalMessages: Math.round(noiseMsgs * scale),
    totalBytes: Math.round(noiseBytes * scale),
    perRule: [...perRule.entries()].map(([name, v]) => ({
      name,
      messages: Math.round(v.messages * scale),
      bytes: Math.round(v.bytes * scale),
    })),
    shortHighFreq: [...shortFreq.entries()]
      .filter(([, c]) => c >= 2)
      .slice(0, 20)
      .map(([content, occurrences]) => ({
        content,
        occurrences: Math.round(occurrences * scale),
        bytes: Math.round(content.length * occurrences * scale),
      })),
  };
  const truncate: TruncateReport = {
    totalMessages: Math.round(truncMsgs * scale),
    totalSavedBytes: Math.round(truncBytes * scale),
    perRule: truncPerRule.map((t) => ({
      role: t.role,
      maxBytes: t.maxBytes,
      keepBytes: t.keepBytes,
      messages: Math.round(t.messages * scale),
      savedBytes: Math.round(t.savedBytes * scale),
    })),
  };
  // 归档/分类在抽样模式下不做（它们按 session 判定，抽样算不出来）——
  // 明确置空并靠 sampled=true 让调用方知道这两块没有数据，而不是假装是 0。
  const archive: ArchiveReport = {
    sessionsToArchive: 0,
    messagesAffected: 0,
    bytesAffected: 0,
    oldestStartedAt: null,
    cutoffTimestamp: 0,
  };
  const session: SessionClassification = {
    noiseSessions: [],
    shortSessions: [],
    duplicateSessions: [],
    totalNoiseMessages: 0,
    totalNoiseBytes: 0,
    totalShortMessages: 0,
    totalShortBytes: 0,
    totalDuplicateMessages: 0,
    totalDuplicateBytes: 0,
  };

  const projectedRemainingMessages = Math.max(
    0,
    totalMessages - noise.totalMessages - truncate.totalMessages,
  );
  const projectedRemainingBytes = Math.max(
    0,
    estTotalBytes - noise.totalBytes - truncate.totalSavedBytes,
  );

  return {
    databasePath: '',
    scannedAt: Date.now(),
    totalMessages,
    totalBytes: estTotalBytes,
    noise,
    truncate,
    archive,
    session,
    projectedRemainingMessages,
    projectedRemainingBytes,
    sampled: true,
    sampleSize: rows.length,
  };
}
