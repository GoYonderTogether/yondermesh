/**
 * Session 级分类器（纯 SQL/JS，零 LLM）
 *
 * 在消息级 L0/L2/L3 之上对 sessions 做"整场级"判定：
 *   SL0 纯噪音 session —— 整场都是 no-response/interrupted/API Error 占位符
 *   SL1 短问答 session —— 消息数 < 阈值 且 时长 < 阈值（保留 metadata，删 messages）
 *   SL2 重复 session    —— 同 cwd+source+首条 user 消息 + 时间窗内重复（保留最新）
 *
 * 接口约定：
 *   - classify() 只读，返回三个分类的 sessionId 列表 + 涉及消息数/字节数
 *   - 不修改数据库
 *   - 复用 applier 已建的 tmp_noise_contents 临时表（避免重复扫噪音 content）
 *
 * 大库优化：
 *   - SL0：用临时表 JOIN 替代逐 session 查询
 *   - SL1：纯 SQL 一次性过滤
 *   - SL2：用 SQLite window function 取首条 user 消息，避免 N+1
 */

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  CompiledNoiseRule,
  RetainPolicy,
} from './policy.js';

/** 数据库连接类型（仅用于函数签名，不在此模块实例化） */
type Db = DatabaseSyncType;

/** 单个 session 的分类结果元数据 */
export interface ClassifiedSession {
  id: string;
  /** 消息数 */
  messageCount: number;
  /** 涉及字节数（整 session 的 messages 字节总和） */
  bytes: number;
  /** 分类原因（人类可读） */
  reason: string;
}

/** 完整分类报告 */
export interface SessionClassification {
  /** SL0 纯噪音 session */
  noiseSessions: ClassifiedSession[];
  /** SL1 短问答 session */
  shortSessions: ClassifiedSession[];
  /** SL2 重复 session（保留最新一场，其余列在此） */
  duplicateSessions: ClassifiedSession[];
  /** 各分类涉及的总消息数 */
  totalNoiseMessages: number;
  totalShortMessages: number;
  totalDuplicateMessages: number;
  /** 各分类涉及的总字节数 */
  totalNoiseBytes: number;
  totalShortBytes: number;
  totalDuplicateBytes: number;
}

/**
 * 对所有 sessions 跑分类。
 *
 * @param db 已打开的数据库（读写模式；临时表由调用方创建/清理）
 * @param policy 策略
 * @param compiled 已编译的噪音规则（用于 SL0 的 content 匹配，从 exact 规则提取候选集）
 */
export function classifySessions(
  db: Db,
  policy: RetainPolicy,
  compiled: CompiledNoiseRule[],
): SessionClassification {
  const sc = policy.sessionClassify;

  // ─── SL0 纯噪音 session ─────────────────────────────────────
  // 思路：
  //   1. 复用 tmp_noise_contents 临时表（applier.applyNoise 已建；如果未建则在此建）
  //   2. JOIN messages × tmp_noise_contents 算每个 session 的噪音消息数
  //   3. 与 sessions.message_count 对比，> noiseRatio 则归入 SL0
  //
  // 注意：tmp_noise_contents 只包含 exact 噪音 content。regex/prefix 规则的命中
  // 在 L0 已 DELETE，剩余的纯噪音 session 主要由 exact 噪音构成，此近似足够。
  const noiseSessions = classifyNoiseSessions(db, sc.noiseRatio, sc.noiseMinMessages, compiled);

  // ─── SL1 短问答 session ─────────────────────────────────────
  // 排除已归入 SL0 的 session
  const excludeSl0 = new Set(noiseSessions.map((s) => s.id));
  const shortSessions = classifyShortSessions(db, sc.shortMaxMessages, sc.shortMaxDurationMs, excludeSl0);

  // ─── SL2 重复 session ───────────────────────────────────────
  const excludeSl0Sl1 = new Set([...excludeSl0, ...shortSessions.map((s) => s.id)]);
  const duplicateSessions = classifyDuplicateSessions(db, sc.duplicateWindowMs, excludeSl0Sl1);

  // 汇总
  const sumMsgs = (arr: ClassifiedSession[]) => arr.reduce((s, x) => s + x.messageCount, 0);
  const sumBytes = (arr: ClassifiedSession[]) => arr.reduce((s, x) => s + x.bytes, 0);

  return {
    noiseSessions,
    shortSessions,
    duplicateSessions,
    totalNoiseMessages: sumMsgs(noiseSessions),
    totalShortMessages: sumMsgs(shortSessions),
    totalDuplicateMessages: sumMsgs(duplicateSessions),
    totalNoiseBytes: sumBytes(noiseSessions),
    totalShortBytes: sumBytes(shortSessions),
    totalDuplicateBytes: sumBytes(duplicateSessions),
  };
}

