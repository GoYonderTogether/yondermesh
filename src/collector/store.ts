/**
 * SQLite 采集器存储
 *
 * 增量入库，hash 去重。
 * 使用 node:sqlite 内置模块，零三方依赖。
 */

import { Database } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { SessionRecord, SessionMessage, SessionQuery, SessionQueryResult } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  device TEXT NOT NULL,
  project_path TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER,
  seq INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
`;

/**
 * SQLite 采集器存储
 */
export class SqliteCollectorStore {
  private db: Database;

  constructor(dbPath: string) {
    // 确保目录存在
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA);
  }

  /** 计算 session 内容 hash */
  private contentHash(session: SessionRecord): string {
    const data = `${session.agent}:${session.device}:${session.projectPath}:${session.startedAt}:${session.messageCount}`;
    return createHash('sha256').update(data).digest('hex');
  }

  /** 入库一个 session（增量，hash 去重） */
  async ingest(session: SessionRecord): Promise<boolean> {
    const hash = this.contentHash(session);
    const existing = this.db.prepare(
      'SELECT content_hash FROM sessions WHERE id = ?'
    ).get(session.id) as { content_hash: string } | undefined;

    if (existing?.content_hash === hash) {
      return false; // 未变更，跳过
    }

    this.db.exec('BEGIN');
    try {
      // 删除旧消息（如果有）
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);

      // 插入 session
      this.db.prepare(`
        INSERT INTO sessions (id, agent, device, project_path, started_at, ended_at, message_count, summary, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          ended_at = excluded.ended_at,
          message_count = excluded.message_count,
          summary = excluded.summary,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `).run(
        session.id, session.agent, session.device, session.projectPath,
        session.startedAt, session.endedAt ?? null, session.messageCount,
        session.summary ?? null, hash, Date.now()
      );

      // 插入消息
      const stmt = this.db.prepare(
        'INSERT INTO messages (session_id, role, content, timestamp, seq) VALUES (?, ?, ?, ?, ?)'
      );
      session.messages.forEach((msg, i) => {
        stmt.run(session.id, msg.role, msg.content, msg.timestamp ?? null, i);
      });

      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 查询 session 列表 */
  query(q: SessionQuery): SessionQueryResult {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (q.agent) { conditions.push('agent = ?'); params.push(q.agent); }
    if (q.device) { conditions.push('device = ?'); params.push(q.device); }
    if (q.projectPath) { conditions.push('project_path = ?'); params.push(q.projectPath); }
    if (q.since) { conditions.push('started_at >= ?'); params.push(q.since); }
    if (q.until) { conditions.push('started_at <= ?'); params.push(q.until); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = q.limit ?? 50;
    const offset = q.cursor ? parseInt(q.cursor, 10) : 0;

    const sessions = this.db.prepare(
      `SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Record<string, unknown>[];

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM sessions ${where}`
    ).get(...params) as { count: number };

    return {
      sessions: sessions.map(this.rowToSession),
      nextCursor: sessions.length === limit ? String(offset + limit) : undefined,
      total: totalRow.count,
    };
  }

  /** 获取单个 session 的完整消息 */
  getMessages(sessionId: string): SessionMessage[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
    ).all(sessionId) as Record<string, unknown>[];

    return rows.map(row => ({
      role: row.role as SessionMessage['role'],
      content: row.content as string,
      timestamp: row.timestamp as number | undefined,
    }));
  }

  /** 获取最近 N 个 session 摘要 */
  recent(limit: number = 10): SessionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?'
    ).all(limit) as Record<string, unknown>[];

    return rows.map(this.rowToSession);
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }

  private rowToSession = (row: Record<string, unknown>): SessionRecord => ({
    id: row.id as string,
    agent: row.agent as SessionRecord['agent'],
    device: row.device as string,
    projectPath: row.project_path as string,
    startedAt: row.started_at as number,
    endedAt: row.ended_at as number | undefined,
    messageCount: row.message_count as number,
    summary: row.summary as string | undefined,
    messages: [],
  });
}
