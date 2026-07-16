/**
 * Session Store SQLite schema
 *
 * 6 张表（architecture.md §3.2 建议）：
 *   source_instances / sessions / session_revisions /
 *   messages / session_relationships / scan_runs
 *
 * 身份 = device_id + source_instance_id + native_session_id（§3.1）。
 */

export const SCHEMA = `
-- 1. 来源实例：某设备上的一个采集入口（如 claude-code 的 ~/.claude/projects）
CREATE TABLE IF NOT EXISTS source_instances (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL,
  source       TEXT NOT NULL,
  root_path    TEXT,
  coverage     TEXT NOT NULL DEFAULT 'B',
  presence     TEXT NOT NULL DEFAULT 'present',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (device_id, source, root_path)
);

-- 2. sessions：session 身份 + 当前指针 + 多维切分 + 正交状态
CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT PRIMARY KEY,
  device_id             TEXT NOT NULL,
  source_instance_id    TEXT NOT NULL,
  native_session_id     TEXT NOT NULL,
  source                TEXT NOT NULL,
  cwd                   TEXT,
  project_path          TEXT,
  topology              TEXT NOT NULL DEFAULT 'root',
  presence              TEXT NOT NULL DEFAULT 'present',
  retention             TEXT NOT NULL DEFAULT 'live',
  sync_state            TEXT NOT NULL DEFAULT 'local',
  content_hash          TEXT NOT NULL,
  current_revision_id   INTEGER,
  message_count         INTEGER NOT NULL DEFAULT 0,
  started_at            INTEGER,
  last_seen_at          INTEGER NOT NULL,
  ended_at              INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  -- 元数据扩展（LOOP-012）
  model                 TEXT,
  cli_version           TEXT,
  originator            TEXT,
  entry_source          TEXT,
  thread_source         TEXT,
  estimated_cost_usd    REAL,
  total_input_tokens    INTEGER,
  total_output_tokens   INTEGER,
  tool_call_count       INTEGER,
  file_modified_at       INTEGER,
 UNIQUE (device_id, source_instance_id, native_session_id),
  FOREIGN KEY (source_instance_id) REFERENCES source_instances(id)
);

-- 3. session_revisions：内容变更历史
CREATE TABLE IF NOT EXISTS session_revisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  message_count   INTEGER NOT NULL DEFAULT 0,
  source_kind     TEXT,
  recorded_at     INTEGER NOT NULL,
  UNIQUE (session_id, revision_number),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 4. messages：按 revision 保存消息快照
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  revision_id  INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  timestamp    INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (revision_id) REFERENCES session_revisions(id)
);

-- 5. session_relationships：关系单独建模（§3.4）
CREATE TABLE IF NOT EXISTS session_relationships (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session_id TEXT NOT NULL,
  to_session_id   TEXT NOT NULL,
  relation_type   TEXT NOT NULL,
  evidence        TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (from_session_id, to_session_id, relation_type),
  FOREIGN KEY (from_session_id) REFERENCES sessions(id),
  FOREIGN KEY (to_session_id) REFERENCES sessions(id)
);

-- 6. scan_runs：扫描运行记录
CREATE TABLE IF NOT EXISTS scan_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source_instance_id TEXT,
  device_id          TEXT,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  status             TEXT NOT NULL DEFAULT 'running',
  sessions_seen      INTEGER NOT NULL DEFAULT 0,
  sessions_new       INTEGER NOT NULL DEFAULT 0,
  sessions_updated   INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  FOREIGN KEY (source_instance_id) REFERENCES source_instances(id)
);

-- 7. agent_messages：跨 session 消息总线
CREATE TABLE IF NOT EXISTS agent_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  to_session_id   TEXT,
  to_project      TEXT,
  from_session_id TEXT,
  body            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'info',
  created_at      INTEGER NOT NULL,
  read_at         INTEGER,
  -- mailbox v2 扩展（src/mailbox/core.ts）
  priority        TEXT NOT NULL DEFAULT 'normal',
  expires_at      INTEGER,
  thread_id       TEXT,
  reply_to_id     INTEGER,
  FOREIGN KEY (reply_to_id) REFERENCES agent_messages(id)
);
`;