// ─── SL0 实现 ──────────────────────────────────────────────────

/**
 * SL0：找纯噪音 session。
 *
 * 算法：
 *   1. 收集所有 exact 噪音 content 到候选集（与 L0 一致）
 *   2. SQL JOIN 算每个 session 命中噪音数
 *   3. noise_count / message_count > noiseRatio 且 message_count >= noiseMinMessages → SL0
 */
function classifyNoiseSessions(
  db: Db,
  noiseRatio: number,
  minMessages: number,
  compiled: CompiledNoiseRule[],
): ClassifiedSession[] {
  // 用 SQL 一次性取所有候选 content（length < 2000 且全库出现 >= 5 次）
  // 然后用 JS 跑规则，命中的收集
  // 与 applier.applyNoise 步骤 1 一致，确保 SL0 和 L0 使用同一份噪音集
  const candidates = db
    .prepare(
      `SELECT content, COUNT(*) AS c
       FROM messages
       WHERE length(content) < 2000
       GROUP BY content
       HAVING c >= 5`,
    )
    .all() as Array<{ content: string; c: number }>;

  const noiseContents: string[] = [];
  for (const row of candidates) {
    for (const rule of compiled) {
      if (rule.match(row.content)) {
        noiseContents.push(row.content);
        break;
      }
    }
  }

  if (noiseContents.length === 0) return [];

  // 建临时表存噪音 content（如果不存在）
  db.exec('DROP TABLE IF EXISTS tmp_sl0_noise_contents');
  db.exec('CREATE TEMP TABLE tmp_sl0_noise_contents(content TEXT PRIMARY KEY)');
  const insertStmt = db.prepare('INSERT OR IGNORE INTO tmp_sl0_noise_contents(content) VALUES (?)');
  for (const c of noiseContents) insertStmt.run(c);

  try {
    // JOIN 算每个 session 的噪音消息数 + 总字节数
    // 注意：messages.content IN (tmp) 走临时表主键索引
    const rows = db
      .prepare(
        `SELECT
           m.session_id AS id,
           s.message_count AS msg_count,
           COUNT(m.id) AS noise_count,
           COALESCE(SUM(length(m.content)), 0) AS bytes
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         JOIN tmp_sl0_noise_contents c ON c.content = m.content
         GROUP BY m.session_id
         HAVING noise_count >= ? AND noise_count * 1.0 / MAX(msg_count, 1) >= ?`,
      )
      .all(minMessages, noiseRatio) as Array<{
      id: string;
      msg_count: number;
      noise_count: number;
      bytes: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      messageCount: r.msg_count,
      bytes: r.bytes,
      reason: `噪音占比 ${((r.noise_count / Math.max(r.msg_count, 1)) * 100).toFixed(0)}% (${r.noise_count}/${r.msg_count})`,
    }));
  } finally {
    db.exec('DROP TABLE IF EXISTS tmp_sl0_noise_contents');
  }
}

// ─── SL1 实现 ──────────────────────────────────────────────────

/**
 * SL1：短问答 session。
 *
 * 条件：
 *   - message_count < shortMaxMessages
 *   - 时长 = ended_at - started_at < shortMaxDurationMs（若 ended_at 为空，用 last_seen_at 兜底）
 *   - 排除 SL0 已命中的 session
 */