/**
 * 索引定义。必须在 MIGRATION_COLUMNS 之后执行，因为部分索引引用了
 * 迁移新增的列（如 idx_msg_thread 引用 thread_id）。旧库的 agent_messages
 * 表在 CREATE TABLE IF NOT EXISTS 时不会重建，必须先 ALTER 再建索引。
 */
export const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_sessions_device        ON sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_sessions_instance      ON sessions(source_instance_id);
CREATE INDEX IF NOT EXISTS idx_sessions_source        ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_topology      ON sessions(topology);
CREATE INDEX IF NOT EXISTS idx_sessions_started       ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_revisions_session      ON session_revisions(session_id, revision_number);
CREATE INDEX IF NOT EXISTS idx_messages_session       ON messages(session_id, revision_id, seq);
CREATE INDEX IF NOT EXISTS idx_rel_from               ON session_relationships(from_session_id);
CREATE INDEX IF NOT EXISTS idx_rel_to                 ON session_relationships(to_session_id);
CREATE INDEX IF NOT EXISTS idx_rel_type               ON session_relationships(relation_type);
CREATE INDEX IF NOT EXISTS idx_scanruns_instance      ON scan_runs(source_instance_id);
CREATE INDEX IF NOT EXISTS idx_msg_to_session         ON agent_messages(to_session_id);
CREATE INDEX IF NOT EXISTS idx_msg_to_project         ON agent_messages(to_project);
CREATE INDEX IF NOT EXISTS idx_msg_created            ON agent_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_unread             ON agent_messages(read_at, to_session_id);
CREATE INDEX IF NOT EXISTS idx_msg_thread             ON agent_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_msg_expires            ON agent_messages(expires_at);
`;

/**
 * 已有数据库的列迁移。在 ensureSchema 之后执行，幂等。
 */
export const MIGRATION_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: 'sessions', column: 'model', type: 'TEXT' },
  { table: 'sessions', column: 'cli_version', type: 'TEXT' },
  { table: 'sessions', column: 'originator', type: 'TEXT' },
  { table: 'sessions', column: 'entry_source', type: 'TEXT' },
  { table: 'sessions', column: 'thread_source', type: 'TEXT' },
  { table: 'sessions', column: 'estimated_cost_usd', type: 'REAL' },
  { table: 'sessions', column: 'total_input_tokens', type: 'INTEGER' },
  { table: 'sessions', column: 'total_output_tokens', type: 'INTEGER' },
  { table: 'sessions', column: 'tool_call_count', type: 'INTEGER' },
  { table: 'sessions', column: 'total_cache_read_tokens', type: 'INTEGER' },
  { table: 'sessions', column: 'total_cache_creation_tokens', type: 'INTEGER' },
  { table: 'sessions', column: 'grand_total_tokens', type: 'INTEGER' },
  { table: 'sessions', column: 'api_call_count', type: 'INTEGER' },
  { table: 'sessions', column: 'file_modified_at', type: 'INTEGER' },
  // mailbox v2 扩展（src/mailbox/core.ts）
  { table: 'agent_messages', column: 'priority', type: "TEXT NOT NULL DEFAULT 'normal'" },
  { table: 'agent_messages', column: 'expires_at', type: 'INTEGER' },
  { table: 'agent_messages', column: 'thread_id', type: 'TEXT' },
  { table: 'agent_messages', column: 'reply_to_id', type: 'INTEGER' },
];

/**
 * 数据回填语句：在 runMigrations 之后执行，幂等。
 * 每条 { sql, check }：check 查询返回 1 表示已有非 NULL 值，跳过；否则执行 sql。
 */
export const MIGRATION_BACKFILLS: { check: string; sql: string }[] = [
  {
    check:
      "SELECT EXISTS(SELECT 1 FROM sessions WHERE file_modified_at IS NOT NULL) AS has",
    sql: "UPDATE sessions SET file_modified_at = last_seen_at WHERE file_modified_at IS NULL",
  },
];