function classifyShortSessions(
  db: Db,
  maxMessages: number,
  maxDurationMs: number,
  exclude: Set<string>,
): ClassifiedSession[] {
  const rows = db
    .prepare(
      `SELECT
         s.id,
         s.message_count AS msg_count,
         COALESCE(s.ended_at, s.last_seen_at) - s.started_at AS duration_ms,
         COALESCE(SUM(length(m.content)), 0) AS bytes
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       WHERE s.message_count > 0
         AND s.message_count < ?
         AND s.started_at IS NOT NULL
         AND (COALESCE(s.ended_at, s.last_seen_at) - s.started_at) < ?
       GROUP BY s.id`,
    )
    .all(maxMessages, maxDurationMs) as Array<{
    id: string;
    msg_count: number;
    duration_ms: number;
    bytes: number;
  }>;

  return rows
    .filter((r) => !exclude.has(r.id))
    .map((r) => ({
      id: r.id,
      messageCount: r.msg_count,
      bytes: r.bytes,
      reason: `短会话 ${r.msg_count} 条 / ${Math.round(r.duration_ms / 1000)}s`,
    }));
}

// ─── SL2 实现 ──────────────────────────────────────────────────

/**
 * SL2：重复 session。
 *
 * 算法：
 *   1. 用 window function 取每个 session 的首条 user 消息（按 seq 升序）
 *   2. 按 (cwd, source, first_user_content) 分组
 *   3. 同组 session 数 > 1 时，按 started_at 降序排序，保留最新的，其余归入 SL2
 *   4. 时间窗内（duplicateWindowMs）的才算重复，跨太久的不算
 *
 * 注意：first_user_content 用前 500 字符做指纹，避免超长 user 消息导致分组爆炸
 */
function classifyDuplicateSessions(
  db: Db,
  windowMs: number,
  exclude: Set<string>,
): ClassifiedSession[] {
  // 取每个 session 的首条 user 消息（substr 前 500 字符作为指纹）
  // SQLite 3.25+ 支持 ROW_NUMBER window function
  const groups = db
    .prepare(
      `WITH first_user AS (
         SELECT session_id, substr(content, 1, 500) AS fingerprint,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq ASC) AS rn
         FROM messages WHERE role = 'user'
       )
       SELECT
         s.id,
         s.cwd,
         s.source,
         s.started_at,
         s.message_count AS msg_count,
         fu.fingerprint,
         COALESCE(SUM(length(m.content)), 0) AS bytes
       FROM sessions s
       JOIN first_user fu ON fu.session_id = s.id AND fu.rn = 1
       LEFT JOIN messages m ON m.session_id = s.id
       WHERE s.cwd IS NOT NULL
         AND s.started_at IS NOT NULL
         AND fu.fingerprint != ''
       GROUP BY s.id`,
    )
    .all() as Array<{
    id: string;
    cwd: string;
    source: string;
    started_at: number;
    msg_count: number;
    fingerprint: string;
    bytes: number;
  }>;

  // 按 (cwd, source, fingerprint) 分组
  const buckets = new Map<string, typeof groups>();
  for (const row of groups) {
    if (exclude.has(row.id)) continue;
    const key = `${row.cwd}\u0000${row.source}\u0000${row.fingerprint}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }

  const result: ClassifiedSession[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    // 按 started_at 降序排序，保留最新的
    bucket.sort((a, b) => b.started_at - a.started_at);
    const newest = bucket[0]!;
    const minStartedAt = newest.started_at - windowMs;
    // 时间窗内的才算重复
    for (let i = 1; i < bucket.length; i++) {
      const s = bucket[i]!;
      if (s.started_at < minStartedAt) break; // 超出时间窗，更老的也跳过
      result.push({
        id: s.id,
        messageCount: s.msg_count,
        bytes: s.bytes,
        reason: `与 ${newest.id} 重复（cwd=${s.cwd}, source=${s.source}）`,
      });
    }
  }

  return result;
}
